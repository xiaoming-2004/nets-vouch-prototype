# NETS Vouch prototype

Interactive front-end prototype for the NETS Vouch payment and referral journey.

**One payment creates the next.**

The demo starts from Jia’s NETS-style Main Menu. She scans a fictional QR, reviews and completes a simulated payment, optionally creates a Vouch, and can then continue into Darren’s recipient journey, optional merchant-funded offer, and later payment that creates the next Vouch.

## Run locally

Requirements:

- Node.js 22 or newer
- npm

Install and start the development server:

```bash
npm install
npm run dev
```

Open the local URL printed by Vite. The prototype appears in a centred iPhone-style frame on desktop and fills smaller mobile screens.

## Verify the project

```bash
npm run lint
npm run typecheck
npm run test
npm run build
npm run preview
```

The production-ready static files are generated in `dist/`.

## Demo areas

- **Main journey:** Home → Scan to Pay → payment review → payment success → optional Vouch → Home
- **Profile:** Jia’s fictional Past Transactions and My Vouches, including a fallback Vouch action from eligible transaction details
- **Optional Darren journey:** choose **Continue demo as Darren** after Jia shares a Café ABC Vouch, then claim and later redeem the merchant-funded offer
- **Saved Offers:** Darren’s claimed merchant offers, kept separate from Jia’s My Vouches
- **Merchant campaign:** fictional merchant-funded offer setup
- **Business logic:** illustrative payment-rate comparison and merchant rationale

Use the Home/Scan/Profile navigation for Jia’s main tasks. The discreet **Demo** control moves between consumer, merchant, and business areas without losing current records. **Restart demo** requires confirmation and restores the original fictional transactions, Vouches, offer, campaign, and navigation state.

### Suggested click-through

1. Choose **Scan to Pay** on Home.
2. Tap the fictional QR; no camera permission is requested.
3. Review Café ABC and choose **Pay $8.50**.
4. Choose **Vouch this place**, select a tag, and pick a simulated share option.
5. Choose **Done** to return Home, or **Continue demo as Darren** for the recipient and offer-redemption branch.
6. Open **Profile** to inspect the new payment in Past Transactions and the new recommendation in My Vouches.

## Technical approach

- React, TypeScript, and Vite
- A typed `useReducer` state machine with guarded transitions
- Centralised fictional mock data
- Plain responsive CSS with reusable design tokens and components
- Vitest and React Testing Library for state and click-through coverage
- No router, state library, backend, database, authentication, or network integration

The implementation source of truth and live progress checklist are in [`PROTOTYPE_PLAN.md`](./PROTOTYPE_PLAN.md).

## Prototype limitations

All people, merchants, messages, transactions, QR visuals, offers, accounts, and campaign results are fictional. QR scanning, WhatsApp, Telegram, Messages, NETS payments, link copying, offer claiming, and redemption are simulated entirely in the browser. The prototype does not access a camera, request bank details, move money, or open an external application.

The offer is represented as account-linked and single-use only through temporary in-memory demo state. Refreshing the page resets the prototype.

**Illustrative published rates. Actual merchant fees vary.** The displayed rate comparison is not guaranteed merchant pricing or a promise of savings.

## Vercel readiness

This is a single-page static Vite application. Vercel can build it with `npm run build` and publish the `dist/` directory; no server routes or environment variables are required.
