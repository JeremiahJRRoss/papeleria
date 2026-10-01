#!/usr/bin/env node
/**
 * Bundles each browser client into one classic script (M1.6, D50).
 *
 * A published deck carries exactly one executable script and must open from
 * disk (IC07), so each client is bundled by esbuild into a classic IIFE with
 * no `import`, `require` or network call left in it, and the output is then
 * scanned. Bundles go to lib/clients/, which `npm run build` regenerates and
 * git ignores; the npm package ships that directory and the pipeline copies a
 * bundle into each dist/, so a bundle is written there only once its scan is
 * clean, and a refused one leaves no file of its name behind (W5R-24).
 *
 * M2 (W3A, D76) adds two preview-only bundles, each an entry of its own so the
 * published deck.js entry never widens: `deck-preview.js`, the deck client with
 * the preview bridge bundled in, which a preview generation stages under the
 * name deck.js, and `document-preview.js`, the bridge alone, for a template
 * that publishes no script. Both are scanned like a published client; the
 * bridge learns its editor's origin at run time, so no address is written in
 * them. Neither is ever copied into dist/.
 *
 * Two tool pages are bundled here too (D76): the editor (`lib/clients/editor/`)
 * and `serve`'s read-only shell (`lib/clients/serve/`), each a classic script
 * beside its page and stylesheet. They run in the author's own browser from
 * the local server and nothing copies them into dist/; they reach the server
 * with fetch or an event stream, which a published client must never do, so
 * the scan below is not theirs. Their inputs are still bounded — own code
 * only from `src/editor/` and the preview protocol, third-party code only
 * from production dependencies in the lockfile — a warning still fails, and
 * they must still compile as classic scripts.
 *
 * M4.3 (W4, D109) adds the comic reader, `reader.js`, and its preview
 * bundle, `reader-preview.js`, the reader with the bridge. Each is one
 * classic script in three parts: a banner line naming both licences, the
 * page-turn engine's pinned bytes exactly as vendored (M4.1, D100), then a
 * newline and the esbuild IIFE of the reader's own code, which takes the
 * engine from the global it defines. The engine is never an esbuild input,
 * so it is neither re-bundled nor rewritten. The scan is not loosened for
 * it: the own code is scanned as every client is, and the engine is admitted
 * only as the file whose size and SHA-256 are pinned, in which every match of
 * every forbidden pattern lies inside one of the uses reviewed once in D101
 * (`REVIEWED_USES`), each present exactly once. `--scan` reads a reader
 * bundle in the same three parts.
 *
 * M5.3 (W5B, D128): each bundle's esbuild metafile is kept as
 * `lib/metafiles/<script>.json`, outside what the package ships, so the
 * licence inventory's test can hold the packages it reads from the shipped
 * editor page to what esbuild actually put into it (issue 002 F1).
 *
 * Usage: node scripts/bundle-clients.mjs                   build every client, then scan it
 *        node scripts/bundle-clients.mjs --scan <file...>  scan existing files without building
 * Exit:  0 built and clean · 1 an esbuild warning, a foreign input or a forbidden
 *        pattern · 2 usage, IO or build failure
 */
import {createHash} from 'node:crypto';
import {copyFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {basename, dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import vm from 'node:vm';

import {build, formatMessages} from 'esbuild';

import {PINS, REVIEWED_USES} from './vendor-page-flip.mjs';

class UsageError extends Error {}

const USAGE = 'usage: node scripts/bundle-clients.mjs [--scan <file...>]';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The browser clients. `sources` bounds what a bundle may contain: every
 * client is own code only, so nothing from node_modules can reach a published
 * piece unnoticed. `engine` puts the vendored page-turn engine before the
 * bundle, admitted as described above; it is never one of the inputs.
 */
const CLIENTS = [
  {
    name: 'deck',
    entry: 'templates/deck/client/deck.ts',
    outfile: 'lib/clients/deck.js',
    sources: ['templates/deck/client/'],
  },
  {
    // The deck client, the bridge, then the deck's preview-only overflow
    // check (IC06, D76, D174), in one classic script. The entry exists only
    // here, as esbuild's stdin, so the bundle's recipe is stated where its
    // inputs are bounded.
    name: 'deck-preview',
    stdin: {
      contents: "import './templates/deck/client/deck.ts';\nimport './templates/shared/preview-bridge.ts';\nimport './templates/deck/client/preview-deck.ts';\n",
      sourcefile: 'deck-preview.entry.ts',
    },
    outfile: 'lib/clients/deck-preview.js',
    sources: ['templates/deck/client/', 'templates/shared/preview-bridge.ts', 'templates/shared/preview-protocol.ts', 'deck-preview.entry.ts'],
  },
  {
    name: 'document-preview',
    entry: 'templates/shared/preview-bridge.ts',
    outfile: 'lib/clients/document-preview.js',
    sources: ['templates/shared/preview-bridge.ts', 'templates/shared/preview-protocol.ts'],
  },
  {
    // The comic's one script (C22, D109): the engine, then the reader and its adapter.
    name: 'reader',
    title: 'comic reader',
    entry: 'templates/comic/client/reader.ts',
    outfile: 'lib/clients/reader.js',
    sources: ['templates/comic/client/'],
    engine: true,
  },
  {
    // The reader, the bridge, then the comic's preview-only grid, pointer and marks (IC06, D117); a preview
    // generation stages it as reader.js.
    name: 'reader-preview',
    title: 'comic reader for the preview',
    stdin: {
      contents:
        "import './templates/comic/client/reader.ts';\nimport './templates/shared/preview-bridge.ts';\nimport './templates/comic/client/preview-comic.ts';\n",
      sourcefile: 'reader-preview.entry.ts',
    },
    outfile: 'lib/clients/reader-preview.js',
    sources: ['templates/comic/client/', 'templates/shared/preview-bridge.ts', 'templates/shared/preview-protocol.ts', 'reader-preview.entry.ts'],
    engine: true,
  },
];

/** The vendored engine a reader bundle starts with (M4.1). */
const ENGINE_PATH = join('vendor', 'page-flip', PINS.file.name);

/**
 * Tool pages: never published, so outside the scan; see the header. `own`
 * bounds the project files a bundle may contain, and `packages` whether it may
 * contain third-party code at all, which must then be a production dependency.
 */
const TOOLS = [
  {
    name: 'editor',
    entry: 'src/editor/app.ts',
    outdir: 'lib/clients/editor',
    script: 'editor.js',
    copy: [
      ['src/editor/index.html', 'index.html'],
      ['src/editor/editor.css', 'editor.css'],
    ],
    own: ['src/editor/', 'templates/shared/preview-protocol.ts'],
    packages: true,
  },
  {
    name: 'serve',
    entry: 'src/editor/serve-shell.ts',
    outdir: 'lib/clients/serve',
    script: 'serve.js',
    copy: [
      ['src/editor/serve.html', 'index.html'],
      ['src/editor/serve.css', 'serve.css'],
    ],
    own: ['src/editor/serve-shell.ts', 'src/editor/dom.ts', 'templates/shared/preview-protocol.ts'],
    packages: false,
  },
];

/**
 * Current evergreen engines, floored at the first releases in which every API
 * the clients use is unprefixed: Safari 16.4 (March 2023) brought the
 * unprefixed Fullscreen API, and the other engines are floored in the same
 * season. esbuild lowers any newer syntax for these targets and adds no
 * polyfills.
 */
const TARGET = ['chrome111', 'edge111', 'firefox111', 'safari16.4', 'ios16.4'];

/**
 * What a published client must never contain: each is a way to reach the
 * network, load more code or evaluate text at run time (IC02, IC07, C22, C24).
 * The preview's CSP forbids eval as well (IC06). The patterns match the
 * identifiers, not the calls, so an alias, a bracket, an optional call or a
 * function passed by reference cannot slip past.
 */
const FORBIDDEN = [
  ['a dynamic import()', /\bimport\s*\(/],
  ['an import or export statement', /^\s*(?:import|export)\b/m],
  ['require()', /\brequire\s*\(/],
  ['fetch', /\bfetch\w*/],
  ['XMLHttpRequest', /\bXMLHttpRequest\b/],
  ['navigator.sendBeacon', /\bsendBeacon\b/],
  ['WebSocket', /\bWebSocket\w*/],
  ['EventSource', /\bEventSource\b/],
  ['importScripts', /\bimportScripts\b/],
  ['a worker', /\b(?:Shared)?Worker\b/],
  ['a service worker', /\bserviceWorker\b/],
  ['a worklet', /Worklet\b|\baddModule\b/],
  ['eval', /\beval\b/],
  ['the Function constructor', /\bFunction\b/],
  ['a .constructor lookup', /\.\s*constructor\b|\[\s*["'`]constructor["'`]\s*\]/],
  ['a script element', /\bcreateElement(?:NS)?\s*\([^)]*["'`]script\b/i],
  ['an Image', /\bImage\b/],
  ['a timer given a string', /\bset(?:Timeout|Interval)\s*\(\s*["'`]/],
  [
    'markup parsed from a string',
    /\b(?:innerHTML|outerHTML|insertAdjacentHTML|createContextualFragment|setHTMLUnsafe|parseHTMLUnsafe)\b|\bdocument\s*\.\s*write(?:ln)?\b/,
  ],
  ['an absolute URL', /\b[a-z][a-z0-9+.-]*:\/\//i],
  ['a protocol-relative URL', /["'`]\/\//],
  ['a root-relative path', /["'`]\/(?![/*])[^"'`\s]/],
  ['a source map reference', /sourceMappingURL/],
];

function banner(client) {
  return `/* Papeleria ${client.name} client. Own code under Apache-2.0; see LICENSE and NOTICE.md. */`;
}

/** The first line of a reader bundle: which bytes are whose, and under which licence (D109). */
function engineBanner(client) {
  return (
    `/* Papeleria ${client.title}. Line 2 is ${PINS.npmPackage} ${PINS.npmVersion} (StPageFlip), byte for byte: ` +
    `MIT, see vendor/page-flip/LICENSE. The lines after it are Papeleria's own code under Apache-2.0; see LICENSE and NOTICE.md. */`
  );
}

/** How a reader bundle's first line starts, which `--scan` recognizes. */
const ENGINE_BANNER_START = '/* Papeleria comic reader';

/** A pattern that finds every match, where `scan` needs only the first. */
function everyMatch(pattern) {
  return new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
}

/**
 * Admits the engine's bytes (D101, D109): the pinned size and SHA-256, and
 * every match of every forbidden pattern inside a reviewed use of that kind,
 * each reviewed use present exactly once. Returns one message per problem.
 */
export function admitEngine(bytes, label) {
  const problems = [];
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (bytes.length !== PINS.file.bytes || sha256 !== PINS.file.sha256) {
    problems.push(`${label} is not the pinned engine: ${bytes.length} bytes with SHA-256 ${sha256}, where ${PINS.file.bytes} bytes with SHA-256 ${PINS.file.sha256} are pinned (D100)`);
    return problems;
  }
  const text = bytes.toString('utf8');
  const spans = [];
  for (const use of REVIEWED_USES) {
    const at = text.indexOf(use.code);
    if (at < 0 || text.indexOf(use.code, at + 1) >= 0) {
      problems.push(`${label} does not hold the reviewed use at ${use.source} exactly once (D101)`);
      continue;
    }
    spans.push({scan: use.scan, start: at, end: at + use.code.length});
  }
  for (const [name, pattern] of FORBIDDEN) {
    for (const match of text.matchAll(everyMatch(pattern))) {
      const start = match.index;
      const end = start + match[0].length;
      if (!spans.some((span) => span.scan === name && span.start <= start && end <= span.end)) {
        const line = text.slice(0, start).split('\n').length;
        problems.push(`${label}:${line} contains ${name} outside the uses reviewed in D101: ${JSON.stringify(match[0].trim())}`);
      }
    }
  }
  return problems;
}

/**
 * Scans a reader bundle in its three parts: the banner line, the engine
 * (admitted, not scanned as own code), then the own code (scanned as every
 * client is); and the whole file compiles as one classic script.
 */
function scanReader(bytes, label) {
  const newline = bytes.indexOf(0x0a);
  const engineEnd = newline + 1 + PINS.file.bytes;
  if (newline < 0 || bytes.length < engineEnd + 1 || bytes[engineEnd] !== 0x0a) {
    return [`${label} is not a reader bundle: a banner line, the ${PINS.file.bytes} bytes of the engine, then a newline and the reader`];
  }
  const head = bytes.subarray(0, newline).toString('utf8');
  const own = bytes.subarray(engineEnd + 1).toString('utf8');
  const problems = [];
  if (!/^\/\*[^\n]*\*\/$/.test(head) || head.slice(2, -2).includes('*/')) {
    problems.push(`${label}:1 is not a one-line comment`);
  }
  problems.push(...admitEngine(bytes.subarray(newline + 1, engineEnd), `${label} (the engine, line 2)`));
  // The own code starts on line 4: the banner, the engine, and the empty line its final newline and ours make.
  problems.push(...scan(own, `${label} (the reader's own code)`, false, 4));
  try {
    new vm.Script(bytes.toString('utf8'), {filename: label});
  } catch (error) {
    problems.push(`${label} does not compile as a classic script: ${error.message}`);
  }
  return problems;
}

/** Returns one message per problem; an empty array means the text is clean. */
function scan(text, label, compile = true, firstLine = 1) {
  const problems = [];
  for (const [name, pattern] of FORBIDDEN) {
    const match = pattern.exec(text);
    if (match !== null) {
      const line = firstLine - 1 + text.slice(0, match.index).split('\n').length;
      problems.push(`${label}:${line} contains ${name}: ${JSON.stringify(match[0].trim())}`);
    }
  }
  if (compile) {
    try {
      // Compiling as a classic script, without running it, rejects any module
      // syntax the patterns above might miss.
      new vm.Script(text, {filename: label});
    } catch (error) {
      problems.push(`${label} does not compile as a classic script: ${error.message}`);
    }
  }
  return problems;
}

/** The scan `--scan` runs on a file: a reader bundle in its parts, anything else as own code. */
function scanFile(bytes, label) {
  return bytes.subarray(0, ENGINE_BANNER_START.length).toString('utf8') === ENGINE_BANNER_START ? scanReader(bytes, label) : scan(bytes.toString('utf8'), label);
}

function report(problems) {
  for (const problem of problems) {
    console.error(`bundle-clients: ${problem}`);
  }
  return problems.length === 0;
}

async function bundle(client) {
  const engine = client.engine === true;
  const result = await build({
    absWorkingDir: root,
    ...(client.stdin === undefined
      ? {entryPoints: [client.entry]}
      : {stdin: {...client.stdin, resolveDir: root, loader: 'ts'}}),
    outfile: client.outfile,
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: TARGET,
    tsconfig: 'tsconfig.client.json',
    minify: false,
    sourcemap: false,
    // A reader bundle's banner is its first line, before the engine; the IIFE starts on the line after it.
    ...(engine ? {} : {banner: {js: banner(client)}}),
    metafile: true,
    logLevel: 'silent',
    // Kept in memory: the bundle reaches lib/clients/ only once it has been scanned (W5R-24).
    write: false,
  });
  const problems = [];
  if (result.warnings.length > 0) {
    const formatted = await formatMessages(result.warnings, {kind: 'warning'});
    problems.push(...formatted.map((message) => `esbuild warning while bundling ${client.entry ?? client.stdin.sourcefile}:\n${message}`));
  }
  keepMetafile(client.outfile, result.metafile);
  const inputs = Object.keys(result.metafile.inputs);
  for (const input of inputs) {
    if (!client.sources.some((prefix) => input.startsWith(prefix))) {
      problems.push(`${client.outfile} would contain ${input}, which is outside ${client.sources.join(', ')}`);
    }
  }
  const own = result.outputFiles.find((file) => file.path.endsWith('.js'));
  if (own === undefined) {
    throw new Error(`esbuild wrote no script for ${client.outfile}`);
  }
  const bytes = engine
    ? Buffer.concat([Buffer.from(`${engineBanner(client)}\n`), readFileSync(join(root, ENGINE_PATH)), Buffer.from('\n'), Buffer.from(own.contents)])
    : Buffer.from(own.contents);
  problems.push(...(engine ? scanReader(bytes, client.outfile) : scan(bytes.toString('utf8'), client.outfile)));
  const clean = report(problems);
  place(client.outfile, clean ? bytes : null);
  if (clean) {
    const parts = engine ? ` (the engine, ${PINS.file.bytes} bytes, admitted by its pin and the ${REVIEWED_USES.length} reviewed uses; own code scanned)` : '';
    console.log(`${client.outfile}: ${bytes.length} bytes from ${inputs.length} inputs${parts}; scan clean`);
    return true;
  }
  return false;
}

/**
 * Puts a scanned client where the pipeline copies it from (W5R-24): a clean
 * bundle through a temporary name beside it and a rename, so the file is never
 * seen half written; a refused one is never written, and an earlier build's
 * file of that name is removed, so a refused client leaves nothing a direct
 * CLI build could copy in its place.
 */
function place(outfile, bytes) {
  const target = join(root, outfile);
  if (bytes === null) {
    rmSync(target, {force: true});
    return;
  }
  mkdirSync(dirname(target), {recursive: true});
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, bytes);
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, {force: true});
  }
}

/** Keeps a bundle's esbuild metafile beside the build, where the package does not ship it (M5.3, D128). */
function keepMetafile(outfile, metafile) {
  const file = join(root, 'lib', 'metafiles', `${basename(outfile)}.json`);
  mkdirSync(dirname(file), {recursive: true});
  writeFileSync(file, `${JSON.stringify(metafile)}\n`);
}

/** The lockfile's package entries, to tell a production dependency from a development one. */
function lockedPackages() {
  return JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')).packages ?? {};
}

/** Why an input may not be in a tool bundle, or null when it may. */
function toolInputProblem(tool, input, locked) {
  const at = input.lastIndexOf('node_modules/');
  if (at < 0) {
    return tool.own.some((prefix) => input.startsWith(prefix)) ? null : `it is outside ${tool.own.join(', ')}`;
  }
  if (!tool.packages) {
    return 'this tool takes no third-party code';
  }
  const rest = input.slice(at + 'node_modules/'.length).split('/');
  const name = rest[0].startsWith('@') ? `${rest[0]}/${rest[1]}` : rest[0];
  const entry = locked[`${input.slice(0, at)}node_modules/${name}`];
  if (entry === undefined) {
    return `${name} is not in package-lock.json`;
  }
  return entry.dev === true ? `${name} is a development dependency` : null;
}

async function bundleTool(tool, locked) {
  const result = await build({
    absWorkingDir: root,
    entryPoints: [tool.entry],
    outfile: join(tool.outdir, tool.script),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: TARGET,
    tsconfig: 'tsconfig.client.json',
    minify: false,
    sourcemap: false,
    banner: {js: `/* Papeleria ${tool.name}: a tool page, never part of a published piece. Own code under Apache-2.0; bundled packages keep their own licences, which the npm package lists in THIRD_PARTY.md with their notices and keeps in licenses/packages/. */`},
    metafile: true,
    logLevel: 'silent',
    write: true,
  });
  const problems = [];
  if (result.warnings.length > 0) {
    const formatted = await formatMessages(result.warnings, {kind: 'warning'});
    problems.push(...formatted.map((message) => `esbuild warning while bundling ${tool.entry}:\n${message}`));
  }
  keepMetafile(tool.script, result.metafile);
  const inputs = Object.keys(result.metafile.inputs);
  for (const input of inputs) {
    const problem = toolInputProblem(tool, input, locked);
    if (problem !== null) {
      problems.push(`${tool.outdir}/${tool.script} would contain ${input}: ${problem}`);
    }
  }
  const file = join(tool.outdir, tool.script);
  const text = readFileSync(join(root, file), 'utf8');
  try {
    new vm.Script(text, {filename: file});
  } catch (error) {
    problems.push(`${file} does not compile as a classic script: ${error.message}`);
  }
  mkdirSync(join(root, tool.outdir), {recursive: true});
  for (const [source, name] of tool.copy) {
    copyFileSync(join(root, source), join(root, tool.outdir, name));
  }
  if (report(problems)) {
    const packages = new Set(inputs.filter((input) => input.includes('node_modules/')).map((input) => input.slice(input.lastIndexOf('node_modules/') + 13).split('/').slice(0, 2).join('/').replace(/^([^@][^/]*)\/.*$/, '$1')));
    console.log(`${file}: ${Buffer.byteLength(text)} bytes from ${inputs.length} inputs (${packages.size} packages); a tool page, not scanned as a published client`);
    return true;
  }
  return false;
}

async function main(argv) {
  if (argv[0] === '--scan') {
    const files = argv.slice(1);
    if (files.length === 0) {
      throw new UsageError('--scan needs at least one file');
    }
    let clean = true;
    for (const file of files) {
      const problems = scanFile(readFileSync(file), file);
      if (report(problems)) {
        console.log(`${file}: scan clean`);
      } else {
        clean = false;
      }
    }
    return clean ? 0 : 1;
  }
  if (argv.length > 0) {
    throw new UsageError(`unknown argument ${JSON.stringify(argv[0])}`);
  }
  let clean = true;
  for (const client of CLIENTS) {
    if (!(await bundle(client))) {
      clean = false;
    }
  }
  const locked = lockedPackages();
  for (const tool of TOOLS) {
    if (!(await bundleTool(tool, locked))) {
      clean = false;
    }
  }
  return clean ? 0 : 1;
}

/** Runs as a command; imported (by the tests, for `admitEngine`), it does nothing. */
function run() {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      if (error instanceof UsageError) {
        console.error(`bundle-clients: ${error.message}`);
        console.error(USAGE);
      } else if (Array.isArray(error?.errors) && error.errors.length > 0) {
        for (const message of error.errors) {
          const where = message.location ? `${message.location.file}:${message.location.line}: ` : '';
          console.error(`bundle-clients: ${where}${message.text}`);
        }
      } else {
        console.error(`bundle-clients: ${error?.message ?? String(error)}`);
      }
      process.exitCode = 2;
    },
  );
}

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href) {
  run();
}
