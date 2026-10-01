#!/usr/bin/env node
/**
 * The code provenance review's checks B1 and B2 (review §5.3, issue 002 F5,
 * D181), which W5B left unadopted at M5.3 (D129).
 *
 *   B1  attribution markers: every line of own code (src/, templates/, theme/,
 *       scripts/ and test/, less test/fixtures/, the font door theme/fonts/,
 *       and this check, its allowlist and its tests, which quote the markers)
 *       that reads like a copy's declaration: "copied from", "adapted from",
 *       "based on", "ported from" or "a port of", "taken from", "line for
 *       line" or "step for step", Stack Overflow, CodePen, JSFiddle, a gist, a
 *       code-host URL other than this repository, @license, @author, or a
 *       copyright line
 *   B2  third-party shape: every code or markup file (.js, .mjs, .cjs, .ts,
 *       .mts, .cts, .css, .html, .htm, .svg) outside the declared doors
 *       (vendor/, theme/fonts/, licenses/) and generated trees (lib/,
 *       node_modules/) whose longest line is over 500 characters or whose size
 *       is over 100 KB: the shape of a pasted build
 *
 * A hit passes only when an entry in scripts/provenance-allowlist.json covers
 * it, and each entry is a reading: what the line or file is, and the decision
 * that admitted it. A B1 entry names the text of the line it read, and that
 * text holds the line's markers: it covers a line of its file that contains
 * the text and matches no marker the text does not, so a reworded line, or
 * one that gains a marker, is read again, and a reviewed line cannot be
 * swapped for a new declaration in the same file. An entry states how many
 * hits it covers, and a count that differs fails; an entry that covers
 * nothing fails too. A B1 entry that says a line declares a copy must name a
 * package or component that `COPIED` in scripts/license-inventory.mjs lists
 * for that file, so a copy cannot pass here without its row in
 * THIRD_PARTY.md §2.
 *
 * The files are those git tracks or would commit (`git ls-files --cached
 * --others --exclude-standard`), so ignored output never counts.
 *
 * Usage: node scripts/provenance-check.mjs [--root <dir>] [--allowlist <file>]
 * Exit:  0 pass · 1 a hit no entry covers, or an entry that is wrong · 2 usage or IO
 */
import {execFileSync} from 'node:child_process';
import {existsSync, readFileSync, statSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

import {COPIED} from './license-inventory.mjs';

class UsageError extends Error {}

const APPLICATION_ROOT = join(import.meta.dirname, '..');

/** B1's markers, one expression each. "Stack Overflow" is matched as the site's name, never the error. */
export const MARKERS = Object.freeze([
  Object.freeze({id: 'copied from', pattern: /\bcopied from\b/i}),
  Object.freeze({id: 'adapted from', pattern: /\badapted from\b/i}),
  Object.freeze({id: 'based on', pattern: /\bbased on\b/i}),
  Object.freeze({id: 'ported from', pattern: /\bport(?:ed)? (?:from|of)\b/i}),
  Object.freeze({id: 'taken from', pattern: /\btaken from\b/i}),
  Object.freeze({id: 'line for line', pattern: /\b(?:line[- ]for[- ]line|step[- ]for[- ]step)\b/i}),
  Object.freeze({id: 'Stack Overflow', pattern: /\bStack ?Overflow\b|\bstack(?:overflow|exchange)\.com\b/}),
  Object.freeze({id: 'CodePen', pattern: /\bcodepen\b/i}),
  Object.freeze({id: 'JSFiddle', pattern: /\bjsfiddle\b/i}),
  Object.freeze({id: 'gist', pattern: /\bgist\.github(?:usercontent)?\.com\b/i}),
  Object.freeze({id: 'code-host URL', pattern: /\b(?:github\.com|raw\.githubusercontent\.com|gitlab\.com|bitbucket\.org)\/(?!JeremiahJRRoss\/Dev_Papeleria(?:[/#?.)\s]|$))/i}),
  Object.freeze({id: '@license', pattern: /@license\b|\bSPDX-License-Identifier\b/i}),
  Object.freeze({id: '@author', pattern: /@author\b/i}),
  Object.freeze({id: 'copyright line', pattern: /\bCopyright\s*(?:\(c\)|©)|\bCopyright\s+(?:19|20)\d\d\b|©\s*(?:19|20)\d\d/i}),
]);

/** Where B1 reads: own code, less the fixtures, the font door, and this check, its allowlist and its tests, which quote the markers. */
const MARKER_ROOTS = ['src/', 'templates/', 'theme/', 'scripts/', 'test/'];
const MARKER_EXCLUDED = ['test/fixtures/', 'theme/fonts/', 'scripts/provenance-check.mjs', 'scripts/provenance-allowlist.json', 'test/unit/provenance-check.test.ts'];

/** What B2 reads: code and markup, outside the declared doors and generated trees. */
export const SHAPE_EXTENSIONS = Object.freeze(['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.css', '.html', '.htm', '.svg']);
const SHAPE_EXCLUDED = ['vendor/', 'theme/fonts/', 'licenses/', 'lib/'];
export const SHAPE_LIMITS = Object.freeze({line: 500, bytes: 100 * 1024});

/** The kinds of reading a B1 entry may give. */
export const MARKER_KINDS = Object.freeze(['copy', 'kit', 'provenance-tooling', 'not-a-copy']);

/** Every file git tracks or would commit under the root, by forward-slash path, that exists on disk. */
export function repositoryFiles(root) {
  const listed = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024});
  return [...new Set(listed.split('\0').filter((path) => path !== ''))]
    .filter((path) => existsSync(join(root, path)) && statSync(join(root, path)).isFile())
    .sort();
}

const inNodeModules = (path) => path.startsWith('node_modules/') || path.includes('/node_modules/');

/** Whether a file's bytes look like text: no NUL in its first 8 KB. */
function isText(bytes) {
  return !bytes.subarray(0, 8192).includes(0);
}

/** B1's hits: one per line that matches at least one marker. */
export function markerHits(root, files) {
  const hits = [];
  for (const path of files) {
    if (!MARKER_ROOTS.some((prefix) => path.startsWith(prefix)) || MARKER_EXCLUDED.some((prefix) => path.startsWith(prefix)) || inNodeModules(path)) {
      continue;
    }
    const bytes = readFileSync(join(root, path));
    if (!isText(bytes)) {
      continue;
    }
    const lines = bytes.toString('utf8').split('\n');
    lines.forEach((text, index) => {
      const markers = MARKERS.filter((marker) => marker.pattern.test(text)).map((marker) => marker.id);
      if (markers.length > 0) {
        hits.push({file: path, line: index + 1, markers, text: text.trim()});
      }
    });
  }
  return hits;
}

/** B2's hits: code or markup whose longest line or size is past the limits. */
export function shapeHits(root, files) {
  const hits = [];
  for (const path of files) {
    const extension = path.slice(path.lastIndexOf('.')).toLowerCase();
    if (!SHAPE_EXTENSIONS.includes(extension) || SHAPE_EXCLUDED.some((prefix) => path.startsWith(prefix)) || inNodeModules(path)) {
      continue;
    }
    const bytes = readFileSync(join(root, path));
    const longest = Math.max(...bytes.toString('utf8').split('\n').map((line) => line.length));
    if (longest > SHAPE_LIMITS.line || bytes.length > SHAPE_LIMITS.bytes) {
      hits.push({file: path, longest, bytes: bytes.length});
    }
  }
  return hits;
}

/** A glob with `**` (any folders) and `*` (within one name) as a regular expression. */
export function patternExpression(pattern) {
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    if (pattern.startsWith('**/', index)) {
      source += '(?:[^/]+/)*';
      index += 2;
    } else if (pattern[index] === '*') {
      source += '[^/]*';
    } else {
      source += pattern[index].replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`);
}

/** Problems with an entry's own fields, before it is matched. */
function entryProblems(entry, where, check) {
  const problems = [];
  if (typeof entry.reading !== 'string' || entry.reading.trim() === '') problems.push(`${where}: no reading`);
  if (typeof entry.decision !== 'string' || !/^D\d+/.test(entry.decision)) problems.push(`${where}: no decision row`);
  if (!Number.isInteger(entry.count) || entry.count < 1) problems.push(`${where}: no count of the hits it covers`);
  if (check === 'B1') {
    if (typeof entry.file !== 'string' || typeof entry.line !== 'string' || entry.line === '') {
      problems.push(`${where}: a B1 entry names a file and the text of the line it read`);
    } else if (!MARKERS.some((marker) => marker.pattern.test(entry.line))) {
      problems.push(`${where}: its line text holds no marker, so it names no line that was read`);
    }
    if (!MARKER_KINDS.includes(entry.kind)) problems.push(`${where}: kind is one of ${MARKER_KINDS.join(', ')}`);
    if (entry.kind === 'copy') {
      const copy = entry.copy ?? {};
      const listed = COPIED.some((copied) => copied.into === entry.file && (copy.component !== undefined ? copied.component === copy.component : copied.package === copy.package && copied.version === copy.version));
      if (!listed) problems.push(`${where}: a copy must be listed in COPIED (scripts/license-inventory.mjs) for ${entry.file}, so that THIRD_PARTY.md §2 names it`);
    }
  } else if ((typeof entry.file === 'string') === (typeof entry.pattern === 'string')) {
    problems.push(`${where}: a B2 entry names a file or a pattern`);
  }
  return problems;
}

/** Matches hits to entries: every hit covered once, every entry covering exactly its count. */
function reconcile(hits, entries, check, covers, describe) {
  const problems = [];
  entries.forEach((entry, index) => problems.push(...entryProblems(entry, `${check} entry ${index + 1} (${entry.file ?? entry.pattern})`, check)));
  const covered = new Map(entries.map((entry) => [entry, 0]));
  const uncovered = [];
  for (const hit of hits) {
    const by = entries.filter((entry) => covers(entry, hit));
    if (by.length === 0) uncovered.push(hit);
    if (by.length > 1) problems.push(`${describe(hit)}: covered by ${by.length} entries; make them distinct`);
    for (const entry of by) covered.set(entry, covered.get(entry) + 1);
  }
  entries.forEach((entry, index) => {
    const count = covered.get(entry);
    if (count === 0) {
      problems.push(`${check} entry ${index + 1} (${entry.file ?? entry.pattern}) covers nothing: remove it, or read what changed`);
    } else if (Number.isInteger(entry.count) && count !== entry.count) {
      problems.push(`${check} entry ${index + 1} (${entry.file ?? entry.pattern}) covers ${count} hit(s), and states ${entry.count}: read the new ones, then change the count`);
    }
  });
  return {uncovered, problems};
}

const MARKER_BY_ID = new Map(MARKERS.map((marker) => [marker.id, marker]));

/** Whether a B1 entry covers a hit: its file, a line that contains the entry's text, and no marker on the line the text lacks. */
function coversLine(entry, hit) {
  return (
    entry.file === hit.file &&
    typeof entry.line === 'string' &&
    entry.line !== '' &&
    hit.text.includes(entry.line) &&
    hit.markers.every((id) => MARKER_BY_ID.get(id).pattern.test(entry.line))
  );
}

/** Runs B1 and B2 over the files and returns the result; does not exit. */
export function checkProvenance({root, files, allowlist}) {
  const markers = markerHits(root, files);
  const shapes = shapeHits(root, files);
  const b1 = reconcile(markers, allowlist.markers ?? [], 'B1', coversLine, (hit) => `${hit.file}:${hit.line}`);
  const b2 = reconcile(
    shapes,
    allowlist.shapes ?? [],
    'B2',
    (entry, hit) => (entry.file !== undefined ? entry.file === hit.file : patternExpression(entry.pattern).test(hit.file)),
    (hit) => hit.file,
  );
  return {files: files.length, markers, shapes, b1, b2, pass: [b1, b2].every((part) => part.uncovered.length === 0 && part.problems.length === 0)};
}

export function report(result) {
  const lines = [
    `provenance check: ${result.files} file(s) git tracks or would commit`,
    `B1 attribution markers: ${result.markers.length} line(s), ${result.b1.uncovered.length} not covered by an entry`,
    `B2 third-party shape: ${result.shapes.length} file(s) over ${SHAPE_LIMITS.line} characters a line or ${SHAPE_LIMITS.bytes / 1024} KB, ${result.b2.uncovered.length} not covered by an entry`,
  ];
  for (const hit of result.b1.uncovered) {
    lines.push(`  B1 ${hit.file}:${hit.line} (${hit.markers.join(', ')}): ${hit.text.slice(0, 160)}`);
  }
  for (const hit of result.b2.uncovered) {
    lines.push(`  B2 ${hit.file}: longest line ${hit.longest} characters, ${hit.bytes} bytes`);
  }
  for (const problem of [...result.b1.problems, ...result.b2.problems]) {
    lines.push(`  ${problem}`);
  }
  if (result.pass) {
    lines.push('result: pass — every hit is covered by an entry that reads it');
  } else {
    lines.push('result: FAIL');
    lines.push(
      'fix: a copy names its source, version and licence where it sits, is listed in COPIED (scripts/license-inventory.mjs) so that THIRD_PARTY.md §2 names it, ' +
        'and gets a "copy" entry; anything else gets an entry in scripts/provenance-allowlist.json saying what it is (code provenance review §5.5)',
    );
  }
  return lines.join('\n');
}

function parseArguments(argv) {
  const options = {root: APPLICATION_ROOT, allowlist: null};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === '--root' || flag === '--allowlist') {
      if (value === undefined) throw new UsageError(`${flag} needs a path`);
      options[flag === '--root' ? 'root' : 'allowlist'] = resolve(value);
      index += 1;
    } else {
      throw new UsageError(`unknown argument ${JSON.stringify(flag)}`);
    }
  }
  options.allowlist ??= join(options.root, 'scripts', 'provenance-allowlist.json');
  return options;
}

function main(argv) {
  let result;
  try {
    const options = parseArguments(argv);
    const allowlist = JSON.parse(readFileSync(options.allowlist, 'utf8'));
    result = checkProvenance({root: options.root, files: repositoryFiles(options.root), allowlist});
  } catch (error) {
    process.stderr.write(`provenance-check: ${error.message}\n`);
    if (error instanceof UsageError) process.stderr.write('usage: node scripts/provenance-check.mjs [--root <dir>] [--allowlist <file>]\n');
    return 2;
  }
  process.stdout.write(`${report(result)}\n`);
  return result.pass ? 0 : 1;
}

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href) {
  process.exitCode = main(process.argv.slice(2));
}
