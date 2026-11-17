# Task 8: clean mobile-first UI and brand-safe presentation

Implemented on 17 November 2026. Presentation only: Groq interpretation, grounded menu matching, dietary rules, ranking, activity, rejection learning, Google route calculation, coordinate privacy, feedback tokens, payment and Vouch mechanics and the database are unchanged.

## Branding

The app presents itself as **VouchAI** with the label **Student prototype**, using a neutral text and inline-SVG mark (`views/partials/brand-mark.ejs`, favicon in `views/partials/brand-icon.ejs`). No NETS logo, wordmark or derivative is served or rendered, and `public/images/nets-vouch-ai-logo.jpg` was removed from the application (the poster may keep using the approved NETS logo; a copy of that file was kept outside the repository before removal and the file also remains in Git history).

Every page footer shows exactly: "Student prototype for demonstration. Not an official NETS application." The plain word NETS may appear only inside that sentence. Payment wording is "Pay (simulated)", "Processing simulated payment…", "Paid (simulated payment)", "Simulated payment · Successful"; merchant wording is "Platform success fee (illustrative)" and "Amount paid through the prototype". Internal values (`paymentMethod`, `netsPaid`, repository and database names) are not renamed. `tests/task8-branding.test.js` separates the approved disclaimer from prohibited branding.

## Layout

Large screens (at least 700 px wide **and** 700 px tall) show one centred iPhone-style frame around a 390 px-wide screen (black bezel, dynamic island, side buttons, decorative status bar and home indicator, all `aria-hidden`). Content scrolls inside the screen and the bottom navigation stays inside it. On real phones, narrow windows and high zoom (for example 200% on a laptop) the frame and every decoration are removed: the app uses the real viewport (maximum 560 px wide when frameless), normal page scrolling, a sticky header, a fixed bottom navigation and safe-area padding. Recommendation cards are always one per row.

Home: greeting, one starting-point pill (expands; privacy text in "About starting points and privacy"), then "Your smart match" with an Edit match button, the result card, and "Edit filters" (date and time, budget, walking distance) with summary chips. The matching sheet is a **modal dialog** (opens automatically on a first visit, or from Find food / Edit match): solid red selected chips, a 3x2 food grid and 2x2 dietary grid, one Find my match button. Focus is trapped, the rest of the app is inert while it is open, Escape or the backdrop closes it and focus returns to its opener. Task 7 untouched-default versus actively-selected chip behaviour and all request payloads are unchanged.

Collapsed cards show merchant, "Fictional sample merchant", recommended item and price, a walking route panel (live) or an "RP demo distance" panel, dietary badges, one activity sentence, a light-red reward panel, Choose this, Not for me, then "Why this match?". Google Maps attribution and the walking warning stay in the visible route panel. There is no merchant map. Error and empty states are friendly cards with one explanation and one recovery action; stable codes stay internal.

## Accessibility

Skip link, landmarks, fieldset/legend chip groups, `aria-pressed`, `aria-expanded`, `aria-busy` and status regions, visible focus, a check mark (not colour alone) on selected chips, 44 px targets, reduced motion, 16 px inputs, reflow down to 320 px.
