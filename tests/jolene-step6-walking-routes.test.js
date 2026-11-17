const { database: db, counters } = require('./helpers/test-isolation.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ejs = require('ejs');
const { merchants: task3Merchants } = require('../sample-data/nets-vouch-task3.cjs');
const { start } = require('./helpers/visitor.cjs');
const { row } = require('./helpers/catalogue-fixtures.cjs');
const feedback = require('../rejection-feedback');
const routes = require('../walking-routes');
const nl = require('../natural-language-intent');
const { resetMerchantCampaigns, getMerchantCampaigns } = require('../app');

const ROOT = path.join(__dirname, '..');
const originalFetch = global.fetch;
const ROUTES_KEY = 'fake-routes-key-AAAA1111';
const BROWSER_KEY = 'fake-browser-key-BBBB2222';
const GROQ_KEY = 'fake-groq-key-CCCC3333';
// A distinctive Singapore origin that must never be found anywhere it should not be.
const ORIGIN = { latitude: 1.3012345, longitude: 103.8123456 };
const ORIGIN_NEEDLES = ['1.3012345', '103.8123456', '1.30123', '103.81234'];
const FIXED_NOW = '2026-11-17T06:00:00.000Z';

function seedTask3() {
  task3Merchants.forEach(function(m) {
    db.seedMerchant({ merchant_id: m.merchantId, name: m.name, location_label: m.locationLabel,
      distance_metres: m.distanceMetres, cuisine_type: m.cuisineType, typical_price: m.typicalPrice,
      dietary_halal: m.dietaryHalal ? 1 : 0, dietary_vegetarian: m.dietaryVegetarian ? 1 : 0,
      dietary_vegan: m.dietaryVegan ? 1 : 0, reward_amount: m.rewardAmount, min_spend: m.minSpend,
      is_sample_data: 1, latitude: m.latitude.toFixed(6), longitude: m.longitude.toFixed(6) });
  });
}

const W = metres => [metres, Math.round(metres * 0.75)]; // [metres, seconds]: 80 m per minute

// Google mock. table: merchantId -> [metres, seconds] | 'none' | 'error' | 'missing'.
let routeCalls;
let otherCalls;
function elementFor(index, spec) {
  const element = {};
  if (index) element.destinationIndex = index; // proto3 JSON omits index 0
  if (spec === 'none') { element.status = {}; element.condition = 'ROUTE_NOT_FOUND'; return element; }
  if (spec === 'error') { element.status = { code: 5, message: 'SECRET-GOOGLE-DETAIL' }; element.condition = 'ROUTE_NOT_FOUND'; return element; }
  element.status = {}; element.condition = 'ROUTE_EXISTS';
  if (spec[0]) element.distanceMeters = spec[0];
  element.duration = spec[1] + 's';
  return element;
}
function matrixFor(body, table, options) {
  const byCoordinate = new Map();
  db.merchants.forEach(function(r) { if (!Array.isArray(r) && r.latitude) byCoordinate.set(Number(r.latitude) + ',' + Number(r.longitude), r.merchant_id); });
  let elements = body.destinations.map(function(d, index) {
    const id = byCoordinate.get(d.waypoint.location.latLng.latitude + ',' + d.waypoint.location.latLng.longitude);
    const spec = table[id];
    if (spec === undefined) throw new Error('unmapped destination ' + id);
    return spec === 'missing' ? null : elementFor(index, spec);
  }).filter(Boolean);
  if (options && options.shuffle) elements = elements.slice().reverse();
  return elements;
}
// handler(body, callNumber) -> { json } | { status } | { reject } | { hang }; groq(body) -> content object
function mockGoogle(handler, groq) {
  routeCalls = []; otherCalls = [];
  global.fetch = async function(url, init) {
    const host = new URL(String(url)).hostname;
    if (host === 'api.groq.com') {
      otherCalls.push({ host, body: JSON.parse(init.body) });
      const content = groq ? groq(JSON.parse(init.body)) : null;
      if (!content) return { ok: false, status: 500 };
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(content) } }] }) };
    }
    if (host !== 'routes.googleapis.com') throw new Error('unexpected host ' + host);
    routeCalls.push({ url: String(url), init, body: JSON.parse(init.body) });
    const outcome = await handler(JSON.parse(init.body), routeCalls.length);
    if (outcome.reject) throw new TypeError('network down');
    if (outcome.hang) {
      return new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
    }
    if (outcome.status) return { ok: false, status: outcome.status, json: async () => ({ error: { message: 'SECRET-GOOGLE-DETAIL' } }) };
    return { ok: true, status: 200, json: async () => outcome.json };
  };
}
function tableMock(table, options) { mockGoogle(body => ({ json: matrixFor(body, table, options) })); }

function allDistances(overrides) {
  const table = {};
  task3Merchants.forEach(m => { table[m.merchantId] = W(3000); });
  return Object.assign(table, overrides);
}

let captured;
let restoreCapture = () => {};
function captureOutput() {
  captured = [];
  const originals = {};
  ['log', 'info', 'warn', 'error', 'debug'].forEach(name => {
    originals[name] = console[name];
    console[name] = (...args) => captured.push(args.map(String).join(' '));
  });
  const stderr = process.stderr.write;
  process.stderr.write = function(chunk) { captured.push(String(chunk)); return true; };
  restoreCapture = () => {
    Object.keys(originals).forEach(name => { console[name] = originals[name]; });
    process.stderr.write = stderr;
  };
}

function liveBody(extra) {
  return Object.assign({ location: ORIGIN, budget: 20, maxDistance: 5, diningDate: '2026-11-17', diningTime: '12:00' }, extra || {});
}
async function live(v, extra) {
  const response = await v.request('/api/recommend/live', liveBody(extra));
  let body = null; try { body = JSON.parse(response.html); } catch (e) { body = null; }
  return { response, body };
}
async function demo(v, query) {
  const response = await v.request('/api/recommend' + (query || '?budget=20&maxDistance=60&diningDate=2026-11-17&diningTime=12:00'));
  return { response, body: JSON.parse(response.html) };
}
const batchOf = async v => { const d = (await v.state()).demo; return JSON.stringify([d.catalogueBatch, d.lastApiRecommendations]); };
const containsOrigin = text => ORIGIN_NEEDLES.some(needle => String(text).includes(needle));
const minutes = metres => Math.ceil(Math.round(metres * 0.75) / 60);

let http;
test.before(async () => { http = await start(); });
test.beforeEach(() => {
  process.env.GOOGLE_ROUTES_API_KEY = ROUTES_KEY;
  process.env.GOOGLE_MAPS_BROWSER_API_KEY = BROWSER_KEY;
  process.env.GROQ_API_KEY = GROQ_KEY;
  delete process.env.WALKING_ROUTES_TIMEOUT_MS;
  nl.setClockForTest(() => new Date(FIXED_NOW));
  feedback.setNowProviderForTest(() => new Date(FIXED_NOW));
  resetMerchantCampaigns();
  seedTask3();
});
test.afterEach(() => {
  restoreCapture(); restoreCapture = () => {};
  global.fetch = originalFetch;
  ['GOOGLE_ROUTES_API_KEY', 'GOOGLE_MAPS_BROWSER_API_KEY', 'GROQ_API_KEY', 'WALKING_ROUTES_TIMEOUT_MS'].forEach(k => delete process.env[k]);
  nl.setClockForTest(); feedback.setNowProviderForTest();
});
test.after(async () => {
  await http.close();
  assert.deepEqual(counters, { envLoads: 0, privateReads: 0, mysqlFactories: 0, redisFactories: 0, blockedConnections: 0 });
});

// ---------------------------------------------------------------------------
// 1-4. One matrix request, no RP pre-filter, walking time decides filtering and ranking
// ---------------------------------------------------------------------------
test('live request: one WALK matrix request, RP estimate not used, walking minutes filter and rank', async () => {
  tableMock(allDistances({ 'northside-wraps': W(100), 'spice-lane': W(160), 'vegan-zen-kitchen': W(200), 'tokyo-express-bento': W(400) }));
  const v = http.visitor();
  const { response, body } = await live(v);
  assert.equal(response.status, 200);
  assert.equal(routeCalls.length, 1, 'exactly one matrix request');
  const call = routeCalls[0];
  assert.equal(call.url, 'https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix');
  assert.deepEqual(Object.keys(call.body).sort(), ['destinations', 'origins', 'travelMode']);
  assert.equal(call.body.travelMode, 'WALK');
  assert.equal('routingPreference' in call.body, false);
  assert.equal(call.body.origins.length, 1);
  assert.deepEqual(call.body.origins[0].waypoint.location.latLng, ORIGIN);
  assert.equal(call.body.destinations.length, 10);
  assert.equal(call.init.headers['X-Goog-Api-Key'], ROUTES_KEY);
  assert.equal(call.init.headers['X-Goog-FieldMask'], 'originIndex,destinationIndex,duration,distanceMeters,status,condition');
  assert.equal(JSON.stringify(call.init.headers).includes(BROWSER_KEY), false);

  // northside-wraps is 720 m from RP (outside a 5 minute RP estimate) but 100 m from the user.
  const ids = body.recommendations.map(card => card.id);
  const withinLimit = ['northside-wraps', 'spice-lane', 'vegan-zen-kitchen', 'tokyo-express-bento'];
  assert.equal(ids.length, 3);
  assert.ok(ids.every(id => withinLimit.includes(id)), ids.join());
  assert.ok(ids.includes('northside-wraps'));
  assert.ok(body.recommendations.length <= 3);
  body.recommendations.forEach(card => {
    assert.equal(card.distanceMetres, null); assert.equal(card.distanceMinutes, null); assert.equal(card.distanceLabel, null);
    assert.equal(card.travel.mode, 'live-walking');
    assert.equal(card.travel.provider, 'Google Maps');
    assert.equal(card.travel.warning, routes.WALKING_WARNING);
    assert.ok(card.travel.walkingMinutes <= 5);
    assert.deepEqual(Object.keys(card.travel).sort(),
      ['mode', 'provider', 'sampleDestination', 'walkingMetres', 'walkingMinutes', 'warning']);
  });
  assert.deepEqual(body.recommendations.map(c => c.travel.walkingMetres), body.recommendations.map(c => c.travel.walkingMetres).slice().sort((a, b) => a - b),
    'equal-score ordering follows routed metres');
  assert.equal(body.metadata.distance.basis, 'google-walking-route');
  assert.equal(body.metadata.distance.routed, true);
  assert.deepEqual(body.metadata.travel, { requestedDestinations: 10, withoutCoordinates: 0, noRoute: 0, unavailable: 0, beyondWalkingLimit: 6 });
  assert.equal(body.metadata.activity.status, 'available');
  assert.equal(body.metadata.feedback.status, 'applied');
  assert.equal(containsOrigin(response.html), false);
  assert.equal(response.location, null);
});

test('walking duration decides the maxDistance boundary at exactly N minutes', async () => {
  db.merchants.clear();
  db.seedMerchant(row({ merchant_id: 'edge-in', name: 'Edge In', latitude: '1.440000', longitude: '103.780000', typical_price: '5.00' }));
  db.seedMerchant(row({ merchant_id: 'edge-out', name: 'Edge Out', latitude: '1.441000', longitude: '103.781000', typical_price: '5.00' }));
  tableMock({ 'edge-in': [400, 300], 'edge-out': [401, 301] });
  const { body } = await live(http.visitor(), { maxDistance: 5 });
  assert.deepEqual(body.recommendations.map(c => c.id), ['edge-in']);
  assert.equal(body.recommendations[0].travel.walkingMinutes, 5);
  assert.equal(body.metadata.travel.beyondWalkingLimit, 1);
});

test('proximity ranking uses routed metres, not the stored RP estimate', async () => {
  db.merchants.clear();
  db.seedMerchant(row({ merchant_id: 'a-far-from-rp', name: 'A', latitude: '1.440000', longitude: '103.780000', distance_metres: 700, typical_price: '5.00' }));
  db.seedMerchant(row({ merchant_id: 'b-near-rp', name: 'B', latitude: '1.441000', longitude: '103.781000', distance_metres: 90, typical_price: '5.00' }));
  tableMock({ 'a-far-from-rp': W(100), 'b-near-rp': W(300) });
  const { body } = await live(http.visitor());
  assert.deepEqual(body.recommendations.map(c => c.id), ['a-far-from-rp', 'b-near-rp']);
});

test('matrix elements map to merchants by destinationIndex whatever the response order', async () => {
  const table = allDistances({ 'northside-wraps': W(120), 'spice-lane': W(240), 'vegan-zen-kitchen': W(330) });
  tableMock(table, { shuffle: true });
  const { body } = await live(http.visitor());
  assert.ok(body.recommendations.length >= 3);
  body.recommendations.forEach(card => {
    assert.equal(card.travel.walkingMetres, table[card.id][0], card.id);
    assert.equal(card.travel.walkingMinutes, minutes(table[card.id][0]));
  });
});

// ---------------------------------------------------------------------------
// 5. Partial and no-route results are excluded honestly
// ---------------------------------------------------------------------------
test('no-route, missing, errored and coordinate-less merchants are excluded and counted', async () => {
  db.merchants.get('felicia-chicken-rice').latitude = null;
  db.merchants.get('felicia-chicken-rice').longitude = null;
  tableMock(allDistances({ 'northside-wraps': W(100), 'spice-lane': 'none', 'green-bowl': 'missing',
    'makcik-nasi-padang': 'error', 'vegan-zen-kitchen': W(200) }));
  const { response, body } = await live(http.visitor());
  assert.equal(response.status, 200);
  const ids = body.recommendations.map(c => c.id);
  ['spice-lane', 'green-bowl', 'makcik-nasi-padang', 'felicia-chicken-rice'].forEach(id => assert.equal(ids.includes(id), false, id));
  assert.ok(ids.includes('northside-wraps') && ids.includes('vegan-zen-kitchen'));
  assert.equal(body.metadata.travel.withoutCoordinates, 1);
  assert.equal(body.metadata.travel.requestedDestinations, 9);
  assert.equal(body.metadata.travel.noRoute, 1);
  assert.equal(body.metadata.travel.unavailable, 2);
  assert.equal(routeCalls[0].body.destinations.length, 9);
  assert.equal(response.html.includes('SECRET-GOOGLE-DETAIL'), false);
});

test('a matrix where every element cleanly has no route is an empty 200, not a failure', async () => {
  const none = {}; task3Merchants.forEach(m => { none[m.merchantId] = 'none'; });
  tableMock(none);
  const v = http.visitor();
  const { response, body } = await live(v);
  assert.equal(response.status, 200);
  assert.deepEqual(body.recommendations, []);
  assert.equal(body.metadata.travel.noRoute, 10);
  assert.equal((await v.state()).demo.catalogueBatch.length, 0);
});

// ---------------------------------------------------------------------------
// 6. Total failures keep the previous batch and tokens and never fall back to RP estimates
// ---------------------------------------------------------------------------
test('every total Routes failure returns a stable code and preserves the previous batch', async () => {
  const v = http.visitor();
  await demo(v);
  const before = await batchOf(v);
  const goodElement = { status: {}, condition: 'ROUTE_EXISTS', distanceMeters: 100, duration: '75s' };
  const cases = [
    ['not configured', null, 503, 'walking-routes-not-configured', 0],
    ['http 500', () => ({ status: 500 }), 502, 'walking-routes-provider-failure', 1],
    ['http 403', () => ({ status: 403 }), 502, 'walking-routes-provider-failure', 1],
    ['http 429', () => ({ status: 429 }), 503, 'walking-routes-rate-limited', 1],
    ['network error', () => ({ reject: true }), 502, 'walking-routes-provider-failure', 1],
    ['timeout', () => ({ hang: true }), 504, 'walking-routes-timeout', 1],
    ['not an array', () => ({ json: { error: 'x' } }), 502, 'walking-routes-invalid-response', 1],
    ['bad duration', () => ({ json: [{ ...goodElement, duration: '75 seconds' }] }), 502, 'walking-routes-invalid-response', 1],
    ['bad condition', () => ({ json: [{ status: {}, condition: 'SOMETHING' }] }), 502, 'walking-routes-invalid-response', 1],
    ['duplicate index', () => ({ json: [goodElement, goodElement] }), 502, 'walking-routes-invalid-response', 1],
    ['index out of range', () => ({ json: [{ ...goodElement, destinationIndex: 99 }] }), 502, 'walking-routes-invalid-response', 1],
    ['wrong origin index', () => ({ json: [{ ...goodElement, originIndex: 1 }] }), 502, 'walking-routes-invalid-response', 1],
    ['all errored', body => ({ json: body.destinations.map((d, i) => ({ destinationIndex: i, status: { code: 13 } })) }), 502, 'walking-routes-invalid-response', 1]
  ];
  for (const [label, handler, status, code, callCount] of cases) {
    if (handler) { mockGoogle(handler); process.env.WALKING_ROUTES_TIMEOUT_MS = label === 'timeout' ? '500' : ''; }
    else { mockGoogle(() => ({ json: [] })); delete process.env.GOOGLE_ROUTES_API_KEY; }
    captureOutput();
    const { response, body } = await live(v);
    restoreCapture();
    process.env.GOOGLE_ROUTES_API_KEY = ROUTES_KEY;
    assert.equal(response.status, status, label);
    assert.equal(body.error.code, code, label);
    assert.equal(body.alternative, 'demo-origin', label);
    assert.equal(body.recommendations, undefined, label);
    assert.equal(routeCalls.length, callCount, label + ' (no retry)');
    const everything = response.html + captured.join('\n');
    ['SECRET-GOOGLE-DETAIL', ROUTES_KEY, BROWSER_KEY].forEach(secret => assert.equal(everything.includes(secret), false, label));
    assert.equal(containsOrigin(everything), false, label);
    assert.equal(await batchOf(v), before, label + ' must preserve the previous batch and tokens');
  }
});

test('local limit allows 20 live requests per minute, then 429 with Retry-After', async () => {
  tableMock(allDistances({ 'northside-wraps': W(100) }));
  const v = http.visitor();
  for (let i = 0; i < 20; i++) assert.equal((await live(v)).response.status, 200, 'request ' + (i + 1));
  const limited = await live(v);
  assert.equal(limited.response.status, 429);
  assert.equal(limited.body.error.code, 'location-request-rate-limited');
  assert.ok(Number(limited.response.retryAfter) >= 1 && Number(limited.response.retryAfter) <= 60);
  assert.equal(routeCalls.length, 20);
  assert.equal(routes.consumeRateLimit(Array.from({ length: 20 }, () => 1000), 2000).retryAfterSeconds, 59);
});

// ---------------------------------------------------------------------------
// 7. Demo-origin mode unchanged; GET never accepts coordinates
// ---------------------------------------------------------------------------
test('demo mode keeps its exact shape and never touches Google', async () => {
  tableMock(allDistances());
  const { response, body } = await demo(http.visitor());
  assert.equal(response.status, 200);
  assert.equal(routeCalls.length, 0);
  assert.deepEqual(Object.keys(body), ['recommendations', 'catalogue', 'metadata']);
  assert.deepEqual(Object.keys(body.metadata), ['request', 'distance', 'activity', 'feedback']);
  assert.deepEqual(body.metadata.distance, { basis: 'demo-origin-estimate', origin: 'Republic Polytechnic demo origin', routed: false });
  body.recommendations.forEach(card => {
    assert.deepEqual(Object.keys(card), ['id', 'merchantName', 'itemName', 'price', 'distanceMinutes', 'distanceMetres',
      'distanceLabel', 'source', 'isSampleData', 'dietary', 'category', 'cuisine', 'feedbackToken', 'usualActivity',
      'matchReasons', 'campaign']);
    assert.match(card.distanceLabel, /from demo origin \(catalogue estimate\)/);
    assert.ok(Number.isFinite(card.distanceMetres));
  });
});

test('GET /api/recommend rejects any lat or lng without reading, storing or routing', async () => {
  tableMock(allDistances());
  const v = http.visitor();
  await v.request('/home');
  const before = JSON.stringify((await v.state()).demo);
  db.calls.length = 0;
  for (const query of ['?lat=1.3012345&lng=103.8123456', '?lat=1.3012345', '?lng=103.8123456', '?lat=abc&lng=']) {
    const { response, body } = await demo(v, query);
    assert.equal(response.status, 400, query);
    assert.equal(body.error.code, 'invalid-recommendation-input');
    assert.ok(Object.values(body.error.fields).every(value => value === 'unsupported-parameter'));
    assert.equal(containsOrigin(response.html), false);
  }
  assert.equal(db.calls.length, 0);
  assert.equal(routeCalls.length, 0);
  assert.equal(JSON.stringify((await v.state()).demo), before);
});

// ---------------------------------------------------------------------------
// 8. Validation before any database or Google read
// ---------------------------------------------------------------------------
test('live POST validates body, coordinates and filters before any read', async () => {
  tableMock(allDistances());
  const v = http.visitor();
  await v.request('/home');
  const before = JSON.stringify((await v.state()).demo);
  db.calls.length = 0;
  const bad = [
    [[], { request: 'invalid' }],
    [{ location: ORIGIN, extra: 1 }, { request: 'unknown-field' }],
    [{ budget: 5 }, { location: 'required' }],
    [liveBody({ location: null }), { location: 'invalid' }],
    [liveBody({ location: '1.3,103.8' }), { location: 'invalid' }],
    [liveBody({ location: { latitude: 1.3, longitude: 103.8, accuracy: 5 } }), { location: 'invalid' }],
    [liveBody({ location: { latitude: '1.3', longitude: 103.8 } }), { location: 'invalid' }],
    [liveBody({ location: { latitude: 91, longitude: 103.8 } }), { location: 'out-of-range' }],
    [liveBody({ location: { latitude: 1.3, longitude: 181 } }), { location: 'out-of-range' }],
    [liveBody({ location: { latitude: 1.0, longitude: 103.8 } }), { location: 'outside-singapore' }],
    [liveBody({ location: { latitude: 1.3, longitude: 105 } }), { location: 'outside-singapore' }],
    [liveBody({ budget: '10' }), { budget: 'invalid-type' }],
    [liveBody({ maxDistance: 2.5 }), { maxDistance: 'invalid-type' }],
    [liveBody({ cuisine: 'halal' }), { cuisine: 'unsupported-value' }],
    [liveBody({ diningDate: '2026-02-30' }), { diningDate: 'invalid-date' }],
    [liveBody({ diningTime: '25:00' }), { diningTime: 'invalid-time' }]
  ];
  const nullBody = await v.rawPost('/api/recommend/live', 'null');
  assert.equal(nullBody.status, 400);
  assert.deepEqual(JSON.parse(nullBody.html), { error: { code: 'invalid-recommendation-input' } });
  for (const [body, fields] of bad) {
    const response = await v.request('/api/recommend/live', body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.deepEqual(JSON.parse(response.html), { error: { code: 'invalid-recommendation-input', fields } });
    assert.equal(containsOrigin(response.html), false);
  }
  assert.equal(db.calls.length, 0, 'no database read for invalid input');
  assert.equal(routeCalls.length, 0);
  assert.equal(JSON.stringify((await v.state()).demo), before);
});

test('malformed JSON bodies get a fixed 400 and put nothing in logs or responses', async () => {
  tableMock(allDistances());
  const v = http.visitor();
  await v.request('/home');
  captureOutput();
  const truncated = '{"location":{"latitude":1.3012345,"longitude":103.8123456';
  const live400 = await v.rawPost('/api/recommend/live', truncated);
  const nl400 = await v.rawPost('/api/recommend/natural', truncated);
  const huge = await v.rawPost('/api/recommend/live', '{"location":"' + 'x'.repeat(200000) + '"}');
  restoreCapture();
  assert.equal(live400.status, 400);
  assert.deepEqual(JSON.parse(live400.html), { error: { code: 'invalid-recommendation-input' } });
  assert.equal(nl400.status, 400);
  assert.deepEqual(JSON.parse(nl400.html), { error: { code: 'invalid-natural-language-input' } });
  assert.equal(huge.status, 400);
  assert.equal(captured.length, 0, captured.join('\n'));
  [live400, nl400, huge].forEach(r => { assert.equal(containsOrigin(r.html), false); assert.equal(/stack|SyntaxError|at /.test(r.html), false); });
  assert.equal(routeCalls.length, 0);
});

// ---------------------------------------------------------------------------
// 9. The origin is never stored or logged anywhere
// ---------------------------------------------------------------------------
test('the origin appears only in the request body and the Google request', async () => {
  tableMock(allDistances({ 'northside-wraps': W(100), 'spice-lane': W(160), 'vegan-zen-kitchen': W(200) }));
  const v = http.visitor();
  captureOutput();
  const first = await live(v);
  const cards = first.body.recommendations;
  const accepted = await v.request('/recommendation/accept', { merchantId: cards[0].id });
  const scanPage = await v.request('/scan');
  const scanPost = await v.request('/scan', { merchantId: cards[0].id });
  const state0 = (await v.state()).demo;
  const scan = state0.currentScanPayment;
  const paymentPage = await v.request('/scan/payment');
  const paid = await v.request('/scan/payment', { journeyId: scan.id, amount: '6.00' });
  const rejected = await v.request('/recommendation/reject', { merchantId: cards[1].id,
    feedbackToken: cards[1].feedbackToken, reason: 'too-far' }, { 'X-Requested-With': 'smart-match' });
  const home = await v.request('/home');
  restoreCapture();

  assert.equal(routeCalls.length, 1);
  assert.equal(containsOrigin(JSON.stringify(routeCalls[0].body)), true, 'only the Google request carries the origin');
  assert.equal(accepted.location, '/scan');
  [accepted.location, scanPost.location, paid.location, rejected.status === 204 ? '' : rejected.location]
    .forEach(location => assert.equal(containsOrigin(location), false));
  const everything = [first.response.html, scanPage.html, paymentPage.html, home.html, captured.join('\n'),
    JSON.stringify(db.calls), JSON.stringify(db.feedbackRows), JSON.stringify(await v.state())].join('\n');
  assert.equal(containsOrigin(everything), false);
  assert.equal(/google\.com\/maps\/dir|directionsUrl|destination_place_id/.test(everything), false);
  const state = (await v.state()).demo;
  assert.equal(containsOrigin(JSON.stringify(state)), false);
  assert.equal(Object.prototype.hasOwnProperty.call(state, 'liveLocation'), false);
  assert.equal(state.discoveryLocation, null);
  assert.equal(state.locationAttempted, false);
});

test('session snapshots keep only displayed route facts; payment, receipt and Vouch state keep none', async () => {
  tableMock(allDistances({ 'northside-wraps': W(100), 'spice-lane': W(160), 'vegan-zen-kitchen': W(200) }));
  const v = http.visitor();
  const { body } = await live(v);
  const card = body.recommendations.find(c => c.id === 'spice-lane');
  const batch = (await v.state()).demo.catalogueBatch.find(m => m.id === 'spice-lane');
  assert.deepEqual(batch.travel, { mode: 'live-walking', walkingMinutes: card.travel.walkingMinutes,
    walkingMetres: card.travel.walkingMetres, provider: 'Google Maps', warningRequired: true });
  assert.equal(batch.distanceMetres, null); assert.equal(batch.distanceMinutes, null); assert.equal(batch.distanceLabel, null);
  assert.equal((await v.request('/recommendation/accept', { merchantId: 'spice-lane' })).location, '/scan');
  await v.request('/scan');
  await v.request('/scan', { merchantId: 'spice-lane' });
  const scan = (await v.state()).demo.currentScanPayment;
  assert.deepEqual(scan.merchantSnapshot.travel, batch.travel);
  const paid = await v.request('/scan/payment', { journeyId: scan.id, amount: '8.00' });
  assert.match(paid.location, /^\/payment-success\/tx-/);
  const state = (await v.state()).demo;
  const tx = state.transactions[0];
  assert.equal(/travel|walking|Google|route/i.test(JSON.stringify(tx)), false);
  assert.equal((await v.request('/payment-success/' + tx.id)).status, 200);
  assert.equal((await v.request('/vouch/' + tx.id, { action: 'create' })).status, 302);
  assert.equal((await v.request('/vouch/' + tx.id + '/success')).status, 200);
  const after = (await v.state()).demo;
  assert.equal(/travel|walking|Google|route/i.test(JSON.stringify(after.paymentVerifiedVouches)), false);
  assert.equal(/travel|walking|Google|route/i.test(JSON.stringify(after.transactions)), false);
  // No database statement carries Google route content.
  assert.equal(/walking|google|route/i.test(JSON.stringify(db.calls)), false);
  assert.equal(db.feedbackRows.length, 0);
  // No reusable route cache exists on disk or in module state.
  assert.equal(fs.readdirSync(ROOT).some(file => /route-?cache/i.test(file)), false);
  assert.equal(/\bcache\b/i.test(fs.readFileSync(path.join(ROOT, 'walking-routes.js'), 'utf8').replace(/never cache[^\n]*|Nothing here persists or caches[^\n]*|No reusable[^\n]*/gi, '')), false);
});

test('Reset Demo clears the live travel snapshot', async () => {
  tableMock(allDistances({ 'northside-wraps': W(100) }));
  const v = http.visitor();
  await live(v);
  await v.request('/recommendation/accept', { merchantId: 'northside-wraps' });
  assert.ok((await v.state()).demo.selectedMerchantSnapshot.travel);
  assert.equal((await v.request('/reset-demo', {})).status, 302);
  const state = (await v.state()).demo;
  assert.deepEqual(state.catalogueBatch, []);
  assert.equal(state.selectedMerchantSnapshot, null);
  assert.equal(/walking|travel/.test(JSON.stringify(state)), false);
});

// ---------------------------------------------------------------------------
// Key separation and Home page
// ---------------------------------------------------------------------------
test('browser and server keys are separate and the Routes key never reaches the page', async () => {
  const v = http.visitor();
  const home = (await v.request('/home')).html;
  assert.ok(home.includes('data-maps-browser-key="' + BROWSER_KEY + '"'));
  assert.equal(home.split(BROWSER_KEY).length, 2, 'browser key appears exactly once, inside the location panel');
  assert.ok(home.indexOf(BROWSER_KEY) > home.indexOf('data-origin-panel') && home.indexOf(BROWSER_KEY) < home.indexOf('</section>', home.indexOf('data-origin-panel')));
  assert.equal(home.includes(ROUTES_KEY), false);
  delete process.env.GOOGLE_MAPS_BROWSER_API_KEY;
  const without = (await http.visitor().request('/home')).html;
  assert.equal(without.includes('data-maps-browser-key'), false);
  assert.match(without, /data-origin-panel/);
  const script = fs.readFileSync(path.join(ROOT, 'public/js/script.js'), 'utf8');
  assert.equal(/GOOGLE_ROUTES|routes\.googleapis|X-Goog-Api-Key/.test(script), false);
  const app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  assert.equal(/GOOGLE_MAPS_BROWSER_API_KEY/.test(app.replace("process.env.GOOGLE_MAPS_BROWSER_API_KEY || ''", '')), false);
  assert.equal(/GOOGLE_ROUTES_API_KEY/.test(app), false, 'only walking-routes.js touches the server key');
});

// ---------------------------------------------------------------------------
// Feedback, accept and Step 5 interaction
// ---------------------------------------------------------------------------
function seedPair() {
  db.merchants.clear();
  [['a-rejected', '8.00', 500, '1.440000', '103.780000'], ['b-penalised', '8.00', 600, '1.441000', '103.781000'],
    ['c-clean', '5.00', 100, '1.442000', '103.782000']].forEach(([id, price, metres, lat, lng]) => {
    db.seedMerchant(row({ merchant_id: id, name: id, typical_price: price, distance_metres: metres, latitude: lat, longitude: lng }));
  });
}

test('live requests keep exact exclusions and price learning but ignore RP-origin "Too far" similarity', async () => {
  seedPair();
  const v = http.visitor();
  const first = (await demo(v, '?budget=20&maxDistance=20&diningDate=2026-11-17&diningTime=12:00')).body.recommendations;
  const target = first.find(c => c.id === 'a-rejected');
  assert.equal((await v.request('/recommendation/reject', { merchantId: target.id, feedbackToken: target.feedbackToken,
    reason: 'too-far' }, { 'X-Requested-With': 'smart-match' })).status, 204);
  assert.equal(db.feedbackRows[0].distance_metres, 500, 'demo rejections still store the RP distance');
  // Live mode (no explicit maxDistance, so only the live origin itself can suppress the learned penalty):
  // b-penalised would lose 30 points if the RP-origin threshold (420 m) were applied to its 600 m estimate.
  // With walking distances (100 m vs 200 m) it is NOT penalised and ranks first. a-rejected stays excluded.
  tableMock({ 'a-rejected': W(50), 'b-penalised': W(100), 'c-clean': W(200) });
  const liveResult = (await live(v, { budget: 20, maxDistance: undefined })).body.recommendations;
  assert.deepEqual(liveResult.map(c => c.id), ['b-penalised', 'c-clean']);
});

test('price similarity learned earlier still penalises candidates in live mode', async () => {
  seedPair();
  const v = http.visitor();
  const first = (await demo(v, '?budget=20&maxDistance=20&diningDate=2026-11-17&diningTime=12:00')).body.recommendations;
  const target = first.find(c => c.id === 'a-rejected');
  await v.request('/recommendation/reject', { merchantId: target.id, feedbackToken: target.feedbackToken,
    reason: 'too-expensive' }, { 'X-Requested-With': 'smart-match' });
  tableMock({ 'a-rejected': W(50), 'b-penalised': W(100), 'c-clean': W(200) });
  // No explicit budget: an explicit budget would (by Step 4 design) suppress price similarity.
  const result = (await live(v, { budget: undefined, maxDistance: undefined })).body.recommendations;
  // b-penalised (8.00 >= 7.50) loses 30 points; c-clean (5.00) does not.
  assert.deepEqual(result.map(c => c.id), ['c-clean', 'b-penalised']);
});

test('live rejections persist NULL distances; exact exclusion applies to the next live request', async () => {
  tableMock(allDistances({ 'northside-wraps': W(100), 'spice-lane': W(160), 'vegan-zen-kitchen': W(200) }));
  const v = http.visitor();
  const cards = (await live(v)).body.recommendations;
  assert.ok(cards.length >= 2);
  const second = cards[1];
  const response = await v.request('/recommendation/reject', { merchantId: second.id, feedbackToken: second.feedbackToken,
    reason: 'too-far' }, { 'X-Requested-With': 'smart-match' });
  assert.equal(response.status, 204);
  assert.equal(db.feedbackRows.length, 1);
  assert.equal(db.feedbackRows[0].distance_metres, null);
  assert.equal(db.feedbackRows[0].distance_minutes, null);
  assert.equal(db.feedbackRows[0].merchant_id, second.id);
  assert.equal(containsOrigin(JSON.stringify(db.feedbackRows)), false);
  const next = (await live(v)).body.recommendations;
  assert.equal(next.some(c => c.id === second.id), false);
  // A later demo-origin request is not affected by any routed distance.
  const demoNext = (await demo(v)).body.recommendations;
  assert.equal(demoNext.some(c => c.id === second.id), false, 'exact exclusion still applies');
});

test('second and third cards accept, reject and reach Scan/payment/Vouch with the same shown facts', async () => {
  const table = allDistances({ 'northside-wraps': W(100), 'spice-lane': W(160), 'vegan-zen-kitchen': W(200) });
  tableMock(table);
  for (const index of [1, 2]) {
    resetMerchantCampaigns();
    const v = http.visitor();
    const cards = (await live(v)).body.recommendations;
    const card = cards[index];
    assert.ok(card, 'card ' + (index + 1));
    // The stored RP estimate would fail the 5 minute limit for these merchants; the walking time passes.
    assert.equal((await v.request('/recommendation/accept', { merchantId: card.id })).location, '/scan');
    await v.request('/scan');
    assert.equal((await v.request('/scan', { merchantId: card.id })).status, 302);
    const scan = (await v.state()).demo.currentScanPayment;
    assert.equal(scan.merchantId, card.id);
    assert.equal(scan.merchantSnapshot.travel.walkingMetres, card.travel.walkingMetres);
    assert.equal(scan.merchantSnapshot.travel.walkingMinutes, card.travel.walkingMinutes);
    const paid = await v.request('/scan/payment', { journeyId: scan.id, amount: '9.00' });
    assert.match(paid.location, /^\/payment-success\/tx-/);
    const tx = (await v.state()).demo.transactions[0];
    assert.equal(tx.merchantId, card.id);
    assert.equal((await v.request('/vouch/' + tx.id, { action: 'create' })).status, 302);
    assert.equal(routeCalls.length, 1, 'no second Routes call during the journey');
    routeCalls.length = 0;
  }
  // A tampered or stale token is still rejected.
  const v = http.visitor();
  const cards = (await live(v)).body.recommendations;
  const bad = await v.request('/recommendation/reject', { merchantId: cards[0].id, feedbackToken: cards[1].feedbackToken, reason: 'too-far' });
  assert.equal(bad.status, 409);
});

test('the Scan page shows retained walking facts with attribution and warning, and no directions link', async () => {
  tableMock(allDistances({ 'northside-wraps': W(100), 'spice-lane': W(160), 'vegan-zen-kitchen': W(200) }));
  const v = http.visitor();
  const cards = (await live(v)).body.recommendations;
  await v.request('/recommendation/accept', { merchantId: cards[0].id });
  const page = (await v.request('/scan')).html;
  assert.match(page, /data-google-route/);
  assert.match(page, /About \d+ min walk · \d+ m/);
  assert.equal((page.match(/translate="no">Google Maps<\/span>/g) || []).length >= 1, true);
  assert.ok(page.includes(routes.WALKING_WARNING));
  assert.equal(/maps\/dir|data-directions|Open walking directions|Destination is a fictional/.test(page), false);
  assert.equal(containsOrigin(page), false);
});

test('Step 5 natural-language requests accept an optional location and never send it to the model', async () => {
  const intent = { budgetMax: 10, distance: 'nearby', cuisine: null, dietary: null, dayRef: null, time: '12:00', mealPeriod: null, unsupported: ['light'] };
  mockGoogle(body => ({ json: matrixFor(body, allDistances({ 'northside-wraps': W(100), 'spice-lane': W(160) }), {}) }), () => intent);
  const v = http.visitor();
  const response = await v.request('/api/recommend/natural', { text: 'Something light nearby under $10', location: ORIGIN });
  const body = JSON.parse(response.html);
  assert.equal(response.status, 200);
  assert.equal(otherCalls.length, 1);
  const sent = JSON.stringify(otherCalls[0].body);
  assert.equal(containsOrigin(sent), false);
  assert.equal(/Google Maps|latitude|longitude/.test(sent), false);
  assert.equal(routeCalls.length, 1);
  assert.equal(body.metadata.distance.basis, 'google-walking-route');
  assert.ok(body.recommendations.every(c => c.travel && c.distanceMetres === null && c.price <= 10));
  assert.ok(body.interpretation.understood.some(chip => chip.field === 'distance' && /min walking \(Google Maps route\)/.test(chip.value)));
  assert.equal(body.interpretation.resolved.routed, true);
  assert.equal(containsOrigin(response.html), false);
  // Same three-card authorisation batch as the other routes.
  const state = (await v.state()).demo;
  assert.deepEqual(state.lastApiRecommendations, body.recommendations.map(c => c.id));
  assert.deepEqual(state.catalogueBatch.map(c => c.feedbackToken), body.recommendations.map(c => c.feedbackToken));
  // Without a location the Step 5 behaviour is unchanged.
  mockGoogle(() => ({ json: [] }), () => intent);
  const plain = JSON.parse((await http.visitor().request('/api/recommend/natural', { text: 'Something light nearby under $10' })).html);
  assert.equal(routeCalls.length, 0);
  assert.equal(plain.metadata.distance.basis, 'demo-origin-estimate');
});

test('natural-language location failures keep the batch and stop before any provider call', async () => {
  const intent = { budgetMax: 10, distance: null, cuisine: null, dietary: null, dayRef: null, time: null, mealPeriod: null, unsupported: [] };
  mockGoogle(() => ({ status: 500 }), () => intent);
  const v = http.visitor();
  await demo(v);
  const before = await batchOf(v);
  const invalid = await v.request('/api/recommend/natural', { text: 'under $10', location: { latitude: 5, longitude: 103.8 } });
  assert.equal(invalid.status, 400);
  assert.deepEqual(JSON.parse(invalid.html), { error: { code: 'invalid-recommendation-input', fields: { location: 'outside-singapore' } } });
  assert.equal(otherCalls.length + routeCalls.length, 0);
  const failed = await v.request('/api/recommend/natural', { text: 'under $10', location: ORIGIN });
  assert.equal(failed.status, 502);
  assert.equal(JSON.parse(failed.html).error.code, 'walking-routes-provider-failure');
  assert.equal(await batchOf(v), before);
  assert.equal(containsOrigin(failed.html), false);
  delete process.env.GOOGLE_ROUTES_API_KEY;
  otherCalls.length = 0;
  const missing = await v.request('/api/recommend/natural', { text: 'under $10', location: ORIGIN });
  assert.equal(missing.status, 503);
  assert.equal(JSON.parse(missing.html).error.code, 'walking-routes-not-configured');
  assert.equal(otherCalls.length, 0, 'the model is not called when walking routes cannot run');
});

// ---------------------------------------------------------------------------
// Browser behaviour (DOM stubs) and presentation structure
// ---------------------------------------------------------------------------
const script = fs.readFileSync(path.join(ROOT, 'public/js/script.js'), 'utf8');
function clientApi(navigator) {
  const sandbox = { document: { createElement: tag => {
    const node = { tag, attrs: {}, children: [], textContent: '', className: '' };
    node.setAttribute = (name, value) => { node.attrs[name] = value; };
    node.getAttribute = name => node.attrs[name];
    node.appendChild = child => { node.children.push(child); return child; };
    Object.defineProperty(node, 'textContent', { get: () => node._text || '', set: value => { node._text = String(value); if (value === '') node.children.length = 0; } });
    return node;
  } }, navigator, URL, URLSearchParams, console: { info() {} }, window: {}, Number, String, Math, Array, Map };
  vm.createContext(sandbox);
  vm.runInContext(script.slice(script.indexOf('function escHtml('), script.indexOf('async function loadMatch(')) +
    '\nthis.api = { renderGoogleRoute, buildDirectionsUrl, attachDirectionLinks, clearDirectionLinks, requestLiveOrigin, renderRecCard };', sandbox);
  return sandbox.api;
}
const geolocation = result => ({ geolocation: { getCurrentPosition: (ok, fail, options) => { geolocation.options = options; result(ok, fail); } } });

test('device geolocation: 150 m accepted, 151 m rejected, failures have distinct reasons, user initiated only', async () => {
  const plain = value => JSON.parse(JSON.stringify(value));
  const run = async result => plain(await clientApi(geolocation(result)).requestLiveOrigin());
  const at = accuracy => (ok) => ok({ coords: { latitude: 1.3, longitude: 103.8, accuracy } });
  assert.deepEqual(await run(at(150)), { ok: true, location: { latitude: 1.3, longitude: 103.8 } });
  assert.deepEqual(await run(at(151)), { ok: false, reason: 'inaccurate' });
  assert.deepEqual(await run(at(undefined)), { ok: false, reason: 'inaccurate' });
  assert.deepEqual(await run(at(NaN)), { ok: false, reason: 'inaccurate' });
  assert.deepEqual(await run((ok, fail) => fail({ code: 1 })), { ok: false, reason: 'denied' });
  assert.deepEqual(await run((ok, fail) => fail({ code: 2 })), { ok: false, reason: 'unavailable' });
  assert.deepEqual(await run((ok, fail) => fail({ code: 3 })), { ok: false, reason: 'timeout' });
  assert.deepEqual(plain(await clientApi({}).requestLiveOrigin()), { ok: false, reason: 'unsupported' });
  assert.deepEqual(plain(geolocation.options), { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 });
  // Geolocation is requested only inside the button handler, never at load.
  const section = script.slice(script.indexOf('const originModule = '));
  assert.equal((script.match(/getCurrentPosition\(/g) || []).length, 1, 'the only geolocation call is the user-triggered live one');
  assert.match(section, /panel\.querySelector\('\[data-origin-device\]'\)\.addEventListener\('click', useDevice\)/);
  assert.equal((script.match(/requestLiveOrigin\(/g) || []).length, 2, 'one definition and one call');
  assert.match(section, /async function useDevice\(\) \{[\s\S]*?await requestLiveOrigin\(\);/);
});

test('directions link is built only in the browser, only with an origin, and is removed when cleared', () => {
  const api = clientApi({});
  const url = new URL(api.buildDirectionsUrl(ORIGIN, { latitude: 1.4428, longitude: 103.7854 }));
  assert.equal(url.origin + url.pathname, 'https://www.google.com/maps/dir/');
  assert.deepEqual([...url.searchParams.keys()], ['api', 'origin', 'destination', 'travelmode']);
  assert.equal(url.searchParams.get('api'), '1');
  assert.equal(url.searchParams.get('origin'), '1.3012345,103.8123456');
  assert.equal(url.searchParams.get('destination'), '1.4428,103.7854');
  assert.equal(url.searchParams.get('travelmode'), 'walking');
  assert.ok(url.href.includes('%2C'));
  assert.equal(url.href.includes('destination_place_id'), false);

  const makeSlot = id => { const slot = { attrs: { 'data-directions-slot': id }, children: [], _text: '' };
    slot.getAttribute = name => slot.attrs[name]; slot.appendChild = child => { slot.children.push(child); return child; };
    Object.defineProperty(slot, 'textContent', { get: () => slot._text, set: value => { slot._text = String(value); if (value === '') slot.children.length = 0; } });
    return slot; };
  const slots = [makeSlot('a'), makeSlot('unknown')];
  const destinations = new Map([['a', { latitude: 1.4428, longitude: 103.7854 }]]);
  api.attachDirectionLinks(slots, null, destinations);
  assert.equal(slots[0].children.length, 0, 'no origin, no link');
  api.attachDirectionLinks(slots, ORIGIN, destinations);
  const [link, note] = slots[0].children;
  assert.equal(link.rel, 'noopener noreferrer');
  assert.equal(link.target, '_blank');
  assert.equal(link.textContent, 'Open walking directions');
  assert.ok(link.href.startsWith('https://www.google.com/maps/dir/?api=1&origin=1.3012345%2C103.8123456'));
  assert.equal(note.textContent, 'Destination is a fictional sample merchant coordinate.');
  assert.equal(slots[1].children.length, 0, 'unknown destinations get no link');
  api.clearDirectionLinks(slots);
  assert.equal(slots[0].children.length, 0);
  assert.equal(slots[0].textContent, '');

  // The server and templates never build a directions URL.
  const app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  const live = fs.readFileSync(path.join(ROOT, 'walking-routes.js'), 'utf8');
  assert.equal(/maps\/dir|directionsUrl/.test(live), false);
  assert.equal(/directionsUrl/.test(app), false);
  assert.equal(/maps\/dir/.test(fs.readFileSync(path.join(ROOT, 'views/partials/google-walking.ejs'), 'utf8')), false);
  assert.equal((script.match(/https:\/\/www\.google\.com\/maps\/dir\//g) || []).length, 1);
});

test('the origin lives only in browser memory: no storage, URLs, attributes or logs', () => {
  const start = script.indexOf('function requestLiveOrigin');
  const section = script.slice(start, script.indexOf('async function loadMatch(')) +
    script.slice(script.indexOf('const originModule = '), script.indexOf('// Natural-language request (Jolene Step 5)'));
  assert.equal(/localStorage|sessionStorage|indexedDB|document\.cookie|history\.(push|replace)State|location\.(href|search|hash)/.test(section), false);
  assert.equal(/console\./.test(section), false);
  assert.equal(/smartMatchDebug/.test(section), false);
  assert.equal(/\/smart-match\/location/.test(section), false);
  assert.equal(/setAttribute\([^)]*(origin|latitude|longitude)/i.test(section), false);
  assert.equal(/dataset\.[a-z]*(origin|lat|lng)/i.test(section), false);
  // Our own endpoints are called by POST with a JSON body, never with coordinates in the URL.
  assert.equal(/lat=|lng=|latitude=|longitude=|[?&]origin=/.test(script.replace(/url\.searchParams\.set\('origin'[^\n]*\n/, '')), false);
  assert.match(script, /fetch\('\/api\/recommend\/live', \{ method: 'POST'/);
  assert.match(script, /fetch\('\/api\/recommend\/natural', \{ method: 'POST'/);
  // It is cleared on errors and when switching to the RP demo origin.
  assert.match(section, /function failed\(body\) \{[\s\S]*?clear\(\);/);
  assert.match(section, /demoButton\.addEventListener\('click', function\(\) \{\s*clear\(\);/);
  assert.match(section, /function clear\(\) \{\s*origin = null;[\s\S]*?clearDirectionLinks\(slots\(\)\);/);
  // Place search: Singapore only, only location and displayName requested, Google's widget left intact.
  assert.match(section, /includedRegionCodes = \['sg'\]/);
  assert.match(section, /fetchFields\(\{ fields: \['location', 'displayName'\] \}\)/);
  assert.equal(/\.(innerHTML|outerHTML|insertAdjacentHTML)\b/.test(section.replace('matchRegion.innerHTML = renderRecommendationList(', 'matchRegion.RENDER(')), false);
});

test('Google route block: facts, then attribution "Google Maps" with translate="no", then the warning, in one container', async () => {
  const api = clientApi({});
  const travel = { walkingMinutes: 7, walkingMetres: 520, warning: routes.WALKING_WARNING };
  const html = api.renderGoogleRoute(travel, 'm"1');
  const ejsHtml = await ejs.renderFile(path.join(ROOT, 'views/partials/google-walking.ejs'),
    { travel, walkingWarning: routes.WALKING_WARNING });
  for (const markup of [html, ejsHtml]) {
    assert.equal((markup.match(/translate="no">Google Maps<\/span>/g) || []).length, 1);
    assert.equal(markup.includes('Google maps') || markup.includes('google maps'), false);
    const container = markup.indexOf('data-google-route');
    const facts = markup.indexOf('google-route__facts');
    const attribution = markup.indexOf('google-route__attribution');
    const warning = markup.indexOf('google-route__warning');
    assert.ok(container >= 0 && container < facts && facts < attribution && attribution < warning);
    assert.ok(markup.includes(routes.WALKING_WARNING));
    assert.match(markup, /About 7 min walk · 520 m/);
    assert.equal(/hidden|display:\s*none|aria-hidden/.test(markup), false);
    assert.equal((markup.match(/<span class="google-route"/g) || []).length, 1);
  }
  assert.equal(html.includes('"m"1'), false, 'merchant id is escaped');
  assert.equal(api.renderGoogleRoute({ walkingMinutes: 7, walkingMetres: 520 }, 'x'), '', 'no route facts without the warning');
  assert.equal(api.renderGoogleRoute(null, 'x'), '');
  assert.equal(routes.WALKING_WARNING, 'Walking routes are in beta and may be missing clear sidewalks or pedestrian paths. Use caution.');
  // A live card renders the route block, keeps fictional merchant facts outside it and shows no RP estimate.
  const card = api.renderRecCard({ id: 'x', merchantName: 'N', price: 5, source: 'mysql', isSampleData: true,
    distanceLabel: null, dietary: [], feedbackToken: 't', travel, usualActivity: null, matchReasons: [] });
  assert.ok(card.indexOf('Sample catalogue data') < card.indexOf('data-google-route'));
  assert.equal(/demo origin|catalogue estimate|not routed/.test(card), false);
  // Demo cards keep their label and show no Google content.
  const demoCard = api.renderRecCard({ id: 'x', merchantName: 'N', price: 5, source: 'mysql', isSampleData: true,
    distanceLabel: 'Approx. 150 m from demo origin (catalogue estimate)', dietary: [], feedbackToken: 't', usualActivity: null, matchReasons: [] });
  assert.match(demoCard, /from demo origin \(catalogue estimate\)/);
  assert.equal(/Google Maps|data-google-route/.test(demoCard), false);
});

test('attribution and panel styling are compliant, visible and mobile-safe', () => {
  const css = fs.readFileSync(path.join(ROOT, 'public/css/style.css'), 'utf8');
  const rule = selector => { const m = css.match(new RegExp('(?:^|\\n)' + selector.replace(/[.[\]]/g, '\\$&') + '\\s*\\{([^}]*)\\}')); assert.ok(m, selector); return m[1]; };
  const attribution = rule('.google-route__attribution');
  assert.match(attribution, /font-size:\s*13px/);
  assert.match(attribution, /font-weight:\s*400/);
  assert.match(attribution, /font-style:\s*normal/);
  assert.match(attribution, /letter-spacing:\s*normal/);
  assert.match(attribution, /font-family:\s*Roboto,\s*Arial,\s*sans-serif/);
  assert.match(attribution, /color:\s*#5E5E5E/);
  assert.match(attribution, /white-space:\s*nowrap/);
  assert.equal(/display:\s*none|visibility|opacity|clip|overflow:\s*hidden|text-indent|font-size:\s*0|height:\s*0|transform|filter/.test(attribution), false);
  assert.match(rule('.google-route'), /border:\s*1px solid/);
  assert.match(rule('.google-route'), /background:\s*#ffffff/);
  assert.equal(/opacity|visibility|display:\s*none|overflow:\s*hidden/.test(rule('.google-route')), false);
  // Google's own Autocomplete attribution is never hidden or restyled.
  const widget = css.split('\n').map(line => line.trim()).filter(line => /gmp-place-autocomplete|::part|gmp-/.test(line));
  assert.deepEqual(widget, ['.origin-search gmp-place-autocomplete { display:block; width:100%; }']);
  // Touch targets and narrow-width layout.
  assert.match(rule('.origin-actions .button'), /min-height:\s*44px/);
  assert.match(css, /@media \(max-width:420px\) \{ \.origin-actions \{ grid-template-columns:1fr; \} \}/);
  assert.match(rule('.google-route__directions a'), /min-height:\s*44px/);
  const home = fs.readFileSync(path.join(ROOT, 'views/home.ejs'), 'utf8');
  const panel = home.slice(home.indexOf('data-origin-panel'), home.indexOf('</section>', home.indexOf('data-origin-panel')));
  assert.match(panel, /aria-labelledby="origin-title"/);
  assert.match(panel, /data-origin-status role="status" aria-live="polite"/);
  assert.match(panel, /Your location is used only in this browser tab/);
  assert.match(panel, /sent to our server for that request and to Google Maps/);
  assert.match(panel, /<button class="button" type="button" data-origin-device>Use my location<\/button>/);
  assert.match(panel, /<button class="button" type="button" data-origin-place>Search for a place<\/button>/);
  assert.match(panel, /data-origin-demo hidden>Use RP demo origin/);
  assert.equal(/<%-/.test(panel), false);
});

test('the Home page labels the RP demo origin by default and renders no coordinates', async () => {
  const home = (await http.visitor().request('/home')).html;
  assert.match(home, /RP demo origin: estimated distances, not routed walking times\./);
  assert.equal(containsOrigin(home), false);
  assert.equal(/localStorage|sessionStorage/.test(home), false);
});

// ---------------------------------------------------------------------------
// Privacy cleanup: the legacy session-coordinate route is disabled
// ---------------------------------------------------------------------------
test('POST /smart-match/location is disabled: it cannot store coordinates or mutate the session', async () => {
  const v = http.visitor();
  await v.request('/home');
  const before = JSON.stringify((await v.state()).demo);
  assert.equal((await v.state()).demo.discoveryLocation, null);
  db.calls.length = 0;
  captureOutput();
  const bodies = [{ latitude: ORIGIN.latitude, longitude: ORIGIN.longitude }, { status: 'fallback' },
    { latitude: 'x', longitude: 200 }, {}, { latitude: 1.3, longitude: 103.8, extra: [1, 2, 3] }];
  const responses = [];
  for (const body of bodies) responses.push(await v.request('/smart-match/location', body));
  responses.push(await v.rawPost('/smart-match/location', '{"latitude":' + ORIGIN.latitude + ',"longitude":103.8123456'));
  restoreCapture();
  responses.slice(0, bodies.length).forEach(response => {
    assert.equal(response.status, 410);
    assert.deepEqual(JSON.parse(response.html), { error: { code: 'smart-match-location-disabled' } });
  });
  assert.equal(responses[bodies.length].status, 400, 'a malformed body never reaches the handler');
  assert.equal(captured.length, 0, 'nothing is logged');
  assert.equal(db.calls.length, 0);
  const after = (await v.state()).demo;
  assert.equal(JSON.stringify(after), before, 'the session is not mutated');
  assert.equal(after.discoveryLocation, null);
  assert.equal(after.locationAttempted, false);
  assert.equal(containsOrigin(JSON.stringify(await v.state())), false);
  // A fresh session behaves the same way, and the Home page still reports no location.
  const fresh = http.visitor();
  assert.equal((await fresh.request('/smart-match/location', ORIGIN)).status, 410);
  const home = (await fresh.request('/home')).html;
  assert.match(home, /data-location-ready="false"/);
  assert.equal((await fresh.state()).demo.discoveryLocation, null);

  // The handler reads no request field, and no browser code calls the route or its retired helpers.
  const app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  const start = app.indexOf("app.post('/smart-match/location'");
  const handler = app.slice(start, app.indexOf('});', start) + 3);
  assert.equal(/req\.|demo|locationCache|logDiscovery|discoveryLocation/.test(handler.replace(/^app\.post\('\/smart-match\/location', function\(req, res\) \{/, '')), false, handler);
  assert.match(handler, /res\.status\(410\)\.json\(\{ error: \{ code: 'smart-match-location-disabled' \} \}\)/);
  const script = fs.readFileSync(path.join(ROOT, 'public/js/script.js'), 'utf8');
  for (const dead of ['/smart-match/location', 'requestCurrentPosition', 'prepareDiscoveryLocation', 'renderLocationNeeded',
    'useDemoLocation', 'data-retry-location', 'data-use-demo-location']) {
    assert.equal(script.includes(dead), false, dead);
  }
  for (const file of fs.readdirSync(path.join(ROOT, 'views'), { recursive: true }).filter(name => name.endsWith('.ejs'))) {
    assert.equal(/smart-match\/location|data-retry-location|data-use-demo-location/.test(
      fs.readFileSync(path.join(ROOT, 'views', file), 'utf8')), false, file);
  }
});

// ---------------------------------------------------------------------------
// Privacy closure: no GET route accepts, caches or redirects with a precise location
// ---------------------------------------------------------------------------
test('GET /smart-match/result refuses every coordinate parameter and changes nothing', async () => {
  const outbound = [];
  global.fetch = async url => { outbound.push(String(url)); throw new Error('no outbound call expected'); };
  delete process.env.GROQ_API_KEY; // the legacy ranking path would otherwise try its own provider
  const v = http.visitor();
  await v.request('/home');
  const before = JSON.stringify((await v.state()).demo);
  db.calls.length = 0;
  captureOutput();
  const queries = ['?lat=1.234&lng=103.876', '?lat=1.234', '?lng=103.876', '?latitude=1.234&longitude=103.876',
    '?lat=abc&lng=', '?lat=1.234&lat=1.5&lng=103.876', '?lat[]=1.234&lng[]=103.876', '?LAT=1.234&Lng=103.876'];
  const responses = [];
  for (const query of queries) responses.push(await v.request('/smart-match/result' + query));
  restoreCapture();
  responses.forEach((response, index) => {
    assert.equal(response.status, 400, queries[index]);
    assert.deepEqual(JSON.parse(response.html), { error: { code: 'smart-match-coordinates-not-accepted' } });
    assert.equal(response.location, null, 'no redirect or Location header');
    assert.equal(/1\.234|103\.876/.test(response.html), false, 'values are never echoed');
  });
  assert.equal(captured.length, 0, captured.join('|').slice(0, 300));
  assert.equal(db.calls.length, 0, 'no database call');
  assert.deepEqual(outbound, [], 'no provider call');
  const after = (await v.state()).demo;
  assert.equal(JSON.stringify(after), before, 'the session is unchanged');
  assert.equal(after.discoveryLocation, null);
  assert.equal(after.locationAttempted, false);
  // Nothing was cached: a later request without coordinates still has no location.
  const follow = await v.request('/smart-match/result');
  assert.equal(follow.status, 200);
  assert.equal((await v.state()).demo.discoveryLocation, null);
  assert.equal(outbound.length, 0);
});

test('the retained no-location and noscript journeys behave honestly without a live location', async () => {
  global.fetch = async () => { throw new Error('no outbound call expected'); };
  delete process.env.GROQ_API_KEY;
  const v = http.visitor();
  const result = await v.request('/smart-match/result');
  assert.equal(result.status, 200);
  assert.match(result.html, /Using demo location/);
  assert.equal(containsOrigin(result.html), false);
  const staticResult = await http.visitor().request('/smart-match/static');
  assert.equal(staticResult.status, 302);
  assert.equal(staticResult.location, '/home');
  const noscript = http.visitor();
  await noscript.request('/smart-match/static');
  const demoState = (await noscript.state()).demo;
  assert.equal(demoState.discoveryLocation, null);
  assert.equal(demoState.locationAttempted, false);
  assert.equal(demoState.nearbySource, 'local-fallback');
  assert.equal(demoState.nearbyDemoFallback, false, 'a demo recommendation never pretends to be live');
  const home = (await noscript.request('/home')).html;
  assert.match(home, /data-location-ready="false"/);
  // The noscript link itself carries no query string at all.
  assert.match(fs.readFileSync(path.join(ROOT, 'views/home.ejs'), 'utf8'), /<noscript><a class="button" href="\/smart-match\/static">Find my match<\/a><\/noscript>/);
});

test('catalogue merchants get no map pin and no server-rendered directions link on Home', async () => {
  tableMock(allDistances({ 'northside-wraps': W(100), 'spice-lane': W(160) }));
  for (const mode of ['live', 'demo']) {
    resetMerchantCampaigns();
    const v = http.visitor();
    const cards = mode === 'live' ? (await live(v)).body.recommendations : (await demo(v)).body.recommendations;
    assert.equal((await v.request('/recommendation/accept', { merchantId: cards[0].id })).location, '/scan');
    const home = (await v.request('/home')).html;
    assert.equal(/maps\/dir|match-map|match-map-open|data-lat|data-lng|Open in Google Maps/.test(home), false, mode);
    assert.equal(containsOrigin(home), false);
    const scan = (await v.request('/scan')).html;
    assert.equal(/maps\/dir|match-map|data-lat|data-lng/.test(scan), false, mode);
  }
});

test('no GET endpoint or redirect can carry precise coordinates (source search)', () => {
  const app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  const script = fs.readFileSync(path.join(ROOT, 'public/js/script.js'), 'utf8');
  const walking = fs.readFileSync(path.join(ROOT, 'walking-routes.js'), 'utf8');
  // The coordinate cache and every read of lat/lng query values are gone.
  assert.equal(/locationCache/.test(app), false);
  assert.equal(/req\.query\.(lat|lng|latitude|longitude)\b/.test(app), false);
  assert.equal(/req\.(body|query)\.(lat|lng|latitude|longitude)\b/.test(app), false);
  assert.equal(/res\.redirect\([^)]*(lat|lng|latitude|longitude|discoveryLocation|origin)/i.test(app), false);
  assert.equal(/res\.(set|setHeader|location)\([^)]*(lat|lng|latitude|longitude|discoveryLocation|origin)/i.test(app), false);
  // Query strings with coordinates in our own URLs: none. The only coordinate-bearing URLs are the two
  // outbound Foursquare ones (a fixed health-check point and the legacy discovery origin, never ours)...
  assert.deepEqual(app.split('\n').filter(line => /searchParams\.set\('(ll|lat|lng|latitude|longitude)'/.test(line)).map(line => line.trim()), [
    "url.searchParams.set('ll', searchLocation.latitude + ',' + searchLocation.longitude);",
    "pingUrl.searchParams.set('ll', '1.3521,103.8198');"
  ]);
  assert.equal(/[?&](lat|lng|latitude|longitude)=/.test(app + walking), false);
  // ...and, in the browser, the one user-triggered Google Maps directions link.
  assert.equal(/[?&](lat|lng|latitude|longitude)=/.test(script), false);
  assert.deepEqual(script.split('\n').filter(line => /searchParams\.set\('(origin|destination|ll|lat|lng)'/.test(line)).map(line => line.trim()), [
    "url.searchParams.set('origin', origin.latitude + ',' + origin.longitude);",
    "url.searchParams.set('destination', destination.latitude + ',' + destination.longitude);"
  ]);
  // Nothing in the application assigns a coordinate to the session location.
  assert.deepEqual(app.split(String.fromCharCode(10)).filter(line => /discoveryLocation\s*=[^=]/.test(line)), []);
});
