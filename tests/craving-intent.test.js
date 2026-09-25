const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createInitialDemo, getNearbyMerchants, getSmartRecommendation, classifyMealEligibility,
  clearDiscoveryCache, clearMerchantResearchCache, clearSearchIntentCache, resetMerchantCampaigns } = require('../app');

// Resilient meal-type classification (MEAL / NON_MEAL / UNCERTAIN) and the Groq search-intent
// pre-step for local/free-text cravings. No food dictionary, merchant or location logic in production.
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
const INTENT_MARKER = 'You turn a free-text food craving';

function place(id, name, primaryType, metres, types) {
  const list = types || (primaryType ? [primaryType] : []);
  return { id: id, displayName: { text: name }, primaryType: primaryType || undefined,
    types: list.concat(['food', 'point_of_interest', 'establishment']),
    formattedAddress: '1 Example Road, Singapore',
    location: { latitude: ORIGIN.latitude + metres / M, longitude: ORIGIN.longitude } };
}

function chat(obj) {
  return { ok: true, json: async function() {
    return { choices: [{ message: { content: typeof obj === 'string' ? obj : JSON.stringify(obj) } }] };
  } };
}

// intent / rank: an object reply, a function(userOrPrompt) -> reply, or { status } for HTTP failure.
function mockAll(options) {
  const calls = { nearby: [], text: [], intent: [], rank: [] };
  global.fetch = async function(url, init) {
    const target = String(url);
    const body = init && init.body ? JSON.parse(init.body) : {};
    if (target.endsWith(':searchNearby')) {
      calls.nearby.push(body);
      return { ok: true, json: async function() { return { places: options.nearby || [] }; } };
    }
    if (target.endsWith(':searchText')) {
      calls.text.push(body);
      const places = typeof options.text === 'function' ? options.text(body.textQuery) : options.text || [];
      return { ok: true, json: async function() { return { places: places }; } };
    }
    if (new URL(target).hostname === 'api.groq.com') {
      const isIntent = String(body.messages[0].content).indexOf(INTENT_MARKER) === 0;
      const prompt = body.messages.map(function(m) { return m.content; }).join('\n');
      (isIntent ? calls.intent : calls.rank).push({ body: body, prompt: prompt });
      const handler = isIntent ? options.intent : options.rank;
      const reply = typeof handler === 'function' ? handler(prompt) : handler;
      if (!reply || reply.status) return { ok: false, status: reply ? reply.status : 500 };
      return chat(reply);
    }
    return { ok: false, status: 404 };
  };
  return calls;
}

function listed(rankCall) {
  return JSON.parse(rankCall.prompt.split('Eligible merchants:\n')[1].split('\n\nOutput:')[0]);
}

async function run(craving, options, profileExtra) {
  process.env.GOOGLE_PLACES_API_KEY = 'test-google';
  process.env.GROQ_API_KEY = 'test-groq';
  const calls = mockAll(options);
  const demo = createInitialDemo('jia');
  demo.profile.craving = craving;
  Object.assign(demo.profile, profileExtra || {});
  const nearby = await getNearbyMerchants(ORIGIN, 'jia', craving, demo.profile.maxDistanceMinutes);
  const result = await getSmartRecommendation(demo.profile, nearby.merchants, [], [], demo, []);
  return { calls: calls, result: result, merchants: nearby.merchants };
}

function g(primaryType, types) {
  return { source: 'GOOGLE', primaryType: primaryType, placeTypes: types || (primaryType ? [primaryType] : []) };
}

// --- A-F: future-proof Google type classification ------------------------------------------------

test('TYPE A/B: an unknown primary type with strong secondary meal evidence is MEAL', function() {
  assert.equal(classifyMealEligibility(g('future_noodle_stall', ['future_noodle_stall', 'restaurant'])), 'MEAL');
  assert.equal(classifyMealEligibility(g('future_meal_stall', ['future_meal_stall', 'meal_takeaway'])), 'MEAL');
  assert.equal(classifyMealEligibility(g('rice_noodle_shop', ['rice_noodle_shop', 'meal_takeaway'])), 'MEAL');
});

test('TYPE C: an unknown primary type with only generic food metadata is UNCERTAIN, not NON_MEAL', function() {
  assert.equal(classifyMealEligibility(g('future_food_business', ['future_food_business'])), 'UNCERTAIN');
  assert.equal(classifyMealEligibility(g(null, [])), 'UNCERTAIN');
});

test('TYPE D/E: an explicit non-meal primary type wins over secondary meal types', function() {
  assert.equal(classifyMealEligibility(g('cafe', ['cafe', 'restaurant'])), 'NON_MEAL');
  assert.equal(classifyMealEligibility(g('bakery', ['bakery', 'meal_takeaway'])), 'NON_MEAL');
  assert.equal(classifyMealEligibility(g('coffee_shop', ['coffee_shop', 'cafe', 'food_store', 'store'])), 'NON_MEAL');
  assert.equal(classifyMealEligibility(g('dessert_restaurant', ['dessert_restaurant', 'restaurant'])), 'NON_MEAL');
  assert.equal(classifyMealEligibility(g(null, ['cafe', 'bakery'])), 'NON_MEAL');
});

test('TYPE F: any new "_restaurant" primary type is MEAL without being listed', function() {
  for (const type of ['new_cuisine_restaurant', 'chinese_noodle_restaurant', 'soup_restaurant', 'vegan_restaurant']) {
    assert.equal(classifyMealEligibility(g(type)), 'MEAL', type);
  }
});

test('TYPE Foursquare: primary category decides; unfamiliar categories are UNCERTAIN, not excluded', function() {
  const f = function(categories) { return { source: 'FOURSQUARE', categoryNames: categories }; };
  assert.equal(classifyMealEligibility(f(['Café', 'Restaurant'])), 'NON_MEAL');
  assert.equal(classifyMealEligibility(f(['Bubble Tea Shop'])), 'NON_MEAL');
  assert.equal(classifyMealEligibility(f(['Hawker Stall'])), 'MEAL');
  assert.equal(classifyMealEligibility(f(['Zi Char Place', 'Chinese Restaurant'])), 'MEAL', 'secondary meal category promotes');
  assert.equal(classifyMealEligibility(f(['Zi Char Place'])), 'UNCERTAIN');
  assert.equal(classifyMealEligibility(f([])), 'UNCERTAIN');
});

// --- Raw-first craving search; semantic expansion only as a fallback ------------------------------

const noodleSpots = [
  place('generic', 'Generic Restaurant', 'restaurant', 50),
  place('noodle', 'Corner Noodle House', 'noodle_shop', 300, ['noodle_shop', 'restaurant']),
  place('r1', 'R1', 'restaurant', 110), place('r2', 'R2', 'restaurant', 120), place('r3', 'R3', 'restaurant', 130)
];
const RAW = 'bee hoon';
const EXPANDED = 'bee hoon rice vermicelli';
const rawTwo = [place('a', 'Stall A', 'restaurant', 300), place('b', 'Stall B', 'restaurant', 400)];
const expandedTwo = [place('b', 'Stall B', 'restaurant', 400), place('c', 'Stall C', 'restaurant', 500)];
function byQuery(map) { return function(query) { return map[query] || []; }; }
function ids(merchants) { return merchants.map(function(m) { return m.id; }); }

test('RAW A: enough usable raw results -> 1 Text Search, 0 Groq search-intent calls, no expansion', async function() {
  const six = noodleSpots.concat([place('r4', 'R4', 'restaurant', 140)]);
  const { calls } = await run(RAW, { text: six, intent: { searchQuery: EXPANDED },
    rank: { merchantId: 'google-noodle', relevance: 'high', budgetFit: 'unknown', reason: 'Fits your craving.' } });
  assert.deepEqual(calls.text.map(function(c) { return c.textQuery; }), [RAW]);
  assert.equal(calls.intent.length, 0);
  assert.equal(calls.nearby.length, 0);
  assert.ok(!/Discovery search used/.test(calls.rank[0].prompt), 'no expanded search -> no discovery-query line');
});

test('RAW B/C: too few usable raw results -> 1 expansion + 1 expanded search, merged and deduplicated', async function() {
  const { calls, merchants } = await run(RAW, { text: byQuery({ 'bee hoon': rawTwo, 'bee hoon rice vermicelli': expandedTwo }),
    intent: { searchQuery: EXPANDED } });
  assert.deepEqual(calls.text.map(function(c) { return c.textQuery; }), [RAW, EXPANDED]);
  assert.equal(calls.intent.length, 1);
  assert.equal(calls.nearby.length, 0, 'max 2 Google calls: no Nearby fallback after an expanded search');
  assert.deepEqual(ids(merchants), ['google-a', 'google-b', 'google-c'], 'raw first, expanded added, B once');
});

test('RAW D: a strong raw result missing from the expanded search is still kept and rankable', async function() {
  const rawStrong = [place('strong', 'Neutral Noodle Stall', 'noodle_shop', 350, ['noodle_shop', 'restaurant']),
    place('x', 'X', 'restaurant', 200)];
  const expandedWorse = [place('far1', 'Far One', 'restaurant', 700), place('far2', 'Far Two', 'restaurant', 750)];
  const { calls, result, merchants } = await run(RAW, {
    text: byQuery({ 'bee hoon': rawStrong, 'bee hoon rice vermicelli': expandedWorse }),
    intent: { searchQuery: EXPANDED },
    rank: { merchantId: 'google-strong', relevance: 'high', budgetFit: 'unknown', reason: 'Its Noodle Shop category fits your craving.' }
  });
  assert.ok(ids(merchants).includes('google-strong'));
  assert.ok(listed(calls.rank[0]).some(function(m) { return m.id === 'google-strong'; }));
  assert.equal(result.merchant.id, 'google-strong');
  assert.match(calls.rank[0].prompt, /- Specific craving: bee hoon\n/, 'the ranker keeps the raw craving');
  assert.match(calls.rank[0].prompt, /Discovery search used \(retrieval only, NOT the user's words\): bee hoon rice vermicelli/);
});

test('RAW E: expansion fails -> raw results kept, the one Nearby fallback runs, never demo', async function() {
  for (const intent of [{ status: 429 }, { status: 500 }, 'not json', { concepts: [] }]) {
    clearSearchIntentCache();
    clearDiscoveryCache();
    const { calls, merchants } = await run(RAW, { text: byQuery({ 'bee hoon': rawTwo }), intent: intent,
      nearby: [place('n1', 'Nearby One', 'restaurant', 150)] });
    assert.deepEqual(calls.text.map(function(c) { return c.textQuery; }), [RAW], JSON.stringify(intent));
    assert.equal(calls.intent.length, 1, 'no retry of the intent call');
    assert.equal(calls.nearby.length, 1);
    assert.deepEqual(ids(merchants), ['google-a', 'google-b', 'google-n1']);
  }
});

test('RAW E2: no Groq key -> no intent call; raw results kept with the Nearby fallback', async function() {
  process.env.GOOGLE_PLACES_API_KEY = 'test-google';
  const calls = mockAll({ text: byQuery({ 'bee hoon': rawTwo }), nearby: [place('n1', 'Nearby One', 'restaurant', 150)] });
  const nearby = await getNearbyMerchants(ORIGIN, 'jia', RAW, 10);
  assert.equal(nearby.source, 'google');
  assert.equal(calls.intent.length, 0);
  assert.deepEqual(ids(nearby.merchants), ['google-a', 'google-b', 'google-n1']);
});

test('RAW F: unsafe expansions are never searched; raw results are preserved', async function() {
  for (const searchQuery of [
    'bee hoon Popeyes Woodlands', 'bee hoon near me', 'halal bee hoon', 'bee hoon singapore',
    'rice vermicelli noodles', 'bee hoon 738099', 'best bee hoon', 'bee hoon <b>', 'bee hoon @ mall'
  ]) {
    clearSearchIntentCache();
    clearDiscoveryCache();
    const { calls, merchants } = await run(RAW, { text: byQuery({ 'bee hoon': rawTwo }), intent: { searchQuery: searchQuery } });
    assert.deepEqual(calls.text.map(function(c) { return c.textQuery; }), [RAW], searchQuery);
    assert.ok(ids(merchants).includes('google-a') && ids(merchants).includes('google-b'));
  }
  // A dietary word the user DID write is kept in the expansion.
  clearSearchIntentCache();
  clearDiscoveryCache();
  const { calls } = await run('vegetarian bee hoon', { text: byQuery({}), intent: { searchQuery: 'vegetarian bee hoon rice vermicelli' } });
  assert.deepEqual(calls.text.map(function(c) { return c.textQuery; }), ['vegetarian bee hoon', 'vegetarian bee hoon rice vermicelli']);
});

test('RAW H: a compound craving is searched raw first and stays the user intent', async function() {
  const { calls } = await run('noodles and bee hoon', { text: byQuery({}), intent: { searchQuery: 'noodles and bee hoon rice vermicelli' },
    nearby: [] });
  assert.deepEqual(calls.text.map(function(c) { return c.textQuery; }), ['noodles and bee hoon', 'noodles and bee hoon rice vermicelli']);
  assert.match(calls.intent[0].prompt, /Craving: noodles and bee hoon$/);
});

test('RAW K: the same insufficient craving reuses the cached expansion - no second Groq intent call', async function() {
  const options = { text: byQuery({ 'bee hoon': rawTwo, 'bee hoon rice vermicelli': expandedTwo }), intent: { searchQuery: EXPANDED } };
  const first = await run(RAW, options);
  assert.equal(first.calls.intent.length, 1);
  clearDiscoveryCache();
  const second = await run('  Bee   Hoon ', options);
  assert.equal(second.calls.intent.length, 0, 'normalised craving hits the search-intent cache');
  assert.deepEqual(second.calls.text.map(function(c) { return c.textQuery; }), ['Bee   Hoon', EXPANDED]);
});

// --- Singapore coffee_shop: meal evidence in its own types makes it a meal merchant ---------------

test('COFFEE G/H: coffee_shop with restaurant or meal-service evidence is MEAL', function() {
  assert.equal(classifyMealEligibility(g('coffee_shop', ['coffee_shop', 'restaurant'])), 'MEAL');
  assert.equal(classifyMealEligibility(g('coffee_shop', ['coffee_shop', 'meal_takeaway'])), 'MEAL');
  assert.equal(classifyMealEligibility(g('coffee_shop', ['coffee_shop', 'breakfast_restaurant', 'cafe', 'food_store', 'store', 'restaurant'])), 'MEAL');
  assert.equal(classifyMealEligibility(g('coffee_shop', ['coffee_shop', 'noodle_shop'])), 'MEAL');
});

test('COFFEE I/J: coffee_shop alone or with only generic/cafe metadata stays NON_MEAL', function() {
  assert.equal(classifyMealEligibility(g('coffee_shop', ['coffee_shop'])), 'NON_MEAL');
  assert.equal(classifyMealEligibility(g('coffee_shop', ['coffee_shop', 'cafe', 'food_store', 'store'])), 'NON_MEAL');
});

test('COFFEE K/L: the exception is coffee_shop only - cafe, bakery, dessert, juice, tea, ice cream unchanged', function() {
  for (const type of ['cafe', 'bakery', 'dessert_shop', 'juice_shop', 'tea_house', 'ice_cream_shop']) {
    assert.equal(classifyMealEligibility(g(type, [type, 'restaurant', 'meal_takeaway'])), 'NON_MEAL', type);
  }
});

test('COFFEE stall end-to-end: a coffee_shop stall with meal evidence reaches the ranker; a plain one does not', async function() {
  const { calls } = await run(RAW, {
    text: noodleSpots.concat([
      place('kopi', 'Neutral Kopi Stall', 'coffee_shop', 60, ['coffee_shop', 'breakfast_restaurant', 'cafe', 'restaurant']),
      place('plain', 'Plain Coffee', 'coffee_shop', 40, ['coffee_shop', 'cafe', 'food_store', 'store'])
    ]),
    rank: { merchantId: 'google-kopi', relevance: 'high', budgetFit: 'unknown', reason: 'Fits your craving.' }
  });
  const candidateIds = ids(listed(calls.rank[0]));
  assert.ok(candidateIds.includes('google-kopi'));
  assert.ok(!candidateIds.includes('google-plain'));
});

// --- L-N: ranking -----------------------------------------------------------------------------------

test('RANK L: a farther merchant with noodle evidence may beat a nearer generic restaurant', async function() {
  const { calls, result } = await run('bee hoon', {
    intent: { status: 500 },
    text: noodleSpots,
    rank: function(prompt) {
      const fit = JSON.parse(prompt.split('Eligible merchants:\n')[1].split('\n\nOutput:')[0])
        .find(function(m) { return m.categories.some(function(c) { return /noodle/i.test(c); }); });
      return { merchantId: fit.id, relevance: 'high', budgetFit: 'unknown', reason: 'Its Noodle Shop category fits your craving best.' };
    }
  });
  assert.equal(result.merchant.id, 'google-noodle');
  assert.ok(listed(calls.rank[0]).some(function(m) { return m.id === 'google-generic'; }));
});

test('RANK M: a cafe at 20 m never reaches the final ranker', async function() {
  const { calls } = await run('bee hoon', {
    intent: { status: 500 },
    text: [place('cafe', 'Corner Cafe', 'cafe', 20, ['cafe', 'restaurant'])].concat(noodleSpots),
    rank: { merchantId: 'google-noodle', relevance: 'high', budgetFit: 'unknown', reason: 'Fits your craving.' }
  });
  assert.ok(!listed(calls.rank[0]).some(function(m) { return m.id === 'google-cafe'; }));
});

test('RANK N: an UNCERTAIN craving-search result reaches the AI labelled; the AI can prefer MEAL evidence', async function() {
  const { calls, result } = await run('bee hoon', {
    intent: { status: 500 },
    text: [place('stall', 'Bee Hoon Corner', 'future_food_business', 40)].concat(noodleSpots),
    rank: function(prompt) {
      const candidates = JSON.parse(prompt.split('Eligible merchants:\n')[1].split('\n\nOutput:')[0]);
      const meal = candidates.find(function(m) { return m.mealEligibility === 'MEAL' && /noodle/i.test(m.categories.join()); });
      return { merchantId: meal.id, relevance: 'high', budgetFit: 'unknown', reason: 'Its Noodle Shop category fits your craving.' };
    }
  });
  const candidates = listed(calls.rank[0]);
  assert.equal(candidates.find(function(m) { return m.id === 'google-stall'; }).mealEligibility, 'UNCERTAIN');
  assert.equal(candidates.find(function(m) { return m.id === 'google-noodle'; }).mealEligibility, 'MEAL');
  assert.match(calls.rank[0].prompt, /never pick an UNCERTAIN one merely because it is nearer/);
  assert.equal(result.merchant.id, 'google-noodle');
});

test('UNCERTAIN rules fallback: a nearer UNCERTAIN merchant never beats a MEAL merchant on distance alone', async function() {
  process.env.GOOGLE_PLACES_API_KEY = 'test-google';
  mockAll({ text: [place('stall', 'Mystery Stall', 'future_food_business', 20),
    place('meal', 'Meal Place', 'restaurant', 500)].concat(noodleSpots.slice(2)) });
  const demo = createInitialDemo('jia');
  demo.profile.craving = 'something tasty';
  const nearby = await getNearbyMerchants(ORIGIN, 'jia', 'something tasty', 10);
  const result = await getSmartRecommendation(demo.profile, nearby.merchants, [], [], demo, []);
  assert.notEqual(result.merchant.id, 'google-stall');
});

test('UNCERTAIN no-craving: excluded while the MEAL pool is big enough, used only when it is too small', async function() {
  process.env.GOOGLE_PLACES_API_KEY = 'test-google';
  const uncertain = place('stall', 'Mystery Stall', 'future_food_business', 20);
  const meals = [1, 2, 3, 4, 5].map(function(i) { return place('m' + i, 'Meal ' + i, 'restaurant', 100 * i); });
  mockAll({ nearby: [uncertain].concat(meals) });
  const demo = createInitialDemo('jia');
  let nearby = await getNearbyMerchants(ORIGIN, 'jia', '', 10);
  let result = await getSmartRecommendation(demo.profile, nearby.merchants, [], [], demo, []);
  assert.equal(result.merchant.id, 'google-m1', 'enough MEAL merchants: the nearer UNCERTAIN one is not used');
  clearDiscoveryCache();
  mockAll({ nearby: [uncertain] });
  nearby = await getNearbyMerchants(ORIGIN, 'jia', '', 10);
  result = await getSmartRecommendation(demo.profile, nearby.merchants, [], [], demo, []);
  assert.equal(result.merchant.id, 'google-stall', 'too few MEAL merchants: UNCERTAIN keeps Smart Match usable');
});

test('NO DICTIONARY: the craving search-intent and meal-eligibility code hold no food, merchant or location mapping', function() {
  // Scoped to the craving/eligibility code: the separate, pre-existing "Mood today" dropdown keyword
  // list (moodCuisineKeywords) maps fixed mood options, not free-text cravings.
  const full = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  const slice = function(from, to) { return full.slice(full.indexOf(from), full.indexOf(to)); };
  const source = (slice('// Meal-merchant eligibility.', '// Two entries are the same real place') +
    slice('// Craving search intent (discovery only).', '// Google discovery. No craving') +
    slice('function buildRankingMessages', 'const RANKING_PROVIDERS')).toLowerCase();
  assert.ok(source.length > 5000, 'the scanned blocks exist');
  assert.ok(!/mamacha|republic|woodlands|bugis|canberra|felicia|\d+\.\d{3,}/.test(source), 'no merchant/location logic');
  for (const term of ['bee hoon', 'vermicelli', 'beehoon', 'mee hoon', 'cai fan', 'mala', 'prata', 'laksa']) {
    assert.ok(!new RegExp('\\b' + term + '\\b').test(source), term);
  }
});
