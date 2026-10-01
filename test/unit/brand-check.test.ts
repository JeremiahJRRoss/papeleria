/**
 * M0.3 / R12: the brand check catches a copied owner asset and accepts the
 * public identity files that D05 allows.
 *
 * The allowed-exceptions and excluded-path trees are assembled at run time from
 * the repository's real `theme/brand.default.json` and
 * `theme/marks/papeleria-favicon.svg`, so the fixture proves the shipped files
 * pass rather than proving that a second copy of them passes.
 */
import assert from 'node:assert/strict';
import {cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after, test} from 'node:test';

import {applicationRoot, fixturePath, runCheckScript} from '../helpers/paths.js';

const temporaryRoots: string[] = [];

function temporaryRoot(label: string): string {
  const directory = mkdtempSync(join(tmpdir(), `papeleria-brand-${label}-`));
  temporaryRoots.push(directory);
  return directory;
}

after(() => {
  for (const directory of temporaryRoots) {
    rmSync(directory, {recursive: true, force: true});
  }
});

const ownerMark = fixturePath('brand', 'with-owner-copy', 'brand', 'fixture-owner-mark.svg');
const ownerInventory = fixturePath('brand', 'with-owner-copy', 'brand', 'owner-assets.sha256');

function writeInventoryAndMark(root: string): void {
  mkdirSync(join(root, 'brand'), {recursive: true});
  cpSync(ownerMark, join(root, 'brand', 'fixture-owner-mark.svg'));
  cpSync(ownerInventory, join(root, 'brand', 'owner-assets.sha256'));
}

test('a copy of an inventoried owner asset outside brand/ fails', async () => {
  const result = await runCheckScript('brand-check.mjs', [
    '--root',
    fixturePath('brand', 'with-owner-copy'),
  ]);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /result: FAIL — 1 copied owner asset\(s\) \(R12\)/);
  assert.match(result.stdout, /piece\/assets\/images\/fixture-owner-mark\.svg/);
  assert.match(result.stdout, /brand\/fixture-owner-mark\.svg/);
});

test('an absent inventory passes with an explicit note, never a silent skip', async () => {
  const result = await runCheckScript('brand-check.mjs', [
    '--root',
    fixturePath('brand', 'no-inventory'),
  ]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /note: brand\/owner-assets\.sha256 is absent/);
  assert.match(result.stdout, /no owner-exclusive assets are supplied/);
  assert.match(result.stdout, /not\s+permission to introduce unidentified owner marks/);
  assert.match(result.stdout, /scanned: 2 regular file\(s\)/);
});

test('the shipped public theme default, favicon and a client logo pass', async () => {
  const root = temporaryRoot('allowed');
  writeInventoryAndMark(root);

  mkdirSync(join(root, 'theme', 'marks'), {recursive: true});
  cpSync(join(applicationRoot, 'theme', 'brand.default.json'), join(root, 'theme', 'brand.default.json'));
  cpSync(
    join(applicationRoot, 'theme', 'marks', 'papeleria-favicon.svg'),
    join(root, 'theme', 'marks', 'papeleria-favicon.svg'),
  );

  const logos = join(root, 'piece', 'assets', 'images', 'logos');
  mkdirSync(logos, {recursive: true});
  writeFileSync(
    join(logos, 'client-logo.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 8"><title>A client logo</title>' +
      '<rect width="20" height="8" fill="#0f766e"/></svg>\n',
  );

  const result = await runCheckScript('brand-check.mjs', ['--root', root]);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /inventory: 1 owner hash\(es\)/);
  assert.match(result.stdout, /scanned: 3 regular file\(s\)/);
  assert.match(result.stdout, /result: pass/);
});

test('copies inside the documented exclusions are not scanned', async () => {
  const root = temporaryRoot('excluded');
  writeInventoryAndMark(root);

  // node_modules and .papeleria at any depth; the tool's own lib/ and dist/ only at the root (W5R-25).
  for (const directory of [
    ['node_modules', 'some-package'],
    ['piece', 'node_modules', 'some-package'],
    ['lib', 'src'],
    ['dist'],
    ['piece', '.papeleria', 'cache'],
  ]) {
    const target = join(root, ...directory);
    mkdirSync(target, {recursive: true});
    cpSync(ownerMark, join(target, 'fixture-owner-mark.svg'));
  }

  const result = await runCheckScript('brand-check.mjs', ['--root', root]);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /scanned: 0 regular file\(s\)/);
});

test('a nested brand/ directory is still scanned; only the root brand/ is skipped', async () => {
  const root = temporaryRoot('nested');
  writeInventoryAndMark(root);
  const nested = join(root, 'piece', 'brand');
  mkdirSync(nested, {recursive: true});
  cpSync(ownerMark, join(nested, 'fixture-owner-mark.svg'));

  const result = await runCheckScript('brand-check.mjs', ['--root', root]);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /piece\/brand\/fixture-owner-mark\.svg/);
});

test('lib and dist below the root are scanned: an owner mark under a sample\'s assets/lib/ fails (W5R-25)', async () => {
  const root = temporaryRoot('nested-lib-dist');
  writeInventoryAndMark(root);
  // A sample's assets/lib/ ships in the package and is copied by `new`; a piece's dist/ is what it publishes.
  for (const directory of [
    ['templates', 'deck', 'sample', 'assets', 'lib'],
    ['examples', 'starter-deck', 'dist', 'assets'],
  ]) {
    const target = join(root, ...directory);
    mkdirSync(target, {recursive: true});
    cpSync(ownerMark, join(target, 'fixture-owner-mark.svg'));
  }

  const result = await runCheckScript('brand-check.mjs', ['--root', root]);
  assert.equal(result.code, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /result: FAIL — 2 copied owner asset\(s\) \(R12\)/);
  assert.match(result.stdout, /templates\/deck\/sample\/assets\/lib\/fixture-owner-mark\.svg has the hash of brand\/fixture-owner-mark\.svg/);
  assert.match(result.stdout, /examples\/starter-deck\/dist\/assets\/fixture-owner-mark\.svg has the hash of brand\/fixture-owner-mark\.svg/);
  assert.match(result.stdout, /excluding \.git, node_modules and \.papeleria at any depth, and brand\/, lib\/ and dist\/ at the root/);
});

test('a malformed inventory line is a usage failure, not a pass', async () => {
  const root = temporaryRoot('malformed');
  mkdirSync(join(root, 'brand'), {recursive: true});
  writeFileSync(join(root, 'brand', 'owner-assets.sha256'), 'not-a-hash  brand/mark.svg\n');

  const result = await runCheckScript('brand-check.mjs', ['--root', root]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /is not a SHA-256 inventory line/);
});

test('the repository itself passes', async () => {
  const result = await runCheckScript('brand-check.mjs', ['--root', applicationRoot]);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /result: pass/);
});
