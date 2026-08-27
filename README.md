# NETS Vouch prototype

Interactive front-end prototype for the NETS Vouch payment and referral journey.

**One payment creates the next.**

The demo follows Jia’s completed NETS payment, her Vouch shared through a simulated WhatsApp conversation, Darren’s optional merchant-funded offer, and his later payment that creates the next Vouch.

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

- **Consumer journey:** payment → Vouch → simulated share → offer claim → later payment → next Vouch
- **Merchant campaign:** fictional merchant-funded offer setup
- **Business logic:** illustrative payment-rate comparison and merchant rationale

Use the discreet **Demo** control inside the phone to move between areas without losing consumer progress. **Restart demo** requires confirmation and clears all in-memory state.

## Technical approach

- React, TypeScript, and Vite
- A typed `useReducer` state machine with guarded transitions
- Centralised fictional mock data
- Plain responsive CSS with reusable design tokens and components
- Vitest and React Testing Library for state and click-through coverage
- No router, state library, backend, database, authentication, or network integration

The implementation source of truth and live progress checklist are in [`PROTOTYPE_PLAN.md`](./PROTOTYPE_PLAN.md).

## Prototype limitations

All people, merchants, messages, transactions, offers, accounts, and campaign results are fictional. WhatsApp, Telegram, Messages, NETS payments, link copying, offer claiming, and redemption are simulated entirely in the browser. No money moves and no external application opens.

The offer is represented as account-linked and single-use only through temporary in-memory demo state. Refreshing the page resets the prototype.

**Illustrative published rates. Actual merchant fees vary.** The displayed rate comparison is not guaranteed merchant pricing or a promise of savings.

## Vercel readiness

This is a single-page static Vite application. Vercel can build it with `npm run build` and publish the `dist/` directory; no server routes or environment variables are required.
