'use strict';

const { database: db } = require('./helpers/test-isolation.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { start } = require('./helpers/visitor.cjs');
const { row } = require('./helpers/catalogue-fixtures.cjs');
const feedback = require('../rejection-feedback');

function seedCatalogue() {
  db.seedMerchant(row({ merchant_id: 'cheap-near-rice', name: 'Cheap Near Rice', typical_price: '5.00', distance_metres: 80, cuisine_type: 'rice' }));
  db.seedMerchant(row({ merchant_id: 'mid-rice', name: 'Mid Rice', typical_price: '7.00', distance_metres: 240, cuisine_type: 'rice' }));
  db.seedMerchant(row({ merchant_id: 'far-noodles', name: 'Far Noodles', typical_price: '9.00', distance_metres: 560, cuisine_type: 'noodles' }));
  db.seedMerchant(row({ merchant_id: 'soup-four', name: 'Soup Four', typical_price: '6.00', distance_metres: 320, cuisine_type: 'soup' }));
}

async function recommend(visitor, query = '?budget=20&maxDistance=20&diningDate=2026-11-17&diningTime=14:00') {
  const response = await visitor.request('/api/recommend' + query);
  return { response, body: JSON.parse(response.html) };
}

let http;
test.before(async () => { http = await start(); });
test.beforeEach(() => {
  feedback.setNowProviderForTest(() => new Date('2026-11-17T04:00:00.000Z'));
  seedCatalogue();
});
test.afterEach(() => feedback.setNowProviderForTest());
test.after(async () => http.close());

for (const reason of ['too-expensive', 'too-far', 'ate-recently', 'not-in-mood']) {
  test(`${reason} persists one row with server-derived merchant context`, async () => {
    const visitor = http.visitor();
    const cards = (await recommend(visitor)).body.recommendations;
    const card = cards[1];
    const response = await visitor.request('/recommendation/reject', {
      merchantId: card.id, feedbackToken: card.feedbackToken, reason
    }, { 'X-Requested-With': 'smart-match' });
    assert.equal(response.status, 204);
    assert.equal(db.feedbackRows.length, 1);
    const stored = db.feedbackRows[0];
    const merchant = db.merchants.get(card.id);
    assert.deepEqual({ user: stored.user_id, merchant: stored.merchant_id, reason: stored.reason,
      category: stored.category, price: Number(stored.price), metres: stored.distance_metres,
      minutes: stored.distance_minutes, token: stored.submission_token, rejectedAt: stored.rejected_at_sg }, {
      user: 'jia', merchant: card.id, reason, category: merchant.cuisine_type,
      price: Number(merchant.typical_price), metres: merchant.distance_metres,
      minutes: Math.ceil(merchant.distance_metres / 80), token: card.feedbackToken,
      rejectedAt: '2026-11-17 12:00:00'
    });
    assert.deepEqual(JSON.parse(stored.cuisine_tags), []);
    assert.equal(db.calls.some(call => /^UPDATE users SET weight_/.test(call.sql)), false);
  });
}

test('duplicate retry is idempotent and conflicting token reuse is rejected', async () => {
  const visitor = http.visitor();
  const card = (await recommend(visitor)).body.recommendations[0];
  const body = { merchantId: card.id, feedbackToken: card.feedbackToken, reason: 'too-expensive' };
  assert.equal((await visitor.request('/recommendation/reject', body, { 'X-Requested-With': 'smart-match' })).status, 204);
  assert.equal((await visitor.request('/recommendation/reject', body, { 'X-Requested-With': 'smart-match' })).status, 204);
  assert.equal(db.feedbackRows.length, 1);

  db.feedbackRows[0].merchant_id = 'different-merchant';
  assert.equal((await visitor.request('/recommendation/reject', body, { 'X-Requested-With': 'smart-match' })).status, 409);
  assert.equal(db.feedbackRows.length, 1);
});

test('malformed, unshown, stale and token-mismatch submissions never write', async () => {
  const visitor = http.visitor();
  const first = (await recommend(visitor)).body.recommendations;
  const malformed = [
    {},
    { merchantId: first[0].id, feedbackToken: first[0].feedbackToken, reason: 'unknown' },
    { merchantId: first[0].id, feedbackToken: 'not-a-uuid', reason: 'too-far' }
  ];
  for (const body of malformed) assert.equal((await visitor.request('/recommendation/reject', body)).status, 400);
  assert.equal((await visitor.request('/recommendation/reject', {
    merchantId: 'unshown', feedbackToken: first[0].feedbackToken, reason: 'too-far'
  })).status, 409);
  assert.equal((await visitor.request('/recommendation/reject', {
    merchantId: first[0].id, feedbackToken: first[1].feedbackToken, reason: 'too-far'
  })).status, 409);
  await recommend(visitor);
  assert.equal((await visitor.request('/recommendation/reject', {
    merchantId: first[0].id, feedbackToken: first[0].feedbackToken, reason: 'too-far'
  })).status, 409);
  assert.equal(db.feedbackRows.length, 0);
});

test('persistence failure is recoverable and leaves the active batch unchanged', async () => {
  const visitor = http.visitor();
  const card = (await recommend(visitor)).body.recommendations[2];
  const before = (await visitor.state()).demo;
  db.feedbackWriteFailing = true;
  const response = await visitor.request('/recommendation/reject', {
    merchantId: card.id, feedbackToken: card.feedbackToken, reason: 'too-far'
  }, { 'X-Requested-With': 'smart-match' });
  assert.equal(response.status, 503);
  assert.doesNotMatch(response.html, /simulated|database/i);
  assert.equal(db.feedbackRows.length, 0);
  const after = (await visitor.state()).demo;
  assert.deepEqual(after.catalogueBatch, before.catalogueBatch);
  assert.deepEqual(after.lastApiRecommendations, before.lastApiRecommendations);
  assert.deepEqual(after.recommendationFeedback, before.recommendationFeedback);
});

test('durable rows adapt fresh sessions and remain isolated by persona', async () => {
  db.seedFeedback({ user_id: 'jia', merchant_id: 'cheap-near-rice', reason: 'too-expensive',
    price: 5, distance_metres: 80, category: 'rice' });
  db.seedFeedback({ user_id: 'darren', merchant_id: 'far-noodles', reason: 'too-far',
    price: 9, distance_metres: 560, category: 'noodles' });
  const jia = http.visitor();
  const jiaIds = (await recommend(jia)).body.recommendations.map(card => card.id);
  assert.equal(jiaIds.includes('cheap-near-rice'), false);
  assert.equal(jiaIds.includes('far-noodles'), true);
  const darren = http.visitor();
  await darren.request('/demo/identity', { userId: 'darren' });
  const darrenIds = (await recommend(darren)).body.recommendations.map(card => card.id);
  assert.equal(darrenIds.includes('far-noodles'), false);
  assert.equal(darrenIds.includes('cheap-near-rice'), true);

  delete require.cache[require.resolve('../rejection-feedback')];
  const restartedAdapter = require('../rejection-feedback');
  restartedAdapter.setNowProviderForTest(() => new Date('2026-11-17T04:00:00.000Z'));
  const afterRestart = await restartedAdapter.loadRecentFeedback(db, 'jia');
  assert.equal(restartedAdapter.buildLearningPolicy(afterRestart).excludedMerchantIds.has('cheap-near-rice'), true);
});

test('history read includes exactly 30 Singapore calendar dates', async () => {
  db.seedFeedback({ merchant_id: 'included', rejected_at_sg: '2026-10-19 00:00:00' });
  db.seedFeedback({ merchant_id: 'excluded', rejected_at_sg: '2026-10-18 23:59:59' });
  const rows = await feedback.loadRecentFeedback(db, 'jia');
  assert.deepEqual(rows.map(row => row.merchantId), ['included']);
  const call = db.calls.find(item => item.sql.startsWith('SELECT feedback_id'));
  assert.deepEqual(call.params, ['jia', '2026-10-19 00:00:00']);
});

test('Singapore midnight controls Just not today expiry deterministically', () => {
  const rows = [{ merchantId: 'mid-rice', reason: 'not-in-mood', rejectedAtSingapore: '2026-11-17 23:59:59' }];
  feedback.setNowProviderForTest(() => new Date('2026-11-17T15:59:59.000Z'));
  assert.equal(feedback.buildLearningPolicy(rows).excludedMerchantIds.has('mid-rice'), true);
  feedback.setNowProviderForTest(() => new Date('2026-11-17T16:00:00.000Z'));
  assert.equal(feedback.buildLearningPolicy(rows).excludedMerchantIds.has('mid-rice'), false);
});

test('learned penalties are bounded, non-stacking, and explicit filters suppress only matching dimensions', () => {
  const rows = [
    { merchantId: 'old-price', reason: 'too-expensive', price: 7, rejectedAtSingapore: '2026-11-17 09:00:00' },
    { merchantId: 'old-price-2', reason: 'too-expensive', price: 8, rejectedAtSingapore: '2026-11-16 09:00:00' },
    { merchantId: 'old-distance', reason: 'too-far', distanceMetres: 400, rejectedAtSingapore: '2026-11-17 09:00:00' },
    { merchantId: 'old-cuisine', reason: 'ate-recently', category: 'Rice & Bowls', cuisineTags: ['Rice & Bowls'], rejectedAtSingapore: '2026-11-17 09:00:00' }
  ];
  const candidate = { price: 6.50, distanceMetres: 320, category: 'rice-bowls' };
  assert.equal(feedback.buildLearningPolicy(rows).score(candidate, []), -30);
  assert.equal(feedback.buildLearningPolicy(rows, { budget: true }).score(candidate, []), -30);
  assert.equal(feedback.buildLearningPolicy(rows, { maxDistance: true }).score(candidate, []), -30);
  assert.equal(feedback.buildLearningPolicy(rows, { cuisine: true }).score(candidate, []), -30);
  assert.equal(feedback.buildLearningPolicy(rows, {
    budget: true, maxDistance: true, cuisine: true
  }).score(candidate, []), 0);
  assert.equal(feedback.buildLearningPolicy(rows).excludedMerchantIds.has('old-price'), true);
});

test('feedback-read failure returns 503 without replacing the current batch', async () => {
  const visitor = http.visitor();
  await recommend(visitor);
  const before = (await visitor.state()).demo;
  db.feedbackReadFailing = true;
  const failed = await recommend(visitor, '?diningDate=2026-11-17&diningTime=15:00');
  assert.equal(failed.response.status, 503);
  assert.deepEqual(failed.body, { error: { code: 'recommendation-feedback-unavailable' } });
  const after = (await visitor.state()).demo;
  assert.deepEqual(after.catalogueBatch, before.catalogueBatch);
  assert.deepEqual(after.lastApiRecommendations, before.lastApiRecommendations);
});

test('Reset Demo deletes only the current persona feedback and rolls back on failure', async () => {
  db.seedUser('jia', { budget_max: 25 });
  db.seedUser('darren', { budget_max: 30 });
  db.seedFeedback({ user_id: 'jia', merchant_id: 'mid-rice' });
  db.seedFeedback({ user_id: 'darren', merchant_id: 'far-noodles' });
  const visitor = http.visitor();
  assert.equal((await visitor.request('/reset-demo', {})).status, 302);
  assert.deepEqual(db.feedbackRows.map(row => row.user_id), ['darren']);
  assert.equal(db.users.get('jia').budget_max, 10);
  assert.equal(db.users.get('darren').budget_max, 30);
  const deletes = db.calls.filter(call => call.sql.startsWith('DELETE FROM rejection_feedback'));
  assert.deepEqual(deletes.map(call => call.params), [['jia']]);

  db.seedFeedback({ user_id: 'jia', merchant_id: 'mid-rice' });
  db.users.get('jia').budget_max = 25;
  db.resetDeleteFailing = true;
  assert.equal((await visitor.request('/reset-demo', {})).status, 500);
  assert.equal(db.users.get('jia').budget_max, 25);
  assert.equal(db.feedbackRows.some(row => row.user_id === 'jia'), true);
});

test('SQL and browser surface remain parameterised and contain no obsolete feedback path', () => {
  const adapter = fs.readFileSync(path.join(__dirname, '../rejection-feedback.js'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
  const browser = fs.readFileSync(path.join(__dirname, '../public/js/script.js'), 'utf8');
  assert.doesNotMatch(app + browser, /\/api\/feedback|handleRejection/);
  assert.doesNotMatch(app, /UPDATE users SET weight_(?:price|distance)_sensitivity = weight_/);
  assert.doesNotMatch(adapter, /weight_(?:price|distance|quietness)/);
  assert.doesNotMatch(adapter, /(?:UPDATE|DELETE)\s+(?:transactions|merchants|campaign)/i);
  assert.doesNotMatch(adapter + app, /reinforcement learning|model training/i);
  assert.match(adapter, /DELETE FROM rejection_feedback WHERE user_id = \?/);
  assert.match(adapter, /WHERE user_id = \?/);
});

test('migration is additive and rerunnable without destructive replacement', () => {
  const sql = fs.readFileSync(path.join(__dirname,
    '../Database/migrations/004_jolene_step4_rejection_feedback.sql'), 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS rejection_feedback/);
  for (const name of ['submission_token', 'distance_metres', 'rejected_at_sg',
    'uq_rejection_user_token', 'idx_rejection_user_sg_time']) assert.match(sql, new RegExp(name));
  assert.match(sql, /information_schema\.columns/);
  assert.match(sql, /information_schema\.statistics/);
  assert.doesNotMatch(sql, /DROP\s+(?:TABLE|DATABASE)|TRUNCATE|CREATE\s+DATABASE/i);
});
