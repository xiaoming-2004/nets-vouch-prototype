const test = require('node:test');
const assert = require('node:assert/strict');
const { app, demoStore, getMerchantCampaigns, resetMerchantCampaigns } = require('../app');

let server;
let base;
const originalFoursquareKey = process.env.FOURSQUARE_API_KEY;

test.before(async function() {
  delete process.env.FOURSQUARE_API_KEY;
  server = await new Promise(function(resolve) {
    const instance = app.listen(0, '127.0.0.1', function() { resolve(instance); });
  });
  base = 'http://127.0.0.1:' + server.address().port;
});
test.after(function() {
  server.close();
  if (originalFoursquareKey === undefined) delete process.env.FOURSQUARE_API_KEY;
  else process.env.FOURSQUARE_API_KEY = originalFoursquareKey;
});
test.beforeEach(async function() {
  resetMerchantCampaigns();
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
      const setCookie = response.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      const html = await response.text();
      assert.ok(response.status < 500, path + ' returned ' + response.status + '\n' + html);
      return { status: response.status, location: response.headers.get('location'), html: html };
    },
    async state() {
      const id = decodeURIComponent(cookie.split('=')[1]).slice(2).split('.')[0];
      return new Promise(function(resolve, reject) {
        demoStore.get(id, function(error, state) { if (error) reject(error); else resolve(state.demo); });
      });
    },
    async change(update) {
      const id = decodeURIComponent(cookie.split('=')[1]).slice(2).split('.')[0];
      const stored = await new Promise(function(resolve, reject) {
        demoStore.get(id, function(error, state) { if (error) reject(error); else resolve(state); });
      });
      update(stored.demo);
      await new Promise(function(resolve, reject) {
        demoStore.set(id, stored, function(error) { if (error) reject(error); else resolve(); });
      });
    }
  };
}

function campaign(id) {
  return getMerchantCampaigns().find(function(item) { return item.merchantId === id; });
}

async function startScan(v, merchantId) {
  const response = await v.request('/scan', { merchantId: merchantId });
  assert.match(response.location, /^\/scan\/payment/);
  return (await v.state()).currentScanPayment;
}

async function pay(v, merchantId, amount, useCredit) {
  const scan = await startScan(v, merchantId);
  const response = await v.request('/scan/payment', {
    journeyId: scan.id, amount: amount, useCashback: useCredit ? 'on' : ''
  });
  assert.match(response.location, /^\/payment-success\/tx-/);
  return { scan: scan, transaction: (await v.state()).transactions[0] };
}

test('invalid and over-precision amounts cannot create payments, rewards or analytics', async function() {
  const v = visitor();
  const scan = await startScan(v, 'green-bowl');
  for (const amount of ['', '0', '0.00', '-1', '-50', 'abc', 'NaN', 'Infinity', '1e999', ' ', '8.555', '0.009', '999999999']) {
    const posted = await v.request('/scan/payment', { journeyId: scan.id, amount: amount });
    assert.equal(posted.location, '/scan/payment?error=amount', amount);
    assert.match((await v.request(posted.location)).html, /Enter \$0\.01/);
  }
  assert.deepEqual((await v.state()).transactions, []);
  assert.equal(campaign('green-bowl').metrics.payments, 0);
  assert.equal(campaign('green-bowl').rewardBudgetSpentToday, 0);
  const valid = await v.request('/scan/payment', { journeyId: scan.id, amount: '8.5' });
  assert.match(valid.location, /^\/payment-success\/tx-/);
  const tx = (await v.state()).transactions[0];
  assert.equal(tx.purchaseAmount, 8.5);
  assert.equal(tx.netsPaid, 8.5);
  assert.equal(tx.displayAmount, '$8.50');
  assert.ok(!JSON.stringify(tx).includes('8.499999'));
});

test('scan and payment need a valid merchant and current attempt; no implicit merchant fallback', async function() {
  const v = visitor();
  assert.equal((await v.request('/scan/payment')).location, '/scan');
  assert.equal((await v.request('/scan/payment', { journeyId: 'stale', amount: '6.00' })).location, '/scan');
  for (const merchantId of [undefined, '', 'missing-merchant', '__proto__']) {
    const body = merchantId === undefined ? {} : { merchantId: merchantId };
    const result = await v.request('/scan', body);
    assert.equal(result.location, '/scan?error=invalid');
    assert.equal((await v.state()).currentScanPayment, null);
  }
  assert.equal(campaign('green-bowl').metrics.scans, 0);
  assert.deepEqual((await v.state()).transactions, []);
});

test('minimum spend and $1 NETS floor use exact cents', async function() {
  const c = campaign('felicia-chicken-rice');
  c.minimumEligibleSpend = 10;
  for (const [amount, rewarded] of [['9.99', false], ['10.00', true], ['10.01', true]]) {
    const v = visitor();
    const paid = await pay(v, 'felicia-chicken-rice', amount, false);
    assert.equal(paid.transaction.merchantRewardEarned > 0, rewarded, amount);
  }
  assert.equal(c.redemptionsToday, 2);
  assert.equal(c.rewardBudgetSpentToday, 1);
  const v = visitor();
  await v.request('/home');
  await v.change(function(demo) { demo.vouchCredits['felicia-chicken-rice'] = 20; });
  const paid = await pay(v, 'felicia-chicken-rice', '5.00', true);
  assert.equal(paid.transaction.merchantCreditUsed, 4);
  assert.equal(paid.transaction.netsPaid, 1);
  assert.equal(paid.transaction.merchantRewardEarned, 0, 'below the configured $10 spend minimum');
  assert.equal((await v.state()).vouchCredits['felicia-chicken-rice'], 16);
});

test('exact NETS-paid eligibility boundary is $0.99 / $1.00 / $1.01', async function() {
  const c = campaign('green-bowl');
  c.minimumEligibleSpend = 0;
  for (const [amount, rewarded] of [['0.99', false], ['1.00', true], ['1.01', true]]) {
    const v = visitor();
    const tx = (await pay(v, 'green-bowl', amount)).transaction;
    assert.equal(tx.netsPaid, Number(amount));
    assert.equal(tx.merchantRewardEarned > 0, rewarded, amount);
  }
  assert.equal(c.redemptionsToday, 2);
  assert.equal(c.rewardBudgetSpentToday, 1);
});

test('exhausted budget and rewarded-payment cap block rewards, not successful payments', async function() {
  const c = campaign('green-bowl');
  c.maxRewardBudgetPerDay = 0.50;
  const a = visitor();
  const first = await pay(a, 'green-bowl', '6.00');
  assert.equal(first.transaction.merchantRewardEarned, 0.50);
  const b = visitor();
  const second = await pay(b, 'green-bowl', '6.00');
  assert.equal(second.transaction.status, 'Successful');
  assert.equal(second.transaction.merchantRewardEarned, 0);
  assert.equal(c.rewardBudgetSpentToday, 0.50);
  assert.equal(c.redemptionsToday, 1);
  assert.equal(c.metrics.payments, 2);
  assert.equal(c.metrics.directScanSales, 12);
  c.maxRewardBudgetPerDay = 10;
  c.maxRewardedPaymentsPerDay = 1;
  const d = visitor();
  const capped = await pay(d, 'green-bowl', '6.00');
  assert.equal(capped.transaction.merchantRewardEarned, 0);
  assert.equal(c.redemptionsToday, 1);
  assert.equal(c.rewardBudgetSpentToday, 0.50);
});

test('same-day normal reward is once per merchant, but credit remains usable', async function() {
  const v = visitor();
  const first = await pay(v, 'green-bowl', '5.00');
  assert.equal(first.transaction.merchantRewardEarned, 0.50);
  await v.request('/vouch/' + first.transaction.id, { action: 'skip' });
  const second = await pay(v, 'green-bowl', '5.00', true);
  assert.equal(second.transaction.merchantCreditUsed, 0.50);
  assert.equal(second.transaction.netsPaid, 4.50);
  assert.equal(second.transaction.merchantRewardEarned, 0);
  assert.equal(campaign('green-bowl').redemptionsToday, 1);
  assert.equal(campaign('green-bowl').rewardBudgetSpentToday, 0.50);
  await v.request('/vouch/' + second.transaction.id, { action: 'skip' });
  const other = await pay(v, 'felicia-chicken-rice', '5.00');
  assert.equal(other.transaction.merchantId, 'felicia-chicken-rice');
  assert.equal(other.transaction.merchantRewardEarned, 0.50);
});

test('payment and Vouch replay are idempotent; skip is final', async function() {
  const v = visitor();
  const scan = await startScan(v, 'green-bowl');
  const form = { journeyId: scan.id, amount: '6.00' };
  const [first, replay] = await Promise.all([v.request('/scan/payment', form), v.request('/scan/payment', form)]);
  assert.equal(first.location, replay.location);
  const tx = (await v.state()).transactions[0];
  for (let i = 0; i < 3; i++) await v.request('/payment-success/' + tx.id);
  assert.equal((await v.state()).transactions.length, 1);
  assert.equal(campaign('green-bowl').metrics.payments, 1);
  assert.equal(campaign('green-bowl').rewardBudgetSpentToday, 0.50);
  await Promise.all([v.request('/vouch/' + tx.id, { action: 'create' }), v.request('/vouch/' + tx.id, { action: 'create' })]);
  assert.equal((await v.state()).paymentVerifiedVouches.length, 1);
  assert.equal((await v.request('/vouch/' + tx.id + '/success')).status, 200);
  const skipped = visitor();
  const skipPayment = await pay(skipped, 'felicia-chicken-rice', '6.00');
  await skipped.request('/vouch/' + skipPayment.transaction.id, { action: 'skip' });
  await skipped.request('/vouch/' + skipPayment.transaction.id, { action: 'create' });
  assert.equal((await skipped.state()).transactions[0].vouchDecision, 'skipped');
  assert.equal((await skipped.state()).paymentVerifiedVouches.length, 0);
});

test('private transaction/credit remain owned; public offer reveals no purchase amount', async function() {
  const jia = visitor();
  const paid = await pay(jia, 'green-bowl', '8.50');
  await jia.request('/vouch/' + paid.transaction.id, { action: 'create' });
  const vouch = (await jia.state()).paymentVerifiedVouches[0];
  const darren = visitor();
  await darren.request('/demo/identity', { userId: 'darren' });
  for (const path of ['/transactions/', '/payment-success/', '/vouch/']) {
    assert.equal((await darren.request(path + paid.transaction.id)).status, 404);
  }
  assert.equal((await darren.request('/vouch/' + paid.transaction.id, { action: 'create' })).status, 404);
  assert.equal((await darren.request('/offers/not-a-token')).status, 404);
  const publicOffer = await darren.request('/offers/' + vouch.shareToken);
  assert.equal(publicOffer.status, 200);
  assert.ok(!publicOffer.html.includes('$8.50'));
  assert.ok(!publicOffer.html.includes(paid.transaction.id));
  assert.ok(!publicOffer.html.includes('ownerUserId'));
  assert.deepEqual((await darren.state()).vouchCredits, {});
  const darrenPayment = await pay(darren, 'green-bowl', '5.00', true);
  assert.equal(darrenPayment.transaction.merchantCreditUsed, 0);
});

test('wrong QR after Smart Match is charged and attributed to scanned merchant only', async function() {
  const v = visitor();
  await v.request('/home');
  const result = await v.request('/smart-match/result');
  const selected = result.html.match(/data-merchant-id="([^"]+)"/)[1];
  await v.request('/recommendation/accept', { merchantId: selected });
  const wrong = selected === 'green-bowl' ? 'felicia-chicken-rice' : 'green-bowl';
  const paid = await pay(v, wrong, '6.00');
  assert.equal(paid.transaction.merchantId, wrong);
  assert.equal(paid.transaction.source, 'DIRECT_SCAN');
  assert.equal(campaign(selected).metrics.smartMatchPayments, 0);
  assert.equal(campaign(wrong).metrics.directScanPayments, 1);
  assert.equal(campaign(selected).metrics.rewardCost, 0);
});

test('Singapore midnight resets earning eligibility without deleting accumulated credit', async function() {
  const RealDate = Date;
  let clock = RealDate.parse('2026-09-22T15:59:00Z'); // 23:59 in Singapore
  global.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [clock])); }
    static now() { return clock; }
  };
  try {
    const v = visitor();
    const first = await pay(v, 'green-bowl', '5.00');
    assert.equal(first.transaction.merchantRewardEarned, 0.50);
    await v.request('/vouch/' + first.transaction.id, { action: 'skip' });
    clock = RealDate.parse('2026-09-22T16:01:00Z'); // 00:01 next Singapore day
    const second = await pay(v, 'green-bowl', '5.00');
    assert.equal(second.transaction.merchantRewardEarned, 0.50);
    assert.equal((await v.state()).vouchCredits['green-bowl'], 1);
    assert.equal(campaign('green-bowl').redemptionsToday, 1);
  } finally {
    global.Date = RealDate;
  }
});

test('global reset invalidates stale payment, receipt, Vouch and claim actions across sessions', async function() {
  const jia = visitor();
  const darren = visitor();
  await darren.request('/demo/identity', { userId: 'darren' });
  const staleScan = await startScan(jia, 'green-bowl');
  await darren.request('/reset-demo', {});
  assert.equal((await jia.request('/scan/payment', { journeyId: staleScan.id, amount: '6.00' })).location, '/scan');
  assert.deepEqual((await jia.state()).transactions, []);

  const paid = await pay(jia, 'green-bowl', '6.00');
  await jia.request('/vouch/' + paid.transaction.id, { action: 'create' });
  const token = (await jia.state()).paymentVerifiedVouches[0].shareToken;
  await darren.request('/demo/identity', { userId: 'darren' });
  await darren.request('/offers/' + token + '/claim', {});
  assert.equal((await darren.state()).activeVouchClaim.status, 'CLAIMED');
  await jia.request('/reset-demo', {});
  assert.equal((await jia.request('/transactions/' + paid.transaction.id)).status, 404);
  assert.equal((await jia.request('/payment-success/' + paid.transaction.id)).status, 404);
  assert.equal((await jia.request('/vouch/' + paid.transaction.id, { action: 'create' })).status, 404);
  assert.equal((await darren.request('/offers/' + token)).status, 404);
  assert.equal((await darren.request('/offers/' + token + '/claim', {})).location, '/offers/' + token);
  assert.equal((await darren.state()).activeVouchClaim, null);
  assert.deepEqual((await darren.state()).vouchCredits, {});
  assert.equal(campaign('green-bowl').metrics.sharedVouchClaims, 0);
});

test('merchant dashboard refresh and invalid offer/claim URLs have no metric side effects', async function() {
  const c = campaign('green-bowl');
  const v = visitor();
  const initial = JSON.stringify({ metrics: c.metrics, redemptions: c.redemptionsToday,
    spend: c.rewardBudgetSpentToday, fee: c.platformFeeAccrued });
  for (let i = 0; i < 3; i++) {
    const dashboard = await v.request('/merchant?merchantId=green-bowl&tab=results');
    assert.equal(dashboard.status, 200);
    assert.ok(!dashboard.html.includes('NaN'));
    assert.ok(!dashboard.html.includes('Infinity'));
    assert.ok(!dashboard.html.includes('$-'));
    assert.equal((await v.request('/offers/not-a-token')).status, 404);
    assert.equal((await v.request('/offers/not-a-token/claim', {})).location, '/offers/not-a-token');
  }
  assert.equal(JSON.stringify({ metrics: c.metrics, redemptions: c.redemptionsToday,
    spend: c.rewardBudgetSpentToday, fee: c.platformFeeAccrued }), initial);
});
