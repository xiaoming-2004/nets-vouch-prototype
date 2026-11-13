# Task 2 verification: MySQL recommendation catalogue

13 November 2026 (Asia/Singapore). Starting branch: `improvement/nets-demo`; starting HEAD: `bb3fbbb5e0f1d98bfb253ffcdee662f8a31606ad`. Task 2 changes are unstaged and uncommitted.

## Implemented behavior

- `/api/recommend` reads the MySQL merchant catalogue on every request through `merchant-catalogue.js`. The adapter accepts the existing database interface and uses a fixed prepared SELECT with explicit fields, stable ID ordering, and an empty parameter array. No user input is interpolated, no catalogue writes are added, and provider discovery is not called by this flow.
- Existing scoring, three-result maximum, routes, and recommendation fields are retained. Response metadata is additive: `catalogue: { source: 'mysql' | 'demo-fallback', status: 'ok' | 'empty' | 'unavailable' }`. Cards also receive source, sample-data, and stored-distance information.
- A successful empty catalogue returns an empty list with status `empty`. A populated catalogue with no eligible rows returns an empty list with status `ok`. Only a failed/unusable database response uses the existing demo merchants, with status `unavailable` and a visible demo-fallback notice. Successful MySQL results never mix in demo/provider merchants.
- Merchant IDs remain exact strings. DECIMAL fields become finite, nonnegative numbers; valid zero values remain zero. Null/blank/malformed numeric facts stay unknown rather than coercing to zero. Missing menu items and coordinates remain null. Catalogue flags require explicit true/1/"1" values; no dietary claim is inferred from names or cuisine.
- A known typical price and stored distance are required to enforce budget/distance limits. Unknown prices are excluded from recommendations, never described as confirmed within budget. Active dietary restrictions require explicit matching catalogue flags; existing vegan-satisfies-vegetarian behavior is retained. Missing reward/minimum-spend terms do not produce an invented offer.
- Stored distances are labelled as approximate catalogue estimates from the demo origin. They are not recomputed from device GPS or presented as route-based walking times. The Home catalogue request no longer requires device location. Typical price displays independently of menu-item availability, and sample catalogue rows are identified.

## Snapshot and campaign consistency

- The latest three results are retained as a session batch. Acceptance/rejection resolve that batch explicitly, including the second and third cards. This prevents a same-ID hardcoded merchant from supplying different names, prices, dietary flags, or reward terms.
- Selected facts are copied into the Scan journey, transaction, Vouch offer, and shared claim. A catalogue refresh does not overwrite an active journey. Shared-claim recipients can resolve the exact merchant without loading the catalogue themselves. Historical offers retain the original facts after later same-ID selections.
- Campaign state is created in memory when necessary, without using the existing provider-registration function that writes merchant rows. Existing shared status, hours, counters, caps, budget, and normal daily rollover remain the simulation mechanics. Catalogue refresh does not recreate or reset existing campaign state.
- Snapshot reward/minimum-spend terms are overlaid on that live campaign state without copying its mutable counters. At payment, the existing logic checks actual purchase amount, NETS-paid minimum, daily reward eligibility, current status/time window, redemption cap, and remaining shared budget. A successful simulated payment may earn no reward when a current gate fails. Payment submission does not query the catalogue; fresh-session payment-form recovery may read its merchant as described below.
- Unknown catalogue facts are not filled from same-ID fallback objects. The database-backed return-to-Home card also displays typical price and avoids generating new illustrative Vouch counts for database merchants.

## Files changed

| File | Change |
| --- | --- |
| `merchant-catalogue.js` | New read-only adapter, conservative row normalization, and prepared exact-ID lookup |
| `app.js` | Fresh catalogue reads, metadata, catalogue eligibility, snapshot resolution, campaign-term views, Scan/transaction/shared-claim handoff |
| `public/js/script.js` | Honest price/distance/source presentation, distinct empty/outage states, attribute escaping, no GPS prerequisite for catalogue requests |
| `views/home.ejs` | Catalogue-specific loading copy |
| `views/smart-match-card.ejs` | Typical price/sample information when returning to a selected catalogue merchant |
| `views/scan-unavailable.ejs` | Recoverable 503 response with a safe same-ID retry link |
| `tests/helpers/test-isolation.cjs` | Explicit catalogue SELECT fixture contract, seed helper, separate catalogue-outage control; other SQL remains forbidden unless already supported |
| `tests/helpers/catalogue-fixtures.cjs` | In-memory test rows only; no SQL seeding or application sample data |
| `tests/catalogue.test.js` | Adapter/API/identity/journey/snapshot/live-payment-gate coverage |
| `tests/catalogue-render.test.js` | Pure rendering and escaping checks using a JavaScript VM |
| `tests/catalogue-scan.test.js` | Fresh-session Scan/form recovery, errors, snapshot/counter preservation, and shared-recipient checks |
| `tests/rejection.test.js` | Explicitly seeds isolated catalogue fixtures; retains existing response/update assertions |
| `docs/task2-verification.md` | This record |

The existing Scan template already renders `distanceLabel`, so no Scan template change was needed.

## Actual checks and results

- Syntax checks passed for the adapter, application, browser script, isolation helper, and new test files.
- Before running catalogue route tests, the existing isolation suite passed **8/8**. Real environment reads, service factories, and external connections remained guarded.
- The initial catalogue/API/render/isolation/rejection run exposed two dietary failures: the legacy generic filter admitted unknown dietary matches. A catalogue-specific explicit-flag requirement repaired the cause without weakening assertions. The focused rerun passed **47/47**.
- Expanded verification initially passed **90/90**, then the final run including the two-active-session shared-budget case passed **91/91**, **0 failed**, **0 cancelled/skipped/todo**, exit **0**, approximately **9.3 seconds**.
- No full-suite run was performed. No live database, browser, laptop, or mobile verification was performed.

Original catalogue-integration focused command:

```text
node --require ./tests/helpers/test-isolation.cjs --test tests/catalogue.test.js tests/catalogue-render.test.js tests/isolation.test.js tests/rejection.test.js tests/db-preferences.test.js tests/reset-demo.test.js tests/reset-demo-redis.test.js tests/merchant-report.test.js tests/template-js.test.js
```

The focused checks cover price changes on the next request; flag/number/null/zero mapping; empty versus filtered-empty versus outage fallback; second/third-card acceptance and rejection; exact IDs and escaped text; query-filter overrides; Scan/payment/receipt/Vouch; shared claims; zero rewards; same-ID demo collisions; pinned facts across refreshes and later selections; payment replay; live status, daily eligibility, minimum spend/NETS amount, caps and budget; and two active sessions consuming one shared budget.

The catalogue journey file additionally asserts zero private environment loads/reads, real MySQL factories, Redis factories, and blocked socket attempts across its run. Catalogue recommendation reads assert that they add no INSERT/UPDATE/DELETE calls. All database operations during tests are in-memory fixture methods, not real SQL execution.

Local diagnostic logs: `%TEMP%\nets-task2-focused.log` and `%TEMP%\nets-task2-regressions.log`. They are not repository artifacts.

## Direct Scan follow-up

The initial implementation resolved catalogue-only IDs only from retained recommendation/selected/shared-claim snapshots. A fresh-session Direct Scan or cold payment link therefore failed without querying the catalogue. Same-session selected-payment refresh and a fresh shared recipient already worked.

The follow-up adds a fixed prepared SELECT with `WHERE merchant_id = ?`, passing the exact ID in a separate parameter array. It reuses row normalization, requires the returned ID to match exactly (including case), and returns no merchant for missing/invalid rows. No new fields, writes, or seed data are involved.

- `POST /scan` and fresh-session `GET /scan/payment?m=...` use the lookup only when existing merchant resolution has no result. Known snapshots and existing demo/provider resolution retain priority.
- A mapped row with usable campaign terms initializes only missing in-memory campaign state, then uses the existing Scan snapshot structure. Existing campaign objects and counters are never recreated by the lookup. Incomplete rows do not receive invented reward terms.
- Active Scan/payment state is checked before looking up a different ID. Refreshes, alternate submitted IDs, and catalogue outages cannot overwrite an active journey. Another session can load updated row facts without changing the first session's snapshot or resetting shared counters.
- Unknown/malformed IDs retain `/scan?error=invalid`. Database lookup failure returns **503** with a static unavailable message and a safely encoded retry link to the same merchant's payment form. It exposes no database error details and substitutes no demo merchant.
- GET recovery creates only an unpaid `MERCHANT_FOUND` journey and displays a form. Repeated GETs retain its journey ID, leave transactions/payment counters/reward spend unchanged, and do not repeat the catalogue lookup. Only the existing payment POST records a simulated payment.
- A fresh shared recipient still uses the offer's retained snapshot without a catalogue lookup, including when the sender's stored session has been deleted and the catalogue is unavailable. Shared offers/campaigns remain process-local state.

Follow-up syntax checks passed for `merchant-catalogue.js`, `app.js`, the isolation helper, and `tests/catalogue-scan.test.js`. Initial Scan/isolation verification passed **20/20**. The final focused run passed **57/57**, **0 failed/cancelled/skipped/todo**, exit **0**, approximately **1.7 seconds**:

```text
node --require ./tests/helpers/test-isolation.cjs --test tests/catalogue-scan.test.js tests/catalogue.test.js tests/catalogue-render.test.js tests/isolation.test.js tests/template-js.test.js
```

Coverage includes fresh-session direct Scan and subsequent payment/Vouch; a cold payment link and subsequent payment; GET-only safety; unknown and malformed IDs; wrong campaign IDs; GET/POST database outages and successful same-ID retries; safe retry escaping; selected-payment refresh; active journey/counter preservation across sessions; exact prepared-query parameters; incomplete rows; and shared recipients independent of the sender session. The new Scan suite asserts zero private environment reads/loads, real MySQL/Redis factory calls, and blocked socket attempts. Database calls are fixture methods only.

Logs: `%TEMP%\nets-task2-direct-scan.log` and `%TEMP%\nets-task2-direct-scan-regressions.log`. No full-suite, real database/service, schema/migration, staging, or commit operation was performed. Browser/mobile verification was not performed.

## Preservation and remaining limits

- Database configuration, `.env`, checked-in schema, and Task 0/1 records are preserved. Their contents are compared privately by fingerprints; fingerprint values and secret values are not printed. No live queries/writes, migrations, `db.sql`, sample-data installation, new AI, Maps, or activity calculations were performed.
- Campaign status/caps/budget and simulated payments still live in process/session memory. Catalogue integration does not make them production deployment infrastructure or durable transactions.
- Distances are estimates from the demo origin. GPS/route accuracy and menu-level pricing remain unsupported. Unknown facts or unusable reward terms can leave fewer than three eligible cards; no results are invented to fill slots.
- Fresh unresolved Scan IDs and cold merchant payment links now support prepared catalogue lookup. The Scan picker still does not enumerate the entire database catalogue. Known in-memory merchants/snapshots keep priority. Recovery of completed transactions/shared offers after process restart and merchant-dashboard catalogue expansion remain outside this task.
- The previously documented 54 baseline full-suite failures and historical unexplained reset-worker exit are not claimed fixed. This focused run passed reset coverage, but the full suite was not rerun and those historical conclusions remain unchanged.
- VM rendering and HTTP assertions do not verify real browser layout, camera operation, mobile interaction, or live database behavior.

## Short manual checks for later

Use an isolated fixture instance, not `npm start` against the preserved database. For example, from the project directory on a free port:

```text
node --require ./tests/helpers/test-isolation.cjs -e "const {database}=require('./tests/helpers/test-isolation.cjs'); require('./tests/helpers/catalogue-fixtures.cjs').seedCatalogue(database); require('./app').app.listen(3102,'127.0.0.1');"
```

This seeds only an in-memory fake. The Node guard blocks server-side service access; a separate browser can still load existing public CDN assets and is not itself sandboxed by the helper.

1. Inspect the three Home cards at laptop/mobile widths: typical price, demo-origin distance estimate, no invented menu item, and correct selected identity.
2. Choose card two or three, use Scan's merchant list, complete simulated payment, and create/share a Vouch.
3. In a separate isolated persona/session, claim the link and verify the same merchant and reward terms.
4. Check an empty fixture catalogue and a fixture outage separately; only the outage should show labelled demo fallback.
5. Open `/scan/payment?m=catalogue-a` in a fresh browser session; verify the merchant form, refresh it, then submit a simulated payment. Unknown IDs should return the invalid-merchant outcome; lookup outages should show unavailable with a same-ID retry, never another merchant.

Suggested commit title: `feat: connect recommendations to the MySQL merchant catalogue`.
