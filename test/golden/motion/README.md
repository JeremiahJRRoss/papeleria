# A turn in moments: the reduced-motion series (A14, M4.7)

Twelve captures of one page turn in the sample comic, written by `test/browser/motion.test.ts` ("a turn, in moments") with `PAPELERIA_MOTION_SERIES=1`, for the person who inspects A14's recording. They are evidence, not an oracle: no test compares a new capture with these files. The test itself holds every run, in every engine, to one rule: under reduced motion every moment after Next already shows the new page; with motion some moment shows the turn.

## What they show

`examples/sample-comic`, built by the compiled CLI and served over loopback, opened at 390×844 on page 1 (one page shown), its fonts and the kept images loaded. Page 2 is shown once and the reader returns to page 1, and every image the book holds is decoded, before the turn is recorded: an engine may paint an image it has never painted a frame late while it decodes it, which is not motion, and is the likely reason WebKit failed the rule once in CI without this. Each capture is the book's box alone (358×615). `0-start` is taken once two captures in a row agree; Next is pressed; the moments are taken at 0, 120, 240 and 360 ms after it; `5-end` once the reader reports page 2 and two captures in a row agree.

| Moment | `reduced-*` (`prefers-reduced-motion: reduce`) | `motion-*` (`no-preference`) |
| --- | --- | --- |
| `0-start` | page 1, 42,035 bytes, SHA-256 `29bf22d3e2b09ffc…` | the same bytes |
| `1-0ms` | page 2, 33,399 bytes, SHA-256 `388a580824b50c59…` | page 1 folding over page 2, 49,025 bytes, `a91a194293c284f4…` |
| `2-120ms` | page 2, the same bytes | page 2 under the fold's shadow, 35,845 bytes, `14c131c065e6d9c6…` |
| `3-240ms` | page 2, the same bytes | page 2 with the shadow's last trace, 33,667 bytes, `06e0a8e003c52e00…` |
| `4-360ms` | page 2, the same bytes | page 2, 33,399 bytes, `388a580824b50c59…` |
| `5-end` | page 2, the same bytes | page 2, the same bytes |

Under reduced motion the first moment after Next is already byte for byte the last: the reader turns with the engine's instant path and never asks it for an animated one (D118). With motion the frames in the middle of the curl vary a little from run to run with timing; the rule asks only that one of them be neither the start nor the end.

## Where they were made

This session's container (W4, a Claude Code session for accountable maintainer JR), 2026-09-27, rewritten after the warm-up was added (the reduced series came out byte for byte the same): Chromium 141.0.7390.37 headless through Playwright 1.63.0, pixel ratio 1, light colour scheme, `animations: 'allow'` so the turn is caught as it runs. Fonts and antialiasing differ from CI's runner, so these bytes are not expected to match a capture made elsewhere.

## Making them again

From the repository root: `npm run pretest:browser`, then `PAPELERIA_BROWSERS=chromium PAPELERIA_MOTION_SERIES=1 node --test lib/browser-tests/test/browser/motion.test.js`. Only Chromium writes; the other engines run the same rule without writing. When the rule fails, in any engine, the test logs how many pixels of each capture differ from the end and leaves the captures in `test-results/motion/`, which CI keeps with a failed run's evidence.
