/**
 * The lines the visual golden test prints for a capture that has no baseline,
 * and that `test/golden/extract-captures.mjs` reads back (A4, D70). One
 * format, shared, so the two cannot drift apart.
 */
import {createHash} from 'node:crypto';

export const CAPTURE_MARKER = 'PAPELERIA-CAPTURE';

/** Base64 characters per printed line. */
export const CAPTURE_CHUNK = 4000;

/** What a baseline was made on; the comparison runs only on the same. */
export type Platform = {
  readonly engine: string;
  readonly version: string;
  /** `process.platform`. */
  readonly os: string;
  /** `ID VERSION_ID` from /etc/os-release, or '' where there is none. */
  readonly osRelease: string;
};

export function platformLine(platform: Platform): string {
  return `${CAPTURE_MARKER}-PLATFORM ${JSON.stringify(platform)}`;
}

/** A capture as printable lines: its name, length and SHA-256, then base64 in chunks. */
export function captureLines(name: string, data: Uint8Array): string[] {
  const base64 = Buffer.from(data).toString('base64');
  const sha256 = createHash('sha256').update(data).digest('hex');
  const lines = [`${CAPTURE_MARKER}-BEGIN ${name} ${data.length} ${sha256}`];
  for (let start = 0; start < base64.length; start += CAPTURE_CHUNK) {
    lines.push(`${CAPTURE_MARKER} ${base64.slice(start, start + CAPTURE_CHUNK)}`);
  }
  lines.push(`${CAPTURE_MARKER}-END ${name}`);
  return lines;
}
