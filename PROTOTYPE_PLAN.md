# NETS Vouch AI — Open House Prototype Plan

This is the canonical product and implementation plan for the Republic Polytechnic Open House prototype.

## Product objective

Demonstrate the main understandable journey:

**MATCH → ACCEPT → PAY WITH NETS → MERCHANT FULFILS → COLLECT → VERIFY**

The prototype is a C237-style Node.js, Express, EJS and `express-session` application. It simulates a simple collection order, not a full restaurant, kitchen, delivery or POS application.

## Pitch alignment

- **Proactive Smart Match:** Jia receives one relevant participating merchant offer without starting a chatbot conversation.
- **Adaptive Learning:** acceptance, rejection, reason, scan, claim and payment outcomes are recorded as future learning signals.
- **Measurable Promotions:** Felicia sees an aggregated attribution path from recommendation to eligible simulated NETS payment.
- **Rules, AI, user:** rules decide what is possible, simulated Smart Match decides what is relevant, and Jia makes the final decision.

## Primary Open House journey

1. Jia opens directly to Home; recommendation preferences are already enabled.
2. Smart Match uses Jia's Profile Settings to recommend Felicia's participating offer.
3. Jia accepts or rejects it and may receive the Chicken Porridge alternative.
4. Jia visits Felicia and simulates scanning the merchant campaign QR.
5. The server verifies the merchant, campaign, timing and daily cap.
6. Jia claims a temporary, single-use promotional Vouch.
7. Jia completes a simulated NETS payment.
8. The server verifies the session, merchant, claim, payment amount and campaign.
9. Eligible payment unlocks the reward exactly once.
10. Jia may create a Payment-Verified Vouch.
11. Felicia sees the attributed result in aggregated campaign analytics.
12. A student helper resets the demo.

## Implemented foundation retained

- CommonJS Express/EJS application and session state.
- Jia Profile Settings for dietary preference, budget, walking distance and notifications.
- Home page, Smart Recommendation and matching explanation.
- Four validated rejection reasons and Chicken Porridge alternative.
- Seeded Toast & Co. and Hawker 88 transactions.
- Profile, transaction details, responsive NETS-inspired UI and reset control.
- `getSmartRecommendation()` as the future AI boundary.

## Consumer functionality

### Profile Settings

Jia opens directly to Home. Recommendation preferences are managed under Profile using dietary preference, budget, maximum walking distance and notifications. The Open House prototype does not show Basic Mode, Personalised Mode or startup privacy configuration.

### Recommendation and feedback

The recommendation shows merchant, item, estimated price, dietary information, optional distance, campaign reward, Payment-Verified Vouch count and a matching reason. Rejection reasons are Too far, Costs too much, Not in the mood and Ate this recently.

### Merchant QR and campaign claim

The simulated QR identifies Felicia and campaign `felicia-lunch-vouch`; it does not verify payment. A valid scan checks campaign status, current time, daily cap and previous redemption. A claim lasts ten minutes, is bound to Jia's session and is single-use.

Availability states are Vouch Available, Vouch Currently Unavailable, Campaign Ended, Fully Redeemed Today and Already Redeemed.

### Simulated payment and reward

Chicken Rice costs $7.50 and Chicken Porridge costs $6.90. The fixed system requirement is an eligible simulated NETS payment of at least $1.00. There is no merchant-configurable minimum spend. Both recommendations may qualify.

Eligible payment must match the Jia session, Felicia, campaign and unused claim, and occur while the claim and campaign remain valid. A successful eligible payment creates one transaction, one promotional redemption, one reward and one set of metrics. Repeated POST requests must not duplicate them.

### Vouches and transactions

My Vouches separates redeemed promotional Vouches from optional Payment-Verified Vouches. Public Payment-Verified Vouches contain user, merchant, transaction identifier, date and simulated verification status, but no payment amount. Transaction history combines seeded and new simulated records.

## Merchant functionality

Felicia has only two tabs:

- **Campaign:** reward amount, start/end time, daily cap, active status, availability, redemptions remaining and campaign QR identifier.
- **Results:** recommendations shown/accepted, QR scans, claims, eligible payments, attributed value, reward cost and recommendation-to-payment conversion.

Seeded metrics are labelled **Illustrative Prototype Data**. Merchant results are aggregated and never reveal Jia's private settings or individual spending history.

## Session model

`req.session.demo` contains simple objects and arrays:

- `user`, `profile`
- selected, accepted and rejected recommendation identifiers
- rejection reason and metric flags
- `campaign`, `qrScan`, `activeClaim`
- `promotionalRedemptions`, `transactions`, `latestPayment`
- `currentOrder` with order number, item, amount, fulfilment status, payment and collection flags
- `paymentVerifiedVouches`, `metrics`
- simple scan, claim, transaction and Vouch counters

There is no `currentOrder`, order number, kitchen status or collection state.

## Routes

- Home: `GET /home`
- Profile settings: `GET/POST /profile`
- Recommendation: `GET /recommendation`, `GET/POST /recommendation/reject`, `POST /recommendation/accept`
- QR and claim: `GET/POST /scan`, `GET/POST /claim`
- Payment: `GET/POST /payment`, `GET /payment-success`
- Vouch: `GET/POST /vouch`
- Profile: `GET /profile`, `GET /transactions/:id`
- Merchant: `GET /merchant`, `POST /merchant/offer`
- Preorder: `GET /order`, `POST /merchant/start-preparing`, `POST /merchant/mark-ready`, `POST /collection`
- Reset: `POST /reset-demo`

## Privacy and integrity

- The prototype does not claim production access to transaction history or personalisation APIs.
- Do not claim bank-statement access, production consent or real NETS APIs.
- Do not expose public spending history or individual spending to merchants.
- Do not publish payment amounts on Payment-Verified Vouches.
- Merchant results remain aggregated.
- QR identifies the campaign but does not prove payment.
- Only an eligible simulated payment unlocks a reward.
- A Payment-Verified Vouch proves a simulated eligible transaction occurred, not product quality.
- Jia approves the recommendation, claim and payment.

## Simulated versus future capability

Smart Match, QR scanning, NETS payment, verification, cashback, transaction history and campaign analytics are simulated. Future production work may add NETS APIs, real settlement, merchant onboarding, authentication, persistent storage, consent management, notifications and an AI ranking API.

The future AI integration point remains `getSmartRecommendation(profile, feedback, eligibleCampaigns)`. Backend rules must filter dietary, budget, distance and campaign conflicts before any future AI ranks offers.

## Agile delivery record

1. **Campaign, timing and cap:** replace order management with campaign controls and availability states. No fulfilment or merchant minimum-spend configuration.
2. **QR verification:** connect accepted recommendation to Felicia's simulated QR. No camera or payment proof from QR.
3. **Promotional claim:** create a ten-minute, single-use claim. No reward before payment.
4. **Payment verification:** match a simulated NETS payment to the active claim using the fixed $1.00 rule. No production NETS API.
5. **Reward record:** award and attribute cashback exactly once. No real settlement.
6. **Merchant fulfilment:** simulate paid order handoff, preparation, readiness and collection. No delivery, inventory or POS integration.
7. **Payment-Verified Vouch:** support Create or Skip and separate My Vouches lists. No ratings or public amount.
8. **Merchant analytics:** display aggregated attribution and illustrative metrics. No item-level receipt or individual consumer analytics.
9. **Open House polish:** reset all state, complete navigation, direct-route guards, responsive UI and clear simulation labels. No authentication or database.

## Acceptance and test checklist

- Complete Chicken Rice and rejected-to-Chicken-Porridge journeys.
- Verify direct-to-Home startup and saved Profile Settings for every dietary option.
- Verify invalid rejection reasons and QR identifiers are rejected.
- Verify inactive, early, ended and capped campaigns cannot create claims.
- Verify direct claim, payment, success and Vouch URLs are guarded.
- Verify invalid fulfilment transitions, duplicate payment, duplicate collection and duplicate cashback are ignored.
- Verify expired and reused claims cannot earn rewards.
- Verify repeated scan, claim, payment and Vouch POST requests are idempotent.
- Verify transaction, My Vouches and Felicia metrics update once.
- Verify reset restores defaults, seeds and counters.
- Verify every visible control has a working route.

## Out of scope

Delivery, live queue/inventory, kitchen integration, detailed POS handoff, item-level receipt management, real camera scanning, real NETS verification, real cashback payout, real partnerships, production transaction access, production AI, authentication, database, React, TypeScript, Vite, Prisma, Firebase, Supabase, SQL and layered enterprise architecture.

## Definition of Done

The prototype is ready when both the preorder and QR-to-payment journeys work, rewards and Vouches are protected from duplication, Felicia sees aggregated attributed results, Reset Demo restores the initial state, invalid states are safe, simulation labels are accurate, no visible control is broken, and a student helper can run the full demonstration without editing code.
