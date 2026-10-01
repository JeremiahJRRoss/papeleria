/**
 * The print fixture catalog, test/fixtures/print/cases.json (M3.5, M3.6),
 * and the files a case makes when its test runs. Shared by the unit test that
 * holds the catalog valid and the browser suites that print each case.
 */
import {readFileSync} from 'node:fs';

import {pngSource} from '../fixtures/images/generate.js';
import {mp4Source} from '../fixtures/video/generate.js';
import {fixturePath} from './paths.js';

export type PrintCase = {
  readonly name: string;
  /** The piece's folder, from the application root. */
  readonly piece: string;
  /** Why the case cannot print yet: its template has no renderer. None is pending from M4 (W4). */
  readonly pending?: string;
  /** Files made when the test runs: a PNG of [width, height], or `mp4:<seconds>`, a silent MP4. */
  readonly generated?: Readonly<Record<string, readonly [number, number] | string>>;
  /** Document: its logical sheets, each starting a printed page. */
  readonly sheets?: number;
  /** Document and comic: the fewest printed pages it may take. */
  readonly minPages?: number;
  /** Document and comic: text that must print, in this order. */
  readonly inOrder?: readonly string[];
  /** Document: a text file of the piece whose paragraphs must all print, in order. */
  readonly inOrderFile?: string;
  /** Document: text that must be the first on its sheet after the sheet's header; comic: the first on its printed page. */
  readonly startsSheet?: readonly string[];
  readonly table?: {readonly header: readonly string[]; readonly rowIds: number; readonly tallRow: string; readonly tallRowLines: number};
  readonly tallImage?: {readonly width: number; readonly height: number; readonly caption: string};
  readonly video?: {readonly alternative: string; readonly poster: readonly [number, number]};
  /** Comic: its source pages, each starting a printed page, its art whole on it (IC08). */
  readonly comicPages?: number;
  /** Deck: its slides, one printed page each. */
  readonly slides?: number;
  /** Deck: the slides, numbered from 1, whose content is taller or wider than a printed slide. */
  readonly overflowing?: readonly number[];
};

export type PrintCases = Readonly<Record<'document' | 'comic' | 'deck', readonly PrintCase[]>>;

export function readPrintCases(): PrintCases {
  return JSON.parse(readFileSync(fixturePath('print', 'cases.json'), 'utf8')) as PrintCases;
}

/** The files a case's tests make when they run: a PNG of a size, or a silent MP4 of some seconds. */
export async function generatedFiles(each: PrintCase): Promise<Record<string, Uint8Array>> {
  const files: Record<string, Uint8Array> = {};
  for (const [path, spec] of Object.entries(each.generated ?? {})) {
    files[path] = typeof spec === 'string' ? mp4Source({seconds: Number(spec.slice('mp4:'.length))}) : new Uint8Array(await pngSource(spec[0], spec[1]));
  }
  return files;
}
