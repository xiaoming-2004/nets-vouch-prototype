'use strict';

const DATASET = Object.freeze({
  key: 'nets-vouch-task3-v1',
  label: 'Fictional NETS Vouch Task 3 sample; not a participating business',
  timezone: 'Asia/Singapore',
  originName: 'Republic Polytechnic demo origin',
  originLatitude: 1.442800,
  originLongitude: 103.785400,
  distanceBasis: 'STRAIGHT_LINE_DEMO_ORIGIN_ESTIMATE_NOT_ROUTED',
  periodStart: '2026-10-19',
  periodEnd: '2026-11-15',
  slotStartHour: 7,
  slotEndHour: 21,
  slotMinutes: 60,
  dietaryClaimStatus: 'DEMO_UNVERIFIED',
  disclosure: 'Fictional deterministic sample data only. It is not live NETS traffic, a queue estimate, a real merchant participation claim, or verified dietary certification.'
});

const weekdayFactors = Object.freeze([100, 103, 106, 110, 116, 91, 72]);
const weekAdjustments = Object.freeze([-1, 0, 1, 0]);

function hours(monFri, saturday, sunday) {
  return [monFri, monFri, monFri, monFri, monFri, saturday, sunday];
}

const merchants = Object.freeze([
  {
    ordinal: 0, merchantId: 'felicia-chicken-rice', name: "Felicia's Chicken Rice",
    locationLabel: 'RP North Food Court', distanceMetres: 180, cuisineType: 'chicken-rice',
    typicalPrice: '5.00', dietaryHalal: true, dietaryVegetarian: false, dietaryVegan: false,
    rewardAmount: '0.80', minSpend: '5.00', latitude: 1.444419, longitude: 103.785400,
    openingHours: hours(['10:00', '18:00'], ['10:00', '15:00'], null),
    hourlyBase: [0, 0, 0, 2, 9, 15, 11, 5, 3, 2, 1, 0, 0, 0, 0]
  },
  {
    ordinal: 1, merchantId: 'green-bowl', name: 'Green Bowl',
    locationLabel: 'RP North Food Court', distanceMetres: 210, cuisineType: 'healthy-food',
    typicalPrice: '7.50', dietaryHalal: false, dietaryVegetarian: true, dietaryVegan: true,
    rewardAmount: '1.00', minSpend: '9.00', latitude: 1.440911, longitude: 103.785400,
    openingHours: hours(['10:00', '20:00'], ['10:00', '20:00'], ['11:00', '17:00']),
    hourlyBase: [0, 0, 0, 1, 5, 10, 9, 6, 5, 4, 5, 6, 3, 0, 0]
  },
  {
    ordinal: 2, merchantId: 'woodlands-noodle-bar', name: 'Woodlands Noodle Bar',
    locationLabel: 'Woodlands Demo Outlet', distanceMetres: 320, cuisineType: 'noodles',
    typicalPrice: '6.00', dietaryHalal: false, dietaryVegetarian: false, dietaryVegan: false,
    rewardAmount: '0.80', minSpend: '6.00', latitude: 1.442800, longitude: 103.782521,
    openingHours: hours(['11:00', '21:00'], ['11:00', '21:00'], ['11:00', '21:00']),
    hourlyBase: [0, 0, 0, 0, 4, 12, 13, 6, 3, 3, 5, 10, 12, 7, 0]
  },
  {
    ordinal: 3, merchantId: 'northside-wraps', name: 'Northside Wraps',
    locationLabel: 'Woodlands Demo Outlet', distanceMetres: 720, cuisineType: 'wraps',
    typicalPrice: '6.80', dietaryHalal: true, dietaryVegetarian: false, dietaryVegan: false,
    rewardAmount: '0.50', minSpend: '8.00', latitude: 1.447378, longitude: 103.789980,
    openingHours: hours(['10:00', '20:00'], ['11:00', '19:00'], ['11:00', '19:00']),
    hourlyBase: [0, 0, 0, 1, 3, 8, 9, 5, 3, 4, 6, 8, 5, 0, 0]
  },
  {
    ordinal: 4, merchantId: 'spice-lane', name: 'Spice Lane',
    locationLabel: 'Woodlands Demo Outlet', distanceMetres: 560, cuisineType: 'indian-food',
    typicalPrice: '7.50', dietaryHalal: true, dietaryVegetarian: true, dietaryVegan: false,
    rewardAmount: '0.70', minSpend: '7.50', latitude: 1.442800, longitude: 103.780362,
    openingHours: hours(['11:00', '21:00'], ['11:00', '21:00'], ['11:00', '21:00']),
    hourlyBase: [0, 0, 0, 0, 4, 11, 12, 6, 3, 3, 5, 10, 13, 8, 0]
  },
  {
    ordinal: 5, merchantId: 'makcik-nasi-padang', name: 'Makcik Sari Nasi Padang',
    locationLabel: 'RP South Canteen', distanceMetres: 250, cuisineType: 'malay',
    typicalPrice: '5.50', dietaryHalal: true, dietaryVegetarian: false, dietaryVegan: false,
    rewardAmount: '0.60', minSpend: '5.00', latitude: 1.440552, longitude: 103.785400,
    openingHours: hours(['08:00', '16:00'], ['08:00', '16:00'], null),
    hourlyBase: [0, 2, 3, 4, 8, 14, 12, 6, 2, 0, 0, 0, 0, 0, 0]
  },
  {
    ordinal: 6, merchantId: 'tokyo-express-bento', name: 'Tokyo Express Donburi',
    locationLabel: 'Woodlands Hub', distanceMetres: 480, cuisineType: 'japanese',
    typicalPrice: '8.90', dietaryHalal: false, dietaryVegetarian: false, dietaryVegan: false,
    rewardAmount: '1.00', minSpend: '10.00', latitude: 1.442800, longitude: 103.789719,
    openingHours: hours(['11:00', '21:00'], ['11:00', '21:00'], ['11:00', '21:00']),
    hourlyBase: [0, 0, 0, 0, 3, 9, 10, 5, 3, 4, 6, 9, 11, 6, 0]
  },
  {
    ordinal: 7, merchantId: 'ah-heng-fish-soup', name: 'Ah Heng Sliced Fish Soup',
    locationLabel: 'RP South Canteen', distanceMetres: 260, cuisineType: 'soup',
    typicalPrice: '5.20', dietaryHalal: false, dietaryVegetarian: false, dietaryVegan: false,
    rewardAmount: '0.50', minSpend: '5.00', latitude: 1.441147, longitude: 103.787054,
    openingHours: hours(['10:00', '19:00'], ['10:00', '19:00'], null),
    hourlyBase: [0, 0, 0, 1, 5, 12, 13, 7, 4, 3, 3, 2, 0, 0, 0]
  },
  {
    ordinal: 8, merchantId: 'vegan-zen-kitchen', name: 'Zen Plant Kitchen',
    locationLabel: 'Woodlands Hub', distanceMetres: 640, cuisineType: 'healthy-food',
    typicalPrice: '9.50', dietaryHalal: false, dietaryVegetarian: true, dietaryVegan: true,
    rewardAmount: '1.20', minSpend: '12.00', latitude: 1.446868, longitude: 103.789469,
    openingHours: hours(['10:00', '20:00'], ['10:00', '20:00'], ['11:00', '18:00']),
    hourlyBase: [0, 0, 0, 1, 4, 8, 9, 6, 5, 4, 5, 7, 4, 0, 0]
  },
  {
    ordinal: 9, merchantId: 'kopi-toast-corner', name: 'Nanyang Kopi & Toast',
    locationLabel: 'RP North Food Court', distanceMetres: 150, cuisineType: 'cafe',
    typicalPrice: '4.50', dietaryHalal: true, dietaryVegetarian: true, dietaryVegan: false,
    rewardAmount: '0.50', minSpend: '4.00', latitude: 1.442800, longitude: 103.784051,
    openingHours: hours(['07:00', '17:00'], ['08:00', '15:00'], ['08:00', '15:00']),
    hourlyBase: [8, 14, 12, 7, 4, 6, 7, 5, 3, 2, 0, 0, 0, 0, 0]
  }
]);

function parseDate(date) {
  return new Date(date + 'T00:00:00.000Z');
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function dates() {
  const result = [];
  const cursor = parseDate(DATASET.periodStart);
  const end = parseDate(DATASET.periodEnd);
  while (cursor <= end) {
    result.push(isoDate(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return result;
}

function isoWeekday(date) {
  const day = parseDate(date).getUTCDay();
  return day === 0 ? 7 : day;
}

function weekIndex(date) {
  return Math.floor((parseDate(date) - parseDate(DATASET.periodStart)) / (7 * 86400000));
}

function isOpen(merchant, weekday, hour) {
  const interval = merchant.openingHours[weekday - 1];
  if (!interval) return false;
  const opens = Number(interval[0].slice(0, 2));
  const closes = Number(interval[1].slice(0, 2));
  return hour >= opens && hour + 1 <= closes;
}

function isMissing(merchant, date, hour) {
  const week = weekIndex(date);
  const weekday = isoWeekday(date);
  return weekday === 1 + ((merchant.ordinal + week) % 4) &&
    hour === 12 + ((merchant.ordinal + week) % 2);
}

function activityRows() {
  const result = [];
  for (const merchant of merchants) {
    for (const date of dates()) {
      const weekday = isoWeekday(date);
      const week = weekIndex(date);
      for (let hour = DATASET.slotStartHour; hour <= DATASET.slotEndHour; hour++) {
        let observationStatus = 'CLOSED';
        let transactionCount = null;
        if (isOpen(merchant, weekday, hour)) {
          if (isMissing(merchant, date, hour)) {
            observationStatus = 'MISSING';
          } else {
            observationStatus = 'OBSERVED';
            const base = merchant.hourlyBase[hour - DATASET.slotStartHour];
            transactionCount = Math.max(0, Math.round(base * weekdayFactors[weekday - 1] / 100 + weekAdjustments[week]));
          }
        }
        result.push({
          datasetKey: DATASET.key,
          merchantId: merchant.merchantId,
          observationDate: date,
          slotStart: String(hour).padStart(2, '0') + ':00:00',
          slotMinutes: DATASET.slotMinutes,
          observationStatus,
          transactionCount
        });
      }
    }
  }
  return result;
}

module.exports = {
  DATASET,
  merchants,
  weekdayFactors,
  weekAdjustments,
  dates,
  isoWeekday,
  weekIndex,
  isOpen,
  isMissing,
  activityRows
};
