/**
 * M2.6: `papeleria edit` and `papeleria serve` as a person runs them — the
 * compiled CLI in a child process, stopped with Ctrl C (SIGINT) — and once
 * in process, to see what the browser opener is handed. The child processes
 * run with PAPELERIA_NO_BROWSER set, so no browser is ever started.
 */
import assert from 'node:assert/strict';
import {spawn, type ChildProcess} from 'node:child_process';
import {existsSync, readdirSync, readFileSync, writeFileSync} from 'node:fs';
import {createServer, type Server} from 'node:http';
import {connect} from 'node:net';
import {join} from 'node:path';
import {after, test} from 'node:test';

import {runCli, type CliIo} from '../../src/cli/index.js';
import {revisionOf} from '../../src/server/index.js';
import {applicationRoot, runNode} from '../helpers/paths.js';
import {removeTemporaryFolders, temporaryFolder} from '../helpers/pieces.js';
import {body, call, json, openEvents, starterDeck} from './server-helpers.js';

/** Every CLI a test started; one a failed assertion left running is killed after the file. */
const children = new Set<ChildProcess>();

after(() => {
  for (const child of children) {
    child.kill('SIGKILL');
  }
  removeTemporaryFolders();
});

const CLI = join(applicationRoot, 'lib', 'src', 'cli', 'index.js');
const LAUNCH = /^http:\/\/127\.0\.0\.1:([0-9]+)\/#token=([0-9a-f]{64})$/m;

type Ended = {code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string};

type Running = {
  stdout(): string;
  stderr(): string;
  /** Resolves once stderr matches `pattern`, with the match. */
  waitFor(pattern: RegExp, timeoutMs?: number): Promise<RegExpMatchArray>;
  /** Sends `signal` (Ctrl C by default) and resolves when the process has exited. */
  stop(signal?: NodeJS.Signals): Promise<Ended>;
  ended: Promise<Ended>;
};

/** Starts the compiled CLI with the browser opener off. */
function startCli(args: readonly string[]): Running {
  const child = spawn(process.execPath, [CLI, ...args], {
    cwd: applicationRoot,
    env: {...process.env, PAPELERIA_NO_BROWSER: '1'},
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  let stdout = '';
  let stderr = '';
  const listeners = new Set<() => void>();
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
    for (const listener of [...listeners]) {
      listener();
    }
  });
  const ended = new Promise<Ended>((resolveEnded, rejectEnded) => {
    child.on('error', rejectEnded);
    child.on('close', (code, signal) => {
      children.delete(child);
      resolveEnded({code, signal, stdout, stderr});
    });
  });
  return {
    stdout: () => stdout,
    stderr: () => stderr,
    waitFor(pattern, timeoutMs = 20_000) {
      return new Promise((resolveMatch, rejectMatch) => {
        const check = (): boolean => {
          const match = pattern.exec(stderr);
          if (match !== null) {
            listeners.delete(listener);
            clearTimeout(timer);
            resolveMatch(match);
            return true;
          }
          return false;
        };
        const listener = (): void => void check();
        const timer = setTimeout(() => {
          listeners.delete(listener);
          rejectMatch(new Error(`stderr never matched ${pattern}:\n${stderr}`));
        }, timeoutMs);
        listeners.add(listener);
        if (!check()) {
          void ended.then(() => {
            if (!check()) {
              listeners.delete(listener);
              clearTimeout(timer);
              rejectMatch(new Error(`the CLI exited before stderr matched ${pattern}:\n${stderr}`));
            }
          });
        }
      });
    },
    async stop(signal = 'SIGINT') {
      child.kill(signal);
      return ended;
    },
    ended,
  };
}

/** A port nothing listens on at the moment. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  assert.ok(address !== null && typeof address === 'object');
  return address.port;
}

/** True when nothing accepts connections on the port. */
function refuses(port: number): Promise<boolean> {
  return new Promise((resolveProbe) => {
    const socket = connect({host: '127.0.0.1', port});
    socket.once('connect', () => {
      socket.destroy();
      resolveProbe(false);
    });
    socket.once('error', () => resolveProbe(true));
  });
}

function generationsLeft(root: string): string[] {
  const folder = join(root, '.papeleria', 'preview');
  return existsSync(folder) ? readdirSync(folder) : [];
}

function occurrences(text: string, part: string): number {
  return text.split(part).length - 1;
}

test('edit prints the launch address once, and Ctrl C stops both origins and removes every preview generation', async () => {
  const root = starterDeck('cli-edit');
  const port = await freePort();
  const run = startCli(['edit', root, '--port', String(port)]);
  await run.waitFor(/Ctrl C stops the editor\.\n/);
  const [, launchPort, token] = LAUNCH.exec(run.stderr())!;
  assert.equal(Number(launchPort), port, '--port chooses the editor port');
  const editorOrigin = `http://127.0.0.1:${port}`;
  const previewOrigin = /its preview is served from (http:\/\/127\.0\.0\.1:[0-9]+)\./.exec(run.stderr())?.[1];
  assert.ok(previewOrigin !== undefined && previewOrigin !== editorOrigin, run.stderr());
  assert.match(run.stderr(), new RegExp(`^Papeleria is editing .*piece at ${editorOrigin.replace(/[.]/g, '\\.')}; `, 'm'));
  assert.match(run.stderr(), /^Open this address in a browser on this machine\. Keep it private: it holds this session’s key\.$/m, 'no opener, so no promise of one');

  // The session works: the page, the launch token redeemed as the page redeems it (D192), the API behind
  // the session token it gives, a preview on the preview origin.
  assert.equal((await call(`${editorOrigin}/`)).status, 200);
  const redeemed = await call(`${editorOrigin}/api/session`, {method: 'POST', ...body({launchToken: token}), headers: {origin: editorOrigin, 'content-type': 'application/json'}});
  assert.equal(redeemed.status, 200, redeemed.body);
  const sessionToken = String(json(redeemed)['token']);
  const resumeToken = String(json(redeemed)['resumeToken']);
  assert.notEqual(sessionToken, token, 'the address held a launch token, not the session token');
  await run.waitFor(/^The editor opened\. To open it in another tab, use this address; it works once:\nhttp:\/\/127\.0\.0\.1:[0-9]+\/#token=[0-9a-f]{64}\n/m);
  const headers = {'x-papeleria-token': sessionToken, origin: editorOrigin};
  const piece = json(await call(`${editorOrigin}/api/piece`, {headers}));
  const manifestText = String(piece['manifestText']);
  const preview = await call(`${editorOrigin}/api/preview`, {
    method: 'POST',
    ...body({
      requestId: 1,
      manifestPath: 'papeleria.yaml',
      manifestText,
      manifestBaseRevision: revisionOf(Buffer.from(manifestText, 'utf8')),
      overlays: [],
      cursor: {path: 'papeleria.yaml', line: 1, column: 1},
    }),
    headers: {...headers, 'content-type': 'application/json'},
  });
  assert.equal(preview.status, 200, preview.body);
  const generationURL = String(json(preview)['generationURL']);
  assert.ok(generationURL.startsWith(`${previewOrigin}/`));
  assert.equal((await call(generationURL)).status, 200);
  assert.equal(generationsLeft(root).length, 1);

  const ended = await run.stop('SIGINT');
  assert.equal(ended.code, 0, ended.stderr);
  assert.match(ended.stderr, /Stopping the editor…\nStopped\. The preview files were removed\.\n$/);
  assert.deepEqual(generationsLeft(root), [], 'Ctrl C removes the generations');
  assert.equal(await refuses(port), true, 'the editor origin is closed');
  assert.equal(await refuses(Number(new URL(previewOrigin).port)), true, 'the preview origin is closed');
  assert.equal(existsSync(join(root, 'dist')), false);
  // The launch display is the first launch token's one appearance: nowhere else on stderr, never on
  // stdout; the session token has none at all.
  assert.equal(occurrences(ended.stderr, token!), 1);
  assert.equal(occurrences(ended.stderr, sessionToken), 0);
  assert.equal(occurrences(ended.stderr, resumeToken), 0, 'nor a resume token (D195)');
  assert.equal(ended.stdout, '');
});

test('SIGTERM stops edit the same way', async () => {
  const root = starterDeck('cli-term');
  const run = startCli(['edit', root]);
  const [, port] = await run.waitFor(LAUNCH);
  const ended = await run.stop('SIGTERM');
  assert.equal(ended.code, 0, ended.stderr);
  assert.match(ended.stderr, /Stopped\. The preview files were removed\.\n$/);
  assert.equal(await refuses(Number(port)), true);
});

test('a port in use stops edit and serve with E_PORT, and nothing is left behind', async () => {
  const root = starterDeck('cli-busy');
  const busy: Server = createServer((_request, response) => response.end('someone else'));
  await new Promise<void>((resolveListen) => busy.listen(0, '127.0.0.1', resolveListen));
  const port = (busy.address() as {port: number}).port;
  try {
    for (const command of ['edit', 'serve']) {
      const result = await runNode(CLI, [command, root, `--port=${port}`]);
      assert.equal(result.code, 2, `${command}: ${result.stderr}`);
      assert.equal(result.stdout, '');
      assert.equal(
        result.stderr,
        `papeleria: E_PORT: Port ${port} is in use. Choose another with --port, or leave --port out to use a free one.\n`,
      );
      assert.doesNotMatch(result.stderr, /#token=/);
      assert.deepEqual(generationsLeft(root), []);
    }
    assert.equal((await call(`http://127.0.0.1:${port}/`)).body, 'someone else', 'the other program keeps its port');
  } finally {
    await new Promise<void>((resolveClose) => busy.close(() => resolveClose()));
  }
});

test('edit and serve name their folder and --port; anything else is a usage error', async () => {
  const root = starterDeck('cli-usage');
  const parent = temporaryFolder('cli-usage-parent');
  const usage: [string[], string, RegExp][] = [
    [['edit'], 'E_USAGE', /Give edit a piece folder: papeleria edit my-deck\. Make one with papeleria new deck my-deck\./],
    [['serve'], 'E_USAGE', /Give serve a piece folder: papeleria serve my-deck\. Make one with papeleria new deck my-deck\./],
    [['edit', '--port', '4400'], 'E_USAGE', /Give edit a piece folder/],
    [['edit', 'a', 'b'], 'E_USAGE', /edit takes a piece folder; it was given 2 arguments/],
    [['edit', root, '--port'], 'E_USAGE', /--port needs a port number, such as papeleria edit my-deck --port 4400\./],
    [['edit', root, '--port', '0'], 'E_USAGE', /--port takes a whole number from 1 to 65535; it was given "0"\. Leave --port out to use a free port\./],
    [['serve', root, '--port=70000'], 'E_USAGE', /--port takes a whole number from 1 to 65535; it was given "70000"/],
    [['edit', root, '--port', '+80'], 'E_USAGE', /it was given "\+80"/],
    [['edit', root, '--port', '0x50'], 'E_USAGE', /it was given "0x50"/],
    [['serve', root, '--json'], 'E_USAGE', /serve does not take the option "--json"/],
    [['build', root, '--port', '4400'], 'E_USAGE', /build does not take the option "--port"/],
    [['check', root, '--port=4400'], 'E_USAGE', /check does not take the option "--port"/],
  ];
  for (const [args, code, pattern] of usage) {
    const result = await runNode(CLI, args);
    assert.equal(result.code, 2, args.join(' '));
    assert.equal(result.stdout, '', args.join(' '));
    assert.match(result.stderr, new RegExp(`^papeleria: ${code}: `), args.join(' '));
    assert.match(result.stderr, pattern, args.join(' '));
    assert.match(result.stderr, /Usage: papeleria/, args.join(' '));
  }
  const missing = await runNode(CLI, ['edit', join(parent, 'nowhere')]);
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /^papeleria: E_PIECE_FOLDER: The piece folder .*nowhere does not exist\. Make one with papeleria new deck /);
  const help = await runNode(CLI, ['--help']);
  assert.match(help.stdout, /^ {2}edit <folder> \[--port N\] +Open the piece in the local editor; Ctrl C stops it$/m);
  assert.match(help.stdout, /^ {2}serve <folder> \[--port N\] +Serve a read-only preview that reloads when a file changes$/m);
  assert.match(help.stdout, /^ {2}--port N +The port edit or serve listens on at 127\.0\.0\.1; a free one if left out$/m);
});

test('serve logs each build, keeps the last good preview after a broken save, never writes dist, and stops on Ctrl C', async () => {
  const root = starterDeck('cli-serve');
  const port = await freePort();
  const run = startCli(['serve', root, `--port=${port}`]);
  const origin = `http://127.0.0.1:${port}`;
  await run.waitFor(new RegExp(`^Open ${origin.replace(/[.]/g, '\\.')} in a browser on this machine\\. Ctrl C stops it\\.$`, 'm'));
  assert.match(run.stderr(), /^Papeleria is serving a read-only preview of .*piece; it reloads when a file changes and never writes dist\/\.$/m);
  await run.waitFor(/^Previewed .*piece · 0 errors · /m);

  const events = await openEvents(`${origin}/events`, {});
  const hello = await events.next((event) => event.event === 'hello');
  const shown = hello.data['shown'] as {generationId: string; generationURL: string};
  assert.equal((await call(shown.generationURL)).status, 200);

  const manifest = join(root, 'papeleria.yaml');
  const original = readFileSync(manifest, 'utf8');
  writeFileSync(manifest, original.replace('layout: statement', 'layout: poster'));
  await events.next((event) => event.event === 'build-failed');
  await run.waitFor(/^Still showing the last good build\.$/m);
  assert.match(run.stderr(), /papeleria\.yaml:[0-9]+:[0-9]+ error R09: /);
  assert.equal((await call(shown.generationURL)).status, 200, 'the last good generation is still served');

  writeFileSync(manifest, original);
  const reload = await events.next((event) => event.event === 'reload' && event.data['generationId'] !== shown.generationId);
  assert.equal((await call(String(reload.data['generationURL']))).status, 200);
  events.close();

  const ended = await run.stop('SIGINT');
  assert.equal(ended.code, 0, ended.stderr);
  assert.match(ended.stderr, /Stopping the preview…\nStopped\. The preview files were removed\.\n$/);
  assert.equal(ended.stdout, '');
  assert.doesNotMatch(ended.stderr, /#token=|[0-9a-f]{64}/, 'serve has no token to show');
  assert.deepEqual(generationsLeft(root), []);
  assert.equal(existsSync(join(root, 'dist')), false, 'serve never writes dist/');
  assert.equal(await refuses(port), true);
});

test('edit hands the opener the address it printed, and says so once when no browser opens', async () => {
  const root = starterDeck('cli-opener');
  const stderr: string[] = [];
  const io: CliIo = {out: () => assert.fail('edit writes nothing to stdout'), err: (text) => stderr.push(text)};
  let stop!: () => void;
  const until = new Promise<void>((resolveUntil) => {
    stop = resolveUntil;
  });
  const opened: string[] = [];
  const running = runCli(['edit', root], io, {
    until,
    openBrowser: (url, failed) => {
      opened.push(url);
      failed();
      failed();
    },
  });
  for (let waited = 0; !stderr.some((line) => line.startsWith('Ctrl C')) && waited < 200; waited += 1) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  const printed = stderr.filter((line) => LAUNCH.test(line));
  assert.equal(printed.length, 1);
  assert.deepEqual(opened, printed, 'the opener gets exactly the printed launch address');
  const note = stderr.indexOf('No browser opened. Paste the address above into a browser on this machine.');
  assert.ok(note > stderr.indexOf(printed[0]!), 'the note follows the address it points to');
  assert.equal(stderr.lastIndexOf('No browser opened. Paste the address above into a browser on this machine.'), note, 'and is said once');
  assert.ok(stderr.includes('Opening the editor in your browser. If it does not open, paste this address into a browser on this machine. Keep it private: it holds this session’s key.'));
  stop();
  assert.equal(await running, 0);
  assert.equal(stderr.at(-1), 'Stopped. The preview files were removed.');
});
