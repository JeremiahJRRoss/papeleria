/**
 * M1.7 / D65: the html-validate configuration and Papeleria's output rules
 * (R08). A small valid page is changed one way at a time; each change must
 * be caught by the rule that owns it, and the valid page must pass.
 */
import assert from 'node:assert/strict';
import {test} from 'node:test';

import {
  decodeAttribute,
  HTML_VALIDATE_RULES,
  resolveLinkTarget,
  resolveOutputUrl,
  scanInlineSvg,
  scanStylesheet,
  unexpectedDeclarations,
  validatePage,
} from '../../src/checks/html-scan.js';
import {renderChart} from '../../src/core/index.js';
import {positiveFixtures} from '../fixtures/charts/render-fixtures.js';

const FILES = ['index.html', 'deck.js', 'theme/css/site.css', 'theme/marks/papeleria-favicon.svg', 'assets/images/a.800.webp', 'assets/images/a.1600.webp'];

function page({head = '', body = ''}: {head?: string; body?: string} = {}): string {
  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>Test</title>',
    '<link rel="icon" href="theme/marks/papeleria-favicon.svg" type="image/svg+xml">',
    '<link rel="stylesheet" href="theme/css/site.css">',
    '<script type="application/json" id="deck-strings">{"skip":"Skip \\u003cto\\u003e content"}</script>',
    '<script src="deck.js" defer></script>',
    head,
    '</head>',
    '<body>',
    '<main id="main">',
    '<article id="slide-1"><h1 id="title-1" tabindex="-1">One</h1>',
    '<div class="swatch" style="background:#0f766e"></div>',
    '<picture><source type="image/avif" srcset="assets/images/a.800.webp 800w"><img src="assets/images/a.800.webp" srcset="assets/images/a.800.webp 800w, assets/images/a.1600.webp 1600w" sizes="100vw" width="1600" height="800" alt="" style="object-position:20% 80%"></picture>',
    '<p><a href="https://example.com/">External</a> <a href="mailto:a@example.com">Mail</a> <a href="#slide-1">Here</a></p>',
    '<div class="table-wrap" tabindex="0" role="region" aria-labelledby="title-1"><table><thead><tr><th scope="col">A</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table></div>',
    body,
    '</article>',
    '</main>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

/** The lines where `page` puts its `head` and `body` additions. */
const HEAD_LINE = page({head: 'HEAD'}).split('\n').indexOf('HEAD') + 1;
const BODY_LINE = page({body: 'BODY'}).split('\n').indexOf('BODY') + 1;

async function rulesFor(html: string, script: string | null = 'deck.js'): Promise<string[]> {
  return (await validatePage(html, {files: FILES, script})).map((message) => `${message.rule}@${message.line}`);
}

test('D65: the valid page passes, swatch and focal-point styles, the table region and a shared landmark label included', async () => {
  assert.deepEqual(await rulesFor(page()), []);
  const twoAsides = page({body: '<aside aria-label="Notes">a</aside></article><article id="slide-2"><h2>Two</h2><aside aria-label="Notes">b</aside>'});
  assert.deepEqual(await rulesFor(twoAsides), [], 'every notes aside carries the one notes_label (D161)');
});

test('D65: html-validate changes are deliberate and listed', () => {
  assert.deepEqual(Object.keys(HTML_VALIDATE_RULES).sort(), [
    'long-title',
    'missing-doctype',
    'no-inline-style',
    'no-missing-references',
    'no-trailing-whitespace',
    'prefer-native-element',
    'tel-non-breaking',
    'unique-landmark',
    'valid-id',
  ]);
  assert.equal(HTML_VALIDATE_RULES['no-inline-style'], 'off', 'papeleria/resources holds inline styles to an allowlist instead');
});

test('R08: malformed markup, a missing doctype and any other inline style fail', async () => {
  assert.ok((await rulesFor(page({body: '<p><div>block in a paragraph</div></p>'}))).length > 0);
  assert.ok((await rulesFor(page({body: '<span>unclosed'}))).length > 0);
  assert.deepEqual(await rulesFor(page().replace('<!DOCTYPE html>\n', '')), ['missing-doctype@1']);
  assert.deepEqual(await rulesFor(page({body: '<p style="color:red">x</p>'})), [`papeleria/resources@${BODY_LINE}`], 'one finding, not two');
  assert.ok((await rulesFor(page({body: '<p aria-labelledby="nowhere">x</p>'}))).includes(`no-missing-references@${BODY_LINE}`));
});

test('R08 / C22: exactly the template’s one classic script, from its file, and nothing else executable', async () => {
  assert.deepEqual(await rulesFor(page({head: '<script src="deck.js" defer></script>'})), ['papeleria/scripts@3'], 'two scripts');
  assert.ok((await rulesFor(page({body: '<script>alert(1)</script>'}))).includes(`papeleria/scripts@${BODY_LINE}`), 'inline code');
  assert.ok((await rulesFor(page({head: '<script type="module" src="deck.js"></script>'}))).includes(`papeleria/scripts@${HEAD_LINE}`), 'a module');
  assert.ok((await rulesFor(page().replace('src="deck.js"', 'src="other.js"'))).some((rule) => rule.startsWith('papeleria/scripts')), 'a different file');
  assert.deepEqual(await rulesFor(page().replace('<script src="deck.js" defer></script>', '')), ['papeleria/scripts@3'], 'none at all');
  assert.deepEqual(await rulesFor(page().replace('<script src="deck.js" defer></script>', ''), null), [], 'a document has none (C22)');
});

test('R08 / IC02: a JSON block with a raw <, >, &, U+2028 or U+2029 fails, as does one that is not JSON', async () => {
  const withJson = (json: string) => page().replace('{"skip":"Skip \\u003cto\\u003e content"}', json);
  for (const raw of ['<', '>', '&', String.fromCharCode(0x2028), String.fromCharCode(0x2029)]) {
    assert.ok((await rulesFor(withJson(`{"skip":"a${raw}b"}`))).includes('papeleria/scripts@9'), JSON.stringify(raw));
  }
  assert.ok((await rulesFor(withJson('{"skip":'))).includes('papeleria/scripts@9'));
});

test('R08 / C24: every automatically loaded resource is a relative URL to a file the output holds', async () => {
  const cases: [string, string][] = [
    ['<img src="https://example.com/a.png" alt="">', 'scheme'],
    ['<img src="//example.com/a.png" alt="">', 'protocol-relative'],
    ['<img src="/assets/images/a.800.webp" alt="">', 'root-absolute'],
    ['<img src="assets/images/missing.webp" alt="">', 'absent file'],
    ['<img src="assets/images/a.800.webp" srcset="assets/images/a.800.webp 800w, data:image/png;base64,AA 2x" alt="">', 'data URL in srcset'],
    ['<img src="../outside.webp" alt="">', 'outside the output'],
    ['<video src="assets/video/a.mp4" poster="assets/images/a.800.webp"></video>', 'absent video'],
  ];
  for (const [body, label] of cases) {
    assert.ok((await rulesFor(page({body}))).some((rule) => rule.startsWith('papeleria/resources')), label);
  }
  const links: [string, string][] = [
    ['<link rel="preload" href="deck.js" as="script">', 'preload'],
    ['<link rel="prefetch" href="theme/css/site.css">', 'prefetch'],
    ['<link rel="stylesheet" href="https://fonts.example.com/a.css">', 'remote stylesheet'],
    ['<meta http-equiv="refresh" content="0;url=https://example.com">', 'refresh'],
    ['<base href="https://example.com/">', 'base'],
    ['<style>body{}</style>', 'style element'],
  ];
  for (const [head, label] of links) {
    assert.ok((await rulesFor(page({head}))).some((rule) => rule.startsWith('papeleria/resources')), label);
  }
  const elements: [string, string][] = [
    ['<iframe src="assets/a.html" title="x"></iframe>', 'iframe'],
    ['<form action="https://example.com/"><button type="submit">Go</button></form>', 'form'],
    ['<object data="a.pdf" aria-label="x"></object>', 'object'],
    ['<p onclick="alert(1)">x</p>', 'inline handler'],
    ['<p style="background:url(https://example.com/x.png)">x</p>', 'style url()'],
    ['<a href="https://example.com/" ping="https://example.com/track">x</a>', 'ping'],
  ];
  for (const [body, label] of elements) {
    assert.ok((await rulesFor(page({body}))).some((rule) => rule.startsWith('papeleria/resources')), label);
  }
});

test('R08 / IC02: navigation outside the scheme allowlist fails, and a new browsing context needs noopener noreferrer', async () => {
  for (const href of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', '//example.com/', 'blob:https://example.com/x', 'vbscript:x']) {
    assert.ok((await rulesFor(page({body: `<p><a href="${href}">x</a></p>`}))).some((rule) => rule.startsWith('papeleria/navigation')), href);
  }
  assert.ok((await rulesFor(page({body: '<p><a href="https://example.com/" target="_blank">x</a></p>'}))).some((rule) => rule.startsWith('papeleria/navigation')));
  assert.deepEqual(await rulesFor(page({body: '<p><a href="https://example.com/" target="_blank" rel="noopener noreferrer">x</a></p>'})), []);
  // A relative link must also name a file the output holds (D172).
  const allowed = await validatePage(page({body: '<p><a href="tel:+34 600 000 000">x</a> <a href="notes.html#a">y</a></p>'}), {files: [...FILES, 'notes.html'], script: 'deck.js'});
  assert.deepEqual(allowed, []);
});

test('D172: a relative link is read as a browser reads it from the page at the output’s root', () => {
  const inside = (path: string | null, fragment: string | null = null) => ({kind: 'inside', path, fragment});
  const cases: [string, unknown][] = [
    ['#part', inside(null, 'part')],
    [' #part\n', inside(null, 'part')],
    ['?view=all', inside(null)],
    ['', inside(null)],
    ['index.html', inside('index.html')],
    ['./a.html', inside('a.html')],
    ['sub/a.html?view=all#part', inside('sub/a.html', 'part')],
    ['sub//a.html', inside('sub/a.html')],
    ['sub\\a.html', inside('sub/a.html')],
    ['sub/../a%20b.html', inside('a b.html')],
    // A separator written encoded stays in its segment, as the browser asks for it: it names no nested file.
    ['theme%2Fcss%2Fsite.css', inside('theme%2Fcss%2Fsite.css')],
    ['theme%5Ccss%5Csite.css', inside('theme%5Ccss%5Csite.css')],
    ['sub%2F..%2Fa.html', inside('sub%2F..%2Fa.html')],
    ['./', {kind: 'folder', path: ''}],
    ['.', {kind: 'folder', path: ''}],
    ['sub/', {kind: 'folder', path: 'sub'}],
    ['sub/..', {kind: 'folder', path: ''}],
    ['sub/%2E', {kind: 'folder', path: 'sub'}],
    ['../other-piece/', {kind: 'outside'}],
    ['%2e%2e/other.html', {kind: 'outside'}],
    ['sub/../../other.html', {kind: 'outside'}],
    ['../dist/index.html', {kind: 'outside'}],
    ['https://example.com/', null],
    ['mailto:a@example.com', null],
    ['tel:+15551234567', null],
    ['javascript:alert(1)', null],
    ['/about', null],
    ['//example.com/', null],
  ];
  for (const [href, target] of cases) {
    assert.deepEqual(resolveLinkTarget(href), target, JSON.stringify(href));
  }
});

test('PRR-06 (D172): an empty segment is kept until the path is resolved, as the browser keeps it, so a `..` after `//` takes it away', async () => {
  const inside = (path: string | null, fragment: string | null = null) => ({kind: 'inside', path, fragment});
  assert.deepEqual(resolveLinkTarget('theme//../deck.js'), inside('theme/deck.js'));
  assert.deepEqual(resolveLinkTarget('.//../notes.html'), inside('notes.html'));
  assert.deepEqual(resolveLinkTarget('x//../index.html#nowhere'), inside('x/index.html', 'nowhere'));
  assert.deepEqual(resolveLinkTarget('a//../../f.html'), inside('f.html'));
  assert.deepEqual(resolveLinkTarget('sub//..'), {kind: 'folder', path: 'sub'});
  assert.deepEqual(resolveLinkTarget('.//../..'), {kind: 'outside'});
  // Every path of up to four segments drawn from a name, an empty segment, `.` and `..`, resolved from the page at
  // the output's root as the URL standard resolves it, the algorithm browsers follow.
  const root = 'file:///piece/dist/';
  const parts = ['a', 'b', '', '.', '..'];
  let paths: string[][] = [[]];
  let compared = 0;
  for (let depth = 0; depth < 4; depth += 1) {
    paths = paths.flatMap((path) => parts.map((part) => [...path, part]));
    for (const path of paths) {
      const href = [...path, 'f.html'].join('/');
      if (href.startsWith('/')) {
        continue; // Root- or scheme-relative: not a relative link, and refused before this.
      }
      const {pathname} = new URL(href, `${root}index.html`);
      const expected = pathname.startsWith('/piece/dist/')
        ? inside(pathname.slice('/piece/dist/'.length).split('/').filter((segment) => segment !== '').join('/'))
        : {kind: 'outside'};
      assert.deepEqual(resolveLinkTarget(href), expected, href);
      compared += 1;
    }
  }
  assert.ok(compared > 500, `${compared} paths compared`);
  // At the rule: the file the browser asks for is the one that must exist.
  const targets = async (body: string) =>
    (await validatePage(page({body}), {files: FILES, script: 'deck.js'})).filter((message) => message.rule === 'papeleria/link-targets').map((message) => message.link);
  assert.deepEqual(await targets('<p><a href="theme//../deck.js">a</a> <a href="theme/css//../site.css">b</a></p>'), [{href: 'theme//../deck.js', problem: 'file'}]);
});

test('R08 / D172: a relative link inside the output names a file it holds, never a folder, and a fragment names something on the page', async () => {
  const targets = async (body: string, script: string | null = 'deck.js') =>
    (await validatePage(page({body}), {files: FILES, script}))
      .filter((message) => message.rule === 'papeleria/link-targets')
      .map((message) => [message.line, message.message, message.link]);
  // The page's ids, its top, files the output holds, a fragment of another file, and every link out of the output.
  const leadSomewhere = [
    '#slide-1',
    '#',
    '#TOP',
    'index.html#title-1',
    '?view=all#slide-1',
    'deck.js',
    'theme/css/site.css#part',
    '../other-piece/',
    '../../other.html',
  ];
  assert.deepEqual(await targets(`<p>${leadSomewhere.map((href) => `<a href="${href}">x</a>`).join(' ')}</p>`), []);
  // theme/css/site.css is in the output, but a browser asks for one file named `theme%2Fcss%2Fsite.css`.
  assert.deepEqual(await targets('<p><a href="theme%2Fcss%2Fsite.css">a</a></p>'), [
    [BODY_LINE, 'The link "theme%2Fcss%2Fsite.css" names a file the output does not have', {href: 'theme%2Fcss%2Fsite.css', problem: 'file'}],
  ]);
  assert.deepEqual(await targets('<p><a href="notes.html">a</a> <a href="index.html#nowhere">b</a> <a href="assets/images/">c</a></p>'), [
    [BODY_LINE, 'The link "notes.html" names a file the output does not have', {href: 'notes.html', problem: 'file'}],
    [BODY_LINE, 'The link "index.html#nowhere" names nothing on the page', {href: 'index.html#nowhere', problem: 'fragment'}],
    [BODY_LINE, 'The link "assets/images/" names a folder, not a file', {href: 'assets/images/', problem: 'folder'}],
  ]);
  // The browser finds an id percent-decoded: a document section's anchor is written encoded.
  assert.deepEqual(await targets('<p><a href="#caf%C3%A9">a</a> <span id="café">b</span></p>'), []);
  // A place the page's script shows: the deck's slide however its number is written, never one past the end.
  assert.deepEqual((await targets('<p><a href="#slide-01">a</a> <a href="#slide-2">b</a></p>')).map(([, , link]) => link), [{href: '#slide-2', problem: 'fragment'}]);
  assert.deepEqual((await targets('<p><a href="#slide-01">a</a></p>', null)).map(([, , link]) => link), [{href: '#slide-01', problem: 'fragment'}], 'only where the deck script reads it');
  // The comic reader's page and panel, which must exist too.
  const comic = '<p id="page-1"><a href="#page-01">a</a> <a href="#page-1-panel-1">b</a> <a href="#page-2">c</a> <a href="#page-1-panel-2">d</a> <button type="button" id="page-1-panel-1">e</button></p>';
  assert.deepEqual((await targets(comic, 'reader.js')).map(([, , link]) => link), [
    {href: '#page-2', problem: 'fragment'},
    {href: '#page-1-panel-2', problem: 'fragment'},
  ]);
});

test('R08: a stylesheet may load nothing but relative files the output holds, and never imports', () => {
  const files = new Set(['theme/css/site.css', 'theme/fonts/inter.woff2', 'theme/marks/a.svg']);
  assert.deepEqual(scanStylesheet("@font-face{src:url('../fonts/inter.woff2') format('woff2')}\n.a{background:url(../marks/a.svg)}", 'theme/css/site.css', files), []);
  const messages = scanStylesheet(
    "@import 'other.css';\n.a{background:url(\"https://example.com/x.png\")}\n.b{background:url(../fonts/missing.woff2)}\n.c{background:url(/abs.png)}",
    'theme/css/site.css',
    files,
  );
  assert.deepEqual(
    messages.map((message) => [message.line, message.column, message.message.replace(/ ".*" /, ' ')]),
    [
      [1, 1, 'A stylesheet imports another; published stylesheets load nothing by themselves'],
      [2, 15, 'The stylesheet URL names a scheme, so it loads from outside the piece'],
      [3, 15, 'The stylesheet URL names a file the output does not have'],
      [4, 15, 'The stylesheet URL is absolute, so it breaks when the piece opens from another folder'],
    ],
  );
});

test('an output URL resolves inside the output folder or says why it cannot', () => {
  assert.deepEqual(resolveOutputUrl('assets/images/a%20b.webp', ''), {path: 'assets/images/a b.webp'});
  assert.deepEqual(resolveOutputUrl('../fonts/a.woff2', 'theme/css'), {path: 'theme/fonts/a.woff2'});
  assert.deepEqual(resolveOutputUrl('./a/./b', ''), {path: 'a/b'});
  for (const [url, problem] of [
    ['', 'is empty'],
    ['https://example.com', 'names a scheme'],
    ['/a', 'is absolute'],
    ['\\a', 'is absolute'],
    ['a?b', 'has a query'],
    ['a#b', 'has a query'],
    ['../a', 'leaves the output folder'],
    ['%E0%A4%A', 'is not a valid URL path'],
  ] as const) {
    const resolved = resolveOutputUrl(url, '');
    assert.ok('problem' in resolved && resolved.problem.startsWith(problem), `${url}: ${JSON.stringify(resolved)}`);
  }
});

test('D65: an attribute is read as a browser reads it, and a reference the generator never writes is refused', async () => {
  assert.equal(decodeAttribute('a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39; &apos;f&apos; &#106;&#x6A;'), `a & b <c> "d" 'e' 'f' jj`);
  for (const raw of ['javascript&colon;x', '&nbsp;', 'a & b', '&#0;', '&#xD800;', '&#1114112;', '&amp']) {
    assert.equal(decodeAttribute(raw), null, raw);
  }
  const encoded = await rulesFor(page({body: '<p><a href="&#106;avascript:alert(1)">x</a></p>'}));
  assert.ok(encoded.includes(`papeleria/navigation@${BODY_LINE}`), `a numeric reference is decoded first: ${encoded.join(', ')}`);
  const named = await rulesFor(page({body: '<p><a href="javascript&colon;alert(1)">x</a></p>'}));
  assert.ok(named.includes(`papeleria/references@${BODY_LINE}`), named.join(', '));
  const loaded = await rulesFor(page({body: '<img src="&#104;ttps://example.com/a.png" alt="">'}));
  assert.ok(loaded.includes(`papeleria/resources@${BODY_LINE}`), loaded.join(', '));
});

test('D65: inline, only a swatch colour, a focal point and a table cell alignment are written, value and all', async () => {
  assert.deepEqual(unexpectedDeclarations('background:#0f766e'), []);
  assert.deepEqual(unexpectedDeclarations('object-position:33.333333333333336% 1e-7%'), []);
  assert.deepEqual(unexpectedDeclarations('text-align:center; '), []);
  for (const style of [
    "background:image-set('https://example.com/x.png' 1x)",
    'background:u\\72l(https://example.com/x.png)',
    'background:url(assets/images/a.800.webp)',
    'background:#0f766e;color:red',
    'object-position:left top',
    'text-align:justify',
  ]) {
    assert.ok(unexpectedDeclarations(style).length > 0, style);
    assert.ok((await rulesFor(page({body: `<p style="${style.replaceAll('"', '&quot;')}">x</p>`}))).includes(`papeleria/resources@${BODY_LINE}`), style);
  }
});

test('D65: every inline SVG is read as XML: a drawn chart passes, anything that runs, links or loads fails', async () => {
  for (const fixture of positiveFixtures()) {
    const svg = renderChart(fixture.input).svg!;
    assert.deepEqual(scanInlineSvg(`<figure>${svg}</figure>`), [], fixture.name);
  }
  const svg = (inner: string, attributes = '') => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"${attributes}>${inner}</svg>`;
  const refused: [string, RegExp][] = [
    [svg('<script>alert(1)</script>'), /<script>/],
    [svg('<foreignObject><iframe src="https://example.com"/></foreignObject>'), /<foreignObject>/],
    [svg('<image href="https://example.com/x.png"/>'), /<image>/],
    [svg('<a href="javascript:alert(1)"><text>x</text></a>'), /<a>/],
    [svg('<g onclick="alert(1)"/>'), /onclick attribute, which runs code/],
    [svg('<rect style="fill:red" width="1" height="1"/>'), /a style attribute/],
    [svg('<rect fill="url(https://example.com/x.svg#a)" width="1" height="1"/>'), /url\(\)/],
    [svg('<g/>', ' xmlns:xlink="http://www.w3.org/1999/xlink"'), /namespace declaration xmlns:xlink/],
    [svg('<text>unclosed'), /not well-formed XML/],
  ];
  for (const [markup, pattern] of refused) {
    const messages = scanInlineSvg(`<p>before</p>\n<figure>${markup}</figure>`);
    assert.ok(messages.length > 0 && messages.every((message) => message.rule === 'papeleria/svg' && message.line === 2), markup);
    assert.ok(messages.some((message) => pattern.test(message.message)), `${markup}: ${messages.map((message) => message.message).join(' | ')}`);
  }
  assert.deepEqual(scanInlineSvg(svg('<defs><linearGradient id="g"><stop offset="0"/></linearGradient></defs><rect fill="url(#g)" width="1" height="1"/>')), []);
  const inPage = await rulesFor(page({body: svg('<script>fetch("https://example.com")</script>')}));
  assert.ok(inPage.includes(`papeleria/svg@${BODY_LINE}`), `validatePage runs the SVG scan: ${inPage.join(', ')}`);
});

test('D65: valid author Markdown passes: an aligned table and a footnote cited twice', async () => {
  const body = [
    '<table><thead><tr><th style="text-align:left">a</th><th style="text-align:right">b</th></tr></thead><tbody><tr><td style="text-align:left">1</td><td style="text-align:right">2</td></tr></tbody></table>',
    '<p>A<sup class="footnote-ref"><a href="#fn-n-1" id="fnref-n-1">[1]</a></sup> again<sup class="footnote-ref"><a href="#fn-n-1" id="fnref-n-1:1">[1:1]</a></sup>.</p>',
    '<ol><li id="fn-n-1"><p>Note. <a href="#fnref-n-1">↩</a> <a href="#fnref-n-1:1">↩</a></p></li></ol>',
  ].join('');
  assert.deepEqual(await rulesFor(page({body})), []);
});
