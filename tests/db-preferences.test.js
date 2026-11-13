const { database: db } = require('./helpers/test-isolation.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const { start } = require('./helpers/visitor.cjs');
let http;
test.before(async () => { http = await start(); });
test.after(() => http.close());

test('current preference SQL persists budget, max_walk_minutes and dietary only', async () => {
  db.seedUser('jia', { max_distance_minutes: 23, mood_cuisine: 'rice', craving: 'old', notifications: 1, has_set_preferences: 0 });
  const v = http.visitor(); await v.request('/home');
  assert.equal((await v.request('/profile', { budget: '8.50', maxDistanceMinutes: '12', moodCuisine: 'noodles', craving: 'laksa' })).status, 302);
  await v.request('/profile/dietary', { dietaryPreference: 'halal' });
  await v.request('/profile/notifications', {});
  const row = db.users.get('jia');
  assert.equal(row.budget_max, 8.5); assert.equal(row.max_walk_minutes, 12); assert.equal(row.dietary_preference, 'halal');
  assert.equal(row.display_name, 'Jia');
  assert.deepEqual([row.max_distance_minutes, row.mood_cuisine, row.craving, row.notifications, row.has_set_preferences], [23, 'rice', 'old', 1, 0]);
  const profile = (await v.state()).demo.profile;
  assert.equal(profile.craving, 'laksa'); assert.equal(profile.notifications, false);
  for (const call of db.calls.filter(c => c.sql.startsWith('INSERT'))) {
    assert.match(call.sql, /budget_max, max_walk_minutes, dietary_preference/);
    assert.doesNotMatch(call.sql, /max_distance_minutes|mood_cuisine|craving|notifications|has_set_preferences/);
  }
});

test('onboarding creates a current-schema user without extending persisted fields', async () => {
  const v = http.visitor(); await v.request('/home');
  await v.request('/setup-preferences', { moodCuisine: 'rice', craving: 'chicken rice' });
  const row = db.users.get('jia'); assert.ok(row);
  assert.equal(row.display_name, 'Jia'); assert.equal(row.craving, ''); assert.equal(row.has_set_preferences, 0);
  assert.equal((await v.state()).demo.hasSetPreferences, true);
});

test('fresh sessions hydrate current columns, not migrated session-only fields', async () => {
  db.seedUser('jia', { budget_max: 7, max_walk_minutes: 15, dietary_preference: 'vegetarian',
    max_distance_minutes: 50, mood_cuisine: 'soup', craving: 'fish soup', notifications: 0, has_set_preferences: 1 });
  const v = http.visitor(); assert.equal((await v.request('/home')).status, 200);
  const demo = (await v.state()).demo;
  assert.deepEqual(demo.profile, { dietaryPreference: 'vegetarian', moodCuisine: 'any', craving: '', budget: 7, maxDistanceMinutes: 15, notifications: true });
  assert.equal(demo.hasSetPreferences, false);
});

test('persona preferences remain separate', async () => {
  const v = http.visitor(); await v.request('/home');
  await v.request('/profile/dietary', { dietaryPreference: 'halal' });
  await v.request('/demo/identity', { userId: 'darren' }); await v.request('/home');
  assert.equal((await v.state()).demo.profile.dietaryPreference, 'none');
  await v.request('/profile/dietary', { dietaryPreference: 'vegan' });
  assert.equal(db.users.get('jia').dietary_preference, 'halal');
  assert.equal(db.users.get('darren').dietary_preference, 'vegan');
});

test('invalid hydrated values fall back to session defaults', async () => {
  db.seedUser('jia', { budget_max: 9999, max_walk_minutes: 500, dietary_preference: 'invalid' });
  const v = http.visitor(); await v.request('/home'); const profile = (await v.state()).demo.profile;
  assert.equal(profile.budget, 10); assert.equal(profile.maxDistanceMinutes, 10); assert.equal(profile.dietaryPreference, 'none');
});

test('active preferences are not overwritten and invalid forms cause no upsert', async () => {
  const v = http.visitor(); await v.request('/home');
  await v.request('/profile', { budget: '8', maxDistanceMinutes: '12' });
  db.seedUser('jia', { budget_max: 3, max_walk_minutes: 5 });
  await v.request('/home'); assert.equal((await v.state()).demo.profile.budget, 8);
  const before = db.calls.filter(c => c.sql.startsWith('INSERT')).length;
  await v.request('/profile', { budget: '999', maxDistanceMinutes: '12' });
  await v.request('/profile/dietary', { dietaryPreference: 'invalid' });
  assert.equal(db.calls.filter(c => c.sql.startsWith('INSERT')).length, before);
});

test('fixture outages preserve session behavior and hydration retries later', async () => {
  db.seedUser('jia', { budget_max: 6, dietary_preference: 'halal' }); db.failing = true;
  const v = http.visitor(); assert.equal((await v.request('/home')).status, 200);
  assert.equal((await v.state()).demo.profile.dietaryPreference, 'none');
  db.failing = false; await v.request('/home'); assert.equal((await v.state()).demo.profile.dietaryPreference, 'halal');
  db.failing = true;
  assert.equal((await v.request('/setup-preferences', { craving: 'rice' })).status, 302);
  assert.equal((await v.state()).demo.profile.craving, 'rice'); assert.equal(db.users.get('jia').craving, '');
});
