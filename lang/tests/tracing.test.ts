import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ask, configure } from '../src/index.js';
import { LlmError, type LlmBackend, type LlmRequest } from '../src/llm.js';
import { Logger } from '../src/logger.js';
import type { ModelStreamEvent } from '../src/log-events.js';
import { parse, parseMarkdown } from '../src/markdown.js';
import { setAmbient } from '../src/runtime.js';
import { ToolHost } from '../src/tools.js';
import { Trace, TraceError, type TraceContext } from '../src/trace.js';
import { run, type RunOptions, type RunResult } from '../src/workflow.js';
import { NoLlm, acting, action, backend, cleanTemp, document, exec, fence, scripted, silent, tempDir } from './helpers.js';

let cwd: string;
let file: string;
beforeEach(() => {
    cwd = tempDir('spl-trace-');
    file = path.join(cwd, 'run.jsonl');
});
afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    setAmbient(undefined);
    cleanTemp();
});

const context = (source: string): TraceContext => ({ source, runtime: 'test-runtime', cwd });
const journal = (): string => fs.readFileSync(file, 'utf8');
const rows = (): any[] => journal().trimEnd().split('\n').map(line => JSON.parse(line));
/** Recorded effect requests, in order. */
const requests = (): any[] => rows().filter(row => row.type === 'intent').map(row => JSON.parse(row.request));
const keepRows = (...indexes: number[]): void => {
    const all = journal().trimEnd().split('\n');
    fs.writeFileSync(file, indexes.map(index => all.at(index)).join('\n') + '\n');
};
const firstRows = (count: number): void => keepRows(...Array.from({ length: count }, (_, index) => index));

/** Answers in order with saved reasoning; an Error fails that call. */
function reasoned(...outcomes: (string | Error)[]): LlmBackend & { calls: LlmRequest[] } {
    const calls: LlmRequest[] = [];
    return { calls, ...backend(request => {
        const outcome = outcomes[calls.length];
        calls.push(request);
        if (outcome instanceof Error) throw outcome;
        if (outcome === undefined) throw new Error('unexpected model call');
        return { text: outcome, reasoning: 'saved reasoning', effective: { model: 'test' } };
    }) };
}

/** Runs a workflow with the trace file, sealing the result like the CLI does. */
async function traced(source: string, options: Partial<RunOptions> = {}, markdown = false): Promise<RunResult> {
    const workflow = markdown ? parseMarkdown(source) : parse(source);
    const trace = Trace.open(file, context(source));
    try {
        const result = await run(workflow, { backend: new NoLlm(), logger: silent, cwd, ...options, trace });
        trace.finish(result);
        return result;
    } finally {
        trace.close();
    }
}

describe('trace journal', () => {
    it('records library effects in execution order, with their guidance, restrictions and call lines', async () => {
        vi.stubEnv('SPL_TRACE_TEST', 'original');
        const source = `const note = await restrict('./out', async () => {
    await writeFile('./out/note.txt', 'draft');
    return readFile('./out/note.txt');
});
const title = await enforce('Be brief', () => ask(\`Title for \${note}\`, { len: 'word' }));
const approved = await human('Publish?');
success({ title, approved, mode: env.SPL_TRACE_TEST });`;
        const result = await traced(source, { backend: scripted('Draft'), human: () => 'yes' });
        expect(result).toEqual({ status: 'success', value: { title: 'Draft', approved: 'yes', mode: 'original' }, hasValue: true });
        const out = [{ kind: 'fs', values: [path.join(cwd, 'out')] }];
        expect(requests()).toEqual([
            { kind: 'restriction', restriction: 'fs', value: './out' },
            { kind: 'tool', tool: 'write_file', params: { path: './out/note.txt', content: 'draft' }, restrictions: out },
            { kind: 'tool', tool: 'read_file', params: { path: './out/note.txt' }, restrictions: out },
            { kind: 'llm', restrictions: [], request: {
                kind: 'ask', model: null, reasoningEffort: null, showReasoning: true,
                prompt: 'Response guidance (not runtime validation):\n- Follow: Be brief\n\nAnswer with a single word.\n\nTitle for draft',
            } },
            { kind: 'human', question: 'Publish?', line: 6 },
        ]);
        const events = rows();
        expect(events[0]).toMatchObject({ format: 'spl-trace', version: 2, runtime: 'test-runtime', cwd, args: [] });
        expect(events.slice(1).map(row => row.type)).toEqual([
            ...Array<string[]>(5).fill(['intent', 'outcome']).flat(), 'environment', 'terminal',
        ]);
        expect(events.filter(row => row.type === 'outcome').map(row => row.sequence)).toEqual([0, 1, 2, 3, 4]);
        expect(events[2].outcome).toEqual({ value: out[0] });
        expect(events[8].outcome).toEqual({ value: { text: 'Draft', effective: {} } });
        expect(events[10].outcome).toEqual({ value: 'yes' });
        expect(events.at(-2).value).toMatchObject({ SPL_TRACE_TEST: 'original' });
        expect(JSON.parse(events.at(-1).result)).toEqual(result);
    });

    it('journals every blockquote decision with the history that preceded it, not the model call', async () => {
        const source = document('> Save a greeting to @greeting, then ask for approval.');
        const save = action('save_variable', { name: 'greeting', value: 'hi' });
        const question = action('ask_human', { question: 'ok?' });
        const model = acting(save, question);
        expect(await traced(source, { backend: model, human: () => 'sure' }, true)).toMatchObject({ status: 'success', hasValue: false });
        expect(model.calls).toHaveLength(1);
        const recorded = requests();
        expect(recorded.map(request => request.kind)).toEqual(['natural', 'natural', 'human', 'natural']);
        expect(recorded[0]).toEqual({ kind: 'natural', text: 'Save a greeting to @greeting, then ask for approval.', line: 6, history: '[]', restrictions: [] });
        expect(recorded[2]).toEqual({ kind: 'human', question: 'ok?', line: 6 });
        const saved = { action: save, result: { value: 'hi' } };
        expect(recorded.filter(request => request.kind === 'natural').map(request => JSON.parse(request.history))).toEqual([
            [], [saved], [saved, { action: question, result: { value: 'sure' } }],
        ]);
        const outcomes = rows().filter(row => row.type === 'outcome').map(row => row.outcome.value);
        expect(outcomes).toEqual([
            { text: 'Runtime action.', effective: {}, action: save },
            { text: 'Runtime action.', effective: {}, action: question },
            'sure',
            { text: 'Done.', effective: {} },
        ]);
    });
});

describe('append-only trace resumption', () => {
    it('replays completed tools, model repairs, agents, human answers, arguments and environment without external work', async () => {
        vi.stubEnv('SPL_TRACE_TEST', 'original');
        const tools = vi.spyOn(ToolHost.prototype, 'invoke').mockResolvedValue('raw result');
        const model = reasoned('bad JSON', '42', 'agent result');
        const human = vi.fn(async () => '  exact\nanswer  ');
        const source = `const results = [await readFile('input'), await writeFile('output', 'text'), await shell('command'),
    await webFetch('https://example.test'), await webSearch('query')];
const value = await ask('Number?', { tokens: 2048, seed: 42, temperature: 0, fmt: 'integer', repairs: 1 });
const answer = await human('Approve?');
success([results, value, await agent('Act'), answer, args, env.SPL_TRACE_TEST, env.SPL_TRACE_ADDED ?? null]);`;
        const workflow = parse(source);
        let trace = Trace.open(file, { ...context(source), args: ['initial'] });
        let first: RunResult;
        try {
            first = await run(workflow, { backend: model, human, logger: silent, cwd, trace });
            trace.finish(first);
        } finally { trace.close(); }
        expect(first).toEqual({ status: 'success', hasValue: true, value: [
            Array(5).fill('raw result'), 42, 'agent result', '  exact\nanswer  ', ['initial'], 'original', null,
        ] });
        expect(tools.mock.calls.map(([tool]) => tool)).toEqual(['read_file', 'write_file', 'shell', 'web_fetch', 'web_search']);
        const original = journal();
        vi.stubEnv('SPL_TRACE_TEST', 'changed');
        vi.stubEnv('SPL_TRACE_ADDED', 'new');
        tools.mockClear();
        human.mockClear();
        trace = Trace.open(file, context(source));
        try {
            expect(await run(workflow, { backend: new NoLlm(), human, logger: silent, cwd, trace })).toEqual(first);
            trace.finish(first);
        } finally { trace.close(); }
        expect(journal()).toBe(original);
        expect(tools).not.toHaveBeenCalled();
        expect(human).not.toHaveBeenCalled();
        expect(model.calls).toHaveLength(3);
        expect(model.calls[1].prompt).toContain('Previous response:\nbad JSON');
        expect(original).toContain('saved reasoning');
        expect(original).toContain('\\"tokens\\":2048');
        expect(original).not.toMatch(/bindingId|scopeId|payloadId|onStream/);
    });

    it('resumes interrupted human input, reconstructing loops, aliases and mutations exactly once', async () => {
        const tools = vi.spyOn(ToolHost.prototype, 'invoke').mockResolvedValue('written');
        const source = `const answers = [];
const alias = answers;
async function collect(i) {
    await writeFile('output', 'original');
    alias.push(await human(\`Question \${i}\`));
}
for (let i = 0; i < 2; i++) await collect(i);
success([answers, alias === answers]);`;
        let calls = 0;
        await expect(traced(source, { human: () => { if (calls++ === 0) return ''; throw new Error('interrupted'); } })).rejects.toThrow(/interrupted/);
        const prefix = journal();
        expect(rows().at(-1)).toMatchObject({ type: 'intent' });
        expect(tools).toHaveBeenCalledTimes(2);
        const human = vi.fn(() => '  final\nanswer  ');
        const result = await traced(source, { human });
        expect(result).toMatchObject({ status: 'success', value: [['', '  final\nanswer  '], true] });
        expect(human).toHaveBeenCalledExactlyOnceWith('Question 1', 5);
        expect(tools).toHaveBeenCalledTimes(2);
        expect(journal().startsWith(prefix)).toBe(true);
        const complete = journal();
        expect(await traced(source)).toEqual(result);
        expect(journal()).toBe(complete);
    });

    it('continues a valid prefix even when there is no pending input or completion event', async () => {
        const source = "const value = await ask('First');\nsuccess([value, await ask('Second')]);";
        expect(await traced(source, { backend: scripted('first', 'second') })).toMatchObject({ status: 'success', value: ['first', 'second'] });
        firstRows(3);
        const prefix = journal();
        const suffix = scripted('new second');
        expect(await traced(source, { backend: suffix })).toMatchObject({ status: 'success', value: ['first', 'new second'] });
        expect(suffix.calls.map(call => call.prompt)).toEqual(['Second']);
        expect(journal().startsWith(prefix)).toBe(true);
        expect(rows().map(row => row.type)).toEqual([undefined, 'intent', 'outcome', 'intent', 'outcome', 'terminal']);
    });

    it('retries an unresolved generation or read, appending only its outcome', async () => {
        const source = "success([await readFile('input.txt'), await ask('Summarize')]);";
        fs.writeFileSync(path.join(cwd, 'input.txt'), 'first');
        await traced(source, { backend: scripted('summary') });
        for (const [count, expected] of [[4, ['first', 'again']], [2, ['second', 'again']]] as const) {
            firstRows(count);
            const prefix = journal();
            fs.writeFileSync(path.join(cwd, 'input.txt'), 'second');
            const model = scripted('again');
            expect(await traced(source, { backend: model })).toMatchObject({ status: 'success', value: expected });
            expect(model.calls).toHaveLength(1);
            expect(journal().startsWith(prefix)).toBe(true);
            expect(rows().map(row => row.sequence).filter(sequence => sequence !== undefined)).toEqual([0, 0, 1, 1]);
        }
    });

    it('replays durable failures deterministically and records raw generation failures', async () => {
        const source = `try {
    await ask('Unavailable');
} catch (error) {
    assert(error.statusCode === 'llm_error', error.statusCode);
}
fail('rejected');`;
        const model = reasoned(new LlmError('offline'));
        const first = await traced(source, { backend: model });
        expect(first).toMatchObject({ status: 'failure', failure: { status_code: 'explicit_failure', reason: 'rejected', line: 6 } });
        expect(await traced(source)).toEqual(first);
        expect(model.calls).toHaveLength(1);
        expect(rows().find(row => row.type === 'outcome').outcome.error).toEqual({ status_code: 'llm_error', reason: 'offline' });
    });

    it('replays completed agent-owned effects, but refuses to repeat an agent with an unknown outcome', async () => {
        const source = "success(await agent('Write a file'));";
        const writer = backend(async request => {
            await request.tools.invoke('write_file', { path: 'agent.txt', content: 'original' });
            return { text: 'done', effective: {} };
        });
        const first = await traced(source, { backend: writer });
        expect(fs.readFileSync(path.join(cwd, 'agent.txt'), 'utf8')).toBe('original');
        fs.unlinkSync(path.join(cwd, 'agent.txt'));
        expect(await traced(source)).toEqual(first);
        expect(fs.existsSync(path.join(cwd, 'agent.txt'))).toBe(false);
        firstRows(2);
        const before = journal();
        await expect(traced(source, { backend: writer })).rejects.toThrow(/unresolved effect/);
        expect(journal()).toBe(before);
        expect(fs.existsSync(path.join(cwd, 'agent.txt'))).toBe(false);
    });

    it.each([
        ['write_file', "await writeFile('output.txt', 'text');"],
        ['shell', "await shell('node --version');"],
    ])('refuses to repeat an unresolved %s call', async (tool, source) => {
        const tools = vi.spyOn(ToolHost.prototype, 'invoke').mockResolvedValue('done');
        await traced(source);
        expect(requests()).toMatchObject([{ kind: 'tool', tool }]);
        firstRows(2);
        tools.mockClear();
        await expect(traced(source)).rejects.toThrow(/unresolved effect.*manual recovery/);
        expect(tools).not.toHaveBeenCalled();
    });

    it('resumes blockquote actions inside functions without repeating writes, generation or shared mutations', async () => {
        const source = document(`${fence(`let count = 0;
async function approve() {
    count += 1;
    await writeFile('draft.txt', 'original');
    return [await ask('Number?', { fmt: 'integer', repairs: 1 }), await human('Approve?')];
}`)}

> @CTL(restrict={fs: ["."]}, enforce="Be precise", model="quote-model", reasoning="high") Invoke @approve, save the result to @answer, and finish.

${fence('success([count, answer]);')}`);
        const tools = vi.spyOn(ToolHost.prototype, 'invoke').mockResolvedValue('written');
        let generations = 0;
        const interrupted = backend(async request => {
            if (!request.naturalLanguage) return { text: generations++ === 0 ? 'bad JSON' : '9', effective: {} };
            const value = await request.invokeAction!(action('call_function', { name: 'approve', args: [] }));
            await request.invokeAction!(action('save_variable', { name: 'answer', value }));
            return { text: 'Done', effective: {} };
        });
        await expect(traced(source, { backend: interrupted, human: () => { throw new Error('interrupted'); } }, true)).rejects.toThrow(/interrupted/);
        const prefix = journal();
        expect(requests().map(request => request.kind)).toEqual(['restriction', 'natural', 'tool', 'llm', 'llm', 'human']);
        expect(requests()[1].controls).toEqual({ restrict: { fs: ['.'] }, enforce: 'Be precise', model: 'quote-model', reasoning: 'high' });
        const prompts: string[] = [];
        const resumed = backend(async request => {
            prompts.push(request.prompt);
            await request.invokeAction!(action('save_variable', { name: 'answer', value: [9, 'approved'] }));
            return { text: 'Done', effective: {} };
        });
        const result = await traced(source, { backend: resumed, human: () => 'approved' }, true);
        expect(result).toMatchObject({ status: 'success', value: [1, [9, 'approved']] });
        expect(prompts).toHaveLength(1);
        expect(prompts[0]).toContain('"value":[9,"approved"]');
        expect(tools).toHaveBeenCalledOnce();
        expect(generations).toBe(2);
        expect(journal().startsWith(prefix)).toBe(true);
        expect(await traced(source, {}, true)).toEqual(result);
        expect(tools).toHaveBeenCalledOnce();
    });

    it.each([
        { name: 'success', arguments: { value: 9 } },
        { name: 'fail', arguments: { reason: 'stop' } },
        { name: 'call_function', arguments: { name: 'missing', args: [] } },
        { name: 'read_file', arguments: { path: 'missing' } },
    ])('replays immediately terminating blockquote $name actions', async terminating => {
        const source = document('> Act.');
        const model = acting(terminating, action('fail', { reason: 'must terminate' }));
        const first = await traced(source, { backend: model }, true);
        expect(model.results).toEqual([]);
        expect(first).not.toMatchObject({ failure: { reason: 'must terminate' } });
        const complete = journal();
        expect(await traced(source, {}, true)).toEqual(first);
        expect(journal()).toBe(complete);
    });

    it('records a failed blockquote model call as a durable decision', async () => {
        const source = document(`> Act.\n\n${fence("fail('unreachable');")}`);
        const model = reasoned(new LlmError('provider down'));
        const first = await traced(source, { backend: model }, true);
        expect(first).toMatchObject({ status: 'failure', failure: { status_code: 'llm_error', reason: 'provider down', line: 6, command: '> Act.' } });
        expect(rows()[2].outcome).toEqual({ error: { status_code: 'llm_error', reason: 'provider down' } });
        expect(await traced(source, {}, true)).toEqual(first);
        expect(model.calls).toHaveLength(1);
    });

    it('records only requested agent environment values and replays them after changes', async () => {
        vi.stubEnv('SPL_AGENT_PRIVATE', 'do-not-include');
        vi.stubEnv('SPL_AGENT_PUBLIC', 'original');
        const source = document('> Return the configured environment value.');
        const model = acting(
            action('get_env', { name: 'SPL_AGENT_PUBLIC' }),
            action('get_env', { name: 'SPL_AGENT_MISSING' }),
            results => action('success', { value: results }),
        );
        const first = await traced(source, { backend: model }, true);
        expect(first).toMatchObject({ status: 'success', value: ['original', null] });
        expect(journal()).not.toContain('do-not-include');
        expect(rows().some(row => row.type === 'environment')).toBe(false);
        expect(requests().filter(request => request.kind !== 'natural')).toEqual([
            { kind: 'environment-value', name: 'SPL_AGENT_PUBLIC' }, { kind: 'environment-value', name: 'SPL_AGENT_MISSING' },
        ]);
        vi.stubEnv('SPL_AGENT_PUBLIC', 'changed');
        vi.stubEnv('SPL_AGENT_MISSING', 'now set');
        expect(await traced(source, {}, true)).toEqual(first);
    });

    it('snapshots the environment on first use, and never when the workflow does not read it', async () => {
        vi.stubEnv('SPL_TRACE_TEST', 'original');
        const unread = "success('constant');";
        await traced(unread);
        expect(rows().map(row => row.type)).toEqual([undefined, 'terminal']);
        fs.unlinkSync(file);
        const source = "const names = Object.keys(env);\nsuccess(['SPL_TRACE_TEST' in env, 'SPL_TRACE_LATER' in env, names.includes('SPL_TRACE_TEST'), env.SPL_TRACE_TEST]);";
        const first = await traced(source);
        expect(first).toMatchObject({ status: 'success', value: [true, false, true, 'original'] });
        expect(rows().filter(row => row.type === 'environment')).toHaveLength(1);
        vi.stubEnv('SPL_TRACE_TEST', 'changed');
        vi.stubEnv('SPL_TRACE_LATER', 'added');
        const complete = journal();
        expect(await traced(source)).toEqual(first);
        expect(journal()).toBe(complete);
    });

    it('streams live previews without persisting or replaying ephemeral updates', async () => {
        const streams: ModelStreamEvent[] = [];
        const logger = new Logger('error', () => {}, { streamSink: event => streams.push(event) });
        const model = backend(request => {
            request.onStream?.({ channel: 'response', messageId: 'preview-id', mode: 'append', text: 'partial preview' });
            return { text: 'complete', effective: {} };
        });
        const source = "success(await ask('Prompt'));";
        const result = await traced(source, { backend: model, logger });
        expect(streams.map(event => event.type)).toEqual(['update', 'end']);
        expect(journal()).not.toMatch(/partial preview|preview-id/);
        streams.length = 0;
        expect(await traced(source, { logger })).toEqual(result);
        expect(streams).toEqual([]);
    });

    it('replays typed schema hydration of values saved by a blockquote', async () => {
        const source = document(`${fence("const Data = struct('Data', { count: int }).methods({ doubled() { return this.count * 2; } });")}

> Save @data with schema @Data.

${fence('success([Data.is(data), data.doubled(), data.count]);')}`);
        const model = acting(
            action('load_variable', { name: 'Data' }),
            action('save_variable', { name: 'data', value: { count: 15 }, schema: 'Data' }),
        );
        const result = await traced(source, { backend: model }, true);
        expect(result).toMatchObject({ status: 'success', value: [true, 30, 15] });
        expect(await traced(source, {}, true)).toEqual(result);
    });

    it('does not seal cancelled calls as failures, and reclaims a terminated writer lock', async () => {
        const source = "success(await ask('Prompt'));";
        let trace = Trace.open(file, context(source));
        const cancelling = backend(() => {
            trace.cancel();
            throw new LlmError('cancelled provider');
        });
        try {
            await expect(run(parse(source), { backend: cancelling, logger: silent, cwd, trace })).rejects.toThrow(/unusable/);
        } finally { trace.close(); }
        expect(rows().map(row => row.type)).toEqual([undefined, 'intent']);
        const prefix = journal();
        const terminated = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' });
        expect(terminated.status).toBe(0);
        fs.writeFileSync(`${file}.lock`, String(terminated.pid));
        trace = Trace.open(file, context(source));
        try {
            const result = await run(parse(source), { backend: scripted('resumed'), logger: silent, cwd, trace });
            expect(result).toMatchObject({ status: 'success', value: 'resumed' });
            trace.finish(result);
        } finally { trace.close(); }
        expect(journal().startsWith(prefix)).toBe(true);
        expect(fs.existsSync(`${file}.lock`)).toBe(false);
    });

    it('runs native Node.js calls again, and refuses to continue when they change a recorded request', async () => {
        const source = `import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
appendFileSync(join(import.meta.dirname, 'native.log'), 'run\\n');
await writeFile('library.txt', 'written once');
success(await ask(readFileSync(join(import.meta.dirname, 'topic.txt'), 'utf8')));`;
        fs.writeFileSync(path.join(cwd, 'topic.txt'), 'cats');
        const model = scripted('meow');
        const first = await traced(source, { backend: model });
        expect(first).toMatchObject({ status: 'success', value: 'meow' });
        expect(requests().map(request => request.kind)).toEqual(['tool', 'llm']);
        fs.unlinkSync(path.join(cwd, 'library.txt'));
        expect(await traced(source)).toEqual(first);
        expect(fs.readFileSync(path.join(cwd, 'native.log'), 'utf8')).toBe('run\nrun\n');
        expect(fs.existsSync(path.join(cwd, 'library.txt'))).toBe(false);
        const complete = journal();
        fs.writeFileSync(path.join(cwd, 'topic.txt'), 'dogs');
        await expect(traced(source, { backend: model })).rejects.toThrow(/history mismatch/);
        expect(model.calls).toHaveLength(1);
        expect(journal()).toBe(complete);
    });

    it('records library calls made outside a workflow through the configured trace', async () => {
        const model = scripted('hello');
        let trace = Trace.open(file, context('library'));
        try {
            configure({ backend: model, logLevel: 'silent', cwd, trace });
            expect(await ask('Hi')).toBe('hello');
        } finally { trace.close(); }
        expect(requests()).toMatchObject([{ kind: 'llm', request: { kind: 'ask', prompt: 'Hi' } }]);
        trace = Trace.open(file, context('library'));
        try {
            configure({ backend: new NoLlm(), logLevel: 'silent', cwd, trace });
            expect(await ask('Hi')).toBe('hello');
        } finally { trace.close(); }
        expect(model.calls).toHaveLength(1);
        expect(rows()).toHaveLength(3);
    });
});

describe('trace guards', () => {
    it('supports exact bigint completion and source, runtime, cwd, configuration and argument guards', async () => {
        const source = 'const exact = 123456789012345678901234567890n;\nsuccess(exact);';
        const first = await traced(source);
        expect(first).toEqual({ status: 'success', value: 123456789012345678901234567890n, hasValue: true });
        expect(rows().at(-1)).toEqual({ type: 'terminal', result: '{"hasValue":true,"status":"success","value":123456789012345678901234567890n}' });
        expect(await traced(source)).toEqual(first);
        const original = journal();
        const changes: [Partial<TraceContext>, RegExp][] = [
            [{ source: 'changed' }, /trace source mismatch/], [{ runtime: 'changed' }, /trace runtime mismatch/],
            [{ cwd: tempDir() }, /trace cwd mismatch/], [{ configuration: { model: 'changed' } }, /trace configuration mismatch/],
            [{ args: ['changed'] }, /trace script arguments mismatch/],
        ];
        for (const [change, message] of changes) {
            expect(() => Trace.open(file, { ...context(source), ...change })).toThrow(message);
        }
        Trace.open(file, { ...context(source.replace(/\n/g, '\r\n')), args: [], configuration: null }).close();
        expect(fs.existsSync(`${file}.lock`)).toBe(false);
        expect(journal()).toBe(original);
    });

    it('refuses variable stores and workflows or arguments other than the traced ones', async () => {
        const source = 'success(args);';
        const options = { backend: new NoLlm(), logger: silent, cwd };
        const trace = Trace.open(file, { ...context(source), args: ['traced'] });
        try {
            const save = vi.fn();
            await expect(run(parse(source), { ...options, trace, store: { load: () => ({}), save } })).rejects.toThrow(/trace runs cannot use a variable store/);
            expect(save).not.toHaveBeenCalled();
            await expect(run(parse('success(1);'), { ...options, trace })).rejects.toThrow(/trace source mismatch/);
            await expect(run(parse(source), { ...options, trace, args: ['other'] })).rejects.toThrow(/trace script arguments mismatch/);
            expect(await run(parse(source), { ...options, trace, args: ['traced'] })).toMatchObject({ status: 'success', value: ['traced'] });
        } finally { trace.close(); }
        expect(rows()).toHaveLength(1);
    });

    it('guards mismatched effects, unused history and terminal results without modifying completed traces', async () => {
        const source = "success(await ask('Prompt'));";
        await traced(source, { backend: scripted('answer') });
        const original = journal();
        const trace = Trace.open(file, context(source));
        try {
            await expect(trace.effect({ kind: 'unexpected' }, () => 'unused', (value): value is string => typeof value === 'string'))
                .rejects.toThrow(/history mismatch/);
            expect(() => trace.assertConsumed()).toThrow(/unused history/);
            expect(() => trace.finish({ status: 'success', value: 'answer', hasValue: true })).toThrow(/unused history/);
            await run(parse(source), { backend: new NoLlm(), logger: silent, cwd, trace });
            expect(() => trace.assertConsumed()).not.toThrow();
            expect(() => trace.finish({ status: 'success', value: 'wrong', hasValue: true })).toThrow(/completion mismatch/);
            trace.finish({ status: 'success', value: 'answer', hasValue: true });
            expect(() => trace.finish({ status: 'success', value: 'answer', hasValue: true })).toThrow(/closed or unusable/);
        } finally { trace.close(); }
        expect(journal()).toBe(original);
    });

    it('fails a run that leaves recorded effects unused, whatever its result', async () => {
        const source = "if (args[0] !== 'skip') await ask('Prompt');\nsuccess('done');";
        const trace = Trace.open(file, { ...context(source), args: ['skip'] });
        trace.close();
        const header = rows()[0];
        fs.unlinkSync(file);
        await traced(source, { backend: scripted('answer') });
        const complete = rows();
        fs.writeFileSync(file, [header, ...complete.slice(1)].map(row => JSON.stringify(row)).join('\n') + '\n');
        const original = journal();
        await expect(traced(source)).rejects.toThrow(/unused history/);
        expect(journal()).toBe(original);
    });

    it('never falls back to a live agent when a completed trace is missing its runtime decisions', async () => {
        const source = document('> Act.');
        await traced(source, { backend: scripted('Done') }, true);
        expect(rows().map(row => row.type)).toEqual([undefined, 'intent', 'outcome', 'terminal']);
        keepRows(0, -1);
        const original = journal();
        const model = scripted('must never be used');
        await expect(traced(source, { backend: model }, true)).rejects.toThrow(/history mismatch/);
        expect(model.calls).toEqual([]);
        expect(journal()).toBe(original);
    });

    it('rejects concurrent writers and malformed or truncated files without rewriting bytes', () => {
        const source = 'success();';
        const trace = Trace.open(file, context(source));
        expect(() => Trace.open(file, context(source))).toThrow(/another trace writer/);
        expect(fs.readFileSync(`${file}.lock`, 'utf8')).toBe(String(process.pid));
        trace.close();
        trace.close();
        const header = journal();
        const intent = JSON.stringify({ type: 'intent', sequence: 0, request: '{}' }) + '\n';
        const outcome = JSON.stringify({ type: 'outcome', sequence: 0, outcome: { value: 1 } }) + '\n';
        const terminal = JSON.stringify({ type: 'terminal', result: 'null' }) + '\n';
        for (const invalid of [
            '', '{broken\n', header + '{broken', header + '{}\n', '{"format":"spl-trace","version":1}\n',
            header + outcome, header + intent + intent, header + intent.replace('0', '1'), header + intent + outcome.replace('0', '1'),
            header + terminal + intent, header + intent + terminal,
            header + JSON.stringify({ type: 'outcome', sequence: 0, outcome: { value: 1, error: { status_code: 'llm_error', reason: 'x' } } }) + '\n',
            header + intent + JSON.stringify({ type: 'outcome', sequence: 0, outcome: { error: { status_code: 'unknown', reason: 'x' } } }) + '\n',
            header + '{"type":"environment","value":{}}\n{"type":"environment","value":{}}\n',
            header + '{"type":"environment","value":{"A":1}}\n',
        ]) {
            fs.writeFileSync(file, invalid);
            expect(() => Trace.open(file, context(source)), invalid).toThrow(TraceError);
            expect(journal()).toBe(invalid);
            expect(fs.existsSync(`${file}.lock`)).toBe(false);
        }
    });
});

describe('human input', () => {
    it('passes exact answers through, and rejects answers that are not text', async () => {
        const human = vi.fn((): string => '  exact\nanswer  ');
        expect(await exec("\nsuccess(await human('Question'));", { human })).toEqual({ status: 'success', value: '  exact\nanswer  ', hasValue: true });
        expect(human).toHaveBeenCalledExactlyOnceWith('Question', 2);
        expect(await exec("await human('Question');", { human: () => 42 as never })).toMatchObject({
            status: 'failure', failure: { status_code: 'runtime_error', reason: 'human answer must be a string', line: 1 },
        });
    });

    it('validates the question and the presence of a handler before journaling', async () => {
        const human = vi.fn(() => 'unused');
        expect(await traced('await human(42);', { human })).toMatchObject({ status: 'failure', failure: { reason: 'human question must be a string' } });
        expect(human).not.toHaveBeenCalled();
        expect(requests()).toEqual([]);
        fs.unlinkSync(file);
        const source = "let code;\ntry { await human('Question'); } catch (error) { code = error.statusCode; }\nsuccess(code);";
        expect(await traced(source)).toMatchObject({ status: 'success', value: 'runtime_error' });
        expect(requests()).toEqual([]);
    });

    it('reports unexpected handler errors as runtime failures, and as an interrupted effect under a trace', async () => {
        const human = (): string => { throw new Error('input unavailable'); };
        expect(await exec("await human('Question');", { human })).toMatchObject({
            status: 'failure', failure: { status_code: 'runtime_error', reason: 'Error: input unavailable' },
        });
        const error = await traced("await human('Question');", { human }).catch(caught => caught);
        expect(error).toBeInstanceOf(TraceError);
        expect(error).toMatchObject({ kind: 'infrastructure', message: 'trace effect interrupted: input unavailable' });
        expect(rows().map(row => row.type)).toEqual([undefined, 'intent']);
    });
});
