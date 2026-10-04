const test = require('node:test');
const assert = require('node:assert/strict');
const { app, demoStore, resetMerchantCampaigns, clearDiscoveryCache, clearSearchIntentCache, getMerchantCampaigns,
  getNearbyMerchants, getSmartRecommendation, createInitialDemo } = require('../app');
const realFetch = global.fetch;
const keys = ['GOOGLE_PLACES_API_KEY', 'FOURSQUARE_API_KEY', 'GROQ_API_KEY', 'OPENAI_API_KEY', 'PLACES_PROVIDER'];
const original = Object.fromEntries(keys.map(k => [k, process.env[k]]));
const origin = { latitude: 1.3, longitude: 103.85 };
let server, base;
test.before(async () => {
  server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  base = 'http://127.0.0.1:' + server.address().port;
});
test.after(() => { server.close(); keys.forEach(k => original[k] === undefined ? delete process.env[k] : process.env[k] = original[k]); });
test.beforeEach(() => { keys.forEach(k => delete process.env[k]); clearDiscoveryCache(); clearSearchIntentCache(); resetMerchantCampaigns(); });
test.afterEach(() => { global.fetch = realFetch; });
function visitor() {
  let cookie = '';
  return {
    async request(path, body) {
      const response = await realFetch(base + path, { method: body === undefined ? 'GET' : 'POST', redirect: 'manual',
        headers: { Cookie: cookie, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body) });
      if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
      return { status: response.status, html: await response.text() };
    },
    async state(edit) {
      const id = decodeURIComponent(cookie.split('=')[1]).slice(2).split('.')[0];
      const stored = await new Promise((resolve, reject) => demoStore.get(id, (err, s) => err ? reject(err) : resolve(s)));
      if (edit) { edit(stored.demo); await new Promise((resolve, reject) => demoStore.set(id, stored, err => err ? reject(err) : resolve())); }
      return stored.demo;
    }
  };
}
const merchantId = page => (page.html.match(/data-merchant-id="([^"]+)"/) || [])[1] || null;
const place = (id, name, metres = 300, type = 'restaurant') => ({ id, displayName: { text: name },
  primaryType: type, types: [type, 'food'], location: { latitude: origin.latitude + metres / 111195, longitude: origin.longitude } });
const chat = value => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(value) } }] }) });
function mock(options = {}) {
  process.env.GOOGLE_PLACES_API_KEY = 'mock'; process.env.GROQ_API_KEY = 'mock';
  if (options.alternate) process.env.FOURSQUARE_API_KEY = 'mock';
  const calls = { discovery: [], ranking: [], continuationIntent: [] };
  let continued = false;
  global.fetch = async (url, init) => {
    const body = init && init.body ? JSON.parse(init.body) : {};
    if (String(url).includes('groq')) {
      if (body.messages[0].content.includes('SMART MATCH CONTINUATION')) {
        calls.continuationIntent.push(body);
        return options.intentFail ? { ok: false, status: 429, json: async () => ({}) } :
          chat({ searchQuery: options.alternativeQuery || options.query || 'food', concepts: [] });
      }
      if (body.messages[0].content.includes('You turn a free-text food craving')) {
        return chat({ searchQuery: options.query || 'comfort food', concepts: [] });
      }
      calls.ranking.push(body);
      if ((options.aiFailAfterFirst && calls.ranking.length > 1) || (options.aiFailAtThird && calls.ranking.length > 2)) return { ok: false, status: 429, json: async () => ({}) };
      const listed = JSON.parse(body.messages[1].content.split('Eligible merchants:\n')[1].split('\n\nOutput:')[0]);
      const suitable = options.suitableIds || ['google-a', 'google-b', 'google-new', 'foursquare-new'];
      const chosen = listed.find(m => suitable.includes(m.id));
      const craving = !body.messages[1].content.includes('Specific craving: none');
      const mood = !body.messages[1].content.includes('Food mood today: Anything');
      return chat({ merchantId: chosen ? chosen.id : null, cravingFit: craving ? chosen ? 'medium' : 'low' : 'not_applicable',
        moodFit: mood ? chosen ? 'medium' : 'low' : 'not_applicable', overallFit: chosen ? 'medium' : 'low',
        reason: chosen ? 'The supplied name suggests a food fit.' : 'The supplied facts conflict with the active food request.' });
    }
    if (String(url).includes('places-api.foursquare')) {
      const query = new URL(url).searchParams.get('query');
      calls.discovery.push({ provider: 'foursquare', query }); continued = true;
      const results = (options.fresh || [place('new', 'New Food Match')]).map(m => ({ fsq_place_id: m.id, name: m.displayName.text,
        categories: [{ name: 'Restaurant' }], latitude: m.location.latitude, longitude: m.location.longitude }));
      return { ok: true, json: async () => ({ results }) };
    }
    if (String(url).includes('places.googleapis')) {
      const broad = String(url).endsWith(':searchNearby');
      const continuation = calls.continuationIntent.length > 0;
      calls.discovery.push({ provider: 'google', query: broad ? 'nearby' : body.textQuery });
      if (continuation) continued = true;
      const places = broad ? [place('broad', 'Mala Nearby', 20, 'chinese_restaurant')] :
        continued ? options.fresh || [place('new', 'New Food Match')] : options.initial || [place('a', 'First Food Match'), place('b', 'Second Food Match')];
      return { ok: true, json: async () => ({ places }) };
    }
    return { ok: false, status: 404 };
  };
  return calls;
}
async function start(v, profile = {}) {
  await v.request('/home');
  await v.request('/profile', { craving: '', moodCuisine: 'any', dietaryPreference: 'none', budget: '10', maxDistanceMinutes: 10, ...profile });
  await v.request('/smart-match/location', origin);
  return merchantId(await v.request('/smart-match/result'));
}
async function reject(v, id, reason = 'not-in-mood') {
  assert.equal((await v.request('/recommendation/reject', { merchantId: id, reason })).status, 302);
}
for (const [mood, craving, query, names] of [
  ['bread', '', 'bread', ['First Bakery', 'Second Toast Shop']],
  ['rice', '', 'rice', ['First Rice Merchant', 'Second Rice Merchant']],
  ['any', 'something spicy', 'something spicy', ['Spicy Kitchen', 'Another Spicy Kitchen']],
  ['bread', 'chicken', 'chicken sandwich', ['First Sandwich Shop', 'Second Sandwich Shop']]
]) {
  test('current batch: ' + mood + ' / ' + craving + ' retains intent with zero extra discovery', async () => {
    const calls = mock({ query, initial: names.map((name, i) => place(i ? 'b' : 'a', name)) });
    const v = visitor(); const first = await start(v, { moodCuisine: mood, craving });
    const before = (await v.state()).profile; const discovery = calls.discovery.length;
    await reject(v, first);
    const next = merchantId(await v.request('/smart-match/result'));
    assert.equal(next, 'google-b'); assert.notEqual(next, first);
    assert.equal(calls.discovery.length, discovery); assert.equal(calls.continuationIntent.length, 0);
    assert.deepEqual((await v.state()).profile, before);
    const request = calls.ranking.at(-1).messages[1].content;
    assert.ok(request.includes('Specific craving: ' + (craving || 'none')));
    assert.ok(request.includes('Food mood today: ' + (mood === 'any' ? 'Anything' : mood[0].toUpperCase() + mood.slice(1))));
  });
}
for (const alternate of [false, true]) {
  test('explicit cached-pool no-match continues once via ' + (alternate ? 'next provider' : 'alternative query'), async () => {
    const calls = mock({ alternate, query: 'bread', alternativeQuery: 'bread food',
      initial: [place('a', 'First Bakery', 300, 'bakery'), place('conflict', 'Mala Kitchen', 50, 'chinese_restaurant')] });
    const v = visitor(); const first = await start(v, { moodCuisine: 'bread' }); const count = calls.discovery.length;
    await reject(v, first); const next = merchantId(await v.request('/smart-match/result'));
    assert.equal(next, alternate ? 'foursquare-new' : 'google-new');
    assert.equal(calls.discovery.length, count + 1);
    assert.equal(calls.continuationIntent.length, alternate ? 0 : 1);
    assert.equal(calls.discovery.at(-1).query, alternate ? 'bread' : 'bread food');
    assert.equal(calls.ranking.length, 3, 'initial, remaining cached pool, new merged pool');
    assert.ok(calls.ranking.at(-1).messages[1].content.includes('Food mood today: Bread'));
    const listed = JSON.parse(calls.ranking.at(-1).messages[1].content.split('Eligible merchants:\n')[1].split('\n\nOutput:')[0]);
    assert.ok(!listed.some(m => m.id === first), 'rejection context is retained, but rejected ID is not eligible');
    const countAfter = calls.discovery.length;
    assert.equal(merchantId(await v.request('/smart-match/result')), next); assert.equal(calls.discovery.length, countAfter);
  });
}
test('identical IDs with changed names/distances do not duplicate, repeat, or loop', async () => {
  const calls = mock({ query: 'bread', initial: [place('a', 'Bakery', 200, 'bakery')],
    fresh: [place('a', 'Renamed Bakery', 100, 'bakery'), place('a', 'Same ID Again', 120, 'bakery')] });
  const v = visitor(); const first = await start(v, { moodCuisine: 'bread' }); const count = calls.discovery.length;
  await reject(v, first); const empty = await v.request('/smart-match/result');
  assert.equal(merchantId(empty), null); assert.equal(calls.discovery.length, count + 1);
  assert.match(empty.html, /We couldn’t find another nearby match for your current craving and mood/);
  for (const action of ['Search farther', 'Edit craving', 'Change mood']) assert.ok(empty.html.includes(action));
  const state = await v.state(); assert.equal(state.nearbyMerchants.filter(m => m.id === first).length, 1);
  assert.deepEqual(state.matchContinuation.discovery.newIds, []);
  const rankings = calls.ranking.length;
  await v.request('/smart-match/result'); assert.equal(calls.discovery.length, count + 1);
  assert.equal(calls.ranking.length, rankings, 'a terminal identical batch is not repeatedly ranked');
});
test('new stable IDs are merged once even if response duplicates them', async () => {
  const calls = mock({ query: 'bread', initial: [place('a', 'Bakery')], fresh: [place('new', 'New Bakery'), place('new', 'Renamed New Bakery', 100)] });
  const v = visitor(); const first = await start(v, { moodCuisine: 'bread' });
  await reject(v, first); assert.equal(merchantId(await v.request('/smart-match/result')), 'google-new');
  assert.equal((await v.state()).nearbyMerchants.filter(m => m.id === 'google-new').length, 1);
  assert.equal(calls.continuationIntent.length, 1);
});
test('empty continuation and unrelated broad pool never fill a specific food result', async () => {
  const calls = mock({ query: 'bread', initial: [place('a', 'Bakery')], fresh: [] });
  const v = visitor(); const first = await start(v, { moodCuisine: 'bread' }); const count = calls.discovery.length;
  await reject(v, first);
  assert.equal(merchantId(await v.request('/smart-match/result')), null); assert.equal(calls.discovery.length, count + 1);
  assert.equal(calls.ranking.length, 2, 'no ranking of a nonexistent new batch');
});
test('AI failure after rejection uses only a new direct targeted candidate', async () => {
  const calls = mock({ query: 'rice', initial: [place('a', 'Rice Kitchen')], aiFailAfterFirst: true });
  const v = visitor(); const first = await start(v, { moodCuisine: 'rice' }); const count = calls.discovery.length;
  await reject(v, first); const page = await v.request('/smart-match/result');
  assert.equal(merchantId(page), 'google-new'); assert.match(page.html, /search; merchant details are limited/);
  assert.equal(calls.discovery.length, count + 1);
});
test('intent failure still bypasses cache for the unchanged query once', async () => {
  const calls = mock({ query: 'rice', intentFail: true, initial: [place('a', 'Rice Kitchen')] });
  const v = visitor(); const first = await start(v, { moodCuisine: 'rice' }); const count = calls.discovery.length;
  await reject(v, first); assert.equal(merchantId(await v.request('/smart-match/result')), 'google-new');
  assert.equal(calls.discovery.length, count + 1); assert.equal(calls.discovery.at(-1).query, 'rice');
  assert.equal(calls.continuationIntent.length, 1);
});
for (const closer of [true, false]) {
  test('Too far continuation ' + (closer ? 'selects strictly closer' : 'honestly explains no closer match'), async () => {
    const calls = mock({ query: 'rice', initial: [place('a', 'Rice Kitchen', 300)],
      fresh: [place('new', 'Another Rice Kitchen', closer ? 100 : 400)] });
    const v = visitor(); const first = await start(v, { moodCuisine: 'rice' }); const count = calls.discovery.length;
    await reject(v, first, 'too-far'); const page = await v.request('/smart-match/result');
    assert.equal(calls.discovery.length, count + 1);
    if (closer) assert.equal(merchantId(page), 'google-new');
    else { assert.equal(merchantId(page), null); assert.match(page.html, /No closer match was found/); }
  });
}
test('cost and recently-eaten preferences reach ranker, stay factual in targeted fallback', async () => {
  const calls = mock({ query: 'rice', initial: [place('a', 'Rice Kitchen'), place('b', 'Other Rice Kitchen')] });
  const nearby = await getNearbyMerchants(origin, 'jia', '', 10, 'none', 'rice');
  delete process.env.GROQ_API_KEY;
  const demo = createInitialDemo('jia'); demo.profile.moodCuisine = 'rice';
  const a = nearby.merchants.find(m => m.id === 'google-a');
  const b = nearby.merchants.find(m => m.id === 'google-b');
  a.price = null; b.price = 5; a.distanceMetres = 10; b.distanceMetres = 500;
  const cost = await getSmartRecommendation(demo.profile, [a, b], [], [{ reason: 'too-expensive', price: 8 }], demo, []);
  assert.equal(cost.merchant.id, b.id, 'unknown price never counts as cheaper');
  a.cuisineTags = ['indian']; b.cuisineTags = ['malay'];
  const recent = await getSmartRecommendation(demo.profile, [a, b], [], [{ reason: 'ate-recently', cuisineTags: ['indian'] }], demo, []);
  assert.equal(recent.merchant.id, b.id);
  process.env.GROQ_API_KEY = 'mock';
  const v = visitor(); const first = await start(v, { moodCuisine: 'rice' });
  await reject(v, first, 'ate-recently'); await v.request('/smart-match/result');
  assert.match(calls.ranking.at(-1).messages[1].content, /Last rejection:.*ate-recently/);
});
test('dietary declarations filter continuation before ranking', async () => {
  const calls = mock({ query: 'rice', initial: [place('a', 'Rice Kitchen')], fresh: [place('new', 'Undeclared Rice Kitchen')] });
  const v = visitor(); await start(v, { moodCuisine: 'rice' });
  getMerchantCampaigns().find(c => c.merchantId === 'google-a').dietaryCapabilities = { halal: true };
  getMerchantCampaigns().forEach(c => { if (c.merchantId !== 'google-a') c.dietaryCapabilities = {}; });
  await v.state(demo => { demo.profile.dietaryPreference = 'halal'; });
  const count = calls.ranking.length; await reject(v, 'google-a');
  const page = await v.request('/smart-match/result');
  assert.equal(merchantId(page), null);
  assert.equal(calls.ranking.length, count, 'no eligible declared alternative to send to AI');
  assert.equal((await v.state()).profile.dietaryPreference, 'halal');
});
test('continuation and rejection history are isolated between sessions', async () => {
  const calls = mock({ query: 'bread', initial: [place('a', 'Bakery')], fresh: [] });
  const a = visitor(), b = visitor();
  assert.equal(await start(a, { moodCuisine: 'bread' }), 'google-a');
  assert.equal(await start(b, { moodCuisine: 'bread' }), 'google-a');
  await reject(a, 'google-a'); await a.request('/smart-match/result');
  assert.ok((await a.state()).matchContinuation.attempted);
  assert.equal((await b.state()).matchContinuation, null); assert.deepEqual((await b.state()).rejectedMerchantIds, []);
  assert.equal(merchantId(await b.request('/smart-match/result')), 'google-a');
  assert.equal(calls.continuationIntent.length, 1);
});
for (const change of ['craving', 'mood', 'diet', 'distance', 'location']) {
  test('changing ' + change + ' resets continuation without deleting rejected IDs', async () => {
    mock({ query: 'bread', initial: [place('a', 'Bakery')], fresh: [] });
    const v = visitor(); const first = await start(v, { moodCuisine: 'bread' });
    await reject(v, first); await v.request('/smart-match/result'); assert.ok((await v.state()).matchContinuation);
    if (change === 'diet') await v.request('/profile/dietary', { dietaryPreference: 'vegan' });
    else if (change === 'location') await v.request('/smart-match/location', { latitude: 1.301, longitude: 103.85 });
    else await v.request('/profile', { craving: change === 'craving' ? 'something warm' : '', moodCuisine: change === 'mood' ? 'rice' : 'bread',
      budget: '10', maxDistanceMinutes: change === 'distance' ? 15 : 10 });
    const state = await v.state(); assert.equal(state.matchContinuation, null); assert.ok(state.rejectedMerchantIds.includes(first));
  });
}
test('Try again does not erase explicit merchant rejections', async () => {
  mock({ query: 'bread', initial: [place('a', 'Bakery')], fresh: [] });
  const v = visitor(); const first = await start(v, { moodCuisine: 'bread' });
  await reject(v, first); await v.request('/smart-match/result');
  await v.request('/recommendation/try-again');
  assert.ok((await v.state()).rejectedMerchantIds.includes(first));
  assert.notEqual(merchantId(await v.request('/smart-match/result')), first);
});
test('AI outage during continuation never resurrects cached candidates that received no-match', async () => {
  const calls = mock({ query: 'bread', initial: [place('a', 'Bakery', 300), place('conflict', 'Mala Kitchen', 30)],
    fresh: [place('new', 'New Bakery', 500)], aiFailAtThird: true });
  const v = visitor(); const first = await start(v, { moodCuisine: 'bread' });
  await reject(v, first);
  assert.equal(merchantId(await v.request('/smart-match/result')), 'google-new');
  assert.equal(calls.ranking.length, 3);
});
for (const [mood, craving, query, alternativeQuery] of [
  ['rice', '', 'rice', 'rice food'],
  ['any', 'something spicy', 'something spicy', 'spicy food'],
  ['bread', 'chicken', 'chicken sandwich', 'chicken sandwich food']
]) {
  test('continuation preserves original inputs: ' + query, async () => {
    const calls = mock({ query, alternativeQuery, initial: [place('a', 'First Food Match')] });
    const v = visitor(); const first = await start(v, { moodCuisine: mood, craving });
    const before = (await v.state()).profile; const count = calls.discovery.length;
    await reject(v, first); assert.equal(merchantId(await v.request('/smart-match/result')), 'google-new');
    assert.equal(calls.discovery.length, count + 1); assert.equal(calls.continuationIntent.length, 1);
    assert.equal(calls.discovery.at(-1).query, alternativeQuery);
    assert.deepEqual((await v.state()).profile, before);
    const prompt = calls.ranking.at(-1).messages[1].content;
    assert.ok(prompt.includes('Specific craving: ' + (craving || 'none')));
    assert.ok(prompt.includes('Food mood today: ' + (mood === 'any' ? 'Anything' : mood[0].toUpperCase() + mood.slice(1))));
  });
}
test('new continuation targets reach ranking even when cached targets exceed the prompt limit', async () => {
  const calls = mock({ query: 'bread', initial: [place('a', 'Bakery', 100)].concat(
    Array.from({ length: 14 }, (_, i) => place('conflict-' + i, 'Conflicting Kitchen ' + i, 150 + i))),
    fresh: [place('new', 'New Bakery', 700)] });
  const v = visitor(); const first = await start(v, { moodCuisine: 'bread' });
  await reject(v, first); assert.equal(merchantId(await v.request('/smart-match/result')), 'google-new');
  const listed = JSON.parse(calls.ranking.at(-1).messages[1].content.split('Eligible merchants:\n')[1].split('\n\nOutput:')[0]);
  assert.equal(listed.length, 12); assert.ok(listed.some(m => m.id === 'google-new'));
});
