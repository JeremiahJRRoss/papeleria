/**
 * M5.5 (D141): `scripts/gen-manifest.mjs` writes `MANIFEST.sha256` in the
 * scope README.md states, in the form `sha256sum -c` reads, and `--check`
 * finds every difference.
 *
 * Each case is a tree planted in a temporary folder: a file of every kind the
 * scope leaves out beside one it keeps, so a rule that drops too much fails
 * as surely as one that keeps too much. Only the git case runs git, in a
 * repository of its own.
 */
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {after, test} from 'node:test';
import {pathToFileURL} from 'node:url';

import {runCheckScript, scriptPath} from '../helpers/paths.js';

const temporaryRoots: string[] = [];

after(() => {
  for (const directory of temporaryRoots) {
    rmSync(directory, {recursive: true, force: true});
  }
});

/** Runs git in a planted repository, as a person who has set nothing up. */
function git(root: string, ...args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.org', ...args], {encoding: 'utf8'});
}

function plant(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'papeleria-manifest-'));
  temporaryRoots.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), {recursive: true});
    writeFileSync(join(root, path), text);
  }
  return root;
}

/** Every kind of file the scope leaves out, each beside one it keeps. */
const TREE: Record<string, string> = {
  'README.md': 'readme\n',
  'MANIFEST.sha256': 'stale\n',
  '.DS_Store': 'finder\n',
  'docs/.DS_Store': 'finder\n',
  'docs/guide.md': 'guide\n',
  '.git/config': 'git\n',
  'node_modules/dependency/index.js': 'installed\n',
  'lib/src/cli/index.js': 'compiled\n',
  'test/fixtures/license/tree/node_modules/alpha/package.json': '{"name":"alpha"}\n',
  'test/fixtures/license/tree/node_modules/alpha/lib/index.js': 'fixture\n',
  'examples/deck/papeleria.yaml': 'template: deck\n',
  'examples/deck/assets/text/notes.md': 'notes\n',
  'examples/deck/dist/index.html': 'built\n',
  'examples/deck/.papeleria/cache/entry': 'cache\n',
  'examples/json-piece/papeleria.json': '{}\n',
  'examples/json-piece/dist/index.html': 'built\n',
  'vendor/tool/dist/tool.js': 'not a piece, so its dist/ is source\n',
  'templates/deck/lib/helper.js': 'a lib/ below the root is source\n',
  'Zeta.md': 'upper case sorts before lower case\n',
  'alpha.md': 'alpha\n',
  'año.md': 'a multibyte name sorts by its bytes\n',
};

const KEPT = [
  'README.md',
  'Zeta.md',
  'alpha.md',
  'año.md',
  'docs/guide.md',
  'examples/deck/assets/text/notes.md',
  'examples/deck/papeleria.yaml',
  'examples/json-piece/papeleria.json',
  'templates/deck/lib/helper.js',
  'test/fixtures/license/tree/node_modules/alpha/lib/index.js',
  'test/fixtures/license/tree/node_modules/alpha/package.json',
  'vendor/tool/dist/tool.js',
];

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

test('the manifest lists the scope and nothing else, sorted by bytes, in sha256sum form', async () => {
  const root = plant(TREE);
  const result = await runCheckScript('gen-manifest.mjs', ['--root', root, '--no-git']);
  assert.equal(result.code, 0, result.stderr);
  const text = readFileSync(join(root, 'MANIFEST.sha256'), 'utf8');
  assert.equal(text, KEPT.map((path) => `${sha256(TREE[path]!)}  ${path}\n`).join(''));
  assert.match(result.stdout, new RegExp(`^MANIFEST\\.sha256: ${KEPT.length} files; SHA-256 of the manifest ${sha256(text)}\\n$`));
  // sha256sum itself reads it back, where the tool is installed.
  const verified = spawnSync('sha256sum', ['-c', 'MANIFEST.sha256'], {cwd: root, encoding: 'utf8'});
  if (verified.error === undefined) {
    assert.equal(verified.status, 0, verified.stdout + verified.stderr);
    assert.equal(verified.stdout.split('\n').filter((line) => line.endsWith(': OK')).length, KEPT.length);
  }
});

test('--check passes on a fresh manifest and names each changed, unlisted and vanished file', async () => {
  const root = plant(TREE);
  assert.equal((await runCheckScript('gen-manifest.mjs', ['--root', root, '--no-git'])).code, 0);
  const clean = await runCheckScript('gen-manifest.mjs', ['--root', root, '--no-git', '--check']);
  assert.equal(clean.code, 0, clean.stderr);
  assert.equal(clean.stdout, `MANIFEST.sha256: ${KEPT.length} entries, ${KEPT.length} files in scope, 0 differences\n`);

  writeFileSync(join(root, 'docs', 'guide.md'), 'changed\n');
  writeFileSync(join(root, 'docs', 'added.md'), 'new\n');
  unlinkSync(join(root, 'alpha.md'));
  writeFileSync(join(root, 'examples', 'deck', 'dist', 'more.html'), 'built output never counts\n');
  const changed = await runCheckScript('gen-manifest.mjs', ['--root', root, '--no-git', '--check']);
  assert.equal(changed.code, 1);
  assert.deepEqual(changed.stderr.trim().split('\n').sort(), [
    'gen-manifest: alpha.md: listed, but not in the tree',
    'gen-manifest: docs/added.md: not listed',
    'gen-manifest: docs/guide.md: differs',
  ]);
  assert.equal(readFileSync(join(root, 'MANIFEST.sha256'), 'utf8').split('\n').length, KEPT.length + 1, '--check writes nothing');
});

test('a symbolic link is named and not listed; a path sha256sum would escape stops the run', {skip: process.platform === 'win32' ? 'links and backslashes in names need a POSIX file system' : false}, async () => {
  const root = plant({'README.md': 'readme\n', 'docs/guide.md': 'guide\n'});
  symlinkSync('guide.md', join(root, 'docs', 'link.md'));
  const linked = await runCheckScript('gen-manifest.mjs', ['--root', root, '--no-git']);
  assert.equal(linked.code, 0, linked.stderr);
  assert.match(linked.stderr, /note: docs\/link\.md \(a symbolic link\) is not listed/);
  assert.doesNotMatch(readFileSync(join(root, 'MANIFEST.sha256'), 'utf8'), /link\.md/);

  writeFileSync(join(root, 'back\\slash.md'), 'escaped\n');
  const escaped = await runCheckScript('gen-manifest.mjs', ['--root', root, '--no-git']);
  assert.equal(escaped.code, 2);
  assert.match(escaped.stderr, /"back\\\\slash\.md" holds a backslash or a line break/);
});

test('a file git ignores inside the scope stops the run, so a clone can always verify the manifest', async () => {
  const root = plant({'README.md': 'readme\n', '.gitignore': 'test-results/\n*.tgz\n', 'test-results/run.json': '{}\n', 'papeleria-0.1.0.tgz': 'packed\n'});
  const init = spawnSync('git', ['init', '--quiet', root], {encoding: 'utf8'});
  assert.equal(init.status, 0, init.stderr);
  const refused = await runCheckScript('gen-manifest.mjs', ['--root', root]);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /papeleria-0\.1\.0\.tgz is ignored by git but inside the manifest's scope/);
  assert.match(refused.stderr, /test-results\/run\.json is ignored by git but inside the manifest's scope/);

  rmSync(join(root, 'test-results'), {recursive: true});
  unlinkSync(join(root, 'papeleria-0.1.0.tgz'));
  assert.equal(git(root, 'add', '-A').status, 0);
  const written = await runCheckScript('gen-manifest.mjs', ['--root', root]);
  assert.equal(written.code, 0, written.stderr);
  assert.equal(readFileSync(join(root, 'MANIFEST.sha256'), 'utf8'), `${sha256('test-results/\n*.tgz\n')}  .gitignore\n${sha256('readme\n')}  README.md\n`);
});

test('writing stops on a file in scope git would not commit as it is: untracked, changed or deleted without staging', async () => {
  const root = plant({'README.md': 'readme\n', 'docs/guide.md': 'guide\n', 'docs/old.md': 'old\n', 'lib/built.js': 'generated\n'});
  assert.equal(git(root, 'init', '--quiet').status, 0);
  assert.equal(git(root, 'add', 'README.md', 'docs').status, 0);
  // lib/ is outside the scope, so its untracked file is not the manifest's business.
  assert.equal((await runCheckScript('gen-manifest.mjs', ['--root', root])).code, 0);

  writeFileSync(join(root, 'docs', 'new.md'), 'new\n');
  writeFileSync(join(root, 'docs', 'guide.md'), 'guide, edited\n');
  unlinkSync(join(root, 'docs', 'old.md'));
  const refused = await runCheckScript('gen-manifest.mjs', ['--root', root]);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /^gen-manifest: docs\/guide\.md has changes that are not staged, so a clone could not verify the manifest; stage or commit it, and run again$/m);
  assert.match(refused.stderr, /^gen-manifest: docs\/new\.md is not tracked by git, /m);
  assert.match(refused.stderr, /^gen-manifest: docs\/old\.md is deleted, and the deletion is not staged, /m);
  const before = readFileSync(join(root, 'MANIFEST.sha256'), 'utf8');
  assert.match(before, /  docs\/old\.md\n/, 'a refused write leaves the manifest as it was');

  // --check writes nothing, so it reports the differences instead of refusing.
  const checked = await runCheckScript('gen-manifest.mjs', ['--root', root, '--check']);
  assert.equal(checked.code, 1);
  assert.match(checked.stderr, /docs\/guide\.md: differs/);

  assert.equal(git(root, 'add', '-A').status, 0);
  const staged = await runCheckScript('gen-manifest.mjs', ['--root', root]);
  assert.equal(staged.code, 0, staged.stderr);
  assert.equal(readFileSync(join(root, 'MANIFEST.sha256'), 'utf8'), `${sha256('readme\n')}  README.md\n${sha256('guide, edited\n')}  docs/guide.md\n${sha256('new\n')}  docs/new.md\n`);
});

test('outside a repository the run stops unless --no-git says so; a bad argument is exit 2', async () => {
  const root = plant({'README.md': 'readme\n'});
  const outside = await runCheckScript('gen-manifest.mjs', ['--root', root]);
  assert.equal(outside.code, 2);
  assert.match(outside.stderr, /git could not tell which files it ignores: .*pass --no-git/);
  assert.equal((await runCheckScript('gen-manifest.mjs', ['--root'])).code, 2);
  assert.equal((await runCheckScript('gen-manifest.mjs', ['--write'])).code, 2);
  const missing = await runCheckScript('gen-manifest.mjs', ['--root', root, '--no-git', '--check']);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /MANIFEST\.sha256 is missing/);
});

test('git leaving before it has read every path is still git refusing, not git missing', async () => {
  // Outside a repository git exits at once; a long list then meets a closed
  // pipe (EPIPE), which a short list meets only sometimes.
  const {ignoredByGit} = (await import(pathToFileURL(scriptPath('gen-manifest.mjs')).href)) as {ignoredByGit(root: string, files: string[]): string[]};
  const root = plant({'README.md': 'readme\n'});
  const many = Array.from({length: 200_000}, (_, index) => `notes/${index}.md`);
  assert.throws(() => ignoredByGit(root, many), /^Error: git could not tell which files it ignores: fatal: not a git repository.*pass --no-git$/s);
});
