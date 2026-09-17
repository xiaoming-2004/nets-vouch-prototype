// UI only. Preferences, payments and decisions belong to the server session.
function wait(milliseconds) {
  return new Promise(function(resolve) { window.setTimeout(resolve, milliseconds); });
}

const matchRegion = document.querySelector('[data-match-region]');
async function loadMatch(again) {
  if (!matchRegion) return;
  matchRegion.setAttribute('aria-busy', 'true');
  matchRegion.innerHTML = '<div class="matching"><div class="matching-dots" aria-hidden="true"><i></i><i></i><i></i></div><h2>' +
    (again ? 'Finding something better...' : 'Finding your next spot...') +
    '</h2><p>' + (again ? 'Using your feedback' : 'Checking what fits right now') + '</p></div>';
  try {
    const results = await Promise.all([
      fetch('/smart-match/result').then(function(response) {
        if (!response.ok) throw new Error('Unable to load match');
        return response.text();
      }),
      wait(1800)
    ]);
    matchRegion.innerHTML = results[0];
  } catch (error) {
    matchRegion.innerHTML = '<section class="card"><h2>Let’s try that again.</h2><a class="button" href="/home">Return Home</a></section>';
  }
  matchRegion.setAttribute('aria-busy', 'false');
}
if (document.querySelector('[data-load-match]')) loadMatch(location.search.includes('matching=again'));

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
  function updateTotal() {
    const amount = Number(amountInput ? amountInput.value : paymentForm.dataset.amount);
    const valid = Number.isFinite(amount) && amount > 0 && amount <= 1000;
    const cents = valid ? Math.round(amount * 100) : 0;
    const used = checkbox.checked ? Math.min(Math.round(Number(paymentForm.dataset.balance) * 100), cents) : 0;
    const paid = (cents - used) / 100;
    paymentForm.querySelector('[data-cashback-used]').textContent = '−$' + (used / 100).toFixed(2);
    paymentForm.querySelector('[data-nets-total]').textContent = '$' + paid.toFixed(2);
    paymentForm.querySelector('[data-pay-button]').textContent = valid ? 'Pay $' + paid.toFixed(2) : 'Pay';
  }
  paymentForm.addEventListener('input', updateTotal);
  updateTotal();
}

// Social buttons are deliberately simulated: each copies the same claimable link.
const shareGrid = document.querySelector('[data-share-path]');
if (shareGrid) {
  shareGrid.addEventListener('click', async function(event) {
    const button = event.target.closest('[data-copy-share]');
    if (!button) return;
    const link = new URL(shareGrid.dataset.sharePath, window.location.origin).href;
    try {
      await navigator.clipboard.writeText(link);
    } catch (error) {
      const input = document.createElement('textarea');
      input.value = link; input.setAttribute('readonly', ''); input.style.position = 'fixed'; input.style.opacity = '0';
      document.body.appendChild(input); input.select(); document.execCommand('copy'); input.remove();
    }
    const status = document.querySelector('.share-status');
    status.textContent = 'Claim link copied ✓';
    button.setAttribute('aria-label', button.textContent.trim() + ' link copied');
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

// Reflect merchant readiness without fake preparation timers.
const orderCards = Array.from(document.querySelectorAll('[data-order-id]'));
if (orderCards.some(function(card) { return ['PAID', 'PREPARING'].includes(card.dataset.orderStatus); })) {
  window.setInterval(async function() {
    if (document.hidden) return;
    try {
      const response = await fetch('/order/state');
      const state = await response.json();
      const changed = orderCards.some(function(card) {
        const latest = state.orders.find(function(order) { return order.id === card.dataset.orderId; });
        return !latest || latest.status !== card.dataset.orderStatus;
      });
      if (changed) location.reload();
    } catch (error) { /* The next poll can recover from temporary loss of connection. */ }
  }, 4000);
}
