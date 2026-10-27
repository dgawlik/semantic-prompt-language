import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { run } from '../src/interpreter.js';
import { Logger } from '../src/logger.js';
import { parse } from '../src/parser.js';
import { extractMarkdown, parseMarkdown } from '../src/markdown.js';
import { JsonFileStore } from '../src/store.js';
import type { LlmRequest, RuntimeAction } from '../src/llm.js';
import { LIVE_TIMEOUT, RecordingCopilot, live } from './live.js';

const dir = path.resolve(__dirname, '..', 'examples');
const load = (name: string) => fs.readFileSync(path.join(dir, name), 'utf8');
const exampleCode = (name: string) => extractMarkdown(load(name)).blocks.filter((block) => block.kind === 'spl').map((block) => block.text).join('\n');

describe('examples', () => {
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.md'))) {
        it(`${file} is valid syntax`, () => {
            expect(() => parseMarkdown(load(file))).not.toThrow();
        });
    }
});

describe('documentation snippets', () => {
    const docs = path.resolve(dir, '..', '..', 'docs');
    const normalize = (source: string) => source.replace(/\r\n/g, '\n').trim();
    const decode = (source: string) => source.replace(/<\/?span\b[^>]*>/g, '')
        .replace(/&#x([a-f\d]+);/gi, (_, digits: string) => String.fromCodePoint(parseInt(digits, 16)))
        .replace(/&#(\d+);/g, (_, digits: string) => String.fromCodePoint(parseInt(digits, 10)))
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    for (const file of fs.readdirSync(docs).filter((name) => name.endsWith('.html'))) {
        const html = fs.readFileSync(path.join(docs, file), 'utf8');
        it(`${file} includes an accessible static documentation shell`, () => {
            expect([...html.matchAll(/<h1(?:\s|>)/g)]).toHaveLength(1);
            expect(html).toContain('<html lang="en">');
            expect(html).toContain('<main id="page"');
            expect(html).toContain('href="#page">Skip to content');
            expect(html).toContain('<dialog class="search-dialog" aria-labelledby="search-title">');
            expect(html).toContain('aria-current="page"');
            const depths = [...html.matchAll(/<h([1-6])(?:\s|>)/g)].map((match) => Number(match[1]));
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
        const snippets = [...html.matchAll(/<code class="language-spl"([^>]*)>([\s\S]*?)<\/code>/g)];
        snippets.forEach((match, i) => {
            it(`${file} SPL block ${i + 1} parses`, () => {
                expect(() => parse(decode(match[2]))).not.toThrow();
            });
            const name = /data-file="([^"]+)"/.exec(match[1])?.[1];
            const source = name === 'quickstart.md' ? 'hi.md' : name;
            if (source && fs.existsSync(path.join(dir, source))) {
                it(`${file} embeds current ${source}`, () => {
                    expect(normalize(decode(match[2]))).toBe(normalize(exampleCode(source)));
                });
            }
        });
    }
    const root = path.resolve(docs, '..');
    const markdownDocs = path.join(root, 'docs-template');
    const markdownFiles = fs.readdirSync(markdownDocs).filter((file) => file.endsWith('.md'));
    const withoutFences = (markdown: string) => normalize(markdown).replace(/^[ \t]*```[^\n]*\n[\s\S]*?^[ \t]*```[ \t]*$/gm, '');
    const headingId = (heading: string) => heading.toLowerCase().replace(/[^\p{L}\p{N}_ -]/gu, '').replace(/ /g, '-');
    it('has a Markdown page for every HTML documentation page', () => {
        const expected = fs.readdirSync(docs).filter((file) => file.endsWith('.html'))
            .map((file) => file === 'index.html' ? 'introduction.md' : file.replace(/\.html$/, '.md'))
            .sort();
        expect(markdownFiles.map((file) => file.toLowerCase()).sort()).toEqual(expected);
    });
    it('indexes every page and resolves every search result', () => {
        const content = fs.readFileSync(path.join(docs, 'assets', 'search-index.js'), 'utf8');
        const entries: { href: string; title: string; text: string }[] = JSON.parse(content.replace(/^window\.SPL_SEARCH_INDEX = /, '').trim().replace(/;$/, ''));
        const indexedPages = [...new Set(entries.map((entry) => entry.href.split('#')[0]))].sort();
        expect(indexedPages).toEqual(fs.readdirSync(docs).filter((file) => file.endsWith('.html')).sort());
        for (const entry of entries) {
            const [name, fragment] = entry.href.split('#');
            expect(entry.title.trim()).not.toBe('');
            if (fragment) {
                expect(fs.readFileSync(path.join(docs, name), 'utf8'), entry.href).toContain(`id="${fragment}"`);
            }
        }
    });
    it('preserves the published output formats permalink', () => {
        expect(fs.readFileSync(path.join(docs, 'llm-commands.html'), 'utf8')).toContain('id="fmt-object"');
    });
    for (const file of markdownFiles) {
        const markdown = fs.readFileSync(path.join(markdownDocs, file), 'utf8');
        it(`${file} local Markdown links resolve`, () => {
            for (const match of withoutFences(markdown).matchAll(/\[[^\n]*?\]\(([^)\s]+)\)/g)) {
                const href = match[1];
                if (/^[a-z][a-z\d+.-]*:/i.test(href)) continue;
                const [name, fragment] = href.split('#');
                const target = path.resolve(markdownDocs, decodeURIComponent(name || file));
                expect(fs.existsSync(target), `${file}: ${href}`).toBe(true);
                if (fragment && target.endsWith('.md')) {
                    const headings = [...withoutFences(fs.readFileSync(target, 'utf8')).matchAll(/^#{1,6} (.+)$/gm)]
                        .map((heading) => headingId(heading[1]));
                    expect(headings, `${file}: ${href}`).toContain(decodeURIComponent(fragment));
                }
            }
        });
        for (const match of markdown.matchAll(/^`([^`\r\n]+\.md)`\r?\n\r?\n```spl\r?\n([\s\S]*?)^```[ \t]*\r?$/gm)) {
            const name = match[1];
            if (fs.existsSync(path.join(dir, name))) {
                it(`${file} embeds current ${name}`, () => {
                    expect(normalize(match[2])).toBe(normalize(exampleCode(name)));
                });
            }
        }
        for (const match of markdown.matchAll(/^`([^`\r\n]+\.md)`\r?\n\r?\n````markdown\r?\n([\s\S]*?)^````[ \t]*\r?$/gm)) {
            const name = match[1];
            if (fs.existsSync(path.join(dir, name))) {
                it(`${file} embeds the full current ${name}`, () => {
                    expect(normalize(match[2])).toBe(normalize(load(name)));
                });
            }
        }
    }
    it('renders the canonical Markdown grammar without a separate EBNF source', () => {
        const markdown = fs.readFileSync(path.join(markdownDocs, 'Grammar.md'), 'utf8');
        const grammar = /```ebnf\s*\n([\s\S]*?)```/.exec(markdown);
        const html = fs.readFileSync(path.join(docs, 'grammar.html'), 'utf8');
        const rendered = /<code class="language-ebnf"[^>]*>([\s\S]*?)<\/code>/.exec(html);
        expect(grammar).not.toBeNull();
        expect(rendered).not.toBeNull();
        expect(normalize(decode(rendered![1]))).toBe(normalize(grammar![1]));
    });
    for (const file of ['README.md', path.join('lang', 'README.md'), ...markdownFiles.map((file) => path.join('docs-template', file))]) {
        const markdown = fs.readFileSync(path.join(root, file), 'utf8');
        [...markdown.matchAll(/```spl\s*\n([\s\S]*?)```/g)].forEach((match, i) => {
            it(`${file} SPL example ${i + 1} parses`, () => {
                expect(() => parse(match[1])).not.toThrow();
            });
        });
    }
});

describe('examples with offline backends', () => {
    const save = (name: string, value: unknown): RuntimeAction => ({ name: 'save_variable', arguments: { name, value } });
    function scriptedBackend(commands: RuntimeAction[][]) {
        const counts = { commands: 0, actions: 0 };
        let step = 0;
        return {
            counts,
            backend: {
                async call(req: LlmRequest) {
                    if (!req.naturalLanguage || !commands[counts.commands]) throw new Error('unexpected model call');
                    const action = commands[counts.commands][step++];
                    if (action) counts.actions++;
                    else { counts.commands++; step = 0; }
                    return { text: 'Done', action, effective: {} };
                },
                async close() {},
            },
        };
    }

    it('preserves journal state and bounds its history across runs with block scopes', async () => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'spl-journal-'));
        try {
            fs.mkdirSync(path.join(cwd, 'examples', 'data'), { recursive: true });
            fs.writeFileSync(path.join(cwd, 'examples', 'data', 'notes.txt'), 'Today we shipped.');
            const file = path.join(cwd, 'journal.json');
            for (let i = 1; i <= 6; i++) {
                const { backend, counts } = scriptedBackend([
                    [save('today', `Summary ${i}`)],
                    i > 1 ? [save('trend', 'Steady progress.')] : [],
                ]);
                const result = await run(parseMarkdown(load('journal.md')), {
                    cwd, logger: new Logger('silent'), store: new JsonFileStore(file), backend,
                });
                expect(result).toMatchObject({
                    status: 'success', value: { run: i, today: `Summary ${i}`, trend: i === 1 ? '' : 'Steady progress.' },
                });
                expect(counts).toEqual({ commands: 2, actions: i === 1 ? 1 : 2 });
                const state = JSON.parse(fs.readFileSync(file, 'utf8'));
                expect(state.runs).toBe(i);
                expect(state.history).toHaveLength(Math.min(i, 5));
                expect(state).not.toHaveProperty('first_run');
            }
        } finally {
            fs.rmSync(cwd, { recursive: true, force: true });
        }
    });

    it('compares integer generation with deterministic Fibonacci in the basics example', async () => {
        const { backend, counts } = scriptedBackend([
            [save('modelFib10', 55)],
            [save('joke', { setup: 'A programmer walks into a bar.', punchline: 'It was a FooBar.' })],
            [
                { name: 'set_guidance', arguments: { kind: 'enforce', text: 'Answer in Chinese' } },
                { name: 'set_guidance', arguments: { kind: 'forbid', text: 'Mentioning the word cat' } },
                save('animal', 'A pet story.'),
            ],
        ]);
        const result = await run(parseMarkdown(load('basics.md')), { logger: new Logger('silent'), backend });
        expect(result).toMatchObject({
            status: 'success',
            value: {
                fib: 55, modelFib: 55,
                joke: { setup: 'A programmer walks into a bar.', punchline: 'It was a FooBar.' },
                animal: 'A pet story.',
            },
        });
        expect(counts).toEqual({ commands: 3, actions: 5 });
    });

    it('rejects a wrong model answer in the basics example', async () => {
        const { backend } = scriptedBackend([[save('modelFib10', 54)]]);
        const result = await run(parseMarkdown(load('basics.md')), { logger: new Logger('silent'), backend });
        expect(result).toMatchObject({ status: 'failure', failure: { status_code: 'assertion_failed' } });
    });
    async function runScripted(file: string, actions: RuntimeAction[], args: string[] = [], outputs: string[] = []) {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'spl-example-'));
        fs.cpSync(path.join(dir, 'data'), path.join(cwd, 'examples', 'data'), { recursive: true });
        const { backend, counts } = scriptedBackend([actions]);
        try {
            const result = await run(parseMarkdown(load(file)), {
                cwd, args, logger: new Logger('silent'),
                backend,
            });
            expect(counts).toEqual({ commands: 1, actions: actions.length });
            const files = Object.fromEntries(outputs.map((name) => [name, fs.readFileSync(path.join(cwd, name), 'utf8')]));
            return { result, files };
        } finally {
            fs.rmSync(cwd, { recursive: true, force: true });
        }
    }

    const invoice = {
        vendor: 'ACME Industrial Supplies GmbH', number: 'INV-2026-0042', date: '2026-03-14', currency: 'EUR',
        lines: [
            { description: 'Hex bolt M8 (box of 100)', quantity: 3, unit_price: 12.5 },
            { description: 'Safety gloves, size L', quantity: 2, unit_price: 8.9 },
            { description: 'Cordless drill', quantity: 1, unit_price: 119 },
        ],
        subtotal: 174.3, tax: 33.12, total: 207.42,
    };

    it('checks invoice structure and arithmetic offline', async () => {
        const output = 'out/invoices/INV-2026-0042.json';
        const { result, files } = await runScripted('extract-invoice.md', [save('invoice', invoice)], [], [output]);
        expect(result).toMatchObject({ status: 'success', value: invoice });
        expect(JSON.parse(files[output])).toEqual(invoice);
    });

    it('rejects an invoice whose line items do not add up', async () => {
        const wrong = { ...invoice, subtotal: 180, total: 213.12 };
        const { result } = await runScripted('extract-invoice.md', [save('invoice', wrong)]);
        expect(result).toMatchObject({ status: 'failure', failure: { status_code: 'assertion_failed' } });
    });

    it('counts and groups log errors deterministically for the incident report', async () => {
        const output = 'reports/incident-2026-10-25.md';
        const report = ['Summary', 'Timeline', 'Impact', 'Likely root cause', 'Follow-ups'].map((s) => `## ${s}\n`).join('');
        const { result, files } = await runScripted('incident-report.md', [save('report', report)], [], [output]);
        expect(result).toMatchObject({ status: 'success', value: { errors: 6, groups: 3, report: `./${output}` } });
        expect(files[output]).toContain('## Likely root cause');
    });

    it('verifies that translations keep links, code spans and headings', async () => {
        const translation = (title: string) => [
            `# ${title}`, '', '## New', '', '- `GET /v2/reports` supports `limit` and `cursor`.', '',
            '## Fixes', '', 'See https://example.com/help or write to support@example.com.',
        ].join('\n');
        const good = save('translations', { en: translation('Product update'), de: translation('Produktupdate') });
        const output = 'out/translations/product-update.de.md';
        const { result, files } = await runScripted('translate-docs.md', [good], ['en', 'de'], [output]);
        expect(result).toMatchObject({ status: 'success', value: ['en', 'de'] });
        expect(files[output]).toContain('# Produktupdate');

        const broken = save('translations', { en: translation('Product update').replace('support@example.com', 'support') });
        const failed = await runScripted('translate-docs.md', [broken], ['en']);
        expect(failed.result).toMatchObject({ status: 'failure', failure: { status_code: 'assertion_failed' } });
        expect((failed.result as { failure: { reason: string } }).failure.reason).toContain('support@example.com');
    });
});

describe.skipIf(!live)('examples on Copilot', () => {
    it(
        'extract-invoice extracts a balanced invoice from the sample document',
        async () => {
            const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'spl-live-invoice-'));
            fs.cpSync(path.join(dir, 'data'), path.join(cwd, 'examples', 'data'), { recursive: true });
            const backend = new RecordingCopilot(cwd);
            try {
                const result = await run(parseMarkdown(load('extract-invoice.md')), { backend, logger: new Logger('silent'), cwd });
                expect(result).toMatchObject({
                    status: 'success', value: { number: 'INV-2026-0042', currency: 'EUR', total: 207.42 },
                });
            } finally {
                await backend.close();
                fs.rmSync(cwd, { recursive: true, force: true });
            }
        },
        LIVE_TIMEOUT * 3,
    );
});
