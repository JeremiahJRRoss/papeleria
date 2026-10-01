# Local patches to the vendored page-turn engine

`page-flip.browser.js` is byte-identical to `package/dist/js/page-flip.browser.js` in the npm tarball `page-flip@2.0.7`, which was published from the pinned StPageFlip commit (`VERSION`, docs/DECISIONS.md D100). What the engine does that Papeleria must not rely on is handled in Papeleria's own code, `templates/comic/client/engine-adapter.ts` (D103), not by changing the engine.

## When a patch is needed

A change to the engine's bytes is made only when the adapter cannot do the job, and only by adding an entry below and teaching `scripts/vendor-page-flip.mjs` to apply it after the upstream bytes are verified. The entry and the script change land in the same commit as a decision row, and `VERSION` then records the patched file's SHA-256 beside the upstream one. Nobody edits `page-flip.browser.js` by hand.

Each entry has:

- **ID and title**: `P001`, `P002` and so on, never reused.
- **Date, author and decision**: when, who, and the row in docs/DECISIONS.md that approves it.
- **Why**: the behaviour, how it was observed, and why the adapter cannot handle it.
- **Change**: the exact text replaced and the text that replaces it, with the number of places it applies; the script refuses to patch if the count differs.
- **Hashes**: the file's SHA-256 before and after.
- **Upstream**: whether the problem was reported upstream, with a link.
- **Test**: the test that fails without the patch.

## Patches

None.
