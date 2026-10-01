/**
 * Measures the shipped Inter at the chart SVG's own settings (12.5 px,
 * font-variant tabular-nums) in Chromium and writes inter-metrics.json beside
 * this file, for label-bounds.ts. The page loads theme/css/fonts.css with its
 * font files inlined, so the faces and unicode ranges are the theme's own.
 *
 *   PAPELERIA_CHROMIUM_EXECUTABLE=/path/to/chromium node test/fixtures/charts/measure-inter.mjs
 *
 * Run it when the theme's Inter changes, then review the diff; the browser
 * suite checks the advance table against the font in every engine.
 */
import {readFileSync, writeFileSync} from 'node:fs';
import {chromium} from 'playwright';

const here = new URL('.', import.meta.url);
const theme = new URL('../../../theme/', import.meta.url);
const css = readFileSync(new URL('css/fonts.css', theme), 'utf8').replace(
  /url\(\.\.\/fonts\/([\w.-]+)\)/g,
  (_, file) => `url(data:font/woff2;base64,${readFileSync(new URL(`fonts/${file}`, theme)).toString('base64')})`,
);

const characters = [];
for (let code = 0x20; code <= 0x7e; code += 1) characters.push(String.fromCodePoint(code));
for (let code = 0xa1; code <= 0xff; code += 1) if (code !== 0xad) characters.push(String.fromCodePoint(code));
characters.push(...'−…–—‘’“”€');

const executablePath = process.env['PAPELERIA_CHROMIUM_EXECUTABLE'] || undefined;
const browser = await chromium.launch(executablePath === undefined ? {} : {executablePath});
try {
  const page = await browser.newPage();
  await page.setContent(`<!doctype html><html lang="en"><head><meta charset="utf-8"><style>${css}</style></head><body></body></html>`);
  const measured = await page.evaluate(async (characters) => {
    await Promise.allSettled(Array.from(document.fonts, (face) => face.load()));
    await document.fonts.ready;
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    const text = document.createElementNS(ns, 'text');
    text.setAttribute('x', '10');
    text.setAttribute('y', '100');
    text.setAttribute('font-family', "Inter, 'Helvetica Neue', Helvetica, Arial, sans-serif");
    text.setAttribute('font-size', '12.5');
    text.setAttribute('font-variant', 'tabular-nums');
    svg.append(text);
    document.body.append(svg);
    const length = (content) => {
      text.textContent = content;
      return text.getComputedTextLength();
    };
    const advances = {};
    for (const char of characters) {
      // Between two x's, ten in a row to average out rounding; a run of spaces collapses to one, so one.
      const count = char === ' ' ? 1 : 10;
      advances[char] = (length(`x${char.repeat(count)}x`) - length('xx')) / count / 12.5;
    }
    text.textContent = 'Hxgé';
    const box = text.getBBox();
    return {advances, top: (box.y - 100) / 12.5, bottom: (box.y + box.height - 100) / 12.5};
  }, characters);
  const round = (value) => Math.round(value * 10000) / 10000;
  const metrics = {
    font: 'theme/fonts/inter-400-700-latin.woff2 (Inter, weight 400)',
    measured: `Chromium ${browser.version()}, SVG text at 12.5 px with font-variant tabular-nums; advances are the mean of ten in a row`,
    unit: 'em',
    boxTop: round(measured.top),
    boxBottom: round(measured.bottom),
    advances: Object.fromEntries(Object.entries(measured.advances).map(([char, value]) => [char, round(value)])),
  };
  writeFileSync(new URL('inter-metrics.json', here), `${JSON.stringify(metrics, null, 2)}\n`);
  process.stdout.write(`${Object.keys(metrics.advances).length} advances, box ${metrics.boxTop} to ${metrics.boxBottom} em\n`);
} finally {
  await browser.close();
}
