/**
 * M1.3: the bounded SVG profile of IC02.
 *
 * An author's SVG is parsed with saxes and accepted only when every element,
 * attribute and value is on the allowlist: no DTD or entity declarations, no
 * script, foreignObject, style element or attribute, event attribute, `href`
 * or other namespace, and no URL anywhere except `url(#id)` in fill, stroke,
 * clip-path and mask, pointing at an element of the right kind in the same
 * file. Values follow finite numeric, list, path and colour grammars. Nothing
 * is removed or repaired: a file outside the profile is refused, and the
 * text accepted is what is published, never re-serialised (D154, D164).
 *
 * The size of an accepted SVG is its viewBox, so a viewBox is required. As a
 * size in pixels (ERD IMAGE_FILE) each side is at least 1, the whole is held to
 * the image pixel limit (IC01), and the width and height reported are whole
 * numbers; the exact viewBox is reported beside them (D164).
 */
import {SaxesParser, type SaxesTagPlain} from 'saxes';

import {quoteValue, shortenForMessage} from './finding.js';
import {INPUT_LIMITS} from './limits.js';
import {LineIndex} from './positions.js';

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

export const SVG_ELEMENTS: ReadonlySet<string> = new Set([
  'svg',
  'g',
  'defs',
  'path',
  'rect',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'text',
  'tspan',
  'title',
  'desc',
  'linearGradient',
  'radialGradient',
  'stop',
  'clipPath',
  'mask',
]);

/** Elements whose content may be text. */
const TEXT_ELEMENTS = new Set(['text', 'tspan', 'title', 'desc']);

export type SvgProblem = {readonly message: string; readonly fix: string; readonly line: number | null; readonly column: number | null};

/** An accepted SVG's size: `width` and `height` are the viewBox's, rounded to whole pixels; `viewBox` is exact. */
export type SvgResult =
  | {readonly ok: true; readonly width: number; readonly height: number; readonly viewBox: readonly [number, number, number, number]}
  | {readonly ok: false; readonly problems: readonly SvgProblem[]};

/** At most this many problems are listed for one file; the last one says how many more there were. */
const MAX_PROBLEMS = 20;

/** A name or value from the file, as a problem shows it: bare, hidden characters visible, a long one cut (D175). */
function named(text: string): string {
  return quoteValue(text, 'none');
}

const pixelFormat = new Intl.NumberFormat('en-US');

// ---------------------------------------------------------------------------
// Value grammars. Each returns null when the value is acceptable, or the reason.
//
// Every grammar runs in time linear in its value: the number pattern has one
// way to match any digit run (a dot is required before a fraction), and
// whitespace is collapsed before a pattern that would otherwise have to choose
// which of several optional spaces a run belongs to (D154).

/**
 * CSS whitespace: space, tab, line feed, carriage return and form feed, which
 * is also SVG's own `wsp` in number, list, path, transform and viewBox values
 * (form feed cannot occur in XML 1.0). A browser reads only these as spaces.
 * JavaScript's `\s` and `trim` also take a no-break space, U+3000, U+2028 or a
 * byte-order mark, which a browser keeps as part of the value: `url(<U+00A0>#g)`
 * is the relative URL `%C2%A0#g`, which it requests, not the fragment `#g`, and
 * a viewBox or path holding one is dropped or cut short. So every grammar here
 * trims and splits with this set only (D154, D164(f), W5R-22).
 */
const CSS_SPACE = '[ \\t\\n\\r\\f]';

function isCssSpace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d || code === 0x0c;
}

/** Removes leading and trailing CSS whitespace. Linear. */
function cssTrim(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && isCssSpace(value.charCodeAt(start))) {
    start += 1;
  }
  while (end > start && isCssSpace(value.charCodeAt(end - 1))) {
    end -= 1;
  }
  return value.slice(start, end);
}

const NUMBER = String.raw`[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?`;
const NUMBER_ONLY = new RegExp(`^${NUMBER}$`);
const NUMBER_AT = new RegExp(NUMBER, 'y');
const LENGTH = new RegExp(`^(${NUMBER})(?:px|em|ex|pt|pc|cm|mm|in|%)?$`);
/** Between the items of a list: CSS whitespace and commas. */
const SEPARATOR = /[ \t\n\r\f,]+/;

type Check = (value: string) => string | null;

function finite(text: string): boolean {
  return Number.isFinite(Number.parseFloat(text));
}

const number: Check = (value) => {
  const text = cssTrim(value);
  return NUMBER_ONLY.test(text) && finite(text) ? null : 'must be a finite number';
};

function length(nonNegative: boolean): Check {
  return (value) => {
    const match = LENGTH.exec(cssTrim(value));
    if (match === null || !finite(match[1]!)) {
      return 'must be a finite length, such as 12, 12px or 50%';
    }
    return nonNegative && Number.parseFloat(match[1]!) < 0 ? 'must not be negative' : null;
  };
}

function list(item: Check, what: string, even = false): Check {
  return (value) => {
    const parts = cssTrim(value).split(SEPARATOR).filter((part) => part !== '');
    if (parts.length === 0) {
      return `must list ${what}`;
    }
    if (even && parts.length % 2 !== 0) {
      return 'must list x and y numbers in pairs';
    }
    return parts.every((part) => item(part) === null) ? null : `must list ${what}`;
  };
}

function oneOf(words: readonly string[]): Check {
  const allowed = new Set(words);
  return (value) => (allowed.has(cssTrim(value)) ? null : `must be one of ${words.join(', ')}`);
}

const fraction: Check = (value) => {
  const text = cssTrim(value);
  const percent = text.endsWith('%');
  const body = percent ? text.slice(0, -1) : text;
  return NUMBER_ONLY.test(body) && finite(body) ? null : 'must be a finite number or a percentage';
};

/** CSS named colours, lower case. */
const NAMED_COLOURS = new Set(
  (
    'aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood ' +
    'cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray ' +
    'darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen ' +
    'darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue ' +
    'firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew ' +
    'hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan ' +
    'lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray ' +
    'lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue ' +
    'mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred ' +
    'midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid ' +
    'palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple ' +
    'rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue ' +
    'slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white ' +
    'whitesmoke yellow yellowgreen transparent currentcolor'
  ).split(' '),
);

const HEX_COLOUR = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
/** Matched after every CSS whitespace run is collapsed to one space, so each optional space is a single character. */
const FUNCTION_COLOUR = new RegExp(
  String.raw`^(?:rgba?|hsla?)\( ?${NUMBER}(?:%|deg)?(?: ?[, ] ?${NUMBER}%?){2}(?: ?[,/] ?${NUMBER}%?)? ?\)$`,
  'i',
);
const CSS_SPACES = new RegExp(`${CSS_SPACE}+`, 'g');

const colour: Check = (value) => {
  const text = cssTrim(value).replace(CSS_SPACES, ' ');
  if (HEX_COLOUR.test(text) || NAMED_COLOURS.has(text.toLowerCase())) {
    return null;
  }
  if (FUNCTION_COLOUR.test(text)) {
    const numbers = text.match(new RegExp(NUMBER, 'g')) ?? [];
    return numbers.every(finite) ? null : 'must be a colour with finite numbers';
  }
  return 'must be a colour: a #hex value, rgb(), hsl() or a colour name';
};

const LOCAL_URL = new RegExp(String.raw`^url\(${CSS_SPACE}*(['"]?)#([A-Za-z_][A-Za-z0-9_.-]*)\1${CSS_SPACE}*\)`);

/** A `url(#id)` reference, or null when the value is not one. */
function localReference(value: string): {id: string; rest: string} | null {
  const text = cssTrim(value);
  const match = LOCAL_URL.exec(text);
  return match === null ? null : {id: match[2]!, rest: cssTrim(text.slice(match[0].length))};
}

const paint: Check = (value) => {
  const text = cssTrim(value);
  if (text === 'none') {
    return null;
  }
  if (/url\s*\(/i.test(text)) {
    const reference = localReference(text);
    if (reference === null) {
      return 'may use url() only as url(#id), naming an element in this file';
    }
    return reference.rest === '' || reference.rest === 'none' || colour(reference.rest) === null
      ? null
      : 'must follow url(#id) with nothing, none or a colour';
  }
  return colour(text);
};

const clipOrMask: Check = (value) => {
  const text = cssTrim(value);
  if (text === 'none') {
    return null;
  }
  const reference = localReference(text);
  return reference !== null && reference.rest === '' ? null : 'must be none or url(#id), naming an element in this file';
};

// Every table keyed by a name taken from the file is a Map: a plain object
// would answer for `constructor` or `__proto__` from its prototype.
const TRANSFORM_ARGUMENTS: ReadonlyMap<string, readonly number[]> = new Map([
  ['matrix', [6]],
  ['translate', [1, 2]],
  ['scale', [1, 2]],
  ['rotate', [1, 3]],
  ['skewX', [1]],
  ['skewY', [1]],
]);

const TRANSFORM_CALL = new RegExp(`^([A-Za-z]+)${CSS_SPACE}*\\(([^()]*)\\)${CSS_SPACE}*,?${CSS_SPACE}*`);

const transform: Check = (value) => {
  let rest = cssTrim(value);
  while (rest !== '') {
    const match = TRANSFORM_CALL.exec(rest);
    if (match === null) {
      return 'must be a list of matrix(), translate(), scale(), rotate(), skewX() and skewY()';
    }
    const counts = TRANSFORM_ARGUMENTS.get(match[1]!);
    const args = cssTrim(match[2]!).split(SEPARATOR).filter((part) => part !== '');
    if (counts === undefined || !counts.includes(args.length) || args.some((arg) => number(arg) !== null)) {
      // A function name is letters only; the value quoted before it already states its length.
      return `has an invalid ${shortenForMessage(match[1]!)}()`;
    }
    rest = rest.slice(match[0].length);
  }
  return null;
};

const PATH_ARITY: ReadonlyMap<string, number> = new Map([
  ['m', 2],
  ['l', 2],
  ['h', 1],
  ['v', 1],
  ['c', 6],
  ['s', 4],
  ['q', 4],
  ['t', 2],
  ['a', 7],
  ['z', 0],
]);

/** SVG path data: commands and finite numbers, arc flags 0 or 1, starting with a move. */
const pathData: Check = (value) => {
  const text = value;
  let index = 0;
  const skip = (): void => {
    while (index < text.length && (isCssSpace(text.charCodeAt(index)) || text[index] === ',')) {
      index += 1;
    }
  };
  const readNumber = (): string | null => {
    NUMBER_AT.lastIndex = index;
    const match = NUMBER_AT.exec(text);
    if (match === null) {
      return null;
    }
    index += match[0].length;
    return match[0];
  };
  skip();
  if (index >= text.length) {
    return null;
  }
  if (!/[Mm]/.test(text[index]!)) {
    return 'must start with a move command, M or m';
  }
  while (index < text.length) {
    skip();
    if (index >= text.length) {
      break;
    }
    const command = text[index]!;
    const arity = PATH_ARITY.get(command.toLowerCase());
    if (arity === undefined) {
      return `uses ${JSON.stringify(command)}, which is not a path command`;
    }
    index += 1;
    if (arity === 0) {
      continue;
    }
    let groups = 0;
    for (;;) {
      skip();
      if (index >= text.length || /[A-Za-z]/.test(text[index]!)) {
        break;
      }
      for (let argument = 0; argument < arity; argument += 1) {
        skip();
        if (command.toLowerCase() === 'a' && (argument === 3 || argument === 4)) {
          const flag = text[index];
          if (flag !== '0' && flag !== '1') {
            return 'has an arc flag that is not 0 or 1';
          }
          index += 1;
          continue;
        }
        const read = readNumber();
        if (read === null || !finite(read)) {
          return `has a ${command} command without its ${arity} numbers`;
        }
      }
      groups += 1;
    }
    if (groups === 0) {
      return `has a ${command} command without its ${arity} numbers`;
    }
  }
  return null;
};

/** A viewBox's four numbers; the check below has accepted `value`. */
function viewBoxNumbers(value: string): number[] {
  return cssTrim(value).split(SEPARATOR).map(Number);
}

const viewBox: Check = (value) => {
  const parts = cssTrim(value).split(SEPARATOR);
  if (parts.length !== 4 || parts.some((part) => number(part) !== null)) {
    return 'must be four numbers: min-x, min-y, width and height';
  }
  return Number(parts[2]) > 0 && Number(parts[3]) > 0 ? null : 'must have a width and height greater than 0';
};

const FAMILY = /^(?:"[^"\\(){};:<>@/=]*"|'[^'\\(){};:<>@/=]*'|[A-Za-z][A-Za-z0-9 _-]*)$/;

const fontFamily: Check = (value) =>
  value.split(',').every((family) => FAMILY.test(cssTrim(family)))
    ? null
    : 'must be a list of font names, with no brackets, colons, slashes or other punctuation';

const fontSize: Check = (value) =>
  oneOf(['xx-small', 'x-small', 'small', 'medium', 'large', 'x-large', 'xx-large', 'larger', 'smaller'])(value) === null
    ? null
    : length(true)(value);

const identifier: Check = (value) =>
  /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(value) ? null : 'must start with a letter or underscore and use only letters, digits, _, . and -';

const ASPECT = new RegExp(`^(?:none|x(?:Min|Mid|Max)Y(?:Min|Mid|Max))(?:${CSS_SPACE}+(?:meet|slice))?$`);

const aspect: Check = (value) =>
  ASPECT.test(cssTrim(value)) ? null : 'must be none, or xMinYMin to xMaxYMax, optionally followed by meet or slice';

const dashArray: Check = (value) => (cssTrim(value) === 'none' ? null : list(length(true), 'non-negative lengths')(value));

const units = oneOf(['userSpaceOnUse', 'objectBoundingBox']);

const miterLimit: Check = (value) => number(value) ?? (Number(value) >= 1 ? null : 'must be at least 1');

const ATTRIBUTES: ReadonlyMap<string, Check> = new Map<string, Check>([
  ['viewBox', viewBox],
  ['id', identifier],
  ['x', list(length(false), 'lengths')],
  ['y', list(length(false), 'lengths')],
  ['x1', length(false)],
  ['y1', length(false)],
  ['x2', length(false)],
  ['y2', length(false)],
  ['width', length(true)],
  ['height', length(true)],
  ['cx', length(false)],
  ['cy', length(false)],
  ['r', length(true)],
  ['rx', length(true)],
  ['ry', length(true)],
  ['d', pathData],
  ['points', list(number, 'numbers', true)],
  ['transform', transform],
  ['preserveAspectRatio', aspect],
  ['fill', paint],
  ['stroke', paint],
  ['opacity', fraction],
  ['fill-opacity', fraction],
  ['stroke-opacity', fraction],
  ['stroke-width', length(true)],
  ['stroke-linecap', oneOf(['butt', 'round', 'square'])],
  ['stroke-linejoin', oneOf(['miter', 'round', 'bevel'])],
  ['stroke-miterlimit', miterLimit],
  ['stroke-dasharray', dashArray],
  ['stroke-dashoffset', length(false)],
  ['fill-rule', oneOf(['nonzero', 'evenodd'])],
  ['clip-rule', oneOf(['nonzero', 'evenodd'])],
  ['font-family', fontFamily],
  ['font-size', fontSize],
  ['font-weight', oneOf(['normal', 'bold', 'bolder', 'lighter', '100', '200', '300', '400', '500', '600', '700', '800', '900'])],
  ['text-anchor', oneOf(['start', 'middle', 'end'])],
  ['dominant-baseline', oneOf([
    'auto',
    'use-script',
    'no-change',
    'reset-size',
    'ideographic',
    'alphabetic',
    'hanging',
    'mathematical',
    'central',
    'middle',
    'text-after-edge',
    'text-before-edge',
    'text-bottom',
    'text-top',
  ])],
  ['dx', list(length(false), 'lengths')],
  ['dy', list(length(false), 'lengths')],
  ['gradientUnits', units],
  ['gradientTransform', transform],
  ['spreadMethod', oneOf(['pad', 'reflect', 'repeat'])],
  ['offset', fraction],
  ['stop-color', colour],
  ['stop-opacity', fraction],
  ['clipPathUnits', units],
  ['maskUnits', units],
  ['maskContentUnits', units],
  ['clip-path', clipOrMask],
  ['mask', clipOrMask],
]);

/** Which elements a url(#id) in each attribute may point at. */
const REFERENCE_TARGETS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['fill', new Set(['linearGradient', 'radialGradient'])],
  ['stroke', new Set(['linearGradient', 'radialGradient'])],
  ['clip-path', new Set(['clipPath'])],
  ['mask', new Set(['mask'])],
]);

/** Why a well-known element outside the profile is refused. */
const REFUSED_ELEMENTS: ReadonlyMap<string, string> = new Map([
  ['script', 'Scripts are not allowed in an SVG.'],
  ['foreignObject', 'foreignObject is not allowed in an SVG.'],
  ['style', 'Style elements are not allowed in an SVG; use presentation attributes such as fill and stroke.'],
  ['image', 'Embedded or linked images are not allowed in an SVG; use a raster image block instead.'],
  ['use', 'use elements are not allowed; draw the shape where it appears.'],
  ['a', 'Links are not allowed inside an SVG.'],
]);

function isXmlSpace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}

/**
 * Where each attribute of one start tag begins, found in a single pass over
 * the tag's text (`start` is its `<`, `end` just after its `>`). saxes has
 * already accepted the tag, so its shape is known; a surprise stops the scan
 * and the remaining attributes are placed at the tag.
 */
function attributeStarts(text: string, start: number, end: number): Map<string, number> {
  const starts = new Map<string, number>();
  const stopsName = (index: number): boolean =>
    isXmlSpace(text.charCodeAt(index)) || text[index] === '=' || text[index] === '>' || text[index] === '/';
  let index = start + 1;
  while (index < end && !stopsName(index)) {
    index += 1;
  }
  for (;;) {
    while (index < end && isXmlSpace(text.charCodeAt(index))) {
      index += 1;
    }
    if (index >= end || text[index] === '>' || text[index] === '/') {
      return starts;
    }
    const nameStart = index;
    while (index < end && !stopsName(index)) {
      index += 1;
    }
    const name = text.slice(nameStart, index);
    while (index < end && isXmlSpace(text.charCodeAt(index))) {
      index += 1;
    }
    if (text[index] !== '=') {
      return starts;
    }
    index += 1;
    while (index < end && isXmlSpace(text.charCodeAt(index))) {
      index += 1;
    }
    const quote = text[index];
    const close = quote === '"' || quote === "'" ? text.indexOf(quote, index + 1) : -1;
    if (close === -1 || close >= end) {
      return starts;
    }
    if (!starts.has(name)) {
      starts.set(name, nameStart);
    }
    index = close + 1;
  }
}

// ---------------------------------------------------------------------------

const FIX_REMOVE = 'Remove it, or export the SVG again with only the shapes, text and gradients it needs.';

/**
 * Validates SVG text against the bounded profile. Pure. Line and column are
 * positions in the SVG file itself.
 */
export function validateSvg(text: string): SvgResult {
  const lines = new LineIndex(text);
  const problems: SvgProblem[] = [];
  let overflow = 0;
  /** Records a problem at an offset, or at one a search finds; once the list is full, only the count grows and no search runs. */
  const report = (offset: number | null | (() => number), message: string, fix: string = FIX_REMOVE): void => {
    if (problems.length >= MAX_PROBLEMS) {
      overflow += 1;
      return;
    }
    const found = typeof offset === 'function' ? offset() : offset;
    const at = found === null ? null : lines.position(found);
    problems.push({message, fix, line: at?.line ?? null, column: at?.column ?? null});
  };

  // saxes runs without its namespace mode, whose prefix lookup walks every
  // open element and makes deep nesting quadratic. The profile allows no
  // prefix at all, so the one namespace fact needed is the default namespace
  // in scope, kept here per open element (D154).
  const parser = new SaxesParser({xmlns: false, position: true});
  const ids = new Map<string, {element: string; offset: number}>();
  const references: {id: string; attribute: string; offset: number}[] = [];
  const open: string[] = [];
  const namespaces: string[] = [];
  /** How many of the open elements were refused; their content is not reported again. */
  let refusedDepth = 0;
  const refusedAt: boolean[] = [];
  /** Where the last piece of markup ended: a text node starts there. */
  let markupEnd = 0;
  let tagStart = 0;
  let root: {viewBox: readonly [number, number, number, number] | null} | null = null;
  /** Where the root's viewBox attribute is, for a problem with its size. */
  let viewBoxAt = 0;

  parser.on('xmldecl', (declaration) => {
    // saxes reads any other version with XML 1.1's rules, which allow references to
    // control characters such as &#x1;; a browser shows such a file as a broken image.
    if (declaration.version !== undefined && declaration.version !== '1.0') {
      report(0, `The SVG declares XML version ${named(declaration.version)}; only version 1.0 is accepted.`, 'Declare version="1.0", or leave the XML declaration out.');
    }
    if (declaration.encoding !== undefined && declaration.encoding.toLowerCase() !== 'utf-8') {
      report(0, `The SVG declares the ${named(declaration.encoding)} encoding; only UTF-8 is accepted.`, 'Save the file as UTF-8 and declare encoding="UTF-8", or leave the encoding out.');
    }
  });
  // saxes reports a declaration just after its closing `>`, where the next one
  // may already begin, so each is found by searching back from that `>` over
  // the declaration itself. Searching from the start of the file for each of
  // many DOCTYPEs made the check quadratic (D154).
  parser.on('doctype', () => {
    report(() => Math.max(0, text.lastIndexOf('<!DOCTYPE', parser.position - 1)), 'The SVG has a DOCTYPE; document type and entity declarations are not allowed.', 'Remove the <!DOCTYPE …> declaration.');
  });
  parser.on('processinginstruction', (instruction) => {
    report(() => text.lastIndexOf('<?', parser.position - 1), `The SVG has a <?${named(instruction.target)} ?> instruction, which is not allowed.`, 'Remove the processing instruction.');
  });
  parser.on('opentagstart', () => {
    tagStart = Math.max(0, text.lastIndexOf('<', parser.position - 1));
  });
  parser.on('opentag', (tag: SaxesTagPlain) => {
    const isRoot = open.length === 0;
    const attributes = tag.attributes as Readonly<Record<string, string>>;
    const namespace = Object.hasOwn(attributes, 'xmlns') ? attributes['xmlns']! : (namespaces.at(-1) ?? '');
    const colon = tag.name.indexOf(':');
    const prefixed = colon !== -1;
    const local = prefixed ? tag.name.slice(colon + 1) : tag.name;
    open.push(local);
    namespaces.push(namespace);
    markupEnd = parser.position;
    const refused = prefixed || namespace !== SVG_NAMESPACE || !SVG_ELEMENTS.has(local);
    refusedAt.push(refused);
    if (refused) {
      refusedDepth += 1;
    }
    if (isRoot && local !== 'svg') {
      root = {viewBox: null};
      report(tagStart, `The root element is ${named(tag.name)}; an SVG file must start with an svg element.`, 'Make svg the root element.');
    } else if (prefixed || namespace !== SVG_NAMESPACE) {
      report(
        tagStart,
        !prefixed && namespace === '' && isRoot
          ? 'The root svg element does not declare the SVG namespace.'
          : `The element ${named(tag.name)} is outside the SVG namespace.`,
        isRoot ? 'Add xmlns="http://www.w3.org/2000/svg" to the root svg element.' : FIX_REMOVE,
      );
    } else if (!SVG_ELEMENTS.has(local)) {
      report(tagStart, REFUSED_ELEMENTS.get(local) ?? `The element ${named(local)} is not allowed in an SVG.`);
    }
    if (isRoot) {
      root = {viewBox: null};
    }

    const starts = attributeStarts(text, tagStart, parser.position);
    for (const [name, value] of Object.entries(attributes)) {
      const offset = starts.get(name) ?? tagStart;
      if (name === 'xmlns') {
        if (value !== SVG_NAMESPACE) {
          report(offset, `The default namespace ${named(value)} is not the SVG namespace.`, 'Set xmlns="http://www.w3.org/2000/svg".');
        }
        continue;
      }
      if (name.includes(':')) {
        report(
          offset,
          name.endsWith(':href') ? `The attribute ${named(name)} links outside the SVG and is not allowed.` : `The namespaced attribute ${named(name)} is not allowed.`,
          FIX_REMOVE,
        );
        continue;
      }
      if (/^on/i.test(name)) {
        report(offset, `The event attribute ${named(name)} is not allowed in an SVG.`);
        continue;
      }
      if (name === 'style') {
        report(offset, 'The style attribute is not allowed in an SVG.', 'Write each property as its own attribute, such as fill="#1d1d1a".');
        continue;
      }
      if (name === 'href') {
        report(offset, 'The href attribute is not allowed in an SVG.');
        continue;
      }
      const check = ATTRIBUTES.get(name);
      if (check === undefined) {
        report(offset, `The attribute ${named(name)} is not allowed in an SVG.`);
        continue;
      }
      const problem = check(value);
      if (problem !== null) {
        report(offset, `The ${name} value ${quoteValue(value, 'json')} ${problem}.`, `Correct the ${name} value.`);
        continue;
      }
      if (name === 'id') {
        if (ids.has(value)) {
          report(offset, `The id ${named(value)} is used twice.`, 'Give every element a different id.');
        } else {
          ids.set(value, {element: local, offset});
        }
      }
      if (REFERENCE_TARGETS.has(name)) {
        const reference = localReference(value);
        if (reference !== null) {
          references.push({id: reference.id, attribute: name, offset});
        }
      }
      if (isRoot && name === 'viewBox') {
        const [minX, minY, width, height] = viewBoxNumbers(value) as [number, number, number, number];
        root = {viewBox: [minX, minY, width, height]};
        viewBoxAt = offset;
      }
    }
  });
  parser.on('closetag', () => {
    open.pop();
    namespaces.pop();
    if (refusedAt.pop() === true) {
      refusedDepth -= 1;
    }
    markupEnd = parser.position;
  });
  parser.on('comment', () => {
    markupEnd = parser.position;
  });
  const checkText = (content: string, kind: string): void => {
    const start = markupEnd;
    markupEnd = parser.position;
    if (content.trim() === '' || refusedDepth > 0) {
      return;
    }
    // The first visible character of the text, in the file.
    let offset = start;
    while (offset < text.length && /\s/.test(text[offset]!)) {
      offset += 1;
    }
    const current = open.at(-1);
    if (current === undefined || !TEXT_ELEMENTS.has(current)) {
      report(offset, `${kind} is only allowed inside text, tspan, title and desc.`, 'Remove the stray text, or put it in a text element.');
      return;
    }
    if (/url\s*\(|@import/i.test(content)) {
      report(offset, `Text in the ${current} element contains url( or @import, which the profile does not allow.`, 'Rewrite the text without url( or @import.');
    }
  };
  parser.on('text', (content) => checkText(content, 'Text'));
  parser.on('cdata', (content) => checkText(content, 'CDATA'));
  parser.on('error', (error) => {
    if (problems.length >= MAX_PROBLEMS) {
      // Counted without searching for a position no one will see.
      overflow += 1;
      return;
    }
    const message = error.message.replace(/^\d+:\d+: /, '');
    // saxes reports after the offending construct; an entity is shown at its ampersand.
    const at = /entity/i.test(message) ? text.lastIndexOf('&', parser.position - 1) : parser.position - 1;
    // saxes names the tag or attribute at fault, which may be as long as the file.
    report(Math.max(0, at), `The SVG is not well-formed XML: ${shortenForMessage(message)}`, 'Fix the XML, or export the SVG again.');
  });

  try {
    parser.write(text).close();
  } catch (error) {
    // saxes rethrows the error it reported when there is no handler; the handler is set, so this is a defect.
    throw new Error(`E_INTERNAL: saxes failed after reporting: ${(error as Error).message}`);
  }

  const parsedRoot = root as {viewBox: readonly [number, number, number, number] | null} | null;
  if (parsedRoot === null) {
    report(null, 'The file has no svg element.', 'Save a complete SVG file.');
  } else if (parsedRoot.viewBox === null && problems.length === 0) {
    report(0, 'The SVG has no viewBox, so its size is unknown.', 'Add viewBox="0 0 width height" to the root svg element.');
  } else if (parsedRoot.viewBox !== null) {
    const [, , width, height] = parsedRoot.viewBox;
    if (width < 1 || height < 1) {
      report(
        viewBoxAt,
        `The viewBox is ${width} by ${height}; an SVG's size is its viewBox in pixels, at least 1 on each side.`,
        'Export the drawing larger, so that its viewBox is at least 1 unit on each side, such as viewBox="0 0 800 600".',
      );
    } else if (Math.round(width) * Math.round(height) > INPUT_LIMITS.imagePixels) {
      report(
        viewBoxAt,
        `The viewBox is ${width} by ${height}; an SVG's size is its viewBox in pixels, and images are limited to ${pixelFormat.format(INPUT_LIMITS.imagePixels)} pixels.`,
        'Export the drawing smaller, so that its viewBox width times its height is at most 100,000,000, such as viewBox="0 0 800 600".',
      );
    }
  }
  for (const reference of references) {
    const target = ids.get(reference.id);
    if (target === undefined) {
      report(reference.offset, `The ${reference.attribute} reference url(#${named(reference.id)}) names no element in this file.`, 'Point it at the id of an element in this file, or remove it.');
    } else if (!REFERENCE_TARGETS.get(reference.attribute)!.has(target.element)) {
      report(
        reference.offset,
        `The ${reference.attribute} reference url(#${named(reference.id)}) names a ${named(target.element)}, not a ${[...REFERENCE_TARGETS.get(reference.attribute)!].join(' or ')}.`,
        'Point it at an element of the right kind.',
      );
    }
  }

  if (problems.length > 0) {
    if (overflow > 0) {
      const last = problems[problems.length - 1]!;
      problems[problems.length - 1] = {...last, message: `${last.message} (${overflow} more problem${overflow === 1 ? '' : 's'} in this file are not listed.)`};
    }
    return {ok: false, problems};
  }
  const box = parsedRoot!.viewBox!;
  return {ok: true, width: Math.round(box[2]), height: Math.round(box[3]), viewBox: box};
}
