/**
 * M1.7: the tool's own files a generation carries (D62, D15, DISTRIBUTION_INVENTORY §2).
 *
 * Stylesheets the template links, the eight Poppins and Inter subsets that
 * `fonts.css` names, the public favicon (D05), the template's one script from
 * `lib/clients/` (never the kit's `theme/js/`, C22), and the notices: the own
 * Apache-2.0 LICENSE, the maintained NOTICE.md, both font OFL texts, and a
 * THIRD_PARTY.md scoped to the files staged, which `notices.ts` writes (M5.3,
 * D127; until then a placeholder, D62). A template adds notices of its own: a
 * comic's `reader.js` carries the page-turn engine, so its MIT licence travels
 * with it (D108).
 * Tool files are read from the tool root, which is the tool's, not the piece's.
 */
import {Buffer} from 'node:buffer';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';

import {FAVICON} from '../../templates/deck/render.js';
import type {PublishedFile} from '../../templates/shared/blocks.js';
import {distThirdParty, ENGINE_LICENSE, NoticeSourceError, THIRD_PARTY_FILE} from './notices.js';
import type {TemplateBuild} from './templates.js';
import {writeGenerationFile, type Generation} from './write.js';

export {ENGINE_LICENSE, THIRD_PARTY_FILE};

/** The eight WOFF2 subsets in `theme/fonts/`, all counted in every first view (IC04). */
export const FONT_FILES: readonly string[] = Object.freeze([
  'inter-400-700-latin.woff2',
  'inter-400-700-latin-ext.woff2',
  'poppins-400-latin.woff2',
  'poppins-400-latin-ext.woff2',
  'poppins-500-latin.woff2',
  'poppins-500-latin-ext.woff2',
  'poppins-600-latin.woff2',
  'poppins-600-latin-ext.woff2',
]);

/** Notices every generation carries, by output path and tool source (DISTRIBUTION_INVENTORY §2). */
const NOTICES: readonly {readonly path: string; readonly source: string}[] = [
  {path: 'LICENSE', source: 'LICENSE'},
  {path: 'NOTICE.md', source: 'NOTICE.md'},
  {path: 'Poppins-OFL.txt', source: 'theme/fonts/Poppins-OFL.txt'},
  {path: 'Inter-OFL.txt', source: 'theme/fonts/Inter-OFL.txt'},
];

/** A tool file is missing or unreadable: the installation, not the piece, is at fault (exit 2). */
export class ToolFileError extends Error {
  readonly code = 'E_TOOL_RESOURCE';
  readonly file: string;

  constructor(file: string, message: string, options?: {cause?: unknown}) {
    super(message, options);
    this.name = 'ToolFileError';
    this.file = file;
  }
}

/** A file this stage has written into the generation, read back as written. */
async function readStaged(generation: Generation, path: string): Promise<Uint8Array | null> {
  try {
    return await readFile(join(generation.directory, ...path.split('/')));
  } catch {
    return null;
  }
}

async function readToolFile(toolRoot: string, source: string): Promise<Buffer> {
  try {
    return await readFile(join(toolRoot, ...source.split('/')));
  } catch (error) {
    const hint = source.startsWith('lib/') ? ' Run npm run build, which writes it.' : ' Reinstall Papeleria.';
    throw new ToolFileError(source, `The tool file ${source} could not be read: ${(error as Error).message}.${hint}`, {cause: error});
  }
}

export type StagedFiles = {
  /** Everything the first view always loads: stylesheets, the script, fonts and the favicon. */
  readonly firstView: readonly PublishedFile[];
  /** The notices, which no reader loads. */
  readonly notices: readonly PublishedFile[];
};

/** Copies the tool's files for a template into a generation. */
export async function stageToolFiles(generation: Generation, toolRoot: string, template: TemplateBuild, toolVersion: string): Promise<StagedFiles> {
  const firstView: PublishedFile[] = [];
  const copy = async (path: string, source: string): Promise<PublishedFile> => ({
    path,
    bytes: await writeGenerationFile(generation, path, await readToolFile(toolRoot, source)),
  });
  for (const sheet of template.stylesheets) {
    firstView.push(await copy(sheet.href, sheet.source));
  }
  if (template.script !== null) {
    firstView.push(await copy(template.script.name, template.script.source));
  }
  for (const font of FONT_FILES) {
    firstView.push(await copy(`theme/fonts/${font}`, `theme/fonts/${font}`));
  }
  firstView.push(await copy(FAVICON, FAVICON));
  const notices: PublishedFile[] = [];
  for (const notice of [...NOTICES, ...(template.notices ?? [])]) {
    notices.push(await copy(notice.path, notice.source));
  }
  // M5.3 (D127): scoped to what was staged, read back from the generation itself.
  const staged = [...firstView, ...notices].map((file) => file.path);
  let thirdParty: string;
  try {
    thirdParty = await distThirdParty(toolRoot, {paths: staged, read: (path) => readStaged(generation, path)}, toolVersion);
  } catch (error) {
    if (error instanceof NoticeSourceError) {
      throw new ToolFileError(error.file, `${error.message} Reinstall Papeleria.`, {cause: error});
    }
    throw error;
  }
  notices.push({path: THIRD_PARTY_FILE, bytes: await writeGenerationFile(generation, THIRD_PARTY_FILE, thirdParty)});
  return {firstView, notices};
}
