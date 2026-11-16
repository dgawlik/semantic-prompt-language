import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { compile } from '../src/compile.js';
import { documentMarkdown } from '../src/doc.js';
import hljs from '../src/highlight.js';

const root = path.resolve(__dirname, '..', '..');
const docs = path.join(root, 'docs');
const templates = path.join(root, 'docs-template');
const examples = path.join(root, 'lang', 'examples');
const exampleFiles = fs.readdirSync(examples, { recursive: true, encoding: 'utf8' })
    .map(name => name.replaceAll('\\', '/')).filter(name => name.endsWith('.spl')).sort();

const normalize = (source: string): string => source.replace(/\r\n/g, '\n').trim();
/** Turns highlighted HTML back into the text a reader copies. */
const decode = (html: string): string => html.replace(/<\/?span\b[^>]*>/g, '')
    .replace(/&#x([a-f\d]+);/gi, (_, digits: string) => String.fromCodePoint(parseInt(digits, 16)))
    .replace(/&#(\d+);/g, (_, digits: string) => String.fromCodePoint(parseInt(digits, 10)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const headingId = (heading: string): string => heading.toLowerCase().replace(/[^\p{L}\p{N}_ -]/gu, '').replace(/ /g, '-');
const withoutFences = (markdown: string): string =>
    normalize(markdown).replace(/^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]*\1[ \t]*$/gm, '');

interface Fence {
    language: string;
    /** `spl fragment` marks a part of a file, such as a lone header: highlighted, not compiled. */
    fragment: boolean;
    text: string;
    /** The example file named by the caption above the listing. */
    caption?: string;
}

/** Fenced blocks of a Markdown source, outermost fences only. */
function fences(markdown: string): Fence[] {
    const source = normalize(markdown);
    return [...source.matchAll(/^(`{3,}|~{3,})([^\n]*)\n([\s\S]*?)^\1[ \t]*$/gm)].map(match => {
        const [language = '', flag] = match[2].trim().toLowerCase().split(/\s+/);
        const caption = /(?:^|\n)`([^`\n]+\.\w+)`\n\n$/.exec(source.slice(0, match.index))?.[1];
        return { language, fragment: flag === 'fragment', text: match[3], ...(caption ? { caption } : {}) };
    });
}

describe('documentation site', () => {
    const files = fs.readdirSync(docs).filter(name => name.endsWith('.html'));
    // index.html is the starter presentation; the generated documentation starts at introduction.html.
    const pages = files.filter(name => name !== 'index.html');

    it('publishes the starter presentation as the front page, linking to the documentation', () => {
        const html = fs.readFileSync(path.join(docs, 'index.html'), 'utf8');
        expect(html).toContain('href="introduction.html">Explore the docs');
        expect(html).toContain('href="getting-started.html"');
        expect(html).not.toMatch(/href="\.\.\//);
        expect(html).not.toContain('href="https://dgawlik.github.io/semantic-prompt-language/');
        for (const file of pages) expect(fs.readFileSync(path.join(docs, file), 'utf8'), file).toContain('<a href="introduction.html" aria-current="true">Documentation</a>');
    });

    it('presents 3.0 syntax on the front page', () => {
        const text = decode(fs.readFileSync(path.join(docs, 'index.html'), 'utf8'));
        for (const expected of ['spl run lang/examples/typed-data.spl', 'spl check lang/examples/random-article.spl', 'mode: agent', '->[Str] @article']) expect(text).toContain(expected);
        for (const removed of ['{js}', '{agent', '@validate', '--check', 'enumOf(', 'go(']) expect(text).not.toContain(removed);
    });

    it('index.html local links resolve', () => {
        const html = fs.readFileSync(path.join(docs, 'index.html'), 'utf8');
        for (const match of html.matchAll(/href="([^"]+)"/g)) {
            const href = match[1];
            if (/^[a-z][a-z\d+.-]*:/i.test(href)) continue;
            const [name, fragment] = href.split('#');
            const target = path.resolve(docs, decodeURIComponent(name || 'index.html'));
            expect(fs.existsSync(target), href).toBe(true);
            if (fragment) expect(fs.readFileSync(target, 'utf8'), href).toContain(`id="${fragment}"`);
        }
    });

    for (const file of pages) {
        const html = fs.readFileSync(path.join(docs, file), 'utf8');

        it(`${file} includes an accessible static documentation shell`, () => {
            expect([...html.matchAll(/<h1(?:\s|>)/g)]).toHaveLength(1);
            expect(html).toContain('<html lang="en">');
            expect(html).toContain('<main id="page"');
            expect(html).toContain('href="#page">Skip to content');
            expect(html).toContain('<dialog class="search-dialog" aria-labelledby="search-title">');
            expect(html).toContain('aria-current="page"');
            const depths = [...html.matchAll(/<h([1-6])(?:\s|>)/g)].map(match => Number(match[1]));
            for (let i = 1; i < depths.length; i++) expect(depths[i]).toBeLessThanOrEqual(depths[i - 1] + 1);
            for (const match of html.matchAll(/(?:src|href)="(assets\/[^"]+)"/g)) {
                expect(fs.existsSync(path.join(docs, match[1].split('?')[0])), `${file}: ${match[1]}`).toBe(true);
            }
        });

        it(`${file} local documentation links resolve`, () => {
            for (const match of html.matchAll(/href="([^"]+)"/g)) {
                const href = match[1];
                if (/^[a-z][a-z\d+.-]*:/i.test(href)) continue;
                const [name, fragment] = href.split('#');
                const target = path.resolve(docs, decodeURIComponent(name.split('?')[0] || file));
                expect(fs.existsSync(target), `${file}: ${href}`).toBe(true);
                if (fragment && target.endsWith('.html')) {
                    expect(fs.readFileSync(target, 'utf8'), `${file}: ${href}`).toContain(`id="${fragment}"`);
                }
            }
        });

        it(`${file} shows its listings as the template wrote them`, () => {
            const template = fs.readdirSync(templates).find(name => name.toLowerCase() === file.replace(/\.html$/, '.md'))!;
            const written = fences(fs.readFileSync(path.join(templates, template), 'utf8')).filter(fence => fence.language !== 'spl-doc');
            const shown = [...html.matchAll(/<code class="language-([\w-]+)"([^>]*)>([\s\S]*?)<\/code>/g)]
                .map(match => ({ text: decode(match[3]), example: /data-file="([^"]+)"/.exec(match[2])?.[1] }));
            for (const fence of written) expect(shown.map(block => normalize(block.text)), `${file}: ${fence.text.slice(0, 40)}`).toContain(normalize(fence.text));
            for (const block of shown.filter(item => item.example)) {
                expect(normalize(block.text), `${file}: ${block.example}`).toBe(normalize(fs.readFileSync(path.join(examples, block.example!), 'utf8')));
            }
        });
    }

    it('shows shipped examples from their files', () => {
        const embedded = pages.flatMap(file => [...fs.readFileSync(path.join(docs, file), 'utf8').matchAll(/data-file="([^"]+)"/g)].map(match => match[1]));
        for (const name of ['hi.spl', 'basics.spl', 'codegen.spl', 'code-review.spl']) expect(embedded).toContain(name);
    });

    it('documents every example on the Examples page, as spl doc prints it', () => {
        const html = fs.readFileSync(path.join(docs, 'examples.html'), 'utf8');
        const template = fs.readFileSync(path.join(templates, 'Examples.md'), 'utf8');
        const listed = fences(template).filter(fence => fence.language === 'spl-doc').flatMap(fence => fence.text.split('\n').map(line => line.trim()).filter(Boolean));
        expect([...listed].sort()).toEqual(exampleFiles);
        for (const name of exampleFiles) {
            const title = /^# (.+)$/m.exec(documentMarkdown(fs.readFileSync(path.join(examples, name), 'utf8')))![1];
            expect(decode(html.replace(/<[^>]+>/g, '')), name).toContain(title.replace(/`/g, ''));
            expect(html, name).toContain(`/lang/examples/${name.split('/').map(encodeURIComponent).join('/')}"`);
        }
    });

    it('has a Markdown page for every HTML documentation page', () => {
        const expected = pages.map(file => file.replace(/\.html$/, '.md')).sort();
        expect(fs.readdirSync(templates).filter(file => file.endsWith('.md')).map(file => file.toLowerCase()).sort()).toEqual(expected);
    });

    it('indexes every page and resolves every search result', () => {
        const content = fs.readFileSync(path.join(docs, 'assets', 'search-index.js'), 'utf8');
        const entries: { href: string; title: string; text: string }[] = JSON.parse(content.replace(/^window\.SPL_SEARCH_INDEX = /, '').trim().replace(/;$/, ''));
        expect([...new Set(entries.map(entry => entry.href.split('#')[0]))].sort()).toEqual([...pages].sort());
        for (const entry of entries) {
            const [name, fragment] = entry.href.split('#');
            expect(entry.title.trim()).not.toBe('');
            if (fragment) expect(fs.readFileSync(path.join(docs, name), 'utf8'), entry.href).toContain(`id="${fragment}"`);
        }
    });

    it('states the runtime requirements and the version of the package', () => {
        const { engines, version } = JSON.parse(fs.readFileSync(path.join(root, 'lang', 'package.json'), 'utf8')) as { engines: { node: string }; version: string };
        const minimum = /^>=(\d+\.\d+)/.exec(engines.node)![1];
        expect(version).toBe('3.0.0');
        expect(fs.readFileSync(path.join(docs, 'introduction.html'), 'utf8')).toContain(`Node.js ${minimum}+`);
        expect(fs.readFileSync(path.join(docs, 'introduction.html'), 'utf8')).toContain(`v${version}`);
        expect(fs.readFileSync(path.join(docs, 'index.html'), 'utf8')).toContain(`Node.js ${minimum}+`);
    });
});

describe('documentation sources', () => {
    const sources = [
        'README.md', path.join('lang', 'README.md'), path.join('vscode', 'README.md'),
        ...fs.readdirSync(templates).filter(file => file.endsWith('.md')).map(file => path.join('docs-template', file)),
    ];

    for (const file of sources) {
        const markdown = fs.readFileSync(path.join(root, file), 'utf8');
        const directory = path.dirname(path.join(root, file));

        it(`${file} local Markdown links resolve`, () => {
            for (const match of withoutFences(markdown).matchAll(/\[[^\n]*?\]\(([^)\s]+)\)/g)) {
                const href = match[1];
                if (/^[a-z][a-z\d+.-]*:/i.test(href)) continue;
                const [name, fragment] = href.split('#');
                const target = name ? path.resolve(directory, decodeURIComponent(name)) : path.join(root, file);
                expect(fs.existsSync(target), `${file}: ${href}`).toBe(true);
                if (fragment && target.endsWith('.md')) {
                    const headings = [...withoutFences(fs.readFileSync(target, 'utf8')).matchAll(/^#{1,6} (.+)$/gm)]
                        .map(heading => headingId(heading[1].replace(/`/g, '')));
                    expect(headings, `${file}: ${href}`).toContain(decodeURIComponent(fragment));
                }
            }
        });

        it(`${file} describes SPL 3.0 only`, () => {
            // The migration guide is the one place that shows what 2.x looked like.
            if (file.endsWith('Migration.md')) return;
            const prose = withoutFences(markdown);
            for (const removed of ['@CTL', '@CODEGEN', '@validate', '--pin', 'think(', 'enumOf', 'go(']) {
                expect(prose.toLowerCase(), `${file}: ${removed}`).not.toContain(removed.toLowerCase());
            }
        });

        fences(markdown).forEach((fence, index) => {
            // An `spl` listing is a whole file unless it is marked as a fragment: it must compile.
            if (fence.language === 'spl' && !fence.fragment) {
                it(`${file} .spl listing ${index + 1} compiles`, () => {
                    expect(() => compile(fence.text)).not.toThrow();
                });
            }
            if (fence.caption && fs.existsSync(path.join(examples, fence.caption))) {
                it(`${file} listing ${index + 1} is ${fence.caption} as shipped`, () => {
                    expect(normalize(fence.text)).toBe(normalize(fs.readFileSync(path.join(examples, fence.caption!), 'utf8')));
                });
            }
        });
    }

    it('keeps the README example current', () => {
        const [first] = fences(fs.readFileSync(path.join(root, 'README.md'), 'utf8'));
        expect(first.language).toBe('spl');
        expect(normalize(first.text)).toBe(normalize(fs.readFileSync(path.join(examples, 'basics.spl'), 'utf8')));
    });

    it('generate-presentation.spl is a valid workflow', () => {
        expect(() => compile(fs.readFileSync(path.join(root, 'generate-presentation.spl'), 'utf8'))).not.toThrow();
    });
});

describe('documentation syntax highlighting', () => {
    const highlight = (text: string, language = 'spl'): string => hljs.highlight(text, { language }).value;
    const source = [
        '//*', '# Title', '', 'Some *prose* with `---` in it.', '*//',
        '---', 'model: gpt-6-luna', '---',
        "const topic: string = 'types';", 'const rule = `---`;',
        '---', 'mode: agent', 'restrict: { fs: ./out }', '',
        'Explain @topic and @env.HOME to user@example.com ->[List(Str)] @points', 'model: this line is text, and so is @=count', '---',
        'success(points);',
    ].join('\n');

    it('registers the languages used by the documentation', () => {
        for (const name of ['js', 'javascript', 'ts', 'typescript', 'bash', 'sh', 'powershell', 'json', 'yaml', 'markdown', 'md', 'spl']) {
            expect(hljs.getLanguage(name), name).toBeTruthy();
        }
        expect(hljs.getLanguage('ebnf')).toBeUndefined();
    });

    it('colors a .spl file: Markdown comments, fences, header keys, references, arrows and TypeScript between them', () => {
        const html = highlight(source);
        expect(html).toContain('<span class="hljs-comment">//*</span>');
        expect(html).toContain('<span class="hljs-section"># Title</span>');
        expect(html).toContain('<span class="hljs-comment">*//</span>');
        expect(html).toContain('<span class="hljs-meta">---</span>');
        expect(html).toContain('<span class="hljs-attr">model</span>: gpt-6-luna');
        expect(html).toContain('<span class="hljs-attr">mode</span>: agent');
        expect(html).toContain('<span class="hljs-attr">restrict</span>');
        expect(html).toContain('<span class="hljs-variable">@topic</span>');
        expect(html).toContain('<span class="hljs-variable">@env.HOME</span>');
        expect(html).toContain('<span class="hljs-variable">@=count</span>');
        expect(html).toContain('<span class="hljs-keyword">-&gt;</span>[List(Str)] <span class="hljs-variable">@points</span>');
        expect(html).toContain('<span class="hljs-keyword">const</span> <span class="hljs-attr">topic</span>: <span class="hljs-built_in">string</span> = <span class="hljs-string">&#x27;types&#x27;</span>;');
        expect(html).toContain('<span class="hljs-title function_">success</span>(points);');
    });

    it('leaves addresses, fences inside strings and prose alone', () => {
        const html = highlight(source);
        expect(html).toContain('user@example.com');
        expect(html).not.toContain('<span class="hljs-variable">@example');
        expect(html).toContain('<span class="hljs-string">`---`</span>');
        // Six fence lines open and close the three blocks; the `---` in the comment and in the string are not fences.
        expect(html.match(/<span class="hljs-meta">---<\/span>/g)).toHaveLength(4);
    });

    it('preserves the source text of every example', () => {
        for (const name of exampleFiles) {
            const text = fs.readFileSync(path.join(examples, name), 'utf8').replace(/\r\n/g, '\n');
            expect(decode(highlight(text)), name).toBe(text);
        }
    });

    it('escapes HTML without changing copied code', () => {
        const text = 'const html = "<b>&amp;</b>";\n---\noutputVar: a\n\nIs 1 < 2 && 3 > 2?\n---';
        const html = highlight(text);
        expect(html).not.toContain('<b>');
        expect(decode(html)).toBe(text);
    });
});
