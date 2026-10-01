/**
 * M3.5 and M3.6: the print fixture catalog (test/fixtures/print/cases.json)
 * holds what exists. Every case names a piece that is there and whose
 * manifest is valid against its template's schema; every case resolves with
 * no finding once the files its tests make are added; and, since every
 * template renders from M4 (W4), none is pending.
 */
import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';

import {createMemoryLoaders, parseManifest, readPiece, validateManifest} from '../../src/core/index.js';
import {templateBuild} from '../../src/build/templates.js';
import {applicationRoot} from '../helpers/paths.js';
import {readTree} from '../helpers/pieces.js';
import {generatedFiles, readPrintCases} from '../helpers/print-cases.js';

const CASES = readPrintCases();

test('every print case names a piece that is there, valid against its template', () => {
  for (const [template, cases] of Object.entries(CASES)) {
    assert.ok(cases.length > 0, template);
    for (const each of cases) {
      const manifest = join(applicationRoot, each.piece, 'papeleria.yaml');
      assert.ok(existsSync(manifest), `${each.name}: ${each.piece} has no manifest`);
      const loaded = parseManifest(readFileSync(manifest, 'utf8'), 'papeleria.yaml');
      assert.deepEqual(loaded.findings, [], each.name);
      const validated = validateManifest(loaded.manifest!);
      assert.deepEqual(validated.findings.map((item) => item.finding.message), [], each.name);
      assert.equal(validated.manifest?.template, template, `${each.name} is a ${template}`);
    }
  }
});

test('every template renders from M4, so no case is pending, and every case resolves with no finding', async () => {
  for (const [template, cases] of Object.entries(CASES)) {
    assert.equal(typeof templateBuild(template as 'deck' | 'document' | 'comic').render, 'function', `the ${template} template renders`);
    for (const each of cases) {
      assert.equal(each.pending, undefined, `${each.name} is pending, but its template renders`);
      const entries = {...readTree(join(applicationRoot, each.piece)), ...(await generatedFiles(each))};
      const {piece, findings} = await readPiece({loaders: createMemoryLoaders(entries)});
      assert.deepEqual(findings, [], each.name);
      assert.equal(piece?.template, template, each.name);
    }
  }
});

test('IC08: the release fixtures are all there, the comic one included', () => {
  assert.deepEqual(
    CASES.document.map((each) => each.name),
    ['seeded-report', 'long-section', 'long-table', 'tall-image', 'long-headings', 'every-block'],
  );
  assert.deepEqual(CASES.comic.map((each) => [each.name, each.comicPages]), [['comic-transcript', 2]]);
  assert.deepEqual(CASES.deck.map((each) => each.name), ['starter-deck', 'brand-overview', 'deck-overflow']);
});
