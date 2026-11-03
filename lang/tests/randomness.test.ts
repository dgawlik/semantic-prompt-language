import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Checkpoint, type CheckpointContext } from '../src/checkpoint.js';
import { run } from '../src/interpreter.js';
import type { LlmRequest, LlmResponse } from '../src/llm.js';
import { Logger } from '../src/logger.js';
import { parseMarkdown } from '../src/markdown.js';
import { isReservedName, parse } from '../src/parser.js';
import { Pin } from '../src/pin.js';
import { RecordingBackend, ReplayBackend, TraceBackend, traceRequest } from '../src/recording.js';
import { NoLlm } from './helpers.js';

const logger = new Logger('silent');
let cwd: string;
beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'spl-randomness-'));
});
afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
});
const markdown = (source: string) =>
    `---\nextension: semantic-prompt-language\nversion: 1\n---\n\n\`\`\`spl\n${source}\n\`\`\`\n`;
const scripted = (...answers: string[]) => ({
    call: vi.fn(async (_req: LlmRequest): Promise<LlmResponse> => {
        const text = answers.shift();
        if (text === undefined) throw new Error('unexpected model call');
        return { text, effective: {} };
    }),
    async close() {},
});

describe('randomness prefix', () => {
    it.each(['ask', 'think', 'agent'] as const)('parses and executes %s with expression-valued sampling and existing modifiers', async command => {
        const backend = scripted('7');
        const source = `let seed = 21
let value = randomness(
    seed=seed * 2,
    temperature=0,
    top_p=0.01,
) ${command}(fmt='integer', model='chosen') 'Number?'
success value`;
        const program = parse(source);
        expect(program.body[1]).toMatchObject({
            t: 'let', value: { t: command, randomness: {
                seed: { t: 'binary' }, temperature: { t: 'num', v: 0 }, top_p: { t: 'num', v: 0.01 },
            }, mods: { fmt: { t: 'str' }, model: { t: 'str' } } },
        });
        expect(await run(program, { backend, logger, cwd })).toMatchObject({ status: 'success', value: 7 });
        expect(backend.call).toHaveBeenCalledOnce();
        expect(backend.call.mock.calls[0][0]).toMatchObject({
            kind: command, model: 'chosen', randomness: { seed: 42, temperature: 0, top_p: 0.01 },
        });
    });

    it.each(['ask', 'think'] as const)('evaluates sampling before modifiers and prompt, once per %s rather than per repair', async command => {
        const backend = scripted('bad JSON', '3');
        const source = `let order = []
def option(name, value):
    order.append(name)
    return value
let value = randomness(
    seed=option('seed', 42),
    top_p=option('top_p', 0.1),
    temperature=option('temperature', 0),
) ${command}(fmt=option('fmt', 'integer'), repairs=option('repairs', 1)) option('prompt', 'Number?')
success [value, order]`;
        expect(await run(parse(source), { backend, logger, cwd })).toMatchObject({
            status: 'success', value: [3, ['seed', 'top_p', 'temperature', 'fmt', 'repairs', 'prompt']],
        });
        expect(backend.call.mock.calls.map(([req]) => req.randomness)).toEqual([
            { seed: 42, temperature: 0, top_p: 0.1 }, { seed: 42, temperature: 0, top_p: 0.1 },
        ]);
        expect(backend.call.mock.calls.map(([req]) => req.reasoningEffort)).toEqual([undefined, undefined]);
        expect(backend.call.mock.calls[1][0].prompt).toContain('Previous response:\nbad JSON');
    });

    it.each(['ask', 'think', 'agent'] as const)('disables implicit reasoning for prefixed %s while preserving explicit overrides', async command => {
        const backend = scripted('default', 'empty', 'explicit', 'ordinary');
        expect(await run(parse(`success [
    randomness(temperature=0) ${command} 'Default',
    randomness() ${command} 'Empty',
    randomness(temperature=0) ${command}(reasoning='high') 'Explicit',
    ${command} 'Ordinary',
]`), { backend, logger, cwd })).toMatchObject({ status: 'success' });
        expect(backend.call.mock.calls.map(([req]) => req.reasoningEffort)).toEqual([
            undefined, undefined, 'high', command === 'ask' ? undefined : 'medium',
        ]);
        expect(backend.call.mock.calls.map(([req]) => req.prompt.includes('Think carefully'))).toEqual([
            false, false, true, command !== 'ask',
        ]);
    });

    it('keeps sampling local to its expression, with provider defaults for omitted controls', async () => {
        const backend = scripted('first', 'second', 'third', 'fourth');
        const result = await run(parse(`success [
    randomness(temperature=0) ask 'First',
    ask 'Second',
    randomness() think 'Third',
    randomness(seed=0) agent 'Fourth',
]`), { backend, logger, cwd });
        expect(result).toMatchObject({ status: 'success', value: ['first', 'second', 'third', 'fourth'] });
        expect(backend.call.mock.calls.map(([req]) => req.randomness)).toEqual([
            { temperature: 0 }, undefined, {}, { seed: 0 },
        ]);
        expect(backend.call.mock.calls[1][0]).not.toHaveProperty('randomness');
    });

    it('composes with interpolation, short-circuiting, arithmetic, function arguments and generation prompts', async () => {
        const backend = scripted('2', '3', '4', '5', '6', '7', 'inner', 'outer');
        const source = `let skipped = False and randomness(seed=42) ask 'Skipped'
def identity(value):
    return value
let a = '{randomness(temperature=0) ask "Two"}'
let b = identity(randomness(top_p=0) think 'Three')
let c = int(randomness(seed=1) agent 'Four') + 1
let d = 10 + int(randomness() ask 'Five')
let e = [randomness() think 'Six'][0]
let f = randomness() agent 'Seven' if True else randomness() ask 'Skipped'
let g = ask() (randomness(seed=1) think 'Inner')
success [skipped, a, b, c, d, e, f, g]`;
        expect(await run(parse(source), { backend, logger, cwd })).toMatchObject({
            status: 'success', value: [false, '2', '3', 5, 15, '6', '7', 'outer'],
        });
        expect(backend.call).toHaveBeenCalledTimes(8);
        expect(backend.call.mock.calls[7][0].prompt).toBe('inner');
    });

    it.each([
        'seed=-1', 'seed=2147483648', 'seed=0.5', 'seed=True', "seed='42'", 'seed=None', 'seed=1e400',
        'temperature=-0.01', 'temperature=2.01', 'temperature=True', "temperature='0'", 'temperature=None', 'temperature=1e400',
        'top_p=-0.01', 'top_p=1.01', 'top_p=False', "top_p='1'", 'top_p=None', 'top_p=1e400',
    ])('rejects invalid %s without evaluating the prompt or calling the model', async parameters => {
        const backend = scripted('unexpected');
        const source = `def prompt():
    fail 'prompt should not run'
success randomness(${parameters}) ask prompt()`;
        expect(await run(parse(source), { backend, logger, cwd })).toMatchObject({
            status: 'failure', failure: { status_code: 'runtime_error', reason: expect.stringContaining('randomness requires') },
        });
        expect(backend.call).not.toHaveBeenCalled();
    });

    it.each([
        { seed: 0, temperature: 0, top_p: 0 }, { seed: 2147483647, temperature: 2, top_p: 1 },
    ])('preserves boundary values %j without replacing zeroes with defaults', async values => {
        const backend = scripted('answer');
        const parameters = Object.entries(values).map(([name, value]) => `${name}=${value}`).join(', ');
        expect(await run(parse(`success randomness(${parameters}) ask 'Prompt'`), { backend, logger, cwd })).toMatchObject({ status: 'success' });
        expect(backend.call.mock.calls[0][0].randomness).toEqual(values);
    });

    it.each([
        ['randomness', /expected '\('/],
        ["randomness ask 'Prompt'", /expected '\('/],
        ["randomness(42) ask 'Prompt'", /modifier name/],
        ["randomness(unknown=1) ask 'Prompt'", /unknown modifier/],
        ["randomness(model='x') ask 'Prompt'", /unknown modifier/],
        ["randomness(seed=1, seed=2) ask 'Prompt'", /duplicate modifier/],
        ["randomness(temperature=0) human 'Prompt'", /must prefix/],
        ["randomness(temperature=0) randomness(seed=1) ask 'Prompt'", /must prefix/],
        ["randomness(temperature=0) 'Prompt'", /must prefix/],
        ['randomness()', /must prefix/],
        ['randomness(seed=42) ask', /requires a prompt/],
        ["ask(seed=42) 'Prompt'", /unknown modifier/],
        ["think(temperature=0) 'Prompt'", /unknown modifier/],
        ["agent(top_p=0.1) 'Prompt'", /unknown modifier/],
        ['let randomness = 1', /reserved word/],
        ['def randomness():\n    pass', /reserved word/],
    ])('rejects invalid syntax %s', (source, error) => {
        expect(() => parse(source)).toThrow(error);
        expect(isReservedName('randomness')).toBe(true);
    });
});

describe('sampling journal identity', () => {
    it.each([
        ['record', 'ask'], ['record', 'think'], ['trace', 'ask'], ['trace', 'think'], ['trace', 'agent'],
    ] as const)('retains sampling in %s for %s, compares it on replay, and preserves absent fields in old calls', async (mode, command) => {
        const file = path.join(cwd, 'recording.jsonl');
        const backend = scripted('answer');
        const recording = mode === 'record' ? new RecordingBackend(backend, file) : new TraceBackend(backend, file);
        const source = `success randomness(top_p=0.1, seed=42, temperature=0) ${command} 'Prompt'`;
        const expected = await run(parse(source), { backend: recording, logger, cwd });
        await recording.close();
        const request = backend.call.mock.calls[0][0];
        expect(traceRequest(request).reasoningEffort).toBeNull();
        expect(traceRequest(request).randomness).toEqual({ seed: 42, temperature: 0, top_p: 0.1 });
        expect(traceRequest({ ...request, randomness: undefined })).not.toHaveProperty('randomness');
        const replay = new ReplayBackend(file);
        expect(await run(parse(source), { backend: replay, logger, cwd })).toEqual(expected);
        await replay.close();
        const mismatch = new ReplayBackend(file);
        expect(await run(parse(source.replace('seed=42', 'seed=43')), { backend: mismatch, logger, cwd }))
            .toMatchObject({ status: 'failure', failure: { status_code: 'llm_error', reason: expect.stringContaining('mismatch') } });
        expect(backend.call).toHaveBeenCalledOnce();
        if (mode === 'trace') {
            const [header, entry] = fs.readFileSync(file, 'utf8').trimEnd().split('\n').map(line => JSON.parse(line));
            entry.request.randomness.seed = -1;
            fs.writeFileSync(file, [header, entry].map(item => JSON.stringify(item)).join('\n'));
            expect(() => new ReplayBackend(file)).toThrow(/invalid recording entry/);
        }
    });

    it('pins and replays sampled expressions without calling the backend', async () => {
        const source = markdown("success randomness(seed=42, temperature=0, top_p=0) think 'Prompt'");
        const backend = scripted('answer');
        const pin = Pin.capture(source, { cwd, args: [] });
        const expected = await run(parseMarkdown(source), { backend, logger, cwd, pin });
        expect(JSON.parse(pin.data.entries[1].request).request.randomness).toEqual({ seed: 42, temperature: 0, top_p: 0 });
        expect(await run(parseMarkdown(pin.toMarkdown(source)), { backend: new NoLlm(), logger })).toEqual(expected);
        expect(backend.call).toHaveBeenCalledOnce();
    });

    it('retains requested sampling across checkpoint suspension and offline reconstruction', async () => {
        const source = "let result = randomness(seed=42, temperature=0) ask 'Prompt'\nlet answer = human 'Approve?'\nsuccess [result, answer]";
        const context: CheckpointContext = { source, runtime: 'test', cwd };
        const file = path.join(cwd, 'checkpoint.jsonl');
        const backend = scripted('answer');
        const checkpoint = Checkpoint.create(file, context);
        const first = await run(parse(source), { backend, logger, cwd, checkpoint });
        expect(first.status).toBe('waiting_for_input');
        checkpoint.close();
        const resumed = Checkpoint.resume(file, context);
        resumed.answer(resumed.request!.request_id, 'yes');
        const result = await run(parse(source), { backend: new NoLlm(), logger, cwd, checkpoint: resumed });
        expect(result).toMatchObject({ status: 'success', value: ['answer', 'yes'] });
        resumed.finish('success');
        resumed.close();
        expect(fs.readFileSync(file, 'utf8')).toContain('\\"randomness\\"');
        expect(backend.call).toHaveBeenCalledOnce();
    });
});
