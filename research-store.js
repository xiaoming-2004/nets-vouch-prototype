// Shared merchant-research (dietary evidence) store.
//
// Layer 1: in-process Map (fast, per instance). Layer 2: the EXISTING Upstash Redis integration
// when configured, so evidence survives process restarts and is shared across Vercel instances.
// No other database. Only public merchant evidence is stored - never user preferences or history.
//
// Keys:   research-v7:<provider>:<stable place id>:<restriction>
// Values: the validated verdict + sources + verifiedAt + expiresAt + version.
// TTLs:   verified outcomes (SUITABLE / UNSUITABLE, backed by cited evidence) 7 days;
//         UNKNOWN (checked, no qualifying evidence) 6 hours so it is retried sooner;
//         transient failures (timeouts, HTTP/provider errors, deadline) are never stored.
// A shared-store failure never breaks matching: it is logged once and the memory layer is used
// alone for a short cool-down.

const { currentBudget, traceNote } = require('./request-budget');

const RESEARCH_STORE_VERSION = 'research-v7';
const VERIFIED_TTL_MS = Number(process.env.RESEARCH_VERIFIED_TTL_MS) || 7 * 24 * 60 * 60 * 1000;
const UNKNOWN_TTL_MS = Number(process.env.RESEARCH_UNKNOWN_TTL_MS) || 6 * 60 * 60 * 1000;
const MEMORY_MAX_ENTRIES = 2000;
const SHARED_TIMEOUT_MS = 800;
const SHARED_COOLDOWN_MS = 60 * 1000;
const LOCK_TTL_MS = 25 * 1000;
const STATUSES = ['SUITABLE', 'UNKNOWN', 'UNSUITABLE'];

const memory = new Map();
const inFlight = new Map();
let shared = null;
let sharedDisabledUntil = 0;

function setSharedClient(client) {
  shared = client || null;
  sharedDisabledUntil = 0;
}

function sharedUsable() {
  return Boolean(shared) && Date.now() >= sharedDisabledUntil;
}

function sharedFailed(operation, error) {
  sharedDisabledUntil = Date.now() + SHARED_COOLDOWN_MS;
  const budget = currentBudget();
  if (budget) budget.trace.cache.sharedErrors += 1;
  console.log('Research store: shared cache ' + operation + ' failed (' + (error && error.message) +
    ') - using memory only for ' + (SHARED_COOLDOWN_MS / 1000) + ' s');
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([promise, new Promise(function(resolve, reject) {
    timer = setTimeout(function() { reject(new Error('timeout')); }, ms);
  })]).finally(function() { clearTimeout(timer); });
}

function researchKey(provider, placeId, restriction) {
  return RESEARCH_STORE_VERSION + ':' + String(provider || 'unknown').toLowerCase() + ':' + placeId + ':' + restriction;
}

function ttlFor(status) {
  return status === 'SUITABLE' || status === 'UNSUITABLE' ? VERIFIED_TTL_MS : UNKNOWN_TTL_MS;
}

// Adds version, verifiedAt and expiresAt to a validated verdict (a copy; never mutates the input).
function stampVerdict(verdict) {
  const verifiedAt = Number.isFinite(verdict.researchedAt) ? verdict.researchedAt : Date.now();
  return Object.assign({}, verdict, { version: RESEARCH_STORE_VERSION, verifiedAt: verifiedAt,
    expiresAt: verifiedAt + ttlFor(verdict.status) });
}

// Fresh = current schema, a known status and an unexpired expiresAt. Anything else (including old
// session copies without expiry) is ignored rather than trusted indefinitely.
function isFreshVerdict(verdict) {
  return Boolean(verdict) && typeof verdict === 'object' && verdict.version === RESEARCH_STORE_VERSION &&
    STATUSES.indexOf(verdict.status) !== -1 && typeof verdict.expiresAt === 'number' && verdict.expiresAt > Date.now();
}

function memoryGet(key) {
  const verdict = memory.get(key);
  if (!verdict) return null;
  if (!isFreshVerdict(verdict)) { memory.delete(key); return null; }
  return verdict;
}

function memorySet(key, verdict) {
  if (!memory.has(key) && memory.size >= MEMORY_MAX_ENTRIES) memory.delete(memory.keys().next().value);
  memory.set(key, verdict);
}

// Fresh verdicts for many keys: memory first, then ONE shared MGET for the misses (bounded by the
// request's remaining time). Returns Map(key -> verdict).
async function getMany(keys) {
  const found = new Map();
  const misses = [];
  const budget = currentBudget();
  keys.forEach(function(key) {
    const hit = memoryGet(key);
    if (hit) { found.set(key, hit); if (budget) budget.trace.cache.hits += 1; } else misses.push(key);
  });
  if (misses.length && sharedUsable()) {
    const limit = budget ? Math.min(SHARED_TIMEOUT_MS, Math.max(0, budget.remaining() - 200)) : SHARED_TIMEOUT_MS;
    if (limit > 0) {
      try {
        const values = await withTimeout(shared.mget.apply(shared, misses), limit);
        misses.forEach(function(key, i) {
          let value = values && values[i];
          if (typeof value === 'string') { try { value = JSON.parse(value); } catch (e) { value = null; } }
          if (isFreshVerdict(value)) {
            memorySet(key, value);
            found.set(key, value);
            if (budget) budget.trace.cache.sharedHits += 1;
          }
        });
      } catch (error) {
        sharedFailed('read', error);
      }
    }
  }
  if (budget) budget.trace.cache.misses += keys.length - found.size;
  return found;
}

// Stores a validated verdict in memory and (best effort) in the shared store with its TTL.
async function put(key, verdict) {
  const stamped = isFreshVerdict(verdict) ? verdict : stampVerdict(verdict);
  memorySet(key, stamped);
  if (sharedUsable()) {
    try {
      await withTimeout(shared.set(key, JSON.stringify(stamped), { px: Math.max(1000, stamped.expiresAt - Date.now()) }),
        SHARED_TIMEOUT_MS);
    } catch (error) {
      sharedFailed('write', error);
    }
  }
  return stamped;
}

// In-process de-duplication: the first request researching a key owns it; concurrent requests for
// the same outlet + restriction await the owner's result instead of paying for it again.
function claim(key) {
  if (inFlight.has(key)) return { owner: false, promise: inFlight.get(key).promise };
  let resolve;
  const promise = new Promise(function(r) { resolve = r; });
  inFlight.set(key, { promise: promise });
  return { owner: true, promise: promise, settle: function(verdict) { inFlight.delete(key); resolve(verdict || null); } };
}

// Cross-instance de-duplication (shared store only): a short NX lock per key. Without a shared
// store every key is "locked" by this process alone.
async function tryLock(key) {
  if (!sharedUsable()) return true;
  try {
    const result = await withTimeout(shared.set('lock:' + key, '1', { nx: true, px: LOCK_TTL_MS }), SHARED_TIMEOUT_MS);
    return result === 'OK' || result === true;
  } catch (error) {
    sharedFailed('lock', error);
    return true;
  }
}

async function unlock(key) {
  if (!sharedUsable() || typeof shared.del !== 'function') return;
  try { await withTimeout(shared.del('lock:' + key), SHARED_TIMEOUT_MS); } catch (error) { /* lock expires on its own */ }
}

// Another instance holds the lock: poll the shared store for its verdict until untilMs.
async function waitForShared(key, untilMs) {
  traceNote('waiting for another instance researching ' + key.split(':').slice(1, 3).join(':'));
  while (Date.now() + 400 < untilMs) {
    await new Promise(function(resolve) { setTimeout(resolve, 400); });
    const found = await getMany([key]);
    if (found.has(key)) return found.get(key);
  }
  return null;
}

function clearMemory() {
  memory.clear();
  inFlight.clear();
}

module.exports = { RESEARCH_STORE_VERSION: RESEARCH_STORE_VERSION, VERIFIED_TTL_MS: VERIFIED_TTL_MS,
  UNKNOWN_TTL_MS: UNKNOWN_TTL_MS, setSharedClient: setSharedClient, researchKey: researchKey,
  stampVerdict: stampVerdict, isFreshVerdict: isFreshVerdict, getMany: getMany, put: put, claim: claim,
  tryLock: tryLock, unlock: unlock, waitForShared: waitForShared, clearMemory: clearMemory };
