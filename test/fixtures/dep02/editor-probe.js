/**
 * DEP02 probe application.
 *
 * The smallest thing that answers the gate: a real CodeMirror 6 editor in a real
 * browser, in YAML and in JSON mode, driven by codemirror-json-schema against a
 * 2020-12 schema whose properties are `$ref`s into shared `$defs` — the shape
 * each template schema will have. Everything it learns is written to
 * window.__dep02 for the driver to read.
 *
 * This is a spike, not the editor. The editor source belongs to W3A at M2.
 */
import {EditorState} from '@codemirror/state';
import {EditorView, keymap} from '@codemirror/view';
import {defaultKeymap} from '@codemirror/commands';
import {
  autocompletion,
  startCompletion,
  currentCompletions,
  completionStatus,
} from '@codemirror/autocomplete';
import {lintGutter, forceLinting} from '@codemirror/lint';
import {hoverTooltip} from '@codemirror/view';
import {yaml, yamlLanguage} from '@codemirror/lang-yaml';
import {json, jsonLanguage, jsonParseLinter} from '@codemirror/lang-json';
import {linter} from '@codemirror/lint';
import {
  jsonCompletion,
  jsonSchemaHover,
  jsonSchemaLinter,
  stateExtensions,
} from 'codemirror-json-schema';
import {yamlCompletion, yamlSchemaHover, yamlSchemaLinter} from 'codemirror-json-schema/yaml';

window.__dep02 = {ready: false, errors: []};
window.__dep02phase = 'boot';
window.__dep02setPhase = (phase) => {
  window.__dep02phase = phase;
};

function record(key, value) {
  window.__dep02[key] = value;
}

/** A 2020-12 schema whose properties are $refs into shared $defs. */
const schema = window.__DEP02_SCHEMA__;

function makeView({parent, mode, doc}) {
  // The recommended configuration, and the point of the spike: the adapter
  // supplies completion and hover only. Its bundled jsonSchema()/yamlSchema()
  // helpers also install schema linters, and those linters evaluate with
  // json-schema-library's draft 4 and draft 7 engines, which cannot read the
  // 2020-12 keywords this project's schemas use. Keeping them would put wrong
  // diagnostics beside the authoritative Ajv report. JSON syntax linting stays,
  // because that is the language package, not the schema adapter.
  const extensions = [
    keymap.of(defaultKeymap),
    autocompletion({activateOnTyping: false}),
    lintGutter(),
    stateExtensions(schema),
  ];
  if (mode === 'yaml') {
    extensions.push(
      yaml(),
      yamlLanguage.data.of({autocomplete: yamlCompletion()}),
      hoverTooltip(yamlSchemaHover()),
    );
  } else {
    extensions.push(
      json(),
      linter(jsonParseLinter()),
      jsonLanguage.data.of({autocomplete: jsonCompletion()}),
      hoverTooltip(jsonSchemaHover()),
    );
  }
  return new EditorView({state: EditorState.create({doc, extensions}), parent});
}

try {
  const yamlView = makeView({
    parent: document.getElementById('yaml'),
    mode: 'yaml',
    doc: 'schema: 1\ntemplate: deck\ntitle: A deck\n',
  });
  const jsonView = makeView({
    parent: document.getElementById('json'),
    mode: 'json',
    doc: '{\n  "schema": 1,\n  "template": "deck",\n  "title": "A deck"\n}',
  });

  record('views', {yaml: true, json: true});

  // --- completion, asked for explicitly the way Ctrl-Space does
  window.__dep02probeCompletion = async (which) => {
    const view = which === 'yaml' ? yamlView : jsonView;
    view.focus();
    const text = view.state.doc.toString();
    // YAML appends at the end; JSON must land inside the object, after the last
    // property and before the closing brace, or the position is not in the tree.
    const at = which === 'yaml' ? view.state.doc.length : text.lastIndexOf('"\n}') + 1;
    const insert = which === 'yaml' ? 'st' : ',\n  "st"';
    const caret = which === 'yaml' ? at + insert.length : at + insert.length - 1;
    view.dispatch({changes: {from: at, insert}, selection: {anchor: caret}});
    startCompletion(view);
    const started = performance.now();
    for (let i = 0; i < 100; i += 1) {
      await new Promise((r) => setTimeout(r, 20));
      if (completionStatus(view.state) === 'active') {
        const options = currentCompletions(view.state).map((c) => c.label);
        return {options, ms: Math.round(performance.now() - started)};
      }
    }
    return {options: [], ms: Math.round(performance.now() - started), timedOut: true};
  };

  // --- the same, with no prefix typed, so the full offer is visible
  window.__dep02probeCompletionAll = async (which) => {
    const view = which === 'yaml' ? yamlView : jsonView;
    view.focus();
    const text = view.state.doc.toString();
    const at = which === 'yaml' ? view.state.doc.length : text.lastIndexOf('"\n}') + 1;
    const insert = which === 'yaml' ? 'x' : ',\n  "x"';
    const caret = which === 'yaml' ? at + 1 : at + insert.length - 1;
    view.dispatch({changes: {from: at, insert}, selection: {anchor: caret}});
    startCompletion(view);
    for (let i = 0; i < 100; i += 1) {
      await new Promise((r) => setTimeout(r, 20));
      if (completionStatus(view.state) === 'active') {
        return {options: currentCompletions(view.state).map((c) => c.label)};
      }
    }
    return {options: [], timedOut: true};
  };

  // --- value completion behind a $ref: does it offer the enum members?
  //
  // The caret must sit inside a *terminated* string. Leaving the quote open
  // makes the document unparseable at that point and the source returns nothing,
  // which looks exactly like "the adapter cannot do value completion".
  window.__dep02probeValueCompletion = async (which, property, prefix) => {
    const view = which === 'yaml' ? yamlView : jsonView;
    view.focus();
    // Start from a known-good document. Earlier probes append to the view, and a
    // half-typed key left behind by one of them would make this one look like an
    // adapter failure when it is only a dirty fixture.
    const base =
      which === 'yaml'
        ? 'schema: 1\ntemplate: deck\ntitle: A deck\n'
        : '{\n  "schema": 1,\n  "template": "deck",\n  "title": "A deck"\n}';
    view.dispatch({changes: {from: 0, to: view.state.doc.length, insert: base}});
    await new Promise((r) => setTimeout(r, 80));
    const text = view.state.doc.toString();
    const typed = prefix ?? '';
    let at;
    let insert;
    let caret;
    if (which === 'yaml') {
      at = view.state.doc.length;
      insert = `${property}: ${typed}\n`;
      caret = at + `${property}: ${typed}`.length;
    } else {
      at = text.lastIndexOf('"\n}') + 1;
      insert = `,\n  "${property}": "${typed}"`;
      caret = at + insert.length - 1;
    }
    view.dispatch({changes: {from: at, insert}, selection: {anchor: caret}});
    await new Promise((r) => setTimeout(r, 60));
    startCompletion(view);
    for (let i = 0; i < 80; i += 1) {
      await new Promise((r) => setTimeout(r, 20));
      if (completionStatus(view.state) === 'active') {
        return {options: currentCompletions(view.state).map((c) => c.label)};
      }
    }
    return {options: [], timedOut: true};
  };

  // --- hover at an arbitrary offset, for tuple slots and nested members
  window.__dep02probeHoverAt = async (which, offset) => {
    const view = which === 'yaml' ? yamlView : jsonView;
    const doHover = which === 'yaml' ? yamlSchemaHover() : jsonSchemaHover();
    const result = await doHover(view, offset, 1);
    const dom = result && typeof result.create === 'function' ? result.create(view).dom : null;
    return {found: Boolean(result), text: dom ? dom.textContent.slice(0, 400) : null};
  };

  /** Replaces the whole document, then hovers the first occurrence of a needle. */
  window.__dep02probeDocHover = async (which, doc, needle, offsetInNeedle) => {
    const view = which === 'yaml' ? yamlView : jsonView;
    view.dispatch({changes: {from: 0, to: view.state.doc.length, insert: doc}});
    await new Promise((r) => setTimeout(r, 120));
    const at = doc.indexOf(needle);
    if (at < 0) return {found: false, reason: 'needle absent'};
    return window.__dep02probeHoverAt(which, at + (offsetInNeedle ?? 0));
  };

  /** Completion inside an arbitrary document, at a marker position. */
  window.__dep02probeDocCompletion = async (which, doc, marker) => {
    const view = which === 'yaml' ? yamlView : jsonView;
    const at = doc.indexOf(marker);
    const clean = doc.replace(marker, '');
    view.dispatch({changes: {from: 0, to: view.state.doc.length, insert: clean}, selection: {anchor: at}});
    view.focus();
    await new Promise((r) => setTimeout(r, 120));
    startCompletion(view);
    for (let i = 0; i < 80; i += 1) {
      await new Promise((r) => setTimeout(r, 20));
      if (completionStatus(view.state) === 'active') {
        return {options: currentCompletions(view.state).map((c) => c.label)};
      }
    }
    return {options: [], timedOut: true};
  };

  // --- does the adapter understand 2020-12 keywords, or only draft 4 / 7?
  window.__dep02probe2020 = async () => {
    const draftModule = await import('json-schema-library');
    const out = {};
    const tuple = {
      type: 'object',
      properties: {
        focal_point: {
          type: 'array',
          prefixItems: [
            {type: 'number', minimum: 0, maximum: 100},
            {type: 'number', minimum: 0, maximum: 100},
          ],
          items: false,
          minItems: 2,
          maxItems: 2,
        },
      },
    };
    // A value that 2020-12 rejects (a third item, and one out of range) and that
    // a draft-4 or draft-7 evaluator cannot see, because it has no prefixItems.
    for (const [name, Draft] of [['Draft04', draftModule.Draft04], ['Draft07', draftModule.Draft07]]) {
      if (!Draft) { out[name] = 'not exported'; continue; }
      try {
        const valid = new Draft(tuple).validate({focal_point: [50, 50]});
        const invalid = new Draft(tuple).validate({focal_point: [50, 500]});
        out[name] = {
          rejectsAValidTuple: valid.length > 0,
          onValid: valid.map((e) => e.message).slice(0, 2),
          onInvalid: invalid.map((e) => e.message).slice(0, 2),
        };
      } catch (error) {
        out[name] = `threw: ${String(error).slice(0, 120)}`;
      }
    }
    out.availableDrafts = Object.keys(draftModule).filter((k) => /^Draft/.test(k));
    return out;
  };

  // --- hover help, straight from the adapter rather than through a mouse event
  window.__dep02probeHover = async (which, needle) => {
    const view = which === 'yaml' ? yamlView : jsonView;
    const text = view.state.doc.toString();
    const pos = text.indexOf(needle);
    if (pos < 0) return {found: false, reason: `${needle} is not in the document`};
    const doHover = which === 'yaml' ? yamlSchemaHover() : jsonSchemaHover();
    const result = await doHover(view, pos, 1);
    const dom = result && typeof result.create === 'function' ? result.create(view).dom : null;
    return {found: Boolean(result), text: dom ? dom.textContent.slice(0, 400) : null, pos};
  };

  // --- what the adapter's own linter says, so duplicate diagnostics are visible
  window.__dep02probeDiagnostics = async (which, doc) => {
    const view = which === 'yaml' ? yamlView : jsonView;
    view.dispatch({changes: {from: 0, to: view.state.doc.length, insert: doc}});
    forceLinting(view);
    await new Promise((r) => setTimeout(r, 300));
    const lint = which === 'yaml' ? yamlSchemaLinter() : jsonSchemaLinter();
    const diagnostics = await lint(view);
    return (diagnostics || []).map((d) => ({from: d.from, to: d.to, severity: d.severity, message: d.message}));
  };

  // --- edit and paste latency, measured on the real view
  window.__dep02probeLatency = async (which, iterations) => {
    const view = which === 'yaml' ? yamlView : jsonView;
    const samples = [];
    for (let i = 0; i < iterations; i += 1) {
      const started = performance.now();
      view.dispatch({changes: {from: view.state.doc.length, insert: `\n# edit ${i}`}});
      await new Promise((r) => requestAnimationFrame(() => r()));
      samples.push(performance.now() - started);
    }
    const pasteStarted = performance.now();
    view.dispatch({changes: {from: view.state.doc.length, insert: '\n' + '# pasted line\n'.repeat(500)}});
    await new Promise((r) => requestAnimationFrame(() => r()));
    const paste = performance.now() - pasteStarted;
    samples.sort((a, b) => a - b);
    return {
      editCount: samples.length,
      editMedianMs: Math.round(samples[Math.floor(samples.length / 2)] * 100) / 100,
      editMaxMs: Math.round(samples[samples.length - 1] * 100) / 100,
      pasteMs: Math.round(paste * 100) / 100,
    };
  };

  window.__dep02.ready = true;
} catch (error) {
  window.__dep02.errors.push(String(error && error.stack ? error.stack : error));
  window.__dep02.ready = false;
}
