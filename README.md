# NETS Vouch AI

NETS Vouch AI helps Gen Z and Millennial consumers decide where to spend, connects that decision to a verified NETS payment, and turns eligible payments into trusted social discovery.

**AI helps users decide. NETS verifies the payment. Vouch turns the verified transaction into trusted social discovery. Merchants measure campaign-linked outcomes.**

## Current experience

### Jia

1. Smart Match recommends a participating merchant and may suggest an item. The item is not an order; Jia may buy anything at that merchant.
2. Jia selects **Scan when you arrive**, visits the merchant, and scans its simulated QR.
3. Jia enters the actual purchase amount, optionally applies that merchant's Vouch Credit, and pays with simulated NETS.
4. An eligible payment earns merchant-specific Vouch Credit.
5. Jia may create one Payment-Verified Vouch and share the same offer link through WhatsApp, Telegram, or Copy Link.

Scan also works directly for a customer already at a participating merchant. There is no preorder, kitchen, preparation, fulfilment, or collection workflow.

### Shared Vouch

Jia shares a Payment-Verified Vouch → Darren claims the merchant offer → the claim gives no immediate reward → Darren pays with NETS at the same merchant → an eligible conversion releases that merchant's reward. A qualifying sender referral reward may also apply.

### Profile

Profile contains identity, merchant-specific rewards, My Vouches, NETS Activity, preferences, and notifications. Helper controls live separately at `/demo`.

## Vouch Credit

Vouch Credit is merchant-funded and merchant-specific:

- Felicia Vouch Credit is usable only at Felicia.
- Green Bowl Vouch Credit is usable only at Green Bowl.
- Credit is not a universal NETS cashback wallet.
- At least `$1.00` must remain payable through NETS for reward and Vouch eligibility.
- A normal qualifying reward is earned from the payment, not from creating a Vouch.

## Payment-Verified Vouch

A Payment-Verified Vouch means the user completed an eligible simulated NETS payment at that merchant. It does not guarantee product quality, represent a NETS rating, or publicly reveal the payment amount. Vouch creation is optional and limited to one per eligible transaction.

## Smart Match

Rules determine what is possible: dietary preference, known budget and distance information, and campaign availability. With permission, browser geolocation sends current coordinates to the server for optional Foursquare Places nearby discovery (`FOURSQUARE_API_KEY`). Discovered places receive clearly simulated demo campaigns; this does not indicate real NETS participation. When location or Foursquare is unavailable, the Republic Polytechnic demo location and local merchants keep Smart Match working. Distance is shown in metres, not walking time; there is no routing API. After filtering, optional server-side OpenAI `gpt-4o-mini` ranking uses `OPENAI_API_KEY` and brief feedback/payment outcomes. Invalid or unavailable AI results fall back to local rule-based ranking. This is not production AI integration.

## Technology

- Node.js and Express.js
- EJS
- `express-session`
- Vanilla JavaScript and CSS
- CommonJS

Consumer data is held under `req.session.demo`. Shared Vouch links are held in process memory. There is no database or production persistence.

## Run locally

```bash
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000).

Optional API setup: copy `.env.example` to `.env` and set `OPENAI_API_KEY` for ranking and/or `FOURSQUARE_API_KEY` for nearby discovery. Keep `.env` private; the demo works without either key.

## Prototype boundaries

QR detection, NETS payment processing and verification, merchant participation, campaigns, Smart Match fallback ranking, rewards, referral conversion, and platform-fee accounting are simulated for the Open House prototype. Optional OpenAI and Foursquare Places calls are real external APIs, but are not production NETS integrations. There is no production NETS API, settlement, POS, merchant billing, or production AI integration.
