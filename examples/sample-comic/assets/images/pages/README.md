The eight pages, `01.png` to `08.png`, are prototype art drawn by `scripts/gen-sample-comic.mjs` (M4.5, D102). Every page says "Placeholder art, generated"; none carries an owner mark, a third-party image or a name that could pass for a credit; and the sample is never presented as published work (PRD §11). The manifest credits the pages as "Placeholder art, generated", with the rights note "Prototype art from scripts/gen-sample-comic.mjs; no rights claimed".

Each page is 1600 × 2200 px: the title "The ferry · prototype", the page number, the panel frames exactly at the boxes in `papeleria.yaml` (the script reads them from there), and in each panel a scene hint made of lines and simple shapes, after the page's alternative text and the panel's transcript. The lettering is drawn as paths from a small stroke font in the script, so no installed font can change a pixel, and nothing is random.

To regenerate, from the repository root:

```sh
npm run gen:sample-comic              # builds, draws the eight pages, checks the phone-image budget
npm run gen:sample-comic -- --check   # compares with the committed pages and writes nothing
```

The script draws every page twice and fails unless the bytes are identical, and it derives each page as a build would and fails if any 800 px derivative (WebP, and AVIF where the encoder works) is larger than 307,200 bytes, the comic phone-image budget (IC04). Identical bytes are promised on one machine and toolchain, not across platforms: another libvips, librsvg or zlib may write other PNG bytes for the same drawing, so `--check` can differ there without a change. Commit regenerated pages only when the drawing changed.
