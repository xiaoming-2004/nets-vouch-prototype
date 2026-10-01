# NETS Vouch AI — Engineering Handover

_Last updated: 1 Oct 2026. Written from the code at `main` @ `33046c4` ("fix: make hourly chart horizontally scrollable") plus the uncommitted truthfulness/correctness repairs described in section 16. **If this document and the code disagree, the code wins** — then fix this document._

| | |
|---|---|
| Project | **NETS Vouch AI** (repo `nets-vouch-prototype`) |
| Team | **Capital 6** |
| Context | PolyFinTech Challenge 2026 — continued development as a functional coded prototype |
| Recognition | **Merit Award – Poly FinTech Hackathon 2026** |
| Test baseline | **383 / 383 passing** (`npm test`), syntax checks clean. Measured with every provider credential cleared and all providers mocked. (The `33046c4` snapshot itself was 296 / 326 — see section 16.) |
| Stack | Node.js ≥ 22, Express 5, EJS, express-session, vanilla JS/CSS, CommonJS, `@upstash/redis` (optional) |

Do not introduce a large framework or a new database unless explicitly requested.

## Contents

1. Product thesis & locked decisions
2. Consumer navigation
3. Smart Match — architecture (discovery, craving intent, meal classification, ranking)
4. Dietary — current state (discovery, research, Halal rule, waves, performance)
5. Request deadline (`request-budget.js`)
6. Research cache (`research-store.js`)
7. Smart Match result UI (card, badge, photo, map, Vouch count)
8. Payments, Vouch Credit, Payment-Verified Vouch, Shared Vouch, attribution, analytics
9. Activity, sessions/Upstash, Reset Demo
10. API keys & environment variables (setup, safe packaging, missing-key behaviour, degradation, security)
11. Developer setup & testing
12. Known limitations
13. Live test history (observed, not guaranteed)
14. Git / working state
15. Do NOT reintroduce · Paused areas · Working rules
16. Repairs applied after `33046c4` (reward truthfulness, report truthfulness, discovery cache, Redis reset)
17. Open House demonstration script

---

# 1. PRODUCT THESIS & LOCKED DECISIONS

> **NETS Vouch AI helps users decide where to spend, verifies the resulting NETS payment, and turns that verified outcome into a measurable merchant referral loop.**

Principle: **Rules decide what is possible. AI decides which valid option to recommend. The user decides whether to accept.**

### LOCKED (change only on explicit instruction)

- Preorder / order queue / preparing / ready / collection / kitchen fulfilment are **removed**. Legacy routes (`/order`, `/collection`, `/merchant/start-preparing`, `/merchant/mark-ready`, `/payment`) only redirect. Do not revive them.
- **Smart Match** is the main recommendation experience (Home).
- **Scan** is the merchant/payment flow.
- **Profile** holds account functions (credits, Vouches, activity, preferences, Reset Demo).
- A **Vouch proves a NETS payment happened** — NOT food quality or satisfaction.
- **Max one Vouch per eligible transaction.**
- **Direct Scan is not acquisition attribution.**
- Merchant analytics must keep **live** and **illustrative/sample** data separate.
- **No guaranteed ROI / profit claims.**

Locked consumer flow:

```text
Smart Match → choose merchant → physically visit → scan merchant QR → enter actual amount
→ simulated NETS payment → eligible merchant-specific Vouch Credit → optional Payment-Verified Vouch → share
```

---

# 2. CONSUMER NAVIGATION

Source: `views/partials/end.ejs`. The customer tab bar currently has **four** tabs (not three):

| Tab | Route | Responsibility |
|---|---|---|
| Home | `/home` | Onboarding preferences, Smart Match (location → match card / empty state), accept/reject |
| Scan | `/scan` | "Already at the merchant": QR scan (jsQR) or tap a merchant → `/scan/payment` |
| Activity | `/profile/activity` | NETS payment history (also linked from Profile) |
| Profile | `/profile` | Vouch Credits (`/profile/rewards`), My Vouches, NETS Activity, Preferences, Notifications, **Reset Demo** |

- Merchant view `/merchant` has its own tabs: **Campaign** (`&tab=campaign`) and **Results** (`&tab=results`). Never put customer tabs on it.
- `/demo` switches the demo persona (Jia / Darren) inside one browser session.

---

# 3. SMART MATCH — ARCHITECTURE

Files: `app.js` (discovery, eligibility, research, ranking, routes) · `request-budget.js` (deadline + safe trace) · `research-store.js` (dietary evidence cache) · `smart-match-result.js` (card photo, demo Vouch count, Maps URL).

## 3.1 Pipeline (`GET /smart-match/result`)

```text
Browser GPS (script.js, maximumAge 0) → POST /smart-match/location  (or ?lat=&lng= on the result URL)
  no/invalid location → demo location (Republic Polytechnic, 1.4428,103.7854) + "Using demo location" notice
↓
ONE request deadline created: 6 s (no restriction) / 15 s (Halal/Vegetarian/Vegan)
↓
Discovery: primary provider (Google Places New) → other provider (Foursquare) → curated demo merchants
  • raw craving searched first and always kept
  • active dietary restriction adds ONE dietary-targeted search (retrieval only)
  • merged + de-duplicated by provider place ID, then by name+<50 m
↓
Container suppression (food courts / malls / markets / container names)
↓
MEAL / NON_MEAL / UNCERTAIN classification (provider types only)
↓
Deterministic rules: shown/rejected history, walking limit (straight-line metres), known price > budget,
  known dietary NON_MATCH, merchant has a campaign, "Too far" ⇒ strictly closer
↓
Dietary restriction? → fresh cached evidence → else bounded research waves (Tavily → Groq → OpenAI)
  → only verified SUITABLE candidates continue
↓
Final ranking (≤ 12 candidates): Groq → OpenAI (one shared 2.5 s budget) → deterministic rules
↓
Server validation of the AI output → ONE recommendation, or an honest empty state
↓
Card extras within ≤ 500 ms: owner photo lookup + Halal badge from EXISTING evidence only
```

`POST /recommendation/reject` reuses the current merchant batch (no new Places call). A batch refresh (`refreshNearbyBatch`) happens at most once per cycle and **never** after `noCloserMatch` or any dietary outcome.

## 3.2 Google Places discovery (primary)

| Item | Current value / behaviour |
|---|---|
| API | Places API (New): `places:searchText`, `places:searchNearby` |
| Field mask | `places.id,displayName,primaryType,types,formattedAddress,location` (no ratings/photos/price → predictable billing) |
| Results per call | 20 (Google max) |
| Nearby | `includedTypes` restaurant / fast_food_restaurant / meal_takeaway; `excludedPrimaryTypes` food_court, shopping_mall, cafe, bakery, dessert_shop, pastry_shop (**`coffee_shop` is NOT excluded**); rank DISTANCE; radius = min(2000 m, walking limit × 80 m) |
| Text Search | rank RELEVANCE; `locationBias` circle 1000 m around the user |
| Location | Browser coordinates from the session / URL. Demo location only when no valid coordinates. No hardcoded production location. |
| Distance | Haversine straight-line metres, computed locally; `distanceMinutes = metres / 80` is used **only** for the walking-limit filter. UI shows metres (e.g. "603 m away"), never a walking time. |
| Discovery cache | In-process `Map`, **15 min** TTL, max 200 entries; key = ~110 m bucket (lat/lng to 3 dp) + mode + normalised query/radius. Distances are recalculated per visitor on hits. Not shared across instances. |
| Identity | Merchant id `google-<placeId>`; `providerPlaceId` = Google place ID |
| Participation | `source: 'GOOGLE'`, `participationMode: 'DEMO_SIMULATED'` — real places are **not** confirmed NETS Vouch partners |

**Call budget per discovery (Google):**

| Case | Calls |
|---|---|
| No craving, no restriction | 1 Nearby |
| Craving, no restriction | raw Text Search; if < 5 usable → 1 Groq intent + 1 expanded Text Search, **or** (no usable expansion) 1 Nearby. Max 2 Google + 1 Groq |
| Restriction, no craving | Text Search `"<diet> food"`; if < 5 usable → 1 Nearby merged in. Max 2 |
| Craving + restriction | raw Text Search + 1 `"<diet> <craving>"` Text Search (skipped if the craving already contains the diet word). No expansion. Max 2 |

"Usable" = MEAL within the walking limit, or UNCERTAIN that eligibility could still use. Zero usable → the next provider.

**Raw-first craving flow** (threshold `MIN_CRAVING_POOL_SIZE = 5`):

```text
raw craving → Google Text Search
  ≥ 5 usable → stop
  < 5 usable → Groq search-intent expansion → expanded Text Search → MERGED AFTER raw results (dedupe by place ID)
               (no Groq key / failure / unsafe output → one Nearby Search merged instead)
```

Raw results are never replaced by expansion results.

## 3.3 Foursquare (fallback)

- `GET https://places-api.foursquare.com/places/search`, headers `Authorization: Bearer <FOURSQUARE_API_KEY>`, `X-Places-Api-Version: 2025-06-17`. Uses `ll=<lat>,<lon>`, radius 2000 m, sort DISTANCE, limit 50. Do **not** use `api.foursquare.com/v3` or `near=`.
- Query: the raw craving (or `"<diet> food"`), plus at most ONE second query (the dietary query, or `"food"` without a restriction). Max 2 calls.
- `PLACES_PROVIDER=foursquare` swaps the order (Foursquare primary, Google fallback).
- Supplies `parentVenueName` from `related_places` (e.g. "Flying Wok · Yong Li Coffee Station"). Google has no parent-venue data, so it stays `null`.

## 3.4 Craving search intent (Groq expansion — fallback only)

- Used **only** when raw search yields < 5 usable merchants **and** there is no active dietary restriction.
- Provider: Groq `GROQ_SEARCH_INTENT_MODEL` → `GROQ_RANKING_MODEL` → default `openai/gpt-oss-20b`. Timeout `SEARCH_INTENT_TIMEOUT_MS` (1500 ms), also capped by the remaining budget.
- Validator (`validateSearchIntent`) rejects: non-JSON; > 80 chars or > 10 words; missing any raw craving word; added proper nouns, numbers or symbols; added location / dietary / quality words (halal, near, best, cheap…). Any rejection → the raw craving is used.
- Cache: in-process, 24 h, 500 entries, keyed by the normalised craving.
- No hardcoded food-synonym dictionary. The raw craving stays authoritative for discovery and ranking.
- History: live testing showed **expansion-first** search made results worse, so the design is **RAW SEARCH FIRST**.

## 3.5 Meal merchant classification

`classifyMealEligibility` is a three-way result, decided only from provider type/category metadata, never from merchant names:

| State | Meaning |
|---|---|
| `MEAL` | Known meal evidence |
| `NON_MEAL` | The place's own primary identity is outside proper-meal scope |
| `UNCERTAIN` | Food-related, but no strong evidence either way |

**Google rules, in order:**

1. `primaryType === 'coffee_shop'` **and** any strong meal-service type in its `types` (the `GOOGLE_MEAL_SERVICE_TYPES` list or the `*_restaurant` family) → **MEAL**.
2. Primary type in `GOOGLE_NON_MEAL_TYPES` → **NON_MEAL**. That list covers:
   - coffee: cafe, coffee_shop, coffee_stand, coffee_roastery, cat/dog_cafe
   - drinks: tea_house, juice_shop, acai_shop
   - bakery/pastry: bakery, bagel/pastry/donut shops
   - desserts: dessert_shop, dessert_restaurant, ice_cream_shop, confectionery, candy/chocolate
   - bars/snacks: snack_bar, bar, pub, wine_bar
   - retail: convenience/grocery/supermarket/liquor store, store
3. Primary type in `GOOGLE_MEAL_SERVICE_TYPES` or the `*_restaurant` family (excluding the non-meal ones) → **MEAL**. The meal-service list is restaurant, meal_takeaway, meal_delivery, bar_and_grill, cafeteria, deli, diner, sandwich_shop, salad_shop, noodle_shop.
4. Unfamiliar primary, `food_store`, or no primary: a strong secondary type (restaurant, meal_takeaway, meal_delivery, `*_restaurant`) → **MEAL**.
5. `food_store` → **NON_MEAL**. With no primary, any non-meal type → **NON_MEAL**.
6. Otherwise → **UNCERTAIN**.

**Foursquare rules:** the first category is the primary identity. A meal-category pattern gives MEAL; a non-meal pattern (café/coffee/tea/bakery/dessert/bar…) gives NON_MEAL. A meal category elsewhere promotes the place to MEAL; otherwise it is UNCERTAIN. Curated demo merchants are always MEAL.

**UNCERTAIN handling** (`filterByMealEligibility`):
- With a specific craving, UNCERTAIN is allowed only when the craving or dietary search itself returned the merchant.
- With no craving, it is allowed only when there are fewer than 5 MEAL merchants.
- NON_MEAL never qualifies.

Unknown types are not automatically discarded.

**Containers** are removed before classification when:
- the Google primary type is food_court / shopping_mall / market, or
- there is no primary type and those types appear in `types`, or
- the place's own name is a container name.

An address that mentions a mall or food court never makes a stall a container, so **stalls inside food courts remain valid**. Two stalls sharing an address are only merged when the name matches **and** they are < 50 m apart.

### `coffee_shop` — current rule and known limitation

- `coffee_shop` + strong meal-service secondary type → MEAL. Otherwise it stays NON_MEAL.
- Nearby Search no longer excludes `coffee_shop`, so these places can be retrieved.
- **Known limitation:** Google sometimes types Singapore kopitiam/stall businesses as `coffee_shop` with no useful meal-service secondary types. Genuine meal merchants can therefore still be excluded occasionally. This is accepted, not silently "fixed". Do **not** patch it with merchant names or hardcoded lists.

## 3.6 Final AI ranking

| Order | Provider | Model env (default) | Notes |
|---|---|---|---|
| 1 | Groq | `GROQ_RANKING_MODEL` (`openai/gpt-oss-20b`) | `reasoning_effort: low`, `max_tokens: 800` |
| 2 | OpenAI | `OPENAI_RANKING_MODEL` (`gpt-4o-mini`) | `max_tokens: 150`, only with the time left |
| 3 | Rules | `getFallbackRecommendation` | Same constrained candidate set |

- **Shared budget:** `SMART_MATCH_RANKING_MS` (2500 ms), capped by the request deadline. A provider is skipped when less than 300 ms of that budget is left. The next provider is tried on a missing key, HTTP error, 429, timeout or failed validation. There are no same-provider retries.
- **Candidates:** at most **12** per prompt (`AI_PROMPT_CANDIDATE_LIMIT`). The AI only ever sees the deterministically constrained subset.
- **Kept outside the AI:**
  - walking limit, "Too far", shown/rejected history
  - known over-budget and known dietary NON_MATCH
  - the campaign requirement and meal eligibility
  - dietary verification: the ranker is told `dietaryStatus` and never re-decides it
- **What the AI judges:** semantic fit from the craving, mood, categories, researched menu items and feedback. The prompt tells it that distance should not dominate a clearly better food match.
- **Validator** (`validateRankingResponse`, one validator for every provider):
  - The response must be JSON, and `merchantId` must be one of the candidates actually sent (invalid IDs are rejected).
  - `relevance` must be high, medium or low (`confidence` is accepted as an alias).
  - The reason must be non-empty, ≤ 160 characters, with no newlines or `<>`.
  - `budgetFit` must be within, over or unknown, and is forced to `unknown` when there is no real price.
- **Reason safety** (`safeAIReason`): the reason is dropped entirely when it contains any of:
  - dietary words for a merchant not verified as a MATCH ("halal", "vegan", "Muslim friendly", …)
  - "diet/dietary" without a verified restriction
  - price or "cheap" wording without a real or researched price
  - menu or "serves" wording without researched menu evidence
  - rating, "popular" or "famous" claims
  - **any walking time** for Places merchants, which only carry straight-line metres. Curated demo merchants may only quote their own minute figure.

  A `low` relevance pick always uses the fixed text "This is the closest available fit from the nearby options."
- **Observed:** the Groq ranker has picked a farther but semantically stronger merchant over the nearest generic one.

---

# 4. DIETARY — CURRENT STATE

Restrictions (`dietaryPreferenceOptions`): **No dietary restriction · Halal · Vegetarian · Vegan**.

## 4.1 Dietary-aware discovery (retrieval only)

- Diet only → `"<diet> food"` (e.g. `halal food`). Craving + diet → raw craving search **plus** `"<diet> <craving>"`.
- Results are flagged `fromDietarySearch` and are researched first.
- **A search result never proves suitability.** Google/Foursquare types, merchant names, cuisine and search terms do NOT prove Halal, Vegetarian or Vegan. Places merchants always start with `dietary: []`.

## 4.2 Research pipeline

```text
eligible candidate (after hard rules)
↓
fresh cached evidence? (memory → Upstash, one MGET)  ── a fresh verified SUITABLE → used immediately, no research
↓ (unchecked candidates: dietary-search results first, then nearest)
Tavily Search (per merchant, query "<name> <address/outlet> <diet term>", halal term = "halal MUIS", 5 results)
↓
Tavily Extract of the strongest 1–2 pages per merchant — only if ≥ 7 s remain (else strongest snippets, marked weak)
  (advanced-depth extract retry only if ≥ 12 s remain)
↓
Groq analysis (GROQ_RESEARCH_MODEL, default openai/gpt-oss-20b)
↓ on missing key / error / 429 / invalid output
OpenAI analysis (OPENAI_RESEARCH_MODEL, default gpt-4o-mini) over the SAME evidence
↓
ONE server validator (validateResearchAnalysis) → SUITABLE / UNSUITABLE / UNKNOWN (+ sources)
↓
cache verdict (research-store) → only SUITABLE passes the dietary hard rule
```

- **No Tavily evidence means no analysis.** Nothing is answered from model memory.
- **No usable analysis provider means no Tavily calls at all.**
- A Groq 429 blocks Groq for the rest of that request.
- Validator rules:
  - Sources are classified as certification / official / social / delivery / listing / community / other.
  - Vegetarian and vegan SUITABLE verdicts need at least one evidenced item. Vegetarian ≠ vegan.
- **Outlet identity** (`sourceIdentifiesOutlet`):
  - A cited source must contain the **full brand name**; a brand prefix is not enough.
  - For **Halal**, the source must also contain an outlet signal when the merchant has one: its postal code, the branch name after `@ - | (`, or its parent venue. Another branch's certificate therefore cannot verify this outlet.
  - Vegetarian and vegan may accept the chain's own menu for the brand.

## 4.3 Halal rule

**Halal requires explicit, outlet-level supporting evidence.** It is never inferred from:
- cuisine or merchant name
- Muslim-looking branding
- location
- Google/Foursquare categories
- "Muslim-friendly" or pork-free wording
- search retrieval
- AI memory
- another outlet's certificate

Official or current evidence (MUIS certification, the merchant's own pages) ranks highest among source types.

## 4.4 Research waves (exact current values)

| Setting | Value |
|---|---|
| Batch size | 3 merchants (`RESEARCH_BATCH_SIZE`) |
| Batches per wave | 2 (`RESEARCH_CONCURRENCY`) → **≤ 6 merchants per wave** |
| Max merchants researched per request | **12** (`RESEARCH_MAX_MERCHANTS`) |
| Order | `fromDietarySearch` first, then nearest |
| Stop conditions | first verified SUITABLE merchant · 12 merchants · < **5 s** left (`RESEARCH_MIN_WAVE_MS`) |
| Evidence | gathered in parallel across the wave; analysis runs batch by batch |
| Reserves | Tavily calls keep 2.5 s for analysis + 1.5 s for ranking |
| Per-call caps | Tavily search 15 s / extract 25 s / analysis 30 s — always further capped by the remaining budget |

**Outcomes (empty states, `views/smart-match-empty.ejs`):**

| Outcome | Meaning | UI |
|---|---|---|
| `researchUnavailable` | No provider could produce any verdict (missing keys, errors) | "We couldn't check <diet> options right now." |
| `verificationIncomplete` | Unchecked candidates remain (deadline or 12-merchant cap) | "Still checking <diet> options nearby." + "Check more places" (the next request continues with unchecked ones) |
| `noVerifiedDietary` | Everything checked, none verified | "No verified <diet> matches found nearby." |
| no candidates | Nothing inside the hard constraints | Generic empty state |

Unverified merchants are **never** shown to fill an empty result.

## 4.5 Current dietary performance (honest)

- **Cold Halal request: about 10 s observed.** Tavily search takes ~3–4 s, extract ~6–8 s, plus model latency.
- **Warm or cached request: can be under 1 s** (observed 0.95 s and 0.09 s).
- Mitigations in place: the request-wide deadline, research waves, parallel evidence gathering, shared evidence, and the persistent cache when Upstash is configured.
- **This is NOT solved.** Cold dietary research is still slow and remains an improvement area.

---

# 5. REQUEST DEADLINE (`request-budget.js`)

- `createBudget(totalMs)` builds `{deadline, AbortSignal, trace}`, which `runWithBudget` carries through all async work via `AsyncLocalStorage`.
- `callTimeout(cap, reserve)` sizes each provider call from the time left. It returns 0 when there isn't enough time, so the call is skipped and `markDeadlineHit` is recorded.
- `withBudgetSignal()` combines each call's own AbortController with the deadline signal, so outstanding work is **cancelled** at the deadline. `MIN_CALL_MS = 250`: no call starts with less than that.
- The trace records safe diagnostics only (counts, timings, notes). `logMatchDiagnostics` prints the one-line `SMART MATCH REQUEST …` summary.

| Env var | Default | Scope |
|---|---|---|
| `SMART_MATCH_DEADLINE_MS` | 6000 | whole request, no restriction |
| `SMART_MATCH_DIETARY_DEADLINE_MS` | 15000 | whole request, active restriction |
| `PLACES_REQUEST_TIMEOUT_MS` | 3000 | each Google/Foursquare call |
| `SMART_MATCH_RANKING_MS` | 2500 | shared Groq → OpenAI ranking budget |
| `SEARCH_INTENT_TIMEOUT_MS` | 1500 | Groq craving expansion (also keeps 3 s for the following Places call) |
| — (constant) | 500 | card extras (`RESULT_EXTRAS_WAIT_MS`) |
| — (constant) | 2500 / 5000 | photo Place Details / photo media (`smart-match-result.js`) |

Non-Smart-Match timeouts: `/health` Foursquare ping 4 s.

---

# 6. RESEARCH CACHE (`research-store.js`)

```text
L1 in-process Map (≤ 2000 entries)  →  L2 Upstash Redis (the SAME client as sessions) when configured
```

| Item | Value |
|---|---|
| Key | `research-v7:<provider>:<placeId>:<restriction>` (provider lowercased, e.g. `google`) |
| Value | validated verdict + sources + `verifiedAt` + `expiresAt` + `version` — **no user data** |
| TTL SUITABLE / UNSUITABLE | **7 days** (`RESEARCH_VERIFIED_TTL_MS`) |
| TTL UNKNOWN | **6 hours** (`RESEARCH_UNKNOWN_TTL_MS`) |
| Timeouts / HTTP / provider errors / deadline aborts | **never cached** |
| Shared read | ONE `MGET` for all misses, ≤ 800 ms, bounded by the remaining budget |

**Concurrency:**
- On the same server, `claim(key)` makes the first request the owner, and concurrent requests await its result.
- Across instances (Upstash only), a `SET NX` lock `lock:<key>` with a **25 s** lifetime is taken. Others poll the shared cache every 400 ms.
- If Redis fails (read, write or lock), the failure is logged once and the store runs **memory-only for 60 s**. Matching continues.

**Rules:**
- Loading the cache must **not** overwrite fresh session evidence. `hydrateMerchantResearch` keeps a merchant's own session copy when the store misses, as long as that copy is fresh.
- Expired entries and old-format entries (wrong `version`, no `expiresAt`) are ignored.

Other caches (all in-process only):

| Cache | TTL |
|---|---|
| Discovery | 15 min |
| Search intent | 24 h |
| Photo info | 24 h, or 1 h when there's no photo |
| Photo bytes | 40 entries |

---

# 7. SMART MATCH RESULT UI (current, `views/smart-match-card.ejs`)

What exists **now**:

- **Header row:**
  - owner photo (76 px), or a letter placeholder
  - merchant name ("Heading to X?" once accepted)
  - parent venue or category, plus distance in metres
- **Tag row, on one line:**
  - demo Vouch count
  - Halal badge
  - a separate verified diet chip for Vegetarian/Vegan
- **Photo credit** line (Google author attributions), when a photo is shown.
- **"Try: <item>"**, for curated demo merchants with an item.
- **"Using demo location"** notice, when applicable.
- **Map:**
  - Leaflet + OpenStreetMap tiles with a merchant pin and popup (keyless, loaded from unpkg)
  - an "Open in Google Maps" overlay link for walking directions
- **Reward line:**
  - "Earn $X <merchant> Vouch Credit"
  - "Today's Vouch Credit earned ✓"
  - "offer ended"
- **Buttons:** **Choose this** (→ `POST /recommendation/accept`); once accepted, **Scan when you arrive**.
- **Edit filters** sheet: craving, dietary, mood, budget, walking distance.
- **Not for me** feedback sheet with rejection reasons: Too far / Costs too much / Not in the mood / Ate this recently.

There is **no "Why this match" section** on the card; it was removed and tests assert its absence. `getMatchReasons` / `aiReason` are still computed but not rendered.

Loading copy is client-side only: "Finding nearby places…", then after 4 s "Checking which places fit your preferences…".

## 7.1 Halal badge

`resultHalalTag` reads **existing, fresh** evidence only:

| Evidence | Badge |
|---|---|
| Verified halal evidence | green **Halal** |
| Evidence that it is not halal | orange **Non-halal** |
| Anything else | grey **Halal not verified** |

- It is display only and never used by ranking.
- **No badge-only research is started.** The old per-card halal research endpoint was removed.
- Curated demo merchants use their own dietary records.
- The code comment on `resultHalalTag` still says "cached 24 h". That is stale wording; the real TTLs are the ones in §6.

## 7.2 Merchant photo (`smart-match-result.js`)

- **Lookup:** ONE Place Details request (`X-Goog-FieldMask: photos`) for the selected Google merchant only, within ≤ 500 ms of the request budget. It is cancelled at that limit, and failures are not cached.
- **Owner photos only:** a photo is used only when its Google author attribution matches the business name. Customer photos are never shown, and there is no AI photo selection.
- **Choice:** the first square-friendly photo that is ≥ 200 px, otherwise the first owner photo. With no owner photo, the letter placeholder is shown.
- **Serving:** image bytes go through `GET /smart-match/photo/:merchantId`, which only serves the visitor's **currently selected** merchant (anything else returns 404). Responses are ≤ 480 px and ≤ 2 MB, sent with `Cache-Control: private` and `nosniff`.
- **`GOOGLE_PLACES_API_KEY` never reaches the browser.**
- Attributions are cleaned (https links only, `<>` stripped, max 3) and rendered as "Photo: …".

## 7.3 Map / walking directions

- The map is **Leaflet + OSM**, so there is no Google Maps embed and no browser Maps key.
- `buildWalkingDirections` builds `https://www.google.com/maps/dir/?api=1&origin=<session coords>&destination=<lat,lng>&destination_place_id=<Google place ID>&travelmode=walking`.
  - The origin is omitted when the session location is unknown, and Google then routes from the device.
  - `destination_place_id` is only set for Google-sourced merchants, using Google's own ID (not the `google-` app ID).
  - No link is built without valid coordinates.
- Google computes the route and time. The app never presents straight-line metres as a walking time.

## 7.4 Vouch count

- `demoVouchCount(merchantId)` is **simulated sample social proof**: a deterministic FNV-1a hash of the merchant ID giving 20–300, identical across sessions. Real Payment-Verified Vouches made in this demo session are added on top.
- It is **not** a rating or quality score, and it is **never read by ranking**.

---

# 8. PAYMENTS, VOUCH & REFERRAL

## 8.1 Payment flow (Scan)

```text
/scan → pick or scan the merchant (POST /scan; attribution = smart-match only if this merchant was the accepted match)
↓
/scan/payment → enter the actual amount ($0.01–$1,000, ≤ 2 dp)
↓
optional: apply this merchant's Vouch Credit (capped so ≥ S$1.00 remains paid via NETS)
↓
POST /scan/payment → recordPayment (idempotent per journey ID via processedPaymentAttempts)
↓
simulated NETS success → receipt /payment-success/:id → reward released → Vouch prompt
```

## 8.2 Vouch Credit (merchant-specific)

- Stored per merchant (`demo.vouchCredits[merchantId]`), usable **only at that merchant**, and it accumulates. It is not platform-wide money.
- **A reward is money, never an item.** There is no item entitlement and no in-store item redemption
  anywhere in the code: `releaseMerchantReward` adds an amount to `demo.vouchCredits[merchantId]`
  and nothing else. Treat this as a locked constraint on anything customer-facing: a screen may
  never present an earned item.
- **Reward amounts and minimum spends are per merchant**, not one global default. `getRewardConfig`
  resolves them in this order:
  1. `MERCHANT_REWARD_CONFIGS` — an explicit entry for one of the five curated demo merchants.
  2. `discoveredRewardConfigs` — the offer assigned to a discovered merchant when it was first
     registered, so the same place keeps the same offer.
  3. `CATEGORY_REWARD_MAPS` — a category-matched offer, chosen by a stable hash of the merchant id.
  4. `GENERIC_REWARD_POOL` — the fallback, also by stable hash.

  The five curated demo merchants currently ship:

  | Merchant | Reward | Minimum spend |
  |---|---|---|
  | `felicia-chicken-rice` | $0.80 | $5.00 |
  | `green-bowl` | $1.00 | $9.00 |
  | `woodlands-noodle-bar` | $0.80 | $6.00 |
  | `northside-wraps` | $0.50 | $8.00 |
  | `spice-lane` | $0.70 | $7.50 |

- Settings that are still the same for every campaign (`createDemoCampaign`):

  | Setting | Default |
  |---|---|
  | Rewarded payments per day | 20 |
  | Reward budget per day | $10.00 |
  | Hours | 00:00–23:59, ACTIVE |
  | Sender referral reward | $0.20 |
  | Illustrative platform fee per attributed payment | $0.10 |

  Merchants can edit the reward, minimum spend, label, caps, hours and status at `/merchant`
  (Campaign tab).
- **Reward labels describe the credit, and the amount is never stored in the label.** A stored label
  is a purpose phrase such as `Vouch Credit towards a side dish`. Screens render it through
  `rewardCreditText(campaign.rewardAmount, campaign.rewardLabel)`, which prefixes the campaign's
  live amount — so editing the amount can never leave a stale figure in text. `validateRewardLabel`
  enforces this server-side on `POST /merchant/offer` and rejects a label that promises an item
  (`free`, `complimentary`, `on the house`, `gratis`, `redeemable for` …), carries its own amount,
  contains `<`/`>`, is empty, or exceeds 50 characters. A rejected submission saves **nothing** and
  redirects with `&error=label`; an empty label leaves the existing one in place.
  The journey test suites deliberately pin campaigns to a known amount/minimum so they assert
  literal dollar figures; the per-merchant catalogue itself is covered by `tests/merchant-rewards.test.js`.
- A reward requires **all** of:
  - NETS-paid ≥ $1.00
  - a campaign that is available (active, within hours, cap not reached, budget not reached)
  - purchase amount ≥ minimum spend
  - reward budget still available
  - no normal reward from this merchant yet today (Singapore date); a matching Shared-Vouch claim is exempt from this daily rule
- Payment below the minimum still succeeds, but earns no reward.

## 8.3 Payment-Verified Vouch

- Offered only for a successful, eligible Scan transaction (`canVouch`), and it is optional: "Not now" records `skipped`.
- Decision states: `pending` / `created` / `skipped` (or `not-eligible`). **One Vouch per transaction.**
- Label: "Payment-Verified (Simulated)", with an optional tag. It proves payment only.
- Sharing uses **WhatsApp, Telegram and Copy Link** (`views/vouch-success.ejs`). Each share reuses the same Vouch and share token, so shares never create duplicates.

## 8.4 Shared Vouch / referral

```text
Jia pays (eligible) → creates Vouch → shares /offers/<token>
↓
Darren opens → POST /offers/<token>/claim  (claim alone gives NO reward; counts sharedVouchClaims)
↓
Darren pays with NETS at the SAME merchant within 20 min
↓
Darren gets the receiver reward (the campaign reward, via the same eligibility checks)
↓
Jia's sender bonus ($0.20) — only if budget remains after the receiver reward;
credited to Jia's credits for that merchant on Jia's next request (applyPendingReferralCredits middleware)
```

| Rule | Current value |
|---|---|
| Sender ≠ receiver | Checked by persona identity, not browser session |
| Same merchant | Required |
| Claim expiry | **20 min** (`CLAIM_EXPIRY_MS`) |
| Sender/receiver/merchant cooldown | **30 days** (`REFERRAL_COOLDOWN_MS`) |
| Rewards per transaction | Max one customer reward, plus at most one sender bonus |
| Budget | Both rewards count against the merchant's daily reward budget |
| Stacking | Receiver reward and normal daily reward do not stack |
| Wrong merchant | No referral reward |

## 8.5 Attribution

| Channel | Meaning |
|---|---|
| `SMART_MATCH` | The user accepted this merchant in Smart Match, then paid there |
| `SHARED_VOUCH` | A valid matching claim existed at payment (takes precedence) |
| `DIRECT_SCAN` | Everything else. **Not acquisition**, never counted as a Smart Match conversion, earns no platform fee |

## 8.6 Merchant analytics (`/merchant`, Results tab)

- **Live metrics** per campaign:
  - scans, payments, reward cost
  - Smart Match shown / accepted / paid / sales / conversion (paid ÷ shown)
  - Shared Vouch claims / paid / sales / conversion (paid ÷ claims)
  - Direct Scan payments / sales
  - campaign status: reward budget, spent, remaining, rewarded payments used and remaining, platform fee accrued
- **Illustrative baseline** (`campaignSeedMetrics`, plus the `merchantPaymentFeed` entries with `illustrative: true`) is displayed **separately** and labelled as sample data. Only live payments appear in "recent payments".
- `getMaxDailyCostEstimate` is a worst-case illustrative figure.
- Reward spend is not NETS revenue, and payouts are not double-counted as transactions. **No guaranteed ROI, profit or incremental-profit claims.**

---

# 9. ACTIVITY, SESSIONS, RESET

## 9.1 NETS Activity (repaired)

- `getActivityTransactions` returns only this session's transactions owned by the current persona (`ownerUserId`).
- It includes only successful NETS transactions with `netsPaid > 0`, sorted newest first.
- The NETS-paid amount is the primary figure, and reward/credit rows appear only when positive (no +$0 / −$0).
- The detail route `/transactions/:id` is **owner-safe**: another user's ID returns 404.
- **No fake seeded transactions.** The old module-level `txCache` / `userTxIndex` was removed because it could leak or stale transaction ownership across sessions.
- `seedPromotionalRedemptions` is still defined in `app.js` but unused. Do not wire it in.

## 9.2 Sessions / Upstash

| Item | Behaviour |
|---|---|
| Middleware | `express-session`, `resave: false`, `saveUninitialized: false` |
| Secret | `SESSION_SECRET`, falling back to a built-in demo string. **Set it in any deployment.** |
| With Upstash (`UPSTASH_REDIS_REST_URL` + `_TOKEN`) | custom `UpstashStore`, keys `sess:<sid>`, TTL = cookie maxAge or 24 h. A leading BOM in the env values is stripped. |
| Without Upstash | `MemoryStore`: fine locally; on Vercel, state is lost and not shared between instances |
| Session-scoped state | Profile, location, recommendation and history, transactions, credits, Vouches, claims (`createInitialDemo`, version 18) |
| Module-level state (shared, not per user) | merchant campaigns, the discovered-merchant registry, shared offers, referral cooldowns, the merchant payment feed, `locationCache` (sessionId → coords, a cold-start fallback), and the caches |

## 9.3 Reset Demo (`POST /reset-demo`)

UI: a small outlined button at the bottom of Profile and on `/demo` (`views/partials/reset-demo.ejs`), behind a confirmation sheet.

| Resets | Preserves |
|---|---|
| Every visitor session's demo state (transactions, credits, Vouches, claims, idempotency tokens, preferences, match history) via `demoResetGeneration` and `demoStore.all` | Merchant-edited campaign configuration (reward, minimum spend, caps, hours, status) |
| Shared offers, referral cooldowns | Illustrative analytics baseline and illustrative payment-feed entries |
| Live payment feed (restored to the illustrative seed) | Discovery, search-intent, research and photo caches; discovered-merchant registry; `locationCache` |
| Campaign daily counters, budget spent, platform fee, live metrics | Static configuration |

It redirects to `/home?reset=done`.

**Repaired (was broken at `33046c4`).** `UpstashStore` implements only `get`/`set`/`destroy`, and
`express-session`'s base `Store` has no `all`, so the old route threw a `TypeError` at
`demoStore.all` and Reset Demo returned 500 whenever Upstash was configured. Enumeration is now an
optimisation rather than the mechanism:

- `resetOtherStoredSessions` enumerates and clears other sessions **only when the configured store
  implements `all()`** (MemoryStore does; Upstash deliberately does not, because the Upstash REST
  API has no cheap key scan).
- What actually makes the reset global is the **reset generation**. `demoResetGeneration` is bumped
  on every reset, and `initialiseDemoSession` runs on every request and replaces the demo state of
  any session whose stored generation is behind it. So on either store, every other session is reset
  the moment it is next used.
- That same guard defeats a **stale in-flight save**: a request that started before the reset writes
  back the superseded generation, so its data is replaced on the next read instead of coming back.
- The requesting session is now saved **explicitly** (`req.session.save`) before the redirect. The
  session middleware's own save completes *after* the response, so a failed write previously still
  showed `reset=done`. A store failure now returns 500 `Demo reset could not be completed`.
- Covered by `tests/reset-demo-redis.test.js`, which loads the app against a fake
  Upstash-compatible client (no real Redis, no `.env` credentials) and checks two sessions, reset
  around a pending save, idempotent repeats, and an honestly-reported write failure.

⚠ **Limitation, not papered over:** `demoResetGeneration` lives in the server process. On a single
instance (local, or one Vercel lambda) a reset clears everything. With Upstash configured across
**several** instances, a reset does not reach sessions being served by another instance. Making that
work would mean storing the generation in Redis and reading it per request, which is a deliberate
design change and is not done.

---

# 10. API KEYS & ENVIRONMENT VARIABLES

`app.js` loads `.env` automatically when present (`process.loadEnvFile`, Node ≥ 22). Deployments (Vercel) set variables in the platform.

## 10.1 Complete variable table (from every `process.env` use)

| Variable | Required? | Used for | Safe if missing? | Configure in |
|---|---|---|---|---|
| `GOOGLE_PLACES_API_KEY` | For live discovery | Places Text/Nearby search, result photo (server-side only) | Yes — Foursquare, then demo merchants; no photos | `.env` / Vercel |
| `FOURSQUARE_API_KEY` | Optional | Fallback discovery; `/health` ping | Yes | `.env` / Vercel |
| `PLACES_PROVIDER` | Optional | `google` (default) or `foursquare` primary | Yes (google) | `.env` / Vercel |
| `GROQ_API_KEY` | Recommended | Final ranking, craving expansion, dietary analysis | Yes — see §10.3 | `.env` / Vercel |
| `GROQ_RANKING_MODEL` | Optional | Ranking model (also the intent fallback) | default `openai/gpt-oss-20b` | `.env` / Vercel |
| `GROQ_SEARCH_INTENT_MODEL` | Optional | Craving-expansion model | → `GROQ_RANKING_MODEL` → default | `.env` / Vercel |
| `GROQ_RESEARCH_MODEL` | Optional | Dietary analysis model | default `openai/gpt-oss-20b` | `.env` / Vercel |
| `OPENAI_API_KEY` | Optional | Ranking + dietary-analysis fallback | Yes | `.env` / Vercel |
| `OPENAI_RANKING_MODEL` | Optional | Ranking model | default `gpt-4o-mini` | `.env` / Vercel |
| `OPENAI_RESEARCH_MODEL` | Optional | Dietary analysis model | default `gpt-4o-mini` | `.env` / Vercel |
| `TAVILY_API_KEY` | For dietary research | Tavily search/extract | Yes — see §10.3 | `.env` / Vercel |
| `UPSTASH_REDIS_REST_URL` | For deployment | Sessions + shared research cache | Yes — memory fallback | Vercel (optional locally) |
| `UPSTASH_REDIS_REST_TOKEN` | For deployment | Same as above | Yes | Vercel (optional locally) |
| `SESSION_SECRET` | **Yes in deployment** | Session cookie signing | Falls back to a public demo string (unsafe) | Vercel / `.env` |
| `PORT` | Optional | Local listen port | default `3000` | shell / `.env` |
| `NODE_ENV` | Optional | `production` silences `logDiscovery` and debug logs | Yes | Vercel sets it |
| `SMART_MATCH_DEADLINE_MS` | Optional | Request deadline without a restriction | 6000 | `.env` / Vercel |
| `SMART_MATCH_DIETARY_DEADLINE_MS` | Optional | Request deadline with a restriction | 15000 | `.env` / Vercel |
| `PLACES_REQUEST_TIMEOUT_MS` | Optional | Per Places call | 3000 | `.env` / Vercel |
| `SMART_MATCH_RANKING_MS` | Optional | Ranking budget | 2500 | `.env` / Vercel |
| `SEARCH_INTENT_TIMEOUT_MS` | Optional | Craving expansion | 1500 | `.env` / Vercel |
| `RESEARCH_CONCURRENCY` | Optional | Batches per research wave | 2 | `.env` / Vercel |
| `RESEARCH_MAX_MERCHANTS` | Optional | Merchants researched per request | 12 | `.env` / Vercel |
| `RESEARCH_VERIFIED_TTL_MS` | Optional | TTL for SUITABLE/UNSUITABLE | 7 days | `.env` / Vercel |
| `RESEARCH_UNKNOWN_TTL_MS` | Optional | TTL for UNKNOWN | 6 h | `.env` / Vercel |

- No Maps embed or browser-side key is used. The map is Leaflet/OSM and the Maps link is a keyless URL.
- `GEMINI_API_KEY` / `GEOAPIFY_API_KEY` may exist in someone's local `.env`, but the code never reads them.
- `.env.example` now documents **every** variable in this table, with safe placeholders and a note
  on what happens when each is missing. It contains names and placeholders only — never values — and
  is the one `.env*` file that may be committed or shipped (`.gitignore` ignores `.env` and
  `.env.*`, with `!.env.example` re-included).

## 10.1b Packaging a handover archive safely

`.gitignore` protects Git, not `zip`. Build an archive from what Git tracks, so an ignored `.env`
can never be included:

```bash
# From the repo root. Writes ../nets-vouch-prototype-handover.zip containing tracked files only.
git archive --format=zip --output=../nets-vouch-prototype-handover.zip HEAD
```

If you must zip the working directory instead, exclude secrets and build output explicitly:

```bash
zip -r ../nets-vouch-prototype-handover.zip . \
  -x '.env' -x '.env.*' -x 'node_modules/*' -x '.git/*' -x '*.zip'
```

Then verify, without printing any value:

```bash
unzip -l ../nets-vouch-prototype-handover.zip | grep -E '(^|/)\.env($|[^.])' || echo 'no .env in archive'
```

If an existing archive does contain `.env`, delete the archive and rebuild it with one of the
commands above. Do not open it to inspect the contents.

## 10.2 Teammate API key setup — READ THIS

- API keys are **never stored in Git**. `.env` is local and **gitignored** (re-verified 1 Oct 2026:
  `git ls-files .env` finds nothing, `git check-ignore .env` matches, and `.gitignore` also ignores
  `.env.*` and `*.zip`/`*.tar*` so a stale archive cannot be committed with secrets inside).
- `.env.example` contains variable **names and placeholders only**.
- **Cloning the repo does NOT give you anyone's keys.** For full live functionality, use one of:
  - **A.** your **own** provider keys, or
  - **B.** shared team development credentials, received through a **secure private channel** and put in **your local `.env`**, or
  - **C.** the **deployed environment**, where keys are configured server-side in Vercel.
- **Never** paste keys into GitHub (code, issues, PRs), `handover.md`, source code, test fixtures, or Discord/chat messages or screenshots.

## 10.3 Missing-key behaviour (verified in code)

| Missing | Behaviour |
|---|---|
| **Google** | `discoverWithGoogle` returns null. Foursquare is used if configured; otherwise the curated demo merchants load, with the "Using demo location" notice. No merchant photos. |
| **Foursquare** | Google stays primary; there is simply no fallback provider. `/health` reports `foursquareKey: missing`. |
| **Groq** | Craving expansion is skipped and the raw craving is used (the one Nearby fallback runs when the raw search is thin). Ranking goes to OpenAI, else rules. Dietary analysis goes to OpenAI. |
| **OpenAI** | Groq stays primary. When Groq fails or is rate-limited, ranking falls back to rules and dietary analysis has no fallback. |
| **Groq + OpenAI** | Rules ranking. Dietary research makes **no Tavily calls**, so the result is `researchUnavailable` unless fresh cached verified evidence exists. |
| **Tavily** | No live dietary research. Fresh cached evidence (memory or Upstash) still works; otherwise "We couldn't check <diet> options right now." Never AI memory. |
| **Upstash** | Sessions use `MemoryStore`, and the research cache is memory-only (per instance, lost on restart). Fine locally; on Vercel, sessions are not shared across instances. |
| **SESSION_SECRET** | Works with the built-in demo secret. **Unsafe for deployment.** |

## 10.4 Provider degradation

| Keys configured | What works |
|---|---|
| None | Curated demo merchants (Woodlands), rules ranking, full payment/Vouch/referral demo, dietary via curated demo records only |
| Google only | Live discovery + rules ranking. Dietary restrictions give "couldn't check" (unless cached). Owner photos. |
| Google + Groq | Live discovery, AI ranking, craving expansion. Dietary still unavailable (no Tavily). |
| Google + Groq + Tavily | Full live discovery + evidence-based dietary research. The cache is per-instance memory. |
| + OpenAI | Fallback for ranking and dietary analysis when Groq fails or is rate-limited |
| + Upstash | Persistent shared sessions and a shared 7-day/6-hour dietary evidence cache across instances |

## 10.5 API key security

- Never commit `.env`, API keys, `SESSION_SECRET` values or Redis credentials. Never log keys (the code only logs "configured: yes/no").
- **Exposure scan (25 Sep 2026):** tracked files and the full Git history were searched for Google/Groq/OpenAI/Tavily/Foursquare key patterns and Upstash credentials. **No real keys were found.** The only Upstash URL in history is the `your-db` placeholder.
- If a key is ever committed: rotate it at the provider immediately. Removing it from Git is not enough.
- **Google key restrictions (intended):**
  - The server-side Places key is restricted to **Places API (New)** only. It is used from the server only, never sent to browser JavaScript.
  - If a browser-visible Maps key is ever added (e.g. a Maps Embed): make it a **separate** key, restricted to that API and to the deployed domain(s) by HTTP referrer.
  - **Never reuse the server Places key client-side.**
- Only these values reach the browser: coordinates, the keyless Google Maps directions URL, and photos proxied through `/smart-match/photo/:id`.

---

# 11. DEVELOPER SETUP & TESTING

```text
1. git clone https://github.com/xiaoming-2004/nets-vouch-prototype.git && cd nets-vouch-prototype
2. Node.js ≥ 22 required (process.loadEnvFile, AbortSignal.any)
3. npm install
4. cp .env.example .env     # then add the keys you have (see §10); never commit .env
5. npm test                 # node --check public/js/script.js + node --test tests/*.test.js → expect 383/383
6. npm start                # node app.js
7. open http://localhost:3000   (→ /welcome; PORT overrides)
```

Syntax checks: `node --check app.js request-budget.js research-store.js smart-match-result.js public/js/script.js`.

Deployment: Vercel (`vercel.json` routes everything to `server.js`, which exports the app). `/health` reports Foursquare, OpenAI and Tavily status only; it doesn't cover Google or Groq, and `vercel.json` defines no cron despite the code comment.

## Test suite (`tests/`, node:test, all providers mocked)

| File | Covers |
|---|---|
| `smart-match.test.js` | Core matching, rejection rules, Too far, history, research integration, reliability/429, retrieval, empty states |
| `dietary-matching.test.js` | Dietary-intent discovery, `coffee_shop` handling, shared/fake Upstash store, TTLs, concurrent dedupe, no provider → 0 Tavily, deadline → incomplete, warm cache, outlet identity (wrong outlet / brand prefix) |
| `google-discovery.test.js` | Google Text/Nearby, provider order, Foursquare fallback, containers, dedupe |
| `discovery-cache.test.js` | Discovery cache keys/TTL/per-visitor distances, and that a wider walking radius can never be answered from a narrower cached search |
| `meal-eligibility.test.js` | MEAL/NON_MEAL/UNCERTAIN, Nearby exclusions |
| `craving-intent.test.js` | Raw-first flow, Groq expansion validation, intent cache |
| `ranking-providers.test.js` | Groq → OpenAI → rules, validator, unsupported claims, walking-time protection, ranking budget |
| `smart-match-result.test.js` | Card rendering, photo proxy/owner-only, Maps URL, demo Vouch count, halal badge (no badge research) |
| `activity.test.js` | Activity filtering, owner isolation, no seeded rows |
| `journeys.test.js`, `jia-e2e.test.js`, `darren-e2e.test.js` | Payment, credit, Vouch and Shared-Vouch/referral end-to-end |
| `edge-cases.test.js` | Negative and abuse cases |
| `merchant-analytics.test.js` | Attribution, live vs illustrative metrics |
| `reset-demo.test.js` | Reset Demo (MemoryStore) |
| `reset-demo-redis.test.js` | Reset Demo against the **configured Upstash store** via a fake Upstash client: two sessions, reset around a pending save, idempotent repeats, honest failure reporting |
| `merchant-rewards.test.js` | Reward truthfulness: no shipped label promises an item, the rendered amount always comes from the live campaign value, server-side custom-label validation, per-merchant minimum-spend boundaries, the $1 NETS floor |
| `merchant-report.test.js` | Report truthfulness: no fabricated live transactions, illustrative rows excluded from live feeds, live vs illustrative totals kept separate, honest date ranges, rule-based observation naming, escaped merchant-controlled text |
| `acceptance-journeys.test.js` | End-to-end acceptance of the five demo journeys (no restriction, active Halal across verified/unverified/unavailable/timed-out/cached states, Direct Scan attribution, Shared Vouch claim and redemption, Reset Demo), plus long-label and reward-control accessibility checks |
| `template-js.test.js` | Every EJS template compiles; every inline `<script>` block and public JS file is valid JavaScript; no template ships an activity-inventing timer |

Only mocks and unit tests run in CI. The tests do not cover live providers, and the Upstash path is
covered with a fake client rather than a real Redis service.

---

# 12. KNOWN LIMITATIONS

### Dietary
- **Cold dietary requests are slow: about 10 s observed** for a cold Halal search. Warm or cached requests can be under 1 s.
- Cold latency depends on Tavily (search ~3–4 s, extract ~6–8 s) and model latency.
- Groq free-tier rate limits (429) cause OpenAI or rules fallback and lower quality. A 429 found on the first analysis can waste one wave of Tavily searches.
- Roughly one research wave fits in a cold request. Remaining candidates need "Check more places".
- A cached verified merchant short-circuits research, even when an unchecked place might fit the craving better.
- Hawker stalls often have no web evidence, so "no verified match" is common. Dietary match quality is **still being refined**.
- **The shared-cache path has not been live-tested against a real Upstash instance.** It is only tested with a fake store.

### Search / retrieval
- Provider data can omit merchants, especially small stalls. Google returns at most 20 results per call and at most 2 calls are made.
- Ambiguous Google types (e.g. `coffee_shop` without meal types) can still misclassify Singapore stalls.
- **Do not add hardcoded merchant data or name lists to compensate.**

### Budget
- Exact merchant or menu prices are usually unavailable (`price: null`). Unknown budget fit must stay **unknown**.

### Platform
- Everything depends on third-party availability and rate limits (Google, Foursquare, Groq, OpenAI, Tavily, Upstash).
- Many state stores are process-memory:
  - shared offers, referral cooldowns, campaigns, the payment feed
  - every cache except research-store L2
- That state is lost on restart and not shared across Vercel instances.
- Reset Demo with Upstash: **needs verification** (§9.3).
- Map tiles and scripts load from unpkg, OpenStreetMap and jsDelivr, so the map needs internet access.

### Rewards
- **No item redemption exists.** A reward is a cash Vouch Credit balance only; nothing can issue,
  track or redeem a physical item. Reward labels may therefore only describe what the credit is
  towards (§8.2).

### Merchant report
- The hourly chart, the seven-sample-day series, the busy-period heatmap and the baseline totals are
  **fixed sample data**, labelled as illustrative. The prototype keeps no per-hour, per-weekday or
  dated history, so no chart below the live section carries a date range.
- Live report figures cover "since the last Reset Demo", not a calendar day. Campaign metrics are
  not bucketed per day; only `redemptionsToday` and `rewardBudgetSpentToday` roll over.
- The observations section is rule-based demo heuristics. It asserts no sales lift, return-visit or
  perceived-value figures, because the prototype collects no outcome data.

### State and reset
- Campaigns, shared Vouch links, referral cooldowns and the payment feed are **process memory**.
  They are not durable and not shared across instances; a restart returns them to their defaults.
- Reset Demo is coordinated in-process and so is single-instance only (§9.3).

### Verification
- **No browser-automation testing.** The suite drives the app over HTTP and asserts on rendered
  markup. Layout at a narrow viewport has not been confirmed in a real browser.

---

# 13. LIVE TEST HISTORY (observed development tests — not guaranteed behaviour)

- **Google vs Foursquare** (RP and Bugis): Google found stall-level merchants that Foursquare missed, which led to making Google primary.
- The `noodle_shop` type exposed brittle allow-list filtering, which led to the MEAL / NON_MEAL / UNCERTAIN design.
- A raw `bee hoon` search found Hup Lee Economic Bee Hoon at 603 m. An expansion-first query made retrieval worse, which led to **raw-first**.
- The Groq final ranker chose a semantically better food match over the nearest generic merchant.
- **25 Sep 2026 Halal tests** (RP location; Google + Tavily + Groq; memory cache only, no Upstash or OpenAI):

  | Request | Time | Result | Calls |
  |---|---|---|---|
  | Halal, no craving (cold) | 10.0 s | Red Ginger — verified halal | 1 Google text, 6 Tavily search, 2 Tavily extract, 3 Groq |
  | Halal + "chicken rice" | 0.95 s | Red Ginger (cached evidence reused) | 2 Google text, 1 Groq (rules fallback) |
  | Repeat, new session | 0.09 s | Red Ginger | 1 Groq (rate-limited → rules) |

- Before the analysis-time reserve existed, a cold run spent its budget on page extraction and returned "Still checking" after 13.5 s.

---

# 14. GIT / CURRENT WORKING STATE

- Branch `main`. HEAD `33046c4` "fix: make hourly chart horizontally scrollable".
- The working tree was clean at `33046c4`. The repairs in §16 are **uncommitted** working-tree
  changes: `app.js`, `public/css/style.css`, five views, eight existing test files, five new test
  files, `package-lock.json`, `.env.example`, `.gitignore`, `README.md`, `PROTOTYPE_PLAN.md` and this
  document. Nothing has been committed, pushed or deployed.
- Recent history: `33046c4` hourly chart scroll · `bcb30c6` hourly chart overflow and decimal split ·
  `ff0c07d` merchant-report view · `ab8e3f4` halal/non-halal filtering, merchant report, Smart Match
  result improvements (this is the commit that introduced the per-merchant reward catalogue) ·
  `9e1f039` APIs and location · `f96ba38` halal, non-halal.

---

# 15. RULES FOR FUTURE WORK

## Do NOT reintroduce
- fake seeded Activity transactions; a global or module-level transaction cache (`txCache` / `userTxIndex`)
- merchant-specific ranking bonuses, fake busyness, hardcoded merchant recommendations or name lists
- a hardcoded food-synonym dictionary; expansion-first search
- trusting Google/Foursquare types, names, cuisine or search terms as dietary proof; unverified merchants shown for a dietary restriction
- café, bakery, dessert or drink places as meal recommendations
- AI-estimated walking times, or straight-line metres shown as walking time
- badge-only dietary research on the result card
- backend API keys exposed client-side (including reusing the Places key in the browser)
- Vouch count used in ranking, or shown as a rating
- guaranteed ROI or profit claims; Direct Scan counted as acquisition
- preorder, order queue or fulfilment logic

## Paused / delegated
- **Dietary preference matching and preference-quality tuning are still being refined and may be picked up by teammates.** Don't redesign this area unless explicitly asked.
- The priority is keeping the documented architecture stable while teammates test.

## Working rules
- **Frozen unless explicitly requested:**
  - payments, Vouch Credit, Payment-Verified Vouch, Shared Vouch/referral rules
  - attribution and analytics calculations
  - Reset Demo behaviour, NETS Activity
  - the UI shell/design system (small fixes only)
- **Teammate preservation:** inspect first, make the smallest safe change, preserve unrelated features, add focused tests, and run the full suite. Never replace a teammate's feature with a simpler one.
- **Code style:** follow the existing architecture and helpers, keep deterministic business rules, handle secrets server-side, keep dependencies minimal, and avoid broad rewrites.
- **Testing standard:** run `node --check` on the changed JS and `npm test`. Never weaken assertions to go green; replace obsolete tests with equivalent coverage.
- **Honesty:** never claim live browser, geolocation, real-API or multi-device testing unless it happened. Distinguish mocked tests from live calls.
- **UI shell:** the iPhone 16 Pro Max frame (`views/partials/start.ejs` / `end.ejs`) is hidden at ≤ 560 px width. Keep the logo `public/images/nets-vouch-ai-logo.jpg` unchanged, and reuse the design tokens at the top of `public/css/style.css`. Many tests assert visible strings, so change wording only together with its tests.
- **Sprint report:** list the files changed, root cause, implementation, new tests, full-suite result, any impact on teammate features, and live-testing limits. Then STOP; don't start the next item automatically.

---

# 16. REPAIRS APPLIED AFTER `33046c4`

The `33046c4` snapshot was **296 / 326 passing**. All 30 failures traced to one deliberate v17
change: `ab8e3f4` replaced the uniform `$0.50` reward / `$5.00` minimum with the per-merchant
catalogue in §8.2, and the journey suites still encoded the old uniform values. The product change
was kept; the test fixtures were brought up to date by pinning each campaign the test pays at, so
every invariant those tests protected is still asserted on literal figures.

The repairs below were applied on top of that snapshot. Final state: **383 / 383 passing**.

### 16.1 Reward truthfulness
- 72 reward labels promised items ("Free side dish", "Free upsize") while the backend only ever
  credited money. Every label is now a credit-purpose phrase, and the live amount is rendered beside
  it by `rewardCreditText`. See §8.2 for the full rule and the validator.
- `POST /merchant/offer` now validates the label **before writing any field**, so a rejected
  submission saves nothing instead of silently keeping the old label and applying the rest.
- The `vouch-success` page no longer falls back to a hardcoded `$0.50` when a campaign has ended; it
  says the offer has ended.

### 16.2 Merchant report truthfulness (§8.6)
- **Removed the fabricated live feed.** Both the Results tab and the Business Report shipped a
  browser timer (`setInterval`) that injected randomly chosen sample transactions into a feed headed
  "Live transactions", built with `innerHTML` from merchant-controlled strings. The timer, the
  sample pool (`getMerchantLiveFeedPool`) and the unsafe markup construction are gone.
- The report's live feed previously did **not** filter `illustrative: true`, so shipped sample rows
  dated 2026-09-18/19 rendered as live payments. It now shows only recorded payments.
- "Today at a Glance" added a sample weekly average to live counters and multiplied it by a blended
  basket size to produce "Revenue today". Replaced by **Live demo activity · since last Reset Demo**,
  computed from recorded payments only, with an honest empty state and no basket average until there
  is at least one payment.
- Channel mix is now reported **twice** — live and illustrative — so neither borrows the other's
  volume.
- Date-range claims that the data could not support ("last 7 days", "last 4 weeks", "today") are
  gone. The hourly, seven-day and heatmap charts are each labelled as illustrative sample data with
  their own caption, and the weekly series is labelled Day 1–7 because the prototype keeps no dated
  history. The Results tab's sample series no longer carries invented calendar dates.
- **"AI Insights" renamed to "Demo observations · rule-based"**, because it is a set of fixed
  `if`/`else` statements. Unsupported claims were removed: the 15–25 % slow-period lift, the
  30–40 % next-visit rate, the "2–3× perceived value" claim and the "a free item reward could
  outperform credits" recommendation (which also contradicted the credit-only model). Each
  observation now states the basis it was read off instead of a confidence level.

### 16.3 Discovery cache radius (§3.3)
- The Foursquare cache key was location bucket + query and **ignored the search radius**, so a short
  walking-limit result set could answer a later, wider request — missing every merchant between the
  two radii, which the provider had never returned.
- The radius is now quantised once, upwards to the next 250 m, and the same value is used for both
  the provider request and the cache key. A hit therefore always means "same place, same query, same
  radius actually searched". Quantising upwards keeps near-equivalent walking limits sharing one
  entry rather than fragmenting the cache per metre, and never shrinks a search; any extra far
  merchant is removed per visitor by `merchantMatchesProfile`'s exact distance check.
- Google was already correct: its `nearby` key includes the radius, and `text` mode uses a fixed
  location bias that does not vary with the walking limit. TTL, cache limits, per-visitor distance
  recalculation, provider order, dietary-targeted discovery and craving search are unchanged.

### 16.4 Reset Demo on the configured store (§9.3)
See §9.3 for the full description, including the explicit session save and the single-instance
limitation.

### 16.5 Accessibility and layout
- The reward-type radios are now a real `fieldset`/`legend` with `role="radiogroup"`,
  `aria-labelledby` and `aria-describedby`; the custom-label text field has a real (visually hidden)
  label instead of only a placeholder.
- `.visually-hidden` was scoped to `.match-card` and is now global, so those labels actually hide.

### 16.6 Setup
- `package-lock.json` declared two dependencies `package.json` never did — `nodejs@0.0.0` and
  `yarn@1.22.22`, neither installed in `node_modules`. Removed by regenerating the lockfile offline
  from `package.json`; no real dependency was added, upgraded or changed.
  Verified with `npm ls --depth=0` and `npm ci --dry-run --offline`.
- `.env.example` rewritten to cover every variable in §10.1 with safe placeholders.
- `.gitignore` extended to ignore `.env.*` (re-including `.env.example`) and `*.zip` / `*.tar*`.

### 16.7 Not done
- **No browser verification.** No browser automation was added, so layout at a narrow viewport was
  not confirmed in a real browser. The checks are over rendered markup only.
- **No live provider or real Redis calls.** Every check ran with credentials cleared and providers
  mocked.
- Distributed persistence for campaigns, offers and the payment feed was deliberately not
  implemented; those remain in process memory.

---

# 17. OPEN HOUSE DEMONSTRATION SCRIPT

Roughly 5 minutes. Run `npm start`, open `http://localhost:3000`, and press **Reset Demo** at
`/demo` first so every figure starts at zero.

1. **Set the scene (20 s).** At `/welcome`, say what the prototype claims: AI helps the visitor
   decide, NETS verifies the payment, and a verified payment becomes social discovery. Say plainly
   that payments and merchant participation are simulated.
2. **Smart Match (45 s).** From Home, take the recommendation. Point out the offer line: a dollar
   amount of Vouch Credit, the minimum spend, and that the credit is usable only at that merchant.
   Optionally press **Not for me** once to show rejection produces a different merchant.
3. **Pay (60 s).** **Choose this → Scan when you arrive → Scan**, enter a real-looking amount above
   the minimum, and pay. On the receipt, read the earned credit aloud — it names the amount and what
   the merchant intends it towards, and it is money, not an item.
4. **Vouch and share (45 s).** Create the Payment-Verified Vouch, add a tag, and open the share
   sheet. Note that the purchase amount is never shown on the shared page.
5. **Shared Vouch (60 s).** At `/demo`, switch to **Darren**, open the share link, claim it, then pay
   at the **same** merchant. Show that the claim only converts on a payment at that merchant, and
   that Darren's receipt and Jia's sender bonus both appear. (If you have time, pay at the wrong
   merchant first to show the claim is not consumed.)
6. **Merchant view (60 s).** Switch to **Merchant → Results**, then **Business Report**. Show the
   live figures matching exactly the payments just made, and point at the labelled illustrative
   baseline beside them — the charts are sample data so the report has shape, and the report says so.
   Mention that the observations are rule-based demo heuristics, not model output.
7. **Reset (20 s).** Press **Reset Demo** and show the live figures and feed return to zero while the
   merchant's campaign configuration survives.

Do not claim during the demonstration: real NETS settlement, a production AI integration, measured
sales lift or return-visit rates, durable storage, or multi-instance behaviour.
