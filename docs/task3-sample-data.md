# Task 3 labelled sample data

Prepared for review on 16 November 2026 (Asia/Singapore). These files have not been run against a real database. Do not use `Database/db.sql` to install them: that file is destructive and is not part of Task 3.

## Dataset contract

`nets-vouch-task3-v1` contains ten fictional merchants using the stable IDs and existing catalogue facts and reward terms from the prototype. Names, cuisine, price, explicit dietary flags, coordinates, opening hours, and activity are demonstration data. They do not identify participating businesses, actual NETS traffic, live queues, or verified dietary certification.

The documented origin is Republic Polytechnic demo origin at `1.442800, 103.785400`. `distance_metres` is a rounded straight-line demo-origin estimate. It is not GPS-derived, a walking route, or a promised travel time. Coordinates were selected so each straight-line calculation is within two metres of its stored estimate.

All activity uses Singapore wall-clock dates and times with dataset timezone `Asia/Singapore`:

- Four complete Monday-Sunday weeks: 19 October through 15 November 2026.
- Fifteen one-hour slots per day, starting at 07:00 through 21:00 and ending at 22:00.
- `10 merchants × 28 dates × 15 slots = 4,200` rows.
- 2,440 `OBSERVED` rows, including 28 explicit zero-count observations.
- 40 `MISSING` open-period observations: one controlled gap per merchant per week.
- 1,720 `CLOSED` rows derived from the declared opening hours.

An `OBSERVED` row always has a nonnegative integer transaction count. `MISSING` and `CLOSED` rows always have a null count. Missing and closed rows must be excluded from averages; observed zeroes must be included. The fixed merchant/hour profiles, weekday factors, and week adjustments are deterministic and are intended to support later merchant/weekday/hour comparisons against that merchant's own baseline. Task 3 does not calculate those averages.

Historical sample activity is stored only in `merchant_sample_activity`. It is not inserted into `transactions`, `merchant_activity_slots`, the in-memory payment feed, or campaign metrics. Production recommendations do not read the new coordinates, hours, or activity in this task.

## Files and generation

- `sample-data/nets-vouch-task3.cjs` is the shared definition used by isolated fixtures and the SQL renderer.
- `scripts/render-task3-sample-seed.cjs` deterministically renders `Database/seeds/003_task3_sample_data.sql`.
- `tests/helpers/task3-sample-fixtures.cjs` applies the same definition to an isolated in-memory store.
- `tests/task3-sample-data.test.js` checks the definition, fixture behavior, and generated artifact.

Regenerate the reviewed seed without database access:

```text
node scripts/render-task3-sample-seed.cjs
node scripts/render-task3-sample-seed.cjs --check
```

The renderer only writes the checked-in SQL file. It does not load database configuration or connect to MySQL.

## Installation order and rerun behavior

Stop for review before installation. After approval, first test both files on a disposable MySQL 8 database using the same schema shape and SQL mode as the target.

1. Run `Database/migrations/003_task3_sample_schema.sql`.
2. Review the resulting schema and constraints.
3. Run `Database/seeds/003_task3_sample_data.sql`.
4. Verify the installed dataset with read-only queries before considering production installation.

The migration is additive and rerunnable. It uses `CREATE TABLE IF NOT EXISTS` and `information_schema` checks before adding merchant columns or named constraints. It never drops a table or column. MySQL DDL can implicitly commit, so the migration is deliberately separate from seed DML and is not fully rollbackable. A backup and disposable-environment rehearsal are required.

The seed requires permission to create and drop its uniquely named temporary stored procedure as well as normal DML privileges. Temporary staging tables are populated first. The procedure starts a transaction, validates staged cardinality and every permanent ownership/collision condition, then performs permanent inserts/upserts. An SQL exception rolls back the permanent DML.

Before any permanent write, the seed aborts when:

- its dataset key exists with different metadata;
- a target merchant is non-sample, belongs to another dataset, or differs in any established identity, catalogue, dietary, price, distance, or reward fact;
- an existing opening-hours or activity row under this dataset key has a key outside the complete staged definition; or
- the staged definition is not exactly ten merchants, 28 dates, 150 merchant/hour profiles, and 4,200 activity rows.

Absent merchants are inserted. A legacy merchant is claimable only when it is already marked sample data, has no dataset owner, and all established facts exactly match. On duplicate merchant IDs, the seed updates only Task 3 coordinates, dataset ownership, sample label, and dietary-claim status; it does not overwrite established merchant or reward facts. Opening/activity upserts are restricted to the validated dataset key. The seed never deletes rows. An unchanged rerun is idempotent; changed historical definitions should use a new versioned dataset key.

## What isolated verification does and does not prove

The isolated tests prove JavaScript definition validity, exact row counts, deterministic generation, coordinate/distance coherence, opening-state consistency, logical foreign-key ownership, fixture collision atomicity, rerun stability, and that the checked-in SQL matches the renderer. The existing Task 2 fixture tests verify that unchanged production recommendation and Scan behavior still works under the in-memory database guard.

These tests do **not** parse or execute the SQL with MySQL. They do not prove server-version syntax, SQL-mode behavior, enforced `CHECK` constraints, privileges, collation behavior, transaction behavior, migration compatibility with the actual schema, or seed performance. Those remain installation gates for a disposable real MySQL 8 environment. No live database, migration, seed, browser, or full-suite verification is claimed.

## Rehearsal and local installation record

Completed on 16 November 2026 (Asia/Singapore) with MySQL Community Server 8.4.6. The application was stopped and no Node application process was running during installation. `Database/db.sql` was not executed.

The final disposable rehearsal used a uniquely named database and an account with only global `USAGE` plus `ALL PRIVILEGES` on that exact rehearsal schema, without grant option or roles. Access to `NetsVouch` was rejected before setup or scenario SQL ran. The migration installed and reran with identical column/constraint metadata; all Task 3 checks and foreign keys reported `ENFORCED=YES`. The seed installed and reran with identical canonical, primary-key-ordered fingerprints.

Rehearsal failure scenarios also passed:

- A changed established price caused the seed to reject the merchant collision before permanent data changed.
- A rehearsal-only `CHECK` constraint rejected the activity insert after earlier seed DML had begun; the procedure's exception handler rolled the dataset, merchant metadata, opening hours, and activity back to the exact pre-call fingerprint.
- Guard user, transaction, and campaign rows remained unchanged.
- The generated rehearsal database and account were removed.

Before local installation, all ten existing target merchant rows matched the reviewed legacy sample facts and none conflicted with non-sample business data. A fresh structure-and-data dump was created and verified outside the repository at:

```text
C:\Users\mangg\OneDrive\Documents\Nets Polyfintech\rollback-backups\netsvouch-task3-preinstall-20261116134701.sql
```

The verified backup is 9,423 bytes and contains database selection, table structure, and data inserts. The additive migration and transactional seed were then applied to the local `netsvouch` database in that order. Installed totals are:

| Item | Installed total |
| --- | ---: |
| Dataset records | 1 |
| Task 3 merchants | 10 |
| Opening-hour records | 67 |
| Activity records | 4,200 |
| `OBSERVED` | 2,440 |
| Observed zero counts | 28 |
| `MISSING` | 40 |
| `CLOSED` | 1,720 |

The installed period remains 19 October through 15 November 2026 with ten merchants, 28 dates, and fifteen hourly starts per date. A restricted restore of the pre-install backup into a separate comparison database verified that two user rows, zero transaction rows, zero rejection-feedback rows, six legacy `merchant_activity_slots` rows, and all ten merchants' established core facts were unchanged. A database campaigns table was absent both before and after installation; in-memory application campaign state was not running during installation. The comparison database and account were removed.

Jolene's Step 1 (labelled fictional sample data) is complete. Step 2 still needs the usual-activity averages and merchant-relative comparison, with missing and closed slots excluded and observed zeroes included. Step 3 still needs the intended-day/time recommendation API contract and grounded usual-activity result field. Step 4 still needs durable per-profile rejection feedback that changes later results and survives refresh/restart. Those stages remain outside Task 3 and must not reinterpret this sample history as live queues or actual NETS traffic.
