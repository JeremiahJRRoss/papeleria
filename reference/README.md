# Reference

One page of the design kit's HTML is kept here, `decks/brand-overview.html`: the brand overview deck, which the deck template reproduces. It is a test fixture, and nothing here is edited.

| File | Used by |
| --- | --- |
| `decks/brand-overview.html` | The A4 golden test, which compares `examples/brand-overview`, built by the CLI, against it, with every deliberate difference recorded in `docs/REFERENCE_COMPATIBILITY.md` and `test/golden/brand-overview.allowlist.json`; the deck render test; the deck browser fixture; and `npm run check:brand-overview-content` |

It stays at this path because its relative links (`../../theme/…`) resolve from here when the golden test opens it in a browser. The rest of the kit, the other deck, the document templates, the block examples and the guides, is kept in the development record, the Dev_Papeleria repository, under `Dev_Docs/reference/`.

Adapted from the Ross.moda design language kit, authored by JR (Jeremiah Ross). The Ross.moda name and marks are not included.
