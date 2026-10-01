# Papeleria

Papelería is an application for creating and publishing interactive HTML5 presentations, digital publications, and learning content. Its scope includes interactive slide presentations, infographics, comic panels, magazine and ebook layouts, and integration with Learning Management Systems through Learning Tools Interoperability (LTI). It is designed to run on Linux, macOS, and Windows.

The existing implementation includes a command-line tool and a local browser-based editor for creating content from plain files, including YAML manifests, Markdown text, CSV data, images, and video. It builds static HTML5 content for offline viewing and publication. Current templates support interactive slide presentations, web comics, and printable documents, with browser-based PDF output.

Magazine and ebook layouts, an expanded visual editing studio, automation interfaces, and LTI integration are part of the planned scope and are not represented as completed features.

Papeleria turns a folder of text, data, and images into a slide deck, an illustrated comic, or a printable document. Write a YAML or JSON manifest, edit it in a local browser, and build a folder of static files that can be opened offline or copied to a web host.

**Documentation edition:** 0.1.0 · schema 1 · 30 September 2026. The implementation is a release candidate. Platform acceptance and redistribution checks remain open; see [Installation](docs/INSTALLATION.md#requirements-and-platform-status) and [Licensing](docs/LICENSING.md#release-status-and-native-dependencies).

[Repository](https://github.com/JeremiahJRRoss/papeleria) · [Main branch](https://github.com/JeremiahJRRoss/papeleria/tree/main) · [Releases](https://github.com/JeremiahJRRoss/papeleria/releases) · [Issues](https://github.com/JeremiahJRRoss/papeleria/issues)

## What you can make

| Format | Authoring features | Published result |
| --- | --- | --- |
| **Deck** | Twelve slide layouts; Markdown; CSV charts and tables; pictures; speaker notes | Slides with keyboard, touch, and presentation controls; printable as A4 landscape |
| **Comic** | Page art; panel rectangles; transcripts; optional zoom, text, image, and link details | Page and guided readers; single pages or spreads; printable art and transcripts |
| **Document** | Sections containing text, figures, short video, charts, tables, quotes, notes, callouts, and logos | A scrolling, script-free document with A4 portrait print styling |

The editor provides schema help, live preview, diagnostics, file saving, and conflict detection. Output supports English and Spanish; the editor interface is English. Fonts and other rendering resources are local. External links require a connection only when followed.

Papeleria has no account service, database, telemetry, or built-in hosting. The editor runs on your computer at `127.0.0.1`. It is a source editor with a preview, not a drag-and-drop page designer. It does not transcode video or generate chart summaries and image descriptions for you.

## Start here

Install Git and **Node.js 22.x**, then run:

```sh
git clone --branch main https://github.com/JeremiahJRRoss/papeleria.git
cd papeleria
npm ci
npm run build
node lib/src/cli/index.js --version
node lib/src/cli/index.js new deck my-deck
node lib/src/cli/index.js edit my-deck
```

The editor opens in your browser. Change the title of the first slide, save, and choose **Build**. Open `my-deck/dist/index.html` to read the result. Save before stopping the editor with **Ctrl+C** in its terminal.

For a terminal-only build:

```sh
node lib/src/cli/index.js check my-deck
node lib/src/cli/index.js build my-deck
```

Run those commands from the repository root. The manual uses the shorter `papeleria` command: replace it with `node lib/src/cli/index.js` while working there, or install a command as described in [Installation](docs/INSTALLATION.md).

## Documentation

These five documents form a complete public set; earlier development documents are not required.

| Document | Contents |
| --- | --- |
| [README](README.md) | Overview and first build |
| [Installation guide](docs/INSTALLATION.md) | Source, tarball, and desktop installation; verification; offline use; updates and removal |
| [User manual](docs/USER_MANUAL.md) | Complete workflow, examples for all three formats, field reference, media, publishing, diagnostics, and troubleshooting |
| [Architecture](docs/ARCHITECTURE.md) | Components, data flow, build behavior, storage, security boundaries, testing, and extension points |
| [Licensing](docs/LICENSING.md) | Project license, attribution, fonts, dependencies, generated output, trademarks, and known redistribution gaps |

The accompanying `LICENSE` and `licenses/` contain the retained legal texts referenced by the licensing document.

## Files and commands

A **piece** is a folder containing exactly one `papeleria.yaml` or `papeleria.json`, plus its assets. Generated output goes in `dist/`. The source files are your editable originals; keep them even after sharing the output.

| Command | Purpose |
| --- | --- |
| `papeleria new deck my-deck` | Create an editable sample; `comic` and `document` are also available |
| `papeleria edit my-deck` | Open the local editor |
| `papeleria check my-deck` | Validate source and generated output without replacing `dist/` |
| `papeleria build my-deck` | Validate and replace `dist/` with a complete build |
| `papeleria serve my-deck` | Read-only live preview of saved source |

Share the **whole `dist/` folder**, including its notices and licenses. A piece marked `withheld` will preview but will not produce a new `dist/`; any previously published copy must be removed separately.

## Development and support

All npm development commands run in the repository root. The [architecture document](docs/ARCHITECTURE.md#development-and-verification) explains the build and test commands. To report a problem, use [GitHub Issues](https://github.com/JeremiahJRRoss/papeleria/issues) with the Papeleria version, operating system, command, and smallest piece that reproduces it. Remove private content and editor access tokens before attaching files.

Papeleria's own software is licensed under [Apache License 2.0](LICENSE). Third-party components and your authored content have separate terms; see [Licensing](docs/LICENSING.md).

The development record, with the decisions, specifications, acceptance matrix, release status and session blueprints behind this code, is kept in a separate repository, Dev_Papeleria, which is not public.
