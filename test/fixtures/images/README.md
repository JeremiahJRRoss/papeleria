# Image fixtures (M1.4)

No binary image is committed here. `generate.ts` builds every source with the locked sharp when a test runs, so the fixtures cost no repository weight and cannot drift from the code that reads them. Each builder is deterministic on one toolchain.

| Builder | Used for |
| --- | --- |
| `pngSource`, `webpSource` | Gradients with real detail at any size: widths, aspect ratio, quality, names, cold/warm byte identity |
| `jpegSource(w, h, orientation?)` | EXIF and XMP that must be stripped, and EXIF orientation that must be applied |
| `p3Source` | A Display P3 PNG whose derivative must come out in sRGB with no profile |
| `animatedWebpSource` | Two frames: refused as `animated` |
| `apngSource` | A two-frame APNG, which libvips reads as a still PNG: refused as `animated` by its `acTL` chunk |
| `truncatedJpegSource` | Header intact, pixels cut short: probes, then fails to decode |
| `gifSource`, `SVG_MARKUP` | Formats the raster path refuses before sharp sees them |
| `pngHeaderOnly(w, h)` | A PNG header declaring any size over one short scanline: it probes, it never decodes. Used for the 100,000,000-pixel boundary, the WebP height limit and the exact 100 MiB file |

Oversized files (over 100 MiB) are created as sparse files in a temporary directory by the test itself.
