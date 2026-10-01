/**
 * Loads and renders the positive chart fixtures under `positive/`. charts.test.ts
 * uses it in-process, and also runs this file as a separate Node process to
 * show the snapshots are byte-stable across runs, not only within one.
 *
 * As a script it prints `{fixture name: SHA-256 of the SVG}` as JSON.
 * With UPDATE_CHART_SNAPSHOTS=1 it rewrites every `expected.svg`; that is a
 * deliberate maintainer action, reviewed in the diff, and never run by CI.
 */
import {createHash} from 'node:crypto';
import {readdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

import {renderChart, type ChartInput, type ChartResult} from '../../../src/core/charts.js';
import {parseCsv} from '../../../src/core/csv.js';
import {fixturePath} from '../../helpers/paths.js';

export type ChartFixture = {name: string; input: ChartInput; expectedPath: string};

export const POSITIVE_DIRECTORY = fixturePath('charts', 'positive');

export function positiveFixtures(): ChartFixture[] {
  return readdirSync(POSITIVE_DIRECTORY, {withFileTypes: true})
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((name) => {
      const directory = join(POSITIVE_DIRECTORY, name);
      const spec = JSON.parse(readFileSync(join(directory, 'chart.json'), 'utf8')) as Omit<ChartInput, 'table'>;
      const parsed = parseCsv(readFileSync(join(directory, 'data.csv'), 'utf8'));
      if (!parsed.ok) {
        throw new Error(`chart fixture ${name} has CSV problems: ${JSON.stringify(parsed.problems)}`);
      }
      return {name, input: {...spec, table: parsed.table}, expectedPath: join(directory, 'expected.svg')};
    });
}

export function renderFixture(fixture: ChartFixture): ChartResult {
  return renderChart(fixture.input);
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const hashes: Record<string, string> = {};
  for (const fixture of positiveFixtures()) {
    const result = renderFixture(fixture);
    if (result.svg === null) {
      throw new Error(`chart fixture ${fixture.name} did not render: ${JSON.stringify(result.problems)}`);
    }
    if (process.env['UPDATE_CHART_SNAPSHOTS'] === '1') {
      writeFileSync(fixture.expectedPath, result.svg);
    }
    hashes[fixture.name] = sha256(result.svg);
  }
  process.stdout.write(`${JSON.stringify(hashes)}\n`);
}
