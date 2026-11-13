const isolation = require('./helpers/test-isolation.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');

test('private environment loading and direct reads are blocked before any app import', async () => {
  assert.equal(require.cache[require.resolve('../app')], undefined);
  assert.equal(process.env.NODE_ENV, 'test');
  assert.equal(process.env.MYSQL_PASSWORD, undefined);
  assert.equal(process.env.GROQ_API_KEY, undefined);
  assert.throws(() => process.loadEnvFile('.env'), { code: 'ERR_TEST_ISOLATION' });
  assert.throws(() => fs.readFileSync(path.join(__dirname, '../.env')), { code: 'ERR_TEST_ISOLATION' });
  await assert.rejects(fs.promises.readFile(path.join(__dirname, '../.env')), { code: 'ERR_TEST_ISOLATION' });
  assert.equal(isolation.takeViolations().length, 3);
});

test('real database/Redis factories and existing local service ports are blocked', () => {
  for (const name of ['mysql2', 'mysql2/promise']) {
    for (const method of ['createPool', 'createConnection', 'createPoolCluster']) {
      assert.throws(() => require(name)[method]({}), { code: 'ERR_TEST_ISOLATION' });
    }
  }
  assert.throws(() => new (require('@upstash/redis').Redis)({}), { code: 'ERR_TEST_ISOLATION' });
  for (const port of [3306, 6379]) assert.throws(() => net.connect({ host: '127.0.0.1', port }), { code: 'ERR_TEST_ISOLATION' });
  assert.equal(isolation.takeViolations().length, 9);
});

test('real provider HTTP/TLS is blocked, including a mock falling through to native fetch', async () => {
  const original = global.fetch;
  global.fetch = (url, init) => url === 'https://mock.invalid/fixture'
    ? Promise.resolve({ ok: true }) : original(url, init);
  try {
    assert.equal((await fetch('https://mock.invalid/fixture')).ok, true);
    await assert.rejects(fetch('https://provider.invalid/'));
    await assert.rejects(fetch('http://provider.invalid/'));
    assert.equal(isolation.takeViolations().length, 2);
  } finally { global.fetch = original; }
});

test('only a test-owned loopback HTTP listener accepts real fetch traffic', async () => {
  const server = http.createServer((req, res) => res.end('fixture'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await fetch('http://127.0.0.1:' + server.address().port);
    assert.equal(await result.text(), 'fixture');
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('fixture errors are recorded even when a caller catches them', async () => {
  await assert.rejects(isolation.database.execute('DELETE FROM users'), { code: 'ERR_TEST_ISOLATION' });
  assert.deepEqual(isolation.takeViolations(), ['unrecognized fixture SQL']);
});

test('swallowed socket and SQL violations fail a subprocess test run', () => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT; // The subprocess owns its own test runner/protocol.
  const result = require('node:child_process').spawnSync(process.execPath,
    ['--test', '--test-reporter=tap', path.join(__dirname, 'fixtures/isolation-violation.cjs')], { encoding: 'utf8', env });
  assert.equal(result.status, 1);
  assert.match(result.stdout + result.stderr, /unexpected service\/private-file access or fixture SQL/);
  assert.match(result.stdout + result.stderr, /fail 2/);
});

test('every test entrypoint installs isolation before any application dependencies', () => {
  for (const file of fs.readdirSync(__dirname).filter(name => name.endsWith('.test.js'))) {
    assert.match(fs.readFileSync(path.join(__dirname, file), 'utf8').split(/\r?\n/)[0],
      /require\('\.\/helpers\/test-isolation\.cjs'\)/, file);
  }
});

test('app and agent import use the same fixture and do not load private settings or construct services', () => {
  const before = { ...isolation.counters };
  const { app, demoStore } = require('../app');
  assert.equal(typeof app, 'function');
  assert.equal(demoStore.constructor.name, 'MemoryStore');
  assert.equal(require('../Database/db'), isolation.database);
  assert.equal(typeof require('../nets_agent').getAgentRecommendations, 'function');
  assert.deepEqual(isolation.counters, before);
});
