'use strict';

// Task 7: read-only grounded menu loader and deterministic matcher.
//
// - ONE parameterised batch SELECT for every catalogue merchant ID; never one query per merchant.
// - Fail closed: if ANY returned row is malformed, cross-merchant, wrongly owned, from another dataset or
//   version, has an invalid item identity, price or term, or claims a dietary flag the merchant does not
//   support, the whole read throws MenuCatalogueError. Nothing is partially trusted or silently dropped.
// - Matching is exact and deterministic over stored item names, approved categories and approved tags only.
//   It can only narrow an already eligible merchant set; it never invents a merchant, item, price or claim.

const vocabulary = require('./food-vocabulary');

const EXPECTED = { datasetKey: 'nets-vouch-task3-v1', menuVersion: 'task7-menu-v1', claimStatus: 'sample-unverified' };
const SAMPLE_LABEL = 'Fictional sample item · dietary claims unverified';

class MenuCatalogueError extends Error {
  constructor(reason) {
    super('menu-catalogue-unavailable');
    this.name = 'MenuCatalogueError';
    this.code = 'menu-catalogue-unavailable';
    // The reason is for tests and diagnostics only. It never contains row content or database detail.
    this.reason = reason;
  }
}

const COLUMNS = 'i.item_id, i.merchant_id, i.item_slug, i.item_name, i.price, i.is_vegetarian, i.is_vegan, i.is_halal, ' +
  'i.availability, i.dietary_claim_status, i.is_sample_data, i.dataset_key, i.menu_version, i.sort_order, ' +
  't.term_kind, t.term';

function buildMenuSelect(count) {
  if (!Number.isInteger(count) || count < 1 || count > 200) throw new MenuCatalogueError('bad-id-count');
  return 'SELECT ' + COLUMNS + ' FROM merchant_menu_items i LEFT JOIN merchant_menu_item_terms t ON t.item_id = i.item_id ' +
    'WHERE i.merchant_id IN (' + new Array(count).fill('?').join(', ') + ") AND i.availability = 'AVAILABLE' " +
    'ORDER BY i.merchant_id, i.sort_order, i.item_id, t.term_kind, t.term';
}

function fail(reason) { throw new MenuCatalogueError(reason); }

function tri(value) {
  if (value === null || value === undefined) return null;
  if (value === 1 || value === true || value === '1') return true;
  if (value === 0 || value === false || value === '0') return false;
  return fail('bad-flag');
}

const ITEM_FIELDS = ['item_id', 'merchant_id', 'item_slug', 'item_name', 'price', 'is_vegetarian', 'is_vegan',
  'is_halal', 'availability', 'dietary_claim_status', 'is_sample_data', 'dataset_key', 'menu_version', 'sort_order'];

function validateItemRow(row, capabilitiesByMerchant) {
  const caps = capabilitiesByMerchant.get(row.merchant_id);
  if (!caps) fail('cross-merchant');
  if (typeof row.item_slug !== 'string' || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(row.item_slug)) fail('bad-slug');
  if (typeof row.item_id !== 'string' || row.item_id !== row.merchant_id + '--' + row.item_slug) fail('bad-item-identity');
  if (typeof row.item_name !== 'string' || !row.item_name.trim() || row.item_name.length > 100) fail('bad-name');
  const priceText = typeof row.price === 'number' ? String(row.price) : row.price;
  if (typeof priceText !== 'string' || !/^\d{1,4}(\.\d{1,2})?$/.test(priceText) || Number(priceText) <= 0) fail('bad-price');
  if (row.availability !== 'AVAILABLE') fail('bad-availability');
  if (row.dietary_claim_status !== EXPECTED.claimStatus) fail('bad-claim-status');
  if (tri(row.is_sample_data) !== true) fail('not-sample');
  if (row.dataset_key !== EXPECTED.datasetKey) fail('bad-dataset');
  if (row.menu_version !== EXPECTED.menuVersion) fail('bad-version');
  if (!Number.isInteger(Number(row.sort_order)) || Number(row.sort_order) < 0) fail('bad-sort');
  const vegetarian = tri(row.is_vegetarian); const vegan = tri(row.is_vegan); const halal = tri(row.is_halal);
  if (vegan === true && vegetarian !== true) fail('vegan-without-vegetarian');
  // A flag may never exceed what the merchant itself supports.
  if (halal === true && caps.halal !== true) fail('halal-exceeds-merchant');
  if (vegetarian === true && !(caps.vegetarian === true || caps.vegan === true)) fail('vegetarian-exceeds-merchant');
  if (vegan === true && caps.vegan !== true) fail('vegan-exceeds-merchant');
  return { itemId: row.item_id, merchantId: row.merchant_id, name: row.item_name, price: Number(priceText),
    vegetarian: vegetarian === true, vegan: vegan === true, halal: halal === true, sortOrder: Number(row.sort_order),
    categories: [], tags: [] };
}

// merchants: catalogue merchants ({ id, dietaryCapabilities }). Returns Map(merchantId -> items[]).
async function loadMenu(database, merchants) {
  const capabilities = new Map();
  (merchants || []).forEach(merchant => {
    if (merchant && typeof merchant.id === 'string' && merchant.dietaryCapabilities) {
      capabilities.set(merchant.id, merchant.dietaryCapabilities);
    }
  });
  const ids = [...capabilities.keys()];
  if (!ids.length) fail('no-merchants');
  let rows;
  try {
    [rows] = await database.execute(buildMenuSelect(ids.length), ids);
  } catch (error) {
    throw new MenuCatalogueError('read-failed');
  }
  if (!Array.isArray(rows)) fail('bad-result');
  const items = new Map();
  rows.forEach(row => {
    if (row === null || typeof row !== 'object') fail('bad-row');
    const parsed = validateItemRow(row, capabilities);
    const existing = items.get(parsed.itemId);
    if (existing) {
      // Every row of one item must agree on the item fields.
      ITEM_FIELDS.forEach(field => { if (existing.raw[field] !== row[field]) fail('inconsistent-item-rows'); });
    } else {
      items.set(parsed.itemId, { item: parsed, raw: row, seen: new Set() });
    }
    const entry = items.get(parsed.itemId);
    if (row.term_kind !== null && row.term_kind !== undefined) {
      if (typeof row.term !== 'string' || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(row.term) || row.term.length > 40) fail('bad-term');
      const key = row.term_kind + '|' + row.term;
      if (entry.seen.has(key)) fail('duplicate-term');
      entry.seen.add(key);
      if (row.term_kind === 'category') {
        if (vocabulary.MENU_CATEGORIES.indexOf(row.term) === -1) fail('unknown-category');
        entry.item.categories.push(row.term);
      } else if (row.term_kind === 'tag') {
        if (vocabulary.MENU_TAGS.indexOf(row.term) === -1) fail('unknown-tag');
        entry.item.tags.push(row.term);
      } else fail('bad-term-kind');
    } else if (row.term !== null && row.term !== undefined) fail('bad-term');
  });
  const byMerchant = new Map();
  items.forEach(({ item }) => {
    if (!item.categories.length) fail('item-without-category');
    item.nameTokens = vocabulary.tokens(item.name);
    item.termPhrases = new Set(item.categories.concat(item.tags).map(vocabulary.normalisePhrase));
    item.singleTokens = new Set([...item.termPhrases].filter(phrase => phrase.indexOf(' ') === -1));
    if (!byMerchant.has(item.merchantId)) byMerchant.set(item.merchantId, []);
    byMerchant.get(item.merchantId).push(item);
  });
  byMerchant.forEach(list => list.sort((a, b) => a.sortOrder - b.sortOrder || (a.itemId < b.itemId ? -1 : 1)));
  return byMerchant;
}

// 3 = exact (the whole phrase is a stored term, or a whole-word phrase of the item name);
// 2 = every word of a multi-word phrase is a stored single-word term of the item; 0 = no match.
function termTier(item, phrase) {
  if (!phrase) return 0;
  if (item.termPhrases.has(phrase)) return 3;
  const words = phrase.split(' ');
  const name = item.nameTokens;
  for (let start = 0; start + words.length <= name.length; start++) {
    if (words.every((word, offset) => name[start + offset] === word)) return 3;
  }
  if (words.length > 1 && words.every(word => item.singleTokens.has(word))) return 2;
  return 0;
}

// Terms that exist (at tier 2 or better) on at least one stored item anywhere in the loaded catalogue,
// before any budget, diet, distance or other eligibility. Everything else is "not applied".
function classifyTerms(menu, rawTerms) {
  const applied = [];
  const unsupported = [];
  const seen = new Set();
  (rawTerms || []).forEach(raw => {
    const phrase = vocabulary.canonicalPhrase(raw);
    if (!phrase || seen.has(phrase)) return;
    seen.add(phrase);
    let known = false;
    menu.forEach(list => list.forEach(item => { if (termTier(item, phrase) >= 2) known = true; }));
    (known ? applied : unsupported).push(known ? { raw, phrase } : raw);
  });
  return { applied, unsupported };
}

function itemSatisfiesDiet(item, dietary) {
  if (dietary === 'halal') return item.halal === true;
  if (dietary === 'vegetarian') return item.vegetarian === true || item.vegan === true;
  if (dietary === 'vegan') return item.vegan === true;
  return true;
}

// requirement: { category: string|null, terms: [{ raw, phrase }] }. context: { budget, dietary }.
// Returns the single best qualifying item for the merchant, or null.
function matchMerchant(items, requirement, context) {
  let best = null;
  (items || []).forEach(item => {
    if (!(item.price <= context.budget)) return;
    if (!itemSatisfiesDiet(item, context.dietary)) return;
    if (requirement.category && item.categories.indexOf(requirement.category) === -1) return;
    let tier = requirement.terms.length ? 3 : 1;
    const matched = [];
    for (const term of requirement.terms) {
      const t = termTier(item, term.phrase);
      if (t < 2) return;
      tier = Math.min(tier, t);
      matched.push({ term: term.raw, basis: t === 3 ? 'exact' : 'tokens' });
    }
    const candidate = { item, tier, matched };
    if (!best || candidate.tier > best.tier || (candidate.tier === best.tier &&
        (item.price < best.item.price || (item.price === best.item.price && item.itemId < best.item.itemId)))) best = candidate;
  });
  return best;
}

function toRecommendedItem(match, requirement) {
  const item = match.item;
  return {
    itemId: item.itemId, name: item.name, price: item.price,
    categories: item.categories.slice(), tags: item.tags.slice(),
    dietary: { vegetarian: item.vegetarian || item.vegan, vegan: item.vegan, halal: item.halal },
    matchBasis: requirement.terms.length ? (match.tier === 3 ? 'exact' : 'tokens') : 'category',
    matched: match.matched.map(entry => ({ term: entry.term, basis: entry.basis })),
    label: SAMPLE_LABEL
  };
}

// Score bonus added on top of the existing ranking; the ordering signal only, never an eligibility rule.
function tierBonus(match) { return match.tier === 3 ? (match.matched.length ? 60 : 20) : match.tier === 2 ? 30 : 20; }

module.exports = {
  EXPECTED, SAMPLE_LABEL, MenuCatalogueError, buildMenuSelect, loadMenu, classifyTerms, matchMerchant,
  toRecommendedItem, tierBonus, termTier, itemSatisfiesDiet
};
