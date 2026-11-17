const { counters } = require('./helpers/test-isolation.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { start } = require('./helpers/visitor.cjs');

// Task 8 branding: the application presents itself as "VouchAI - Student prototype". No NETS logo, wordmark or
// derivative is served or rendered, and the plain word NETS may appear only inside the one approved disclaimer.
const ROOT = path.join(__dirname, '..');
const DISCLAIMER = 'Student prototype for demonstration. Not an official NETS application.';
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');
const walk = dir => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })
  .flatMap(entry => entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);

// Removes the approved disclaimer; whatever mentions NETS afterwards is prohibited branding.
const withoutDisclaimer = text => text.split(DISCLAIMER).join('');
const nets = text => withoutDisclaimer(text).match(/\bnets\b/gi) || [];

let http;
test.before(async () => { http = await start(); });
test.after(async () => {
  await http.close();
  assert.deepEqual(counters, { envLoads: 0, privateReads: 0, mysqlFactories: 0, redisFactories: 0, blockedConnections: 0 });
});

const PAGES = ['/welcome', '/home', '/scan', '/profile', '/profile/activity', '/profile/rewards', '/profile/vouches',
  '/profile/dietary', '/merchant?merchantId=felicia-chicken-rice&tab=campaign', '/merchant?merchantId=felicia-chicken-rice&tab=results',
  '/merchant/report?merchantId=felicia-chicken-rice', '/demo'];

test('every application page shows VouchAI, Student prototype and the exact disclaimer, and no other NETS wording', async () => {
  const v = http.visitor();
  await v.request('/home');
  for (const page of PAGES) {
    const { status, html } = await v.request(page);
    assert.equal(status, 200, page);
    assert.ok(html.includes('<span class="brand-name">VouchAI</span><span class="brand-label">Student prototype</span>'), page + ' header identity');
    assert.ok(html.includes('<p class="app-disclaimer">' + DISCLAIMER + '</p>'), page + ' disclaimer');
    assert.equal((html.split(DISCLAIMER).length - 1), 1, page + ' shows the disclaimer exactly once');
    assert.deepEqual(nets(html), [], page + ' contains prohibited NETS wording');
    assert.match(html, /<title>[^<]+ · VouchAI<\/title>/, page + ' title');
    assert.ok(!/<img[^>]+(nets|logo)/i.test(html), page + ' renders no NETS image');
    assert.match(html, /<link rel="icon" type="image\/svg\+xml" href="data:image\/svg\+xml,/, page + ' neutral favicon');
    assert.match(html, /aria-label="VouchAI home"/, page + ' accessible brand name');
    assert.ok(!/aria-label="[^"]*\bnets\b/i.test(html) && !/alt="[^"]*\bnets\b/i.test(html), page + ' accessible names');
  }
});

test('the welcome page uses the neutral text/SVG mark, not an image', async () => {
  const html = (await http.visitor().request('/welcome')).html;
  assert.match(html, /<title>Welcome · VouchAI<\/title>/);
  assert.match(html, /<h1 class="welcome-title">Welcome to VouchAI<\/h1>/);
  assert.match(html, /<div class="welcome-brand"><svg class="brand-mark"/);
  assert.equal(/<img/.test(html), false);
  assert.deepEqual(nets(html), []);
});

test('payment, receipt, Vouch and merchant presentation carry simulated-payment wording only', () => {
  for (const file of walk('views').filter(f => f.endsWith('.ejs'))) {
    const source = read(file);
    const matches = nets(source);
    assert.deepEqual(matches, [], file + ' contains NETS wording');
    assert.equal(/Pay with|Paid with/.test(source), false, file + ' has "Pay with/Paid with" branding');
  }
  for (const phrase of ['Pay (simulated)', 'Processing simulated payment', 'Paid (simulated payment)', 'Simulated payment · Successful',
    'Platform success fee (illustrative)', 'Amounts shown are the amount paid through the prototype']) {
    const found = walk('views').concat(['public/js/script.js']).some(file => read(file).includes(phrase));
    assert.ok(found, phrase);
  }
});

test('client-generated text, share messages and styles carry no NETS wording', () => {
  const script = read('public/js/script.js');
  assert.deepEqual(nets(script), []);
  assert.match(script, /I Vouched for ' \+ shareGrid\.dataset\.shareMerchant \+ ' on VouchAI\. Claim the offer: /);
  assert.match(script, /Processing simulated payment\.\.\./);
  assert.match(script, /Point at a merchant QR code/);
  assert.deepEqual(nets(read('public/css/style.css')), []);
  assert.equal(/--nets-/.test(read('public/css/style.css')), false, 'CSS tokens use the --brand-* names');
});

test('no NETS logo or wordmark asset exists in or is served by the application', async () => {
  const publicFiles = walk('public');
  assert.deepEqual(publicFiles.filter(f => /nets|logo/i.test(path.basename(f))), []);
  assert.equal(publicFiles.some(f => /\.(jpe?g|png|gif|webp|ico)$/i.test(f) && /nets/i.test(f)), false);
  for (const url of ['/images/nets-vouch-ai-logo.jpg', '/images/logo.png', '/favicon.ico', '/manifest.json']) {
    const { status } = await http.visitor().request(url);
    assert.equal(status === 404 || status === 302 || status === 200, true, url);
    if (url.startsWith('/images/')) assert.equal(status, 404, url + ' is not served');
  }
  for (const file of ['views/partials/start.ejs', 'views/welcome.ejs', 'public/css/style.css']) {
    assert.equal(/nets-vouch-ai-logo|\.jpg/.test(read(file)), false, file);
  }
  const mark = read('views/partials/brand-mark.ejs') + read('views/partials/brand-icon.ejs');
  assert.equal(/nets|<text|font-family/i.test(mark), false, 'the mark is a plain geometric SVG, not lettering');
  assert.equal(/#d6212f|#e4002b|#ed1c24|#0033a0/i.test(mark), false, 'no NETS red/blue treatment');
});

test('the disclaimer is the only place the word NETS appears in the application source', () => {
  const sources = walk('views').concat(walk('public')).filter(f => /\.(ejs|js|css|html|json|svg)$/.test(f));
  const offenders = sources.filter(f => nets(read(f)).length);
  assert.deepEqual(offenders, []);
  assert.ok(read('views/partials/end.ejs').includes(DISCLAIMER));
});
