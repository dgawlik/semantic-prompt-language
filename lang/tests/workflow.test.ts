import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Failure } from '../src/errors.js';
import { agent, ask, configure, enforce, readFile, restrict, struct, str, success } from '../src/index.js';
import { setAmbient } from '../src/runtime.js';
import {
    NoLlm, acting, action, backend, cleanTemp, collecting, document, exec, execMarkdown, fence, quote, scripted, silent, tempDir, text,
} from './helpers.js';

afterEach(() => {
    cleanTemp();
    setAmbient(undefined);
});

describe('library calls in fences', () => {
    it('assembles prompts from guidance, restrictions and hints', async () => {
        const model = scripted('first', 'second', 'third');
        const cwd = tempDir();
        const result = await exec(`
const a = await enforce('Answer in English', () => forbid(['jokes', 'emoji'], () => ask('Explain recursion', { len: 'sentence' })));
const b = await restrict({ fs: './out', net: 'example.com' }, () => think\`Plan \${1 + 1} steps\`);
const c = await agent('Act');
success([a, b, c]);`, { backend: model, cwd });
        expect(result).toMatchObject({ status: 'success', value: ['first', 'second', 'third'] });
        expect(model.calls[0]).toMatchObject({ kind: 'ask', reasoningEffort: undefined, showReasoning: true });
        expect(model.calls[0].prompt).toBe('Response guidance (not runtime validation):\n- Follow: Answer in English\n- Avoid: jokes\n- Avoid: emoji\n\nAnswer in a single sentence.\n\nExplain recursion');
        expect(model.calls[1]).toMatchObject({ kind: 'think', reasoningEffort: 'medium' });
        expect(model.calls[1].prompt).toContain(`File system: you may read and write only inside: ${path.join(cwd, 'out')}.`);
        expect(model.calls[1].prompt).toContain('Network: you may only access these hosts: example.com.');
        expect(model.calls[1].prompt.endsWith('Think carefully about the problem before giving the final answer.\n\nPlan 2 steps')).toBe(true);
        expect(model.calls[1].restrictions.list).toHaveLength(2);
        expect(model.calls[2]).toMatchObject({ kind: 'agent', reasoningEffort: 'medium' });
        expect(model.calls[2].restrictions.list).toEqual([]);
        expect(model.calls[2].prompt).toBe('Think carefully about the problem before giving the final answer.\n\nAct');
    });

    it('parses formats and typed schemas, repairing invalid answers', async () => {
        const model = scripted('nope', '4', '{"term":"x","extra":1}', '{"term":"closures"}', 'true', '[1]', '{"a":1}', '2.5');
        const result = await exec(`
const Card = struct('Card', { term: str.describe('The term') }).methods({ shout() { return this.term.toUpperCase(); } });
const score = await ask('Rate', { fmt: 'integer', repairs: 1, hide: true });
const card = await ask('Card', { schema: Card, repairs: 2 });
success([score, card.shout(), await ask('?', { fmt: 'boolean' }), await ask('?', { fmt: 'array' }), await think('?', { fmt: 'object' }), await ask('?', { schema: { type: 'number', minimum: 2 } })]);`,
        { backend: model });
        expect(result).toMatchObject({ status: 'success', value: [4, 'CLOSURES', true, [1], { a: 1 }, 2.5] });
        expect(model.calls.map(call => call.showReasoning)).toEqual([false, false, true, true, true, true, true, true]);
        expect(model.calls[1].prompt).toContain('Previous response:\nnope\n\nValidation failed: LLM response is not valid JSON');
        expect(model.calls[2].prompt).toContain('The result must satisfy this JSON Schema:\n{"type":"object","properties":{"term":{"type":"string","description":"The term"}},"required":["term"],"additionalProperties":false}');
        expect(model.calls[3].prompt).toContain("Validation failed: $: unexpected field 'extra' in Card\nReturn a corrected JSON value.");
    });

    it.each([
        ["ask('x', { fmt: 'integer' })", 'word', 'invalid_format', /not valid JSON/],
        ["ask('x', { fmt: 'integer' })", '1.5', 'invalid_format', /must be a JSON integer/],
        ["ask('x', { schema: struct('S', { a: int }) })", '{"a":"1"}', 'validation_failed', /\$\.a: expected int, got "1"/],
        ["ask('x', { schema: { type: 'object', properties: { total: { type: 'number' } }, required: ['total'] } })", '{}', 'validation_failed', /total: must have required property/],
    ])('fails %s on %j without repairs', async (call, reply, code, reason) => {
        expect(await exec(`await ${call};`, { backend: scripted(reply) })).toMatchObject({
            status: 'failure', failure: { status_code: code, reason: expect.stringMatching(reason), line: 1 },
        });
    });

    it.each([
        ["ask('x', { unknown: 1 })", /unknown ask\(\) option 'unknown'/],
        ["ask('x', { len: 'huge' })", /len must be/],
        ["ask('x', { fmt: 'xml' })", /fmt must be/],
        ["ask('x', { repairs: 6, fmt: 'json' })", /repairs must be an integer from 0 to 5/],
        ["ask('x', { repairs: 1 })", /schema and repairs require JSON output/],
        ["ask('x', { tokens: 0 })", /tokens must be a positive safe integer/],
        ["ask('x', { seed: -1 })", /sampling requires/],
        ["ask('x', { temperature: 3 })", /sampling requires/],
        ["ask('x', { topP: 0.5, top_p: 0.5 })", /either topP or top_p/],
        ["think('x', { seed: 1 })", /exclusive to ask\(\); think\(\) does not accept them/],
        ["agent('x', { repairs: 1, fmt: 'json' })", /agents cannot use repairs/],
        ["ask('x', { model: ' ' })", /model must be a non-empty string/],
        ["ask('x', { reasoning: 'extreme' })", /reasoning must be/],
        ["ask('x', { hide: 'yes' })", /hide must be true or false/],
        ["ask('x', 'word')", /options must be an object/],
        ["ask('x', {}, {})", /takes a prompt and one options object/],
        ["restrict('./out')", /restrict\(\) requires a function/],
        ["restrict({ disk: 'x' }, () => 1)", /unknown restriction kind 'disk'/],
        ["restrict({ fs: [] }, () => 1)", /needs at least one entry/],
        ["enforce('', () => 1)", /enforce\(\) requires guidance text/],
        ["forbid('x')", /forbid\(\) requires a function/],
        ["human(42)", /human question must be a string/],
        ["readFile(42)", /read_file\(\): path must be a string/],
    ])('rejects %s before contacting a model', async (call, reason) => {
        expect(await exec(`await ${call};`)).toMatchObject({
            status: 'failure', failure: { status_code: 'runtime_error', reason: expect.stringMatching(reason) },
        });
    });

    it('passes sampling, tokens and model options through, with override precedence', async () => {
        const model = scripted('a', 'b', 'c');
        await exec("await ask('x', { seed: 7, temperature: 0, top_p: 0.1, tokens: 64, model: 'per-call' });\nawait ask('y');", { backend: model });
        expect(model.calls[0]).toMatchObject({ model: 'per-call', tokens: 64, randomness: { seed: 7, temperature: 0, top_p: 0.1 } });
        expect(model.calls[1].model).toBeUndefined();
        expect(model.calls[1].randomness).toBeUndefined();
        await exec("await ask('z', { model: 'per-call' });", { backend: model, model: 'override' });
        expect(model.calls[2].model).toBe('override');
    });

    it('enforces restrictions on tools and restores the outer scope afterwards', async () => {
        const cwd = tempDir();
        fs.writeFileSync(path.join(cwd, 'secret.txt'), 'top secret');
        const result = await exec(`
let blocked;
await restrict('./out', async () => {
    await writeFile('./out/a.txt', 'inside');
    try { await readFile('./secret.txt'); } catch (error) { blocked = error.statusCode; }
    await restrict({ exec: 'node' }, async () => {
        try { await shell('git status'); } catch (error) { blocked += ' ' + error.statusCode; }
    });
});
success([blocked, await readFile('./secret.txt'), await readFile('./out/a.txt')]);`, { cwd });
        expect(result).toMatchObject({ status: 'success', value: ['restriction_violation restriction_violation', 'top secret', 'inside'] });
        expect(await exec("await readFile('./missing.txt');", { cwd })).toMatchObject({ failure: { status_code: 'tool_error', line: 1 } });
    });

    it('exposes args, env, human input and leveled logs', async () => {
        const { logger, events } = collecting('debug');
        process.env.SPL_TEST_VALUE = 'from-env';
        const questions: [string, number][] = [];
        const result = await exec(`
log('plain', { a: [1] }, 42, null);
log.debug('details');
log.error('bad');
const answer = await human('Proceed?');
success({ args, second: args[1], missing: args[9] ?? null, env: env.SPL_TEST_VALUE, none: env.SPL_TEST_MISSING ?? null, answer, frozen: Object.isFrozen(args) });`,
        { logger, args: ['one', 'two'], human: (question, line) => { questions.push([question, line]); return 'yes'; } });
        expect(result).toMatchObject({ status: 'success', value: {
            args: ['one', 'two'], second: 'two', missing: null, env: 'from-env', none: null, answer: 'yes', frozen: true,
        } });
        expect(questions).toEqual([['Proceed?', 5]]);
        const scripts = events.filter(event => event.origin === 'script');
        expect(scripts.map(event => event.kind)).toEqual(['info', 'debug', 'error']);
        expect(text(scripts[0])).toBe('log: plain\n{"a":[1]} 42 null');
        expect(await exec("await human('q');")).toMatchObject({ failure: { reason: 'human input requires a human handler' } });
    });
});

describe('blockquote agents', () => {
    it('shares one scope with fences through runtime tools', async () => {
        const model = acting(
            action('load_variable', { name: 'notes' }),
            action('call_function', { name: 'shout', args: ['hi'] }),
            results => action('save_variable', { name: 'summary', value: `${results[0]} / ${results[1]}` }),
            action('load_variable', { name: 'args' }),
            action('get_env', { name: 'SPL_TEST_MISSING' }),
            action('ask_human', { question: 'ok?' }),
        );
        const result = await execMarkdown(`${fence("const notes = 'raw notes';\nasync function shout(text) { return text.toUpperCase() + '!'; }")}

> Summarize @notes with @shout and save it to @summary

${fence('success({ summary, count: summary.length });')}`, { backend: model, args: ['x'], human: () => 'sure' });
        expect(result).toMatchObject({ status: 'success', value: { summary: 'raw notes / HI!', count: 15 } });
        expect(model.results).toEqual(['raw notes', 'HI!', 'raw notes / HI!', ['x'], null, 'sure']);
        const prompt = model.calls[0].prompt;
        expect(prompt).toContain('Blockquote:\nSummarize @notes with @shout and save it to @summary');
        expect(prompt).toContain('Shared bindings at command start:\n{"notes":"raw notes","shout":"async function shout(text)"}');
        expect(prompt).toContain('Available library functions: ask, think, agent, human, log, codegen, readFile, writeFile, webFetch, webSearch, shell, validate\n');
        expect(model.calls[0]).toMatchObject({ kind: 'agent', naturalLanguage: true, model: undefined, reasoningEffort: 'medium' });
    });

    it('validates saved values against named types and inline schemas', async () => {
        const body = (save: string) => `${fence("const Review = struct('Review', { score: int, note: str }).methods({ stars() { return '*'.repeat(this.score); } });\nconst Rating = { type: 'integer', minimum: 1 };")}

> Review it. @validate[Review] save to @review

${fence(save)}`;
        const good = acting(
            action('load_variable', { name: 'Review' }),
            action('save_variable', { name: 'review', value: { score: 3, note: 'fine' }, schema: 'Review' }),
            action('save_variable', { name: 'rating', value: 4, schema: 'Rating' }),
            action('save_variable', { name: 'inline', value: 'x', schema: { type: 'string' } }),
        );
        expect(await execMarkdown(body('success([review.stars(), rating, inline]);'), { backend: good })).toMatchObject({ value: ['***', 4, 'x'] });
        expect(good.results[0]).toMatchObject({ type: 'object', required: ['score', 'note'] });
        for (const [bad, code, reason] of [
            [action('save_variable', { name: 'review', value: { score: '3', note: 'x' }, schema: 'Review' }), 'validation_failed', /review\.score: expected int/],
            [action('save_variable', { name: 'rating', value: 0, schema: 'Rating' }), 'validation_failed', /must be >= 1/],
            [action('save_variable', { name: 'x', value: 1, schema: 'Missing' }), 'runtime_error', /name 'Missing' is not defined/],
            [action('save_variable', { name: 'Review', value: 1 }), 'runtime_error', /cannot replace type 'Review'/],
            [action('save_variable', { name: 'ask', value: 1 }), 'runtime_error', /'ask' is a library name/],
            [action('save_variable', { name: 'class', value: 1 }), 'runtime_error', /reserved word/],
            [action('load_variable', { name: 'nothing' }), 'runtime_error', /name 'nothing' is not defined/],
            [action('load_variable', { name: 'env' }), 'runtime_error', /get_env/],
            [action('call_function', { name: 'Rating', args: [] }), 'runtime_error', /'Rating' is not callable/],
            [action('fail', { reason: 'agent gave up' }), 'explicit_failure', /agent gave up/],
        ] as const) {
            expect(await execMarkdown(body('success(1);'), { backend: acting(bad) })).toMatchObject({
                status: 'failure', failure: { status_code: code, reason: expect.stringMatching(reason), line: 11 },
            });
        }
    });

    it('applies @CTL settings and agent-side narrowing only within the blockquote', async () => {
        const cwd = tempDir();
        const seen: unknown[] = [];
        const model = backend(async request => {
            if (!request.naturalLanguage) { seen.push(request.prompt); return { text: 'nested', effective: {} }; }
            seen.push({ model: request.model, effort: request.reasoningEffort, kinds: request.restrictions.list.map(item => item.kind) });
            await request.invokeAction!(action('set_guidance', { kind: 'forbid', text: 'slang' }));
            await request.invokeAction!(action('restrict', { kind: 'exec', value: ['git'] }));
            seen.push(request.currentRestrictions!().list.map(item => item.kind));
            await request.invokeAction!(action('call_function', { name: 'nested', args: [] }));
            await request.invokeAction!(action('write_file', { path: './src/ok.txt', content: 'ok' }));
            return { text: 'done', effective: {} };
        });
        const result = await execMarkdown(`${fence("const nested = () => ask('inner');")}

> @CTL(
>     restrict={fs: ['./src'], net: 'example.com'},
>     enforce='Be concise', model='special', reasoning='high',
> )
> Work.

${fence("success([await nested(), await readFile('./src/ok.txt')]);")}`, { backend: model, cwd }, 'model: doc-model\n');
        expect(result).toMatchObject({ status: 'success', value: ['nested', 'ok'] });
        expect(seen[0]).toEqual({ model: 'special', effort: 'high', kinds: ['fs', 'net'] });
        expect(seen[1]).toEqual(['fs', 'net', 'exec']);
        expect(String(seen[2])).toContain('- Follow: Be concise\n- Avoid: slang');
        expect(String(seen[2])).toContain('Shell: you may only run these executables: git.');
        expect(String(seen[3])).toMatch(/inner$/);
        expect(String(seen[3])).not.toContain('Be concise');
    });

    it('keeps the failure kind of workflow functions called by an agent', async () => {
        const model = acting(action('call_function', { name: 'explode', args: [] }));
        expect(await execMarkdown(`${fence('function explode() {\n    null.x;\n}')}\n\n> Call @explode`, { backend: model })).toMatchObject({
            status: 'failure', failure: { status_code: 'runtime_error', reason: expect.stringContaining('TypeError'), line: 8, command: 'null.x;' },
        });
    });

    it('lets an agent end the document', async () => {
        expect(await execMarkdown(`> Finish with @success\n\n${fence('fail("unreachable");')}`, { backend: acting(action('success', { value: { ok: true } })) }))
            .toEqual({ status: 'success', value: { ok: true }, hasValue: true });
    });
});

describe('codegen', () => {
    it('defines generated functions for later fences and returns the requested one', async () => {
        const model = scripted('```js\nfunction double(value) {\n    return helper(value);\n}\nfunction helper(value) { return value * 2; }\n```', 'function addOne(n) { return n + 1; }');
        const result = await execMarkdown(`> @CODEGEN 'Define double(value), returning value multiplied by two'

${fence("const addOne = await codegen('Define addOne(n)', { reasoning: 'low' });\nsuccess([double(21), addOne(1), typeof helper]);")}`, { backend: model });
        expect(result).toMatchObject({ status: 'success', value: [42, 2, 'function'] });
        expect(model.calls[0]).toMatchObject({ kind: 'ask', reasoningEffort: 'medium' });
        expect(model.calls[0].prompt).toContain('Function description:\nDefine double(value), returning value multiplied by two');
        expect(model.calls[1].reasoningEffort).toBe('low');
    });

    it.each([
        ['const x = 1;', /only JavaScript function declarations/],
        ['function ok() {}\nok();', /only JavaScript function declarations/],
        ['function (', /invalid JavaScript/],
        ['', /empty|only JavaScript function declarations/],
    ])('rejects generated code %j', async (reply, reason) => {
        expect(await execMarkdown("> @CODEGEN 'Define f()'", { backend: scripted(reply || ' ') })).toMatchObject({
            status: 'failure', failure: { status_code: 'invalid_format', reason: expect.stringMatching(reason) },
        });
    });
});

describe('documents', () => {
    it('runs js and ts fences, skipping ignored fences and other languages', async () => {
        const result = await execMarkdown(`Fail now. @fail

\`\`\`text
fail('text');
\`\`\`

${fence("fail('ignored');", 'js ignore')}

${fence("fail('no-run');", 'javascript no-run')}

- ${fence("fail('nested');").replace(/\n/g, '\n  ')}

${fence('let count = 1;', 'javascript')}

~~~ts
const typed: number = count + 1;
~~~

${fence('success(typed + 1);', 'mjs')}`);
        expect(result).toEqual({ status: 'success', value: 3, hasValue: true });
    });

    it('prefixes prompts with the runtime preamble and frontmatter preamble', async () => {
        const model = scripted('ok');
        await execMarkdown(fence("await ask('Hi');"), { backend: model }, 'preamble: Be brief.\nmodel: doc-model\n');
        expect(model.calls[0].model).toBe('doc-model');
        expect(model.calls[0].prompt).toMatch(/^You are running a Semantic Prompt Language Markdown workflow\.[\s\S]*\n\nBe brief\.\n\nHi$/);
    });

    it('reports document lines for failures after frontmatter and prose', async () => {
        const source = document(`# Title\n\n${fence('const a = 1;\nassert(a === 2, `a is ${a}`);')}`);
        expect(source.split('\n')[9]).toBe('assert(a === 2, `a is ${a}`);');
        const { run, parseMarkdown } = await import('../src/index.js');
        expect(await run(parseMarkdown(source), { backend: new NoLlm(), logger: silent })).toEqual({
            status: 'failure', failure: { status: 'failure', reason: 'a is 1', command: 'assert(a === 2, `a is ${a}`);', line: 10, status_code: 'assertion_failed' },
        });
    });

    it('rejects spl fences and broken documents before running anything', async () => {
        const { parseMarkdown } = await import('../src/index.js');
        expect(() => parseMarkdown(document(fence('let a = 1', 'spl')))).toThrow(/spl fences are no longer supported/);
        expect(() => parseMarkdown(document(`${fence('log(1);')}\n\n${fence('const = 2;')}`))).toThrow(expect.objectContaining({ line: 11, col: 7 }));
        expect(() => parseMarkdown(document('```js\nsuccess(1)'))).toThrow(/unterminated js fence/);
        expect(() => parseMarkdown(document(quote('@CTL(model=42) Go')))).toThrow(/@CTL: expected a literal string/);
    });
});

describe('concurrent calls under a trace', () => {
    it('journals parallel model calls in call order and replays them without a model', async () => {
        const { Trace } = await import('../src/trace.js');
        const cwd = tempDir();
        const file = path.join(cwd, 'run.jsonl');
        const source = "const answers = await Promise.all(['a', 'b', 'c'].map(topic => ask(`About ${topic}`)));\nsuccess(answers);";
        const context = { source, runtime: 'test', cwd };
        // The slowest answer is requested first: completion order must not decide the journal order.
        const delays: Record<string, number> = { a: 30, b: 10, c: 0 };
        const model = backend(async request => {
            const topic = request.prompt.at(-1)!;
            await new Promise(resolve => setTimeout(resolve, delays[topic]));
            return { text: `answer ${topic}`, effective: {} };
        });
        const record = Trace.open(file, context);
        const first = await exec(source, { backend: model, trace: record, cwd });
        record.finish(first);
        record.close();
        expect(first).toMatchObject({ status: 'success', value: ['answer a', 'answer b', 'answer c'] });
        const events = fs.readFileSync(file, 'utf8').trim().split('\n').slice(1).map(line => JSON.parse(line));
        expect(events.map(event => event.type)).toEqual(['intent', 'outcome', 'intent', 'outcome', 'intent', 'outcome', 'terminal']);
        expect(events.filter(event => event.type === 'intent').map(event => JSON.parse(event.request).request.prompt)).toEqual(['About a', 'About b', 'About c']);
        const replay = Trace.open(file, context);
        try {
            expect(await exec(source, { backend: new NoLlm(), trace: replay, cwd })).toEqual(first);
        } finally {
            replay.close();
        }
    });
});
describe('the library outside workflows', () => {
    it('uses the configured default runtime in plain Node.js code', async () => {
        const model = scripted('{"name":"Ada"}', 'acted');
        const cwd = tempDir();
        fs.writeFileSync(path.join(cwd, 'note.txt'), 'hello');
        const runtime = configure({ backend: model, logLevel: 'silent', model: 'default-model', cwd });
        const Person = struct('Person', { name: str });
        const person = await ask('Who?', { schema: Person });
        expect(person).toEqual({ name: 'Ada' });
        expect(model.calls[0].model).toBe('default-model');
        expect(model.calls[0].prompt).toMatch(/^Who\?\n\nReturn ONLY valid JSON/);
        expect(await enforce('Be brief', () => restrict('.', () => agent('Do it')))).toBe('acted');
        expect(model.calls[1].prompt).toContain('- Follow: Be brief');
        expect(await readFile('./note.txt')).toBe('hello');
        await expect(restrict('./sub', () => readFile('./note.txt'))).rejects.toMatchObject({ statusCode: 'restriction_violation' });
        expect(() => success(1)).toThrow();
        expect(runtime.cwd).toBe(cwd);
        await expect(ask('x', { fmt: 'nope' as never })).rejects.toBeInstanceOf(Failure);
    });
});
