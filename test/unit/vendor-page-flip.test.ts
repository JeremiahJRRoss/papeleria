/**
 * M4.1: the vendored page-turn engine (D100, D101), checked without a network.
 *
 * The committed bytes are compared with the owner's pins written out here, a
 * second time, so a change to the script's pins alone cannot pass. Both modes
 * of scripts/vendor-page-flip.mjs run on temporary copies: the verify mode
 * with `fetch` replaced by a function that throws, and the fetch mode on a
 * tarball built here, which it must refuse before writing anything. The tar
 * reader is exercised on ustar, pax and GNU long-name members. The review of
 * the engine's banned uses is held to the file: exactly six, each where the
 * review found it, and the published-client scan finds nothing else.
 */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after, test} from 'node:test';
import {pathToFileURL} from 'node:url';
import {gunzipSync, gzipSync} from 'node:zlib';

import {build} from 'esbuild';

import {applicationRoot, runCheckScript, scriptPath, type RunResult} from '../helpers/paths.js';

/** The owner's decision (W1_RECONCILIATION §6, D100), independently of the script. */
const ENGINE = {bytes: 44_058, sha256: 'bbaca0bbef57a22bb66a3fc69d67baf9a17fb9a9c89ec9ed35e2b91abe4bd1e7'};
const LICENSE = {bytes: 1_063, sha256: '88d7b609a3be5efa2abe8648ddc35d5489579db5e06299545760df45c2c32d66'};
const INTEGRITY = 'sha512-96lQFUUz7r/LZzEUZJ3yBIMEKU9+m8HMFDzTvTdD6P7Ag/wXINjp9n0W7b4wanwnDbQETo4uNUoL3zMqpFxwGA==';
const COMMIT = 'ab30ecc1d9f6d98de1a99b8e296469382f41c120';

const VENDORED = join(applicationRoot, 'vendor', 'page-flip');
const SCRIPT = scriptPath('vendor-page-flip.mjs');

type ReviewedUse = {scan: string; code: string; source: string; writes: string; reachedBy: string; adapterCalls: boolean};
type VendorModule = {
  PINS: {integrity: string; upstreamCommit: string; npmGitHead: string; file: {sha256: string}; license: {sha256: string; spdx: string}};
  REVIEWED_USES: readonly ReviewedUse[];
  parseVersion(text: string): Record<string, string>;
  versionText(): string;
  readTarMembers(tarball: Uint8Array, names: readonly string[]): Map<string, Uint8Array>;
};

async function vendorModule(): Promise<VendorModule> {
  return (await import(pathToFileURL(SCRIPT).href)) as VendorModule;
}

const temporary: string[] = [];
after(() => {
  for (const directory of temporary) {
    rmSync(directory, {recursive: true, force: true});
  }
});

function temporaryFolder(label: string): string {
  const directory = mkdtempSync(join(tmpdir(), `papeleria-vendor-${label}-`));
  temporary.push(directory);
  return directory;
}

/** A copy of the committed folder to break. */
function vendoredCopy(label: string): string {
  const directory = join(temporaryFolder(label), 'page-flip');
  cpSync(VENDORED, directory, {recursive: true});
  return directory;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Runs the script with `fetch` replaced by one that throws, so any network use fails the run. */
function runOffline(args: readonly string[]): Promise<RunResult> {
  const noNetwork = 'data:text/javascript,globalThis.fetch=()=>{throw new Error("the network was used")}';
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, ['--import', noNetwork, SCRIPT, ...args], {cwd: applicationRoot, stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.on('error', rejectPromise);
    child.on('close', (code) => resolvePromise({code: code ?? -1, stdout, stderr}));
  });
}

// ----------------------------------------------------------------- a tar ---

type TarEntry = {name: string; data?: Uint8Array | string; type?: string};

function octalField(value: number, length: number): string {
  return `${value.toString(8).padStart(length - 1, '0')}\0`;
}

/** A ustar archive, written here so the reader is not checked against itself. */
function tarOf(entries: readonly TarEntry[]): Uint8Array {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const data = typeof entry.data === 'string' ? Buffer.from(entry.data) : Buffer.from(entry.data ?? new Uint8Array());
    const header = Buffer.alloc(512);
    header.write(entry.name.slice(0, 100), 0, 'utf8');
    header.write(octalField(0o644, 8), 100, 'latin1');
    header.write(octalField(0, 8), 108, 'latin1');
    header.write(octalField(0, 8), 116, 'latin1');
    header.write(octalField(data.length, 12), 124, 'latin1');
    header.write(octalField(0, 12), 136, 'latin1');
    header.write('        ', 148, 'latin1');
    header.write(entry.type ?? '0', 156, 'latin1');
    header.write('ustar\u000000', 257, 'latin1');
    let sum = 0;
    for (const byte of header) {
      sum += byte;
    }
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1');
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  let length = body.length + 1;
  while (`${length}${body}`.length !== length) {
    length += 1;
  }
  return `${length}${body}`;
}

// ----------------------------------------------------------------- tests ---

test('the committed engine and licence are the pinned bytes, and VERSION records them', () => {
  const engine = readFileSync(join(VENDORED, 'page-flip.browser.js'));
  const license = readFileSync(join(VENDORED, 'LICENSE'));
  assert.deepEqual({bytes: engine.length, sha256: sha256(engine)}, ENGINE);
  assert.deepEqual({bytes: license.length, sha256: sha256(license)}, LICENSE);
  assert.match(license.toString('utf8'), /^MIT License\n\nCopyright \(c\) 2020 Nodlik\n/);
  assert.match(engine.toString('utf8'), /^!function\(t,e\)\{"object"==typeof exports&&"undefined"!=typeof module\?e\(exports\)/, 'the UMD build');

  const record = readFileSync(join(VENDORED, 'VERSION'), 'utf8');
  for (const [key, value] of [
    ['upstream_commit', COMMIT],
    ['npm_git_head', COMMIT],
    ['npm_package', 'page-flip'],
    ['npm_version', '2.0.7'],
    ['npm_tarball', 'https://registry.npmjs.org/page-flip/-/page-flip-2.0.7.tgz'],
    ['npm_integrity', INTEGRITY],
    ['file_member', 'package/dist/js/page-flip.browser.js'],
    ['file_sha256', ENGINE.sha256],
    ['file_bytes', String(ENGINE.bytes)],
    ['license_spdx', 'MIT'],
    ['license_sha256', LICENSE.sha256],
    ['patches', 'none'],
  ] as const) {
    assert.ok(record.includes(`\n${key}: ${value}\n`), `VERSION records ${key}: ${value}`);
  }
  assert.deepEqual(readdirSync(VENDORED).sort(), ['.gitattributes', 'LICENSE', 'PATCHES.md', 'VERSION', 'page-flip.browser.js']);
  assert.equal(readFileSync(join(VENDORED, '.gitattributes'), 'utf8'), '# The vendored bytes are pinned by SHA-256: never convert line endings.\n* -text\n');
});

test('the script\'s pins are the owner\'s, and VERSION is exactly their record', async () => {
  const vendor = await vendorModule();
  assert.equal(vendor.PINS.integrity, INTEGRITY);
  assert.equal(vendor.PINS.upstreamCommit, COMMIT);
  assert.equal(vendor.PINS.npmGitHead, COMMIT);
  assert.equal(vendor.PINS.file.sha256, ENGINE.sha256);
  assert.equal(vendor.PINS.license.sha256, LICENSE.sha256);
  assert.equal(vendor.PINS.license.spdx, 'MIT');
  assert.equal(readFileSync(join(VENDORED, 'VERSION'), 'utf8'), vendor.versionText());
});

test('npm run vendor:page-flip verifies offline, and never uses the network', async () => {
  const result = await runOffline([]);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, new RegExp(`ok {2}page-flip\\.browser\\.js {2}44,058 bytes {2}sha256 ${ENGINE.sha256}`));
  assert.match(result.stdout, new RegExp(`ok {2}LICENSE {2}1,063 bytes {2}sha256 ${LICENSE.sha256}`));
  assert.match(result.stdout, /ok {2}the 6 reviewed uses \(D101\) are each in page-flip\.browser\.js once/);
  assert.match(result.stdout, /ok {2}PATCHES\.md {2}no local patch/);
  assert.match(result.stdout, /^result: pass$/m);
  const scripts = (JSON.parse(readFileSync(join(applicationRoot, 'package.json'), 'utf8')) as {scripts: Record<string, string>}).scripts;
  assert.equal(scripts['vendor:page-flip'], 'node scripts/vendor-page-flip.mjs', 'the npm script is the verify mode');
});

test('verification names what does not match: a changed byte, a changed record, a patch, a stray or missing file', async () => {
  const cases: Array<[string, (directory: string) => void, RegExp]> = [
    [
      'engine',
      (directory) => {
        const path = join(directory, 'page-flip.browser.js');
        const bytes = readFileSync(path);
        bytes[100] = bytes[100]! ^ 1;
        writeFileSync(path, bytes);
      },
      new RegExp(`page-flip\\.browser\\.js is 44,058 bytes with SHA-256 [0-9a-f]{64}; the pin is 44,058 bytes with SHA-256 ${ENGINE.sha256}`),
    ],
    [
      'licence',
      (directory) => writeFileSync(join(directory, 'LICENSE'), readFileSync(join(directory, 'LICENSE'), 'utf8').replace('2020', '2021')),
      /LICENSE is 1,063 bytes with SHA-256 [0-9a-f]{64}; the pin is/,
    ],
    [
      'record',
      (directory) => writeFileSync(join(directory, 'VERSION'), readFileSync(join(directory, 'VERSION'), 'utf8').replace(`file_sha256: ${ENGINE.sha256}`, `file_sha256: ${'0'.repeat(64)}`)),
      /VERSION does not match the pins: file_sha256 is "0{64}", the pin "bbaca0bb/,
    ],
    [
      'record-duplicate',
      (directory) => writeFileSync(join(directory, 'VERSION'), `${readFileSync(join(directory, 'VERSION'), 'utf8')}patches: none\n`),
      /VERSION does not match the pins: line \d+ repeats the key patches/,
    ],
    [
      'ledger',
      (directory) => writeFileSync(join(directory, 'PATCHES.md'), readFileSync(join(directory, 'PATCHES.md'), 'utf8').replace(/## Patches\n\nNone\.\n$/, '## Patches\n\n### P001 — hand edit\n')),
      /PATCHES\.md lists a patch, but VERSION says none is applied/,
    ],
    ['missing-ledger', (directory) => rmSync(join(directory, 'PATCHES.md')), /PATCHES\.md is missing/],
    ['attributes', (directory) => writeFileSync(join(directory, '.gitattributes'), '* text=auto\n'), /\.gitattributes must say exactly/],
    ['stray', (directory) => writeFileSync(join(directory, 'page-flip.module.js'), 'export {};\n'), /page-flip\.module\.js does not belong in the vendored folder/],
  ];
  for (const [label, damage, expected] of cases) {
    const directory = vendoredCopy(label);
    damage(directory);
    const result = await runOffline(['--dir', directory]);
    assert.equal(result.code, 1, `${label}: ${result.stdout}${result.stderr}`);
    assert.match(result.stderr, expected, label);
    assert.match(result.stdout, /^result: FAIL — 1 problem\(s\)$/m, label);
  }
  const intact = await runOffline(['--dir', vendoredCopy('intact')]);
  assert.equal(intact.code, 0, intact.stderr);
});

test('the fetch mode refuses a tarball that is not the pinned one and writes nothing', async () => {
  const engine = readFileSync(join(VENDORED, 'page-flip.browser.js'));
  const license = readFileSync(join(VENDORED, 'LICENSE'));
  // The right members with the right bytes, in the wrong archive: the pin is the tarball's integrity.
  const tarball = tarOf([
    {name: 'package/LICENSE', data: license},
    {name: 'package/dist/js/page-flip.browser.js', data: engine},
  ]);
  const folder = temporaryFolder('fetch');
  const archive = join(folder, 'page-flip-2.0.7.tgz');
  writeFileSync(archive, tarball);
  const target = join(folder, 'out');
  const result = await runOffline(['--fetch', '--tarball', archive, '--dir', target]);
  assert.equal(result.code, 1, result.stdout + result.stderr);
  assert.match(result.stderr, new RegExp(`the tarball's integrity is sha512-[A-Za-z0-9+/=]+; the pin is ${INTEGRITY.replace(/[+/]/g, '\\$&')}`));
  assert.throws(() => readdirSync(target), /ENOENT/, 'nothing was written');

  const notGzip = join(folder, 'not-a-tarball.tgz');
  writeFileSync(notGzip, 'plain text');
  const refused = await runOffline(['--fetch', '--tarball', notGzip, '--dir', target]);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /integrity is sha512-/);

  const usage = await runCheckScript('vendor-page-flip.mjs', ['--tarball', archive]);
  assert.equal(usage.code, 2);
  assert.match(usage.stderr, /--tarball is read only with --fetch/);
});

test('the tar reader reads ustar members, pax paths and GNU long names, and refuses damage', async () => {
  const vendor = await vendorModule();
  const longName = `package/${'deep/'.repeat(30)}file.js`;
  const tarball = tarOf([
    {name: 'package/', type: '5'},
    {name: 'package/short.txt', data: 'short'},
    {name: 'PaxHeader', type: 'x', data: paxRecord('path', longName)},
    {name: 'package/truncated-name', data: 'pax'},
    {name: '././@LongLink', type: 'L', data: `package/${'gnu/'.repeat(30)}long.txt\0`},
    {name: 'package/cut', data: 'gnu'},
  ]);
  const members = vendor.readTarMembers(tarball, ['package/short.txt', longName, `package/${'gnu/'.repeat(30)}long.txt`]);
  assert.deepEqual(
    [...members.values()].map((bytes) => Buffer.from(bytes).toString('utf8')),
    ['short', 'pax', 'gnu'],
  );
  assert.throws(() => vendor.readTarMembers(tarball, ['package/absent']), /the tarball has no package\/absent/);
  assert.throws(() => vendor.readTarMembers(tarball, ['package/']), /is not a regular file/);
  assert.throws(
    () => vendor.readTarMembers(tarOf([{name: 'package/a', data: 'one'}, {name: 'package/a', data: 'two'}]), ['package/a']),
    /holds package\/a twice/,
  );
  assert.throws(() => vendor.readTarMembers(Buffer.from('plain text'), ['package/a']), /the tarball is not gzip data/);
  const raw = gunzipSync(tarOf([{name: 'package/a', data: 'x'}]));
  raw[0] = raw[0]! ^ 1;
  assert.throws(() => vendor.readTarMembers(gzipSync(raw), ['package/a']), /fails its checksum/);
});

test('a VERSION record is read strictly: one value per key, nothing but key: value lines', async () => {
  const vendor = await vendorModule();
  assert.deepEqual(vendor.parseVersion('# comment\nfile: a.js\nfile_bytes: 3\n'), {file: 'a.js', file_bytes: '3'});
  assert.throws(() => vendor.parseVersion('file: a.js\nfile: b.js\n'), /repeats the key file/);
  assert.throws(() => vendor.parseVersion('file = a.js\n'), /is not a "key: value" line/);
  assert.throws(() => vendor.parseVersion('File: a.js\n'), /is not a "key: value" line/);
  assert.throws(() => vendor.parseVersion('file: \n'), /is not a "key: value" line/);
});

test('the review (D101) is the engine\'s whole list: six uses, each where it was found, and nothing else the scan bans', async () => {
  const vendor = await vendorModule();
  const text = readFileSync(join(VENDORED, 'page-flip.browser.js'), 'utf8');
  assert.equal(vendor.REVIEWED_USES.length, 6);
  const banned = /\b(?:innerHTML|outerHTML|insertAdjacentHTML|createContextualFragment|setHTMLUnsafe|parseHTMLUnsafe|Image)\b|\bdocument\s*\.\s*write(?:ln)?\b/g;
  const found = [...text.matchAll(banned)].map((match) => match.index);
  assert.equal(found.length, 6, 'innerHTML twice, insertAdjacentHTML three times, Image once');
  const counts = {innerHTML: 0, insertAdjacentHTML: 0, Image: 0};
  for (const match of text.matchAll(banned)) {
    counts[match[0] as keyof typeof counts] += 1;
  }
  assert.deepEqual(counts, {innerHTML: 2, insertAdjacentHTML: 3, Image: 1});
  for (const offset of found) {
    const covering = vendor.REVIEWED_USES.filter((use) => {
      const start = text.indexOf(use.code);
      return start <= offset && offset < start + use.code.length;
    });
    assert.equal(covering.length, 1, `the use at offset ${offset} is reviewed exactly once`);
  }
  for (const use of vendor.REVIEWED_USES) {
    assert.equal(text.split(use.code).length, 2, `${use.source} is in the file once`);
    // Nothing is interpolated: every markup use writes a string literal the engine spells out.
    if (use.scan === 'markup parsed from a string') {
      assert.match(use.code, /(?:innerHTML=|insertAdjacentHTML\("(?:afterbegin|beforeend)",)(?:'[^'$`]*'|"")\)?$/, use.source);
    }
  }
  assert.deepEqual(
    vendor.REVIEWED_USES.filter((use) => use.adapterCalls).map((use) => use.source),
    ['src/UI/UI.ts:42', 'src/UI/HTMLUI.ts:20', 'src/Render/HTMLRender.ts:40'],
    'the adapter reaches only the three constructors that write empty containers',
  );

  const scan = await runCheckScript('bundle-clients.mjs', ['--scan', join(VENDORED, 'page-flip.browser.js')]);
  assert.equal(scan.code, 1);
  assert.deepEqual(
    scan.stderr.trim().split('\n').map((line) => line.replace(/^bundle-clients: .*?page-flip\.browser\.js:\d+ contains /, '')),
    ['an Image: "Image"', 'markup parsed from a string: "insertAdjacentHTML"'],
    'the scan finds only the two reviewed kinds, and the file compiles as a classic script',
  );
});

test('the adapter is Papeleria\'s own code and passes the published-client scan with no exception', async () => {
  // Bundled as bundle-clients.mjs bundles a published client: one classic IIFE, not minified, the same targets.
  const result = await build({
    absWorkingDir: applicationRoot,
    entryPoints: ['templates/comic/client/engine-adapter.ts'],
    bundle: true,
    format: 'iife',
    globalName: 'papeleriaEngineAdapter',
    platform: 'browser',
    target: ['chrome111', 'edge111', 'firefox111', 'safari16.4', 'ios16.4'],
    tsconfig: 'tsconfig.client.json',
    minify: false,
    sourcemap: false,
    metafile: true,
    logLevel: 'silent',
    write: false,
  });
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(Object.keys(result.metafile.inputs), ['templates/comic/client/engine-adapter.ts'], 'nothing else is bundled in');
  const file = join(temporaryFolder('adapter'), 'engine-adapter.js');
  writeFileSync(file, result.outputFiles[0]!.contents);
  const scan = await runCheckScript('bundle-clients.mjs', ['--scan', file]);
  assert.equal(scan.code, 0, scan.stderr);
  assert.match(scan.stdout, /scan clean/);
});
