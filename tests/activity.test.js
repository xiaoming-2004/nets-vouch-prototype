const test = require('node:test');
const assert = require('node:assert/strict');
const { app, demoStore, resetMerchantCampaigns, resetReferralCooldowns } = require('../app');

// Discovery must never reach the real Google Places API from tests, even when .env configures a
// key: Google is the default primary provider, so each test starts without it (tests that need
// Google set a fake key and mock fetch).
const originalGooglePlacesKey = process.env.GOOGLE_PLACES_API_KEY;
const originalPlacesProvider = process.env.PLACES_PROVIDER;
test.beforeEach(function() {
  delete process.env.GOOGLE_PLACES_API_KEY;
  delete process.env.PLACES_PROVIDER;
});
test.after(function() {
  if (originalGooglePlacesKey !== undefined) process.env.GOOGLE_PLACES_API_KEY = originalGooglePlacesKey;
  if (originalPlacesProvider !== undefined) process.env.PLACES_PROVIDER = originalPlacesProvider;
});

const originalFoursquareKey = process.env.FOURSQUARE_API_KEY;
let server;
let base;

test.before(async function() {
  server = await new Promise(function(resolve) {
    const instance = app.listen(0, '127.0.0.1', function() { resolve(instance); });
  });
  base = 'http://127.0.0.1:' + server.address().port;
});
test.after(function() { server.close(); });
test.beforeEach(function() {
  resetMerchantCampaigns();
  resetReferralCooldowns();
  delete process.env.FOURSQUARE_API_KEY;
});
test.afterEach(function() {
  if (originalFoursquareKey === undefined) delete process.env.FOURSQUARE_API_KEY;
  else process.env.FOURSQUARE_API_KEY = originalFoursquareKey;
});

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
      return { status: response.status, location: response.headers.get('location'), html: await response.text() };
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

async function pay(v, merchantId, amount, useCredit) {
  await v.request('/scan');
  assert.equal((await v.request('/scan', { merchantId: merchantId })).status, 302);
  const journey = (await v.state()).demo.currentScanPayment;
  const paid = await v.request('/scan/payment', {
    journeyId: journey.id, amount: amount, useCashback: useCredit ? 'on' : ''
  });
  assert.match(paid.location, /^\/payment-success\/tx-/);
  return (await v.state()).demo.transactions[0];
}

function rowCount(html) { return (html.match(/class="payment-row"/g) || []).length; }

test('fresh Activity is empty; incomplete and foreign records remain hidden', async function() {
  const v = visitor();
  const fresh = await v.request('/profile/activity');
  assert.equal(rowCount(fresh.html), 0);
  assert.match(fresh.html, /No NETS activity yet/);
  assert.ok(!fresh.html.includes('tx-h1'));
  await v.change(function(demo) {
    demo.transactions.push({ id: 'pending', ownerUserId: 'jia', merchantName: 'Incomplete',
      status: 'PENDING', paymentMethod: 'NETS', netsPaid: 8.5, createdAt: new Date().toISOString() });
    demo.transactions.push({ id: 'foreign', ownerUserId: 'darren', merchantName: 'Other user',
      status: 'Successful', paymentMethod: 'NETS', netsPaid: 12, createdAt: new Date().toISOString() });
  });
  const activity = await v.request('/profile/activity');
  assert.equal(rowCount(activity.html), 0);
  assert.ok(!activity.html.includes('Incomplete'));
  assert.ok(!activity.html.includes('Other user'));
  assert.equal((await v.request('/transactions/pending')).status, 404);
});

test('one successful Direct Scan shows one owned NETS amount and no zero-credit noise', async function() {
  const v = visitor();
  const tx = await pay(v, 'green-bowl', '3.00'); // Below campaign minimum, but payment succeeds.
  assert.equal(tx.source, 'DIRECT_SCAN');
  assert.equal(tx.merchantRewardEarned, 0);
  const activity = await v.request('/profile/activity');
  assert.equal(rowCount(activity.html), 1);
  assert.match(activity.html, /Green Bowl/);
  assert.match(activity.html, /\$3\.00/);
  assert.match(activity.html, /NETS · Successful/);
  assert.ok(!activity.html.includes('+$0.00'));
  assert.ok(!activity.html.includes('−$0.00'));
  assert.ok(!activity.html.includes('Vouch Credit used:'));
  assert.equal((await v.request('/transactions/' + tx.id)).status, 200);
});

test('merchant credit used and earned display factual two-decimal amounts', async function() {
  const v = visitor();
  await v.request('/home');
  await v.change(function(demo) { demo.vouchCredits['felicia-chicken-rice'] = 1; });
  const tx = await pay(v, 'felicia-chicken-rice', '5.00', true);
  assert.equal(tx.purchaseAmount, 5);
  assert.equal(tx.merchantCreditUsed, 1);
  assert.equal(tx.netsPaid, 4);
  assert.equal(tx.merchantRewardEarned, .5);
  const activity = await v.request('/profile/activity');
  assert.match(activity.html, /\$4\.00/);
  assert.match(activity.html, /Felicia&#39;s Chicken Rice Vouch Credit used: \$1\.00/);
  assert.match(activity.html, /\+\$0\.50 Vouch Credit/);
  const detail = await v.request('/transactions/' + tx.id);
  assert.match(detail.html, /Purchase total<\/dt><dd>\$5\.00/);
  assert.match(detail.html, /Vouch Credit used<\/dt><dd class="credit-applied">−\$1\.00/);
  assert.match(detail.html, /Paid with NETS<\/dt><dd>\$4\.00/);
});

test('Activity and detail stay private across sessions', async function() {
  const jia = visitor();
  const tx = await pay(jia, 'felicia-chicken-rice', '8.50');
  const darren = visitor();
  await darren.request('/demo/identity', { userId: 'darren' });
  const activity = await darren.request('/profile/activity');
  assert.equal(rowCount(activity.html), 0);
  assert.ok(!activity.html.includes(tx.merchantName));
  const detail = await darren.request('/transactions/' + tx.id);
  assert.equal(detail.status, 404);
  assert.equal(detail.html, 'Payment not found');
});

test('Activity sorts by completion timestamp, formats cents, and refresh creates nothing', async function() {
  const v = visitor();
  const first = await pay(v, 'green-bowl', '8.50');
  await v.request('/vouch/' + first.id, { action: 'skip' });
  await v.request('/transactions/' + first.id + '/done', {});
  const second = await pay(v, 'felicia-chicken-rice', '12');
  await v.change(function(demo) {
    demo.transactions.find(function(tx) { return tx.id === first.id; }).createdAt = '2026-09-22T12:00:00.000Z';
    demo.transactions.find(function(tx) { return tx.id === second.id; }).createdAt = '2026-09-21T12:00:00.000Z';
  });
  const activity = await v.request('/profile/activity');
  assert.equal(rowCount(activity.html), 2);
  assert.ok(activity.html.indexOf('/transactions/' + first.id) < activity.html.indexOf('/transactions/' + second.id));
  assert.match(activity.html, /\$8\.50/);
  assert.match(activity.html, /\$12\.00/);
  await v.request('/payment-success/' + second.id);
  await v.request('/transactions/' + second.id);
  await v.request('/profile/activity');
  assert.equal((await v.state()).demo.transactions.length, 2);
});

test('a Smart Match-attributed payment appears in Activity', async function() {
  const v = visitor();
  await v.request('/home');
  await v.request('/smart-match/result');
  const selected = (await v.state()).demo.selectedMerchantId;
  await v.request('/recommendation/accept', { merchantId: selected });
  const tx = await pay(v, selected, '5.00');
  assert.equal(tx.source, 'SMART_MATCH');
  assert.match((await v.request('/profile/activity')).html, new RegExp('/transactions/' + tx.id));
});

test('a Shared Vouch-attributed completed payment appears in receiver Activity', async function() {
  const sender = visitor();
  const senderTx = await pay(sender, 'green-bowl', '7.20');
  await sender.request('/vouch/' + senderTx.id, { action: 'create' });
  const token = (await sender.state()).demo.paymentVerifiedVouches[0].shareToken;
  const receiver = visitor();
  await receiver.request('/demo/identity', { userId: 'darren' });
  await receiver.request('/offers/' + token + '/claim', {});
  const receiverTx = await pay(receiver, 'green-bowl', '6.00');
  assert.equal(receiverTx.source, 'SHARED_VOUCH');
  const activity = await receiver.request('/profile/activity');
  assert.equal(rowCount(activity.html), 1);
  assert.match(activity.html, new RegExp('/transactions/' + receiverTx.id));
  assert.ok(!activity.html.includes(senderTx.id));
});
