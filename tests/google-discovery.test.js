const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { app, createInitialDemo, getNearbyMerchants, getSmartRecommendation, getDietaryMatchState,
  MATCH_STATE, clearDiscoveryCache, clearMerchantResearchCache, resetMerchantCampaigns } = require('../app');

const originalFetch = global.fetch;
const trackedKeys = ['GOOGLE_PLACES_API_KEY', 'FOURSQUARE_API_KEY', 'PLACES_PROVIDER', 'OPENAI_API_KEY',
  'TAVILY_API_KEY', 'GROQ_API_KEY'];
const originalEnv = {};
trackedKeys.forEach(function(key) { originalEnv[key] = process.env[key]; });
let server;
let base;

test.before(async function() {
  server = await new Promise(function(resolve) {
    const instance = app.listen(0, '127.0.0.1', function() { resolve(instance); });
  });
  base = 'http://127.0.0.1:' + server.address().port;
});
test.after(function() {
  server.close();
  trackedKeys.forEach(function(key) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  });
});
test.beforeEach(function() {
  resetMerchantCampaigns();
  clearDiscoveryCache();
  clearMerchantResearchCache();
  trackedKeys.forEach(function(key) { delete process.env[key]; });
  process.env.GOOGLE_PLACES_API_KEY = 'test-google-key';
  global.fetch = originalFetch;
});
test.afterEach(function() { global.fetch = originalFetch; });

const RP = { latitude: 1.4428, longitude: 103.7854 };
const BUGIS = { latitude: 1.3000, longitude: 103.8556 };
// ~0.0009 degrees of latitude is ~100 m.
const METRES_PER_DEGREE_LAT = 111195;

function googlePlace(id, name, extra) {
  return Object.assign({
    id: id,
    displayName: { text: name, languageCode: 'en' },
    primaryType: 'restaurant',
    types: ['restaurant', 'food', 'point_of_interest', 'establishment'],
    formattedAddress: '9 Woodlands Ave 9, Singapore 738964',
    location: { latitude: RP.latitude + 0.0005, longitude: RP.longitude }
  }, extra || {});
}

function placesAt(origin, count, prefix) {
  const places = [];
  for (let i = 0; i < count; i++) {
    places.push(googlePlace((prefix || 'p') + i, (prefix || 'Place ') + i,
      { location: { latitude: origin.latitude + 0.0002 * (i + 1), longitude: origin.longitude } }));
  }
  return places;
}

// Routes Google Nearby/Text Search, Foursquare and OpenAI calls. Each Google handler is either an
// array of places, a function(body) -> places, or { status } for an HTTP failure.
function mockProviders(options) {
  const calls = { nearby: [], text: [], foursquare: 0, openai: [] };
  const respond = function(handler, body) {
    if (handler && handler.status) return { ok: false, status: handler.status };
    if (handler && handler.malformed) return { ok: true, status: 200, json: async function() { return { places: 'bad' }; } };
    const places = typeof handler === 'function' ? handler(body) : handler || [];
    return { ok: true, status: 200, json: async function() { return places.length ? { places: places } : {}; } };
  };
  global.fetch = async function(url, init) {
    const target = String(url);
    if (target === 'https://places.googleapis.com/v1/places:searchNearby') {
      const body = JSON.parse(init.body);
      calls.nearby.push({ body: body, headers: init.headers });
      return respond(options.nearby, body);
    }
    if (target === 'https://places.googleapis.com/v1/places:searchText') {
      const body = JSON.parse(init.body);
      calls.text.push({ body: body, headers: init.headers });
      return respond(options.text, body);
    }
    if (new URL(target).hostname === 'places-api.foursquare.com') {
      calls.foursquare += 1;
      const results = options.foursquare || [];
      return { ok: true, status: 200, json: async function() { return { results: results }; } };
    }
    if (target.startsWith('https://api.openai.com/')) {
      const body = JSON.parse(init.body);
      calls.openai.push(body);
      if (!options.openai) return { ok: false, status: 500 };
      return { ok: true, json: async function() {
        return { choices: [{ message: { content: JSON.stringify(options.openai) } }] };
      } };
    }
    return { ok: false, status: 404 };
  };
  return calls;
}

function fsqResult(id, name) {
  return { fsq_place_id: id, name: name, latitude: 1.4430, longitude: 103.7855, distance: 30,
    categories: [{ name: 'Restaurant' }], location: { formatted_address: 'Woodlands, Singapore' } };
}

function visitor() {
  let cookie = '';
  return { async request(requestPath, body) {
    const response = await originalFetch(base + requestPath, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'manual',
      headers: { Cookie: cookie, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const header = response.headers.get('set-cookie');
    if (header) cookie = header.split(';')[0];
    return { status: response.status, html: await response.text() };
  } };
}

test('GOOGLE A: no craving makes exactly one distance-ranked Nearby Search with the minimal field mask', async function() {
  const calls = mockProviders({ nearby: placesAt(RP, 6) });
  const nearby = await getNearbyMerchants(RP, 'jia', '', 10);
  assert.equal(nearby.source, 'google');
  assert.equal(calls.nearby.length, 1);
  assert.equal(calls.text.length, 0);
  const request = calls.nearby[0];
  assert.equal(request.body.rankPreference, 'DISTANCE');
  assert.equal(request.body.maxResultCount, 20);
  assert.deepEqual(request.body.locationRestriction.circle.center, RP);
  assert.equal(request.body.locationRestriction.circle.radius, 800, '10 min walk x 80 m, not a blind 2 km');
  assert.equal(request.headers['X-Goog-FieldMask'],
    'places.id,places.displayName,places.primaryType,places.types,places.formattedAddress,places.location');
  assert.equal(request.headers['X-Goog-Api-Key'], 'test-google-key');
  assert.ok(!/rating|review|photo|price|opening|summary/i.test(request.headers['X-Goog-FieldMask']));
  const merchant = nearby.merchants[0];
  assert.equal(merchant.id, 'google-p0');
  assert.equal(merchant.providerPlaceId, 'p0');
  assert.equal(merchant.source, 'GOOGLE');
  assert.equal(merchant.participationMode, 'DEMO_SIMULATED');
  assert.equal(merchant.primaryType, 'restaurant');
  assert.equal(merchant.parentVenueName, null);
});

test('GOOGLE B: a craving goes to Text Search as the raw textQuery - no dictionary', async function() {
  const calls = mockProviders({ text: placesAt(RP, 6) });
  await getNearbyMerchants(RP, 'jia', 'spicy chicken', 10);
  assert.equal(calls.text.length, 1);
  assert.equal(calls.text[0].body.textQuery, 'spicy chicken');
  assert.equal(calls.text[0].body.rankPreference, 'RELEVANCE');
  assert.equal(calls.text[0].body.pageSize, 20);
  assert.equal(calls.nearby.length, 0, 'enough usable candidates - no Nearby fallback');
  assert.equal(calls.foursquare, 0);
});

test('GOOGLE C: Text Search location bias uses the current session browser coordinates', async function() {
  const calls = mockProviders({ text: placesAt(BUGIS, 6) });
  const v = visitor();
  await v.request('/home');
  await v.request('/profile', { dietaryPreference: 'none', budget: '10', maxDistanceMinutes: '10', craving: 'spicy chicken' });
  assert.equal((await v.request('/smart-match/location', BUGIS)).status, 204);
  const result = await v.request('/smart-match/result');
  assert.equal(result.status, 200);
  assert.equal(calls.text.length, 1);
  assert.deepEqual(calls.text[0].body.locationBias.circle.center, BUGIS);
  assert.equal(calls.text[0].body.locationBias.circle.radius, 1000);
  assert.match(result.html, /data-merchant-id="google-p/);
});

test('GOOGLE D: returned coordinates produce a locally calculated distanceMetres', async function() {
  mockProviders({ nearby: [googlePlace('d', 'Distance Stall',
    { location: { latitude: RP.latitude + 100 / METRES_PER_DEGREE_LAT, longitude: RP.longitude } })] });
  const merchant = (await getNearbyMerchants(RP, 'jia', '', 10)).merchants[0];
  assert.equal(merchant.distanceMetres, 100);
  assert.equal(merchant.distanceLabel, '100 m away');
  assert.equal(merchant.distanceMinutes, 1);
});

test('GOOGLE E: a Text Search result beyond the walking limit is excluded before AI ranking', async function() {
  process.env.OPENAI_API_KEY = 'test-openai';
  const far = googlePlace('far', 'Chix Hot Chicken', { primaryType: 'chicken_restaurant',
    location: { latitude: BUGIS.latitude + 975 / METRES_PER_DEGREE_LAT, longitude: BUGIS.longitude } });
  const near = placesAt(BUGIS, 5, 'near');
  const calls = mockProviders({ text: [far].concat(near),
    openai: { merchantId: 'google-far', relevance: 'high', budgetFit: 'unknown', reason: 'Hot chicken.' } });
  const demo = createInitialDemo('jia');
  demo.profile.craving = 'spicy chicken';
  demo.profile.maxDistanceMinutes = 5; // 400 m
  const nearby = await getNearbyMerchants(BUGIS, 'jia', 'spicy chicken', 5);
  assert.ok(nearby.merchants.some(function(m) { return m.id === 'google-far'; }), 'discovery keeps the raw pool');
  const result = await getSmartRecommendation(demo.profile, nearby.merchants, [], [], demo, []);
  assert.equal(calls.openai.length, 1);
  assert.ok(!JSON.stringify(calls.openai[0]).includes('google-far'), 'the AI never sees the 975 m merchant');
  assert.notEqual(result.merchant.id, 'google-far');
  assert.ok(result.merchant.distanceMetres <= 400);
});

test('GOOGLE F: a place whose primaryType is food_court is excluded as a container', async function() {
  mockProviders({ nearby: placesAt(RP, 2).concat([
    googlePlace('koufu', 'Koufu (Republic Polytechnic - South Food Court)', { primaryType: 'food_court',
      types: ['food_court', 'food', 'point_of_interest', 'establishment'] }),
    googlePlace('lawn', 'Swee Mak Mak by Savoury Collective', { primaryType: 'food_court',
      types: ['food_court', 'food', 'point_of_interest', 'establishment'] })]) });
  const ids = (await getNearbyMerchants(RP, 'jia', '', 10)).merchants.map(function(m) { return m.id; });
  assert.ok(!ids.includes('google-koufu'));
  assert.ok(!ids.includes('google-lawn'), 'excluded by type alone, no merchant-specific name rule');
  assert.equal(ids.length, 2);
});

test('GOOGLE F2: a place NAMED as a food mall is a container even when typed as a restaurant', async function() {
  // Live RP Text Search returned a food-mall venue with primaryType "restaurant".
  mockProviders({ nearby: placesAt(RP, 2).concat([googlePlace('mall', 'Eden Food Mall'),
    googlePlace('fairinn', 'Fair Inn Food Place (Coffeeshop)', { primaryType: 'coffee_shop',
      types: ['coffee_shop', 'cafe', 'food', 'point_of_interest', 'establishment'] }),
    googlePlace('kah', 'Kah Toh Fook @ Republic Poly', { primaryType: 'coffee_shop',
      types: ['coffee_shop', 'cafe', 'food', 'point_of_interest', 'establishment'] })]) });
  const ids = (await getNearbyMerchants(RP, 'jia', '', 10)).merchants.map(function(m) { return m.id; });
  assert.ok(!ids.includes('google-mall'));
  assert.ok(!ids.includes('google-fairinn'), 'the place name itself says coffeeshop');
  assert.ok(ids.includes('google-kah'), 'a coffee_shop type alone is not a container');
});

test('GOOGLE G: a stall whose ADDRESS mentions a food court is retained', async function() {
  mockProviders({ nearby: [googlePlace('meng', 'Mr Chicken Meng', {
    formattedAddress: 'Republic Polytechnic, South Food Court, Stall 11, 31 Woodlands Ave 9, #01-01, Singapore 738964' })] });
  const merchants = (await getNearbyMerchants(RP, 'jia', '', 10)).merchants;
  assert.equal(merchants.length, 1);
  assert.equal(merchants[0].merchantName, 'Mr Chicken Meng');
  assert.equal(merchants[0].parentVenueName, null, 'no parent relationship is invented from the address');
});

test('GOOGLE H: a restaurant inside a mall is retained', async function() {
  mockProviders({ nearby: [googlePlace('tokyo', 'Tokyo Shokudo Bistro Bugis', { primaryType: 'japanese_restaurant',
    types: ['japanese_restaurant', 'restaurant', 'food', 'point_of_interest', 'establishment'],
    formattedAddress: '200 Victoria St, B1-07 Bugis Junction, Singapore 188021',
    location: { latitude: BUGIS.latitude + 0.0001, longitude: BUGIS.longitude } })] });
  const merchant = (await getNearbyMerchants(BUGIS, 'jia', '', 10)).merchants[0];
  assert.equal(merchant.merchantName, 'Tokyo Shokudo Bistro Bugis');
  assert.equal(merchant.categoryLabel, 'Japanese Restaurant');
  assert.deepEqual(merchant.cuisineTags, ['japanese']);
});

test('GOOGLE I: fewer than 5 usable Text Search merchants triggers exactly one Nearby fallback', async function() {
  const farAway = googlePlace('far', 'Far Chicken', { location: { latitude: RP.latitude + 0.02, longitude: RP.longitude } });
  const calls = mockProviders({ text: placesAt(RP, 2, 'text').concat([farAway]), nearby: placesAt(RP, 6, 'near') });
  const nearby = await getNearbyMerchants(RP, 'jia', 'spicy chicken', 10);
  assert.equal(calls.text.length, 1);
  assert.equal(calls.nearby.length, 1, 'the out-of-range result does not count as usable');
  assert.equal(calls.foursquare, 0);
  assert.equal(nearby.merchants.length, 2 + 1 + 6);
});

test('GOOGLE J: the same place from Text and Nearby Search becomes one merchant', async function() {
  const shared = googlePlace('shared', 'Shared Stall');
  const calls = mockProviders({ text: [shared], nearby: [shared].concat(placesAt(RP, 3, 'n')) });
  const merchants = (await getNearbyMerchants(RP, 'jia', 'spicy chicken', 10)).merchants;
  assert.equal(calls.nearby.length, 1);
  assert.equal(merchants.filter(function(m) { return m.id === 'google-shared'; }).length, 1);
  assert.equal(merchants.length, 4);
});

test('GOOGLE K: a Google HTTP failure, timeout-style error or malformed response falls back to Foursquare', async function() {
  process.env.FOURSQUARE_API_KEY = 'test-fsq-key';
  let calls = mockProviders({ nearby: { status: 500 }, foursquare: [fsqResult('f1', 'Fallback Stall')] });
  let nearby = await getNearbyMerchants(RP, 'jia', '', 10);
  assert.equal(nearby.source, 'foursquare');
  assert.equal(calls.foursquare, 1);
  assert.equal(nearby.merchants[0].source, 'FOURSQUARE');

  clearDiscoveryCache();
  calls = mockProviders({ nearby: { malformed: true }, foursquare: [fsqResult('f1', 'Fallback Stall')] });
  assert.equal((await getNearbyMerchants(RP, 'jia', '', 10)).source, 'foursquare');

  clearDiscoveryCache();
  calls = mockProviders({ text: { status: 403 }, foursquare: [fsqResult('f1', 'Fallback Stall')] });
  nearby = await getNearbyMerchants(RP, 'jia', 'spicy chicken', 10);
  assert.equal(nearby.source, 'foursquare');
  assert.equal(calls.nearby.length, 0, 'a failed Text Search goes straight to the fallback provider');

  clearDiscoveryCache();
  global.fetch = async function(url) {
    if (String(url).startsWith('https://places.googleapis.com/')) throw new Error('network down');
    return { ok: true, status: 200, json: async function() { return { results: [fsqResult('f1', 'Fallback Stall')] }; } };
  };
  assert.equal((await getNearbyMerchants(RP, 'jia', '', 10)).source, 'foursquare');
});

test('GOOGLE K2: zero usable Google merchants falls back to Foursquare', async function() {
  process.env.FOURSQUARE_API_KEY = 'test-fsq-key';
  const calls = mockProviders({ nearby: [], foursquare: [fsqResult('f1', 'Fallback Stall')] });
  assert.equal((await getNearbyMerchants(RP, 'jia', '', 10)).source, 'foursquare');
  assert.equal(calls.nearby.length, 1);
});

test('GOOGLE L: no Google key falls back to Foursquare without calling Google', async function() {
  delete process.env.GOOGLE_PLACES_API_KEY;
  process.env.FOURSQUARE_API_KEY = 'test-fsq-key';
  const calls = mockProviders({ foursquare: [fsqResult('f1', 'Fallback Stall')] });
  const nearby = await getNearbyMerchants(RP, 'jia', '', 10);
  assert.equal(nearby.source, 'foursquare');
  assert.equal(calls.nearby.length + calls.text.length, 0);
});

test('GOOGLE M: a successful Google discovery never calls Foursquare', async function() {
  process.env.FOURSQUARE_API_KEY = 'test-fsq-key';
  const calls = mockProviders({ nearby: placesAt(RP, 3), text: placesAt(RP, 6), foursquare: [fsqResult('f1', 'X')] });
  await getNearbyMerchants(RP, 'jia', '', 10);
  await getNearbyMerchants(RP, 'jia', 'sushi', 10);
  assert.equal(calls.foursquare, 0);
});

test('GOOGLE M2: PLACES_PROVIDER=foursquare makes Foursquare primary with Google as fallback', async function() {
  process.env.PLACES_PROVIDER = 'foursquare';
  process.env.FOURSQUARE_API_KEY = 'test-fsq-key';
  let calls = mockProviders({ nearby: placesAt(RP, 3), foursquare: [fsqResult('f1', 'Primary Stall')] });
  assert.equal((await getNearbyMerchants(RP, 'jia', '', 10)).source, 'foursquare');
  assert.equal(calls.nearby.length, 0);
  clearDiscoveryCache();
  delete process.env.FOURSQUARE_API_KEY;
  calls = mockProviders({ nearby: placesAt(RP, 3) });
  assert.equal((await getNearbyMerchants(RP, 'jia', '', 10)).source, 'google');
});

test('GOOGLE N: Google and Foursquare both failing uses the explicit demo fallback', async function() {
  process.env.FOURSQUARE_API_KEY = 'test-fsq-key';
  mockProviders({ nearby: { status: 500 } });
  global.fetch = (function(inner) {
    return async function(url, init) {
      if (new URL(String(url)).hostname === 'places-api.foursquare.com') return { ok: false, status: 503 };
      return inner(url, init);
    };
  })(global.fetch);
  const nearby = await getNearbyMerchants(BUGIS, 'jia', '', 10);
  assert.equal(nearby.source, 'local-fallback');
  assert.equal(nearby.demoFallback, true);
  assert.ok(nearby.merchants.every(function(m) { return m.source === 'local-fallback'; }));

  // Over HTTP, the real browser location + demo merchants is surfaced, never shown as live.
  const v = visitor();
  await v.request('/home');
  await v.request('/profile', { dietaryPreference: 'none', budget: '10', maxDistanceMinutes: '10' });
  await v.request('/smart-match/location', BUGIS);
  const result = await v.request('/smart-match/result');
  assert.match(result.html, /Using demo location/);
});

test('GOOGLE O: the same location and search mode reuse the Google cache within the TTL', async function() {
  const calls = mockProviders({ nearby: placesAt(RP, 6), text: placesAt(RP, 6) });
  await getNearbyMerchants(RP, 'jia', '', 10);
  const second = await getNearbyMerchants({ latitude: RP.latitude + 0.0001, longitude: RP.longitude }, 'darren', '', 10);
  assert.equal(calls.nearby.length, 1);
  assert.equal(second.source, 'google');
  assert.notEqual(second.merchants[0].distanceMetres, undefined);
  await getNearbyMerchants(RP, 'jia', 'Spicy  Chicken', 10);
  await getNearbyMerchants(RP, 'darren', 'spicy chicken', 10);
  assert.equal(calls.text.length, 1, 'the normalised craving shares one cache entry');
});

test('GOOGLE P: different cravings at the same location use separate Text Search cache entries', async function() {
  const calls = mockProviders({ text: function(body) { return placesAt(RP, 6, body.textQuery.replace(/\s/g, '')); } });
  const sushi = await getNearbyMerchants(RP, 'jia', 'sushi', 10);
  const chicken = await getNearbyMerchants(RP, 'jia', 'spicy chicken', 10);
  await getNearbyMerchants(RP, 'jia', 'sushi', 10);
  assert.deepEqual(calls.text.map(function(c) { return c.body.textQuery; }), ['sushi', 'spicy chicken']);
  assert.notEqual(sushi.merchants[0].id, chicken.merchants[0].id);
});

test('GOOGLE Q: a cached Nearby Search never satisfies a craving Text Search', async function() {
  const calls = mockProviders({ nearby: placesAt(RP, 6, 'n'), text: placesAt(RP, 6, 't') });
  await getNearbyMerchants(RP, 'jia', '', 10);
  const craving = await getNearbyMerchants(RP, 'jia', 'sushi', 10);
  assert.equal(calls.nearby.length, 1);
  assert.equal(calls.text.length, 1);
  assert.ok(craving.merchants.every(function(m) { return m.id.startsWith('google-t'); }));
});

test('GOOGLE R: a halal_restaurant type is never halal verification', async function() {
  mockProviders({ nearby: [googlePlace('halal', 'InstaChef at Republic Polytechnic', {
    primaryType: 'halal_restaurant', types: ['halal_restaurant', 'restaurant', 'food', 'point_of_interest', 'establishment'] })] });
  const merchant = (await getNearbyMerchants(RP, 'jia', '', 10)).merchants[0];
  assert.deepEqual(merchant.dietary, []);
  assert.equal(getDietaryMatchState(merchant, 'halal'), MATCH_STATE.UNKNOWN);
  const demo = createInitialDemo('jia');
  demo.profile.dietaryPreference = 'halal';
  const result = await getSmartRecommendation(demo.profile, [merchant], [], [], demo, []);
  assert.equal(result.merchant, null, 'without research evidence the type alone cannot recommend it as halal');
});

test('GOOGLE S: a failed location POST is not treated as stored location', async function() {
  // Server: invalid coordinates are rejected and nothing is stored for discovery.
  const v = visitor();
  await v.request('/home');
  assert.equal((await v.request('/smart-match/location', { latitude: 'x', longitude: 200 })).status, 400);

  // Client: prepareDiscoveryLocation must require response.ok before marking location ready.
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'script.js'), 'utf8');
  const region = { dataset: {}, addEventListener: function() {}, setAttribute: function() {}, querySelector: function() { return null; } };
  const sandbox = {
    console: { info: function() {}, log: function() {}, error: function() {} },
    window: { setTimeout: setTimeout, clearTimeout: clearTimeout, addEventListener: function() {},
      location: { assign: function() {} } },
    location: { search: '' },
    setTimeout: setTimeout, clearTimeout: clearTimeout,
    navigator: { geolocation: { getCurrentPosition: function(success) { success({ coords: { latitude: 1.3, longitude: 103.8556 } }); } } },
    document: {
      querySelector: function(selector) { return selector === '[data-match-region]' ? region : null; },
      querySelectorAll: function() { return []; },
      getElementById: function() { return null; },
      addEventListener: function() {}
    },
    fetch: async function() { return { ok: false, status: 500 }; }
  };
  vm.createContext(sandbox);
  vm.runInContext(source + '\n;globalThis.__prepare = prepareDiscoveryLocation;', sandbox);
  assert.equal(await sandbox.__prepare(), false);
  assert.notEqual(region.dataset.locationReady, 'true');

  sandbox.fetch = async function() { return { ok: true, status: 204 }; };
  assert.equal(await sandbox.__prepare(), true);
  assert.equal(region.dataset.locationReady, 'true');
});
