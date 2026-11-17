'use strict';

// Renders Database/seeds/005_task7_menu_data.sql deterministically from sample-data/nets-vouch-task7-menu.cjs.
//   node scripts/render-task7-menu-seed.cjs           print to stdout
//   node scripts/render-task7-menu-seed.cjs --write   write the committed file
//   node scripts/render-task7-menu-seed.cjs --check   exit 1 if the committed file differs
// This script validates the definition and never connects to a database.

const fs = require('node:fs');
const path = require('node:path');
const definition = require('../sample-data/nets-vouch-task7-menu.cjs');

const TARGET = path.join(__dirname, '..', 'Database', 'seeds', '005_task7_menu_data.sql');
const { MENU, items, itemId } = definition;

const lit = text => "'" + String(text).replaceAll("'", "''") + "'";
const flag = value => value === null ? 'NULL' : '1';

function render() {
  const summary = definition.validateDefinition();
  const itemRows = items.map(e => '(' + [lit(itemId(e)), lit(e.merchantId), lit(e.slug), lit(e.name), e.price,
    flag(e.vegetarian), flag(e.vegan), flag(e.halal), e.sortOrder].join(', ') + ')');
  const termRows = [];
  items.forEach(e => {
    e.categories.forEach(term => termRows.push('(' + [lit(itemId(e)), "'category'", lit(term)].join(', ') + ')'));
    e.tags.forEach(term => termRows.push('(' + [lit(itemId(e)), "'tag'", lit(term)].join(', ') + ')'));
  });
  const owner = "dataset_key = " + lit(MENU.datasetKey) + ' AND menu_version = ' + lit(MENU.menuVersion);
  const abort = text => "    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = " + lit('Task 7 menu seed: ' + text) + ';';
  return [
    '-- GENERATED FILE: scripts/render-task7-menu-seed.cjs. Do not edit by hand.',
    '-- Task 7 fictional sample menu (' + MENU.menuVersion + '): ' + summary.items + ' items, ' + summary.terms + ' category/tag rows, ' + summary.merchants + ' merchants.',
    '-- Review only. Run Database/migrations/005_task7_menu_items.sql first (and the Task 3 seed).',
    '-- Stages every expected row in temporary tables, validates ownership and collisions, and only then changes permanent',
    '-- data in ONE transaction that rolls back completely on any failure. An identical rerun changes nothing.',
    '-- It only inserts rows into merchant_menu_items and merchant_menu_item_terms. It never writes merchants, users,',
    '-- transactions, activity, feedback or campaigns, and never deletes. All dietary flags are fictional and unverified.',
    '',
    'USE NetsVouch;',
    '',
    'DROP TEMPORARY TABLE IF EXISTS tmp_task7_terms;',
    'DROP TEMPORARY TABLE IF EXISTS tmp_task7_items;',
    '',
    'CREATE TEMPORARY TABLE tmp_task7_items (',
    '  item_id VARCHAR(96) NOT NULL PRIMARY KEY,',
    '  merchant_id VARCHAR(64) NOT NULL,',
    '  item_slug VARCHAR(64) NOT NULL,',
    '  item_name VARCHAR(100) NOT NULL,',
    '  price DECIMAL(6,2) NOT NULL,',
    '  is_vegetarian TINYINT(1) NULL,',
    '  is_vegan TINYINT(1) NULL,',
    '  is_halal TINYINT(1) NULL,',
    '  sort_order SMALLINT UNSIGNED NOT NULL',
    ');',
    'INSERT INTO tmp_task7_items (item_id, merchant_id, item_slug, item_name, price, is_vegetarian, is_vegan, is_halal, sort_order) VALUES',
    itemRows.join(',\n') + ';',
    '',
    'CREATE TEMPORARY TABLE tmp_task7_terms (',
    '  item_id VARCHAR(96) NOT NULL,',
    "  term_kind ENUM('category','tag') NOT NULL,",
    '  term VARCHAR(40) NOT NULL,',
    '  PRIMARY KEY (item_id, term_kind, term)',
    ');',
    'INSERT INTO tmp_task7_terms (item_id, term_kind, term) VALUES',
    termRows.join(',\n') + ';',
    '',
    'DELIMITER //',
    'DROP PROCEDURE IF EXISTS task7_seed_menu_v1//',
    'CREATE PROCEDURE task7_seed_menu_v1()',
    'BEGIN',
    '  DECLARE EXIT HANDLER FOR SQLEXCEPTION',
    '  BEGIN',
    '    ROLLBACK;',
    '    RESIGNAL;',
    '  END;',
    '',
    '  IF (SELECT COUNT(*) FROM tmp_task7_items) <> ' + summary.items + ' OR (SELECT COUNT(*) FROM tmp_task7_terms) <> ' + summary.terms + ' THEN',
    abort('staged definition has unexpected cardinality'),
    '  END IF;',
    "  IF (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name IN ('merchant_menu_items', 'merchant_menu_item_terms')) <> 2 THEN",
    abort('migration 005 has not been installed'),
    '  END IF;',
    '',
    '  START TRANSACTION;',
    '',
    '  IF EXISTS (SELECT 1 FROM tmp_task7_items t LEFT JOIN merchants m ON m.merchant_id = t.merchant_id',
    '             WHERE m.merchant_id IS NULL OR m.sample_dataset_key IS NULL OR m.sample_dataset_key <> ' + lit(MENU.datasetKey) + ' OR m.is_sample_data <> 1) THEN',
    abort('a merchant is missing or is not an owned sample merchant'),
    '  END IF;',
    '  IF EXISTS (SELECT 1 FROM tmp_task7_items t JOIN merchants m ON m.merchant_id = t.merchant_id',
    '             WHERE (t.is_halal IS NOT NULL AND IFNULL(m.dietary_halal, 0) <> 1)',
    '                OR (t.is_vegetarian IS NOT NULL AND IFNULL(m.dietary_vegetarian, 0) + IFNULL(m.dietary_vegan, 0) = 0)',
    '                OR (t.is_vegan IS NOT NULL AND IFNULL(m.dietary_vegan, 0) <> 1)) THEN',
    abort('an item dietary flag exceeds what its merchant supports'),
    '  END IF;',
    '  IF EXISTS (SELECT 1 FROM merchant_menu_items e JOIN tmp_task7_items t ON t.item_id = e.item_id',
    '             WHERE NOT (e.merchant_id = t.merchant_id AND e.item_slug = t.item_slug AND e.item_name = t.item_name AND e.price = t.price',
    '                        AND e.is_vegetarian <=> t.is_vegetarian AND e.is_vegan <=> t.is_vegan AND e.is_halal <=> t.is_halal',
    '                        AND e.sort_order = t.sort_order AND e.availability = ' + "'AVAILABLE'" + ' AND e.' + owner.replace(' AND menu_version', ' AND e.menu_version') + ')) THEN',
    abort('an item ID collides with a non-owned or differing item'),
    '  END IF;',
    '  IF EXISTS (SELECT 1 FROM merchant_menu_items e LEFT JOIN tmp_task7_items t ON t.item_id = e.item_id',
    '             WHERE e.' + owner.replace(' AND menu_version', ' AND e.menu_version') + ' AND t.item_id IS NULL) THEN',
    abort('the owned menu contains items missing from the definition (use a new menu version)'),
    '  END IF;',
    '  IF EXISTS (SELECT 1 FROM merchant_menu_item_terms e JOIN merchant_menu_items i ON i.item_id = e.item_id',
    '             LEFT JOIN tmp_task7_terms t ON t.item_id = e.item_id AND t.term_kind = e.term_kind AND t.term = e.term',
    '             WHERE i.' + owner.replace(' AND menu_version', ' AND i.menu_version') + ' AND t.item_id IS NULL) THEN',
    abort('an owned item has category/tag rows missing from the definition'),
    '  END IF;',
    '',
    '  INSERT INTO merchant_menu_items (item_id, merchant_id, item_slug, item_name, price, is_vegetarian, is_vegan, is_halal,',
    '                                   availability, dietary_claim_status, is_sample_data, dataset_key, menu_version, sort_order)',
    "  SELECT t.item_id, t.merchant_id, t.item_slug, t.item_name, t.price, t.is_vegetarian, t.is_vegan, t.is_halal,",
    "         'AVAILABLE', " + lit(MENU.claimStatus) + ', 1, ' + lit(MENU.datasetKey) + ', ' + lit(MENU.menuVersion) + ', t.sort_order',
    '    FROM tmp_task7_items t',
    '   WHERE NOT EXISTS (SELECT 1 FROM merchant_menu_items e WHERE e.item_id = t.item_id);',
    '  INSERT INTO merchant_menu_item_terms (item_id, term_kind, term)',
    '  SELECT t.item_id, t.term_kind, t.term',
    '    FROM tmp_task7_terms t',
    '   WHERE NOT EXISTS (SELECT 1 FROM merchant_menu_item_terms e WHERE e.item_id = t.item_id AND e.term_kind = t.term_kind AND e.term = t.term);',
    '',
    '  IF (SELECT COUNT(*) FROM merchant_menu_items WHERE ' + owner + ') <> ' + summary.items + ' OR',
    '     (SELECT COUNT(*) FROM merchant_menu_item_terms e JOIN merchant_menu_items i ON i.item_id = e.item_id WHERE i.' +
      owner.replace(' AND menu_version', ' AND i.menu_version') + ') <> ' + summary.terms + ' THEN',
    abort('post-install counts differ from the definition'),
    '  END IF;',
    '  IF EXISTS (SELECT 1 FROM merchants m WHERE m.sample_dataset_key = ' + lit(MENU.datasetKey) + ' AND',
    '             ((m.dietary_halal = 1 AND NOT EXISTS (SELECT 1 FROM merchant_menu_items i WHERE i.merchant_id = m.merchant_id AND i.is_halal = 1))',
    '           OR (m.dietary_vegetarian = 1 AND NOT EXISTS (SELECT 1 FROM merchant_menu_items i WHERE i.merchant_id = m.merchant_id AND i.is_vegetarian = 1))',
    '           OR (m.dietary_vegan = 1 AND NOT EXISTS (SELECT 1 FROM merchant_menu_items i WHERE i.merchant_id = m.merchant_id AND i.is_vegan = 1)))) THEN',
    abort('a merchant supports a dietary option but has no qualifying sample item'),
    '  END IF;',
    '',
    '  COMMIT;',
    'END//',
    'CALL task7_seed_menu_v1()//',
    'DROP PROCEDURE task7_seed_menu_v1//',
    'DELIMITER ;',
    ''
  ].join('\n');
}

if (require.main === module) {
  const text = render();
  if (process.argv.includes('--write')) fs.writeFileSync(TARGET, text, 'utf8');
  else if (process.argv.includes('--check')) {
    const current = fs.existsSync(TARGET) ? fs.readFileSync(TARGET, 'utf8') : '';
    if (current !== text) { console.error('005_task7_menu_data.sql is out of date'); process.exit(1); }
  } else process.stdout.write(text);
}

module.exports = { render, TARGET };
