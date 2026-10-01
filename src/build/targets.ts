/**
 * IC06 source targets: which place in a built piece each stretch of source
 * text produces, so the editor can follow the cursor (M2.3) and a finding can
 * name the slide it concerns.
 *
 * A target is a slide, page, panel or section; a `SourceTarget` ties one to a
 * line range of one file. A deck gives each slide its manifest lines (the
 * resolved `source`, D145) and, for every text file the slide reads (notes,
 * column text, captions), that file's lines; a document does the same for
 * each section (M3.1); a comic for each page and each panel (M4.2). Pure:
 * the Piece holds everything.
 */
import type {ComicPiece, DeckPiece, DocumentPiece, ResolvedBlock, ResolvedSection, ResolvedSlide, ResolvedText} from '../core/index.js';

export type Target =
  | {readonly kind: 'slide'; readonly slide: number}
  | {readonly kind: 'page'; readonly page: number}
  | {readonly kind: 'panel'; readonly page: number; readonly panel: number}
  | {readonly kind: 'section'; readonly slug: string};

export type SourceTarget = {readonly target: Target; readonly file: string; readonly lineStart: number; readonly lineEnd: number};

/**
 * The last line of a text that holds anything: `\r\n`, `\n` and a lone `\r`
 * end a line (D145), and a final line break opens no line of its own.
 */
export function lastLine(text: string): number {
  const breaks = text.match(/\r\n|\n|\r/g)?.length ?? 0;
  return /(?:\r\n|\n|\r)$/.test(text) ? Math.max(1, breaks) : breaks + 1;
}

function slideTexts(slide: ResolvedSlide): ResolvedText[] {
  const texts: (ResolvedText | null)[] = [
    slide.notes,
    ...slide.columns.map((column) => column.text),
    slide.chart?.caption ?? null,
    slide.table?.caption ?? null,
    slide.image?.caption ?? null,
  ];
  return texts.filter((text): text is ResolvedText => text !== null);
}

/**
 * A deck's targets in slide order: each slide's manifest lines first, then the
 * text files it reads, each file once per slide.
 */
export function deckTargets(piece: DeckPiece): SourceTarget[] {
  const targets: SourceTarget[] = [];
  for (const slide of piece.slides) {
    const target: Target = {kind: 'slide', slide: slide.number};
    targets.push({target, file: slide.source.file, lineStart: slide.source.lineStart, lineEnd: slide.source.lineEnd});
    const files = new Set<string>();
    for (const text of slideTexts(slide)) {
      if (text.origin === 'file' && text.path !== null && !files.has(text.path)) {
        files.add(text.path);
        const asset = piece.assets.texts[text.path];
        targets.push({target, file: text.path, lineStart: 1, lineEnd: lastLine(asset?.markdown ?? text.markdown)});
      }
    }
  }
  return targets;
}

/** Every text field a block reads, which may come from a file. */
function blockTexts(block: ResolvedBlock): (ResolvedText | null)[] {
  switch (block.kind) {
    case 'text':
    case 'quote':
    case 'note':
    case 'callout':
      return [block.text];
    case 'image':
      return [block.image.caption];
    case 'chart':
      return [block.chart.caption];
    case 'table':
      return [block.table.caption];
    case 'video':
      return [block.video.caption];
    case 'logo':
      return [];
  }
}

function sectionTexts(section: ResolvedSection): ResolvedText[] {
  return section.blocks.flatMap(blockTexts).filter((text): text is ResolvedText => text !== null);
}

/**
 * A document's targets in section order (M3.1, W3B): each section's manifest
 * lines first, then the text files its blocks read, each file once per
 * section. A section's target is its slug, the heading's id on the page
 * (IC06, IC07).
 */
export function documentTargets(piece: DocumentPiece): SourceTarget[] {
  const targets: SourceTarget[] = [];
  for (const section of piece.sections) {
    const target: Target = {kind: 'section', slug: section.slug};
    targets.push({target, file: section.source.file, lineStart: section.source.lineStart, lineEnd: section.source.lineEnd});
    const files = new Set<string>();
    for (const text of sectionTexts(section)) {
      if (text.origin === 'file' && text.path !== null && !files.has(text.path)) {
        files.add(text.path);
        const asset = piece.assets.texts[text.path];
        targets.push({target, file: text.path, lineStart: 1, lineEnd: lastLine(asset?.markdown ?? text.markdown)});
      }
    }
  }
  return targets;
}

/**
 * A comic's targets in page order (M4.2, W4): each page's manifest lines,
 * then each of its panels' lines, and for a panel whose detail reads a text
 * file, that file's lines. A panel's lines lie inside its page's, so the
 * narrowest wins and the cursor in a panel names the panel (IC06).
 */
export function comicTargets(piece: ComicPiece): SourceTarget[] {
  const targets: SourceTarget[] = [];
  for (const page of piece.pages) {
    targets.push({target: {kind: 'page', page: page.number}, file: page.source.file, lineStart: page.source.lineStart, lineEnd: page.source.lineEnd});
    for (const panel of page.panels) {
      const target: Target = {kind: 'panel', page: page.number, panel: panel.number};
      targets.push({target, file: panel.source.file, lineStart: panel.source.lineStart, lineEnd: panel.source.lineEnd});
      const detail = panel.detail;
      const texts = detail === null ? [] : detail.kind === 'text' ? [detail.text] : detail.kind === 'image' && detail.image.caption !== null ? [detail.image.caption] : [];
      for (const text of texts) {
        if (text.origin === 'file' && text.path !== null) {
          const asset = piece.assets.texts[text.path];
          targets.push({target, file: text.path, lineStart: 1, lineEnd: lastLine(asset?.markdown ?? text.markdown)});
        }
      }
    }
  }
  return targets;
}

/**
 * The target a source position belongs to: of the targets whose file is
 * `file` and whose range holds `line`, the narrowest, and the first of equals.
 * Null when the position produces nothing on its own, such as a line between
 * two slides.
 */
export function targetAt(targets: readonly SourceTarget[], file: string, line: number): Target | null {
  let best: SourceTarget | null = null;
  for (const candidate of targets) {
    if (candidate.file !== file || line < candidate.lineStart || line > candidate.lineEnd) {
      continue;
    }
    if (best === null || candidate.lineEnd - candidate.lineStart < best.lineEnd - best.lineStart) {
      best = candidate;
    }
  }
  return best?.target ?? null;
}
