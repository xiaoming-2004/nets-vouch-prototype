const test = require('node:test');
const assert = require('node:assert/strict');
const { app, demoStore, getMerchantCampaigns,
  resetMerchantCampaigns, resetReferralCooldowns } = require('../app');

const originalKey = process.env.FOURSQUARE_API_KEY;
let server;
let base;

test.before(async function() {
  server = await new Promise(function(resolve) {
    const instance = app.listen(0, '127.0.0.1', function() { resolve(instance); });
  });
  base = 'http://127.0.0.1:' + server.address().port;
});
test.after(function() { server.close(); });
test.beforeEach(async function() {
  delete process.env.FOURSQUARE_API_KEY;
  resetMerchantCampaigns();
  resetReferralCooldowns();
  await visitor().request('/reset-demo', {});
});
test.afterEach(function() {
  if (originalKey === undefined) delete process.env.FOURSQUARE_API_KEY;
  else process.env.FOURSQUARE_API_KEY = originalKey;
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

function campaign(id) {
  return getMerchantCampaigns().find(function(item) { return item.merchantId === id; });
}

async function scanAndPay(v, merchantId, amount, useCredit) {
  await v.request('/scan');
  await v.request('/scan', { merchantId: merchantId });
  const journey = (await v.state()).demo.currentScanPayment;
  const response = await v.request('/scan/payment', {
    journeyId: journey.id, amount: amount, useCashback: useCredit ? 'on' : ''
  });
  assert.match(response.location, /^\/payment-success\/tx-/);
  return { transaction: (await v.state()).demo.transactions[0], journeyId: journey.id };
}

async function results(v, merchantId) {
  return (await v.request('/merchant?merchantId=' + merchantId + '&tab=results')).html;
}

test('empty live dashboard is separate from labelled illustrative baseline; conversions show 0%', async function() {
  const v = visitor();
  const c = campaign('felicia-chicken-rice');
  const html = await results(v, c.merchantId);
  assert.equal(c.metrics.payments, 0);
  assert.match(html, /Illustrative Prototype Data/);
  assert.match(html, /Live demo activity/);
  assert.match(html, /Sample: 494 payments/);
  assert.match(html, /Gross purchase sales<\/small><b>\$0\.00/);
  assert.match(html, /Shared Vouch conversion<\/dt><dd>0%/);
  assert.match(html, /Smart Match conversion<\/dt><dd>0%/);
  assert.ok(!html.includes('NaN'));
  assert.ok(!html.includes('Infinity'));
});

test('Smart Match shown, rejection, acceptance and payment remain distinct and idempotent', async function() {
  const v = visitor();
  await v.request('/home');
  await v.request('/smart-match/result');
  const id = (await v.state()).demo.selectedMerchantId;
  const c = campaign(id);
  assert.equal(c.metrics.smartMatchShown, 1);
  assert.equal(c.metrics.smartMatchAccepted, 0);
  assert.equal(c.metrics.smartMatchPayments, 0);
  await v.request('/smart-match/result');
  assert.equal(c.metrics.smartMatchShown, 1, 'refresh is not a second impression');
  await v.request('/recommendation/accept', { merchantId: id });
  await v.request('/recommendation/accept', { merchantId: id });
  assert.equal(c.metrics.smartMatchAccepted, 1);
  assert.equal(c.metrics.smartMatchPayments, 0);
  const paid = await scanAndPay(v, id, '5.00');
  assert.equal(paid.transaction.source, 'SMART_MATCH');
  assert.equal(c.metrics.smartMatchPayments, 1);
  assert.equal(c.metrics.smartMatchSales, 5);
  assert.equal(c.metrics.directScanPayments, 0);
  assert.equal(c.platformFeeAccrued, c.platformFeePerAttributedPayment);
  await v.request('/payment-success/' + paid.transaction.id);
  await v.request('/transactions/' + paid.transaction.id);
  await results(v, id);
  await v.request('/scan/payment', { journeyId: paid.journeyId, amount: '5.00' });
  assert.equal(c.metrics.payments, 1);
  assert.equal(c.metrics.smartMatchPayments, 1);
  assert.equal(c.metrics.rewardCost, 0.50);
});

test('rejection is not acceptance; the alternative is a separate shown merchant', async function() {
  const v = visitor();
  await v.request('/home');
  await v.request('/smart-match/result');
  const firstId = (await v.state()).demo.selectedMerchantId;
  await v.request('/recommendation/reject', { merchantId: firstId, reason: 'not-in-mood' });
  assert.equal(campaign(firstId).metrics.smartMatchAccepted, 0);
  await v.request('/smart-match/result');
  const secondId = (await v.state()).demo.selectedMerchantId;
  assert.notEqual(secondId, firstId);
  assert.equal(campaign(firstId).metrics.smartMatchShown, 1);
  assert.equal(campaign(secondId).metrics.smartMatchShown, 1);
});

test('Direct Scan gross sales, NETS-paid feed, merchant isolation and no success fee', async function() {
  const v = visitor();
  await v.request('/home');
  await v.change(function(demo) { demo.vouchCredits['green-bowl'] = 1; });
  const paid = await scanAndPay(v, 'green-bowl', '6.00', true);
  const green = campaign('green-bowl');
  const felicia = campaign('felicia-chicken-rice');
  assert.equal(paid.transaction.source, 'DIRECT_SCAN');
  assert.equal(paid.transaction.netsPaid, 5);
  assert.equal(green.metrics.directScanPayments, 1);
  assert.equal(green.metrics.directScanSales, 6, 'merchant sales use gross purchase value');
  assert.equal(green.metrics.smartMatchPayments, 0);
  assert.equal(green.metrics.sharedVouchPayments, 0);
  assert.equal(green.platformFeeAccrued, 0);
  assert.equal(felicia.metrics.payments, 0);
  const html = await results(v, 'green-bowl');
  assert.match(html, /Gross purchase sales<\/small><b>\$6\.00/);
  assert.match(html, /Recent live payments · NETS paid/);
  assert.match(html, /\$5\.00/);
  assert.ok(!(await results(v, 'felicia-chicken-rice')).includes('Recent live payments'));
});

test('shared claim counts once, receiver payment counts once, sender bonus only adds reward spend', async function() {
  const sender = visitor();
  const senderPaid = await scanAndPay(sender, 'green-bowl', '7.20');
  await sender.request('/vouch/' + senderPaid.transaction.id, { action: 'create' });
  const token = (await sender.state()).demo.paymentVerifiedVouches[0].shareToken;
  const c = campaign('green-bowl');
  const before = { payments: c.metrics.payments, spend: c.metrics.rewardCost,
    budget: c.rewardBudgetSpentToday, slots: c.redemptionsToday };
  const receiver = visitor();
  await receiver.request('/demo/identity', { userId: 'darren' });
  await receiver.request('/offers/' + token);
  assert.equal(c.metrics.sharedVouchClaims, 0);
  await receiver.request('/offers/' + token + '/claim', {});
  await receiver.request('/offers/' + token + '/claim', {});
  assert.equal(c.metrics.sharedVouchClaims, 1);
  assert.equal(c.metrics.sharedVouchPayments, 0);
  assert.equal(c.metrics.rewardCost, before.spend);
  const received = await scanAndPay(receiver, 'green-bowl', '6.00');
  assert.equal(received.transaction.source, 'SHARED_VOUCH');
  assert.equal(c.metrics.sharedVouchPayments, 1);
  assert.equal(c.metrics.sharedVouchSales, 6);
  assert.equal(c.metrics.directScanPayments, 1, 'sender Direct Scan remains separate');
  assert.equal(c.metrics.payments, before.payments + 1);
  assert.equal(c.redemptionsToday, before.slots + 1);
  assert.equal(c.metrics.rewardCost, before.spend + 0.70);
  assert.equal(c.rewardBudgetSpentToday, before.budget + 0.70);
  assert.equal(c.platformFeeAccrued, c.platformFeePerAttributedPayment);
  await sender.request('/home');
  assert.equal(c.metrics.payments, before.payments + 1, 'sender credit delivery is not another payment');
  const html = await results(sender, 'green-bowl');
  assert.match(html, /Shared Vouch conversion<\/dt><dd>100%/);
  assert.match(html, /Merchant reward spend<\/small><b>\$1\.20/);
  assert.match(html, /Illustrative success fees<\/small><b>\$0\.10/);
});

test('invalid attempt makes no sale; below-minimum successful payment records sale but no reward', async function() {
  const v = visitor();
  await v.request('/scan');
  await v.request('/scan', { merchantId: 'green-bowl' });
  const journey = (await v.state()).demo.currentScanPayment;
  const c = campaign('green-bowl');
  await v.request('/scan/payment', { journeyId: journey.id, amount: 'invalid' });
  assert.equal(c.metrics.payments, 0);
  assert.equal(c.metrics.directScanSales, 0);
  assert.equal(c.metrics.rewardCost, 0);
  assert.equal(c.platformFeeAccrued, 0);
  await v.request('/scan/payment', { journeyId: journey.id, amount: '3.00' });
  assert.equal(c.metrics.payments, 1);
  assert.equal(c.metrics.directScanSales, 3);
  assert.equal(c.redemptionsToday, 0);
  assert.equal(c.rewardBudgetSpentToday, 0);
  assert.equal(c.metrics.rewardCost, 0);
  assert.equal(c.platformFeeAccrued, 0);
});

test('conversion formulas use each channel denominator and never include Direct Scan', async function() {
  const v = visitor();
  const c = campaign('felicia-chicken-rice');
  c.metrics.smartMatchShown = 10;
  c.metrics.smartMatchPayments = 2;
  c.metrics.sharedVouchClaims = 4;
  c.metrics.sharedVouchPayments = 1;
  c.metrics.directScanPayments = 9;
  const html = await results(v, c.merchantId);
  assert.match(html, /Smart Match conversion<\/dt><dd>20%/);
  assert.match(html, /Shared Vouch conversion<\/dt><dd>25%/);
});

test('Reset Demo clears live merchant metrics and feed while preserving illustrative baseline', async function() {
  const v = visitor();
  await scanAndPay(v, 'green-bowl', '5.37');
  let html = await results(v, 'green-bowl');
  assert.match(html, /Live demo activity/);
  assert.match(html, /\$5\.37/);
  await v.request('/reset-demo', {});
  html = await results(v, 'green-bowl');
  assert.equal(campaign('green-bowl').metrics.payments, 0);
  assert.match(html, /Illustrative Prototype Data/);
  assert.match(html, /Sample: 179 payments/);
  assert.match(html, /Gross purchase sales<\/small><b>\$0\.00/);
  assert.ok(!html.includes('$5.37'));
});
