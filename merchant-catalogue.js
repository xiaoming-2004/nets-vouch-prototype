'use strict';

// Read only. Filtering/ranking stays in the existing recommendation flow.
const SELECT_CATALOGUE = 'SELECT merchant_id, name, location_label, distance_metres, cuisine_type, typical_price, dietary_halal, dietary_vegetarian, dietary_vegan, reward_amount, min_spend, is_sample_data FROM merchants ORDER BY merchant_id';
const SELECT_MERCHANT = 'SELECT merchant_id, name, location_label, distance_metres, cuisine_type, typical_price, dietary_halal, dietary_vegetarian, dietary_vegan, reward_amount, min_spend, is_sample_data FROM merchants WHERE merchant_id = ?';

function numberOrNull(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !/^\d+(?:\.\d+)?$/.test(value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function flag(value) {
  if (value === true || value === 1 || value === '1') return true;
  if (value === false || value === 0 || value === '0') return false;
  return null;
}

function mapMerchant(row) {
  if (!row || typeof row.merchant_id !== 'string' || !row.merchant_id.trim() ||
      typeof row.name !== 'string' || !row.name.trim()) return null;
  const distance = numberOrNull(row.distance_metres);
  const distanceMetres = Number.isInteger(distance) ? distance : null;
  const capabilities = { halal: flag(row.dietary_halal) === true,
    vegetarian: flag(row.dietary_vegetarian) === true, vegan: flag(row.dietary_vegan) === true };
  const rewardAmount = numberOrNull(row.reward_amount);
  const minimumEligibleSpend = numberOrNull(row.min_spend);
  const category = typeof row.cuisine_type === 'string' && row.cuisine_type.trim() ? row.cuisine_type : null;
  return {
    id: row.merchant_id, merchantId: row.merchant_id, merchantName: row.name, name: row.name,
    address: typeof row.location_label === 'string' ? row.location_label : null,
    price: numberOrNull(row.typical_price), itemName: null, coordinates: null,
    category, categoryLabel: category, categoryNames: category ? [category] : [], cuisineTags: [],
    distanceMetres, distanceMinutes: distanceMetres === null ? null : Math.ceil(distanceMetres / 80),
    distanceLabel: distanceMetres === null ? 'Catalogue distance unavailable'
      : 'Approx. ' + distanceMetres + ' m from demo origin (catalogue estimate)',
    dietary: Object.keys(capabilities).filter(key => capabilities[key]), dietaryCapabilities: capabilities,
    catalogueTerms: rewardAmount === null || minimumEligibleSpend === null ? null
      : { rewardAmount, minimumEligibleSpend, rewardLabel: 'Vouch Credit' },
    source: 'mysql', isSampleData: flag(row.is_sample_data), available: true
  };
}

async function loadCatalogue(database) {
  const [rows] = await database.execute(SELECT_CATALOGUE, []);
  if (!Array.isArray(rows)) throw new Error('Invalid catalogue result');
  return { merchants: rows.map(mapMerchant).filter(Boolean), status: rows.length ? 'ok' : 'empty' };
}

async function findMerchant(database, merchantId) {
  if (typeof merchantId !== 'string' || !merchantId.trim()) return null;
  const [rows] = await database.execute(SELECT_MERCHANT, [merchantId]);
  if (!Array.isArray(rows)) throw new Error('Invalid merchant result');
  const merchant = mapMerchant(rows[0]);
  // Preserve the application's exact ID semantics even with a case-insensitive DB collation.
  return merchant && merchant.id === merchantId ? merchant : null;
}

module.exports = { SELECT_CATALOGUE, SELECT_MERCHANT, mapMerchant, loadCatalogue, findMerchant };
