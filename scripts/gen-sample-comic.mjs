#!/usr/bin/env node
/**
 * The sample comic's eight prototype pages (M4.5, script and assets half; D17, D102).
 *
 * examples/sample-comic is labelled a prototype and never presented as
 * published work (PRD §11), so its art is drawn here rather than supplied:
 * eight portrait pages of 1600 × 2200 px, each a paper ground, the title
 * "The ferry · prototype", the page number, the panel frames exactly at the
 * boxes the manifest gives (read from examples/sample-comic/papeleria.yaml,
 * so the art cannot drift from them), a scene hint in each panel made of
 * lines and simple shapes, and the label "Placeholder art, generated". There
 * is no owner mark, no third-party image and no name that could pass for a
 * credit.
 *
 * Every page is SVG text built by the functions below, rasterized by sharp
 * (librsvg, already a dependency; D46's rule that SVG never reaches sharp is
 * about authors' files in the product, not this development script). The
 * lettering is drawn as stroked paths from a small built-in stroke font, so
 * no installed font can change a pixel, and nothing is random. The script
 * renders each page twice and fails unless the bytes are identical; identical
 * bytes are promised for one machine and toolchain, not across platforms
 * (IC04 says the same of derivatives).
 *
 * Each page is then derived as a build would derive it, with `deriveImage`
 * from the built core, and every 800 px derivative, WebP and (where the
 * encoder works) AVIF, is held to the comic phone-image budget of 307,200
 * bytes, inclusive (IC04). The sizes are printed.
 *
 * Needs the core compiled: `npm run gen:sample-comic` builds first.
 *
 * Usage: node scripts/gen-sample-comic.mjs [--check] [--out <dir>]
 *        --check  renders in memory, compares with the committed pages and
 *                 writes nothing
 *        --out    writes the pages somewhere else
 * Exit:  0 written (or, with --check, current) and within the budget · 1 a
 *        render that is not deterministic, a stale page, or a derivative over
 *        the budget · 2 usage, IO, or no built core
 */
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, relative, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

import sharp from 'sharp';

class UsageError extends Error {}

const APPLICATION_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PIECE = join(APPLICATION_ROOT, 'examples', 'sample-comic');
export const DEFAULT_OUT = join(PIECE, 'assets', 'images', 'pages');

export const PAGE_WIDTH = 1600;
export const PAGE_HEIGHT = 2200;
/** IC04: a comic phone derivative is at most this many bytes, inclusive, for every emitted format. */
export const PHONE_BUDGET_BYTES = 307_200;
export const PHONE_WIDTH = 800;

export const TITLE = 'The ferry · prototype';
export const LABEL = 'Placeholder art, generated';

/** The theme's neutrals (theme/css/tokens.css) and two pale tints for sky and water. */
const COLOURS = Object.freeze({
  paper: '#fcfcfa',
  ink: '#1d1d1a',
  muted: '#5f5f57',
  rule: '#d8d8d1',
  sky: '#e9eef0',
  water: '#d3e0e6',
  fog: '#b9c2c4',
});

/** Two decimals: the SVG text is stable, and nothing finer shows at this size. */
function n(value) {
  const fixed = value.toFixed(2);
  return fixed === '-0.00' ? '0.00' : fixed;
}

// ------------------------------------------------------------- lettering ---

/**
 * A stroke font for the characters the pages use, in em units: the baseline
 * at y = 0, capitals and figures 0.7 tall, the x-height 0.5, descenders to 0.2,
 * y growing downwards as in SVG. Drawn with round caps and joins.
 */
const GLYPHS = Object.freeze({
  ' ': {advance: 0.28, d: ''},
  '·': {advance: 0.26, d: 'M0.1 -0.27 a0.03 0.03 0 1 0 0.06 0 a0.03 0.03 0 1 0 -0.06 0'},
  ',': {advance: 0.22, d: 'M0.1 -0.05 L0.05 0.13'},
  T: {advance: 0.62, d: 'M0.02 -0.7 L0.58 -0.7 M0.3 -0.7 L0.3 0'},
  P: {advance: 0.58, d: 'M0.04 0 L0.04 -0.7 L0.3 -0.7 A0.18 0.18 0 0 1 0.3 -0.34 L0.04 -0.34'},
  a: {advance: 0.52, d: 'M0.42 -0.5 L0.42 0 M0.42 -0.25 A0.2 0.25 0 1 1 0.02 -0.25 A0.2 0.25 0 1 1 0.42 -0.25'},
  c: {advance: 0.46, d: 'M0.4 -0.42 A0.2 0.25 0 1 0 0.4 -0.08'},
  d: {advance: 0.52, d: 'M0.42 -0.72 L0.42 0 M0.42 -0.25 A0.2 0.25 0 1 1 0.02 -0.25 A0.2 0.25 0 1 1 0.42 -0.25'},
  e: {advance: 0.48, d: 'M0.03 -0.26 L0.41 -0.26 A0.19 0.24 0 1 0 0.36 -0.08'},
  f: {advance: 0.36, d: 'M0.34 -0.69 A0.15 0.15 0 0 0 0.14 -0.55 L0.14 0 M0.02 -0.46 L0.3 -0.46'},
  g: {advance: 0.52, d: 'M0.42 -0.5 L0.42 0.05 A0.19 0.15 0 0 1 0.05 0.12 M0.42 -0.25 A0.2 0.25 0 1 1 0.02 -0.25 A0.2 0.25 0 1 1 0.42 -0.25'},
  h: {advance: 0.5, d: 'M0.04 -0.72 L0.04 0 M0.04 -0.3 A0.18 0.2 0 0 1 0.4 -0.3 L0.4 0'},
  l: {advance: 0.2, d: 'M0.07 -0.72 L0.07 0'},
  n: {advance: 0.5, d: 'M0.04 -0.5 L0.04 0 M0.04 -0.3 A0.18 0.2 0 0 1 0.4 -0.3 L0.4 0'},
  o: {advance: 0.52, d: 'M0.44 -0.25 A0.21 0.25 0 1 1 0.02 -0.25 A0.21 0.25 0 1 1 0.44 -0.25'},
  p: {advance: 0.52, d: 'M0.04 -0.5 L0.04 0.2 M0.04 -0.25 A0.2 0.25 0 1 0 0.44 -0.25 A0.2 0.25 0 1 0 0.04 -0.25'},
  r: {advance: 0.34, d: 'M0.04 -0.5 L0.04 0 M0.04 -0.28 A0.26 0.22 0 0 1 0.31 -0.5'},
  t: {advance: 0.36, d: 'M0.14 -0.66 L0.14 -0.08 A0.08 0.08 0 0 0 0.22 0 L0.31 0 M0.02 -0.46 L0.29 -0.46'},
  y: {advance: 0.46, d: 'M0.02 -0.5 L0.22 0 M0.42 -0.5 L0.15 0.2'},
  1: {advance: 0.48, d: 'M0.09 -0.56 L0.25 -0.7 L0.25 0 M0.09 0 L0.41 0'},
  2: {advance: 0.48, d: 'M0.05 -0.55 A0.19 0.17 0 1 1 0.37 -0.42 L0.04 0 L0.43 0'},
  3: {advance: 0.48, d: 'M0.05 -0.6 A0.18 0.16 0 1 1 0.2 -0.38 A0.2 0.19 0 1 1 0.04 -0.1'},
  4: {advance: 0.48, d: 'M0.33 0 L0.33 -0.7 L0.03 -0.2 L0.45 -0.2'},
  5: {advance: 0.48, d: 'M0.41 -0.7 L0.09 -0.7 L0.07 -0.41 A0.2 0.21 0 1 1 0.04 -0.1'},
  6: {advance: 0.48, d: 'M0.38 -0.68 Q0.06 -0.62 0.04 -0.22 M0.42 -0.22 A0.19 0.22 0 1 1 0.04 -0.22 A0.19 0.22 0 1 1 0.42 -0.22'},
  7: {advance: 0.46, d: 'M0.03 -0.7 L0.43 -0.7 L0.17 0'},
  8: {advance: 0.48, d: 'M0.39 -0.53 A0.17 0.17 0 1 1 0.05 -0.53 A0.17 0.17 0 1 1 0.39 -0.53 M0.42 -0.19 A0.2 0.19 0 1 1 0.02 -0.19 A0.2 0.19 0 1 1 0.42 -0.19'},
});

/** The width of a line of lettering, in px. */
export function textWidth(text, size) {
  let width = 0;
  for (const character of text) {
    const glyph = GLYPHS[character];
    if (glyph === undefined) {
      throw new Error(`the stroke font has no ${JSON.stringify(character)}`);
    }
    width += glyph.advance;
  }
  return width * size;
}

/** A line of lettering as one stroked group; `anchor` 'end' right-aligns it at x. */
function lettering(text, x, baseline, size, colour, anchor = 'start') {
  const start = anchor === 'end' ? x - textWidth(text, size) : x;
  const parts = [];
  let offset = 0;
  for (const character of text) {
    const glyph = GLYPHS[character];
    if (glyph.d !== '') {
      parts.push(`<path transform="translate(${n(offset)} 0)" d="${glyph.d}"/>`);
    }
    offset += glyph.advance;
  }
  return (
    `<g transform="translate(${n(start)} ${n(baseline)}) scale(${n(size)})" fill="none" stroke="${colour}" ` +
    `stroke-width="0.09" stroke-linecap="round" stroke-linejoin="round">${parts.join('')}</g>`
  );
}

// ---------------------------------------------------------------- scenes ---

/**
 * Scene hints, drawn in a panel's own frame: `u` and `v` run from 0 to 1
 * across its width and height. Each returns SVG elements.
 */
function frame(box) {
  const [x, y, w, h] = box;
  const rx = (x / 100) * PAGE_WIDTH;
  const ry = (y / 100) * PAGE_HEIGHT;
  const rw = (w / 100) * PAGE_WIDTH;
  const rh = (h / 100) * PAGE_HEIGHT;
  return {
    rx,
    ry,
    rw,
    rh,
    X: (u) => rx + u * rw,
    Y: (v) => ry + v * rh,
    /** A length relative to the panel's smaller side. */
    L: (k) => k * Math.min(rw, rh),
  };
}

const stroke = (colour, width) => `stroke="${colour}" stroke-width="${n(width)}" stroke-linecap="round" stroke-linejoin="round"`;
const line = (colour, width) => `fill="none" ${stroke(colour, width)}`;

const scene = {
  sky(f, horizon) {
    return `<rect x="${n(f.rx)}" y="${n(f.ry)}" width="${n(f.rw)}" height="${n(horizon * f.rh)}" fill="${COLOURS.sky}"/>`;
  },
  sea(f, horizon) {
    return `<rect x="${n(f.rx)}" y="${n(f.Y(horizon))}" width="${n(f.rw)}" height="${n((1 - horizon) * f.rh)}" fill="${COLOURS.water}"/>` +
      `<path d="M${n(f.X(0))} ${n(f.Y(horizon))} L${n(f.X(1))} ${n(f.Y(horizon))}" ${line(COLOURS.ink, 4)}/>`;
  },
  waves(f, v, rows, amplitude) {
    let d = '';
    for (let row = 0; row < rows; row += 1) {
      const y = f.Y(v + row * 0.09);
      const step = f.rw / 12;
      d += `M${n(f.X(0))} ${n(y)}`;
      for (let index = 0; index < 12; index += 1) {
        const x0 = f.X(0) + index * step;
        d += ` Q${n(x0 + step / 4)} ${n(y - amplitude)} ${n(x0 + step / 2)} ${n(y)} T${n(x0 + step)} ${n(y)}`;
      }
    }
    return `<path d="${d}" ${line(COLOURS.muted, 3)}/>`;
  },
  sun(f, u, v, r, rays) {
    const cx = f.X(u);
    const cy = f.Y(v);
    const radius = f.L(r);
    let d = '';
    for (let index = 0; index < rays; index += 1) {
      const angle = Math.PI + (index * Math.PI) / (rays - 1);
      d += `M${n(cx + Math.cos(angle) * radius * 1.35)} ${n(cy + Math.sin(angle) * radius * 1.35)} L${n(cx + Math.cos(angle) * radius * 1.8)} ${n(cy + Math.sin(angle) * radius * 1.8)} `;
    }
    return `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(radius)}" fill="${COLOURS.paper}" stroke="${COLOURS.ink}" stroke-width="4"/>` +
      `<path d="${d.trim()}" ${line(COLOURS.ink, 4)}/>`;
  },
  fog(f, v0, v1, rows) {
    let d = '';
    for (let row = 0; row < rows; row += 1) {
      const y = f.Y(v0 + ((v1 - v0) * row) / Math.max(rows - 1, 1));
      const inset = (row % 2) * 0.08;
      d += `M${n(f.X(0.04 + inset))} ${n(y)} L${n(f.X(0.96 - inset))} ${n(y)} `;
    }
    return `<path d="${d.trim()}" ${line(COLOURS.fog, 10)} stroke-dasharray="60 26"/>`;
  },
  ferry(f, u, v, w) {
    const left = f.X(u - w / 2);
    const right = f.X(u + w / 2);
    const deck = f.Y(v);
    const hull = f.L(w * 0.32);
    const width = right - left;
    const cabinLeft = left + width * 0.22;
    const cabinTop = deck - hull * 0.9;
    const funnelX = left + width * 0.62;
    return `<path d="M${n(left)} ${n(deck)} L${n(right)} ${n(deck)} L${n(right - width * 0.08)} ${n(deck + hull)} L${n(left + width * 0.05)} ${n(deck + hull)} Z" fill="${COLOURS.paper}" ${stroke(COLOURS.ink, 4)}/>` +
      `<rect x="${n(cabinLeft)}" y="${n(cabinTop)}" width="${n(width * 0.5)}" height="${n(hull * 0.9)}" fill="${COLOURS.paper}" stroke="${COLOURS.ink}" stroke-width="4"/>` +
      `<path d="M${n(funnelX)} ${n(cabinTop)} L${n(funnelX)} ${n(cabinTop - hull * 0.7)} L${n(funnelX + width * 0.08)} ${n(cabinTop - hull * 0.7)} L${n(funnelX + width * 0.08)} ${n(cabinTop)}" ${line(COLOURS.ink, 4)}/>` +
      `<path d="M${n(cabinLeft + width * 0.06)} ${n(cabinTop + hull * 0.35)} L${n(cabinLeft + width * 0.44)} ${n(cabinTop + hull * 0.35)}" ${line(COLOURS.muted, 3)} stroke-dasharray="${n(width * 0.04)} ${n(width * 0.03)}"/>`;
  },
  pier(f, u0, u1, v, posts) {
    let d = `M${n(f.X(u0))} ${n(f.Y(v))} L${n(f.X(u1))} ${n(f.Y(v))} M${n(f.X(u0))} ${n(f.Y(v) + 14)} L${n(f.X(u1))} ${n(f.Y(v) + 14)}`;
    for (let index = 0; index < posts; index += 1) {
      const x = f.X(u0 + ((u1 - u0) * (index + 0.5)) / posts);
      d += ` M${n(x)} ${n(f.Y(v) + 14)} L${n(x)} ${n(f.Y(v) + f.L(0.18))}`;
    }
    return `<path d="${d}" ${line(COLOURS.ink, 5)}/>`;
  },
  figure(f, u, v, h) {
    const size = f.L(h);
    const x = f.X(u);
    const foot = f.Y(v);
    const head = size * 0.13;
    const neck = foot - size + head * 2;
    const hip = foot - size * 0.45;
    return `<circle cx="${n(x)}" cy="${n(foot - size + head)}" r="${n(head)}" fill="${COLOURS.paper}" stroke="${COLOURS.ink}" stroke-width="4"/>` +
      `<path d="M${n(x)} ${n(neck)} L${n(x)} ${n(hip)} M${n(x - size * 0.16)} ${n(foot)} L${n(x)} ${n(hip)} L${n(x + size * 0.16)} ${n(foot)} ` +
      `M${n(x - size * 0.2)} ${n(neck + size * 0.2)} L${n(x)} ${n(neck + size * 0.06)} L${n(x + size * 0.2)} ${n(neck + size * 0.2)}" ${line(COLOURS.ink, 4)}/>`;
  },
  gull(f, u, v, s) {
    const x = f.X(u);
    const y = f.Y(v);
    const span = f.L(s);
    return `<path d="M${n(x - span)} ${n(y)} Q${n(x - span / 2)} ${n(y - span * 0.6)} ${n(x)} ${n(y)} Q${n(x + span / 2)} ${n(y - span * 0.6)} ${n(x + span)} ${n(y)}" ${line(COLOURS.ink, 4)}/>`;
  },
  bollard(f, u, v, s) {
    const w = f.L(s);
    return `<rect x="${n(f.X(u) - w / 2)}" y="${n(f.Y(v) - w * 1.2)}" width="${n(w)}" height="${n(w * 1.2)}" rx="${n(w * 0.25)}" fill="${COLOURS.rule}" stroke="${COLOURS.ink}" stroke-width="4"/>`;
  },
  booth(f, u, v, w, h) {
    const left = f.X(u);
    const bottom = f.Y(v);
    const width = f.L(w);
    const height = f.L(h);
    return `<rect x="${n(left)}" y="${n(bottom - height)}" width="${n(width)}" height="${n(height)}" fill="${COLOURS.paper}" stroke="${COLOURS.ink}" stroke-width="4"/>` +
      `<path d="M${n(left - width * 0.1)} ${n(bottom - height)} L${n(left + width / 2)} ${n(bottom - height * 1.35)} L${n(left + width * 1.1)} ${n(bottom - height)}" fill="${COLOURS.rule}" ${stroke(COLOURS.ink, 4)}/>` +
      `<rect x="${n(left + width * 0.2)}" y="${n(bottom - height * 0.8)}" width="${n(width * 0.6)}" height="${n(height * 0.3)}" fill="${COLOURS.sky}" stroke="${COLOURS.ink}" stroke-width="3"/>`;
  },
  bubble(f, u, v, w, h, tailU, tailV) {
    const cx = f.X(u);
    const cy = f.Y(v);
    const rx = (f.rw * w) / 2;
    const ry = (f.rh * h) / 2;
    return `<path d="M${n(cx - rx * 0.2)} ${n(cy + ry * 0.9)} L${n(f.X(tailU))} ${n(f.Y(tailV))} L${n(cx + rx * 0.15)} ${n(cy + ry * 0.95)}" fill="${COLOURS.paper}" ${stroke(COLOURS.ink, 4)}/>` +
      `<ellipse cx="${n(cx)}" cy="${n(cy)}" rx="${n(rx)}" ry="${n(ry)}" fill="${COLOURS.paper}" stroke="${COLOURS.ink}" stroke-width="4"/>` +
      `<path d="M${n(cx - rx * 0.55)} ${n(cy - ry * 0.2)} L${n(cx + rx * 0.55)} ${n(cy - ry * 0.2)} M${n(cx - rx * 0.55)} ${n(cy + ry * 0.2)} L${n(cx + rx * 0.3)} ${n(cy + ry * 0.2)}" ${line(COLOURS.muted, 5)}/>`;
  },
  lighthouse(f, u, v, h) {
    const x = f.X(u);
    const base = f.Y(v);
    const height = f.L(h);
    const top = base - height;
    const lamp = height * 0.14;
    return `<path d="M${n(x - height * 0.12)} ${n(base)} L${n(x - height * 0.07)} ${n(top + lamp)} L${n(x + height * 0.07)} ${n(top + lamp)} L${n(x + height * 0.12)} ${n(base)} Z" fill="${COLOURS.paper}" ${stroke(COLOURS.ink, 4)}/>` +
      `<rect x="${n(x - height * 0.08)}" y="${n(top)}" width="${n(height * 0.16)}" height="${n(lamp)}" fill="${COLOURS.rule}" stroke="${COLOURS.ink}" stroke-width="4"/>` +
      `<path d="M${n(x - height * 0.1)} ${n(top + lamp * 3)} L${n(x + height * 0.1)} ${n(top + lamp * 3)} M${n(x - height * 0.11)} ${n(top + lamp * 5)} L${n(x + height * 0.11)} ${n(top + lamp * 5)}" ${line(COLOURS.ink, 4)}/>`;
  },
  beams(f, u, v, length) {
    const x = f.X(u);
    const y = f.Y(v);
    const reach = f.L(length);
    return `<path d="M${n(x)} ${n(y)} L${n(x + reach)} ${n(y - reach * 0.18)} M${n(x)} ${n(y)} L${n(x + reach)} ${n(y + reach * 0.12)} M${n(x)} ${n(y)} L${n(x - reach)} ${n(y - reach * 0.15)}" ${line(COLOURS.muted, 3)} stroke-dasharray="18 12"/>`;
  },
  houses(f, u, v, count, s) {
    let body = '';
    for (let index = 0; index < count; index += 1) {
      const w = f.L(s) * (1 + (index % 3) * 0.2);
      const left = f.X(u) + index * f.L(s) * 1.5;
      const bottom = f.Y(v);
      body += `<path d="M${n(left)} ${n(bottom)} L${n(left)} ${n(bottom - w * 0.8)} L${n(left + w / 2)} ${n(bottom - w * 1.25)} L${n(left + w)} ${n(bottom - w * 0.8)} L${n(left + w)} ${n(bottom)}" fill="${COLOURS.paper}" ${stroke(COLOURS.ink, 3)}/>`;
    }
    return body;
  },
  rail(f, v, posts) {
    let d = `M${n(f.X(0))} ${n(f.Y(v))} L${n(f.X(1))} ${n(f.Y(v))} M${n(f.X(0))} ${n(f.Y(v + 0.08))} L${n(f.X(1))} ${n(f.Y(v + 0.08))}`;
    for (let index = 1; index < posts; index += 1) {
      const x = f.X(index / posts);
      d += ` M${n(x)} ${n(f.Y(v))} L${n(x)} ${n(f.Y(1))}`;
    }
    return `<path d="${d}" ${line(COLOURS.ink, 6)}/>`;
  },
  wake(f, u, v, spread) {
    const x = f.X(u);
    const y = f.Y(v);
    return `<path d="M${n(x)} ${n(y)} L${n(x - f.L(spread))} ${n(f.Y(1))} M${n(x)} ${n(y)} L${n(x + f.L(spread))} ${n(f.Y(1))}" ${line(COLOURS.paper, 8)}/>` +
      `<path d="M${n(x)} ${n(y)} L${n(x - f.L(spread) * 0.6)} ${n(f.Y(1))} M${n(x)} ${n(y)} L${n(x + f.L(spread) * 0.6)} ${n(f.Y(1))}" ${line(COLOURS.muted, 3)}/>`;
  },
  horn(f, u, v) {
    const x = f.X(u);
    const y = f.Y(v);
    let d = '';
    for (let index = 1; index <= 3; index += 1) {
      const r = f.L(0.06) * index;
      d += `M${n(x + r * 0.7)} ${n(y - r * 0.7)} A${n(r)} ${n(r)} 0 0 1 ${n(x + r * 0.7)} ${n(y + r * 0.7)} `;
    }
    return `<path d="${d.trim()}" ${line(COLOURS.muted, 4)}/>`;
  },
  rope(f, u0, v0, u1, v1) {
    const mx = (f.X(u0) + f.X(u1)) / 2;
    const my = Math.max(f.Y(v0), f.Y(v1)) + f.L(0.08);
    return `<path d="M${n(f.X(u0))} ${n(f.Y(v0))} Q${n(mx)} ${n(my)} ${n(f.X(u1))} ${n(f.Y(v1))}" ${line(COLOURS.ink, 4)}/>`;
  },
  gangway(f, u0, v0, u1, v1) {
    return `<path d="M${n(f.X(u0))} ${n(f.Y(v0))} L${n(f.X(u1))} ${n(f.Y(v1))} M${n(f.X(u0))} ${n(f.Y(v0) - 16)} L${n(f.X(u1))} ${n(f.Y(v1) - 16)}" ${line(COLOURS.ink, 5)}/>`;
  },
};

/**
 * What each panel shows, page by page, from the page's alternative text and
 * the panel's transcript in the manifest. Page 1 has five panels, the others
 * three: a wide one on top and two below.
 */
const PAGES = [
  // 1. A harbor at dawn, seen from the ferry pier.
  [
    (f) => scene.sky(f, 0.62) + scene.sun(f, 0.7, 0.62, 0.16, 7) + scene.sea(f, 0.62) + scene.waves(f, 0.72, 2, 10) + scene.pier(f, 0, 0.55, 0.86, 4),
    (f) => scene.sky(f, 0.8) + scene.bollard(f, 0.42, 0.95, 0.32) + scene.gull(f, 0.42, 0.52, 0.16) + scene.horn(f, 0.78, 0.3),
    (f) => scene.sky(f, 0.55) + scene.sea(f, 0.55) + scene.pier(f, 0.3, 1, 0.8, 6) + scene.booth(f, 0.62, 0.8, 0.5, 0.44) + scene.figure(f, 0.5, 0.8, 0.46) + scene.figure(f, 0.56, 0.8, 0.42),
    (f) => scene.sky(f, 0.7) + scene.figure(f, 0.3, 0.95, 0.6) + scene.bubble(f, 0.64, 0.3, 0.56, 0.3, 0.4, 0.5),
    (f) => scene.sky(f, 0.6) + scene.sea(f, 0.6) + scene.ferry(f, 0.5, 0.56, 0.5) + scene.fog(f, 0.2, 0.9, 5),
  ],
  // 2. The ferry docks; passengers file aboard.
  [
    (f) => scene.sky(f, 0.58) + scene.sea(f, 0.58) + scene.ferry(f, 0.62, 0.56, 0.6) + scene.pier(f, 0, 0.4, 0.74, 4) + scene.gangway(f, 0.3, 0.74, 0.46, 0.56) + scene.figure(f, 0.12, 0.74, 0.32) + scene.figure(f, 0.2, 0.74, 0.3) + scene.figure(f, 0.36, 0.66, 0.28),
    (f) => scene.sky(f, 0.5) + scene.gangway(f, 0.05, 0.9, 0.95, 0.45) + scene.figure(f, 0.4, 0.72, 0.42) + scene.figure(f, 0.62, 0.62, 0.4),
    (f) => scene.sky(f, 0.4) + scene.sea(f, 0.72) + scene.ferry(f, 0.55, 0.5, 1.2) + scene.rope(f, 0, 0.62, 0.34, 0.52),
  ],
  // 3. On deck; the town shrinks behind the wake.
  [
    (f) => scene.sky(f, 0.42) + scene.sea(f, 0.42) + scene.houses(f, 0.36, 0.42, 5, 0.06) + scene.wake(f, 0.5, 0.45, 0.6) + scene.rail(f, 0.82, 8),
    (f) => scene.sky(f, 0.45) + scene.sea(f, 0.45) + scene.figure(f, 0.36, 0.95, 0.6) + scene.figure(f, 0.62, 0.95, 0.56) + scene.rail(f, 0.7, 4),
    (f) => scene.sky(f, 0.5) + scene.sea(f, 0.5) + scene.houses(f, 0.42, 0.5, 3, 0.04) + scene.wake(f, 0.5, 0.52, 0.9),
  ],
  // 4. A conversation at the rail.
  [
    (f) => scene.sky(f, 0.5) + scene.sea(f, 0.5) + scene.figure(f, 0.38, 0.9, 0.62) + scene.figure(f, 0.6, 0.9, 0.58) + scene.rail(f, 0.72, 8) + scene.bubble(f, 0.2, 0.22, 0.24, 0.26, 0.34, 0.42) + scene.bubble(f, 0.8, 0.2, 0.22, 0.24, 0.64, 0.42),
    (f) => scene.sky(f, 0.6) + scene.figure(f, 0.3, 1.05, 0.9) + scene.figure(f, 0.7, 1.05, 0.85) + scene.bubble(f, 0.5, 0.18, 0.44, 0.22, 0.34, 0.34),
    (f) => scene.sky(f, 0.46) + scene.sea(f, 0.46) + scene.waves(f, 0.58, 3, 12) + scene.figure(f, 0.3, 0.98, 0.7),
  ],
  // 5. The far shore; a lighthouse in the fog.
  [
    (f) => scene.sky(f, 0.64) + scene.sea(f, 0.64) + scene.lighthouse(f, 0.7, 0.64, 0.55) + scene.beams(f, 0.7, 0.13, 0.5) + scene.fog(f, 0.3, 0.9, 5),
    (f) => scene.sky(f, 0.78) + scene.lighthouse(f, 0.5, 0.95, 0.85) + scene.beams(f, 0.5, 0.375, 0.45),
    (f) => scene.sky(f, 0.52) + scene.sea(f, 0.52) + scene.fog(f, 0.15, 0.85, 7),
  ],
  // 6. The crossing at midday.
  [
    (f) => scene.sky(f, 0.56) + scene.sun(f, 0.5, 0.2, 0.12, 9) + scene.sea(f, 0.56) + scene.waves(f, 0.66, 3, 10) + scene.ferry(f, 0.3, 0.6, 0.34),
    (f) => scene.sky(f, 0.4) + scene.sun(f, 0.5, 0.25, 0.14, 9) + scene.sea(f, 0.4) + scene.waves(f, 0.5, 5, 14),
    (f) => scene.sky(f, 0.58) + scene.sea(f, 0.58) + scene.waves(f, 0.7, 3, 12) + scene.gull(f, 0.5, 0.3, 0.2),
  ],
  // 7. Arrival; the same two figures, ashore.
  [
    (f) => scene.sky(f, 0.5) + scene.sea(f, 0.5) + scene.ferry(f, 0.24, 0.48, 0.3) + scene.pier(f, 0, 1, 0.78, 7) + scene.figure(f, 0.6, 0.78, 0.4) + scene.figure(f, 0.68, 0.78, 0.37),
    (f) => scene.sky(f, 0.62) + scene.figure(f, 0.4, 0.96, 0.8) + scene.figure(f, 0.64, 0.96, 0.74),
    (f) => scene.sky(f, 0.6) + scene.houses(f, 0.1, 0.9, 4, 0.2),
  ],
  // 8. The ferry leaves; the pier is empty.
  [
    (f) => scene.sky(f, 0.5) + scene.sea(f, 0.5) + scene.ferry(f, 0.8, 0.49, 0.16) + scene.wake(f, 0.72, 0.53, 0.2) + scene.pier(f, 0, 0.6, 0.8, 5),
    (f) => scene.sky(f, 0.7) + scene.bollard(f, 0.5, 0.95, 0.3) + scene.rope(f, 0.5, 0.7, 1, 0.82),
    (f) => scene.sky(f, 0.52) + scene.sea(f, 0.52) + scene.ferry(f, 0.5, 0.505, 0.08) + scene.wake(f, 0.5, 0.53, 0.5),
  ],
];

/** The SVG text of page `pageNumber` (1-based), with the panel boxes of `manifest`. */
export function pageSvg(pageNumber, manifest) {
  const page = manifest.pages[pageNumber - 1];
  const drawings = PAGES[pageNumber - 1];
  if (page === undefined || drawings === undefined) {
    throw new Error(`there is no page ${pageNumber}`);
  }
  const panels = page.panels ?? [];
  if (panels.length !== drawings.length) {
    throw new Error(`page ${pageNumber} has ${panels.length} panels in the manifest and ${drawings.length} scenes here`);
  }
  const body = [];
  body.push(`<rect width="${PAGE_WIDTH}" height="${PAGE_HEIGHT}" fill="${COLOURS.paper}"/>`);
  panels.forEach((panel, index) => {
    const f = frame(panel.box);
    const id = `p${pageNumber}-${index + 1}`;
    body.push(`<clipPath id="${id}"><rect x="${n(f.rx)}" y="${n(f.ry)}" width="${n(f.rw)}" height="${n(f.rh)}"/></clipPath>`);
    body.push(`<g clip-path="url(#${id})">${drawings[index](f)}</g>`);
    // The frame sits exactly on the manifest's box.
    body.push(`<rect x="${n(f.rx)}" y="${n(f.ry)}" width="${n(f.rw)}" height="${n(f.rh)}" fill="none" stroke="${COLOURS.ink}" stroke-width="6"/>`);
  });
  const margin = 0.04 * PAGE_WIDTH;
  body.push(lettering(TITLE, margin, 64, 50, COLOURS.ink));
  body.push(lettering(`Page ${pageNumber} of ${manifest.pages.length}`, PAGE_WIDTH - margin, 64, 50, COLOURS.ink, 'end'));
  body.push(lettering(LABEL, margin, PAGE_HEIGHT - 30, 50, COLOURS.muted));
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${PAGE_WIDTH}" height="${PAGE_HEIGHT}" viewBox="0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}">` +
    `${body.join('')}</svg>\n`
  );
}

/** PNG bytes for one page. The settings are fixed, and nothing in them depends on time or place. */
export async function renderPage(svg) {
  return sharp(Buffer.from(svg), {density: 72}).png({compressionLevel: 9, adaptiveFiltering: true, palette: true, colours: 64, dither: 0}).toBuffer();
}

// ----------------------------------------------------------------- budget ---

async function loadCore() {
  const entry = join(APPLICATION_ROOT, 'lib', 'src', 'core', 'index.js');
  if (!existsSync(entry)) {
    throw new UsageError(`${relative(APPLICATION_ROOT, entry)} is missing; run npm run build first (npm run gen:sample-comic does)`);
  }
  return import(pathToFileURL(entry).href);
}

/** Derives each page as a build would and returns every derivative's size. */
async function derivatives(core, files) {
  const scratch = mkdtempSync(join(tmpdir(), 'papeleria-sample-comic-'));
  try {
    const rows = [];
    for (const [name, bytes] of files) {
      const result = await core.deriveImage({
        bytes: new Uint8Array(bytes),
        relativePath: `assets/images/pages/${name}`,
        outputDir: join(scratch, 'dist'),
        cacheDir: join(scratch, 'cache'),
      });
      if (!result.ok) {
        throw new Error(`${name}: ${result.problem.message}`);
      }
      rows.push({name, png: bytes.length, derivatives: result.derivatives, warnings: result.warnings});
    }
    return rows;
  } finally {
    rmSync(scratch, {recursive: true, force: true});
  }
}

const count = new Intl.NumberFormat('en-US');

function sizeOf(row, width, format) {
  return row.derivatives.find((derivative) => derivative.width === width && derivative.format === format)?.bytes ?? null;
}

// ------------------------------------------------------------------- main ---

function parseArguments(argv) {
  const options = {check: false, out: DEFAULT_OUT};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--check') {
      options.check = true;
    } else if (flag === '--out') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new UsageError('--out needs a folder');
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
    error(`gen-sample-comic: ${problem.message}`);
    if (problem instanceof UsageError) {
      error('usage: node scripts/gen-sample-comic.mjs [--check] [--out <dir>]');
    }
    return 2;
  }
  const problems = [];
  let files;
  try {
    const parsed = core.parseManifest(readFileSync(join(PIECE, 'papeleria.yaml'), 'utf8'), 'papeleria.yaml');
    if (parsed.manifest === null) {
      throw new Error('examples/sample-comic/papeleria.yaml does not load');
    }
    const manifest = parsed.manifest.value;
    files = [];
    for (let number = 1; number <= manifest.pages.length; number += 1) {
      const name = `${String(number).padStart(2, '0')}.png`;
      const expected = `assets/images/pages/${name}`;
      if (manifest.pages[number - 1].image !== expected) {
        throw new Error(`page ${number} names ${JSON.stringify(manifest.pages[number - 1].image)}, not ${expected}`);
      }
      const svg = pageSvg(number, manifest);
      if (pageSvg(number, manifest) !== svg) {
        problems.push(`${name}: the SVG differs between two builds`);
      }
      const first = await renderPage(svg);
      const second = await renderPage(svg);
      if (!first.equals(second)) {
        problems.push(`${name}: two renders of the same SVG gave different bytes`);
      }
      files.push([name, first]);
    }
    if (options.check) {
      for (const [name, bytes] of files) {
        const path = join(options.out, name);
        if (!existsSync(path)) {
          problems.push(`${name} is missing from ${relative(APPLICATION_ROOT, options.out)}`);
        } else if (!readFileSync(path).equals(bytes)) {
          problems.push(`${name} differs from what this script draws; run npm run gen:sample-comic`);
        }
      }
      out(`checked ${files.length} pages against ${relative(APPLICATION_ROOT, options.out) || options.out}`);
    } else {
      mkdirSync(options.out, {recursive: true});
      for (const [name, bytes] of files) {
        writeFileSync(join(options.out, name), bytes);
      }
      out(`wrote ${files.length} pages to ${relative(APPLICATION_ROOT, options.out) || options.out}, each rendered twice with identical bytes`);
    }
  } catch (problem) {
    error(`gen-sample-comic: ${problem.message}`);
    return 2;
  }

  let rows;
  try {
    rows = await derivatives(core, files);
  } catch (problem) {
    error(`gen-sample-comic: ${problem.message}`);
    return 2;
  }
  const cell = (value) => (value === null ? '—' : count.format(value)).padStart(9);
  out(`page       PNG  ${String(PHONE_WIDTH)} WebP  ${String(PHONE_WIDTH)} AVIF  1600 WebP  1600 AVIF   (bytes; phone budget ${count.format(PHONE_BUDGET_BYTES)}, IC04)`);
  for (const row of rows) {
    out(`${row.name}  ${cell(row.png)}  ${cell(sizeOf(row, PHONE_WIDTH, 'webp'))}  ${cell(sizeOf(row, PHONE_WIDTH, 'avif'))}  ${cell(sizeOf(row, 1600, 'webp'))}  ${cell(sizeOf(row, 1600, 'avif'))}`);
    for (const derivative of row.derivatives) {
      if (derivative.width === PHONE_WIDTH && derivative.bytes > PHONE_BUDGET_BYTES) {
        problems.push(`${row.name}: the ${PHONE_WIDTH} px ${derivative.format} derivative is ${count.format(derivative.bytes)} bytes, over the ${count.format(PHONE_BUDGET_BYTES)}-byte phone budget`);
      }
    }
    if (sizeOf(row, PHONE_WIDTH, 'webp') === null) {
      problems.push(`${row.name}: no ${PHONE_WIDTH} px WebP was derived`);
    }
  }
  const avif = rows.every((row) => sizeOf(row, PHONE_WIDTH, 'avif') !== null);
  out(avif ? 'AVIF: encoded on this platform, and checked' : `AVIF: not encoded on this platform (${rows[0]?.warnings[0]?.message ?? 'no encoder'}); WebP checked alone`);
  for (const problem of problems) {
    error(`gen-sample-comic: ${problem}`);
  }
  out(problems.length === 0 ? 'result: pass — deterministic, and every phone derivative within the budget' : `result: FAIL — ${problems.length} problem(s)`);
  return problems.length === 0 ? 0 : 1;
}

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href) {
  process.exitCode = await main(process.argv.slice(2));
}
