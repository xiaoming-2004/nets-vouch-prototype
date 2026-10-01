const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const ejs = require('ejs');
const { app, demoStore, getMerchantCampaigns, resetMerchantCampaigns, resetReferralCooldowns } = require('../app');

// The merchant Results and Business Report views must never present manufactured activity as real.
// Two kinds of figure exist and may never be added together or mislabelled:
//   LIVE  - only from payments this prototype actually recorded since the last Reset Demo.
//   DEMO  - fixed illustrative sample data, labelled as illustrative wherever it appears.

const isolatedProviderEnv = ['GOOGLE_PLACES_API_KEY', 'PLACES_PROVIDER', 'GROQ_API_KEY', 'OPENAI_API_KEY', 'TAVILY_API_KEY'];
const originalProviderEnv = {};
isolatedProviderEnv.forEach(function(key) { originalProviderEnv[key] = process.env[key]; });
const originalFoursquareKey = process.env.FOURSQUARE_API_KEY;
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
  isolatedProviderEnv.forEach(function(key) {
    if (originalProviderEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalProviderEnv[key];
  });
  if (originalFoursquareKey === undefined) delete process.env.FOURSQUARE_API_KEY;
  else process.env.FOURSQUARE_API_KEY = originalFoursquareKey;
});
test.beforeEach(async function() {
  isolatedProviderEnv.forEach(function(key) { delete process.env[key]; });
  delete process.env.FOURSQUARE_API_KEY;
  resetMerchantCampaigns();
  resetReferralCooldowns();
  await visitor().request('/reset-demo', {});
});

function visitor() {
  let cookie = '';
  return {
    async request(path, body) {
      const response = await fetch(base + path, {
        method: body === undefined ? 'GET' : 'POST', redirect: 'manual',
        headers: { Cookie: cookie, ...(body === undefined ? {} : { 'Content-Type': 'application/x-www-form-urlencoded' }) },
        body: body === undefined ? undefined : new URLSearchParams(body)
      });
      const header = response.headers.get('set-cookie');
      if (header) cookie = header.split(';')[0];
      const html = await response.text();
      assert.ok(response.status < 500, path + ' returned ' + response.status);
      return { status: response.status, location: response.headers.get('location'), html: html };
    },
    async state() {
      const id = decodeURIComponent(cookie.split('=')[1]).slice(2).split('.')[0];
      return new Promise(function(resolve, reject) {
        demoStore.get(id, function(error, data) { if (error) reject(error); else resolve(data); });
      });
    }
  };
}

function campaign(id) {
  return getMerchantCampaigns().find(function(item) { return item.merchantId === id; });
}

async function pay(v, merchantId, amount) {
  await v.request('/scan');
  await v.request('/scan', { merchantId: merchantId });
  const journey = (await v.state()).demo.currentScanPayment;
  await v.request('/scan/payment', { journeyId: journey.id, amount: amount });
  return (await v.state()).demo.transactions[0];
}

function report(v, merchantId) {
  return v.request('/merchant/report?merchantId=' + encodeURIComponent(merchantId));
}
function results(v, merchantId) {
  return v.request('/merchant?merchantId=' + encodeURIComponent(merchantId) + '&tab=results');
}
function liveFeedRowCount(html) {
  return (html.match(/class="feed-row"(?! feed-placeholder)/g) || []).length;
}

// ---------------------------------------------------------------------------
// No fabricated transactions
// ---------------------------------------------------------------------------

test('a report with no recorded payments shows an empty live feed and zeroed live KPIs', async function() {
  const v = visitor();
  await v.request('/home');
  const page = await report(v, 'felicia-chicken-rice');
  assert.equal(page.status, 200);
  assert.equal(liveFeedRowCount(page.html), 0, 'no live feed row may exist without a recorded payment');
  assert.match(page.html, /No payments recorded yet/);
  assert.match(page.html, /No payments have been recorded through this prototype yet/);
  assert.match(page.html, /Payments recorded<\/small><b>0<\/b>/);
  assert.match(page.html, /Gross sales<\/small><b>\$0\.00<\/b>/);
  // With nothing recorded there is no basket to average, so it must not invent one.
  assert.match(page.html, /Avg basket<\/small><b>—<\/b>/);
  assert.match(page.html, /no live channel mix to show/);
});

test('neither report nor dashboard ships a script that manufactures feed rows', async function() {
  const v = visitor();
  await v.request('/home');
  for (const html of [(await report(v, 'felicia-chicken-rice')).html, (await results(v, 'felicia-chicken-rice')).html]) {
    assert.ok(!html.includes('setInterval'), 'no timer may add transactions');
    assert.ok(!html.includes('setTimeout(addRow'), 'no timer may add transactions');
    assert.ok(!html.includes('innerHTML'), 'feed rows must not be built from HTML strings');
    assert.ok(!html.includes('Math.random'), 'feed content must not be randomised in the browser');
    assert.ok(!/var pool = \[/.test(html), 'no sample transaction pool may be sent to the browser');
  }
});

test('the live feed holds exactly the payments that were recorded, in recorded order', async function() {
  const v = visitor();
  await v.request('/home');
  assert.equal(liveFeedRowCount((await report(v, 'felicia-chicken-rice')).html), 0);

  await pay(v, 'felicia-chicken-rice', '6.00');
  let html = (await report(v, 'felicia-chicken-rice')).html;
  assert.equal(liveFeedRowCount(html), 1, 'one payment, one row');

  const second = visitor();
  await second.request('/home');
  await pay(second, 'felicia-chicken-rice', '9.00');
  html = (await report(v, 'felicia-chicken-rice')).html;
  assert.equal(liveFeedRowCount(html), 2, 'two payments, two rows');
  // Newest first, and the amount shown is the NETS-paid portion of each recorded payment.
  assert.ok(html.indexOf('$9.00') < html.indexOf('$6.00'), 'newest recorded payment comes first');
});

test('illustrative seed rows never appear in a live feed, on the report or the dashboard', async function() {
  const v = visitor();
  await v.request('/home');
  // Felicia ships illustrative seed feed rows dated 2026-09-18/19; none may be rendered as live.
  for (const html of [(await report(v, 'felicia-chicken-rice')).html, (await results(v, 'felicia-chicken-rice')).html]) {
    assert.equal(liveFeedRowCount(html), 0, 'seed rows must not render as live payments');
    assert.ok(!html.includes('2026-09-19'), 'a seed row date must not appear in a live feed');
    assert.ok(!html.includes('2026-09-18'), 'a seed row date must not appear in a live feed');
  }
});

// ---------------------------------------------------------------------------
// Live and illustrative figures stay separate
// ---------------------------------------------------------------------------

test('live KPIs count only recorded payments and never borrow the illustrative baseline', async function() {
  const v = visitor();
  await v.request('/home');
  const seedPayments = 494; // Felicia's shipped illustrative baseline.
  const page1 = await report(v, 'felicia-chicken-rice');
  assert.match(page1.html, /Payments recorded<\/small><b>0<\/b>/);
  assert.ok(!/Payments recorded<\/small><b>494<\/b>/.test(page1.html));
  // The baseline is still shown, but in its own labelled card.
  assert.match(page1.html, new RegExp('Sample payments</small><b>' + seedPayments + '</b>'));

  await pay(v, 'felicia-chicken-rice', '6.00');
  const page2 = await report(v, 'felicia-chicken-rice');
  assert.match(page2.html, /Payments recorded<\/small><b>1<\/b>/, 'live count is 1, not 1 + 494');
  assert.match(page2.html, /Gross sales<\/small><b>\$6\.00<\/b>/, 'live sales are the recorded $6.00 only');
  assert.match(page2.html, /Avg basket<\/small><b>\$6\.00<\/b>/);
  assert.match(page2.html, new RegExp('Sample payments</small><b>' + seedPayments + '</b>'),
    'the baseline card is unchanged by a live payment');
});

test('every illustrative section is labelled as sample data wherever it appears', async function() {
  const v = visitor();
  await v.request('/home');
  const html = (await report(v, 'felicia-chicken-rice')).html;
  assert.match(html, /Illustrative baseline/);
  assert.match(html, /fixed sample data/i);
  // Each illustrative chart carries its own label, so a section read on its own is still honest.
  for (const heading of [
    /Illustrative baseline · sample totals/,
    /Illustrative baseline · transactions by hour/,
    /Illustrative baseline · payments across seven sample days/,
    /Illustrative baseline · sample payments by channel/,
    /Illustrative baseline · busiest periods/
  ]) {
    assert.match(html, heading);
  }
  const illustrativeCards = (html.match(/class="card[^"]*is-illustrative/g) || []).length;
  assert.ok(illustrativeCards >= 4, 'illustrative cards must be marked, found ' + illustrativeCards);
});

test('the report claims no date range it cannot support', async function() {
  const v = visitor();
  await v.request('/home');
  const html = (await report(v, 'felicia-chicken-rice')).html;
  // The prototype keeps no dated per-hour or per-weekday history, so these ranges were untrue.
  assert.ok(!html.includes('last 7 days'), 'no "last 7 days" claim without dated history');
  assert.ok(!html.includes('last 4 weeks'), 'no "last 4 weeks" claim without dated history');
  assert.ok(!/Today at a Glance/i.test(html), 'figures since a reset are not "today"');
  assert.ok(!/Revenue today/i.test(html));
  assert.match(html, /since last Reset Demo/, 'the live range must say what it actually covers');
  assert.match(html, /no per-hour history/i);
  assert.match(html, /no dated history/i);
});

// ---------------------------------------------------------------------------
// Channel classification
// ---------------------------------------------------------------------------

test('the report keeps Smart Match, Shared Vouch and Direct Scan distinct', async function() {
  const merchantId = 'green-bowl';
  campaign(merchantId).rewardAmount = 0.50;
  campaign(merchantId).minimumEligibleSpend = 5.00;

  // Direct Scan.
  const direct = visitor();
  await direct.request('/home');
  await pay(direct, merchantId, '6.00');

  // Smart Match: accept the recommendation for this merchant before paying.
  const matched = visitor();
  await matched.request('/home');
  await matched.request('/smart-match/result');
  const selected = (await matched.state()).demo.selectedMerchantId;
  await matched.request('/recommendation/accept', { merchantId: selected });
  const smartTx = await pay(matched, selected, '6.00');
  assert.equal(smartTx.source, 'SMART_MATCH');

  const c = campaign(selected);
  const page = await report(matched, selected);
  assert.match(page.html, new RegExp('Smart Match</b><small>' + c.metrics.smartMatchPayments + ' payments'));
  assert.match(page.html, new RegExp('Direct Scan</b><small>' + c.metrics.directScanPayments + ' payments'));
  // A Direct Scan must never be counted as a Smart Match conversion.
  const directCampaign = campaign(merchantId);
  assert.equal(directCampaign.metrics.directScanPayments >= 1, true);
  const directPage = await report(direct, merchantId);
  assert.match(directPage.html, /Direct Scan<\/b><small>[1-9]/);
});

// ---------------------------------------------------------------------------
// Observations: honest naming, no unsupported claims
// ---------------------------------------------------------------------------

test('observations are named as rule-based demo heuristics, not AI insights', async function() {
  const v = visitor();
  await v.request('/home');
  const html = (await report(v, 'felicia-chicken-rice')).html;
  assert.ok(!html.includes('AI Insights'), 'hardcoded if/else rules must not be called AI');
  assert.match(html, /Demo observations · rule-based/);
  assert.match(html, /fixed if\/else rules/i);
  // A confidence badge implies a model; each observation states what it was read off instead.
  assert.ok(!/confidence/i.test(html), 'no confidence claim without a model behind it');
  assert.match(html, /insight-badge--basis/);
});

test('no observation asserts a sales lift, return-visit or perceived-value figure', async function() {
  const v = visitor();
  await v.request('/home');
  // Check across merchants so every branch of the rule set is exercised.
  for (const merchantId of ['felicia-chicken-rice', 'green-bowl', 'woodlands-noodle-bar', 'northside-wraps', 'spice-lane']) {
    const html = (await report(v, merchantId)).html;
    for (const claim of [
      /lifts? slow-period sales/i, /15–25%/, /30–40%/, /2–3×/,
      /higher next-visit rate/i, /perceived value/i, /well-positioned for repeat/i,
      /historically/i, /could outperform/i, /drives strong return visits/i
    ]) {
      assert.doesNotMatch(html, claim, merchantId + ' must not assert: ' + claim);
    }
  }
});

test('an observation about live payments reflects what was actually recorded', async function() {
  const v = visitor();
  await v.request('/home');
  const before = (await report(v, 'felicia-chicken-rice')).html;
  assert.match(before, /No live payments recorded yet/);

  await pay(v, 'felicia-chicken-rice', '6.00');
  const after = (await report(v, 'felicia-chicken-rice')).html;
  assert.ok(!after.includes('No live payments recorded yet'));
  assert.match(after, /1 payment\(s\) recorded since the last Reset Demo/);
});

// ---------------------------------------------------------------------------
// Safe rendering of merchant-controlled text
// ---------------------------------------------------------------------------

test('merchant-controlled feed text is escaped, never injected as HTML', function() {
  const template = fs.readFileSync(path.join(__dirname, '..', 'views', 'merchant-report.ejs'), 'utf8');
  // The only unescaped output a report template may contain is the partial includes.
  const unescaped = template.match(/<%-[\s\S]*?%>/g) || [];
  for (const tag of unescaped) {
    assert.match(tag, /include\('partials\//, 'unexpected unescaped output in report template: ' + tag);
  }
  // Render the feed with hostile merchant-controlled strings and confirm they come back inert.
  const hostile = '<img src=x onerror=alert(1)>';
  const rendered = ejs.render(
    template.replace(/<%- include\([\s\S]*?\) %>/g, ''),
    {
      merchants: [{ id: 'm', merchantName: hostile }],
      merchant: { id: 'm', merchantName: hostile },
      campaign: { rewardLabel: hostile, rewardAmount: 0.5, minimumEligibleSpend: 5 },
      tab: 'report',
      liveKpis: { payments: 1, sales: '6.00', avgBasket: '6.00', rewardCost: '0.50', successFees: '0.10' },
      baselineKpis: null,
      chartHours: [], weeklyData: [], heatmapData: [], heatmapHourLabels: [],
      liveAcquisition: { total: 1, smartMatch: { count: 1, pct: 100 }, sharedVouch: { count: 0, pct: 0 }, directScan: { count: 0, pct: 0 } },
      baselineAcquisition: null,
      insights: [{ icon: '🎯', headline: hostile, detail: hostile, basis: hostile }],
      recentPayments: [{ source: 'SMART_MATCH', itemName: hostile, date: '2026-10-01', time: '12:00', displayAmount: hostile }]
    },
    { filename: path.join(__dirname, '..', 'views', 'merchant-report.ejs') }
  );
  assert.ok(!rendered.includes(hostile), 'hostile merchant text must not appear unescaped');
  // The escaped form legitimately contains the words as inert text, so assert on the tag itself:
  // no <img element may be created, which is what an injection would have to produce.
  assert.ok(!/<img\b/i.test(rendered), 'no element may be injected from merchant-controlled text');
  assert.match(rendered, /&lt;img src=x onerror=alert\(1\)&gt;/, 'hostile text must be rendered escaped');
});

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

test('Reset Demo clears the live report figures and leaves the illustrative baseline intact', async function() {
  const v = visitor();
  await v.request('/home');
  await pay(v, 'felicia-chicken-rice', '6.00');
  let html = (await report(v, 'felicia-chicken-rice')).html;
  assert.equal(liveFeedRowCount(html), 1);
  assert.match(html, /Payments recorded<\/small><b>1<\/b>/);

  await v.request('/reset-demo', {});
  html = (await report(v, 'felicia-chicken-rice')).html;
  assert.equal(liveFeedRowCount(html), 0, 'reset must clear the live feed');
  assert.match(html, /Payments recorded<\/small><b>0<\/b>/);
  assert.match(html, /Gross sales<\/small><b>\$0\.00<\/b>/);
  assert.match(html, /Sample payments<\/small><b>494<\/b>/, 'the illustrative baseline survives reset');
});
