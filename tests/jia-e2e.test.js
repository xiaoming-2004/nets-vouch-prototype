const test = require('node:test');
const assert = require('node:assert/strict');
const { app, demoStore, getMerchantCampaigns, clearDiscoveryCache,
  resetMerchantCampaigns, resetReferralCooldowns } = require('../app');

const realFetch = global.fetch;
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
test.beforeEach(async function() {
  delete process.env.FOURSQUARE_API_KEY;
  resetMerchantCampaigns();
  resetReferralCooldowns();
  await visitor().request('/reset-demo', {});
});
test.afterEach(function() {
  global.fetch = realFetch;
  if (originalFoursquareKey === undefined) delete process.env.FOURSQUARE_API_KEY;
  else process.env.FOURSQUARE_API_KEY = originalFoursquareKey;
});

function visitor() {
  let cookie = '';
  return {
    async request(path, body, extraHeaders) {
      const isJson = extraHeaders && extraHeaders['Content-Type'] === 'application/json';
      const response = await realFetch(base + path, {
        method: body === undefined ? 'GET' : 'POST', redirect: 'manual',
        headers: { Cookie: cookie, ...(body === undefined ? {} : {
          'Content-Type': isJson ? 'application/json' : 'application/x-www-form-urlencoded'
        }), ...extraHeaders },
        body: body === undefined ? undefined : isJson ? JSON.stringify(body) : new URLSearchParams(body)
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

function campaign(id) {
  return getMerchantCampaigns().find(function(item) { return item.merchantId === id; });
}

function merchantId(html) {
  const match = html.match(/data-merchant-id="([^"]+)"/);
  assert.ok(match, 'recommendation card should identify its merchant');
  return match[1];
}

async function onboardAndMatch(v) {
  const home = await v.request('/home');
  assert.match(home.html, /action="\/setup-preferences"/);
  assert.match(home.html, /href="\/scan"/);
  assert.match(home.html, /href="\/profile"/);
  assert.equal((await v.request('/setup-preferences', {
    moodCuisine: 'any', dietaryPreference: 'none', craving: ''
  })).location, '/home');
  // Mirrors the visible "Use demo location" control when a real GPS fix is unavailable.
  assert.equal((await v.request('/smart-match/location', { status: 'fallback' },
    { 'Content-Type': 'application/json' })).status, 204);
  const result = await v.request('/smart-match/result');
  assert.equal(result.status, 200);
  assert.match(result.html, /Choose this/);
  return result;
}

async function chooseAndScan(v, cardHtml, amount, useCredit) {
  const id = merchantId(cardHtml);
  assert.match(cardHtml, /action="\/recommendation\/accept"/);
  assert.equal((await v.request('/recommendation/accept', { merchantId: id })).location, '/scan');
  const home = await v.request('/home');
  assert.match(home.html, /Scan when you arrive/);
  assert.match(home.html, /href="\/scan"/);
  const scan = await v.request('/scan');
  assert.match(scan.html, new RegExp('value="' + id + '"'));
  assert.match(scan.html, /scan-merchant-row--active/);
  assert.match(scan.html, /No camera\? Tap a merchant/);
  assert.match(scan.html, /action="\/scan"/);
  assert.match((await v.request('/scan', { merchantId: id })).location, /^\/scan\/payment/);
  const pending = (await v.state()).demo.currentScanPayment;
  assert.equal(pending.merchantId, id);
  assert.equal(pending.attributionSource, 'smart-match');
  const paymentPage = await v.request('/scan/payment');
  assert.match(paymentPage.html, /name="amount"/);
  assert.match(paymentPage.html, /data-pay-button/);
  const posted = await v.request('/scan/payment', {
    journeyId: pending.id, amount: amount, useCashback: useCredit ? 'on' : ''
  });
  assert.match(posted.location, /^\/payment-success\/tx-/);
  return { id: id, pending: pending, transaction: (await v.state()).demo.transactions[0] };
}

test('Jia completes rejection → Choose this → Scan → Pay → Vouch → share → Profile → reset', async function() {
  const jia = visitor();
  assert.equal((await jia.request('/reset-demo', {})).location, '/home?reset=done');
  const fresh = (await jia.state()).demo;
  assert.equal(fresh.user.id, 'jia');
  assert.equal(fresh.selectedMerchantId, null);
  assert.equal(fresh.currentScanPayment, null);
  assert.equal(fresh.activeVouchClaim, null);
  assert.deepEqual(fresh.transactions, []);
  assert.deepEqual(fresh.vouchCredits, {});
  assert.deepEqual(fresh.paymentVerifiedVouches, []);
  assert.match((await jia.request('/profile/activity')).html, /No NETS activity yet/);
  assert.match((await jia.request('/profile/vouches')).html, /Your first Vouch starts/);
  const firstCard = await onboardAndMatch(jia);
  const rejectedId = merchantId(firstCard.html);
  assert.match(firstCard.html, /Not for me/);
  assert.match(firstCard.html, /action="\/recommendation\/reject"/);
  const rejected = await jia.request('/recommendation/reject', {
    merchantId: rejectedId, reason: 'not-in-mood'
  }, { 'X-Requested-With': 'smart-match' });
  assert.equal(rejected.status, 204);
  const secondCard = await jia.request('/smart-match/result');
  const chosenId = merchantId(secondCard.html);
  assert.notEqual(chosenId, rejectedId);
  const paid = await chooseAndScan(jia, secondCard.html, '8.50', false);
  const tx = paid.transaction;
  assert.equal(tx.source, 'SMART_MATCH');
  assert.equal(tx.ownerUserId, 'jia');
  assert.equal(tx.merchantId, chosenId);
  assert.equal(tx.purchaseAmount, 8.50);
  assert.equal(tx.merchantCreditUsed, 0);
  assert.equal(tx.netsPaid, 8.50);
  assert.equal(tx.merchantRewardEarned, 0.50);
  assert.equal((await jia.state()).demo.vouchCredits[chosenId], 0.50);
  const c = campaign(chosenId);
  assert.equal(c.metrics.smartMatchShown, 1);
  assert.equal(c.metrics.smartMatchAccepted, 1);
  assert.equal(c.metrics.smartMatchPayments, 1);
  assert.equal(c.metrics.smartMatchSales, 8.50);
  assert.equal(c.metrics.directScanPayments, 0);
  assert.equal(c.metrics.sharedVouchPayments, 0);
  assert.equal(c.metrics.rewardCost, 0.50);
  assert.equal(c.rewardBudgetSpentToday, 0.50);
  assert.equal(c.redemptionsToday, 1);
  assert.equal(c.platformFeeAccrued, c.platformFeePerAttributedPayment);
  const success = await jia.request('/payment-success/' + tx.id);
  assert.match(success.html, /Payment successful/);
  assert.match(success.html, /\$8\.50/);
  assert.match(success.html, /\+\$0\.50 Vouch Credit earned/);
  assert.match(success.html, /action="\/vouch\/[^\"]+"/);
  assert.match(success.html, /Not now/);
  await jia.request('/payment-success/' + tx.id);
  await jia.request('/scan/payment', { journeyId: paid.pending.id, amount: '8.50' });
  assert.equal((await jia.state()).demo.transactions.length, 1);
  assert.equal(c.metrics.payments, 1);
  const created = await jia.request('/vouch/' + tx.id, { action: 'create', tag: 'worth-it' });
  assert.equal(created.location, '/vouch/' + tx.id + '/success');
  await jia.request('/vouch/' + tx.id, { action: 'create', tag: 'worth-it' });
  const vouch = (await jia.state()).demo.paymentVerifiedVouches[0];
  assert.equal((await jia.state()).demo.paymentVerifiedVouches.length, 1);
  assert.equal(vouch.transactionId, tx.id);
  assert.equal(vouch.merchantId, chosenId);
  assert.equal(vouch.tagLabel, 'Worth It');
  const shared = await jia.request(created.location);
  assert.match(shared.html, /Payment-Verified Vouch/);
  assert.match(shared.html, /data-share-platform="whatsapp"/);
  assert.match(shared.html, /data-share-platform="telegram"/);
  assert.match(shared.html, /data-share-platform="copy"/);
  assert.match(shared.html, new RegExp('data-share-path="/offers/' + vouch.shareToken + '"'));
  assert.ok(!shared.html.includes('$8.50'), 'public share content must not expose payment amount');
  const browserScript = await jia.request('/js/script.js');
  assert.match(browserScript.html, /https:\/\/wa\.me\/\?text=/);
  assert.match(browserScript.html, /https:\/\/t\.me\/share\/url\?url=/);
  assert.match(browserScript.html, /shareGrid\.dataset\.sharePath/);
  const profile = await jia.request('/profile');
  assert.match(profile.html, /Jia Yi/);
  assert.match(profile.html, /Your Vouch Credits/);
  assert.match(profile.html, /href="\/profile\/activity"/);
  assert.match(profile.html, /href="\/profile\/vouches"/);
  const activity = await jia.request('/profile/activity');
  assert.equal((activity.html.match(/class="payment-row"/g) || []).length, 1);
  assert.match(activity.html, new RegExp('/transactions/' + tx.id));
  assert.match(activity.html, /\$8\.50/);
  assert.ok(!activity.html.includes('Vouch Credit used: $0.00'));
  const detail = await jia.request('/transactions/' + tx.id);
  assert.equal(detail.status, 200);
  assert.match(detail.html, /Paid with NETS/);
  assert.match(detail.html, /\+\$0\.50 Vouch Credit earned/);
  assert.ok(!detail.html.includes(tx.id), 'detail should not surface an internal ID');
  const vouches = await jia.request('/profile/vouches');
  assert.match(vouches.html, /Payment-Verified/);
  assert.match(vouches.html, /Worth It/);
  assert.match(vouches.html, /Share again/);
  assert.match(vouches.html, new RegExp('/vouch/' + tx.id + '/success'));
  await jia.request('/profile/activity');
  await jia.request('/transactions/' + tx.id);
  await jia.request('/profile/vouches');
  await jia.request('/vouch/' + tx.id + '/success');
  assert.equal((await jia.state()).demo.transactions.length, 1);
  assert.equal((await jia.state()).demo.paymentVerifiedVouches.length, 1);
  assert.equal(c.metrics.payments, 1);
  assert.equal((await jia.request('/reset-demo', {})).location, '/home?reset=done');
  const clean = (await jia.state()).demo;
  assert.deepEqual(clean.transactions, []);
  assert.deepEqual(clean.vouchCredits, {});
  assert.deepEqual(clean.paymentVerifiedVouches, []);
  assert.equal(clean.selectedMerchantId, null);
  assert.equal(clean.currentScanPayment, null);
  assert.equal(c.metrics.payments, 0);
  assert.equal(c.metrics.rewardCost, 0);
  assert.match((await jia.request('/profile/activity')).html, /No NETS activity yet/);
  assert.equal((await jia.request('/transactions/' + tx.id)).status, 404);
});

test('Not now keeps the successful payment and reward without creating a Vouch', async function() {
  const jia = visitor();
  const card = await onboardAndMatch(jia);
  const paid = await chooseAndScan(jia, card.html, '10.00', false);
  const tx = paid.transaction;
  const receipt = await jia.request('/payment-success/' + tx.id);
  assert.match(receipt.html, /name="action" value="skip"/);
  assert.equal((await jia.request('/vouch/' + tx.id, { action: 'skip' })).location, '/home');
  const state = (await jia.state()).demo;
  assert.equal(state.transactions.length, 1);
  assert.equal(state.transactions[0].vouchDecision, 'skipped');
  assert.equal(state.transactions[0].merchantRewardEarned, 0.50);
  assert.equal(state.vouchCredits[paid.id], 0.50);
  assert.deepEqual(state.paymentVerifiedVouches, []);
  assert.equal((await jia.request('/vouch/' + tx.id)).location, '/home');
  assert.equal((await jia.request('/profile/activity')).html.includes(tx.id), true);
  assert.match((await jia.request('/profile/vouches')).html, /Your first Vouch starts/);
});

test('credit stays merchant-specific and the server leaves at least $1 payable with NETS', async function() {
  const jia = visitor();
  await jia.request('/home');
  await jia.change(function(demo) { demo.vouchCredits['felicia-chicken-rice'] = 5; });
  await jia.request('/scan', { merchantId: 'green-bowl' });
  const wrongScan = (await jia.state()).demo.currentScanPayment;
  const wrongPage = await jia.request('/scan/payment');
  assert.ok(!wrongPage.html.includes('credit-toggle'));
  await jia.request('/scan/payment', { journeyId: wrongScan.id, amount: '5.00', useCashback: 'on' });
  let state = (await jia.state()).demo;
  assert.equal(state.transactions[0].merchantCreditUsed, 0);
  assert.equal(state.transactions[0].netsPaid, 5);
  assert.equal(state.vouchCredits['felicia-chicken-rice'], 5);
  await jia.request('/vouch/' + state.transactions[0].id, { action: 'skip' });
  await jia.request('/scan', { merchantId: 'felicia-chicken-rice' });
  const ownScan = (await jia.state()).demo.currentScanPayment;
  const ownPage = await jia.request('/scan/payment');
  assert.match(ownPage.html, /\$5\.00 available/);
  await jia.request('/scan/payment', { journeyId: ownScan.id, amount: '5.00', useCashback: 'on' });
  state = (await jia.state()).demo;
  const tx = state.transactions[0];
  assert.equal(tx.merchantCreditUsed, 4);
  assert.equal(tx.netsPaid, 1);
  assert.equal(tx.eligible, true);
  assert.equal(tx.merchantRewardEarned, 0.50);
  assert.equal(state.vouchCredits['felicia-chicken-rice'], 1.50);
  const activity = await jia.request('/profile/activity');
  assert.match(activity.html, /Vouch Credit used: \$4\.00/);
  assert.match(activity.html, /\$1\.00/);
  assert.equal((activity.html.match(/class="payment-row"/g) || []).length, 2);
});

test('another browser never inherits Jia selection, transaction, credit or Vouch', async function() {
  const jia = visitor();
  const card = await onboardAndMatch(jia);
  const paid = await chooseAndScan(jia, card.html, '8.50', false);
  await jia.request('/vouch/' + paid.transaction.id, { action: 'create' });
  const other = visitor();
  await other.request('/demo/identity', { userId: 'darren' });
  const state = (await other.state()).demo;
  assert.equal(state.selectedMerchantId, null);
  assert.deepEqual(state.transactions, []);
  assert.deepEqual(state.vouchCredits, {});
  assert.deepEqual(state.paymentVerifiedVouches, []);
  assert.match((await other.request('/profile/activity')).html, /No NETS activity yet/);
  assert.match((await other.request('/profile/vouches')).html, /Your first Vouch starts/);
  assert.equal((await other.request('/transactions/' + paid.transaction.id)).status, 404);
  assert.equal((await other.request('/payment-success/' + paid.transaction.id)).status, 404);
});

test('rejecting from a loaded Foursquare batch makes no extra provider request', async function() {
  clearDiscoveryCache();
  process.env.FOURSQUARE_API_KEY = 'test-only-key';
  const places = ['A', 'B', 'C', 'D', 'E'].map(function(label, index) {
    return { fsq_place_id: 'jia-e2e-' + label, name: 'Food ' + label,
      latitude: 1.451 + index * 0.0001, longitude: 103.821,
      distance: 100 + index * 60, categories: [{ name: 'Restaurant' }],
      location: { formatted_address: 'Singapore' } };
  });
  let providerCalls = 0;
  global.fetch = async function(url) {
    assert.equal(new URL(String(url)).hostname, 'places-api.foursquare.com');
    providerCalls += 1;
    return { ok: true, json: async function() { return { results: places }; } };
  };
  const jia = visitor();
  await jia.request('/setup-preferences', { moodCuisine: 'any', dietaryPreference: 'none' });
  assert.equal((await jia.request('/smart-match/location',
    { latitude: 1.451, longitude: 103.821 }, { 'Content-Type': 'application/json' })).status, 204);
  const first = merchantId((await jia.request('/smart-match/result')).html);
  assert.equal(providerCalls, 1);
  await jia.request('/recommendation/reject', { merchantId: first, reason: 'not-in-mood' });
  const second = merchantId((await jia.request('/smart-match/result')).html);
  assert.notEqual(second, first);
  assert.equal(providerCalls, 1);
  assert.equal((await jia.request('/recommendation/accept', { merchantId: second })).location, '/scan');
});
