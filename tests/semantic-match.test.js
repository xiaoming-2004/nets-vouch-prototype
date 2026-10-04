const test = require('node:test');
const assert = require('node:assert/strict');
const { createInitialDemo, getNearbyMerchants, getSmartRecommendation, clearDiscoveryCache, clearSearchIntentCache,
  resetMerchantCampaigns, getMerchantCampaigns, validateRankingResponseForTest: validate,
  buildRankingMessagesForTest: messages } = require('../app');
const originalFetch = global.fetch;
const keys = ['GOOGLE_PLACES_API_KEY', 'FOURSQUARE_API_KEY', 'GROQ_API_KEY', 'OPENAI_API_KEY', 'PLACES_PROVIDER'];
const env = Object.fromEntries(keys.map(k => [k, process.env[k]]));
test.beforeEach(() => { keys.forEach(k => delete process.env[k]); clearDiscoveryCache(); clearSearchIntentCache(); resetMerchantCampaigns(); });
test.afterEach(() => { global.fetch = originalFetch; });
test.after(() => keys.forEach(k => env[k] === undefined ? delete process.env[k] : process.env[k] = env[k]));
const origin = { latitude: 1.3, longitude: 103.85 };
const profile = (extra = {}) => ({ ...createInitialDemo('jia').profile, ...extra });
const googlePlace = (id, name, type, metres) => ({ id, displayName: { text: name }, primaryType: type,
  types: [type, 'food'], location: { latitude: origin.latitude + metres / 111195, longitude: origin.longitude } });
const fsqPlace = (id, name, category, metres) => ({ fsq_place_id: id, name, categories: [{ name: category }],
  latitude: origin.latitude + metres / 111195, longitude: origin.longitude, distance: metres });
const chat = value => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(value) } }] }) });
const pick = (id, cravingFit, moodFit, overallFit = 'medium', reason = 'Found in the targeted food search; details are limited.') =>
  ({ merchantId: id, cravingFit, moodFit, overallFit, reason });
async function discover(p, provider = 'google', options = {}) {
  process.env.PLACES_PROVIDER = provider;
  process.env[provider === 'google' ? 'GOOGLE_PLACES_API_KEY' : 'FOURSQUARE_API_KEY'] = 'mock';
  const queries = [];
  global.fetch = async (url, init) => {
    const body = init && init.body ? JSON.parse(init.body) : {};
    if (String(url).includes('groq')) return options.intent ? chat(options.intent) : { ok: false, status: 500 };
    const broad = provider === 'google' ? String(url).endsWith(':searchNearby') : new URL(url).searchParams.get('query') === 'food';
    queries.push(broad ? 'nearby' : provider === 'google' ? body.textQuery : new URL(url).searchParams.get('query'));
    const places = broad ? [googlePlace('broad', 'Mala Corner', 'chinese_restaurant', 20)] :
      options.empty ? [] : [googlePlace('target', 'Neutral Eatery', 'restaurant', 500)];
    if (provider === 'google') return { ok: true, json: async () => ({ places }) };
    return { ok: true, json: async () => ({ results: places.map(m => fsqPlace(m.id, m.displayName.text, m.id === 'broad' ? 'Chinese Restaurant' : 'Restaurant', m.id === 'broad' ? 20 : 500)) }) };
  };
  const nearby = await getNearbyMerchants(origin, 'jia', p.craving, p.maxDistanceMinutes, p.dietaryPreference, p.moodCuisine);
  keys.filter(k => /PLACES|FOURSQUARE/.test(k)).forEach(k => delete process.env[k]);
  return { pool: nearby.merchants, queries };
}
async function rank(pool, p, response) {
  process.env.GROQ_API_KEY = 'mock';
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push(JSON.parse(init.body));
    if (response === 'fail') return { ok: false, status: 429, json: async () => ({}) };
    return chat(typeof response === 'function' ? response(calls.at(-1)) : response);
  };
  const demo = createInitialDemo('jia'); demo.profile = p;
  const result = await getSmartRecommendation(p, pool, [], [], demo, []);
  return { result, calls };
}

for (const provider of ['google', 'foursquare']) {
  for (const mood of ['rice', 'noodles', 'pasta', 'soup', 'bread']) {
    test(`${provider}: ${mood} generic targeted result beats unrelated broad result, including AI failure`, async () => {
      const p = profile({ moodCuisine: mood });
      const { pool, queries } = await discover(p, provider);
      const id = provider + '-target';
      assert.equal(queries[0], mood);
      assert.ok(pool.find(m => m.id === id).fromMoodSearch);
      assert.ok(pool.find(m => m.id === provider + '-broad').fromNearbySearch);
      const { result, calls } = await rank(pool, p, pick(id, 'not_applicable', 'medium'));
      assert.equal(result.merchant.id, id, 'generic categories allow a cautious medium match');
      assert.deepEqual(result.aiFits, { cravingFit: 'not_applicable', moodFit: 'medium', overallFit: 'medium' });
      assert.equal(result.selectionSource, 'GROQ');
      assert.ok(calls[0].max_tokens <= 600);
      assert.deepEqual(Object.keys(calls[0].response_format.json_schema.schema.properties).sort(),
        ['merchantId', 'cravingFit', 'moodFit', 'overallFit', 'reason'].sort());
      assert.match(calls[0].messages[0].content, /cautious MEDIUM fit/);
      assert.match(calls[0].messages[0].content, /Broad Nearby membership provides NO food-fit evidence/);
      const fallback = (await rank(pool, p, 'fail')).result;
      assert.equal(fallback.merchant.id, id);
      assert.equal(fallback.selectionSource, 'FALLBACK');
      assert.equal(fallback.aiFits, null);
      assert.match(fallback.reason, /search; merchant details are limited/);
      assert.ok(!fallback.reason.includes('serves'));
      delete process.env.GROQ_API_KEY;
      const demo = createInitialDemo('jia'); demo.profile = p;
      const noKey = await getSmartRecommendation(p, pool, [], [], demo, []);
      assert.equal(noKey.merchant.id, id, 'missing AI key also uses targeted retrieval');
    });
  }
}

for (const craving of ['chicken rice', 'something spicy', 'light breakfast', 'comfort food', 'fried chicken', 'something warm']) {
  test(`arbitrary craving: ${craving} uses raw discovery and supports generic targeted AI/fallback`, async () => {
    const p = profile({ craving });
    const { pool, queries } = await discover(p);
    assert.equal(queries[0], craving);
    assert.equal(pool.find(m => m.id === 'google-target').fromCravingSearch, true);
    assert.equal((await rank(pool, p, pick('google-target', 'medium', 'not_applicable'))).result.merchant.id, 'google-target');
    const fallback = (await rank(pool, p, 'fail')).result;
    assert.equal(fallback.merchant.id, 'google-target');
    assert.ok(fallback.reason.includes(craving));
  });
}

for (const [label, cravingFit, moodFit] of [['both', 'high', 'high'], ['craving only', 'high', 'low'], ['mood only', 'low', 'medium'], ['neither', 'low', 'low']]) {
  test(`combined inputs: ${label} fit`, async () => {
    const p = profile({ craving: 'chicken', moodCuisine: 'bread' });
    process.env.GROQ_API_KEY = 'mock';
    const { pool, queries } = await discover(p, 'google', { intent: { searchQuery: 'chicken sandwich', concepts: [] } });
    assert.equal(queries[0], 'chicken sandwich');
    assert.equal(pool.find(m => m.id === 'google-target').fromMoodSearch, true);
    assert.equal(pool.find(m => m.id === 'google-target').fromCravingSearch, true);
    const response = pick(label === 'neither' ? null : 'google-target', cravingFit, moodFit, label === 'neither' ? 'low' : 'medium',
      label === 'neither' ? 'All targeted candidates have conflicting food facts.' : 'The supplied food category is a plausible match.');
    const { result, calls } = await rank(pool, p, response);
    assert.match(calls[0].messages[1].content, /Specific craving: chicken/);
    assert.match(calls[0].messages[1].content, /Food mood today: Bread/);
    assert.match(calls[0].messages[0].content, /prefer fitting BOTH/);
    if (label === 'neither') { assert.equal(result.merchant, null); assert.equal(calls.length, 1, 'valid no-match never triggers fallback'); }
    else {
      assert.equal(result.merchant.id, 'google-target');
      if (cravingFit === 'low') assert.match(result.reason, /Your craving could not be confirmed/);
      if (moodFit === 'low') assert.match(result.reason, /Your mood could not be confirmed/);
    }
  });
}

test('AI semantic stub chooses both-input fit ahead of nearer partial or unrelated candidates', async () => {
  const p = profile({ craving: 'chicken', moodCuisine: 'bread' });
  const { pool } = await discover(p);
  pool[0].merchantName = 'Chicken Sandwich Shop'; pool[0].categoryNames = ['Sandwich Shop'];
  pool.push({ ...pool[0], id: 'google-partial', merchantName: 'Chicken Restaurant', categoryNames: ['Chicken Restaurant'], distanceMetres: 100 });
  const { result } = await rank(pool, p, body => {
    const listed = JSON.parse(body.messages[1].content.split('Eligible merchants:\n')[1].split('\n\nOutput:')[0]);
    const strongest = listed.find(m => m.name === 'Chicken Sandwich Shop');
    return pick(strongest.id, 'high', 'high', 'high', 'Chicken Sandwich Shop has a Sandwich Shop category fitting both inputs.');
  });
  assert.equal(result.merchant.id, 'google-target');
});

test('No targeted results: AI failure cannot choose unrelated broad Nearby', async () => {
  const p = profile({ moodCuisine: 'bread' }); const { pool } = await discover(p, 'google', { empty: true });
  assert.equal(pool.some(m => m.fromMoodSearch || m.fromCravingSearch), false);
  assert.equal((await rank(pool, p, 'fail')).result.merchant, null);
});

test('Both-input fallback can use one targeted input and discloses the other', async () => {
  const p = profile({ craving: 'chicken', moodCuisine: 'bread' }); const { pool } = await discover(p);
  pool[0].fromMoodSearch = false;
  const result = (await rank(pool, p, 'fail')).result;
  assert.equal(result.merchant.id, 'google-target');
  assert.match(result.reason, /Your mood could not be confirmed/);
});

test('Expanded and broad provenance remains distinct; duplicates retain original direct context', async () => {
  const p = profile({ craving: 'comfort food' }); process.env.GROQ_API_KEY = 'mock';
  process.env.GOOGLE_PLACES_API_KEY = 'mock';
  global.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (String(url).includes('groq')) return chat({ searchQuery: 'comfort food warm meal', concepts: [] });
    return { ok: true, json: async () => ({ places: body.textQuery === p.craving ? [googlePlace('original', 'Original', 'restaurant', 200)] :
      [googlePlace('original', 'Original', 'restaurant', 200), googlePlace('expanded', 'Expanded', 'restaurant', 100)] }) };
  };
  const { merchants } = await getNearbyMerchants(origin, 'jia', p.craving, 10, 'none', 'any');
  const original = merchants.find(m => m.id === 'google-original'); const expanded = merchants.find(m => m.id === 'google-expanded');
  assert.equal(original.fromCravingSearch, true); assert.equal(original.fromExpandedSearch, true);
  assert.equal(expanded.fromExpandedSearch, true); assert.ok(!expanded.fromCravingSearch);
  assert.equal((await rank(merchants, p, 'fail')).result.merchant.id, original.id, 'fallback prefers exact search, not nearer expansion');
});

test('Anything without craving retains ordinary nearby AI ranking and fallback', async () => {
  const p = profile(); const { pool } = await discover(p);
  const { result } = await rank(pool, p, pick('google-broad', 'not_applicable', 'not_applicable', 'high', 'Mala Corner is the nearest eligible restaurant.'));
  assert.equal(result.merchant.id, 'google-broad');
  assert.equal((await rank(pool, p, 'fail')).result.merchant.id, 'google-broad');
});

test('Compact validation rejects invalid IDs, fits, absent-input fits, low picks, constraints and invented facts', async () => {
  const p = profile({ moodCuisine: 'rice' }); const { pool } = await discover(p);
  const response = pick('google-target', 'not_applicable', 'medium');
  for (const override of [{ merchantId: 'invented' }, { moodFit: 'great' }, { cravingFit: 'high' },
    { moodFit: 'low' }, { overallFit: 'low' }, { evidence: [] }]) {
    assert.throws(() => validate(JSON.stringify({ ...response, ...override }), pool, p), JSON.stringify(override));
  }
  const target = pool.find(m => m.id === response.merchantId);
  assert.throws(() => validate(JSON.stringify(response), pool.map(m => m.id === target.id ? { ...m, distanceMetres: 9999 } : m), p));
  assert.throws(() => validate(JSON.stringify(response), pool.map(m => m.id === target.id ? { ...m, price: 99 } : m), p));
  assert.throws(() => validate(JSON.stringify(response), pool, { ...p, dietaryPreference: 'halal' }));
  assert.equal(validate(JSON.stringify(response), pool, p).moodFit, 'medium', 'no exact evidence arrays needed');
});

for (const diet of ['halal', 'vegetarian', 'vegan']) {
  test(`${diet} declarations gate candidates before AI and targeted fallback`, async () => {
    const p = profile({ moodCuisine: 'rice', dietaryPreference: diet }); const { pool } = await discover(p);
    getMerchantCampaigns().find(c => c.merchantId === 'google-target').dietaryCapabilities = { [diet]: true };
    const { result, calls } = await rank(pool, p, pick('google-target', 'not_applicable', 'medium'));
    assert.equal(result.merchant.id, 'google-target');
    const listed = JSON.parse(calls[0].messages[1].content.split('Eligible merchants:\n')[1].split('\n\nOutput:')[0]);
    assert.deepEqual(listed.map(m => m.id), ['google-target']);
    assert.equal((await rank(pool, p, 'fail')).result.merchant.id, 'google-target');
    getMerchantCampaigns().find(c => c.merchantId === 'google-target').dietaryCapabilities = {};
    const gated = await rank(pool, p, 'fail'); assert.equal(gated.result.merchant, null); assert.equal(gated.calls.length, 0);
  });
}


test('Unsupported AI sentences are discarded; direct retrieval can retain a capped medium selection', async () => {
  const p = profile({ moodCuisine: 'rice' }); const { pool } = await discover(p);
  for (const reason of ['It serves dragon toast.', 'It is rated five stars.', 'A meal costs $2.50.', 'A five-minute walk away.']) {
    const response = pick('google-target', 'not_applicable', 'high', 'high', reason);
    const validated = validate(JSON.stringify(response), pool, p);
    assert.equal(validated.merchantId, 'google-target');
    assert.equal(validated.moodFit, 'medium'); assert.equal(validated.overallFit, 'medium');
    assert.ok(!validated.reason.includes(reason)); assert.match(validated.reason, /merchant details are limited/);
    assert.throws(() => validate(JSON.stringify({ ...response, merchantId: 'google-broad' }), pool, p), 'no safe targeted context for a broad-only claim');
  }
  const ranked = await rank(pool, p, pick('google-target', 'not_applicable', 'high', 'high', 'It serves dragon toast.'));
  assert.equal(ranked.result.selectionSource, 'GROQ'); assert.equal(ranked.calls.length, 1);
  assert.ok(!ranked.result.reason.includes('dragon toast'));
});
