#!/usr/bin/env node
/**
 * M5.1: the manifest reference, docs/manifest-reference.md, generated
 * from the three template schemas (PRD §11, the DOC_PAGE manifest-reference,
 * D104).
 *
 * Each template is read with `bundledSchema(template)` from the built core,
 * the form in which the shared definitions are local, so only `#/$defs/…`
 * references are followed and any other reference is refused. Every field of
 * every object a manifest can hold gets an entry: its type, whether and when
 * it is required, its default, the values and limits it allows, the rule
 * that reports each broken limit (IC01, D149) and the checks that read it
 * after the schema, its description and one example. The descriptions are
 * the schemas' own, the text the editor shows as hover help. The examples,
 * the words for each pattern and the rule for each limit are this script's:
 * every example is validated with the core's `createAjv()` against its
 * field's schema before anything is written, a pattern with no words here
 * fails the run, and so does any keyword or construct the script does not
 * know how to describe, so a schema change cannot leave the reference
 * silently wrong. The deck's layout table is read from the `if`/`then` pairs
 * of `$defs/slide/allOf`.
 *
 * The header names the four schema files with their SHA-256. Nothing else
 * varies (no date, no path of this machine), so the same schemas and the same
 * script always give the same bytes.
 *
 * Needs the core compiled: `npm run gen:manifest-reference` builds first.
 *
 * Usage: node scripts/gen-manifest-reference.mjs [--check] [--out <file>]
 *        --check  generates in memory, compares with the committed file and
 *                 writes nothing
 *        --out    writes the reference somewhere else
 * Exit:  0 written (or, with --check, current) · 1 stale, an example that
 *        does not validate, or a schema construct it cannot describe · 2
 *        usage, IO, or no built core
 */
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join, relative, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

import {Document, isScalar, visit} from 'yaml';

class UsageError extends Error {}

const APPLICATION_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUT = join(APPLICATION_ROOT, 'docs', 'manifest-reference.md');

/** The templates, in the order the reference presents them. */
export const TEMPLATES = Object.freeze(['deck', 'comic', 'document']);

/** The files the reference is generated from; the header gives each one's SHA-256. */
export const INPUTS = Object.freeze([
  'templates/shared/schema-defs.json',
  'templates/deck/schema.json',
  'templates/comic/schema.json',
  'templates/document/schema.json',
]);

// ------------------------------------------------------------------ words ---

const NAME_WORDS = 'every folder and file name starts with an ASCII letter, a digit, `_` or `-` and goes on with those or `.`';
const REFUSED_PATHS = 'An absolute path, a drive letter, a backslash, a `..` segment, a space or a name that starts with a dot does not match';

/**
 * Every pattern the schemas use, in words: the reference never prints a
 * regular expression. `short` goes in a field's entry, `long` in the value
 * type's, and `broken` names a value the pattern refuses. A pattern missing
 * here fails the run.
 */
export const PATTERN_WORDS = Object.freeze({
  [String.raw`[^\p{White_Space}\p{Default_Ignorable_Code_Point}\p{Cc}\u115f\u1160\u2800\u3164\uffa0]`]: {
    short: 'at least one visible character',
    long:
      'at least one visible character. A value made only of spaces, line breaks and characters that show nothing is blank: a zero-width space or joiner, a word joiner, a soft hyphen, a byte-order mark, a control character, a Hangul filler or the blank Braille pattern',
    broken: 'blank',
  },
  [String.raw`^assets/text/[\s\S]*\.md$`]: {
    short: 'starts with `assets/text/` and ends with `.md`',
    long: 'starts with `assets/text/` and ends with `.md`',
    broken: 'a text file reference',
  },
  [String.raw`^assets/text/(?:[A-Za-z0-9_-][A-Za-z0-9._-]*/)*[A-Za-z0-9_-][A-Za-z0-9._-]*\.md$`]: {
    short: 'a path inside `assets/text/` ending in `.md`',
    long: `starts with \`assets/text/\`, may go on through folders, and ends with a file name ending in \`.md\`, in lower case; ${NAME_WORDS}, and the parts are separated by forward slashes. ${REFUSED_PATHS}`,
    broken: 'not a well-formed text file path',
  },
  [String.raw`^assets/images/(?:[A-Za-z0-9_-][A-Za-z0-9._-]*/)*[A-Za-z0-9_-][A-Za-z0-9._-]*\.(?:png|jpg|jpeg|webp|svg)$`]: {
    short: 'a path inside `assets/images/` ending in `.png`, `.jpg`, `.jpeg`, `.webp` or `.svg`',
    long: `starts with \`assets/images/\`, may go on through folders, and ends with a file name ending in \`.png\`, \`.jpg\`, \`.jpeg\`, \`.webp\` or \`.svg\`, in lower case; ${NAME_WORDS}, and the parts are separated by forward slashes. ${REFUSED_PATHS}`,
    broken: 'not a well-formed image path',
  },
  [String.raw`^assets/images/logos/(?:[A-Za-z0-9_-][A-Za-z0-9._-]*/)*[A-Za-z0-9_-][A-Za-z0-9._-]*\.(?:png|jpg|jpeg|webp|svg)$`]: {
    short: 'a path inside `assets/images/logos/` ending in `.png`, `.jpg`, `.jpeg`, `.webp` or `.svg`',
    long: `starts with \`assets/images/logos/\`, may go on through folders, and ends with a file name ending in \`.png\`, \`.jpg\`, \`.jpeg\`, \`.webp\` or \`.svg\`, in lower case; ${NAME_WORDS}, and the parts are separated by forward slashes. ${REFUSED_PATHS}`,
    broken: 'not a well-formed logo path',
  },
  [String.raw`^assets/data/[A-Za-z0-9_-][A-Za-z0-9._-]*\.csv$`]: {
    short: 'a file directly inside `assets/data/` ending in `.csv`',
    long: 'starts with `assets/data/` and goes on with a file name ending in `.csv`, in lower case, with no folder in between; the name starts with an ASCII letter, a digit, `_` or `-` and goes on with those or `.`. A path with a folder, a backslash, a space or a name that starts with a dot does not match',
    broken: 'not a well-formed CSV file path',
  },
  [String.raw`^assets/video/[A-Za-z0-9_-][A-Za-z0-9._-]*\.(?:mp4|webm)$`]: {
    short: 'a file directly inside `assets/video/` ending in `.mp4` or `.webm`',
    long: 'starts with `assets/video/` and goes on with a file name ending in `.mp4` or `.webm`, in lower case, with no folder in between; the name starts with an ASCII letter, a digit, `_` or `-` and goes on with those or `.`. A path with a folder, a backslash, a space or a name that starts with a dot does not match',
    broken: 'not a well-formed video path',
  },
  [String.raw`^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$`]: {
    short: '`#` and three or six hexadecimal digits',
    long: '`#` followed by exactly three or exactly six hexadecimal digits, `0` to `9` and `a` to `f` in either case, such as `#2f7fbf` or `#fff`',
    broken: 'not a colour written that way',
  },
  [String.raw`^(?:https://\S+|http://\S+|mailto:\S+|tel:\S+|(?![\\/])[^:\s]+)$`]: {
    short: 'an `https:`, `http:`, `mailto:` or `tel:` address, or a relative target',
    long: 'either an address that starts with `https://`, `http://`, `mailto:` or `tel:`, in lower case, and goes on with at least one more character and no space; or a relative target, such as `#page-3` or `notes.html`, with no colon and no space, that does not start with `/` or `\\`',
    broken: 'not an allowed link',
  },
});

/**
 * The value types the Values section describes once; a field whose schema
 * reaches one links to it. Definitions that only name a meaning (`alt_text`,
 * `caption`, …) are described by the fields that use them.
 */
const VALUES = Object.freeze([
  {def: 'non_empty_string', title: 'Text', noun: 'text'},
  {def: 'inline_markdown', title: 'Inline Markdown', noun: 'inline Markdown'},
  {def: 'text_value', title: 'Markdown or a text file', noun: 'Markdown or a text file path'},
  {def: 'text_file_path', title: 'Text file path', noun: 'text file path'},
  {def: 'image_path', title: 'Image path', noun: 'image path'},
  {def: 'logo_path', title: 'Logo path', noun: 'logo path'},
  {def: 'data_path', title: 'CSV file path', noun: 'CSV file path'},
  {def: 'video_path', title: 'Video path', noun: 'video path'},
  {def: 'hex_color', title: 'Colour', noun: 'colour'},
  {def: 'detail_href', title: 'Link', noun: 'link'},
]);

/**
 * The groups of fields, in the order the reference presents them. A group is
 * a template's top level (`root`), the fields every template shares
 * (`common`), an object, list-of-numbers or either-form definition (`def`),
 * or the deck's layout table. `positions` names the numbers of a list of
 * numbers; its example is the one its field gives (`exampleFrom`).
 */
const GROUPS = Object.freeze([
  {key: 'piece', section: 'common', common: true, title: 'Fields every piece takes', noun: 'piece'},
  {key: 'credit', section: 'common', def: 'credit', title: 'Credit fields', noun: 'credit', plural: 'credits'},
  {key: 'deck', section: 'deck', root: 'deck', title: 'Deck fields', noun: 'deck'},
  {key: 'slide', section: 'deck', def: 'slide', title: 'Slide fields', noun: 'slide', plural: 'slides'},
  {key: 'layouts', section: 'deck', layouts: true, title: 'Layouts'},
  {key: 'column', section: 'deck', def: 'column', title: 'Column fields', noun: 'column', plural: 'columns'},
  {key: 'item', section: 'deck', def: 'item', title: 'Item fields', noun: 'item', plural: 'items'},
  {key: 'swatch', section: 'deck', def: 'swatch', title: 'Swatch fields', noun: 'swatch', plural: 'swatches'},
  {key: 'comic', section: 'comic', root: 'comic', title: 'Comic fields', noun: 'comic'},
  {key: 'page', section: 'comic', def: 'page', title: 'Page fields', noun: 'page', plural: 'pages'},
  {key: 'panel', section: 'comic', def: 'panel', title: 'Panel fields', noun: 'panel', plural: 'panels'},
  {key: 'panel_box', section: 'comic', def: 'panel_box', title: 'Panel box', noun: 'panel box', positions: ['x', 'y', 'width', 'height'], exampleFrom: 'panel.box'},
  {key: 'detail', section: 'comic', def: 'detail', title: 'Detail fields', noun: 'detail'},
  {key: 'document', section: 'document', root: 'document', title: 'Document fields', noun: 'document'},
  {key: 'metadata_item', section: 'document', def: 'metadata_item', title: 'Metadata item fields', noun: 'metadata item', plural: 'metadata items'},
  {key: 'section', section: 'document', def: 'section', title: 'Section fields', noun: 'section', plural: 'sections'},
  {key: 'block', section: 'blocks', def: 'block', title: 'Block kinds', noun: 'block kind', one: 'block', plural: 'blocks'},
  {key: 'image_block', section: 'blocks', def: 'image_block', title: 'Image block', noun: 'image block'},
  {key: 'focal_point', section: 'blocks', def: 'focal_point', title: 'Focal point', noun: 'focal point', positions: ['x', 'y'], exampleFrom: 'image_block.focal_point'},
  {key: 'video_block', section: 'blocks', def: 'video_block', title: 'Video block', noun: 'video block'},
  {key: 'chart_block', section: 'blocks', def: 'chart_block', title: 'Chart block', noun: 'chart block'},
  {key: 'table_block', section: 'blocks', def: 'table_block', title: 'Table block', noun: 'table block'},
  {key: 'table_column', section: 'blocks', def: 'table_column', title: 'Table column', noun: 'table column', plural: 'table columns'},
  {key: 'quote_block', section: 'blocks', def: 'quote_block', title: 'Quote block', noun: 'quote block'},
  {key: 'note_block', section: 'blocks', def: 'note_block', title: 'Note block', noun: 'note block'},
  {key: 'callout_block', section: 'blocks', def: 'callout_block', title: 'Callout block', noun: 'callout block'},
  {key: 'logo_block', section: 'blocks', def: 'logo_block', title: 'Logo block', noun: 'logo block'},
]);

const SECTIONS = Object.freeze([
  {key: 'common', title: 'Common fields'},
  {key: 'deck', title: 'Deck'},
  {key: 'comic', title: 'Comic'},
  {key: 'document', title: 'Document'},
  {key: 'blocks', title: 'Blocks'},
  {key: 'values', title: 'Values'},
  {key: 'rules', title: 'Rules'},
]);

/**
 * One example per field, keyed `group.field`; a list of numbers takes its
 * numbers from its field's example, and an either-form definition's forms are
 * keyed by their index. Each is validated against the field's schema, and an
 * example no field uses fails the run, like a field with none.
 */
export const EXAMPLES = Object.freeze({
  'piece.schema': 1,
  'piece.template': 'comic',
  'piece.title': 'The ferry',
  'piece.language': 'es',
  'piece.status': 'review',
  'piece.wordmark': 'Harbour Press',
  'piece.credits': [
    {role: 'Author', name: 'Lena Ortiz'},
    {role: 'Art', name: 'Sam Okafor'},
  ],
  'credit.role': 'Letters',
  'credit.name': 'Lena Ortiz',
  'deck.register': 'Brand overview / Review edition',
  'deck.edition': 'Version 1.1.0 / 2026-09-05',
  'deck.logo': {src: 'assets/images/logos/client.svg', alt: 'Harbour Press'},
  'deck.slides': [
    {layout: 'cover', title: 'Craft with care. Build for the long view.'},
    {layout: 'statement', title: 'The record should outlast the meeting.'},
  ],
  'slide.layout': 'three',
  'slide.title': 'Where the hours went.',
  'slide.lead': 'Professional documents share a durable structure.',
  'slide.footer': 'Adapted / S06–S07',
  'slide.notes': 'assets/text/01-cover-notes.md',
  'slide.columns': [
    {heading: 'Context', text: 'Audience, purpose, scope, version and owner.'},
    {heading: 'Basis', text: 'Evidence, assumptions, limitations and terms.'},
  ],
  'slide.chart': {type: 'bar', data: 'assets/data/hours-by-phase.csv', x: 'phase', y: 'hours', summary: 'Review took the most hours and delivery the fewest.'},
  'slide.table': {data: 'assets/data/hours-by-phase.csv', columns: ['phase', 'hours']},
  'slide.image': {src: 'assets/images/pier.jpg', alt: 'The ferry pier at dawn, empty.', credit: 'Lena Ortiz', rights: 'Studio photograph'},
  'slide.items': [
    {label: 'Voice', text: 'Plain and direct.'},
    {label: 'Pace', text: 'One idea per slide.'},
  ],
  'slide.swatches': [
    {name: 'Process cyan', value: '#2f7fbf', use: 'section rail'},
    {name: 'Paper', value: '#f7f4ee'},
  ],
  'column.heading': 'Context',
  'column.text': 'Audience, purpose, scope, version and owner.',
  'item.label': 'Voice',
  'item.text': 'Plain and direct.',
  'swatch.name': 'Process cyan',
  'swatch.value': '#2f7fbf',
  'swatch.use': 'section rail',
  'comic.format': 'Web Comics',
  'comic.pages': [
    {
      image: 'assets/images/pages/01.png',
      alt: 'A harbour at dawn, seen from the ferry pier.',
      panels: [{box: [4, 4, 56, 28], transcript: 'Narration: The ferry was late again.'}],
    },
  ],
  'page.image': 'assets/images/pages/01.png',
  'page.alt': 'A harbour at dawn, seen from the ferry pier.',
  'page.credit': 'Lena Ortiz',
  'page.rights': 'Commissioned for this comic',
  'page.panels': [
    {box: [4, 4, 56, 28], transcript: 'Narration: The ferry was late again.'},
    {box: [64, 4, 32, 28], transcript: 'A gull on a bollard. Sound: a distant horn.'},
  ],
  'panel.box': [4, 4, 56, 28],
  'panel.transcript': 'Narration: The ferry was late again.',
  'panel.detail': {zoom: true},
  'detail.zoom': true,
  'detail.text': 'assets/text/gull-note.md',
  'detail.image': {src: 'assets/images/gull.png', alt: 'A herring gull on a bollard, looking out to sea.', credit: 'Lena Ortiz', rights: 'Commissioned for this comic'},
  'detail.href': 'https://example.org/timetable',
  'detail.label': 'The ferry timetable',
  'document.doc_type': 'Project report',
  'document.metadata': [
    {label: 'Audience', value: 'Studio leads'},
    {label: 'Period', value: 'Q3 2026'},
  ],
  'document.sections': [{heading: 'Executive summary', blocks: [{text: 'assets/text/summary.md'}]}],
  'document.source_note': 'Basis: studio timesheets. Not a signed approval.',
  'document.footer': 'Harbour Press · internal',
  'metadata_item.label': 'Audience',
  'metadata_item.value': 'Studio leads',
  'section.heading': 'Hours by phase',
  'section.new_page': true,
  'section.blocks': [{text: 'Review took the most hours.'}, {note: {text: 'Sample data, for the example only.', tone: 'warning'}}],
  'block.text': 'assets/text/summary.md',
  'block.image': {src: 'assets/images/pier.jpg', alt: 'The ferry pier at dawn, empty.', credit: 'Lena Ortiz', rights: 'Studio photograph'},
  'block.video': {src: 'assets/video/loop.mp4', poster: 'assets/images/loop-poster.jpg', alt: 'Waves break against the pier and settle.'},
  'block.chart': {type: 'line', data: 'assets/data/hours-by-week.csv', x: 'week', y: 'hours', series: 'phase', summary: 'Review hours rose through the quarter while build hours fell.'},
  'block.table': {data: 'assets/data/hours-by-phase.csv', columns: ['phase', {field: 'hours', label: 'Hours'}]},
  'block.quote': {text: 'A considered label. A clear handoff.', attribution: 'Brand principle'},
  'block.note': {text: 'Sample data, for the example only.', tone: 'warning'},
  'block.callout': {text: 'A folder of text, data and images becomes a finished piece.'},
  'block.logo': {src: 'assets/images/logos/client.svg', alt: 'Harbour Press'},
  'image_block.src': 'assets/images/pier.jpg',
  'image_block.alt': 'The ferry pier at dawn, empty.',
  'image_block.decorative': true,
  'image_block.caption': 'The pier before the first crossing.',
  'image_block.credit': 'Lena Ortiz',
  'image_block.rights': 'Studio photograph',
  'image_block.focal_point': [30, 60],
  'video_block.src': 'assets/video/loop.mp4',
  'video_block.poster': 'assets/images/loop-poster.jpg',
  'video_block.alt': 'Waves break against the pier and settle.',
  'video_block.caption': 'Twelve seconds at the pier, on a loop.',
  'video_block.credit': 'Sam Okafor',
  'video_block.rights': 'Studio footage',
  'chart_block.type': 'bar',
  'chart_block.orientation': 'horizontal',
  'chart_block.data': 'assets/data/hours-by-phase.csv',
  'chart_block.x': 'phase',
  'chart_block.y': 'hours',
  'chart_block.series': 'team',
  'chart_block.summary': 'Review took the most hours and delivery the fewest.',
  'chart_block.show_table': true,
  'chart_block.caption': 'Hours by phase, Q3 2026.',
  'chart_block.source': 'Studio timesheets, Q3 2026',
  'table_block.data': 'assets/data/hours-by-phase.csv',
  'table_block.columns': ['phase', {field: 'hours', label: 'Hours'}],
  'table_block.caption': 'Hours by phase, Q3 2026.',
  'table_block.source': 'Studio timesheets, Q3 2026',
  'table_column.0': 'phase',
  'table_column.1': {field: 'hours', label: 'Hours'},
  'table_column.field': 'hours',
  'table_column.label': 'Hours',
  'quote_block.text': 'A considered label. A clear handoff.',
  'quote_block.attribution': 'Brand principle',
  'note_block.text': 'Figures exclude travel time.',
  'note_block.tone': 'warning',
  'callout_block.text': 'A folder of text, data and images becomes a finished piece.',
  'logo_block.src': 'assets/images/logos/client.svg',
  'logo_block.alt': 'Harbour Press',
});

// ------------------------------------------------------------------ rules ---

/**
 * The rule that reports a broken limit of a field, by the field's place
 * (IC01, D149): the alternatives of an image, a comic page and a logo are
 * R03 and a video's R10, a panel's transcript R04, a chart's summary R05, a
 * slide's columns R15 (except a value that is not a list) and a panel box's
 * numbers R14 (except a missing box). Every other limit is R09. `kind` is one
 * of missing, forbidden, both, type, blank, value and count.
 */
export function ruleFor(group, field, kind) {
  if (field === 'alt' || field === 'decorative') {
    if (group === 'image_block' || group === 'page' || group === 'logo_block') {
      return 'R03';
    }
    if (group === 'video_block') {
      return 'R10';
    }
  }
  if (group === 'panel' && field === 'transcript') {
    return 'R04';
  }
  if (group === 'chart_block' && field === 'summary') {
    return 'R05';
  }
  if (group === 'slide' && field === 'columns' && kind !== 'type') {
    return 'R15';
  }
  if ((group === 'panel' && field === 'box' && kind !== 'missing') || group === 'panel_box') {
    return 'R14';
  }
  return 'R09';
}

/**
 * The checks that read a field after the schema has passed it, from the
 * ERD's integrity rules (C04, C05, C11, C13, C23, C28) and IC01–IC04: a file
 * that must exist, a CSV header a chart or table names, credit and rights,
 * a panel's extent, a video's duration, a comic page's phone-width weight.
 */
function laterChecks(group, field, reached) {
  const checks = [];
  const add = (rule, text) => checks.push({rule, text});
  if (['image_path', 'logo_path', 'data_path', 'video_path'].some((name) => reached.includes(name))) {
    add('R02', 'the file it names does not exist');
  } else if (reached.includes('text_value')) {
    add('R02', 'it names a text file that does not exist');
  }
  if (group === 'page' && field === 'image') {
    add('R07', 'a phone-width copy of the page, WebP or AVIF, is over 307,200 bytes (300 KiB)');
  }
  if (['image_block', 'page', 'video_block'].includes(group) && (field === 'credit' || field === 'rights')) {
    add('R06', `left out: a warning, reported apart from a missing ${field === 'credit' ? 'rights note' : 'credit'}`);
  }
  if (group === 'chart_block') {
    const csv = {
      data: 'the CSV file is malformed, has a header and no rows, or has two rows with the same `x` in one series',
      x: 'it is not a header of the CSV file, a cell in its column is empty, or, on a line chart, its cells are not all numbers or all dates',
      y: 'it is not a header of the CSV file, or a cell in its column is empty or not a finite number',
      series: 'it is not a header of the CSV file, or a cell in its column is empty',
    };
    if (csv[field] !== undefined) {
      checks.push({rule: 'R13', text: csv[field]});
    }
  }
  if (group === 'table_block' && field === 'data') {
    checks.push({rule: 'R13', text: 'the CSV file is malformed; a file with a header and no rows is a warning'});
  }
  if (group === 'table_column' && (field === 'field' || field === '0')) {
    checks.push({rule: 'R13', text: 'it is not a header of the CSV file'});
  }
  if (group === 'panel' && field === 'box') {
    add('R14', 'x plus width, or y plus height, is more than 100: the box runs off the page');
  }
  if (group === 'video_block' && field === 'src') {
    add('R16', 'the file is not an MP4 or WebM video with a video track, or its duration is zero, more than 15 seconds or unreadable');
  }
  if (group === 'piece' && field === 'schema') {
    add('R17', 'a whole number greater than 1, which needs a newer Papeleria; it is then the only finding');
  }
  return checks;
}

/** The ERD's RULE catalogue, in the reference's words; severities come from the core. */
const RULE_TITLES = Object.freeze({
  R01: 'A bracketed placeholder, such as `[Artist]`, is still in the text',
  R02: 'A file the manifest names is missing',
  R03: 'An image, a comic page or a logo has no alternative text, or an image has both alternative text and a decorative mark',
  R04: 'A comic panel has no transcript',
  R05: 'A chart has no summary',
  R06: 'An image, a video or a comic page has no credit, or no rights note',
  R07: 'A page is over its weight budget, or a comic page image is over 300 KiB at phone width',
  R09: 'A field is unknown, missing or has a value its schema refuses',
  R10: 'A video has no text alternative',
  R12: "An owner-exclusive file is copied into the piece, outside the owner's `brand/` folder",
  R13: 'A CSV file is malformed, or does not have the columns or values its chart or table needs',
  R14: 'A panel box is not four finite numbers, has no width or height, or runs off the page',
  R15: "A slide's number of columns does not match its layout",
  R16: 'A video is longer than 15 seconds, or its duration is zero or cannot be read',
  R17: "The manifest's schema is newer than this Papeleria",
});

const SEVERITY_WORDS = Object.freeze({
  R01: 'warning; error when `status` is `published`',
  R13: 'error; a warning for a table whose file has a header and no rows',
});

// ------------------------------------------------------------ small words ---

const numbers = new Intl.NumberFormat('en-US');

function listWords(words, joiner = 'and') {
  if (words.length <= 1) {
    return words.join('');
  }
  return `${words.slice(0, -1).join(', ')} ${joiner} ${words.at(-1)}`;
}

/** Conditions joined by commas, or by semicolons once one of them holds a comma or a list of its own. */
function conditionWords(phrases) {
  if (phrases.length <= 1) {
    return phrases.join('');
  }
  // A comma between digits is a thousands separator, not a list.
  const complex = phrases.some((phrase) => /,(?!\d)| or | and /.test(phrase));
  return complex ? `${phrases.slice(0, -1).join('; ')}; or ${phrases.at(-1)}` : listWords(phrases, 'or');
}

const code = (value) => `\`${value}\``;
const codes = (values, joiner = 'and') => listWords(values.map(code), joiner);

function article(noun) {
  return /^`?[aeiou]/i.test(noun) ? `an ${noun}` : `a ${noun}`;
}

const NUMBER_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

function countWords(count, noun, plural) {
  return `${NUMBER_WORDS[count] ?? numbers.format(count)} ${count === 1 ? noun : plural}`;
}

/** The anchor GitHub gives a heading: lower case, punctuation other than `-` and `_` removed, spaces as `-`. */
export function slug(heading) {
  return heading
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
    .replace(/ /g, '-');
}

/** A value as it is written in a manifest: YAML, block style, with lists of plain values on one line. */
export function yamlOf(value, {flow = true} = {}) {
  const document = new Document(value);
  if (flow) {
    visit(document, {
      Seq(_, node) {
        if (node.items.every((item) => isScalar(item))) {
          node.flow = true;
        }
      },
    });
  }
  return document.toString({lineWidth: 0, flowCollectionPadding: false}).trimEnd();
}

function inlineValue(value) {
  return code(yamlOf(value));
}

// ------------------------------------------------------------- the walk ---

/** The keywords the reference can describe; any other fails the run. */
const KEYWORDS = new Set([
  '$schema', '$id', '$comment', '$defs', '$ref', 'title', 'description', 'type', 'properties', 'required',
  'additionalProperties', 'items', 'prefixItems', 'minItems', 'maxItems', 'enum', 'const', 'default', 'pattern',
  'minLength', 'minimum', 'maximum', 'exclusiveMinimum', 'oneOf', 'allOf', 'if', 'then', 'not', 'minProperties',
  'maxProperties',
]);

function scanKeywords(node, where, problems) {
  if (typeof node === 'boolean') {
    return;
  }
  if (typeof node !== 'object' || node === null || Array.isArray(node)) {
    problems.push(`${where}: is not a schema`);
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    if (!KEYWORDS.has(key)) {
      problems.push(`${where}: the keyword ${key} is not one this generator can describe`);
      continue;
    }
    if (key === 'properties' || key === '$defs') {
      for (const [name, schema] of Object.entries(value)) {
        scanKeywords(schema, `${where}/${key}/${name}`, problems);
      }
    } else if (key === 'prefixItems' || key === 'oneOf' || key === 'allOf') {
      value.forEach((schema, index) => scanKeywords(schema, `${where}/${key}/${index}`, problems));
    } else if (['items', 'if', 'then', 'not', 'additionalProperties'].includes(key)) {
      scanKeywords(value, `${where}/${key}`, problems);
    }
  }
}

const VALUE_BY_DEF = new Map(VALUES.map((value) => [value.def, value]));
const GROUP_BY_DEF = new Map(GROUPS.filter((group) => group.def !== undefined).map((group) => [group.def, group]));

/** The group a template's own or a shared definition is read from: the first template whose bundle has it. */
function bundleWith(bundles, def) {
  const template = TEMPLATES.find((name) => Object.hasOwn(bundles[name].$defs ?? {}, def));
  return template === undefined ? null : {template, bundle: bundles[template]};
}

/**
 * A field's schema and every definition it reaches through `$ref`, outermost
 * first. The walk stops at a group, whose own fields are described where the
 * group is.
 */
function chainOf(bundle, node, where, problems) {
  const chain = [{name: null, schema: node}];
  let current = node;
  const seen = new Set();
  while (typeof current === 'object' && current !== null && current.$ref !== undefined) {
    const reference = current.$ref;
    if (typeof reference !== 'string' || !/^#\/\$defs\/[A-Za-z0-9_]+$/.test(reference)) {
      problems.push(`${where}: the reference ${JSON.stringify(reference)} is not a local #/$defs/ reference`);
      break;
    }
    const name = reference.slice('#/$defs/'.length);
    if (seen.has(name) || !Object.hasOwn(bundle.$defs ?? {}, name)) {
      problems.push(`${where}: the reference ${reference} ${seen.has(name) ? 'refers to itself' : 'names no definition'}`);
      break;
    }
    seen.add(name);
    current = bundle.$defs[name];
    chain.push({name, schema: current});
    if (GROUP_BY_DEF.has(name)) {
      break;
    }
  }
  return chain;
}

/** Where a group's heading points. */
function groupLink(group, words) {
  return `[${words}](#${slug(group.title)})`;
}

/** What a value is, in words, and the group it holds, if it holds one. */
function describeType(bundle, node, where, problems) {
  const chain = chainOf(bundle, node, where, problems);
  for (const {name} of chain) {
    if (name === null) {
      continue;
    }
    const value = VALUE_BY_DEF.get(name);
    if (value !== undefined) {
      return {words: `[${value.noun}](#${slug(value.title)})`, noun: 'text', group: null, list: null, chain};
    }
    const group = GROUP_BY_DEF.get(name);
    if (group !== undefined) {
      if (group.positions !== undefined) {
        return {
          words: `${article(group.noun).replace(group.noun, groupLink(group, group.noun))}: a list of ${countWords(group.positions.length, 'number', 'numbers')}`,
          noun: 'a list',
          group,
          list: null,
          chain,
        };
      }
      const schema = bundle.$defs[name];
      const noun = schema.type === 'object' ? 'a mapping' : 'text or a mapping';
      return {words: article(group.noun).replace(group.noun, groupLink(group, group.noun)), noun, group, list: null, chain};
    }
  }
  const last = chain.at(-1).schema;
  if (last.type === 'array' && last.items !== undefined && last.prefixItems === undefined) {
    const items = describeType(bundle, last.items, `${where}/items`, problems);
    if (items.group === null || items.group.plural === undefined) {
      problems.push(`${where}: a list whose items are not a group of fields cannot be described`);
      return {words: 'a list', noun: 'a list', group: null, list: null, chain};
    }
    return {words: `a list of ${groupLink(items.group, items.group.plural)}`, noun: 'a list', group: null, list: items.group, chain};
  }
  switch (last.type) {
    case 'string':
      return {words: 'text', noun: 'text', group: null, list: null, chain};
    case 'boolean':
      return {words: '`true` or `false`', noun: '`true` or `false`', group: null, list: null, chain};
    case 'integer':
      return {words: 'a whole number', noun: 'a whole number', group: null, list: null, chain};
    case 'number':
      return {words: 'a number', noun: 'a finite number', group: null, list: null, chain};
    default:
      break;
  }
  if (last.type === undefined && last.const !== undefined) {
    return {words: inlineValue(last.const), noun: null, group: null, list: null, chain};
  }
  problems.push(`${where}: its type cannot be described`);
  return {words: 'a value', noun: 'a value', group: null, list: null, chain};
}

/** The limits a value's schema and the definitions it reaches put on it. */
function limitsOf(chain, where, problems) {
  const limits = {enum: null, const: undefined, patterns: [], minLength: null, minimum: null, maximum: null, exclusiveMinimum: null, minItems: null, maxItems: null, default: undefined, textFile: null};
  for (const {name, schema} of chain) {
    if (name !== null && GROUP_BY_DEF.has(name)) {
      // A group's own limits are described with the group; only its default is the field's.
      if (schema.default !== undefined && limits.default === undefined) {
        limits.default = schema.default;
      }
      break;
    }
    for (const key of ['enum', 'minLength', 'minimum', 'maximum', 'exclusiveMinimum', 'minItems', 'maxItems']) {
      if (schema[key] !== undefined && limits[key] === null) {
        limits[key] = schema[key];
      }
    }
    if (schema.const !== undefined && limits.const === undefined) {
      limits.const = schema.const;
    }
    if (schema.default !== undefined && limits.default === undefined) {
      limits.default = schema.default;
    }
    if (typeof schema.pattern === 'string') {
      limits.patterns.push(schema.pattern);
    }
    if (schema.if !== undefined || schema.then !== undefined) {
      // C05: `if` a pattern `then` a definition, the text value's file rule.
      const test = schema.if;
      const then = schema.then;
      const target = typeof then?.$ref === 'string' ? then.$ref.replace('#/$defs/', '') : null;
      if (
        test?.type === 'string' &&
        typeof test.pattern === 'string' &&
        Object.keys(test).length === 2 &&
        then !== undefined &&
        Object.keys(then).length === 1 &&
        target !== null &&
        VALUE_BY_DEF.has(target)
      ) {
        limits.textFile = {pattern: test.pattern, then: VALUE_BY_DEF.get(target)};
      } else {
        problems.push(`${where}: an if/then other than "a pattern, then a value type" cannot be described`);
      }
    }
  }
  return limits;
}

function patternWords(pattern, where, problems) {
  const words = PATTERN_WORDS[pattern];
  if (words === undefined) {
    problems.push(`${where}: the pattern ${JSON.stringify(pattern)} has no words in PATTERN_WORDS`);
    return {short: 'a pattern', long: 'a pattern', broken: 'refused by its pattern'};
  }
  return words;
}

const VISIBLE_PATTERN = Object.keys(PATTERN_WORDS)[0];

/** The limits in words, and the violations they define. */
function limitWords(type, limits, where, problems, {long = false, one = 'item', plural = 'items'} = {}) {
  const allowed = [];
  const broken = [];
  if (limits.enum !== null) {
    const values = limits.enum.map((value) => yamlOf(value));
    allowed.push(values.length === 2 ? codes(values, 'or') : `one of ${codes(values, 'or')}`);
    broken.push({kind: 'value', phrase: 'not one of those values'});
  }
  if (limits.const !== undefined) {
    allowed.push(`${inlineValue(limits.const)} only`);
    broken.push({kind: 'value', phrase: `anything but ${inlineValue(limits.const)}`});
  }
  for (const pattern of limits.patterns) {
    const words = patternWords(pattern, where, problems);
    allowed.push(long ? words.long : words.short);
    broken.push({kind: pattern === VISIBLE_PATTERN ? 'blank' : 'value', phrase: words.broken});
  }
  if (limits.minLength !== null && !(limits.minLength === 1 && limits.patterns.includes(VISIBLE_PATTERN))) {
    allowed.push(limits.minLength === 1 ? 'not empty' : `at least ${countWords(limits.minLength, 'character', 'characters')}`);
    broken.push({kind: 'value', phrase: limits.minLength === 1 ? 'empty' : 'too short'});
  }
  if (limits.textFile !== null) {
    const words = patternWords(limits.textFile.pattern, where, problems);
    allowed.push(
      `a value that ${words.short} is read as a file and must then be a [${limits.textFile.then.noun}](#${slug(limits.textFile.then.title)}); any other value is the text itself`,
    );
    broken.push({kind: 'value', phrase: `a malformed ${limits.textFile.then.noun}`});
  }
  const low = limits.minimum ?? limits.exclusiveMinimum;
  if (low !== null || limits.maximum !== null) {
    const lowWords = limits.minimum !== null ? `${numbers.format(limits.minimum)}` : `more than ${numbers.format(limits.exclusiveMinimum)}`;
    if (low !== null && limits.maximum !== null) {
      allowed.push(limits.minimum !== null ? `from ${lowWords} to ${numbers.format(limits.maximum)}` : `${lowWords} and at most ${numbers.format(limits.maximum)}`);
    } else if (low !== null) {
      allowed.push(limits.minimum !== null ? `${lowWords} or more` : lowWords);
    } else {
      allowed.push(`at most ${numbers.format(limits.maximum)}`);
    }
    const under = limits.minimum !== null ? `less than ${numbers.format(limits.minimum)}` : `${numbers.format(limits.exclusiveMinimum)} or less`;
    const over = limits.maximum !== null ? `more than ${numbers.format(limits.maximum)}` : null;
    broken.push({kind: 'value', phrase: low !== null && over !== null ? 'outside that range' : low !== null ? under : over});
  }
  if (limits.minItems !== null || limits.maxItems !== null) {
    const {minItems: min, maxItems: max} = limits;
    if (min !== null && max !== null && min === max) {
      allowed.push(`exactly ${countWords(min, one, plural)}`);
      broken.push({kind: 'count', phrase: `not exactly ${countWords(min, one, plural)}`});
    } else {
      allowed.push(
        min !== null && max !== null
          ? `from ${numbers.format(min)} to ${numbers.format(max)} ${plural}`
          : min !== null
            ? `at least ${countWords(min, one, plural)}`
            : `at most ${countWords(max, one, plural)}`,
      );
      if (min === 1) {
        broken.push({kind: 'count', phrase: 'empty'});
      } else if (min !== null) {
        broken.push({kind: 'count', phrase: `fewer than ${countWords(min, one, plural)}`});
      }
      if (max !== null) {
        broken.push({kind: 'count', phrase: `more than ${countWords(max, one, plural)}`});
      }
    }
  }
  if (type.noun !== null) {
    broken.unshift({kind: 'type', phrase: `not ${type.noun}`});
  }
  return {allowed, broken};
}

// ------------------------------------------------------- object analysis ---

function push(map, key, value) {
  const list = map.get(key) ?? [];
  list.push(value);
  map.set(key, list);
}

function requiredOnly(schema) {
  return (
    typeof schema === 'object' &&
    schema !== null &&
    Object.keys(schema).length === 1 &&
    Array.isArray(schema.required) &&
    schema.required.length === 1
  );
}

/** What an object definition says about its fields beyond each field's own schema. */
function analyseObject(schema, where, problems, {layoutRules = false} = {}) {
  const info = {
    required: new Set(schema.required ?? []),
    exclusive: [],
    oneKind: false,
    requiredWhen: new Map(),
    needs: new Map(),
    forbiddenWhen: new Map(),
  };
  const allowed = new Set(['type', 'description', 'properties', 'required', 'additionalProperties', 'oneOf', 'allOf', 'minProperties', 'maxProperties', '$comment']);
  for (const key of Object.keys(schema)) {
    if (!allowed.has(key)) {
      problems.push(`${where}: ${key} on a group of fields cannot be described`);
    }
  }
  if (schema.type !== 'object' || typeof schema.properties !== 'object') {
    problems.push(`${where}: a group of fields must be an object with properties`);
  }
  if (schema.additionalProperties !== false) {
    problems.push(`${where}: an object that accepts fields it does not list cannot be described`);
  }
  for (const name of info.required) {
    if (!Object.hasOwn(schema.properties ?? {}, name)) {
      problems.push(`${where}: requires ${name}, which it does not define`);
    }
  }
  if (schema.oneOf !== undefined) {
    if (schema.oneOf.every(requiredOnly)) {
      info.exclusive.push(schema.oneOf.map((branch) => branch.required[0]));
    } else {
      problems.push(`${where}/oneOf: only a choice of exactly one field can be described`);
    }
  }
  if (schema.minProperties !== undefined || schema.maxProperties !== undefined) {
    if (schema.minProperties === 1 && schema.maxProperties === 1) {
      info.oneKind = true;
      info.exclusive.push(Object.keys(schema.properties ?? {}));
    } else {
      problems.push(`${where}: only minProperties and maxProperties of 1, exactly one field, can be described`);
    }
  }
  for (const [index, rule] of (schema.allOf ?? []).entries()) {
    const at = `${where}/allOf/${index}`;
    if (layoutRules) {
      continue;
    }
    const keys = Object.keys(rule).filter((key) => key !== '$comment');
    if (keys.length !== 2 || rule.if === undefined || rule.then === undefined) {
      problems.push(`${at}: only an if/then pair can be described`);
      continue;
    }
    if (requiredOnly(rule.if) && requiredOnly(rule.then)) {
      const given = rule.if.required[0];
      const needed = rule.then.required[0];
      push(info.needs, given, needed);
      push(info.requiredWhen, needed, given);
      continue;
    }
    const test = rule.if;
    const property = Object.keys(test.properties ?? {});
    const forbidden = rule.then.not;
    if (
      property.length === 1 &&
      Object.keys(test).sort().join() === 'properties,required' &&
      test.required.length === 1 &&
      test.required[0] === property[0] &&
      Object.keys(test.properties[property[0]]).join() === 'const' &&
      Object.keys(rule.then).join() === 'not' &&
      requiredOnly(forbidden)
    ) {
      push(info.forbiddenWhen, forbidden.required[0], {field: property[0], value: test.properties[property[0]].const});
      continue;
    }
    problems.push(`${at}: this if/then cannot be described`);
  }
  return info;
}

// --------------------------------------------------------------- layouts ---

/**
 * The deck's layout rules, read from the `if`/`then` pairs of
 * `$defs/slide/allOf`: for each layout and each field a rule names, whether
 * the field is required (and how many items), one of a pair, or not allowed.
 */
export function layoutRules(bundle, problems = []) {
  const where = '#/$defs/slide/allOf';
  const layouts = bundle.$defs?.layout?.enum;
  const slide = bundle.$defs?.slide;
  if (!Array.isArray(layouts) || slide === undefined) {
    problems.push(`${where}: the deck schema has no layout enum or slide definition`);
    return {layouts: [], fields: [], cells: new Map(), ids: new Map()};
  }
  const cells = new Map(layouts.map((layout) => [layout, new Map()]));
  const ids = new Map();
  const cell = (layout, field) => {
    const row = cells.get(layout);
    if (!row.has(field)) {
      row.set(field, {required: false, count: null, oneOf: null, forbidden: false});
    }
    return row.get(field);
  };
  for (const [index, rule] of (slide.allOf ?? []).entries()) {
    const at = `${where}/${index}`;
    const test = rule.if;
    const layout = test?.properties?.layout;
    const on = layout?.const !== undefined ? [layout.const] : Array.isArray(layout?.enum) ? layout.enum : null;
    if (
      on === null ||
      Object.keys(test).sort().join() !== 'properties,required,type' ||
      test.type !== 'object' ||
      Object.keys(test.properties).join() !== 'layout' ||
      test.required.join() !== 'layout' ||
      Object.keys(rule).filter((key) => key !== '$comment').sort().join() !== 'if,then'
    ) {
      problems.push(`${at}: only "if the layout is one of these, then" can be described`);
      continue;
    }
    for (const name of on) {
      if (!cells.has(name)) {
        problems.push(`${at}: names the layout ${name}, which is not in the layout enum`);
      }
    }
    const then = rule.then;
    const governed = [];
    for (const key of Object.keys(then)) {
      if (key === 'required') {
        for (const field of then.required) {
          governed.push(field);
          on.forEach((name) => (cell(name, field).required = true));
        }
      } else if (key === 'properties') {
        for (const [field, schema] of Object.entries(then.properties)) {
          governed.push(field);
          if (schema === false) {
            on.forEach((name) => (cell(name, field).forbidden = true));
          } else if (
            Object.keys(schema).sort().join() === 'maxItems,minItems,type' &&
            schema.type === 'array' &&
            schema.minItems === schema.maxItems
          ) {
            on.forEach((name) => (cell(name, field).count = schema.minItems));
          } else {
            problems.push(`${at}/then/properties/${field}: only false or an exact count can be described`);
          }
        }
      } else if (key === 'oneOf' && then.oneOf.every(requiredOnly)) {
        const members = then.oneOf.map((branch) => branch.required[0]);
        for (const field of members) {
          governed.push(field);
          on.forEach((name) => (cell(name, field).oneOf = members));
        }
      } else {
        problems.push(`${at}/then/${key}: cannot be described`);
      }
    }
    const found = typeof rule.$comment === 'string' ? rule.$comment.match(/\b[CR]\d{2}\b/g) ?? [] : [];
    for (const field of governed) {
      const list = ids.get(field) ?? new Set();
      found.forEach((id) => list.add(id));
      ids.set(field, list);
    }
  }
  const fields = Object.keys(slide.properties ?? {}).filter((field) => layouts.some((layout) => cells.get(layout)?.has(field)));
  for (const layout of layouts) {
    for (const [field, value] of cells.get(layout)) {
      if (value.forbidden && (value.required || value.count !== null || value.oneOf !== null)) {
        problems.push(`${where}: ${field} is both required and not allowed on a ${layout} slide`);
      }
      if (!Object.hasOwn(slide.properties ?? {}, field)) {
        problems.push(`${where}: governs ${field}, which a slide does not define`);
      }
    }
  }
  return {layouts, fields, cells, ids};
}

function layoutCell(value) {
  if (value === undefined) {
    return 'optional';
  }
  if (value.forbidden) {
    return '—';
  }
  if (value.oneOf !== null) {
    return `exactly one of ${codes(value.oneOf)}`;
  }
  if (value.count !== null) {
    return `required, exactly ${numbers.format(value.count)}`;
  }
  return value.required ? 'required' : 'optional';
}

function slides(layouts) {
  return `${article(codes(layouts, 'or'))} slide`;
}

/** What the layout rules say about one slide field, in words, and the violations they define. */
function layoutRequirement(rules, field) {
  const on = (test) => rules.layouts.filter((layout) => test(rules.cells.get(layout).get(field)));
  const required = on((value) => value !== undefined && (value.required || value.count !== null) && value.oneOf === null);
  const paired = on((value) => value?.oneOf !== null && value?.oneOf !== undefined);
  const forbidden = on((value) => value?.forbidden === true);
  const words = [];
  const broken = [];
  if (required.length > 0) {
    const counted = required.map((layout) => {
      const count = rules.cells.get(layout).get(field).count;
      return count === null ? code(layout) : `${code(layout)} (exactly ${numbers.format(count)})`;
    });
    words.push(required.length === 1 ? `yes on ${article(counted[0])} slide` : `yes on ${listWords(counted)} slides`);
    broken.push({kind: 'missing', phrase: `missing on ${slides(required)}`});
    if (required.some((layout) => rules.cells.get(layout).get(field).count !== null)) {
      broken.push({kind: 'count', phrase: 'a list of the wrong length for the layout'});
    }
  }
  if (paired.length > 0) {
    const members = rules.cells.get(paired[0]).get(field).oneOf;
    const others = members.filter((member) => member !== field);
    words.push(`on ${slides(paired)}, exactly one of ${codes(members)}`);
    broken.push({kind: 'missing', phrase: `missing on ${slides(paired)} that has no ${codes(others, 'or')}`});
    broken.push({kind: 'both', phrase: `given together with ${codes(others)}`});
  }
  if (forbidden.length > 0) {
    const rest = rules.layouts.length - required.length - paired.length === forbidden.length;
    words.push(rest ? 'not allowed on any other layout' : `not allowed on ${slides(forbidden)}`);
    broken.push({kind: 'forbidden', phrase: rest ? 'given on any other layout' : `given on ${slides(forbidden)}`});
  }
  return {words: `${words.join('; ')} (see [Layouts](#layouts))`, broken};
}

// ---------------------------------------------------------------- entries ---

/** Whether and when a field is required, in words, and the violations that defines. */
function requirementOf(info, name, layout) {
  const broken = [];
  let words;
  if (layout !== null) {
    return layoutRequirement(layout, name);
  }
  const exclusive = info.exclusive.find((set) => set.includes(name));
  if (info.required.has(name)) {
    words = 'yes';
    broken.push({kind: 'missing', phrase: 'missing'});
  } else if (info.requiredWhen.has(name) && exclusive === undefined) {
    // One of a choice is described by the choice; the pair it needs is said below.
    const given = info.requiredWhen.get(name);
    words = `yes when ${codes(given, 'or')} is given`;
    broken.push({kind: 'missing', phrase: `missing while ${codes(given, 'or')} is given`});
  } else if (exclusive !== undefined) {
    const others = exclusive.filter((member) => member !== name);
    if (info.oneKind) {
      words = 'exactly one kind per block';
      broken.push({kind: 'both', phrase: 'given together with another kind'});
    } else if (others.length === 1) {
      words = `one of ${codes(exclusive)}, never both`;
      broken.push({kind: 'missing', phrase: `missing while ${code(others[0])} is not given`});
      broken.push({kind: 'both', phrase: `given together with ${code(others[0])}`});
    } else {
      words = `exactly one of ${codes(exclusive)}`;
      broken.push({kind: 'both', phrase: `given together with any of ${codes(others)}`});
    }
  } else {
    words = 'no';
  }
  const needs = info.needs.get(name);
  if (needs !== undefined) {
    words += `; only together with ${codes(needs)}`;
    broken.push({kind: 'forbidden', phrase: `given without ${codes(needs)}`});
  }
  for (const {field, value} of info.forbiddenWhen.get(name) ?? []) {
    words += `; not allowed when ${code(field)} is ${inlineValue(value)}`;
    broken.push({kind: 'forbidden', phrase: `given while ${code(field)} is ${inlineValue(value)}`});
  }
  return {words, broken};
}

const KIND_ORDER = ['missing', 'forbidden', 'both', 'type', 'blank', 'value', 'count'];

/** Each rule that can report on a field, with the conditions it reports: the schema's first, then the later checks'. */
function rulesOf(groupKey, field, broken, later) {
  const byRule = new Map();
  const add = (rule, phrase) => {
    const phrases = byRule.get(rule) ?? [];
    if (!phrases.includes(phrase)) {
      phrases.push(phrase);
    }
    byRule.set(rule, phrases);
  };
  const sorted = [...broken].sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
  for (const item of sorted) {
    add(ruleFor(groupKey, field, item.kind), item.phrase);
  }
  for (const check of later) {
    add(check.rule, check.text);
  }
  return [...byRule].map(([rule, phrases]) => ({rule, text: conditionWords(phrases)}));
}

function jsonPointer(segments) {
  return `#/${segments.map((segment) => String(segment).replaceAll('~', '~0').replaceAll('/', '~1')).join('/')}`;
}

/** The key the coverage test reads: template-qualified for a template's top level, bare for a definition. */
function pointerKey(template, segments) {
  return segments[0] === '$defs' ? jsonPointer(segments) : `${template}${jsonPointer(segments)}`;
}

// ------------------------------------------------------------ generation ---

/**
 * The reference for the schemas under `toolRoot`, generated with the built
 * core: `{markdown, sections, problems, unreferenced}`. `problems` lists
 * everything that stops the run; the markdown is only meant to be written
 * when it is empty.
 */
export function generate(core, toolRoot = APPLICATION_ROOT) {
  const problems = [];
  const bundles = {};
  for (const template of TEMPLATES) {
    bundles[template] = core.bundledSchema(template, toolRoot);
    scanKeywords(bundles[template], `${template}#`, problems);
  }
  const versions = new Set(TEMPLATES.map((template) => /\/schema\/(\d+)\//.exec(String(bundles[template].$id))?.[1] ?? null));
  if (versions.size !== 1 || versions.has(null)) {
    problems.push(`the templates' $ids do not name one schema version: ${[...versions].join(', ')}`);
  }
  const version = [...versions][0];

  const ajv = core.createAjv();
  for (const template of TEMPLATES) {
    ajv.addSchema(bundles[template]);
  }
  const usedExamples = new Set();
  const validates = (template, segments, value, label) => {
    let validate;
    try {
      validate = ajv.getSchema(`${bundles[template].$id}${jsonPointer(segments)}`);
    } catch (error) {
      problems.push(`${label}: its schema does not compile (${error.message})`);
      return;
    }
    if (validate === undefined) {
      problems.push(`${label}: ${jsonPointer(segments)} is not in the ${template} schema`);
    } else if (validate(value) !== true) {
      problems.push(`${label}: the example ${JSON.stringify(value)} does not validate against its schema (${ajv.errorsText(validate.errors)})`);
    }
  };
  const exampleOf = (key, label) => {
    usedExamples.add(key);
    if (!Object.hasOwn(EXAMPLES, key)) {
      problems.push(`${label}: has no example (EXAMPLES['${key}'])`);
      return null;
    }
    return EXAMPLES[key];
  };

  const layout = layoutRules(bundles.deck, problems);
  // A rule a layout rule's comment names must be the rule this script says reports it.
  for (const [field, ids] of layout.ids) {
    for (const id of [...ids].filter((item) => item.startsWith('R'))) {
      const rules = new Set(['missing', 'forbidden', 'count', 'both'].map((kind) => ruleFor('slide', field, kind)));
      if (!rules.has(id)) {
        problems.push(`#/$defs/slide/allOf: a comment names ${id} for ${field}, and ruleFor gives ${[...rules].join(', ')}`);
      }
    }
  }
  const usedBy = new Map();
  const entries = new Map(GROUPS.map((group) => [group.key, []]));
  const intros = new Map();

  /** One field's entry, from its schema in one bundle. */
  const fieldEntry = (group, template, name, node, segments, info, {requirement = null, description = null, pointers = null, example = undefined, typed = true} = {}) => {
    const bundle = bundles[template];
    const label = pointerKey(template, segments);
    const type = describeType(bundle, node, label, problems);
    const limits = limitsOf(type.chain, label, problems);
    const one = type.list?.one ?? type.list?.noun ?? 'item';
    const plural = type.list?.plural ?? 'items';
    const words = limitWords(type, limits, label, problems, {one, plural});
    if (type.group?.positions !== undefined) {
      const count = type.group.positions.length;
      words.allowed.push(`exactly ${countWords(count, 'number', 'numbers')}, ${codes(type.group.positions)}, as the ${groupLink(type.group, type.group.noun)} describes them`);
      words.broken.push({kind: 'count', phrase: `not exactly ${countWords(count, 'number', 'numbers')}`});
    } else if (type.group !== null) {
      words.allowed.push(`the fields of ${article(type.group.noun).replace(type.group.noun, groupLink(type.group, type.group.noun))}`);
    } else if (type.list !== null) {
      words.allowed.push(`each one ${article(one).replace(one, groupLink(type.list, one))}`);
    }
    if (words.allowed.length === 0) {
      words.allowed.push(type.words);
    }
    const required = requirement ?? requirementOf(info, name, group.key === 'slide' && layout.fields.includes(name) ? layout : null);
    const reached = type.chain.map((link) => link.name).filter((linkName) => linkName !== null);
    const broken = [...required.broken, ...words.broken].filter((item) => typed || item.kind !== 'type');
    const rules = rulesOf(group.key, name, broken, laterChecks(group.key, name, reached));
    const text = description ?? node.description;
    if (typeof text !== 'string' || text.trim() === '') {
      problems.push(`${label}: has no description`);
    } else if (/^(?:[#>*+-]|\d+[.)])\s/.test(text)) {
      problems.push(`${label}: its description starts like Markdown structure`);
    }
    const value = example === undefined ? exampleOf(`${group.key}.${name}`, label) : example;
    const heading = `${code(name)} (${group.noun})`;
    const target = type.group ?? type.list;
    if (target !== null) {
      push(usedBy, target.key, `[${code(name)} (${group.noun})](#${slug(heading)})`);
    }
    return {
      heading,
      anchor: slug(heading),
      name,
      pointers: pointers ?? [label],
      type: type.words,
      required: required.words,
      default: limits.default === undefined ? '—' : inlineValue(limits.default),
      allowed: words.allowed.join('; '),
      rules,
      description: text,
      example: value === null ? '' : yamlOf({[name]: value}),
      value,
    };
  };

  for (const group of GROUPS) {
    const list = entries.get(group.key);
    if (group.common) {
      // The fields every template defines, described once, with a line per template where their descriptions differ.
      const names = Object.keys(bundles.deck.properties).filter((name) => TEMPLATES.every((template) => Object.hasOwn(bundles[template].properties, name)));
      for (const name of names) {
        const nodes = TEMPLATES.map((template) => bundles[template].properties[name]);
        const shape = (node) => JSON.stringify({...node, description: undefined, const: undefined});
        const consts = nodes.map((node) => node.const);
        if (new Set(nodes.map(shape)).size !== 1) {
          problems.push(`${name}: a field every template takes must have one shape, apart from its description and a constant`);
        }
        const descriptions = nodes.map((node) => node.description);
        const description =
          new Set(descriptions).size === 1
            ? descriptions[0]
            : TEMPLATES.map((template, index) => `In a ${template}: ${descriptions[index]}`).join('\n\n');
        const requiredIn = TEMPLATES.filter((template) => (bundles[template].required ?? []).includes(name));
        const requirement =
          requiredIn.length === TEMPLATES.length
            ? {words: 'yes', broken: [{kind: 'missing', phrase: 'missing'}]}
            : requiredIn.length === 0
              ? {words: 'no', broken: []}
              : {words: `yes in ${listWords(requiredIn.map((template) => `a ${template}`))}`, broken: [{kind: 'missing', phrase: `missing in ${listWords(requiredIn.map((template) => `a ${template}`), 'or')}`}]};
        const example = exampleOf(`piece.${name}`, `common#/properties/${name}`);
        const entry = fieldEntry(group, 'deck', name, nodes[0], ['properties', name], null, {
          requirement,
          description,
          pointers: TEMPLATES.map((template) => pointerKey(template, ['properties', name])),
          example,
        });
        if (consts.some((value) => value !== undefined)) {
          entry.allowed = `${listWords(TEMPLATES.map((template, index) => `${inlineValue(consts[index])} in a ${template}`))}: the template the manifest is for`;
          entry.rules = rulesOf(group.key, name, [...requirement.broken, {kind: 'type', phrase: 'not text'}, {kind: 'value', phrase: 'not the name of a template'}], []);
        }
        for (const [index, template] of TEMPLATES.entries()) {
          if (consts[index] === undefined || consts[index] === example) {
            validates(template, ['properties', name], example, `${template}#/properties/${name}`);
          }
        }
        list.push(entry);
      }
      intros.set(group.key, {
        text: `Every template takes these fields at the top level of its manifest; ${codes(names.filter((name) => TEMPLATES.every((template) => (bundles[template].required ?? []).includes(name))))} are required in each.`,
      });
      continue;
    }
    if (group.root !== undefined) {
      const bundle = bundles[group.root];
      const own = Object.fromEntries(Object.entries(bundle).filter(([key]) => !['$schema', '$id', 'title', '$defs'].includes(key)));
      const info = analyseObject(own, `${group.root}#`, problems);
      const common = entries.get('piece').map((entry) => entry.name);
      for (const [name, node] of Object.entries(bundle.properties)) {
        if (common.includes(name)) {
          continue;
        }
        const entry = fieldEntry(group, group.root, name, node, ['properties', name], info);
        validates(group.root, ['properties', name], entry.value, entry.pointers[0]);
        list.push(entry);
      }
      intros.set(group.key, {text: `A ${group.root} manifest takes the [common fields](#common-fields) and these. Any other field is R09 at its line.`});
      continue;
    }
    if (group.layouts) {
      continue;
    }
    const found = bundleWith(bundles, group.def);
    if (found === null) {
      problems.push(`$defs/${group.def}: no template defines it`);
      continue;
    }
    const {template, bundle} = found;
    const schema = bundle.$defs[group.def];
    const base = ['$defs', group.def];
    if (group.positions !== undefined) {
      const expected = ['type', 'description', 'prefixItems', 'items', 'minItems', 'maxItems', 'default'];
      for (const key of Object.keys(schema)) {
        if (!expected.includes(key)) {
          problems.push(`${jsonPointer(base)}: ${key} on a list of numbers cannot be described`);
        }
      }
      const count = group.positions.length;
      if (schema.type !== 'array' || schema.items !== false || schema.minItems !== count || schema.maxItems !== count || schema.prefixItems?.length !== count) {
        problems.push(`${jsonPointer(base)}: must be exactly ${count} numbers, as the reference names them`);
      }
      const parent = exampleOf(group.exampleFrom, jsonPointer(base));
      for (const [index, position] of group.positions.entries()) {
        const node = schema.prefixItems?.[index] ?? {};
        const segments = [...base, 'prefixItems', index];
        const value = Array.isArray(parent) ? parent[index] : null;
        const field = group.exampleFrom.split('.')[1];
        const entry = fieldEntry(group, template, position, node, segments, null, {
          requirement: {words: `yes: number ${index + 1} of ${count}`, broken: []},
          example: value,
        });
        entry.example = `${yamlOf({[field]: parent})}   # ${position} is ${yamlOf(value)}`;
        entry.default = Array.isArray(schema.default) ? inlineValue(schema.default[index]) : '—';
        validates(template, segments, value, entry.pointers[0]);
        list.push(entry);
      }
      intros.set(group.key, {
        text: schema.description,
        limits: [
          `A list of exactly ${countWords(count, 'number', 'numbers')}, in this order: ${codes(group.positions)}; ${ruleFor(group.key, '', 'count')} if it is not a list of ${countWords(count, 'number', 'numbers')}.`,
          ...(schema.default === undefined ? [] : [`When it is left out, the default is ${inlineValue(schema.default)}.`]),
        ],
      });
      continue;
    }
    if (schema.oneOf !== undefined && schema.type === undefined) {
      // An either-form definition: a value or an object of fields.
      const forms = schema.oneOf;
      const expected = ['description', 'oneOf'];
      for (const key of Object.keys(schema)) {
        if (!expected.includes(key)) {
          problems.push(`${jsonPointer(base)}: ${key} beside a choice of forms cannot be described`);
        }
      }
      const described = [];
      const examples = [];
      for (const [index, form] of forms.entries()) {
        const segments = [...base, 'oneOf', index];
        if (form.type === 'object') {
          const info = analyseObject(form, jsonPointer(segments), problems);
          const example = exampleOf(`${group.key}.${index}`, jsonPointer(segments));
          validates(template, segments, example, jsonPointer(segments));
          examples.push(example);
          described.push(`Form ${index + 1}, a mapping: ${form.description} It takes the fields ${codes(Object.keys(form.properties))}; any other field is R09.`);
          for (const [name, node] of Object.entries(form.properties)) {
            const entry = fieldEntry(group, template, name, node, [...segments, 'properties', name], info);
            validates(template, [...segments, 'properties', name], entry.value, entry.pointers[0]);
            list.push(entry);
          }
        } else {
          // Which form a value takes is one question: a value that is neither is the choice's R09, said with the group.
          const entry = fieldEntry(group, template, String(index), form, segments, null, {
            requirement: {words: `one of the ${countWords(forms.length, 'form', 'forms')}`, broken: []},
            typed: false,
          });
          entry.heading = `The header name alone (${group.noun})`;
          entry.anchor = slug(entry.heading);
          entry.example = yamlOf([entry.value], {flow: false});
          validates(template, segments, entry.value, entry.pointers[0]);
          examples.push(entry.value);
          described.push(`Form ${index + 1}, text: ${form.description}`);
          list.unshift(entry);
        }
      }
      const kinds = forms.map((form) => (form.type === 'object' ? 'a mapping' : 'text'));
      intros.set(group.key, {
        text: schema.description,
        limits: [...described, `A value that is neither ${listWords(kinds, 'nor')} is R09.`],
        example: yamlOf(examples, {flow: false}),
      });
      continue;
    }
    const info = analyseObject(schema, jsonPointer(base), problems, {layoutRules: group.key === 'slide'});
    for (const [name, node] of Object.entries(schema.properties ?? {})) {
      const entry = fieldEntry(group, template, name, node, [...base, 'properties', name], info);
      validates(template, [...base, 'properties', name], entry.value, entry.pointers[0]);
      list.push(entry);
    }
    const limits = [`Any field not listed here is R09 at its line.`];
    for (const set of info.exclusive) {
      const rule = ruleFor(group.key, set[0], 'both');
      limits.push(
        info.oneKind
          ? `Exactly one kind per block: a block with none, or with two, is ${rule}.`
          : `Exactly one of ${codes(set)}: none, or ${set.length === 2 ? 'both' : 'more than one'}, is ${rule}.`,
      );
    }
    if (Object.hasOwn(schema.properties ?? {}, 'alt') && !Object.hasOwn(schema.properties ?? {}, 'decorative')) {
      const rule = ruleFor(group.key, 'decorative', 'forbidden');
      if (rule !== 'R09') {
        limits.push(`${article(group.noun).replace(/^./, (letter) => letter.toUpperCase())} cannot be marked decorative: \`decorative\` here is ${rule}, not R09.`);
      }
    }
    intros.set(group.key, {text: schema.description, limits});
  }

  for (const key of Object.keys(EXAMPLES)) {
    if (!usedExamples.has(key)) {
      problems.push(`EXAMPLES['${key}'] is not the example of any field`);
    }
  }

  // Every object, list of numbers or either-form definition a template reaches must be a group.
  const reachable = new Set();
  const reach = (template, node) => {
    if (typeof node !== 'object' || node === null) {
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item) => reach(template, item));
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref' && typeof value === 'string' && value.startsWith('#/$defs/')) {
        const name = value.slice('#/$defs/'.length);
        if (!reachable.has(`${template}:${name}`)) {
          reachable.add(`${template}:${name}`);
          reach(template, bundles[template].$defs?.[name]);
        }
      } else if (key !== '$defs' && key !== 'enum' && key !== 'const' && key !== 'default') {
        reach(template, value);
      }
    }
  };
  for (const template of TEMPLATES) {
    reach(template, {...bundles[template], $defs: undefined});
  }
  const reached = new Set([...reachable].map((item) => item.split(':')[1]));
  for (const template of TEMPLATES) {
    for (const [name, schema] of Object.entries(bundles[template].$defs ?? {})) {
      const shaped = schema.type === 'object' || schema.prefixItems !== undefined || (Array.isArray(schema.oneOf) && schema.oneOf.some((form) => form.type === 'object'));
      if (reached.has(name) && shaped && !GROUP_BY_DEF.has(name)) {
        problems.push(`$defs/${name}: a template reaches it, and the reference has no group for it`);
      }
    }
  }
  const defined = new Set(TEMPLATES.flatMap((template) => Object.keys(bundles[template].$defs ?? {})));
  const unreferenced = [...defined].filter((name) => !reached.has(name)).sort();

  const markdown = render({core, toolRoot, version, bundles, entries, intros, usedBy, layout, problems});
  const sections = SECTIONS.map((section) => {
    const groups = GROUPS.filter((group) => group.section === section.key);
    const sectionEntries = groups.flatMap((group) => entries.get(group.key));
    return {
      key: section.key,
      title: section.title,
      properties: sectionEntries.flatMap((entry) => entry.pointers),
      entries: sectionEntries.map((entry) => ({heading: entry.heading, anchor: entry.anchor, pointers: entry.pointers, rules: entry.rules, description: entry.description})),
    };
  });
  return {markdown, sections, problems, unreferenced};
}

// ------------------------------------------------------------- rendering ---

function hashOf(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function renderEntry(entry) {
  const lines = [`#### ${entry.heading}`, '', entry.description, ''];
  lines.push(`- **Type:** ${entry.type}`);
  lines.push(`- **Required:** ${entry.required}`);
  lines.push(`- **Default:** ${entry.default}`);
  lines.push(`- **Allowed:** ${entry.allowed}`);
  lines.push('- **Rules:**');
  for (const rule of entry.rules) {
    lines.push(`  - ${rule.rule}: ${rule.text}`);
  }
  lines.push('', '```yaml', entry.example, '```', '');
  return lines;
}

function summaryTable(list) {
  const lines = ['| Field | Type | Required | Default |', '| --- | --- | --- | --- |'];
  for (const entry of list) {
    const name = entry.heading.replace(/ \(.*\)$/, '');
    lines.push(`| [${name}](#${entry.anchor}) | ${entry.type} | ${entry.required.replace(/ \(see \[Layouts\]\(#layouts\)\)$/, '')} | ${entry.default} |`);
  }
  return [...lines, ''];
}

function render({core, toolRoot, version, bundles, entries, intros, usedBy, layout, problems}) {
  const out = [];
  const headings = [];
  const heading = (level, text) => {
    headings.push(slug(text));
    out.push(`${'#'.repeat(level)} ${text}`, '');
  };

  out.push('# Manifest reference', '');
  headings.push(slug('Manifest reference'));
  out.push(
    `Generated by \`scripts/gen-manifest-reference.mjs\` from the schemas below, for manifest schema ${version}. Do not edit it by hand: change the schema, then run \`npm run gen:manifest-reference\`.`,
    '',
    '| Schema | SHA-256 |',
    '| --- | --- |',
  );
  for (const input of INPUTS) {
    out.push(`| \`${input}\` | \`${hashOf(join(toolRoot, input))}\` |`);
  }
  out.push(
    '',
    'A piece has one manifest at the root of its folder: `papeleria.yaml`, or `papeleria.json` with the same fields and values. Field names are lower case, with underscores between words. A field the schema does not list is refused at its line, so a misspelled field is caught.',
    '',
    'Each field below has an entry. **Type** is the kind of value. **Required** says whether the field must be written, and when. **Default** is the value the schema assumes when the field is left out; — means it assumes none, and the description says what happens instead. **Allowed** lists the values and limits the schema enforces. **Rules** names the rule that reports each broken limit, and the checks that read the field after the schema; [Rules](#rules) lists every rule that reads a manifest. The example is YAML.',
    '',
  );
  heading(2, 'Contents');
  for (const section of SECTIONS) {
    out.push(`- [${section.title}](#${slug(section.title)})`);
    for (const group of GROUPS.filter((item) => item.section === section.key)) {
      out.push(`  - [${group.title}](#${slug(group.title)})`);
    }
    if (section.key === 'values') {
      for (const value of VALUES) {
        out.push(`  - [${value.title}](#${slug(value.title)})`);
      }
    }
  }
  out.push('');

  const sectionIntro = {
    common: null,
    deck: bundles.deck.description,
    comic: bundles.comic.description,
    document: bundles.document.description,
    blocks:
      "A block is a mapping with one key, its kind, whose value holds that kind's fields. A document section's `blocks` take every kind; a deck and a comic use some of the same shapes as fields of their own, listed under **Used by**.",
  };
  for (const section of SECTIONS) {
    if (section.key === 'values' || section.key === 'rules') {
      continue;
    }
    heading(2, section.title);
    if (sectionIntro[section.key]) {
      out.push(sectionIntro[section.key], '');
    }
    for (const group of GROUPS.filter((item) => item.section === section.key)) {
      heading(3, group.title);
      if (group.layouts) {
        out.push(...renderLayouts(bundles.deck, layout));
        continue;
      }
      const intro = intros.get(group.key) ?? {};
      if (intro.text) {
        out.push(intro.text, '');
      }
      for (const line of intro.limits ?? []) {
        out.push(`- ${line}`);
      }
      if ((intro.limits ?? []).length > 0) {
        out.push('');
      }
      if (intro.example !== undefined) {
        out.push('```yaml', intro.example, '```', '');
      }
      const users = usedBy.get(group.key);
      if (users !== undefined && !group.common && group.root === undefined) {
        out.push(`Used by: ${users.join(', ')}.`, '');
      }
      const list = entries.get(group.key);
      out.push(...summaryTable(list));
      for (const entry of list) {
        headings.push(entry.anchor);
        out.push(...renderEntry(entry));
      }
    }
  }

  heading(2, 'Values');
  out.push("The value types that fields share. A field's own entry gives the short form of these limits; the rule that reports a broken one is the field's.", '');
  for (const value of VALUES) {
    const found = bundleWith(bundles, value.def);
    if (found === null) {
      problems.push(`$defs/${value.def}: the value type is in no template`);
      continue;
    }
    const schema = found.bundle.$defs[value.def];
    const chain = chainOf(found.bundle, schema, `#/$defs/${value.def}`, problems);
    const type = describeType(found.bundle, {$ref: `#/$defs/${value.def}`}, `#/$defs/${value.def}`, problems);
    const limits = limitsOf(chain, `#/$defs/${value.def}`, problems);
    const words = limitWords(type, limits, `#/$defs/${value.def}`, problems, {long: true});
    heading(3, value.title);
    out.push(schema.description, '');
    out.push(`- **Type:** ${chain.some((link) => link.schema.type === 'string') ? 'text' : 'a value'}`);
    out.push(`- **Allowed:** ${words.allowed.join('; ')}`, '');
  }

  heading(2, 'Rules');
  out.push(...renderRules(core, entries));

  const counts = new Map();
  for (const anchor of headings) {
    counts.set(anchor, (counts.get(anchor) ?? 0) + 1);
  }
  for (const [anchor, seen] of counts) {
    if (seen > 1) {
      problems.push(`the heading anchor #${anchor} is used ${seen} times`);
    }
  }
  const text = `${out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
  for (const match of text.matchAll(/\]\(#([^)]+)\)/g)) {
    if (!counts.has(match[1])) {
      problems.push(`the link #${match[1]} has no heading`);
    }
  }
  return text;
}

function renderLayouts(deck, layout) {
  const lines = [];
  const slide = deck.$defs.slide;
  const common = Object.keys(slide.properties).filter((field) => !layout.fields.includes(field));
  const required = common.filter((field) => (slide.required ?? []).includes(field));
  const optional = common.filter((field) => !(slide.required ?? []).includes(field));
  lines.push(deck.$defs.layout.description, '');
  lines.push(
    `Every layout takes ${codes(required)}, and may take ${codes(optional)}. The table shows the fields that depend on the layout, from the layout rules of the slide schema: "required" fields must be written, "exactly one of" means one of the pair and never both, and — means the layout does not take the field.`,
    '',
  );
  lines.push(`| Layout | ${layout.fields.map(code).join(' | ')} |`, `| --- | ${layout.fields.map(() => '---').join(' | ')} |`);
  for (const name of layout.layouts) {
    const row = layout.cells.get(name);
    lines.push(`| ${code(name)} | ${layout.fields.map((field) => layoutCell(row.get(field))).join(' | ')} |`);
  }
  lines.push('');
  const notes = layout.fields.map((field) => {
    const rules = new Set(['missing', 'forbidden', 'count', 'both'].map((kind) => ruleFor('slide', field, kind)));
    const ids = [...(layout.ids.get(field) ?? [])].filter((id) => id.startsWith('C'));
    return `${code(field)} ${[...rules].join(', ')}${ids.length > 0 ? ` (${ids.join(', ')})` : ''}`;
  });
  lines.push(`A slide that breaks its row is reported as: ${listWords(notes)}.`, '');
  return lines;
}

function renderRules(core, entries) {
  const lines = [
    "The schema check reports a broken limit as R09 at the field's line (a missing field at its container's, IC01), unless a rule of its own owns the field (D149): the alternative text of an image, a comic page or a logo is R03, and a video's R10; a panel's transcript is R04; a chart's summary is R05; a slide's columns are R15, except a value that is not a list; the numbers of a panel box are R14, except a missing box. Each problem is reported once, by one rule. A manifest whose `schema` is newer than this release is R17 alone, before anything else is checked.",
    '',
    'Other checks read the fields once the schema has passed them. Two read the whole piece rather than one field: R01 reports a bracketed placeholder, such as `[Artist]`, left in any text, and R12 an owner-exclusive file copied into the piece. R08 (the generated HTML) and R11 (dependency licences) check the build and the tool, not the manifest, and are not listed.',
    '',
    '| Rule | Severity | What it reports | Fields |',
    '| --- | --- | --- | --- |',
  ];
  const byRule = new Map();
  for (const group of GROUPS) {
    for (const entry of entries.get(group.key) ?? []) {
      for (const rule of entry.rules) {
        push(byRule, rule.rule, `[${entry.heading}](#${entry.anchor})`);
      }
    }
  }
  const rules = [...new Set(['R01', ...byRule.keys(), 'R12'])].sort();
  for (const rule of rules) {
    const severity = SEVERITY_WORDS[rule] ?? core.RULE_SEVERITY[rule];
    const fields =
      rule === 'R09'
        ? 'every field, for every limit no other rule owns, and a field that is not listed'
        : rule === 'R01'
          ? 'every field that holds text, and the Markdown files the manifest names'
          : rule === 'R12'
            ? 'every file in the piece'
            : `${[...new Set(byRule.get(rule))].join(', ')}${rule === 'R07' ? ', and the first view of every page' : ''}`;
    lines.push(`| ${rule} | ${severity} | ${RULE_TITLES[rule]} | ${fields} |`);
  }
  lines.push('');
  return lines;
}

// ------------------------------------------------------------------- main ---

async function loadCore() {
  const entry = join(APPLICATION_ROOT, 'lib', 'src', 'core', 'index.js');
  if (!existsSync(entry)) {
    throw new UsageError(`${relative(APPLICATION_ROOT, entry)} is missing; run npm run build first (npm run gen:manifest-reference does)`);
  }
  return import(pathToFileURL(entry).href);
}

function parseArguments(argv) {
  const options = {check: false, out: DEFAULT_OUT};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--check') {
      options.check = true;
    } else if (flag === '--out') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new UsageError('--out needs a file');
      }
      options.out = resolve(value);
      index += 1;
    } else {
      throw new UsageError(`unknown argument ${JSON.stringify(flag)}`);
    }
  }
  return options;
}

export async function main(argv, out = (line) => process.stdout.write(`${line}\n`), error = (line) => process.stderr.write(`${line}\n`)) {
  let options;
  let core;
  try {
    options = parseArguments(argv);
    core = await loadCore();
  } catch (problem) {
    error(`gen-manifest-reference: ${problem.message}`);
    if (problem instanceof UsageError) {
      error('usage: node scripts/gen-manifest-reference.mjs [--check] [--out <file>]');
    }
    return 2;
  }
  let result;
  try {
    result = generate(core, APPLICATION_ROOT);
  } catch (problem) {
    error(`gen-manifest-reference: ${problem.message}`);
    return 2;
  }
  if (result.problems.length > 0) {
    for (const problem of result.problems) {
      error(`gen-manifest-reference: ${problem}`);
    }
    out(`result: FAIL — ${result.problems.length} problem(s); nothing written`);
    return 1;
  }
  const entries = result.sections.reduce((total, section) => total + section.entries.length, 0);
  const target = relative(APPLICATION_ROOT, options.out) || options.out;
  if (result.unreferenced.length > 0) {
    out(`not referenced by any template, so not described: ${result.unreferenced.join(', ')}`);
  }
  try {
    if (options.check) {
      const current = existsSync(options.out) ? readFileSync(options.out, 'utf8') : null;
      if (current !== result.markdown) {
        error(`gen-manifest-reference: ${target} ${current === null ? 'is missing' : 'is not what the schemas give'}; run npm run gen:manifest-reference`);
        out('result: FAIL — stale');
        return 1;
      }
      out(`checked ${target}: current, ${entries} entries`);
    } else {
      mkdirSync(dirname(options.out), {recursive: true});
      writeFileSync(options.out, result.markdown);
      out(`wrote ${target}: ${entries} entries, ${Buffer.byteLength(result.markdown)} bytes`);
    }
  } catch (problem) {
    error(`gen-manifest-reference: ${problem.message}`);
    return 2;
  }
  out('result: pass');
  return 0;
}

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href) {
  process.exitCode = await main(process.argv.slice(2));
}
