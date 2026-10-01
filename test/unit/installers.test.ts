/**
 * The desktop installers under installers/ (installers/README.md), and the
 * zip `scripts/package-installers.mjs` makes of them. The script checks the
 * installers before it writes a zip; these tests hold the same checks on every
 * commit, then read a zip it writes back, entry by entry:
 *
 * - shared/node-runtime.txt pins a Node.js 22 release, as package.json's
 *   engines ask, with a SHA-256 for each archive an installer downloads, and
 *   each installer names its archives the way the pin lists them;
 * - the Windows scripts are plain ASCII, since Windows PowerShell 5.1 and
 *   cmd.exe read them in the system's code page; the shell scripts have LF
 *   endings, start with #!/bin/bash where they are run directly, are
 *   executable in the checkout, and parse in bash;
 * - the zip has one top folder, records Unix modes, gives the Windows files
 *   CRLF endings, inflates to the bytes it was given, and its README has no
 *   link that leads out of the zip.
 */
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {pathToFileURL} from 'node:url';
import {crc32, inflateRawSync} from 'node:zlib';

import {applicationRoot, scriptPath} from '../helpers/paths.js';

type InstallerFile = {path: string; mode: number; endings: 'lf' | 'crlf'};
type ZipEntry = {name: string; mode: number; data?: Buffer};
type Packager = {
  INSTALLER_FILES: readonly InstallerFile[];
  NODE_ARCHIVES: readonly string[];
  readNodePin(text: string): {version: string | null; hashes: Map<string, string>; problems: string[]};
  checkInstallerFile(file: InstallerFile, bytes: Buffer): string[];
  withEndings(bytes: Buffer, endings: 'lf' | 'crlf'): Buffer;
  readmeForZip(text: string): string;
  tarballFiles(gzipped: Buffer): Map<string, Buffer>;
  zipBytes(entries: readonly ZipEntry[], when?: Date): Buffer;
  zipEntries(options: {top: string; tarball: Buffer; tarballName: string}): {entries: ZipEntry[]; problems: string[]};
};

const packager = (await import(pathToFileURL(scriptPath('package-installers.mjs')).href)) as Packager;
const installers = join(applicationRoot, 'installers');
const read = (path: string): Buffer => readFileSync(join(installers, ...path.split('/')));

/** A zip's entries, read from its central directory: name, Unix mode and the inflated bytes, each checked against its CRC. */
function unzip(zip: Buffer): {name: string; mode: number; data: Buffer}[] {
  const end = zip.length - 22;
  assert.equal(zip.readUInt32LE(end), 0x06054b50, 'the zip ends with its end-of-directory record');
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    assert.equal(zip.readUInt32LE(at), 0x02014b50);
    assert.equal(zip.readUInt16LE(at + 4) >> 8, 3, 'made on Unix, so extractors read the modes');
    const method = zip.readUInt16LE(at + 10);
    const checksum = zip.readUInt32LE(at + 16);
    const compressed = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const mode = zip.readUInt32LE(at + 38) >>> 16;
    const local = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    assert.equal(zip.readUInt32LE(local), 0x04034b50);
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const body = zip.subarray(start, start + compressed);
    const data = method === 8 ? inflateRawSync(body) : Buffer.from(body);
    assert.equal(crc32(data), checksum, `${name} matches its CRC`);
    entries.push({name, mode, data});
    at += 46 + nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
  }
  return entries;
}

test('node-runtime.txt pins a Node.js 22 release and a SHA-256 for each archive the installers download', () => {
  const pin = packager.readNodePin(read('shared/node-runtime.txt').toString('utf8'));
  assert.deepEqual(pin.problems, []);
  const engines = (JSON.parse(readFileSync(join(applicationRoot, 'package.json'), 'utf8')) as {engines: {node: string}}).engines.node;
  assert.equal(engines, '22.x');
  assert.match(pin.version ?? '', /^22\.\d+\.\d+$/);
  assert.equal(pin.hashes.size, packager.NODE_ARCHIVES.length, 'one line for each archive, and no other');
  // Each installer builds its archive's name the way the pin lists it.
  assert.ok(read('Ubuntu/install.sh').includes('NODE_ARCHIVE="node-v$(node_pin version)-linux-$arch.tar.xz"'));
  assert.ok(read('Ubuntu/install.sh').includes('NODE_ARCHIVE="node-v$(node_pin version)-linux-$arch.tar.gz"'));
  assert.ok(read('macOS/Install Papeleria.command').includes('NODE_ARCHIVE="node-v$(node_pin version)-darwin-$arch.tar.xz"'));
  assert.ok(read('Windows/install.ps1').includes('$archive = "node-v$nodeVersion-win-$arch.zip"'));
});

test('the pin refuses what an installer could not use', () => {
  const good = packager.readNodePin(read('shared/node-runtime.txt').toString('utf8'));
  const lines = [...good.hashes].map(([file, hash]) => `${hash}  ${file}`);
  assert.match(packager.readNodePin(['version 24.1.0', ...lines].join('\n')).problems.join(' '), /Node\.js 22/);
  assert.match(packager.readNodePin([`version ${good.version}`, ...lines.slice(1)].join('\n')).problems.join(' '), /pins no SHA-256/);
  assert.match(packager.readNodePin([`version ${good.version}`, ...lines, 'abc  node.zip'].join('\n')).problems.join(' '), /neither/);
});

test('every installer file is there, the Windows ones plain ASCII, the shell scripts LF and started by bash', () => {
  for (const file of packager.INSTALLER_FILES) {
    assert.deepEqual(packager.checkInstallerFile(file, read(file.path)), [], file.path);
    if (file.mode === 0o755 && process.platform !== 'win32') {
      assert.ok((statSync(join(installers, ...file.path.split('/'))).mode & 0o111) !== 0, `${file.path} is executable in the checkout`);
    }
  }
  const bad = packager.checkInstallerFile({path: 'Windows/x.ps1', mode: 0o644, endings: 'crlf'}, Buffer.from('Write-Host "café"\r\n'));
  assert.match(bad.join(' '), /printable ASCII/);
  assert.match(packager.checkInstallerFile({path: 'Ubuntu/x.sh', mode: 0o755, endings: 'lf'}, Buffer.from('#!/bin/bash\r\n')).join(' '), /carriage return/);
  assert.match(packager.checkInstallerFile({path: 'Ubuntu/x.sh', mode: 0o755, endings: 'lf'}, Buffer.from('#!/bin/sh\n')).join(' '), /#!\/bin\/bash/);
});

test('the shell scripts parse in bash', {skip: spawnSync('bash', ['--version']).status !== 0 && 'bash is not installed'}, () => {
  for (const file of packager.INSTALLER_FILES.filter((entry) => /\.(?:sh|command)$/.test(entry.path))) {
    const parsed = spawnSync('bash', ['-n', join(installers, ...file.path.split('/'))], {encoding: 'utf8'});
    assert.equal(parsed.status, 0, `${file.path}: ${parsed.stderr}`);
  }
});

test('line endings: CRLF for Windows, LF for the rest, whatever the checkout gave', () => {
  assert.equal(packager.withEndings(Buffer.from('a\nb\r\nc\n'), 'crlf').toString(), 'a\r\nb\r\nc\r\n');
  assert.equal(packager.withEndings(Buffer.from('a\r\nb\nc\r\n'), 'lf').toString(), 'a\nb\nc\n');
});

test("the zip's README names the repository's pages instead of linking out of the zip", () => {
  const readme = packager.readmeForZip(read('README.md').toString('utf8'));
  assert.doesNotMatch(readme, /\]\(\.\.\//);
  assert.match(readme, /First piece \(`docs\/USER_MANUAL\.md` in the papeleria repository\)/);
  assert.match(readme, /\]\(#the-launcher\)/, 'links within the page stay');
});

test('the zip holds one folder with every installer, the tarball and the terms, with Unix modes and each system\'s line endings', () => {
  const tarball = Buffer.from('a stand-in for the tarball');
  const {entries, problems} = packager.zipEntries({top: 'papeleria-9.9.9', tarball, tarballName: 'papeleria-9.9.9.tgz'});
  assert.deepEqual(problems, []);
  const zipped = unzip(packager.zipBytes(entries, new Date(Date.UTC(2026, 8, 30, 12, 0, 0))));
  const byName = new Map(zipped.map((entry) => [entry.name, entry]));
  assert.ok(zipped.every((entry) => entry.name.startsWith('papeleria-9.9.9/')), 'one top folder');
  for (const folder of ['papeleria-9.9.9/', 'papeleria-9.9.9/macOS/', 'papeleria-9.9.9/Windows/', 'papeleria-9.9.9/Ubuntu/', 'papeleria-9.9.9/shared/']) {
    assert.equal(byName.get(folder)?.mode, 0o040755, folder);
  }
  for (const file of packager.INSTALLER_FILES) {
    const entry = byName.get(`papeleria-9.9.9/${file.path}`);
    assert.ok(entry, `${file.path} is in the zip`);
    assert.equal(entry.mode, 0o100000 | file.mode, `${file.path} mode`);
    const text = entry.data.toString('utf8');
    if (file.endings === 'crlf') {
      assert.equal(text.split('\n').length, text.split('\r\n').length, `${file.path} has CRLF endings only`);
    } else {
      assert.ok(!text.includes('\r'), `${file.path} has LF endings`);
    }
  }
  assert.deepEqual(byName.get('papeleria-9.9.9/papeleria-9.9.9.tgz')?.data, tarball, 'the tarball, byte for byte');
  for (const term of ['LICENSE', 'NOTICE.md', 'TRADEMARKS.md']) {
    assert.deepEqual(byName.get(`papeleria-9.9.9/${term}`)?.data, readFileSync(join(applicationRoot, term)), term);
  }
  assert.equal(zipped.length, 5 + packager.INSTALLER_FILES.length + 4, 'the folders, the installer files, the three terms and the tarball; nothing else');
});

test('the tarball reader finds the package manifest and the shrinkwrap the installers need', {skip: spawnSync('tar', ['--version']).status !== 0 && 'tar is not installed'}, () => {
  const root = mkdtempSync(join(tmpdir(), 'papeleria-installers-'));
  try {
    mkdirSync(join(root, 'package'));
    writeFileSync(join(root, 'package', 'package.json'), '{"name": "papeleria", "version": "9.9.9"}\n');
    writeFileSync(join(root, 'package', 'npm-shrinkwrap.json'), '{}\n');
    const packed = spawnSync('tar', ['-czf', 'p.tgz', 'package'], {cwd: root});
    assert.equal(packed.status, 0);
    const files = packager.tarballFiles(readFileSync(join(root, 'p.tgz')));
    assert.equal(files.get('package/package.json')?.toString('utf8'), '{"name": "papeleria", "version": "9.9.9"}\n');
    assert.ok(files.has('package/npm-shrinkwrap.json'));
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});
