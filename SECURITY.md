# Security policy

Papeleria is a local publisher: `papeleria build` turns a folder of text, data
and images into a static deck, comic or document, and `papeleria edit` and
`papeleria serve` run on the author's own machine on the loopback address
only. The boundaries it keeps are described in the architecture document
([system boundaries](docs/ARCHITECTURE.md#system-boundaries) and
[persistence and privacy](docs/ARCHITECTURE.md#persistence-and-privacy)).
The security contracts it implements (IC02 paths, IC05 saves, IC06 the local
server) and the latest security review, of 28 September 2026, are recorded in
the development record, Dev_Papeleria, which is not public.

## Reporting a vulnerability

Please do not open a public issue for a security problem. Use GitHub's
private vulnerability reporting on this repository (Security tab, "Report a
vulnerability"). If that is not enabled, contact the repository owner
directly through GitHub.

Include what you did, what you expected, what happened instead, and the
version (`papeleria --version`) and platform. A minimal piece folder that
reproduces the problem is the most useful thing you can attach.

## What is in scope

- The local editor and serve servers: anything that lets a page on another
  origin, another user on the machine, or a piece folder itself read or
  change something it should not (the session token, files outside the
  approved set, the preview of another session).
- The build: a manifest or asset that makes the build read or write outside
  the piece folder, follow a link out of it, exhaust memory or time, or put
  executable content into the published output.
- The published output: script or markup injected through manifest text,
  Markdown, CSV, SVG or file names.
- The supply chain: the pinned dependencies, the vendored page-flip library
  and the CI workflow.

## What is not

- Running `papeleria` on a folder you do not trust is like opening it in any
  other tool: the manifest and assets are the author's own input. Findings
  that need a malicious piece folder are still welcome when they cross one of
  the lines above, since a shared piece may have more than one contributor.
- Anything a browser's own settings or extensions add to a page.

## Supported versions

The `main` branch. There is no released version yet; fixes land on `main`.
