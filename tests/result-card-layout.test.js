require('./helpers/test-isolation.cjs');
const seedLegacyLocation = require('./helpers/legacy-location.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app, demoStore, createInitialDemo, buildMatchExplanation, getMerchantCampaigns,
  resetMerchantCampaigns, clearDiscoveryCache, clearSearchIntentCache,
  RESEARCH_STATUS } = require('../app');

// Task 8: the Smart Match result is a clean collapsed card. These tests guard the STRUCTURE (every essential fact and
// action is present, details live in "Why this match?", Google facts are never collapsed, sheets are overlays) and the
// responsive CSS contract. Pixel results are verified in a real browser separately.
const originalFetch = global.fetch;
const trackedKeys = ['GOOGLE_PLACES_API_KEY', 'FOURSQUARE_API_KEY', 'PLACES_PROVIDER',
  'OPENAI_API_KEY', 'TAVILY_API_KEY', 'GROQ_API_KEY'];
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

const CSS = function() {
  return fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'style.css'), 'utf8');
};
const CLIENT_JS = function() {
  return fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'script.js'), 'utf8');
};

function visitor() {
  let cookie = '';
  return {
    cookieValue() { return cookie; },
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

async function card(v) {
  await v.request('/home');
  await seedLegacyLocation(v, { status: 'fallback' });
  const result = await v.request('/smart-match/result');
  assert.equal(result.status, 200);
  assert.match(result.html, /data-merchant-id="/);
  return result.html;
}

// WHY -------------------------------------------------------------------------------------------
function placesMerchant(extra) {
  return Object.assign({
    id: 'google-x', merchantName: 'Corner Stall', source: 'GOOGLE', categoryNames: ['Noodle Restaurant'],
    categoryLabel: 'Noodle Restaurant', cuisineTags: ['noodles'], itemName: null, price: null,
    dietary: [], category: 'google.place', distanceMetres: 179, distanceLabel: '179 m away',
    distanceMinutes: 3, research: {}
  }, extra || {});
}
function profileFor(overrides) {
  return Object.assign(createInitialDemo('jia').profile, overrides || {});
}

test('WHY 1: a validated AI ranking reason is used exactly as the ranker approved it', function() {
  const reason = 'Its Noodle Restaurant category fits your craving better than the nearer options.';
  assert.equal(buildMatchExplanation(profileFor(), placesMerchant(), null, reason, 'high'), reason);
  assert.equal(buildMatchExplanation(profileFor(), placesMerchant(), null, '  A  b \n c ', 'high'), 'A b c');
});

test('WHY 2: without an AI reason it composes up to three facts the data supports', function() {
  const campaign = { rewardAmount: 0.8, rewardLabel: 'Vouch Credit' };
  assert.equal(
    buildMatchExplanation(profileFor({ moodCuisine: 'noodles' }), placesMerchant(), campaign, null, null),
    'Matches your noodles mood, 179 m away and has a Vouch Credit today.');
  // A registered merchant that listed Halal: the clause says the merchant listed it, never that it
  // was verified. ('felicia-chicken-rice' lists Halal in the shipped demo data.)
  const listed = placesMerchant({ id: 'felicia-chicken-rice', source: 'local-fallback' });
  assert.equal(
    buildMatchExplanation(profileFor({ dietaryPreference: 'halal', craving: 'bee hoon' }), listed, null, null, 'high'),
    'Listed as halal by the merchant, matches your bee hoon craving and 179 m away.');
});

test('WHY 3: it never states anything the recommendation data does not support', function() {
  const campaign = { rewardAmount: 0.8, rewardLabel: 'Vouch Credit' };
  const unverified = placesMerchant({ merchantName: 'Halal Food Paradise' });
  const halalText = buildMatchExplanation(profileFor({ dietaryPreference: 'halal' }), unverified, campaign, null, null);
  assert.ok(!/halal/i.test(halalText), halalText);
  assert.ok(!/budget/i.test(buildMatchExplanation(profileFor(), placesMerchant({ price: null }), null, null, null)));
  assert.match(buildMatchExplanation(profileFor({ budget: 10 }), placesMerchant({ price: 6.8 }), null, null, null),
    /fits your \$10 budget/);
  const demoMerchant = placesMerchant({ distanceMetres: undefined, distanceLabel: null, distanceMinutes: 4 });
  const demoText = buildMatchExplanation(profileFor(), demoMerchant, campaign, null, null);
  assert.match(demoText, /within your walking range/);
  assert.ok(!/\bmin\b|minute/.test(demoText), demoText);
  const all = [halalText, demoText,
    buildMatchExplanation(profileFor({ moodCuisine: 'noodles' }), placesMerchant(), campaign, null, null)].join(' ');
  assert.ok(!/vouches|popular|famous|best|rated|review|serves|menu/i.test(all), all);
  const bare = buildMatchExplanation(profileFor(), placesMerchant({ categoryLabel: null, categoryNames: [] }), null, null, null);
  assert.ok(bare.length > 0 && /\.$/.test(bare), bare);
});

// LAYOUT 1 -------------------------------------------------------------------------------------
test('LAYOUT 1: the collapsed card carries every essential fact and action', async function() {
  const html = await card(visitor());
  assert.match(html, /<h3 title="[^"]+">[^<]+<\/h3>/, 'merchant name');
  assert.match(html, /<span class="result-distance">[^<]*(away|min)[^<]*<\/span>/, 'distance or RP demo estimate');
  assert.match(html, /class="reward"/);
  assert.match(html, /\$\d+\.\d\d Vouch Credit/, 'the monetary credit value stays visible');
  assert.match(html, /Spend \$\d+\.\d\d\+ · Simulated payment · Credit usable only at /, 'the qualifying conditions stay visible');
  assert.match(html, /action="\/recommendation\/accept"[^>]*>[\s\S]*?Choose this/, 'primary action');
  assert.match(html, /class="feedback sheet-host"[\s\S]*?Not for me/, 'rejection action');
  assert.match(html, /<details class="why-match">\s*<summary class="why-match__summary">Why this match\?<\/summary>/);
  assert.ok(!/class="result-why-label"/.test(html), 'the old clamped label is gone');
  const css = CSS();
  assert.match(css, /\.result-dish-price \{ flex-shrink:0; \}/, 'the price can never be the part that gets ellipsised');
});

test('LAYOUT 1b: the Home greeting stays above the results and the matching sheet is a modal dialog', async function() {
  const v = visitor();
  const home = await v.request('/home');
  assert.match(home.html, /<header class="greeting"><p>Good (morning|afternoon|evening), Jia 👋<\/p><h1>[^<]+<\/h1><\/header>/);
  assert.ok(home.html.indexOf('class="greeting"') < home.html.indexOf('id="smart-match"'));
  assert.match(home.html, /<div class="sheet-modal" data-match-modal data-modal-auto="true" hidden>/, 'a first visit opens the sheet automatically');
  assert.match(home.html, /role="dialog" aria-modal="true" aria-labelledby="sheet-title"/);
  assert.ok(!/\.greeting \{ display:none/.test(CSS()));
});

// WHY 4 -----------------------------------------------------------------------------------------
test('WHY 4: the card renders the composed explanation inside "Why this match?", never lost', async function() {
  const html = await card(visitor());
  const details = html.match(/<details class="why-match">([\s\S]*?)<\/details>/);
  assert.ok(details, 'the disclosure exists');
  assert.match(details[1], /class="result-why-text">[^<]*walking range[^<]*\.</, 'the full explanation is inside it');
  assert.match(details[1], /Distances are estimates from the RP demo origin, not real walking times\./, 'methodology disclosure');
  assert.ok(!/class="why-match" open/.test(html), 'collapsed by default');
});

// LAYOUT 2 -------------------------------------------------------------------------------------
test('LAYOUT 2: the sheets are closed-by-default overlays, not inline card height', async function() {
  const html = await card(visitor());
  assert.match(html, /<details class="refine-prefs sheet-host" id="refine">/);
  assert.ok(!/<details class="refine-prefs sheet-host" id="refine" open/.test(html));
  assert.match(html, /<details class="feedback sheet-host" id="feedback">/);
  assert.match(html, /class="result-sheet"[\s\S]*?data-sheet-backdrop/);
  assert.match(html, /class="result-sheet-panel refine-sheet" role="group" aria-label="Edit craving and mood"/);
  assert.match(html, /data-sheet-close>Close<\/button>/);
  assert.match(html, /name="craving"/);
  assert.match(html, /name="moodCuisine"/);
  assert.match(html, /name="budget"/);
  assert.match(html, /name="maxDistanceMinutes"/);
  assert.match(html, /name="notifications"/);
  assert.match(html, /Dietary: <strong>No dietary restriction<\/strong>/);
  assert.match(html, /href="\/profile\/dietary">Change in Profile/);
  assert.doesNotMatch(html, /name="dietaryPreference"/, 'no second editable dietary selector');
  assert.match(html, /action="\/profile" class="form-stack"/, 'submission target is unchanged');
  const css = CSS();
  assert.match(css, /\.result-sheet \{ position:absolute; inset:0; z-index:2000; \}/, 'an overlay inside the phone screen (fixed when frameless)');
  assert.match(css, /\.result-sheet-panel \{ position:absolute;[^}]*bottom:0;/);
  assert.match(css, /\.result-sheet-panel \{[^}]*env\(safe-area-inset-bottom\)/);
  assert.match(css, /details\[open\]>\.sheet-trigger/, 'the open state is visible on the trigger');
  assert.match(css, /\.match-card\.reveal \{ animation-fill-mode:none; \}/);
});

test('LAYOUT 2b: the sheets keep working from the keyboard', async function() {
  const js = CLIENT_JS();
  assert.match(js, /key !== 'Escape'/, 'Escape closes an open sheet');
  assert.match(js, /data-sheet-backdrop\], \[data-sheet-close\]/, 'backdrop and Close both close it');
  assert.match(js, /trigger\.focus\(\)/, 'focus returns to the trigger');
  assert.match(js, /first\.focus\(\{ preventScroll: true \}\)/, 'focus moves into the panel on open');
  assert.match(js, /closeOpenSheets\(host, false\)/, 'only one sheet is open at a time');
  assert.match(CSS(), /button:focus-visible,a:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible \{ outline:3px solid/);
});

// LAYOUT 3 -------------------------------------------------------------------------------------
test('LAYOUT 3: iPhone-style frame on large screens, frameless real-viewport layout on phones and at high zoom', async function() {
  const css = CSS();
  assert.match(css, /\.device \{[^}]*width:418px; height:clamp\(660px,calc\(100dvh - 40px\),920px\);/, 'one centred ~390px-wide phone screen');
  assert.match(css, /\.device-bezel \{[^}]*background:#050506;/, 'black bezel');
  assert.match(css, /\.dynamic-island \{/);
  assert.match(css, /\.home-indicator \{/);
  assert.match(css, /\.device-button--power \{/);
  assert.match(css, /\.screen \{ grid-row:3; min-height:0; overflow-y:auto;/, 'content scrolls inside the phone screen');
  assert.match(css, /\.navigation \{ grid-row:4;/, 'the bottom navigation stays inside the screen');
  const frameless = css.match(/@media not all and \(min-width:700px\) and \(min-height:700px\) \{([\s\S]*?)\n\}/);
  assert.ok(frameless, 'the frame is used only above 700px wide AND 700px tall, so narrow windows and high zoom go frameless');
  for (const rule of [/\.status-bar,\.home-indicator,\.device-button \{ display:none; \}/, /\.device,\.device-bezel \{[^}]*box-shadow:none;/,
    /\.screen \{ overflow:visible;[^}]*env\(safe-area-inset-bottom\)/, /\.navigation \{ position:fixed; left:0; right:0; bottom:0;/,
    /\.navigation \{[^}]*padding:6px 8px calc\(6px \+ env\(safe-area-inset-bottom\)\)/, /\.app-header \{ position:sticky; top:0;/,
    /\.app-header \{[^}]*env\(safe-area-inset-top\)/, /\.phone \{[^}]*max-width:var\(--frameless-max\)/]) assert.match(frameless[1], rule);
  assert.match(css, /--frameless-max:560px/);
  const home = (await visitor().request('/home')).html;
  for (const decorative of ['device-button device-button--action', 'class="status-bar"', 'dynamic-island', 'class="home-indicator"']) {
    const at = home.indexOf(decorative); assert.ok(at >= 0, decorative);
  }
  assert.equal((home.match(/class="device-button [^"]*" aria-hidden="true"/g) || []).length, 4);
  assert.match(home, /<div class="status-bar" aria-hidden="true">/);
  assert.match(home, /<span class="home-indicator" aria-hidden="true"><\/span>/);
  assert.match(css, /\.screen \{[^}]*scroll-padding-top:/);
  assert.match(css, /\.sheet-trigger \{[^}]*min-height:44px;/);
  assert.match(css, /\.button \{[^}]*min-height:52px;/);
  assert.match(css, /\.avatar \{ width:44px; height:44px;/);
  assert.match(css, /\.navigation a \{ min-height:50px; min-width:44px;/);
  assert.match(css, /\.result-photo \{[^}]*aspect-ratio:1 \/ 1;/, 'the photo square never distorts');
  assert.match(css, /\.result-photo img \{[^}]*object-fit:cover;/);
  assert.match(css, /\.result-photo\.is-empty \.result-photo-fallback \{ display:grid; \}/);
  assert.match(css, /prefers-reduced-motion:reduce/);
  assert.ok(!/\.rec-list \{[^}]*grid-template-columns:repeat\(2/.test(css) && !/@media \(min-width:700px\) \{ \.rec-list/.test(css), 'never more than one card per row');
  assert.match(css, /\.rec-list \{ display:flex; flex-direction:column; gap:14px; \}/);
});

test('LAYOUT 3b: long dynamic text is never clamped or hidden, and wraps instead of overflowing', async function() {
  const v = visitor();
  await card(v);
  await v.change(function(demo) {
    const merchant = demo.nearbyMerchants.find(function(m) { return m.id === demo.selectedMerchantId; });
    merchant.merchantName = 'Super Extraordinarily Long Hawker Merchant Name With Many Many Words Indeed Stall 47B';
    demo.selectedMerchantReason = 'This candidate fits your craving far better than every other listed option nearby, ' +
      'and it is still comfortably inside the walking range you asked for today.';
  });
  const html = (await v.request('/smart-match/result')).html;
  assert.match(html, /<h3 title="Super Extraordinarily Long Hawker Merchant Name[^"]*">Super Extraordinarily Long Hawker Merchant Name[^<]*<\/h3>/);
  assert.match(html, /class="result-why-text">This candidate fits your craving far better[^<]*</);
  assert.match(html, /Spend \$\d+\.\d\d\+ · Simulated payment · Credit usable only at Super Extraordinarily Long/);
  const css = CSS();
  assert.ok(!/\.result-info h3 \{[^}]*line-clamp/.test(css), 'the merchant name is never clamped');
  assert.ok(!/\.match-card \.reward[^{]*\{[^}]*line-clamp/.test(css), 'reward conditions are never line-clamped');
  assert.match(css, /\.result-why-text \{[^}]*-webkit-line-clamp:unset;[^}]*overflow:visible;/, 'the explanation is shown in full');
  assert.match(css, /\.result-info h3,\.rec-name|\.rec-name,\.result-info h3 \{[^}]*overflow-wrap:anywhere;/);
});

test('LAYOUT 3c: an exceptionally long name is rendered whole', async function() {
  const v = visitor();
  await card(v);
  const longName = 'Pondok Angah Nasi Padang Muslim Food Stall and Traditional Halal Kitchen Woodlands Branch 02';
  assert.ok(longName.length >= 80 && longName.length <= 100);
  await v.change(function(demo) {
    const merchant = demo.nearbyMerchants.find(function(m) { return m.id === demo.selectedMerchantId; });
    merchant.merchantName = longName;
    merchant.name = longName;
  });
  const html = (await v.request('/smart-match/result')).html;
  assert.ok(html.includes('>' + longName + '</h3>'), 'the complete name is rendered');
  assert.match(html, /Choose this/);
  assert.match(html, /Not for me/);
  assert.match(html, /Craving and mood/);
  assert.match(html, new RegExp('Credit usable only at ' + longName.replace(/[.*+?^$()|[\]\\{}]/g, '\\$&')));
  assert.ok(!/merchantName\.length|nameLength/.test(CLIENT_JS()), 'no JavaScript measures the name');
});

// LAYOUT 3d ------------------------------------------------------------------------------------
// A REAL provider result: Google photo + owner attribution, a full Singapore address, the composed
// explanation, long reward copy and both secondary actions. This is the shape that produced the
// horizontal clipping, so it is pinned here.
const PLACE_ID = 'ChIJq6qq6jQX2jERPondokAngah';
const PROVIDER_NAME = 'Pondok Angah Nasi Padang';
const PROVIDER_ADDRESS = '1 Woodlands Square, #B1-K12 Causeway Point Food Junction, Singapore 738099';

function mockRealProvider(name) {
  const place = {
    id: PLACE_ID, displayName: { text: name }, primaryType: 'indonesian_restaurant',
    types: ['indonesian_restaurant', 'restaurant', 'food', 'point_of_interest', 'establishment'],
    formattedAddress: PROVIDER_ADDRESS,
    location: { latitude: 1.4444, longitude: 103.7854 },
    photos: [{ name: 'places/' + PLACE_ID + '/photos/AelY_CtPondokAngahPhotoReference',
      widthPx: 1600, heightPx: 1200,
      authorAttributions: [{ displayName: name + ' Causeway Point Woodlands Square Outlet',
        uri: 'https://maps.google.com/maps/contrib/123456789' }] }]
  };
  global.fetch = async function (url, init) {
    const target = String(url);
    const host = new URL(target).hostname;
    if (host === '127.0.0.1') return originalFetch(url, init);
    if (target.endsWith(':searchText') || target.endsWith(':searchNearby')) {
      return { ok: true, status: 200, json: async () => ({ places: [place] }) };
    }
    if (host === 'places.googleapis.com') return { ok: true, status: 200, json: async () => ({ photos: place.photos }) };
    return { ok: false, status: 404 };
  };
}

// An external provider result is never a dietary match (nobody has listed anything about it), so
// this layout fixture runs with no dietary preference - the long name, photo, address and actions
// are what it pins.
async function providerCard(v, name) {
  process.env.GOOGLE_PLACES_API_KEY = 'test-google';
  mockRealProvider(name);
  await v.request('/home');
  await v.request('/profile', { dietaryPreference: 'none', budget: '30', maxDistanceMinutes: '30', craving: '', moodCuisine: 'any' });
  await seedLegacyLocation(v, { latitude: 1.4428, longitude: 103.7854 });
  await v.request('/smart-match/result');          // warms the one photo lookup
  const result = await v.request('/smart-match/result');
  assert.match(result.html, /data-merchant-id="google-/, 'a real provider merchant is recommended');
  return result.html;
}

test('LAYOUT 3d: a real provider result keeps every part inside the card', async function() {
  const html = await providerCard(visitor(), PROVIDER_NAME);
  assert.ok(html.includes('>' + PROVIDER_NAME + '</h3>'));
  assert.ok(!/diet-tag/.test(html), 'no dietary badge without an active preference');
  assert.match(html, /class="result-photo-credit">Photo: <a/, 'owner attribution is rendered (inside Why this match?)');
  assert.match(html, /<img src="\/smart-match\/photo\//, 'the provider photo is rendered');
  assert.ok(html.includes('data-address="' + PROVIDER_ADDRESS + '"'), 'the full address reaches the map');
  assert.match(html, /class="result-why-text">[^<]+</, 'the composed explanation is rendered');
  assert.match(html, /Simulated payment · Credit usable only at /);
  assert.match(html, /Choose this/);
  assert.match(html, /Not for me/);
  const css = CSS();
  assert.match(css, /\.match-copy \{[^}]*min-width:0;/);
  assert.match(css, /\.result-info \{ flex:1; min-width:0;/);
  assert.match(css, /\.result-meta \{ display:flex; flex-wrap:wrap;/);
  assert.match(css, /\.result-tags \{ display:flex; flex-wrap:wrap;/);
  assert.match(css, /\.result-photo-credit \{[^}]*overflow-wrap:anywhere;/);
  assert.match(css, /\.match-card \.reward \{[^}]*overflow-wrap:anywhere;/);
  assert.match(css, /\.result-secondary \{ display:flex; flex-wrap:wrap;/);
  assert.match(css, /\.mood-chip \{ position:relative;/);
  const js = CLIENT_JS();
  assert.match(js, /const popupMaxWidth = Math\.max\(150, Math\.round\(el\.clientWidth\) - 48\);/);
  assert.match(css, /\.map-popup \.leaflet-popup-content \{[^}]*overflow-wrap:anywhere;/);
  const resultRules = css.split('Smart Match RESULT card')[1].split('Business Report page')[0];
  assert.ok(!/overflow-x:(auto|scroll)/.test(resultRules), 'no horizontal scroll area in the result card');
});

test('LAYOUT 3e: an 80-100 character provider name still stays inside the card', async function() {
  const longName = 'Pondok Angah Nasi Padang Muslim Food Stall and Traditional Halal Kitchen Woodlands 02';
  assert.ok(longName.length >= 80 && longName.length <= 100);
  const html = await providerCard(visitor(), longName);
  assert.ok(html.includes('>' + longName + '</h3>'), 'the whole name is rendered');
  assert.match(html, /Choose this/);
  assert.match(CSS(), /\.result-info h3 \{[^}]*overflow-wrap:anywhere;/, 'an unbroken name breaks inside the word');
});

// LAYOUT 4 -------------------------------------------------------------------------------------
test('LAYOUT 4: the special result states still render their own content', async function() {
  const v = visitor();
  const merchantId = (await card(v)).match(/data-merchant-id="([^"]+)"/)[1];
  await v.request('/recommendation/accept', { merchantId: merchantId });
  const accepted = (await v.request('/smart-match/result')).html;
  assert.match(accepted, /Heading to /);
  assert.match(accepted, /href="\/scan">Scan when you arrive/);
  assert.match(accepted, /Changed your mind\?/);
  getMerchantCampaigns().forEach(function(c) { c.status = 'PAUSED'; });
  await v.change(function(demo) { demo.selectedMerchantId = merchantId; demo.recommendationAccepted = false; });
  const ended = (await v.request('/smart-match/result')).html;
  assert.match(ended, /class="reward reward--ended" role="status">This offer has ended/);
  assert.ok(!/Choose this/.test(ended), 'no primary action without a live campaign');
  assert.match(ended, /Not for me/, 'the user can still reject and try another');
});

test('LAYOUT 4b: the empty states keep their own explanations and inline filter form', async function() {
  const v = visitor();
  await v.request('/home');
  await seedLegacyLocation(v, { status: 'fallback' });
  await v.request('/profile', { budget: '1', maxDistanceMinutes: '1', craving: '', moodCuisine: 'any' });
  const empty = (await v.request('/smart-match/result')).html;
  assert.match(empty, /No nearby merchants clearly match your current craving and mood./);
  assert.match(empty, /Adjust filters/);
  assert.match(empty, /name="craving"/);
  assert.match(empty, /Dietary: <strong>No dietary restriction<\/strong>/);
  assert.match(empty, /Search more places/);
  assert.match(CSS(), /\.refine-prefs--flat \.refine-sheet \{ padding:/);
});
