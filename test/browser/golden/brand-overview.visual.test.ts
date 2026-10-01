/**
 * A4 (M1.9, D70): the built brand overview's look, in Chromium.
 *
 * Seven slides — the cover, a columns slide, attributes, palette, type,
 * wordmark and closing — are captured at 1280×800 and 390×844 from the deck
 * built by the compiled CLI and opened from disk, each in a fresh page so no
 * focus ring shows, once `document.fonts` reports every face loaded. Each
 * capture is compared pixel by pixel, with sharp, with its committed baseline
 * in `test/golden/baselines/brand-overview/`. Nothing on these slides varies
 * between runs, so nothing is masked.
 *
 * The baselines were made in CI by the session that wrote this test and await
 * the design maintainer's review (REVIEW_PENDING.md beside them); until then
 * A4's visual part is pending-human. They are bound to the platform recorded
 * in their platform.json: under CI any other platform fails; elsewhere the
 * comparison is reported as skipped with both platforms named. A capture
 * without a baseline fails, is written to `test-results/brand-overview-visual/`
 * and is printed into the log between PAPELERIA-CAPTURE markers, which
 * `test/golden/extract-captures.mjs` turns back into files where a job's
 * artifacts cannot be fetched; a capture that differs fails and is written
 * there with a picture of the difference. Nothing here writes a baseline.
 *
 * Also asserted, at both viewports and on all sixteen slides: every slide
 * title is set in the self-hosted Poppins at weight 600, in the computed style
 * and in the face Chromium drew it with; and the footer counter stays whole
 * (D73).
 */
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {after, before, describe, test} from 'node:test';

import type {Browser, BrowserContext} from 'playwright';

import {captureLines, platformLine, type Platform} from '../../golden/captures.js';
import {comparePixels, differenceImage} from '../../golden/pixels.js';
import {applicationRoot} from '../../helpers/paths.js';
import {launchEngine, selectedEngines} from '../helpers/engines.js';

const TIMEOUT = {timeout: 180_000};
const CLI = join(applicationRoot, 'lib', 'src', 'cli', 'index.js');

/** A4's slides: the cover, a columns slide (UX §05's three-column example), attributes, palette, type, wordmark, closing. */
const SLIDES: readonly {readonly number: number; readonly name: string}[] = [
  {number: 1, name: 'cover'},
  {number: 9, name: 'columns'},
  {number: 5, name: 'attributes'},
  {number: 6, name: 'palette'},
  {number: 7, name: 'type'},
  {number: 8, name: 'wordmark'},
  {number: 16, name: 'closing'},
];
const VIEWPORTS: readonly {readonly width: number; readonly height: number}[] = [
  {width: 1280, height: 800},
  {width: 390, height: 844},
];

/**
 * A pixel counts as different when a channel moves by more than 8 levels in
 * 255, which a flat colour moving visibly does; a capture may have at most one
 * in a thousand such pixels, room for antialiasing to settle differently on
 * another runner's processor. A pixel that moves by more than 64 levels is a
 * glyph or an edge that moved, and a capture may have at most 32 of those.
 */
const THRESHOLDS = {weakDelta: 8, strongDelta: 64};
const MAX_WEAK_SHARE = 0.001;
const MAX_STRONG = 32;

function inContinuousIntegration(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env['CI'];
  return value !== undefined && value !== '' && value !== '0' && value.toLowerCase() !== 'false';
}

function baselineFolder(): string {
  const override = process.env['PAPELERIA_VISUAL_BASELINES'];
  if (override === undefined || override === '') {
    return join(applicationRoot, 'test', 'golden', 'baselines', 'brand-overview');
  }
  if (inContinuousIntegration()) {
    throw new Error('PAPELERIA_VISUAL_BASELINES replaces the committed baselines and is refused under CI (D70)');
  }
  return resolve(override);
}

const BASELINES = baselineFolder();
const RESULTS = join(applicationRoot, 'test-results', 'brand-overview-visual');

function osRelease(): string {
  try {
    const text = readFileSync('/etc/os-release', 'utf8');
    const field = (name: string): string => (new RegExp(`^${name}=(.*)$`, 'm').exec(text)?.[1] ?? '').replace(/^"|"$/g, '');
    return `${field('ID')} ${field('VERSION_ID')}`.trim();
  } catch {
    return '';
  }
}

function recordedPlatform(): Platform | null {
  const file = join(BASELINES, 'platform.json');
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Platform) : null;
}

/** The four facts a baseline is bound to; platform.json may also record where it was made. */
function samePlatform(a: Platform, b: Platform): boolean {
  return a.engine === b.engine && a.version === b.version && a.os === b.os && a.osRelease === b.osRelease;
}

function describePlatform(platform: Platform): string {
  return `${platform.engine} ${platform.version} on ${platform.os}${platform.osRelease === '' ? '' : ` (${platform.osRelease})`}`;
}

const workspace = mkdtempSync(join(tmpdir(), 'papeleria-visual-'));
const dist = join(workspace, 'brand-overview', 'dist');

before(() => {
  const piece = join(workspace, 'brand-overview');
  cpSync(join(applicationRoot, 'examples', 'brand-overview'), piece, {recursive: true, filter: (path) => !/[\\/](?:dist|\.papeleria)$/.test(path)});
  const built = spawnSync(process.execPath, [CLI, 'build', piece], {encoding: 'utf8'});
  assert.equal(built.status, 0, `papeleria build: ${built.stderr}`);
});

after(() => rmSync(workspace, {recursive: true, force: true}));

async function newContext(browser: Browser, viewport: {width: number; height: number}, javaScriptEnabled = true): Promise<BrowserContext> {
  return browser.newContext({
    viewport,
    deviceScaleFactor: 1,
    colorScheme: 'light',
    reducedMotion: 'reduce',
    forcedColors: 'none',
    locale: 'en-US',
    timezoneId: 'UTC',
    javaScriptEnabled,
  });
}

/** Each listed slide at one viewport, as PNG bytes by baseline name, once every face has loaded. */
async function capture(browser: Browser, viewport: {width: number; height: number}): Promise<Map<string, Uint8Array>> {
  const captures = new Map<string, Uint8Array>();
  const context = await newContext(browser, viewport);
  try {
    for (const slide of SLIDES) {
      const page = await context.newPage();
      await page.goto(`${pathToFileURL(join(dist, 'index.html')).href}#slide-${slide.number}`);
      await page.waitForFunction(() => document.body.classList.contains('deck-enhanced'));
      const fonts = await page.evaluate(async () => {
        await document.fonts.ready;
        await Promise.all(['600 1em Poppins', '400 1em Inter', '700 1em Inter'].map((face) => document.fonts.load(face)));
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return {
          status: document.fonts.status,
          loaded: Array.from(document.fonts, (face) => `${face.family.replace(/["']/g, '')} ${face.weight} ${face.status}`).filter((face) => face.endsWith(' loaded')),
          focused: document.activeElement === document.body || document.activeElement === null,
        };
      });
      assert.equal(fonts.status, 'loaded', `slide ${slide.number}: fonts still loading`);
      assert.ok(fonts.loaded.some((face) => face.startsWith('Poppins 600')), `slide ${slide.number}: Poppins 600 loaded before capture (${fonts.loaded.join(', ')})`);
      assert.ok(fonts.loaded.some((face) => face.startsWith('Inter ')), `slide ${slide.number}: Inter loaded before capture`);
      assert.ok(fonts.focused, `slide ${slide.number}: nothing has focus, so no focus ring is captured`);
      const png = await page.locator(`#slide-${slide.number}`).screenshot({animations: 'disabled', caret: 'hide', scale: 'css'});
      captures.set(`${viewport.width}x${viewport.height}/${String(slide.number).padStart(2, '0')}-${slide.name}.png`, new Uint8Array(png));
      await page.close();
    }
  } finally {
    await context.close();
  }
  return captures;
}

const {run} = selectedEngines();
const skip = run.includes('chromium') ? false : `PAPELERIA_BROWSERS=${process.env['PAPELERIA_BROWSERS'] ?? ''} leaves chromium out`;

describe('A4: the built brand overview’s look, in chromium', () => {
  let browser: Browser | undefined;
  before(async () => {
    if (skip === false) {
      browser = await launchEngine('chromium');
    }
  }, TIMEOUT);
  after(async () => {
    await browser?.close();
  });

  for (const viewport of VIEWPORTS) {
    test(`the seven slides at ${viewport.width}×${viewport.height} match their baselines`, {skip, ...TIMEOUT}, async (context) => {
      const platform: Platform = {engine: 'chromium', version: browser!.version(), os: process.platform, osRelease: osRelease()};
      context.diagnostic(`captured on ${describePlatform(platform)}`);
      const captures = await capture(browser!, viewport);
      const recorded = recordedPlatform();
      if (recorded !== null && !samePlatform(recorded, platform)) {
        const reason = `the baselines were made on ${describePlatform(recorded)}; this run is ${describePlatform(platform)}`;
        if (inContinuousIntegration()) {
          assert.fail(`${reason}. Make new baselines on CI's platform and have them reviewed (D70).`);
        }
        context.skip(`${reason}, so the pixels are not compared here; CI compares them`);
        return;
      }

      const missing: string[] = [];
      const differing: string[] = [];
      for (const [name, png] of captures) {
        const file = join(BASELINES, ...name.split('/'));
        if (!existsSync(file)) {
          missing.push(name);
          const stem = join(RESULTS, ...name.replace(/\.png$/, '').split('/'));
          mkdirSync(join(stem, '..'), {recursive: true});
          writeFileSync(`${stem}.actual.png`, png);
          continue;
        }
        const expected = new Uint8Array(readFileSync(file));
        const result = await comparePixels(png, expected, THRESHOLDS);
        const allowedWeak = Math.floor(result.width * result.height * MAX_WEAK_SHARE);
        if (!result.sameSize || result.weak > allowedWeak || result.strong > MAX_STRONG) {
          const stem = join(RESULTS, ...name.replace(/\.png$/, '').split('/'));
          mkdirSync(join(stem, '..'), {recursive: true});
          writeFileSync(`${stem}.actual.png`, png);
          writeFileSync(`${stem}.diff.png`, await differenceImage(png, expected, THRESHOLDS));
          differing.push(
            result.sameSize
              ? `${name}: ${result.weak} pixels differ (at most ${allowedWeak}), ${result.strong} strongly (at most ${MAX_STRONG}), largest ${result.largestDelta}`
              : `${name}: ${result.width}×${result.height} where the baseline is ${result.expectedWidth}×${result.expectedHeight}`,
          );
        } else if (result.weak > 0) {
          context.diagnostic(`${name}: ${result.weak} pixels differ faintly, within the tolerance`);
        }
      }
      if (missing.length > 0) {
        // The bootstrap path: print what is missing so a maintainer can review it and, if it is right, commit it.
        context.diagnostic(platformLine(platform));
        for (const name of missing) {
          for (const line of captureLines(name, captures.get(name)!)) {
            context.diagnostic(line);
          }
        }
      }
      assert.deepEqual(
        [...missing.map((name) => `${name}: no baseline (the capture is printed above; test/golden/extract-captures.mjs reads it)`), ...differing],
        [],
        `captures that do not match: actual and difference images are in ${RESULTS}`,
      );
    });
  }

  for (const viewport of VIEWPORTS) {
    test(`at ${viewport.width}×${viewport.height} every slide title is Poppins 600, as computed and as drawn, and every counter stays whole`, {skip, ...TIMEOUT}, async () => {
      // Without JavaScript all sixteen slides are laid out at once.
      const context = await newContext(browser!, viewport, false);
      try {
        const page = await context.newPage();
        await page.goto(pathToFileURL(join(dist, 'index.html')).href);
        const computed = await page.evaluate(async () => {
          await document.fonts.ready;
          return Array.from(document.querySelectorAll('h2.slide-title'), (title) => {
            const style = getComputedStyle(title);
            const counter = title.closest('article')?.querySelector('footer.slide-footer > span:last-child');
            const range = document.createRange();
            if (counter) {
              range.selectNodeContents(counter);
            }
            const lines = new Set(Array.from(range.getClientRects(), (rect) => Math.round(rect.top)));
            return {
              id: title.id,
              family: (style.fontFamily.split(',')[0] ?? '').trim().replace(/^["']|["']$/g, ''),
              weight: style.fontWeight,
              counter: counter?.textContent ?? '',
              counterLines: lines.size,
            };
          });
        });
        assert.equal(computed.length, 16);
        for (const title of computed) {
          assert.deepEqual([title.family, title.weight], ['Poppins', '600'], `${title.id}: the computed face`);
          assert.match(title.counter, /^\d{2} \/ 16$/, `${title.id}: the counter`);
          assert.equal(title.counterLines, 1, `${title.id}: "${title.counter}" is broken over ${title.counterLines} lines (D73)`);
        }

        // The face Chromium actually drew each title with: the self-hosted
        // Poppins SemiBold for every glyph, no fallback font.
        const cdp = await context.newCDPSession(page);
        await cdp.send('DOM.enable');
        await cdp.send('CSS.enable');
        const {root} = await cdp.send('DOM.getDocument', {depth: -1});
        const {nodeIds} = await cdp.send('DOM.querySelectorAll', {nodeId: root.nodeId, selector: 'h2.slide-title'});
        assert.equal(nodeIds.length, 16);
        for (const [index, nodeId] of nodeIds.entries()) {
          const {fonts} = await cdp.send('CSS.getPlatformFontsForNode', {nodeId});
          assert.ok(fonts.length > 0, `title ${index + 1}: no face was reported`);
          for (const font of fonts) {
            assert.ok(font.isCustomFont, `title ${index + 1}: ${font.familyName} is not the self-hosted web font`);
            assert.equal(font.postScriptName, 'Poppins-SemiBold', `title ${index + 1}: drawn with ${font.familyName}`);
          }
        }
      } finally {
        await context.close();
      }
    });
  }
});
