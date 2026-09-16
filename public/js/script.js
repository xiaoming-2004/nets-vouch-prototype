console.log('NETS Vouch AI Express prototype loaded');

const resetForms = document.querySelectorAll('[data-confirm-reset]');

resetForms.forEach(function(form) {
  form.addEventListener('submit', function(event) {
    const confirmed = window.confirm('Reset the complete Open House demo for the next visitor?');
    if (!confirmed) event.preventDefault();
  });
});

const smartMatchRegion = document.querySelector('[data-smart-match]');

if (smartMatchRegion) {
  const loadingDetail = smartMatchRegion.querySelector('[data-loading-detail]');
  const loadingDetails = [
    "Checking what's nearby",
    'Matching your preferences',
    "Looking for something you'll like"
  ];
  let detailIndex = 0;

  const detailTimer = window.setInterval(function() {
    detailIndex = (detailIndex + 1) % loadingDetails.length;
    if (loadingDetail) loadingDetail.textContent = loadingDetails[detailIndex];
  }, 650);

  const minimumDisplayTime = new Promise(function(resolve) {
    window.setTimeout(resolve, 2000);
  });

  const recommendationRequest = fetch('/smart-match/result', {
    headers: { 'X-Requested-With': 'smart-match' }
  }).then(function(response) {
    if (!response.ok) throw new Error('Smart Match could not be loaded');
    return response.text();
  });

  Promise.all([recommendationRequest, minimumDisplayTime])
    .then(function(results) {
      smartMatchRegion.innerHTML = results[0];
      smartMatchRegion.setAttribute('aria-busy', 'false');
    })
    .catch(function() {
      smartMatchRegion.innerHTML =
        '<section class="smart-match-empty smart-match-reveal">' +
        '<span aria-hidden="true">↻</span>' +
        '<h2>Smart Match needs another go.</h2>' +
        '<p>Your Home page is still available.</p>' +
        '<a class="button button--full" href="/home#smart-match">Try again</a>' +
        '</section>';
      smartMatchRegion.setAttribute('aria-busy', 'false');
    })
    .finally(function() {
      window.clearInterval(detailTimer);
    });
}

const singleSubmitForms = document.querySelectorAll('[data-single-submit]');

singleSubmitForms.forEach(function(form) {
  form.addEventListener('submit', function() {
    const submitButton = form.querySelector('button[type="submit"]');
    if (!submitButton) return;
    const submitText = submitButton.getAttribute('data-submit-text');
    if (submitText) submitButton.textContent = submitText;
    submitButton.disabled = true;
  });
});
