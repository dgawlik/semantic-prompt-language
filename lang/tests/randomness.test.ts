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

describe('ask sampling modifiers', () => {
    it('runs the shipped example with two sampled asks and no evaluation call', async () => {
        const source = fs.readFileSync(new URL('../examples/randomness.md', import.meta.url), 'utf8');
        const backend = scripted('first recipe', 'second recipe');
        expect(await run(parseMarkdown(source), { backend, logger, cwd })).toMatchObject({
            status: 'success', value: ['first recipe', 'second recipe'],
        });
        expect(backend.call).toHaveBeenCalledTimes(2);
        for (const [request] of backend.call.mock.calls) {
            expect(request).toMatchObject({
                kind: 'ask', tokens: 1024, randomness: { seed: 13, temperature: 0, top_p: 0.0001 },
            });
        }
    });

    it('parses and executes expression-valued sampling with existing modifiers', async () => {
        const backend = scripted('7');
        const source = `let seed = 21
let value = ask(
    seed=seed * 2,
    temperature=0,
    top_p=0.01,
    fmt='integer',
    model='chosen',
) 'Number?'
success value`;
        const program = parse(source);
        expect(program.body[1]).toMatchObject({
            t: 'let', value: { t: 'ask', mods: {
                seed: { t: 'binary' }, temperature: { t: 'num', v: 0 }, top_p: { t: 'num', v: 0.01 },
                fmt: { t: 'str' }, model: { t: 'str' },
            } },
        });
        expect(await run(program, { backend, logger, cwd })).toMatchObject({ status: 'success', value: 7 });
        expect(backend.call).toHaveBeenCalledOnce();
        expect(backend.call.mock.calls[0][0]).toMatchObject({
            kind: 'ask', model: 'chosen', randomness: { seed: 42, temperature: 0, top_p: 0.01 },
        });
    });

    it('evaluates modifiers once in source order before the prompt, reusing sampling for repairs', async () => {
        const backend = scripted('bad JSON', '3');
        const source = `let order = []
def option(name, value):
    order.append(name)
    return value
let value = ask(
    fmt=option('fmt', 'integer'),
    seed=option('seed', 42),
    repairs=option('repairs', 1),
    top_p=option('top_p', 0.1),
    temperature=option('temperature', 0),
) option('prompt', 'Number?')
success [value, order]`;
        expect(await run(parse(source), { backend, logger, cwd })).toMatchObject({
            status: 'success', value: [3, ['fmt', 'seed', 'repairs', 'top_p', 'temperature', 'prompt']],
        });
        expect(backend.call.mock.calls.map(([req]) => req.randomness)).toEqual([
            { seed: 42, temperature: 0, top_p: 0.1 }, { seed: 42, temperature: 0, top_p: 0.1 },
        ]);
        expect(backend.call.mock.calls.map(([req]) => req.reasoningEffort)).toEqual([undefined, undefined]);
        expect(backend.call.mock.calls[1][0].prompt).toContain('Previous response:\nbad JSON');
    });

    it('preserves explicit reasoning and the defaults of ask, think and agent', async () => {
        const backend = scripted('sampled', 'explicit', 'ordinary', 'empty', 'think', 'agent');
        expect(await run(parse(`success [
    ask(temperature=0) 'Sampled',
    ask(temperature=0, reasoning='high') 'Explicit',
    ask 'Ordinary',
    ask() 'Empty',
    think 'Think',
    agent 'Agent',
]`), { backend, logger, cwd })).toMatchObject({ status: 'success' });
        expect(backend.call.mock.calls.map(([req]) => req.reasoningEffort)).toEqual([
            undefined, 'high', undefined, undefined, 'medium', 'medium',
        ]);
        expect(backend.call.mock.calls.map(([req]) => req.prompt.includes('Think carefully'))).toEqual([
            false, true, false, false, true, true,
        ]);
        expect(backend.call.mock.calls.map(([req]) => req.randomness)).toEqual([
            { temperature: 0 }, { temperature: 0 }, undefined, undefined, undefined, undefined,
        ]);
        for (const [req] of backend.call.mock.calls.slice(2)) expect(req).not.toHaveProperty('randomness');
    });

    it('composes with interpolation, short-circuiting, arithmetic, function arguments and prompts', async () => {
        const backend = scripted('2', '3', '4', '5', '6', '7', 'inner', 'outer');
        const source = `let skipped = False and ask(seed=42) 'Skipped'
def identity(value):
    return value
let a = '{ask(temperature=0) "Two"}'
let b = identity(ask(top_p=0) 'Three')
let c = int(ask(seed=1) 'Four') + 1
let d = 10 + int(ask() 'Five')
let e = [ask(temperature=0) 'Six'][0]
let f = ask(seed=1) 'Seven' if True else ask 'Skipped'
let g = ask() (ask(seed=1) 'Inner')
success [skipped, a, b, c, d, e, f, g]`;
        expect(await run(parse(source), { backend, logger, cwd })).toMatchObject({
            status: 'success', value: [false, '2', '3', 5n, 15n, '6', '7', 'outer'],
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
success ask(${parameters}) prompt()`;
        expect(await run(parse(source), { backend, logger, cwd })).toMatchObject({
            status: 'failure', failure: { status_code: 'runtime_error', reason: expect.stringContaining('sampling requires') },
        });
        expect(backend.call).not.toHaveBeenCalled();
    });

    it.each([
        { seed: 0, temperature: 0, top_p: 0 }, { seed: 2147483647, temperature: 2, top_p: 1 },
    ])('preserves boundary values %j without replacing zeroes with defaults', async values => {
        const backend = scripted('answer');
        const parameters = Object.entries(values).map(([name, value]) => `${name}=${value}`).join(', ');
        expect(await run(parse(`success ask(${parameters}) 'Prompt'`), { backend, logger, cwd })).toMatchObject({ status: 'success' });
        expect(backend.call.mock.calls[0][0].randomness).toEqual(values);
    });

    it.each([
        "ask(42) 'Prompt'", "ask(unknown=1) 'Prompt'", "ask(seed=1, seed=2) 'Prompt'",
        "ask(temperature=0, temperature=1) 'Prompt'", "ask(top_p=0, top_p=1) 'Prompt'",
        "randomness(seed=42) ask 'Prompt'", "randomness() ask 'Prompt'",
        ...['think', 'agent'].flatMap(command => ['seed', 'temperature', 'top_p'].map(name => `${command}(${name}=0) 'Prompt'`)),
    ])('rejects invalid or removed syntax %s', source => {
        expect(() => parse(source)).toThrow();
    });

    it('no longer reserves randomness as a keyword', async () => {
        expect(isReservedName('randomness')).toBe(false);
        expect(await run(parse('let randomness = 2\nsuccess randomness ** 3'), { backend: new NoLlm(), logger, cwd }))
            .toMatchObject({ status: 'success', value: 8 });
    });
});

describe('sampling journal identity', () => {
    it.each(['record', 'trace'] as const)('retains sampling in %s and compares it on replay', async mode => {
        const file = path.join(cwd, 'recording.jsonl');
        const backend = scripted('answer');
        const recording = mode === 'record' ? new RecordingBackend(backend, file) : new TraceBackend(backend, file);
        const source = "success ask(top_p=0.1, seed=42, temperature=0) 'Prompt'";
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
        await expect(mismatch.close()).rejects.toThrow(/unused recorded response/);
        expect(backend.call).toHaveBeenCalledOnce();
        if (mode === 'trace') {
            const [header, entry] = fs.readFileSync(file, 'utf8').trimEnd().split('\n').map(line => JSON.parse(line));
            entry.request.randomness.seed = -1;
            fs.writeFileSync(file, [header, entry].map(item => JSON.stringify(item)).join('\n'));
            expect(() => new ReplayBackend(file)).toThrow(/invalid recording entry/);
        }
    });

    it('pins and replays sampled expressions without calling the backend', async () => {
        const source = markdown("success ask(seed=42, temperature=0, top_p=0) 'Prompt'");
        const backend = scripted('answer');
        const pin = Pin.capture(source, { cwd, args: [] });
        const expected = await run(parseMarkdown(source), { backend, logger, cwd, pin });
        expect(JSON.parse(pin.data.entries[1].request).request.randomness).toEqual({ seed: 42, temperature: 0, top_p: 0 });
        expect(await run(parseMarkdown(pin.toMarkdown(source)), { backend: new NoLlm(), logger })).toEqual(expected);
        expect(backend.call).toHaveBeenCalledOnce();
    });

    it('retains requested sampling across checkpoint suspension and offline reconstruction', async () => {
        const source = "let result = ask(seed=42, temperature=0) 'Prompt'\nlet answer = human 'Approve?'\nsuccess [result, answer]";
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
