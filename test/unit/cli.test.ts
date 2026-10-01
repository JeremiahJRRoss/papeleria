/** M0.1: the compiled CLI reports its version and a usage line; M1.8's commands are in test/integration/cli.test.ts. */
import assert from 'node:assert/strict';
import {cpSync, symlinkSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {after, test} from 'node:test';

import {applicationRoot, runNode} from '../helpers/paths.js';
import {copyPiece, removeTemporaryFolders, temporaryFolder} from '../helpers/pieces.js';
import {runCli, readToolVersion} from '../../src/cli/index.js';

after(removeTemporaryFolders);

const compiledCli = join(applicationRoot, 'lib', 'src', 'cli', 'index.js');

test('--version prints 0.1.0 on stdout and exits 0', async () => {
  const result = await runNode(compiledCli, ['--version']);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, '0.1.0\n');
  assert.equal(result.stderr, '');
});

test('-v is the short form of --version', async () => {
  const result = await runNode(compiledCli, ['-v']);
  assert.equal(result.code, 0);
  assert.equal(result.stdout.trim(), '0.1.0');
});

test('no arguments prints usage on stdout and exits 0', async () => {
  const result = await runNode(compiledCli, []);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /^Usage: papeleria <command> \[options\]/);
});

test('an unknown command prints usage on stderr and exits 2', async () => {
  const result = await runNode(compiledCli, ['publish']);
  assert.equal(result.code, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /unknown command "publish"/);
  assert.match(result.stderr, /Usage: papeleria/);
});

test('runCli writes through the injected io and resolves to the exit code', async () => {
  const out: string[] = [];
  const err: string[] = [];
  const io = {out: (t: string) => out.push(t), err: (t: string) => err.push(t)};

  assert.equal(await runCli(['--version'], io), 0);
  assert.deepEqual(out, ['0.1.0']);
  assert.deepEqual(err, []);

  assert.equal(await runCli(['--help'], io), 0);
  assert.equal(await runCli(['nope'], io), 2);
  assert.equal(err.length, 2);
});

test('the version comes from the packaged manifest, not a literal', () => {
  assert.equal(readToolVersion(), '0.1.0');
});

test('W5R-12: a tool whose package.json gives no version fails with exit 2 and a code, never an unhandled rejection', async () => {
  // The compiled tool under a package.json Node can load but that names no version, its dependencies reached
  // through a link. (One that is not JSON at all stops Node itself before any of Papeleria's code runs.)
  const tool = temporaryFolder('broken-manifest');
  cpSync(join(applicationRoot, 'lib', 'src'), join(tool, 'lib', 'src'), {recursive: true});
  cpSync(join(applicationRoot, 'lib', 'templates'), join(tool, 'lib', 'templates'), {recursive: true});
  symlinkSync(join(applicationRoot, 'node_modules'), join(tool, 'node_modules'), 'junction');
  writeFileSync(join(tool, 'package.json'), '{"name": "papeleria", "type": "module"}\n');
  const cli = join(tool, 'lib', 'src', 'cli', 'index.js');

  const version = await runNode(cli, ['--version']);
  assert.equal(version.code, 2, version.stderr);
  assert.equal(version.stdout, '');
  assert.equal(version.stderr, 'papeleria: E_INTERNAL: papeleria package.json was not found above the tool files\n', 'one line, no stack');

  const checked = await runNode(cli, ['check', copyPiece(join(applicationRoot, 'examples', 'starter-deck'), 'broken-manifest-piece'), '--json']);
  assert.equal(checked.code, 2, checked.stderr);
  const lines = checked.stdout.split('\n').filter((line) => line !== '');
  assert.equal(lines.length, 1, 'one JSON value on stdout');
  assert.equal((JSON.parse(lines[0]!) as {errorCode: string}).errorCode, 'E_INTERNAL');
  assert.match(checked.stderr, /^papeleria: E_INTERNAL: [^\n]+\n$/);
});
