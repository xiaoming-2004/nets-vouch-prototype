const test = require('node:test');
const assert = require('node:assert/strict');
const { app, demoStore, getMerchantCampaigns, resetMerchantCampaigns, resetReferralCooldowns } = require('../app');
let server;
let base;
const originalFoursquareKey = process.env.FOURSQUARE_API_KEY;

test.before(async function() {
  server = await new Promise(function(resolve) {
    const instance = app.listen(0, '127.0.0.1', function() { resolve(instance); });
  });
  base = 'http://127.0.0.1:' + server.address().port;
});
test.after(function() { server.close(); });
// Merchant campaigns are global (shared across every visitor), so each test starts from a clean cap/status.
// This suite relies on Smart Match's deterministic local-demo-merchant fallback (no mocked
// fetch here), so FOURSQUARE_API_KEY must stay unset even if the real .env configures one.
test.beforeEach(function() { resetMerchantCampaigns(); resetReferralCooldowns(); delete process.env.FOURSQUARE_API_KEY; });
test.afterEach(function() {
  if (originalFoursquareKey === undefined) delete process.env.FOURSQUARE_API_KEY;
  else process.env.FOURSQUARE_API_KEY = originalFoursquareKey;
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
      assert.ok(response.status < 500, path + ' returned ' + response.status + '\n' + html);
      return { status: response.status, location: response.headers.get('location'), html: html };
    },
    async state() {
      const id = decodeURIComponent(cookie.split('=')[1]).slice(2).split('.')[0];
      return new Promise(function(resolve, reject) {
        demoStore.get(id, function(error, data) { if (error) reject(error); else resolve(data); });
      });
    },
    async change(update) {
      const id = decodeURIComponent(cookie.split('=')[1]).slice(2).split('.')[0];
      const state = await this.state();
      update(state.demo);
      await new Promise(function(resolve, reject) {
        demoStore.set(id, state, function(error) { if (error) reject(error); else resolve(); });
      });
    }
  };
}

async function match(v) {
  await v.request('/home');
  return v.request('/smart-match/result');
}

async function goThere(v) {
  await match(v);
  const merchantId = (await v.state()).demo.selectedMerchantId;
  await v.request('/recommendation/accept', { merchantId: merchantId });
  return merchantId;
}

async function scan(v, merchantId) {
  await v.request('/scan');
  if (!merchantId) {
    const demo = (await v.state()).demo;
    merchantId = demo.activeVouchClaim && demo.activeVouchClaim.status === 'CLAIMED'
      ? demo.activeVouchClaim.merchantId
      : demo.recommendationAccepted && demo.selectedMerchantId ? demo.selectedMerchantId : 'green-bowl';
  }
  const result = await v.request('/scan', { merchantId: merchantId });
  assert.ok(result.location && result.location.startsWith('/scan/payment'), 'expected redirect to /scan/payment, got ' + result.location);
  return (await v.state()).demo.currentScanPayment;
}

function credit(demo, merchantId) { return demo.vouchCredits[merchantId] || 0; }

test('payment IDs and consumer receipts/Vouches are private to their owner', async function() {
  const jia = visitor();
  const jiaScan = await scan(jia, 'felicia-chicken-rice');
  await jia.request('/scan/payment', { journeyId: jiaScan.id, amount: '5.00' });
  const jiaTransaction = (await jia.state()).demo.transactions[0];
  assert.equal(jiaTransaction.ownerUserId, 'jia');
  assert.equal((await jia.request('/transactions/' + jiaTransaction.id)).status, 200);
  assert.equal((await jia.request('/payment-success/' + jiaTransaction.id)).status, 200);

  const darren = visitor();
  await darren.request('/demo/identity', { userId: 'darren' });
  for (const path of ['/transactions/', '/payment-success/', '/vouch/']) {
    const denied = await darren.request(path + jiaTransaction.id);
    assert.equal(denied.status, 404);
    assert.equal(denied.html, 'Payment not found');
  }
  assert.equal((await darren.request('/vouch/' + jiaTransaction.id + '/success')).status, 404);
  assert.equal((await darren.request('/vouch/' + jiaTransaction.id, { action: 'create' })).status, 404);
  assert.equal((await darren.request('/transactions/' + jiaTransaction.id + '/done', {})).status, 404);
  assert.equal((await darren.state()).demo.paymentVerifiedVouches.length, 0);

  const darrenScan = await scan(darren, 'green-bowl');
  await darren.request('/scan/payment', { journeyId: darrenScan.id, amount: '5.00' });
  const darrenTransaction = (await darren.state()).demo.transactions[0];
  assert.equal(darrenTransaction.ownerUserId, 'darren');
  assert.notEqual(darrenTransaction.id, jiaTransaction.id);
});

test('replaying one payment attempt cannot duplicate payment, reward or merchant metrics', async function() {
  const v = visitor();
  const pending = await scan(v, 'felicia-chicken-rice');
  const body = { journeyId: pending.id, amount: '5.13' };
  const first = await v.request('/scan/payment', body);
  const campaign = getMerchantCampaigns().find(function(item) { return item.merchantId === pending.merchantId; });
  const firstState = (await v.state()).demo;
  const metrics = {
    payments: campaign.metrics.payments,
    redemptions: campaign.redemptionsToday,
    rewardSpend: campaign.rewardBudgetSpentToday,
    rewardCost: campaign.metrics.rewardCost,
    platformFee: campaign.platformFeeAccrued
  };
  const repeated = await v.request('/scan/payment', body);
  assert.equal(repeated.location, first.location);
  const repeatedState = (await v.state()).demo;
  assert.equal(repeatedState.transactions.length, 1);
  assert.deepEqual(repeatedState.vouchCredits, firstState.vouchCredits);
  assert.deepEqual({
    payments: campaign.metrics.payments,
    redemptions: campaign.redemptionsToday,
    rewardSpend: campaign.rewardBudgetSpentToday,
    rewardCost: campaign.metrics.rewardCost,
    platformFee: campaign.platformFeeAccrued
  }, metrics);
  const merchantResults = await v.request('/merchant?merchantId=felicia-chicken-rice&tab=results');
  assert.equal((merchantResults.html.match(/\$5\.13/g) || []).length, 1);
});

test('Smart Match recommends a merchant, keeps feedback and hands off to Scan', async function() {
  const v = visitor();
  assert.equal((await v.request('/')).location, '/welcome');
  await v.request('/home');
  const first = await match(v);
  assert.match(first.html, /felicia-chicken-rice/);
  assert.match(first.html, /Try: Chicken Rice · \$5\.00/);
  assert.match(first.html, /Choose this/);
  assert.ok(!first.html.includes('Go there'));
  assert.ok(!first.html.includes('after collection'));
  const feliciaId = (await v.state()).demo.selectedMerchantId;
  await v.request('/recommendation/accept', { merchantId: feliciaId });
  let state = (await v.state()).demo;
  assert.equal(state.recommendationAccepted, true);
  assert.equal(state.currentOrder, undefined);
  assert.match((await v.request('/home')).html, /Scan when you arrive/);
  assert.match((await v.request('/scan')).html, new RegExp('value="' + feliciaId + '"'));
  await v.request('/recommendation/reject', { merchantId: feliciaId, reason: 'too-far' });
  state = (await v.state()).demo;
  assert.equal(state.recommendationAccepted, false);
  assert.equal(state.recommendationFeedback[0].reason, 'too-far');
  const next = await v.request('/smart-match/result');
  assert.ok(!next.html.includes('data-merchant-id="' + feliciaId + '"'));
});

test('Profile preferences still filter Smart Match', async function() {
  const v = visitor();
  await v.request('/home');
  for (const dietary of ['halal', 'vegetarian', 'vegan', 'none']) {
    const saved = await v.request('/profile', { dietaryPreference: dietary, budget: '10', maxDistanceMinutes: '10' });
    assert.equal(saved.location, '/home?matching=again');
    const result = await v.request('/smart-match/result');
    assert.equal(result.status, 200);
    if (dietary !== 'none') assert.match(result.html, new RegExp(dietary, 'i'));
  }
  await v.request('/profile', { dietaryPreference: 'none', budget: '1', maxDistanceMinutes: '1' });
  assert.match((await v.request('/smart-match/result')).html, /No spots nearby/);
});

test('Smart Match Scan accepts actual amount, merchant credit and optional Vouch', async function() {
  const v = visitor();
  const merchantId = await goThere(v);
  await v.change(function(demo) { demo.vouchCredits[merchantId] = .5; });
  const pending = await scan(v);
  assert.equal(pending.merchantId, merchantId);
  const page = await v.request('/scan/payment');
  assert.match(page.html, /Pay with NETS/);
  assert.match(page.html, /\$0\.50 available/);
  const paid = await v.request('/scan/payment', { journeyId: pending.id, amount: '6.00', useCashback: 'on' });
  assert.match(paid.location, /^\/payment-success\/tx-/);
  let state = (await v.state()).demo;
  const transaction = state.transactions[0];
  assert.equal(transaction.purchaseAmount, 6);
  assert.equal(transaction.merchantCreditUsed, .5);
  assert.equal(transaction.netsPaid, 5.5);
  assert.equal(transaction.merchantRewardEarned, .5);
  assert.equal(transaction.source, 'SMART_MATCH');
  const smartMatchCampaign = getMerchantCampaigns().find(function(item) { return item.merchantId === merchantId; });
  assert.equal(smartMatchCampaign.metrics.smartMatchPayments, 1);
  assert.equal(smartMatchCampaign.metrics.directScanPayments, 0);
  assert.equal(smartMatchCampaign.platformFeeAccrued, smartMatchCampaign.platformFeePerAttributedPayment);
  assert.equal(credit(state, merchantId), .5);
  assert.match((await v.request('/payment-success/' + transaction.id)).html, /Paid with NETS/);
  await Promise.all([
    v.request('/vouch/' + transaction.id, { action: 'create', tag: 'worth-it' }),
    v.request('/vouch/' + transaction.id, { action: 'create', tag: 'worth-it' })
  ]);
  state = (await v.state()).demo;
  assert.equal(state.paymentVerifiedVouches.length, 1);
  const share = await v.request('/vouch/' + transaction.id + '/success');
  assert.match(share.html, /WhatsApp/);
  assert.match(share.html, /Telegram/);
  assert.match(share.html, /Copy Link/);
  const vouches = await v.request('/profile/vouches');
  assert.match(vouches.html, /Payment-Verified/);
  assert.ok(!vouches.html.includes('Simulated verification'));
  const profile = await v.request('/profile');
  assert.match(profile.html, /Jia Yi/);
  assert.ok(!profile.html.includes('Open House controls'));
});

test('Merchant Vouch Credit cannot be used at another merchant', async function() {
  const v = visitor();
  await v.request('/home');
  await v.change(function(demo) { demo.vouchCredits['felicia-chicken-rice'] = .5; });
  getMerchantCampaigns().forEach(function(campaign) { campaign.status = 'INACTIVE'; });
  const green = await scan(v, 'green-bowl');
  await v.request('/scan/payment', { journeyId: green.id, amount: '6.00', useCashback: 'on' });
  let state = (await v.state()).demo;
  assert.equal(state.transactions[0].merchantCreditUsed, 0);
  assert.equal(credit(state, 'felicia-chicken-rice'), .5);
  await v.request('/vouch/' + state.transactions[0].id, { action: 'skip' });
  const felicia = await scan(v, 'felicia-chicken-rice');
  await v.request('/scan/payment', { journeyId: felicia.id, amount: '4.50', useCashback: 'on' });
  state = (await v.state()).demo;
  assert.equal(state.transactions[0].merchantCreditUsed, .5);
  assert.equal(state.transactions[0].netsPaid, 4);
  assert.equal(credit(state, 'felicia-chicken-rice'), 0);
});

test('Amount validation, $1 NETS floor, campaign cap and duplicate payment safety', async function() {
  const v = visitor();
  await v.request('/home');
  const pending = await scan(v, 'green-bowl');
  assert.equal((await v.request('/scan/payment', { journeyId: pending.id, amount: '4.999' })).location,
    '/scan/payment?error=amount');
  await v.change(function(demo) { demo.vouchCredits['green-bowl'] = 5; });
  await Promise.all([
    v.request('/scan/payment', { journeyId: pending.id, amount: '4.80', useCashback: 'on' }),
    v.request('/scan/payment', { journeyId: pending.id, amount: '4.80', useCashback: 'on' })
  ]);
  let state = (await v.state()).demo;
  assert.equal(state.transactions.length, 1);
  assert.equal(state.transactions[0].merchantCreditUsed, 3.8);
  assert.equal(state.transactions[0].netsPaid, 1);
  // $4.80 is below the campaign's $5 minimum eligible spend, so no reward is added to the credit balance.
  assert.equal(credit(state, 'green-bowl'), 1.2);
  await v.request('/vouch/' + state.transactions[0].id, { action: 'skip' });
  const next = await scan(v, 'green-bowl');
  const cappedCampaign = getMerchantCampaigns().find(function(item) { return item.merchantId === 'green-bowl'; });
  cappedCampaign.redemptionsToday = cappedCampaign.maxRewardedPaymentsPerDay;
  await v.request('/scan/payment', { journeyId: next.id, amount: '6.00' });
  state = (await v.state()).demo;
  assert.equal(state.transactions[0].merchantRewardEarned, 0);
});

test('Reward eligibility respects minimum spend and daily reward budget, and merchant sees a max-cost estimate', async function() {
  const v = visitor();
  await v.request('/home');
  const campaign = getMerchantCampaigns().find(function(item) { return item.merchantId === 'green-bowl'; });
  assert.equal(campaign.minimumEligibleSpend, 5);
  const initialMerchantPage = await v.request('/merchant?merchantId=green-bowl&tab=campaign');
  assert.match(initialMerchantPage.html, /Maximum merchant reward spend[\s\S]*\$10\.00/);
  assert.match(initialMerchantPage.html, /Maximum NETS success fees[\s\S]*\$2\.00/);
  assert.match(initialMerchantPage.html, /Maximum campaign cost[\s\S]*\$12\.00/);
  assert.match(initialMerchantPage.html, /Referral rewards are included within the reward budget/);
  assert.ok(!initialMerchantPage.html.includes('Possible referral bonus cost'));

  // Below minimum spend: no reward, even though the cap and budget are untouched.
  const belowMinimum = await scan(v, 'green-bowl');
  const paymentPage = await v.request('/scan/payment');
  assert.match(paymentPage.html, /Spend \$5\.00\+ and keep at least \$1 paid with NETS/);
  assert.ok(!paymentPage.html.includes('credit-toggle'));
  assert.ok(!paymentPage.html.includes('−$0.00'));
  const browserScript = await v.request('/js/script.js');
  assert.match(browserScript.html, /This payment won't earn Vouch Credit/);
  await v.request('/scan/payment', { journeyId: belowMinimum.id, amount: '4.00' });
  let state = (await v.state()).demo;
  assert.equal(state.transactions[0].merchantRewardEarned, 0);
  assert.equal(campaign.rewardBudgetSpentToday, 0);

  // Reward budget reached: the next qualifying payment earns no reward, though the payment-count cap is unused.
  campaign.maxRewardBudgetPerDay = 0.5;
  await v.request('/vouch/' + state.transactions[0].id, { action: 'skip' });
  const first = await scan(v, 'green-bowl');
  await v.request('/scan/payment', { journeyId: first.id, amount: '6.00' });
  state = (await v.state()).demo;
  assert.equal(state.transactions[0].merchantRewardEarned, .5);
  assert.equal(campaign.rewardBudgetSpentToday, .5);

  await v.request('/vouch/' + state.transactions[0].id, { action: 'skip' });
  const second = await scan(v, 'green-bowl');
  await v.request('/scan/payment', { journeyId: second.id, amount: '6.00' });
  state = (await v.state()).demo;
  assert.equal(state.transactions[0].merchantRewardEarned, 0);
  assert.equal(campaign.redemptionsToday, 1);

  const merchantPage = await v.request('/merchant?merchantId=green-bowl&tab=campaign');
  assert.match(merchantPage.html, /Estimated maximum daily cost/);
  assert.match(merchantPage.html, /Maximum merchant reward spend/);
  assert.match(merchantPage.html, /Maximum NETS success fees/);
});

test('Merchant campaign cap is shared across different user sessions, not per browser', async function() {
  const jia = visitor();
  const darren = visitor();
  await jia.request('/home');
  await darren.request('/home');
  const campaign = getMerchantCampaigns().find(function(item) { return item.merchantId === 'green-bowl'; });
  campaign.maxRewardedPaymentsPerDay = 2;

  const jiaScan = await scan(jia, 'green-bowl');
  await jia.request('/scan/payment', { journeyId: jiaScan.id, amount: '5.00' });
  const jiaTransaction = (await jia.state()).demo.transactions[0];
  assert.equal(jiaTransaction.merchantRewardEarned, .5);

  const darrenScan = await scan(darren, 'green-bowl');
  await darren.request('/scan/payment', { journeyId: darrenScan.id, amount: '5.00' });
  const darrenTransaction = (await darren.state()).demo.transactions[0];
  assert.equal(darrenTransaction.merchantRewardEarned, .5);
  assert.equal(campaign.redemptionsToday, 2);

  // Cap is now used up globally, so a third qualifying payment (back on Jia's own session) earns no reward.
  await jia.request('/vouch/' + jiaTransaction.id, { action: 'skip' });
  const jiaScanAgain = await scan(jia, 'green-bowl');
  await jia.request('/scan/payment', { journeyId: jiaScanAgain.id, amount: '5.00' });
  const jiaSecondTransaction = (await jia.state()).demo.transactions[0];
  assert.equal(jiaSecondTransaction.merchantRewardEarned, 0);
});

test('Normal Vouch Credit is earned once per user, merchant and Singapore day', async function() {
  const v = visitor();
  await v.request('/home');
  const feliciaCampaign = getMerchantCampaigns().find(function(item) {
    return item.merchantId === 'felicia-chicken-rice';
  });

  const first = await scan(v, 'felicia-chicken-rice');
  await v.request('/scan/payment', { journeyId: first.id, amount: '5.00' });
  let state = (await v.state()).demo;
  assert.equal(state.transactions[0].merchantRewardEarned, .5);
  assert.equal(credit(state, 'felicia-chicken-rice'), .5);
  assert.equal(feliciaCampaign.redemptionsToday, 1);
  assert.equal(feliciaCampaign.rewardBudgetSpentToday, .5);
  await v.request('/vouch/' + state.transactions[0].id, { action: 'skip' });
  assert.match((await v.request('/smart-match/result')).html, /Today's Vouch Credit earned/);

  const second = await scan(v, 'felicia-chicken-rice');
  const secondPaymentPage = await v.request('/scan/payment');
  assert.match(secondPaymentPage.html, /Today's Felicia/);
  await v.request('/scan/payment', { journeyId: second.id, amount: '5.00' });
  state = (await v.state()).demo;
  assert.equal(state.transactions[0].merchantRewardEarned, 0);
  assert.equal(credit(state, 'felicia-chicken-rice'), .5);
  assert.equal(feliciaCampaign.redemptionsToday, 1);
  assert.equal(feliciaCampaign.rewardBudgetSpentToday, .5);
  await v.request('/vouch/' + state.transactions[0].id, { action: 'skip' });

  const green = await scan(v, 'green-bowl');
  await v.request('/scan/payment', { journeyId: green.id, amount: '5.00' });
  state = (await v.state()).demo;
  assert.equal(state.transactions[0].merchantRewardEarned, .5);
  assert.equal(credit(state, 'green-bowl'), .5);
  await v.request('/vouch/' + state.transactions[0].id, { action: 'skip' });

  await v.change(function(demo) {
    demo.dailyMerchantRewards['felicia-chicken-rice'] = '2000-01-01';
  });
  const nextDay = await scan(v, 'felicia-chicken-rice');
  await v.request('/scan/payment', { journeyId: nextDay.id, amount: '5.00' });
  state = (await v.state()).demo;
  assert.equal(state.transactions[0].merchantRewardEarned, .5);
  assert.equal(credit(state, 'felicia-chicken-rice'), 1);
});

test('Using accumulated merchant credit does not block the first daily reward', async function() {
  const v = visitor();
  await v.request('/home');
  await v.change(function(demo) { demo.vouchCredits['felicia-chicken-rice'] = 1; });
  const payment = await scan(v, 'felicia-chicken-rice');
  await v.request('/scan/payment', { journeyId: payment.id, amount: '5.00', useCashback: 'on' });
  const state = (await v.state()).demo;
  assert.equal(state.transactions[0].merchantCreditUsed, 1);
  assert.equal(state.transactions[0].netsPaid, 4);
  assert.equal(state.transactions[0].merchantRewardEarned, .5);
  assert.equal(credit(state, 'felicia-chicken-rice'), .5);
});

test('Shared Vouch claim rewards only after same-merchant payment without stacking', async function() {
  const sender = visitor();
  await sender.request('/home');
  const pending = await scan(sender, 'green-bowl');
  await sender.request('/scan/payment', { journeyId: pending.id, amount: '7.20' });
  const transaction = (await sender.state()).demo.transactions[0];
  assert.equal(transaction.source, 'DIRECT_SCAN');
  const greenBowlCampaign = getMerchantCampaigns().find(function(item) { return item.merchantId === 'green-bowl'; });
  assert.equal(greenBowlCampaign.metrics.directScanPayments, 1);
  assert.equal(greenBowlCampaign.metrics.smartMatchPayments, 0);
  assert.equal(greenBowlCampaign.platformFeeAccrued, 0);
  await sender.request('/vouch/' + transaction.id, { action: 'create' });
  const vouch = (await sender.state()).demo.paymentVerifiedVouches[0];
  const offerPath = '/offers/' + vouch.shareToken;

  // Jia cannot claim her own Vouch, even from what looks like a fresh browser/session.
  const selfReferral = visitor();
  await selfReferral.request(offerPath);
  await selfReferral.request(offerPath + '/claim', {});
  assert.equal((await selfReferral.state()).demo.activeVouchClaim, null);

  const receiver = visitor();
  await receiver.request('/demo/identity', { userId: 'darren' });
  await receiver.request(offerPath);
  await receiver.request(offerPath + '/claim', {});
  let state = (await receiver.state()).demo;
  assert.equal(credit(state, 'green-bowl'), 0);
  assert.equal(state.activeVouchClaim.status, 'CLAIMED');
  // Only $0.60 remains: prioritise the $0.50 receiver reward and skip the $0.20 sender reward.
  greenBowlCampaign.maxRewardBudgetPerDay = 1.10;
  const claimedScan = await scan(receiver, 'green-bowl');
  await receiver.request('/scan/payment', { journeyId: claimedScan.id, amount: '6.00' });
  state = (await receiver.state()).demo;
  assert.equal(state.activeVouchClaim.status, 'REDEEMED');
  assert.equal(credit(state, 'green-bowl'), .5);
  assert.equal(state.transactions[0].source, 'SHARED_VOUCH');
  assert.equal(state.transactions[0].merchantRewardEarned, .5);
  assert.equal(greenBowlCampaign.metrics.sharedVouchPayments, 1);
  assert.equal(greenBowlCampaign.platformFeeAccrued, greenBowlCampaign.platformFeePerAttributedPayment);
  assert.equal(greenBowlCampaign.rewardBudgetSpentToday, 1);
  assert.ok(greenBowlCampaign.rewardBudgetSpentToday <= greenBowlCampaign.maxRewardBudgetPerDay);
  assert.equal(greenBowlCampaign.redemptionsToday, 2);
  await sender.request('/home');
  assert.equal(credit((await sender.state()).demo, 'green-bowl'), .5);
  await receiver.request('/scan/payment', { journeyId: claimedScan.id, amount: '4.80' });
  assert.equal(credit((await receiver.state()).demo, 'green-bowl'), .5);

  const wrongMerchant = visitor();
  await wrongMerchant.request('/demo/identity', { userId: 'darren' });
  await wrongMerchant.request(offerPath + '/claim', {});
  const wrongScan = await scan(wrongMerchant, 'spice-lane');
  await wrongMerchant.request('/scan/payment', { journeyId: wrongScan.id, amount: '4.80' });
  state = (await wrongMerchant.state()).demo;
  assert.equal(state.activeVouchClaim.status, 'CLAIMED');
  assert.equal(credit(state, 'green-bowl'), 0);
});

test('Switching demo identity keeps Jia and Darren consumer state separate', async function() {
  const v = visitor();
  await v.request('/home');
  await v.change(function(demo) {
    demo.vouchCredits['green-bowl'] = 1;
    demo.transactions.push({ id: 'jia-only' });
  });
  await v.request('/demo/identity', { userId: 'darren' });
  let state = (await v.state()).demo;
  assert.equal(state.user.id, 'darren');
  assert.equal(credit(state, 'green-bowl'), 0);
  assert.equal(state.transactions.length, 0);
  await v.request('/demo/identity', { userId: 'jia' });
  state = (await v.state()).demo;
  assert.equal(state.user.id, 'jia');
  assert.equal(credit(state, 'green-bowl'), 1);
  assert.equal(state.transactions[0].id, 'jia-only');
});

test('Shared Vouch claim expires after 20 minutes and stops redeeming as a referral', async function() {
  const sender = visitor();
  await sender.request('/home');
  const pending = await scan(sender, 'green-bowl');
  await sender.request('/scan/payment', { journeyId: pending.id, amount: '7.20' });
  const transaction = (await sender.state()).demo.transactions[0];
  await sender.request('/vouch/' + transaction.id, { action: 'create' });
  const vouch = (await sender.state()).demo.paymentVerifiedVouches[0];
  const offerPath = '/offers/' + vouch.shareToken;

  const receiver = visitor();
  await receiver.request('/demo/identity', { userId: 'darren' });
  await receiver.request(offerPath);
  await receiver.request(offerPath + '/claim', {});
  await receiver.change(function(demo) { demo.activeVouchClaim.expiresAt = Date.now() - 1000; });

  const expiredView = await receiver.request(offerPath);
  assert.match(expiredView.html, /expired/i);

  const scanned = await scan(receiver, 'green-bowl');
  await receiver.request('/scan/payment', { journeyId: scanned.id, amount: '6.00' });
  const state = (await receiver.state()).demo;
  assert.equal(state.transactions[0].source, 'DIRECT_SCAN');
  assert.equal(state.activeVouchClaim.status, 'EXPIRED');
});

test('Referral cooldown blocks repeated rewarded conversions for the same sender, recipient and merchant', async function() {
  const sender = visitor();
  await sender.request('/home');
  async function payAndVouch(amount) {
    const scanned = await scan(sender, 'green-bowl');
    await sender.request('/scan/payment', { journeyId: scanned.id, amount: amount });
    const tx = (await sender.state()).demo.transactions[0];
    await sender.request('/vouch/' + tx.id, { action: 'create' });
    return (await sender.state()).demo.paymentVerifiedVouches[0];
  }

  const firstVouch = await payAndVouch('7.20');
  const receiver = visitor();
  await receiver.request('/demo/identity', { userId: 'darren' });
  await receiver.request('/offers/' + firstVouch.shareToken + '/claim', {});
  const firstScan = await scan(receiver, 'green-bowl');
  await receiver.request('/scan/payment', { journeyId: firstScan.id, amount: '6.00' });
  let state = (await receiver.state()).demo;
  assert.equal(state.transactions[0].source, 'SHARED_VOUCH');
  assert.equal(state.transactions[0].merchantRewardEarned, .5);

  // Same sender, recipient and merchant try to farm a second rewarded referral straight away.
  const secondVouch = await payAndVouch('7.20');
  await receiver.request('/vouch/' + state.transactions[0].id, { action: 'skip' });
  await receiver.request('/offers/' + secondVouch.shareToken + '/claim', {});
  const secondScan = await scan(receiver, 'green-bowl');
  await receiver.request('/scan/payment', { journeyId: secondScan.id, amount: '6.00' });
  state = (await receiver.state()).demo;
  assert.equal(state.transactions[0].source, 'DIRECT_SCAN');
  assert.equal(state.activeVouchClaim.status, 'CLAIMED');
});

test('Retired preorder routes are safe and active pages render', async function() {
  const v = visitor();
  for (const path of ['/payment', '/order', '/collection', '/vouch', '/scan/payment']) {
    assert.equal((await v.request(path)).status, 302, path);
  }
  for (const path of ['/vouch/missing', '/payment-success/missing']) {
    assert.equal((await v.request(path)).status, 404, path);
  }
  await v.request('/home');
  const pending = await scan(v, 'felicia-chicken-rice');
  await v.request('/scan/payment', { journeyId: pending.id, amount: '6.00' });
  const id = (await v.state()).demo.transactions[0].id;
  await v.request('/vouch/' + id, { action: 'skip' });
  const pages = ['/home', '/profile', '/profile/preferences', '/profile/rewards', '/profile/vouches', '/profile/activity',
    '/transactions/' + id, '/merchant', '/merchant?tab=results', '/scan',
    '/payment-success/' + id, '/demo', '/css/style.css', '/js/script.js'];
  for (const path of pages) assert.equal((await v.request(path)).status, 200, path);
  assert.equal((await v.request('/merchant?tab=orders')).status, 200);
  assert.ok(!(await v.request('/merchant?tab=orders')).html.includes('Start preparing'));
  const script = await v.request('/js/script.js');
  assert.match(script.html, /wa\.me/);
  assert.match(script.html, /t\.me\/share/);
});

test('Task 1 regression — Smart Match still recommends Felicia first by default', async function() {
  const v = visitor();
  const result = await match(v);
  assert.match(result.html, /felicia-chicken-rice/);
  assert.match(result.html, /Choose this/);
});

test('Task 3 regression — Smart Match route resolves correctly after async refactor', async function() {
  const v = visitor();
  await v.request('/home');
  const result = await v.request('/smart-match/result');
  assert.equal(result.status, 200);
  assert.match(result.html, /felicia-chicken-rice/);
  assert.match(result.html, /Why this match/);
});

test('Task 7 — daily reward is per-user; campaign cap is shared globally across sessions', async function() {
  const jia = visitor();
  const darren = visitor();
  await jia.request('/home');
  await darren.request('/demo/identity', { userId: 'darren' });

  // Both pay Felicia — each earns their own first daily reward independently
  const jiaScan = await scan(jia, 'felicia-chicken-rice');
  await jia.request('/scan/payment', { journeyId: jiaScan.id, amount: '5.00' });
  const jiaTx = (await jia.state()).demo.transactions[0];
  assert.equal(jiaTx.merchantRewardEarned, 0.50);
  await jia.request('/vouch/' + jiaTx.id, { action: 'skip' });

  const darrenScan = await scan(darren, 'felicia-chicken-rice');
  await darren.request('/scan/payment', { journeyId: darrenScan.id, amount: '5.00' });
  const darrenTx = (await darren.state()).demo.transactions[0];
  assert.equal(darrenTx.merchantRewardEarned, 0.50);
  await darren.request('/vouch/' + darrenTx.id, { action: 'skip' });

  // Jia's second visit today earns no repeat reward — daily limit is per-user
  const jiaSecondScan = await scan(jia, 'felicia-chicken-rice');
  await jia.request('/scan/payment', { journeyId: jiaSecondScan.id, amount: '5.00' });
  const jiaSecondTx = (await jia.state()).demo.transactions[0];
  assert.equal(jiaSecondTx.merchantRewardEarned, 0);
  await jia.request('/vouch/' + jiaSecondTx.id, { action: 'skip' });

  // Campaign cap is global: set cap to current redemptions (2), then clear Jia's daily limit
  const campaign = getMerchantCampaigns().find(function(c) { return c.merchantId === 'felicia-chicken-rice'; });
  assert.equal(campaign.redemptionsToday, 2);
  campaign.maxRewardedPaymentsPerDay = 2;
  await jia.change(function(demo) { demo.dailyMerchantRewards['felicia-chicken-rice'] = '2000-01-01'; });

  // Even though Jia's daily limit is cleared, global cap is exhausted → no reward
  const jiaCappedScan = await scan(jia, 'felicia-chicken-rice');
  await jia.request('/scan/payment', { journeyId: jiaCappedScan.id, amount: '5.00' });
  const jiaCappedTx = (await jia.state()).demo.transactions[0];
  assert.equal(jiaCappedTx.merchantRewardEarned, 0);
});

test('Task 6 — full Open House story: Jia Smart Match → Vouch → Darren pays → Felicia sees both conversions', async function() {
  const jia = visitor();
  const darren = visitor();

  // Jia: Smart Match → accept → scan → pay → vouch → share
  await jia.request('/home');
  const matchResult = await jia.request('/smart-match/result');
  assert.match(matchResult.html, /felicia-chicken-rice/);
  const feliciaId = (await jia.state()).demo.selectedMerchantId;
  await jia.request('/recommendation/accept', { merchantId: feliciaId });
  const jiaScan = await scan(jia, feliciaId);
  await jia.request('/scan/payment', { journeyId: jiaScan.id, amount: '5.00' });
  const jiaTx = (await jia.state()).demo.transactions[0];
  assert.equal(jiaTx.source, 'SMART_MATCH');
  assert.equal(jiaTx.merchantRewardEarned, 0.50);
  await jia.request('/vouch/' + jiaTx.id, { action: 'create', tag: 'worth-it' });
  const jiaVouch = (await jia.state()).demo.paymentVerifiedVouches[0];
  const offerPath = '/offers/' + jiaVouch.shareToken;

  // Darren: switch identity → claim offer → pay at same merchant
  await darren.request('/demo/identity', { userId: 'darren' });
  await darren.request(offerPath);
  await darren.request(offerPath + '/claim', {});
  const darrenScan = await scan(darren, feliciaId);
  await darren.request('/scan/payment', { journeyId: darrenScan.id, amount: '5.00' });
  const darrenTx = (await darren.state()).demo.transactions[0];
  assert.equal(darrenTx.source, 'SHARED_VOUCH');
  assert.equal(darrenTx.merchantRewardEarned, 0.50);

  // Felicia's campaign metrics reflect both attributed channels
  const campaign = getMerchantCampaigns().find(function(c) { return c.merchantId === feliciaId; });
  assert.equal(campaign.metrics.smartMatchPayments, 1);
  assert.equal(campaign.metrics.sharedVouchPayments, 1);
  assert.equal(campaign.metrics.directScanPayments, 0);
  assert.ok(campaign.metrics.smartMatchSales > 0);
  assert.ok(campaign.metrics.sharedVouchSales > 0);
  assert.equal(campaign.metrics.sharedVouchClaims, 1);
  assert.ok(campaign.platformFeeAccrued > 0);

  // Merchant results page renders without error and shows both channels
  const merchantPage = await jia.request('/merchant?merchantId=' + feliciaId + '&tab=results');
  assert.equal(merchantPage.status, 200);
  assert.match(merchantPage.html, /Smart Match payments/);
  assert.match(merchantPage.html, /Shared Vouch conversion/);
});

test('Task 5 — merchant results tab shows Shared Vouch conversion rate', async function() {
  const v = visitor();
  await v.request('/home');
  const page = await v.request('/merchant?merchantId=green-bowl&tab=results');
  assert.equal(page.status, 200);
  assert.match(page.html, /Shared Vouch conversion/);
});

test('Task 4 — smart-match-card renders Why this match section with a non-empty reason', async function() {
  const v = visitor();
  await v.request('/home');
  const result = await v.request('/smart-match/result');
  assert.equal(result.status, 200);
  // The why block must exist and contain some text after the heading
  assert.match(result.html, /Why this match\?<\/strong><p>[^<]+<\/p>/);
});

test('merchant results tab shows channel attribution chart', async function() {
  const v = visitor();
  await v.request('/home');
  const page = await v.request('/merchant?merchantId=felicia-chicken-rice&tab=results');
  assert.equal(page.status, 200);
  assert.match(page.html, /Payments by channel/);
  assert.match(page.html, /chart-fill--smart/);
  assert.match(page.html, /chart-fill--vouch/);
  assert.match(page.html, /chart-fill--direct/);
});
