/**
 * M0.2: the maintained attribution exists and `package.json` files matches the
 * planned inventory in docs/DISTRIBUTION_INVENTORY.md.
 *
 * This is a manifest consistency check, not a tarball test. The real tarball
 * is inspected by `npm run test:package` (M1.8, D68) and again at M5.3.
 */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';

import {applicationRoot} from '../helpers/paths.js';

const read = (relative: string): string =>
  readFileSync(join(applicationRoot, relative), 'utf8');

test('the maintained legal files exist and say what they must', () => {
  const license = read('LICENSE');
  assert.match(license, /Apache License\s+Version 2\.0, January 2004/);
  assert.match(license, /APPENDIX: How to apply the Apache License/);

  const notice = read('NOTICE.md');
  assert.match(notice, /Copyright 2026 Ross\.moda/);
  assert.match(notice, /Apache License, Version 2\.0/);
  assert.match(notice, /SIL Open Font License 1\.1/);
  assert.match(notice, /TRADEMARKS\.md/);

  const trademarks = read('TRADEMARKS.md');
  assert.match(trademarks, /Ross\.moda/);
  assert.match(trademarks, /Papeleria favicon in `theme\/marks\/`/);
});

test('NOTICE.md attributes every library inside sharp’s binaries to a retained text (M5.3, issue 002 A3)', () => {
  const notice = read('NOTICE.md');
  const section = notice.slice(notice.indexOf('## Libraries inside sharp'));
  assert.ok(section.startsWith('## Libraries inside sharp'), 'NOTICE.md has the section');
  const rows = section.split('\n').filter((line) => line.startsWith('| ') && !line.startsWith('| Library') && !line.startsWith('| ---'));
  const components = (JSON.parse(read('docs/evidence/native-source-index.json')) as {components: {component: string; version: string}[]}).components;
  assert.equal(rows.length, components.length, 'one row per library and version');
  const retained = new Set((JSON.parse(read('licenses/index.json')) as {licenses: {file: string}[]}).licenses.map((entry) => entry.file));
  for (const {component, version} of components) {
    const row = rows.find((candidate) => candidate.startsWith(`| ${component} `) && candidate.split(' | ')[1]!.startsWith(version));
    assert.ok(row !== undefined, `${component} ${version} is attributed`);
    const texts = [...row.split(' | ').at(-1)!.matchAll(/`([^`]+\.txt)`/g)].map((match) => match[1]!);
    assert.ok(texts.length > 0 || /not yet retained/.test(row), `${component} ${version} names its text, or says it is not yet retained`);
    for (const text of texts) {
      assert.ok(retained.has(text), `${text}, named for ${component}, is retained and indexed`);
    }
  }
  assert.match(section, /this software is based in part on the work of the Independent JPEG Group/);
});

test('both font OFL texts are complete and name their family', () => {
  for (const [file, family] of [
    ['theme/fonts/Poppins-OFL.txt', 'Poppins'],
    ['theme/fonts/Inter-OFL.txt', 'Inter'],
  ] as const) {
    const text = read(file);
    assert.match(text, new RegExp(`Copyright 2020 The ${family} Project Authors`));
    assert.match(text, /SIL OPEN FONT LICENSE Version 1\.1/);
    assert.match(text, /PERMISSION & CONDITIONS/);
    assert.match(text, /TERMINATION/);
  }
});

test('every licence text licenses/index.json names is there, byte for byte as hashed (D36, D126)', () => {
  const index = JSON.parse(read('licenses/index.json')) as {licenses: {file: string; sha256: string; bytes: number}[]; packages: {file: string; sha256: string; bytes: number}[]};
  const entries = [...index.licenses, ...index.packages];
  assert.deepEqual([index.licenses.length, index.packages.length], [14, 61], 'the editor bundle’s 58 (d3-dsv’s also copied, D182), d3-format and d3-time-format (D41), markdown-it-footnote (D144)');
  for (const entry of entries) {
    const bytes = readFileSync(join(applicationRoot, 'licenses', ...entry.file.split('/')));
    assert.equal(bytes.length, entry.bytes, `licenses/${entry.file} is ${entry.bytes} bytes`);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256, `licenses/${entry.file} is the text the index hashed`);
  }
});

test('each OFL text carries every copyright line its fonts embed (issue 002 F3)', () => {
  const inventory = JSON.parse(read('docs/evidence/license-inventory.json')) as {fonts: {family: string; licenceFile: {path: string}; nameTableCopyright: string[]}[]};
  assert.deepEqual(inventory.fonts.map((family) => family.family), ['Poppins', 'Inter']);
  for (const family of inventory.fonts) {
    const lines = read(family.licenceFile.path).split('\n').map((line) => line.trim());
    assert.ok(family.nameTableCopyright.length > 0, `${family.family}: the fonts embed a copyright line`);
    for (const embedded of family.nameTableCopyright) {
      assert.ok(lines.includes(embedded), `${family.licenceFile.path} carries "${embedded}", as the ${family.family} files embed it`);
    }
  }
  assert.equal(read('theme/fonts/Inter-OFL.txt').split('\n')[0], 'Copyright 2016 The Inter Project Authors (https://github.com/rsms/inter)');
});

test('the eight shipped WOFF2 subsets are present', () => {
  const fonts = [
    'inter-400-700-latin.woff2',
    'inter-400-700-latin-ext.woff2',
    'poppins-400-latin.woff2',
    'poppins-400-latin-ext.woff2',
    'poppins-500-latin.woff2',
    'poppins-500-latin-ext.woff2',
    'poppins-600-latin.woff2',
    'poppins-600-latin-ext.woff2',
  ];
  assert.equal(fonts.length, 8);
  for (const font of fonts) {
    assert.ok(
      readFileSync(join(applicationRoot, 'theme', 'fonts', font)).length > 0,
      `${font} is missing or empty`,
    );
  }
});

test('package.json files matches the planned distribution inventory', () => {
  const manifest = JSON.parse(read('package.json')) as {files: string[]; bin: Record<string, string>};
  assert.deepEqual(manifest.files, [
    'lib/src/',
    'lib/templates/',
    '!lib/templates/*/client/',
    'lib/clients/',
    '!lib/**/*.map',
    'templates/',
    'theme/',
    '!theme/js/',
    'vendor/',
    'LICENSE',
    'NOTICE.md',
    'TRADEMARKS.md',
    'THIRD_PARTY.md',
    'licenses/',
    'npm-shrinkwrap.json',
  ]);
  assert.equal(manifest.bin['papeleria'], 'lib/src/cli/index.js');

  const mustNotShip = ['brand', 'docs', 'blueprint', 'reference', 'examples', 'src', 'test', 'scripts', 'lib/test', 'lib/scripts'];
  for (const path of mustNotShip) {
    assert.ok(
      !manifest.files.some((entry) => entry.replace(/\/$/, '') === path),
      `${path} must not be packaged`,
    );
  }
});

test('the inventory document lists every packaged path and every exclusion', () => {
  const inventory = read('docs/DISTRIBUTION_INVENTORY.md');
  for (const entry of ['lib/src/', 'lib/templates/', 'lib/clients/', 'templates/', 'theme/', 'vendor/', 'THIRD_PARTY.md', 'licenses/', 'npm-shrinkwrap.json']) {
    assert.ok(inventory.includes(entry), `${entry} is packaged but not documented`);
  }
  for (const entry of ['brand/', 'reference/', 'lib/test/', 'theme/js/', 'lib/templates/*/client/', 'lib/**/*.map']) {
    assert.ok(inventory.includes(entry), `${entry} exclusion is not documented`);
  }
  assert.match(inventory, /Poppins-OFL\.txt/);
  assert.match(inventory, /StPageFlip/);
});
