const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app, demoStore, createInitialDemo, buildMatchExplanation, getMerchantCampaigns,
  resetMerchantCampaigns, clearDiscoveryCache, clearSearchIntentCache,
  RESEARCH_STATUS } = require('../app');

// The normal Smart Match result has to fit one mobile screen. Pixel heights belong in the browser
// (verified separately), so these tests guard the STRUCTURE that makes it fit and the content that
// must never be dropped to achieve it: every essential fact and action is present, the filter form
// is a closed-by-default overlay rather than inline height, and the compact rules are scoped to the
// result screen only.
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
  await v.request('/smart-match/location', { status: 'fallback' });
  const result = await v.request('/smart-match/result');
  assert.equal(result.status, 200);
  assert.match(result.html, /data-merchant-id="/);
  return result.html;
}

// LAYOUT 1 -------------------------------------------------------------------------------------
test('LAYOUT 1: the one-screen card still carries every essential fact and action', async function() {
  const html = await card(visitor());
  // Merchant name, distance, dietary badge, reward value + conditions, both actions, filters, map.
  assert.match(html, /<h2 title="Woodlands Noodle Bar">Woodlands Noodle Bar<\/h2>/);
  assert.match(html, /<span class="result-distance">\d+ min away<\/span>/);
  // Without an active dietary preference there is no dietary badge to show (the badge states only
  // what a registered merchant listed for the customer's own restriction).
  assert.ok(!/class="diet-tag/.test(html), 'no dietary badge without a preference');
  assert.match(html, /<span class="result-why-label">Why this match<\/span>/);
  assert.match(html, /class="result-why-text" title="[^"]+"/);
  assert.match(html, /class="reward"/);
  assert.match(html, /\$\d+\.\d\d Vouch Credit/, 'the monetary credit value stays visible');
  assert.match(html, /Spend \$\d+\.\d\d\+ · Pay with NETS/, 'the qualifying conditions stay visible');
  assert.match(html, /Credit usable only at Woodlands Noodle Bar\./);
  assert.match(html, /action="\/recommendation\/accept"[^>]*>[\s\S]*?Choose this/, 'primary action');
  assert.match(html, /class="feedback sheet-host"[\s\S]*?Not for me/, 'rejection action');
  assert.match(html, /Edit filters/);
  assert.match(html, /class="match-map"/);
  assert.match(html, /class="match-map-open"[^>]*maps/, 'directions stay reachable');
  // The dish and its price get their own compact row and are never clipped out of the card.
  assert.match(html, /<span class="result-dish-name">Try: Mushroom Noodles<\/span>/);
  assert.match(html, /<span class="result-dish-price">\$6\.80<\/span>/);
  const css = CSS();
  assert.match(css, /\.result-dish-price \{ flex-shrink:0; \}/,
    'the price can never be the part that gets ellipsised');
});

test('LAYOUT 1b: the Home greeting stays above the card and is never hidden', async function() {
  const v = visitor();
  const home = await v.request('/home');
  await v.request('/smart-match/location', { status: 'fallback' });
  await v.request('/smart-match/result');
  const withMatch = await v.request('/home');
  // The greeting keeps its original time-aware wording and the signed-in demo user's name.
  assert.match(withMatch.html, /<header class="greeting"><p>Good (morning|afternoon|evening), Jia 👋<\/p><h1>[^<]+<\/h1><\/header>/);
  assert.match(withMatch.html, /<header class="greeting">[\s\S]*?<section id="smart-match"/,
    'it sits above the Smart Match card');
  assert.equal(home.html.includes('class="greeting"'), true, 'and before a match is chosen too');
  const css = CSS();
  // No rule may hide it on the result screen - the compact pass used to drop it on a short shell.
  assert.ok(!/\.greeting \{ display:none/.test(css));
  assert.ok(!/\.screen:has\(\.match-card\) \.greeting \{[^}]*display:none/.test(css));
  // Only ONE heading competes at the top: the repeated "Your Smart Match" label steps aside.
  assert.match(css, /\.screen:has\(\.match-card\) #smart-match>\.eyebrow \{ display:none; \}/);
});

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

test('WHY 4: the card renders the composed explanation, clamped but never lost', async function() {
  const html = await card(visitor());
  assert.match(html, /<span class="result-why-label">Why this match<\/span>/);
  const shown = html.match(/class="result-why-text" title="([^"]+)">([^<]+)</);
  assert.ok(shown, 'the explanation renders with its full text in the title attribute');
  assert.equal(shown[1], shown[2], 'the title carries exactly the full sentence');
  assert.match(shown[2], /walking range/);
  assert.match(shown[2], /\.$/, 'it reads as a sentence');
  const css = CSS();
  assert.match(css, /\.result-why-text \{[^}]*-webkit-line-clamp:2;/, 'two lines by default');
  assert.match(css, /\.screen:has\(\.match-card\) \.result-why-text \{ -webkit-line-clamp:3; \}/,
    'up to three lines on the result screen');
});

// LAYOUT 2 -------------------------------------------------------------------------------------
test('LAYOUT 2: the filter form is a closed-by-default overlay, not inline card height', async function() {
  const html = await card(visitor());
  // Closed <details>: no `open` attribute, so the panel costs nothing while closed.
  assert.match(html, /<details class="refine-prefs sheet-host" id="refine">/);
  assert.ok(!/<details class="refine-prefs sheet-host" id="refine" open/.test(html));
  assert.match(html, /<details class="feedback sheet-host" id="feedback">/);
  // It is an overlay sheet with a backdrop and an explicit close control.
  assert.match(html, /class="result-sheet"[\s\S]*?data-sheet-backdrop/);
  assert.match(html, /class="result-sheet-panel refine-sheet" role="group" aria-label="Edit Smart Match filters"/);
  assert.match(html, /data-sheet-close>Close<\/button>/);
  // Every existing control is still inside it, with dietary read-only and linked to Profile.
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
  // The panel is positioned against the phone shell, so an open sheet never adds card height and
  // never sits under the bottom navigation.
  assert.match(css, /\.result-sheet \{ position:absolute; inset:0; z-index:2000; \}/,
    'the sheet sits above the Leaflet map panes and its full-size directions link');
  assert.match(css, /\.result-sheet-panel \{ position:absolute;[^}]*bottom:0;/);
  assert.match(css, /\.result-sheet-panel \{[^}]*env\(safe-area-inset-bottom\)/);
  assert.match(css, /details\[open\]>\.sheet-trigger/, 'the open state is visible on the trigger');
  // A filling transform animation on the card would make it the sheet's containing block, and its
  // overflow:hidden would then cut the panel off halfway down the screen.
  assert.match(css, /\.match-card\.reveal \{ animation-fill-mode:none; \}/,
    'the card reveal animation must not keep filling a transform');
});

test('LAYOUT 2b: the sheets keep working from the keyboard', async function() {
  const js = CLIENT_JS();
  // <details>/<summary> is natively keyboard operable; the script only adds sheet behaviour.
  assert.match(js, /key !== 'Escape'/, 'Escape closes an open sheet');
  assert.match(js, /data-sheet-backdrop\], \[data-sheet-close\]/, 'backdrop and Close both close it');
  assert.match(js, /trigger\.focus\(\)/, 'focus returns to the trigger');
  assert.match(js, /first\.focus\(\{ preventScroll: true \}\)/, 'focus moves into the panel on open');
  assert.match(js, /closeOpenSheets\(host, false\)/, 'only one sheet is open at a time');
  const css = CSS();
  assert.match(css, /button:focus-visible,a:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible \{ outline:3px solid/,
    'the trigger keeps a visible focus indicator');
});

// LAYOUT 3 -------------------------------------------------------------------------------------
test('LAYOUT 3: photo, map and spacing are viewport-aware instead of fixed', async function() {
  const css = CSS();
  assert.match(css, /--result-thumb:\d+px/);
  assert.match(css, /--result-map-h:clamp\(/, 'the map height is a clamp(), not one fixed value');
  // A wide rectangle with a readable height at every shell size, never a thin banner: a floor, a
  // viewport-aware basis and a ceiling, with the map taking the card's spare height.
  assert.match(css, /--result-map-h:clamp\(110px,/, 'the map has a floor and a viewport-aware basis');
  assert.match(css, /\.screen:has\(\.match-card\) \.match-map-wrap \{ flex:50 1 var\(--result-map-h\); min-height:var\(--result-map-min\); max-height:var\(--result-map-max\); \}/);
  assert.match(css, /\.screen:has\(\.match-card\) \.match-card \{ flex:1 0 auto;/,
    'the card grows into spare height, and never shrinks to avoid a scrollbar');
  assert.match(css, /\.screen:has\(\.match-card\) #smart-match \{[^}]*margin-bottom:16px;/,
    'the card-to-navigation gap is an explicit margin, so it survives scrolling too');
  assert.match(css, /\.match-map-wrap \.match-map \{ height:var\(--result-map-h\);/);
  assert.match(css, /\.result-photo \{[^}]*aspect-ratio:1 \/ 1;/, 'the photo square never distorts');
  assert.match(css, /\.result-photo img \{[^}]*object-fit:cover;/);
  assert.match(css, /\.result-photo\.is-empty \.result-photo-fallback \{ display:grid; \}/,
    'a missing photo keeps the polished monogram fallback');
  // Compact rules are scoped to the screen that shows a result card.
  assert.match(css, /\.screen:has\(\.match-card\) \{/);
  assert.ok(!/\boverflow:hidden\b/.test(css.split('.screen:has(.match-card)')[1].split('}')[0]),
    'scrolling is never disabled on the result screen');
  assert.match(css, /\.screen \{ min-height:0; overflow-y:auto;/, 'the screen still scrolls as a fallback');
  // Touch targets stay tappable.
  assert.match(css, /\.sheet-trigger \{[^}]*min-height:44px;/);
  assert.match(css, /\.button \{[^}]*min-height:52px;/);
  assert.match(css, /\.navigation \{[^}]*padding:6px 10px 26px;/);
  assert.match(css, /\.navigation \{ padding-bottom:calc\(6px \+ env\(safe-area-inset-bottom\)\); \}|padding-bottom:calc\(6px \+ env\(safe-area-inset-bottom\)\)/,
    'the bottom navigation respects the safe area');
});

test('LAYOUT 3b: long dynamic text is clamped, but conditions are never truncated', async function() {
  const v = visitor();
  await card(v);
  await v.change(function(demo) {
    const merchant = demo.nearbyMerchants.find(function(m) { return m.id === demo.selectedMerchantId; });
    merchant.merchantName = 'Super Extraordinarily Long Hawker Merchant Name With Many Many Words Indeed Stall 47B';
    demo.selectedMerchantReason = 'This candidate fits your craving far better than every other listed option nearby, ' +
      'and it is still comfortably inside the walking range you asked for today.';
  });
  const html = (await v.request('/smart-match/result')).html;
  // The name renders in full, with its title attribute intact.
  assert.match(html, /<h2 title="Super Extraordinarily Long Hawker Merchant Name[^"]*">Super Extraordinarily Long Hawker Merchant Name[^<]*<\/h2>/);
  // The reason keeps its full text in the title attribute next to the clamped visible line.
  assert.match(html, /class="result-why-text" title="This candidate fits your craving far better[^"]*"/);
  // The reward conditions are plain text with no clamp applied.
  assert.match(html, /Spend \$\d+\.\d\d\+ · Pay with NETS · Credit usable only at Super Extraordinarily Long/);
  const css = CSS();
  assert.ok(!/\.result-info h2 \{[^}]*line-clamp/.test(css), 'the merchant name is never clamped');
  assert.match(css, /\.result-why-text \{[^}]*-webkit-line-clamp:2;/);
  assert.ok(!/\.match-card \.reward[^{]*\{[^}]*line-clamp/.test(css),
    'reward conditions are never line-clamped');
});

test('LAYOUT 3c: an exceptionally long name scrolls the result instead of being clipped', async function() {
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
  // The whole name is in the document - no ellipsis, no "More" affordance, nothing dropped.
  assert.ok(html.includes('>' + longName + '</h2>'), 'the complete name is rendered');
  const heading = html.match(/<h2 title="[^"]*">([^<]*)<\/h2>/);
  assert.equal(heading[1], longName, 'the heading text is the whole name, with no ellipsis');
  // Every action and the full reward conditions are still present for the user to scroll to.
  assert.match(html, /Choose this/);
  assert.match(html, /Not for me/);
  assert.match(html, /Edit filters/);
  assert.match(html, new RegExp('Credit usable only at ' + longName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  const css = CSS();
  // Scrolling is a consequence of content height, not of any name-length detection.
  assert.ok(!/merchantName\.length|nameLength/.test(CLIENT_JS()), 'no JavaScript measures the name');
  assert.match(css, /\.screen \{ min-height:0; overflow-y:auto; -webkit-overflow-scrolling:touch;/,
    'the one scroll area keeps momentum scrolling');
  assert.match(css, /\.screen \{[^}]*scroll-padding:/, 'focused controls are scrolled clear of the edges');
  assert.match(css, /\.screen:has\(\.match-card\) \.match-card \{ flex:1 0 auto;/,
    'the card grows into spare height but is never compressed to avoid a scrollbar');
  assert.match(css, /\.screen:has\(\.match-card\) \.match-map-wrap \{[^}]*min-height:var\(--result-map-min\);/,
    'the map keeps a readable floor instead of collapsing into a banner');
  assert.match(css, /--result-map-min:\d+px/);
  // Only the content area scrolls - the shell rows stay put.
  assert.match(css, /\.status-bar \{ grid-row:1; \} \.app-header \{ grid-row:2; \} \.screen \{ grid-row:3; \} \.navigation \{ grid-row:4; \}/);
  assert.ok(!/\.match-copy \{[^}]*overflow-y:(auto|scroll)/.test(css), 'no nested scroll area inside the card');
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
  await v.request('/smart-match/location', { latitude: 1.4428, longitude: 103.7854 });
  await v.request('/smart-match/result');          // warms the one photo lookup
  const result = await v.request('/smart-match/result');
  assert.match(result.html, /data-merchant-id="google-/, 'a real provider merchant is recommended');
  return result.html;
}

test('LAYOUT 3d: a real provider result keeps every part inside the card', async function() {
  const html = await providerCard(visitor(), PROVIDER_NAME);
  // Everything the provider supplies is present and whole.
  assert.ok(html.includes('>' + PROVIDER_NAME + '</h2>'));
  assert.ok(!/diet-tag/.test(html), 'no dietary badge without an active preference');
  assert.match(html, /class="result-photo-credit">Photo: <a/, 'owner attribution is rendered');
  assert.match(html, /<img src="\/smart-match\/photo\//, 'the provider photo is rendered');
  assert.ok(html.includes('data-address="' + PROVIDER_ADDRESS + '"'), 'the full address reaches the map');
  assert.match(html, /class="result-why-text" title="[^"]+"/, 'the composed explanation is rendered');
  assert.match(html, /Pay with NETS · Credit usable only at /);
  assert.match(html, /Choose this/);
  assert.match(html, /Not for me/);
  assert.match(html, /Edit filters/);

  const css = CSS();
  // Nothing in the card may hold itself at max-content width: these are the rules that keep the
  // provider's own text inside its own section.
  assert.match(css, /\.match-copy \{[^}]*min-width:0;/);
  assert.match(css, /\.screen:has\(\.match-card\) \.match-copy \{ flex:1 1 auto; min-width:0;/,
    'the card content column must be allowed to shrink to the card width');
  assert.match(css, /\.result-info \{ flex:1; min-width:0;/);
  assert.match(css, /\.result-meta \{ display:flex; flex-wrap:wrap;/, 'category and distance may wrap');
  assert.match(css, /\.result-tags \{ display:flex; flex-wrap:wrap;/, 'Vouches and dietary badges wrap as a group');
  assert.match(css, /\.result-photo-credit \{[^}]*overflow-wrap:anywhere;/);
  assert.match(css, /\.match-card \.reward \{[^}]*overflow-wrap:anywhere;/);
  assert.match(css, /\.result-why-text \{[^}]*overflow-wrap:anywhere;/);
  assert.match(css, /\.result-secondary \{ display:flex; flex-wrap:wrap;/, 'the two actions stack rather than clip');
  assert.match(css, /\.result-secondary \.sheet-host \{ flex:1 1 120px; min-width:0; \}/);
  assert.match(css, /\.sheet-trigger \{[^}]*min-height:44px;/, 'touch targets stay 44px');
  assert.match(css, /\.mood-chip \{ position:relative;/, 'the hidden radio cannot escape its chip');
  // The map popup is bound to the map's own width in script.js, not Leaflet's 300px default.
  const js = CLIENT_JS();
  assert.match(js, /const popupMaxWidth = Math\.max\(150, Math\.round\(el\.clientWidth\) - 48\);/);
  assert.match(js, /maxWidth: popupMaxWidth/);
  assert.match(css, /\.map-popup \.leaflet-popup-content \{[^}]*overflow-wrap:anywhere;/,
    'a long address wraps inside the popup');
  // The fallback for oversized content is vertical only - no part of the result card scrolls
  // sideways. (The merchant report's own charts are deliberately horizontally scrollable and are
  // not part of this screen.)
  const resultRules = css.split('Smart Match RESULT card')[1].split('Business Report page')[0];
  assert.ok(!/overflow-x:(auto|scroll)/.test(resultRules), 'no horizontal scroll area in the result card');
  assert.match(css, /\.screen \{ min-height:0; overflow-y:auto;/, 'the screen scrolls vertically only');
});

test('LAYOUT 3e: an 80-100 character provider name still stays inside the card', async function() {
  const longName = 'Pondok Angah Nasi Padang Muslim Food Stall and Traditional Halal Kitchen Woodlands 02';
  assert.ok(longName.length >= 80 && longName.length <= 100);
  const html = await providerCard(visitor(), longName);
  assert.ok(html.includes('>' + longName + '</h2>'), 'the whole name is rendered');
  assert.match(html, /Choose this/);
  assert.match(html, /Edit filters/);
  const css = CSS();
  assert.match(css, /\.result-info h2 \{[^}]*overflow-wrap:anywhere; \}/,
    'an unbroken name breaks inside the word rather than widening the card');
});

// LAYOUT 4 -------------------------------------------------------------------------------------
test('LAYOUT 4: the special result states still render their own content', async function() {
  const v = visitor();
  const merchantId = (await card(v)).match(/data-merchant-id="([^"]+)"/)[1];

  // Accepted: the primary action becomes "Scan when you arrive" and the rejection stays available.
  await v.request('/recommendation/accept', { merchantId: merchantId });
  const accepted = (await v.request('/smart-match/result')).html;
  assert.match(accepted, /Heading to /);
  assert.match(accepted, /href="\/scan">Scan when you arrive/);
  assert.match(accepted, /Changed your mind\?/);
  assert.match(accepted, /Edit filters/);

  // Campaign unavailable: the truthful "offer has ended" status replaces the reward strip.
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
  await v.request('/smart-match/location', { status: 'fallback' });
  // An impossible budget empties the pool - the empty state is allowed to be as tall as it needs.
  await v.request('/profile', { budget: '1', maxDistanceMinutes: '1', craving: '', moodCuisine: 'any' });
  const empty = (await v.request('/smart-match/result')).html;
  assert.match(empty, /No spots nearby right now/);
  assert.match(empty, /Adjust filters/);
  assert.match(empty, /name="craving"/);
  assert.match(empty, /Dietary: <strong>No dietary restriction<\/strong>/);
  assert.match(empty, /Widen distance by 5 minutes/);
  const css = CSS();
  assert.match(css, /\.refine-prefs--flat \.refine-sheet \{ padding:/,
    'the empty state keeps its inline disclosure instead of an overlay');
});
