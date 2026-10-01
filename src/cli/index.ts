#!/usr/bin/env node
/**
 * Papeleria command line entry point (M1.8).
 *
 * `new` copies a template's sample piece into an absent or empty folder
 * (IC09); `build` checks a piece and writes `dist/`; `check` runs the same
 * checks in a disposable generation and never changes `dist/` (IC05). `edit`
 * starts the local editor and `serve` a read-only preview (M2.6, IC06, IC09);
 * both run until Ctrl C, then stop both origins and remove their preview
 * generations.
 *
 * Exit codes (IC05): 0 when the report has no error, warnings and withheld
 * included; 1 when it has an error; 2 for a usage, IO, tool or internal
 * failure, which carries a code and no rule (IC06). With `check --json`,
 * stdout holds exactly one JSON value — the report, or `{errorCode, message}`
 * on exit 2 — and everything meant for a person goes to stderr, where every
 * author-controlled string is escaped so a piece cannot drive the terminal.
 */
import {spawn} from 'node:child_process';
import {constants, realpathSync} from 'node:fs';
import {copyFile, lstat, mkdir, readdir, rm, rmdir, stat} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {escapeControls, locateToolRoot, TEMPLATE_NAMES, type TemplateName} from '../core/index.js';
import {PipelineError, runPipeline, type PipelineResult} from '../build/pipeline.js';
import {formatReport} from '../build/report.js';
import {readToolVersion} from '../build/version.js';
import {leftoverNote} from '../build/write.js';
import {ServerStartError, startEditor, startServe} from '../server/index.js';

export {readToolVersion} from '../build/version.js';

/** Hands a launch address to a browser; calls `failed` when it knows none opened. */
export type Opener = (url: string, failed: () => void) => void;

export type CliIo = {
  out: (text: string) => void;
  err: (text: string) => void;
};

/** What the CLI needs from its surroundings; tests pass their own. */
export type CliOptions = {
  /** The tool root the samples, templates and theme are read from. */
  readonly toolRoot?: string;
  /** Resolves relative folders; the process's working folder by default. */
  readonly cwd?: string;
  /** `edit` and `serve` stop when this settles; by default at Ctrl C, SIGTERM or the terminal closing. */
  readonly until?: Promise<unknown>;
  /** Opens `edit`'s launch address, or null for none; by default `platformOpener()`. */
  readonly openBrowser?: Opener | null;
};

const defaultIo: CliIo = {
  out: (text) => process.stdout.write(`${text}\n`),
  err: (text) => process.stderr.write(`${text}\n`),
};

const USAGE = [
  'Usage: papeleria <command> [options]',
  '',
  'Commands:',
  '  new <deck|comic|document> <folder>   Create a piece from a template’s sample',
  '  build <folder>                       Check the piece and write <folder>/dist',
  '  check <folder> [--json]              Check the piece without writing dist; --json prints the report',
  '  edit <folder> [--port N]             Open the piece in the local editor; Ctrl C stops it',
  '  serve <folder> [--port N]            Serve a read-only preview that reloads when a file changes',
  '',
  'Options:',
  '  --port N                             The port edit or serve listens on at 127.0.0.1; a free one if left out',
  '  -v, --version                        Print the tool version',
  '  -h, --help                           Print this usage',
  '',
  'Exit codes: 0 no errors (warnings allowed), 1 the piece has errors, 2 usage, IO or tool failure.',
].join('\n');

/** A failure that is not the piece's content: exit 2, with a code and no rule (IC06). */
class CliFailure extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

type Parsed = {
  readonly positional: readonly string[];
  readonly flags: ReadonlySet<string>;
  /** The value of each option that takes one, or null when none followed it. */
  readonly values: ReadonlyMap<string, string | null>;
};

/** Options that take a value, as `--port 4400` or `--port=4400`. */
const VALUED: ReadonlySet<string> = new Set(['--port']);

/** Positional arguments, flags and option values; `--` ends the flags, so a folder may start with a dash. */
function parse(argv: readonly string[]): Parsed {
  const positional: string[] = [];
  const flags = new Set<string>();
  const values = new Map<string, string | null>();
  let flagsEnded = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (!flagsEnded && argument === '--') {
      flagsEnded = true;
    } else if (!flagsEnded && argument.startsWith('-') && argument !== '-') {
      const equals = argument.indexOf('=');
      const name = equals === -1 ? argument : argument.slice(0, equals);
      if (!VALUED.has(name)) {
        flags.add(argument);
      } else if (equals !== -1) {
        flags.add(name);
        values.set(name, argument.slice(equals + 1));
      } else {
        flags.add(name);
        values.set(name, argv[index + 1] ?? null);
        index += 1;
      }
    } else {
      positional.push(argument);
    }
  }
  return {positional, flags, values};
}

function quote(value: string): string {
  return JSON.stringify(escapeControls(value));
}

function expect(parsed: Parsed, command: string, count: number, allowed: readonly string[] = []): void {
  for (const flag of parsed.flags) {
    if (!allowed.includes(flag)) {
      throw new CliFailure('E_USAGE', `${command} does not take the option ${quote(flag)}.`);
    }
  }
  if (parsed.positional.length !== count) {
    const what = count === 1 ? 'a piece folder' : 'a template and a folder';
    throw new CliFailure('E_USAGE', `${command} takes ${what}; it was given ${parsed.positional.length} argument${parsed.positional.length === 1 ? '' : 's'}.`);
  }
}

// ---------------------------------------------------------------------------
// new

/** Paths `new` made, so a failure removes exactly those and nothing else (IC09). */
type Created = {readonly files: string[]; readonly folders: string[]};

async function undo(created: Created): Promise<void> {
  for (const file of created.files.reverse()) {
    await rm(file, {force: true});
  }
  for (const folder of created.folders.reverse()) {
    await rmdir(folder).catch(() => undefined);
  }
}

/** One entry of a sample, as a path relative to the sample. */
type SampleEntry = {readonly segments: readonly string[]; readonly kind: 'folder' | 'file'};

/**
 * Reads a sample's tree before anything is created: folders and regular files
 * only, in name order. A sample that is missing, unreadable or holds anything
 * else (a link) is the installation's failure, E_TOOL_RESOURCE.
 */
async function listSample(root: string, segments: readonly string[] = []): Promise<SampleEntry[]> {
  const folder = join(root, ...segments);
  let items;
  try {
    items = (await readdir(folder, {withFileTypes: true})).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  } catch (error) {
    throw new CliFailure('E_TOOL_RESOURCE', `The sample folder ${folder} could not be read: ${(error as Error).message}. Reinstall Papeleria.`);
  }
  const entries: SampleEntry[] = [];
  for (const item of items) {
    const path = [...segments, item.name];
    if (item.isDirectory()) {
      entries.push({segments: path, kind: 'folder'}, ...(await listSample(root, path)));
    } else if (item.isFile()) {
      entries.push({segments: path, kind: 'file'});
    } else {
      throw new CliFailure('E_TOOL_RESOURCE', `The sample file ${join(folder, item.name)} is not a regular file or folder, so it was not copied. Reinstall Papeleria.`);
    }
  }
  return entries;
}

/** Copies a listed sample, never over an existing file, recording what it makes. */
async function copySample(sample: string, destination: string, entries: readonly SampleEntry[], created: Created): Promise<void> {
  for (const entry of entries) {
    const to = join(destination, ...entry.segments);
    if (entry.kind === 'folder') {
      await mkdir(to);
      created.folders.push(to);
    } else {
      // A file that appeared meanwhile is never overwritten.
      await copyFile(join(sample, ...entry.segments), to, constants.COPYFILE_EXCL);
      created.files.push(to);
    }
  }
}

/** What is at the destination, or null when nothing is; a path that cannot be looked at is the author's to fix. */
async function destinationState(destination: string, folder: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(destination);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return null;
    }
    if (code === 'ENOTDIR') {
      throw new CliFailure('E_DESTINATION', `Part of the path ${quote(folder)} is a file, not a folder. Choose another place.`);
    }
    throw new CliFailure('E_DESTINATION', `${quote(folder)} could not be looked at: ${(error as Error).message}`);
  }
}

async function runNew(parsed: Parsed, io: CliIo, options: CliOptions): Promise<number> {
  expect(parsed, 'new', 2);
  const [template, folder] = parsed.positional as [string, string];
  if (!(TEMPLATE_NAMES as readonly string[]).includes(template)) {
    throw new CliFailure('E_USAGE', `There is no template named ${quote(template)}. Choose deck, comic or document.`);
  }
  // Every template has its sample from M4.8 (W4): new deck, new comic and new document all copy one (D119).
  const name = template as TemplateName;
  const toolRoot = options.toolRoot ?? locateToolRoot();
  const sample = join(toolRoot, 'templates', name, 'sample');
  const destination = resolve(options.cwd ?? process.cwd(), folder);

  const entries = await listSample(sample);
  const created: Created = {files: [], folders: []};
  const existing = await destinationState(destination, folder);
  if (existing !== null) {
    if (existing.isSymbolicLink()) {
      throw new CliFailure('E_DESTINATION', `${quote(folder)} is a symbolic link; new never writes through a link. Choose another folder.`);
    }
    if (!existing.isDirectory()) {
      throw new CliFailure('E_DESTINATION', `${quote(folder)} exists and is not a folder. Choose a new folder name.`);
    }
    const inside = await readdir(destination).catch((error: unknown) => {
      throw new CliFailure('E_DESTINATION', `${quote(folder)} could not be read: ${(error as Error).message}`);
    });
    if (inside.length > 0) {
      throw new CliFailure('E_DESTINATION', `${quote(folder)} is not empty, and new never writes into a folder that holds anything. Choose a new or empty folder.`);
    }
  } else {
    // The folder above may be reached through a link of the author's own, such as a symlinked home.
    const parent = await stat(dirname(destination)).catch(() => null);
    if (parent === null || !parent.isDirectory()) {
      throw new CliFailure('E_DESTINATION', `The folder that would hold ${quote(folder)} does not exist. Create it first, or choose another place.`);
    }
    try {
      await mkdir(destination);
    } catch (error) {
      throw new CliFailure('E_OUTPUT_IO', `${quote(folder)} could not be created: ${(error as Error).message}`);
    }
    created.folders.push(destination);
  }
  try {
    await copySample(sample, destination, entries, created);
  } catch (error) {
    await undo(created);
    throw new CliFailure('E_OUTPUT_IO', `The ${name} sample could not be copied into ${quote(folder)}, and what was copied was removed: ${(error as Error).message}`);
  }
  const copied = entries.filter((entry) => entry.kind === 'file').length;
  const shown = escapeControls(folder);
  io.err(`Created ${shown} from the ${name} sample (${copied} files).`);
  io.err(`Next: papeleria build ${shown}, then open ${escapeControls(join(folder, 'dist', 'index.html'))}.`);
  return 0;
}

// ---------------------------------------------------------------------------
// build and check

const RECOVERY_NOTES = {
  restored: 'An interrupted build was found; the previous dist/ was put back before this build.',
  completed: 'An interrupted build had finished writing dist/; its cleanup was completed.',
  discarded: 'An unfinished build’s files were removed; dist/ was as it was.',
  cleaned: 'Files left by old, unfinished builds were removed.',
} as const;

function olderDistWarning(result: PipelineResult, folder: string): string | null {
  if (!result.olderDist) {
    return null;
  }
  const dist = escapeControls(join(folder, 'dist'));
  return result.report.outputReason === 'withheld'
    ? `warning: ${dist} holds an older build, which was left as it was. It is not this withheld preview; remove it if it must no longer be shared.`
    : `note: ${dist} still holds the last complete build, unchanged.`;
}

async function runBuild(parsed: Parsed, io: CliIo, options: CliOptions): Promise<number> {
  expect(parsed, 'build', 1);
  const folder = parsed.positional[0]!;
  const result = await runPipeline(
    {root: resolve(options.cwd ?? process.cwd(), folder), label: folder},
    {kind: 'dist'},
    options.toolRoot === undefined ? {} : {toolRoot: options.toolRoot},
  );
  if (result.recovery !== null && result.recovery !== 'nothing') {
    io.err(`note: ${RECOVERY_NOTES[result.recovery]}`);
  }
  for (const leftover of result.leftovers) {
    // The reason is the system's message, which can quote the piece's path.
    io.err(`note: ${escapeControls(leftoverNote(leftover))}`);
  }
  io.err(formatReport(result.report));
  const warning = olderDistWarning(result, folder);
  if (warning !== null) {
    io.err(warning);
  }
  return result.report.errors > 0 ? 1 : 0;
}

async function runCheck(parsed: Parsed, io: CliIo, options: CliOptions): Promise<number> {
  expect(parsed, 'check', 1, ['--json']);
  const folder = parsed.positional[0]!;
  const result = await runPipeline(
    {root: resolve(options.cwd ?? process.cwd(), folder), label: folder},
    {kind: 'check'},
    options.toolRoot === undefined ? {} : {toolRoot: options.toolRoot},
  );
  if (parsed.flags.has('--json')) {
    io.out(JSON.stringify(result.report));
  }
  io.err(formatReport(result.report));
  return result.report.errors > 0 ? 1 : 0;
}

// ---------------------------------------------------------------------------
// edit and serve

/** The folder `edit` or `serve` was given; none at all gets the UX's first-run line. */
function expectPiece(parsed: Parsed, command: 'edit' | 'serve'): string {
  if (parsed.positional.length === 0 && [...parsed.flags].every((flag) => flag === '--port')) {
    throw new CliFailure('E_USAGE', `Give ${command} a piece folder: papeleria ${command} my-deck. Make one with papeleria new deck my-deck.`);
  }
  expect(parsed, command, 1, ['--port']);
  return parsed.positional[0]!;
}

/** `--port N`: a whole number from 1 to 65535, or undefined for a free port. */
function portOf(parsed: Parsed, command: 'edit' | 'serve'): number | undefined {
  if (!parsed.values.has('--port')) {
    return undefined;
  }
  const value = parsed.values.get('--port') ?? null;
  if (value === null) {
    throw new CliFailure('E_USAGE', `--port needs a port number, such as papeleria ${command} my-deck --port 4400.`);
  }
  if (!/^[0-9]{1,5}$/.test(value) || Number(value) < 1 || Number(value) > 65_535) {
    throw new CliFailure('E_USAGE', `--port takes a whole number from 1 to 65535; it was given ${quote(value)}. Leave --port out to use a free port.`);
  }
  return Number(value);
}

/** A server's line for the terminal, one escaped line at a time: a report or an error can quote the author's text. */
function logTo(io: CliIo): (text: string) => void {
  return (text) => io.err(text.split('\n').map(escapeControls).join('\n'));
}

/**
 * Resolves at the first Ctrl C (SIGINT), SIGTERM or SIGHUP (the terminal
 * closing). The handlers are removed then, so a second Ctrl C during the
 * clean-up ends the process at once, as Node does by default.
 */
function untilStopped(): Promise<void> {
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
  return new Promise((resolvePromise) => {
    const stop = (): void => {
      for (const signal of signals) {
        process.off(signal, stop);
      }
      resolvePromise();
    };
    for (const signal of signals) {
      process.on(signal, stop);
    }
  });
}

/**
 * The platform's opener, or null when the environment sets
 * PAPELERIA_NO_BROWSER (tests, CI, a machine without a desktop), when the
 * printed address is the way in.
 *
 * The launch address goes to the opener as one argument, with no shell
 * (IC06: "supply the full launch URL to the browser opener"): `open` on
 * macOS, `url.dll`'s handler on Windows, `xdg-open` elsewhere. The opener runs
 * in its own process group, so the Ctrl C that stops Papeleria does not reach
 * a browser it started. Other users of the machine can read its command line,
 * and a browser it starts may keep the address in its own, so the address
 * holds a launch token the page spends at once, never the session token
 * (security audit F10, D192).
 */
function platformOpener(): Opener | null {
  if ((process.env['PAPELERIA_NO_BROWSER'] ?? '') !== '') {
    return null;
  }
  return (url, failed) => {
    const [command, args]: [string, string[]] =
      process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]] : ['xdg-open', [url]];
    try {
      const child = spawn(command, args, {stdio: 'ignore', detached: process.platform !== 'win32', windowsHide: true});
      child.once('error', failed);
      child.once('exit', (code) => {
        if (code !== 0 && code !== null) {
          failed();
        }
      });
      child.unref();
    } catch {
      failed();
    }
  };
}

async function runEdit(parsed: Parsed, io: CliIo, options: CliOptions): Promise<number> {
  const folder = expectPiece(parsed, 'edit');
  const port = portOf(parsed, 'edit');
  const session = await startEditor({
    root: resolve(options.cwd ?? process.cwd(), folder),
    label: folder,
    ...(port === undefined ? {} : {port}),
    ...(options.toolRoot === undefined ? {} : {toolRoot: options.toolRoot}),
    log: logTo(io),
    // Each launch address opens the editor once (D192); the next one is shown here, never to an opener. A reload needs none (D195).
    announce: (address, reason) => {
      io.err(
        reason === 'expired'
          ? 'The address above was not opened within two minutes, so it no longer works. To open the editor, use this one; it works once:'
          : 'The editor opened. To open it in another tab, use this address; it works once:',
      );
      io.err(address);
    },
  });
  const until = options.until ?? untilStopped();
  const opener = options.openBrowser === undefined ? platformOpener() : options.openBrowser;
  io.err(`Papeleria is editing ${escapeControls(folder)} at ${session.editorOrigin}; its preview is served from ${session.previewOrigin}.`);
  io.err(
    opener === null
      ? 'Open this address in a browser on this machine. Keep it private: it holds this session’s key.'
      : 'Opening the editor in your browser. If it does not open, paste this address into a browser on this machine. Keep it private: it holds this session’s key.',
  );
  // The first launch token's only appearances (IC06, D192): this line, once, and the opener. The session token has none.
  io.err(session.launchUrl);
  io.err('Ctrl C stops the editor.');
  let noted = false;
  opener?.(session.launchUrl, () => {
    if (!noted) {
      noted = true;
      io.err('No browser opened. Paste the address above into a browser on this machine.');
    }
  });
  await until;
  io.err('Stopping the editor…');
  await session.close();
  io.err('Stopped. The preview files were removed.');
  return 0;
}

async function runServe(parsed: Parsed, io: CliIo, options: CliOptions): Promise<number> {
  const folder = expectPiece(parsed, 'serve');
  const port = portOf(parsed, 'serve');
  const session = await startServe({
    root: resolve(options.cwd ?? process.cwd(), folder),
    label: folder,
    ...(port === undefined ? {} : {port}),
    ...(options.toolRoot === undefined ? {} : {toolRoot: options.toolRoot}),
    log: logTo(io),
  });
  const until = options.until ?? untilStopped();
  io.err(`Papeleria is serving a read-only preview of ${escapeControls(folder)}; it reloads when a file changes and never writes dist/.`);
  io.err(`Open ${session.origin} in a browser on this machine. Ctrl C stops it.`);
  await until;
  io.err('Stopping the preview…');
  await session.close();
  io.err('Stopped. The preview files were removed.');
  return 0;
}

// ---------------------------------------------------------------------------

const COMMANDS: Readonly<Record<string, (parsed: Parsed, io: CliIo, options: CliOptions) => Promise<number>>> = {
  new: runNew,
  build: runBuild,
  check: runCheck,
  edit: runEdit,
  serve: runServe,
};

/** Whether a command line asks for the report as JSON on stdout: `check … --json`. */
function wantsJson(argv: readonly string[]): boolean {
  const [first, ...rest] = argv;
  return first === 'check' && parse(rest).flags.has('--json');
}

/** A failure as the CLI reports one: a code and one line on stderr, and under `--json` one object on stdout (IC05). */
function failure(io: CliIo, json: boolean, code: string, message: string): number {
  if (json) {
    io.out(JSON.stringify({errorCode: code, message}));
  }
  io.err(`papeleria: ${code}: ${message}`);
  return 2;
}

/** Runs the CLI and returns the process exit code. Every failure resolves to exit 2 with a code; it never rejects (W5R-12). */
export async function runCli(argv: readonly string[], io: CliIo = defaultIo, options: CliOptions = {}): Promise<number> {
  const [first, ...rest] = argv;
  const parsed = parse(rest);
  const json = wantsJson(argv);
  const fail = (code: string, message: string, usage = false): number => {
    const status = failure(io, json, code, message);
    if (usage) {
      io.err(USAGE);
    }
    return status;
  };

  try {
    if (first === '--version' || first === '-v') {
      io.out(readToolVersion());
      return 0;
    }
    if (first === undefined || first === '--help' || first === '-h') {
      io.out(USAGE);
      return 0;
    }
    const command = Object.hasOwn(COMMANDS, first) ? COMMANDS[first] : undefined;
    if (command === undefined) {
      return fail('E_USAGE', `unknown command ${quote(first)}`, true);
    }
    return await command(parsed, io, options);
  } catch (error) {
    if (error instanceof CliFailure) {
      // A system error's message can quote the author's path, controls and all.
      return fail(error.code, escapeControls(error.message), error.code === 'E_USAGE');
    }
    if (error instanceof PipelineError) {
      return fail(error.code, escapeControls(error.message));
    }
    if (error instanceof ServerStartError) {
      return fail(error.code, escapeControls(error.message), error.code === 'E_USAGE');
    }
    // Anything else, a tool that cannot read its own package.json included, is the tool's: one line, never a stack.
    const message = error instanceof Error ? error.message : String(error);
    return fail('E_INTERNAL', escapeControls(message.replace(/^E_INTERNAL: /, '')));
  }
}

/**
 * True when Node was started on this file. Real paths are compared, because
 * an installed `papeleria` is reached through npm's link in `node_modules/.bin`
 * while Node resolves the module itself to its real path.
 */
function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  const argv = process.argv.slice(2);
  // runCli resolves every failure it meets; this guard is for a defect in that promise, still reported as exit 2 with a code (W5R-12).
  process.exitCode = await runCli(argv).catch((error: unknown) => failure(defaultIo, wantsJson(argv), 'E_INTERNAL', escapeControls(error instanceof Error ? error.message : String(error))));
}
