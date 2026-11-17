# Jolene Step 2: usual merchant activity

Prepared on 17 November 2026 (Asia/Singapore). This step calculates historical usual activity from the installed fictional Task 3 sample history. It does not connect dining-time inputs to recommendations or display activity on Home; those remain Step 3.

## Calculation contract

`merchant-activity.js` accepts exact merchant IDs plus an ISO weekday (`1` Monday through `7` Sunday) and Singapore-local `HH:mm` time. Minutes are floored to the containing hourly sample slot: for example, `14:37` uses `14:00:00`.

One parameterised batch `SELECT` loads every requested merchant. The read includes all `OBSERVED` rows needed for each merchant baseline and all statuses for the requested weekday/hour. It never writes data and never reads `transactions`, campaign metrics, simulated payments, or live provider information.

For each merchant:

1. The target average is the arithmetic mean of `OBSERVED` transaction counts for the requested weekday/hour.
2. The merchant baseline is the arithmetic mean across all that merchant's `OBSERVED` open-hour rows in the sample period.
3. Observed zeroes are included. `MISSING` and `CLOSED` rows are excluded from both averages.
4. Relative difference is `(target average - merchant baseline) / merchant baseline` using unrounded values.
5. A difference at or below `-20%` is `quieter`; greater than `-20%` and less than `+20%` is `typical`; at or above `+20%` is `busier`.

Returned averages are rounded to two decimal places and the percentage to one decimal place only after classification. When both valid averages are zero, the comparison is `typical` with a zero-percent difference.

Example: Felicia's Chicken Rice has Monday 14:00 observations `4, 5, 6, 5`, averaging `5.00`. Its 176 observed open-hour samples total 1,118, averaging approximately `6.35`. The unrounded relative difference is approximately `-21.3%`, so the slot is classified `quieter` relative to that merchant's own typical observed open hour.

This means historically quieter in fictional sample data. It is not evidence of a live queue, waiting time, seating availability, current demand, or real NETS transaction traffic.

## Evidence and states

At least three observed target samples and 28 observed baseline samples are required.

- `available`: both evidence minimums and integrity checks pass; returns `quieter`, `typical`, or `busier`.
- `closed` / `scheduled-closed`: complete matching history exists and every requested weekday/hour row is `CLOSED`.
- `insufficient-data` / `target-sample-too-small`: fewer than three matching observations remain after excluding missing rows.
- `insufficient-data` / `baseline-sample-too-small`: fewer than 28 merchant baseline observations remain.
- `unavailable`: the merchant/dataset is absent, the database read fails, the timezone or metadata is incompatible, the hour lies outside sample coverage, target dates are incomplete, or closed/open states conflict.

Every result includes a stable reason code, requested slot, `Asia/Singapore` timezone, target and baseline sample counts, historical period, fictional sample-data label, and disclosure. Database failures return `database-unavailable` for every requested merchant and do not expose the underlying error.

## Focused verification

The isolated tests cover the hand-calculated Felicia example; exact `-20%` and `+20%` boundaries; observed zeroes; missing and closed exclusion; target and baseline minimums; closed/inconsistent/incomplete history; zero baseline; weekday/hour selection; one parameterised multi-merchant read; requested-order preservation; unavailable metadata and database failures; and non-live labelling.

Approved focused commands:

```text
node --check merchant-activity.js
node --test tests/merchant-activity.test.js tests/task3-sample-data.test.js
```

No full-suite, browser, live database, recommendation, payment, Vouch, AI, or Maps work is part of this step.
