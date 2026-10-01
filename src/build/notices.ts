/**
 * M5.3 (D127): the `THIRD_PARTY.md` every generation carries, scoped to the
 * files the generation actually holds (DISTRIBUTION_INVENTORY §2). It replaces
 * the placeholder M1.7 wrote (D62, D108).
 *
 * A piece carries at most three third-party components, and each is named
 * only when its files are there: the Poppins and Inter subsets under
 * `theme/fonts/`, with the OFL text the build stages beside them, and the
 * page-turn engine when `reader.js` holds the pinned engine on line 2 (D109),
 * with its MIT licence at `vendor/page-flip/LICENSE` (D108). What the file
 * says about each comes from files the tool ships: the copyright lines of
 * the OFL texts, and the engine's `vendor/page-flip/VERSION` and `LICENSE`.
 * So a build from the installed package writes the same file as one from
 * the repository, and `node scripts/gen-notice.mjs --dist <dir>` (D126) writes
 * it again for a `dist/` that already exists.
 *
 * Everything else a piece holds is Papeleria's own code, under Apache-2.0,
 * or the author's own text, data and images. Charts are drawn at build time,
 * so no chart library ships, and nothing that runs only on the author's
 * machine (sharp and libvips, the editor and its packages) is ever emitted.
 */
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';

export const THIRD_PARTY_FILE = 'THIRD_PARTY.md';

/** The files of a generation or a `dist/`, and a way to read one. */
export type EmittedFiles = {
  readonly paths: readonly string[];
  read(path: string): Promise<Uint8Array | null>;
};

export type PublishedComponent = {
  readonly name: string;
  readonly version: string | null;
  readonly licence: string;
  readonly spdx: string;
  readonly copyright: readonly string[];
  /** Where the component is in the folder, in words and paths. */
  readonly where: string;
  /** The licence text, relative to the folder's root. */
  readonly text: string;
};

/**
 * The font families a piece can carry, as scripts/license-check.mjs names
 * them (FONT_FAMILIES, D125): their files' prefix in a generation, the OFL
 * text staged at its root (D62), and where the tool keeps that text.
 */
export const FONT_FAMILIES: readonly {readonly family: string; readonly prefix: string; readonly text: string; readonly source: string}[] = Object.freeze([
  {family: 'Poppins', prefix: 'theme/fonts/poppins-', text: 'Poppins-OFL.txt', source: 'theme/fonts/Poppins-OFL.txt'},
  {family: 'Inter', prefix: 'theme/fonts/inter-', text: 'Inter-OFL.txt', source: 'theme/fonts/Inter-OFL.txt'},
]);

/** The engine's record and licence in the tool, and where a comic keeps its licence (D100, D108). */
const ENGINE_RECORD = 'vendor/page-flip/VERSION';
const ENGINE_LICENSE_SOURCE = 'vendor/page-flip/LICENSE';
export const ENGINE_LICENSE = 'vendor/page-flip/LICENSE';

/** The comic stylesheet's mark on the rules it restates from the engine (D109). */
const ENGINE_RULES_MARK = 'StPageFlip 2.0.7 (MIT; vendor/page-flip/LICENSE)';

/** The copyright lines a licence text opens with: notices, not the word inside the terms. */
export function copyrightNotices(text: string): string[] {
  const notices: string[] = [];
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.replace(/\s+/g, ' ').trim();
    if (/^copyright\s+(?:\(c\)\s*|©\s*)?\d{4}/i.test(line)) {
      notices.push(line);
    }
  }
  return notices;
}

/** A `key: value` record such as `vendor/page-flip/VERSION`; comment and blank lines are skipped. */
export function parseRecord(text: string): ReadonlyMap<string, string> {
  const record = new Map<string, string>();
  for (const line of text.split('\n')) {
    const match = /^([a-z0-9_]+):\s*(.*?)\s*$/.exec(line);
    if (match !== null) {
      record.set(match[1]!, match[2]!);
    }
  }
  return record;
}

/** A text this module reads from the tool is missing: the installation, not the piece, is at fault. */
export class NoticeSourceError extends Error {
  readonly file: string;

  constructor(file: string, cause: unknown) {
    super(`The tool file ${file} could not be read: ${(cause as Error).message}.`, {cause});
    this.name = 'NoticeSourceError';
    this.file = file;
  }
}

async function toolText(toolRoot: string, source: string): Promise<string> {
  try {
    return (await readFile(join(toolRoot, ...source.split('/')))).toString('utf8');
  } catch (error) {
    throw new NoticeSourceError(source, error);
  }
}

/**
 * The engine's pinned bytes in a reader bundle (D109): they start on line 2,
 * after the banner, and run for the pinned length, their own final newline
 * included, as `scripts/bundle-clients.mjs` assembles and scans them.
 */
function pinnedPrefix(bytes: Uint8Array, length: number): Uint8Array | null {
  const start = bytes.indexOf(0x0a) + 1;
  return start === 0 || !Number.isSafeInteger(length) || bytes.length < start + length ? null : bytes.subarray(start, start + length);
}

const listing = (paths: readonly string[]): string => paths.map((path) => `\`${path}\``).join(', ');

/**
 * The third-party components in a folder, from its own files: a font family
 * whose WOFF2 files are there, and the engine when `reader.js` carries the
 * pinned file on line 2.
 */
export async function publishedComponents(toolRoot: string, emitted: EmittedFiles): Promise<PublishedComponent[]> {
  const components: PublishedComponent[] = [];
  for (const family of FONT_FAMILIES) {
    const files = emitted.paths.filter((path) => path.startsWith(family.prefix) && path.endsWith('.woff2')).sort();
    if (files.length === 0) {
      continue;
    }
    components.push({
      name: family.family,
      version: null,
      licence: 'SIL Open Font License 1.1',
      spdx: 'OFL-1.1',
      copyright: copyrightNotices(await toolText(toolRoot, family.source)),
      where: listing(files),
      text: family.text,
    });
  }
  if (emitted.paths.includes('reader.js')) {
    const record = parseRecord(await toolText(toolRoot, ENGINE_RECORD));
    const bytes = await emitted.read('reader.js');
    const engine = bytes === null ? null : pinnedPrefix(bytes, Number(record.get('file_bytes')));
    if (engine !== null && createHash('sha256').update(engine).digest('hex') === record.get('file_sha256')) {
      const repository = record.get('upstream_repository') ?? '';
      const stylesheet = emitted.paths.includes('theme/css/comic.css') ? await emitted.read('theme/css/comic.css') : null;
      const restated = stylesheet !== null && Buffer.from(stylesheet).toString('utf8').includes(ENGINE_RULES_MARK);
      components.push({
        name: repository.replace(/\/+$/, '').split('/').pop() || (record.get('npm_package') ?? 'page-flip'),
        version: record.get('npm_version') ?? null,
        licence: record.get('license_spdx') ?? 'MIT',
        spdx: record.get('license_spdx') ?? 'MIT',
        copyright: copyrightNotices(await toolText(toolRoot, ENGINE_LICENSE_SOURCE)),
        where: `line 2 of \`reader.js\`, byte for byte${restated ? ', and the four layout rules `theme/css/comic.css` restates from it' : ''}`,
        text: ENGINE_LICENSE,
      });
    }
  }
  return components;
}

const cell = (text: string): string => text.replace(/\|/g, '\\|');

/** The file itself: own code, the components, and nothing the folder does not hold. */
export function renderDistThirdParty(components: readonly PublishedComponent[], emitted: readonly string[], toolVersion: string): string {
  const script = emitted.includes('reader.js') ? 'the reader in `reader.js`' : emitted.includes('deck.js') ? '`deck.js`' : null;
  const ownCode = script === null ? 'the page and the stylesheets' : `the page, ${script} and the stylesheets`;
  const lines = [
    '# Third-party components in this piece',
    '',
    `Written by Papeleria ${toolVersion} from the files in this folder.`,
    '',
    `Papeleria’s own code, including ${ownCode}, is under the Apache License 2.0 in \`LICENSE\`; \`NOTICE.md\` holds the attributions. The text, data and images are the author’s, with the credits and rights the piece gives them. Charts are drawn when the piece is built, so no chart library ships here, and nothing that runs only on the machine that built it, such as sharp or the editor, is in this folder.`,
    '',
  ];
  if (components.length === 0) {
    lines.push('This folder holds no third-party component.', '');
    return lines.join('\n');
  }
  lines.push(
    components.length === 1 ? 'The one third-party component here:' : `The ${components.length} third-party components here:`,
    '',
    '| Component | Where in this folder | Licence | Copyright | Licence text |',
    '| --- | --- | --- | --- | --- |',
  );
  for (const component of components) {
    const name = component.version === null ? component.name : `${component.name} ${component.version}`;
    const copyright = component.copyright.length === 0 ? 'none in the licence text' : component.copyright.join('; ');
    lines.push(`| ${cell(name)} | ${cell(component.where)} | ${cell(component.licence === component.spdx ? component.licence : `${component.licence} (${component.spdx})`)} | ${cell(copyright)} | \`${component.text}\` |`);
  }
  lines.push('');
  return lines.join('\n');
}

/** The `THIRD_PARTY.md` for a folder's files, the tool's texts read from `toolRoot`. */
export async function distThirdParty(toolRoot: string, emitted: EmittedFiles, toolVersion: string): Promise<string> {
  return renderDistThirdParty(await publishedComponents(toolRoot, emitted), emitted.paths, toolVersion);
}
