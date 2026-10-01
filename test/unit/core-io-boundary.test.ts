/**
 * D155: piece files have one read path. Only `paths.ts`, which implements
 * `FileAccess`, reads the piece; the image cache reads and writes its own
 * folder and the derivatives it is given, and the installation key that signs
 * its records lives in the user's state folder (D191); strings, brand and
 * schema read the tool's own resources from the tool root. No other core
 * module may import the filesystem, so a reader that took a path and opened it
 * itself — the conflict W1R removed from `images.ts` — cannot come back
 * unnoticed.
 */
import assert from 'node:assert/strict';
import {readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';

import {applicationRoot} from '../helpers/paths.js';

/** Why each module may touch the filesystem. Anything not listed may not. */
const ALLOWED: Readonly<Record<string, string>> = {
  'paths.ts': 'FileAccess, the one read path for piece files, and the tool-root lookup',
  'image-cache.ts': 'the derivative cache under .papeleria/cache and the derivatives written to the output directory',
  'installation-key.ts': "the installation key in the user's state folder, outside every piece, that signs the image cache's records (D191)",
  'strings.ts': 'the tool resource templates/shared/strings.<language>.json',
  'brand.ts': 'the tool resources theme/brand.default.json and brand/brand.json',
  'schema.ts': 'the tool resources templates/<name>/schema.json and templates/shared/schema-defs.json',
};

const FILESYSTEM = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)['"](?:node:)?fs(?:\/promises)?['"]/;

function touchesFilesystem(source: string): boolean {
  return FILESYSTEM.test(source);
}

test('the detector is not vacuous', () => {
  for (const planted of [
    "import {readFile} from 'node:fs/promises';",
    "import {readFileSync} from 'fs';",
    "const fs = await import('node:fs');",
    "const fs = require('fs/promises');",
  ]) {
    assert.ok(touchesFilesystem(planted), planted);
  }
  assert.ok(!touchesFilesystem("import {Buffer} from 'node:buffer';"));
  assert.ok(!touchesFilesystem('// reads files through FileAccess'));
});

test('only the listed core modules touch the filesystem', () => {
  const directory = join(applicationRoot, 'src', 'core');
  const touching = readdirSync(directory)
    .filter((name) => name.endsWith('.ts'))
    .filter((name) => touchesFilesystem(readFileSync(join(directory, name), 'utf8')))
    .sort();
  assert.deepEqual(touching, Object.keys(ALLOWED).sort());
});
