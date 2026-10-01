/**
 * M2.2: hover help built from the template's bundled schema (D75, D148).
 *
 * `codemirror-json-schema`'s own hover runs json-schema-library's Draft04,
 * which drops a description written beside a `$ref` — where the template
 * schemas put nearly all of theirs — and ignores `if`/`then`. So the editor
 * builds its help here, from `bundledSchema(template)` as the server sends it
 * (shared definitions inlined into `$defs`, every reference local), and keeps
 * the library for completion only.
 *
 * Given the path of a key or value and the document's value (the manifest as
 * parsed so far, or undefined), `helpAt` finds every subschema that applies
 * there — through `$ref`, `allOf`, the branches of `oneOf`/`anyOf`, and the
 * `then` or `else` of an `if` the document's value decides — and gathers
 * their descriptions: first what a condition says about this very value (a
 * `then` chosen by it), then the description beside the reference, then the
 * referenced definitions', most specific first, each once, at most three.
 * Array positions use `prefixItems` for a tuple's own slots.
 *
 * Pure: no DOM, no CodeMirror; the unit tests run it over the three real
 * bundled schemas.
 */

type SchemaObject = Readonly<Record<string, unknown>>;
type Segment = string | number;

export type SchemaHelp = {
  /** Distinct descriptions, most specific first. */
  readonly descriptions: readonly string[];
  /** What the value may be, in words: a type, a range, the allowed values. Null when nothing useful can be said. */
  readonly summary: string | null;
};

/** The most descriptions a hover shows. */
export const MAX_DESCRIPTIONS = 3;
const MAX_DEPTH = 32;

function isObject(value: unknown): value is SchemaObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function definitions(root: SchemaObject): SchemaObject {
  const defs = root['$defs'];
  return isObject(defs) ? defs : {};
}

/** A local reference's target, or null for one this module does not follow. */
function resolve(root: SchemaObject, reference: unknown): SchemaObject | null {
  if (typeof reference !== 'string' || !reference.startsWith('#/$defs/')) {
    return null;
  }
  const target = definitions(root)[reference.slice('#/$defs/'.length)];
  return isObject(target) ? target : null;
}

function jsonType(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? 'integer' : 'number';
  }
  return typeof value;
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Whether `value` satisfies `schema`, for the keywords the templates' `if`
 * conditions use; null when this cannot be decided here. A keyword about a
 * type the value does not have is satisfied, as JSON Schema has it.
 */
export function holds(root: SchemaObject, schema: unknown, value: unknown, depth = 0): boolean | null {
  if (schema === true) {
    return true;
  }
  if (schema === false) {
    return false;
  }
  if (!isObject(schema) || depth > MAX_DEPTH) {
    return null;
  }
  let undecided = false;
  const decide = (result: boolean | null): boolean => {
    if (result === null) {
      undecided = true;
      return true;
    }
    return result;
  };
  for (const [keyword, argument] of Object.entries(schema)) {
    switch (keyword) {
      case 'description':
      case 'title':
      case '$comment':
      case 'default':
      case 'examples':
        break;
      case 'type': {
        const allowed = Array.isArray(argument) ? argument : [argument];
        const actual = jsonType(value);
        if (!allowed.some((type) => type === actual || (type === 'number' && actual === 'integer'))) {
          return false;
        }
        break;
      }
      case 'const':
        if (!sameJson(value, argument)) {
          return false;
        }
        break;
      case 'enum':
        if (!Array.isArray(argument) || !argument.some((member) => sameJson(value, member))) {
          return false;
        }
        break;
      case 'pattern':
        if (typeof value === 'string' && typeof argument === 'string') {
          try {
            if (!new RegExp(argument, 'u').test(value)) {
              return false;
            }
          } catch {
            undecided = true;
          }
        }
        break;
      case 'required':
        if (isObject(value) && Array.isArray(argument) && !argument.every((key) => typeof key === 'string' && Object.hasOwn(value, key))) {
          return false;
        }
        break;
      case 'properties':
        if (isObject(value) && isObject(argument)) {
          for (const [key, subschema] of Object.entries(argument)) {
            if (Object.hasOwn(value, key) && !decide(holds(root, subschema, value[key], depth + 1))) {
              return false;
            }
          }
        }
        break;
      case '$ref':
        if (!decide(holds(root, resolve(root, argument), value, depth + 1))) {
          return false;
        }
        break;
      case 'allOf':
        if (Array.isArray(argument) && !argument.every((member) => decide(holds(root, member, value, depth + 1)))) {
          return false;
        }
        break;
      default:
        undecided = true;
    }
  }
  return undecided ? null : true;
}

type Candidate = {readonly schema: SchemaObject; readonly value: unknown; readonly known: boolean};

/**
 * Every subschema that applies at one place: the schema, the targets of its
 * references, the members of `allOf`, the branches of `oneOf` and `anyOf`
 * (any of them may define the next key), and the `then` or `else` of an `if`
 * — the one the value decides, or both when it cannot be decided, since
 * either may define the next key.
 */
function facets(root: SchemaObject, candidate: Candidate, depth = 0): SchemaObject[] {
  const {schema, value, known} = candidate;
  if (depth > MAX_DEPTH) {
    return [];
  }
  const found: SchemaObject[] = [schema];
  const more = (next: unknown): void => {
    if (isObject(next)) {
      found.push(...facets(root, {schema: next, value, known}, depth + 1));
    }
  };
  more(resolve(root, schema['$ref']));
  for (const keyword of ['allOf', 'oneOf', 'anyOf']) {
    const members = schema[keyword];
    if (Array.isArray(members)) {
      members.forEach(more);
    }
  }
  if (schema['if'] !== undefined) {
    const decided = known ? holds(root, schema['if'], value) : null;
    if (decided !== false) {
      more(schema['then']);
    }
    if (decided !== true) {
      more(schema['else']);
    }
  }
  return found;
}

function childValue(value: unknown, segment: Segment): {value: unknown; known: boolean} {
  if (Array.isArray(value)) {
    const index = typeof segment === 'number' ? segment : /^(?:0|[1-9][0-9]*)$/.test(segment) ? Number(segment) : Number.NaN;
    return index < value.length ? {value: value[index], known: true} : {value: undefined, known: false};
  }
  if (isObject(value) && typeof segment === 'string' && Object.hasOwn(value, segment)) {
    return {value: value[segment], known: true};
  }
  return {value: undefined, known: false};
}

/** The subschemas one facet gives the child at `segment`. */
function children(facet: SchemaObject, segment: Segment): SchemaObject[] {
  const found: SchemaObject[] = [];
  const index = typeof segment === 'number' ? segment : /^(?:0|[1-9][0-9]*)$/.test(segment) ? Number(segment) : null;
  if (index !== null) {
    const tuple = facet['prefixItems'];
    if (Array.isArray(tuple) && index < tuple.length) {
      if (isObject(tuple[index])) {
        found.push(tuple[index]);
      }
    } else if (isObject(facet['items'])) {
      found.push(facet['items']);
    }
  }
  if (typeof segment === 'string') {
    const properties = facet['properties'];
    if (isObject(properties) && isObject(properties[segment])) {
      found.push(properties[segment]);
    } else {
      const patterns = facet['patternProperties'];
      let matched = false;
      if (isObject(patterns)) {
        for (const [pattern, subschema] of Object.entries(patterns)) {
          try {
            if (isObject(subschema) && new RegExp(pattern, 'u').test(segment)) {
              found.push(subschema);
              matched = true;
            }
          } catch {
            // A pattern this engine cannot read names no key here.
          }
        }
      }
      if (!matched && isObject(facet['additionalProperties'])) {
        found.push(facet['additionalProperties']);
      }
    }
  }
  return found;
}

/** Descriptions along one candidate, in the order `helpAt` promises, with conditional ones marked. */
function describe(root: SchemaObject, candidate: Candidate, out: {conditional: string[]; plain: string[]}, depth = 0, conditional = false): void {
  const {schema, value, known} = candidate;
  if (depth > MAX_DEPTH) {
    return;
  }
  const description = schema['description'];
  if (typeof description === 'string' && description.trim() !== '') {
    (conditional ? out.conditional : out.plain).push(description.trim());
  }
  if (schema['if'] !== undefined && known) {
    const decided = holds(root, schema['if'], value);
    const branch = decided === true ? schema['then'] : decided === false ? schema['else'] : undefined;
    if (isObject(branch)) {
      describe(root, {schema: branch, value, known}, out, depth + 1, true);
    }
  }
  const target = resolve(root, schema['$ref']);
  if (target !== null) {
    describe(root, {schema: target, value, known}, out, depth + 1, conditional);
  }
  const members = schema['allOf'];
  if (Array.isArray(members)) {
    for (const member of members) {
      if (isObject(member)) {
        describe(root, {schema: member, value, known}, out, depth + 1, conditional);
      }
    }
  }
}

function list(values: readonly unknown[]): string {
  const shown = values.map((value) => (typeof value === 'string' ? value : JSON.stringify(value)));
  return shown.length <= 1 ? (shown[0] ?? '') : `${shown.slice(0, -1).join(', ')} or ${shown.at(-1)!}`;
}

/** What the value may be, in words, from the first facet that says. */
function summarize(root: SchemaObject, candidates: readonly Candidate[]): string | null {
  for (const candidate of candidates) {
    for (const facet of facets(root, candidate)) {
      if (Object.hasOwn(facet, 'const')) {
        return `The value ${list([facet['const']])}.`;
      }
      if (Array.isArray(facet['enum'])) {
        return `One of ${list(facet['enum'])}.`;
      }
    }
  }
  for (const candidate of candidates) {
    for (const facet of facets(root, candidate)) {
      const type = facet['type'];
      const low = facet['minimum'] ?? facet['exclusiveMinimum'];
      const high = facet['maximum'];
      if (type === 'number' || type === 'integer') {
        const noun = type === 'integer' ? 'A whole number' : 'A number';
        if (typeof low === 'number' && typeof high === 'number') {
          return `${noun} from ${low} to ${high}${facet['exclusiveMinimum'] !== undefined ? ', above the first' : ''}.`;
        }
        return typeof low === 'number' ? `${noun} of at least ${low}.` : `${noun}.`;
      }
      if (type === 'string') {
        return 'Text.';
      }
      if (type === 'boolean') {
        return 'true or false.';
      }
      if (type === 'array') {
        const tuple = facet['prefixItems'];
        if (Array.isArray(tuple) && facet['items'] === false) {
          return `A list of exactly ${tuple.length}.`;
        }
        const fewest = facet['minItems'];
        const most = facet['maxItems'];
        return typeof fewest === 'number' && typeof most === 'number'
          ? `A list of ${fewest} to ${most.toLocaleString('en-US')}.`
          : typeof fewest === 'number'
            ? `A list of at least ${fewest}.`
            : 'A list.';
      }
      if (type === 'object') {
        return 'A group of fields.';
      }
    }
  }
  return null;
}

/**
 * The help for the key or value at `path` (keys and list positions from the
 * document's root) in a document shaped by `schema`, or null when the schema
 * has nothing there.
 */
export function helpAt(schema: unknown, path: readonly Segment[], document: unknown): SchemaHelp | null {
  if (!isObject(schema)) {
    return null;
  }
  const root = schema;
  let candidates: Candidate[] = [{schema: root, value: document, known: document !== undefined}];
  for (const segment of path) {
    const next: Candidate[] = [];
    const seen = new Set<SchemaObject>();
    for (const candidate of candidates) {
      const child = candidate.known ? childValue(candidate.value, segment) : {value: undefined, known: false};
      for (const facet of facets(root, candidate)) {
        for (const subschema of children(facet, segment)) {
          if (!seen.has(subschema)) {
            seen.add(subschema);
            next.push({schema: subschema, ...child});
          }
        }
      }
    }
    if (next.length === 0) {
      return null;
    }
    candidates = next;
  }
  const out = {conditional: [] as string[], plain: [] as string[]};
  for (const candidate of candidates) {
    describe(root, candidate, out);
  }
  const descriptions = [...new Set([...out.conditional, ...out.plain])].slice(0, MAX_DESCRIPTIONS);
  const summary = summarize(root, candidates);
  return descriptions.length === 0 && summary === null ? null : {descriptions, summary};
}

/** The path segments of a JSON pointer, `/slides/2/title` → `['slides', '2', 'title']`. */
export function pointerSegments(pointer: string): string[] {
  if (pointer === '' || pointer === '/') {
    return [];
  }
  return pointer
    .slice(1)
    .split('/')
    .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'));
}
