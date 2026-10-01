/**
 * M1.2: validating a loaded manifest against its template's JSON Schema.
 *
 * `templates/<name>/schema.json` (2020-12) reference the shared definitions in
 * `templates/shared/schema-defs.json` by `../shared/schema-defs.json#/$defs/…`;
 * both carry `$id`s that mirror the file layout, so the reference resolves by
 * URI here and by file path in tools that read the files (D148). Ajv runs in
 * strict mode with every error collected.
 *
 * Validation runs on an inlined form of each schema, every `$ref` replaced by
 * the definition it names. Ajv compiles a referenced definition as a function
 * of its own and joins its errors with `concat`, so a manifest with many
 * errors cost time quadratic in their number; inlined, each error is pushed
 * once, and every schema path is absolute (D149).
 *
 * Each Ajv error becomes a finding at an honest location. Errors are classified
 * by where they occur in the manifest (the instance path), their keyword and
 * their schema path, so the instance location is what identifies an image, a
 * chart or a panel wherever it appears. Dedicated rules replace the generic R09
 * for the problems they own — R03 image and logo alternatives, R04
 * transcripts, R05 summaries, R10 video alternatives, R14 panel boxes and R15
 * column counts — and each such problem is reported once. A value of the wrong
 * type is reported by its type error alone: conditions that cannot apply to it
 * (a `oneOf` of required fields, an `if` on its properties) say nothing more.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

import ajv2020Module from 'ajv/dist/2020.js';
import ajvFormatsModule from 'ajv-formats';
import type {ErrorObject, ValidateFunction} from 'ajv';

import {hasErrors, shortenForMessage, traced, type Location, type TracedFinding} from './finding.js';
import type {LoadedManifest} from './manifest.js';
import {classifyLink} from './markdown.js';
import {checkAssetPath, isTextFileReference, locateToolRoot, quoteForMessage, type AssetKind} from './paths.js';
import {joinPointer, nearestEntry, parsePointer, type SourceEntry} from './positions.js';
import {LAYOUT_COLUMNS, LAYOUT_NAMES, ToolResourceError, type LayoutName, type Manifest, type TemplateName} from './types.js';

// ajv and ajv-formats are CommonJS packages whose runtime module.exports is the
// class or function itself while their types describe a namespace (D26).
const Ajv2020 = ajv2020Module as unknown as typeof ajv2020Module.default;
const addFormats = ajvFormatsModule as unknown as typeof ajvFormatsModule.default;

export const TEMPLATE_NAMES: readonly TemplateName[] = Object.freeze(['deck', 'comic', 'document']);

const SHARED_PREFIX = '../shared/schema-defs.json#/$defs/';

export type ValidatedManifest = LoadedManifest & {readonly template: TemplateName; readonly data: Manifest};

/** `manifest` is null when any error was found; the findings say why. */
export type ValidationResult = {readonly manifest: ValidatedManifest | null; readonly findings: readonly TracedFinding[]};

type SchemaSet = {
  readonly shared: Record<string, unknown>;
  readonly templates: Readonly<Record<TemplateName, Record<string, unknown>>>;
  readonly validators: Readonly<Record<TemplateName, ValidateFunction>>;
};

const schemaSets = new Map<string, SchemaSet>();

/** A tool schema file; a missing, unreadable or malformed one is an installation failure, not a finding (IC05). */
function readJson(path: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new ToolResourceError(path, `cannot be read as JSON: ${(error as Error).message}`);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ToolResourceError(path, 'must be a JSON object');
  }
  return value as Record<string, unknown>;
}

/** Ajv as the project configures it everywhere: 2020-12, strict, all errors (D28). */
export function createAjv(): InstanceType<typeof Ajv2020> {
  const ajv = new Ajv2020({
    strict: true,
    strictTypes: true,
    strictTuples: true,
    // An exactly-one-of union states `required` inside a branch over the
    // parent's properties; D28 keeps this one lint off.
    strictRequired: false,
    allowUnionTypes: false,
    allErrors: true,
    verbose: true,
    validateFormats: true,
  });
  addFormats(ajv);
  return ajv;
}

function loadSchemaSet(toolRoot: string): SchemaSet {
  let set = schemaSets.get(toolRoot);
  if (set !== undefined) {
    return set;
  }
  const shared = readJson(join(toolRoot, 'templates', 'shared', 'schema-defs.json'));
  const templates = {} as Record<TemplateName, Record<string, unknown>>;
  for (const name of TEMPLATE_NAMES) {
    templates[name] = readJson(join(toolRoot, 'templates', name, 'schema.json'));
  }
  const ajv = createAjv();
  addAssetPathKeyword(ajv);
  const validators = {} as Record<TemplateName, ValidateFunction>;
  for (const name of TEMPLATE_NAMES) {
    try {
      validators[name] = ajv.compile(inlinedSchema(bundleOf(templates[name], shared, name)));
    } catch (error) {
      throw new ToolResourceError(join(toolRoot, 'templates', name, 'schema.json'), `does not compile: ${(error as Error).message}`);
    }
  }
  set = {shared, templates, validators};
  schemaSets.set(toolRoot, set);
  return set;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** The template schema exactly as shipped, as a fresh copy. */
export function templateSchema(template: TemplateName, toolRoot: string = locateToolRoot()): Record<string, unknown> {
  return clone(loadSchemaSet(toolRoot).templates[template]);
}

/** The shared definitions exactly as shipped, as a fresh copy. */
export function sharedDefinitions(toolRoot: string = locateToolRoot()): Record<string, unknown> {
  return clone(loadSchemaSet(toolRoot).shared);
}

/**
 * One self-contained schema for a template: the shared definitions copied into
 * its `$defs` and every `../shared/schema-defs.json#/$defs/` reference made
 * local. The editor and the generated manifest reference read this form.
 */
export function bundledSchema(template: TemplateName, toolRoot: string = locateToolRoot()): Record<string, unknown> {
  const set = loadSchemaSet(toolRoot);
  return bundleOf(set.templates[template], set.shared, template);
}

/** The bundled form of one template's schema, built from the files as read. */
function bundleOf(linked: Record<string, unknown>, sharedFile: Record<string, unknown>, template: TemplateName): Record<string, unknown> {
  const bundle = clone(linked);
  const own = (bundle['$defs'] ?? {}) as Record<string, unknown>;
  const shared = clone(sharedFile['$defs'] as Record<string, unknown>);
  for (const name of Object.keys(shared)) {
    if (Object.hasOwn(own, name)) {
      throw new Error(`E_INTERNAL: ${template} defines $defs/${name}, which the shared definitions also define`);
    }
  }
  const rewrite = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(rewrite);
    } else if (typeof node === 'object' && node !== null) {
      const record = node as Record<string, unknown>;
      const reference = record['$ref'];
      if (typeof reference === 'string' && reference.startsWith(SHARED_PREFIX)) {
        record['$ref'] = `#/$defs/${reference.slice(SHARED_PREFIX.length)}`;
      }
      Object.values(record).forEach(rewrite);
    }
  };
  rewrite(bundle);
  bundle['$id'] = String(bundle['$id']).replace(/schema\.json$/, 'schema.bundled.json');
  bundle['$defs'] = {...own, ...shared};
  return bundle;
}

/** Keywords that only describe; merging them next to an inlined definition changes nothing that validates. */
const ANNOTATIONS = new Set(['description', 'title', '$comment', 'examples', 'default', 'deprecated', 'readOnly', 'writeOnly']);

/**
 * The shared path definitions, and the kind of file each names. A value its
 * definition's pattern accepts is also held to `checkAssetPath`, which says
 * what a pattern cannot: names Windows reserves, names ending in a dot, and
 * the name and path lengths (IC02, D164(d)). Each depends on the value alone,
 * so it is judged here with the schema's other errors rather than in resolve,
 * after them (W5R-33). The keyword exists only in the inlined form validation
 * runs; the shipped schemas and the bundled form do not carry it.
 */
const PATH_DEFINITIONS: ReadonlyMap<string, AssetKind> = new Map([
  ['text_file_path', 'text'],
  ['image_path', 'image'],
  ['logo_path', 'logo'],
  ['data_path', 'data'],
  ['video_path', 'video'],
]);
const ASSET_PATH = 'papeleriaAssetPath';

/** Adds the path rules as a keyword: a value the pattern beside it refuses is left to that pattern's own error. */
function addAssetPathKeyword(ajv: InstanceType<typeof Ajv2020>): void {
  ajv.addKeyword({
    keyword: ASSET_PATH,
    type: 'string',
    schemaType: 'string',
    compile: (kind: AssetKind, parentSchema) => {
      const pattern = typeof parentSchema['pattern'] === 'string' ? new RegExp(parentSchema['pattern'], 'u') : null;
      return (data: string) => (pattern !== null && !pattern.test(data)) || checkAssetPath(kind, data) === null;
    },
  });
}

/**
 * A bundled schema with every `#/$defs/…` reference replaced by a copy of the
 * definition it names, for validation only. The schemas are not recursive, so
 * this terminates; a cycle or an unresolvable reference is a defect.
 */
function inlinedSchema(bundled: Record<string, unknown>): Record<string, unknown> {
  const definitions = bundled['$defs'] as Record<string, unknown>;
  const inline = (node: unknown, trail: readonly string[]): unknown => {
    if (Array.isArray(node)) {
      return node.map((item) => inline(item, trail));
    }
    if (typeof node !== 'object' || node === null) {
      return node;
    }
    const record = node as Record<string, unknown>;
    const reference = record['$ref'];
    if (typeof reference === 'string') {
      const name = reference.startsWith('#/$defs/') ? reference.slice('#/$defs/'.length) : null;
      if (name === null || !Object.hasOwn(definitions, name)) {
        throw new Error(`E_INTERNAL: the schema reference ${reference} cannot be inlined`);
      }
      if (trail.includes(name)) {
        throw new Error(`E_INTERNAL: the schema refers to itself through ${[...trail, name].join(', ')}`);
      }
      const inlined = inline(definitions[name], [...trail, name]) as Record<string, unknown>;
      const kind = PATH_DEFINITIONS.get(name);
      const target = kind === undefined ? inlined : {...inlined, [ASSET_PATH]: kind};
      const siblings = Object.keys(record).filter((key) => key !== '$ref');
      const result: Record<string, unknown> = siblings.every((key) => ANNOTATIONS.has(key)) ? {...target} : {allOf: [target]};
      for (const key of siblings) {
        result[key] = inline(record[key], trail);
      }
      return result;
    }
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
      if (key !== '$defs') {
        result[key] = inline(value, trail);
      }
    }
    return result;
  };
  const inlined = inline(bundled, []) as Record<string, unknown>;
  inlined['$id'] = String(bundled['$id']).replace(/\.bundled\.json$/, '.inlined.json');
  return inlined;
}

// ---------------------------------------------------------------------------
// Where an error is, in words an author recognises.

type Place = {readonly kind: string; readonly label: string};

const BLOCK_KINDS = new Set(['text', 'image', 'video', 'chart', 'table', 'quote', 'note', 'callout', 'logo']);

function ordinal(segment: string | undefined): number {
  return Number(segment) + 1;
}

/** Names the object at a pointer: its kind and a label such as "the chart on slide 4". */
function describe(segments: readonly string[]): Place {
  const [first, a, second, b, third, c, fourth] = segments;
  const n = segments.length;
  if (n === 0) {
    return {kind: 'root', label: 'the manifest'};
  }
  if (first === 'logo' && n === 1) {
    return {kind: 'logo', label: 'the deck logo'};
  }
  if (first === 'credits' && n === 2) {
    return {kind: 'credit', label: `credit ${ordinal(a)}`};
  }
  if (first === 'metadata' && n === 2) {
    return {kind: 'metadata', label: `metadata item ${ordinal(a)}`};
  }
  if (first === 'slides') {
    const slide = `slide ${ordinal(a)}`;
    if (n === 1) {
      return {kind: 'slides', label: 'the slides'};
    }
    if (n === 2) {
      return {kind: 'slide', label: slide};
    }
    if (n === 3 && second === 'columns') {
      return {kind: 'columns', label: `the columns of ${slide}`};
    }
    if (n === 4 && second === 'columns') {
      return {kind: 'column', label: `column ${ordinal(b)} of ${slide}`};
    }
    if (n === 4 && second === 'items') {
      return {kind: 'item', label: `item ${ordinal(b)} of ${slide}`};
    }
    if (n === 4 && second === 'swatches') {
      return {kind: 'swatch', label: `swatch ${ordinal(b)} of ${slide}`};
    }
    if (n === 3 && (second === 'chart' || second === 'table' || second === 'image')) {
      return {kind: second, label: `the ${second} on ${slide}`};
    }
    if (n === 5 && second === 'table' && b === 'columns') {
      return {kind: 'table-column', label: `column ${ordinal(third)} of the table on ${slide}`};
    }
  }
  if (first === 'pages') {
    const page = `page ${ordinal(a)}`;
    if (n === 1) {
      return {kind: 'pages', label: 'the pages'};
    }
    if (n === 2) {
      return {kind: 'page', label: page};
    }
    if (second === 'panels' && n >= 4) {
      const panel = `panel ${ordinal(b)} on ${page}`;
      if (n === 4) {
        return {kind: 'panel', label: panel};
      }
      if (third === 'box') {
        return {kind: 'box', label: `the box of ${panel}`};
      }
      if (third === 'detail' && n === 5) {
        return {kind: 'detail', label: `the detail of ${panel}`};
      }
      if (third === 'detail' && c === 'image' && n === 6) {
        return {kind: 'image', label: `the detail image of ${panel}`};
      }
    }
  }
  if (first === 'sections') {
    const section = `section ${ordinal(a)}`;
    if (n === 1) {
      return {kind: 'sections', label: 'the sections'};
    }
    if (n === 2) {
      return {kind: 'section', label: section};
    }
    if (second === 'blocks' && n === 3) {
      return {kind: 'blocks', label: `the blocks of ${section}`};
    }
    if (second === 'blocks' && n >= 4) {
      const block = `block ${ordinal(b)} of ${section}`;
      if (n === 4) {
        return {kind: 'block', label: block};
      }
      if (n === 5 && third !== undefined && BLOCK_KINDS.has(third)) {
        return {kind: third, label: `the ${third} in ${block}`};
      }
      if (n === 7 && third === 'table' && c === 'columns') {
        return {kind: 'table-column', label: `column ${ordinal(fourth)} of the table in ${block}`};
      }
    }
  }
  return {kind: 'value', label: segments.at(-1) ?? 'the manifest'};
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function listWords(words: readonly string[], joiner = 'and'): string {
  if (words.length <= 1) {
    return words.join('');
  }
  return `${words.slice(0, -1).join(', ')} ${joiner} ${words.at(-1)!}`;
}

/** A value as the author wrote it, for a message: text quoted, anything else as written; long either way is cut (D175). */
function show(value: unknown): string {
  return typeof value === 'string' ? quoteForMessage(value) : shortenForMessage(String(value));
}

/** A layout as the author wrote it: plain when it is one of the twelve, quoted otherwise. */
function layoutWord(value: unknown): string {
  return typeof value === 'string' && (LAYOUT_NAMES as readonly string[]).includes(value) ? value : show(value);
}

// ---------------------------------------------------------------------------
// Mapping one error to one finding.

const BOX_SLOTS = ['x', 'y', 'width', 'height'];
const BOX_FIX = 'Keep x and y from 0 to 100, width and height above 0, and x plus width and y plus height at most 100.';

/** How far past 100 a sum of two percentages may be and still be at the edge: rounding, never an author's number (D107). */
export const PANEL_EXTENT_TOLERANCE = 1e-9;

const extentNumbers = new Intl.NumberFormat('en-US', {maximumFractionDigits: 6});

/**
 * R14's extent (C11, D107): a panel box stays on the page when x + width and
 * y + height are each at most 100, the exact edge accepted. The sums are of
 * the numbers as written, held as binary doubles, whose sum may land a unit
 * in the last place away from the decimal sum the author meant: a sum within
 * PANEL_EXTENT_TOLERANCE past 100 is at the edge. The words for a box that
 * runs off, naming each extent that does; null for a box on the page.
 */
export function panelExtentProblem(
  box: readonly [number, number, number, number],
  page: number,
  panel: number,
): {readonly message: string; readonly fix: string; readonly detail: string} | null {
  const [x, y, width, height] = box;
  const over = [
    {axis: 'x', size: 'width', start: x, extent: width, edge: 'right'},
    {axis: 'y', size: 'height', start: y, extent: height, edge: 'bottom'},
  ].filter((each) => each.start + each.extent > 100 + PANEL_EXTENT_TOLERANCE);
  const first = over[0];
  if (first === undefined) {
    return null;
  }
  const sums = over.map((each) => `${each.axis} + ${each.size} is ${extentNumbers.format(each.start + each.extent)}`).join(' and ');
  const edges = over.map((each) => each.edge).join(' and ');
  return {
    message: `Panel ${panel} on page ${page} runs off the ${edges} of the page: ${sums}, and each must be at most 100.`,
    fix: `Make ${over.map((each) => `${each.axis} + ${each.size}`).join(' and ')} at most 100, for example a ${first.size} of ${extentNumbers.format(Math.max(0, 100 - first.start))} or less at ${first.axis} ${extentNumbers.format(first.start)}.`,
    detail: `The box is [x, y, width, height] in percent of the page image: [${box.map((value) => extentNumbers.format(value)).join(', ')}].`,
  };
}

/**
 * R14's extent for every panel box whose four numbers the schema accepted, so
 * a box off the page is reported with the manifest's other errors, not after
 * them (W5R-33). A box with an error of its own says that alone.
 */
function mapPanelExtents(mapper: Mapper, value: Readonly<Record<string, unknown>>, errors: readonly ErrorObject[]): void {
  const refused = new Set<string>();
  for (const error of errors) {
    const box = /^\/pages\/\d+\/panels\/\d+\/box(?=\/|$)/.exec(error.instancePath);
    if (box !== null) {
      refused.add(box[0]);
    }
  }
  const pages = value['pages'];
  if (!Array.isArray(pages)) {
    return;
  }
  pages.forEach((page: unknown, pageIndex) => {
    const panels = typeof page === 'object' && page !== null ? (page as Record<string, unknown>)['panels'] : undefined;
    if (!Array.isArray(panels)) {
      return;
    }
    panels.forEach((panel: unknown, panelIndex) => {
      const box = typeof panel === 'object' && panel !== null ? (panel as Record<string, unknown>)['box'] : undefined;
      const pointer = `/pages/${pageIndex}/panels/${panelIndex}/box`;
      if (!Array.isArray(box) || box.length !== 4 || !box.every((item) => typeof item === 'number' && Number.isFinite(item)) || refused.has(pointer)) {
        return;
      }
      const problem = panelExtentProblem(box as [number, number, number, number], pageIndex + 1, panelIndex + 1);
      if (problem !== null) {
        mapper.add('R14', mapper.valueAt(pointer), `${pointer}#extent`, problem.message, problem.fix, problem.detail);
      }
    });
  });
}

const COLUMNS_FIX = 'The two layout takes two columns, three takes three and four takes four; every other layout takes none.';
const KIND_WORDS = listWords([...BLOCK_KINDS], 'or');

class Mapper {
  readonly findings: TracedFinding[] = [];
  readonly #manifest: LoadedManifest;

  constructor(manifest: LoadedManifest) {
    this.#manifest = manifest;
  }

  get file(): string {
    return this.#manifest.file;
  }

  #entry(pointer: string): SourceEntry | null {
    return nearestEntry(this.#manifest.sourceMap, pointer)?.entry ?? null;
  }

  /** The start of a value. */
  valueAt(pointer: string): Location {
    const entry = this.#entry(pointer);
    return entry === null
      ? {file: this.file, line: null, column: null}
      : {file: this.file, line: entry.value.start.line, column: entry.value.start.column};
  }

  /** The start of a field's key when it has one, else of its value: where an author looks for an object or list. */
  nodeAt(pointer: string): Location {
    const entry = this.#entry(pointer);
    if (entry === null) {
      return {file: this.file, line: null, column: null};
    }
    const start = (entry.key ?? entry.value).start;
    return {file: this.file, line: start.line, column: start.column};
  }

  valueOf(pointer: string): unknown {
    let current: unknown = this.#manifest.value;
    for (const segment of parsePointer(pointer)) {
      if (typeof current !== 'object' || current === null || !Object.hasOwn(current, segment)) {
        return undefined;
      }
      current = (current as Record<string, unknown>)[segment];
    }
    return current;
  }

  add(
    rule: string,
    location: Location,
    sourcePath: string,
    message: string,
    fix: string,
    detail: string | null = null,
  ): void {
    this.findings.push(traced({rule, message, fix, detail, location, sourcePath: `${this.file}#${sourcePath}`}));
  }

  /** A missing field, located at its container (IC01). */
  missing(rule: string, container: string, sourcePath: string, place: Place, field: string, message: string, fix: string): void {
    this.add(rule, this.nodeAt(container), sourcePath, message, fix, `Container location: ${place.label} starts here and has no ${field}.`);
  }
}

function typeWords(type: unknown, format: 'yaml' | 'json'): string {
  switch (type) {
    case 'string':
      return 'text';
    case 'number':
      return 'a finite number';
    case 'integer':
      return 'a whole number';
    case 'boolean':
      return 'true or false';
    case 'array':
      return 'a list';
    case 'object':
      return format === 'json' ? 'an object of fields' : 'a mapping of fields';
    default:
      return String(type);
  }
}

/**
 * The pattern of `non_empty_string` in schema-defs.json: one visible
 * character, which neither whitespace, a default-ignorable character (a
 * zero-width space, a joiner, a soft hyphen, a byte-order mark), a control, a
 * Hangul filler nor the blank Braille pattern is.
 */
const VISIBLE_TEXT = '[^\\p{White_Space}\\p{Default_Ignorable_Code_Point}\\p{Cc}\\u115f\\u1160\\u2800\\u3164\\uffa0]';

function isBlankCheck(error: ErrorObject): boolean {
  return (
    (error.keyword === 'pattern' && (error.params as {pattern?: string}).pattern === VISIBLE_TEXT) ||
    (error.keyword === 'minLength' && (error.params as {limit?: number}).limit === 1)
  );
}

/** Which asset kind a path field names, from its place in the manifest. */
function assetKindOf(container: Place, field: string): AssetKind | null {
  if (field === 'data' && (container.kind === 'chart' || container.kind === 'table')) {
    return 'data';
  }
  if (field === 'poster' && container.kind === 'video') {
    return 'image';
  }
  if (field === 'src') {
    if (container.kind === 'image') {
      return 'image';
    }
    if (container.kind === 'logo') {
      return 'logo';
    }
    if (container.kind === 'video') {
      return 'video';
    }
  }
  if (field === 'image' && container.kind === 'page') {
    return 'image';
  }
  return null;
}

/** The dedicated rule that owns a field, if any: the alternatives, transcripts and summaries. */
function dedicatedField(container: Place, field: string): {rule: string; facet: string; noun: string} | null {
  if (field === 'alt' || field === 'decorative') {
    if (container.kind === 'image') {
      return {rule: 'R03', facet: 'alternative', noun: 'image'};
    }
    if (container.kind === 'page') {
      return {rule: 'R03', facet: 'alternative', noun: 'comic page'};
    }
    if (container.kind === 'logo') {
      return {rule: 'R03', facet: 'alternative', noun: 'logo'};
    }
    if (container.kind === 'video') {
      return {rule: 'R10', facet: 'alternative', noun: 'video'};
    }
  }
  if (field === 'transcript' && container.kind === 'panel') {
    return {rule: 'R04', facet: 'transcript', noun: 'panel'};
  }
  if (field === 'summary' && container.kind === 'chart') {
    return {rule: 'R05', facet: 'summary', noun: 'chart'};
  }
  return null;
}

const DEDICATED_TEXT: Readonly<Record<string, {missing: string; blank: string; notText: string; fix: string}>> = {
  image: {
    missing: 'An image has neither alt text nor a decorative mark.',
    blank: "The image's alt text is blank.",
    notText: "The image's alt text must be text.",
    fix: 'Add alt: describing the image, or decorative: true if it adds nothing a reader needs.',
  },
  'comic page': {
    missing: 'A comic page has no alt text.',
    blank: "The comic page's alt text is blank.",
    notText: "The comic page's alt text must be text.",
    fix: 'Describe the page art in alt:. A comic page cannot be marked decorative.',
  },
  logo: {
    missing: 'A logo has no alt text.',
    blank: "The logo's alt text is blank.",
    notText: "The logo's alt text must be text.",
    fix: 'Name whose logo it is in alt:. A logo cannot be marked decorative.',
  },
  video: {
    missing: 'A video has no text alternative.',
    blank: "The video's text alternative is blank.",
    notText: "The video's text alternative must be text.",
    fix: 'Add alt: describing the loop.',
  },
  panel: {
    missing: 'A comic panel has no transcript.',
    blank: "The panel's transcript is blank.",
    notText: "The panel's transcript must be text.",
    fix: 'Add transcript: with the words and action of the panel.',
  },
  chart: {
    missing: 'A chart has no summary.',
    blank: "The chart's summary is blank.",
    notText: "The chart's summary must be text.",
    fix: 'Add summary: with the sentence the chart makes.',
  },
};

function mapError(error: ErrorObject, mapper: Mapper, template: TemplateName, format: 'yaml' | 'json'): void {
  const pointer = error.instancePath;
  const segments = parsePointer(pointer);
  const place = describe(segments);
  const params = error.params as Record<string, unknown>;
  const schemaPath = error.schemaPath;

  // `if` only says a `then` failed; the `then` error itself is reported.
  if (error.keyword === 'if') {
    return;
  }

  // A path its pattern accepted and the path rules refuse, worded by those rules as resolve words them.
  if (error.keyword === ASSET_PATH && typeof error.data === 'string') {
    const problem = checkAssetPath(error.schema as AssetKind, error.data);
    if (problem !== null) {
      mapper.add('R09', mapper.valueAt(pointer), pointer, problem.message, problem.fix);
    }
    return;
  }

  // R14: anything wrong with the value of a panel box (C11).
  const boxIndex = segments.length >= 5 && segments[0] === 'pages' && segments[2] === 'panels' && segments[4] === 'box';
  if (boxIndex) {
    const box = parsePointer(pointer).slice(0, 5);
    const boxPointer = `/${box.join('/')}`;
    const slot = segments[5] === undefined ? undefined : Number(segments[5]);
    const panelLabel = describe(box.slice(0, 4)).label;
    if (slot === undefined || slot > 3 || error.keyword === 'false schema') {
      const count = Array.isArray(mapper.valueOf(boxPointer)) ? (mapper.valueOf(boxPointer) as unknown[]).length : null;
      mapper.add(
        'R14',
        mapper.nodeAt(boxPointer),
        `${boxPointer}#shape`,
        count === null
          ? `The box of ${panelLabel} must be a list of four numbers: x, y, width and height.`
          : `The box of ${panelLabel} has ${count} numbers; it needs four: x, y, width and height.`,
        BOX_FIX,
      );
      return;
    }
    const name = BOX_SLOTS[slot]!;
    const subject = `The ${name} of the box of ${panelLabel}`;
    const messages: Record<string, string> = {
      type: `${subject} is not a finite number.`,
      minimum: `${subject} is ${show(error.data)}, below 0.`,
      maximum: `${subject} is ${show(error.data)}, above 100.`,
      exclusiveMinimum: `${subject} is ${show(error.data)}; it must be greater than 0.`,
    };
    mapper.add('R14', mapper.valueAt(pointer), pointer, messages[error.keyword] ?? `${subject} is not valid.`, BOX_FIX);
    return;
  }

  // A table column is a header name or {field, label}. Ajv reports each failed
  // branch of that union; they are one problem, worded from what was written.
  if (place.kind === 'table-column' && error.keyword !== 'additionalProperties') {
    const value = mapper.valueOf(pointer);
    const record = typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
    if (record !== null && Object.hasOwn(record, 'field')) {
      // The column is a mapping with a field; the errors under it say what is wrong.
      return;
    }
    const message =
      typeof value === 'string'
        ? `${capitalize(place.label)} is blank.`
        : record !== null
          ? `${capitalize(place.label)} has no field.`
          : `${capitalize(place.label)} must be a CSV header name, or a mapping with field:.`;
    mapper.add('R09', mapper.valueAt(pointer), `${pointer}#column`, message, 'Write the CSV header name, or a mapping with field: and an optional label:.');
    return;
  }

  switch (error.keyword) {
    case 'required': {
      const field = String(params['missingProperty']);
      const fieldPointer = joinPointer(pointer, field);
      const dedicated = dedicatedField(place, field);
      if (dedicated !== null) {
        const text = DEDICATED_TEXT[dedicated.noun]!;
        mapper.missing(dedicated.rule, pointer, `${pointer}#${dedicated.facet}`, place, field, text.missing, text.fix);
        return;
      }
      if (place.kind === 'slide') {
        const layout = mapper.valueOf(joinPointer(pointer, 'layout')) as LayoutName;
        if (field === 'columns') {
          const count = LAYOUT_COLUMNS[layout];
          mapper.missing(
            'R15',
            pointer,
            `${pointer}/columns`,
            place,
            field,
            `A ${layoutWord(layout)} slide takes exactly ${count} columns; ${place.label} has none.`,
            COLUMNS_FIX,
          );
          return;
        }
        if ((field === 'chart' || field === 'table') && schemaPath.includes('/oneOf/')) {
          mapper.missing('R09', pointer, `${pointer}#chart-or-table`, place, 'chart or table', 'A chart slide needs one chart or one table.', 'Add chart: or table:, not both.');
          return;
        }
        const needs: Record<string, [string, string]> = {
          image: ['An image slide needs an image.', 'Add image: with src: and alt:.'],
          items: ['An attributes slide needs items.', 'Add items:, each with label: and text:.'],
          swatches: ['A palette slide needs swatches.', 'Add swatches:, each with name: and value:.'],
        };
        if (needs[field] !== undefined) {
          mapper.missing('R09', pointer, fieldPointer, place, field, needs[field]![0], needs[field]![1]);
          return;
        }
      }
      if (place.kind === 'detail') {
        if (schemaPath.includes('/oneOf/')) {
          mapper.missing(
            'R09',
            pointer,
            `${pointer}#kind`,
            place,
            'kind',
            `${capitalize(place.label)} has none of zoom, text, image and href.`,
            'Give the detail exactly one of zoom: true, text:, image: or href: with label:.',
          );
          return;
        }
        if (field === 'label') {
          mapper.missing('R09', pointer, fieldPointer, place, field, `The link in ${place.label} has no label.`, 'Add label: with the link text.');
          return;
        }
        if (field === 'href') {
          mapper.add('R09', mapper.nodeAt(joinPointer(pointer, 'label')), joinPointer(pointer, 'label'), 'label is used only with href.', 'Add href: with the link, or remove label:.');
          return;
        }
      }
      mapper.missing('R09', pointer, fieldPointer, place, field, `${capitalize(place.label)} has no ${field}.`, `Add ${field}: to ${place.label}.`);
      return;
    }

    case 'additionalProperties': {
      const field = String(params['additionalProperty']);
      const fieldPointer = joinPointer(pointer, field);
      if (field === 'video' && place.kind !== 'block') {
        mapper.add(
          'R09',
          mapper.nodeAt(fieldPointer),
          fieldPointer,
          'Video is allowed only in document sections.',
          'Remove the video, or move it into a block of a document section; use an image here instead.',
        );
        return;
      }
      if (field === 'decorative' && (place.kind === 'page' || place.kind === 'logo' || place.kind === 'video')) {
        const dedicated = dedicatedField(place, field)!;
        const noun = dedicated.noun;
        const describeFix = noun === 'video' ? 'describe the loop' : noun === 'logo' ? 'name whose logo it is' : 'describe the page art';
        mapper.add(
          dedicated.rule,
          mapper.nodeAt(fieldPointer),
          `${pointer}#${dedicated.facet}`,
          `A ${noun} cannot be marked decorative.`,
          `Remove decorative: and ${describeFix} in alt:.`,
        );
        return;
      }
      const properties = Object.keys(((error.parentSchema as {properties?: object} | undefined)?.properties ?? {}) as object);
      mapper.add(
        'R09',
        mapper.nodeAt(fieldPointer),
        fieldPointer,
        `${quoteForMessage(field)} is not a field of ${place.label}.`,
        properties.length > 0
          ? `Check the spelling. ${capitalize(place.label)} takes: ${properties.join(', ')}.`
          : 'Check the spelling, or remove the field.',
      );
      return;
    }

    case 'false schema': {
      // properties: {x: false} in a layout rule: this slide's layout does not take x.
      const field = segments.at(-1)!;
      const slidePointer = `/${segments.slice(0, -1).join('/')}`;
      const slide = describe(segments.slice(0, -1));
      const layout = layoutWord(mapper.valueOf(joinPointer(slidePointer, 'layout')));
      if (field === 'columns') {
        mapper.add('R15', mapper.nodeAt(pointer), pointer, `A ${layout} slide takes no columns.`, 'Remove columns:, or change the layout to two, three or four.');
        return;
      }
      const owner: Record<string, string> = {chart: 'a chart slide', table: 'a chart slide', image: 'an image slide', items: 'an attributes slide', swatches: 'a palette slide'};
      const layoutFor: Record<string, string> = {chart: 'chart', table: 'chart', image: 'image', items: 'attributes', swatches: 'palette'};
      mapper.add(
        'R09',
        mapper.nodeAt(pointer),
        pointer,
        `${field} belongs on ${owner[field] ?? 'another layout'}; ${slide.label} is a ${layout} slide.`,
        `Remove ${field}:, or set layout: ${layoutFor[field] ?? layout}.`,
      );
      return;
    }

    case 'oneOf': {
      if (place.kind === 'image') {
        const value = (mapper.valueOf(pointer) ?? {}) as Record<string, unknown>;
        const both = Object.hasOwn(value, 'alt') && Object.hasOwn(value, 'decorative');
        if (both) {
          mapper.add(
            'R03',
            mapper.nodeAt(pointer),
            `${pointer}#alternative`,
            'An image has both alt text and a decorative mark.',
            'Keep alt: if the image carries meaning, or keep decorative: true and remove alt:.',
          );
        } else {
          const text = DEDICATED_TEXT['image']!;
          mapper.missing('R03', pointer, `${pointer}#alternative`, place, 'alt', text.missing, text.fix);
        }
        return;
      }
      if (place.kind === 'slide') {
        // With neither, each branch's required error says the slide needs one; only both is this error's own.
        const value = mapper.valueOf(pointer);
        const record = typeof value === 'object' && value !== null ? value : {};
        if (Object.hasOwn(record, 'chart') && Object.hasOwn(record, 'table')) {
          mapper.add('R09', mapper.nodeAt(pointer), `${pointer}#chart-or-table`, 'A chart slide has both a chart and a table.', 'Keep exactly one of chart: and table:.');
        }
        return;
      }
      if (place.kind === 'detail') {
        const value = (mapper.valueOf(pointer) ?? {}) as Record<string, unknown>;
        const kinds = ['zoom', 'text', 'image', 'href'].filter((kind) => Object.hasOwn(value, kind));
        mapper.add(
          'R09',
          mapper.nodeAt(pointer),
          `${pointer}#kind`,
          kinds.length === 0
            ? `${capitalize(place.label)} has none of zoom, text, image and href.`
            : `${capitalize(place.label)} has more than one of zoom, text, image and href: ${listWords(kinds)}.`,
          'Give the detail exactly one of zoom: true, text:, image: or href: with label:.',
        );
        return;
      }
      break;
    }

    case 'minProperties':
    case 'maxProperties': {
      if (place.kind === 'block') {
        // Only real kinds count: a field written beside one kind is an unknown
        // field, which additionalProperties reports, not a second kind.
        const value = (mapper.valueOf(pointer) ?? {}) as Record<string, unknown>;
        const kinds = Object.keys(value).filter((key) => BLOCK_KINDS.has(key));
        if (error.keyword === 'maxProperties' && kinds.length < 2) {
          return;
        }
        mapper.add(
          'R09',
          mapper.nodeAt(pointer),
          `${pointer}#kind`,
          kinds.length === 0
            ? `${capitalize(place.label)} names no block kind.`
            : `${capitalize(place.label)} names more than one kind: ${listWords(kinds)}.`,
          `Write each block as exactly one of ${KIND_WORDS}.`,
        );
        return;
      }
      break;
    }

    case 'not': {
      if (place.kind === 'chart') {
        const orientation = joinPointer(pointer, 'orientation');
        mapper.add('R09', mapper.nodeAt(orientation), orientation, 'orientation applies only to bar charts.', 'Remove orientation: from this line chart, or set type: bar.');
        return;
      }
      break;
    }

    case 'minItems':
    case 'maxItems':
    case 'items': {
      const limit = Number(params['limit']);
      if (place.kind === 'columns') {
        const slidePointer = `/${segments.slice(0, 2).join('/')}`;
        const layout = mapper.valueOf(joinPointer(slidePointer, 'layout')) as LayoutName;
        const count = (mapper.valueOf(pointer) as unknown[]).length;
        mapper.add(
          'R15',
          mapper.nodeAt(pointer),
          pointer,
          `A ${layoutWord(layout)} slide takes exactly ${LAYOUT_COLUMNS[layout]} columns; ${describe(segments.slice(0, 2)).label} has ${count}.`,
          COLUMNS_FIX,
        );
        return;
      }
      if (segments.length === 1 && ['slides', 'pages', 'sections'].includes(segments[0]!)) {
        const noun = segments[0]!.slice(0, -1);
        if (error.keyword === 'minItems') {
          mapper.add('R09', mapper.nodeAt(pointer), pointer, `A ${template} needs at least one ${noun}.`, `Add a ${noun} under ${segments[0]}:.`);
        } else {
          const count = (mapper.valueOf(pointer) as unknown[]).length;
          mapper.add(
            'R09',
            mapper.nodeAt(pointer),
            pointer,
            `The manifest lists ${count.toLocaleString('en-US')} ${segments[0]}; the limit is ${limit.toLocaleString('en-US')} per piece.`,
            'Split the piece into several pieces.',
            'Input limit: 1,000 slides, pages or sections per piece (IC01).',
          );
        }
        return;
      }
      if (place.kind === 'blocks') {
        mapper.add('R09', mapper.nodeAt(pointer), pointer, `${capitalize(describe(segments.slice(0, 2)).label)} needs at least one block.`, 'Add a block under blocks:, such as - text: followed by the words.');
        return;
      }
      const field = segments.at(-1);
      if (field === 'items' || field === 'swatches') {
        mapper.add(
          'R09',
          mapper.nodeAt(pointer),
          pointer,
          field === 'items' ? 'An attributes slide needs at least one item.' : 'A palette slide needs at least one swatch.',
          field === 'items' ? 'Add an item with label: and text:.' : 'Add a swatch with name: and value:.',
        );
        return;
      }
      if (field === 'columns') {
        mapper.add('R09', mapper.nodeAt(pointer), pointer, "The table's columns list is empty.", 'List at least one CSV header name, or leave columns: out to show every column.');
        return;
      }
      if (field === 'focal_point') {
        mapper.add('R09', mapper.nodeAt(pointer), pointer, 'focal_point needs two numbers, x and y.', 'Write focal_point: [x, y] with percentages from 0 to 100, such as [50, 50].');
        return;
      }
      break;
    }

    default:
      break;
  }

  // Value-level errors: dedicated fields first, then paths, then the generic wording.
  const field = segments.at(-1) ?? '';
  const container = describe(segments.slice(0, -1));
  const dedicated = dedicatedField(container, field);
  if (dedicated !== null) {
    const containerPointer = `/${segments.slice(0, -1).join('/')}`;
    const text = DEDICATED_TEXT[dedicated.noun]!;
    if (field === 'decorative') {
      mapper.add(dedicated.rule, mapper.valueAt(pointer), `${containerPointer}#${dedicated.facet}`, 'decorative accepts only true.', 'Set decorative: true, or remove it and describe the image in alt:.');
      return;
    }
    const blank = error.keyword === 'type' ? text.notText : text.blank;
    mapper.add(dedicated.rule, mapper.valueAt(pointer), `${containerPointer}#${dedicated.facet}`, blank, text.fix);
    return;
  }

  if (error.keyword === 'pattern' && !isBlankCheck(error)) {
    if (field === 'href') {
      // Worded by the link policy itself, as resolve words it (D151).
      const verdict = typeof error.data === 'string' ? classifyLink(error.data) : null;
      mapper.add(
        'R09',
        mapper.valueAt(pointer),
        pointer,
        verdict !== null && !verdict.ok ? `The link ${show(error.data)} uses ${verdict.reason}.` : `The link ${show(error.data)} is not allowed.`,
        'Use an https, http, mailto or tel address, a relative link or a #fragment.',
      );
      return;
    }
    if (field === 'value' && container.kind === 'swatch') {
      mapper.add('R09', mapper.valueAt(pointer), pointer, `${show(error.data)} is not a colour.`, 'Write the colour as #rgb or #rrggbb, such as #2f7fbf.');
      return;
    }
    // A path field by its place, or a text value that C05's prefix and suffix make a file reference.
    const kind = assetKindOf(container, field) ?? (typeof error.data === 'string' && isTextFileReference(error.data) ? 'text' : null);
    if (kind !== null && typeof error.data === 'string') {
      const problem = checkAssetPath(kind, error.data);
      mapper.add(
        'R09',
        mapper.valueAt(pointer),
        pointer,
        problem?.message ?? `The path ${show(error.data)} is not a valid ${kind} path.`,
        problem?.fix ?? 'Write the path from the piece folder with forward slashes.',
      );
      return;
    }
  }

  if (isBlankCheck(error)) {
    mapper.add('R09', mapper.valueAt(pointer), pointer, `${field} is blank.`, `Write the ${field.replaceAll('_', ' ')} as visible text, or remove ${field}: if it is optional.`);
    return;
  }

  switch (error.keyword) {
    case 'type': {
      const item = /^\d+$/.test(field);
      const subject = item ? describe(segments).label : field;
      const words = typeWords(params['type'], format);
      mapper.add('R09', mapper.valueAt(pointer), pointer, `${item ? capitalize(subject) : subject} must be ${words}.`, `Rewrite ${subject} as ${words}.`);
      return;
    }
    case 'enum': {
      const allowed = (params['allowedValues'] as unknown[]).map(String);
      mapper.add('R09', mapper.valueAt(pointer), pointer, `${show(error.data)} is not a valid ${field.replaceAll('_', ' ')}.`, `Use one of: ${allowed.join(', ')}.`);
      return;
    }
    case 'const': {
      mapper.add('R09', mapper.valueAt(pointer), pointer, `${field} accepts only ${show(params['allowedValue'])}.`, `Set ${field}: ${show(params['allowedValue'])}, or remove it.`);
      return;
    }
    case 'minimum':
    case 'maximum':
    case 'exclusiveMinimum':
    case 'exclusiveMaximum': {
      if (segments.at(-2) === 'focal_point') {
        mapper.add('R09', mapper.valueAt(pointer), pointer, `focal_point has ${show(error.data)}, outside 0 to 100.`, 'Write focal_point: [x, y] with percentages from 0 to 100, such as [50, 50].');
        return;
      }
      if (field === 'schema') {
        mapper.add('R09', mapper.valueAt(pointer), pointer, `schema: ${show(error.data)} is not a manifest version; this release reads schema 1.`, 'Set schema: 1.');
        return;
      }
      break;
    }
    default:
      break;
  }

  mapper.add('R09', mapper.valueAt(pointer), pointer, `${capitalize(place.label)} ${error.message ?? 'is not valid'}.`, 'Check this value against the manifest reference.');
}

export type ValidateOptions = {
  /** The tool root holding templates/; defaults to the installed package. */
  toolRoot?: string;
};

/**
 * Validates a loaded manifest against its template's schema. The template must
 * be named first (C03); a manifest whose schema is newer than the tool never
 * reaches this point (R17 stops it in the loader).
 */
export function validateManifest(loaded: LoadedManifest, options: ValidateOptions = {}): ValidationResult {
  const mapper = new Mapper(loaded);
  const value = loaded.value;

  if (!Object.hasOwn(value, 'template')) {
    mapper.missing(
      'R09',
      '',
      '/template',
      {kind: 'root', label: 'the manifest'},
      'template',
      'The manifest has no template.',
      'Add template: deck, template: comic or template: document.',
    );
    return {manifest: null, findings: mapper.findings};
  }
  const template = value['template'];
  if (typeof template !== 'string' || !(TEMPLATE_NAMES as readonly string[]).includes(template)) {
    // A value that is not text is worded by its kind, as the loader words `schema`.
    const message =
      typeof template === 'string'
        ? `${show(template)} is not a template.`
        : template === null
          ? 'template is empty.'
          : `template must be deck, comic or document, not ${Array.isArray(template) ? 'a list' : typeof template === 'object' ? 'a mapping' : String(template)}.`;
    mapper.add('R09', mapper.valueAt('/template'), '/template', message, 'Use deck, comic or document.');
    return {manifest: null, findings: mapper.findings};
  }

  const set = loadSchemaSet(options.toolRoot ?? locateToolRoot());
  const validate = set.validators[template as TemplateName];
  const errors: readonly ErrorObject[] = validate(value) === true ? [] : [...(validate.errors ?? [])];
  if (errors.length > 0) {
    // A value of the wrong type is reported by its type error alone. A type
    // error inside a oneOf or anyOf branch is one alternative among several,
    // not a verdict on the value, so it silences nothing.
    const definitive = (error: ErrorObject): boolean => error.keyword === 'type' && !/\/(?:oneOf|anyOf)\//.test(error.schemaPath);
    const wrongType = new Set(errors.filter(definitive).map((error) => error.instancePath));
    const underWrongType = (pointer: string): boolean => {
      for (let at = pointer; ; at = at.slice(0, at.lastIndexOf('/'))) {
        if (wrongType.has(at)) {
          return true;
        }
        if (at === '') {
          return false;
        }
      }
    };
    for (const error of errors) {
      if (definitive(error) || wrongType.size === 0 || !underWrongType(error.instancePath)) {
        mapError(error, mapper, template as TemplateName, loaded.format);
      }
    }
  }
  if (template === 'comic') {
    mapPanelExtents(mapper, value, errors);
  }

  if (hasErrors(mapper.findings)) {
    return {manifest: null, findings: mapper.findings};
  }
  const manifest: ValidatedManifest = Object.freeze({...loaded, template: template as TemplateName, data: value as unknown as Manifest});
  return {manifest, findings: mapper.findings};
}
