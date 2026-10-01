/**
 * M5.3 (D126, D127): the notices.
 *
 * - THIRD_PARTY.md, licenses/packages/ and licenses/index.json are exactly
 *   what scripts/gen-notice.mjs writes from the repository, and every text the
 *   index names is there with its recorded SHA-256.
 * - The package's THIRD_PARTY.md groups its entries by scope, in a fixed
 *   order, and covers all 31 components inside sharp's binaries.
 * - The dist-scoped variant, the module every build uses, names a font family
 *   only when its files are in the folder and the engine only when reader.js
 *   carries the pinned file, and names nothing else.
 * - gen-notice never writes NOTICE.md.
 */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after, test} from 'node:test';
import {pathToFileURL} from 'node:url';

import {distThirdParty, FONT_FAMILIES, publishedComponents, THIRD_PARTY_FILE, type EmittedFiles} from '../../src/build/notices.js';
import {applicationRoot, runCheckScript, scriptPath} from '../helpers/paths.js';

type Index = {
  licenses: {spdxId: string; file: string; sha256: string; bytes: number}[];
  packages: {package: string; version: string; file: string; sha256: string; bytes: number; copiedFrom: string; why: string}[];
};
type GenNotice = {
  renderThirdParty(inventory: unknown, index: unknown): string;
  packageTexts(inventory: unknown): {file: string; sha256: string}[];
  refuseNotice(path: string): string;
};
type LicenseCheck = {FONT_FAMILIES: readonly {family: string; prefix: string; text: string}[]};

const genNotice = async (): Promise<GenNotice> => (await import(pathToFileURL(scriptPath('gen-notice.mjs')).href)) as GenNotice;
const read = (relative: string): string => readFileSync(join(applicationRoot, ...relative.split('/')), 'utf8');
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

const temporary: string[] = [];
after(() => {
  for (const directory of temporary) rmSync(directory, {recursive: true, force: true});
});

test('THIRD_PARTY.md, licenses/packages/ and licenses/index.json are what gen-notice writes', async () => {
  const result = await runCheckScript('gen-notice.mjs', ['--check']);
  assert.equal(result.code, 0, `${result.stdout}${result.stderr}\nRun node scripts/gen-notice.mjs and review the difference.`);
  assert.match(result.stdout, /check: THIRD_PARTY\.md, licenses\/packages\/ and licenses\/index\.json are current/);
});

test('every text the licence index names is in licenses/ with the recorded SHA-256', () => {
  const index = JSON.parse(read('licenses/index.json')) as Index;
  assert.equal(index.licenses.length, 14, 'the twelve SPDX texts and IJG and libtiff (D126)');
  for (const id of ['LGPL-3.0-or-later', 'GPL-3.0-or-later', 'MPL-2.0', 'Apache-2.0', 'MIT', 'BSD-2-Clause', 'BSD-3-Clause', 'Zlib', 'libpng-2.0', 'FTL', 'ISC', '0BSD', 'IJG', 'libtiff']) {
    assert.ok(index.licenses.some((entry) => entry.spdxId === id), `${id} is retained`);
  }
  for (const entry of [...index.licenses, ...index.packages]) {
    const bytes = readFileSync(join(applicationRoot, 'licenses', ...entry.file.split('/')));
    assert.equal(sha256(bytes), entry.sha256, entry.file);
    assert.equal(bytes.length, entry.bytes, entry.file);
  }
  for (const entry of index.packages) {
    assert.match(entry.file, /^packages\/(?:@[^/]+\/)?[^/@]+@[^/]+\/[^/]+$/, entry.file);
    assert.ok(readFileSync(join(applicationRoot, ...entry.copiedFrom.split('/'))).equals(readFileSync(join(applicationRoot, 'licenses', ...entry.file.split('/')))), `${entry.file} is ${entry.copiedFrom}, byte for byte`);
  }
  assert.ok(index.packages.some((entry) => entry.package === 'd3-format' && /copied into src\/core\/charts\.ts/.test(entry.why)));
  assert.ok(index.packages.some((entry) => entry.package === '@codemirror/view' && /bundled into lib\/clients\/editor\/editor\.js/.test(entry.why)));
});

test('the package THIRD_PARTY.md: its sections in order, and all 31 components with their texts', () => {
  const text = read('THIRD_PARTY.md');
  const headings = [...text.matchAll(/^##+ (.+)$/gm)].map((match) => match[1]);
  assert.deepEqual(headings, [
    '1. In published pieces',
    '2. Copied into Papeleria’s own files',
    '3. Bundled into the editor page',
    '4. Installed with Papeleria',
    '5. Platform packages',
    '5.1 The libraries inside the prebuilt binaries',
    '6. Development only',
    '7. Licence texts',
  ]);
  const section = (from: string, to: string): string => text.slice(text.indexOf(`## ${from}`), text.indexOf(`## ${to}`));
  const components = section('5.1', '6.').split('\n').filter((line) => line.startsWith('| ') && !line.startsWith('| Component') && !line.startsWith('| ---'));
  assert.equal(components.length, 31);
  for (const row of components) {
    assert.match(row, /`licenses\/[^`]+\.txt`|not retained: /, row.slice(0, 60));
  }
  assert.match(section('1.', '2.'), /\| StPageFlip \| 2\.0\.7 \| .* \| MIT \| Copyright \(c\) 2020 Nodlik \|/);
  assert.match(section('3.', '4.'), /\| @codemirror\/state \| [\d.]+ \| MIT \| Copyright \(C\) 2018-2021 by Marijn Haverbeke/);
  assert.doesNotMatch(section('4.', '5.'), /\| (?:esbuild|typescript|playwright) \|/, 'development packages are not installed with Papeleria');
  assert.match(section('6.', '7.'), /\| typescript \| 5\.9\.3 \| Apache-2\.0 \|/);
  assert.match(text, /this software is based in part on the work of the Independent JPEG Group/);
  assert.doesNotMatch(text, /<(?![^<>\s]+@[^<>\s]+>)(?!https?:\/\/)[A-Za-z]/, 'no raw HTML tag in the Markdown');
});

test('scope grouping: each entry lands under its own scope’s section', async () => {
  const {renderThirdParty} = await genNotice();
  const npm = (name: string, scope: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    name, version: '1.0.0', path: `node_modules/${name}`, scope, policyScope: scope === 'dev' ? 'dev' : 'author-runtime', declared: 'MIT', expression: 'MIT',
    allowed: true, allowedBy: 'allowlist', inspected: 'installed', licenceFiles: [{file: 'LICENSE', sha256: 'a'.repeat(64), readsAs: ['MIT']}], copyright: [`Copyright (c) 2026 ${name}`], ...extra,
  });
  const inventory = {
    npm: [
      npm('runtime-only', 'author-runtime'),
      npm('in-the-editor', 'author-runtime', {bundledInto: ['lib/clients/editor/editor.js'], retained: ['licenses/packages/in-the-editor@1.0.0/LICENSE']}),
      npm('platform-bin', 'optional-platform', {platform: {os: ['linux'], cpu: ['x64']}, inspected: 'scripts/native-observations.json', copyright: undefined}),
      npm('dev-tool', 'dev'),
    ],
    vendored: [{name: 'Engine', version: '2.0.0', declared: 'MIT', copyright: ['Copyright (c) 2026 Engine'], file: {path: 'vendor/engine/engine.js'}, licenceFile: {path: 'vendor/engine/LICENSE'}, component: 'vendor/engine'}],
    fonts: [{family: 'Face', declared: 'OFL-1.1', copyright: ['Copyright 2026 The Face Project Authors'], nameTableCopyright: [], licenceFile: {path: 'theme/fonts/Face-OFL.txt'}, files: [{path: 'theme/fonts/face-400.woff2', observed: {fontRevision: '1.000', version: '1.000'}}]}],
    copied: [],
    bundled: [{file: 'lib/clients/editor/editor.js', installations: ['node_modules/in-the-editor']}],
    native: {packages: [{package: 'platform-bin', distributionScope: 'required', review: 'unresolved', observations: []}], components: [{component: 'libthing', version: '3.0', inPackages: ['platform-bin'], licenceFromReadme: 'MIT License', retained: ['licenses/MIT.txt']}]},
  };
  const text = renderThirdParty(inventory, {licenses: [{spdxId: 'MIT', file: 'MIT.txt', why: 'libthing'}], packages: []});
  const at = (needle: string): number => {
    const position = text.indexOf(needle);
    assert.ok(position >= 0, `${needle} is in the file`);
    return position;
  };
  const sections = ['## 1.', '## 2.', '## 3.', '## 4.', '## 5.', '### 5.1', '## 6.', '## 7.'].map(at);
  assert.deepEqual([...sections].sort((a, b) => a - b), sections, 'the sections keep their order');
  const within = (needle: string, from: number, to: number): void => {
    const position = at(needle);
    assert.ok(position > sections[from]! && position < sections[to]!, `${needle} is in section ${from + 1}`);
  };
  within('| Engine | 2.0.0 |', 0, 1);
  within('| Face | 1.000 |', 0, 1);
  within('| in-the-editor | 1.0.0 | MIT |', 2, 3);
  within('| runtime-only | 1.0.0 | MIT |', 3, 4);
  within('| platform-bin | 1.0.0 | linux / x64 |', 4, 5);
  within('| libthing | 3.0 |', 5, 6);
  within('| dev-tool | 1.0.0 | MIT |', 6, 7);
  assert.equal(text.indexOf('| dev-tool |'), text.lastIndexOf('| dev-tool |'), 'a development package appears in its own section only');
  assert.equal(text.indexOf('| runtime-only |'), text.lastIndexOf('| runtime-only |'));
});

test('packageTexts keeps one copy per name and version, and refuses two installations whose texts differ', async () => {
  const {packageTexts} = await genNotice();
  const record = (path: string, sha: string): Record<string, unknown> => ({name: 'twice', version: '1.0.0', path, bundledInto: ['lib/clients/editor/editor.js'], licenceFiles: [{file: 'LICENSE', sha256: sha, bytes: 10}]});
  assert.deepEqual(packageTexts({npm: [record('node_modules/twice', 'a'.repeat(64)), record('node_modules/x/node_modules/twice', 'a'.repeat(64))]}).map((entry) => entry.file), ['packages/twice@1.0.0/LICENSE']);
  assert.throws(() => packageTexts({npm: [record('node_modules/twice', 'a'.repeat(64)), record('node_modules/x/node_modules/twice', 'b'.repeat(64))]}), /two installations whose LICENSE differ/);
});

test('gen-notice never writes NOTICE.md', async () => {
  const {refuseNotice} = await genNotice();
  assert.throws(() => refuseNotice('/somewhere/NOTICE.md'), /which a person maintains/);
  assert.throws(() => refuseNotice('notice.MD'), /which a person maintains/);
  assert.equal(refuseNotice('/somewhere/THIRD_PARTY.md'), '/somewhere/THIRD_PARTY.md');
  const before = read('NOTICE.md');
  const result = await runCheckScript('gen-notice.mjs', ['--out', join(applicationRoot, 'NOTICE.md')]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /gen-notice never writes it/);
  assert.equal(read('NOTICE.md'), before);
});

// --- the dist-scoped variant (D127) -------------------------------------------

const FONT_PATHS = [
  'theme/fonts/inter-400-700-latin.woff2',
  'theme/fonts/inter-400-700-latin-ext.woff2',
  'theme/fonts/poppins-400-latin.woff2',
  'theme/fonts/poppins-600-latin.woff2',
];

/** A folder's files in memory: paths and, where a test needs them, bytes. */
function folder(files: Record<string, Uint8Array | string>): EmittedFiles {
  return {
    paths: Object.keys(files).sort(),
    read: async (path) => {
      const value = files[path];
      return value === undefined ? null : typeof value === 'string' ? Buffer.from(value) : value;
    },
  };
}

test('dist: a deck names the two font families and nothing else', async () => {
  const text = await distThirdParty(applicationRoot, folder({'index.html': '', 'deck.js': '', 'theme/css/site.css': '', ...Object.fromEntries(FONT_PATHS.map((path) => [path, '']))}), '9.9.9');
  assert.match(text, /^# Third-party components in this piece\n\nWritten by Papeleria 9\.9\.9 from the files in this folder\./);
  assert.match(text, /including the page, `deck\.js` and the stylesheets, is under the Apache License 2\.0/);
  assert.match(text, /\| Poppins \| `theme\/fonts\/poppins-400-latin\.woff2`, `theme\/fonts\/poppins-600-latin\.woff2` \| SIL Open Font License 1\.1 \(OFL-1\.1\) \| Copyright 2020 The Poppins Project Authors \(https:\/\/github\.com\/itfoundry\/Poppins\) \| `Poppins-OFL\.txt` \|/);
  assert.match(text, /\| Inter \| .* \| Copyright 2016 The Inter Project Authors \(https:\/\/github\.com\/rsms\/inter\); Copyright 2020 The Inter Project Authors \(https:\/\/github\.com\/rsms\/inter\) \| `Inter-OFL\.txt` \|/);
  assert.doesNotMatch(text, /StPageFlip/);
});

test('dist: a comic names the engine, from the pinned bytes on line 2 of reader.js', async () => {
  const reader = readFileSync(join(applicationRoot, 'lib', 'clients', 'reader.js'));
  const comic = readFileSync(join(applicationRoot, 'templates', 'comic', 'comic.css'));
  const files = {'index.html': '', 'reader.js': reader, 'theme/css/comic.css': comic, 'vendor/page-flip/LICENSE': '', ...Object.fromEntries(FONT_PATHS.map((path) => [path, '']))};
  const text = await distThirdParty(applicationRoot, folder(files), '9.9.9');
  assert.match(text, /including the page, the reader in `reader\.js` and the stylesheets/);
  assert.match(text, /\| StPageFlip 2\.0\.7 \| line 2 of `reader\.js`, byte for byte, and the four layout rules `theme\/css\/comic\.css` restates from it \| MIT \| Copyright \(c\) 2020 Nodlik \| `vendor\/page-flip\/LICENSE` \|/);
  assert.match(text, /The 3 third-party components here:/);

  const withoutRules = await distThirdParty(applicationRoot, folder({...files, 'theme/css/comic.css': 'body{}'}), '9.9.9');
  assert.match(withoutRules, /\| StPageFlip 2\.0\.7 \| line 2 of `reader\.js`, byte for byte \| MIT \|/, 'the stylesheet is named only when it restates the rules');

  const changed = Buffer.from(reader);
  changed[changed.indexOf(0x0a) + 100] ^= 0x01;
  const other = await publishedComponents(applicationRoot, folder({...files, 'reader.js': changed}));
  assert.deepEqual(other.map((component) => component.name), ['Poppins', 'Inter'], 'a reader.js without the pinned engine names no engine');
});

test('dist: a folder with no fonts and no reader holds no third-party component', async () => {
  const text = await distThirdParty(applicationRoot, folder({'index.html': '', 'theme/css/site.css': ''}), '9.9.9');
  assert.match(text, /including the page and the stylesheets, is under the Apache License 2\.0/);
  assert.match(text, /This folder holds no third-party component\.\n$/);
  assert.equal(THIRD_PARTY_FILE, 'THIRD_PARTY.md');
});

test('the build and the licence check name the same font families', async () => {
  const check = (await import(pathToFileURL(scriptPath('license-check.mjs')).href)) as LicenseCheck;
  assert.deepEqual(
    FONT_FAMILIES.map((family) => [family.family, family.prefix, family.source]),
    check.FONT_FAMILIES.map((family) => [family.family, `theme/fonts/${family.prefix}`, family.text]),
  );
});

test('gen-notice --dist writes what the build writes, and --check says so', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'papeleria-notice-dist-'));
  temporary.push(directory);
  mkdirSync(join(directory, 'theme', 'fonts'), {recursive: true});
  for (const path of FONT_PATHS) writeFileSync(join(directory, ...path.split('/')), '');
  writeFileSync(join(directory, 'deck.js'), '');
  const written = await runCheckScript('gen-notice.mjs', ['--dist', directory]);
  assert.equal(written.code, 0, written.stdout + written.stderr);
  const version = (JSON.parse(read('package.json')) as {version: string}).version;
  const expected = await distThirdParty(applicationRoot, folder({'deck.js': '', 'THIRD_PARTY.md': '', ...Object.fromEntries(FONT_PATHS.map((path) => [path, '']))}), version);
  assert.equal(readFileSync(join(directory, 'THIRD_PARTY.md'), 'utf8'), expected);
  assert.equal((await runCheckScript('gen-notice.mjs', ['--dist', directory, '--check'])).code, 0);
  writeFileSync(join(directory, 'THIRD_PARTY.md'), 'edited\n');
  assert.equal((await runCheckScript('gen-notice.mjs', ['--dist', directory, '--check'])).code, 1);
});
