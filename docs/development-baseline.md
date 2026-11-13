# NETS Vouch development baseline

Recorded on 13 November 2026 (Asia/Singapore). Task 0 establishes the baseline for small improvements to the laptop/mobile presentation for NETS staff.

## Git reference

- Original requested snapshot: `c91b8688eb5e9b21b0d6033dc96bfbcf56a9a4f6`.
- Inspected restoration commit: `3bdf7c6a5152c78d7437813986ec158f08e3a27f` (`Restore prototype to c91b868 recommendation API version`). The restoration was committed; it is not an uncommitted rollback.
- Before setup: branch `main`, clean working tree and index, no unmerged entries. This state was rechecked before creating references.
- Local baseline tag: `baseline/nets-restored-3bdf7c6`, pointing to the restoration commit.
- Development branch: `improvement/nets-demo`, created at the same restoration commit.
- The restoration matches the original requested snapshot except for a hardcoded database password change in `Database/db.js`. No credential values are recorded here.
- Local status reported alignment with cached `origin/main` during inspection. Remote freshness was not checked; no pull or push was performed.

The tag preserves the restored code as a reference, not a database or environment backup. This document is intentionally uncommitted at Task 0 completion.

## Configuration baseline

- `app.js` loads the local `.env` through Node's `process.loadEnvFile` before importing the database module. The package requires Node 22 or later; inspection used Node `v24.15.0`.
- `.env` exists, is ignored and untracked, and contains nonempty database configuration, a session secret, and several API keys. Values are deliberately omitted.
- `Database/db.js` uses hardcoded connection settings, including a password, rather than the preserved `MYSQL_*` environment settings. Importing it creates a pool and immediately attempts a connection.
- Sessions use `SESSION_SECRET`, with a fixed fallback when absent. `createUpstashClient()` always returns `null`, so the current session store is MemoryStore, regardless of Redis configuration. In-memory sessions do not survive a process restart.

## Code/schema compatibility

The inspection connected using the restored code's database configuration and issued only read-only `information_schema` queries. It did not import the application, inspect business rows, or execute schema/data writes.

- All four tables defined by the restored `Database/db.sql` are present: `users`, `merchants`, `merchant_activity_slots`, and `transactions`. Expected columns and declared foreign keys are present.
- The previously migrated user columns remain: `max_distance_minutes`, `mood_cuisine`, `craving`, `notifications`, and `has_set_preferences`.
- The `rejection_feedback` table remains present, including its user/merchant identifiers, reason, category, price, distance, cuisine tags, and timestamp fields.
- The restored preference SQL reads/writes `budget_max`, `max_walk_minutes`, and `dietary_preference`. It does not synchronize `max_distance_minutes` or persist the other migrated preference fields. The two distance columns can therefore diverge.
- Restored rejection handlers update sensitivity weights but do not write `rejection_feedback` records. The additional table and preference columns are unused by the restored SQL.
- Required schema elements are present; this confirms structural compatibility only. Business data, route behavior, and end-to-end persistence remain unverified.

Do not rerun the migration or `Database/db.sql`. The SQL file contains destructive table drops and seed writes and is not a safe reconciliation step for this preserved database.

## Checks and unsafe test paths

Existing package commands:

| Command | Behavior and database implications |
| --- | --- |
| `npm start` | Starts the app, loads `.env`, and imports the real database pool. Routes can write data. |
| `npm run test:browser-js` | Runs `node --check public/js/script.js`; syntax only, without importing the app. |
| `npm test` | Runs the browser syntax check, then `node --test tests/*.test.js`. Unsafe until database isolation is established. |

Prior inspection passed syntax checks for `app.js`, `nets_agent.js`, `Database/db.js`, and `public/js/script.js`; installed dependency inspection also passed. Integration tests and application startup were not run.

Known exposure paths:

- Many tests import `app.js`, which loads the real environment and database module before test hooks run. No shared database isolation was found. Clearing provider environment variables or mocking Redis does not isolate MySQL.
- Preference submission routes call `persistPreferences()` and upsert real `users` rows.
- Merchant discovery calls `registerDemoMerchant()` and inserts into `merchants`; a discovery journey can therefore write even when initiated through a GET route.
- `/api/feedback` and `/recommendation/reject` update user sensitivity weights.
- `/reset-demo` runs an `UPDATE users` without a `WHERE` clause, resetting preferences and weights for every user. Multiple journey/reset tests call this route.
- `tests/db-preferences.test.js` imports a missing `preferences-store` module. Its fake database does not isolate the app's direct database import.

## Task 1 handoff: runtime repairs and test isolation

Verify and report these items before expanding functionality:

1. Establish isolation before app import: tests must use an injected fake database or a dedicated disposable test database with an explicit guard against the preserved database. Prevent real provider access during automated tests as well. Prove isolation on profile, discovery, feedback, rejection, and reset paths before running the integration suite.
2. Resolve the missing `preferences-store` test dependency against the restored implementation; do not assume the old fake-store tests cover direct database calls.
3. Verify both Merchant Report dependencies: `getMerchantHourlyProfile()` and `HEATMAP_DAY_WEIGHTS`. The current code references both without definitions found in the project search. Treat Merchant Report runtime behavior as unverified until checked safely.
4. Review the duplicate rejection weight updates after `res.redirect()`. The redirect does not terminate the handler, so normal non-AJAX rejection can execute a second weight update and continue into additional response logic. Verify that each rejection produces only one intended update and one response.
5. Repair database configuration handling so preserved environment settings are honored without documenting secret values. Keep live-schema changes out of runtime repair work unless separately reviewed.
6. Verify application startup and affected routes under isolation, then record remaining laptop/mobile presentation blockers. Syntax checks alone do not establish runtime correctness.

Task 0 changes only local Git references and this baseline document. Application code, `.env`, and database contents are preserved. No integration tests, migrations, `db.sql`, pull, push, staging, or commit are part of Task 0. Recommendations, AI, Maps, and payment rebuilding are outside this baseline task.
