/**
 * R08: the generated page is valid HTML and keeps the output rules (D65).
 *
 * html-validate 11 runs on every page with `html-validate:recommended`, two
 * rules of its document preset (`missing-doctype`, `no-missing-references`)
 * and these deliberate changes, each for a reason the page cannot avoid:
 *
 * - `no-inline-style` is off, because `papeleria/resources` holds every
 *   inline style to the three declarations the generator writes, value and
 *   all: a swatch's checked hex colour, as the reference paints it, a focal
 *   point's `object-position`, and the `text-align` markdown-it puts on the
 *   cells of an aligned Markdown table; and, on a comic panel alone, its box
 *   as `left`, `top`, `width` and `height` in percent (M4.2, W4, D105). One
 *   check, so one finding.
 * - `unique-landmark` is off: every notes aside carries the one `notes_label`
 *   (D161, CONTRACT §2) inside its own slide article, which its title names,
 *   and the enhanced deck shows one slide at a time.
 * - `prefer-native-element` allows `role="region"`: the kit's table region is
 *   `div.table-wrap[role=region]` (UX §09).
 * - `valid-id` is relaxed to what HTML allows (no space): a footnote cited
 *   twice gets the id `fnref-…:1` from markdown-it-footnote.
 * - `long-title`, `no-trailing-whitespace` and `tel-non-breaking` are off: the
 *   page title is the author's cover title, whitespace inside `<pre>` is the
 *   author's code, and a phone number's spaces are the author's.
 *
 * Four rules of Papeleria's own run in the same pass, as an html-validate
 * plugin, over the parsed page. html-validate hands a rule an attribute's
 * value as written, and a browser decodes character references, so each value
 * is read through `decodeAttribute` first:
 *
 * - `papeleria/references`: every character reference in an attribute is one
 *   the generator writes (`&amp;`, `&lt;`, `&gt;`, `&quot;`, `&#39;` and
 *   numeric ones), so nothing the rules read can differ from what runs;
 * - `papeleria/scripts`: exactly the template's one classic script, loaded
 *   from its file, and every JSON block inert and parseable (C22, IC02);
 * - `papeleria/resources`: every automatically loaded resource a relative URL
 *   to a file the generation holds, no speculative link, no inline handler,
 *   no inline style but the three declarations the generator writes, no frame,
 *   form, base, style, template or MathML element (C24, IC02);
 * - `papeleria/navigation`: every link allowed by the IC02 policy (D151);
 * - `papeleria/link-targets`: every relative link that stays inside the output
 *   names a file the build wrote, and every fragment of the page names
 *   something on it (D172). The message is the author's to act on, and says
 *   which link, for R08 to find where it is written.
 *
 * html-validate keeps no element inside an inline `<svg>`, so every inline SVG
 * (a chart drawn at build time) is parsed apart as XML (`scanInlineSvg`): only
 * the IC02 SVG elements, and no handler, link, style or `url()` other than
 * `url(#id)`. Stylesheets are scanned apart too (`scanStylesheet`): every
 * `url()` relative and present, no `@import`.
 */
import {HtmlValidate, Rule, StaticConfigLoader, definePlugin, type DOMReadyEvent, type HtmlElement, type RuleConfig} from 'html-validate';
import {SaxesParser, type SaxesTagPlain} from 'saxes';

import {classifyLink, hrefAsRead, LineIndex, quoteValue, SVG_ELEMENTS} from '../core/index.js';

/** A link that leads nowhere in the output, as `papeleria/link-targets` found it: its href as the page carries it (D172). */
export type LinkProblem = {readonly href: string; readonly problem: 'file' | 'folder' | 'fragment'};

export type PageMessage = {
  readonly rule: string;
  readonly message: string;
  readonly line: number | null;
  readonly column: number | null;
  /** For `papeleria/link-targets` alone. */
  readonly link?: LinkProblem;
};

/** The html-validate rules Papeleria changes, with the reasons in this module's comment (D65). */
const RULES: RuleConfig = {
  'missing-doctype': 'error',
  'no-missing-references': 'error',
  'no-inline-style': 'off',
  'unique-landmark': 'off',
  'prefer-native-element': ['error', {exclude: ['region']}],
  'valid-id': ['error', {relaxed: true}],
  'long-title': 'off',
  'no-trailing-whitespace': 'off',
  'tel-non-breaking': 'off',
};
export const HTML_VALIDATE_RULES: Readonly<RuleConfig> = Object.freeze(RULES);

/** Where a URL a file loads points, as a path in the output, or why it is not allowed. */
export function resolveOutputUrl(url: string, fromDirectory: string): {readonly path: string} | {readonly problem: string} {
  if (url.trim() === '') {
    return {problem: 'is empty'};
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(url)) {
    return {problem: 'names a scheme, so it loads from outside the piece'};
  }
  if (/^[\\/]/.test(url)) {
    return {problem: 'is absolute, so it breaks when the piece opens from another folder'};
  }
  if (/[?#\\]/.test(url)) {
    return {problem: 'has a query, a fragment or a backslash'};
  }
  const segments = fromDirectory === '' ? [] : fromDirectory.split('/');
  for (const raw of url.split('/')) {
    let segment: string;
    try {
      segment = decodeURIComponent(raw);
    } catch {
      return {problem: 'is not a valid URL path'};
    }
    if (segment === '' || segment === '.') {
      continue;
    }
    if (segment === '..') {
      if (segments.length === 0) {
        return {problem: 'leaves the output folder'};
      }
      segments.pop();
    } else {
      segments.push(segment);
    }
  }
  return {path: segments.join('/')};
}

/** Where an anchor's relative href leads from the page at the output's root: the page itself when `path` is null. */
export type LinkTarget =
  | {readonly kind: 'inside'; readonly path: string | null; readonly fragment: string | null}
  | {readonly kind: 'folder'; readonly path: string}
  | {readonly kind: 'outside'};

/** A single-dot and a double-dot path segment, written plainly or percent-encoded, as a URL parser reads them. */
const DOT = /^(?:\.|%2e)$/i;
const DOUBLE_DOT = /^(?:\.|%2e){2}$/i;

/**
 * Where a link leads, read as a browser reads it from `index.html` at the
 * output's root (D172): spaces, controls, tabs and line breaks as for the
 * navigation policy, the fragment and then the query split off, a backslash
 * taken for a slash, `.` and `..` segments resolved, and each other segment
 * percent-decoded to the file name it asks for. A path that ends in a slash, a
 * `.` or a `..` names a folder; one that climbs above the output's root has
 * left it. Null for a link that is not relative: external, mail, phone, or
 * refused by the policy.
 */
export function resolveLinkTarget(href: string): LinkTarget | null {
  const value = hrefAsRead(href);
  const verdict = classifyLink(value);
  if (!verdict.ok || (verdict.kind !== 'relative' && verdict.kind !== 'fragment')) {
    return null;
  }
  const hash = value.indexOf('#');
  const fragment = hash === -1 ? null : value.slice(hash + 1);
  const beforeHash = hash === -1 ? value : value.slice(0, hash);
  const query = beforeHash.indexOf('?');
  const path = (query === -1 ? beforeHash : beforeHash.slice(0, query)).replaceAll('\\', '/');
  if (path === '') {
    return {kind: 'inside', path: null, fragment};
  }
  const segments: string[] = [];
  const written = path.split('/');
  for (const segment of written) {
    if (DOUBLE_DOT.test(segment)) {
      if (segments.length === 0) {
        return {kind: 'outside'};
      }
      segments.pop();
    } else if (segment === '') {
      // The browser keeps the empty segment `//` makes, so a `..` after it takes that one away, not the folder before
      // it (PRR-06): `theme//../deck.js` asks for theme/deck.js. The file is looked up without them, below.
      segments.push('');
    } else if (!DOT.test(segment)) {
      let name = segment;
      try {
        name = decodeURIComponent(segment);
      } catch {
        // Not valid percent-encoding: the browser asks for the name as written.
      }
      // A separator written encoded, %2F or %5C, stays inside its segment: the browser asks for that one name, which no
      // file of the output has, and the preview's server refuses (generationSegments). Kept as written, it matches none.
      segments.push(/[/\\]/.test(name) ? segment : name);
    }
  }
  const last = written.at(-1)!;
  // Opened from disk, `a//b` is the file a/b.
  const named = segments.filter((segment) => segment !== '').join('/');
  if (last === '' || DOT.test(last) || DOUBLE_DOT.test(last)) {
    return {kind: 'folder', path: named};
  }
  return {kind: 'inside', path: named, fragment};
}

/**
 * The addresses a template's script shows as places of their own, beside the
 * ids of the page (D172): the deck's `#slide-N` and the comic reader's
 * `#page-N` and `#page-N-panel-M`, the numbers in ASCII digits, as
 * `deck-logic.ts` and `reader-logic.ts` read them. Each shows the slide, page
 * or panel whose id is its canonical form; a number past the end or naming no
 * panel is corrected by the script, and names nothing.
 */
const CLIENT_ADDRESSES: ReadonlyMap<string, (decoded: string) => string | null> = new Map([
  [
    'deck.js',
    (decoded: string) => {
      const match = /^slide-([0-9]+)$/.exec(decoded);
      return match === null ? null : `slide-${Number(match[1])}`;
    },
  ],
  [
    'reader.js',
    (decoded: string) => {
      const match = /^page-([0-9]+)(?:-panel-([0-9]+))?$/.exec(decoded);
      return match === null ? null : `page-${Number(match[1])}${match[2] === undefined ? '' : `-panel-${Number(match[2])}`}`;
    },
  ],
]);

/**
 * Whether a fragment of the page names something on it, as the browser and
 * the page's script find it (D172): an element's id, as written or
 * percent-decoded; the top of the page, for an empty fragment or `top`; or a
 * place the script shows.
 */
function namesPlace(fragment: string, ids: ReadonlySet<string>, script: string | null): boolean {
  if (fragment === '' || ids.has(fragment)) {
    return true;
  }
  let decoded = fragment;
  try {
    decoded = decodeURIComponent(fragment);
  } catch {
    // Not valid percent-encoding: nothing but the fragment as written can match.
  }
  if (ids.has(decoded) || /^top$/i.test(decoded)) {
    return true;
  }
  const canonical = script === null ? null : (CLIENT_ADDRESSES.get(script)?.(decoded) ?? null);
  return canonical !== null && ids.has(canonical);
}

type ScriptOptions = {readonly script: string | null};
type ResourceOptions = {readonly files: readonly string[]};
type LinkTargetOptions = {readonly files: readonly string[]; readonly script: string | null};

/** The page `validatePage` reads, and what a link without a path leads to. */
const PAGE = 'index.html';

const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);
/**
 * Elements that would load, embed or submit something, restyle the page
 * outside its stylesheets, or hide their content from this scan (html-validate
 * keeps no children of `template` or `math`).
 */
const FORBIDDEN_ELEMENTS = ['base', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'portal', 'form', 'style', 'template', 'math'];
/** The only `link` relations a page may have. */
const ALLOWED_LINKS = new Set(['stylesheet', 'icon']);
/** Every attribute that makes the browser load a URL by itself, by element. */
const LOADING_ATTRIBUTES: readonly (readonly [element: string, attribute: string, list: boolean])[] = [
  ['script', 'src', false],
  ['link', 'href', false],
  ['img', 'src', false],
  ['img', 'srcset', true],
  ['source', 'src', false],
  ['source', 'srcset', true],
  ['video', 'src', false],
  ['video', 'poster', false],
  ['audio', 'src', false],
  ['track', 'src', false],
  ['input', 'src', false],
];

/** The references the generator writes in an attribute value, matched where a `&` stands. */
const REFERENCE_AT = /&(?:#([0-9]{1,7})|#[xX]([0-9a-fA-F]{1,6})|(amp|lt|gt|quot|apos));/y;
const NAMED_REFERENCES: Readonly<Record<string, string>> = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'"};

/**
 * An attribute value as a browser reads it, or null when a `&` in it begins
 * no reference the generator writes: its five escapes and numeric references
 * to a character (IC02). html-validate reports values as written, and a
 * browser reads `&#106;avascript:` as `javascript:`.
 */
export function decodeAttribute(raw: string): string | null {
  let decoded = '';
  let index = 0;
  for (let amp = raw.indexOf('&'); amp !== -1; amp = raw.indexOf('&', index)) {
    decoded += raw.slice(index, amp);
    REFERENCE_AT.lastIndex = amp;
    const match = REFERENCE_AT.exec(raw);
    if (match === null) {
      return null;
    }
    if (match[3] !== undefined) {
      decoded += NAMED_REFERENCES[match[3]]!;
    } else {
      const code = match[1] !== undefined ? Number(match[1]) : Number.parseInt(match[2]!, 16);
      if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
        return null;
      }
      decoded += String.fromCodePoint(code);
    }
    index = REFERENCE_AT.lastIndex;
  }
  return decoded + raw.slice(index);
}

/** An attribute's value as a browser reads it; one `papeleria/references` refuses is read as written. */
function attributeText(element: HtmlElement, name: string): string | null {
  const value = element.getAttributeValue(name);
  return typeof value === 'string' ? (decodeAttribute(value) ?? value) : null;
}

const CSS_NUMBER = String.raw`\d+(?:\.\d+)?(?:e[+-]?\d+)?`;
/**
 * Every declaration the generator writes inline (D65): a swatch's checked hex
 * colour, a focal point's position and a Markdown table cell's alignment.
 * Anything else in a style attribute is refused, `image-set()` and CSS escapes
 * included.
 */
const INLINE_DECLARATIONS: readonly RegExp[] = [
  /^background:#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/,
  new RegExp(`^object-position:${CSS_NUMBER}% ${CSS_NUMBER}%$`),
  /^text-align:(?:left|right|center)$/,
];

/**
 * A comic panel's box, which the generator writes on the panel alone: where
 * its button stands over the page image, in percent (D105). IC06 names these
 * "inline styles needed for generated positions".
 */
const PANEL_BOX_DECLARATIONS: readonly RegExp[] = [new RegExp(`^(?:left|top|width|height):${CSS_NUMBER}%$`)];

/** The declarations of a style value that the generator never writes; a comic panel may also hold its box. */
export function unexpectedDeclarations(style: string, options: {readonly panelBox?: boolean} = {}): string[] {
  const allowed = options.panelBox === true ? [...INLINE_DECLARATIONS, ...PANEL_BOX_DECLARATIONS] : INLINE_DECLARATIONS;
  return style
    .split(';')
    .map((declaration) => declaration.trim())
    .filter((declaration) => declaration !== '' && !allowed.some((pattern) => pattern.test(declaration)));
}

class ScriptsRule extends Rule<void, ScriptOptions> {
  static override schema(): null {
    return null;
  }

  setup(): void {
    this.on('dom:ready', (event: DOMReadyEvent) => {
      const expected = this.options.script;
      let executable = 0;
      for (const element of event.document.querySelectorAll('script')) {
        const type = attributeText(element, 'type');
        const text = element.textContent;
        if (type === 'application/json') {
          if (/[<>&]/.test(text) || text.includes(LINE_SEPARATOR) || text.includes(PARAGRAPH_SEPARATOR)) {
            this.report(element, 'A JSON data block holds a raw <, >, &, U+2028 or U+2029 instead of its \\u escape (IC02)');
          }
          try {
            JSON.parse(text);
          } catch {
            this.report(element, 'A JSON data block is not valid JSON');
          }
          if (element.hasAttribute('src')) {
            this.report(element, 'A JSON data block loads a file');
          }
          continue;
        }
        executable += 1;
        const src = attributeText(element, 'src');
        if (type !== null && type !== 'text/javascript') {
          this.report(element, `A script has type="${type}"; the one script is a classic script`);
        }
        if (src === null || text.trim() !== '') {
          this.report(element, 'A script holds inline code; the page may run only its template\'s script file');
        } else if (src !== expected) {
          this.report(element, `The page loads the script ${src}, which is not its template's script${expected === null ? '' : ` ${expected}`}`);
        }
      }
      const wanted = expected === null ? 0 : 1;
      if (executable !== wanted) {
        this.report(event.document.querySelector('head'), `The page has ${executable} executable scripts; it must have exactly ${wanted} (C22)`);
      }
    });
  }
}

class ResourcesRule extends Rule<void, ResourceOptions> {
  static override schema(): null {
    return null;
  }

  setup(): void {
    this.on('dom:ready', (event: DOMReadyEvent) => {
      const files = new Set(this.options.files);
      const document = event.document;
      for (const name of FORBIDDEN_ELEMENTS) {
        for (const element of document.querySelectorAll(name)) {
          this.report(element, `<${name}> is not allowed in published output`);
        }
      }
      for (const element of document.querySelectorAll('meta')) {
        const equiv = (attributeText(element, 'http-equiv') ?? '').toLowerCase();
        if (equiv !== '' && equiv !== 'content-type') {
          this.report(element, `<meta http-equiv="${equiv}"> is not allowed in published output`);
        }
      }
      for (const element of document.querySelectorAll('link')) {
        const relations = (attributeText(element, 'rel') ?? '').toLowerCase().split(/\s+/).filter((relation) => relation !== '');
        if (relations.length === 0 || relations.some((relation) => !ALLOWED_LINKS.has(relation))) {
          this.report(element, `A link with rel="${relations.join(' ')}" asks the browser to fetch something the page does not show; only stylesheet and icon links are allowed`);
        }
      }
      for (const [tag, attribute, list] of LOADING_ATTRIBUTES) {
        for (const element of document.querySelectorAll(tag)) {
          const value = attributeText(element, attribute);
          if (value === null) {
            continue;
          }
          const urls = list ? value.split(',').map((candidate) => candidate.trim().split(/\s+/)[0] ?? '') : [value];
          for (const url of urls) {
            const resolved = resolveOutputUrl(url, '');
            if ('problem' in resolved) {
              this.report(element, `The ${tag} ${attribute} ${quoteValue(url, 'json')} ${resolved.problem}`);
            } else if (!files.has(resolved.path)) {
              this.report(element, `The ${tag} ${attribute} ${quoteValue(url, 'json')} names a file the output does not have`);
            }
          }
        }
      }
      for (const element of document.querySelectorAll('*')) {
        for (const attribute of element.attributes) {
          const key = attribute.key.toLowerCase();
          if (key.startsWith('on')) {
            this.report(element, `The ${key} attribute runs code; published output has no inline handlers`);
          } else if (key === 'srcdoc' || key === 'ping') {
            this.report(element, `The ${key} attribute is not allowed in published output`);
          } else if (key === 'style') {
            const panelBox = (attributeText(element, 'class') ?? '').split(/\s+/).includes('comic-panel');
            const unexpected = unexpectedDeclarations(attributeText(element, 'style') ?? '', {panelBox});
            if (unexpected.length > 0) {
              this.report(element, `The style attribute holds ${quoteValue(unexpected.join('; '), 'json')}; inline, the generator writes only a swatch's background colour, a focal point's object-position, a table cell's text-align and a comic panel's box`);
            }
          }
        }
      }
    });
  }
}

class ReferencesRule extends Rule<void, void> {
  setup(): void {
    this.on('dom:ready', (event: DOMReadyEvent) => {
      for (const element of event.document.querySelectorAll('*')) {
        for (const attribute of element.attributes) {
          const raw = attribute.value;
          if (typeof raw === 'string' && decodeAttribute(raw) === null) {
            this.report(element, `The ${attribute.key} attribute holds a character reference the generator never writes: ${quoteValue(raw, 'json')}`);
          }
        }
      }
    });
  }
}

class NavigationRule extends Rule<void, void> {
  setup(): void {
    this.on('dom:ready', (event: DOMReadyEvent) => {
      for (const element of event.document.querySelectorAll('a, area')) {
        const href = attributeText(element, 'href');
        if (href !== null) {
          const verdict = classifyLink(href);
          if (!verdict.ok) {
            this.report(element, `The link ${quoteValue(href, 'json')} uses ${verdict.reason}`);
          }
        }
        if (element.hasAttribute('target')) {
          const relations = (attributeText(element, 'rel') ?? '').toLowerCase().split(/\s+/);
          if (!relations.includes('noopener') || !relations.includes('noreferrer')) {
            this.report(element, 'A link that opens a new browsing context needs rel="noopener noreferrer" (IC02)');
          }
        }
      }
    });
  }
}

/**
 * D172: a relative link that stays inside the output must name a file the
 * build wrote, never a folder, and a fragment of the page must name something
 * on it. A link that climbs out of the output folder (`../other-piece/`) is
 * allowed and not verified: where the piece is published, and what stands
 * beside it, is not the build's to know. A fragment of another file the build
 * wrote is not read.
 */
class LinkTargetsRule extends Rule<LinkProblem, LinkTargetOptions> {
  static override schema(): null {
    return null;
  }

  setup(): void {
    this.on('dom:ready', (event: DOMReadyEvent) => {
      const files = new Set(this.options.files);
      const ids = new Set<string>();
      for (const element of event.document.querySelectorAll('*')) {
        const id = attributeText(element, 'id');
        if (id !== null) {
          ids.add(id);
        }
      }
      for (const element of event.document.querySelectorAll('a, area')) {
        const href = attributeText(element, 'href');
        const target = href === null ? null : resolveLinkTarget(href);
        if (href === null || target === null || target.kind === 'outside') {
          continue;
        }
        // A long address is cut and its hidden characters shown, as every quoted author value is (D175).
        const shown = quoteValue(href, 'json');
        if (target.kind === 'folder') {
          this.report(element, `The link ${shown} names a folder, not a file`, null, {href, problem: 'folder'});
        } else if (target.path !== null && target.path !== PAGE && !files.has(target.path)) {
          this.report(element, `The link ${shown} names a file the output does not have`, null, {href, problem: 'file'});
        } else if ((target.path === null || target.path === PAGE) && target.fragment !== null && !namesPlace(target.fragment, ids, this.options.script)) {
          this.report(element, `The link ${shown} names nothing on the page`, null, {href, problem: 'fragment'});
        }
      }
    });
  }
}

const plugin = definePlugin({
  name: 'papeleria',
  rules: {
    'papeleria/references': ReferencesRule,
    'papeleria/scripts': ScriptsRule,
    'papeleria/resources': ResourcesRule,
    'papeleria/navigation': NavigationRule,
    'papeleria/link-targets': LinkTargetsRule,
  },
});

/** Validates a generated page: html-validate's rules and Papeleria's own, one pass. */
export async function validatePage(html: string, options: {readonly files: readonly string[]; readonly script: string | null}): Promise<PageMessage[]> {
  const loader = new StaticConfigLoader({
    plugins: [plugin],
    extends: ['html-validate:recommended'],
    rules: {
      ...HTML_VALIDATE_RULES,
      'papeleria/references': 'error',
      'papeleria/scripts': ['error', {script: options.script}],
      'papeleria/resources': ['error', {files: [...options.files]}],
      'papeleria/navigation': 'error',
      'papeleria/link-targets': ['error', {files: [...options.files], script: options.script}],
    },
  });
  const report = await new HtmlValidate(loader).validateString(html, PAGE);
  const messages: PageMessage[] = report.results.flatMap((result) =>
    result.messages.map((message) => ({
      rule: message.ruleId,
      message: message.message,
      line: Number.isInteger(message.line) && message.line > 0 ? message.line : null,
      column: Number.isInteger(message.column) && message.column > 0 ? message.column : null,
      ...(message.ruleId === 'papeleria/link-targets' ? {link: message.context as LinkProblem} : {}),
    })),
  );
  return messages.concat(scanInlineSvg(html));
}

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
/** A reference to an element of the same drawing, the one `url()` an SVG attribute may hold. */
const LOCAL_URL = /^url\(\s*#[A-Za-z_][\w.-]*\s*\)$/;

/** Why an attribute of an inline SVG element could run, load or restyle something, or null. */
function svgAttributeProblem(name: string, value: string): string | null {
  const local = name.slice(name.indexOf(':') + 1).toLowerCase();
  if (local.startsWith('on')) {
    return `the ${name} attribute, which runs code`;
  }
  if (local === 'href' || local === 'src' || local === 'base') {
    return `the ${name} attribute, which links to or loads something`;
  }
  if (local === 'style') {
    return 'a style attribute; a drawing is styled by its attributes';
  }
  if (name === 'xmlns' ? value !== SVG_NAMESPACE : name.startsWith('xmlns:')) {
    return `the namespace declaration ${name}="${value}"`;
  }
  if (/url\s*\(/i.test(value) && !LOCAL_URL.test(value.trim())) {
    return `the ${name} attribute, which loads something through url()`;
  }
  return null;
}

/**
 * Checks every inline `<svg>` in a page as XML, which html-validate does not:
 * well formed, only the IC02 SVG elements, and no attribute that runs, links,
 * loads or restyles (D65). A chart is drawn from escaped values by trusted
 * code (IC02); this catches a defect in that code before it ships.
 */
export function scanInlineSvg(html: string): PageMessage[] {
  const lines = new LineIndex(html);
  const messages: PageMessage[] = [];
  for (const match of html.matchAll(/<svg\b[\s\S]*?<\/svg\s*>/gi)) {
    const region = match[0];
    const at = (offset: number): {line: number; column: number} => {
      const position = lines.position(match.index + Math.max(0, Math.min(offset, region.length - 1)));
      return {line: position.line, column: position.column};
    };
    const report = (offset: number, message: string): void => {
      messages.push({rule: 'papeleria/svg', message, ...at(offset)});
    };
    const parser = new SaxesParser({xmlns: false, position: true});
    let tagStart = 0;
    let broken = false;
    parser.on('opentagstart', () => {
      tagStart = Math.max(0, region.lastIndexOf('<', parser.position - 1));
    });
    parser.on('opentag', (tag: SaxesTagPlain) => {
      if (!SVG_ELEMENTS.has(tag.name)) {
        report(tagStart, `An inline SVG holds <${tag.name}>, which no drawing may hold`);
      }
      for (const [name, value] of Object.entries(tag.attributes)) {
        const problem = svgAttributeProblem(name, value);
        if (problem !== null) {
          report(tagStart, `The inline SVG element <${tag.name}> has ${problem}`);
        }
      }
    });
    parser.on('doctype', () => report(parser.position - 1, 'An inline SVG holds a document type declaration'));
    parser.on('processinginstruction', () => report(parser.position - 1, 'An inline SVG holds a processing instruction'));
    parser.on('error', (error: Error) => {
      if (!broken) {
        broken = true;
        report(parser.position - 1, `An inline SVG is not well-formed XML: ${error.message.split('\n')[0]}`);
      }
    });
    parser.write(region).close();
  }
  return messages;
}

/** Scans one stylesheet: every `url()` relative and present in the output, no `@import` (C24). */
export function scanStylesheet(css: string, path: string, files: ReadonlySet<string>): PageMessage[] {
  const lines = new LineIndex(css);
  const directory = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  const messages: PageMessage[] = [];
  const at = (offset: number): {line: number; column: number} => {
    const position = lines.position(offset);
    return {line: position.line, column: position.column};
  };
  for (const match of css.matchAll(/@import\b/gi)) {
    messages.push({rule: 'papeleria/stylesheet', message: 'A stylesheet imports another; published stylesheets load nothing by themselves', ...at(match.index)});
  }
  for (const match of css.matchAll(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi)) {
    const resolved = resolveOutputUrl(match[2]!, directory);
    if ('problem' in resolved) {
      messages.push({rule: 'papeleria/stylesheet', message: `The stylesheet URL ${quoteValue(match[2]!, 'json')} ${resolved.problem}`, ...at(match.index)});
    } else if (!files.has(resolved.path)) {
      messages.push({rule: 'papeleria/stylesheet', message: `The stylesheet URL ${quoteValue(match[2]!, 'json')} names a file the output does not have`, ...at(match.index)});
    }
  }
  return messages;
}
