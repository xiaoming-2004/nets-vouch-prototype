# NETS Vouch Prototype — Codex Handover

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

Current intended navigation:

```text
Home
Scan
Profile
```

Home:
Smart Match / help me decide where to spend.

Scan:
User is already at the merchant and wants to pay.

Profile:
Preferences, Vouch Credits, My Vouches, NETS Activity and related user information.

---

# SMART MATCH — CURRENT OWNERSHIP

IMPORTANT:

Smart Match location/search/AI relevance is currently being handled separately by another teammate.

Do NOT redesign, replace, or refactor Smart Match unless the sprint prompt explicitly tells you to.

Preserve the current working Smart Match implementation.

Current high-level Smart Match architecture is approximately:

```text
browser GPS
→ Foursquare Places search
→ merchant-only filtering
→ factual preference/craving logic
→ deterministic constraints
→ AI ranking
→ existing recommendation UI
```

Current implementation may include:

- Foursquare-only merchant discovery
- browser geolocation
- per-session discovery location
- merchant-only filtering
- container/parent venue suppression
- parentVenueName contextual display
- craving-aware Foursquare searches
- factual MATCH / UNKNOWN / NON_MATCH relevance
- per-session shown/rejected merchant history
- no immediate repeats
- deterministic rejection rules
- OpenAI ranking
- rule-based fallback ranking

Do not weaken or remove these behaviours.

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

Consumer Activity should eventually show only genuine transactions from the current demo user's session.

Remove fake/static consumer transactions when working on the Activity cleanup sprint.

Expected information may include:

```text
merchant
amount
date/time
payment status
Vouch Credit earned/used
```

Requirements:

- current user only
- newest first
- valid transaction detail
- no meaningless +$0 / -$0 rows
- clean empty state

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

A future Reset Demo sprint must reliably reset demo runtime state.

Likely reset targets include:

- transactions
- Vouches
- claims
- referral state
- Smart Match recommendation state/history
- Vouch Credits
- live merchant metrics
- campaign runtime reward budget usage
- relevant session state

Retain static configuration.

Do not implement Reset Demo unless explicitly requested in the current sprint.

---

# DEPLOYMENT / PERSISTENCE

The prototype currently prioritises simplicity.

Some runtime data may exist in process memory/session memory.

Do NOT suddenly introduce MySQL, Redis, Firebase or another persistence system unless explicitly requested.

For an Open House prototype, temporary process-memory persistence may be acceptable if reset/restart behaviour remains safe.

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

Until explicitly told otherwise:

DO NOT modify:

- Smart Match search quality
- Smart Match AI prompt
- Smart Match craving matching
- Smart Match location logic
- Foursquare provider logic

Another teammate is currently handling that area.

Codex should focus on the sprint explicitly supplied by the user.

---

# REMAINING ROADMAP

Approximate remaining development order:

```text
1. API discovery caching / quota protection
2. NETS Activity cleanup
3. Reset Demo reliability
4. Merchant analytics consistency
5. Jia full end-to-end regression
6. Darren Shared-Vouch/referral regression
7. Negative and edge-case testing
8. Open House polish
9. Feature freeze
10. Pitch deck alignment
```

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