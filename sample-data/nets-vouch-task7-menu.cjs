'use strict';

// Task 7 fictional sample menu. ONE definition shared by the migration/seed renderers, the application
// loader's expectations and the tests. Every item, price, tag and dietary flag is demonstration data:
// not a real menu, not a participating business, and no dietary claim here is verified certification.

const task3 = require('./nets-vouch-task3.cjs');
const vocabulary = require('../food-vocabulary.js');

const MENU = {
  datasetKey: task3.DATASET.key,
  menuVersion: 'task7-menu-v1',
  claimStatus: 'sample-unverified',
  label: 'Fictional sample menu item; dietary claims are unverified demonstration data',
  disclosure: 'Fictional deterministic sample menu. Items, prices and dietary flags are demonstration data only; ' +
    'they are not a real menu, a merchant participation claim or verified dietary certification.'
};

// flags: V vegetarian, VG vegan (implies vegetarian), H halal. An absent flag means "unspecified".
function item(merchantId, slug, name, price, categories, tags, flags, sortOrder) {
  const set = new Set(String(flags || '').split(' ').filter(Boolean));
  return {
    merchantId, slug, name, price, categories, tags,
    vegetarian: set.has('V') || set.has('VG') ? true : null,
    vegan: set.has('VG') ? true : null,
    halal: set.has('H') ? true : null,
    sortOrder
  };
}

const items = [
  item('felicia-chicken-rice', 'roasted-chicken-rice', 'Roasted Chicken Rice', '5.00', ['rice'], ['chicken', 'chicken-rice'], 'H', 1),
  item('felicia-chicken-rice', 'steamed-chicken-rice', 'Steamed Chicken Rice', '5.00', ['rice'], ['chicken', 'chicken-rice', 'light'], 'H', 2),
  item('felicia-chicken-rice', 'chicken-drumstick-rice', 'Chicken Drumstick Rice', '6.20', ['rice'], ['chicken'], 'H', 3),

  item('green-bowl', 'tofu-quinoa-bowl', 'Tofu Quinoa Bowl', '7.50', ['healthy-bowls'], ['tofu', 'quinoa', 'light'], 'VG', 1),
  item('green-bowl', 'chicken-teriyaki-grain-bowl', 'Chicken Teriyaki Grain Bowl', '8.20', ['healthy-bowls'], ['chicken', 'teriyaki', 'light'], '', 2),
  item('green-bowl', 'hummus-veggie-wrap', 'Hummus Veggie Wrap', '6.80', ['wraps'], ['hummus', 'vegetables', 'light'], 'VG', 3),
  item('green-bowl', 'pumpkin-brown-rice', 'Pumpkin Brown Rice', '6.50', ['rice'], ['pumpkin', 'vegetables'], 'VG', 4),

  item('woodlands-noodle-bar', 'wanton-noodle', 'Wanton Noodle', '6.00', ['noodles'], ['wanton', 'pork'], '', 1),
  item('woodlands-noodle-bar', 'chicken-mee-pok', 'Chicken Mee Pok', '6.00', ['noodles'], ['chicken', 'mee-pok'], '', 2),
  item('woodlands-noodle-bar', 'chicken-noodle-soup', 'Chicken Noodle Soup', '6.50', ['noodles', 'soup'], ['chicken'], '', 3),

  item('northside-wraps', 'chicken-shawarma-wrap', 'Chicken Shawarma Wrap', '6.80', ['wraps'], ['chicken', 'shawarma'], 'H', 1),
  item('northside-wraps', 'beef-kebab-wrap', 'Beef Kebab Wrap', '7.20', ['wraps'], ['beef', 'kebab'], 'H', 2),
  item('northside-wraps', 'grilled-chicken-wrap', 'Grilled Chicken Wrap', '7.00', ['wraps'], ['chicken', 'grilled', 'light'], 'H', 3),

  item('spice-lane', 'chicken-briyani', 'Chicken Briyani', '7.50', ['rice', 'indian'], ['chicken', 'briyani', 'spicy'], 'H', 1),
  item('spice-lane', 'butter-chicken-naan', 'Butter Chicken & Naan', '8.50', ['indian', 'bread'], ['chicken', 'curry', 'naan'], 'H', 2),
  item('spice-lane', 'dhal-roti-prata-set', 'Dhal & Roti Prata Set', '6.50', ['indian', 'bread'], ['dhal', 'prata'], 'V H', 3),
  item('spice-lane', 'vegetable-curry-rice', 'Vegetable Curry Rice', '7.00', ['rice', 'indian'], ['curry', 'vegetables'], 'V H', 4),

  item('makcik-nasi-padang', 'ayam-goreng-rice-set', 'Ayam Goreng Rice Set', '5.50', ['rice'], ['chicken', 'ayam-goreng', 'fried'], 'H', 1),
  item('makcik-nasi-padang', 'beef-rendang-rice', 'Beef Rendang Rice', '6.50', ['rice'], ['beef', 'rendang'], 'H', 2),
  item('makcik-nasi-padang', 'mee-soto', 'Mee Soto', '5.00', ['noodles', 'soup'], ['chicken', 'soto'], 'H', 3),

  item('tokyo-express-bento', 'chicken-teriyaki-donburi', 'Chicken Teriyaki Donburi', '8.90', ['rice'], ['chicken', 'teriyaki', 'donburi'], '', 1),
  item('tokyo-express-bento', 'salmon-poke-bowl', 'Salmon Poke Bowl', '9.50', ['healthy-bowls'], ['salmon', 'fish', 'light'], '', 2),
  item('tokyo-express-bento', 'cold-soba-set', 'Cold Soba Set', '8.50', ['noodles'], ['soba', 'light'], '', 3),

  item('ah-heng-fish-soup', 'sliced-fish-soup-set', 'Sliced Fish Soup Set', '5.20', ['soup', 'rice'], ['fish', 'light', 'clear-soup'], '', 1),
  item('ah-heng-fish-soup', 'fish-soup-bee-hoon', 'Fish Soup Bee Hoon', '5.50', ['noodles', 'soup'], ['fish', 'bee-hoon', 'light'], '', 2),

  item('vegan-zen-kitchen', 'mushroom-rice-bowl', 'Mushroom Rice Bowl', '9.50', ['rice', 'healthy-bowls'], ['mushroom', 'light'], 'VG', 1),
  item('vegan-zen-kitchen', 'vegan-mee-goreng', 'Vegan Mee Goreng', '8.50', ['noodles'], ['vegetables', 'spicy'], 'VG', 2),
  item('vegan-zen-kitchen', 'lettuce-wrap-trio', 'Lettuce Wrap Trio', '9.00', ['wraps'], ['tofu', 'light'], 'VG', 3),
  item('vegan-zen-kitchen', 'vegan-laksa', 'Vegan Laksa', '9.20', ['noodles', 'soup'], ['spicy', 'coconut'], 'VG', 4),

  item('kopi-toast-corner', 'kaya-butter-toast-set', 'Kaya Butter Toast Set', '4.50', ['bread'], ['toast', 'kaya'], 'V H', 1),
  item('kopi-toast-corner', 'soft-boiled-eggs-toast', 'Soft-boiled Eggs & Toast', '4.80', ['bread'], ['egg', 'toast', 'light'], 'V H', 2),
  item('kopi-toast-corner', 'roti-prata-kosong', 'Roti Prata Kosong', '3.50', ['indian', 'bread'], ['prata'], 'V H', 3),
  item('kopi-toast-corner', 'mee-siam', 'Mee Siam', '4.50', ['noodles'], ['spicy'], 'H', 4)
];

function itemId(entry) { return entry.merchantId + '--' + entry.slug; }

// Throws on any violation. `merchants` defaults to the Task 3 definition.
function validateDefinition(merchants, itemList) {
  const list = itemList || items;
  const known = new Map((merchants || task3.merchants).map(m => [m.merchantId, m]));
  const problems = [];
  const seen = new Set();
  const names = new Set();
  const byMerchant = new Map();
  list.forEach(entry => {
    const merchant = known.get(entry.merchantId);
    const id = itemId(entry);
    if (!merchant) { problems.push('unknown merchant ' + entry.merchantId); return; }
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(entry.slug)) problems.push('bad slug ' + id);
    if (id.length > 96) problems.push('item id too long ' + id);
    if (seen.has(id)) problems.push('duplicate item ' + id);
    seen.add(id);
    const nameKey = entry.merchantId + '|' + entry.name.toLowerCase();
    if (names.has(nameKey)) problems.push('duplicate name ' + id);
    names.add(nameKey);
    if (!entry.name || entry.name.length > 100) problems.push('bad name ' + id);
    if (!/^\d{1,4}\.\d{2}$/.test(entry.price) || Number(entry.price) <= 0) problems.push('bad price ' + id);
    if (!entry.categories.length) problems.push('no category ' + id);
    entry.categories.forEach(c => { if (vocabulary.MENU_CATEGORIES.indexOf(c) === -1) problems.push('bad category ' + c + ' ' + id); });
    entry.tags.forEach(t => { if (vocabulary.MENU_TAGS.indexOf(t) === -1) problems.push('bad tag ' + t + ' ' + id); });
    if (new Set(entry.categories).size !== entry.categories.length || new Set(entry.tags).size !== entry.tags.length) {
      problems.push('duplicate term ' + id);
    }
    if (entry.vegan && !entry.vegetarian) problems.push('vegan without vegetarian ' + id);
    if (entry.halal && !merchant.dietaryHalal) problems.push('halal item at non-halal merchant ' + id);
    if (entry.vegetarian && !(merchant.dietaryVegetarian || merchant.dietaryVegan)) problems.push('vegetarian item at unsupported merchant ' + id);
    if (entry.vegan && !merchant.dietaryVegan) problems.push('vegan item at unsupported merchant ' + id);
    if (!byMerchant.has(entry.merchantId)) byMerchant.set(entry.merchantId, []);
    byMerchant.get(entry.merchantId).push(entry);
  });
  known.forEach((merchant, id) => {
    const own = byMerchant.get(id) || [];
    if (!own.length) problems.push('merchant without menu ' + id);
    if (merchant.dietaryHalal && !own.some(e => e.halal)) problems.push('halal merchant without halal item ' + id);
    if (merchant.dietaryVegetarian && !own.some(e => e.vegetarian)) problems.push('vegetarian merchant without vegetarian item ' + id);
    if (merchant.dietaryVegan && !own.some(e => e.vegan)) problems.push('vegan merchant without vegan item ' + id);
  });
  const coverage = {};
  ['rice', 'noodles', 'healthy-bowls', 'indian', 'wraps'].forEach(category => {
    coverage[category] = [...new Set(list.filter(e => e.categories.indexOf(category) !== -1).map(e => e.merchantId))].length;
    if (coverage[category] < 2) problems.push('category ' + category + ' covers fewer than two merchants');
  });
  if (!list.some(e => e.tags.indexOf('light') !== -1)) problems.push('no explicit light tag');
  if (problems.length) throw new Error('Task 7 menu definition invalid: ' + problems.join('; '));
  return { items: list.length, merchants: byMerchant.size, coverage,
    terms: list.reduce((sum, e) => sum + e.categories.length + e.tags.length, 0) };
}

// Rows exactly as the application's batch SELECT returns them (item LEFT JOIN term), for test fixtures.
function joinRows() {
  const rows = [];
  items.forEach(entry => {
    const base = {
      item_id: itemId(entry), merchant_id: entry.merchantId, item_slug: entry.slug, item_name: entry.name,
      price: entry.price, is_vegetarian: entry.vegetarian === null ? null : 1, is_vegan: entry.vegan === null ? null : 1,
      is_halal: entry.halal === null ? null : 1, availability: 'AVAILABLE', dietary_claim_status: MENU.claimStatus,
      is_sample_data: 1, dataset_key: MENU.datasetKey, menu_version: MENU.menuVersion, sort_order: entry.sortOrder
    };
    entry.categories.forEach(term => rows.push({ ...base, term_kind: 'category', term }));
    entry.tags.forEach(term => rows.push({ ...base, term_kind: 'tag', term }));
  });
  return rows;
}

// Structured table specification: the migration renderer builds the CREATE statements AND the
// compatibility checks from this one description, so they cannot drift apart.
const TABLES = {
  merchant_menu_items: {
    columns: [
      ['item_id', 'varchar(96)', false, null], ['merchant_id', 'varchar(64)', false, null],
      ['item_slug', 'varchar(64)', false, null], ['item_name', 'varchar(100)', false, null],
      ['price', 'decimal(6,2)', false, null], ['is_vegetarian', 'tinyint(1)', true, null],
      ['is_vegan', 'tinyint(1)', true, null], ['is_halal', 'tinyint(1)', true, null],
      ['availability', "enum('AVAILABLE','UNAVAILABLE')", false, 'AVAILABLE'],
      ['dietary_claim_status', 'varchar(24)', false, 'sample-unverified'],
      ['is_sample_data', 'tinyint(1)', false, '1'], ['dataset_key', 'varchar(64)', false, null],
      ['menu_version', 'varchar(32)', false, null], ['sort_order', 'smallint unsigned', false, '0']
    ],
    primaryKey: ['item_id'],
    indexes: [
      { name: 'uq_menu_merchant_slug', unique: true, columns: ['merchant_id', 'item_slug'] },
      { name: 'idx_menu_merchant_available', unique: false, columns: ['merchant_id', 'availability', 'sort_order'] },
      // Explicit supporting index for fk_menu_dataset, so MySQL does not auto-create one with the constraint's name.
      { name: 'idx_menu_dataset', unique: false, columns: ['dataset_key'] }
    ],
    foreignKeys: [
      { name: 'fk_menu_merchant', columns: ['merchant_id'], refTable: 'merchants', refColumns: ['merchant_id'] },
      { name: 'fk_menu_dataset', columns: ['dataset_key'], refTable: 'sample_datasets', refColumns: ['dataset_key'] }
    ],
    checks: [
      ['chk_menu_price', 'price > 0'],
      // Null-safe: a CHECK that evaluates to NULL PASSES in SQL, so `is_vegetarian = 1` alone would accept a vegan
      // item whose vegetarian flag is NULL. `<=>` makes that case FALSE. NULL still means "unspecified".
      ['chk_menu_vegan_implies_vegetarian', 'is_vegan IS NULL OR is_vegan = 0 OR is_vegetarian <=> 1'],
      // Flags are NULL (unspecified), 0 or 1, never another number.
      ['chk_menu_flag_values', '(is_vegetarian IS NULL OR is_vegetarian IN (0,1)) AND (is_vegan IS NULL OR is_vegan IN (0,1)) AND (is_halal IS NULL OR is_halal IN (0,1))'],
      // Case matters for identifiers and fixed constants. The column collation is case-insensitive, so plain `=`
      // and REGEXP would accept `Bad` for `[a-z]`; BINARY comparison and REGEXP_LIKE(..., 'c') do not.
      ['chk_menu_claim', "BINARY dietary_claim_status = BINARY 'sample-unverified'"],
      ['chk_menu_sample', 'is_sample_data = 1'],
      ['chk_menu_item_id', "BINARY item_id = BINARY CONCAT(merchant_id, '--', item_slug)"],
      ['chk_menu_slug', "REGEXP_LIKE(item_slug, '^[a-z0-9]+(-[a-z0-9]+)*$', 'c')"],
      // Ownership strings are lower-case words and hyphens, so a differently-cased dataset key (which the
      // case-insensitive foreign key would otherwise match), merchant id or version is refused.
      ['chk_menu_ownership_format', "REGEXP_LIKE(merchant_id, '^[a-z0-9]+(-[a-z0-9]+)*$', 'c') AND REGEXP_LIKE(dataset_key, '^[a-z0-9]+(-[a-z0-9]+)*$', 'c') AND REGEXP_LIKE(menu_version, '^[a-z0-9]+(-[a-z0-9]+)*$', 'c')"]
    ]
  },
  merchant_menu_item_terms: {
    columns: [
      ['item_id', 'varchar(96)', false, null], ['term_kind', "enum('category','tag')", false, null],
      ['term', 'varchar(40)', false, null]
    ],
    primaryKey: ['item_id', 'term_kind', 'term'],
    indexes: [{ name: 'idx_menu_terms_lookup', unique: false, columns: ['term_kind', 'term'] }],
    foreignKeys: [
      { name: 'fk_menu_terms_item', columns: ['item_id'], refTable: 'merchant_menu_items', refColumns: ['item_id'] }
    ],
    checks: [
      ['chk_menu_term_format', "REGEXP_LIKE(term, '^[a-z0-9]+(-[a-z0-9]+)*$', 'c')"],
      ['chk_menu_term_category', "term_kind = 'tag' OR BINARY term IN (" +
        vocabulary.MENU_CATEGORIES.map(c => "'" + c + "'").join(',') + ')']
    ]
  }
};

module.exports = { MENU, items, itemId, validateDefinition, joinRows, TABLES };
