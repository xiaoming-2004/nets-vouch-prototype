const { database: fixtureDb } = require('./helpers/test-isolation.cjs');
const seedLegacyLocation = require('./helpers/legacy-location.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const { app, demoStore, getMerchantCampaigns, getNearbyMerchants,
  clearDiscoveryCache, resetMerchantCampaigns } = require('../app');

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

const realFetch = global.fetch;
const originalKey = process.env.FOURSQUARE_API_KEY;
let server;
let base;

test.before(async function() {
  server = await new Promise(function(resolve) {
    const instance = app.listen(0, '127.0.0.1', function() { resolve(instance); });
  });
  base = 'http://127.0.0.1:' + server.address().port;
});
test.after(function() { server.close(); });
test.beforeEach(function() { delete process.env.FOURSQUARE_API_KEY; });
test.afterEach(function() {
  global.fetch = realFetch;
  resetMerchantCampaigns();
  if (originalKey === undefined) delete process.env.FOURSQUARE_API_KEY;
  else process.env.FOURSQUARE_API_KEY = originalKey;
});

function visitor() {
  let cookie = '';
  return {
    cookieValue() { return cookie; },
    async request(path, body) {
      const response = await realFetch(base + path, {
        method: body === undefined ? 'GET' : 'POST', redirect: 'manual',
        headers: { Cookie: cookie, ...(body === undefined ? {} : { 'Content-Type': 'application/x-www-form-urlencoded' }) },
        body: body === undefined ? undefined : new URLSearchParams(body)
      });
      const header = response.headers.get('set-cookie');
      if (header) cookie = header.split(';')[0];
      return { status: response.status, location: response.headers.get('location'), html: await response.text() };
    },
    async replaceState(state) {
      const id = decodeURIComponent(cookie.split('=')[1]).slice(2).split('.')[0];
      await new Promise((resolve, reject) => demoStore.set(id, state, error => error ? reject(error) : resolve()));
    },
    async state() {
      const id = decodeURIComponent(cookie.split('=')[1]).slice(2).split('.')[0];
      return new Promise(function(resolve, reject) {
        demoStore.get(id, function(error, data) { if (error) reject(error); else resolve(data); });
      });
    }
  };
}

async function reset(v) {
  const response = await v.request('/reset-demo', {});
  assert.equal(response.status, 302);
  assert.equal(response.location, '/home?reset=done');
  return (await v.state()).demo;
}

async function pay(v, merchantId, amount) {
  await v.request('/scan');
  assert.equal((await v.request('/scan', { merchantId: merchantId })).status, 302);
  const scan = (await v.state()).demo.currentScanPayment;
  const result = await v.request('/scan/payment', { journeyId: scan.id, amount: amount });
  assert.match(result.location, /^\/payment-success\/tx-/);
  return (await v.state()).demo.transactions[0];
}

function campaign(id) {
  return getMerchantCampaigns().find(function(item) { return item.merchantId === id; });
}

// Reward amounts and minimum spends are per-merchant campaign configuration a merchant can edit.
// Tests that assert literal reward figures pin the campaigns they pay at, after the reset that
// would otherwise restore the merchant catalogue's own values. Where a test checks that edited
// configuration survives a reset it pins only the campaign it pays at, never the edited one.
function pinCampaign(merchantId, rewardAmount, minimumEligibleSpend) {
  const c = campaign(merchantId);
  assert.ok(c, 'no campaign for ' + merchantId);
  c.rewardAmount = rewardAmount;
  c.minimumEligibleSpend = minimumEligibleSpend;
  return c;
}
function pinAllCampaigns(rewardAmount, minimumEligibleSpend) {
  getMerchantCampaigns().forEach(function(c) {
    c.rewardAmount = rewardAmount;
    c.minimumEligibleSpend = minimumEligibleSpend;
  });
}

test('fresh and repeated global resets are safe and confirm on Home', async function() {
  const v = visitor();
  await reset(v);
  await reset(v);
  const home = await v.request('/home?reset=done');
  assert.equal(home.status, 200);
  assert.match(home.html, /Demo reset successfully/);
  assert.equal((await v.request('/profile/activity')).html.includes('No NETS activity yet'), true);
});

test('payment, credit, Vouch, daily marker, idempotency and stale URLs reset', async function() {
  const v = visitor();
  await reset(v);
  pinCampaign('felicia-chicken-rice', 0.50, 5.00);
  const tx = await pay(v, 'felicia-chicken-rice', '5.00');
  await v.request('/vouch/' + tx.id, { action: 'create' });
  const token = (await v.state()).demo.paymentVerifiedVouches[0].shareToken;
  assert.match((await v.request('/profile/activity')).html, new RegExp(tx.id));
  assert.match((await v.request('/profile/rewards')).html, /\$0\.50/);
  assert.equal(campaign('felicia-chicken-rice').redemptionsToday, 1);
  const clean = await reset(v);
  assert.deepEqual(clean.transactions, []);
  assert.deepEqual(clean.vouchCredits, {});
  assert.deepEqual(clean.paymentVerifiedVouches, []);
  assert.deepEqual(clean.dailyMerchantRewards, {});
  assert.deepEqual(clean.processedPaymentAttempts, {});
  assert.equal(clean.currentScanPayment, null);
  assert.equal((await v.request('/profile/activity')).html.includes('No NETS activity yet'), true);
  assert.match((await v.request('/profile/vouches')).html, /Your first Vouch starts/);
  assert.equal((await v.request('/transactions/' + tx.id)).status, 404);
  assert.equal((await v.request('/payment-success/' + tx.id)).status, 404);
  assert.equal((await v.request('/vouch/' + tx.id)).status, 404);
  assert.equal((await v.request('/offers/' + token)).status, 404);
  const next = await pay(v, 'felicia-chicken-rice', '5.00');
  assert.notEqual(next.id, tx.id);
  assert.equal(next.merchantRewardEarned, 0.50);
  assert.equal((await v.state()).demo.transactions.length, 1);
});

test('Smart Match, preferences, location, selected merchant and partial scan reset', async function() {
  const v = visitor();
  await reset(v);
  await v.request('/profile', { dietaryPreference: 'halal', budget: '9', maxDistanceMinutes: '7', craving: '' });
  await seedLegacyLocation(v, { status: 'fallback' });
  await v.request('/smart-match/result');
  await v.request('/scan', { merchantId: 'green-bowl' });
  const before = (await v.state()).demo;
  assert.ok(before.shownMerchantIds.length > 0);
  assert.ok(before.currentScanPayment);
  const clean = await reset(v);
  assert.equal(clean.selectedMerchantId, null);
  assert.equal(clean.currentScanPayment, null);
  assert.equal(clean.discoveryLocation, null);
  assert.equal(clean.locationAttempted, false);
  assert.deepEqual(clean.nearbyMerchants, []);
  assert.deepEqual(clean.shownMerchantIds, []);
  assert.deepEqual(clean.rejectedMerchantIds, []);
  assert.deepEqual(clean.recommendationFeedback, []);
  assert.equal(clean.profile.dietaryPreference, 'none');
  assert.equal(clean.profile.craving, '');
  assert.equal(clean.hasSetPreferences, false);
});

test('persona reset leaves shared campaign metrics and settings unchanged', async function() {
  const v = visitor();
  await reset(v);
  pinAllCampaigns(0.50, 5.00);
  await v.request('/home');
  await v.request('/smart-match/result');
  const selected = (await v.state()).demo.selectedMerchantId;
  await v.request('/recommendation/accept', { merchantId: selected });
  const tx = await pay(v, selected, '5.00');
  assert.equal(tx.source, 'SMART_MATCH');
  const c = campaign(selected);
  assert.equal(c.metrics.smartMatchPayments, 1);
  assert.ok(c.metrics.smartMatchShown > 0);
  assert.equal(c.platformFeeAccrued, c.platformFeePerAttributedPayment);
  const beforeReset = { payments: c.metrics.smartMatchPayments, shown: c.metrics.smartMatchShown,
    sales: c.metrics.smartMatchSales, fee: c.platformFeeAccrued };
  await reset(v);
  assert.deepEqual({ payments: c.metrics.smartMatchPayments, shown: c.metrics.smartMatchShown,
    sales: c.metrics.smartMatchSales, fee: c.platformFeeAccrued }, beforeReset);
  assert.equal(c.platformFeePerAttributedPayment, 0.10);
});

test('persona reset does not clear another session or its shared offer', async function() {
  const sender = visitor();
  await reset(sender);
  pinCampaign('green-bowl', 0.50, 5.00);
  const tx = await pay(sender, 'green-bowl', '6.00');
  await sender.request('/vouch/' + tx.id, { action: 'create' });
  const token = (await sender.state()).demo.paymentVerifiedVouches[0].shareToken;
  const receiver = visitor();
  await receiver.request('/demo/identity', { userId: 'darren' });
  await receiver.request('/offers/' + token + '/claim', {});
  assert.equal((await receiver.state()).demo.activeVouchClaim.status, 'CLAIMED');
  await pay(receiver, 'green-bowl', '6.00');
  assert.equal((await receiver.state()).demo.activeVouchClaim.status, 'REDEEMED');
  await reset(receiver);
  assert.equal((await sender.state()).demo.user.id, 'jia');
  assert.equal((await sender.state()).demo.transactions.length, 1);
  assert.equal((await sender.state()).demo.paymentVerifiedVouches.length, 1);
  assert.equal((await receiver.state()).demo.user.id, 'darren');
  assert.equal((await receiver.state()).demo.activeVouchClaim, null);
  assert.equal((await sender.request('/offers/' + token)).status, 200);
});

test('reset clears only the selected persona in a multi-persona browser session', async function() {
  const v = visitor();
  await reset(v);
  const tx = await pay(v, 'green-bowl', '6.00');
  await v.request('/vouch/' + tx.id, { action: 'create' });
  const token = (await v.state()).demo.paymentVerifiedVouches[0].shareToken;
  await v.request('/demo/identity', { userId: 'darren' });
  await v.request('/offers/' + token + '/claim', {});
  assert.equal((await v.state()).demo.activeVouchClaim.status, 'CLAIMED');
  await reset(v);
  const state = await v.state();
  assert.equal(state.demo.user.id, 'darren');
  assert.equal(state.demo.activeVouchClaim, null);
  assert.deepEqual(state.demo.transactions, []);
  await v.request('/demo/identity', { userId: 'jia' });
  assert.equal((await v.state()).demo.transactions.length, 1);
  assert.equal((await v.request('/offers/' + token)).status, 200);
});

test('campaign configuration, live metrics and merchant feed survive persona reset', async function() {
  const v = visitor();
  await reset(v);
  const c = campaign('felicia-chicken-rice');
  c.rewardAmount = 0.70;
  c.minimumEligibleSpend = 4;
  c.maxRewardedPaymentsPerDay = 7;
  c.maxRewardBudgetPerDay = 9;
  c.platformFeePerAttributedPayment = 0.15;
  c.senderReferralReward = 0.25;
  c.status = 'INACTIVE';
  c.startTime = '01:00';
  c.endTime = '22:00';
  // Use a different active campaign for actual runtime counters.
  pinCampaign('green-bowl', 0.50, 5.00);
  await pay(v, 'green-bowl', '5.37');
  const live = campaign('green-bowl');
  assert.equal(live.redemptionsToday, 1);
  assert.equal(live.metrics.directScanPayments, 1);
  assert.equal(live.metrics.rewardCost, 0.50);
  assert.equal(live.metrics.payments, 1);
  assert.match((await v.request('/merchant?merchantId=green-bowl&tab=results')).html, /\$5\.37/);
  await reset(v);
  assert.equal(campaign('felicia-chicken-rice'), c);
  assert.deepEqual([c.rewardAmount, c.minimumEligibleSpend, c.maxRewardedPaymentsPerDay,
    c.maxRewardBudgetPerDay, c.platformFeePerAttributedPayment, c.senderReferralReward,
    c.status, c.startTime, c.endTime], [0.70, 4, 7, 9, 0.15, 0.25, 'INACTIVE', '01:00', '22:00']);
  assert.equal(live.redemptionsToday, 1);
  assert.equal(live.rewardBudgetSpentToday, 0.50);
  assert.equal(live.metrics.payments, 1);
  assert.equal(live.metrics.directScanPayments, 1);
  assert.equal(live.metrics.rewardCost, 0.50);
  const results = await v.request('/merchant?merchantId=green-bowl&tab=results');
  assert.equal(results.status, 200);
  assert.ok(results.html.includes('$5.37'));
  assert.match(results.html, /Illustrative Prototype Data/i);
});

test('Foursquare discovery cache is preserved across demo reset', async function() {
  clearDiscoveryCache();
  const v = visitor();
  await reset(v);
  process.env.FOURSQUARE_API_KEY = 'test-key';
  const location = { latitude: 1.4521, longitude: 103.8221 };
  let calls = 0;
  global.fetch = async function() {
    calls += 1;
    return { ok: true, json: async function() { return { results: [{ fsq_place_id: 'reset-cache',
      name: 'Cache Café', latitude: 1.4522, longitude: 103.8222, distance: 100,
      categories: [{ name: 'Restaurant' }], location: { formatted_address: 'Singapore' } }] }; } };
  };
  await getNearbyMerchants(location, 'jia', '');
  assert.equal(calls, 1);
  await reset(v);
  await getNearbyMerchants(location, 'darren', '');
  assert.equal(calls, 1);
});

test('reset updates only the current fixture user and uses scoped writes', async () => {
  for (const id of ['jia', 'darren', 'unrelated-user']) fixtureDb.seedUser(id, {
    budget_max: 4, max_walk_minutes: 3, dietary_preference: 'vegan', weight_price_sensitivity: 2,
    weight_distance_sensitivity: 3, weight_quietness_affinity: 4, max_distance_minutes: 25,
    mood_cuisine: 'rice', craving: 'laksa', notifications: 0, has_set_preferences: 1
  });
  const v = visitor(); await v.request('/home'); await reset(v);
  assert.equal(fixtureDb.users.size, 3);
  const jia = fixtureDb.users.get('jia');
  assert.deepEqual([jia.budget_max, jia.max_walk_minutes, jia.dietary_preference,
    jia.weight_price_sensitivity, jia.weight_distance_sensitivity, jia.weight_quietness_affinity], [10, 15, 'none', 2, 3, 4]);
  for (const id of ['darren', 'unrelated-user']) assert.deepEqual([
    fixtureDb.users.get(id).budget_max, fixtureDb.users.get(id).max_walk_minutes,
    fixtureDb.users.get(id).dietary_preference], [4, 3, 'vegan']);
  const writes = fixtureDb.calls.filter(c => /^(UPDATE|INSERT|DELETE)/.test(c.sql));
  assert.equal(writes.length, 2);
  assert.ok(writes.every(write => /WHERE user_id = \?/.test(write.sql)));
  assert.ok(writes.every(write => write.params[0] === 'jia'));
});

test('persona-scoped reset does not sweep or rewrite separately saved session state', async () => {
  const v = visitor(); await v.request('/home'); pinCampaign('felicia-chicken-rice', 0.50, 5);
  await pay(v, 'felicia-chicken-rice', '6.00'); const stale = await v.state();
  assert.equal(stale.demo.transactions.length, 1);
  await reset(v); await v.replaceState(stale);
  assert.equal((await v.state()).demo.transactions.length, 1);
  assert.equal((await v.request('/profile/activity')).status, 200);
  assert.equal((await v.state()).demo.transactions.length, 1);
});

test('current MemoryStore: a session save failure must not report reset success', async () => {
  const v = visitor(); await v.request('/home'); const original = demoStore.set;
  demoStore.set = function(id, state, callback) { callback(new Error('simulated session save failure')); };
  try {
    const response = await v.request('/reset-demo', {});
    assert.equal(response.status, 500); assert.match(response.html, /could not be completed/);
    assert.notEqual(response.location, '/home?reset=done');
  } finally { demoStore.set = original; }
});
