/**
 * The release proof's one flow (M1.8, M5.5; D68, D140, D196): `npm pack` writes
 * the tarball from the built application root, and `npm install --omit=dev`
 * installs it with its production dependencies into an empty folder, as an
 * author installs a release from the registry. The tarball proof
 * (`test/package/tarball.ts`, in the scaffold job) and the browser smoke
 * (`test/browser/release-smoke.test.ts`, in the browser job) both use it, so the
 * two prove the same installation.
 *
 * npm installs a package's dependencies from the `npm-shrinkwrap.json` it
 * carries only when the registry says it carries one (`_hasShrinkwrap`), never
 * for a tarball given by path (D196). So the tarball is installed through a
 * registry of one package on 127.0.0.1, which serves it with the metadata the
 * npm registry gives it; every dependency comes from the shrinkwrap's resolved
 * addresses at the npm registry, or from npm's cache when `npm ci` has just
 * filled it, so neither user runs inside `npm test`. It runs no package's
 * install script (`--ignore-scripts`): no production dependency has one
 * (`test/unit/install-scripts.test.ts`), so none should run code on the runner
 * (security audit F11). The installed CLI is started through npm's `.bin`
 * link, as a user's shell starts it (D68).
 *
 * Node-side only and free of DOM types, so both test programs can import it.
 */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {createServer, request} from 'node:http';
import type {AddressInfo} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {applicationRoot} from './paths.js';

export type Run = {code: number; stdout: string; stderr: string};

/** Runs a command to completion, collecting its output. `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD` is set, as in CI's scaffold job (D23). */
export function run(command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv = {}): Promise<Run> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {cwd, stdio: ['ignore', 'pipe', 'pipe'], env: {...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1', ...env}});
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (stdout += chunk));
    child.stderr.on('data', (chunk: string) => (stderr += chunk));
    child.on('error', rejectPromise);
    child.on('close', (code) => resolvePromise({code: code ?? -1, stdout, stderr}));
  });
}

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

/** What `npm pack --json` reports for the tarball. */
export type Packed = {
  readonly filename: string;
  readonly size: number;
  readonly unpackedSize: number;
  readonly entryCount: number;
  readonly integrity: string;
  readonly files: readonly {readonly path: string; readonly size: number}[];
};

export type Installation = {
  /** The temporary folder holding the tarball and the installation; `remove` deletes it. */
  readonly workspace: string;
  readonly packed: Packed;
  /** The tarball's path and its SHA-256. */
  readonly tarball: string;
  readonly sha256: string;
  /** The project folder the tarball is installed into, and the installed package inside it. */
  readonly install: string;
  readonly packageRoot: string;
  /** The installed command, npm's `.bin` link. */
  readonly bin: string;
  /** Runs the installed CLI in the project folder. */
  cli(args: readonly string[], env?: NodeJS.ProcessEnv): Promise<Run>;
  remove(): void;
};

/**
 * A registry of one package on 127.0.0.1: its metadata, marked as carrying a
 * shrinkwrap when the tarball does, as the npm registry marks it, and the
 * tarball. It knows no other package: npm takes the dependencies from the
 * shrinkwrap's resolved addresses.
 */
async function oneTarballRegistry(tarball: string, manifest: Readonly<Record<string, unknown>> & {name: string; version: string}, hasShrinkwrap: boolean): Promise<{url: string; close(): Promise<void>}> {
  const bytes = readFileSync(tarball);
  const file = `/${manifest.name}/-/${manifest.name}-${manifest.version}.tgz`;
  const server = createServer((incoming, response) => {
    const path = decodeURIComponent(new URL(incoming.url ?? '/', 'http://registry').pathname);
    if (path === `/${manifest.name}`) {
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const dist = {tarball: `${origin}${file}`, integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`, shasum: createHash('sha1').update(bytes).digest('hex')};
      response.writeHead(200, {'content-type': 'application/json'});
      response.end(JSON.stringify({name: manifest.name, 'dist-tags': {latest: manifest.version}, versions: {[manifest.version]: {...manifest, _hasShrinkwrap: hasShrinkwrap, dist}}}));
    } else if (path === file) {
      response.writeHead(200, {'content-type': 'application/octet-stream'});
      response.end(bytes);
    } else {
      response.writeHead(404, {'content-type': 'application/json'});
      response.end('{"error":"not found"}');
    }
  });
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`,
    close: () => new Promise<void>((resolveClose) => server.close(() => resolveClose())),
  };
}

/** Packs the built application root and installs the tarball for production into an empty folder, as from the registry. */
export async function packAndInstall(label: string): Promise<Installation> {
  const workspace = mkdtempSync(join(tmpdir(), `papeleria-${label}-`));
  const pack = await run(npm, ['pack', '--json', '--pack-destination', workspace], applicationRoot);
  assert.equal(pack.code, 0, pack.stderr);
  const packed = (JSON.parse(pack.stdout) as Packed[])[0]!;
  const tarball = join(workspace, packed.filename);
  const install = join(workspace, 'install');
  mkdirSync(install);
  writeFileSync(join(install, 'package.json'), `${JSON.stringify({name: `papeleria-${label}`, version: '0.0.0', private: true}, null, 2)}\n`);
  const manifest = JSON.parse(readFileSync(join(applicationRoot, 'package.json'), 'utf8')) as Record<string, unknown> & {name: string; version: string};
  const registry = await oneTarballRegistry(tarball, manifest, packed.files.some((entry) => entry.path === 'npm-shrinkwrap.json'));
  let installed: Run;
  try {
    // The resolved addresses in the shrinkwrap stay the npm registry's (`--replace-registry-host=never`),
    // and the one-package registry is reached directly, never through a proxy the environment names.
    const direct = ['127.0.0.1', process.env['NO_PROXY'] ?? process.env['no_proxy'] ?? ''].filter((entry) => entry !== '').join(',');
    installed = await run(
      npm,
      ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', `--registry=${registry.url}`, '--replace-registry-host=never', `${manifest.name}@${manifest.version}`],
      install,
      {NO_PROXY: direct, no_proxy: direct},
    );
  } finally {
    await registry.close();
  }
  assert.equal(installed.code, 0, installed.stderr);
  const bin = join(install, 'node_modules', '.bin', 'papeleria');
  return {
    workspace,
    packed,
    tarball,
    sha256: createHash('sha256').update(readFileSync(tarball)).digest('hex'),
    install,
    packageRoot: join(install, 'node_modules', 'papeleria'),
    bin,
    cli: (args, env = {}) => run(process.execPath, [bin, ...args], install, env),
    remove: () => rmSync(workspace, {recursive: true, force: true}),
  };
}

/** The bytes and regular files under a folder, links not followed: the installed footprint. */
export function footprint(folder: string): {bytes: number; files: number} {
  let bytes = 0;
  let files = 0;
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, {withFileTypes: true})) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (entry.isFile()) {
        bytes += lstatSync(path).size;
        files += 1;
      }
    }
  };
  walk(folder);
  return {bytes, files};
}

/** A process the installed CLI started, once it printed what `ready` matches. */
export type Started = {readonly match: RegExpMatchArray; stop(): Promise<Run>};

/** Starts the installed CLI with the opener off, reads stderr until `ready` matches, and returns what it matched and how to stop it with Ctrl C. */
export function startInstalled(installation: Pick<Installation, 'bin' | 'install'>, args: readonly string[], ready: RegExp): Promise<Started> {
  return new Promise((resolveStart, rejectStart) => {
    const child = spawn(process.execPath, [installation.bin, ...args], {
      cwd: installation.install,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {...process.env, PAPELERIA_NO_BROWSER: '1'},
    });
    let stdout = '';
    let stderr = '';
    let started = false;
    const ended = new Promise<Run>((resolveEnd) => child.on('close', (code) => resolveEnd({code: code ?? -1, stdout, stderr})));
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (stdout += chunk));
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
      const match = ready.exec(stderr);
      if (match !== null && !started) {
        started = true;
        resolveStart({
          match,
          stop: () => {
            child.kill('SIGINT');
            return ended;
          },
        });
      }
    });
    child.on('error', rejectStart);
    void ended.then((result) => {
      if (!started) {
        rejectStart(new Error(`papeleria ${args.join(' ')} exited before it was ready: ${result.stderr}`));
      }
    });
  });
}

/** A GET with the Host header the server expects, and optionally the session token. */
export function get(url: string, token?: string): Promise<{status: number; type: string; body: string}> {
  return new Promise((resolveGet, rejectGet) => {
    const call = request(url, {headers: token === undefined ? {} : {'x-papeleria-token': token}}, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => (body += chunk));
      response.on('end', () => resolveGet({status: response.statusCode ?? 0, type: String(response.headers['content-type'] ?? ''), body}));
    });
    call.on('error', rejectGet);
    call.end();
  });
}

/** Redeems a launch token for the session token, as the editor page does, with the editor's Origin (D192). */
export function redeem(origin: string, launchToken: string): Promise<string> {
  return new Promise((resolveRedeem, rejectRedeem) => {
    const payload = JSON.stringify({launchToken});
    const call = request(
      `${origin}/api/session`,
      {method: 'POST', headers: {origin, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload)}},
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => (body += chunk));
        response.on('end', () => {
          const token = response.statusCode === 200 ? (JSON.parse(body) as {token?: unknown}).token : undefined;
          if (typeof token === 'string') {
            resolveRedeem(token);
          } else {
            rejectRedeem(new Error(`POST /api/session answered ${response.statusCode ?? 0}: ${body}`));
          }
        });
      },
    );
    call.on('error', rejectRedeem);
    call.end(payload);
  });
}

/** The launch line `edit` prints: the editor's origin and the launch token, which opens the session once (D192). */
export const EDIT_READY = /^(http:\/\/127\.0\.0\.1:[0-9]+)\/#token=([0-9a-f]{64})$/m;

/** The line `serve` prints: its origin. */
export const SERVE_READY = /^Open (http:\/\/127\.0\.0\.1:[0-9]+) in a browser on this machine\./m;
