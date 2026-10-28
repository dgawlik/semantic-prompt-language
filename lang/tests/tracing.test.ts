import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Failure } from '../src/errors.js';
import { run } from '../src/interpreter.js';
import { LlmError, type LlmBackend, type LlmRequest, type LlmResponse } from '../src/llm.js';
import { Logger } from '../src/logger.js';
import { parse } from '../src/parser.js';
import { ReplayBackend, TraceBackend } from '../src/recording.js';
import { MemoryStore } from '../src/store.js';

let dir: string;
let file: string;
beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spl-trace-'));
    file = path.join(dir, 'trace.jsonl');
});
afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
});

const exec = (source: string, backend: LlmBackend, store?: MemoryStore) =>
    run(parse(source), { backend, cwd: dir, logger: new Logger('silent'), store });

function scripted(...outcomes: (string | Error)[]) {
    const call = vi.fn(async (_req: LlmRequest): Promise<LlmResponse> => {
        const outcome = outcomes.shift();
        if (outcome instanceof Error) throw outcome;
        if (outcome === undefined) throw new Error('unexpected LLM call');
        return { text: outcome, reasoning: 'recorded reasoning', effective: { model: 'test', reasoningEffort: 'high' } };
    });
    return { call, close: vi.fn(async () => {}) };
}

function entries() {
    return fs.readFileSync(file, 'utf8').trimEnd().split('\n').map((line) => JSON.parse(line));
}

describe('workflow trace/replay', () => {
    it('captures common structured inputs and complete responses for every LLM operation', async () => {
        const backend = scripted('answer', 'thought', 'agent result');
        const trace = new TraceBackend(backend, file);
        const source = `success [ask(model='chosen', reasoning='high', show=True) 'Ask', think 'Think', agent 'Act']`;
        const expected = await exec(source, trace);
        await trace.close();
        expect(expected).toMatchObject({ status: 'success', value: ['answer', 'thought', 'agent result'] });
        const [header, ...calls] = entries();
        expect(header).toEqual({ format: 'spl-trace', version: 1 });
        expect(calls.map((entry) => entry.request.kind)).toEqual(['ask', 'think', 'agent']);
        expect(calls[0]).toEqual({
            request: {
                kind: 'ask', prompt: backend.call.mock.calls[0][0].prompt,
                model: 'chosen', reasoningEffort: 'high', showReasoning: true,
            },
            response: {
                text: 'answer', reasoning: 'recorded reasoning',
                effective: { model: 'test', reasoningEffort: 'high' },
            },
        });
        expect(backend.close).toHaveBeenCalledOnce();
        const replay = new ReplayBackend(file);
        expect(replay.mode).toBe('workflow-replay');
        expect(await exec(source, replay)).toEqual(expected);
        await replay.close();
        expect(backend.call).toHaveBeenCalledTimes(3);
        expect(() => new TraceBackend(backend, file)).toThrow();
    });

    it('replays agent results without repeating agent-owned tools or other backend work', async () => {
        const backend = {
            call: vi.fn(async (req: LlmRequest) => {
                await req.tools.invoke('write_file', { path: 'agent.txt', content: 'live action' });
                return { text: 'done', effective: { model: 'test' } };
            }),
            async close() {},
        };
        const trace = new TraceBackend(backend, file);
        const source = `success agent 'Write the file'`;
        expect(await exec(source, trace)).toMatchObject({ status: 'success', value: 'done' });
        await trace.close();
        fs.unlinkSync(path.join(dir, 'agent.txt'));
        const replay = new ReplayBackend(file);
        expect(await exec(source, replay)).toMatchObject({ status: 'success', value: 'done' });
        await replay.close();
        expect(fs.existsSync(path.join(dir, 'agent.txt'))).toBe(false);
        expect(backend.call).toHaveBeenCalledOnce();
    });

    it('records every repair attempt and revalidates raw responses on replay', async () => {
        const backend = scripted('not JSON', '3');
        const source = `success ask(fmt='integer', repairs=1) 'Count'`;
        const trace = new TraceBackend(backend, file);
        expect(await exec(source, trace)).toMatchObject({ status: 'success', value: 3 });
        await trace.close();
        expect(entries()).toHaveLength(3);
        expect(entries()[2].request.prompt).toContain('Previous response:\nnot JSON');
        const replay = new ReplayBackend(file);
        expect(await exec(source, replay)).toMatchObject({ status: 'success', value: 3 });
        await replay.close();
    });

    it.each(['ask', 'think', 'agent'])('records and replays failures from %s', async (command) => {
        const backend = scripted(new LlmError('transport failed'));
        const trace = new TraceBackend(backend, file);
        const source = `success ${command} 'Fail'`;
        const expected = await exec(source, trace);
        await trace.close();
        expect(expected).toMatchObject({ status: 'failure', failure: { status_code: 'llm_error', reason: 'transport failed' } });
        expect(entries()[1].error).toEqual({ status_code: 'llm_error', reason: 'transport failed' });
        const replay = new ReplayBackend(file);
        expect(await exec(source, replay)).toEqual(expected);
        await replay.close();
    });

    it('retains runtime failure categories and caught-error control flow', async () => {
        const backend = scripted(new Failure('restriction_violation', 'denied agent action'), 'recovered');
        const source = `
try:
    agent 'Act'
except err:
    assert err.status_code == 'restriction_violation'
    assert err.reason == 'denied agent action'
success ask 'Recover'
`;
        const trace = new TraceBackend(backend, file);
        const expected = await exec(source, trace);
        await trace.close();
        expect(expected).toMatchObject({ status: 'success', value: 'recovered' });
        const replay = new ReplayBackend(file);
        expect(await exec(source, replay)).toEqual(expected);
        await replay.close();
    });

    it('re-executes explicit writes, shell, and network tools under normal restrictions', async () => {
        const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('network input'));
        const backend = scripted('answer');
        const source = `
let input = web_fetch('https://example.com')
let output = ask 'Process {input}'
write_file('output.txt', output)
success [read_file('output.txt'), shell('echo traced')]
`;
        const trace = new TraceBackend(backend, file);
        const expected = await exec(source, trace);
        await trace.close();
        fs.unlinkSync(path.join(dir, 'output.txt'));
        const replay = new ReplayBackend(file);
        expect(await exec(source, replay)).toEqual(expected);
        await replay.close();
        expect(fs.readFileSync(path.join(dir, 'output.txt'), 'utf8')).toBe('answer');
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(await exec(`restrict './allowed':
    write_file('denied.txt', 'x')`, new ReplayBackend(file)))
            .toMatchObject({ status: 'failure', failure: { status_code: 'restriction_violation' } });
        expect(fs.existsSync(path.join(dir, 'denied.txt'))).toBe(false);
    });

    it('loads and saves persistent variables during trace replay, including after failure', async () => {
        const backend = scripted('answer');
        const source = `let output = ask 'Question'\nfail output`;
        const trace = new TraceBackend(backend, file);
        await exec(source, trace);
        await trace.close();
        const store = new MemoryStore();
        const load = vi.spyOn(store, 'load');
        const save = vi.spyOn(store, 'save');
        const replay = new ReplayBackend(file);
        expect(await exec(source, replay, store)).toMatchObject({ status: 'failure', failure: { reason: 'answer' } });
        await replay.close();
        expect(load).toHaveBeenCalledOnce();
        expect(save).toHaveBeenCalledWith({ output: 'answer' });
    });

    it('matches all input fields in order and reports exhaustion and unused entries', async () => {
        const backend = scripted('one', 'two');
        const trace = new TraceBackend(backend, file);
        await exec(`let first = ask 'First'\nsuccess ask 'Second'`, trace);
        await trace.close();
        const replay = new ReplayBackend(file);
        const original = backend.call.mock.calls[0][0];
        for (const request of [
            { ...original, prompt: 'Changed' },
            { ...original, kind: 'agent' as const },
            { ...original, model: 'other' },
            { ...original, reasoningEffort: 'high' as const },
            { ...original, showReasoning: true },
        ]) {
            await expect(replay.call(request)).rejects.toThrow(/mismatch at call 1/);
        }
        const response = await replay.call(original);
        response.effective.model = 'mutated';
        await expect(replay.close()).rejects.toThrow(/1 unused/);
        expect(await replay.call(backend.call.mock.calls[1][0])).toMatchObject({ text: 'two', effective: { model: 'test' } });
        await expect(replay.call(original)).rejects.toThrow(/exhausted at call 3/);
        await replay.close();
    });

    it('fails explicitly when a trace cannot be saved', async () => {
        const backend = scripted('answer');
        const trace = new TraceBackend(backend, file);
        fs.unlinkSync(file);
        fs.mkdirSync(file);
        expect(await exec(`success ask 'Question'`, trace)).toMatchObject({
            status: 'failure', failure: { status_code: 'llm_error', reason: expect.stringContaining('could not save trace') },
        });
        await trace.close();
    });

    it.each([
        {},
        { request: { kind: ['ask'], prompt: 'x', model: null, reasoningEffort: null, showReasoning: false }, response: { text: 'x', effective: {} } },
        { request: { kind: 'ask', prompt: 'x', model: null, reasoningEffort: 'invalid', showReasoning: false }, response: { text: 'x', effective: {} } },
        { request: { kind: 'ask', prompt: 'x', model: null, reasoningEffort: null, showReasoning: false }, response: { text: 1, effective: {} } },
        { request: { kind: 'ask', prompt: 'x', model: null, reasoningEffort: null, showReasoning: false }, error: { status_code: 'unknown', reason: 'bad' } },
        { request: { kind: 'ask', prompt: 'x', model: null, reasoningEffort: null, showReasoning: false }, response: { text: 'x', effective: {} }, error: { status_code: 'llm_error', reason: 'bad' } },
    ])('rejects malformed trace entries: %j', (entry) => {
        fs.writeFileSync(file, JSON.stringify({ format: 'spl-trace', version: 1 }) + '\n' + JSON.stringify(entry) + '\n');
        expect(() => new ReplayBackend(file)).toThrow(/entry at line 2/);
    });
});
