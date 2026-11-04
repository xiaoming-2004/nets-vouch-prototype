const test = require('node:test');
const assert = require('node:assert/strict');
const { app, demoStore } = require('../app');
const preferencesStore = require('../preferences-store');

// Saved preferences in MySQL. No real database and no .env credentials are used: the store is given an
// in-process fake that understands exactly the four statements preferences-store.js issues.

const originalFetch = global.fetch;

class FakeDatabase {
  constructor() { this.rows = new Map(); this.calls = []; this.failing = false; this.configured = true; }
  isConfigured() { return this.configured; }
  async query(sql, params) {
    this.calls.push(sql.split(' ')[0]);
    if (this.failing) throw new Error('connection refused');
    if (/^SELECT/.test(sql)) {
      const row = this.rows.get(params[0]);
      return row ? [row] : [];
    }
    if (/^INSERT INTO users/.test(sql)) {
      this.rows.set(params[0], { user_id: params[0], display_name: params[1], dietary_preference: params[2],
        mood_cuisine: params[3], craving: params[4], budget_max: String(params[5]),
        max_distance_minutes: params[6], notifications: params[7], has_set_preferences: params[8] });
      return { affectedRows: 1 };
    }
    if (/^DELETE FROM users/.test(sql)) {
      params[0].forEach((id) => this.rows.delete(id));
      return { affectedRows: 1 };
    }
    throw new Error('unexpected SQL: ' + sql);
  }
}

let server;
let base;
let fake;
test.before(async function() {
  server = await new Promise(function(resolve) {
    const instance = app.listen(0, '127.0.0.1', function() { resolve(instance); });
  });
  base = 'http://127.0.0.1:' + server.address().port;
});
test.after(function() { server.close(); preferencesStore.setDatabase(null); });
test.beforeEach(function() {
  fake = new FakeDatabase();
  preferencesStore.setDatabase(fake);
  global.fetch = originalFetch;
});

function visitor() {
  let cookie = '';
  return {
    async request(requestPath, body) {
      const response = await originalFetch(base + requestPath, {
        method: body === undefined ? 'GET' : 'POST', redirect: 'manual',
        headers: { Cookie: cookie, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      const header = response.headers.get('set-cookie');
      if (header) cookie = header.split(';')[0];
      return { status: response.status, location: response.headers.get('location'), html: await response.text() };
    },
    async state() {
      const id = decodeURIComponent(cookie.split('=')[1]).slice(2).split('.')[0];
      return new Promise(function(resolve, reject) {
        demoStore.get(id, function(error, data) { if (error) reject(error); else resolve(data); });
      });
    },
    async change(mutate) {
      const id = decodeURIComponent(cookie.split('=')[1]).slice(2).split('.')[0];
      const state = await this.state();
      mutate(state.demo);
      await new Promise(function(resolve, reject) {
        demoStore.set(id, state, function(error) { if (error) reject(error); else resolve(); });
      });
    }
  };
}

test('onboarding preferences are written to the database for the persona', async function() {
  const jia = visitor();
  await jia.request('/home');
  const response = await jia.request('/setup-preferences', { moodCuisine: 'rice', craving: 'chicken rice' });
  assert.equal(response.status, 302);
  const row = fake.rows.get('jia');
  assert.ok(row, 'a users row exists for jia');
  assert.equal(row.display_name, 'Jia');
  assert.equal(row.mood_cuisine, 'rice');
  assert.equal(row.craving, 'chicken rice');
  assert.equal(row.has_set_preferences, 1);
});

test('Edit filters, dietary restriction and notifications are all saved', async function() {
  const jia = visitor();
  await jia.request('/home');
  await jia.request('/profile', { budget: '8.50', maxDistanceMinutes: '12', moodCuisine: 'noodles', craving: 'laksa' });
  assert.equal(fake.rows.get('jia').budget_max, '8.5');
  assert.equal(fake.rows.get('jia').max_distance_minutes, 12);
  await jia.request('/profile/dietary', { dietaryPreference: 'halal' });
  assert.equal(fake.rows.get('jia').dietary_preference, 'halal');
  assert.equal(fake.rows.get('jia').budget_max, '8.5', 'saving dietary keeps the other values');
  await jia.request('/profile/notifications', {});
  assert.equal(fake.rows.get('jia').notifications, 0);
});

test('a brand-new session (e.g. after a server restart) gets the saved preferences back', async function() {
  const first = visitor();
  await first.request('/home');
  await first.request('/profile', { budget: '7', maxDistanceMinutes: '15', moodCuisine: 'soup', craving: 'fish soup' });
  await first.request('/profile/dietary', { dietaryPreference: 'vegetarian' });

  const second = visitor();   // different cookie = different session, as after a restart
  const home = await second.request('/home');
  assert.equal(home.status, 200);
  const demo = (await second.state()).demo;
  assert.equal(demo.hasSetPreferences, true);
  assert.deepEqual(demo.profile, { dietaryPreference: 'vegetarian', moodCuisine: 'soup', craving: 'fish soup',
    budget: 7, maxDistanceMinutes: 15, notifications: true });
  assert.doesNotMatch(home.html, /setup-preferences/, 'onboarding is not shown again');
});

test('each persona keeps separate saved preferences', async function() {
  const visit = visitor();
  await visit.request('/home');
  await visit.request('/profile/dietary', { dietaryPreference: 'halal' });
  await visit.request('/demo/identity', { userId: 'darren' });
  await visit.request('/home');
  assert.equal((await visit.state()).demo.profile.dietaryPreference, 'none', 'Darren starts from defaults');
  await visit.request('/profile/dietary', { dietaryPreference: 'vegan' });
  assert.equal(fake.rows.get('jia').dietary_preference, 'halal');
  assert.equal(fake.rows.get('darren').dietary_preference, 'vegan');
});

test('stored values that are no longer valid are normalised, never trusted', async function() {
  fake.rows.set('jia', { user_id: 'jia', display_name: 'Jia', dietary_preference: 'pescatarian',
    mood_cuisine: 'sushi', craving: '<b>bee hoon</b>', budget_max: '9999.00',
    max_distance_minutes: 500, notifications: 1, has_set_preferences: 1 });
  const jia = visitor();
  await jia.request('/home');
  const profile = (await jia.state()).demo.profile;
  assert.equal(profile.dietaryPreference, 'none');
  assert.equal(profile.moodCuisine, 'any');
  assert.equal(profile.craving, 'bbee hoon/b');
  assert.doesNotMatch(profile.craving, /[<>]/);
  assert.equal(profile.budget, 10, 'an out-of-range budget falls back to the default');
  assert.equal(profile.maxDistanceMinutes, 10);
});

test('saved preferences never overwrite what an active session already set', async function() {
  const jia = visitor();
  await jia.request('/home');
  await jia.change(function(demo) { demo.hasSetPreferences = true; demo.profile.craving = 'in this session'; });
  fake.rows.set('jia', { user_id: 'jia', display_name: 'Jia', dietary_preference: 'halal', mood_cuisine: 'rice',
    craving: 'from the database', budget_max: '5', max_distance_minutes: 5, notifications: 1, has_set_preferences: 1 });
  await jia.request('/home');
  assert.equal((await jia.state()).demo.profile.craving, 'in this session');
});

test('Reset Demo clears saved preferences so they do not come straight back', async function() {
  const jia = visitor();
  await jia.request('/home');
  await jia.request('/setup-preferences', { moodCuisine: 'rice', craving: 'chicken rice' });
  assert.ok(fake.rows.has('jia'));
  const reset = await jia.request('/reset-demo', {});
  assert.equal(reset.status, 302);
  assert.equal(fake.rows.size, 0);
  const fresh = visitor();
  await fresh.request('/home');
  assert.equal((await fresh.state()).demo.hasSetPreferences, false);
});

test('a database outage never breaks a page and the session keeps working', async function() {
  fake.failing = true;
  const jia = visitor();
  const home = await jia.request('/home');
  assert.equal(home.status, 200);
  const saved = await jia.request('/setup-preferences', { moodCuisine: 'rice', craving: 'chicken rice' });
  assert.equal(saved.status, 302);
  const demo = (await jia.state()).demo;
  assert.equal(demo.profile.craving, 'chicken rice', 'session state still holds the preference');
  assert.equal(fake.rows.size, 0);
  assert.equal((await jia.request('/profile')).status, 200);
});

test('an unreadable database is retried later instead of being treated as "nothing saved"', async function() {
  fake.rows.set('jia', { user_id: 'jia', display_name: 'Jia', dietary_preference: 'halal', mood_cuisine: 'any',
    craving: '', budget_max: '10', max_distance_minutes: 10, notifications: 1, has_set_preferences: 1 });
  fake.failing = true;
  const jia = visitor();
  await jia.request('/home');
  assert.equal((await jia.state()).demo.profile.dietaryPreference, 'none');
  fake.failing = false;
  await jia.request('/home');
  assert.equal((await jia.state()).demo.profile.dietaryPreference, 'halal');
});

test('with no database configured nothing is queried and behaviour is unchanged', async function() {
  fake.configured = false;
  const jia = visitor();
  await jia.request('/home');
  const response = await jia.request('/setup-preferences', { moodCuisine: 'rice', craving: 'chicken rice' });
  assert.equal(response.status, 302);
  assert.equal((await jia.state()).demo.profile.craving, 'chicken rice');
  assert.deepEqual(fake.calls, []);
});
