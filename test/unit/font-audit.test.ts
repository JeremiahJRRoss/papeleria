/**
 * B6 of the code provenance review (`docs/CODE_PROVENANCE_REVIEW_2026-09-28.md`
 * §5.3; issue 002 F5; D144), the font binary audit, on every commit rather
 * than at each release candidate. Its five assertions, and where each is made:
 *
 * - the family is Inter or Poppins: `license-inventory.test.ts`, from each
 *   file's own name table (W5B, D125);
 * - the embedded copyright line is in the OFL text beside the fonts:
 *   `distribution.test.ts` (W5B, issue 002 F3);
 * - `fsType` is 0, installable embedding: `license-inventory.test.ts`;
 * - the licence URL the fonts embed is the OFL's, and neither OFL text
 *   declares a Reserved Font Name: here.
 *
 * Every reading comes from W5B's font reader (`fontFacts` in
 * `scripts/license-inventory.mjs`), so no second reader can disagree with
 * the first and no tool enters the baseline: the review's fontTools step is
 * not needed. The readings are recorded in `docs/evidence/license-inventory.json`,
 * whose `--check` under `npm test` holds them to the committed bytes, which is
 * the review's M7.
 */
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';
import {pathToFileURL} from 'node:url';

import {applicationRoot, scriptPath} from '../helpers/paths.js';

type Family = {family: string; prefix: string; text: string};

/** The OFL's own addresses: SIL's, as Poppins embeds it, and the OFL site, as Inter embeds it. */
const OFL_URL = /^https?:\/\/(?:scripts\.sil\.org\/OFL|openfontlicense\.org)\/?$/;

async function families(): Promise<readonly Family[]> {
  return ((await import(pathToFileURL(scriptPath('license-check.mjs')).href)) as {FONT_FAMILIES: readonly Family[]}).FONT_FAMILIES;
}

test('B6: every font file embeds the OFL’s own address as its licence URL', async () => {
  const {fontFacts} = (await import(pathToFileURL(scriptPath('license-inventory.mjs')).href)) as {fontFacts(bytes: Uint8Array): {licenceUrl?: string}};
  const folder = join(applicationRoot, 'theme', 'fonts');
  const files = readdirSync(folder).filter((name) => name.endsWith('.woff2')).sort();
  assert.equal(files.length, 8, 'the eight subsets the first view counts (IC04)');
  for (const name of files) {
    assert.match(fontFacts(readFileSync(join(folder, name))).licenceUrl ?? '(none)', OFL_URL, `${name}: the licence URL in its name table`);
  }
});

test('B6: neither OFL text declares a Reserved Font Name', async () => {
  const known = await families();
  assert.deepEqual(known.map((family) => family.family).sort(), ['Inter', 'Poppins']);
  for (const family of known) {
    const text = readFileSync(join(applicationRoot, ...family.text.split('/')), 'utf8');
    // A declaration follows a copyright statement ("... with Reserved Font Name X"), above the licence's own text.
    const statements = text.slice(0, text.indexOf('This Font Software is licensed under'));
    assert.match(statements, /^Copyright /, `${family.text} opens with its copyright statements`);
    assert.doesNotMatch(statements, /Reserved Font Name/i, `${family.text} declares a Reserved Font Name`);
  }
});
