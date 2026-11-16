'use strict';

const fs = require('node:fs');
const path = require('node:path');
const definition = require('../sample-data/nets-vouch-task3.cjs');

function sqlString(value) {
  return "'" + String(value).replaceAll("'", "''") + "'";
}

function tuple(values) {
  return '(' + values.map(value => value === null ? 'NULL' : value).join(', ') + ')';
}

function insertRows(table, columns, rows) {
  return `INSERT INTO ${table} (${columns.join(', ')}) VALUES\n${rows.map(tuple).join(',\n')};`;
}

function renderSeed() {
  const { DATASET, merchants, weekdayFactors, weekAdjustments, dates, isoWeekday, weekIndex } = definition;
  const merchantRows = merchants.map(merchant => [
    merchant.ordinal,
    sqlString(merchant.merchantId), sqlString(merchant.name), sqlString(merchant.locationLabel),
    merchant.distanceMetres, sqlString(merchant.cuisineType), merchant.typicalPrice,
    Number(merchant.dietaryHalal), Number(merchant.dietaryVegetarian), Number(merchant.dietaryVegan),
    merchant.rewardAmount, merchant.minSpend, merchant.latitude.toFixed(6), merchant.longitude.toFixed(6)
  ]);
  const openingRows = [];
  const hourlyRows = [];
  for (const merchant of merchants) {
    merchant.openingHours.forEach((interval, index) => {
      if (interval) openingRows.push([
        sqlString(merchant.merchantId), index + 1, 1,
        sqlString(interval[0] + ':00'), sqlString(interval[1] + ':00')
      ]);
    });
    merchant.hourlyBase.forEach((baseCount, index) => hourlyRows.push([
      sqlString(merchant.merchantId), DATASET.slotStartHour + index, baseCount
    ]));
  }
  const dateRows = dates().map(date => [sqlString(date), isoWeekday(date), weekIndex(date)]);
  const weekdayRows = weekdayFactors.map((factor, index) => [index + 1, factor]);
  const weekRows = weekAdjustments.map((adjustment, index) => [index, adjustment]);

  return `-- GENERATED FILE: scripts/render-task3-sample-seed.cjs
-- Review only. Run Database/migrations/003_task3_sample_schema.sql first.
-- This seed stages all 4,200 expected rows in temporary tables, validates every
-- ownership/collision condition, and only then changes permanent data in one transaction.
-- It never writes users, transactions, merchant_activity_slots, payments, or campaigns.

USE NetsVouch;

DROP TEMPORARY TABLE IF EXISTS tmp_task3_activity;
DROP TEMPORARY TABLE IF EXISTS tmp_task3_opening;
DROP TEMPORARY TABLE IF EXISTS tmp_task3_hourly;
DROP TEMPORARY TABLE IF EXISTS tmp_task3_dates;
DROP TEMPORARY TABLE IF EXISTS tmp_task3_weekdays;
DROP TEMPORARY TABLE IF EXISTS tmp_task3_weeks;
DROP TEMPORARY TABLE IF EXISTS tmp_task3_merchants;

CREATE TEMPORARY TABLE tmp_task3_merchants (
  ordinal_no TINYINT UNSIGNED PRIMARY KEY,
  merchant_id VARCHAR(64) NOT NULL UNIQUE,
  name VARCHAR(120) NOT NULL,
  location_label VARCHAR(160) NOT NULL,
  distance_metres INT NOT NULL,
  cuisine_type VARCHAR(64) NOT NULL,
  typical_price DECIMAL(6,2) NOT NULL,
  dietary_halal BOOLEAN NOT NULL,
  dietary_vegetarian BOOLEAN NOT NULL,
  dietary_vegan BOOLEAN NOT NULL,
  reward_amount DECIMAL(6,2) NOT NULL,
  min_spend DECIMAL(6,2) NOT NULL,
  latitude DECIMAL(9,6) NOT NULL,
  longitude DECIMAL(9,6) NOT NULL
);
${insertRows('tmp_task3_merchants', [
    'ordinal_no', 'merchant_id', 'name', 'location_label', 'distance_metres', 'cuisine_type',
    'typical_price', 'dietary_halal', 'dietary_vegetarian', 'dietary_vegan', 'reward_amount',
    'min_spend', 'latitude', 'longitude'
  ], merchantRows)}

CREATE TEMPORARY TABLE tmp_task3_opening (
  merchant_id VARCHAR(64) NOT NULL,
  iso_weekday TINYINT UNSIGNED NOT NULL,
  interval_no TINYINT UNSIGNED NOT NULL,
  opens_at TIME NOT NULL,
  closes_at TIME NOT NULL,
  PRIMARY KEY (merchant_id, iso_weekday, interval_no)
);
${insertRows('tmp_task3_opening', ['merchant_id', 'iso_weekday', 'interval_no', 'opens_at', 'closes_at'], openingRows)}

CREATE TEMPORARY TABLE tmp_task3_hourly (
  merchant_id VARCHAR(64) NOT NULL,
  hour_24 TINYINT UNSIGNED NOT NULL,
  base_count INT UNSIGNED NOT NULL,
  PRIMARY KEY (merchant_id, hour_24)
);
${insertRows('tmp_task3_hourly', ['merchant_id', 'hour_24', 'base_count'], hourlyRows)}

CREATE TEMPORARY TABLE tmp_task3_dates (
  observation_date DATE PRIMARY KEY,
  iso_weekday TINYINT UNSIGNED NOT NULL,
  week_index TINYINT UNSIGNED NOT NULL
);
${insertRows('tmp_task3_dates', ['observation_date', 'iso_weekday', 'week_index'], dateRows)}

CREATE TEMPORARY TABLE tmp_task3_weekdays (
  iso_weekday TINYINT UNSIGNED PRIMARY KEY,
  factor_percent SMALLINT UNSIGNED NOT NULL
);
${insertRows('tmp_task3_weekdays', ['iso_weekday', 'factor_percent'], weekdayRows)}

CREATE TEMPORARY TABLE tmp_task3_weeks (
  week_index TINYINT UNSIGNED PRIMARY KEY,
  count_adjustment SMALLINT NOT NULL
);
${insertRows('tmp_task3_weeks', ['week_index', 'count_adjustment'], weekRows)}

CREATE TEMPORARY TABLE tmp_task3_activity (
  merchant_id VARCHAR(64) NOT NULL,
  observation_date DATE NOT NULL,
  slot_start TIME NOT NULL,
  slot_minutes SMALLINT UNSIGNED NOT NULL,
  observation_status ENUM('OBSERVED', 'MISSING', 'CLOSED') NOT NULL,
  transaction_count INT UNSIGNED NULL,
  PRIMARY KEY (merchant_id, observation_date, slot_start)
);

INSERT INTO tmp_task3_activity
  (merchant_id, observation_date, slot_start, slot_minutes, observation_status, transaction_count)
SELECT
  merchant.merchant_id,
  sample_date.observation_date,
  MAKETIME(hourly.hour_24, 0, 0),
  ${DATASET.slotMinutes},
  CASE
    WHEN opening.merchant_id IS NULL THEN 'CLOSED'
    WHEN sample_date.iso_weekday = 1 + MOD(merchant.ordinal_no + sample_date.week_index, 4)
      AND hourly.hour_24 = 12 + MOD(merchant.ordinal_no + sample_date.week_index, 2) THEN 'MISSING'
    ELSE 'OBSERVED'
  END,
  CASE
    WHEN opening.merchant_id IS NULL THEN NULL
    WHEN sample_date.iso_weekday = 1 + MOD(merchant.ordinal_no + sample_date.week_index, 4)
      AND hourly.hour_24 = 12 + MOD(merchant.ordinal_no + sample_date.week_index, 2) THEN NULL
    ELSE GREATEST(0, ROUND(hourly.base_count * weekday.factor_percent / 100 + sample_week.count_adjustment))
  END
FROM tmp_task3_merchants merchant
JOIN tmp_task3_hourly hourly ON hourly.merchant_id = merchant.merchant_id
CROSS JOIN tmp_task3_dates sample_date
JOIN tmp_task3_weekdays weekday ON weekday.iso_weekday = sample_date.iso_weekday
JOIN tmp_task3_weeks sample_week ON sample_week.week_index = sample_date.week_index
LEFT JOIN tmp_task3_opening opening
  ON opening.merchant_id = merchant.merchant_id
  AND opening.iso_weekday = sample_date.iso_weekday
  AND MAKETIME(hourly.hour_24, 0, 0) >= opening.opens_at
  AND ADDTIME(MAKETIME(hourly.hour_24, 0, 0), '01:00:00') <= opening.closes_at;

DELIMITER //
DROP PROCEDURE IF EXISTS task3_seed_nets_vouch_v1//
CREATE PROCEDURE task3_seed_nets_vouch_v1()
BEGIN
  DECLARE collision_count INT DEFAULT 0;
  DECLARE EXIT HANDLER FOR SQLEXCEPTION
  BEGIN
    ROLLBACK;
    RESIGNAL;
  END;

  START TRANSACTION;

  IF (SELECT COUNT(*) FROM tmp_task3_merchants) <> 10
    OR (SELECT COUNT(*) FROM tmp_task3_dates) <> 28
    OR (SELECT COUNT(*) FROM tmp_task3_hourly) <> 150
    OR (SELECT COUNT(*) FROM tmp_task3_activity) <> 4200 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Task 3 staged definition has unexpected cardinality';
  END IF;

  SELECT COUNT(*) INTO collision_count
  FROM sample_datasets
  WHERE dataset_key = ${sqlString(DATASET.key)}
    AND NOT (
      sample_label <=> ${sqlString(DATASET.label)}
      AND timezone_name <=> ${sqlString(DATASET.timezone)}
      AND origin_name <=> ${sqlString(DATASET.originName)}
      AND origin_latitude <=> ${DATASET.originLatitude.toFixed(6)}
      AND origin_longitude <=> ${DATASET.originLongitude.toFixed(6)}
      AND distance_basis <=> ${sqlString(DATASET.distanceBasis)}
      AND period_start <=> ${sqlString(DATASET.periodStart)}
      AND period_end <=> ${sqlString(DATASET.periodEnd)}
      AND slot_start_hour <=> ${DATASET.slotStartHour}
      AND slot_end_hour <=> ${DATASET.slotEndHour}
      AND slot_minutes <=> ${DATASET.slotMinutes}
      AND disclosure <=> ${sqlString(DATASET.disclosure)}
    );
  IF collision_count > 0 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Task 3 dataset key exists with different metadata';
  END IF;

  SELECT COUNT(*) INTO collision_count
  FROM merchants existing
  JOIN tmp_task3_merchants expected ON expected.merchant_id = existing.merchant_id
  WHERE existing.is_sample_data <> TRUE
     OR existing.sample_dataset_key NOT IN (${sqlString(DATASET.key)})
     OR NOT (
       existing.name <=> expected.name
       AND existing.location_label <=> expected.location_label
       AND existing.distance_metres <=> expected.distance_metres
       AND existing.cuisine_type <=> expected.cuisine_type
       AND existing.typical_price <=> expected.typical_price
       AND existing.dietary_halal <=> expected.dietary_halal
       AND existing.dietary_vegetarian <=> expected.dietary_vegetarian
       AND existing.dietary_vegan <=> expected.dietary_vegan
       AND existing.reward_amount <=> expected.reward_amount
       AND existing.min_spend <=> expected.min_spend
     );
  IF collision_count > 0 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Task 3 merchant ID collides with non-sample or differing merchant facts';
  END IF;

  SELECT COUNT(*) INTO collision_count
  FROM merchant_opening_hours existing
  LEFT JOIN tmp_task3_opening expected
    ON expected.merchant_id = existing.merchant_id
    AND expected.iso_weekday = existing.iso_weekday
    AND expected.interval_no = existing.interval_no
  WHERE existing.dataset_key = ${sqlString(DATASET.key)} AND expected.merchant_id IS NULL;
  IF collision_count > 0 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Task 3 opening-hours dataset contains unowned keys';
  END IF;

  SELECT COUNT(*) INTO collision_count
  FROM merchant_sample_activity existing
  LEFT JOIN tmp_task3_activity expected
    ON expected.merchant_id = existing.merchant_id
    AND expected.observation_date = existing.observation_date
    AND expected.slot_start = existing.slot_start
  WHERE existing.dataset_key = ${sqlString(DATASET.key)} AND expected.merchant_id IS NULL;
  IF collision_count > 0 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Task 3 activity dataset contains unowned keys';
  END IF;

  INSERT INTO sample_datasets
    (dataset_key, sample_label, timezone_name, origin_name, origin_latitude, origin_longitude,
     distance_basis, period_start, period_end, slot_start_hour, slot_end_hour, slot_minutes, disclosure)
  VALUES
    (${sqlString(DATASET.key)}, ${sqlString(DATASET.label)}, ${sqlString(DATASET.timezone)},
     ${sqlString(DATASET.originName)}, ${DATASET.originLatitude.toFixed(6)}, ${DATASET.originLongitude.toFixed(6)},
     ${sqlString(DATASET.distanceBasis)}, ${sqlString(DATASET.periodStart)}, ${sqlString(DATASET.periodEnd)}, ${DATASET.slotStartHour},
     ${DATASET.slotEndHour}, ${DATASET.slotMinutes}, ${sqlString(DATASET.disclosure)})
  ON DUPLICATE KEY UPDATE dataset_key = VALUES(dataset_key);

  INSERT INTO merchants
    (merchant_id, name, location_label, distance_metres, cuisine_type, typical_price,
     dietary_halal, dietary_vegetarian, dietary_vegan, reward_amount, min_spend, is_sample_data,
     latitude, longitude, sample_dataset_key, sample_data_label, dietary_claim_status)
  SELECT merchant_id, name, location_label, distance_metres, cuisine_type, typical_price,
    dietary_halal, dietary_vegetarian, dietary_vegan, reward_amount, min_spend, TRUE,
    latitude, longitude, ${sqlString(DATASET.key)}, ${sqlString(DATASET.label)},
    ${sqlString(DATASET.dietaryClaimStatus)}
  FROM tmp_task3_merchants
  WHERE TRUE
  ON DUPLICATE KEY UPDATE
    latitude = VALUES(latitude),
    longitude = VALUES(longitude),
    sample_dataset_key = VALUES(sample_dataset_key),
    sample_data_label = VALUES(sample_data_label),
    dietary_claim_status = VALUES(dietary_claim_status);

  INSERT INTO merchant_opening_hours
    (dataset_key, merchant_id, iso_weekday, interval_no, opens_at, closes_at)
  SELECT ${sqlString(DATASET.key)}, merchant_id, iso_weekday, interval_no, opens_at, closes_at
  FROM tmp_task3_opening
  WHERE TRUE
  ON DUPLICATE KEY UPDATE opens_at = VALUES(opens_at), closes_at = VALUES(closes_at);

  INSERT INTO merchant_sample_activity
    (dataset_key, merchant_id, observation_date, slot_start, slot_minutes,
     observation_status, transaction_count)
  SELECT ${sqlString(DATASET.key)}, merchant_id, observation_date, slot_start, slot_minutes,
    observation_status, transaction_count
  FROM tmp_task3_activity
  WHERE TRUE
  ON DUPLICATE KEY UPDATE
    slot_minutes = VALUES(slot_minutes),
    observation_status = VALUES(observation_status),
    transaction_count = VALUES(transaction_count);

  COMMIT;
END//
CALL task3_seed_nets_vouch_v1()//
DROP PROCEDURE task3_seed_nets_vouch_v1//
DELIMITER ;

DROP TEMPORARY TABLE tmp_task3_activity;
DROP TEMPORARY TABLE tmp_task3_opening;
DROP TEMPORARY TABLE tmp_task3_hourly;
DROP TEMPORARY TABLE tmp_task3_dates;
DROP TEMPORARY TABLE tmp_task3_weekdays;
DROP TEMPORARY TABLE tmp_task3_weeks;
DROP TEMPORARY TABLE tmp_task3_merchants;
`;
}

function main(argv) {
  const output = renderSeed();
  const target = path.resolve(__dirname, '../Database/seeds/003_task3_sample_data.sql');
  if (argv.includes('--check')) {
    if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== output) {
      process.stderr.write('Task 3 generated seed is out of date.\n');
      process.exitCode = 1;
    }
    return;
  }
  if (argv.includes('--stdout')) process.stdout.write(output);
  else fs.writeFileSync(target, output, 'utf8');
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { renderSeed };
