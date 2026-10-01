/**
 * A4 (M1.9, D70): `examples/brand-overview`, built by the compiled CLI,
 * against the kit's own deck, `reference/decks/brand-overview.html`.
 *
 * Structure, in Chromium: both pages are opened from disk with JavaScript off,
 * so each is its published markup, and one function extracts each document's
 * elements, attributes and whitespace-normalized text, with each notes aside
 * read apart (its label, then its lines or paragraphs, each exactly).
 * `test/golden/dom-compare.ts` compares the two, and every difference must be
 * covered by exactly one entry of `test/golden/brand-overview.allowlist.json`,
 * each entry used exactly as often as it says; each entry is justified in
 * docs/REFERENCE_COMPATIBILITY.md. Attribute assertions cover lang, the ARIA
 * of slides, buttons and status, and every link and resource.
 *
 * In Chromium, Firefox and WebKit (A7): from disk the built deck opens,
 * enhances, turns all sixteen slides from the keyboard, shows its notes, loads
 * its fonts, reports no error, stays still under reduced motion (A14, deck
 * share) and without JavaScript shows every slide; served from a loopback
 * server, whose log records every fetch in every engine, it fetches nothing
 * from elsewhere and only files the first-view budget counts (C23, C24).
 */
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {after, before, describe, test} from 'node:test';

import type {Browser, BrowserContextOptions, Page} from 'playwright';

import {loadBrandFiles, resolveBrand} from '../../../src/core/brand.js';
import {
  applyAllowlist,
  compareDocuments,
  describeDifference,
  type Allowlist,
  type AllowlistContext,
  type DomNode,
  type ElementNode,
  type ExtractedDocument,
  type NotesRecord,
} from '../../golden/dom-compare.js';
import {applicationRoot} from '../../helpers/paths.js';
import {launchEngine, selectedEngines} from '../helpers/engines.js';
import {serveDirectory} from '../helpers/static-server.js';

const TIMEOUT = {timeout: 120_000};
const CLI = join(applicationRoot, 'lib', 'src', 'cli', 'index.js');
const REFERENCE = join(applicationRoot, 'reference', 'decks', 'brand-overview.html');
const ALLOWLIST_FILE = join(applicationRoot, 'test', 'golden', 'brand-overview.allowlist.json');
const COMPATIBILITY = join(applicationRoot, 'docs', 'REFERENCE_COMPATIBILITY.md');
const STRINGS = JSON.parse(readFileSync(join(applicationRoot, 'templates', 'shared', 'strings.en.json'), 'utf8')) as Record<string, string>;
const VERSION = (JSON.parse(readFileSync(join(applicationRoot, 'package.json'), 'utf8')) as {version: string}).version;

type Target = {target: {kind: string; slide?: number}; file: string; lineStart: number; lineEnd: number};
type Report = {status: string; errors: number; warnings: number; findings: {severity: string; rule: string; message: string}[]; targets: Target[]; weight: {firstViewBytes: number}};

const workspace = mkdtempSync(join(tmpdir(), 'papeleria-golden-'));
const piece = join(workspace, 'brand-overview');
const dist = join(piece, 'dist');
let report: Report;

before(() => {
  cpSync(join(applicationRoot, 'examples', 'brand-overview'), piece, {
    recursive: true,
    filter: (path) => !/[\\/](?:dist|\.papeleria)$/.test(path),
  });
  const built = spawnSync(process.execPath, [CLI, 'build', piece], {encoding: 'utf8'});
  assert.equal(built.status, 0, `papeleria build: ${built.stderr}`);
  const checked = spawnSync(process.execPath, [CLI, 'check', piece, '--json'], {encoding: 'utf8'});
  assert.equal(checked.status, 0, `papeleria check: ${checked.stderr}`);
  report = JSON.parse(checked.stdout) as Report;
});

after(() => rmSync(workspace, {recursive: true, force: true}));

/**
 * Runs in the page. Reads the document as the comparison sees it: every
 * element with its tag, id, class list and other attributes; text with runs
 * of ASCII whitespace collapsed and whitespace-only text left out (a script's
 * text is kept as it is); each `aside.slide-notes` as its label, the
 * whitespace after it, and its lines or paragraphs exactly, with any
 * attribute or markup on the label or a paragraph, and anything else in the
 * aside, reported as stray. Comments are not read. Self-contained, because
 * Playwright sends it to the page as text.
 */
function extractDocument(): ExtractedDocument {
  const collapse = (text: string): string => text.replace(/[\t\n\f\r ]+/g, ' ');
  const notesOf = (aside: Element): NotesRecord => {
    const nodes = Array.from(aside.childNodes).filter((node) => node.nodeType !== Node.COMMENT_NODE);
    const stray: string[] = [];
    let label: string | null = null;
    let rest = nodes;
    const first = nodes[0];
    if (first instanceof Element && first.localName === 'strong') {
      label = first.textContent ?? '';
      // The label is compared as text, so anything else on it is reported as
      // stray, which no allowlist entry can cover: an attribute, or markup inside.
      for (const attribute of Array.from(first.attributes)) {
        stray.push(`the label has the attribute ${attribute.name}`);
      }
      for (const inner of Array.from(first.querySelectorAll('*'))) {
        stray.push(`markup inside the label: <${inner.localName}>`);
      }
      rest = nodes.slice(1);
    }
    if (rest.length === 0) {
      return {label, boundary: '', form: 'empty', paragraphs: [], stray};
    }
    if (rest.every((node) => node.nodeType === Node.TEXT_NODE)) {
      const text = rest.map((node) => (node as Text).data).join('');
      const boundary = /^[\t\n\f\r ]*/.exec(text)?.[0] ?? '';
      return {label, boundary, form: 'lines', paragraphs: text.slice(boundary.length).split('\n'), stray};
    }
    let boundary = '';
    const head = rest[0];
    if (head !== undefined && head.nodeType === Node.TEXT_NODE && /^[\t\n\f\r ]*$/.test((head as Text).data)) {
      boundary = (head as Text).data;
      rest = rest.slice(1);
    }
    const paragraphs: string[] = [];
    for (const node of rest) {
      if (node instanceof Element && node.localName === 'p') {
        paragraphs.push(node.textContent ?? '');
        for (const inner of Array.from(node.querySelectorAll('*'))) {
          stray.push(`markup inside paragraph ${paragraphs.length}: <${inner.localName}>`);
        }
        for (const attribute of Array.from(node.attributes)) {
          stray.push(`paragraph ${paragraphs.length} has the attribute ${attribute.name}`);
        }
      } else if (node.nodeType === Node.TEXT_NODE) {
        stray.push(`text after paragraph ${paragraphs.length}: ${JSON.stringify((node as Text).data)}`);
      } else if (node instanceof Element) {
        stray.push(`an element <${node.localName}> after paragraph ${paragraphs.length}`);
      }
    }
    return {label, boundary, form: 'paragraphs', paragraphs, stray};
  };
  const elementOf = (element: Element): ElementNode => {
    const attributes: Record<string, string> = {};
    for (const attribute of Array.from(element.attributes)) {
      if (attribute.name !== 'class' && attribute.name !== 'id') {
        attributes[attribute.name] = attribute.value;
      }
    }
    const base = {tag: element.localName, id: element.hasAttribute('id') ? element.id : null, classes: Array.from(element.classList), attributes};
    if (element.localName === 'aside' && element.classList.contains('slide-notes')) {
      return {...base, children: [], notes: notesOf(element)};
    }
    const children: DomNode[] = [];
    for (const child of Array.from(element.childNodes)) {
      if (child instanceof Element) {
        children.push(elementOf(child));
      } else if (child.nodeType === Node.TEXT_NODE) {
        const data = (child as Text).data;
        if (element.localName === 'script') {
          if (data !== '') {
            children.push({text: data});
          }
          continue;
        }
        const text = collapse(data);
        if (text.trim() !== '') {
          children.push({text});
        }
      }
    }
    return {...base, children};
  };
  const type = document.doctype;
  return {doctype: type === null ? null : `${type.name}|${type.publicId}|${type.systemId}`, root: elementOf(document.documentElement)};
}

async function extract(browser: Browser, file: string): Promise<ExtractedDocument> {
  const context = await browser.newContext({javaScriptEnabled: false});
  try {
    const page = await context.newPage();
    await page.goto(pathToFileURL(file).href);
    return await page.evaluate(extractDocument);
  } finally {
    await context.close();
  }
}

function allowlistContext(): AllowlistContext {
  const sourceLines = new Map<number, {start: number; end: number}>();
  for (const target of report.targets) {
    if (target.target.kind === 'slide' && target.file === 'papeleria.yaml' && target.target.slide !== undefined) {
      sourceLines.set(target.target.slide, {start: target.lineStart, end: target.lineEnd});
    }
  }
  // The piece sets no wordmark, so the build shows brand/brand.json's or the theme default's (D04, D05).
  const wordmark = resolveBrand(loadBrandFiles(applicationRoot)).wordmark;
  return {strings: STRINGS, wordmark, generator: `Papeleria ${VERSION}`, sourceLines};
}

function readAllowlist(): Allowlist {
  return JSON.parse(readFileSync(ALLOWLIST_FILE, 'utf8')) as Allowlist;
}

function articles(document: ExtractedDocument): ElementNode[] {
  const found: ElementNode[] = [];
  const walk = (node: ElementNode): void => {
    if (node.tag === 'article' && node.classes.includes('deck-slide')) {
      found.push(node);
      return;
    }
    for (const child of node.children) {
      if ('tag' in child) {
        walk(child);
      }
    }
  };
  walk(document.root);
  return found;
}

function notesOfSlide(slide: ElementNode): NotesRecord {
  const aside = slide.children.find((child): child is ElementNode => 'tag' in child && child.tag === 'aside');
  assert.ok(aside?.notes, `${slide.id} has a notes aside`);
  return aside.notes;
}

const {run, excluded} = selectedEngines();

describe('A4: the built brand overview against the reference deck, in chromium', () => {
  let browser: Browser | undefined;
  let reference: ExtractedDocument;
  let generated: ExtractedDocument;
  before(async () => {
    if (!run.includes('chromium')) {
      return;
    }
    browser = await launchEngine('chromium');
    reference = await extract(browser, REFERENCE);
    generated = await extract(browser, join(dist, 'index.html'));
  }, TIMEOUT);
  after(async () => {
    await browser?.close();
  });
  const skip = run.includes('chromium') ? false : `PAPELERIA_BROWSERS=${process.env['PAPELERIA_BROWSERS'] ?? ''} leaves chromium out`;

  test('the build: zero errors and zero warnings; sixteen slides with the reference’s ids and layouts, in order', {skip, ...TIMEOUT}, (context) => {
    context.diagnostic(`chromium ${browser?.version() ?? ''}`);
    assert.deepEqual([report.status, report.errors, report.warnings], ['ok', 0, 0], JSON.stringify(report.findings));
    const shape = (document: ExtractedDocument): string[] => articles(document).map((slide) => `${slide.id} ${slide.classes.join(' ')}`);
    assert.equal(shape(reference).length, 16);
    assert.deepEqual(shape(generated), shape(reference));
  });

  test('structure: every difference from the reference is on the allowlist, each entry used exactly as often as it says', {skip, ...TIMEOUT}, (context) => {
    const differences = compareDocuments(reference, generated);
    const allowlist = readAllowlist();
    const result = applyAllowlist(differences, allowlist, allowlistContext());
    assert.deepEqual(
      result.ambiguous.map((each) => `${describeDifference(each.difference)} ← ${each.entries.join(', ')}`),
      [],
      'a difference more than one entry covers',
    );
    assert.deepEqual(result.unexpected.map(describeDifference), [], 'differences no allowlist entry covers');
    assert.deepEqual(
      result.entries.filter((entry) => entry.used !== entry.expected).map((entry) => `${entry.id}: used ${entry.used}, says ${entry.expected}`),
      [],
      'allowlist entries used more or less often than they say',
    );
    context.diagnostic(`${differences.length} differences, each covered by one of ${allowlist.entries.length} allowlist entries`);
  });

  test('notes: sixteen asides, each with the reference’s label, and its lines as paragraphs, text for text', {skip, ...TIMEOUT}, () => {
    const referenceSlides = articles(reference);
    const generatedSlides = articles(generated);
    let paragraphs = 0;
    for (const [index, slide] of referenceSlides.entries()) {
      const expected = notesOfSlide(slide);
      const actual = notesOfSlide(generatedSlides[index]!);
      assert.equal(actual.label, STRINGS['notes_heading'], `${slide.id}: the label is notes_heading (D161)`);
      assert.equal(actual.label, expected.label, `${slide.id}: the label`);
      assert.deepEqual([expected.form, actual.form], ['lines', 'paragraphs'], `${slide.id}: the form`);
      assert.equal(actual.boundary, ' ', `${slide.id}: one space between the label and the first paragraph`);
      assert.deepEqual(actual.paragraphs, expected.paragraphs, `${slide.id}: the paragraphs, one per reference line`);
      assert.deepEqual([expected.stray, actual.stray], [[], []], `${slide.id}: nothing else`);
      paragraphs += actual.paragraphs.length;
    }
    assert.equal(paragraphs, 23, 'the reference’s 23 notes lines');
  });

  test('attributes: lang, ARIA on slides, buttons and status, and every link and resource', {skip, ...TIMEOUT}, async () => {
    const context = await browser!.newContext({javaScriptEnabled: false});
    try {
      const page = await context.newPage();
      await page.goto(pathToFileURL(join(dist, 'index.html')).href);
      const facts = await page.evaluate(() => {
        const slides = Array.from(document.querySelectorAll('article.deck-slide')).map((slide) => {
          const labelledBy = slide.getAttribute('aria-labelledby') ?? '';
          const target = document.getElementById(labelledBy);
          return {
            id: slide.id,
            labelledBy,
            labelIsTitle: target !== null && slide.contains(target) && target.matches('h2.slide-title'),
            notesLabel: slide.querySelector('aside.slide-notes')?.getAttribute('aria-label') ?? null,
            horizon: Array.from(slide.querySelectorAll('.horizon')).map((element) => element.getAttribute('aria-hidden')),
          };
        });
        const buttons = Array.from(document.querySelectorAll('.deck-tools button')).map((button) => ({
          id: button.id,
          type: button.getAttribute('type'),
          pressed: button.getAttribute('aria-pressed'),
        }));
        const status = document.getElementById('deck-status');
        const links = Array.from(document.querySelectorAll('a[href]')).map((link) => {
          const href = link.getAttribute('href') ?? '';
          return {href, resolves: href.startsWith('#') && document.getElementById(decodeURIComponent(href.slice(1))) !== null};
        });
        const resources = [
          ...Array.from(document.querySelectorAll('link[href]'), (element) => element.getAttribute('href') ?? ''),
          ...Array.from(document.querySelectorAll('script[src]'), (element) => element.getAttribute('src') ?? ''),
        ];
        return {
          lang: document.documentElement.getAttribute('lang'),
          slides,
          buttons,
          status: {role: status?.getAttribute('role') ?? null, tag: status?.localName ?? null},
          links,
          resources,
          main: document.getElementById('deck-main')?.localName ?? null,
        };
      });
      assert.equal(facts.lang, 'en', 'html[lang] is the manifest language');
      assert.equal(facts.slides.length, 16);
      for (const slide of facts.slides) {
        const number = slide.id.slice('slide-'.length);
        assert.equal(slide.labelledBy, `title-${number}`, `${slide.id} is labelled by its title`);
        assert.ok(slide.labelIsTitle, `${slide.id}: aria-labelledby names its own title`);
        assert.equal(slide.notesLabel, STRINGS['notes_label'], `${slide.id}: the notes aside is named by notes_label`);
      }
      assert.deepEqual(
        facts.slides.filter((slide) => slide.horizon.length > 0).map((slide) => [slide.id, slide.horizon]),
        [
          ['slide-1', ['true']],
          ['slide-16', ['true']],
        ],
        'the horizon ornament is hidden from assistive technology',
      );
      assert.deepEqual(facts.buttons, [
        {id: 'prev-slide', type: 'button', pressed: null},
        {id: 'next-slide', type: 'button', pressed: null},
        {id: 'all-slides', type: 'button', pressed: 'false'},
        {id: 'toggle-notes', type: 'button', pressed: 'false'},
        {id: 'full-deck', type: 'button', pressed: null},
        {id: 'print-deck', type: 'button', pressed: null},
      ]);
      assert.deepEqual(facts.status, {role: 'status', tag: 'p'});
      assert.deepEqual(facts.links, [{href: '#deck-main', resolves: true}], 'the one link is the skip link, and its target exists');
      assert.equal(facts.main, 'main');
      assert.equal(facts.resources.length, 7, 'the favicon, five stylesheets and deck.js');
      for (const resource of facts.resources) {
        assert.ok(!/^[a-z][a-z0-9+.-]*:|^\/|^\\/i.test(resource), `${resource} is a relative path`);
        const file = join(dist, ...resource.split('/'));
        assert.ok(file.startsWith(dist + sep) && existsSync(file), `${resource} is a file dist/ holds`);
      }
    } finally {
      await context.close();
    }
  });

  test('the comparison is not vacuous: a planted change of each kind is reported and not allowed', {skip, ...TIMEOUT}, async () => {
    const planted = join(workspace, 'planted');
    cpSync(dist, planted, {recursive: true});
    let html = readFileSync(join(dist, 'index.html'), 'utf8');
    const plant = (from: string, to: string): void => {
      assert.equal(html.split(from).length, 2, `${from} occurs once`);
      html = html.replace(from, to);
    };
    plant('<h3>Comic</h3>', '<h3>Comics</h3>');
    plant(' aria-labelledby="title-4"', '');
    plant('<p>Pages hosts static files;', '<p>Pages host static files;');
    plant('<span>Observed / S01–S04</span>', '<span data-kind="footer">Observed / S01–S04</span>');
    plant('<span class="slide-status">Review edition / approval pending</span><span>03 / 16</span>', '<span class="slide-status">Draft</span><span>03 / 16</span>');
    plant(
      '<span class="slide-status">Review edition / approval pending</span><span>05 / 16</span>',
      '<span class="slide-status"><em>Review edition / approval pending</em></span><span>05 / 16</span>',
    );
    plant('<strong>Speaker notes &amp; source detail</strong> <p>Primary sources:', '<strong hidden>Speaker notes &amp; source detail</strong> <p>Primary sources:');
    plant('<strong>Speaker notes &amp; source detail</strong> <p>Live page reviewed', '<strong>Speaker <em>notes</em> &amp; source detail</strong> <p>Live page reviewed');
    writeFileSync(join(planted, 'index.html'), html);
    const changed = await extract(browser!, join(planted, 'index.html'));
    const result = applyAllowlist(compareDocuments(reference, changed), readAllowlist(), allowlistContext());
    const unexpected = result.unexpected.map(describeDifference);
    assert.equal(unexpected.length, 8, unexpected.join('\n'));
    assert.ok(unexpected.some((line) => line.startsWith('text at ') && line.includes('"Comics"')), 'the heading');
    assert.ok(unexpected.some((line) => line.startsWith('attribute aria-labelledby at ') && line.includes('slide-4')), 'the label');
    assert.ok(unexpected.some((line) => line.startsWith('notes paragraph 2 at ') && line.includes('Pages host')), 'the note');
    assert.ok(unexpected.some((line) => line.startsWith('attribute data-kind at ')), 'the attribute');
    assert.ok(unexpected.some((line) => line.startsWith('extra ') && line.includes('>Draft</span>')), 'the status');
    assert.ok(
      unexpected.some((line) => line.startsWith('extra ') && line.includes('article#slide-5.') && line.includes('<em>Review edition / approval pending</em>')),
      'markup inside an allowed status, with the same text',
    );
    assert.ok(unexpected.some((line) => line.includes('slide-16') && line.endsWith('generated: the label has the attribute hidden')), 'an attribute on a notes label');
    assert.ok(unexpected.some((line) => line.includes('slide-2.') && line.endsWith('generated: markup inside the label: <em>')), 'markup inside a notes label');
    assert.deepEqual(
      result.entries.filter((entry) => entry.used !== entry.expected).map((entry) => [entry.id, entry.used, entry.expected]),
      [['slide-status', 14, 16]],
      'the status entry no longer covers slides 3 and 5',
    );
  });

  test('the allowlist is small, and each entry is justified in docs/REFERENCE_COMPATIBILITY.md', (context) => {
    const allowlist = readAllowlist();
    const ids = allowlist.entries.map((entry) => entry.id);
    assert.equal(new Set(ids).size, ids.length, 'entry ids are unique');
    const compatibility = readFileSync(COMPATIBILITY, 'utf8');
    const start = compatibility.indexOf('## A4 allowlist');
    assert.ok(start >= 0, 'REFERENCE_COMPATIBILITY.md has an "A4 allowlist" section');
    const section = compatibility.slice(start, compatibility.indexOf('\n## ', start + 1));
    const documented = Array.from(section.matchAll(/^\| `([a-z0-9-]+)` \|/gm), (match) => match[1]!);
    assert.deepEqual([...documented].sort(), [...ids].sort(), 'the record and the allowlist name the same entries');
    for (const entry of allowlist.entries) {
      assert.ok(entry.record.trim() !== '', `${entry.id} names its record`);
      assert.ok(entry.count > 0, `${entry.id} covers something`);
    }
    context.diagnostic(`${ids.length} allowlist entries`);
  });
});

if (!run.includes('chromium')) {
  test('A4 golden: not run', {skip: `PAPELERIA_BROWSERS=${process.env['PAPELERIA_BROWSERS'] ?? ''} leaves chromium out`}, () => {});
}

for (const engine of excluded) {
  test(`${engine}: the built brand overview not run`, {skip: `PAPELERIA_BROWSERS=${process.env['PAPELERIA_BROWSERS'] ?? ''} leaves ${engine} out`}, () => {});
}

type Opened = {readonly page: Page; readonly requests: readonly string[]};

/** Opens the built page, from disk unless an address is given, and fails on any error it reports. */
async function openBuilt(
  browser: Browser,
  options: BrowserContextOptions,
  body: (opened: Opened) => Promise<void>,
  address: string = pathToFileURL(join(dist, 'index.html')).href,
): Promise<void> {
  const context = await browser.newContext({viewport: {width: 1280, height: 800}, ...options});
  const page = await context.newPage();
  const errors: string[] = [];
  const requests: string[] = [];
  page.on('pageerror', (error) => errors.push(`page error: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') {
      errors.push(`console error: ${message.text()}`);
    }
  });
  page.on('request', (request) => requests.push(request.url()));
  page.on('requestfailed', (request) => errors.push(`request failed: ${request.url()} ${request.failure()?.errorText ?? ''}`));
  try {
    await page.goto(address);
    await body({page, requests});
    assert.deepEqual(errors, [], 'the page reported errors');
  } finally {
    await context.close();
  }
}

function visibleSlides(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>('article.deck-slide'))
      .filter((slide) => slide.offsetParent !== null && getComputedStyle(slide).visibility !== 'hidden')
      .map((slide) => slide.id),
  );
}

/** The files a first view counts (IC04, D62): the page, what it links and loads, and all eight fonts. */
function firstViewFiles(): string[] {
  const html = readFileSync(join(dist, 'index.html'), 'utf8');
  return [
    'index.html',
    ...Array.from(html.matchAll(/<link rel="(?:stylesheet|icon)" href="([^"]+)"/g), (match) => match[1]!),
    ...Array.from(html.matchAll(/<script src="([^"]+)"/g), (match) => match[1]!),
    ...['400-latin', '400-latin-ext', '500-latin', '500-latin-ext', '600-latin', '600-latin-ext'].map((face) => `theme/fonts/poppins-${face}.woff2`),
    'theme/fonts/inter-400-700-latin.woff2',
    'theme/fonts/inter-400-700-latin-ext.woff2',
  ];
}

for (const engine of run) {
  describe(`A7: the built brand overview in ${engine}`, () => {
    let browser: Browser | undefined;
    before(async () => {
      browser = await launchEngine(engine);
    }, TIMEOUT);
    after(async () => {
      await browser?.close();
    });
    const use = (): Browser => {
      if (browser === undefined) {
        throw new Error(`${engine} did not launch`);
      }
      return browser;
    };

    test('from file:// it enhances, turns every slide from the keyboard, shows its notes and loads its fonts', TIMEOUT, async (context) => {
      context.diagnostic(`${engine} ${use().version()}`);
      await openBuilt(use(), {}, async ({page}) => {
        await page.waitForFunction(() => document.body.classList.contains('deck-enhanced'));
        assert.deepEqual(await visibleSlides(page), ['slide-1']);
        assert.equal(await page.locator('#deck-status').textContent(), 'Slide 1 of 16: Craft with care. Build for the long view.');
        for (let number = 2; number <= 16; number += 1) {
          await page.keyboard.press('ArrowRight');
          await page.waitForFunction((expected) => location.hash === expected, `#slide-${number}`);
          assert.deepEqual(await visibleSlides(page), [`slide-${number}`]);
          assert.match((await page.locator('#deck-status').textContent()) ?? '', new RegExp(`^Slide ${number} of 16: \\S`));
        }
        assert.equal(await page.locator('#deck-status').textContent(), 'Slide 16 of 16: Build a practice people can carry forward.');
        await page.click('#toggle-notes');
        assert.equal(await page.locator('#toggle-notes').getAttribute('aria-pressed'), 'true');
        assert.ok(await page.locator('#slide-16 aside.slide-notes').isVisible(), 'the notes of the current slide show');

        const fonts = await page.evaluate(async () => {
          await document.fonts.ready;
          return Array.from(document.fonts, (face) => `${face.family.replace(/["']/g, '')} ${face.weight} ${face.status}`).filter((face) => face.endsWith('loaded'));
        });
        assert.ok(fonts.some((face) => face.startsWith('Poppins 600')), `Poppins 600 loaded from disk: ${fonts.join(', ')}`);
        assert.ok(fonts.some((face) => face.startsWith('Inter ')), `Inter loaded from disk: ${fonts.join(', ')}`);
      });
    });

    // What a page fetches is read from the loopback server's own log, which every
    // engine feeds; Playwright's Firefox reports no request event for a file://
    // load, so an event log from disk would prove nothing there (D74).
    test('served, it fetches nothing from elsewhere and nothing the first-view budget does not count (C23, C24)', TIMEOUT, async (context) => {
      const server = await serveDirectory(dist);
      try {
        await openBuilt(
          use(),
          {},
          async ({page, requests}) => {
            await page.waitForFunction(() => document.body.classList.contains('deck-enhanced'));
            for (let number = 2; number <= 16; number += 1) {
              await page.keyboard.press('ArrowRight');
              await page.waitForFunction((expected) => location.hash === expected, `#slide-${number}`);
            }
            await page.click('#toggle-notes');
            await page.evaluate(() => document.fonts.ready);
            assert.deepEqual(requests.filter((url) => !url.startsWith(`${server.origin}/`)), [], 'nothing is requested from anywhere else (C24)');
          },
          `${server.origin}/index.html`,
        );
      } finally {
        await server.close();
      }
      const loaded = [...new Set(server.requests.map((path) => path.replace(/^\//, '')))];
      assert.ok(
        loaded.includes('index.html') && loaded.includes('deck.js') && loaded.some((path) => path.startsWith('theme/fonts/')),
        `the log holds the page, its script and a font, so it is this page's: ${loaded.join(', ')}`,
      );
      const counted = new Set(firstViewFiles());
      assert.deepEqual(
        loaded.filter((path) => !counted.has(path)),
        [],
        'after all sixteen slides and the notes, every file fetched is one the first-view budget counts (IC04)',
      );
      const bytes = loaded.reduce((sum, path) => sum + statSync(join(dist, ...path.split('/'))).size, 0);
      assert.ok(bytes <= report.weight.firstViewBytes, `the browser fetched ${bytes} bytes, within the ${report.weight.firstViewBytes} counted`);
      context.diagnostic(`${engine} fetched ${loaded.length} files, ${bytes} bytes; the budget counts ${report.weight.firstViewBytes}`);
    });

    test('under reduced motion nothing moves or transitions (A14, deck share, on the built output)', TIMEOUT, async () => {
      await openBuilt(use(), {reducedMotion: 'reduce'}, async ({page}) => {
        await page.waitForFunction(() => document.body.classList.contains('deck-enhanced'));
        await page.keyboard.press('ArrowRight');
        await page.waitForFunction(() => location.hash === '#slide-2');
        const moving = await page.evaluate(() => [
          ...document.getAnimations().map((animation) => `running: ${animation.constructor.name}`),
          ...Array.from(document.querySelectorAll('*')).flatMap((element) => {
            const style = getComputedStyle(element);
            const seconds = (value: string): number[] => value.split(',').map((part) => Number.parseFloat(part) || 0);
            const transition = seconds(style.transitionDuration).some((value) => value > 0);
            const animation = style.animationName.split(',').some((name) => name.trim() !== 'none') && seconds(style.animationDuration).some((value) => value > 0);
            return transition || animation ? [`${element.localName}.${Array.from(element.classList).join('.')}: ${style.transitionDuration} ${style.animationName}`] : [];
          }),
        ]);
        assert.deepEqual(moving, [], 'reduced motion leaves no transition or animation');
      });
    });

    test('without JavaScript every slide and note shows, the status says so, and the tools stay hidden', TIMEOUT, async () => {
      await openBuilt(use(), {javaScriptEnabled: false}, async ({page}) => {
        assert.deepEqual(await visibleSlides(page), Array.from({length: 16}, (_, index) => `slide-${index + 1}`));
        assert.equal(await page.locator('aside.slide-notes:visible').count(), 16);
        assert.equal((await page.locator('#deck-status').textContent())?.trim(), STRINGS['no_js_slides']);
        assert.equal(await page.locator('.deck-tools button:visible').count(), 0, 'controls that need the script stay hidden');
      });
    });
  });
}

