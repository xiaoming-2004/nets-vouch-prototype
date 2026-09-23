const test = require('node:test');
const assert = require('node:assert/strict');
const { app, createInitialDemo, getNearbyMerchants, getEligibleMerchants,
  getSmartRecommendation, getMerchantCampaigns, resetMerchantCampaigns,
  getMoodMatchState, getDietaryMatchState, getCravingMatchState, MATCH_STATE,
  clearDiscoveryCache } = require('../app');

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
  delete process.env.OPENAI_API_KEY;
  delete process.env.FOURSQUARE_API_KEY;
  global.fetch = originalFetch;
});
test.afterEach(function() {
  global.fetch = originalFetch;
  if (originalOpenAIKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalOpenAIKey;
  if (originalFoursquareKey === undefined) delete process.env.FOURSQUARE_API_KEY;
  else process.env.FOURSQUARE_API_KEY = originalFoursquareKey;
});

async function candidates() {
  return (await getNearbyMerchants()).merchants;
}

function aiResponse(merchantId, reason) {
  return { ok: true, json: async function() {
    return { choices: [{ message: { content: JSON.stringify({ merchantId: merchantId, reason: reason }) } }] };
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

test('missing AI key uses participating local fallback', async function() {
  const demo = createInitialDemo('jia');
  const result = await getSmartRecommendation(demo.profile, await candidates(), [], [], demo);
  assert.equal(result.merchant.id, 'felicia-chicken-rice');
  assert.equal(result.reason, null);
});

test('AI error and malformed or ineligible output use deterministic fallback', async function() {
  process.env.OPENAI_API_KEY = 'test-key';
  const demo = createInitialDemo('jia');
  const nearby = await candidates();
  global.fetch = async function() { throw new Error('provider unavailable'); };
  assert.equal((await getSmartRecommendation(demo.profile, nearby, [], [], demo)).merchant.id, 'felicia-chicken-rice');
  global.fetch = async function() { return aiResponse('not-participating', 'Nearby choice.'); };
  assert.equal((await getSmartRecommendation(demo.profile, nearby, [], [], demo)).merchant.id, 'felicia-chicken-rice');
  global.fetch = async function() { return aiResponse('green-bowl', '   '); };
  assert.equal((await getSmartRecommendation(demo.profile, nearby, [], [], demo)).merchant.id, 'felicia-chicken-rice');
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
  assert.equal((await getSmartRecommendation(demo.profile, nearby, [], [], demo)).merchant.id, 'felicia-chicken-rice');
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
  assert.match(match.html, /data-merchant-id="felicia-chicken-rice"/);
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
  process.env.FOURSQUARE_API_KEY = 'test-key';
  const mock = mockFoursquare([
    fsqPlace('mood-match', 'Mood Match Noodles', 'Noodle Restaurant', { distance: 400 }),
    fsqPlace('pref-match', 'Preference Match Halal', 'Restaurant', { distance: 400 })
  ]);
  global.fetch = mock.fetchFn;
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

test('TEST D: a factual craving match ranks ahead of a generic candidate', async function() {
  process.env.FOURSQUARE_API_KEY = 'test-key';
  const mock = mockFoursquareByQuery({ bread: [
    fsqPlace('bakery', 'Corner Bakery', 'Bakery', { distance: 300 }),
    fsqPlace('generic', 'Generic Restaurant', 'Restaurant', { distance: 100 })
  ] });
  global.fetch = mock.fetchFn;
  const demo = createInitialDemo('jia');
  demo.profile.craving = 'bread';
  demo.profile.maxDistanceMinutes = 30;
  const nearby = await getNearbyMerchants({ latitude: 1.45, longitude: 103.82 }, 'jia', 'bread');
  const result = await getSmartRecommendation(demo.profile, nearby.merchants, [], [], demo);
  assert.equal(result.merchant.merchantName, 'Corner Bakery',
    'the factual bread/bakery match must outrank the nearer but unrelated generic restaurant');
});

test('TEST E: no fabricated craving match for a merchant with only generic metadata', async function() {
  const genericMerchant = { category: 'foursquare.place', categoryLabel: 'Restaurant',
    merchantName: 'Food Leaf', itemName: null, cuisineTags: [], dietary: [] };
  assert.equal(getCravingMatchState(genericMerchant, 'bread'), MATCH_STATE.NON_MATCH,
    'a known-generic category with no bread evidence must not be an unresolved unknown either, but it must never be MATCH');
  const trulyUnknownMerchant = { category: 'foursquare.place', categoryLabel: 'Food & drink',
    merchantName: 'Mystery Place', itemName: null, cuisineTags: [], dietary: [] };
  assert.equal(getCravingMatchState(trulyUnknownMerchant, 'bread'), MATCH_STATE.UNKNOWN);
  const bakery = { category: 'foursquare.place', categoryLabel: 'Bakery',
    merchantName: 'Corner Bakery', itemName: null, cuisineTags: ['bakery'], dietary: [] };
  assert.equal(getCravingMatchState(bakery, 'bread'), MATCH_STATE.MATCH);
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
