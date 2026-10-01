/**
 * Browser engines for the Playwright suites (D51).
 *
 * Node-side only and free of DOM types, so any test program can import it.
 * CI installs Playwright's own Chromium, Firefox and WebKit builds with
 * `npx playwright install --with-deps chromium firefox webkit` and runs every
 * engine. Two environment variables exist for machines that cannot download
 * those builds:
 *
 * - `PAPELERIA_BROWSERS=chromium,webkit` narrows the engines a suite runs.
 *   Each engine left out is reported as a skipped test, never dropped
 *   silently, and the variable is refused under CI, where every engine must
 *   run.
 * - `PAPELERIA_<ENGINE>_EXECUTABLE`, for example
 *   `PAPELERIA_CHROMIUM_EXECUTABLE=/opt/pw-browsers/chromium`, launches a
 *   browser binary already on the machine instead of Playwright's own build.
 *   Suites should record `browser.version()` so the evidence names what ran.
 */
import {chromium, firefox, webkit, type Browser, type BrowserType} from 'playwright';

export type EngineName = 'chromium' | 'firefox' | 'webkit';

export const ENGINES: readonly EngineName[] = ['chromium', 'firefox', 'webkit'];

const BROWSER_TYPES: Readonly<Record<EngineName, BrowserType>> = {chromium, firefox, webkit};

const INSTALL_HINT = 'npx playwright install --with-deps chromium firefox webkit';

/** Whether this run is under CI, where every engine and tool a suite needs must be there. */
export function inContinuousIntegration(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env['CI'];
  return value !== undefined && value !== '' && value !== '0' && value.toLowerCase() !== 'false';
}

function isEngineName(name: string): name is EngineName {
  return (ENGINES as readonly string[]).includes(name);
}

/** The engines to run and the engines deliberately left out. */
export function selectedEngines(env: NodeJS.ProcessEnv = process.env): {run: EngineName[]; excluded: EngineName[]} {
  const requested = env['PAPELERIA_BROWSERS'];
  if (requested === undefined || requested.trim() === '') {
    return {run: [...ENGINES], excluded: []};
  }
  if (inContinuousIntegration(env)) {
    throw new Error('PAPELERIA_BROWSERS narrows the browser engines and is refused under CI, where every engine runs (D51)');
  }
  const names = requested
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '');
  for (const name of names) {
    if (!isEngineName(name)) {
      throw new Error(`PAPELERIA_BROWSERS names an unknown engine ${JSON.stringify(name)}; use ${ENGINES.join(', ')}`);
    }
  }
  const run = ENGINES.filter((engine) => names.includes(engine));
  return {run, excluded: ENGINES.filter((engine) => !run.includes(engine))};
}

/** The browser binary to launch instead of Playwright's own build, if one is configured. */
export function executableOverride(name: EngineName, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env[`PAPELERIA_${name.toUpperCase()}_EXECUTABLE`];
  return value === undefined || value === '' ? undefined : value;
}

/** Launches one engine headless, or fails with the reason and the install command. */
export async function launchEngine(name: EngineName, env: NodeJS.ProcessEnv = process.env): Promise<Browser> {
  const executablePath = executableOverride(name, env);
  try {
    return await BROWSER_TYPES[name].launch(executablePath === undefined ? {} : {executablePath});
  } catch (error) {
    const reason = error instanceof Error ? (error.message.split('\n')[0] ?? error.message) : String(error);
    throw new Error(
      `${name} could not launch: ${reason}. Install the engines with "${INSTALL_HINT}" (D51), ` +
        `or see test/browser/helpers/engines.ts for PAPELERIA_BROWSERS and PAPELERIA_${name.toUpperCase()}_EXECUTABLE.`,
    );
  }
}
