/**
 * The characters the shipped Inter draws: every code point that a face of
 * theme/css/fonts.css maps to a glyph inside its own unicode-range, read from
 * the cmap tables of the WOFF2 files. A range only says a face may hold a
 * character; one the file has no glyph for, such as U+2030, U+2031 or U+FFFD,
 * is drawn by a fallback face whose width depends on the machine, so the
 * advance table (D48) can only be checked against Inter for these characters.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {brotliDecompressSync} from 'node:zlib';

import {applicationRoot} from '../../helpers/paths.js';

/** WOFF2 table directory flags: the known-table index of cmap, glyf and loca, and "tag follows". */
const CMAP = 0;
const GLYF = 10;
const LOCA = 11;
const ARBITRARY_TAG = 63;

/** The decompressed cmap table of a WOFF2 file (W3C WOFF2, §4 and §5). */
function woff2Cmap(file: Buffer): Buffer {
  if (file.readUInt32BE(0) !== 0x774f4632) {
    throw new Error('not a WOFF2 file');
  }
  const tables = file.readUInt16BE(12);
  const compressedSize = file.readUInt32BE(20);
  let offset = 48;
  const base128 = (): number => {
    let value = 0;
    for (let index = 0; index < 5; index += 1) {
      const byte = file[offset++]!;
      value = value * 128 + (byte & 0x7f);
      if ((byte & 0x80) === 0) {
        return value;
      }
    }
    throw new Error('a UIntBase128 longer than five bytes');
  };
  // Each table is stored whole, one after another, in one Brotli stream; a
  // transformed table (glyf and loca by default, hmtx on request) with its
  // transformed length.
  const entries: {known: number; length: number}[] = [];
  for (let index = 0; index < tables; index += 1) {
    const flags = file[offset++]!;
    const known = flags & 0x3f;
    const version = flags >> 6;
    if (known === ARBITRARY_TAG) {
      offset += 4;
    }
    const length = base128();
    const transformed = known === GLYF || known === LOCA ? version === 0 : version !== 0;
    entries.push({known, length: transformed ? base128() : length});
  }
  const stream = brotliDecompressSync(file.subarray(offset, offset + compressedSize));
  let start = 0;
  for (const {known, length} of entries) {
    if (known === CMAP) {
      return stream.subarray(start, start + length);
    }
    start += length;
  }
  throw new Error('no cmap table');
}

/** The code points a cmap maps to a glyph other than .notdef, from its Unicode format 12 or format 4 subtable. */
function mappedCodePoints(cmap: Buffer): Set<number> {
  let subtable: number | null = null;
  let format = 0;
  for (let index = 0; index < cmap.readUInt16BE(2); index += 1) {
    const platform = cmap.readUInt16BE(4 + index * 8);
    const encoding = cmap.readUInt16BE(6 + index * 8);
    const at = cmap.readUInt32BE(8 + index * 8);
    const kind = cmap.readUInt16BE(at);
    const unicode = platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10));
    if (unicode && (kind === 12 || (kind === 4 && format !== 12))) {
      subtable = at;
      format = kind;
    }
  }
  if (subtable === null) {
    throw new Error('no Unicode cmap subtable');
  }
  const mapped = new Set<number>();
  if (format === 12) {
    for (let group = 0; group < cmap.readUInt32BE(subtable + 12); group += 1) {
      const at = subtable + 16 + group * 12;
      const [first, last, glyph] = [cmap.readUInt32BE(at), cmap.readUInt32BE(at + 4), cmap.readUInt32BE(at + 8)];
      for (let code = first; code <= last; code += 1) {
        if (glyph + code - first !== 0) {
          mapped.add(code);
        }
      }
    }
    return mapped;
  }
  const segments = cmap.readUInt16BE(subtable + 6) / 2;
  const ends = subtable + 14;
  const starts = ends + segments * 2 + 2;
  const deltas = starts + segments * 2;
  const rangeOffsets = deltas + segments * 2;
  for (let segment = 0; segment < segments; segment += 1) {
    const end = cmap.readUInt16BE(ends + segment * 2);
    const first = cmap.readUInt16BE(starts + segment * 2);
    const delta = cmap.readUInt16BE(deltas + segment * 2);
    const rangeOffset = cmap.readUInt16BE(rangeOffsets + segment * 2);
    for (let code = first; code <= end && code !== 0xffff; code += 1) {
      let glyph: number;
      if (rangeOffset === 0) {
        glyph = (code + delta) & 0xffff;
      } else {
        glyph = cmap.readUInt16BE(rangeOffsets + segment * 2 + rangeOffset + (code - first) * 2);
        glyph = glyph === 0 ? 0 : (glyph + delta) & 0xffff;
      }
      if (glyph !== 0) {
        mapped.add(code);
      }
    }
  }
  return mapped;
}

/** Every code point Inter draws in the theme, in code point order. */
export function interCodePoints(): number[] {
  const css = readFileSync(join(applicationRoot, 'theme', 'css', 'fonts.css'), 'utf8');
  const drawn = new Set<number>();
  for (const [, block = ''] of css.matchAll(/@font-face\s*\{([^}]*)\}/g)) {
    if (!/font-family:\s*["']?Inter\b/.test(block)) {
      continue;
    }
    const file = /url\(\.\.\/fonts\/([\w.-]+)\)/.exec(block)?.[1];
    const range = /unicode-range:([^;]*);/.exec(block)?.[1];
    if (file === undefined || range === undefined) {
      throw new Error(`an Inter face without a font file or unicode-range: ${block}`);
    }
    const ranges = range.split(',').map((part) => {
      const [first = '', last] = part.trim().replace(/^U\+/i, '').split('-');
      return [Number.parseInt(first, 16), Number.parseInt(last ?? first, 16)] as const;
    });
    for (const code of mappedCodePoints(woff2Cmap(readFileSync(join(applicationRoot, 'theme', 'fonts', file))))) {
      if (ranges.some(([first, last]) => first <= code && code <= last)) {
        drawn.add(code);
      }
    }
  }
  return [...drawn].sort((a, b) => a - b);
}
