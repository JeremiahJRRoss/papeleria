/**
 * M0.7: the repository-root workflow is valid and runs exactly the suites that
 * exist. The application root is the repository root, so no step changes
 * directory. Whether the workflow's active and pending lists match the
 * acceptance matrix was checked here while the matrix lived beside the
 * application; the matrix stays in the development record, Dev_Papeleria.
 *
 * M1.6 adds the `browser` job (D51): the only place browser binaries are
 * downloaded, running every engine with nothing to narrow the list. M1.8
 * adds the tarball proof to `scaffold` (D68). W2B activates the rest of M1
 * (D72, D74): the deck examples in `scaffold`, and the A4 golden, visual and
 * first-view suites in `browser`, whose failed captures are kept; only deck
 * print verification stays pending, for M3.6. W3A activates M2 with no new
 * job: the server suites run in `npm test` and the editor suites in
 * `browser`; only A10's human sessions stay pending. W3B activates M3 with no
 * new job: the document, video and report suites run in `npm test`, and the
 * document and print suites in `browser`, after a step installing
 * poppler-utils (D91); deck print verification (M3.6) closes M1, and only
 * A6's human reading of the PDFs stays pending. W4 activates M4 with no new
 * job: the comic renderer, rules, reader bundle, sample and `new comic` run
 * in `npm test`, the sample comic in `npm run examples` and the tarball
 * proof, and the reader, accessibility, grid, motion and comic print suites
 * in `browser`; only A13's screen-reader sessions stay pending. W5D activates
 * M5 with no new job (D138): `npm run examples` checks before it builds, the
 * tarball proof checks and builds the four examples with the installed CLI,
 * and the release smoke drives the installed package in `browser`. The
 * pending list is now exactly the human gates, and the publication gate runs
 * in front of `npm publish`, never in a job (D137).
 */
import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';

import {parse} from 'yaml';

import {applicationRoot} from '../helpers/paths.js';

const workflowPath = join(applicationRoot, '.github', 'workflows', 'ci.yml');
const workflowText = readFileSync(workflowPath, 'utf8');

type Step = {name?: string; uses?: string; run?: string; if?: string; with?: Record<string, string | number>; env?: Record<string, string>};
type Workflow = {
  name: string;
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  defaults?: {run?: {'working-directory'?: string}};
  jobs: Record<string, {'runs-on': string; env?: Record<string, string>; steps: Step[]}>;
};

const workflow = parse(workflowText) as Workflow;
const job = workflow.jobs['scaffold']!;
const runSteps = job.steps.filter((step) => typeof step.run === 'string');
const allRunText = runSteps.map((step) => step.run).join('\n');
const browserJob = workflow.jobs['browser'];

test('the workflow is valid YAML with the required triggers and root', () => {
  assert.equal(typeof workflow.name, 'string');
  assert.ok(Object.hasOwn(workflow.on, 'push'), 'must trigger on push');
  assert.ok(Object.hasOwn(workflow.on, 'pull_request'), 'must trigger on pull_request');
  assert.equal(workflow.defaults?.run?.['working-directory'], undefined, 'the application root is the repository root: no default working directory');
  assert.equal(workflow.permissions['contents'], 'read');
});

test('each job runs on ubuntu-latest with Node 22 and an npm cache', () => {
  for (const [name, each] of Object.entries(workflow.jobs)) {
    assert.equal(each['runs-on'], 'ubuntu-latest', name);
    const setupNode = each.steps.find((step) => step.uses?.startsWith('actions/setup-node'));
    assert.ok(setupNode, `setup-node is missing from ${name}`);
    assert.match(String(setupNode.with?.['node-version']), /^22/);
    assert.equal(setupNode.with?.['cache'], 'npm');
    assert.equal(setupNode.with?.['cache-dependency-path'], 'package-lock.json');
    assert.ok(each.steps.some((step) => step.uses?.startsWith('actions/checkout')), `checkout is missing from ${name}`);
  }
});

test('every M0 check the package defines is invoked, and nothing else', () => {
  const packageScripts = JSON.parse(readFileSync(join(applicationRoot, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  const expected = ['npm ci', 'npm run typecheck', 'npm run build', 'npm test',
    'npm run check:licenses', 'npm run check:brand', 'npm run check:strings', 'npm run check:schema-defs'];
  for (const command of expected) {
    assert.ok(allRunText.includes(command), `the workflow never runs ${command}`);
  }
  // Every check the package defines runs here, with one stated exception: the
  // release gate fails by design while the libvips obligations are open, so it
  // belongs in front of publication rather than on every commit.
  const notRunInCi = new Set(['check:licenses:release']);
  for (const name of Object.keys(packageScripts.scripts)) {
    if (name.startsWith('check:') && !notRunInCi.has(name)) {
      assert.ok(allRunText.includes(`npm run ${name}`), `${name} exists but CI never runs it`);
    }
  }
  for (const name of notRunInCi) {
    assert.ok(packageScripts.scripts[name], `${name} must exist even though CI does not run it`);
    assert.ok(!allRunText.includes(`npm run ${name}`), `${name} must not run on every commit`);
    assert.ok(
      workflowText.includes(name),
      `${name} must be named in the workflow comment so its absence is deliberate, not forgotten`,
    );
  }
  assert.ok(allRunText.includes('node lib/src/cli/index.js --version'), 'the built CLI is never exercised');
});

test('D137: the publication gate runs in front of npm publish, and nothing in CI publishes', () => {
  const packageJson = JSON.parse(readFileSync(join(applicationRoot, 'package.json'), 'utf8')) as {
    private?: boolean;
    scripts: Record<string, string>;
  };
  assert.equal(packageJson.scripts['prepublishOnly'], 'npm run check:licenses:release', 'npm publish runs the release gate first and stops when it fails');
  assert.equal(packageJson.private, true, 'the package stays private until the owner records otherwise (M0)');
  const executed = Object.values(workflow.jobs).flatMap((each) => each.steps.map((step) => step.run ?? '')).join('\n');
  assert.doesNotMatch(executed, /npm\s+publish|prepublishOnly|--ignore-scripts|npm\s+version|git\s+tag/, 'no job publishes, tags or skips the gate');
  assert.ok(workflowText.includes('prepublishOnly'), 'the workflow comment says where the gate runs');
});

test('M1.8: the scaffold job installs the packed tarball and runs the CLI from it (D68)', () => {
  const packageScripts = JSON.parse(readFileSync(join(applicationRoot, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  assert.equal(packageScripts.scripts['test:package'], 'node --test lib/test/package/tarball.js');
  assert.equal(packageScripts.scripts['pretest:package'], 'npm run build');
  const target = packageScripts.scripts['test:package']!.split(' ').at(-1)!;
  assert.doesNotMatch(target, /\.test\.js$/, 'npm test’s glob must never pick up the test that needs the network');
  const steps = job.steps.map((step) => step.run?.trim());
  const tarball = steps.indexOf('npm run test:package');
  assert.ok(tarball >= 0, 'the tarball proof is missing from the scaffold job');
  assert.ok(tarball > steps.indexOf('npm ci'), 'the tarball proof runs after the locked install');
});

test('the scaffold job downloads no browser (D23)', () => {
  assert.equal(job.env?.['PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD'], '1');
  assert.ok(!/playwright\s+install/i.test(allRunText), 'browsers are installed by the browser job alone (D51)');
});

test('the browser job installs all three engines explicitly and runs every one (D51)', () => {
  assert.ok(browserJob, 'the browser job is missing');
  const steps = browserJob.steps;
  const position = (command: string): number => steps.findIndex((step) => step.run?.trim() === command);
  const install = position('npm ci');
  const browsers = position('npx playwright install --with-deps chromium firefox webkit');
  const suite = position('npm run test:browser');
  assert.ok(install >= 0, 'npm ci is missing');
  assert.equal(steps[install]?.env?.['PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD'], '1', 'npm ci must not fetch browsers itself');
  assert.ok(browsers > install, 'the explicit three-engine install step is missing or out of order');
  assert.ok(suite > browsers, 'npm run test:browser is missing or runs before the browsers are installed');
  const packageScripts = JSON.parse(readFileSync(join(applicationRoot, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  assert.ok(packageScripts.scripts['test:browser'], 'package.json has no test:browser script');
  // Nothing CI executes may narrow the engines or swap in another binary: no
  // workflow, job or step environment and no command sets either variable.
  const executed = JSON.stringify([
    (workflow as {env?: unknown}).env ?? null,
    Object.values(workflow.jobs).map((each) => [each.env ?? null, each.steps.map((step) => [step.env ?? null, step.run ?? null])]),
  ]);
  assert.doesNotMatch(executed, /PAPELERIA_BROWSERS|PAPELERIA_[A-Z]+_EXECUTABLE/);
  // Nor may it swap the committed screenshot baselines for others (D70).
  assert.doesNotMatch(executed, /PAPELERIA_VISUAL_/);
});

test('no later suite is invoked, and none is faked as a skipped job', () => {
  assert.deepEqual(Object.keys(workflow.jobs), ['scaffold', 'browser'], 'M0 has one job and M1.6 adds the browser job');
  for (const forbidden of ['continue-on-error', 'if: false', '|| true', 'exit 0 #']) {
    assert.ok(!workflowText.includes(forbidden), `${forbidden} would turn a real failure green`);
  }
  for (const each of Object.values(workflow.jobs)) {
    assert.ok(!Object.hasOwn(each, 'if'), 'a job may not be switched off by a condition');
    for (const step of each.steps) {
      assert.ok(!Object.hasOwn(step, 'continue-on-error'), 'a check may not be allowed to fail');
      // A condition on a step skips it as quietly as one on its job, with the job still green (W5R-07).
      assert.ok(typeof step.run !== 'string' || !Object.hasOwn(step, 'if'), `the step ${JSON.stringify(step.name)} may not be skipped by a condition`);
    }
  }
  const conditioned = Object.values(workflow.jobs).flatMap((each) => each.steps.filter((step) => Object.hasOwn(step, 'if')));
  assert.deepEqual(
    conditioned.map((step) => [step.uses?.split('@')[0], step.if]),
    [['actions/upload-artifact', 'failure()']],
    'the only condition in the workflow keeps the failed captures',
  );
});

test('M1: the scaffold job builds the implemented examples; the browser job runs the A4 and first-view suites and keeps failed captures', () => {
  const packageScripts = JSON.parse(readFileSync(join(applicationRoot, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  assert.equal(packageScripts.scripts['examples'], 'node scripts/build-examples.mjs');
  assert.equal(packageScripts.scripts['preexamples'], 'npm run build');
  const steps = job.steps.map((step) => step.run?.trim());
  const examples = steps.indexOf('npm run examples');
  assert.ok(examples >= 0, 'the deck examples are not built in the scaffold job');
  assert.ok(examples > steps.indexOf('npm ci'), 'the examples are built after the locked install');

  assert.ok(browserJob, 'the browser job is missing');
  assert.match(String((browserJob as {name?: string}).name), /golden/i, 'the browser job is named for what it runs');
  const glob = packageScripts.scripts['test:browser'] ?? '';
  assert.match(glob, /"lib\/browser-tests\/test\/browser\/\*\*\/\*\.test\.js"/, 'test:browser runs every suite under test/browser/, in subfolders too');
  for (const suite of ['golden/brand-overview.test.ts', 'golden/brand-overview.visual.test.ts', 'first-view.test.ts', 'deck-build.test.ts', 'charts.test.ts', 'deck.test.ts']) {
    assert.ok(existsSync(join(applicationRoot, 'test', 'browser', ...suite.split('/'))), `test/browser/${suite} is missing`);
  }

  const browserSteps = browserJob.steps;
  const suite = browserSteps.findIndex((step) => step.run?.trim() === 'npm run test:browser');
  const keep = browserSteps.findIndex((step) => step.uses?.startsWith('actions/upload-artifact@'));
  assert.ok(keep > suite, 'failed captures are kept after the browser tests run');
  const upload = browserSteps[keep]!;
  assert.equal(upload.if, 'failure()', 'captures are kept only when something failed');
  assert.equal(upload.with?.['path'], 'test-results/');
});

test('M2: npm test holds the server suites, and the browser job runs the editor suites (W3A)', () => {
  for (const suite of ['server-security', 'server-saves', 'server-preview', 'server-cli', 'server-serve']) {
    assert.ok(existsSync(join(applicationRoot, 'test', 'integration', `${suite}.test.ts`)), `test/integration/${suite}.test.ts is missing`);
  }
  for (const suite of ['editor', 'editor-schema', 'editor-timing', 'preview-bridge', 'serve']) {
    assert.ok(existsSync(join(applicationRoot, 'test', 'browser', `${suite}.test.ts`)), `test/browser/${suite}.test.ts is missing`);
  }
});

test('M3: npm test holds the document, video and report suites; the browser job installs poppler-utils and runs the document and print suites (W3B)', () => {
  for (const suite of ['document-render', 'document-blocks', 'document-report', 'document-sample', 'video', 'video-rules', 'print-fixtures']) {
    assert.ok(existsSync(join(applicationRoot, 'test', 'unit', `${suite}.test.ts`)), `test/unit/${suite}.test.ts is missing`);
  }
  assert.ok(existsSync(join(applicationRoot, 'test', 'integration', 'new-document.test.ts')), 'test/integration/new-document.test.ts is missing');
  for (const suite of ['document', 'print-document', 'print-deck']) {
    assert.ok(existsSync(join(applicationRoot, 'test', 'browser', `${suite}.test.ts`)), `test/browser/${suite}.test.ts is missing`);
  }
  assert.ok(existsSync(join(applicationRoot, 'test', 'fixtures', 'print', 'cases.json')), 'the print fixture catalog is missing');
  assert.ok(browserJob, 'the browser job is missing');
  const steps = browserJob.steps;
  const poppler = steps.findIndex((step) => /apt-get install -y --no-install-recommends poppler-utils/.test(step.run ?? ''));
  const suite = steps.findIndex((step) => step.run?.trim() === 'npm run test:browser');
  assert.ok(poppler >= 0, 'no step installs poppler-utils (D91)');
  assert.ok(poppler < suite, 'poppler-utils is installed before the browser suites run');
  assert.equal(steps[suite]?.env?.['PAPELERIA_PRINT_OUT'], 'test-results/print', 'the printed PDFs land where a failed run keeps them');
});

test('M4: npm test holds the comic suites; the examples, the tarball proof and the browser job take the comic with no new job (W4)', () => {
  for (const suite of ['comic-render', 'comic-rules', 'comic-reader-logic', 'comic-reader-bundle', 'comic-preview', 'comic-sample', 'print-fixtures']) {
    assert.ok(existsSync(join(applicationRoot, 'test', 'unit', `${suite}.test.ts`)), `test/unit/${suite}.test.ts is missing`);
  }
  for (const suite of ['comic-build', 'new-comic', 'sample-comic']) {
    assert.ok(existsSync(join(applicationRoot, 'test', 'integration', `${suite}.test.ts`)), `test/integration/${suite}.test.ts is missing`);
  }
  for (const suite of ['comic', 'comic-a11y', 'editor-grid', 'motion', 'print-comic']) {
    assert.ok(existsSync(join(applicationRoot, 'test', 'browser', `${suite}.test.ts`)), `test/browser/${suite}.test.ts is missing`);
  }
  assert.ok(existsSync(join(applicationRoot, 'test', 'fixtures', 'print', 'comic-transcript', 'papeleria.yaml')), 'the comic print case is missing');
  const examples = readFileSync(join(applicationRoot, 'scripts', 'build-examples.mjs'), 'utf8');
  assert.match(examples, /\{name: 'sample-comic', template: 'comic'\}/, 'npm run examples builds the sample comic');
  assert.match(examples, /export const PENDING = \[\];/, 'no example is pending from M4');
  assert.match(readFileSync(join(applicationRoot, 'test', 'package', 'tarball.ts'), 'utf8'), /\['new', 'comic', /, 'the tarball proof makes a comic');
  // The sample's art is bound to one machine and toolchain (D102): its check runs by hand, never in CI.
  assert.doesNotMatch(allRunText, /gen:sample-comic/);
  assert.deepEqual(Object.keys(workflow.jobs), ['scaffold', 'browser'], 'M4 adds no job: the browser job runs every suite under test/browser/');
});

test('M5: examples checked and built, the tarball proof with the four examples, and the release smoke in the browser job, with no new job (W5D)', () => {
  for (const suite of ['unit/user-docs', 'unit/gen-manifest', 'unit/similarity-scan', 'unit/binary-provenance', 'unit/font-audit', 'unit/license-inventory', 'unit/gen-notice', 'integration/output-notices', 'integration/localization', 'integration/withheld', 'browser/localization', 'browser/release-smoke']) {
    assert.ok(existsSync(join(applicationRoot, 'test', `${suite}.test.ts`)), `test/${suite}.test.ts is missing`);
  }
  const examples = readFileSync(join(applicationRoot, 'scripts', 'build-examples.mjs'), 'utf8');
  assert.match(examples, /'check', piece, '--json'/, 'npm run examples checks each example');
  assert.match(examples, /export const ACCEPTED_WARNINGS = \{/, 'every accepted warning is listed with its reason (D139)');
  const tarball = readFileSync(join(applicationRoot, 'test', 'package', 'tarball.ts'), 'utf8');
  assert.match(tarball, /scriptPath\('build-examples\.mjs'\), '--examples', examples, '--cli', installation\.bin/, 'the tarball proof builds the examples with the installed CLI');
  assert.match(tarball, /packAndInstall\(/, 'the tarball proof uses the shared flow');
  assert.match(readFileSync(join(applicationRoot, 'test', 'browser', 'release-smoke.test.ts'), 'utf8'), /packAndInstall\(/, 'the release smoke installs the same way');
  assert.deepEqual(Object.keys(workflow.jobs), ['scaffold', 'browser'], 'M5 adds no job: every suite runs in scaffold or browser');
});
