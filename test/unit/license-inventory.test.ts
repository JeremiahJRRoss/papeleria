/**
 * M5.3 / R11 / DEP06 (D125): the final licence inventory.
 *
 * The committed docs/evidence/license-inventory.json is exactly what
 * scripts/license-inventory.mjs computes from the repository, and it holds
 * what the milestone asks: every lockfile entry once with its scope, the SPDX
 * expression as declared and license-check's own evaluation of it; the
 * platform packages from the lockfile and the recorded observations, never
 * from node_modules; the vendored engine; the fonts with what their own
 * tables say; the material copied into Papeleria's own files; the packages
 * inside the shipped editor bundle, read from the bundle; the components
 * inside sharp's binaries; and the gaps. A refused licence stops it.
 */
import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after, test} from 'node:test';
import {pathToFileURL} from 'node:url';

import {applicationRoot, fixturePath, runCheckScript, scriptPath} from '../helpers/paths.js';

type NpmRecord = {
  name: string;
  version: string;
  path: string;
  scope: 'author-runtime' | 'dev' | 'optional-platform';
  policyScope: 'author-runtime' | 'dev';
  platform?: {os?: string[]; cpu?: string[]};
  declared: string | null;
  expression: string | null;
  allowed: boolean;
  allowedBy?: string;
  inspected: string;
  licenceFiles?: {file: string; sha256: string; readsAs?: string[]}[];
  copyright?: string[];
  bundledInto?: string[];
  copiedInto?: string[];
  retained?: string[];
};
type Inventory = {
  summary: Record<string, unknown> & {npm: Record<string, number>};
  npm: NpmRecord[];
  vendored: {name: string; version: string; declared: string; copyright: string[]; licenceFile: {path: string; sha256: string}}[];
  fonts: {family: string; declared: string; copyright: string[]; nameTableCopyright: string[]; files: {path: string; observed: Record<string, unknown>}[]}[];
  copied: {what: string; into: string; package?: string; version?: string}[];
  bundled: {file: string; installations: string[]}[];
  native: {
    packages: {package: string; distributionScope: string; review: string; observations: unknown[]}[];
    components: {component: string; version: string; weakCopyleft?: boolean; retained?: string[]; notRetained?: string[]; upstream?: string}[];
  };
  gaps: {subject: string; gap: string; owner: string}[];
};
type InventoryModule = {
  classifyLicenceText(text: string): string[];
  copyrightLines(text: string): string[];
  fontFacts(bytes: Uint8Array): Record<string, unknown>;
  woff2Tables(bytes: Uint8Array): Map<string, Uint8Array>;
  bundledInstallations(text: string): string[];
  unrepresentedLicences(expression: string, reads: string[]): string[];
  installedNativeAgreement(root: string, observations: unknown[]): {package: string; agrees: boolean}[];
  COPIED: readonly {into: string; marker: string; package?: string; version?: string}[];
  EDITOR_BUNDLE: string;
};

const inventoryModule = async (): Promise<InventoryModule> => (await import(pathToFileURL(scriptPath('license-inventory.mjs')).href)) as InventoryModule;
const committed = (): Inventory => JSON.parse(readFileSync(join(applicationRoot, 'docs', 'evidence', 'license-inventory.json'), 'utf8')) as Inventory;
const lockfile = (): Record<string, {version?: string; dev?: boolean; os?: string[]; cpu?: string[]}> =>
  (JSON.parse(readFileSync(join(applicationRoot, 'package-lock.json'), 'utf8')) as {packages: Record<string, {version?: string; dev?: boolean}>}).packages;

const temporary: string[] = [];
after(() => {
  for (const directory of temporary) rmSync(directory, {recursive: true, force: true});
});
function temporaryRoot(label: string): string {
  const directory = mkdtempSync(join(tmpdir(), `papeleria-inventory-${label}-`));
  temporary.push(directory);
  return directory;
}

/** Native-review flags that require nothing, as the licence-check tests use them. */
function quietNative(root: string): string[] {
  const write = (name: string, value: unknown): string => {
    writeFileSync(join(root, name), JSON.stringify(value));
    return join(root, name);
  };
  return [
    '--scope', write('scope.json', {distributionScope: {decision: 'test', authorizedBy: 'test', date: '2026-09-28', platforms: []}, exclusions: []}),
    '--observations', write('observations.json', {observations: []}),
    '--reviews', write('reviews.json', {reviews: []}),
  ];
}

test('the committed inventory is exactly what the script computes from the repository', async () => {
  const result = await runCheckScript('license-inventory.mjs', ['--check']);
  assert.equal(result.code, 0, `${result.stdout}${result.stderr}\nRun node scripts/license-inventory.mjs and review the difference.`);
  assert.match(result.stdout, /^licence inventory: 225 lockfile entries/);
});

test('every lockfile entry appears once, scoped, with the check’s own evaluation', () => {
  const inventory = committed();
  const lock = lockfile();
  const entries = Object.keys(lock).filter((path) => path !== '');
  assert.deepEqual(inventory.npm.map((record) => record.path).sort(), entries.sort());
  for (const record of inventory.npm) {
    const entry = lock[record.path]!;
    assert.equal(record.version, entry.version, record.path);
    assert.equal(record.policyScope, entry.dev === true ? 'dev' : 'author-runtime', record.path);
    assert.ok(['author-runtime', 'dev', 'optional-platform'].includes(record.scope), record.path);
    if (entry.dev === true) assert.equal(record.scope, 'dev', `${record.path} is a development package wherever it runs`);
    assert.equal(record.allowed, true, `${record.path} is allowed: R11 passes`);
    assert.ok(record.expression !== null, `${record.path} has an expression to evaluate`);
  }
  const counts = inventory.summary.npm;
  assert.equal(counts['total'], entries.length);
  assert.equal((counts['author-runtime'] ?? 0) + (counts['dev'] ?? 0) + (counts['optional-platform'] ?? 0), entries.length);
});

test('a platform package is described from the lockfile and the observations, never from node_modules', () => {
  const inventory = committed();
  const platform = inventory.npm.filter((record) => record.platform !== undefined);
  assert.ok(platform.length >= 40, 'sharp’s and esbuild’s per-platform packages');
  for (const record of platform) {
    assert.notEqual(record.inspected, 'installed', record.path);
    assert.equal(record.copyright, undefined, `${record.path}: nothing read from a platform’s own install`);
  }
  const win = inventory.npm.find((record) => record.name === '@img/sharp-win32-x64')!;
  assert.equal(win.inspected, 'scripts/native-observations.json');
  assert.deepEqual(win.licenceFiles?.map((file) => file.file), ['LICENSE']);
  assert.equal(win.allowedBy, 'allowlist and the libvips list (D24)');
});

test('the editor bundle’s packages are read from the shipped file, and every one is a production dependency', async () => {
  const {bundledInstallations, EDITOR_BUNDLE} = await inventoryModule();
  const inventory = committed();
  const read = bundledInstallations(readFileSync(join(applicationRoot, ...EDITOR_BUNDLE.split('/')), 'utf8'));
  assert.deepEqual(inventory.bundled, [{file: EDITOR_BUNDLE, installations: read}]);
  assert.equal(read.length, 58);
  const lock = lockfile();
  for (const path of read) {
    assert.ok(lock[path] !== undefined && lock[path]!.dev !== true, `${path} is a production dependency (D76)`);
    const record = inventory.npm.find((candidate) => candidate.path === path)!;
    assert.deepEqual(record.bundledInto, [EDITOR_BUNDLE]);
    assert.ok((record.retained ?? []).every((file) => file.startsWith('licenses/packages/')), `${path}: its licence travels in the package`);
  }
  for (const expected of ['node_modules/@codemirror/state', 'node_modules/yaml', 'node_modules/codemirror-json-schema/node_modules/markdown-it']) {
    assert.ok(read.includes(expected), expected);
  }
  for (const absent of ['node_modules/railroad-diagrams', 'node_modules/argparse', 'node_modules/codemirror-json5']) {
    assert.ok(!read.includes(absent), `${absent} contributes no code to the bundle`);
  }
  assert.deepEqual(
    bundledInstallations('(() => {\n  // node_modules/a/index.js\n  var a = 1;\n  // node_modules/@b/c/lib/x.js\n  // node_modules/a/node_modules/d/y.js\n  // src/editor/app.ts\n})();\n'),
    ['node_modules/@b/c', 'node_modules/a', 'node_modules/a/node_modules/d'],
  );
});

/** The installation an esbuild input path lies in: everything up to the package after its last `node_modules/`. */
function installationOf(input: string): string {
  const at = input.lastIndexOf('node_modules/') + 'node_modules/'.length;
  const [first, second] = input.slice(at).split('/');
  return `${input.slice(0, at)}${first!.startsWith('@') ? `${first}/${second}` : first}`;
}

test('B4 (issue 002 F1): what esbuild put into each bundle is what the inventory read, each in THIRD_PARTY.md with its copyright', () => {
  type Metafile = {outputs: Record<string, {inputs: Record<string, {bytesInOutput: number}>}>};
  const inventory = committed();
  const sectionStart = readFileSync(join(applicationRoot, 'THIRD_PARTY.md'), 'utf8').split('\n## 3. Bundled into the editor page\n')[1];
  assert.ok(sectionStart !== undefined, 'THIRD_PARTY.md has its section 3');
  const rows = sectionStart.split('\n## ')[0]!.split('\n').filter((line) => line.startsWith('| ') && !line.startsWith('| Package') && !line.startsWith('| ---'));
  // Every bundle `npm run build` writes, published clients and tool pages alike (scripts/bundle-clients.mjs keeps their metafiles).
  const scripts = ['deck.js', 'deck-preview.js', 'document-preview.js', 'reader.js', 'reader-preview.js', 'editor.js', 'serve.js'];
  for (const script of scripts) {
    const metafile = JSON.parse(readFileSync(join(applicationRoot, 'lib', 'metafiles', `${script}.json`), 'utf8')) as Metafile;
    const outputs = Object.entries(metafile.outputs).filter(([path]) => path.endsWith('.js'));
    assert.equal(outputs.length, 1, `${script}: one script`);
    const [output, {inputs}] = outputs[0]!;
    const installations = [...new Set(Object.entries(inputs).filter(([input, used]) => input.includes('node_modules/') && used.bytesInOutput > 0).map(([input]) => installationOf(input)))].sort();
    const inventoried = inventory.bundled.find((entry) => entry.file === output)?.installations ?? [];
    assert.deepEqual(installations, [...inventoried].sort(), `${output}: the packages esbuild bundled are the ones the inventory read from the file`);
    for (const path of installations) {
      const record = inventory.npm.find((candidate) => candidate.path === path)!;
      assert.equal(record.policyScope, 'author-runtime', `${path} is allowed in author-runtime scope`);
      assert.equal(record.allowed, true, path);
      const row = rows.find((line) => line.startsWith(`| ${record.name} | ${record.version} |`));
      assert.ok(row !== undefined, `${record.name} ${record.version} has its row in THIRD_PARTY.md`);
      assert.match(row.split(' | ')[3]!, /Copyright|\(c\)|©/i, `${record.name} ${record.version}: the row carries its copyright line`);
    }
  }
  assert.equal(inventory.bundled.length, 1, 'only the editor page bundles packages');
  assert.equal(rows.length, inventory.bundled[0]!.installations.length);
});

test('B3: every lockfile entry comes from the public registry with its integrity, and nothing is bundled into a package', () => {
  const lock = JSON.parse(readFileSync(join(applicationRoot, 'package-lock.json'), 'utf8')) as {packages: Record<string, {resolved?: string; integrity?: string; link?: boolean; bundleDependencies?: unknown; inBundle?: boolean}>};
  const entries = Object.entries(lock.packages).filter(([path]) => path !== '');
  assert.equal(entries.length, 225);
  for (const [path, entry] of entries) {
    assert.ok(entry.resolved?.startsWith('https://registry.npmjs.org/'), `${path} resolves from the public registry, not ${entry.resolved}`);
    assert.match(entry.integrity ?? '', /^sha512-/, `${path} has an integrity hash`);
    assert.ok(entry.link !== true && entry.bundleDependencies === undefined && entry.inBundle !== true, `${path} is neither linked nor bundled`);
  }
});

test('material copied into Papeleria’s own files is inventoried, and still says where it came from', async () => {
  const {COPIED} = await inventoryModule();
  const inventory = committed();
  assert.equal(inventory.copied.length, COPIED.length);
  const lock = lockfile();
  for (const entry of COPIED) {
    assert.ok(readFileSync(join(applicationRoot, ...entry.into.split('/')), 'utf8').includes(entry.marker), `${entry.into} still names its source`);
    if (entry.package !== undefined) {
      assert.equal(lock[`node_modules/${entry.package}`]?.version, entry.version, `${entry.package} is still the version copied (D41)`);
      const record = inventory.npm.find((candidate) => candidate.name === entry.package)!;
      assert.deepEqual(record.copiedInto, [entry.into]);
    }
  }
  assert.deepEqual(inventory.copied.map((entry) => entry.package ?? entry.into), ['d3-dsv', 'd3-format', 'd3-time-format', 'markdown-it-footnote', 'templates/comic/comic.css']);
});

test('the vendored engine and the fonts are inventoried in published-piece scope, with what their own files say', () => {
  const inventory = committed();
  assert.equal(inventory.vendored.length, 1);
  const engine = inventory.vendored[0]!;
  assert.deepEqual([engine.name, engine.version, engine.declared, engine.copyright], ['StPageFlip', '2.0.7', 'MIT', ['Copyright (c) 2020 Nodlik']]);
  assert.equal(engine.licenceFile.sha256, '88d7b609a3be5efa2abe8648ddc35d5489579db5e06299545760df45c2c32d66');
  assert.deepEqual(inventory.fonts.map((family) => [family.family, family.declared, family.files.length]), [['Poppins', 'OFL-1.1', 6], ['Inter', 'OFL-1.1', 2]]);
  for (const family of inventory.fonts) {
    for (const file of family.files) {
      assert.ok(String(file.observed['family']).startsWith(family.family), `${file.path} names its own family`);
      assert.equal(file.observed['embedding'], 'installable', `${file.path}: fsType 0`);
    }
  }
  const inter = inventory.fonts[1]!;
  assert.deepEqual(inter.nameTableCopyright, ['Copyright 2016 The Inter Project Authors (https://github.com/rsms/inter)']);
  // Issue 002 F3: the retained text carries the line the fonts embed, above Google Fonts' own, so no year is left in dispute.
  assert.deepEqual(inter.copyright, ['Copyright 2016 The Inter Project Authors (https://github.com/rsms/inter)', 'Copyright 2020 The Inter Project Authors (https://github.com/rsms/inter)']);
  assert.ok(!inventory.gaps.some((gap) => /name tables say/.test(gap.gap)), 'every copyright line a font embeds is in its retained text');
  for (const family of ['Poppins', 'Inter']) {
    assert.ok(inventory.gaps.some((gap) => gap.subject === `${family} (fonts)` && /provenance is not established/.test(gap.gap) && gap.owner === 'Release owner'));
  }
});

test('the native section: every sharp package, its review as recorded, and 31 components each with a retained text or a recorded gap', () => {
  const inventory = committed();
  assert.equal(inventory.native.packages.length, 27);
  const required = inventory.native.packages.filter((record) => record.distributionScope === 'required');
  assert.equal(required.length, 16);
  assert.ok(required.every((record) => record.review === 'unresolved'), 'no review is signed: a person signs them (D34)');
  assert.equal(inventory.native.components.length, 31);
  assert.equal(inventory.native.components.filter((component) => component.weakCopyleft).length, 9);
  for (const component of inventory.native.components) {
    const retained = component.retained ?? [];
    assert.ok(retained.length > 0 || (component.notRetained ?? []).length > 0, `${component.component} ${component.version}`);
    for (const path of retained) {
      assert.ok(existsSync(join(applicationRoot, path)), `${path} is retained`);
    }
    if ((component.notRetained ?? []).length > 0) {
      assert.ok(inventory.gaps.some((gap) => gap.subject === `${component.component} ${component.version}` && gap.gap.startsWith('no retained text')), `${component.component}'s missing text is a recorded gap`);
    }
  }
  const resvg = inventory.native.components.find((component) => component.component === 'resvg')!;
  assert.equal(resvg.upstream, 'https://github.com/linebender/resvg', 'issue 002 A6');
  assert.deepEqual(inventory.native.components.find((component) => component.component === 'mozjpeg')!.retained, ['licenses/Zlib.txt', 'licenses/IJG.txt', 'licenses/BSD-3-Clause.txt']);
});

test('the sharp packages installed here are the bytes their observations recorded', async () => {
  const {installedNativeAgreement} = await inventoryModule();
  const observations = (JSON.parse(readFileSync(scriptPath('native-observations.json'), 'utf8')) as {observations: unknown[]}).observations;
  const results = installedNativeAgreement(applicationRoot, observations);
  assert.ok(results.some((result) => result.package === 'sharp'), 'sharp itself is installed on every platform');
  for (const result of results) {
    assert.ok(result.agrees, `${result.package} differs from its observation`);
  }
});

test('licence texts: each licence the tree ships reads as itself, and an unknown text as nothing', async () => {
  const {classifyLicenceText} = await inventoryModule();
  const cases: [string, string[]][] = [
    ['Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files', ['MIT']],
    ['Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies.', ['ISC']],
    ['Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted.\n\nTHE SOFTWARE IS PROVIDED "AS IS"', ['0BSD']],
    ['Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:', ['BSD-2-Clause']],
    ['Redistribution and use in source and binary forms, with or without modification, are permitted provided that ... Neither the name of the copyright holder', ['BSD-3-Clause']],
    ['Apache License\n                           Version 2.0, January 2004', ['Apache-2.0']],
    ['PYTHON SOFTWARE FOUNDATION LICENSE VERSION 2\n1. This LICENSE AGREEMENT', ['PSF-2.0']],
    ['PYTHON SOFTWARE FOUNDATION LICENSE VERSION 2 ... BEOPEN.COM LICENSE AGREEMENT FOR PYTHON 2.0 ... CNRI LICENSE AGREEMENT', ['Python-2.0']],
    ['Creative Commons Legal Code\n\nCC0 1.0 Universal', ['CC0-1.0']],
    ['SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007\nPermission is hereby granted, free of charge, to any person obtaining a copy of the Font Software', ['OFL-1.1']],
    ['You may use this code only on Tuesdays.', []],
  ];
  for (const [text, expected] of cases) {
    assert.deepEqual(classifyLicenceText(text), expected, text.slice(0, 60));
  }
  for (const [file, expected] of [['LICENSE', ['Apache-2.0']], ['vendor/page-flip/LICENSE', ['MIT']], ['theme/fonts/Inter-OFL.txt', ['OFL-1.1']], ['licenses/LGPL-3.0-or-later.txt', ['LGPL-3.0']]] as const) {
    assert.deepEqual(classifyLicenceText(readFileSync(join(applicationRoot, file), 'utf8')), expected, file);
  }
});

test('a declared expression is held to the texts by its structure: every AND operand needs its text, one OR alternative is enough', async () => {
  const {unrepresentedLicences} = await inventoryModule();
  assert.deepEqual(unrepresentedLicences('MIT', ['MIT']), []);
  assert.deepEqual(unrepresentedLicences('Apache-2.0 AND LGPL-3.0-or-later AND MIT', ['Apache-2.0']), ['LGPL-3.0-or-later', 'MIT']);
  assert.deepEqual(unrepresentedLicences('(AFL-2.1 OR BSD-3-Clause)', ['BSD-3-Clause']), []);
  assert.deepEqual(unrepresentedLicences('(MIT OR Apache-2.0) AND BSD-3-Clause', ['MIT']), ['BSD-3-Clause'], 'an OR met on one side asks nothing of the other');
  assert.deepEqual(unrepresentedLicences('(MIT OR Apache-2.0)', ['ISC']), ['MIT', 'Apache-2.0']);
  assert.deepEqual(unrepresentedLicences('GPL-3.0-or-later', ['GPL-3.0']), [], 'the GPL-3.0 text stands for GPL-3.0-or-later');
  // The case the flat comparison hid: sharp's WebAssembly package ships the Apache-2.0 text only.
  const wasm = committed().gaps.filter((gap) => gap.subject === '@img/sharp-wasm32@0.35.4');
  assert.equal(wasm.length, 1);
  assert.match(wasm[0]!.gap, /^declares Apache-2\.0 AND LGPL-3\.0-or-later AND MIT, but its own licence text reads as Apache-2\.0: the package carries no text for LGPL-3\.0-or-later and MIT \(retained in Papeleria's licenses\/LGPL-3\.0-or-later\.txt and licenses\/MIT\.txt\)$/);
  assert.ok(!committed().gaps.some((gap) => gap.subject === 'json-schema@0.4.0'), 'its BSD-3-Clause text meets (AFL-2.1 OR BSD-3-Clause)');
});

test('copyright lines: notices kept, templates and the word inside the terms dropped', async () => {
  const {copyrightLines} = await inventoryModule();
  assert.deepEqual(copyrightLines('MIT License\n\nCopyright (c) 2020 Nodlik\n\nThe above copyright notice and this permission notice shall be included'), ['Copyright (c) 2020 Nodlik']);
  assert.deepEqual(copyrightLines('   Copyright [yyyy] [name of copyright owner]\n'), [], 'the Apache-2.0 appendix names nobody');
  assert.deepEqual(copyrightLines('Copyright Eemeli Aro <eemeli@gmail.com>\n\nPermission to use'), ['Copyright Eemeli Aro <eemeli@gmail.com>'], 'a notice without a year is still a notice');
  assert.deepEqual(copyrightLines('The ISC License\n\nCopyright (c) Isaac Z. Schlueter and Contributors\n'), ['Copyright (c) Isaac Z. Schlueter and Contributors']);
  assert.deepEqual(copyrightLines('Copyright (c) 1991 - 1995, Stichting Mathematisch Centrum Amsterdam,\nThe Netherlands. All rights reserved.\n'), ['Copyright (c) 1991 - 1995, Stichting Mathematisch Centrum Amsterdam, The Netherlands. All rights reserved.']);
  assert.deepEqual(
    copyrightLines('retained in Python alone, i.e., "Copyright (c) 2001, 2002\n2003 Python Software Foundation; All Rights Reserved" are retained'),
    ['Copyright (c) 2001, 2002 2003 Python Software Foundation; All Rights Reserved'],
    'a notice the terms quote is found across its line break',
  );
  assert.deepEqual(copyrightLines('Copyright laws apply.\ncopyright holders and contributors'), []);
});

test('a font file tells the inventory its own name, version, vendor and embedding', async () => {
  const {fontFacts, woff2Tables} = await inventoryModule();
  const facts = fontFacts(readFileSync(join(applicationRoot, 'theme', 'fonts', 'poppins-600-latin.woff2')));
  assert.equal(facts['copyright'], 'Copyright 2020 The Poppins Project Authors (https://github.com/itfoundry/Poppins)');
  assert.deepEqual([facts['family'], facts['version'], facts['vendorId'], facts['weightClass'], facts['fontRevision']], ['Poppins SemiBold', '4.004', 'ITFO', 600, '4.004']);
  const inter = fontFacts(readFileSync(join(applicationRoot, 'theme', 'fonts', 'inter-400-700-latin.woff2')));
  assert.deepEqual(inter['variableAxes'], ['wght 100–900']);
  assert.throws(() => woff2Tables(new Uint8Array(64)), /not a WOFF2 file/);
});

test('a refused licence stops the inventory and nothing is written; an allowed tree is inventoried', async () => {
  for (const tree of ['tree-disallowed', 'tree-unknown']) {
    const scratch = temporaryRoot(tree);
    const out = join(scratch, 'inventory.json');
    const result = await runCheckScript('license-inventory.mjs', ['--root', fixturePath('license', tree), '--out', out, ...quietNative(scratch)]);
    assert.equal(result.code, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /R11 refuses \d+ item\(s\); nothing written/);
    assert.equal(existsSync(out), false);
  }
  const scratch = temporaryRoot('tree-ok');
  const out = join(scratch, 'inventory.json');
  const passed = await runCheckScript('license-inventory.mjs', ['--root', fixturePath('license', 'tree-ok'), '--out', out, ...quietNative(scratch)]);
  assert.equal(passed.code, 0, passed.stdout + passed.stderr);
  const inventory = JSON.parse(readFileSync(out, 'utf8')) as Inventory;
  assert.ok(inventory.npm.length > 0);
  assert.ok(inventory.npm.every((record) => record.allowed));
});

test('a development dependency inside a shipped bundle is refused', async () => {
  const root = temporaryRoot('dev-in-bundle');
  mkdirSync(join(root, 'node_modules', 'tool'), {recursive: true});
  writeFileSync(join(root, 'node_modules', 'tool', 'package.json'), JSON.stringify({name: 'tool', version: '1.0.0', license: 'MIT'}));
  writeFileSync(join(root, 'node_modules', 'tool', 'LICENSE'), 'MIT License\n\nCopyright (c) 2026 Tool\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software\n');
  writeFileSync(join(root, 'package-lock.json'), JSON.stringify({lockfileVersion: 3, packages: {'': {name: 'fixture', version: '0.0.0'}, 'node_modules/tool': {version: '1.0.0', dev: true, license: 'MIT'}}}));
  const bundle = join(root, 'bundle.js');
  writeFileSync(bundle, '(() => {\n  // node_modules/tool/index.js\n  var tool = 1;\n})();\n');
  const result = await runCheckScript('license-inventory.mjs', ['--root', root, '--bundle', bundle, '--out', join(root, 'inventory.json'), ...quietNative(root)]);
  assert.equal(result.code, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /node_modules\/tool@1\.0\.0 \(dev\) is a development dependency, yet its code is inside lib\/clients\/editor\/editor\.js/);
});
