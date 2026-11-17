'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  TIMEZONE,
  MIN_TARGET_OBSERVATIONS,
  MIN_BASELINE_OBSERVATIONS,
  RELATIVE_THRESHOLD,
  calculateUsualActivity,
  loadUsualActivity
} = require('../merchant-activity');
const { DATASET, activityRows, isoWeekday } = require('../sample-data/nets-vouch-task3.cjs');

function metadata(merchantId, values = {}) {
  return {
    merchant_id: merchantId,
    dataset_key: DATASET.key,
    sample_label: DATASET.label,
    timezone_name: DATASET.timezone,
    period_start: DATASET.periodStart,
    period_end: DATASET.periodEnd,
    slot_start_hour: DATASET.slotStartHour,
    slot_end_hour: DATASET.slotEndHour,
    slot_minutes: DATASET.slotMinutes,
    disclosure: DATASET.disclosure,
    ...values
  };
}

function storedRows(ids, isoDay, slotStart) {
  const selected = new Set(ids);
  return activityRows().filter(row => selected.has(row.merchantId) &&
    (row.observationStatus === 'OBSERVED' ||
      (isoWeekday(row.observationDate) === isoDay && row.slotStart === slotStart)))
    .map(row => metadata(row.merchantId, {
      observation_date: row.observationDate,
      iso_weekday: isoWeekday(row.observationDate),
      slot_start: row.slotStart,
      observation_status: row.observationStatus,
      transaction_count: row.transactionCount
    }));
}

function fakeDatabase(rows, error) {
  return {
    calls: [],
    async execute(sql, params) {
      this.calls.push({ sql, params });
      if (error) throw error;
      return [rows, []];
    }
  };
}

const mondayDates = ['2026-10-19', '2026-10-26', '2026-11-02', '2026-11-09'];

function syntheticRows({
  merchantId = 'synthetic',
  targetCounts = [10, 10, 10, 10],
  targetStatuses = ['OBSERVED', 'OBSERVED', 'OBSERVED', 'OBSERVED'],
  otherCounts = Array(24).fill(10),
  metadataValues = {}
} = {}) {
  const rows = targetStatuses.map((status, index) => metadata(merchantId, {
    ...metadataValues,
    observation_date: mondayDates[index],
    iso_weekday: 1,
    slot_start: '14:00:00',
    observation_status: status,
    transaction_count: status === 'OBSERVED' ? targetCounts[index] : null
  }));
  otherCounts.forEach((count, index) => rows.push(metadata(merchantId, {
    ...metadataValues,
    observation_date: `2026-10-${String(20 + (index % 8)).padStart(2, '0')}`,
    iso_weekday: 2 + (index % 6),
    slot_start: String(7 + (index % 15)).padStart(2, '0') + ':00:00',
    observation_status: 'OBSERVED',
    transaction_count: count
  })));
  return rows;
}

test('Felicia Monday 14:00 matches the hand-calculated merchant-relative result', async () => {
  const rows = storedRows(['felicia-chicken-rice'], 1, '14:00:00');
  const db = fakeDatabase(rows);
  const [result] = await loadUsualActivity(db, ['felicia-chicken-rice'], { isoWeekday: 1, time: '14:37' });
  assert.equal(result.status, 'available');
  assert.equal(result.comparison, 'quieter');
  assert.equal(result.averageTransactions, 5);
  assert.equal(result.baselineAverageTransactions, 6.35);
  assert.equal(result.relativeDifferencePercent, -21.3);
  assert.equal(result.sampleCount, 4);
  assert.equal(result.baselineSampleCount, 176);
  assert.deepEqual(result.historicalPeriod, { start: '2026-10-19', end: '2026-11-15' });
  assert.equal(result.sampleDataLabel, DATASET.label);
  assert.equal(result.basis, 'fictional-sample-history');
});

test('one missing week is excluded while three observations remain sufficient', async () => {
  const rows = storedRows(['felicia-chicken-rice'], 1, '12:00:00');
  const [result] = await loadUsualActivity(fakeDatabase(rows), ['felicia-chicken-rice'], { isoWeekday: 1, time: '12:15' });
  assert.equal(result.status, 'available');
  assert.equal(result.comparison, 'busier');
  assert.equal(result.averageTransactions, 15.33);
  assert.equal(result.sampleCount, MIN_TARGET_OBSERVATIONS);
  assert.equal(result.missingCount, 1);
});

test('exact -20% and +20% boundaries classify without overlap', () => {
  const quieterRows = syntheticRows({ targetCounts: [8, 8, 8, 8], otherCounts: [...Array(23).fill(10), 18] });
  const busierRows = syntheticRows({ merchantId: 'busier', targetCounts: [12, 12, 12, 12], otherCounts: [...Array(23).fill(10), 2] });
  const [quieter] = calculateUsualActivity(['synthetic'], { isoWeekday: 1, time: '14:00' }, quieterRows);
  const [busier] = calculateUsualActivity(['busier'], { isoWeekday: 1, time: '14:00' }, busierRows);
  assert.equal(RELATIVE_THRESHOLD, 0.20);
  assert.equal(quieter.relativeDifferencePercent, -20);
  assert.equal(quieter.comparison, 'quieter');
  assert.equal(busier.relativeDifferencePercent, 20);
  assert.equal(busier.comparison, 'busier');
  assert.notEqual(quieter.comparison, 'typical');
  assert.notEqual(busier.comparison, 'typical');
});

test('observed zeroes count as samples while missing values do not enter averages', () => {
  const rows = syntheticRows({
    targetCounts: [0, 0, 0, null],
    targetStatuses: ['OBSERVED', 'OBSERVED', 'OBSERVED', 'MISSING'],
    otherCounts: Array(25).fill(10)
  });
  const [result] = calculateUsualActivity(['synthetic'], { isoWeekday: 1, time: '14:00' }, rows);
  assert.equal(result.status, 'available');
  assert.equal(result.averageTransactions, 0);
  assert.equal(result.sampleCount, 3);
  assert.equal(result.missingCount, 1);
  assert.equal(result.baselineSampleCount, 28);
  assert.equal(result.comparison, 'quieter');
});

test('target and baseline minimums return stable insufficient-data reasons', () => {
  const tooFewTarget = syntheticRows({
    targetCounts: [4, 5, null, null],
    targetStatuses: ['OBSERVED', 'OBSERVED', 'MISSING', 'MISSING'],
    otherCounts: Array(26).fill(10)
  });
  const tooFewBaseline = syntheticRows({
    targetCounts: [4, 5, 6, null],
    targetStatuses: ['OBSERVED', 'OBSERVED', 'OBSERVED', 'MISSING'],
    otherCounts: Array(24).fill(10)
  });
  const [target] = calculateUsualActivity(['synthetic'], { isoWeekday: 1, time: '14:00' }, tooFewTarget);
  const [baseline] = calculateUsualActivity(['synthetic'], { isoWeekday: 1, time: '14:00' }, tooFewBaseline);
  assert.equal(MIN_BASELINE_OBSERVATIONS, 28);
  assert.deepEqual([target.status, target.reason, target.sampleCount], ['insufficient-data', 'target-sample-too-small', 2]);
  assert.deepEqual([baseline.status, baseline.reason, baseline.baselineSampleCount], ['insufficient-data', 'baseline-sample-too-small', 27]);
  assert.equal(target.averageTransactions, null);
  assert.equal(baseline.comparison, null);
});

test('complete closed history is closed; mixed or incomplete history is unavailable', () => {
  const closedRows = syntheticRows({ targetStatuses: Array(4).fill('CLOSED'), targetCounts: Array(4).fill(null), otherCounts: Array(28).fill(7) });
  const mixedRows = syntheticRows({ merchantId: 'mixed', targetStatuses: ['CLOSED', 'OBSERVED', 'OBSERVED', 'OBSERVED'], targetCounts: [null, 5, 5, 5], otherCounts: Array(28).fill(7) });
  const incompleteRows = syntheticRows({ merchantId: 'incomplete', targetStatuses: ['OBSERVED', 'OBSERVED', 'OBSERVED'], targetCounts: [5, 5, 5], otherCounts: Array(28).fill(7) });
  const [closed] = calculateUsualActivity(['synthetic'], { isoWeekday: 1, time: '14:00' }, closedRows);
  const [mixed] = calculateUsualActivity(['mixed'], { isoWeekday: 1, time: '14:00' }, mixedRows);
  const [incomplete] = calculateUsualActivity(['incomplete'], { isoWeekday: 1, time: '14:00' }, incompleteRows);
  assert.deepEqual([closed.status, closed.reason], ['closed', 'scheduled-closed']);
  assert.deepEqual([mixed.status, mixed.reason], ['unavailable', 'inconsistent-target-history']);
  assert.deepEqual([incomplete.status, incomplete.reason], ['unavailable', 'incomplete-target-history']);
});

test('zero baseline is typical only when the target is also zero', () => {
  const rows = syntheticRows({ targetCounts: [0, 0, 0, 0], otherCounts: Array(24).fill(0) });
  const [result] = calculateUsualActivity(['synthetic'], { isoWeekday: 1, time: '14:00' }, rows);
  assert.equal(result.status, 'available');
  assert.equal(result.comparison, 'typical');
  assert.equal(result.relativeDifferencePercent, 0);
});

test('weekday and hourly slot selection use Singapore-local inputs', async () => {
  const mondayRows = storedRows(['green-bowl'], 1, '12:00:00');
  const saturdayRows = storedRows(['green-bowl'], 6, '12:00:00');
  const [monday] = await loadUsualActivity(fakeDatabase(mondayRows), ['green-bowl'], { isoWeekday: 1, time: '12:59' });
  const [saturday] = await loadUsualActivity(fakeDatabase(saturdayRows), ['green-bowl'], { isoWeekday: 6, time: '12:00' });
  assert.equal(monday.slotStart, '12:00:00');
  assert.equal(monday.timezone, TIMEZONE);
  assert.equal(monday.averageTransactions, 10);
  assert.equal(saturday.averageTransactions, 9);
});

test('multi-merchant loading issues exactly one parameterised read and preserves requested order', async () => {
  const ids = ['green-bowl', 'felicia-chicken-rice', 'woodlands-noodle-bar'];
  const db = fakeDatabase(storedRows(ids, 1, '14:00:00'));
  const results = await loadUsualActivity(db, ids, { isoWeekday: 1, time: '14:22' });
  assert.equal(db.calls.length, 1);
  assert.deepEqual(results.map(result => result.merchantId), ids);
  assert.deepEqual(db.calls[0].params, [1, '14:00:00', ...ids]);
  assert.match(db.calls[0].sql, /^SELECT\s/i);
  assert.equal((db.calls[0].sql.match(/\?/g) || []).length, 2 + ids.length);
  assert.doesNotMatch(db.calls[0].sql, /\b(?:INSERT|UPDATE|DELETE|REPLACE|ALTER|CREATE|DROP|TRUNCATE)\b/i);
});

test('unknown metadata, timezone mismatch and outside-range times are unavailable', async () => {
  const unknown = await loadUsualActivity(fakeDatabase([]), ['unknown'], { isoWeekday: 1, time: '14:00' });
  const wrongZoneRows = syntheticRows({ metadataValues: { timezone_name: 'UTC' } });
  const wrongZone = calculateUsualActivity(['synthetic'], { isoWeekday: 1, time: '14:00' }, wrongZoneRows);
  const outsideRows = storedRows(['green-bowl'], 1, '22:00:00');
  const outside = calculateUsualActivity(['green-bowl'], { isoWeekday: 1, time: '22:15' }, outsideRows);
  assert.equal(unknown[0].reason, 'merchant-sample-unavailable');
  assert.equal(wrongZone[0].reason, 'timezone-unavailable');
  assert.equal(outside[0].reason, 'outside-sample-hour-range');
  for (const result of [unknown[0], wrongZone[0], outside[0]]) {
    assert.equal(result.status, 'unavailable');
    assert.equal(result.basis, 'fictional-sample-history');
  }
});

test('database failures return unavailable results without error details', async () => {
  const secret = 'private database detail';
  const ids = ['green-bowl', 'felicia-chicken-rice'];
  const results = await loadUsualActivity(fakeDatabase([], new Error(secret)), ids, { isoWeekday: 1, time: '14:00' });
  assert.deepEqual(results.map(result => result.merchantId), ids);
  assert.ok(results.every(result => result.status === 'unavailable' && result.reason === 'database-unavailable'));
  assert.doesNotMatch(JSON.stringify(results), new RegExp(secret));
  assert.ok(results.every(result => /Fictional sample history/.test(result.sampleDataLabel)));
});

test('invalid inputs fail before a database read', async () => {
  const db = fakeDatabase([]);
  await assert.rejects(() => loadUsualActivity(db, [], { isoWeekday: 1, time: '14:00' }), /merchantIds/);
  await assert.rejects(() => loadUsualActivity(db, ['green-bowl'], { isoWeekday: 0, time: '14:00' }), /isoWeekday/);
  await assert.rejects(() => loadUsualActivity(db, ['green-bowl'], { isoWeekday: 1, time: '2 pm' }), /HH:mm/);
  assert.equal(db.calls.length, 0);
});

test('all result copy remains explicitly historical and non-live', async () => {
  const rows = storedRows(['green-bowl'], 1, '14:00:00');
  const [result] = await loadUsualActivity(fakeDatabase(rows), ['green-bowl'], { isoWeekday: 1, time: '14:00' });
  assert.match(result.sampleDataLabel, /Fictional/);
  assert.match(result.disclosure, /not live NETS traffic/i);
  assert.equal(result.basis, 'fictional-sample-history');
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'queue'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'waitingTime'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'seatingAvailability'), false);
});
