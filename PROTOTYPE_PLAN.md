# NETS Vouch AI — Open House Prototype Plan

Canonical direction, updated for the latest consumer UX brief.

## Objective

Show NETS before, during and after payment: Smart Match, simulated payment/cashback, and optional Payment-Verified Vouch. Keep CommonJS Express, EJS, session objects, HTML forms, CSS and small browser scripts. Backend logic stays in app.js.

## Two distinct journeys

### A — Smart Match / collection preorder

Home → one persistent match → Accept → review and Pay → Track order → merchant Preparing / Ready → Collect → cashback released → Vouch or Not now → completed Home → Find my next match.

Home always shows the next meaningful order action. Ready orders can be collected directly on Home. Rejection is an inline four-reason sheet with one-tap submission and a short matching transition. Visiting Home must not change the selected merchant.

### B — Standalone Scan to Pay

Scan → select a fictional merchant QR and tap Scan → enter purchase amount, optionally use cashback, and Pay on one screen → receipt and immediate eligible cashback → Vouch or Not now → Done.

Scan never creates an order and never requires Smart Match, preparation or collection. The QR identifies a merchant, not a verified payment. Scan uses the entered amount, not a recommendation price.

These journeys deliberately replace the earlier QR-claim-only plan. No temporary promotional claim screen is needed in this version.

## Implemented consumer experience

- Home opens directly; dietary, budget, walking distance and notification preferences live in Profile.
- Five fictional participating merchants have separate campaigns and dynamic merchant/outlet labels.
- Smart Match filters preferences, availability and rejected merchants, then uses simple simulated ranking.
- Optional server-side Google Places discovery remains separate from campaign participation. Offline demo merchants work without a key.
- Rejection records Too far, Costs too much, Not in the mood or Ate this recently. No extra submit step.
- Existing cashback can offset either purchase; only successful payment deducts it.
- Transaction-specific receipts and Vouch decisions prevent previous payments hijacking later journeys.
- Bottom navigation remains exactly Home, Scan, Profile.
- Profile contains preferences, balance, rewards, social Vouches and NETS activity.
- New sessions start with zero cashback, zero transactions and zero social Vouches.

## State ownership

Under req.session.demo:

- user, profile, cashbackBalance
- nearbyMerchants, selectedMerchantId, rejectedMerchantIds, recommendationFeedback, shownMerchantIds
- currentOrder: its own ID, merchant/item, amount, payment, status and Vouch decision
- currentScanPayment: its own ID, merchant, entered amount, payment and Vouch decision
- transactions: permanent-for-session records identified by transaction ID and source
- paymentVerifiedVouches, promotionalRedemptions
- campaigns: one per merchant, each with timing, cap, reward and aggregate metrics
- simple order, scan, transaction and Vouch counters

Order status: PENDING_PAYMENT → PAID → PREPARING → READY → COLLECTED.
Scan status: MERCHANT_FOUND → PAID → COMPLETE. Amount entry and review share one screen.

There is no global latestPayment, activeClaim or journeyComplete. Vouch decisions belong to transactions and are mirrored only onto the matching current journey.

## Payment and reward rules

- Purchase amount must be positive, at most $1,000, with at most two decimals.
- Server calculates cashback offset and NETS remainder in cents. Client totals are not trusted.
- At least $1 must actually be paid with simulated NETS for a Payment-Verified Vouch and campaign reward eligibility.
- Campaign reward additionally requires active status, valid Singapore timing and remaining daily cap.
- A fully cashback-funded payment is allowed, but does not create NETS-verified social proof or earn a new campaign reward.
- Eligible rewards reserve campaign capacity at payment. Smart Match credits the promised reward once after collection; Scan credits it once immediately.
- Campaign edits after payment cannot change a previously promised collection reward.
- No ratings or written reviews. One transaction permits at most one social Vouch; Skip is remembered.
- Public social Vouch content never includes the amount.

## Merchant helper view

Profile's discreet Open House controls open the merchant view. Select the actual merchant to edit Campaign, advance Orders, or inspect aggregated Results. Merchant transitions only allow PAID → PREPARING → READY for the matching merchant and order ID.

This is a simulated collection handoff, not POS integration, delivery or a full kitchen system. Results are prototype-only session statistics, never real pilot claims.

## Routes

- GET /, /home, /smart-match/result; /smart-match/static is the no-JavaScript fallback.
- POST /recommendation/reject, /recommendation/accept, /recommendation/next, /recommendation/try-again, /recommendation/widen-distance.
- GET/POST /payment: Smart Match order only.
- GET/POST /scan, GET/POST /scan/payment, POST /scan/cancel: standalone Scan only.
- GET /payment-success/:id: explicit historical transaction receipt.
- GET /order, GET /order/state, POST /collection.
- GET/POST /vouch/:id, GET /vouch/:id/success, POST /transactions/:id/done.
- GET/POST /profile, GET /transactions/:id.
- GET /merchant, POST /merchant/offer, /merchant/start-preparing, /merchant/mark-ready.
- POST /reset-demo.

Legacy GET shortcuts redirect safely. Forms carry journey IDs; old forms cannot pay a different new journey.

## Integrity and privacy

State-changing routes validate prerequisites and use Post/Redirect/Get. Successful payment, collection, reward and Vouch creation are idempotent. Requests in the same demo session are serialized to prevent simultaneous requests spending the same balance or duplicating rewards.

No bank access, production NETS connection, real cashback payout, real camera scanner or real merchant partnership is claimed. Merchant analytics are aggregated. All demo merchants are fictional. All actions require user approval; social proof indicates a simulated eligible transaction, not product quality.

## Verification and Definition of Done

Automated stateful tests cover both complete journeys, preferences and rejection, exact cashback arithmetic, merchant readiness, premature/duplicate actions, transaction-specific Vouches, direct route guards, navigation, reset and repeat journeys. Browser checks cover loading, inline feedback, Scan amount/totals, payment transitions, collection and Vouch.

Done means both journeys work independently, then consecutively in either order; no stale receipt redirects; no duplicate transactions/rewards/Vouches; dynamic merchant details; no broken visible links; safe invalid state handling; and reset ready for the next visitor.

## Boundaries and future work

In-memory state is intentionally for a single-process Open House demo and resets on server restart. No authentication, database, production payment/QR/POS integration, delivery, notifications service or real AI is included. The notification preference is stored only.

getSmartRecommendation() remains the future AI ranking boundary. Production rollout would require secure identity, durable transactional storage, consent, provider verification and settlement. These are outside this prototype task.
