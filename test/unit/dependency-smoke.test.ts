/**
 * M0.1 / DEP01: every author-runtime dependency loads on this Node version.
 *
 * `codemirror-json-schema` is the one exception and is covered separately: its
 * published ESM build uses extensionless relative specifiers that Node's ESM
 * loader rejects, and its CJS build is shadowed by the package's own
 * `"type": "module"`. Its documented scope in docs/DEPENDENCIES.md is an
 * editor-bundle build input, so the test proves the esbuild path instead (D25).
 */
import assert from 'node:assert/strict';
import {test} from 'node:test';

import ajv2020Module from 'ajv/dist/2020.js';
import ajvFormatsModule from 'ajv-formats';
import MarkdownIt from 'markdown-it';
import footnote from 'markdown-it-footnote';
import sharp from 'sharp';
import {parseDocument} from 'yaml';
import {csvParseRows} from 'd3-dsv';
import {parseFile} from 'music-metadata';
import {SaxesParser} from 'saxes';
import {HtmlValidate} from 'html-validate';
import * as esbuild from 'esbuild';

import {applicationRoot} from '../helpers/paths.js';

// ajv and ajv-formats are CommonJS packages whose runtime `module.exports` is
// the class/function itself while their declaration files describe a namespace.
// Node hands the ES importer `module.exports`, so the cast matches runtime (D26).
const Ajv2020 = ajv2020Module as unknown as typeof ajv2020Module.default;
const addFormats = ajvFormatsModule as unknown as typeof ajvFormatsModule.default;

const nodeLoadableRuntimeDependencies = [
  'yaml',
  'ajv',
  'ajv-formats',
  'markdown-it',
  'markdown-it-footnote',
  'd3-array',
  'd3-dsv',
  'd3-format',
  'd3-scale',
  'd3-shape',
  'd3-time-format',
  'saxes',
  'music-metadata',
  'sharp',
  'html-validate',
  'codemirror',
  '@codemirror/state',
  '@codemirror/view',
  '@codemirror/language',
  '@codemirror/commands',
  '@codemirror/autocomplete',
  '@codemirror/lint',
  '@codemirror/lang-json',
  '@codemirror/lang-yaml',
  '@lezer/common',
  '@lezer/highlight',
] as const;

for (const specifier of nodeLoadableRuntimeDependencies) {
  test(`imports ${specifier}`, async () => {
    const loaded: Record<string, unknown> = await import(specifier);
    assert.ok(Object.keys(loaded).length > 0, `${specifier} exported nothing`);
  });
}

test('named entry points used by later milestones exist', () => {
  assert.equal(typeof parseDocument, 'function');
  assert.equal(typeof csvParseRows, 'function');
  assert.equal(typeof parseFile, 'function');
  assert.equal(typeof SaxesParser, 'function');
  assert.equal(typeof HtmlValidate, 'function');
});

test('Ajv compiles a 2020-12 schema with formats registered', () => {
  const ajv = new Ajv2020({strict: true});
  addFormats(ajv);
  const validate = ajv.compile({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: {when: {type: 'string', format: 'date'}},
    required: ['when'],
    additionalProperties: false,
  });
  assert.equal(validate({when: '2026-09-22'}), true);
  assert.equal(validate({when: 'not a date'}), false);
});

test('markdown-it renders with the footnote plugin and raw HTML disabled', () => {
  const md = new MarkdownIt({html: false}).use(footnote);
  const rendered = md.render('A claim.[^1]\n\n[^1]: The source.\n\n<script>bad()</script>');
  assert.match(rendered, /footnote/);
  assert.ok(!rendered.includes('<script>'), 'raw HTML must be escaped, not executed');
});

test('sharp reports a working libvips and WebP support', () => {
  const formats = sharp.format;
  assert.ok(formats.webp.output.buffer, 'WebP output is required (IC04)');
  assert.equal(typeof sharp.versions.vips, 'string');
});

test('codemirror-json-schema resolves through the esbuild editor bundle path', async () => {
  const result = await esbuild.build({
    stdin: {
      contents: [
        "import {jsonSchema} from 'codemirror-json-schema';",
        "import {yamlSchema} from 'codemirror-json-schema/yaml';",
        'export const probe = [typeof jsonSchema, typeof yamlSchema];',
      ].join('\n'),
      resolveDir: applicationRoot,
      loader: 'js',
    },
    bundle: true,
    format: 'iife',
    write: false,
    logLevel: 'silent',
  });
  assert.equal(result.errors.length, 0);
  assert.ok((result.outputFiles?.[0]?.contents.length ?? 0) > 0);
});
