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
- Each merchant sets its own reward amount and minimum qualifying spend, so two merchants shown by
  Smart Match may offer different amounts above different minimums.

**A reward is always a cash credit, never an item.** The prototype has no item entitlement and no
in-store item redemption: paying simply adds an amount to that merchant's Vouch Credit balance. A
merchant may choose what the credit is *towards* ("Vouch Credit towards a side dish"), and every
screen renders that wording next to the campaign's live amount, so nothing is ever presented as a
free item the backend could not honour. Custom labels are validated server-side and rejected if they
promise an item or carry their own amount.

## Payment-Verified Vouch

A Payment-Verified Vouch means the user completed an eligible simulated NETS payment at that merchant. It does not guarantee product quality, represent a NETS rating, or publicly reveal the payment amount. Vouch creation is optional and limited to one per eligible transaction.

## Smart Match

Rules determine what is possible: dietary preference, known budget and distance information, and campaign availability. With permission, browser geolocation sends current coordinates to the server for optional live discovery: Google Places API (New) is the default provider (`GOOGLE_PLACES_API_KEY`) and Foursquare Places is the automatic fallback (`FOURSQUARE_API_KEY`); `PLACES_PROVIDER` swaps the order. Discovered places receive clearly simulated demo campaigns; this does not indicate real NETS participation. When location or both providers are unavailable, the Republic Polytechnic demo location and local merchants keep Smart Match working. Distance is shown in metres, not walking time; there is no routing API. After filtering, optional server-side ranking tries Groq first (`GROQ_API_KEY`), then OpenAI `gpt-4o-mini` with whatever time remains (`OPENAI_API_KEY`), then local rule-based ranking. Invalid or unavailable AI results always fall back to the rules. This is not production AI integration.

One overall deadline covers discovery, dietary research and ranking for each request, and every
provider call is sized from the time left and cancelled at the deadline. Provider results are cached
briefly per location, search radius and query; distances are always recalculated for the current
visitor, so a cached entry never carries another person's data.

### Dietary verification

With an active dietary restriction (Halal, vegetarian or vegan), a merchant is only ever offered as
suitable when retrieved evidence about **that outlet** supports it (`TAVILY_API_KEY` for retrieval,
Groq or OpenAI for analysis). Without verification the app says so — "no verified matches",
"still checking", or "couldn't check right now" — and recommends nothing. It never presents an
unverified outlet as suitable, and evidence about a different outlet or a brand as a whole never
verifies a specific stall.

## Merchant dashboard and Business Report

The merchant views separate two kinds of figure and never add them together:

- **Live demo** figures come only from payments this prototype actually recorded since the last
  Reset Demo. With no payments recorded, the live feed and KPIs show an honest empty state.
- **Illustrative baseline** figures are fixed sample data shipped so the charts have shape during a
  demonstration. Every illustrative card is labelled as sample data and is kept out of the live
  feed and the live totals.

The hourly chart, the seven-day series and the busy-period heatmap are all illustrative: the
prototype keeps no per-hour or dated history, so they carry no date-range claim. Nothing in the
report invents a transaction — there is no browser timer adding feed rows — and the observations
section is labelled as rule-based demo heuristics, because it is a set of fixed `if`/`else`
statements reading the figures already on screen. It asserts no sales lift, return-visit or
perceived-value numbers, as the prototype collects no outcome data to support them. Success fees
shown are simulated and are never billed.

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

Optional API setup: copy `.env.example` to `.env` and fill in only what you want. Every value is
optional and `.env.example` documents each one. With no `.env` at all the prototype runs on its
curated local merchants, rule-based ranking and in-memory sessions, and the whole Open House journey
works. Keep `.env` private: it is listed in `.gitignore` and must never be committed or included in
a handover archive.

## Tests

```bash
npm test
```

This runs a browser-JavaScript syntax check and the full `node --test` suite: **383 tests, all
passing** as of this revision. The suite uses mocked providers and test-only sessions throughout and
never calls a real external API or reads credentials from `.env`.

## Prototype boundaries

QR detection, NETS payment processing and verification, merchant participation, campaigns, Smart Match fallback ranking, rewards, referral conversion, and platform-fee accounting are simulated for the Open House prototype. Optional Google Places, Foursquare Places, Groq, OpenAI and Tavily calls are real external APIs, but are not production NETS integrations. There is no production NETS API, settlement, POS, merchant billing, or production AI integration.

### Known limitations

- **No item redemption.** A reward is a cash Vouch Credit balance only. Nothing in the prototype can
  issue, track or redeem a physical item.
- **Merchant state is in process memory.** Campaigns, shared Vouch links, referral cooldowns and the
  payment feed live in the server process. They are not durable and are not shared across server
  instances; restarting the process returns them to their starting values.
- **Reset Demo is coordinated in-process.** On a single instance it resets every session. With
  Upstash configured across several instances, a reset does not reach sessions being served by
  another instance, because the reset generation is held in the resetting process.
- **Illustrative report data is not a measurement.** The hourly, weekly and heatmap charts and the
  baseline totals are fixed sample data, labelled as such.
- **No browser-automation verification.** The suite drives the app over HTTP and asserts on rendered
  markup; layout at a narrow viewport has not been confirmed in a real browser in this revision.
