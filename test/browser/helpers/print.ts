/**
 * Reading a printed PDF back (M3.5, M3.6, D91, D98).
 *
 * Chromium prints a page with `page.pdf`, honouring the stylesheets' `@page`
 * size and margins. Nothing in the dependency baseline reads a PDF's words,
 * boxes and images, so poppler-utils, installed on the machine, read it back
 * (D91):
 *
 * - `pdfinfo` for the page count, whether the PDF is tagged, and its tag
 *   tree with its text (`-struct-text`), in the order a reader is given it;
 * - `pdftotext -bbox` for every word and the box it stands in, in the order
 *   poppler reads the page;
 * - `pdfimages -list` for each image drawn, its page, its pixels and the
 *   resolution it is drawn at, hence its printed size;
 * - `pdftoppm` to render each page at 72 dpi, one pixel a point, to look for
 *   ink in its margins.
 *
 * CI installs poppler-utils in the browser job, and a missing tool fails
 * there; elsewhere the checks that need them are skipped and say why.
 *
 * Node-side only and free of DOM types.
 */
import {spawnSync} from 'node:child_process';
import {mkdtempSync, readdirSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {inContinuousIntegration} from './engines.js';

export const PDF_TOOLS = ['pdfinfo', 'pdftotext', 'pdfimages', 'pdftoppm'] as const;

const INSTALL_HINT = 'sudo apt-get install poppler-utils (Debian, Ubuntu) or brew install poppler (macOS)';

/** One millimetre in PDF points. */
export const MM = 72 / 25.4;

/**
 * Why the PDF checks cannot run on this machine, or undefined when every
 * poppler tool is there. Under CI a missing tool is an error, never a skip (D91).
 */
export function pdfToolsMissing(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const missing = PDF_TOOLS.filter((tool) => spawnSync(tool, ['-v'], {encoding: 'utf8'}).error !== undefined);
  if (missing.length === 0) {
    return undefined;
  }
  const reason = `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not installed; install poppler-utils with ${INSTALL_HINT} (D91)`;
  if (inContinuousIntegration(env)) {
    throw new Error(`${reason}. CI installs poppler-utils in the browser job, so the print checks never skip there.`);
  }
  return reason;
}

function run(tool: string, args: readonly string[]): string {
  const result = spawnSync(tool, args, {encoding: 'utf8', maxBuffer: 256 * 1024 * 1024});
  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${tool} ${args.join(' ')} exited ${String(result.status)}: ${result.stderr}`);
  }
  return result.stdout;
}

export type PdfWord = {readonly text: string; readonly xMin: number; readonly yMin: number; readonly xMax: number; readonly yMax: number};

export type PdfPage = {
  /** From 1. */
  readonly number: number;
  readonly width: number;
  readonly height: number;
  readonly words: readonly PdfWord[];
};

export type PdfImage = {
  readonly page: number;
  /** poppler's object number, the same wherever one image is drawn again. */
  readonly object: string;
  readonly width: number;
  readonly height: number;
  /** The size it prints at, in points. */
  readonly printedWidth: number;
  readonly printedHeight: number;
};

export type StructureNode = {readonly type: string; readonly text: string; readonly children: readonly StructureNode[]};

export type PrintedPdf = {
  readonly file: string;
  readonly pages: readonly PdfPage[];
  readonly tagged: boolean;
  readonly images: readonly PdfImage[];
  /** The tag tree; empty when the PDF is not tagged. */
  readonly structure: readonly StructureNode[];
};

const ENTITIES: Readonly<Record<string, string>> = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'"};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name.startsWith('#x') || name.startsWith('#X')) {
      return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
    }
    if (name.startsWith('#')) {
      return String.fromCodePoint(Number.parseInt(name.slice(1), 10));
    }
    return ENTITIES[name] ?? whole;
  });
}

/** Every page and word of a PDF, as `pdftotext -bbox` reads them. */
export function readWords(file: string): PdfPage[] {
  const html = run('pdftotext', ['-bbox', file, '-']);
  const pages: PdfPage[] = [];
  for (const page of html.matchAll(/<page width="([\d.]+)" height="([\d.]+)">([\s\S]*?)<\/page>/g)) {
    const words: PdfWord[] = [];
    for (const word of page[3]!.matchAll(/<word xMin="([-\d.]+)" yMin="([-\d.]+)" xMax="([-\d.]+)" yMax="([-\d.]+)">([^<]*)<\/word>/g)) {
      words.push({text: decodeEntities(word[5]!), xMin: Number(word[1]), yMin: Number(word[2]), xMax: Number(word[3]), yMax: Number(word[4])});
    }
    pages.push({number: pages.length + 1, width: Number(page[1]), height: Number(page[2]), words});
  }
  return pages;
}

/** Each image drawn, as `pdfimages -list` lists it; soft masks are left out. */
export function readImages(file: string): PdfImage[] {
  const images: PdfImage[] = [];
  for (const line of run('pdfimages', ['-list', file]).split('\n').slice(2)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 14 || fields[2] !== 'image') {
      continue;
    }
    const [page, , , width, height] = fields.map(Number) as [number, number, number, number, number];
    const xPpi = Number(fields[12]);
    const yPpi = Number(fields[13]);
    images.push({page, object: `${fields[10]} ${fields[11]}`, width, height, printedWidth: (width / xPpi) * 72, printedHeight: (height / yPpi) * 72});
  }
  return images;
}

/** The tag tree as `pdfinfo -struct-text` prints it, two spaces a level, text in quotes. */
export function parseStructure(printed: string): StructureNode[] {
  type Open = {type: string; texts: string[]; children: Open[]; depth: number};
  const root: Open = {type: '', texts: [], children: [], depth: -1};
  const stack: Open[] = [root];
  for (const line of printed.split('\n')) {
    if (line.trim() === '') {
      continue;
    }
    const depth = (line.length - line.trimStart().length) / 2;
    while (stack.length > 1 && stack[stack.length - 1]!.depth >= depth) {
      stack.pop();
    }
    const parent = stack[stack.length - 1]!;
    const content = line.trim();
    if (content.startsWith('"')) {
      parent.texts.push(content.slice(1, content.endsWith('"') ? -1 : undefined));
    } else if (!content.startsWith('Object ')) {
      const node: Open = {type: content.split(' ')[0]!, texts: [], children: [], depth};
      parent.children.push(node);
      stack.push(node);
    }
  }
  const close = (node: Open): StructureNode => {
    const children = node.children.map(close);
    return {type: node.type, text: [...node.texts, ...children.map((child) => child.text)].join(''), children};
  };
  return root.children.map(close);
}

/** Reads a printed PDF: its pages and words, whether it is tagged and its tag tree, and its images. */
export function readPdf(file: string): PrintedPdf {
  const info = run('pdfinfo', [file]);
  const pages = readWords(file);
  const count = Number(/^Pages:\s+(\d+)$/m.exec(info)?.[1]);
  if (count !== pages.length) {
    throw new Error(`pdfinfo counts ${count} pages in ${file}, pdftotext ${pages.length}`);
  }
  const tagged = /^Tagged:\s+yes$/m.test(info);
  return {
    file,
    pages,
    tagged,
    images: readImages(file),
    structure: tagged ? parseStructure(run('pdfinfo', ['-struct-text', file])) : [],
  };
}

/** Every node of a tag tree, depth first, in reading order. */
export function structureNodes(nodes: readonly StructureNode[]): StructureNode[] {
  return nodes.flatMap((node) => [node, ...structureNodes(node.children)]);
}

/**
 * Text for comparing what printed with what was written: Unicode compatibility
 * forms folded (a ligature glyph reads as its letters), the bidi isolates a
 * chart puts around each label dropped (D164(i)), and every space removed, so
 * a line or page break inside a phrase, or a word broken to fit, still matches.
 */
export function squash(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[⁦-⁩‎‏­]/g, '')
    .replace(/\s+/g, '');
}

/** All the PDF's text, squashed, with the page each character printed on. */
export type PrintedText = {readonly text: string; pageAt(index: number): number; readonly pageStarts: readonly number[]};

export function printedText(pdf: PrintedPdf): PrintedText {
  const pageStarts: number[] = [];
  let text = '';
  for (const page of pdf.pages) {
    pageStarts.push(text.length);
    text += squash(page.words.map((word) => word.text).join(''));
  }
  return {
    text,
    pageStarts,
    pageAt(index: number): number {
      let page = 0;
      while (page + 1 < pageStarts.length && pageStarts[page + 1]! <= index) {
        page += 1;
      }
      return page + 1;
    },
  };
}

/** Where each phrase printed, each found after the one before; the first phrase missing or out of order throws. */
export function findInOrder(printed: PrintedText, phrases: readonly string[]): {phrase: string; index: number; page: number}[] {
  const found: {phrase: string; index: number; page: number}[] = [];
  let from = 0;
  for (const phrase of phrases) {
    const wanted = squash(phrase);
    const index = printed.text.indexOf(wanted, from);
    if (index === -1) {
      const anywhere = printed.text.indexOf(wanted);
      throw new Error(
        anywhere === -1
          ? `"${phrase}" did not print`
          : `"${phrase}" printed on page ${printed.pageAt(anywhere)}, before "${found[found.length - 1]?.phrase ?? ''}", out of order`,
      );
    }
    found.push({phrase, index, page: printed.pageAt(index)});
    from = index + wanted.length;
  }
  return found;
}

/** How many times a phrase printed. */
export function countPrinted(printed: PrintedText, phrase: string): number {
  const wanted = squash(phrase);
  let count = 0;
  for (let index = printed.text.indexOf(wanted); index !== -1; index = printed.text.indexOf(wanted, index + wanted.length)) {
    count += 1;
  }
  return count;
}

/** Words whose boxes reach into the page's left or right margin by more than `tolerance` points. */
export function wordsInSideMargins(pdf: PrintedPdf, margin: number, tolerance = 1): string[] {
  return pdf.pages.flatMap((page) =>
    page.words
      .filter((word) => word.xMin < margin - tolerance || word.xMax > page.width - margin + tolerance)
      .map((word) => `page ${page.number}: "${word.text}" at x ${word.xMin.toFixed(1)}–${word.xMax.toFixed(1)}`),
  );
}

/**
 * Pairs of words printed over each other. A word's box runs from its font's
 * ascent to its descent, taller than its letters, so boxes of two lines set
 * close together touch without the letters meeting; only the middle half of
 * each box, where the letters are, is compared, and two words must share
 * more than a point of it both ways. A "word" that is only a format
 * character, such as the bidi isolates around a chart label (D164(i)), prints
 * nothing and is left out.
 */
export function overlappingWords(pdf: PrintedPdf): string[] {
  const found: string[] = [];
  for (const page of pdf.pages) {
    const cores = page.words
      .filter((word) => squash(word.text) !== '')
      .map((word) => {
        const quarter = (word.yMax - word.yMin) / 4;
        return {word, top: word.yMin + quarter, bottom: word.yMax - quarter};
      });
    cores.sort((a, b) => a.top - b.top);
    for (let first = 0; first < cores.length; first += 1) {
      const a = cores[first]!;
      for (let second = first + 1; second < cores.length && cores[second]!.top < a.bottom - 1; second += 1) {
        const b = cores[second]!;
        const across = Math.min(a.word.xMax, b.word.xMax) - Math.max(a.word.xMin, b.word.xMin);
        const down = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (across > 1 && down > 1) {
          found.push(`page ${page.number}: "${a.word.text}" and "${b.word.text}"`);
        }
      }
    }
  }
  return found;
}

/** A page's last line: the words beside its lowest word, left to right, squashed. */
export function lastLine(page: PdfPage): string {
  const words = page.words.filter((word) => squash(word.text) !== '');
  const lowest = words.reduce<PdfWord | undefined>((low, word) => (low === undefined || word.yMax > low.yMax ? word : low), undefined);
  if (lowest === undefined) {
    return '';
  }
  return squash(
    words
      .filter((word) => (word.yMin + word.yMax) / 2 >= lowest.yMin && (word.yMin + word.yMax) / 2 <= lowest.yMax)
      .sort((a, b) => a.xMin - b.xMin)
      .map((word) => word.text)
      .join(''),
  );
}

/**
 * Ink in the page margins, from each page rendered at 72 dpi in grey: any
 * pixel darker than near-white more than `tolerance` points outside the text
 * area. The margins of a printed page hold nothing (IC08: no running header,
 * footer or number is generated).
 */
export function inkInMargins(pdf: PrintedPdf, margin: number, tolerance = 2): string[] {
  const directory = mkdtempSync(join(tmpdir(), 'papeleria-pdf-pages-'));
  try {
    run('pdftoppm', ['-r', '72', '-gray', pdf.file, join(directory, 'page')]);
    const files = readdirSync(directory)
      .filter((name) => name.endsWith('.pgm'))
      .sort((a, b) => Number(/(\d+)\.pgm$/.exec(a)?.[1]) - Number(/(\d+)\.pgm$/.exec(b)?.[1]));
    if (files.length !== pdf.pages.length) {
      throw new Error(`pdftoppm rendered ${files.length} pages of ${pdf.pages.length}`);
    }
    const found: string[] = [];
    files.forEach((name, index) => {
      const image = readPgm(readFileSync(join(directory, name)));
      const inner = {left: margin - tolerance, top: margin - tolerance, right: image.width - margin + tolerance, bottom: image.height - margin + tolerance};
      let first: string | undefined;
      let count = 0;
      for (let y = 0; y < image.height; y += 1) {
        for (let x = 0; x < image.width; x += 1) {
          const inside = x >= inner.left && x < inner.right && y >= inner.top && y < inner.bottom;
          if (!inside && image.pixels[y * image.width + x]! < 250) {
            count += 1;
            first ??= `(${x}, ${y})`;
          }
        }
      }
      if (count > 0) {
        found.push(`page ${index + 1}: ${count} inked pixels in the margins, the first at ${first ?? ''}`);
      }
    });
    return found;
  } finally {
    rmSync(directory, {recursive: true, force: true});
  }
}

/** A binary greymap (P5) with one byte a pixel. */
function readPgm(bytes: Buffer): {width: number; height: number; pixels: Uint8Array} {
  const header = /^P5\s+(\d+)\s+(\d+)\s+(\d+)\s/.exec(bytes.subarray(0, 64).toString('latin1'));
  if (header === null || header[3] !== '255') {
    throw new Error('pdftoppm did not write an 8-bit greymap');
  }
  const width = Number(header[1]);
  const height = Number(header[2]);
  return {width, height, pixels: new Uint8Array(bytes.buffer, bytes.byteOffset + header[0].length, width * height)};
}

/**
 * Text that numbers the printed pages: "3 / 7", "3 of 7", "3 de 7", "Page 3".
 * IC08 leaves page numbering to the browser's own print settings.
 */
export function pageNumbering(pdf: PrintedPdf): string[] {
  return pdf.pages.flatMap((page) => {
    const text = page.words.map((word) => word.text).join(' ');
    return [...text.matchAll(/\b\d+\s*(?:\/|of|de)\s*\d+\b|\b(?:page|página|pág\.)\s*\d+\b/gi)].map((match) => `page ${page.number}: "${match[0]}"`);
  });
}
