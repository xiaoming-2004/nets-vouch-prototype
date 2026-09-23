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
  L.marker([lat, lng], { icon: pin }).addTo(map).bindPopup(label, { closeButton: false, className: 'map-popup' }).openPopup();
}

// Concise, non-blocking client-side trace for diagnosing Smart Match end-to-end (Sprint 1.8
// Step 24). There is no separate popup/modal in this app - the recommendation renders into
// the #smart-match `[data-match-region]` container on the Home page, swapped in below.
function smartMatchDebug(message) { console.info('Smart Match: ' + message); }

const matchRegion = document.querySelector('[data-match-region]');

// Asks the device for its CURRENT position - never a cached one (maximumAge: 0) - every time a
// new Smart Match discovery starts. Returns the coordinates, or null on any failure. Does NOT
// silently fall back to a demo location; the caller decides what to show on failure.
function requestCurrentPosition() {
  return new Promise(function(resolve) {
    if (!navigator.geolocation) { smartMatchDebug('geolocation unsupported'); return resolve(null); }
    navigator.geolocation.getCurrentPosition(function(position) {
      smartMatchDebug('geolocation success');
      resolve({ latitude: position.coords.latitude, longitude: position.coords.longitude });
    }, function() { smartMatchDebug('geolocation denied/failed'); resolve(null); }, {
      enableHighAccuracy: true, maximumAge: 0, timeout: 10000
    });
  });
}

// Resolves true once THIS user's current device coordinates are stored server-side, or false if
// geolocation failed and the caller must show an explicit retry/demo-location choice - it must
// never guess a location on the user's behalf.
async function prepareDiscoveryLocation() {
  if (!matchRegion || matchRegion.dataset.locationReady === 'true') return true;
  const location = await requestCurrentPosition();
  if (!location) return false;
  try {
    const response = await fetch('/smart-match/location', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(location)
    });
    smartMatchDebug('location request status: ' + response.status);
  } catch (error) { return false; }
  matchRegion.dataset.locationReady = 'true';
  return true;
}

function renderLocationNeeded() {
  clearMatchingStages();
  matchRegion.innerHTML = '<section class="card state-card reveal"><div class="state-icon" aria-hidden="true">' +
    '<svg viewBox="0 0 24 24"><path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg></div>' +
    '<h2>Location needed</h2><p>We use your location to find places nearby.</p>' +
    '<button class="button" type="button" data-retry-location>Try again</button>' +
    '<button class="text-button" type="button" data-use-demo-location>Use demo location</button></section>';
  matchRegion.setAttribute('aria-busy', 'false');
}

// Loading copy only - no fake progress. If the match takes a while (e.g. preference checks),
// the message changes so the app never looks frozen. Backend timing is untouched.
let matchingStageTimer = null;
function clearMatchingStages() {
  if (matchingStageTimer) { window.clearTimeout(matchingStageTimer); matchingStageTimer = null; }
}
function matchingMarkup(again) {
  return '<div class="matching"><div class="matching-spinner" aria-hidden="true"></div><h2 data-matching-title>' +
    (again ? 'Finding something better…' : 'Finding nearby places…') + '</h2><p data-matching-sub>' +
    (again ? 'Using your feedback' : 'Checking what\'s around you right now') +
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

// Only an explicit tap on "Use demo location" may put Smart Match into the demo fallback -
// it is never chosen automatically on the user's behalf.
async function useDemoLocation() {
  try {
    await fetch('/smart-match/location', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'fallback' })
    });
  } catch (error) { /* loadMatch's own error state covers a failed request here. */ }
  matchRegion.dataset.locationReady = 'true';
  loadMatch(false);
}

async function loadMatch(again) {
  if (!matchRegion) return;
  matchRegion.setAttribute('aria-busy', 'true');
  matchRegion.innerHTML = matchingMarkup(again);
  startMatchingStages();
  const locationReady = await prepareDiscoveryLocation();
  if (!locationReady) { renderLocationNeeded(); return; }
  try {
    const results = await Promise.all([
      fetch('/smart-match/result').then(function(response) {
        smartMatchDebug('result request status: ' + response.status);
        if (!response.ok) throw new Error('Unable to load match');
        return response.text();
      }),
      wait(1800)
    ]);
    clearMatchingStages();
    matchRegion.innerHTML = results[0];
    const card = matchRegion.querySelector('[data-merchant-id]');
    smartMatchDebug('recommendation rendered: ' + (card ? 'yes (' + card.dataset.merchantId + ')' : 'no (empty state)'));
    initMerchantMap();
  } catch (error) {
    smartMatchDebug('load failed: ' + error.message);
    clearMatchingStages();
    matchRegion.innerHTML = '<section class="card state-card reveal"><div class="state-icon" aria-hidden="true">' +
      '<svg viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 4v5h-5"/></svg></div>' +
      '<h2>Let’s try that again.</h2><p>We couldn’t load a match just now.</p><a class="button" href="/home">Return Home</a></section>';
  }
  matchRegion.setAttribute('aria-busy', 'false');
}
if (matchRegion) {
  matchRegion.addEventListener('click', function(event) {
    if (event.target.closest('[data-retry-location]')) loadMatch(false);
    else if (event.target.closest('[data-use-demo-location]')) useDemoLocation();
  });
}
if (document.querySelector('[data-load-match]')) loadMatch(location.search.includes('matching=again'));
initMerchantMap();

// A reason button both selects and submits feedback. No extra confirmation.
document.addEventListener('submit', async function(event) {
  const form = event.target;
  if (!form.matches('[data-feedback]')) return;
  event.preventDefault();
  if (form.dataset.busy) return;
  const data = new FormData(form);
  data.set('reason', event.submitter.value);
  form.dataset.busy = 'true';
  try {
    const response = await fetch(form.action, {
      method: 'POST', headers: { 'X-Requested-With': 'smart-match' },
      body: new URLSearchParams(data)
    });
    if (!response.ok) throw new Error('Feedback state changed');
    await loadMatch(true);
  } catch (error) { window.location.assign('/home'); }
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
