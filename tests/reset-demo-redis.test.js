const test = require('node:test');
const assert = require('node:assert/strict');

// Reset Demo must give the same documented result when the configured session store is the custom
// Upstash/Redis store, which implements only get/set/destroy and has no all(). Every other suite
// exercises MemoryStore, so without this file the configured production path is never tested.
//
// No real Redis service and no .env credentials are used: the @upstash/redis module is replaced in
// the require cache with an in-process fake that speaks the same commands the store calls, and the
// app is then loaded fresh against it.

// ---------------------------------------------------------------------------
// Fake Upstash client: the REST commands this prototype actually issues.
// ---------------------------------------------------------------------------
class FakeUpstashRedis {
  constructor(options) {
    assert.ok(options && options.url && options.token, 'client must be built from url + token');
    this.url = options.url;
    this.store = new Map();          // key -> JSON string
    this.calls = [];                 // command log, for assertions
    this.failNextSet = false;
  }
  _expired(key) {
    const entry = this.store.get(key);
    if (entry && entry.expiresAt && Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return true;
    }
    return false;
  }
  async get(key) {
    this.calls.push(['get', key]);
    this._expired(key);
    const entry = this.store.get(key);
    return entry ? entry.value : null;
  }
  async setex(key, seconds, value) {
    this.calls.push(['setex', key, seconds]);
    if (this.failNextSet) {
      this.failNextSet = false;
      throw new Error('simulated Upstash write failure');
    }
    this.store.set(key, { value: value, expiresAt: Date.now() + seconds * 1000 });
    return 'OK';
  }
  async del(key) {
    this.calls.push(['del', key]);
    return this.store.delete(key) ? 1 : 0;
  }
  async set(key, value, options) {
    this.calls.push(['set', key]);
    if (options && options.nx && this.store.has(key)) return null;
    this.store.set(key, { value: value, expiresAt: options && options.px ? Date.now() + options.px : 0 });
    return 'OK';
  }
  async mget() {
    this.calls.push(['mget']);
    return Array.from(arguments).map(function() { return null; });
  }
  sessionKeys() {
    return Array.from(this.store.keys()).filter(function(k) { return k.startsWith('sess:'); });
  }
}

// ---------------------------------------------------------------------------
// Load the app against the fake, with Upstash configured.
// ---------------------------------------------------------------------------
const upstashPath = require.resolve('@upstash/redis');
const appPath = require.resolve('../app');
const originalUpstashModule = require.cache[upstashPath];

let created = [];
require.cache[upstashPath] = {
  id: upstashPath, filename: upstashPath, loaded: true, exports: {
    Redis: function (options) {
      const client = new FakeUpstashRedis(options);
      created.push(client);
      return client;
    }
  }
};

const savedEnv = {};
['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'GOOGLE_PLACES_API_KEY', 'PLACES_PROVIDER',
 'GROQ_API_KEY', 'OPENAI_API_KEY', 'TAVILY_API_KEY', 'FOURSQUARE_API_KEY'].forEach(function(key) {
  savedEnv[key] = process.env[key];
});
process.env.UPSTASH_REDIS_REST_URL = 'https://fake-upstash.invalid';
process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';
['GOOGLE_PLACES_API_KEY', 'PLACES_PROVIDER', 'GROQ_API_KEY', 'OPENAI_API_KEY', 'TAVILY_API_KEY',
 'FOURSQUARE_API_KEY'].forEach(function(key) { delete process.env[key]; });

delete require.cache[appPath];
const { app, demoStore, getMerchantCampaigns } = require('../app');

const redis = created[0];
let server;
let base;

test.before(async function() {
  assert.ok(redis instanceof FakeUpstashRedis, 'the app must have built the Upstash client');
  server = await new Promise(function(resolve) {
    const instance = app.listen(0, '127.0.0.1', function() { resolve(instance); });
  });
  base = 'http://127.0.0.1:' + server.address().port;
});
test.after(function() {
  server.close();
  if (originalUpstashModule) require.cache[upstashPath] = originalUpstashModule;
  else delete require.cache[upstashPath];
  Object.keys(savedEnv).forEach(function(key) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  });
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
      return { status: response.status, location: response.headers.get('location'), html: html };
    },
    get sessionId() {
      return decodeURIComponent(cookie.split('=')[1]).slice(2).split('.')[0];
    },
    async stored() {
      const raw = await redis.get('sess:' + this.sessionId);
      return raw ? JSON.parse(raw) : null;
    }
  };
}

function campaign(id) {
  return getMerchantCampaigns().find(function(item) { return item.merchantId === id; });
}

async function pay(v, merchantId, amount) {
  await v.request('/scan');
  await v.request('/scan', { merchantId: merchantId });
  const journey = (await v.stored()).demo.currentScanPayment;
  await v.request('/scan/payment', { journeyId: journey.id, amount: amount });
  return (await v.stored()).demo.transactions[0];
}

// ---------------------------------------------------------------------------
// The configured store really is the Redis one
// ---------------------------------------------------------------------------

test('the configured session store is the Upstash store, which has no all()', function() {
  assert.equal(typeof demoStore.get, 'function');
  assert.equal(typeof demoStore.set, 'function');
  assert.equal(typeof demoStore.destroy, 'function');
  assert.equal(typeof demoStore.all, 'undefined',
    'this test is only meaningful while the Upstash store cannot enumerate sessions');
});

test('sessions are persisted through the Upstash client, not an in-process map', async function() {
  const v = visitor();
  await v.request('/home');
  const keys = redis.sessionKeys();
  assert.ok(keys.length >= 1, 'a session must have been written to Redis');
  assert.ok(keys.includes('sess:' + v.sessionId));
  const stored = await v.stored();
  assert.ok(stored && stored.demo, 'the stored session must carry demo state');
  assert.equal(stored.demo.user.id, 'jia');
  assert.ok(redis.calls.some(function(c) { return c[0] === 'setex'; }), 'the store must use SETEX');
});

// ---------------------------------------------------------------------------
// Reset works, and reports honestly
// ---------------------------------------------------------------------------

test('Reset Demo succeeds on the Redis store instead of failing on the missing all()', async function() {
  const v = visitor();
  await v.request('/home');
  const reset = await v.request('/reset-demo', {});
  assert.equal(reset.status, 302, 'reset must not fail with a 500 on the configured store');
  assert.equal(reset.location, '/home?reset=done');
});

test('Reset Demo clears the requesting session payment, credit and Vouch state', async function() {
  const v = visitor();
  await v.request('/home');
  campaign('felicia-chicken-rice').rewardAmount = 0.50;
  campaign('felicia-chicken-rice').minimumEligibleSpend = 5.00;
  const tx = await pay(v, 'felicia-chicken-rice', '6.00');
  await v.request('/vouch/' + tx.id, { action: 'create' });

  let stored = await v.stored();
  assert.equal(stored.demo.transactions.length, 1);
  assert.equal(stored.demo.vouchCredits['felicia-chicken-rice'], 0.50);
  assert.equal(stored.demo.paymentVerifiedVouches.length, 1);

  assert.equal((await v.request('/reset-demo', {})).location, '/home?reset=done');
  stored = await v.stored();
  assert.deepEqual(stored.demo.transactions, []);
  assert.deepEqual(stored.demo.vouchCredits, {});
  assert.deepEqual(stored.demo.paymentVerifiedVouches, []);
  assert.equal(stored.demo.currentScanPayment, null);
  assert.equal(stored.demo.activeVouchClaim, null);
});

test('a second session is reset on its next request, even though Redis cannot be enumerated', async function() {
  const first = visitor();
  const second = visitor();
  await first.request('/home');
  await second.request('/demo/identity', { userId: 'darren' });
  campaign('green-bowl').rewardAmount = 0.50;
  campaign('green-bowl').minimumEligibleSpend = 5.00;

  await pay(first, 'green-bowl', '6.00');
  await pay(second, 'green-bowl', '6.00');
  assert.equal((await first.stored()).demo.transactions.length, 1);
  assert.equal((await second.stored()).demo.transactions.length, 1);
  assert.notEqual(first.sessionId, second.sessionId, 'two distinct sessions are required');

  // Reset from the first session only.
  assert.equal((await first.request('/reset-demo', {})).location, '/home?reset=done');
  assert.deepEqual((await first.stored()).demo.transactions, []);

  // The second session's stored state is reset the moment it is next used.
  const page = await second.request('/profile/activity');
  assert.equal(page.status, 200);
  assert.match(page.html, /No NETS activity yet/);
  const secondStored = await second.stored();
  assert.deepEqual(secondStored.demo.transactions, [], 'the other session must not keep pre-reset payments');
  assert.deepEqual(secondStored.demo.vouchCredits, {});
  assert.equal(secondStored.demo.user.id, 'jia', 'reset returns every session to the default persona');
});

test('a stale in-flight save cannot restore pre-reset state', async function() {
  const v = visitor();
  await v.request('/home');
  campaign('felicia-chicken-rice').rewardAmount = 0.50;
  campaign('felicia-chicken-rice').minimumEligibleSpend = 5.00;
  await pay(v, 'felicia-chicken-rice', '6.00');
  const preReset = await v.stored();
  assert.equal(preReset.demo.transactions.length, 1);

  await v.request('/reset-demo', {});
  assert.deepEqual((await v.stored()).demo.transactions, []);

  // Simulate a request that started before the reset and only now writes back: it carries the
  // pre-reset demo state and the superseded reset generation.
  await new Promise(function(resolve, reject) {
    demoStore.set(v.sessionId, preReset, function(error) { if (error) reject(error); else resolve(); });
  });
  // The stale write really is in the store...
  assert.equal((await v.stored()).demo.transactions.length, 1);
  // ...but it is superseded on the next read rather than coming back to life.
  const page = await v.request('/profile/activity');
  assert.match(page.html, /No NETS activity yet/);
  assert.deepEqual((await v.stored()).demo.transactions, [],
    'a stale save must not restore pre-reset state');
});

test('repeated resets are idempotent and stay clean', async function() {
  const v = visitor();
  await v.request('/home');
  campaign('felicia-chicken-rice').rewardAmount = 0.50;
  campaign('felicia-chicken-rice').minimumEligibleSpend = 5.00;
  await pay(v, 'felicia-chicken-rice', '6.00');
  for (let i = 0; i < 3; i++) {
    const reset = await v.request('/reset-demo', {});
    assert.equal(reset.location, '/home?reset=done', 'reset ' + (i + 1) + ' must succeed');
    const stored = await v.stored();
    assert.deepEqual(stored.demo.transactions, []);
    assert.deepEqual(stored.demo.vouchCredits, {});
  }
  assert.equal(campaign('felicia-chicken-rice').metrics.payments, 0);
  assert.equal(campaign('felicia-chicken-rice').redemptionsToday, 0);
});

test('campaign configuration survives a Redis-backed reset while live counters clear', async function() {
  const v = visitor();
  await v.request('/home');
  const c = campaign('green-bowl');
  c.rewardAmount = 0.70;
  c.minimumEligibleSpend = 4;
  c.maxRewardedPaymentsPerDay = 7;
  c.maxRewardBudgetPerDay = 9;
  c.status = 'INACTIVE';
  c.startTime = '01:00';
  c.endTime = '22:00';

  campaign('felicia-chicken-rice').rewardAmount = 0.50;
  campaign('felicia-chicken-rice').minimumEligibleSpend = 5.00;
  await pay(v, 'felicia-chicken-rice', '6.00');
  const felicia = campaign('felicia-chicken-rice');
  assert.equal(felicia.metrics.payments, 1);

  await v.request('/reset-demo', {});
  assert.deepEqual([c.rewardAmount, c.minimumEligibleSpend, c.maxRewardedPaymentsPerDay,
    c.maxRewardBudgetPerDay, c.status, c.startTime, c.endTime],
    [0.70, 4, 7, 9, 'INACTIVE', '01:00', '22:00'], 'merchant configuration must survive reset');
  assert.equal(felicia.metrics.payments, 0, 'live counters must clear');
  assert.equal(felicia.platformFeeAccrued, 0);
});

test('a Redis write failure during reset is reported, not reported as success', async function() {
  const v = visitor();
  await v.request('/home');
  redis.failNextSet = true;
  const reset = await v.request('/reset-demo', {});
  // The failure must surface: either the store rejects the save (500) or the session could not be
  // written at all. What must never happen is a cheerful "reset=done" over a failed write.
  if (reset.status === 302) {
    assert.notEqual(reset.location, '/home?reset=done',
      'a failed store write must not be reported as a completed reset');
  } else {
    assert.equal(reset.status, 500);
    assert.match(reset.html, /could not be completed/);
  }
  redis.failNextSet = false;
});
