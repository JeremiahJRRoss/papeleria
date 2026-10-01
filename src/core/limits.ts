/**
 * IC01 input limits, in one place (D159). They are independent of the output
 * budgets in IC04. Each limit has one owner: file bytes are enforced where the
 * file is read (`FileAccess` with `maxBytes`), CSV rows by `csv.ts`, decoded
 * pixels by `images.ts` (an SVG's viewBox by `svg.ts`), the manifest's size,
 * depth and list lengths by `manifest.ts`, and the Markdown a piece's text
 * fields hold by `resolve.ts`. Every limit is inclusive: a value equal to it
 * passes.
 */
export const INPUT_LIMITS = Object.freeze({
  /** Manifest bytes. */
  manifestBytes: 1_048_576,
  /** Bytes of each Markdown or CSV file. */
  textBytes: 5_242_880,
  /** CSV data rows in one file. */
  csvRows: 100_000,
  /** Slides, pages or sections in one piece. */
  items: 1_000,
  /** Nested collections, counting the root mapping as 1. */
  depth: 32,
  /** Bytes of one image or video file. */
  mediaBytes: 104_857_600,
  /** Pixels one image may decode to. */
  imagePixels: 100_000_000,
  /** Markdown bytes in all of a piece's text fields, a file counted once for each field that names it (D164). */
  pieceMarkdownBytes: 20_971_520,
});

/** A byte count for a message: "5 MiB", or "5.25 MiB". */
export function mebibytes(bytes: number): string {
  const value = bytes / 1_048_576;
  return `${Number.isInteger(value) ? value : value.toFixed(2)} MiB`;
}
