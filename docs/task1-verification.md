# Task 1 verification

13 November 2026 (Asia/Singapore). Branch: `improvement/nets-demo`; reference HEAD: `3bdf7c6a5152c78d7437813986ec158f08e3a27f`. Changes are unstaged and uncommitted. `development-baseline.md` remains the original Task 0 record.

## Changes and repaired root causes

- **Isolation:** app imports previously loaded private `.env` settings and constructed a live database pool before test hooks ran. `tests/helpers/test-isolation.cjs` now runs first in every test entrypoint and is preloaded by `npm test`. Test mode skips application environment loading; the helper also blocks environment-file reads and removes inherited service configuration before imports. It installs one shared, resettable in-memory database in the database module cache, leaving `Database/db.js` unchanged.
- **Service access:** real MySQL factories and the Redis constructor are forbidden. Socket connections are permitted only to numeric loopback addresses on HTTP server ports registered by the same test process. Existing provider fetch mocks remain usable; falling through to native HTTP/TLS is blocked. Unknown SQL and blocked accesses are recorded and fail test hooks even if application code catches the error. This is a test harness for this Node app, not an operating-system sandbox for arbitrary untrusted programs.
- **Merchant Report:** the restored code referenced undefined `getMerchantHourlyProfile()` and `HEATMAP_DAY_WEIGHTS`. Removed their dependent calculations and unsupported hourly observations. Hourly activity, peak hour, and busiest periods now show explicit unavailable states; existing weekly samples, sample totals, and live-payment accounting remain separate. Unseeded outlets receive empty sample totals/weekly states. The existing hourly scroll-wrapper hook is retained.
- **Preference tests:** removed the nonexistent `preferences-store` import and obsolete fake interface. Tests now exercise the actual mysql2-style result tuples and current SQL for display name, budget, `max_walk_minutes`, and dietary preference. They verify hydration, persona separation, invalid input, session-only fields, and outage fallback without adding persistence.
- **Rejection:** a redirect did not terminate the handler, allowing a second weight update and further response logic. The handler now has one update block and terminates with AJAX 204 or the existing normal-form redirect. Invalid requests do not update weights. Batch-card rejection remains supported.
- **Reset tests:** all SQL operates on fixtures. Tests cover multiple users, session/payment/Vouch cleanup, repeat reset, stale session saves, and session-store write failures. The former Redis suite now explicitly characterizes the current Redis bypass/MemoryStore behavior; it does not endorse it as the final deployment architecture. Applicable generic reset coverage remains in the reset suite.

Files changed: `app.js`, `views/merchant-report.ejs`, `package.json`; new test helpers, isolation/rejection tests, and a deliberately failing subprocess fixture; rewritten current-SQL preference tests; report/reset tests; a first-line isolation import in all other existing test entrypoints; this verification record. No dependency changes were needed.

## Execution order and actual results

| Check | Actual result |
| --- | --- |
| Initial isolation proof, before runtime repairs or route tests | 7 passed, 0 failed |
| Initial focused runtime/test checks | 56 passed, 0 failed |
| Focused checks including the new unseeded-report scenario | Initially 56 passed, 1 failed because the new test incorrectly treated the discovery result object as an array; corrected the test to use `.merchants`, then 57 passed, 0 failed |
| `npm test`, complete suite, run exactly once | 479 reported tests: 423 passed, 56 failed; 0 cancelled/skipped/todo; exit 1; approximately 14.5 seconds. Browser-script syntax check passed before the test runner. |
| Reset file checked separately after its unexplained full-run worker failure | 11 passed, 0 failed |
| Isolated comparison against restored HEAD, selecting the 54 unrelated failing cases | 54 failed, 0 passed: all selected failures reproduced |
| Targeted report layout-hook check after restoring the wrapper | 1 passed, 0 failed |
| Final focused run, including the additional swallowed-error subprocess proof | 58 passed, 0 failed; approximately 1.9 seconds |

Final focused command:

```text
node --require ./tests/helpers/test-isolation.cjs --test tests/isolation.test.js tests/db-preferences.test.js tests/rejection.test.js tests/merchant-report.test.js tests/reset-demo.test.js tests/reset-demo-redis.test.js tests/template-js.test.js
```

The separate layout check uses `--test-name-pattern="UI: the merchant campaign and report pages carry mobile-safe layout hooks"` with `tests/acceptance-journeys.test.js`.

The baseline comparison loaded `git show HEAD:app.js` into memory using a temporary preload, with only environment loading guarded for isolation. It used the same fake database/network guards and selected failing tests; no checkout, branch, or tracked-file changes were needed. No full-suite rerun was performed after the wrapper fix or the extra isolation test, so the full-suite counts above describe that run, not a claimed final green suite.

Local diagnostic logs are in the Windows temporary directory: `nets-task1-full.log`, `nets-task1-focused-final.log`, `nets-task1-baseline-comparison.log`, `nets-task1-reset.log`, and `nets-task1-report-layout.log`. They are not repository artifacts.

## Isolation evidence

The final eight isolation tests prove:

1. Before app import, private environment loading and synchronous/asynchronous environment-file reads are rejected; service keys are absent.
2. Both mysql2 APIs reject pool/connection/cluster creation, Redis construction is rejected, and existing loopback MySQL/Redis ports are denied without connecting.
3. Native external HTTP and TLS fail, including a provider mock that falls through to native fetch. An explicitly mocked response still works.
4. A test-owned loopback HTTP listener can serve real requests.
5. Unsupported SQL is recorded before it can be swallowed by a caller.
6. A deliberately failing subprocess catches forbidden socket/SQL exceptions internally but still exits 1 with two failed tests because isolation hooks detect them. That fixture is excluded from the normal test-file glob.
7. Every top-level test entrypoint installs isolation on its first line.
8. App/agent import uses the shared fake database, selects the current MemoryStore, and adds no environment reads, service constructors, or connections.

Real database configuration and private files were not used for test access. No live metadata/business queries, database writes, migrations, or `db.sql` executions were performed during Task 1. The `.env`, `Database/db.js`, and original baseline document are checked by private fingerprints for unchanged contents; fingerprint values are not printed.

## Full-suite failures and remaining work

Of the 56 reported failures, one was introduced by removing the hourly scroll wrapper. It was repaired without weakening its assertion, and its targeted check now passes. One was a file-level reset-worker failure with only `test failed` reported. The other 54 reproduce with the restored HEAD application under isolation:

| Test file | Reproduced failures | Evidence / cause or mismatch |
| --- | ---: | --- |
| `acceptance-journeys.test.js` | 2 | Halal scenarios expect Felicia; restored selection returns Toast & Co. |
| `craving-intent.test.js` | 3 | Semantic picks expect the strong/noodle candidate; restored behavior returns a generic candidate. |
| `journeys.test.js` | 3 | Two expect Woodlands Noodle Bar rather than Toast & Co.; one expects the old `Payments by channel` wording. |
| `match-continuation.test.js` | 4 | Expected new continuation targets differ from cached candidates actually returned. |
| `meal-eligibility.test.js` | 1 | Curated catalog count is 8; test expects 5. |
| `merchant-analytics.test.js` | 1 | Empty-feed assertion expects `No live payments yet`; current wording differs. |
| `merchant-dietary.test.js` | 1 | Expected AI category explanation differs from cautious fallback copy. |
| `ranking-providers.test.js` | 12 | Ranker selections/provider expectations differ; several dereference a null selection. Current validator requires a `bestMatch`/`backups` envelope, while existing mock replies use the older flat selection format. |
| `result-card-layout.test.js` | 1 | Expected Woodlands Noodle Bar heading; restored selection renders Toast & Co. |
| `semantic-match.test.js` | 15 | Flat validation inputs trigger `malformed ranking structure`; related expected fit/null/reason outcomes differ. |
| `smart-match.test.js` | 11 | Fallback merchant, semantic picks, no-match/closer-match behavior, and explanation expectations differ. |

These are confirmed baseline failures under the same harness, not a determination that every assertion is wrong. Ranking/continuation/catalog behavior and their test contracts need a separately reviewed task. Their assertions remain intact.

**Unresolved worker diagnostic:** the full run reported `tests/reset-demo.test.js` as a file-level failure without individual test output or a useful cause. It did not reproduce in the original separate 11-test run, the final 58-test focused run, or the seven targeted follow-up runs below. Its cause remains unverified; it is not classified as repaired or pre-existing.

**Deferred production reset risk:** `/reset-demo` still updates every user with no `WHERE` clause, resetting budget, `max_walk_minutes`, dietary preference, and sensitivity weights. Fixture tests explicitly include an unrelated user to characterize this. Rows are retained. Migrated preference columns and `rejection_feedback` are not cleared or synchronized. Broad production behavior is documented, not repaired in Task 1. Do not exercise this route on the preserved database as an acceptance check.

## Reset-worker follow-up investigation

This follow-up investigated only the unexplained worker failure. The complete suite was not rerun, and no production or test assertions were changed. Only this verification document changed during the follow-up.

### Original evidence and standalone comparison

- `nets-task1-full.log`, line 10398, reports `tests\reset-demo.test.js` failing after **3100.2444 ms**. Lines 17270-17272 identify the file at `1:1` and contain only `'test failed'`. There are no named reset-test results, useful stack, exit code, signal, isolation violation, or asynchronous-error diagnostic for that worker in the saved log.
- The original `nets-task1-reset.log` reports all **11 individual reset tests passing**, no cancellations/skips, and **1055.343 ms** total duration. The original final focused log also includes the reset tests passing.
- Inspection of this installation's Node `v24.15.0` built-in `internal/test_runner/runner` shows that its child-exit handler can generate `test failed` for a nonzero exit code or a signal, and attaches that metadata to its error. The saved spec-reporter output does not retain which condition occurred. The message alone cannot establish a reset assertion failure, timeout, or application exception.

### Smallest relevant reproduction attempts

Every run used `--require ./tests/helpers/test-isolation.cjs --test`; the bootstrap remained active before application imports. Only in-memory SQL fixtures were exercised, with no real SQL engine or service access.

| Attempt | Files / configuration | Actual result |
| --- | --- | --- |
| Standalone comparison | `reset-demo.test.js`; TAP reporter; concurrency limit 2 | 11 passed, 0 failed; 1106.0754 ms |
| Adjacent reset/store workers | `reset-demo-redis.test.js` + `reset-demo.test.js`; TAP; concurrency 2 | 12 passed, 0 failed; 1676.5156 ms |
| Bootstrap/subprocess interaction | `isolation.test.js` + `reset-demo.test.js`; TAP; concurrency 2 | 19 passed, 0 failed; 1854.0252 ms |
| Lifecycle trace | Reset/store pair; TAP; concurrency 2; temporary diagnostic preload | 12 passed, 0 failed; 1385.0918 ms |
| Related rejection state | `rejection.test.js` + `reset-demo.test.js`; spec reporter; default concurrency | 22 passed, 0 failed; 1292.3548 ms |
| Original reporter, repeat 1 | Reset/store pair; spec; default concurrency | 12 passed, 0 failed; 1975.0444 ms |
| Original reporter, repeat 2 | Same two-file command, immediately repeated without delays | 12 passed, 0 failed; 1846.4863 ms |

All seven runner processes exited **0**, with no signal, cancellations, or skipped tests. No whole-suite, broad stress run, or arbitrary delay was used. An example reproduction command is:

```text
node --require ./tests/helpers/test-isolation.cjs --test --test-concurrency=2 --test-reporter=tap tests/reset-demo-redis.test.js tests/reset-demo.test.js
```

Logs and temporary instrumentation are under `%TEMP%\nets-task1-reset-investigation`: `standalone.tap`, `redis-reset-pair.tap`, `isolation-reset-pair.tap`, `traced-pair.tap`, `rejection-reset-pair.log`, `spec-pair-repeat-1.log`, `spec-pair-repeat-2.log`, `lifecycle-probe.cjs`, and per-process `lifecycle-*.jsonl` records. Original Task 1 logs were preserved.

### Worker isolation, shared state, teardown, and timing

- The traced pair ran in distinct worker PIDs, each with its own MemoryStore and database fixture. Each process confirmed that its database module export was its own shared fixture. Synthetic Redis configuration set by the Redis-characterization worker was absent in the reset worker. The pair therefore showed no cross-worker environment, module-cache, or application-state leakage.
- Within the reset file, tests are not configured to run concurrently. The fixture resets before each test, provider mocks are restored after each test, and campaign state is reset. The session-save failure test restores `demoStore.set` in a `finally` block. No missing restoration was found on the exercised paths.
- The existing teardown calls `server.close()` without returning a promise or awaiting its callback. This is a possible teardown weakness, not a confirmed cause of the original failure. In the lifecycle trace, `close()` ran at approximately 1274.10 ms, the server's `close` event fired at 1276.09 ms, `beforeExit` ran at 1282.18 ms, and the worker exited 0 at 1285.15 ms. It had zero tracked HTTP listeners remaining and no monitored uncaught exception. A `Timeout` resource appeared alongside runner pipes at `beforeExit`, but did not prevent normal exit; it does not diagnose the earlier failure.
- The traced reset and Redis workers both reported **zero** private environment loads/reads, real MySQL factories, Redis factories, or blocked connection attempts. All requested service boundaries remained intact.
- No explicit reset-test timeout or package-level test timeout was found. Passing targeted runtimes were approximately 1.1-2.0 seconds; the original 3.1-second file duration alone does not identify a timeout. Larger-suite scheduling/resource effects were not reproduced or ruled out by these small combinations.

**Conclusion:** the original worker failure cannot currently be reproduced. There is no confirmed Task 1 cause justifying a code change, assertion change, teardown workaround, or added delay. The historical worker exit remains an unresolved verification blocker, with its underlying exit code/signal and cause unknown. If it recurs, retain TAP or structured worker diagnostics including exit metadata and lifecycle events before attributing it to reset logic. This follow-up does not change the previously recorded full-suite result or claim a green full suite.

## Browser status and manual checks

No isolated browser check, screenshot review, laptop check, or mobile check was performed. HTTP/template assertions and the layout-hook check are automated source/server checks, not visual acceptance.

For later manual review, start only an isolated fixture instance (for example, `node --require ./tests/helpers/test-isolation.cjs app.js` on a free port). The helper keeps server-side database/provider access blocked. A separate browser may still load the template's existing public CDN assets; the Node guard is not a browser network sandbox.

- On laptop and mobile viewports, inspect Home's three recommendation cards and Merchant Report's available samples and explicit unavailable states.
- Reject a card through the normal UI; confirm one response and a usable next recommendation.
- Complete simulated payment and Vouch/shared-offer journeys, then inspect report live figures.
- Run Reset Demo only on that fixture instance; confirm live state clears and sample figures remain.

Suggested commit title: `fix: isolate tests and repair report and rejection runtime paths`.
