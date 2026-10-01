const test = require('node:test');
const assert = require('node:assert/strict');
const { app, demoStore, getMerchantCampaigns, resetMerchantCampaigns, resetReferralCooldowns,
  getRewardCatalogueForTest, getRewardConfigForTest, rewardCreditText, validateRewardLabel } = require('../app');

// A reward in this prototype is a merchant-funded Vouch Credit: a cash balance usable only at that
// merchant. There is no item entitlement and no in-store item redemption, so nothing may be
// presented to a customer as an earned item. These tests pin that down, and cover the per-merchant
// amount/minimum-spend catalogue that the journey suites deliberately pin away.

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
test.beforeEach(function() {
  isolatedProviderEnv.forEach(function(key) { delete process.env[key]; });
  delete process.env.FOURSQUARE_API_KEY;
  resetMerchantCampaigns();
  resetReferralCooldowns();
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
      const stored = await this.state();
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

async function pay(v, merchantId, amount, useCashback) {
  await v.request('/scan');
  await v.request('/scan', { merchantId: merchantId });
  const journey = (await v.state()).demo.currentScanPayment;
  const body = { journeyId: journey.id, amount: amount };
  if (useCashback) body.useCashback = 'on';
  await v.request('/scan/payment', body);
  return (await v.state()).demo.transactions[0];
}

// ---------------------------------------------------------------------------
// Truthful labels
// ---------------------------------------------------------------------------

test('no shipped reward label promises an item; every one reads as a Vouch Credit', function() {
  const catalogue = getRewardCatalogueForTest();
  assert.ok(catalogue.length > 0, 'reward catalogue must not be empty');
  for (const reward of catalogue) {
    const label = reward.rewardLabel;
    assert.ok(typeof label === 'string' && label.length > 0, 'every reward needs a label');
    assert.doesNotMatch(label, /\bfree\b/i, 'in-kind promise in label: ' + label);
    assert.doesNotMatch(label, /\bcomplimentary\b|\bon the house\b|\bgratis\b/i, 'in-kind promise in label: ' + label);
    assert.match(label, /Vouch Credit/i, 'label must describe a credit: ' + label);
    // A stored label must not carry its own amount, or an edited rewardAmount would contradict it.
    assert.doesNotMatch(label, /\$\s*\d/, 'label must not embed an amount: ' + label);
    assert.ok(reward.rewardAmount > 0, 'reward amount must be positive: ' + label);
    assert.ok(reward.minimumEligibleSpend >= 0, 'minimum spend must not be negative: ' + label);
  }
});

test('rewardCreditText always renders the live amount beside the credit label', function() {
  assert.equal(rewardCreditText(0.8, 'Vouch Credit towards a side dish'),
    '$0.80 Vouch Credit towards a side dish');
  // An edited amount changes the rendered text, because the amount is never stored in the label.
  assert.equal(rewardCreditText(1.25, 'Vouch Credit towards a side dish'),
    '$1.25 Vouch Credit towards a side dish');
  assert.equal(rewardCreditText(0.5, ''), '$0.50 Vouch Credit');
  assert.equal(rewardCreditText(0.5, null), '$0.50 Vouch Credit');
  assert.equal(rewardCreditText(0, 'Vouch Credit'), '$0.00 Vouch Credit');
});

test('customer screens describe the reward as a merchant-specific cash credit, never an item', async function() {
  const c = campaign('felicia-chicken-rice');
  c.rewardAmount = 0.80;
  c.minimumEligibleSpend = 5.00;
  c.rewardLabel = 'Vouch Credit towards a side dish';
  const v = visitor();
  await v.request('/home');

  await v.request('/scan', { merchantId: 'felicia-chicken-rice' });
  const paymentPage = await v.request('/scan/payment');
  assert.match(paymentPage.html, /Earn \$0\.80 Felicia&#39;s Chicken Rice Vouch Credit/);
  assert.doesNotMatch(paymentPage.html, /\bfree\b/i);

  const tx = await pay(v, 'felicia-chicken-rice', '6.00');
  assert.equal(tx.merchantRewardEarned, 0.80);
  const receipt = await v.request('/payment-success/' + tx.id);
  assert.match(receipt.html, /\+\$0\.80 Vouch Credit towards a side dish earned/);
  assert.match(receipt.html, /usable only at Felicia&#39;s Chicken Rice/);
  assert.doesNotMatch(receipt.html, /\bfree\b/i);

  const rewards = await v.request('/profile/rewards');
  assert.match(rewards.html, /\$0\.80/);
  assert.match(rewards.html, /Vouch Credit/);
  assert.doesNotMatch(rewards.html, /\bfree\b/i);
});

test('a reward amount edited after the label is chosen is shown, not the stale label text', async function() {
  const c = campaign('felicia-chicken-rice');
  c.rewardLabel = 'Vouch Credit towards a side dish';
  c.rewardAmount = 1.30;
  c.minimumEligibleSpend = 5.00;
  const v = visitor();
  const tx = await pay(v, 'felicia-chicken-rice', '6.00');
  assert.equal(tx.merchantRewardEarned, 1.30);
  const receipt = await v.request('/payment-success/' + tx.id);
  assert.match(receipt.html, /\+\$1\.30 Vouch Credit towards a side dish earned/);
  assert.ok(!receipt.html.includes('$0.80'), 'no stale amount may survive in label text');
});

// ---------------------------------------------------------------------------
// Server-side custom label validation
// ---------------------------------------------------------------------------

test('validateRewardLabel accepts credit descriptions and rejects in-kind or amount-bearing text', function() {
  assert.equal(validateRewardLabel('Vouch Credit towards a wonton side'), 'Vouch Credit towards a wonton side');
  assert.equal(validateRewardLabel('  Vouch   Credit  towards soup  '), 'Vouch Credit towards soup');
  assert.equal(validateRewardLabel('vouch credit towards dessert'), 'vouch credit towards dessert');

  // In-kind promises the backend cannot honour.
  for (const bad of ['Free wonton', 'Free Vouch Credit side', 'Complimentary Vouch Credit drink',
    'Vouch Credit on the house', 'Gratis Vouch Credit', 'Vouch Credit redeemable for a drink']) {
    assert.equal(validateRewardLabel(bad), null, 'must reject in-kind label: ' + bad);
  }
  // Amounts in the label would contradict the live rewardAmount rendered beside it.
  for (const bad of ['$1 Vouch Credit', 'Vouch Credit worth $2.00', 'Vouch Credit 50 cents', 'Vouch Credit 2 dollars']) {
    assert.equal(validateRewardLabel(bad), null, 'must reject amount in label: ' + bad);
  }
  // Must actually say it is a credit.
  assert.equal(validateRewardLabel('Side dish'), null);
  assert.equal(validateRewardLabel('Bonus stamp'), null);
  // Length and markup limits.
  assert.equal(validateRewardLabel(''), null);
  assert.equal(validateRewardLabel('   '), null);
  assert.equal(validateRewardLabel('Vouch Credit ' + 'x'.repeat(60)), null);
  assert.equal(validateRewardLabel('<b>Vouch Credit</b> towards soup'), null);
});

test('the merchant campaign form rejects an untruthful custom label without saving anything', async function() {
  const v = visitor();
  await v.request('/home');
  const before = campaign('felicia-chicken-rice');
  before.rewardLabel = 'Vouch Credit towards a side dish';
  before.rewardAmount = 0.80;
  before.minimumEligibleSpend = 5.00;

  const rejected = await v.request('/merchant/offer', {
    merchantId: 'felicia-chicken-rice', rewardLabel: '__custom__', rewardLabelCustom: 'Free wonton',
    rewardAmount: '0.90', minimumEligibleSpend: '6.00', maxRewardedPaymentsPerDay: '25',
    maxRewardBudgetPerDay: '12.00', startTime: '00:00', endTime: '23:59', status: 'ACTIVE'
  });
  assert.match(rejected.location, /error=label/);
  const after = campaign('felicia-chicken-rice');
  // A rejected submission must not half-apply: the other fields are untouched too.
  assert.equal(after.rewardLabel, 'Vouch Credit towards a side dish');
  assert.equal(after.rewardAmount, 0.80);
  assert.equal(after.minimumEligibleSpend, 5.00);

  const page = await v.request('/merchant?merchantId=felicia-chicken-rice&tab=campaign&error=label');
  assert.match(page.html, /Nothing was saved/);
});

test('the merchant campaign form accepts a truthful custom credit label', async function() {
  const v = visitor();
  await v.request('/home');
  const accepted = await v.request('/merchant/offer', {
    merchantId: 'felicia-chicken-rice', rewardLabel: '__custom__',
    rewardLabelCustom: 'Vouch Credit towards a wonton side',
    rewardAmount: '0.90', minimumEligibleSpend: '6.00', maxRewardedPaymentsPerDay: '25',
    maxRewardBudgetPerDay: '12.00', startTime: '00:00', endTime: '23:59', status: 'ACTIVE'
  });
  assert.ok(!/error=/.test(accepted.location || ''), 'truthful label must be accepted');
  const c = campaign('felicia-chicken-rice');
  assert.equal(c.rewardLabel, 'Vouch Credit towards a wonton side');
  assert.equal(c.rewardAmount, 0.90);
  assert.equal(c.minimumEligibleSpend, 6.00);

  const tx = await pay(visitor(), 'felicia-chicken-rice', '6.00');
  assert.equal(tx.merchantRewardEarned, 0.90);
});

test('an empty label submission keeps the existing label and still saves the other fields', async function() {
  const v = visitor();
  await v.request('/home');
  campaign('felicia-chicken-rice').rewardLabel = 'Vouch Credit towards a side dish';
  const saved = await v.request('/merchant/offer', {
    merchantId: 'felicia-chicken-rice', rewardLabel: '__custom__', rewardLabelCustom: '',
    rewardAmount: '1.10', minimumEligibleSpend: '7.00', maxRewardedPaymentsPerDay: '25',
    maxRewardBudgetPerDay: '12.00', startTime: '00:00', endTime: '23:59', status: 'ACTIVE'
  });
  assert.ok(!/error=/.test(saved.location || ''));
  const c = campaign('felicia-chicken-rice');
  assert.equal(c.rewardLabel, 'Vouch Credit towards a side dish');
  assert.equal(c.rewardAmount, 1.10);
  assert.equal(c.minimumEligibleSpend, 7.00);
});

// ---------------------------------------------------------------------------
// Per-merchant catalogue and threshold boundaries
// ---------------------------------------------------------------------------

test('the shipped catalogue really is merchant-specific and is used to build each campaign', function() {
  const ids = ['felicia-chicken-rice', 'green-bowl', 'woodlands-noodle-bar', 'northside-wraps', 'spice-lane'];
  const amounts = new Set();
  const minimums = new Set();
  for (const id of ids) {
    const configured = getRewardConfigForTest(id);
    const built = campaign(id);
    assert.equal(built.rewardAmount, configured.rewardAmount, id + ' campaign amount');
    assert.equal(built.minimumEligibleSpend, configured.minimumEligibleSpend, id + ' campaign minimum');
    assert.equal(built.rewardLabel, configured.rewardLabel, id + ' campaign label');
    amounts.add(configured.rewardAmount);
    minimums.add(configured.minimumEligibleSpend);
  }
  assert.ok(amounts.size > 1, 'reward amounts must differ between merchants');
  assert.ok(minimums.size > 1, 'minimum spends must differ between merchants');
});

test('each merchant minimum spend is enforced at its own exact-cent boundary', async function() {
  for (const merchantId of ['felicia-chicken-rice', 'green-bowl', 'spice-lane']) {
    resetMerchantCampaigns();
    const c = campaign(merchantId);
    const minimum = c.minimumEligibleSpend;
    const reward = c.rewardAmount;
    assert.ok(minimum >= 1, merchantId + ' needs a minimum above the $1 NETS floor for this check');
    // Give each attempt a generous budget so only the minimum spend can decide the outcome.
    c.maxRewardBudgetPerDay = 1000;
    c.maxRewardedPaymentsPerDay = 1000;

    const justUnder = (minimum - 0.01).toFixed(2);
    const exactly = minimum.toFixed(2);
    const justOver = (minimum + 0.01).toFixed(2);

    assert.equal((await pay(visitor(), merchantId, justUnder)).merchantRewardEarned, 0,
      merchantId + ' must not reward ' + justUnder + ' below its $' + exactly + ' minimum');
    assert.equal((await pay(visitor(), merchantId, exactly)).merchantRewardEarned, reward,
      merchantId + ' must reward exactly $' + exactly);
    assert.equal((await pay(visitor(), merchantId, justOver)).merchantRewardEarned, reward,
      merchantId + ' must reward $' + justOver);
  }
});

test('the $1 NETS-paid floor still applies when merchant credit covers most of a qualifying spend', async function() {
  const c = campaign('felicia-chicken-rice');
  c.minimumEligibleSpend = 5.00;
  c.rewardAmount = 0.80;
  const v = visitor();
  await v.request('/home');
  await v.change(function(demo) { demo.vouchCredits['felicia-chicken-rice'] = 20; });
  // Spend meets the minimum, and the server still leaves $1 payable with NETS, so this earns.
  const tx = await pay(v, 'felicia-chicken-rice', '5.00', true);
  assert.equal(tx.merchantCreditUsed, 4);
  assert.equal(tx.netsPaid, 1);
  assert.equal(tx.eligible, true);
  assert.equal(tx.merchantRewardEarned, 0.80);
});

test('a discovered merchant gets one catalogue offer and keeps it across repeated lookups', function() {
  const first = getRewardConfigForTest('some-discovered-place-123');
  const again = getRewardConfigForTest('some-discovered-place-123');
  assert.deepEqual(first, again, 'the same merchant must not get a different offer each lookup');
  assert.ok(first.rewardAmount > 0);
  assert.match(first.rewardLabel, /Vouch Credit/i);
  assert.doesNotMatch(first.rewardLabel, /\bfree\b/i);
});
