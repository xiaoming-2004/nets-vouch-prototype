require('../helpers/test-isolation.cjs');
const test = require('node:test');
const net = require('node:net');
const { database } = require('../helpers/test-isolation.cjs');

// Deliberately failing subprocess fixture; excluded from tests/*.test.js.
test('caught forbidden connection still fails the test', () => {
  try { net.connect({ host: '127.0.0.1', port: 3306 }); } catch (error) { /* mimic swallowed app errors */ }
});
test('caught unknown SQL still fails the test', async () => {
  await database.execute('DELETE FROM users').catch(() => {});
});
