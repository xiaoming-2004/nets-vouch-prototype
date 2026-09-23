# NETS Vouch Prototype — Codex Handover

_Last updated: 23 Sep 2026. Everything except AI Smart Matching is built and tested (195 tests passing). See **REMAINING ROADMAP**._

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

Core principle:

```text
Rules decide what is eligible.
AI only interprets and ranks eligible candidates.
Server validates every AI output.
```

## End-to-end flow

```text
browser GPS (navigator.geolocation, maximumAge 0) → POST /smart-match/location (session only)
→ Foursquare Place Search (query = raw craving, or "food"; one broad "food" fallback if < 5 results)
→ merge both responses, THEN container/parent-venue suppression
→ deterministic rules: shown/rejected history, distance limit, "Too far" (strictly closer), campaign, known dietary NON_MATCH
→ if a dietary restriction is set: merchant research (Tavily → Groq → OpenAI) = hard filter, SUITABLE only
→ craving ranking AI (OpenAI chat completions, gpt-4o-mini) over the surviving candidates (max 20 in prompt)
→ server validates AI pick + reason; otherwise rule-based fallback ranking
→ ONE recommendation
```

Key functions in `app.js`: `getNearbyMerchants`, `parseFoursquareNearbyPlaces`, `isContainerName`, `getSmartRecommendation`, `applyDeterministicRejectionConstraint`, `applyMerchantResearch`, `researchMerchants`, `analyseMerchantResearch`, `validateResearchAnalysis`, `getAIRanking`, `safeAIReason`, `getFallbackRecommendation`.

## Container / stall discovery (done)

- Craving search and "food" fallback are merged by `fsq_place_id` and parsed once, so a parent referenced in either response is suppressed.
- Suppressed: places named as another place's `related_places.parent`; categories Food Court / Hawker Centre / Shopping Mall / Market; whole-phrase names (food court, food centre, hawker centre, kopitiam, coffeeshop, coffee shop).
- A "Coffee Shop" **category** alone is NOT suppressed (standalone cafés stay valid).
- Child stall keeps `parentVenueName` (from its own data or the parent place in the combined results).

## Craving (done)

- No craving dictionary. The raw craving is the Foursquare query; the craving AI interprets it semantically.
- AI output: `{merchantId, relevance: high|medium|low, budgetFit: within|over|unknown, reason}`.
- `low` relevance → fixed honest reason: "This is the closest available fit from the nearby options."
- Reason text is dropped (falls back to rule-based "Why this match") if it claims unsupported dietary, price, menu or rating facts.
- Fallback ranking uses distance/preferences plus a small bonus when the user's own words literally appear in the merchant name/category.

## Dietary (done — evidence-based)

- Options: none / halal / vegetarian / vegan (single select).
- No food-word dictionaries and no category shortcuts. Foursquare merchants start with `dietary: []`.
- Suitability comes ONLY from validated merchant research (curated local demo merchants keep their own tags).
- Active restriction → only research-verified `SUITABLE` merchants are recommended. None verified → "No verified <diet> matches found nearby." Research unavailable → "We couldn't check <diet> options right now."
- Mixed menus are fine (meat + one real vegetarian/vegan option = SUITABLE). Vegetarian ≠ vegan. Halal needs explicit outlet-level evidence (MUIS / official statement / reliable source).

## Merchant research layer (Tavily → Groq → OpenAI)

- **Tavily Search** (1 per merchant, 5 results): query = name + parent venue + address + "Singapore" + diet intent (`vegetarian menu` / `vegan menu` / `halal MUIS`).
- Results ranked by exact-merchant relevance, then generic source quality (gov/certification → official site → official social → delivery → listing → other → forums).
- **Tavily Extract** (basic, batched per 3-merchant batch) on the best 2 URLs per merchant; one batched advanced retry only for strong sources that came back unusable. Page text cleaned and capped at ~1,500 chars per source. If all extraction fails → top 3 snippets, marked `evidenceStrength: "snippets"`.
- **Analysis**: one request per batch asking ONE question per merchant for the active diet only. Groq (`openai/gpt-oss-20b`) primary; OpenAI (`gpt-4o-mini`) fallback with the SAME evidence. Groq 429 → Groq blocked for that request; no Tavily repeat for the fallback.
- **One validator** (`validateResearchAnalysis`):
  - whole response rejected (→ next provider): non-JSON, missing `results`, merchant ID outside batch/duplicate, any URL not from that merchant's supplied sources
  - per merchant: malformed entry dropped alone (not cached, retried later)
  - per field: bad status → UNKNOWN; bad item dropped; bad price → null
  - SUITABLE/UNSUITABLE need evidence + a cited source that **names the merchant** (exact-outlet identity check); vegetarian/vegan SUITABLE also needs ≥ 1 matching item
- **Limits**: batches of 3, stop at 2 verified, max 3 batches (9 merchants) per Smart Match, nearest first. No research at all when diet = none (cached research is still reused for ranking).
- **Cache**: in-process `Map`, key `research-v6:<fsq_place_id>:<restriction>`, TTL 24 h, provider-independent (`researchProvider` stored for debugging). Failed calls never cached.

## Discovery cache

Foursquare responses are cached ~15 min per ~110 m location bucket + query; distances are recalculated for each visitor's own coordinates.

## Live verification so far (honest status)

- Live Tavily → Groq single merchant (Genesis Vegan Restaurant): verified vegan, 4.5 s.
- Live RP Vegetarian run (41 merchants): Subway verified vegetarian from its foodpanda menu ("Falafel Sub"), ~23 s. That run also showed a false positive (Cafe Esplanade matched from a page about a different outlet); the exact-outlet identity check was added afterwards and is covered by tests but **not yet re-verified live**.
- OpenAI fallback: mocks only (no local OpenAI key).
- Gemini was evaluated and rejected (model retired / free-tier quota 429).

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

Foursquare is currently the merchant discovery provider.

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
FOURSQUARE_API_KEY   nearby merchant discovery (missing → curated local demo merchants)
TAVILY_API_KEY       live web/menu research (missing → no dietary verification, never AI memory)
GROQ_API_KEY         primary research reasoning
OPENAI_API_KEY       research fallback + craving ranking (missing → rule-based ranking)
```

Optional model overrides: `GROQ_RESEARCH_MODEL`, `OPENAI_RESEARCH_MODEL`.

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

Do NOT suddenly introduce MySQL, Redis, Firebase or another persistence system unless explicitly requested.

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