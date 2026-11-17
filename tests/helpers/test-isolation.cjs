'use strict';

// Install before app imports, including when a single test file is run directly.
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const net = require('node:net');
const http = require('node:http');
const task3 = require('../../sample-data/nets-vouch-task3.cjs');

process.env.NODE_ENV = 'test';
for (const key of Object.keys(process.env)) {
  if (/^(MYSQL_|DB_|REDIS_|UPSTASH_)/.test(key) || /(?:_API_KEY|_API_TOKEN|_SECRET)$/.test(key)) delete process.env[key];
}
process.env.SESSION_SECRET = 'isolated-test-session-only';

const violations = [];
const counters = { envLoads: 0, privateReads: 0, mysqlFactories: 0, redisFactories: 0, blockedConnections: 0 };
function deny(kind) {
  violations.push(kind);
  const error = new Error('Test isolation blocked: ' + kind);
  error.code = 'ERR_TEST_ISOLATION';
  throw error;
}
process.loadEnvFile = function() { counters.envLoads++; deny('environment file loading'); };
function privateFile(file) {
  if (file instanceof URL) file = file.pathname;
  return (typeof file === 'string' || Buffer.isBuffer(file)) && /^\.env(?:\.|$)/i.test(path.basename(String(file)));
}
for (const method of ['readFileSync', 'readFile']) {
  const original = fs[method];
  fs[method] = function(file, ...args) {
    if (privateFile(file)) { counters.privateReads++; deny('private environment read'); }
    return original.call(this, file, ...args);
  };
}
const readFile = fs.promises.readFile;
fs.promises.readFile = async function(file, ...args) {
  if (privateFile(file)) { counters.privateReads++; deny('private environment read'); }
  return readFile.call(this, file, ...args);
};

// Only HTTP listeners created inside this process are eligible for real traffic.
// This also blocks accidental connections to an existing local MySQL/Redis service.
const ports = new Set();
const listen = http.Server.prototype.listen;
http.Server.prototype.listen = function(...args) {
  this.once('listening', () => {
    const address = this.address();
    if (address && typeof address === 'object') {
      ports.add(address.port);
      this.once('close', () => ports.delete(address.port));
    }
  });
  return listen.apply(this, args);
};
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function(...args) {
  const normalized = Array.isArray(args[0]) ? args[0] : args;
  const options = typeof normalized[0] === 'object' ? normalized[0] : { port: normalized[0], host: normalized[1] };
  if (!options || options.path || !['127.0.0.1', '::1'].includes(options.host) || !ports.has(Number(options.port))) {
    counters.blockedConnections++;
    deny('non-test socket connection');
  }
  return connect.apply(this, args);
};

for (const name of ['mysql2', 'mysql2/promise']) {
  const mysql = require(name);
  for (const method of ['createPool', 'createConnection', 'createPoolCluster']) {
    mysql[method] = function() { counters.mysqlFactories++; deny('real MySQL factory'); };
  }
}
const redisPath = require.resolve('@upstash/redis');
const redis = require(redisPath);
require.cache[redisPath].exports = { ...redis, Redis: class ForbiddenRedis {
  constructor() { counters.redisFactories++; deny('real Redis factory'); }
} };

const defaults = () => ({ budget_max: 10, max_walk_minutes: 15, dietary_preference: 'none',
  weight_price_sensitivity: 1, weight_distance_sensitivity: 1, weight_quietness_affinity: 1,
  max_distance_minutes: 10, mood_cuisine: 'any', craving: '', notifications: 1, has_set_preferences: 0 });
const database = {
  users: new Map(), merchants: new Map(), calls: [], failing: false, catalogueFailing: false,
  activityFailing: false, sampleActivityRows: task3.activityRows(),
  reset() { this.users.clear(); this.merchants.clear(); this.calls.length = 0; this.failing = false;
    this.catalogueFailing = false; this.activityFailing = false; this.sampleActivityRows = task3.activityRows(); },
  seedMerchant(row) { this.merchants.set(row.merchant_id, { ...row }); },
  seedUser(id, values = {}) { this.users.set(id, { ...defaults(), user_id: id, display_name: id, ...values }); },
  async execute(sql, params = []) {
    const text = sql.replace(/\s+/g, ' ').trim();
    this.calls.push({ sql: text, params: [...params] });
    if (this.failing) throw new Error('simulated database outage');
    if (text === 'SELECT merchant_id, name, location_label, distance_metres, cuisine_type, typical_price, dietary_halal, dietary_vegetarian, dietary_vegan, reward_amount, min_spend, is_sample_data FROM merchants ORDER BY merchant_id') {
      if (this.catalogueFailing) throw new Error('simulated catalogue outage');
      assert.deepEqual(params, []);
      return [[...this.merchants.values()].filter(row => !Array.isArray(row))
        .sort((a, b) => a.merchant_id < b.merchant_id ? -1 : a.merchant_id > b.merchant_id ? 1 : 0)
        .map(row => ({ ...row })), []];
    }
    if (text === 'SELECT merchant_id, name, location_label, distance_metres, cuisine_type, typical_price, dietary_halal, dietary_vegetarian, dietary_vegan, reward_amount, min_spend, is_sample_data FROM merchants WHERE merchant_id = ?') {
      if (this.catalogueFailing) throw new Error('simulated catalogue outage');
      assert.equal(params.length, 1);
      assert.equal(typeof params[0], 'string');
      const row = this.merchants.get(params[0]);
      return [row && !Array.isArray(row) ? [{ ...row }] : [], []];
    }
    if (/^SELECT m\.merchant_id, d\.dataset_key, d\.sample_label, d\.timezone_name,/.test(text) &&
        /FROM merchants m JOIN sample_datasets d/.test(text)) {
      if (this.activityFailing) throw new Error('simulated private activity database detail');
      const isoDay = params[0]; const slotStart = params[1]; const ids = params.slice(2);
      assert.ok(Number.isInteger(isoDay) && isoDay >= 1 && isoDay <= 7);
      assert.match(slotStart, /^\d{2}:00:00$/);
      assert.equal((text.match(/\?/g) || []).length, params.length);
      const selected = new Set(ids);
      return [this.sampleActivityRows.filter(row => selected.has(row.merchantId) &&
        (row.observationStatus === 'OBSERVED' ||
          (task3.isoWeekday(row.observationDate) === isoDay && row.slotStart === slotStart)))
        .map(row => ({
          merchant_id: row.merchantId,
          dataset_key: task3.DATASET.key,
          sample_label: task3.DATASET.label,
          timezone_name: task3.DATASET.timezone,
          period_start: task3.DATASET.periodStart,
          period_end: task3.DATASET.periodEnd,
          slot_start_hour: task3.DATASET.slotStartHour,
          slot_end_hour: task3.DATASET.slotEndHour,
          slot_minutes: task3.DATASET.slotMinutes,
          disclosure: task3.DATASET.disclosure,
          observation_date: row.observationDate,
          iso_weekday: task3.isoWeekday(row.observationDate),
          slot_start: row.slotStart,
          observation_status: row.observationStatus,
          transaction_count: row.transactionCount
        })), []];
    }
    if (/^SELECT (budget_max, max_walk_minutes, dietary_preference|\*) FROM users WHERE user_id = \?$/.test(text)) {
      const row = this.users.get(params[0]);
      return [row ? [{ ...row }] : [], []];
    }
    if (text === 'INSERT INTO users (user_id, display_name, budget_max, max_walk_minutes, dietary_preference) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE display_name = VALUES(display_name), budget_max = VALUES(budget_max), max_walk_minutes = VALUES(max_walk_minutes), dietary_preference = VALUES(dietary_preference)') {
      const [id, display_name, budget_max, max_walk_minutes, dietary_preference] = params;
      if (!this.users.has(id)) this.seedUser(id);
      Object.assign(this.users.get(id), { display_name, budget_max, max_walk_minutes, dietary_preference });
      return [{ affectedRows: 1 }, []];
    }
    const weight = text.match(/^UPDATE users SET (weight_price_sensitivity|weight_distance_sensitivity) = \1 \+ 0\.2 WHERE user_id = \?$/);
    if (weight) {
      const row = this.users.get(params[0]);
      if (row) row[weight[1]] = Number(row[weight[1]]) + 0.2;
      return [{ affectedRows: row ? 1 : 0 }, []];
    }
    if (text === "UPDATE users SET budget_max = 10.00, max_walk_minutes = 15, dietary_preference = 'none', weight_price_sensitivity = 1.00, weight_distance_sensitivity = 1.00, weight_quietness_affinity = 1.00") {
      for (const row of this.users.values()) Object.assign(row, { budget_max: 10, max_walk_minutes: 15,
        dietary_preference: 'none', weight_price_sensitivity: 1, weight_distance_sensitivity: 1, weight_quietness_affinity: 1 });
      return [{ affectedRows: this.users.size }, []];
    }
    if (text === 'INSERT IGNORE INTO merchants (merchant_id, name, location_label, distance_metres, cuisine_type, typical_price, dietary_halal, dietary_vegetarian, dietary_vegan, reward_amount, min_spend, is_sample_data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, FALSE)') {
      if (!this.merchants.has(params[0])) this.merchants.set(params[0], [...params]);
      return [{ affectedRows: 1 }, []];
    }
    deny('unrecognized fixture SQL');
  },
  query(sql, params) { return this.execute(sql, params); }
};
const dbPath = require.resolve('../../Database/db');
assert.equal(require.cache[dbPath], undefined, 'isolation must precede the database module');
assert.equal(require.cache[require.resolve('../../app')], undefined, 'isolation must precede the app');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: database };

// The --test coordinator does not execute tests. Register hooks in workers and
// direct single-file runs only, avoiding a second empty test-harness summary.
if (!(process.execArgv.includes('--test') && !process.env.NODE_TEST_CONTEXT)) {
  const test = require('node:test');
  test.beforeEach(() => database.reset());
  test.afterEach(() => {
    const unexpected = violations.splice(0);
    assert.deepEqual(unexpected, [], 'unexpected service/private-file access or fixture SQL, even if caught by the app');
  });
  test.after(() => assert.deepEqual(violations, [], 'unacknowledged isolation violation'));
}

module.exports = { database, counters, takeViolations: () => violations.splice(0) };
