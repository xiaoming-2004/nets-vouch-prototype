const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app, clearDiscoveryCache, clearMerchantResearchCache, clearSearchIntentCache,
  resetMerchantCampaigns } = require('../app');
const result = require('../smart-match-result');

// Smart Match RESULT presentation: the business's own photo (Google Place Photos via a server proxy),
// a stable demo Vouch count, and the tappable location map. Display only - never ranking.
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
  clearMerchantResearchCache();
  clearSearchIntentCache();
  result.clearMerchantPhotoCache();
  trackedKeys.forEach(function(key) { delete process.env[key]; });
  global.fetch = originalFetch;
});
test.afterEach(function() { global.fetch = originalFetch; });

const USER = { latitude: 1.4428, longitude: 103.7854 };
const PLACE_A = 'ChIJAAAAAAAAAAAAAAAAAAAAAAA';
const PLACE_B = 'ChIJBBBBBBBBBBBBBBBBBBBBBBB';
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');

function googleMerchant(placeId, extra) {
  return Object.assign({ id: 'google-' + placeId, providerPlaceId: placeId, source: 'GOOGLE',
    merchantName: 'Neutral Noodle Stall', coordinates: { latitude: 1.4473, longitude: 103.7856 } }, extra || {});
}
// Default author = the business itself (an owner upload). Pass a person's name for a customer photo.
function photo(placeId, suffix, w, h, authorName) {
  return { name: 'places/' + placeId + '/photos/' + suffix, widthPx: w, heightPx: h,
    authorAttributions: [{ displayName: authorName || 'Neutral Noodle Stall', uri: '//maps.google.com/maps/contrib/123' }] };
}
function params(url) { return new URL(url).searchParams; }

// Mocks Google discovery (one merchant), Place Details (photos) and Place Photos media.
function mockGoogle(options) {
  options = options || {};
  const calls = { details: [], media: [], search: 0 };
  const place = { id: PLACE_A, displayName: { text: 'Neutral Noodle Stall' }, primaryType: 'noodle_shop',
    types: ['noodle_shop', 'restaurant', 'food', 'point_of_interest', 'establishment'],
    formattedAddress: '1 Example Road, Singapore', location: { latitude: 1.4473, longitude: 103.7856 } };
  global.fetch = async function(url, init) {
    const target = String(url);
    if (target.endsWith(':searchNearby') || target.endsWith(':searchText')) {
      calls.search += 1;
      return { ok: true, json: async function() { return { places: [place] }; } };
    }
    if (target.indexOf('https://places.googleapis.com/v1/places/') === 0 && target.indexOf('/media') === -1) {
      calls.details.push({ url: target, headers: init.headers });
      if (options.details === 'fail') return { ok: false, status: 500 };
      return { ok: true, json: async function() { return { photos: options.photos || [] }; } };
    }
    if (target.indexOf('/media?') !== -1) {
      calls.media.push({ url: target, headers: init.headers });
      return { ok: true, headers: new Map([['content-type', 'image/png']]), arrayBuffer: async function() { return PNG; } };
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
    const type = response.headers.get('content-type') || '';
    return { status: response.status, type: type,
      html: /^image\//.test(type) ? '' : await response.text() };
  } };
}

async function matched(location) {
  process.env.GOOGLE_PLACES_API_KEY = 'places-server-secret-9f2c';
  const v = visitor();
  await v.request('/home');
  await v.request('/profile', { dietaryPreference: 'none', budget: '10', maxDistanceMinutes: '10', craving: '', moodCuisine: 'any' });
  await v.request('/smart-match/location', location || USER);
  const page = await v.request('/smart-match/result');
  assert.equal(page.status, 200);
  assert.match(page.html, /data-merchant-id="google-/);
  return { v: v, html: page.html };
}

// --- Merchant photo ---------------------------------------------------------------------------

test('PHOTO A/B: a Google merchant with photo metadata gets ITS photo, served by the server proxy', async function() {
  const calls = mockGoogle({ photos: [photo(PLACE_A, 'p1', 1200, 900)] });
  const { v, html } = await matched();
  assert.equal(calls.details.length, 1, 'one Place Details lookup for the selected merchant only');
  assert.match(calls.details[0].url, new RegExp('/v1/places/' + PLACE_A + '$'));
  assert.equal(calls.details[0].headers['X-Goog-FieldMask'], 'photos', 'minimal field mask');
  assert.match(html, new RegExp('<img src="/smart-match/photo/google-' + PLACE_A + '"'));
  const image = await v.request('/smart-match/photo/google-' + PLACE_A);
  assert.equal(image.status, 200);
  assert.equal(image.type, 'image/png');
  assert.match(calls.media[0].url, new RegExp('/v1/places/' + PLACE_A + '/photos/p1/media\\?maxWidthPx=480&maxHeightPx=480'));
});

test('PHOTO C: another merchant\'s photo can never be selected or served', async function() {
  const place = googleMerchant(PLACE_A);
  global.fetch = async function() {
    return { ok: true, json: async function() { return { photos: [photo(PLACE_B, 'foreign', 1000, 1000)] }; } };
  };
  assert.equal(await result.ensureMerchantPhoto(place, 'k'), null, 'a photo resource of a different place is rejected');
  const calls = mockGoogle({ photos: [photo(PLACE_A, 'p1', 800, 800)] });
  const { v } = await matched();
  assert.equal((await v.request('/smart-match/photo/google-' + PLACE_B)).status, 404, 'only the currently selected merchant');
  assert.equal((await v.request('/smart-match/photo/felicia-chicken-rice')).status, 404);
  assert.equal(calls.media.length, 0);
});

test('PHOTO selection: first square-friendly photo in Google order; extreme panoramas skipped', async function() {
  global.fetch = async function() {
    return { ok: true, json: async function() { return { photos: [
      photo(PLACE_A, 'panorama', 4000, 800), photo(PLACE_A, 'tiny', 120, 120), photo(PLACE_A, 'good', 1600, 1200), photo(PLACE_A, 'later', 900, 900)
    ] }; } };
  };
  const chosen = await result.ensureMerchantPhoto(googleMerchant(PLACE_A), 'k');
  assert.equal(chosen.name, 'places/' + PLACE_A + '/photos/good');
});

test('PHOTO D/H: no photo or a failed lookup -> clean placeholder, Smart Match still renders', async function() {
  mockGoogle({ photos: [] });
  let page = await matched();
  assert.ok(!/<img src="\/smart-match\/photo/.test(page.html));
  assert.match(page.html, /class="result-photo is-empty"/);
  assert.match(page.html, /Choose this/);
  result.clearMerchantPhotoCache();
  clearDiscoveryCache();
  mockGoogle({ details: 'fail' });
  page = await matched();
  assert.match(page.html, /class="result-photo is-empty"/);
  assert.match(page.html, /Choose this/);
  // Non-Google merchants never trigger a photo lookup.
  assert.equal(await result.ensureMerchantPhoto(googleMerchant(PLACE_A, { source: 'FOURSQUARE' }), 'k'), null);
});

test('PHOTO E: the thumbnail is a square that crops with object-fit:cover (never stretched)', function() {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'style.css'), 'utf8');
  assert.match(css, /\.result-photo \{[^}]*aspect-ratio:1 \/ 1;[^}]*overflow:hidden;/);
  assert.match(css, /\.result-photo img \{[^}]*width:100%; height:100%; object-fit:cover; object-position:center;/);
});

test('PHOTO F: Google author attribution is rendered with the photo', async function() {
  mockGoogle({ photos: [photo(PLACE_A, 'p1', 1000, 1000)] });
  const { html } = await matched();
  assert.match(html, /class="result-photo-credit">Photo: <a href="https:\/\/maps\.google\.com\/maps\/contrib\/123"[^>]*>Neutral Noodle Stall<\/a>/);
});

test('PHOTO owner-only: customer photos are never shown; the business\'s own photo is preferred', async function() {
  const merchant = googleMerchant(PLACE_A);
  global.fetch = async function() {
    return { ok: true, json: async function() { return { photos: [
      photo(PLACE_A, 'customer1', 1200, 1200, 'Chew Jian Qiang'), photo(PLACE_A, 'customer2', 1000, 1000, 'A Local Guide'),
      photo(PLACE_A, 'owner', 1000, 1000, 'Neutral Noodle Stall')
    ] }; } };
  };
  assert.equal((await result.ensureMerchantPhoto(merchant, 'k')).name, 'places/' + PLACE_A + '/photos/owner');
  result.clearMerchantPhotoCache();
  global.fetch = async function() {
    return { ok: true, json: async function() { return { photos: [photo(PLACE_A, 'customer', 1200, 1200, 'Chew Jian Qiang')] }; } };
  };
  assert.equal(await result.ensureMerchantPhoto(merchant, 'k'), null, 'only customer photos -> no photo');
  result.clearMerchantPhotoCache();
  clearDiscoveryCache();
  mockGoogle({ photos: [photo(PLACE_A, 'customer', 1200, 1200, 'Chew Jian Qiang')] });
  const { html } = await matched();
  assert.match(html, /class="result-photo is-empty"/, 'the neutral placeholder is shown instead');
  assert.ok(!/Chew Jian Qiang/.test(html));
});

test('PHOTO G: the server Places key never appears in HTML or client JS', async function() {
  process.env.GROQ_API_KEY = 'groq-secret-77ab';
  mockGoogle({ photos: [photo(PLACE_A, 'p1', 1000, 1000)] });
  const { v, html } = await matched();
  const pages = [html];
  for (const page of ['/home', '/js/script.js', '/scan', '/profile']) pages.push((await v.request(page)).html);
  const all = pages.join('\n');
  assert.ok(!all.includes('places-server-secret-9f2c'));
  assert.ok(!all.includes('groq-secret-77ab'));
  assert.ok(!all.includes('X-Goog-Api-Key'));
});

// --- Demo Vouch count --------------------------------------------------------------------------

test('VOUCH I/J: the demo Vouch count is stable per merchant, in range, and differs between merchants', function() {
  const a = result.demoVouchCount('google-' + PLACE_A);
  assert.equal(result.demoVouchCount('google-' + PLACE_A), a);
  const counts = new Set();
  for (let i = 0; i < 40; i++) {
    const n = result.demoVouchCount('google-merchant-' + i);
    assert.ok(n >= 20 && n <= 300, String(n));
    counts.add(n);
  }
  assert.ok(counts.size > 20, 'different merchants produce different demo counts');
});

test('VOUCH K: no per-render randomness; the rendered count is identical across refreshes', async function() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'smart-match-result.js'), 'utf8');
  assert.ok(!/Math\.random/.test(source));
  mockGoogle({ photos: [] });
  const { v, html } = await matched();
  const first = html.match(/(\d+) Vouches<\/span>/)[1];
  const again = (await v.request('/home')).html.match(/(\d+) Vouches<\/span>/)[1];
  assert.equal(first, again);
  assert.equal(Number(first), result.demoVouchCount('google-' + PLACE_A));
  assert.ok(!/★|rating|Top rated|Most popular/i.test(html.split('data-merchant-id')[1]));
});

test('VOUCH L: the demo Vouch count is display-only and never reaches ranking', function() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  const uses = source.split('demoVouchCount(').length - 1;
  assert.equal(uses, 1, 'used once, in the display helper');
  const helper = source.slice(source.indexOf('function smartMatchResultDisplay'), source.indexOf('function applyPendingReferralCredits'));
  assert.ok(helper.includes('demoVouchCount('));
  const ranking = source.slice(source.indexOf('function buildRankingMessages'), source.indexOf('function getEligibleMerchants'));
  assert.ok(!/demoVouch|Vouches/.test(ranking));
});

// --- Walking map --------------------------------------------------------------------------------

test('MAP M/N/O/P/Q/R: tapping the map opens walking directions from the user to the selected merchant', function() {
  const directions = result.buildWalkingDirections(USER, googleMerchant(PLACE_A));
  const maps = params(directions.mapsUrl);
  assert.equal(new URL(directions.mapsUrl).href.split('?')[0], 'https://www.google.com/maps/dir/');
  assert.equal(maps.get('api'), '1');
  assert.equal(maps.get('travelmode'), 'walking');
  assert.equal(maps.get('origin'), '1.4428,103.7854');
  assert.equal(maps.get('destination'), '1.4473,103.7856');
  assert.equal(maps.get('destination_place_id'), PLACE_A);
  assert.ok(!directions.mapsUrl.includes('google-' + PLACE_A), 'never the internal google- ID');
  assert.ok(!/key=/.test(directions.mapsUrl), 'no API key needed or exposed');
  const fsq = result.buildWalkingDirections(USER, googleMerchant('4bd0116aa8b3a5934a43635f', { source: 'FOURSQUARE' }));
  assert.equal(params(fsq.mapsUrl).get('destination_place_id'), null);
});

test('MAP S: the location map is in the card and the whole map is a Google Maps link', async function() {
  mockGoogle({ photos: [] });
  const { html } = await matched();
  assert.match(html, /<div class="match-map" data-lat="1\.4473" data-lng="103\.7856" data-name="Neutral Noodle Stall"/);
  const link = html.match(/<a class="match-map-open" href="([^"]+)"/);
  assert.ok(link, 'overlay link covering the map');
  const href = link[1].replace(/&amp;/g, '&');
  assert.equal(params(href).get('travelmode'), 'walking');
  assert.equal(params(href).get('origin'), '1.4428,103.7854');
  assert.equal(params(href).get('destination_place_id'), PLACE_A);
  assert.match(html, /Open in Google Maps/);
  assert.ok(!/<iframe/.test(html), 'no embedded Google map or browser key needed');
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'style.css'), 'utf8');
  assert.match(css, /\.match-map-open \{ position:absolute; inset:0; z-index:1000;/, 'the link covers the whole map');
});

test('MAP T/U: missing or malformed coordinates fail gracefully; no user location still opens Maps', function() {
  assert.equal(result.buildWalkingDirections(USER, googleMerchant(PLACE_A, { coordinates: null })), null);
  assert.equal(result.buildWalkingDirections(USER, googleMerchant(PLACE_A, { coordinates: { latitude: 'x', longitude: 1 } })), null);
  const noOrigin = result.buildWalkingDirections(null, googleMerchant(PLACE_A));
  assert.equal(params(noOrigin.mapsUrl).get('origin'), null, 'Google Maps routes from the device instead');
  assert.equal(params(noOrigin.mapsUrl).get('travelmode'), 'walking');
});

test('MAP V: no map is loaded before a Smart Match result exists', async function() {
  const v = visitor();
  const fresh = await v.request('/home');
  assert.ok(!/match-map|maps\/dir/.test(fresh.html));
  await v.request('/profile', { dietaryPreference: 'none', budget: '10', maxDistanceMinutes: '10', craving: '', moodCuisine: 'any' });
  const loading = await v.request('/home');
  assert.match(loading.html, /data-load-match/);
  assert.ok(!/match-map|maps\/dir/.test(loading.html));
});

test('MAP W: no walking time is calculated - Google renders the route, distance and time', function() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'smart-match-result.js'), 'utf8');
  assert.ok(!/distanceMinutes|distanceMetres|\/ ?80\b|minute/i.test(source.slice(source.indexOf('// Walking directions'), source.indexOf('// Merchant photo'))));
  assert.ok(!/\d+\.\d{3,}/.test(source), 'no hardcoded coordinates');
  const card = fs.readFileSync(path.join(__dirname, '..', 'views', 'smart-match-card.ejs'), 'utf8');
  assert.ok(!/min walk|minute walk/.test(card));
});

// --- Header layout + halal tag -----------------------------------------------------------------

test('HEADER: no "Your match"/"AI Matched" line; name, details and tags sit beside the image', async function() {
  mockGoogle({ photos: [] });
  const { html } = await matched();
  assert.ok(!/Your match|AI Matched/.test(html));
  assert.match(html, /<div class="result-head">\s*<div class="result-photo is-empty">[\s\S]*<div class="result-info">\s*<h2 title="Neutral Noodle Stall">Neutral Noodle Stall<\/h2>/);
  assert.match(html, /<p class="result-meta"><span class="result-lead">Noodle Shop<\/span><span class="result-distance">\d+ m away<\/span><\/p>/);
  assert.match(html, /<p class="result-tags"><span class="result-vouches"/);
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'style.css'), 'utf8');
  assert.match(css, /\.result-photo \{[^}]*flex:0 0 76px; width:76px; aspect-ratio:1 \/ 1;/);
  assert.match(css, /\.result-info \{[^}]*min-height:76px; display:flex; flex-direction:column; justify-content:space-between;/);
  assert.match(css, /-webkit-line-clamp:2/, 'long names are clamped to two lines');
});

test('HALAL: curated merchants use their own records - green Halal / orange Non-halal', async function() {
  const v = visitor();
  await v.request('/home');
  await v.request('/profile', { dietaryPreference: 'none', budget: '10', maxDistanceMinutes: '10', craving: '', moodCuisine: 'any' });
  await v.request('/smart-match/location', { status: 'fallback' });
  const html = (await v.request('/smart-match/result')).html;
  assert.match(html, /data-merchant-id="woodlands-noodle-bar"/);
  assert.match(html, /<span class="halal-tag halal-tag--non-halal">Non-halal<\/span>/);
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'style.css'), 'utf8');
  assert.match(css, /\.halal-tag--halal \{ background:var\(--success-bg\); color:var\(--success\); \}/, 'halal is green');
  assert.match(css, /\.halal-tag--non-halal \{ background:#fff1e6; color:#b45309; \}/, 'non-halal is orange');
  await v.request('/recommendation/reject', { merchantId: 'woodlands-noodle-bar', reason: 'not-in-mood' });
  await v.request('/profile', { dietaryPreference: 'halal', budget: '10', maxDistanceMinutes: '10', craving: '', moodCuisine: 'any' });
  const halal = (await v.request('/smart-match/result')).html;
  assert.match(halal, /<span class="halal-tag halal-tag--halal">Halal<\/span>/);
});

test('HALAL: the tag is final when the card appears - no pending state, never guessed', async function() {
  mockGoogle({ photos: [] });
  const { html } = await matched();
  // No Tavily key -> no evidence -> honest "not verified" (not "Non-halal", not "Halal"), already in the card.
  assert.match(html, /<span class="halal-tag halal-tag--unknown">Halal not verified<\/span>/);
  assert.ok(!/Checking halal|data-halal-url/.test(html));
  const script = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'script.js'), 'utf8');
  assert.ok(!/halal/i.test(script), 'no client-side delayed halal fetch');
});

test('SPEED: slow halal research never holds the result longer than the 0.5 s extras cap', async function() {
  process.env.TAVILY_API_KEY = 'test-tavily';
  process.env.GROQ_API_KEY = 'test-groq';
  const calls = mockGoogle({ photos: [] });
  const googleFetch = global.fetch;
  let tavilyCalls = 0;
  global.fetch = function(url, init) {
    if (new URL(String(url)).hostname === 'api.tavily.com') {
      tavilyCalls += 1;
      return new Promise(function() {}); // research hangs
    }
    return googleFetch(url, init);
  };
  const started = Date.now();
  const { html } = await matched();
  const elapsed = Date.now() - started;
  assert.equal(tavilyCalls, 1, 'halal research ran for the selected merchant during loading');
  assert.ok(elapsed < 2000, 'photo + halal extras are capped at 0.5 s, took ' + elapsed + ' ms');
  assert.match(html, /<span class="halal-tag halal-tag--unknown">Halal not verified<\/span>/);
  assert.equal(calls.search >= 1, true);
});

test('HALAL: the tag is display-only and never read by ranking', function() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  assert.equal(source.split('resultHalalTag(').length - 1, 3, 'definition + display helper + loading-time check');
  const ranking = source.slice(source.indexOf('async function getSmartRecommendation'), source.indexOf('function getMatchReasons'));
  assert.ok(!/resultHalalTag|halal-tag/.test(ranking));
});
