/**
 * Code provenance review P05 (issue 002 F4, D180), the browsers' reading: in
 * Chromium, Firefox and WebKit, each readable copy under `theme/css/readable/`
 * gives exactly the rules its shipped stylesheet gives.
 *
 * `test/unit/theme-css.test.ts` shows that a copy differs from its shipped file
 * only in whitespace, comments and a block's last semicolon, and that esbuild
 * reads the two alike. Here each engine parses both into a stylesheet and the
 * serialized rules are compared, nested rules included, so a whitespace change
 * that meant something to a browser (a descendant combinator made or lost, a
 * media query read differently) would fail in the engine that reads it.
 */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {after, before, describe, test} from 'node:test';

import type {Browser, Page} from 'playwright';

import {applicationRoot} from '../helpers/paths.js';
import {launchEngine, selectedEngines} from './helpers/engines.js';

const SHEETS = ['site', 'slides', 'print'] as const;
const TIMEOUT = {timeout: 60_000};

const read = (...parts: string[]): string => readFileSync(join(applicationRoot, 'theme', 'css', ...parts), 'utf8');

/** The rules an engine reads from a stylesheet, each serialized by the engine. */
function rulesOf(page: Page, css: string): Promise<string[]> {
  return page.evaluate((text) => {
    const style = document.createElement('style');
    style.textContent = text;
    document.head.append(style);
    const sheet = style.sheet;
    const rules = sheet === null ? [] : [...sheet.cssRules].map((rule) => rule.cssText);
    style.remove();
    return rules;
  }, css);
}

const {run, excluded} = selectedEngines();

for (const engine of excluded) {
  test(`${engine}: not run`, {skip: `PAPELERIA_BROWSERS=${process.env['PAPELERIA_BROWSERS'] ?? ''} leaves ${engine} out`}, () => {});
}

for (const engine of run) {
  describe(`P05: the readable theme stylesheets in ${engine}`, () => {
    let browser: Browser;
    let page: Page;

    before(async () => {
      browser = await launchEngine(engine);
      page = await browser.newPage();
      await page.setContent('<!doctype html><html lang="en"><head><title>theme</title></head><body></body></html>');
    });

    after(async () => {
      await browser?.close();
    });

    test('each readable copy gives the rules its shipped stylesheet gives', TIMEOUT, async (context) => {
      context.diagnostic(`${engine} ${browser.version()}`);
      for (const name of SHEETS) {
        const shipped = await rulesOf(page, read(`${name}.css`));
        const readable = await rulesOf(page, read('readable', `${name}.css`));
        assert.ok(shipped.length > 0, `${engine} reads rules from ${name}.css`);
        assert.deepEqual(readable, shipped, `${name}.css: ${engine} reads the same rules from the readable copy`);
        context.diagnostic(`${name}.css: ${shipped.length} top-level rules, identical`);
      }
    });
  });
}
