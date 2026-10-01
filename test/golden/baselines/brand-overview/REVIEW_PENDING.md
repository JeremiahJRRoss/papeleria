# Brand-overview screenshot baselines: pending the design maintainer's review

**Status: pending-human.** These fourteen captures were made by the W2B session (a Claude Code session for accountable maintainer JR) and nobody has reviewed them yet. `test/browser/golden/brand-overview.visual.test.ts` compares every new build with them, so it catches a change from what is here; it does not prove that what is here is right. Until the design maintainer has reviewed them, A4's visual part stays `pending-human` (D70, `docs/ACCEPTANCE_MATRIX.md`: "Screenshot baselines must be reviewed by the design maintainer before becoming the oracle").

## What they are

The built deck, not the reference: `examples/brand-overview`, built by the compiled CLI, opened from disk and captured slide by slide once its fonts had loaded.

| Slide | Layout | 1280×800 | 390×844 |
| --- | --- | --- | --- |
| 1 | cover | `1280x800/01-cover.png`, 32,171 bytes, SHA-256 `d4aea9b92af53a13…` | `390x844/01-cover.png`, 24,104 bytes, SHA-256 `51b70d7ff43ef1be…` |
| 9 | three | `1280x800/09-columns.png`, 41,135 bytes, SHA-256 `d9825f5df9781f20…` | `390x844/09-columns.png`, 38,860 bytes, SHA-256 `48fff2c5073e59bc…` |
| 5 | attributes | `1280x800/05-attributes.png`, 40,971 bytes, SHA-256 `00962fc51fd95336…` | `390x844/05-attributes.png`, 41,367 bytes, SHA-256 `8db4d69a4a007309…` |
| 6 | palette | `1280x800/06-palette.png`, 40,098 bytes, SHA-256 `95f26c3b529a9a7b…` | `390x844/06-palette.png`, 39,026 bytes, SHA-256 `77bcc6e8429227b3…` |
| 7 | type | `1280x800/07-type.png`, 56,826 bytes, SHA-256 `fe741fedea0b4193…` | `390x844/07-type.png`, 48,299 bytes, SHA-256 `70107cc515a57eea…` |
| 8 | wordmark | `1280x800/08-wordmark.png`, 46,817 bytes, SHA-256 `3d82232832411d5b…` | `390x844/08-wordmark.png`, 36,393 bytes, SHA-256 `cd6de8410d1448e7…` |
| 16 | closing | `1280x800/16-closing.png`, 34,866 bytes, SHA-256 `a5c931e6274c5856…` | `390x844/16-closing.png`, 25,139 bytes, SHA-256 `b6aa9bf14cd7750b…` |

## Where they were made

- **Run:** CI run 36066417849 in the development record's CI, job 107857110819 (`browser`), push of commit `5c1f796` on `claude/relaxed-bell-togmtx`, 2026-09-24. The visual test found no baseline, failed as designed, and printed the fourteen captures into the job log; `test/golden/extract-captures.mjs` checked each one's length and SHA-256 against the log and wrote it here. The product has not changed since that commit: later commits change tests and records only.
- **Platform:** Chromium 153.0.8010.12, Playwright 1.63.0's own build, headless, on GitHub's `ubuntu-latest` runner (Ubuntu 24.04), with the system libraries and fonts `npx playwright install --with-deps` installs.
- **Settings:** each slide's `article` captured alone, in a fresh page at pixel ratio 1, light colour scheme, reduced motion, `en-US`, UTC, JavaScript on (the enhanced deck, one slide shown), once `document.fonts` reported Poppins 600 and Inter loaded and nothing had focus; animations disabled and the caret hidden. Nothing is masked.
- **Why CI and not this session's container:** captures from the container's Chromium 141 differ from these in 2.5 to 7 percent of their pixels, and the 390 px wordmark slide wraps its title onto one more line, so a baseline made there could not be CI's oracle (D70).

`platform.json` binds them to that platform: under CI any other engine version or OS release fails the comparison, and elsewhere it is reported as skipped. A capture may differ from its baseline in at most one pixel in a thousand by more than 8 levels in any channel, and in at most 32 pixels by more than 64.

## How to review

1. Open `reference/decks/brand-overview.html` in Chromium from disk at 1280×800 and at 390×844, address `#slide-N` for each slide above, and compare it with the baseline of the same slide and width.
2. Expect these deliberate differences, each recorded in `docs/REFERENCE_COMPATIBILITY.md`, and nothing else:
   - every footer carries the piece's status label, "Review edition / approval pending", between the footer text and the counter (D61);
   - on the attributes slide each label stands on a line of its own above its text, where the kit ran the two together (D69);
   - at 390 px the footer text and the status label wrap between words while the counter stays whole, where the kit's two-part footer fitted on one line (D73).
3. Check what a DOM comparison cannot: the type (titles in Poppins 600, reading text in Inter, the mono sample in the system monospace face, which comes from the CI runner), the colours and swatches, the dark plates and the horizon lines, spacing, the wordmark samples, and the phone layout.

## How to record the outcome

- **Approved:** replace this file with `REVIEWED.md` naming the reviewer, the date, the commit reviewed and a verdict per capture, and change A4's visual part to `automated-pass` in that session's blueprint.
- **Not approved:** a capture that is wrong is a defect in the product, not in the baseline. Fix the product; then make new baselines as below and review them in turn.

## How to make new baselines

Never regenerate a baseline to make a failing comparison pass without review.

1. Delete the PNGs to replace (and `platform.json` too when the platform changes), and push.
2. The visual test fails, writes each capture without a baseline to `test-results/brand-overview-visual/` (CI keeps that folder as the `brand-overview-visual` artifact) and prints it into the job log between `PAPELERIA-CAPTURE` markers.
3. Save the job log and run `node test/golden/extract-captures.mjs <saved log> test/golden/baselines/brand-overview`, which checks each capture's length and SHA-256 before writing it; or take the files from the artifact.
4. Review them as above and commit them with this file.
