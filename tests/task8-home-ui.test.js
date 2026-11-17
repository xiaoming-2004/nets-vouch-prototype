const { counters } = require('./helpers/test-isolation.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ejs = require('ejs');
const { start } = require('./helpers/visitor.cjs');

// Task 8: mobile-first Home inside an iPhone-style presentation frame, a modal matching sheet, solid chips,
// collapsed one-column recommendation cards, friendly states, accessibility and responsive CSS.
const ROOT = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');
const css = read('public/css/style.css');
const script = read('public/js/script.js');
const WARNING = 'Walking routes are in beta and may be missing clear sidewalks or pedestrian paths. Use caution.';

let http;
test.before(async () => { http = await start(); });
test.after(async () => {
  await http.close();
  assert.deepEqual(counters, { envLoads: 0, privateReads: 0, mysqlFactories: 0, redisFactories: 0, blockedConnections: 0 });
});

function clientApi() {
  const sandbox = { String, Number, Array, Math, Object, URL, URLSearchParams };
  vm.createContext(sandbox);
  vm.runInContext(script.slice(script.indexOf('function escHtml('), script.indexOf('async function loadMatch(')) +
    '\nthis.api = { renderRecCard, renderRecommendationList, stateCardHtml, renderGoogleRoute };', sandbox);
  return sandbox.api;
}
const LIVE = { id: 'm1', merchantName: 'Green Bowl', price: 7.5, typicalPrice: 7.5, source: 'mysql', isSampleData: true,
  distanceLabel: null, dietary: ['halal'], feedbackToken: 't', usualActivity: { status: 'available', comparison: 'quieter' },
  matchReasons: ['Matches your rice choice exactly.'], campaign: { rewardAmount: 0.5, rewardLabel: 'Vouch Credit', minimumEligibleSpend: 5 },
  recommendedMenuItem: { name: 'Chicken Rice', price: 5, label: 'Fictional sample item · dietary claims unverified', dietary: { halal: true } },
  travel: { walkingMinutes: 6, walkingMetres: 410, warning: WARNING } };

test('Home hierarchy: frame, landmarks, skip link, header, greeting, start pill, results, filters; one h1', async () => {
  const v = http.visitor();
  const html = (await v.request('/home')).html;
  const at = s => { const i = html.indexOf(s); assert.ok(i >= 0, s); return i; };
  assert.ok(at('class="skip-link"') < at('<div class="stage">'));
  assert.ok(at('<div class="stage">') < at('<div class="status-bar" aria-hidden="true">'));
  assert.ok(at('<div class="status-bar"') < at('<header class="app-header">'));
  assert.ok(at('<header class="app-header">') < at('<main class="main" id="main"'));
  assert.ok(at('<main class="main" id="main"') < at('class="greeting"'));
  assert.ok(at('class="greeting"') < at('data-origin-toggle'));
  assert.ok(at('data-origin-toggle') < at('id="smart-match"'));
  assert.ok(at('id="smart-match"') < at('data-filters-panel'));
  assert.ok(at('</main>') < at('<footer class="app-footer">') && at('<footer class="app-footer">') < at('<nav class="navigation" aria-label="Primary navigation">'));
  assert.ok(at('<nav class="navigation"') < at('<span class="home-indicator" aria-hidden="true">'));
  assert.equal((html.match(/<h1[ >]/g) || []).length, 1, 'one h1');
  assert.match(html, /<summary class="avatar" aria-label="Account menu">/);
  assert.match(html, /<button class="match-bar__edit" type="button" data-sheet-open aria-haspopup="dialog">Edit match<\/button>/);
});

test('every decorative phone element is hidden from assistive technology', async () => {
  const html = (await http.visitor().request('/home')).html;
  const frame = html.slice(html.indexOf('<div class="stage">'), html.indexOf('<header class="app-header">'));
  assert.equal((frame.match(/<span class="device-button[^>]*aria-hidden="true">/g) || []).length, 4);
  assert.match(frame, /<div class="status-bar" aria-hidden="true">/);
  assert.match(html, /<span class="home-indicator" aria-hidden="true"><\/span>/);
  assert.equal(/<div class="status-bar"[^>]*>[\s\S]*?(<a |<button|tabindex)/.test(frame), false, 'nothing focusable inside the decorative status bar');
});

test('the matching sheet is a modal dialog with the reference content, opened automatically on a first visit', async () => {
  const html = (await http.visitor().request('/home')).html;
  const modal = html.slice(html.indexOf('<div class="sheet-modal"'), html.indexOf('<header class="greeting">'));
  assert.match(modal, /<div class="sheet-modal" data-match-modal data-modal-auto="true" hidden>/);
  assert.match(modal, /role="dialog" aria-modal="true" aria-labelledby="sheet-title" tabindex="-1" data-modal-panel/);
  assert.match(modal, /<p class="sheet-eyebrow">Hi Jia 👋<\/p>/);
  assert.match(modal, /<h2 class="sheet-title" id="sheet-title">What are you in the mood for\?<\/h2>/);
  assert.match(modal, /<label for="nl-text">What are you craving\?<\/label>/);
  assert.match(modal, /<legend class="chip-title" id="food-chip-title">Or pick a type<\/legend>/);
  assert.match(modal, /<legend class="chip-title" id="diet-chip-title">Any dietary requirements\?<\/legend>/);
  assert.match(modal, /data-nl-submit>Find my match<\/button>/);
  assert.match(modal, /data-modal-close aria-label="Close matching sheet"/);
  assert.equal((modal.match(/data-chip-value=/g) || []).length, 10);
  assert.deepEqual([...modal.matchAll(/class="chip" data-chip-value="[^"]+" aria-pressed="[a-z]+">([^<]+)</g)].map(m => m[1]),
    ['Anything', 'Rice dishes', 'Noodles', 'Healthy bowls', 'Indian food', 'Wraps', 'No dietary restriction', 'Halal', 'Vegetarian', 'Vegan']);
  assert.equal(/Ticked choices are your defaults|AI interprets your words/.test(html.replace(modal, '')), false, 'helper paragraphs are gone from the main screen');
  assert.match(modal, /<details class="about-search"><summary>About this search<\/summary>[\s\S]*AI interprets your words; fixed rules choose merchants[\s\S]*your saved profile is not changed/);
  assert.match(html, /<h2>Ready to find lunch\?<\/h2>[\s\S]*data-sheet-open[^>]*>Find food<\/button>/);
  const returning = http.visitor();
  await returning.request('/home');
  await returning.request('/profile', { budget: '10', maxDistanceMinutes: '10', craving: '', moodCuisine: 'any' });
  const later = (await returning.request('/home')).html;
  assert.match(later, /data-modal-auto="false"/, 'a returning visitor sees results, not the sheet');
  assert.match(later, /data-load-match/);
});

test('the modal controller traps focus, closes with Escape or the backdrop and returns focus; storage use is optional', () => {
  const block = script.slice(script.indexOf('const matchModal = (function() {'), script.indexOf('// Result bottom sheets'));
  assert.match(block, /backgrounds\(\)\.forEach\(function\(element\) \{ element\.inert = true; \}\)/, 'the rest of the app is inert while open');
  assert.match(block, /event\.key === 'Escape'\) \{ event\.preventDefault\(\); close\(true\)/);
  assert.match(block, /event\.key !== 'Tab'/);
  assert.match(block, /last\.focus\(\)/);
  assert.match(block, /first\.focus\(\)/);
  assert.match(block, /closest\('\[data-modal-close\]'\)\) close\(true\)/, 'backdrop and close button');
  assert.match(block, /target\.focus\(\{ preventScroll: true \}\)/, 'focus returns to the opener');
  assert.ok(block.includes("try { return window.sessionStorage.getItem('vouchai-sheet-seen') === '1'; } catch (error) { return false; }"));
  assert.ok(block.includes("try { window.sessionStorage.setItem('vouchai-sheet-seen', '1'); } catch (error)"));
  assert.match(script, /matchModal\.markSeen\(\);\s*matchModal\.close\(true\);\s*await loadMatch\(false\);/, 'searching closes the sheet');
  assert.equal(/localStorage|document\.cookie|indexedDB|console\./.test(block), false);
  const chipBlock = script.slice(script.indexOf('const chipState = (function() {'), script.indexOf("if (nlForm) nlForm.addEventListener('submit'"));
  assert.equal(/sessionStorage|localStorage|document\.cookie|indexedDB/.test(chipBlock), false, 'chip state stays in memory only');
});

test('the starting point is one compact pill that expands; the privacy explanation is in an information panel', async () => {
  const html = (await http.visitor().request('/home')).html;
  assert.match(html, /<button class="origin-pill" type="button" data-origin-toggle aria-expanded="false" aria-controls="origin-choices">/);
  assert.match(html, /<strong data-origin-pill>RP demo origin<\/strong>/);
  const panel = html.slice(html.indexOf('data-origin-panel'), html.indexOf('</section>', html.indexOf('data-origin-panel')));
  assert.match(panel, /<details class="origin-info"><summary>About starting points and privacy<\/summary>/);
  assert.ok(panel.indexOf('it is not saved') > panel.indexOf('origin-info'));
  for (const hook of ['data-origin-device', 'data-origin-place', 'data-origin-demo', 'data-origin-search', 'data-origin-status', 'data-origin-mode']) assert.ok(panel.includes(hook), hook);
  assert.match(panel, /<p class="origin-status" data-origin-status role="status" aria-live="polite" hidden>/);
  assert.match(script, /pillEl\.textContent = !origin \? 'RP demo origin' : source === 'device' \? 'Current location'/);
  assert.match(script, /if \(message && isError\) expand\(true\)/);
});

test('food and dietary choices keep their groups, hooks and payload behaviour', async () => {
  const html = (await http.visitor().request('/home')).html;
  assert.match(html, /<fieldset class="chip-group" role="group" aria-labelledby="food-chip-title" data-chip-group="food" data-chip-default="any">/);
  assert.match(html, /<fieldset class="chip-group" role="group" aria-labelledby="diet-chip-title" data-chip-group="dietary" data-chip-default="none">/);
  assert.equal((html.match(/aria-pressed="true"/g) || []).length, 2, 'only the two untouched defaults are pressed');
  assert.equal((html.match(/data-nl-submit>Find my match<\/button>/g) || []).length, 1);
  assert.match(script, /chipState\.params\(query\);\s*return '\?' \+ query\.toString\(\);/);
  assert.match(script, /originModule\.withLocation\(Object\.assign\(\{ text: text \}, chipState\.params\(\{\}\)\)\)/);
});

test('advanced controls are collapsed under "Edit filters" below the results, with summary chips and unchanged fields', async () => {
  const html = (await http.visitor().request('/home')).html;
  const panel = html.slice(html.indexOf('<details class="filters-panel"'), html.indexOf('</details>', html.indexOf('<details class="filters-panel"')));
  assert.ok(!/<details class="filters-panel"[^>]* open/.test(html), 'collapsed by default');
  assert.ok(html.indexOf('id="smart-match"') < html.indexOf('<details class="filters-panel"'));
  assert.match(panel, /<span class="filters-summary__title">Edit filters<\/span>/);
  assert.match(panel, /<span class="filter-chips" aria-label="Current filters"><span class="filter-chip">No dietary restriction<\/span><span class="filter-chip">≤ \$\d+<\/span><span class="filter-chip" data-filter-time><\/span>/);
  assert.match(panel, /<form class="dining-time-form" data-dining-time-form>[\s\S]*id="dining-date-time" name="diningDateTime" type="datetime-local"/);
  assert.match(panel, /<form class="filters-form" method="POST" action="\/profile">[\s\S]*name="budget"[\s\S]*name="maxDistanceMinutes"/);
  assert.ok(!/name="(craving|moodCuisine|dietaryPreference|notifications)"/.test(panel));
  assert.match(css, /\.filters-panel \.button \{ background:var\(--surface\); color:var\(--brand-navy\);/, 'Update matches does not compete with Find my match');
});

test('the collapsed client card follows the reference order; reasons and disclosures sit in "Why this match?"', () => {
  const card = clientApi().renderRecCard(LIVE);
  const order = ['<h3 class="rec-name">Green Bowl</h3><p class="sample-label">Fictional sample merchant</p>', 'Recommended: Chicken Rice', 'data-google-route',
    '<p class="rec-badges">', 'rec-activity', 'class="rec-reward"', 'Choose this', 'Not for me', '<details class="why-match">'];
  let last = -1;
  for (const piece of order) { const i = card.indexOf(piece); assert.ok(i > last, piece + ' out of order'); last = i; }
  const [collapsed, details] = card.split('<details class="why-match">');
  assert.match(collapsed, /<p class="rec-reward"><strong>Earn \$0\.50 Vouch Credit<\/strong><span>Once daily · Spend \$5\.00\+<\/span><\/p>/);
  assert.match(collapsed, /Fictional sample item · dietary claims unverified\. A recommendation, not a purchase\./);
  assert.match(collapsed, /<p class="rec-badges"><span class="rec-tag">Halal<\/span><\/p>/);
  assert.match(collapsed, /Usually quieter at this time based on fictional sample history\./);
  assert.equal(/Matches your rice choice exactly/.test(collapsed), false);
  assert.match(details, /Matches your rice choice exactly\./);
  assert.match(details, /Sample catalogue data: fictional merchants, menus and prices; dietary claims are unverified\./);
  assert.match(details, /Walking times come from Google Maps[^<]*not a Google place\./);
  assert.equal(/match-map|leaflet/i.test(card), false, 'no merchant map');
  assert.equal(/purchased|you ordered|bought it/i.test(card), false);
});

test('RP demo mode shows a compact labelled distance panel, never a map or a directions link', () => {
  const api = clientApi();
  const demo = api.renderRecCard(Object.assign({}, LIVE, { travel: undefined, distanceLabel: 'Approx. 150 m from demo origin (catalogue estimate)' }));
  assert.match(demo, /<div class="demo-distance"><svg class="demo-distance__icon" viewBox="0 0 24 24" aria-hidden="true">[\s\S]*<strong>RP demo distance<\/strong><span>Approx\. 150 m from demo origin \(catalogue estimate\)<\/span>/);
  assert.equal(/Google Maps|data-google-route|maps\/dir|match-map|data-directions-slot/.test(demo), false);
  assert.match(css, /\.demo-distance \{[^}]*min-height:52px;/);
});

test('Google attribution and the walking warning stay visible whenever route facts are visible', async () => {
  const api = clientApi();
  const card = api.renderRecCard(LIVE);
  const route = card.indexOf('data-google-route');
  assert.ok(route >= 0 && route < card.indexOf('<details class="why-match">'));
  const block = card.slice(route, card.indexOf('</span></span>', card.indexOf('google-route__warning')));
  assert.match(block, /translate="no">Google Maps<\/span>/);
  assert.ok(block.includes(WARNING));
  assert.match(card, /data-directions-slot="m1"/);
  assert.equal(/maps\/dir|origin=/.test(card), false, 'no directions URL or origin is rendered');
  const html = await ejs.renderFile(path.join(ROOT, 'views/smart-match-card.ejs'), serverLocals({ travel: { walkingMinutes: 6, walkingMetres: 410 } }));
  assert.ok(html.indexOf('data-google-route') < html.indexOf('<details class="why-match">'));
  assert.ok(html.includes(WARNING) && html.includes('translate="no">Google Maps</span>'));
  assert.equal(/<div class="match-map"|maps\/dir/.test(html), false);
});

function serverLocals(extra) {
  return Object.assign({
    recommendation: Object.assign({ id: 'felicia-chicken-rice', merchantName: 'Felicia\'s <b>Chicken Rice</b>', source: 'mysql', isSampleData: true, price: 5,
      distanceLabel: 'Approx. 180 m from demo origin (catalogue estimate)', cuisine: 'rice', category: 'rice', feedbackToken: 'tok',
      usualActivity: { status: 'available', comparison: 'quieter' }, matchReasons: ['A <script>reason</script>'], itemName: null,
      recommendedMenuItem: { name: 'Roasted <i>Chicken</i> Rice', price: 5, label: 'Fictional sample item · dietary claims unverified' } }, extra),
    resultDisplay: {}, matchExplanation: 'Within your walking range.', locationNotice: false, recommendationAccepted: false, dailyRewardEarned: false,
    rewardCreditText: (amount, label) => '$' + amount.toFixed(2) + ' ' + label, dietaryTagLabel: '', walkingWarning: WARNING,
    campaign: { rewardAmount: 0.8, rewardLabel: 'Vouch Credit', minimumEligibleSpend: 5 },
    rejectionReasons: [{ id: 'too-far', label: 'Too far' }], profile: null
  });
}

test('the server-rendered card is collapsed, ordered, labelled, escaped and keeps the recommendation wording', async () => {
  const html = await ejs.renderFile(path.join(ROOT, 'views/smart-match-card.ejs'), serverLocals({}));
  const [collapsed, rest] = html.split('<details class="why-match">');
  assert.match(collapsed, /class="sample-label">Fictional sample merchant</);
  assert.match(collapsed, /<div class="demo-distance">/);
  assert.match(collapsed, /Recommended: Roasted &lt;i&gt;Chicken&lt;\/i&gt; Rice · \$5\.00/);
  assert.match(collapsed, /This is a recommendation, not a record of what you bought\./);
  assert.match(collapsed, /Spend \$5\.00\+ · Simulated payment · Credit usable only at /);
  assert.ok(collapsed.indexOf('Choose this') < collapsed.indexOf('Not for me'), 'Choose this, then Not for me, then Why this match?');
  assert.equal(/A <script>|<b>Chicken|<i>Chicken/.test(html), false, 'no HTML injection');
  assert.match(rest, /A &lt;script&gt;reason&lt;\/script&gt;/);
  assert.match(rest, /Sample catalogue data: fictional merchants, menus and prices; dietary claims are unverified\./);
  assert.match(rest, /Distances are estimates from the RP demo origin, not real walking times\./);
});

test('error and empty states are friendly: one explanation, one recovery action, no codes or provider detail', () => {
  const api = clientApi();
  const states = [
    api.renderRecommendationList([], { source: 'mysql', status: 'empty' }),
    api.renderRecommendationList([], { source: 'mysql', status: 'ok' }, { request: { foodCategory: 'indian' } }),
    api.renderRecommendationList([], { source: 'mysql', status: 'ok' }, { request: {} })
  ];
  for (const html of states) {
    assert.equal((html.match(/data-state-card/g) || []).length, 1);
    assert.equal((html.match(/<button class="button"/g) || []).length, 1, 'exactly one primary action');
    const text = html.replace(/<[^>]+>/g, ' ');
    assert.equal(/\b(?:[a-z]+-){2,}[a-z]+\b/.test(text), false, 'no kebab-case codes');
    assert.equal(/SQL|mysql|Groq|Google|error code|undefined|null/i.test(text), false);
  }
  assert.match(states[0], /No merchants to show yet/);
  assert.match(states[1], /data-clear-food>Clear food choice/);
  assert.match(states[2], /data-open-filters>Edit filters/);
  assert.match(script, /error\.code === 'menu-catalogue-unavailable'/);
  assert.match(script, /The sample menu isn\\'t available right now/);
  assert.match(script, /data-retry-match>Try again/);
  const messages = [];
  for (const name of ['ORIGIN_MESSAGES', 'NL_ERROR_MESSAGES']) {
    const block = script.slice(script.indexOf('const ' + name), script.indexOf('};', script.indexOf('const ' + name)));
    block.split('\n').forEach(line => { const m = line.match(/:\s*'(.*)',?$/); if (m) messages.push(m[1]); });
  }
  assert.ok(messages.length >= 20);
  messages.forEach(text => {
    assert.equal(/\b(?:[a-z]+-){2,}[a-z]+\b/.test(text), false, text);
    assert.equal(/SQL|stack|exception|API key|HTTP \d|status \d/i.test(text), false, text);
  });
  assert.match(script, /'menu-catalogue-unavailable': \['Use Anything', 'anything'\]/);
});

test('chips: solid red selected, light-grey unselected, external focus ring, no dashed or dotted selected state', () => {
  const rule = selector => { const all = [...css.matchAll(new RegExp('(?:^|\\n)' + selector.replace(/[.[\]":()]/g, '\\$&') + '\\s*\\{([^}]*)\\}', 'g'))]; assert.ok(all.length, selector); return all.map(m => m[1]).join(' '); };
  assert.match(rule('.chip[aria-pressed="true"]'), /background:var\(--brand-red\); border-color:var\(--brand-red\); color:#fff/);
  assert.match(rule('.chip'), /background:#f3f5f8; border:1px solid #dfe4ea; color:var\(--brand-navy\)/);
  assert.match(rule('.chip:focus-visible'), /outline:3px solid var\(--focus\); outline-offset:3px/);
  assert.match(rule('.chip[aria-pressed="true"]:focus-visible'), /outline-color:var\(--brand-navy\)/, 'focus looks different from selected');
  assert.match(css, /\.chip\[aria-pressed="true"\]::before \{ content:"\\2713";/, 'non-colour selection cue');
  assert.match(rule('.chip'), /min-height:44px/);
  assert.equal(/\.chip[^{]*\{[^}]*(dashed|dotted)/.test(css), false);
  assert.match(css, /\.chip-grid--food \{ grid-template-columns:repeat\(3,/);
  assert.match(css, /\.chip-grid--diet \{ grid-template-columns:repeat\(2,/);
  assert.match(css, /@media \(max-width:340px\) \{ \.chip-grid--food \{ grid-template-columns:repeat\(3,/, 'wraps sensibly at 320px');
});

test('one card per row at every width; reward panel, CTA and subtle Not for me match the reference', () => {
  assert.equal(/\.rec-list \{[^}]*grid-template-columns:\s*repeat\(2/.test(css), false);
  assert.equal(/@media \(min-width:[0-9]+px\) \{ \.rec-list/.test(css), false);
  assert.match(css, /\.rec-list \{ display:flex; flex-direction:column; gap:14px; \}/);
  assert.match(css, /\.rec-reward,\.match-card \.reward \{[^}]*background:var\(--brand-red-soft\);/);
  assert.match(css, /\.rec-reward strong,\.match-card \.reward \{ font-size:15px; color:var\(--brand-red\); \}/);
  assert.match(css, /\.rec-card \.feedback \.sheet-trigger,\.result-secondary \.sheet-trigger \{ border:0; background:none;/);
  assert.match(css, /\.rec-card,\.match-card \{ border-radius:22px;/);
});

test('presentation: framed on large screens, frameless on phones and high zoom, bottom navigation inside the frame', () => {
  assert.match(css, /\.device \{[^}]*width:418px;[^}]*border-radius:64px;/);
  assert.match(css, /\.phone \{[^}]*grid-template-rows:auto auto minmax\(0,1fr\) auto; overflow:hidden;/);
  assert.match(css, /\.navigation \{ grid-row:4; position:relative;[^}]*background:#fff; border-top:1px solid var\(--border\);/);
  assert.match(css, /\.navigation a\[aria-current\] \{ color:var\(--brand-red\); font-weight:750; \}/);
  assert.match(css, /@media not all and \(min-width:700px\) and \(min-height:700px\) \{/);
  assert.match(css, /\.sheet-modal \{ position:absolute; inset:0; z-index:100;/);
  assert.match(css, /@media not all and \(min-width:700px\) and \(min-height:700px\) \{ \.sheet-modal \{ position:fixed; \} \}/);
  assert.match(css, /body\.modal-open \{ overflow:hidden; \}/);
  assert.match(css, /\.skip-link:focus \{ top:12px; \}/);
  assert.match(css, /\.nl-controls input \{[^}]*font-size:16px;/);
  assert.match(css, /@media \(prefers-reduced-motion:reduce\) \{ \*,\*::before,\*::after \{ animation:none!important; transition:none!important;/);
  assert.match(css, /\.back-icon \{ width:44px; height:44px;/);
  assert.match(css, /\.origin-pill \{ min-height:44px;/);
  assert.match(css, /\.why-match__summary \{[^}]*min-height:48px;/);
  assert.match(css, /\.greeting h1 \{ margin:0; font-size:29px;/);
});

test('red primary action, navy text and neutral palette tokens are defined as --brand-*', () => {
  const root = css.slice(css.indexOf(':root {'), css.indexOf('}', css.indexOf(':root {')));
  for (const token of ['--brand-red:#d6212f', '--brand-navy:#0b2a4a', '--app-bg:#f4f5f7', '--surface:#ffffff']) assert.ok(root.includes(token), token);
  assert.equal(/--nets-/.test(css), false);
});

test('the decorative status bar is static markup; no script drives a clock or any phone behaviour', () => {
  assert.equal(/status-time|data-status-time/.test(script), false);
  assert.match(read('views/partials/start.ejs'), /<span class="status-time">/);
});
