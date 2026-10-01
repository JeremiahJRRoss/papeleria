#!/usr/bin/env node
/**
 * The final R11 licence inventory (M5.3, DEP06, D125).
 *
 * One machine-readable record of everything third-party that the npm package
 * ships, installs or builds with, written to docs/evidence/license-inventory.json:
 *
 *   npm        every lockfile entry: scope, the SPDX expression as declared and
 *              where, the evaluation scripts/license-check.mjs made of it, the
 *              licence files with their SHA-256, what each text reads as, the
 *              copyright lines it gives, and the text that is retained
 *   vendored   vendor/*, emitted into comics (D100)
 *   fonts      the eight WOFF2 files, with what their own name, OS/2 and head
 *              tables say (observed facts, not provenance)
 *   copied     third-party material inside Papeleria's own files, which no
 *              lockfile shows: D41's d3 locale definitions, the engine's four
 *              layout rules in comic.css (D109)
 *   bundled    the package installations whose code is inside a file the npm
 *              package ships: lib/clients/editor/editor.js, read from the
 *              esbuild path comments in the shipped file itself
 *   native     sharp's platform packages and the components inside their
 *              prebuilt binaries, built on scripts/native-observations.json and
 *              docs/evidence/native-source-index.json rather than read again
 *   gaps       what is missing or differs, for the owner to review
 *
 * The file is the same on every platform: a lockfile entry that npm installs
 * only on some platforms (an `os` or `cpu` field) is described from the
 * lockfile and the recorded observations, never from node_modules, and nothing
 * records a date, an absolute path, the tool's version or the lockfile's hash.
 *
 * It decides nothing. The evaluation is license-check's own (the same function
 * runs `npm run check:licenses`), a gap is recorded rather than failed, and
 * no review status is read as more than it says (D34, D36).
 *
 * Usage: node scripts/license-inventory.mjs [--check] [--root <dir>] [--out <file>]
 *          [--exceptions <file>] [--evidence <file>] [--scope <file>]
 *          [--observations <file>] [--reviews <file>]
 *          [--source-index <file>] [--licences-index <file>] [--bundle <file>]
 * Exit:  0 written, or current with --check · 1 stale with --check, or a
 *        licence R11 refuses · 2 usage or IO
 */
import {createHash} from 'node:crypto';
import {existsSync, lstatSync, readdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {brotliDecompressSync} from 'node:zlib';

import {checkLicenses, evaluateSpdx, FONT_FAMILIES, parseSpdx} from './license-check.mjs';
import {NativeConfigError, observationKey} from './native-reconcile.mjs';
import {parseVersion} from './vendor-page-flip.mjs';

class UsageError extends Error {}

const APPLICATION_ROOT = join(import.meta.dirname, '..');

/** Licence texts a package keeps at its top level; NOTICE files are Apache-2.0 §4(d)'s, and kept apart. */
const LICENCE_FILE = /^(?:LICEN[CS]E|COPYING|UNLICENSE)(?:[.-][A-Za-z0-9.]+)?$/i;
const NOTICE_FILE = /^NOTICE(?:[.-][A-Za-z0-9.]+)?$/i;

/** sharp and its platform packages: what native-observations.json describes (D34). */
const NATIVE_PACKAGE = /^(?:@img\/sharp-|sharp$)/;

/** The shipped file whose third-party code the inventory reads (D76). */
export const EDITOR_BUNDLE = 'lib/clients/editor/editor.js';

/**
 * Third-party material inside Papeleria's own files. A lockfile scan cannot
 * see it, so it is listed here, and each entry names a marker that must still
 * be in the file, so the list cannot outlive what it describes.
 */
export const COPIED = Object.freeze([
  Object.freeze({
    what: "The CSV record scanner's token loop, a line-for-line port of d3-dsv's parseRows with position bookkeeping added (IC01); found by the attribution-marker check (D182)",
    package: 'd3-dsv',
    version: '3.0.1',
    from: ['src/dsv.js'],
    into: 'src/core/csv.ts',
    ships: ['lib/src/core/csv.js'],
    marker: 'Adapted from d3-dsv 3.0.1 (ISC licence',
  }),
  Object.freeze({
    what: 'Chart number formats, en-US and es-ES locale definitions (D41)',
    package: 'd3-format',
    version: '3.1.2',
    from: ['locale/en-US.json', 'locale/es-ES.json'],
    into: 'src/core/charts.ts',
    ships: ['lib/src/core/charts.js'],
    marker: 'copied from d3-format 3.1.2 and',
  }),
  Object.freeze({
    what: 'Chart date formats, en-US and es-ES locale definitions (D41)',
    package: 'd3-time-format',
    version: '4.1.0',
    from: ['locale/en-US.json', 'locale/es-ES.json'],
    into: 'src/core/charts.ts',
    ships: ['lib/src/core/charts.js'],
    marker: 'd3-time-format 4.1.0 (`locale/en-US.json`, `locale/es-ES.json`)',
  }),
  Object.freeze({
    what: "The closing lines of markdown-it-footnote's footnote_tail rule, which emit the plugin's own tokens, inside Papeleria's linear rewrite of that rule (D164(e)); found by the similarity scan (D144)",
    package: 'markdown-it-footnote',
    version: '4.0.0',
    from: ['index.mjs'],
    into: 'src/core/markdown.ts',
    ships: ['lib/src/core/markdown.js'],
    marker: 'Adapted from markdown-it-footnote 4.0.0 (MIT licence',
  }),
  Object.freeze({
    what: "The page-turn engine's four layout rules, restated because the editor's preview refuses the style element the engine adds (D109)",
    component: 'vendor/page-flip',
    into: 'templates/comic/comic.css',
    ships: ['templates/comic/comic.css', 'every comic dist/ as theme/css/comic.css'],
    marker: 'StPageFlip 2.0.7 (MIT; vendor/page-flip/LICENSE)',
  }),
]);

/**
 * The licence names the sharp-libvips package READMEs give their components,
 * as SPDX expressions, and the retained texts (by SPDX identifier in
 * licenses/index.json) each needs. `missing` names a text that has no SPDX
 * form here and is not retained. The READMEs say LGPLv3 is used "via the 'any
 * later version' clause of the LGPLv2 or LGPLv2.1", and LGPL-3.0 incorporates
 * the GPL-3.0 by reference, so both texts travel.
 */
export const README_LICENCES = new Map([
  ['LGPLv3', {spdx: 'LGPL-3.0-or-later', texts: ['LGPL-3.0-or-later', 'GPL-3.0-or-later'], weakCopyleft: true}],
  ['Mozilla Public License 2.0', {spdx: 'MPL-2.0', texts: ['MPL-2.0'], weakCopyleft: true}],
  ['MIT License', {spdx: 'MIT', texts: ['MIT']}],
  ['BSD 2-Clause', {spdx: 'BSD-2-Clause', texts: ['BSD-2-Clause']}],
  ['BSD 3-Clause', {spdx: 'BSD-3-Clause', texts: ['BSD-3-Clause']}],
  ['New BSD License', {spdx: 'BSD-3-Clause', texts: ['BSD-3-Clause']}],
  ['BSD 2-Clause + Alliance for Open Media Patent License 1.0', {spdx: 'BSD-2-Clause AND LicenseRef-AOM-Patent-License-1.0', texts: ['BSD-2-Clause'], missing: ['the Alliance for Open Media Patent License 1.0']}],
  ['zlib License', {spdx: 'Zlib', texts: ['Zlib']}],
  ['zlib License, IJG License, BSD 3-Clause', {spdx: 'Zlib AND IJG AND BSD-3-Clause', texts: ['Zlib', 'IJG', 'BSD-3-Clause']}],
  ['libpng License', {spdx: 'libpng-2.0', texts: ['libpng-2.0']}],
  ['freetype License (BSD-like)', {spdx: 'FTL', texts: ['FTL']}],
  ['fontconfig License (BSD-like)', {spdx: 'LicenseRef-fontconfig', texts: [], missing: ["fontconfig's own licence text (its COPYING file)"]}],
  ['libtiff License (BSD-like)', {spdx: 'libtiff', texts: ['libtiff']}],
]);

// ------------------------------------------------------------ texts ------

/**
 * The SPDX identifiers a licence file reads as, from the phrases each licence
 * is written in. It recognises the texts the locked tree ships and says so
 * when it does not recognise one; it never guesses from a file name.
 */
export function classifyLicenceText(text) {
  const flat = text.replace(/\s+/g, ' ').toLowerCase();
  const has = (phrase) => flat.includes(phrase);
  const ids = [];
  if (has('apache license') && (has('version 2.0') || has('version 2,'))) ids.push('Apache-2.0');
  // The OFL grants its permission in the same words, then says "of the Font Software"; MIT says "of this software".
  if (has('permission is hereby granted, free of charge, to any person obtaining a copy of this software')) ids.push('MIT');
  if (
    has('permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted') ||
    has('permission to use, copy, modify, and distribute this software for any purpose with or without fee is hereby granted')
  ) {
    ids.push(has('provided that the above copyright notice and this permission notice appear in all copies') ? 'ISC' : '0BSD');
  }
  if (has('redistribution and use in source and binary forms, with or without modification, are permitted')) {
    ids.push(has('neither the name') || has('endorse or promote products derived') ? 'BSD-3-Clause' : 'BSD-2-Clause');
  }
  if (has('python software foundation license version 2')) {
    ids.push(has('beopen.com license agreement') || has('cnri license agreement') ? 'Python-2.0' : 'PSF-2.0');
  }
  if (has('cc0 1.0 universal') || (has('creative commons') && has('cc0'))) ids.push('CC0-1.0');
  if (has('blue oak model license')) ids.push('BlueOak-1.0.0');
  if (has('attribution 4.0 international')) ids.push('CC-BY-4.0');
  if (has('this is free and unencumbered software released into the public domain')) ids.push('Unlicense');
  if (has('sil open font license') && has('version 1.1')) ids.push('OFL-1.1');
  if (has('mozilla public license') && (has('version 2.0') || has('v. 2.0'))) ids.push('MPL-2.0');
  if (has('gnu lesser general public license') && has('version 3')) ids.push('LGPL-3.0');
  if (has('gnu general public license') && !has('lesser general public license') && has('version 3')) ids.push('GPL-3.0');
  return [...new Set(ids)];
}

/** A copyright template left unfilled, which names nobody. */
const TEMPLATE = /\[yyyy\]|\{yyyy\}|<year>|\[year\]|\{year\}|\[name of copyright owner\]|<copyright holders?>|<owner>|<name of author>|\byyyy\b/i;
/** "Copyright" used as a word inside the licence's own terms, not as a notice. */
const NOT_A_NOTICE = /^copyright(?:\s*\(c\)|\s*©)?\s*(?:(?:license|licence|notices?|and|holders?|owners?|statements?|laws?|to|in|of|on|for|is|are|protection)\b|[,.;:]|$)/i;

/**
 * The copyright lines a licence text gives: a line that starts with a notice,
 * joined with the line after it while it ends on a comma, and a notice quoted
 * inside the terms, as the PSF licence quotes its own. Unfilled templates, such
 * as the Apache-2.0 appendix's `Copyright [yyyy] [name of copyright owner]`,
 * name nobody and are dropped.
 */
export function copyrightLines(text) {
  const found = [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n').map((line) => line.replace(/^[\s#*/>;-]+/, '').replace(/\s+/g, ' ').trim());
  for (let index = 0; index < lines.length; index += 1) {
    let line = lines[index];
    if (!/^(?:copyright\b|\(c\)\s*\d|©)/i.test(line) || TEMPLATE.test(line) || NOT_A_NOTICE.test(line)) {
      continue;
    }
    for (let next = index + 1; line.endsWith(',') && next < lines.length && next <= index + 2; next += 1) {
      if (lines[next] === '' || /^(?:copyright\b|\(c\)|©)/i.test(lines[next])) break;
      line = `${line} ${lines[next]}`;
    }
    found.push(line);
  }
  const flat = text.replace(/\s+/g, ' ');
  for (const match of flat.matchAll(/["“](Copyright (?:\(c\)|©) ?\d{4}[^"”]*)["”]/gi)) {
    if (!TEMPLATE.test(match[1])) {
      found.push(match[1].trim());
    }
  }
  // A quoted notice that a line already gave in full is the same notice.
  const unique = [...new Set(found)];
  return unique.filter((line) => !unique.some((other) => other !== line && other.startsWith(line)));
}

// ------------------------------------------------------------ fonts ------

/** The tags of the WOFF2 known-table index (W3C WOFF2 §5.2), in order. */
const WOFF2_TAGS = [
  'cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'glyf', 'loca', 'prep', 'CFF ', 'VORG', 'EBDT',
  'EBLC', 'gasp', 'hdmx', 'kern', 'LTSH', 'PCLT', 'VDMX', 'vhea', 'vmtx', 'BASE', 'GDEF', 'GPOS', 'GSUB', 'EBSC', 'JSTF', 'MATH',
  'CBDT', 'CBLC', 'COLR', 'CPAL', 'SVG ', 'sbix', 'acnt', 'avar', 'bdat', 'bloc', 'bsln', 'cvar', 'fdsc', 'feat', 'fmtx', 'fvar',
  'gvar', 'hsty', 'just', 'lcar', 'mort', 'morx', 'opbd', 'prop', 'trak', 'Zapf', 'Silf', 'Glat', 'Gloc', 'Feat', 'Sill',
];

/**
 * The tables of a WOFF2 file, decompressed: every table is stored whole, one
 * after another, in one Brotli stream, glyf and loca (and hmtx on request)
 * transformed, which the tables read here never are (W3C WOFF2 §4, §5).
 */
export function woff2Tables(bytes) {
  const file = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (file.length < 48 || file.readUInt32BE(0) !== 0x774f4632) {
    throw new UsageError('not a WOFF2 file');
  }
  const count = file.readUInt16BE(12);
  const compressedSize = file.readUInt32BE(20);
  let offset = 48;
  const base128 = () => {
    let value = 0;
    for (let index = 0; index < 5; index += 1) {
      const byte = file[offset++];
      if (byte === undefined) throw new UsageError('a WOFF2 table directory ends early');
      value = value * 128 + (byte & 0x7f);
      if ((byte & 0x80) === 0) return value;
    }
    throw new UsageError('a WOFF2 UIntBase128 is longer than five bytes');
  };
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    const flags = file[offset++];
    const known = flags & 0x3f;
    let tag = WOFF2_TAGS[known];
    if (known === 63) {
      tag = file.toString('latin1', offset, offset + 4);
      offset += 4;
    }
    const length = base128();
    const transformed = tag === 'glyf' || tag === 'loca' ? flags >> 6 === 0 : flags >> 6 !== 0;
    entries.push({tag, length: transformed ? base128() : length});
  }
  const stream = brotliDecompressSync(file.subarray(offset, offset + compressedSize));
  const tables = new Map();
  let start = 0;
  for (const {tag, length} of entries) {
    tables.set(tag, stream.subarray(start, start + length));
    start += length;
  }
  return tables;
}

/** The name table's strings, Windows Unicode English first (OpenType `name`). */
function nameStrings(table) {
  const count = table.readUInt16BE(2);
  const storage = table.readUInt16BE(4);
  const names = new Map();
  for (let index = 0; index < count; index += 1) {
    const at = 6 + index * 12;
    const platform = table.readUInt16BE(at);
    const language = table.readUInt16BE(at + 4);
    const id = table.readUInt16BE(at + 6);
    const bytes = table.subarray(storage + table.readUInt16BE(at + 10), storage + table.readUInt16BE(at + 10) + table.readUInt16BE(at + 8));
    let text;
    if (platform === 0 || platform === 3) {
      if (platform === 3 && language !== 0x0409) continue;
      text = '';
      for (let byte = 0; byte + 1 < bytes.length; byte += 2) text += String.fromCharCode(bytes.readUInt16BE(byte));
    } else {
      text = bytes.toString('latin1');
    }
    if (!names.has(id) || platform === 3) names.set(id, text);
  }
  return names;
}

/** OS/2 fsType, as the OpenType specification words each permission. */
function embedding(fsType) {
  const level = fsType & 0x000f;
  const words = level === 0 ? ['installable'] : [];
  if (level & 0x2) words.push('restricted license');
  if (level & 0x4) words.push('preview and print');
  if (level & 0x8) words.push('editable');
  if (fsType & 0x100) words.push('no subsetting');
  if (fsType & 0x200) words.push('bitmap embedding only');
  return words.join(', ');
}

/** What a font file says about itself: name table, vendor, embedding, revision and axes. */
export function fontFacts(bytes) {
  const tables = woff2Tables(bytes);
  const name = tables.get('name');
  const os2 = tables.get('OS/2');
  const head = tables.get('head');
  if (name === undefined || os2 === undefined || head === undefined) {
    throw new UsageError('a font without its name, OS/2 or head table');
  }
  const names = nameStrings(name);
  const pick = (id) => names.get(id);
  const facts = {
    copyright: pick(0),
    family: pick(1),
    subfamily: pick(2),
    uniqueId: pick(3),
    fullName: pick(4),
    version: pick(5),
    postScriptName: pick(6),
    trademark: pick(7),
    manufacturer: pick(8),
    designer: pick(9),
    description: pick(10),
    vendorUrl: pick(11),
    designerUrl: pick(12),
    licence: pick(13),
    licenceUrl: pick(14),
    vendorId: os2.toString('latin1', 58, 62).trim(),
    weightClass: os2.readUInt16BE(4),
    fsType: os2.readUInt16BE(8),
    embedding: embedding(os2.readUInt16BE(8)),
    fontRevision: (head.readInt32BE(4) / 65536).toFixed(3),
  };
  const fvar = tables.get('fvar');
  if (fvar !== undefined) {
    const axes = [];
    const first = fvar.readUInt16BE(4);
    for (let index = 0; index < fvar.readUInt16BE(8); index += 1) {
      const at = first + index * fvar.readUInt16BE(10);
      axes.push(`${fvar.toString('latin1', at, at + 4)} ${fvar.readInt32BE(at + 4) / 65536}–${fvar.readInt32BE(at + 12) / 65536}`);
    }
    facts.variableAxes = axes;
  }
  return Object.fromEntries(Object.entries(facts).filter(([, value]) => value !== undefined && value !== ''));
}

// ----------------------------------------------------------- bundles -----

/**
 * The package installations inside an esbuild bundle, from the `// path`
 * comment esbuild writes before the code of every input that contributes
 * bytes to an unminified bundle. An input it tree-shakes to nothing gets no
 * comment, and ships nothing.
 */
export function bundledInstallations(bundleText) {
  const found = new Set();
  for (const match of bundleText.matchAll(/^[ \t]*\/\/ ((?:\S*\/)?node_modules\/\S+)$/gm)) {
    const input = match[1];
    const at = input.lastIndexOf('node_modules/');
    const rest = input.slice(at + 'node_modules/'.length).split('/');
    const name = rest[0].startsWith('@') ? `${rest[0]}/${rest[1]}` : rest[0];
    found.add(`${input.slice(0, at)}node_modules/${name}`);
  }
  return [...found].sort();
}

/** Where the notice generator keeps a copy of a shipped package's licence file (D126). */
export function packageTextPath(name, version, file) {
  return `licenses/packages/${name}@${version}/${file}`;
}

// ---------------------------------------------------------- helpers ------

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Top-level licence and NOTICE files of an installed package, read. */
function packageTexts(root, path) {
  const directory = join(root, ...path.split('/'));
  const licences = [];
  const notices = [];
  for (const name of readdirSync(directory).sort(byName)) {
    const full = join(directory, name);
    if (!lstatSync(full).isFile()) continue;
    if (LICENCE_FILE.test(name) || NOTICE_FILE.test(name)) {
      const bytes = readFileSync(full);
      const record = {file: name, sha256: sha256(bytes), bytes: bytes.length, text: bytes.toString('utf8')};
      (LICENCE_FILE.test(name) ? licences : notices).push(record);
    }
  }
  return {licences, notices};
}

/** The copyright lines under a README's Licensing or License heading, for a licence text that gives none. */
function readmeCopyright(root, path) {
  const file = join(root, ...path.split('/'), 'README.md');
  if (!existsSync(file)) return [];
  const section = /^#{1,6}\s+Licen[cs](?:e|ing)\b[^\n]*\n([\s\S]*?)(?=^#{1,6}\s|(?![\s\S]))/im.exec(readFileSync(file, 'utf8'));
  return section === null ? [] : copyrightLines(section[1]);
}

function readJson(file, label) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new UsageError(`cannot read ${label} at ${file}: ${error.message}`);
  }
}

/** How an allowed expression was allowed: by the allowlist, the libvips list (D24) or a listed exception. */
function allowedVia(outcome) {
  if (outcome === null) return undefined;
  const listed = outcome.usedExceptions.filter((used) => used.kind === 'listed');
  if (listed.length > 0) return listed.map((used) => `${used.exception.status} exception for ${used.identifier}`).join('; ');
  if (outcome.usedExceptions.some((used) => used.kind === 'libvips')) return 'allowlist and the libvips list (D24)';
  return 'allowlist';
}

// --------------------------------------------------------- inventory -----

/**
 * Builds the inventory. Everything it reads is named in `files`; the result is
 * deterministic and holds no date, absolute path, tool version or lockfile hash.
 */
/** Whether a licence text that reads as `reads` stands for an identifier: GPL-3.0's text stands for GPL-3.0-or-later. */
const textStandsFor = (reads, identifier) => reads.some((read) => read === identifier || identifier.startsWith(`${read}-`));

/**
 * The licences of a declared expression that a package's own texts leave
 * without a text, evaluated as the expression says (R11's own evaluator):
 * every operand of an AND needs its text, and one alternative of an OR is
 * enough. Empty when the texts cover the expression.
 */
export function unrepresentedLicences(expression, reads) {
  const tree = parseSpdx(expression);
  if (evaluateSpdx(tree, (leaf) => textStandsFor(reads, leaf.identifier))) {
    return [];
  }
  // What is missing, so the gap can name it: an OR met on one side asks nothing of the other.
  const missing = (node) => {
    if (node.kind === 'licence') return textStandsFor(reads, node.identifier) ? [] : [node.identifier];
    const left = missing(node.left);
    const right = missing(node.right);
    return node.kind === 'or' && (left.length === 0 || right.length === 0) ? [] : [...left, ...right];
  };
  return [...new Set(missing(tree))];
}

export function buildInventory(files) {
  const root = files.root;
  const check = checkLicenses({
    root,
    exceptionsFile: files.exceptions,
    evidenceFile: files.evidence,
    scopeFile: files.scope,
    observationsFile: files.observations,
    reviewsFile: files.reviews,
  });
  const lock = readJson(join(root, 'package-lock.json'), 'the lockfile').packages ?? {};
  const gaps = [];
  const gap = (subject, text, owner) => gaps.push({subject, gap: text, owner});
  const index = existsSync(files.licences) ? readJson(files.licences, 'the licence index') : {licenses: []};
  const retainedById = new Map((index.licenses ?? []).map((entry) => [entry.spdxId, `licenses/${entry.file}`]));

  // --- the editor bundle's installations (D76): read from the shipped file.
  const bundlePath = files.bundle ?? join(root, ...EDITOR_BUNDLE.split('/'));
  const hasEditor = existsSync(join(root, 'src', 'editor', 'app.ts'));
  let bundled = [];
  if (existsSync(bundlePath)) {
    bundled = bundledInstallations(readFileSync(bundlePath, 'utf8'));
  } else if (hasEditor) {
    throw new UsageError(`${bundlePath} is missing; run npm run build, which writes it`);
  }
  const bundledSet = new Set(bundled);
  for (const path of bundled) {
    const entry = lock[path];
    if (entry === undefined) {
      check.failures.push({item: {packageName: path, version: null, scope: 'author-runtime', source: EDITOR_BUNDLE}, reason: `is inside ${EDITOR_BUNDLE} but not in package-lock.json`});
    } else if (entry.dev === true) {
      check.failures.push({item: {packageName: path, version: entry.version ?? null, scope: 'dev', source: EDITOR_BUNDLE}, reason: `is a development dependency, yet its code is inside ${EDITOR_BUNDLE}, which the package ships`});
    }
  }

  // --- copied material: d3's locale files and the engine's rules.
  const copiedPackages = new Map();
  const copied = [];
  for (const entry of COPIED) {
    const into = join(root, ...entry.into.split('/'));
    if (!existsSync(into)) continue;
    const present = readFileSync(into, 'utf8').includes(entry.marker);
    const record = {what: entry.what, into: entry.into, ships: entry.ships};
    if (entry.package !== undefined) {
      const installed = lock[`node_modules/${entry.package}`];
      Object.assign(record, {package: entry.package, version: entry.version, from: entry.from, license: installed?.license ?? null});
      if (installed?.version !== entry.version) {
        gap(`${entry.package}@${entry.version}`, `copied into ${entry.into} from ${entry.version}, but the lockfile holds ${installed?.version ?? 'no copy'}; compare the definitions before changing either`, 'Build maintainer');
      }
      copiedPackages.set(`node_modules/${entry.package}`, entry.into);
    } else {
      Object.assign(record, {component: entry.component, license: 'MIT'});
    }
    if (!present) {
      gap(entry.into, `no longer says where its copied material came from ("${entry.marker}")`, 'Build maintainer');
    }
    copied.push(record);
  }

  // --- npm: every lockfile entry once.
  const npm = [];
  for (const item of check.inventory) {
    const platformSpecific = item.os !== null || item.cpu !== null;
    const native = NATIVE_PACKAGE.test(item.packageName);
    // A development package stays `dev` wherever it runs; `optional-platform` is the author's machine's
    // per-platform packages, sharp's, which npm installs with Papeleria (D24, D34).
    const scope = item.scope === 'dev' ? 'dev' : platformSpecific || (native && item.packageName !== 'sharp') ? 'optional-platform' : item.scope;
    const evaluation = check.evaluations.get(item.path);
    const record = {
      name: item.packageName,
      version: item.version,
      path: item.path,
      scope,
      policyScope: item.scope,
    };
    if (platformSpecific) record.platform = {os: item.os ?? undefined, cpu: item.cpu ?? undefined};
    if (item.optional) record.optional = true;
    record.declared = item.declared;
    record.declaredIn = item.source.endsWith('package.json') ? 'package.json' : 'package-lock.json';
    if (evaluation?.identifiedBy) {
      record.identifiedBy = {evidence: 'scripts/license-evidence.json', file: evaluation.identifiedBy.file, sha256: evaluation.identifiedBy.sha256, identifies: evaluation.identifiedBy.identifies};
    }
    record.expression = evaluation?.expression ?? null;
    record.allowed = evaluation?.failure === null;
    const via = allowedVia(evaluation?.outcome ?? null);
    if (record.allowed && via !== undefined) record.allowedBy = via;

    const shipsCode = bundledSet.has(item.path) || copiedPackages.has(item.path);
    if (bundledSet.has(item.path)) record.bundledInto = [EDITOR_BUNDLE];
    if (copiedPackages.has(item.path)) record.copiedInto = [copiedPackages.get(item.path)];

    if (platformSpecific) {
      const observations = check.native.observations.records.filter((observation) => observation.package === item.packageName && observation.version === item.version);
      if (observations.length > 0) {
        record.inspected = 'scripts/native-observations.json';
        const texts = new Map();
        for (const observation of observations) {
          for (const file of observation.licenseFiles ?? []) {
            texts.set(file.path.replace(/^node_modules\/(?:@[^/]+\/)?[^/]+\//, ''), file.sha256);
          }
        }
        record.licenceFiles = [...texts].sort((a, b) => byName(a[0], b[0])).map(([file, digest]) => ({file, sha256: digest}));
      } else {
        record.inspected = 'package-lock.json only; a platform package npm installs on its own platform';
      }
    } else if (!item.installed) {
      throw new UsageError(`${item.path} is in the lockfile with no os or cpu, but not installed under ${root}; run npm ci`);
    } else {
      record.inspected = 'installed';
      const {licences, notices} = packageTexts(root, item.path);
      record.licenceFiles = licences.map(({file, sha256: digest, bytes, text}) => ({file, sha256: digest, bytes, readsAs: classifyLicenceText(text)}));
      if (notices.length > 0) record.noticeFiles = notices.map(({file, sha256: digest, bytes}) => ({file, sha256: digest, bytes}));
      const lines = [...new Set(licences.flatMap(({text}) => copyrightLines(text)))];
      if (lines.length > 0) {
        record.copyright = lines;
      } else {
        // An Apache-2.0 text names nobody; sharp's packages say who holds the copyright in their README.
        const readme = readmeCopyright(root, item.path);
        if (readme.length > 0) record.readmeCopyright = readme;
      }
      if (licences.length === 0) {
        gap(`${item.packageName}@${item.version}`, `declares ${item.declared ?? 'no licence'} and ships no licence text${shipsCode ? ', yet the package ships its code' : ''}`, 'Release maintainer');
      } else {
        const reads = [...new Set(record.licenceFiles.flatMap((file) => file.readsAs))];
        const missing = record.expression === null ? [] : unrepresentedLicences(record.expression, reads);
        if (reads.length === 0) {
          gap(`${item.packageName}@${item.version}`, `its licence text (${licences.map(({file}) => file).join(', ')}) is not one the inventory recognises; read it`, 'Release maintainer');
        } else if (missing.length > 0) {
          const kept = missing.filter((identifier) => retainedById.has(identifier)).map((identifier) => retainedById.get(identifier));
          gap(
            `${item.packageName}@${item.version}`,
            `declares ${record.expression}, but its own licence text reads as ${reads.join(' and ')}: the package carries no text for ${missing.join(' and ')}${kept.length > 0 ? ` (retained in Papeleria's ${kept.join(' and ')})` : ''}`,
            'Release maintainer',
          );
        }
        record.retained = shipsCode
          ? licences.map(({file}) => packageTextPath(item.packageName, item.version, file))
          : licences.map(({file}) => `${item.path}/${file}`);
      }
    }
    if (evaluation?.outcome?.usedExceptions.some((used) => used.kind === 'listed' && used.exception.status !== 'approved')) {
      gap(`${item.packageName}@${item.version}`, 'relies on a provisional licence exception, which blocks a release (D32)', 'Release owner');
    }
    npm.push(record);
  }

  // --- vendored components (D100).
  const vendored = [];
  for (const component of check.vendored) {
    const versionText = readFileSync(join(root, component.path, 'VERSION'), 'utf8');
    const pins = parseVersion(versionText);
    const licence = readFileSync(join(root, ...component.licenseFile.split('/')), 'utf8');
    const repository = pins.upstream_repository ?? null;
    vendored.push({
      component: component.path,
      name: repository === null ? component.packageName : repository.replace(/\/+$/, '').split('/').pop(),
      package: component.packageName,
      version: component.version,
      scope: 'vendored-published',
      policyScope: 'published-piece',
      upstream: repository,
      commit: pins.upstream_commit,
      file: pins.file === undefined ? undefined : {path: `${component.path}/${pins.file}`, sha256: pins.file_sha256, bytes: Number(pins.file_bytes)},
      declared: component.declared,
      allowed: true,
      licenceFile: {path: component.licenseFile, sha256: component.licenseSha256, readsAs: classifyLicenceText(licence)},
      copyright: copyrightLines(licence),
      emitted: [
        `line 2 of lib/clients/reader.js and lib/clients/reader-preview.js, byte for byte (D109)`,
        `every comic dist/: line 2 of reader.js, and ${component.licenseFile} at the same path (D108)`,
      ],
    });
  }

  // --- fonts (D18, D62), with what their own tables say.
  const fonts = [];
  for (const family of check.fonts) {
    const definition = FONT_FAMILIES.find((candidate) => candidate.family === family.packageName);
    const text = readFileSync(join(root, ...family.licenseFile.split('/')), 'utf8');
    const textCopyright = copyrightLines(text);
    const files = family.files.map((path) => {
      const bytes = readFileSync(join(root, ...path.split('/')));
      return {path, sha256: sha256(bytes), bytes: bytes.length, observed: fontFacts(bytes)};
    });
    const tableCopyright = [...new Set(files.map((file) => file.observed.copyright).filter(Boolean))];
    fonts.push({
      family: family.packageName,
      scope: 'font',
      policyScope: 'published-piece',
      declared: definition.spdx,
      allowed: true,
      licenceFile: {path: family.licenseFile, sha256: family.licenseSha256, readsAs: classifyLicenceText(text)},
      copyright: textCopyright,
      nameTableCopyright: tableCopyright,
      files,
    });
    for (const line of tableCopyright) {
      if (!textCopyright.includes(line)) {
        gap(`${family.packageName} (fonts)`, `the fonts' own name tables say "${line}", the retained ${family.licenseFile} says "${textCopyright.join('"; "')}"`, 'Release owner');
      }
    }
    gap(`${family.packageName} (fonts)`, 'the subset files were supplied without the recipe that made them (NOTICE.md); their provenance is not established by reading them', 'Release owner');
  }

  // --- native: sharp's packages from the observations, their components from the source index.
  const reviews = new Map(check.native.reviews.records.map((review) => [`${review.package}@${review.version}`, review]));
  const nativePackages = check.native.requirements.map((requirement) => {
    const observations = check.native.observations.records
      .filter((observation) => observation.package === requirement.package && observation.version === requirement.version)
      .sort((a, b) => byName(observationKey(a), observationKey(b)));
    const review = reviews.get(`${requirement.package}@${requirement.version}`);
    const record = {
      package: requirement.package,
      version: requirement.version,
      platform: requirement.platformKey,
      declared: requirement.declaredLicense,
      distributionScope: requirement.required ? 'required' : 'excluded',
    };
    if (requirement.excludedBy) record.excludedBy = requirement.excludedBy.decision;
    record.observations = observations.map((observation) => ({
      inspection: observation.inspection,
      observedFrom: observation.observedFrom,
      observedOn: observation.observedOn,
      licenceFiles: (observation.licenseFiles ?? []).length,
      nativeArtefacts: (observation.nativeArtefacts ?? []).length,
      bundledComponents: (observation.bundledComponents ?? []).length,
    }));
    record.review = review?.status ?? 'absent';
    if (requirement.required && observations.length > 0 && observations.every((observation) => (observation.licenseFiles ?? []).length === 0)) {
      gap(`${requirement.package}@${requirement.version}`, `declares ${requirement.declaredLicense} and ships no licence text of its own`, 'Release maintainer');
    }
    return record;
  });
  const lockedNative = new Set(check.native.requirements.map((requirement) => requirement.package));

  const sourceIndex = existsSync(files.sourceIndex) ? readJson(files.sourceIndex, 'the native source index') : {components: []};
  const components = [];
  for (const component of sourceIndex.components ?? []) {
    const inPackages = (component.inPackages ?? []).filter((name) => lockedNative.has(name)).sort(byName);
    if (inPackages.length === 0) continue;
    const readme = component.licenseFromPackageReadme ?? null;
    const mapping = readme === null ? undefined : README_LICENCES.get(readme);
    const record = {component: component.component, version: component.version, inPackages, licenceFromReadme: readme};
    if (mapping === undefined) {
      record.spdx = null;
      gap(`${component.component} ${component.version}`, readme === null ? 'the package READMEs give it no licence' : `"${readme}" is a licence name the inventory does not map to a text`, 'Release maintainer');
    } else {
      record.spdx = mapping.spdx;
      if (mapping.weakCopyleft) record.weakCopyleft = true;
      record.retained = mapping.texts.map((id) => retainedById.get(id) ?? null).filter((path) => path !== null);
      const absent = mapping.texts.filter((id) => !retainedById.has(id)).concat(mapping.missing ?? []);
      if (absent.length > 0) {
        record.notRetained = absent;
        gap(`${component.component} ${component.version}`, `no retained text for ${absent.join(' or ')}`, 'Release maintainer');
      }
    }
    if (component.upstreamLicence !== undefined) record.upstreamLicence = component.upstreamLicence;
    if (component.notEnumerated !== undefined) {
      record.notEnumerated = component.notEnumerated;
      gap(`${component.component} ${component.version}`, component.notEnumerated, 'Release maintainer');
    }
    if (component.upstream) record.upstream = component.upstream;
    components.push(record);
  }
  components.sort((a, b) => byName(`${a.component} ${a.version}`, `${b.component} ${b.version}`));
  if (components.length > 0) {
    gap(
      'components inside the prebuilt libvips binaries',
      "the retained texts are the SPDX licence texts; each component's own licence file, with its copyright lines, is not retained, and a binary distribution under BSD- or MIT-style terms reproduces those notices",
      'Release owner',
    );
  }

  // --- summary.
  const count = (list, key) => list.reduce((tally, item) => ({...tally, [item[key]]: (tally[item[key]] ?? 0) + 1}), {});
  gaps.sort((a, b) => byName(`${a.subject}|${a.gap}`, `${b.subject}|${b.gap}`));
  return {
    inventory: {
      $comment: [
        'The final R11 licence inventory (M5.3, DEP06, D125), generated by scripts/license-inventory.mjs. Do not edit by hand.',
        "Facts, not decisions: each licence's evaluation is scripts/license-check.mjs's own, gaps are recorded for the owner to review, and no native review status is read as more than it says (D34, D36).",
        'The same on every platform: an entry npm installs only on some platforms is described from package-lock.json and scripts/native-observations.json, never from node_modules.',
      ],
      generatedBy: 'scripts/license-inventory.mjs',
      summary: {
        npm: {total: npm.length, ...count(npm, 'scope')},
        vendored: vendored.length,
        fontFiles: fonts.reduce((total, family) => total + family.files.length, 0),
        fontFamilies: fonts.length,
        copied: copied.length,
        bundledInto: {[EDITOR_BUNDLE]: bundled.length},
        nativePackages: nativePackages.length,
        nativePackagesRequired: nativePackages.filter((record) => record.distributionScope === 'required').length,
        nativeReviewsVerified: nativePackages.filter((record) => record.distributionScope === 'required' && record.review === 'verified').length,
        nativeComponents: components.length,
        weakCopyleftComponents: components.filter((component) => component.weakCopyleft).length,
        gaps: gaps.length,
      },
      npm,
      vendored,
      fonts,
      copied,
      bundled: [{file: EDITOR_BUNDLE, installations: bundled}],
      native: {packages: nativePackages, components},
      gaps,
    },
    check,
  };
}

export function serialiseInventory(inventory) {
  return `${JSON.stringify(inventory, null, 2)}\n`;
}

/**
 * Compares the sharp packages installed under the root with their recorded
 * observations, by what was inspected: the integrity, and each artefact's and
 * licence text's SHA-256 by its path inside the package. Printed, never
 * written: it depends on which platform's packages are installed.
 */
export function installedNativeAgreement(root, observations) {
  const lock = readJson(join(root, 'package-lock.json'), 'the lockfile').packages ?? {};
  const results = [];
  const inside = (path) => path.replace(/^node_modules\/(?:@[^/]+\/)?[^/]+\//, '');
  for (const [path, entry] of Object.entries(lock)) {
    const name = path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
    if (!NATIVE_PACKAGE.test(name) || !existsSync(join(root, path, 'package.json'))) continue;
    const recorded = observations.filter((observation) => observation.package === name && observation.version === entry.version);
    if (recorded.length === 0) {
      results.push({package: name, version: entry.version, agrees: false, detail: 'no observation records it'});
      continue;
    }
    const expected = recorded.map((observation) =>
      [observation.integrity ?? '', ...[...(observation.nativeArtefacts ?? []), ...(observation.licenseFiles ?? [])].map((file) => `${inside(file.path)}:${file.sha256}`).sort()].join('\n'),
    );
    const files = [];
    const walk = (directory) => {
      for (const item of readdirSync(directory, {withFileTypes: true})) {
        const full = join(directory, item.name);
        if (item.isDirectory()) walk(full);
        else if (item.isFile()) files.push(full);
      }
    };
    walk(join(root, path));
    const relative = (full) => full.slice(join(root, path).length + 1).split('\\').join('/');
    const keep = files.filter((full) => /(^|\/)(LICEN[CS]E|COPYING|NOTICE)([.-][A-Za-z0-9.]+)?$/i.test(relative(full)) || ['.so', '.dylib', '.dll', '.node', '.wasm'].some((extension) => full.endsWith(extension) || full.includes(`${extension}.`)));
    const actual = [entry.integrity ?? '', ...keep.map((full) => `${relative(full)}:${sha256(readFileSync(full))}`).sort()].join('\n');
    results.push({package: name, version: entry.version, agrees: expected.includes(actual), detail: expected.includes(actual) ? 'the installed bytes are the observed ones' : 'the installed bytes differ from every observation of this version'});
  }
  return results.sort((a, b) => byName(a.package, b.package));
}

// ------------------------------------------------------------- main ------

const FLAGS = {
  '--root': 'root',
  '--out': 'out',
  '--exceptions': 'exceptions',
  '--evidence': 'evidence',
  '--scope': 'scope',
  '--observations': 'observations',
  '--reviews': 'reviews',
  '--source-index': 'sourceIndex',
  '--licences-index': 'licences',
  '--bundle': 'bundle',
};

export function parseArguments(argv) {
  const options = {check: false};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--check') {
      options.check = true;
      continue;
    }
    const key = FLAGS[flag];
    if (key === undefined) throw new UsageError(`unknown argument ${JSON.stringify(flag)}`);
    const value = argv[index + 1];
    if (value === undefined) throw new UsageError(`${flag} needs a path`);
    options[key] = resolve(value);
    index += 1;
  }
  const scripts = import.meta.dirname;
  return {
    check: options.check,
    root: options.root ?? APPLICATION_ROOT,
    out: options.out ?? join(APPLICATION_ROOT, 'docs', 'evidence', 'license-inventory.json'),
    exceptions: options.exceptions ?? join(scripts, 'license-exceptions.json'),
    evidence: options.evidence ?? join(scripts, 'license-evidence.json'),
    scope: options.scope ?? join(scripts, 'native-scope.json'),
    observations: options.observations ?? join(scripts, 'native-observations.json'),
    reviews: options.reviews ?? join(scripts, 'native-reviews.json'),
    sourceIndex: options.sourceIndex ?? join(APPLICATION_ROOT, 'docs', 'evidence', 'native-source-index.json'),
    licences: options.licences ?? join(APPLICATION_ROOT, 'licenses', 'index.json'),
    bundle: options.bundle ?? null,
  };
}

function main(argv) {
  let options;
  try {
    options = parseArguments(argv);
  } catch (error) {
    process.stderr.write(`license-inventory: ${error.message}\n`);
    process.stderr.write('usage: node scripts/license-inventory.mjs [--check] [--root <dir>] [--out <file>] [--exceptions <file>] [--evidence <file>]\n' +
      '         [--scope <file>] [--observations <file>] [--reviews <file>] [--source-index <file>] [--licences-index <file>] [--bundle <file>]\n');
    return 2;
  }
  let built;
  try {
    built = buildInventory(options);
  } catch (error) {
    const label = error instanceof NativeConfigError ? 'native review configuration: ' : '';
    process.stderr.write(`license-inventory: ${label}${error.message}\n`);
    return 2;
  }
  const {inventory, check} = built;
  const summary = inventory.summary;
  const scopes = Object.entries(summary.npm).filter(([key]) => key !== 'total').map(([scope, total]) => `${scope} ${total}`).join(', ');
  process.stdout.write(
    `licence inventory: ${summary.npm.total} lockfile entries (${scopes}); ${summary.vendored} vendored; ${summary.fontFiles} font files in ${summary.fontFamilies} families; ` +
      `${summary.copied} copied; ${summary.bundledInto[EDITOR_BUNDLE]} installations bundled into ${EDITOR_BUNDLE}; ${summary.nativePackages} native packages ` +
      `(${summary.nativePackagesRequired} in distribution scope, ${summary.nativeReviewsVerified} reviewed verified); ${summary.nativeComponents} components inside them, ` +
      `${summary.weakCopyleftComponents} weak-copyleft; ${summary.gaps} gap(s) for review\n`,
  );
  for (const agreement of installedNativeAgreement(options.root, check.native.observations.records)) {
    process.stdout.write(`  installed ${agreement.agrees ? 'ok ' : 'DIFFERS'} ${agreement.package}@${agreement.version}: ${agreement.detail}\n`);
  }
  if (check.failures.length > 0) {
    process.stdout.write(`R11 refuses ${check.failures.length} item(s); nothing written:\n`);
    for (const failure of check.failures) {
      process.stdout.write(`  ${failure.item.packageName}${failure.item.version ? `@${failure.item.version}` : ''} (${failure.item.scope}) ${failure.reason}\n`);
    }
    return 1;
  }
  const serialised = serialiseInventory(inventory);
  if (options.check) {
    const current = existsSync(options.out) ? readFileSync(options.out, 'utf8') : '';
    if (current === serialised) {
      process.stdout.write(`check: ${options.out} is current\n`);
      return 0;
    }
    process.stdout.write(`check: ${options.out} is stale; run node scripts/license-inventory.mjs and review the difference\n`);
    return 1;
  }
  writeFileSync(options.out, serialised);
  process.stdout.write(`written: ${options.out}\n`);
  return 0;
}

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href) {
  process.exitCode = main(process.argv.slice(2));
}

