# NETS Vouch AI — Current Product Plan

## 1. Product thesis

NETS Vouch AI helps consumers decide where to spend, verifies the resulting NETS payment, and turns eligible payments into trusted social discovery and measurable merchant outcomes.

**AI helps users decide → NETS verifies the payment → Vouch creates trusted discovery → merchants measure campaign-linked outcomes.**

NETS Vouch is not food delivery, preorder, a kitchen system, a POS replacement, or a universal cashback app.

## 2. Current consumer journey

Smart Match → merchant recommendation → **Scan when you arrive** → visit merchant → scan simulated participating-merchant QR → merchant detected → enter actual purchase amount → optionally apply that merchant's Vouch Credit → simulated NETS payment → payment success → eligible merchant-specific Vouch Credit → optional Payment-Verified Vouch → optional sharing.

The suggested item and price explain the recommendation only. They do not create or lock an order. Jia may purchase any item, and the amount entered after scanning is the actual purchase amount.

Direct Scan remains available when Jia is already at a merchant. It uses the same payment, credit, reward, and optional Vouch flow without requiring Smart Match.

## 3. Consumer navigation

- **Home:** persistent Smart Match or selected merchant state.
- **Scan:** participating-merchant QR simulation, actual amount entry, merchant credit, and NETS payment.
- **Profile:** Jia's identity, merchant-specific rewards, My Vouches, NETS Activity, preferences, and notifications.
- **Demo helper:** merchant and reset controls are separate at `/demo` and are not shown in Jia's Profile.

## 4. Smart Match and future AI

Rules filter what is possible:

- Participating merchant and valid campaign.
- Dietary preference.
- Budget.
- Maximum walking distance.
- Merchant and campaign availability.
- Prior rejection in the current journey.

The current `getSmartRecommendation()` uses simple JavaScript rules, local fallback merchants, and optional nearby-place discovery. It records recommendation, acceptance, rejection reason, and payment signals. Production AI ranking is not implemented. Kai's future AI/API work should replace the ranking internals without changing the route or EJS contract.

AI may rank eligible merchants and learn from outcomes; it must not override eligibility rules or Jia's final choice.

## 5. Merchant-specific Vouch Credit

- Each balance belongs to one merchant: Felicia credit works only at Felicia; Green Bowl credit works only at Green Bowl.
- Credits are merchant-funded campaign value, not a universal NETS wallet.
- Credit may offset a future payment only at its merchant.
- At least `$1.00` must remain payable through NETS for the transaction to qualify for a new reward or Payment-Verified Vouch.
- One qualifying transaction earns at most one customer reward.
- The qualifying reward is earned from payment; creating a Vouch is optional.
- **A reward is a cash amount, not an item.** The prototype holds a numeric per-merchant credit
  balance and has no item entitlement and no in-store item redemption. Nothing customer-facing may
  present an earned item.
- **Each merchant sets its own reward amount and minimum qualifying spend**, so two merchants shown
  by Smart Match may offer different amounts above different minimums. A merchant may also choose a
  label describing what the credit is *towards*; every screen renders that label beside the
  campaign's live amount, and the label is validated server-side so it cannot promise an item or
  carry a figure of its own.

Payment records retain merchant, original purchase amount, merchant credit used, NETS amount paid, reward earned, attribution source, status, and Vouch decision.

## 6. Payment-Verified Vouch

A Payment-Verified Vouch confirms that an eligible simulated NETS payment occurred at the named merchant. It does not guarantee product quality, represent a NETS rating, or expose the transaction amount publicly.

- Maximum one Vouch per eligible transaction.
- Vouch creation is optional and does not unlock Jia's normal purchase reward.
- All share actions use the same Vouch record and claim link.
- WhatsApp and Telegram open their share URLs; Copy Link copies the same URL.

## 7. Shared Vouch journey

Jia creates a Payment-Verified Vouch → shares its link → Darren opens it → Darren claims the merchant offer → no reward is issued at claim time → Darren pays with NETS at the same merchant → the eligible claim becomes redeemed → Darren receives the merchant-specific reward once → an optional sender referral reward may be credited to Jia.

Current safeguards include same-merchant matching, claim status, payment idempotency, one receiver reward per transaction, no stacking with the normal customer reward, and blocking the Vouch owner from claiming their own link.

## 8. Attribution

Use three product attribution labels:

- **SMART_MATCH** (`smart-match`): Smart Match influenced merchant choice before payment.
- **SHARED_VOUCH** (`shared-vouch`): a claimed friend offer influenced the eligible same-merchant payment.
- **DIRECT_SCAN** (`scan`): the customer was already at the merchant and entered through Scan directly.

Smart Match conversion must use Smart Match activity only. Shared Vouch conversion must use Shared Vouch claims and eligible payments only. Direct Scan is payment activity, not automatically acquired by Smart Match or a shared Vouch.

## 9. Merchant campaign and commercial model

The merchant funds capped, merchant-specific rewards and can observe campaign-linked results. The current campaign object contains reward amount, active time window, daily redemption cap, redemption count, active status, optional sender referral reward, an illustrative per-attributed-payment platform fee, accrued fee, and metrics.

NETS may benefit from additional NETS payment volume and may charge a success-based fee for clearly attributed conversions. The seeded fee is prototype accounting only: it is not final NETS pricing, proof of profitability, validated infrastructure cost, or real merchant billing.

Merchant reporting should distinguish campaign-linked sales, attributed payments, reward cost, platform fees, claims, and conversions. Campaign-linked sales must not be called profit, guaranteed ROI, or incremental profit.

**Value loop:** Smart Match → merchant choice → NETS payment → merchant-funded reward → optional Payment-Verified Vouch → social referral → another verified NETS conversion → measurable merchant outcome.

NETS turns verified payments into a measurable merchant referral loop.

## 10. Reward integrity: implemented versus required

### Implemented now

- Fixed minimum eligible NETS payment of `$1.00`.
- Merchant-specific credit lookup, addition, and use.
- Daily redemption-count cap within the current demo session.
- Payment, reward, claim redemption, and Vouch idempotency.
- Maximum one customer reward per qualifying transaction.
- Shared receiver reward replaces rather than stacks with the normal customer reward.
- Sender referral reward is delayed until the receiver's eligible same-merchant payment and consumes an additional cap slot when capacity exists.
- Self-claim is blocked by session identity.
- Same-session requests are serialized to reduce double-spend and duplicate-reward risk.

### Also implemented since this section was first written

- Merchant campaign state (caps, budget, status, metrics) is **shared across browser sessions**: it
  lives in one module-level store, not under `req.session.demo`.
- A maximum merchant **reward-budget amount per day**, which both the customer reward and any sender
  referral bonus count against.
- A **configurable merchant minimum purchase amount**, separate from and in addition to the `$1.00`
  NETS-paid requirement, and editable per merchant.
- **Sender/recipient/merchant referral cooldowns**, which block a repeated rewarded conversion for
  the same trio.
- **Shared-offer claim expiry**, evaluated lazily wherever a claim is read.
- Attribution is **split by `SMART_MATCH`, `SHARED_VOUCH` and `DIRECT_SCAN`** throughout metrics and
  reporting. A Direct Scan is never counted as a Smart Match conversion and accrues no success fee.
- Merchant reporting separates **live recorded payments from labelled illustrative sample data** and
  never adds the two together.

### Still required before multi-user or production use

- **Durable cross-process duplicate and reward-farming protection.** Campaign state, shared offers,
  referral cooldowns and the payment feed are process memory: shared across sessions on one
  instance, but lost on restart and not shared across instances. These must not be described as
  production abuse prevention.
- **Instance-wide Reset Demo.** The reset generation is held in the resetting process, so with
  Redis-backed sessions across several instances a reset does not reach sessions served elsewhere.
- **Per-day metric bucketing.** Live campaign metrics accumulate since the last Reset Demo; only the
  daily redemption count and budget spent roll over at the Singapore date boundary. The report
  therefore reports "since last Reset Demo" rather than "today".
- **Outcome measurement.** No sales-lift, return-visit or perceived-value data is collected, so no
  such figure may be presented. The report's observations are explicitly rule-based demo heuristics.

## 11. Technical architecture

Stack: Node.js, Express.js, EJS, `express-session`, CommonJS, HTML, CSS, and Vanilla JavaScript. Backend logic remains in `app.js` for RP C237 readability.

### Session state

- Jia/Darren demo identity.
- Preferences and rejected Smart Matches.
- Merchant-specific `vouchCredits`.
- Selected recommendation and current Scan journey.
- Transactions and Payment-Verified Vouches.
- Active shared offer claim.
- Campaign copies, counters, and metrics.

### Process memory

- Merchant campaigns: caps, budget spent, status, hours, accrued fees and live metrics, shared across
  every browser session on the instance.
- Shared Vouch offer links connecting sender and recipient sessions.
- Referral cooldowns for a sender/recipient/merchant trio.
- The cross-session merchant payment feed, including the labelled illustrative seed rows.
- Provider discovery, search-intent and dietary-research caches, and the discovered-merchant registry.

All of this is lost on restart and is **not** shared across server instances.

There is no database, authentication, durable campaign store, production consent system, or multi-instance persistence.

## 12. Main routes

- Home and Smart Match: `/home`, `/smart-match/result`, `/recommendation/reject`, `/recommendation/accept`.
- Scan and payment: `/scan`, `/scan/payment`, `/payment-success/:id`.
- Vouch and sharing: `/vouch/:id`, `/vouch/:id/success`, `/offers/:token`.
- Profile: `/profile`, `/profile/rewards`, `/profile/vouches`, `/profile/activity`, `/profile/preferences`, `/transactions/:id`.
- Merchant/demo: `/merchant`, `/merchant/offer`, `/merchant/report`, `/demo`, `/reset-demo`.

The internal `/recommendation/accept` route records the choice and sends Jia directly to Scan; it does not create an order.

## 13. Simulation boundary

Simulated in the current Open House prototype:

- NETS payment processing and verification events.
- QR detection and merchant participation.
- Smart Match AI/ranking.
- Merchant campaigns and reward issuance.
- Shared-offer conversion.
- Platform-fee accrual and merchant metrics.

Do not claim production NETS APIs, banking settlement, camera scanning, POS integration, real merchant billing, real campaign payouts, durable fraud controls, or production AI ranking.

## 14. Definition of done for this prototype

- Smart Match and rejection work without generating an order.
- Scan accepts the actual purchase amount and applies only the scanned merchant's credit.
- Payment success explains NETS amount and earned merchant credit before the optional Vouch step.
- One eligible transaction creates at most one optional Vouch.
- Shared claims require an eligible same-merchant payment before reward.
- Profile cleanly separates rewards, Vouches, activity, and preferences.
- No visible consumer control leads to an unavailable route.
- Simulated features and current integrity limitations are stated accurately.
- Every reward shown to a customer is described as the cash Vouch Credit the backend actually grants,
  never as an item the prototype cannot issue.
- The merchant report presents only recorded payments as live activity, labels all sample data as
  illustrative, claims no date range it cannot support, and makes no outcome claim the prototype
  collects no data for.
- With a dietary restriction active, a merchant is offered as suitable only on verified evidence
  about that outlet; otherwise the unverified state is stated and nothing is recommended.
