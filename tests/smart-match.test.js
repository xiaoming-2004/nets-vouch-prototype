const test = require('node:test');
const assert = require('node:assert/strict');
const { app, createInitialDemo, getNearbyMerchants, getEligibleMerchants,
  getSmartRecommendation, getMerchantCampaigns, resetMerchantCampaigns } = require('../app');

const originalFetch = global.fetch;
const originalOpenAIKey = process.env.OPENAI_API_KEY;
const originalPlacesKey = process.env.GEOAPIFY_API_KEY;
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
  delete process.env.OPENAI_API_KEY;
  delete process.env.GEOAPIFY_API_KEY;
  global.fetch = originalFetch;
});
test.afterEach(function() {
  global.fetch = originalFetch;
  if (originalOpenAIKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalOpenAIKey;
  if (originalPlacesKey === undefined) delete process.env.GEOAPIFY_API_KEY;
  else process.env.GEOAPIFY_API_KEY = originalPlacesKey;
});

async function candidates(demo) {
  return (await getNearbyMerchants()).merchants;
}

function aiResponse(merchantId, reason) {
  return { ok: true, json: async function() {
    return { choices: [{ message: { content: JSON.stringify({ merchantId: merchantId, reason: reason }) } }] };
  } };
}

test('missing AI key uses participating local fallback', async function() {
  const demo = createInitialDemo('jia');
  const result = await getSmartRecommendation(demo.profile, await candidates(demo), [], [], demo);
  assert.equal(result.merchant.id, 'felicia-chicken-rice');
  assert.equal(result.reason, null);
});

test('AI error and malformed or ineligible output use deterministic fallback', async function() {
  process.env.OPENAI_API_KEY = 'test-key';
  const demo = createInitialDemo('jia');
  const nearby = await candidates(demo);
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
  const nearby = await candidates(demo);
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
  const nearby = await candidates(demo);
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
  await getSmartRecommendation(demo.profile, await candidates(demo), [], [], demo);
  assert.match(prompt, /Felicia's Chicken Rice.*recommended, accepted, payment completed/);
  assert.ok(!prompt.includes('tx-secret'));
  assert.ok(!prompt.includes('123.45'));
  assert.ok(!prompt.includes('Private Merchant'));
});

test('demo location discovers Geoapify places with stable IDs and simulated participation', async function() {
  process.env.GEOAPIFY_API_KEY = 'test-key';
  let requestUrl;
  global.fetch = async function(url, options) {
    requestUrl = new URL(url);
    assert.equal(requestUrl.origin + requestUrl.pathname, 'https://api.geoapify.com/v2/places');
    assert.ok(options.signal);
    return { ok: true, json: async function() { return { type: 'FeatureCollection', features: [{
      type: 'Feature', properties: { place_id: 'public-cafe', name: 'Public Cafe',
        formatted: 'Woodlands, Singapore', categories: ['catering.cafe'], distance: 85 },
      geometry: { type: 'Point', coordinates: [103.786, 1.443] }
    }] }; } };
  };
  const nearby = await getNearbyMerchants();
  assert.equal(nearby.source, 'geoapify');
  assert.equal(requestUrl.searchParams.get('filter'), 'circle:103.7854,1.4428,2000');
  assert.equal(requestUrl.searchParams.get('bias'), 'proximity:103.7854,1.4428');
  assert.equal(requestUrl.searchParams.get('limit'), '20');
  assert.equal(requestUrl.searchParams.get('lang'), 'en');
  assert.equal(requestUrl.searchParams.get('categories'), 'catering');
  const publicCafe = nearby.merchants.find(function(item) { return item.id === 'geoapify-public-cafe'; });
  assert.equal(publicCafe.externalPlaceId, 'public-cafe');
  assert.equal(publicCafe.source, 'GEOAPIFY');
  assert.equal(publicCafe.participationMode, 'DEMO_SIMULATED');
  assert.equal(publicCafe.itemName, null);
  assert.equal(publicCafe.price, null);
  assert.deepEqual(publicCafe.dietary, []);
  assert.equal(publicCafe.distanceLabel, '85 m away');
  assert.equal(publicCafe.rating, null);
  assert.equal(publicCafe.priceLevel, null);
  const demo = createInitialDemo('jia');
  const eligible = getEligibleMerchants(demo.profile, nearby.merchants, [], demo);
  assert.ok(eligible.some(function(item) { return item.id === 'felicia-chicken-rice'; }));
  assert.ok(eligible.some(function(item) { return item.id === 'geoapify-public-cafe'; }));
  demo.profile.dietaryPreference = 'halal';
  demo.profile.budget = 1;
  assert.ok(getEligibleMerchants(demo.profile, nearby.merchants, [], demo)
    .some(function(item) { return item.id === 'geoapify-public-cafe'; }));
  const campaign = getMerchantCampaigns().find(function(item) { return item.merchantId === publicCafe.id; });
  assert.equal(campaign.participationMode, 'DEMO_SIMULATED');
});

test('missing or failed Geoapify API keeps Smart Match usable from local demo merchants', async function() {
  assert.equal((await getNearbyMerchants()).source, 'local-fallback');
  process.env.GEOAPIFY_API_KEY = 'test-key';
  global.fetch = async function() { throw new Error('location service unavailable'); };
  const nearby = await getNearbyMerchants({ latitude: 1.45, longitude: 103.82 });
  assert.equal(nearby.source, 'local-fallback');
  global.fetch = async function() { return { ok: false, status: 429 }; };
  assert.equal((await getNearbyMerchants()).source, 'local-fallback');
  global.fetch = async function() { return { ok: true, json: async function() { return { features: [] }; } }; };
  assert.equal((await getNearbyMerchants()).source, 'local-fallback');
  global.fetch = async function() { return { ok: true, json: async function() { return { features: [
    { properties: { place_id: 'pub-only', name: 'Pub', categories: ['catering.pub'], lat: 1.45, lon: 103.82 } }
  ] }; } }; };
  assert.equal((await getNearbyMerchants()).source, 'local-fallback');
  global.fetch = async function() { return { ok: true, json: async function() { throw new SyntaxError('bad JSON'); } }; };
  assert.equal((await getNearbyMerchants()).source, 'local-fallback');
  const demo = createInitialDemo('jia');
  const result = await getSmartRecommendation(demo.profile, nearby.merchants, [], [], demo);
  assert.equal(result.merchant.id, 'felicia-chicken-rice');
});

test('Geoapify timeout falls back to local merchants', async function() {
  process.env.GEOAPIFY_API_KEY = 'test-key';
  global.fetch = function(url, options) {
    return new Promise(function(resolve, reject) {
      options.signal.addEventListener('abort', function() { reject(new Error('aborted')); });
    });
  };
  assert.equal((await getNearbyMerchants()).source, 'local-fallback');
});

test('broad catering keeps restaurants, cafes and food courts ahead of fast food, bars and pubs', async function() {
  process.env.GEOAPIFY_API_KEY = 'test-key';
  const names = ['restaurant', 'cafe', 'food_court', 'fast_food', 'bar', 'pub', 'biergarten'];
  global.fetch = async function() { return { ok: true, json: async function() { return { features:
    names.map(function(category, index) { return {
      properties: { place_id: 'food-' + index, name: category,
        categories: ['catering', 'catering.' + category], lat: 1.45, lon: 103.82 }
    }; })
  }; } }; };
  const nearby = await getNearbyMerchants({ latitude: 1.45, longitude: 103.82 });
  assert.deepEqual(nearby.merchants.map(function(item) { return item.merchantName; }),
    ['restaurant', 'cafe', 'food_court']);
  assert.equal(nearby.merchants[2].category, 'catering.food_court');
});

test('fast food is only a backup when fewer than three normal meal places remain', async function() {
  process.env.GEOAPIFY_API_KEY = 'test-key';
  global.fetch = async function() { return { ok: true, json: async function() { return { features: [
    { properties: { place_id: 'fast', name: 'Quick Bite', categories: ['catering.fast_food'], lat: 1.45, lon: 103.82 } },
    { properties: { place_id: 'meal', name: 'Meal Place', categories: ['catering.restaurant'], lat: 1.45, lon: 103.82 } }
  ] }; } }; };
  const nearby = await getNearbyMerchants({ latitude: 1.45, longitude: 103.82 });
  assert.deepEqual(nearby.merchants.map(function(item) { return item.merchantName; }),
    ['Meal Place', 'Quick Bite']);
});

test('invalid Geoapify features are skipped and missing distance uses coordinates', async function() {
  process.env.GEOAPIFY_API_KEY = 'test-key';
  global.fetch = async function() { return { ok: true, json: async function() { return { features: [
    { properties: { place_id: 'no-name' }, geometry: { coordinates: [103.82, 1.45] } },
    { properties: { place_id: 'no-coordinates', name: 'Unknown Place' } },
    { properties: { place_id: 'valid', name: 'Named Cafe', categories: ['catering.cafe'] },
      geometry: { coordinates: [103.82, 1.45] } }
  ] }; } }; };
  const nearby = await getNearbyMerchants({ latitude: 1.45, longitude: 103.82 });
  assert.equal(nearby.merchants.length, 1);
  assert.equal(nearby.merchants[0].id, 'geoapify-valid');
  assert.equal(nearby.merchants[0].distanceMetres, 0);
  assert.equal(nearby.merchants[0].itemName, null);
  assert.equal(nearby.merchants[0].price, null);
  assert.deepEqual(nearby.merchants[0].dietary, []);
});

test('real coordinates change the Geoapify search centre and feed the existing Smart Match and Scan', async function() {
  process.env.GEOAPIFY_API_KEY = 'test-key';
  const centres = [];
  global.fetch = async function(url, options) {
    const filter = new URL(url).searchParams.get('filter');
    const parts = filter.split(':')[1].split(',').map(Number);
    const centre = { latitude: parts[1], longitude: parts[0] };
    assert.equal(parts[2], 2000);
    assert.equal(new URL(url).searchParams.get('bias'), 'proximity:' + parts[0] + ',' + parts[1]);
    centres.push(centre);
    const inCanberra = centre.latitude > 1.4;
    return { ok: true, json: async function() { return { type: 'FeatureCollection', features: [{
      properties: { place_id: inCanberra ? 'canberra-cafe' : 'sengkang-cafe',
        name: inCanberra ? 'Canberra Cafe' : 'Sengkang Cafe', categories: ['catering.cafe'] },
      geometry: { coordinates: [centre.longitude, centre.latitude] }
    }] }; } };
  };
  const v = visitor();
  assert.match((await v.request('/home')).html, /data-location-ready="false"/);
  assert.equal((await v.request('/smart-match/location', { latitude: 1.45, longitude: 103.82 })).status, 204);
  assert.match((await v.request('/home')).html, /data-location-ready="true"/);
  assert.match((await v.request('/smart-match/result')).html, /Canberra Cafe/);
  assert.equal((await v.request('/smart-match/location', { latitude: 1.39, longitude: 103.89 })).status, 204);
  const second = await v.request('/smart-match/result');
  assert.match(second.html, /Sengkang Cafe/);
  assert.ok(!second.html.includes('Felicia'));
  assert.ok(!second.html.includes('Try:'));
  assert.match(second.html, /<p class="facts">0 m away<\/p>/);
  assert.equal((await v.request('/recommendation/accept', { merchantId: 'geoapify-sengkang-cafe' })).status, 302);
  assert.match((await v.request('/scan')).html, /value="geoapify-sengkang-cafe"/);
  assert.equal((await v.request('/scan', { merchantId: 'geoapify-sengkang-cafe' })).status, 302);
  const paymentPage = await v.request('/scan/payment');
  assert.match(paymentPage.html, /Sengkang Cafe/);
  const journeyId = paymentPage.html.match(/name="journeyId" value="([^"]+)"/)[1];
  const paid = await v.request('/scan/payment', { journeyId: journeyId, amount: '5.00' });
  assert.match(paid.location, /^\/payment-success\/tx-/);
  assert.match((await v.request('/profile/rewards')).html, /Sengkang Cafe/);
  assert.deepEqual(centres, [
    { latitude: 1.45, longitude: 103.82 },
    { latitude: 1.39, longitude: 103.89 }
  ]);
  assert.equal((await v.request('/smart-match/location', { latitude: 999, longitude: 103.89 })).status, 400);
  assert.equal((await v.request('/smart-match/location', { latitude: 1.39, longitude: -181 })).status, 400);
});

test('location denied and missing Geoapify key use the RP demo fallback', async function() {
  const v = visitor();
  assert.equal((await v.request('/smart-match/location', { status: 'fallback' })).status, 204);
  const match = await v.request('/smart-match/result');
  assert.match(match.html, /data-merchant-id="felicia-chicken-rice"/);
  assert.match(match.html, /Using demo location/);
});
