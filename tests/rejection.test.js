const { database: db } = require('./helpers/test-isolation.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const { start } = require('./helpers/visitor.cjs');
let http;
test.before(async () => { http = await start(); });
test.after(() => http.close());

for (const ajax of [false, true]) for (const reason of ['too-expensive', 'too-far', 'ate-recently', 'not-in-mood']) {
  test(`${ajax ? 'AJAX' : 'form'} rejection ${reason}: one response, at most one intended weight update`, async () => {
    db.seedUser('jia');
    const v = http.visitor();
    const batch = JSON.parse((await v.request('/api/recommend')).html).recommendations;
    assert.equal(batch.length, 3);
    // Every card in the batch can be rejected, including a non-selected card.
    const merchantId = batch[ajax ? 2 : 1].id;
    await v.change(demo => { demo.matchBackups = [{ merchantId: batch[0].id }]; });
    const response = await v.request('/recommendation/reject', { merchantId, reason }, ajax ? { 'X-Requested-With': 'smart-match' } : {});
    assert.equal(response.status, ajax ? 204 : 302);
    if (!ajax) assert.equal(response.location, '/home?matching=again');
    const updates = db.calls.filter(call => call.sql.startsWith('UPDATE users'));
    assert.equal(updates.length, ['too-expensive', 'too-far'].includes(reason) ? 1 : 0);
    if (updates.length) {
      assert.match(updates[0].sql, reason === 'too-far' ? /weight_distance_sensitivity/ : /weight_price_sensitivity/);
      assert.deepEqual(updates[0].params, ['jia']);
    }
    assert.equal(db.users.get('jia').weight_price_sensitivity, reason === 'too-expensive' ? 1.2 : 1);
    assert.equal(db.users.get('jia').weight_distance_sensitivity, reason === 'too-far' ? 1.2 : 1);
    const demo = (await v.state()).demo;
    assert.equal(demo.selectedMerchantId, null);
    assert.deepEqual(demo.matchContinuation, { rejectedId: merchantId, attempted: false });
    assert.equal(demo.recommendationFeedback.filter(f => f.merchantId === merchantId).length, 1);
  });
}

test('first recommendation card can also be rejected', async () => {
  const v = http.visitor(); const batch = JSON.parse((await v.request('/api/recommend')).html).recommendations;
  assert.equal((await v.request('/recommendation/reject', { merchantId: batch[0].id, reason: 'ate-recently' })).status, 302);
  assert.equal(db.calls.filter(c => c.sql.startsWith('UPDATE')).length, 0);
});

for (const ajax of [false, true]) test(`${ajax ? 'AJAX' : 'form'} invalid rejection produces no update`, async () => {
  const v = http.visitor(); const batch = JSON.parse((await v.request('/api/recommend')).html).recommendations;
  for (const body of [{ merchantId: 'unshown', reason: 'too-far' }, { merchantId: batch[0].id, reason: 'invalid' }]) {
    const result = await v.request('/recommendation/reject', body, ajax ? { 'X-Requested-With': 'smart-match' } : {});
    assert.equal(result.status, ajax ? 409 : 302);
    if (!ajax) assert.equal(result.location, '/home');
  }
  assert.equal(db.calls.filter(c => c.sql.startsWith('UPDATE')).length, 0);
});
