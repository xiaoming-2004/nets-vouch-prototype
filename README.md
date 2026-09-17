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

Rules determine what is possible: merchant participation, dietary preference, budget, distance, campaign availability, and eligibility. The current prototype then uses simple simulated/fallback ranking to select a merchant. A future AI service may improve relevance using accept, reject, and payment outcomes; production AI integration is not complete.

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

## Prototype boundaries

QR detection, NETS payment processing and verification, merchant participation, campaigns, Smart Match ranking, rewards, referral conversion, and platform-fee accounting are simulated for the Open House prototype. There is no production NETS API, settlement, POS, camera scanning, merchant billing, or live AI integration.
