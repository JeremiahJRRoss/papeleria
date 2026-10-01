/**
 * The tool's version, read from the `papeleria` package.json above a starting
 * folder. Walking up keeps the lookup right from the source tree, from `lib/`
 * and inside an installed `node_modules/papeleria`. The build stamps it into
 * every page (IC07, the ERD's BUILD `tool_version`) and every report.
 */
import {existsSync, readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

export function readToolVersion(startDirectory: string = dirname(fileURLToPath(import.meta.url))): string {
  let directory = startDirectory;
  for (;;) {
    const candidate = join(directory, 'package.json');
    if (existsSync(candidate)) {
      const parsed: unknown = JSON.parse(readFileSync(candidate, 'utf8'));
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        (parsed as {name?: unknown}).name === 'papeleria' &&
        typeof (parsed as {version?: unknown}).version === 'string'
      ) {
        return (parsed as {version: string}).version;
      }
    }
    const parent = dirname(directory);
    if (parent === directory) {
      throw new Error('E_INTERNAL: papeleria package.json was not found above the tool files');
    }
    directory = parent;
  }
}
