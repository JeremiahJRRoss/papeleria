/**
 * M1.3: the bounded SVG profile (IC02). Every rejected fixture lists the exact
 * problems it must produce, located in the SVG file itself; the valid fixture
 * uses every element and attribute kind the profile allows.
 */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';

import {SVG_ELEMENTS, validateSvg} from '../../src/core/index.js';
import {fixturePath} from '../helpers/paths.js';

type Marker = string | {marker: string; occurrence: number};
type Case = {
  file: string;
  valid?: true;
  width?: number;
  height?: number;
  expect?: {at: Marker; message: string; fix: string}[];
};

const cases = (JSON.parse(readFileSync(fixturePath('svg', 'cases.json'), 'utf8')) as {cases: Case[]}).cases;

function locate(text: string, marker: Marker): {line: number; column: number} {
  const needle = typeof marker === 'string' ? marker : marker.marker;
  const occurrence = typeof marker === 'string' ? 1 : marker.occurrence;
  let offset = -1;
  for (let count = 0; count < occurrence; count += 1) {
    offset = text.indexOf(needle, offset + 1);
    assert.notEqual(offset, -1, `marker ${JSON.stringify(needle)} #${occurrence} is missing`);
  }
  const before = text.slice(0, offset);
  return {line: before.split('\n').length, column: offset - (before.lastIndexOf('\n') + 1) + 1};
}

for (const testCase of cases) {
  test(`svg: ${testCase.file}`, () => {
    const text = readFileSync(fixturePath('svg', testCase.file), 'utf8');
    const result = validateSvg(text);
    if (testCase.valid === true) {
      assert.deepEqual(result, {ok: true, width: testCase.width, height: testCase.height, viewBox: [0, 0, testCase.width, testCase.height]});
      return;
    }
    assert.equal(result.ok, false);
    const expected = (testCase.expect ?? []).map((item) => ({message: item.message, fix: item.fix, ...locate(text, item.at)}));
    assert.deepEqual(result.ok ? [] : result.problems, expected);
  });
}

test('the element allowlist is exactly the IC02 list', () => {
  assert.deepEqual(
    [...SVG_ELEMENTS].sort(),
    [
      'circle', 'clipPath', 'defs', 'desc', 'ellipse', 'g', 'line', 'linearGradient', 'mask', 'path', 'polygon',
      'polyline', 'radialGradient', 'rect', 'stop', 'svg', 'text', 'title', 'tspan',
    ].sort(),
  );
});

test('every rejection has a case, and the valid file uses every allowed element', () => {
  const valid = readFileSync(fixturePath('svg', 'valid.svg'), 'utf8');
  for (const element of SVG_ELEMENTS) {
    assert.ok(valid.includes(`<${element}`), `valid.svg does not use ${element}`);
  }
  assert.ok(cases.filter((testCase) => testCase.valid !== true).length >= 25);
});

test('the viewBox gives the size in whole pixels, and the exact box beside it, for fractional and offset boxes', () => {
  const result = validateSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="-10 5 320.5 200"/>');
  assert.deepEqual(result, {ok: true, width: 321, height: 200, viewBox: [-10, 5, 320.5, 200]});
  // A page exported from a PDF-sized document.
  const page = validateSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 595.28 841.89"/>');
  assert.deepEqual(page, {ok: true, width: 595, height: 842, viewBox: [0, 0, 595.28, 841.89]});
});

test('a viewBox under 1 on a side, or over the image pixel limit, is refused at the viewBox (IC01, D164)', () => {
  const problemsOf = (box: string) => {
    const result = validateSvg(`<svg xmlns="http://www.w3.org/2000/svg"\n  viewBox="${box}"/>`);
    return result.ok ? [] : result.problems.map((problem) => [problem.line, problem.column, problem.message]);
  };
  assert.deepEqual(problemsOf('0 0 0.25 0.5'), [[2, 3, "The viewBox is 0.25 by 0.5; an SVG's size is its viewBox in pixels, at least 1 on each side."]]);
  assert.deepEqual(problemsOf('0 0 1e-7 5'), [[2, 3, "The viewBox is 1e-7 by 5; an SVG's size is its viewBox in pixels, at least 1 on each side."]]);
  const tooLarge = "; an SVG's size is its viewBox in pixels, and images are limited to 100,000,000 pixels.";
  assert.deepEqual(problemsOf('0 0 1e+308 1'), [[2, 3, `The viewBox is 1e+308 by 1${tooLarge}`]]);
  assert.deepEqual(problemsOf('0 0 10000 10001'), [[2, 3, `The viewBox is 10000 by 10001${tooLarge}`]]);
  // The edges themselves are accepted.
  assert.deepEqual(problemsOf('0 0 1 1'), []);
  assert.deepEqual(problemsOf('0 0 10000 10000'), []);
});

test('a very long file of problems lists twenty and counts the rest', () => {
  const rects = Array.from({length: 30}, (_unused, index) => `<rect class="c${index}"/>`).join('\n');
  const result = validateSvg(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1">\n${rects}\n</svg>`);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.problems.length, 20);
    assert.match(result.problems[19]!.message, /\(10 more problems in this file are not listed\.\)$/);
  }
});

test('each DOCTYPE and processing instruction is reported at its own declaration, adjacent ones too', () => {
  const result = validateSvg('<!---->\n<!DOCTYPE a>\n  <!DOCTYPE b><!DOCTYPE c>\n<?p x?><?q y?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>');
  assert.equal(result.ok, false);
  if (!result.ok) {
    const located = result.problems.filter((problem) => !problem.message.includes('not well-formed'));
    assert.deepEqual(located.map((problem) => [problem.line, problem.column, problem.message.slice(0, 21)]), [
      [2, 1, 'The SVG has a DOCTYPE'],
      [3, 3, 'The SVG has a DOCTYPE'],
      [3, 15, 'The SVG has a DOCTYPE'],
      [4, 1, 'The SVG has a <?p ?> '],
      [4, 8, 'The SVG has a <?q ?> '],
    ]);
  }
});

test('CRLF files are located on the same lines', () => {
  const text = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1">\r\n  <rect\r\n    style="x"/>\r\n</svg>\r\n';
  const result = validateSvg(text);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.deepEqual([result.problems[0]!.line, result.problems[0]!.column], [3, 5]);
  }
});

test('a file with no svg element at all is refused without an invented line', () => {
  const result = validateSvg('');
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.problems.some((problem) => problem.message === 'The file has no svg element.' && problem.line === null));
  }
});

test('names that exist on Object.prototype are refused like any other name, never looked up', () => {
  const head = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">';
  const cases: [string, string][] = [
    ['<rect valueOf="x"/>', 'The attribute valueOf is not allowed in an SVG.'],
    ['<rect hasOwnProperty="x"/>', 'The attribute hasOwnProperty is not allowed in an SVG.'],
    ['<rect __proto__="x"/>', 'The attribute __proto__ is not allowed in an SVG.'],
    ['<rect toString="1"/>', 'The attribute toString is not allowed in an SVG.'],
    ['<rect transform="constructor(1)"/>', 'The transform value "constructor(1)" has an invalid constructor().'],
    ['<linearGradient gradientTransform="valueOf(2)"/>', 'The gradientTransform value "valueOf(2)" has an invalid valueOf().'],
    ['<constructor/>', 'The element constructor is not allowed in an SVG.'],
    ['<toString/>', 'The element toString is not allowed in an SVG.'],
  ];
  for (const [body, message] of cases) {
    const result = validateSvg(`${head}${body}</svg>`);
    assert.equal(result.ok, false, body);
    if (!result.ok) {
      assert.deepEqual(result.problems.map((problem) => problem.message), [message], body);
    }
  }
});

test('url() and colours read whitespace as CSS does: space, tab, line feed, carriage return and form feed only', () => {
  const head = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><defs><linearGradient id="g"><stop offset="0" stop-color="red"/></linearGradient></defs>';
  // CSS whitespace around a reference or inside a colour leaves a same-document reference and a colour.
  for (const fill of ['url( #g )', 'url(&#9;#g&#10;)', 'url(&#13;#g)', ' url(#g) ', 'url(#g) &#9;red', 'rgb(1,&#10;2, 3)']) {
    assert.equal(validateSvg(`${head}<rect fill="${fill}"/></svg>`).ok, true, fill);
  }
  // Every other space is part of the value, as it is to a browser: url(<U+00A0>#g) is the relative URL %C2%A0#g.
  for (const fill of ['url(#g&#xA0;)', '&#xA0;url(#g)', 'url(#g)&#xA0;', 'url(#g)&#xA0;red', '&#x3000;none', 'rgb(1,&#xA0;2,3)', '&#xFEFF;red']) {
    const result = validateSvg(`${head}<rect fill="${fill}"/></svg>`);
    assert.equal(result.ok ? 0 : result.problems.length, 1, fill);
  }
  const targets = '<clipPath id="c"><rect width="1" height="1"/></clipPath><mask id="m"><rect width="1" height="1" fill="white"/></mask>';
  const clipAndMask = (clip: string, mask: string) => validateSvg(`${head}${targets}<rect clip-path="${clip}"/><rect mask="${mask}"/></svg>`);
  assert.equal(clipAndMask('url(&#10;#c )', ' url(&#9;#m)').ok, true);
  for (const space of ['&#xA0;', '&#x3000;', '&#x2028;', '&#xFEFF;']) {
    const result = clipAndMask(`url(#c)${space}`, `${space}none`);
    assert.equal(result.ok ? 0 : result.problems.length, 2, space);
  }
});

test('every number, list, path, transform, viewBox and keyword value reads CSS whitespace as spaces, and nothing else (W5R-22)', () => {
  // Tab, line feed and carriage return, written as references so the parser keeps them, and ordinary spaces.
  const svg = (space: string) =>
    [
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${space}0${space}0,100${space}50${space}" preserveAspectRatio="xMidYMid${space}slice">`,
      `<line x1="${space}1${space}" y1="0" x2="10" y2="10" stroke="black"/>`,
      `<rect width="${space}10" height="10" opacity="0.5${space}" stroke="black" stroke-dasharray="1${space}2,${space}3" stroke-linecap="${space}round"/>`,
      `<polyline points="0${space}0,${space}10${space}10" fill="none" stroke="black"/>`,
      `<text x="1${space}2" y="20" font-family="${space}Inter,${space}sans-serif">A</text>`,
      `<path d="${space}M0${space}0${space}L10,10${space}Z" stroke="black"/>`,
      `<g transform="${space}translate(1${space}2)${space}scale(${space}2)${space},${space}rotate(1)"/>`,
      '</svg>',
    ].join('');
  for (const space of [' ', '&#9;', '&#10;', '&#13;', ' &#9;&#10; ']) {
    const result = validateSvg(svg(space));
    assert.deepEqual(result.ok ? null : result.problems.map((problem) => problem.message), null, space);
    assert.deepEqual(result.ok ? result.viewBox : null, [0, 0, 100, 50], space);
  }
  // The four characters JavaScript also counts as spaces are refused in each of those values (fixtures wsp-*.svg).
  for (const space of ['&#xA0;', '&#x3000;', '&#x2028;', '&#xFEFF;']) {
    const result = validateSvg(svg(space));
    assert.equal(result.ok, false, space);
  }
});

/** Runs `work` and fails when it takes longer than `budget` milliseconds, a bound far above linear time and far below quadratic. */
function assertLinear(label: string, budget: number, work: () => void): void {
  const started = performance.now();
  work();
  const elapsed = performance.now() - started;
  assert.ok(elapsed < budget, `${label} took ${elapsed.toFixed(0)} ms; the budget is ${budget} ms`);
}

test('validation time grows linearly with the file, however its bytes are arranged', () => {
  const head = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">';
  // Each of these took seconds to minutes before the grammar and scanning were made linear.
  const attributes = Array.from({length: 32_000}, (_unused, index) => `a${index}="1"`).join(' ');
  assertLinear('32,000 attributes on one element', 2_000, () => {
    const result = validateSvg(`${head}<rect ${attributes}/></svg>`);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.problems.length, 20);
      assert.deepEqual([result.problems[0]!.line, result.problems[0]!.column], [1, 67]);
    }
  });
  assertLinear('a 40,000-digit length', 2_000, () => {
    assert.equal(validateSvg(`${head}<rect x="${'1'.repeat(40_000)}x"/></svg>`).ok, false);
  });
  assertLinear('a colour function with 200,000 spaces', 2_000, () => {
    assert.equal(validateSvg(`${head}<rect fill="rgb(1 ,${' '.repeat(200_000)}, 2 x)"/></svg>`).ok, false);
  });
  assertLinear('40,000 nested groups', 2_000, () => {
    assert.equal(validateSvg(`${head}${'<g>'.repeat(40_000)}${'</g>'.repeat(40_000)}</svg>`).ok, true);
  });
  // Each DOCTYPE was located by searching from the start of the file: 20 s before the fix, under 1 s after.
  assertLinear('60,000 DOCTYPEs after an 8 MB comment', 4_000, () => {
    const result = validateSvg(`<!--${' '.repeat(8_000_000)}-->${'<!DOCTYPE a>'.repeat(60_000)}${head}</svg>`);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.problems.length, 20);
      assert.deepEqual([result.problems[0]!.column, result.problems[2]!.column], [8_000_008, 8_000_020]);
      // One report per DOCTYPE, and saxes' own error for each after the first.
      assert.match(result.problems[19]!.message, /\(119979 more problems in this file are not listed\.\)$/);
    }
  });
});

test('namespaces are tracked per element without the parser namespace mode', () => {
  const inner = validateSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><g xmlns="http://example.com/other"><rect/></g></svg>');
  assert.equal(inner.ok, false);
  if (!inner.ok) {
    assert.deepEqual(inner.problems.map((problem) => problem.message), [
      'The element g is outside the SVG namespace.',
      'The default namespace http://example.com/other is not the SVG namespace.',
      // The rect inherits the other namespace, so it is outside the profile too.
      'The element rect is outside the SVG namespace.',
    ]);
  }
  const redeclared = validateSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><g xmlns="http://www.w3.org/2000/svg"><rect/></g></svg>');
  assert.equal(redeclared.ok, true);
  const unbound = validateSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><x:rect/></svg>');
  assert.equal(unbound.ok, false);
  if (!unbound.ok) {
    assert.deepEqual(unbound.problems.map((problem) => problem.message), ['The element x:rect is outside the SVG namespace.']);
  }
});
