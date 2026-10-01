#!/usr/bin/env node
/**
 * The desktop installers' zip, `papeleria-<version>.zip`: the one file a
 * person downloads, extracts, and runs an installer from, on macOS, Windows 11
 * or Ubuntu 26.04 (installers/README.md). It holds the npm tarball that
 * `npm pack` writes, the installers under `installers/`, their README and the
 * package's licence and notices, in one folder named like the zip:
 *
 *   papeleria-<version>/
 *     README.md, LICENSE, NOTICE.md, TRADEMARKS.md
 *     papeleria-<version>.tgz
 *     macOS/    Install Papeleria.command, Uninstall Papeleria.command
 *     Windows/  Install Papeleria.cmd, Uninstall Papeleria.cmd, install.ps1, uninstall.ps1, launcher.ps1
 *     Ubuntu/   install.sh, uninstall.sh
 *     shared/   common.sh, launcher.sh, make-icons.mjs, node-runtime.txt
 *
 * The zip records Unix modes, so the shell scripts arrive executable where the
 * extractor honours them (macOS's Archive Utility, unzip, GNOME's), and the
 * Windows scripts get CRLF line endings whatever the checkout has. Before
 * writing, it checks what the installers depend on: every Windows script is
 * plain ASCII (Windows PowerShell 5.1 reads a script without a byte-order mark
 * in the system code page, and cmd.exe reads batch files in the console's),
 * the shell scripts have LF endings, the Node.js pin names each archive the
 * installers download, and the tarball carries npm-shrinkwrap.json.
 *
 * It writes the zip, a copy of the tarball and SHA256SUMS for both into the
 * output folder, `release/` at the repository root by default, which
 * .gitignore leaves out.
 *
 * Usage: node scripts/package-installers.mjs [--tarball <file>] [--out <dir>]
 *        (npm run package:installers builds first, then runs this)
 * Exit:  0 written · 1 a check failed · 2 usage or IO
 */
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {crc32, deflateRawSync, gunzipSync} from 'node:zlib';

const APPLICATION_ROOT = fileURLToPath(new URL('..', import.meta.url));
const INSTALLERS = join(APPLICATION_ROOT, 'installers');

class CheckError extends Error {}
class UsageError extends Error {}

/**
 * What the zip holds from installers/, by path in the zip under its top
 * folder: the file's mode and its line endings.
 */
export const INSTALLER_FILES = Object.freeze([
  {path: 'README.md', mode: 0o644, endings: 'lf'},
  {path: 'macOS/Install Papeleria.command', mode: 0o755, endings: 'lf'},
  {path: 'macOS/Uninstall Papeleria.command', mode: 0o755, endings: 'lf'},
  {path: 'Windows/Install Papeleria.cmd', mode: 0o644, endings: 'crlf'},
  {path: 'Windows/Uninstall Papeleria.cmd', mode: 0o644, endings: 'crlf'},
  {path: 'Windows/install.ps1', mode: 0o644, endings: 'crlf'},
  {path: 'Windows/uninstall.ps1', mode: 0o644, endings: 'crlf'},
  {path: 'Windows/launcher.ps1', mode: 0o644, endings: 'crlf'},
  {path: 'Ubuntu/install.sh', mode: 0o755, endings: 'lf'},
  {path: 'Ubuntu/uninstall.sh', mode: 0o755, endings: 'lf'},
  {path: 'shared/common.sh', mode: 0o644, endings: 'lf'},
  {path: 'shared/launcher.sh', mode: 0o755, endings: 'lf'},
  {path: 'shared/make-icons.mjs', mode: 0o644, endings: 'lf'},
  {path: 'shared/node-runtime.txt', mode: 0o644, endings: 'lf'},
]);

/** The package's own terms, beside the installers, so they can be read before installing. */
export const TERMS = Object.freeze(['LICENSE', 'NOTICE.md', 'TRADEMARKS.md']);

/** Each Node.js archive an installer may download, by the platform suffix in its name. */
export const NODE_ARCHIVES = Object.freeze([
  'darwin-arm64.tar.xz',
  'darwin-x64.tar.xz',
  'linux-arm64.tar.xz',
  'linux-arm64.tar.gz',
  'linux-x64.tar.xz',
  'linux-x64.tar.gz',
  'win-x64.zip',
  'win-arm64.zip',
]);

/** node-runtime.txt read: the version and each archive's SHA-256, or the problems found. */
export function readNodePin(text) {
  const problems = [];
  let version = null;
  const hashes = new Map();
  for (const [index, raw] of text.split('\n').entries()) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    if (parts[0] === 'version' && parts.length === 2) {
      version = parts[1];
    } else if (parts.length === 2 && /^[0-9a-f]{64}$/.test(parts[0])) {
      hashes.set(parts[1], parts[0]);
    } else {
      problems.push(`node-runtime.txt line ${index + 1} is neither "version <v>" nor "<sha256>  <file>": ${line}`);
    }
  }
  if (version === null || !/^22\.\d+\.\d+$/.test(version)) {
    problems.push(`node-runtime.txt must name a Node.js 22 release ("version 22.x.y"), as package.json's engines ask; it names ${version ?? 'none'}.`);
  } else {
    for (const suffix of NODE_ARCHIVES) {
      if (!hashes.has(`node-v${version}-${suffix}`)) problems.push(`node-runtime.txt pins no SHA-256 for node-v${version}-${suffix}.`);
    }
    for (const file of hashes.keys()) {
      if (!file.startsWith(`node-v${version}-`)) problems.push(`node-runtime.txt pins ${file}, which is not version ${version}.`);
    }
  }
  return {version, hashes, problems};
}

/** The checks an installer file must pass before it ships; each problem is one sentence. */
export function checkInstallerFile(file, bytes) {
  const problems = [];
  const text = bytes.toString('utf8');
  if (file.endings === 'crlf' && [...bytes].some((byte) => byte > 0x7e || (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d))) {
    problems.push(`${file.path} holds a byte outside printable ASCII; Windows reads it in the system code page.`);
  }
  if (file.endings === 'lf' && text.includes('\r')) {
    problems.push(`${file.path} has a carriage return; shell scripts need LF line endings.`);
  }
  if (file.mode === 0o755 && !text.startsWith('#!/bin/bash\n')) {
    problems.push(`${file.path} is run directly, so it must start with #!/bin/bash.`);
  }
  return problems;
}

/** The file's bytes with the line endings its entry asks for. */
export function withEndings(bytes, endings) {
  const lf = bytes.toString('utf8').replace(/\r\n/g, '\n');
  return Buffer.from(endings === 'crlf' ? lf.replace(/\n/g, '\r\n') : lf, 'utf8');
}

/**
 * README.md as the zip carries it. Its links into the rest of the repository,
 * written `../path` from installers/, lead nowhere in the zip, so each becomes
 * its text with the path in the repository beside it.
 */
export function readmeForZip(text) {
  return text.replace(/\[([^\]]+)\]\(\.\.\/([^)#\s]+)(?:#[^)\s]*)?\)/g, (_, label, path) => `${label} (\`${path}\` in the papeleria repository)`);
}

/** The files of a gzipped tar, by name, read far enough to find package/package.json and the shrinkwrap. */
export function tarballFiles(gzipped) {
  const tar = gunzipSync(gzipped);
  const files = new Map();
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (start, length) => header.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '');
    const size = Number.parseInt(field(124, 12).trim() || '0', 8);
    const prefix = field(345, 155);
    const name = prefix === '' ? field(0, 100) : `${prefix}/${field(0, 100)}`;
    const type = field(156, 1);
    if (type === '0' || type === '') files.set(name, tar.subarray(offset + 512, offset + 512 + size));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

/** DOS date and time, as a zip records them, for a Date read in UTC. */
function dosTime(date) {
  const year = Math.max(1980, date.getUTCFullYear());
  return {
    time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
  };
}

/**
 * A zip archive of the given entries, in their order: `{name, mode, data}`
 * for a file, `{name: 'folder/', mode}` for a folder. Names are UTF-8 and the
 * modes are recorded as Unix ones. Compressed files are stored; everything
 * else is deflated.
 */
export function zipBytes(entries, when = new Date()) {
  const {time, date} = dosTime(when);
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const folder = entry.name.endsWith('/');
    const data = folder ? Buffer.alloc(0) : entry.data;
    const store = folder || /\.(?:tgz|gz|zip|xz|png)$/.test(entry.name);
    const body = store ? data : deflateRawSync(data, {level: 9});
    const name = Buffer.from(entry.name, 'utf8');
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(store ? 0 : 8, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(store ? 0 : 8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    const mode = (folder ? 0o040000 : 0o100000) | entry.mode;
    central.writeUInt32LE(((mode << 16) | (folder ? 0x10 : 0)) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/** The entries of the installers' zip, folders first within each level, every path under `top/`. */
export function zipEntries({top, tarball, tarballName, installers = INSTALLERS, applicationRoot = APPLICATION_ROOT}) {
  const problems = [];
  const files = [];
  for (const file of INSTALLER_FILES) {
    const source = join(installers, ...file.path.split('/'));
    if (!existsSync(source)) {
      problems.push(`installers/${file.path} is missing.`);
      continue;
    }
    const bytes = readFileSync(source);
    problems.push(...checkInstallerFile(file, bytes));
    const shipped = file.path === 'README.md' ? Buffer.from(readmeForZip(bytes.toString('utf8')), 'utf8') : bytes;
    files.push({name: `${top}/${file.path}`, mode: file.mode, data: withEndings(shipped, file.endings)});
  }
  problems.push(...readNodePin(readFileSync(join(installers, 'shared', 'node-runtime.txt'), 'utf8')).problems);
  for (const term of TERMS) {
    files.push({name: `${top}/${term}`, mode: 0o644, data: readFileSync(join(applicationRoot, term))});
  }
  files.push({name: `${top}/${tarballName}`, mode: 0o644, data: tarball});
  const folders = new Set([`${top}/`]);
  for (const file of files) {
    const parts = file.name.split('/').slice(0, -1);
    for (let depth = 1; depth <= parts.length; depth += 1) folders.add(`${parts.slice(0, depth).join('/')}/`);
  }
  const entries = [...[...folders].map((name) => ({name, mode: 0o755})), ...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return {entries, problems};
}

function npmPack(destination) {
  if (!existsSync(join(APPLICATION_ROOT, 'lib', 'src', 'cli', 'index.js'))) {
    throw new UsageError('lib/ is not built, and npm pack would pack no program: run npm run build first (npm run package:installers does both).');
  }
  // npm run sets npm_execpath to npm's own script, which this Node.js can run on every system.
  const npm = process.env['npm_execpath'];
  const [command, args, shell] = npm !== undefined && npm.endsWith('.js')
    ? [process.execPath, [npm], false]
    : ['npm', [], process.platform === 'win32'];
  const packed = spawnSync(command, [...args, 'pack', '--json', '--pack-destination', destination], {cwd: APPLICATION_ROOT, encoding: 'utf8', shell});
  if (packed.status !== 0) throw new UsageError(`npm pack failed:\n${packed.stderr}`);
  const report = JSON.parse(packed.stdout);
  return join(destination, report[0].filename);
}

function parseArguments(argv) {
  const options = {tarball: null, out: join(APPLICATION_ROOT, 'release')};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if ((argument === '--tarball' || argument === '--out') && index + 1 < argv.length) {
      options[argument.slice(2)] = resolve(argv[index + 1]);
      index += 1;
    } else {
      throw new UsageError(`unknown argument ${argument}. Usage: node scripts/package-installers.mjs [--tarball <file>] [--out <dir>]`);
    }
  }
  return options;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function main(argv) {
  const options = parseArguments(argv);
  const scratch = mkdtempSync(join(tmpdir(), 'papeleria-installers-'));
  try {
    const tarballPath = options.tarball ?? npmPack(scratch);
    const tarball = readFileSync(tarballPath);
    const inside = tarballFiles(tarball);
    const manifest = JSON.parse(inside.get('package/package.json')?.toString('utf8') ?? '{}');
    if (manifest.name !== 'papeleria' || typeof manifest.version !== 'string') throw new CheckError(`${basename(tarballPath)} is not a Papeleria package.`);
    if (!inside.has('package/npm-shrinkwrap.json')) {
      throw new CheckError(`${basename(tarballPath)} holds no npm-shrinkwrap.json, and the installers install the tree it pins. Pack it with npm pack, whose prepack script writes it.`);
    }
    const top = `papeleria-${manifest.version}`;
    const tarballName = `papeleria-${manifest.version}.tgz`;
    const {entries, problems} = zipEntries({top, tarball, tarballName});
    if (problems.length > 0) throw new CheckError(problems.join('\n'));
    const epoch = process.env['SOURCE_DATE_EPOCH'];
    const zip = zipBytes(entries, epoch === undefined ? new Date() : new Date(Number(epoch) * 1000));
    mkdirSync(options.out, {recursive: true});
    const zipName = `${top}.zip`;
    writeFileSync(join(options.out, zipName), zip);
    if (resolve(tarballPath) !== resolve(join(options.out, tarballName))) copyFileSync(tarballPath, join(options.out, tarballName));
    const sums = `${sha256(zip)}  ${zipName}\n${sha256(tarball)}  ${tarballName}\n`;
    writeFileSync(join(options.out, 'SHA256SUMS'), sums);
    process.stdout.write(
      `Wrote ${join(options.out, zipName)}: ${zip.length.toLocaleString('en-US')} bytes, ${entries.filter((entry) => !entry.name.endsWith('/')).length} files\n` +
        `Wrote ${join(options.out, 'SHA256SUMS')}:\n${sums}`,
    );
    return 0;
  } finally {
    rmSync(scratch, {recursive: true, force: true});
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`package-installers: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = error instanceof CheckError ? 1 : 2;
  }
}
