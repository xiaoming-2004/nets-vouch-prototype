-- Task 3 additive schema migration. Review and run this file before the matching seed.
-- MySQL DDL can implicitly commit and is not fully rollbackable. Take an appropriate
-- schema backup and test this migration on a disposable MySQL 8 environment first.
-- This file is rerunnable: existing columns and named constraints are detected through
-- information_schema. It never drops or rewrites an existing table or column.

USE NetsVouch;

CREATE TABLE IF NOT EXISTS sample_datasets (
    dataset_key VARCHAR(64) PRIMARY KEY,
    sample_label VARCHAR(160) NOT NULL,
    timezone_name VARCHAR(64) NOT NULL,
    origin_name VARCHAR(120) NOT NULL,
    origin_latitude DECIMAL(9,6) NOT NULL,
    origin_longitude DECIMAL(9,6) NOT NULL,
    distance_basis VARCHAR(80) NOT NULL,
    period_start DATE NOT NULL,
    period_end DATE NOT NULL,
    slot_start_hour TINYINT UNSIGNED NOT NULL,
    slot_end_hour TINYINT UNSIGNED NOT NULL,
    slot_minutes SMALLINT UNSIGNED NOT NULL,
    disclosure VARCHAR(500) NOT NULL,
    CONSTRAINT chk_sample_datasets_period CHECK (period_end >= period_start),
    CONSTRAINT chk_sample_datasets_slots CHECK (
      slot_start_hour <= slot_end_hour AND slot_end_hour <= 23 AND slot_minutes > 0
    ),
    CONSTRAINT chk_sample_datasets_coordinates CHECK (
      origin_latitude BETWEEN -90 AND 90 AND origin_longitude BETWEEN -180 AND 180
    )
) ENGINE=InnoDB;

SET @task3_sql = IF(
  EXISTS(SELECT 1 FROM information_schema.columns
         WHERE table_schema = DATABASE() AND table_name = 'merchants' AND column_name = 'latitude'),
  'SELECT 1',
  'ALTER TABLE merchants ADD COLUMN latitude DECIMAL(9,6) NULL AFTER is_sample_data'
);
PREPARE task3_stmt FROM @task3_sql; EXECUTE task3_stmt; DEALLOCATE PREPARE task3_stmt;

SET @task3_sql = IF(
  EXISTS(SELECT 1 FROM information_schema.columns
         WHERE table_schema = DATABASE() AND table_name = 'merchants' AND column_name = 'longitude'),
  'SELECT 1',
  'ALTER TABLE merchants ADD COLUMN longitude DECIMAL(9,6) NULL AFTER latitude'
);
PREPARE task3_stmt FROM @task3_sql; EXECUTE task3_stmt; DEALLOCATE PREPARE task3_stmt;

SET @task3_sql = IF(
  EXISTS(SELECT 1 FROM information_schema.columns
         WHERE table_schema = DATABASE() AND table_name = 'merchants' AND column_name = 'sample_dataset_key'),
  'SELECT 1',
  'ALTER TABLE merchants ADD COLUMN sample_dataset_key VARCHAR(64) NULL AFTER longitude'
);
PREPARE task3_stmt FROM @task3_sql; EXECUTE task3_stmt; DEALLOCATE PREPARE task3_stmt;

SET @task3_sql = IF(
  EXISTS(SELECT 1 FROM information_schema.columns
         WHERE table_schema = DATABASE() AND table_name = 'merchants' AND column_name = 'sample_data_label'),
  'SELECT 1',
  'ALTER TABLE merchants ADD COLUMN sample_data_label VARCHAR(160) NULL AFTER sample_dataset_key'
);
PREPARE task3_stmt FROM @task3_sql; EXECUTE task3_stmt; DEALLOCATE PREPARE task3_stmt;

SET @task3_sql = IF(
  EXISTS(SELECT 1 FROM information_schema.columns
         WHERE table_schema = DATABASE() AND table_name = 'merchants' AND column_name = 'dietary_claim_status'),
  'SELECT 1',
  'ALTER TABLE merchants ADD COLUMN dietary_claim_status VARCHAR(32) NULL AFTER sample_data_label'
);
PREPARE task3_stmt FROM @task3_sql; EXECUTE task3_stmt; DEALLOCATE PREPARE task3_stmt;

SET @task3_sql = IF(
  EXISTS(SELECT 1 FROM information_schema.table_constraints
         WHERE constraint_schema = DATABASE() AND table_name = 'merchants'
           AND constraint_name = 'fk_merchants_sample_dataset'),
  'SELECT 1',
  'ALTER TABLE merchants ADD CONSTRAINT fk_merchants_sample_dataset FOREIGN KEY (sample_dataset_key) REFERENCES sample_datasets(dataset_key) ON DELETE RESTRICT'
);
PREPARE task3_stmt FROM @task3_sql; EXECUTE task3_stmt; DEALLOCATE PREPARE task3_stmt;

SET @task3_sql = IF(
  EXISTS(SELECT 1 FROM information_schema.table_constraints
         WHERE constraint_schema = DATABASE() AND table_name = 'merchants'
           AND constraint_name = 'chk_merchants_task3_coordinates'),
  'SELECT 1',
  'ALTER TABLE merchants ADD CONSTRAINT chk_merchants_task3_coordinates CHECK ((latitude IS NULL AND longitude IS NULL) OR (latitude BETWEEN -90 AND 90 AND longitude BETWEEN -180 AND 180))'
);
PREPARE task3_stmt FROM @task3_sql; EXECUTE task3_stmt; DEALLOCATE PREPARE task3_stmt;

CREATE TABLE IF NOT EXISTS merchant_opening_hours (
    dataset_key VARCHAR(64) NOT NULL,
    merchant_id VARCHAR(64) NOT NULL,
    iso_weekday TINYINT UNSIGNED NOT NULL,
    interval_no TINYINT UNSIGNED NOT NULL DEFAULT 1,
    opens_at TIME NOT NULL,
    closes_at TIME NOT NULL,
    PRIMARY KEY (dataset_key, merchant_id, iso_weekday, interval_no),
    CONSTRAINT fk_opening_dataset FOREIGN KEY (dataset_key)
      REFERENCES sample_datasets(dataset_key) ON DELETE RESTRICT,
    CONSTRAINT fk_opening_merchant FOREIGN KEY (merchant_id)
      REFERENCES merchants(merchant_id) ON DELETE RESTRICT,
    CONSTRAINT chk_opening_weekday CHECK (iso_weekday BETWEEN 1 AND 7),
    CONSTRAINT chk_opening_interval CHECK (closes_at > opens_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS merchant_sample_activity (
    dataset_key VARCHAR(64) NOT NULL,
    merchant_id VARCHAR(64) NOT NULL,
    observation_date DATE NOT NULL,
    slot_start TIME NOT NULL,
    slot_minutes SMALLINT UNSIGNED NOT NULL,
    observation_status ENUM('OBSERVED', 'MISSING', 'CLOSED') NOT NULL,
    transaction_count INT UNSIGNED NULL,
    PRIMARY KEY (dataset_key, merchant_id, observation_date, slot_start),
    CONSTRAINT fk_sample_activity_dataset FOREIGN KEY (dataset_key)
      REFERENCES sample_datasets(dataset_key) ON DELETE RESTRICT,
    CONSTRAINT fk_sample_activity_merchant FOREIGN KEY (merchant_id)
      REFERENCES merchants(merchant_id) ON DELETE RESTRICT,
    CONSTRAINT chk_sample_activity_slot CHECK (slot_minutes > 0),
    CONSTRAINT chk_sample_activity_count_state CHECK (
      (observation_status = 'OBSERVED' AND transaction_count IS NOT NULL)
      OR (observation_status IN ('MISSING', 'CLOSED') AND transaction_count IS NULL)
    )
) ENGINE=InnoDB;

SET @task3_sql = NULL;
