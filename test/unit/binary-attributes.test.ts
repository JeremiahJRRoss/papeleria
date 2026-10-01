/**
 * W5R-28: the repository's .gitattributes marks each binary file type the tree
 * holds, or an author may add, as `binary`, so no checkout converts, diffs or
 * merges such a file as text on git's guess. The fonts the budget counts and
 * the images compared byte for byte (the sample pages, the examples, the golden
 * baselines) depend on it. Read without git: the file's own lines, and each
 * file's first 8,000 bytes, where git looks for a NUL when it has to guess.
 */
import assert from 'node:assert/strict';
import {closeSync, openSync, readdirSync, readFileSync, readSync} from 'node:fs';
import {extname, join} from 'node:path';
import {test} from 'node:test';

import {applicationRoot} from '../helpers/paths.js';

/** The extensions the repository root's .gitattributes marks with a `*.<ext> binary` line. */
function markedBinary(): Set<string> {
  const text = readFileSync(join(applicationRoot, '.gitattributes'), 'utf8');
  return new Set(
    text.split('\n').flatMap((line) => {
      const match = /^\*(\.[a-z0-9]+)\s+binary$/.exec(line.trim());
      return match === null ? [] : [match[1]!];
    }),
  );
}

/** What git would guess binary: a NUL in the first 8,000 bytes. */
function looksBinary(path: string): boolean {
  const head = Buffer.alloc(8000);
  const handle = openSync(path, 'r');
  try {
    return head.subarray(0, readSync(handle, head, 0, head.length, 0)).includes(0);
  } finally {
    closeSync(handle);
  }
}

/** Every file under a folder, leaving out hidden entries and what a build or a piece writes there. */
function* files(directory: string): Generator<string> {
  for (const entry of readdirSync(directory, {withFileTypes: true})) {
    if (entry.name.startsWith('.') || ['node_modules', 'lib', 'dist'].includes(entry.name)) {
      continue;
    }
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      yield* files(path);
    } else if (entry.isFile()) {
      yield path;
    }
  }
}

test('the binary types an author adds, the build writes and the theme ships are marked binary (W5R-28)', () => {
  const marked = markedBinary();
  // IC02's images and videos (src/core/paths.ts), the AVIF and WebP derivatives, and the fonts.
  for (const extension of ['.png', '.jpg', '.jpeg', '.webp', '.avif', '.mp4', '.webm', '.woff2']) {
    assert.ok(marked.has(extension), `.gitattributes marks *${extension} binary`);
  }
});

test('every binary file in the trees that hold them is of a type marked binary (W5R-28)', () => {
  const marked = markedBinary();
  const found = new Set<string>();
  const unmarked: string[] = [];
  for (const tree of ['brand', 'examples', 'templates', 'test/golden', 'theme', 'vendor']) {
    for (const path of files(join(applicationRoot, tree))) {
      if (looksBinary(path)) {
        found.add(extname(path).toLowerCase());
        if (!marked.has(extname(path).toLowerCase())) {
          unmarked.push(path.slice(applicationRoot.length + 1));
        }
      }
    }
  }
  assert.deepEqual(unmarked, []);
  assert.ok(found.has('.woff2') && found.has('.png'), 'the walk finds the fonts and the images');
});
