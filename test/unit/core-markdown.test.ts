/**
 * M1.3: Markdown text fields (IC01, IC02). Raw HTML is escaped and shown, never
 * run; image syntax is refused; links follow the navigation policy; headings
 * are rebased; footnote ids are unique per field.
 */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';

import {classifyLink, markdownDocId, renderInlineMarkdown, renderMarkdown} from '../../src/core/index.js';
import {fixturePath} from '../helpers/paths.js';

function fixture(name: string): string {
  return readFileSync(fixturePath('markdown', name), 'utf8');
}

const options = {baseLevel: 2, docId: '/sections/0/blocks/0/text', externalLinkLabel: 'External link'};

test('raw HTML is escaped as visible text and never becomes markup', () => {
  const result = renderMarkdown(fixture('raw-html.md'), options);
  assert.equal(
    result.html,
    '<p>Raw HTML stays visible: &lt;b&gt;bold?&lt;/b&gt; and &lt;script&gt;alert(1)&lt;/script&gt;.</p>\n' +
      '<p>&lt;div onclick=&quot;alert(2)&quot;&gt;A block of HTML.&lt;/div&gt;</p>\n',
  );
  assert.deepEqual(result.issues, []);
  assert.ok(!/<(?:b|script|div)\b/.test(result.html));
});

test('headings are rebased to the containing hierarchy and stop at h6', () => {
  const result = renderMarkdown(fixture('headings.md'), {...options, baseLevel: 3});
  assert.equal(
    result.html,
    '<h3>Top</h3>\n<p>Text under the top heading.</p>\n<h4>Second</h4>\n<h5>Third</h5>\n<h6>Fourth</h6>\n<h4>Setext heading</h4>\n',
  );
  assert.match(renderMarkdown('# A', {...options, baseLevel: 6}).html, /^<h6>A<\/h6>/);
  assert.throws(() => renderMarkdown('# A', {...options, baseLevel: 7}), /not a heading level/);
});

test('allowed links render as normal anchors; external ones carry a visible mark and the localized hint', () => {
  const result = renderMarkdown(fixture('links.md'), {...options, externalLinkLabel: 'Enlace externo'});
  const firstParagraph = result.html.split('</p>')[0]!;
  assert.equal(
    firstParagraph,
    '<p>An <a href="https://example.com/report" class="link-external">external source<span class="link-external-mark" aria-hidden="true">↗</span><span class="sr-only"> (Enlace externo)</span></a>' +
      ' and a <a href="http://example.com" class="link-external">plain one<span class="link-external-mark" aria-hidden="true">↗</span><span class="sr-only"> (Enlace externo)</span></a>.\n' +
      'Write to <a href="mailto:studio@example.com">the studio</a> or <a href="tel:+15551234567">call</a>.\n' +
      'Go to <a href="other.html">another page</a>, <a href="#hours-by-phase">a section</a> or <a href="../index.html">up</a>.',
  );
  assert.ok(!result.html.includes('target='), 'no link opens a new window, so none needs rel');
});

test('refused links are reported at their source and rendered as their text only', () => {
  const result = renderMarkdown(fixture('links.md'), options);
  const refused = result.html.split('</p>')[1]!;
  assert.equal(
    refused,
    '\n<p>These are refused:\nscript, data and file.\nA protocol-relative and a root-absolute link.\nAn autolink JavaScript:alert(3) and an entity link e.',
  );
  assert.deepEqual(
    result.issues.map((issue) => [issue.kind, issue.line, issue.column, issue.message]),
    // Each link is located where it starts: its [ or, for an autolink, its <.
    [
      ['link', 6, 1, 'The link to javascript:alert(1) uses the javascript: scheme, which is not allowed.'],
      ['link', 6, 32, 'The link to data:text/html,<b>x</b> uses the data: scheme, which is not allowed.'],
      ['link', 6, 68, 'The link to file:///etc/passwd uses the file: scheme, which is not allowed.'],
      ['link', 7, 3, 'The link to //evil.example/x uses a protocol-relative address, which could load from any host.'],
      ['link', 7, 47, 'The link to /about uses an address from the root of the site, which breaks when the piece opens from disk.'],
      ['link', 8, 13, 'The link to JavaScript:alert(3) uses the javascript: scheme, which is not allowed.'],
      // Written with an entity; the link is still located exactly, since its start is recorded as it is parsed.
      ['link', 8, 54, 'The link to javascript:alert(4) uses the javascript: scheme, which is not allowed.'],
    ],
  );
  for (const issue of result.issues) {
    assert.equal(issue.fix, 'Use an https, http, mailto or tel address, a relative link or a #fragment.');
  }
});

test('Markdown image syntax is refused where it is written and never emits an img element', () => {
  const result = renderMarkdown(fixture('images.md'), options);
  assert.equal(result.html, '<p>Some text.</p>\n<p>A picture The pier at dawn in a paragraph.</p>\n<ul>\n<li>A list item with another.</li>\n</ul>\n');
  assert.deepEqual(
    result.issues.map((issue) => [issue.kind, issue.line, issue.column, issue.message, issue.fix]),
    [
      ['image', 3, 11, 'Markdown image syntax is not allowed (assets/images/pier.jpg).', 'Use an image block, which carries the alternative text, credit and rights, instead of Markdown image syntax.'],
      ['image', 5, 20, 'Markdown image syntax is not allowed (assets/images/b.png).', 'Use an image block, which carries the alternative text, credit and rights, instead of Markdown image syntax.'],
    ],
  );
});

test('a footnote inside link text is refused where it is written, and the link renders as its text, never an a inside an a', () => {
  const noted = renderMarkdown('See [the report ^[unaudited]](https://e.com/r).\n', {...options, docId: '/slides/0/notes'});
  assert.deepEqual(noted.issues.map((issue) => [issue.kind, issue.line, issue.column, issue.message, issue.fix]), [
    ['link', 1, 17, 'The link to https://e.com/r has a footnote inside its text.', 'Move the footnote after the link.'],
  ]);
  assert.equal(
    noted.html.split('\n')[0],
    '<p>See the report <sup class="footnote-ref"><a href="#fn-slides-0-notes-1" id="fnref-slides-0-notes-1">[1]</a></sup>.</p>',
  );
  // A link inside the footnote is in the footnote list, not in the outer link.
  const nested = renderMarkdown('[x ^[see [y](https://b)]](other.html)\n', {...options, docId: '/slides/0/notes'});
  assert.deepEqual(nested.issues.map((issue) => [issue.kind, issue.line, issue.column]), [['link', 1, 4]]);
  assert.equal(nested.html.split('\n')[0], '<p>x <sup class="footnote-ref"><a href="#fn-slides-0-notes-1" id="fnref-slides-0-notes-1">[1]</a></sup></p>');
  assert.match(nested.html, /<li id="fn-slides-0-notes-1" class="footnote-item"><p>see <a href="https:\/\/b" class="link-external">y/);
  // A refused link with a footnote in its text reports both.
  const both = renderMarkdown('[a ^[b]](javascript:x)\n', options);
  assert.deepEqual(both.issues.map((issue) => [issue.line, issue.column, issue.message]), [
    [1, 1, 'The link to javascript:x uses the javascript: scheme, which is not allowed.'],
    [1, 4, 'The link to javascript:x has a footnote inside its text.'],
  ]);
});

test('an autolink inside link text is refused where it is written, and the outer link renders as its text, never an a inside an a', () => {
  const external = (href: string) =>
    `<a href="${href}" class="link-external">${href}<span class="link-external-mark" aria-hidden="true">↗</span><span class="sr-only"> (External link)</span></a>`;
  const result = renderMarkdown(fixture('nested-links.md'), options);
  assert.deepEqual(result.issues.map((issue) => [issue.kind, issue.line, issue.column, issue.message, issue.fix]), [
    ['link', 1, 15, 'The link to https://b.example has another link inside its text.', 'Move the inner link out of the link text.'],
    ['link', 3, 15, 'The link to https://b.example has another link inside its text.', 'Move the inner link out of the link text.'],
  ]);
  // The inner link keeps its anchor; the outer one, inline or by reference, is its text.
  assert.equal(result.html, `<p>See the site ${external('https://a.example')}.</p>\n<p>See the site ${external('https://a.example')} as a reference.</p>\n`);
  // A title or lead takes inline links alone, and refuses the same nesting.
  const title = renderInlineMarkdown('See [the site <https://a.example>](https://b.example)', {externalLinkLabel: 'External link'});
  assert.deepEqual(title.issues.map((issue) => [issue.line, issue.column, issue.message]), [[1, 15, 'The link to https://b.example has another link inside its text.']]);
  assert.equal(title.html, `See the site ${external('https://a.example')}`);
});

test('link text that holds a footnote or another link is refused at its bracket in every form, and published as written', () => {
  const footnote = ['Link text cannot hold a footnote, so this link would show as plain text, brackets and address included.', 'Move the footnote after the link.'];
  const link = ['Link text cannot hold another link, so this link would show as plain text, brackets and address included.', 'Move the inner link out of the link text.'];
  const both = [
    'Link text cannot hold a footnote or another link, so this link would show as plain text, brackets and address included.',
    'Move the footnote and the inner link out of the link text.',
  ];
  const result = renderMarkdown(fixture('broken-links.md'), options);
  // markdown-it makes no link of brackets whose text holds a construct that starts with [; the author wrote one.
  assert.deepEqual(result.issues.map((issue) => [issue.kind, issue.line, issue.column, issue.message, issue.fix]), [
    ['link', 1, 1, ...footnote],
    ['link', 3, 1, ...link],
    ['link', 5, 1, ...footnote],
    ['link', 7, 1, ...link],
    ['link', 7, 59, ...both],
  ]);
  // Reported, not repaired: the brackets and the address stay text, and the inner construct keeps its anchor.
  assert.equal(
    result.html.split('\n')[0],
    '<p>[words <sup class="footnote-ref"><a href="#fn-sections-0-blocks-0-text-1" id="fnref-sections-0-blocks-0-text-1">[1]</a></sup>](https://w.example)</p>',
  );
  // Inside an inline footnote and in a title, the bracket is found where it is written.
  const noted = renderMarkdown('Para^[see [a [b](https://i.example)](https://o.example)].\n', options);
  assert.deepEqual(noted.issues.map((issue) => [issue.line, issue.column, issue.message]), [[1, 11, link[0]]]);
  const title = renderInlineMarkdown('[outer [inner](https://i.example)](https://o.example)', {externalLinkLabel: 'x'});
  assert.deepEqual(title.issues.map((issue) => [issue.line, issue.column, issue.message]), [[1, 1, link[0]]]);
});

test('an image or link message shows the address as the author wrote it, not percent-encoded', () => {
  const result = renderMarkdown('![x](assets/images/café.png) [y](javascript:café)\n', options);
  assert.deepEqual(result.issues.map((issue) => issue.message), [
    'Markdown image syntax is not allowed (assets/images/café.png).',
    'The link to javascript:café uses the javascript: scheme, which is not allowed.',
  ]);
});

test('footnote ids carry a per-field prefix so two fields on one page never collide', () => {
  const first = renderMarkdown(fixture('footnotes.md'), {...options, docId: '/slides/0/notes'});
  const second = renderMarkdown(fixture('footnotes.md'), {...options, docId: '/slides/1/notes'});
  assert.match(first.html, /id="fn-slides-0-notes-1"/);
  assert.match(first.html, /href="#fnref-slides-0-notes-2"/);
  const ids = (html: string) => [...html.matchAll(/id="([^"]+)"/g)].map((match) => match[1]);
  const shared = ids(first.html).filter((id) => ids(second.html).includes(id));
  assert.deepEqual(shared, []);
  assert.equal(markdownDocId('/sections/0/blocks/2/text'), 'sections-0-blocks-2-text');
  assert.equal(markdownDocId('///'), 'text');
});

test('a result says whether its HTML carries ids made from the field: only footnotes do', () => {
  assert.equal(renderMarkdown('# Plain\n\nText with a [link](https://example.com).\n', options).fieldIds, false);
  assert.equal(renderMarkdown('A claim.^[A source.]\n', options).fieldIds, true);
  assert.equal(renderMarkdown('A claim.[^1]\n\n[^1]: A source.\n', options).fieldIds, true);
  // A definition nobody references renders nothing, so nothing carries the field.
  assert.equal(renderMarkdown('Text.\n\n[^1]: Unused.\n', options).fieldIds, false);
  assert.equal(renderInlineMarkdown('A title^[not a footnote]', {externalLinkLabel: 'x'}).fieldIds, false);
});

test('footnotes render exactly as markdown-it-footnote renders them, in every form', () => {
  // Recorded with the plugin's own footnote_tail rule before this module replaced it with a linear one.
  assert.equal(
    renderMarkdown(fixture('footnotes.md'), {...options, docId: '/slides/0/notes'}).html,
    '<p>A claim with a source.<sup class="footnote-ref"><a href="#fn-slides-0-notes-1" id="fnref-slides-0-notes-1">[1]</a></sup> And another.<sup class="footnote-ref"><a href="#fn-slides-0-notes-2" id="fnref-slides-0-notes-2">[2]</a></sup></p>\n' +
      '<hr class="footnotes-sep">\n<section class="footnotes">\n<ol class="footnotes-list">\n' +
      '<li id="fn-slides-0-notes-1" class="footnote-item"><p>The first source. <a href="#fnref-slides-0-notes-1" class="footnote-backref">↩︎</a></p>\n</li>\n' +
      '<li id="fn-slides-0-notes-2" class="footnote-item"><p>The second source. <a href="#fnref-slides-0-notes-2" class="footnote-backref">↩︎</a></p>\n</li>\n' +
      '</ol>\n</section>\n',
  );
  assert.equal(
    renderMarkdown(fixture('footnote-forms.md'), {baseLevel: 3, docId: '/slides/0/notes', externalLinkLabel: 'External link'}).html,
    fixture('footnote-forms.html'),
  );
});

test('titles and leads take inline formatting only, with authored line breaks', () => {
  const title = renderInlineMarkdown('Take the color from the mark.\\\nSeparate the meanings.\n', {externalLinkLabel: 'External link'});
  assert.equal(title.html, 'Take the color from the mark.<br>Separate the meanings.');
  const trailing = renderInlineMarkdown('Craft with care.  \nBuild for the *long* view.', {externalLinkLabel: 'External link'});
  assert.equal(trailing.html, 'Craft with care.<br>Build for the <em>long</em> view.');
  // Block syntax is shown literally rather than turned into structure.
  assert.equal(renderInlineMarkdown('# 2026. A year', {externalLinkLabel: 'x'}).html, '# 2026. A year');
  assert.equal(renderInlineMarkdown('- one', {externalLinkLabel: 'x'}).html, '- one');
  const refused = renderInlineMarkdown('See ![x](y.png) and [a](javascript:x)', {externalLinkLabel: 'x'});
  assert.equal(refused.html, 'See x and a');
  assert.deepEqual(refused.issues.map((issue) => [issue.kind, issue.line, issue.column]), [
    ['image', 1, 5],
    ['link', 1, 21],
  ]);
});

test('a title or lead also comes as plain text: its words and code, a space for each line break, no link mark or hint', () => {
  const linked = renderInlineMarkdown('See the [report](https://example.com/r) &amp; *notes*', {externalLinkLabel: 'External link'});
  assert.equal(linked.text, 'See the report & notes');
  assert.match(linked.html, /↗/);
  assert.equal(renderInlineMarkdown('Craft with care.  \nBuild for the *long* view.', {externalLinkLabel: 'x'}).text, 'Craft with care. Build for the long view.');
  assert.equal(renderInlineMarkdown('Take the color from the mark.\\\nSeparate the meanings.\n', {externalLinkLabel: 'x'}).text, 'Take the color from the mark. Separate the meanings.');
  assert.equal(renderInlineMarkdown('Run `npm test` <b>now</b>\nor [never](javascript:x)', {externalLinkLabel: 'x'}).text, 'Run npm test <b>now</b> or never');
});

test('the navigation policy reads a link the way a browser would', () => {
  const allowed: [string, string][] = [
    ['https://example.com', 'external'],
    ['HTTP://example.com', 'external'],
    ['mailto:studio@example.com', 'mail'],
    ['tel:+15551234567', 'phone'],
    ['#page-3', 'fragment'],
    ['other.html', 'relative'],
    ['../index.html', 'relative'],
  ];
  for (const [href, kind] of allowed) {
    assert.deepEqual(classifyLink(href), {ok: true, kind}, href);
  }
  const refused = [
    'javascript:alert(1)',
    ' JavaScript:alert(1)',
    'java\tscript:alert(1)',
    'java\nscript:alert(1)',
    '\u0000javascript:alert(1)',
    'data:text/html,x',
    'blob:https://example.com/x',
    'file:///etc/passwd',
    'ftp://example.com',
    '//evil.example',
    '\\\\evil.example',
    '/\\evil.example',
    '\\/evil.example',
    '/about',
  ];
  for (const href of refused) {
    assert.equal(classifyLink(href).ok, false, JSON.stringify(href));
  }
});

test('a title or lead has no footnotes: ^[...] stays text, with no block markup and no ids', () => {
  for (const title of ['Revenue^[Unaudited]', 'Costs^[Estimated] and [^1]', 'Costs[^1]\n\n[^1]: A note.']) {
    const result = renderInlineMarkdown(title, {externalLinkLabel: 'External link'});
    assert.ok(!/<(?:section|hr|ol|li|p|sup)\b|\bid=/.test(result.html), result.html);
  }
  assert.equal(renderInlineMarkdown('Revenue^[Unaudited]', {externalLinkLabel: 'x'}).html, 'Revenue^[Unaudited]');
  assert.equal(renderInlineMarkdown('Costs[^1]', {externalLinkLabel: 'x'}).html, 'Costs[^1]');
});

test('images and links are located where they are written, in footnotes, containers and around code spans', () => {
  const inFootnote = renderMarkdown('Para one with a note^[see [x](javascript:y)].\n\nPara two.\n\nPara three.\n', options);
  assert.deepEqual(inFootnote.issues.map((issue) => [issue.line, issue.column]), [[1, 27]]);
  const afterCode = renderMarkdown('`![x]` then ![real](a.png)\n', options);
  assert.deepEqual(afterCode.issues.map((issue) => [issue.line, issue.column]), [[1, 13]]);
  const source = [
    '> quote with [bad](javascript:1)',
    '> > nested ![img](a.png)',
    '',
    '- item [b](data:x)',
    '  continued [c](vbscript:1)',
    '',
    '| a | b |',
    '|---|---|',
    '| [x](javascript:1) | [y](javascript:5) |',
    '',
    '# Heading [h](javascript:2) #',
    '',
    '[r]: javascript:3',
    '',
    'Use [ref][r] here.',
    '',
    'Text[^1]',
    '',
    '[^1]: Note with [n](javascript:4).',
    '',
  ].join('\n');
  assert.deepEqual(renderMarkdown(source, options).issues.map((issue) => [issue.kind, issue.line, issue.column]), [
    ['link', 1, 14],
    ['image', 2, 12],
    ['link', 4, 8],
    ['link', 5, 13],
    ['link', 9, 3],
    ['link', 9, 23],
    ['link', 11, 11],
    ['link', 15, 5],
    ['link', 19, 17],
  ]);
  // Cells are matched in order along their row, so a cell whose text appears twice on it is still placed exactly,
  // inside a container and after an escaped pipe too.
  const twice = renderMarkdown('| a | b |\n|---|---|\n| [x](javascript:1) | [x](javascript:1) |\n', options);
  assert.deepEqual(twice.issues.map((issue) => [issue.line, issue.column]), [[3, 3], [3, 23]]);
  const quoted = renderMarkdown('> | > | b |\n> |---|---|\n> | ![>](x.png) | a\\|b [>](javascript:1) |\n', options);
  assert.deepEqual(quoted.issues.map((issue) => [issue.line, issue.column]), [[3, 5], [3, 24]]);
  // The same link text in a later cell is not taken for this one.
  const repeated = renderMarkdown('| a | b | c |\n|---|---|---|\n| x | [y](javascript:1) | [y](javascript:1) z [y](javascript:1) |\n', options);
  assert.deepEqual(repeated.issues.map((issue) => [issue.line, issue.column]), [[3, 7], [3, 27], [3, 47]]);
  // Line breaks of every kind count as markdown-it counts them.
  const breaks = renderMarkdown('a\r\nb [x](javascript:1)\rc ![i](p.png)\n', options);
  assert.deepEqual(breaks.issues.map((issue) => [issue.kind, issue.line, issue.column]), [['link', 2, 3], ['image', 3, 3]]);
});

/** Runs `work` and fails when it takes longer than `budget` milliseconds, a bound far above linear time and far below quadratic. */
function assertLinear(label: string, budget: number, work: () => void): void {
  const started = performance.now();
  work();
  const elapsed = performance.now() - started;
  assert.ok(elapsed < budget, `${label} took ${elapsed.toFixed(0)} ms; the budget is ${budget} ms`);
}

test('rendering time grows linearly with the text, however many issues it has', () => {
  // Each of these took from seconds to minutes when issues were located by searching the text.
  assertLinear('80,000 image lines', 5_000, () => {
    const result = renderMarkdown('![](a)\n'.repeat(80_000), options);
    assert.equal(result.issues.length, 80_000);
    assert.deepEqual([result.issues[79_999]!.line, result.issues[79_999]!.column], [80_000, 1]);
  });
  assertLinear('one paragraph of 40,000 links', 5_000, () => {
    const result = renderMarkdown(`${'[a](b) '.repeat(40_000)}\n`, options);
    assert.equal(result.issues.length, 0);
    assert.equal((result.html.match(/<a /g) ?? []).length, 40_000);
  });
  // Many issues on one line: each searched its whole source line, 40 s for the first two here before the fix.
  assertLinear('20,000 refused links on one line', 5_000, () => {
    const result = renderMarkdown(`${'[a](javascript:x) '.repeat(20_000)}\n`, options);
    assert.equal(result.issues.length, 20_000);
    assert.deepEqual([result.issues[19_999]!.line, result.issues[19_999]!.column], [1, 18 * 19_999 + 1]);
  });
  assertLinear('20,000 refused links on one quoted line', 5_000, () => {
    const result = renderMarkdown(`> ${'[a](javascript:x) '.repeat(20_000)}\n`, options);
    assert.deepEqual([result.issues[19_999]!.line, result.issues[19_999]!.column], [1, 18 * 19_999 + 3]);
  });
  assertLinear('20,000 links broken by the link in their text, on one line', 5_000, () => {
    const result = renderMarkdown(`${'[a [b](c)](d) '.repeat(20_000)}\n`, options);
    assert.deepEqual([result.issues.length, result.issues[19_999]!.column], [20_000, 14 * 19_999 + 1]);
  });
  assertLinear('80,000 open brackets around one link', 5_000, () => {
    const result = renderMarkdown(`${'['.repeat(80_000)}[b](c)${']'.repeat(80_000)}(d)\n`, options);
    assert.deepEqual(result.issues.map((issue) => [issue.line, issue.column]), [[1, 1]]);
  });
  assertLinear('20,000 images on one line', 5_000, () => {
    const result = renderMarkdown(`${'![](a) '.repeat(20_000)}\n`, options);
    assert.deepEqual([result.issues.length, result.issues[19_999]!.column], [20_000, 7 * 19_999 + 1]);
  });
  assertLinear('a table row of 40,000 cells, each with a refused link', 5_000, () => {
    const cells = Array.from({length: 40_000}, (_unused, index) => ` [a${index}](javascript:x) |`);
    const row = `|${cells.join('')}\n`;
    const result = renderMarkdown(`|${' h |'.repeat(40_000)}\n|${'---|'.repeat(40_000)}\n${row}`, options);
    assert.equal(result.issues.length, 40_000);
    assert.deepEqual([result.issues[39_999]!.line, result.issues[39_999]!.column], [3, row.lastIndexOf('[') + 1]);
  });
  // markdown-it-footnote copied the whole token list once per footnote: 15 s for 20,000 here before the fix.
  assertLinear('40,000 inline footnotes', 5_000, () => {
    const result = renderMarkdown(`${'x^[n] '.repeat(40_000)}\n`, options);
    assert.equal((result.html.match(/class="footnote-item"/g) ?? []).length, 40_000);
  });
  assertLinear('40,000 referenced footnotes', 5_000, () => {
    const references = Array.from({length: 40_000}, (_unused, index) => `[^${index}]`).join(' ');
    const definitions = Array.from({length: 40_000}, (_unused, index) => `[^${index}]: n`).join('\n');
    const result = renderMarkdown(`${references}\n\n${definitions}\n`, options);
    assert.equal((result.html.match(/class="footnote-item"/g) ?? []).length, 40_000);
  });
  assertLinear('a title with 80,000 inner spaces', 2_000, () => {
    assert.equal(renderInlineMarkdown(`a${' '.repeat(80_000)}b`, {externalLinkLabel: 'x'}).issues.length, 0);
  });
  assertLinear('a link with 100,000 inner spaces', 2_000, () => {
    assert.deepEqual(classifyLink(`java${' '.repeat(100_000)}x`), {ok: true, kind: 'relative'});
  });
});
