require('./helpers/test-isolation.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../public/js/script.js'), 'utf8');
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(source.slice(source.indexOf('function escHtml('), source.indexOf('async function loadMatch(')), sandbox);

const card = { id: 'exact-id', merchantName: 'Fixture outlet', itemName: null, price: 0,
  source: 'mysql', isSampleData: true, distanceMinutes: 1,
  distanceLabel: 'Approx. 80 m from demo origin (catalogue estimate)', dietary: ['vegan'],
  campaign: { rewardAmount: 0, minimumEligibleSpend: 0, rewardLabel: 'Vouch Credit' } };

test('cards show numeric zero prices without invented dishes and label estimates/sample data', () => {
  const html = sandbox.renderRecCard(card);
  assert.match(html, /Typical price: <strong>\$0\.00<\/strong>/);
  assert.match(html, /Earn \$0\.00/); assert.match(html, /Spend \$0\.00/);
  assert.match(html, /from demo origin \(catalogue estimate\)/); assert.match(html, /Sample catalogue data/);
  assert.doesNotMatch(html, /min away|GPS|route|Try:/);
});

test('unknown prices are unavailable, never claimed within budget', () => {
  const html = sandbox.renderRecCard({ ...card, price: null });
  assert.match(html, /Typical price: unavailable/); assert.doesNotMatch(html, /within.*budget|Typical price: <strong>\$0/);
});

test('catalogue strings are escaped in text and attributes', () => {
  const html = sandbox.renderRecCard({ ...card, id: '"><img src=x onerror=alert(1)>',
    merchantName: '<script>bad()</script>', distanceLabel: '<img src=x>',
    campaign: { ...card.campaign, rewardLabel: '<b>credit</b>' } });
  assert.doesNotMatch(html, /<script|<img|<b>credit/);
  assert.match(html, /&quot;&gt;&lt;img/); assert.match(html, /&lt;script&gt;/);
});

test('empty catalogue and filtered-empty responses display distinct honest states', () => {
  const empty = sandbox.renderRecommendationList([], { source: 'mysql', status: 'empty' });
  assert.match(empty, /No merchants in the catalogue/); assert.doesNotMatch(empty, /widening|demo merchants/);
  const filtered = sandbox.renderRecommendationList([], { source: 'mysql', status: 'ok' });
  assert.match(filtered, /No matches for your filters/); assert.doesNotMatch(filtered, /Catalogue unavailable/);
});

test('outage notice identifies demo fallback even when it has no eligible cards', () => {
  for (const recommendations of [[], [{ ...card, source: 'local-fallback' }]]) {
    const html = sandbox.renderRecommendationList(recommendations, { source: 'demo-fallback', status: 'unavailable' });
    assert.match(html, /Catalogue unavailable.*showing demo merchants/);
  }
});

test('catalogue loading does not request browser GPS', () => {
  const loader = source.slice(source.indexOf('async function loadMatch('), source.indexOf('function initMerchantMap('));
  assert.doesNotMatch(loader, /await prepareDiscoveryLocation\(/);
});
