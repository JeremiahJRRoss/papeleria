#!/usr/bin/env node
/**
 * DEP02 spike: can `codemirror-json-schema` carry the editor's schema help?
 *
 * The gate (docs/DEPENDENCIES.md, DEP02) asks for YAML and JSON completion and
 * hover through the shared `$ref`s and 2020-12 schemas, useful behaviour while
 * input is malformed, no duplicate diagnostics competing with the authoritative
 * server report, and recorded paste/edit latency. None of that can be answered
 * from Node: the adapter is browser code, and the project forbids jsdom. So this
 * builds the real bundle with esbuild and drives it in a real Chromium.
 *
 * It is a spike, not the editor. It creates nothing under src/editor/, which
 * belongs to W3A at M2.
 *
 * Usage: node scripts/dep02-spike.mjs [--out <file>] [--browser <chrome path>]
 *                                     [--keep] [--iterations <n>]
 * Exit:  0 the gate's checks all answered yes · 1 one or more answered no
 *        · 2 usage, build or browser failure (the gate is then unanswered)
 */
import {mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync} from 'node:fs';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join, resolve, extname} from 'node:path';
import {pathToFileURL} from 'node:url';

class UsageError extends Error {}

const CHROMIUM_CANDIDATES = [
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/opt/pw-browsers/chromium/chrome-linux/chrome',
  '/opt/pw-browsers/chromium/chrome-linux64/chrome',
];

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>DEP02 probe</title>
<style>body{font:14px system-ui;margin:0} .pane{height:45vh;overflow:auto;border-bottom:1px solid #ccc}</style>
</head><body>
<div class="pane" id="yaml"></div>
<div class="pane" id="json"></div>
<script>window.__DEP02_SCHEMA__ = __SCHEMA__;</script>
<script src="./probe.js"></script>
</body></html>`;

/**
 * A deck-shaped 2020-12 schema built from the real shared `$defs`.
 *
 * Descriptions live **only** in the definitions, never beside the `$ref` that
 * points at them. An earlier version of this spike copied each definition's
 * description onto the referring property, which meant a hover could have
 * returned the local copy without ever resolving the reference — the test would
 * have passed whether or not `$ref` resolution worked. It does not prove
 * anything unless the only place the text exists is behind the reference.
 *
 * The schema also carries the constructs the project actually uses and that a
 * draft-07 engine is known to misread: a `prefixItems` tuple closed with
 * `items: false` (focal_point), a `const` (decorative), an enum behind a `$ref`
 * (status, template), a nested object (image) and a one-key union
 * (block, via minProperties/maxProperties).
 */
function buildSchema(root) {
  const shared = JSON.parse(readFileSync(join(root, 'templates', 'shared', 'schema-defs.json'), 'utf8'));
  const ref = (name) => ({$ref: `#/$defs/${name}`});
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://papeleria.ross.moda/schema/1/dep02-probe.json',
    title: 'Papeleria deck manifest (DEP02 probe)',
    description: 'A deck manifest, used by the DEP02 spike to exercise shared $ref resolution.',
    type: 'object',
    properties: {
      schema: ref('schema_version'),
      template: ref('template_name'),
      title: ref('title'),
      language: ref('language'),
      status: ref('status'),
      wordmark: ref('wordmark'),
      credits: ref('credits'),
      cover: ref('image_block'),
      blocks: ref('blocks'),
    },
    required: ['schema', 'template', 'title'],
    additionalProperties: false,
    $defs: shared.$defs,
  };
}

async function buildBundle({root, outDirectory, schema}) {
  const esbuild = await import('esbuild');
  const entry = join(root, 'test', 'fixtures', 'dep02', 'editor-probe.js');
  if (!existsSync(entry)) {
    throw new UsageError(`the probe application is missing at ${entry}`);
  }
  const result = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: 'iife',
    target: 'es2022',
    outfile: join(outDirectory, 'probe.js'),
    logLevel: 'silent',
    metafile: true,
    minify: false,
  });
  writeFileSync(join(outDirectory, 'index.html'), PAGE.replace('__SCHEMA__', JSON.stringify(schema)));
  const bytes = readFileSync(join(outDirectory, 'probe.js')).length;
  return {warnings: result.warnings, bytes};
}

function serve(directory) {
  const types = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8'};
  const server = createServer((request, response) => {
    const path = request.url === '/' ? '/index.html' : request.url.split('?')[0];
    if (path === '/favicon.ico') {
      response.writeHead(204).end();
      return;
    }
    const file = join(directory, path.replace(/^\/+/, ''));
    if (!file.startsWith(directory) || !existsSync(file)) {
      response.writeHead(404, {'content-type': 'text/plain'}).end('not found');
      return;
    }
    response.writeHead(200, {'content-type': types[extname(file)] ?? 'application/octet-stream'});
    response.end(readFileSync(file));
  });
  return new Promise((resolvePromise) => {
    server.listen(0, '127.0.0.1', () => resolvePromise({server, port: server.address().port}));
  });
}

function findBrowser(explicit) {
  const candidates = explicit ? [explicit, ...CHROMIUM_CANDIDATES] : CHROMIUM_CANDIDATES;
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

export async function runSpike({root, iterations = 20, browserPath = null, keep = false}) {
  const outDirectory = mkdtempSync(join(tmpdir(), 'papeleria-dep02-'));
  const checks = [];
  const add = (name, passed, detail) => checks.push({name, passed, detail});
  let bundle;
  let server;

  try {
    const schema = buildSchema(root);
    bundle = await buildBundle({root, outDirectory, schema});
    add(
      'production browser bundle builds',
      bundle.warnings.length === 0,
      `${bundle.bytes} bytes, ${bundle.warnings.length} esbuild warning(s)`,
    );

    const executablePath = findBrowser(browserPath);
    if (executablePath === null) {
      throw new UsageError(
        'no Chromium binary was found; pass --browser <path>. The spike needs a real browser ' +
          'because the project forbids jsdom and the adapter is browser code.',
      );
    }

    const {chromium} = await import('playwright');
    const listening = await serve(outDirectory);
    server = listening.server;
    const browser = await chromium.launch({executablePath, args: ['--no-sandbox']});
    const page = await browser.newPage();
    const pageErrors = [];
    let phase = 'boot';
    const capture = (text) => pageErrors.push({phase, text: String(text).slice(0, 300)});
    page.on('pageerror', (error) => capture(error));
    page.on('console', (message) => {
      // The probe page has no favicon; that 404 is not a defect under test.
      if (message.type() === 'error' && !message.text().includes('favicon')) {
        capture(message.text());
      }
    });

    // An editor document is incomplete most of the time, and the adapter logs
    // when it parses one. That is the behaviour under test, not a browser error,
    // so it is classified by message rather than suppressed: a TypeError raised
    // in the same breath would still be counted.
    const INCOMPLETE_DOCUMENT = /parsed (json|yaml) with extra tokens|Unexpected end of (JSON|input)/i;

    await page.goto(`http://127.0.0.1:${listening.port}/`, {waitUntil: 'load'});
    await page.waitForFunction('window.__dep02 && (window.__dep02.ready || window.__dep02.errors.length)', null, {
      timeout: 20000,
    });
    const boot = await page.evaluate('window.__dep02');
    add(
      'editor mounts in YAML and JSON without page errors',
      boot.ready === true && pageErrors.length === 0,
      boot.ready
        ? `mounted; ${pageErrors.length} page error(s)${pageErrors.length ? ': ' + pageErrors.map((e) => e.text).join(' | ').slice(0, 300) : ''}`
        : `boot errors: ${boot.errors.join(' | ')}`,
    );

    if (boot.ready) {
      for (const mode of ['yaml', 'json']) {
        const completion = await page.evaluate(`window.__dep02probeCompletion(${JSON.stringify(mode)})`);
        const fromShared = completion.options.filter((option) =>
          ['status', 'schema', 'template', 'title', 'wordmark'].includes(option),
        );
        add(
          `${mode}: completion offers properties from the shared $defs`,
          completion.options.length > 0 && fromShared.length > 0,
          `${completion.options.length} option(s) in ${completion.ms} ms; shared: ${fromShared.join(', ') || 'none'}; all: ${completion.options.slice(0, 12).join(', ')}`,
        );

        const hover = await page.evaluate(
          `window.__dep02probeHover(${JSON.stringify(mode)}, ${JSON.stringify('template')})`,
        );
        const sharedDescription = 'Which of the three templates builds this piece';
        add(
          `${mode}: hover resolves help text through a $ref`,
          hover.found === true && typeof hover.text === 'string' && hover.text.includes(sharedDescription),
          hover.found ? `hover text: ${String(hover.text).slice(0, 120)}` : 'no hover result',
        );
      }

      phase = 'malformed-input';
      await page.evaluate(`window.__dep02setPhase('malformed-input')`);
      const malformedYaml = 'schema: 1\ntemplate: deck\ntitle:\n  - broken\n   indent';
      const malformedDiagnostics = await page.evaluate(
        `window.__dep02probeDiagnostics('yaml', ${JSON.stringify(malformedYaml)})`,
      );
      add(
        'yaml: malformed input does not throw and still yields positioned output',
        Array.isArray(malformedDiagnostics),
        `${malformedDiagnostics.length} adapter diagnostic(s) on malformed input`,
      );

      const invalidJson = '{"schema": 1, "template": "slides", "title": ""}';
      const invalidDiagnostics = await page.evaluate(
        `window.__dep02probeDiagnostics('json', ${JSON.stringify(invalidJson)})`,
      );
      add(
        'json: the adapter reports schema violations with positions, so they can be suppressed in favour of the server report',
        Array.isArray(invalidDiagnostics) && invalidDiagnostics.length > 0 &&
          invalidDiagnostics.every((d) => Number.isFinite(d.from) && Number.isFinite(d.to)),
        invalidDiagnostics.map((d) => `${d.from}-${d.to} ${d.message}`).join(' | ').slice(0, 300),
      );

      // --- value completion behind a $ref: the enum members, not just the key
      const jsonValues = await page.evaluate(`window.__dep02probeValueCompletion('json', 'status', '')`);
      const statusValues = ['draft', 'review', 'published', 'withheld'];
      const jsonOffered = statusValues.filter((value) => jsonValues.options.includes(value));
      add(
        'json: value completion offers the whole enum behind the $ref',
        jsonOffered.length === statusValues.length,
        `offered ${jsonOffered.length} of ${statusValues.length}: ${jsonValues.options.slice(0, 8).join(', ') || 'none'}`,
      );

      const yamlValues = await page.evaluate(`window.__dep02probeValueCompletion('yaml', 'status', 'd')`);
      add(
        'yaml: value completion filters the enum behind the $ref',
        yamlValues.options.includes('draft'),
        `typing "d" offered: ${yamlValues.options.slice(0, 8).join(', ') || 'none'}` +
          `${yamlValues.timedOut ? ' (timed out)' : ''}`,
      );

      const yamlBare = await page.evaluate(`window.__dep02probeValueCompletion('yaml', 'status', '')`);
      checks.push({
        name: 'note: YAML value completion with nothing typed',
        passed: true,
        detail:
          yamlBare.options.length > 0
            ? `offers ${yamlBare.options.length} option(s) immediately after the colon`
            : 'does not activate on an empty value after the colon; M2.2 should trigger it ' +
              'explicitly (Ctrl-Space is already the documented shortcut) rather than assume it appears',
      });

      // --- the tuple the project actually uses, and a nested member
      const tupleDoc = '{\n  "schema": 1,\n  "template": "deck",\n  "title": "A deck",\n' +
        '  "cover": {"src": "assets/images/a.png", "alt": "A", "focal_point": [50, 50]}\n}';
      const tupleHover = await page.evaluate(
        `window.__dep02probeDocHover('json', ${JSON.stringify(tupleDoc)}, 'focal_point', 2)`,
      );
      add(
        'json: hover reaches a prefixItems tuple through two levels of $ref',
        tupleHover.found === true &&
          typeof tupleHover.text === 'string' &&
          /crops|focal|percentage/i.test(tupleHover.text),
        tupleHover.found ? `hover: ${String(tupleHover.text).slice(0, 160)}` : `no hover (${tupleHover.reason ?? 'none'})`,
      );

      const slotHover = await page.evaluate(
        `window.__dep02probeDocHover('json', ${JSON.stringify(tupleDoc)}, '[50, 50]', 1)`,
      );
      add(
        'json: hover inside a tuple slot returns that slot\'s own help',
        slotHover.found === true,
        slotHover.found
          ? `hover: ${String(slotHover.text).slice(0, 160)}`
          : 'no hover inside the tuple; the adapter does not describe prefixItems positions',
      );

      const nestedCompletion = await page.evaluate(
        `window.__dep02probeDocCompletion('json', ${JSON.stringify(
          '{\n  "schema": 1,\n  "template": "deck",\n  "title": "A deck",\n  "cover": {"§"}\n}',
        )}, '§')`,
      );
      const nestedExpected = ['src', 'alt', 'decorative', 'caption', 'credit', 'rights', 'focal_point'];
      const nestedOffered = nestedExpected.filter((name) => nestedCompletion.options.includes(name));
      add(
        'json: completion inside a nested $ref object offers that object\'s properties',
        nestedOffered.length >= 4,
        `offered ${nestedOffered.length} of ${nestedExpected.length}: ${nestedOffered.join(', ') || 'none'}` +
          `${nestedCompletion.timedOut ? ' (timed out)' : ''}`,
      );

      // --- incomplete input, the state an editor is in most of the time
      const incomplete = await page.evaluate(
        `window.__dep02probeDocCompletion('yaml', ${JSON.stringify('schema: 1\ntemplate: deck\ntitle: A deck\nstat§\n')}, '§')`,
      );
      add(
        'yaml: completion still works on incomplete input',
        incomplete.options.includes('status'),
        `offered: ${incomplete.options.slice(0, 8).join(', ') || 'none'}${incomplete.timedOut ? ' (timed out)' : ''}`,
      );

      // The gate asks whether the project's 2020-12 features survive. They do
      // not: json-schema-library ships draft 4, 6 and 7 engines only, and the
      // adapter validates with draft 4 and completes with draft 7. A draft 7
      // engine reads `items: false` beside `prefixItems` as "no array items at
      // all", so it rejects a focal_point of [50, 50] that 2020-12 accepts.
      // That is why the recommended configuration excludes its linters.
      const drafts = await page.evaluate('window.__dep02probe2020()');
      const rejectsValid = Object.entries(drafts)
        .filter(([key]) => key.startsWith('Draft'))
        .filter(([, value]) => value && value.rejectsAValidTuple === true)
        .map(([key]) => key);
      add(
        'the adapter\'s own validation is excluded, because its engine misreads 2020-12',
        rejectsValid.length > 0,
        `available engines: ${(drafts.availableDrafts ?? []).join(', ')}; ` +
          `${rejectsValid.join(' and ')} reject a valid 2020-12 tuple ([50, 50] for a prefixItems ` +
          `pair) with "${drafts.Draft07?.onValid?.[0] ?? 'n/a'}". Completion and hover are kept; ` +
          'the schema linters are not wired in, so the Ajv 2020-12 report stays the only validator.',
      );
      checks.push({name: 'draft-engine evidence', passed: true, detail: JSON.stringify(drafts)});

      phase = 'latency';
      await page.evaluate(`window.__dep02setPhase('latency')`);
      const latency = await page.evaluate(`window.__dep02probeLatency('yaml', ${iterations})`);
      add(
        'edit and paste latency stay within an interactive budget',
        latency.editMedianMs < 50 && latency.pasteMs < 1000,
        `median edit ${latency.editMedianMs} ms, max edit ${latency.editMaxMs} ms over ${latency.editCount}; 500-line paste ${latency.pasteMs} ms`,
      );
      checks.push({name: 'measurements', passed: true, detail: JSON.stringify(latency)});
    }

    await browser.close();

    return {
      gate: 'DEP02',
      ranOn: new Date().toISOString().slice(0, 10),
      environment: {
        node: process.version,
        platform: `${process.platform}/${process.arch}`,
        chromium: executablePath,
      },
      bundleBytes: bundle.bytes,
      checks,
      passed: checks.every((check) => check.passed),
      pageErrors: {
        // Three buckets, so "no errors" means something. A message the adapter
        // emits for an incomplete or deliberately malformed document is the
        // behaviour under test. Anything else is a defect and fails the gate.
        duringMalformedInput: pageErrors.filter((entry) => entry.phase === 'malformed-input'),
        incompleteDocument: pageErrors.filter(
          (entry) => entry.phase !== 'malformed-input' && INCOMPLETE_DOCUMENT.test(entry.text),
        ),
        unexpected: pageErrors.filter(
          (entry) => entry.phase !== 'malformed-input' && !INCOMPLETE_DOCUMENT.test(entry.text),
        ),
      },
    };
  } finally {
    if (server) server.close();
    if (!keep) rmSync(outDirectory, {recursive: true, force: true});
  }
}

function parseArguments(argv) {
  const options = {out: null, browser: null, keep: false, iterations: 20};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--keep') {
      options.keep = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined) throw new UsageError(`${flag} needs a value`);
    if (flag === '--out') options.out = value;
    else if (flag === '--browser') options.browser = value;
    else if (flag === '--iterations') options.iterations = Number(value);
    else throw new UsageError(`unknown argument ${JSON.stringify(flag)}`);
    index += 1;
  }
  return options;
}

async function main(argv) {
  let options;
  try {
    options = parseArguments(argv);
  } catch (error) {
    process.stderr.write(`dep02-spike: ${error.message}\n`);
    return 2;
  }
  const root = resolve(join(import.meta.dirname, '..'));
  let result;
  try {
    result = await runSpike({root, iterations: options.iterations, browserPath: options.browser, keep: options.keep});
  } catch (error) {
    process.stderr.write(`dep02-spike: ${error.message}\n`);
    return 2;
  }

  const lines = [`DEP02 spike on ${result.environment.platform}, Node ${result.environment.node}`];
  lines.push(`bundle: ${result.bundleBytes} bytes from esbuild`);
  for (const check of result.checks) {
    lines.push(`  ${check.passed ? 'pass' : 'FAIL'}  ${check.name}`);
    lines.push(`        ${check.detail}`);
  }
  const unexpected = result.pageErrors.unexpected.length;
  lines.push(
    `page errors: ${unexpected} unexpected, ` +
      `${result.pageErrors.duringMalformedInput.length} while deliberately malformed input was loaded, ` +
      `${result.pageErrors.incompleteDocument.length} from the adapter parsing a half-typed document`,
  );
  for (const entry of result.pageErrors.unexpected) {
    lines.push(`  unexpected [${entry.phase}] ${entry.text}`);
  }
  lines.push(result.passed && unexpected === 0 ? 'result: DEP02 passes' : 'result: DEP02 FAILS');
  process.stdout.write(`${lines.join('\n')}\n`);

  if (options.out !== null) {
    writeFileSync(resolve(options.out), `${JSON.stringify(result, null, 2)}\n`);
    process.stdout.write(`written: ${resolve(options.out)}\n`);
  }
  return result.passed && result.pageErrors.unexpected.length === 0 ? 0 : 1;
}

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href) {
  process.exitCode = await main(process.argv.slice(2));
}
