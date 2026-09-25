// Smart Match RESULT presentation helpers (UI support only - no discovery, ranking, payment or
// reward logic). Everything here runs AFTER the existing logic has chosen the merchant.
//
//  - demoVouchCount: a stable, clearly-simulated demo Vouch count for display only.
//  - buildWalkingDirections: a universal Google Maps walking-directions URL (no key) opened when the
//    result map is tapped. Google computes the route and time; nothing is estimated here.
//  - merchant photo: ONE Place Details (photos only) lookup for the selected Google merchant,
//    cached. Only photos Google credits to the BUSINESS ITSELF (owner uploads - e.g. logo, signboard)
//    are used; customer-contributed photos are never shown. The image bytes are proxied by the
//    server so GOOGLE_PLACES_API_KEY never reaches the browser.

const PLACE_DETAILS_URL = 'https://places.googleapis.com/v1/places/';
const PLACES_MEDIA_URL = 'https://places.googleapis.com/v1/';
const MAPS_DIRECTIONS_URL = 'https://www.google.com/maps/dir/';
const PHOTO_LOOKUP_TIMEOUT_MS = 2500;
const PHOTO_MEDIA_TIMEOUT_MS = 5000;
const PHOTO_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const NO_PHOTO_CACHE_TTL_MS = 60 * 60 * 1000;
const PHOTO_MAX_PX = 480;
const PHOTO_MAX_BYTES = 2 * 1024 * 1024;
const PHOTO_BYTES_CACHE_MAX = 40;
const DEMO_VOUCH_MIN = 20;
const DEMO_VOUCH_SPAN = 281; // 20-300

const photoInfoCache = new Map();   // Google place ID -> { photo|null, expiresAt }
const photoBytesCache = new Map();  // photo resource name -> { type, body }

// ---------------------------------------------------------------------------
// Demo Vouch count. SIMULATED sample social proof for the Open House prototype - not live data,
// not a rating, and never read by ranking. FNV-1a over the stable merchant ID keeps it identical
// across refreshes and sessions (no random numbers). Real Payment-Verified Vouches made in the demo
// are added on top by the caller.
// ---------------------------------------------------------------------------
function demoVouchCount(merchantId) {
  let hash = 0x811c9dc5;
  const text = String(merchantId || '');
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return DEMO_VOUCH_MIN + (hash % DEMO_VOUCH_SPAN);
}

// ---------------------------------------------------------------------------
// Walking directions
// ---------------------------------------------------------------------------
function toLatLng(point) {
  if (!point) return null;
  const latitude = Number(point.latitude);
  const longitude = Number(point.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) ||
      latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;
  return latitude + ',' + longitude;
}

// Google's own Place ID - only for Google-sourced merchants, never the app's "google-" prefixed ID.
function googlePlaceIdOf(merchant) {
  if (!merchant || merchant.source !== 'GOOGLE') return null;
  const id = merchant.providerPlaceId;
  return typeof id === 'string' && /^[A-Za-z0-9_-]{10,}$/.test(id) ? id : null;
}

// origin: the visitor's current session coordinates, or null (unknown / demo data) - Google Maps
// then routes from the device's own location. Returns null without valid merchant coordinates.
function buildWalkingDirections(origin, merchant) {
  const destination = toLatLng(merchant && merchant.coordinates);
  if (!destination) return null;
  const from = toLatLng(origin);
  const placeId = googlePlaceIdOf(merchant);
  const maps = new URL(MAPS_DIRECTIONS_URL);
  maps.searchParams.set('api', '1');
  if (from) maps.searchParams.set('origin', from);
  maps.searchParams.set('destination', destination);
  if (placeId) maps.searchParams.set('destination_place_id', placeId);
  maps.searchParams.set('travelmode', 'walking');
  return { mapsUrl: maps.href };
}

// ---------------------------------------------------------------------------
// Merchant photo (Google Places API (New) - Place Details photos + Place Photos media)
// ---------------------------------------------------------------------------
function isPhotoOfPlace(name, placeId) {
  return typeof name === 'string' && name.indexOf('places/' + placeId + '/photos/') === 0 &&
    /^places\/[A-Za-z0-9_-]+\/photos\/[A-Za-z0-9_-]+$/.test(name);
}

function cleanAttributions(list) {
  return (Array.isArray(list) ? list : []).map(function(a) {
    const name = a && typeof a.displayName === 'string' ? a.displayName.replace(/[<>]/g, '').trim() : '';
    let uri = a && typeof a.uri === 'string' ? a.uri : '';
    if (uri.indexOf('//') === 0) uri = 'https:' + uri;
    if (!/^https:\/\//.test(uri)) uri = '';
    return name ? { name: name, uri: uri } : null;
  }).filter(Boolean).slice(0, 3);
}

function normaliseName(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Google has no "logo" field. An owner-uploaded photo is credited to the business itself, so a photo
// counts only when one of its author names matches the merchant's own name (exactly, or one name
// containing the other). Customer photos (credited to individual people) never match.
function isOwnerPhoto(photo, merchantName) {
  const business = normaliseName(merchantName);
  if (business.length < 3) return false;
  return (Array.isArray(photo.authorAttributions) ? photo.authorAttributions : []).some(function(a) {
    const author = normaliseName(a && a.displayName);
    return author.length >= 3 && (author === business ||
      (Math.min(author.length, business.length) >= 5 && (author.indexOf(business) !== -1 || business.indexOf(author) !== -1)));
  });
}

// Deterministic choice among the business's OWN photos (Google returns photos in its own relevance
// order): the first reasonably sized one that crops cleanly to a square, else the first owner photo.
// No owner photo -> null, and the card shows the neutral placeholder.
function selectPhoto(photos, placeId, merchantName) {
  const valid = (Array.isArray(photos) ? photos : []).filter(function(p) {
    return p && isPhotoOfPlace(p.name, placeId) && isOwnerPhoto(p, merchantName);
  });
  if (!valid.length) return null;
  const squareFriendly = valid.find(function(p) {
    const w = Number(p.widthPx);
    const h = Number(p.heightPx);
    return w >= 200 && h >= 200 && w / h >= 0.6 && w / h <= 1.8;
  });
  const chosen = squareFriendly || valid[0];
  return { name: chosen.name, attributions: cleanAttributions(chosen.authorAttributions) };
}

function getCachedMerchantPhoto(merchant) {
  const placeId = googlePlaceIdOf(merchant);
  if (!placeId) return null;
  const entry = photoInfoCache.get(placeId);
  if (!entry || entry.expiresAt <= Date.now()) return null;
  return entry.photo;
}

// One Place Details request (field mask "photos" only) for the ONE selected merchant; cached per
// place. Never throws: any failure simply means no photo (failures are not cached). timeoutMs lets
// the caller cancel it at the same moment it stops waiting, so no work outlives the response.
async function ensureMerchantPhoto(merchant, apiKey, timeoutMs) {
  const placeId = googlePlaceIdOf(merchant);
  if (!placeId || !apiKey) return null;
  const cached = photoInfoCache.get(placeId);
  if (cached && cached.expiresAt > Date.now()) return cached.photo;
  const controller = new AbortController();
  const timeout = setTimeout(function() { controller.abort(); },
    Math.min(PHOTO_LOOKUP_TIMEOUT_MS, timeoutMs || PHOTO_LOOKUP_TIMEOUT_MS));
  try {
    const response = await fetch(PLACE_DETAILS_URL + encodeURIComponent(placeId), {
      signal: controller.signal,
      headers: { 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': 'photos' }
    });
    if (!response.ok) return null;
    const data = await response.json();
    const photo = selectPhoto(data && data.photos, placeId, merchant.merchantName);
    if (photoInfoCache.size >= 500) photoInfoCache.delete(photoInfoCache.keys().next().value);
    photoInfoCache.set(placeId, { photo: photo,
      expiresAt: Date.now() + (photo ? PHOTO_CACHE_TTL_MS : NO_PHOTO_CACHE_TTL_MS) });
    return photo;
  } catch (error) {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// Image bytes for the selected merchant's chosen photo, fetched server-side with the server key.
async function fetchMerchantPhotoBytes(merchant, apiKey) {
  const photo = getCachedMerchantPhoto(merchant);
  if (!photo || !apiKey) return null;
  const hit = photoBytesCache.get(photo.name);
  if (hit) return hit;
  const controller = new AbortController();
  const timeout = setTimeout(function() { controller.abort(); }, PHOTO_MEDIA_TIMEOUT_MS);
  try {
    const url = PLACES_MEDIA_URL + photo.name + '/media?maxWidthPx=' + PHOTO_MAX_PX + '&maxHeightPx=' + PHOTO_MAX_PX;
    const response = await fetch(url, { signal: controller.signal, headers: { 'X-Goog-Api-Key': apiKey } });
    const type = response.headers && response.headers.get ? response.headers.get('content-type') || '' : '';
    if (!response.ok || !/^image\//.test(type)) return null;
    const body = Buffer.from(await response.arrayBuffer());
    if (!body.length || body.length > PHOTO_MAX_BYTES) return null;
    const entry = { type: type, body: body };
    if (photoBytesCache.size >= PHOTO_BYTES_CACHE_MAX) photoBytesCache.delete(photoBytesCache.keys().next().value);
    photoBytesCache.set(photo.name, entry);
    return entry;
  } catch (error) {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function clearMerchantPhotoCache() {
  photoInfoCache.clear();
  photoBytesCache.clear();
}

module.exports = {
  demoVouchCount: demoVouchCount,
  buildWalkingDirections: buildWalkingDirections,
  googlePlaceIdOf: googlePlaceIdOf,
  getCachedMerchantPhoto: getCachedMerchantPhoto,
  ensureMerchantPhoto: ensureMerchantPhoto,
  fetchMerchantPhotoBytes: fetchMerchantPhotoBytes,
  clearMerchantPhotoCache: clearMerchantPhotoCache
};
