'use strict';

const HISTORY_DAYS = 30;
const VALID_REASONS = new Set(['too-expensive', 'too-far', 'ate-recently', 'not-in-mood']);
let nowProvider = () => new Date();

function singaporeParts(value = nowProvider()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Singapore', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(value);
  const result = {};
  parts.forEach(part => { if (part.type !== 'literal') result[part.type] = part.value; });
  return {
    date: `${result.year}-${result.month}-${result.day}`,
    dateTime: `${result.year}-${result.month}-${result.day} ${result.hour}:${result.minute}:${result.second}`
  };
}

function subtractCalendarDays(dateText, days) {
  const [year, month, day] = dateText.split('-').map(Number);
  const value = new Date(Date.UTC(year, month - 1, day - days));
  return value.toISOString().slice(0, 10);
}

function normalizeCuisine(value) {
  return typeof value === 'string'
    ? value.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim()
    : '';
}

function parseCuisineTags(value) {
  if (Array.isArray(value)) return value.filter(tag => typeof tag === 'string');
  if (typeof value !== 'string' || !value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter(tag => typeof tag === 'string') : [];
  } catch (error) {
    return [];
  }
}

async function loadRecentFeedback(database, userId) {
  const today = singaporeParts().date;
  const cutoff = `${subtractCalendarDays(today, HISTORY_DAYS - 1)} 00:00:00`;
  const [rows] = await database.execute(
    `SELECT feedback_id, user_id, merchant_id, reason, category, price, distance_minutes,
            distance_metres, cuisine_tags, submission_token, rejected_at_sg
       FROM rejection_feedback
      WHERE user_id = ? AND rejected_at_sg >= ?
      ORDER BY rejected_at_sg DESC, feedback_id DESC`,
    [userId, cutoff]
  );
  return rows.map(row => ({
    feedbackId: row.feedback_id,
    userId: row.user_id,
    merchantId: row.merchant_id,
    reason: row.reason,
    category: row.category || null,
    price: row.price === null ? null : Number(row.price),
    distanceMinutes: row.distance_minutes === null ? null : Number(row.distance_minutes),
    distanceMetres: row.distance_metres === null ? null : Number(row.distance_metres),
    cuisineTags: parseCuisineTags(row.cuisine_tags),
    token: row.submission_token,
    rejectedAtSingapore: String(row.rejected_at_sg).slice(0, 19)
  }));
}

async function recordRejection(database, entry) {
  const cuisineTags = JSON.stringify(Array.isArray(entry.cuisineTags) ? entry.cuisineTags : []);
  const [insert] = await database.execute(
    `INSERT INTO rejection_feedback
       (user_id, merchant_id, reason, category, price, distance_minutes, distance_metres,
        cuisine_tags, submission_token, rejected_at_sg)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE feedback_id = feedback_id`,
    [entry.userId, entry.merchantId, entry.reason, entry.category, entry.price,
      entry.distanceMinutes, entry.distanceMetres, cuisineTags, entry.token,
      entry.rejectedAtSingapore || singaporeParts().dateTime]
  );
  const [rows] = await database.execute(
    `SELECT user_id, merchant_id, reason
       FROM rejection_feedback
      WHERE user_id = ? AND submission_token = ?`,
    [entry.userId, entry.token]
  );
  const stored = rows[0];
  if (!stored || stored.merchant_id !== entry.merchantId || stored.reason !== entry.reason) {
    return { status: 'conflict' };
  }
  return { status: insert.affectedRows === 1 ? 'created' : 'duplicate' };
}

function buildLearningPolicy(rows, explicit = {}) {
  const today = singaporeParts().date;
  const excludedMerchantIds = new Set();
  const priceValues = [];
  const distanceValues = [];
  const cuisines = new Set();

  rows.forEach(row => {
    if (!VALID_REASONS.has(row.reason)) return;
    const rowDate = String(row.rejectedAtSingapore || '').slice(0, 10);
    if (row.reason === 'not-in-mood') {
      if (rowDate === today) excludedMerchantIds.add(row.merchantId);
      return;
    }
    excludedMerchantIds.add(row.merchantId);
    if (row.reason === 'too-expensive' && Number.isFinite(row.price)) priceValues.push(row.price);
    if (row.reason === 'too-far' && Number.isFinite(row.distanceMetres)) distanceValues.push(row.distanceMetres);
    if (row.reason === 'ate-recently') {
      [row.category].concat(row.cuisineTags || []).forEach(value => {
        const normalized = normalizeCuisine(value);
        if (normalized) cuisines.add(normalized);
      });
    }
  });

  const priceThreshold = priceValues.length ? Math.min(...priceValues) - 0.50 : null;
  const distanceThreshold = distanceValues.length ? Math.max(0, Math.min(...distanceValues) - 80) : null;
  return {
    excludedMerchantIds,
    score(merchant, cuisineTags) {
      let matched = false;
      if (!explicit.budget && priceThreshold !== null && Number.isFinite(merchant.price) &&
          merchant.price >= priceThreshold) matched = true;
      const metres = Number.isFinite(merchant.distanceMetres) ? merchant.distanceMetres : null;
      if (!explicit.maxDistance && distanceThreshold !== null && metres !== null && metres >= distanceThreshold) matched = true;
      if (!explicit.cuisine && cuisines.size) {
        const matches = [merchant.category].concat(cuisineTags || []).some(value => cuisines.has(normalizeCuisine(value)));
        if (matches) matched = true;
      }
      return matched ? -30 : 0;
    },
    historyDays: HISTORY_DAYS,
    today
  };
}

async function resetPersona(database, userId) {
  const connection = await database.getConnection();
  try {
    await connection.beginTransaction();
    await connection.execute(
      `UPDATE users
          SET budget_max = 10.00, max_walk_minutes = 15, dietary_preference = 'none'
        WHERE user_id = ?`,
      [userId]
    );
    await connection.execute('DELETE FROM rejection_feedback WHERE user_id = ?', [userId]);
    await connection.commit();
  } catch (error) {
    try { await connection.rollback(); } catch (rollbackError) { /* preserve the original failure */ }
    throw error;
  } finally {
    connection.release();
  }
}

function setNowProviderForTest(provider) {
  nowProvider = typeof provider === 'function' ? provider : () => new Date();
}

module.exports = {
  HISTORY_DAYS,
  VALID_REASONS,
  singaporeParts,
  normalizeCuisine,
  loadRecentFeedback,
  recordRejection,
  buildLearningPolicy,
  resetPersona,
  setNowProviderForTest
};
