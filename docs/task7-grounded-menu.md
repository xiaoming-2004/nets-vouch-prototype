# Task 7: grounded menu items, quick food choices and dietary matching

Implemented on 17 November 2026 (Asia/Singapore). Food requests are matched only against a fictional sample menu stored in MySQL. The language model extracts the user's own words; deterministic rules and stored facts choose and rank merchants. Every item, price and dietary flag is demonstration data: not a real menu, not a participating business, and no dietary claim is verified certification. Migration and seed 005 were rehearsed on a disposable MySQL 8 database and then **installed on the local `netsvouch` database on 17 November 2026** (see "Verification and installation record" below and `docs/task7-mysql-rehearsal.md`). On any database where they are not installed, food requests return an honest `menu-catalogue-unavailable` and nothing else changes.

## Data

`merchant_menu_items` (33 sample items for the ten Task 3 merchants) and `merchant_menu_item_terms` (119 category/tag rows). Categories: rice, noodles, healthy-bowls, indian, wraps, soup, bread. Tags come from a fixed allowlist (`food-vocabulary.js`), including the explicit `light` tag (the only way "light" is ever applied). Item flags (`is_vegetarian`, `is_vegan`, `is_halal`) are 1 or NULL (NULL = unspecified = unsupported). Items carry `dietary_claim_status = 'sample-unverified'`, the Task 3 dataset key and `menu_version = 'task7-menu-v1'`. The single shared definition is `sample-data/nets-vouch-task7-menu.cjs`; `scripts/render-task7-menu-migration.cjs` and `scripts/render-task7-menu-seed.cjs` generate the SQL deterministically from it (`--check` verifies the committed files). Existing merchants, users, activity, feedback and `Database/db.sql` are untouched.

## Dietary truth

- Merchant flags mean the merchant **supports** the option, not that every item has it.
- With a food category or dish requirement, the exact matched item must satisfy the diet: halal needs an explicitly halal sample item at a halal-declaring merchant; vegan satisfies vegetarian; vegetarian never satisfies vegan; category or cuisine wording never proves a diet. A dietary-only request keeps the merchant-level behaviour of Steps 3 to 6 and does not read the menu.
- The saved profile is the default (highlighted, untouched) chip and is never changed by a chip.

## Requests

`foodCategory` (`any|rice|noodles|healthy-bowls|indian|wraps`) is accepted by `GET /api/recommend`, `POST /api/recommend/live` and `POST /api/recommend/natural`; legacy `cuisine` stays a soft preference with its old values. `any` is no requirement. A food category and supported typed dish terms are **hard grounded requirements that can only narrow** the already eligible set (budget, diet, campaign, rejection, activity closure, walking distance). Terms outside the stored vocabulary are listed under "Not applied". With no food requirement the menu tables are never read and responses are unchanged.

Step 5's interpretation contract accepts exactly the original 8 keys or exactly the v2 10 keys (adds `foodCategory`, `dishTerms`); the model is sent the strict v2 schema. Dish terms must be copied from the user's own words (every word must appear in the typed text), use lowercase letters/digits/spaces/hyphens (1 to 30 characters, at most 3), and cannot be dietary words. The server alone maps reviewed aliases (ayam to chicken; biryani/biriyani/briani to briyani; roti canai/canai/paratha to prata; beehoon to bee-hoon; kabab to kebab) onto stored terms. No fuzzy matching. Negated words ("no rice", "without chicken", "not vegan") become Not applied. A typed halal/vegetarian/vegan word the model omits, contradicts or invents rejects the interpretation as a whole.

## Chip and typed-text precedence

Untouched chip groups (defaults shown highlighted) are never sent and never conflict. Only actively changed chips are sent. For food and for diet separately: chip only, text only, or equal values apply; different values return HTTP 409 `natural-language-conflicts-with-selection` (naming `food` and/or `dietary`), no recommendations, previous batch and tokens preserved. A chip category plus typed dish terms is an AND on the same item.

## Matching and price

Normalisation lowercases, strips accents, turns hyphens and punctuation into spaces and singularises tokens by a fixed rule. Tiers: exact (the whole phrase is a stored tag/category or a whole-word phrase of the item name), then every-word-covered by the item's single-word terms (shown as not an exact dish name), then category only. When an item is matched its exact stored price controls budget eligibility and the price term of the score; the merchant typical price is shown separately and unchanged ("Recommended item price" and "Typical merchant price"). Without a food requirement the typical price rule is unchanged. Ranking otherwise still uses Step 2 activity, Step 3 ordering, Step 4 durable feedback and Step 6 walking time.

## Menu read and failure

One parameterised batch `SELECT` covers every catalogue merchant. Every row is validated; **any** malformed, cross-merchant, wrongly owned, wrong-version, wrong-identity, invalid-price, invalid-term or dietary-flag-exceeding row fails the whole read. The response is HTTP 503 `menu-catalogue-unavailable`, no recommendations, previous batch and feedback tokens preserved, no row content or database detail. A fallback demo catalogue also returns this error for a food request. In live mode the menu is read before the Google Routes request, so a menu failure never spends a Google call.

## Journey

The result is `recommendedMenuItem` (never a purchase): kept on the active batch merchant, the accepted snapshot and the Scan journey, and shown as "Recommended: <item> · $<price>" with the fictional-sample disclosure and "This is a recommendation, not a record of what you bought." It is removed (with the match reasons that quote it) when a snapshot is copied into transactions, receipts, shared Vouch offers and claims. Transaction `itemName` is never set from it. Payment amounts, rewards, counters, ownership, idempotency and Vouch mechanics are unchanged; Reset Demo clears it with the rest of the journey.

## Case sensitivity

The tables use a case-insensitive collation, so plain `=` and `REGEXP` would accept `Bad` where `[a-z]` is intended, and a differently cased dataset key would match its foreign key. The database CHECK constraints therefore use `REGEXP_LIKE(..., 'c')` (case-sensitive) for the item slug, the term and the ownership strings (merchant id, dataset key, menu version), and `BINARY` comparisons for the item identity (`item_id` against `merchant_id--item_slug`), the fixed claim status and the fixed category list. `availability` and `term_kind` are ENUM columns: MySQL canonicalises an enum value before any CHECK runs (for example `TAG` is stored as `tag`), so a differently cased enum spelling is stored as the canonical value rather than rejected, and the table design is not changed for that. The definition validator, the generated seed, the application loader (exact string comparisons, fail closed) and the request validators still enforce the intended lower-case input contract.

## Verification and installation record

- **Focused tests:** 213 passed (0 failed) across the Task 7, Step 3 to 6, rejection, catalogue, catalogue-scan, catalogue-render, reset-demo, template-js, merchant-activity and task3-sample-data suites.
- **Disposable rehearsal:** all 24 steps passed on a fresh uniquely named database with a restricted user (fresh and rerun migration, seed and rerun with identical fingerprints, 26 invalid-row cases refused and 8 valid cases accepted, five collision cases, four incompatible-table cases, forced transactional rollback with a clean recovery, sentinel preservation, verified cleanup). The rehearsal found and the shared specification fixed three database-level defects (an auto-created foreign-key index, a NULL-passing CHECK, and collation-dependent pattern checks); details are in `docs/task7-mysql-rehearsal.md`.
- **Installation:** migration 005 and seed 005 were installed on `netsvouch` on 17 November 2026 with the application stopped, after a verified backup. Installed totals: **33 menu items and 119 category/tag rows** for the ten fictional sample merchants, all `nets-vouch-task3-v1` / `task7-menu-v1` / `sample-unverified`. The menu fingerprint prefix is `679229828ad1062b`, identical to the rehearsal's.
- **Preservation:** all eight pre-existing tables (`merchant_activity_slots`, `merchant_opening_hours`, `merchant_sample_activity`, `merchants`, `rejection_feedback`, `sample_datasets`, `transactions`, `users`) are unchanged by row counts, `CHECKSUM TABLE` and canonical structure fingerprints. The successful installation left no procedures, triggers or temporary objects.
- **Backup:** `C:\Users\mangg\OneDrive\Documents\Nets Polyfintech\rollback-backups\netsvouch-pre-task7-menu-20261117-060516.sql`, 373,433 bytes (outside the repository).
- **Read-only smoke test** (mutation SQL blocked, Groq mocked in-process, no Google call): `foodCategory=rice`, `foodCategory=noodles` with the halal chip, and an exact "chicken rice" request returned only stored menu items and prices. There were 13 SELECT statements and no write, one batched menu read per food request, and the temporary server's port closed afterwards. No row changed.
- **Verification-script bug (not an application or data defect):** the install script's last check failed with `menu-catalogue-unavailable` because its connection had no default database while the loader's SQL uses unqualified table names. The migration and seed had already succeeded, and a separate read-only verification confirmed every check.
- **Normal application:** it remains stopped; it was not restarted after the installation and verification.

## Failure recovery

If a migration or seed run fails: keep the application stopped; inspect the failure and compare every pre-existing table's counts and fingerprints; a failed mysql client run may leave `task7_seed_menu_v1` or `task7_menu_migrate`, so confirm the target schema and drop **only** the exact named residual procedure; do **not** use `--force`; do not blindly rerun the file and never execute `Database/db.sql`. Successful runs leave no routine behind. The full procedure is in `docs/task7-mysql-rehearsal.md`.

## Limitations

- Task 8 owns the visual redesign; the chips here are functional, accessible and plain.
- The migration's `information_schema` signature checks and the CHECK constraints were confirmed on MySQL 8.4.6 by the rehearsal and the installation; a different MySQL version has not been tested.
- Chip layout, touch targets and keyboard behaviour have been checked only through HTML and CSS structure and DOM stubs, not in a real browser or on a phone.
- Dish terms must be the user's own words, so the model cannot translate (for example from another language) beyond the reviewed server aliases.
- Only 33 fictional items exist; real menus, availability and certification are out of scope.
