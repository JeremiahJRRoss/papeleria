/**
 * M1.7: finds the rule modules (architecture §9, D66).
 *
 * Every `R<nn>.js` in the compiled `rules/` folder beside this module is a
 * rule, loaded once per process and returned in id order. Adding a rule is
 * adding its file; nothing lists them. A module whose `rule` export is not a
 * rule of that id is a defect in the tool, never a finding: it throws.
 */
import {readdir} from 'node:fs/promises';

import type {Rule} from './rule.js';

const RULE_FILE = /^(R\d{2})\.js$/;

function isRule(value: unknown, id: string): value is Rule {
  const rule = value as Partial<Rule> | null;
  return (
    typeof rule === 'object' &&
    rule !== null &&
    rule.id === id &&
    (rule.phase === 'source' || rule.phase === 'output') &&
    typeof rule.check === 'function'
  );
}

async function discover(): Promise<readonly Rule[]> {
  const folder = new URL('./rules/', import.meta.url);
  const names = (await readdir(folder)).filter((name) => RULE_FILE.test(name)).sort();
  const rules: Rule[] = [];
  for (const name of names) {
    const id = RULE_FILE.exec(name)![1]!;
    const module = (await import(new URL(name, folder).href)) as {rule?: unknown};
    if (!isRule(module.rule, id)) {
      throw new Error(`E_INTERNAL: rules/${name} does not export the rule ${id}`);
    }
    rules.push(module.rule);
  }
  return Object.freeze(rules);
}

let loaded: Promise<readonly Rule[]> | null = null;

/** Every rule module, in id order. */
export function loadRules(): Promise<readonly Rule[]> {
  loaded ??= discover().catch((error: unknown) => {
    loaded = null;
    throw error;
  });
  return loaded;
}
