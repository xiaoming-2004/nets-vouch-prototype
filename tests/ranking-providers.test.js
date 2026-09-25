const test = require('node:test');
const assert = require('node:assert/strict');
const { app, createInitialDemo, getNearbyMerchants, getSmartRecommendation, clearDiscoveryCache,
  clearMerchantResearchCache, resetMerchantCampaigns, safeAIReason, getMatchReasons } = require('../app');

// Final Smart Match ranking: Groq primary -> OpenAI fallback -> deterministic rules. Candidates are
// prepared by mocked Google discovery (so they are real normalised, campaign-registered merchants);
// ranking itself must never reach discovery, Tavily or any other host.
const originalFetch = global.fetch;
const trackedKeys = ['GOOGLE_PLACES_API_KEY', 'FOURSQUARE_API_KEY', 'PLACES_PROVIDER', 'OPENAI_API_KEY',
  'TAVILY_API_KEY', 'GROQ_API_KEY', 'GROQ_RANKING_MODEL', 'OPENAI_RANKING_MODEL'];
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
  trackedKeys.forEach(function(key) { delete process.env[key]; });
  global.fetch = originalFetch;
});
test.afterEach(function() { global.fetch = originalFetch; });

const ORIGIN = { latitude: 1.3000, longitude: 103.8556 };
const METRES_PER_DEGREE_LAT = 111195;

function googlePlace(id, name, primaryType, metres, extraTypes) {
  return {
    id: id, displayName: { text: name }, primaryType: primaryType,
    types: [primaryType].concat(extraTypes || []).concat(['restaurant', 'food', 'point_of_interest', 'establishment']),
    formattedAddress: '200 Victoria St, Singapore 188021',
    location: { latitude: ORIGIN.latitude + metres / METRES_PER_DEGREE_LAT, longitude: ORIGIN.longitude }
  };
}

const chickenPlaces = [
  googlePlace('leaf', 'Food Leaf', 'restaurant', 90),
  googlePlace('cafe', 'Corner Cafe', 'cafe', 150),
  googlePlace('chix', 'Chix Hot Chicken', 'chicken_restaurant', 320, ['fast_food_restaurant'])
];

// Real normalised merchants from mocked Google discovery; the Google key is removed afterwards.
async function discover(places, craving) {
  process.env.GOOGLE_PLACES_API_KEY = 'test-google';
  global.fetch = async function() {
    return { ok: true, status: 200, json: async function() { return { places: places }; } };
  };
  const nearby = await getNearbyMerchants(ORIGIN, 'jia', craving || '', 10);
  delete process.env.GOOGLE_PLACES_API_KEY;
  assert.equal(nearby.source, 'google');
  return nearby.merchants;
}

function chatReply(content) {
  return { ok: true, status: 200, json: async function() { return { choices: [{ message: { content: content } }] }; } };
}

// replies: { groq, openai } each a ranking object, a raw string, a function(prompt, body), or
// { status } for an HTTP failure. Every other host is counted as an illegal ranking-time call.
function mockRankers(replies) {
  const calls = { groq: [], openai: [], other: [] };
  const answer = function(reply, body) {
    const prompt = body.messages.map(function(m) { return m.content; }).join('\n');
    const value = typeof reply === 'function' ? reply(prompt, body) : reply;
    if (value && value.status) return { ok: false, status: value.status };
    return chatReply(typeof value === 'string' ? value : JSON.stringify(value));
  };
  global.fetch = async function(url, init) {
    const host = new URL(String(url)).hostname;
    const body = init && init.body ? JSON.parse(init.body) : {};
    if (host === 'api.groq.com') { calls.groq.push(body); return answer(replies.groq || { status: 500 }, body); }
    if (host === 'api.openai.com') { calls.openai.push(body); return answer(replies.openai || { status: 500 }, body); }
    calls.other.push(host);
    return { ok: false, status: 404 };
  };
  return calls;
}

function promptOf(body) { return body.messages.map(function(m) { return m.content; }).join('\n'); }
function promptIds(body) {
  return (promptOf(body).match(/"id":"([^"]+)"/g) || []).map(function(entry) { return entry.slice(6, -1); });
}

function profileFor(craving, extra) {
  const demo = createInitialDemo('jia');
  demo.profile.craving = craving || '';
  Object.assign(demo.profile, extra || {});
  return demo;
}

async function rank(merchants, craving, extra) {
  const demo = profileFor(craving, extra);
  return getSmartRecommendation(demo.profile, merchants, [], [], demo, []);
}

const chixPick = { merchantId: 'google-chix', relevance: 'high', budgetFit: 'unknown',
  reason: 'Its Chicken Restaurant category fits your spicy crispy chicken craving.' };

test('RANK A/I: Groq succeeds -> Groq recommendation used, OpenAI never called, no other hosts', async function() {
  const merchants = await discover(chickenPlaces, 'spicy crispy chicken');
  process.env.GROQ_API_KEY = 'test-groq';
  process.env.OPENAI_API_KEY = 'test-openai';
  const calls = mockRankers({ groq: chixPick, openai: chixPick });
  const result = await rank(merchants, 'spicy crispy chicken');
  assert.equal(result.merchant.id, 'google-chix');
  assert.equal(result.reason, chixPick.reason);
  assert.equal(calls.groq.length, 1);
  assert.equal(calls.openai.length, 0, 'OpenAI is never called when Groq returns a valid ranking');
  assert.deepEqual(calls.other, [], 'ranking makes no discovery, Tavily or other calls');
  assert.equal(calls.groq[0].model, 'openai/gpt-oss-20b');
  assert.deepEqual(calls.groq[0].response_format, { type: 'json_object' });
});

test('RANK I2: GROQ_RANKING_MODEL overrides the Groq ranking model', async function() {
  const merchants = await discover(chickenPlaces);
  process.env.GROQ_API_KEY = 'test-groq';
  process.env.GROQ_RANKING_MODEL = 'custom-groq-model';
  const calls = mockRankers({ groq: chixPick });
  await rank(merchants, 'spicy crispy chicken');
  assert.equal(calls.groq[0].model, 'custom-groq-model');
});

test('RANK B: no Groq key -> OpenAI ranks the candidates', async function() {
  const merchants = await discover(chickenPlaces);
  process.env.OPENAI_API_KEY = 'test-openai';
  const calls = mockRankers({ groq: chixPick, openai: chixPick });
  const result = await rank(merchants, 'spicy crispy chicken');
  assert.equal(result.merchant.id, 'google-chix');
  assert.equal(calls.groq.length, 0);
  assert.equal(calls.openai.length, 1);
  assert.equal(calls.openai[0].model, 'gpt-4o-mini');
});

for (const scenario of [
  { name: 'C: Groq HTTP failure', groq: { status: 500 } },
  { name: 'D: Groq 429 (no Groq retry)', groq: { status: 429 } },
  { name: 'E: Groq malformed JSON', groq: 'I think Chix is best!' },
  { name: 'F/O: Groq invents a merchant outside the candidate list', groq: Object.assign({}, chixPick, { merchantId: 'google-invented' }) },
  { name: 'F2: Groq returns an invalid relevance', groq: Object.assign({}, chixPick, { relevance: 'certain' }) },
  { name: 'F3: Groq returns an HTML reason', groq: Object.assign({}, chixPick, { reason: '<b>Great</b> pick' }) }
]) {
  test('RANK ' + scenario.name + ' -> OpenAI fallback over the same candidates', async function() {
    const merchants = await discover(chickenPlaces);
    process.env.GROQ_API_KEY = 'test-groq';
    process.env.OPENAI_API_KEY = 'test-openai';
    const calls = mockRankers({ groq: scenario.groq, openai: chixPick });
    const result = await rank(merchants, 'spicy crispy chicken');
    assert.equal(calls.groq.length, 1, 'Groq is tried exactly once - never retried');
    assert.equal(calls.openai.length, 1);
    assert.deepEqual(promptIds(calls.openai[0]), promptIds(calls.groq[0]), 'same candidate list');
    assert.equal(result.merchant.id, 'google-chix');
    assert.equal(result.reason, chixPick.reason);
  });
}

test('RANK G: both providers fail -> deterministic fallback, same as having no AI', async function() {
  const merchants = await discover(chickenPlaces);
  const rules = await rank(merchants, 'spicy crispy chicken');
  process.env.GROQ_API_KEY = 'test-groq';
  process.env.OPENAI_API_KEY = 'test-openai';
  const calls = mockRankers({ groq: { status: 429 }, openai: 'not json' });
  const result = await rank(merchants, 'spicy crispy chicken');
  assert.equal(calls.groq.length, 1);
  assert.equal(calls.openai.length, 1);
  assert.equal(result.merchant.id, rules.merchant.id);
  assert.equal(result.reason, null);
});

test('RANK O2: Groq-only invented merchant is rejected -> deterministic fallback, never the invented ID', async function() {
  const merchants = await discover(chickenPlaces);
  process.env.GROQ_API_KEY = 'test-groq';
  mockRankers({ groq: Object.assign({}, chixPick, { merchantId: 'google-invented' }) });
  const result = await rank(merchants, 'spicy crispy chicken');
  assert.ok(merchants.some(function(m) { return m.id === result.merchant.id; }));
  assert.notEqual(result.merchant.id, 'google-invented');
  assert.equal(result.reason, null);
});

test('RANK H: no AI keys -> deterministic fallback with no network calls', async function() {
  const merchants = await discover(chickenPlaces);
  const calls = mockRankers({});
  const result = await rank(merchants, 'spicy crispy chicken');
  assert.ok(result.merchant);
  assert.equal(result.reason, null);
  assert.equal(calls.groq.length + calls.openai.length + calls.other.length, 0);
});

test('RANK J: a semantic craving match can beat a nearer weak match inside the hard distance limit', async function() {
  const merchants = await discover(chickenPlaces, 'spicy crispy chicken');
  process.env.GROQ_API_KEY = 'test-groq';
  // The mock "understands" the craving only from the supplied factual categories.
  const calls = mockRankers({ groq: function(prompt) {
    const listed = JSON.parse(prompt.slice(prompt.indexOf('Eligible merchants:\n') + 20, prompt.indexOf('\n\nOutput:')));
    const fit = listed.find(function(m) { return m.categories.some(function(c) { return /chicken/i.test(c); }); });
    return { merchantId: fit.id, relevance: 'high', budgetFit: 'unknown',
      reason: 'Its Chicken Restaurant category fits your spicy crispy chicken craving.' };
  } });
  const result = await rank(merchants, 'spicy crispy chicken');
  const nearest = merchants.slice().sort(function(a, b) { return a.distanceMetres - b.distanceMetres; })[0];
  assert.equal(nearest.id, 'google-leaf');
  assert.equal(result.merchant.id, 'google-chix', 'the 320 m chicken merchant beats the 90 m generic one');
  assert.ok(promptIds(calls.groq[0]).includes('google-leaf'), 'the nearer generic restaurant is still a candidate');
  assert.ok(!promptIds(calls.groq[0]).includes('google-cafe'), 'a cafe primary type never reaches the ranker');
});

test('RANK K: an arbitrary craving reaches the ranker verbatim - no dictionary', async function() {
  const merchants = await discover(chickenPlaces);
  process.env.GROQ_API_KEY = 'test-groq';
  const calls = mockRankers({ groq: { merchantId: 'google-leaf', relevance: 'medium', budgetFit: 'unknown',
    reason: 'Food Leaf is the nearest restaurant, 90 m away.' } });
  await rank(merchants, 'something soupy and comforting');
  assert.match(promptOf(calls.groq[0]), /- Specific craving: something soupy and comforting\n/);
});

test('RANK L: the ranker receives factual price context; unknown stays unknown; over-budget facts stay excluded', async function() {
  // Curated demo merchants carry factual item prices; clone three with controlled prices.
  const demoMerchants = (await getNearbyMerchants()).merchants;
  const byId = function(id) { return Object.assign({}, demoMerchants.find(function(m) { return m.id === id; })); };
  const within = Object.assign(byId('felicia-chicken-rice'), { itemName: 'Spicy Chicken Rice', price: 8.9 });
  const over = Object.assign(byId('woodlands-noodle-bar'), { itemName: 'Chicken Noodle Soup', price: 15 });
  const unknown = Object.assign(byId('green-bowl'), { itemName: null, price: null });
  process.env.GROQ_API_KEY = 'test-groq';
  const calls = mockRankers({ groq: { merchantId: 'green-bowl', relevance: 'medium', budgetFit: 'within',
    reason: 'Green Bowl is cheap and within your budget.' } });
  const result = await rank([within, over, unknown], 'spicy chicken', { budget: 10 });
  const listed = JSON.parse(promptOf(calls.groq[0]).split('Eligible merchants:\n')[1].split('\n\nOutput:')[0]);
  assert.equal(listed.find(function(m) { return m.id === 'felicia-chicken-rice'; }).price, '$8.90');
  assert.equal(listed.find(function(m) { return m.id === 'green-bowl'; }).price, 'unknown');
  assert.ok(!listed.some(function(m) { return m.id === 'woodlands-noodle-bar'; }),
    'a factual $15 price over the $10 budget is excluded by the existing hard budget rule');
  assert.match(promptOf(calls.groq[0]), /- Budget: \$10/);
  assert.equal(result.merchant.id, 'green-bowl');
  assert.equal(result.budgetFit, 'unknown', 'no fabricated budget fit without a real price');
  assert.equal(result.reason, null, 'an affordability claim without a price is dropped');
});

test('RANK M: a merchant beyond the hard distance limit never reaches the AI', async function() {
  const merchants = await discover(chickenPlaces.concat([googlePlace('far', 'Far Chicken', 'chicken_restaurant', 1500)]),
    'spicy crispy chicken');
  assert.ok(merchants.some(function(m) { return m.id === 'google-far'; }), 'discovery keeps the raw pool');
  process.env.GROQ_API_KEY = 'test-groq';
  const calls = mockRankers({ groq: Object.assign({}, chixPick, { merchantId: 'google-far' }) });
  const result = await rank(merchants, 'spicy crispy chicken', { maxDistanceMinutes: 10 });
  assert.ok(!promptIds(calls.groq[0]).includes('google-far'));
  assert.notEqual(result.merchant.id, 'google-far', 'the AI cannot pick it even by naming it');
});

test('RANK N: an unverified merchant under a dietary restriction never reaches the ranker', async function() {
  const merchants = await discover(chickenPlaces.concat([googlePlace('halal', 'InstaChef', 'halal_restaurant', 60)]));
  process.env.GROQ_API_KEY = 'test-groq';
  const calls = mockRankers({ groq: Object.assign({}, chixPick, { merchantId: 'google-halal' }) });
  const result = await rank(merchants, '', { dietaryPreference: 'halal' });
  assert.equal(result.merchant, null, 'no research evidence -> nothing is recommended as halal');
  assert.equal(calls.groq.length, 0, 'the ranker is never asked');
});

test('RANK P: an unsupported "highest rated" claim is dropped for the server-generated reasons', async function() {
  const merchants = await discover(chickenPlaces);
  process.env.GROQ_API_KEY = 'test-groq';
  mockRankers({ groq: Object.assign({}, chixPick, { reason: 'The highest rated chicken spot nearby.' }) });
  const result = await rank(merchants, 'spicy crispy chicken');
  assert.equal(result.merchant.id, 'google-chix', 'the valid pick is kept');
  assert.equal(result.reason, null, 'the card falls back to server-generated "Why this match" reasons');
  for (const claim of ['A best seller in Bugis.', 'A must-try chicken stall.', 'Very popular with students.']) {
    mockRankers({ groq: Object.assign({}, chixPick, { reason: claim }) });
    assert.equal((await rank(merchants, 'spicy crispy chicken')).reason, null, claim);
  }
});

test('RANK Q/R: the prompt has no busyness data and no merchant-identity bonus', async function() {
  const merchants = await discover(chickenPlaces);
  process.env.GROQ_API_KEY = 'test-groq';
  const calls = mockRankers({ groq: chixPick });
  await rank(merchants, 'spicy crispy chicken');
  const prompt = promptOf(calls.groq[0]);
  assert.ok(!/busy|busyness|quiet|txPerHour|velocity|transactions\/hour|queue|crowd/i.test(prompt));
  assert.ok(!/felicia|bonus|preferred merchant|sponsored/i.test(prompt));
});

test('RANK R2: rules fallback ignores merchant identity - identical facts, nearer wins in any order', async function() {
  const merchants = await discover([
    googlePlace('a', "Felicia's Chicken Rice", 'chicken_restaurant', 300),
    googlePlace('b', 'Neutral Chicken', 'chicken_restaurant', 200)
  ]);
  for (const pool of [merchants, merchants.slice().reverse()]) {
    assert.equal((await rank(pool, '')).merchant.id, 'google-b');
  }
});

test('RANK cap: at most 12 candidates are sent to the ranker', async function() {
  const places = [];
  for (let i = 0; i < 18; i++) places.push(googlePlace('p' + i, 'Place ' + i, 'restaurant', 30 + i * 20));
  const merchants = await discover(places);
  process.env.GROQ_API_KEY = 'test-groq';
  const calls = mockRankers({ groq: { merchantId: 'google-p0', relevance: 'medium', budgetFit: 'unknown',
    reason: 'Place 0 is the nearest restaurant.' } });
  await rank(merchants, '');
  assert.equal(promptIds(calls.groq[0]).length, 12);
  assert.ok(promptIds(calls.groq[0]).includes('google-p0'), 'no-craving shortlist keeps the nearest');
});

// --- Reason wording: safe factual reasons survive, unsupported claims are dropped -----------------

function reasonMerchant(extra) {
  return Object.assign({ id: 'google-popeyes', merchantName: 'Popeyes Woodlands Exchange', price: null, itemName: null,
    source: 'GOOGLE', dietary: [], research: {}, cuisineTags: [], category: 'google.place',
    categoryNames: ['Fast Food Restaurant', 'Chicken Restaurant'], distanceMetres: 685, distanceMinutes: 9 }, extra || {});
}
function reasonProfile(extra) {
  return Object.assign({ craving: 'spicy chicken', dietaryPreference: 'none', moodCuisine: 'any', budget: 10,
    maxDistanceMinutes: 10 }, extra || {});
}
function checkReason(reason, merchant, profile) {
  return safeAIReason({ relevance: 'high', reason: reason }, merchant || reasonMerchant(), profile || reasonProfile());
}
const researchedBurger = { vegan: { identified: true, status: 'UNKNOWN', evidence: '',
  matchingItems: [{ name: 'Spicy Chicken Burger', price: 8.9 }] } };
const verifiedVegetarian = { vegetarian: { identified: true, status: 'SUITABLE', evidence: 'Vegetarian menu section.',
  matchingItems: [{ name: 'Veggie Wrap', price: null }] } };

test('REASON A: a safe craving + walking-range reason is preserved', function() {
  const reason = 'Strong match for your spicy chicken craving and still within your walking range.';
  assert.equal(checkReason(reason), reason);
});

test('REASON B/C: popularity and rating claims are dropped', function() {
  assert.equal(checkReason('Very popular for spicy chicken.'), null);
  assert.equal(checkReason('Highest-rated nearby option.'), null);
});

test('REASON D: a supplied factual distance is allowed', function() {
  const reason = 'Matches your craving and is 685 m away.';
  assert.equal(checkReason(reason), reason);
});

test('REASON E: a researched menu item may be cited', function() {
  const reason = 'Offers a researched Spicy Chicken Burger that matches your craving.';
  assert.equal(checkReason(reason, reasonMerchant({ research: researchedBurger })), reason);
});

test('REASON F: an unsupplied "famous" menu claim is dropped', function() {
  assert.equal(checkReason('Their famous spicy chicken burger is perfect for you.'), null);
  assert.equal(checkReason('Known for its spicy chicken dishes.'), null);
});

test('REASON G/H: a dietary reason survives only with verified suitability', function() {
  const reason = 'Verified for your vegetarian preference and still within your walking range.';
  const profile = reasonProfile({ dietaryPreference: 'vegetarian' });
  assert.equal(checkReason(reason, reasonMerchant({ research: verifiedVegetarian }), profile), reason);
  assert.equal(checkReason(reason, reasonMerchant(), profile), null, 'no dietary evidence -> dropped');
});

test('REASON I/J: a dropped reason keeps the AI merchant choice and provider behaviour', async function() {
  const merchants = await discover(chickenPlaces, 'spicy crispy chicken');
  process.env.GROQ_API_KEY = 'test-groq';
  process.env.OPENAI_API_KEY = 'test-openai';
  const calls = mockRankers({ groq: Object.assign({}, chixPick, { reason: 'Very popular for spicy chicken.' }),
    openai: Object.assign({}, chixPick, { merchantId: 'google-leaf' }) });
  const result = await rank(merchants, 'spicy crispy chicken');
  assert.equal(result.merchant.id, 'google-chix', 'Groq selection kept');
  assert.equal(result.reason, null);
  assert.equal(result.relevance, 'high');
  assert.equal(calls.groq.length, 1);
  assert.equal(calls.openai.length, 0, 'an unsafe reason alone never triggers the OpenAI fallback');
});

test('SERVER REASONS: useful factual fallback lines, never fabricated', function() {
  const within = reasonMerchant();
  assert.deepEqual(getMatchReasons(reasonProfile(), within, [], 'high'),
    ['Matches your current craving', 'Within your walking range']);
  assert.deepEqual(getMatchReasons(reasonProfile(), within, [], 'medium'),
    ['A likely fit for your craving', 'Within your walking range']);
  assert.deepEqual(getMatchReasons(reasonProfile(), within, [], 'low'), ['Within your walking range'],
    'a low-relevance pick never claims to match the craving');
  assert.deepEqual(getMatchReasons(reasonProfile(), within, [], null), ['Within your walking range'],
    'rules fallback claims craving fit only from literal words');
  assert.deepEqual(getMatchReasons(reasonProfile({ craving: 'chicken' }), within, [], null),
    ['Matches your current craving', 'Within your walking range']);
  assert.deepEqual(getMatchReasons(reasonProfile({ craving: '', dietaryPreference: 'vegetarian' }),
    reasonMerchant({ research: verifiedVegetarian }), [], null),
  ['Verified for your dietary preference', 'Within your walking range']);
  assert.deepEqual(getMatchReasons(reasonProfile({ craving: '' }), reasonMerchant({ research: researchedBurger }), [], null),
    ['A researched menu option fits your budget', 'Within your walking range']);
  assert.deepEqual(getMatchReasons(reasonProfile({ craving: '', budget: 5 }), reasonMerchant({ research: researchedBurger }), [], null),
    ['Within your walking range'], 'an $8.90 item never counts as fitting a $5 budget');
  assert.deepEqual(getMatchReasons(reasonProfile({ craving: '', maxDistanceMinutes: 5 }), within, [], null),
    ['Best available match from the eligible nearby options']);
});

test('SERVER REASONS end-to-end: a dropped AI reason is never shown; the card renders the valid pick', async function() {
  const server = await new Promise(function(resolve) {
    const instance = app.listen(0, '127.0.0.1', function() { resolve(instance); });
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    process.env.GOOGLE_PLACES_API_KEY = 'test-google';
    process.env.GROQ_API_KEY = 'test-groq';
    global.fetch = async function(url, init) {
      const host = new URL(String(url)).hostname;
      if (host === '127.0.0.1') return originalFetch(url, init);
      if (host === 'places.googleapis.com') {
        return { ok: true, status: 200, json: async function() { return { places: chickenPlaces }; } };
      }
      if (host === 'api.groq.com') {
        return chatReply(JSON.stringify(Object.assign({}, chixPick, { reason: 'Famous for the best spicy chicken.' })));
      }
      return { ok: false, status: 404 };
    };
    let cookie = '';
    const request = async function(path, body) {
      const response = await originalFetch(base + path, { method: body ? 'POST' : 'GET', redirect: 'manual',
        headers: Object.assign({ Cookie: cookie }, body ? { 'Content-Type': 'application/json' } : {}),
        body: body ? JSON.stringify(body) : undefined });
      const header = response.headers.get('set-cookie');
      if (header) cookie = header.split(';')[0];
      return response.text();
    };
    await request('/home');
    await request('/profile', { dietaryPreference: 'none', budget: '10', maxDistanceMinutes: '10', craving: 'spicy crispy chicken' });
    await request('/smart-match/location', ORIGIN);
    const html = await request('/smart-match/result');
    assert.match(html, /data-merchant-id="google-chix"/);
    assert.ok(!/Why this match/.test(html), 'the result card has no reason section');
    assert.ok(!/Famous|best spicy/.test(html));
    assert.ok(!html.includes('AI Matched'), 'no AI badge without a safe AI reason');
  } finally {
    server.close();
  }
});

// --- Travel time: the user's max-walking preference is a limit, never a claimed travel time ------

const fourFingers = reasonMerchant({ id: 'google-4fingers', merchantName: '4Fingers Crispy Chicken',
  distanceMetres: 733, distanceMinutes: 9 });

test('WALK A/D: a walking duration is dropped when no travel time was supplied', function() {
  for (const reason of [
    '4Fingers Crispy Chicken directly matches your spicy chicken craving and is within a 10‑minute walk.',
    'Matches your spicy chicken craving within a 10-minute walk.',
    'Matches your craving and is 5 minutes away.',
    'Matches your craving, just a few minutes\' walk away.',
    'Matches your craving and is only 9 mins away.'
  ]) {
    assert.equal(checkReason(reason, fourFingers), null, reason);
  }
});

test('WALK B/C: supplied metres and "within your walking range" are allowed', function() {
  for (const reason of [
    'Matches your spicy chicken craving and is 733 m away.',
    'A stronger match for your spicy chicken craving while still within your walking range.',
    'Fits your craving better and is still within your preferred distance.'
  ]) {
    assert.equal(checkReason(reason, fourFingers), reason);
  }
});

test('WALK curated: a demo merchant may quote only its own supplied minutes estimate', function() {
  const curated = reasonMerchant({ id: 'green-bowl', source: 'local-fallback', dietary: ['vegetarian', 'vegan'],
    distanceMetres: undefined, distanceMinutes: 6 });
  assert.equal(checkReason('Vegan bowl, six minutes away.', curated), 'Vegan bowl, six minutes away.');
  assert.equal(checkReason('Fits your craving within a 10-minute walk.', curated), null, 'the user limit is not its travel time');
});

test('WALK E/F: a dropped walking-time reason keeps the merchant and never triggers OpenAI', async function() {
  const merchants = await discover(chickenPlaces, 'spicy crispy chicken');
  process.env.GROQ_API_KEY = 'test-groq';
  process.env.OPENAI_API_KEY = 'test-openai';
  const calls = mockRankers({ groq: Object.assign({}, chixPick,
    { reason: 'Chix Hot Chicken matches your spicy chicken craving within a 10-minute walk.' }),
  openai: Object.assign({}, chixPick, { merchantId: 'google-leaf' }) });
  const result = await rank(merchants, 'spicy crispy chicken');
  assert.equal(result.merchant.id, 'google-chix');
  assert.equal(result.reason, null);
  assert.equal(calls.groq.length, 1);
  assert.equal(calls.openai.length, 0);
  const prompt = promptOf(calls.groq[0]);
  assert.match(prompt, /maxWalkingMinutes: 10 \(an eligibility limit only - NOT a travel time\)/);
  assert.match(prompt, /Never convert maxWalkingMinutes into a claimed travel time/);
});

test('SPEED: a hung Groq ranker falls back within the shared 1.5 s ranking budget', async function() {
  const merchants = await discover(chickenPlaces, 'spicy crispy chicken');
  process.env.GROQ_API_KEY = 'test-groq';
  process.env.OPENAI_API_KEY = 'test-openai';
  const calls = { groq: 0, openai: 0 };
  global.fetch = function(url, init) {
    const host = new URL(String(url)).hostname;
    if (host === 'api.groq.com') {
      calls.groq += 1;
      return new Promise(function(resolve, reject) {
        init.signal.addEventListener('abort', function() { reject(new Error('aborted')); });
      });
    }
    if (host === 'api.openai.com') { calls.openai += 1; return Promise.resolve(chatReply(JSON.stringify(chixPick))); }
    return Promise.resolve({ ok: false, status: 404 });
  };
  const started = Date.now();
  const result = await rank(merchants, 'spicy crispy chicken');
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 1900, 'ranking finished in ' + elapsed + ' ms');
  assert.equal(calls.groq, 1);
  assert.equal(calls.openai, 0, 'Groq used the whole budget, so OpenAI is skipped for rules');
  assert.ok(result.merchant, 'deterministic rules still recommend a merchant');
  assert.equal(result.reason, null);
});
