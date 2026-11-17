-- Jolene Step 4: additive durable rejection feedback.
-- Run after the application's existing schema migrations. This DDL is rerunnable, but MySQL DDL
-- auto-commits and is not fully rollbackable. The application migration account needs ALTER,
-- CREATE, INDEX and routine PREPARE/EXECUTE privileges for this schema.

CREATE TABLE IF NOT EXISTS rejection_feedback (
  feedback_id INT NOT NULL AUTO_INCREMENT,
  user_id VARCHAR(32) NOT NULL,
  merchant_id VARCHAR(64) NOT NULL,
  reason ENUM('too-expensive','too-far','ate-recently','not-in-mood') NOT NULL,
  category VARCHAR(64) NULL,
  price DECIMAL(6,2) NULL,
  distance_minutes INT NULL,
  cuisine_tags TEXT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  submission_token CHAR(36) NULL,
  distance_metres INT UNSIGNED NULL,
  rejected_at_sg DATETIME NULL,
  PRIMARY KEY (feedback_id),
  KEY idx_rejection_user (user_id, feedback_id),
  UNIQUE KEY uq_rejection_user_token (user_id, submission_token),
  KEY idx_rejection_user_sg_time (user_id, rejected_at_sg, feedback_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET @schema_name = DATABASE();

SET @ddl = IF((SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = @schema_name AND table_name = 'rejection_feedback' AND column_name = 'submission_token') = 0,
  'ALTER TABLE rejection_feedback ADD COLUMN submission_token CHAR(36) NULL AFTER cuisine_tags', 'DO 0');
PREPARE step4_stmt FROM @ddl; EXECUTE step4_stmt; DEALLOCATE PREPARE step4_stmt;

SET @ddl = IF((SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = @schema_name AND table_name = 'rejection_feedback' AND column_name = 'distance_metres') = 0,
  'ALTER TABLE rejection_feedback ADD COLUMN distance_metres INT UNSIGNED NULL AFTER distance_minutes', 'DO 0');
PREPARE step4_stmt FROM @ddl; EXECUTE step4_stmt; DEALLOCATE PREPARE step4_stmt;

SET @ddl = IF((SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = @schema_name AND table_name = 'rejection_feedback' AND column_name = 'rejected_at_sg') = 0,
  'ALTER TABLE rejection_feedback ADD COLUMN rejected_at_sg DATETIME NULL AFTER submission_token', 'DO 0');
PREPARE step4_stmt FROM @ddl; EXECUTE step4_stmt; DEALLOCATE PREPARE step4_stmt;

SET @ddl = IF((SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = @schema_name AND table_name = 'rejection_feedback' AND index_name = 'uq_rejection_user_token') = 0,
  'ALTER TABLE rejection_feedback ADD UNIQUE KEY uq_rejection_user_token (user_id, submission_token)', 'DO 0');
PREPARE step4_stmt FROM @ddl; EXECUTE step4_stmt; DEALLOCATE PREPARE step4_stmt;

SET @ddl = IF((SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = @schema_name AND table_name = 'rejection_feedback' AND index_name = 'idx_rejection_user_sg_time') = 0,
  'ALTER TABLE rejection_feedback ADD KEY idx_rejection_user_sg_time (user_id, rejected_at_sg, feedback_id)', 'DO 0');
PREPARE step4_stmt FROM @ddl; EXECUTE step4_stmt; DEALLOCATE PREPARE step4_stmt;
