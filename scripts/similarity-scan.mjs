#!/usr/bin/env node
/**
 * The similarity scan, tier 1: B7 of the code provenance review
 * (docs/CODE_PROVENANCE_REVIEW_2026-09-28.md §5.3; D144). It lists every run
 * of 50 tokens or more that Papeleria's own code shares with a file of an
 * installed dependency, for each to be dispositioned: replaced by an import,
 * declared and attributed, or recorded as a false positive.
 *
 * Own code is every TypeScript, JavaScript and CSS file under `src/`,
 * `templates/`, `scripts/`, `theme/` and `test/` that git tracks or would
 * commit, except the licence-check fixtures' synthetic packages under
 * `test/fixtures/license/`. `vendor/` is the declared third-party door, pinned
 * by hash (D100), and is not own code. The corpus is every JavaScript,
 * TypeScript, CSS and JSON file under the installed `node_modules/`, which
 * `npm ci` fills with every package the lockfile locks, development tools
 * included.
 *
 * Both sides are read as tokens: comments and whitespace are dropped, and a
 * string's quotes too, so a JSON key compares equal to the same identifier and
 * a re-quoted or re-indented copy is still found; everything else is compared
 * as written, so a copy with renamed identifiers is not. Every window of N
 * tokens of own code is hashed; a corpus window with the same hash is then
 * compared token by token, so a hash collision is never reported. Windows that
 * continue one another are merged into one region per pair of files.
 *
 * Each region needs a disposition, recorded in
 * `docs/evidence/similarity-dispositions.json` by the own file, the corpus
 * path it starts with and the identity of every region it covers: replaced
 * by an import, declared and attributed, or a false positive, with the
 * reason. A region's identity is the first 16 hexadecimal digits of the
 * SHA-256 of its shared tokens, so it survives a move within the file, while
 * a second copy between the same files, or a region a changed dependency
 * alters, is a new region that has no disposition until someone decides it.
 * The run passes when every region has one and every recorded region is
 * still found, and names each that is not.
 *
 * The review asks for it per release candidate and after any change of more
 * than 2,000 added lines (§5.3). It reads about 70 MiB of dependencies in a
 * few seconds, so `test/unit/similarity-scan.test.ts` also runs it on this
 * repository under `npm test`, on every commit.
 *
 * Usage: node scripts/similarity-scan.mjs [--root <dir>] [--tokens N] [--dispositions <file>]
 * Exit:  0 every shared run has a disposition · 1 a shared run has none, or
 *        a recorded one is no longer found · 2 usage or IO, or no
 *        node_modules/ to compare with
 */
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync, readdirSync, readFileSync} from 'node:fs';
import {join, relative, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const APPLICATION_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Own code: these folders, these extensions, less the licence fixtures' synthetic packages. */
const OWN_FOLDERS = ['src/', 'templates/', 'scripts/', 'theme/', 'test/'];
const OWN_EXTENSIONS = /\.(?:ts|mts|cts|js|mjs|cjs|css)$/;
const OWN_EXCLUDED = /^test\/fixtures\/license\//;

/** The corpus: code, styles and data an installed package carries. */
const CORPUS_EXTENSIONS = /\.(?:ts|mts|cts|js|mjs|cjs|css|json)$/;

/**
 * One token at a time: whitespace and comments (dropped), strings (kept
 * without their quotes), identifiers and numbers, and any other character.
 */
const TOKEN = /\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\[\s\S])*`|[A-Za-z_$][\w$]*|[0-9][\w.]*|[^\s]/g;

/** FNV-1a over a string's UTF-16 code units, as an unsigned 32-bit number. */
function fnv(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193);
  }
  return hash >>> 0;
}

/** A file's tokens, their hashes and the line each starts on. */
export function tokenize(text) {
  const tokens = [];
  const lines = [];
  let line = 1;
  TOKEN.lastIndex = 0;
  for (let match = TOKEN.exec(text); match !== null; match = TOKEN.exec(text)) {
    const value = match[0];
    const first = value.charCodeAt(0);
    const dropped = first <= 32 || value.startsWith('//') || value.startsWith('/*');
    if (!dropped) {
      tokens.push(first === 34 || first === 39 || first === 96 ? value.slice(1, -1) : value);
      lines.push(line);
    }
    for (let index = value.indexOf('\n'); index !== -1; index = value.indexOf('\n', index + 1)) {
      line += 1;
    }
  }
  return {tokens, hashes: Uint32Array.from(tokens, fnv), lines};
}

const BASE = 0x01000193;

/** The hash of every window of `width` tokens, rolled along the file. */
function windowHashes(hashes, width) {
  const count = hashes.length - width + 1;
  if (count <= 0) {
    return new Uint32Array(0);
  }
  let top = 1;
  for (let index = 1; index < width; index += 1) {
    top = Math.imul(top, BASE);
  }
  const result = new Uint32Array(count);
  let hash = 0;
  for (let index = 0; index < width; index += 1) {
    hash = (Math.imul(hash, BASE) + hashes[index]) >>> 0;
  }
  result[0] = hash;
  for (let start = 1; start < count; start += 1) {
    hash = (Math.imul((hash - Math.imul(hashes[start - 1], top)) >>> 0, BASE) + hashes[start + width - 1]) >>> 0;
    result[start] = hash;
  }
  return result;
}

function sameWindow(a, aStart, b, bStart, width) {
  for (let offset = 0; offset < width; offset += 1) {
    if (a[aStart + offset] !== b[bStart + offset]) {
      return false;
    }
  }
  return true;
}

function ownFiles(root) {
  const listing = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024});
  return [...new Set(listing.split('\0'))]
    .filter((path) => OWN_FOLDERS.some((folder) => path.startsWith(folder)) && OWN_EXTENSIONS.test(path) && !OWN_EXCLUDED.test(path))
    .sort();
}

function corpusFiles(directory, found = []) {
  for (const entry of readdirSync(directory, {withFileTypes: true})) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      corpusFiles(path, found);
    } else if (entry.isFile() && CORPUS_EXTENSIONS.test(entry.name)) {
      found.push(path);
    }
  }
  return found;
}

/** Every region of `width` tokens or more that an own file shares with a corpus file. */
export function scan(root, width) {
  const own = ownFiles(root).map((path) => ({path, ...tokenize(readFileSync(join(root, path), 'utf8'))}));
  const index = new Map();
  own.forEach((file, fileIndex) => {
    windowHashes(file.hashes, width).forEach((hash, start) => {
      const list = index.get(hash);
      if (list === undefined) {
        index.set(hash, [fileIndex, start]);
      } else {
        list.push(fileIndex, start);
      }
    });
  });
  const modules = join(root, 'node_modules');
  const corpus = corpusFiles(modules).sort();
  const regions = [];
  let tokensRead = 0;
  for (const path of corpus) {
    const file = tokenize(readFileSync(path, 'utf8'));
    tokensRead += file.tokens.length;
    const hits = new Map();
    windowHashes(file.hashes, width).forEach((hash, start) => {
      const list = index.get(hash);
      if (list === undefined) {
        return;
      }
      for (let entry = 0; entry < list.length; entry += 2) {
        const ownFile = own[list[entry]];
        const ownStart = list[entry + 1];
        if (sameWindow(ownFile.tokens, ownStart, file.tokens, start, width)) {
          const key = list[entry];
          const pairs = hits.get(key) ?? [];
          pairs.push([ownStart, start]);
          hits.set(key, pairs);
        }
      }
    });
    for (const [fileIndex, pairs] of hits) {
      const ownFile = own[fileIndex];
      pairs.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      // Windows on one diagonal (the same offset between the two files) that
      // overlap or touch belong to one region.
      const byDiagonal = new Map();
      for (const [ownStart, corpusStart] of pairs) {
        const diagonal = corpusStart - ownStart;
        const list = byDiagonal.get(diagonal) ?? [];
        list.push(ownStart);
        byDiagonal.set(diagonal, list);
      }
      for (const [diagonal, starts] of byDiagonal) {
        let begin = starts[0];
        let end = starts[0] + width;
        const close = () => {
          regions.push({
            id: createHash('sha256').update(ownFile.tokens.slice(begin, end).join('\0')).digest('hex').slice(0, 16),
            own: ownFile.path,
            ownLines: [ownFile.lines[begin], ownFile.lines[end - 1]],
            corpus: relative(root, path).split('\\').join('/'),
            corpusLines: [file.lines[begin + diagonal], file.lines[end - 1 + diagonal]],
            tokens: end - begin,
          });
        };
        for (const start of starts.slice(1)) {
          if (start <= end) {
            end = Math.max(end, start + width);
          } else {
            close();
            begin = start;
            end = start + width;
          }
        }
        close();
      }
    }
  }
  regions.sort((a, b) => a.own.localeCompare(b.own) || a.ownLines[0] - b.ownLines[0] || a.corpus.localeCompare(b.corpus));
  return {ownFiles: own.length, ownTokens: own.reduce((sum, file) => sum + file.tokens.length, 0), corpusFiles: corpus.length, corpusTokens: tokensRead, regions};
}

/** A region's identity as a disposition records it. */
const REGION_ID = /^[0-9a-f]{16}$/;

/** The recorded dispositions: each names an own file, a corpus path prefix, the regions it covers, and what was decided and why. */
function readDispositions(file) {
  if (!existsSync(file)) {
    return [];
  }
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  const entries = Array.isArray(parsed.dispositions) ? parsed.dispositions : null;
  const valid = (entry) =>
    typeof entry.own === 'string' &&
    typeof entry.corpus === 'string' &&
    Array.isArray(entry.regions) &&
    entry.regions.length > 0 &&
    entry.regions.every((id) => typeof id === 'string' && REGION_ID.test(id)) &&
    typeof entry.disposition === 'string' &&
    entry.disposition.trim() !== '';
  if (entries === null || !entries.every(valid)) {
    throw new Error(`${file} must hold {"dispositions": [{own, corpus, regions, disposition}]}, each region named by its identity and each disposition written out`);
  }
  return entries;
}

/** Whether a disposition covers a region: the same own file, a corpus path under its prefix, and the region's identity. */
function covers(entry, region) {
  return entry.own === region.own && region.corpus.startsWith(entry.corpus) && entry.regions.includes(region.id);
}

function main(argv) {
  const usage = 'usage: node scripts/similarity-scan.mjs [--root <dir>] [--tokens N] [--dispositions <file>]';
  let root = APPLICATION_ROOT;
  let width = 50;
  let dispositionsFile = null;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === '--root' && value !== undefined) {
      root = resolve(value);
      index += 1;
    } else if (flag === '--tokens' && value !== undefined && /^[1-9][0-9]*$/.test(value)) {
      width = Number(value);
      index += 1;
    } else if (flag === '--dispositions' && value !== undefined) {
      dispositionsFile = resolve(value);
      index += 1;
    } else {
      process.stderr.write(`similarity-scan: unknown or incomplete argument ${JSON.stringify(flag)}\n${usage}\n`);
      return 2;
    }
  }
  if (!existsSync(join(root, 'node_modules'))) {
    process.stderr.write('similarity-scan: node_modules/ is missing; run npm ci first, so every locked package is there to compare with\n');
    return 2;
  }
  let result;
  let dispositions;
  try {
    dispositions = readDispositions(dispositionsFile ?? join(root, 'docs', 'evidence', 'similarity-dispositions.json'));
    result = scan(root, width);
  } catch (error) {
    process.stderr.write(`similarity-scan: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  process.stdout.write(
    `similarity scan, tier 1: ${result.ownFiles} own files (${result.ownTokens} tokens) against ${result.corpusFiles} files in node_modules/ (${result.corpusTokens} tokens), windows of ${width} tokens\n`,
  );
  let open = 0;
  for (const region of result.regions) {
    const decided = dispositions.find((entry) => covers(entry, region));
    open += decided === undefined ? 1 : 0;
    process.stdout.write(
      `shared ${region.tokens} tokens, region ${region.id}: ${region.own}:${region.ownLines[0]}-${region.ownLines[1]} = ${region.corpus}:${region.corpusLines[0]}-${region.corpusLines[1]}` +
        ` (${decided === undefined ? 'no disposition yet' : decided.disposition})\n`,
    );
  }
  // A recorded region the scan no longer finds is a record that no longer describes the code.
  let stale = 0;
  for (const entry of dispositions) {
    for (const id of entry.regions) {
      if (!result.regions.some((region) => covers({...entry, regions: [id]}, region))) {
        stale += 1;
        process.stdout.write(`recorded region ${id} of ${entry.own} and ${entry.corpus} is not found: remove it from the dispositions, or find what changed\n`);
      }
    }
  }
  process.stdout.write(
    `${result.regions.length} shared region${result.regions.length === 1 ? '' : 's'}, ${open} without a disposition` +
      `${stale === 0 ? '' : `, ${stale} recorded region${stale === 1 ? '' : 's'} not found`}\n`,
  );
  return open === 0 && stale === 0 ? 0 : 1;
}

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href) {
  process.exitCode = main(process.argv.slice(2));
}
