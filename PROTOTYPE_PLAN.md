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

### Required before multi-user or production use

The current prototype does **not** yet implement these controls:

- Globally shared merchant campaign state across browser sessions.
- A maximum merchant reward-budget amount per day.
- A configurable merchant minimum purchase amount separate from the `$1.00` NETS-paid requirement.
- Sender/recipient/merchant referral cooldowns.
- Shared-offer claim expiry.
- Durable cross-process duplicate and reward-farming protection.

Campaigns currently live under each `req.session.demo`; therefore caps and metrics are per demo session, not truly global. Shared offers live only in one in-process `Map`. These limits must not be described as production abuse prevention.

The current metrics implementation also increments attributed-payment totals for every reward-eligible payment, including direct Scan. It must be split by `SMART_MATCH`, `SHARED_VOUCH`, and `DIRECT_SCAN` before merchant attribution is presented as commercially reliable.

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

- Shared Vouch offer links connecting sender and recipient sessions.

There is no database, authentication, durable campaign store, production consent system, or multi-instance persistence.

## 12. Main routes

- Home and Smart Match: `/home`, `/smart-match/result`, `/recommendation/reject`, `/recommendation/accept`.
- Scan and payment: `/scan`, `/scan/payment`, `/payment-success/:id`.
- Vouch and sharing: `/vouch/:id`, `/vouch/:id/success`, `/offers/:token`.
- Profile: `/profile`, `/profile/rewards`, `/profile/vouches`, `/profile/activity`, `/profile/preferences`, `/transactions/:id`.
- Merchant/demo: `/merchant`, `/merchant/offer`, `/demo`, `/reset-demo`.

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
