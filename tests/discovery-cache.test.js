const test = require('node:test');
const assert = require('node:assert/strict');
const { app, getNearbyMerchants, clearDiscoveryCache, resetMerchantCampaigns } = require('../app');

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
const originalAIKey = process.env.OPENAI_API_KEY;
const location = { latitude: 1.4501, longitude: 103.8201 };
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
  clearDiscoveryCache();
  resetMerchantCampaigns();
  process.env.FOURSQUARE_API_KEY = 'test-key';
  delete process.env.OPENAI_API_KEY;
  global.fetch = realFetch;
});
test.afterEach(function() {
  global.fetch = realFetch;
  if (originalKey === undefined) delete process.env.FOURSQUARE_API_KEY;
  else process.env.FOURSQUARE_API_KEY = originalKey;
  if (originalAIKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalAIKey;
});

function place(id, distance) {
  return { fsq_place_id: id, name: 'Merchant ' + id, latitude: 1.4502, longitude: 103.8202,
    distance: distance, categories: [{ name: 'Restaurant' }],
    location: { formatted_address: 'Canberra, Singapore' } };
}

function mockPlaces(resultsByQuery) {
  const queries = [];
  global.fetch = async function(url) {
    const requestUrl = new URL(String(url));
    assert.equal(requestUrl.hostname, 'places-api.foursquare.com');
    const query = requestUrl.searchParams.get('query');
    queries.push(query);
    const results = resultsByQuery[query] || resultsByQuery.food || [];
    return { ok: true, json: async function() { return { results: results }; } };
  };
  return queries;
}

function visitor() {
  let cookie = '';
  return { async request(path, body) {
    const response = await realFetch(base + path, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'manual',
      headers: { Cookie: cookie, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const header = response.headers.get('set-cookie');
    if (header) cookie = header.split(';')[0];
    return { status: response.status, html: await response.text() };
  } };
}

function merchantId(html) {
  const match = html.match(/data-merchant-id="([^"]+)"/);
  return match ? match[1] : null;
}

test('first discovery misses and second same-location/query discovery hits', async function() {
  const queries = mockPlaces({ food: [place('a', 100)] });
  const first = await getNearbyMerchants(location, 'jia', '');
  const second = await getNearbyMerchants(location, 'darren', 'anything');
  assert.equal(first.source, 'foursquare');
  assert.equal(second.merchants[0].id, first.merchants[0].id);
  assert.deepEqual(queries, ['food']);
});

test('nearby coordinates share a bucket but receive their own distance values', async function() {
  const queries = mockPlaces({ food: [place('a', 100)] });
  const first = await getNearbyMerchants(location, 'jia', '');
  const second = await getNearbyMerchants({ latitude: 1.4502, longitude: 103.8202 }, 'darren', '');
  assert.equal(queries.length, 1);
  assert.equal(first.merchants[0].distanceMetres, 100);
  assert.equal(second.merchants[0].distanceMetres, 0);
  assert.equal(first.merchants[0].distanceMetres, 100);
});

test('materially different locations use separate cache entries', async function() {
  const queries = mockPlaces({ food: [place('a', 100)] });
  await getNearbyMerchants(location, 'jia', '');
  await getNearbyMerchants({ latitude: 1.3526, longitude: 103.9448 }, 'darren', '');
  assert.deepEqual(queries, ['food', 'food']);
});

test('different cravings at one location use separate query entries', async function() {
  const five = ['a', 'b', 'c', 'd', 'e'].map(function(id) { return place(id, 100); });
  const queries = mockPlaces({ bread: five, sushi: five });
  await getNearbyMerchants(location, 'jia', 'bread');
  await getNearbyMerchants(location, 'darren', 'sushi');
  await getNearbyMerchants(location, 'jia', 'bread');
  assert.deepEqual(queries, ['bread', 'sushi']);
});

test('a cache entry expires after 15 minutes and refreshes once', async function() {
  const queries = mockPlaces({ food: [place('a', 100)] });
  const originalNow = Date.now;
  let now = 1000000;
  Date.now = function() { return now; };
  try {
    await getNearbyMerchants(location, 'jia', '');
    now += 15 * 60 * 1000 - 1;
    await getNearbyMerchants(location, 'darren', '');
    assert.equal(queries.length, 1);
    now += 1;
    await getNearbyMerchants(location, 'jia', '');
    assert.equal(queries.length, 2);
  } finally {
    Date.now = originalNow;
  }
});

test('cached nested merchant data cannot be mutated by another caller', async function() {
  const queries = mockPlaces({ food: [place('a', 100)] });
  const first = await getNearbyMerchants(location, 'jia', '');
  first.merchants[0].coordinates.latitude = 0;
  first.merchants[0].dietary.push('invented');
  first.merchants[0].merchantName = 'Changed';
  const second = await getNearbyMerchants(location, 'darren', '');
  assert.equal(queries.length, 1);
  assert.equal(second.merchants[0].coordinates.latitude, 1.4502);
  assert.deepEqual(second.merchants[0].dietary, []);
  assert.equal(second.merchants[0].merchantName, 'Merchant a');
});

test('two sessions share discovery but keep shown and rejected state independent', async function() {
  const queries = mockPlaces({ food: [place('a', 100), place('b', 200)] });
  const jia = visitor();
  const darren = visitor();
  await jia.request('/smart-match/location', location);
  await darren.request('/smart-match/location', location);
  const first = merchantId((await jia.request('/smart-match/result')).html);
  assert.equal(first, 'foursquare-a');
  await jia.request('/recommendation/reject', { merchantId: first, reason: 'not-in-mood' });
  const second = merchantId((await jia.request('/smart-match/result')).html);
  assert.equal(second, 'foursquare-b');
  assert.equal(merchantId((await darren.request('/smart-match/result')).html), first);
  assert.equal(queries.length, 1, 'Not for me and the second session must not call Foursquare again');
});

test('craving-specific and broad fallback searches are cached independently', async function() {
  const queries = mockPlaces({ bread: [place('bread', 100)], food: [place('food', 200)] });
  await getNearbyMerchants(location, 'jia', 'bread');
  await getNearbyMerchants(location, 'darren', 'bread');
  assert.deepEqual(queries, ['bread', 'food']);
});

test('lazy cleanup removes expired entries without evicting a still-valid query', async function() {
  const five = ['a', 'b', 'c', 'd', 'e'].map(function(id) { return place(id, 100); });
  const queries = mockPlaces({ bread: five, sushi: five });
  const originalNow = Date.now;
  let now = 1000000;
  Date.now = function() { return now; };
  try {
    await getNearbyMerchants(location, 'jia', 'bread');
    now += 5 * 60 * 1000;
    await getNearbyMerchants(location, 'jia', 'sushi');
    now += 10 * 60 * 1000;
    await getNearbyMerchants(location, 'darren', 'sushi');
    assert.deepEqual(queries, ['bread', 'sushi']);
    await getNearbyMerchants(location, 'darren', 'bread');
    assert.deepEqual(queries, ['bread', 'sushi', 'bread']);
  } finally {
    Date.now = originalNow;
  }
});

// ---------------------------------------------------------------------------
// Search radius is part of the cache identity
// ---------------------------------------------------------------------------
// A Foursquare result set is only valid for the radius it was searched with. A short walking limit
// returns nothing beyond that limit, so its result set can never answer a later, wider request.

// A fixture merchant placed at a real offset north of `location`, so the distance the app computes
// from its coordinates matches the distance the mocked provider filters on. ~0.001 degrees of
// latitude is ~111 m near Singapore.
function placeAtMetres(id, metres) {
  const latitude = location.latitude + metres / 111320;
  return { fsq_place_id: id, name: 'Merchant ' + id, latitude: latitude, longitude: location.longitude,
    geocodes: { main: { latitude: latitude, longitude: location.longitude } },
    distance: metres, categories: [{ name: 'Restaurant' }],
    location: { formatted_address: 'Canberra, Singapore' } };
}

// Records the radius sent with each call alongside the query, and answers from a distance-aware
// fixture so a too-narrow search genuinely cannot see the far merchant.
function mockPlacesByRadius(placesWithDistance) {
  const calls = [];
  global.fetch = async function(url) {
    const requestUrl = new URL(String(url));
    assert.equal(requestUrl.hostname, 'places-api.foursquare.com');
    const radius = Number(requestUrl.searchParams.get('radius'));
    const query = requestUrl.searchParams.get('query');
    calls.push({ radius: radius, query: query });
    // A provider only returns what is inside the radius it was asked for.
    const results = placesWithDistance.filter(function(p) { return p.distance <= radius; });
    return { ok: true, json: async function() { return { results: results }; } };
  };
  return calls;
}

test('a wider walking limit cannot be answered from a narrower cached search', async function() {
  const near = placeAtMetres('near', 300);
  const far = placeAtMetres('far', 900);
  const calls = mockPlacesByRadius([near, far]);

  // 5 minutes ≈ 400 m: the far merchant is outside the radius and is never returned.
  const short = await getNearbyMerchants(location, 'jia', '', 5);
  assert.equal(calls.length, 1, 'the first search must reach the provider');
  assert.ok(calls[0].radius >= 400, 'the searched radius must cover the 400 m walking limit');
  assert.deepEqual(short.merchants.map(function(m) { return m.id; }), ['foursquare-' + near.fsq_place_id],
    'only the near merchant is within a 5 minute walk');

  // 15 minutes ≈ 1200 m: this must NOT be served from the 400 m entry, which never saw the far one.
  const wide = await getNearbyMerchants(location, 'darren', '', 15);
  assert.equal(calls.length, 2, 'a materially wider request must search again, not reuse the narrow entry');
  assert.ok(calls[1].radius >= 1200, 'the second searched radius must cover the 1200 m walking limit');
  const wideIds = wide.merchants.map(function(m) { return m.id; });
  assert.ok(wideIds.includes('foursquare-' + near.fsq_place_id), 'the wider search still includes the near merchant');
  assert.ok(wideIds.includes('foursquare-' + far.fsq_place_id),
    'the wider search must find the merchant the narrow search could never have returned');
});

test('repeating a search at the same walking limit still hits the cache', async function() {
  const calls = mockPlacesByRadius([placeAtMetres('near', 300)]);
  const first = await getNearbyMerchants(location, 'jia', '', 10);
  const second = await getNearbyMerchants(location, 'darren', '', 10);
  assert.equal(calls.length, 1, 'an identical repeat request must be served from the cache');
  assert.deepEqual(second.merchants.map(function(m) { return m.id; }),
    first.merchants.map(function(m) { return m.id; }));
});

test('walking limits that resolve to the same searched radius share one cache entry', async function() {
  const calls = mockPlacesByRadius([placeAtMetres('near', 300)]);
  // 5 min = 400 m and 6 min = 480 m both quantise up to the same searched radius, so one provider
  // call serves both: the cache is keyed on what was actually searched, not on every raw metre.
  await getNearbyMerchants(location, 'jia', '', 5);
  await getNearbyMerchants(location, 'darren', '', 6);
  assert.equal(calls.length, 1, 'equivalent radii must not fragment the cache');
  assert.equal(calls[0].radius, 500, 'both limits resolve to the same 250 m-quantised radius');
});

test('the searched radius never falls short of the requested walking limit', async function() {
  for (const [minutes, atLeast] of [[1, 80], [5, 400], [10, 800], [13, 1040], [30, 2400]]) {
    clearDiscoveryCache();
    const calls = mockPlacesByRadius([placeAtMetres('near', 50)]);
    await getNearbyMerchants(location, 'jia', '', minutes);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].radius >= atLeast,
      minutes + ' min needs at least ' + atLeast + ' m, searched ' + calls[0].radius + ' m');
  }
});

test('radius is part of the key for the broad fallback query too, not just the craving query', async function() {
  const calls = mockPlacesByRadius([placeAtMetres('near', 300), placeAtMetres('far', 900)]);
  await getNearbyMerchants(location, 'jia', 'laksa', 5);
  const shortQueries = calls.map(function(c) { return c.query; });
  assert.ok(shortQueries.length >= 1);
  const shortRadii = calls.map(function(c) { return c.radius; });
  assert.ok(shortRadii.every(function(r) { return r >= 400; }), 'every call covers the 400 m limit');

  const before = calls.length;
  await getNearbyMerchants(location, 'darren', 'laksa', 15);
  const newCalls = calls.slice(before);
  assert.ok(newCalls.length >= 1, 'the wider craving search must not reuse the narrow entries');
  assert.ok(newCalls.every(function(c) { return c.radius >= 1200; }),
    'every wider call covers the 1200 m limit');
});
