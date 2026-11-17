-- GENERATED FILE: scripts/render-task7-menu-migration.cjs. Do not edit by hand.
-- Task 7 additive migration: grounded sample menu tables (task7-menu-v1).
-- Review only. Run after migrations 003 and 004. MySQL DDL auto-commits and is not fully rollbackable: take a backup and
-- rehearse on a disposable MySQL 8 database first (docs/task7-mysql-rehearsal.md). It is rerunnable.
-- It creates the two new tables when absent. When a table already exists it VALIDATES (engine, collation, columns,
-- primary key, indexes, foreign keys, named CHECK constraints) and aborts before any change on any mismatch.
-- It never drops, renames or alters an existing table and writes no rows. Database/db.sql is not involved.

USE NetsVouch;

DELIMITER //
DROP PROCEDURE IF EXISTS task7_menu_migrate//
CREATE PROCEDURE task7_menu_migrate()
BEGIN
  DECLARE v_count INT DEFAULT 0;
  DECLARE v_charset VARCHAR(64);
  DECLARE v_collation VARCHAR(64);
  DECLARE v_actual TEXT;

  SELECT COUNT(*) INTO v_count FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name IN ('merchants', 'sample_datasets');
  IF v_count <> 2 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Task 7 menu migration prerequisite missing: merchants and sample_datasets (run migration 003)';
  END IF;
  SELECT COUNT(*) INTO v_count FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'merchants' AND column_name = 'sample_dataset_key';
  IF v_count <> 1 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Task 7 menu migration prerequisite missing: merchants.sample_dataset_key (run migration 003)';
  END IF;
  SELECT COUNT(*) INTO v_count FROM sample_datasets WHERE dataset_key = 'nets-vouch-task3-v1';
  IF v_count <> 1 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Task 7 menu migration prerequisite missing: sample dataset nets-vouch-task3-v1 (run the Task 3 seed)';
  END IF;
  SELECT character_set_name, collation_name INTO v_charset, v_collation FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'merchants' AND column_name = 'merchant_id';

  SELECT COUNT(*) INTO v_count FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'merchant_menu_items';
  IF v_count = 0 THEN
    SET @task7_sql = CONCAT('CREATE TABLE merchant_menu_items (
  item_id varchar(96) NOT NULL,
  merchant_id varchar(64) NOT NULL,
  item_slug varchar(64) NOT NULL,
  item_name varchar(100) NOT NULL,
  price decimal(6,2) NOT NULL,
  is_vegetarian tinyint(1) NULL,
  is_vegan tinyint(1) NULL,
  is_halal tinyint(1) NULL,
  availability enum(''AVAILABLE'',''UNAVAILABLE'') NOT NULL DEFAULT ''AVAILABLE'',
  dietary_claim_status varchar(24) NOT NULL DEFAULT ''sample-unverified'',
  is_sample_data tinyint(1) NOT NULL DEFAULT 1,
  dataset_key varchar(64) NOT NULL,
  menu_version varchar(32) NOT NULL,
  sort_order smallint unsigned NOT NULL DEFAULT 0,
  PRIMARY KEY (item_id),
  UNIQUE KEY uq_menu_merchant_slug (merchant_id, item_slug),
  KEY idx_menu_merchant_available (merchant_id, availability, sort_order),
  KEY idx_menu_dataset (dataset_key),
  CONSTRAINT fk_menu_merchant FOREIGN KEY (merchant_id) REFERENCES merchants (merchant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_menu_dataset FOREIGN KEY (dataset_key) REFERENCES sample_datasets (dataset_key) ON DELETE RESTRICT,
  CONSTRAINT chk_menu_price CHECK (price > 0),
  CONSTRAINT chk_menu_vegan_implies_vegetarian CHECK (is_vegan IS NULL OR is_vegan = 0 OR is_vegetarian <=> 1),
  CONSTRAINT chk_menu_flag_values CHECK ((is_vegetarian IS NULL OR is_vegetarian IN (0,1)) AND (is_vegan IS NULL OR is_vegan IN (0,1)) AND (is_halal IS NULL OR is_halal IN (0,1))),
  CONSTRAINT chk_menu_claim CHECK (BINARY dietary_claim_status = BINARY ''sample-unverified''),
  CONSTRAINT chk_menu_sample CHECK (is_sample_data = 1),
  CONSTRAINT chk_menu_item_id CHECK (BINARY item_id = BINARY CONCAT(merchant_id, ''--'', item_slug)),
  CONSTRAINT chk_menu_slug CHECK (REGEXP_LIKE(item_slug, ''^[a-z0-9]+(-[a-z0-9]+)*$'', ''c'')),
  CONSTRAINT chk_menu_ownership_format CHECK (REGEXP_LIKE(merchant_id, ''^[a-z0-9]+(-[a-z0-9]+)*$'', ''c'') AND REGEXP_LIKE(dataset_key, ''^[a-z0-9]+(-[a-z0-9]+)*$'', ''c'') AND REGEXP_LIKE(menu_version, ''^[a-z0-9]+(-[a-z0-9]+)*$'', ''c''))
) ENGINE=InnoDB DEFAULT CHARSET=', v_charset, ' COLLATE=', v_collation);
    PREPARE task7_stmt FROM @task7_sql; EXECUTE task7_stmt; DEALLOCATE PREPARE task7_stmt;
  ELSE
    SELECT COUNT(*) INTO v_count FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'merchant_menu_items' AND engine = 'InnoDB' AND table_collation = v_collation;
    IF v_count <> 1 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Task 7 menu migration: existing merchant_menu_items has an incompatible engine or collation; nothing was changed';
    END IF;
    SELECT GROUP_CONCAT(CONCAT(column_name, ':', column_type, ':', is_nullable, ':', IFNULL(column_default, 'NULL')) ORDER BY ordinal_position SEPARATOR '|') INTO v_actual FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'merchant_menu_items';
    IF v_actual IS NULL OR v_actual <> 'item_id:varchar(96):NO:NULL|merchant_id:varchar(64):NO:NULL|item_slug:varchar(64):NO:NULL|item_name:varchar(100):NO:NULL|price:decimal(6,2):NO:NULL|is_vegetarian:tinyint(1):YES:NULL|is_vegan:tinyint(1):YES:NULL|is_halal:tinyint(1):YES:NULL|availability:enum(''AVAILABLE'',''UNAVAILABLE''):NO:AVAILABLE|dietary_claim_status:varchar(24):NO:sample-unverified|is_sample_data:tinyint(1):NO:1|dataset_key:varchar(64):NO:NULL|menu_version:varchar(32):NO:NULL|sort_order:smallint unsigned:NO:0' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Task 7 menu migration: existing merchant_menu_items has an incompatible column definition; nothing was changed';
    END IF;
    SELECT GROUP_CONCAT(CONCAT(index_name, ':', non_unique, ':', seq_in_index, ':', column_name) ORDER BY LOWER(index_name), seq_in_index SEPARATOR '|') INTO v_actual FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'merchant_menu_items';
    IF v_actual IS NULL OR v_actual <> 'idx_menu_dataset:1:1:dataset_key|idx_menu_merchant_available:1:1:merchant_id|idx_menu_merchant_available:1:2:availability|idx_menu_merchant_available:1:3:sort_order|PRIMARY:0:1:item_id|uq_menu_merchant_slug:0:1:merchant_id|uq_menu_merchant_slug:0:2:item_slug' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Task 7 menu migration: existing merchant_menu_items has an incompatible primary key or index; nothing was changed';
    END IF;
    SELECT GROUP_CONCAT(CONCAT(k.constraint_name, ':', k.column_name, ':', k.referenced_table_name, ':', k.referenced_column_name, ':', r.delete_rule) ORDER BY LOWER(k.constraint_name), k.ordinal_position SEPARATOR '|') INTO v_actual FROM information_schema.key_column_usage k JOIN information_schema.referential_constraints r ON r.constraint_schema = k.table_schema AND r.constraint_name = k.constraint_name AND r.table_name = k.table_name WHERE k.table_schema = DATABASE() AND k.table_name = 'merchant_menu_items' AND k.referenced_table_name IS NOT NULL;
    IF v_actual IS NULL OR v_actual <> 'fk_menu_dataset:dataset_key:sample_datasets:dataset_key:RESTRICT|fk_menu_merchant:merchant_id:merchants:merchant_id:RESTRICT' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Task 7 menu migration: existing merchant_menu_items has an incompatible foreign key; nothing was changed';
    END IF;
    SELECT GROUP_CONCAT(constraint_name ORDER BY LOWER(constraint_name) SEPARATOR '|') INTO v_actual FROM information_schema.table_constraints WHERE table_schema = DATABASE() AND table_name = 'merchant_menu_items' AND constraint_type = 'CHECK' AND enforced = 'YES';
    IF v_actual IS NULL OR v_actual <> 'chk_menu_claim|chk_menu_flag_values|chk_menu_item_id|chk_menu_ownership_format|chk_menu_price|chk_menu_sample|chk_menu_slug|chk_menu_vegan_implies_vegetarian' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Task 7 menu migration: existing merchant_menu_items has an incompatible CHECK constraint; nothing was changed';
    END IF;
  END IF;

  SELECT COUNT(*) INTO v_count FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'merchant_menu_item_terms';
  IF v_count = 0 THEN
    SET @task7_sql = CONCAT('CREATE TABLE merchant_menu_item_terms (
  item_id varchar(96) NOT NULL,
  term_kind enum(''category'',''tag'') NOT NULL,
  term varchar(40) NOT NULL,
  PRIMARY KEY (item_id, term_kind, term),
  KEY idx_menu_terms_lookup (term_kind, term),
  CONSTRAINT fk_menu_terms_item FOREIGN KEY (item_id) REFERENCES merchant_menu_items (item_id) ON DELETE RESTRICT,
  CONSTRAINT chk_menu_term_format CHECK (REGEXP_LIKE(term, ''^[a-z0-9]+(-[a-z0-9]+)*$'', ''c'')),
  CONSTRAINT chk_menu_term_category CHECK (term_kind = ''tag'' OR BINARY term IN (''rice'',''noodles'',''healthy-bowls'',''indian'',''wraps'',''soup'',''bread''))
) ENGINE=InnoDB DEFAULT CHARSET=', v_charset, ' COLLATE=', v_collation);
    PREPARE task7_stmt FROM @task7_sql; EXECUTE task7_stmt; DEALLOCATE PREPARE task7_stmt;
  ELSE
    SELECT COUNT(*) INTO v_count FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'merchant_menu_item_terms' AND engine = 'InnoDB' AND table_collation = v_collation;
    IF v_count <> 1 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Task 7 menu migration: existing merchant_menu_item_terms has an incompatible engine or collation; nothing was changed';
    END IF;
    SELECT GROUP_CONCAT(CONCAT(column_name, ':', column_type, ':', is_nullable, ':', IFNULL(column_default, 'NULL')) ORDER BY ordinal_position SEPARATOR '|') INTO v_actual FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'merchant_menu_item_terms';
    IF v_actual IS NULL OR v_actual <> 'item_id:varchar(96):NO:NULL|term_kind:enum(''category'',''tag''):NO:NULL|term:varchar(40):NO:NULL' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Task 7 menu migration: existing merchant_menu_item_terms has an incompatible column definition; nothing was changed';
    END IF;
    SELECT GROUP_CONCAT(CONCAT(index_name, ':', non_unique, ':', seq_in_index, ':', column_name) ORDER BY LOWER(index_name), seq_in_index SEPARATOR '|') INTO v_actual FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'merchant_menu_item_terms';
    IF v_actual IS NULL OR v_actual <> 'idx_menu_terms_lookup:1:1:term_kind|idx_menu_terms_lookup:1:2:term|PRIMARY:0:1:item_id|PRIMARY:0:2:term_kind|PRIMARY:0:3:term' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Task 7 menu migration: existing merchant_menu_item_terms has an incompatible primary key or index; nothing was changed';
    END IF;
    SELECT GROUP_CONCAT(CONCAT(k.constraint_name, ':', k.column_name, ':', k.referenced_table_name, ':', k.referenced_column_name, ':', r.delete_rule) ORDER BY LOWER(k.constraint_name), k.ordinal_position SEPARATOR '|') INTO v_actual FROM information_schema.key_column_usage k JOIN information_schema.referential_constraints r ON r.constraint_schema = k.table_schema AND r.constraint_name = k.constraint_name AND r.table_name = k.table_name WHERE k.table_schema = DATABASE() AND k.table_name = 'merchant_menu_item_terms' AND k.referenced_table_name IS NOT NULL;
    IF v_actual IS NULL OR v_actual <> 'fk_menu_terms_item:item_id:merchant_menu_items:item_id:RESTRICT' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Task 7 menu migration: existing merchant_menu_item_terms has an incompatible foreign key; nothing was changed';
    END IF;
    SELECT GROUP_CONCAT(constraint_name ORDER BY LOWER(constraint_name) SEPARATOR '|') INTO v_actual FROM information_schema.table_constraints WHERE table_schema = DATABASE() AND table_name = 'merchant_menu_item_terms' AND constraint_type = 'CHECK' AND enforced = 'YES';
    IF v_actual IS NULL OR v_actual <> 'chk_menu_term_category|chk_menu_term_format' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Task 7 menu migration: existing merchant_menu_item_terms has an incompatible CHECK constraint; nothing was changed';
    END IF;
  END IF;
END//
CALL task7_menu_migrate()//
DROP PROCEDURE task7_menu_migrate//
DELIMITER ;
