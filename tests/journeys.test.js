const test = require('node:test');
const assert = require('node:assert/strict');
const { app, demoStore } = require('../app');
let server;
let base;

test.before(async function() {
  server = await new Promise(function(resolve) {
    const instance = app.listen(0, '127.0.0.1', function() { resolve(instance); });
  });
  base = 'http://127.0.0.1:' + server.address().port;
});
test.after(function() { server.close(); });

function visitor() {
  let cookie = '';
  return {
    async request(path, body) {
      const response = await fetch(base + path, {
        method: body === undefined ? 'GET' : 'POST', redirect: 'manual',
        headers: { Cookie: cookie, ...(body === undefined ? {} : { 'Content-Type': 'application/x-www-form-urlencoded' }) },
        body: body === undefined ? undefined : new URLSearchParams(body)
      });
      const header = response.headers.get('set-cookie');
      if (header) cookie = header.split(';')[0];
      const html = await response.text();
      assert.ok(response.status < 500, path + ' returned ' + response.status + '\n' + html);
      return { status: response.status, location: response.headers.get('location'), html: html };
    },
    async state() {
      const id = decodeURIComponent(cookie.split('=')[1]).slice(2).split('.')[0];
      return new Promise(function(resolve, reject) {
        demoStore.get(id, function(error, data) { if (error) reject(error); else resolve(data); });
      });
    },
    async change(update) {
      const id = decodeURIComponent(cookie.split('=')[1]).slice(2).split('.')[0];
      const state = await this.state();
      update(state.demo);
      await new Promise(function(resolve, reject) {
        demoStore.set(id, state, function(error) { if (error) reject(error); else resolve(); });
      });
    }
  };
}

async function match(v) {
  await v.request('/home');
  return v.request('/smart-match/result');
}

async function goThere(v) {
  await match(v);
  const merchantId = (await v.state()).demo.selectedMerchantId;
  await v.request('/recommendation/accept', { merchantId: merchantId });
  return merchantId;
}

async function scan(v, merchantId) {
  await v.request('/scan');
  if (!merchantId) {
    const demo = (await v.state()).demo;
    merchantId = demo.activeVouchClaim && demo.activeVouchClaim.status === 'CLAIMED'
      ? demo.activeVouchClaim.merchantId
      : demo.recommendationAccepted && demo.selectedMerchantId ? demo.selectedMerchantId : 'green-bowl';
  }
  const result = await v.request('/scan', { merchantId: merchantId });
  assert.equal(result.location, '/scan/payment');
  return (await v.state()).demo.currentScanPayment;
}

function credit(demo, merchantId) { return demo.vouchCredits[merchantId] || 0; }

test('Smart Match recommends a merchant, keeps feedback and hands off to Scan', async function() {
  const v = visitor();
  assert.equal((await v.request('/')).location, '/home');
  const first = await match(v);
  assert.match(first.html, /felicia-chicken-rice/);
  assert.match(first.html, /Try: Chicken Rice · \$5\.00/);
  assert.match(first.html, /Go there/);
  assert.ok(!first.html.includes('after collection'));
  const feliciaId = (await v.state()).demo.selectedMerchantId;
  await v.request('/recommendation/accept', { merchantId: feliciaId });
  let state = (await v.state()).demo;
  assert.equal(state.recommendationAccepted, true);
  assert.equal(state.currentOrder, undefined);
  assert.match((await v.request('/home')).html, /Scan when you arrive/);
  assert.match((await v.request('/scan')).html, new RegExp('value="' + feliciaId + '"'));
  await v.request('/recommendation/reject', { merchantId: feliciaId, reason: 'too-far' });
  state = (await v.state()).demo;
  assert.equal(state.recommendationAccepted, false);
  assert.equal(state.recommendationFeedback[0].reason, 'too-far');
  const next = await v.request('/smart-match/result');
  assert.ok(!next.html.includes('data-merchant-id="' + feliciaId + '"'));
});

test('Profile preferences still filter Smart Match', async function() {
  const v = visitor();
  await v.request('/home');
  for (const dietary of ['halal', 'vegetarian', 'vegan', 'none']) {
    await v.request('/profile', { dietaryPreference: dietary, budget: '10', maxDistanceMinutes: '10' });
    const result = await v.request('/smart-match/result');
    assert.equal(result.status, 200);
    if (dietary !== 'none') assert.match(result.html, new RegExp(dietary));
  }
  await v.request('/profile', { dietaryPreference: 'none', budget: '1', maxDistanceMinutes: '1' });
  assert.match((await v.request('/smart-match/result')).html, /all we've got/);
});

test('Smart Match Scan accepts actual amount, merchant credit and optional Vouch', async function() {
  const v = visitor();
  const merchantId = await goThere(v);
  await v.change(function(demo) { demo.vouchCredits[merchantId] = .5; });
  const pending = await scan(v);
  assert.equal(pending.merchantId, merchantId);
  const page = await v.request('/scan/payment');
  assert.match(page.html, /How much are you paying/);
  assert.match(page.html, /\$0\.50 available/);
  const paid = await v.request('/scan/payment', { journeyId: pending.id, amount: '6.00', useCashback: 'on' });
  assert.match(paid.location, /^\/vouch\/tx-/);
  let state = (await v.state()).demo;
  const transaction = state.transactions[0];
  assert.equal(transaction.purchaseAmount, 6);
  assert.equal(transaction.merchantCreditUsed, .5);
  assert.equal(transaction.netsPaid, 5.5);
  assert.equal(transaction.merchantRewardEarned, .5);
  assert.equal(transaction.source, 'smart-match');
  assert.equal(credit(state, merchantId), .5);
  assert.match((await v.request('/payment-success/' + transaction.id)).html, /Paid with NETS/);
  await Promise.all([
    v.request('/vouch/' + transaction.id, { action: 'create', tag: 'worth-it' }),
    v.request('/vouch/' + transaction.id, { action: 'create', tag: 'worth-it' })
  ]);
  state = (await v.state()).demo;
  assert.equal(state.paymentVerifiedVouches.length, 1);
  const share = await v.request('/vouch/' + transaction.id + '/success');
  assert.match(share.html, /WhatsApp/);
  assert.match(share.html, /Telegram/);
  assert.match(share.html, /Copy link/);
});

test('Merchant Vouch Credit cannot be used at another merchant', async function() {
  const v = visitor();
  await v.request('/home');
  await v.change(function(demo) {
    demo.vouchCredits['felicia-chicken-rice'] = .5;
    demo.campaigns.forEach(function(campaign) { campaign.status = 'INACTIVE'; });
  });
  const green = await scan(v, 'green-bowl');
  await v.request('/scan/payment', { journeyId: green.id, amount: '6.00', useCashback: 'on' });
  let state = (await v.state()).demo;
  assert.equal(state.transactions[0].merchantCreditUsed, 0);
  assert.equal(credit(state, 'felicia-chicken-rice'), .5);
  await v.request('/vouch/' + state.transactions[0].id, { action: 'skip' });
  const felicia = await scan(v, 'felicia-chicken-rice');
  await v.request('/scan/payment', { journeyId: felicia.id, amount: '4.50', useCashback: 'on' });
  state = (await v.state()).demo;
  assert.equal(state.transactions[0].merchantCreditUsed, .5);
  assert.equal(state.transactions[0].netsPaid, 4);
  assert.equal(credit(state, 'felicia-chicken-rice'), 0);
});

test('Amount validation, $1 NETS floor, campaign cap and duplicate payment safety', async function() {
  const v = visitor();
  await v.request('/home');
  const pending = await scan(v, 'green-bowl');
  assert.equal((await v.request('/scan/payment', { journeyId: pending.id, amount: '4.999' })).location,
    '/scan/payment?error=amount');
  await v.change(function(demo) { demo.vouchCredits['green-bowl'] = 5; });
  await Promise.all([
    v.request('/scan/payment', { journeyId: pending.id, amount: '4.80', useCashback: 'on' }),
    v.request('/scan/payment', { journeyId: pending.id, amount: '4.80', useCashback: 'on' })
  ]);
  let state = (await v.state()).demo;
  assert.equal(state.transactions.length, 1);
  assert.equal(state.transactions[0].merchantCreditUsed, 3.8);
  assert.equal(state.transactions[0].netsPaid, 1);
  assert.equal(credit(state, 'green-bowl'), 1.7);
  await v.request('/vouch/' + state.transactions[0].id, { action: 'skip' });
  const next = await scan(v, 'green-bowl');
  await v.change(function(demo) {
    const campaign = demo.campaigns.find(function(item) { return item.merchantId === 'green-bowl'; });
    campaign.redemptionsToday = campaign.dailyCap;
  });
  await v.request('/scan/payment', { journeyId: next.id, amount: '4.80' });
  state = (await v.state()).demo;
  assert.equal(state.transactions[0].merchantRewardEarned, 0);
});

test('Shared Vouch claim rewards only after same-merchant payment without stacking', async function() {
  const sender = visitor();
  await sender.request('/home');
  const pending = await scan(sender, 'green-bowl');
  await sender.request('/scan/payment', { journeyId: pending.id, amount: '7.20' });
  const transaction = (await sender.state()).demo.transactions[0];
  await sender.request('/vouch/' + transaction.id, { action: 'create' });
  const vouch = (await sender.state()).demo.paymentVerifiedVouches[0];
  const offerPath = '/offers/' + vouch.shareToken;

  const receiver = visitor();
  await receiver.request(offerPath);
  await receiver.request(offerPath + '/claim', {});
  let state = (await receiver.state()).demo;
  assert.equal(credit(state, 'green-bowl'), 0);
  assert.equal(state.activeVouchClaim.status, 'CLAIMED');
  const claimedScan = await scan(receiver, 'green-bowl');
  await receiver.request('/scan/payment', { journeyId: claimedScan.id, amount: '4.80' });
  state = (await receiver.state()).demo;
  assert.equal(state.activeVouchClaim.status, 'REDEEMED');
  assert.equal(credit(state, 'green-bowl'), .5);
  assert.equal(state.transactions[0].source, 'shared-vouch');
  assert.equal(state.transactions[0].merchantRewardEarned, .5);
  await receiver.request('/scan/payment', { journeyId: claimedScan.id, amount: '4.80' });
  assert.equal(credit((await receiver.state()).demo, 'green-bowl'), .5);

  const wrongMerchant = visitor();
  await wrongMerchant.request(offerPath + '/claim', {});
  const wrongScan = await scan(wrongMerchant, 'spice-lane');
  await wrongMerchant.request('/scan/payment', { journeyId: wrongScan.id, amount: '4.80' });
  state = (await wrongMerchant.state()).demo;
  assert.equal(state.activeVouchClaim.status, 'CLAIMED');
  assert.equal(credit(state, 'green-bowl'), 0);
});

test('Retired preorder routes are safe and active pages render', async function() {
  const v = visitor();
  for (const path of ['/payment', '/order', '/collection', '/vouch', '/vouch/missing',
    '/payment-success/missing', '/scan/payment']) {
    assert.equal((await v.request(path)).status, 302, path);
  }
  await v.request('/home');
  const pending = await scan(v, 'felicia-chicken-rice');
  await v.request('/scan/payment', { journeyId: pending.id, amount: '6.00' });
  const id = (await v.state()).demo.transactions[0].id;
  await v.request('/vouch/' + id, { action: 'skip' });
  const pages = ['/home', '/profile', '/profile?tab=vouches', '/profile?tab=transactions',
    '/transactions/' + id, '/merchant', '/merchant?tab=results', '/scan',
    '/payment-success/' + id, '/css/style.css', '/js/script.js'];
  for (const path of pages) assert.equal((await v.request(path)).status, 200, path);
  assert.equal((await v.request('/merchant?tab=orders')).status, 200);
  assert.ok(!(await v.request('/merchant?tab=orders')).html.includes('Start preparing'));
});
