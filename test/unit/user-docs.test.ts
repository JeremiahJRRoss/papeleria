/**
 * The documentation: README.md at the repository root, the four documents
 * under docs/ (INSTALLATION.md, USER_MANUAL.md, ARCHITECTURE.md and
 * LICENSING.md) with the records beside them, and installers/README.md. W5A
 * wrote this check for the user guide in docs/user/ (D121); it was retargeted
 * when the application moved to the repository root, where these five
 * documents replace that guide.
 *
 * Links. README.md, every Markdown file directly in docs/ and
 * installers/README.md are parsed with markdown-it as GitHub renders them
 * (raw HTML read for its href and src, bare web and e-mail addresses made
 * links), and every link and image they hold must resolve: a relative path to
 * a file or folder that exists inside the repository, never inside reference/
 * (a test fixture, not Papeleria's instructions), and a #fragment to a heading
 * of the Markdown file it names, by GitHub's slugs. An external address in a
 * document a reader follows must be https on one of the hosts listed here; the
 * licensing and dependency records, which cite their sources, may name any
 * https address and the e-mail addresses in their copyright lines. Any other
 * scheme, a //host and a /root path are refused. Code spans and blocks are not
 * links, so a path the docs mention in code may name a file still to come.
 *
 * Address. No page names the repository address the documents were drafted
 * with, in a link, in code or in prose.
 *
 * Pages. README.md links each of the four documents, and each links back.
 *
 * W5A's rule coverage (every rule of the ERD's RULE catalogue with a fix in
 * troubleshooting.md) is not carried over: USER_MANUAL.md gives the rules as a
 * table, and retargeting that check to it is a follow-up.
 *
 * The checks are pure functions over text, and each is shown to fail on a
 * planted mistake before it is trusted with the real pages.
 */
import assert from 'node:assert/strict';
import {existsSync, readFileSync, readdirSync, statSync} from 'node:fs';
import {dirname, extname, join, relative, resolve, sep} from 'node:path';
import {test} from 'node:test';

import markdownIt, {type Token} from 'markdown-it';

import {applicationRoot} from '../helpers/paths.js';

const README = join(applicationRoot, 'README.md');
const DOCS = join(applicationRoot, 'docs');
const INSTALLERS_README = join(applicationRoot, 'installers', 'README.md');
const REPOSITORY = applicationRoot;
const REFERENCE = join(applicationRoot, 'reference');

/** The four documents README.md introduces, in docs/. */
const DOCUMENTS = ['INSTALLATION.md', 'USER_MANUAL.md', 'ARCHITECTURE.md', 'LICENSING.md'];

/** The hosts a document a reader follows may link to, over https: the repositories on GitHub, and Node.js's downloads. */
const READER_HOSTS: ReadonlySet<string> = new Set(['github.com', 'nodejs.org']);

/**
 * The records that cite their sources: each upstream by its own https address, and each copyright
 * holder by the e-mail address the upstream licence gives, which GitHub makes a mailto: link.
 */
const RECORDS: ReadonlySet<string> = new Set(['docs/LICENSING.md', 'docs/DEPENDENCIES.md']);

/** The owner and name of the repository the five documents were moved to for the release candidate, which no page may name now that the application is back in JeremiahJRRoss/papeleria. */
const FORMER_ADDRESS = /\bJeremiahJRRoss\/rc_papeleria(?![\w-])/;

const md = markdownIt({html: true, linkify: true, typographer: false});
// GitHub links a bare address only with its scheme (or www.): `install.md` in a sentence is not a link.
md.linkify.set({fuzzyLink: false});

// ---------------------------------------------------------------------------
// Markdown reading

function walk(tokens: readonly Token[], visit: (token: Token) => void): void {
  for (const token of tokens) {
    visit(token);
    if (token.children !== null) {
      walk(token.children, visit);
    }
  }
}

/** The text of a heading as GitHub slugs it: its text and code, without the markup. */
function inlineText(token: Token): string {
  return (token.children ?? [])
    .filter((child) => child.type === 'text' || child.type === 'code_inline')
    .map((child) => child.content)
    .join('');
}

/** GitHub's heading anchor (github-slugger): lower case; every character but letters, marks, digits, spaces, `-` and `_` removed; spaces to hyphens. */
function slugOf(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
    .replace(/ /g, '-');
}

type Heading = {readonly level: number; readonly text: string; readonly slug: string; readonly line: number};

/** Every heading, with the anchor GitHub gives it: a repeated slug takes -1, -2 in order. */
function headingsOf(markdown: string): Heading[] {
  const tokens = md.parse(markdown, {});
  const seen = new Map<string, number>();
  const headings: Heading[] = [];
  tokens.forEach((token, index) => {
    if (token.type !== 'heading_open') {
      return;
    }
    const text = inlineText(tokens[index + 1]!);
    const base = slugOf(text);
    let slug = base;
    while (seen.has(slug)) {
      const count = seen.get(base)! + 1;
      seen.set(base, count);
      slug = `${base}-${count}`;
    }
    seen.set(slug, 0);
    headings.push({level: Number(token.tag.slice(1)), text, slug, line: (token.map?.[0] ?? 0) + 1});
  });
  return headings;
}

type Link = {readonly target: string; readonly line: number};

/**
 * An `href` or `src` attribute in raw HTML, with its value double-quoted, single-quoted or unquoted, as HTML
 * allows; the name must start the attribute, so `data-href` is not a link.
 */
const HTML_LINK_ATTRIBUTE = /(?<=[\s"'/])(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi;

/** Every link and image address, inline, reference, autolink, bare address or raw HTML, with its line. */
function linksOf(markdown: string): Link[] {
  const links: Link[] = [];
  let line = 0;
  walk(md.parse(markdown, {}), (token) => {
    if (token.map !== null) {
      line = token.map[0] + 1;
    }
    const target = token.type === 'link_open' ? token.attrGet('href') : token.type === 'image' ? token.attrGet('src') : null;
    if (target !== null) {
      links.push({target: String(target), line});
    }
    if (token.type === 'html_inline' || token.type === 'html_block') {
      for (const match of token.content.matchAll(HTML_LINK_ATTRIBUTE)) {
        links.push({target: (match[1] ?? match[2] ?? match[3])!, line});
      }
    }
  });
  return links;
}

// ---------------------------------------------------------------------------
// The checks, as pure functions

type Files = {
  /** Whether the absolute path exists, and whether it is a folder. */
  readonly kind: (path: string) => 'file' | 'folder' | null;
  /** The heading anchors of a Markdown file. */
  readonly anchors: (path: string) => ReadonlySet<string>;
};

/** Why an external address is refused on the page named, or null when it is allowed. */
function externalProblem(name: string, target: string): string | null {
  const record = RECORDS.has(name);
  if (record && /^mailto:[^@\s/]+@[^@\s/]+$/i.test(target)) {
    return null;
  }
  let address: URL;
  try {
    address = new URL(target);
  } catch {
    return 'is not a valid address';
  }
  if (address.protocol !== 'https:') {
    return 'is an external link that is not https';
  }
  if (!record && !READER_HOSTS.has(address.hostname)) {
    return 'is an external link to a host that is not listed';
  }
  return null;
}

/** Every problem with the links of one page, as `file:line: problem`. */
function linkProblems(file: string, markdown: string, files: Files): string[] {
  const problems: string[] = [];
  const name = relative(applicationRoot, file).split(sep).join('/');
  for (const {target, line} of linksOf(markdown)) {
    const at = `${name}:${line}: ${JSON.stringify(target)}`;
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) {
      const problem = externalProblem(name, target);
      if (problem !== null) {
        problems.push(`${at} ${problem}`);
      }
      continue;
    }
    if (target.startsWith('//') || target.startsWith('\\')) {
      problems.push(`${at} is protocol-relative`);
      continue;
    }
    if (target.startsWith('/')) {
      problems.push(`${at} starts at the root, which only resolves on one host`);
      continue;
    }
    const hash = target.indexOf('#');
    const pathPart = hash === -1 ? target : target.slice(0, hash);
    const fragment = hash === -1 ? null : target.slice(hash + 1);
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathPart);
    } catch {
      problems.push(`${at} is not valid percent-encoding`);
      continue;
    }
    const resolved = decoded === '' ? file : resolve(dirname(file), decoded);
    if (!(resolved + sep).startsWith(REPOSITORY + sep)) {
      problems.push(`${at} leaves the repository`);
      continue;
    }
    if ((resolved + sep).startsWith(REFERENCE + sep)) {
      problems.push(`${at} points into reference/, a test fixture, not Papeleria's instructions`);
      continue;
    }
    const kind = files.kind(resolved);
    if (kind === null) {
      problems.push(`${at} names a file that does not exist`);
      continue;
    }
    if (fragment !== null) {
      if (kind !== 'file' || extname(resolved) !== '.md') {
        problems.push(`${at} has a #fragment on something that is not a Markdown file`);
      } else if (!files.anchors(resolved).has(fragment)) {
        problems.push(`${at} names no heading of ${relative(applicationRoot, resolved).split(sep).join('/')}`);
      }
    }
  }
  return problems;
}

/** The lines of a page that name the former repository address, as `file:line`. */
function formerAddressLines(name: string, markdown: string): string[] {
  return markdown.split('\n').flatMap((text, index) => (FORMER_ADDRESS.test(text) ? [`${name}:${index + 1}`] : []));
}

// ---------------------------------------------------------------------------
// The real pages

/** README.md, the Markdown files directly in docs/, and installers/README.md. */
function pages(): string[] {
  const docs = readdirSync(DOCS, {withFileTypes: true})
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => join(DOCS, entry.name))
    .sort();
  return [README, ...docs, INSTALLERS_README];
}

const anchorCache = new Map<string, ReadonlySet<string>>();

const disk: Files = {
  kind: (path) => {
    if (!existsSync(path)) {
      return null;
    }
    return statSync(path).isDirectory() ? 'folder' : 'file';
  },
  anchors: (path) => {
    let anchors = anchorCache.get(path);
    if (anchors === undefined) {
      anchors = new Set(headingsOf(readFileSync(path, 'utf8')).map((heading) => heading.slug));
      anchorCache.set(path, anchors);
    }
    return anchors;
  },
};

test('GitHub anchors: text and code kept, punctuation and markup dropped, repeats numbered', () => {
  const headings = headingsOf('# `schema` (piece)\n\n## R11 A dependency\'s licence\n\n## What dist/ holds\n\n## Intro\n\n## Intro\n\n## Intro\n');
  assert.deepEqual(
    headings.map((heading) => heading.slug),
    ['schema-piece', 'r11-a-dependencys-licence', 'what-dist-holds', 'intro', 'intro-1', 'intro-2'],
  );
});

test('the link check is not vacuous: each kind of broken link is reported', () => {
  const file = join(DOCS, 'planted.md');
  const planted = [
    '# Planted',
    '',
    '[missing](no-such-page.md) [bad anchor](USER_MANUAL.md#no-such-heading) [own anchor](#planted) [own bad](#nowhere)',
    '[kit](../reference/README.md) [out](../../../../etc/passwd) [root](/docs/INSTALLATION.md) [proto](//example.org)',
    '[web](https://example.org/page) [mail](mailto:someone@example.org) <a href="missing-too.md">raw</a> https://example.com/bare',
    '[fragment on a folder](../docs#top) [listed](https://nodejs.org/en/download) [present](INSTALLATION.md) `[in code](nowhere.md)`',
    '<a href=unquoted-missing.md>unquoted</a> <img src=\'single-missing.png\' alt=""> <a data-href="not-a-link.md" href=INSTALLATION.md>data</a>',
    '[plain http](http://nodejs.org/en/download) [up](../README.md) someone@example.org',
  ].join('\n');
  const files: Files = {
    kind: (path) => (path === join(DOCS, 'INSTALLATION.md') || path === join(DOCS, 'USER_MANUAL.md') || path === README || path === file ? 'file' : path === DOCS ? 'folder' : existsSync(path) ? 'file' : null),
    anchors: (path) => (path === file ? new Set(['planted']) : new Set(['first-piece'])),
  };
  const problems = linkProblems(file, planted, files);
  const expected = [
    '"no-such-page.md" names a file that does not exist',
    '"USER_MANUAL.md#no-such-heading" names no heading',
    '"#nowhere" names no heading',
    '"../reference/README.md" points into reference/',
    '"../../../../etc/passwd" leaves the repository',
    '"/docs/INSTALLATION.md" starts at the root',
    '"//example.org" is protocol-relative',
    '"https://example.org/page" is an external link to a host that is not listed',
    '"mailto:someone@example.org" is an external link that is not https',
    '"missing-too.md" names a file that does not exist',
    '"https://example.com/bare" is an external link to a host that is not listed',
    '"../docs#top" has a #fragment on something that is not a Markdown file',
    '"unquoted-missing.md" names a file that does not exist',
    '"single-missing.png" names a file that does not exist',
    '"http://nodejs.org/en/download" is an external link that is not https',
    '"mailto:someone@example.org" is an external link that is not https',
  ];
  for (const fragment of expected) {
    assert.ok(problems.some((problem) => problem.includes(fragment)), `expected a problem containing ${fragment}; got:\n${problems.join('\n')}`);
  }
  assert.equal(problems.length, expected.length, `only the planted links are problems:\n${problems.join('\n')}`);
});

test('a record may cite any https source and its copyright holders\' e-mail addresses, and nothing else external', () => {
  const record = join(DOCS, 'LICENSING.md');
  const cited = [
    '# Record',
    '',
    '| lib | Someone <someone@example.org> | https://gitlab.example.org/lib | [text](../LICENSE) |',
    '[plain http](http://example.org/lib) [ftp](ftp://example.org/lib) [proto](//example.org/lib)',
  ].join('\n');
  const files: Files = {kind: (path) => (path === join(applicationRoot, 'LICENSE') ? 'file' : null), anchors: () => new Set()};
  const problems = linkProblems(record, cited, files);
  assert.deepEqual(
    problems.map((problem) => problem.slice(problem.indexOf(': ') + 2)),
    [
      '"http://example.org/lib" is an external link that is not https',
      '"ftp://example.org/lib" is an external link that is not https',
      '"//example.org/lib" is protocol-relative',
    ],
  );
  assert.equal(linkProblems(join(DOCS, 'planted.md'), cited, files).filter((problem) => problem.includes('host that is not listed')).length, 1, 'a page a reader follows may not cite that source');
});

test('every link in README.md, docs/ and installers/README.md resolves: files, folders, heading anchors and allowed external addresses', () => {
  const files = pages();
  for (const document of DOCUMENTS) {
    assert.ok(files.includes(join(DOCS, document)), `docs/${document} is checked`);
  }
  assert.ok(files.length >= 10, `README.md, docs/ and installers/README.md hold their pages (found ${files.length} Markdown files)`);
  const problems = files.flatMap((file) => linkProblems(file, readFileSync(file, 'utf8'), disk));
  assert.deepEqual(problems, []);
  const linked = files.reduce((sum, file) => sum + linksOf(readFileSync(file, 'utf8')).length, 0);
  assert.ok(linked > 100, `the pages carry their cross-links (found ${linked})`);
});

test('the former repository address is found in a link, in code and in prose', () => {
  const text = [
    '# T',
    '',
    '[Repository](https://example.org/JeremiahJRRoss/rc_papeleria)',
    '',
    '```sh',
    'cd JeremiahJRRoss/rc_papeleria',
    '```',
    'Clone JeremiahJRRoss/rc_papeleria first.',
    'Not these: JeremiahJRRoss/papeleria, JeremiahJRRoss/rc_papeleria-notes.',
  ].join('\n');
  assert.deepEqual(formerAddressLines('planted.md', text), ['planted.md:3', 'planted.md:6', 'planted.md:8']);
});

test('no page names the former repository address', () => {
  const found = pages().flatMap((file) => formerAddressLines(relative(applicationRoot, file).split(sep).join('/'), readFileSync(file, 'utf8')));
  assert.deepEqual(found, []);
});

test('README.md links each of the four documents, and each links back to it', () => {
  const index = new Set(linksOf(readFileSync(README, 'utf8')).map((link) => link.target));
  for (const document of DOCUMENTS) {
    assert.ok(existsSync(join(DOCS, document)), `docs/${document} exists`);
    assert.ok(index.has(`docs/${document}`), `README.md links docs/${document}`);
    const targets = linksOf(readFileSync(join(DOCS, document), 'utf8')).map((link) => link.target);
    assert.ok(targets.includes('../README.md'), `docs/${document} links back to README.md`);
  }
});
