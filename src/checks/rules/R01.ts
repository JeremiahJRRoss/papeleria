/**
 * R01: a bracketed placeholder is still unfilled (IC01, D66).
 *
 * Every author string is read in its source, never in the rendered HTML,
 * where an escaped bracket looks like any other (W1A): each title, lead and
 * text field as Markdown (`InlineText.markdown`, `ResolvedText.markdown`, a
 * file under `assets/text/` once however many fields name it), and every
 * other manifest string as plain text. Values that name something rather than
 * say something are not read: enumerations, file paths, link targets and the
 * CSV columns a chart or table names. CSV cells are the data's, not author
 * strings. A plain string has no escape syntax of its own, so a backslash
 * before a bracket marks it literal there too, and is shown as written.
 *
 * Each placeholder is one finding where it is written: the line and column in
 * the text file, or in the manifest when the value's source holds the same
 * copies of it as the value (`placeholders.ts`); failing that, the value's
 * start, or the block's first line in a file, and no column. It is a warning,
 * and an error when the piece is published.
 */
import {joinPointer, traced, type Location, type Piece, type TracedFinding, type ValidatedManifest} from '../../core/index.js';
import {manifestLocation} from '../locate.js';
import {placeholdersInMarkdown, placeholdersInText, unescapedOccurrences} from '../placeholders.js';
import type {SourceRule} from '../rule.js';
import {isInlineText, isResolvedText, visitContent} from '../walk.js';

/** Keys whose string values name a thing — an enumeration, a file, a link, a CSV column — rather than say something. */
const NAMING_KEYS = new Set(['schema', 'template', 'language', 'status', 'layout', 'type', 'orientation', 'tone', 'src', 'data', 'poster', 'image', 'href', 'x', 'y', 'series', 'field']);

type Placeholder = {
  readonly text: string;
  readonly location: Location;
  /** Markdown, where `\[` hides a bracket, or plain text, where it is printed. */
  readonly markdown: boolean;
  /** The field that names a text file, for a placeholder the file holds but cannot place. */
  readonly related?: Location;
};

/** Which copy of a placeholder's text this is, among the unescaped copies in the value, and how many there are. */
type Occurrence = {readonly index: number; readonly count: number};

/**
 * Where a copy of `text` is written inside the manifest value at `pointer`:
 * the same copy in the value's own source span, when that span holds exactly
 * as many copies as the value; otherwise the value's start, because the source
 * spells the value differently (an escape in a JSON or quoted YAML string).
 */
function inManifest(manifest: ValidatedManifest, piece: Piece, pointer: string, text: string, occurrence: Occurrence | null): Location {
  const entry = manifest.sourceMap.get(pointer);
  if (entry !== undefined && occurrence !== null) {
    const start = entry.value.start.offset;
    const copies = unescapedOccurrences(text, manifest.text.slice(start, entry.value.end.offset));
    const at = copies.length === occurrence.count ? copies[occurrence.index] : undefined;
    if (at !== undefined) {
      const position = manifest.lines.position(start + at);
      return {file: manifest.file, line: position.line, column: position.column};
    }
  }
  return manifestLocation(piece, pointer);
}

function findPlaceholders(piece: Piece, manifest: ValidatedManifest): {manifest: Map<string, Placeholder[]>; files: Map<string, Placeholder[]>} {
  const markdown = new Map<string, {readonly source: string; readonly inlineOnly: boolean}>();
  const files = new Map<string, Placeholder[]>();
  visitContent(piece, (value) => {
    if (isInlineText(value)) {
      markdown.set(value.pointer, {source: value.markdown, inlineOnly: true});
    } else if (isResolvedText(value)) {
      if (value.origin === 'inline') {
        markdown.set(value.pointer, {source: value.markdown, inlineOnly: false});
      } else if (value.path !== null) {
        // The field holds a file path; the file's words are read once, where they are written.
        markdown.set(value.pointer, {source: '', inlineOnly: false});
        const path = value.path;
        if (!files.has(path)) {
          const field = manifestLocation(piece, value.pointer);
          files.set(
            path,
            placeholdersInMarkdown(value.markdown, false).map((found) => ({
              text: found.text,
              location: {file: path, line: found.line, column: found.column},
              markdown: true,
              ...(found.line === null ? {related: field} : {}),
            })),
          );
        }
      }
    }
  });

  const inManifestValues = new Map<string, Placeholder[]>();
  const note = (pointer: string, found: readonly {readonly text: string; readonly occurrence: Occurrence | null}[], isMarkdown: boolean): void => {
    if (found.length > 0) {
      inManifestValues.set(
        pointer,
        found.map(({text, occurrence}) => ({text, location: inManifest(manifest, piece, pointer, text, occurrence), markdown: isMarkdown})),
      );
    }
  };
  const walk = (value: unknown, pointer: string, key: string | null, parentKey: string | null): void => {
    if (typeof value === 'string') {
      const text = markdown.get(pointer);
      if (text !== undefined) {
        note(pointer, text.source === '' ? [] : placeholdersInMarkdown(text.source, text.inlineOnly), true);
      } else if (!(key !== null && NAMING_KEYS.has(key)) && parentKey !== 'columns') {
        // A string directly inside a table's `columns` names a CSV column; a slide's columns are objects.
        note(
          pointer,
          placeholdersInText(value).map((match) => {
            const copies = unescapedOccurrences(match.text, value);
            return {text: match.text, occurrence: {index: copies.indexOf(match.index), count: copies.length}};
          }),
          false,
        );
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, joinPointer(pointer, index), null, key));
      return;
    }
    if (typeof value === 'object' && value !== null) {
      for (const [childKey, child] of Object.entries(value)) {
        walk(child, joinPointer(pointer, childKey), childKey, key);
      }
    }
  };
  walk(manifest.data, '', null, null);

  return {manifest: inManifestValues, files};
}

function fixFor(placeholder: Placeholder): string {
  return placeholder.markdown
    ? `Replace ${placeholder.text} with the real text. To keep the brackets, write them as \\[ and \\].`
    : `Replace ${placeholder.text} with the real text. This field is plain text, not Markdown: a backslash before a bracket keeps it but is printed too, so if the words must stay in brackets, use other ones, such as ( ).`;
}

export const rule: SourceRule = {
  id: 'R01',
  phase: 'source',
  check(context) {
    const {piece, manifest} = context;
    if (piece === null || manifest === null) {
      return [];
    }
    const published = piece.status === 'published';
    const findings: TracedFinding[] = [];
    const report = (placeholder: Placeholder, sourcePath: string): void => {
      findings.push(
        traced({
          rule: 'R01',
          severity: published ? 'error' : 'warning',
          message: `The placeholder ${placeholder.text} has not been filled in.`,
          fix: fixFor(placeholder),
          detail: published ? 'A published piece cannot keep a placeholder.' : 'This becomes an error when the status is published.',
          location: placeholder.location,
          sourcePath,
          ...(placeholder.related === undefined ? {} : {relatedLocation: placeholder.related}),
        }),
      );
    };
    const found = findPlaceholders(piece, manifest);
    for (const [pointer, placeholders] of found.manifest) {
      placeholders.forEach((placeholder, index) => report(placeholder, `${piece.manifestFile}#${pointer}#placeholder-${index}`));
    }
    for (const [path, placeholders] of found.files) {
      placeholders.forEach((placeholder, index) => report(placeholder, `${path}#placeholder-${index}`));
    }
    return findings;
  },
};
