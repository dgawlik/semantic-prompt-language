import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compileCell, FENCE_LANGUAGES } from '../src/cell.js';
import { parseMarkdown } from '../src/markdown.js';
import { header } from './helpers.js';

const root = path.resolve(__dirname, '..', '..');
const docs = path.join(root, 'docs');
const templates = path.join(root, 'docs-template');
const examples = path.join(root, 'lang', 'examples');

interface Highlighter {
    highlight(text: string, options: { language: string }): { value: string };
    getLanguage(name: string): unknown;
}
// The documentation generator's own highlighter: plain JavaScript outside this package.
const { default: hljs } = await import(pathToFileURL(path.join(docs, 'highlight.mjs')).href) as { default: Highlighter };

const normalize = (source: string): string => source.replace(/\r\n/g, '\n').trim();
/** Turns highlighted HTML back into the text a reader copies. */
const decode = (html: string): string => html.replace(/<\/?span\b[^>]*>/g, '')
    .replace(/&#x([a-f\d]+);/gi, (_, digits: string) => String.fromCodePoint(parseInt(digits, 16)))
    .replace(/&#(\d+);/g, (_, digits: string) => String.fromCodePoint(parseInt(digits, 10)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const headingId = (heading: string): string => heading.toLowerCase().replace(/[^\p{L}\p{N}_ -]/gu, '').replace(/ /g, '-');
const withoutFences = (markdown: string): string =>
    normalize(markdown).replace(/^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]*\1[ \t]*$/gm, '');

/** A listing is either a whole workflow or a fragment of one: a few fences and blockquotes. */
const workflow = (text: string): string => text.startsWith('---\n') ? text : `${header}---\n\n${text}`;

/** Fenced blocks of a Markdown source, outermost fences only. */
function fences(markdown: string): { language: string; text: string }[] {
    const found: { language: string; text: string }[] = [];
    for (const match of normalize(markdown).matchAll(/^(`{3,}|~{3,})([^\s`]*)[^\n]*\n([\s\S]*?)^\1[ \t]*$/gm)) {
        found.push({ language: match[2].toLowerCase(), text: match[3] });
    }
    return found;
}

describe('documentation site', () => {
    const pages = fs.readdirSync(docs).filter(name => name.endsWith('.html'));

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

        it(`${file} does not present the removed language`, () => {
            expect(html).not.toContain('class="language-spl"');
            expect(html).not.toContain('class="language-ebnf"');
        });

        const blocks = [...html.matchAll(/<code class="language-([\w-]+)"([^>]*)>([\s\S]*?)<\/code>/g)]
            .map(match => ({ language: match[1], text: decode(match[3]), example: /data-file="([^"]+)"/.exec(match[2])?.[1] }));
        blocks.forEach((block, index) => {
            const language = Object.hasOwn(FENCE_LANGUAGES, block.language) ? FENCE_LANGUAGES[block.language] : undefined;
            if (language) {
                it(`${file} ${block.language} block ${index + 1} compiles as a workflow fence`, () => {
                    expect(() => compileCell(block.text, { language })).not.toThrow();
                });
            }
            if (block.language === 'markdown') {
                it(`${file} workflow listing ${index + 1} parses`, () => {
                    const parsed = parseMarkdown(workflow(block.text));
                    expect(parsed.steps.length).toBeGreaterThan(0);
                });
            }
            if (block.example) {
                it(`${file} embeds the current ${block.example}`, () => {
                    expect(decodeURIComponent(block.example!)).not.toContain('..');
                    expect(normalize(block.text)).toBe(normalize(fs.readFileSync(path.join(examples, block.example!), 'utf8')));
                });
            }
        });
    }

    it('shows shipped examples from their files', () => {
        const embedded = pages.flatMap(file => [...fs.readFileSync(path.join(docs, file), 'utf8').matchAll(/data-file="([^"]+)"/g)].map(match => match[1]));
        for (const name of ['hi.md', 'codegen.md', 'types.md', 'extract-invoice.md', 'triage-issues.md']) expect(embedded).toContain(name);
    });

    it('has a Markdown page for every HTML documentation page', () => {
        const expected = pages.map(file => file === 'index.html' ? 'introduction.md' : file.replace(/\.html$/, '.md')).sort();
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

    it('preserves the published output formats permalink', () => {
        expect(fs.readFileSync(path.join(docs, 'llm-commands.html'), 'utf8')).toContain('id="fmt-object"');
    });

    it('states the runtime requirements of the package', () => {
        const { engines } = JSON.parse(fs.readFileSync(path.join(root, 'lang', 'package.json'), 'utf8')) as { engines: { node: string } };
        const minimum = /^>=(\d+\.\d+)/.exec(engines.node)![1];
        expect(fs.readFileSync(path.join(docs, 'index.html'), 'utf8')).toContain(`Node.js ${minimum}+`);
        expect(fs.readFileSync(path.join(docs, 'getting-started.html'), 'utf8')).toContain(`Node.js ${engines.node.replace('>', '&gt;')}`);
    });
});

describe('documentation sources', () => {
    const sources = [
        'README.md', 'TYPES.md', path.join('lang', 'README.md'), path.join('vscode', 'README.md'),
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

        it(`${file} has no fences in the removed language`, () => {
            expect(fences(markdown).map(fence => fence.language)).not.toContain('spl');
        });

        fences(markdown).forEach((fence, index) => {
            const language = Object.hasOwn(FENCE_LANGUAGES, fence.language) ? FENCE_LANGUAGES[fence.language] : undefined;
            if (language) {
                it(`${file} ${fence.language} example ${index + 1} compiles as a workflow fence`, () => {
                    expect(() => compileCell(fence.text, { language })).not.toThrow();
                });
            }
            if (fence.language === 'markdown') {
                it(`${file} workflow listing ${index + 1} parses`, () => {
                    expect(parseMarkdown(workflow(fence.text)).steps.length).toBeGreaterThan(0);
                });
            }
        });
    }

    it('keeps the README example current', () => {
        const readme = normalize(fs.readFileSync(path.join(root, 'README.md'), 'utf8'));
        const embedded = /^````markdown\n([\s\S]*?)^````[ \t]*$/m.exec(readme);
        expect(embedded).not.toBeNull();
        expect(normalize(embedded![1])).toBe(normalize(fs.readFileSync(path.join(examples, 'hi.md'), 'utf8')));
    });

    it.each(['generate-presentation.md', path.join('.testmd', '1.md')])('%s is a valid workflow', file => {
        const source = fs.readFileSync(path.join(root, file), 'utf8');
        expect(source).not.toMatch(/^(`{3,}|~{3,})spl\b/m);
        expect(parseMarkdown(source).steps.some(step => step.kind === 'code')).toBe(true);
    });
});

describe('documentation syntax highlighting', () => {
    const highlight = (text: string, language = 'markdown'): string => hljs.highlight(text, { language }).value;

    it('registers the languages used by the documentation and not the removed ones', () => {
        for (const name of ['js', 'javascript', 'ts', 'typescript', 'bash', 'powershell', 'json', 'markdown']) {
            expect(hljs.getLanguage(name), name).toBeTruthy();
        }
        for (const name of ['spl', 'ebnf']) expect(hljs.getLanguage(name), name).toBeFalsy();
    });

    it('highlights JavaScript workflow code with the library as ordinary calls', () => {
        const text = "const answer = await ask(`Rate ${args[0]}`, { fmt: 'integer', repairs: 1 });\nsuccess(answer);";
        const html = highlight(text, 'js');
        for (const keyword of ['const', 'await']) expect(html).toContain(`<span class="hljs-keyword">${keyword}</span>`);
        expect(html).toContain('<span class="hljs-title function_">ask</span>');
        expect(html).toContain('<span class="hljs-subst">${args[<span class="hljs-number">0</span>]}</span>');
        for (const name of ['fmt', 'repairs']) expect(html).toContain(`<span class="hljs-attr">${name}</span>`);
        expect(decode(html)).toBe(text);
    });

    it('highlights TypeScript annotations in ts blocks', () => {
        const text = "import type { Infer } from 'spl-lang';\ntype Invoice = Infer<typeof Invoice>;\nconst total: number = 1;";
        const html = highlight(text, 'ts');
        expect(html).toContain('<span class="hljs-keyword">type</span>');
        expect(html).toContain('<span class="hljs-built_in">number</span>');
        expect(decode(html)).toBe(text);
    });

    it('highlights references and agent markers only in blockquotes', () => {
        const text = "Email user@example.com and mention @outside.\n\n> @CTL(forbid='guessing') Inspect @facts and @env.HOME; @validate[Schema] save to @result, then @success or @fail";
        const html = highlight(text);
        expect(html).toContain('<span class="hljs-keyword">@CTL</span>');
        expect(html).toContain('<span class="hljs-attr">forbid</span>');
        for (const name of ['@validate', '@success', '@fail']) expect(html).toContain(`<span class="hljs-keyword">${name}</span>`);
        for (const name of ['@facts', '@env.HOME', '@result']) expect(html).toContain(`<span class="hljs-variable">${name}</span>`);
        for (const name of ['@example', '@outside']) expect(html).not.toContain(`>${name}</span>`);
        expect(decode(html)).toBe(text);
    });

    it('highlights every control setting of a multiline @CTL block', () => {
        const text = "> @CTL(\n>     restrict={fs: ['./src']},\n>     enforce='Be concise',\n>     model='m', reasoning='high'\n> )\n>\n> Save findings to @notes";
        const html = highlight(text);
        for (const name of ['restrict', 'enforce', 'model', 'reasoning']) expect(html).toContain(`<span class="hljs-attr">${name}</span>`);
        expect(html).toContain('<span class="hljs-variable">@notes</span>');
        expect(decode(html)).toBe(text);
    });

    it('does not highlight removed blockquote markers as keywords', () => {
        const html = highlight('> @RESTRICT @ENFORCE @FORBID @HUMAN');
        for (const name of ['RESTRICT', 'ENFORCE', 'FORBID', 'HUMAN']) {
            expect(html).not.toContain(`<span class="hljs-keyword">@${name}</span>`);
        }
    });

    it('highlights the explicit codegen marker in blockquotes', () => {
        expect(highlight("> @CODEGEN 'Define double(value)'")).toContain('<span class="hljs-keyword">@CODEGEN</span>');
        const lower = highlight("> @ctl(model='m')\n> @codegen 'Define double(value)'");
        for (const name of ['@ctl', '@codegen']) expect(lower).toContain(`<span class="hljs-keyword">${name}</span>`);
        expect(highlight('> Return @total with @SUCCESS')).toContain('<span class="hljs-keyword">@SUCCESS</span>');
    });

    it('highlights embedded JavaScript and TypeScript in all supported Markdown fence styles', () => {
        const cases: [string, string][] = [
            ['js', 'javascript'], ['javascript', 'javascript'], ['mjs', 'javascript'],
            ['ts', 'typescript'], ['typescript', 'typescript'], ['mts', 'typescript'],
        ];
        for (const [name, language] of cases) {
            for (const fence of ['```', '````', '~~~', '~~~~']) {
                for (const indent of ['', '   ']) {
                    for (const newline of ['\n', '\r\n']) {
                        const text = `${indent}${fence}${name}${newline}const count = args.length;${newline}success(\`\${count}\`);${newline}${indent}${fence}${fence[0]}  ${newline}`;
                        const html = highlight(text);
                        expect(html, text).toContain(`<span class="language-${language}">`);
                        expect(html, text).toContain('<span class="hljs-keyword">const</span>');
                        expect(html, text).toContain('<span class="hljs-title function_">success</span>');
                        expect(decode(html)).toBe(text);
                    }
                }
            }
        }
    });

    it('highlights fences that are shown but not run', () => {
        const text = '```js ignore\nconst shown = true;\n```\n\n```ts no-run\nconst typed: boolean = true;\n```';
        const html = highlight(text);
        expect(html).toContain('<span class="language-javascript">');
        expect(html).toContain('<span class="language-typescript">');
        expect(decode(html)).toBe(text);
    });

    it('does not close a fence on a shorter or different delimiter', () => {
        const text = '````js\n/*\n```\n~~~\n*/\nsuccess(true);\n````\n\n> Save to @result';
        const html = highlight(text);
        expect(html).toContain('<span class="hljs-title function_">success</span>');
        expect(html).toContain('<span class="hljs-variable">@result</span>');
        expect(decode(html)).toBe(text);
    });

    it('does not highlight apparent workflow fences inside another code block', () => {
        const html = highlight('````text\n```js\nconst hidden = true;\n```\n````');
        expect(html).not.toContain('hljs-keyword');
        expect(html).not.toContain('language-javascript');
    });

    it('treats fences in other languages, including the removed one, as plain code', () => {
        for (const name of ['spl', 'python', 'json']) {
            const text = `\`\`\`${name}\nconst value = 1\n\`\`\``;
            const html = highlight(text);
            expect(html, name).not.toContain('class="language-');
            expect(html, name).not.toContain('hljs-keyword');
            expect(decode(html)).toBe(text);
        }
    });

    it('preserves every example document and its source text', () => {
        const files = fs.readdirSync(examples, { recursive: true, encoding: 'utf8' }).filter(name => name.endsWith('.md'));
        expect(files.length).toBeGreaterThan(20);
        for (const file of files) {
            const text = fs.readFileSync(path.join(examples, file), 'utf8');
            const html = highlight(text);
            expect(decode(html), file).toBe(text);
            if (/^```js\r?$/m.test(text)) expect(html, file).toContain('<span class="language-javascript">');
        }
    });

    it('escapes HTML without changing copied code', () => {
        const text = `const html = '<script>alert("x")</script> & text';`;
        for (const language of ['js', 'ts']) {
            const html = highlight(text, language);
            expect(html).not.toContain('<script>');
            expect(decode(html)).toBe(text);
        }
        const quoted = highlight('> Save <b>bold</b> & more to @result');
        expect(quoted).not.toContain('<b>');
        expect(decode(quoted)).toBe('> Save <b>bold</b> & more to @result');
    });
});
