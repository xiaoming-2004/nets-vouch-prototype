const { database: db, counters } = require('./helpers/test-isolation.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ejs = require('ejs');
const { merchants: task3Merchants } = require('../sample-data/nets-vouch-task3.cjs');
const definition = require('../sample-data/nets-vouch-task7-menu.cjs');
const vocabulary = require('../food-vocabulary');
const menu = require('../merchant-menu');
const migration = require('../scripts/render-task7-menu-migration.cjs');
const seed = require('../scripts/render-task7-menu-seed.cjs');
const { start } = require('./helpers/visitor.cjs');
const { seedTask3Merchants, seedMenu } = require('./helpers/task7-menu-fixtures.cjs');

const ROOT = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');

let http;
test.before(async () => { http = await start(); });
test.beforeEach(() => { seedTask3Merchants(db); seedMenu(db); });
test.after(async () => {
  await http.close();
  assert.deepEqual(counters, { envLoads: 0, privateReads: 0, mysqlFactories: 0, redisFactories: 0, blockedConnections: 0 });
});

// ---------------------------------------------------------------------------
// Shared sample definition
// ---------------------------------------------------------------------------
test('the shared fictional menu definition is valid, covers every chip, and keeps merchants unchanged', () => {
  const summary = definition.validateDefinition();
  assert.deepEqual(summary, { items: 33, merchants: 10, coverage: { rice: 7, noodles: 6, 'healthy-bowls': 3, indian: 2, wraps: 3 }, terms: 119 });
  assert.equal(definition.items.filter(item => item.tags.includes('light')).length, 12);
  assert.equal(definition.MENU.claimStatus, 'sample-unverified');
  assert.deepEqual(menu.EXPECTED, { datasetKey: definition.MENU.datasetKey, menuVersion: definition.MENU.menuVersion, claimStatus: definition.MENU.claimStatus });
  assert.equal(definition.MENU.datasetKey, 'nets-vouch-task3-v1');
  // Halal, vegetarian and vegan appear only where the merchant declares support.
  const byId = new Map(task3Merchants.map(m => [m.merchantId, m]));
  definition.items.forEach(item => {
    const merchant = byId.get(item.merchantId);
    if (item.halal) assert.equal(merchant.dietaryHalal, true, item.slug);
    if (item.vegetarian) assert.ok(merchant.dietaryVegetarian || merchant.dietaryVegan, item.slug);
    if (item.vegan) { assert.equal(merchant.dietaryVegan, true, item.slug); assert.equal(item.vegetarian, true); }
  });
  // The ten merchants are not modified by this definition (it only reads them).
  assert.equal(task3Merchants.length, 10);
  assert.deepEqual(definition.joinRows().map(row => row.dataset_key).filter((v, i, a) => a.indexOf(v) === i), ['nets-vouch-task3-v1']);
});

test('the definition validator rejects every unsafe change', () => {
  const copy = () => definition.items.map(item => ({ ...item, categories: item.categories.slice(), tags: item.tags.slice() }));
  const mutate = (change) => { const list = copy(); change(list); return list; };
  const must = (list, pattern, merchants) => assert.throws(() => definition.validateDefinition(merchants, list), pattern);
  const find = (list, slug) => list.find(item => item.slug === slug);
  must(mutate(l => { find(l, 'tokyo-express-bento') ; l.push({ ...find(l, 'cold-soba-set'), slug: 'halal-soba', name: 'Halal Soba', halal: true }); }), /halal item at non-halal merchant/);
  must(mutate(l => { find(l, 'wanton-noodle').vegetarian = true; }), /vegetarian item at unsupported merchant/);
  must(mutate(l => { find(l, 'dhal-roti-prata-set').vegan = true; }), /vegan item at unsupported merchant/);
  must(mutate(l => { find(l, 'tofu-quinoa-bowl').vegetarian = null; }), /vegan without vegetarian/);
  must(mutate(l => { find(l, 'tofu-quinoa-bowl').tags.push('lobster'); }), /bad tag lobster/);
  must(mutate(l => { find(l, 'tofu-quinoa-bowl').categories.push('pizza'); }), /bad category pizza/);
  must(mutate(l => { find(l, 'tofu-quinoa-bowl').price = '0.00'; }), /bad price/);
  must(mutate(l => { find(l, 'tofu-quinoa-bowl').price = '7.5'; }), /bad price/);
  must(mutate(l => { find(l, 'tofu-quinoa-bowl').slug = 'Bad_Slug'; }), /bad slug/);
  must(mutate(l => { l.push({ ...find(l, 'mee-siam') }); }), /duplicate item/);
  must(mutate(l => { find(l, 'tofu-quinoa-bowl').categories = []; }), /no category/);
  must(mutate(l => { l.push({ ...find(l, 'mee-siam'), merchantId: 'ghost' }); }), /unknown merchant ghost/);
  must(mutate(l => l.splice(0, l.length, ...l.filter(i => i.merchantId !== 'spice-lane' && i.merchantId !== 'kopi-toast-corner'))), /category indian covers fewer than two merchants/);
  must(mutate(l => l.splice(0, l.length, ...l.filter(i => !i.tags.includes('light')))), /no explicit light tag/);
  must(mutate(l => l.splice(0, l.length, ...l.filter(i => i.merchantId !== 'woodlands-noodle-bar'))), /merchant without menu woodlands-noodle-bar/);
  must(mutate(l => l.splice(0, l.length, ...l.filter(i => !i.halal || i.merchantId !== 'northside-wraps'))), /halal merchant without halal item northside-wraps/);
  must(mutate(l => l.splice(0, l.length, ...l.filter(i => !(i.merchantId === 'zen-none' || (i.merchantId === 'vegan-zen-kitchen' && i.vegan))))), /vegan merchant without vegan item/);
  const noHalal = task3Merchants.map(m => m.merchantId === 'felicia-chicken-rice' ? { ...m, dietaryHalal: false } : m);
  must(copy(), /halal item at non-halal merchant/, noHalal);
});

// ---------------------------------------------------------------------------
// Generated migration and seed
// ---------------------------------------------------------------------------
test('the migration and seed are deterministic generated files that are additive and safeguarded', () => {
  const migrationText = read('Database/migrations/005_task7_menu_items.sql');
  const seedText = read('Database/seeds/005_task7_menu_data.sql');
  assert.equal(migration.render(), migrationText, 'migration matches its generator');
  assert.equal(seed.render(), seedText, 'seed matches its generator');
  assert.equal(migration.render(), migration.render());
  assert.equal(seed.render(), seed.render());
  assert.match(migrationText, /^-- GENERATED FILE: scripts\/render-task7-menu-migration\.cjs/);
  assert.match(seedText, /^-- GENERATED FILE: scripts\/render-task7-menu-seed\.cjs/);

  for (const [name, text] of [['migration', migrationText], ['seed', seedText]]) {
    assert.equal(/\b(DROP\s+TABLE|DROP\s+DATABASE|ALTER\s+TABLE|TRUNCATE|DELETE\s+FROM|UPDATE\s+\w+\s+SET|RENAME\s+TABLE)\b/i.test(text), false, name);
    assert.equal(/\bdb\.sql\b/.test(text.replace(/--[^\n]*/g, '')), false, name + ' never executes db.sql');
    assert.equal(/\b(users|transactions|merchant_activity_slots|merchant_sample_activity|rejection_feedback|campaign)\b/i.test(text.replace(/--[^\n]*/g, '')), false, name + ' never touches other tables');
    assert.match(text, /\nUSE NetsVouch;\n/);
  }
  // Migration: prerequisites, collation-matched creation, and validation of every element of an existing table.
  assert.match(migrationText, /prerequisite missing: merchants and sample_datasets \(run migration 003\)/);
  assert.match(migrationText, /prerequisite missing: sample dataset nets-vouch-task3-v1/);
  assert.match(migrationText, /DEFAULT CHARSET=', v_charset, ' COLLATE=', v_collation/);
  for (const table of ['merchant_menu_items', 'merchant_menu_item_terms']) {
    for (const element of ['engine or collation', 'column definition', 'primary key or index', 'foreign key', 'CHECK constraint']) {
      assert.match(migrationText, new RegExp('existing ' + table + ' has an incompatible ' + element + '; nothing was changed'));
    }
  }
  Object.entries(definition.TABLES).forEach(([name, spec]) => {
    const create = migration.createStatement(name, spec);
    spec.checks.forEach(([checkName]) => assert.ok(create.includes('CONSTRAINT ' + checkName + ' CHECK')));
    spec.foreignKeys.forEach(fk => assert.ok(create.includes('CONSTRAINT ' + fk.name + ' FOREIGN KEY') && create.includes('ON DELETE RESTRICT')));
    const sig = migration.signatures(spec);
    spec.columns.forEach(([column]) => assert.ok(sig.columns.includes(column + ':')));
    spec.checks.forEach(([checkName]) => assert.ok(sig.checks.includes(checkName)));
  });
  assert.ok(migrationText.includes("CONSTRAINT chk_menu_item_id CHECK (BINARY item_id = BINARY CONCAT(merchant_id, ''--'', item_slug))"));
  assert.ok(migrationText.includes("CONSTRAINT chk_menu_claim CHECK (BINARY dietary_claim_status = BINARY ''sample-unverified'')"));
  // Seed: single transaction with full rollback, staged validation, ownership and collision safeguards.
  assert.equal((seedText.match(/START TRANSACTION;/g) || []).length, 1);
  assert.equal((seedText.match(/COMMIT;/g) || []).length, 1);
  assert.match(seedText, /DECLARE EXIT HANDLER FOR SQLEXCEPTION\s+BEGIN\s+ROLLBACK;\s+RESIGNAL;/);
  assert.ok(seedText.indexOf('START TRANSACTION;') < seedText.indexOf('INSERT INTO merchant_menu_items'));
  for (const message of ['unexpected cardinality', 'migration 005 has not been installed', 'missing or is not an owned sample merchant',
    'dietary flag exceeds what its merchant supports', 'collides with a non-owned or differing item', 'missing from the definition (use a new menu version)',
    'category/tag rows missing from the definition', 'post-install counts differ', 'no qualifying sample item']) {
    assert.ok(seedText.includes(message), message);
  }
  const permanentWrites = (seedText.match(/INSERT INTO (\w+)/g) || []).map(line => line.replace('INSERT INTO ', ''));
  assert.deepEqual([...new Set(permanentWrites)].sort(), ['merchant_menu_item_terms', 'merchant_menu_items', 'tmp_task7_items', 'tmp_task7_terms']);
  assert.ok(seedText.includes('WHERE NOT EXISTS (SELECT 1 FROM merchant_menu_items e WHERE e.item_id = t.item_id);'), 'item insert is idempotent');
  assert.ok(seedText.includes('WHERE NOT EXISTS (SELECT 1 FROM merchant_menu_item_terms e WHERE e.item_id = t.item_id AND e.term_kind = t.term_kind AND e.term = t.term);'), 'term insert is idempotent');
  assert.ok(seedText.includes('<> 33 OR') && seedText.includes('<> 119 THEN'));
  const stagedItems = seedText.split('INSERT INTO tmp_task7_items')[1].split(';')[0].match(/^\('/gm).length;
  const stagedTerms = seedText.split('INSERT INTO tmp_task7_terms')[1].split(';')[0].match(/^\('/gm).length;
  assert.deepEqual([stagedItems, stagedTerms], [33, 119]);
  definition.items.forEach(item => assert.ok(seedText.includes("'" + definition.itemId(item) + "'")));
  assert.ok(seedText.includes("'sample-unverified'"));
  // Nothing installs anything automatically: no application code references the SQL files.
  assert.equal(/Database\/(migrations|seeds)\/005/.test(read('app.js') + read('merchant-menu.js')), false);
});

test('the rehearsal procedure is documented and was not executed', () => {
  const doc = read('docs/task7-mysql-rehearsal.md');
  for (const phrase of ['uniquely named', 'restricted user', 'never execute `Database/db.sql`', 'minimal required baseline', 'rerun',
    'identical fingerprint', 'collision', 'rollback', 'sentinel', 'clean up', 'separate approval']) {
    assert.ok(doc.toLowerCase().includes(phrase.toLowerCase()), phrase);
  }
  assert.equal(/netsvouch`? (database )?(is|will be) (used|modified)/i.test(doc), false);
});

// ---------------------------------------------------------------------------
// Vocabulary, normaliser and aliases
// ---------------------------------------------------------------------------
test('the food vocabulary is fixed, approved and deterministic', () => {
  assert.deepEqual(vocabulary.FOOD_CHOICES.map(c => c.label), ['Anything', 'Rice dishes', 'Noodles', 'Healthy bowls', 'Indian food', 'Wraps']);
  assert.deepEqual(vocabulary.FOOD_CATEGORIES, ['any', 'rice', 'noodles', 'healthy-bowls', 'indian', 'wraps']);
  assert.equal(new Set(vocabulary.MENU_TAGS).size, vocabulary.MENU_TAGS.length);
  vocabulary.MENU_TAGS.concat(vocabulary.MENU_CATEGORIES).forEach(term => assert.match(term, /^[a-z0-9]+(-[a-z0-9]+)*$/));
  const n = vocabulary.normalisePhrase;
  assert.equal(n('Noodles'), 'noodle');
  assert.equal(n('WRAPS'), 'wrap');
  assert.equal(n('Healthy-Bowls'), 'healthy bowl');
  assert.equal(n('bee-hoon'), n('Bee  Hoon'));
  assert.equal(n('Café'), 'cafe');
  assert.equal(n('  chicken   rice '), 'chicken rice');
  assert.equal(n('hummus'), 'hummus');
  assert.equal(n('dishes'), 'dish');
  assert.equal(n('curries'), 'curry');
  assert.equal(n('class'), 'class');
  assert.equal(n(''), '');
  assert.equal(n(null), '');
  // Reviewed aliases (exactly the approved starter list), applied once, and only to stored vocabulary.
  assert.deepEqual(Object.keys(vocabulary.ALIASES).sort(), ['ayam', 'biriyani', 'biryani', 'briani', 'canai', 'beehoon', 'kabab', 'paratha', 'roti canai'].sort());
  const stored = new Set(vocabulary.MENU_TAGS.concat(vocabulary.MENU_CATEGORIES).map(n));
  Object.entries(vocabulary.ALIASES).forEach(([key, target]) => {
    assert.ok(stored.has(n(target)), key + ' -> ' + target + ' must be a stored term');
    assert.notEqual(n(key), n(target));
  });
  assert.equal(vocabulary.canonicalPhrase('Ayam'), 'chicken');
  assert.equal(vocabulary.canonicalPhrase('biryani'), 'briyani');
  assert.equal(vocabulary.canonicalPhrase('Roti Canai'), 'prata');
  assert.equal(vocabulary.canonicalPhrase('beehoon'), 'bee hoon');
  assert.equal(vocabulary.canonicalPhrase('kabab'), 'kebab');
  assert.equal(vocabulary.canonicalPhrase('noodles'), 'noodle');
  assert.equal(vocabulary.canonicalPhrase('chicken rice'), 'chicken rice');
  assert.equal(vocabulary.canonicalPhrase('chickn rice'), 'chickn rice', 'no fuzzy matching');
  // The legacy cuisine mapping.
  assert.deepEqual(vocabulary.LEGACY_CUISINE_TO_FOOD, { any: 'any', rice: 'rice', noodles: 'noodles', pasta: null, soup: 'soup', bread: 'bread' });
  // Negation windows.
  const negated = text => [...vocabulary.negatedTokens(text)].sort();
  assert.deepEqual(negated('no rice please'), ['please', 'rice'].sort());
  assert.ok(negated('chicken without noodles').includes('noodle'));
  assert.ok(negated('gluten free noodles').includes('gluten'));
  assert.ok(!negated('rice and noodles').includes('rice'));
  assert.ok(negated('not vegan').includes('vegan'));
  assert.ok(negated('non vegetarian').includes('vegetarian'));
});

// ---------------------------------------------------------------------------
// Loader and matcher units
// ---------------------------------------------------------------------------
function rowsFor(items) {
  const rows = [];
  items.forEach(item => {
    const base = { item_id: item.merchant + '--' + item.slug, merchant_id: item.merchant, item_slug: item.slug, item_name: item.name,
      price: item.price, is_vegetarian: item.v ? 1 : null, is_vegan: item.vg ? 1 : null, is_halal: item.h ? 1 : null,
      availability: 'AVAILABLE', dietary_claim_status: 'sample-unverified', is_sample_data: 1, dataset_key: 'nets-vouch-task3-v1',
      menu_version: 'task7-menu-v1', sort_order: item.order || 1 };
    item.categories.forEach(term => rows.push({ ...base, term_kind: 'category', term }));
    (item.tags || []).forEach(term => rows.push({ ...base, term_kind: 'tag', term }));
  });
  return rows;
}
const caps = (halal, vegetarian, vegan) => ({ halal, vegetarian, vegan });
async function load(items, merchantCaps) {
  const merchants = Object.entries(merchantCaps).map(([id, c]) => ({ id, dietaryCapabilities: c }));
  const database = { calls: [], async execute(sql, params) { this.calls.push({ sql, params }); return [rowsFor(items), []]; } };
  const result = await menu.loadMenu(database, merchants);
  return { menu: result, database };
}

test('the matcher is exact, deterministic and never matches inside words', async () => {
  const { menu: m } = await load([
    { merchant: 'a', slug: 'chicken-rice', name: 'Hainan Chicken Rice', price: '5.00', categories: ['rice'], tags: ['chicken', 'chicken-rice'], h: true },
    { merchant: 'a', slug: 'drumstick-rice', name: 'Chicken Drumstick Rice', price: '4.00', categories: ['rice'], tags: ['chicken'], h: true, order: 2 },
    { merchant: 'a', slug: 'priced-dish', name: 'Pricey Dish', price: '3.00', categories: ['bread'], tags: ['toast'], order: 3 },
    { merchant: 'b', slug: 'wrapper', name: 'Wrapper Special', price: '6.00', categories: ['wraps'], tags: [] }
  ], { a: caps(true, false, false), b: caps(false, false, false) });
  const items = m.get('a');
  const rice = vocabulary.canonicalPhrase('rice');
  assert.equal(menu.termTier(items[0], 'chicken rice'), 3, 'exact tag/name phrase');
  assert.equal(menu.termTier(items[1], 'chicken rice'), 2, 'every word covered by stored terms');
  assert.equal(menu.termTier(items[0], 'chicken'), 3);
  assert.equal(menu.termTier(items[2], 'ice'), 0, '"ice" is not inside "rice" or "pricey"');
  assert.equal(menu.termTier(items[2], rice), 0);
  assert.equal(menu.termTier(m.get('b')[0], 'wrap'), 3, 'category wraps');
  assert.equal(menu.termTier(m.get('b')[0], 'rap'), 0);
  assert.equal(menu.termTier(items[0], 'chicken noodle'), 0);
  assert.equal(menu.termTier(items[0], ''), 0);
  // Best item: highest tier, then lower price, then item id.
  const requirement = { category: null, terms: [{ raw: 'chicken rice', phrase: 'chicken rice' }] };
  const best = menu.matchMerchant(items, requirement, { budget: 10, dietary: 'none' });
  assert.equal(best.item.name, 'Hainan Chicken Rice');
  assert.equal(best.tier, 3);
  const tokensOnly = menu.matchMerchant([items[1]], requirement, { budget: 10, dietary: 'none' });
  assert.equal(tokensOnly.tier, 2);
  assert.equal(menu.toRecommendedItem(tokensOnly, requirement).matchBasis, 'tokens');
  assert.ok(menu.tierBonus(best) > menu.tierBonus(tokensOnly));
  // Category plus term is an AND over the same item; a category-only match is the weakest.
  assert.equal(menu.matchMerchant(items, { category: 'bread', terms: [{ raw: 'chicken', phrase: 'chicken' }] }, { budget: 10, dietary: 'none' }), null);
  const categoryOnly = menu.matchMerchant(items, { category: 'rice', terms: [] }, { budget: 10, dietary: 'none' });
  assert.equal(categoryOnly.item.name, 'Chicken Drumstick Rice', 'the cheaper qualifying item wins');
  assert.equal(menu.toRecommendedItem(categoryOnly, { category: 'rice', terms: [] }).matchBasis, 'category');
  // The exact item price must fit the budget.
  assert.equal(menu.matchMerchant(items, requirement, { budget: 4.5, dietary: 'none' }).item.name, 'Chicken Drumstick Rice');
  assert.equal(menu.matchMerchant(items, requirement, { budget: 3, dietary: 'none' }), null);
  // Terms: known anywhere, deduplicated, aliased; unknown ones are reported, not guessed.
  const classified = menu.classifyTerms(m, ['Chicken Rice', 'chicken  rice', 'ayam', 'pizza', 'ice']);
  assert.deepEqual(classified.applied.map(t => t.phrase), ['chicken rice', 'chicken']);
  assert.deepEqual(classified.unsupported, ['pizza', 'ice']);
  assert.equal(menu.classifyTerms(m, []).applied.length, 0);
});

test('item-level dietary truth: merchant flags mean "supports", vegan satisfies vegetarian only', async () => {
  const { menu: m } = await load([
    { merchant: 'halal-shop', slug: 'flagged', name: 'Flagged Rice', price: '5.00', categories: ['rice'], h: true },
    { merchant: 'halal-shop', slug: 'unflagged', name: 'Unflagged Noodle', price: '4.00', categories: ['noodles'], order: 2 },
    { merchant: 'green', slug: 'vegetarian-bowl', name: 'Cheese Bowl', price: '6.00', categories: ['healthy-bowls'], v: true },
    { merchant: 'green', slug: 'vegan-bowl', name: 'Vegan Bowl', price: '7.00', categories: ['healthy-bowls'], v: true, vg: true, order: 2 },
    { merchant: 'green', slug: 'plain-bowl', name: 'Plain Bowl', price: '3.00', categories: ['healthy-bowls'], order: 3 }
  ], { 'halal-shop': caps(true, false, false), green: caps(false, true, true) });
  const ctx = dietary => ({ budget: 20, dietary });
  const need = category => ({ category, terms: [] });
  // Halal needs the item's own explicit claim even at a halal-declaring merchant.
  assert.equal(menu.matchMerchant(m.get('halal-shop'), need('rice'), ctx('halal')).item.name, 'Flagged Rice');
  assert.equal(menu.matchMerchant(m.get('halal-shop'), need('noodles'), ctx('halal')), null);
  assert.equal(menu.matchMerchant(m.get('halal-shop'), need('noodles'), ctx('none')).item.name, 'Unflagged Noodle');
  // A vegetarian/vegan-supporting merchant does not make every item vegetarian or vegan.
  assert.equal(menu.matchMerchant(m.get('green'), need('healthy-bowls'), ctx('vegetarian')).item.name, 'Cheese Bowl');
  assert.equal(menu.matchMerchant(m.get('green'), need('healthy-bowls'), ctx('vegan')).item.name, 'Vegan Bowl');
  assert.equal(menu.matchMerchant(m.get('green'), need('healthy-bowls'), ctx('none')).item.name, 'Plain Bowl');
  assert.equal(menu.itemSatisfiesDiet({ vegetarian: false, vegan: true, halal: false }, 'vegetarian'), true);
  assert.equal(menu.itemSatisfiesDiet({ vegetarian: true, vegan: false, halal: false }, 'vegan'), false);
  assert.equal(menu.itemSatisfiesDiet({ vegetarian: true, vegan: true, halal: false }, 'halal'), false);
  // Category wording alone never proves a diet: no flag, no match.
  assert.equal(menu.matchMerchant(m.get('green'), need('healthy-bowls'), ctx('halal')), null);
});

test('the loader reads once, fails closed and never exposes detail', async () => {
  const items = [{ merchant: 'a', slug: 'x', name: 'X', price: '1.00', categories: ['rice'] }];
  const { database } = await load(items, { a: caps(false, false, false) });
  assert.equal(database.calls.length, 1);
  assert.equal(database.calls[0].params.length, 1);
  assert.equal(menu.buildMenuSelect(3).match(/\?/g).length, 3);
  assert.throws(() => menu.buildMenuSelect(0), error => error instanceof menu.MenuCatalogueError);
  assert.throws(() => menu.buildMenuSelect(201), error => error instanceof menu.MenuCatalogueError);
  const failing = { async execute() { throw new Error('private connection string detail'); } };
  await assert.rejects(menu.loadMenu(failing, [{ id: 'a', dietaryCapabilities: caps(false, false, false) }]),
    error => error.code === 'menu-catalogue-unavailable' && error.message === 'menu-catalogue-unavailable' && !/private/.test(error.message));
  await assert.rejects(menu.loadMenu({ async execute() { return [{ not: 'an array' }, []]; } }, [{ id: 'a', dietaryCapabilities: caps(false, false, false) }]), menu.MenuCatalogueError);
  await assert.rejects(menu.loadMenu(failing, []), menu.MenuCatalogueError);
});

// ---------------------------------------------------------------------------
// Functional chips: markup, state machine, safe rendering
// ---------------------------------------------------------------------------
const script = read('public/js/script.js');

test('Home renders six food chips, four dietary chips and one Find my match action accessibly', async () => {
  const home = (await http.visitor().request('/home')).html;
  const form = home.slice(home.indexOf('data-nl-form'), home.indexOf('</form>', home.indexOf('data-nl-form')));
  const food = form.slice(form.indexOf('data-chip-group="food"'), form.indexOf('data-chip-group="dietary"'));
  const labels = group => [...group.matchAll(/<button type="button" class="chip" data-chip-value="([^"]+)" aria-pressed="(true|false)">([^<]+)<\/button>/g)];
  const foodChips = labels(food);
  assert.deepEqual(foodChips.map(m => m[3]), ['Anything', 'Rice dishes', 'Noodles', 'Healthy bowls', 'Indian food', 'Wraps']);
  assert.deepEqual(foodChips.map(m => m[1]), ['any', 'rice', 'noodles', 'healthy-bowls', 'indian', 'wraps']);
  assert.deepEqual(foodChips.map(m => m[2]), ['true', 'false', 'false', 'false', 'false', 'false']);
  const dietChips = labels(form.slice(form.indexOf('data-chip-group="dietary"')));
  assert.deepEqual(dietChips.map(m => m[3]), ['No dietary restriction', 'Halal', 'Vegetarian', 'Vegan']);
  assert.deepEqual(dietChips.map(m => m[1]), ['none', 'halal', 'vegetarian', 'vegan']);
  assert.deepEqual(dietChips.map(m => m[2]), ['true', 'false', 'false', 'false']);
  assert.match(form, /role="group" aria-labelledby="food-chip-title" data-chip-group="food" data-chip-default="any"/);
  assert.match(form, /role="group" aria-labelledby="diet-chip-title" data-chip-group="dietary" data-chip-default="none"/);
  assert.match(form, /id="food-chip-title"/);
  assert.equal((form.match(/type="submit"/g) || []).length, 1);
  assert.match(form, /<button class="button" type="submit" data-nl-submit>Find my match<\/button>/);
  assert.match(form, /<label for="nl-text">What are you craving\?<\/label>/);
  assert.match(form, /your saved profile is not changed/);
  assert.equal(/<%-/.test(fs.readFileSync(path.join(ROOT, 'views/home.ejs'), 'utf8').slice(fs.readFileSync(path.join(ROOT, 'views/home.ejs'), 'utf8').indexOf('data-chip-group="food"'), fs.readFileSync(path.join(ROOT, 'views/home.ejs'), 'utf8').indexOf('data-nl-submit'))), false);
  // The saved dietary preference is the highlighted, untouched default.
  const v = http.visitor();
  await v.request('/home');
  await v.change(demo => { demo.profile.dietaryPreference = 'halal'; });
  const halalHome = (await v.request('/home')).html;
  assert.match(halalHome, /data-chip-group="dietary" data-chip-default="halal"/);
  assert.match(halalHome, /data-chip-value="halal" aria-pressed="true"/);
  assert.match(halalHome, /data-chip-value="none" aria-pressed="false"/);
  assert.equal((await v.state()).demo.profile.dietaryPreference, 'halal');
});

test('chip styling meets the touch, keyboard and state requirements', () => {
  const css = read('public/css/style.css');
  const rule = selector => { const m = css.match(new RegExp('(?:^|\\n)' + selector.replace(/[.[\]":()]/g, '\\$&') + '\\s*\\{([^}]*)\\}')); assert.ok(m, selector); return m[1]; };
  assert.match(rule('.chip'), /min-height:\s*44px/);
  assert.match(rule('.chip-grid--food'), /grid-template-columns:\s*repeat\(3,/);
  assert.match(rule('.chip-grid--diet'), /grid-template-columns:\s*repeat\(2,/);
  assert.match(rule('.chip[aria-pressed="true"]'), /background/);
  assert.match(rule('.chip:focus-visible'), /outline:\s*3px solid/);
  assert.match(rule('.chip:disabled'), /cursor:\s*not-allowed/);
  assert.match(css, /\.chip-group\[aria-busy="true"\]/);
  assert.match(css, /@media \(max-width:340px\) \{ \.chip-grid--food \{ grid-template-columns:repeat\(3,/);
});

function chipSandbox(defaults) {
  const makeButton = value => {
    const button = { attrs: { 'data-chip-value': value }, disabled: false, classes: new Set() };
    button.getAttribute = name => button.attrs[name];
    button.setAttribute = (name, v) => { button.attrs[name] = String(v); };
    button.classList = { toggle: (name, on) => { if (on) button.classes.add(name); else button.classes.delete(name); } };
    return button;
  };
  const makeGroup = (name, fallback, values) => {
    const group = { attrs: { 'data-chip-group': name, 'data-chip-default': fallback }, buttons: values.map(makeButton), handlers: [] };
    group.getAttribute = key => group.attrs[key];
    group.setAttribute = (key, v) => { group.attrs[key] = String(v); };
    group.querySelectorAll = () => group.buttons;
    group.addEventListener = (type, handler) => group.handlers.push(handler);
    return group;
  };
  const food = makeGroup('food', 'any', ['any', 'rice', 'noodles', 'healthy-bowls', 'indian', 'wraps']);
  const diet = makeGroup('dietary', defaults.dietary || 'none', ['none', 'halal', 'vegetarian', 'vegan']);
  const context = vm.createContext({ document: { querySelectorAll: () => [food, diet] }, URLSearchParams, Array, Object });
  const source = script.slice(script.indexOf('const chipState = (function() {'), script.indexOf("document.addEventListener('click', function(event) {\n  if (event.target.closest && event.target.closest('[data-clear-food]'))"));
  vm.runInContext(source + '\nthis.chipState = chipState;', context);
  const press = (group, value) => group.handlers[0]({ target: { closest: () => group.buttons.find(b => b.getAttribute('data-chip-value') === value) } });
  const pressed = group => group.buttons.filter(b => b.getAttribute('aria-pressed') === 'true').map(b => b.getAttribute('data-chip-value'));
  return { chips: context.chipState, food, diet, press, pressed };
}

test('chip state machine: untouched defaults are shown but never sent; active choices are', () => {
  const { chips, food, diet, press, pressed } = chipSandbox({ dietary: 'none' });
  const plain = target => JSON.parse(JSON.stringify(target));
  assert.deepEqual(plain(chips.params({})), {});
  assert.deepEqual(pressed(food), ['any']);
  assert.deepEqual(pressed(diet), ['none']);
  assert.ok(food.buttons[0].classes.has('is-default'));
  press(food, 'any'); press(diet, 'none');
  assert.deepEqual(plain(chips.params({})), {}, 'pressing the shown default changes nothing');
  press(food, 'rice');
  assert.deepEqual(plain(chips.params({})), { foodCategory: 'rice' });
  assert.deepEqual(pressed(food), ['rice']);
  assert.equal(food.buttons[1].classes.has('is-default'), false);
  press(food, 'rice');
  assert.deepEqual(plain(chips.params({})), {}, 'tapping the active chip returns to the untouched default');
  assert.deepEqual(pressed(food), ['any']);
  press(food, 'noodles'); press(food, 'any');
  assert.deepEqual(plain(chips.params({})), { foodCategory: 'any' }, 'choosing Anything after another choice is an explicit override');
  press(diet, 'vegan');
  const query = chips.params(new URLSearchParams('diningDate=2026-11-17'));
  assert.equal(query.get('foodCategory'), 'any');
  assert.equal(query.get('dietaryPreference'), 'vegan');
  chips.setBusy(true);
  assert.ok(food.buttons.concat(diet.buttons).every(b => b.disabled));
  assert.equal(food.getAttribute('aria-busy'), 'true');
  press(food, 'wraps');
  assert.equal(plain(chips.params({})).foodCategory, 'any', 'a disabled chip ignores taps while a request is running');
  chips.setBusy(false);
  assert.ok(food.buttons.every(b => !b.disabled));
  chips.clearFood();
  assert.equal(plain(chips.params({})).foodCategory, undefined);
});

test('the saved dietary preference is the untouched default chip', () => {
  const { chips, diet, press, pressed } = chipSandbox({ dietary: 'halal' });
  assert.deepEqual(pressed(diet), ['halal']);
  assert.deepEqual(JSON.parse(JSON.stringify(chips.params({}))), {});
  press(diet, 'none');
  assert.deepEqual(JSON.parse(JSON.stringify(chips.params({}))), { dietaryPreference: 'none' }, 'No restriction over a saved Halal is an explicit override');
  press(diet, 'none');
  assert.deepEqual(JSON.parse(JSON.stringify(chips.params({}))), {});
  assert.deepEqual(pressed(diet), ['halal']);
});

test('Find my match sends the chips with every route and keeps all text escaped', () => {
  assert.match(script, /chipState\.params\(query\);\s*return '\?' \+ query\.toString\(\);/);
  assert.match(script, /body: JSON\.stringify\(originModule\.withLocation\(Object\.assign\(\{ text: text \}, chipState\.params\(\{\}\)\)\)\)/);
  assert.match(script, /diningDate: parts\.diningDate, diningTime: parts\.diningTime \}, chipState\.params\(\{\}\)\)\) \}\);/);
  assert.match(script, /if \(!text\) \{[^}]*await loadMatch\(false\);/);
  const section = script.slice(script.indexOf('const chipState = (function() {'), script.indexOf("if (nlForm) nlForm.addEventListener('submit'"));
  assert.equal(/localStorage|sessionStorage|document\.cookie|indexedDB|console\.|innerHTML/.test(section), false);

  const sandbox = { String, Number, Array, Math, Object, URL, URLSearchParams };
  vm.createContext(sandbox);
  vm.runInContext(script.slice(script.indexOf('function escHtml('), script.indexOf('async function loadMatch(')) +
    '\nthis.api = { renderRecCard, renderRecommendationList };', sandbox);
  const card = sandbox.api.renderRecCard({ id: 'x', merchantName: 'M', price: 5, typicalPrice: 5, source: 'mysql', isSampleData: true,
    distanceLabel: 'near', dietary: [], feedbackToken: 't', usualActivity: null, matchReasons: [], campaign: null,
    recommendedMenuItem: { name: '<img src=x onerror=alert(1)>', price: 6.8, label: 'Fictional <b>sample</b>' } });
  assert.ok(card.includes('Recommended: &lt;img src=x onerror=alert(1)&gt; · <strong>$6.80</strong>'));
  assert.ok(card.includes('Typical merchant price $5.00'));
  assert.equal(/<img|<b>/.test(card), false);
  const empty = sandbox.api.renderRecommendationList([], { source: 'mysql', status: 'ok' }, { request: { foodCategory: 'indian' } });
  assert.match(empty, /data-clear-food>Clear food choice<\/button>/);
  assert.equal(/Clear food choice/.test(sandbox.api.renderRecommendationList([], { source: 'mysql', status: 'ok' }, { request: {} })), false);
  assert.match(sandbox.api.renderRecommendationList([], { source: 'mysql', status: 'ok' }, { request: { dishTerms: ['chicken'] } }), /No sample menu item fits/);
});

test('the recommended-item partial states a recommendation, never a purchase, and escapes everything', async () => {
  const html = await ejs.renderFile(path.join(ROOT, 'views/partials/recommended-item.ejs'),
    { item: { name: '<script>alert(1)</script>', price: 6.8, label: 'Fictional sample item · dietary claims unverified' } });
  assert.match(html, /Recommended: &lt;script&gt;alert\(1\)&lt;\/script&gt; · \$6\.80/);
  assert.match(html, /Fictional sample item · dietary claims unverified\. This is a recommendation, not a record of what you bought\./);
  assert.equal(/<script>/.test(html), false);
  assert.equal(/purchased|bought it|you ordered/i.test(html.replace('not a record of what you bought', '')), false);
});

// ---------------------------------------------------------------------------
// Regression: MySQL auto-creates an index named after a foreign key that has no supporting index. The
// rehearsal found that fk_menu_dataset did exactly that, so the migration could not accept its own schema.
// ---------------------------------------------------------------------------
test('every foreign key has an explicit supporting index, so MySQL creates no unexpected one', () => {
  const migrationText = read('Database/migrations/005_task7_menu_items.sql');
  const spec = definition.TABLES.merchant_menu_items;
  assert.ok(spec.indexes.some(ix => ix.name === 'idx_menu_dataset' && !ix.unique && ix.columns.join() === 'dataset_key'));
  // A fresh migration creates the explicit index (in the CREATE TABLE, before the constraints).
  const create = migration.createStatement('merchant_menu_items', spec);
  assert.ok(create.includes('KEY idx_menu_dataset (dataset_key)'));
  assert.ok(create.indexOf('KEY idx_menu_dataset (dataset_key)') < create.indexOf('CONSTRAINT fk_menu_dataset'));
  assert.ok(migrationText.includes('  KEY idx_menu_dataset (dataset_key),\n'));
  // Rule MySQL applies: a foreign key needs an index whose leading columns are the key's columns.
  Object.entries(definition.TABLES).forEach(([name, table]) => {
    const candidates = [{ name: 'PRIMARY', columns: table.primaryKey }].concat(table.indexes);
    table.foreignKeys.forEach(fk => {
      const supporting = candidates.filter(ix => fk.columns.every((column, i) => ix.columns[i] === column));
      assert.ok(supporting.length >= 1, name + '.' + fk.name + ' has no supporting index and MySQL would create one');
    });
  });
  // The dataset key foreign key is supported by the explicit index (and by no other).
  const datasetFk = spec.foreignKeys.find(fk => fk.name === 'fk_menu_dataset');
  assert.deepEqual(spec.indexes.filter(ix => ix.columns[0] === datasetFk.columns[0]).map(ix => ix.name), ['idx_menu_dataset']);
  // The index names MySQL would report for the created table are exactly those the migration expects on rerun:
  // PRIMARY plus every declared index, and nothing named after a constraint.
  const expected = migration.signatures(spec).indexes.split('|').map(entry => entry.split(':')[0]);
  const declared = ['PRIMARY'].concat(spec.indexes.map(ix => ix.name));
  assert.deepEqual([...new Set(expected)].sort(), declared.slice().sort());
  assert.ok(!expected.some(indexName => /^fk_/.test(indexName)), 'no implicit foreign-key index is expected or tolerated');
  assert.ok(migrationText.includes("'idx_menu_dataset:1:1:dataset_key|idx_menu_merchant_available:1:1:merchant_id"));
  // Rerun validation compares the same signature that the creation produces, whatever order the spec lists indexes in.
  const shuffled = { ...spec, indexes: spec.indexes.slice().reverse() };
  assert.equal(migration.signatures(shuffled).indexes, migration.signatures(spec).indexes);
  const rotated = { ...spec, indexes: spec.indexes.slice(1).concat(spec.indexes.slice(0, 1)) };
  assert.equal(migration.signatures(rotated).indexes, migration.signatures(spec).indexes);
  // The terms table's foreign key is supported by the leading column of its primary key.
  assert.deepEqual(definition.TABLES.merchant_menu_item_terms.foreignKeys[0].columns, ['item_id']);
  assert.equal(definition.TABLES.merchant_menu_item_terms.primaryKey[0], 'item_id');
  // The committed migration is still exactly the generator's output.
  assert.equal(migration.render(), migrationText);
});

// ---------------------------------------------------------------------------
// Regression: SQL three-valued logic. A CHECK that evaluates to NULL PASSES, so every CHECK that touches a nullable
// column must be TRUE or FALSE for every NULL/0/1 combination, never NULL.
// ---------------------------------------------------------------------------
// A tiny three-valued evaluator for the constraint grammar used on the nullable flag columns:
//   expr := and ('OR' and)* ; and := atom ('AND' atom)* ;
//   atom := '(' expr ')' | col 'IS NULL' | col '=' n | col '<=>' n | col 'IN' '(' n (',' n)* ')'
// Values: true, false, null (UNKNOWN). Anything outside this grammar throws, forcing a new audit.
function evaluateCheck(expression, row) {
  const tokens = expression.match(/<=>|\(|\)|,|=|[A-Za-z_]+|\d+/g);
  let pos = 0;
  const peek = () => tokens[pos]; const take = () => tokens[pos++];
  const OR = (a, b) => (a === true || b === true) ? true : (a === null || b === null) ? null : false;
  const AND = (a, b) => (a === false || b === false) ? false : (a === null || b === null) ? null : true;
  function atom() {
    if (peek() === '(') { take(); const value = expr(); assert.equal(take(), ')'); return value; }
    const column = take();
    assert.ok(Object.prototype.hasOwnProperty.call(row, column), 'unknown column ' + column);
    const value = row[column];
    const operator = take();
    if (operator === 'IS') { assert.equal(take(), 'NULL'); return value === null; }
    if (operator === '=') { const n = Number(take()); return value === null ? null : value === n; }
    if (operator === '<=>') { const n = Number(take()); return value === null ? false : value === n; }
    if (operator === 'IN') {
      assert.equal(take(), '(');
      const list = [Number(take())];
      while (peek() === ',') { take(); list.push(Number(take())); }
      assert.equal(take(), ')');
      return value === null ? null : list.includes(value);
    }
    throw new Error('unsupported operator ' + operator);
  }
  function and() { let value = atom(); while (peek() === 'AND') { take(); value = AND(value, atom()); } return value; }
  function expr() { let value = and(); while (peek() === 'OR') { take(); value = OR(value, and()); } return value; }
  const result = expr();
  assert.equal(pos, tokens.length, 'unparsed tokens in ' + expression);
  return result;
}
// A row is stored when its CHECK result is TRUE or NULL; it is refused only when the result is FALSE.
const accepted = result => result !== false;

test('every CHECK is TRUE or FALSE (never NULL) for every NULL/0/1 combination of its nullable columns', () => {
  const vegan = definition.TABLES.merchant_menu_items.checks.find(c => c[0] === 'chk_menu_vegan_implies_vegetarian')[1];
  assert.equal(vegan, 'is_vegan IS NULL OR is_vegan = 0 OR is_vegetarian <=> 1');
  const check = (veganValue, vegetarianValue) => accepted(evaluateCheck(vegan, { is_vegan: veganValue, is_vegetarian: vegetarianValue }));
  assert.equal(check(null, null), true, 'vegan NULL + vegetarian NULL is allowed');
  assert.equal(check(null, 1), true);
  assert.equal(check(null, 0), true);
  assert.equal(check(0, null), true, 'vegan 0 + vegetarian NULL is allowed');
  assert.equal(check(0, 0), true);
  assert.equal(check(0, 1), true);
  assert.equal(check(1, 1), true, 'vegan 1 + vegetarian 1 is allowed');
  assert.equal(check(1, 0), false, 'vegan 1 + vegetarian 0 is rejected');
  assert.equal(check(1, null), false, 'vegan 1 + vegetarian NULL is rejected (the NULL-passes-CHECK defect)');
  // The old expression demonstrates the defect the null-safe form fixes.
  assert.equal(evaluateCheck('is_vegan IS NULL OR is_vegan = 0 OR is_vegetarian = 1', { is_vegan: 1, is_vegetarian: null }), null);
  assert.equal(accepted(null), true);

  const flags = definition.TABLES.merchant_menu_items.checks.find(c => c[0] === 'chk_menu_flag_values')[1];
  const flagRow = (vegetarian, veganValue, halal) => accepted(evaluateCheck(flags, { is_vegetarian: vegetarian, is_vegan: veganValue, is_halal: halal }));
  [null, 0, 1].forEach(a => [null, 0, 1].forEach(b => [null, 0, 1].forEach(c => assert.equal(flagRow(a, b, c), true, 'NULL/0/1 flags are allowed'))));
  [2, -1, 7].forEach(bad => {
    assert.equal(flagRow(bad, null, null), false);
    assert.equal(flagRow(null, bad, null), false);
    assert.equal(flagRow(null, null, bad), false);
  });

  // Audit of every Task 7 CHECK: a check touching a nullable column must be parseable and never evaluate to NULL.
  Object.entries(definition.TABLES).forEach(([table, spec]) => {
    const nullable = spec.columns.filter(c => c[2]).map(c => c[0]);
    spec.checks.forEach(([name, expression]) => {
      const touched = spec.columns.map(c => c[0]).filter(column => new RegExp(String.raw`\b` + column + String.raw`\b`).test(expression));
      assert.ok(touched.length > 0, name + ' references no column');
      const touchedNullable = touched.filter(column => nullable.includes(column));
      if (!touchedNullable.length) return; // NOT NULL columns can never make the expression NULL
      const row = {};
      touched.forEach(column => { row[column] = 1; });
      const space = touchedNullable.length;
      for (let mask = 0; mask < Math.pow(4, space); mask++) {
        touchedNullable.forEach((column, index) => { row[column] = [null, 0, 1, 2][Math.floor(mask / Math.pow(4, index)) % 4]; });
        assert.notEqual(evaluateCheck(expression, row), null, table + '.' + name + ' evaluates to NULL for ' + JSON.stringify(row));
      }
    });
  });
  // Every other check references only NOT NULL columns, so none of them can evaluate to NULL.
  const notNull = [];
  Object.entries(definition.TABLES).forEach(([table, spec]) => spec.checks.forEach(([name, expression]) => {
    const touched = spec.columns.map(c => c[0]).filter(column => new RegExp(String.raw`\b` + column + String.raw`\b`).test(expression));
    if (touched.every(column => !spec.columns.find(c => c[0] === column)[2])) notNull.push(name);
  }));
  assert.deepEqual(notNull.sort(), ['chk_menu_claim', 'chk_menu_item_id', 'chk_menu_ownership_format', 'chk_menu_price', 'chk_menu_sample', 'chk_menu_slug',
    'chk_menu_term_category', 'chk_menu_term_format']);
  // Intended nullable dietary fields stay nullable (NULL = unspecified).
  const columns = Object.fromEntries(definition.TABLES.merchant_menu_items.columns.map(c => [c[0], c[2]]));
  assert.deepEqual([columns.is_vegetarian, columns.is_vegan, columns.is_halal], [true, true, true]);
  // The generated migration carries both constraints and still equals its renderer byte for byte.
  const migrationText = read('Database/migrations/005_task7_menu_items.sql');
  assert.ok(migrationText.includes('CHECK (is_vegan IS NULL OR is_vegan = 0 OR is_vegetarian <=> 1)'));
  assert.ok(migrationText.includes('chk_menu_flag_values'));
  assert.equal(migration.render(), migrationText);
});

// ---------------------------------------------------------------------------
// Regression: collation-dependent CHECKs. Under a case-insensitive collation `REGEXP '[a-z]'` accepts "Bad" and `=`
// treats "Sample-Unverified" as equal, so identifiers and fixed constants use REGEXP_LIKE(..., 'c') and BINARY.
// ---------------------------------------------------------------------------
test('textual CHECKs are case-sensitive: no collation-dependent operator remains', () => {
  const all = [];
  Object.entries(definition.TABLES).forEach(([table, spec]) => spec.checks.forEach(([name, expression]) => all.push({ table, name, expression })));
  const likes = expression => expression.split('REGEXP_LIKE(').slice(1).map(part => ({
    column: part.slice(0, part.indexOf(',')),
    pattern: part.slice(part.indexOf("'") + 1, part.indexOf("', 'c')")),
    flag: part.slice(part.indexOf("', '") + 4, part.indexOf("')", part.indexOf("', '")))
  }));
  all.forEach(({ name, expression }) => {
    assert.equal(expression.includes(' REGEXP '), false, name + ' uses the collation-dependent REGEXP operator');
    // Plain string equality is allowed only for the ENUM term_kind (MySQL canonicalises ENUM values before a CHECK runs).
    const plain = (expression.match(/[A-Za-z_]+ = '/g) || []);
    if (name === 'chk_menu_term_category') assert.deepEqual(plain, ["term_kind = '"]);
    else assert.deepEqual(plain, [], name + ' compares text with a case-insensitive =');
    likes(expression).forEach(like => assert.equal(like.flag, 'c', name + ' REGEXP_LIKE must use the case-sensitive flag'));
  });
  const byName = Object.fromEntries(all.map(c => [c.name, c.expression]));
  assert.equal(byName.chk_menu_slug, "REGEXP_LIKE(item_slug, '^[a-z0-9]+(-[a-z0-9]+)*$', 'c')");
  assert.equal(byName.chk_menu_term_format, "REGEXP_LIKE(term, '^[a-z0-9]+(-[a-z0-9]+)*$', 'c')");
  assert.equal(byName.chk_menu_item_id, "BINARY item_id = BINARY CONCAT(merchant_id, '--', item_slug)");
  assert.equal(byName.chk_menu_claim, "BINARY dietary_claim_status = BINARY 'sample-unverified'");
  assert.ok(byName.chk_menu_term_category.includes('BINARY term IN ('));
  assert.deepEqual(likes(byName.chk_menu_ownership_format).map(l => l.column), ['merchant_id', 'dataset_key', 'menu_version']);

  // Model of the case-sensitive semantics MySQL applies to these expressions.
  const matches = (column, expression, value) => likes(expression).filter(like => like.column === column)
    .every(like => new RegExp(like.pattern).test(value));
  for (const bad of ['Bad', 'bad_word', 'Spicy', 'RICE', 'a--b', '-a', 'a-', '', ' a', 'a b']) {
    assert.equal(matches('item_slug', byName.chk_menu_slug, bad), false, 'slug ' + bad);
    assert.equal(matches('term', byName.chk_menu_term_format, bad), false, 'term ' + bad);
  }
  for (const good of ['chicken-rice', 'rice', 'healthy-bowls', 'mee-pok', 'a1', 'a-1-b']) {
    assert.equal(matches('item_slug', byName.chk_menu_slug, good), true, 'slug ' + good);
    assert.equal(matches('term', byName.chk_menu_term_format, good), true, 'term ' + good);
  }
  for (const bad of ['Task7-Menu-V1', 'NETS-VOUCH-TASK3-V1', 'task7_menu_v1']) {
    assert.equal(matches('menu_version', byName.chk_menu_ownership_format, bad), false, 'version ' + bad);
    assert.equal(matches('dataset_key', byName.chk_menu_ownership_format, bad), false, 'dataset ' + bad);
  }
  assert.equal(matches('merchant_id', byName.chk_menu_ownership_format, 'GREEN-BOWL'), false);
  for (const good of [definition.MENU.menuVersion, definition.MENU.datasetKey, 'green-bowl', 'felicia-chicken-rice']) {
    ['merchant_id', 'dataset_key', 'menu_version'].forEach(column => assert.equal(matches(column, byName.chk_menu_ownership_format, good), true, column + ' ' + good));
  }
  // BINARY equality is exact: a mixed-case claim status or item identity is not equal.
  const binaryEqual = (a, b) => a === b;
  assert.equal(binaryEqual('Sample-Unverified', 'sample-unverified'), false);
  assert.equal(binaryEqual('sample-unverified', definition.MENU.claimStatus), true);
  assert.equal(binaryEqual('Green-Bowl--mix', 'green-bowl' + '--' + 'mix'), false);
  assert.equal(binaryEqual('green-bowl--mix', 'green-bowl' + '--' + 'mix'), true);
  // Category list: exact spelling.
  const categories = byName.chk_menu_term_category;
  vocabulary.MENU_CATEGORIES.forEach(category => assert.ok(categories.includes("'" + category + "'")));
  assert.equal(categories.includes("'RICE'"), false);
  // ENUM columns are canonicalised by MySQL before CHECK evaluation; this is documented, not redesigned.
  const columns = Object.fromEntries(Object.values(definition.TABLES).flatMap(t => t.columns.map(c => [c[0], c[1]])));
  assert.ok(columns.availability.startsWith('enum(') && columns.term_kind.startsWith('enum('));
  assert.match(read('docs/task7-grounded-menu.md'), /MySQL canonicalises an enum value before any CHECK runs/);
  assert.ok(read('docs/task7-grounded-menu.md').includes("REGEXP_LIKE(..., 'c')"));
  // Generated SQL matches its renderer byte for byte.
  assert.equal(migration.render(), read('Database/migrations/005_task7_menu_items.sql'));
});

test('the loader, seed definition and request validators still enforce the exact lower-case contract', async () => {
  const base = [{ merchant: 'a', slug: 'chicken-rice', name: 'Chicken Rice', price: '5.00', categories: ['rice'], tags: ['chicken', 'chicken-rice'], h: true }];
  const merchants = [{ id: 'a', dietaryCapabilities: caps(true, false, false) }];
  const loadWith = async mutate => {
    const rows = rowsFor(base);
    mutate(rows);
    return menu.loadMenu({ async execute() { return [rows, []]; } }, merchants);
  };
  assert.equal((await loadWith(() => {})).get('a').length, 1, 'valid lower-case values are accepted');
  const rejected = {
    'uppercase slug': rows => rows.forEach(r => { r.item_slug = 'Chicken-Rice'; r.item_id = 'a--Chicken-Rice'; }),
    'uppercase term': rows => { rows[1].term = 'Chicken'; },
    'uppercase category': rows => { rows[0].term = 'RICE'; },
    'mixed-case claim status': rows => rows.forEach(r => { r.dietary_claim_status = 'Sample-Unverified'; }),
    'mixed-case item identity': rows => rows.forEach(r => { r.item_id = 'A--chicken-rice'; }),
    'mixed-case dataset key': rows => rows.forEach(r => { r.dataset_key = 'NETS-VOUCH-TASK3-V1'; }),
    'mixed-case menu version': rows => rows.forEach(r => { r.menu_version = 'Task7-Menu-V1'; }),
    'mixed-case merchant id': rows => rows.forEach(r => { r.merchant_id = 'A'; }),
    'mixed-case term kind': rows => { rows[0].term_kind = 'Category'; },
    'mixed-case availability': rows => rows.forEach(r => { r.availability = 'available'; })
  };
  for (const [label, mutate] of Object.entries(rejected)) {
    await assert.rejects(loadWith(mutate), error => error instanceof menu.MenuCatalogueError, label);
  }
  // The shared definition validator also refuses upper-case identifiers and terms.
  const copy = () => definition.items.map(item => ({ ...item, categories: item.categories.slice(), tags: item.tags.slice() }));
  const slugCase = copy(); slugCase[0].slug = 'Roasted-Chicken-Rice';
  assert.throws(() => definition.validateDefinition(undefined, slugCase), /bad slug/);
  const tagCase = copy(); tagCase[0].tags.push('Chicken');
  assert.throws(() => definition.validateDefinition(undefined, tagCase), /bad tag Chicken/);
  const categoryCase = copy(); categoryCase[0].categories = ['RICE'];
  assert.throws(() => definition.validateDefinition(undefined, categoryCase), /bad category RICE/);
  // Request validators: a foodCategory in the wrong case is refused (the dietary option list is exact too).
  const response = await http.visitor().request('/api/recommend?foodCategory=Rice&dietaryPreference=Halal');
  assert.equal(response.status, 400);
  assert.deepEqual(JSON.parse(response.html).error.fields, { foodCategory: 'unsupported-value', dietaryPreference: 'unsupported-value' });
});
