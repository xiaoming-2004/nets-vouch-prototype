# Jolene Step 5: natural-language recommendation requests

Implemented on 17 November 2026 (Asia/Singapore). The LLM performs **intent extraction only**. The existing deterministic catalogue engine validates, filters and ranks. This is not reinforcement learning, a trained predictive model, or an AI choice of merchants. There is no migration and no database write.

## Flow

1. Home has one labelled input (`maxlength` 200) above the dining-time form: "Describe what you feel like".
2. The browser calls `POST /api/recommend/natural` with `{ "text": "…" }`. The provider key never reaches the browser.
3. The server cleans the text (control and bidirectional characters removed, whitespace collapsed), checks it is 1 to 200 characters, applies the local limit, and calls Groq.
4. The reply is validated against a strict schema, resolved deterministically, and passed through the existing Step 3 `recommendationInput()` validation.
5. The shared core (`buildRecommendationResponse`, extracted from `GET /api/recommend`) loads durable feedback, the catalogue and usual activity, ranks, and replaces the three-card batch with fresh feedback tokens exactly as the GET route does.
6. The response is the GET payload plus `interpretation`: `{ source, model, understood[], notApplied[], resolved }`. "Understood as" labels are server templates built from validated values, never LLM prose. Match reasons remain the existing grounded `recommendationReasons()`.

Interpretation finishes before any catalogue read, discovery-location change or batch replacement. A failure returns no recommendations and leaves the current batch and its feedback tokens untouched.

## Provider and model

- Groq only; no OpenAI or other fallback. A dedicated `callNaturalLanguageProvider` is used (not `callResearchProvider`).
- Default model `openai/gpt-oss-20b`; override with `GROQ_NATURAL_LANGUAGE_MODEL`. Groq lists this model as Production and documents strict JSON Schema structured outputs for it (checked 17 November 2026; re-check before relying on it, as Groq retires models regularly). `nets_agent.js` still references the retired `llama3-8b-8192`; it is unused and was left unchanged.
- `response_format.type = json_schema`, `strict = true`, every property required, `additionalProperties = false`, `temperature = 0`. No tools and no streaming.
- One total timeout (`NL_REQUEST_TIMEOUT_MS`, default 5000 ms, accepted range 500 to 15000) covers the call and any retry. One retry only, for a network error or HTTP 5xx, and only if time remains. Authentication errors, 429, schema-invalid output and unusable intent are never retried.
- `GROQ_API_KEY` is read on the server at call time and is never logged, returned or placed in an error. Provider response bodies, headers and messages are never read into errors or returned.

## Schema

Every key is required; `null` means "not mentioned". Missing or unknown keys, wrong types, bad enums and out-of-range values reject the whole reply.

| Key | Allowed values |
| --- | --- |
| `budgetMax` | number 1 to 1000, or null |
| `distance` | `"nearby"` or null (never a number) |
| `cuisine` | null, `any`, `rice`, `noodles`, `pasta`, `soup`, `bread` |
| `dietary` | null, `none`, `halal`, `vegetarian`, `vegan` |
| `dayRef` | null, `today`, `tomorrow`, `mon` to `sun` |
| `time` | null or strict 24-hour `HH:mm` |
| `mealPeriod` | null, `breakfast`, `lunch`, `dinner`, `supper` |
| `unsupported` | at most 5 unique plain-text strings, each 1 to 40 characters |

The provider-facing schema uses types, enums, `required` and `additionalProperties: false`; numeric ranges and string lengths are enforced by the server, not by schema keywords.

`any` (cuisine) and `none` (dietary) are explicit statements that replace the saved preference for this request only. The saved profile is never changed. Budget, cuisine and dietary values supplied this way follow the same explicit-field path as Step 3 query parameters (including Step 4's explicit-filter precedence).

## Resolution rules (server side, Asia/Singapore, clock injectable for tests)

- **Nearby:** uses the user's saved maximum-distance limit and never tightens it. The chip says it is a demo-origin estimate, not a routed walking time. It supplies no new number, so it is not treated as an explicit distance override and Step 4 distance learning keeps working.
- **Explicit distances** ("within 5 minutes") are not applied. They are reported under "Not applied" with a hint to use the manual filters. If the model mapped such text to "nearby", the server still reports that the specific distance was not applied.
- **"Light"** (and similar words such as cosy or spicy) is not applied: the catalogue has only cuisine, typical price, distance, three dietary flags and reward terms, and no lightness field. It is shown under "Not applied" and does not change ranking. "Something light nearby under $10" therefore runs with a budget of at most $10 and the saved distance limit.
- **Meal periods:** breakfast 08:00, lunch 12:00, dinner 18:00, supper 21:00 (all inside the 07:00 to 21:00 sample slots).
- **Time and meal period together:** the explicit time wins. If it falls outside that meal's window (breakfast 06:00 to 10:59, lunch 11:00 to 14:59, dinner 17:00 to 20:59, supper 21:00 to 23:59) the conflict is reported under "Not applied".
- **Dates:** one Singapore reading of the clock per request. No day means today; `tomorrow` is today plus one day; a weekday means the next occurrence, and the current weekday means today. A day without a time uses the current Singapore time.

## Failure contract

Every failure returns no recommendations, never exposes provider text or credentials, keeps the typed text and manual controls in the browser, and leaves the existing batch unchanged.

| Code | HTTP |
| --- | --- |
| `invalid-natural-language-input` | 400 |
| `natural-language-not-configured` | 503 |
| `natural-language-timeout` | 504 |
| `natural-language-provider-failure` (`retryable: true` for a provider 429) | 502 |
| `natural-language-invalid-output` | 502 |
| `natural-language-no-usable-constraint` (includes the safe `notApplied` list) | 422 |
| `natural-language-rate-limited` (with `Retry-After`) | 429 |
| `natural-language-recommendation-unavailable` (the shared recommendation engine failed after interpretation succeeded; no internal detail is returned) | 503 |

The local limit is 10 requests per rolling 60 seconds per browser session, kept outside the demo state so Reset Demo does not clear it.

## Privacy and safety

The provider receives only a fixed system instruction and the cleaned request text wrapped as JSON. It receives no merchant data, user identity, session data, feedback history, database content or credentials. The raw text is not logged; only its length and the outcome code are. User text is treated as data: the system instruction tells the model to ignore instructions in it, the schema forbids extra keys, and every value is validated and re-validated by the Step 3 rules.

All new browser text (typed text, "Understood as" chips and "Not applied" phrases) is written with `textContent`; the new code never uses `innerHTML`. The existing card renderer escapes catalogue fields as before.

## Verification

Focused, isolated tests in `tests/jolene-step5-natural-language.test.js` use a mocked `fetch` and the existing isolation harness. They do not call Groq, use MySQL, run a browser, or run the full suite. See the completion report for the exact counts.

## Live Groq smoke test

Run on **17 November 2026** against a temporary local server on an unused loopback port (since stopped; the port was confirmed closed), the normal local `netsvouch` database for reads only, and the live Groq API with the existing private key. Model: `openai/gpt-oss-20b` (no override set). A guard rejected any non-`SELECT` statement and any transaction connection; none was attempted. No rejection, reset, payment, Vouch, preference-save, migration, seed or `db.sql` path was used. Groq's strict-schema request was accepted as written: all three calls returned HTTP 200 and no compatibility change was needed. Request text, authorization and provider bodies were not recorded; captured application logs contained no API key, authorization text, prompt text or system instruction.

| # | Request | Interpreted constraints | Cards |
| --- | --- | --- | --- |
| 1 | "Something light nearby under $10" | budget $10; nearby resolved to the saved 15-minute limit (demo-origin estimate, not routed); "light" not applied; current Singapore time | 3, all within $10 and 1,200 m |
| 2 | "Halal noodles tomorrow at 7pm under $12" | halal; cuisine noodles; budget $12; 2026-11-18 (Singapore tomorrow) at 19:00 | 2, all halal, within $12 and the saved distance |
| 3 | "No dietary restrictions, anything for lunch" | dietary `none`; cuisine `any`; 12:00; replaced a session stand-in saved profile of vegetarian/soup for this request only, and the profile was unchanged afterwards | 3 |

All three responses reported `interpretation.source = "llm"`, catalogue source `mysql`, usual-activity status `available`, feedback status `applied`, the demo-origin distance basis, and a feedback token and sample-activity result on every card. Every card came from the deterministic engine's catalogue; no merchant fact was produced by the LLM. In request 2 the cuisine is a ranking preference rather than a hard filter, and no halal noodle merchant exists in the sample catalogue, so the two cards are other halal merchants within the hard filters.

Database preservation (row counts and table checksums identical before and after): `users` 2, `merchants` 10, `transactions` 0, `rejection_feedback` 0, `merchant_sample_activity` 4,200. The smoke script ran twice (six Groq calls in total) because the first run's tail output was truncated; both runs succeeded and only the second was recorded in full. Request 3 used an in-memory session value as the "saved" profile because the database persona has none of those preferences; MySQL was not written.

## Limitations

- Only constraints the Step 3 engine already supports are applied; dishes, tastes, lightness, "cheap" and specific walking times are reported as not applied.
- Distance remains a stored demo-origin estimate, not a routed walking time. Activity is fictional four-week sample history, never a live queue.
- The live smoke test covers three sample sentences on one model on one day; Groq model availability and schema support should be re-checked before each demo.
- Layout is structurally tested, not verified in a real browser.
- The 10-per-minute limit is per session and in memory; it is not a global quota guard.
