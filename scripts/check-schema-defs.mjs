#!/usr/bin/env node
/**
 * M0.6: templates/shared/schema-defs.json compiles and behaves.
 *
 * Three things are checked.
 *   1. Ajv compiles the document and every single definition under 2020-12 in
 *      strict mode, so an unknown keyword or a broken $ref fails here rather
 *      than at build time.
 *   2. Every definition and every property carries its own description. Those
 *      descriptions are the editor's hover help and the source of the generated
 *      manifest reference, so an undescribed property is a defect.
 *   3. The fixture cases validate or fail exactly as the fixture says.
 *
 * Usage: node scripts/check-schema-defs.mjs [--schema <file>] [--cases <file>]
 * Exit:  0 pass · 1 a compile, description or case failure · 2 usage or IO
 */
import {existsSync, readFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

import ajv2020Module from 'ajv/dist/2020.js';
import ajvFormatsModule from 'ajv-formats';

// ajv and ajv-formats are CommonJS packages whose runtime module.exports is the
// class or function itself while their types describe a namespace (D26).
const Ajv2020 = /** @type {any} */ (ajv2020Module);
const addFormats = /** @type {any} */ (ajvFormatsModule);

class UsageError extends Error {}

const DEFAULT_SCHEMA = join('templates', 'shared', 'schema-defs.json');
const DEFAULT_CASES = join('test', 'fixtures', 'schema-defs', 'cases.json');

function readJson(path, label) {
  if (!existsSync(path)) {
    throw new UsageError(`${label} ${path} is missing`);
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (cause) {
    throw new UsageError(`cannot parse ${path}: ${cause.message}`);
  }
}

export function createValidator() {
  const ajv = new Ajv2020({
    strict: true,
    strictTypes: true,
    strictTuples: true,
    // A `required` list inside a oneOf or if branch constrains properties the
    // parent object declares. That is ordinary JSON Schema, and it is the only
    // way to write "exactly one of these keys", so this one Ajv lint is off
    // while strict schema, type and tuple checking stay on.
    strictRequired: false,
    allowUnionTypes: false,
    allErrors: true,
    validateFormats: true,
  });
  addFormats(ajv);
  return ajv;
}

/**
 * Collects every definition, declared property and tuple slot whose own
 * description is missing or blank.
 *
 * Subschemas under `if`, `then`, `else` and `not` are constraints rather than
 * field declarations, so they are walked for nested definitions but never
 * demand help text of their own: `if: {properties: {type: {const: "line"}}}`
 * declares nothing an author writes.
 */
export function findUndescribed(schema) {
  const problems = [];
  const described = (value) =>
    typeof value?.description === 'string' && value.description.trim() !== '';

  const walk = (node, path, inConstraint) => {
    if (typeof node !== 'object' || node === null || Array.isArray(node)) {
      return;
    }
    for (const [keyword, value] of Object.entries(node)) {
      if (keyword === 'properties' || keyword === '$defs') {
        for (const [name, subschema] of Object.entries(value ?? {})) {
          const where = `${path}/${keyword}/${name}`;
          if (!inConstraint && !described(subschema)) {
            problems.push(where);
          }
          walk(subschema, where, inConstraint);
        }
        continue;
      }
      if (keyword === 'prefixItems' && Array.isArray(value)) {
        value.forEach((slot, index) => {
          const where = `${path}/prefixItems/${index}`;
          if (!inConstraint && !described(slot)) {
            problems.push(where);
          }
          walk(slot, where, inConstraint);
        });
        continue;
      }
      if (['oneOf', 'anyOf', 'allOf'].includes(keyword) && Array.isArray(value)) {
        value.forEach((branch, index) => walk(branch, `${path}/${keyword}/${index}`, inConstraint));
        continue;
      }
      if (['if', 'then', 'else', 'not'].includes(keyword)) {
        walk(value, `${path}/${keyword}`, true);
        continue;
      }
      if (['items', 'contains', 'additionalProperties', 'propertyNames'].includes(keyword)) {
        walk(value, `${path}/${keyword}`, inConstraint);
      }
    }
  };

  walk(schema, '#', false);
  return problems;
}

export function runSchemaDefsCheck({schemaPath, casesPath}) {
  const schema = readJson(schemaPath, 'schema');
  const lines = [`schema definitions: ${schemaPath}`];
  const problems = [];

  const ajv = createValidator();
  try {
    ajv.addSchema(schema);
  } catch (error) {
    problems.push(`the document does not compile: ${error.message}`);
    return {lines, problems, compiled: 0, cases: 0};
  }

  const definitionNames = Object.keys(schema.$defs ?? {});
  let compiled = 0;
  const validators = new Map();
  for (const name of definitionNames) {
    const reference = `${schema.$id}#/$defs/${name}`;
    try {
      const validate = ajv.getSchema(reference);
      if (typeof validate !== 'function') {
        problems.push(`${name} did not resolve from ${reference}`);
        continue;
      }
      validators.set(name, validate);
      compiled += 1;
    } catch (error) {
      problems.push(`${name} does not compile: ${error.message}`);
    }
  }
  lines.push(`compiled: ${compiled} of ${definitionNames.length} definition(s) with Ajv 2020-12 in strict mode`);

  const undescribed = findUndescribed(schema);
  if (undescribed.length > 0) {
    for (const where of undescribed) {
      problems.push(`${where} has no description; every definition and property needs user-facing help text`);
    }
  } else {
    lines.push('descriptions: every definition, property and tuple slot carries its own text');
  }

  const cases = readJson(casesPath, 'cases').cases ?? [];
  let checked = 0;
  for (const [index, testCase] of cases.entries()) {
    const validate = validators.get(testCase.def);
    if (validate === undefined) {
      problems.push(`case ${index} names the unknown definition ${JSON.stringify(testCase.def)}`);
      continue;
    }
    const actual = validate(testCase.value) === true;
    checked += 1;
    if (actual !== testCase.valid) {
      const detail = actual
        ? 'it was accepted'
        : `it was rejected: ${ajv.errorsText(validate.errors, {separator: '; '})}`;
      problems.push(
        `case ${index} (${testCase.def}) expected ${testCase.valid ? 'valid' : 'invalid'} but ${detail}` +
          (testCase.note === undefined ? '' : ` — ${testCase.note}`),
      );
    }
  }
  lines.push(`cases: ${checked} of ${cases.length} from ${casesPath}`);

  return {lines, problems, compiled, cases: cases.length};
}

function parseArguments(argv) {
  const options = {
    schemaPath: join(process.cwd(), DEFAULT_SCHEMA),
    casesPath: join(process.cwd(), DEFAULT_CASES),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === '--schema' || flag === '--cases') {
      if (value === undefined) {
        throw new UsageError(`${flag} needs a path`);
      }
      options[flag === '--schema' ? 'schemaPath' : 'casesPath'] = resolve(value);
      index += 1;
    } else {
      throw new UsageError(`unknown argument ${JSON.stringify(flag)}`);
    }
  }
  return options;
}

function main(argv) {
  let options;
  try {
    options = parseArguments(argv);
  } catch (error) {
    process.stderr.write(`check-schema-defs: ${error.message}\n`);
    process.stderr.write('usage: node scripts/check-schema-defs.mjs [--schema <file>] [--cases <file>]\n');
    return 2;
  }

  let result;
  try {
    result = runSchemaDefsCheck(options);
  } catch (error) {
    process.stderr.write(`check-schema-defs: ${error.message}\n`);
    return 2;
  }

  const lines = [...result.lines];
  if (result.problems.length === 0) {
    lines.push('result: pass');
  } else {
    lines.push(`result: FAIL — ${result.problems.length} problem(s)`);
    for (const problem of result.problems) {
      lines.push(`  ${problem}`);
    }
  }
  process.stdout.write(`${lines.join('\n')}\n`);
  return result.problems.length === 0 ? 0 : 1;
}

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href) {
  process.exitCode = main(process.argv.slice(2));
}
