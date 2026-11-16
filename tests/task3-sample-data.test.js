'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  DATASET, merchants, dates, isoWeekday, isOpen, activityRows
} = require('../sample-data/nets-vouch-task3.cjs');
const { renderSeed } = require('../scripts/render-task3-sample-seed.cjs');
const {
  createStore, seedTask3, snapshot, coreFacts, openingRows
} = require('./helpers/task3-sample-fixtures.cjs');

const root = path.resolve(__dirname, '..');

function haversineMetres(a, b) {
  const radians = value => value * Math.PI / 180;
  const latitudeDifference = radians(b.latitude - a.latitude);
  const longitudeDifference = radians(b.longitude - a.longitude);
  const firstLatitude = radians(a.latitude);
  const secondLatitude = radians(b.latitude);
  const h = Math.sin(latitudeDifference / 2) ** 2 +
    Math.cos(firstLatitude) * Math.cos(secondLatitude) * Math.sin(longitudeDifference / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

test('definition contains ten unique stable fictional sample merchants with preserved reward terms', () => {
  assert.equal(merchants.length, 10);
  assert.equal(new Set(merchants.map(merchant => merchant.merchantId)).size, 10);
  assert.deepEqual(merchants.map(merchant => merchant.merchantId), [
    'felicia-chicken-rice', 'green-bowl', 'woodlands-noodle-bar', 'northside-wraps',
    'spice-lane', 'makcik-nasi-padang', 'tokyo-express-bento', 'ah-heng-fish-soup',
    'vegan-zen-kitchen', 'kopi-toast-corner'
  ]);
  assert.deepEqual(merchants.map(merchant => [merchant.rewardAmount, merchant.minSpend]), [
    ['0.80', '5.00'], ['1.00', '9.00'], ['0.80', '6.00'], ['0.50', '8.00'],
    ['0.70', '7.50'], ['0.60', '5.00'], ['1.00', '10.00'], ['0.50', '5.00'],
    ['1.20', '12.00'], ['0.50', '4.00']
  ]);
  assert.match(DATASET.label, /Fictional/);
  assert.match(DATASET.disclosure, /not live NETS traffic/);
  assert.match(DATASET.disclosure, /not.*verified dietary certification/);
  assert.equal(DATASET.dietaryClaimStatus, 'DEMO_UNVERIFIED');
  for (const merchant of merchants) {
    assert.ok(merchant.name.length > 0 && merchant.cuisineType.length > 0);
    assert.ok(Number(merchant.typicalPrice) > 0);
    for (const flag of [merchant.dietaryHalal, merchant.dietaryVegetarian, merchant.dietaryVegan]) {
      assert.equal(typeof flag, 'boolean');
    }
  }
});

test('coordinates and stored straight-line estimates are coherent with the documented demo origin', () => {
  const origin = { latitude: DATASET.originLatitude, longitude: DATASET.originLongitude };
  assert.equal(DATASET.originName, 'Republic Polytechnic demo origin');
  assert.equal(DATASET.distanceBasis, 'STRAIGHT_LINE_DEMO_ORIGIN_ESTIMATE_NOT_ROUTED');
  for (const merchant of merchants) {
    assert.ok(merchant.latitude >= -90 && merchant.latitude <= 90);
    assert.ok(merchant.longitude >= -180 && merchant.longitude <= 180);
    const calculated = haversineMetres(origin, merchant);
    assert.ok(Math.abs(calculated - merchant.distanceMetres) <= 2,
      `${merchant.merchantId}: ${calculated} m vs stored ${merchant.distanceMetres} m`);
  }
});

test('four complete Singapore weeks and fifteen hourly slots produce exactly 4,200 rows', () => {
  assert.equal(DATASET.timezone, 'Asia/Singapore');
  assert.equal(DATASET.periodStart, '2026-10-19');
  assert.equal(DATASET.periodEnd, '2026-11-15');
  assert.equal(dates().length, 28);
  assert.equal(isoWeekday(dates()[0]), 1);
  assert.equal(isoWeekday(dates()[27]), 7);
  const rows = activityRows();
  assert.equal(rows.length, 10 * 28 * 15);
  for (const merchant of merchants) {
    for (const date of dates()) {
      const subset = rows.filter(row => row.merchantId === merchant.merchantId && row.observationDate === date);
      assert.equal(subset.length, 15);
      assert.deepEqual(subset.map(row => row.slotStart),
        Array.from({ length: 15 }, (_, index) => String(index + 7).padStart(2, '0') + ':00:00'));
    }
  }
});

test('opening hours agree with CLOSED rows and zero, missing, and closed remain distinct', () => {
  const rows = activityRows();
  const counts = { OBSERVED: 0, MISSING: 0, CLOSED: 0, ZERO: 0 };
  for (const row of rows) {
    const merchant = merchants.find(candidate => candidate.merchantId === row.merchantId);
    const hour = Number(row.slotStart.slice(0, 2));
    const open = isOpen(merchant, isoWeekday(row.observationDate), hour);
    if (row.observationStatus === 'OBSERVED') {
      counts.OBSERVED++;
      assert.equal(open, true);
      assert.ok(Number.isInteger(row.transactionCount) && row.transactionCount >= 0);
      if (row.transactionCount === 0) counts.ZERO++;
    } else {
      assert.equal(row.transactionCount, null);
      if (row.observationStatus === 'MISSING') {
        counts.MISSING++;
        assert.equal(open, true);
      } else {
        counts.CLOSED++;
        assert.equal(open, false);
      }
    }
  }
  assert.equal(counts.MISSING, 40, 'one controlled open-period gap per merchant per week');
  assert.ok(counts.OBSERVED > 0 && counts.CLOSED > 0 && counts.ZERO > 0);
  assert.equal(counts.OBSERVED + counts.MISSING + counts.CLOSED, 4200);
  assert.ok(openingRows().length > 0);
});

test('each merchant weekday and open hour retains at least three observed weeks for later baselines', () => {
  const groups = new Map();
  for (const row of activityRows()) {
    const merchant = merchants.find(candidate => candidate.merchantId === row.merchantId);
    const weekday = isoWeekday(row.observationDate);
    const hour = Number(row.slotStart.slice(0, 2));
    if (!isOpen(merchant, weekday, hour)) continue;
    const key = [row.merchantId, weekday, row.slotStart].join('|');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  assert.ok(groups.size > 0);
  for (const rows of groups.values()) {
    assert.equal(rows.length, 4);
    assert.ok(rows.filter(row => row.observationStatus === 'OBSERVED').length >= 3);
  }
});

test('isolated fixture enforces foreign-key ownership and is deterministic on rerun', () => {
  const first = createStore();
  seedTask3(first);
  assert.equal(first.datasets.size, 1);
  assert.equal(first.merchants.size, 10);
  assert.equal(first.activity.size, 4200);
  for (const row of first.openingHours.values()) assert.ok(first.merchants.has(row.merchantId));
  for (const row of first.activity.values()) {
    assert.ok(first.merchants.has(row.merchantId));
    assert.ok(first.datasets.has(row.datasetKey));
  }
  const once = snapshot(first);
  seedTask3(first);
  assert.equal(snapshot(first), once);
  assert.deepEqual(activityRows(), activityRows());
});

test('isolated fixture validates all collisions before changing any state', () => {
  for (const existing of [
    { ...coreFacts(merchants[0]), isSampleData: false, sampleDatasetKey: null },
    { ...coreFacts(merchants[0]), name: 'Different legacy fact', isSampleData: true, sampleDatasetKey: null },
    { ...coreFacts(merchants[0]), isSampleData: true, sampleDatasetKey: 'another-dataset' }
  ]) {
    const store = createStore();
    store.merchants.set(existing.merchantId, existing);
    const before = snapshot(store);
    assert.throws(() => seedTask3(store), /collides/);
    assert.equal(snapshot(store), before);
  }

  const legacy = createStore();
  for (const merchant of merchants) legacy.merchants.set(merchant.merchantId, {
    ...coreFacts(merchant), isSampleData: true, sampleDatasetKey: null
  });
  seedTask3(legacy);
  assert.equal(legacy.merchants.size, 10, 'matching legacy sample facts are claimed without replacing identity');

  const extra = createStore();
  extra.activity.set('extra', { datasetKey: DATASET.key, merchantId: 'unexpected' });
  const before = snapshot(extra);
  assert.throws(() => seedTask3(extra), /unowned keys/);
  assert.equal(snapshot(extra), before);
});

test('reviewable SQL is generated deterministically and keeps schema, seed, and unsafe db.sql separate', () => {
  const generated = renderSeed();
  const seedPath = path.join(root, 'Database/seeds/003_task3_sample_data.sql');
  const migrationPath = path.join(root, 'Database/migrations/003_task3_sample_schema.sql');
  assert.equal(fs.readFileSync(seedPath, 'utf8'), generated);
  assert.equal(renderSeed(), generated);

  const migration = fs.readFileSync(migrationPath, 'utf8');
  assert.doesNotMatch(migration, /DROP\s+TABLE/i);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS sample_datasets/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS merchant_opening_hours/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS merchant_sample_activity/);
  assert.match(migration, /not fully rollbackable/i);

  const procedureStart = generated.indexOf('CREATE PROCEDURE task3_seed_nets_vouch_v1');
  const firstPermanentInsert = generated.indexOf('INSERT INTO sample_datasets', procedureStart);
  for (const message of [
    'dataset key exists with different metadata',
    'merchant ID collides with non-sample or differing merchant facts',
    'opening-hours dataset contains unowned keys',
    'activity dataset contains unowned keys'
  ]) assert.ok(generated.indexOf(message, procedureStart) < firstPermanentInsert);
  assert.match(generated, /START TRANSACTION;/);
  assert.match(generated, /COMMIT;/);
  assert.match(generated, /ROLLBACK;/);
  assert.doesNotMatch(generated, /INSERT INTO (?:users|transactions|merchant_activity_slots)\b/i);
  assert.doesNotMatch(generated, /(?:UPDATE|DELETE FROM) (?:users|transactions|merchants)\b/i);
});

test('SQL artifact checks are static and do not claim execution compatibility', () => {
  assert.ok(true, 'actual migration and seed execution still require a disposable MySQL 8 review');
});
