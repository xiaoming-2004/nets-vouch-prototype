'use strict';

// Renders Database/migrations/005_task7_menu_items.sql deterministically from the table specification in
// sample-data/nets-vouch-task7-menu.cjs, so the DDL and the compatibility checks cannot drift apart.
//   node scripts/render-task7-menu-migration.cjs           print to stdout
//   node scripts/render-task7-menu-migration.cjs --write   write the committed file
//   node scripts/render-task7-menu-migration.cjs --check   exit 1 if the committed file differs
// This script never connects to a database.

const fs = require('node:fs');
const path = require('node:path');
const { TABLES, MENU } = require('../sample-data/nets-vouch-task7-menu.cjs');

const TARGET = path.join(__dirname, '..', 'Database', 'migrations', '005_task7_menu_items.sql');

function lit(text) { return "'" + String(text).replaceAll("'", "''") + "'"; }

function columnDdl([name, type, nullable, def]) {
  let text = '  ' + name + ' ' + type + (nullable ? ' NULL' : ' NOT NULL');
  if (def !== null) text += ' DEFAULT ' + (/^\d+$/.test(def) ? def : lit(def));
  return text;
}

function createStatement(name, spec) {
  const lines = spec.columns.map(columnDdl);
  lines.push('  PRIMARY KEY (' + spec.primaryKey.join(', ') + ')');
  spec.indexes.forEach(ix => lines.push('  ' + (ix.unique ? 'UNIQUE KEY ' : 'KEY ') + ix.name + ' (' + ix.columns.join(', ') + ')'));
  spec.foreignKeys.forEach(fk => lines.push('  CONSTRAINT ' + fk.name + ' FOREIGN KEY (' + fk.columns.join(', ') + ') REFERENCES ' +
    fk.refTable + ' (' + fk.refColumns.join(', ') + ') ON DELETE RESTRICT'));
  spec.checks.forEach(([checkName, expression]) => lines.push('  CONSTRAINT ' + checkName + ' CHECK (' + expression + ')'));
  return 'CREATE TABLE ' + name + ' (\n' + lines.join(',\n') + '\n)';
}

const lower = (a, b) => a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0;

function signatures(spec) {
  const columns = spec.columns.map(([n, type, nullable, def]) => [n, type, nullable ? 'YES' : 'NO', def === null ? 'NULL' : def].join(':')).join('|');
  const rows = [];
  spec.primaryKey.forEach((column, i) => rows.push(['PRIMARY', 0, i + 1, column]));
  spec.indexes.forEach(ix => ix.columns.forEach((column, i) => rows.push([ix.name, ix.unique ? 0 : 1, i + 1, column])));
  rows.sort((a, b) => lower(a[0], b[0]) || a[2] - b[2]);
  const indexes = rows.map(r => r.join(':')).join('|');
  const fkRows = [];
  spec.foreignKeys.forEach(fk => fk.columns.forEach((column, i) => fkRows.push([fk.name, i + 1, column, fk.refTable, fk.refColumns[i], 'RESTRICT'])));
  fkRows.sort((a, b) => lower(a[0], b[0]) || a[1] - b[1]);
  const foreignKeys = fkRows.map(r => [r[0], r[2], r[3], r[4], r[5]].join(':')).join('|');
  const checks = spec.checks.map(c => c[0]).sort(lower).join('|');
  return { columns, indexes, foreignKeys, checks };
}

function validateBlock(name, spec) {
  const sig = signatures(spec);
  const where = "table_schema = DATABASE() AND table_name = '" + name + "'";
  const abort = what => "    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = " +
    lit('Task 7 menu migration: existing ' + name + ' has an incompatible ' + what + '; nothing was changed') + ';';
  return [
    "    SELECT COUNT(*) INTO v_count FROM information_schema.tables WHERE " + where + " AND engine = 'InnoDB' AND table_collation = v_collation;",
    '    IF v_count <> 1 THEN', abort('engine or collation'), '    END IF;',
    "    SELECT GROUP_CONCAT(CONCAT(column_name, ':', column_type, ':', is_nullable, ':', IFNULL(column_default, 'NULL')) ORDER BY ordinal_position SEPARATOR '|') INTO v_actual FROM information_schema.columns WHERE " + where + ';',
    '    IF v_actual IS NULL OR v_actual <> ' + lit(sig.columns) + ' THEN', abort('column definition'), '    END IF;',
    "    SELECT GROUP_CONCAT(CONCAT(index_name, ':', non_unique, ':', seq_in_index, ':', column_name) ORDER BY LOWER(index_name), seq_in_index SEPARATOR '|') INTO v_actual FROM information_schema.statistics WHERE " + where + ';',
    '    IF v_actual IS NULL OR v_actual <> ' + lit(sig.indexes) + ' THEN', abort('primary key or index'), '    END IF;',
    "    SELECT GROUP_CONCAT(CONCAT(k.constraint_name, ':', k.column_name, ':', k.referenced_table_name, ':', k.referenced_column_name, ':', r.delete_rule) ORDER BY LOWER(k.constraint_name), k.ordinal_position SEPARATOR '|') INTO v_actual FROM information_schema.key_column_usage k JOIN information_schema.referential_constraints r ON r.constraint_schema = k.table_schema AND r.constraint_name = k.constraint_name AND r.table_name = k.table_name WHERE k.table_schema = DATABASE() AND k.table_name = '" + name + "' AND k.referenced_table_name IS NOT NULL;",
    '    IF v_actual IS NULL OR v_actual <> ' + lit(sig.foreignKeys) + ' THEN', abort('foreign key'), '    END IF;',
    "    SELECT GROUP_CONCAT(constraint_name ORDER BY LOWER(constraint_name) SEPARATOR '|') INTO v_actual FROM information_schema.table_constraints WHERE " + where + " AND constraint_type = 'CHECK' AND enforced = 'YES';",
    '    IF v_actual IS NULL OR v_actual <> ' + lit(sig.checks) + ' THEN', abort('CHECK constraint'), '    END IF;'
  ].join('\n');
}

function tableBlock(name, spec) {
  const create = createStatement(name, spec);
  const concat = "CONCAT(" + lit(create + ' ENGINE=InnoDB DEFAULT CHARSET=') + ", v_charset, " + lit(' COLLATE=') + ', v_collation)';
  return [
    "  SELECT COUNT(*) INTO v_count FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = '" + name + "';",
    '  IF v_count = 0 THEN',
    '    SET @task7_sql = ' + concat + ';',
    '    PREPARE task7_stmt FROM @task7_sql; EXECUTE task7_stmt; DEALLOCATE PREPARE task7_stmt;',
    '  ELSE',
    validateBlock(name, spec),
    '  END IF;'
  ].join('\n');
}

function render() {
  const prerequisite = what => "    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = " + lit('Task 7 menu migration prerequisite missing: ' + what) + ';';
  return [
    '-- GENERATED FILE: scripts/render-task7-menu-migration.cjs. Do not edit by hand.',
    '-- Task 7 additive migration: grounded sample menu tables (' + MENU.menuVersion + ').',
    '-- Review only. Run after migrations 003 and 004. MySQL DDL auto-commits and is not fully rollbackable: take a backup and',
    '-- rehearse on a disposable MySQL 8 database first (docs/task7-mysql-rehearsal.md). It is rerunnable.',
    '-- It creates the two new tables when absent. When a table already exists it VALIDATES (engine, collation, columns,',
    '-- primary key, indexes, foreign keys, named CHECK constraints) and aborts before any change on any mismatch.',
    '-- It never drops, renames or alters an existing table and writes no rows. Database/db.sql is not involved.',
    '',
    'USE NetsVouch;',
    '',
    'DELIMITER //',
    'DROP PROCEDURE IF EXISTS task7_menu_migrate//',
    'CREATE PROCEDURE task7_menu_migrate()',
    'BEGIN',
    '  DECLARE v_count INT DEFAULT 0;',
    '  DECLARE v_charset VARCHAR(64);',
    '  DECLARE v_collation VARCHAR(64);',
    '  DECLARE v_actual TEXT;',
    '',
    "  SELECT COUNT(*) INTO v_count FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name IN ('merchants', 'sample_datasets');",
    '  IF v_count <> 2 THEN', prerequisite('merchants and sample_datasets (run migration 003)'), '  END IF;',
    "  SELECT COUNT(*) INTO v_count FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'merchants' AND column_name = 'sample_dataset_key';",
    '  IF v_count <> 1 THEN', prerequisite('merchants.sample_dataset_key (run migration 003)'), '  END IF;',
    '  SELECT COUNT(*) INTO v_count FROM sample_datasets WHERE dataset_key = ' + lit(MENU.datasetKey) + ';',
    '  IF v_count <> 1 THEN', prerequisite('sample dataset ' + MENU.datasetKey + ' (run the Task 3 seed)'), '  END IF;',
    "  SELECT character_set_name, collation_name INTO v_charset, v_collation FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'merchants' AND column_name = 'merchant_id';",
    '',
    tableBlock('merchant_menu_items', TABLES.merchant_menu_items),
    '',
    tableBlock('merchant_menu_item_terms', TABLES.merchant_menu_item_terms),
    'END//',
    'CALL task7_menu_migrate()//',
    'DROP PROCEDURE task7_menu_migrate//',
    'DELIMITER ;',
    ''
  ].join('\n');
}

if (require.main === module) {
  const text = render();
  if (process.argv.includes('--write')) fs.writeFileSync(TARGET, text, 'utf8');
  else if (process.argv.includes('--check')) {
    const current = fs.existsSync(TARGET) ? fs.readFileSync(TARGET, 'utf8') : '';
    if (current !== text) { console.error('005_task7_menu_items.sql is out of date'); process.exit(1); }
  } else process.stdout.write(text);
}

module.exports = { render, signatures, createStatement, TARGET };
