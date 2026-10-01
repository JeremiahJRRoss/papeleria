# Brand

Owner-exclusive marks and settings belong here; their rights remain outside the code license under TRADEMARKS.md. Public clones currently contain no owner-exclusive marks.

The tool takes its default wordmark from theme/brand.default.json: papeleria. An owner override may use brand/brand.json:

```json
{ "wordmark": "your name" }
```

R12 protects an explicit SHA-256 inventory, brand/owner-assets.sha256, when owner assets are supplied. Hash-matching copies outside brand, including output/examples, fail. Absence of that inventory means no owner-exclusive assets are supplied; it is not permission to introduce unidentified owner marks.

The public theme default and theme/marks/papeleria-favicon.svg are intentional exceptions, and independent client logos in a piece’s assets/images/logos are allowed. References to Ross.moda in attribution text are also allowed. A published fork replaces the Papeleria name, default wordmark and favicon according to TRADEMARKS.md.

A filename/keyword ban is not the brand check. A hash check cannot establish rights in transformed derivatives; those require review. See decision D05 and acceptance item A11 in the development record.
