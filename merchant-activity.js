'use strict';

const TIMEZONE = 'Asia/Singapore';
const MIN_TARGET_OBSERVATIONS = 3;
const MIN_BASELINE_OBSERVATIONS = 28;
const RELATIVE_THRESHOLD = 0.20;
const BASIS = 'fictional-sample-history';
const UNAVAILABLE_LABEL = 'Fictional sample history unavailable';
const UNAVAILABLE_DISCLOSURE = 'Fictional sample history only. This is not a live queue, waiting-time, seating-availability, or real NETS transaction-traffic claim.';

function validateRequest(database, merchantIds, request) {
  if (!database || typeof database.execute !== 'function') throw new TypeError('database.execute is required');
  if (!Array.isArray(merchantIds) || merchantIds.length === 0) throw new TypeError('merchantIds must be a non-empty array');
  for (const id of merchantIds) {
    if (typeof id !== 'string' || !id.trim() || id.length > 64) throw new TypeError('merchantIds must contain valid strings');
  }
  if (!request || !Number.isInteger(request.isoWeekday) || request.isoWeekday < 1 || request.isoWeekday > 7) {
    throw new RangeError('isoWeekday must be an integer from 1 to 7');
  }
  if (typeof request.time !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(request.time)) {
    throw new TypeError('time must use HH:mm');
  }
}

function normaliseSlot(time) {
  return time.slice(0, 2) + ':00:00';
}

function buildActivitySelect(merchantCount) {
  if (!Number.isInteger(merchantCount) || merchantCount < 1) throw new RangeError('merchantCount must be positive');
  const placeholders = Array(merchantCount).fill('?').join(', ');
  return `SELECT
    m.merchant_id,
    d.dataset_key,
    d.sample_label,
    d.timezone_name,
    DATE_FORMAT(d.period_start, '%Y-%m-%d') AS period_start,
    DATE_FORMAT(d.period_end, '%Y-%m-%d') AS period_end,
    d.slot_start_hour,
    d.slot_end_hour,
    d.slot_minutes,
    d.disclosure,
    DATE_FORMAT(a.observation_date, '%Y-%m-%d') AS observation_date,
    WEEKDAY(a.observation_date) + 1 AS iso_weekday,
    TIME_FORMAT(a.slot_start, '%H:%i:%s') AS slot_start,
    a.observation_status,
    a.transaction_count
  FROM merchants m
  JOIN sample_datasets d ON d.dataset_key = m.sample_dataset_key
  LEFT JOIN merchant_sample_activity a
    ON a.dataset_key = d.dataset_key
    AND a.merchant_id = m.merchant_id
    AND (a.observation_status = 'OBSERVED'
      OR (WEEKDAY(a.observation_date) + 1 = ? AND a.slot_start = ?))
  WHERE m.merchant_id IN (${placeholders})
  ORDER BY m.merchant_id, a.observation_date, a.slot_start`;
}

function round(value, places) {
  const factor = 10 ** places;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function expectedWeekdayDates(start, end, isoWeekday) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start || '') || !/^\d{4}-\d{2}-\d{2}$/.test(end || '')) return null;
  const first = new Date(start + 'T00:00:00.000Z');
  const last = new Date(end + 'T00:00:00.000Z');
  if (!Number.isFinite(first.getTime()) || !Number.isFinite(last.getTime()) || last < first) return null;
  const dates = [];
  const cursor = new Date(first);
  while (cursor <= last) {
    const day = cursor.getUTCDay() || 7;
    if (day === isoWeekday) dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

function fallbackResult(merchantId, request, slotStart, reason) {
  return {
    merchantId,
    status: 'unavailable',
    reason,
    comparison: null,
    isoWeekday: request.isoWeekday,
    slotStart,
    timezone: TIMEZONE,
    averageTransactions: null,
    baselineAverageTransactions: null,
    relativeDifferencePercent: null,
    sampleCount: 0,
    missingCount: 0,
    baselineSampleCount: 0,
    historicalPeriod: null,
    basis: BASIS,
    sampleDataLabel: UNAVAILABLE_LABEL,
    disclosure: UNAVAILABLE_DISCLOSURE
  };
}

function resultBase(merchantId, request, slotStart, metadata) {
  return {
    merchantId,
    status: null,
    reason: null,
    comparison: null,
    isoWeekday: request.isoWeekday,
    slotStart,
    timezone: metadata.timezone_name,
    averageTransactions: null,
    baselineAverageTransactions: null,
    relativeDifferencePercent: null,
    sampleCount: 0,
    missingCount: 0,
    baselineSampleCount: 0,
    historicalPeriod: { start: metadata.period_start, end: metadata.period_end },
    basis: BASIS,
    sampleDataLabel: metadata.sample_label,
    disclosure: metadata.disclosure
  };
}

function unavailable(base, reason) {
  return { ...base, status: 'unavailable', reason };
}

function insufficient(base, reason, sampleCount, missingCount, baselineSampleCount) {
  return { ...base, status: 'insufficient-data', reason, sampleCount, missingCount, baselineSampleCount };
}

function calculateOne(merchantId, request, slotStart, merchantRows) {
  if (!merchantRows.length) return fallbackResult(merchantId, request, slotStart, 'merchant-sample-unavailable');
  const metadata = merchantRows[0];
  const base = resultBase(merchantId, request, slotStart, metadata);
  const metadataFields = ['dataset_key', 'sample_label', 'timezone_name', 'period_start', 'period_end', 'disclosure'];
  if (metadataFields.some(field => typeof metadata[field] !== 'string' || !metadata[field]) ||
      !Number.isInteger(Number(metadata.slot_start_hour)) || !Number.isInteger(Number(metadata.slot_end_hour)) ||
      Number(metadata.slot_minutes) !== 60 || merchantRows.some(row => metadataFields.some(field => row[field] !== metadata[field]))) {
    return unavailable(base, 'invalid-sample-metadata');
  }
  if (metadata.timezone_name !== TIMEZONE) return unavailable(base, 'timezone-unavailable');
  const requestedHour = Number(slotStart.slice(0, 2));
  if (requestedHour < Number(metadata.slot_start_hour) || requestedHour > Number(metadata.slot_end_hour)) {
    return unavailable(base, 'outside-sample-hour-range');
  }
  const expectedDates = expectedWeekdayDates(metadata.period_start, metadata.period_end, request.isoWeekday);
  if (!expectedDates || expectedDates.length === 0) return unavailable(base, 'invalid-sample-metadata');
  const expectedSet = new Set(expectedDates);
  const targetRows = merchantRows.filter(row => Number(row.iso_weekday) === request.isoWeekday && row.slot_start === slotStart);
  const targetDates = new Set(targetRows.map(row => row.observation_date));
  if (targetRows.length !== expectedDates.length || targetDates.size !== expectedDates.length ||
      [...targetDates].some(date => !expectedSet.has(date))) {
    return unavailable(base, 'incomplete-target-history');
  }
  const allowed = new Set(['OBSERVED', 'MISSING', 'CLOSED']);
  if (targetRows.some(row => !allowed.has(row.observation_status))) return unavailable(base, 'inconsistent-target-history');
  const closedCount = targetRows.filter(row => row.observation_status === 'CLOSED').length;
  if (closedCount === targetRows.length) {
    return { ...base, status: 'closed', reason: 'scheduled-closed' };
  }
  if (closedCount > 0) return unavailable(base, 'inconsistent-target-history');

  function validObserved(row) {
    const value = Number(row.transaction_count);
    return row.observation_status === 'OBSERVED' && Number.isInteger(value) && value >= 0;
  }
  if (merchantRows.some(row => row.observation_status === 'OBSERVED' && !validObserved(row))) {
    return unavailable(base, 'inconsistent-target-history');
  }
  const targetObserved = targetRows.filter(validObserved);
  const missingCount = targetRows.filter(row => row.observation_status === 'MISSING').length;
  const baselineObserved = merchantRows.filter(validObserved);
  if (targetObserved.length < MIN_TARGET_OBSERVATIONS) {
    return insufficient(base, 'target-sample-too-small', targetObserved.length, missingCount, baselineObserved.length);
  }
  if (baselineObserved.length < MIN_BASELINE_OBSERVATIONS) {
    return insufficient(base, 'baseline-sample-too-small', targetObserved.length, missingCount, baselineObserved.length);
  }
  const targetAverage = targetObserved.reduce((sum, row) => sum + Number(row.transaction_count), 0) / targetObserved.length;
  const baselineAverage = baselineObserved.reduce((sum, row) => sum + Number(row.transaction_count), 0) / baselineObserved.length;
  let relativeDifference;
  if (baselineAverage === 0) {
    if (targetAverage !== 0) return unavailable(base, 'zero-baseline-comparison-unavailable');
    relativeDifference = 0;
  } else {
    relativeDifference = (targetAverage - baselineAverage) / baselineAverage;
  }
  const comparison = relativeDifference <= -RELATIVE_THRESHOLD ? 'quieter'
    : relativeDifference >= RELATIVE_THRESHOLD ? 'busier' : 'typical';
  return {
    ...base,
    status: 'available',
    comparison,
    averageTransactions: round(targetAverage, 2),
    baselineAverageTransactions: round(baselineAverage, 2),
    relativeDifferencePercent: round(relativeDifference * 100, 1),
    sampleCount: targetObserved.length,
    missingCount,
    baselineSampleCount: baselineObserved.length
  };
}

function calculateUsualActivity(merchantIds, request, rows) {
  const slotStart = normaliseSlot(request.time);
  const grouped = new Map();
  for (const row of rows) {
    if (!row || typeof row.merchant_id !== 'string') continue;
    if (!grouped.has(row.merchant_id)) grouped.set(row.merchant_id, []);
    grouped.get(row.merchant_id).push(row);
  }
  return merchantIds.map(merchantId => calculateOne(merchantId, request, slotStart, grouped.get(merchantId) || []));
}

async function loadUsualActivity(database, merchantIds, request) {
  validateRequest(database, merchantIds, request);
  const uniqueIds = [...new Set(merchantIds)];
  const slotStart = normaliseSlot(request.time);
  try {
    const sql = buildActivitySelect(uniqueIds.length);
    const [rows] = await database.execute(sql, [request.isoWeekday, slotStart, ...uniqueIds]);
    if (!Array.isArray(rows)) throw new Error('invalid activity result');
    return calculateUsualActivity(merchantIds, request, rows);
  } catch (_) {
    return merchantIds.map(merchantId => fallbackResult(merchantId, request, slotStart, 'database-unavailable'));
  }
}

module.exports = {
  TIMEZONE,
  MIN_TARGET_OBSERVATIONS,
  MIN_BASELINE_OBSERVATIONS,
  RELATIVE_THRESHOLD,
  buildActivitySelect,
  calculateUsualActivity,
  loadUsualActivity
};
