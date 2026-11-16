import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Trace } from '../src/trace.js';
import { run } from '../src/workflow.js';
import { acting, action, agentBlock, backend, block, cleanTemp, collecting, exec, save, scripted, silent, tempDir, text, value } from './helpers.js';

afterEach(cleanTemp);

const failure = async (source: string, options = {}) => {
    const result = await exec(source, options);
    if (result.status !== 'failure') throw new Error(`expected a failure, got ${JSON.stringify(result.value)}`);
    return result.failure;
};

describe('ask blocks', () => {
    it('make one model call without tools and declare the answer as text', async () => {
        const model = scripted('  Because.  ');
        expect(await value(`${block('Why is the sky blue?', 'outputVar: answer')}\nsuccess(answer);`, { backend: model })).toBe('Because.');
        expect(model.calls).toHaveLength(1);
        expect(model.calls[0]).toMatchObject({ kind: 'ask', prompt: 'Why is the sky blue?', reasoningEffort: undefined, showReasoning: true });
        expect(model.calls[0].runtimeTools).toBeUndefined();
    });

    it('inline referenced values as JSON, labelled with their names', async () => {
        const model = scripted('ok');
        const source = [
            'const invoice = { total: 12, lines: ["a"] };', 'const Card = Struct("Card", { term: Str });', 'function fib(n: number) { return n; }',
            block('Sum up @invoice.total of @invoice for @args, like a @Card via @fib.\nWrite to me@@example.com, not user@example.com', 'outputVar: a'),
        ].join('\n');
        await value(source, { backend: model, args: ['x'] });
        expect(model.calls[0].prompt).toBe([
            'Sum up @invoice.total of @invoice for @args, like a @Card via @fib.',
            'Write to me@example.com, not user@example.com',
            '',
            'Values referenced above, as JSON:',
            '@invoice.total = 12',
            '@invoice = {"total":12,"lines":["a"]}',
            '@args = ["x"]',
            '@Card = {"type":"object","properties":{"term":{"type":"string"}},"required":["term"],"additionalProperties":false}',
            '@fib = "function fib(n)"',
        ].join('\n'));
    });

    it('coerce the answer to outputType and assign existing variables', async () => {
        const source = [
            'const Joke = Struct("Joke", { setup: Str, stars: Int });', 'let count = 0;',
            block('A joke', 'outputVar: joke', 'outputType: Joke'),
            block('How many?', 'outputVar: =count', 'outputType: Int'),
            block('Tags?', 'outputVar: tags', 'outputType: List(Str)'),
            'success({ joke, count, tags });',
        ].join('\n');
        const model = scripted('```json\n{"setup":"Knock","stars":"4"}\n```', '7.0', '["a",1]');
        expect(await value(source, { backend: model })).toEqual({ joke: { setup: 'Knock', stars: 4 }, count: 7, tags: ['a', '1'] });
        expect(model.calls[0].prompt).toContain('Return ONLY valid JSON');
        expect(model.calls[0].prompt).toContain('"required":["setup","stars"]');
    });

    it('fail with the path of the bad field, or repair with the model', async () => {
        const source = `const Joke = Struct("Joke", { setup: Str, stars: Int });\n${block('A joke', 'outputVar: joke', 'outputType: Joke', 'REPAIRS')}\nsuccess(joke);`;
        expect(await failure(source.replace('REPAIRS', 'hide: false'), { backend: scripted('{"setup":"Knock","stars":3.5}') }))
            .toMatchObject({ status_code: 'validation_failed', reason: '$.stars: expected Int, got 3.5', line: 2, command: 'A joke' });
        const model = scripted('not json', '{"setup":"Knock","stars":3.5}', '{"setup":"Knock","stars":3}');
        expect(await value(source.replace('REPAIRS', 'repairs: 2'), { backend: model })).toEqual({ setup: 'Knock', stars: 3 });
        expect(model.calls[2].prompt).toContain('Validation failed: $.stars: expected Int, got 3.5');
    });

    it('apply block settings, then file defaults, with the run model above both', async () => {
        const source = [
            '---', 'model: file-model', 'reasoning: low', 'tokens: 100', 'hide: true', 'enforce: Be brief', '---',
            block('One', 'outputVar: a'),
            block('Two', 'outputVar: b', 'model: block-model', 'reasoning: max', 'tokens: 5', 'hide: false', 'forbid: jargon', 'seed: 3', 'temperature: 0.2', 'topP: 0.9'),
            "const c = await ask('Three');", "const d = await ask('Four', { model: 'call-model', reasoning: 'none' });",
        ].join('\n');
        const model = scripted('1', '2', '3', '4');
        await value(source, { backend: model });
        expect(model.calls.map(call => [call.model, call.reasoningEffort, call.tokens, call.showReasoning, call.randomness])).toEqual([
            ['file-model', 'low', 100, false, undefined],
            ['block-model', 'max', 5, true, { seed: 3, temperature: 0.2, top_p: 0.9 }],
            ['file-model', 'low', 100, false, undefined],
            ['call-model', 'none', 100, false, undefined],
        ]);
        expect(model.calls[0].prompt).toBe('Response guidance (not runtime validation):\n- Follow: Be brief\n\nOne');
        expect(model.calls[1].prompt).toBe('Response guidance (not runtime validation):\n- Follow: Be brief\n- Avoid: jargon\n\nTwo');
        const override = scripted('1', '2', '3', '4');
        await value(source, { backend: override, model: 'cli-model' });
        expect(override.calls.map(call => call.model)).toEqual(['cli-model', 'cli-model', 'cli-model', 'cli-model']);
    });

    it('follow block scoping and may sit inside functions and loops', async () => {
        const source = [
            'async function describe(item: string): Promise<string> {',
            '    ---', '    outputVar: summary', '', '    Describe @item', '    ---',
            '    return summary;', '}',
            'const all: string[] = [];',
            'for (const item of ["a", "b"]) {', '    all.push(await describe(item));', '}',
            'success(all);',
        ].join('\n');
        expect(await value(source, { backend: scripted('A.', 'B.') })).toEqual(['A.', 'B.']);
    });
});

describe('agent blocks', () => {
    const header = ['const Review = Struct("Review", { score: Int, notes: List(Str) });', 'function fib(n: number): number { return n < 2 ? n : fib(n - 1) + fib(n - 2); }', 'const draft = { title: "T" };'];

    it('run as one agent call that reads inputs and saves outputs through tools', async () => {
        const agent = acting(
            action('loadVariable', { name: 'draft.title' }),
            action('loadVariable', { name: 'Review' }),
            action('callFunction', { name: 'fib', args: [10] }),
            results => save('score', results[2]),
            save('review', '{"score":"3","notes":["fine"]}'),
            save('anything', { nested: [1, null] }),
        );
        const source = [...header, agentBlock('Review @draft.title as a @Review ->[Review] @review\nand score it with @fib ->[Int] @score, plus -> @anything', 'model: agent-model', 'reasoning: high'),
            'success({ review, score, anything });'].join('\n');
        expect(await value(source, { backend: agent })).toEqual({ review: { score: 3, notes: ['fine'] }, score: 55, anything: { nested: [1, null] } });
        expect(agent.results.slice(0, 3)).toEqual(['T', { type: 'object', properties: { score: { type: 'integer' }, notes: { type: 'array', items: { type: 'string' } } }, required: ['score', 'notes'], additionalProperties: false }, 55]);
        expect(agent.calls).toHaveLength(1);
        expect(agent.calls[0]).toMatchObject({ kind: 'agent', model: 'agent-model', reasoningEffort: 'high' });
        expect(agent.calls[0].runtimeTools!.map(tool => tool.name)).toEqual([
            'loadVariable', 'saveVariable', 'callFunction', 'getEnv', 'askHuman', 'setGuidance', 'readFile', 'writeFile', 'webFetch', 'webSearch', 'shell',
        ]);
        const { prompt } = agent.calls[0];
        expect(prompt).toContain('Inputs:\n- @draft.title: string\n- @Review: type Review\n- @fib: function fib(n)');
        expect(prompt).toContain('- @review: Review, JSON Schema {"type":"object"');
        expect(prompt).toContain('- @score: Int, JSON Schema {"type":"integer"}\n- @anything: Any, JSON Schema {}');
        expect(prompt).not.toContain('"title":"T"');
    });

    it('return an invalid save to the agent, which may correct it twice', async () => {
        const source = [agentBlock('Count ->[Int] @count'), 'success(count);'].join('\n');
        const corrected = acting(save('count', 'three'), save('count', 3.5), save('count', '3'));
        expect(await value(source, { backend: corrected })).toBe(3);
        expect(corrected.results).toEqual([
            { rejected: 'count: expected Int, got "three"', hint: 'Correct the value and save @count again.' },
            { rejected: 'count: expected Int, got 3.5', hint: 'Correct the value and save @count again.' },
            3,
        ]);
        expect(await failure(source, { backend: acting(save('count', 'a'), save('count', 'b'), save('count', 'c')) })).toMatchObject({
            status_code: 'validation_failed', reason: '@count is still invalid after 2 corrections: count: expected Int, got "c"', line: 1, command: 'Count ->[Int] @count',
        });
    });

    it('fail when an output is not saved or an undeclared one is', async () => {
        const source = agentBlock('Find ->[Str] @a and -> @b');
        expect(await failure(source, { backend: acting(save('a', 'x')) })).toMatchObject({ status_code: 'validation_failed', reason: 'agent did not produce @b', line: 1 });
        expect(await failure(source, { backend: acting(save('c', 1)) })).toMatchObject({
            status_code: 'runtime_error', reason: 'agent tried to save @c, which is not an output of this block (outputs: @a, @b); declare it with -> @c',
        });
    });

    it('reach only the names the instruction mentions', async () => {
        const source = [...header, 'const secret = "s";', agentBlock('Use @fib -> @x')].join('\n');
        expect(await failure(source, { backend: acting(action('loadVariable', { name: 'secret' })) }))
            .toMatchObject({ status_code: 'runtime_error', reason: '@secret is not referenced in this block; an agent reaches only the names its instruction mentions' });
        expect(await failure(source, { backend: acting(action('callFunction', { name: 'draft', args: [] })) })).toMatchObject({ reason: expect.stringContaining('@draft is not referenced') });
        expect(await failure([...header, agentBlock('Call @draft -> @x')].join('\n'), { backend: acting(action('callFunction', { name: 'draft', args: [] })) }))
            .toMatchObject({ reason: '@draft is not a function' });
    });

    it('assign existing variables and let later code use the outputs', async () => {
        const source = ['let total = 1;', agentBlock('Add one to @total ->[Int] @=total and name it -> @label'), 'success([total, label]);'].join('\n');
        expect(await value(source, { backend: acting(action('loadVariable', { name: 'total' }), results => save('total', Number(results[0]) + 1), save('label', 'two')) })).toEqual([2, 'two']);
    });

    it('act on files within the restrictions of the block', async () => {
        const directory = tempDir();
        fs.mkdirSync(path.join(directory, 'out'));
        fs.writeFileSync(path.join(directory, 'secret.txt'), 'hidden');
        const source = agentBlock('Write a note', 'restrict: { fs: ./out }', 'enforce: Be brief');
        const agent = acting(action('writeFile', { path: './out/note.txt', content: 'hi' }), action('readFile', { path: './out/note.txt' }));
        expect(await exec(source, { backend: agent, cwd: directory })).toMatchObject({ status: 'success' });
        expect(agent.results[1]).toBe('hi');
        expect(agent.calls[0].prompt).toContain('- Follow: Be brief');
        expect(agent.calls[0].prompt).toContain('File system: you may read and write only inside');
        expect(await failure(source, { backend: acting(action('readFile', { path: './secret.txt' })), cwd: directory }))
            .toMatchObject({ status_code: 'restriction_violation', line: 1, command: 'Write a note' });
    });

    it('keep the line of a failure inside a function the agent called', async () => {
        const source = ['function strict(n: number) {', "    assert(n > 0, 'must be positive');", '    return n;', '}', agentBlock('Call @strict -> @x')].join('\n');
        expect(await failure(source, { backend: acting(action('callFunction', { name: 'strict', args: [0] })) }))
            .toMatchObject({ status_code: 'assertion_failed', reason: 'must be positive', line: 2, command: "assert(n > 0, 'must be positive');" });
    });

    it('ask humans, read the environment and add guidance for nested model calls', async () => {
        const source = ['async function nested() {', "    return ask('Nested');", '}', agentBlock('Ask the human, then call @nested -> @x')].join('\n');
        const model = backend(async request => {
            if (!request.runtimeTools) return { text: request.prompt, effective: {} };
            const answer = await request.invokeAction!(action('askHuman', { question: 'Sure?' }));
            const missing = await request.invokeAction!(action('getEnv', { name: 'SPL_TEST_SURELY_MISSING' }));
            await request.invokeAction!(action('setGuidance', { kind: 'forbid', text: 'slang' }));
            const nested = await request.invokeAction!(action('callFunction', { name: 'nested', args: [] }));
            await request.invokeAction!(save('x', { answer, missing, nested }));
            return { text: 'Done', effective: {} };
        });
        expect(await value(`${source}\nsuccess(x);`, { backend: model, human: question => `yes to ${question}` }))
            .toEqual({ answer: 'yes to Sure?', missing: null, nested: 'Response guidance (not runtime validation):\n- Avoid: slang\n\nNested' });
    });

    it('log each action and replay a finished trace without a model', async () => {
        const directory = tempDir();
        const source = ['function twice(n: number) { return n * 2; }', agentBlock('Double 4 with @twice ->[Int] @x'), block('Describe @x', 'outputVar: note'), 'success({ x, note });'].join('\n');
        const open = (): Trace => Trace.open(path.join(directory, 'run.jsonl'), { source, runtime: 'test', cwd: directory });
        const { logger, events } = collecting();
        let trace = open();
        const first = await run(source, { backend: backend(async request => {
            if (!request.runtimeTools) return { text: 'Eight.', effective: {} };
            await request.invokeAction!(save('x', await request.invokeAction!(action('callFunction', { name: 'twice', args: [4] }))));
            return { text: 'Done', effective: {} };
        }), logger, trace, cwd: directory });
        trace.finish(first);
        trace.close();
        expect(first).toEqual({ status: 'success', value: { x: 8, note: 'Eight.' }, hasValue: true });
        expect(events.filter(event => event.kind === 'model-output' && event.interaction.role === 'action').map(event => JSON.parse(text(event)).name)).toEqual(['callFunction', 'saveVariable']);
        trace = open();
        const replayed = await run(source, { backend: backend(() => { throw new Error('replay must not call a model'); }), logger: silent, trace, cwd: directory });
        trace.finish(replayed);
        trace.close();
        expect(replayed).toEqual(first);
    });
});

describe('codegen blocks', () => {
    const source = [
        block('Generate a slug of a title -> @slugify(text: string): string\nusing a helper -> @words(text: string): string[]\nSeparate with @separator', 'mode: codegen', 'model: code-model'),
        'const separator = "-";',
    ].join('\n');
    const code = 'function words(text) {\n    return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];\n}\nfunction slugify(text) {\n    return words(text).join(separator);\n}';

    it('generate the declared functions together in one model call', async () => {
        const model = scripted(`\`\`\`js\n${code}\n\`\`\``);
        const program = `const separator = "-";\n${source.split('\n').slice(0, -1).join('\n')}\nsuccess([slugify(" Hello, World! "), words("A b")]);`;
        expect(await value(program, { backend: model })).toEqual(['hello-world', ['a', 'b']]);
        expect(model.calls).toHaveLength(1);
        expect(model.calls[0]).toMatchObject({ kind: 'ask', model: 'code-model' });
        expect(model.calls[0].prompt).toContain('Inputs in scope:\n{"separator":"-"}');
        expect(model.calls[0].prompt).toContain('Function description:\nGenerate a slug of a title -> @slugify(text: string): string');
    });

    it('cache the code beside the workflow and reuse it without a model', async () => {
        const directory = tempDir();
        const file = path.join(directory, 'slug.spl');
        const program = `const separator = "_";\n${source.split('\n').slice(0, -1).join('\n')}\nsuccess(slugify("Hello World"));`;
        fs.writeFileSync(file, program);
        expect(await value(program, { backend: scripted(code), file, cwd: directory })).toBe('hello_world');
        const cached = fs.readFileSync(path.join(directory, 'slug.slugify.js'), 'utf8');
        expect(cached).toMatch(/^\/\/ @CODEGEN sha256:[0-9a-f]{64}\nfunction words/);
        expect(await value(program, { file, cwd: directory })).toBe('hello_world');
        // Another description is another function: the cache is keyed by the text of the block.
        const changed = program.replace('Generate a slug', 'Generate a short slug');
        expect(await value(changed, { backend: scripted(code.replace('join(separator)', 'join(separator).slice(0, 5)')), file, cwd: directory })).toBe('hello');
        expect(fs.readdirSync(directory).filter(name => name.endsWith('.js')).sort()).toHaveLength(2);
    });

    it('reject answers that are not just the declared functions', async () => {
        const program = `${block('-> @slugify(text: string): string', 'mode: codegen')}`;
        expect(await failure(program, { backend: scripted('function other() {}') })).toMatchObject({ status_code: 'invalid_format', reason: "codegen did not declare the function 'slugify'", line: 1 });
        expect(await failure(program, { backend: scripted('function slugify() {}\nslugify();') })).toMatchObject({ status_code: 'invalid_format', reason: expect.stringContaining('only JavaScript function declarations') });
        expect(await failure(program, { backend: scripted('function slugify( {') })).toMatchObject({ status_code: 'invalid_format', reason: expect.stringContaining('codegen returned invalid JavaScript') });
    });

    it('locate failures inside generated code', async () => {
        const program = `${block('-> @explode()', 'mode: codegen')}\nexplode();`;
        expect(await failure(program, { backend: scripted("function explode() {\n    throw new Error('boom');\n}") }))
            .toMatchObject({ status_code: 'runtime_error', reason: 'Error: boom', line: 3, command: "throw new Error('boom');" });
    });

    it('is also a function: codegen(description)', async () => {
        const model = scripted('function sieve(n) {\n    return [2, 3, 5, 7].filter(prime => prime <= n);\n}');
        expect(await value("const sieve = await codegen('sieve(n): primes up to n', { model: 'm', reasoning: 'low' });\nsuccess(sieve(6));", { backend: model })).toEqual([2, 3, 5]);
        expect(model.calls[0]).toMatchObject({ model: 'm', reasoningEffort: 'low' });
    });
});
