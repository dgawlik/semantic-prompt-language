import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LlmBackend, LlmRequest, RuntimeAction } from '../src/llm.js';
import { parseMarkdown, type Workflow } from '../src/markdown.js';
import { parseSpl } from '../src/spl.js';
import { Trace } from '../src/trace.js';
import { checkWorkflow, run, type RunOptions, type RunResult } from '../src/workflow.js';
import { NoLlm, acting, action, backend, cleanTemp, collecting, scripted, silent, tempDir, text } from './helpers.js';

const lang = path.resolve(__dirname, '..');
const dir = path.join(lang, 'examples');
const load = (name: string): string => fs.readFileSync(path.join(dir, name), 'utf8');
const workflows = fs.readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .map(name => name.replaceAll('\\', '/'))
    .filter(name => /\.(?:md|spl)$/.test(name) && !name.startsWith('data/'))
    .sort();
const parseExample = (name: string): Workflow => (name.endsWith('.spl') ? parseSpl : parseMarkdown)(load(name));

afterEach(() => {
    vi.unstubAllEnvs();
    cleanTemp();
});

/** A scratch working directory with copies of the sample data, so examples never write into the repository. */
function scratch(): string {
    const cwd = tempDir('spl-example-');
    fs.cpSync(path.join(dir, 'data'), path.join(cwd, 'examples', 'data'), { recursive: true });
    return cwd;
}

function example(name: string, options: Partial<RunOptions> = {}): Promise<RunResult> {
    const cwd = options.cwd ?? scratch();
    return run(parseExample(name), {
        backend: new NoLlm(), logger: silent, cwd, file: path.join(cwd, path.basename(name)), ...options,
    });
}

const written = (cwd: string, name: string): string => fs.readFileSync(path.join(cwd, name), 'utf8');
const save = (name: string, value: unknown, schema?: string): RuntimeAction =>
    action('save_variable', { name, value, ...(schema ? { schema } : {}) });

type Step = RuntimeAction | ((results: unknown[]) => RuntimeAction);

/** Answers generation calls with `replies` in order; each blockquote performs its next list of tool calls. */
function model(replies: string[], ...commands: Step[][]): LlmBackend & { asks: LlmRequest[]; quotes: LlmRequest[]; results: unknown[][] } {
    const asks: LlmRequest[] = [];
    const quotes: LlmRequest[] = [];
    const results: unknown[][] = [];
    return { asks, quotes, results, ...backend(async request => {
        if (!request.naturalLanguage) {
            const reply = replies[asks.push(request) - 1];
            if (reply === undefined) throw new Error(`unexpected model call ${asks.length}: ${request.prompt.slice(-80)}`);
            return { text: reply, effective: {} };
        }
        const steps = commands[quotes.push(request) - 1];
        if (!steps) throw new Error(`unexpected blockquote ${quotes.length}: ${request.prompt.slice(-80)}`);
        const done: unknown[] = [];
        results.push(done);
        for (const step of steps) done.push(await request.invokeAction!(typeof step === 'function' ? step(done) : step));
        return { text: 'Done.', effective: {} };
    }) };
}

describe('examples', () => {
    it('finds the shipped workflows, including subfolders but not the sample data', () => {
        expect(workflows).toEqual(expect.arrayContaining(['hi.md', 'basics.md', 'code-review.spl', 'deterministic/node.md', 'imports/run.md']));
        expect(workflows).not.toContain('data/product-update.md');
    });

    it.each(workflows)('%s parses and passes the static checks', name => {
        const workflow = parseExample(name);
        expect(workflow.steps.length).toBeGreaterThan(0);
        expect(checkWorkflow(workflow, lang)).toEqual([]);
    });
});

describe('examples without a model', () => {
    it.each([
        ['typed-data.md', { name: 'Ada', favorite: 'blue', address: { city: 'London', postalCode: null } }],
        ['markdown.md', [
            '# Report', '', '**Ready**', '', '- `parser`: passed', '- `runtime`: passed', '',
            '| Check | Result |', '| --- | --- |', '| build | ok |', '| tests | ok |', '',
        ].join('\n')],
        ['deterministic/enumsStructs.md', { num: 1, desc: 'hi' }],
        ['deterministic/types.md', { prices: [1250, 2500], discounted: 750 }],
        ['deterministic/node.md', {
            fib: 89, evens: [0, 2, 4, 6, 8], file: 'node.md',
            digest: createHash('sha256').update('89').digest('hex').slice(0, 8),
        }],
    ])('runs %s to its documented result', async (name, value) => {
        expect(await example(name)).toEqual({ status: 'success', value, hasValue: true });
    });

    it('typed-data.md returns a parsed object that carries its methods', async () => {
        const { logger, events } = collecting();
        const result = await example('typed-data.md', { logger });
        expect(result.status === 'success' && (result.value as { greeting(): string }).greeting()).toBe('Hello Ada');
        expect(events.map(text)).toEqual(['log: Hello Ada Money\n{"minimum":0,"desc":"Amount in cents"}']);
    });

    it('imports/run.md imports its helper module and a Node.js built-in from the lang folder', async () => {
        expect(await example('imports/run.md', { cwd: lang })).toEqual({
            status: 'success', value: { fib: 55, factorial: 3628800, platform: os.platform() }, hasValue: true,
        });
        expect(await example('imports/run.md')).toMatchObject({
            status: 'failure', failure: { status_code: 'runtime_error', reason: expect.stringContaining('Cannot find module'), line: 14 },
        });
    });
});

describe('examples with scripted models', () => {
    it('hi.md asks for typed flashcards, lets an agent pick one and writes it as Markdown', async () => {
        const cwd = scratch();
        const calls: LlmRequest[] = [];
        const llm = backend(async request => {
            calls.push(request);
            if (request.naturalLanguage) {
                const cards = await request.invokeAction!(action('load_variable', { name: 'cards' })) as unknown[];
                await request.invokeAction!(save('hardest', cards[2]));
                return { text: 'Done.', effective: {} };
            }
            const topic = ['recursion', 'closures', 'regular expressions'].find(topic => request.prompt.includes(`about ${topic}`))!;
            const term = topic === 'closures' && !request.prompt.includes('Validation failed') ? 'Closures' : topic;
            return { text: JSON.stringify({ term, definition: `${topic} in one line`, description: `A paragraph about ${topic}.` }), effective: {} };
        });
        expect(await example('hi.md', { cwd, backend: llm })).toEqual({ status: 'success', value: null, hasValue: false });
        expect(written(cwd, 'out/hardest-card.md')).toBe('### regular expressions\n\n**regular expressions in one line**\n\nA paragraph about regular expressions.\n');
        expect(calls.map(call => call.kind)).toEqual(['ask', 'ask', 'ask', 'ask', 'agent']);
        expect(calls.every(call => call.model === 'gpt-6-luna' && call.prompt.includes('\n\nBe concise.\n\n'))).toBe(true);
        expect(calls[0].prompt).toContain('"description":"One line about"');
        expect(calls[3].prompt).toContain('Validation failed: $.term: expected "recursion" | "closures" | "regular expressions", got "Closures"');
        expect(calls[4].prompt).toContain('Blockquote:\nPick the item of @cards whose card a beginner would find hardest. Save that item to @hardest');
    });

    it.each([
        [['true'], 'Today is Friday!'],
        [['false', 'Mondays again.'], 'Mondays again.'],
    ])('is-friday.md branches on a boolean answer %j', async (replies, value) => {
        const llm = scripted(...replies);
        expect(await example('is-friday.md', { backend: llm })).toEqual({ status: 'success', value, hasValue: true });
        expect(llm.calls).toHaveLength(replies.length);
        expect(llm.calls[0].prompt).toContain('{"type":"boolean"}');
    });

    it('types.md decodes union numbers and a class instance', async () => {
        const { logger, events } = collecting();
        const llm = scripted('1', '1.5', '2', '2.5', '{"firstName":"Ada","lastName":"Lovelace","age":37}');
        expect(await example('types.md', { backend: llm, logger })).toEqual({ status: 'success', value: 'Ada Lovelace at age 37', hasValue: true });
        expect(events.filter(event => event.origin === 'script').map(text)).toEqual(['log: Integer: 1', 'log: Float: 1.5', 'log: Integer: 2', 'log: Float: 2.5']);
        expect(llm.calls.slice(0, 4).every(call => call.tokens === 128 && call.prompt.includes('Either float or int'))).toBe(true);
        expect(llm.calls[4].prompt).toContain('Age in years');
    });

    it.each(['37.5', '9223372036854775807', '"37"'])('types.md rejects the non-integer age %s', async age => {
        const llm = scripted('1', '1.5', '2', '2.5', `{"firstName":"Ada","lastName":"Lovelace","age":${age}}`);
        expect(await example('types.md', { backend: llm })).toMatchObject({
            status: 'failure', failure: { status_code: 'validation_failed', reason: expect.stringContaining('$.age: expected int'), line: 31 },
        });
    });

    const invoice = {
        vendor: 'ACME Industrial Supplies GmbH', number: 'INV-2026-0042', date: '2026-03-14', currency: 'EUR',
        lines: [
            { description: 'Hex bolt M8 (box of 100)', quantity: 3, unit_price: 1250 },
            { description: 'Safety gloves, size L', quantity: 2, unit_price: 890 },
            { description: 'Cordless drill', quantity: 1, unit_price: 11900 },
        ],
        subtotal: 17430, tax: 3312, total: 20742,
    };

    it('extract-invoice.md checks invoice structure and arithmetic, then writes the JSON', async () => {
        const cwd = scratch();
        const llm = acting(action('load_variable', { name: 'text' }), action('load_variable', { name: 'Invoice' }), save('invoice', invoice, 'Invoice'));
        expect(await example('extract-invoice.md', { cwd, backend: llm })).toEqual({ status: 'success', value: invoice, hasValue: true });
        expect(JSON.parse(written(cwd, 'out/invoices/INV-2026-0042.json'))).toEqual(invoice);
        expect(llm.results[0]).toBe(written(cwd, 'examples/data/invoice.txt'));
        expect(llm.results[1]).toMatchObject({ type: 'object', required: Object.keys(invoice) });
        expect(llm.calls[0].prompt).toContain('- Avoid: filling in values that are not printed on the invoice');
    });

    it.each([
        ['line items that do not add up', { ...invoice, subtotal: 17431, total: 20743 }, 'assertion_failed', 'line items add up to 17430 cents but the subtotal is 17431 cents'],
        ['a total that misses subtotal plus tax by one cent', { ...invoice, total: 20743 }, 'assertion_failed', 'subtotal 17430 + tax 3312 does not equal total 20743 cents'],
        ['a fractional amount', { ...invoice, tax: 3312.5 }, 'validation_failed', 'invoice.tax: expected Money, got 3312.5'],
    ])('extract-invoice.md rejects %s', async (_, wrong, code, reason) => {
        const cwd = scratch();
        expect(await example('extract-invoice.md', { cwd, backend: acting(save('invoice', wrong, 'Invoice')) })).toMatchObject({
            status: 'failure', failure: { status_code: code, reason: expect.stringContaining(reason) },
        });
        expect(fs.existsSync(path.join(cwd, 'out'))).toBe(false);
    });

    it('incident-report.md counts and groups log errors in code and saves the narrative', async () => {
        const cwd = scratch();
        const report = ['Summary', 'Timeline', 'Impact', 'Likely root cause', 'Follow-ups'].map(section => `## ${section}\n`).join('');
        const llm = acting(action('load_variable', { name: 'errors' }), action('load_variable', { name: 'counts' }), save('report', report));
        expect(await example('incident-report.md', { cwd, backend: llm })).toEqual({
            status: 'success', value: { errors: 6, groups: 3, report: './reports/incident-2026-10-25.md' }, hasValue: true,
        });
        expect(written(cwd, 'reports/incident-2026-10-25.md')).toBe(report);
        expect(llm.results.slice(0, 2)).toEqual([[
            '3x payments: Timeout calling payment provider after 30000ms (first at 2026-10-25T14:02:11Z)',
            '2x api: POST /v2/checkout returned 502 (first at 2026-10-25T14:02:15Z)',
            '1x db: Connection pool exhausted (first at 2026-10-25T14:04:10Z)',
        ], { INFO: 5, WARN: 2, ERROR: 6 }]);
        expect(await example('incident-report.md', { backend: acting(save('report', report.replace('## Impact\n', ''))) })).toMatchObject({
            status: 'failure', failure: { status_code: 'assertion_failed', reason: "report is missing the 'Impact' section" },
        });
    });

    it('incident-report.md ends early without a model when the log has no errors', async () => {
        const cwd = scratch();
        fs.writeFileSync(path.join(cwd, 'quiet.log'), '2026-10-25T13:58:02Z INFO  api       GET /v2/reports 200 in 84ms\n');
        expect(await example('incident-report.md', { cwd, args: ['./quiet.log'] })).toEqual({ status: 'success', value: 'No errors in ./quiet.log', hasValue: true });
    });

    it.each([
        ['ok', 'Dark mode is here.'],
        ['Make the wording clearer', 'Dark mode has arrived.'],
    ])('human-review.md applies the reviewer feedback %j', async (feedback, final) => {
        const cwd = scratch();
        const questions: string[] = [];
        const llm = model([],
            [action('load_variable', { name: 'changes' }), save('draft', 'Dark mode is here.')],
            [action('load_variable', { name: 'feedback' }), results => results[0] === 'ok' ? action('load_variable', { name: 'final' }) : save('final', final)]);
        const result = await example('human-review.md', { cwd, backend: llm, human: question => { questions.push(question); return feedback; } });
        expect(result).toEqual({ status: 'success', value: { draft: 'Dark mode is here.', feedback, final }, hasValue: true });
        expect(questions).toEqual(['Reply "ok" to accept this draft, or describe what to change:\n\nDark mode is here.']);
        expect(llm.results[0][0]).toBe(written(cwd, 'examples/data/product-update.md'));
        expect(written(cwd, 'out/review-draft.txt')).toBe('Dark mode is here.');
        expect(written(cwd, 'out/announcement.txt')).toBe(final);
    });

    const sieve = 'function sieve(number) {\n    const primes = [];\n    for (let n = 2; n <= number; n++) if (primes.every(prime => n % prime)) primes.push(n);\n    return primes;\n}';
    const slugify = "function slugify(title) {\n    return title.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');\n}";

    it('codegen.md defines generated functions from a blockquote and from codegen()', async () => {
        const cwd = scratch();
        const { logger, events } = collecting();
        const llm = scripted(`\`\`\`js\n${sieve}\n\`\`\``, slugify);
        expect(await example('codegen.md', { cwd, backend: llm, logger })).toEqual({ status: 'success', value: 'hello-generated-world', hasValue: true });
        expect(events.filter(event => event.origin === 'script').map(text)).toEqual([`log:\n${JSON.stringify([2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53, 59, 61, 67, 71, 73, 79, 83, 89, 97])}`]);
        expect(llm.calls[0].prompt).toContain('Function description:\nGenerate sieve(number) sieve of eratosthenes function that returns primes until given number');
        expect(llm.calls[1].prompt).toContain('Function description:\nslugify(title): lowercase, trim');
        expect(fs.readdirSync(cwd)).toEqual(['examples']);
    });

    it('codegen.md saves generated code beside the workflow in traced runs and reuses it later', async () => {
        const cwd = scratch();
        const source = load('codegen.md');
        const traced = async (name: string, llm: LlmBackend): Promise<RunResult> => {
            const trace = Trace.open(path.join(cwd, name), { source, runtime: 'test', cwd });
            try {
                return await example('codegen.md', { cwd, backend: llm, trace });
            } finally {
                trace.close();
            }
        };
        expect(await traced('first.jsonl', scripted(sieve, slugify))).toMatchObject({ status: 'success', value: 'hello-generated-world' });
        expect(written(cwd, 'codegen.sieve.js')).toMatch(/^\/\/ @CODEGEN sha256:[0-9a-f]{64}\nfunction sieve\(number\) \{/);
        expect(fs.existsSync(path.join(cwd, 'codegen.slugify.js'))).toBe(true);
        expect(await traced('second.jsonl', new NoLlm())).toMatchObject({ status: 'success', value: 'hello-generated-world' });
    });

    const basics = (modelFib: number): Step[][] => [
        [action('call_function', { name: 'factorial', args: [15] }), results => save('fact15', results[0])],
        [action('call_function', { name: 'fib', args: [10] }), results => save('fib10', results[0])],
        [action('load_variable', { name: 'fib10' }), results => save('fibPlus2', (results[0] as number) + 2)],
        [save('modelFib10', modelFib)],
        [save('joke', { setup: 'A programmer walks into a bar.', punchline: 'It was a FooBar.' })],
        [save('animal', 'A pet story.')],
    ];

    it('basics.md shares functions and variables between fences and blockquote agents', async () => {
        const llm = model([], ...basics(55));
        expect(await example('basics.md', { backend: llm })).toEqual({
            status: 'success', hasValue: true,
            value: {
                fib: 55, modelFib: 55, animal: 'A pet story.',
                joke: { setup: 'A programmer walks into a bar.', punchline: 'It was a FooBar.' },
            },
        });
        expect(llm.results.slice(0, 3)).toEqual([[1307674368000, 1307674368000], [55, 55], [55, 57]]);
        expect(llm.quotes).toHaveLength(6);
        expect(llm.quotes[0].prompt).toContain('"fib":"function fib(n)"');
        expect(llm.quotes[4].prompt).not.toContain('Answer in Chinese');
        expect(llm.quotes[5].prompt).toContain('- Follow: Answer in Chinese\n- Avoid: Mentioning the word cat');
        expect(llm.quotes[5].prompt).toContain('Blockquote:\nParagraph of funny story about a pet animal -> @animal');
    });

    it('basics.md rejects a wrong model answer with exact code', async () => {
        const llm = model([], ...basics(54));
        expect(await example('basics.md', { backend: llm })).toMatchObject({
            status: 'failure', failure: { status_code: 'assertion_failed', reason: 'Oops, the model got it wrong', line: 33 },
        });
        expect(llm.quotes).toHaveLength(4);
    });

    it('color-poem.md asks both questions through blockquote agents', async () => {
        const questions: [string, number][] = [];
        const answers = ['blue', 'apple'];
        const ask = (question: string, name: string): Step[] => [action('ask_human', { question }), results => save(name, results[0])];
        const llm = model([],
            ask('What is your favorite color?', 'color'), ask('What is your favorite fruit?', 'fruit'),
            [action('load_variable', { name: 'color' }), action('load_variable', { name: 'fruit' }), results => save('poem', `${results[0]} ${results[1]}`)]);
        const result = await example('color-poem.md', { backend: llm, human: (question, line) => { questions.push([question, line]); return answers.shift()!; } });
        expect(result).toEqual({ status: 'success', value: { poem: 'blue apple' }, hasValue: true });
        expect(questions).toEqual([['What is your favorite color?', 7], ['What is your favorite fruit?', 9]]);
    });

    it('randomness.md repeats one seeded request and compares the answers', async () => {
        const recipe = 'Bake apples in a pastry crust with sugar and cinnamon.';
        const llm = scripted(recipe, recipe, 'true');
        expect(await example('randomness.md', { backend: llm })).toEqual({ status: 'success', value: 'It works', hasValue: true });
        for (const call of llm.calls.slice(0, 2)) {
            expect(call).toMatchObject({ kind: 'ask', model: 'gpt-6-luna', tokens: 1024, randomness: { seed: 13, temperature: 0, top_p: 0.0001 } });
            expect(call.prompt.endsWith('<most-frequent>give a recipe for an apple pie</most-frequent>')).toBe(true);
        }
        expect(llm.calls[2].randomness).toBeUndefined();
        expect(await example('randomness.md', { backend: scripted(recipe, 'Stew pears.', 'false') })).toMatchObject({
            status: 'failure', failure: { status_code: 'explicit_failure', reason: 'Not similar' },
        });
    });

    it('journal.md keeps its state in a file and bounds the history across runs', async () => {
        const cwd = scratch();
        fs.writeFileSync(path.join(cwd, 'journal.json'), '{"runs":0,"history":[]}');
        for (let i = 1; i <= 6; i++) {
            const llm = model([],
                [action('load_variable', { name: 'notes' }), save('today', `Summary ${i}`)],
                [action('load_variable', { name: 'history' }), results => (results[0] as unknown[]).length > 1 ? save('trend', 'Steady progress.') : action('load_variable', { name: 'trend' })]);
            expect(await example('journal.md', { cwd, backend: llm })).toEqual({
                status: 'success', value: { run: i, today: `Summary ${i}`, trend: i === 1 ? '' : 'Steady progress.' }, hasValue: true,
            });
            const state = JSON.parse(written(cwd, 'journal.json'));
            expect(state.runs).toBe(i);
            expect(state.history).toHaveLength(Math.min(i, 5));
            expect(state.history.at(-1)).toEqual({ run: i, summary: `Summary ${i}` });
        }
    });

    it('translate-docs.md verifies that translations keep links, code spans and headings', async () => {
        const translation = (title: string) => [
            `# ${title}`, '', '## New', '', '- `GET /v2/reports` supports `limit` and `cursor`.', '',
            '## Fixes', '', 'See https://example.com/help or write to support@example.com.',
        ].join('\n');
        const cwd = scratch();
        const good = acting(save('translations', { en: translation('Product update'), de: translation('Produktupdate') }));
        expect(await example('translate-docs.md', { cwd, backend: good, args: ['en', 'de'] })).toEqual({ status: 'success', value: ['en', 'de'], hasValue: true });
        expect(written(cwd, 'out/translations/product-update.de.md')).toContain('# Produktupdate');
        expect(good.calls[0].prompt).toContain('- Follow: Keep the Markdown structure, URLs, e-mail addresses and `code spans` exactly as in the source');

        for (const [broken, reason] of [
            [translation('Product update').replace('support@example.com', 'support'), 'en: lost support@example.com'],
            [translation('Product update').replace('## Fixes', '### Fixes'), 'en: heading structure changed'],
            [undefined, "missing translation for 'en'"],
        ] as const) {
            const failed = scratch();
            expect(await example('translate-docs.md', { cwd: failed, backend: acting(save('translations', { en: broken })), args: ['en'] })).toMatchObject({
                status: 'failure', failure: { status_code: 'assertion_failed', reason },
            });
            expect(fs.existsSync(path.join(failed, 'out'))).toBe(false);
        }
    });

    it('env.md lets agents read environment variables one at a time and code read args', async () => {
        vi.stubEnv('lhs', '2');
        vi.stubEnv('rhs', '40');
        const { logger, events } = collecting();
        const llm = model([],
            [action('get_env', { name: 'lhs' }), action('get_env', { name: 'rhs' }), results => save('s', Number(results[0]) + Number(results[1]))],
            [action('load_variable', { name: 's' }), results => action('success', { value: results[0] })]);
        expect(await example('env.md', { backend: llm, logger, args: ['first', 'second'] })).toEqual({ status: 'success', value: 42, hasValue: true });
        expect(llm.results[0].slice(0, 2)).toEqual(['2', '40']);
        expect(events.filter(event => event.origin === 'script').map(text)).toEqual(['log: first second', `log: HOME is ${process.env.HOME ?? process.env.USERPROFILE}`]);
    });

    it('repo.md fails on high severity findings and succeeds otherwise', async () => {
        const issue = { name: 'Command injection', 'cwe-id': 'CWE-78', link: 'src/run.js', describtion: 'Unescaped shell input.' };
        expect(await example('repo.md', { backend: acting(save('vulnerabilities', { high: [], medium: [issue], low: [issue] })) }))
            .toEqual({ status: 'success', value: 'Analyzed', hasValue: true });
        expect(await example('repo.md', { backend: acting(save('vulnerabilities', { high: [issue] })) })).toMatchObject({
            status: 'failure', failure: { status_code: 'explicit_failure', reason: `High vulnerabilities found. Fix this one first ${JSON.stringify(issue)}`, line: 20 },
        });
    });

    it('mcp.md restricts an agent to one MCP tool and requires cited sources', async () => {
        const answer = 'Run spl login first.\nSources:\nhttps://docs.example.com/start';
        const llm = model([answer], [action('load_variable', { name: 'answer' }), results => action('success', { value: `- ${results[0]}` })]);
        expect(await example('mcp.md', { backend: llm, args: ['How do I log in?'] })).toEqual({ status: 'success', value: `- ${answer}`, hasValue: true });
        expect(llm.asks[0]).toMatchObject({ kind: 'agent', restrictions: { list: [{ kind: 'mcp', values: ['docs/search'] }] } });
        expect(llm.asks[0].prompt).toContain('Use docs/search to answer: How do I log in?');
        expect(llm.quotes[0].prompt).toContain('- Avoid: adding facts that are not in @answer');
        expect(await example('mcp.md', { backend: model(['No idea.']) })).toMatchObject({
            status: 'failure', failure: { status_code: 'assertion_failed', reason: 'the answer does not cite its sources' },
        });
    });

    const finding = (severity: string) => ({ severity, title: `A ${severity} problem`, location: 'src/app.js:12', fix: 'Validate the input.' });
    const review = (...severities: string[]): Step[][] => [
        [save('notes', 'Unvalidated input in src/app.js:12.')],
        [action('load_variable', { name: 'Review' }), save('review', { findings: severities.map(finding) }, 'Review')],
        [action('load_variable', { name: 'groups' }), results => action('write_file', { path: './reports/review.md', content: `# Review\n\n${Object.keys(results[0] as object).join(', ')}\n` })],
    ];

    it.each(['code-review.md', 'code-review.spl'])('%s turns agent notes into typed findings and a report inside the allowed folder', async name => {
        const cwd = scratch();
        const llm = model([], ...review('medium', 'low', 'medium'));
        expect(await example(name, { cwd, backend: llm })).toEqual({
            status: 'success', hasValue: true,
            value: 'medium: A medium problem (src/app.js:12)\nlow: A low problem (src/app.js:12)\nmedium: A medium problem (src/app.js:12)',
        });
        expect(written(cwd, 'reports/review.md')).toBe('# Review\n\nmedium, low\n');
        expect(llm.quotes.map(quote => quote.model)).toEqual(['gpt-6-luna', 'gpt-6-luna', 'gpt-6.1-sol']);
        expect(llm.quotes.map(quote => quote.restrictions.list.map(item => item.kind))).toEqual([['fs', 'exec'], [], ['fs']]);
        expect(llm.quotes[0].prompt).toContain('- Avoid: suggesting purely stylistic changes');
    });

    it.each(['code-review.md', 'code-review.spl'])('%s fails on high severity findings and rejects unknown severities', async name => {
        expect(await example(name, { backend: model([], ...review('low', 'high')) })).toMatchObject({
            status: 'failure', failure: { status_code: 'explicit_failure', reason: '1 high severity finding(s), see ./reports/review.md' },
        });
        expect(await example(name, { backend: model([], ...review('critical')) })).toMatchObject({
            status: 'failure', failure: { status_code: 'validation_failed', reason: expect.stringContaining('expected "low" | "medium" | "high", got "critical"') },
        });
    });
});
