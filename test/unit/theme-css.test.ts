/**
 * Code provenance review P05 (issue 002 F4, D180): the theme's three minified
 * stylesheets each have a readable copy in `theme/css/readable/`, written by
 * `scripts/theme-css.mjs`, and each copy is the same stylesheet as the file
 * pieces ship.
 *
 * Three readings hold a copy to its shipped file: the text without comments,
 * whitespace and a block's last semicolon is identical; every comment is kept,
 * in order, after the copy's own header; and esbuild's CSS parser minifies the
 * two to the same bytes. The first two say the formatter changed nothing but
 * whitespace, and the third that the whitespace it changed means nothing to a
 * CSS parser. `test/browser/theme-css.test.ts` asks the browsers themselves.
 */
import assert from 'node:assert/strict';
import {cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after, test} from 'node:test';
import {pathToFileURL} from 'node:url';

import * as esbuild from 'esbuild';

import {applicationRoot, scriptPath} from '../helpers/paths.js';

type Copy = {name: string; shipped: string; readable: string; expected: string; current: boolean};
type ThemeCssModule = {
  SHEETS: readonly string[];
  FormatError: new (message: string) => Error;
  formatStylesheet(text: string, name: string): string;
  strippedForm(text: string): string;
  comments(text: string): string[];
  readableCopies(root?: string): Copy[];
};

const themeCss = (await import(pathToFileURL(scriptPath('theme-css.mjs')).href)) as ThemeCssModule;

const read = (path: string): string => readFileSync(join(applicationRoot, ...path.split('/')), 'utf8');
const minified = (css: string): string => esbuild.transformSync(css, {loader: 'css', minify: true}).code;

const workspace = mkdtempSync(join(tmpdir(), 'papeleria-theme-css-'));
after(() => rmSync(workspace, {recursive: true, force: true}));

test('P05: each minified theme stylesheet has a committed readable copy, current with the file pieces ship', () => {
  assert.deepEqual(themeCss.SHEETS, ['site', 'slides', 'print']);
  for (const copy of themeCss.readableCopies()) {
    assert.ok(copy.current, `${copy.readable} is current with ${copy.shipped}; run node scripts/theme-css.mjs`);
  }
});

test('P05: a readable copy is its shipped stylesheet with whitespace changed, every comment kept and nothing else', () => {
  for (const name of themeCss.SHEETS) {
    const shipped = read(`theme/css/${name}.css`);
    const readable = read(`theme/css/readable/${name}.css`);
    assert.equal(themeCss.strippedForm(readable), themeCss.strippedForm(shipped), `${name}.css: the same text but for whitespace`);
    const kept = themeCss.comments(readable);
    assert.match(kept[0] ?? '', new RegExp(`^/\\* Readable copy of theme/css/${name}\\.css`), `${name}.css: the copy says what it is`);
    assert.deepEqual(kept.slice(1), themeCss.comments(shipped), `${name}.css: every comment kept, in order`);
    assert.equal(minified(readable), minified(shipped), `${name}.css: esbuild reads the same stylesheet`);
  }
});

test('P05: a readable copy is readable: one brace, selector or declaration a line, no line of minified length', () => {
  for (const name of themeCss.SHEETS) {
    const shipped = read(`theme/css/${name}.css`);
    const lines = read(`theme/css/readable/${name}.css`).split('\n');
    const longest = Math.max(...lines.map((line) => line.length));
    assert.ok(longest <= 120, `${name}.css: the longest readable line is ${longest} characters`);
    assert.ok(Math.max(...shipped.split('\n').map((line) => line.length)) > 1_000, `${name}.css ships minified, which is why it has a copy`);
    for (const line of lines) {
      if (!line.trimStart().startsWith('/*') && !line.trimStart().startsWith('*')) {
        assert.ok((line.match(/;/g) ?? []).length <= 1, `${name}.css: one declaration a line: ${line}`);
      }
    }
  }
});

test('P05: the formatter keeps what CSS reads as one token and splits only where CSS ignores whitespace', () => {
  const tricky = [
    '@media(max-width:640px){.a,.b:is(.c,.d)>.e{color:red!important;margin:0 auto}}',
    '.\\31 0 .x{content:";{}";background:url(a;b.png)}',
    '[data-x="a,b"],.y::after{content:\'}\';--gap: 4px  8px}',
    '@media print{@page{size:A4 landscape;margin:8mm}.z{break-after:page}}',
    '/* a note */\n.q{color:blue/* inline */;font:400  1rem/1.5\n  var(--f)}',
    '@supports(display:grid){.g{display:grid;grid-template-columns:repeat(2,minmax(0,1fr))}}',
  ].join('\n');
  const readable = themeCss.formatStylesheet(tricky, 'site');
  assert.equal(themeCss.strippedForm(readable), themeCss.strippedForm(tricky));
  assert.equal(minified(readable), minified(tricky), 'esbuild reads the same stylesheet');
  assert.match(readable, /^@media \(max-width:640px\) \{\n {2}\.a,\n {2}\.b:is\(\.c,\.d\)>\.e \{\n {4}color: red!important;\n {4}margin: 0 auto;\n {2}\}\n\}$/m, 'selectors split at the top level only');
  assert.match(readable, /^\.\\31 0 \.x \{$/m, 'a hex escape keeps the space that closes it');
  assert.match(readable, /^ {2}content: ";\{\}";$/m, 'a string is never split');
  assert.match(readable, /^ {2}background: url\(a;b\.png\);$/m, 'an unquoted url( is one token');
  assert.match(readable, /^\[data-x="a,b"\],$/m, 'a comma inside an attribute selector is not a list separator');
  assert.match(readable, /^ {2}--gap: 4px {2}8px;$/m, 'a custom property keeps its value as written, whitespace and all');
  assert.match(readable, /^ {2}font: 400 1rem\/1\.5 var\(--f\);$/m, 'a run of whitespace is one space, and a colon is followed by one');
  assert.match(readable, /^ {2}@page \{\n {4}size: A4 landscape;/m, 'an @page inside @media print holds declarations');
  assert.match(readable, /^ {2}color: blue\/\* inline \*\/;$/m, 'a comment inside a value stays where it is');
  assert.match(readable, /^@supports \(display:grid\) \{$/m);
});

test('P05: the formatter refuses what it cannot read safely, and a copy that differs is stale', () => {
  for (const broken of ['.a{color:red', '.a{color:"red}', '/* open', '.a{color:red}}', '.a{;}', '.a,{color:red}']) {
    assert.throws(() => themeCss.formatStylesheet(broken, 'site'), themeCss.FormatError, JSON.stringify(broken));
  }
  assert.notEqual(themeCss.strippedForm('.a .b{color:red}'), themeCss.strippedForm('.a .b{color:blue}'), 'a changed value is not whitespace');
  const root = join(workspace, 'root');
  cpSync(join(applicationRoot, 'theme', 'css'), join(root, 'theme', 'css'), {recursive: true});
  writeFileSync(join(root, 'theme', 'css', 'readable', 'print.css'), `${read('theme/css/readable/print.css')}\n.edited-by-hand{}\n`);
  const copies = themeCss.readableCopies(root);
  assert.deepEqual(copies.map((copy) => [copy.name, copy.current]), [['site', true], ['slides', true], ['print', false]]);
});
