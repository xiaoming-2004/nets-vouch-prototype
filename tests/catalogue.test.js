const { database: db, counters } = require('./helpers/test-isolation.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const { mapMerchant, loadCatalogue } = require('../merchant-catalogue');
const { row, seedCatalogue } = require('./helpers/catalogue-fixtures.cjs');
const { start } = require('./helpers/visitor.cjs');
const { getMerchantCampaigns, resetMerchantCampaigns } = require('../app');
let http;
test.before(async () => { http = await start(); });
test.beforeEach(() => { resetMerchantCampaigns(); seedCatalogue(db); });
test.after(async () => {
  await http.close();
  assert.deepEqual(counters, { envLoads: 0, privateReads: 0, mysqlFactories: 0, redisFactories: 0, blockedConnections: 0 });
});
const campaign = id => getMerchantCampaigns().find(c => c.merchantId === id);
async function recommend(v, query = '') {
  const response = await v.request('/api/recommend' + query);
  assert.equal(response.status, 200); return JSON.parse(response.html);
}
async function choose(v, id) {
  assert.equal((await v.request('/recommendation/accept', { merchantId: id })).location, '/scan');
  const scanPage = await v.request('/scan'); assert.equal(scanPage.status, 200);
  assert.equal((await v.request('/scan', { merchantId: id })).status, 302);
  return (await v.state()).demo.currentScanPayment;
}
async function pay(v, scan, amount = '6.00') {
  const response = await v.request('/scan/payment', { journeyId: scan.id, amount });
  assert.match(response.location, /^\/payment-success\/tx-/);
  return (await v.state()).demo.transactions[0];
}

test('mapping preserves exact identity, DECIMAL values, explicit flags and valid zeros', () => {
  const m = mapMerchant(row({ merchant_id: ' exact-identity ', typical_price: '0.00', distance_metres: '0',
    dietary_halal: '0', dietary_vegetarian: '1', dietary_vegan: true, reward_amount: 0, min_spend: '0.00', is_sample_data: '1' }));
  assert.equal(m.id, ' exact-identity '); assert.equal(m.price, 0); assert.equal(m.distanceMetres, 0);
  assert.equal(m.distanceMinutes, 0); assert.deepEqual(m.dietary, ['vegetarian', 'vegan']);
  assert.deepEqual(m.catalogueTerms, { rewardAmount: 0, minimumEligibleSpend: 0, rewardLabel: 'Vouch Credit' });
  assert.equal(m.isSampleData, true); assert.equal(m.itemName, null); assert.equal(m.coordinates, null);
  assert.match(m.distanceLabel, /from demo origin \(catalogue estimate\)/);
});

test('null, blank, nonfinite and negative facts never become zero or a positive dietary claim', () => {
  for (const value of [null, undefined, '', ' ', 'bad', NaN, Infinity, -1, '-1']) {
    const m = mapMerchant(row({ typical_price: value, distance_metres: value, reward_amount: value,
      dietary_halal: value, dietary_vegetarian: '0', dietary_vegan: false }));
    assert.equal(m.price, null); assert.equal(m.distanceMetres, null); assert.equal(m.catalogueTerms, null);
    assert.deepEqual(m.dietary, []);
  }
  assert.equal(mapMerchant(row({ distance_metres: 1.5 })).distanceMetres, null);
  assert.equal(mapMerchant(row({ merchant_id: '' })), null);
  assert.equal(mapMerchant(row({ name: null })), null);
  assert.equal(mapMerchant(row({ location_label: null, cuisine_type: null })).address, null);
});

test('adapter uses one fixed prepared read; mutations are visible on the next read', async () => {
  await loadCatalogue(db);
  assert.equal(db.calls.length, 1); assert.match(db.calls[0].sql, /^SELECT merchant_id, name,/);
  assert.match(db.calls[0].sql, /FROM merchants ORDER BY merchant_id$/); assert.deepEqual(db.calls[0].params, []);
  db.merchants.get('catalogue-a').typical_price = '9.25';
  const result = await loadCatalogue(db); assert.equal(result.merchants[0].price, 9.25);
});

test('API price changes affect eligibility immediately and successful reads never merge demos/providers', async () => {
  const v = http.visitor(); const first = await recommend(v);
  assert.deepEqual(first.catalogue, { source: 'mysql', status: 'ok' });
  assert.deepEqual(first.recommendations.map(m => m.id), ['catalogue-a', 'catalogue-b', 'catalogue-c']);
  db.merchants.get('catalogue-b').typical_price = '11.00';
  const second = await recommend(v); assert.deepEqual(second.recommendations.map(m => m.id), ['catalogue-a', 'catalogue-c']);
  assert.equal(second.recommendations[0].itemName, null);
  assert.equal(db.calls.some(c => /^(INSERT|UPDATE|DELETE)/.test(c.sql)), false);
});

test('budget and distance exclude unknown facts; zero remains eligible', async () => {
  db.merchants.get('catalogue-a').typical_price = null;
  db.merchants.get('catalogue-b').distance_metres = null;
  Object.assign(db.merchants.get('catalogue-c'), { typical_price: '0.00', distance_metres: 0, reward_amount: '0.00', min_spend: '0.00' });
  const result = await recommend(http.visitor());
  assert.deepEqual(result.recommendations.map(m => m.id), ['catalogue-c']);
  assert.equal(result.recommendations[0].price, 0); assert.equal(result.recommendations[0].campaign.rewardAmount, 0);
  assert.equal(result.recommendations[0].campaign.minimumEligibleSpend, 0);
});

test('catalogue dietary flags control eligibility, including vegan satisfying vegetarian', async () => {
  Object.assign(db.merchants.get('catalogue-a'), { dietary_halal: '0' });
  Object.assign(db.merchants.get('catalogue-b'), { dietary_halal: '1', dietary_vegan: null });
  Object.assign(db.merchants.get('catalogue-c'), { dietary_halal: null, dietary_vegan: 1 });
  assert.deepEqual((await recommend(http.visitor(), '?cuisine=halal')).recommendations.map(m => m.id), ['catalogue-b']);
  assert.deepEqual((await recommend(http.visitor(), '?cuisine=vegetarian')).recommendations.map(m => m.id), ['catalogue-c']);
  assert.deepEqual((await recommend(http.visitor(), '?cuisine=vegan')).recommendations.map(m => m.id), ['catalogue-c']);
});

test('empty catalogue, filtered-empty results and outage fallback remain distinct', async () => {
  db.merchants.clear(); const empty = await recommend(http.visitor());
  assert.deepEqual(empty, { recommendations: [], catalogue: { source: 'mysql', status: 'empty' } });
  seedCatalogue(db); for (const m of db.merchants.values()) m.typical_price = '99.00';
  const filtered = await recommend(http.visitor());
  assert.deepEqual(filtered, { recommendations: [], catalogue: { source: 'mysql', status: 'ok' } });
  db.catalogueFailing = true; const fallback = await recommend(http.visitor());
  assert.deepEqual(fallback.catalogue, { source: 'demo-fallback', status: 'unavailable' });
  assert.equal(fallback.recommendations.length, 3); assert.ok(fallback.recommendations.every(m => m.source === 'local-fallback' && m.isSampleData));
  assert.doesNotMatch(JSON.stringify(fallback), /simulated catalogue outage|password|MYSQL/);
});

test('unusable reward terms yield no invented offer and no fallback', async () => {
  for (const m of db.merchants.values()) m.reward_amount = null;
  const result = await recommend(http.visitor()); assert.deepEqual(result.recommendations, []);
  assert.deepEqual(result.catalogue, { source: 'mysql', status: 'ok' });
});

for (const index of [1, 2]) test(`card ${index + 1} resolves through Scan, payment, receipt and Vouch`, async () => {
  const v = http.visitor(); const m = (await recommend(v)).recommendations[index];
  const scan = await choose(v, m.id);
  assert.equal(scan.merchantId, m.id); assert.equal(scan.merchantName, m.merchantName);
  assert.equal(scan.outlet, 'Fixture outlet A');
  assert.equal(scan.merchantSnapshot.price, m.price);
  const paymentPage = await v.request('/scan/payment'); assert.match(paymentPage.html, /0\.75/);
  const tx = await pay(v, scan); assert.equal(tx.merchantId, m.id); assert.equal(tx.merchantName, m.merchantName);
  assert.equal(tx.merchantRewardEarned, 0.75); assert.equal(tx.source, 'SMART_MATCH');
  assert.equal((await v.request('/payment-success/' + tx.id)).status, 200);
  await v.request('/scan/payment', { journeyId: scan.id, amount: '6.00' });
  assert.equal(campaign(m.id).metrics.payments, 1);
  assert.equal((await v.request('/vouch/' + tx.id, { action: 'create' })).status, 302);
  assert.equal((await v.request('/vouch/' + tx.id + '/success')).status, 200);
  const vouch = (await v.state()).demo.paymentVerifiedVouches[0];
  assert.equal(vouch.merchantId, m.id); assert.equal(vouch.merchantName, m.merchantName);
});

test('query filter overrides remain usable when choosing a card', async () => {
  db.merchants.get('catalogue-a').typical_price = '12.00';
  const v = http.visitor(); const result = await recommend(v, '?budget=15');
  assert.ok(result.recommendations.some(m => m.id === 'catalogue-a'));
  assert.equal((await v.request('/recommendation/accept', { merchantId: 'catalogue-a' })).location, '/scan');
});

test('same-ID demo facts cannot shadow the database merchant or reward terms', async () => {
  db.merchants.clear(); db.seedMerchant(row({ merchant_id: 'felicia-chicken-rice', name: 'Database identity',
    location_label: 'Database outlet', typical_price: '8.25', reward_amount: '1.25', min_spend: '3.00', dietary_halal: 0 }));
  const v = http.visitor(); assert.deepEqual((await recommend(v, '?cuisine=halal')).recommendations, []);
  const result = await recommend(v); assert.equal(result.recommendations[0].merchantName, 'Database identity');
  const scan = await choose(v, 'felicia-chicken-rice'); assert.equal(scan.outlet, 'Database outlet');
  const tx = await pay(v, scan); assert.equal(tx.merchantName, 'Database identity'); assert.equal(tx.merchantRewardEarned, 1.25);
});

test('exact special-character IDs and merchant text remain intact and escaped through the journey', async () => {
  const id = 'merchant"&<exact>';
  db.merchants.clear(); db.seedMerchant(row({ merchant_id: id, name: '<script>fixture</script>', location_label: '<img src=x>' }));
  const v = http.visitor(); const m = (await recommend(v)).recommendations[0]; assert.equal(m.id, id);
  const scan = await choose(v, id); assert.equal(scan.merchantId, id);
  const page = await v.request('/scan/payment');
  assert.match(page.html, /&lt;script&gt;fixture&lt;\/script&gt;/); assert.doesNotMatch(page.html, /<script>fixture/);
  const tx = await pay(v, scan); assert.equal(tx.merchantId, id); assert.equal(tx.outlet, '<img src=x>');
  await v.request('/vouch/' + tx.id, { action: 'create' });
  assert.equal((await v.state()).demo.paymentVerifiedVouches[0].merchantId, id);
});

test('selection is pinned before Scan even if a subsequent catalogue request becomes empty', async () => {
  const v = http.visitor(); const shown = (await recommend(v)).recommendations[1];
  await v.request('/recommendation/accept', { merchantId: shown.id });
  db.merchants.clear(); assert.equal((await recommend(v)).catalogue.status, 'empty');
  const page = await v.request('/scan'); assert.match(page.html, /Catalogue fixture B/);
  await v.request('/scan', { merchantId: shown.id }); const scan = (await v.state()).demo.currentScanPayment;
  assert.equal(scan.merchantId, shown.id); assert.equal((await pay(v, scan)).merchantRewardEarned, 0.75);
});

test('catalogue refresh and another session preserve active facts and shared counters', async () => {
  const first = http.visitor(); const shown = (await recommend(first)).recommendations[0];
  const scan = await choose(first, shown.id); const state = campaign(shown.id);
  Object.assign(db.merchants.get(shown.id), { name: 'Refreshed name', location_label: 'Refreshed outlet', typical_price: '8.00', reward_amount: '2.00' });
  const second = http.visitor(); await recommend(second); await recommend(first);
  assert.equal(campaign(shown.id), state); assert.equal(state.metrics.scans, 1);
  await first.request('/recommendation/accept', { merchantId: 'catalogue-b' });
  assert.equal((await first.state()).demo.selectedMerchantId, shown.id);
  assert.equal((await first.state()).demo.currentScanPayment.id, scan.id);
  const tx = await pay(first, scan); assert.equal(tx.merchantName, shown.merchantName); assert.equal(tx.outlet, 'Fixture outlet A');
  assert.equal(tx.merchantRewardEarned, 0.75); assert.equal(state.rewardBudgetSpentToday, 0.75);
  await recommend(second); assert.equal(state.metrics.payments, 1); assert.equal(state.rewardBudgetSpentToday, 0.75);
  const nextScan = await choose(second, shown.id); assert.equal(nextScan.merchantName, 'Refreshed name');
  const nextTx = await pay(second, nextScan); assert.equal(nextTx.merchantRewardEarned, 2);
  assert.equal(state.metrics.payments, 2); assert.equal(state.rewardBudgetSpentToday, 2.75);
  const home = await first.request('/home'); assert.match(home.html, /Catalogue fixture A/); assert.doesNotMatch(home.html, /Refreshed name/);
});

for (const [label, mutate, amount] of [
  ['inactive status', c => { c.status = 'INACTIVE'; }, '6.00'],
  ['redemption cap', c => { c.redemptionsToday = c.maxRewardedPaymentsPerDay; }, '6.00'],
  ['exhausted budget', c => { c.rewardBudgetSpentToday = c.maxRewardBudgetPerDay; }, '6.00'],
  ['insufficient remaining budget', c => { c.rewardBudgetSpentToday = c.maxRewardBudgetPerDay - 0.5; }, '6.00'],
  ['minimum spend', () => {}, '1.00'],
  ['minimum NETS payment', () => {}, '0.50']
]) test(`payment rechecks ${label} after selection without changing shown reward terms`, async () => {
  const v = http.visitor(); const m = (await recommend(v)).recommendations[0]; const scan = await choose(v, m.id);
  mutate(campaign(m.id)); const tx = await pay(v, scan, amount);
  assert.equal(tx.merchantRewardEarned, 0); assert.equal(tx.promisedReward, 0);
  assert.equal(tx.merchantSnapshot.catalogueTerms.rewardAmount, 0.75);
});

test('payment rechecks the current daily eligibility marker', async () => {
  const v = http.visitor(); const m = (await recommend(v)).recommendations[0]; const scan = await choose(v, m.id);
  await v.change(demo => { demo.dailyMerchantRewards[m.id] = campaign(m.id).day; });
  assert.equal((await pay(v, scan)).merchantRewardEarned, 0);
});

test('two active sessions share the live reward budget rather than copied snapshot counters', async () => {
  const first = http.visitor(); const second = http.visitor();
  const m = (await recommend(first)).recommendations[0];
  campaign(m.id).maxRewardBudgetPerDay = 1;
  await recommend(second);
  const firstScan = await choose(first, m.id); const secondScan = await choose(second, m.id);
  assert.equal((await pay(first, firstScan)).merchantRewardEarned, 0.75);
  assert.equal((await pay(second, secondScan)).merchantRewardEarned, 0);
  assert.equal(campaign(m.id).rewardBudgetSpentToday, 0.75);
  assert.equal(campaign(m.id).redemptionsToday, 1); assert.equal(campaign(m.id).metrics.payments, 2);
});

test('shared claims carry exact snapshots into a new persona/session without catalogue access', async () => {
  const sender = http.visitor(); const m = (await recommend(sender)).recommendations[1]; const scan = await choose(sender, m.id);
  const tx = await pay(sender, scan); await sender.request('/vouch/' + tx.id, { action: 'create' });
  const token = (await sender.state()).demo.paymentVerifiedVouches[0].shareToken;
  db.merchants.clear(); db.catalogueFailing = true; db.calls.length = 0;
  const receiver = http.visitor(); await receiver.request('/demo/identity', { userId: 'darren' });
  await receiver.request('/offers/' + token + '/claim', {});
  const claim = (await receiver.state()).demo.activeVouchClaim; assert.equal(claim.merchantId, m.id);
  const page = await receiver.request('/scan'); assert.match(page.html, /Catalogue fixture B/);
  await receiver.request('/scan', { merchantId: m.id }); const receiverScan = (await receiver.state()).demo.currentScanPayment;
  const received = await pay(receiver, receiverScan); assert.equal(received.source, 'SHARED_VOUCH');
  assert.equal(received.merchantName, m.merchantName); assert.equal(received.merchantRewardEarned, 0.75);
  assert.equal(db.calls.some(c => /FROM merchants/.test(c.sql)), false);
});

test('Vouch shared terms remain the paid snapshot after the sender starts a later same-ID journey', async () => {
  const sender = http.visitor(); const shown = (await recommend(sender)).recommendations[0];
  const scan = await choose(sender, shown.id); const tx = await pay(sender, scan);
  await sender.request('/vouch/' + tx.id, { action: 'create' });
  const token = (await sender.state()).demo.paymentVerifiedVouches[0].shareToken;
  // Finish the first scan, then make a fresh selection with changed catalogue facts.
  await sender.request('/transactions/' + tx.id + '/done', {});
  Object.assign(db.merchants.get(shown.id), { name: 'Later same-ID name', reward_amount: '2.00' });
  await recommend(sender); await sender.request('/recommendation/accept', { merchantId: shown.id });
  const receiver = http.visitor(); await receiver.request('/demo/identity', { userId: 'darren' });
  await receiver.request('/offers/' + token + '/claim', {});
  const claim = (await receiver.state()).demo.activeVouchClaim;
  assert.equal(claim.rewardAmount, 0.75); assert.equal(claim.merchantSnapshot.merchantName, shown.merchantName);
  await receiver.request('/scan', { merchantId: shown.id });
  const received = await pay(receiver, (await receiver.state()).demo.currentScanPayment);
  assert.equal(received.merchantName, shown.merchantName); assert.equal(received.merchantRewardEarned, 0.75);
});

test('zero reward terms survive payment and shared-claim creation', async () => {
  db.merchants.clear(); db.seedMerchant(row({ reward_amount: '0.00', min_spend: '0.00' }));
  const sender = http.visitor(); const m = (await recommend(sender)).recommendations[0]; const scan = await choose(sender, m.id);
  const tx = await pay(sender, scan); assert.equal(tx.merchantRewardEarned, 0);
  await sender.request('/vouch/' + tx.id, { action: 'create' });
  const token = (await sender.state()).demo.paymentVerifiedVouches[0].shareToken;
  const receiver = http.visitor(); await receiver.request('/demo/identity', { userId: 'darren' });
  await receiver.request('/offers/' + token + '/claim', {});
  assert.equal((await receiver.state()).demo.activeVouchClaim.rewardAmount, 0);
});

test('demo fallback cards can complete the same simulated journey', async () => {
  db.catalogueFailing = true; const v = http.visitor(); const result = await recommend(v);
  const m = result.recommendations[2]; const scan = await choose(v, m.id); const tx = await pay(v, scan, '10.00');
  assert.equal(tx.merchantId, m.id); assert.equal((await v.request('/vouch/' + tx.id)).status, 200);
});
