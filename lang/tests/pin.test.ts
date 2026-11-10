import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Failure } from '../src/errors.js';
import { ExecutionSession, run } from '../src/interpreter.js';
import type { LlmBackend, LlmRequest, LlmResponse } from '../src/llm.js';
import { Logger } from '../src/logger.js';
import { extractMarkdown, parseMarkdown } from '../src/markdown.js';
import { Pin } from '../src/pin.js';
import { ToolHost } from '../src/tools.js';
import { NoLlm } from './helpers.js';

const logger = new Logger('silent');
const markdown = (body: string) => `---\nextension: semantic-prompt-language\nversion: 1\n---\n\n${body}\n`;
const fence = (code: string) => `\`\`\`spl\n${code}\n\`\`\``;
let cwd: string;

beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'spl-pin-'));
});
afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(cwd, { recursive: true, force: true });
});

function scripted(...responses: string[]) {
    return {
        call: vi.fn(async (_req: LlmRequest): Promise<LlmResponse> => {
            const text = responses.shift();
            if (text === undefined) throw new Error('unexpected model call');
            return { text, reasoning: 'saved reasoning', effective: { model: 'test' } };
        }),
        async close() {},
    };
}

describe('pinned Markdown execution', () => {
    it('saves every generation response, repair and loop iteration, then automatically replays offline', async () => {
        const source = markdown(fence(`let number = ask(fmt='integer', repairs=1, model='per-call') 'Number?'
let answers = []
for i in range(2):
    answers.append(think 'Think {i}')
let result = agent 'Act'
success [number, answers, result]`));
        const backend = scripted('bad JSON', '7', 'first', 'second', 'done\n>> nested\n```spl\nfail');
        const pin = Pin.capture(source, { cwd, args: [], model: 'override' });
        const expected = await run(parseMarkdown(source), { backend, logger, cwd, model: 'override', pin });
        expect(expected).toMatchObject({ status: 'success', value: [7, ['first', 'second'], 'done\n>> nested\n```spl\nfail'] });
        expect(backend.call).toHaveBeenCalledTimes(5);
        expect(backend.call.mock.calls.every(([req]) => req.model === 'override')).toBe(true);
        const locked = pin.toMarkdown(source);
        expect(locked.startsWith(source)).toBe(true);
        expect(locked).toContain('>> ```spl-lock');
        expect(locked).toContain('>>           "reasoning": "saved reasoning"');
        expect(extractMarkdown(locked).blocks).toHaveLength(1);
        const noLlm = new NoLlm();
        const calls = vi.spyOn(noLlm, 'call');
        expect(await run(parseMarkdown(locked), { backend: noLlm, logger })).toEqual(expected);
        expect(calls).not.toHaveBeenCalled();
    });

    it('replays all explicit tools, human input, environment, arguments and initial variables without external work', async () => {
        vi.stubEnv('SPL_PIN_TEST', 'original environment');
        const tools = vi.spyOn(ToolHost.prototype, 'invoke').mockImplementation(async tool => `saved ${tool}`);
        const human = vi.fn(async () => '  exact\nanswer  ');
        const load = vi.fn(() => ({ seed: ['initial'] }));
        const save = vi.fn();
        const source = markdown(fence(`let results = [read_file('input.txt'), write_file('output.txt', 'content'), shell('command'),
    web_fetch('https://example.test'), web_search('query')]
let answer = human 'Question?'
seed.append('changed')
success [results, answer, $env.SPL_PIN_TEST, $args, seed]`));
        const pin = Pin.capture(source, { cwd, args: ['input argument'] });
        const expected = await run(parseMarkdown(source), {
            backend: new NoLlm(), logger, cwd, args: ['input argument'], human, store: { load, save }, pin,
        });
        expect(expected).toMatchObject({ status: 'success', value: [
            ['saved read_file', 'saved write_file', 'saved shell', 'saved web_fetch', 'saved web_search'],
            '  exact\nanswer  ', 'original environment', ['input argument'], ['initial', 'changed'],
        ] });
        expect(tools).toHaveBeenCalledTimes(5);
        expect(human).toHaveBeenCalledOnce();
        expect(load).toHaveBeenCalledOnce();
        expect(save).toHaveBeenCalledOnce();
        const program = parseMarkdown(pin.toMarkdown(source));
        tools.mockClear();
        human.mockClear();
        vi.stubEnv('SPL_PIN_TEST', 'changed environment');
        expect(await run(program, { backend: new NoLlm(), logger, human })).toEqual(expected);
        expect(await run(program, { backend: new NoLlm(), logger })).toEqual(expected);
        expect(tools).not.toHaveBeenCalled();
        expect(human).not.toHaveBeenCalled();
        expect(save).toHaveBeenCalledOnce();
    });

    it('reconstructs immediate blockquote decisions, nested function calls, repairs and terminal success', async () => {
        const source = markdown(fence(`let count = 0
def number():
    count += 1
    restrict './output':
        write_file('./output/value.txt', 'original')
    return ask(fmt='integer', repairs=1) 'Number?'`) +
            '\n\n> @CTL(restrict={fs: ["./output"]}, enforce="Be precise", model="quote-model", reasoning="high") Call @number, ask for approval and return the result.');
        const tools = vi.spyOn(ToolHost.prototype, 'invoke').mockResolvedValue('written');
        const human = vi.fn(async () => 'approved');
        let attempts = 0;
        const backend: LlmBackend = {
            call: vi.fn(async req => {
                if (!req.naturalLanguage) return { text: attempts++ === 0 ? 'bad' : '9', effective: {} };
                expect(req.model).toBe('quote-model');
                expect(req.reasoningEffort).toBe('high');
                expect(req.restrictions.has('fs')).toBe(true);
                const invoke = (name: string, args: Record<string, unknown>) => req.invokeAction!({ name, arguments: args });
                const value = await invoke('call_function', { name: 'number', args: [] });
                const answer = await invoke('ask_human', { question: 'Approve?' });
                await invoke('save_variable', { name: 'answer', value: answer });
                await invoke('success', { value: [value, answer, await invoke('load_variable', { name: 'count' })] });
                throw new Error('unreachable');
            }),
            async close() {},
        };
        const pin = Pin.capture(source, { cwd, args: [] });
        const expected = await run(parseMarkdown(source), { backend, logger, cwd, human, pin });
        expect(expected).toMatchObject({ status: 'success', value: [9, 'approved', 1] });
        expect(backend.call).toHaveBeenCalledTimes(3);
        tools.mockClear();
        human.mockClear();
        expect(await run(parseMarkdown(pin.toMarkdown(source)), { backend: new NoLlm(), logger })).toEqual(expected);
        expect(tools).not.toHaveBeenCalled();
        expect(human).not.toHaveBeenCalled();
    });

    it('records returned blockquote actions and final responses as data, not new model instructions', async () => {
        const source = markdown('> Save an answer.\n\n' + fence('success answer'));
        let turn = 0;
        const backend: LlmBackend = {
            async call() {
                return turn++ === 0
                    ? { text: 'Saving', effective: {}, action: { name: 'save_variable', arguments: { name: 'answer', value: 'saved' } } }
                    : { text: 'Finished', effective: {} };
            },
            async close() {},
        };
        const pin = Pin.capture(source, { cwd, args: [] });
        const expected = await run(parseMarkdown(source), { backend, logger, cwd, pin });
        expect(expected).toMatchObject({ status: 'success', value: 'saved' });
        expect(await run(parseMarkdown(pin.toMarkdown(source)), { backend: new NoLlm(), logger })).toEqual(expected);
    });

    it('does not repeat agent-owned tools, or consult filesystem state while rebuilding restrictions', async () => {
        const source = markdown(fence(`restrict './output':
    success agent 'Write output'`));
        const backend: LlmBackend = {
            async call(req) {
                await req.tools.invoke('write_file', { path: './output/agent.txt', content: 'original' });
                return { text: 'written', effective: {}, toolResults: ['original tool result'] };
            },
            async close() {},
        };
        const pin = Pin.capture(source, { cwd, args: [] });
        const expected = await run(parseMarkdown(source), { backend, logger, cwd, pin });
        expect(expected).toMatchObject({ status: 'success', value: 'written' });
        const output = path.join(cwd, 'output', 'agent.txt');
        expect(fs.readFileSync(output, 'utf8')).toBe('original');
        fs.unlinkSync(output);
        const paths = vi.spyOn(fs.realpathSync, 'native').mockImplementation(() => { throw new Error('unexpected filesystem lookup'); });
        expect(await run(parseMarkdown(pin.toMarkdown(source)), { backend: new NoLlm(), logger })).toEqual(expected);
        expect(paths).not.toHaveBeenCalled();
        expect(fs.existsSync(output)).toBe(false);
    });

    it('replays caught tool and model failures, rather than retrying live effects', async () => {
        const source = markdown(fence(`let codes = []
try:
    read_file('missing')
except e:
    codes.append(e.status_code)
try:
    ask 'Fail'
except e:
    codes.append(e.status_code)
success codes`));
        const tools = vi.spyOn(ToolHost.prototype, 'invoke').mockRejectedValue(new Failure('tool_error', 'offline'));
        const backend: LlmBackend = { async call() { throw new Error('provider down'); }, async close() {} };
        const pin = Pin.capture(source, { cwd, args: [] });
        const expected = await run(parseMarkdown(source), { backend, logger, cwd, pin });
        expect(expected).toMatchObject({ status: 'success', value: ['tool_error', 'llm_error'] });
        tools.mockClear();
        expect(await run(parseMarkdown(pin.toMarkdown(source)), { backend: new NoLlm(), logger })).toEqual(expected);
        expect(tools).not.toHaveBeenCalled();
    });

    it.each(['\n', '\r\n'])('preserves original source lines and accepts %j line endings', async newline => {
        const source = '\uFEFF' + markdown(fence("success ask 'Prompt'")).replace(/\n/g, newline);
        const pin = Pin.capture(source, { cwd, args: [] });
        const program = parseMarkdown(source);
        const expected = await run(program, { backend: scripted('answer'), logger, cwd, pin });
        const locked = parseMarkdown(pin.toMarkdown(source).replace(/\r?\n/g, newline));
        expect(locked.body).toEqual(program.body);
        expect(await run(locked, { backend: new NoLlm(), logger })).toEqual(expected);
    });

    it('rejects source edits, malformed journals, duplicate journals and untracked appended code', async () => {
        const source = markdown(fence("success ask 'Prompt'"));
        const pin = Pin.capture(source, { cwd, args: [] });
        await run(parseMarkdown(source), { backend: scripted('answer'), logger, cwd, pin });
        const locked = pin.toMarkdown(source);
        expect(() => parseMarkdown(locked.replace("ask 'Prompt'", "ask 'Edited'"))).toThrow(/source mismatch/);
        expect(() => parseMarkdown(locked.replace('"format": "spl-lock"', '"format": "wrong"'))).toThrow(/format/);
        expect(() => parseMarkdown(locked.replace('"version": 1,', '"version": invalid,'))).toThrow(/JSON/);
        expect(() => parseMarkdown(locked.replace(/>> /g, '> '))).toThrow(/double blockquote/);
        expect(() => parseMarkdown(locked.replace(/>> /g, ''))).toThrow(/double blockquote/);
        expect(() => parseMarkdown(locked.replace(/\n>> ```\n$/, '\n'))).toThrow(/journal fence/);
        expect(() => parseMarkdown(locked + '\n' + locked.slice(locked.indexOf('>> ```')))).toThrow(/duplicate/);
        expect(() => parseMarkdown(locked + '\n' + fence('pass'))).toThrow(/source mismatch/);
    });

    it.each(['missing', 'mismatched', 'unused', 'invalid-result'] as const)('fails closed for %s entries', async change => {
        const source = markdown(fence("success ask 'Prompt'"));
        const pin = Pin.capture(source, { cwd, args: [] });
        await run(parseMarkdown(source), { backend: scripted('answer'), logger, cwd, pin });
        if (change === 'missing') pin.data.entries.pop();
        if (change === 'mismatched') pin.data.entries[1].request = 'wrong';
        if (change === 'unused') pin.data.entries.push(structuredClone(pin.data.entries[1]));
        if (change === 'invalid-result') pin.data.entries[1].outcome = { value: 'not a response' };
        const backend = scripted('must never be used');
        const result = await run(parseMarkdown(pin.toMarkdown(source)), { backend, logger });
        expect(result).toMatchObject({ status: 'failure', failure: { status_code: 'runtime_error', reason: expect.stringMatching(/locked workflow/) } });
        expect(backend.call).not.toHaveBeenCalled();
    });

    it('rejects changed execution inputs and persistent stores', async () => {
        const source = markdown(fence('success $args'));
        const pin = Pin.capture(source, { cwd, args: ['original'] });
        await run(parseMarkdown(source), { backend: new NoLlm(), logger, cwd, pin });
        const program = parseMarkdown(pin.toMarkdown(source));
        for (const options of [{ args: ['changed'] }, { model: 'different' }, { cwd: path.join(cwd, 'other') },
            { store: { load: vi.fn(), save: vi.fn() } }]) {
            expect(await run(program, { backend: new NoLlm(), logger, ...options })).toMatchObject({ status: 'failure' });
        }
    });

    it('rejects locked workflows in stateful sessions rather than accidentally making live calls', async () => {
        const source = markdown(fence("success ask 'Prompt'"));
        const pin = Pin.capture(source, { cwd, args: [] });
        await run(parseMarkdown(source), { backend: scripted('answer'), logger, cwd, pin });
        const backend = scripted('must never be used');
        await expect(new ExecutionSession().run(parseMarkdown(pin.toMarkdown(source)), { backend, logger }))
            .rejects.toThrow(/standalone/);
        expect(backend.call).not.toHaveBeenCalled();
    });
});
