/**
 * C23 (IC04), the browser half: the image a real browser loads for the first
 * view is the one the first-view budget counts (D74).
 *
 * `src/build/budget.ts` models the choice (`selectCandidate`): for each slot,
 * the narrowest derivative at least as wide as the slot at the viewport's
 * pixel ratio, else the widest, from the AVIF set when the browser takes the
 * `<source>` and from the WebP set otherwise. Here a deck whose first slide is
 * a 2,400 px image, whose register shows a raster logo and whose second slide
 * is another image is built by the compiled CLI and opened in Chromium,
 * Firefox and WebKit at IC04's three reference viewports, pixel ratio 1. At
 * each, the first slide's picture loads exactly one derivative, the one the
 * model picks for the format the engine took, and the logo its one
 * derivative; everything loaded is within the weight the report counts.
 *
 * The deck is served by the loopback static server, a fresh one for each
 * viewport, because its log records every file a browser fetches whatever
 * the engine: Playwright's Firefox reports no request event for a file://
 * load, so a log of those events proves nothing there (D74).
 *
 * IC04 leaves lazy media after the first view out of the budget by rule. A
 * browser may still start the second slide's image before `deck.js` has
 * hidden that slide, when it lies within the browser's own lazy-loading
 * distance. Chromium did so here and on CI, and Firefox on CI, at each of
 * the three viewports, more often over loopback HTTP than from disk. That load is reported, not
 * failed; it must still be the one derivative its own slot selects, never
 * both formats (D74).
 */
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after, before, describe, test} from 'node:test';

import type {Browser} from 'playwright';
import sharp from 'sharp';

import {REFERENCE_VIEWPORTS, selectCandidate} from '../../src/build/budget.js';
import {LOGO_HEIGHT_PX, SLIDE_IMAGE_SLOT} from '../../templates/deck/render.js';
import {logoSlot, type PublishedDerivative, type PublishedRaster} from '../../templates/shared/blocks.js';
import {applicationRoot} from '../helpers/paths.js';
import {launchEngine, selectedEngines} from './helpers/engines.js';
import {serveDirectory} from './helpers/static-server.js';

const TIMEOUT = {timeout: 180_000};
const CLI = join(applicationRoot, 'lib', 'src', 'cli', 'index.js');

const workspace = mkdtempSync(join(tmpdir(), 'papeleria-first-view-'));
const piece = join(workspace, 'pictures');
const dist = join(piece, 'dist');
let firstViewBytes = 0;

function cli(...args: string[]): string {
  const result = spawnSync(process.execPath, [CLI, ...args], {encoding: 'utf8'});
  assert.equal(result.status, 0, `papeleria ${args.join(' ')}: ${result.stderr}`);
  return result.stdout;
}

/** A picture with detail in it, so its encodings have realistic, different sizes. */
async function picture(file: string, width: number, height: number): Promise<void> {
  const data = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3;
      data[offset] = (x * 7 + y * 3) % 256;
      data[offset + 1] = (x * y) % 251;
      data[offset + 2] = (y * 5) % 256;
    }
  }
  await sharp(data, {raw: {width, height, channels: 3}}).png().toFile(file);
}

before(async () => {
  cli('new', 'deck', piece);
  mkdirSync(join(piece, 'assets', 'images', 'logos'), {recursive: true});
  await picture(join(piece, 'assets', 'images', 'workshop.png'), 2400, 1350);
  await picture(join(piece, 'assets', 'images', 'bench.png'), 1200, 800);
  await picture(join(piece, 'assets', 'images', 'logos', 'studio.png'), 400, 100);
  const manifest = join(piece, 'papeleria.yaml');
  const images = [
    'slides:',
    '  - layout: image',
    '    title: The workshop.',
    '    image: {src: assets/images/workshop.png, alt: The workshop at first light, credit: Studio, rights: Own work}',
    '',
    '  - layout: image',
    '    title: The bench.',
    '    image: {src: assets/images/bench.png, alt: A bench with the week’s drafts, credit: Studio, rights: Own work}',
    '',
  ].join('\n');
  writeFileSync(
    manifest,
    readFileSync(manifest, 'utf8')
      .replace(/^credits:/m, 'logo: {src: assets/images/logos/studio.png, alt: Studio}\ncredits:')
      .replace(/^slides:\n/m, `${images}\n`),
  );
  cli('build', piece);
  const report = JSON.parse(cli('check', piece, '--json')) as {errors: number; weight: {firstViewBytes: number}};
  assert.equal(report.errors, 0);
  firstViewBytes = report.weight.firstViewBytes;
});

after(() => rmSync(workspace, {recursive: true, force: true}));

/** The derivatives a srcset in the built page lists, with their bytes on disk. */
function candidates(srcset: string, format: 'webp' | 'avif'): PublishedDerivative[] {
  return srcset.split(',').map((entry) => {
    const [url, descriptor] = entry.trim().split(/\s+/);
    const path = decodeURIComponent(url!);
    return {path, bytes: statSync(join(dist, ...path.split('/'))).size, width: Number(descriptor!.slice(0, -1)), height: 0, format};
  });
}

/** A published raster as the page offers it: its `<source>` AVIF set, if any, and its `<img>` WebP set. */
function offered(html: string): {image: PublishedRaster; widest: {width: number; height: number}} {
  const avif = /<source type="image\/avif" srcset="([^"]+)"/.exec(html)?.[1];
  const img = /<img src="[^"]+" srcset="([^"]+)" sizes="[^"]+" width="(\d+)" height="(\d+)"/.exec(html);
  assert.ok(img, `an img with a srcset in ${html.slice(0, 200)}`);
  const derivatives = [...candidates(img[1]!, 'webp'), ...(avif === undefined ? [] : candidates(avif, 'avif'))];
  const widest = {width: Number(img[2]), height: Number(img[3])};
  return {image: {kind: 'raster', width: widest.width, height: widest.height, derivatives}, widest};
}

function slideHtml(html: string, number: number): string {
  const start = html.indexOf(`id="slide-${number}"`);
  return html.slice(start, html.indexOf('</article>', start));
}

const {run, excluded} = selectedEngines();

for (const engine of excluded) {
  test(`${engine}: not run`, {skip: `PAPELERIA_BROWSERS=${process.env['PAPELERIA_BROWSERS'] ?? ''} leaves ${engine} out`}, () => {});
}

for (const engine of run) {
  describe(`C23: the first view's images in ${engine}`, () => {
    let browser: Browser | undefined;
    before(async () => {
      browser = await launchEngine(engine);
    }, TIMEOUT);
    after(async () => {
      await browser?.close();
    });

    test('at 390×844, 834×1112 and 1280×800 each first-view slot loads the one derivative the budget counts', TIMEOUT, async (context) => {
      assert.ok(browser, `${engine} did not launch`);
      context.diagnostic(`${engine} ${browser.version()}`);
      const html = readFileSync(join(dist, 'index.html'), 'utf8');
      const slide = offered(slideHtml(html, 1).slice(slideHtml(html, 1).indexOf('<figure')));
      const logo = offered(slideHtml(html, 1).slice(slideHtml(html, 1).indexOf('<div class="slide-register">')));
      const lazy = offered(slideHtml(html, 2).slice(slideHtml(html, 2).indexOf('<figure')));
      assert.deepEqual(
        slide.image.derivatives.filter((each) => each.format === 'webp').map((each) => each.width),
        [800, 1600],
        'the 2,400 px source is published at both IC04 widths',
      );
      for (const viewport of REFERENCE_VIEWPORTS) {
        const server = await serveDirectory(dist);
        const base = `${server.origin}/`;
        const pages = await browser.newContext({viewport: {width: viewport.width, height: viewport.height}, deviceScaleFactor: viewport.dpr});
        const elsewhere: string[] = [];
        let loaded: {slide: string; logo: string; width: number};
        try {
          const page = await pages.newPage();
          page.on('request', (request) => {
            if (!request.url().startsWith(base)) {
              elsewhere.push(request.url());
            }
          });
          await page.goto(`${base}index.html`);
          await page.waitForFunction(() => document.body.classList.contains('deck-enhanced'));
          loaded = await page.evaluate(async () => {
            const wait = (image: HTMLImageElement): Promise<void> =>
              image.complete ? Promise.resolve() : new Promise((resolve) => image.addEventListener('load', () => resolve(), {once: true}));
            const slideImage = document.querySelector<HTMLImageElement>('#slide-1 figure img')!;
            const logoImage = document.querySelector<HTMLImageElement>('#slide-1 img.slide-logo')!;
            await Promise.all([wait(slideImage), wait(logoImage)]);
            return {slide: slideImage.currentSrc, logo: logoImage.currentSrc, width: document.documentElement.clientWidth};
          });
        } finally {
          await pages.close();
          await server.close();
        }
        // The server's own log: every path this viewport's page fetched, in any engine.
        const requests = server.requests.map((path) => `${base}${path.replace(/^\//, '')}`);

        const at = `${viewport.width}×${viewport.height}`;
        assert.deepEqual(elsewhere, [], `${at}: nothing is requested from anywhere else (C24)`);
        assert.ok(requests.includes(`${base}index.html`), `${at}: the server saw the page, so its log is the page's`);
        assert.equal(loaded.width, viewport.width, `${at}: the layout viewport is the reference width`);
        const shown = (url: string): string => decodeURIComponent(url.slice(base.length));
        const slideFile = shown(loaded.slide);
        const scenario = slideFile.endsWith('.avif') ? 'avif' : 'webp';
        const expected = selectCandidate(slide.image, SLIDE_IMAGE_SLOT.slotWidth(viewport.width), viewport.dpr, scenario).path;
        assert.equal(slideFile, expected, `${at}: the slide's picture loads what the budget counts (${scenario})`);
        const logoWidth = logoSlot(logo.image, LOGO_HEIGHT_PX).slotWidth(viewport.width);
        const logoFile = shown(loaded.logo);
        assert.equal(logoFile, selectCandidate(logo.image, logoWidth, viewport.dpr, logoFile.endsWith('.avif') ? 'avif' : 'webp').path, `${at}: the logo`);

        const images = [...new Set(requests.filter((url) => url.startsWith(`${base}assets/images/`)).map(shown))];
        const early = images.filter((path) => lazy.image.derivatives.some((each) => each.path === path));
        assert.deepEqual(
          images.filter((path) => !early.includes(path)).sort(),
          [logoFile, slideFile].sort(),
          `${at}: one file per first-view slot, never both formats`,
        );
        if (early.length > 0) {
          const lazyScenario = early[0]!.endsWith('.avif') ? 'avif' : 'webp';
          const own = selectCandidate(lazy.image, SLIDE_IMAGE_SLOT.slotWidth(viewport.width), viewport.dpr, lazyScenario).path;
          assert.deepEqual(early, [own], `${at}: the second slide's image, loaded early, is the one its own slot selects`);
          context.diagnostic(`${at}: ${engine} started the second slide's lazy image before deck.js hid it (${own}); IC04 leaves it out`);
        }
        const bytes = [...new Set(requests.filter((url) => url.startsWith(base)).map(shown))].reduce(
          (sum, path) => sum + statSync(join(dist, ...path.split('/'))).size,
          0,
        );
        assert.ok(bytes <= firstViewBytes, `${at}: ${bytes} bytes loaded, within the ${firstViewBytes} the report counts`);
        context.diagnostic(`${at}: ${slideFile.slice(slideFile.lastIndexOf('/') + 1)} and ${logoFile.slice(logoFile.lastIndexOf('/') + 1)}, ${bytes} of ${firstViewBytes} bytes`);
      }
    });
  });
}
