'use strict';

// Jolene Step 6: Google Routes (Compute Route Matrix) walking times for live-location requests.
//
// - One request per recommendation request: ONE origin and ONE batch of eligible destinations.
// - WALK mode. routingPreference is deliberately never sent (Google rejects it for walking).
// - Uses a server-only key (GOOGLE_ROUTES_API_KEY). The browser key is a different variable.
// - The origin is request-scoped. It is never stored, logged, cached or placed in an error. Provider
//   response bodies, headers and messages are never read into an error and never leave this module.
// - Nothing here persists or caches Google content. Results live only in the caller's journey state.

const googleServices = require('./google-services');
const ROUTES_URL = 'https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix';
const FIELD_MASK = 'originIndex,destinationIndex,duration,distanceMeters,status,condition';
const DEFAULT_TIMEOUT_MS = 4000;
const MAX_DESTINATIONS = 100;
const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_WINDOW_MS = 60000;
const PROVIDER_LABEL = 'Google Maps';
// One shared constant. Shown with every Google walking-time result (Home and Scan).
const WALKING_WARNING = 'Walking routes are in beta and may be missing clear sidewalks or pedestrian paths. Use caution.';
// Generous Singapore bounding box (the origin must be a Singapore starting point).
const SG_BOUNDS = { minLatitude: 1.15, maxLatitude: 1.48, minLongitude: 103.55, maxLongitude: 104.10 };

const FAILURES = {
  'walking-routes-not-configured': 503,
  'walking-routes-timeout': 504,
  'walking-routes-rate-limited': 503,
  'walking-routes-provider-failure': 502,
  'walking-routes-invalid-response': 502,
  'location-request-rate-limited': 429,
  'live-recommendation-unavailable': 503
};

class WalkingRoutesError extends Error {
  constructor(code, extra) {
    super(code);
    this.name = 'WalkingRoutesError';
    this.code = code;
    this.status = FAILURES[code] || 502;
    Object.assign(this, extra || {});
  }
}

// Task 9: also requires the master switch (GOOGLE_SERVICES_ENABLED exactly "true"); see google-services.js.
function isConfigured() {
  return googleServices.routesEnabled();
}

function timeoutMs() {
  const value = Number(process.env.WALKING_ROUTES_TIMEOUT_MS);
  return Number.isFinite(value) && value >= 500 && value <= 10000 ? value : DEFAULT_TIMEOUT_MS;
}

// Returns { ok: true, value: {latitude, longitude} } or { ok: false, reason }. Never echoes values.
function parseLocation(location) {
  if (location === null || typeof location !== 'object' || Array.isArray(location)) return { ok: false, reason: 'invalid' };
  const keys = Object.keys(location);
  if (keys.length !== 2 || !keys.includes('latitude') || !keys.includes('longitude')) return { ok: false, reason: 'invalid' };
  const { latitude, longitude } = location;
  if (typeof latitude !== 'number' || typeof longitude !== 'number' ||
      !Number.isFinite(latitude) || !Number.isFinite(longitude)) return { ok: false, reason: 'invalid' };
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return { ok: false, reason: 'out-of-range' };
  if (latitude < SG_BOUNDS.minLatitude || latitude > SG_BOUNDS.maxLatitude ||
      longitude < SG_BOUNDS.minLongitude || longitude > SG_BOUNDS.maxLongitude) return { ok: false, reason: 'outside-singapore' };
  return { ok: true, value: { latitude, longitude } };
}

function validDestination(coordinates) {
  return Boolean(coordinates) && typeof coordinates.latitude === 'number' && typeof coordinates.longitude === 'number' &&
    Number.isFinite(coordinates.latitude) && Number.isFinite(coordinates.longitude) &&
    coordinates.latitude >= -90 && coordinates.latitude <= 90 &&
    coordinates.longitude >= -180 && coordinates.longitude <= 180;
}

function waypoint(point) {
  return { waypoint: { location: { latLng: { latitude: point.latitude, longitude: point.longitude } } } };
}

function buildRequestBody(origin, destinations) {
  return {
    origins: [waypoint(origin)],
    destinations: destinations.map(waypoint),
    travelMode: 'WALK'
    // No routingPreference: it is only valid for DRIVE and TWO_WHEELER.
  };
}

function invalidResponse() { return new WalkingRoutesError('walking-routes-invalid-response'); }

function indexOf(value, limit) {
  // Proto3 JSON omits default values, so an absent index means 0.
  if (value === undefined) return 0;
  if (!Number.isInteger(value) || value < 0 || value >= limit) throw invalidResponse();
  return value;
}

// Maps matrix elements to destinations by destinationIndex (never by array position).
// Returns { routes: Map(id -> {walkingMinutes, walkingMetres}), noRoute: [id], unavailable: [id] }.
function parseMatrix(data, destinations) {
  if (!Array.isArray(data)) throw invalidResponse();
  const seen = new Set();
  const routes = new Map();
  const noRoute = [];
  const unavailable = [];
  let elementErrors = 0;
  data.forEach(function(element) {
    if (element === null || typeof element !== 'object' || Array.isArray(element)) throw invalidResponse();
    const origin = indexOf(element.originIndex, 1);
    const destination = indexOf(element.destinationIndex, destinations.length);
    if (origin !== 0) throw invalidResponse();
    if (seen.has(destination)) throw invalidResponse();
    seen.add(destination);
    const id = destinations[destination].id;
    const status = element.status;
    if (status !== undefined && (status === null || typeof status !== 'object' || Array.isArray(status))) throw invalidResponse();
    if (status && status.code !== undefined && !Number.isInteger(status.code)) throw invalidResponse();
    if (status && status.code) { elementErrors += 1; unavailable.push(id); return; }
    if (element.condition === 'ROUTE_NOT_FOUND') { noRoute.push(id); return; }
    if (element.condition !== 'ROUTE_EXISTS') throw invalidResponse();
    if (typeof element.duration !== 'string' || !/^\d+(?:\.\d+)?s$/.test(element.duration)) throw invalidResponse();
    const seconds = Number(element.duration.slice(0, -1));
    // Proto3 JSON omits a zero distance.
    const metres = element.distanceMeters === undefined ? 0 : element.distanceMeters;
    if (!Number.isFinite(seconds) || !Number.isInteger(metres) || metres < 0) throw invalidResponse();
    routes.set(id, { walkingMinutes: Math.max(1, Math.ceil(seconds / 60)), walkingMetres: metres });
  });
  if (data.length > 0 && elementErrors === data.length) throw invalidResponse();
  destinations.forEach(function(destination, index) {
    if (!seen.has(index)) unavailable.push(destination.id);
  });
  return { routes, noRoute, unavailable };
}

// destinations: [{ id, latitude, longitude }], already validated. Throws WalkingRoutesError only.
async function computeWalkingMatrix(origin, destinations, options) {
  const settings = options || {};
  if (!isConfigured()) throw new WalkingRoutesError('walking-routes-not-configured');
  if (!Array.isArray(destinations) || destinations.length === 0 || destinations.length > MAX_DESTINATIONS ||
      !destinations.every(validDestination)) throw invalidResponse();
  const controller = new AbortController();
  const timer = setTimeout(function() { controller.abort(); }, settings.timeoutMs || timeoutMs());
  if (typeof timer.unref === 'function') timer.unref();
  try {
    let response;
    try {
      response = await fetch(ROUTES_URL, {
        method: 'POST', signal: controller.signal, body: JSON.stringify(buildRequestBody(origin, destinations)),
        headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': process.env.GOOGLE_ROUTES_API_KEY,
          'X-Goog-FieldMask': FIELD_MASK }
      });
    } catch (error) {
      throw new WalkingRoutesError(controller.signal.aborted ? 'walking-routes-timeout' : 'walking-routes-provider-failure');
    }
    if (!response.ok) {
      throw response.status === 429
        ? new WalkingRoutesError('walking-routes-rate-limited', { retryable: true })
        : new WalkingRoutesError('walking-routes-provider-failure');
    }
    let data;
    try { data = await response.json(); } catch (error) {
      throw controller.signal.aborted ? new WalkingRoutesError('walking-routes-timeout') : invalidResponse();
    }
    return parseMatrix(data, destinations);
  } finally {
    clearTimeout(timer);
  }
}

// Per-session limit for live routing requests (one matrix call each).
function consumeRateLimit(store, nowMs) {
  const recent = (Array.isArray(store) ? store : []).filter(function(stamp) {
    return Number.isFinite(stamp) && nowMs - stamp < RATE_LIMIT_WINDOW_MS;
  });
  if (recent.length >= RATE_LIMIT_MAX) {
    return { retryAfterSeconds: Math.max(1, Math.ceil((recent[0] + RATE_LIMIT_WINDOW_MS - nowMs) / 1000)), stamps: recent };
  }
  recent.push(nowMs);
  return { retryAfterSeconds: 0, stamps: recent };
}

module.exports = {
  ROUTES_URL, FIELD_MASK, PROVIDER_LABEL, WALKING_WARNING, SG_BOUNDS, FAILURES, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS,
  WalkingRoutesError, isConfigured, parseLocation, validDestination, buildRequestBody, parseMatrix,
  computeWalkingMatrix, consumeRateLimit
};
