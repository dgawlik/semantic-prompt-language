import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SplSyntaxError, type SyntaxProblem } from '../src/errors.js';
import type { LlmBackend } from '../src/llm.js';
import { Trace } from '../src/trace.js';
import { run, type RunResult } from '../src/workflow.js';
import { NoLlm, block, cleanTemp, exec, scripted, silent, tempDir } from './helpers.js';

afterEach(cleanTemp);

const SAMPLING_ERROR = 'sampling requires seed=integer in 0..2147483647, temperature=number in 0..2, and top_p=number in 0..1; parameters are optional';

describe('ask sampling options', () => {
    it('sends the same sampling controls with every sampled ask of a workflow', async () => {
        const model = scripted('first recipe', 'second recipe', 'third recipe');
        const result = await exec(`//*
# Randomness Controls

Sampling is best-effort and does not guarantee identical responses.
*//

---
model: gpt-6-luna
---

const sampling = { seed: 13, temperature: 0.0, topP: 0.0001, tokens: 1024 };
const recipe1 = await ask('<most-frequent>give a recipe for an apple pie</most-frequent>', sampling);
const recipe2 = await ask('<most-frequent>give a recipe for an apple pie</most-frequent>', sampling);

${block('<most-frequent>give a recipe for an apple pie</most-frequent>', 'outputVar: recipe3', 'seed: 13', 'temperature: 0.0', 'topP: 0.0001', 'tokens: 1024')}

success([recipe1, recipe2, recipe3]);`, { backend: model });
        expect(result).toMatchObject({ status: 'success', value: ['first recipe', 'second recipe', 'third recipe'] });
        expect(model.calls).toHaveLength(3);
        for (const call of model.calls) {
            expect(call).toMatchObject({
                kind: 'ask', model: 'gpt-6-luna', tokens: 1024, randomness: { seed: 13, temperature: 0, top_p: 0.0001 },
                prompt: '<most-frequent>give a recipe for an apple pie</most-frequent>',
            });
        }
    });

    it('combines computed sampling values with other options', async () => {
        const model = scripted('7');
        const result = await exec(`
const seed = 21;
const value = await ask('Number?', {
    seed: seed * 2,
    temperature: 0,
    topP: 0.01,
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

    it('passes on only the reasoning a call asked for, leaving the default of ask and agent to the backend', async () => {
        const prompts = ['Sampled', 'Explicit', 'Ordinary', 'Empty', 'Reasoned', 'Agent', 'Sampled block', 'Explicit block'];
        const model = scripted(...prompts.map(prompt => prompt.toLowerCase()));
        expect(await exec(`const answers = [
    await ask('Sampled', { temperature: 0 }),
    await ask('Explicit', { temperature: 0, reasoning: 'high' }),
    await ask('Ordinary'),
    await ask('Empty', {}),
    await ask('Reasoned', { reasoning: 'max' }),
    await agent('Agent'),
];
${block('Sampled block', 'outputVar: sampled', 'temperature: 0')}
${block('Explicit block', 'outputVar: explicit', 'temperature: 0', 'reasoning: none')}
success([...answers, sampled, explicit]);`, { backend: model })).toMatchObject({ status: 'success', value: prompts.map(prompt => prompt.toLowerCase()) });
        expect(model.calls.map(call => call.reasoningEffort)).toEqual([undefined, 'high', undefined, undefined, 'max', undefined, undefined, 'none']);
        // Neither reasoning nor sampling adds anything to the prompt.
        expect(model.calls.map(call => call.prompt)).toEqual(prompts);
        expect(model.calls.map(call => call.randomness)).toEqual([
            { temperature: 0 }, { temperature: 0 }, undefined, undefined, undefined, undefined, { temperature: 0 }, { temperature: 0 },
        ]);
        for (const call of model.calls.slice(2, 6)) expect(call).not.toHaveProperty('randomness');
    });

    it('composes with interpolation, short-circuiting, arithmetic, function arguments and prompts', async () => {
        const model = scripted('2', '3', '4', '5', '6', '7', 'inner', 'outer');
        const result = await exec(`
const skipped = false && await ask('Skipped', { seed: 42 });
const identity = <T>(value: T): T => value;
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
    ])('rejects invalid { %s } without calling the model', async options => {
        const model = scripted('unexpected');
        expect(await exec(`success(await ask('Prompt', { ${options} }));`, { backend: model })).toMatchObject({
            status: 'failure', failure: { status_code: 'runtime_error', reason: SAMPLING_ERROR, line: 1 },
        });
        expect(model.calls).toHaveLength(0);
    });

    it.each([
        ['seed: -1', '`seed` must be an integer from 0 to 2147483647'], ['seed: 0.5', '`seed` must be an integer from 0 to 2147483647'],
        ["seed: '42'", '`seed` must be an integer from 0 to 2147483647'], ['temperature: 2.01', '`temperature` must be a number from 0 to 2'],
        ['temperature: true', '`temperature` must be a number from 0 to 2'], ['topP: 1.01', '`topP` must be a number from 0 to 1'],
        ['topP: -0.01', '`topP` must be a number from 0 to 1'],
    ])('rejects the invalid ask block header %s before anything runs', async (header, message) => {
        const model = scripted('unexpected');
        const error = await exec(`log('unreachable');\n${block('Prompt', 'outputVar: answer', header)}`, { backend: model }).catch(error => error);
        expect(error).toBeInstanceOf(SplSyntaxError);
        expect(error.message).toContain(message);
        expect(model.calls).toHaveLength(0);
    });

    it.each([
        { seed: 0, temperature: 0, top_p: 0 }, { seed: 2147483647, temperature: 2, top_p: 1 },
    ])('preserves boundary values %j without replacing zeroes with defaults', async values => {
        const model = scripted('answer', 'answer');
        const { top_p: topP, ...rest } = values;
        const source = `await ask('Prompt', ${JSON.stringify({ ...rest, topP })});
${block('Prompt', 'outputVar: answer', `seed: ${values.seed}`, `temperature: ${values.temperature}`, `topP: ${topP}`)}`;
        expect(await exec(source, { backend: model })).toMatchObject({ status: 'success' });
        expect(model.calls.map(call => call.randomness)).toEqual([values, values]);
    });

    it.each(['seed', 'temperature', 'topP'])('rejects agent() with %s: sampling is exclusive to ask', async name => {
        const model = scripted('unexpected');
        expect(await exec(`await agent('Prompt', { ${name}: 0 });`, { backend: model })).toMatchObject({
            status: 'failure', failure: {
                status_code: 'runtime_error', reason: 'seed, temperature and topP are exclusive to ask(); agent() does not accept them',
            },
        });
        expect(model.calls).toHaveLength(0);
    });

    it.each(['agent', 'codegen'])('rejects %s blocks with sampling header keys', async mode => {
        const error = await exec(block('Act -> @result', `mode: ${mode}`, 'seed: 1', 'temperature: 0', 'topP: 1')).catch(error => error);
        expect(error).toBeInstanceOf(SplSyntaxError);
        expect(error.problems.map((problem: SyntaxProblem) => problem.message)).toEqual([
            '`seed` applies only to ask blocks', '`temperature` applies only to ask blocks', '`topP` applies only to ask blocks',
        ]);
    });

    it.each([
        ['{ randomness: { seed: 42 } }', "unknown ask() option 'randomness'"],
        ['{ Seed: 1 }', "unknown ask() option 'Seed'"],
        ['{ topp: 1 }', "unknown ask() option 'topp'"],
        ['{ top_p: 1 }', "unknown ask() option 'top_p'"],
        ['{ topP: 0, top_p: 1 }', "unknown ask() option 'top_p'"],
        ['42', 'ask() options must be an object such as { schema: Invoice, repairs: 1 }'],
    ])('rejects the removed or misspelled form ask(prompt, %s)', async (options, reason) => {
        const model = scripted('unexpected');
        expect(await exec(`await ask('Prompt', ${options});`, { backend: model })).toMatchObject({
            status: 'failure', failure: { status_code: 'runtime_error', reason },
        });
        expect(model.calls).toHaveLength(0);
    });

    it('leaves randomness as an ordinary identifier', async () => {
        expect(await exec('success(typeof randomness);')).toMatchObject({ status: 'success', value: 'undefined' });
        expect(await exec('const randomness = 2;\nsuccess(randomness ** 3);')).toMatchObject({ status: 'success', value: 8 });
    });
});

describe('sampling journal identity', () => {
    const traced = async (source: string, cwd: string, backend: LlmBackend): Promise<RunResult> => {
        const trace = Trace.open(path.join(cwd, 'run.jsonl'), { source, runtime: 'test', cwd });
        try {
            const result = await run(source, { backend, logger: silent, cwd, trace });
            trace.finish(result);
            return result;
        } finally {
            trace.close();
        }
    };

    it('records sampled asks in a trace and replays them without calling the backend', async () => {
        const cwd = tempDir();
        const source = `success([
    await ask('Prompt', { seed: 42, temperature: 0, topP: 0, tokens: 64 }),
    await ask('Reasoned', { reasoning: 'max' }),
]);`;
        const model = scripted('answer', 'thought');
        const expected = await traced(source, cwd, model);
        expect(expected).toEqual({ status: 'success', value: ['answer', 'thought'], hasValue: true });
        const requests = fs.readFileSync(path.join(cwd, 'run.jsonl'), 'utf8').trimEnd().split('\n').map(line => JSON.parse(line))
            .filter(row => row.type === 'intent').map(row => JSON.parse(row.request).request);
        expect(requests).toMatchObject([
            { kind: 'ask', reasoningEffort: null, randomness: { seed: 42, temperature: 0, top_p: 0 }, tokens: 64 },
            { kind: 'ask', reasoningEffort: 'max' },
        ]);
        expect(requests[1]).not.toHaveProperty('randomness');
        expect(await traced(source, cwd, new NoLlm())).toEqual(expected);
        expect(model.calls).toHaveLength(2);
    });

    it.each(['seed', 'temperature', 'topP'])('refuses to replay a recorded ask with a different %s', async name => {
        const cwd = tempDir();
        const setting = path.join(cwd, 'setting.txt');
        // The file is read outside the journal, so a replay sees whatever it holds now.
        const source = `import * as fs from 'node:fs';
const value = Number(fs.readFileSync(${JSON.stringify(setting)}, 'utf8'));
success(await ask('Prompt', { seed: 1, temperature: 1, topP: 1, ${name}: value }));`;
        fs.writeFileSync(setting, '0');
        const expected = await traced(source, cwd, scripted('answer'));
        expect(expected).toMatchObject({ status: 'success', value: 'answer' });
        expect(await traced(source, cwd, new NoLlm())).toEqual(expected);
        fs.writeFileSync(setting, '1');
        await expect(traced(source, cwd, new NoLlm())).rejects.toThrow('trace effect history mismatch');
    });
});
