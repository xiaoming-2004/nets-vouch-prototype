const test = require('node:test');
const assert = require('node:assert/strict');
const { app, getNearbyMerchants, clearDiscoveryCache, resetMerchantCampaigns } = require('../app');

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
