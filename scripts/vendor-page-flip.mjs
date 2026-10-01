#!/usr/bin/env node
/**
 * The vendored page-turn engine (M4.1, D11, D100).
 *
 * The comic reader's page turn is StPageFlip 2.0.7 at commit
 * ab30ecc1d9f6d98de1a99b8e296469382f41c120. That commit holds the engine's
 * sources and build configuration but no built file (its .gitignore excludes
 * dist/), so the browser build comes from the npm tarball `page-flip@2.0.7`,
 * which was published from that commit (its registry `gitHead`). The owner
 * chose this source on 2026-09-23 (../execution/W1_RECONCILIATION.md §6).
 *
 * Two modes:
 *
 * - verify (the default, offline): the files in vendor/page-flip/ are the
 *   pinned bytes. page-flip.browser.js and LICENSE must have the pinned sizes
 *   and SHA-256, VERSION must be exactly the record these pins produce, the
 *   patch ledger must say no patch is applied, `.gitattributes` must keep git
 *   from converting line endings, and nothing else may be in the folder. This is what `npm run vendor:page-flip` runs, and what the unit
 *   test runs without a network.
 * - fetch (`--fetch`): downloads the tarball, checks its SHA-512 against the
 *   pinned integrity, reads the two members out of the tar itself (no
 *   dependency), checks their SHA-256, writes the vendored files and then
 *   verifies the folder. `--tarball <file>` reads a local copy of the tarball
 *   instead of downloading it, for a machine without a network.
 *
 * The pins below are the single source of the expected values. VERSION is
 * the committed record of them; edit the pins, never VERSION. A local change
 * to the engine is a patch in PATCHES.md, applied here after the upstream
 * bytes are verified; there is none.
 *
 * Usage: node scripts/vendor-page-flip.mjs [--verify | --fetch] [--tarball <file>] [--dir <dir>]
 * Exit:  0 verified (and, with --fetch, written) · 1 a byte, hash or record does
 *        not match the pins · 2 usage, IO or network failure
 */
import {createHash} from 'node:crypto';
import {existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join, relative, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {gunzipSync} from 'node:zlib';

class UsageError extends Error {}

/** A downloaded or local tarball that is not the pinned artefact. */
class PinError extends Error {}

const APPLICATION_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_DIRECTORY = join(APPLICATION_ROOT, 'vendor', 'page-flip');

/** D100. Every value was checked against the registry and GitHub on 2026-09-26. */
export const PINS = Object.freeze({
  upstreamRepository: 'https://github.com/Nodlik/StPageFlip',
  upstreamTag: 'v2.0.7',
  upstreamCommit: 'ab30ecc1d9f6d98de1a99b8e296469382f41c120',
  npmPackage: 'page-flip',
  npmVersion: '2.0.7',
  npmGitHead: 'ab30ecc1d9f6d98de1a99b8e296469382f41c120',
  tarball: 'https://registry.npmjs.org/page-flip/-/page-flip-2.0.7.tgz',
  tarballBytes: 9_181_182,
  integrity: 'sha512-96lQFUUz7r/LZzEUZJ3yBIMEKU9+m8HMFDzTvTdD6P7Ag/wXINjp9n0W7b4wanwnDbQETo4uNUoL3zMqpFxwGA==',
  file: Object.freeze({
    name: 'page-flip.browser.js',
    member: 'package/dist/js/page-flip.browser.js',
    bytes: 44_058,
    sha256: 'bbaca0bbef57a22bb66a3fc69d67baf9a17fb9a9c89ec9ed35e2b91abe4bd1e7',
  }),
  license: Object.freeze({
    name: 'LICENSE',
    member: 'package/LICENSE',
    spdx: 'MIT',
    bytes: 1_063,
    sha256: '88d7b609a3be5efa2abe8648ddc35d5489579db5e06299545760df45c2c32d66',
  }),
});

/**
 * D101: the engine's uses of what the published-client scan bans in
 * Papeleria's own code (scripts/bundle-clients.mjs, D164(j)), reviewed once
 * against the minified file and the TypeScript sources in the same tarball.
 * There are six and only six. Each writes a constant the engine itself spells
 * out, with nothing interpolated, so no value from a piece, a manifest or the
 * page can reach any of them; three are on code paths the adapter never calls.
 * W4 admits the engine to the reader bundle by its pinned SHA-256 and by this
 * list, matched exactly, and the scan stays as strict as it is for own code.
 */
export const REVIEWED_USES = Object.freeze(
  [
    {
      scan: 'an Image',
      code: 'this.image=new Image',
      source: 'src/Page/ImagePage.ts:18',
      writes: 'An Image object whose src is one of the URLs handed to loadFromImages',
      reachedBy: 'Canvas mode only: loadFromImages and updateFromImages build ImagePage objects',
      adapterCalls: false,
    },
    {
      scan: 'markup parsed from a string',
      code: 't.insertAdjacentHTML("afterbegin",\'<div class="stf__wrapper"></div>\')',
      source: 'src/UI/UI.ts:42',
      writes: 'One empty div.stf__wrapper at the start of the block the engine was given',
      reachedBy: 'The UI constructor, in both modes: loadFromHTML',
      adapterCalls: true,
    },
    {
      scan: 'markup parsed from a string',
      code: 'this.wrapper.insertAdjacentHTML("afterbegin",\'<div class="stf__block"></div>\')',
      source: 'src/UI/HTMLUI.ts:20',
      writes: 'One empty div.stf__block inside that wrapper, which receives the page elements',
      reachedBy: 'The HTMLUI constructor: loadFromHTML',
      adapterCalls: true,
    },
    {
      scan: 'markup parsed from a string',
      code: 'this.distElement.innerHTML=""',
      source: 'src/UI/HTMLUI.ts:46',
      writes: 'Nothing: it empties div.stf__block before new page elements are appended',
      reachedBy: 'HTMLUI.updateItems, from updateFromHtml only',
      adapterCalls: false,
    },
    {
      scan: 'markup parsed from a string',
      code: 'this.wrapper.innerHTML=\'<canvas class="stf__canvas"></canvas>\'',
      source: 'src/UI/CanvasUI.ts:14',
      writes: 'One empty canvas.stf__canvas',
      reachedBy: 'The CanvasUI constructor: loadFromImages only',
      adapterCalls: false,
    },
    {
      scan: 'markup parsed from a string',
      code:
        'this.element.insertAdjacentHTML("beforeend",\'<div class="stf__outerShadow"></div>\\n             <div class="stf__innerShadow"></div>\\n             <div class="stf__hardShadow"></div>\\n             <div class="stf__hardInnerShadow"></div>\')',
      source: 'src/Render/HTMLRender.ts:40',
      writes: 'Four empty shadow divs at the end of div.stf__block (the source is a template literal with nothing interpolated)',
      reachedBy: 'The HTMLRender constructor (loadFromHTML) and HTMLRender.reload (updateFromHtml)',
      adapterCalls: true,
    },
  ].map((use) => Object.freeze(use)),
);

export const LEDGER = 'PATCHES.md';
export const RECORD = 'VERSION';
export const ATTRIBUTES = '.gitattributes';

/**
 * Git must never convert the pinned bytes: the repository's `* text=auto`
 * would give a Windows checkout with autocrlf CRLF line endings and a
 * different SHA-256. The fixture folders do the same (test/fixtures/csv).
 */
export const ATTRIBUTES_TEXT = '# The vendored bytes are pinned by SHA-256: never convert line endings.\n* -text\n';

/** The folder holds the engine, its licence, the record, the ledger and the attributes, and nothing else. */
export function expectedFiles(pins = PINS) {
  return [pins.file.name, pins.license.name, RECORD, LEDGER, ATTRIBUTES].sort();
}

// ------------------------------------------------------------------ record ---

const RECORD_KEYS = [
  'upstream_repository',
  'upstream_tag',
  'upstream_commit',
  'npm_package',
  'npm_version',
  'npm_git_head',
  'npm_tarball',
  'npm_tarball_bytes',
  'npm_integrity',
  'file',
  'file_member',
  'file_bytes',
  'file_sha256',
  'license',
  'license_member',
  'license_spdx',
  'license_bytes',
  'license_sha256',
  'patches',
];

/** The exact bytes of VERSION for a set of pins. */
export function versionText(pins = PINS) {
  const values = {
    upstream_repository: pins.upstreamRepository,
    upstream_tag: pins.upstreamTag,
    upstream_commit: pins.upstreamCommit,
    npm_package: pins.npmPackage,
    npm_version: pins.npmVersion,
    npm_git_head: pins.npmGitHead,
    npm_tarball: pins.tarball,
    npm_tarball_bytes: String(pins.tarballBytes),
    npm_integrity: pins.integrity,
    file: pins.file.name,
    file_member: pins.file.member,
    file_bytes: String(pins.file.bytes),
    file_sha256: pins.file.sha256,
    license: pins.license.name,
    license_member: pins.license.member,
    license_spdx: pins.license.spdx,
    license_bytes: String(pins.license.bytes),
    license_sha256: pins.license.sha256,
    patches: 'none',
  };
  const lines = [
    '# The vendored page-turn engine, StPageFlip 2.0.7 (docs/DECISIONS.md D11, D100).',
    '# Written by scripts/vendor-page-flip.mjs from its pins and verified offline by',
    '# `npm run vendor:page-flip`. Edit the pins in the script, never this file.',
    ...RECORD_KEYS.map((key) => `${key}: ${values[key]}`),
  ];
  return `${lines.join('\n')}\n`;
}

/**
 * Reads a VERSION record: `#` comments, then one `key: value` line per key,
 * lower-case snake_case keys, each key once. Anything else is refused, so a
 * hand edit cannot slip a second value past a reader that takes the first.
 */
export function parseVersion(text) {
  const record = {};
  const lines = text.split('\n');
  if (lines.at(-1) === '') {
    lines.pop();
  }
  lines.forEach((line, index) => {
    if (line.startsWith('#')) {
      return;
    }
    const match = /^([a-z][a-z0-9_]*): (\S(?:.*\S)?)$/.exec(line);
    if (match === null) {
      throw new UsageError(`line ${index + 1} is not a "key: value" line: ${JSON.stringify(line)}`);
    }
    const [, key, value] = match;
    if (Object.hasOwn(record, key)) {
      throw new UsageError(`line ${index + 1} repeats the key ${key}`);
    }
    record[key] = value;
  });
  return record;
}

// --------------------------------------------------------------------- tar ---

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** npm's `integrity` for a tarball: `sha512-` and the base64 digest. */
export function integrityOf(bytes) {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}

function field(header, start, length) {
  const bytes = header.subarray(start, start + length);
  const end = bytes.indexOf(0);
  return Buffer.from(end < 0 ? bytes : bytes.subarray(0, end)).toString('utf8');
}

function octal(header, start, length, what) {
  const text = field(header, start, length).trim();
  if (!/^[0-7]+$/.test(text)) {
    throw new PinError(`a tar header has an unreadable ${what} ${JSON.stringify(text)}`);
  }
  return Number.parseInt(text, 8);
}

/** POSIX pax records: `<length> <key>=<value>\n`, repeated. */
function paxRecords(bytes) {
  const records = {};
  let position = 0;
  const text = Buffer.from(bytes).toString('utf8');
  while (position < text.length) {
    const space = text.indexOf(' ', position);
    const length = Number.parseInt(text.slice(position, space), 10);
    if (space < 0 || !Number.isInteger(length) || length <= 0) {
      throw new PinError('a pax extended header is malformed');
    }
    const record = text.slice(space + 1, position + length - 1);
    const equals = record.indexOf('=');
    records[record.slice(0, equals)] = record.slice(equals + 1);
    position += length;
  }
  return records;
}

/**
 * Reads the named members out of a gzip-compressed tar (ustar, with pax and
 * GNU long names understood). Each header's checksum is checked. A member that
 * is missing, repeated or not a regular file is refused.
 */
export function readTarMembers(tarball, names) {
  let tar;
  try {
    tar = gunzipSync(tarball);
  } catch (error) {
    throw new PinError(`the tarball is not gzip data: ${error.message}`);
  }
  const wanted = new Set(names);
  const found = new Map();
  let position = 0;
  let pending = {};
  while (position + 512 <= tar.length) {
    const header = tar.subarray(position, position + 512);
    if (header.every((byte) => byte === 0)) {
      break;
    }
    let sum = 0;
    for (let index = 0; index < 512; index += 1) {
      sum += index >= 148 && index < 156 ? 0x20 : header[index];
    }
    if (sum !== octal(header, 148, 8, 'checksum')) {
      throw new PinError(`the tar header at byte ${position} fails its checksum`);
    }
    const type = String.fromCharCode(header[156] || 0x30);
    const extension = type === 'x' || type === 'L' || type === 'g';
    // A pax record or a GNU long name describes the entry that follows it.
    const size = !extension && pending.size !== undefined ? Number.parseInt(pending.size, 10) : octal(header, 124, 12, 'size');
    const prefix = field(header, 345, 155);
    const headerName = prefix === '' ? field(header, 0, 100) : `${prefix}/${field(header, 0, 100)}`;
    const name = !extension && pending.path !== undefined ? pending.path : headerName;
    const start = position + 512;
    const content = tar.subarray(start, start + size);
    if (!Number.isSafeInteger(size) || content.length !== size) {
      throw new PinError(`the tar member ${name} is cut short`);
    }
    position = start + Math.ceil(size / 512) * 512;
    if (type === 'x') {
      pending = paxRecords(content);
      continue;
    }
    if (type === 'L') {
      pending = {path: field(content, 0, content.length)};
      continue;
    }
    if (type === 'g') {
      continue;
    }
    pending = {};
    if (!wanted.has(name)) {
      continue;
    }
    if (type !== '0') {
      throw new PinError(`the tar member ${name} is not a regular file (type ${JSON.stringify(type)})`);
    }
    if (found.has(name)) {
      throw new PinError(`the tarball holds ${name} twice`);
    }
    found.set(name, new Uint8Array(content));
  }
  for (const name of wanted) {
    if (!found.has(name)) {
      throw new PinError(`the tarball has no ${name}`);
    }
  }
  return found;
}

// ------------------------------------------------------------------ verify ---

/**
 * What the patch ledger says. The format is the file's own; this reads only
 * the `## Patches` section, which must be the word "None." while VERSION says
 * `patches: none` and the engine is the upstream bytes.
 */
export function ledgerPatches(text) {
  const match = /^## Patches\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(text);
  if (match === null) {
    return null;
  }
  return match[1].trim();
}

function formatBytes(bytes) {
  return new Intl.NumberFormat('en-US').format(bytes);
}

/** Checks a vendored folder against the pins. Never touches the network. */
export function verifyVendored(directory, pins = PINS) {
  const problems = [];
  const lines = [];
  if (!existsSync(directory) || !lstatSync(directory).isDirectory()) {
    return {ok: false, problems: [`${directory} is not a folder`], lines};
  }
  const present = readdirSync(directory).sort();
  const expected = expectedFiles(pins);
  for (const name of present) {
    if (!expected.includes(name)) {
      problems.push(`${name} does not belong in the vendored folder, which holds ${expected.join(', ')} only`);
    }
  }
  const read = (name) => {
    const path = join(directory, name);
    if (!existsSync(path)) {
      problems.push(`${name} is missing`);
      return null;
    }
    if (!lstatSync(path).isFile()) {
      problems.push(`${name} is not a regular file`);
      return null;
    }
    return readFileSync(path);
  };

  for (const pinned of [pins.file, pins.license]) {
    const bytes = read(pinned.name);
    if (bytes === null) {
      continue;
    }
    const digest = sha256(bytes);
    if (bytes.length !== pinned.bytes || digest !== pinned.sha256) {
      problems.push(
        `${pinned.name} is ${formatBytes(bytes.length)} bytes with SHA-256 ${digest}; ` +
          `the pin is ${formatBytes(pinned.bytes)} bytes with SHA-256 ${pinned.sha256}`,
      );
      continue;
    }
    lines.push(`  ok  ${pinned.name}  ${formatBytes(bytes.length)} bytes  sha256 ${digest}`);
    if (pinned === pins.file) {
      // The review list is only as good as its snippets: each must be in the pinned bytes exactly once.
      const text = bytes.toString('utf8');
      const missing = REVIEWED_USES.filter((use) => text.split(use.code).length !== 2);
      if (missing.length > 0) {
        problems.push(`the review (D101) names code that is not in ${pinned.name} exactly once: ${missing.map((use) => use.source).join(', ')}`);
      } else {
        lines.push(`  ok  the ${REVIEWED_USES.length} reviewed uses (D101) are each in ${pinned.name} once`);
      }
    }
  }

  const record = read(RECORD);
  if (record !== null) {
    if (record.toString('utf8') === versionText(pins)) {
      lines.push(`  ok  ${RECORD}  the record of these pins, byte for byte`);
    } else {
      let detail = 'it differs from the record the pins produce';
      try {
        const parsed = parseVersion(record.toString('utf8'));
        const wanted = parseVersion(versionText(pins));
        const changed = Object.keys(wanted).filter((key) => parsed[key] !== wanted[key]);
        const extra = Object.keys(parsed).filter((key) => !Object.hasOwn(wanted, key));
        detail = [...changed.map((key) => `${key} is ${JSON.stringify(parsed[key] ?? null)}, the pin ${JSON.stringify(wanted[key])}`), ...extra.map((key) => `${key} is not a pinned key`)].join('; ') || 'only its comments or spacing differ';
      } catch (error) {
        detail = error.message;
      }
      problems.push(`${RECORD} does not match the pins: ${detail}`);
    }
  }

  const attributes = read(ATTRIBUTES);
  if (attributes !== null) {
    if (attributes.toString('utf8') === ATTRIBUTES_TEXT) {
      lines.push(`  ok  ${ATTRIBUTES}  git keeps the bytes as they are`);
    } else {
      problems.push(`${ATTRIBUTES} must say exactly ${JSON.stringify(ATTRIBUTES_TEXT)}, so git never converts the pinned bytes`);
    }
  }

  const ledger = read(LEDGER);
  if (ledger !== null) {
    const patches = ledgerPatches(ledger.toString('utf8'));
    if (patches === null) {
      problems.push(`${LEDGER} has no "## Patches" section`);
    } else if (patches !== 'None.') {
      problems.push(`${LEDGER} lists a patch, but ${RECORD} says none is applied and ${pins.file.name} is the upstream bytes`);
    } else {
      lines.push(`  ok  ${LEDGER}  no local patch: the engine is the upstream file`);
    }
  }
  return {ok: problems.length === 0, problems, lines};
}

// ------------------------------------------------------------------- fetch ---

const LEDGER_TEXT = `# Local patches to the vendored page-turn engine

\`page-flip.browser.js\` is byte-identical to \`package/dist/js/page-flip.browser.js\` in the npm tarball \`page-flip@2.0.7\`, which was published from the pinned StPageFlip commit (\`VERSION\`, docs/DECISIONS.md D100). What the engine does that Papeleria must not rely on is handled in Papeleria's own code, \`templates/comic/client/engine-adapter.ts\` (D103), not by changing the engine.

## When a patch is needed

A change to the engine's bytes is made only when the adapter cannot do the job, and only by adding an entry below and teaching \`scripts/vendor-page-flip.mjs\` to apply it after the upstream bytes are verified. The entry and the script change land in the same commit as a decision row, and \`VERSION\` then records the patched file's SHA-256 beside the upstream one. Nobody edits \`page-flip.browser.js\` by hand.

Each entry has:

- **ID and title**: \`P001\`, \`P002\` and so on, never reused.
- **Date, author and decision**: when, who, and the row in docs/DECISIONS.md that approves it.
- **Why**: the behaviour, how it was observed, and why the adapter cannot handle it.
- **Change**: the exact text replaced and the text that replaces it, with the number of places it applies; the script refuses to patch if the count differs.
- **Hashes**: the file's SHA-256 before and after.
- **Upstream**: whether the problem was reported upstream, with a link.
- **Test**: the test that fails without the patch.

## Patches

None.
`;

async function download(url) {
  let response;
  try {
    response = await fetch(url, {redirect: 'follow'});
  } catch (error) {
    throw new Error(`${url} could not be fetched: ${error.cause?.message ?? error.message}`);
  }
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

/** Checks a tarball against the pins and returns the two members' bytes. */
export function unpackPinned(tarball, pins = PINS) {
  const integrity = integrityOf(tarball);
  if (integrity !== pins.integrity) {
    throw new PinError(`the tarball's integrity is ${integrity}; the pin is ${pins.integrity}`);
  }
  const members = readTarMembers(tarball, [pins.file.member, pins.license.member]);
  const result = {};
  for (const pinned of [pins.file, pins.license]) {
    const bytes = members.get(pinned.member);
    const digest = sha256(bytes);
    if (bytes.length !== pinned.bytes || digest !== pinned.sha256) {
      throw new PinError(`${pinned.member} is ${bytes.length} bytes with SHA-256 ${digest}; the pin is ${pinned.bytes} bytes with SHA-256 ${pinned.sha256}`);
    }
    result[pinned.name] = bytes;
  }
  return result;
}

async function fetchInto(directory, tarballPath, pins, out) {
  const tarball = tarballPath === null ? await download(pins.tarball) : new Uint8Array(readFileSync(tarballPath));
  out(`${tarballPath === null ? `fetched ${pins.tarball}` : `read ${tarballPath}`}: ${formatBytes(tarball.length)} bytes`);
  const files = unpackPinned(tarball, pins);
  out(`  ok  integrity ${pins.integrity}`);
  mkdirSync(directory, {recursive: true});
  for (const [name, bytes] of Object.entries(files)) {
    writeFileSync(join(directory, name), bytes);
    out(`  wrote ${name}`);
  }
  writeFileSync(join(directory, RECORD), versionText(pins));
  out(`  wrote ${RECORD}`);
  writeFileSync(join(directory, ATTRIBUTES), ATTRIBUTES_TEXT);
  out(`  wrote ${ATTRIBUTES}`);
  // The ledger is the maintainers' record; it is written only when it is not there yet.
  const ledger = join(directory, LEDGER);
  if (!existsSync(ledger)) {
    writeFileSync(ledger, LEDGER_TEXT);
    out(`  wrote ${LEDGER}`);
  }
}

// -------------------------------------------------------------------- main ---

function parseArguments(argv) {
  const options = {mode: 'verify', tarball: null, directory: DEFAULT_DIRECTORY};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--verify' || flag === '--fetch') {
      options.mode = flag.slice(2);
    } else if (flag === '--tarball' || flag === '--dir') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new UsageError(`${flag} needs a path`);
      }
      options[flag === '--dir' ? 'directory' : 'tarball'] = resolve(value);
      index += 1;
    } else {
      throw new UsageError(`unknown argument ${JSON.stringify(flag)}`);
    }
  }
  if (options.tarball !== null && options.mode !== 'fetch') {
    throw new UsageError('--tarball is read only with --fetch');
  }
  return options;
}

export async function main(argv, out = (line) => process.stdout.write(`${line}\n`), error = (line) => process.stderr.write(`${line}\n`)) {
  let options;
  try {
    options = parseArguments(argv);
  } catch (problem) {
    error(`vendor-page-flip: ${problem.message}`);
    error('usage: node scripts/vendor-page-flip.mjs [--verify | --fetch] [--tarball <file>] [--dir <dir>]');
    return 2;
  }
  const shown = relative(APPLICATION_ROOT, options.directory) || '.';
  try {
    if (options.mode === 'fetch') {
      await fetchInto(options.directory, options.tarball, PINS, out);
    }
  } catch (problem) {
    error(`vendor-page-flip: ${problem.message}`);
    return problem instanceof PinError ? 1 : 2;
  }
  out(`vendor-page-flip: verifying ${shown.startsWith('..') ? options.directory : shown} against the pins (D100), offline`);
  let result;
  try {
    result = verifyVendored(options.directory, PINS);
  } catch (problem) {
    error(`vendor-page-flip: ${problem.message}`);
    return 2;
  }
  for (const line of result.lines) {
    out(line);
  }
  for (const problem of result.problems) {
    error(`vendor-page-flip: ${problem}`);
  }
  out(result.ok ? 'result: pass' : `result: FAIL — ${result.problems.length} problem(s)`);
  return result.ok ? 0 : 1;
}

export {LEDGER_TEXT, PinError, UsageError};

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href) {
  process.exitCode = await main(process.argv.slice(2));
}
