const { database: db, counters } = require('./helpers/test-isolation.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { start } = require('./helpers/visitor.cjs');
const { seedTask3Merchants, seedMenu } = require('./helpers/task7-menu-fixtures.cjs');
const googleServices = require('../google-services');
const { getNearbyMerchants } = require('../app');

// Task 9: guaranteed-zero-cost Google mode. The isolation harness opts the OLD mocked suites in (so they stay
// technical evidence); these tests clear that opt-in and prove the real default is OFF and that no Google or
// Foursquare request can happen. Every key below is a decoy string; nothing here reaches a provider.
const ROOT = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');
const originalFetch = global.fetch;
const ORIGIN = { latitude: 1.3012345, longitude: 103.8123456 };
const NOTICE = 'RP demo mode · estimated distances, not walking times · fictional sample data.';
const DECOYS = { GOOGLE_MAPS_BROWSER_API_KEY: 'decoy-browser-key-9a1', GOOGLE_ROUTES_API_KEY: 'decoy-routes-key-7b2',
  GOOGLE_PLACES_API_KEY: 'decoy-places-key-5c3', FOURSQUARE_API_KEY: 'decoy-foursquare-key-3d4' };
const MANAGED = ['GOOGLE_SERVICES_ENABLED', 'PLACES_PROVIDER'].concat(Object.keys(DECOYS));
const saved = {};
let calls;
let http;

function setEnv(values) {
  MANAGED.forEach(name => delete process.env[name]);
  Object.keys(values || {}).forEach(name => { process.env[name] = values[name]; });
}
test.before(async () => {
  MANAGED.forEach(name => { saved[name] = process.env[name]; });
  http = await start();
});
test.beforeEach(() => {
  seedTask3Merchants(db); seedMenu(db);
  calls = [];
  global.fetch = async function(url) { calls.push(String(url)); return { ok: false, status: 500, json: async () => ({}) }; };
});
test.afterEach(() => { global.fetch = originalFetch; });
test.after(async () => {
  MANAGED.forEach(name => { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; });
  await http.close();
  assert.deepEqual(counters, { envLoads: 0, privateReads: 0, mysqlFactories: 0, redisFactories: 0, blockedConnections: 0 });
});

const SCENARIOS = [
  ['no Google variables at all', {}],
  ['decoy keys, no master switch', DECOYS],
  ['decoy keys, blank switch', Object.assign({ GOOGLE_SERVICES_ENABLED: '' }, DECOYS)],
  ['decoy keys, switch "false"', Object.assign({ GOOGLE_SERVICES_ENABLED: 'false' }, DECOYS)],
  ['decoy keys, switch "TRUE"', Object.assign({ GOOGLE_SERVICES_ENABLED: 'TRUE' }, DECOYS)],
  ['decoy keys, switch "1"', Object.assign({ GOOGLE_SERVICES_ENABLED: '1' }, DECOYS)],
  ['decoy keys, switch " true"', Object.assign({ GOOGLE_SERVICES_ENABLED: ' true' }, DECOYS)],
  ['decoy keys, switch "true "', Object.assign({ GOOGLE_SERVICES_ENABLED: 'true ' }, DECOYS)],
  ['decoy keys, switch "yes"', Object.assign({ GOOGLE_SERVICES_ENABLED: 'yes' }, DECOYS)],
  ['decoy keys, switch "true;"', Object.assign({ GOOGLE_SERVICES_ENABLED: 'true;' }, DECOYS)]
];
const DAY = '?diningDate=2026-11-17&diningTime=12:00';
const noCoordinates = html => !/1\.3012345|103\.8123456|\b1\.\d{5,}\b|\b103\.\d{5,}\b/.test(html);

SCENARIOS.forEach(([label, values]) => {
  test('S$0 default-off (' + label + '): zero provider calls, RP demo mode works, live paths fail safely', async () => {
    setEnv(values);
    ['browserMapsEnabled', 'routesEnabled', 'legacyPlacesEnabled', 'foursquareDiscoveryEnabled'].forEach(name => assert.equal(googleServices[name](), false, name));
    const v = http.visitor();

    const home = (await v.request('/home')).html;
    assert.ok(home.includes(NOTICE), 'the always-visible RP demo notice');
    assert.match(home, /<div class="origin-pill origin-pill--static" data-origin-static>[\s\S]*<strong>RP demo origin<\/strong>/);
    for (const forbidden of ['maps.googleapis.com', 'data-maps-browser-key', 'data-origin-device', 'data-origin-place', 'data-origin-toggle',
      'data-origin-panel', 'Use my location', 'Search for a place', 'google.com/maps', 'decoy-']) assert.equal(home.includes(forbidden), false, forbidden);
    assert.equal(/<script[^>]+google/i.test(home), false);
    assert.ok(noCoordinates(home));

    const api = await v.request('/api/recommend' + DAY);
    assert.equal(api.status, 200);
    const before = JSON.stringify([(await v.state()).demo.catalogueBatch, (await v.state()).demo.lastApiRecommendations]);
    const first = JSON.parse(api.html);
    assert.ok(first.recommendations.length >= 1, 'RP demo mode still recommends');
    first.recommendations.forEach(card => { assert.equal(card.travel, undefined); assert.equal(/google/i.test(JSON.stringify(card)), false); });

    const live = await v.request('/api/recommend/live', Object.assign({ location: ORIGIN, budget: 10, maxDistance: 60, diningDate: '2026-11-17', diningTime: '12:00' }));
    assert.equal(live.status, 503);
    assert.equal(JSON.parse(live.html).error.code, 'walking-routes-not-configured');
    const natural = await v.request('/api/recommend/natural', { text: 'chicken rice', location: ORIGIN });
    assert.ok([400, 503].includes(natural.status), 'natural-language with a location fails safely: ' + natural.status);
    assert.equal(JSON.parse(natural.html).recommendations, undefined);
    assert.equal(JSON.stringify([(await v.state()).demo.catalogueBatch, (await v.state()).demo.lastApiRecommendations]), before, 'batch and feedback tokens survive failed live requests');

    // Legacy discovery, continuation, widening, photo.
    for (const [method, url] of [['GET', '/smart-match/result'], ['GET', '/smart-match/static'], ['POST', '/recommendation/try-again'],
      ['POST', '/recommendation/widen-distance'], ['POST', '/recommendation/next'], ['GET', '/smart-match/photo/google-ChIJdecoy']]) {
      const r = method === 'GET' ? await v.request(url) : await v.request(url, {});
      assert.ok(r.status < 500, url + ' -> ' + r.status);
      assert.equal(/maps\/dir|maps.googleapis|google\.com/i.test(r.html), false, url + ' renders no Google link');
      assert.ok(noCoordinates(r.html), url);
    }
    const nearby = await getNearbyMerchants({ latitude: 1.4428, longitude: 103.7854 }, 'task9', 'chicken rice', 10, 'none', 'any');
    assert.equal(nearby.source, 'local-fallback', 'RP fictional demo data remains the only source');

    // Scan, payment, receipt, Vouch carry no coordinates and no Google content.
    await v.request('/scan');
    const scan = await v.request('/scan', { merchantId: 'felicia-chicken-rice' });
    assert.ok(scan.location && scan.location.startsWith('/scan/payment'));
    const payment = await v.request('/scan/payment');
    const journey = (await v.state()).demo.currentScanPayment;
    const paid = await v.request('/scan/payment', { journeyId: journey.id, amount: '6.00' });
    const transaction = (await v.state()).demo.transactions[0];
    const receipt = await v.request('/payment-success/' + transaction.id);
    const vouch = await v.request('/vouch/' + transaction.id);
    for (const page of [await v.request('/scan'), payment, receipt, vouch, await v.request('/home')]) {
      assert.ok(page.status === 200 || page.status === 302, String(page.status));
      assert.ok(noCoordinates(page.html));
      assert.equal(/maps\/dir|maps.googleapis|data-google-route/.test(page.html), false);
    }
    assert.ok(paid.location);
    assert.equal(/1.3012345|103.8123456/.test(JSON.stringify(await v.state())), false, 'the submitted origin is not kept in session state');
    assert.deepEqual(calls, [], 'zero outbound requests of any kind (no Google, no Foursquare)');
  });
});

test('the real default is OFF: nothing in the application source or config enables it', () => {
  setEnv({});
  assert.equal(googleServices.switchOn(), false);
  for (const file of ['app.js', 'google-services.js', 'walking-routes.js', 'smart-match-result.js', 'vercel.json', 'package.json']) {
    assert.equal(/GOOGLE_SERVICES_ENABLED['"]?\s*[:=]\s*['"]?true/.test(read(file)), false, file + ' must not default the switch on');
  }
  const startup = googleServices.startupMessages({});
  assert.deepEqual(startup, ['Google services disabled (S$0 mode)']);
  assert.match(read('tests/helpers/test-isolation.cjs'), /GOOGLE_SERVICES_ENABLED = 'true'/, 'the harness opt-in is explicit and documented');
});

test('helpers return booleans only; warnings and startup messages carry variable names but never values, prefixes or lengths', () => {
  const env = Object.assign({}, DECOYS);
  ['switchOn', 'browserMapsEnabled', 'routesEnabled', 'legacyPlacesEnabled', 'foursquareDiscoveryEnabled'].forEach(name => assert.equal(typeof googleServices[name](env), 'boolean'));
  const lines = googleServices.startupMessages(env);
  assert.equal(lines[0], 'Google services disabled (S$0 mode)');
  assert.deepEqual(googleServices.ignoredKeyNames(env).sort(), Object.keys(DECOYS).sort());
  const text = lines.join('\n');
  Object.keys(DECOYS).forEach(name => assert.ok(text.includes(name)));
  Object.values(DECOYS).forEach(value => {
    assert.equal(text.includes(value), false);
    assert.equal(text.includes(value.slice(0, 5)) && /decoy/.test(text), false, 'no prefix');
    assert.equal(text.includes(value.slice(-4)), false, 'no suffix');
    assert.equal(new RegExp('\\b' + value.length + '\\b').test(text), false, 'no length');
  });
  assert.equal(googleServices.ignoredKeyNames(Object.assign({ GOOGLE_SERVICES_ENABLED: 'true' }, DECOYS)).length, 0);
  assert.equal(/console\.|logDiscovery/.test(read('google-services.js')), false, 'the module never logs');
  assert.equal(/loadEnvFile|readFile|require\('node:fs'\)|require\('fs'\)/.test(read('google-services.js').replace(/\/\/.*$/gm, '')), false, 'no .env access');
});

test('enabled mode is explicit and per-capability: the switch alone is not enough, and each key unlocks only its own capability', () => {
  assert.equal(googleServices.routesEnabled({ GOOGLE_SERVICES_ENABLED: 'true' }), false);
  assert.equal(googleServices.routesEnabled({ GOOGLE_SERVICES_ENABLED: 'true', GOOGLE_ROUTES_API_KEY: '  ' }), false);
  const env = { GOOGLE_SERVICES_ENABLED: 'true', GOOGLE_ROUTES_API_KEY: 'x' };
  assert.equal(googleServices.routesEnabled(env), true);
  assert.equal(googleServices.browserMapsEnabled(env), false);
  assert.equal(googleServices.legacyPlacesEnabled(env), false);
  assert.equal(googleServices.foursquareDiscoveryEnabled(env), false);
  assert.equal(googleServices.legacyPlacesEnabled({ GOOGLE_SERVICES_ENABLED: 'true', GOOGLE_PLACES_API_KEY: 'x' }), true);
});

test('enabled mode (explicit) keeps the Step 6 live interface; the switch is what gates legacy discovery', async () => {
  setEnv({ GOOGLE_SERVICES_ENABLED: 'true', GOOGLE_ROUTES_API_KEY: DECOYS.GOOGLE_ROUTES_API_KEY });
  const home = (await http.visitor().request('/home')).html;
  assert.match(home, /data-origin-panel/);
  assert.match(home, /data-origin-device>Use my location<\/button>/);
  assert.equal(home.includes(NOTICE), false);
  assert.equal(home.includes('decoy-'), false, 'the routes key never reaches the page');
  // The switch is what stops the legacy provider: with it on (and a key) discovery reaches the (recorded) provider...
  setEnv({ GOOGLE_SERVICES_ENABLED: 'true', GOOGLE_PLACES_API_KEY: DECOYS.GOOGLE_PLACES_API_KEY });
  await getNearbyMerchants({ latitude: 1.4428, longitude: 103.7854 }, 'task9', '', 10, 'none', 'any');
  assert.ok(calls.some(url => /places\.googleapis\.com/.test(url)), 'the harness can see a Google request when it is explicitly enabled');
  // ...and with it off, the same key makes none.
  calls.length = 0;
  setEnv({ GOOGLE_PLACES_API_KEY: DECOYS.GOOGLE_PLACES_API_KEY, FOURSQUARE_API_KEY: DECOYS.FOURSQUARE_API_KEY });
  await getNearbyMerchants({ latitude: 1.4428, longitude: 103.7854 }, 'task9', '', 10, 'none', 'any');
  assert.deepEqual(calls, []);
});

test('the browser never requests geolocation, loads Google, or builds a directions link in S$0 mode', async () => {
  setEnv(DECOYS);
  const home = (await http.visitor().request('/home')).html;
  assert.equal(home.includes('data-origin-panel'), false);
  const script = read('public/js/script.js');
  const section = script.slice(script.indexOf('const originModule = (function() {'), script.indexOf('// Natural-language request'));
  const accessed = [];
  const context = vm.createContext({
    document: { querySelector: () => null, querySelectorAll: () => [] },
    navigator: new Proxy({}, { get(_, key) { accessed.push(String(key)); return undefined; } }),
    window: {}, URL, URLSearchParams, String, Number, Array, Map
  });
  vm.runInContext(section + '\nthis.module = originModule;', context);
  assert.deepEqual(accessed, [], 'no geolocation (or any navigator) access when the panel is absent');
  assert.equal(context.module.isLive(), false);
  assert.deepEqual(JSON.parse(JSON.stringify(context.module.withLocation({ a: 1 }))), { a: 1 });
  // Static structure: geolocation lives only in requestLiveOrigin, which only useDevice calls, which is bound inside `if (panel)`.
  assert.equal((script.match(/navigator\.geolocation/g) || []).length, 2);
  assert.equal((script.match(/requestLiveOrigin\(/g) || []).length, 2);
  assert.match(script, /if \(panel\) \{\s*panel\.querySelector\('\[data-origin-device\]'\)\.addEventListener\('click', useDevice\)/);
  assert.equal((script.match(/maps\.googleapis\.com/g) || []).length, 1, 'the Maps loader exists once, inside usePlace');
  assert.equal((script.match(/google\.com\/maps\/dir/g) || []).length, 1, 'the directions builder exists once and needs a live origin');
  // Cards: no map, no directions link, no Google content.
  const card = (await http.visitor().request('/api/recommend' + DAY)).html;
  assert.equal(/maps\/dir|google/i.test(card), false);
});

test('Google-ready code is dormant, not removed', () => {
  assert.match(read('walking-routes.js'), /computeRouteMatrix/);
  assert.match(read('app.js'), /places\.googleapis\.com\/v1\/places:searchNearby/);
  assert.match(read('app.js'), /async function discoverWithFoursquare/);
  assert.match(read('smart-match-result.js'), /ensureMerchantPhoto/);
});
