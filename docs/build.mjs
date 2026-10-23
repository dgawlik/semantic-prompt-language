import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { Marked, Renderer } from 'marked';
import hljs from 'highlight.js/lib/core';
import python from 'highlight.js/lib/languages/python';
import bash from 'highlight.js/lib/languages/bash';
import json from 'highlight.js/lib/languages/json';
import javascript from 'highlight.js/lib/languages/javascript';
import ebnf from 'highlight.js/lib/languages/ebnf';

const output = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(output);
const source = path.join(root, 'docs-template');
const repository = 'https://github.com/dgawlik/semantic-prompt-language';
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'lang', 'package.json'), 'utf8'));
const check = process.argv.includes('--check');
if (process.argv.slice(2).some((arg) => arg !== '--check')) throw new Error('Usage: node docs/build.mjs [--check]');

const pages = [
    ['Introduction', 'index', 'Introduction', 'Start here', 'book'],
    ['Getting-started', 'getting-started', 'Getting started', 'Start here', 'arrow'],
    ['Language', 'language', 'Language basics', 'The language', 'code'],
    ['LLM-commands', 'llm-commands', 'Generation & agents', 'The language', 'spark'],
    ['Restrictions', 'restrictions', 'Restrictions', 'The language', 'shield'],
    ['Failures', 'failures', 'Failures & errors', 'The language', 'warning'],
    ['Builtins', 'builtins', 'Built-ins', 'Reference', 'blocks'],
    ['CLI', 'cli', 'CLI & runtime', 'Reference', 'terminal'],
    ['Grammar', 'grammar', 'Grammar', 'Reference', 'braces'],
    ['Examples', 'examples', 'Examples', 'Guides', 'layers'],
    ['Editor', 'editor', 'VS Code extension', 'Guides', 'edit'],
    ['Internals', 'internals', 'Architecture', 'Guides', 'network'],
].map(([file, slug, label, group, icon]) => ({ file, slug, label, group, icon }));
const fingerprint = createHash('sha256');
for (const file of [
    fileURLToPath(import.meta.url),
    ...['style.css', 'site.js', 'favicon.svg'].map((file) => path.join(output, 'assets', file)),
    ...pages.map((page) => path.join(source, `${page.file}.md`)),
]) fingerprint.update(fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'));
const revision = fingerprint.digest('hex').slice(0, 12);

const legacy = {
    index: { 'why-spl': 'why', 'design-tenets': 'tenets', 'how-a-run-works': 'how-it-works', 'where-to-next': 'explore' },
    'getting-started': { 'install--build': 'install', 'your-first-run': 'first-run', 'write-a-script': 'hello', 'replay-generation-offline': 'record-replay', 'breaking-changes-in-03': 'migration', 'repository-tour': 'repo-tour', 'run-the-tests': 'tests' },
    language: { 'program-structure': 'structure', 'block-and-conditional-expressions': 'block-expressions', 'types--values': 'types', 'strings--interpolation': 'strings', 'quote-styles--escapes': 'quotes', 'if--elif--else': 'if', 'for--while': 'loops', 'built-ins': 'builtins-brief' },
    'llm-commands': { 'generation-ask': ['ask', 'generation-'], 'composable-modifiers': 'modifiers', 'validated-structured-output': 'schema', 'output-formats': 'fmt-object', 'bounded-repair-not-action-retry': 'repairs', 'think-shorthand': 'think', 'explicit-agents': 'agent', 'scoped-guidance-enforce--forbid': 'constraints', 'exact-raw-tools': 'tools' },
    restrictions: { 'the-four-forms': 'forms', 'two-layers-of-enforcement': 'enforcement', 'matching-rules': 'rules', 'file-system': 'fs', network: 'net', executables: 'exec', 'mcp-servers-and-tools': 'mcp', 'what-is-covered': 'what-is-guarded' },
    failures: { 'failure-payload': 'payload', 'try--except': 'try-except', assertions: 'assert', 'explicit-failure': 'fail', 'successful-termination': 'success', 'bounded-generation-repair': 'retry', 'uncaught-failures-and-cli-errors': 'uncaught' },
    builtins: { 'raw-tools-no-model-round-trip': 'raw-tools', 'types--conversion': 'conversion', 'numbers--sequences': 'numbers', 'dicts--json': 'dict-fns', 'putting-it-together': 'example' },
    cli: { 'output-streams--exit-codes': 'streams', 'mcp-configuration': 'mcp', 'remote-http-or-sse-server': 'mcp-http', 'local-stdio-server': 'mcp-stdio', 'configuration-fields': 'mcp-fields', 'variables-paths-and-unsupported-settings': 'mcp-variables', 'validate-run-and-restrict-access': 'mcp-usage', 'variable-store': 'store', 'custom-stores': 'custom-store', authentication: 'login', backend: 'backends', 'offline-generation-recordreplay': 'record-replay' },
    grammar: { 'complete-grammar': 'program', 'syntax-versus-semantics': 'semantics' },
    examples: { 'extract-an-invoice': 'extract-invoice', 'code-review-as-a-ci-gate': 'code-review', 'search-with-mcp': 'mcp', 'journal-with-persistent-state': 'journal', 'feature-tours': 'tours', 'basicsspl--functions-objects-and-llm-calls': 'basics', 'hispl--compact-end-to-end-tour': 'hi' },
    editor: { 'develop--test': 'develop' },
    internals: { 'execution-pipeline': 'pipeline', 'generation-and-repair-lifecycle': 'llm-call', 'recording-and-replay': 'recording', 'extension-points': 'extending', 'custom-backend': 'backend-interface', 'custom-store': 'variable-store', validation: 'tests' },
};

const paths = {
    book: '<path d="M4 4h6a3 3 0 0 1 3 3v14a4 4 0 0 0-4-3H4z"/><path d="M13 7a3 3 0 0 1 3-3h5v14h-4a4 4 0 0 0-4 3"/>',
    arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
    code: '<path d="m8 7-5 5 5 5m8-10 5 5-5 5m-3-13-2 16"/>',
    spark: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z"/>',
    shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6z"/><path d="m8 12 3 3 5-6"/>',
    warning: '<path d="m12 3 10 18H2zM12 9v4m0 4h.01"/>',
    blocks: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
    terminal: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="m7 9 3 3-3 3m6 0h4"/>',
    braces: '<path d="M8 3H6v6l-3 3 3 3v6h2m8-18h2v6l3 3-3 3v6h-2"/>',
    layers: '<path d="m12 3 10 5-10 5L2 8zm-9 10 9 5 9-5M3 18l9 5 9-5"/>',
    edit: '<path d="m15 4 5 5M4 20l5-1L21 7a2 2 0 0 0-5-5L4 14z"/>',
    network: '<rect x="8" y="2" width="8" height="6" rx="1"/><rect x="2" y="16" width="7" height="6" rx="1"/><rect x="15" y="16" width="7" height="6" rx="1"/><path d="M12 8v4m-7 4v-4h14v4"/>',
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
    moon: '<path d="M20.8 13A9 9 0 0 1 11 3.2 9 9 0 1 0 20.8 13Z"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
    external: '<path d="M14 3h7v7m0-7L10 14M10 3H3v18h18v-7"/>',
    copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
    chevron: '<path d="m9 5 7 7-7 7"/>',
    close: '<path d="m6 6 12 12M6 18 18 6"/>',
};
const icon = (name) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
const escape = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const plain = (tokens) => tokens.map((token) => token.tokens ? plain(token.tokens) : token.text ?? '').join('');
const headingId = (value) => value.toLowerCase().replace(/[^\p{L}\p{N}_ -]/gu, '').replace(/ /g, '-');

hljs.registerLanguage('spl', (engine) => {
    const language = python(engine);
    language.keywords = {
        keyword: 'let def if elif else for in while return try except assert fail success enforce forbid restrict ask think agent break continue pass and or not',
        literal: 'True False None',
        built_in: 'len str int float bool type list range abs round min max sum sorted reversed enumerate zip any all keys values items json_parse json_stringify log read_file write_file web_fetch web_search shell',
    };
    language.contains.unshift({ scope: 'variable', match: /\$(?:env|args)\b/ });
    return language;
});
for (const [name, grammar] of Object.entries({ bash, sh: bash, json, js: javascript, javascript, ebnf })) hljs.registerLanguage(name, grammar);

function rewriteLink(href, page) {
    if (/^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith('#')) return href;
    const [filename, fragment] = href.split('#');
    const target = path.resolve(source, filename);
    const destination = pages.find((item) => path.join(source, `${item.file}.md`) === target);
    if (destination) return `${destination.slug}.html${fragment ? `#${fragment}` : ''}`;
    if (target === output) return 'index.html';
    if (!fs.existsSync(target)) throw new Error(`${page.file}: unresolved link ${href}`);
    const relative = path.relative(root, target);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`${page.file}: link outside repository: ${href}`);
    return `${repository}/${fs.statSync(target).isDirectory() ? 'tree' : 'blob'}/HEAD/${relative.split(path.sep).map(encodeURIComponent).join('/')}${fragment ? `#${fragment}` : ''}`;
}

function navigation(current, label) {
    return `<nav aria-label="${label}">${[...new Set(pages.map((page) => page.group))].map((group) =>
        `<div class="nav-group"><p class="nav-label">${group}</p><ul>${pages.filter((page) => page.group === group).map((page) =>
            `<li><a href="${page.slug}.html"${current.slug === page.slug ? ' aria-current="page"' : ''}>${icon(page.icon)}<span>${page.label}</span>${current.slug === page.slug ? '<span class="nav-indicator" aria-hidden="true"></span>' : ''}</a></li>`).join('')}</ul></div>`).join('')}</nav>`;
}

function renderPage(page, index) {
    const markdown = fs.readFileSync(path.join(source, `${page.file}.md`), 'utf8');
    const parser = new Marked({ gfm: true });
    const tokens = parser.lexer(markdown);
    if (tokens[0]?.type !== 'heading' || tokens[0].depth !== 1) throw new Error(`${page.file}: expected a page title`);
    const title = plain(tokens.shift().tokens);
    while (tokens[0]?.type === 'space') tokens.shift();
    if (tokens[0]?.type !== 'paragraph') throw new Error(`${page.file}: expected an introductory paragraph`);
    const lead = tokens.shift();
    const headings = [];
    const entries = [{ title, page: page.label, href: `${page.slug}.html`, text: plain(lead.tokens), group: page.group }];
    let currentEntry = entries[0];
    let context = page.label;
    let block = 0;
    let previousDepth = 1;
    const ids = new Set();
    for (let i = 0; i < tokens.length; i++) {
        if (tokens[i].type === 'paragraph' && tokens[i].tokens.length === 1 && tokens[i].tokens[0].type === 'codespan' && /\.\w+$/.test(tokens[i].tokens[0].text)) {
            const next = tokens[i + 1]?.type === 'space' ? i + 2 : i + 1;
            if (tokens[next]?.type === 'code') {
                tokens[next].filename = tokens[i].tokens[0].text;
                tokens.splice(i, next - i);
            }
        }
    }
    const defaultRenderer = new Renderer();
    parser.use({ renderer: {
        heading(token) {
            if (token.depth === 1) throw new Error(`${page.file}: multiple page titles`);
            if (token.depth > previousDepth + 1) throw new Error(`${page.file}: do not skip heading levels`);
            previousDepth = token.depth;
            const text = plain(token.tokens);
            const base = headingId(text);
            let id = base;
            for (let suffix = 1; ids.has(id); suffix++) id = `${base}-${suffix}`;
            ids.add(id);
            context = text;
            headings.push({ id, text, depth: token.depth });
            currentEntry = { title: text, page: page.label, href: `${page.slug}.html#${id}`, text: '', group: page.group };
            entries.push(currentEntry);
            const alias = legacy[page.slug]?.[id];
            const prefix = alias ? [].concat(alias).map((id) => `<span id="${id}" class="anchor-alias" aria-hidden="true"></span>`).join('') : '';
            return `${prefix}<h${token.depth} id="${id}">${this.parser.parseInline(token.tokens)}<a class="heading-anchor" href="#${id}" aria-label="Link to ${escape(text)}">#</a></h${token.depth}>\n`;
        },
        paragraph(token) {
            currentEntry.text += ` ${plain(token.tokens)}`;
            return defaultRenderer.paragraph.call(this, token);
        },
        code(token) {
            const language = token.lang?.split(/\s/)[0] || 'text';
            if (language !== 'text' && !hljs.getLanguage(language)) throw new Error(`${page.file}: unsupported code language ${language}`);
            const content = language === 'text' ? escape(token.text) : hljs.highlight(token.text, { language }).value;
            const filename = token.filename;
            const synced = filename?.endsWith('.spl') && fs.existsSync(path.join(root, 'lang', 'examples', filename));
            const id = `code-${++block}`;
            return `<figure class="code-block"><figcaption><span class="code-dots" aria-hidden="true"><i></i><i></i><i></i></span><span class="code-filename">${escape(filename || language)}</span><span class="code-language">${escape(language)}</span><button type="button" class="copy-button" data-copy="${id}" aria-label="Copy ${escape(filename || language)} code" hidden>${icon('copy')}<span>Copy</span></button></figcaption><pre tabindex="0" aria-label="${escape(filename || language)} code example"><code class="language-${escape(language)}"${synced ? ` data-file="${escape(filename)}"` : ''} id="${id}">${content}\n</code></pre></figure>\n`;
        },
        table(token) {
            const html = defaultRenderer.table.call(this, token).replace(/<th(?=[ >])/g, '<th scope="col"');
            currentEntry.text += ` ${token.raw.replace(/[|`\n]/g, ' ')}`;
            currentEntry.signatures = (currentEntry.signatures ?? []).concat(token.rows.flatMap((row) =>
                row[0].tokens.filter((item) => item.type === 'codespan').map((item) => item.text)));
            return `<div class="table-scroll" tabindex="0" role="region" aria-label="${escape(context)} reference table">${html}</div>\n`;
        },
        link(token) {
            return `<a href="${escape(rewriteLink(token.href, page))}"${token.title ? ` title="${escape(token.title)}"` : ''}>${this.parser.parseInline(token.tokens)}</a>`;
        },
        html() { throw new Error(`${page.file}: use Markdown instead of raw HTML`); },
    } });
    const body = parser.parser(tokens);
    const leadHtml = parser.parseInline(lead.text);
    for (const key of Object.keys(legacy[page.slug] ?? {})) {
        if (!ids.has(key)) throw new Error(`${page.file}: legacy permalink target ${key} is missing`);
    }
    const toc = `<nav class="toc-links" aria-label="On this page"><ul>${headings.map((heading) => `<li class="toc-level-${heading.depth}"><a href="#${heading.id}">${escape(heading.text)}</a></li>`).join('')}</ul></nav>`;
    const neighbors = [[pages[index - 1], 'Previous'], [pages[index + 1], 'Next']].map(([neighbor, direction]) => neighbor
        ? `<a class="page-link ${direction.toLowerCase()}" href="${neighbor.slug}.html"><span>${direction}</span><strong>${neighbor.label}</strong>${icon('arrow')}</a>` : '<div></div>').join('');
    const heroTitle = page.slug === 'index' ? escape(title).replace('minutes, not hours', '<em>minutes, not hours</em>') : escape(title);
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="${escape(plain(lead.tokens))}">
<meta name="color-scheme" content="light dark">
<title>${escape(page.slug === 'index' ? 'SPL - Semantic Prompt Language' : `${page.label} - SPL docs`)}</title>
<link rel="icon" type="image/svg+xml" href="assets/favicon.svg?v=${revision}">
<link rel="stylesheet" href="assets/style.css?v=${revision}">
<script>try{const theme=localStorage.getItem('spl-theme');if(theme==='light'||theme==='dark')document.documentElement.dataset.theme=theme}catch(error){console.warn('Could not restore theme preference.',error)}</script>
<script defer src="assets/search-index.js?v=${revision}"></script>
<script defer src="assets/site.js?v=${revision}"></script>
</head>
<body data-page="${page.slug}">
<a class="skip-link" href="#page">Skip to content</a>
<header class="site-header">
  <div class="header-inner">
    <a class="brand" href="index.html" aria-label="SPL documentation home"><span class="brand-mark" aria-hidden="true">s<span>p</span>l<span class="brand-dot">.</span></span><span class="brand-divider" aria-hidden="true"></span><span class="brand-description">Semantic Prompt Language</span></a>
    <nav class="header-links" aria-label="Primary"><a href="index.html" aria-current="true">Documentation</a><a href="examples.html">Examples</a></nav>
    <div class="header-actions"><button type="button" class="search-trigger" data-open-search aria-label="Search documentation" hidden>${icon('search')}<span>Search docs...</span><kbd>Ctrl K</kbd></button><button type="button" class="theme-toggle icon-button" aria-label="Switch color theme" hidden>${icon('sun')}${icon('moon')}</button><a class="github-link icon-button" href="${repository}" aria-label="SPL on GitHub">${icon('external')}</a></div>
  </div>
</header>
<div class="docs-layout">
  <aside class="sidebar"><a class="version-label" href="getting-started.html"><span class="status-dot" aria-hidden="true"></span>v${version}<span class="version-status">Stable</span></a>${navigation(page, 'Documentation')}<div class="sidebar-note">${icon('spark')}<p>Short loops.<br><strong>Clear boundaries.</strong></p></div><a class="sidebar-source" href="${repository}">Open source on GitHub ${icon('external')}</a></aside>
  <details class="mobile-nav"><summary>Browse documentation <span>${escape(page.label)}</span>${icon('chevron')}</summary>${navigation(page, 'Mobile documentation')}</details>
  <main id="page" tabindex="-1">
    <div class="page-meta"><span>${escape(page.group)}</span>${icon('chevron')}<span>${escape(page.label)}</span><span class="reading-time">${Math.max(1, Math.ceil(markdown.split(/\s+/).length / 220))} min read</span></div>
    <header class="page-heading${page.slug === 'index' ? ' introduction-heading' : ''}">${page.slug === 'index' ? '<p class="eyebrow"><span class="status-dot" aria-hidden="true"></span>Fast iteration. Explicit guards. Readable scripts.</p>' : ''}<h1>${heroTitle}</h1><div class="lead"><p>${leadHtml}</p></div>${page.slug === 'index' ? `<div class="hero-actions"><a class="button-primary" href="getting-started.html">Start building ${icon('arrow')}</a><a class="button-secondary" href="language.html">Explore the language ${icon('chevron')}</a></div><div class="hero-tags"><span>${icon('terminal')}Node.js 20+</span><span>${icon('spark')}GitHub Copilot</span><span>${icon('shield')}Visible boundaries</span></div>` : ''}</header>
    <details class="mobile-toc"><summary>On this page ${icon('chevron')}</summary>${toc}</details>
    <article class="prose">${body}</article>
    <footer class="page-footer"><a href="${repository}/blob/HEAD/docs-template/${page.file}.md">${icon('edit')}View this page in Markdown ${icon('external')}</a><span>Good tools make intent clear.</span></footer>
    <nav class="page-pagination" aria-label="Previous and next pages">${neighbors}</nav>
    <div class="site-colophon"><a class="colophon-brand" href="index.html">spl.</a><span>Short loops. Clear boundaries.</span><a href="${repository}">GitHub ${icon('external')}</a></div>
  </main>
  <aside class="right-rail"><div class="toc-heading">${icon('layers')}On this page</div>${toc}<div class="rail-note"><span class="rail-note-icon">${icon('code')}</span><strong>Iterate on a small script.</strong><p>Keep deterministic code, model calls, and guards visible in one readable workflow.</p><a href="getting-started.html">Write your first script ${icon('arrow')}</a></div></aside>
</div>
<dialog class="search-dialog" aria-labelledby="search-title"><div class="search-header"><h2 id="search-title">Find your way</h2><form method="dialog"><button class="icon-button" aria-label="Close search">${icon('close')}</button></form></div><search><label class="visually-hidden" for="search-input">Search documentation</label><div class="search-field">${icon('search')}<input id="search-input" type="search" placeholder="Search concepts, functions, and examples..." autocomplete="off" spellcheck="false" aria-controls="search-results"></div></search><p id="search-status" class="search-status" role="status"></p><ul id="search-results" class="search-results"></ul><div class="search-footer"><span><kbd>Tab</kbd> to navigate</span><span><kbd>Esc</kbd> to close</span><span>Search stays on your device</span></div></dialog>
<p class="visually-hidden" id="announcement" role="status"></p>
<noscript><p class="noscript-note">Search, code copying, and the theme switch need JavaScript. All documentation and navigation work without it.</p></noscript>
</body>
</html>
`;
    return { html, entries: entries.map((entry) => ({ ...entry, text: entry.text.replace(/\s+/g, ' ').trim() })) };
}

const markdownFiles = fs.readdirSync(source).filter((name) => name.endsWith('.md')).sort();
if (JSON.stringify(markdownFiles) !== JSON.stringify(pages.map((page) => `${page.file}.md`).sort())) throw new Error('Update the documentation navigation to cover every Markdown page.');
for (const file of ['style.css', 'site.js', 'favicon.svg']) {
    if (!fs.existsSync(path.join(output, 'assets', file))) throw new Error(`Missing documentation asset: ${file}`);
}
const generated = new Map([['.nojekyll', '']]);
const search = [];
for (const [index, page] of pages.entries()) {
    const result = renderPage(page, index);
    generated.set(`${page.slug}.html`, result.html);
    search.push(...result.entries);
}
generated.set(path.join('assets', 'search-index.js'), `window.SPL_SEARCH_INDEX = ${JSON.stringify(search).replace(/</g, '\\u003c')};\n`);
for (const [file, content] of generated) {
    const target = path.join(output, file);
    if (check) {
        if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n') !== content) throw new Error(`Outdated ${file}. Run npm run docs:build.`);
    } else {
        fs.writeFileSync(target, content);
    }
}
console.log(`${check ? 'Verified' : 'Built'} ${pages.length} documentation pages and ${search.length} searchable sections.`);
