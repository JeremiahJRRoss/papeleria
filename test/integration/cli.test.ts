/**
 * M1.8: the commands. The compiled CLI runs as a child process where streams
 * and exit codes are the point; `runCli` runs in process where a test needs a
 * tool root of its own. Every folder is a temporary one.
 */
import assert from 'node:assert/strict';
import {existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {after, test} from 'node:test';

import {runCli, type CliIo} from '../../src/cli/index.js';
import {applicationRoot, runNode} from '../helpers/paths.js';
import {readTree, removeTemporaryFolders, temporaryFolder} from '../helpers/pieces.js';

after(removeTemporaryFolders);

const CLI = join(applicationRoot, 'lib', 'src', 'cli', 'index.js');
const SAMPLE = join(applicationRoot, 'templates', 'deck', 'sample');
const ESC = String.fromCharCode(0x1b);

function memoryIo(): CliIo & {stdout: string[]; stderr: string[]} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {stdout, stderr, out: (text) => stdout.push(text), err: (text) => stderr.push(text)};
}

function sameTree(a: string, b: string): void {
  const left = readTree(a);
  const right = readTree(b);
  assert.deepEqual(Object.keys(left).sort(), Object.keys(right).sort());
  for (const [path, bytes] of Object.entries(left)) {
    assert.ok(Buffer.from(bytes).equals(Buffer.from(right[path]!)), path);
  }
}

test('new deck copies the sample into an absent folder, and into an empty one', async () => {
  const parent = temporaryFolder('new');
  const absent = join(parent, 'my-deck');
  const made = await runNode(CLI, ['new', 'deck', absent]);
  assert.equal(made.code, 0, made.stderr);
  assert.equal(made.stdout, '');
  assert.match(made.stderr, /^Created .*my-deck from the deck sample \(3 files\)\.\nNext: papeleria build /);
  sameTree(absent, SAMPLE);

  const empty = join(parent, 'empty');
  mkdirSync(empty);
  assert.equal((await runNode(CLI, ['new', 'deck', empty])).code, 0);
  sameTree(empty, SAMPLE);
});

test('new never writes into a folder that holds anything, onto a file, through a link or into a missing parent', async () => {
  const parent = temporaryFolder('new-refused');
  const full = join(parent, 'full');
  mkdirSync(full);
  writeFileSync(join(full, 'keep.txt'), 'mine');
  const file = join(parent, 'file');
  writeFileSync(file, 'a file');
  const target = join(parent, 'link-target');
  mkdirSync(target);
  const link = join(parent, 'link');
  symlinkSync(target, link);
  for (const [folder, pattern] of [
    [full, /is not empty/],
    [file, /exists and is not a folder/],
    [link, /is a symbolic link/],
    [join(parent, 'missing', 'deck'), /does not exist/],
  ] as const) {
    const result = await runNode(CLI, ['new', 'deck', folder]);
    assert.equal(result.code, 2, folder);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^papeleria: E_DESTINATION: /);
    assert.match(result.stderr, pattern);
  }
  assert.deepEqual(readdirSync(full), ['keep.txt']);
  assert.equal(readFileSync(file, 'utf8'), 'a file');
  assert.deepEqual(readdirSync(target), []);
  assert.equal(existsSync(join(parent, 'missing')), false);
});

test('an unknown template is a usage error, and nothing is made', async () => {
  const parent = temporaryFolder('new-unknown');
  // Every template has its sample: new document from M3.7 (test/integration/new-document.test.ts), new comic from M4.8 (new-comic.test.ts).
  const unknown = await runNode(CLI, ['new', 'pamphlet', join(parent, 'x')]);
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /E_USAGE: There is no template named "pamphlet"/);
  assert.deepEqual(readdirSync(parent), []);
});

test('IC09: a sample that holds a link, or none at all, is refused before anything is made (E_TOOL_RESOURCE)', async () => {
  const tool = temporaryFolder('broken-sample');
  const sample = join(tool, 'templates', 'deck', 'sample');
  mkdirSync(join(sample, 'assets'), {recursive: true});
  writeFileSync(join(sample, 'a.md'), 'first');
  symlinkSync('a.md', join(sample, 'z-link'));
  const parent = temporaryFolder('new-refused-sample');
  const io = memoryIo();
  assert.equal(await runCli(['new', 'deck', 'fresh'], io, {toolRoot: tool, cwd: parent}), 2);
  assert.match(io.stderr[0] ?? '', /E_TOOL_RESOURCE: The sample file .*z-link is not a regular file or folder/);
  mkdirSync(join(parent, 'given'));
  assert.equal(await runCli(['new', 'deck', 'given'], memoryIo(), {toolRoot: tool, cwd: parent}), 2);
  assert.deepEqual(readdirSync(parent), ['given'], 'nothing was made');
  assert.deepEqual(readdirSync(join(parent, 'given')), []);

  const missing = memoryIo();
  assert.equal(await runCli(['new', 'deck', 'fresh'], missing, {toolRoot: temporaryFolder('no-sample'), cwd: parent}), 2);
  assert.match(missing.stderr[0] ?? '', /^papeleria: E_TOOL_RESOURCE: The sample folder .* could not be read/);
});

test('IC09: a path through a file is E_DESTINATION, not an internal failure', async () => {
  const parent = temporaryFolder('new-enotdir');
  writeFileSync(join(parent, 'afile'), 'x');
  const io = memoryIo();
  assert.equal(await runCli(['new', 'deck', 'afile/sub'], io, {cwd: parent}), 2);
  assert.match(io.stderr[0] ?? '', /^papeleria: E_DESTINATION: Part of the path "afile\/sub" is a file, not a folder/);
});

test('IC09: a copy that fails half way removes exactly what it made, and never a folder it was given', {skip: process.platform === 'linux' ? false : 'relies on Linux\u2019s 4,096-byte path limit'}, async () => {
  // A destination whose path is a few bytes under the limit: the sample's first
  // folders fit, and its first file, assets/data/hours-by-phase.csv, does not.
  let deep = temporaryFolder('new-undo');
  while (deep.length < 4_000) {
    deep = join(deep, 'd'.repeat(Math.min(200, 4_070 - deep.length - 1)));
    mkdirSync(deep);
  }
  const name = 'x'.repeat(4_075 - deep.length - 1);
  const destination = join(deep, name);
  assert.ok(destination.length + '/assets/data'.length <= 4_095 && destination.length + '/assets/data/hours-by-phase.csv'.length > 4_095);

  const io = memoryIo();
  assert.equal(await runCli(['new', 'deck', name], io, {cwd: deep}), 2);
  assert.match(io.stderr[0] ?? '', /E_OUTPUT_IO: The deck sample could not be copied into .*, and what was copied was removed/);
  assert.equal(existsSync(destination), false, 'the folder new made is gone');

  mkdirSync(destination);
  assert.equal(await runCli(['new', 'deck', name], memoryIo(), {cwd: deep}), 2);
  assert.deepEqual(readdirSync(destination), [], 'the empty folder it was given stays, empty');
});

test('build writes dist/ and exits 0; check --json prints one report on stdout and never touches dist/', async () => {
  const parent = temporaryFolder('build');
  const piece = join(parent, 'deck');
  assert.equal((await runNode(CLI, ['new', 'deck', piece])).code, 0);

  const built = await runNode(CLI, ['build', piece]);
  assert.equal(built.code, 0, built.stderr);
  assert.equal(built.stdout, '');
  assert.match(built.stderr, /Built .*deck\/dist · 0 errors · 0 warnings · first view [\d,]+ of 1,048,576 bytes\n$/);
  assert.ok(existsSync(join(piece, 'dist', 'index.html')));
  const before = readTree(join(piece, 'dist'));

  const checked = await runNode(CLI, ['check', piece, '--json']);
  assert.equal(checked.code, 0, checked.stderr);
  assert.equal(checked.stdout.split('\n').length, 2, 'one line of JSON, then the end');
  const report = JSON.parse(checked.stdout) as {status: string; errors: number; outputWritten: boolean; outputReason: string; weight: {withinBudget: boolean}};
  assert.deepEqual([report.status, report.errors, report.outputWritten, report.outputReason, report.weight.withinBudget], ['ok', 0, false, 'check_only', true]);
  assert.match(checked.stderr, /^Checked /m, 'the human report goes to stderr');
  assert.deepEqual(readTree(join(piece, 'dist')), before);

  const plain = await runNode(CLI, ['check', piece]);
  assert.equal(plain.code, 0);
  assert.equal(plain.stdout, '');
});

test('errors exit 1 with the report; withheld exits 0, writes nothing and warns about an older dist/', async () => {
  const parent = temporaryFolder('exit-codes');
  const piece = join(parent, 'deck');
  await runNode(CLI, ['new', 'deck', piece]);
  assert.equal((await runNode(CLI, ['build', piece])).code, 0);
  const before = readTree(join(piece, 'dist'));
  const manifest = join(piece, 'papeleria.yaml');
  const original = readFileSync(manifest, 'utf8');

  writeFileSync(manifest, original.replace('status: draft', 'status: withheld'));
  const withheld = await runNode(CLI, ['build', piece]);
  assert.equal(withheld.code, 0, withheld.stderr);
  assert.match(withheld.stderr, /is withheld: nothing was written to dist\//);
  assert.match(withheld.stderr, /warning: .*dist holds an older build, which was left as it was\. It is not this withheld preview/);
  assert.deepEqual(readTree(join(piece, 'dist')), before);

  writeFileSync(manifest, original.replace('layout: statement', 'layout: poster'));
  const failed = await runNode(CLI, ['build', piece]);
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /papeleria\.yaml:\d+:\d+ error R09: /);
  assert.match(failed.stderr, /was not built: nothing was written to dist\//);
  assert.match(failed.stderr, /note: .*dist still holds the last complete build, unchanged\./);
  const json = await runNode(CLI, ['check', '--json', piece]);
  assert.equal(json.code, 1);
  assert.equal((JSON.parse(json.stdout) as {status: string}).status, 'failed');
  assert.deepEqual(readTree(join(piece, 'dist')), before);
});

test('exit 2 carries a code and no rule; with --json the code and message are the one JSON value on stdout', async () => {
  const parent = temporaryFolder('exit-two');
  const missing = await runNode(CLI, ['check', join(parent, 'nowhere'), '--json']);
  assert.equal(missing.code, 2);
  const failure = JSON.parse(missing.stdout) as Record<string, unknown>;
  assert.deepEqual(Object.keys(failure), ['errorCode', 'message']);
  assert.equal(failure['errorCode'], 'E_PIECE_FOLDER');
  assert.match(missing.stderr, /^papeleria: E_PIECE_FOLDER: The piece folder .* does not exist\./);

  const usage: [string[], RegExp][] = [
    [['build'], /build takes a piece folder; it was given 0 arguments/],
    [['build', 'a', 'b'], /build takes a piece folder; it was given 2 arguments/],
    [['build', '--json', 'a'], /build does not take the option "--json"/],
    [['check', 'a', '--verbose'], /check does not take the option "--verbose"/],
    [['new', 'deck'], /new takes a template and a folder/],
  ];
  for (const [args, pattern] of usage) {
    const result = await runNode(CLI, args);
    assert.equal(result.code, 2, args.join(' '));
    assert.match(result.stderr, pattern);
    assert.match(result.stderr, /Usage: papeleria/);
  }
  // edit and serve arrived with M2.6 (test/integration/server-cli.test.ts); a folder with no manifest stops both.
  for (const command of ['edit', 'serve']) {
    const result = await runNode(CLI, [command, parent]);
    assert.equal(result.code, 2);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^papeleria: E_PIECE_FOLDER: .* needs exactly one manifest, papeleria\.yaml or papeleria\.json\./);
  }
});

test('a folder name cannot drive the terminal: it is escaped in every line a person reads', async () => {
  const parent = temporaryFolder('escape');
  const folder = join(parent, `evil${ESC}[31m`);
  mkdirSync(folder);
  const io = memoryIo();
  assert.equal(await runCli(['check', `evil${ESC}[31m`, '--json'], io, {cwd: parent}), 1);
  assert.ok(!io.stderr.join('\n').includes(ESC), io.stderr.join('\n'));
  assert.match(io.stderr.join('\n'), /evil\\u001b\[31m error R09: The piece has no manifest\./);
  assert.ok(!io.stdout.join('\n').includes(ESC), 'JSON escapes it too');
  assert.equal((JSON.parse(io.stdout[0]!) as {findings: {file: string}[]}).findings[0]?.file, `evil${ESC}[31m`, 'the report keeps the exact name');
});
