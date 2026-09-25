const test = require('node:test');
const assert = require('node:assert/strict');
const { createInitialDemo, getNearbyMerchants, getSmartRecommendation, getDietaryMatchState, MATCH_STATE,
  clearDiscoveryCache, clearMerchantResearchCache, clearSearchIntentCache, resetMerchantCampaigns } = require('../app');
const requestBudget = require('../request-budget');
const researchStore = require('../research-store');

// Dietary matching: dietary-intent discovery, strict outlet-level verification, the shared research
// store (TTLs, de-duplication, shared-cache survival) and the overall request deadline.
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
  researchStore.setSharedClient(null);
});
test.beforeEach(function() {
  resetMerchantCampaigns();
  clearDiscoveryCache();
  clearMerchantResearchCache();
  clearSearchIntentCache();
  researchStore.setSharedClient(null);
  trackedKeys.forEach(function(key) { delete process.env[key]; });
  global.fetch = originalFetch;
});
test.afterEach(function() { global.fetch = originalFetch; });

const ORIGIN = { latitude: 1.4428, longitude: 103.7854 };
const M = 111195;
const RESEARCH_MARKER = 'You verify ONE dietary requirement';

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

// Mocks Google (Nearby + Text by query), Tavily (search/extract) and Groq (research analysis only).
// options.verdict(merchantName) -> 'SUITABLE' | 'UNKNOWN' | ...; options.hangTavily makes Tavily hang.
function mockAll(options) {
  const calls = { nearby: 0, text: [], search: [], extract: 0, groq: 0 };
  global.fetch = async function(url, init) {
    const target = String(url);
    const body = init && init.body ? JSON.parse(init.body) : {};
    if (target.endsWith(':searchNearby')) {
      calls.nearby += 1;
      return { ok: true, json: async function() { return { places: options.nearby || [] }; } };
    }
    if (target.endsWith(':searchText')) {
      calls.text.push(body.textQuery);
      const places = (options.text && options.text[body.textQuery]) || [];
      return { ok: true, json: async function() { return { places: places }; } };
    }
    const host = new URL(target).hostname;
    if (host === 'api.tavily.com') {
      if (options.hangTavily) {
        return new Promise(function(resolve, reject) {
          init.signal.addEventListener('abort', function() { reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); });
        });
      }
      if (target.endsWith('/search')) {
        calls.search.push(body.query);
        if (options.searchDelayMs) await new Promise(function(r) { setTimeout(r, options.searchDelayMs); });
        const title = options.sourceTitle ? options.sourceTitle(body.query) : body.query + ' - MUIS halal certificate';
        return { ok: true, json: async function() {
          return { results: [{ title: title, url: 'https://www.muis.gov.sg/halal/' + encodeURIComponent(body.query.slice(0, 20)),
            content: title }] };
        } };
      }
      calls.extract += 1;
      return { ok: true, json: async function() {
        return { results: body.urls.map(function(u) { return { url: u, raw_content: 'Certified halal outlet. ' + 'Details. '.repeat(40) }; }) };
      } };
    }
    if (host === 'api.groq.com' && String(body.messages[0].content).indexOf(RESEARCH_MARKER) === 0) {
      calls.groq += 1;
      const merchants = JSON.parse(body.messages[1].content.slice(body.messages[1].content.indexOf('[')));
      return { ok: true, json: async function() {
        return { choices: [{ message: { content: JSON.stringify({ results: merchants.map(function(m) {
          const status = options.verdict ? options.verdict(m.name) : 'UNKNOWN';
          const src = m.sources[0];
          return { merchantId: m.merchantId, identified: true, status: status,
            evidence: status === 'UNKNOWN' ? '' : 'Listed as MUIS halal certified.',
            matchingItems: [], sources: [{ title: src.title, url: src.url, sourceType: 'certification' }] };
        }) }) } }] };
      } };
    }
    return { ok: false, status: 404 };
  };
  return calls;
}

function halalDemo(craving) {
  const demo = createInitialDemo('jia');
  demo.profile.dietaryPreference = 'halal';
  demo.profile.craving = craving || '';
  demo.profile.maxDistanceMinutes = 30;
  return demo;
}

async function match(demo, merchants) {
  return getSmartRecommendation(demo.profile, merchants, [], [], demo, []);
}

function researchKeys() {
  process.env.TAVILY_API_KEY = 'test-tavily';
  process.env.GROQ_API_KEY = 'test-groq';
}

// 1 --------------------------------------------------------------------------------------------
test('DIET 1: Halal + no craving searches "halal food" near the user and flags those candidates', async function() {
  process.env.GOOGLE_PLACES_API_KEY = 'test-google';
  const calls = mockAll({ text: { 'halal food': [place('h1', 'Halal Corner', 300), place('h2', 'Nasi Place', 400)] },
    nearby: generalPlaces(10) });
  const nearby = await getNearbyMerchants(ORIGIN, 'jia', '', 30, 'halal');
  assert.deepEqual(calls.text, ['halal food']);
  assert.equal(calls.nearby, 1, 'too few usable -> the one broad Nearby Search is merged in');
  const h1 = nearby.merchants.find(function(m) { return m.id === 'google-h1'; });
  assert.ok(h1.fromDietarySearch, 'retrieval flag only');
  assert.deepEqual(h1.dietary, [], 'a dietary search result is NOT dietary evidence');
  assert.equal(getDietaryMatchState(h1, 'halal'), MATCH_STATE.UNKNOWN);
});

// 2 --------------------------------------------------------------------------------------------
test('DIET 2: Halal + craving keeps the raw craving results first and merges "halal <craving>" results', async function() {
  process.env.GOOGLE_PLACES_API_KEY = 'test-google';
  process.env.GROQ_API_KEY = 'test-groq';
  const calls = mockAll({ text: {
    'bee hoon': [place('r1', 'Raw Bee Hoon', 100), place('shared', 'Shared Stall', 200)],
    'halal bee hoon': [place('shared', 'Shared Stall', 200), place('d1', 'Halal Bee Hoon House', 500)]
  } });
  const nearby = await getNearbyMerchants(ORIGIN, 'jia', 'bee hoon', 30, 'halal');
  assert.deepEqual(calls.text, ['bee hoon', 'halal bee hoon'], 'raw first; max 2 Google calls; no expansion');
  assert.deepEqual(nearby.merchants.map(function(m) { return m.id; }), ['google-r1', 'google-shared', 'google-d1']);
  assert.ok(nearby.merchants.find(function(m) { return m.id === 'google-d1'; }).fromDietarySearch);
  // A craving that already names the diet is not searched twice.
  clearDiscoveryCache();
  const again = mockAll({ text: { 'halal chicken': [place('c1', 'Chicken Place', 100)] } });
  await getNearbyMerchants(ORIGIN, 'jia', 'halal chicken', 30, 'halal');
  assert.deepEqual(again.text, ['halal chicken']);
});

// 3 --------------------------------------------------------------------------------------------
test('DIET 3: a suitable dietary-search candidate beyond the first nine general restaurants is found', async function() {
  process.env.GOOGLE_PLACES_API_KEY = 'test-google';
  researchKeys();
  mockAll({ text: { 'halal food': [place('far', 'Certified Halal Kitchen', 900)] }, nearby: generalPlaces(15),
    verdict: function(name) { return name === 'Certified Halal Kitchen' ? 'SUITABLE' : 'UNKNOWN'; } });
  const demo = halalDemo('');
  const nearby = await getNearbyMerchants(ORIGIN, 'jia', '', 30, 'halal');
  assert.ok(nearby.merchants.length >= 16);
  const result = await match(demo, nearby.merchants);
  assert.equal(result.merchant && result.merchant.id, 'google-far', 'dietary-search candidates are researched first');
});

// 4 --------------------------------------------------------------------------------------------
test('DIET 4: coffee-shop meal merchants reach the classifier; drink-only coffee shops stay excluded', async function() {
  process.env.GOOGLE_PLACES_API_KEY = 'test-google';
  const captured = [];
  global.fetch = async function(url, init) {
    captured.push(JSON.parse(init.body));
    return { ok: true, json: async function() { return { places: [
      place('kopi', 'Ah Seng Noodle Stall', 100, { primaryType: 'coffee_shop', types: ['coffee_shop', 'restaurant', 'food'] }),
      place('drinks', 'Drinks Only', 120, { primaryType: 'coffee_shop', types: ['coffee_shop', 'cafe', 'food'] })
    ] }; } };
  };
  const demo = createInitialDemo('jia');
  const nearby = await getNearbyMerchants(ORIGIN, 'jia', '', 10);
  assert.ok(!captured[0].excludedPrimaryTypes.includes('coffee_shop'));
  const result = await match(demo, nearby.merchants);
  assert.equal(result.merchant.id, 'google-kopi', 'the drink-only shop never becomes the recommendation');
});

// 5 --------------------------------------------------------------------------------------------
function fakeSharedStore() {
  const data = new Map();
  return {
    data: data,
    async mget() { return Array.from(arguments).map(function(k) { return data.has(k) ? data.get(k) : null; }); },
    async set(key, value, opts) {
      if (opts && opts.nx && data.has(key)) return null;
      data.set(key, value);
      return 'OK';
    },
    async del(key) { data.delete(key); return 1; }
  };
}

test('DIET 5: verified evidence survives a process/cache reset through the shared store', async function() {
  researchKeys();
  const shared = fakeSharedStore();
  researchStore.setSharedClient(shared);
  process.env.GOOGLE_PLACES_API_KEY = 'test-google';
  const halalPlace = place('halal1', 'Certified Halal Kitchen', 200, { formattedAddress: '1 Example Road, Singapore 738010' });
  const calls = mockAll({ verdict: function() { return 'SUITABLE'; }, text: { 'halal food': [halalPlace] }, nearby: [] });
  const merchants = async function() {
    return (await getNearbyMerchants(ORIGIN, 'jia', '', 30, 'halal')).merchants;
  };
  const first = await match(halalDemo(''), await merchants());
  assert.equal(first.merchant.id, 'google-halal1');
  assert.equal(calls.search.length, 1);
  const storedKey = Array.from(shared.data.keys()).find(function(k) { return k.indexOf('research-v7:google:halal1:halal') === 0; });
  assert.ok(storedKey, 'key = version:provider:place:restriction');
  const stored = JSON.parse(shared.data.get(storedKey));
  assert.equal(stored.status, 'SUITABLE');
  assert.ok(stored.sources.length && stored.expiresAt > Date.now() && stored.verifiedAt);
  assert.ok(!/jia|craving|budget/i.test(shared.data.get(storedKey)), 'no user data in shared evidence');
  clearMerchantResearchCache(); // simulated new process: memory empty, shared store intact
  const second = await match(halalDemo(''), await merchants());
  assert.equal(second.merchant.id, 'google-halal1');
  assert.equal(calls.search.length, 1, 'no new research after the reset');
  // A failing shared store never breaks matching.
  clearMerchantResearchCache();
  researchStore.setSharedClient({ mget: async function() { throw new Error('down'); }, set: async function() { throw new Error('down'); } });
  const third = await match(halalDemo(''), await merchants());
  assert.equal(third.merchant.id, 'google-halal1', 'researched again with memory only');
});

// 6 --------------------------------------------------------------------------------------------
test('DIET 6: UNKNOWN evidence expires after 6 hours (retried) while verified evidence lasts 7 days', async function() {
  assert.equal(researchStore.UNKNOWN_TTL_MS, 6 * 60 * 60 * 1000);
  assert.equal(researchStore.VERIFIED_TTL_MS, 7 * 24 * 60 * 60 * 1000);
  const now = Date.now();
  const unknown = researchStore.stampVerdict({ restriction: 'halal', status: 'UNKNOWN', researchedAt: now });
  const verified = researchStore.stampVerdict({ restriction: 'halal', status: 'SUITABLE', researchedAt: now });
  assert.equal(unknown.expiresAt - now, 6 * 60 * 60 * 1000);
  assert.equal(verified.expiresAt - now, 7 * 24 * 60 * 60 * 1000);
  researchKeys();
  const calls = mockAll({ verdict: function() { return 'UNKNOWN'; } });
  const merchant = { id: 'google-u1', merchantName: 'Unverified Eats', externalPlaceId: 'u1', providerPlaceId: 'u1',
    source: 'GOOGLE', address: '2 Example Road, Singapore 738011', dietary: [] };
  await require('../app').runDietaryResearchForTest([merchant], 'halal');
  assert.equal(calls.search.length, 1);
  await require('../app').runDietaryResearchForTest([Object.assign({}, merchant, { research: undefined })], 'halal');
  assert.equal(calls.search.length, 1, 'UNKNOWN is cached for now');
  const realNow = Date.now;
  try {
    Date.now = function() { return realNow() + 6 * 60 * 60 * 1000 + 1000; };
    await require('../app').runDietaryResearchForTest([Object.assign({}, merchant, { research: undefined })], 'halal');
  } finally {
    Date.now = realNow;
  }
  assert.equal(calls.search.length, 2, 'retried after 6 hours');
});

// 7 --------------------------------------------------------------------------------------------
test('DIET 7: concurrent requests for the same outlet research it only once', async function() {
  researchKeys();
  const calls = mockAll({ verdict: function() { return 'UNKNOWN'; }, searchDelayMs: 60 });
  const make = function() {
    return [1, 2, 3].map(function(i) {
      return { id: 'google-c' + i, merchantName: 'Concurrent Eats ' + i, externalPlaceId: 'c' + i, providerPlaceId: 'c' + i,
        source: 'GOOGLE', address: i + ' Example Road, Singapore 73801' + i, dietary: [] };
    });
  };
  const run = require('../app').runDietaryResearchForTest;
  await Promise.all([run(make(), 'halal'), run(make(), 'halal'), run(make(), 'halal')]);
  assert.equal(calls.search.length, 3, 'one Tavily search per outlet, not per request');
  assert.equal(calls.groq, 1);
});

// 8 --------------------------------------------------------------------------------------------
test('DIET 8: no usable analysis provider -> zero Tavily calls, provider-unavailable outcome', async function() {
  process.env.TAVILY_API_KEY = 'test-tavily';
  const calls = mockAll({});
  const outcome = await require('../app').runDietaryResearchForTest([{ id: 'google-n1', merchantName: 'No Provider Eats',
    externalPlaceId: 'n1', source: 'GOOGLE', address: 'Singapore 738019', dietary: [] }], 'halal');
  assert.equal(calls.search.length, 0);
  assert.equal(calls.extract, 0);
  assert.equal(outcome.researchUnavailable, true);
});

// 9 / 10 ---------------------------------------------------------------------------------------
test('DIET 9/10: active-Halal matching respects the overall deadline when research hangs', async function() {
  researchKeys();
  mockAll({ hangTavily: true });
  const merchants = [1, 2, 3, 4, 5, 6, 7].map(function(i) {
    return { id: 'google-s' + i, merchantName: 'Slow Eats ' + i, externalPlaceId: 's' + i, source: 'GOOGLE',
      address: 'Singapore 73802' + i, dietary: [] };
  });
  const budget = requestBudget.createBudget(4500);
  const started = Date.now();
  const outcome = await requestBudget.runWithBudget(budget, function() {
    return require('../app').runDietaryResearchForTest(merchants, 'halal');
  });
  budget.finish();
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 4300, 'research stopped before the ranking reserve: ' + elapsed + ' ms');
  assert.equal(outcome.candidates.length, 0, 'nothing unverified is ever returned');
  assert.equal(outcome.verificationIncomplete, true, 'deadline = incomplete, not "none nearby"');
  assert.ok(!outcome.researchUnavailable);
  assert.ok(budget.trace.deadlineHit || budget.trace.providers['tavily-search'].failed > 0);
});

test('DIET 10b: warm path - fresh cached verified evidence answers immediately with no provider calls', async function() {
  researchKeys();
  const calls = mockAll({ verdict: function() { return 'SUITABLE'; } });
  const merchant = { id: 'google-w1', merchantName: 'Warm Halal Eats', externalPlaceId: 'w1', source: 'GOOGLE',
    address: '9 Example Road, Singapore 738099', dietary: [] };
  const run = require('../app').runDietaryResearchForTest;
  await run([Object.assign({}, merchant)], 'halal');
  const started = Date.now();
  const warm = await run([Object.assign({}, merchant)].concat([{ id: 'google-x', merchantName: 'Other', externalPlaceId: 'x',
    source: 'GOOGLE', address: 'Singapore 738000', dietary: [] }]), 'halal');
  assert.ok(Date.now() - started < 200);
  assert.deepEqual(warm.candidates.map(function(m) { return m.id; }), ['google-w1']);
  assert.equal(calls.search.length, 1, 'no research for the other candidate once a verified one is cached');
});

// 12 -------------------------------------------------------------------------------------------
test('DIET 12: evidence about another outlet or a brand prefix can never verify Halal', async function() {
  researchKeys();
  const run = require('../app').runDietaryResearchForTest;
  // A certificate naming the brand but a different branch/postal code.
  mockAll({ verdict: function() { return 'SUITABLE'; },
    sourceTitle: function() { return 'Chicken Rice Co - Bugis Junction (Singapore 188021) MUIS halal certificate'; } });
  const branch = await run([{ id: 'google-b1', merchantName: 'Chicken Rice Co @ Woodlands', externalPlaceId: 'b1',
    source: 'GOOGLE', address: '10 Woodlands Square, Singapore 738099', dietary: [] }], 'halal');
  assert.equal(branch.candidates.length, 0, 'another branch\'s certificate does not verify this outlet');
  // A page naming only a prefix of the merchant name.
  clearMerchantResearchCache();
  mockAll({ verdict: function() { return 'SUITABLE'; },
    sourceTitle: function() { return 'Hup Lee Economic halal certified stall Singapore 738099'; } });
  const prefix = await run([{ id: 'google-p1', merchantName: 'Hup Lee Economic Bee Hoon', externalPlaceId: 'p1',
    source: 'GOOGLE', address: '888 Woodlands Dr, Singapore 738099', dietary: [] }], 'halal');
  assert.equal(prefix.candidates.length, 0, 'a brand-name prefix alone is not outlet identity');
  // The right outlet (full name + its postal code) does verify.
  clearMerchantResearchCache();
  mockAll({ verdict: function() { return 'SUITABLE'; },
    sourceTitle: function() { return 'Chicken Rice Co Woodlands - 10 Woodlands Square Singapore 738099 MUIS halal'; } });
  const right = await run([{ id: 'google-b2', merchantName: 'Chicken Rice Co @ Woodlands', externalPlaceId: 'b2',
    source: 'GOOGLE', address: '10 Woodlands Square, Singapore 738099', dietary: [] }], 'halal');
  assert.equal(right.candidates.length, 1);
});

test('DIET 12b: unverified candidates never satisfy Halal, even when research is unavailable', async function() {
  const calls = mockAll({});
  const outcome = await require('../app').runDietaryResearchForTest([{ id: 'google-z', merchantName: 'Some Eats',
    externalPlaceId: 'z', source: 'GOOGLE', address: 'Singapore 738000', dietary: [], primaryType: 'halal_restaurant' }], 'halal');
  assert.equal(outcome.candidates.length, 0);
  assert.equal(calls.search.length, 0);
});
