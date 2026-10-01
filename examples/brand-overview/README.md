The kit's sixteen-slide brand overview deck, rebuilt from files as a Papeleria deck piece: `papeleria.yaml` holds the slides and `assets/text/` the speaker notes.
It is the input to the A4 golden test (M1.9); `npm run check:brand-overview-content` compares its text with the baseline until the built deck can be compared in a browser.
The baseline is `reference/decks/brand-overview.html`, which is never edited; deliberate differences are recorded in `docs/REFERENCE_COMPATIBILITY.md`.
