-- GENERATED FILE: scripts/render-task3-sample-seed.cjs
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
INSERT INTO tmp_task3_merchants (ordinal_no, merchant_id, name, location_label, distance_metres, cuisine_type, typical_price, dietary_halal, dietary_vegetarian, dietary_vegan, reward_amount, min_spend, latitude, longitude) VALUES
(0, 'felicia-chicken-rice', 'Felicia''s Chicken Rice', 'RP North Food Court', 180, 'chicken-rice', 5.00, 1, 0, 0, 0.80, 5.00, 1.444419, 103.785400),
(1, 'green-bowl', 'Green Bowl', 'RP North Food Court', 210, 'healthy-food', 7.50, 0, 1, 1, 1.00, 9.00, 1.440911, 103.785400),
(2, 'woodlands-noodle-bar', 'Woodlands Noodle Bar', 'Woodlands Demo Outlet', 320, 'noodles', 6.00, 0, 0, 0, 0.80, 6.00, 1.442800, 103.782521),
(3, 'northside-wraps', 'Northside Wraps', 'Woodlands Demo Outlet', 720, 'wraps', 6.80, 1, 0, 0, 0.50, 8.00, 1.447378, 103.789980),
(4, 'spice-lane', 'Spice Lane', 'Woodlands Demo Outlet', 560, 'indian-food', 7.50, 1, 1, 0, 0.70, 7.50, 1.442800, 103.780362),
(5, 'makcik-nasi-padang', 'Makcik Sari Nasi Padang', 'RP South Canteen', 250, 'malay', 5.50, 1, 0, 0, 0.60, 5.00, 1.440552, 103.785400),
(6, 'tokyo-express-bento', 'Tokyo Express Donburi', 'Woodlands Hub', 480, 'japanese', 8.90, 0, 0, 0, 1.00, 10.00, 1.442800, 103.789719),
(7, 'ah-heng-fish-soup', 'Ah Heng Sliced Fish Soup', 'RP South Canteen', 260, 'soup', 5.20, 0, 0, 0, 0.50, 5.00, 1.441147, 103.787054),
(8, 'vegan-zen-kitchen', 'Zen Plant Kitchen', 'Woodlands Hub', 640, 'healthy-food', 9.50, 0, 1, 1, 1.20, 12.00, 1.446868, 103.789469),
(9, 'kopi-toast-corner', 'Nanyang Kopi & Toast', 'RP North Food Court', 150, 'cafe', 4.50, 1, 1, 0, 0.50, 4.00, 1.442800, 103.784051);

CREATE TEMPORARY TABLE tmp_task3_opening (
  merchant_id VARCHAR(64) NOT NULL,
  iso_weekday TINYINT UNSIGNED NOT NULL,
  interval_no TINYINT UNSIGNED NOT NULL,
  opens_at TIME NOT NULL,
  closes_at TIME NOT NULL,
  PRIMARY KEY (merchant_id, iso_weekday, interval_no)
);
INSERT INTO tmp_task3_opening (merchant_id, iso_weekday, interval_no, opens_at, closes_at) VALUES
('felicia-chicken-rice', 1, 1, '10:00:00', '18:00:00'),
('felicia-chicken-rice', 2, 1, '10:00:00', '18:00:00'),
('felicia-chicken-rice', 3, 1, '10:00:00', '18:00:00'),
('felicia-chicken-rice', 4, 1, '10:00:00', '18:00:00'),
('felicia-chicken-rice', 5, 1, '10:00:00', '18:00:00'),
('felicia-chicken-rice', 6, 1, '10:00:00', '15:00:00'),
('green-bowl', 1, 1, '10:00:00', '20:00:00'),
('green-bowl', 2, 1, '10:00:00', '20:00:00'),
('green-bowl', 3, 1, '10:00:00', '20:00:00'),
('green-bowl', 4, 1, '10:00:00', '20:00:00'),
('green-bowl', 5, 1, '10:00:00', '20:00:00'),
('green-bowl', 6, 1, '10:00:00', '20:00:00'),
('green-bowl', 7, 1, '11:00:00', '17:00:00'),
('woodlands-noodle-bar', 1, 1, '11:00:00', '21:00:00'),
('woodlands-noodle-bar', 2, 1, '11:00:00', '21:00:00'),
('woodlands-noodle-bar', 3, 1, '11:00:00', '21:00:00'),
('woodlands-noodle-bar', 4, 1, '11:00:00', '21:00:00'),
('woodlands-noodle-bar', 5, 1, '11:00:00', '21:00:00'),
('woodlands-noodle-bar', 6, 1, '11:00:00', '21:00:00'),
('woodlands-noodle-bar', 7, 1, '11:00:00', '21:00:00'),
('northside-wraps', 1, 1, '10:00:00', '20:00:00'),
('northside-wraps', 2, 1, '10:00:00', '20:00:00'),
('northside-wraps', 3, 1, '10:00:00', '20:00:00'),
('northside-wraps', 4, 1, '10:00:00', '20:00:00'),
('northside-wraps', 5, 1, '10:00:00', '20:00:00'),
('northside-wraps', 6, 1, '11:00:00', '19:00:00'),
('northside-wraps', 7, 1, '11:00:00', '19:00:00'),
('spice-lane', 1, 1, '11:00:00', '21:00:00'),
('spice-lane', 2, 1, '11:00:00', '21:00:00'),
('spice-lane', 3, 1, '11:00:00', '21:00:00'),
('spice-lane', 4, 1, '11:00:00', '21:00:00'),
('spice-lane', 5, 1, '11:00:00', '21:00:00'),
('spice-lane', 6, 1, '11:00:00', '21:00:00'),
('spice-lane', 7, 1, '11:00:00', '21:00:00'),
('makcik-nasi-padang', 1, 1, '08:00:00', '16:00:00'),
('makcik-nasi-padang', 2, 1, '08:00:00', '16:00:00'),
('makcik-nasi-padang', 3, 1, '08:00:00', '16:00:00'),
('makcik-nasi-padang', 4, 1, '08:00:00', '16:00:00'),
('makcik-nasi-padang', 5, 1, '08:00:00', '16:00:00'),
('makcik-nasi-padang', 6, 1, '08:00:00', '16:00:00'),
('tokyo-express-bento', 1, 1, '11:00:00', '21:00:00'),
('tokyo-express-bento', 2, 1, '11:00:00', '21:00:00'),
('tokyo-express-bento', 3, 1, '11:00:00', '21:00:00'),
('tokyo-express-bento', 4, 1, '11:00:00', '21:00:00'),
('tokyo-express-bento', 5, 1, '11:00:00', '21:00:00'),
('tokyo-express-bento', 6, 1, '11:00:00', '21:00:00'),
('tokyo-express-bento', 7, 1, '11:00:00', '21:00:00'),
('ah-heng-fish-soup', 1, 1, '10:00:00', '19:00:00'),
('ah-heng-fish-soup', 2, 1, '10:00:00', '19:00:00'),
('ah-heng-fish-soup', 3, 1, '10:00:00', '19:00:00'),
('ah-heng-fish-soup', 4, 1, '10:00:00', '19:00:00'),
('ah-heng-fish-soup', 5, 1, '10:00:00', '19:00:00'),
('ah-heng-fish-soup', 6, 1, '10:00:00', '19:00:00'),
('vegan-zen-kitchen', 1, 1, '10:00:00', '20:00:00'),
('vegan-zen-kitchen', 2, 1, '10:00:00', '20:00:00'),
('vegan-zen-kitchen', 3, 1, '10:00:00', '20:00:00'),
('vegan-zen-kitchen', 4, 1, '10:00:00', '20:00:00'),
('vegan-zen-kitchen', 5, 1, '10:00:00', '20:00:00'),
('vegan-zen-kitchen', 6, 1, '10:00:00', '20:00:00'),
('vegan-zen-kitchen', 7, 1, '11:00:00', '18:00:00'),
('kopi-toast-corner', 1, 1, '07:00:00', '17:00:00'),
('kopi-toast-corner', 2, 1, '07:00:00', '17:00:00'),
('kopi-toast-corner', 3, 1, '07:00:00', '17:00:00'),
('kopi-toast-corner', 4, 1, '07:00:00', '17:00:00'),
('kopi-toast-corner', 5, 1, '07:00:00', '17:00:00'),
('kopi-toast-corner', 6, 1, '08:00:00', '15:00:00'),
('kopi-toast-corner', 7, 1, '08:00:00', '15:00:00');

CREATE TEMPORARY TABLE tmp_task3_hourly (
  merchant_id VARCHAR(64) NOT NULL,
  hour_24 TINYINT UNSIGNED NOT NULL,
  base_count INT UNSIGNED NOT NULL,
  PRIMARY KEY (merchant_id, hour_24)
);
INSERT INTO tmp_task3_hourly (merchant_id, hour_24, base_count) VALUES
('felicia-chicken-rice', 7, 0),
('felicia-chicken-rice', 8, 0),
('felicia-chicken-rice', 9, 0),
('felicia-chicken-rice', 10, 2),
('felicia-chicken-rice', 11, 9),
('felicia-chicken-rice', 12, 15),
('felicia-chicken-rice', 13, 11),
('felicia-chicken-rice', 14, 5),
('felicia-chicken-rice', 15, 3),
('felicia-chicken-rice', 16, 2),
('felicia-chicken-rice', 17, 1),
('felicia-chicken-rice', 18, 0),
('felicia-chicken-rice', 19, 0),
('felicia-chicken-rice', 20, 0),
('felicia-chicken-rice', 21, 0),
('green-bowl', 7, 0),
('green-bowl', 8, 0),
('green-bowl', 9, 0),
('green-bowl', 10, 1),
('green-bowl', 11, 5),
('green-bowl', 12, 10),
('green-bowl', 13, 9),
('green-bowl', 14, 6),
('green-bowl', 15, 5),
('green-bowl', 16, 4),
('green-bowl', 17, 5),
('green-bowl', 18, 6),
('green-bowl', 19, 3),
('green-bowl', 20, 0),
('green-bowl', 21, 0),
('woodlands-noodle-bar', 7, 0),
('woodlands-noodle-bar', 8, 0),
('woodlands-noodle-bar', 9, 0),
('woodlands-noodle-bar', 10, 0),
('woodlands-noodle-bar', 11, 4),
('woodlands-noodle-bar', 12, 12),
('woodlands-noodle-bar', 13, 13),
('woodlands-noodle-bar', 14, 6),
('woodlands-noodle-bar', 15, 3),
('woodlands-noodle-bar', 16, 3),
('woodlands-noodle-bar', 17, 5),
('woodlands-noodle-bar', 18, 10),
('woodlands-noodle-bar', 19, 12),
('woodlands-noodle-bar', 20, 7),
('woodlands-noodle-bar', 21, 0),
('northside-wraps', 7, 0),
('northside-wraps', 8, 0),
('northside-wraps', 9, 0),
('northside-wraps', 10, 1),
('northside-wraps', 11, 3),
('northside-wraps', 12, 8),
('northside-wraps', 13, 9),
('northside-wraps', 14, 5),
('northside-wraps', 15, 3),
('northside-wraps', 16, 4),
('northside-wraps', 17, 6),
('northside-wraps', 18, 8),
('northside-wraps', 19, 5),
('northside-wraps', 20, 0),
('northside-wraps', 21, 0),
('spice-lane', 7, 0),
('spice-lane', 8, 0),
('spice-lane', 9, 0),
('spice-lane', 10, 0),
('spice-lane', 11, 4),
('spice-lane', 12, 11),
('spice-lane', 13, 12),
('spice-lane', 14, 6),
('spice-lane', 15, 3),
('spice-lane', 16, 3),
('spice-lane', 17, 5),
('spice-lane', 18, 10),
('spice-lane', 19, 13),
('spice-lane', 20, 8),
('spice-lane', 21, 0),
('makcik-nasi-padang', 7, 0),
('makcik-nasi-padang', 8, 2),
('makcik-nasi-padang', 9, 3),
('makcik-nasi-padang', 10, 4),
('makcik-nasi-padang', 11, 8),
('makcik-nasi-padang', 12, 14),
('makcik-nasi-padang', 13, 12),
('makcik-nasi-padang', 14, 6),
('makcik-nasi-padang', 15, 2),
('makcik-nasi-padang', 16, 0),
('makcik-nasi-padang', 17, 0),
('makcik-nasi-padang', 18, 0),
('makcik-nasi-padang', 19, 0),
('makcik-nasi-padang', 20, 0),
('makcik-nasi-padang', 21, 0),
('tokyo-express-bento', 7, 0),
('tokyo-express-bento', 8, 0),
('tokyo-express-bento', 9, 0),
('tokyo-express-bento', 10, 0),
('tokyo-express-bento', 11, 3),
('tokyo-express-bento', 12, 9),
('tokyo-express-bento', 13, 10),
('tokyo-express-bento', 14, 5),
('tokyo-express-bento', 15, 3),
('tokyo-express-bento', 16, 4),
('tokyo-express-bento', 17, 6),
('tokyo-express-bento', 18, 9),
('tokyo-express-bento', 19, 11),
('tokyo-express-bento', 20, 6),
('tokyo-express-bento', 21, 0),
('ah-heng-fish-soup', 7, 0),
('ah-heng-fish-soup', 8, 0),
('ah-heng-fish-soup', 9, 0),
('ah-heng-fish-soup', 10, 1),
('ah-heng-fish-soup', 11, 5),
('ah-heng-fish-soup', 12, 12),
('ah-heng-fish-soup', 13, 13),
('ah-heng-fish-soup', 14, 7),
('ah-heng-fish-soup', 15, 4),
('ah-heng-fish-soup', 16, 3),
('ah-heng-fish-soup', 17, 3),
('ah-heng-fish-soup', 18, 2),
('ah-heng-fish-soup', 19, 0),
('ah-heng-fish-soup', 20, 0),
('ah-heng-fish-soup', 21, 0),
('vegan-zen-kitchen', 7, 0),
('vegan-zen-kitchen', 8, 0),
('vegan-zen-kitchen', 9, 0),
('vegan-zen-kitchen', 10, 1),
('vegan-zen-kitchen', 11, 4),
('vegan-zen-kitchen', 12, 8),
('vegan-zen-kitchen', 13, 9),
('vegan-zen-kitchen', 14, 6),
('vegan-zen-kitchen', 15, 5),
('vegan-zen-kitchen', 16, 4),
('vegan-zen-kitchen', 17, 5),
('vegan-zen-kitchen', 18, 7),
('vegan-zen-kitchen', 19, 4),
('vegan-zen-kitchen', 20, 0),
('vegan-zen-kitchen', 21, 0),
('kopi-toast-corner', 7, 8),
('kopi-toast-corner', 8, 14),
('kopi-toast-corner', 9, 12),
('kopi-toast-corner', 10, 7),
('kopi-toast-corner', 11, 4),
('kopi-toast-corner', 12, 6),
('kopi-toast-corner', 13, 7),
('kopi-toast-corner', 14, 5),
('kopi-toast-corner', 15, 3),
('kopi-toast-corner', 16, 2),
('kopi-toast-corner', 17, 0),
('kopi-toast-corner', 18, 0),
('kopi-toast-corner', 19, 0),
('kopi-toast-corner', 20, 0),
('kopi-toast-corner', 21, 0);

CREATE TEMPORARY TABLE tmp_task3_dates (
  observation_date DATE PRIMARY KEY,
  iso_weekday TINYINT UNSIGNED NOT NULL,
  week_index TINYINT UNSIGNED NOT NULL
);
INSERT INTO tmp_task3_dates (observation_date, iso_weekday, week_index) VALUES
('2026-10-19', 1, 0),
('2026-10-20', 2, 0),
('2026-10-21', 3, 0),
('2026-10-22', 4, 0),
('2026-10-23', 5, 0),
('2026-10-24', 6, 0),
('2026-10-25', 7, 0),
('2026-10-26', 1, 1),
('2026-10-27', 2, 1),
('2026-10-28', 3, 1),
('2026-10-29', 4, 1),
('2026-10-30', 5, 1),
('2026-10-31', 6, 1),
('2026-11-01', 7, 1),
('2026-11-02', 1, 2),
('2026-11-03', 2, 2),
('2026-11-04', 3, 2),
('2026-11-05', 4, 2),
('2026-11-06', 5, 2),
('2026-11-07', 6, 2),
('2026-11-08', 7, 2),
('2026-11-09', 1, 3),
('2026-11-10', 2, 3),
('2026-11-11', 3, 3),
('2026-11-12', 4, 3),
('2026-11-13', 5, 3),
('2026-11-14', 6, 3),
('2026-11-15', 7, 3);

CREATE TEMPORARY TABLE tmp_task3_weekdays (
  iso_weekday TINYINT UNSIGNED PRIMARY KEY,
  factor_percent SMALLINT UNSIGNED NOT NULL
);
INSERT INTO tmp_task3_weekdays (iso_weekday, factor_percent) VALUES
(1, 100),
(2, 103),
(3, 106),
(4, 110),
(5, 116),
(6, 91),
(7, 72);

CREATE TEMPORARY TABLE tmp_task3_weeks (
  week_index TINYINT UNSIGNED PRIMARY KEY,
  count_adjustment SMALLINT NOT NULL
);
INSERT INTO tmp_task3_weeks (week_index, count_adjustment) VALUES
(0, -1),
(1, 0),
(2, 1),
(3, 0);

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
  60,
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
  WHERE dataset_key = 'nets-vouch-task3-v1'
    AND NOT (
      sample_label <=> 'Fictional NETS Vouch Task 3 sample; not a participating business'
      AND timezone_name <=> 'Asia/Singapore'
      AND origin_name <=> 'Republic Polytechnic demo origin'
      AND origin_latitude <=> 1.442800
      AND origin_longitude <=> 103.785400
      AND distance_basis <=> 'STRAIGHT_LINE_DEMO_ORIGIN_ESTIMATE_NOT_ROUTED'
      AND period_start <=> '2026-10-19'
      AND period_end <=> '2026-11-15'
      AND slot_start_hour <=> 7
      AND slot_end_hour <=> 21
      AND slot_minutes <=> 60
      AND disclosure <=> 'Fictional deterministic sample data only. It is not live NETS traffic, a queue estimate, a real merchant participation claim, or verified dietary certification.'
    );
  IF collision_count > 0 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Task 3 dataset key exists with different metadata';
  END IF;

  SELECT COUNT(*) INTO collision_count
  FROM merchants existing
  JOIN tmp_task3_merchants expected ON expected.merchant_id = existing.merchant_id
  WHERE existing.is_sample_data <> TRUE
     OR existing.sample_dataset_key NOT IN ('nets-vouch-task3-v1')
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
  WHERE existing.dataset_key = 'nets-vouch-task3-v1' AND expected.merchant_id IS NULL;
  IF collision_count > 0 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Task 3 opening-hours dataset contains unowned keys';
  END IF;

  SELECT COUNT(*) INTO collision_count
  FROM merchant_sample_activity existing
  LEFT JOIN tmp_task3_activity expected
    ON expected.merchant_id = existing.merchant_id
    AND expected.observation_date = existing.observation_date
    AND expected.slot_start = existing.slot_start
  WHERE existing.dataset_key = 'nets-vouch-task3-v1' AND expected.merchant_id IS NULL;
  IF collision_count > 0 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Task 3 activity dataset contains unowned keys';
  END IF;

  INSERT INTO sample_datasets
    (dataset_key, sample_label, timezone_name, origin_name, origin_latitude, origin_longitude,
     distance_basis, period_start, period_end, slot_start_hour, slot_end_hour, slot_minutes, disclosure)
  VALUES
    ('nets-vouch-task3-v1', 'Fictional NETS Vouch Task 3 sample; not a participating business', 'Asia/Singapore',
     'Republic Polytechnic demo origin', 1.442800, 103.785400,
     'STRAIGHT_LINE_DEMO_ORIGIN_ESTIMATE_NOT_ROUTED', '2026-10-19', '2026-11-15', 7,
     21, 60, 'Fictional deterministic sample data only. It is not live NETS traffic, a queue estimate, a real merchant participation claim, or verified dietary certification.')
  ON DUPLICATE KEY UPDATE dataset_key = VALUES(dataset_key);

  INSERT INTO merchants
    (merchant_id, name, location_label, distance_metres, cuisine_type, typical_price,
     dietary_halal, dietary_vegetarian, dietary_vegan, reward_amount, min_spend, is_sample_data,
     latitude, longitude, sample_dataset_key, sample_data_label, dietary_claim_status)
  SELECT merchant_id, name, location_label, distance_metres, cuisine_type, typical_price,
    dietary_halal, dietary_vegetarian, dietary_vegan, reward_amount, min_spend, TRUE,
    latitude, longitude, 'nets-vouch-task3-v1', 'Fictional NETS Vouch Task 3 sample; not a participating business',
    'DEMO_UNVERIFIED'
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
  SELECT 'nets-vouch-task3-v1', merchant_id, iso_weekday, interval_no, opens_at, closes_at
  FROM tmp_task3_opening
  WHERE TRUE
  ON DUPLICATE KEY UPDATE opens_at = VALUES(opens_at), closes_at = VALUES(closes_at);

  INSERT INTO merchant_sample_activity
    (dataset_key, merchant_id, observation_date, slot_start, slot_minutes,
     observation_status, transaction_count)
  SELECT 'nets-vouch-task3-v1', merchant_id, observation_date, slot_start, slot_minutes,
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
