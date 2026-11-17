# Jolene Step 3: dining-time usual activity

Implemented on 17 November 2026 (Asia/Singapore). This step connects intended dining date/time and the Step 2 fictional-history calculation to the existing catalogue recommendation API and Home cards. It does not add Maps routing, live traffic, queues, waiting times, seating availability, payment persistence, or new database writes.

## Request contract

`GET /api/recommend` accepts optional `budget`, `maxDistance`, `lat`/`lng`, `cuisine`, `dietaryPreference`, `diningDate`, and `diningTime` query values. Cuisine uses the existing `any|rice|noodles|pasta|soup|bread` preference values. Dietary preference independently uses `none|halal|vegetarian|vegan`.

`diningDate` is a strict `YYYY-MM-DD` Singapore calendar date and `diningTime` is strict `HH:mm`. The Home `datetime-local` value is split into those two strings without constructing a browser `Date` or applying browser-timezone conversion. Missing fields use profile or current Asia/Singapore defaults.

Every explicitly supplied field is validated before a catalogue/activity read, discovery-location mutation, or recommendation-batch replacement. Invalid requests return HTTP 400:

```json
{
  "error": {
    "code": "invalid-recommendation-input",
    "fields": { "cuisine": "unsupported-value" }
  }
}
```

`cuisine=halal` is invalid; callers use `dietaryPreference=halal`. **Superseded in Step 6:** `lat` and `lng` are no longer accepted on GET (HTTP 400 `unsupported-parameter`); live locations use the POST routes described in `docs/jolene-step6-google-walking-routes.md`. The RP demo-origin behaviour of this route is otherwise unchanged.

## Eligibility, activity and ranking

Budget, explicit dietary capability, stored distance, meal/campaign availability, and rejection history are applied before activity is read. Catalogue distance remains the stored estimate from the Republic Polytechnic demo origin and is labelled as non-routed.

For a non-empty eligible batch, `loadUsualActivity` is called exactly once with every eligible merchant ID, Singapore ISO weekday, and intended hourly slot. Historically closed merchants are removed. Insufficient or unavailable activity remains eligible and neutral. Available comparisons adjust the existing score by `+20` for quieter, `0` for typical, and `-20` for busier.

Final ordering is score descending, stored distance ascending, typical price ascending, then exact merchant ID ascending. At most three cards are returned. Each card carries its historical result and grounded match reasons. The response also carries request, distance-basis, catalogue, and activity-availability metadata.

Activity and explanations are copied into the recommendation/selected snapshot only for consistent display. Payment amounts, transaction facts, reward eligibility, campaign counters, Scan, and Vouch calculations continue to use their existing catalogue and campaign facts.

## Presentation and failure behavior

Home provides a responsive `datetime-local` control. Cards show typical price, factual cuisine, explicit dietary flags, demo-origin distance wording, and one of quieter, typical, busier, insufficient-history, or unavailable text. All activity copy says it is fictional sample history. Catalogue outage and activity outage remain separate and neither exposes database errors.

The three-card accept/reject forms are unchanged. An accepted card retains the same historical display after the redirect, while downstream payment and Vouch mechanics ignore that display-only data.

## Focused isolated verification

Syntax checks cover `app.js`, `public/js/script.js`, the isolation helper, and the Step 3 test. The focused isolated run covers Step 2 calculations, Step 3 API/Home behavior, catalogue rendering, catalogue-to-Scan/payment/Vouch snapshots, direct Scan lookup, and rejection handling.

Final focused result: **79 tests passed, 0 failed, 0 cancelled, 0 skipped, 0 todo** in approximately 2.0 seconds. All changed JavaScript files passed `node --check`.

Verified scenarios include strict pre-read validation, cuisine/dietary separation, `cuisine=halal` rejection, Singapore weekday/hour selection, one parameterized batch read, closed exclusion, neutral activity failure, deterministic ordering, all three cards' accept/reject actions, unchanged reward facts, escaped UI content, and mobile dining controls. Tests use the in-memory isolation database and shared Task 3 definition; they do not execute MySQL, browser automation, migrations, seeds, or the full suite.

Remaining limitations: stored distance is not device-relative or routed; coordinates are not connected to recommendation distance; activity reflects only the four-week fictional sample period; process-local campaign/payment simulation remains unchanged; and layout is structurally tested rather than verified in a real browser.

