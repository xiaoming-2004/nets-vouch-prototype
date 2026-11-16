'use strict';

const { DATASET, merchants, activityRows } = require('../../sample-data/nets-vouch-task3.cjs');

function createStore() {
  return { datasets: new Map(), merchants: new Map(), openingHours: new Map(), activity: new Map() };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function coreFacts(merchant) {
  return {
    merchantId: merchant.merchantId,
    name: merchant.name,
    locationLabel: merchant.locationLabel,
    distanceMetres: merchant.distanceMetres,
    cuisineType: merchant.cuisineType,
    typicalPrice: merchant.typicalPrice,
    dietaryHalal: merchant.dietaryHalal,
    dietaryVegetarian: merchant.dietaryVegetarian,
    dietaryVegan: merchant.dietaryVegan,
    rewardAmount: merchant.rewardAmount,
    minSpend: merchant.minSpend
  };
}

function sameCoreFacts(existing, expected) {
  return JSON.stringify(coreFacts(existing)) === JSON.stringify(coreFacts(expected));
}

function openingRows() {
  const rows = [];
  for (const merchant of merchants) {
    merchant.openingHours.forEach((interval, index) => {
      if (interval) rows.push({
        datasetKey: DATASET.key,
        merchantId: merchant.merchantId,
        isoWeekday: index + 1,
        intervalNo: 1,
        opensAt: interval[0] + ':00',
        closesAt: interval[1] + ':00'
      });
    });
  }
  return rows;
}

function openingKey(row) {
  return [row.datasetKey, row.merchantId, row.isoWeekday, row.intervalNo].join('|');
}

function activityKey(row) {
  return [row.datasetKey, row.merchantId, row.observationDate, row.slotStart].join('|');
}

function seedTask3(store) {
  const dataset = store.datasets.get(DATASET.key);
  if (dataset && JSON.stringify(dataset) !== JSON.stringify(DATASET)) {
    throw new Error('Task 3 dataset key exists with different metadata');
  }

  for (const expected of merchants) {
    const existing = store.merchants.get(expected.merchantId);
    if (!existing) continue;
    if (existing.isSampleData !== true ||
        (existing.sampleDatasetKey !== null && existing.sampleDatasetKey !== DATASET.key) ||
        !sameCoreFacts(existing, expected)) {
      throw new Error('Task 3 merchant ID collides with non-sample or differing merchant facts');
    }
  }

  const expectedOpeningKeys = new Set(openingRows().map(openingKey));
  for (const [key, row] of store.openingHours) {
    if (row.datasetKey === DATASET.key && !expectedOpeningKeys.has(key)) {
      throw new Error('Task 3 opening-hours dataset contains unowned keys');
    }
  }
  const expectedActivityKeys = new Set(activityRows().map(activityKey));
  for (const [key, row] of store.activity) {
    if (row.datasetKey === DATASET.key && !expectedActivityKeys.has(key)) {
      throw new Error('Task 3 activity dataset contains unowned keys');
    }
  }

  store.datasets.set(DATASET.key, clone(DATASET));
  for (const merchant of merchants) {
    const existing = store.merchants.get(merchant.merchantId) || {};
    store.merchants.set(merchant.merchantId, {
      ...existing,
      ...clone(coreFacts(merchant)),
      isSampleData: true,
      latitude: merchant.latitude,
      longitude: merchant.longitude,
      sampleDatasetKey: DATASET.key,
      sampleDataLabel: DATASET.label,
      dietaryClaimStatus: DATASET.dietaryClaimStatus
    });
  }
  for (const row of openingRows()) store.openingHours.set(openingKey(row), clone(row));
  for (const row of activityRows()) store.activity.set(activityKey(row), clone(row));
  return store;
}

function snapshot(store) {
  const sort = entries => [...entries].sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return JSON.stringify({
    datasets: sort(store.datasets),
    merchants: sort(store.merchants),
    openingHours: sort(store.openingHours),
    activity: sort(store.activity)
  });
}

module.exports = { createStore, seedTask3, snapshot, coreFacts, openingRows, activityRows };
