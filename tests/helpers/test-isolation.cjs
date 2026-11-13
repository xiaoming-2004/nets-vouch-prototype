'use strict';

// Install before app imports, including when a single test file is run directly.
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const net = require('node:net');
const http = require('node:http');

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
  users: new Map(), merchants: new Map(), calls: [], failing: false,
  reset() { this.users.clear(); this.merchants.clear(); this.calls.length = 0; this.failing = false; },
  seedUser(id, values = {}) { this.users.set(id, { ...defaults(), user_id: id, display_name: id, ...values }); },
  async execute(sql, params = []) {
    const text = sql.replace(/\s+/g, ' ').trim();
    this.calls.push({ sql: text, params: [...params] });
    if (this.failing) throw new Error('simulated database outage');
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
