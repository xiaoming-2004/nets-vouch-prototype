# Task 7: disposable MySQL 8 rehearsal (executed and passed on 17 November 2026)

Task 7 adds migration `Database/migrations/005_task7_menu_items.sql` and seed `Database/seeds/005_task7_menu_data.sql`. This document is the rehearsal that had to pass on a throwaway database **before** installation on the local `netsvouch` database, and it records what was found and done. The rehearsal needed **separate approval**, which was given. It passed on 17 November 2026 and the files were then installed (see "Record of the 17 November 2026 run" below and `docs/task7-grounded-menu.md`). The procedure remains the reference for any future change to the menu migration or seed: rehearse again on a fresh disposable database, never on `netsvouch`, and request separate approval before installing.

## Rules

- Use a **uniquely named** temporary database (for example `task7_rehearsal_<timestamp>_<random>`) and a **restricted user** created only for it, with privileges on that database alone. Never connect as `root` to the real `netsvouch` schema, never reuse its credentials, and print no credentials.
- **Never execute `Database/db.sql`.** It drops and recreates tables and seeds users.
- Build a **minimal required baseline** explicitly (below). Do not copy or restore `netsvouch`.
- The migration and seed contain `USE NetsVouch;`. Never edit the repository files: copy each to a scratch directory and replace that one line with `USE <rehearsal database>;` in the copy only. Run the copies with the restricted user.
- Everything is cleaned up at the end, whether or not the rehearsal passed.

## 1. Minimal baseline (explicit; no `db.sql`)

Create, in the rehearsal database only, the subset of the existing schema that migration 005 and the seed depend on, plus sentinel tables:

1. `sample_datasets` and the Task 3 additions to `merchants` exactly as defined by `Database/migrations/003_task3_sample_schema.sql` (apply the **copy** of 003 after creating the base `merchants` table below, so the real migration is also rehearsed).
2. Base `merchants`: `merchant_id VARCHAR(64) PRIMARY KEY, name VARCHAR(120) NOT NULL, location_label VARCHAR(160) NOT NULL, distance_metres INT NOT NULL, cuisine_type VARCHAR(64) NOT NULL, typical_price DECIMAL(6,2) NOT NULL, dietary_halal BOOLEAN DEFAULT FALSE, dietary_vegetarian BOOLEAN DEFAULT FALSE, dietary_vegan BOOLEAN DEFAULT FALSE, reward_amount DECIMAL(6,2) NOT NULL DEFAULT 0.50, min_spend DECIMAL(6,2) NOT NULL DEFAULT 5.00, is_sample_data BOOLEAN NOT NULL DEFAULT TRUE`.
3. Insert the ten Task 3 merchants and the `nets-vouch-task3-v1` dataset row. The simplest faithful way is the copy of `Database/seeds/003_task3_sample_data.sql`; a small hand-written insert of the ten merchant rows plus the dataset row is acceptable if the 4,200 activity rows are not needed.
4. Sentinel tables with a few rows each and the same shapes the real application uses: `users` (two rows), `transactions` (one row), `rejection_feedback` (one row, from migration 004), and `merchant_sample_activity` (a handful of rows if the Task 3 seed was not applied).

## 2. Fingerprints

Before each step record, for every non-menu table: row count, `CHECKSUM TABLE`, and a hash of the `information_schema` definition (columns, indexes, foreign keys, CHECK constraints, engine, collation). Record the same for the two menu tables once they exist.

## 3. Steps and expected results

1. **Install migration 005 (copy).** Both tables exist; no existing table definition or row changed (fingerprints equal for every non-menu table).
2. **Rerun migration 005.** No error and no change (an existing compatible definition is validated, never altered). Fingerprints identical.
3. **Install the seed (copy).** 33 items and 119 category/tag rows; all rows `sample-unverified`; item flags consistent with merchants; merchants unchanged.
4. **Rerun the seed.** No error, **identical fingerprint** for the menu tables and every other table.
5. **Collision before change.** On a fresh copy of the post-migration state, pre-insert (a) an item with an owned ID but a different price, (b) an item with an owned ID under another `menu_version`, (c) an owned-version item missing from the definition, and (d) an item whose merchant is not an owned sample merchant. Each run must abort with the matching `Task 7 menu seed:` message and **zero** permanent change.
6. **Incompatible existing table.** Before migration 005, pre-create each menu table with a deliberate difference (missing CHECK, wrong column type, missing foreign key, wrong collation, wrong engine). The migration must abort with a `Task 7 menu migration:` message naming the table and element, and change nothing. Confirm the information_schema signatures the generated migration compares against (especially `column_type` and `column_default` rendering and CHECK constraint names) match what MySQL 8 really reports; fix the generator, not the file, if they do not.
7. **Transactional rollback.** Force a failure after the first insert (for example temporarily make a staged price violate `chk_menu_price` in the scratch copy). The seed must roll back completely: the post-failure fingerprint equals the pre-seed fingerprint.
8. **Sentinel preservation.** After every step, all sentinel and Task 3 tables match their recorded fingerprints; no user, merchant, transaction, feedback or activity row changed.
9. **Behavioural spot checks** (read only): the application's batch menu `SELECT` returns the expected rows for the ten merchant IDs, one statement, with parameters.
10. **Clean up.** Drop the rehearsal database and the restricted user, delete the scratch copies, and confirm neither remains. Do this even after a failure.

## 4. After a passing rehearsal

Only then request separate approval to install on the local `netsvouch` database: take a verified backup, run migration 005 then seed 005 once, confirm the same fingerprints for every pre-existing table, and verify one food request end to end. Do not install earlier.

## 5. Record of the 17 November 2026 run

**What the rehearsal found (and the shared specification fixed) before it passed.** Each failure stopped the run, was cleaned up, and was fixed in `sample-data/nets-vouch-task7-menu.cjs` with the migration regenerated from the renderer (never hand-edited):

1. MySQL auto-created an index named `fk_menu_dataset` for the dataset foreign key, so the migration could not accept its own schema on rerun. Fix: an explicit `idx_menu_dataset (dataset_key)` index.
2. A CHECK that evaluates to NULL passes, so a vegan item with an unspecified vegetarian flag was accepted. Fix: the null-safe `is_vegetarian <=> 1`, plus a flag-range check (`chk_menu_flag_values`).
3. The case-insensitive collation made `REGEXP '[a-z]'` accept `Bad` and `=` treat mixed case as equal. Fix: `REGEXP_LIKE(..., 'c')`, `BINARY` comparisons and a lower-case ownership-format check. MySQL canonicalises ENUM values before any CHECK runs, so a differently cased enum spelling is stored as the canonical value; this is documented, not redesigned.

**Final passing run: all 24 steps passed**, from a fresh uniquely named database and restricted user each time:

- disposable database and restricted user created; privileges asserted (global USAGE only, exactly one database scope, no GRANT OPTION, no roles); the restricted user could not reach `netsvouch`, `mysql.user`, or create databases;
- minimal baseline built explicitly (no `db.sql`) from base tables plus the real migrations 003 and 004 and sentinel rows, matching production's engine, charset and collation (InnoDB, `utf8mb4_unicode_ci`); the retargeted copies of migration and seed 005 equalled the reviewed files except the one `USE` line;
- **S1** fresh migration, with columns, engine, collation, indexes, foreign keys and enforced CHECKs verified; **S2** migration rerun with an identical schema fingerprint;
- **S3** seed: 33 items, 119 terms, ten merchants, ownership, coverage and dietary invariants, and the application's own loader accepting the rows; **S3b** 26 invalid rows refused and 8 valid cases accepted (NULL/0/1 flag combinations and the two ENUM canonicalisation cases), nothing persisting after rollback;
- **S4** seed rerun with an identical fingerprint; **S5** five collision cases (conflicting ownership, differing definition, extra owned item, extra owned term, non-owned merchant), each aborting with zero permanent change; **S6** four incompatible-table cases (missing CHECK, column type, missing index, wrong collation) aborting with a `Task 7 menu migration:` message and changing nothing, then a passing migration after each restore;
- **S7** a rehearsal-only trigger forced a failure during permanent insertion: no partial item or term rows, sentinels unchanged, then a clean successful seed reproducing the earlier fingerprint;
- sentinel and Task 3 tables matched their recorded fingerprints after every step; the database, user and temporary directory were dropped, and an independent check showed zero rehearsal databases and zero rehearsal accounts remaining.

**Residual routines after a failed run.** The mysql client stops at the first error, so its own `DROP PROCEDURE` never runs. Each of the ten failing scenarios left `task7_seed_menu_v1` or `task7_menu_migrate` behind, and the harness dropped it and recorded a warning. A successful run leaves nothing.

**Local installation (17 November 2026, application stopped).** After a verified backup, only migration 005 and then seed 005 were executed on `netsvouch`. `Database/db.sql`, other migrations and other seeds were not run. Results: 33 menu items and 119 category/tag rows; ten owned merchants; all rows `nets-vouch-task3-v1`, `task7-menu-v1`, `sample-unverified`, sample data; menu fingerprint prefix `679229828ad1062b` (identical to the rehearsal's); all eight existing tables (`merchant_activity_slots`, `merchant_opening_hours`, `merchant_sample_activity`, `merchants`, `rejection_feedback`, `sample_datasets`, `transactions`, `users`) unchanged by row counts, `CHECKSUM TABLE` and canonical structure fingerprints; no procedures, triggers or temporary objects left behind. Backup: `C:\Users\mangg\OneDrive\Documents\Nets Polyfintech\rollback-backups\netsvouch-pre-task7-menu-20261117-060516.sql` (373,433 bytes, verified complete and covering all eight tables).

**Harness bug during installation (not an application or data defect).** The install script's last verification step reported `menu-catalogue-unavailable` because its database connection had no default database, while the application loader's SQL intentionally uses unqualified table names. Migration and seed had already succeeded. A separate read-only verification connected to `netsvouch` and repeated every check, which all passed. Any future verification script must select the schema before calling the loader.

## 6. Failure recovery

If a migration or seed run fails (against a rehearsal database or, in future, `netsvouch`):

1. **Keep the application stopped.** Do not restart it to "see what happens".
2. **Inspect the failure.** Read the `Task 7 menu migration:` or `Task 7 menu seed:` message, and compare the row counts and fingerprints of every pre-existing table with the pre-run record. The seed is one transaction that rolls back completely, and the migration validates before it changes anything, so a failure should have changed nothing permanent.
3. **Check for a residual procedure.** A failed client run may leave `task7_seed_menu_v1` or `task7_menu_migrate`. First confirm the target schema is the intended one (`SELECT DATABASE()`), list the schema's routines in `information_schema.routines`, then drop **only** the exact named procedure that is present (`DROP PROCEDURE <schema>.task7_seed_menu_v1` or `DROP PROCEDURE <schema>.task7_menu_migrate`). Drop nothing else.
4. **Do not use `--force`.** It would let the client continue after an error and obscures what failed.
5. **Do not blindly rerun** the migration or seed, and never execute `Database/db.sql`. Fix the cause, rehearse again on a fresh disposable database, and request separate approval before touching `netsvouch` again.
