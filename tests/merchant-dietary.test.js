const test = require('node:test');
const assert = require('node:assert/strict');
const { app, demoStore, createInitialDemo, getNearbyMerchants, getSmartRecommendation, getEligibleMerchants,
  getDietaryMatchState, MATCH_STATE, clearDiscoveryCache, clearSearchIntentCache,
  resetMerchantCampaigns, getMerchantCampaigns, applyDietaryPolicyForTest,
  merchantDietaryCapabilitiesForTest, resultDietaryTagForTest } = require('../app');

// Merchant-declared dietary options. Dietary suitability comes from ONE place: what a registered
// NETS Vouch merchant listed in its own settings. There is no web research and no AI dietary
// analysis any more, so these tests never need a research provider at all.
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
// A curated platform merchant whose shipped data lists NOTHING, so every test sets its own options.
const PLATFORM_ID = 'woodlands-noodle-bar';

function visitor() {
  let cookie = '';
  return { async request(path, body, form) {
    const response = await originalFetch(base + path, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'manual',
      headers: { Cookie: cookie, ...(body === undefined ? {} : {
        'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json' }) },
      body: body === undefined ? undefined : (form ? new URLSearchParams(body).toString() : JSON.stringify(body))
    });
    const header = response.headers.get('set-cookie');
    if (header) cookie = header.split(';')[0];
    return { status: response.status, location: response.headers.get('location'), html: await response.text() };
  },
  sessionId() { return decodeURIComponent(cookie.split('=')[1]).slice(2).split('.')[0]; },
  async state() {
    const id = this.sessionId();
    const stored = await new Promise(function(resolve, reject) {
      demoStore.get(id, function(error, data) { if (error) reject(error); else resolve(data); });
    });
    return stored.demo;
  } };
}

function campaignOf(merchantId) {
  return getMerchantCampaigns().find(function(c) { return c.merchantId === merchantId; });
}
// The curated demo merchants ship with their own dietary lists, which seed their settings. Tests
// start from a clean slate so each one controls exactly what is listed.
function clearAllCapabilities() {
  getMerchantCampaigns().forEach(function(c) {
    c.dietaryCapabilities = { halal: false, vegetarian: false, vegan: false };
  });
}
function setCapabilities(merchantId, capabilities) {
  campaignOf(merchantId).dietaryCapabilities = Object.assign({ halal: false, vegetarian: false, vegan: false }, capabilities);
}
function platformMerchant(id) {
  return { id: id || PLATFORM_ID, merchantId: id || PLATFORM_ID, merchantName: 'Woodlands Noodle Bar',
    source: 'local-fallback', dietary: [], available: true, price: 6.8, distanceMinutes: 4, category: 'noodles',
    coordinates: { latitude: 1.4418, longitude: 103.7838 } };
}
function place(id, name, metres) {
  return { id: id, displayName: { text: name }, primaryType: 'restaurant',
    types: ['restaurant', 'food', 'point_of_interest', 'establishment'],
    formattedAddress: '1 Example Road, Singapore 738010',
    location: { latitude: ORIGIN.latitude + metres / M, longitude: ORIGIN.longitude } };
}

// Google discovery plus every former research provider, so any research call would be visible.
function mockProviders(options) {
  options = options || {};
  const calls = { nearby: 0, text: [], tavily: 0, groq: 0, openai: 0, dietaryAnalysis: 0 };
  global.fetch = async function(url, init) {
    const target = String(url);
    const host = new URL(target).hostname;
    if (host === '127.0.0.1') return originalFetch(url, init);
    const body = init && init.body ? JSON.parse(init.body) : {};
    if (target.endsWith(':searchNearby')) {
      calls.nearby += 1;
      return { ok: true, json: async function() { return { places: options.nearby || [] }; } };
    }
    if (target.endsWith(':searchText')) {
      calls.text.push(body.textQuery);
      return { ok: true, json: async function() { return { places: (options.text || {})[body.textQuery] || [] }; } };
    }
    if (host === 'api.tavily.com') { calls.tavily += 1; return { ok: false, status: 500 }; }
    // Any AI call is counted, and separately flagged if it were ever a DIETARY analysis prompt -
    // that system prompt no longer exists, so the flag must stay at zero.
    // The removed dietary analyser had its own system prompt; the ranking prompt legitimately
    // mentions the restriction, so only that exact marker counts as dietary research.
    const system = body.messages && body.messages[0] ? String(body.messages[0].content) : '';
    if (system.indexOf('You verify ONE dietary requirement') !== -1) calls.dietaryAnalysis += 1;
    if (host === 'api.groq.com') { calls.groq += 1; return { ok: false, status: 500 }; }
    if (host === 'api.openai.com') { calls.openai += 1; return { ok: false, status: 500 }; }
    return { ok: false, status: 404 };
  };
  return calls;
}

// 1 --------------------------------------------------------------------------------------------
test('DIET 1: all three checkboxes save independently, and several can be selected at once', async function() {
  const v = visitor();
  await v.request('/home');
  // Shipped demo data seeds this merchant's own list (vegetarian); everything else starts off.
  assert.deepEqual(campaignOf(PLATFORM_ID).dietaryCapabilities, { halal: false, vegetarian: true, vegan: false });
  clearAllCapabilities();
  const page = await v.request('/merchant?merchantId=' + PLATFORM_ID);
  assert.match(page.html, /name="halal" type="checkbox"|type="checkbox" name="halal"/);
  assert.match(page.html, /type="checkbox" name="vegetarian"/);
  assert.match(page.html, /type="checkbox" name="vegan"/);
  assert.match(page.html, /Vegetarian options available/);
  assert.match(page.html, /Vegan options available/);

  // One box.
  let saved = await v.request('/merchant/dietary', { merchantId: PLATFORM_ID, halal: 'on' }, true);
  assert.equal(saved.status, 302);
  assert.match(saved.location, /saved=dietary/);
  assert.deepEqual(campaignOf(PLATFORM_ID).dietaryCapabilities, { halal: true, vegetarian: false, vegan: false });

  // Several boxes at once.
  await v.request('/merchant/dietary', { merchantId: PLATFORM_ID, halal: 'on', vegetarian: 'on', vegan: 'on' }, true);
  assert.deepEqual(campaignOf(PLATFORM_ID).dietaryCapabilities, { halal: true, vegetarian: true, vegan: true });
  const after = await v.request('/merchant?merchantId=' + PLATFORM_ID + '&saved=dietary');
  ['halal', 'vegetarian', 'vegan'].forEach(function(key) {
    assert.match(after.html, new RegExp('name="' + key + '" checked'), key + ' comes back ticked');
  });
  assert.match(after.html, /Dietary options saved\./);

  // Unticking is a real change: an absent box means false.
  await v.request('/merchant/dietary', { merchantId: PLATFORM_ID, vegetarian: 'on' }, true);
  assert.deepEqual(campaignOf(PLATFORM_ID).dietaryCapabilities, { halal: false, vegetarian: true, vegan: false });
});

// 2 --------------------------------------------------------------------------------------------
test('DIET 2: Halal, vegetarian and vegan matching rules, including vegan for a vegetarian diner', async function() {
  const merchant = platformMerchant();
  setCapabilities(PLATFORM_ID, { halal: true });
  assert.equal(getDietaryMatchState(merchant, 'halal'), MATCH_STATE.MATCH);
  assert.equal(getDietaryMatchState(merchant, 'vegetarian'), MATCH_STATE.UNKNOWN);
  assert.equal(getDietaryMatchState(merchant, 'vegan'), MATCH_STATE.UNKNOWN);

  setCapabilities(PLATFORM_ID, { vegetarian: true });
  assert.equal(getDietaryMatchState(merchant, 'vegetarian'), MATCH_STATE.MATCH);
  assert.equal(getDietaryMatchState(merchant, 'vegan'), MATCH_STATE.UNKNOWN, 'vegetarian is not vegan');
  assert.equal(getDietaryMatchState(merchant, 'halal'), MATCH_STATE.UNKNOWN);

  // Vegan satisfies BOTH a vegan and a vegetarian preference.
  setCapabilities(PLATFORM_ID, { vegan: true });
  assert.equal(getDietaryMatchState(merchant, 'vegan'), MATCH_STATE.MATCH);
  assert.equal(getDietaryMatchState(merchant, 'vegetarian'), MATCH_STATE.MATCH, 'a vegan kitchen suits a vegetarian');
  assert.equal(getDietaryMatchState(merchant, 'halal'), MATCH_STATE.UNKNOWN);
});

// 3 --------------------------------------------------------------------------------------------
test('DIET 3: an external Places merchant is never treated as having listed anything', async function() {
  const external = { id: 'google-x', merchantId: 'google-x', merchantName: 'Halal Paradise Kitchen',
    source: 'GOOGLE', dietary: [], available: true, distanceMinutes: 3, category: 'google.place',
    categoryNames: ['Halal Restaurant'], primaryType: 'halal_restaurant' };
  assert.deepEqual(merchantDietaryCapabilitiesForTest(external), { halal: false, vegetarian: false, vegan: false });
  ['halal', 'vegetarian', 'vegan'].forEach(function(diet) {
    assert.equal(getDietaryMatchState(external, diet), MATCH_STATE.UNKNOWN,
      'a name, cuisine or Google category is never a declaration');
  });
  // An ID that belongs to no known merchant account writes nothing at all.
  const v = visitor();
  await v.request('/home');
  const rejected = await v.request('/merchant/dietary', { merchantId: 'google-x', halal: 'on' }, true);
  assert.match(rejected.location, /error=dietary/);
  assert.equal(campaignOf('google-x'), undefined, 'and no record is conjured for it');
});

// 4 --------------------------------------------------------------------------------------------
test('DIET 4: dietary matching makes ZERO research-provider calls and answers immediately', async function() {
  process.env.GOOGLE_PLACES_API_KEY = 'test-google';
  process.env.TAVILY_API_KEY = 'test-tavily';
  process.env.GROQ_API_KEY = 'test-groq';
  process.env.OPENAI_API_KEY = 'test-openai';
  clearAllCapabilities();
  setCapabilities(PLATFORM_ID, { halal: true });
  const calls = mockProviders({ text: { 'halal food': [place('ext', 'External Stall', 150)] }, nearby: [] });
  const demo = createInitialDemo('jia');
  demo.profile.dietaryPreference = 'halal';
  demo.profile.maxDistanceMinutes = 30;
  const started = Date.now();
  const nearby = await getNearbyMerchants(ORIGIN, 'jia', '', 30, 'halal');
  const result = await getSmartRecommendation(demo.profile, nearby.merchants, [], [], demo, []);
  const elapsed = Date.now() - started;
  assert.equal(result.merchant.id, PLATFORM_ID, 'the merchant that listed Halal is the match');
  assert.equal(calls.tavily, 0, 'no Tavily call of any kind');
  assert.equal(calls.dietaryAnalysis, 0, 'no dietary AI analysis (the ranking call is unrelated)');
  assert.ok(elapsed < 1000, 'and it is immediate: ' + elapsed + ' ms');
  assert.equal(result.merchant.research, undefined, 'no research state exists at all');
  // And the dietary analyser prompt is gone from the codebase entirely.
  const source = require('fs').readFileSync(require('path').join(__dirname, '..', 'app.js'), 'utf8');
  assert.ok(!/You verify ONE dietary requirement|api\.tavily\.com|muis\.gov\.sg/i.test(source),
    'no dietary research prompt, Tavily endpoint or MUIS lookup remains in app.js');
});

// 5 --------------------------------------------------------------------------------------------
test('DIET 5: the customer card shows the listed option and the merchant-provided note', async function() {
  clearAllCapabilities();
  setCapabilities(PLATFORM_ID, { halal: true, vegan: true });
  const v = visitor();
  await v.request('/home');
  await v.request('/profile/dietary', { dietaryPreference: 'halal' });
  await v.request('/smart-match/location', { status: 'fallback' });
  const card = await v.request('/smart-match/result');
  assert.match(card.html, new RegExp('data-merchant-id="' + PLATFORM_ID + '"'));
  assert.match(card.html, /diet-tag diet-tag--halal">Halal</, 'the badge is just "Halal"');
  assert.match(card.html, /Dietary information provided by the merchant\./);
  // None of the removed dietary-verification language may appear.
  assert.ok(!/MUIS|Muslim-owned|certification not verified|Potential Halal|Halal verified/i.test(card.html),
    'no verification or certification language survives');
  // A vegetarian diner matched by the vegan listing sees the option actually listed.
  assert.deepEqual(resultDietaryTagForTest(platformMerchant(), 'vegetarian'),
    { tone: 'vegan', label: 'Vegan options', note: 'Dietary information provided by the merchant.' });
});

// 6 --------------------------------------------------------------------------------------------
test('DIET 6: a listed merchant outside the chosen walking distance is excluded', async function() {
  process.env.GOOGLE_PLACES_API_KEY = 'test-google';
  clearAllCapabilities();
  setCapabilities(PLATFORM_ID, { halal: true });
  // Live discovery returns a usable merchant, so the real pool is in play (not the offline demo
  // fallback). The curated merchant sits near Woodlands.
  mockProviders({ text: { 'halal food': [place('ext', 'External Stall', 150)] }, nearby: [] });
  const near = await getNearbyMerchants(ORIGIN, 'jia', '', 30, 'halal');
  const inRange = near.merchants.find(function(m) { return m.id === PLATFORM_ID; });
  assert.ok(inRange, 'within the walking limit it is merged into the pool');
  assert.ok(Number.isFinite(inRange.distanceMetres) && inRange.distanceMetres < 30 * 80,
    'with the REAL distance from the visitor, not the curated placeholder');

  // Same merchant, visitor far away and a 10-minute limit: it must not be offered at all. The live
  // result is placed next to the FAR visitor so discovery still succeeds there.
  clearDiscoveryCache();
  const faraway = { latitude: 1.2800, longitude: 103.8500 };
  mockProviders({ text: { 'halal food': [{ id: 'ext', displayName: { text: 'External Stall' },
    primaryType: 'restaurant', types: ['restaurant', 'food'], formattedAddress: '1 City Road, Singapore 059000',
    location: { latitude: faraway.latitude + 150 / M, longitude: faraway.longitude } }] }, nearby: [] });
  const far = await getNearbyMerchants(faraway, 'jia', '', 10, 'halal');
  assert.ok(!far.merchants.some(function(m) { return m.id === PLATFORM_ID; }),
    'beyond the walking limit it is not offered at all');
  assert.ok(far.merchants.some(function(m) { return m.id === 'google-ext'; }),
    'while the live results are unaffected');
});

// 7 --------------------------------------------------------------------------------------------
test('DIET 7: removing the listing immediately removes eligibility', async function() {
  const v = visitor();
  await v.request('/home');
  await v.request('/merchant/dietary', { merchantId: PLATFORM_ID, halal: 'on' }, true);
  const merchant = platformMerchant();
  assert.equal(getDietaryMatchState(merchant, 'halal'), MATCH_STATE.MATCH);
  // Submitting with no boxes ticked clears every option.
  await v.request('/merchant/dietary', { merchantId: PLATFORM_ID }, true);
  assert.deepEqual(campaignOf(PLATFORM_ID).dietaryCapabilities, { halal: false, vegetarian: false, vegan: false });
  assert.equal(getDietaryMatchState(merchant, 'halal'), MATCH_STATE.UNKNOWN);
  const demo = createInitialDemo('jia');
  demo.profile.dietaryPreference = 'halal';
  const gate = applyDietaryPolicyForTest(getEligibleMerchants(demo.profile, [merchant], [], demo), 'halal');
  assert.equal(gate.candidates.length, 0);
  assert.equal(gate.noDeclaredMatch, true);
});

// 8 --------------------------------------------------------------------------------------------
test('DIET 8: with nothing listed nearby the app says exactly that, and offers the filters', async function() {
  process.env.GOOGLE_PLACES_API_KEY = 'test-google';
  // Every platform merchant lists nothing, and the external results can never count.
  getMerchantCampaigns().forEach(function(c) {
    c.dietaryCapabilities = { halal: false, vegetarian: false, vegan: false };
  });
  mockProviders({ text: { 'halal food': [place('ext', 'External Stall', 150)] }, nearby: [] });
  const v = visitor();
  await v.request('/home');
  await v.request('/profile/dietary', { dietaryPreference: 'halal' });
  await v.request('/location', { latitude: String(ORIGIN.latitude), longitude: String(ORIGIN.longitude) });
  const page = await v.request('/smart-match/result');
  assert.match(page.html, /No nearby merchants have listed this dietary option yet\./);
  assert.match(page.html, /Adjust filters/, 'the user can still change their filters');
  assert.ok(!/no suitable restaurants|No spots nearby/i.test(page.html),
    'it never claims that no suitable restaurants exist');
  assert.ok(!/data-merchant-id=/.test(page.html), 'and no external merchant is passed off as a match');
});

// 9 --------------------------------------------------------------------------------------------
test('DIET 9: unrelated Smart Match ranking still works with no dietary preference', async function() {
  process.env.GOOGLE_PLACES_API_KEY = 'test-google';
  process.env.OPENAI_API_KEY = 'test-openai';
  let rankPrompt = '';
  const base = mockProviders({ text: { 'crispy chicken': [place('a', 'Crispy Chicken House', 120),
    place('b', 'Far Noodle Bar', 900)] }, nearby: [] });
  const withRanker = global.fetch;
  global.fetch = async function(url, init) {
    const body = init && init.body ? JSON.parse(init.body) : {};
    if (new URL(String(url)).hostname === 'api.openai.com') {
      rankPrompt = body.messages.map(function(m) { return m.content; }).join('\n');
      return { ok: true, json: async function() {
        return { choices: [{ message: { content: JSON.stringify({ merchantId: 'google-a', relevance: 'high',
          budgetFit: 'unknown', reason: 'Its Chicken Restaurant category fits your craving.' }) } }] };
      } };
    }
    return withRanker(url, init);
  };
  const demo = createInitialDemo('jia');
  demo.profile.craving = 'crispy chicken';
  demo.profile.maxDistanceMinutes = 30;
  const nearby = await getNearbyMerchants(ORIGIN, 'jia', 'crispy chicken', 30, 'none');
  const result = await getSmartRecommendation(demo.profile, nearby.merchants, [], [], demo, []);
  assert.equal(result.merchant.id, 'google-a', 'craving ranking is untouched');
  assert.equal(result.reason, 'Its Chicken Restaurant category fits your craving.');
  assert.ok(rankPrompt.includes('crispy chicken'), 'the craving still reaches the ranker');
  assert.ok(!/dietaryStatus":"verified/.test(rankPrompt), 'and no dietary verification claim is sent');
  assert.equal(base.tavily, 0);
});

// ---------------------------------------------------------------------------------------------
// EXTERNAL MERCHANT ACCOUNTS - a discovered Google/Foursquare merchant is manageable too
// ---------------------------------------------------------------------------------------------

const EXTERNAL_PLACE = 'ChIJExternalPlaceIdForTesting';
const EXTERNAL_ID = 'google-' + EXTERNAL_PLACE;
const EXTERNAL_NAME = 'Nasi Padang Corner';

function externalPlace(metres, name) {
  return { id: EXTERNAL_PLACE, displayName: { text: name || EXTERNAL_NAME }, primaryType: 'restaurant',
    types: ['restaurant', 'food', 'point_of_interest', 'establishment'],
    formattedAddress: '2 Example Road, Singapore 738020',
    location: { latitude: ORIGIN.latitude + (metres || 180) / M, longitude: ORIGIN.longitude } };
}

// Discovers the external merchant through the real Smart Match route, exactly as the manual flow does.
async function discoverExternal(v, options) {
  process.env.GOOGLE_PLACES_API_KEY = 'test-google';
  const calls = mockProviders(Object.assign({ nearby: [externalPlace()] }, options || {}));
  await v.request('/home');
  await v.request('/location', { latitude: String(ORIGIN.latitude), longitude: String(ORIGIN.longitude) });
  await v.request('/smart-match/result');
  return calls;
}

test('EXT 1: the Dietary options card renders for an external merchant, under the selector', async function() {
  const v = visitor();
  await discoverExternal(v);
  const page = await v.request('/merchant?merchantId=' + EXTERNAL_ID);
  assert.equal(page.status, 200);
  assert.match(page.html, new RegExp('<option value="' + EXTERNAL_ID + '"[^>]*selected'),
    'the discovered merchant is selectable');
  // All three checkboxes, with the exact labels.
  assert.match(page.html, /type="checkbox" name="halal"/);
  assert.match(page.html, /type="checkbox" name="vegetarian"/);
  assert.match(page.html, /type="checkbox" name="vegan"/);
  assert.match(page.html, /<span>Halal<\/span>/);
  assert.match(page.html, /<span>Vegetarian options available<\/span>/);
  assert.match(page.html, /<span>Vegan options available<\/span>/);
  assert.ok(!/checked/.test(page.html.slice(page.html.indexOf('dietary-checks'),
    page.html.indexOf('Save dietary options'))), 'nothing is ticked until the merchant saves');
  // Directly below the merchant selector: the dietary form comes before the campaign form.
  assert.ok(page.html.indexOf('action="/merchant/dietary"') > page.html.indexOf('class="merchant-picker"'),
    'the card sits below the selector');
  assert.ok(page.html.indexOf('action="/merchant/dietary"') < page.html.indexOf('action="/merchant/offer"'),
    'and above the campaign form, so it is immediately visible');
});

test('EXT 2: an external merchant saves several options into campaign.dietaryCapabilities', async function() {
  const v = visitor();
  await discoverExternal(v);
  const saved = await v.request('/merchant/dietary', { merchantId: EXTERNAL_ID, halal: 'on', vegetarian: 'on' }, true);
  assert.equal(saved.status, 302);
  assert.match(saved.location, /saved=dietary/);
  // Stored once, on the settings record keyed by the stable provider place ID.
  const campaign = campaignOf(EXTERNAL_ID);
  assert.ok(campaign, 'a settings record exists for the external merchant');
  assert.equal(campaign.merchantId, EXTERNAL_ID);
  assert.ok(campaign.merchantId.includes(EXTERNAL_PLACE), 'identified by provider place ID, not display name');
  assert.deepEqual(campaign.dietaryCapabilities, { halal: true, vegetarian: true, vegan: false });
  assert.deepEqual(merchantDietaryCapabilitiesForTest({ id: EXTERNAL_ID, source: 'GOOGLE' }),
    { halal: true, vegetarian: true, vegan: false });
  const page = await v.request('/merchant?merchantId=' + EXTERNAL_ID);
  assert.match(page.html, /name="halal" checked/);
  assert.match(page.html, /name="vegetarian" checked/);
  assert.ok(!/name="vegan" checked/.test(page.html));
});

test('EXT 3: the saved declaration survives tab switches, the customer view and a location change', async function() {
  const v = visitor();
  await discoverExternal(v);
  await v.request('/merchant/dietary', { merchantId: EXTERNAL_ID, vegan: 'on' }, true);
  const expected = { halal: false, vegetarian: false, vegan: true };

  // Campaign -> Results -> Campaign.
  const results = await v.request('/merchant?merchantId=' + EXTERNAL_ID + '&tab=results');
  assert.match(results.html, /name="vegan" checked/, 'kept on the Results tab');
  const campaignTab = await v.request('/merchant?merchantId=' + EXTERNAL_ID + '&tab=campaign');
  assert.match(campaignTab.html, /name="vegan" checked/, 'and back on the Campaign tab');

  // Back to the customer view, then a different location, then the merchant view again.
  await v.request('/home');
  await v.request('/location', { latitude: '1.3000', longitude: '103.8500' });
  await v.request('/smart-match/result');
  assert.deepEqual(campaignOf(EXTERNAL_ID).dietaryCapabilities, expected, 'unchanged by a location change');
  const again = await v.request('/merchant?merchantId=' + EXTERNAL_ID);
  assert.match(again.html, /name="vegan" checked/);
  assert.match(again.html, new RegExp('<option value="' + EXTERNAL_ID + '"'),
    'and the discovered merchant stays in the selector after moving');
});

test('EXT 4: rediscovering the same provider place ID reuses its saved settings', async function() {
  const v = visitor();
  await discoverExternal(v);
  await v.request('/merchant/dietary', { merchantId: EXTERNAL_ID, halal: 'on' }, true);
  const before = campaignOf(EXTERNAL_ID);
  before.rewardAmount = 1.23;                       // a campaign value, to prove the record is reused
  clearDiscoveryCache();
  // The same place comes back from the provider, with a different display name and distance.
  mockProviders({ nearby: [externalPlace(260, 'Nasi Padang Corner (Renamed)')] });
  await v.request('/location', { latitude: String(ORIGIN.latitude), longitude: String(ORIGIN.longitude) });
  await v.request('/smart-match/result');
  const after = campaignOf(EXTERNAL_ID);
  assert.equal(after, before, 'the same settings record, not a duplicate');
  assert.deepEqual(after.dietaryCapabilities, { halal: true, vegetarian: false, vegan: false });
  assert.equal(after.rewardAmount, 1.23);
  assert.equal(getMerchantCampaigns().filter(function(c) { return c.merchantId === EXTERNAL_ID; }).length, 1);
});

test('EXT 5: a declared external merchant becomes eligible; an undeclared one never does', async function() {
  const v = visitor();
  await discoverExternal(v);
  const external = { id: EXTERNAL_ID, merchantName: EXTERNAL_NAME, source: 'GOOGLE' };
  // Undeclared: ineligible for every preference, whatever it is called.
  ['halal', 'vegetarian', 'vegan'].forEach(function(diet) {
    assert.equal(getDietaryMatchState(external, diet), MATCH_STATE.UNKNOWN,
      'an undeclared external merchant is never eligible for ' + diet);
  });
  // Declared Halal: eligible for Halal only.
  await v.request('/merchant/dietary', { merchantId: EXTERNAL_ID, halal: 'on' }, true);
  assert.equal(getDietaryMatchState(external, 'halal'), MATCH_STATE.MATCH);
  assert.equal(getDietaryMatchState(external, 'vegetarian'), MATCH_STATE.UNKNOWN);
  assert.equal(getDietaryMatchState(external, 'vegan'), MATCH_STATE.UNKNOWN);
  // Declared vegan: satisfies vegan AND vegetarian.
  await v.request('/merchant/dietary', { merchantId: EXTERNAL_ID, vegan: 'on' }, true);
  assert.equal(getDietaryMatchState(external, 'vegan'), MATCH_STATE.MATCH);
  assert.equal(getDietaryMatchState(external, 'vegetarian'), MATCH_STATE.MATCH);
  assert.equal(getDietaryMatchState(external, 'halal'), MATCH_STATE.UNKNOWN);
});

test('EXT 6: a declared external merchant is recommended with its badge, and costs no research call', async function() {
  const v = visitor();
  // Another external merchant is nearer but declares nothing, so only the declared one may match.
  const calls = await discoverExternal(v, { nearby: [externalPlace(180), {
    id: 'OtherPlaceId', displayName: { text: 'Halal Sounding Stall' }, primaryType: 'restaurant',
    types: ['restaurant', 'food'], formattedAddress: '3 Example Road, Singapore 738030',
    location: { latitude: ORIGIN.latitude + 60 / M, longitude: ORIGIN.longitude } }] });
  clearAllCapabilities();
  await v.request('/merchant/dietary', { merchantId: EXTERNAL_ID, halal: 'on' }, true);
  process.env.TAVILY_API_KEY = 'test-tavily';
  await v.request('/profile/dietary', { dietaryPreference: 'halal' });
  await v.request('/home');
  const started = Date.now();
  const card = await v.request('/smart-match/result');
  const elapsed = Date.now() - started;
  assert.match(card.html, new RegExp('data-merchant-id="' + EXTERNAL_ID + '"'),
    'the external merchant that declared Halal is recommended');
  assert.ok(!/data-merchant-id="google-OtherPlaceId"/.test(card.html),
    'a halal-sounding NAME on an undeclared merchant is never eligible');
  assert.match(card.html, /diet-tag diet-tag--halal">Halal</);
  assert.match(card.html, /Dietary information provided by the merchant\./);
  assert.equal(calls.tavily, 0, 'no Tavily check for a merchant-provided declaration');
  assert.equal(calls.dietaryAnalysis, 0, 'and no dietary AI research');
  assert.ok(elapsed < 2000, 'and it stays fast: ' + elapsed + ' ms');
});

// ---------------------------------------------------------------------------------------------
// SHOWN HISTORY - changing the dietary preference restarts matching under the new filter
// ---------------------------------------------------------------------------------------------

test('HISTORY 1: a previously shown merchant becomes eligible again after the preference changes', async function() {
  const v = visitor();
  await discoverExternal(v);
  // Seen with no restriction, so it is in the shown history.
  const first = await v.request('/smart-match/result');
  const shownId = (first.html.match(/data-merchant-id="([^"]+)"/) || [])[1];
  assert.ok(shownId, 'a merchant was shown under "no restriction"');
  // Its merchant lists Halal; the customer then switches to Halal.
  clearAllCapabilities();
  await v.request('/merchant/dietary', { merchantId: shownId, halal: 'on' }, true);
  await v.request('/profile/dietary', { dietaryPreference: 'halal' });
  const after = await v.request('/smart-match/result');
  assert.match(after.html, new RegExp('data-merchant-id="' + shownId + '"'),
    'the same merchant may be shown again under the new filter');
  assert.match(after.html, /diet-tag diet-tag--halal">Halal</);
});

test('HISTORY 2: an explicitly rejected merchant stays excluded across the change', async function() {
  const v = visitor();
  const keeper = { id: 'KeeperPlaceId', displayName: { text: 'Keeper Stall' }, primaryType: 'restaurant',
    types: ['restaurant', 'food'], formattedAddress: '4 Example Road, Singapore 738040',
    location: { latitude: ORIGIN.latitude + 90 / M, longitude: ORIGIN.longitude } };
  await discoverExternal(v, { nearby: [externalPlace(180), keeper] });
  const first = await v.request('/smart-match/result');
  const rejectedId = (first.html.match(/data-merchant-id="([^"]+)"/) || [])[1];
  const otherId = rejectedId === EXTERNAL_ID ? 'google-KeeperPlaceId' : EXTERNAL_ID;
  await v.request('/recommendation/reject', { merchantId: rejectedId, reason: 'not-in-mood' });
  // BOTH merchants list Halal, so only the rejection can keep one of them out.
  clearAllCapabilities();
  await v.request('/merchant/dietary', { merchantId: rejectedId, halal: 'on' }, true);
  await v.request('/merchant/dietary', { merchantId: otherId, halal: 'on' }, true);
  await v.request('/profile/dietary', { dietaryPreference: 'halal' });
  const after = await v.request('/smart-match/result');
  assert.match(after.html, new RegExp('data-merchant-id="' + otherId + '"'),
    'the merchant that was only SHOWN is offered again under the new filter');
  assert.ok(!new RegExp('data-merchant-id="' + rejectedId + '"').test(after.html),
    '"not for me" is the customer\'s own judgement and survives the filter change');
  const state = await v.state();
  assert.deepEqual(state.rejectedMerchantIds, [rejectedId], 'the rejection is still recorded');
});

test('HISTORY 3: re-saving the SAME preference changes nothing', async function() {
  const v = visitor();
  const second = { id: 'SecondPlaceId', displayName: { text: 'Second Stall' }, primaryType: 'restaurant',
    types: ['restaurant', 'food'], formattedAddress: '5 Example Road, Singapore 738050',
    location: { latitude: ORIGIN.latitude + 240 / M, longitude: ORIGIN.longitude } };
  await discoverExternal(v, { nearby: [externalPlace(180), second] });
  await v.request('/profile/dietary', { dietaryPreference: 'halal' });
  // Two declared merchants, so a preserved history means the OTHER one is shown next.
  clearAllCapabilities();
  await v.request('/merchant/dietary', { merchantId: EXTERNAL_ID, halal: 'on' }, true);
  await v.request('/merchant/dietary', { merchantId: 'google-SecondPlaceId', halal: 'on' }, true);
  const shown = await v.request('/smart-match/result');
  const shownId = (shown.html.match(/data-merchant-id="([^"]+)"/) || [])[1];
  assert.ok(shownId, 'a declared merchant was shown');
  const historyBefore = (await v.state()).shownMerchantIds;

  // Saving the identical value must not reset the shown history.
  await v.request('/profile/dietary', { dietaryPreference: 'halal' });
  assert.deepEqual((await v.state()).shownMerchantIds, historyBefore, 'the shown history is preserved');
  const again = await v.request('/smart-match/result');
  assert.ok(!new RegExp('data-merchant-id="' + shownId + '"').test(again.html),
    'so the merchant already seen is not repeated');
});

test('HISTORY 4: the reset touches nothing but the shown list', async function() {
  const v = visitor();
  await discoverExternal(v);
  const card = await v.request('/smart-match/result');
  const merchantId = (card.html.match(/data-merchant-id="([^"]+)"/) || [])[1];
  // Real session state: an accepted match, a rejection, and the merchant's own declaration.
  await v.request('/recommendation/accept', { merchantId: merchantId });
  await v.request('/recommendation/reject', { merchantId: merchantId, reason: 'not-in-mood' });
  await v.request('/merchant/dietary', { merchantId: merchantId, vegan: 'on' }, true);
  const before = await v.state();
  assert.ok(before.shownMerchantIds.length > 0, 'something was shown');
  const declarationBefore = Object.assign({}, campaignOf(merchantId).dietaryCapabilities);

  await v.request('/profile/dietary', { dietaryPreference: 'vegan' });
  const after = await v.state();

  assert.deepEqual(after.shownMerchantIds, [], 'only the shown history is cleared');
  assert.deepEqual(after.rejectedMerchantIds, before.rejectedMerchantIds, 'rejections untouched');
  assert.deepEqual(after.recommendationFeedback, before.recommendationFeedback, 'rejection reasons untouched');
  assert.deepEqual(after.transactions, before.transactions, 'payment history untouched');
  assert.deepEqual(after.vouchClaims, before.vouchClaims, 'Vouch state untouched');
  assert.deepEqual(after.merchantCredits, before.merchantCredits, 'reward credits untouched');
  assert.deepEqual(after.user, before.user, 'the customer record is untouched');
  assert.deepEqual(campaignOf(merchantId).dietaryCapabilities, declarationBefore,
    'and the merchant\'s own declaration is untouched');
});

// ---------------------------------------------------------------------------------------------
// MERCHANT SETTINGS LAYOUT - the dietary checkboxes must not inherit the full-width field styling
// ---------------------------------------------------------------------------------------------

test('LAYOUT: the dietary checkbox CSS overrides width, min-height and padding from .field input', async function() {
  const css = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'css', 'style.css'), 'utf8');
  // The global rule that made them render as full-width boxes still exists for real text fields.
  const globalRule = (css.match(/^\.field input,\.field select \{[^}]*\}/m) || [])[0];
  assert.ok(globalRule, 'the global .field input rule is still present');
  assert.ok(/width:100%/.test(globalRule) && /min-height:48px/.test(globalRule) && /padding:12px/.test(globalRule));

  // The dietary checkbox rule is scoped to the card and overrides each of those properties.
  const scoped = (css.match(/\.dietary-card \.dietary-check input\[type="checkbox"\] \{[^}]*\}/) || [])[0];
  assert.ok(scoped, 'a scoped dietary checkbox rule exists');
  assert.match(scoped, /width:20px/, 'about 20px wide, not full width');
  assert.match(scoped, /height:20px/);
  assert.match(scoped, /min-height:0/, 'the 48px minimum is cancelled');
  assert.match(scoped, /padding:0/, 'the 12px padding is cancelled');
  assert.match(scoped, /flex:0 0 20px/, 'a fixed flex size, so it never stretches');
  assert.match(scoped, /accent-color:var\(--nets-red\)/, 'NETS red checked colour');

  // Compact, accessible rows: checkbox then label, tappable height, consistent spacing.
  const row = (css.match(/^\.dietary-check \{[^}]*\}/m) || [])[0];
  assert.ok(row && /display:flex/.test(row) && /align-items:center/.test(row));
  assert.match(row, /min-height:44px/, 'a 44px tappable row');
  assert.match(row, /gap:10px/, 'consistent spacing between box and label');
  assert.match(css, /\.dietary-checks \{[^}]*gap:8px/, '8px between option rows');
  assert.match(css, /\.dietary-card \.dietary-save \{[^}]*min-height:46px/, 'a normal mobile control height');
  assert.match(css, /\.dietary-card \.dietary-check input\[type="checkbox"\]:focus-visible \{/,
    'visible keyboard focus is kept');

  // No global input or form styling was touched, and the markup keeps native checkboxes.
  const view = require('fs').readFileSync(require('path').join(__dirname, '..', 'views', 'merchant.ejs'), 'utf8');
  assert.match(view, /class="card dietary-card"/, 'the card carries its own class');
  assert.ok(!/class="field"[^>]*>\s*<legend class="field-label">Dietary/.test(view),
    'the card no longer reuses the global .field styling');
  assert.equal((view.match(/type="checkbox"/g) || []).length, 1, 'one native checkbox input, rendered per option');
  assert.ok(!/role="checkbox"|<div[^>]*onclick/.test(view), 'no inaccessible div substitutes');
});

test('LAYOUT: the dietary card stays directly below the merchant selector at mobile width', async function() {
  const v = visitor();
  await discoverExternal(v);
  const page = await v.request('/merchant?merchantId=' + EXTERNAL_ID);
  const selector = page.html.indexOf('class="merchant-picker"');
  const card = page.html.indexOf('action="/merchant/dietary"');
  const campaign = page.html.indexOf('action="/merchant/offer"');
  assert.ok(selector < card && card < campaign, 'selector -> dietary card -> campaign form');
  // Each option is one label row wrapping one native checkbox plus its text.
  ['Halal', 'Vegetarian options available', 'Vegan options available'].forEach(function(label) {
    assert.match(page.html, new RegExp('<label class="dietary-check"><input type="checkbox" name="\\w+"[^>]*><span>' +
      label.replace(/[()]/g, '\\$&') + '</span></label>'), label + ' sits beside its checkbox');
  });
});

// ---------------------------------------------------------------------------------------------
// SAVE ISOLATION - one merchant's dietary save must never touch another merchant's record
// ---------------------------------------------------------------------------------------------

const MERCHANT_A = 'woodlands-noodle-bar';
const MERCHANT_B = 'green-bowl';

// Everything about a campaign except its dietary options, so "unchanged" can be asserted exactly.
function campaignFingerprint(merchantId) {
  const campaign = campaignOf(merchantId);
  const copy = Object.assign({}, campaign);
  delete copy.dietaryCapabilities;
  return JSON.stringify(copy);
}
function allOtherFingerprints(exceptIds) {
  return getMerchantCampaigns().filter(function(c) { return exceptIds.indexOf(c.merchantId) === -1; })
    .map(function(c) { return c.merchantId + '=' + JSON.stringify(c); }).sort();
}
function checkedBoxes(html) {
  const area = html.slice(html.indexOf('dietary-checks'), html.indexOf('Save dietary options'));
  return ['halal', 'vegetarian', 'vegan'].filter(function(key) {
    return new RegExp('name="' + key + '" checked').test(area);
  });
}

test('ISOLATION 1: saving one merchant never changes another merchant\'s options', async function() {
  const v = visitor();
  await v.request('/home');
  clearAllCapabilities();
  // Both start with nothing listed.
  const pageA0 = await v.request('/merchant?merchantId=' + MERCHANT_A);
  const pageB0 = await v.request('/merchant?merchantId=' + MERCHANT_B);
  assert.deepEqual(checkedBoxes(pageA0.html), [], 'Merchant A starts with no options');
  assert.deepEqual(checkedBoxes(pageB0.html), [], 'Merchant B starts with no options');
  const untouchedBefore = allOtherFingerprints([MERCHANT_A, MERCHANT_B]);
  const otherFieldsA = campaignFingerprint(MERCHANT_A);
  const otherFieldsB = campaignFingerprint(MERCHANT_B);

  // Save Halal for A only.
  await v.request('/merchant/dietary', { merchantId: MERCHANT_A, halal: 'on' }, true);
  assert.deepEqual(checkedBoxes((await v.request('/merchant?merchantId=' + MERCHANT_A)).html), ['halal'],
    'Merchant A shows Halal checked');
  assert.deepEqual(checkedBoxes((await v.request('/merchant?merchantId=' + MERCHANT_B)).html), [],
    'Merchant B is still completely unchecked');

  // Save Vegan for B only.
  await v.request('/merchant/dietary', { merchantId: MERCHANT_B, vegan: 'on' }, true);
  assert.deepEqual(checkedBoxes((await v.request('/merchant?merchantId=' + MERCHANT_B)).html), ['vegan'],
    'Merchant B shows Vegan only');
  assert.deepEqual(checkedBoxes((await v.request('/merchant?merchantId=' + MERCHANT_A)).html), ['halal'],
    'Merchant A still shows Halal only');

  // Stored state matches, and nothing else moved.
  assert.deepEqual(campaignOf(MERCHANT_A).dietaryCapabilities, { halal: true, vegetarian: false, vegan: false });
  assert.deepEqual(campaignOf(MERCHANT_B).dietaryCapabilities, { halal: false, vegetarian: false, vegan: true });
  assert.equal(campaignFingerprint(MERCHANT_A), otherFieldsA, 'no other field of A changed');
  assert.equal(campaignFingerprint(MERCHANT_B), otherFieldsB, 'no other field of B changed');
  assert.deepEqual(allOtherFingerprints([MERCHANT_A, MERCHANT_B]), untouchedBefore,
    'every other merchant record is byte-for-byte unchanged');
});

test('ISOLATION 2: each campaign owns its own capabilities object', async function() {
  const v = visitor();
  await v.request('/home');
  clearAllCapabilities();
  await v.request('/merchant/dietary', { merchantId: MERCHANT_A, halal: 'on' }, true);
  await v.request('/merchant/dietary', { merchantId: MERCHANT_B, halal: 'on' }, true);
  const a = campaignOf(MERCHANT_A).dietaryCapabilities;
  const b = campaignOf(MERCHANT_B).dietaryCapabilities;
  assert.deepEqual(a, b, 'same values...');
  assert.notEqual(a, b, '...but never the same object');
  // Mutating one must not be visible through the other.
  a.vegan = true;
  assert.equal(b.vegan, false, 'no shared reference between merchants');
  // Every campaign in the store has its own object.
  const seen = new Set();
  getMerchantCampaigns().forEach(function(c) {
    assert.ok(!seen.has(c.dietaryCapabilities), 'capabilities object reused by ' + c.merchantId);
    seen.add(c.dietaryCapabilities);
  });
});

test('ISOLATION 3: a missing or unknown merchant ID changes nothing and reports an error', async function() {
  const v = visitor();
  await v.request('/home');
  clearAllCapabilities();
  await v.request('/merchant/dietary', { merchantId: MERCHANT_A, halal: 'on' }, true);
  const before = getMerchantCampaigns().map(function(c) { return c.merchantId + '=' + JSON.stringify(c); }).sort();

  const missing = await v.request('/merchant/dietary', { halal: 'on' }, true);
  assert.equal(missing.status, 302);
  assert.match(missing.location, /error=dietary/);
  const unknown = await v.request('/merchant/dietary', { merchantId: 'google-DoesNotExist', vegan: 'on' }, true);
  assert.match(unknown.location, /error=dietary/);
  const blank = await v.request('/merchant/dietary', { merchantId: '   ', vegan: 'on' }, true);
  assert.match(blank.location, /error=dietary/);

  assert.deepEqual(getMerchantCampaigns().map(function(c) { return c.merchantId + '=' + JSON.stringify(c); }).sort(),
    before, 'not one record was touched');
  const page = await v.request('/merchant?merchantId=' + MERCHANT_A + '&error=dietary');
  assert.match(page.html, /That merchant could not be found, so no dietary options were changed\./);
});

test('ISOLATION 4: the rendered page refers to ONE merchant throughout, and keeps the tab', async function() {
  const v = visitor();
  await v.request('/home');
  for (const tab of ['campaign', 'results']) {
    const page = await v.request('/merchant?merchantId=' + MERCHANT_B + '&tab=' + tab);
    // Heading, selected option, and BOTH hidden merchantId fields agree.
    assert.match(page.html, /<h1>Green Bowl<\/h1>/, 'heading is merchant B');
    assert.match(page.html, new RegExp('<option value="' + MERCHANT_B + '"[^>]*selected'));
    assert.ok(!new RegExp('<option value="' + MERCHANT_A + '"[^>]*selected').test(page.html));
    const hiddenIds = (page.html.match(/name="merchantId" value="([^"]*)"/g) || [])
      .map(function(m) { return m.replace(/.*value="/, '').replace('"', ''); });
    assert.ok(hiddenIds.length >= 1, 'the dietary form carries a hidden merchantId');
    hiddenIds.forEach(function(id) {
      assert.equal(id, MERCHANT_B, 'every form on the page posts for the SAME merchant');
    });
    // The dietary form carries the current tab, so saving returns to the same place.
    const dietaryForm = page.html.slice(page.html.indexOf('action="/merchant/dietary"'),
      page.html.indexOf('Save dietary options'));
    assert.match(dietaryForm, new RegExp('name="tab" value="' + tab + '"'));
  }
  // Saving from the Results tab comes back to the Results tab, for that same merchant.
  const saved = await v.request('/merchant/dietary', { merchantId: MERCHANT_B, tab: 'results', vegan: 'on' }, true);
  assert.equal(saved.location, '/merchant?merchantId=' + MERCHANT_B + '&tab=results&saved=dietary');
});

test('ISOLATION 5: the dropdown loads the chosen merchant before any save can happen', async function() {
  // The picker submits on change, so the page (and both hidden merchantId fields) are re-rendered
  // for the newly chosen merchant before the dietary Save button can be pressed.
  const script = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'js', 'script.js'), 'utf8');
  assert.match(script, /\[data-auto-submit\] select/, 'the picker submits on change');
  assert.match(script, /form\.submit\(\)/);
  const view = require('fs').readFileSync(require('path').join(__dirname, '..', 'views', 'merchant.ejs'), 'utf8');
  assert.match(view, /class="merchant-picker" data-auto-submit/);
  assert.match(view, /<button class="text-button" type="submit">Switch<\/button>/, 'the no-JS fallback stays');

  // And the resulting GET renders the newly chosen merchant end to end.
  const v = visitor();
  await v.request('/home');
  const page = await v.request('/merchant?merchantId=' + MERCHANT_A + '&tab=campaign');
  assert.match(page.html, /<h1>Woodlands Noodle Bar<\/h1>/);
  const switched = await v.request('/merchant?merchantId=' + MERCHANT_B + '&tab=campaign');
  assert.match(switched.html, /<h1>Green Bowl<\/h1>/);
  assert.ok(!/name="merchantId" value="woodlands-noodle-bar"/.test(switched.html),
    'no stale hidden ID from the previously rendered merchant');
});

test('ISOLATION 6: Smart Match honours each merchant\'s own declaration, with no leakage', async function() {
  const v = visitor();
  await v.request('/home');
  clearAllCapabilities();
  await v.request('/merchant/dietary', { merchantId: MERCHANT_A, halal: 'on' }, true);
  await v.request('/merchant/dietary', { merchantId: MERCHANT_B, vegan: 'on' }, true);
  const a = { id: MERCHANT_A, source: 'local-fallback' };
  const b = { id: MERCHANT_B, source: 'local-fallback' };
  // A is Halal only.
  assert.equal(getDietaryMatchState(a, 'halal'), MATCH_STATE.MATCH);
  assert.equal(getDietaryMatchState(a, 'vegan'), MATCH_STATE.UNKNOWN);
  assert.equal(getDietaryMatchState(a, 'vegetarian'), MATCH_STATE.UNKNOWN);
  // B is Vegan (and therefore vegetarian), but never Halal.
  assert.equal(getDietaryMatchState(b, 'vegan'), MATCH_STATE.MATCH);
  assert.equal(getDietaryMatchState(b, 'vegetarian'), MATCH_STATE.MATCH);
  assert.equal(getDietaryMatchState(b, 'halal'), MATCH_STATE.UNKNOWN);
  // End to end: a Halal search may include A and never B; a Vegan search the other way round.
  const demo = createInitialDemo('jia');
  demo.profile.maxDistanceMinutes = 30;
  const pool = (await getNearbyMerchants(null, 'jia', '', 30, 'halal')).merchants;
  const halalGate = applyDietaryPolicyForTest(pool, 'halal').candidates.map(function(m) { return m.id; });
  assert.ok(halalGate.includes(MERCHANT_A) && !halalGate.includes(MERCHANT_B), 'Halal: ' + halalGate);
  const veganGate = applyDietaryPolicyForTest(pool, 'vegan').candidates.map(function(m) { return m.id; });
  assert.ok(veganGate.includes(MERCHANT_B) && !veganGate.includes(MERCHANT_A), 'Vegan: ' + veganGate);
});
