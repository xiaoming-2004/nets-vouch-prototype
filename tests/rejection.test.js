const { database: db } = require('./helpers/test-isolation.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const { start } = require('./helpers/visitor.cjs');
const { seedCatalogue } = require('./helpers/catalogue-fixtures.cjs');
test.beforeEach(() => seedCatalogue(db));
let http;
test.before(async () => { http = await start(); });
test.after(() => http.close());

for (const ajax of [false, true]) for (const reason of ['too-expensive', 'too-far', 'ate-recently', 'not-in-mood']) {
  test(`${ajax ? 'AJAX' : 'form'} rejection ${reason}: one durable row and no weight update`, async () => {
    db.seedUser('jia');
    const v = http.visitor();
    const batch = JSON.parse((await v.request('/api/recommend')).html).recommendations;
    assert.equal(batch.length, 3);
    // Every card in the batch can be rejected, including a non-selected card.
    const card = batch[ajax ? 2 : 1];
    const merchantId = card.id;
    await v.change(demo => { demo.matchBackups = [{ merchantId: batch[0].id }]; });
    const response = await v.request('/recommendation/reject', {
      merchantId, feedbackToken: card.feedbackToken, reason
    }, ajax ? { 'X-Requested-With': 'smart-match' } : {});
    assert.equal(response.status, ajax ? 204 : 302);
    if (!ajax) assert.equal(response.location, '/home?matching=again');
    assert.equal(db.calls.filter(call => call.sql.startsWith('UPDATE users')).length, 0);
    assert.equal(db.feedbackRows.length, 1);
    assert.deepEqual([db.feedbackRows[0].user_id, db.feedbackRows[0].merchant_id, db.feedbackRows[0].reason],
      ['jia', merchantId, reason]);
    assert.equal(db.users.get('jia').weight_price_sensitivity, 1);
    assert.equal(db.users.get('jia').weight_distance_sensitivity, 1);
    const demo = (await v.state()).demo;
    assert.equal(demo.selectedMerchantId, null);
    assert.equal(demo.recommendationFeedback.length, 0);
  });
}

test('first recommendation card can also be rejected', async () => {
  const v = http.visitor(); const batch = JSON.parse((await v.request('/api/recommend')).html).recommendations;
  assert.equal((await v.request('/recommendation/reject', {
    merchantId: batch[0].id, feedbackToken: batch[0].feedbackToken, reason: 'ate-recently'
  })).status, 302);
  assert.equal(db.calls.filter(c => c.sql.startsWith('UPDATE')).length, 0);
});

for (const ajax of [false, true]) test(`${ajax ? 'AJAX' : 'form'} invalid rejection produces no write`, async () => {
  const v = http.visitor(); const batch = JSON.parse((await v.request('/api/recommend')).html).recommendations;
  for (const body of [
    { merchantId: 'unshown', feedbackToken: batch[0].feedbackToken, reason: 'too-far' },
    { merchantId: batch[0].id, feedbackToken: batch[0].feedbackToken, reason: 'invalid' }
  ]) {
    const result = await v.request('/recommendation/reject', body, ajax ? { 'X-Requested-With': 'smart-match' } : {});
    assert.equal(result.status, body.merchantId === 'unshown' ? 409 : 400);
  }
  assert.equal(db.feedbackRows.length, 0);
});
