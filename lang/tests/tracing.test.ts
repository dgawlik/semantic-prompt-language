import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run, type RunOptions } from '../src/interpreter.js';
import { LlmError, type LlmBackend, type LlmRequest, type LlmResponse } from '../src/llm.js';
import { Logger } from '../src/logger.js';
import { parseMarkdown } from '../src/markdown.js';
import { parse, usesHuman } from '../src/parser.js';
import { Trace, TraceError, type TraceContext } from '../src/trace.js';
import { ToolHost } from '../src/tools.js';
import type { ModelStreamEvent } from '../src/log-events.js';

let cwd: string;
let file: string;
const logger = new Logger('silent');
const unused: LlmBackend = { async call() { throw new Error('unexpected model call'); }, async close() {} };
beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'spl-trace-'));
    file = path.join(cwd, 'run.jsonl');
});
afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(cwd, { recursive: true, force: true });
});

const context = (source: string): TraceContext => ({ source, runtime: 'test-runtime', cwd });
const rows = () => fs.readFileSync(file, 'utf8').trimEnd().split('\n').map(line => JSON.parse(line));
function scripted(...outcomes: (string | Error)[]) {
    return {
        call: vi.fn(async (_req: LlmRequest): Promise<LlmResponse> => {
            const outcome = outcomes.shift();
            if (outcome instanceof Error) throw outcome;
            if (outcome === undefined) throw new Error('unexpected model call');
            return { text: outcome, reasoning: 'saved reasoning', effective: { model: 'test' } };
        }),
        async close() {},
    };
}
async function execute(source: string, options: Partial<RunOptions> = {}, markdown = false) {
    const program = markdown ? parseMarkdown(source) : parse(source);
    const trace = Trace.open(file, context(program.lines.join('\n')));
    try {
        const result = await run(program, { backend: unused, logger, cwd, ...options, trace });
        trace.finish(result);
        return result;
    } finally {
        trace.close();
    }
}

describe('append-only trace resumption', () => {
    it('replays completed tools, model repairs, agents, human answers, arguments and environment without external work', async () => {
        vi.stubEnv('SPL_TRACE_TEST', 'original');
        const tools = vi.spyOn(ToolHost.prototype, 'invoke').mockResolvedValue('raw result');
        const backend = scripted('bad JSON', '42', 'agent result');
        const human = vi.fn(async () => '  exact\nanswer  ');
        const source = `let results = [read_file('input'), write_file('output', 'text'), shell('command'),
    web_fetch('https://example.test'), web_search('query')]
let value = ask(tokens=2048, seed=42, temperature=0, fmt='integer', repairs=1) 'Number?'
let answer = human 'Approve?'
success [results, value, agent 'Act', answer, $args, $env.SPL_TRACE_TEST]`;
        const program = parse(source);
        let trace = Trace.open(file, { ...context(source), args: ['initial'] });
        const first = await run(program, { backend, human, logger, cwd, trace });
        trace.finish(first);
        trace.close();
        const original = fs.readFileSync(file, 'utf8');
        vi.stubEnv('SPL_TRACE_TEST', 'changed');
        tools.mockClear();
        human.mockClear();
        trace = Trace.open(file, context(source));
        expect(await run(program, { backend: unused, human, logger, cwd, trace })).toEqual(first);
        trace.finish(first);
        trace.close();
        expect(fs.readFileSync(file, 'utf8')).toBe(original);
        expect(tools).not.toHaveBeenCalled();
        expect(human).not.toHaveBeenCalled();
        expect(backend.call).toHaveBeenCalledTimes(3);
        expect(original).toContain('saved reasoning');
        expect(original).toContain('\\"tokens\\":2048');
        expect(original).not.toMatch(/bindingId|scopeId|payloadId|onStream/);
    });

    it('resumes interrupted human input, reconstructing loops, aliases and mutations exactly once', async () => {
        const stopped = new Error('interrupted');
        const tools = vi.spyOn(ToolHost.prototype, 'invoke').mockResolvedValue('written');
        const source = `let answers = []
let alias = answers
def collect(i):
    write_file('output', 'original')
    alias.append(human 'Question {i}')
for i in range(2):
    collect(i)
success [answers, alias == answers]`;
        let calls = 0;
        await expect(execute(source, { human: () => { if (calls++ === 0) return ''; throw stopped; } })).rejects.toThrow(/interrupted/);
        const prefix = fs.readFileSync(file, 'utf8');
        expect(tools).toHaveBeenCalledTimes(2);
        const human = vi.fn(() => '  final\nanswer  ');
        const result = await execute(source, { human });
        expect(result).toMatchObject({ status: 'success', value: [['', '  final\nanswer  '], true] });
        expect(human).toHaveBeenCalledExactlyOnceWith('Question 1', 5);
        expect(tools).toHaveBeenCalledTimes(2);
        expect(fs.readFileSync(file, 'utf8').startsWith(prefix)).toBe(true);
        const complete = fs.readFileSync(file, 'utf8');
        expect(await execute(source)).toEqual(result);
        expect(fs.readFileSync(file, 'utf8')).toBe(complete);
    });

    it('continues a valid prefix even when there is no pending input or completion event', async () => {
        const source = `let value = ask 'First'\nsuccess [value, ask 'Second']`;
        const backend = scripted('first', 'second');
        const result = await execute(source, { backend });
        const events = rows();
        fs.writeFileSync(file, events.slice(0, 3).map(row => JSON.stringify(row)).join('\n') + '\n');
        const prefix = fs.readFileSync(file, 'utf8');
        const suffix = scripted('new second');
        expect(await execute(source, { backend: suffix })).toMatchObject({ status: 'success', value: ['first', 'new second'] });
        expect(suffix.call).toHaveBeenCalledOnce();
        expect(fs.readFileSync(file, 'utf8').startsWith(prefix)).toBe(true);
        expect(result.status).toBe('success');
    });

    it('replays durable failures deterministically and records raw generation repair failures', async () => {
        const source = `try:
    let value = ask 'Unavailable'
except err:
    assert err.status_code == 'llm_error'
fail 'rejected'`;
        const backend = scripted(new LlmError('offline'));
        const first = await execute(source, { backend });
        expect(first).toMatchObject({ status: 'failure', failure: { status_code: 'explicit_failure' } });
        expect(await execute(source)).toEqual(first);
        expect(backend.call).toHaveBeenCalledOnce();
        expect(rows().find(row => row.type === 'outcome').outcome.error).toEqual({ status_code: 'llm_error', reason: 'offline' });
    });

    it('replays completed agent-owned effects, but refuses to repeat an agent with an unknown outcome', async () => {
        const source = `success agent 'Write a file'`;
        const backend: LlmBackend = {
            async call(req) {
                await req.tools.invoke('write_file', { path: 'agent.txt', content: 'original' });
                return { text: 'done', effective: {} };
            },
            async close() {},
        };
        const first = await execute(source, { backend });
        fs.unlinkSync(path.join(cwd, 'agent.txt'));
        expect(await execute(source)).toEqual(first);
        expect(fs.existsSync(path.join(cwd, 'agent.txt'))).toBe(false);
        const history = rows();
        fs.writeFileSync(file, history.slice(0, 2).map(row => JSON.stringify(row)).join('\n') + '\n');
        const before = fs.readFileSync(file, 'utf8');
        await expect(execute(source, { backend })).rejects.toThrow(/unresolved effect/);
        expect(fs.readFileSync(file, 'utf8')).toBe(before);
        expect(fs.existsSync(path.join(cwd, 'agent.txt'))).toBe(false);
    });

    it('resumes blockquote actions inside functions without repeating writes, generation or shared mutations', async () => {
        const source = `---\nextension: semantic-prompt-language\nversion: 1\n---\n
\`\`\`spl
let count = 0
def approve():
    count += 1
    write_file('draft.txt', 'original')
    return [ask(fmt='integer', repairs=1) 'Number?', human 'Approve?']
\`\`\`
> @CTL(restrict={fs: ["."]}, enforce="Be precise", model="quote-model", reasoning="high") Invoke @approve, save the result to @answer, and finish.
\`\`\`spl
success [count, answer]
\`\`\``;
        const tools = vi.spyOn(ToolHost.prototype, 'invoke').mockResolvedValue('written');
        let generations = 0;
        const backend: LlmBackend = {
            async call(req) {
                if (!req.naturalLanguage) return { text: generations++ === 0 ? 'bad JSON' : '9', effective: {} };
                const value = await req.invokeAction!({ name: 'call_function', arguments: { name: 'approve', args: [] } });
                await req.invokeAction!({ name: 'save_variable', arguments: { name: 'answer', value } });
                return { text: 'Done', effective: {} };
            },
            async close() {},
        };
        const interrupted = new Error('interrupted');
        await expect(execute(source, { backend, human: () => { throw interrupted; } }, true)).rejects.toThrow(/interrupted/);
        const prefix = fs.readFileSync(file, 'utf8');
        const resumed: LlmBackend = {
            async call(req) {
                expect(req.prompt).toContain('"value":[9,"approved"]');
                await req.invokeAction!({ name: 'save_variable', arguments: { name: 'answer', value: [9, 'approved'] } });
                return { text: 'Done', effective: {} };
            },
            async close() {},
        };
        const result = await execute(source, { backend: resumed, human: () => 'approved' }, true);
        expect(result).toMatchObject({ status: 'success', value: [1, [9, 'approved']] });
        expect(tools).toHaveBeenCalledOnce();
        expect(generations).toBe(2);
        expect(fs.readFileSync(file, 'utf8').startsWith(prefix)).toBe(true);
        expect(await execute(source, {}, true)).toEqual(result);
        expect(tools).toHaveBeenCalledOnce();
    });

    it.each([
        { name: 'success', arguments: { value: 9 } },
        { name: 'fail', arguments: { reason: 'stop' } },
        { name: 'call_function', arguments: { name: 'missing', args: [] } },
        { name: 'read_file', arguments: { path: 'missing' } },
    ])('replays immediately terminating blockquote $name actions', async action => {
        const source = '---\nextension: semantic-prompt-language\nversion: 1\n---\n\n> Act.';
        const backend: LlmBackend = {
            async call(req) {
                await req.invokeAction!(action);
                throw new Error('must terminate');
            },
            async close() {},
        };
        const first = await execute(source, { backend }, true);
        expect(await execute(source, {}, true)).toEqual(first);
    });

    it('records only requested agent environment values and replays them after changes', async () => {
        vi.stubEnv('SPL_AGENT_PRIVATE', 'do-not-include');
        vi.stubEnv('SPL_AGENT_PUBLIC', 'original');
        const source = '---\nextension: semantic-prompt-language\nversion: 1\n---\n\n> Return the configured environment value.';
        const backend: LlmBackend = {
            async call(req) {
                const value = await req.invokeAction!({ name: 'get_env', arguments: { name: 'SPL_AGENT_PUBLIC' } });
                await req.invokeAction!({ name: 'success', arguments: { value } });
                throw new Error('must terminate');
            },
            async close() {},
        };
        const first = await execute(source, { backend }, true);
        expect(first).toMatchObject({ value: 'original' });
        expect(fs.readFileSync(file, 'utf8')).not.toContain('do-not-include');
        vi.stubEnv('SPL_AGENT_PUBLIC', 'changed');
        expect(await execute(source, {}, true)).toEqual(first);
    });

    it('streams live previews without persisting or replaying ephemeral updates', async () => {
        const streams: ModelStreamEvent[] = [];
        const streamLogger = new Logger('error', () => {}, { streamSink: event => streams.push(event) });
        const backend: LlmBackend = {
            async call(req) {
                req.onStream?.({ channel: 'response', messageId: 'preview-id', mode: 'append', text: 'partial preview' });
                return { text: 'complete', effective: {} };
            },
            async close() {},
        };
        const source = `success ask 'Prompt'`;
        const result = await execute(source, { backend, logger: streamLogger });
        expect(streams.map(event => event.type)).toEqual(['update', 'end']);
        expect(fs.readFileSync(file, 'utf8')).not.toMatch(/partial preview|preview-id/);
        streams.length = 0;
        expect(await execute(source, { logger: streamLogger })).toEqual(result);
        expect(streams).toEqual([]);
    });

    it('replays named class schema hydration and typed integer results', async () => {
        const source = `---\nextension: semantic-prompt-language\nversion: 1\n---\n
\`\`\`spl
hydratable class Data:
    count: int
\`\`\`
> Save @data with schema @Data.
\`\`\`spl
success [isinstance(data, Data), data.count]
\`\`\``;
        const backend: LlmBackend = {
            async call(req) {
                await req.invokeAction!({ name: 'load_variable', arguments: { name: 'Data' } });
                await req.invokeAction!({ name: 'save_variable', arguments: { name: 'data', value: { count: 15 }, schema: 'Data' } });
                return { text: 'Done', effective: {} };
            },
            async close() {},
        };
        const result = await execute(source, { backend }, true);
        expect(result).toMatchObject({ status: 'success', value: [true, 15n] });
        expect(await execute(source, {}, true)).toEqual(result);
    });

    it('does not seal cancelled calls as failures, and reclaims a terminated writer lock', async () => {
        const source = `success ask 'Prompt'`;
        let trace = Trace.open(file, context(source));
        const backend: LlmBackend = {
            async call() {
                trace.cancel();
                throw new LlmError('cancelled provider');
            },
            async close() {},
        };
        try {
            await expect(run(parse(source), { backend, logger, cwd, trace })).rejects.toThrow(/unusable/);
        } finally { trace.close(); }
        expect(rows().map(row => row.type)).toEqual([undefined, 'intent']);
        const prefix = fs.readFileSync(file, 'utf8');
        const terminated = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' });
        expect(terminated.status).toBe(0);
        fs.writeFileSync(`${file}.lock`, String(terminated.pid));
        trace = Trace.open(file, context(source));
        try {
            const result = await run(parse(source), { backend: scripted('resumed'), logger, cwd, trace });
            expect(result).toMatchObject({ status: 'success', value: 'resumed' });
            trace.finish(result);
        } finally { trace.close(); }
        expect(fs.readFileSync(file, 'utf8').startsWith(prefix)).toBe(true);
    });

    it('supports exact integer completion and source, runtime, configuration and argument guards', async () => {
        const source = `success 123456789012345678901234567890`;
        const first = await execute(source);
        expect(await execute(source)).toEqual(first);
        const original = fs.readFileSync(file, 'utf8');
        for (const change of [{ source: 'changed' }, { runtime: 'changed' }, { configuration: { model: 'changed' } }, { args: ['changed'] }]) {
            expect(() => Trace.open(file, { ...context(source), ...change })).toThrow(/mismatch/);
        }
        expect(fs.readFileSync(file, 'utf8')).toBe(original);
        expect(fs.existsSync(`${file}.lock`)).toBe(false);
    });

    it('guards mismatched effects, unused history and terminal results without modifying completed traces', async () => {
        const source = `success ask 'Prompt'`;
        await execute(source, { backend: scripted('answer') });
        const original = fs.readFileSync(file, 'utf8');
        const trace = Trace.open(file, context(source));
        try {
            await expect(trace.effect({ kind: 'unexpected' }, () => 'unused', (value): value is string => typeof value === 'string'))
                .rejects.toThrow(/history mismatch/);
            expect(() => trace.assertConsumed()).toThrow(/unused history/);
            await run(parse(source), { backend: unused, logger, trace });
            expect(() => trace.finish({ status: 'success', value: 'wrong', hasValue: true })).toThrow(/completion mismatch/);
        } finally { trace.close(); }
        expect(fs.readFileSync(file, 'utf8')).toBe(original);
    });

    it('never falls back to a live agent when a completed trace is missing its runtime decisions', async () => {
        const source = '---\nextension: semantic-prompt-language\nversion: 1\n---\n\n> Act.';
        await execute(source, { backend: scripted('Done') }, true);
        const history = rows();
        fs.writeFileSync(file, [history[0], history.at(-1)].map(row => JSON.stringify(row)).join('\n') + '\n');
        const original = fs.readFileSync(file, 'utf8');
        const backend = scripted('must never be used');
        await expect(execute(source, { backend }, true)).rejects.toThrow(/history mismatch/);
        expect(backend.call).not.toHaveBeenCalled();
        expect(fs.readFileSync(file, 'utf8')).toBe(original);
    });

    it('rejects concurrent writers and malformed or truncated files without rewriting bytes', () => {
        const source = 'pass';
        const trace = Trace.open(file, context(source));
        expect(() => Trace.open(file, context(source))).toThrow(/another trace writer/);
        trace.close();
        const header = fs.readFileSync(file, 'utf8');
        for (const invalid of ['', '{broken\n', header + '{broken', header + '{}\n', '{"format":"spl-trace","version":1}\n']) {
            fs.writeFileSync(file, invalid);
            expect(() => Trace.open(file, context(source))).toThrow(TraceError);
            expect(fs.readFileSync(file, 'utf8')).toBe(invalid);
            expect(fs.existsSync(`${file}.lock`)).toBe(false);
        }
    });
});

describe('direct human input', () => {
    it('preflights human syntax and missing handlers before executing effects', async () => {
        expect(usesHuman(parse(`success 'human'`))).toBe(false);
        expect(usesHuman(parse(`def later():\n    return human 'Question'`))).toBe(true);
        expect(() => parse(`human(fmt='text') 'Question'`)).toThrow(/does not accept modifiers/);
        expect(() => parse(`let human = 1`)).toThrow(/reserved/);
        expect(() => parse('human')).toThrow(/requires a prompt/);
        expect(await run(parse(`write_file('should-not-exist', 'x')\ndef later():\n    return human 'Question'`),
            { backend: unused, logger, cwd })).toMatchObject({ status: 'failure', failure: { reason: 'human input requires a human handler' } });
        expect(fs.existsSync(path.join(cwd, 'should-not-exist'))).toBe(false);
    });

    it('validates questions and exact answers, and propagates unexpected handler errors', async () => {
        const human = vi.fn(() => 'unused');
        expect(await run(parse('success human 42'), { backend: unused, logger, human }))
            .toMatchObject({ status: 'failure', failure: { reason: 'human question must be a string' } });
        expect(human).not.toHaveBeenCalled();
        const failure = new Error('input unavailable');
        await expect(run(parse(`success human 'Question'`),
            { backend: unused, logger, human: () => { throw failure; } })).rejects.toBe(failure);
        expect(await run(parse(`success human 'Question'`),
            { backend: unused, logger, human: () => '  exact\nanswer  ' })).toMatchObject({ value: '  exact\nanswer  ' });
    });
});
