/**
 * M0.4 / R11: scope-aware SPDX evaluation, licence evidence, exception metadata
 * and the release gate. The native distribution reconciliation has its own
 * suite in native-review.test.ts; these tests deliberately require nothing of it.
 */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after, test} from 'node:test';

import {applicationRoot, fixturePath, runCheckScript} from '../helpers/paths.js';

const temporaryRoots: string[] = [];
after(() => {
  for (const directory of temporaryRoots) {
    rmSync(directory, {recursive: true, force: true});
  }
});

function temporaryRoot(label: string): string {
  const directory = mkdtempSync(join(tmpdir(), `papeleria-licence-${label}-`));
  temporaryRoots.push(directory);
  return directory;
}

const licenceTree = (name: string): string => fixturePath('license', name);

/** A minimal installed tree: one package, optionally with a licence file. */
function miniTree(
  label: string,
  pkg: {name: string; version: string; license?: string | null; licenseFile?: {name: string; text: string}},
): string {
  const root = temporaryRoot(label);
  const directory = join(root, 'node_modules', pkg.name);
  mkdirSync(directory, {recursive: true});
  const lockEntry: Record<string, unknown> = {version: pkg.version};
  if (pkg.license) lockEntry['license'] = pkg.license;
  writeFileSync(
    join(root, 'package-lock.json'),
    JSON.stringify({
      name: `fixture-${label}`,
      version: '0.0.0',
      lockfileVersion: 3,
      packages: {'': {name: `fixture-${label}`, version: '0.0.0'}, [`node_modules/${pkg.name}`]: lockEntry},
    }),
  );
  const manifest: Record<string, unknown> = {name: pkg.name, version: pkg.version};
  if (pkg.license) manifest['license'] = pkg.license;
  writeFileSync(join(directory, 'package.json'), JSON.stringify(manifest));
  if (pkg.licenseFile) {
    writeFileSync(join(directory, pkg.licenseFile.name), pkg.licenseFile.text);
  }
  return root;
}

function writeJson(file: string, value: unknown): string {
  writeFileSync(file, JSON.stringify(value, null, 2));
  return file;
}

/**
 * Native-review flags that require nothing, so a licence test is not also a
 * native-distribution test. A scope with no platforms puts no platform package
 * in distribution scope, and these trees lock no package npm installs on every
 * platform, which would stay required (D177); the native reconciliation is
 * exercised on its own in test/unit/native-review.test.ts.
 */
function quietNative(root: string): string[] {
  const scope = writeJson(join(root, 'scope.json'), {
    distributionScope: {decision: 'test', authorizedBy: 'test', date: '2026-09-22', platforms: []},
    exclusions: [],
  });
  const observations = writeJson(join(root, 'observations.json'), {observations: []});
  const reviews = writeJson(join(root, 'reviews.json'), {reviews: []});
  return ['--scope', scope, '--observations', observations, '--reviews', reviews];
}

test('every SPDX case evaluates as the fixture expects', async () => {
  const result = await runCheckScript('license-check.mjs', [
    '--spdx-cases',
    fixturePath('license', 'spdx-cases.json'),
  ]);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /result: pass — \d+ case\(s\)/);
  assert.ok(!result.stdout.includes('FAIL'), result.stdout);

  const cases = JSON.parse(readFileSync(fixturePath('license', 'spdx-cases.json'), 'utf8')) as {
    cases: unknown[];
  };
  assert.ok(cases.cases.length >= 40, 'the SPDX fixture must cover every scope and operator');
});

test('the SPDX runner is not vacuous: a wrong expectation fails', async () => {
  const root = temporaryRoot('spdx');
  const file = join(root, 'wrong-cases.json');
  writeFileSync(
    file,
    JSON.stringify({cases: [{expression: 'GPL-3.0-only', scope: 'author-runtime', expected: true}]}),
  );
  const result = await runCheckScript('license-check.mjs', ['--spdx-cases', file]);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /FAIL/);
});

test('an allowed installed tree passes and names the libvips exception', async () => {
  const result = await runCheckScript('license-check.mjs', ['--root', licenceTree('tree-ok')]);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /libvips exception applied to 2 package\(s\) \(D24\)/);
  assert.match(result.stdout, /@img\/sharp-win32-x64@0\.35\.4/);
  assert.match(result.stdout, /1 package\(s\) are not installed on this platform/);
  assert.match(result.stdout, /result: pass/);
});

test('an unknown or absent licence fails', async () => {
  const result = await runCheckScript('license-check.mjs', ['--root', licenceTree('tree-unknown')]);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /policy failures: 2 package\(s\) \(R11\)/);
  assert.match(result.stdout, /opaque@1\.2\.3 \(author-runtime\) unreadable SPDX expression/);
  assert.match(result.stdout, /undeclared@0\.1\.0 \(author-runtime\) declares no licence, and no verified evidence record/);
});

test('copyleft fails in every scope, including inside an AND', async () => {
  const result = await runCheckScript('license-check.mjs', ['--root', licenceTree('tree-disallowed')]);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /copyleft-runtime@3\.0\.0 \(author-runtime\) GPL-3\.0-only is not allowed/);
  assert.match(result.stdout, /copyleft-dev@1\.0\.0 \(dev\) AGPL-3\.0-or-later is not allowed/);
  assert.match(result.stdout, /mixed@2\.0\.0 \(author-runtime\) MIT AND LGPL-2\.1-or-later is not allowed/);
});

test('a package outside the libvips list cannot claim the LGPL exception', async () => {
  const result = await runCheckScript('license-check.mjs', [
    '--root',
    licenceTree('tree-false-libvips'),
  ]);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /pretend-vips@1\.0\.0 \(author-runtime\) LGPL-3\.0-or-later is not allowed/);
});

test('an exception cannot be used to admit copyleft', async () => {
  const root = temporaryRoot('copyleft-exception');
  const exceptions = join(root, 'exceptions.json');
  writeFileSync(
    exceptions,
    JSON.stringify({
      exceptions: [
        {
          package: 'pretend-vips',
          version: '1.0.0',
          scope: 'author-runtime',
          license: 'LGPL-3.0-or-later',
          status: 'approved',
          rationale: 'this must be refused',
          reviewOwner: 'nobody',
          approvalReference: 'none',
          approver: 'nobody',
          approvalDate: '2026-09-22',
        },
      ],
    }),
  );
  const result = await runCheckScript('license-check.mjs', [
    '--root',
    licenceTree('tree-false-libvips'),
    '--exceptions',
    exceptions,
  ]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /copyleft is refused in every scope/i);
});

test('no exception applies in published-piece scope: one naming the vendored engine fails the run (D21, W5R-06)', async () => {
  // What W5R-06 found accepted: the engine under a licence a published piece may not carry, and an approved
  // exception for exactly that package, version, scope and licence. It passed both the check and the release gate.
  const licence = 'Attribution 4.0 International\n';
  const root = miniTree('published-piece-exception', {name: 'left-pad', version: '1.3.0', license: 'MIT'});
  mkdirSync(join(root, 'vendor', 'page-flip'), {recursive: true});
  writeFileSync(join(root, 'vendor', 'page-flip', 'LICENSE'), licence);
  writeFileSync(
    join(root, 'vendor', 'page-flip', 'VERSION'),
    ['# fixture', 'npm_package: page-flip', 'npm_version: 2.0.7', 'file: page-flip.browser.js', 'license: LICENSE', 'license_spdx: CC-BY-4.0',
      `license_sha256: ${createHash('sha256').update(licence).digest('hex')}`, ''].join('\n'),
  );
  const exceptions = writeJson(join(root, 'exceptions.json'), {
    exceptions: [
      {
        package: 'page-flip',
        version: '2.0.7',
        scope: 'published-piece',
        license: 'CC-BY-4.0',
        status: 'approved',
        rationale: 'this must be refused',
        reviewOwner: 'nobody',
        approvalReference: 'none',
        approver: 'nobody',
        approvalDate: '2026-09-22',
      },
    ],
  });
  const native = quietNative(root);
  for (const mode of [[], ['--release']]) {
    const result = await runCheckScript('license-check.mjs', [...mode, '--root', root, '--exceptions', exceptions, ...native]);
    assert.equal(result.code, 2, `${mode.length === 0 ? 'the development check' : 'the release gate'} must refuse the entry\n${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /page-flip@2\.0\.7 is listed for published-piece scope; no exception applies in published-piece scope \(D21\)/);
  }

  // Without the entry, the licence is what fails: published-piece scope is held to its allowlist alone.
  const plain = await runCheckScript('license-check.mjs', ['--root', root, ...native]);
  assert.equal(plain.code, 1, plain.stdout + plain.stderr);
  assert.match(plain.stdout, /page-flip@2\.0\.7 \(published-piece\) CC-BY-4\.0 is not allowed in published-piece scope — declared in vendor\/page-flip\/VERSION/);
});

test('evidence: a stale licence-file hash fails, whatever the policy says', async () => {
  const root = miniTree('evidence-stale', {
    name: 'quiet',
    version: '1.0.0',
    license: 'MIT',
    licenseFile: {name: 'LICENSE', text: 'MIT, but changed since it was read\n'},
  });
  const evidence = writeJson(join(root, 'evidence.json'), {
    evidence: [
      {
        package: 'quiet',
        version: '1.0.0',
        file: 'LICENSE',
        sha256: '0'.repeat(64),
        verifiedBy: 'a reviewer',
        verifiedOn: '2026-09-22',
      },
    ],
  });
  const result = await runCheckScript('license-check.mjs', [
    '--root', root, '--evidence', evidence, ...quietNative(root),
  ]);
  assert.equal(result.code, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /the file changed since it was read and must be reviewed again/);
});

test('evidence: a missing licence file fails when the package is installed', async () => {
  const root = miniTree('evidence-absent', {name: 'quiet', version: '1.0.0', license: 'MIT'});
  const evidence = writeJson(join(root, 'evidence.json'), {
    evidence: [
      {
        package: 'quiet',
        version: '1.0.0',
        file: 'LICENSE',
        sha256: 'a'.repeat(64),
        verifiedBy: 'a reviewer',
        verifiedOn: '2026-09-22',
      },
    ],
  });
  const result = await runCheckScript('license-check.mjs', [
    '--root', root, '--evidence', evidence, ...quietNative(root),
  ]);
  assert.equal(result.code, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /no longer carries node_modules\/quiet\/LICENSE/);
});

test('evidence: an uninstalled package is unresolved, and that blocks only a release', async () => {
  const root = temporaryRoot('evidence-uninstalled');
  writeJson(join(root, 'package-lock.json'), {
    name: 'fixture',
    version: '0.0.0',
    lockfileVersion: 3,
    packages: {
      '': {name: 'fixture', version: '0.0.0'},
      'node_modules/quiet': {version: '1.0.0', license: 'MIT', optional: true, os: ['win32']},
    },
  });
  const evidence = writeJson(join(root, 'evidence.json'), {
    evidence: [
      {
        package: 'quiet',
        version: '1.0.0',
        file: 'LICENSE',
        sha256: 'b'.repeat(64),
        required: true,
        verifiedBy: 'a reviewer',
        verifiedOn: '2026-09-22',
      },
    ],
  });
  const native = quietNative(root);

  const development = await runCheckScript('license-check.mjs', [
    '--root', root, '--evidence', evidence, ...native,
  ]);
  assert.equal(development.code, 0, development.stdout + development.stderr);
  assert.match(development.stdout, /unresolved .*not installed on this platform/);

  const release = await runCheckScript('license-check.mjs', [
    '--release', '--root', root, '--evidence', evidence, ...native,
  ]);
  assert.equal(release.code, 1, release.stdout + release.stderr);
  assert.match(release.stdout, /required evidence/);
});

test('evidence identifies the licence of a package that declares none', async () => {
  const root = miniTree('evidence-identifies', {
    name: 'silent',
    version: '2.0.0',
    licenseFile: {name: 'LICENSE', text: 'The MIT License\n'},
  });
  const sha = createHash('sha256').update('The MIT License\n').digest('hex');
  const good = writeJson(join(root, 'evidence.json'), {
    evidence: [
      {
        package: 'silent',
        version: '2.0.0',
        file: 'LICENSE',
        sha256: sha,
        identifies: 'MIT',
        verifiedBy: 'a reviewer',
        verifiedOn: '2026-09-22',
      },
    ],
  });
  const native = quietNative(root);

  const withEvidence = await runCheckScript('license-check.mjs', [
    '--root', root, '--evidence', good, ...native,
  ]);
  assert.equal(withEvidence.code, 0, withEvidence.stdout + withEvidence.stderr);
  assert.match(withEvidence.stdout, /identifies MIT/);

  // Without the record the same package fails: an undeclared licence is never
  // waved through just because somebody believes it is MIT.
  const none = writeJson(join(root, 'none.json'), {evidence: []});
  const withoutEvidence = await runCheckScript('license-check.mjs', [
    '--root', root, '--evidence', none, ...native,
  ]);
  assert.equal(withoutEvidence.code, 1);
  assert.match(withoutEvidence.stdout, /declares no licence, and no verified evidence record/);
});

test('an allowlisted licence still has its evidence verified', async () => {
  // The regression D31 exists for: PSF-2.0 moved into the author-runtime
  // allowlist, so argparse matches no exception any more. Its licence file must
  // still be checked, or the approval would have quietly retired the evidence.
  const root = miniTree('allowlisted-evidence', {
    name: 'argparse',
    version: '3.0.2',
    license: 'PSF-2.0',
    licenseFile: {name: 'LICENSE', text: 'not the text that was reviewed\n'},
  });
  const evidence = writeJson(join(root, 'evidence.json'), {
    evidence: [
      {
        package: 'argparse',
        version: '3.0.2',
        file: 'LICENSE',
        sha256: 'c'.repeat(64),
        identifies: 'PSF-2.0',
        verifiedBy: 'a reviewer',
        verifiedOn: '2026-09-22',
      },
    ],
  });
  const result = await runCheckScript('license-check.mjs', [
    '--root', root, '--evidence', evidence, ...quietNative(root),
  ]);
  assert.equal(result.code, 1, 'an allowlisted licence with broken evidence must still fail');
  assert.match(result.stdout, /must be reviewed again/);
});

test('scope isolation: the owner approval widened author-runtime only', async () => {
  const cases: [string, string, number][] = [
    ['author-runtime', 'PSF-2.0', 0],
    ['dev', 'PSF-2.0', 1],
    ['author-runtime', '0BSD', 0],
    ['dev', '0BSD', 1],
  ];
  for (const [scope, license, expected] of cases) {
    const root = temporaryRoot(`scope-${scope}-${license}`);
    mkdirSync(join(root, 'node_modules', 'probe'), {recursive: true});
    writeJson(join(root, 'package-lock.json'), {
      name: 'fixture',
      version: '0.0.0',
      lockfileVersion: 3,
      packages: {
        '': {name: 'fixture', version: '0.0.0'},
        'node_modules/probe': scope === 'dev' ? {version: '1.0.0', dev: true} : {version: '1.0.0'},
      },
    });
    writeFileSync(
      join(root, 'node_modules', 'probe', 'package.json'),
      JSON.stringify({name: 'probe', version: '1.0.0', license}),
    );
    const result = await runCheckScript('license-check.mjs', [
      '--root', root,
      '--evidence', writeJson(join(root, 'evidence.json'), {evidence: []}),
      ...quietNative(root),
    ]);
    assert.equal(result.code, expected, `${license} in ${scope} scope\n${result.stdout}`);
  }
});

test('an exception must name one exact version', async () => {
  const root = miniTree('exact-version', {name: 'probe', version: '1.0.0', license: 'CC0-1.0'});
  for (const version of ['^1.0.0', '1.x', '*', '1.0']) {
    const exceptions = writeJson(join(root, 'exceptions.json'), {
      exceptions: [
        {
          package: 'probe',
          version,
          scope: 'author-runtime',
          license: 'CC0-1.0',
          status: 'approved',
          rationale: 'a range must not be accepted',
          reviewOwner: 'release owner',
          approvalReference: 'ref',
          approver: 'someone',
          approvalDate: '2026-09-22',
        },
      ],
    });
    const result = await runCheckScript('license-check.mjs', ['--root', root, '--exceptions', exceptions]);
    assert.equal(result.code, 2, `${version} should be refused`);
    assert.match(result.stderr, /must name one exact version/);
  }
});

test('an exception without a status is never treated as approved', async () => {
  const root = miniTree('no-status', {name: 'probe', version: '1.0.0', license: 'CC0-1.0'});
  const exceptions = writeJson(join(root, 'exceptions.json'), {
    exceptions: [
      {
        package: 'probe',
        version: '1.0.0',
        scope: 'author-runtime',
        license: 'CC0-1.0',
        rationale: 'no status at all',
        reviewOwner: 'release owner',
      },
    ],
  });
  const result = await runCheckScript('license-check.mjs', ['--root', root, '--exceptions', exceptions]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /needs a non-empty status/);
});

test('an approved exception must carry its approval metadata', async () => {
  const root = miniTree('approval-metadata', {name: 'probe', version: '1.0.0', license: 'CC0-1.0'});
  for (const missing of ['approvalReference', 'approver', 'approvalDate']) {
    const entry: Record<string, string> = {
      package: 'probe',
      version: '1.0.0',
      scope: 'author-runtime',
      license: 'CC0-1.0',
      status: 'approved',
      rationale: 'approved but incomplete',
      reviewOwner: 'release owner',
      approvalReference: 'ref',
      approver: 'someone',
      approvalDate: '2026-09-22',
    };
    delete entry[missing];
    const exceptions = writeJson(join(root, 'exceptions.json'), {exceptions: [entry]});
    const result = await runCheckScript('license-check.mjs', ['--root', root, '--exceptions', exceptions]);
    assert.equal(result.code, 2, `missing ${missing} should be refused`);
    assert.match(result.stderr, new RegExp(`is approved but has no ${missing}`));
  }
});

test('a provisional exception passes development and blocks a release', async () => {
  const root = miniTree('provisional', {name: 'probe', version: '1.0.0', license: 'CC0-1.0'});
  const exceptions = writeJson(join(root, 'exceptions.json'), {
    exceptions: [
      {
        package: 'probe',
        version: '1.0.0',
        scope: 'author-runtime',
        license: 'CC0-1.0',
        status: 'provisional',
        rationale: 'awaiting the release owner',
        reviewOwner: 'release owner (D18)',
      },
    ],
  });
  const native = quietNative(root);

  const development = await runCheckScript('license-check.mjs', [
    '--root', root, '--exceptions', exceptions, ...native,
  ]);
  assert.equal(development.code, 0, development.stdout + development.stderr);
  assert.match(development.stdout, /\[PROVISIONAL, release blocked until approved\]/);

  const release = await runCheckScript('license-check.mjs', [
    '--release', '--root', root, '--exceptions', exceptions, ...native,
  ]);
  assert.equal(release.code, 1, release.stdout + release.stderr);
  assert.match(release.stdout, /relies on a provisional exception/);
});



test('the real installed tree passes development and names its policy', async () => {
  const result = await runCheckScript('license-check.mjs', ['--root', applicationRoot]);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /result: pass/);
  assert.match(
    result.stdout,
    /published-piece scope: 0 npm packages; 1 vendored component\(s\): page-flip@2\.0\.7 \(MIT; vendor\/page-flip\/LICENSE matches its recorded SHA-256\)/,
  );
  assert.match(result.stdout, /PSF-2\.0, Python-2\.0, 0BSD by owner approval \(D29\)/);
  assert.match(result.stdout, /railroad-diagrams@1\.0\.0 \(author-runtime\) — CC0-1\.0 \[approved/);
  for (const name of ['argparse', 'tslib', 'valid-url']) {
    assert.ok(result.stdout.includes(name), `${name} evidence is not reported`);
  }
});

test('a vendored component is checked in published-piece scope, with its licence file held to its hash (M4.1)', async () => {
  const licence = 'MIT License\n\nCopyright (c) 2026 Fixture\n';
  const digest = createHash('sha256').update(licence).digest('hex');
  const record = (name: string, spdx: string, sha256: string): string =>
    ['# fixture', `npm_package: ${name}`, 'npm_version: 1.0.0', 'file: engine.js', 'license: LICENSE', `license_spdx: ${spdx}`, `license_sha256: ${sha256}`, ''].join('\n');
  const component = (root: string, name: string, files: Record<string, string>): void => {
    mkdirSync(join(root, 'vendor', name), {recursive: true});
    for (const [file, text] of Object.entries(files)) {
      writeFileSync(join(root, 'vendor', name, file), text);
    }
  };

  const good = miniTree('vendored-ok', {name: 'left-pad', version: '1.3.0', license: 'MIT'});
  component(good, 'engine', {'VERSION': record('engine', 'MIT', digest), 'LICENSE': licence});
  const passed = await runCheckScript('license-check.mjs', ['--root', good, ...quietNative(good)]);
  assert.equal(passed.code, 0, passed.stdout + passed.stderr);
  assert.match(passed.stdout, /published-piece scope: 0 npm packages; 1 vendored component\(s\): engine@1\.0\.0 \(MIT; vendor\/engine\/LICENSE matches its recorded SHA-256\)/);

  const bad = miniTree('vendored-bad', {name: 'left-pad', version: '1.3.0', license: 'MIT'});
  component(bad, 'copyleft', {'VERSION': record('copyleft', 'GPL-3.0-only', digest), 'LICENSE': licence});
  // Apache-2.0 is allowed for the author's machine, never in a published piece.
  component(bad, 'apache', {'VERSION': record('apache', 'Apache-2.0', digest), 'LICENSE': licence});
  component(bad, 'changed', {'VERSION': record('changed', 'MIT', digest), 'LICENSE': `${licence}An added line.\n`});
  component(bad, 'unrecorded', {'LICENSE': licence});
  component(bad, 'incomplete', {'VERSION': 'npm_package: incomplete\n', 'LICENSE': licence});
  writeFileSync(join(bad, 'vendor', 'stray.js'), '');
  const failed = await runCheckScript('license-check.mjs', ['--root', bad, ...quietNative(bad)]);
  assert.equal(failed.code, 1, failed.stdout + failed.stderr);
  assert.match(failed.stdout, /policy failures: 6 package\(s\) \(R11\)/);
  assert.match(failed.stdout, /copyleft@1\.0\.0 \(published-piece\) GPL-3\.0-only is not allowed in published-piece scope — declared in vendor\/copyleft\/VERSION/);
  assert.match(failed.stdout, /apache@1\.0\.0 \(published-piece\) Apache-2\.0 is not allowed in published-piece scope/);
  assert.match(failed.stdout, /changed@1\.0\.0 \(published-piece\) vendor\/changed\/LICENSE hashes to [0-9a-f]{64}, but its record gives [0-9a-f]{64}/);
  assert.match(failed.stdout, /vendor\/unrecorded \(published-piece\) has no VERSION record naming its licence/);
  assert.match(failed.stdout, /vendor\/incomplete \(published-piece\) has a VERSION record without npm_version, license, license_spdx, license_sha256/);
  assert.match(failed.stdout, /vendor\/stray\.js \(published-piece\) is a file directly under vendor\//);
});

test('a vendored licence file is one inside its own component: no .. segment, absolute path, backslash, link or folder', async () => {
  const licence = 'MIT License\n\nCopyright (c) 2026 Fixture\n';
  const digest = createHash('sha256').update(licence).digest('hex');
  const record = (name: string, license: string): string =>
    ['# fixture', `npm_package: ${name}`, 'npm_version: 1.0.0', 'file: engine.js', `license: ${license}`, 'license_spdx: MIT', `license_sha256: ${digest}`, ''].join('\n');
  const root = miniTree('vendored-paths', {name: 'left-pad', version: '1.3.0', license: 'MIT'});
  const component = (name: string, files: Record<string, string>): string => {
    const folder = join(root, 'vendor', name);
    mkdirSync(folder, {recursive: true});
    for (const [file, text] of Object.entries(files)) {
      writeFileSync(join(folder, file), text);
    }
    return folder;
  };
  // A component with a licence of its own; each of the others tries to pass on a text that is not its own.
  const donor = component('donor', {VERSION: record('donor', 'LICENSE'), LICENSE: licence});
  component('borrower', {VERSION: record('borrower', '../donor/LICENSE')});
  component('absolute', {VERSION: record('absolute', `${join(donor, 'LICENSE')}`)});
  component('backslash', {VERSION: record('backslash', '..\\donor\\LICENSE')});
  symlinkSync(join(donor, 'LICENSE'), join(component('linked', {VERSION: record('linked', 'LICENSE')}), 'LICENSE'));
  mkdirSync(join(component('folder', {VERSION: record('folder', 'LICENSE')}), 'LICENSE'));
  symlinkSync(donor, join(component('escape', {VERSION: record('escape', 'texts/LICENSE')}), 'texts'));

  const run = await runCheckScript('license-check.mjs', ['--root', root, ...quietNative(root)]);
  assert.equal(run.code, 1, run.stdout + run.stderr);
  assert.match(run.stdout, /policy failures: 6 package\(s\) \(R11\)/);
  assert.match(run.stdout, /1 vendored component\(s\): donor@1\.0\.0 \(MIT; vendor\/donor\/LICENSE matches its recorded SHA-256\)/);
  for (const name of ['borrower', 'absolute', 'backslash']) {
    assert.match(run.stdout, new RegExp(`vendor/${name} \\(published-piece\\) names its licence ".+"; it must be a file inside vendor/${name}/`), name);
  }
  for (const name of ['linked', 'folder', 'escape']) {
    assert.match(run.stdout, new RegExp(`${name}@1\\.0\\.0 \\(published-piece\\) names vendor/${name}/\\S+, which is not a regular file inside vendor/${name}/`), name);
  }
});

test('the fonts are checked in published-piece scope: each file has a family whose OFL text travels beside it (M5.3)', async () => {
  const real = await runCheckScript('license-check.mjs', ['--root', applicationRoot]);
  assert.match(
    real.stdout,
    /; 8 font file\(s\) in 2 families: Poppins \(OFL-1\.1; theme\/fonts\/Poppins-OFL\.txt\), Inter \(OFL-1\.1; theme\/fonts\/Inter-OFL\.txt\)\./,
  );

  const ofl = (family: string): string => `Copyright 2020 The ${family} Project Authors (https://example.org)\n\nThis Font Software is licensed under the SIL Open Font License, Version 1.1.\n\nSIL OPEN FONT LICENSE Version 1.1 - 26 February 2007\n`;
  const withFonts = (label: string, files: Record<string, string>): string => {
    const root = miniTree(label, {name: 'left-pad', version: '1.3.0', license: 'MIT'});
    mkdirSync(join(root, 'theme', 'fonts'), {recursive: true});
    for (const [name, text] of Object.entries(files)) {
      writeFileSync(join(root, 'theme', 'fonts', name), text);
    }
    return root;
  };

  const good = withFonts('fonts-ok', {'poppins-400-latin.woff2': 'x', 'Poppins-OFL.txt': ofl('Poppins'), 'README.md': 'not a font'});
  const passed = await runCheckScript('license-check.mjs', ['--root', good, ...quietNative(good)]);
  assert.equal(passed.code, 0, passed.stdout + passed.stderr);
  assert.match(passed.stdout, /1 font file\(s\) in 1 family: Poppins \(OFL-1\.1; theme\/fonts\/Poppins-OFL\.txt\)/);

  const stray = withFonts('fonts-stray', {'poppins-400-latin.woff2': 'x', 'Poppins-OFL.txt': ofl('Poppins'), 'comic-sans.woff2': 'x'});
  const strayRun = await runCheckScript('license-check.mjs', ['--root', stray, ...quietNative(stray)]);
  assert.equal(strayRun.code, 1, strayRun.stdout);
  assert.match(strayRun.stdout, /theme\/fonts\/comic-sans\.woff2 \(published-piece\) is a font file that no family in FONT_FAMILIES claims/);

  const textless = withFonts('fonts-textless', {'inter-400-700-latin.woff2': 'x'});
  const textlessRun = await runCheckScript('license-check.mjs', ['--root', textless, ...quietNative(textless)]);
  assert.equal(textlessRun.code, 1, textlessRun.stdout);
  assert.match(textlessRun.stdout, /Inter \(published-piece\) has 1 font file\(s\) but no licence text at theme\/fonts\/Inter-OFL\.txt/);

  const wrong = withFonts('fonts-wrong-text', {'inter-400-700-latin.woff2': 'x', 'Inter-OFL.txt': 'MIT License\n\nCopyright (c) 2026 Someone\n'});
  const wrongRun = await runCheckScript('license-check.mjs', ['--root', wrong, ...quietNative(wrong)]);
  assert.equal(wrongRun.code, 1, wrongRun.stdout);
  assert.match(wrongRun.stdout, /Inter \(published-piece\) theme\/fonts\/Inter-OFL\.txt is not the SIL Open Font License 1\.1 text/);

  const borrowed = withFonts('fonts-borrowed', {'inter-400-700-latin.woff2': 'x', 'Inter-OFL.txt': ofl('Poppins')});
  const borrowedRun = await runCheckScript('license-check.mjs', ['--root', borrowed, ...quietNative(borrowed)]);
  assert.equal(borrowedRun.code, 1, borrowedRun.stdout);
  assert.match(borrowedRun.stdout, /theme\/fonts\/Inter-OFL\.txt does not name the Inter Project Authors in its copyright line/);
});

test('every licence text licenses/index.json names is held to its recorded size and SHA-256, offline (W5R-05, D36, D126)', async () => {
  const index = JSON.parse(readFileSync(join(applicationRoot, 'licenses', 'index.json'), 'utf8')) as {licenses: unknown[]; packages: unknown[]};
  const real = await runCheckScript('license-check.mjs', ['--root', applicationRoot]);
  assert.equal(real.code, 0, real.stdout + real.stderr);
  assert.match(
    real.stdout,
    new RegExp(`retained licence texts: ${index.licenses.length + index.packages.length} named by licenses/index\\.json match their recorded size and SHA-256 \\(D36, D126\\)`),
  );

  const text = (name: string): string => `The ${name} licence text.\n`;
  const recorded = (file: string, body: string): Record<string, unknown> => ({file, sha256: createHash('sha256').update(body).digest('hex'), bytes: Buffer.byteLength(body)});
  const retained = (label: string): string => {
    const root = miniTree(label, {name: 'left-pad', version: '1.3.0', license: 'MIT'});
    mkdirSync(join(root, 'licenses', 'packages', 'left-pad@1.3.0'), {recursive: true});
    for (const id of ['MIT', 'ISC']) {
      writeFileSync(join(root, 'licenses', `${id}.txt`), text(id));
    }
    writeFileSync(join(root, 'licenses', 'packages', 'left-pad@1.3.0', 'LICENSE'), text('left-pad'));
    // What the real folder keeps beside its texts: the rule that keeps their bytes as written. It is no text to name.
    writeFileSync(join(root, 'licenses', '.gitattributes'), '* -text\n');
    writeJson(join(root, 'licenses', 'index.json'), {
      licenses: [{spdxId: 'MIT', ...recorded('MIT.txt', text('MIT'))}, {spdxId: 'ISC', ...recorded('ISC.txt', text('ISC'))}],
      packages: [{package: 'left-pad', version: '1.3.0', ...recorded('packages/left-pad@1.3.0/LICENSE', text('left-pad'))}],
    });
    return root;
  };

  const good = retained('texts-ok');
  const passed = await runCheckScript('license-check.mjs', ['--root', good, ...quietNative(good)]);
  assert.equal(passed.code, 0, passed.stdout + passed.stderr);
  assert.match(passed.stdout, /retained licence texts: 3 named by licenses\/index\.json match their recorded size and SHA-256/);

  const bad = retained('texts-bad');
  const edited = `${text('MIT')}An added line.\n`;
  writeFileSync(join(bad, 'licenses', 'MIT.txt'), edited);
  rmSync(join(bad, 'licenses', 'ISC.txt'));
  writeFileSync(join(bad, 'licenses', 'GPL-2.0-only.txt'), text('GPL-2.0-only'));
  // The folder ships whole, so a text no entry names is caught however deep it lies.
  writeFileSync(join(bad, 'licenses', 'packages', 'left-pad@1.3.0', 'EXTRA.txt'), text('extra'));
  // The same bytes, through a link to a file outside licenses/: a hash alone would pass it.
  const outside = join(bad, 'left-pad-LICENSE');
  writeFileSync(outside, text('left-pad'));
  rmSync(join(bad, 'licenses', 'packages', 'left-pad@1.3.0', 'LICENSE'));
  symlinkSync(outside, join(bad, 'licenses', 'packages', 'left-pad@1.3.0', 'LICENSE'));
  const indexFile = join(bad, 'licenses', 'index.json');
  const badIndex = JSON.parse(readFileSync(indexFile, 'utf8')) as {packages: Record<string, unknown>[]};
  badIndex.packages.push({package: 'escape', version: '1.0.0', ...recorded('../left-pad-LICENSE', text('left-pad'))});
  writeJson(indexFile, badIndex);

  for (const mode of [[], ['--release']]) {
    const failed = await runCheckScript('license-check.mjs', [...mode, '--root', bad, ...quietNative(bad)]);
    assert.equal(failed.code, 1, failed.stdout + failed.stderr);
    assert.match(failed.stdout, /retained licence texts: 0 named by licenses\/index\.json match their recorded size and SHA-256 \(D36, D126\); 6 failure\(s\), listed below/);
    assert.match(failed.stdout, /policy failures: 6 package\(s\) \(R11\)/);
    assert.match(
      failed.stdout,
      new RegExp(`licenses/MIT\\.txt \\(licence text\\) is ${Buffer.byteLength(edited)} bytes with SHA-256 [0-9a-f]{64}, but licenses/index\\.json records ${Buffer.byteLength(text('MIT'))} bytes with SHA-256 [0-9a-f]{64}`),
    );
    assert.match(failed.stdout, /licenses\/ISC\.txt \(licence text\) is missing, though licenses\/index\.json records it as retained/);
    assert.match(failed.stdout, /licenses\/GPL-2\.0-only\.txt \(licence text\) is not named by licenses\/index\.json, so it would travel with no recorded hash/);
    assert.match(failed.stdout, /licenses\/packages\/left-pad@1\.3\.0\/EXTRA\.txt \(licence text\) is not named by licenses\/index\.json, so it would travel with no recorded hash/);
    assert.match(failed.stdout, /licenses\/packages\/left-pad@1\.3\.0\/LICENSE \(licence text\) is not a regular file inside licenses\//);
    assert.match(failed.stdout, /licenses\/index\.json \(licence text\) names "\.\.\/left-pad-LICENSE" in its packages section; a retained text is a relative path inside licenses\//);
  }
});

test('the real tree fails a release check, honestly', async () => {
  // The libvips obligations are genuinely outstanding. A green release check
  // here would mean the check had been weakened, not that the work was done.
  const result = await runCheckScript('license-check.mjs', ['--release', '--root', applicationRoot]);
  assert.equal(result.code, 1, 'the release check must not pass while reviews are outstanding');
  assert.match(result.stdout, /release blockers: \d+/);
  assert.match(result.stdout, /@img\/sharp-libvips-linux-x64/);
});

test('every exception carries a rationale, a review owner and a real status', () => {
  const exceptions = JSON.parse(
    readFileSync(join(applicationRoot, 'scripts', 'license-exceptions.json'), 'utf8'),
  ) as {exceptions: Record<string, unknown>[]; authorization: Record<string, string>};

  assert.equal(typeof exceptions.authorization['source'], 'string');
  assert.match(exceptions.authorization['notIncluded'], /not independent legal review/);

  for (const entry of exceptions.exceptions) {
    for (const field of ['package', 'version', 'scope', 'license', 'rationale', 'reviewOwner', 'status']) {
      assert.equal(typeof entry[field], 'string', `${String(entry['package'])} is missing ${field}`);
    }
    assert.ok(['provisional', 'approved'].includes(entry['status'] as string));
    if (entry['status'] === 'approved') {
      for (const field of ['approvalReference', 'approver', 'approvalDate']) {
        assert.equal(typeof entry[field], 'string', `${String(entry['package'])} is missing ${field}`);
      }
    }
  }
});

test('every file the licence scripts and records name in scripts/ exists (W5R-29)', () => {
  // license-check.mjs and license-exceptions.json once named scripts/native-distribution-inventory.json, long
  // after it had become native-observations.json and native-reviews.json. Each name is held to the tree.
  const files = [
    'license-check.mjs',
    'license-exceptions.json',
    'license-evidence.json',
    'fetch-license-texts.mjs',
    'native-reconcile.mjs',
    'native-scope.json',
    'native-reviews.json',
  ];
  let names = 0;
  for (const file of files) {
    const text = readFileSync(join(applicationRoot, 'scripts', file), 'utf8');
    const named = [
      ...[...text.matchAll(/\bscripts\/([A-Za-z0-9._-]+\.(?:json|mjs))\b/g)].map((match) => match[1]!),
      ...[...text.matchAll(/join\((?:import\.meta\.dirname|here), '([^'/]+)'\)/g)].map((match) => match[1]!),
    ];
    for (const name of new Set(named)) {
      names += 1;
      assert.ok(existsSync(join(applicationRoot, 'scripts', name)), `scripts/${file} names scripts/${name}, which does not exist`);
    }
  }
  assert.ok(names >= 10, 'the reading is not vacuous');
});

test('every evidence record names what it identifies and who read it', () => {
  const evidence = JSON.parse(
    readFileSync(join(applicationRoot, 'scripts', 'license-evidence.json'), 'utf8'),
  ) as {evidence: Record<string, unknown>[]};
  assert.ok(evidence.evidence.length > 0);
  for (const record of evidence.evidence) {
    for (const field of ['package', 'version', 'file', 'sha256', 'verifiedBy', 'verifiedOn']) {
      assert.equal(typeof record[field], 'string', `${String(record['package'])} is missing ${field}`);
    }
    assert.match(record['sha256'] as string, /^[0-9a-f]{64}$/);
  }
});
