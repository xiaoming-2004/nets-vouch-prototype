const test = require('node:test');
const assert = require('node:assert/strict');
const { app, demoStore, getMerchantCampaigns } = require('../app');

// Tests must never reach real providers, even when .env configures keys: Google is the default
// discovery provider and Groq the default ranker, so each test starts without those (and the other
// AI/research) keys. Tests that need a provider set a fake key and mock fetch.
const isolatedProviderEnv = ['GOOGLE_PLACES_API_KEY', 'PLACES_PROVIDER', 'GROQ_API_KEY', 'OPENAI_API_KEY', 'TAVILY_API_KEY'];
const originalProviderEnv = {};
isolatedProviderEnv.forEach(function(key) { originalProviderEnv[key] = process.env[key]; });
test.beforeEach(function() {
  isolatedProviderEnv.forEach(function(key) { delete process.env[key]; });
});
test.after(function() {
  isolatedProviderEnv.forEach(function(key) {
    if (originalProviderEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalProviderEnv[key];
  });
});

let server;
let base;
const originalFoursquareKey = process.env.FOURSQUARE_API_KEY;

test.before(async function() {
  delete process.env.FOURSQUARE_API_KEY;
  server = await new Promise(function(resolve) {
    const instance = app.listen(0, '127.0.0.1', function() { resolve(instance); });
  });
  base = 'http://127.0.0.1:' + server.address().port;
});
test.after(function() {
  server.close();
  if (originalFoursquareKey === undefined) delete process.env.FOURSQUARE_API_KEY;
  else process.env.FOURSQUARE_API_KEY = originalFoursquareKey;
});
test.beforeEach(async function() { await visitor().request('/reset-demo', {}); });

function visitor() {
  let cookie = '';
  return {
    async request(path, body) {
      const response = await fetch(base + path, {
        method: body === undefined ? 'GET' : 'POST', redirect: 'manual',
        headers: { Cookie: cookie, ...(body === undefined ? {} : { 'Content-Type': 'application/x-www-form-urlencoded' }) },
        body: body === undefined ? undefined : new URLSearchParams(body)
      });
      const setCookie = response.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      const html = await response.text();
      assert.ok(response.status < 500, path + ' returned ' + response.status + '\n' + html);
      return { status: response.status, location: response.headers.get('location'), html: html };
    },
    async state() {
      const id = decodeURIComponent(cookie.split('=')[1]).slice(2).split('.')[0];
      return new Promise(function(resolve, reject) {
        demoStore.get(id, function(error, state) { if (error) reject(error); else resolve(state.demo); });
      });
    },
    async change(update) {
      const id = decodeURIComponent(cookie.split('=')[1]).slice(2).split('.')[0];
      const stored = await new Promise(function(resolve, reject) {
        demoStore.get(id, function(error, state) { if (error) reject(error); else resolve(state); });
      });
      update(stored.demo);
      await new Promise(function(resolve, reject) {
        demoStore.set(id, stored, function(error) { if (error) reject(error); else resolve(); });
      });
    }
  };
}

function campaign(id) {
  return getMerchantCampaigns().find(function(item) { return item.merchantId === id; });
}

async function pay(v, merchantId, amount) {
  const scanPage = await v.request('/scan');
  assert.match(scanPage.html, new RegExp('value="' + merchantId + '"'));
  assert.match((await v.request('/scan', { merchantId: merchantId })).location, /^\/scan\/payment/);
  const journey = (await v.state()).currentScanPayment;
  const posted = await v.request('/scan/payment', { journeyId: journey.id, amount: amount });
  assert.match(posted.location, /^\/payment-success\/tx-/);
  return { journey: journey, transaction: (await v.state()).transactions[0] };
}

async function createOffer(merchantId) {
  const jia = visitor();
  const paid = await pay(jia, merchantId, '7.20');
  assert.equal((await jia.request('/vouch/' + paid.transaction.id, { action: 'create' })).location,
    '/vouch/' + paid.transaction.id + '/success');
  const vouch = (await jia.state()).paymentVerifiedVouches[0];
  const share = await jia.request('/vouch/' + paid.transaction.id + '/success');
  const path = '/offers/' + vouch.shareToken;
  assert.match(share.html, new RegExp('data-share-path="' + path + '"'));
  for (const platform of ['whatsapp', 'telegram', 'copy']) {
    assert.match(share.html, new RegExp('data-share-platform="' + platform + '"'));
  }
  assert.ok(!share.html.includes('$7.20'), 'shared page must keep the purchase amount private');
  return { jia: jia, paid: paid, vouch: vouch, path: path };
}

async function darren() {
  const v = visitor();
  assert.equal((await v.request('/demo/identity', { userId: 'darren' })).location, '/demo');
  assert.equal((await v.state()).user.id, 'darren');
  return v;
}

test('Jia Vouch → Darren link → claim → same-merchant scan/payment → rewards, Activity, analytics and reset', async function() {
  const merchantId = 'green-bowl';
  const offer = await createOffer(merchantId);
  const c = campaign(merchantId);
  const receiver = await darren();
  const open = await receiver.request(offer.path);
  assert.match(open.html, /Claim offer/);
  assert.match(open.html, /Verified NETS Visit/);
  assert.ok(!open.html.includes('$7.20'));
  assert.equal((await receiver.state()).transactions.length, 0);
  assert.equal((await receiver.state()).vouchCredits[merchantId] || 0, 0);
  assert.equal(c.metrics.sharedVouchClaims, 0);
  assert.equal(c.metrics.sharedVouchPayments, 0);

  assert.equal((await receiver.request(offer.path + '/claim', {})).location, offer.path);
  let state = await receiver.state();
  assert.equal(state.activeVouchClaim.status, 'CLAIMED');
  assert.equal(state.activeVouchClaim.senderUserId, 'jia');
  assert.equal(state.activeVouchClaim.recipientUserId, 'darren');
  assert.equal(state.activeVouchClaim.merchantId, merchantId);
  assert.ok(state.activeVouchClaim.expiresAt > Date.now());
  assert.equal(state.transactions.length, 0);
  assert.equal(state.vouchCredits[merchantId] || 0, 0);
  assert.equal(c.metrics.sharedVouchClaims, 1);
  assert.equal(c.redemptionsToday, 1, 'only Jia purchase has used a reward slot');
  assert.equal(c.rewardBudgetSpentToday, 0.50);
  assert.match((await receiver.request(offer.path)).html, /Offer saved/);
  await receiver.request(offer.path + '/claim', {});
  assert.equal(c.metrics.sharedVouchClaims, 1);

  const scanPage = await receiver.request('/scan');
  assert.match(scanPage.html, new RegExp('value="' + merchantId + '"'));
  assert.match(scanPage.html, /scan-merchant-row--active/);
  const paid = await pay(receiver, merchantId, '6.00');
  state = await receiver.state();
  assert.equal(paid.transaction.source, 'SHARED_VOUCH');
  assert.equal(paid.transaction.ownerUserId, 'darren');
  assert.equal(paid.transaction.merchantId, merchantId);
  assert.equal(paid.transaction.merchantRewardEarned, 0.50);
  assert.equal(state.activeVouchClaim.status, 'REDEEMED');
  assert.equal(state.vouchCredits[merchantId], 0.50);
  assert.equal(c.metrics.payments, 2);
  assert.equal(c.metrics.sharedVouchPayments, 1);
  assert.equal(c.metrics.sharedVouchSales, 6);
  assert.equal(c.metrics.smartMatchPayments, 0);
  assert.equal(c.metrics.directScanPayments, 1, 'Jia original purchase remains a direct scan');
  assert.equal(c.redemptionsToday, 2);
  assert.equal(c.rewardBudgetSpentToday, 1.20);
  assert.equal(c.metrics.rewardCost, 1.20);
  assert.equal(c.platformFeeAccrued, c.platformFeePerAttributedPayment);
  // A stale/replayed Claim form must not turn a redeemed offer back into a new claim.
  await receiver.request(offer.path + '/claim', {});
  assert.equal((await receiver.state()).activeVouchClaim.status, 'REDEEMED');
  assert.equal(c.metrics.sharedVouchClaims, 1);

  const firstReceipt = await receiver.request('/payment-success/' + paid.transaction.id);
  assert.match(firstReceipt.html, /Payment successful/);
  await receiver.request('/payment-success/' + paid.transaction.id);
  await receiver.request('/scan/payment', { journeyId: paid.journey.id, amount: '6.00' });
  assert.equal((await receiver.state()).transactions.length, 1);
  assert.equal(c.metrics.payments, 2);
  assert.equal(c.rewardBudgetSpentToday, 1.20);
  const activity = await receiver.request('/profile/activity');
  assert.equal((activity.html.match(/class="payment-row"/g) || []).length, 1);
  assert.match(activity.html, /Green Bowl/);
  assert.equal((await receiver.request('/transactions/' + paid.transaction.id)).status, 200);
  assert.equal((await offer.jia.request('/transactions/' + paid.transaction.id)).status, 404);
  const jiaActivity = await offer.jia.request('/profile/activity');
  assert.equal((jiaActivity.html.match(/class="payment-row"/g) || []).length, 1);
  assert.equal((await offer.jia.state()).transactions.length, 1);
  assert.equal((await offer.jia.state()).vouchCredits[merchantId], 0.70);
  assert.equal((await offer.jia.state()).paymentVerifiedVouches.length, 1);

  assert.equal((await offer.jia.request('/reset-demo', {})).location, '/home?reset=done');
  assert.deepEqual((await offer.jia.state()).transactions, []);
  assert.deepEqual((await offer.jia.state()).vouchCredits, {});
  assert.deepEqual((await offer.jia.state()).paymentVerifiedVouches, []);
  assert.deepEqual((await receiver.state()).transactions, []);
  assert.deepEqual((await receiver.state()).vouchCredits, {});
  assert.equal((await receiver.state()).activeVouchClaim, null);
  assert.equal((await receiver.request(offer.path)).status, 404);
  assert.equal(c.metrics.sharedVouchClaims, 0);
  assert.equal(c.metrics.sharedVouchPayments, 0);
  assert.equal(c.rewardBudgetSpentToday, 0);
  const freshOffer = await createOffer(merchantId);
  await receiver.request('/demo/identity', { userId: 'darren' });
  await receiver.request(freshOffer.path + '/claim', {});
  assert.equal((await receiver.state()).activeVouchClaim.status, 'CLAIMED');
  assert.equal((await pay(receiver, merchantId, '6.00')).transaction.source, 'SHARED_VOUCH');
});

test('self-referral is blocked and a wrong-merchant payment stays ordinary', async function() {
  const offer = await createOffer('green-bowl');
  const sameIdentity = visitor();
  await sameIdentity.request(offer.path + '/claim', {});
  assert.equal((await sameIdentity.state()).activeVouchClaim, null);
  assert.equal(campaign('green-bowl').metrics.sharedVouchClaims, 0);

  const receiver = await darren();
  await receiver.request(offer.path + '/claim', {});
  const before = campaign('green-bowl').metrics.sharedVouchPayments;
  const wrong = await pay(receiver, 'felicia-chicken-rice', '6.00');
  const state = await receiver.state();
  assert.equal(wrong.transaction.source, 'DIRECT_SCAN');
  assert.equal(state.activeVouchClaim.status, 'CLAIMED');
  assert.equal(state.vouchCredits['green-bowl'] || 0, 0);
  assert.equal(campaign('green-bowl').metrics.sharedVouchPayments, before);
  assert.equal(campaign('green-bowl').rewardBudgetSpentToday, 0.50);
  assert.equal(campaign('felicia-chicken-rice').metrics.directScanPayments, 1);
});

test('expired claim cannot redeem; cooldown prevents a second referral conversion', async function() {
  const offer = await createOffer('green-bowl');
  const receiver = await darren();
  await receiver.request(offer.path + '/claim', {});
  await receiver.change(function(demo) { demo.activeVouchClaim.expiresAt = Date.now() - 1; });
  const expired = await pay(receiver, 'green-bowl', '6.00');
  assert.equal(expired.transaction.source, 'DIRECT_SCAN');
  assert.equal((await receiver.state()).activeVouchClaim.status, 'EXPIRED');
  assert.equal(campaign('green-bowl').metrics.sharedVouchPayments, 0);

  // A fresh claim converts, then the same sender/recipient/merchant cannot convert again in 30 days.
  await receiver.request('/vouch/' + expired.transaction.id, { action: 'skip' });
  await receiver.request(offer.path + '/claim', {});
  const first = await pay(receiver, 'green-bowl', '6.00');
  assert.equal(first.transaction.source, 'SHARED_VOUCH');
  await receiver.request('/vouch/' + first.transaction.id, { action: 'skip' });
  await receiver.request(offer.path + '/claim', {});
  const repeat = await pay(receiver, 'green-bowl', '6.00');
  assert.equal(repeat.transaction.source, 'DIRECT_SCAN');
  assert.equal(repeat.transaction.merchantRewardEarned, 0);
  assert.equal(campaign('green-bowl').metrics.sharedVouchPayments, 1);
});

test('receiver priority, exhausted budget and rewarded-payment cap never overspend', async function() {
  const offer = await createOffer('green-bowl');
  const receiver = await darren();
  await receiver.request(offer.path + '/claim', {});
  const c = campaign('green-bowl');
  c.maxRewardBudgetPerDay = 1.10; // $0.60 left: receiver $0.50 fits; sender $0.20 does not.
  const paid = await pay(receiver, 'green-bowl', '6.00');
  assert.equal(paid.transaction.source, 'SHARED_VOUCH');
  assert.equal(paid.transaction.merchantRewardEarned, 0.50);
  assert.equal(c.rewardBudgetSpentToday, 1.00);
  assert.equal(c.redemptionsToday, 2);
  await offer.jia.request('/home');
  assert.equal((await offer.jia.state()).vouchCredits['green-bowl'], 0.50);

  await receiver.request('/vouch/' + paid.transaction.id, { action: 'skip' });
  const anotherOffer = await createOffer('felicia-chicken-rice');
  await receiver.request(anotherOffer.path + '/claim', {});
  const felicia = campaign('felicia-chicken-rice');
  felicia.maxRewardBudgetPerDay = felicia.rewardBudgetSpentToday;
  const noBudget = await pay(receiver, 'felicia-chicken-rice', '6.00');
  assert.equal(noBudget.transaction.merchantRewardEarned, 0);
  assert.ok(felicia.rewardBudgetSpentToday <= felicia.maxRewardBudgetPerDay);
  assert.equal(felicia.redemptionsToday, 1);

  // The cap blocks a customer payout; payment still records once.
  const cappedReceiver = await darren();
  await cappedReceiver.request(anotherOffer.path + '/claim', {});
  felicia.maxRewardBudgetPerDay = 10;
  felicia.maxRewardedPaymentsPerDay = felicia.redemptionsToday;
  const capped = await pay(cappedReceiver, 'felicia-chicken-rice', '6.00');
  assert.equal(capped.transaction.merchantRewardEarned, 0);
  assert.equal(felicia.redemptionsToday, 1);
});
