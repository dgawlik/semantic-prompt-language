import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ask, configure } from '../src/index.js';
import { LlmError, type LlmBackend, type LlmRequest, type LlmResponse, type RuntimeAction } from '../src/llm.js';
import { Logger } from '../src/logger.js';
import type { ModelStreamEvent } from '../src/log-events.js';
import { setAmbient } from '../src/runtime.js';
import { ToolHost } from '../src/tools.js';
import { Trace, TraceError, type TraceContext } from '../src/trace.js';
import { traceHtml, tracePaths } from '../src/trace-html.js';
import { run, type RunOptions, type RunResult } from '../src/workflow.js';
import { NoLlm, acting, action, agentBlock, backend, block, cleanTemp, exec, save, scripted, silent, tempDir } from './helpers.js';

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
/** Recorded effect outcomes, in order. */
const outcomes = (): any[] => rows().filter(row => row.type === 'outcome').map(row => row.outcome);
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

/** An agent that continues after the completed actions its prompt lists, as a model does when a block resumes. */
function resuming(...actions: (RuntimeAction | ((results: unknown[]) => RuntimeAction))[]): (request: LlmRequest) => Promise<LlmResponse> {
    const marker = 'Completed actions and their results:\n';
    return async request => {
        const history = JSON.parse(request.prompt.slice(request.prompt.lastIndexOf(marker) + marker.length)) as { result: { value: unknown } }[];
        const results = history.map(entry => entry.result.value);
        for (const next of actions.slice(results.length)) results.push(await request.invokeAction!(typeof next === 'function' ? next(results) : next));
        return { text: 'Done.', effective: {} };
    };
}

/** Runs a workflow with the trace file, sealing the result like the CLI does. */
async function traced(source: string, options: Partial<RunOptions> = {}): Promise<RunResult> {
    const trace = Trace.open(file, context(source));
    try {
        const result = await run(source, { backend: new NoLlm(), logger: silent, cwd, ...options, trace });
        trace.finish(result);
        return result;
    } finally {
        trace.close();
    }
}

describe('trace journal', () => {
    it('records library effects in execution order, with their guidance and restrictions', async () => {
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
            { kind: 'tool', tool: 'writeFile', params: { path: './out/note.txt', content: 'draft' }, restrictions: out },
            { kind: 'tool', tool: 'readFile', params: { path: './out/note.txt' }, restrictions: out },
            { kind: 'llm', restrictions: [], request: {
                kind: 'ask', model: null, reasoningEffort: null, showReasoning: true,
                prompt: 'Response guidance (not runtime validation):\n- Follow: Be brief\n\nAnswer with a single word.\n\nTitle for draft',
            } },
            { kind: 'human', question: 'Publish?' },
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

    it('journals every decision of an agent block with the history that preceded it, not the model call', async () => {
        const instruction = 'Save a greeting -> @greeting, then ask for approval.';
        const source = agentBlock(instruction);
        const greeting = save('greeting', 'hi');
        const question = action('askHuman', { question: 'ok?' });
        const model = acting(greeting, question);
        expect(await traced(source, { backend: model, human: () => 'sure' })).toMatchObject({ status: 'success', hasValue: false });
        expect(model.calls).toHaveLength(1);
        const recorded = requests();
        expect(recorded.map(request => request.kind)).toEqual(['agent-block', 'agent-block', 'human', 'agent-block']);
        expect(recorded[0]).toEqual({ kind: 'agent-block', text: instruction, line: 1, history: '[]', restrictions: [] });
        expect(recorded[2]).toEqual({ kind: 'human', question: 'ok?' });
        const saved = { action: greeting, result: { value: 'hi' } };
        expect(recorded.filter(request => request.kind === 'agent-block').map(request => JSON.parse(request.history))).toEqual([
            [], [saved], [saved, { action: question, result: { value: 'sure' } }],
        ]);
        expect(outcomes().map(outcome => outcome.value)).toEqual([
            { text: 'Action.', effective: {}, action: greeting },
            { text: 'Action.', effective: {}, action: question },
            'sure',
            { text: 'Done.', effective: {} },
        ]);
    });

    it('journals an ask block as its model calls and a codegen block as one effect', async () => {
        const code = "function slugify(text) {\n    return text.toLowerCase().replace(/ /g, '-');\n}";
        const source = [
            block('Slug of a title -> @slugify(text: string): string', 'mode: codegen', 'model: code-model'),
            "const title = 'Hello World';",
            block('Rate @title', 'outputVar: stars', 'outputType: Int', 'model: ask-model', 'reasoning: low', 'tokens: 64', 'seed: 7', 'repairs: 1', 'hide: true', 'enforce: Be strict'),
            'success([slugify(title), stars]);',
        ].join('\n');
        const model = scripted(`\`\`\`js\n${code}\n\`\`\``, 'five', '5');
        const result = await traced(source, { backend: model });
        expect(result).toEqual({ status: 'success', value: ['hello-world', 5], hasValue: true });
        const request = {
            kind: 'ask', model: 'ask-model', reasoningEffort: 'low', showReasoning: false, randomness: { seed: 7 }, tokens: 64,
            prompt: 'Response guidance (not runtime validation):\n- Follow: Be strict\n\nRate @title\n\nValues referenced above, as JSON:\n@title = "Hello World"\n\n'
                + 'Return ONLY valid JSON, without prose or code fences.\n\nThe result must satisfy this JSON Schema:\n{"type":"integer"}',
        };
        expect(requests()).toEqual([
            { kind: 'codegen', text: 'Slug of a title -> @slugify(text: string): string', line: 1 },
            { kind: 'llm', restrictions: [], request },
            { kind: 'llm', restrictions: [], request: { ...request, prompt: model.calls[2].prompt } },
        ]);
        expect(model.calls[2].prompt).toContain(`${request.prompt}\n\nPrevious response:\nfive\n\nValidation failed: LLM response is not valid JSON`);
        expect(outcomes()).toEqual([
            { value: { text: expect.stringMatching(/^\/\/ @CODEGEN sha256:[0-9a-f]{64}\nfunction slugify\(text\) \{\n[^`]+\n\}\n$/) } },
            { value: { text: 'five', effective: {} } },
            { value: { text: '5', effective: {} } },
        ]);
        const complete = journal();
        expect(await traced(source)).toEqual(result);
        expect(journal()).toBe(complete);
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
        let trace = Trace.open(file, { ...context(source), args: ['initial'] });
        let first: RunResult;
        try {
            first = await run(source, { backend: model, human, logger: silent, cwd, trace });
            trace.finish(first);
        } finally { trace.close(); }
        expect(first).toEqual({ status: 'success', hasValue: true, value: [
            Array(5).fill('raw result'), 42, 'agent result', '  exact\nanswer  ', ['initial'], 'original', null,
        ] });
        expect(tools.mock.calls.map(([tool]) => tool)).toEqual(['readFile', 'writeFile', 'shell', 'webFetch', 'webSearch']);
        const original = journal();
        vi.stubEnv('SPL_TRACE_TEST', 'changed');
        vi.stubEnv('SPL_TRACE_ADDED', 'new');
        tools.mockClear();
        human.mockClear();
        trace = Trace.open(file, context(source));
        try {
            expect(await run(source, { backend: new NoLlm(), human, logger: silent, cwd, trace })).toEqual(first);
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
            await request.tools.invoke('writeFile', { path: 'agent.txt', content: 'original' });
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
        ['writeFile', "await writeFile('output.txt', 'text');"],
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

    it('resumes the actions of an agent block inside functions without repeating writes, generation or shared mutations', async () => {
        const instruction = 'Invoke @approve, save the result -> @answer, and finish.';
        const source = `let count = 0;
async function approve() {
    count += 1;
    await writeFile('draft.txt', 'original');
    return [await ask('Number?', { fmt: 'integer', repairs: 1 }), await human('Approve?')];
}
${agentBlock(instruction, 'restrict: { fs: ["."] }', 'enforce: Be precise', 'model: block-model', 'reasoning: high')}
success([count, answer]);`;
        const tools = vi.spyOn(ToolHost.prototype, 'invoke').mockResolvedValue('written');
        let generations = 0;
        const interrupted = backend(async request => {
            if (!request.runtimeTools) return { text: generations++ === 0 ? 'bad JSON' : '9', effective: {} };
            const value = await request.invokeAction!(action('callFunction', { name: 'approve', args: [] }));
            await request.invokeAction!(save('answer', value));
            return { text: 'Done', effective: {} };
        });
        await expect(traced(source, { backend: interrupted, human: () => { throw new Error('interrupted'); } })).rejects.toThrow(/interrupted/);
        const prefix = journal();
        expect(requests().map(request => request.kind)).toEqual(['restriction', 'agent-block', 'tool', 'llm', 'llm', 'human']);
        expect(requests()[1]).toEqual({ kind: 'agent-block', text: instruction, line: 7, history: '[]', restrictions: [{ kind: 'fs', values: [cwd] }] });
        expect(requests()[3].request).toMatchObject({ kind: 'ask', model: null, prompt: expect.stringContaining('- Follow: Be precise') });
        const resumed: LlmRequest[] = [];
        const continued = backend(async request => {
            resumed.push(request);
            await request.invokeAction!(save('answer', [9, 'approved']));
            return { text: 'Done', effective: {} };
        });
        const result = await traced(source, { backend: continued, human: () => 'approved' });
        expect(result).toMatchObject({ status: 'success', value: [1, [9, 'approved']] });
        expect(resumed).toHaveLength(1);
        expect(resumed[0]).toMatchObject({ kind: 'agent', model: 'block-model', reasoningEffort: 'high' });
        expect(resumed[0].prompt).toContain('"value":[9,"approved"]');
        expect(tools).toHaveBeenCalledOnce();
        expect(generations).toBe(2);
        expect(journal().startsWith(prefix)).toBe(true);
        expect(await traced(source)).toEqual(result);
        expect(tools).toHaveBeenCalledOnce();
    });

    it.each([
        [action('callFunction', { name: 'finish', args: [9] }), { status: 'success', value: 9 }],
        [action('callFunction', { name: 'stop', args: [] }), { status: 'failure', failure: { status_code: 'explicit_failure', reason: 'stop', line: 2 } }],
        [action('callFunction', { name: 'missing', args: [] }), { status: 'failure', failure: { status_code: 'runtime_error', line: 3 } }],
        [action('readFile', { path: './out/missing.txt' }), { status: 'failure', failure: { status_code: 'tool_error', line: 3 } }],
        [action('readFile', { path: './secret.txt' }), { status: 'failure', failure: { status_code: 'restriction_violation', line: 3 } }],
        [save('other', 1), { status: 'failure', failure: { status_code: 'runtime_error', line: 3 } }],
    ])('replays the action of an agent block that ends the run at once: %j', async (terminating, expected) => {
        fs.mkdirSync(path.join(cwd, 'out'));
        fs.writeFileSync(path.join(cwd, 'secret.txt'), 'hidden');
        const source = [
            'function finish(value: number) { success(value); }', "function stop() { fail('stop'); }",
            agentBlock('Act with @finish or @stop -> @x', 'restrict: { fs: ./out }'),
        ].join('\n');
        const model = acting(terminating, save('x', 'must not be reached'));
        const first = await traced(source, { backend: model });
        expect(first).toMatchObject(expected);
        expect(model.results).toEqual([]);
        const complete = journal();
        expect(await traced(source)).toEqual(first);
        expect(journal()).toBe(complete);
    });

    it('records a failed model call of an agent block as a durable decision, after the actions before it', async () => {
        const source = `${agentBlock('Act.')}\n\nfail('unreachable');`;
        const model = reasoned(new LlmError('provider down'));
        const first = await traced(source, { backend: model });
        expect(first).toMatchObject({ status: 'failure', failure: { status_code: 'llm_error', reason: 'provider down', line: 1, command: 'Act.' } });
        expect(rows()[2].outcome).toEqual({ error: { status_code: 'llm_error', reason: 'provider down' } });
        expect(await traced(source)).toEqual(first);
        expect(model.calls).toHaveLength(1);

        fs.unlinkSync(file);
        const counting = ['let calls = 0;', 'function bump() { return ++calls; }', agentBlock('Call @bump twice -> @x'), 'success(x);'].join('\n');
        let attempts = 0;
        const dropped = backend(async request => {
            attempts++;
            await request.invokeAction!(action('callFunction', { name: 'bump', args: [] }));
            throw new LlmError('stream closed');
        });
        const second = await traced(counting, { backend: dropped });
        expect(second).toMatchObject({ status: 'failure', failure: { status_code: 'llm_error', reason: 'stream closed', line: 3, command: 'Call @bump twice -> @x' } });
        expect(outcomes()).toEqual([
            { value: { text: 'Action.', effective: {}, action: action('callFunction', { name: 'bump', args: [] }) } },
            { error: { status_code: 'llm_error', reason: 'stream closed' } },
        ]);
        expect(JSON.parse(requests()[1].history)).toEqual([{ action: action('callFunction', { name: 'bump', args: [] }), result: { value: 1 } }]);
        expect(await traced(counting, { backend: dropped })).toEqual(second);
        expect(attempts).toBe(1);
    });

    it('records only requested agent environment values and replays them after changes', async () => {
        vi.stubEnv('SPL_AGENT_PRIVATE', 'do-not-include');
        vi.stubEnv('SPL_AGENT_PUBLIC', 'original');
        const source = `${agentBlock('Return the configured environment value -> @values')}\nsuccess(values);`;
        const model = acting(
            action('getEnv', { name: 'SPL_AGENT_PUBLIC' }),
            action('getEnv', { name: 'SPL_AGENT_MISSING' }),
            results => save('values', [...results]),
        );
        const first = await traced(source, { backend: model });
        expect(first).toMatchObject({ status: 'success', value: ['original', null] });
        expect(journal()).not.toContain('do-not-include');
        expect(rows().some(row => row.type === 'environment')).toBe(false);
        expect(requests().filter(request => request.kind !== 'agent-block')).toEqual([
            { kind: 'environment-value', name: 'SPL_AGENT_PUBLIC' }, { kind: 'environment-value', name: 'SPL_AGENT_MISSING' },
        ]);
        vi.stubEnv('SPL_AGENT_PUBLIC', 'changed');
        vi.stubEnv('SPL_AGENT_MISSING', 'now set');
        expect(await traced(source)).toEqual(first);
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

    it('snapshots the environment for @env references of a block, and replays it after changes', async () => {
        vi.stubEnv('SPL_TRACE_TEST', 'original');
        const source = `${block('Greet @env.SPL_TRACE_TEST and @env.SPL_TRACE_LATER', 'outputVar: greeting')}\nsuccess(greeting);`;
        const model = scripted('Hello.');
        const first = await traced(source, { backend: model });
        expect(first).toMatchObject({ status: 'success', value: 'Hello.' });
        expect(model.calls[0].prompt).toContain('@env.SPL_TRACE_TEST = "original"\n@env.SPL_TRACE_LATER = null');
        expect(rows().map(row => row.type)).toEqual([undefined, 'environment', 'intent', 'outcome', 'terminal']);
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

    it('replays the typed, hydrated outputs of an agent block', async () => {
        const source = `const Data = Struct('Data', { count: Int }).methods({ doubled() { return this.count * 2; } });
${agentBlock('Save some @Data ->[Data] @data')}
success([Data.is(data), data.doubled(), data.count]);`;
        const model = acting(
            action('loadVariable', { name: 'Data' }),
            save('data', { count: '15' }),
        );
        const result = await traced(source, { backend: model });
        expect(result).toMatchObject({ status: 'success', value: [true, 30, 15] });
        expect(model.results[1]).toEqual({ count: 15 });
        expect(await traced(source)).toEqual(result);
    });

    it('does not seal cancelled calls as failures, and reclaims a terminated writer lock', async () => {
        const source = "success(await ask('Prompt'));";
        let trace = Trace.open(file, context(source));
        const cancelling = backend(() => {
            trace.cancel();
            throw new LlmError('cancelled provider');
        });
        try {
            await expect(run(source, { backend: cancelling, logger: silent, cwd, trace })).rejects.toThrow(/unusable/);
        } finally { trace.close(); }
        expect(rows().map(row => row.type)).toEqual([undefined, 'intent']);
        const prefix = journal();
        const terminated = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' });
        expect(terminated.status).toBe(0);
        fs.writeFileSync(`${file}.lock`, String(terminated.pid));
        trace = Trace.open(file, context(source));
        try {
            const result = await run(source, { backend: scripted('resumed'), logger: silent, cwd, trace });
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

describe('blocks under a trace', () => {
    it('resumes from every prefix of a journal of codegen, ask and agent blocks', async () => {
        const tools = vi.spyOn(ToolHost.prototype, 'invoke').mockResolvedValue('written');
        const source = [
            'let calls = 0;',
            'function twice(n: number): number {', '    calls++;', '    return n * 2;', '}',
            block('Add one to a number -> @increment(n: number): number', 'mode: codegen'),
            block('Pick a number', 'outputVar: seed', 'outputType: Int'),
            agentBlock('Double @seed with @twice ->[Int] @doubled, keep it in a file and describe it -> @note', 'restrict: { fs: . }'),
            block('Sum up @note', 'outputVar: summary'),
            'success({ seed, doubled, note, summary, next: increment(doubled), calls });',
        ].join('\n');
        const agent = resuming(
            action('loadVariable', { name: 'seed' }),
            results => action('callFunction', { name: 'twice', args: [results[0]] }),
            results => action('writeFile', { path: 'doubled.txt', content: String(results[1]) }),
            results => save('doubled', String(results[1])),
            save('note', 'twice as much'),
        );
        const asked: string[] = [];
        const model = backend(request => {
            const generating = request.prompt.includes('Function description:');
            asked.push(request.runtimeTools ? 'agent' : generating ? 'codegen' : request.prompt.split('\n')[0]);
            if (request.runtimeTools) return agent(request);
            if (generating) return { text: 'function increment(n) {\n    return n + 1;\n}', effective: {} };
            return { text: request.prompt.startsWith('Pick') ? '21.0' : 'Forty-two.', effective: {} };
        });
        const first = await traced(source, { backend: model });
        expect(first).toEqual({ status: 'success', hasValue: true, value: { seed: 21, doubled: 42, note: 'twice as much', summary: 'Forty-two.', next: 43, calls: 1 } });
        const kinds = ['codegen', 'llm', 'restriction', 'agent-block', 'agent-block', 'agent-block', 'tool', 'agent-block', 'agent-block', 'agent-block', 'llm'];
        expect(requests().map(request => request.kind)).toEqual(kinds);
        expect(asked).toEqual(['codegen', 'Pick a number', 'agent', 'Sum up @note']);
        const complete = journal();
        const lines = complete.trimEnd().split('\n');
        expect(lines).toHaveLength(2 + 2 * kinds.length);
        for (let count = 1; count < lines.length; count++) {
            fs.writeFileSync(file, lines.slice(0, count).join('\n') + '\n');
            tools.mockClear();
            asked.length = 0;
            // Effects with an outcome in the prefix, and whether it ends inside one.
            const done = Math.floor((count - 1) / 2);
            const pending = count % 2 === 0;
            if (pending && kinds[done] === 'tool') {
                await expect(traced(source, { backend: model }), `${count} rows`).rejects.toThrow(/unresolved effect.*manual recovery/);
                expect(journal(), `${count} rows`).toBe(lines.slice(0, count).join('\n') + '\n');
                expect(asked).toEqual([]);
                expect(tools).not.toHaveBeenCalled();
                continue;
            }
            expect(await traced(source, { backend: model }), `${count} rows`).toEqual(first);
            expect(journal(), `${count} rows`).toBe(complete);
            // Only what the prefix does not hold is done again: the model calls and the write.
            expect(asked, `${count} rows`).toEqual([
                ...(done < 1 ? ['codegen'] : []), ...(done < 2 ? ['Pick a number'] : []),
                ...(done < kinds.lastIndexOf('agent-block') + 1 ? ['agent'] : []), ...(done < kinds.length ? ['Sum up @note'] : []),
            ]);
            expect(tools, `${count} rows`).toHaveBeenCalledTimes(done <= kinds.indexOf('tool') ? 1 : 0);
        }
    });

    it('replays the answer of an ask block through its type, and resumes between its repairs', async () => {
        const source = [
            "const Verdict = Struct('Verdict', { stars: Int, tags: List(Str) }).methods({",
            "    label() { return `${this.stars}/5 ${this.tags.join('+')}`; },",
            '});',
            block('Judge it', 'outputVar: verdict', 'outputType: Verdict', 'repairs: 2'),
            'success([verdict.label(), Verdict.is(verdict)]);',
        ].join('\n');
        const replies = ['nonsense', '{"stars":"4.5","tags":[]}', '```json\n{"stars":"4","tags":["a",1]}\n```'];
        const model = scripted(...replies);
        const first = await traced(source, { backend: model });
        expect(first).toMatchObject({ status: 'success', value: ['4/5 a+1', true] });
        expect(requests().map(request => request.kind)).toEqual(['llm', 'llm', 'llm']);
        expect(requests()[2].request.prompt).toContain('Previous response:\n{"stars":"4.5","tags":[]}\n\nValidation failed: $.stars: expected Int, got 4.5');
        // The journal holds the replies as given: the type is applied again on replay.
        expect(outcomes().map(outcome => outcome.value.text)).toEqual(replies);
        const complete = journal();
        expect(await traced(source)).toEqual(first);
        expect(journal()).toBe(complete);
        firstRows(4);
        const resumed = scripted('{"stars":5.0,"tags":"[]"}');
        expect(await traced(source, { backend: resumed })).toMatchObject({ status: 'success', value: ['5/5 ', true] });
        expect(resumed.calls.map(call => call.prompt)).toEqual([model.calls[1].prompt]);
        expect(rows().map(row => row.type)).toEqual([undefined, 'intent', 'outcome', 'intent', 'outcome', 'terminal']);
        // A block that ran out of repairs failed for good.
        fs.unlinkSync(file);
        const stubborn = scripted('1', '2', '3');
        const failed = await traced(source, { backend: stubborn });
        expect(failed).toMatchObject({ status: 'failure', failure: { status_code: 'validation_failed', reason: '$: expected Verdict, got 3', line: 4, command: 'Judge it' } });
        expect(await traced(source, { backend: stubborn })).toEqual(failed);
        expect(stubborn.calls).toHaveLength(3);
    });

    it('refuses to continue when an input of an ask block is not what the journal recorded', async () => {
        const source = [
            "import { readFileSync } from 'node:fs';",
            "import { join } from 'node:path';",
            "const topic = readFileSync(join(import.meta.dirname, 'topic.txt'), 'utf8');",
            block('Title for @topic', 'outputVar: title'),
            block('Subtitle for @title', 'outputVar: subtitle'),
            'success([title, subtitle]);',
        ].join('\n');
        const topic = path.join(cwd, 'topic.txt');
        fs.writeFileSync(topic, 'cats');
        const first = await traced(source, { backend: scripted('Cats', 'Purring') });
        expect(first).toMatchObject({ status: 'success', value: ['Cats', 'Purring'] });
        const complete = journal();
        fs.writeFileSync(topic, 'dogs');
        const model = scripted('Dogs', 'Barking');
        await expect(traced(source, { backend: model })).rejects.toThrow(/history mismatch/);
        expect(journal()).toBe(complete);
        // Neither is an interrupted call retried with another prompt.
        firstRows(2);
        const prefix = journal();
        await expect(traced(source, { backend: model })).rejects.toThrow(/history mismatch/);
        expect(journal()).toBe(prefix);
        expect(model.calls).toEqual([]);
        fs.writeFileSync(topic, 'cats');
        expect(await traced(source, { backend: scripted('Felines', 'Purring again') })).toMatchObject({ status: 'success', value: ['Felines', 'Purring again'] });
        expect(journal().startsWith(prefix)).toBe(true);
    });

    it('refuses to continue an agent block when a function gives it another result than the journal recorded', async () => {
        const source = [
            "import { readFileSync } from 'node:fs';",
            "import { join } from 'node:path';",
            "const stock = (): number => Number(readFileSync(join(import.meta.dirname, 'stock.txt'), 'utf8'));",
            agentBlock('Read @stock and double it ->[Int] @doubled'),
            'success(doubled);',
        ].join('\n');
        const stock = path.join(cwd, 'stock.txt');
        const asked: string[] = [];
        const agent = resuming(action('callFunction', { name: 'stock', args: [] }), results => save('doubled', Number(results[0]) * 2));
        const model = backend(request => {
            asked.push(request.prompt);
            return agent(request);
        });
        fs.writeFileSync(stock, '4');
        const first = await traced(source, { backend: model });
        expect(first).toMatchObject({ status: 'success', value: 8 });
        expect(requests().map(request => JSON.parse(request.history).length)).toEqual([0, 1, 2]);
        const complete = journal();
        asked.length = 0;
        // A finished journal: the second decision was made knowing 4, not 5.
        fs.writeFileSync(stock, '5');
        await expect(traced(source, { backend: model })).rejects.toThrow(/history mismatch/);
        expect(journal()).toBe(complete);
        // An interrupted journal: the model was asked what to do after 4, and that question cannot be asked again after 5.
        firstRows(4);
        const prefix = journal();
        await expect(traced(source, { backend: model })).rejects.toThrow(/history mismatch; cannot continue with live work/);
        expect(journal()).toBe(prefix);
        expect(asked).toEqual([]);
        // With the recorded result, the block continues where it stopped.
        fs.writeFileSync(stock, '4');
        expect(await traced(source, { backend: model })).toEqual(first);
        expect(journal()).toBe(complete);
        expect(asked).toHaveLength(1);
        expect(asked[0]).toContain('"result":{"value":4}');
    });

    it('journals what an agent block does to the outside world with its restrictions, and replays it without touching anything', async () => {
        fs.mkdirSync(path.join(cwd, 'out'));
        fs.writeFileSync(path.join(cwd, 'out', 'input.txt'), 'draft');
        const source = `${agentBlock('Copy the input in upper case -> @copied', 'restrict: { fs: ./out, exec: node }')}\nsuccess(copied);`;
        const command = 'node -e "console.log(6 * 7)"';
        const agent = acting(
            action('readFile', { path: './out/input.txt' }),
            results => action('writeFile', { path: './out/copy.txt', content: String(results[0]).toUpperCase() }),
            action('readFile', { path: './out/copy.txt' }),
            action('shell', { command }),
            results => save('copied', [results[2], String(results[3]).trim()]),
        );
        const first = await traced(source, { backend: agent });
        expect(first).toMatchObject({ status: 'success', value: ['DRAFT', '42'] });
        const limits = [{ kind: 'fs', values: [path.join(cwd, 'out')] }, { kind: 'exec', values: ['node'] }];
        expect(requests().filter(request => request.kind !== 'agent-block')).toEqual([
            { kind: 'restriction', restriction: 'fs', value: './out' },
            { kind: 'restriction', restriction: 'exec', value: 'node' },
            { kind: 'tool', tool: 'readFile', params: { path: './out/input.txt' }, restrictions: limits },
            { kind: 'tool', tool: 'writeFile', params: { path: './out/copy.txt', content: 'DRAFT' }, restrictions: limits },
            { kind: 'tool', tool: 'readFile', params: { path: './out/copy.txt' }, restrictions: limits },
            { kind: 'tool', tool: 'shell', params: { command }, restrictions: limits },
        ]);
        for (const request of requests().filter(request => request.kind === 'agent-block')) expect(request.restrictions).toEqual(limits);
        const complete = journal();
        fs.rmSync(path.join(cwd, 'out'), { recursive: true });
        const tools = vi.spyOn(ToolHost.prototype, 'invoke');
        expect(await traced(source)).toEqual(first);
        expect(tools).not.toHaveBeenCalled();
        expect(fs.existsSync(path.join(cwd, 'out'))).toBe(false);
        expect(journal()).toBe(complete);
        // A write or a command with an unknown outcome is never repeated; a read is.
        const intents = rows().flatMap((row, index) => row.type === 'intent' && JSON.parse(row.request).kind === 'tool' ? [index] : []);
        for (const [index, repeatable] of [[intents[1], false], [intents[3], false], [intents[0], true]] as const) {
            fs.writeFileSync(file, complete.split('\n').slice(0, index + 1).join('\n') + '\n');
            const prefix = journal();
            tools.mockClear();
            if (repeatable) {
                fs.mkdirSync(path.join(cwd, 'out'));
                fs.writeFileSync(path.join(cwd, 'out', 'input.txt'), 'second draft');
                const continued = backend(resuming(
                    action('readFile', { path: './out/input.txt' }),
                    results => save('copied', [results[0], 'resumed']),
                ));
                expect(await traced(source, { backend: continued })).toMatchObject({ status: 'success', value: ['second draft', 'resumed'] });
                expect(tools).toHaveBeenCalledOnce();
                expect(journal().startsWith(prefix)).toBe(true);
            } else {
                await expect(traced(source, { backend: agent })).rejects.toThrow(/unresolved effect.*manual recovery/);
                expect(tools).not.toHaveBeenCalled();
                expect(journal()).toBe(prefix);
            }
        }
    });

    it('resumes an agent block inside a function that another agent block called, from every prefix', async () => {
        const source = [
            'async function inner(n: number): Promise<number> {',
            '    ---', '    mode: agent', '', '    Inner: add one to @n ->[Int] @m', '    ---',
            '    return m;',
            '}',
            agentBlock('Outer: call @inner with 1 ->[Int] @x'),
            'success(x);',
        ].join('\n');
        const outer = resuming(action('callFunction', { name: 'inner', args: [1] }), results => save('x', results[0]));
        const inner = resuming(action('loadVariable', { name: 'n' }), results => save('m', Number(results[0]) + 1));
        const asked: string[] = [];
        const model = backend(request => {
            const name = request.prompt.includes('Instruction:\nInner') ? 'inner' : 'outer';
            asked.push(name);
            return name === 'inner' ? inner(request) : outer(request);
        });
        const first = await traced(source, { backend: model });
        expect(first).toMatchObject({ status: 'success', value: 2 });
        expect(requests().map(request => [request.line, JSON.parse(request.history).length])).toEqual([[9, 0], [2, 0], [2, 1], [2, 2], [9, 1], [9, 2]]);
        const complete = journal();
        const lines = complete.trimEnd().split('\n');
        for (let count = 1; count < lines.length; count++) {
            fs.writeFileSync(file, lines.slice(0, count).join('\n') + '\n');
            asked.length = 0;
            expect(await traced(source, { backend: model }), `${count} rows`).toEqual(first);
            expect(journal(), `${count} rows`).toBe(complete);
            // Decisions with an outcome in the prefix: the outer block made 1 before the inner one made 3, then 2 more.
            const done = Math.floor((count - 1) / 2);
            expect(asked, `${count} rows`).toEqual([...(done < 1 ? ['outer'] : []), ...(done < 4 ? ['inner'] : []), ...(done >= 1 && done < 6 ? ['outer'] : [])]);
        }
    });

    it('replays agent blocks that ran concurrently, whichever agent acted first', async () => {
        const source = [
            'async function review(item: string): Promise<string> {',
            '    ---', '    mode: agent', '', '    Review @item -> @verdict', '    ---',
            '    return verdict;',
            '}',
            "success(await Promise.all(['slow', 'fast'].map(item => review(item))));",
        ].join('\n');
        const agent = resuming(action('loadVariable', { name: 'item' }), results => save('verdict', `${results[0]} ok`));
        let calls = 0;
        // The agent of the first block acts only after the agent of the second one has finished.
        const model = backend(async request => {
            if (calls++ === 0) await new Promise(resolve => setTimeout(resolve, 20));
            return agent(request);
        });
        const first = await traced(source, { backend: model });
        expect(first).toMatchObject({ status: 'success', value: ['slow ok', 'fast ok'] });
        const complete = journal();
        expect(await traced(source)).toEqual(first);
        expect(journal()).toBe(complete);
    });

    it('replays rejected saves with their corrections, and the failures of a block, without a model', async () => {
        const source = `${agentBlock('Count ->[Int] @count and name it -> @label')}\nsuccess([count, label]);`;
        const hint = 'Correct the value and save @count again.';
        const first = await traced(source, { backend: acting(save('count', 'three'), save('count', 3.5), save('count', '3'), save('label', 'three')) });
        expect(first).toMatchObject({ status: 'success', value: [3, 'three'] });
        // The rejections are part of what later decisions were based on.
        expect(JSON.parse(requests().at(-1).history).map((entry: { result: { value: unknown } }) => entry.result.value)).toEqual([
            { rejected: 'count: expected Int, got "three"', hint }, { rejected: 'count: expected Int, got 3.5', hint }, 3, 'three',
        ]);
        const complete = journal();
        expect(await traced(source)).toEqual(first);
        expect(journal()).toBe(complete);
        for (const [agent, failure] of [
            [acting(save('count', 'a'), save('count', 'b'), save('count', 'c')), { status_code: 'validation_failed', reason: '@count is still invalid after 2 corrections: count: expected Int, got "c"' }],
            [acting(save('count', 1)), { status_code: 'validation_failed', reason: 'agent did not produce @label' }],
            [acting(), { status_code: 'validation_failed', reason: 'agent did not produce @count' }],
        ] as const) {
            fs.unlinkSync(file);
            const failed = await traced(source, { backend: agent });
            expect(failed).toMatchObject({ status: 'failure', failure: { ...failure, line: 1, command: 'Count ->[Int] @count and name it -> @label' } });
            const sealed = journal();
            expect(await traced(source)).toEqual(failed);
            expect(journal()).toBe(sealed);
        }
    });

    it('replays every run of a block in a loop, with the guidance its agent added, and resumes inside one', async () => {
        const source = [
            'async function describe(item: string): Promise<string> {', '    return ask(`Describe ${item}`);', '}',
            'const notes: string[] = [];',
            "for (const item of ['pear', 'plum']) {",
            '    ---', '    mode: agent', '', '    Describe @item with @describe -> @note', '    ---',
            '    notes.push(note);',
            '}',
            'success(notes);',
        ].join('\n');
        const agent = resuming(
            action('setGuidance', { kind: 'forbid', text: 'slang' }),
            action('loadVariable', { name: 'item' }),
            results => action('callFunction', { name: 'describe', args: [results[1]] }),
            results => save('note', results[2]),
        );
        const described: string[] = [];
        const model = backend(request => {
            if (request.runtimeTools) return agent(request);
            described.push(request.prompt);
            return { text: `A ${request.prompt.split(' ').at(-1)}.`, effective: {} };
        });
        const first = await traced(source, { backend: model });
        expect(first).toMatchObject({ status: 'success', value: ['A pear.', 'A plum.'] });
        const guided = (item: string): string => `Response guidance (not runtime validation):\n- Avoid: slang\n\nDescribe ${item}`;
        expect(described).toEqual([guided('pear'), guided('plum')]);
        const run = ['agent-block', 'agent-block', 'agent-block', 'llm', 'agent-block', 'agent-block'];
        expect(requests().map(request => request.kind)).toEqual([...run, ...run]);
        expect(requests().filter(request => request.kind === 'agent-block').map(request => [request.line, JSON.parse(request.history).length]))
            .toEqual([[6, 0], [6, 1], [6, 2], [6, 3], [6, 4], [6, 0], [6, 1], [6, 2], [6, 3], [6, 4]]);
        const complete = journal();
        expect(await traced(source)).toEqual(first);
        expect(journal()).toBe(complete);
        // Cut inside the second run, where the function was about to ask: the guidance is back before it asks again.
        firstRows(1 + 2 * run.length + 2 * 3 + 1);
        described.length = 0;
        expect(await traced(source, { backend: model })).toEqual(first);
        expect(described).toEqual([guided('plum')]);
        expect(journal()).toBe(complete);
    });

    it('records generated code once, and replays it without the model or the cache', async () => {
        const workflow = path.join(cwd, 'slug.spl');
        const source = [
            "const separator = '-';",
            block('Slug of a title -> @slugify(text: string): string\nwith @separator', 'mode: codegen'),
            "const sieve = await codegen('sieve(n): primes up to n');",
            "success([slugify('Hello World'), sieve(6)]);",
        ].join('\n');
        fs.writeFileSync(workflow, source);
        const slugify = 'function slugify(text) {\n    return text.toLowerCase().split(" ").join(separator);\n}';
        const sieve = 'function sieve(n) {\n    return [2, 3, 5, 7].filter(prime => prime <= n);\n}';
        const caches = [path.join(cwd, 'slug.slugify.js'), path.join(cwd, 'slug.sieve.js')];
        const first = await traced(source, { backend: scripted(slugify, sieve), file: workflow });
        expect(first).toEqual({ status: 'success', value: ['hello-world', [2, 3, 5]], hasValue: true });
        expect(requests()).toEqual([
            { kind: 'codegen', text: 'Slug of a title -> @slugify(text: string): string\nwith @separator', line: 2 },
            { kind: 'codegen', text: 'sieve(n): primes up to n', line: 8 },
        ]);
        expect(outcomes()).toEqual([
            { value: { text: fs.readFileSync(caches[0], 'utf8'), file: caches[0] } },
            { value: { text: fs.readFileSync(caches[1], 'utf8'), file: caches[1] } },
        ]);
        expect(outcomes()[0].value.text).toContain(slugify);
        const complete = journal();
        for (const cache of caches) fs.unlinkSync(cache);
        expect(await traced(source, { file: workflow })).toEqual(first);
        expect(journal()).toBe(complete);
        expect(caches.map(cache => fs.existsSync(cache))).toEqual([false, false]);
        // An interrupted generation is generated again; a finished one is not.
        firstRows(4);
        const prefix = journal();
        const again = scripted(sieve.replace('[2, 3, 5, 7]', '[2, 3, 5, 7, 11]'));
        expect(await traced(source, { backend: again, file: workflow })).toEqual(first);
        expect(again.calls).toHaveLength(1);
        expect(journal().startsWith(prefix)).toBe(true);
        expect(caches.map(cache => fs.existsSync(cache))).toEqual([false, true]);
    });

    it('replays code that could not be generated as the failure it was', async () => {
        const source = `${block('-> @slugify(text: string): string', 'mode: codegen')}\nsuccess(slugify('a'));`;
        const model = scripted('function other() {}');
        const first = await traced(source, { backend: model });
        expect(first).toMatchObject({ status: 'failure', failure: { status_code: 'invalid_format', reason: "codegen did not declare the function 'slugify'", line: 1 } });
        expect(outcomes()).toEqual([{ error: { status_code: 'invalid_format', reason: "codegen did not declare the function 'slugify'" } }]);
        expect(await traced(source, { backend: model })).toEqual(first);
        expect(model.calls).toHaveLength(1);
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

    it('refuses workflows or arguments other than the traced ones, and runs with the traced arguments', async () => {
        const source = 'success(args);';
        const options = { backend: new NoLlm(), logger: silent, cwd };
        const trace = Trace.open(file, { ...context(source), args: ['traced'] });
        try {
            await expect(run('success(1);', { ...options, trace })).rejects.toThrow(/trace source mismatch/);
            await expect(run(source, { ...options, trace, args: ['other'] })).rejects.toThrow(/trace script arguments mismatch/);
            expect(await run(source, { ...options, trace, args: ['traced'] })).toMatchObject({ status: 'success', value: ['traced'] });
            expect(await run(source, { ...options, trace })).toMatchObject({ status: 'success', value: ['traced'] });
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
            await run(source, { backend: new NoLlm(), logger: silent, cwd, trace });
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

    it('never falls back to a live agent when a completed trace is missing the decisions of a block', async () => {
        const source = agentBlock('Act.');
        await traced(source, { backend: scripted('Done') });
        expect(rows().map(row => row.type)).toEqual([undefined, 'intent', 'outcome', 'terminal']);
        keepRows(0, -1);
        const original = journal();
        const model = scripted('must never be used');
        await expect(traced(source, { backend: model })).rejects.toThrow(/history mismatch/);
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
            status: 'failure', failure: { status_code: 'runtime_error', reason: 'human answer must be a string' },
        });
    });

    it('locates an answer that is not text on the line of the question', async () => {
        expect(await exec("\nawait human('Question');", { human: () => 42 as never })).toMatchObject({
            status: 'failure', failure: { status_code: 'runtime_error', reason: 'human answer must be a string', line: 2, command: "await human('Question');" },
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

    it('passes the line of an agent block to the handler, and journals the answer for the block', async () => {
        const source = `\n${agentBlock('Ask whether to go on -> @go')}\nsuccess(go);`;
        const human = vi.fn((): string => 'yes');
        const first = await traced(source, { backend: acting(action('askHuman', { question: 'Go on?' }), results => save('go', results[0])), human });
        expect(first).toMatchObject({ status: 'success', value: 'yes' });
        expect(human).toHaveBeenCalledExactlyOnceWith('Go on?', 2);
        human.mockClear();
        expect(await traced(source, { human })).toEqual(first);
        expect(human).not.toHaveBeenCalled();
    });
});

describe('HTML trace report', () => {
    it('maps --trace names and .jsonl paths to sibling .jsonl and .html files', () => {
        const bare = tracePaths(path.join(cwd, 'run'));
        expect(bare).toEqual({
            base: path.join(cwd, 'run'),
            jsonl: path.join(cwd, 'run.jsonl'),
            html: path.join(cwd, 'run.html'),
        });
        expect(tracePaths(path.join(cwd, 'run.jsonl'))).toEqual(bare);
        expect(tracePaths(path.join(cwd, 'run.html'))).toEqual(bare);
    });

    it('renders ask/agent inputs and outputs, agent loop tool usage, source lines and results into self-contained HTML', async () => {
        fs.writeFileSync(path.join(cwd, 'note.txt'), 'line one\nline two');
        const source = [
            'function twice(n: number): number { return n * 2; }',
            agentBlock('Read note.txt, double 21 with @twice ->[Int] @doubled, run shell'),
            block('Summarize @doubled', 'outputVar: summary'),
            "const report = await agent('Inspect workspace');",
            'success({ doubled, summary, report });',
        ].join('\n');
        const loopModel = backend(async request => {
            if (request.runtimeTools) {
                const content = await request.invokeAction!(action('readFile', { path: 'note.txt' }));
                const n = await request.invokeAction!(action('callFunction', { name: 'twice', args: [21] }));
                await request.invokeAction!(save('doubled', n));
                return { text: `Read ${String(content).split('\n').length} lines.`, reasoning: 'Used readFile and twice.', effective: { provider: 'openai', model: 'gpt-6-luna', reasoningEffort: 'medium' } };
            }
            if (request.kind === 'agent') {
                await request.tools.invoke('readFile', { path: 'note.txt' });
                return {
                    text: 'Workspace inspected.',
                    toolResults: [
                        JSON.stringify({ tool: 'readFile', arguments: { path: 'note.txt' }, success: true, output: 'line one\nline two' }),
                        JSON.stringify({ tool: 'shell', arguments: { command: 'echo ready' }, success: true, output: 'ready\n' }),
                    ],
                    effective: { provider: 'openai', model: 'gpt-6-luna' },
                };
            }
            return { text: 'Forty-two is the answer.', effective: { provider: 'openai', model: 'gpt-6-luna' } };
        });
        await traced(source, { backend: loopModel });
        const html = traceHtml(journal(), { title: 'demo.spl', source, traceFile: 'run.jsonl' });
        expect(html).toContain('<!DOCTYPE html>');
        expect(html).toContain('<meta name="color-scheme" content="light dark">');
        expect(html).toContain('demo.spl — SPL Trace');
        expect(html).toContain('✓ Completed');
        expect(html).toContain('Read note.txt, double 21 with @twice -&gt;[Int] @doubled, run shell');
        expect(html).toContain('@twice(21)');
        expect(html).toContain('Forty-two is the answer.');
        expect(html).toContain('Workspace inspected.');
        expect(html).toContain('echo ready');
        // Shell disclosure starts open; readFile disclosure starts closed.
        expect(html).toMatch(/<span class="tool-badge">shell<\/span>[\s\S]*?<details class="disclosure" open>/);
        expect(html).toMatch(/<span class="tool-badge">readFile<\/span>[\s\S]*?<details class="disclosure">/);
        expect(html).toContain('id="L2"');
        expect(html).not.toMatch(/<link[^>]+href="https?:/);
    });

    it('renders bigint completions and failed runs with their source line', async () => {
        const exact = 'const big = 123456789012345678901234567890n;\nsuccess(big);';
        await traced(exact);
        expect(traceHtml(journal(), { title: 'big.spl', source: exact })).toContain('123456789012345678901234567890n');

        fs.unlinkSync(file);
        const failing = "const x = 1;\nfail('boom');";
        await traced(failing);
        const failedHtml = traceHtml(journal(), { title: 'fail.spl', source: failing });
        expect(failedHtml).toContain('✗ Failed');
        expect(failedHtml).toContain('explicit_failure');
        expect(failedHtml).toContain('boom');
        expect(failedHtml).toContain('href="#L2"');
    });
});
