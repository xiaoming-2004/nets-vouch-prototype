const test = require('node:test');
const assert = require('node:assert/strict');
const { app, createInitialDemo, getNearbyMerchants, getEligibleMerchants,
  getSmartRecommendation, getMerchantCampaigns, resetMerchantCampaigns,
  getMoodMatchState, getDietaryMatchState, merchantMentionsCraving, MATCH_STATE,
  clearDiscoveryCache, clearMerchantResearchCache, RESEARCH_STATUS } = require('../app');

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

const originalFetch = global.fetch;
const originalOpenAIKey = process.env.OPENAI_API_KEY;
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

function visitor() {
  let cookie = '';
  return { async request(path, body) {
    const response = await originalFetch(base + path, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'manual',
      headers: { Cookie: cookie, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const header = response.headers.get('set-cookie');
    if (header) cookie = header.split(';')[0];
    return { status: response.status, location: response.headers.get('location'), html: await response.text() };
  } };
}

test.beforeEach(function() {
  resetMerchantCampaigns();
  clearDiscoveryCache();
  clearMerchantResearchCache();
  delete process.env.OPENAI_API_KEY;
  delete process.env.FOURSQUARE_API_KEY;
  delete process.env.TAVILY_API_KEY;
  delete process.env.GROQ_API_KEY;
  global.fetch = originalFetch;
});
test.afterEach(function() {
  global.fetch = originalFetch;
  if (originalOpenAIKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalOpenAIKey;
  delete process.env.TAVILY_API_KEY;
  delete process.env.GROQ_API_KEY;
  if (originalFoursquareKey === undefined) delete process.env.FOURSQUARE_API_KEY;
  else process.env.FOURSQUARE_API_KEY = originalFoursquareKey;
});

async function candidates() {
  return (await getNearbyMerchants()).merchants;
}

function aiResponse(merchantId, reason, relevance) {
  return { ok: true, json: async function() {
    return { choices: [{ message: { content: JSON.stringify({ merchantId: merchantId,
      relevance: relevance === undefined ? 'high' : relevance, reason: reason }) } }] };
  } };
}

function merchantIdOf(html) {
  const match = html.match(/data-merchant-id="([^"]+)"/);
  return match ? match[1] : null;
}

async function rejectCurrent(v, merchantId, reason) {
  return v.request('/recommendation/reject', { merchantId: merchantId, reason: reason || 'not-in-mood' });
}

// Builds one Foursquare Place Search result. distance/latitude/longitude/categories/
// related_places can all be overridden via `extra`.
function fsqPlace(fsqId, name, categoryName, extra) {
  return Object.assign({
    fsq_place_id: fsqId,
    name: name,
    latitude: 1.45,
    longitude: 103.82,
    distance: 100,
    categories: categoryName ? [{ name: categoryName }] : [{ name: 'Restaurant' }],
    location: { formatted_address: '105 Canberra Street, Singapore' }
  }, extra || {});
}

// Mocks the Foursquare Place Search endpoint only. Any other host/path (e.g. a stray OpenAI
// call not otherwise routed) returns a 404-shaped response so an unexpected call fails loudly
// instead of silently returning Foursquare-shaped data.
function mockFoursquare(results) {
  let calls = 0;
  const requests = [];
  const fetchFn = async function(url, options) {
    const requestUrl = new URL(String(url));
    if (requestUrl.hostname === 'places-api.foursquare.com' && requestUrl.pathname === '/places/search') {
      calls += 1;
      const headers = (options && options.headers) || {};
      requests.push({
        hostname: requestUrl.hostname, pathname: requestUrl.pathname,
        ll: requestUrl.searchParams.get('ll'), radius: requestUrl.searchParams.get('radius'),
        near: requestUrl.searchParams.get('near'), query: requestUrl.searchParams.get('query'),
        sort: requestUrl.searchParams.get('sort'), limit: requestUrl.searchParams.get('limit'),
        authorization: headers.Authorization, apiVersion: headers['X-Places-Api-Version']
      });
      return { ok: true, json: async function() { return { results: results || [] }; } };
    }
    return { ok: false, status: 404 };
  };
  return { fetchFn: fetchFn, getCalls: function() { return calls; }, getRequests: function() { return requests; } };
}

// Like mockFoursquare, but returns a different result set depending on the `query` param -
// needed to test the primary-craving-query vs broader-food-fallback search separately.
function mockFoursquareByQuery(resultsByQuery, defaultResults) {
  let calls = 0;
  const requests = [];
  const fetchFn = async function(url, options) {
    const requestUrl = new URL(String(url));
    if (requestUrl.hostname === 'places-api.foursquare.com' && requestUrl.pathname === '/places/search') {
      calls += 1;
      const headers = (options && options.headers) || {};
      const query = requestUrl.searchParams.get('query');
      requests.push({
        query: query, ll: requestUrl.searchParams.get('ll'), radius: requestUrl.searchParams.get('radius'),
        near: requestUrl.searchParams.get('near'), sort: requestUrl.searchParams.get('sort'),
        limit: requestUrl.searchParams.get('limit'),
        authorization: headers.Authorization, apiVersion: headers['X-Places-Api-Version']
      });
      const results = Object.prototype.hasOwnProperty.call(resultsByQuery, query) ?
        resultsByQuery[query] : (defaultResults || []);
      return { ok: true, json: async function() { return { results: results }; } };
    }
    return { ok: false, status: 404 };
  };
  return { fetchFn: fetchFn, getCalls: function() { return calls; }, getRequests: function() { return requests; } };
}

// ---------------------------------------------------------------------------
// AI ranking / deterministic fallback (provider-agnostic - exercised against the
// curated local demo merchants, unaffected by which discovery provider is active)
// ---------------------------------------------------------------------------

// Neutral ranking: no merchant has a hidden ID/name bonus. With default preferences the
// deterministic fallback picks the nearest affordable demo merchant (Woodlands Noodle Bar, 4 min,
// $6.80) over farther ones such as Felicia's Chicken Rice (8 min, $5.00).
const NEAREST_DEMO_MERCHANT_ID = 'woodlands-noodle-bar';

test('missing AI key uses participating local fallback', async function() {
  const demo = createInitialDemo('jia');
  const result = await getSmartRecommendation(demo.profile, await candidates(), [], [], demo);
  assert.equal(result.merchant.id, NEAREST_DEMO_MERCHANT_ID);
  assert.equal(result.reason, null);
});

test('no merchant gets a hidden ranking bonus from its ID or name', async function() {
  const demo = createInitialDemo('jia');
  const base = (await candidates()).find(function(m) { return m.id === 'felicia-chicken-rice'; });
  // Identical facts except identity; the Felicia-identity candidate is 3 minutes farther -
  // a gap the removed +15 bonus would have overturned.
  const felicia = Object.assign({}, base, { distanceMinutes: 7 });
  const neutral = Object.assign({}, base, { id: 'green-bowl', merchantId: 'green-bowl',
    merchantName: 'Neutral Stall', name: 'Neutral Stall', distanceMinutes: 4 });
  for (const pool of [[felicia, neutral], [neutral, felicia]]) {
    const result = await getSmartRecommendation(demo.profile, pool, [], [], demo);
    assert.equal(result.merchant.id, 'green-bowl', 'the nearer merchant wins regardless of identity or order');
  }
});

test('AI error and malformed or ineligible output use deterministic fallback', async function() {
  process.env.OPENAI_API_KEY = 'test-key';
  const demo = createInitialDemo('jia');
  const nearby = await candidates();
  global.fetch = async function() { throw new Error('provider unavailable'); };
  assert.equal((await getSmartRecommendation(demo.profile, nearby, [], [], demo)).merchant.id, NEAREST_DEMO_MERCHANT_ID);
  global.fetch = async function() { return aiResponse('not-participating', 'Nearby choice.'); };
  assert.equal((await getSmartRecommendation(demo.profile, nearby, [], [], demo)).merchant.id, NEAREST_DEMO_MERCHANT_ID);
  global.fetch = async function() { return aiResponse('green-bowl', '   '); };
  assert.equal((await getSmartRecommendation(demo.profile, nearby, [], [], demo)).merchant.id, NEAREST_DEMO_MERCHANT_ID);
});

test('AI timeout uses deterministic fallback', async function() {
  process.env.OPENAI_API_KEY = 'test-key';
  const demo = createInitialDemo('jia');
  const nearby = await candidates();
  global.fetch = function(url, options) {
    return new Promise(function(resolve, reject) {
      options.signal.addEventListener('abort', function() { reject(new Error('aborted')); });
    });
  };
  assert.equal((await getSmartRecommendation(demo.profile, nearby, [], [], demo)).merchant.id, NEAREST_DEMO_MERCHANT_ID);
});

test('valid AI choice is used only after dietary, budget, distance and campaign filters', async function() {
  process.env.OPENAI_API_KEY = 'test-key';
  const demo = createInitialDemo('jia');
  const nearby = await candidates();
  global.fetch = async function() { return aiResponse('green-bowl', 'Vegan bowl, six minutes away.'); };
  let result = await getSmartRecommendation(demo.profile, nearby, [], [], demo);
  assert.equal(result.merchant.id, 'green-bowl');
  assert.equal(result.reason, 'Vegan bowl, six minutes away.');

  demo.profile.dietaryPreference = 'halal';
  demo.profile.budget = 6;
  demo.profile.maxDistanceMinutes = 8;
  result = await getSmartRecommendation(demo.profile, nearby, [], [], demo);
  assert.equal(result.merchant.id, 'felicia-chicken-rice');
  assert.equal(result.reason, null);

  const campaign = getMerchantCampaigns().find(function(item) { return item.merchantId === 'felicia-chicken-rice'; });
  campaign.status = 'INACTIVE';
  result = await getSmartRecommendation(demo.profile, nearby, [], [], demo);
  assert.equal(result.merchant, null);
});

test('AI receives a brief owned payment outcome, not private transaction details', async function() {
  process.env.OPENAI_API_KEY = 'test-key';
  const demo = createInitialDemo('jia');
  demo.transactions.push({ id: 'tx-secret', ownerUserId: 'jia', merchantName: "Felicia's Chicken Rice",
    source: 'SMART_MATCH', status: 'Successful', purchaseAmount: 123.45 });
  demo.transactions.push({ id: 'other-secret', ownerUserId: 'darren', merchantName: 'Private Merchant',
    source: 'DIRECT_SCAN', status: 'Successful', purchaseAmount: 88.88 });
  let prompt = '';
  global.fetch = async function(url, options) {
    prompt = JSON.parse(options.body).messages[1].content;
    return aiResponse('green-bowl', 'Vegan bowl nearby.');
  };
  await getSmartRecommendation(demo.profile, await candidates(), [], [], demo);
  assert.match(prompt, /Felicia's Chicken Rice.*recommended, accepted, payment completed/);
  assert.ok(!prompt.includes('tx-secret'));
  assert.ok(!prompt.includes('123.45'));
  assert.ok(!prompt.includes('Private Merchant'));
});

// ---------------------------------------------------------------------------
// TEST A - browser coordinates reach the backend
// ---------------------------------------------------------------------------

test('TEST A: valid browser coordinates reach the backend and drive discovery', async function() {
  process.env.FOURSQUARE_API_KEY = 'test-key';
  const mock = mockFoursquare([fsqPlace('a', 'Real Nearby Place', 'Restaurant')]);
  global.fetch = mock.fetchFn;
  const v = visitor();
  assert.match((await v.request('/home')).html, /data-location-ready="false"/);
  assert.equal((await v.request('/smart-match/location', { latitude: 1.30, longitude: 103.85 })).status, 204);
  assert.match((await v.request('/home')).html, /data-location-ready="true"/);
  await v.request('/smart-match/result');
  assert.equal(mock.getRequests()[0].ll, '1.3,103.85');
  assert.equal((await v.request('/smart-match/location', { latitude: 999, longitude: 103.89 })).status, 400);
  assert.equal((await v.request('/smart-match/location', { latitude: 1.3, longitude: -181 })).status, 400);
});

// ---------------------------------------------------------------------------
// TEST B/C/D/E - Foursquare endpoint, auth, coordinate search, radius
// ---------------------------------------------------------------------------

test('TEST B: Foursquare Place Search uses the current Places API host/path', async function() {
  process.env.FOURSQUARE_API_KEY = 'test-key';
  const mock = mockFoursquare([fsqPlace('a', 'Flying Wok', 'Chinese Restaurant')]);
  global.fetch = mock.fetchFn;
  await getNearbyMerchants({ latitude: 1.45, longitude: 103.82 });
  const requests = mock.getRequests();
  assert.equal(requests.length, 1,
    'expected exactly one request to the current Places API host/path - fails if the code ' +
    'regresses to the legacy api.foursquare.com/v3/places/search endpoint');
  assert.equal(requests[0].hostname, 'places-api.foursquare.com');
  assert.equal(requests[0].pathname, '/places/search');
});

test('TEST C: Foursquare requests use Bearer auth and the pinned API version header', async function() {
  process.env.FOURSQUARE_API_KEY = 'super-secret-key';
  const mock = mockFoursquare([fsqPlace('a', 'Flying Wok', 'Chinese Restaurant')]);
  global.fetch = mock.fetchFn;
  await getNearbyMerchants({ latitude: 1.45, longitude: 103.82 });
  const request = mock.getRequests()[0];
  assert.equal(request.authorization, 'Bearer super-secret-key');
  assert.equal(request.apiVersion, '2025-06-17');
});

test('TEST D: Foursquare search uses ll= coordinates and never near=', async function() {
  process.env.FOURSQUARE_API_KEY = 'test-key';
  const mock = mockFoursquare([fsqPlace('a', 'Flying Wok', 'Chinese Restaurant')]);
  global.fetch = mock.fetchFn;
  await getNearbyMerchants({ latitude: 1.44891, longitude: 103.83236 });
  const request = mock.getRequests()[0];
  assert.equal(request.ll, '1.44891,103.83236');
  assert.equal(request.near, null, 'address-based near= search must never be used');
  assert.equal(request.query, 'food');
  assert.equal(request.sort, 'DISTANCE');
});

test('TEST E: Smart Match search radius matches the existing ~2km discovery area', async function() {
  process.env.FOURSQUARE_API_KEY = 'test-key';
  const mock = mockFoursquare([fsqPlace('a', 'Flying Wok', 'Chinese Restaurant')]);
  global.fetch = mock.fetchFn;
  await getNearbyMerchants({ latitude: 1.45, longitude: 103.82 });
  assert.equal(mock.getRequests()[0].radius, '2000');
  assert.equal(mock.getRequests()[0].limit, '50');
});

// ---------------------------------------------------------------------------
// TEST F/G/H - individual stalls, stable IDs, parent venue
// ---------------------------------------------------------------------------

test('TEST F: individual stalls survive, but the container food court venue is excluded', async function() {
  process.env.FOURSQUARE_API_KEY = 'test-key';
  const mock = mockFoursquare([
    fsqPlace('kalsom', 'Kalsom Street Food', 'Malay Restaurant'),
    fsqPlace('wok', 'Flying Wok', 'Chinese Restaurant'),
    fsqPlace('leaf', 'Food Leaf', 'Restaurant'),
    fsqPlace('combo', 'Combo 105', 'Food Court')
  ]);
  global.fetch = mock.fetchFn;
  const nearby = await getNearbyMerchants({ latitude: 1.44891, longitude: 103.83236 });
  const names = nearby.merchants.map(function(m) { return m.merchantName; });
  assert.ok(names.includes('Kalsom Street Food'));
  assert.ok(names.includes('Flying Wok'));
  assert.ok(names.includes('Food Leaf'));
  assert.ok(!names.includes('Combo 105'), 'a Food Court category venue must not itself become the recommendation');
});

test('TEST G: Foursquare merchants use a stable foursquare-<fsq_place_id> identity', async function() {
  process.env.FOURSQUARE_API_KEY = 'test-key';
  const mock = mockFoursquare([fsqPlace('abc123', 'Kalsom Street Food', 'Malay Restaurant')]);
  global.fetch = mock.fetchFn;
  const nearby = await getNearbyMerchants({ latitude: 1.45, longitude: 103.82 });
  const stall = nearby.merchants.find(function(m) { return m.merchantName === 'Kalsom Street Food'; });
  assert.equal(stall.id, 'foursquare-abc123');
  assert.equal(stall.externalPlaceId, 'abc123');
  assert.equal(stall.source, 'FOURSQUARE');
});

test('TEST H: related_places.parent is preserved as parent venue metadata, never assumed', async function() {
  process.env.FOURSQUARE_API_KEY = 'test-key';
  const mock = mockFoursquare([
    fsqPlace('kalsom', 'Kalsom Street Food', 'Malay Restaurant',
      { related_places: { parent: { name: 'Yong Li Coffee Station' } } }),
    fsqPlace('leaf', 'Food Leaf', 'Restaurant')
  ]);
  global.fetch = mock.fetchFn;
  const nearby = await getNearbyMerchants({ latitude: 1.45, longitude: 103.82 });
  const withParent = nearby.merchants.find(function(m) { return m.merchantName === 'Kalsom Street Food'; });
  const withoutParent = nearby.merchants.find(function(m) { return m.merchantName === 'Food Leaf'; });
  assert.equal(withParent.parentVenueName, 'Yong Li Coffee Station');
  assert.equal(withoutParent.parentVenueName, null, 'missing parent data must never be fabricated');
});

// ---------------------------------------------------------------------------
// TEST I/J - cuisine mapping and unknown metadata
// ---------------------------------------------------------------------------

test('TEST I: specific factual Foursquare categories map to cuisine tags conservatively', async function() {
  process.env.FOURSQUARE_API_KEY = 'test-key';
  const mock = mockFoursquare([
    fsqPlace('a', 'Chinese Place', 'Chinese Restaurant'),
    fsqPlace('b', 'Malay Place', 'Malay Restaurant'),
    fsqPlace('c', 'Indian Place', 'Indian Restaurant'),
    fsqPlace('d', 'Noodle Place', 'Noodle Restaurant'),
    fsqPlace('e', 'Generic Place', 'Restaurant')
  ]);
  global.fetch = mock.fetchFn;
  const nearby = await getNearbyMerchants({ latitude: 1.45, longitude: 103.82 });
  const byName = function(name) { return nearby.merchants.find(function(m) { return m.merchantName === name; }); };
  assert.deepEqual(byName('Chinese Place').cuisineTags, ['chinese']);
  assert.deepEqual(byName('Malay Place').cuisineTags, ['malay']);
  assert.deepEqual(byName('Indian Place').cuisineTags, ['indian']);
  assert.deepEqual(byName('Noodle Place').cuisineTags, ['noodles']);
  assert.deepEqual(byName('Generic Place').cuisineTags, [], 'a generic category must not be guessed into a cuisine');
});

test('TEST J: unknown cuisine/dietary/price never excludes a merchant from Smart Match', async function() {
  process.env.FOURSQUARE_API_KEY = 'test-key';
  const mock = mockFoursquare([fsqPlace('mystery', 'Mystery Kitchen', 'Restaurant')]);
  global.fetch = mock.fetchFn;
  const demo = createInitialDemo('jia');
  const nearby = await getNearbyMerchants({ latitude: 1.45, longitude: 103.82 });
  const eligible = getEligibleMerchants(demo.profile, nearby.merchants, [], demo);
  assert.ok(eligible.some(function(m) { return m.merchantName === 'Mystery Kitchen'; }),
    'a merchant lacking price/dietary/cuisine metadata must still be eligible');
  const result = await getSmartRecommendation(demo.profile, nearby.merchants, [], [], demo);
  assert.equal(result.merchant.dietary.length, 0);
  assert.equal(result.merchant.cuisineTags.length, 0);
  assert.equal(result.merchant.price, null);
});

// ---------------------------------------------------------------------------
// TEST K - real merchants can be recommended purely via DEMO_SIMULATED participation
// ---------------------------------------------------------------------------

test('TEST K: a real Foursquare merchant with no pre-existing campaign record can be recommended', async function() {
  process.env.FOURSQUARE_API_KEY = 'test-key';
  const mock = mockFoursquare([fsqPlace('new-place', 'Epok Epok Mummy Khalsom', 'Malay Restaurant')]);
  global.fetch = mock.fetchFn;
  const demo = createInitialDemo('jia');
  const nearby = await getNearbyMerchants({ latitude: 1.44891, longitude: 103.83236 });
  const merchant = nearby.merchants.find(function(m) { return m.merchantName === 'Epok Epok Mummy Khalsom'; });
  assert.equal(merchant.participationMode, 'DEMO_SIMULATED');
  const campaign = getMerchantCampaigns().find(function(c) { return c.merchantId === merchant.id; });
  assert.ok(campaign, 'a campaign record must be created automatically, not required to pre-exist');
  const result = await getSmartRecommendation(demo.profile, nearby.merchants, [], [], demo);
  assert.equal(result.merchant.merchantName, 'Epok Epok Mummy Khalsom');
});

// ---------------------------------------------------------------------------
// TEST L/M - deduplication
// ---------------------------------------------------------------------------

test('TEST L: the same real place returned twice within close proximity is deduplicated', async function() {
  process.env.FOURSQUARE_API_KEY = 'test-key';
  const mock = mockFoursquare([
    fsqPlace('dup-1', 'Flying Wok', 'Chinese Restaurant', { latitude: 1.4500, longitude: 103.8200 }),
    fsqPlace('dup-2', 'Flying Wok', 'Chinese Restaurant', { latitude: 1.45001, longitude: 103.82001 })
  ]);
  global.fetch = mock.fetchFn;
  const nearby = await getNearbyMerchants({ latitude: 1.45, longitude: 103.82 });
  const matches = nearby.merchants.filter(function(m) { return m.merchantName === 'Flying Wok'; });
  assert.equal(matches.length, 1, 'a duplicate listing of the same real place must collapse into one candidate');
});

test('TEST M: two distinct stalls sharing the same food court address remain separate', async function() {
  process.env.FOURSQUARE_API_KEY = 'test-key';
  const mock = mockFoursquare([
    fsqPlace('kalsom', 'Kalsom Street Food', 'Malay Restaurant', { latitude: 1.4501, longitude: 103.8201 }),
    fsqPlace('wok', 'Flying Wok', 'Chinese Restaurant', { latitude: 1.4502, longitude: 103.8202 })
  ]);
  global.fetch = mock.fetchFn;
  const nearby = await getNearbyMerchants({ latitude: 1.45, longitude: 103.82 });
  const names = nearby.merchants.map(function(m) { return m.merchantName; });
  assert.ok(names.includes('Kalsom Street Food'));
  assert.ok(names.includes('Flying Wok'));
});

// ---------------------------------------------------------------------------
// TEST N/O - Sprint 1.6 deterministic rejection rules, preserved against Foursquare data
// ---------------------------------------------------------------------------

test('TEST N: Too far remains a hard constraint - only strictly closer candidates survive', async function() {
  process.env.FOURSQUARE_API_KEY = 'test-key';
  const mock = mockFoursquare([
    fsqPlace('rejected', 'Rejected Merchant', 'Restaurant', { distance: 900 }),
    fsqPlace('near-b', 'Near B', 'Restaurant', { distance: 200 }),
    fsqPlace('near-c', 'Near C', 'Restaurant', { distance: 500 }),
    fsqPlace('far-d', 'Far D', 'Restaurant', { distance: 1200 })
  ]);
  global.fetch = mock.fetchFn;
  const demo = createInitialDemo('jia');
  demo.profile.maxDistanceMinutes = 30;
  const nearby = await getNearbyMerchants({ latitude: 1.45, longitude: 103.82 });
  const feedback = [{ merchantId: 'foursquare-rejected', reason: 'too-far', category: 'foursquare.place',
    distanceMetres: 900 }];
  const result = await getSmartRecommendation(demo.profile, nearby.merchants, ['foursquare-rejected'], feedback, demo);
  assert.ok(result.merchant && ['Near B', 'Near C'].includes(result.merchant.merchantName),
    'expected a strictly closer merchant, got ' + (result.merchant && result.merchant.merchantName) + ' - never 950m');

  const noneCloser = mockFoursquare([
    fsqPlace('rejected', 'Rejected Merchant', 'Restaurant', { distance: 300 }),
    fsqPlace('far-b', 'Far B', 'Restaurant', { distance: 500 }),
    fsqPlace('far-c', 'Far C', 'Restaurant', { distance: 800 })
  ]);
  clearDiscoveryCache(); // Independent fixture: do not reuse the first scenario's Places response.
  global.fetch = noneCloser.fetchFn;
  const v = visitor();
  await v.request('/smart-match/location', { latitude: 1.45, longitude: 103.82 });
  await v.request('/profile', { dietaryPreference: 'none', budget: '10', maxDistanceMinutes: '30' });
  const first = await v.request('/smart-match/result');
  const firstId = merchantIdOf(first.html);
  await rejectCurrent(v, firstId, 'too-far');
  const next = await v.request('/smart-match/result');
  assert.match(next.html, /No closer matches available/);
  assert.ok(!next.html.includes('data-merchant-id='), 'must not silently recommend a farther merchant');
  assert.equal(noneCloser.getCalls(), 1, 'a too-far dead end must not trigger a brand-new Foursquare batch');
});

test('TEST O: Not in the mood deprioritises the same factual cuisine using Foursquare category data', async function() {
  process.env.FOURSQUARE_API_KEY = 'test-key';
  const mock = mockFoursquare([
    fsqPlace('western-b', 'Western B', 'Restaurant', { distance: 150, categories: [{ name: 'Chinese Restaurant' }] }),
    fsqPlace('chinese-c', 'Chinese C', 'Restaurant', { distance: 400, categories: [{ name: 'Malay Restaurant' }] })
  ]);
  global.fetch = mock.fetchFn;
  const demo = createInitialDemo('jia');
  const nearby = await getNearbyMerchants({ latitude: 1.45, longitude: 103.82 });
  const feedback = [{ merchantId: 'foursquare-western-a', reason: 'not-in-mood', category: 'foursquare.place',
    cuisineTags: ['chinese'], distanceMetres: 100 }];
  const result = await getSmartRecommendation(demo.profile, nearby.merchants, [], feedback, demo);
  assert.equal(result.merchant.merchantName, 'Chinese C',
    'a same-cuisine alternative should not casually win right after a not-in-mood rejection');
});

// ---------------------------------------------------------------------------
// TEST P - Not for me reuses the current batch
// ---------------------------------------------------------------------------

test('TEST P: Not for me reuses the current batch - no new Foursquare request', async function() {
  process.env.FOURSQUARE_API_KEY = 'test-key';
  const mock = mockFoursquare([
    fsqPlace('a', 'Merchant A', 'Restaurant'),
    fsqPlace('b', 'Merchant B', 'Restaurant'),
    fsqPlace('c', 'Merchant C', 'Restaurant')
  ]);
  global.fetch = mock.fetchFn;
  const v = visitor();
  await v.request('/smart-match/location', { latitude: 1.45, longitude: 103.82 });
  const first = await v.request('/smart-match/result');
  const firstId = merchantIdOf(first.html);
  assert.ok(firstId);
  assert.equal(mock.getCalls(), 1);

  assert.equal((await rejectCurrent(v, firstId, 'not-in-mood')).status, 302);
  assert.equal(mock.getCalls(), 1, 'rejecting must not trigger another Foursquare call');

  const second = await v.request('/smart-match/result');
  const secondId = merchantIdOf(second.html);
  assert.ok(secondId);
  assert.notEqual(secondId, firstId, 'a rejected merchant must not immediately repeat');
  assert.equal(mock.getCalls(), 1, 'the second recommendation still came from the same batch');
});

test('multiple rejections consume the same batch with no extra provider calls', async function() {
  process.env.FOURSQUARE_API_KEY = 'test-key';
  const mock = mockFoursquare([
    fsqPlace('a', 'Merchant A', 'Restaurant'),
    fsqPlace('b', 'Merchant B', 'Restaurant'),
    fsqPlace('c', 'Merchant C', 'Restaurant')
  ]);
  global.fetch = mock.fetchFn;
  const v = visitor();
  await v.request('/smart-match/location', { latitude: 1.45, longitude: 103.82 });
  const seen = new Set();
  for (let i = 0; i < 3; i++) {
    const page = await v.request('/smart-match/result');
    const id = merchantIdOf(page.html);
    assert.ok(id, 'a recommendation should still be available at rejection ' + i);
    assert.ok(!seen.has(id), 'no merchant should repeat within the same cycle');
    seen.add(id);
    await rejectCurrent(v, id, 'not-in-mood');
  }
  assert.equal(mock.getCalls(), 1, 'three rejections against a three-merchant batch should need only the original call');
});

test('rejection state is per-session - Darren is unaffected by Jia', async function() {
  process.env.FOURSQUARE_API_KEY = 'test-key';
  const mock = mockFoursquare([
    fsqPlace('a', 'Merchant A', 'Restaurant'),
    fsqPlace('b', 'Merchant B', 'Restaurant')
  ]);
  global.fetch = mock.fetchFn;
  const jia = visitor();
  const darren = visitor();
  await jia.request('/smart-match/location', { latitude: 1.45, longitude: 103.82 });
  await darren.request('/smart-match/location', { latitude: 1.45, longitude: 103.82 });

  const jiaFirst = merchantIdOf((await jia.request('/smart-match/result')).html);
  await rejectCurrent(jia, jiaFirst, 'too-far');

  const darrenFirst = merchantIdOf((await darren.request('/smart-match/result')).html);
  assert.equal(darrenFirst, jiaFirst, "Darren's session must be unaffected by Jia's rejection");
});

test('batch exhaustion reuses cached discovery instead of spending another API call', async function() {
  process.env.FOURSQUARE_API_KEY = 'test-key';
  let call = 0;
  global.fetch = async function(url) {
    const requestUrl = new URL(String(url));
    if (requestUrl.hostname !== 'places-api.foursquare.com') return { ok: false, status: 404 };
    call += 1;
    const results = call === 1 ? [fsqPlace('a', 'Merchant A', 'Restaurant')]
      : [fsqPlace('a', 'Merchant A', 'Restaurant'), fsqPlace('z', 'Merchant Z', 'Restaurant')];
    return { ok: true, json: async function() { return { results: results }; } };
  };
  const v = visitor();
  await v.request('/smart-match/location', { latitude: 1.45, longitude: 103.82 });
  const firstId = merchantIdOf((await v.request('/smart-match/result')).html);
  assert.equal(firstId, 'foursquare-a');
  assert.equal(call, 1);

  await rejectCurrent(v, firstId, 'not-in-mood');
  const refreshed = await v.request('/smart-match/result');
  assert.equal(call, 1, 'the same location/query must not refresh Foursquare before cache expiry');
  assert.match(refreshed.html, /No spots nearby right now/);
  const exhausted = await v.request('/smart-match/result');
  assert.equal(call, 1, 'no further discovery call once a refresh has already been attempted this cycle');
  assert.match(exhausted.html, /No spots nearby right now/);
});

test('a refresh returning only already-seen merchants shows a clean exhaustion state, not a loop', async function() {
  process.env.FOURSQUARE_API_KEY = 'test-key';
  const mock = mockFoursquare([fsqPlace('a', 'Merchant A', 'Restaurant')]);
  global.fetch = mock.fetchFn;
  const v = visitor();
  await v.request('/smart-match/location', { latitude: 1.45, longitude: 103.82 });
  const firstId = merchantIdOf((await v.request('/smart-match/result')).html);
  await rejectCurrent(v, firstId, 'not-in-mood');
  const result = await v.request('/smart-match/result');
  assert.equal(mock.getCalls(), 1, 'the refresh attempt should reuse cached discovery');
  assert.match(result.html, /No spots nearby right now/);

  const again = await v.request('/smart-match/result');
  assert.equal(mock.getCalls(), 1, 'no repeated provider calls once the cycle is marked exhausted');
  assert.match(again.html, /No spots nearby right now/);
});

// ---------------------------------------------------------------------------
// TEST Q - OpenAI fallback
// ---------------------------------------------------------------------------

test('TEST Q: OpenAI failure still uses factual preference and distance signals sensibly', async function() {
  process.env.FOURSQUARE_API_KEY = 'test-key';
  process.env.OPENAI_API_KEY = 'test-key';
  const placesMock = mockFoursquare([
    fsqPlace('near', 'Near Match', 'Indian Restaurant', { distance: 60 }),
    fsqPlace('far', 'Far Unrelated', 'Restaurant', { distance: 1900 })
  ]);
  global.fetch = async function(url, options) {
    if (String(url).indexOf('openai') !== -1) throw new Error('OpenAI unavailable');
    return placesMock.fetchFn(url, options);
  };
  const demo = createInitialDemo('jia');
  demo.profile.moodCuisine = 'indian';
  demo.profile.maxDistanceMinutes = 30;
  const nearby = await getNearbyMerchants({ latitude: 1.45, longitude: 103.82 });
  const result = await getSmartRecommendation(demo.profile, nearby.merchants, [], [], demo);
  assert.equal(result.merchant.merchantName, 'Near Match');
  assert.equal(result.reason, null);
});

test('AI cannot resurrect a merchant the too-far constraint removed', async function() {
  process.env.FOURSQUARE_API_KEY = 'test-key';
  process.env.OPENAI_API_KEY = 'test-key';
  const placesMock = mockFoursquare([
    fsqPlace('rejected', 'Rejected Merchant', 'Restaurant', { distance: 900 }),
    fsqPlace('near', 'Near Place', 'Restaurant', { distance: 200 }),
    fsqPlace('far', 'Far Place', 'Restaurant', { distance: 1200 })
  ]);
  global.fetch = async function(url, options) {
    if (String(url).indexOf('openai') !== -1) return aiResponse('foursquare-far', 'This one looked good anyway.');
    return placesMock.fetchFn(url, options);
  };
  const demo = createInitialDemo('jia');
  const nearby = await getNearbyMerchants({ latitude: 1.45, longitude: 103.82 });
  const feedback = [{ merchantId: 'foursquare-rejected', reason: 'too-far', category: 'foursquare.place',
    distanceMetres: 900 }];
  const result = await getSmartRecommendation(demo.profile, nearby.merchants, ['foursquare-rejected'], feedback, demo);
  assert.equal(result.merchant.merchantName, 'Near Place',
    'the AI-chosen farther merchant must be rejected in favour of the deterministic subset');
});

// ---------------------------------------------------------------------------
// TEST R/S/T/U - the existing recommendation UI receives real data and the choose -> scan
// flow keeps working. There is no separate modal/dialog component in this codebase (verified
// by inspection - no <dialog>, no open/close JS, no orphaned popup partial); the
// recommendation has always rendered inline into the #smart-match `[data-match-region]`
// container via smart-match-card.ejs. These tests exercise that existing path.
// ---------------------------------------------------------------------------

test('TEST R/S: a successful recommendation renders into the existing Smart Match region with real data', async function() {
  process.env.FOURSQUARE_API_KEY = 'test-key';
  const mock = mockFoursquare([
    fsqPlace('flying-wok', 'Flying Wok', 'Chinese Restaurant', { distance: 410 })
  ]);
  global.fetch = mock.fetchFn;
  const v = visitor();
  await v.request('/smart-match/location', { latitude: 1.44891, longitude: 103.83236 });
  const match = await v.request('/smart-match/result');
  assert.match(match.html, /data-merchant-id="foursquare-flying-wok"/);
  assert.match(match.html, /Flying Wok/);
  assert.match(match.html, /410 m away/);
});

test('TEST T: parent venue displays alongside distance when Foursquare supplies it', async function() {
  process.env.FOURSQUARE_API_KEY = 'test-key';
  const mock = mockFoursquare([
    fsqPlace('kalsom', 'Kalsom Street Food', 'Malay Restaurant',
      { distance: 32, related_places: { parent: { name: 'Yong Li Coffee Station' } } })
  ]);
  global.fetch = mock.fetchFn;
  const v = visitor();
  await v.request('/smart-match/location', { latitude: 1.44891, longitude: 103.83236 });
  const match = await v.request('/smart-match/result');
  assert.match(match.html, /Kalsom Street Food/);
  assert.match(match.html, /Yong Li Coffee Station/);
  assert.match(match.html, /32 m away/);
});

test('TEST U: Choose this continues into Scan when you arrive', async function() {
  process.env.FOURSQUARE_API_KEY = 'test-key';
  const mock = mockFoursquare([fsqPlace('flying-wok', 'Flying Wok', 'Chinese Restaurant')]);
  global.fetch = mock.fetchFn;
  const v = visitor();
  await v.request('/smart-match/location', { latitude: 1.44891, longitude: 103.83236 });
  const id = merchantIdOf((await v.request('/smart-match/result')).html);
  assert.equal((await v.request('/recommendation/accept', { merchantId: id })).status, 302);
  const again = await v.request('/smart-match/result');
  assert.equal(merchantIdOf(again.html), id, 'the accepted merchant must remain selected');
  assert.match(again.html, /Scan when you arrive/);
  assert.match((await v.request('/scan')).html, new RegExp('value="' + id + '"'));
});

// ---------------------------------------------------------------------------
// TEST V - Foursquare failure shows a clean state, never a crash or raw error
// ---------------------------------------------------------------------------

test('TEST V: Foursquare failure (missing key, error, timeout, malformed) keeps Smart Match usable', async function() {
  assert.equal((await getNearbyMerchants()).source, 'local-fallback');

  process.env.FOURSQUARE_API_KEY = 'test-key';
  global.fetch = async function() { throw new Error('network unavailable'); };
  assert.equal((await getNearbyMerchants({ latitude: 1.45, longitude: 103.82 })).source, 'local-fallback');

  global.fetch = async function() { return { ok: false, status: 500 }; };
  assert.equal((await getNearbyMerchants()).source, 'local-fallback');

  global.fetch = async function() { return { ok: true, json: async function() { return { results: [] }; } }; };
  assert.equal((await getNearbyMerchants()).source, 'local-fallback');

  global.fetch = async function() { return { ok: true, json: async function() { throw new SyntaxError('bad JSON'); } }; };
  assert.equal((await getNearbyMerchants()).source, 'local-fallback');

  global.fetch = function(url, options) {
    return new Promise(function(resolve, reject) {
      options.signal.addEventListener('abort', function() { reject(new Error('aborted')); });
    });
  };
  assert.equal((await getNearbyMerchants()).source, 'local-fallback');

  const v = visitor();
  await v.request('/smart-match/location', { status: 'fallback' });
  const match = await v.request('/smart-match/result');
  assert.equal(match.status, 200);
  assert.match(match.html, new RegExp('data-merchant-id="' + NEAREST_DEMO_MERCHANT_ID + '"'));
  assert.match(match.html, /Using demo location/);
});

// ---------------------------------------------------------------------------
// TEST W - only one recommendation region renders (no duplicate popups)
// ---------------------------------------------------------------------------

test('TEST W: only one Smart Match recommendation region renders, never a duplicate', async function() {
  process.env.FOURSQUARE_API_KEY = 'test-key';
  const mock = mockFoursquare([fsqPlace('flying-wok', 'Flying Wok', 'Chinese Restaurant')]);
  global.fetch = mock.fetchFn;
  const v = visitor();
  await v.request('/smart-match/location', { latitude: 1.44891, longitude: 103.83236 });
  await v.request('/smart-match/result');
  const home = await v.request('/home');
  const matches = home.html.match(/data-match-region/g) || [];
  assert.equal(matches.length, 1, 'there must be exactly one Smart Match region on the Home page');
  const cardMatches = home.html.match(/data-merchant-id="foursquare-flying-wok"/g) || [];
  assert.equal(cardMatches.length, 1, 'the recommendation must not be rendered twice');
});

// ---------------------------------------------------------------------------
// Preference / mood tri-state matching (Sprint 1.6 correctness, unaffected by provider choice)
// ---------------------------------------------------------------------------

test('mood and dietary matching use the exact UI preference values and distinguish MATCH / NON_MATCH / UNKNOWN', async function() {
  // moodCuisineOptions/dietaryPreferenceOptions values, verified against home.ejs/profile-preferences.ejs.
  const noodleMerchant = { category: 'noodles', cuisineTags: [] };
  assert.equal(getMoodMatchState(noodleMerchant, 'noodles'), MATCH_STATE.MATCH);
  const halalMerchant = { dietary: ['halal'] };
  assert.equal(getDietaryMatchState(halalMerchant, 'halal'), MATCH_STATE.MATCH);

  const matchMerchant = { category: 'foursquare.place', cuisineTags: ['indian'] };
  const nonMatchMerchant = { category: 'foursquare.place', cuisineTags: ['western'] };
  const unknownMerchant = { category: 'foursquare.place', cuisineTags: [] };
  assert.equal(getMoodMatchState(matchMerchant, 'indian'), MATCH_STATE.MATCH);
  assert.equal(getMoodMatchState(nonMatchMerchant, 'indian'), MATCH_STATE.NON_MATCH);
  assert.equal(getMoodMatchState(unknownMerchant, 'indian'), MATCH_STATE.UNKNOWN);

  const dietMatch = { dietary: ['halal'] };
  const dietNonMatch = { dietary: ['vegetarian'] };
  const dietUnknown = { dietary: [] };
  assert.equal(getDietaryMatchState(dietMatch, 'halal'), MATCH_STATE.MATCH);
  assert.equal(getDietaryMatchState(dietNonMatch, 'halal'), MATCH_STATE.NON_MATCH);
  assert.equal(getDietaryMatchState(dietUnknown, 'halal'), MATCH_STATE.UNKNOWN);
});

test('current mood outranks stored dietary preference for this session', async function() {
  // Dietary is now a hard, research-verified filter; both merchants are researched halal here so
  // the test keeps its original intent - among dietary-valid merchants, today's mood decides.
  setResearchKeys({ openai: true });
  const places = [fsqPlace('mood-match', 'Mood Match Noodles', 'Noodle Restaurant', { distance: 400 }),
    fsqPlace('pref-match', 'Preference Match Place', 'Restaurant', { distance: 400 })];
  const flow = mockDietFlow(places, answerAll({ halal: RESEARCH_STATUS.SUITABLE }));
  global.fetch = flow.fetchFn;
  const demo = createInitialDemo('jia');
  demo.profile.dietaryPreference = 'halal';
  demo.profile.moodCuisine = 'noodles';
  const nearby = await getNearbyMerchants({ latitude: 1.45, longitude: 103.82 });
  const result = await getSmartRecommendation(demo.profile, nearby.merchants, [], [], demo);
  assert.equal(result.merchant.merchantName, 'Mood Match Noodles');
});

test('a materially nearer candidate gets a meaningful ranking advantage', async function() {
  process.env.FOURSQUARE_API_KEY = 'test-key';
  const mock = mockFoursquare([
    fsqPlace('near', 'Near Place', 'Restaurant', { distance: 50 }),
    fsqPlace('far', 'Far Place', 'Restaurant', { distance: 1800 })
  ]);
  global.fetch = mock.fetchFn;
  const demo = createInitialDemo('jia');
  demo.profile.maxDistanceMinutes = 30;
  const nearby = await getNearbyMerchants({ latitude: 1.45, longitude: 103.82 });
  const result = await getSmartRecommendation(demo.profile, nearby.merchants, [], [], demo);
  assert.equal(result.merchant.merchantName, 'Near Place');
});

// ---------------------------------------------------------------------------
// SPRINT 1.9 — Merchant-only Smart Match + true per-device GPS
// ---------------------------------------------------------------------------

const fs = require('node:fs');
const path = require('node:path');
const appSource = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

test('1.9 TEST A: real supplied coordinates become the Foursquare ll parameter', async function() {
  process.env.FOURSQUARE_API_KEY = 'test-key';
  const mock = mockFoursquare([fsqPlace('a', 'Real Place', 'Restaurant')]);
  global.fetch = mock.fetchFn;
  const v = visitor();
  await v.request('/smart-match/location', { latitude: 1.3521, longitude: 103.8198 });
  await v.request('/smart-match/result');
  assert.equal(mock.getRequests()[0].ll, '1.3521,103.8198');
});

test('1.9 TEST B: two sessions retain independent locations - no cross-contamination', async function() {
  process.env.FOURSQUARE_API_KEY = 'test-key';
  const mock = mockFoursquare([fsqPlace('a', 'Some Place', 'Restaurant')]);
  global.fetch = mock.fetchFn;
  const sessionA = visitor();
  const sessionB = visitor();
  await sessionA.request('/smart-match/location', { latitude: 1.44891, longitude: 103.83236 }); // Sembawang/Canberra
  await sessionB.request('/smart-match/location', { latitude: 1.3526, longitude: 103.9448 }); // Tampines
  await sessionA.request('/smart-match/result');
  await sessionB.request('/smart-match/result');
  const requests = mock.getRequests();
  assert.equal(requests.length, 2);
  assert.equal(requests[0].ll, '1.44891,103.83236');
  assert.equal(requests[1].ll, '1.3526,103.9448');
  assert.notEqual(requests[0].ll, requests[1].ll, "session B must not inherit session A's coordinates");
});

test('1.9 TEST C: no hardcoded Canberra/test coordinates in runtime Smart Match discovery', async function() {
  // The lines that actually build the Foursquare request/demo fallback, isolated from this
  // test file itself and from comments that merely document the sprint's example coordinates.
  const runtimeLines = appSource.split('\n').filter(function(line) {
    return !line.trim().startsWith('//') && !line.trim().startsWith('*');
  }).join('\n');
  assert.ok(!runtimeLines.includes('1.44891'), 'runtime code must never hardcode the test-only coordinates');
  assert.ok(!runtimeLines.includes('103.83236'), 'runtime code must never hardcode the test-only coordinates');
});

test('1.9 TEST D: starting a new Smart Match with new coordinates updates the session discovery location', async function() {
  process.env.FOURSQUARE_API_KEY = 'test-key';
  const mock = mockFoursquare([fsqPlace('a', 'Some Place', 'Restaurant')]);
  global.fetch = mock.fetchFn;
  const v = visitor();
  await v.request('/smart-match/location', { latitude: 1.30, longitude: 103.85 });
  await v.request('/smart-match/result');
  await v.request('/smart-match/location', { latitude: 1.40, longitude: 103.90 });
  await v.request('/smart-match/result');
  const requests = mock.getRequests();
  assert.equal(requests.length, 2);
  assert.equal(requests[0].ll, '1.3,103.85');
  assert.equal(requests[1].ll, '1.4,103.9');
});

test('1.9 TEST E: rejection (Not for me) does not reacquire location or re-search', async function() {
  process.env.FOURSQUARE_API_KEY = 'test-key';
  const mock = mockFoursquare([
    fsqPlace('a', 'Merchant A', 'Restaurant'),
    fsqPlace('b', 'Merchant B', 'Restaurant')
  ]);
  global.fetch = mock.fetchFn;
  const v = visitor();
  await v.request('/smart-match/location', { latitude: 1.30, longitude: 103.85 });
  const first = merchantIdOf((await v.request('/smart-match/result')).html);
  await rejectCurrent(v, first, 'not-in-mood');
  await v.request('/smart-match/result');
  assert.equal(mock.getCalls(), 1, 'rejecting must never trigger another Foursquare search');
});

test('1.9 TEST F: a place named as another merchant\'s parent is suppressed, its children survive', async function() {
  process.env.FOURSQUARE_API_KEY = 'test-key';
  const mock = mockFoursquare([
    fsqPlace('parent-p', 'Yong Li Coffee Station', 'Coffee Shop'),
    fsqPlace('child-a', 'Flying Wok', 'Chinese Restaurant',
      { related_places: { parent: { fsq_place_id: 'parent-p', name: 'Yong Li Coffee Station' } } }),
    fsqPlace('child-b', 'Kalsom Street Food', 'Malay Restaurant',
      { related_places: { parent: { fsq_place_id: 'parent-p', name: 'Yong Li Coffee Station' } } })
  ]);
  global.fetch = mock.fetchFn;
  const nearby = await getNearbyMerchants({ latitude: 1.45, longitude: 103.82 });
  const names = nearby.merchants.map(function(m) { return m.merchantName; });
  assert.ok(names.includes('Flying Wok'));
  assert.ok(names.includes('Kalsom Street Food'));
  assert.ok(!names.includes('Yong Li Coffee Station'),
    'a place acting as another merchant\'s parent must not itself become a recommendation');
});

test('1.9 TEST G: the child merchant keeps its own identity with the parent as display context', async function() {
  process.env.FOURSQUARE_API_KEY = 'test-key';
  const mock = mockFoursquare([
    fsqPlace('child-a', 'Flying Wok', 'Chinese Restaurant', { distance: 46,
      related_places: { parent: { fsq_place_id: 'parent-p', name: 'Yong Li Coffee Station' } } })
  ]);
  global.fetch = mock.fetchFn;
  const v = visitor();
  await v.request('/smart-match/location', { latitude: 1.45, longitude: 103.82 });
  const match = await v.request('/smart-match/result');
  assert.match(match.html, /data-merchant-id="foursquare-child-a"/);
  assert.match(match.html, /Flying Wok/);
  assert.match(match.html, /Yong Li Coffee Station/);
  assert.match(match.html, /46 m away/);
});

test('1.9 TEST H: a standalone restaurant with no parent remains a valid candidate', async function() {
  process.env.FOURSQUARE_API_KEY = 'test-key';
  const mock = mockFoursquare([fsqPlace('kfc', "KFC", 'Fast Food Restaurant')]);
  global.fetch = mock.fetchFn;
  const nearby = await getNearbyMerchants({ latitude: 1.45, longitude: 103.82 });
  assert.ok(nearby.merchants.some(function(m) { return m.merchantName === 'KFC'; }));
});

test('1.9 TEST I: a standalone café with no child/parent evidence remains valid', async function() {
  process.env.FOURSQUARE_API_KEY = 'test-key';
  const mock = mockFoursquare([fsqPlace('cafe', 'Independent Café', 'Café')]);
  global.fetch = mock.fetchFn;
  const nearby = await getNearbyMerchants({ latitude: 1.45, longitude: 103.82 });
  assert.ok(nearby.merchants.some(function(m) { return m.merchantName === 'Independent Café'; }),
    'a standalone café must not be excluded just because its category name contains "café"');
});

test('1.9 TEST J: a Food Court category candidate is excluded even without a parent linkage', async function() {
  process.env.FOURSQUARE_API_KEY = 'test-key';
  const mock = mockFoursquare([fsqPlace('fc', 'Some Food Court', 'Food Court')]);
  global.fetch = mock.fetchFn;
  const nearby = await getNearbyMerchants({ latitude: 1.45, longitude: 103.82 });
  assert.ok(!nearby.merchants.some(function(m) { return m.merchantName === 'Some Food Court'; }));
});

test('1.9 TEST K: two different stalls at the same address remain separate candidates', async function() {
  process.env.FOURSQUARE_API_KEY = 'test-key';
  const mock = mockFoursquare([
    fsqPlace('a', 'Kalsom Street Food', 'Malay Restaurant', { latitude: 1.4501, longitude: 103.8201 }),
    fsqPlace('b', 'Flying Wok', 'Chinese Restaurant', { latitude: 1.4502, longitude: 103.8202 })
  ]);
  global.fetch = mock.fetchFn;
  const nearby = await getNearbyMerchants({ latitude: 1.45, longitude: 103.82 });
  const names = nearby.merchants.map(function(m) { return m.merchantName; });
  assert.ok(names.includes('Kalsom Street Food'));
  assert.ok(names.includes('Flying Wok'));
});

test('1.9 TEST L: a child merchant uses its own factual distance, never the parent\'s', async function() {
  process.env.FOURSQUARE_API_KEY = 'test-key';
  const mock = mockFoursquare([
    fsqPlace('parent-p', 'Yong Li Coffee Station', 'Coffee Shop', { distance: 500 }),
    fsqPlace('child-a', 'Flying Wok', 'Chinese Restaurant', { distance: 46,
      related_places: { parent: { fsq_place_id: 'parent-p', name: 'Yong Li Coffee Station' } } })
  ]);
  global.fetch = mock.fetchFn;
  const nearby = await getNearbyMerchants({ latitude: 1.45, longitude: 103.82 });
  const flyingWok = nearby.merchants.find(function(m) { return m.merchantName === 'Flying Wok'; });
  assert.equal(flyingWok.distanceMetres, 46);
});

// ---------------------------------------------------------------------------
// SPRINT 1.10 — Craving-aware Foursquare search + fresh GPS + no repeat merchants
// ---------------------------------------------------------------------------

test('TEST A: a specific craving changes the Foursquare query', async function() {
  process.env.FOURSQUARE_API_KEY = 'test-key';
  const mock = mockFoursquareByQuery({ bread: [fsqPlace('a', 'Corner Bakery', 'Bakery')] });
  global.fetch = mock.fetchFn;
  const demo = createInitialDemo('jia');
  demo.profile.craving = 'bread';
  await getNearbyMerchants({ latitude: 1.45, longitude: 103.82 }, demo.user.id, demo.profile.craving);
  assert.equal(mock.getRequests()[0].query, 'bread');
});

test('TEST B: an empty/anything craving uses the broad food query', async function() {
  process.env.FOURSQUARE_API_KEY = 'test-key';
  const mock = mockFoursquareByQuery({ food: [fsqPlace('a', 'Some Place', 'Restaurant')] });
  global.fetch = mock.fetchFn;
  await getNearbyMerchants({ latitude: 1.45, longitude: 103.82 }, 'jia', '');
  assert.equal(mock.getRequests()[0].query, 'food');
  await getNearbyMerchants({ latitude: 1.45, longitude: 103.82 }, 'jia', 'anything');
  assert.equal(mock.getCalls(), 1, 'the same normalised food query should reuse discovery');
});

test('TEST C: a specific craving with too few results triggers at most one broader food fallback', async function() {
  process.env.FOURSQUARE_API_KEY = 'test-key';
  const mock = mockFoursquareByQuery({
    bread: [fsqPlace('a', 'Corner Bakery', 'Bakery')], // only 1 result - below MIN_CRAVING_POOL_SIZE
    food: [fsqPlace('a', 'Corner Bakery', 'Bakery'), fsqPlace('b', 'Some Diner', 'Restaurant'),
      fsqPlace('c', 'Another Place', 'Restaurant'), fsqPlace('d', 'Yet Another', 'Restaurant'),
      fsqPlace('e', 'Last One', 'Restaurant')]
  });
  global.fetch = mock.fetchFn;
  const nearby = await getNearbyMerchants({ latitude: 1.45, longitude: 103.82 }, 'jia', 'bread');
  const requests = mock.getRequests();
  assert.equal(requests.length, 2, 'exactly one fallback search should occur');
  assert.equal(requests[0].query, 'bread');
  assert.equal(requests[1].query, 'food');
  const names = nearby.merchants.map(function(m) { return m.merchantName; });
  assert.ok(names.includes('Corner Bakery'));
  assert.ok(names.includes('Some Diner'), 'the fallback pool must be merged in');
});

test('TEST D: without AI, the fallback nudges a merchant that literally names the craving', async function() {
  process.env.FOURSQUARE_API_KEY = 'test-key';
  const mock = mockFoursquareByQuery({ bakery: [
    fsqPlace('bakery', 'Corner Bakery', 'Bakery', { distance: 300 }),
    fsqPlace('generic', 'Generic Restaurant', 'Restaurant', { distance: 100 })
  ] });
  global.fetch = mock.fetchFn;
  const demo = createInitialDemo('jia');
  demo.profile.craving = 'bakery';
  demo.profile.maxDistanceMinutes = 30;
  const nearby = await getNearbyMerchants({ latitude: 1.45, longitude: 103.82 }, 'jia', 'bakery');
  const result = await getSmartRecommendation(demo.profile, nearby.merchants, [], [], demo);
  assert.equal(result.merchant.merchantName, 'Corner Bakery',
    'the user\'s own words appearing in factual data must outrank a nearer generic restaurant');
});

test('TEST E: the literal craving check uses only the user\'s words - no vocabulary, no fabrication', function() {
  const merchant = function(name, category) {
    return { merchantName: name, itemName: null, categoryLabel: category, categoryNames: [category], cuisineTags: [], dietary: [] };
  };
  assert.equal(merchantMentionsCraving(merchant('Food Leaf', 'Restaurant'), 'bread'), false);
  assert.equal(merchantMentionsCraving(merchant('Corner Bakery', 'Bakery'), 'bread'), false,
    'bread -> bakery is semantic and belongs to the AI, not a hardcoded mapping');
  assert.equal(merchantMentionsCraving(merchant('Bread Society', 'Café'), 'bread'), true);
  assert.equal(merchantMentionsCraving(merchant('Prime Steakhouse', 'Steakhouse'), 'tea'), false,
    'whole-word only: "tea" must not match inside "Steakhouse"');
  assert.equal(merchantMentionsCraving(merchant('Bread Society', 'Café'), 'anything'), false);
});

test('TEST F: fresh GPS options use enableHighAccuracy and maximumAge 0', async function() {
  const scriptSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'script.js'), 'utf8');
  assert.match(scriptSource, /enableHighAccuracy:\s*true/);
  assert.match(scriptSource, /maximumAge:\s*0/);
});

test('TEST G: geolocation failure does not automatically call Foursquare around a demo location', async function() {
  const scriptSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'script.js'), 'utf8');
  // The old auto-fallback behaviour posted {status:'fallback'} whenever geolocation failed.
  // It must now require an explicit "Use demo location" tap instead.
  assert.match(scriptSource, /data-use-demo-location/);
  assert.match(scriptSource, /data-retry-location/);
  assert.ok(!/resolve\(location \|\| \{ status: 'fallback' \}\)/.test(scriptSource),
    'geolocation failure must not silently substitute a fallback location');
});

test('TEST H: a shown merchant is excluded from the very next recommendation', async function() {
  process.env.FOURSQUARE_API_KEY = 'test-key';
  const mock = mockFoursquare([fsqPlace('a', 'Merchant A', 'Restaurant'), fsqPlace('b', 'Merchant B', 'Restaurant')]);
  global.fetch = mock.fetchFn;
  const v = visitor();
  await v.request('/smart-match/location', { latitude: 1.45, longitude: 103.82 });
  const first = merchantIdOf((await v.request('/smart-match/result')).html);
  await rejectCurrent(v, first, 'not-in-mood');
  const next = merchantIdOf((await v.request('/smart-match/result')).html);
  assert.notEqual(next, first);
});

test('TEST I: a repeated rejection sequence exhausts unseen merchants before any repeat', async function() {
  process.env.FOURSQUARE_API_KEY = 'test-key';
  const mock = mockFoursquare([
    fsqPlace('a', 'Merchant A', 'Restaurant'), fsqPlace('b', 'Merchant B', 'Restaurant'),
    fsqPlace('c', 'Merchant C', 'Restaurant'), fsqPlace('d', 'Merchant D', 'Restaurant')
  ]);
  global.fetch = mock.fetchFn;
  const v = visitor();
  await v.request('/smart-match/location', { latitude: 1.45, longitude: 103.82 });
  const seen = [];
  for (let i = 0; i < 4; i++) {
    const id = merchantIdOf((await v.request('/smart-match/result')).html);
    assert.ok(id);
    assert.ok(!seen.includes(id), 'merchant repeated before the pool was exhausted: ' + id);
    seen.push(id);
    await rejectCurrent(v, id, 'not-in-mood');
  }
  assert.equal(seen.length, 4);
});

test('TEST J: Too far still excludes the already-shown merchant and requires strictly closer', async function() {
  process.env.FOURSQUARE_API_KEY = 'test-key';
  const mock = mockFoursquare([
    fsqPlace('a', 'Merchant A', 'Restaurant', { distance: 900 }),
    fsqPlace('b', 'Merchant B', 'Restaurant', { distance: 700 }),
    fsqPlace('c', 'Merchant C', 'Restaurant', { distance: 500 }),
    fsqPlace('d', 'Merchant D', 'Restaurant', { distance: 1200 })
  ]);
  global.fetch = mock.fetchFn;
  const demo = createInitialDemo('jia');
  demo.profile.maxDistanceMinutes = 30;
  const nearby = await getNearbyMerchants({ latitude: 1.45, longitude: 103.82 });
  const feedback = [{ merchantId: 'foursquare-a', reason: 'too-far', category: 'foursquare.place', distanceMetres: 900 }];
  const result = await getSmartRecommendation(demo.profile, nearby.merchants, ['foursquare-a'], feedback, demo,
    ['foursquare-a']);
  assert.ok(result.merchant && ['Merchant B', 'Merchant C'].includes(result.merchant.merchantName));
});

test('TEST K: editing filters preserves shown history - unseen merchants are preferred', async function() {
  process.env.FOURSQUARE_API_KEY = 'test-key';
  const mock = mockFoursquare([
    fsqPlace('a', 'Merchant A', 'Restaurant'), fsqPlace('b', 'Merchant B', 'Restaurant'),
    fsqPlace('c', 'Merchant C', 'Restaurant')
  ]);
  global.fetch = mock.fetchFn;
  const v = visitor();
  await v.request('/smart-match/location', { latitude: 1.45, longitude: 103.82 });
  const first = merchantIdOf((await v.request('/smart-match/result')).html);
  await v.request('/profile', { dietaryPreference: 'none', budget: '10', maxDistanceMinutes: '30' });
  await v.request('/smart-match/location', { latitude: 1.45, longitude: 103.82 });
  const afterEdit = merchantIdOf((await v.request('/smart-match/result')).html);
  assert.notEqual(afterEdit, first, 'the merchant already shown before the filter edit must not reappear immediately');
});

test('TEST L: changing craving preserves history - a merchant already shown stays excluded', async function() {
  process.env.FOURSQUARE_API_KEY = 'test-key';
  const mock = mockFoursquareByQuery({
    food: [fsqPlace('a', 'Merchant A', 'Restaurant')],
    bread: [fsqPlace('a', 'Merchant A', 'Restaurant'), fsqPlace('bakery', 'Corner Bakery', 'Bakery')]
  });
  global.fetch = mock.fetchFn;
  const v = visitor();
  await v.request('/smart-match/location', { latitude: 1.45, longitude: 103.82 });
  const first = merchantIdOf((await v.request('/smart-match/result')).html);
  assert.equal(first, 'foursquare-a');
  await v.request('/profile', { dietaryPreference: 'none', budget: '10', maxDistanceMinutes: '30', craving: 'bread' });
  await v.request('/smart-match/location', { latitude: 1.45, longitude: 103.82 });
  const afterCravingChange = merchantIdOf((await v.request('/smart-match/result')).html);
  assert.equal(afterCravingChange, 'foursquare-bakery',
    'Merchant A was already shown, so the unseen Corner Bakery should be preferred');
});

test('TEST M: shown history does not leak across sessions', async function() {
  process.env.FOURSQUARE_API_KEY = 'test-key';
  const mock = mockFoursquare([fsqPlace('x', 'Merchant X', 'Restaurant')]);
  global.fetch = mock.fetchFn;
  const sessionA = visitor();
  const sessionB = visitor();
  await sessionA.request('/smart-match/location', { latitude: 1.45, longitude: 103.82 });
  const shownToA = merchantIdOf((await sessionA.request('/smart-match/result')).html);
  assert.equal(shownToA, 'foursquare-x');

  await sessionB.request('/smart-match/location', { latitude: 1.45, longitude: 103.82 });
  const shownToB = merchantIdOf((await sessionB.request('/smart-match/result')).html);
  assert.equal(shownToB, 'foursquare-x', "session B must still be able to receive X - A's history must not leak");
});

test('TEST N: pool exhaustion allows controlled recycling, never the just-rejected merchant', async function() {
  process.env.FOURSQUARE_API_KEY = 'test-key';
  const mock = mockFoursquare([fsqPlace('a', 'Merchant A', 'Restaurant'), fsqPlace('b', 'Merchant B', 'Restaurant')]);
  global.fetch = mock.fetchFn;
  const v = visitor();
  await v.request('/smart-match/location', { latitude: 1.45, longitude: 103.82 });
  const first = merchantIdOf((await v.request('/smart-match/result')).html);
  await rejectCurrent(v, first, 'not-in-mood');
  const second = merchantIdOf((await v.request('/smart-match/result')).html);
  assert.notEqual(second, first);
  await rejectCurrent(v, second, 'not-in-mood');
  // Pool of 2 is now exhausted (both shown/rejected) - recycling must kick in rather than an
  // empty state, and it must not immediately return the merchant JUST rejected (`second`).
  const recycled = await v.request('/smart-match/result');
  const recycledId = merchantIdOf(recycled.html);
  assert.ok(recycledId, 'a recycled recommendation should still be offered rather than a dead end');
  assert.notEqual(recycledId, second, 'must not immediately return the merchant just rejected');
  assert.equal(recycledId, first, 'the least-recently-shown merchant should recycle first');
});

test('TEST O: OpenAI failure - rule-based fallback still respects shown/rejected history', async function() {
  process.env.FOURSQUARE_API_KEY = 'test-key';
  process.env.OPENAI_API_KEY = 'test-key';
  const placesMock = mockFoursquare([fsqPlace('a', 'Merchant A', 'Restaurant'), fsqPlace('b', 'Merchant B', 'Restaurant')]);
  global.fetch = async function(url, options) {
    if (String(url).indexOf('openai') !== -1) throw new Error('OpenAI unavailable');
    return placesMock.fetchFn(url, options);
  };
  const demo = createInitialDemo('jia');
  const nearby = await getNearbyMerchants({ latitude: 1.45, longitude: 103.82 });
  const result = await getSmartRecommendation(demo.profile, nearby.merchants, [], [], demo, ['foursquare-a']);
  assert.equal(result.merchant.merchantName, 'Merchant B', 'the already-shown merchant must stay excluded via fallback too');
});

test('TEST P: Not for me performs zero additional Foursquare requests', async function() {
  process.env.FOURSQUARE_API_KEY = 'test-key';
  const mock = mockFoursquare([
    fsqPlace('a', 'Merchant A', 'Restaurant'), fsqPlace('b', 'Merchant B', 'Restaurant'),
    fsqPlace('c', 'Merchant C', 'Restaurant')
  ]);
  global.fetch = mock.fetchFn;
  const v = visitor();
  await v.request('/smart-match/location', { latitude: 1.45, longitude: 103.82 });
  await v.request('/smart-match/result');
  const callsAfterFirst = mock.getCalls();
  const first = merchantIdOf((await v.request('/smart-match/result')).html);
  await rejectCurrent(v, first, 'not-in-mood');
  await v.request('/smart-match/result');
  assert.equal(mock.getCalls(), callsAfterFirst, 'rejecting must trigger zero additional Foursquare requests');
});

test('TEST Q: merchant-only filtering (container suppression) remains intact', async function() {
  process.env.FOURSQUARE_API_KEY = 'test-key';
  const mock = mockFoursquare([fsqPlace('fc', 'Some Food Court', 'Food Court')]);
  global.fetch = mock.fetchFn;
  const nearby = await getNearbyMerchants({ latitude: 1.45, longitude: 103.82 });
  assert.ok(!nearby.merchants.some(function(m) { return m.merchantName === 'Some Food Court'; }));
});

test('TEST R: choosing a merchant still flows into Scan when you arrive', async function() {
  process.env.FOURSQUARE_API_KEY = 'test-key';
  const mock = mockFoursquare([fsqPlace('a', 'Merchant A', 'Restaurant')]);
  global.fetch = mock.fetchFn;
  const v = visitor();
  await v.request('/smart-match/location', { latitude: 1.45, longitude: 103.82 });
  const id = merchantIdOf((await v.request('/smart-match/result')).html);
  assert.equal((await v.request('/recommendation/accept', { merchantId: id })).status, 302);
  const again = await v.request('/smart-match/result');
  assert.equal(merchantIdOf(again.html), id);
  assert.match(again.html, /Scan when you arrive/);
  assert.match((await v.request('/scan')).html, new RegExp('value="' + id + '"'));
});

// ---------------------------------------------------------------------------
// CONTAINER / STALL FIX - combined-result parent detection + conservative name rules
// ---------------------------------------------------------------------------

async function containerPoolNames(results) {
  process.env.FOURSQUARE_API_KEY = 'test-key';
  global.fetch = mockFoursquare(results).fetchFn;
  const nearby = await getNearbyMerchants({ latitude: 1.45, longitude: 103.82 });
  return nearby.merchants.map(function(m) { return m.merchantName; });
}

test('CONTAINER A: parent from the craving search is suppressed by a child from the food fallback', async function() {
  process.env.FOURSQUARE_API_KEY = 'test-key';
  const mock = mockFoursquareByQuery({
    'chicken rice': [fsqPlace('parent-p', 'Yong Li Coffee Station', 'Coffee Shop')],
    food: [fsqPlace('child-a', 'Flying Wok', 'Chinese Restaurant', { distance: 46,
      related_places: { parent: { fsq_place_id: 'parent-p' } } })]
  });
  global.fetch = mock.fetchFn;
  const nearby = await getNearbyMerchants({ latitude: 1.45, longitude: 103.82 }, 'jia', 'chicken rice');
  const names = nearby.merchants.map(function(m) { return m.merchantName; });
  assert.deepEqual(mock.getRequests().map(function(r) { return r.query; }), ['chicken rice', 'food']);
  assert.ok(!names.includes('Yong Li Coffee Station'), 'the parent must be suppressed across both responses');
  const stall = nearby.merchants.find(function(m) { return m.merchantName === 'Flying Wok'; });
  assert.ok(stall, 'the child stall must be kept');
  assert.equal(stall.parentVenueName, 'Yong Li Coffee Station',
    'the parent name is taken from the factual parent place in the combined results');
});

test('CONTAINER B: a Food Court category venue is excluded', async function() {
  const names = await containerPoolNames([fsqPlace('fc', 'Blk 105 Eats', 'Food Court'),
    fsqPlace('s', 'Flying Wok', 'Chinese Restaurant')]);
  assert.ok(!names.includes('Blk 105 Eats'));
  assert.ok(names.includes('Flying Wok'));
});

test('CONTAINER C: an obvious container name is excluded', async function() {
  const names = await containerPoolNames([fsqPlace('fc', 'ABC Food Centre', 'Restaurant'),
    fsqPlace('k', 'Chong Pang Kopitiam', 'Café'), fsqPlace('s', 'Flying Wok', 'Chinese Restaurant')]);
  assert.ok(!names.includes('ABC Food Centre'));
  assert.ok(!names.includes('Chong Pang Kopitiam'));
  assert.ok(names.includes('Flying Wok'));
});

test('CONTAINER D: a "Coffee Shop" named parent with child stalls is excluded', async function() {
  const names = await containerPoolNames([
    fsqPlace('parent-p', 'Yong Li Coffee Shop', 'Coffee Shop'),
    fsqPlace('child-a', 'Flying Wok', 'Chinese Restaurant',
      { related_places: { parent: { fsq_place_id: 'parent-p', name: 'Yong Li Coffee Shop' } } })
  ]);
  assert.ok(!names.includes('Yong Li Coffee Shop'));
  assert.ok(names.includes('Flying Wok'));
});

test('CONTAINER E: a café brand containing "Coffee" is not treated as a container', async function() {
  const names = await containerPoolNames([fsqPlace('cb', 'The Coffee Bean & Tea Leaf', 'Coffee Shop')]);
  assert.ok(names.includes('The Coffee Bean & Tea Leaf'));
});

test('CONTAINER F: a standalone Coffee Shop/Café category with no container evidence stays valid', async function() {
  const names = await containerPoolNames([fsqPlace('a', 'Brew Lab', 'Coffee Shop'),
    fsqPlace('b', 'Common Man Roasters', 'Café')]);
  assert.ok(names.includes('Brew Lab'));
  assert.ok(names.includes('Common Man Roasters'));
});

test('CONTAINER G: two different stalls in the same coffee shop both remain', async function() {
  process.env.FOURSQUARE_API_KEY = 'test-key';
  const parent = { related_places: { parent: { fsq_place_id: 'parent-p', name: 'Yong Li Coffee Station' } } };
  global.fetch = mockFoursquare([
    fsqPlace('parent-p', 'Yong Li Coffee Station', 'Coffee Shop'),
    fsqPlace('a', 'Flying Wok', 'Chinese Restaurant', Object.assign({ latitude: 1.4501, longitude: 103.8201 }, parent)),
    fsqPlace('b', 'Kalsom Street Food', 'Malay Restaurant', Object.assign({ latitude: 1.4501, longitude: 103.8201 }, parent))
  ]).fetchFn;
  const nearby = await getNearbyMerchants({ latitude: 1.45, longitude: 103.82 });
  const stalls = nearby.merchants.filter(function(m) { return m.parentVenueName === 'Yong Li Coffee Station'; });
  assert.deepEqual(stalls.map(function(m) { return m.merchantName; }).sort(), ['Flying Wok', 'Kalsom Street Food']);
  assert.ok(!nearby.merchants.some(function(m) { return m.merchantName === 'Yong Li Coffee Station'; }));
});

test('CONTAINER H: a known container with no child result is excluded, with no fabricated stall', async function() {
  const names = await containerPoolNames([fsqPlace('fc', 'ABC Food Centre', 'Food Court'),
    fsqPlace('s', 'Food Leaf', 'Restaurant')]);
  assert.deepEqual(names, ['Food Leaf']);
});

// ---------------------------------------------------------------------------
// CRAVING - free-text craving, AI semantic ranking over rule-approved candidates only
// ---------------------------------------------------------------------------

// Mocks Foursquare plus OpenAI, recording the merchant IDs and prompt the AI was actually shown.
function mockFoursquareAndAI(results, aiReply) {
  const seen = { ids: [], prompt: '' };
  const foursquare = Array.isArray(results) ? mockFoursquare(results) : mockFoursquareByQuery(results);
  const fetchFn = async function(url, options) {
    if (new URL(String(url)).hostname === 'api.openai.com') {
      const body = JSON.parse(String(options.body));
      seen.prompt = body.messages.map(function(m) { return m.content; }).join('\n');
      const listed = seen.prompt.match(/"id":"(foursquare-[^"]+)"/g) || [];
      seen.ids = listed.map(function(entry) { return entry.slice(6, -1); });
      if (aiReply === 'throw') throw new Error('provider unavailable');
      return aiReply;
    }
    return foursquare.fetchFn(url, options);
  };
  return { fetchFn: fetchFn, seen: seen, getRequests: foursquare.getRequests };
}

async function recommendFor(craving, results, aiReply, setup) {
  process.env.FOURSQUARE_API_KEY = 'test-key';
  clearDiscoveryCache();
  process.env.OPENAI_API_KEY = 'test-openai';
  const mock = mockFoursquareAndAI(results, aiReply);
  global.fetch = mock.fetchFn;
  const demo = createInitialDemo('jia');
  demo.profile.craving = craving;
  demo.profile.maxDistanceMinutes = 30;
  const nearby = await getNearbyMerchants({ latitude: 1.45, longitude: 103.82 }, 'jia', craving);
  const extra = setup ? setup(demo) : {};
  const result = await getSmartRecommendation(demo.profile, nearby.merchants, extra.rejected || [],
    extra.feedback || [], demo, []);
  return { result: result, seen: mock.seen, requests: mock.getRequests() };
}

const crispyPlaces = [
  fsqPlace('chicken', 'Seoul Bites', 'Korean Restaurant', { distance: 400,
    categories: [{ name: 'Korean Restaurant' }, { name: 'Fried Chicken Joint' }] }),
  fsqPlace('bakery', 'Corner Bakery', 'Bakery', { distance: 200 }),
  fsqPlace('generic', 'Food Leaf', 'Restaurant', { distance: 100 })
];

test('CRAVING A: arbitrary craving - AI semantically picks the fried chicken merchant', async function() {
  const reason = 'Its Fried Chicken Joint category is a close fit for your crispy chicken craving.';
  const { result, seen } = await recommendFor('crispy chicken', crispyPlaces,
    aiResponse('foursquare-chicken', reason, 'high'));
  assert.equal(result.merchant.merchantName, 'Seoul Bites');
  assert.equal(result.reason, reason);
  assert.deepEqual(seen.ids.sort(), ['foursquare-bakery', 'foursquare-chicken', 'foursquare-generic'],
    'the AI ranks every rule-approved candidate; no craving pre-gating');
  assert.match(seen.prompt, /Fried Chicken Joint/, 'all factual Foursquare category names are supplied');
});

test('CRAVING B: a phrase with no mapping anywhere still gets an AI recommendation', async function() {
  const { result } = await recommendFor('warm comforting food', crispyPlaces,
    aiResponse('foursquare-generic', 'Food Leaf is the nearest restaurant, 100 m away.', 'medium'));
  assert.equal(result.merchant.merchantName, 'Food Leaf');
  assert.equal(result.reason, 'Food Leaf is the nearest restaurant, 100 m away.');
});

test('CRAVING C: a strange craving still recommends, with honest low-relevance wording', async function() {
  const { result } = await recommendFor('purple unicorn noodles', crispyPlaces,
    aiResponse('foursquare-generic', 'Food Leaf serves purple unicorn noodles.', 'low'));
  assert.equal(result.merchant.merchantName, 'Food Leaf');
  assert.equal(result.reason, 'This is the closest available fit from the nearby options.');
});

test('CRAVING D: an AI merchant ID outside the candidates is rejected for the fallback', async function() {
  const { result } = await recommendFor('crispy chicken', crispyPlaces,
    aiResponse('foursquare-invented', 'A place I made up.', 'high'));
  assert.ok(result.merchant && result.merchant.id !== 'foursquare-invented');
  assert.equal(result.reason, null, 'fallback picks carry no AI reason');
});

test('CRAVING E: the AI cannot select a rejected merchant', async function() {
  const { result, seen } = await recommendFor('crispy chicken', crispyPlaces,
    aiResponse('foursquare-chicken', 'Fried chicken fit.', 'high'),
    function() { return { rejected: ['foursquare-chicken'] }; });
  assert.ok(!seen.ids.includes('foursquare-chicken'), 'a rejected merchant is never even shown to the AI');
  assert.notEqual(result.merchant.id, 'foursquare-chicken');
});

test('CRAVING F: the AI cannot bypass the Too far constraint', async function() {
  const { result, seen } = await recommendFor('crispy chicken', crispyPlaces,
    aiResponse('foursquare-chicken', 'Fried chicken fit.', 'high'),
    function() { return { feedback: [{ merchantId: 'foursquare-x', reason: 'too-far', category: 'foursquare.place',
      price: null, distanceMinutes: 4, distanceMetres: 300, cuisineTags: [] }] }; });
  assert.ok(!seen.ids.includes('foursquare-chicken'), 'the 400 m merchant is removed before the AI sees it');
  assert.ok(result.merchant.distanceMetres < 300);
});

test('CRAVING G: an AI exception still returns a valid fallback merchant', async function() {
  const { result } = await recommendFor('crispy chicken', crispyPlaces, 'throw');
  assert.ok(['foursquare-chicken', 'foursquare-bakery', 'foursquare-generic'].includes(result.merchant.id));
  assert.equal(result.reason, null);
});

test('CRAVING H: the raw craving is still the Foursquare query', async function() {
  const { requests } = await recommendFor('crispy chicken', { 'crispy chicken': crispyPlaces.concat([
    fsqPlace('d', 'Place D', 'Restaurant'), fsqPlace('e', 'Place E', 'Restaurant')]) },
  aiResponse('foursquare-chicken', 'Fried chicken fit.', 'high'));
  assert.deepEqual(requests.map(function(r) { return r.query; }), ['crispy chicken']);
});

test('CRAVING I: one broad food fallback still runs, and the merged pool is ranked by AI', async function() {
  const { result, seen, requests } = await recommendFor('crispy chicken', {
    'crispy chicken': [crispyPlaces[0]],
    food: [fsqPlace('near', 'Food Leaf', 'Restaurant', { distance: 20 })]
  }, aiResponse('foursquare-chicken', 'Its Fried Chicken Joint category fits your craving.', 'high'));
  assert.deepEqual(requests.map(function(r) { return r.query; }), ['crispy chicken', 'food']);
  assert.deepEqual(seen.ids.sort(), ['foursquare-chicken', 'foursquare-near']);
  assert.equal(result.merchant.merchantName, 'Seoul Bites');
});

test('CRAVING J: a reason citing a supplied category is kept', async function() {
  const reason = 'Categorised as a Bakery, a good fit for something sweet.';
  const { result } = await recommendFor('something sweet', crispyPlaces, aiResponse('foursquare-bakery', reason, 'medium'));
  assert.equal(result.reason, reason);
});

test('CRAVING K: a reason claiming unsupported menu, dietary, price or rating facts is dropped', async function() {
  const claims = ['Food Leaf serves great crispy chicken wings.', 'A halal-certified spot nearby.',
    'Cheap and filling, well within your budget.', 'Highly rated by locals.'];
  for (const claim of claims) {
    const { result } = await recommendFor('crispy chicken', crispyPlaces, aiResponse('foursquare-generic', claim, 'high'));
    assert.equal(result.merchant.merchantName, 'Food Leaf', 'the valid pick itself is kept');
    assert.equal(result.reason, null, 'unsupported claim must not be shown: ' + claim);
  }
});

test('CRAVING L: a craving that appears nowhere in the source still produces an AI recommendation', async function() {
  const craving = 'zqx' + Date.now() + ' glimmerberry stew';
  const source = require('fs').readFileSync(require('path').join(__dirname, '..', 'app.js'), 'utf8');
  assert.ok(!source.includes('glimmerberry'));
  const { result, requests } = await recommendFor(craving, crispyPlaces,
    aiResponse('foursquare-bakery', 'Corner Bakery is the closest fit on offer.', 'low'));
  assert.equal(requests[0].query, craving);
  assert.equal(result.merchant.merchantName, 'Corner Bakery');
});

// ---------------------------------------------------------------------------
// MERCHANT RESEARCH - targeted Tavily search -> batched Tavily Extract -> common analysis
// (Groq primary, OpenAI fallback) -> one validator -> cached verdict per merchant + diet
// ---------------------------------------------------------------------------

const MENU_URL = 'https://www.example-merchant.sg/menu';
const RESEARCH_SYSTEM_MARKER = 'You verify ONE dietary requirement';

function tavilyReply(results) {
  return { ok: true, json: async function() {
    return { results: results || [{ title: 'Official menu', url: MENU_URL, content: 'Current menu and prices.' }] };
  } };
}

// Default extract: every requested URL returns a readable page.
function extractPages(pageFor) {
  return function(urls) {
    return { ok: true, json: async function() {
      return { results: urls.map(function(url) {
        return { url: url, raw_content: pageFor ? pageFor(url) : 'Menu page for ' + url + '. ' + 'Our dishes and prices. '.repeat(20) };
      }).filter(function(r) { return r.raw_content !== null; }), failed_results: [] };
    } };
  };
}

function chatReply(payload) {
  return { ok: true, json: async function() {
    return { choices: [{ message: { content: typeof payload === 'string' ? payload : JSON.stringify(payload) } }] };
  } };
}

// One single-diet verdict entry as a provider would return it.
function verdictFor(id, status, overrides) {
  const suitable = status === RESEARCH_STATUS.SUITABLE;
  return Object.assign({ merchantId: id, identified: true, status: status,
    evidence: status === RESEARCH_STATUS.UNKNOWN ? '' : 'Official menu page states this.',
    matchingItems: suitable ? [{ name: 'Evidenced Dish', price: null, sourceUrl: MENU_URL }] : [],
    sources: [{ title: 'Official menu', url: MENU_URL, sourceType: 'official' }] }, overrides || {});
}

// opts: { vegetarian|vegan|halal: status, items: [...], overrides } - answers for the requested diet.
function answerAll(opts) {
  opts = opts || {};
  return function(ids, diet) {
    return chatReply({ results: ids.map(function(id) {
      const status = opts[diet] || RESEARCH_STATUS.UNKNOWN;
      const extra = Object.assign({}, opts.overrides || {});
      if (opts.items && status === RESEARCH_STATUS.SUITABLE) {
        extra.matchingItems = opts.items.map(function(item) { return Object.assign({ sourceUrl: MENU_URL, price: null }, item); });
      }
      return verdictFor(id, status, extra);
    }) });
  };
}

// Mocks Foursquare, Tavily search/extract, Groq research, OpenAI research and the OpenAI ranker.
// research / options.openaiResearch: responder(ids, diet, merchants) or a fixed reply.
function mockDietFlow(places, research, rankReply, counter, options) {
  options = options || {};
  const seen = { research: counter || { calls: 0, search: 0, extract: 0, groq: 0, openai: 0 }, researchBatches: [],
    researchPrompts: [], researchMerchants: [], searchQueries: [], extractRequests: [], rankIds: null, rankPrompt: '' };
  const foursquare = mockFoursquare(places);
  const respond = function(responder, a, b, c) { return typeof responder === 'function' ? responder(a, b, c) : responder; };
  const analyse = function(body, responder) {
    const userText = body.messages[1].content;
    seen.researchPrompts.push(userText);
    const diet = userText.match(/^Dietary requirement: (\w+)/)[1];
    const merchants = JSON.parse(userText.slice(userText.indexOf('[')));
    seen.researchMerchants.push(merchants);
    const ids = merchants.map(function(m) { return m.merchantId; });
    seen.researchBatches.push(ids);
    return respond(responder, ids, diet, merchants);
  };
  const fetchFn = async function(url, options2) {
    const u = new URL(String(url));
    if (u.hostname === 'api.tavily.com') {
      assert.equal(options2.headers.Authorization, 'Bearer test-tavily');
      const body = JSON.parse(String(options2.body));
      if (u.pathname === '/search') {
        seen.research.search += 1;
        seen.searchQueries.push(body.query);
        assert.equal(body.max_results, 5);
        // Default: one official-looking result whose title carries the searched merchant identity.
        return options.search === undefined ?
          tavilyReply([{ title: body.query + ' - official menu', url: MENU_URL, content: 'Current menu and prices.' }]) :
          respond(options.search, body.query);
      }
      seen.research.extract += 1;
      seen.extractRequests.push({ urls: body.urls, depth: body.extract_depth });
      return respond(options.extract === undefined ? extractPages() : options.extract, body.urls, body.extract_depth);
    }
    if (u.hostname === 'api.groq.com') {
      seen.research.groq += 1;
      seen.research.calls += 1;
      const body = JSON.parse(String(options2.body));
      assert.equal(body.model, 'openai/gpt-oss-20b');
      assert.deepEqual(body.response_format, { type: 'json_object' });
      assert.ok(!body.tools, 'Groq never searches the web itself');
      return analyse(body, research);
    }
    if (u.hostname === 'api.openai.com') {
      const body = JSON.parse(String(options2.body));
      if (body.messages && String(body.messages[0].content).indexOf(RESEARCH_SYSTEM_MARKER) === 0) {
        seen.research.openai += 1;
        seen.research.calls += 1;
        assert.ok(!body.tools, 'OpenAI fallback never performs a second web search');
        return analyse(body, options.openaiResearch === undefined ? research : options.openaiResearch);
      }
      seen.rankPrompt = body.messages.map(function(m) { return m.content; }).join('\n');
      seen.rankIds = (seen.rankPrompt.match(/"id":"(foursquare-[^"]+)"/g) || []).map(function(e) { return e.slice(6, -1); });
      return rankReply || { ok: false, status: 500 };
    }
    return foursquare.fetchFn(url, options2);
  };
  return { fetchFn: fetchFn, seen: seen };
}

// keys: which providers are configured (default Tavily + Groq, no OpenAI).
function setResearchKeys(keys) {
  keys = Object.assign({ tavily: true, groq: true, openai: false }, keys || {});
  process.env.FOURSQUARE_API_KEY = 'test-key';
  if (keys.tavily) process.env.TAVILY_API_KEY = 'test-tavily'; else delete process.env.TAVILY_API_KEY;
  if (keys.groq) process.env.GROQ_API_KEY = 'test-groq'; else delete process.env.GROQ_API_KEY;
  if (keys.openai) process.env.OPENAI_API_KEY = 'test-openai'; else delete process.env.OPENAI_API_KEY;
}

async function recommendDiet(diet, places, research, options) {
  options = options || {};
  setResearchKeys(options.keys);
  clearDiscoveryCache();
  const flow = mockDietFlow(places, research, options.rankReply, options.counter, options);
  global.fetch = flow.fetchFn;
  const demo = createInitialDemo('jia');
  demo.profile.dietaryPreference = diet;
  demo.profile.craving = options.craving || '';
  demo.profile.maxDistanceMinutes = 30;
  if (options.budget) demo.profile.budget = options.budget;
  const nearby = await getNearbyMerchants({ latitude: 1.45, longitude: 103.82 }, 'jia', demo.profile.craving);
  const result = await getSmartRecommendation(demo.profile, nearby.merchants, [], [], demo, []);
  return { result: result, seen: flow.seen, merchants: nearby.merchants };
}

function newCounter() { return { calls: 0, search: 0, extract: 0, groq: 0, openai: 0 }; }

function numberedPlaces(count) {
  const places = [];
  for (let i = 0; i < count; i++) places.push(fsqPlace('p' + i, 'Place ' + i, 'Restaurant', { distance: 50 + i * 10 }));
  return places;
}

const foodLeaf = fsqPlace('leaf', 'Food Leaf', 'Restaurant');
const flyingWok = fsqPlace('flying-wok', 'Flying Wok', 'Chinese Restaurant', { distance: 46,
  location: { formatted_address: '105 Canberra Street, Singapore' },
  related_places: { parent: { fsq_place_id: 'yong-li', name: 'Yong Li Coffee Station' } } });
const veganOk = answerAll({ vegan: RESEARCH_STATUS.SUITABLE });

// --- Provider resilience -------------------------------------------------------------------

test('PROVIDER A/I/J: Tavily + Groq succeed -> Groq result used, OpenAI never called', async function() {
  const { result, seen } = await recommendDiet('vegan', [foodLeaf], veganOk, { keys: { openai: true } });
  assert.equal(result.merchant.merchantName, 'Food Leaf');
  assert.equal(result.merchant.research.vegan.researchProvider, 'groq');
  assert.equal(seen.research.search, 1);
  assert.equal(seen.research.groq, 1);
  assert.equal(seen.research.openai, 0, 'no wasted fallback credits when Groq is valid');
  const groqOnly = await recommendDiet('vegan', [fsqPlace('g', 'Groq Only Place', 'Restaurant')], veganOk);
  assert.equal(groqOnly.result.merchant.research.vegan.researchProvider, 'groq', 'works with no OpenAI key');
});

test('PROVIDER B/H: no Groq key -> OpenAI analyses the same Tavily evidence', async function() {
  const { result, seen } = await recommendDiet('vegan', [foodLeaf], veganOk, { keys: { groq: false, openai: true } });
  assert.equal(result.merchant.research.vegan.researchProvider, 'openai');
  assert.equal(seen.research.groq, 0);
  assert.equal(seen.research.openai, 1);
});

test('PROVIDER C/D/E: Groq HTTP failure, malformed JSON or an injected URL -> OpenAI fallback', async function() {
  const groqFailures = [
    { ok: false, status: 500 },
    chatReply('this is not json'),
    function(ids) { return chatReply({ results: ids.map(function(id) {
      return verdictFor(id, RESEARCH_STATUS.SUITABLE, { sources: [{ title: 'Invented', url: 'https://invented.example.com/vegan' }] });
    }) }); }
  ];
  for (let i = 0; i < groqFailures.length; i++) {
    clearMerchantResearchCache();
    const { result, seen } = await recommendDiet('vegan', [foodLeaf], groqFailures[i],
      { keys: { openai: true }, openaiResearch: veganOk });
    assert.equal(seen.research.groq, 1);
    assert.equal(seen.research.openai, 1, 'case ' + i + ' falls back to OpenAI');
    assert.equal(result.merchant.research.vegan.researchProvider, 'openai');
  }
});

test('PROVIDER F: both reasoning providers fail -> research unavailable, nothing cached', async function() {
  const { result } = await recommendDiet('vegan', [foodLeaf], { ok: false, status: 503 },
    { keys: { openai: true }, openaiResearch: chatReply('{"results": "nope"}') });
  assert.equal(result.merchant, null);
  assert.equal(result.researchUnavailable, true);
  const again = await recommendDiet('vegan', [foodLeaf], veganOk, { keys: { openai: true } });
  assert.equal(again.seen.research.groq, 1, 'a failed analysis is never cached');
});

test('PROVIDER G: Tavily search failure or no Tavily key -> no LLM is asked to answer from memory', async function() {
  const failed = await recommendDiet('vegan', [foodLeaf], veganOk, { keys: { openai: true }, search: { ok: false, status: 500 } });
  assert.equal(failed.seen.research.search, 1);
  assert.equal(failed.seen.research.calls, 0);
  assert.equal(failed.result.researchUnavailable, true);
  const noKey = await recommendDiet('vegan', [foodLeaf], veganOk, { keys: { tavily: false, openai: true } });
  assert.equal(noKey.seen.research.search, 0);
  assert.equal(noKey.seen.research.calls, 0);
  assert.equal(noKey.result.researchUnavailable, true);
});

test('PROVIDER: Tavily works but no Groq/OpenAI key -> friendly AI-analysis-unavailable state', async function() {
  setResearchKeys({ groq: false, openai: false });
  const flow = mockDietFlow([foodLeaf], veganOk);
  global.fetch = flow.fetchFn;
  const v = visitor();
  await v.request('/setup-preferences', { dietaryPreference: 'vegan', moodCuisine: 'any', craving: '' });
  await v.request('/smart-match/location', { latitude: 1.45, longitude: 103.82 });
  const page = await v.request('/smart-match/result');
  assert.match(page.html, /We couldn(&#39;|')t check vegan options right now\./);
  assert.equal(merchantIdOf(page.html), null);
  assert.equal(flow.seen.research.calls, 0);
});

test('PROVIDER: Tavily finds nothing -> cached UNKNOWN without extract or LLM calls', async function() {
  const counter = newCounter();
  const first = await recommendDiet('vegan', [foodLeaf], veganOk, { counter: counter, search: tavilyReply([]) });
  assert.equal(first.result.noVerifiedDietary, true);
  await recommendDiet('vegan', [foodLeaf], veganOk, { counter: counter, search: tavilyReply([]) });
  assert.deepEqual(counter, { calls: 0, search: 1, extract: 0, groq: 0, openai: 0 });
});

test('PROVIDER K/L: a cached verdict (from Groq or the OpenAI fallback) means no provider call next time', async function() {
  const counter = newCounter();
  await recommendDiet('vegan', [foodLeaf], veganOk, { counter: counter, keys: { groq: false, openai: true } });
  const second = await recommendDiet('vegan', [foodLeaf], veganOk, { counter: counter, keys: { openai: true } });
  assert.equal(second.result.merchant.research.vegan.researchProvider, 'openai', 'provider-independent cache');
  assert.deepEqual(counter, { calls: 1, search: 1, extract: 1, groq: 0, openai: 1 });
});

// --- Targeted retrieval + extraction ---------------------------------------------------------

test('RETRIEVAL A: the Tavily query is exact identity plus the active requirement', async function() {
  const veg = await recommendDiet('vegetarian', [flyingWok], answerAll({}));
  assert.equal(veg.seen.searchQueries[0], 'Flying Wok Yong Li Coffee Station 105 Canberra Street, Singapore Singapore vegetarian menu');
  const vegan = await recommendDiet('vegan', [flyingWok], answerAll({}));
  assert.match(vegan.seen.searchQueries[0], / vegan menu$/);
  const halal = await recommendDiet('halal', [flyingWok], answerAll({}));
  assert.match(halal.seen.searchQueries[0], / halal MUIS$/);
});

test('RETRIEVAL B (Subway regression): generic snippet says nothing, extracted menu page does -> SUITABLE', async function() {
  const source = require('fs').readFileSync(require('path').join(__dirname, '..', 'app.js'), 'utf8');
  assert.ok(!/subway|flying wok/i.test(source), 'no merchant-specific code');
  const subway = fsqPlace('subway', 'Subway', 'Sandwich Place', { location: { formatted_address: '9 Woodlands Ave 9, Singapore' } });
  const officialMenu = 'https://www.subway.com/en-SG/MenuNutrition/Menu';
  const search = tavilyReply([
    { title: 'Subway Republic Polytechnic', url: 'https://www.tripadvisor.com.sg/subway-rp', content: 'Sandwich shop near campus.' },
    { title: 'Menu | Subway Singapore', url: officialMenu, content: 'Explore our sandwiches and wraps.' }]);
  const extract = extractPages(function(url) {
    return url === officialMenu ? 'Subway Singapore menu. Sandwiches: Chicken Teriyaki, Tuna, Veggie Delite (vegetarian) - ' +
      'fresh vegetables on your choice of bread. Wraps and salads also available. ' + 'Nutrition info. '.repeat(20) : null;
  });
  // Stand-in for the reasoning model: it can only answer SUITABLE if the extracted page reached it.
  const reader = function(ids, diet, merchants) {
    return chatReply({ results: merchants.map(function(m) {
      const page = m.sources.find(function(s) { return /vegetarian/i.test(s.content); });
      return page ? verdictFor(m.merchantId, RESEARCH_STATUS.SUITABLE, { evidence: 'Official menu lists Veggie Delite as vegetarian.',
        matchingItems: [{ name: 'Veggie Delite', price: null, sourceUrl: page.url }],
        sources: [{ title: page.title, url: page.url, sourceType: 'official' }] }) :
        verdictFor(m.merchantId, RESEARCH_STATUS.UNKNOWN, { sources: [] });
    }) });
  };
  const { result, seen } = await recommendDiet('vegetarian', [subway], reader, { search: search, extract: extract });
  assert.equal(seen.researchMerchants[0][0].evidenceStrength, 'extracted');
  assert.match(seen.researchMerchants[0][0].sources[0].content, /Veggie Delite \(vegetarian\)/, 'extracted page reached the model');
  assert.equal(result.merchant.merchantName, 'Subway');
  assert.deepEqual(result.merchant.research.vegetarian.matchingItems, [{ name: 'Veggie Delite', price: null, sourceUrl: officialMenu }]);
});

test('RETRIEVAL C/D: mixed menus - meat + vegetarian noodles, meat + an evidenced vegan meal', async function() {
  const veg = await recommendDiet('vegetarian', [flyingWok], answerAll({ vegetarian: RESEARCH_STATUS.SUITABLE,
    items: [{ name: 'Vegetarian Tofu Noodles', price: 5.5 }] }));
  assert.equal(veg.result.merchant.merchantName, 'Flying Wok');
  const vegan = await recommendDiet('vegan', [fsqPlace('steak', 'Prime Cuts', 'Steakhouse')], answerAll({
    vegan: RESEARCH_STATUS.SUITABLE, items: [{ name: 'Vegan Mushroom Steak', price: 24 }] }));
  assert.equal(vegan.result.merchant.merchantName, 'Prime Cuts');
});

test('RETRIEVAL E/L/N: vegetarian verification is never reused as vegan - separate targeted research', async function() {
  const counter = newCounter();
  const veg = await recommendDiet('vegetarian', [foodLeaf], answerAll({ vegetarian: RESEARCH_STATUS.SUITABLE }), { counter: counter });
  assert.equal(veg.result.merchant.merchantName, 'Food Leaf');
  const vegan = await recommendDiet('vegan', [foodLeaf], answerAll({ vegetarian: RESEARCH_STATUS.SUITABLE }), { counter: counter });
  assert.equal(vegan.result.merchant, null, 'vegetarian evidence does not imply vegan');
  assert.equal(counter.search, 2, 'vegan triggered its own targeted search');
  assert.match(vegan.seen.searchQueries[0], / vegan menu$/);
});

test('RETRIEVAL F: halal needs explicit verification - cuisine or an unevidenced claim is not enough', async function() {
  const malay = fsqPlace('malay', 'Kampong Kitchen', 'Malay Restaurant');
  const none = await recommendDiet('halal', [malay], answerAll({}));
  assert.equal(none.result.merchant, null);
  clearMerchantResearchCache();
  const bare = await recommendDiet('halal', [malay], answerAll({ halal: RESEARCH_STATUS.SUITABLE, overrides: { evidence: '' } }));
  assert.equal(bare.result.merchant, null, 'SUITABLE without evidence is downgraded');
  clearMerchantResearchCache();
  const certified = await recommendDiet('halal', [malay], answerAll({ halal: RESEARCH_STATUS.SUITABLE,
    overrides: { evidence: 'Listed as halal-certified in the MUIS directory.', matchingItems: [] } }));
  assert.equal(certified.result.merchant.merchantName, 'Kampong Kitchen', 'halal is outlet-level: no item list needed');
});

test('RETRIEVAL G/H: only the strongest 2 URLs per merchant are extracted, in one batched call', async function() {
  const search = function(query) {
    const slug = query.split(' ')[0].toLowerCase();
    return tavilyReply([
      { title: 'Forum', url: 'https://www.reddit.com/r/sg/' + slug, content: slug + ' thread' },
      { title: 'Listing', url: 'https://www.burpple.com/' + slug, content: slug + ' review' },
      { title: 'Official', url: 'https://www.' + slug + 'kitchen.sg/menu', content: slug + ' menu' },
      { title: 'Delivery', url: 'https://food.grab.com/sg/' + slug, content: slug + ' delivery' },
      { title: 'Blog', url: 'https://blog.example.com/' + slug, content: 'unrelated' }]);
  };
  const places = [fsqPlace('a', 'Alphaa Kitchen', 'Restaurant', { distance: 10 }), fsqPlace('b', 'Bravoo Kitchen', 'Restaurant', { distance: 20 }),
    fsqPlace('c', 'Charlie Kitchen', 'Restaurant', { distance: 30 })];
  const { seen } = await recommendDiet('vegetarian', places, answerAll({}), { search: search });
  assert.equal(seen.research.extract, 1, 'one batched extract call for the whole batch');
  const urls = seen.extractRequests[0].urls;
  assert.equal(seen.extractRequests[0].depth, 'basic');
  assert.equal(urls.length, 6);
  ['alphaa', 'bravoo', 'charlie'].forEach(function(slug) {
    assert.ok(urls.includes('https://www.' + slug + 'kitchen.sg/menu'), 'official page extracted');
    assert.ok(urls.includes('https://food.grab.com/sg/' + slug), 'delivery menu extracted');
    assert.ok(!urls.some(function(u) { return u.indexOf('reddit.com') !== -1; }), 'community source not extracted');
  });
});

test('RETRIEVAL I: a failed extraction for one URL still uses the other extracted page', async function() {
  const search = tavilyReply([{ title: 'Official', url: MENU_URL, content: 'Food Leaf menu' },
    { title: 'Grab', url: 'https://food.grab.com/sg/food-leaf', content: 'Food Leaf delivery' }]);
  const extract = extractPages(function(url) { return url === MENU_URL ? null : 'Food Leaf Grab menu. ' + 'Dishes. '.repeat(40); });
  const { seen } = await recommendDiet('vegetarian', [foodLeaf], answerAll({}), { search: search, extract: extract });
  const merchant = seen.researchMerchants[0][0];
  assert.equal(merchant.evidenceStrength, 'extracted');
  assert.deepEqual(merchant.sources.map(function(s) { return s.url; }), ['https://food.grab.com/sg/food-leaf']);
});

test('RETRIEVAL J: all extraction fails -> weaker snippets are sent and marked, never an unevidenced SUITABLE', async function() {
  const { result, seen } = await recommendDiet('vegetarian', [foodLeaf], answerAll({}), { extract: { ok: false, status: 500 } });
  const merchant = seen.researchMerchants[0][0];
  assert.equal(merchant.evidenceStrength, 'snippets');
  assert.equal(merchant.sources[0].content, 'Current menu and prices.');
  assert.equal(result.merchant, null);
});

test('RETRIEVAL: a strong source with unusable basic extraction gets one batched advanced retry', async function() {
  const official = 'https://www.foodleaf.sg/menu';
  const search = tavilyReply([{ title: 'Food Leaf official', url: official, content: 'Food Leaf menu' },
    { title: 'Listing', url: 'https://www.burpple.com/food-leaf', content: 'Food Leaf review' }]);
  const extract = function(urls, depth) {
    return extractPages(function(url) {
      if (url === official) return depth === 'advanced' ? 'Food Leaf full menu. ' + 'Dishes. '.repeat(40) : 'Loading...';
      return 'Burpple page. ' + 'Reviews. '.repeat(40);
    })(urls);
  };
  const { seen } = await recommendDiet('vegetarian', [foodLeaf], answerAll({}), { search: search, extract: extract });
  assert.deepEqual(seen.extractRequests.map(function(r) { return r.depth + ':' + r.urls.length; }), ['basic:2', 'advanced:1']);
  assert.match(seen.researchMerchants[0][0].sources[0].content, /Food Leaf full menu/);
});

test('RETRIEVAL K: the model receives cleaned, size-limited extracted content, not tiny snippets', async function() {
  const long = 'Header nav [Home](https://x.sg) ![logo](https://x.sg/l.png) ' + 'Menu section text. '.repeat(200);
  const { seen } = await recommendDiet('vegetarian', [foodLeaf], answerAll({}), { extract: extractPages(function() { return long; }) });
  const content = seen.researchMerchants[0][0].sources[0].content;
  assert.ok(content.length > 1000 && content.length <= 1500, 'content length ' + content.length);
  assert.ok(!/https?:\/\//.test(content) && content.indexOf('Home') !== -1, 'links reduced to their text');
  assert.match(seen.researchPrompts[0], /^Dietary requirement: vegetarian/);
});

test('RETRIEVAL M: the same merchant + diet is served from cache for the next visitor; 24h TTL', async function() {
  const counter = newCounter();
  const opts = answerAll({ vegan: RESEARCH_STATUS.SUITABLE, items: [{ name: 'Vegan Fried Bee Hoon', price: 5.5 }] });
  await recommendDiet('vegan', [foodLeaf], opts, { counter: counter, craving: 'bread' });
  const second = await recommendDiet('none', [foodLeaf], opts, { counter: counter, craving: 'noodles',
    keys: { openai: true }, rankReply: aiResponse('foursquare-leaf', 'Nearest option.', 'medium') });
  assert.match(second.seen.rankPrompt, /Vegan Fried Bee Hoon \$5\.50/, 'evidenced items still help craving ranking');
  await recommendDiet('vegan', [foodLeaf], opts, { counter: counter });
  assert.equal(counter.calls, 1);
  const realNow = Date.now;
  try {
    Date.now = function() { return realNow() + 24 * 60 * 60 * 1000 + 1000; };
    await recommendDiet('vegan', [foodLeaf], opts, { counter: counter });
  } finally {
    Date.now = realNow;
  }
  assert.equal(counter.calls, 2, 'expired after 24 hours');
});

test('RETRIEVAL O: research stops once 2 suitable merchants are verified', async function() {
  const research = function(ids) {
    return chatReply({ results: ids.map(function(id) {
      return verdictFor(id, id === 'foursquare-p2' ? RESEARCH_STATUS.UNKNOWN : RESEARCH_STATUS.SUITABLE);
    }) });
  };
  const { seen } = await recommendDiet('vegetarian', numberedPlaces(9), research);
  assert.equal(seen.research.groq, 1);
  assert.equal(seen.research.search, 3);
});

test('RETRIEVAL P: research continues to batch 3 when the first 6 merchants verify nothing', async function() {
  const research = function(ids) {
    return chatReply({ results: ids.map(function(id) {
      return verdictFor(id, id === 'foursquare-p7' ? RESEARCH_STATUS.SUITABLE : RESEARCH_STATUS.UNKNOWN);
    }) });
  };
  const { result, seen } = await recommendDiet('vegetarian', numberedPlaces(12), research);
  assert.equal(seen.research.groq, 3);
  assert.equal(result.merchant.merchantName, 'Place 7');
});

test('RETRIEVAL Q: at most 9 merchants are researched per Smart Match, nearest first, 3 per batch', async function() {
  const { result, seen } = await recommendDiet('vegetarian', numberedPlaces(12), answerAll({}));
  assert.equal(seen.research.search, 9);
  assert.deepEqual(seen.researchBatches, [['foursquare-p0', 'foursquare-p1', 'foursquare-p2'],
    ['foursquare-p3', 'foursquare-p4', 'foursquare-p5'], ['foursquare-p6', 'foursquare-p7', 'foursquare-p8']]);
  assert.equal(result.noVerifiedDietary, true);
});

test('RETRIEVAL R: Groq 429 -> the same extracted evidence goes to OpenAI; no new Tavily calls; Groq not retried', async function() {
  const { result, seen } = await recommendDiet('vegetarian', numberedPlaces(6), { ok: false, status: 429 }, {
    keys: { openai: true }, openaiResearch: function(ids) {
      return chatReply({ results: ids.map(function(id) {
        return verdictFor(id, id === 'foursquare-p3' ? RESEARCH_STATUS.SUITABLE : RESEARCH_STATUS.UNKNOWN);
      }) });
    } });
  assert.equal(seen.research.groq, 1);
  assert.equal(seen.research.openai, 2);
  assert.equal(seen.research.search, 6);
  assert.equal(seen.research.extract, 2, 'one extract per batch; nothing repeated for the fallback');
  assert.equal(seen.researchPrompts[0], seen.researchPrompts[1], 'OpenAI receives the identical evidence');
  assert.equal(result.merchant.research.vegetarian.researchProvider, 'openai');
});

test('RELIABILITY: Groq 429 without OpenAI stops research; earlier verified merchants are still used', async function() {
  const none = await recommendDiet('vegetarian', numberedPlaces(6), { ok: false, status: 429 });
  assert.equal(none.seen.research.groq, 1);
  assert.equal(none.seen.research.search, 3, 'no further Tavily credits spent on evidence nobody can analyse');
  assert.equal(none.result.researchUnavailable, true);
  clearMerchantResearchCache();
  const known = fsqPlace('known', 'Known Veg Place', 'Restaurant', { distance: 500 });
  await recommendDiet('vegetarian', [known], answerAll({ vegetarian: RESEARCH_STATUS.SUITABLE }));
  const later = await recommendDiet('vegetarian', [known].concat(numberedPlaces(4)), { ok: false, status: 429 });
  assert.equal(later.result.merchant.merchantName, 'Known Veg Place');
});

// --- Granular validation ---------------------------------------------------------------------

test('RELIABILITY: one malformed merchant in a batch is dropped alone; the others are cached', async function() {
  const places = [fsqPlace('a', 'Alpha Eats', 'Restaurant', { distance: 50 }),
    fsqPlace('b', 'Bravo Eats', 'Restaurant', { distance: 60 }), fsqPlace('c', 'Charlie Eats', 'Restaurant', { distance: 70 })];
  const research = function(ids) {
    return chatReply({ results: ids.map(function(id) {
      return id === 'foursquare-b' ? { merchantId: id, identified: 'yes' } : verdictFor(id, RESEARCH_STATUS.SUITABLE);
    }) });
  };
  const counter = newCounter();
  const first = await recommendDiet('vegetarian', places, research, { counter: counter });
  const byId = {};
  first.merchants.forEach(function(m) { byId[m.id] = m; });
  assert.equal(byId['foursquare-a'].research.vegetarian.status, 'SUITABLE');
  assert.equal(byId['foursquare-c'].research.vegetarian.status, 'SUITABLE');
  assert.equal(byId['foursquare-b'].research.vegetarian, undefined, 'the malformed merchant gets no verdict');
  const second = await recommendDiet('vegetarian', places, research, { counter: counter });
  assert.ok(second.result.merchant);
  assert.equal(counter.calls, 1, 'A and C are cached; 2 verified means B is not needed');
});

test('RELIABILITY: bad status/evidence/items/prices are normalised or downgraded, never whole-batch failures', async function() {
  const { merchants } = await recommendDiet('vegetarian', [foodLeaf], chatReply({ results: [verdictFor('foursquare-leaf',
    RESEARCH_STATUS.SUITABLE, { evidence: '  Official menu\n lists a <b>vegetarian</b> set. ' + 'x'.repeat(300),
      matchingItems: [{ name: 'Veg Set', price: '$8.90', sourceUrl: MENU_URL }, { name: '' }] })] }));
  const verdict = merchants[0].research.vegetarian;
  assert.equal(verdict.status, 'SUITABLE');
  assert.ok(verdict.evidence.startsWith('Official menu lists a bvegetarian/b set.') && verdict.evidence.length <= 240);
  assert.deepEqual(verdict.matchingItems, [{ name: 'Veg Set', price: null, sourceUrl: MENU_URL }]);
  clearMerchantResearchCache();
  const badStatus = await recommendDiet('vegetarian', [foodLeaf], answerAll({ vegetarian: 'PROBABLY' }));
  assert.equal(badStatus.merchants[0].research.vegetarian.status, 'UNKNOWN');
  clearMerchantResearchCache();
  const noItems = await recommendDiet('vegetarian', [foodLeaf], answerAll({ vegetarian: RESEARCH_STATUS.SUITABLE,
    overrides: { matchingItems: [] } }));
  assert.equal(noItems.result.merchant, null, 'a vegetarian SUITABLE must name at least one evidenced item');
});

test('RELIABILITY: whole-response problems fail closed when no fallback exists', async function() {
  const cases = [
    chatReply('Sorry, I could not do that.'),
    answerAll({ vegan: RESEARCH_STATUS.SUITABLE, overrides: { sources: [{ title: 'x', url: 'https://not-supplied.example.com/menu' }] } }),
    answerAll({ vegan: RESEARCH_STATUS.SUITABLE, items: [{ name: 'Vegan Bowl', sourceUrl: 'https://elsewhere.example.com/x' }] }),
    chatReply({ results: [verdictFor('foursquare-ghost', RESEARCH_STATUS.SUITABLE)] })
  ];
  for (let i = 0; i < cases.length; i++) {
    clearMerchantResearchCache();
    const { result } = await recommendDiet('vegan', [foodLeaf], cases[i]);
    assert.equal(result.merchant, null, 'case ' + i + ' must fail closed');
  }
  clearMerchantResearchCache();
  const unidentified = await recommendDiet('vegan', [foodLeaf], answerAll({ vegan: RESEARCH_STATUS.SUITABLE,
    overrides: { identified: false } }));
  assert.equal(unidentified.result.merchant, null);
});

// --- Downstream behaviour ----------------------------------------------------------------------

test('RESEARCH: arbitrary craving - evidenced items reach the ranker, no dictionary', async function() {
  const spicy = fsqPlace('spicy', 'Hot Wok House', 'Restaurant', { distance: 300 });
  const research = function(ids) {
    return chatReply({ results: ids.map(function(id) {
      return verdictFor(id, RESEARCH_STATUS.SUITABLE, { matchingItems: [{ name: id === 'foursquare-spicy' ?
        'Crispy Chilli Tofu Bites' : 'Creamy Mushroom Soup', price: id === 'foursquare-spicy' ? 6.8 : 7.5, sourceUrl: MENU_URL }] });
    }) });
  };
  const reason = 'Its researched menu has Crispy Chilli Tofu Bites, a crispy spicy light bite.';
  const { result, seen } = await recommendDiet('vegetarian', [foodLeaf, spicy], research, { keys: { openai: true },
    craving: 'something crispy and spicy but not too heavy', rankReply: aiResponse('foursquare-spicy', reason, 'high') });
  assert.match(seen.rankPrompt, /Crispy Chilli Tofu Bites \$6\.80/);
  assert.equal(result.merchant.merchantName, 'Hot Wok House');
  assert.equal(result.reason, reason);
});

test('RESEARCH budget: an evidenced numeric price supports budget fit; no price means unknown', async function() {
  const rank = function(budgetFit, reason) {
    return chatReply({ merchantId: 'foursquare-leaf', relevance: 'high', budgetFit: budgetFit, reason: reason });
  };
  const priced = await recommendDiet('vegan', [foodLeaf], answerAll({ vegan: RESEARCH_STATUS.SUITABLE,
    items: [{ name: 'Vegan Laksa', price: 8.9 }] }), { budget: 10, keys: { openai: true },
    rankReply: rank('within', 'Vegan Laksa is $8.90, within your $10 budget.') });
  assert.equal(priced.result.budgetFit, 'within');
  clearMerchantResearchCache();
  const unpriced = await recommendDiet('vegan', [foodLeaf], answerAll({ vegan: RESEARCH_STATUS.SUITABLE,
    items: [{ name: 'Vegan Laksa', price: null }] }), { budget: 10, keys: { openai: true }, rankReply: rank('within', 'Cheap and within budget.') });
  assert.equal(unpriced.result.merchant.merchantName, 'Food Leaf');
  assert.equal(unpriced.result.budgetFit, 'unknown');
  assert.equal(unpriced.result.reason, null);
});

test('RESEARCH: no dietary restriction -> zero new Tavily/LLM research', async function() {
  const { result, seen } = await recommendDiet('none', [foodLeaf, flyingWok], veganOk, { craving: 'crispy chicken' });
  assert.deepEqual([seen.research.search, seen.research.extract, seen.research.calls], [0, 0, 0]);
  assert.ok(result.merchant);
});

test('RESEARCH: dietary before craving - only verified merchants reach the ranker', async function() {
  const chicken = fsqPlace('chicken', 'Seoul Bites', 'Fried Chicken Joint', { distance: 20 });
  const research = function(ids) {
    return chatReply({ results: ids.map(function(id) {
      return verdictFor(id, id === 'foursquare-leaf' ? RESEARCH_STATUS.SUITABLE : RESEARCH_STATUS.UNKNOWN);
    }) });
  };
  const { result, seen } = await recommendDiet('vegan', [foodLeaf, chicken], research, { keys: { openai: true },
    craving: 'crispy food', rankReply: aiResponse('foursquare-chicken', 'Crispy fried chicken.', 'high') });
  assert.deepEqual(seen.rankIds, ['foursquare-leaf']);
  assert.equal(result.merchant.merchantName, 'Food Leaf');
});

test('RESEARCH: no metadata shortcuts - a Vegan category or a Non-Halal name is still researched', async function() {
  const vegan = await recommendDiet('vegan', [fsqPlace('vegan', 'Plant Hut', 'Vegan Restaurant')], answerAll({}));
  assert.equal(vegan.seen.research.calls, 1);
  assert.equal(vegan.result.merchant, null);
  const nonHalal = await recommendDiet('halal', [fsqPlace('nh', 'Ah Seng (Non-Halal)', 'Chinese Restaurant')], answerAll({}));
  assert.equal(nonHalal.seen.research.calls, 1);
  assert.equal(nonHalal.result.merchant, null);
});

test('RESEARCH: zero verified -> clean dietary no-result state, 9 merchants max, no Foursquare re-query', async function() {
  setResearchKeys();
  const flow = mockDietFlow(numberedPlaces(20), answerAll({}));
  let foursquareCalls = 0;
  global.fetch = async function(url, options) {
    if (new URL(String(url)).hostname === 'places-api.foursquare.com') foursquareCalls += 1;
    return flow.fetchFn(url, options);
  };
  const v = visitor();
  await v.request('/setup-preferences', { dietaryPreference: 'vegan', moodCuisine: 'any', craving: '' });
  await v.request('/smart-match/location', { latitude: 1.45, longitude: 103.82 });
  const page = await v.request('/smart-match/result');
  assert.match(page.html, /No verified vegan matches found nearby\./);
  assert.equal(merchantIdOf(page.html), null);
  assert.equal(flow.seen.research.calls, 3);
  assert.equal(flow.seen.research.search, 9);
  assert.equal(foursquareCalls, 1);
});

test('RETRIEVAL identity: a page about a DIFFERENT nearby outlet can never verify this merchant', async function() {
  const cafe = fsqPlace('cafe', 'Cafe Esplanade @ RP', 'Café');
  const otherOutlet = 'https://www.happycow.net/reviews/the-crowded-bowl';
  const search = tavilyReply([{ title: 'The Crowded Bowl - Republic Polytechnic', url: otherOutlet, content: 'Vegetarian salad bowls.' }]);
  const extract = extractPages(function() { return 'The Crowded Bowl serves vegetarian salad bowls at RP. ' + 'Menu. '.repeat(40); });
  const research = function(ids) {
    return chatReply({ results: ids.map(function(id) {
      return verdictFor(id, RESEARCH_STATUS.SUITABLE, { evidence: 'Listed as a vegetarian salad bowl restaurant.',
        matchingItems: [{ name: 'Vegetarian salad bowl', price: null, sourceUrl: otherOutlet }],
        sources: [{ title: 'The Crowded Bowl', url: otherOutlet, sourceType: 'listing' }] });
    }) });
  };
  const { result, merchants } = await recommendDiet('vegetarian', [cafe], research, { search: search, extract: extract });
  assert.equal(merchants[0].research.vegetarian.status, 'UNKNOWN', 'the cited source never names Cafe Esplanade');
  assert.equal(result.merchant, null);
});
