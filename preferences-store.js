// Saved demo-user state in MySQL (optional). This module is the app's single gateway to the
// database: profile preferences, rejection feedback and discovered-merchant records all go through
// here. Tests swap the backing database with setDatabase(); with no database configured every
// reader reports "nothing saved" and every writer does nothing, so MySQL is never required.
//
// Database errors are propagated to the caller, never swallowed here: hydration must be able to
// retry later instead of treating an outage as "nothing saved", and fire-and-forget writers attach
// their own .catch at the call site.
const realDatabase = require('./Database/db');

// The injectable adapter contract: isConfigured() and query(sql, params) -> rows.
const defaultDatabase = {
  isConfigured: function() { return realDatabase.isConfigured(); },
  query: async function(sql, params) {
    const result = await realDatabase.query(sql, params);
    return result[0];
  }
};

let database = defaultDatabase;
function setDatabase(custom) { database = custom || defaultDatabase; }

async function loadPreferences(userId) {
  if (!database.isConfigured()) return null;
  const rows = await database.query(
    'SELECT user_id, display_name, dietary_preference, mood_cuisine, craving, budget_max, ' +
    'max_distance_minutes, notifications, has_set_preferences FROM users WHERE user_id = ?',
    [userId]
  );
  return rows && rows.length ? rows[0] : null;
}

async function savePreferences(user, profile, hasSetPreferences) {
  if (!database.isConfigured()) return;
  await database.query(
    'INSERT INTO users (user_id, display_name, dietary_preference, mood_cuisine, craving, ' +
    'budget_max, max_distance_minutes, notifications, has_set_preferences) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
    'ON DUPLICATE KEY UPDATE display_name = VALUES(display_name), ' +
    'dietary_preference = VALUES(dietary_preference), mood_cuisine = VALUES(mood_cuisine), ' +
    'craving = VALUES(craving), budget_max = VALUES(budget_max), ' +
    'max_distance_minutes = VALUES(max_distance_minutes), notifications = VALUES(notifications), ' +
    'has_set_preferences = VALUES(has_set_preferences)',
    [user.id, user.name, profile.dietaryPreference, profile.moodCuisine, profile.craving,
      profile.budget, profile.maxDistanceMinutes, profile.notifications ? 1 : 0,
      hasSetPreferences ? 1 : 0]
  );
}

async function deleteSavedUsers(userIds) {
  if (!database.isConfigured() || !userIds.length) return;
  await database.query('DELETE FROM users WHERE user_id IN (?)', [userIds]);
}

// Every rejection reason is saved against the demo user, not only the two that adjust weights.
async function recordRejection(userId, feedback) {
  if (!database.isConfigured()) return;
  await database.query(
    'INSERT INTO rejection_feedback (user_id, merchant_id, reason, category, price, ' +
    'distance_minutes, cuisine_tags) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [userId, feedback.merchantId, feedback.reason, feedback.category || null,
      Number.isFinite(feedback.price) ? feedback.price : null,
      Number.isFinite(feedback.distanceMinutes) ? feedback.distanceMinutes : null,
      JSON.stringify(Array.isArray(feedback.cuisineTags) ? feedback.cuisineTags : [])]
  );
}

async function loadRecentRejections(userId, limit) {
  if (!database.isConfigured()) return [];
  const rows = await database.query(
    'SELECT merchant_id, reason, category, price, distance_minutes, cuisine_tags ' +
    'FROM rejection_feedback WHERE user_id = ? ORDER BY feedback_id DESC LIMIT ' +
    Math.max(1, Math.min(50, Number(limit) || 10)),
    [userId]
  );
  return rows || [];
}

async function clearRejections(userIds) {
  if (!database.isConfigured() || !userIds.length) return;
  await database.query('DELETE FROM rejection_feedback WHERE user_id IN (?)', [userIds]);
}

// "Too expensive" and "Too far" also nudge the stored ranking weights, capped so repeated
// rejections can never push a weight to an absurd value.
const REJECTION_WEIGHT_COLUMNS = {
  'too-expensive': 'weight_price_sensitivity',
  'too-far': 'weight_distance_sensitivity'
};
async function applyRejectionWeight(userId, reason) {
  const column = REJECTION_WEIGHT_COLUMNS[reason];
  if (!column || !database.isConfigured()) return;
  await database.query(
    'UPDATE users SET ' + column + ' = LEAST(' + column + ' + 0.2, 3.0) WHERE user_id = ?',
    [userId]
  );
}

// API-discovered merchants (Google Places / Foursquare) are kept for future retrieval.
async function syncDiscoveredMerchant(record) {
  if (!database.isConfigured()) return;
  await database.query(
    'INSERT IGNORE INTO merchants (merchant_id, name, location_label, distance_metres, ' +
    'cuisine_type, typical_price, dietary_halal, dietary_vegetarian, dietary_vegan, ' +
    'reward_amount, min_spend, is_sample_data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, FALSE)',
    [record.id, record.name, record.locationLabel, record.distanceMetres, record.cuisineType,
      record.typicalPrice, record.halal, record.vegetarian, record.vegan,
      record.rewardAmount, record.minSpend]
  );
}

module.exports = {
  setDatabase: setDatabase,
  loadPreferences: loadPreferences,
  savePreferences: savePreferences,
  deleteSavedUsers: deleteSavedUsers,
  recordRejection: recordRejection,
  loadRecentRejections: loadRecentRejections,
  clearRejections: clearRejections,
  applyRejectionWeight: applyRejectionWeight,
  syncDiscoveredMerchant: syncDiscoveredMerchant
};
