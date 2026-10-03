const test = require('node:test');
const assert = require('node:assert/strict');
const { app, demoStore, getMerchantCampaigns, resetMerchantCampaigns, resetReferralCooldowns,
  clearDiscoveryCache, clearSearchIntentCache } = require('../app');
// End-to-end acceptance of the five Open House demo journeys, over HTTP against local data, mocked
// providers and test-only sessions. These walk what a person actually does at the stand, so a
// regression that each unit-level suite would miss individually still fails here.
// No real Google, Foursquare, Groq, OpenAI, Tavily or Upstash call is made and no credential is used.

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
  global.fetch = originalFetch;
  trackedKeys.forEach(function(key) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  });
});
test.beforeEach(async function() {
  global.fetch = originalFetch;
  trackedKeys.forEach(function(key) { delete process.env[key]; });
  resetMerchantCampaigns();
  resetReferralCooldowns();
  clearDiscoveryCache();
  clearSearchIntentCache();
  await visitor().request('/reset-demo', {});
});
test.afterEach(function() { global.fetch = originalFetch; });

function visitor() {
  let cookie = '';
  return {
    async request(path, body) {
      const response = await originalFetch(base + path, {
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
    },
    async demo() { return (await this.state()).demo; }
  };
}

function campaign(id) {
  return getMerchantCampaigns().find(function(item) { return item.merchantId === id; });
}
function pinAllCampaigns(rewardAmount, minimumEligibleSpend) {
  getMerchantCampaigns().forEach(function(c) {
    c.rewardAmount = rewardAmount;
    c.minimumEligibleSpend = minimumEligibleSpend;
  });
}
function merchantIdFromCard(html) {
  const match = html.match(/data-merchant-id="([^"]+)"/);
  return match ? match[1] : null;
}

async function scanAndPay(v, merchantId, amount, useCredit) {
  await v.request('/scan');
  const scan = await v.request('/scan', { merchantId: merchantId });
  assert.ok(scan.location && scan.location.startsWith('/scan/payment'),
    'scan must lead to payment, got ' + scan.location);
  const journey = (await v.demo()).currentScanPayment;
  const body = { journeyId: journey.id, amount: amount };
  if (useCredit) body.useCashback = 'on';
  const paid = await v.request('/scan/payment', body);
  assert.match(paid.location, /^\/payment-success\/tx-/, 'payment must succeed');
  return (await v.demo()).transactions[0];
}

// ===========================================================================
// 1. No dietary restriction: Smart Match -> accept -> Scan -> pay -> credit -> Vouch -> Activity
// ===========================================================================

test('JOURNEY 1: no dietary restriction, full Smart Match to Vouch to Activity walk', async function() {
  pinAllCampaigns(0.50, 5.00);
  const v = visitor();
  await v.request('/home');
  await v.request('/profile', { dietaryPreference: 'none', budget: '20', maxDistanceMinutes: '20' });

  // Smart Match presents one merchant with a truthful credit offer.
  const card = await v.request('/smart-match/result');
  const merchantId = merchantIdFromCard(card.html);
  assert.ok(merchantId, 'Smart Match must present a merchant');
  assert.match(card.html, /\$0\.50 Vouch Credit/, 'the offer is shown as a cash credit');
  assert.doesNotMatch(card.html, /\bfree\b/i, 'no in-kind promise on the match card');
  assert.match(card.html, /Spend \$5\.00\+/, 'the minimum spend is stated up front');
  assert.match(card.html, /Choose this/);

  // Accept, then scan on arrival.
  await v.request('/recommendation/accept', { merchantId: merchantId });
  assert.equal((await v.demo()).recommendationAccepted, true);

  const paymentPage = await (async function() {
    await v.request('/scan');
    await v.request('/scan', { merchantId: merchantId });
    return v.request('/scan/payment');
  })();
  assert.match(paymentPage.html, /Pay with NETS/);
  assert.match(paymentPage.html, /Earn \$0\.50/, 'the payment screen states the credit, not an item');

  // Enter the actual amount and pay.
  const journey = (await v.demo()).currentScanPayment;
  const paid = await v.request('/scan/payment', { journeyId: journey.id, amount: '8.50' });
  assert.match(paid.location, /^\/payment-success\/tx-/);
  const tx = (await v.demo()).transactions[0];
  assert.equal(tx.source, 'SMART_MATCH', 'an accepted Smart Match visit is Smart Match attributed');
  assert.equal(tx.purchaseAmount, 8.50);
  assert.equal(tx.netsPaid, 8.50);
  assert.equal(tx.merchantRewardEarned, 0.50);
  assert.equal((await v.demo()).vouchCredits[merchantId], 0.50);

  // Receipt states a truthful, merchant-specific credit.
  const receipt = await v.request('/payment-success/' + tx.id);
  assert.match(receipt.html, /Paid with NETS/);
  assert.match(receipt.html, /\+\$0\.50 Vouch Credit/);
  assert.match(receipt.html, /usable only at/);
  assert.doesNotMatch(receipt.html, /\bfree\b/i);

  // Optional Vouch.
  const vouched = await v.request('/vouch/' + tx.id, { action: 'create', tag: 'worth-it' });
  assert.equal(vouched.location, '/vouch/' + tx.id + '/success');
  assert.equal((await v.demo()).paymentVerifiedVouches.length, 1);

  // Activity and rewards reflect exactly this one payment.
  const activity = await v.request('/profile/activity');
  assert.match(activity.html, new RegExp(tx.id));
  assert.equal((activity.html.match(/class="payment-row"/g) || []).length, 1);
  const rewards = await v.request('/profile/rewards');
  assert.match(rewards.html, /\$0\.50/);
  assert.match(rewards.html, /Vouch Credit/);

  // The merchant sees exactly one Smart Match conversion and no other channel.
  const c = campaign(merchantId);
  assert.equal(c.metrics.smartMatchPayments, 1);
  assert.equal(c.metrics.directScanPayments, 0);
  assert.equal(c.metrics.sharedVouchPayments, 0);
});

test('JOURNEY 1b: accumulated credit is spent on the next visit and $1 stays payable with NETS', async function() {
  pinAllCampaigns(0.50, 5.00);
  const v = visitor();
  await v.request('/home');
  const first = await scanAndPay(v, 'felicia-chicken-rice', '6.00');
  assert.equal(first.merchantRewardEarned, 0.50);
  await v.request('/vouch/' + first.id, { action: 'skip' });

  // Credit is merchant-specific: it must not apply at a different merchant.
  await v.request('/scan');
  await v.request('/scan', { merchantId: 'green-bowl' });
  const otherPage = await v.request('/scan/payment');
  assert.ok(!otherPage.html.includes('credit-toggle'),
    "another merchant's screen must not offer Felicia credit");

  // Abandon that scan before scanning the other merchant, as the Scan another merchant control does;
  // otherwise the pending journey keeps the visitor on the first merchant's payment screen.
  const pendingOther = (await v.demo()).currentScanPayment;
  await v.request('/scan/cancel', { journeyId: pendingOther.id });
  assert.equal((await v.demo()).currentScanPayment, null, 'the abandoned scan must be cleared');

  // At the same merchant it is offered and applied.
  await v.request('/scan');
  await v.request('/scan', { merchantId: 'felicia-chicken-rice' });
  const ownPage = await v.request('/scan/payment');
  assert.match(ownPage.html, /Felicia/, 'the payment screen must now be the credited merchant');
  assert.match(ownPage.html, /\$0\.50 available/);
  const journey = (await v.demo()).currentScanPayment;
  await v.request('/scan/payment', { journeyId: journey.id, amount: '6.00', useCashback: 'on' });
  const second = (await v.demo()).transactions[0];
  assert.equal(second.merchantCreditUsed, 0.50);
  assert.equal(second.netsPaid, 5.50);
  assert.equal(second.merchantRewardEarned, 0, 'the daily reward is once per merchant per day');
});

// ===========================================================================
// 2. Active dietary restriction: never suitable without validated evidence
// ===========================================================================

const DIET_ORIGIN = { latitude: 1.4428, longitude: 103.7854 };
const METRES_PER_DEGREE = 111195;
const RESEARCH_MARKER = 'You verify ONE dietary requirement';

function googlePlace(id, name, metres) {
  return { id: id, displayName: { text: name }, primaryType: 'restaurant',
    types: ['restaurant', 'food', 'point_of_interest', 'establishment'],
    formattedAddress: '1 Example Road, Singapore 738010',
    location: { latitude: DIET_ORIGIN.latitude + metres / METRES_PER_DEGREE, longitude: DIET_ORIGIN.longitude } };
}

// Mocks Google discovery, Tavily evidence retrieval and the Groq research analysis.
// options.verdict(name) -> 'SUITABLE' | 'UNKNOWN'; options.hangTavily makes evidence time out;
// options.noAnalysis removes the analysis provider entirely.
function mockDietaryProviders(options) {
  const calls = { nearby: 0, text: [], search: [], groq: 0 };
  global.fetch = async function(url, init) {
    const target = String(url);
    const body = init && init.body ? JSON.parse(init.body) : {};
    if (target.endsWith(':searchNearby')) {
      calls.nearby += 1;
      return { ok: true, json: async function() { return { places: options.places || [] }; } };
    }
    if (target.endsWith(':searchText')) {
      calls.text.push(body.textQuery);
      return { ok: true, json: async function() { return { places: options.places || [] }; } };
    }
    const host = new URL(target).hostname;
    if (host === 'api.tavily.com') {
      if (options.hangTavily) {
        return new Promise(function(resolve, reject) {
          init.signal.addEventListener('abort', function() {
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
        });
      }
      if (target.endsWith('/search')) {
        calls.search.push(body.query);
        return { ok: true, json: async function() {
          return { results: [{ title: body.query + ' - MUIS halal certificate',
            url: 'https://www.muis.gov.sg/halal/x', content: body.query + ' halal certified' }] };
        } };
      }
      return { ok: true, json: async function() {
        return { results: body.urls.map(function(u) {
          return { url: u, raw_content: 'Certified halal outlet. ' + 'Details. '.repeat(40) };
        }) };
      } };
    }
    if (host === 'api.groq.com' && String(body.messages[0].content).indexOf(RESEARCH_MARKER) === 0) {
      calls.groq += 1;
      const merchants = JSON.parse(body.messages[1].content.slice(body.messages[1].content.indexOf('[')));
      return { ok: true, json: async function() {
        return { choices: [{ message: { content: JSON.stringify({ results: merchants.map(function(m) {
          const status = options.verdict ? options.verdict(m.name) : 'UNKNOWN';
          // A real analyser cites the sources that actually identify the outlet, so the mock cites
          // every source it was given; the server-side validator decides which ones qualify.
          const cited = m.sources.map(function(src) {
            return { title: src.title, url: src.url, sourceType: 'certification' };
          });
          return { merchantId: m.merchantId, identified: true, outletMatched: true, status: status,
            evidenceClass: status === 'SUITABLE' ? 'CERTIFIED_HALAL' : 'NONE', claimSubject: 'merchant',
            conflict: false, evidenceDate: null, outletSignalsUsed: [],
            evidence: status === 'SUITABLE' ? 'Listed as MUIS halal certified.' : '',
            matchingItems: [], sources: cited };
        }) }) } }] };
      } };
    }
    return { ok: false, status: 404 };
  };
  return calls;
}

async function halalVisitor(v) {
  await v.request('/home');
  await v.request('/profile', { dietaryPreference: 'halal', budget: '30', maxDistanceMinutes: '30' });
  // Give the session real browser coordinates so Google discovery is used rather than demo data.
  await v.request('/location', { latitude: String(DIET_ORIGIN.latitude), longitude: String(DIET_ORIGIN.longitude) });
}

test('JOURNEY 2: a Halal match is shown only when a registered merchant listed Halal', async function() {
  process.env.GOOGLE_PLACES_API_KEY = 'test-google';
  // External Google results can never be a dietary match; the registered merchant below listed Halal.
  mockDietaryProviders({ places: [googlePlace('ext', 'Unlisted Stall', 150)] });
  const campaign = getMerchantCampaigns().find(function(c) { return c.merchantId === 'felicia-chicken-rice'; });
  campaign.dietaryCapabilities = { halal: true, vegetarian: false, vegan: false };
  const v = visitor();
  await halalVisitor(v);
  const card = await v.request('/smart-match/result');
  assert.equal(merchantIdFromCard(card.html), 'felicia-chicken-rice',
    'only a merchant that listed Halal may be recommended');
  assert.ok(!card.html.includes('Unlisted Stall'), 'an external listing is never shown as a dietary match');
  assert.match(card.html, /diet-tag diet-tag--halal">Halal</);
  assert.match(card.html, /Dietary information provided by the merchant\./);
});

test('JOURNEY 2b: with nothing listed nearby the app says exactly that and recommends nothing', async function() {
  process.env.GOOGLE_PLACES_API_KEY = 'test-google';
  mockDietaryProviders({ places: [googlePlace('a', 'Unlisted Stall A', 150), googlePlace('b', 'Unlisted Stall B', 200)] });
  getMerchantCampaigns().forEach(function(c) {
    c.dietaryCapabilities = { halal: false, vegetarian: false, vegan: false };
  });
  const v = visitor();
  await halalVisitor(v);
  const card = await v.request('/smart-match/result');
  assert.equal(merchantIdFromCard(card.html), null, 'nothing may be recommended for an unlisted diet');
  assert.match(card.html, /No nearby merchants have listed this dietary option yet\./);
  assert.ok(!/no suitable restaurants/i.test(card.html), 'and it never claims none exist generally');
});

test('JOURNEY 2c: a Halal search spends no research provider call and returns immediately', async function() {
  process.env.GOOGLE_PLACES_API_KEY = 'test-google';
  process.env.TAVILY_API_KEY = 'test-tavily';
  const calls = mockDietaryProviders({ places: [googlePlace('ext', 'Unlisted Stall', 150)] });
  const campaign = getMerchantCampaigns().find(function(c) { return c.merchantId === 'felicia-chicken-rice'; });
  campaign.dietaryCapabilities = { halal: true, vegetarian: false, vegan: false };
  const v = visitor();
  await halalVisitor(v);
  const started = Date.now();
  const card = await v.request('/smart-match/result');
  const elapsed = Date.now() - started;
  assert.equal(merchantIdFromCard(card.html), 'felicia-chicken-rice');
  assert.equal(calls.search.length, 0, 'no Tavily dietary search exists any more');
  assert.ok(elapsed < 3000, 'and a dietary search is no slower than any other: ' + elapsed + ' ms');
});

// ===========================================================================
// 3. Direct Scan stays Direct Scan
// ===========================================================================

test('JOURNEY 3: a Direct Scan is never counted as a Smart Match acquisition', async function() {
  pinAllCampaigns(0.50, 5.00);
  const v = visitor();
  await v.request('/home');
  // Smart Match showed one merchant; the visitor walks to a different one and scans directly.
  const card = await v.request('/smart-match/result');
  const shown = merchantIdFromCard(card.html);
  const other = shown === 'green-bowl' ? 'felicia-chicken-rice' : 'green-bowl';

  const tx = await scanAndPay(v, other, '6.00');
  assert.equal(tx.source, 'DIRECT_SCAN');
  assert.equal(campaign(other).metrics.directScanPayments, 1);
  assert.equal(campaign(other).metrics.smartMatchPayments, 0);
  assert.equal(campaign(other).platformFeeAccrued, 0, 'a Direct Scan accrues no acquisition fee');
  if (shown) {
    assert.equal(campaign(shown).metrics.smartMatchPayments, 0,
      'the merchant that was merely shown gained no conversion');
  }

  // Even scanning the merchant that was shown, without accepting, stays a Direct Scan.
  await v.request('/vouch/' + tx.id, { action: 'skip' });
  const second = visitor();
  await second.request('/home');
  const card2 = await second.request('/smart-match/result');
  const shown2 = merchantIdFromCard(card2.html);
  const tx2 = await scanAndPay(second, shown2, '6.00');
  assert.equal(tx2.source, 'DIRECT_SCAN',
    'being shown a merchant is not accepting it; an unaccepted visit is a Direct Scan');
});

// ===========================================================================
// 4. Shared Vouch: create, share, claim by another identity, redeem once
// ===========================================================================

test('JOURNEY 4: share, claim, wrong merchant does not redeem, right merchant redeems once', async function() {
  pinAllCampaigns(0.50, 5.00);
  const merchantId = 'green-bowl';
  const sender = visitor();
  await sender.request('/home');
  const senderTx = await scanAndPay(sender, merchantId, '7.20');
  await sender.request('/vouch/' + senderTx.id, { action: 'create' });
  const vouch = (await sender.demo()).paymentVerifiedVouches[0];
  const offerPath = '/offers/' + vouch.shareToken;

  // The share page never leaks the sender's purchase amount.
  const share = await sender.request('/vouch/' + senderTx.id + '/success');
  assert.ok(!share.html.includes('$7.20'), 'the purchase amount stays private');

  // A different demo identity claims the link.
  const receiver = visitor();
  await receiver.request('/demo/identity', { userId: 'darren' });
  const opened = await receiver.request(offerPath);
  assert.match(opened.html, /Claim offer/);
  assert.ok(!opened.html.includes('$7.20'));
  assert.equal((await receiver.request(offerPath + '/claim', {})).location, offerPath);
  let claim = (await receiver.demo()).activeVouchClaim;
  assert.equal(claim.status, 'CLAIMED');
  assert.equal(claim.senderUserId, 'jia');
  assert.equal(claim.recipientUserId, 'darren');
  assert.equal(campaign(merchantId).metrics.sharedVouchClaims, 1);

  // A payment at the WRONG merchant must not redeem the claim.
  const wrong = await scanAndPay(receiver, 'felicia-chicken-rice', '6.00');
  assert.equal(wrong.source, 'DIRECT_SCAN');
  assert.equal((await receiver.demo()).activeVouchClaim.status, 'CLAIMED', 'the claim is still unredeemed');
  assert.equal(campaign(merchantId).metrics.sharedVouchPayments, 0);
  await receiver.request('/vouch/' + wrong.id, { action: 'skip' });

  // A payment at the RIGHT merchant redeems it exactly once.
  const right = await scanAndPay(receiver, merchantId, '6.00');
  assert.equal(right.source, 'SHARED_VOUCH');
  assert.equal(right.merchantRewardEarned, 0.50);
  assert.equal((await receiver.demo()).activeVouchClaim.status, 'REDEEMED');
  assert.equal(campaign(merchantId).metrics.sharedVouchPayments, 1);

  // The sender's bonus follows the existing rule and is credited at the same merchant.
  await sender.request('/home');
  assert.equal((await sender.demo()).vouchCredits[merchantId], 0.50 + campaign(merchantId).senderReferralReward);

  // A second claim cannot convert again for the same sender, recipient and merchant.
  await receiver.request('/vouch/' + right.id, { action: 'skip' });
  await receiver.request(offerPath + '/claim', {});
  const repeat = await scanAndPay(receiver, merchantId, '6.00');
  assert.equal(repeat.source, 'DIRECT_SCAN', 'the referral cooldown blocks a second conversion');
  assert.equal(campaign(merchantId).metrics.sharedVouchPayments, 1);
});

test('JOURNEY 4b: a visitor cannot claim their own Vouch', async function() {
  pinAllCampaigns(0.50, 5.00);
  const sender = visitor();
  await sender.request('/home');
  const tx = await scanAndPay(sender, 'green-bowl', '6.00');
  await sender.request('/vouch/' + tx.id, { action: 'create' });
  const token = (await sender.demo()).paymentVerifiedVouches[0].shareToken;

  const sameIdentity = visitor();
  await sameIdentity.request('/offers/' + token + '/claim', {});
  assert.equal((await sameIdentity.demo()).activeVouchClaim, null, 'self-referral must be blocked');
  assert.equal(campaign('green-bowl').metrics.sharedVouchClaims, 0);
});

// ===========================================================================
// 5. Reset Demo clears exactly the intended state
// ===========================================================================

test('JOURNEY 5: Reset Demo clears customer state and live metrics, keeps campaign configuration', async function() {
  pinAllCampaigns(0.50, 5.00);
  const v = visitor();
  await v.request('/home');

  // Edit one campaign; this configuration must survive.
  const configured = campaign('green-bowl');
  configured.rewardAmount = 0.70;
  configured.minimumEligibleSpend = 4;
  configured.maxRewardedPaymentsPerDay = 7;
  configured.status = 'INACTIVE';

  const tx = await scanAndPay(v, 'felicia-chicken-rice', '6.00');
  await v.request('/vouch/' + tx.id, { action: 'create' });
  const live = campaign('felicia-chicken-rice');
  assert.equal(live.metrics.payments, 1);
  assert.ok(live.platformFeeAccrued >= 0);

  assert.equal((await v.request('/reset-demo', {})).location, '/home?reset=done');

  // Customer state is gone.
  const demo = await v.demo();
  assert.equal(demo.user.id, 'jia');
  assert.deepEqual(demo.transactions, []);
  assert.deepEqual(demo.vouchCredits, {});
  assert.deepEqual(demo.paymentVerifiedVouches, []);
  assert.equal(demo.currentScanPayment, null);
  assert.equal(demo.activeVouchClaim, null);
  assert.equal(demo.selectedMerchantId, null);
  assert.match((await v.request('/profile/activity')).html, /No NETS activity yet/);
  assert.equal((await v.request('/payment-success/' + tx.id)).status, 404, 'a stale URL must not resolve');

  // Live merchant counters are gone.
  assert.equal(live.metrics.payments, 0);
  assert.equal(live.metrics.directScanPayments, 0);
  assert.equal(live.metrics.rewardCost, 0);
  assert.equal(live.redemptionsToday, 0);
  assert.equal(live.rewardBudgetSpentToday, 0);
  assert.equal(live.platformFeeAccrued, 0);

  // Campaign configuration survived.
  assert.deepEqual([configured.rewardAmount, configured.minimumEligibleSpend,
    configured.maxRewardedPaymentsPerDay, configured.status], [0.70, 4, 7, 'INACTIVE']);
});

// ===========================================================================
// UI: long text, mobile layout constraints, accessibility of the reward controls
// ===========================================================================

test('UI: a long merchant name and a long credit label stay constrained, not injected', async function() {
  const v = visitor();
  await v.request('/home');
  const longLabel = 'Vouch Credit towards a very generously portioned side dish';
  assert.ok(longLabel.length > 50, 'this label is deliberately over the 50-character limit');
  const rejected = await v.request('/merchant/offer', {
    merchantId: 'felicia-chicken-rice', rewardLabel: '__custom__', rewardLabelCustom: longLabel,
    rewardAmount: '0.80', minimumEligibleSpend: '5.00', maxRewardedPaymentsPerDay: '25',
    maxRewardBudgetPerDay: '12.00', startTime: '00:00', endTime: '23:59', status: 'ACTIVE'
  });
  assert.match(rejected.location, /error=label/, 'an over-long label is rejected server-side');

  // The longest accepted label renders, escaped, with the amount beside it.
  const atLimit = 'Vouch Credit towards a generous side dish portion';
  assert.ok(atLimit.length <= 50);
  await v.request('/merchant/offer', {
    merchantId: 'felicia-chicken-rice', rewardLabel: '__custom__', rewardLabelCustom: atLimit,
    rewardAmount: '0.80', minimumEligibleSpend: '5.00', maxRewardedPaymentsPerDay: '25',
    maxRewardBudgetPerDay: '12.00', startTime: '00:00', endTime: '23:59', status: 'ACTIVE'
  });
  assert.equal(campaign('felicia-chicken-rice').rewardLabel, atLimit);
  const tx = await scanAndPay(v, 'felicia-chicken-rice', '6.00');
  const receipt = await v.request('/payment-success/' + tx.id);
  assert.match(receipt.html, /\+\$0\.80 Vouch Credit towards a generous side dish portion earned/);

  // A label carrying markup is refused outright, so merchant text can never introduce an element.
  const markup = await v.request('/merchant/offer', {
    merchantId: 'felicia-chicken-rice', rewardLabel: '__custom__',
    rewardLabelCustom: '<b>Vouch Credit</b> towards a side',
    rewardAmount: '0.80', minimumEligibleSpend: '5.00', maxRewardedPaymentsPerDay: '25',
    maxRewardBudgetPerDay: '12.00', startTime: '00:00', endTime: '23:59', status: 'ACTIVE'
  });
  assert.match(markup.location, /error=label/, 'a label containing markup is rejected');
  assert.equal(campaign('felicia-chicken-rice').rewardLabel, atLimit, 'the stored label is unchanged');
});

test('UI: the merchant campaign and report pages carry mobile-safe layout hooks', async function() {
  const v = visitor();
  await v.request('/home');
  for (const path of ['/merchant?merchantId=felicia-chicken-rice&tab=campaign',
                      '/merchant?merchantId=felicia-chicken-rice&tab=results',
                      '/merchant/report?merchantId=felicia-chicken-rice']) {
    const page = await v.request(path);
    assert.equal(page.status, 200, path);
    // Every screen renders inside the fixed-width phone frame, so nothing is laid out full-bleed.
    assert.match(page.html, /class="phone"/, path + ' must render in the phone frame');
    assert.match(page.html, /name="viewport" content="width=device-width/, path + ' must set the viewport');
    assert.ok(!/style="[^"]*width:\s*\d{4,}px/.test(page.html),
      path + ' must not hard-code a width wider than a phone');
  }
  // The hourly chart is the one wide element; it must stay in its own scroll container.
  const report = await v.request('/merchant/report?merchantId=felicia-chicken-rice');
  assert.match(report.html, /trend-chart--hourly-wrap/,
    'the wide hourly chart must stay inside its scroll wrapper rather than widening the page');
});

test('UI: the reward controls are a properly labelled, keyboard-reachable group', async function() {
  const v = visitor();
  await v.request('/home');
  const page = await v.request('/merchant?merchantId=felicia-chicken-rice&tab=campaign');

  // The radio set is a real group with an accessible name and its hint associated.
  assert.match(page.html, /<fieldset class="field">/);
  assert.match(page.html, /<legend class="field-label" id="rewardTypeLabel">Reward type<\/legend>/);
  assert.match(page.html, /role="radiogroup"[^>]*aria-labelledby="rewardTypeLabel"/);
  assert.match(page.html, /aria-describedby="rewardTypeHint"/);
  assert.match(page.html, /id="rewardTypeHint"/);

  // The custom free-text field has a real label, not only a placeholder.
  assert.match(page.html, /<label class="visually-hidden" for="rewardCustomInput">/);
  assert.match(page.html, /id="rewardCustomInput"/);
  assert.match(page.html, /aria-controls="rewardCustomInput"/);

  // Every reward option states the amount alongside the credit description.
  const options = page.html.match(/<span>\$\d+\.\d{2} [^<]*Vouch Credit[^<]*<\/span>/g) || [];
  assert.ok(options.length >= 1, 'reward options must show the live amount with the credit label');
  assert.doesNotMatch(page.html.replace(/Reward labels must describe[\s\S]*?Nothing was saved\./, ''), /\bfree\b/i);
});
