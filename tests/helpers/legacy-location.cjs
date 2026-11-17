// Test-only seeding for the legacy Smart Match discovery suites.
// The POST /smart-match/location route is disabled (it can no longer accept or store coordinates), so
// these suites put a visitor's session into the state that route used to create by writing the
// in-memory test session store directly. Nothing here exists in application code.
const { demoStore } = require('../../app');

function sessionIdOf(visitor) {
  return decodeURIComponent(visitor.cookieValue().split('=')[1]).slice(2).split('.')[0];
}
const finite = value => typeof value === 'number' && Number.isFinite(value);

module.exports = async function seedLegacyLocation(visitor, body) {
  const fallback = body && body.status === 'fallback';
  if (!fallback && !(body && finite(body.latitude) && finite(body.longitude) &&
      Math.abs(body.latitude) <= 90 && Math.abs(body.longitude) <= 180)) {
    throw new Error('seedLegacyLocation needs { status: "fallback" } or valid coordinates');
  }
  if (!visitor.cookieValue()) await visitor.request('/welcome');
  const id = sessionIdOf(visitor);
  const stored = await new Promise((resolve, reject) => demoStore.get(id, (error, value) => error ? reject(error) : resolve(value)));
  const demo = stored.demo;
  demo.discoveryLocation = fallback ? null : { latitude: body.latitude, longitude: body.longitude };
  demo.locationAttempted = true;
  demo.nearbyMerchants = [];
  demo.nearbySource = null;
  demo.nearbyDemoFallback = false;
  demo.nearbyRefreshAttempted = false;
  demo.matchContinuation = null;
  if (!demo.recommendationAccepted) {
    demo.selectedMerchantId = null;
    demo.selectedMerchantReason = null;
    demo.selectedMerchantRelevance = null;
  }
  await new Promise((resolve, reject) => demoStore.set(id, stored, error => error ? reject(error) : resolve()));
  return { status: 204 };
};
