/**
 * D34: the native release check reconciles three separate things — requirements
 * derived from the lockfile and the documented scope, generated observations,
 * and a person's compliance reviews. These tests pin the failures that a review
 * found in the first version, where an empty inventory and a stale record both
 * passed.
 */
import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after, test} from 'node:test';

import {applicationRoot, runCheckScript} from '../helpers/paths.js';

const temporaryRoots: string[] = [];
after(() => {
  for (const directory of temporaryRoots) {
    rmSync(directory, {recursive: true, force: true});
  }
});

function temporaryRoot(label: string): string {
  const directory = mkdtempSync(join(tmpdir(), `papeleria-native-${label}-`));
  temporaryRoots.push(directory);
  return directory;
}

function writeJson(file: string, value: unknown): string {
  writeFileSync(file, JSON.stringify(value, null, 2));
  return file;
}

const SCOPE = {
  distributionScope: {
    decision: 'D34',
    authorizedBy: 'fixture',
    date: '2026-09-22',
    platforms: [{os: 'linux', cpu: 'x64', rationale: 'the fixture platform'}],
  },
  exclusions: [],
};

/** A tree locking one libvips package, with the package installed. */
function libvipsTree(label: string): {root: string; digest: string} {
  const root = temporaryRoot(label);
  const directory = join(root, 'node_modules', '@img', 'sharp-libvips-linux-x64');
  mkdirSync(join(directory, 'lib'), {recursive: true});
  writeFileSync(join(directory, 'package.json'), JSON.stringify({name: '@img/sharp-libvips-linux-x64', version: '1.3.3', license: 'LGPL-3.0-or-later'}));
  writeFileSync(join(directory, 'lib', 'libvips-cpp.so.8'), 'pretend native bytes\n');
  writeJson(join(root, 'package-lock.json'), {
    name: `fixture-${label}`,
    version: '0.0.0',
    lockfileVersion: 3,
    packages: {
      '': {name: `fixture-${label}`, version: '0.0.0'},
      'node_modules/@img/sharp-libvips-linux-x64': {
        name: '@img/sharp-libvips-linux-x64',
        version: '1.3.3',
        license: 'LGPL-3.0-or-later',
        integrity: 'sha512-fixture',
        optional: true,
        os: ['linux'],
        cpu: ['x64'],
      },
    },
  });
  return {root, digest: ''};
}

function release(root: string, files: Record<string, string>): Promise<{code: number; stdout: string; stderr: string}> {
  return runCheckScript('license-check.mjs', [
    '--release',
    '--root', root,
    '--evidence', files['evidence'] ?? writeJson(join(root, 'evidence.json'), {evidence: []}),
    '--exceptions', files['exceptions'] ?? writeJson(join(root, 'exceptions.json'), {exceptions: []}),
    '--scope', files['scope']!,
    '--observations', files['observations']!,
    '--reviews', files['reviews']!,
  ]);
}

test('an empty inventory fails when the lockfile contains libvips', async () => {
  const {root} = libvipsTree('empty');
  const result = await release(root, {
    scope: writeJson(join(root, 'scope.json'), SCOPE),
    observations: writeJson(join(root, 'obs.json'), {observations: []}),
    reviews: writeJson(join(root, 'rev.json'), {reviews: []}),
  });
  assert.equal(result.code, 1, 'an empty inventory must not pass\n' + result.stdout);
  assert.match(result.stdout, /@img\/sharp-libvips-linux-x64@1\.3\.3 .*has no observation at all/);
  assert.match(result.stdout, /has no compliance review/);
});

test('a verified review whose version is not locked fails', async () => {
  const {root} = libvipsTree('stale-version');
  const result = await release(root, {
    scope: writeJson(join(root, 'scope.json'), SCOPE),
    observations: writeJson(join(root, 'obs.json'), {observations: []}),
    reviews: writeJson(join(root, 'rev.json'), {
      reviews: [
        {
          package: '@img/sharp-libvips-linux-x64',
          version: '0.0.1',
          status: 'verified',
          reviewedBy: 'someone',
          reviewedOn: '2026-09-22',
          boundToArtefactDigest: 'anything',
          evidence: {licenseTextsRetained: 'a', sourceAvailability: 'b', linkingPosition: 'c'},
        },
      ],
    }),
  });
  assert.equal(result.code, 1);
  assert.match(result.stdout, /does not match any locked version/);
});

test('a verified review must carry its required evidence', async () => {
  const {root} = libvipsTree('no-evidence');
  const result = await release(root, {
    scope: writeJson(join(root, 'scope.json'), SCOPE),
    observations: writeJson(join(root, 'obs.json'), {observations: []}),
    reviews: writeJson(join(root, 'rev.json'), {
      reviews: [
        {
          package: '@img/sharp-libvips-linux-x64',
          version: '1.3.3',
          status: 'verified',
          reviewedBy: 'someone',
          reviewedOn: '2026-09-22',
        },
      ],
    }),
  });
  assert.equal(result.code, 2, 'a malformed policy file is a usage failure in every mode');
  assert.match(result.stderr, /verified but records no licenseTextsRetained/);
});

test('a complete, matching inventory and review passes', async () => {
  const {root} = libvipsTree('complete');
  // Generate the observation the way the real generator does, so the digest the
  // review binds to is the digest the checker computes.
  const generate = await runCheckScript('native-inventory.mjs', [
    '--root', root,
    '--out', join(root, 'obs.json'),
  ]);
  assert.equal(generate.code, 0, generate.stdout + generate.stderr);

  const observations = JSON.parse(readFileSync(join(root, 'obs.json'), 'utf8')) as {
    observations: {package: string; artefactDigest: string}[];
  };
  const observed = observations.observations.find((o) => o.package === '@img/sharp-libvips-linux-x64');
  assert.ok(observed, 'the generator must observe the installed package');

  const result = await release(root, {
    scope: writeJson(join(root, 'scope.json'), SCOPE),
    observations: join(root, 'obs.json'),
    reviews: writeJson(join(root, 'rev.json'), {
      reviews: [
        {
          package: '@img/sharp-libvips-linux-x64',
          version: '1.3.3',
          status: 'verified',
          reviewedBy: 'a named reviewer',
          reviewedOn: '2026-09-22',
          boundToArtefactDigest: observed.artefactDigest,
          evidence: {
            licenseTextsRetained: 'LGPL-3.0 text retained at licenses/LGPL-3.0.txt in the fixture',
            sourceAvailability: 'corresponding source offered at the fixture URL',
            linkingPosition: 'dynamically linked against the shipped shared library',
          },
        },
      ],
    }),
  });
  assert.equal(result.code, 0, 'a complete matching fixture must pass\n' + result.stdout);
  assert.match(result.stdout, /native distribution review: 1 verified of 1 required/);
});

test('a changed artefact invalidates the review that was bound to it', async () => {
  const {root} = libvipsTree('invalidated');
  await runCheckScript('native-inventory.mjs', ['--root', root, '--out', join(root, 'obs.json')]);
  const observations = JSON.parse(readFileSync(join(root, 'obs.json'), 'utf8')) as {
    observations: {package: string; artefactDigest: string}[];
  };
  const digest = observations.observations.find((o) => o.package === '@img/sharp-libvips-linux-x64')!.artefactDigest;

  // The binary changes; the observation is regenerated; the review is not.
  writeFileSync(
    join(root, 'node_modules', '@img', 'sharp-libvips-linux-x64', 'lib', 'libvips-cpp.so.8'),
    'different native bytes\n',
  );
  const regenerate = await runCheckScript('native-inventory.mjs', ['--root', root, '--out', join(root, 'obs.json')]);
  assert.match(regenerate.stdout, /changed .*any review bound to the old digest is now invalid/);

  const result = await release(root, {
    scope: writeJson(join(root, 'scope.json'), SCOPE),
    observations: join(root, 'obs.json'),
    reviews: writeJson(join(root, 'rev.json'), {
      reviews: [
        {
          package: '@img/sharp-libvips-linux-x64',
          version: '1.3.3',
          status: 'verified',
          reviewedBy: 'a named reviewer',
          reviewedOn: '2026-09-22',
          boundToArtefactDigest: digest,
          evidence: {licenseTextsRetained: 'a', sourceAvailability: 'b', linkingPosition: 'c'},
        },
      ],
    }),
  });
  assert.equal(result.code, 1);
  assert.match(result.stdout, /no current observation matches the artefact digest/);
});

test('a rescan of unchanged artefacts keeps the review applicable', async () => {
  const {root} = libvipsTree('rescan');
  await runCheckScript('native-inventory.mjs', ['--root', root, '--out', join(root, 'obs.json')]);
  const first = readFileSync(join(root, 'obs.json'), 'utf8');
  const rescan = await runCheckScript('native-inventory.mjs', ['--root', root, '--out', join(root, 'obs.json')]);
  assert.equal(rescan.code, 0);
  assert.match(rescan.stdout, /0 changed/);
  assert.equal(readFileSync(join(root, 'obs.json'), 'utf8'), first, 'an unchanged rescan must be byte-identical');
});

test('a scan from one platform does not erase another platform observations', async () => {
  const {root} = libvipsTree('cross-platform');
  const out = join(root, 'obs.json');
  // A Windows row recorded earlier, by a scan this machine cannot repeat.
  writeJson(out, {
    observations: [
      {
        package: '@img/sharp-win32-x64',
        version: '0.35.4',
        platformKey: 'win32/x64',
        inspection: 'fetched-package',
        observedFrom: 'win32/x64',
        observedOn: '2026-09-20',
        artefactDigest: 'windows-digest',
        licenseFiles: [],
        nativeArtefacts: [],
      },
    ],
  });
  const rescan = await runCheckScript('native-inventory.mjs', ['--root', root, '--out', out]);
  assert.equal(rescan.code, 0, rescan.stdout + rescan.stderr);
  assert.match(rescan.stdout, /1 kept from other platforms or runs/);

  const merged = JSON.parse(readFileSync(out, 'utf8')) as {observations: {package: string}[]};
  const packages = merged.observations.map((o) => o.package);
  assert.ok(packages.includes('@img/sharp-win32-x64'), 'the Windows row must survive a Linux scan');
  assert.ok(packages.includes('@img/sharp-libvips-linux-x64'), 'the Linux row must be added');
});

test('required: false cannot bypass a review without a documented scope decision', () => {
  const scope = JSON.parse(
    readFileSync(join(applicationRoot, 'scripts', 'native-scope.json'), 'utf8'),
  ) as {exclusions: Record<string, unknown>[]};
  assert.ok(scope.exclusions.length > 0);
  for (const exclusion of scope.exclusions) {
    for (const field of ['reason', 'decision', 'approvedBy', 'date']) {
      assert.equal(typeof exclusion[field], 'string', `an exclusion is missing ${field}`);
      assert.notEqual((exclusion[field] as string).trim(), '');
    }
  }
});

// --- D177: no edit to the scope file alone empties the review (W5R-30) -------

/**
 * A tree that locks sharp and three of its platform packages, none installed:
 * which of them the review requires is decided by the lockfile and the scope,
 * not by any bytes. linux/x64 is in the fixture scope; linux/s390x is not, and
 * nor is the WebContainers build, which names a cpu no platform has.
 */
function nativeLockTree(label: string): string {
  const root = temporaryRoot(label);
  const locked = (name: string, entry: Record<string, unknown>): [string, Record<string, unknown>] => [`node_modules/${name}`, {name, version: '0.35.4', license: 'Apache-2.0', ...entry}];
  writeJson(join(root, 'package-lock.json'), {
    name: `fixture-${label}`,
    version: '0.0.0',
    lockfileVersion: 3,
    packages: Object.fromEntries([
      ['', {name: `fixture-${label}`, version: '0.0.0'}],
      locked('@img/sharp-libvips-linux-x64', {version: '1.3.3', license: 'LGPL-3.0-or-later', optional: true, os: ['linux'], cpu: ['x64']}),
      locked('@img/sharp-linux-s390x', {optional: true, os: ['linux'], cpu: ['s390x']}),
      locked('@img/sharp-webcontainers-wasm32', {optional: true, cpu: ['wasm32']}),
      locked('sharp', {}),
    ]),
  });
  return root;
}

function exclusion(match: Record<string, string>, decision = 'D34'): Record<string, unknown> {
  return {match, reason: 'not distributed for', decision, approvedBy: 'fixture', date: '2026-09-22'};
}

function unreviewed(root: string): {observations: string; reviews: string} {
  return {
    observations: writeJson(join(root, 'obs.json'), {observations: []}),
    reviews: writeJson(join(root, 'rev.json'), {reviews: []}),
  };
}

test('a package-pattern exclusion cannot take out a package a platform in scope requires, whatever decision it cites (W5R-30, D177)', async () => {
  const root = nativeLockTree('pattern-over-scope');
  // The shape W5R-30 describes: one pattern over every native package, citing a decision row that exists.
  const scope = writeJson(join(root, 'scope.json'), {...SCOPE, exclusions: [exclusion({packagePattern: '^(@img/sharp-|sharp$)'})]});
  const files = {scope, ...unreviewed(root)};
  const result = await release(root, files);
  assert.equal(result.code, 2, 'nothing is signed, so the gate must not pass\n' + result.stdout + result.stderr);
  assert.match(result.stderr, /the exclusion "\^\(@img\/sharp-\|sharp\$\)" \(D34\) matches @img\/sharp-libvips-linux-x64, which linux\/x64 in scope requires; a package-pattern exclusion may name only packages no platform in scope requires, whatever decision it cites \(D177\)/);

  // Narrower patterns are refused the same way, sharp itself included: npm installs it on every platform.
  for (const [pattern, refused] of [['^@img/sharp-libvips-', '@img\\/sharp-libvips-linux-x64, which linux\\/x64 in scope requires'], ['^sharp$', 'sharp, which npm installs on every platform;']] as const) {
    const narrower = await release(root, {...files, scope: writeJson(join(root, 'narrower.json'), {...SCOPE, exclusions: [exclusion({packagePattern: pattern})]})});
    assert.equal(narrower.code, 2, pattern);
    assert.match(narrower.stderr, new RegExp(`matches ${refused}`), pattern);
  }

  // The development check refuses the scope too, so CI does not wait for a release to find it.
  const development = await runCheckScript('license-check.mjs', [
    '--root', root, '--evidence', writeJson(join(root, 'evidence.json'), {evidence: []}),
    '--scope', scope, '--observations', files.observations, '--reviews', files.reviews,
  ]);
  assert.equal(development.code, 2, development.stdout + development.stderr);
  assert.match(development.stderr, /\(D177\)/);
});

test('a scope that lists no platform cannot empty the review: sharp, which npm installs everywhere, stays required (D177)', async () => {
  const root = nativeLockTree('no-platform');
  const scope = writeJson(join(root, 'scope.json'), {...SCOPE, distributionScope: {...SCOPE.distributionScope, platforms: []}});
  const result = await release(root, {scope, ...unreviewed(root)});
  assert.equal(result.code, 1, 'nothing is signed, so the gate must not pass\n' + result.stdout + result.stderr);
  assert.match(result.stdout, /native distribution review: 0 verified of 1 required package\(s\); 0 observation\(s\); 3 out of documented scope/);
  assert.match(result.stdout, /sharp@0\.35\.4 \(any-os\/any-cpu\) has no observation at all/);
});

test('platform exclusions are accepted, and none of them can empty the review (D34, D177)', async () => {
  const root = nativeLockTree('platform-exclusions');
  const files = unreviewed(root);
  // What native-scope.json holds today, in kind: a platform outside scope, and a pattern for a build no platform installs.
  const outside = [exclusion({os: 'linux', cpu: 's390x'}), exclusion({packagePattern: '^@img/sharp-webcontainers-'})];
  const accepted = await release(root, {...files, scope: writeJson(join(root, 'scope.json'), {...SCOPE, exclusions: outside})});
  assert.equal(accepted.code, 1, accepted.stdout + accepted.stderr);
  assert.match(accepted.stdout, /native distribution review: 0 verified of 2 required package\(s\); 0 observation\(s\); 2 out of documented scope/);

  // D34's way for a platform in scope to leave it. It cannot reach sharp, which names no platform, so the gate stays shut.
  const dropped = await release(root, {...files, scope: writeJson(join(root, 'dropped.json'), {...SCOPE, exclusions: [...outside, exclusion({os: 'linux', cpu: 'x64'})]})});
  assert.equal(dropped.code, 1, dropped.stdout + dropped.stderr);
  assert.match(dropped.stdout, /native distribution review: 0 verified of 1 required package\(s\); 0 observation\(s\); 3 out of documented scope/);
  assert.match(dropped.stdout, /sharp@0\.35\.4 \(any-os\/any-cpu\) has no observation at all/);
});

test('a malformed scope, observation or review file is a usage failure', async () => {
  const {root} = libvipsTree('malformed');
  const good = {
    scope: writeJson(join(root, 'scope.json'), SCOPE),
    observations: writeJson(join(root, 'obs.json'), {observations: []}),
    reviews: writeJson(join(root, 'rev.json'), {reviews: []}),
  };

  const badScope = await release(root, {...good, scope: writeJson(join(root, 'bad-scope.json'), {})});
  assert.equal(badScope.code, 2);
  assert.match(badScope.stderr, /distributionScope\.platforms must be an array/);

  const badObservation = await release(root, {
    ...good,
    observations: writeJson(join(root, 'bad-obs.json'), {observations: [{package: 'x'}]}),
  });
  assert.equal(badObservation.code, 2);
  assert.match(badObservation.stderr, /an observation is missing/);

  const badReview = await release(root, {
    ...good,
    reviews: writeJson(join(root, 'bad-rev.json'), {reviews: [{package: 'x', version: '1.0.0', status: 'maybe', reviewedBy: 'a', reviewedOn: '2026-09-22'}]}),
  });
  assert.equal(badReview.code, 2);
  assert.match(badReview.stderr, /use "verified" or "unresolved"/);
});

test('the real tree still fails a release check, with every obligation named', async () => {
  const result = await runCheckScript('license-check.mjs', ['--release', '--root', applicationRoot]);
  assert.equal(result.code, 1, 'the obligations are open; a pass would mean the check was weakened');
  assert.match(result.stdout, /native distribution review: 0 verified of \d+ required/);
  assert.match(result.stdout, /; 11 out of documented scope/, 'the seven exclusions native-scope.json holds are accepted (D177)');
  assert.match(result.stdout, /@img\/sharp-libvips-linux-x64@1\.3\.3 review is unresolved/);
});

test('every native review names an owner and what is outstanding', () => {
  const reviews = JSON.parse(
    readFileSync(join(applicationRoot, 'scripts', 'native-reviews.json'), 'utf8'),
  ) as {reviews: Record<string, string>[]};
  assert.ok(reviews.reviews.length > 0);
  for (const review of reviews.reviews) {
    assert.ok(['verified', 'unresolved'].includes(review['status']!));
    if (review['status'] === 'unresolved') {
      assert.equal(typeof review['unresolved'], 'string');
      assert.equal(typeof review['owner'], 'string');
    }
  }
});

// --- D36: assembled facts beside a review, never inside it -------------------

/**
 * The shape a reviewer is offered: facts, an author, a date and their sources.
 * The sources are relative to the reviews file, which is where the fixture
 * writes them, because assembled facts live beside the reviews that cite them.
 */
function proposal(root: string): Record<string, unknown> {
  mkdirSync(join(root, 'licenses'), {recursive: true});
  writeFileSync(join(root, 'licenses', 'index.json'), '{}\n');
  return {
    assembledBy: 'the fixture generator',
    assembledOn: '2026-09-22',
    linkingPosition: 'read from the file header with readelf -d',
    sources: ['licenses/index.json'],
  };
}

test('assembled facts on an unresolved review do not clear the release', async () => {
  const {root} = libvipsTree('proposed-unresolved');
  await runCheckScript('native-inventory.mjs', ['--root', root, '--out', join(root, 'obs.json')]);
  const result = await release(root, {
    scope: writeJson(join(root, 'scope.json'), SCOPE),
    observations: join(root, 'obs.json'),
    reviews: writeJson(join(root, 'rev.json'), {
      reviews: [
        {
          package: '@img/sharp-libvips-linux-x64',
          version: '1.3.3',
          status: 'unresolved',
          reviewedBy: 'not yet reviewed by a person',
          reviewedOn: '2026-09-22',
          unresolved: 'the obligations are not discharged',
          proposedEvidence: proposal(root),
        },
      ],
    }),
  });
  assert.equal(result.code, 1, 'facts a machine assembled are not a review\n' + result.stdout);
  assert.match(result.stdout, /review is unresolved/);
});

test('a verified review may not leave its evidence as a proposal', async () => {
  const {root} = libvipsTree('proposed-verified');
  const result = await release(root, {
    scope: writeJson(join(root, 'scope.json'), SCOPE),
    observations: writeJson(join(root, 'obs.json'), {observations: []}),
    reviews: writeJson(join(root, 'rev.json'), {
      reviews: [
        {
          package: '@img/sharp-libvips-linux-x64',
          version: '1.3.3',
          status: 'verified',
          reviewedBy: 'a named reviewer',
          reviewedOn: '2026-09-22',
          boundToArtefactDigest: 'anything',
          evidence: {licenseTextsRetained: 'a', sourceAvailability: 'b', linkingPosition: 'c'},
          proposedEvidence: proposal(root),
        },
      ],
    }),
  });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /verified but still carries proposedEvidence/);
});

test('a proposal pointing at a file that is gone is rejected', async () => {
  const {root} = libvipsTree('proposed-missing-source');
  const result = await release(root, {
    scope: writeJson(join(root, 'scope.json'), SCOPE),
    observations: writeJson(join(root, 'obs.json'), {observations: []}),
    reviews: writeJson(join(root, 'rev.json'), {
      reviews: [
        {
          package: '@img/sharp-libvips-linux-x64',
          version: '1.3.3',
          status: 'unresolved',
          reviewedBy: 'not yet reviewed by a person',
          reviewedOn: '2026-09-22',
          unresolved: 'open',
          proposedEvidence: {
            assembledBy: 'the fixture generator',
            assembledOn: '2026-09-22',
            linkingPosition: 'read from the file header',
            sources: ['docs/evidence/deleted.json'],
          },
        },
      ],
    }),
  });
  assert.equal(result.code, 2, 'a proposal that points at nothing reads as evidence and holds none');
  assert.match(result.stderr, /docs\/evidence\/deleted\.json, which does not exist/);
});

test('a misspelled proposal field is rejected rather than ignored', async () => {
  const {root} = libvipsTree('proposed-typo');
  const result = await release(root, {
    scope: writeJson(join(root, 'scope.json'), SCOPE),
    observations: writeJson(join(root, 'obs.json'), {observations: []}),
    reviews: writeJson(join(root, 'rev.json'), {
      reviews: [
        {
          package: '@img/sharp-libvips-linux-x64',
          version: '1.3.3',
          status: 'unresolved',
          reviewedBy: 'not yet reviewed by a person',
          reviewedOn: '2026-09-22',
          unresolved: 'open',
          proposedEvidence: {
            assembledBy: 'the fixture generator',
            assembledOn: '2026-09-22',
            linkingPositon: 'a typo that would otherwise look like evidence',
          },
        },
      ],
    }),
  });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /proposedEvidence\.linkingPositon, which is not one of/);
});
