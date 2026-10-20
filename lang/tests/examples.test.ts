import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { run } from '../src/interpreter.js';
import { Logger } from '../src/logger.js';
import { parse } from '../src/parser.js';
import { JsonFileStore } from '../src/store.js';
import { LIVE_TIMEOUT, RecordingCopilot, live } from './live.js';

const dir = path.resolve(__dirname, '..', 'examples');
const load = (name: string) => fs.readFileSync(path.join(dir, name), 'utf8');

describe('examples', () => {
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.spl'))) {
        it(`${file} is valid syntax`, () => {
            expect(() => parse(load(file))).not.toThrow();
        });
    }
});

describe('documentation snippets', () => {
    const docs = path.resolve(dir, '..', '..', 'docs');
    const decode = (source: string) => source.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    for (const file of fs.readdirSync(docs).filter((name) => name.endsWith('.html'))) {
        const html = fs.readFileSync(path.join(docs, file), 'utf8');
        it(`${file} local documentation links resolve`, () => {
            for (const match of html.matchAll(/href="([^"]+)"/g)) {
                const href = match[1];
                if (/^[a-z][a-z\d+.-]*:/i.test(href)) continue;
                const [name, fragment] = href.split('#');
                const target = path.resolve(docs, decodeURIComponent(name || file));
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
            const source = name === 'quickstart.spl' ? 'hi.spl' : name;
            if (source && fs.existsSync(path.join(dir, source))) {
                it(`${file} embeds current ${source}`, () => {
                    expect(decode(match[2]).trim()).toBe(load(source).trim());
                });
            }
        });
    }
    const root = path.resolve(docs, '..');
    for (const file of ['README.md', path.join('lang', 'README.md')]) {
        const markdown = fs.readFileSync(path.join(root, file), 'utf8');
        [...markdown.matchAll(/```spl\s*\n([\s\S]*?)```/g)].forEach((match, i) => {
            it(`${file} SPL example ${i + 1} parses`, () => {
                expect(() => parse(match[1])).not.toThrow();
            });
        });
    }
});

describe('examples with offline backends', () => {
    it('preserves journal state and bounds its history across runs with block scopes', async () => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'spl-journal-'));
        try {
            fs.mkdirSync(path.join(cwd, 'examples', 'data'), { recursive: true });
            fs.writeFileSync(path.join(cwd, 'examples', 'data', 'notes.txt'), 'Today we shipped.');
            const file = path.join(cwd, 'journal.json');
            for (let i = 1; i <= 6; i++) {
                let calls = 0;
                const result = await run(parse(load('journal.spl')), {
                    cwd, logger: new Logger('silent'), store: new JsonFileStore(file),
                    backend: {
                        async call() { return { text: ++calls === 1 ? `Summary ${i}` : 'Steady progress.', effective: {} }; },
                        async close() {},
                    },
                });
                expect(result).toMatchObject({
                    status: 'success', value: { run: i, today: `Summary ${i}`, trend: i === 1 ? '' : 'Steady progress.' },
                });
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
        const responses = ['55', '{"setup":"A programmer walks into a bar.","punchline":"It was a FooBar."}', 'A pet story.'];
        let calls = 0;
        const result = await run(parse(load('basics.spl')), {
            logger: new Logger('silent'),
            backend: {
                async call() {
                    const text = responses[calls++];
                    if (text === undefined) throw new Error('unexpected extra generation');
                    return { text, effective: {} };
                },
                async close() {},
            },
        });
        expect(result).toMatchObject({
            status: 'success',
            value: {
                fib: 55, modelFib: 55,
                joke: { setup: 'A programmer walks into a bar.', punchline: 'It was a FooBar.' },
                animal: 'A pet story.',
            },
        });
        expect(calls).toBe(3);
    });

    it('triages every issue using validated output without live model calls', async () => {
        let calls = 0;
        const result = await run(parse(load('triage-issues.spl')), {
            cwd: path.dirname(dir), logger: new Logger('silent'),
            backend: {
                async call() {
                    calls++;
                    return {
                        text: calls <= 4 ? '{"label":"bug","priority":"high","reason":"Needs attention"}' : 'Four urgent bugs.',
                        effective: {},
                    };
                },
                async close() {},
            },
        });
        expect(result).toMatchObject({ status: 'success', value: { counts: { bug: 4 }, urgent: expect.any(Array) } });
        expect(calls).toBe(5);
    });

    it('checks invoice structure and arithmetic offline', async () => {
        const invoice = {
            vendor: 'ACME', number: 'INV-2026-0042', date: '2026-03-14', currency: 'EUR',
            lines: [
                { description: 'Bolts', quantity: 3, unit_price: 12.5 },
                { description: 'Gloves', quantity: 2, unit_price: 8.9 },
                { description: 'Drill', quantity: 1, unit_price: 119 },
            ],
            subtotal: 174.3, total: 207.42,
        };
        const result = await run(parse(load('extract-invoice.spl')), {
            cwd: path.dirname(dir), logger: new Logger('silent'),
            backend: { async call() { return { text: JSON.stringify(invoice), effective: {} }; }, async close() {} },
        });
        expect(result).toMatchObject({ status: 'success', value: invoice });
    });
});

describe.skipIf(!live)('examples on Copilot', () => {
    it(
        'triage-issues labels every issue and aggregates the counts',
        async () => {
            const backend = new RecordingCopilot(path.dirname(dir));
            try {
                const result = await run(parse(load('triage-issues.spl')), { backend, logger: new Logger('silent'), cwd: path.dirname(dir) });
                expect(result.status).toBe('success');
                const v = (result as { value: { counts: Record<string, number>; urgent: string[] } }).value;
                expect(Object.values(v.counts).reduce((a, b) => a + b, 0)).toBe(4);
                expect(Array.isArray(v.urgent)).toBe(true);
            } finally {
                await backend.close();
            }
        },
        LIVE_TIMEOUT * 3,
    );
});
