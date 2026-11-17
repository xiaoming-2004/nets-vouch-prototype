'use strict';

const { database: db, counters } = require('./helpers/test-isolation.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { merchants, DATASET } = require('../sample-data/nets-vouch-task3.cjs');
const { start } = require('./helpers/visitor.cjs');
const { resetMerchantCampaigns } = require('../app');

function seedTask3Catalogue(overrides = {}) {
  merchants.forEach(function(merchant) {
    const values = overrides[merchant.merchantId] || {};
    db.seedMerchant({
      merchant_id: merchant.merchantId,
      name: merchant.name,
      location_label: merchant.locationLabel,
      distance_metres: merchant.distanceMetres,
      cuisine_type: merchant.cuisineType,
      typical_price: merchant.typicalPrice,
      dietary_halal: merchant.dietaryHalal ? 1 : 0,
      dietary_vegetarian: merchant.dietaryVegetarian ? 1 : 0,
      dietary_vegan: merchant.dietaryVegan ? 1 : 0,
      reward_amount: merchant.rewardAmount,
      min_spend: merchant.minSpend,
      is_sample_data: 1,
      ...values
    });
  });
}

async function recommend(visitor, query = '') {
  const response = await visitor.request('/api/recommend' + query);
  return { response, body: JSON.parse(response.html) };
}

function activityCalls() {
  return db.calls.filter(function(call) { return /FROM merchants m JOIN sample_datasets d/.test(call.sql); });
}

let http;
test.before(async () => { http = await start(); });
test.beforeEach(() => { resetMerchantCampaigns(); seedTask3Catalogue(); });
test.after(async () => {
  await http.close();
  assert.deepEqual(counters, { envLoads: 0, privateReads: 0, mysqlFactories: 0,
    redisFactories: 0, blockedConnections: 0 });
});

test('explicit invalid fields return stable 400 errors before reads or session mutation', async () => {
  const v = http.visitor();
  const before = await v.request('/home');
  assert.equal(before.status, 200);
  db.calls.length = 0;
  const initial = (await v.state()).demo;
  const result = await recommend(v, '?cuisine=halal&dietaryPreference=rice&budget=bad&maxDistance=2.5&diningDate=2026-02-30&diningTime=25:00&lat=1.4');
  assert.equal(result.response.status, 400);
  assert.deepEqual(result.body, { error: { code: 'invalid-recommendation-input', fields: {
    budget: 'out-of-range', maxDistance: 'out-of-range', cuisine: 'unsupported-value',
    dietaryPreference: 'unsupported-value', diningDate: 'invalid-date', diningTime: 'invalid-time',
    lat: 'unsupported-parameter'
  } } });
  assert.equal(db.calls.length, 0);
  const after = (await v.state()).demo;
  assert.deepEqual(after.discoveryLocation, initial.discoveryLocation);
  assert.deepEqual(after.catalogueBatch, initial.catalogueBatch);
  assert.deepEqual(after.lastApiRecommendations, initial.lastApiRecommendations);
});

test('cuisine and dietary preference are separate and all hard filters apply first', async () => {
  const result = await recommend(http.visitor(),
    '?budget=10&maxDistance=10&cuisine=rice&dietaryPreference=vegan&diningDate=2026-11-02&diningTime=14:30');
  assert.equal(result.response.status, 200);
  assert.ok(result.body.recommendations.length > 0);
  assert.ok(result.body.recommendations.every(function(card) {
    return card.price <= 10 && card.distanceMetres <= 800 && card.dietary.includes('vegan');
  }));
  assert.equal(result.body.metadata.request.cuisinePreference, 'rice');
  assert.equal(result.body.metadata.request.dietaryPreference, 'vegan');
  assert.ok(result.body.recommendations.every(function(card) { return card.cuisine !== 'rice'; }),
    'a cuisine preference must not masquerade as a dietary declaration');
});

test('Singapore calendar date and hour reach one parameterised activity batch read', async () => {
  const result = await recommend(http.visitor(), '?diningDate=2026-11-02&diningTime=14:37');
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.body.metadata.request.dining, {
    date: '2026-11-02', time: '14:37', isoWeekday: 1, hour: 14, timezone: 'Asia/Singapore'
  });
  assert.equal(activityCalls().length, 1);
  const call = activityCalls()[0];
  assert.deepEqual(call.params.slice(0, 2), [1, '14:00:00']);
  assert.equal(call.params.length, 12, 'the full ten-merchant eligible batch is read at once');
  assert.match(call.sql, /^SELECT /);
  assert.doesNotMatch(call.sql, /\b(?:INSERT|UPDATE|DELETE|REPLACE|ALTER|CREATE|DROP|TRUNCATE)\b/i);
});

test('historically closed merchants are excluded after the complete eligible batch is loaded', async () => {
  const result = await recommend(http.visitor(), '?budget=20&maxDistance=20&diningDate=2026-11-02&diningTime=09:15');
  assert.equal(activityCalls().length, 1);
  assert.equal(activityCalls()[0].params.length, 12);
  assert.deepEqual(result.body.recommendations.map(function(card) { return card.id; }).sort(),
    ['kopi-toast-corner', 'makcik-nasi-padang'].sort());
  assert.ok(result.body.recommendations.every(function(card) { return card.usualActivity.status !== 'closed'; }));
});

test('activity comparison is attached, labelled and scored without live claims', async () => {
  const result = await recommend(http.visitor(), '?diningDate=2026-11-02&diningTime=14:00');
  const felicia = result.body.recommendations.find(function(card) { return card.id === 'felicia-chicken-rice'; });
  assert.ok(felicia);
  assert.deepEqual([felicia.usualActivity.status, felicia.usualActivity.comparison], ['available', 'quieter']);
  assert.equal(felicia.usualActivity.sampleDataLabel, DATASET.label);
  assert.match(felicia.matchReasons.join(' '), /Usually quieter.*fictional sample history/);
  assert.doesNotMatch(JSON.stringify(result.body), /live queue|waiting time|seating availability|routed walking time is/i);
  assert.deepEqual(result.body.metadata.distance, { basis: 'demo-origin-estimate',
    origin: 'Republic Polytechnic demo origin', routed: false });
});

test('activity failure remains neutral, keeps eligible merchants and hides database details', async () => {
  db.activityFailing = true;
  const result = await recommend(http.visitor(), '?budget=20&maxDistance=20&diningDate=2026-11-02&diningTime=14:00');
  assert.equal(result.response.status, 200);
  assert.equal(result.body.recommendations.length, 3);
  assert.equal(result.body.metadata.activity.status, 'unavailable');
  assert.ok(result.body.recommendations.every(function(card) {
    return card.usualActivity.status === 'unavailable' && card.usualActivity.reason === 'database-unavailable';
  }));
  assert.doesNotMatch(JSON.stringify(result.body), /simulated private|database detail/i);
});

test('quieter, typical and busier apply symmetric +20, 0 and -20 ordering', async () => {
  db.merchants.clear();
  const ids = ['felicia-chicken-rice', 'green-bowl', 'ah-heng-fish-soup'];
  const same = { distance_metres: 200, typical_price: '6.00', cuisine_type: 'rice',
    dietary_halal: 0, dietary_vegetarian: 0, dietary_vegan: 0 };
  seedTask3Catalogue(Object.fromEntries(ids.map(function(id) { return [id, same]; })));
  for (const id of [...db.merchants.keys()]) if (!ids.includes(id)) db.merchants.delete(id);
  const result = await recommend(http.visitor(), '?budget=10&maxDistance=10&diningDate=2026-11-02&diningTime=14:00');
  assert.deepEqual(result.body.recommendations.map(function(card) {
    return [card.id, card.usualActivity.comparison];
  }), [
    ['felicia-chicken-rice', 'quieter'],
    ['green-bowl', 'typical'],
    ['ah-heng-fish-soup', 'busier']
  ]);
});

test('neutral activity ties resolve by distance, price and exact merchant ID', async () => {
  db.merchants.clear();
  const ids = ['woodlands-noodle-bar', 'green-bowl', 'felicia-chicken-rice'];
  const same = { distance_metres: 200, typical_price: '6.00', cuisine_type: 'rice',
    dietary_halal: 0, dietary_vegetarian: 0, dietary_vegan: 0 };
  seedTask3Catalogue(Object.fromEntries(ids.map(function(id) { return [id, same]; })));
  for (const id of [...db.merchants.keys()]) if (!ids.includes(id)) db.merchants.delete(id);
  db.activityFailing = true;
  const result = await recommend(http.visitor(), '?budget=10&maxDistance=10&diningDate=2026-11-02&diningTime=14:00');
  assert.deepEqual(result.body.recommendations.map(function(card) { return card.id; }), [...ids].sort());
});

test('all three cards retain exact accept and reject actions and display-only snapshots', async () => {
  for (const index of [0, 1, 2]) {
    const accepting = http.visitor();
    const batch = (await recommend(accepting, '?diningDate=2026-11-02&diningTime=14:00')).body.recommendations;
    const selected = batch[index];
    const accepted = await accepting.request('/recommendation/accept', { merchantId: selected.id });
    assert.equal(accepted.location, '/scan');
    const state = (await accepting.state()).demo;
    assert.equal(state.selectedMerchantId, selected.id);
    assert.equal(state.selectedMerchantSnapshot.usualActivity.merchantId, selected.id);
    assert.equal(state.selectedMerchantSnapshot.catalogueTerms.rewardAmount, selected.campaign.rewardAmount);
    const acceptedHome = await accepting.request('/home');
    assert.equal(acceptedHome.status, 200);
    assert.match(acceptedHome.html, /fictional sample history/i);

    const rejecting = http.visitor();
    const rejectBatch = (await recommend(rejecting, '?diningDate=2026-11-02&diningTime=14:00')).body.recommendations;
    const rejected = await rejecting.request('/recommendation/reject', {
      merchantId: rejectBatch[index].id, feedbackToken: rejectBatch[index].feedbackToken, reason: 'not-in-mood'
    }, { 'X-Requested-With': 'smart-match' });
    assert.equal(rejected.status, 204);
  }
});

test('Home exposes timezone-safe dining controls and mobile-readable card styles', async () => {
  const home = await http.visitor().request('/home');
  assert.match(home.html, /type="datetime-local"/);
  assert.match(home.html, /Singapore date and time/);
  const script = fs.readFileSync(path.join(__dirname, '../public/js/script.js'), 'utf8');
  const queryBuilder = script.slice(script.indexOf('function diningRecommendationQuery'), script.indexOf('function diningParts'));
  assert.match(queryBuilder, /query\.set\('diningDate'/);
  assert.match(queryBuilder, /query\.set\('diningTime'/);
  assert.doesNotMatch(queryBuilder, /new Date|toISOString|toLocale/);
  const css = fs.readFileSync(path.join(__dirname, '../public/css/style.css'), 'utf8');
  assert.match(css, /@media \(max-width:560px\)[\s\S]*\.dining-time-controls \{ grid-template-columns:1fr; \}/);
  assert.match(css, /\.rec-reasons/);
});

