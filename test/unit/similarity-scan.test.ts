/**
 * B7, tier 1 (D144): `scripts/similarity-scan.mjs` finds a run of 50 tokens
 * or more that own code shares with an installed package, whatever its
 * whitespace, comments or quotes, and reports nothing shorter.
 *
 * Each case is a repository planted in a temporary folder, since own code is
 * what git tracks or would commit there.
 */
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {after, test} from 'node:test';

import {runCheckScript} from '../helpers/paths.js';

const temporaryRoots: string[] = [];

after(() => {
  for (const directory of temporaryRoots) {
    rmSync(directory, {recursive: true, force: true});
  }
});

function plant(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'papeleria-similarity-'));
  temporaryRoots.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), {recursive: true});
    writeFileSync(join(root, path), text);
  }
  const init = spawnSync('git', ['init', '--quiet', root], {encoding: 'utf8'});
  assert.equal(init.status, 0, init.stderr);
  writeFileSync(join(root, '.gitignore'), 'node_modules/\n');
  return root;
}

/** A function of about 80 tokens, as a package publishes it. */
const PUBLISHED = `function footnoteTail(state) {
  for (let i = 0; i < state.list.length; i++) {
    const token = new state.Token("footnote_open", "", 1);
    token.meta = { id: i, label: state.list[i].label };
    state.tokens.push(token);
    if (state.list[i].tokens) {
      state.tokens.push(new state.Token("paragraph_open", "p", 1));
    }
    state.tokens.push(new state.Token("footnote_close", "", -1));
  }
}
`;

/** A second function of about 90 tokens, unlike the first. */
const PUBLISHED_TWO = `function tallyShelf(shelf) {
  let count = 0;
  for (const box of shelf.boxes) {
    if (box.label && box.items.length > 0) {
      count += box.items.filter((item) => item.kept === true).length;
    }
  }
  shelf.summary = { total: count, boxes: shelf.boxes.length };
  return shelf.summary;
}
`;

/** The same code re-indented, re-quoted and commented: still the same tokens. */
const REFORMATTED = `// A copy, reformatted.
export function footnoteTail(state) {
    for (let i = 0; i < state.list.length; i++) {
        const token = new state.Token('footnote_open', '', 1); /* opening */
        token.meta = {id: i, label: state.list[i].label};
        state.tokens.push(token);
        if (state.list[i].tokens) {
            state.tokens.push(new state.Token('paragraph_open', 'p', 1));
        }
        state.tokens.push(new state.Token('footnote_close', '', -1));
    }
}
`;

test('a reformatted copy of 50 tokens or more is one region, with both places', async () => {
  const root = plant({'node_modules/pkg/index.js': PUBLISHED, 'src/copy.ts': REFORMATTED, 'src/own.ts': 'export const answer = 42;\n'});
  const result = await runCheckScript('similarity-scan.mjs', ['--root', root]);
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stdout, /^similarity scan, tier 1: 2 own files \(\d+ tokens\) against 1 files in node_modules\/ \(\d+ tokens\), windows of 50 tokens$/m);
  const shared = result.stdout.split('\n').filter((line) => line.startsWith('shared '));
  assert.equal(shared.length, 1, result.stdout);
  assert.match(shared[0]!, /^shared \d+ tokens, region [0-9a-f]{16}: src\/copy\.ts:2-12 = node_modules\/pkg\/index\.js:1-11 /);
  assert.match(shared[0]!, / \(no disposition yet\)$/);
  assert.match(result.stdout, /^1 shared region, 1 without a disposition$/m);
});

/** The identities of the regions a run reports, in order. */
function regionIds(stdout: string): string[] {
  return [...stdout.matchAll(/^shared \d+ tokens, region ([0-9a-f]{16}): /gm)].map((match) => match[1]!);
}

function dispose(root: string, dispositions: readonly object[]): void {
  mkdirSync(join(root, 'docs', 'evidence'), {recursive: true});
  writeFileSync(join(root, 'docs', 'evidence', 'similarity-dispositions.json'), JSON.stringify({dispositions}));
}

test('a region with a recorded disposition is listed with it and passes', async () => {
  const root = plant({'node_modules/pkg/index.js': PUBLISHED, 'src/copy.ts': REFORMATTED});
  const [id] = regionIds((await runCheckScript('similarity-scan.mjs', ['--root', root])).stdout);
  assert.ok(id !== undefined);
  dispose(root, [{own: 'src/copy.ts', corpus: 'node_modules/pkg/', regions: [id], disposition: 'declared: a planted copy'}]);
  const result = await runCheckScript('similarity-scan.mjs', ['--root', root]);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, new RegExp(`^shared \\d+ tokens, region ${id}: src/copy\\.ts:2-12 = node_modules/pkg/index\\.js:1-11 \\(declared: a planted copy\\)$`, 'm'));
  assert.match(result.stdout, /^1 shared region, 0 without a disposition$/m);
  for (const malformed of [{own: 'src/copy.ts', corpus: 'node_modules/pkg/', disposition: 'declared: a planted copy'}, {own: 'src/copy.ts', corpus: 'node_modules/pkg/', regions: [id]}, {own: 'src/copy.ts', corpus: 'node_modules/pkg/', regions: ['copy'], disposition: 'declared'}]) {
    dispose(root, [malformed]);
    const refused = await runCheckScript('similarity-scan.mjs', ['--root', root]);
    assert.equal(refused.code, 2, JSON.stringify(malformed));
    assert.match(refused.stderr, /each region named by its identity and each disposition written out/);
  }
});

test('a disposition covers the regions it names: a second copy between the same files fails, and so does a named region no longer found', async () => {
  const root = plant({'node_modules/pkg/index.js': PUBLISHED + PUBLISHED_TWO, 'src/copy.ts': REFORMATTED});
  const [first] = regionIds((await runCheckScript('similarity-scan.mjs', ['--root', root])).stdout);
  dispose(root, [{own: 'src/copy.ts', corpus: 'node_modules/pkg/', regions: [first], disposition: 'declared: the first copy'}]);
  assert.equal((await runCheckScript('similarity-scan.mjs', ['--root', root])).code, 0);

  // A second copy from the same package into the same file, apart from the first, is a new region.
  writeFileSync(join(root, 'src', 'copy.ts'), `${REFORMATTED}\nexport const shelves = 2;\n${PUBLISHED_TWO.replaceAll('  ', '\t')}`);
  const second = await runCheckScript('similarity-scan.mjs', ['--root', root]);
  assert.equal(second.code, 1, second.stdout);
  const ids = regionIds(second.stdout);
  assert.equal(ids.length, 2);
  assert.ok(ids.includes(first!));
  assert.match(second.stdout, new RegExp(`region ${first}: .* \\(declared: the first copy\\)$`, 'm'));
  assert.match(second.stdout, /^shared \d+ tokens, region [0-9a-f]{16}: src\/copy\.ts:15-24 = node_modules\/pkg\/index\.js:12-21 \(no disposition yet\)$/m);
  assert.match(second.stdout, /^2 shared regions, 1 without a disposition$/m);

  // The first copy gone, its recorded region is no longer found.
  writeFileSync(join(root, 'src', 'copy.ts'), PUBLISHED_TWO);
  const gone = await runCheckScript('similarity-scan.mjs', ['--root', root]);
  assert.equal(gone.code, 1, gone.stdout);
  assert.match(gone.stdout, new RegExp(`^recorded region ${first} of src/copy\\.ts and node_modules/pkg/ is not found: remove it from the dispositions, or find what changed$`, 'm'));
  assert.match(gone.stdout, /^1 shared region, 1 without a disposition, 1 recorded region not found$/m);
});

test('a run shorter than the window, and a copy with renamed identifiers, are not reported', async () => {
  const renamed = REFORMATTED.replaceAll('token', 'item').replaceAll('state', 'context');
  const short = 'const token = new state.Token("footnote_open", "", 1);\n';
  const root = plant({'node_modules/pkg/index.js': PUBLISHED, 'src/renamed.ts': renamed, 'src/short.ts': short});
  const result = await runCheckScript('similarity-scan.mjs', ['--root', root]);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^0 shared regions, 0 without a disposition$/m);
});

test('files outside own code are not scanned: vendor/, the licence fixtures, and anything git ignores', async () => {
  const root = plant({
    'node_modules/pkg/index.js': PUBLISHED,
    'vendor/pkg/index.js': PUBLISHED,
    'test/fixtures/license/tree/node_modules/pkg/index.js': PUBLISHED,
    'src/generated/ignored.js': PUBLISHED,
    'src/own.ts': 'export const answer = 42;\n',
  });
  writeFileSync(join(root, '.gitignore'), 'node_modules/\nsrc/generated/\n');
  const result = await runCheckScript('similarity-scan.mjs', ['--root', root]);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^similarity scan, tier 1: 1 own files /m);
});

test('a smaller window finds a shorter run; no node_modules/ or a bad argument is exit 2', async () => {
  const short = 'const token = new state.Token("footnote_open", "", 1);\ntoken.meta = { id: i, label: state.list[i].label };\n';
  const root = plant({'node_modules/pkg/index.js': PUBLISHED, 'src/short.ts': short});
  const narrow = await runCheckScript('similarity-scan.mjs', ['--root', root, '--tokens', '20']);
  assert.equal(narrow.code, 1, narrow.stdout + narrow.stderr);
  assert.match(narrow.stdout, /windows of 20 tokens/);
  const bare = plant({'src/own.ts': 'export const answer = 42;\n'});
  const missing = await runCheckScript('similarity-scan.mjs', ['--root', bare]);
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /node_modules\/ is missing/);
  assert.equal((await runCheckScript('similarity-scan.mjs', ['--tokens', '0'])).code, 2);
});

test('B7 on this repository: every run of 50 tokens its own code shares with a locked package has a recorded disposition', {timeout: 120_000}, async () => {
  const result = await runCheckScript('similarity-scan.mjs');
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /^\d+ shared regions?, 0 without a disposition$/m);
});
