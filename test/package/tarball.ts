/**
 * M1.8 / DEP01: the npm tarball, installed for production in an empty folder,
 * makes, builds and checks a deck on its own (D68).
 *
 * `npm pack` writes the tarball; `npm install --omit=dev` installs it with
 * its dependencies from the registry, so this needs the network and runs as
 * `npm run test:package`, never inside `npm test`: its compiled name,
 * `lib/test/package/tarball.js`, does not end in `.test.js`, so `npm test`'s
 * glob never matches it. The installed CLI is started through npm's `.bin`
 * link, as a user's shell starts it. From M2.6 (W3A), `edit` and `serve`
 * start from the installed package, serve their pages from it, and stop on
 * Ctrl C. From M3.7 (W3B), `new document` makes a report there too, and
 * from M4.8 (W4) `new comic` a comic whose one script is reader.js, with the
 * page-turn engine's licence beside it, so all three templates are proved.
 * From M5.3 (W5B, D127, D128) the tarball carries every notice and licence
 * text byte for byte, and every sample, code and theme tree whole, and each
 * template's dist/ from the installed CLI carries a THIRD_PARTY.md that
 * `scripts/gen-notice.mjs --dist` finds current.
 * From M5.5 (W5D, D140) the pack and the installation are the shared flow in
 * `test/helpers/tarball.ts`, which the browser smoke uses too; the four
 * examples are checked and built by the installed CLI, and the tarball's
 * size, the installation's footprint and the versions it resolved are
 * recorded for the release inventory.
 */
import assert from 'node:assert/strict';
import {cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync} from 'node:fs';
import {basename, join} from 'node:path';
import {after, before, test} from 'node:test';
import {pathToFileURL} from 'node:url';

import {pngSource} from '../fixtures/images/generate.js';
import {NOTICE_EXAMPLES, assertNoticeCurrent, assertNoticeFiles, assertThirdParty, distFiles} from '../helpers/notices.js';
import {applicationRoot, scriptPath} from '../helpers/paths.js';
import {EDIT_READY, SERVE_READY, footprint, get, packAndInstall, redeem, run, startInstalled, type Installation, type Packed, type Run} from '../helpers/tarball.js';

let installation: Installation;
let install = '';
let packed: Packed;

/** Every regular file under a folder of the application root, by its forward-slash path from the root; macOS metadata left out, as npm leaves it out. */
function repositoryFiles(relative: string): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(join(applicationRoot, directory), {withFileTypes: true})) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name !== '.DS_Store') found.push(path);
    }
  };
  walk(relative);
  return found.sort();
}

/** M5.3: the repository's gen-notice, run on a dist/ the installed CLI wrote, must find its THIRD_PARTY.md current. */
async function noticeIsCurrent(dist: string): Promise<void> {
  const checked = await run(process.execPath, [join(applicationRoot, 'scripts', 'gen-notice.mjs'), '--dist', dist, '--check'], applicationRoot);
  assert.equal(checked.code, 0, checked.stdout + checked.stderr);
}

/** The installed CLI, started through npm's link the way a shell starts it. */
function papeleria(args: readonly string[]): Promise<Run> {
  return installation.cli(args);
}

before(async () => {
  installation = await packAndInstall('tarball');
  install = installation.install;
  packed = installation.packed;
});

after(() => installation?.remove());

test('D68: the tarball holds what the inventory lists and nothing it excludes', () => {
  const files = packed.files.map((file) => file.path);
  for (const required of [
    'package.json',
    'LICENSE',
    'NOTICE.md',
    'TRADEMARKS.md',
    'lib/src/cli/index.js',
    'lib/src/build/pipeline.js',
    'lib/src/checks/rules/R08.js',
    'lib/templates/deck/render.js',
    'lib/templates/shared/blocks.js',
    'lib/clients/deck.js',
    'lib/clients/deck-preview.js',
    'lib/clients/document-preview.js',
    'lib/clients/editor/index.html',
    'lib/clients/editor/editor.js',
    'lib/clients/editor/editor.css',
    'lib/clients/serve/index.html',
    'lib/clients/serve/serve.js',
    'lib/clients/serve/serve.css',
    'lib/src/server/index.js',
    'theme/css/site.css',
    'theme/css/fonts.css',
    'templates/shared/strings.en.json',
    'templates/shared/strings.es.json',
    'templates/shared/schema-defs.json',
    'templates/shared/base.css',
    'templates/deck/schema.json',
    'templates/deck/sample/papeleria.yaml',
    'lib/templates/document/render.js',
    'lib/src/core/video.js',
    'lib/src/checks/rules/R16.js',
    'templates/document/schema.json',
    'templates/document/sample/papeleria.yaml',
    'templates/document/sample/assets/text/summary.md',
    'templates/document/sample/assets/data/hours-by-phase.csv',
    'templates/document/sample/assets/data/hours-by-week.csv',
    'lib/templates/comic/render.js',
    'lib/src/checks/rules/R14.js',
    'lib/src/build/originals.js',
    'lib/clients/reader.js',
    'lib/clients/reader-preview.js',
    'templates/comic/schema.json',
    'templates/comic/comic.css',
    'templates/comic/sample/papeleria.yaml',
    'templates/comic/sample/assets/text/gull-note.md',
    'templates/comic/sample/assets/images/pages/01.png',
    'templates/comic/sample/assets/images/pages/08.png',
    'vendor/page-flip/LICENSE',
    'vendor/page-flip/page-flip.browser.js',
    'theme/css/print.css',
    'theme/css/slides.css',
    'theme/fonts/Inter-OFL.txt',
    'theme/marks/papeleria-favicon.svg',
    'npm-shrinkwrap.json',
  ]) {
    assert.ok(files.includes(required), `${required} is missing from the tarball`);
  }
  assert.equal(files.filter((file) => /^theme\/fonts\/.+\.woff2$/.test(file)).length, 8);
  const forbidden = /^(?:brand|docs|blueprint|reference|examples|src|test|scripts|theme\/js|lib\/test|lib\/browser-tests|lib\/scripts|lib\/templates\/[^/]+\/client)\//;
  assert.deepEqual(files.filter((file) => forbidden.test(file)), []);
  assert.ok(!files.some((file) => /(?:^|\/)(?:dist|\.papeleria|node_modules)\//.test(file)));
});

test('M5.3 (DEP06, A11): every notice and licence text, byte for byte, and the samples, code and theme whole; nothing else', () => {
  const files = new Set(packed.files.map((file) => file.path));
  const installed = join(install, 'node_modules', 'papeleria');
  const same = (path: string): void => {
    assert.ok(files.has(path), `${path} is in the tarball`);
    assert.ok(readFileSync(join(installed, ...path.split('/'))).equals(readFileSync(join(applicationRoot, ...path.split('/')))), `${path}, byte for byte`);
  };
  for (const notice of ['LICENSE', 'NOTICE.md', 'TRADEMARKS.md', 'THIRD_PARTY.md', 'theme/fonts/Poppins-OFL.txt', 'theme/fonts/Inter-OFL.txt', 'vendor/page-flip/LICENSE']) {
    same(notice);
  }
  // Whole trees, shipped exactly: every licence text with its index, templates/ with each sample, the theme but its kit scripts (D68),
  // the vendored engine, and the built code, lib/templates/ without the tests' client halves (D68).
  const shipped = (prefix: string): string[] => [...files].filter((path) => path.startsWith(prefix)).sort();
  const licences = repositoryFiles('licenses');
  const templates = repositoryFiles('templates');
  const theme = repositoryFiles('theme').filter((path) => !path.startsWith('theme/js/'));
  const vendor = repositoryFiles('vendor');
  // The source maps point at TypeScript the package does not ship, so they stay out too (D176).
  const built = [...repositoryFiles('lib/clients'), ...repositoryFiles('lib/src'), ...repositoryFiles('lib/templates').filter((path) => !/^lib\/templates\/[^/]+\/client\//.test(path))]
    .filter((path) => !path.endsWith('.map'))
    .sort();
  assert.deepEqual(shipped('licenses/'), licences, 'licenses/ is shipped exactly');
  assert.deepEqual(shipped('templates/'), templates, 'templates/ is shipped exactly');
  assert.deepEqual(shipped('theme/'), theme, 'theme/ is shipped without theme/js/');
  assert.deepEqual(shipped('vendor/'), vendor, 'vendor/ is shipped exactly');
  assert.deepEqual(shipped('lib/'), built, 'lib/ is shipped as lib/clients/, lib/src/ and lib/templates/ without the client halves or the source maps');
  assert.ok(built.some((path) => path.endsWith('.d.ts')), 'the declarations ship');
  for (const path of [...licences, ...theme, ...vendor, ...templates.filter((path) => /^templates\/[^/]+\/sample\//.test(path)), 'lib/clients/deck.js', 'lib/clients/reader.js']) {
    same(path);
  }
  assert.deepEqual(
    [...new Set(templates.filter((path) => /^templates\/[^/]+\/sample\//.test(path)).map((path) => path.split('/')[1]))].sort(),
    ['comic', 'deck', 'document'],
    'each template’s sample ships',
  );
  const index = JSON.parse(readFileSync(join(installed, 'licenses', 'index.json'), 'utf8')) as {licenses: {file: string}[]; packages: {file: string}[]};
  assert.equal(index.licenses.length, 14);
  assert.ok(index.packages.length > 0);
  for (const entry of [...index.licenses, ...index.packages]) {
    assert.ok(files.has(`licenses/${entry.file}`), `licenses/${entry.file}, which the index names, is in the tarball`);
  }
  // Nothing else: the top level is these six files, and every other file is in one of the trees above.
  const topLevel = [...files].filter((path) => !path.includes('/')).sort();
  assert.deepEqual(topLevel, ['LICENSE', 'NOTICE.md', 'README.md', 'THIRD_PARTY.md', 'TRADEMARKS.md', 'npm-shrinkwrap.json', 'package.json']);
  // The shrinkwrap is the repository's lockfile, byte for byte, written only for the pack (D196).
  assert.ok(readFileSync(join(installed, 'npm-shrinkwrap.json')).equals(readFileSync(join(applicationRoot, 'package-lock.json'))), 'npm-shrinkwrap.json is package-lock.json');
  assert.equal(existsSync(join(applicationRoot, 'npm-shrinkwrap.json')), false, 'and the pack took it away again');
  assert.equal(files.size, topLevel.length + licences.length + templates.length + theme.length + vendor.length + built.length);
  const excluded = /^(?:reference|examples|test|brand|scripts|src|blueprint|docs|marketing|lib\/test|lib\/browser-tests|lib\/scripts)\//;
  assert.deepEqual([...files].filter((path) => excluded.test(path)), []);
});

test('DEP01: the installed CLI reports its version through the npm link', {timeout: 60_000}, async () => {
  const version = await papeleria(['--version']);
  assert.deepEqual([version.code, version.stdout, version.stderr], [0, '0.1.0\n', '']);
});

test('M1.8: new, build and check from the installed tarball give a self-contained deck', {timeout: 300_000}, async () => {
  const made = await papeleria(['new', 'test-deck']);
  assert.equal(made.code, 2, 'new needs a template and a folder');
  assert.equal((await papeleria(['new', 'deck', 'test-deck'])).code, 0);

  const built = await papeleria(['build', 'test-deck']);
  assert.equal(built.code, 0, built.stderr);
  assert.match(built.stderr, /Built test-deck\/dist · 0 errors/);
  const dist = join(install, 'test-deck', 'dist');
  const files = readdirSync(dist).sort();
  assert.deepEqual(files, ['Inter-OFL.txt', 'LICENSE', 'NOTICE.md', 'Poppins-OFL.txt', 'THIRD_PARTY.md', 'deck.js', 'index.html', 'theme']);
  const installed = join(install, 'node_modules', 'papeleria');
  assert.ok(readFileSync(join(dist, 'LICENSE')).equals(readFileSync(join(installed, 'LICENSE'))));
  assert.ok(readFileSync(join(dist, 'NOTICE.md')).equals(readFileSync(join(installed, 'NOTICE.md'))));
  assert.ok(readFileSync(join(dist, 'deck.js')).equals(readFileSync(join(installed, 'lib', 'clients', 'deck.js'))));
  const thirdParty = readFileSync(join(dist, 'THIRD_PARTY.md'), 'utf8');
  assert.match(thirdParty, /^# Third-party components in this piece\n\nWritten by Papeleria \S+ from the files in this folder\./);
  assert.match(thirdParty, /\| Poppins \| .* \| `Poppins-OFL\.txt` \|\n\| Inter \| .* \| `Inter-OFL\.txt` \|\n$/);
  assert.doesNotMatch(thirdParty, /StPageFlip/, 'a deck carries no engine');
  await noticeIsCurrent(dist);
  assert.equal(existsSync(join(dist, 'theme', 'js')), false);

  const html = readFileSync(join(dist, 'index.html'), 'utf8');
  const executable = [...html.matchAll(/<script\b([^>]*)>/g)].filter((match) => !match[1]!.includes('application/json'));
  assert.deepEqual(executable.map((match) => match[1]), [' src="deck.js" defer']);
  for (const match of html.matchAll(/\s(src|href)="([^"#][^"]*)"/g)) {
    const url = match[2]!;
    if (match[1] === 'href' && /^(?:https?|mailto|tel):/.test(url)) {
      continue;
    }
    assert.doesNotMatch(url, /^(?:[a-z][a-z0-9+.-]*:|\/)/i, `${url} is relative`);
    assert.ok(existsSync(join(dist, url)), `${url} is in dist/`);
  }

  const checked = await papeleria(['check', 'test-deck', '--json']);
  assert.equal(checked.code, 0, checked.stderr);
  const report = JSON.parse(checked.stdout) as {status: string; errors: number; outputReason: string};
  assert.deepEqual([report.status, report.errors, report.outputReason], ['ok', 0, 'check_only']);

  const missing = await papeleria(['check', 'no-such-deck', '--json']);
  assert.equal(missing.code, 2);
  assert.equal((JSON.parse(missing.stdout) as {errorCode: string}).errorCode, 'E_PIECE_FOLDER');

  const manifest = join(install, 'test-deck', 'papeleria.yaml');
  const original = readFileSync(manifest, 'utf8');
  writeFileSync(manifest, original.replace('layout: statement', 'layout: poster'));
  const failing = await papeleria(['check', 'test-deck', '--json']);
  assert.equal(failing.code, 1);
  assert.equal((JSON.parse(failing.stdout) as {status: string}).status, 'failed');
  writeFileSync(manifest, original);
});

test('M3.7: new document, build and check from the installed tarball give a self-contained report with no script', {timeout: 300_000}, async () => {
  assert.equal((await papeleria(['new', 'document', 'test-report'])).code, 0);
  const built = await papeleria(['build', 'test-report']);
  assert.equal(built.code, 0, built.stderr);
  assert.match(built.stderr, /Built test-report\/dist · 0 errors · 0 warnings/);
  const dist = join(install, 'test-report', 'dist');
  assert.deepEqual(readdirSync(dist).sort(), ['Inter-OFL.txt', 'LICENSE', 'NOTICE.md', 'Poppins-OFL.txt', 'THIRD_PARTY.md', 'index.html', 'theme']);
  const thirdParty = readFileSync(join(dist, 'THIRD_PARTY.md'), 'utf8');
  assert.match(thirdParty, /Papeleria’s own code, including the page and the stylesheets, is under the Apache License 2\.0/);
  assert.doesNotMatch(thirdParty, /StPageFlip/);
  await noticeIsCurrent(dist);
  const html = readFileSync(join(dist, 'index.html'), 'utf8');
  assert.doesNotMatch(html, /<script\b/i, 'a published document has no script (C22)');
  for (const match of html.matchAll(/\s(src|href)="([^"#][^"]*)"/g)) {
    assert.doesNotMatch(match[2]!, /^(?:[a-z][a-z0-9+.-]*:|\/)/i, `${match[2]} is relative`);
    assert.ok(existsSync(join(dist, match[2]!)), `${match[2]} is in dist/`);
  }
  const checked = await papeleria(['check', 'test-report', '--json']);
  assert.equal(checked.code, 0, checked.stderr);
  const report = JSON.parse(checked.stdout) as {status: string; errors: number; warnings: number; outputReason: string};
  assert.deepEqual([report.status, report.errors, report.warnings, report.outputReason], ['ok', 0, 0, 'check_only']);
});

test('M4.8: new comic, build and check from the installed tarball give a self-contained comic whose one script is reader.js', {timeout: 300_000}, async () => {
  assert.equal((await papeleria(['new', 'comic', 'test-comic'])).code, 0);
  const built = await papeleria(['build', 'test-comic']);
  assert.equal(built.code, 0, built.stderr);
  assert.match(built.stderr, /Built test-comic\/dist · 0 errors · 0 warnings · first view [\d,]+ bytes · largest phone image [\d,]+ of 307,200 bytes/);
  const dist = join(install, 'test-comic', 'dist');
  assert.deepEqual(readdirSync(dist).sort(), ['Inter-OFL.txt', 'LICENSE', 'NOTICE.md', 'Poppins-OFL.txt', 'THIRD_PARTY.md', 'assets', 'index.html', 'reader.js', 'theme', 'vendor']);
  const installed = join(install, 'node_modules', 'papeleria');
  assert.ok(readFileSync(join(dist, 'reader.js')).equals(readFileSync(join(installed, 'lib', 'clients', 'reader.js'))));
  assert.ok(readFileSync(join(dist, 'vendor', 'page-flip', 'LICENSE')).equals(readFileSync(join(installed, 'vendor', 'page-flip', 'LICENSE'))));
  assert.match(
    readFileSync(join(dist, 'THIRD_PARTY.md'), 'utf8'),
    /\| StPageFlip 2\.0\.7 \| line 2 of `reader\.js`, byte for byte, and the four layout rules `theme\/css\/comic\.css` restates from it \| MIT \| Copyright \(c\) 2020 Nodlik \| `vendor\/page-flip\/LICENSE` \|/,
  );
  await noticeIsCurrent(dist);
  const html = readFileSync(join(dist, 'index.html'), 'utf8');
  const executable = [...html.matchAll(/<script\b([^>]*)>/g)].map((match) => match[1]!).filter((attributes) => !attributes.includes('type="application/json"'));
  assert.deepEqual(executable, [' src="reader.js" defer'], 'one classic script (C22)');
  for (const match of html.matchAll(/\s(src|href)="([^"#][^"]*)"/g)) {
    if (/^(?:https?|mailto|tel):/.test(match[2]!)) {
      continue;
    }
    assert.doesNotMatch(match[2]!, /^(?:[a-z][a-z0-9+.-]*:|\/)/i, `${match[2]} is relative`);
    assert.ok(existsSync(join(dist, match[2]!)), `${match[2]} is in dist/`);
  }
  const checked = await papeleria(['check', 'test-comic', '--json']);
  assert.equal(checked.code, 0, checked.stderr);
  const report = JSON.parse(checked.stdout) as {status: string; errors: number; warnings: number; outputReason: string};
  assert.deepEqual([report.status, report.errors, report.warnings, report.outputReason], ['ok', 0, 0, 'check_only']);
});

test('DEP01: sharp and html-validate work in the production install', {timeout: 300_000}, async () => {
  const piece = join(install, 'test-deck');
  mkdirSync(join(piece, 'assets', 'images'), {recursive: true});
  writeFileSync(join(piece, 'assets', 'images', 'photo.png'), await pngSource(1700, 900));
  const manifest = join(piece, 'papeleria.yaml');
  writeFileSync(
    manifest,
    `${readFileSync(manifest, 'utf8')}\n  - layout: image\n    title: A picture\n    image: {src: assets/images/photo.png, alt: A gradient, credit: Test, rights: Test}\n`,
  );
  const built = await papeleria(['build', 'test-deck']);
  assert.equal(built.code, 0, built.stderr);
  const images = readdirSync(join(piece, 'dist', 'assets', 'images'));
  assert.ok(images.some((name) => name.endsWith('.webp')), images.join(', '));

  const probe = [
    `const scan = await import(${JSON.stringify(pathToFileURL(join(install, 'node_modules', 'papeleria', 'lib', 'src', 'checks', 'html-scan.js')).href)});`,
    "const messages = await scan.validatePage('<!DOCTYPE html><html lang=\"en\"><head><title>x</title></head><body><p><div>x</div></p></body></html>', {files: [], script: null});",
    'process.stdout.write(JSON.stringify(messages.map((message) => message.rule)));',
  ].join('\n');
  const validated = await run(process.execPath, ['--input-type=module', '-e', probe], install);
  assert.equal(validated.code, 0, validated.stderr);
  assert.ok((JSON.parse(validated.stdout) as string[]).length > 0, 'html-validate reports the broken page');
});

test('M2.6: edit and serve start from the installed tarball, serve their pages, and stop on Ctrl C', {timeout: 120_000}, async () => {
  const edit = await startInstalled(installation, ['edit', 'test-deck'], EDIT_READY);
  const [, editorOrigin, launchToken] = edit.match;
  try {
    const page = await get(`${editorOrigin}/`);
    assert.equal(page.status, 200);
    assert.match(page.type, /^text\/html/);
    assert.equal((await get(`${editorOrigin}/editor.js`)).status, 200);
    assert.equal((await get(`${editorOrigin}/theme/css/site.css`)).status, 200);
    // The launch token opens the session once, for the session token the API needs (D192).
    const piece = await get(`${editorOrigin}/api/piece`, await redeem(editorOrigin!, launchToken!));
    assert.equal(piece.status, 200, piece.body);
    assert.deepEqual(Object.keys((JSON.parse(piece.body) as {schemas: Record<string, unknown>}).schemas).sort(), ['comic', 'deck', 'document']);
  } finally {
    const stopped = await edit.stop();
    assert.equal(stopped.code, 0, stopped.stderr);
    assert.match(stopped.stderr, /Stopped\. The preview files were removed\.\n$/);
  }

  const serve = await startInstalled(installation, ['serve', 'test-deck'], SERVE_READY);
  try {
    const shell = await get(`${serve.match[1]}/`);
    assert.equal(shell.status, 200);
    assert.equal((await get(`${serve.match[1]}/serve.js`)).status, 200);
  } finally {
    const stopped = await serve.stop();
    assert.equal(stopped.code, 0, stopped.stderr);
    assert.equal(existsSync(join(install, 'test-deck', '.papeleria', 'preview')) ? readdirSync(join(install, 'test-deck', '.papeleria', 'preview')).length : 0, 0);
  }
});

/** The package a lockfile path names: what follows its last `node_modules/`. */
function packageName(path: string): string {
  return path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
}

test('M5.5: the four examples check and build with zero errors and no warning from the installed CLI, and carry their notices (A7, A11, D139)', {timeout: 600_000}, async (context) => {
  const examples = join(installation.workspace, 'examples');
  cpSync(join(applicationRoot, 'examples'), examples, {recursive: true, filter: (path) => !['dist', '.papeleria'].includes(basename(path))});
  const result = await run(process.execPath, [scriptPath('build-examples.mjs'), '--examples', examples, '--cli', installation.bin], install);
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /^examples: starter-deck built; brand-overview built; hours-report built; sample-comic built$/m);
  assert.match(
    result.stdout,
    /^checks: starter-deck 0 errors, 0 warnings; brand-overview 0 errors, 0 warnings; hours-report 0 errors, 0 warnings; sample-comic 0 errors, 0 warnings$/m,
  );
  const reports = result.stderr.split('\n').filter((line) => line.startsWith('Built '));
  assert.equal(reports.length, 4, result.stderr);
  for (const report of reports) {
    assert.match(report, / · 0 errors · 0 warnings · first view [\d,]+ /);
    context.diagnostic(report.replace(`${examples}/`, 'examples/'));
  }
  for (const name of ['starter-deck', 'brand-overview', 'hours-report', 'sample-comic']) {
    assert.ok(existsSync(join(examples, name, 'dist', 'index.html')), `${name} was built by the installed CLI`);
  }
  // W5B's notice checks (test/helpers/notices.ts), on what the installed CLI wrote.
  for (const example of NOTICE_EXAMPLES) {
    const dist = join(examples, example.name, 'dist');
    const files = distFiles(dist);
    assertNoticeFiles(dist, files, example);
    assertThirdParty(dist, files, example);
    await assertNoticeCurrent(dist);
  }
});

test('M5.5: the release tarball, the production installation and the versions it resolved, for the inventory', async (context) => {
  const version = (JSON.parse(readFileSync(join(applicationRoot, 'package.json'), 'utf8')) as {version: string}).version;
  assert.equal(packed.filename, `papeleria-${version}.tgz`);
  assert.equal(packed.entryCount, packed.files.length);
  assert.equal((JSON.parse(readFileSync(join(installation.packageRoot, 'package.json'), 'utf8')) as {version: string}).version, version);

  type Lock = {packages: Record<string, {version?: string; dev?: boolean}>};
  // The installation's lockfile also records the optional packages of other
  // platforms, which npm does not install here: only what is on disk counts.
  const installedLock = JSON.parse(readFileSync(join(install, 'package-lock.json'), 'utf8')) as Lock;
  const installed = Object.entries(installedLock.packages)
    .filter(([path]) => path.startsWith('node_modules/') && existsSync(join(install, path, 'package.json')))
    .map(([path, entry]) => `${packageName(path)}@${entry.version ?? '?'}`);
  const repositoryLock = JSON.parse(readFileSync(join(applicationRoot, 'package-lock.json'), 'utf8')) as Lock;
  const locked = new Set(
    Object.entries(repositoryLock.packages)
      .filter(([path, entry]) => path.startsWith('node_modules/') && entry.dev !== true)
      .map(([path, entry]) => `${packageName(path)}@${entry.version ?? '?'}`),
  );
  // The package carries npm-shrinkwrap.json and is installed as from the
  // registry (test/helpers/tarball.ts), so npm installs the locked tree and no
  // range: every installed package is one the lockfile locks, at its version,
  // the tree the suites ran and the native reviews read (D196).
  const drift = installed.filter((name) => !name.startsWith('papeleria@') && !locked.has(name));
  const modules = footprint(join(install, 'node_modules'));
  // The toolchain this proof ran on, for the release inventory (D02, issue 002 E2).
  const npmVersion = (await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['--version'], install)).stdout.trim();
  context.diagnostic(`toolchain: Node ${process.version}, npm ${npmVersion}, ${process.platform} ${process.arch}`);
  context.diagnostic(
    `tarball ${packed.filename}: ${packed.size} bytes, SHA-256 ${installation.sha256}, ${packed.integrity}; ${packed.entryCount} files, ${packed.unpackedSize} bytes unpacked`,
  );
  context.diagnostic(`installed with --omit=dev: ${installed.length} packages; node_modules/ holds ${modules.files} files, ${modules.bytes} bytes`);
  context.diagnostic(`native packages installed here: ${installed.filter((name) => name.startsWith('@img/') || name.startsWith('sharp@')).join(', ')}`);
  context.diagnostic(
    drift.length === 0
      ? 'every installed package is at a version package-lock.json locks'
      : `installed at a version package-lock.json does not lock: ${drift.join(', ')}`,
  );
  assert.ok(installed.some((name) => name.startsWith('sharp@')), 'sharp is installed');
  assert.deepEqual(drift, [], 'the installation is the locked tree (D196)');
});
