import { afterEach, describe, expect, it } from 'vitest';
import { parseMarkdown } from '../src/markdown.js';
import { Pin } from '../src/pin.js';
import { run } from '../src/workflow.js';
import { NoLlm, cleanTemp, document, exec, execMarkdown, fence, scripted, silent, tempDir } from './helpers.js';

afterEach(cleanTemp);

const SAMPLING_ERROR = 'sampling requires seed=integer in 0..2147483647, temperature=number in 0..2, and top_p=number in 0..1; parameters are optional';

describe('ask sampling options', () => {
    it('sends the same sampling controls with every sampled ask of a document', async () => {
        const model = scripted('first recipe', 'second recipe');
        const result = await execMarkdown(`# Randomness Controls

Sampling is best-effort and does not guarantee identical responses.

${fence(`const sampling = { seed: 13, temperature: 0.0, topP: 0.0001, tokens: 1024 };
const recipe1 = await ask('<most-frequent>give a recipe for an apple pie</most-frequent>', sampling);
const recipe2 = await ask('<most-frequent>give a recipe for an apple pie</most-frequent>', sampling);
success([recipe1, recipe2]);`)}`, { backend: model }, "model: 'gpt-6-luna'\n");
        expect(result).toMatchObject({ status: 'success', value: ['first recipe', 'second recipe'] });
        expect(model.calls).toHaveLength(2);
        for (const call of model.calls) {
            expect(call).toMatchObject({ kind: 'ask', model: 'gpt-6-luna', tokens: 1024, randomness: { seed: 13, temperature: 0, top_p: 0.0001 } });
        }
    });

    it('combines computed sampling values with other options', async () => {
        const model = scripted('7');
        const result = await exec(`
const seed = 21;
const value = await ask('Number?', {
    seed: seed * 2,
    temperature: 0,
    top_p: 0.01,
    fmt: 'integer',
    model: 'chosen',
});
success(value);`, { backend: model });
        expect(result).toMatchObject({ status: 'success', value: 7 });
        expect(model.calls).toHaveLength(1);
        expect(model.calls[0]).toMatchObject({ kind: 'ask', model: 'chosen', randomness: { seed: 42, temperature: 0, top_p: 0.01 } });
    });

    it('reuses sampling for repairs, giving each attempt its own copy', async () => {
        const model = scripted(request => { request.randomness!.seed = 1; return 'bad JSON'; }, '3');
        expect(await exec("success(await ask('Number?', { fmt: 'integer', seed: 42, repairs: 1, topP: 0.1, temperature: 0 }));", { backend: model }))
            .toMatchObject({ status: 'success', value: 3 });
        expect(model.calls.map(call => call.randomness)).toEqual([{ seed: 1, temperature: 0, top_p: 0.1 }, { seed: 42, temperature: 0, top_p: 0.1 }]);
        expect(model.calls.map(call => call.reasoningEffort)).toEqual([undefined, undefined]);
        expect(model.calls[1].prompt).toContain('Previous response:\nbad JSON');
    });

    it('preserves explicit reasoning and the defaults of ask, think and agent', async () => {
        const model = scripted('sampled', 'explicit', 'ordinary', 'empty', 'think', 'agent');
        expect(await exec(`success([
    await ask('Sampled', { temperature: 0 }),
    await ask('Explicit', { temperature: 0, reasoning: 'high' }),
    await ask('Ordinary'),
    await ask('Empty', {}),
    await think('Think'),
    await agent('Agent'),
]);`, { backend: model })).toMatchObject({ status: 'success' });
        expect(model.calls.map(call => call.reasoningEffort)).toEqual([undefined, 'high', undefined, undefined, 'medium', 'medium']);
        expect(model.calls.map(call => call.prompt.includes('Think carefully'))).toEqual([false, true, false, false, true, true]);
        expect(model.calls.map(call => call.randomness)).toEqual([{ temperature: 0 }, { temperature: 0 }, undefined, undefined, undefined, undefined]);
        for (const call of model.calls.slice(2)) expect(call).not.toHaveProperty('randomness');
    });

    it('composes with interpolation, short-circuiting, arithmetic, function arguments and prompts', async () => {
        const model = scripted('2', '3', '4', '5', '6', '7', 'inner', 'outer');
        const result = await exec(`
const skipped = false && await ask('Skipped', { seed: 42 });
const identity = value => value;
const a = \`\${await ask('Two', { temperature: 0 })}\`;
const b = identity(await ask('Three', { topP: 0 }));
const c = Number(await ask('Four', { seed: 1 })) + 1;
const d = 10 + await ask('Five', { fmt: 'integer' });
const e = [await ask('Six', { temperature: 0 })][0];
const f = true ? await ask('Seven', { seed: 1 }) : await ask('Skipped');
const g = await ask(await ask('Inner', { seed: 1 }), {});
success([skipped, a, b, c, d, e, f, g]);`, { backend: model });
        expect(result).toMatchObject({ status: 'success', value: [false, '2', '3', 5, 15, '6', '7', 'outer'] });
        expect(model.calls).toHaveLength(8);
        expect(model.calls[7].prompt).toBe('inner');
        expect(model.calls.map(call => call.randomness)).toEqual([
            { temperature: 0 }, { top_p: 0 }, { seed: 1 }, undefined, { temperature: 0 }, { seed: 1 }, { seed: 1 }, undefined,
        ]);
    });

    it.each([
        'seed: -1', 'seed: 2147483648', 'seed: 0.5', 'seed: true', "seed: '42'", 'seed: null', 'seed: 1e400', 'seed: NaN', 'seed: 42n',
        'temperature: -0.01', 'temperature: 2.01', 'temperature: true', "temperature: '0'", 'temperature: null', 'temperature: 1e400', 'temperature: NaN',
        'topP: -0.01', 'topP: 1.01', 'topP: false', "topP: '1'", 'topP: null', 'topP: 1e400', 'topP: NaN',
        'top_p: 1.01', "top_p: '1'", 'top_p: null',
    ])('rejects invalid { %s } without calling the model', async options => {
        const model = scripted('unexpected');
        expect(await exec(`success(await ask('Prompt', { ${options} }));`, { backend: model })).toMatchObject({
            status: 'failure', failure: { status_code: 'runtime_error', reason: SAMPLING_ERROR, line: 1 },
        });
        expect(model.calls).toHaveLength(0);
    });

    it.each([
        { seed: 0, temperature: 0, top_p: 0 }, { seed: 2147483647, temperature: 2, top_p: 1 },
    ])('preserves boundary values %j without replacing zeroes with defaults', async values => {
        const model = scripted('answer', 'answer');
        const { top_p: topP, ...rest } = values;
        expect(await exec(`await ask('Prompt', ${JSON.stringify(values)});\nawait ask('Prompt', ${JSON.stringify({ ...rest, topP })});`, { backend: model }))
            .toMatchObject({ status: 'success' });
        expect(model.calls.map(call => call.randomness)).toEqual([values, values]);
    });

    it.each(['think', 'agent'].flatMap(kind => ['seed', 'temperature', 'topP', 'top_p'].map(name => [kind, name])))(
        'rejects %s with %s: sampling is exclusive to ask', async (kind, name) => {
            const model = scripted('unexpected');
            expect(await exec(`await ${kind}('Prompt', { ${name}: 0 });`, { backend: model })).toMatchObject({
                status: 'failure', failure: {
                    status_code: 'runtime_error', reason: `seed, temperature and topP are exclusive to ask(); ${kind}() does not accept them`,
                },
            });
            expect(model.calls).toHaveLength(0);
        });

    it.each([
        ['{ randomness: { seed: 42 } }', "unknown ask() option 'randomness'"],
        ['{ Seed: 1 }', "unknown ask() option 'Seed'"],
        ['{ topp: 1 }', "unknown ask() option 'topp'"],
        ['{ topP: 0, top_p: 1 }', 'use either topP or top_p, not both'],
        ['42', 'ask() options must be an object such as { schema: Invoice, repairs: 1 }'],
    ])('rejects the removed or misspelled form ask(prompt, %s)', async (options, reason) => {
        const model = scripted('unexpected');
        expect(await exec(`await ask('Prompt', ${options});`, { backend: model })).toMatchObject({
            status: 'failure', failure: { status_code: 'runtime_error', reason },
        });
        expect(model.calls).toHaveLength(0);
    });

    it('leaves randomness as an ordinary identifier', async () => {
        expect(await exec('const before = typeof randomness;\nconst randomness = 2;\nsuccess([before, randomness ** 3]);'))
            .toMatchObject({ status: 'success', value: ['undefined', 8] });
    });
});

describe('sampling journal identity', () => {
    it('pins and replays sampled asks without calling the backend', async () => {
        const cwd = tempDir();
        const source = document(fence("success(await ask('Prompt', { seed: 42, temperature: 0, topP: 0, tokens: 64 }));"));
        const model = scripted('answer');
        const pin = Pin.capture(source, { cwd, args: [] });
        const expected = await run(parseMarkdown(source), { backend: model, logger: silent, cwd, pin });
        expect(expected).toEqual({ status: 'success', value: 'answer', hasValue: true });
        expect(JSON.parse(pin.data.entries[1].request).request).toMatchObject({ kind: 'ask', randomness: { seed: 42, temperature: 0, top_p: 0 }, tokens: 64 });
        expect(await run(parseMarkdown(pin.toMarkdown(source)), { backend: new NoLlm(), logger: silent })).toEqual(expected);
        expect(model.calls).toHaveLength(1);
    });

    it('refuses to replay a pinned ask with different sampling', async () => {
        const cwd = tempDir();
        const workflow = parseMarkdown(document(fence("success(await ask('Prompt', { seed: Number(args[0]) }));")));
        const pin = Pin.capture(workflow.lines.join('\n'), { cwd, args: ['42'] });
        await run(workflow, { backend: scripted('answer'), logger: silent, cwd, args: ['42'], pin });
        expect(await run(workflow, { backend: new NoLlm(), logger: silent, pin: Pin.replay(pin.data) })).toMatchObject({ status: 'success', value: 'answer' });
        const changed = Pin.replay({ ...pin.data, context: { ...pin.data.context, args: ['43'] } });
        expect(await run(workflow, { backend: new NoLlm(), logger: silent, pin: changed })).toMatchObject({
            status: 'failure', failure: { status_code: 'runtime_error', reason: 'locked workflow request mismatch at entry 2' },
        });
    });
});
