import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { check } from '../src/check.js';
import { compile } from '../src/compile.js';
import { documentMarkdown } from '../src/doc.js';
import type { LlmBackend, LlmRequest, RuntimeAction } from '../src/llm.js';
import { run, type RunOptions, type RunResult } from '../src/workflow.js';
import { NoLlm, action, backend, cleanTemp, save, silent, tempDir } from './helpers.js';

const lang = path.resolve(__dirname, '..');
const dir = path.join(lang, 'examples');
const load = (name: string): string => fs.readFileSync(path.join(dir, name), 'utf8');
const workflows = fs.readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .map(name => name.replaceAll('\\', '/'))
    .filter(name => name.endsWith('.spl'))
    .sort();

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
    return run(load(name), { backend: new NoLlm(), logger: silent, cwd: options.cwd ?? scratch(), file: path.join(dir, name), ...options });
}

const written = (cwd: string, name: string): string => fs.readFileSync(path.join(cwd, name), 'utf8');
type Act = RuntimeAction | ((results: unknown[]) => RuntimeAction);

/** Answers ask calls with `replies` in order; each agent block performs its next list of tool calls. */
function model(replies: string[], ...agents: Act[][]): LlmBackend & { asks: LlmRequest[]; blocks: LlmRequest[]; results: unknown[][] } {
    const asks: LlmRequest[] = [];
    const blocks: LlmRequest[] = [];
    const results: unknown[][] = [];
    return { asks, blocks, results, ...backend(async request => {
        if (!request.runtimeTools) {
            const reply = replies[asks.push(request) - 1];
            if (reply === undefined) throw new Error(`unexpected model call ${asks.length}: ${request.prompt.slice(-80)}`);
            return { text: reply, effective: {} };
        }
        const steps = agents[blocks.push(request) - 1];
        if (!steps) throw new Error(`unexpected agent block ${blocks.length}: ${request.prompt.slice(-80)}`);
        const done: unknown[] = [];
        results.push(done);
        for (const step of steps) done.push(await request.invokeAction!(typeof step === 'function' ? step(done) : step));
        return { text: 'Done.', effective: {} };
    }) };
}

describe('examples', () => {
    it('are all .spl files, including subfolders', () => {
        expect(workflows).toContain('hi.spl');
        expect(workflows).toContain('deterministic/node.spl');
        expect(fs.readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter(name => name.endsWith('.md') && !name.startsWith('data'))).toEqual([]);
    });

    it.each(workflows)('%s compiles, documents itself and starts with a title', name => {
        const source = load(name);
        expect(() => compile(source)).not.toThrow();
        expect(documentMarkdown(source)).toMatch(/^# \S/);
    });

    it('all pass spl check', () => {
        expect(workflows.flatMap(name => check(path.join(dir, name)))).toEqual([]);
    }, 120_000);
});

describe('examples without a model', () => {
    it.each([
        ['deterministic/enumsStructs.spl', { num: 1, desc: 'hi' }],
        ['deterministic/types.spl', { prices: [1250, 2500], discounted: 750 }],
        ['markdown.spl', '# Report\n\n**Ready**\n\n- `parser`: passed\n- `runtime`: passed\n\n| Check | Result |\n| --- | --- |\n| build | ok |\n| tests | ok |\n'],
        ['imports/math.spl', []],
    ])('%s', async (name, value) => {
        expect(await example(name)).toEqual({ status: 'success', value, hasValue: true });
    });

    it('deterministic/node.spl uses Node.js built-ins and import.meta', async () => {
        expect(await example('deterministic/node.spl')).toMatchObject({ value: { fib: 89, evens: [0, 2, 4, 6, 8], file: 'node.spl' } });
    });

    it('typed-data.spl returns a parsed object that carries its methods', async () => {
        const result = await example('typed-data.spl');
        expect(result).toMatchObject({ status: 'success', value: { name: 'Ada', favorite: 'blue', address: { city: 'London', postalCode: null } } });
        expect((result as { value: { greeting(): string } }).value.greeting()).toBe('Hello Ada');
    });

    it('imports/run.spl imports a module, a Node.js built-in and another workflow, relative to the file', async () => {
        expect(await example('imports/run.spl')).toMatchObject({ value: { fib: 55, factorial: 3628800, square: 49, squares: [4, 9] } });
        expect(await example('imports/math.spl', { args: ['2', '3'] })).toMatchObject({ value: [4, 9] });
    });

    it('codegen.spl reuses the code cached beside it', async () => {
        expect(await example('codegen.spl')).toMatchObject({ status: 'success', value: 'hello-generated-world' });
    });

    it('incident-report.spl ends early without a model when the log has no errors', async () => {
        const cwd = scratch();
        fs.writeFileSync(path.join(cwd, 'quiet.log'), '2026-10-25T10:00:00Z INFO api started\n');
        expect(await example('incident-report.spl', { cwd, args: ['./quiet.log'] })).toMatchObject({ value: 'No errors in ./quiet.log' });
    });
});

describe('examples with scripted models', () => {
    it('basics.spl lets one agent call functions and save typed outputs, then checks them in code', async () => {
        const agent = model(['{"setup":"Why?","punchline":"Because."}', 'A dog.'], [
            action('callFunction', { name: 'factorial', args: [15] }), results => save('fact15', results[0]),
            action('callFunction', { name: 'fib', args: [10] }), results => save('fib10', results[2]),
            save('fibPlus2', 57), save('modelFib10', 55),
        ]);
        expect(await example('basics.spl', { backend: agent })).toEqual({
            status: 'success', hasValue: true, value: { fib: 55, modelFib: 55, joke: { setup: 'Why?', punchline: 'Because.' }, animal: 'A dog.' },
        });
        expect(agent.blocks[0]).toMatchObject({ model: 'gpt-6-luna', reasoningEffort: 'high' });
        expect(agent.asks[0].prompt).toContain('- Follow: Answer in Chinese\n- Avoid: Mentioning the word cat');
        const wrong = model([], [save('fact15', 1), save('fib10', 55), save('fibPlus2', 57), save('modelFib10', 54)]);
        expect(await example('basics.spl', { backend: wrong })).toMatchObject({ failure: { status_code: 'assertion_failed', reason: 'Oops, the model got it wrong', line: 35 } });
    });

    it('hi.spl asks for typed flashcards, lets an agent pick one and writes it as Markdown', async () => {
        const cwd = scratch();
        const card = (term: string) => JSON.stringify({ term, definition: `${term} in a line`, description: `About ${term}.` });
        const agent = model(['recursion', 'closures', 'regular expressions'].map(card), [
            action('loadVariable', { name: 'cards' }), results => save('hardest', (results[0] as unknown[])[2]),
        ]);
        expect(await example('hi.spl', { backend: agent, cwd })).toMatchObject({ status: 'success' });
        expect(agent.asks[0].prompt).toContain('- Follow: Be concise.');
        expect(written(cwd, 'out/hardest-card.md')).toBe('### regular expressions\n\n**regular expressions in a line**\n\nAbout regular expressions.\n');
    });

    it('goto.spl asks again with the error until the answer is an integer', async () => {
        const agent = model([], [save('response', 'forty-two')], [action('loadVariable', { name: 'error' }), save('response', 42)]);
        expect(await example('goto.spl', { backend: agent })).toMatchObject({ value: 42 });
        expect(agent.results[1][0]).toBe('Response is not an integer: "forty-two"');
    });

    it('conditional-workflows.spl runs blocks inside if and while', async () => {
        const increment: Act[] = [action('loadVariable', { name: 'i' }), results => save('i', Number(results[0]) + 1)];
        expect(await example('conditional-workflows.spl', { backend: model(['Blue'], increment, increment), args: ['color'] })).toMatchObject({ value: { result: 'Blue', i: 2 } });
        expect(await example('conditional-workflows.spl', { backend: model([], increment, increment) })).toMatchObject({ value: { result: null, i: 2 } });
    });

    it('answer.spl and rgb2.spl use what an agent saved', async () => {
        expect(await example('answer.spl', { backend: model([], [save('response', 42)]) })).toMatchObject({ value: 'Everything works as planned' });
        expect(await example('answer.spl', { backend: model([], [save('response', '42!')]) })).toMatchObject({ failure: { reason: 'Response is not an integer' } });
        expect(await example('rgb2.spl', { backend: model([], [action('loadVariable', { name: 'rgbString' }), save('colorName', 'navy')]), human: () => 'rgb(0, 0, 128)' }))
            .toMatchObject({ value: 'navy' });
    });

    it('enforce.spl and rgb.spl guide and type function calls', async () => {
        const guided = model(['故事', 'Historia']);
        expect(await example('enforce.spl', { backend: guided })).toMatchObject({ value: ['故事', 'Historia'] });
        expect(guided.asks.map(ask => ask.prompt.split('\n')[1])).toEqual(['- Follow: Answer in Chinese', '- Follow: Answer in Polish']);
        expect(guided.asks[1].prompt).toContain('@answer = "故事"');
        expect(await example('rgb.spl', { backend: model(['{"r":0,"g":0,"b":128}']), human: () => 'navy' })).toMatchObject({ value: '{"r":0,"g":0,"b":128}' });
    });

    it('color-poem.spl asks both questions through the agent', async () => {
        const questions: string[] = [];
        const agent = model(['A poem.'], [
            action('askHuman', { question: 'What is your favorite color?' }), results => save('color', results[0]),
            action('askHuman', { question: 'What is your favorite fruit?' }), results => save('fruit', results[2]),
        ]);
        expect(await example('color-poem.spl', { backend: agent, human: question => { questions.push(question); return questions.length === 1 ? 'teal' : 'fig'; } }))
            .toMatchObject({ value: { poem: 'A poem.' } });
        expect(agent.asks[0].prompt).toContain('@color = "teal"\n@fruit = "fig"');
    });

    it('types.spl decodes union numbers and a class instance', async () => {
        const person = '{"firstName":"Ada","lastName":"Lovelace","age":36}';
        expect(await example('types.spl', { backend: model(['1', '2.5', '3', '4.25', person]) })).toMatchObject({ value: 'Ada Lovelace at age 36' });
        expect(await example('types.spl', { backend: model(['1', '2.5', '3', '4.25', person.replace('36', '36.5')]) }))
            .toMatchObject({ failure: { status_code: 'validation_failed', reason: '$.age: expected Int, got 36.5' } });
    });

    it('is-friday.spl branches on a boolean answer', async () => {
        expect(await example('is-friday.spl', { backend: model(['true']) })).toMatchObject({ value: 'Today is Friday!' });
        expect(await example('is-friday.spl', { backend: model(['false', 'Alas.']) })).toMatchObject({ value: 'Alas.' });
    });

    it('env.spl reads environment variables in a block and arguments in code', async () => {
        vi.stubEnv('lhs', '2');
        vi.stubEnv('rhs', '40');
        const asked = model(['42']);
        expect(await example('env.spl', { backend: asked, args: ['first', 'second'] })).toMatchObject({ value: 42 });
        expect(asked.asks[0].prompt).toContain('@env.lhs = "2"\n@env.rhs = "40"');
    });

    it('extract-invoice.spl checks invoice structure and arithmetic, then writes the JSON', async () => {
        const cwd = scratch();
        const invoice = {
            vendor: 'Acme', number: 'INV-1', date: '2026-01-02', currency: 'USD',
            lines: [{ description: 'Widget', quantity: 2, unit_price: 500 }], subtotal: 1000, tax: 80, total: 1080,
        };
        expect(await example('extract-invoice.spl', { backend: model([JSON.stringify(invoice)]), cwd })).toMatchObject({ value: invoice });
        expect(JSON.parse(written(cwd, 'out/invoices/INV-1.json'))).toEqual(invoice);
        expect(await example('extract-invoice.spl', { backend: model([JSON.stringify({ ...invoice, subtotal: 900 })]), cwd: scratch() }))
            .toMatchObject({ failure: { status_code: 'assertion_failed', reason: 'line items add up to 1000 cents but the subtotal is 900 cents' } });
    });

    it('incident-report.spl counts and groups log errors in code and saves the narrative', async () => {
        const cwd = scratch();
        const asked = model(['Summary\nTimeline\nImpact\nLikely root cause\nFollow-ups']);
        const result = await example('incident-report.spl', { backend: asked, cwd });
        expect(result).toMatchObject({ status: 'success', value: { report: expect.stringMatching(/^\.\/reports\/incident-\d{4}-\d{2}-\d{2}\.md$/) } });
        const { errors, groups, report } = (result as { value: { errors: number; groups: number; report: string } }).value;
        expect(errors).toBeGreaterThan(0);
        expect(groups).toBeGreaterThan(0);
        expect(asked.asks[0].prompt).toContain('@counts = {"INFO":');
        expect(written(cwd, report)).toContain('Likely root cause');
    });

    it('human-review.spl rewrites the draft only when the reviewer asks', async () => {
        const cwd = scratch();
        expect(await example('human-review.spl', { backend: model(['Draft.']), cwd, human: () => ' OK ' })).toMatchObject({ value: { draft: 'Draft.', final: 'Draft.' } });
        expect(await example('human-review.spl', { backend: model(['Draft.', 'Clearer.']), cwd, human: () => 'Make it clearer' }))
            .toMatchObject({ value: { draft: 'Draft.', feedback: 'Make it clearer', final: 'Clearer.' } });
        expect(written(cwd, 'out/announcement.txt')).toBe('Clearer.');
    });

    it('journal.spl keeps its state in a file and bounds the history across runs', async () => {
        const cwd = scratch();
        fs.writeFileSync(path.join(cwd, 'journal.json'), '{"runs":0,"history":[]}');
        expect(await example('journal.spl', { backend: model(['Day one.']), cwd })).toMatchObject({ value: { run: 1, today: 'Day one.', trend: '' } });
        for (let run = 2; run <= 7; run++) {
            expect(await example('journal.spl', { backend: model([`Day ${run}.`, `Trend ${run}.`]), cwd })).toMatchObject({ value: { run, trend: `Trend ${run}.` } });
        }
        expect(JSON.parse(written(cwd, 'journal.json'))).toMatchObject({ runs: 7, history: [{ run: 3 }, { run: 4 }, { run: 5 }, { run: 6 }, { run: 7 }] });
    });

    it('translate-docs.spl verifies that translations keep links, code spans and headings', async () => {
        const cwd = scratch();
        const source = written(cwd, 'examples/data/product-update.md');
        expect(await example('translate-docs.spl', { backend: model([JSON.stringify({ de: source, pl: source })]), cwd, args: ['de', 'pl'] })).toMatchObject({ value: ['de', 'pl'] });
        expect(written(cwd, 'out/translations/product-update.pl.md')).toBe(source);
        expect(await example('translate-docs.spl', { backend: model([JSON.stringify({ de: source.replace(/^#+ /m, '') })]), cwd: scratch(), args: ['de'] }))
            .toMatchObject({ failure: { status_code: 'assertion_failed', reason: expect.stringMatching(/^de: /) } });
        expect(await example('translate-docs.spl', { backend: model(['{"de":"x"}']), cwd: scratch(), args: ['de', 'pl'] }))
            .toMatchObject({ failure: { status_code: 'assertion_failed' } });
    });

    it('randomness.spl repeats one seeded request and compares the answers', async () => {
        const asked = model(['Pie.', 'Pie.', 'true']);
        expect(await example('randomness.spl', { backend: asked })).toMatchObject({ value: 'It works' });
        expect(asked.asks.slice(0, 2).map(ask => [ask.randomness, ask.tokens, ask.reasoningEffort]))
            .toEqual(Array(2).fill([{ seed: 13, temperature: 0, top_p: 0.0001 }, 1024, undefined]));
        expect(await example('randomness.spl', { backend: model(['Pie.', 'Cake.', 'false']) })).toMatchObject({ failure: { reason: 'Not similar' } });
    });

    it('repo.spl fails on high severity findings and succeeds otherwise', async () => {
        const issue = { name: 'XSS', cwe: 'CWE-79', file: 'a.js', description: 'Unescaped output' };
        expect(await example('repo.spl', { backend: model([], [save('vulnerabilities', { high: [], medium: [issue], low: [] })]) })).toMatchObject({ value: 'Analyzed' });
        expect(await example('repo.spl', { backend: model([], [save('vulnerabilities', { high: [issue], medium: [], low: [] })]) }))
            .toMatchObject({ failure: { status_code: 'explicit_failure', reason: expect.stringContaining('CWE-79') } });
    });

    it('mcp.spl restricts its agent to one MCP tool and requires cited sources', async () => {
        const agent = model(['- Point\nSources: https://docs.example/start'], [action('loadVariable', { name: 'question' }), save('answer', 'Start here.\nSources: https://docs.example/start')]);
        expect(await example('mcp.spl', { backend: agent })).toMatchObject({ value: '- Point\nSources: https://docs.example/start' });
        expect(agent.blocks[0].restrictions.list).toEqual([{ kind: 'mcp', values: ['docs/search'] }]);
        expect(agent.results[0][0]).toBe('How do I get started?');
        expect(await example('mcp.spl', { backend: model([], [save('answer', 'No citations.')]) })).toMatchObject({ failure: { reason: 'the answer does not cite its sources' } });
    });

    it('code-review.spl turns agent notes into typed findings and a report inside the allowed folder', async () => {
        const cwd = scratch();
        fs.mkdirSync(path.join(cwd, 'src'));
        const finding = { severity: 'medium', title: 'Unchecked input', location: 'src/a.js:3', fix: 'Validate it' };
        const agent = model([JSON.stringify({ findings: [finding] })],
            [save('notes', 'One medium finding in src/a.js')],
            [action('loadVariable', { name: 'groups' }), action('writeFile', { path: './reports/review.md', content: '# Review' })]);
        expect(await example('code-review.spl', { backend: agent, cwd })).toMatchObject({ value: 'medium: Unchecked input (src/a.js:3)' });
        expect(agent.blocks[0].restrictions.list.map(item => item.kind)).toEqual(['fs', 'exec']);
        expect(agent.blocks[1]).toMatchObject({ model: 'gpt-6.1-sol' });
        expect(written(cwd, 'reports/review.md')).toBe('# Review');
        const high = model([JSON.stringify({ findings: [{ ...finding, severity: 'high' }] })], [save('notes', 'n')], []);
        expect(await example('code-review.spl', { backend: high, cwd })).toMatchObject({ failure: { reason: '1 high severity finding(s), see ./reports/review.md' } });
        expect(await example('code-review.spl', { backend: model([JSON.stringify({ findings: [{ ...finding, severity: 'severe' }] })], [save('notes', 'n')]), cwd }))
            .toMatchObject({ failure: { status_code: 'validation_failed', reason: '$.findings[0].severity: expected "low" | "medium" | "high", got "severe"' } });
    });
});
