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
async function accept(v) {
  await match(v);
  const merchantId = (await v.state()).demo.selectedMerchantId;
  await v.request('/recommendation/accept', { merchantId });
  return (await v.state()).demo.currentOrder;
}
async function collect(v, order) {
  const data = { journeyId: order.id, merchantId: order.merchantId };
  await v.request('/merchant/start-preparing', data);
  await v.request('/merchant/mark-ready', data);
  await v.request('/collection', data);
}
async function scan(v, merchantId = 'green-bowl') {
  await v.request('/scan');
  const result = await v.request('/scan', { merchantId });
  assert.equal(result.location, '/scan/payment');
  return (await v.state()).demo.currentScanPayment;
}
function credit(demo, merchantId) { return demo.vouchCredits[merchantId] || 0; }

test('Smart Match persists, supports inline feedback, and filters all dietary choices', async function() {
  const v = visitor();
  const root = await v.request('/');
  assert.equal(root.location, '/home');
  const first = await match(v);
  assert.match(first.html, /Felicia/);
  const id = (await v.state()).demo.selectedMerchantId;
  assert.match((await v.request('/home')).html, /name="merchantId"/);
  await v.request('/home');
  assert.equal((await v.state()).demo.selectedMerchantId, id);
  await v.request('/recommendation/reject', { merchantId: id, reason: 'wrong' });
  assert.equal((await v.state()).demo.recommendationFeedback.length, 0);
  await v.request('/recommendation/reject', { merchantId: id, reason: 'too-far' });
  assert.match((await v.request('/home?matching=again')).html, /Finding something better/);
  const next = await v.request('/smart-match/result');
  assert.ok(!next.html.includes('data-merchant-id="' + id + '"'));
  assert.equal((await v.state()).demo.recommendationFeedback[0].reason, 'too-far');
  for (const dietary of ['halal', 'vegetarian', 'vegan', 'none']) {
    await v.request('/profile', { dietaryPreference: dietary, budget: '10', maxDistanceMinutes: '10' });
    const result = await v.request('/smart-match/result');
    assert.equal(result.status, 200);
    if (dietary !== 'none') assert.match(result.html, new RegExp(dietary));
  }
  await v.request('/profile', { dietaryPreference: 'none', budget: '1', maxDistanceMinutes: '1' });
  assert.match((await v.request('/smart-match/result')).html, /all we've got/);
});

test('Smart Match payment, concurrent duplicate protection, merchant readiness, collection and Vouch', async function() {
  const v = visitor();
  const order = await accept(v);
  assert.equal(order.orderAmount, 7.5);
  await v.request('/recommendation/accept', { merchantId: order.merchantId });
  assert.equal((await v.state()).demo.currentOrder.id, order.id);
  assert.equal((await v.request('/payment')).status, 200);
  await v.request('/collection', { journeyId: order.id });
  await v.request('/merchant/mark-ready', { journeyId: order.id, merchantId: order.merchantId });
  assert.equal((await v.state()).demo.currentOrder.status, 'PENDING_PAYMENT');
  const pays = await Promise.all([
    v.request('/payment', { journeyId: order.id }), v.request('/payment', { journeyId: order.id })
  ]);
  assert.equal(pays[0].location, pays[1].location);
  let state = (await v.state()).demo;
  assert.equal(state.transactions.length, 1);
  assert.equal(credit(state, order.merchantId), 0);
  assert.equal(state.currentOrder.status, 'PAID');
  const tx = state.transactions[0];
  assert.match((await v.request(pays[0].location)).html, /Track order/);
  await v.request('/vouch/' + tx.id, { action: 'create', tag: 'worth-it' });
  assert.equal((await v.state()).demo.paymentVerifiedVouches.length, 0);
  await collect(v, order);
  await v.request('/collection', { journeyId: order.id });
  state = (await v.state()).demo;
  assert.equal(credit(state, order.merchantId), .5);
  assert.equal(state.transactions[0].merchantRewardEarned, .5);
  const homeWithOrder = await v.request('/home');
  assert.match(homeWithOrder.html, /Vouch this spot/);
  assert.match((await v.request('/order')).html, /Vouch this spot/);
  await Promise.all([v.request('/vouch/' + tx.id, { action: 'create', tag: 'worth-it' }), v.request('/vouch/' + tx.id, { action: 'create', tag: 'worth-it' })]);
  state = (await v.state()).demo;
  assert.equal(state.paymentVerifiedVouches.length, 1);
  assert.equal(state.currentOrder.vouchDecision, 'created');
  const success = await v.request('/vouch/' + tx.id + '/success');
  assert.match(success.html, /amount stays private/);
  assert.ok(!success.html.includes('$7.50'));
  assert.match((await v.request('/home')).html, /Journey complete/);
  await v.request('/recommendation/next', {});
  assert.equal((await v.request('/smart-match/result')).status, 200);
  assert.notEqual((await v.state()).demo.selectedMerchantId, order.merchantId);
});

test('One Smart Match order stays active until collection and Vouch decision', async function() {
  const v = visitor();
  const order = await accept(v);
  await v.request('/payment', { journeyId: order.id });
  const home = await v.request('/home');
  assert.match(home.html, /Preparing your order/);
  assert.ok(!home.html.includes('Your Smart Match'));
  assert.equal((await v.request('/smart-match/result')).status, 409);
  await collect(v, order);
  const txId = (await v.state()).demo.currentOrder.transactionId;
  assert.equal(credit((await v.state()).demo, order.merchantId), .5);
  await v.request('/vouch/' + txId, { action: 'skip' });
  let state = (await v.state()).demo;
  assert.equal(state.currentOrder.vouchDecision, 'skipped');
  assert.equal(credit(state, order.merchantId), .5);
  await v.request('/recommendation/next', {});
  state = (await v.state()).demo;
  assert.equal(state.currentOrder, null);
  assert.equal((await v.request('/smart-match/result')).status, 200);
});

test('Scan is standalone; custom amount, offset, immediate cashback, Vouch merchant and later journeys', async function() {
  const v = visitor();
  await v.request('/home');
  await v.change(function(demo) { demo.vouchCredits['green-bowl'] = .5; });
  const scanPayment = await scan(v);
  assert.equal((await v.state()).demo.currentOrder, null);
  const review = await v.request('/scan/payment');
  assert.match(review.html, /Green Bowl/);
  assert.ok(!review.html.includes('Chicken Rice'));
  assert.equal(credit((await v.state()).demo, 'green-bowl'), .5);
  const responses = await Promise.all([
    v.request('/scan/payment', { journeyId: scanPayment.id, amount: '7.20', useCashback: 'on' }),
    v.request('/scan/payment', { journeyId: scanPayment.id, amount: '7.20', useCashback: 'on' })
  ]);
  assert.equal(responses[0].location, responses[1].location);
  let state = (await v.state()).demo;
  const tx = state.transactions[0];
  assert.equal(state.transactions.length, 1);
  assert.equal(tx.purchaseAmount, 7.2);
  assert.equal(tx.merchantCreditUsed, .5);
  assert.equal(tx.netsPaid, 6.7);
  assert.equal(tx.merchantRewardEarned, .5);
  assert.equal(credit(state, 'green-bowl'), .5);
  assert.equal(state.currentOrder, null);
  const receipt = await v.request(responses[0].location);
  assert.match(receipt.html, /Green Bowl/);
  assert.ok(!receipt.html.includes('Track order'));
  await v.request('/vouch/' + tx.id, { action: 'create', tag: 'good-value' });
  assert.equal((await v.state()).demo.paymentVerifiedVouches[0].merchantName, 'Green Bowl');
  await v.request('/transactions/' + tx.id + '/done', {});
  assert.equal((await v.request('/scan')).status, 200);
  const order = await accept(v);
  assert.equal((await v.request('/payment')).status, 200);
  const payment = await v.request('/payment', { journeyId: order.id, useCashback: 'on' });
  state = (await v.state()).demo;
  assert.equal(state.currentOrder.netsPaid, 7.5);
  assert.equal(credit(state, order.merchantId), 0);
  assert.notEqual(payment.location, responses[0].location);
  await collect(v, order);
  assert.equal(credit((await v.state()).demo, order.merchantId), .5);
  const orderTx = (await v.state()).demo.currentOrder.transactionId;
  await v.request('/vouch/' + orderTx, { action: 'skip' });
  assert.equal((await v.state()).demo.currentOrder.vouchDecision, 'skipped');
  await v.request('/vouch/' + orderTx, { action: 'create', tag: 'vouch-pick' });
  assert.equal((await v.state()).demo.paymentVerifiedVouches.length, 1);
  const secondScan = await scan(v, 'spice-lane');
  await v.request('/scan/payment', { journeyId: secondScan.id, amount: '4.80' });
  state = (await v.state()).demo;
  assert.equal(state.transactions[0].merchantName, 'Spice Lane');
  assert.equal(state.transactions[0].netsPaid, 4.8);
  assert.equal(state.currentOrder.transactionId, orderTx);
});

test('Merchant Vouch Credit cannot be spent elsewhere and works on a return purchase', async function() {
  const v = visitor();
  const firstOrder = await accept(v);
  await v.request('/payment', { journeyId: firstOrder.id });
  await collect(v, firstOrder);
  const firstTx = (await v.state()).demo.currentOrder.transactionId;
  await v.request('/vouch/' + firstTx, { action: 'skip' });
  let state = (await v.state()).demo;
  assert.equal(firstOrder.merchantId, 'felicia-chicken-rice');
  assert.equal(credit(state, 'felicia-chicken-rice'), .5);
  await v.request('/recommendation/next', {});

  const greenScan = await scan(v, 'green-bowl');
  await v.request('/scan/payment', { journeyId: greenScan.id, amount: '4.80', useCashback: 'on' });
  state = (await v.state()).demo;
  assert.equal(state.transactions[0].merchantCreditUsed, 0);
  assert.equal(credit(state, 'felicia-chicken-rice'), .5);
  await v.request('/vouch/' + state.transactions[0].id, { action: 'skip' });

  await v.change(function(demo) {
    demo.rejectedMerchantIds = [];
    demo.selectedMerchantId = null;
    demo.shownMerchantIds = [];
  });
  const secondOrder = await accept(v);
  await v.request('/payment', { journeyId: secondOrder.id, useCashback: 'on' });
  state = (await v.state()).demo;
  assert.equal(secondOrder.merchantId, 'felicia-chicken-rice');
  assert.equal(state.transactions[0].merchantCreditUsed, .5);
  assert.equal(state.transactions[0].netsPaid, 7);
  assert.equal(credit(state, 'felicia-chicken-rice'), 0);
});

test('Amount validation, stale forms, $1 NETS floor and reset', async function() {
  const v = visitor();
  const pending = await scan(v);
  for (const value of ['', '-1', '0', '1.234', '1000.01', 'Infinity', 'abc', '1e2']) {
    const response = await v.request('/scan/payment', { journeyId: pending.id, amount: value });
    assert.equal(response.location, '/scan/payment?error=amount', value);
    assert.equal((await v.state()).demo.transactions.length, 0);
  }
  await v.request('/scan/payment', { journeyId: 'old-scan', amount: '7' });
  assert.equal((await v.state()).demo.transactions.length, 0);
  await v.change(function(demo) {
    demo.vouchCredits['green-bowl'] = 5;
    demo.campaigns.find(function(c) { return c.merchantId === 'green-bowl'; }).status = 'INACTIVE';
  });
  await v.request('/scan/payment', { journeyId: pending.id, amount: '4.80', useCashback: 'on' });
  let state = (await v.state()).demo;
  assert.equal(state.transactions[0].merchantCreditUsed, 3.8);
  assert.equal(state.transactions[0].netsPaid, 1);
  assert.equal(state.transactions[0].merchantRewardEarned, 0);
  assert.equal(state.transactions[0].eligible, true);
  assert.equal(credit(state, 'green-bowl'), 1.2);
  await v.request('/vouch/' + state.transactions[0].id, { action: 'skip' });
  assert.equal((await v.state()).demo.paymentVerifiedVouches.length, 0);
  await v.request('/transactions/' + state.transactions[0].id + '/done', {});
  await v.request('/reset-demo', {});
  state = (await v.state()).demo;
  assert.deepEqual(state.vouchCredits, {});
  assert.equal(state.transactions.length, 0);
  assert.equal(state.currentScanPayment, null);
  assert.equal(state.currentOrder, null);
  assert.equal(state.campaigns[1].status, 'ACTIVE');
});

test('Campaign cap, promised reward, concurrent collection and historical receipt isolation', async function() {
  const v = visitor();
  const order = await accept(v);
  await v.request('/payment', { journeyId: order.id });
  const txId = (await v.state()).demo.currentOrder.transactionId;
  await v.change(function(demo) {
    const campaign = demo.campaigns.find(function(c) { return c.merchantId === order.merchantId; });
    campaign.status = 'INACTIVE';
    campaign.rewardAmount = 2;
  });
  const data = { journeyId: order.id, merchantId: order.merchantId };
  await v.request('/merchant/start-preparing', data);
  await v.request('/merchant/mark-ready', data);
  await Promise.all([v.request('/collection', data), v.request('/collection', data)]);
  assert.equal(credit((await v.state()).demo, order.merchantId), .5);
  assert.equal((await v.state()).demo.promotionalRedemptions.length, 1);
  await v.request('/vouch/' + txId, { action: 'skip' });
  await v.request('/recommendation/next', {});
  await accept(v);
  assert.ok(!(await v.request('/payment-success/' + txId)).html.includes('Track order'));
  const pending = await scan(v);
  await v.change(function(demo) {
    const campaign = demo.campaigns.find(function(c) { return c.merchantId === 'green-bowl'; });
    campaign.redemptionsToday = campaign.dailyCap;
  });
  await v.request('/scan/payment', { journeyId: pending.id, amount: '4.80' });
  assert.equal((await v.state()).demo.transactions[0].merchantRewardEarned, 0);
  assert.equal(credit((await v.state()).demo, order.merchantId), .5);
});

test('Concurrent independent journeys cannot spend the same cashback twice', async function() {
  const v = visitor();
  const order = await accept(v);
  const pending = await scan(v);
  await v.change(function(demo) {
    demo.vouchCredits[order.merchantId] = .5;
    demo.vouchCredits['green-bowl'] = .5;
    demo.campaigns.forEach(function(c) { c.status = 'INACTIVE'; });
  });
  await Promise.all([
    v.request('/payment', { journeyId: order.id, useCashback: 'on' }),
    v.request('/scan/payment', { journeyId: pending.id, amount: '7.20', useCashback: 'on' })
  ]);
  const state = (await v.state()).demo;
  assert.equal(state.transactions.length, 2);
  assert.equal(state.transactions[0].merchantCreditUsed + state.transactions[1].merchantCreditUsed, 1);
  assert.equal(credit(state, order.merchantId), 0);
  assert.equal(credit(state, 'green-bowl'), 0);
  assert.notEqual(state.currentOrder.transactionId, state.currentScanPayment.transactionId);
});

test('Home balance, one-tap scan, tagged Vouch sharing and friend claim', async function() {
  const sender = visitor();
  const home = await sender.request('/home');
  assert.match(home.html, /Your Smart Match/);
  assert.ok(!home.html.includes('Your Vouch Cashback'));
  assert.ok(!home.html.includes('Already at a merchant'));
  const scanPage = await sender.request('/scan');
  assert.match(scanPage.html, /Scan Merchant QR/);
  assert.ok(!scanPage.html.includes('Demo merchant'));
  const pending = await scan(sender);
  const paid = await sender.request('/scan/payment', { journeyId: pending.id, amount: '7.20' });
  assert.match(paid.location, /^\/vouch\/tx-/);
  const transaction = (await sender.state()).demo.transactions[0];
  await sender.request('/vouch/' + transaction.id, { action: 'create' });
  const vouch = (await sender.state()).demo.paymentVerifiedVouches[0];
  assert.equal(vouch.tagLabel, 'Payment-Verified');
  const share = await sender.request('/vouch/' + transaction.id + '/success');
  assert.match(share.html, /WhatsApp/);
  assert.match(share.html, /Telegram/);
  assert.match(share.html, /Copy link/);
  const receiver = visitor();
  const offerPath = '/offers/' + vouch.shareToken;
  assert.match((await receiver.request(offerPath)).html, /Claim Vouch/);
  await receiver.request(offerPath + '/claim', {});
  let receiverState = (await receiver.state()).demo;
  assert.equal(credit(receiverState, 'green-bowl'), 0);
  assert.equal(receiverState.activeVouchClaim.status, 'CLAIMED');
  await receiver.request(offerPath + '/claim', {});
  receiverState = (await receiver.state()).demo;
  assert.equal(credit(receiverState, 'green-bowl'), 0);
  const claimedScan = await scan(receiver, 'green-bowl');
  await receiver.request('/scan/payment', { journeyId: claimedScan.id, amount: '4.80' });
  receiverState = (await receiver.state()).demo;
  assert.equal(receiverState.activeVouchClaim.status, 'REDEEMED');
  assert.equal(credit(receiverState, 'green-bowl'), .5);
  assert.equal(receiverState.transactions[0].source, 'shared-vouch');
  assert.equal(receiverState.campaigns[1].redemptionsToday, 2);
  assert.equal(receiverState.campaigns[1].platformFeeAccrued, .1);
  await receiver.request('/scan/payment', { journeyId: claimedScan.id, amount: '4.80' });
  assert.equal(credit((await receiver.state()).demo, 'green-bowl'), .5);
  await sender.request('/home');
  assert.equal(credit((await sender.state()).demo, 'green-bowl'), .7);

  const wrongMerchant = visitor();
  await wrongMerchant.request(offerPath + '/claim', {});
  const wrongScan = await scan(wrongMerchant, 'spice-lane');
  await wrongMerchant.request('/scan/payment', { journeyId: wrongScan.id, amount: '4.80' });
  const wrongState = (await wrongMerchant.state()).demo;
  assert.equal(wrongState.activeVouchClaim.status, 'CLAIMED');
  assert.equal(credit(wrongState, 'green-bowl'), 0);
  assert.equal(credit(wrongState, 'spice-lane'), .5);
});

test('Direct guards and all rendered pages / navigation destinations', async function() {
  const v = visitor();
  for (const path of ['/payment', '/order', '/collection', '/vouch', '/vouch/missing',
    '/payment-success/missing', '/scan/payment']) {
    assert.equal((await v.request(path)).status, 302, path);
  }
  const order = await accept(v);
  await v.request('/payment', { journeyId: order.id });
  const id = (await v.state()).demo.currentOrder.transactionId;
  const pages = ['/home', '/profile', '/profile?tab=vouches', '/profile?tab=transactions',
    '/order', '/transactions/' + id, '/merchant', '/merchant?tab=orders',
    '/merchant?tab=results', '/scan', '/payment-success/' + id,
    '/css/style.css', '/js/script.js'];
  for (const path of pages) assert.equal((await v.request(path)).status, 200, path);
  await collect(v, order);
  assert.equal((await v.request('/vouch/' + id)).status, 200);
  await v.request('/vouch/' + id, { action: 'create', tag: 'good-hangout' });
  assert.equal((await v.request('/vouch/' + id + '/success')).status, 200);
  const links = new Set();
  for (const path of pages.slice(0, -2)) {
    const html = (await v.request(path)).html;
    for (const match of html.matchAll(/href="(\/[^"]*)"/g)) links.add(match[1].replaceAll('&amp;', '&'));
  }
  for (const link of links) assert.ok((await v.request(link)).status < 400, link);
});
