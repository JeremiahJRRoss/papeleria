/**
 * A4 (M1.9, D70): the structural comparison of a built deck with the
 * reference deck, and the allowlist that names every difference it may show.
 *
 * Pure and free of DOM types: `test/browser/golden/brand-overview.test.ts`
 * extracts both documents in a browser with one function, and this module
 * compares the two extractions, so the same code runs under `npm test` in
 * `test/golden/dom-compare.test.ts`.
 *
 * What is compared: the doctype, then every element from `<html>` down, in
 * order — its tag, id, ordered class list and every other attribute — and
 * every text node with its ASCII whitespace collapsed, whitespace-only nodes
 * left out. Children are aligned by a longest common subsequence of their
 * signatures, so an element added or left out is reported once, not as a
 * cascade. A notes aside is compared apart (REFERENCE_COMPATIBILITY, notes
 * rows): its label text exactly, the whitespace after the label, its form, and
 * its lines or paragraphs as an ordered list, each exactly. Comments are not
 * read.
 */

export type TextNode = {readonly text: string};

/** What a notes aside holds, read the same way from either document. */
export type NotesRecord = {
  /** The text of the `<strong>` label that begins the aside, or null when it does not begin with one. */
  readonly label: string | null;
  /** The whitespace between the label and the first line or paragraph, exactly. */
  readonly boundary: string;
  /** The kit writes lines of text under `white-space: pre-line`; Markdown notes are `<p>` elements. */
  readonly form: 'lines' | 'paragraphs' | 'empty';
  /** The lines, or each paragraph's text, exactly and in order. */
  readonly paragraphs: readonly string[];
  /** Anything that is neither: markup inside a paragraph, text between paragraphs, another element. */
  readonly stray: readonly string[];
};

export type ElementNode = {
  readonly tag: string;
  readonly id: string | null;
  readonly classes: readonly string[];
  /** Every attribute but `class` and `id`, by name. */
  readonly attributes: Readonly<Record<string, string>>;
  readonly children: readonly DomNode[];
  /** Present on `aside.slide-notes`, whose children are read here instead. */
  readonly notes?: NotesRecord;
};

export type DomNode = ElementNode | TextNode;

export type ExtractedDocument = {
  /** `name|publicId|systemId`, or null without a doctype. */
  readonly doctype: string | null;
  readonly root: ElementNode;
};

export type ElementSummary = {
  readonly attributes: Readonly<Record<string, string>>;
  /** The element's descendant texts, joined by one space. */
  readonly text: string;
  /** A canonical serialization of the element and everything in it. */
  readonly markup: string;
  /** Whether it holds no element, only text or nothing; a notes aside never does. */
  readonly leaf: boolean;
};

export type Difference =
  | {readonly kind: 'doctype'; readonly path: string; readonly reference: string | null; readonly generated: string | null}
  | {readonly kind: 'missing' | 'extra'; readonly path: string; readonly element: ElementSummary}
  | {readonly kind: 'attribute'; readonly path: string; readonly name: string; readonly reference: string | null; readonly generated: string | null}
  | {readonly kind: 'text'; readonly path: string; readonly reference: string | null; readonly generated: string | null}
  | {readonly kind: 'notes-label' | 'notes-boundary' | 'notes-form'; readonly path: string; readonly reference: string | null; readonly generated: string | null}
  | {readonly kind: 'notes-paragraphs'; readonly path: string; readonly index: number; readonly reference: string | null; readonly generated: string | null}
  | {readonly kind: 'notes-stray'; readonly path: string; readonly side: 'reference' | 'generated'; readonly description: string};

export type DifferenceKind = Difference['kind'];

export function isElement(node: DomNode): node is ElementNode {
  return 'tag' in node;
}

/**
 * Attributes that tell apart elements of one kind in `<head>`, where there is
 * no id or class: which meta, which link, which script. A link's file name
 * joins them, so the stylesheets align file by file.
 */
const DISCRIMINATING: Readonly<Record<string, readonly string[]>> = {meta: ['name', 'charset', 'http-equiv'], link: ['rel'], script: ['type']};

function fileName(href: string): string {
  const path = href.split(/[?#]/, 1)[0] ?? '';
  return path.slice(path.lastIndexOf('/') + 1);
}

/** The element as one path segment: `tag#id.class[attribute="value"]`. */
export function segment(node: ElementNode): string {
  let text = node.tag;
  if (node.id !== null) {
    text += `#${node.id}`;
  }
  for (const name of node.classes) {
    text += `.${name}`;
  }
  for (const name of DISCRIMINATING[node.tag] ?? []) {
    const value = node.attributes[name];
    if (value !== undefined) {
      text += `[${name}="${value}"]`;
    }
  }
  const href = node.attributes['href'];
  if (node.tag === 'link' && href !== undefined) {
    text += `[href$="${fileName(href)}"]`;
  }
  return text;
}

function key(node: DomNode): string {
  return isElement(node) ? segment(node) : '#text';
}

/** Pairs of indices aligned by a longest common subsequence of the keys; the rest are unmatched. */
function align(left: readonly string[], right: readonly string[]): Array<[number | null, number | null]> {
  const rows = left.length;
  const columns = right.length;
  const table: number[][] = Array.from({length: rows + 1}, () => new Array<number>(columns + 1).fill(0));
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = columns - 1; j >= 0; j -= 1) {
      table[i]![j] = left[i] === right[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const pairs: Array<[number | null, number | null]> = [];
  let i = 0;
  let j = 0;
  while (i < rows && j < columns) {
    if (left[i] === right[j]) {
      pairs.push([i, j]);
      i += 1;
      j += 1;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      pairs.push([i, null]);
      i += 1;
    } else {
      pairs.push([null, j]);
      j += 1;
    }
  }
  for (; i < rows; i += 1) {
    pairs.push([i, null]);
  }
  for (; j < columns; j += 1) {
    pairs.push([null, j]);
  }
  return pairs;
}

function escapeMarkup(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** A canonical serialization: attributes sorted by name, class and id among them, texts as extracted. */
export function markupOf(node: DomNode): string {
  if (!isElement(node)) {
    return escapeMarkup(node.text);
  }
  const attributes: [string, string][] = Object.entries(node.attributes);
  if (node.id !== null) {
    attributes.push(['id', node.id]);
  }
  if (node.classes.length > 0) {
    attributes.push(['class', node.classes.join(' ')]);
  }
  attributes.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const open = `<${node.tag}${attributes.map(([name, value]) => ` ${name}="${escapeMarkup(value)}"`).join('')}>`;
  const inner =
    node.notes === undefined
      ? node.children.map(markupOf).join('')
      : `[notes ${node.notes.form}: ${node.notes.paragraphs.length}]`;
  return `${open}${inner}</${node.tag}>`;
}

function textsOf(node: DomNode): string[] {
  if (!isElement(node)) {
    return [node.text];
  }
  if (node.notes !== undefined) {
    return [...(node.notes.label === null ? [] : [node.notes.label]), ...node.notes.paragraphs];
  }
  return node.children.flatMap(textsOf);
}

export function summarize(node: ElementNode): ElementSummary {
  const attributes: Record<string, string> = {...node.attributes};
  const leaf = node.notes === undefined && node.children.every((child) => !isElement(child));
  return {attributes, text: textsOf(node).join(' '), markup: markupOf(node), leaf};
}

function compareNotes(path: string, reference: NotesRecord, generated: NotesRecord, out: Difference[]): void {
  if (reference.label !== generated.label) {
    out.push({kind: 'notes-label', path, reference: reference.label, generated: generated.label});
  }
  if (reference.boundary !== generated.boundary) {
    out.push({kind: 'notes-boundary', path, reference: reference.boundary, generated: generated.boundary});
  }
  if (reference.form !== generated.form) {
    out.push({kind: 'notes-form', path, reference: reference.form, generated: generated.form});
  }
  const count = Math.max(reference.paragraphs.length, generated.paragraphs.length);
  for (let index = 0; index < count; index += 1) {
    const left = reference.paragraphs[index] ?? null;
    const right = generated.paragraphs[index] ?? null;
    if (left !== right) {
      out.push({kind: 'notes-paragraphs', path, index, reference: left, generated: right});
    }
  }
  for (const description of reference.stray) {
    out.push({kind: 'notes-stray', path, side: 'reference', description});
  }
  for (const description of generated.stray) {
    out.push({kind: 'notes-stray', path, side: 'generated', description});
  }
}

function compareElements(path: string, reference: ElementNode, generated: ElementNode, out: Difference[]): void {
  const names = [...new Set([...Object.keys(reference.attributes), ...Object.keys(generated.attributes)])].sort();
  for (const name of names) {
    const left = reference.attributes[name] ?? null;
    const right = generated.attributes[name] ?? null;
    if (left !== right) {
      out.push({kind: 'attribute', path, name, reference: left, generated: right});
    }
  }
  if (reference.notes !== undefined || generated.notes !== undefined) {
    const empty: NotesRecord = {label: null, boundary: '', form: 'empty', paragraphs: [], stray: []};
    compareNotes(path, reference.notes ?? empty, generated.notes ?? empty, out);
    return;
  }
  const pairs = align(reference.children.map(key), generated.children.map(key));
  for (const [left, right] of pairs) {
    const a = left === null ? null : reference.children[left]!;
    const b = right === null ? null : generated.children[right]!;
    if (a !== null && b !== null) {
      if (isElement(a) && isElement(b)) {
        compareElements(`${path} > ${segment(a)}`, a, b, out);
      } else if (!isElement(a) && !isElement(b) && a.text !== b.text) {
        out.push({kind: 'text', path: `${path} > #text`, reference: a.text, generated: b.text});
      }
    } else if (a !== null) {
      out.push(
        isElement(a)
          ? {kind: 'missing', path: `${path} > ${segment(a)}`, element: summarize(a)}
          : {kind: 'text', path: `${path} > #text`, reference: a.text, generated: null},
      );
    } else if (b !== null) {
      out.push(
        isElement(b)
          ? {kind: 'extra', path: `${path} > ${segment(b)}`, element: summarize(b)}
          : {kind: 'text', path: `${path} > #text`, reference: null, generated: b.text},
      );
    }
  }
}

/** Every difference between the two documents, in document order. */
export function compareDocuments(reference: ExtractedDocument, generated: ExtractedDocument): Difference[] {
  const out: Difference[] = [];
  if (reference.doctype !== generated.doctype) {
    out.push({kind: 'doctype', path: '#doctype', reference: reference.doctype, generated: generated.doctype});
  }
  if (segment(reference.root) !== segment(generated.root)) {
    out.push({kind: 'missing', path: segment(reference.root), element: summarize(reference.root)});
    out.push({kind: 'extra', path: segment(generated.root), element: summarize(generated.root)});
    return out;
  }
  compareElements(segment(reference.root), reference.root, generated.root, out);
  return out;
}

// ---------------------------------------------------------------------------
// The allowlist

/**
 * An expected value: a literal (null for absent), a strings key of the piece's
 * language, the configured wordmark, the generator, a path rewritten from the
 * reference's, or the manifest line a slide starts or ends on.
 */
export type Expected =
  | string
  | null
  | {readonly string: string}
  | {readonly stringsJson: true}
  | {readonly wordmark: true}
  | {readonly generator: true}
  | {readonly from: string; readonly to: string}
  | {readonly sourceLine: true};

export type AllowlistEntry = {
  readonly id: string;
  readonly kind: DifferenceKind;
  /** Where: one pattern or several; `*` stands for any run of characters inside one path segment. */
  readonly path: string | readonly string[];
  /** For attribute entries: the attribute names it covers. */
  readonly name?: string | readonly string[];
  readonly reference?: Expected;
  readonly generated?: Expected;
  /**
   * For missing and extra entries: the element's whole canonical markup; or,
   * for an element that holds no other element, its text, its exact
   * attributes, or both.
   */
  readonly text?: Expected;
  readonly attributes?: Readonly<Record<string, Expected>>;
  readonly markup?: string;
  /** How many differences the entry covers, exactly. */
  readonly count: number;
  /** A conditional entry covers its differences only while this holds, and none otherwise. */
  readonly when?: 'configured-wordmark-differs';
  /** Where the difference is justified. */
  readonly record: string;
  readonly note?: string;
};

export type Allowlist = {readonly entries: readonly AllowlistEntry[]};

export type AllowlistContext = {
  /** The strings file of the piece's language. */
  readonly strings: Readonly<Record<string, string>>;
  /** The wordmark the build resolves (manifest, brand/brand.json, theme default). */
  readonly wordmark: string;
  /** The generator the page names: `Papeleria <version>`. */
  readonly generator: string;
  /** Each slide's manifest lines, from the report's targets. */
  readonly sourceLines: ReadonlyMap<number, {readonly start: number; readonly end: number}>;
};

export type AllowlistResult = {
  /** Differences no entry covers: each is a failure. */
  readonly unexpected: readonly Difference[];
  /** How often each entry was used, against how often it says. */
  readonly entries: readonly {readonly id: string; readonly used: number; readonly expected: number}[];
  /** Differences more than one entry would cover: the allowlist must say which. */
  readonly ambiguous: readonly {readonly difference: Difference; readonly entries: readonly string[]}[];
};

function patternRegExp(pattern: string): RegExp {
  const source = pattern
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('(?:(?! > ).)*');
  return new RegExp(`^${source}$`, 'u');
}

function matchesPath(pattern: string | readonly string[], path: string): boolean {
  return (typeof pattern === 'string' ? [pattern] : pattern).some((each) => patternRegExp(each).test(path));
}

function slideNumber(path: string): number | null {
  const match = /article#slide-(\d+)[.\s>]/u.exec(`${path} `);
  return match === null ? null : Number(match[1]);
}

/** Whether `actual` is what `expected` says, where `reference` is the reference's value for a rewrite. */
export function meets(
  expected: Expected | undefined,
  actual: string | null,
  context: AllowlistContext,
  facts: {readonly reference?: string | null; readonly path?: string; readonly name?: string} = {},
): boolean {
  if (expected === undefined) {
    return true;
  }
  if (expected === null || typeof expected === 'string') {
    return actual === expected;
  }
  if (actual === null) {
    return false;
  }
  if ('string' in expected) {
    return context.strings[expected.string] !== undefined && actual === context.strings[expected.string];
  }
  if ('stringsJson' in expected) {
    try {
      return JSON.stringify(JSON.parse(actual)) === JSON.stringify(context.strings);
    } catch {
      return false;
    }
  }
  if ('wordmark' in expected) {
    return actual === context.wordmark;
  }
  if ('generator' in expected) {
    return actual === context.generator;
  }
  if ('from' in expected) {
    const reference = facts.reference;
    return typeof reference === 'string' && reference.startsWith(expected.from) && actual === expected.to + reference.slice(expected.from.length);
  }
  if ('sourceLine' in expected) {
    const slide = facts.path === undefined ? null : slideNumber(facts.path);
    const lines = slide === null ? undefined : context.sourceLines.get(slide);
    const which = facts.name?.endsWith('-start') ? lines?.start : facts.name?.endsWith('-end') ? lines?.end : undefined;
    return which !== undefined && actual === String(which);
  }
  return false;
}

function covers(entry: AllowlistEntry, difference: Difference, context: AllowlistContext): boolean {
  if (entry.kind !== difference.kind || !matchesPath(entry.path, difference.path)) {
    return false;
  }
  switch (difference.kind) {
    case 'attribute': {
      const names = entry.name === undefined ? [] : typeof entry.name === 'string' ? [entry.name] : entry.name;
      const facts = {reference: difference.reference, path: difference.path, name: difference.name};
      return (
        names.includes(difference.name) &&
        meets(entry.reference, difference.reference, context, facts) &&
        meets(entry.generated, difference.generated, context, facts)
      );
    }
    case 'missing':
    case 'extra': {
      const element = difference.element;
      if (entry.markup !== undefined && entry.markup !== element.markup) {
        return false;
      }
      // Text and attributes say all there is to an element only when it holds
      // no other element; one with markup inside is named by its whole markup,
      // so nothing can be put inside an allowed element unnoticed.
      if (entry.markup === undefined && !element.leaf) {
        return false;
      }
      if (!meets(entry.text, element.text, context)) {
        return false;
      }
      if (entry.attributes !== undefined) {
        const expectedNames = Object.keys(entry.attributes).sort();
        const actualNames = Object.keys(element.attributes).sort();
        if (JSON.stringify(expectedNames) !== JSON.stringify(actualNames)) {
          return false;
        }
        return expectedNames.every((name) => meets(entry.attributes![name], element.attributes[name] ?? null, context));
      }
      return entry.markup !== undefined || entry.text !== undefined;
    }
    case 'notes-stray':
      return false;
    default: {
      const facts = {reference: difference.reference, path: difference.path};
      return meets(entry.reference, difference.reference, context, facts) && meets(entry.generated, difference.generated, context, facts);
    }
  }
}

function applies(entry: AllowlistEntry, context: AllowlistContext): boolean {
  if (entry.when === 'configured-wordmark-differs') {
    return typeof entry.reference === 'string' && context.wordmark !== entry.reference;
  }
  return true;
}

/**
 * Matches every difference against the allowlist. A difference is allowed
 * only when exactly one entry covers it; an entry must cover exactly as many
 * differences as it says, so a stale or widened entry fails as surely as an
 * unlisted difference. A stray node inside the notes is never allowed.
 */
export function applyAllowlist(differences: readonly Difference[], allowlist: Allowlist, context: AllowlistContext): AllowlistResult {
  const used = new Map<string, number>(allowlist.entries.map((entry) => [entry.id, 0]));
  const unexpected: Difference[] = [];
  const ambiguous: {difference: Difference; entries: string[]}[] = [];
  for (const difference of differences) {
    const matching = allowlist.entries.filter((entry) => applies(entry, context) && covers(entry, difference, context));
    if (matching.length === 0) {
      unexpected.push(difference);
    } else if (matching.length > 1) {
      ambiguous.push({difference, entries: matching.map((entry) => entry.id)});
    } else {
      const id = matching[0]!.id;
      used.set(id, (used.get(id) ?? 0) + 1);
    }
  }
  const entries = allowlist.entries.map((entry) => ({
    id: entry.id,
    used: used.get(entry.id) ?? 0,
    expected: applies(entry, context) ? entry.count : 0,
  }));
  return {unexpected, entries, ambiguous};
}

/** One line a person can read: what differs, where, and both values. */
export function describeDifference(difference: Difference): string {
  const show = (value: string | null): string => (value === null ? 'absent' : JSON.stringify(value));
  switch (difference.kind) {
    case 'missing':
      return `missing ${difference.path}: ${difference.element.markup}`;
    case 'extra':
      return `extra ${difference.path}: ${difference.element.markup}`;
    case 'attribute':
      return `attribute ${difference.name} at ${difference.path}: reference ${show(difference.reference)}, generated ${show(difference.generated)}`;
    case 'notes-paragraphs':
      return `notes paragraph ${difference.index + 1} at ${difference.path}: reference ${show(difference.reference)}, generated ${show(difference.generated)}`;
    case 'notes-stray':
      return `notes at ${difference.path}, ${difference.side}: ${difference.description}`;
    default:
      return `${difference.kind} at ${difference.path}: reference ${show(difference.reference)}, generated ${show(difference.generated)}`;
  }
}
