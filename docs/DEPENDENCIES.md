# Dependency baseline and feasibility gates

Date: 2026-09-22. Working choices under D02/D11/D12/D18. This is an input to M0, not an installed lockfile or a completed dependency/security/license audit. Package ranges below are deliberately bounded starting ranges, not a claim that these are the newest releases.

## Installation and scope

Use Node **22.x**, TypeScript ESM and npm. Record the exact supported Node/npm patch, platform and package-lock.json in M0; use npm ci thereafter. Do not substitute an unspecified “LTS or later”. Before public release, recheck Node support/security updates and record the tested patch.

“Author runtime” means a production dependency of the CLI: npm install --omit=dev must still build/check/edit pieces. It does not mean code is copied into a published piece. Build/dev tools below are needed to develop/package Papeleria, not to run the installed CLI.

| Package / starting range | Purpose | Scope | Upstream license declaration |
| --- | --- | --- | --- |
| yaml ^2 | YAML AST, source positions | Author runtime | ISC |
| ajv ^8; ajv-formats ^3 | JSON Schema 2020-12 and formats | Author runtime | MIT |
| markdown-it ^15; markdown-it-footnote ^4 | Markdown with HTML disabled | Author runtime | MIT |
| d3-scale ^4.0.2 | Scales | Author runtime | ISC |
| d3-shape ^3.2.0 | Line/bar geometry support | Author runtime | ISC |
| d3-array ^3.2.4 | Domains, ticks and grouping | Author runtime | ISC |
| d3-format ^3.1.0 | Numeric labels | Author runtime | ISC |
| d3-time-format ^4.1.0 | Date labels | Author runtime | ISC |
| d3-dsv ^3.0.1 | csvParseRows; use no eval-based object parser | Author runtime | ISC |
| saxes ^6.0.0 | Bounded XML parsing for the SVG allowlist | Author runtime | ISC |
| music-metadata ^11.16.1 | `parseBuffer` duration for local MP4/WebM read through `FileAccess` (D158), including silent clips | Author runtime | MIT |
| sharp ^0.35 | Required WebP, optional AVIF transforms | Author runtime | Apache-2.0; bundled libvips LGPL-3.0-or-later exception |
| html-validate ^11 | R08 during installed CLI build/check | **Author runtime**, not dev-only | MIT |
| codemirror ^6; @codemirror/lang-yaml ^6; @codemirror/lang-json ^6; codemirror-json-schema ^0.8.1 | YAML/JSON editor support | Editor bundle build inputs, held in `dependencies` under D22, confirmed at M5.3 (D128). codemirror-json-schema is bundle-only under D25 | MIT |
| @codemirror/state, view, language, commands, autocomplete, lint ^6; @lezer/common, highlight ^1 | Explicit direct editor imports/peers as used | Same editor scope | MIT |
| esbuild ^0.28 | Prebundle editor/deck/comic scripts | Dev | MIT |
| typescript ^5; @types/node ^22 | Strict compilation | Dev | Apache-2.0; MIT |
| @types/markdown-it-footnote ^3; @types/d3-scale ^4; @types/d3-shape ^3; @types/d3-array ^3; @types/d3-format ^3; @types/d3-time-format ^4; @types/d3-dsv ^3 | Types for libraries without declarations. @types/markdown-it is not installed: markdown-it 15 ships its own declarations (D19) | Dev | MIT |
| playwright ^1 | Browser and PDF checks; browser binaries are not downloaded before M2 (D23) | Dev | Apache-2.0 |
| StPageFlip 2.0.7 | Page-turn adapter | Vendored published runtime | MIT |
| Eight Poppins/Inter WOFF2 files | Self-hosted type | Published resource | OFL-1.1; license texts in theme/fonts |

No UI/template/web framework, jsdom, CDN, WebSocket library, telemetry or external ffmpeg is selected. Node’s APIs provide server, filesystem and test runner. Strict JSON syntax/duplicate-key scanning and CSV position tracking are small owned modules with fixtures, not additional unnamed dependencies.

The CodeMirror schema extension supplies completion/hover. Its schema validation must not replace the authoritative Ajv/semantic report; test the shared schema’s references and reject duplicate competing diagnostics. M0 resolves compatible peer packages without force/legacy-peer-deps workarounds; record intentional range changes here and in DECISIONS.

## Locked install, 2026-09-22 (DEP01)

Recorded by session W0 at M0.1. `npm ci` is the repeatable install from here on; `npm install` is only for a deliberate, recorded range change.

| Fact | Value |
| --- | --- |
| Node | v22.22.2 |
| npm | 10.9.7 |
| Platform | Linux 6.18.44 x86_64, glibc |
| package-lock.json SHA-256 | `3c0a5761039c7839fee05ce4cda88e7f2c337eb58bebb67b604e7e305a045bb3` |
| lockfileVersion | 3 |
| Packages installed by `npm ci` | 179 |
| Peer resolution | Clean; no `--force` and no `--legacy-peer-deps` |

Resolved versions of the named baseline packages: yaml 2.9.1, ajv 8.20.0, ajv-formats 3.0.1, markdown-it 15.0.2, markdown-it-footnote 4.0.0, d3-array 3.2.4, d3-dsv 3.0.1, d3-format 3.1.2, d3-scale 4.0.2, d3-shape 3.2.0, d3-time-format 4.1.0, saxes 6.0.0, music-metadata 11.15.0, sharp 0.35.4, html-validate 11.16.0, codemirror 6.0.2, codemirror-json-schema 0.8.1, @codemirror/lang-json 6.0.2, @codemirror/lang-yaml 6.1.3, esbuild 0.28.2, typescript 5.9.3, @types/node 22.20.4, playwright 1.63.0.

Amended 2026-09-29 by Dependabot's pull request #38, merged with its licence records regenerated (the PRR review's proposed fix for O4): music-metadata 11.16.1, the baseline row now `^11.16.1`, which carries the fixes for the three published advisories that named 11.15.0 (GHSA-5gfj-9q3v-qfp3, GHSA-qc8q-pw95-mq6c, GHSA-f94x-6692-553q); @lezer/common 1.5.3 and @lezer/highlight 1.2.4. `THIRD_PARTY.md`, `licenses/index.json`, `licenses/packages/` and `docs/evidence/license-inventory.json` were regenerated by `scripts/license-inventory.mjs` and `scripts/gen-notice.mjs`, and `MANIFEST.sha256` last (D141). Every other resolved version above is unchanged.

The CI runner resolves its own Node 22 patch through `setup-node`; the release session records the exact tested patch per D02. This entry is the M0 install record, not the release inventory that DEP06 owed; that is recorded below, 2026-09-28.

## Media gate, 2026-09-23 (DEP03)

Recorded by session W1B at M1.4 on the locked install above (sharp 0.35.4, libvips 8.18.6, libwebp 1.6.0, libaom 3.15.0, libheif 1.23.2; linux-x64 glibc). All five experiments pass as automated tests in `test/unit/images-cache.test.ts`: WebP success; the AVIF-present path (the prebuilt linux-x64 libvips includes the AV1 encoder); a simulated AVIF-unavailable path, which degrades to WebP with one warning and probes the encoder once per process; cache invalidation per changed setting, library version, SIMD switch and thread count; and a missing or broken sharp, which is a hard `E_SHARP_UNAVAILABLE` failure with no fallback. Cold and warm builds write byte-identical files.

One finding changes how the cache must work. AVIF output depends on the libvips thread count while WebP output does not, and sharp defaults to one thread on glibc Linux and to the CPU count elsewhere. The thread count is therefore part of the AVIF cache key (D43). Details, measurements and the remaining open items are in `blueprint/W1B.md` in the development record, Dev_Papeleria, which is not public. The gate still has to be re-run on the Windows and macOS runners when the A10 matrix exists.

## Video gate, 2026-09-26 (DEP04)

Recorded by session W3B at M3.4 on the locked install (music-metadata 11.15.0, Node v22.22.2, Linux x86_64). Every file was written byte by byte by `test/fixtures/video/generate.ts` (provenance: its README and D93; containers exact, frames placeholders, no encoder), read with `parseBuffer(bytes, undefined, {duration: true, skipCovers: true})` and then by Papeleria's reader, `probeVideo` (D92). `test/unit/video.test.ts` asserts each outcome and prints this table's two right-hand columns on every run.

| File | music-metadata 11.15.0 | `probeVideo` |
| --- | --- | --- |
| MP4 (`isom`, one `avc1` track, no audio): 1 s, 14.999 s, 15.000 s, 12 s with `mvhd` version 1, 15 s at a 90,000 Hz timescale; `moov` after `mdat`, a 64-bit `mdat` size, `mdat` to the end of the file (3 s each) | Container `isom/iso2/avc1/mp41`, the `avc1` track, **no duration** | Passes, with the movie header's duration |
| The same MP4 at 15.001 s and 16 s | No duration | `too_long` |
| The same MP4 with a zero duration; all ones ("unknown") in versions 0 and 1; timescale 0; no `mvhd` | No duration | `zero_duration`; `unknown_duration` (four cases) |
| MP4 with an AAC track, 5 s; the same with the audio 20 s long | Duration 5; 20 | Passes, 5 s; `too_long` (the longer of the two lengths) |
| M4A (audio only) | Duration 1, no video track | `no_video_track` |
| QuickTime (`qt`); 3GPP (`3gp4`) | Container `qt`; throws `UnsupportedFileTypeError` (video/3gpp) | `unsupported_container` |
| MP4 cut off inside `moov` | Throws `EndOfStreamError` | `unreadable` |
| WebM (`V_VP8`, no audio): 1 s, 15.000 s, 15 s at a 1 µs `TimecodeScale`; with an Opus track, 1 s | Container `EBML/webm`, duration 1, 15, 15, 1 | Passes |
| WebM at 15.001 s and 16 s | Duration 15.001, 16 | `too_long` |
| WebM with a zero and a negative `Duration`; none; NaN; +∞ | 0, −0.005; none; NaN; Infinity | `zero_duration` (two); `unknown_duration`; `non_finite_duration` (two) |
| WebM, audio only | Duration 1, no video track | `no_video_track` |
| Matroska (`DocType matroska`) | Container `EBML/matroska` | `unsupported_container` |
| WebM cut off in its header; 4,096 bytes of no format; an empty file; a PNG | Throws `CouldNotDetermineFileTypeError` (three); `UnsupportedFileTypeError` (image/png) | `unsupported_container` |

**Result: DEP04 passes with D92.** WebM passes as specified, through music-metadata alone. A silent MP4 does not: music-metadata 11.15.0 takes an MP4's duration only from its first audio track and reads the movie header for its dates alone, and it reports `hasAudio` true for every MP4. The failure action, "resolve parser/container support before accepting video", is met by D92: music-metadata still reads every file, sniffs its container and lists its tracks, and an MP4's duration is its movie header's (`moov/mvhd`), read by a bounded reader in `src/core/video.ts`. No dependency was added. What a browser does with a published video, nothing before Play, is checked in `test/browser/document.test.ts` without a decodable file; which codecs a reader's browser plays is not Papeleria's to check (Playwright's Chromium plays VP8, VP9 and AV1 and not H.264).

**Amended 2026-09-28 by D190 (security audit F8, F20).** music-metadata 11.15 sizes each read by what a file declares and trusts every count it finds, so a file of a few bytes could make it reserve gigabytes or hold the event loop for more than a minute. `probeVideo` now reads a file with it only after `admitVideo` has named the container from the bytes and walked every part music-metadata will read, within the part that holds it and within bounds, and it passes the media type found to `parseBuffer`. Every outcome in the table above is unchanged; a file that is neither EBML nor an ISO file with `ftyp` first is refused before music-metadata sees it, and a fragmented MP4 is named as such. `test/unit/video.test.ts` holds the walk's element sets to the Matroska DTD installed, so an upgrade of music-metadata that reads differently fails there first. The same test file passes unchanged against 11.16.1, the version the tarball's installation resolved by its range on 2026-09-28, which fixes F8 upstream but not three of F20's four; those are to be reported to the maintainer through the library's private vulnerability reporting, and the report stays out of this repository until a fixed release exists.

## Pinned page-turn source

Use [Nodlik/StPageFlip v2.0.7](https://github.com/Nodlik/StPageFlip/tree/ab30ecc1d9f6d98de1a99b8e296469382f41c120), commit **ab30ecc1d9f6d98de1a99b8e296469382f41c120**. The annotated tag was resolved to this commit and its MIT LICENSE inspected on 2026-09-22. No other fork is implied.

That commit carries the engine's sources and build configuration but **no built file**: its `.gitignore` excludes `dist/*`, and `dist/js/page-flip.browser.js` does not exist there. The built file comes from the npm tarball `page-flip@2.0.7` instead, which was published from that commit (its registry `gitHead`). The owner chose this source on 2026-09-23 (`../execution/W1_RECONCILIATION.md` §6); M4.1 vendored it on 2026-09-26 (D100):

| Item | Value |
| --- | --- |
| Tarball | `https://registry.npmjs.org/page-flip/-/page-flip-2.0.7.tgz`: 9,181,182 bytes, integrity `sha512-96lQFUUz7r/LZzEUZJ3yBIMEKU9+m8HMFDzTvTdD6P7Ag/wXINjp9n0W7b4wanwnDbQETo4uNUoL3zMqpFxwGA==` |
| `vendor/page-flip/page-flip.browser.js` | The tarball's `package/dist/js/page-flip.browser.js`, byte for byte: 44,058 bytes, SHA-256 `bbaca0bbef57a22bb66a3fc69d67baf9a17fb9a9c89ec9ed35e2b91abe4bd1e7`. A minified classic UMD script that sets the global `St` and adds the engine's stylesheet with a `<style>` element when it runs |
| `vendor/page-flip/LICENSE` | The tarball's `package/LICENSE`, verbatim: MIT, Copyright (c) 2020 Nodlik, 1,063 bytes, SHA-256 `88d7b609a3be5efa2abe8648ddc35d5489579db5e06299545760df45c2c32d66`, byte-identical to the commit's |
| `vendor/page-flip/VERSION` | Upstream repository, tag and commit; npm package, version and `gitHead`; tarball URL, size and integrity; each file's tarball member, size and SHA-256; `patches: none` |
| `vendor/page-flip/PATCHES.md` | The ledger: no patch is applied, and the format one must follow |
| `vendor/page-flip/.gitattributes` | `* -text`, so no checkout converts the pinned bytes |

`scripts/vendor-page-flip.mjs` holds the pins. `npm run vendor:page-flip` verifies the folder offline and fails on any mismatch; `node scripts/vendor-page-flip.mjs --fetch` downloads the tarball, checks its integrity, reads the two members itself and checks their hashes before writing anything (`--tarball <file>` reads a local copy). `test/unit/vendor-page-flip.test.ts` repeats the checks without a network, and `npm run check:licenses` inventories the licence in published-piece scope. The file uses six things the published-client scan bans in Papeleria's own code; each was reviewed once, writes a constant, and cannot be reached by anything from a piece (D101), so W4 admits the file to the reader bundle by its hash and that list and the scan stays as it is. Local changes remain separate, explained patches; no CDN fallback.

Papeleria's own adapter, `templates/comic/client/engine-adapter.ts` (D103), wraps the engine behind turnTo/next/previous/resize/destroy, owns the logical page state and never calls an animated engine path in its instant, reduced-motion mode; W4's `reader.ts` uses it.

### Spike, 2026-09-26 (DEP05)

`test/browser/spike/page-flip.test.ts` assembles the spike when it runs: `test/browser/spike/page-flip.html` (eight figures, each a page of the sample comic as an `<img>` with its panel buttons, as `examples/sample-comic/papeleria.yaml` places them), the eight committed pages, the theme's public favicon, and one classic script, `spike.js`: the vendored file's pinned bytes verbatim, a newline, then the spike's own IIFE (`spike-entry.ts` and the adapter, bundled by esbuild), which the published-client scan passes with no exception. Each item runs at 390×844, 834×1112 and 1280×800, over http and, for item 6, from `file://`:

| Item | Result |
| --- | --- |
| Cover and pairs | The cover alone, then 2–3, 4–5, 6–7 and 8 alone at 1280×800; one page at a time at 390×844 and 834×1112, where IC07 fits no spread |
| Resize | The logical page is kept: page 3 widened shows 2–3 and narrowed shows 3 again; a resize during a curl finishes it |
| Panel-over-edge priority | A click or tap on a panel inside the edge zone runs the panel's action and turns nothing; bare art at the corner turns; with the guard off, the same press turns (the control) |
| No-JS DOM | Every page and its `<img src>`, in order, requested; with JavaScript every page stays in the DOM |
| `src` retention | Every `<img>` keeps its `src` and is the same element after initialization and turns |
| `file://` | Loads, enhances and turns; nothing captured outside the folder. Playwright's Firefox fires no request event for a `file://` load, so there the capture covers network requests |
| Reduced-motion bypass | Every turn, API or gesture, is an instant swap; `flipNext`, `flipPrev` and `startAnimation` are never called (a spying subclass); a live switch finishes a running curl |
| `destroy()` cleanup | Every listener, observer and frame the adapter and the engine added is gone, the frame loop stops, and the page DOM is byte-identical to before |

**Result: DEP05 passes, with no patch to the engine**: in Chromium 141 on the development machine, and in Chromium 153, Firefox 155 and WebKit 26.6 in CI (run 36264619086 in the development record's CI). The failure action, "patch isolated adapter; do not silently drop curl or accessibility promises", was not needed: the adapter meets every item from outside the engine (D103), the curl stays in motion mode and is bypassed only for reduced motion, and `PATCHES.md` stays empty. The per-engine table, the defects fixed on the way and the open limits are in `blueprint/W3C.md`.

**Re-confirmed on the real reader, 2026-09-27 (W4, D116).** The same items run against the shipped `reader.js`, not the spike, in `test/browser/comic.test.ts`, items 1 and 3 to 6 at each of the three viewports: the cover alone, pairs and the last page alone (1); resize keeping the logical page, between 1280×800 and 390×844 (2); a press on a panel winning over the edge zone (3); the page without JavaScript (4); the preload window (5), where a loaded page outside it now lets its sources go, as IC07 asks, keeping its element and its size (D114); `file://` (6); and print handing the page back exactly as published, then resuming, at 1280×800 (8). Reduced motion (7) is `test/browser/motion.test.ts`: every turn instant and no animated engine call, counted through an init-script subclass (D118). All passed in Chromium 153, Firefox 155 and WebKit 26.6 in CI, on `main` after the merge (run 36358007535 in the development record's CI, 430 of 430 browser tests). The adapter and the engine are unchanged and `PATCHES.md` stays empty; the adapter's open limits are listed in D116.

## Release licence inventory, 2026-09-28 (DEP06)

Recorded by session W5B at M5.3 (D125–D129), on Node v22.22.2, npm 10.9.7, Linux 6.18.44 x86_64 (glibc).

**Final locked versions.** `package-lock.json` is unchanged since DEP01 (SHA-256 `3c0a5761039c7839fee05ce4cda88e7f2c337eb58bebb67b604e7e305a045bb3`), so the resolved versions listed there are the release's: nothing was added, removed or moved between `dependencies` and `devDependencies` from M1 to M5. The lockfile holds 225 entries; `npm ci` installs 179 of them here, and the other 46, other platforms' packages, are read from the lockfile and from `scripts/native-observations.json`.

The inventory is `docs/evidence/license-inventory.json` (D125), and `THIRD_PARTY.md` is written from it (D126):

| Scope | Entries | What they are |
| --- | --- | --- |
| author-runtime | 155 lockfile entries, 150 package versions | npm installs them with Papeleria; 58 installations are also inside the shipped editor page, `lib/clients/editor/editor.js` |
| optional-platform | 26 | sharp's per-platform packages; with `sharp` itself, 27 native packages, 16 in distribution scope and 11 excluded by D34, holding 31 components, 9 of them weak-copyleft |
| dev | 44 | Not installed with Papeleria and not in the package |
| vendored-published | 1 | StPageFlip 2.0.7 (MIT), copied into every comic |
| font | 8 files, 2 families | Poppins and Inter (OFL-1.1), copied into every piece |
| copied into own files | 3 | D41's d3-format and d3-time-format locale definitions (ISC); the engine's four layout rules in `comic.css` (MIT) |
| gaps | 19 | Recorded for the owner, never failed: licence texts that are not retained, packages that ship none or fewer than their declaration names, the fonts' provenance |

The experiment the register row names, and its evidence:

| DEP06 asks for | Evidence |
| --- | --- |
| The actual lockfile and platform-binary licence inventory | The inventory above. `npm run check:licenses` passes R11 in every scope, the fonts and the engine included, with no policy failure; `node scripts/license-inventory.mjs --check` passes under `npm test`, and the six sharp packages installed here are byte for byte their observations |
| Tarball and output notice content | `npm run test:package` holds the real tarball to an exact tree, with every notice and licence text byte for byte and `THIRD_PARTY.md` current, and checks each template's `dist/` from the installed CLI; `test/integration/output-notices.test.ts` checks the four examples' `dist/` trees (D127, D128) |
| Own-versus-third-party policy tests | R11 per scope with the disallowed and unknown fixtures, no GPL dependency installed (`test/unit/license-check.test.ts`); the font scope; `test/unit/distribution.test.ts`; each `dist/THIRD_PARTY.md` names Papeleria's own code under the Apache License 2.0 apart from its third-party rows |

**Result: DEP06's automated part passes, and its failure action stands.** Public release stays blocked until the discrepancies are resolved: the sixteen native reviews are unsigned, so `npm run check:licenses:release` fails with 16 blockers, 0 policy failures and licence evidence 5 of 5 verified; A1 and A2 are the owner's; the texts and notices of A9 are not retained; B1 and B2 wait on re-confirmation; and the fonts' subset provenance is not established. Each is a row in `execution/issues/002-standing-release-items.md`, and `docs/RELEASE_LICENSE_REVIEW.md` is the review. At M5.3 `licenses/` holds fourteen SPDX texts, IJG and libtiff added to the twelve, and the exact licence files of the 60 packages whose code or data the package ships.

**C2 (D128).** The CodeMirror and Lezer packages stay in `dependencies`: their code ships in the editor page whichever section lists them, and moving the twelve direct editor dependencies to `devDependencies` would put `argparse@2.0.1` (Python-2.0) and `railroad-diagrams@1.0.0` (CC0-1.0) in dev scope, which no policy covers, for an install 24.95 MB smaller out of 90.3 MB.

## License and package gates

The Apache license for Papeleria’s own code is independent of the third-party published-code allowlist (MIT/ISC/BSD) and font OFL. Author-only dependencies additionally allow Apache-2.0 and the documented libvips LGPL exception. That exception is an explicit package list, not a name prefix: sharp 0.35 also declares `Apache-2.0 AND LGPL-3.0-or-later` on `@img/sharp-win32-arm64`, `@img/sharp-win32-ia32`, `@img/sharp-win32-x64` and `@img/sharp-wasm32`, which link libvips statically (D24). It never applies in published-piece scope. Scan production, dev, optional, platform-specific and vendored dependencies with scope, version, license expression and retained license text. Do not infer a whole dependency tree’s license from a parent package. Unknown/custom expressions fail pending review; evaluate SPDX AND/OR expressions correctly.

Keep NOTICE.md maintained; generate THIRD_PARTY.md and a licenses directory without overwriting the kit/font attribution. The npm package includes own LICENSE, NOTICE.md, TRADEMARKS.md, all third-party license texts and font licenses. Each dist includes own LICENSE, NOTICE.md, THIRD_PARTY.md scoped to emitted assets, both font OFLs, and the engine MIT text for comics. Copy tests inspect actual npm tarball and output trees. Test a disallowed fixture without installing a GPL dependency.

Licences outside those allowlists are refused unless `scripts/license-exceptions.json` names the exact package, version, scope and licence with a rationale, a review owner and an explicit `provisional` or `approved` status; a missing status is a hard error, never an implied approval, and an approved entry must also carry its approval reference, approver and date. Copyleft can never be excepted.

The owner resolved the M0.4 findings on 2026-09-22. **PSF-2.0, Python-2.0 and 0BSD are allowed in author-runtime scope** (D29), which covers `argparse@3.0.2`, `argparse@2.0.1` and `tslib@2.8.1`; the published-piece and dev allowlists are unchanged, and all three sets are now written out per scope so that widening one cannot widen another. `railroad-diagrams@1.0.0` keeps an approved package-specific exception for CC0-1.0 (D30); CC0 is not allowlisted. `valid-url@1.0.9` declares no licence and is identified as MIT by a pinned licence-file hash (D31). `json-schema@0.4.0` declares `(AFL-2.1 OR BSD-3-Clause)` and passes on its allowed half with no exception. Three of these reach the tree only through codemirror-json-schema, which DEP02 has now assessed (D33).

Licence **evidence** is separate from policy and lives in `scripts/license-evidence.json` (D31). A record names the package, exact version, the licence file relative to that package's own directory, its SHA-256, optionally what it identifies, and who read it when. Records are verified whether or not an exception applies, so moving a licence into an allowlist does not retire its check, and they resolve against nested installations where those exist.

sharp must be installed and WebP encoding must work. Only missing AVIF capability degrades to WebP with a warning. Do not claim that notices alone establish LGPL compliance; verify distribution obligations and the actual transitive/native inventory before release. Trademark clearance remains an owner release responsibility.

Facts a machine can assemble about a native package are recorded on an unresolved review as `proposedEvidence`, never as `evidence` (D36). The static linkage read in `scripts/native-observations.json`, the twelve SPDX texts at `licenses/` with their hashes in `licenses/index.json`, and the per-component upstreams in `docs/evidence/native-source-index.json` are all assembled and cited from the sixteen reviews; none of them moves a review towards verified, and the release gate still fails. The linkage read corrects an earlier claim in D35: the linking position comes out of the file headers, not out of running the binary, and it shows the weak-copyleft components linked **statically** into `libvips-cpp` and `libvips-42.dll`.

Work deferred to the end of the project is collected in `execution/issues/002-standing-release-items.md`. That file is a register of what must be true before 0.1.0; being listed there approves nothing.

## Release gate

`npm run check:licenses:release` is the publication gate (D32). It fails on an applicable provisional exception, missing approval metadata, failed or unresolved required evidence, an incomplete native distribution review, and any disallowed or unknown licence. CI runs the ordinary `npm run check:licenses` only: the release gate fails today for a real reason, and running it per commit would invite someone to weaken it. Both modes also fail on an exception listed for published-piece scope, which no exception covers (D21), and on a retained licence text under `licenses/` whose size or SHA-256 differs from `licenses/index.json`, or that the index does not name (W5E, W5R-05, W5R-06).

The native review is three files, because they are three different jobs (D34). `scripts/native-scope.json` records which platforms the project distributes for; a platform leaves scope only through an exclusion naming a decision, an approver and a date. A package-pattern exclusion may name only packages no platform in scope requires, and a package npm installs everywhere, such as `sharp`, stays required whatever the scope lists, so no edit to the scope file alone can empty the review (D177). `scripts/native-observations.json` is generated by `scripts/native-inventory.mjs` and records what is *in* each package — versions, integrity, artefact and licence-text hashes, bundled component tables. `scripts/native-reviews.json` records whether the obligations are met, and a person writes it; no generator may set a status there. Requirements are derived from the lockfile intersected with the scope, so a missing record is a failure rather than an absence of findings.

A verified review must state where the licence texts are retained, where corresponding source is offered, and whether the artefact is linked statically or dynamically, and it is bound to the artefact digest it was made against: a changed binary invalidates it instead of inheriting it.

`--fetch` downloads and statically unpacks a published tarball, so the Windows and macOS packages are inspected from any platform (D35). Only execution — loading a binary to see what it links against — needs the target machine, and every observation records which method produced it.

As of 2026-09-22 on linux/x64: 27 observations covering every in-scope package, 16 required packages, **0 verified**, 11 out of scope by recorded decision. The substantive findings: `@img/sharp-libvips-linux-x64`, `-linuxmusl-x64`, `-darwin-arm64` and `-darwin-x64` declare LGPL-3.0-or-later and ship **no licence text of their own**, each bundling one ~18 MB shared library built from 28 upstream projects of which 9 are weak-copyleft (cairo under MPL-2.0, plus fribidi, glib, libexif, libheif, librsvg, pango, proxy-libintl and libvips); `@img/sharp-win32-x64` does ship a licence text and carries libvips as two separate DLLs; and source availability and the linking position are review questions that a static read cannot answer.

## Feasibility gates (all pending execution)

| Gate / owner role | Due | Experiment and pass evidence | Failure action |
| --- | --- | --- | --- |
| DEP01 / build maintainer | M0.1 | Resolve lockfile, clean npm ci, strict import smoke/typecheck on Node 22.x; npm pack production installation keeps CLI html-validate functional once build exists in M1 | Adjust incompatible ranges in this register; do not hide errors with forced peers |
| DEP02 / editor maintainer | M2.2 before full UI | YAML/JSON completion/hover through shared $refs and 2020-12 schemas; malformed input still gets authoritative positions; paste/edit latency recorded | Correct adapter or record a replacement decision before continuing editor |
| DEP03 / media maintainer | M1.4 | WebP success, AVIF-present and simulated unavailable paths; content/settings cache invalidation; sharp-unavailable failure | Fix install/platform support; no promise that missing sharp is optional |
| DEP04 / media maintainer | M3.4 | Silent MP4 and WebM at <=15 s pass; 16 s, zero/unknown/corrupt duration fail; record container/codec provenance | Resolve parser/container support before accepting video |
| DEP05 / reader maintainer | M4.1 before reader completion | Cover/pairs, resize, panel-over-edge priority, no-JS DOM, src retention, file://, reduced-motion bypass and destroy cleanup at three viewports | Patch isolated adapter; do not silently drop curl or accessibility promises |
| DEP06 / release maintainer | M5.3 | Actual lockfile/platform binary license inventory, tarball/output notice content, own-vs-third-party policy tests. Run 2026-09-28 (W5B): the automated part passes; see “Release licence inventory” above | Block public release until discrepancies are resolved |

## Primary source register

These links identify upstream facts used for the baseline; final locked versions still require installation and license inspection.

- [Node previous releases](https://nodejs.org/en/about/previous-releases) and [release schedule](https://github.com/nodejs/Release#release-schedule).
- [D3 modules](https://d3js.org/getting-started) and [d3-dsv](https://github.com/d3/d3-dsv).
- [CodeMirror schema extension](https://github.com/jsonnext/codemirror-json-schema) (0.8.1 package and YAML support inspected).
- [music-metadata](https://github.com/Borewit/music-metadata) (11.15.0 API/package inspected; DEP04 run on 2026-09-26: WebM passes as it is, and a silent MP4's duration is read from its movie header, D92; each file is walked before it reads it, D190).
- [saxes 6.0.0 package](https://github.com/lddubeau/saxes/blob/v6.0.0/package.json).
- [StPageFlip pinned MIT license](https://github.com/Nodlik/StPageFlip/blob/ab30ecc1d9f6d98de1a99b8e296469382f41c120/LICENSE).
- [sharp installation](https://sharp.pixelplumbing.com/install/) and [license](https://github.com/lovell/sharp/blob/main/LICENSE).
- [Poppins OFL](https://github.com/google/fonts/blob/main/ofl/poppins/OFL.txt) and [Inter OFL](https://github.com/google/fonts/blob/main/ofl/inter/OFL.txt), copied into theme/fonts on 2026-09-22. Original subset build provenance is not supplied; inspect bundled font metadata and retained notices before distribution. The fonts' name, OS/2 and head tables were read at M5.3 (D125, `docs/RELEASE_LICENSE_REVIEW.md` §5a); the subset recipe is still not supplied.
- Read at M5.3 for the native provenance (D129): [sharp at `7f1a0a22`](https://github.com/lovell/sharp/tree/7f1a0a22cc285fe180766f4935d50b55af6e8432) (the CI job `build-emscripten`); [sharp-libvips at `6e5971d`](https://github.com/lovell/sharp-libvips/tree/6e5971d333377743163edc3ad9e5d0b897abcbc9) (`versions.properties`, `build/wasm.sh`, `build/win.sh`); [wasm-vips at `79103664`](https://github.com/kleisauke/wasm-vips/tree/79103664d21ce00982e80571cf12f58bd3dcc5f3) (`build.sh`, `Dockerfile`); [resvg `v0.48.1`](https://github.com/linebender/resvg/tree/v0.48.1) (`Cargo.toml`, `LICENSE-MIT`); [build-win64-mxe `v8.18.6`](https://github.com/libvips/build-win64-mxe/releases/tag/v8.18.6); and the [SPDX licence list data](https://github.com/spdx/license-list-data) for the IJG and libtiff texts.
