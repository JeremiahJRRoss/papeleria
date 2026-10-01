/**
 * The notices a generated dist/ carries (M5.3, D127), as one set of checks.
 * W5B's `test/integration/output-notices.test.ts` runs them on the four
 * examples the compiled CLI builds; the tarball proof runs them on the four
 * the installed CLI builds (M5.5, D140), so the release proof reads the
 * notices a user's installation writes, not only the repository's.
 */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

import {applicationRoot, runNode, scriptPath} from './paths.js';
import {readTree} from './pieces.js';

/** The four examples, and what each dist/ must say about third-party components. */
export const NOTICE_EXAMPLES = [
  {name: 'starter-deck', script: 'deck.js', engine: false},
  {name: 'brand-overview', script: 'deck.js', engine: false},
  {name: 'hours-report', script: null, engine: false},
  {name: 'sample-comic', script: 'reader.js', engine: true},
] as const;

export type NoticeExample = (typeof NOTICE_EXAMPLES)[number];

/** D62, D108: the notices at a dist/'s root, and where the tool keeps each. */
export const NOTICES: readonly (readonly [string, string])[] = [
  ['LICENSE', 'LICENSE'],
  ['NOTICE.md', 'NOTICE.md'],
  ['Poppins-OFL.txt', 'theme/fonts/Poppins-OFL.txt'],
  ['Inter-OFL.txt', 'theme/fonts/Inter-OFL.txt'],
];

/** The copyright notices of a licence text (a year follows the word, unlike "Copyright Holder" in the terms), as the notice quotes them. */
export function copyrightLines(relative: string): string {
  const lines = readFileSync(join(applicationRoot, relative), 'utf8').split('\n').map((candidate) => candidate.trim()).filter((candidate) => /^Copyright (?:\(c\) )?\d{4}/.test(candidate));
  assert.ok(lines.length > 0, `${relative} has a copyright line`);
  return lines.join('; ');
}

/** The component rows of a dist THIRD_PARTY.md: name, where, licence, copyright, text. */
export function thirdPartyRows(text: string): string[][] {
  return text
    .split('\n')
    .filter((line) => line.startsWith('| ') && !line.startsWith('| Component') && !line.startsWith('| ---'))
    .map((line) => line.slice(2, -2).split(' | '));
}

/** Every file in a dist/, by its forward-slash path, sorted. */
export function distFiles(dist: string): string[] {
  return Object.keys(readTree(dist)).sort();
}

/** Papeleria's LICENSE, the maintained NOTICE.md and both font OFL texts, byte for byte; the engine's licence only beside the engine. */
export function assertNoticeFiles(dist: string, files: readonly string[], example: NoticeExample): void {
  for (const [output, source] of NOTICES) {
    assert.ok(files.includes(output), `${example.name}: ${output} is in dist/`);
    assert.ok(readFileSync(join(dist, output)).equals(readFileSync(join(applicationRoot, source))), `${example.name}: ${output} is ${source}, byte for byte`);
  }
  assert.ok(files.includes('THIRD_PARTY.md'), `${example.name}: THIRD_PARTY.md is in dist/`);
  if (example.engine) {
    assert.ok(readFileSync(join(dist, 'vendor', 'page-flip', 'LICENSE')).equals(readFileSync(join(applicationRoot, 'vendor', 'page-flip', 'LICENSE'))), `${example.name}: the engine’s MIT licence travels with it (D108)`);
  } else {
    assert.ok(!files.some((file) => file.startsWith('vendor/')), `${example.name}: no engine, so no engine licence`);
  }
  assert.ok(!files.some((file) => file.startsWith('licenses/')), `${example.name}: the package’s licence texts are the package’s, not a piece’s`);
}

/** THIRD_PARTY.md names what the folder holds and nothing else, written by this version of Papeleria. */
export function assertThirdParty(dist: string, files: readonly string[], example: NoticeExample): void {
  const text = readFileSync(join(dist, 'THIRD_PARTY.md'), 'utf8');
  const version = (JSON.parse(readFileSync(join(applicationRoot, 'package.json'), 'utf8')) as {version: string}).version;
  assert.ok(text.startsWith(`# Third-party components in this piece\n\nWritten by Papeleria ${version} from the files in this folder.`), `${example.name}: ${text.slice(0, 200)}`);
  const ownCode = example.script === 'reader.js' ? 'the page, the reader in `reader.js` and the stylesheets' : example.script === 'deck.js' ? 'the page, `deck.js` and the stylesheets' : 'the page and the stylesheets';
  assert.ok(text.includes(`Papeleria’s own code, including ${ownCode}, is under the Apache License 2.0 in \`LICENSE\``), text.slice(0, 400));
  assert.match(text, /no chart library ships here/);

  const found = thirdPartyRows(text);
  assert.deepEqual(found.map((row) => row[0]), example.engine ? ['Poppins', 'Inter', 'StPageFlip 2.0.7'] : ['Poppins', 'Inter']);
  const byName = new Map(found.map((row) => [row[0]!, row]));
  assert.deepEqual(byName.get('Poppins')!.slice(2), ['SIL Open Font License 1.1 (OFL-1.1)', copyrightLines('theme/fonts/Poppins-OFL.txt'), '`Poppins-OFL.txt`']);
  assert.deepEqual(byName.get('Inter')!.slice(2), ['SIL Open Font License 1.1 (OFL-1.1)', copyrightLines('theme/fonts/Inter-OFL.txt'), '`Inter-OFL.txt`']);
  if (example.engine) {
    assert.deepEqual(byName.get('StPageFlip 2.0.7'), [
      'StPageFlip 2.0.7',
      'line 2 of `reader.js`, byte for byte, and the four layout rules `theme/css/comic.css` restates from it',
      'MIT',
      copyrightLines('vendor/page-flip/LICENSE'),
      '`vendor/page-flip/LICENSE`',
    ]);
  } else {
    assert.doesNotMatch(text, /StPageFlip|page-flip/);
  }
  // Every path a row names is a file in this folder.
  for (const row of found) {
    for (const match of `${row[1]} ${row[4]}`.matchAll(/`([^`]+)`/g)) {
      assert.ok(files.includes(match[1]!), `${example.name}: ${match[1]} (named in THIRD_PARTY.md) is in dist/`);
    }
  }
  const fontsHere = files.filter((file) => file.startsWith('theme/fonts/') && file.endsWith('.woff2'));
  assert.equal(fontsHere.length, 8);
  for (const font of fontsHere) {
    assert.ok(text.includes(`\`${font}\``), `${example.name}: ${font} is attributed`);
  }
}

/** The repository's `gen-notice --dist` finds the folder's THIRD_PARTY.md current. */
export async function assertNoticeCurrent(dist: string): Promise<void> {
  const checked = await runNode(scriptPath('gen-notice.mjs'), ['--dist', dist, '--check']);
  assert.equal(checked.code, 0, checked.stdout + checked.stderr);
}
