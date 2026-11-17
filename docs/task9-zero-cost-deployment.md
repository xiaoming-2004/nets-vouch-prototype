# Task 9: S$0 Google-disabled deployment

Implemented on 17 November 2026. **This deployment operates in S$0 Google-disabled mode. No Google key is connected to this deployment.** (That is a statement about the deployment's configuration, not a claim that no Google key exists anywhere.)

## What the application does by default

Google functionality is off unless the environment variable `GOOGLE_SERVICES_ENABLED` is **exactly** the string `true`. A missing, blank, `false`, `TRUE`, `1`, `yes`, padded or otherwise malformed value means disabled. Even when it is `true`, each capability also needs its own key (`google-services.js`):

| Capability | Needs the switch and |
|---|---|
| Server walking times (Routes) | `GOOGLE_ROUTES_API_KEY` |
| Place search (browser Maps/Places) | `GOOGLE_MAPS_BROWSER_API_KEY` (and Routes enabled) |
| Legacy Google Places discovery, continuation/widening, photo proxy | `GOOGLE_PLACES_API_KEY` |
| Legacy Foursquare location discovery and its health ping | `FOURSQUARE_API_KEY` |

While disabled:

- `POST /api/recommend/live` returns the generic 503 `walking-routes-not-configured`, and a natural-language request with a location fails the same safe way. No outbound request occurs, and the current batch and feedback tokens are untouched.
- Legacy discovery, continuation, widening and photo routes cannot contact Google or Foursquare; they fall back to the fictional RP demo data. Nothing falls back to another paid provider.
- Home shows a static **RP demo origin** control (no "Use my location" or "Search for a place" buttons, no geolocation request, no Google script, no directions link) and the line "RP demo mode · estimated distances, not walking times · fictional sample data."
- Cards show "Fictional sample merchant", the "RP demo distance" panel and fictional-history wording; there is no merchant map and no server-built directions link.
- Startup logs `Google services disabled (S$0 mode)`. If a gated key variable is present, one warning names the variable only; no value, prefix, suffix or length is ever printed.
- Groq (natural-language input) and the unrelated OpenAI/Tavily paths are not changed by this switch.

## What the distances mean

RP distances are stored fictional estimates from the RP demo origin. They are **not** routed walking times. Merchants, menus and activity are fictional sample data.

## Mocked Google tests are not live evidence

The Step 6 and legacy Google/Foursquare suites use mocked responses. They show the dormant integration works as designed; they are technical evidence only, never live Google results. The shared test harness opts those suites in explicitly; `tests/task9-zero-cost.test.js` proves the real default is off.

## Enabling Google safely in the future (separate, funded decision)

Live Google support requires a separate reviewed, funded decision (a school-owned billing project, new restricted keys, quotas, and a privacy/attribution review per `docs/jolene-step6-google-walking-routes.md`). Then set `GOOGLE_SERVICES_ENABLED=true` and the specific keys needed. Budget alerts do not cap spending; quotas reduce risk but do not guarantee S$0.

## Returning to S$0 immediately

Remove `GOOGLE_SERVICES_ENABLED` (or set it to anything other than `true`) and redeploy. All Google and Foursquare location requests stop at once, even if keys remain in the environment. No code needs to change.
