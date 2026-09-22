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

const matchRegion = document.querySelector('[data-match-region]');
async function prepareDiscoveryLocation() {
  if (!matchRegion || matchRegion.dataset.locationReady === 'true') return;
  const location = await new Promise(function(resolve) {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(function(position) {
      resolve({ latitude: position.coords.latitude, longitude: position.coords.longitude });
    }, function() { resolve(null); }, {
      enableHighAccuracy: false, timeout: 5000, maximumAge: 60000
    });
  });
  try {
    await fetch('/smart-match/location', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(location || { status: 'fallback' })
    });
  } catch (error) { /* The server's demo-location fallback keeps Smart Match available. */ }
  matchRegion.dataset.locationReady = 'true';
}
async function loadMatch(again) {
  if (!matchRegion) return;
  matchRegion.setAttribute('aria-busy', 'true');
  matchRegion.innerHTML = '<div class="matching"><div class="matching-dots" aria-hidden="true"><i></i><i></i><i></i></div><h2>' +
    (again ? 'Finding something better...' : 'Finding your next spot...') +
    '</h2><p>' + (again ? 'Using your feedback' : 'Checking what fits right now') + '</p></div>';
  try {
    const results = await Promise.all([
      prepareDiscoveryLocation().then(function() { return fetch('/smart-match/result'); }).then(function(response) {
        if (!response.ok) throw new Error('Unable to load match');
        return response.text();
      }),
      wait(1800)
    ]);
    matchRegion.innerHTML = results[0];
    initMerchantMap();
  } catch (error) {
    matchRegion.innerHTML = '<section class="card"><h2>Let’s try that again.</h2><a class="button" href="/home">Return Home</a></section>';
  }
  matchRegion.setAttribute('aria-busy', 'false');
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
    status.textContent = platform === 'copy' ? 'Copied ✓' : 'Share ready ✓';
  });
}

// Capture the clicked action BEFORE disabling controls. Keeps Vouch/Skip values intact.
document.addEventListener('submit', function(event) {
  const form = event.target;
  if (form.matches('[data-confirm-reset]') && !window.confirm('Reset this demo for the next visitor?')) {
    event.preventDefault(); return;
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
