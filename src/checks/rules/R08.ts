/**
 * R08: the generated output fails HTML validation or the output rules (D65).
 *
 * The page goes through html-validate with Papeleria's configuration and its
 * own scripts, resources, navigation and link-target rules in one pass
 * (`html-scan.ts`); each stylesheet the generation holds is scanned for
 * `@import` and for `url()`s that are not relative files it holds. Each
 * message is an error at the generated file, line and column (IC01), with the
 * source line of the slide, page or section it falls in, read from the
 * element's `data-source-line-start`, as the related location.
 *
 * A link that leads nowhere in the output (D172) is the author's to change:
 * its message and fix say so plainly, its related location is where the link
 * is written when the piece says (`linkSources`), and it is one finding
 * however often the page shows it, as a comic's link panel and its detail do.
 */
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';

import {LineIndex, traced, type Location, type TracedFinding} from '../../core/index.js';
import {scanStylesheet, validatePage, type LinkProblem, type PageMessage} from '../html-scan.js';
import {linkSources, type LinkSource} from '../locate.js';
import type {OutputRule} from '../rule.js';

const FIX = 'Author text is always escaped, so this is most likely a Papeleria template defect: report it with this piece. The related location is the source of the part of the page it is in.';

const LINK_FIX: Readonly<Record<LinkProblem['problem'], string>> = {
  file: 'Link to a part of this page with #, to a full https address, or to a file the output holds. Text and data files are rendered into the page, not published as files, and raster images are published resized, under new names.',
  folder: 'Name a file, such as index.html, not a folder: opened from disk, a folder shows a list of its files. For the top of this page, use #.',
  fragment: 'Use the id of a part of this page, such as a slide’s #slide-2, a comic page’s #page-2 or the anchor a document section’s heading links to, or remove the #.',
};

type SourceRange = {readonly from: number; readonly to: number; readonly sourceLine: number};

/** The generated lines each source-mapped element spans, and the source line it starts at. */
function sourceRanges(html: string): SourceRange[] {
  const lines = new LineIndex(html);
  const ranges: SourceRange[] = [];
  for (const match of html.matchAll(/<(article|section)\b[^>]*?\sdata-source-line-start="(\d+)"/g)) {
    const close = html.indexOf(`</${match[1]}>`, match.index);
    ranges.push({
      from: lines.position(match.index).line,
      to: lines.position(close === -1 ? html.length : close).line,
      sourceLine: Number(match[2]),
    });
  }
  return ranges;
}

export const rule: OutputRule = {
  id: 'R08',
  phase: 'output',
  async check({piece, output}) {
    const findings: TracedFinding[] = [];
    const report = (file: string, message: PageMessage, index: number, part?: Location, written?: LinkSource): void => {
      const related = written?.location ?? part;
      findings.push(
        traced({
          rule: 'R08',
          message: message.link === undefined ? `The generated ${file} breaks ${message.rule}: ${message.message}.` : `${message.message}.`,
          fix: message.link === undefined ? FIX : LINK_FIX[message.link.problem],
          detail: written?.detail ?? null,
          location: {file: `${output.label}/${file}`, line: message.line, column: message.column},
          sourcePath: written?.sourcePath ?? `${output.label}/${file}#${index}`,
          ...(related === undefined ? {} : {relatedLocation: related}),
        }),
      );
    };

    const ranges = sourceRanges(output.html);
    const messages = await validatePage(output.html, {files: output.files.map((file) => file.path), script: output.script});
    let sourceOf: ((href: string) => LinkSource | undefined) | undefined;
    messages.forEach((message, index) => {
      const line = message.line;
      const range = line === null ? undefined : ranges.findLast((candidate) => candidate.from <= line && line <= candidate.to);
      const part = range === undefined ? undefined : {file: piece.manifestFile, line: range.sourceLine, column: null};
      const written = message.link === undefined ? undefined : (sourceOf ??= linkSources(piece))(message.link.href);
      report('index.html', message, index, part, written);
    });

    const present = new Set(output.files.map((file) => file.path));
    for (const sheet of output.files.filter((file) => file.path.endsWith('.css'))) {
      const css = await readFile(join(output.directory, ...sheet.path.split('/')), 'utf8');
      scanStylesheet(css, sheet.path, present).forEach((message, index) => report(sheet.path, message, index));
    }
    return findings;
  },
};
