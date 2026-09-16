# NETS Vouch AI Prototype Plan

Last updated: 2 September 2026

This document is the source of truth for the clickable MVP. It describes a proposed capability inside the NETS App; it does not represent a live NETS product or authorised production integration.

## 1. Problem and product objective

NETS usually appears only after a customer has already chosen what to buy and where to buy it. A student with a short lunch break may search across several services but still lack one timely, relevant and actionable option.

NETS Vouch AI moves NETS from the last tap to the first choice. It connects one proactive recommendation to a human-approved purchase, a simulated NETS payment, merchant fulfilment, measurable offer attribution and an optional Payment-Verified Vouch.

Core loop:

`NETS recommends → Darren accepts and pays → Felicia prepares → Darren collects → cashback recorded → optional Vouch`

## 2. Personas

### Darren — consumer

- 20-year-old polytechnic student with a one-hour lunch break.
- Wants one suitable participating option before leaving class.
- Cares about price, distance, dietary requirements and convenience.
- Approves or rejects every recommendation before payment.

### Felicia — participating merchant

- Publishes menu and pickup availability through a future participating merchant or ordering integration.
- Controls a capped, merchant-funded cashback campaign.
- Receives an order only after payment is confirmed.
- Controls preparation and marks the order ready.
- Measures recommendation-to-payment attribution, not proven incrementality.

All people, merchants, offers, orders and metrics in the MVP are fictional or illustrative.

1. **Payment comes first.** Vouching is offered only after the NETS payment has succeeded.
2. **Recommendation and incentive remain separate.**
   - Jia’s Vouch is the trusted recommendation.
   - Café ABC’s offer is an optional, merchant-funded conversion mechanism.
3. **Will get referrer reward.** Jia will only receive merchant rewards only if Darren successfully paid and claimed his reward.
4. **Claim now, use later.** Darren saves the offer to his simulated NETS account and redeems it only during a later eligible payment.
5. **Single-use and account-linked.** The prototype state must prevent a claimed offer from being claimed twice or a redeemed offer from being reused.
6. **No promo code.** The offer is represented as an account-linked entitlement, never as a reusable code.
7. **One payment creates the next.** Darren’s successful payment ends with a new Vouch action that loops to Vouch creation.
8. **Prototype honesty.** Simulated payment, WhatsApp, account, fee, and campaign states must be clearly presented as illustrative.
9. **Focused storytelling.** Every screen and control must support the consumer loop, merchant setup, or business rationale.
10. **Accessible interaction.** Keyboard operation, clear focus, comfortable touch targets, readable contrast, and reduced-motion support are required.

## 3. Final consumer journey

1. Darren completes first-use privacy and personalisation settings.
2. The NETS home screen proactively shows that one lunch option matches.
3. Darren sees Felicia’s Chicken Rice: $7.50, Halal, eight-minute walk, pickup availability, $0.50 cashback and 18 Payment-Verified Vouches.
4. Darren either accepts or rejects it.
5. A rejection records one reason and supplies one adjusted participating option. Rejection is free.
6. Acceptance creates pending order `#104` and opens a simulated NETS payment.
7. Darren pays the full $7.50. A separate $0.50 merchant-funded cashback is recorded after confirmation.
8. Felicia receives the paid order, prepares it and marks it ready.
9. Darren sees “Ready for collection” and confirms collection.
10. After lunch, Darren may create a one-tap Vouch or select `Not now`.
11. Either choice returns to NETS Home.

Scan-to-Pay, Profile, past transactions and Vouch history remain available as secondary features.

## 4. Final merchant journey

Felicia’s workspace has three tabs:

1. **Offer** — inspect or edit cashback, minimum spend and daily cap; publish the capped offer.
2. **Orders** — receive a paid order, start preparing and mark ready.
3. **Results** — view illustrative recommendations, acceptances, attributed payments, cashback cost, offer-to-payment conversion and cost per attributed payment.

Initial illustrative totals are 19 recommendations, 7 acceptances, 6 attributed payments and $3.00 cashback cost. Darren’s completed path updates these once to 20, 8, 7 and $3.50.

## 5. Screen and route map

The app deliberately uses reducer-driven screens rather than a routing dependency.

### Consumer screens

- `personalisation`
- `main-menu`
- `recommendation`
- `rejection`
- `consumer-payment`
- `order-status`
- `collection-ready`
- `post-meal-vouch`
- `scanner`
- `payment-review`
- `payment-success`
- `profile`
- `transaction-detail`

### Merchant screen

- `merchant`, with `setup`, `orders` and `results` tabs.

The Demo control switches between Darren and Felicia without creating separate data stores.

## 6. Shared state transitions

One reducer is the source of truth. The connected order lifecycle is:

`none → pending-payment → paid → preparing → ready → collected`

Guards enforce that:

- A displayed recommendation increments metrics only once.
- Acceptance creates a pending order only once.
- Only confirmed payment creates Felicia’s paid order and cashback.
- Only Felicia can move `paid → preparing → ready`.
- Darren cannot collect before `ready`.
- A Vouch requires an eligible payment and collected meal.
- Payment, cashback and metric updates are idempotent.

State is persisted under `nets-vouch-ai-demo:v1`. Restart Demo clears it and restores the default demonstration.

## 7. AI smart-matching inputs

The MVP simulates a smart match using:

- user-selected preferences;
- location and available time;
- price range;
- optional, explicitly consented NETS activity patterns;
- past acceptance and rejection choices;
- participating merchant menus and offers;
- merchant-supplied pickup availability;
- Payment-Verified Vouch counts.

Deterministic rules filter unsuitable options first. Mock matching then selects one candidate. No live AI model or LLM is called, and no AI-generated explanation is required to use the product.

## 8. Privacy and consent model

First use provides separate controls for:

- personalised recommendations;
- optional NETS transaction-pattern analysis;
- location while using;
- notifications.

Turning transaction analysis off enables Basic Mode, which uses manually selected preferences and participating merchant information. Transaction amounts are never exposed through a Vouch. Production use would require valid consent, minimised data processing, security review and applicable PDPA/financial-sector governance.

## 9. Merchant funding logic

- The participating merchant funds and caps the cashback.
- The default illustrative campaign is $0.50 cashback, $7 minimum spend, 11:30 AM–1:30 PM, 20 daily redemptions and $10 maximum daily cost.
- Unused rewards cost nothing.
- Cashback is recorded only after an eligible NETS payment.
- NETS does not permanently subsidise every reward.
- Card-processing fee savings are not used as the funding explanation.
- A future success-based merchant platform fee is only a proposal, not an existing NETS business model.

## 10. Payment-Verified Vouch definition

A Payment-Verified Vouch means that the user completed an eligible NETS payment at the merchant before recommending it. It does not guarantee food quality, service quality or universal customer satisfaction.

The MVP Vouch is optional, one tap, contains no amount, requires no review/photo/caption and gives no additional reward.

## 11. What is simulated

- AI smart matching and learning.
- NETS payment processing and confirmation.
- Cashback issuance and recording.
- Merchant menu and pickup availability.
- Merchant order handoff and shared order state.
- Collection notification.
- Campaign attribution and illustrative metrics.
- All merchant, menu, order and transaction data.

The UI labels simulation boundaries directly. No money is moved.

## 12. What requires real API or partner access

A production version would require authorised access to:

- eligible NETS payment events and transaction identifiers;
- participating merchant identity and outlet mapping;
- merchant menu, availability and ordering systems;
- offer rules, eligibility, redemption caps and settlement;
- cashback issuance or account crediting;
- notification delivery;
- privacy, consent, fraud and security controls.

The frontend currently uses local reducer state and local storage instead of these services.

## 13. Explicit non-goals

The MVP is not:

- a generic chatbot;
- a budgeting app;
- a queue or cooking-time predictor;
- a food-delivery product;
- a replacement for Cates or merchant ordering systems;
- an endless deals marketplace;
- a claim that every NETS merchant participates;
- a quality guarantee based on Vouches;
- proof that an attributed payment was incremental.

## 14. Testing

Automated tests cover:

- consented personalisation and Basic Mode;
- proactive and adjusted recommendations;
- full-price payment plus separate cashback;
- paid-order visibility and shared preparation/readiness;
- collection and Vouch guards;
- exact-once campaign metric updates;
- campaign editing and publishing;
- versioned local-storage hydration/fallback/reset;
- retained Scan-to-Pay, Profile and transaction history;
- keyboard-operable settings and accessible dialog dismissal.

Required checks:

```bash
npm run lint
npm run typecheck
npm run test
npm run build
```

## Completed implementation

- Connected Darren/Felicia reducer and versioned persistence.
- Privacy setup and Basic Mode.
- Proactive recommendation and rejection learning.
- Full-price simulated NETS payment and separate cashback.
- Shared merchant order preparation and collection status.
- Optional post-meal Payment-Verified Vouch.
- Merchant offer controls and attributed campaign dashboard.
- Retained Scan-to-Pay, Profile, transaction history and Vouch history.
- Responsive iPhone shell, focus movement, keyboard controls, loading/success/disabled feedback.
- Revised automated tests and documentation.
