# NETS Vouch AI Clickable Prototype

A frontend-only React/Vite/TypeScript MVP for a proposed NETS App capability.

NETS Vouch AI proactively gives Darren one suitable participating lunch option, connects his accepted recommendation to a simulated NETS payment, lets Felicia fulfil the paid order and records an optional Payment-Verified Vouch after collection.

> NETS moves from the last tap to the first choice.

## Main demonstration

1. Choose privacy and personalisation settings.
2. Open the proactive lunch recommendation.
3. Accept Felicia’s Chicken Rice or test the one-tap rejection branch.
4. Complete the simulated full-price NETS payment.
5. Switch to Felicia and move the paid order from `Paid` to `Preparing` to `Ready`.
6. Return to Darren, collect the order and optionally Vouch.
7. Open Felicia’s Results tab to view recommendation-to-payment attribution.

The **Demo** control switches between Darren and Felicia. **Restart Demo** clears saved local progress after a second confirmation.

## Retained secondary features

- Scan-to-Pay simulation
- Profile
- Past NETS transactions
- Vouch history

The old Jia/WhatsApp referral-and-offer-claim journey is no longer part of primary navigation.

## Important simulation boundaries

This prototype does not connect to a real NETS, AI, merchant-ordering, cashback or notification API. All people, merchants, payments, orders, offers and campaign metrics are fictional or illustrative. No real money moves.

A Payment-Verified Vouch means an eligible payment was confirmed before the recommendation. It is not a guarantee of quality. Only fictional participating merchants are displayed.

## Run locally

Requirements: Node.js 22 or newer.

```bash
npm install
npm run dev
```

Open the local address shown in the terminal.

## Checks

```bash
npm run lint
npm run typecheck
npm run test
npm run build
```

## Build and deploy

```bash
npm run build
```

Deploy the generated `dist` directory to any static host. No server routes or environment variables are required for this MVP.

## Project structure

- `src/app/` — reducer, typed state, navigation and persistence
- `src/screens/` — Darren, Felicia, Scan and Profile screens
- `src/components/` — reusable phone-shell and interface components
- `src/data/` — fictional merchants, recommendations and activity data
- `src/styles/` — design tokens and responsive phone styling
- `src/test/` — reducer, persistence and clickable-flow tests
- `PROTOTYPE_PLAN.md` — product, state, privacy, funding and integration source of truth
