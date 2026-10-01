# Similarity scan, tier 1 — 2026-09-28

The first run of B7's tier 1 against the 0.1.0 release candidate (the code provenance review, `Dev_Docs/docs/CODE_PROVENANCE_REVIEW_2026-09-28.md` in the development record, Dev_Papeleria, which is not public; §5.3 and §5.6; issue 002 F5; D144). Run by W5D (`blueprint/W5D.md` there).

## The run

| Fact | Value |
| --- | --- |
| Command | `node scripts/similarity-scan.mjs`, after `npm ci` |
| Tool | `scripts/similarity-scan.mjs`, owned; no dependency added. Tokens compared exactly, comments and whitespace dropped, strings without their quotes; windows of 50 tokens hashed, then every hash match compared token by token |
| Commit | the release candidate's branch at `13ebbd5` and after; re-run on the merged tree before the candidate is final |
| Environment | Node v22.22.2, Linux x86_64 |
| Own code | 241 files, 522,975 tokens: every TypeScript, JavaScript and CSS file under `src/`, `templates/`, `scripts/`, `theme/` and `test/` that git tracks or would commit, less the licence fixtures' synthetic packages; `vendor/` is the declared third-party door |
| Corpus | 4,905 files, 8,233,726 tokens: every JavaScript, TypeScript, CSS and JSON file under `node_modules/` as `npm ci` installs the lockfile, development tools included |
| Time | about five seconds |
| Result | **10 shared regions, in two places, both dispositioned**; exit 0 |

## Regions and dispositions

The dispositions are recorded in [`similarity-dispositions.json`](similarity-dispositions.json), which the scan reads: a region without one fails the run. Each disposition names the regions it covers by their identity, which the scan prints: the first 16 hexadecimal digits of the SHA-256 of the shared tokens. The same text shared with several files of a package is one region under one identity, so the ten regions below are five identities.

| Own code | Shared with | Tokens | Disposition |
| --- | --- | --- | --- |
| `src/core/charts.ts` lines 120–128 (the en-US time locale) | `d3-time-format` 4.1.0: `locale/en-US.json`, and the same data in `src/defaultLocale.js`, `dist/d3-time-format.js` and `.min.js`; `locale/en-CA.json` and `en-GB.json` share 100 of its tokens | 112 | **Declared.** D41 copies the locale definitions of d3-format 3.1.2 and d3-time-format 4.1.0 into `charts.ts`, names them there, and a test compares them with the installed files. Licence ISC. The notice in `THIRD_PARTY.md` is issue 002 F2 (review P03) |
| `src/core/charts.ts` lines 135–143 (the es-ES time locale) | `d3-time-format` 4.1.0: `locale/es-ES.json`; `es-MX.json` shares 100 of its tokens | 112 | **Declared**, as above |
| `src/core/markdown.ts`, the last seven lines of `footnoteTail` | `markdown-it-footnote` 4.0.0: the end of `footnote_tail` in `dist/markdown-it-footnote.js` and `dist/index.cjs.js` | 54 | **Declared and attributed.** D164(e) replaced the plugin's rule with a linear one producing the same tokens, and the function's comment already said it follows the plugin's rule "step for step". The shared lines are the ones that emit the plugin's own tokens (`footnote_close`, `footnote_block_close`), which its renderer requires. The comment now also names the version and the licence, MIT, Copyright (c) 2014-2015 Vitaly Puzrin, Alex Kocharin (D144), and `THIRD_PARTY.md` §2 lists it among the material copied into Papeleria's own files, with its licence file in `licenses/packages/`. The code provenance review of 2026-09-28 did not list it; this scan found it |

d3-format's number locales, which D41 also copies, are shorter than 50 tokens and are not reported; D41 declares them all the same.

## On the merged candidate

Run again on `43c43c5`, with W5B's and W5C's code merged: 254 own files, 559,441 tokens, against the same 4,905 files and 8,233,726 tokens; the same **10 shared regions, all dispositioned**, exit 0. And on `a0f3318`, with the Codex review's fixes to the two tools and `main`'s security audit merged: 254 own files, 561,405 tokens, the same corpus, the same 10 regions under the same identities, exit 0. `charts.ts`'s regions are two lines lower, after W5B's comment on D41's copies. The identities, recorded after the Codex review of the pull request: `5d6df9b8cbc1801b` (the en-US locale, with `dist/`, `src/` and `locale/en-US.json`), `a4a29b770e81f505` (its tail, as en-CA and en-GB share it), `7053ff5fcdc18118` (es-ES), `20cfc41caa8481e4` (its tail, as es-MX shares it) and `0a348ecf7b6f20f6` (the end of `footnoteTail`). W5B's new scripts and W5C's new code and tests share no run of 50 tokens with a locked package.

## What this run does not cover

- **Renamed or re-typed copies.** Tokens are compared as written, so a copy whose identifiers were renamed, or whose JavaScript gained TypeScript types, is not found. Tier 2 and the manual procedure (review §5.4) are the backstop.
- **Code that is not installed.** The corpus is the locked packages only. **Tier 2**, a scan of `src/`, `templates/`, `theme/` and `scripts/` against the open-source corpus with a licence and copyright detector and snippet matching, needs ScanCode Toolkit and a snippet-matching service, neither of which this environment can reach. It stays owed before 0.1.0 is published (`RELEASE_STATUS.md` in the development record).

## Re-running it

`npm ci`, then `node scripts/similarity-scan.mjs`. It exits 0 when every region has a disposition and 1 naming each one that has none; `--tokens N` changes the window. It takes seconds, so `test/unit/similarity-scan.test.ts` runs it on the repository under `npm test` on every commit, which is stricter than the review's release-candidate cadence. Record a release candidate's run here or in a new dated file.
