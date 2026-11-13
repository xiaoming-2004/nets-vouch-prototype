const { counters } = require('./helpers/test-isolation.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
// Characterize the current Redis bypass, not the intended deployment architecture.
process.env.UPSTASH_REDIS_REST_URL = 'https://fixture.invalid';
process.env.UPSTASH_REDIS_REST_TOKEN = 'synthetic-test-token';
const before = counters.redisFactories;
const { demoStore } = require('../app');
test('current behavior: Redis configuration still selects MemoryStore without a Redis client', () => {
  assert.equal(demoStore.constructor.name, 'MemoryStore');
  assert.equal(counters.redisFactories, before);
});
