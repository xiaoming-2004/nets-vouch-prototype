# Jolene Step 6: Google starting point and walking travel information

> **Dormant by default (Task 9).** Everything below runs only when `GOOGLE_SERVICES_ENABLED` is exactly `true` and the specific key is present. This deployment is in S$0 Google-disabled mode; see `docs/task9-zero-cost-deployment.md`. The tests in this document use mocked responses and are not live Google evidence.

Implemented on 17 November 2026 (Asia/Singapore). A user can choose a real Singapore starting point and see Google Maps walking minutes and metres to the fictional sample merchants. The RP demo-origin estimate remains the default, clearly labelled mode. There is no schema, migration, seed or database write, no route cache, and no embedded map.

## Modes and request contracts

| Mode | Request | Distance used |
| --- | --- | --- |
| RP demo origin (default) | `GET /api/recommend` | Stored catalogue estimate from the Republic Polytechnic demo origin, not routed. Unchanged from Steps 3 to 5. |
| Live starting point | `POST /api/recommend/live`, or `POST /api/recommend/natural` with an optional `location` | Google Routes walking duration and distance from the chosen origin only |

- **GET never takes coordinates.** A `lat` or `lng` parameter returns HTTP 400 `invalid-recommendation-input` with `fields.lat/lng = "unsupported-parameter"` before any read; it is never ignored, stored or routed.
- **`POST /api/recommend/live` body** (JSON; unknown keys rejected): `{ "location": {"latitude", "longitude"}, "budget"?: number, "maxDistance"?: integer, "cuisine"?, "dietaryPreference"?, "diningDate"?, "diningTime"? }`. Coordinates must be finite numbers inside a Singapore bounding box (about 1.15 to 1.48 N, 103.55 to 104.10 E). Everything is validated, with the Step 3 rules for the filters, before any database or Google read. Errors name fields only (`invalid`, `out-of-range`, `outside-singapore`, `required`, `unknown-field`, `invalid-type`) and never echo values.
- **Step 5** accepts the same optional `location` object. The language model never receives coordinates or place names; it only receives the cleaned request text.
- **Response** is the Step 3 shape. In live mode each card has `distanceMetres`, `distanceMinutes` and `distanceLabel` set to `null` and a `travel` object (`mode`, `walkingMinutes`, `walkingMetres`, `provider: "Google Maps"`, `warning`, `sampleDestination`). `metadata.distance.basis` is `google-walking-route` and `metadata.travel` holds counts only (`requestedDestinations`, `withoutCoordinates`, `noRoute`, `unavailable`, `beyondWalkingLimit`). The response never contains the origin.

## Live processing

1. Validate, then load durable feedback (Step 4), then the catalogue (which now includes each fictional merchant's sample coordinates).
2. Apply campaign, meal, budget, dietary and exact-rejection eligibility. The stored RP distance is not compared.
3. One `computeRouteMatrix` request (one origin, all routable eligible destinations, `travelMode: "WALK"`, **no** `routingPreference`, field mask `originIndex,destinationIndex,duration,distanceMeters,status,condition`). Results are mapped by `destinationIndex`, never by array position. Proto3 JSON omits zero indices and zero distances, which the parser accepts.
4. Hard filter: `ceil(duration / 60)` minutes must be at most the request's maximum walking minutes. `ROUTE_NOT_FOUND`, per-element errors, missing elements and merchants without coordinates are excluded and counted.
5. Step 2 usual activity for the survivors (insufficient history stays neutral), then the existing score with proximity from routed metres (`routedMetres / 20`) and the Step 4 learned score. A live origin counts as explicit location context, so distance similarity learned from another origin is not applied. Exact rejected-merchant exclusion, price and cuisine learning still apply.
6. Same deterministic tie-break, at most three cards, fresh feedback tokens, and the same authorisation batch as GET and Step 5.

The fictional merchants are never looked up in Google Places and never receive a place ID. Their sample coordinates are used only as route destinations. Cards state that the merchants are fictional sample data.

## Coordinate lifecycle and non-persistence

The precise origin exists only:
- in browser memory (a closure variable in `public/js/script.js`: never localStorage, sessionStorage, cookies, URLs or HTML attributes);
- in the JSON body of the live POST;
- in the server-to-Google Routes request, for the duration of that request;
- in a user-triggered Google Maps directions link built in the browser.

It is cleared on reload (which returns to RP demo mode), on any failed live request, and when switching to the RP demo origin. The server never stores it in the session, `catalogueBatch`, snapshots, rejection rows, payment, receipt or Vouch state, database calls or logs, never returns it, and never builds or stores a directions URL. `/api/recommend` no longer writes any session location. Malformed JSON on the recommendation routes gets a fixed 400 from a route-scoped handler, so a stack message quoting part of the body cannot reach logs or responses. The legacy `POST /smart-match/location` route, which stored coordinates in the session and an in-process cache, has no active caller and is **disabled**: it now returns HTTP 410 `smart-match-location-disabled`, reads no request field, mutates no session state, stores and logs nothing. Its dead browser code was removed. The legacy discovery test suites now seed their session location directly through `tests/helpers/legacy-location.cjs`. `GET /smart-match/result` (the legacy discovery page, not linked from any page) used to accept `?lat=&lng=` and store them in the session and an in-process cache. That branch and the cache are removed: any `lat`, `lng`, `latitude` or `longitude` query key (including bracketed or differently cased forms) now returns a fixed HTTP 400 `smart-match-coordinates-not-accepted` before the session is read, with no redirect, log, database call or outbound call. No GET endpoint accepts a precise location, and nothing in the application writes a coordinate to `discoveryLocation`. The retained `/smart-match/static` noscript journey redirects to `/home` and uses the labelled demo merchants. Catalogue (fictional sample) merchants no longer show a map pin or a server-rendered directions link on the Home accepted card.

Live rejections store NULL distance values, so routed distances never affect RP-origin "Too far" learning (exact 30-day exclusion still applies).

## Temporary journey state, not stored Google data

Routed minutes and metres exist only in the active in-memory journey: the current batch, the selected snapshot and the Scan journey snapshot, so the selected card stays visually consistent. They are replaced by the next batch and cleared by Reset Demo. Completed transactions and shared Vouch offers strip them. They must never be reused as historical merchant data. Nothing Google-derived is written to MySQL, activity history, reports or rejection rows, and there is no route cache.

## Browser flow

- A "Starting point" panel explains, before anything is requested, that the location is used only in this tab, is sent to our server for that request and to Google Maps to calculate routes, and is not saved.
- **Use my location** is a user-pressed button. Accuracy worse than 150 metres (or unknown) is rejected; denied, unavailable, timeout and unsupported each have their own message. Typed-place and demo alternatives are always offered.
- **Search for a place** loads Google Maps JavaScript only on first use and shows `PlaceAutocompleteElement` limited to Singapore (`includedRegionCodes = ['sg']`) and biased near Republic Polytechnic. It requests only `location` and `displayName`. Google's attribution inside the widget is not hidden or restyled. The place name stays in browser memory and is rendered with `textContent`.
- Live results render in the normal card list. The previous results stay on screen if a live request fails.

## Attribution, warning and directions link

Every Google route fact is shown in one bordered container (`views/partials/google-walking.ejs` on the server and `renderGoogleRoute` in the browser): facts, then the visible text `Google Maps` with `translate="no"` (Roboto/sans-serif 13px, weight 400, colour `#5E5E5E` on white, never wrapped, hidden, clipped or faded), then the walking warning. The warning is one constant, `WALKING_WARNING` in `walking-routes.js`:

> Walking routes are in beta and may be missing clear sidewalks or pedestrian paths. Use caution.

It is displayed with every live result on Home and on the Scan page. Route facts are never shown without it. Fictional merchant facts sit outside the container. The wording is the project's required copy; confirm it still matches Google's current Routes API requirements during the terms review below.

The "Open walking directions" link is built only in `public/js/script.js` with `URL` and `URLSearchParams` from the in-memory origin and the fictional sample destination coordinate, uses `rel="noopener noreferrer"`, appears only while a live origin exists, is removed immediately when the origin is cleared, and is accompanied by "Destination is a fictional sample merchant coordinate." It is never shown on Scan, payment, receipt or Vouch pages.

## Failure behaviour (live mode never falls back silently to RP estimates)

| Code | HTTP |
| --- | --- |
| `walking-routes-not-configured` | 503 |
| `walking-routes-timeout` (default 4 s, `WALKING_ROUTES_TIMEOUT_MS` 500 to 10000, one attempt, no retry) | 504 |
| `walking-routes-rate-limited` (provider 429, `retryable`) | 503 |
| `walking-routes-provider-failure` | 502 |
| `walking-routes-invalid-response` (malformed array, bad duration, bad or duplicate index, every element errored) | 502 |
| `live-recommendation-unavailable` (engine failure after routing started) | 503 |
| `location-request-rate-limited` (20 per rolling 60 s per session, with `Retry-After`) | 429 |

Each failure body is `{ error: { code }, alternative: "demo-origin" }`, returns no recommendations, never contains provider text or keys, and leaves the previous batch and feedback tokens unchanged. All of this happens before the session is mutated. A matrix where every element cleanly has no route returns an empty 200 instead.

## Key and deployment setup (to be configured separately after implementation)

Two different variables, neither committed (`.env` is private):

- `GOOGLE_MAPS_BROWSER_API_KEY`: browser key. Restrict by HTTP referrer (localhost for development and the deployed domain) and to **Maps JavaScript API** and **Places API (New)** only. It is rendered into the Home page only when set (inside the starting-point panel), and it is public by nature.
- `GOOGLE_ROUTES_API_KEY`: server-only key. Restrict to **Routes API** only. It is read only in `walking-routes.js`, sent only in the `X-Goog-Api-Key` header to Google, and never reaches the browser, a response, a log or an error. Vercel does not provide a stable outbound IP address for ordinary deployments, so an IP restriction may be unavailable; API restriction, daily quotas and billing alerts are therefore essential.
- The existing `GOOGLE_PLACES_API_KEY` (legacy discovery and photos) is not reused by Step 6, and since Task 9 the legacy Google/Foursquare paths also need `GOOGLE_SERVICES_ENABLED=true`.
- `GOOGLE_SERVICES_ENABLED`: opt-in master switch (exactly `true`); off by default.
- Optional: `WALKING_ROUTES_TIMEOUT_MS`.

Cost notes (read from Google's pricing page on 17 November 2026, which showed no date; pricing can change, so confirm before the event): free monthly caps listed were Compute Route Matrix 10,000 (Essentials), 5,000 (Pro), 1,000 (Enterprise); Autocomplete requests 10,000 with session usage unlimited; dynamic maps 10,000. The page does not say which Routes tier applies to walking. Matrix elements are billed per origin and destination pair, so a request with ten merchants is about ten elements; if Essentials applies, 10,000 free elements is only about 1,000 requests a month. Set a daily quota on the Routes API and budget alerts in Google Cloud.

Deployment prerequisite: complete a Google Maps Platform attribution, privacy and terms review (including showing route data without a Google map and the walking-warning requirement) before public use.

## Verification

Focused, isolated tests in `tests/jolene-step6-walking-routes.test.js` use a mocked `fetch`, DOM stubs and the existing isolation harness. They do not call Google, use MySQL, run a browser, or run the full suite. See the completion report for exact counts. Layout, the Google Maps loader, `PlaceAutocompleteElement` and real geolocation have **not** been verified in a real browser or on a phone.

## Limitations

- The Google Maps JavaScript loader and `PlaceAutocompleteElement` calls follow Google's documentation but have never run against the live service; geolocation and the widget need a manual browser and phone check once the keys exist.
- Only ten fictional merchants within about 720 m of Republic Polytechnic exist, so a starting point more than a few kilometres away will often show no match within the walking limit.
- Walking times are Google estimates and may differ on the day. There is no live queue, arrival guarantee, verified merchant participation or real NETS activity.
- The per-session limit is in memory and is not a global quota guard.
