/**
 * D48: chart labels with the theme's Inter in Chromium, Firefox and WebKit.
 *
 * Charts lay labels out with a fixed advance table, never a measurement. Here
 * the table is checked against the shipped Inter as each engine sets it, and
 * charts with long upper-case names in every chart kind
 * (test/fixtures/charts/label-bounds.ts), the positive fixtures and the
 * densest vertical bars are drawn inline in a page that loads
 * theme/css/fonts.css, as a published piece does: every <text> box must lie
 * inside its SVG's viewBox.
 */
import assert from 'node:assert/strict';
import {cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after, before, describe, test} from 'node:test';

import type {Browser, Page} from 'playwright';

import {chartLabelWidth, renderChart} from '../../src/core/charts.js';
import {interCodePoints} from '../fixtures/charts/inter-coverage.js';
import {CHART_FONT_SIZE, denseBars, upperCaseCharts} from '../fixtures/charts/label-bounds.js';
import {positiveFixtures} from '../fixtures/charts/render-fixtures.js';
import {applicationRoot} from '../helpers/paths.js';
import {launchEngine, selectedEngines} from './helpers/engines.js';
import {serveDirectory, type StaticServer} from './helpers/static-server.js';

const TIMEOUT = {timeout: 90_000};
/** Engines place text on fractional pixels; a box may touch the edge by this much. */
const TOLERANCE = 1;

/**
 * Every character the shipped Inter draws, read from its font files, except
 * controls and format characters, which take no room. A character Inter lacks
 * comes from a fallback face whose width depends on the machine, so the table
 * can only be held to Inter's own characters.
 */
const INTER_CHARACTERS = interCodePoints()
  .map((code) => String.fromCodePoint(code))
  .filter((char) => !/[\p{Cc}\p{Cf}]/u.test(char));

const charts = [
  ...upperCaseCharts().map(({name, input}) => ({name, svg: renderChart(input).svg})),
  ...positiveFixtures().map((fixture) => ({name: fixture.name, svg: renderChart(fixture.input).svg})),
  // The review's densest vertical bars, which now widen the drawing.
  ...([[15, 5, 240], [22, 5, 240], [60, 5, 240], [100, 5, 640], [40, 1, 240]] as const).map(([categories, k, width]) => ({
    name: `${categories} × ${k} dense bars at ${width} px`,
    svg: renderChart(denseBars(categories, k, width)).svg,
  })),
];

const workspace = mkdtempSync(join(tmpdir(), 'papeleria-charts-'));
let server: StaticServer | undefined;

before(async () => {
  mkdirSync(join(workspace, 'theme', 'css'), {recursive: true});
  cpSync(join(applicationRoot, 'theme', 'fonts'), join(workspace, 'theme', 'fonts'), {recursive: true});
  cpSync(join(applicationRoot, 'theme', 'css', 'fonts.css'), join(workspace, 'theme', 'css', 'fonts.css'));
  writeFileSync(
    join(workspace, 'charts.html'),
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Charts</title>' +
      '<link rel="stylesheet" href="theme/css/fonts.css"><style>body{margin:0}#host svg{display:block}</style></head>' +
      '<body><div id="host"></div></body></html>',
  );
  server = await serveDirectory(workspace);
});

after(async () => {
  await server?.close();
  rmSync(workspace, {recursive: true, force: true});
});

/** Opens the chart page with every face of fonts.css loaded, and Inter among them. */
async function chartPage(browser: Browser): Promise<Page> {
  if (server === undefined) {
    throw new Error('the chart page server is not running');
  }
  const page = await browser.newPage({viewport: {width: 1400, height: 900}});
  await page.goto(`${server.origin}/charts.html`);
  const loaded = await page.evaluate(async () => {
    await Promise.allSettled(Array.from(document.fonts, (face) => face.load()));
    await document.fonts.ready;
    return Array.from(document.fonts)
      .filter((face) => face.status === 'loaded')
      .map((face) => face.family.replace(/["']/g, ''));
  });
  assert.ok(loaded.includes('Inter'), `Inter did not load: ${JSON.stringify(loaded)}`);
  return page;
}

const {run, excluded} = selectedEngines();

for (const engine of excluded) {
  test(`${engine}: not run`, {skip: `PAPELERIA_BROWSERS=${process.env['PAPELERIA_BROWSERS'] ?? ''} leaves ${engine} out`}, () => {});
}

for (const engine of run) {
  describe(`chart labels in ${engine}`, () => {
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

    test('launches', TIMEOUT, (context) => {
      context.diagnostic(`${engine} ${use().version()}`);
    });

    test('the advance table is never narrower than the engine sets the shipped Inter', TIMEOUT, async () => {
      const page = await chartPage(use());
      try {
        const measured = await page.evaluate(
          ({characters, size}) => {
            const ns = 'http://www.w3.org/2000/svg';
            const svg = document.createElementNS(ns, 'svg');
            const text = document.createElementNS(ns, 'text');
            text.setAttribute('font-family', "Inter, 'Helvetica Neue', Helvetica, Arial, sans-serif");
            text.setAttribute('font-size', String(size));
            text.setAttribute('font-variant', 'tabular-nums');
            svg.append(text);
            document.getElementById('host')?.append(svg);
            const length = (content: string): number => {
              text.textContent = content;
              return text.getComputedTextLength();
            };
            // Between two x's, ten in a row; a run of spaces collapses to one, so one.
            return characters.map((char) => {
              const count = char === ' ' ? 1 : 10;
              return (length(`x${char.repeat(count)}x`) - length('xx')) / count;
            });
          },
          {characters: INTER_CHARACTERS, size: CHART_FONT_SIZE},
        );
        const narrower = INTER_CHARACTERS.flatMap((char, index) => {
          const drawn = measured[index] ?? Number.POSITIVE_INFINITY;
          return chartLabelWidth(char) + 0.05 < drawn ? [`${JSON.stringify(char)} ${chartLabelWidth(char)} < ${drawn.toFixed(2)} px`] : [];
        });
        assert.deepEqual(narrower, [], 'characters laid out narrower than the engine draws them');
      } finally {
        await page.close();
      }
    });

    test('no label leaves the viewBox: long upper-case names in every chart kind, the fixtures, the densest bars', TIMEOUT, async () => {
      const page = await chartPage(use());
      try {
        for (const {name, svg} of charts) {
          assert.ok(svg !== null, `${name} did not render`);
          const outside = await page.evaluate(
            ({markup, tolerance}) => {
              const host = document.getElementById('host');
              if (host === null) {
                throw new Error('no host element');
              }
              host.innerHTML = markup;
              const root = host.querySelector('svg');
              const [, , width = 0, height = 0] = (root?.getAttribute('viewBox') ?? '').split(' ').map(Number);
              const frame = root?.getBoundingClientRect();
              if (root === null || root === undefined || frame === undefined) {
                throw new Error('no chart SVG');
              }
              return Array.from(root.querySelectorAll('text')).flatMap((label) => {
                const box = label.getBoundingClientRect();
                const [left, top, right, bottom] = [box.left - frame.left, box.top - frame.top, box.right - frame.left, box.bottom - frame.top];
                return left < -tolerance || top < -tolerance || right > width + tolerance || bottom > height + tolerance
                  ? [`${JSON.stringify(label.textContent)} at ${[left, top, right, bottom].map((edge) => edge.toFixed(1)).join(', ')} in ${width}×${height}`]
                  : [];
              });
            },
            {markup: svg, tolerance: TOLERANCE},
          );
          assert.deepEqual(outside, [], `${name}: labels outside the viewBox`);
        }
      } finally {
        await page.close();
      }
    });
  });
}
