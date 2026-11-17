// UI only. Preferences, payments and decisions belong to the server session.
function wait(milliseconds) {
  return new Promise(function(resolve) { window.setTimeout(resolve, milliseconds); });
}

(function initQRScanner() {
  const video = document.getElementById('qr-video');
  const canvas = document.getElementById('qr-canvas');
  const statusEl = document.getElementById('camera-status');
  const placeholder = document.getElementById('camera-placeholder');
  const placeholderText = document.getElementById('placeholder-text');
  const form = document.getElementById('qr-scan-form');
  const fallback = document.getElementById('scan-fallback');
  if (!video || !canvas || !form) return;

  function setStatus(text) { if (statusEl) statusEl.textContent = text; }

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    if (placeholderText) placeholderText.textContent = 'Camera not supported';
    setStatus('Use the list below to select a merchant');
    if (fallback) fallback.open = true;
    return;
  }

  navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } } })
    .then(function(stream) {
      video.srcObject = stream;
      video.play().catch(function() {});
      if (placeholder) placeholder.hidden = true;
      setStatus('Point at a merchant NETS QR code');

      let active = true;
      function tick() {
        if (!active) return;
        if (video.readyState >= video.HAVE_ENOUGH_DATA) {
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(video, 0, 0);
          const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
          if (typeof jsQR !== 'undefined') {
            const code = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
            if (code) {
              active = false;
              stream.getTracks().forEach(function(t) { t.stop(); });
              const raw = code.data.trim();
              let merchantId = raw;
              if (raw.indexOf('merchantId=') !== -1) {
                try { merchantId = new URL(raw).searchParams.get('merchantId') || raw; }
                catch (e) { const m = raw.match(/merchantId=([^&]+)/); if (m) merchantId = decodeURIComponent(m[1]); }
              }
              setStatus('QR detected — opening payment…');
              document.getElementById('qr-merchant-id').value = merchantId;
              form.submit();
              return;
            }
          }
        }
        requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);
    })
    .catch(function() {
      if (placeholderText) placeholderText.textContent = 'Camera unavailable';
      setStatus('Tap a merchant below to pay');
      if (fallback) fallback.open = true;
    });
}());

function initMerchantMap() {
  const el = document.querySelector('.match-map:not([data-map-ready])');
  if (!el || typeof L === 'undefined') return;
  const lat = Number(el.dataset.lat);
  const lng = Number(el.dataset.lng);
  if (!lat || !lng) return;
  el.setAttribute('data-map-ready', '1');
  const map = L.map(el, {
    center: [lat, lng], zoom: 17,
    zoomControl: false, scrollWheelZoom: false, attributionControl: false,
    dragging: !L.Browser.mobile, tap: false
  });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);
  const pin = L.divIcon({ html: '<div class="map-pin"></div>', iconSize: [28, 36], iconAnchor: [14, 36], className: '' });
  const label = document.createElement('span');
  label.textContent = el.dataset.name;
  if (el.dataset.address) {
    label.appendChild(document.createElement('br'));
    const address = document.createElement('small');
    address.textContent = el.dataset.address;
    label.appendChild(address);
  }
  // Leaflet's default popup maxWidth is 300px, which with its own padding renders ~329px wide and
  // is centred on the marker - wider than the card's map on a phone, so a long address was cut off
  // at the map's right edge. Bind it to the map's actual width instead, leaving room for the
  // rounded corners and the "Open in Google Maps" control.
  const popupMaxWidth = Math.max(150, Math.round(el.clientWidth) - 48);
  L.marker([lat, lng], { icon: pin }).addTo(map)
    .bindPopup(label, { closeButton: false, className: 'map-popup', maxWidth: popupMaxWidth, autoPan: false })
    .openPopup();
}

// Concise, non-blocking client-side trace for diagnosing Smart Match end-to-end (Sprint 1.8
// Step 24). There is no separate popup/modal in this app - the recommendation renders into
// the #smart-match `[data-match-region]` container on the Home page, swapped in below.
function smartMatchDebug(message) { console.info('Smart Match: ' + message); }

const matchRegion = document.querySelector('[data-match-region]');
const diningTimeForm = document.querySelector('[data-dining-time-form]');

function diningRecommendationQuery() {
  if (!diningTimeForm) return '';
  const input = diningTimeForm.querySelector('[name="diningDateTime"]');
  const value = input && input.value;
  // datetime-local is deliberately split as written. Do not construct a Date: that would convert
  // through the browser timezone instead of treating it as a Singapore calendar date and time.
  const match = typeof value === 'string' && value.match(/^(\d{4}-\d{2}-\d{2})T((?:[01]\d|2[0-3]):[0-5]\d)$/);
  if (!match) return null;
  const query = new URLSearchParams();
  query.set('diningDate', match[1]);
  query.set('diningTime', match[2]);
  // Only chips the user actively changed are sent; untouched defaults are never explicit overrides.
  chipState.params(query);
  return '?' + query.toString();
}

// Singapore dining date and time exactly as written in the datetime-local control (no Date object).
function diningParts() {
  if (!diningTimeForm) return null;
  const input = diningTimeForm.querySelector('[name="diningDateTime"]');
  const value = input && input.value;
  const match = typeof value === 'string' && value.match(/^(\d{4}-\d{2}-\d{2})T((?:[01]\d|2[0-3]):[0-5]\d)$/);
  return match ? { diningDate: match[1], diningTime: match[2] } : null;
}

// Loading copy only - no fake progress. If the match takes a while (e.g. preference checks),
// the message changes so the app never looks frozen. Backend timing is untouched.
let matchingStageTimer = null;
function clearMatchingStages() {
  if (matchingStageTimer) { window.clearTimeout(matchingStageTimer); matchingStageTimer = null; }
}
function matchingMarkup(again) {
  return '<div class="matching"><div class="matching-spinner" aria-hidden="true"></div><h2 data-matching-title>' +
    (again ? 'Finding something better…' : 'Finding catalogue matches…') + '</h2><p data-matching-sub>' +
    (again ? 'Using your feedback' : 'Checking stored catalogue information') +
    '</p><div class="skeleton" aria-hidden="true"><i></i><i></i><i></i></div></div>';
}
function startMatchingStages() {
  clearMatchingStages();
  matchingStageTimer = window.setTimeout(function() {
    const title = matchRegion.querySelector('[data-matching-title]');
    const sub = matchRegion.querySelector('[data-matching-sub]');
    if (title) title.textContent = 'Checking which places fit your preferences…';
    if (sub) sub.textContent = 'Hang tight — this can take a few seconds.';
  }, 4000);
}

function escHtml(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escAttr(str) {
  return escHtml(str).replace(/"/g, '&quot;');
}

const REC_REJECTION_REASONS = [
  { id: 'too-expensive', label: 'Too expensive' },
  { id: 'too-far', label: 'Too far' },
  { id: 'ate-recently', label: 'Not this cuisine' },
  { id: 'not-in-mood', label: 'Just not today' }
];

const DIETARY_LABELS = { halal: 'Halal', vegetarian: 'Vegetarian', vegan: 'Vegan' };

function activityText(activity) {
  if (!activity || activity.status === 'unavailable') return 'Usual activity unavailable — fictional sample history only.';
  if (activity.status === 'insufficient-data') return 'Not enough fictional sample history for this time.';
  if (activity.status === 'closed') return 'Historically closed at this time in the fictional sample.';
  if (activity.comparison === 'quieter') return 'Usually quieter at this time based on fictional sample history.';
  if (activity.comparison === 'busier') return 'Usually busier at this time based on fictional sample history.';
  return 'Usually typical at this time based on fictional sample history.';
}

function renderRecCard(r) {
  const tags = (r.dietary || []).map(function(d) { return DIETARY_LABELS[d]; }).filter(Boolean);
  const tagHtml = tags.map(function(t) { return '<span class="rec-tag">' + escHtml(t) + '</span>'; }).join('');
  const rewardHtml = r.campaign && Number.isFinite(r.campaign.rewardAmount) && Number.isFinite(r.campaign.minimumEligibleSpend)
    ? '<p class="rec-reward">Earn $' + escHtml(r.campaign.rewardAmount.toFixed(2)) + ' ' +
      escHtml(r.campaign.rewardLabel) + ' · Spend $' +
      escHtml(r.campaign.minimumEligibleSpend.toFixed(2)) + '+</p>'
    : '';
  const priceHtml = Number.isFinite(r.price) ? '<strong>$' + r.price.toFixed(2) + '</strong>' : 'unavailable';
  const distance = r.source === 'mysql' ? r.distanceLabel || 'Catalogue distance unavailable'
    : 'Approx. demo distance: ' + r.distanceMinutes + ' min-equivalent (not routed)';
  const sampleHtml = r.isSampleData === true ? '<p class="rec-meta">' +
    (r.source === 'mysql' ? 'Sample catalogue data' : 'Demo merchant') + '</p>' : '';
  const reasonHtml = REC_REJECTION_REASONS.map(function(reason) {
    return '<button type="submit" name="reason" value="' + escAttr(reason.id) + '">' +
      escHtml(reason.label) + '<span aria-hidden="true">→</span></button>';
  }).join('');
  const cuisineHtml = r.cuisine ? '<span class="rec-cuisine">Cuisine: ' + escHtml(r.cuisine) + '</span>' : '';
  const activityHtml = '<p class="rec-activity" data-activity-state="' +
    escAttr(r.usualActivity && r.usualActivity.status || 'unavailable') + '">' +
    escHtml(activityText(r.usualActivity)) + '</p>';
  const matchesHtml = Array.isArray(r.matchReasons) && r.matchReasons.length
    ? '<ul class="rec-reasons" aria-label="Why this matches">' + r.matchReasons.map(function(reason) {
      return '<li>' + escHtml(reason) + '</li>';
    }).join('') + '</ul>' : '';
  return '<article class="rec-card reveal" data-merchant-id="' + escAttr(r.id) + '">' +
    '<div class="rec-header">' +
    '<div class="rec-initial" aria-hidden="true">' + escHtml((r.merchantName || '').charAt(0)) + '</div>' +
    '<div class="rec-info">' +
    '<h2 class="rec-name">' + escHtml(r.merchantName) + '</h2>' +
    (r.recommendedMenuItem && Number.isFinite(r.recommendedMenuItem.price)
      ? '<p class="rec-dish" data-recommended-item>Recommended: ' + escHtml(r.recommendedMenuItem.name) + ' · <strong>$' +
        r.recommendedMenuItem.price.toFixed(2) + '</strong></p>' +
        '<p class="rec-meta">Recommended item price · Typical merchant price ' +
        (Number.isFinite(r.typicalPrice) ? '$' + r.typicalPrice.toFixed(2) : 'unavailable') + '</p>' +
        '<p class="rec-meta">' + escHtml(r.recommendedMenuItem.label) + '</p>'
      : r.itemName
      ? '<p class="rec-dish">' + escHtml(r.itemName) +
        (Number.isFinite(r.price) ? ' · ' + priceHtml : '') + '</p>'
      : '<p class="rec-dish">Typical price: ' + priceHtml + '</p>') +
    '<p class="rec-meta">' + (r.travel ? '' : escHtml(distance)) +
      (tagHtml ? (r.travel ? '' : ' · ') + tagHtml : '') + '</p>' +
    cuisineHtml +
    '</div>' +
    '</div>' +
    sampleHtml +
    renderGoogleRoute(r.travel, r.id) +
    activityHtml +
    matchesHtml +
    rewardHtml +
    '<form method="POST" action="/recommendation/accept" data-single-submit>' +
    '<input type="hidden" name="merchantId" value="' + escAttr(r.id) + '">' +
    '<button class="button" type="submit">Choose this</button>' +
    '</form>' +
    '<details class="feedback sheet-host">' +
    '<summary class="sheet-trigger">Not for me</summary>' +
    '<div class="result-sheet">' +
    '<span class="result-sheet-backdrop" data-sheet-backdrop></span>' +
    '<div class="result-sheet-panel feedback-sheet" role="group" aria-label="What didn\'t fit">' +
    '<div class="result-sheet-head"><h3>What didn\'t fit?</h3>' +
    '<button class="sheet-close" type="button" data-sheet-close>Close</button></div>' +
    '<form method="POST" action="/recommendation/reject" data-feedback>' +
    '<input type="hidden" name="merchantId" value="' + escAttr(r.id) + '">' +
    '<input type="hidden" name="feedbackToken" value="' + escAttr(r.feedbackToken || '') + '">' +
    reasonHtml +
    '<p class="feedback-status" data-feedback-status role="status"></p>' +
    '</form></div></div></details>' +
    '</article>';
}

// Google walking-route facts: facts, then the visible "Google Maps" attribution, then the required
// walking warning, all inside ONE visually distinct container (same structure as
// views/partials/google-walking.ejs). Nothing is shown without its warning. The directions link is
// added later, in browser memory only, and only while a live origin exists.
function renderGoogleRoute(travel, merchantId) {
  if (!travel || typeof travel.warning !== 'string' || !travel.warning) return '';
  const minutes = Number(travel.walkingMinutes);
  const metres = Number(travel.walkingMetres);
  if (!Number.isFinite(minutes) || !Number.isFinite(metres)) return '';
  return '<span class="google-route" data-google-route>' +
    '<span class="google-route__facts">About ' + escHtml(String(Math.round(minutes))) + ' min walk · ' +
    escHtml(String(Math.round(metres))) + ' m</span>' +
    '<span class="google-route__attribution" translate="no">Google Maps</span>' +
    '<span class="google-route__warning">' + escHtml(travel.warning) + '</span>' +
    '<span class="google-route__directions" data-directions-slot="' + escAttr(merchantId) + '"></span>' +
    '</span>';
}

// The ONLY place a Google Maps directions URL is built. The origin never leaves browser memory
// except inside this user-triggered link; the destination is a fictional sample merchant coordinate.
function buildDirectionsUrl(origin, destination) {
  const url = new URL('https://www.google.com/maps/dir/');
  url.searchParams.set('api', '1');
  url.searchParams.set('origin', origin.latitude + ',' + origin.longitude);
  url.searchParams.set('destination', destination.latitude + ',' + destination.longitude);
  url.searchParams.set('travelmode', 'walking');
  return url.href;
}

function attachDirectionLinks(slots, origin, destinations) {
  if (!origin) return;
  slots.forEach(function(slot) {
    const destination = destinations.get(slot.getAttribute('data-directions-slot'));
    if (!destination) return;
    const link = document.createElement('a');
    link.href = buildDirectionsUrl(origin, destination);
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.setAttribute('data-directions-link', '');
    link.textContent = 'Open walking directions';
    const note = document.createElement('span');
    note.className = 'google-route__note';
    note.textContent = 'Destination is a fictional sample merchant coordinate.';
    slot.textContent = '';
    slot.appendChild(link);
    slot.appendChild(note);
  });
}

function clearDirectionLinks(slots) {
  slots.forEach(function(slot) { slot.textContent = ''; });
}

function foodRequested(metadata) {
  const request = metadata && metadata.request;
  return Boolean(request && (request.foodCategory || (Array.isArray(request.dishTerms) && request.dishTerms.length)));
}

function renderRecommendationList(recommendations, catalogue, metadata) {
  const notice = catalogue && catalogue.source === 'demo-fallback'
    ? '<p class="report-note" role="status">Catalogue unavailable — showing demo merchants.</p>' : '';
  const activityNotice = metadata && metadata.activity && metadata.activity.status === 'unavailable'
    ? '<p class="report-note" role="status">Usual activity is unavailable. Recommendations remain based on suitable catalogue facts.</p>' : '';
  const emptyCatalogue = catalogue && catalogue.source === 'mysql' && catalogue.status === 'empty';
  if (!recommendations || !recommendations.length) {
    return notice + activityNotice + '<section class="card state-card reveal">' +
      '<div class="state-icon" aria-hidden="true">' +
      '<svg viewBox="0 0 24 24"><path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z"/>' +
      '<circle cx="12" cy="9.5" r="2.5"/></svg></div>' +
      (emptyCatalogue ? '<h2>No merchants in the catalogue</h2><p>The catalogue is currently empty.</p>'
        : foodRequested(metadata)
        ? '<h2>No sample menu item fits</h2><p>Nothing on the fictional sample menu matches your food choice with your other filters.</p>' +
          '<button class="button" type="button" data-clear-food>Clear food choice</button>'
        : '<h2>No matches for your filters</h2><p>Try widening your distance or budget in <a href="/profile">Profile</a>.</p>') +
      '</section>';
  }
  return notice + activityNotice + '<div class="rec-list">' + recommendations.map(renderRecCard).join('') + '</div>';
}

// ---------------------------------------------------------------------------
// Live starting point (Jolene Step 6). The origin exists ONLY in this closure's memory: never in
// localStorage, sessionStorage, cookies, a URL, an HTML attribute or a console message. It is sent
// once per request in a POST body, cleared on errors and when switching to the RP demo origin, and
// gone after a reload (which returns to the labelled RP demo origin).
// ---------------------------------------------------------------------------
function requestLiveOrigin() {
  return new Promise(function(resolve) {
    if (!navigator.geolocation) return resolve({ ok: false, reason: 'unsupported' });
    navigator.geolocation.getCurrentPosition(function(position) {
      const accuracy = position && position.coords && position.coords.accuracy;
      // Anything worse than 150 metres (or an unknown accuracy) is rejected.
      if (!(accuracy <= 150)) return resolve({ ok: false, reason: 'inaccurate' });
      resolve({ ok: true, location: { latitude: position.coords.latitude, longitude: position.coords.longitude } });
    }, function(error) {
      const code = error && error.code;
      resolve({ ok: false, reason: code === 1 ? 'denied' : code === 3 ? 'timeout' : 'unavailable' });
    }, { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 });
  });
}

const ORIGIN_MESSAGES = {
  denied: 'Location permission was denied. Search for a place instead, or use the RP demo origin.',
  unavailable: 'Your location is unavailable. Search for a place instead, or use the RP demo origin.',
  timeout: 'Finding your location took too long. Search for a place instead, or use the RP demo origin.',
  inaccurate: 'Your location is not accurate enough for walking times (within 150 m is needed). Search for a place instead, or use the RP demo origin.',
  unsupported: 'This browser cannot share a location. Search for a place instead, or use the RP demo origin.',
  places: 'Place search could not load. Use your location or the RP demo origin.',
  unconfigured: 'Place search is not available right now. Use your location or the RP demo origin.',
  'walking-routes-not-configured': 'Google Maps walking times are not available right now.',
  'walking-routes-timeout': 'Google Maps walking times took too long.',
  'walking-routes-rate-limited': 'Google Maps walking times are busy right now.',
  'walking-routes-provider-failure': 'Google Maps walking times are unavailable right now.',
  'walking-routes-invalid-response': 'Google Maps walking times could not be read.',
  'live-recommendation-unavailable': 'Recommendations are unavailable right now.',
  'location-request-rate-limited': 'Too many walking-time requests. Please wait a moment.',
  'invalid-recommendation-input': 'That starting point could not be used. Choose a place in Singapore.',
  'menu-catalogue-unavailable': 'The sample menu is unavailable right now. Try Anything or use the manual filters.'
};
const ORIGIN_RECOVERY = ' Your previous results are unchanged. Choose a starting point again, or use the RP demo origin.';

async function loadMatch(again) {
  if (!matchRegion) return;
  if (originModule.isLive()) return originModule.loadLive();
  const query = diningRecommendationQuery();
  if (query === null) {
    matchRegion.innerHTML = '<p class="error" role="status">Choose a valid Singapore dining date and time.</p>';
    return;
  }
  matchRegion.setAttribute('aria-busy', 'true');
  chipState.setBusy(true);
  matchRegion.innerHTML = matchingMarkup(again);
  startMatchingStages();
  // Catalogue distances are estimates from the demo origin, not device GPS.
  try {
    const results = await Promise.all([
      fetch('/api/recommend' + query).then(async function(response) {
        smartMatchDebug('recommend request status: ' + response.status);
        const body = await response.json();
        if (!response.ok) throw new Error(response.status === 400 ? 'Invalid recommendation filters' : 'Unable to load recommendations');
        return body;
      }),
      wait(2000)
    ]);
    clearMatchingStages();
    matchRegion.innerHTML = renderRecommendationList(results[0].recommendations, results[0].catalogue, results[0].metadata);
    const cards = matchRegion.querySelectorAll('[data-merchant-id]');
    smartMatchDebug('recommendations rendered: ' + cards.length);
    initMerchantMap();
  } catch (error) {
    smartMatchDebug('load failed: ' + error.message);
    clearMatchingStages();
    matchRegion.innerHTML = '<section class="card state-card reveal"><div class="state-icon" aria-hidden="true">' +
      '<svg viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 4v5h-5"/></svg></div>' +
      '<h2>Let\'s try that again.</h2><p>We couldn\'t load a match just now.</p>' +
      '<a class="button" href="/home">Return Home</a></section>';
  }
  matchRegion.setAttribute('aria-busy', 'false');
  chipState.setBusy(false);
}
const originModule = (function() {
  const panel = document.querySelector('[data-origin-panel]');
  const modeEl = panel && panel.querySelector('[data-origin-mode]');
  const statusEl = panel && panel.querySelector('[data-origin-status]');
  const demoButton = panel && panel.querySelector('[data-origin-demo]');
  const searchBox = panel && panel.querySelector('[data-origin-search]');
  let origin = null;
  let label = '';
  let source = '';
  const destinations = new Map();
  let autocomplete = null;
  let placesPromise = null;

  function slots() { return Array.prototype.slice.call(document.querySelectorAll('[data-directions-slot]')); }
  function setStatus(message, isError) {
    if (!statusEl) return;
    statusEl.textContent = message || '';
    statusEl.hidden = !message;
    statusEl.classList.toggle('error', Boolean(message) && Boolean(isError));
  }
  function describeMode() {
    if (!modeEl) return;
    modeEl.textContent = !origin ? 'RP demo origin: estimated distances, not routed walking times.'
      : source === 'device' ? 'Your current location: Google Maps walking times (kept only in this tab).'
      : 'Starting place: ' + label + ' (Google Maps walking times, kept only in this tab).';
    if (demoButton) demoButton.hidden = !origin;
  }
  function clear() {
    origin = null; label = ''; source = '';
    destinations.clear();
    clearDirectionLinks(slots());
    describeMode();
  }
  function set(location, kind, name) {
    origin = { latitude: location.latitude, longitude: location.longitude };
    source = kind;
    label = String(name || '').slice(0, 120);
    describeMode();
  }
  function rememberDestinations(recommendations) {
    destinations.clear();
    (recommendations || []).forEach(function(r) {
      const d = r && r.travel && r.travel.sampleDestination;
      if (d && Number.isFinite(d.latitude) && Number.isFinite(d.longitude)) {
        destinations.set(r.id, { latitude: d.latitude, longitude: d.longitude });
      }
    });
  }
  function afterRender(recommendations) {
    rememberDestinations(recommendations);
    attachDirectionLinks(slots(), origin, destinations);
  }
  function messageFor(code) { return ORIGIN_MESSAGES[code] || 'Google Maps walking times are unavailable right now.'; }
  function isTravelCode(code) {
    return typeof code === 'string' && (/^walking-routes-/.test(code) || code === 'location-request-rate-limited' ||
      code === 'live-recommendation-unavailable');
  }
  // Any failed live request clears the origin. The previous results stay on screen, unchanged.
  function failed(body) {
    const code = body && body.error && typeof body.error.code === 'string' ? body.error.code : '';
    clear();
    setStatus(messageFor(code) + ORIGIN_RECOVERY, true);
  }
  function showResults(body) {
    setStatus('', false);
    matchRegion.innerHTML = renderRecommendationList(body.recommendations, body.catalogue, body.metadata);
    afterRender(body.recommendations);
    initMerchantMap();
  }
  async function loadLive() {
    const parts = diningParts();
    if (!parts) { setStatus('Choose a valid Singapore dining date and time.', true); return; }
    matchRegion.setAttribute('aria-busy', 'true');
    chipState.setBusy(true);
    setStatus('Finding Google Maps walking times…', false);
    try {
      const response = await fetch('/api/recommend/live', { method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({ location: { latitude: origin.latitude, longitude: origin.longitude },
          diningDate: parts.diningDate, diningTime: parts.diningTime }, chipState.params({}))) });
      let body = null;
      try { body = await response.json(); } catch (error) { body = null; }
      if (!response.ok || !body || !Array.isArray(body.recommendations)) { failed(body); return; }
      showResults(body);
    } catch (error) {
      failed(null);
    } finally {
      matchRegion.setAttribute('aria-busy', 'false');
      chipState.setBusy(false);
    }
  }
  async function useDevice() {
    setStatus('Requesting your location…', false);
    const result = await requestLiveOrigin();
    if (!result.ok) { setStatus(ORIGIN_MESSAGES[result.reason] || ORIGIN_MESSAGES.unavailable, true); return; }
    set(result.location, 'device', '');
    await loadMatch(false);
  }
  function loadPlaces(key) {
    if (placesPromise) return placesPromise;
    placesPromise = new Promise(function(resolve, reject) {
      function ready() {
        window.google.maps.importLibrary('places').then(resolve, reject);
      }
      if (window.google && window.google.maps && window.google.maps.importLibrary) return ready();
      const script = document.createElement('script');
      script.src = 'https://maps.googleapis.com/maps/api/js?' + new URLSearchParams({ key: key, loading: 'async', v: 'weekly' }).toString();
      script.async = true;
      script.onload = ready;
      script.onerror = function() { reject(new Error('places script')); };
      document.head.appendChild(script);
    }).catch(function(error) { placesPromise = null; throw error; });
    return placesPromise;
  }
  async function usePlace() {
    const key = panel.getAttribute('data-maps-browser-key');
    if (!key) { setStatus(ORIGIN_MESSAGES.unconfigured, true); return; }
    setStatus('Loading place search…', false);
    try {
      const library = await loadPlaces(key);
      if (!autocomplete) {
        autocomplete = new library.PlaceAutocompleteElement({});
        // Singapore only, biased towards Republic Polytechnic. Google's own attribution is left untouched.
        autocomplete.includedRegionCodes = ['sg'];
        autocomplete.locationBias = { center: { lat: 1.4428, lng: 103.7854 }, radius: 20000 };
        autocomplete.addEventListener('gmp-select', async function(event) {
          try {
            const place = event.placePrediction.toPlace();
            await place.fetchFields({ fields: ['location', 'displayName'] });
            set({ latitude: place.location.lat(), longitude: place.location.lng() }, 'place', place.displayName);
            await loadMatch(false);
          } catch (error) {
            clear();
            setStatus(ORIGIN_MESSAGES.places + ORIGIN_RECOVERY, true);
          }
        });
        searchBox.appendChild(autocomplete);
      }
      searchBox.hidden = false;
      setStatus('', false);
    } catch (error) {
      clear();
      setStatus(ORIGIN_MESSAGES.places, true);
    }
  }
  if (panel) {
    panel.querySelector('[data-origin-device]').addEventListener('click', useDevice);
    panel.querySelector('[data-origin-place]').addEventListener('click', usePlace);
    demoButton.addEventListener('click', function() {
      clear();
      searchBox.hidden = true;
      setStatus('', false);
      loadMatch(false);
    });
    describeMode();
  }
  return {
    isLive: function() { return Boolean(origin); },
    loadLive: loadLive, failed: failed, afterRender: afterRender, messageFor: messageFor, isTravelCode: isTravelCode,
    withLocation: function(payload) {
      return origin ? Object.assign({}, payload, { location: { latitude: origin.latitude, longitude: origin.longitude } }) : payload;
    }
  };
})();

// ---------------------------------------------------------------------------
// Natural-language request (Jolene Step 5). The server asks an LLM only to extract constraints;
// fixed rules choose merchants. Every value shown here (typed text, interpretation chips, unsupported
// phrases) is untrusted and is written with textContent only - never innerHTML.
// ---------------------------------------------------------------------------
const nlForm = document.querySelector('[data-nl-form]');
const NL_ERROR_MESSAGES = {
  'invalid-natural-language-input': 'Enter a request of up to 200 characters.',
  'natural-language-not-configured': 'AI interpretation is not available right now. Use the manual filters instead.',
  'natural-language-timeout': 'The AI took too long. Your text is kept; try again or use the manual filters.',
  'natural-language-provider-failure': 'The AI service is unavailable right now. Your text is kept; try again or use the manual filters.',
  'natural-language-invalid-output': 'We could not safely understand that request. Try rephrasing it or use the manual filters.',
  'natural-language-no-usable-constraint': 'No supported constraint was found (budget, distance, cuisine, dietary, day or time). Try rephrasing or use the manual filters.',
  'natural-language-rate-limited': 'Too many requests. Please wait a moment and try again.',
  'natural-language-conflicts-with-selection': 'Your typed request and your selected choices disagree. Change one of them and try again.',
  'menu-catalogue-unavailable': 'The sample menu is unavailable right now. Try Anything or use the manual filters.',
  'natural-language-recommendation-unavailable': 'We understood your request but could not load recommendations just now. Your text is kept; try again or use the manual filters.'
};

function nlSetStatus(form, message, isError) {
  const status = form.querySelector('[data-nl-status]');
  status.textContent = message || '';
  status.hidden = !message;
  status.classList.toggle('error', Boolean(message) && Boolean(isError));
}

function nlAppendList(box, headingText, className, lines) {
  const heading = document.createElement('p');
  heading.className = 'nl-heading';
  heading.textContent = headingText;
  box.appendChild(heading);
  const list = document.createElement('ul');
  list.className = className;
  lines.forEach(function(line) {
    const item = document.createElement('li');
    item.textContent = line;
    list.appendChild(item);
  });
  box.appendChild(list);
}

function nlRenderInterpretation(form, interpretation, fallbackNotApplied) {
  const box = form.querySelector('[data-nl-understood]');
  box.textContent = '';
  const understood = interpretation && Array.isArray(interpretation.understood) ? interpretation.understood : [];
  const notApplied = interpretation && Array.isArray(interpretation.notApplied) ? interpretation.notApplied
    : Array.isArray(fallbackNotApplied) ? fallbackNotApplied : [];
  if (understood.length) {
    nlAppendList(box, 'Understood as', 'nl-chips', understood.map(function(item) {
      return String(item.label) + ': ' + String(item.value);
    }));
  }
  if (notApplied.length) nlAppendList(box, 'Not applied', 'nl-notapplied', notApplied.map(String));
  box.hidden = !(understood.length || notApplied.length);
}

async function submitNaturalLanguage(form) {
  const input = form.querySelector('[name="text"]');
  const button = form.querySelector('[data-nl-submit]');
  const text = input.value.trim();
  if (text.length > 200) {
    nlSetStatus(form, NL_ERROR_MESSAGES['invalid-natural-language-input'], true);
    return;
  }
  if (!text) {
    // No typed request: the chips, dining time and starting point drive the same deterministic engine.
    nlSetStatus(form, '', false);
    await loadMatch(false);
    return;
  }
  form.setAttribute('aria-busy', 'true');
  button.disabled = true;
  chipState.setBusy(true);
  nlSetStatus(form, 'Interpreting your request…', false);
  try {
    const response = await fetch('/api/recommend/natural', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(originModule.withLocation(Object.assign({ text: text }, chipState.params({})))) });
    let body = null;
    try { body = await response.json(); } catch (error) { body = null; }
    if (!response.ok || !body || !Array.isArray(body.recommendations)) {
      const code = body && body.error && typeof body.error.code === 'string' ? body.error.code : '';
      if (originModule.isTravelCode(code)) {
        // A walking-time failure clears the in-memory origin; the typed text and current results stay.
        originModule.failed(body);
        nlSetStatus(form, originModule.messageFor(code), true);
        nlRenderInterpretation(form, null, null);
        return;
      }
      // Typed text and manual filters stay as they are; the current recommendations are left untouched.
      nlSetStatus(form, NL_ERROR_MESSAGES[code] || 'Something went wrong. Use the manual filters instead.', true);
      nlRenderInterpretation(form, null, body && body.notApplied);
      return;
    }
    nlSetStatus(form, '', false);
    nlRenderInterpretation(form, body.interpretation, null);
    const resolved = body.interpretation && body.interpretation.resolved;
    const dining = diningTimeForm && diningTimeForm.querySelector('[name="diningDateTime"]');
    if (dining && resolved && /^\d{4}-\d{2}-\d{2}$/.test(resolved.diningDate) && /^\d{2}:\d{2}$/.test(resolved.diningTime)) {
      dining.value = resolved.diningDate + 'T' + resolved.diningTime;
    }
    clearMatchingStages();
    matchRegion.innerHTML = renderRecommendationList(body.recommendations, body.catalogue, body.metadata);
    originModule.afterRender(body.recommendations);
    matchRegion.setAttribute('aria-busy', 'false');
    initMerchantMap();
  } catch (error) {
    nlSetStatus(form, 'We could not reach the server. Your text is kept; try again or use the manual filters.', true);
  } finally {
    form.setAttribute('aria-busy', 'false');
    button.disabled = false;
    chipState.setBusy(false);
  }
}
// ---------------------------------------------------------------------------
// Food and dietary chips (Task 7). Each group is untouched (its default is shown as pressed but is NOT sent)
// or active (the user changed it). Tapping the active chip returns the group to untouched. Only active
// groups are sent as explicit overrides; nothing here writes the saved profile. Chip state lives in this
// closure only.
// ---------------------------------------------------------------------------
const chipState = (function() {
  const groups = {};
  Array.prototype.slice.call(document.querySelectorAll('[data-chip-group]')).forEach(function(element) {
    groups[element.getAttribute('data-chip-group')] = { element: element, fallback: element.getAttribute('data-chip-default'),
      active: null, buttons: Array.prototype.slice.call(element.querySelectorAll('[data-chip-value]')) };
  });
  function render(name) {
    const group = groups[name];
    const shown = group.active === null ? group.fallback : group.active;
    group.buttons.forEach(function(button) {
      const pressed = button.getAttribute('data-chip-value') === shown;
      button.setAttribute('aria-pressed', pressed ? 'true' : 'false');
      button.classList.toggle('is-default', pressed && group.active === null);
    });
  }
  function press(name, value) {
    const group = groups[name];
    if (group.active === value) group.active = null;
    else if (group.active === null && value === group.fallback) return;
    else group.active = value;
    render(name);
  }
  Object.keys(groups).forEach(function(name) {
    groups[name].element.addEventListener('click', function(event) {
      const button = event.target.closest('[data-chip-value]');
      if (button && !button.disabled) press(name, button.getAttribute('data-chip-value'));
    });
    render(name);
  });
  function params(target) {
    const set = function(key, value) { if (typeof target.set === 'function') target.set(key, value); else target[key] = value; };
    if (groups.food && groups.food.active !== null) set('foodCategory', groups.food.active);
    if (groups.dietary && groups.dietary.active !== null) set('dietaryPreference', groups.dietary.active);
    return target;
  }
  return {
    params: params,
    setBusy: function(busy) {
      Object.keys(groups).forEach(function(name) {
        groups[name].element.setAttribute('aria-busy', busy ? 'true' : 'false');
        groups[name].buttons.forEach(function(button) { button.disabled = Boolean(busy); });
      });
    },
    clearFood: function() { if (groups.food) { groups.food.active = null; render('food'); } }
  };
})();

document.addEventListener('click', function(event) {
  if (event.target.closest && event.target.closest('[data-clear-food]')) {
    chipState.clearFood();
    loadMatch(false);
  }
});

if (nlForm) nlForm.addEventListener('submit', function(event) {
  event.preventDefault();
  submitNaturalLanguage(nlForm);
});

if (diningTimeForm) diningTimeForm.addEventListener('submit', function(event) {
  event.preventDefault();
  loadMatch(false);
});
if (document.querySelector('[data-load-match]')) loadMatch(location.search.includes('matching=again'));
initMerchantMap();

// ---------------------------------------------------------------------------
// Result bottom sheets ("Edit filters" / "Not for me"). Plain <details> elements, so they open and
// close from the keyboard with no JavaScript at all; this only adds the behaviour a sheet needs on
// top of that: one sheet at a time, Escape and backdrop close, focus moved into the panel and
// handed back to the trigger afterwards.
// ---------------------------------------------------------------------------
let sheetReturnFocus = null;

function closeSheet(host, restoreFocus) {
  if (!host || !host.open) return;
  host.open = false;
  const trigger = host.querySelector('summary');
  if (restoreFocus && trigger) trigger.focus();
}

function closeOpenSheets(except, restoreFocus) {
  document.querySelectorAll('.sheet-host[open]').forEach(function(host) {
    if (host !== except) closeSheet(host, restoreFocus);
  });
}

// `toggle` does not bubble, so it is captured at the document level instead of bound per sheet -
// this keeps working for a card that Smart Match swaps in later.
document.addEventListener('toggle', function(event) {
  const host = event.target;
  if (!host.matches || !host.matches('.sheet-host')) return;
  if (!host.open) return;
  closeOpenSheets(host, false);
  sheetReturnFocus = host.querySelector('summary');
  const panel = host.querySelector('.result-sheet-panel');
  if (!panel) return;
  const first = panel.querySelector('input, select, textarea, button, a[href]');
  if (first) first.focus({ preventScroll: true });
}, true);

document.addEventListener('click', function(event) {
  const target = event.target;
  if (!target.closest) return;
  if (target.closest('[data-sheet-backdrop], [data-sheet-close]')) {
    closeSheet(target.closest('.sheet-host'), true);
  }
});

document.addEventListener('keydown', function(event) {
  if (event.key !== 'Escape') return;
  const open = document.querySelector('.sheet-host[open]');
  if (open) { event.preventDefault(); closeSheet(open, true); }
});

// A reason button both selects and submits feedback. No extra confirmation.
document.addEventListener('submit', async function(event) {
  const form = event.target;
  if (!form.matches('[data-feedback]')) return;
  event.preventDefault();
  if (form.dataset.busy) return;
  const data = new FormData(form);
  data.set('reason', event.submitter.value);
  form.dataset.busy = 'true';
  const status = form.querySelector('[data-feedback-status]');
  if (status) status.textContent = '';
  try {
    const response = await fetch(form.action, {
      method: 'POST', headers: { 'X-Requested-With': 'smart-match' },
      body: new URLSearchParams(data)
    });
    if (!response.ok) {
      if (status) status.textContent = response.status === 503
        ? 'We could not save that yet. Please try again.'
        : 'This recommendation changed. Refresh Home and try again.';
      return;
    }
    await loadMatch(true);
  } catch (error) {
    if (status) status.textContent = 'We could not save that yet. Please try again.';
  } finally {
    delete form.dataset.busy;
  }
});

const paymentForm = document.querySelector('[data-payment]');
if (paymentForm) {
  const amountInput = paymentForm.querySelector('[name="amount"]');
  const checkbox = paymentForm.querySelector('[name="useCashback"]');
  const eligibility = paymentForm.querySelector('[data-reward-eligibility]');
  function updateTotal() {
    const amount = Number(amountInput ? amountInput.value : paymentForm.dataset.amount);
    const valid = Number.isFinite(amount) && amount > 0 && amount <= 1000;
    const cents = valid ? Math.round(amount * 100) : 0;
    const maximumCashback = Math.max(0, cents - 100);
    const used = checkbox && checkbox.checked ? Math.min(Math.round(Number(paymentForm.dataset.balance) * 100), maximumCashback) : 0;
    const paid = (cents - used) / 100;
    paymentForm.querySelector('[data-purchase-amount]').textContent = '$' + (cents / 100).toFixed(2);
    const creditUsed = paymentForm.querySelector('[data-cashback-used]');
    if (creditUsed) creditUsed.textContent = used > 0 ? '−$' + (used / 100).toFixed(2) : 'Not applied';
    paymentForm.querySelector('[data-nets-total]').textContent = '$' + paid.toFixed(2);
    paymentForm.querySelector('[data-pay-button]').textContent = valid ? 'Pay $' + paid.toFixed(2) : 'Pay';
    if (eligibility) {
      const minimum = Number(eligibility.dataset.minimumSpend);
      const reward = Number(eligibility.dataset.rewardAmount).toFixed(2);
      const merchant = eligibility.dataset.merchantName;
      eligibility.classList.toggle('is-ineligible', valid && amount < minimum);
      if (!valid) {
        eligibility.textContent = 'Earn $' + reward + ' ' + merchant + ' Vouch Credit. Once daily · Spend $' + minimum.toFixed(2) + '+ and keep at least $1 paid with NETS.';
      } else if (amount < minimum) {
        eligibility.textContent = "This payment won't earn Vouch Credit. Minimum spend is $" + minimum.toFixed(2) + '.';
      } else if (paid < 1) {
        eligibility.textContent = "This payment won't earn Vouch Credit. Keep at least $1 paid with NETS.";
      } else {
        eligibility.textContent = "You'll earn $" + reward + ' ' + merchant + ' Vouch Credit.';
      }
    }
  }
  paymentForm.addEventListener('input', updateTotal);
  updateTotal();
}

// Every share action uses the same claimable Vouch link.
const shareGrid = document.querySelector('[data-share-path]');
if (shareGrid) {
  async function copyShareLink(link) {
    try {
      await navigator.clipboard.writeText(link);
    } catch (error) {
      const input = document.createElement('textarea');
      input.value = link; input.setAttribute('readonly', ''); input.style.position = 'fixed'; input.style.opacity = '0';
      document.body.appendChild(input); input.select(); document.execCommand('copy'); input.remove();
    }
  }
  shareGrid.addEventListener('click', async function(event) {
    const button = event.target.closest('[data-share-platform]');
    if (!button) return;
    const link = new URL(shareGrid.dataset.sharePath, window.location.origin).href;
    const text = 'I Vouched for ' + shareGrid.dataset.shareMerchant + ' on NETS Vouch. Claim the offer: ';
    const platform = button.dataset.sharePlatform;
    if (platform === 'copy') {
      await copyShareLink(link);
    } else {
      const shareUrl = platform === 'whatsapp'
        ? 'https://wa.me/?text=' + encodeURIComponent(text + link)
        : 'https://t.me/share/url?url=' + encodeURIComponent(link) + '&text=' + encodeURIComponent(text);
      const opened = window.open(shareUrl, '_blank', 'noopener,noreferrer');
      if (!opened) await copyShareLink(link);
    }
    const status = document.querySelector('.share-status');
    status.textContent = platform === 'copy' ? 'Link copied' : 'Share ready — link copied as backup';
  });
}

// Capture the clicked action BEFORE disabling controls. Keeps Vouch/Skip values intact.
document.addEventListener('submit', function(event) {
  const form = event.target;
  if (form.matches('[data-confirm-reset]') && !form.dataset.confirmed) {
    event.preventDefault();
    const dialog = document.querySelector('[data-reset-dialog]');
    if (dialog && typeof dialog.showModal === 'function') {
      dialog.addEventListener('close', function() {
        if (dialog.returnValue !== 'confirm') return;
        form.dataset.confirmed = 'true';
        HTMLFormElement.prototype.submit.call(form);
      }, { once: true });
      dialog.showModal();
    } else if (window.confirm('Reset the entire demo? This clears all active visitor sessions and live demo data.')) {
      HTMLFormElement.prototype.submit.call(form);
    }
    return;
  }
  if (!form.matches('[data-single-submit], [data-payment], [data-scan]')) return;
  event.preventDefault();
  if (form.dataset.busy) return;
  if (!form.reportValidity()) return;
  if (form.matches('[data-payment]')) {
    const input = form.querySelector('[name="amount"]');
    if (input && (!/^\d+(\.\d{1,2})?$/.test(input.value.trim()) || Number(input.value) > 1000 || Number(input.value) <= 0)) {
      input.setCustomValidity('Enter $0.01–$1,000 with up to two decimal places.');
      input.reportValidity();
      input.addEventListener('input', function() { input.setCustomValidity(''); }, { once: true });
      return;
    }
  }
  form.dataset.busy = 'true';
  if (event.submitter && event.submitter.name) {
    const action = document.createElement('input');
    action.type = 'hidden'; action.name = event.submitter.name; action.value = event.submitter.value;
    form.appendChild(action);
  }
  form.querySelectorAll('button[type="submit"]').forEach(function(button) { button.disabled = true; });
  let delay = 0;
  if (form.matches('[data-payment], [data-scan]')) {
    form.classList.add('is-processing');
    const status = form.querySelector('.form-status');
    status.textContent = form.matches('[data-scan]') ? 'Scanning...' : 'Processing NETS payment...';
    delay = form.matches('[data-scan]') ? 900 : 800;
  }
  window.setTimeout(function() { HTMLFormElement.prototype.submit.call(form); }, delay);
});

// A cached page must not leave its buttons disabled when the user returns.
window.addEventListener('pageshow', function(event) {
  if (event.persisted) window.location.reload();
});

// Simulated iOS status bar clock (presentation only).
const statusTime = document.querySelector('[data-status-time]');
if (statusTime) {
  const renderTime = function() {
    const now = new Date();
    statusTime.textContent = now.getHours() + ':' + String(now.getMinutes()).padStart(2, '0');
  };
  renderTime();
  window.setInterval(renderTime, 30000);
}

// Close the header account menu when tapping anywhere outside it.
document.addEventListener('click', function(event) {
  document.querySelectorAll('.account-menu[open]').forEach(function(menu) {
    if (!menu.contains(event.target)) menu.removeAttribute('open');
  });
});

// Merchant picker: changing the dropdown loads that merchant's page straight away, so the dietary
// and campaign forms below can never still be holding the previously rendered merchant's hidden ID.
// The Switch button remains the no-JavaScript fallback.
document.addEventListener('change', function(event) {
  const select = event.target.closest('[data-auto-submit] select');
  if (!select) return;
  const form = select.closest('form');
  if (form) form.submit();
});
