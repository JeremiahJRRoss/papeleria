# Release licence review

Revision 1 · 2026-09-28 · Written by session W5B at M5.3 (DEP06), under D125–D129. Implementing maintainer: Claude Code autonomous session for accountable maintainer JR (Jeremiah Ross).

**This document is not legal advice.** It records what the licence inventory found, how the obligations of the native libraries are understood, where each release item stands, and what the owner must confirm before Papeleria is published. Every item it calls pending is pending; nothing here approves a release, and nothing here was decided on the owner's behalf. `npm run check:licenses:release` still fails, by design, until a person signs the native reviews.

## 1. Summary

| Question | Answer as of this revision | Evidence |
| --- | --- | --- |
| Does every dependency's licence meet the policy for its scope (R11)? | Yes: `npm run check:licenses` passes with no policy failure. One package-specific exception applies (`railroad-diagrams@1.0.0`, CC0-1.0, approved, D30) | `scripts/license-check.mjs`, `docs/evidence/license-inventory.json` |
| May this be published? | **No, not yet.** The release gate fails on 16 blockers, every one an unsigned native review | `npm run check:licenses:release`, section 3 |
| What reaches a published piece from outside Papeleria? | The eight Poppins and Inter subsets (OFL-1.1) in every piece, and StPageFlip 2.0.7 (MIT) in comics. Nothing else | Each `dist/THIRD_PARTY.md`, `test/integration/output-notices.test.ts` |
| What third-party code is inside the npm package itself? | The engine (`vendor/page-flip/`, and line 2 of `lib/clients/reader.js`), the fonts, D41's d3 locale definitions, the engine's four rules in `comic.css`, and the editor page `lib/clients/editor/editor.js`, which holds code from 58 package installations | `THIRD_PARTY.md` sections 1–3 |
| Are their licence texts in the package? | Yes: `LICENSE`, both OFL texts, the engine's `LICENSE`, fourteen SPDX texts and the exact licence files of the 60 packages whose code or data the package ships | `licenses/index.json`, the tarball test |
| Do the libvips obligations apply to Papeleria? | Open. See section 3: Papeleria's package holds none of those bytes, but anyone who redistributes an installed tree does | Section 3 |

The inventory, `docs/evidence/license-inventory.json`, holds:

| Scope | Entries | Policy applied (R11) | What happens to them |
| --- | --- | --- | --- |
| author-runtime | 155 lockfile entries | MIT, ISC, BSD-2-Clause, BSD-3-Clause, OFL-1.1, Apache-2.0, PSF-2.0, Python-2.0, 0BSD (D29), and the named exceptions | npm installs them with Papeleria on the author's machine; 58 of them are also inside the shipped editor page |
| optional-platform | 26 | As author-runtime, plus LGPL-3.0-or-later for the fourteen named libvips packages (D24) | sharp's prebuilt binaries; npm installs the set for the author's platform |
| dev | 44 | MIT, ISC, BSD-2-Clause, BSD-3-Clause, OFL-1.1, Apache-2.0 | Not installed with Papeleria and not in the package |
| vendored-published | 1 (StPageFlip 2.0.7) | Published piece: MIT, ISC, BSD-2-Clause, BSD-3-Clause, OFL-1.1 | Copied into every comic |
| font | 8 files, 2 families | Published piece | Copied into every piece |
| copied into own files | 3 | — | d3-format 3.1.2 and d3-time-format 4.1.0 locale definitions (ISC), the engine's four layout rules (MIT) |
| bundled into the editor page | 58 installations | Held to production dependencies (D76) | `lib/clients/editor/editor.js`, run in the author's browser, never in a piece |
| native | 27 packages, 16 in distribution scope, 11 excluded by D34; 31 components, 9 weak-copyleft | Section 3 | 0 of 16 reviews signed |

## 2. The package and the pieces

The npm package, as `npm pack` writes it here (Linux x86_64, Node v22.22.2, npm 10.9.7), is 464 files. `test/package/tarball.ts` holds it to exactly: the six top-level files (`LICENSE`, `NOTICE.md`, `README.md`, `THIRD_PARTY.md`, `TRADEMARKS.md`, `package.json`), and the trees `lib/clients/`, `lib/src/`, `lib/templates/` without the client halves (D68), `licenses/`, `templates/` with each template's sample, `theme/` without `theme/js/` (D68) and `vendor/`. Nothing from `brand/`, `docs/`, `blueprint/`, `examples/`, `reference/`, `scripts/`, `src/`, `test/` or any other tree ships. Every notice and licence text is byte for byte the repository's.

Every `dist/` carries Papeleria's `LICENSE`, the maintained `NOTICE.md`, `Poppins-OFL.txt`, `Inter-OFL.txt` and a `THIRD_PARTY.md` the build writes from the files it staged (D127): the two font families with the copyright lines of their OFL texts, and in a comic StPageFlip 2.0.7 with `vendor/page-flip/LICENSE`. The same file is written by an installed CLI and by the repository, and `node scripts/gen-notice.mjs --dist <dir>` rewrites or checks it for any `dist/`.

## 3. The native libraries and the LGPL, as understood

### What is where

sharp 0.35.4 (Apache-2.0) converts a piece's images on the author's machine. npm installs it with Papeleria, with one set of prebuilt packages for the platform:

| Kind | Packages in distribution scope | What the files show | Where each was built |
| --- | --- | --- | --- |
| sharp itself | `sharp` | JavaScript, no native code | `lovell/sharp` at `7f1a0a22cc285fe180766f4935d50b55af6e8432` (registry `gitHead`) |
| The addon | `@img/sharp-{darwin,linux,linuxmusl}-{arm64,x64}` (6) | `sharp-<platform>-0.35.4.node` links `libvips-cpp` **dynamically**, from the libvips package beside it | `lovell/sharp` at `7f1a0a22…` |
| libvips | `@img/sharp-libvips-{darwin,linux,linuxmusl}-{arm64,x64}` (6) | One shared library, `libvips-cpp`, whose dependencies are only the platform's C and C++ runtime: the 28 libraries inside it, 9 weak-copyleft, are linked **statically**. The package ships no licence text | `lovell/sharp-libvips` at `6e5971d333377743163edc3ad9e5d0b897abcbc9` (registry `gitHead` of every 1.3.3 package); its `versions.properties` pins exactly the 28 versions each package lists |
| Windows | `@img/sharp-win32-{arm64,x64}` (2) | The addon and `libvips-cpp-8.18.6.dll` link `libvips-42.dll` dynamically; `libvips-42.dll` holds the 28 libraries statically | Addon: `lovell/sharp` at `7f1a0a22…`. `libvips-42.dll` is byte for byte the one in `@img/sharp-libvips-win32-*@1.3.3` (`6e5971d…`), whose `build/win.sh` packages the prebuilt libraries of **libvips/build-win64-mxe v8.18.6** rather than building them: the reason the Windows packages list aom 3.14.1 where the others have 3.15.0 |
| WebAssembly | `@img/sharp-wasm32` (installed on every platform) | One module with no import table: all 19 libraries, 4 of them LGPL, compiled in | sharp's CI job `build-emscripten` at `7f1a0a22…` (`emscripten/emsdk:6.0.8`) against `@img/sharp-libvips-dev-wasm32@1.3.3` (`6e5971d…`), whose `build/wasm.sh` runs `kleisauke/wasm-vips` from an unpinned `HEAD`; wasm-vips at `79103664d21ce00982e80571cf12f58bd3dcc5f3` pins exactly the shipped versions (issue 002 A5) |

The nine weak-copyleft components are cairo (MPL-2.0) and libexif, fribidi, glib, libheif, pango, proxy-libintl, librsvg and libvips (LGPLv3, used "via the 'any later version' clause of the LGPLv2 or LGPLv2.1", as the READMEs say). The WebAssembly module holds libexif, glib, libheif and libvips. `docs/evidence/native-source-index.json` records every component with its upstream, and `wasm32Build` and `windowsBuild` record each provenance step above.

### Obligations as understood

This is the reading the reviews were prepared against; a lawyer's reading may differ.

- **Papeleria's own npm package contains none of these bytes.** npm fetches them from the registry, where sharp's maintainers publish them, when an author installs Papeleria. Whether declaring the dependency makes Papeleria a distributor of them is the owner's question to take to counsel. What is clear is that anyone who hands on an installed tree does distribute them: an installer, an archive with `node_modules/`, the "copy a prepared directory" route of the installation guide (§7), or a desktop app (PRD §13 already asks for a legal review first).
- **Notices and licence texts.** For such a distribution the LGPL asks for prominent notice that the library is used, with copies of the GPL and the LGPL, and the MPL and the permissive licences ask for their texts and notices. Done: the fourteen texts are in `licenses/`, `NOTICE.md` attributes each of the 31 components to its text (A3), and `THIRD_PARTY.md` lists them. Not done: fontconfig's licence text, the Alliance for Open Media Patent License 1.0, and each component's own licence file with its copyright lines (section 5).
- **Corresponding source.** The LGPL asks that the source of the library, as used, be available; the MPL asks the same of cairo's files. The candidate points are recorded (sharp-libvips at `6e5971d…` with the component sources it downloads; build-win64-mxe v8.18.6 for Windows; wasm-vips at `79103664…` for the module). Whether they are the Minimal Corresponding Source is **issue 002 A1**, the owner's.
- **Relinking.** The LGPL lets a user replace the library in a combined work. On Linux and macOS the addon loads libvips from a separate package, and on Windows from separate DLLs, so the library as a whole can be swapped; but the LGPL libraries inside libvips are linked into it statically, and inside the WebAssembly module everything is. How the relinking terms are met is **issue 002 A2**, the owner's.

### The reviews

`scripts/native-reviews.json` holds sixteen reviews, all `unresolved`. Each now carries refreshed `proposedEvidence` (M5.3): where its licence texts are retained and attributed, where its source was built, from the registry and the build scripts at those commits, and its linking position. A person signs a review by reading those facts, moving the accepted ones into `evidence`, binding it to the current `artefactDigest` and setting its status (D34, D36). No session signs them. The `unresolved` line of the `@img/sharp-wasm32` review still says its build "is not identified yet": that text is the reviewer's, and its proposal now identifies it.

## 4. Issue 002, where each row stands

| Row | Item | Where it stands | Owner |
| --- | --- | --- | --- |
| A1 | Minimal Corresponding Source | **Open.** Facts assembled: the build commits of every package, the Windows and WebAssembly chains, each component's upstream | Release owner |
| A2 | Relinking for the statically linked LGPL components | **Open.** Facts assembled: the linkage of every artefact (section 3) | Release owner |
| A3 | Attribute each bundled component to its retained text | **Closed at M5.3**: `NOTICE.md` attributes all 31, `THIRD_PARTY.md` section 5.1 covers them, IJG and libtiff added to `licenses/`; two texts and the per-component notices stay open as A9 | Release maintainer |
| A4 | Sign the sixteen reviews | **Open, prepared.** `proposedEvidence` refreshed on all sixteen; none signed | Release maintainer |
| A5 | Identify the build behind `@img/sharp-wasm32` | **Closed at M5.3**: section 3, `native-source-index.json` `wasm32Build` | Release maintainer |
| A6 | An upstream for resvg | **Closed at M5.3**: `https://github.com/linebender/resvg`, from wasm-vips' `build.sh` at `79103664…` and resvg's `Cargo.toml` at `v0.48.1` | Release maintainer |
| A7 | Install-time check on win32 and macOS | Open, M5.5 | Release maintainer |
| A8 | Wire the release gate in front of publication | Open, M5.5 (W5D) | W5D |
| A9 (new) | fontconfig's text, the AOM patent licence, each component's own copyright notices; resvg's Rust crates and Emscripten's runtime libraries | Open | Release maintainer; whether needed depends on A1/A2 |
| B1 | Re-confirm PSF-2.0, Python-2.0, 0BSD in author-runtime scope | **Open.** Still needed by exactly `argparse@3.0.2` (PSF-2.0), `argparse@2.0.1` at two paths (Python-2.0, reached only through `codemirror-json-schema` and `@shikijs/markdown-it`, not in the editor bundle) and `tslib@2.8.1` (0BSD, through `@img/sharp-wasm32`) | Release owner |
| B2 | Re-confirm the `railroad-diagrams@1.0.0` CC0-1.0 exception | **Open.** Still in the tree, through `codemirror-json-schema` → `json-schema-library` → `smtp-address-parser` → `nearley`; not in the editor bundle; it ships no licence text | Release owner |
| B3 | Re-verify the licence-file hashes of `license-evidence.json` | **Closed at M5.3**: 5 of 5 verified on Linux x86_64; every one is in a package npm installs on every platform | Build maintainer |
| B4 | Naming and trademark clearance | Open | Owner |
| C2 | CodeMirror and Lezer in `dependencies` or `devDependencies` | **Closed at M5.3: they stay** (D128). Their code ships inside the editor page whichever section lists them; moving them would take 96 installations, 24.95 MB of the 90.3 MB production install, out of `npm install --omit=dev`, but would need the owner's policy for Python-2.0 and CC0-1.0 in dev scope and a change to the bundler's rule (D76) | Editor maintainer |
| F1 | The editor page's packages in `THIRD_PARTY.md` with their copyright lines; a missing inventory path fails the tarball test (provenance review P01) | **Closed at M5.3**: `THIRD_PARTY.md` §3 and `licenses/packages/`; the packages read from the shipped file are held to each bundle's esbuild metafile (B4), and the tarball to an exact tree (B5). The review's 54 read the four packages nested under `codemirror-json-schema` as that package: they are 58 | Release maintainer |
| F2 | The ISC notice for D41's copied locale data (P03) | **Closed at M5.3**: `THIRD_PARTY.md` §2, and D41's comment points at it | Release maintainer |
| F3 | Inter's embedded copyright line in `Inter-OFL.txt`; the font facts in `NOTICE.md` (P04) | **Closed at M5.3**: the 2016 line opens `Inter-OFL.txt`, above Google Fonts' 2020 line; `NOTICE.md` records the facts; a test checks each family's embedded lines against its text | Release maintainer |
| F4 | A provenance statement for the kit; readable sources for the three minified stylesheets (P05) | Open | Owner; theme maintainer |
| F5 | The review's checks B1–B9 adopted or declined | B3, B4 and B5 **adopted at M5.3**, under `npm test` and `npm run test:package`; B1 and B2 not adopted at M5.3 (D129: an allowlist that a person has to read, and B2 waits on F4); B6–B9 are W5D's | Release maintainer; W5D |

## 5. Findings of this review

Each is in the inventory's `gaps` list, the source index or the pages named. None is a policy failure; each needs a person.

1. **Texts not retained.** fontconfig's own licence (the READMEs' "fontconfig License (BSD-like)") and the Alliance for Open Media Patent License 1.0: their upstreams (`gitlab.freedesktop.org`, `aomedia.org`, `aomedia.googlesource.com`) were refused by this environment's network.
2. **Component copyright notices.** The retained texts are the SPDX texts, which name no holder. A binary distribution under BSD- or MIT-style terms reproduces each component's own notices; none is retained yet.
3. **Libraries compiled in but not listed anywhere.** resvg is built with `cargo --locked` and `-Zbuild-std`, so crates from its `Cargo.lock` and the Rust standard library are in the WebAssembly module; Emscripten compiles its runtime libraries in. No package lists them.
4. **Upstream licences read against the READMEs.** resvg 0.48.1 is `Apache-2.0 OR MIT`; libultrahdr 2.0.2 is under "both the MIT license and the Apache License"; libvips 8.18.6's own text is LGPL-2.1; Emscripten 6.0.8 is MIT or NCSA. The READMEs name one licence for each, and the retained texts cover what they name. The source index had no licence for `uhdr`, whose README row is named `libultrahdr`: corrected. libnsgif (MIT) is compiled inside libvips' own tree.
5. **The Windows DLL is not sharp-libvips' build.** Its corresponding-source point is `libvips/build-win64-mxe` v8.18.6 (section 3).
6. **npm packages that ship no licence text:** `@tokenizer/token@0.3.0` (MIT), `saxes@6.0.0` (ISC), `railroad-diagrams@1.0.0` (CC0-1.0) and `codemirror-json5@1.0.3` (MIT, which contributes no code to the editor bundle). Each declares its licence in `package.json`; `valid-url@1.0.9` is the reverse case, a text with no declaration, identified by D31's evidence. `@img/sharp-wasm32@0.35.4` declares Apache-2.0 AND LGPL-3.0-or-later AND MIT and ships the Apache-2.0 text alone; the other two are retained in `licenses/`.
7. **Inside the editor bundle's shiki packages.** It carries one grammar, JavaScript, and two themes, Vitesse light and dark. shiki's registry (`shikijs/textmate-grammars-themes`, read 2026-09-28) gives their sources as `microsoft/vscode` and `antfu/vscode-theme-vitesse`, both MIT; the `@shikijs` packages' own MIT files, which `licenses/packages/` retains, name shiki's authors, not those.
8. **Fonts.** Their tables say: Poppins 4.004 (vendor ITFO, "Copyright 2020 The Poppins Project Authors", licence URL `https://scripts.sil.org/OFL`), Inter 4.001 (`Version 4.001;git-66647c0bb`, vendor RSMS, a variable font with a weight axis of 100–900 although the files are named 400–700, licence URL `https://openfontlicense.org`); every file allows installable embedding (fsType 0). Inter's name tables say **Copyright 2016** The Inter Project Authors where Google Fonts' `OFL.txt` says 2020: `Inter-OFL.txt` now carries both lines, the embedded one first (issue 002 F3). The subset files came without the recipe that made them, so their provenance is not established by reading them (`NOTICE.md`).

## 5a. Fonts, file by file

| File | Family (name table) | Revision | Vendor | Copyright (name table) | SHA-256 |
| --- | --- | --- | --- | --- | --- |
| `inter-400-700-latin-ext.woff2` | Inter | 4.001 | RSMS | Copyright 2016 The Inter Project Authors | see the inventory |
| `inter-400-700-latin.woff2` | Inter | 4.001 | RSMS | Copyright 2016 The Inter Project Authors | see the inventory |
| `poppins-400-latin-ext.woff2`, `poppins-400-latin.woff2` | Poppins | 4.004 | ITFO | Copyright 2020 The Poppins Project Authors | see the inventory |
| `poppins-500-latin-ext.woff2`, `poppins-500-latin.woff2` | Poppins Medium | 4.004 | ITFO | Copyright 2020 The Poppins Project Authors | see the inventory |
| `poppins-600-latin-ext.woff2`, `poppins-600-latin.woff2` | Poppins SemiBold | 4.004 | ITFO | Copyright 2020 The Poppins Project Authors | see the inventory |

## 6. Trademarks

The names and marks are not licensed with the code (`TRADEMARKS.md`, D05, D18). Registration and clearance of the Papeleria name and of the `papeleria` wordmark are the owner's, with a trademark attorney after a clearance search (PRD §13, issue 002 B4). Nothing in this review bears on them.

## 7. What the owner must confirm before publication

1. **A1 and A2**, recorded as decisions, then **the sixteen signatures (A4)**: accepted facts moved from `proposedEvidence` into `evidence`, each review bound to its current artefact digest, until `npm run check:licenses:release` passes without any weakening.
2. **B1 and B2**: the author-runtime allowlist additions and the CC0-1.0 exception against this lockfile, which still needs them.
3. **A9**: whether the missing texts and the per-component notices are needed, given A1 and A2, and if so where they come from.
4. **The fonts and the kit**: the provenance of the eight subsets; a provenance statement for the kit and readable sources for its three minified stylesheets (F4); and whether to adopt the provenance review's B1 and B2 scans, whose allowlists are a person's reading (F5).
5. **B4**: naming and trademark clearance.
6. **A7 and A8** at M5.5: the install check on Windows and macOS, and the release gate in front of publication.

## 8. Reproducing this review

From the repository root, after `npm ci` and `npm run build`:

| Command | What it shows |
| --- | --- |
| `npm run check:licenses` | R11 over every scope, the fonts and the vendored engine included: pass |
| `npm run check:licenses:release` | The publication gate: fails on the 16 unsigned reviews |
| `node scripts/license-inventory.mjs --check` | The inventory is current; it also compares the installed sharp packages with their observations |
| `node scripts/gen-notice.mjs --check` | `THIRD_PARTY.md`, `licenses/packages/` and `licenses/index.json` are current |
| `node scripts/gen-notice.mjs --dist <dir> --check` | A `dist/`'s `THIRD_PARTY.md` is what the build writes |
| `npm run test:package` | The tarball's contents and notices, and each template's `dist/` from the installed CLI |
| `npm test` | Among the rest, the inventory's checks: every lockfile entry from the public registry (B3), and the editor page's packages as esbuild bundled them (B4) |
