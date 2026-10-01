#!/usr/bin/env node
/**
 * Retrieves the licence texts the native distribution has to carry, into
 * `licenses/`, and records where each came from (D36).
 *
 * The four in-scope `@img/sharp-libvips-*` packages declare LGPL-3.0-or-later
 * and ship no licence text at all, and the shared library they carry is built
 * from 28 upstream projects under at least six different licences. The texts
 * have to travel with the distribution, so they are fetched once, hashed, and
 * committed rather than assembled by hand at release time.
 *
 * Fetching only. It does not decide whether retaining them discharges anything;
 * that is a review, and a person records it in scripts/native-reviews.json.
 *
 * `licenses/index.json` has two owners (D126). This script owns `licenses`,
 * the SPDX texts; scripts/gen-notice.mjs owns `packages`, the licence files of
 * the npm packages whose code the package ships. Each rewrites the file whole
 * and keeps the other's section as it found it. A text already retained is
 * kept, bytes and retrieval date, unless `--refresh` asks for every text again:
 * a text the native reviews cite should change only when someone chose to.
 * `--check` fetches every text into memory and compares it, by SHA-256, with
 * its index entry and with the file on disk; it writes nothing (W5R-05).
 *
 * The texts are read at one commit of spdx/license-list-data, `SPDX_COMMIT`,
 * never at a branch, so `--refresh` and `--check` read the same bytes until
 * someone moves the pin, in a change of its own that shows the new commit
 * (security audit F13).
 *
 * Usage: node scripts/fetch-license-texts.mjs [--out <dir>] [--check] [--refresh]
 * Exit:  0 written or unchanged · 1 --check found drift · 2 fetch or IO failure
 */
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

/**
 * The commit the texts are read at. Checked on 2026-09-28: all fourteen texts
 * there are byte for byte the ones retained on 2026-09-22 and 2026-09-28 from
 * the `main` branch, which it was the head of that day.
 */
export const SPDX_COMMIT = '31ba1a50e5397e00a304dbadc76531740e89ee48';
const SPDX_TEXT = `https://raw.githubusercontent.com/spdx/license-list-data/${SPDX_COMMIT}/text`;

/**
 * Why each text is here. The first three carry conditions the distribution must
 * satisfy; the rest are attribution licences of components inside the same
 * binary, which still have to be reproduced. IJG and libtiff joined at M5.3,
 * when the components were attributed to their texts one by one (issue 002 A3).
 */
export const REQUIRED = [
  {id: 'LGPL-3.0-or-later', why: 'declared by the four in-scope @img/sharp-libvips-* packages, and by libvips, glib, pango, librsvg, libexif, libheif, fribidi and proxy-libintl inside the bundled library'},
  {id: 'GPL-3.0-or-later', why: 'the LGPL-3.0 is written as a set of additional permissions on top of the GPL-3.0 and incorporates it by reference, so the GPL text has to travel with it'},
  {id: 'MPL-2.0', why: 'cairo, inside the bundled shared library'},
  {id: 'Apache-2.0', why: 'sharp itself and the @img/sharp-<platform> binaries'},
  {id: 'MIT', why: 'cgif, expat, harfbuzz, lcms, libffi, libnsgif, libultrahdr, libxml2, pixman and others inside the bundled library'},
  {id: 'BSD-2-Clause', why: 'libarchive, libimagequant and the aom terms'},
  {id: 'BSD-3-Clause', why: 'highway, libwebp and part of mozjpeg'},
  {id: 'Zlib', why: 'zlib-ng and part of mozjpeg'},
  {id: 'libpng-2.0', why: 'libpng'},
  {id: 'FTL', why: 'freetype'},
  {id: 'ISC', why: 'several author-runtime npm dependencies'},
  {id: '0BSD', why: 'tslib, reached through the sharp WebAssembly build'},
  {id: 'IJG', why: 'part of mozjpeg, which its README lists under the zlib, IJG and BSD 3-Clause licences'},
  {id: 'libtiff', why: 'libtiff, which the package READMEs list under the libtiff License'},
];

const COMMENT = [
  'Licence texts retained for distribution (D36, D126). Presence of a text is a fact. Whether retaining it',
  'discharges an obligation is a review, recorded by a person in scripts/native-reviews.json. This file decides nothing.',
  'licenses: SPDX texts, fetched by scripts/fetch-license-texts.mjs. packages: the licence files of npm packages',
  'whose code or data the npm package ships, copied by scripts/gen-notice.mjs. Each script keeps the other\'s section.',
  'THIRD_PARTY.md is generated from this index and the licence inventory (docs/evidence/license-inventory.json).',
];

async function fetchText(id) {
  const url = `${SPDX_TEXT}/${id}.txt`;
  const response = await fetch(url, {redirect: 'follow'});
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}`);
  }
  const text = await response.text();
  if (text.trim().length < 200) {
    throw new Error(`${url} returned only ${text.length} characters`);
  }
  return {url, text};
}

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/** The index as it stands, or an empty one. */
export function readIndex(outDirectory) {
  const indexPath = join(outDirectory, 'index.json');
  if (!existsSync(indexPath)) {
    return {};
  }
  return JSON.parse(readFileSync(indexPath, 'utf8'));
}

/** An entry already retained, whose file is still the bytes it records. */
function retained(outDirectory, existing, id) {
  const entry = (existing.licenses ?? []).find((candidate) => candidate.spdxId === id);
  if (entry === undefined) return null;
  const path = join(outDirectory, entry.file);
  return existsSync(path) && sha256(readFileSync(path)) === entry.sha256 ? entry : null;
}

export async function fetchAll(outDirectory, {refresh = false, write = true} = {}) {
  if (write) {
    mkdirSync(outDirectory, {recursive: true});
  }
  const existing = readIndex(outDirectory);
  const entries = [];
  const fetched = [];
  for (const {id, why} of REQUIRED) {
    const kept = refresh ? null : retained(outDirectory, existing, id);
    if (kept !== null) {
      entries.push({...kept, why});
      continue;
    }
    const {url, text} = await fetchText(id);
    const file = `${id}.txt`;
    if (write) {
      writeFileSync(join(outDirectory, file), text);
    }
    fetched.push(id);
    entries.push({
      spdxId: id,
      file,
      sha256: sha256(text),
      bytes: Buffer.byteLength(text),
      retrievedFrom: url,
      retrievedOn: new Date().toISOString().slice(0, 10),
      why,
    });
  }
  return {entries, fetched, existing};
}

/** The whole index: this script's comment, source and texts, and every other section as it was. */
export function indexDocument(entries, existing = {}) {
  const {$comment: _comment, source: _source, licenses: _licenses, ...others} = existing;
  return `${JSON.stringify({$comment: COMMENT, source: 'SPDX license-list-data', licenses: entries, ...others}, null, 2)}\n`;
}

async function main(argv) {
  const check = argv.includes('--check');
  const refresh = argv.includes('--refresh') || check;
  const outIndex = argv.indexOf('--out');
  const outDirectory = resolve(
    outIndex >= 0 ? argv[outIndex + 1] : join(import.meta.dirname, '..', 'licenses'),
  );
  let result;
  try {
    result = await fetchAll(outDirectory, {refresh, write: !check});
  } catch (error) {
    process.stderr.write(`fetch-license-texts: ${error.message}\n`);
    return 2;
  }
  const {entries, fetched, existing} = result;
  const indexPath = join(outDirectory, 'index.json');
  process.stdout.write(`licence texts: ${entries.length} retained in ${outDirectory}; ${fetched.length} fetched now\n`);
  for (const entry of entries) {
    process.stdout.write(`  ${entry.spdxId.padEnd(20)} ${String(entry.bytes).padStart(7)} bytes  ${entry.sha256.slice(0, 16)}${fetched.includes(entry.spdxId) ? '  fetched' : ''}\n`);
  }
  if (check) {
    // Upstream, fetched into memory, against what is retained: the index entry
    // and the file on disk, each by SHA-256, never the retrieval dates. Nothing
    // is written, so a difference is reported and left for someone to choose;
    // a text edited on disk is one too, even while upstream and the index agree
    // (W5R-05).
    const retainedEntries = new Map((existing.licenses ?? []).map((entry) => [entry.spdxId, entry]));
    const drift = [];
    for (const entry of entries) {
      const kept = retainedEntries.get(entry.spdxId);
      const file = kept?.file ?? entry.file;
      const path = join(outDirectory, file);
      const onDisk = existsSync(path) ? sha256(readFileSync(path)) : null;
      const where = [
        ...(kept?.sha256 === entry.sha256 ? [] : ['index.json']),
        ...(onDisk === entry.sha256 ? [] : [onDisk === null ? `${file} missing` : `${file} on disk`]),
      ];
      if (where.length > 0) {
        drift.push(`${entry.spdxId} (${where.join(', ')})`);
      }
    }
    for (const id of retainedEntries.keys()) {
      if (!entries.some((entry) => entry.spdxId === id)) {
        drift.push(`${id} (retained, no longer required)`);
      }
    }
    if (drift.length === 0) {
      process.stdout.write('check: the retained texts match upstream, in index.json and on disk\n');
      return 0;
    }
    process.stdout.write(`check: the retained texts differ from upstream: ${drift.join(', ')}\n`);
    return 1;
  }
  writeFileSync(indexPath, indexDocument(entries, existing));
  process.stdout.write(`written: ${indexPath}\n`);
  return 0;
}

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href) {
  process.exitCode = await main(process.argv.slice(2));
}
