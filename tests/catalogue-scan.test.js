const { database: db, counters } = require('./helpers/test-isolation.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const { findMerchant } = require('../merchant-catalogue');
const { row } = require('./helpers/catalogue-fixtures.cjs');
const { start } = require('./helpers/visitor.cjs');
const { resetMerchantCampaigns, getMerchantCampaigns, demoStore } = require('../app');
const id = 'catalogue-only-direct-scan';
let http;
test.before(async () => { http = await start(); });
test.beforeEach(() => {
  resetMerchantCampaigns();
  db.seedMerchant(row({ merchant_id: id, name: 'Direct Scan catalogue fixture' }));
});
test.after(async () => {
  await http.close();
  assert.deepEqual(counters, { envLoads: 0, privateReads: 0, mysqlFactories: 0, redisFactories: 0, blockedConnections: 0 });
});
const lookupCalls = () => db.calls.filter(c => c.sql.endsWith('FROM merchants WHERE merchant_id = ?'));
const campaign = () => getMerchantCampaigns().find(c => c.merchantId === id);
async function pay(v) {
  const scan = (await v.state()).demo.currentScanPayment;
  const result = await v.request('/scan/payment', { journeyId: scan.id, amount: '6.00' });
  assert.match(result.location, /^\/payment-success\/tx-/);
  const tx = (await v.state()).demo.transactions[0];
  assert.equal(tx.merchantId, id); assert.equal(tx.merchantName, 'Direct Scan catalogue fixture');
  return tx;
}

test('ID lookup uses a prepared parameter and returns only the exact normalized identity', async () => {
  const special = 'merchant\' OR 1=1 --';
  db.seedMerchant(row({ merchant_id: special, typical_price: '0.00' }));
  const merchant = await findMerchant(db, special);
  assert.equal(merchant.id, special); assert.equal(merchant.price, 0);
  assert.deepEqual(lookupCalls()[0].params, [special]);
  assert.ok(!lookupCalls()[0].sql.includes(special));
  assert.equal(await findMerchant(db, 'missing'), null);
  const count = db.calls.length;
  for (const invalid of [null, {}, [], '', ' ']) assert.equal(await findMerchant(db, invalid), null);
  assert.equal(db.calls.length, count);
  assert.equal(await findMerchant({ execute: async () => [[row({ merchant_id: 'OtherCase' })], []] }, 'othercase'), null);
});

test('fresh-session Direct Scan resolves a database-only ID and completes simulated payment/Vouch', async () => {
  const v = http.visitor();
  assert.equal((await v.request('/scan', { merchantId: id })).location, '/scan/payment?m=' + id);
  assert.deepEqual(lookupCalls().map(c => c.params), [[id]]);
  const scan = (await v.state()).demo.currentScanPayment;
  assert.equal(scan.merchantSnapshot.source, 'mysql'); assert.equal(scan.merchantSnapshot.price, 5);
  assert.equal(campaign().metrics.scans, 1); assert.equal(campaign().metrics.payments, 0);
  assert.deepEqual((await v.state()).demo.transactions, []);
  const tx = await pay(v); assert.equal(tx.source, 'DIRECT_SCAN'); assert.equal(tx.merchantRewardEarned, 0.75);
  assert.equal((await v.request('/vouch/' + tx.id, { action: 'create' })).status, 302);
  assert.equal((await v.state()).demo.paymentVerifiedVouches[0].merchantId, id);
  assert.equal(db.calls.some(c => /^(INSERT|UPDATE|DELETE)/.test(c.sql)), false);
});

test('fresh-session payment link creates only a form/journey; GET and refresh never pay', async () => {
  const v = http.visitor();
  const first = await v.request('/scan/payment?m=' + id); assert.equal(first.status, 200);
  assert.match(first.html, /Direct Scan catalogue fixture/);
  const before = (await v.state()).demo.currentScanPayment;
  assert.equal(before.status, 'MERCHANT_FOUND'); assert.equal(before.transactionId, null);
  for (let i = 0; i < 2; i++) assert.equal((await v.request('/scan/payment?m=' + id)).status, 200);
  const demo = (await v.state()).demo;
  assert.equal(demo.currentScanPayment.id, before.id); assert.deepEqual(demo.transactions, []);
  assert.equal(campaign().metrics.payments, 0); assert.equal(campaign().rewardBudgetSpentToday, 0);
  assert.equal(lookupCalls().length, 1);
  assert.equal((await pay(v)).merchantRewardEarned, 0.75);
});

test('unknown IDs and malformed IDs retain the existing invalid-merchant outcome', async () => {
  for (const url of ['/scan', '/scan/payment?m=unknown-catalogue-id']) {
    const v = http.visitor(); const result = url === '/scan'
      ? await v.request(url, { merchantId: 'unknown-catalogue-id' }) : await v.request(url);
    assert.equal(result.location, '/scan?error=invalid');
    assert.equal((await v.state()).demo.currentScanPayment, null);
    assert.equal((await v.state()).demo.transactions.length, 0);
  }
  const v = http.visitor(); const before = lookupCalls().length;
  assert.equal((await v.request('/scan', { merchantId: [] })).location, '/scan?error=invalid');
  assert.equal(lookupCalls().length, before);
  assert.equal((await v.request('/scan', { merchantId: id, campaignId: 'wrong-campaign' })).location, '/scan?error=invalid');
  assert.equal(lookupCalls().length, before);
});

for (const method of ['GET', 'POST']) test(`${method} catalogue failure is recoverable, keeps the ID, and substitutes no merchant`, async () => {
  const v = http.visitor(); db.catalogueFailing = true;
  const failed = method === 'POST' ? await v.request('/scan', { merchantId: id }) : await v.request('/scan/payment?m=' + id);
  assert.equal(failed.status, 503); assert.match(failed.html, /Merchant catalogue unavailable/);
  assert.match(failed.html, new RegExp('href="/scan/payment\\?m=' + id + '"'));
  assert.doesNotMatch(failed.html, /simulated catalogue outage|MYSQL|password|showing demo merchants/);
  assert.equal((await v.state()).demo.currentScanPayment, null);
  assert.equal((await v.state()).demo.transactions.length, 0);
  db.catalogueFailing = false;
  assert.equal((await v.request('/scan/payment?m=' + id)).status, 200);
  assert.equal((await v.state()).demo.currentScanPayment.merchantId, id);
  assert.equal((await pay(v)).merchantRewardEarned, 0.75);
});

test('outage retry URLs escape the original special-character ID safely', async () => {
  db.catalogueFailing = true; const special = 'id"&<tag>';
  const result = await http.visitor().request('/scan', { merchantId: special });
  assert.equal(result.status, 503);
  assert.ok(result.html.includes('/scan/payment?m=' + encodeURIComponent(special)));
  assert.doesNotMatch(result.html, /<tag>/);
});

test('existing active journey ignores other IDs and outage without replacing its snapshot or counters', async () => {
  const v = http.visitor(); await v.request('/scan', { merchantId: id });
  const original = (await v.state()).demo.currentScanPayment;
  const state = campaign(); state.metrics.payments = 3; state.rewardBudgetSpentToday = 1;
  db.calls.length = 0; db.catalogueFailing = true;
  assert.equal((await v.request('/scan', { merchantId: 'another-id' })).location, '/scan/payment');
  assert.equal((await v.request('/scan/payment?m=another-id')).status, 200);
  assert.deepEqual((await v.state()).demo.currentScanPayment, original);
  assert.equal(state.metrics.payments, 3); assert.equal(state.rewardBudgetSpentToday, 1);
  assert.equal(lookupCalls().length, 0);
});

test('another fresh-session lookup neither refreshes an active snapshot nor resets campaign counters', async () => {
  const first = http.visitor(); await first.request('/scan', { merchantId: id });
  const original = (await first.state()).demo.currentScanPayment; await pay(first);
  const state = campaign();
  Object.assign(db.merchants.get(id), { name: 'Updated direct-scan name', reward_amount: '2.00' });
  const second = http.visitor(); await second.request('/scan/payment?m=' + id);
  assert.equal(campaign(), state); assert.equal(state.metrics.payments, 1); assert.equal(state.rewardBudgetSpentToday, 0.75);
  assert.equal((await second.state()).demo.currentScanPayment.merchantName, 'Updated direct-scan name');
  const firstScan = (await first.state()).demo.currentScanPayment;
  assert.equal(firstScan.id, original.id); assert.equal(firstScan.merchantName, original.merchantName);
  assert.equal(firstScan.merchantSnapshot.catalogueTerms.rewardAmount, 0.75);
});

test('selected-payment refresh still works with the catalogue down and no new lookup', async () => {
  const v = http.visitor(); await v.request('/api/recommend');
  await v.request('/recommendation/accept', { merchantId: id }); await v.request('/scan', { merchantId: id });
  const original = (await v.state()).demo.currentScanPayment;
  db.calls.length = 0; db.catalogueFailing = true;
  assert.equal((await v.request('/scan/payment?m=' + id)).status, 200);
  assert.equal((await v.state()).demo.currentScanPayment.id, original.id);
  assert.equal(lookupCalls().length, 0); assert.equal((await pay(v)).source, 'SMART_MATCH');
});

test('a fresh shared recipient pays without the sender session or any catalogue lookup', async () => {
  const sender = http.visitor(); await sender.request('/scan/payment?m=' + id);
  const tx = await pay(sender); await sender.request('/vouch/' + tx.id, { action: 'create' });
  const token = (await sender.state()).demo.paymentVerifiedVouches[0].shareToken;
  const sessions = await new Promise((resolve, reject) => demoStore.all((e, s) => e ? reject(e) : resolve(s)));
  const senderId = Object.keys(sessions).find(key => sessions[key].demo.paymentVerifiedVouches.some(v => v.shareToken === token));
  assert.ok(senderId);
  await new Promise((resolve, reject) => demoStore.destroy(senderId, e => e ? reject(e) : resolve()));
  db.merchants.clear(); db.catalogueFailing = true; db.calls.length = 0;
  const recipient = http.visitor(); await recipient.request('/demo/identity', { userId: 'darren' });
  assert.equal((await recipient.request('/offers/' + token)).status, 200);
  await recipient.request('/offers/' + token + '/claim', {});
  await recipient.request('/scan', { merchantId: id });
  assert.equal((await pay(recipient)).source, 'SHARED_VOUCH');
  assert.equal(lookupCalls().length, 0);
});

test('an incomplete catalogue record does not acquire invented campaign terms', async () => {
  db.merchants.get(id).reward_amount = null;
  const v = http.visitor();
  assert.equal((await v.request('/scan', { merchantId: id })).location, '/scan?error=invalid');
  assert.equal((await v.state()).demo.currentScanPayment, null);
  assert.equal(campaign(), undefined);
});
