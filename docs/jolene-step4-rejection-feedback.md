# Jolene Step 4: durable rejection feedback

## Scope and status

Step 4 adds rules-based preference learning to the existing three-card recommendation API. It does not train a model, use AI, change payments or Vouch calculations, or alter Task 3 activity history. The migration was prepared without execution during implementation and was later installed through the reviewed process recorded below.

## Migration and persistence

Run `Database/migrations/004_jolene_step4_rejection_feedback.sql` once before deploying the application change. The migration is additive and rerunnable. It creates the legacy table when absent, or conditionally adds `submission_token`, `distance_metres`, `rejected_at_sg`, a per-user token uniqueness index, and a per-user Singapore-time read index. Existing rows remain unchanged; rows without the new timestamp do not participate in learning. MySQL DDL auto-commits and is not fully rollbackable.

Each returned recommendation receives a `crypto.randomUUID()` token. A rejection is authorised only when its merchant ID and token match the latest three-card session batch. The server stores the selected demo user, reason, and server-derived merchant category, typical price, distance and cuisine tags. SQL values are parameterised. The unique `(user_id, submission_token)` key makes an identical retry idempotent; reuse for a different merchant or reason is a conflict.

Malformed fields return HTTP 400. Stale batches, unshown merchants and token conflicts return HTTP 409. A database write failure returns HTTP 503 and leaves the active batch unchanged. AJAX success returns 204; a normal form submission keeps the `/home?matching=again` redirect.

## Recommendation effects

One prepared read loads the current persona's feedback from the current Singapore calendar day and the preceding 29 days. Hard budget, distance, cuisine and dietary eligibility still runs first, and Step 3 historical-activity scoring remains unchanged.

- **Too expensive:** exclude that merchant for 30 calendar days; apply one non-stacking -30 price penalty at or above the lowest relevant rejected price minus $0.50.
- **Too far:** exclude that merchant for 30 calendar days; apply one non-stacking -30 distance penalty at or beyond the lowest relevant rejected distance minus 80 metres.
- **Not this cuisine:** exclude that merchant for 30 calendar days; apply one non-stacking -30 penalty for normalized exact factual category/cuisine matches.
- **Just not today:** exclude that merchant only on the rejection's Singapore calendar date; apply no broader penalty.

Price, distance and cuisine matches produce at most one -30 learned penalty per candidate; neither repeated feedback nor multiple matching dimensions stack. An explicitly supplied `budget`, `maxDistance` or `cuisine` suppresses only its corresponding similarity signal. Exact rejected-merchant exclusion remains authoritative. Activity that is insufficient or unavailable remains neutral.

## Reset and failures

Reset Demo uses a database transaction to reset preferences and delete feedback with `WHERE user_id = ?` for only the selected persona. A database failure rolls back and is reported; in-memory state is not reset. After database success, only the selected persona in the current session is reset. Other personas, browser sessions, transactions, merchants, activity rows, campaigns and campaign metrics are not swept. Shared offers created by the resetting persona are removed; other personas' offers remain.

## Isolated verification

The focused tests use the existing isolated database fixture. They cover all four stored contexts, HTTP status rules, exact merchant/token authorization, duplicate and conflicting tokens, fresh-session hydration, Jia/Darren isolation, deterministic Singapore-midnight expiry, bounded penalties, explicit-filter precedence, feedback read/write failures, scoped reset rollback, Step 3 activity behavior, catalogue/Scan journeys, payment/Vouch snapshots, and absence of broad SQL.

The isolated tests alone did not prove the migration against a real MySQL server. The later local installation and schema/index verification are recorded below.

Implementation verification on 17 November 2026:

- `node --check` passed for `app.js`, `rejection-feedback.js`, `public/js/script.js`, the isolation fixture, and the changed Step 3/Step 4/rejection/reset tests.
- The focused Node test run passed **112 tests, 0 failed** across Step 4, Step 3, merchant activity, Task 3’s data contract, rejection, reset, catalogue, Scan/payment/Vouch snapshots, and template/public-JavaScript compilation.
- That implementation-only check did not run a migration, seed, browser automation, live MySQL access, or the full suite; the later reviewed local installation is recorded below.

## Local MySQL installation

The additive migration was installed in the local `netsvouch` database on **17 November 2026** after the application process was stopped.

- Backup: `C:\Users\mangg\OneDrive\Documents\Nets Polyfintech\rollback-backups\netsvouch-pre-jolene-step4-20261117-105135.sql` (structure and data; verified non-empty at 373,659 bytes).
- Migration executed: `Database/migrations/004_jolene_step4_rejection_feedback.sql` only. No `db.sql`, seed, or other migration was executed.
- MySQL verification: `submission_token CHAR(36)`, unsigned `distance_metres`, `rejected_at_sg DATETIME`, unique `(user_id, submission_token)`, and read index `(user_id, rejected_at_sg, feedback_id)` are installed.
- Preservation: rejection feedback, users, merchants, transactions, and sample-activity counts were unchanged. A canonical fingerprint covering every unrelated table's columns, indexes, engine, and collation was identical before and after migration.
- Read-only application check: a temporary server returned HTTP 200 with three recommendations; catalogue status was `ok`, historical activity was `available`, and feedback history was `applied`. No rejection, reset, payment, seed, or other write request was made. The temporary server was then stopped.
