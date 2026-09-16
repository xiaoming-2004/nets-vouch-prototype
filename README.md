# NETS Vouch AI

A Republic Polytechnic C237-style Open House prototype built with Node.js, Express, EJS, express-session, HTML, CSS and vanilla JavaScript.

## Run locally

```bash
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000).

## Optional nearby merchant discovery

Smart Match works offline with local Open House demo merchants. To also retrieve nearby restaurants from Google Places, copy `.env.example` to `.env` and add a server-side Places API key:

```text
PLACES_API_KEY=your_key_here
```

The key is read only by `app.js` and is never sent to EJS or browser JavaScript.

## Open House journey

1. Open Jia's Home page and review her Profile Settings.
2. Accept the Felicia Smart Recommendation and review the collection order.
3. Complete the simulated NETS payment.
4. Switch to Felicia, start preparing, and mark the order ready.
5. Switch back to Jia, collect the order, and release cashback.
6. Optionally create a Payment-Verified Vouch.
7. Independently use Scan: choose a fictional merchant QR, enter an amount, optionally use cashback, and Pay. Scan credits eligible rewards immediately and offers Vouch/Skip; it never creates an order.
8. Reset the demo for the next visitor.

Smart Match rewards are released only after collection. Both journeys require at least $1 actually paid with simulated NETS to qualify for verification; rewards also depend on the merchant campaign. Profile contains transaction history and discreet merchant/reset controls.

## Tests

Run `npm test` for stateful journey, amount validation, duplicate-safety, navigation and reset tests. Run `node --check app.js` for a syntax check. Sessions are in memory and reset when the server restarts; run a single Node process for this demo.

## Prototype boundaries

- All people, merchants, payments and campaign results are fictional or illustrative.
- QR scanning, NETS payment verification, merchant handoff, fulfilment status and cashback are simulated.
- The preorder journey is collection-only; there is no delivery or POS/kitchen integration.
- There is no production NETS connection, real payout, database or authentication.
- Smart Match uses simple server-side ranking, not a production AI model. Google Places is optional for discovery; campaign participation and rewards remain internal prototype data.

See [PROTOTYPE_PLAN.md](PROTOTYPE_PLAN.md) for the canonical product direction.
