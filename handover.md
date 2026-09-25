# NETS Vouch Prototype — Codex Handover

_Last updated: 25 Sep 2026 (Smart Match sections). Earlier note — 23 Sep 2026: Everything except AI Smart Matching is built and tested (195 tests passing). See **REMAINING ROADMAP**._

## Project

NETS Vouch is a coded prototype for the PolyFinTech Challenge 2026 / Republic Polytechnic Open House demonstration.

Team: Capital 6.

The prototype should feel like a polished, working product rather than a static mock-up.

The current technical stack is intentionally simple and RP-friendly:

- Node.js
- Express
- EJS
- express-session
- Vanilla JavaScript
- CSS
- CommonJS

Do not introduce a large framework or database unless explicitly requested.

---

# Product Thesis

NETS Vouch helps users decide where to spend, verifies the resulting NETS payment, and turns that verified outcome into a measurable merchant referral loop.

Core principle:

> Rules decide what is possible. AI decides which valid option to recommend. The user decides whether to accept.

---

# LOCKED CONSUMER FLOW

The old preorder flow is permanently removed.

Do NOT reintroduce:

- preorder
- food-order confirmation
- PENDING_PAYMENT food orders
- merchant order queue
- preparing
- ready
- collection
- kitchen fulfilment
- POS replacement
- item-level receipt dependency

Current consumer flow:

```text
Smart Match
→ choose merchant
→ physically visit merchant
→ scan merchant QR
→ enter actual purchase amount
→ pay through simulated NETS
→ earn eligible merchant-specific Vouch Credit
→ optional Payment-Verified Vouch
→ share
```

---

# CONSUMER NAVIGATION

Current bottom tab bar (customer):

```text
Home
Scan
Activity
Profile
```

Home:
Smart Match / help me decide where to spend.

Scan:
User is already at the merchant and wants to pay.

Activity:
NETS payment history (also reachable from Profile).

Profile:
Vouch Credits, My Vouches, NETS Activity, Preferences, Notifications, and a small **Reset Demo** button at the bottom.

Top-right avatar opens a **Switch view** menu:

```text
Jia · Customer app      → /home
Merchant · Merchant dashboard → /merchant
View profile            → /profile
```

Merchant view (`/merchant`) uses its own bottom tab bar:

```text
Campaign   (/merchant?merchantId=<id>&tab=campaign)
Results    (/merchant?merchantId=<id>&tab=results)
```

The avatar shows a red "M" in merchant mode. Do not put customer tabs on the merchant view.

---

# SMART MATCH — CURRENT OWNERSHIP

Smart Match (AI matching quality) is now the **only open workstream**. Everything else is frozen (see **CURRENT OWNERSHIP / FREEZE**).

Work on Smart Match must still:

- keep the deterministic safety rules below
- keep AI as ranker/interpreter only, never the authority on hard constraints
- keep the Tavily → Groq → OpenAI research layer provider-resilient
- keep all 195 existing tests green (replace obsolete tests with equivalent coverage only when architecture intentionally changes)

The current implementation is documented in **SMART MATCH — CURRENT IMPLEMENTATION** below.

---

# SMART MATCH — CURRENT IMPLEMENTATION

_Updated 25 Sep 2026 (dietary matching / caching / deadline fix). The code is the source of truth._

Core principle:

```text
Rules decide what is eligible.
AI only interprets and ranks eligible candidates.
Server validates every AI output.
Dietary suitability comes ONLY from validated, outlet-level evidence.
```

## End-to-end flow (`GET /smart-match/result`)

```text
browser GPS → POST /smart-match/location (session only)
→ ONE overall request deadline starts (request-budget.js, AsyncLocalStorage)
→ discovery: Google Places (New) primary → Foursquare fallback → curated demo merchants
     raw craving searched first and always kept; active dietary restriction adds ONE dietary search
→ container suppression + meal eligibility (MEAL / NON_MEAL / UNCERTAIN)
→ deterministic rules: shown/rejected, walking distance, "Too far" (strictly closer), budget, campaign
→ dietary restriction set: fresh evidence (shared store) → otherwise bounded research waves
     (Tavily → Groq → OpenAI) → only verified SUITABLE candidates continue
→ final ranking: Groq → OpenAI (shared budget) → deterministic rules, over verified/eligible candidates only
→ ONE recommendation, or an honest empty state
→ card extras: Place photo + halal badge from EXISTING evidence only (no badge research)
```

Key files: `app.js` (discovery, research, ranking, routes), `request-budget.js` (deadline + safe trace),
`research-store.js` (shared dietary evidence), `smart-match-result.js` (card photo / demo Vouches / Maps URL).

## Discovery (Google primary, Foursquare fallback)

- `getNearbyMerchants(location, sessionLabel, craving, maxDistanceMinutes, dietaryPreference)`.
- **No craving, no restriction:** 1 Google Nearby Search (distance-ranked, meal types, radius = walking limit).
- **Craving, no restriction:** raw Text Search; if < 5 usable → ONE Groq search-intent expansion + ONE expanded Text Search (or the ONE Nearby fallback). Raw results are always kept.
- **Restriction, no craving:** Text Search `"<diet> food"` (e.g. "halal food"); if < 5 usable → ONE Nearby Search merged in.
- **Restriction + craving:** raw craving Text Search, then ONE `"<diet> <craving>"` search merged after it (skipped when the craving already names the diet). No expansion.
- **Max per discovery:** 2 Google calls (+ at most 1 Groq intent call, only without a restriction). Foursquare fallback mirrors this: raw craving (or `"<diet> food"`) + at most ONE second query (dietary query, or broad `"food"` without a restriction) = max 2 calls.
- Dietary search terms are retrieval only (`fromDietarySearch` flag) — never evidence.
- Merged and de-duplicated by provider place ID. Discovery cache ~15 min per ~110 m bucket + mode + query/radius.
- Nearby Search no longer excludes `coffee_shop`; `classifyMealEligibility` keeps coffee_shop + strong meal-service type (MEAL) and rejects drink-only coffee shops, cafés, bakeries, desserts and containers.

## Dietary verification (strict)

- Options: none / halal / vegetarian / vegan. Places merchants start with `dietary: []`.
- Only research-verified `SUITABLE` merchants satisfy an active restriction — never unverified ones, never search retrieval, names, cuisine, Google types, pork-free menus or AI memory.
- **Outlet identity** (`sourceIdentifiesOutlet`): a cited source must contain the FULL brand name (not a prefix). For **halal** it must also contain an outlet signal when the merchant has one (its postal code, branch name after `@`/`-`/`|`/`(`, or parent venue) — another branch's certificate cannot verify this outlet. Vegetarian/vegan accept a chain's own menu for the brand.
- Vegetarian ≠ vegan; vegetarian/vegan SUITABLE also needs ≥ 1 evidenced item.

## Research (Tavily → Groq → OpenAI), bounded

- Research order: fresh cached VERIFIED candidate → used immediately, no research. Otherwise unchecked candidates: dietary-search results first, then nearest.
- **Waves**: up to 2 batches × 3 merchants (`RESEARCH_CONCURRENCY`=2). Tavily evidence for a wave is gathered in parallel; analysis runs batch by batch (a Groq 429 blocks Groq for the rest of the request; OpenAI reuses the SAME evidence).
- Stops at the FIRST verified merchant, at 12 merchants per request (`RESEARCH_MAX_MERCHANTS`), or when < 5 s remain.
- No Tavily call at all when no Groq/OpenAI key is usable. (A Groq 429 discovered on the first analysis can cost one wave of Tavily searches.)
- Tavily calls keep 2.5 s back for analysis + 1.5 s for ranking; page extraction only with ≥ 7 s left (else the strongest snippets are analysed, marked weak, same validator); advanced extract retry only with ≥ 12 s left.
- Outcomes: `researchUnavailable` (no provider could produce any verdict) → "We couldn't check <diet> options right now."; `verificationIncomplete` (some candidates unchecked because of time / the per-request limit) → "Still checking <diet> options nearby…" + "Check more places" (the next request continues with unchecked ones); all checked and none verified → "No verified <diet> matches found nearby."
- Dietary outcomes never trigger a discovery refresh (discovery already used dietary intent).

## Research evidence store (`research-store.js`)

- Layer 1 in-process `Map`; layer 2 the EXISTING Upstash Redis client (same client as sessions) when `UPSTASH_REDIS_REST_URL/TOKEN` are set. No other database.
- Key: `research-v7:<provider>:<stable place id>:<restriction>`. Value: validated verdict + sources + `verifiedAt` + `expiresAt` + `version`. No user data.
- TTL: SUITABLE/UNSUITABLE 7 days (`RESEARCH_VERIFIED_TTL_MS`); UNKNOWN 6 h (`RESEARCH_UNKNOWN_TTL_MS`); timeouts / HTTP / provider failures / deadline aborts are never stored.
- `hydrateMerchantResearch` loads fresh evidence (memory → ONE shared MGET). A merchant keeps its own session copy only while it is fresh (current version, unexpired) — a store miss never erases fresh evidence, stale/old-format evidence is dropped.
- Concurrency: in-process claim per key (other requests await the owner); with Upstash, a 25 s NX lock per key across instances (others poll the shared cache). Shared-store errors → logged once, memory-only for 60 s; matching continues.

## Time policy (configurable)

| Setting | Default | Meaning |
|---|---|---|
| `SMART_MATCH_DEADLINE_MS` | 6000 | whole request, no dietary restriction |
| `SMART_MATCH_DIETARY_DEADLINE_MS` | 15000 | whole request with an active restriction |
| `PLACES_REQUEST_TIMEOUT_MS` | 3000 | per Google/Foursquare call (capped by time left) |
| `SEARCH_INTENT_TIMEOUT_MS` | 1500 | Groq craving expansion |
| `SMART_MATCH_RANKING_MS` | 2500 | shared Groq → OpenAI ranking budget, then rules |

Every provider call is sized from the time left and cancelled at the deadline (AbortSignal). Fallback when time runs short: next Places provider / demo; raw craving; "verification incomplete" (never an unverified match); rules ranking.

## Result card (display only)

- Halal badge reads existing fresh evidence only: green "Halal" / orange "Non-halal" (evidence) / grey "Halal not verified". No badge-only research.
- Place photo (owner-uploaded only) within ≤ 500 ms of the remaining budget; the lookup is cancelled at the same limit (no work after the response).

## Craving ranking

- No craving dictionary; the raw craving goes to discovery and to the ranker. Ranker output `{merchantId, relevance, budgetFit, reason}`, validated; unsupported claims dropped; `low` relevance → fixed honest wording.

## Diagnostics

`logDiscovery` (non-production only) prints per request: discovery mode/queries and meal/non-meal counts, eligibility filter counts on empty results, research cache hits/misses, researched vs unchecked, provider call counts + timings, deadline notes, and the final selection or empty reason (`SMART MATCH REQUEST …`). Never keys or personal data.

## Live verification (25 Sep 2026, RP demo location, Google + Tavily + Groq, memory cache only — no Upstash/OpenAI locally)

| Request | Time | Result | Calls |
|---|---|---|---|
| Halal, no craving (cold) | 10.0 s | Red Ginger — verified halal | 1 Google text, 6 Tavily search, 2 Tavily extract, 3 Groq |
| Halal + "chicken rice" | 0.95 s | Red Ginger (fresh verified evidence reused) | 2 Google text, 1 Groq |
| Repeat of first, new session | 0.09 s | Red Ginger | 1 Groq (rate-limited → rules) |

Before the analysis-time reserve was added, a cold run spent its budget on page extraction and returned "still checking" after 13.5 s. Cold dietary requests are several seconds by nature (Tavily search ~3–4 s, extract ~6–8 s); warm requests are sub-second.

---

# SMART MATCH REJECTION RULES

Existing rejection reasons include:

- Too far
- Costs too much
- Not in the mood
- Ate this recently

Important:

`Too far` is a HARD deterministic constraint.

If a user rejects a merchant at 900m because it is too far, the next candidate must be strictly closer than 900m.

AI must never bypass this.

`Not for me` / rejection actions should normally reuse the existing merchant batch rather than call the Places API again.

Do not reintroduce immediate merchant repeats.

---

# FOURSQUARE

Foursquare is the automatic FALLBACK discovery provider (Google Places is primary; `PLACES_PROVIDER=foursquare` swaps them).

Current endpoint:

```text
GET https://places-api.foursquare.com/places/search
```

Authentication:

```text
Authorization: Bearer <FOURSQUARE_API_KEY>
X-Places-Api-Version: 2025-06-17
```

The API key must remain server-side.

Do not expose secrets to browser JavaScript.

Do not use:

```text
api.foursquare.com/v3/places/search
```

Do not use address-based `near=` for normal discovery.

Browser coordinates should drive searches through `ll=<lat>,<lon>`.

---

# ENVIRONMENT KEYS

All optional at startup; features degrade safely. Keys stay server-side and must never be logged or printed.

```text
GOOGLE_PLACES_API_KEY    primary discovery + result photo (server-side only)
FOURSQUARE_API_KEY       fallback discovery (neither key → curated local demo merchants)
PLACES_PROVIDER          google (default) | foursquare
TAVILY_API_KEY           live web/menu research (missing → no dietary verification, never AI memory)
GROQ_API_KEY             primary research reasoning, search intent and final ranking
OPENAI_API_KEY           research + ranking fallback (neither AI key → rule-based ranking)
UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN   sessions + shared dietary evidence (missing → memory)
```

Optional model overrides: `GROQ_RESEARCH_MODEL`, `OPENAI_RESEARCH_MODEL`, `GROQ_RANKING_MODEL`, `OPENAI_RANKING_MODEL`, `GROQ_SEARCH_INTENT_MODEL`. Time policy: see SMART MATCH — Time policy.

`.env` is not loaded automatically by `node app.js`; the deployment environment (e.g. Vercel) provides the keys. Locally, `GEMINI_API_KEY` / `GEOAPIFY_API_KEY` may exist in `.env` but are unused.

---

# MERCHANT MODEL

Real-world merchants returned by a Places API are NOT confirmed NETS Vouch partners.

They should use equivalent internal metadata such as:

```text
source: FOURSQUARE
participationMode: DEMO_SIMULATED
```

Do not claim these merchants genuinely participate in NETS Vouch.

Stable merchant IDs should be based on Foursquare place ID:

```text
foursquare-<fsq_place_id>
```

Do not use random IDs or merchant names as identity.

---

# PARENT VENUES

The product should recommend actual merchants/stalls rather than container locations where possible.

Example:

```text
Flying Wok
Yong Li Coffee Station · 46 m away
```

The recommendation is:

```text
Flying Wok
```

The coffee shop is contextual parent venue information.

Food courts, hawker centres, shopping malls and parent venue containers should not normally dominate Smart Match recommendations.

Do not globally exclude legitimate standalone cafés simply because their category contains “coffee” or “café”.

Implemented rules are listed under **SMART MATCH — CURRENT IMPLEMENTATION → Container / stall discovery**.

---

# PAYMENT FLOW

Current intended flow:

```text
Scan merchant QR
→ merchant identified
→ enter actual purchase amount
→ optionally apply that merchant's Vouch Credit
→ PAY
→ simulated NETS payment success
```

At least SGD 1 must remain paid through NETS for reward/Vouch eligibility.

Campaign minimum-spend rules may additionally apply.

A user may still complete payment below the campaign minimum, but should not receive an eligible reward.

---

# MERCHANT-SPECIFIC VOUCH CREDIT

Vouch Credit is NOT universal cashback.

Example:

```text
Felicia credit
→ usable only at Felicia
```

```text
Green Bowl credit
→ usable only at Green Bowl
```

Credits may accumulate over time.

Normal reward eligibility is approximately:

- successful simulated NETS payment
- active campaign
- qualifying minimum spend
- at least SGD 1 paid through NETS
- reward budget available
- rewarded-payment cap available
- user has not already earned that normal merchant reward for the relevant daily rule
- integrity checks pass

Do not turn Vouch Credit into platform-wide money.

---

# PAYMENT-VERIFIED VOUCH

After an eligible payment, the user may optionally create a Payment-Verified Vouch.

It proves:

> an eligible NETS payment occurred

It does NOT prove:

- merchant quality
- product quality
- payment amount publicly

One eligible transaction can create at most one Vouch.

Possible decision states may include:

```text
pending
created
skipped
```

`Not now` should record the skip cleanly.

Sharing the same Vouch through WhatsApp, Telegram or Copy Link should not create duplicate Vouches.

---

# SHARED VOUCH / REFERRAL FLOW

Current intended flow:

```text
Jia makes eligible NETS payment
→ creates Vouch
→ shares Vouch
→ Darren opens shared Vouch
→ Darren claims offer
→ claim itself gives NO reward
→ Darren visits same merchant
→ Darren pays through NETS
→ qualifying payment releases merchant-specific reward
```

Wrong merchant:

```text
no referral reward
```

Normal purchase reward and Shared-Vouch receiver reward must not stack incorrectly.

General rule:

> Maximum one customer reward per qualifying transaction, plus at most one eligible sender referral reward.

Optional sender referral reward may exist.

All merchant-funded rewards must respect the same merchant reward budget.

---

# REFERRAL INTEGRITY RULES

Preserve relevant anti-abuse controls such as:

- sender != recipient
- short claim expiry window
- sender/recipient/merchant cooldown
- merchant reward budget cap
- rewarded-payment cap
- refund/reversal protection
- anomaly/velocity checks where already implemented
- sender bonus only when budget remains

Do not weaken these rules without an explicit sprint requirement.

---

# ATTRIBUTION

Three important attribution channels:

```text
SMART_MATCH
SHARED_VOUCH
DIRECT_SCAN
```

SMART_MATCH:
Recommendation influenced merchant choice.

SHARED_VOUCH:
Friend referral influenced payment.

DIRECT_SCAN:
User was already at the merchant and scanned directly.

IMPORTANT:

Direct Scan is NOT Smart Match acquisition.

Do not count Direct Scan as Smart Match conversion.

---

# MERCHANT ANALYTICS

Desired analytics concepts include:

Smart Match:

```text
shown
accepted
paid
sales
conversion = paid / shown
```

Shared Vouch:

```text
claims
paid
sales
conversion = paid / claims
```

Direct Scan:

```text
payments
sales
```

Campaign/commercial metrics:

```text
reward spend
success fees
remaining reward budget
rewarded payments used
rewarded payments remaining
```

Do not label reward expenditure as NETS revenue.

Do not double-count customer and sender payouts as multiple transactions.

Do not claim guaranteed ROI, profit or incremental profit.

---

# COMMERCIAL MODEL

Illustrative model:

- merchant funds capped customer/referral rewards
- NETS may receive a small illustrative success-based platform fee after clearly attributed Smart Match or Shared Vouch payment
- Direct Scan should not automatically be treated as acquisition/success-fee revenue
- NETS also benefits from payment volume

Do not present illustrative success fees as proven commercial economics.

---

# NETS ACTIVITY

Implemented: current user's genuine session transactions only, newest first, transaction detail receipt, no +$0 / −$0 rows, clean empty state. Reached via the Activity tab and Profile.

---

# SESSION SAFETY

The application uses Express sessions.

User-specific state must remain session-scoped.

Do NOT store user-specific state in process-global variables where it can leak between visitors.

Visitor A must not inherit Visitor B's:

- location
- recommendation history
- transactions
- credits
- Vouches
- referral state

Static merchant/campaign configuration may be shared where appropriate.

---

# RESET DEMO

Implemented. `POST /reset-demo` resets all demo runtime state for every visitor (sessions, transactions, Vouches, claims, referral state, credits, live merchant metrics, campaign budget usage) and redirects to `/home?reset=done`. Static configuration is retained.

UI: a small outlined **Reset Demo** button at the bottom of Profile (and on `/demo`), shared partial `views/partials/reset-demo.ejs`, always behind a confirmation sheet:

```text
Reset the entire demo?
This clears all active visitor sessions and live demo data.
[ Cancel ] [ Reset Demo ]
```

Do not make it look like a normal consumer feature.

---

# DEPLOYMENT / PERSISTENCE

The prototype currently prioritises simplicity.

Some runtime data may exist in process memory/session memory.

Upstash Redis (optional) backs sessions and the shared dietary-evidence store (`research-store.js`); without it both fall back to process memory. Do NOT introduce MySQL, Firebase or another persistence system unless explicitly requested.

For an Open House prototype, temporary process-memory persistence may be acceptable if reset/restart behaviour remains safe.

---

# UI / IPHONE SHELL

The whole app renders inside an iPhone 16 Pro Max frame on desktop (shared partials `views/partials/start.ejs` / `end.ejs`): titanium frame, bezel, side buttons, Dynamic Island, live status-bar clock, translucent tab bar, home indicator. Content scrolls inside the screen only.

- ≤ 560 px wide (real phones): frame hidden, full-screen app with safe-area spacing.
- Logo: `public/images/nets-vouch-ai-logo.jpg` (supplied asset — do not redraw or alter). Device reference: `references/iphone-16-pro-max-reference.png`.
- Design tokens live at the top of `public/css/style.css` (`--nets-red`, `--nets-navy`, `--surface`, `--text-2`, `--r-lg`, …). Reuse them; don't scatter new colours.
- Smart Match loading shows "Finding nearby places…", then "Checking which places fit your preferences…" after 4 s (client-side only).
- Many tests assert visible strings ("Why this match?", "Choose this", "No camera? Tap a merchant", "Verified NETS Visit", "46 m away" …). Change wording only with matching test updates.

---

# TEAMMATE PRESERVATION RULE

CRITICAL:

Do not remove teammate features just because they are not part of the current sprint.

Before modifying a file:

1. inspect the existing implementation
2. identify the smallest safe change
3. preserve unrelated functionality
4. update/add focused tests
5. run the complete test suite

Never replace a teammate's feature with a simpler implementation merely to make the sprint easier.

---

# CODE STYLE

Prefer:

- simple readable functions
- existing architecture
- minimal dependencies
- server-side secret handling
- deterministic business rules
- testable pure helpers where appropriate

Avoid:

- unnecessary frameworks
- broad rewrites
- speculative abstractions
- massive new dependency trees
- changing unrelated files

---

# TESTING STANDARD

For every sprint:

Run relevant syntax checks.

At minimum where applicable:

```text
node --check app.js
node --check public/js/script.js
npm test
```

Do not weaken existing assertions simply to get green tests.

If existing tests become obsolete because architecture intentionally changed, replace them with equivalent regression coverage.

---

# LIVE TESTING HONESTY

Do not claim:

- live browser testing
- live geolocation testing
- real API verification
- multi-device testing

unless it actually occurred.

If only mocks/unit tests were possible, say so.

If network access exists and a live API call was performed, distinguish that from real-browser testing.

---

# CURRENT OWNERSHIP / FREEZE

Frozen (do not modify unless the user explicitly asks):

- payments, Vouch Credit, Payment-Verified Vouch, Shared Vouch/referral rules
- attribution and merchant analytics calculations
- Reset Demo backend behaviour
- NETS Activity
- UI shell and design system (small fixes only)

Open for work:

- **AI Smart Matching** — search quality, merchant research quality, craving ranking, dietary verification reliability. Location/GPS and container logic may be touched only if a Smart Match sprint needs it.

---

# REMAINING ROADMAP

Done:

```text
✓ API discovery caching / quota protection
✓ NETS Activity cleanup
✓ Reset Demo reliability (+ confirmation UI)
✓ Merchant analytics consistency
✓ Jia end-to-end regression
✓ Darren Shared-Vouch/referral regression
✓ Negative and edge-case testing
✓ Container/stall discovery fix
✓ Free-text craving ranking (no dictionary)
✓ Evidence-based dietary research (Tavily → Groq → OpenAI)
✓ Open House UI polish (iPhone 16 Pro Max shell, merchant view in same shell)
```

Remaining:

```text
1. AI Smart Matching quality  ← current focus
2. Feature freeze
3. Pitch deck alignment
```

Suggested starting points for AI Smart Matching:

- Re-run one live RP Vegetarian test to confirm the exact-outlet identity check removes the Cafe Esplanade-style false positive.
- Hawker stalls often have no web menu → many "no verified match" results; decide product wording/coverage (e.g. research further than 9 merchants, or accept honest no-result).
- Craving ranking still uses OpenAI only; with a Groq-only environment ranking falls back to rules. Consider reusing the Groq → OpenAI provider chain for ranking.
- Groq free tier (8k tokens/min for gpt-oss-20b): 3 batches in one minute is near the limit.
- Research latency (~20 s first dietary search, then cached 24 h) — consider UX/progress wording.
- The AI reason check is a small word-pattern filter, not full validation.
- Research sources are stored but not yet shown in the UI.

Do ONLY the current requested sprint.

Never automatically continue to the next roadmap item.

---

# FINAL REPORT FORMAT

At the end of every sprint:

- state exact files changed
- explain root cause where applicable
- explain implementation
- report new tests
- report complete test-suite result
- state whether unrelated teammate features were affected
- disclose live-testing limitations
- STOP

Do not begin another sprint automatically.