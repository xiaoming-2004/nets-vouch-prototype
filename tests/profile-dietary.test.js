const test = require('node:test');
const assert = require('node:assert/strict');
const { app, demoStore, getDietaryMatchState, MATCH_STATE, RESEARCH_STATUS, clearDiscoveryCache,
  clearMerchantResearchCache, clearSearchIntentCache, resetMerchantCampaigns } = require('../app');
const researchStore = require('../research-store');

// Dietary restrictions are a SAVED Profile setting: never asked during onboarding, managed only
// from Profile, and saved without disturbing any other profile value or session state.
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

function visitor() {
  let cookie = '';
  return {
    async request(requestPath, body) {
      const response = await originalFetch(base + requestPath, {
        method: body === undefined ? 'GET' : 'POST', redirect: 'manual',
        headers: { Cookie: cookie, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      const header = response.headers.get('set-cookie');
      if (header) cookie = header.split(';')[0];
      return { status: response.status, location: response.headers.get('location'), html: await response.text() };
    },
    sessionId() { return decodeURIComponent(cookie.split('=')[1]).slice(2).split('.')[0]; },
    async state() {
      const id = this.sessionId();
      return new Promise(function(resolve, reject) {
        demoStore.get(id, function(error, data) { if (error) reject(error); else resolve(data); });
      });
    },
    async change(mutate) {
      const id = this.sessionId();
      const state = await this.state();
      mutate(state.demo);
      await new Promise(function(resolve, reject) {
        demoStore.set(id, state, function(error) { if (error) reject(error); else resolve(); });
      });
    }
  };
}

function place(id, name, metres, extra) {
  return Object.assign({ id: id, displayName: { text: name }, primaryType: 'restaurant',
    types: ['restaurant', 'food', 'point_of_interest', 'establishment'],
    formattedAddress: '1 Example Road, Singapore 7380' + String(10 + (metres % 80)).padStart(2, '0'),
    location: { latitude: ORIGIN.latitude + metres / M, longitude: ORIGIN.longitude } }, extra || {});
}

// Google text/nearby by query, plus Tavily + Groq so dietary verification can be exercised end to end.
const RESEARCH_MARKER = 'You verify ONE dietary requirement';
function mockProviders(options) {
  const calls = { nearby: 0, text: [], search: [], extract: 0 };
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
      if (target.endsWith('/search')) {
        calls.search.push(body.query);
        return { ok: true, json: async function() {
          return { results: [{ title: body.query + ' - MUIS halal certificate',
            url: 'https://www.muis.gov.sg/halal/' + encodeURIComponent(body.query.slice(0, 20)),
            content: body.query }] };
        } };
      }
      calls.extract += 1;
      return { ok: true, json: async function() {
        return { results: body.urls.map(function(u) {
          return { url: u, raw_content: 'Certified halal outlet. ' + 'Details. '.repeat(40) };
        }) };
      } };
    }
    if (host === 'api.groq.com' && String(body.messages[0].content).indexOf(RESEARCH_MARKER) === 0) {
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

// DIETARY UI 1 ---------------------------------------------------------------------------------
test('ONBOARD 1: first-time onboarding asks only for the current meal - no dietary controls', async function() {
  const v = visitor();
  const home = await v.request('/home');
  assert.match(home.html, /action="\/setup-preferences"/, 'the onboarding form is shown to a new user');
  assert.match(home.html, /name="craving"/);
  assert.match(home.html, /name="moodCuisine"/);
  // No dietary question, and no dietary option of any kind.
  assert.doesNotMatch(home.html, /name="dietaryPreference"/);
  assert.doesNotMatch(home.html, /dietary requirements\?/i);
  const onboardForm = home.html.slice(home.html.indexOf('action="/setup-preferences"'),
    home.html.indexOf('Find my match'));
  ['Halal', 'Vegetarian', 'Vegan', 'No dietary restriction'].forEach(function(label) {
    assert.ok(!onboardForm.includes(label), 'onboarding must not offer ' + label);
  });
  // A new user starts at "none".
  assert.equal((await v.state()).demo.profile.dietaryPreference, 'none');
});

// DIETARY UI 2 ---------------------------------------------------------------------------------
test('ONBOARD 2: submitting onboarding never resets a saved dietary restriction', async function() {
  const v = visitor();
  await v.request('/home');
  assert.equal((await v.request('/profile/dietary', { dietaryPreference: 'halal' })).location,
    '/profile/dietary?saved=1');
  // Onboarding no longer submits the field at all - the saved restriction must survive.
  assert.equal((await v.request('/setup-preferences', { craving: 'something light', moodCuisine: 'soup' })).location,
    '/home');
  let profile = (await v.state()).demo.profile;
  assert.equal(profile.dietaryPreference, 'halal', 'an absent field is not an instruction to reset');
  assert.equal(profile.craving, 'something light');
  assert.equal(profile.moodCuisine, 'soup');
  // An explicitly submitted valid value is still honoured (existing links and flows).
  await v.request('/setup-preferences', { craving: '', moodCuisine: 'any', dietaryPreference: 'vegan' });
  assert.equal((await v.state()).demo.profile.dietaryPreference, 'vegan');
  // An explicitly submitted INVALID value never lands, and never downgrades the saved one either.
  await v.request('/setup-preferences', { craving: '', moodCuisine: 'any', dietaryPreference: 'pescatarian' });
  assert.equal((await v.state()).demo.profile.dietaryPreference, 'vegan');
});

// DIETARY UI 3 ---------------------------------------------------------------------------------
test('PROFILE 1: Profile offers "Dietary restrictions" instead of "Preferences"', async function() {
  const v = visitor();
  await v.request('/home');
  const profile = await v.request('/profile');
  assert.match(profile.html, /<strong>Dietary restrictions<\/strong>/);
  assert.match(profile.html, /Set requirements Smart Match must follow/);
  assert.match(profile.html, /href="\/profile\/dietary"/);
  assert.ok(!profile.html.includes('<strong>Preferences</strong>'));
  assert.ok(!profile.html.includes('Edit preferences'));
  // Notifications remain a saved setting, toggled from Profile itself.
  assert.match(profile.html, /action="\/profile\/notifications"/);
});

test('PROFILE 2: the Dietary restrictions page holds the four dietary choices and nothing else', async function() {
  const v = visitor();
  await v.request('/home');
  for (const path of ['/profile/dietary', '/profile/preferences']) {
    const page = await v.request(path);
    assert.equal(page.status, 200, path + ' still resolves');
    assert.match(page.html, /<h1>Dietary restrictions<\/h1>/);
    assert.match(page.html, /<title>Dietary restrictions/);
    assert.match(page.html, /← Profile/);
    assert.match(page.html, /aria-label="Back to Profile"/);
    assert.ok(!page.html.includes('<h1>Preferences</h1>'));
    ['none', 'halal', 'vegetarian', 'vegan'].forEach(function(value) {
      assert.match(page.html, new RegExp('name="dietaryPreference" value="' + value + '"'));
    });
    const radios = page.html.match(/name="dietaryPreference"/g) || [];
    assert.equal(radios.length, 4, 'exactly four dietary choices');
    // Current-meal inputs must not appear as permanent Profile settings.
    assert.doesNotMatch(page.html, /name="craving"/);
    assert.doesNotMatch(page.html, /name="moodCuisine"/);
    assert.doesNotMatch(page.html, /name="budget"/);
    assert.doesNotMatch(page.html, /name="maxDistanceMinutes"/);
    assert.doesNotMatch(page.html, /Craving today|Mood today/);
  }
});

// DIETARY UI 4 ---------------------------------------------------------------------------------
test('SAVE 1: saving a dietary restriction changes only that field', async function() {
  const v = visitor();
  await v.request('/home');
  await v.request('/setup-preferences', { craving: 'laksa', moodCuisine: 'noodles' });
  await v.request('/profile', { craving: 'laksa', moodCuisine: 'noodles', budget: '23',
    maxDistanceMinutes: '17', notifications: '' });
  const before = (await v.state()).demo.profile;
  assert.deepEqual(before, { dietaryPreference: 'none', moodCuisine: 'noodles', craving: 'laksa',
    budget: 23, maxDistanceMinutes: 17, notifications: false });

  const saved = await v.request('/profile/dietary', { dietaryPreference: 'vegetarian' });
  assert.equal(saved.location, '/profile/dietary?saved=1');
  const after = (await v.state()).demo.profile;
  assert.deepEqual(after, { dietaryPreference: 'vegetarian', moodCuisine: 'noodles', craving: 'laksa',
    budget: 23, maxDistanceMinutes: 17, notifications: false },
    'only dietaryPreference changed');

  // The success state is visible and the saved value is pre-selected when reopened.
  const page = await v.request('/profile/dietary?saved=1');
  assert.match(page.html, /✓ Saved/);
  assert.match(page.html, /value="vegetarian" checked/);
  assert.doesNotMatch(page.html, /value="none" checked/);
  assert.match((await v.request('/profile/dietary')).html, /value="vegetarian" checked/,
    'reopening the page keeps the saved value selected');
});

test('SAVE 2: saving dietary preserves payments, Vouches, rewards and location state', async function() {
  const v = visitor();
  await v.request('/home');
  await v.request('/smart-match/location', ORIGIN);
  const first = await v.request('/smart-match/result');
  const merchantId = (first.html.match(/data-merchant-id="([^"]+)"/) || [])[1];
  assert.ok(merchantId);
  await v.request('/recommendation/accept', { merchantId: merchantId });
  await v.request('/scan');
  const scanResult = await v.request('/scan', { merchantId: merchantId });
  assert.ok(scanResult.location && scanResult.location.startsWith('/scan/payment'), scanResult.location);
  const pending = (await v.state()).demo.currentScanPayment;
  await v.request('/scan/payment', { journeyId: pending.id, amount: '6.00' });
  let demo = (await v.state()).demo;
  const transactionId = demo.transactions[0].id;
  await v.request('/vouch/' + transactionId, { action: 'create', tag: 'worth-it' });
  await v.change(function(state) { state.vouchCredits[merchantId] = 1.25; });
  const beforeDemo = (await v.state()).demo;

  await v.request('/profile/dietary', { dietaryPreference: 'halal' });
  demo = (await v.state()).demo;
  assert.equal(demo.profile.dietaryPreference, 'halal');
  assert.equal(demo.transactions.length, beforeDemo.transactions.length);
  assert.equal(demo.transactions[0].id, transactionId);
  assert.equal(demo.paymentVerifiedVouches.length, beforeDemo.paymentVerifiedVouches.length);
  assert.equal(demo.vouchCredits[merchantId], 1.25);
  assert.deepEqual(demo.discoveryLocation, beforeDemo.discoveryLocation);
  assert.deepEqual(demo.shownMerchantIds, beforeDemo.shownMerchantIds,
    'shown history survives a filter change, as it does for every other edit');
  assert.equal((await v.request('/profile/vouches')).status, 200);
  assert.equal((await v.request('/profile/activity')).status, 200);
});

test('SAVE 3: an invalid dietary submission is rejected and changes nothing', async function() {
  const v = visitor();
  await v.request('/home');
  await v.request('/profile/dietary', { dietaryPreference: 'vegan' });
  for (const bad of [{ dietaryPreference: 'pescatarian' }, { dietaryPreference: '' }, {}]) {
    const rejected = await v.request('/profile/dietary', bad);
    assert.equal(rejected.location, '/profile/dietary?error=invalid');
    assert.equal((await v.state()).demo.profile.dietaryPreference, 'vegan');
  }
  assert.match((await v.request('/profile/dietary?error=invalid')).html,
    /Please choose a valid dietary restriction/);
});

test('SAVE 4: a dietary value stored by an older build safely falls back to none', async function() {
  const v = visitor();
  await v.request('/home');
  await v.change(function(demo) { demo.profile.dietaryPreference = 'pescatarian'; });
  // The stale value is migrated on the next request, before any screen or search can read it.
  const page = await v.request('/profile/dietary');
  assert.match(page.html, /value="none" checked/);
  assert.equal((await v.state()).demo.profile.dietaryPreference, 'none');
  assert.match((await v.request('/profile')).html, /No dietary restriction/);
});

// DIETARY UI 5 ---------------------------------------------------------------------------------
test('SAVE 5: changing the restriction clears a stale recommendation instead of relabelling it', async function() {
  const v = visitor();
  await v.request('/home');
  await v.request('/smart-match/location', ORIGIN);
  const first = await v.request('/smart-match/result');
  const merchantId = (first.html.match(/data-merchant-id="([^"]+)"/) || [])[1];
  assert.ok(merchantId, 'a recommendation exists under "none"');
  assert.equal((await v.state()).demo.selectedMerchantId, merchantId);

  await v.request('/profile/dietary', { dietaryPreference: 'halal' });
  const demo = (await v.state()).demo;
  assert.equal(demo.selectedMerchantId, null, 'the stale selection is dropped');
  assert.equal(demo.selectedMerchantReason, null);
  assert.equal(demo.recommendationAccepted, false);
  assert.deepEqual(demo.nearbyMerchants, [], 'the batch is re-discovered under the new restriction');
  assert.equal(demo.nearbyRefreshAttempted, false);
});

test('SAVE 6: the next Smart Match search uses the newly saved restriction', async function() {
  process.env.GOOGLE_PLACES_API_KEY = 'test-google';
  process.env.TAVILY_API_KEY = 'test-tavily';
  process.env.GROQ_API_KEY = 'test-groq';
  const calls = mockProviders({
    nearby: [place('plain', 'Plain Eatery', 120)],
    text: { 'halal food': [place('cert', 'Certified Halal Kitchen', 240)] },
    verdict: function(name) { return name === 'Certified Halal Kitchen' ? RESEARCH_STATUS.SUITABLE : 'UNKNOWN'; }
  });
  const v = visitor();
  await v.request('/home');
  await v.request('/smart-match/location', ORIGIN);
  await v.request('/smart-match/result');
  assert.equal(calls.nearby, 1, '"none" performs normal discovery');
  assert.deepEqual(calls.text, [], 'no dietary-targeted search while unrestricted');

  await v.request('/profile/dietary', { dietaryPreference: 'halal' });
  const result = await v.request('/smart-match/result');
  assert.deepEqual(calls.text, ['halal food'], 'the saved restriction drives the next discovery');
  assert.match(result.html, /data-merchant-id="google-cert"/, 'only the verified outlet can be shown');
  assert.ok(!result.html.includes('data-merchant-id="google-plain"'));
  assert.ok(calls.search.length > 0, 'suitability still comes from evidence research');
});

test('SAVE 7: an unverified merchant is never presented as suitable after the change', async function() {
  process.env.GOOGLE_PLACES_API_KEY = 'test-google';
  process.env.TAVILY_API_KEY = 'test-tavily';
  process.env.GROQ_API_KEY = 'test-groq';
  // Everything the provider returns is named and queried as halal, yet nothing is verified.
  mockProviders({ nearby: [place('a', 'Halal Food Paradise', 120)],
    text: { 'halal food': [place('b', 'Super Halal Kitchen', 200)] },
    verdict: function() { return 'UNKNOWN'; } });
  const v = visitor();
  await v.request('/home');
  await v.request('/profile/dietary', { dietaryPreference: 'halal' });
  await v.request('/smart-match/location', ORIGIN);
  const result = await v.request('/smart-match/result');
  assert.equal(result.status, 200);
  assert.ok(!/data-merchant-id=/.test(result.html), 'no merchant is offered without evidence');
  assert.match(result.html, /halal/i);
  // The provider query words and the merchant names are not evidence.
  assert.equal(getDietaryMatchState({ merchantName: 'Super Halal Kitchen', source: 'GOOGLE', dietary: [],
    research: {} }, 'halal'), MATCH_STATE.UNKNOWN);
});

// DIETARY UI 6 ---------------------------------------------------------------------------------
test('REFINE: the Smart Match refine form shows the restriction read-only and links to Profile', async function() {
  const v = visitor();
  await v.request('/home');
  await v.request('/profile/dietary', { dietaryPreference: 'halal' });
  await v.change(function(demo) { demo.profile.dietaryPreference = 'none'; });
  await v.request('/smart-match/location', ORIGIN);
  const card = await v.request('/smart-match/result');
  assert.equal(card.status, 200);
  assert.match(card.html, /Dietary: <strong>No dietary restriction<\/strong>/);
  assert.match(card.html, /href="\/profile\/dietary">Change in Profile/);
  // Craving, mood, budget and distance stay editable here; dietary does not.
  assert.match(card.html, /name="craving"/);
  assert.match(card.html, /name="moodCuisine"/);
  assert.match(card.html, /name="budget"/);
  assert.doesNotMatch(card.html, /name="dietaryPreference"/);

  // Applying the refine form keeps the saved restriction even though it submits no dietary field.
  await v.request('/profile/dietary', { dietaryPreference: 'vegan' });
  const applied = await v.request('/profile', { craving: 'tofu', moodCuisine: 'any', budget: '12',
    maxDistanceMinutes: '15', notifications: 'on' });
  assert.equal(applied.location, '/home?matching=again');
  const profile = (await v.state()).demo.profile;
  assert.equal(profile.dietaryPreference, 'vegan', 'the refine form never resets the restriction');
  assert.equal(profile.craving, 'tofu');
  assert.equal(profile.budget, 12);
  assert.equal(profile.maxDistanceMinutes, 15);
  assert.equal(profile.notifications, true);
});

test('REFINE 2: an invalid refine submission keeps every saved value', async function() {
  const v = visitor();
  await v.request('/home');
  await v.request('/profile/dietary', { dietaryPreference: 'halal' });
  await v.request('/profile', { craving: 'rice', moodCuisine: 'rice', budget: '15',
    maxDistanceMinutes: '12', notifications: 'on' });
  const before = (await v.state()).demo.profile;
  for (const bad of [{ budget: '500', maxDistanceMinutes: '12' }, { budget: '15', maxDistanceMinutes: '0' },
    { budget: 'abc', maxDistanceMinutes: '12' }, { budget: '15', maxDistanceMinutes: '12', dietaryPreference: 'bad' }]) {
    const rejected = await v.request('/profile', bad);
    assert.equal(rejected.location, '/home?error=invalid');
    assert.deepEqual((await v.state()).demo.profile, before);
  }
  assert.match((await v.request('/home?error=invalid')).html, /Please choose valid filters/);
});

// DIETARY UI 7 ---------------------------------------------------------------------------------
test('NOTIFICATIONS: the Profile toggle flips only the notification setting', async function() {
  const v = visitor();
  await v.request('/home');
  await v.request('/profile/dietary', { dietaryPreference: 'halal' });
  const before = (await v.state()).demo.profile;
  assert.equal(before.notifications, true);
  assert.equal((await v.request('/profile/notifications', {})).location, '/profile');
  const after = (await v.state()).demo.profile;
  assert.equal(after.notifications, false);
  assert.deepEqual(Object.assign({}, after, { notifications: true }), before, 'nothing else moved');
  assert.match((await v.request('/profile')).html, /<em>Off<\/em>/);
  await v.request('/profile/notifications', {});
  assert.equal((await v.state()).demo.profile.notifications, true);
});
