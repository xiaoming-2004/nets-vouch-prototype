const test = require('node:test');
const assert = require('node:assert/strict');
const { createInitialDemo, getNearbyMerchants, getSmartRecommendation, isMealMerchant, clearDiscoveryCache,
  clearMerchantResearchCache, clearSearchIntentCache, resetMerchantCampaigns } = require('../app');

// Meal-merchant eligibility: Smart Match recommends a proper meal, so a place whose PRIMARY provider
// type/category is coffee, tea, drinks, bakery, dessert or snacks never reaches ranking. Decided from
// provider metadata only - no merchant names, food words or locations.
const originalFetch = global.fetch;
const trackedKeys = ['GOOGLE_PLACES_API_KEY', 'FOURSQUARE_API_KEY', 'PLACES_PROVIDER', 'OPENAI_API_KEY',
  'TAVILY_API_KEY', 'GROQ_API_KEY'];
const originalEnv = {};
trackedKeys.forEach(function(key) { originalEnv[key] = process.env[key]; });
test.after(function() {
  trackedKeys.forEach(function(key) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  });
});
test.beforeEach(function() {
  resetMerchantCampaigns();
  clearDiscoveryCache();
  clearMerchantResearchCache();
  clearSearchIntentCache();
  trackedKeys.forEach(function(key) { delete process.env[key]; });
  global.fetch = originalFetch;
});
test.afterEach(function() { global.fetch = originalFetch; });

const ORIGIN = { latitude: 1.3, longitude: 103.8556 };
const M = 111195;

function place(id, name, primaryType, metres, types, address) {
  return { id: id, displayName: { text: name }, primaryType: primaryType,
    types: (types || [primaryType]).concat(['food', 'point_of_interest', 'establishment']),
    formattedAddress: address || '1 Example Road, Singapore',
    location: { latitude: ORIGIN.latitude + metres / M, longitude: ORIGIN.longitude } };
}

// Mocks Google (Nearby + Text) and Groq; records what the ranker was shown.
function mockGoogleAndGroq(options) {
  const calls = { nearby: 0, text: [], groq: [], intent: [] };
  global.fetch = async function(url, init) {
    const target = String(url);
    const body = init && init.body ? JSON.parse(init.body) : {};
    if (target.endsWith(':searchNearby')) {
      calls.nearby += 1;
      return { ok: true, json: async function() { return { places: options.nearby || [] }; } };
    }
    if (target.endsWith(':searchText')) {
      calls.text.push(body);
      return { ok: true, json: async function() { return { places: options.text || [] }; } };
    }
    if (new URL(target).hostname === 'api.groq.com' &&
        String(body.messages[0].content).indexOf('You turn a free-text food craving') === 0) {
      // Search-intent pre-step: fails by default here, so discovery uses the raw craving.
      calls.intent.push(body);
      return { ok: false, status: 500 };
    }
    if (new URL(target).hostname === 'api.groq.com') {
      calls.groq.push(body);
      const prompt = body.messages.map(function(m) { return m.content; }).join('\n');
      const reply = typeof options.groq === 'function' ? options.groq(prompt) : options.groq;
      if (!reply) return { ok: false, status: 500 };
      return { ok: true, json: async function() { return { choices: [{ message: { content: JSON.stringify(reply) } }] }; } };
    }
    return { ok: false, status: 404 };
  };
  return calls;
}

function listedCandidates(groqBody) {
  const prompt = groqBody.messages.map(function(m) { return m.content; }).join('\n');
  return JSON.parse(prompt.split('Eligible merchants:\n')[1].split('\n\nOutput:')[0]);
}

async function discoverAndRank(craving, options) {
  process.env.GOOGLE_PLACES_API_KEY = 'test-google';
  process.env.GROQ_API_KEY = 'test-groq';
  const calls = mockGoogleAndGroq(options);
  const demo = createInitialDemo('jia');
  demo.profile.craving = craving;
  const nearby = await getNearbyMerchants(ORIGIN, 'jia', craving, demo.profile.maxDistanceMinutes);
  const result = await getSmartRecommendation(demo.profile, nearby.merchants, [], [], demo, []);
  return { calls: calls, result: result, merchants: nearby.merchants };
}

function googleMerchant(primaryType, types, extra) {
  return Object.assign({ id: 'google-x', source: 'GOOGLE', primaryType: primaryType, placeTypes: types || [primaryType] }, extra || {});
}

// --- Google merchant type -------------------------------------------------------------------------

test('MEAL A-D: cafe, bakery, coffee_shop and dessert/drink primary types are not meal merchants', function() {
  // coffee_shop is covered separately: the Singapore exception makes it MEAL with meal-service evidence.
  assert.equal(isMealMerchant(googleMerchant('coffee_shop', ['coffee_shop', 'cafe'])), false);
  for (const type of ['cafe', 'bakery', 'dessert_shop', 'pastry_shop', 'dessert_restaurant',
    'ice_cream_shop', 'juice_shop', 'tea_house', 'convenience_store', 'store']) {
    assert.equal(isMealMerchant(googleMerchant(type, [type, 'restaurant'])), false, type);
  }
  // Generic food_store is non-meal unless a stronger meal signal exists.
  assert.equal(isMealMerchant(googleMerchant('food_store', ['food_store'])), false);
  assert.equal(isMealMerchant(googleMerchant('food_store', ['food_store', 'meal_takeaway'])), true);
});

test('MEAL E/F: restaurant, fast food, takeaway and cuisine restaurants are meal merchants', function() {
  for (const type of ['restaurant', 'fast_food_restaurant', 'meal_takeaway', 'chicken_restaurant',
    'chinese_restaurant', 'halal_restaurant', 'sandwich_shop', 'salad_shop', 'noodle_shop']) {
    assert.equal(isMealMerchant(googleMerchant(type)), true, type);
  }
});

test('MEAL G: the primary type wins over secondary types in both directions', function() {
  assert.equal(isMealMerchant(googleMerchant('restaurant', ['restaurant', 'cafe', 'coffee_shop'])), true);
  assert.equal(isMealMerchant(googleMerchant('cafe', ['cafe', 'restaurant', 'meal_takeaway'])), false);
  assert.equal(isMealMerchant(googleMerchant(null, ['meal_takeaway', 'store'])), true, 'no primary: secondary meal type counts');
  assert.equal(isMealMerchant(googleMerchant(null, ['cafe', 'bakery'])), false);
});

test('MEAL H/I: a restaurant stall inside a food court is kept; the food court itself is excluded', async function() {
  const { calls } = await discoverAndRank('', {
    nearby: [
      place('meng', 'Mr Chicken Meng', 'restaurant', 100, ['restaurant'], 'Republic Polytechnic, South Food Court, Stall 11'),
      place('court', 'Koufu South Food Court', 'food_court', 90, ['food_court'])
    ],
    groq: { merchantId: 'google-meng', relevance: 'medium', budgetFit: 'unknown', reason: 'Within your walking range.' }
  });
  const ids = listedCandidates(calls.groq[0]).map(function(m) { return m.id; });
  assert.deepEqual(ids, ['google-meng']);
});

test('MEAL nearby request: meal-oriented included types; cafes/bakeries are not requested', async function() {
  const captured = [];
  process.env.GOOGLE_PLACES_API_KEY = 'test-google';
  global.fetch = async function(url, init) {
    captured.push(JSON.parse(init.body));
    return { ok: true, json: async function() { return { places: [place('r', 'Rice Place', 'restaurant', 50)] }; } };
  };
  await getNearbyMerchants(ORIGIN, 'jia', '', 10);
  assert.deepEqual(captured[0].includedTypes, ['restaurant', 'fast_food_restaurant', 'meal_takeaway']);
  for (const type of ['cafe', 'coffee_shop', 'bakery', 'food_court', 'shopping_mall']) {
    assert.ok(captured[0].excludedPrimaryTypes.includes(type), type);
  }
});

// --- Craving ----------------------------------------------------------------------------------------

test('MEAL J: "noodles" - a cafe never reaches the ranker; the AI may pick the farther noodle restaurant', async function() {
  const { calls, result } = await discoverAndRank('noodles', {
    text: [
      place('cafe', 'Corner Tea Cafe', 'cafe', 50, ['cafe', 'coffee_shop']),
      place('generic', 'Generic Restaurant', 'restaurant', 100),
      place('noodle', 'Corner Noodle House', 'noodle_restaurant', 400, ['noodle_restaurant', 'restaurant']),
      place('r1', 'Rice One', 'restaurant', 150), place('r2', 'Rice Two', 'restaurant', 160),
      place('r3', 'Rice Three', 'restaurant', 170)
    ],
    groq: function(prompt) {
      const listed = JSON.parse(prompt.split('Eligible merchants:\n')[1].split('\n\nOutput:')[0]);
      const fit = listed.find(function(m) { return m.categories.some(function(c) { return /noodle/i.test(c); }); });
      return { merchantId: fit.id, relevance: 'high', budgetFit: 'unknown',
        reason: 'Its Noodle Restaurant category fits your noodles craving and is 400 m away.' };
    }
  });
  const ids = listedCandidates(calls.groq[0]).map(function(m) { return m.id; });
  assert.ok(!ids.includes('google-cafe'));
  assert.ok(ids.includes('google-generic'));
  assert.equal(result.merchant.id, 'google-noodle');
  assert.equal(calls.text[0].textQuery, 'noodles');
});

test('MEAL K: "spicy chicken" - a bakery is filtered before the ranker', async function() {
  const { calls } = await discoverAndRank('spicy chicken', {
    text: [
      place('bake', 'Morning Bakes', 'bakery', 40, ['bakery', 'cafe']),
      place('chix', 'Hot Chicken Co', 'chicken_restaurant', 300, ['chicken_restaurant', 'restaurant']),
      place('generic', 'Generic Restaurant', 'restaurant', 120),
      place('r1', 'Rice One', 'restaurant', 150), place('r2', 'Rice Two', 'restaurant', 160),
      place('r3', 'Rice Three', 'restaurant', 170)
    ],
    groq: { merchantId: 'google-chix', relevance: 'high', budgetFit: 'unknown', reason: 'Fits your spicy chicken craving.' }
  });
  const ids = listedCandidates(calls.groq[0]).map(function(m) { return m.id; });
  assert.ok(!ids.includes('google-bake'));
  assert.ok(ids.includes('google-chix') && ids.includes('google-generic'));
});

test('MEAL K2: a Text Search full of non-meal places triggers the broad Nearby fallback', async function() {
  const { calls, result } = await discoverAndRank('bubble tea', {
    text: [place('t1', 'Tea One', 'tea_house', 50), place('t2', 'Tea Two', 'cafe', 60), place('t3', 'Dessert', 'dessert_shop', 70)],
    nearby: [place('meal', 'Meal Place', 'restaurant', 120)],
    groq: { merchantId: 'google-meal', relevance: 'low', budgetFit: 'unknown', reason: 'Closest available fit.' }
  });
  assert.equal(calls.nearby, 1, 'zero usable meal merchants from Text Search -> one Nearby fallback');
  assert.deepEqual(listedCandidates(calls.groq[0]).map(function(m) { return m.id; }), ['google-meal']);
  assert.equal(result.merchant.id, 'google-meal');
  assert.equal(result.reason, 'This is the closest available fit from the nearby options.', 'low relevance stays conservative');
});

test('MEAL L: an arbitrary craving reaches Google and Groq verbatim', async function() {
  const { calls } = await discoverAndRank('something warm and soupy', {
    text: [place('soup', 'Soup Spot', 'restaurant', 100), place('r1', 'R1', 'restaurant', 110),
      place('r2', 'R2', 'restaurant', 120), place('r3', 'R3', 'restaurant', 130), place('r4', 'R4', 'restaurant', 140)],
    groq: { merchantId: 'google-soup', relevance: 'medium', budgetFit: 'unknown', reason: 'A likely fit for your craving.' }
  });
  assert.equal(calls.text[0].textQuery, 'something warm and soupy');
  const prompt = calls.groq[0].messages.map(function(m) { return m.content; }).join('\n');
  assert.match(prompt, /- Specific craving: something warm and soupy\n/);
});

test('MEAL M: an excluded cafe ID returned by the ranker is rejected, never recommended', async function() {
  const { calls, result } = await discoverAndRank('noodles', {
    text: [place('cafe', 'Corner Tea Cafe', 'cafe', 50), place('noodle', 'Noodle Bar', 'noodle_restaurant', 300),
      place('r1', 'R1', 'restaurant', 110), place('r2', 'R2', 'restaurant', 120), place('r3', 'R3', 'restaurant', 130)],
    groq: { merchantId: 'google-cafe', relevance: 'high', budgetFit: 'unknown', reason: 'Fits your craving.' }
  });
  assert.equal(calls.groq.length, 1);
  assert.notEqual(result.merchant.id, 'google-cafe', 'invalid candidate -> rules fallback over meal merchants only');
  assert.equal(result.reason, null);
});

test('MEAL rules fallback: without AI keys a nearer cafe still never wins', async function() {
  process.env.GOOGLE_PLACES_API_KEY = 'test-google';
  mockGoogleAndGroq({ nearby: [place('cafe', 'Corner Cafe', 'cafe', 20), place('meal', 'Meal Place', 'restaurant', 300)] });
  const demo = createInitialDemo('jia');
  const nearby = await getNearbyMerchants(ORIGIN, 'jia', '', 10);
  assert.ok(nearby.merchants.some(function(m) { return m.id === 'google-cafe'; }), 'discovery still returns it (e.g. for Scan)');
  const result = await getSmartRecommendation(demo.profile, nearby.merchants, [], [], demo, []);
  assert.equal(result.merchant.id, 'google-meal');
});

// --- Foursquare fallback ------------------------------------------------------------------------

function fsq(id, name, categories, extra) {
  return Object.assign({ fsq_place_id: id, name: name, latitude: 1.3005, longitude: 103.8556, distance: 60,
    categories: categories.map(function(c) { return { name: c }; }),
    location: { formatted_address: '1 Example Road, Singapore' } }, extra || {});
}

test('MEAL FSQ: cafes/bakeries excluded, restaurants and stalls inside containers kept, containers excluded', async function() {
  process.env.FOURSQUARE_API_KEY = 'test-fsq';
  global.fetch = async function() {
    return { ok: true, json: async function() { return { results: [
      fsq('cafe', 'Corner Cafe', ['Café']),
      fsq('coffee', 'Bean There', ['Coffee Shop']),
      fsq('bakery', 'Morning Bakes', ['Bakery']),
      fsq('tea', 'Tea Time', ['Bubble Tea Shop']),
      fsq('mixed', 'Cafe Restaurant', ['Café', 'Restaurant']),
      fsq('rest', 'Rice House', ['Chinese Restaurant', 'Café']),
      fsq('stall', 'Stall Noodles', ['Noodle Restaurant'], { related_places: { parent: { fsq_place_id: 'court', name: 'Big Food Court' } } }),
      fsq('court', 'Big Food Court', ['Food Court'])
    ] }; } };
  };
  const demo = createInitialDemo('jia');
  const nearby = await getNearbyMerchants(ORIGIN, 'jia', '', 10);
  const meal = nearby.merchants.filter(isMealMerchant).map(function(m) { return m.id; }).sort();
  assert.deepEqual(meal, ['foursquare-rest', 'foursquare-stall'], 'primary category decides');
  assert.ok(!nearby.merchants.some(function(m) { return m.id === 'foursquare-court'; }), 'container removed at discovery');
  const result = await getSmartRecommendation(demo.profile, nearby.merchants, [], [], demo, []);
  assert.ok(['foursquare-rest', 'foursquare-stall'].includes(result.merchant.id));
});

test('MEAL curated demo merchants all remain meal merchants', async function() {
  const merchants = (await getNearbyMerchants()).merchants;
  assert.equal(merchants.length, 5);
  assert.ok(merchants.every(isMealMerchant));
});

test('MEAL no merchant-specific or location-specific eligibility logic in production code', function() {
  const source = require('fs').readFileSync(require('path').join(__dirname, '..', 'app.js'), 'utf8');
  const block = source.slice(source.indexOf('// Meal-merchant eligibility.'), source.indexOf('// Two entries are the same real place'));
  assert.ok(block.length > 0);
  assert.ok(!/mamacha|republic|woodlands|bugis|canberra|felicia|\d+\.\d{3,}/i.test(block));
});
