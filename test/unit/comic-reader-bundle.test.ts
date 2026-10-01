/**
 * M4.3 (D109): the comic's one script, lib/clients/reader.js, and its preview
 * bundle, checked without a browser.
 *
 * The file is three parts: a banner line naming both licences, the vendored
 * engine's pinned bytes, byte for byte, then a newline and the reader's own
 * code as one esbuild IIFE. The own code is held to a list of what a
 * published client must never contain, written here apart from the scan in
 * scripts/bundle-clients.mjs, as test/unit/deck-client.test.ts does for the
 * deck; each entry is proved to catch a planted copy. The bundler's own
 * admission of the engine (its pin and the reviewed uses, D101) is then run
 * against tampered copies, and the reader's DOM names are held to its
 * CONTRACT.md. Browser behaviour is test/browser/comic.test.ts.
 */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {after, describe, test} from 'node:test';
import {pathToFileURL} from 'node:url';
import vm from 'node:vm';

import {domNames, undocumentedNames} from '../helpers/dom-names.js';
import {applicationRoot, runCheckScript, runNode, scriptPath} from '../helpers/paths.js';

/** The owner's pin (D100), written out a second time, apart from the scripts' PINS. */
const ENGINE = {bytes: 44_058, sha256: 'bbaca0bbef57a22bb66a3fc69d67baf9a17fb9a9c89ec9ed35e2b91abe4bd1e7'};

const READER = join(applicationRoot, 'lib', 'clients', 'reader.js');
const PREVIEW = join(applicationRoot, 'lib', 'clients', 'reader-preview.js');
const CONTRACT = join(applicationRoot, 'templates', 'comic', 'client', 'CONTRACT.md');
const VENDORED = join(applicationRoot, 'vendor', 'page-flip', 'page-flip.browser.js');

const temporary: string[] = [];
after(() => {
  for (const directory of temporary) {
    rmSync(directory, {recursive: true, force: true});
  }
});

function temporaryFile(name: string, bytes: Uint8Array | string): string {
  const directory = mkdtempSync(join(tmpdir(), 'papeleria-reader-'));
  temporary.push(directory);
  const file = join(directory, name);
  writeFileSync(file, bytes);
  return file;
}

type Parts = {readonly banner: string; readonly engine: Buffer; readonly own: string};

/** The three parts, found by position: the first line, the pinned number of bytes after it, a newline, the rest. */
function parts(file: string): Parts {
  const bytes = readFileSync(file);
  const newline = bytes.indexOf(0x0a);
  const engineEnd = newline + 1 + ENGINE.bytes;
  assert.ok(newline > 0, 'a first line');
  assert.equal(bytes[engineEnd], 0x0a, 'a newline after the engine');
  return {banner: bytes.subarray(0, newline).toString('utf8'), engine: bytes.subarray(newline + 1, engineEnd), own: bytes.subarray(engineEnd + 1).toString('utf8')};
}

/**
 * What the reader's own code must never contain, apart from the bundler's
 * list: identifiers rather than call shapes, so that an alias, a bracket, an
 * optional call or a passed reference cannot slip by.
 */
const NEVER_IN_OWN_CODE: [string, RegExp][] = [
  ['module syntax', /^\s*(?:import|export)\b/m],
  ['import(', /import\s*\(/],
  ['require(', /require\s*\(/],
  ['fetch', /fetch/i],
  ['XMLHttpRequest', /XMLHttpRequest/],
  ['navigator.sendBeacon', /sendBeacon/],
  ['WebSocket', /WebSocket/],
  ['EventSource', /EventSource/],
  ['importScripts', /importScripts/],
  ['a worker of any kind', /Worker\b/],
  ['a worklet', /Worklet|addModule/],
  ['eval', /\beval\b/],
  ['Function', /\bFunction\b/],
  ['a .constructor lookup', /\.\s*constructor\b|['"`]constructor['"`]/],
  ['a script element', /createElement(?:NS)?\s*\([^)]*script/i],
  ['Image', /\bImage\b/],
  ['a timer given a string', /set(?:Timeout|Interval)\s*\(\s*['"`]/],
  ['markup from a string', /innerHTML|outerHTML|insertAdjacentHTML|createContextualFragment|HTMLUnsafe|document\s*\.\s*write/],
  ['an http(s) or file URL', /(?:https?|file|wss?|ftp):/i],
  ['a protocol-relative URL', /['"`]\/\//],
  ['a root-relative path in a string', /['"`]\/[A-Za-z0-9._-]/],
  ['a source map', /sourceMappingURL/],
  ['storage of any kind', /localStorage|sessionStorage|indexedDB|document\s*\.\s*cookie|caches\b/],
];

/** One planted copy for each entry above. */
const PLANTED: Readonly<Record<string, string>> = {
  'module syntax': 'export const x = 1;',
  'import(': 'void import("./x.js");',
  'require(': 'require("x");',
  fetch: 'window["fetch"]("x");',
  XMLHttpRequest: 'new XMLHttpRequest();',
  'navigator.sendBeacon': 'navigator.sendBeacon("x");',
  WebSocket: 'new WebSocket("x");',
  EventSource: 'new EventSource("x");',
  importScripts: 'importScripts("x");',
  'a worker of any kind': 'new SharedWorker("x");',
  'a worklet': 'CSS.paintWorklet.addModule("x");',
  eval: 'eval("1");',
  Function: 'new Function("return 1");',
  'a .constructor lookup': '(() => 0).constructor("return 1");',
  'a script element': 'document.createElement("script");',
  Image: 'new Image();',
  'a timer given a string': 'setTimeout("alert(1)", 1);',
  'markup from a string': 'document.body.innerHTML = "x";',
  'an http(s) or file URL': 'const where = "https:example";',
  'a protocol-relative URL': 'const where = "//host/x";',
  'a root-relative path in a string': 'const where = "/etc/x";',
  'a source map': '//# sourceMappingURL=x.map',
  'storage of any kind': 'localStorage.setItem("x", "y");',
};

function forbiddenIn(text: string): string[] {
  return NEVER_IN_OWN_CODE.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}

type BundlerModule = {admitEngine(bytes: Uint8Array, label: string): string[]};

async function bundler(): Promise<BundlerModule> {
  return (await import(pathToFileURL(scriptPath('bundle-clients.mjs')).href)) as BundlerModule;
}

describe('reader.js: one classic script in three parts (C22, D109)', () => {
  test('a banner line names both licences, then the engine\'s pinned bytes, then the reader', () => {
    const {banner, engine, own} = parts(READER);
    assert.match(banner, /^\/\* Papeleria comic reader\. .* \*\/$/);
    assert.match(banner, /page-flip 2\.0\.7 \(StPageFlip\), byte for byte: MIT, see vendor\/page-flip\/LICENSE/);
    assert.match(banner, /own code under Apache-2\.0; see LICENSE and NOTICE\.md/);
    assert.equal(engine.length, ENGINE.bytes);
    assert.equal(createHash('sha256').update(engine).digest('hex'), ENGINE.sha256, 'line 2 is the pinned engine');
    assert.ok(engine.equals(readFileSync(VENDORED)), 'the vendored file, unchanged');
    assert.match(own, /^"use strict";\n\(\(\) => \{\n/, 'an IIFE, strict');
    assert.match(own, /\}\)\(\);\n$/);
  });

  test('the whole file compiles as one classic script; the own code is the reader, its logic and the adapter, never the bridge', () => {
    const text = readFileSync(READER, 'utf8');
    assert.doesNotThrow(() => new vm.Script(text, {filename: 'reader.js'}));
    const {own} = parts(READER);
    const inputs = [...own.matchAll(/^ {2}\/\/ (\S+\.ts)$/gm)].map((match) => match[1]);
    assert.deepEqual(inputs, ['templates/comic/client/engine-adapter.ts', 'templates/comic/client/reader-logic.ts', 'templates/comic/client/reader.ts']);
    assert.doesNotMatch(own, /preview-bridge|preview-comic|papeleria-preview|postMessage/, 'the preview bridge and the grid enter preview builds only');
  });

  test('the preview bundle is the same engine, then the reader, the bridge and the comic\'s preview-only grid', () => {
    const {banner, engine, own} = parts(PREVIEW);
    assert.match(banner, /^\/\* Papeleria comic reader for the preview\. /);
    assert.equal(createHash('sha256').update(engine).digest('hex'), ENGINE.sha256);
    const inputs = [...own.matchAll(/^ {2}\/\/ (\S+\.ts)$/gm)].map((match) => match[1]);
    assert.deepEqual(inputs, [
      'templates/comic/client/engine-adapter.ts',
      'templates/comic/client/reader-logic.ts',
      'templates/comic/client/reader.ts',
      'templates/shared/preview-protocol.ts',
      'templates/shared/preview-bridge.ts',
      'templates/comic/client/preview-comic.ts',
    ]);
    assert.doesNotThrow(() => new vm.Script(readFileSync(PREVIEW, 'utf8'), {filename: 'reader-preview.js'}));
  });

  test('the reader\'s own code holds nothing a published client may not, and each check catches a planted copy', () => {
    // The published file; the preview bundle adds the bridge, which checks its editor's http: origin (IC06), and is scanned by the bundler.
    assert.deepEqual(forbiddenIn(parts(READER).own), []);
    for (const [name] of NEVER_IN_OWN_CODE) {
      const planted = PLANTED[name];
      assert.ok(planted !== undefined, `a plant for ${name}`);
      assert.ok(forbiddenIn(`${parts(READER).own}\n${planted}\n`).includes(name), `${name} is caught`);
    }
  });

  test('the reader stores nothing and asks for nothing: no storage, no request, the address its only state', () => {
    const {own} = parts(READER);
    assert.doesNotMatch(own, /pushState/, 'the address is replaced, never pushed');
    assert.match(own, /replaceState/);
    assert.doesNotMatch(own, /\bopen\(|navigator\.|\.download\b/);
  });
});

describe('the engine\'s admission (D101, D109)', () => {
  test('the bundler admits the pinned engine, and refuses one byte changed', async () => {
    const {admitEngine} = await bundler();
    const engine = readFileSync(VENDORED);
    assert.deepEqual(admitEngine(engine, 'engine'), []);
    const changed = Buffer.from(engine);
    changed[1000] = changed[1000]! ^ 1;
    const problems = admitEngine(changed, 'engine');
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /is not the pinned engine/);
    assert.match(admitEngine(engine.subarray(0, 100), 'engine')[0]!, /100 bytes with SHA-256/);
  });

  test('--scan reads a reader bundle in its parts: clean as built, and refused with a byte of the engine or a forbidden use in the own code', async () => {
    const clean = await runCheckScript('bundle-clients.mjs', ['--scan', READER, PREVIEW]);
    assert.equal(clean.code, 0, clean.stderr);
    assert.match(clean.stdout, /reader\.js: scan clean/);

    const bytes = readFileSync(READER);
    const newline = bytes.indexOf(0x0a);
    const engineByte = Buffer.from(bytes);
    engineByte[newline + 500] = engineByte[newline + 500]! ^ 1;
    const tampered = await runCheckScript('bundle-clients.mjs', ['--scan', temporaryFile('reader.js', engineByte)]);
    assert.equal(tampered.code, 1);
    assert.match(tampered.stderr, /\(the engine, line 2\) is not the pinned engine/);

    const image = await runCheckScript('bundle-clients.mjs', ['--scan', temporaryFile('reader.js', Buffer.concat([bytes, Buffer.from('new Image();\n')]))]);
    assert.equal(image.code, 1);
    assert.match(image.stderr, /\(the reader's own code\):\d+ contains an Image/);

    const moved = Buffer.concat([bytes.subarray(0, newline + 1), Buffer.from('\n'), bytes.subarray(newline + 1)]);
    const shifted = await runCheckScript('bundle-clients.mjs', ['--scan', temporaryFile('reader.js', moved)]);
    assert.equal(shifted.code, 1, 'the engine must start on line 2');
  });

  test('the engine alone is still refused as own code: the scan is not loosened', async () => {
    const scan = await runCheckScript('bundle-clients.mjs', ['--scan', VENDORED]);
    assert.equal(scan.code, 1);
    assert.match(scan.stderr, /contains an Image/);
  });

  test('a bundle reaches lib/clients/ only after a clean scan: a refused reader leaves no reader.js to copy (W5R-24)', async () => {
    // The bundler runs in a copy of its own layout with stand-in sources, so the refusal is real and the
    // repository's lib/ is not touched.
    const root = mkdtempSync(join(tmpdir(), 'papeleria-bundler-'));
    temporary.push(root);
    const put = (path: string, contents: string | Buffer): void => {
      mkdirSync(dirname(join(root, path)), {recursive: true});
      writeFileSync(join(root, path), contents);
    };
    for (const name of ['bundle-clients.mjs', 'vendor-page-flip.mjs']) {
      put(`scripts/${name}`, readFileSync(scriptPath(name)));
    }
    symlinkSync(join(applicationRoot, 'node_modules'), join(root, 'node_modules'), 'junction');
    put('tsconfig.client.json', readFileSync(join(applicationRoot, 'tsconfig.client.json')));
    put('package-lock.json', '{"packages": {}}\n');
    put('vendor/page-flip/page-flip.browser.js', readFileSync(VENDORED));
    put('templates/deck/client/deck.ts', 'document.title = "deck";\n');
    put('templates/shared/preview-bridge.ts', 'document.title += " bridge";\n');
    put('templates/deck/client/preview-deck.ts', 'document.title += " overflow";\n');
    put('templates/comic/client/preview-comic.ts', 'document.title += " grid";\n');
    // What no published client may hold: the scan refuses the reader and its preview bundle.
    put('templates/comic/client/reader.ts', 'document.title = String(new Image());\n');
    put('src/editor/app.ts', 'document.title = "editor";\n');
    put('src/editor/serve-shell.ts', 'document.title = "serve";\n');
    for (const page of ['index.html', 'editor.css', 'serve.html', 'serve.css']) {
      put(`src/editor/${page}`, '');
    }
    // An earlier build's reader.js: a build that failed must not leave it standing either.
    put('lib/clients/reader.js', '/* an earlier build */\n');

    const result = await runNode(join(root, 'scripts', 'bundle-clients.mjs'));
    assert.equal(result.code, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /lib\/clients\/reader\.js \(the reader's own code\):\d+ contains an Image/);
    assert.match(result.stderr, /lib\/clients\/reader-preview\.js \(the reader's own code\):\d+ contains an Image/);
    const clients = join(root, 'lib', 'clients');
    assert.equal(existsSync(join(clients, 'reader.js')), false, 'neither the refused reader.js nor an earlier one is where the pipeline copies from');
    assert.deepEqual(readdirSync(clients).sort(), ['deck-preview.js', 'deck.js', 'document-preview.js', 'editor', 'serve'], 'the clean clients, and no temporary file');
    assert.match(readFileSync(join(clients, 'deck.js'), 'utf8'), /^\/\* Papeleria deck client\. [^\n]*\*\/\n"use strict";\n\(\(\) => \{\n[^]*document\.title = "deck";\n\}\)\(\);\n$/, 'a clean client is written whole');
  });
});

describe('CONTRACT.md (CONTRACT §7)', () => {
  const contract = readFileSync(CONTRACT, 'utf8');

  test('every id, class, attribute, element, event and global the reader\'s own code names is documented', () => {
    const {own} = parts(READER);
    assert.deepEqual(undocumentedNames(own, contract), []);
    const names = domNames(own);
    for (const expected of [
      'id comic-previous',
      'id comic-next',
      'id comic-guided',
      'id comic-detail',
      'id comic-transcript-toggle',
      'id comic-fullscreen',
      'id comic-status',
      'id papeleria-strings',
      'id comic-main',
      'id comic-book',
      'class comic-enhanced',
      'class comic-guided',
      'class comic-spread',
      'class comic-show-transcript',
      'class comic-panel',
      'class comic-panel-label',
      'class comic-sheet',
      'class comic-figure',
      'class comic-art',
      'attribute data-panel',
      'attribute data-page',
      'attribute data-detail',
      'attribute data-box',
      'attribute data-zoom-src',
      'element dialog',
      'event pagechange',
      'global papeleriaReader',
    ]) {
      assert.ok(names.has(expected), `the reading finds ${expected}`);
    }
  });

  test('the reading is not vacuous: planted names are found and reported', () => {
    const {own} = parts(READER);
    const planted = `${own}
      document.getElementById("comic-secret-panel");
      document.body.classList.add("comic-undocumented-state");
      element("aside", "comic-planted-part", { id: "comic-planted-id", "data-planted": "yes" });
      node.dataset["plantedThing"] = "1";
      document.dispatchEvent(new CustomEvent("plantedchange"));
      window.plantedReader = {};
    `;
    assert.deepEqual(undocumentedNames(planted, contract), [
      'attribute data-planted',
      'attribute data-planted-thing',
      'class comic-planted-part',
      'class comic-undocumented-state',
      'element aside',
      'event plantedchange',
      'global plantedReader',
      'id comic-planted-id',
      'id comic-secret-panel',
    ]);
  });
});
