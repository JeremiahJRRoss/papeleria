/**
 * M5.3 / A11 / DEP06 (D127): the notices in every generated dist/.
 *
 * All four examples are built by the compiled CLI on temporary copies, so
 * nothing is written into examples/ (D71). Every dist/ carries Papeleria's
 * own LICENSE, the maintained NOTICE.md and both font OFL texts, byte for
 * byte as the tool ships them, and a THIRD_PARTY.md scoped to what the dist/
 * holds: the two font families in every piece, and the page-turn engine,
 * with its MIT licence beside it, in the comic only. Each row names files
 * the folder has, and `node scripts/gen-notice.mjs --dist` writes the same
 * file for the same folder.
 *
 * From M5.5 (W5D, D140) the checks live in `test/helpers/notices.ts`, and
 * the tarball proof runs them on the four examples the installed CLI builds;
 * THIRD_PARTY.md also names the version of Papeleria that wrote it.
 */
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {after, before, describe, test} from 'node:test';

import {NOTICE_EXAMPLES, assertNoticeCurrent, assertNoticeFiles, assertThirdParty, distFiles} from '../helpers/notices.js';
import {applicationRoot, runNode} from '../helpers/paths.js';
import {copyPiece, removeTemporaryFolders} from '../helpers/pieces.js';

after(removeTemporaryFolders);

const CLI = join(applicationRoot, 'lib', 'src', 'cli', 'index.js');

for (const example of NOTICE_EXAMPLES) {
  describe(`${example.name}: its dist/ carries its notices`, () => {
    let dist = '';
    let files: string[] = [];

    before(async () => {
      const root = copyPiece(join(applicationRoot, 'examples', example.name), `notices-${example.name}`);
      const built = await runNode(CLI, ['build', root]);
      assert.equal(built.code, 0, built.stderr);
      dist = join(root, 'dist');
      files = distFiles(dist);
    });

    test('Papeleria’s LICENSE, the maintained NOTICE.md and both font OFL texts, byte for byte', () => {
      assertNoticeFiles(dist, files, example);
    });

    test('THIRD_PARTY.md names what this folder holds, and nothing else, and the version that wrote it', () => {
      assertThirdParty(dist, files, example);
    });

    test('gen-notice --dist writes the same THIRD_PARTY.md for this folder', async () => {
      await assertNoticeCurrent(dist);
    });
  });
}
