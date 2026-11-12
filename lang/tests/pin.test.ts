import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Failure, SplSyntaxError } from '../src/errors.js';
import type { LlmBackend, LlmRequest } from '../src/llm.js';
import { extractMarkdown, parseMarkdown } from '../src/markdown.js';
import { Pin, PinError } from '../src/pin.js';
import { ToolHost } from '../src/tools.js';
import { Trace } from '../src/trace.js';
import { ExecutionSession, run, type RunOptions, type RunResult } from '../src/workflow.js';
import { NoLlm, acting, action, backend, cleanTemp, document, fence, scripted, silent, tempDir } from './helpers.js';

let cwd: string;
beforeEach(() => {
    cwd = tempDir('spl-pin-');
});
afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    cleanTemp();
});

const markdown = (body: string): string => `${document(body)}\n`;
const asking = markdown(fence("success(await ask('Prompt'));"));

/** Answers in order with saved reasoning. */
function reasoned(...replies: string[]): LlmBackend & { calls: LlmRequest[] } {
    const calls: LlmRequest[] = [];
    return { calls, ...backend(request => {
        const text = replies[calls.length];
        calls.push(request);
        if (text === undefined) throw new Error('unexpected model call');
        return { text, reasoning: 'saved reasoning', effective: { model: 'test' } };
    }) };
}

/** Runs a workflow while capturing it, like `--pin`. */
async function capture(source: string, options: Partial<RunOptions> = {}): Promise<{ pin: Pin; result: RunResult; locked: string }> {
    const pin = Pin.capture(source, { cwd, args: options.args ?? [], model: options.model });
    const result = await run(parseMarkdown(source), { backend: new NoLlm(), logger: silent, cwd, ...options, pin });
    return { pin, result, locked: pin.toMarkdown(source) };
}

/** Runs a locked workflow with nothing to call: no model, tools, human or store. */
function replay(locked: string, options: Partial<RunOptions> = {}): Promise<RunResult> {
    return run(parseMarkdown(locked), { backend: new NoLlm(), logger: silent, ...options });
}

const requests = (pin: Pin): any[] => pin.data.entries.map(entry => JSON.parse(entry.request));

describe('pin capture', () => {
    it('journals the store, then every effect in execution order, with snapshots of the outcomes', async () => {
        vi.stubEnv('SPL_PIN_TEST', 'original environment');
        const source = markdown(fence(`const lines = [];
await restrict('./out', () => writeFile('./out/a.txt', 'content'));
lines.push(await ask('First', { model: 'per-call' }));
lines.push(await human('Question?'));
success([lines, env.SPL_PIN_TEST]);`));
        const { pin, result, locked } = await capture(source, { backend: scripted('reply'), human: () => 'answer', args: ['argument'], model: 'override' });
        expect(result).toEqual({ status: 'success', value: [['reply', 'answer'], 'original environment'], hasValue: true });
        const out = [{ kind: 'fs', values: [path.join(cwd, 'out')] }];
        expect(requests(pin)).toMatchObject([
            { kind: 'store' },
            { kind: 'restriction', restriction: 'fs', value: './out' },
            { kind: 'tool', tool: 'write_file', params: { path: './out/a.txt', content: 'content' }, restrictions: out },
            { kind: 'llm', request: { kind: 'ask', model: 'override', showReasoning: true }, restrictions: [] },
            { kind: 'human', question: 'Question?', line: 10 },
        ]);
        expect(pin.data.entries.map(entry => entry.outcome)).toEqual([
            { value: {} }, { value: out[0] }, { value: expect.stringMatching(/^Wrote 7 bytes/) },
            { value: { text: 'reply', effective: {} } }, { value: 'answer' },
        ]);
        expect(pin.data).toMatchObject({
            format: 'spl-lock', version: 1, source: expect.stringMatching(/^[0-9a-f]{64}$/),
            context: { cwd, args: ['argument'], model: 'override' },
            environment: { SPL_PIN_TEST: 'original environment' },
        });
        expect(pin.replaying).toBe(false);
        expect(JSON.parse(extractMarkdown(locked).lock!.entries[3].request)).toEqual(requests(pin)[3]);
        expect(extractMarkdown(locked).lock).toEqual(JSON.parse(JSON.stringify(pin.data)));
    });

    it('saves the environment only when the workflow reads it', async () => {
        vi.stubEnv('SPL_PIN_TEST', 'original environment');
        const unread = await capture(markdown(fence("success('constant');")));
        expect(unread.pin.data.environment).toBeUndefined();
        expect(unread.locked).not.toContain('original environment');
        expect(await replay(unread.locked)).toEqual(unread.result);

        const source = markdown('> Read the configured value and finish with it.');
        const model = acting(action('get_env', { name: 'SPL_PIN_TEST' }), results => action('success', { value: results[0] }));
        const read = await capture(source, { backend: model });
        expect(read.result).toMatchObject({ status: 'success', value: 'original environment' });
        expect(read.pin.data.environment).toMatchObject({ SPL_PIN_TEST: 'original environment' });
        expect(requests(read.pin).map(request => request.kind)).toEqual(['store', 'natural', 'natural']);
        vi.stubEnv('SPL_PIN_TEST', 'changed environment');
        expect(await replay(read.locked)).toEqual(read.result);
    });

    it('refuses traces, repeated pinning and sources other than the captured one', async () => {
        const { pin, locked } = await capture(asking, { backend: scripted('answer') });
        expect(() => pin.toMarkdown(asking.replace('Prompt', 'Edited'))).toThrow(/source mismatch/);
        expect(pin.toMarkdown(`\uFEFF${asking.replace(/\n/g, '\r\n')}\n\n`)).toContain('>> ```spl-lock');
        expect(() => pin.validateOptions({ trace: {} })).toThrow(PinError);

        const trace = Trace.open(path.join(cwd, 'run.jsonl'), { source: asking, runtime: 'test', cwd });
        const model = scripted('must never be used');
        try {
            expect(await run(parseMarkdown(asking), { backend: model, logger: silent, cwd, trace, pin: Pin.capture(asking, { cwd, args: [] }) }))
                .toMatchObject({ status: 'failure', failure: { status_code: 'runtime_error', reason: 'pinned workflows cannot use traces' } });
        } finally { trace.close(); }
        expect(await replay(locked, { backend: model, pin: Pin.capture(locked, { cwd, args: [] }) }))
            .toMatchObject({ status: 'failure', failure: { status_code: 'runtime_error', reason: 'cannot pin an already locked workflow' } });
        expect(model.calls).toEqual([]);
    });
});

describe('pinned Markdown execution', () => {
    it('saves every generation response, repair and loop iteration, then automatically replays offline', async () => {
        const source = markdown(fence(`const number = await ask('Number?', { fmt: 'integer', repairs: 1, model: 'per-call' });
const answers = [];
for (let i = 0; i < 2; i++) answers.push(await think(\`Think \${i}\`));
const result = await agent('Act');
success([number, answers, result]);`));
        const nested = 'done\n>> nested\n```js\nfail("not code")';
        const model = reasoned('bad JSON', '7', 'first', 'second', nested);
        const { pin, result, locked } = await capture(source, { backend: model, model: 'override' });
        expect(result).toMatchObject({ status: 'success', value: [7, ['first', 'second'], nested] });
        expect(model.calls).toHaveLength(5);
        expect(model.calls.every(call => call.model === 'override')).toBe(true);
        expect(pin.data.entries).toHaveLength(6);
        expect(locked.startsWith(source)).toBe(true);
        expect(locked.endsWith('\n>> ```\n')).toBe(true);
        expect(locked).toContain('>> ```spl-lock');
        expect(locked).toContain('>>           "reasoning": "saved reasoning"');
        expect(extractMarkdown(locked).blocks).toHaveLength(1);
        const offline = new NoLlm();
        const calls = vi.spyOn(offline, 'call');
        expect(await replay(locked, { backend: offline })).toEqual(result);
        expect(calls).not.toHaveBeenCalled();
    });

    it('replays all explicit tools, human input, environment, arguments and initial variables without external work', async () => {
        vi.stubEnv('SPL_PIN_TEST', 'original environment');
        const tools = vi.spyOn(ToolHost.prototype, 'invoke').mockImplementation(async tool => `saved ${tool}`);
        const human = vi.fn(async () => '  exact\nanswer  ');
        const load = vi.fn(() => ({ seed: ['initial'] }));
        const save = vi.fn();
        const source = markdown(fence(`const results = [await readFile('input.txt'), await writeFile('output.txt', 'content'), await shell('command'),
    await webFetch('https://example.test'), await webSearch('query')];
const answer = await human('Question?');
seed.push('changed');
success([results, answer, env.SPL_PIN_TEST, args, seed]);`));
        const { result, locked } = await capture(source, { args: ['input argument'], human, store: { load, save } });
        expect(result).toMatchObject({ status: 'success', value: [
            ['saved read_file', 'saved write_file', 'saved shell', 'saved web_fetch', 'saved web_search'],
            '  exact\nanswer  ', 'original environment', ['input argument'], ['initial', 'changed'],
        ] });
        expect(tools).toHaveBeenCalledTimes(5);
        expect(human).toHaveBeenCalledOnce();
        expect(load).toHaveBeenCalledOnce();
        expect(save).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ seed: ['initial', 'changed'], answer: '  exact\nanswer  ' }));
        tools.mockClear();
        human.mockClear();
        vi.stubEnv('SPL_PIN_TEST', 'changed environment');
        expect(await replay(locked, { human })).toEqual(result);
        expect(await replay(locked)).toEqual(result);
        expect(tools).not.toHaveBeenCalled();
        expect(human).not.toHaveBeenCalled();
        expect(load).toHaveBeenCalledOnce();
        expect(save).toHaveBeenCalledOnce();
    });

    it('reconstructs immediate blockquote decisions, nested function calls, repairs and terminal success', async () => {
        const source = markdown(`${fence(`let count = 0;
async function number() {
    count += 1;
    await restrict('./output', () => writeFile('./output/value.txt', 'original'));
    return ask('Number?', { fmt: 'integer', repairs: 1 });
}`)}

> @CTL(restrict={fs: ["./output"]}, enforce="Be precise", model="quote-model", reasoning="high") Call @number, ask for approval and return the result.`);
        const tools = vi.spyOn(ToolHost.prototype, 'invoke').mockResolvedValue('written');
        const human = vi.fn(async () => 'approved');
        const seen: unknown[] = [];
        let attempts = 0;
        let commands = 0;
        const model = backend(async request => {
            if (!request.naturalLanguage) {
                seen.push(request.prompt);
                return { text: attempts++ === 0 ? 'bad' : '9', effective: {} };
            }
            commands++;
            seen.push({ model: request.model, effort: request.reasoningEffort, fs: request.restrictions.has('fs') });
            const invoke = (name: string, args: Record<string, unknown>) => request.invokeAction!(action(name, args));
            const value = await invoke('call_function', { name: 'number', args: [] });
            const answer = await invoke('ask_human', { question: 'Approve?' });
            await invoke('save_variable', { name: 'answer', value: answer });
            await invoke('success', { value: [value, answer, await invoke('load_variable', { name: 'count' })] });
            throw new Error('unreachable');
        });
        const { pin, result, locked } = await capture(source, { backend: model, human });
        expect(result).toMatchObject({ status: 'success', value: [9, 'approved', 1] });
        expect(commands).toBe(1);
        expect(seen[0]).toEqual({ model: 'quote-model', effort: 'high', fs: true });
        expect(String(seen[1])).toContain('- Follow: Be precise');
        expect(String(seen[2])).toContain('Previous response:\nbad');
        expect(human).toHaveBeenCalledExactlyOnceWith('Approve?', 15);
        expect(requests(pin).map(request => request.kind)).toEqual([
            'store', 'restriction', 'natural', 'restriction', 'tool', 'llm', 'llm', 'natural', 'human', 'natural', 'natural', 'natural',
        ]);
        tools.mockClear();
        human.mockClear();
        expect(await replay(locked)).toEqual(result);
        expect(tools).not.toHaveBeenCalled();
        expect(human).not.toHaveBeenCalled();
    });

    it('records returned blockquote actions and final responses as data, not new model instructions', async () => {
        const source = markdown(`> Save an answer.\n\n${fence('success(answer);')}`);
        let turn = 0;
        const model = backend(() => turn++ === 0
            ? { text: 'Saving', effective: {}, action: action('save_variable', { name: 'answer', value: 'saved' }) }
            : { text: 'Finished', effective: {} });
        const { pin, result, locked } = await capture(source, { backend: model });
        expect(result).toMatchObject({ status: 'success', value: 'saved' });
        expect(turn).toBe(2);
        expect(pin.data.entries.slice(1).map(entry => entry.outcome)).toEqual([
            { value: { text: 'Saving', effective: {}, action: action('save_variable', { name: 'answer', value: 'saved' }) } },
            { value: { text: 'Finished', effective: {} } },
        ]);
        expect(await replay(locked)).toEqual(result);
    });

    it('does not repeat agent-owned tools, or consult filesystem state while rebuilding restrictions', async () => {
        const source = markdown(fence("await restrict('./output', async () => success(await agent('Write output')));"));
        const model = backend(async request => {
            await request.tools.invoke('write_file', { path: './output/agent.txt', content: 'original' });
            return { text: 'written', effective: {}, toolResults: ['original tool result'] };
        });
        const { result, locked } = await capture(source, { backend: model });
        expect(result).toMatchObject({ status: 'success', value: 'written' });
        expect(locked).toContain('original tool result');
        const output = path.join(cwd, 'output', 'agent.txt');
        expect(fs.readFileSync(output, 'utf8')).toBe('original');
        fs.unlinkSync(output);
        const paths = vi.spyOn(fs.realpathSync, 'native').mockImplementation(() => { throw new Error('unexpected filesystem lookup'); });
        expect(await replay(locked)).toEqual(result);
        expect(paths).not.toHaveBeenCalled();
        expect(fs.existsSync(output)).toBe(false);
    });

    it('replays caught tool and model failures, rather than retrying live effects', async () => {
        const source = markdown(fence(`const codes = [];
try { await readFile('missing'); } catch (error) { codes.push(error.statusCode, error.reason); }
try { await ask('Fail'); } catch (error) { codes.push(error.statusCode, error.reason); }
success(codes);`));
        const tools = vi.spyOn(ToolHost.prototype, 'invoke').mockRejectedValue(new Failure('tool_error', 'offline'));
        const model = backend(() => { throw new Error('provider down'); });
        const { pin, result, locked } = await capture(source, { backend: model });
        expect(result).toMatchObject({ status: 'success', value: ['tool_error', 'offline', 'llm_error', 'provider down'] });
        expect(pin.data.entries.slice(1).map(entry => entry.outcome)).toEqual([
            { error: { status_code: 'tool_error', reason: 'offline' } }, { error: { status_code: 'llm_error', reason: 'provider down' } },
        ]);
        tools.mockClear();
        expect(await replay(locked)).toEqual(result);
        expect(tools).not.toHaveBeenCalled();
    });

    it('replays a failed workflow with the same failure payload', async () => {
        const source = markdown(fence("const verdict = await ask('Verdict?');\nassert(verdict === 'pass', `verdict was ${verdict}`);"));
        const { result, locked } = await capture(source, { backend: scripted('reject') });
        expect(result).toEqual({ status: 'failure', failure: {
            status: 'failure', status_code: 'assertion_failed', reason: 'verdict was reject', line: 8,
            command: "assert(verdict === 'pass', `verdict was ${verdict}`);",
        } });
        expect(await replay(locked)).toEqual(result);
    });

    it('runs native Node.js calls again: only library effects come from the journal', async () => {
        const source = markdown(fence(`import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const log = join(import.meta.dirname, 'native.log');
appendFileSync(log, 'run\\n');
await writeFile('library.txt', 'written once');
success([readFileSync(log, 'utf8'), await readFile('library.txt')]);`));
        const { result, locked } = await capture(source);
        expect(result).toMatchObject({ status: 'success', value: ['run\n', 'written once'] });
        fs.unlinkSync(path.join(cwd, 'library.txt'));
        expect(await replay(locked)).toMatchObject({ status: 'success', value: ['run\nrun\n', 'written once'] });
        expect(fs.existsSync(path.join(cwd, 'library.txt'))).toBe(false);
    });

    it.each(['\n', '\r\n'])('preserves original source lines and accepts %j line endings', async newline => {
        const source = '\uFEFF' + asking.replace(/\n/g, newline);
        const pin = Pin.capture(source, { cwd, args: [] });
        const workflow = parseMarkdown(source);
        const expected = await run(workflow, { backend: scripted('answer'), logger: silent, cwd, pin });
        expect(expected).toMatchObject({ status: 'success', value: 'answer' });
        const locked = parseMarkdown(pin.toMarkdown(source).replace(/\r?\n/g, newline));
        expect(locked.steps).toEqual(workflow.steps);
        expect(locked.lines.slice(0, workflow.lines.length - 1)).toEqual(workflow.lines.slice(0, -1));
        expect(await run(locked, { backend: new NoLlm(), logger: silent })).toEqual(expected);
    });
});

describe('locked workflow validation', () => {
    it('rejects source edits, malformed journals, duplicate journals and untracked appended code', async () => {
        const { locked } = await capture(asking, { backend: scripted('answer') });
        expect(() => parseMarkdown(locked.replace("ask('Prompt')", "ask('Edited')"))).toThrow(/source mismatch/);
        expect(() => parseMarkdown(locked.replace('version: 1', 'version: 1\nmodel: other'))).toThrow(/source mismatch/);
        expect(() => parseMarkdown(locked.replace('"format": "spl-lock"', '"format": "wrong"'))).toThrow(/format/);
        expect(() => parseMarkdown(locked.replace('"version": 1,', '"version": 2,'))).toThrow(/format\/version/);
        expect(() => parseMarkdown(locked.replace('"version": 1,', '"version": invalid,'))).toThrow(/JSON/);
        expect(() => parseMarkdown(locked.replace('"entries": [', '"entries": [ {"request": "x", "outcome": {}},'))).toThrow(/journal/);
        expect(() => parseMarkdown(locked.replace(/>> /g, '> '))).toThrow(/double blockquote/);
        expect(() => parseMarkdown(locked.replace(/>> /g, ''))).toThrow(/double blockquote/);
        expect(() => parseMarkdown(locked.replace(/\n>> ```\n$/, '\n'))).toThrow(/journal fence/);
        expect(() => parseMarkdown(locked + '\n' + locked.slice(locked.indexOf('>> ```')))).toThrow(/duplicate/);
        expect(() => parseMarkdown(locked + '\n' + fence('log(1);'))).toThrow(/source mismatch/);
        expect(() => parseMarkdown(locked.replace('\n>> ```spl-lock', '\n> Act.\n\n>> ```spl-lock'))).toThrow(/source mismatch/);
        let error: unknown;
        try { parseMarkdown(locked.replace('Prompt', 'Edited')); } catch (caught) { error = caught; }
        expect(error).toBeInstanceOf(SplSyntaxError);
        expect(error).toMatchObject({ line: locked.split('\n').indexOf('>> ```spl-lock') + 1, col: 1 });
        expect(parseMarkdown(locked + '\n\n').markdown?.lock?.entries).toHaveLength(2);
    });

    it.each([
        ['missing', /locked workflow exhausted at entry 2/],
        ['mismatched', /locked workflow request mismatch at entry 2/],
        ['unused', /locked workflow ended with 1 unused journal entries/],
        ['invalid-result', /invalid locked workflow result at entry 2/],
        ['no-environment', /locked workflow has no saved environment/],
    ] as const)('fails closed for %s entries', async (change, reason) => {
        vi.stubEnv('SPL_PIN_TEST', 'original');
        const source = markdown(fence("success([await ask('Prompt'), env.SPL_PIN_TEST]);"));
        const { pin } = await capture(source, { backend: scripted('answer') });
        if (change === 'missing') pin.data.entries.pop();
        if (change === 'mismatched') pin.data.entries[1].request = 'wrong';
        if (change === 'unused') pin.data.entries.push(structuredClone(pin.data.entries[1]));
        if (change === 'invalid-result') pin.data.entries[1].outcome = { value: 'not a response' };
        if (change === 'no-environment') delete pin.data.environment;
        const model = scripted('must never be used');
        const result = await replay(pin.toMarkdown(source), { backend: model });
        expect(result).toMatchObject({ status: 'failure', failure: { status_code: 'runtime_error', reason: expect.stringMatching(reason) } });
        expect(model.calls).toEqual([]);
    });

    it('does not let workflow code swallow a journal mismatch', async () => {
        const source = markdown(fence("let answer = 'fallback';\ntry { answer = await ask('Prompt'); } catch {}\nsuccess(answer);"));
        const { pin } = await capture(source, { backend: scripted('answer') });
        pin.data.entries[1].request = 'wrong';
        const model = scripted('must never be used');
        expect(await replay(pin.toMarkdown(source), { backend: model })).toMatchObject({ status: 'failure', failure: { reason: expect.stringMatching(/locked workflow/) } });
        expect(model.calls).toEqual([]);
    });

    it('rejects changed execution inputs and persistent stores', async () => {
        const source = markdown(fence('success(args);'));
        const { result, locked } = await capture(source, { args: ['original'], model: 'pinned-model' });
        const workflow = parseMarkdown(locked);
        const options = { backend: new NoLlm(), logger: silent };
        const save = vi.fn();
        for (const [changed, reason] of [
            [{ args: ['changed'] }, /execution options mismatch/], [{ args: [] }, /execution options mismatch/],
            [{ model: 'different' }, /execution options mismatch/], [{ cwd: path.join(cwd, 'other') }, /execution options mismatch/],
            [{ store: { load: vi.fn(() => ({})), save } }, /cannot use a variable store/],
        ] as const) {
            expect(await run(workflow, { ...options, ...changed })).toMatchObject({
                status: 'failure', failure: { status_code: 'runtime_error', reason: expect.stringMatching(reason) },
            });
        }
        expect(save).not.toHaveBeenCalled();
        expect(await run(workflow, { ...options, args: ['original'], model: 'pinned-model', cwd })).toEqual(result);
        expect(result).toMatchObject({ status: 'success', value: ['original'] });
    });

    it('rejects locked workflows in stateful sessions rather than accidentally making live calls', async () => {
        const { locked } = await capture(asking, { backend: scripted('answer') });
        const model = scripted('must never be used');
        await expect(new ExecutionSession().run(parseMarkdown(locked), { backend: model, logger: silent })).rejects.toThrow(/standalone/);
        expect(model.calls).toEqual([]);
    });
});
