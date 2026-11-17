const { database: db, counters } = require('./helpers/test-isolation.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const { start } = require('./helpers/visitor.cjs');
const { seedTask3Merchants, seedMenu } = require('./helpers/task7-menu-fixtures.cjs');
const nl = require('../natural-language-intent');
const { resetMerchantCampaigns, getMerchantCampaigns } = require('../app');

const originalFetch = global.fetch;
const GROQ_KEY = 'fake-groq-key-7777';
const ROUTES_KEY = 'fake-routes-key-8888';
const ORIGIN = { latitude: 1.3012345, longitude: 103.8123456 };
const DAY = 'diningDate=2026-11-17&diningTime=12:00';
const QUERY = (extra) => '?' + DAY + (extra ? '&' + extra : '');

let groqCalls; let routeCalls; let groqReply; let routeTable;
function reply(overrides) {
  return Object.assign({ budgetMax: null, distance: null, cuisine: null, dietary: null, dayRef: null, time: null,
    mealPeriod: null, unsupported: [], foodCategory: null, dishTerms: [] }, overrides || {});
}
function installFetch() {
  groqCalls = []; routeCalls = [];
  global.fetch = async function(url, init) {
    const host = new URL(String(url)).hostname;
    if (host === 'api.groq.com') {
      groqCalls.push(JSON.parse(init.body));
      const content = typeof groqReply === 'function' ? groqReply(JSON.parse(init.body)) : groqReply;
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(content) } }] }) };
    }
    if (host === 'routes.googleapis.com') {
      const body = JSON.parse(init.body);
      routeCalls.push(body);
      const byCoordinate = new Map();
      db.merchants.forEach(r => { if (!Array.isArray(r) && r.latitude) byCoordinate.set(Number(r.latitude) + ',' + Number(r.longitude), r.merchant_id); });
      const elements = body.destinations.map((d, index) => {
        const id = byCoordinate.get(d.waypoint.location.latLng.latitude + ',' + d.waypoint.location.latLng.longitude);
        const metres = routeTable && routeTable[id] !== undefined ? routeTable[id] : 3000;
        const element = { status: {}, condition: 'ROUTE_EXISTS', distanceMeters: metres, duration: Math.round(metres * 0.75) + 's' };
        if (index) element.destinationIndex = index;
        return element;
      });
      return { ok: true, status: 200, json: async () => elements };
    }
    throw new Error('unexpected outbound host ' + host);
  };
}

async function get(v, query) {
  const response = await v.request('/api/recommend' + query);
  return { response, body: JSON.parse(response.html) };
}
async function natural(v, body, content) {
  groqReply = content;
  const response = await v.request('/api/recommend/natural', body);
  return { response, body: JSON.parse(response.html) };
}
async function live(v, body) {
  const response = await v.request('/api/recommend/live', Object.assign({ location: ORIGIN, budget: 10, maxDistance: 60,
    diningDate: '2026-11-17', diningTime: '12:00' }, body));
  return { response, body: JSON.parse(response.html) };
}
const menuCalls = () => db.calls.filter(call => /FROM merchant_menu_items/.test(call.sql));
const ids = cards => cards.map(card => card.id);
const batchOf = async v => { const d = (await v.state()).demo; return JSON.stringify([d.catalogueBatch, d.lastApiRecommendations]); };

let http;
test.before(async () => { http = await start(); });
test.beforeEach(() => {
  process.env.GROQ_API_KEY = GROQ_KEY;
  process.env.GOOGLE_ROUTES_API_KEY = ROUTES_KEY;
  resetMerchantCampaigns();
  seedTask3Merchants(db);
  seedMenu(db);
  nl.setClockForTest(() => new Date('2026-11-17T04:00:00.000Z'));
  installFetch();
});
test.afterEach(() => {
  global.fetch = originalFetch;
  delete process.env.GROQ_API_KEY; delete process.env.GOOGLE_ROUTES_API_KEY;
  nl.setClockForTest();
  groqReply = undefined; routeTable = undefined;
});
test.after(async () => {
  await http.close();
  assert.deepEqual(counters, { envLoads: 0, privateReads: 0, mysqlFactories: 0, redisFactories: 0, blockedConnections: 0 });
});

// ---------------------------------------------------------------------------
// Food chips and dietary chips
// ---------------------------------------------------------------------------
test('all six food choices use the same engine and return grounded results', async () => {
  const baseline = await get(http.visitor(), QUERY());
  assert.equal(menuCalls().length, 0, 'no food requirement: the menu is not read');
  const anything = await get(http.visitor(), QUERY('foodCategory=any'));
  assert.deepEqual(ids(anything.body.recommendations), ids(baseline.body.recommendations));
  assert.equal(menuCalls().length, 0, '"Anything" is not a food requirement');
  assert.equal(anything.body.metadata.menu, undefined);

  for (const category of ['rice', 'noodles', 'healthy-bowls', 'indian', 'wraps']) {
    db.calls.length = 0;
    const { response, body } = await get(http.visitor(), QUERY('foodCategory=' + category));
    assert.equal(response.status, 200, category);
    assert.ok(body.recommendations.length >= 2, category + ' has at least two grounded results');
    assert.equal(new Set(ids(body.recommendations)).size, body.recommendations.length);
    body.recommendations.forEach(card => {
      assert.ok(card.recommendedMenuItem.categories.includes(category), card.id);
      assert.ok(card.recommendedMenuItem.price <= 10);
      assert.equal(card.recommendedMenuItem.matchBasis, 'category');
      assert.match(card.recommendedMenuItem.label, /Fictional sample item/);
      assert.equal(card.typicalPrice, card.price, 'the typical merchant price is kept apart');
    });
    assert.equal(menuCalls().length, 1, 'exactly one batched menu read');
    assert.equal(body.metadata.request.foodCategory, category);
    assert.equal(body.metadata.menu.status, 'available');
  }
});

test('all four dietary choices apply at the matched-item level and never leak across requests', async () => {
  const run = async extra => (await get(http.visitor(), QUERY(extra))).body.recommendations;
  const halalNoodles = await run('foodCategory=noodles&dietaryPreference=halal');
  assert.deepEqual(ids(halalNoodles).sort(), ['kopi-toast-corner', 'makcik-nasi-padang']);
  halalNoodles.forEach(card => assert.equal(card.recommendedMenuItem.dietary.halal, true));
  const vegetarianNoodles = await run('foodCategory=noodles&dietaryPreference=vegetarian');
  assert.deepEqual(ids(vegetarianNoodles), ['vegan-zen-kitchen'], 'vegan satisfies vegetarian; an unflagged item does not');
  const veganNoodles = await run('foodCategory=noodles&dietaryPreference=vegan');
  assert.deepEqual(ids(veganNoodles), ['vegan-zen-kitchen']);
  assert.equal(veganNoodles[0].recommendedMenuItem.name, 'Vegan Mee Goreng');
  const veganIndian = await run('foodCategory=indian&dietaryPreference=vegan');
  assert.deepEqual(veganIndian, [], 'vegetarian items never satisfy vegan');
  const vegetarianIndian = await run('foodCategory=indian&dietaryPreference=vegetarian');
  assert.deepEqual(ids(vegetarianIndian).sort(), ['kopi-toast-corner', 'spice-lane']);
  const none = await run('foodCategory=noodles&dietaryPreference=none');
  assert.ok(none.length === 3 && none.some(card => !card.recommendedMenuItem.dietary.vegetarian));
  // Dietary-only requests keep the merchant-level behaviour: no menu read, no item.
  db.calls.length = 0;
  const dietOnly = await get(http.visitor(), QUERY('dietaryPreference=vegan'));
  assert.equal(menuCalls().length, 0);
  assert.ok(dietOnly.body.recommendations.every(card => card.recommendedMenuItem === undefined));
  assert.deepEqual(ids(dietOnly.body.recommendations).sort(), ['green-bowl', 'vegan-zen-kitchen'].sort().filter(id => ids(dietOnly.body.recommendations).includes(id)));
});

test('a saved dietary preference is the default; a chip overrides it for one request only', async () => {
  const v = http.visitor();
  await v.request('/home');
  await v.change(demo => { demo.profile.dietaryPreference = 'halal'; });
  const saved = await get(v, QUERY('foodCategory=noodles'));
  assert.deepEqual(ids(saved.body.recommendations).sort(), ['kopi-toast-corner', 'makcik-nasi-padang']);
  assert.equal(saved.body.metadata.request.dietaryPreference, 'halal');
  const overridden = await get(v, QUERY('foodCategory=noodles&dietaryPreference=none'));
  assert.equal(overridden.body.metadata.request.dietaryPreference, 'none');
  assert.ok(overridden.body.recommendations.length > saved.body.recommendations.length);
  assert.equal((await v.state()).demo.profile.dietaryPreference, 'halal', 'the saved profile is unchanged');
  const again = await get(v, QUERY('foodCategory=noodles'));
  assert.equal(again.body.metadata.request.dietaryPreference, 'halal');
});

// ---------------------------------------------------------------------------
// Typed food and diet interpretation, grounding and aliases
// ---------------------------------------------------------------------------
test('typed "chicken rice" is grounded exactly and ranks above generic chicken matches; "chicken" matches the tag', async () => {
  const exact = await natural(http.visitor(), { text: 'chicken rice' }, reply({ dishTerms: ['chicken rice'] }));
  assert.equal(exact.response.status, 200);
  const cards = exact.body.recommendations;
  assert.equal(cards[0].id, 'felicia-chicken-rice');
  assert.equal(cards[0].recommendedMenuItem.name, 'Roasted Chicken Rice');
  assert.equal(cards[0].recommendedMenuItem.matchBasis, 'exact');
  assert.ok(cards.slice(1).every(card => card.recommendedMenuItem.matchBasis === 'tokens'), 'other chicken-and-rice items rank lower');
  assert.ok(cards[1].matchReasons.some(reason => /not an exact dish name/.test(reason)));
  assert.ok(cards[0].matchReasons.some(reason => /Matches “chicken rice”/.test(reason)));
  assert.deepEqual(exact.body.metadata.menu.appliedTerms, ['chicken rice']);

  const generic = await natural(http.visitor(), { text: 'chicken' }, reply({ dishTerms: ['chicken'] }));
  assert.ok(generic.body.recommendations.length === 3);
  generic.body.recommendations.forEach(card => assert.ok(card.recommendedMenuItem.tags.includes('chicken')));
});

test('"light" is applied only through the explicit stored tag; unknown words stay Not applied', async () => {
  const light = await natural(http.visitor(), { text: 'something light' }, reply({ dishTerms: ['light'] }));
  assert.equal(light.response.status, 200);
  light.body.recommendations.forEach(card => assert.ok(card.recommendedMenuItem.tags.includes('light')));
  assert.ok(light.body.interpretation.understood.some(chip => chip.field === 'dishTerms' && chip.value === 'light'));
  const unknown = await natural(http.visitor(), { text: 'pizza under 10' }, reply({ budgetMax: 10, dishTerms: ['pizza'] }));
  assert.equal(unknown.response.status, 200);
  assert.deepEqual(unknown.body.metadata.menu.unsupportedTerms, ['pizza']);
  assert.deepEqual(unknown.body.metadata.request.dishTerms, []);
  assert.ok(unknown.body.interpretation.notApplied.some(line => /“pizza”: not applied. The sample menu has no matching item/.test(line)));
  assert.ok(unknown.body.recommendations.length > 0, 'an unsupported word does not block supported constraints');
  assert.ok(unknown.body.recommendations.every(card => card.recommendedMenuItem === undefined));
});

test('reviewed aliases map only to stored terms; the provider cannot invent or translate', async () => {
  const cases = [['ayam', 'chicken', null], ['biryani', 'briyani', ['spice-lane']], ['roti canai', 'prata', ['kopi-toast-corner', 'spice-lane']],
    ['beehoon', 'bee hoon', ['ah-heng-fish-soup']], ['kabab', 'kebab', ['northside-wraps']]];
  for (const [raw, canonical, merchants] of cases) {
    const { response, body } = await natural(http.visitor(), { text: raw }, reply({ dishTerms: [raw] }));
    assert.equal(response.status, 200, raw);
    assert.deepEqual(body.metadata.menu.appliedTerms, [canonical], raw);
    if (merchants) assert.deepEqual(ids(body.recommendations).sort(), merchants, raw);
  }
  // The model may not translate: "chicken" is not a word the user typed.
  const translated = await natural(http.visitor(), { text: 'ayam' }, reply({ dishTerms: ['chicken'] }));
  assert.equal(translated.response.status, 502);
  assert.equal(translated.body.error.code, 'natural-language-invalid-output');
  // Unknown aliases are Not applied, never fuzzily matched.
  const unknown = await natural(http.visitor(), { text: 'ramen' }, reply({ dishTerms: ['ramen'] }));
  assert.deepEqual(unknown.body.metadata.menu.unsupportedTerms, ['ramen']);
  const fuzzy = await natural(http.visitor(), { text: 'chickn rice' }, reply({ dishTerms: ['chickn rice'] }));
  assert.deepEqual(fuzzy.body.metadata.menu.unsupportedTerms, ['chickn rice']);
});

test('hostile or provider-invented food output is rejected as a whole', async () => {
  const bad = [
    [{ text: 'pizza' }, reply({ dishTerms: ['chicken'] })],
    [{ text: 'chicken $5' }, reply({ dishTerms: ['chicken $5'] })],
    [{ text: 'chicken' }, reply({ dishTerms: ['<b>chicken</b>'] })],
    [{ text: 'chicken rice noodles soup' }, reply({ dishTerms: ['chicken', 'rice', 'noodles', 'soup'] })],
    [{ text: 'chicken' }, reply({ dishTerms: [123] })],
    [{ text: 'chicken' }, reply({ dishTerms: 'chicken' })],
    [{ text: 'chicken' }, Object.assign(reply({ dishTerms: ['chicken'] }), { menuItem: 'Chicken Rice $4.00', merchantId: 'felicia-chicken-rice' })],
    [{ text: 'halal chicken' }, reply({ dishTerms: ['halal chicken'], dietary: 'halal' })],
    [{ text: 'rice' }, reply({ foodCategory: 'wraps' })],
    [{ text: 'something nice' }, reply({ foodCategory: 'indian' })],
    [{ text: 'rice' }, Object.assign(reply({ foodCategory: 'rice' }), { cuisine: 'noodles' })],
    [{ text: 'noodles' }, reply({ foodCategory: 'noodles', cuisine: 'rice' })]
  ];
  db.calls.length = 0;
  for (const [body, content] of bad) {
    // A fresh session per case keeps the local request limit out of the way.
    const v = http.visitor();
    await get(v, QUERY());
    const before = await batchOf(v);
    const result = await natural(v, body, content);
    assert.equal(result.response.status, 502, JSON.stringify(body) + JSON.stringify(content));
    assert.equal(result.body.error.code, 'natural-language-invalid-output');
    assert.equal(await batchOf(v), before);
  }
  assert.equal(menuCalls().length, 0, 'the menu is never read for rejected interpretations');
});

test('typed halal, vegetarian and vegan wording can never be omitted, contradicted, invented or guessed', async () => {
  const cases = [
    [{ text: 'halal chicken' }, reply({ dishTerms: ['chicken'] })],
    [{ text: 'halal chicken' }, reply({ dishTerms: ['chicken'], dietary: 'vegan' })],
    [{ text: 'halal chicken' }, reply({ dishTerms: ['chicken'], dietary: 'none' })],
    [{ text: 'vegan or vegetarian' }, reply({ dietary: 'vegan' })],
    [{ text: 'not vegan please', }, reply({ dietary: 'vegan' })],
    [{ text: 'chicken' }, reply({ dishTerms: ['chicken'], dietary: 'halal' })]
  ];
  for (const [body, content] of cases) {
    const result = await natural(http.visitor(), body, content);
    assert.equal(result.response.status, 502, JSON.stringify(body));
    assert.equal(result.body.error.code, 'natural-language-invalid-output');
  }
  const ok = await natural(http.visitor(), { text: 'halal chicken' }, reply({ dishTerms: ['chicken'], dietary: 'halal' }));
  assert.equal(ok.response.status, 200);
  ok.body.recommendations.forEach(card => {
    assert.equal(card.recommendedMenuItem.dietary.halal, true);
    assert.ok(card.recommendedMenuItem.tags.includes('chicken'));
  });
});

test('negated food and diet words become Not applied, never positive requirements', async () => {
  const noRice = await natural(http.visitor(), { text: 'no rice' }, reply({ foodCategory: 'rice' }));
  assert.equal(noRice.response.status, 422);
  assert.equal(noRice.body.error.code, 'natural-language-no-usable-constraint');
  assert.ok(noRice.body.notApplied.some(line => /Negative food requests are not supported/.test(line)));
  const noChicken = await natural(http.visitor(), { text: 'no chicken under 8' }, reply({ budgetMax: 8, dishTerms: ['chicken'] }));
  assert.equal(noChicken.response.status, 200);
  assert.ok(noChicken.body.interpretation.notApplied.some(line => /“chicken”: not applied. Negative food requests/.test(line)));
  assert.ok(!noChicken.body.interpretation.understood.some(chip => chip.field === 'dishTerms'));
  assert.equal(noChicken.body.metadata.menu, undefined);
  const withoutChicken = await natural(http.visitor(), { text: 'without chicken under 8' }, reply({ budgetMax: 8, dishTerms: ['chicken'] }));
  assert.ok(withoutChicken.body.interpretation.notApplied.some(line => /Negative/.test(line)));
  // A negated diet word is never turned into that requirement.
  const notVegan = await natural(http.visitor(), { text: 'not vegan under 8' }, reply({ budgetMax: 8 }));
  assert.equal(notVegan.response.status, 200);
  assert.equal(notVegan.body.metadata.request.dietaryPreference, 'none');
});

// ---------------------------------------------------------------------------
// Chip and typed-text precedence
// ---------------------------------------------------------------------------
test('untouched defaults never conflict with typed text; actively selected chips do', async () => {
  // Untouched Anything + typed noodles: noodles from the text.
  const noodles = await natural(http.visitor(), { text: 'noodles' }, reply({ foodCategory: 'noodles' }));
  assert.equal(noodles.response.status, 200);
  assert.ok(noodles.body.recommendations.every(card => card.recommendedMenuItem.categories.includes('noodles')));
  assert.ok(noodles.body.interpretation.understood.some(chip => chip.field === 'foodCategory' && chip.value === 'Noodles'));

  // Untouched No restriction + typed halal: halal for this request only; the profile is unchanged.
  const v = http.visitor();
  const halal = await natural(v, { text: 'halal' }, reply({ dietary: 'halal' }));
  assert.equal(halal.response.status, 200);
  assert.equal(halal.body.metadata.request.dietaryPreference, 'halal');
  assert.equal((await v.state()).demo.profile.dietaryPreference, 'none');

  // Actively selected Rice + typed noodles, and actively selected Vegetarian + typed vegan: 409, batch preserved.
  const w = http.visitor();
  await get(w, QUERY());
  const before = await batchOf(w);
  db.calls.length = 0;
  const food = await natural(w, { text: 'noodles', foodCategory: 'rice' }, reply({ foodCategory: 'noodles' }));
  assert.equal(food.response.status, 409);
  assert.deepEqual(food.body, { error: { code: 'natural-language-conflicts-with-selection', fields: ['food'] } });
  const diet = await natural(w, { text: 'vegan', dietaryPreference: 'vegetarian' }, reply({ dietary: 'vegan' }));
  assert.equal(diet.response.status, 409);
  assert.deepEqual(diet.body.error.fields, ['dietary']);
  const both = await natural(w, { text: 'vegan noodles', foodCategory: 'rice', dietaryPreference: 'halal' }, reply({ foodCategory: 'noodles', dietary: 'vegan' }));
  assert.deepEqual(both.body.error.fields, ['food', 'dietary']);
  const typedNone = await natural(w, { text: 'no dietary restrictions', dietaryPreference: 'halal' }, reply({ dietary: 'none' }));
  assert.equal(typedNone.response.status, 409);
  assert.equal(await batchOf(w), before, 'conflicts preserve the previous batch and tokens');
  assert.equal(menuCalls().length, 0);

  // Equal values combine normally; a chip category plus a typed dish is an AND.
  const equal = await natural(http.visitor(), { text: 'noodles', foodCategory: 'noodles' }, reply({ foodCategory: 'noodles' }));
  assert.equal(equal.response.status, 200);
  const and = await natural(http.visitor(), { text: 'chicken', foodCategory: 'noodles' }, reply({ dishTerms: ['chicken'] }));
  assert.equal(and.response.status, 200);
  and.body.recommendations.forEach(card => {
    assert.ok(card.recommendedMenuItem.categories.includes('noodles'));
    assert.ok(card.recommendedMenuItem.tags.includes('chicken'));
  });
  // A typed requirement is kept when the chip is silent, and the active chip stays when the text is silent.
  const chipOnly = await natural(http.visitor(), { text: 'under 10', dietaryPreference: 'halal', foodCategory: 'wraps' }, reply({ budgetMax: 10 }));
  assert.equal(chipOnly.body.metadata.request.dietaryPreference, 'halal');
  assert.equal(chipOnly.body.metadata.request.foodCategory, 'wraps');
  // Invalid chip values fail before any model call.
  groqCalls.length = 0;
  const invalid = await natural(http.visitor(), { text: 'noodles', foodCategory: 'pasta' }, reply());
  assert.equal(invalid.response.status, 400);
  assert.deepEqual(invalid.body, { error: { code: 'invalid-recommendation-input', fields: { foodCategory: 'unsupported-value' } } });
  assert.equal(groqCalls.length, 0);
});

// ---------------------------------------------------------------------------
// Budget behaviour
// ---------------------------------------------------------------------------
test('the exact item price controls budget and scoring only when an item is matched', async () => {
  // Zen Plant Kitchen's typical price ($9.50) is over a $9 budget, but its Vegan Mee Goreng ($8.50) is not.
  const withFood = await get(http.visitor(), QUERY('foodCategory=noodles&dietaryPreference=vegan&budget=9'));
  assert.deepEqual(ids(withFood.body.recommendations), ['vegan-zen-kitchen']);
  const card = withFood.body.recommendations[0];
  assert.equal(card.price, 9.5);
  assert.equal(card.typicalPrice, 9.5);
  assert.equal(card.recommendedMenuItem.price, 8.5);
  assert.ok(card.matchReasons[0].startsWith('Recommended item price $8.50 is within your $9.00 budget'));
  // Without a food requirement the typical-price rule is unchanged.
  const withoutFood = await get(http.visitor(), QUERY('dietaryPreference=vegan&budget=9'));
  assert.deepEqual(ids(withoutFood.body.recommendations), ['green-bowl']);
  assert.match(withoutFood.body.recommendations[0].matchReasons[0], /^Typical price \$7\.50/);
  // An item over budget is excluded even when the merchant's typical price fits.
  const tight = await get(http.visitor(), QUERY('foodCategory=healthy-bowls&budget=8'));
  assert.deepEqual(ids(tight.body.recommendations), ['green-bowl']);
  assert.equal(tight.body.recommendations[0].recommendedMenuItem.name, 'Tofu Quinoa Bowl');
  // The cheaper qualifying item is chosen per merchant.
  const wraps = await get(http.visitor(), QUERY('foodCategory=wraps&budget=7'));
  wraps.body.recommendations.forEach(entry => assert.ok(entry.recommendedMenuItem.price <= 7));
});

// ---------------------------------------------------------------------------
// One batched read, fail closed
// ---------------------------------------------------------------------------
test('the menu is read in one parameterised batch query for every catalogue merchant', async () => {
  db.calls.length = 0;
  await get(http.visitor(), QUERY('foodCategory=rice'));
  const calls = menuCalls();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].params.length, 10);
  assert.equal((calls[0].sql.match(/\?/g) || []).length, 10);
  assert.ok(!/merchant_id = '/.test(calls[0].sql), 'values are parameters, never interpolated');
  // Legacy requests and dietary-only requests never touch the menu tables.
  db.calls.length = 0;
  await get(http.visitor(), QUERY('cuisine=rice'));
  await get(http.visitor(), QUERY('dietaryPreference=halal'));
  await natural(http.visitor(), { text: 'under 8' }, reply({ budgetMax: 8 }));
  assert.equal(menuCalls().length, 0);
});

test('every malformed menu row fails the whole read closed with a generic 503 and keeps the previous batch', async () => {
  const v = http.visitor();
  await get(v, QUERY());
  const before = await batchOf(v);
  const original = db.menuRows.map(row => ({ ...row }));
  const first = (predicate) => db.menuRows.find(predicate);
  const corruptions = {
    'cross-merchant item': () => { const r = first(x => x.item_id === 'green-bowl--tofu-quinoa-bowl'); r.merchant_id = 'felicia-chicken-rice'; },
    'unknown merchant': () => { const r = first(x => x.merchant_id === 'green-bowl'); db.menuUnfiltered = true; db.menuRows.push({ ...r, merchant_id: 'ghost', item_id: 'ghost--x', item_slug: 'x' }); },
    'wrong owner dataset': () => { first(x => x.merchant_id === 'green-bowl').dataset_key = 'someone-elses-dataset'; },
    'unsupported version': () => { first(x => x.merchant_id === 'green-bowl').menu_version = 'task7-menu-v2'; },
    'invalid item identity': () => { first(x => x.merchant_id === 'green-bowl').item_id = 'green-bowl--other'; },
    'invalid slug': () => { first(x => x.merchant_id === 'green-bowl').item_slug = 'Bad Slug'; },
    'zero price': () => { first(x => x.merchant_id === 'green-bowl').price = '0.00'; },
    'negative price': () => { first(x => x.merchant_id === 'green-bowl').price = '-3.00'; },
    'non-numeric price': () => { first(x => x.merchant_id === 'green-bowl').price = 'abc'; },
    'three-decimal price': () => { first(x => x.merchant_id === 'green-bowl').price = '5.555'; },
    'invalid term': () => { first(x => x.term === 'light').term = 'Light!'; },
    'unknown tag': () => { first(x => x.term_kind === 'tag').term = 'lobster'; },
    'unknown category': () => { first(x => x.term_kind === 'category').term = 'pizza'; },
    'bad term kind': () => { first(x => x.term_kind === 'tag').term_kind = 'flavour'; },
    'vegan without vegetarian': () => { const r = first(x => x.item_id === 'green-bowl--tofu-quinoa-bowl'); r.is_vegetarian = null; },
    'halal flag exceeds merchant': () => { first(x => x.merchant_id === 'tokyo-express-bento').is_halal = 1; },
    'vegetarian flag exceeds merchant': () => { first(x => x.merchant_id === 'woodlands-noodle-bar').is_vegetarian = 1; },
    'vegan flag exceeds merchant': () => { first(x => x.merchant_id === 'spice-lane' && x.is_vegetarian === 1).is_vegan = 1; },
    'claim status changed': () => { first(x => x.merchant_id === 'green-bowl').dietary_claim_status = 'verified'; },
    'not sample data': () => { first(x => x.merchant_id === 'green-bowl').is_sample_data = 0; },
    'bad availability': () => { first(x => x.merchant_id === 'green-bowl').availability = 'SOLD_OUT'; },
    'inconsistent rows of one item': () => { const rows = db.menuRows.filter(x => x.item_id === 'green-bowl--tofu-quinoa-bowl'); rows[1].item_name = 'Different Name'; },
    'duplicate term row': () => { const r = first(x => x.term_kind === 'tag'); db.menuRows.push({ ...r }); },
    'item without a category': () => { db.menuRows = db.menuRows.filter(x => !(x.item_id === 'green-bowl--tofu-quinoa-bowl' && x.term_kind === 'category')); },
    'bad flag value': () => { first(x => x.merchant_id === 'green-bowl').is_vegan = 'maybe'; },
    'null row': () => { db.menuRows.push(null); },
    'empty name': () => { first(x => x.merchant_id === 'green-bowl').item_name = '   '; }
  };
  for (const [label, corrupt] of Object.entries(corruptions)) {
    db.menuRows = original.map(row => ({ ...row }));
    db.menuUnfiltered = false;
    corrupt();
    const result = await get(v, QUERY('foodCategory=noodles'));
    assert.equal(result.response.status, 503, label);
    assert.deepEqual(result.body, { error: { code: 'menu-catalogue-unavailable' } }, label);
    assert.equal(/simulated|lobster|Different Name|ghost|task7-menu-v2|someone-elses/.test(result.response.html), false, label + ' leaks no row content');
    assert.equal(await batchOf(v), before, label + ' preserves the previous batch and tokens');
  }
  db.menuRows = original;
  db.menuUnfiltered = false;
  assert.equal((await get(v, QUERY('foodCategory=noodles'))).response.status, 200);
});

test('a menu read failure, or a fallback catalogue, returns a recoverable 503 on every route and spends no Google call', async () => {
  const v = http.visitor();
  await get(v, QUERY());
  const before = await batchOf(v);
  db.menuFailing = true;
  const demo = await get(v, QUERY('foodCategory=rice'));
  assert.equal(demo.response.status, 503);
  assert.deepEqual(demo.body, { error: { code: 'menu-catalogue-unavailable' } });
  assert.equal(/simulated|database/i.test(demo.response.html), false);
  const nlResult = await natural(v, { text: 'chicken' }, reply({ dishTerms: ['chicken'] }));
  assert.equal(nlResult.response.status, 503);
  assert.equal(nlResult.body.error.code, 'menu-catalogue-unavailable');
  routeCalls.length = 0;
  const liveResult = await live(v, { foodCategory: 'wraps' });
  assert.equal(liveResult.response.status, 503);
  assert.equal(liveResult.body.error.code, 'menu-catalogue-unavailable');
  assert.equal(routeCalls.length, 0, 'the menu is read before any Google request');
  assert.equal(await batchOf(v), before);
  // Without a food requirement the menu is not needed and everything still works.
  assert.equal((await get(v, QUERY())).response.status, 200);
  assert.equal((await get(v, QUERY('dietaryPreference=halal'))).response.status, 200);
  db.menuFailing = false;
  db.catalogueFailing = true;
  const fallback = await get(http.visitor(), QUERY('foodCategory=rice'));
  assert.equal(fallback.response.status, 503, 'the demo fallback catalogue has no grounded menu');
  assert.equal((await get(http.visitor(), QUERY())).response.status, 200);
});

// ---------------------------------------------------------------------------
// Legacy compatibility
// ---------------------------------------------------------------------------
test('legacy Step 3 and Step 5 requests behave exactly as before', async () => {
  const legacy = await get(http.visitor(), QUERY('cuisine=rice&dietaryPreference=vegan'));
  assert.equal(legacy.response.status, 200);
  assert.deepEqual(Object.keys(legacy.body), ['recommendations', 'catalogue', 'metadata']);
  assert.deepEqual(Object.keys(legacy.body.metadata), ['request', 'distance', 'activity', 'feedback']);
  legacy.body.recommendations.forEach(card => {
    assert.equal(card.recommendedMenuItem, undefined);
    assert.equal(card.typicalPrice, undefined);
  });
  assert.equal(menuCalls().length, 0);
  // cuisine stays a soft preference: a rice preference does not remove non-rice vegan merchants.
  assert.ok(legacy.body.recommendations.some(card => card.cuisine === 'healthy-food'));
  // foodCategory is validated; conflicts with a different concrete legacy cuisine are reported.
  const badValue = await get(http.visitor(), QUERY('foodCategory=pasta'));
  assert.equal(badValue.response.status, 400);
  assert.deepEqual(badValue.body.error.fields, { foodCategory: 'unsupported-value' });
  const conflict = await get(http.visitor(), QUERY('cuisine=rice&foodCategory=noodles'));
  assert.equal(conflict.response.status, 400);
  assert.deepEqual(conflict.body.error.fields, { cuisine: 'conflicts-with-foodCategory' });
  assert.equal((await get(http.visitor(), QUERY('cuisine=rice&foodCategory=rice'))).response.status, 200);
  assert.equal((await get(http.visitor(), QUERY('cuisine=soup&foodCategory=noodles'))).response.status, 200);
  assert.equal((await get(http.visitor(), QUERY('cuisine=any&foodCategory=wraps'))).response.status, 200);
  // The strict interpretation contract accepts exactly the original 8 keys or exactly the v2 10 keys.
  const v1 = { budgetMax: 8, distance: null, cuisine: 'rice', dietary: null, dayRef: null, time: null, mealPeriod: null, unsupported: [] };
  const accepted = nl.validateInterpretation(JSON.stringify(v1));
  assert.deepEqual([accepted.foodCategory, accepted.dishTerms], [null, []]);
  assert.equal(accepted.cuisine, 'rice');
  assert.equal(nl.validateInterpretation(JSON.stringify(reply({ budgetMax: 8 }))).dishTerms.length, 0);
  for (const content of [Object.assign({}, v1, { foodCategory: null }), Object.assign({}, v1, { dishTerms: [] }),
    Object.assign(reply(), { extra: 1 }), (() => { const r = reply(); delete r.dishTerms; return r; })()]) {
    assert.throws(() => nl.validateInterpretation(JSON.stringify(content)), error => error.code === 'natural-language-invalid-output');
  }
  // A legacy Step 5 reply (8 keys) still works end to end and keeps its soft cuisine meaning.
  const old = await natural(http.visitor(), { text: 'rice under 8' }, v1);
  assert.equal(old.response.status, 200);
  assert.equal(old.body.metadata.request.cuisinePreference, 'rice');
  assert.equal(old.body.metadata.menu, undefined);
});

// ---------------------------------------------------------------------------
// Existing behaviour is preserved around the menu
// ---------------------------------------------------------------------------
test('activity, durable feedback, deterministic order and live walking filters still apply', async () => {
  const first = await get(http.visitor(), QUERY('foodCategory=rice'));
  const second = await get(http.visitor(), QUERY('foodCategory=rice'));
  assert.deepEqual(ids(first.body.recommendations), ids(second.body.recommendations));
  assert.deepEqual(first.body.recommendations.map(c => c.recommendedMenuItem.itemId), second.body.recommendations.map(c => c.recommendedMenuItem.itemId));
  assert.equal(first.body.metadata.activity.status, 'available');
  first.body.recommendations.forEach(card => assert.ok(card.usualActivity));
  assert.equal(first.body.metadata.feedback.status, 'applied');

  // Step 4: an exact rejection still excludes the merchant from later food requests.
  const v = http.visitor();
  const cards = (await get(v, QUERY('foodCategory=rice'))).body.recommendations;
  const target = cards[0];
  assert.equal((await v.request('/recommendation/reject', { merchantId: target.id, feedbackToken: target.feedbackToken,
    reason: 'too-far' }, { 'X-Requested-With': 'smart-match' })).status, 204);
  const after = (await get(v, QUERY('foodCategory=rice'))).body.recommendations;
  assert.equal(ids(after).includes(target.id), false);
  assert.ok(after.length >= 2);

  // Step 6: only wrap merchants are routed, one matrix request, and the walking limit still narrows.
  routeTable = { 'northside-wraps': 100, 'green-bowl': 200, 'vegan-zen-kitchen': 3000 };
  const walking = await live(http.visitor(), { foodCategory: 'wraps', maxDistance: 5 });
  assert.equal(walking.response.status, 200);
  assert.equal(routeCalls.length, 1);
  assert.equal(routeCalls[0].destinations.length, 3, 'only merchants with a grounded wrap are routed');
  assert.deepEqual(ids(walking.body.recommendations).sort(), ['green-bowl', 'northside-wraps']);
  walking.body.recommendations.forEach(card => {
    assert.equal(card.distanceMetres, null);
    assert.ok(card.travel.walkingMinutes <= 5);
    assert.ok(card.recommendedMenuItem.categories.includes('wraps'));
  });
  assert.equal(walking.body.metadata.travel.requestedDestinations, 3);
  // Food matching cannot restore a merchant removed by the walking limit.
  assert.equal(ids(walking.body.recommendations).includes('vegan-zen-kitchen'), false);
});

// ---------------------------------------------------------------------------
// Journey truth: a recommendation is never a purchase
// ---------------------------------------------------------------------------
test('cards two and three carry the recommended item through Scan and payment review without changing payment mechanics', async () => {
  for (const index of [1, 2]) {
    resetMerchantCampaigns();
    const v = http.visitor();
    const cards = (await get(v, QUERY('foodCategory=rice'))).body.recommendations;
    const card = cards[index];
    assert.ok(card);
    assert.equal((await v.request('/recommendation/accept', { merchantId: card.id })).location, '/scan');
    const state = (await v.state()).demo;
    assert.equal(state.selectedMerchantSnapshot.recommendedMenuItem.itemId, card.recommendedMenuItem.itemId);
    assert.equal(state.selectedMerchantSnapshot.price, card.price, 'the typical price is unchanged in the snapshot');
    const home = (await v.request('/home')).html;
    assert.match(home, new RegExp('Recommended: ' + card.recommendedMenuItem.name.replace(/[&()]/g, '.')));
    const scan = (await v.request('/scan')).html;
    assert.match(scan, /data-recommended-item/);
    assert.match(scan, /not a record of what you bought/);
    assert.equal((await v.request('/scan', { merchantId: card.id })).status, 302);
    const journey = (await v.state()).demo.currentScanPayment;
    assert.equal(journey.merchantSnapshot.recommendedMenuItem.name, card.recommendedMenuItem.name);
    const review = (await v.request('/scan/payment')).html;
    assert.ok(review.includes('Recommended: ' + card.recommendedMenuItem.name.replace(/&/g, '&amp;')));
    assert.match(review, /fictional sample item/i);
    assert.match(review, /not a record of what you bought/);
    // The amount, reward and counters come only from what the user enters and the campaign terms.
    const campaign = getMerchantCampaigns().find(c => c.merchantId === card.id);
    const amount = (campaign.minimumEligibleSpend + 1).toFixed(2);
    const paid = await v.request('/scan/payment', { journeyId: journey.id, amount });
    assert.match(paid.location, /^\/payment-success\/tx-/);
    const finalState = (await v.state()).demo;
    const tx = finalState.transactions[0];
    assert.equal(tx.purchaseAmount, Number(amount));
    assert.equal(tx.merchantRewardEarned, campaign.rewardAmount);
    assert.equal(tx.itemName, null, 'a recommendation never sets the purchased item');
    assert.equal(/recommendedMenuItem|Recommended/.test(JSON.stringify(tx)), false);
    const receipt = (await v.request('/payment-success/' + tx.id)).html;
    assert.equal(/Recommended:|recommendedMenuItem/.test(receipt), false);
    assert.equal((await v.request('/vouch/' + tx.id, { action: 'create' })).status, 302);
    const after = (await v.state()).demo;
    assert.equal(/recommendedMenuItem|Recommended/.test(JSON.stringify(after.paymentVerifiedVouches)), false);
    assert.equal(/recommendedMenuItem/.test(JSON.stringify(after.transactions)), false);
    const offer = after.paymentVerifiedVouches[0];
    const shared = (await http.visitor().request('/offers/' + offer.shareToken));
    assert.equal(/Recommended:|recommendedMenuItem/.test(shared.html), false, 'shared offers never carry the recommendation');
  }
  // A rejected card also works with the exact token, and a stale token does not.
  const w = http.visitor();
  const batch = (await get(w, QUERY('foodCategory=noodles'))).body.recommendations;
  assert.equal((await w.request('/recommendation/reject', { merchantId: batch[1].id, feedbackToken: batch[1].feedbackToken,
    reason: 'too-expensive' }, { 'X-Requested-With': 'smart-match' })).status, 204);
  assert.equal((await w.request('/recommendation/reject', { merchantId: batch[2].id, feedbackToken: batch[1].feedbackToken,
    reason: 'too-expensive' })).status, 409);
});

test('accepting is judged by the exact recommended item, not the typical price', async () => {
  const v = http.visitor();
  const cards = (await get(v, QUERY('foodCategory=noodles&dietaryPreference=vegan&budget=9'))).body.recommendations;
  assert.deepEqual(ids(cards), ['vegan-zen-kitchen']);
  // Typical $9.50 is over the $9 budget, the item ($8.50) is not: accepting works.
  assert.equal((await v.request('/recommendation/accept', { merchantId: 'vegan-zen-kitchen' })).location, '/scan');
  // An item that no longer fits the batch budget is refused.
  await v.change(demo => { demo.catalogueBatchProfile.budget = 8; });
  assert.match((await v.request('/recommendation/accept', { merchantId: 'vegan-zen-kitchen' })).location, /error=offer/);
  await v.change(demo => { demo.catalogueBatchProfile.budget = 9; demo.catalogueBatchProfile.dietaryPreference = 'vegan';
    const merchant = demo.catalogueBatch[0]; merchant.recommendedMenuItem.dietary.vegan = false; merchant.recommendedMenuItem.dietary.vegetarian = true; });
  assert.match((await v.request('/recommendation/accept', { merchantId: 'vegan-zen-kitchen' })).location, /error=offer/);
});

test('Reset Demo clears the recommended item with the rest of the journey', async () => {
  const v = http.visitor();
  const cards = (await get(v, QUERY('foodCategory=wraps'))).body.recommendations;
  await v.request('/recommendation/accept', { merchantId: cards[0].id });
  assert.ok((await v.state()).demo.selectedMerchantSnapshot.recommendedMenuItem);
  assert.equal((await v.request('/reset-demo', {})).status, 302);
  const state = (await v.state()).demo;
  assert.deepEqual(state.catalogueBatch, []);
  assert.equal(state.selectedMerchantSnapshot, null);
  assert.equal(/recommendedMenuItem/.test(JSON.stringify(state)), false);
});

test('no Task 7 request writes to the database or calls a provider other than the language model', async () => {
  db.calls.length = 0;
  await get(http.visitor(), QUERY('foodCategory=rice&dietaryPreference=halal'));
  await natural(http.visitor(), { text: 'chicken' }, reply({ dishTerms: ['chicken'] }));
  assert.equal(db.calls.some(call => /^\s*(INSERT|UPDATE|DELETE|REPLACE|ALTER|DROP|CREATE|TRUNCATE)\b/i.test(call.sql)), false);
  assert.equal(groqCalls.length, 1);
  assert.equal(routeCalls.length, 0);
  // The language model never receives menu data, prices, merchants or chip values.
  const sent = JSON.stringify(groqCalls[0]);
  for (const secret of ['Roasted Chicken Rice', 'felicia', '$5.00', 'merchant_menu', 'recommendedMenuItem']) assert.equal(sent.includes(secret), false, secret);
});
