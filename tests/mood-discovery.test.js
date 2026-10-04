const rankingFixture = require('./ranking-fixture');
const test = require('node:test');
const assert = require('node:assert/strict');
const { app, createInitialDemo, getNearbyMerchants, getSmartRecommendation, getMoodMatchState,
  getMerchantCampaigns,
  getDietaryMatchState, MATCH_STATE, moodCuisineOptions, normaliseMoodCuisine,
  buildRankingMessagesForTest, clearDiscoveryCache,
  clearSearchIntentCache, resetMerchantCampaigns } = require('../app');
// "Mood today": the staple the user feels like eating. It steers Smart Match DISCOVERY (one
// mood-targeted provider search inside the existing call budget) and RANKING, and nothing else -
// it is never an eligibility rule, never menu proof and never dietary proof.
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
  clearSearchIntentCache();
  trackedKeys.forEach(function(key) { delete process.env[key]; });
  global.fetch = originalFetch;
});
test.afterEach(function() { global.fetch = originalFetch; });

const ORIGIN = { latitude: 1.4428, longitude: 103.7854 };
const M = 111195;

function place(id, name, metres, extra) {
  return Object.assign({ id: id, displayName: { text: name }, primaryType: 'restaurant',
    types: ['restaurant', 'food', 'point_of_interest', 'establishment'],
    formattedAddress: '1 Example Road, Singapore 7380' + String(10 + (metres % 80)).padStart(2, '0'),
    location: { latitude: ORIGIN.latitude + metres / M, longitude: ORIGIN.longitude } }, extra || {});
}

function generalPlaces(count, startMetres) {
  const list = [];
  for (let i = 0; i < count; i++) list.push(place('g' + i, 'General Eatery ' + i, (startMetres || 40) + i * 15));
  return list;
}

function fsqResult(id, name, categoryName, metres) {
  return { fsq_place_id: id, name: name, latitude: ORIGIN.latitude + (metres || 100) / M,
    longitude: ORIGIN.longitude, distance: metres || 100,
    categories: [{ name: categoryName || 'Restaurant' }],
    location: { formatted_address: 'Woodlands, Singapore' } };
}

// Google Nearby + Text (keyed by textQuery), Foursquare (keyed by query) and OpenAI ranking.
function mockProviders(options) {
  const calls = { nearby: 0, text: [], foursquare: [], openai: [] };
  global.fetch = async function(url, init) {
    const target = String(url);
    const body = init && init.body ? JSON.parse(init.body) : {};
    if (target.endsWith(':searchNearby')) {
      calls.nearby += 1;
      if (options.nearbyStatus) return { ok: false, status: options.nearbyStatus };
      return { ok: true, json: async function() { return { places: options.nearby || [] }; } };
    }
    if (target.endsWith(':searchText')) {
      calls.text.push(body.textQuery);
      if (options.textStatus) return { ok: false, status: options.textStatus };
      const places = (options.text && options.text[body.textQuery]) || [];
      return { ok: true, json: async function() { return { places: places }; } };
    }
    const host = new URL(target).hostname;
    if (host === 'places-api.foursquare.com') {
      const query = new URL(target).searchParams.get('query');
      calls.foursquare.push(query);
      const results = (options.foursquare && options.foursquare[query]) || [];
      return { ok: true, json: async function() { return { results: results }; } };
    }
    if (host === 'api.openai.com') {
      calls.openai.push(body);
      if (!options.openai) return { ok: false, status: 500 };
      return { ok: true, json: async function() {
        return { choices: [{ message: { content: JSON.stringify(rankingFixture(options.openai, body.messages)) } }] };
      } };
    }
    return { ok: false, status: 404 };
  };
  return calls;
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
    return { status: response.status, location: response.headers.get('location'), html: await response.text() };
  } };
}

// MOOD 1 ---------------------------------------------------------------------------------------
test('MOOD 1: exactly six mood choices with stable values, and the old choices are gone', async function() {
  assert.deepEqual(moodCuisineOptions, [
    { value: 'any', label: 'Anything' },
    { value: 'rice', label: 'Rice' },
    { value: 'noodles', label: 'Noodles' },
    { value: 'pasta', label: 'Pasta' },
    { value: 'soup', label: 'Soup' },
    { value: 'bread', label: 'Bread' }
  ]);
  // Mood is a current-meal input: it lives in onboarding and in the Smart Match refine form.
  const v = visitor();
  const home = await v.request('/home');
  await v.request('/smart-match/location', { status: 'fallback' });
  const card = (await v.request('/smart-match/result')).html;
  ['any', 'rice', 'noodles', 'pasta', 'soup', 'bread'].forEach(function(value) {
    assert.match(home.html, new RegExp('name="moodCuisine" value="' + value + '"'));
    assert.match(card, new RegExp('name="moodCuisine" value="' + value + '"'));
  });
  ['healthy', 'indian', 'wraps'].forEach(function(removed) {
    assert.doesNotMatch(home.html, new RegExp('name="moodCuisine" value="' + removed + '"'));
    assert.doesNotMatch(card, new RegExp('name="moodCuisine" value="' + removed + '"'));
  });
  assert.match(card, /Mood today/);
});

// MOOD 2 ---------------------------------------------------------------------------------------
test('MOOD 2: an invalid or legacy mood value safely falls back to "any"', async function() {
  ['healthy', 'indian', 'wraps', '', null, undefined, 'RICE', 42].forEach(function(value) {
    assert.equal(normaliseMoodCuisine(value), 'any');
  });
  ['any', 'rice', 'noodles', 'pasta', 'soup', 'bread'].forEach(function(value) {
    assert.equal(normaliseMoodCuisine(value), value);
  });
  // A stale value never silently matches nothing, and never becomes a discovery term.
  process.env.GOOGLE_PLACES_API_KEY = 'test-google';
  const calls = mockProviders({ nearby: generalPlaces(6) });
  await getNearbyMerchants(ORIGIN, 'jia', '', 30, 'none', 'healthy');
  assert.deepEqual(calls.text, [], 'a legacy mood adds no provider search');
  assert.equal(calls.nearby, 1, 'it behaves exactly like "Anything"');
  assert.equal(getMoodMatchState({ category: 'healthy-food', cuisineTags: [] }, 'healthy'), MATCH_STATE.UNKNOWN);

  // The onboarding form rejects it the same way: the stored mood becomes "any".
  const v = visitor();
  await v.request('/home');
  await v.request('/setup-preferences', { moodCuisine: 'healthy', dietaryPreference: 'none', craving: '' });
  const profile = await v.request('/profile');
  assert.doesNotMatch(profile.html, /Mood:/, 'an invalid mood is stored as "any", which the profile never labels');
});

// MOOD 3 ---------------------------------------------------------------------------------------
test('MOOD 3: "Anything" keeps the generic nearby discovery and gives nobody a mood bonus', async function() {
  process.env.GOOGLE_PLACES_API_KEY = 'test-google';
  const calls = mockProviders({ nearby: generalPlaces(6) });
  const nearby = await getNearbyMerchants(ORIGIN, 'jia', '', 30, 'none', 'any');
  assert.equal(calls.nearby, 1, 'one distance-ranked Nearby Search, as before');
  assert.deepEqual(calls.text, [], 'no mood term is added to provider searches');
  nearby.merchants.forEach(function(m) {
    assert.equal(getMoodMatchState(m, 'any'), MATCH_STATE.UNKNOWN, 'no merchant earns a mood ranking bonus');
    assert.ok(!m.fromMoodSearch);
  });
});

// MOOD 4 / 5 -----------------------------------------------------------------------------------
test('MOOD 4: each non-default mood becomes the food discovery term (mood-only discovery)', async function() {
  const terms = { rice: 'rice', noodles: 'noodles', pasta: 'pasta', soup: 'soup', bread: 'bread' };
  for (const mood of Object.keys(terms)) {
    clearDiscoveryCache();
    process.env.GOOGLE_PLACES_API_KEY = 'test-google';
    const places = [place('m1', 'Staple Stall', 120), place('m2', 'Second Stall', 180),
      place('m3', 'Third Stall', 240), place('m4', 'Fourth Stall', 300), place('m5', 'Fifth Stall', 360)];
    const calls = mockProviders({ text: { [terms[mood]]: places } });
    const nearby = await getNearbyMerchants(ORIGIN, 'jia', '', 30, 'none', mood);
    assert.deepEqual(calls.text, [terms[mood]], mood + ' searches for the staple itself');
    assert.equal(calls.nearby, 0, 'enough usable mood results - the broad Nearby Search is not needed');
    assert.ok(nearby.merchants.every(function(m) { return m.fromMoodSearch; }), 'retrieval flag only');
    assert.deepEqual(nearby.merchants[0].dietary, [], 'a mood search result is never dietary evidence');
  }
});

test('MOOD 5: too few mood results still fall back to the one broad Nearby Search', async function() {
  process.env.GOOGLE_PLACES_API_KEY = 'test-google';
  const calls = mockProviders({ text: { soup: [place('s1', 'Soup Spot', 150)] }, nearby: generalPlaces(8) });
  const nearby = await getNearbyMerchants(ORIGIN, 'jia', '', 30, 'none', 'soup');
  assert.deepEqual(calls.text, ['soup']);
  assert.equal(calls.nearby, 1, 'max 2 Google calls: mood search + one broad fallback');
  assert.ok(nearby.merchants.some(function(m) { return m.id === 'google-s1'; }));
  assert.ok(nearby.merchants.some(function(m) { return m.id === 'google-g0'; }));
});

test('MOOD 5b: Foursquare uses the mood as its primary query when there is no craving', async function() {
  process.env.PLACES_PROVIDER = 'foursquare';
  process.env.FOURSQUARE_API_KEY = 'test-fsq';
  const calls = mockProviders({ foursquare: {
    pasta: [fsqResult('p1', 'Pasta Corner', 'Italian Restaurant', 120),
      fsqResult('p2', 'Second Pasta', 'Restaurant', 160), fsqResult('p3', 'Third Pasta', 'Restaurant', 200),
      fsqResult('p4', 'Fourth Pasta', 'Restaurant', 240), fsqResult('p5', 'Fifth Pasta', 'Restaurant', 280)]
  } });
  const nearby = await getNearbyMerchants(ORIGIN, 'jia', '', 30, 'none', 'pasta');
  assert.deepEqual(calls.foursquare, ['pasta'], 'the mood replaces the generic query=food search');
  assert.equal(nearby.source, 'foursquare');
  assert.ok(nearby.merchants.every(function(m) { return m.fromMoodSearch; }));
});

test('MOOD 5c: a failed Google mood search still falls back to Foursquare', async function() {
  process.env.GOOGLE_PLACES_API_KEY = 'test-google';
  process.env.FOURSQUARE_API_KEY = 'test-fsq';
  const calls = mockProviders({ textStatus: 500, nearbyStatus: 500,
    foursquare: { bread: [fsqResult('b1', 'Toast House', 'Bakery', 90)] } });
  const nearby = await getNearbyMerchants(ORIGIN, 'jia', '', 30, 'none', 'bread');
  assert.deepEqual(calls.text, ['bread']);
  assert.equal(nearby.source, 'foursquare', 'provider fallback is unchanged');
  assert.deepEqual(calls.foursquare, ['bread', 'food'],
    'the mood is the primary query; the broad "food" query is still the one fallback');
});

// MOOD 6 ---------------------------------------------------------------------------------------
test('MOOD 6: both inputs use one combined query when intent AI is unavailable', async function() {
  process.env.GOOGLE_PLACES_API_KEY = 'test-google';
  const calls = mockProviders({ text: { 'crispy chicken rice': generalPlaces(6) } });
  const nearby = await getNearbyMerchants(ORIGIN, 'jia', 'crispy chicken', 30, 'none', 'rice');
  assert.deepEqual(calls.text, ['crispy chicken rice']);
  assert.ok(nearby.merchants.every(m => m.fromMoodSearch && m.fromCravingSearch));
});

test('MOOD 6b: Foursquare uses one combined input query and preserves provenance', async function() {
  process.env.PLACES_PROVIDER = 'foursquare'; process.env.FOURSQUARE_API_KEY = 'test-fsq';
  const calls = mockProviders({ foursquare: { 'crispy chicken noodles': [fsqResult('r1', 'Chicken Noodles', 'Noodle Restaurant', 100)] } });
  const nearby = await getNearbyMerchants(ORIGIN, 'jia', 'crispy chicken', 30, 'none', 'noodles');
  assert.deepEqual(calls.foursquare, ['crispy chicken noodles', 'food']);
  assert.equal(nearby.merchants[0].fromMoodSearch, true);
  assert.equal(nearby.merchants[0].fromCravingSearch, true);
});

// MOOD 7 ---------------------------------------------------------------------------------------
test('MOOD 7: combined raw fallback needs no synonym dictionary', async function() {
  process.env.GOOGLE_PLACES_API_KEY = 'test-google';
  for (const [craving, mood] of [['ramen', 'noodles'], ['spaghetti', 'pasta'], ['kaya toast', 'bread']]) {
    clearDiscoveryCache();
    const query = craving + ' ' + mood;
    const calls = mockProviders({ text: { [query]: generalPlaces(6) } });
    await getNearbyMerchants(ORIGIN, 'jia', craving, 30, 'none', mood);
    assert.deepEqual(calls.text, [query]); assert.equal(calls.nearby, 0);
  }
});

// MOOD 8 ---------------------------------------------------------------------------------------
test('MOOD 8: mood + dietary composes ONE query and keeps strict dietary verification', async function() {
  process.env.GOOGLE_PLACES_API_KEY = 'test-google';
  const calls = mockProviders({ text: { 'halal rice': [place('h1', 'Nasi Padang Stall', 200)] },
    nearby: generalPlaces(8) });
  const nearby = await getNearbyMerchants(ORIGIN, 'jia', '', 30, 'halal', 'rice');
  assert.deepEqual(calls.text, ['halal rice'], 'dietary and mood share one targeted search');
  assert.equal(calls.nearby, 1, 'still max 2 Google calls');
  const h1 = nearby.merchants.find(function(m) { return m.id === 'google-h1'; });
  assert.ok(h1.fromDietarySearch && h1.fromMoodSearch, 'retrieval flags only');
  assert.deepEqual(h1.dietary, [], 'the query words are not dietary evidence');
  assert.equal(getDietaryMatchState(h1, 'halal'), MATCH_STATE.UNKNOWN,
    'a mood search can never prove Halal, vegetarian or vegan');

  // An external merchant is never suitable for the restriction: only a registered merchant that
  // listed the option can be. Clear every listing so nothing nearby qualifies.
  getMerchantCampaigns().forEach(function(c) {
    c.dietaryCapabilities = { halal: false, vegetarian: false, vegan: false };
  });
  const demo = createInitialDemo('jia');
  demo.profile.dietaryPreference = 'halal';
  demo.profile.moodCuisine = 'rice';
  demo.profile.maxDistanceMinutes = 30;
  const result = await getSmartRecommendation(demo.profile, nearby.merchants, [], [], demo, []);
  assert.equal(result.merchant, null);
  assert.equal(result.noDeclaredDietary, true);
});

test('MOOD 8b: craving + dietary + mood spends both calls on dietary safety and the raw craving', async function() {
  process.env.GOOGLE_PLACES_API_KEY = 'test-google';
  const calls = mockProviders({ text: {
    'crispy chicken rice': [place('r1', 'Raw Crispy Chicken', 100)],
    'halal crispy chicken': [place('d1', 'Halal Chicken House', 300)]
  } });
  const nearby = await getNearbyMerchants(ORIGIN, 'jia', 'crispy chicken', 30, 'halal', 'rice');
  assert.deepEqual(calls.text, ['crispy chicken rice', 'halal crispy chicken'],
    'combined food intent and dietary breadth both remain available');
  // With an active dietary restriction the third call is the general nearby pool: most certified or
  // Muslim-owned outlets are not labelled halal by the provider, so they must stay researchable.
  // The broad MOOD hint is still dropped - it is only a ranking signal.
  assert.equal(calls.nearby, 1, 'the third call is the general nearby pool, not a mood search');
  assert.ok(nearby.merchants.find(function(m) { return m.id === 'google-r1'; }).fromMoodSearch);
});

// MOOD 9 ---------------------------------------------------------------------------------------
test('MOOD 9: ranking receives factual inputs and retrieval flags without a deterministic mood verdict', function() {
  const demo = createInitialDemo('jia'); demo.profile.moodCuisine = 'noodles';
  const eligible = [{ id: 'a', merchantName: 'Noodle Stall', categoryNames: ['Noodle Restaurant'], cuisineTags: ['noodles'], itemName: null, price: null, distanceMetres: 240, source: 'GOOGLE', placeTypes: ['restaurant'], fromMoodSearch: true }];
  const messages = buildRankingMessagesForTest(demo.profile, eligible, [], demo);
  assert.match(messages[1].content, /Food mood today: Noodles/);
  const summary = JSON.parse(messages[1].content.split('Eligible merchants:\n')[1].split('\n\nOutput:')[0])[0];
  assert.equal(summary.fromMoodSearch, true); assert.equal(summary.matchesCurrentMood, undefined);
  assert.deepEqual(summary.cuisine, ['noodles']);
  assert.match(messages[0].content, /cannot support HIGH fit/); assert.match(messages[0].content, /Never judge dietary suitability yourself/);
  demo.profile.moodCuisine = 'any';
  assert.match(buildRankingMessagesForTest(demo.profile, eligible, [], demo)[1].content, /Food mood today: Anything/);
});

test('MOOD 9b: AI output still cannot override the distance constraint under an active mood', async function() {
  process.env.GOOGLE_PLACES_API_KEY = 'test-google';
  process.env.OPENAI_API_KEY = 'test-openai';
  const calls = mockProviders({
    text: { noodles: [place('far', 'Far Ramen Bar', 900, { primaryType: 'ramen_restaurant' })]
      .concat(generalPlaces(5, 60)) },
    openai: { merchantId: 'google-far', relevance: 'high', budgetFit: 'unknown', reason: 'Ramen fits your mood.' }
  });
  const demo = createInitialDemo('jia');
  demo.profile.moodCuisine = 'noodles';
  demo.profile.maxDistanceMinutes = 5; // 400 m
  const nearby = await getNearbyMerchants(ORIGIN, 'jia', '', 5, 'none', 'noodles');
  const result = await getSmartRecommendation(demo.profile, nearby.merchants, [], [], demo, []);
  assert.ok(!JSON.stringify(calls.openai[0]).includes('google-far'), 'the AI never sees the 900 m merchant');
  assert.notEqual(result.merchant.id, 'google-far');
  assert.ok(result.merchant.distanceMetres <= 400);
});

// MOOD 10 --------------------------------------------------------------------------------------
test('MOOD 10: with no AI key the rules fallback prefers a supported mood match', async function() {
  process.env.GOOGLE_PLACES_API_KEY = 'test-google';
  mockProviders({ text: { noodles: [
    place('plain', 'Plain Eatery', 200),
    place('mood', 'Mee Pok Place', 320, { primaryType: 'ramen_restaurant', types: ['ramen_restaurant', 'restaurant', 'food'] })
  ] }, nearby: generalPlaces(6, 600) });
  const demo = createInitialDemo('jia');
  demo.profile.moodCuisine = 'noodles';
  demo.profile.maxDistanceMinutes = 30;
  const nearby = await getNearbyMerchants(ORIGIN, 'jia', '', 30, 'none', 'noodles');
  const moodMerchant = nearby.merchants.find(function(m) { return m.id === 'google-mood'; });
  assert.equal(getMoodMatchState(moodMerchant, 'noodles'), MATCH_STATE.MATCH,
    'the match comes from the provider category name, not the merchant name');
  const result = await getSmartRecommendation(demo.profile, nearby.merchants, [], [], demo, []);
  assert.equal(result.merchant.id, 'google-mood', 'the mood match wins over a slightly nearer plain eatery');
  assert.match(result.reason, /nearby noodles search; merchant details are limited/);
});

test('MOOD 10b: a mood match never overrides distance or budget constraints', async function() {
  const demo = createInitialDemo('jia');
  demo.profile.moodCuisine = 'noodles';
  demo.profile.budget = 7;
  demo.profile.maxDistanceMinutes = 10;
  // Woodlands Noodle Bar is the mood match ($6.80, 4 min); Spice Lane is farther and over budget.
  const result = await getSmartRecommendation(demo.profile, (await getNearbyMerchants()).merchants.map(function(m) { return { ...m, fromMoodSearch: true }; }),
    [], [], demo, []);
  assert.equal(result.merchant.id, 'woodlands-noodle-bar');

  // A mood match that breaks the budget is still excluded, not promoted.
  demo.profile.moodCuisine = 'rice';
  demo.profile.budget = 6;
  const riceResult = await getSmartRecommendation(demo.profile, (await getNearbyMerchants()).merchants.map(function(m) { return { ...m, fromMoodSearch: true }; }),
    [], [], demo, []);
  assert.equal(riceResult.merchant.id, 'felicia-chicken-rice', '$5.00 chicken rice is inside the budget');
  demo.profile.budget = 4;
  const tightResult = await getSmartRecommendation(demo.profile, (await getNearbyMerchants()).merchants.map(function(m) { return { ...m, fromMoodSearch: true }; }),
    [], [], demo, []);
  assert.equal(tightResult.merchant, null, 'budget still excludes every candidate, mood or not');
});

// MOOD 11 --------------------------------------------------------------------------------------
test('MOOD 11: an incomplete provider category never makes mood an eligibility rule', async function() {
  process.env.GOOGLE_PLACES_API_KEY = 'test-google';
  mockProviders({ text: { pasta: generalPlaces(6) } });
  const demo = createInitialDemo('jia');
  demo.profile.moodCuisine = 'pasta';
  demo.profile.maxDistanceMinutes = 30;
  const nearby = await getNearbyMerchants(ORIGIN, 'jia', '', 30, 'none', 'pasta');
  nearby.merchants.forEach(function(m) {
    assert.equal(getMoodMatchState(m, 'pasta'), MATCH_STATE.UNKNOWN, 'generic "Restaurant" stays unknown');
  });
  const result = await getSmartRecommendation(demo.profile, nearby.merchants, [], [], demo, []);
  assert.ok(result.merchant.fromMoodSearch, 'generic targeted category can support cautious fallback');
  assert.match(result.reason, /merchant details are limited/);
});

test('MOOD 11b: mood evidence comes from facts, never from a merchant name alone', async function() {
  const nameOnly = { merchantName: 'Noodle Heaven', category: 'google.place', categoryNames: ['Restaurant'],
    cuisineTags: [], itemName: null };
  assert.equal(getMoodMatchState(nameOnly, 'noodles'), MATCH_STATE.UNKNOWN);
  const dishEvidence = { merchantName: 'Woodlands Noodle Bar', category: 'noodles', itemName: 'Mushroom Noodles' };
  assert.equal(getMoodMatchState(dishEvidence, 'noodles'), MATCH_STATE.MATCH);
  const biryani = { merchantName: 'Spice Lane', category: 'indian-food', itemName: 'Chicken Biryani' };
  assert.equal(getMoodMatchState(biryani, 'rice'), MATCH_STATE.UNKNOWN, 'semantic equivalence requires AI');
  assert.equal(getMoodMatchState(biryani, 'pasta'), MATCH_STATE.UNKNOWN, 'unconfirmed facts remain unknown');
  const bakery = { merchantName: 'Corner Shop', category: 'google.place', categoryNames: ['Bakery'], cuisineTags: ['bakery'] };
  assert.equal(getMoodMatchState(bakery, 'bread'), MATCH_STATE.UNKNOWN);
});

// MOOD 12 --------------------------------------------------------------------------------------
test('MOOD 12: editing the mood in the refine form re-runs discovery with the new staple', async function() {
  process.env.GOOGLE_PLACES_API_KEY = 'test-google';
  const calls = mockProviders({ nearby: generalPlaces(8), text: { soup: generalPlaces(6, 90) } });
  const v = visitor();
  await v.request('/home');
  assert.equal((await v.request('/smart-match/location', ORIGIN)).status, 204);
  const first = await v.request('/smart-match/result');
  assert.equal(first.status, 200);
  assert.equal(calls.nearby, 1, '"Anything" keeps the generic nearby discovery');
  assert.deepEqual(calls.text, []);
  const saved = await v.request('/profile', { dietaryPreference: 'none', moodCuisine: 'soup',
    craving: '', budget: '10', maxDistanceMinutes: '10' });
  assert.equal(saved.location, '/home?matching=again');
  const second = await v.request('/smart-match/result');
  assert.equal(second.status, 200);
  assert.deepEqual(calls.text, ['soup'], 'the saved mood becomes the discovery term');
  assert.match(second.html, /Mood: Soup/);

  // An invalid mood is rejected by the refine form, leaving the stored mood untouched.
  const rejected = await v.request('/profile', { moodCuisine: 'healthy',
    craving: '', budget: '10', maxDistanceMinutes: '10' });
  assert.equal(rejected.location, '/home?error=invalid');
  assert.match((await v.request('/profile/dietary')).html, /Dietary restrictions/);
});
