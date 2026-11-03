import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import type { LanguageModelV4StreamPart, LanguageModelV4CallOptions } from '@ai-sdk/provider';
import { AiBackend, reasoningOptions } from '../src/ai.js';
import { CopilotBackend } from '../src/copilot.js';
import { Logger } from '../src/logger.js';
import { makeRestriction, Restrictions } from '../src/restrict.js';
import { TOOL_SPECS, ToolHost } from '../src/tools.js';
import { AGENT_TOOLS } from '../src/agent.js';
import type { LlmRequest, LlmStreamUpdate } from '../src/llm.js';
import { run } from '../src/interpreter.js';
import { parseMarkdown } from '../src/markdown.js';
import { Failure, SuccessSignal } from '../src/errors.js';

const sdk = vi.hoisted(() => ({
    model: undefined as unknown,
    openai: vi.fn(),
    anthropic: vi.fn(),
    google: vi.fn(),
    mcp: vi.fn(),
}));
vi.mock('@ai-sdk/openai', () => ({ createOpenAI: (options: unknown) => {
    sdk.openai(options);
    return { responses: () => sdk.model };
} }));
vi.mock('@ai-sdk/anthropic', () => ({ createAnthropic: (options: unknown) => {
    sdk.anthropic(options);
    return () => sdk.model;
} }));
vi.mock('@ai-sdk/google', () => ({ createGoogleGenerativeAI: (options: unknown) => {
    sdk.google(options);
    return () => sdk.model;
} }));
vi.mock('@ai-sdk/mcp', () => ({ createMCPClient: (options: unknown) => sdk.mcp(options) }));

let cwd: string;
let backend: AiBackend;
let requests: LanguageModelV4CallOptions[];
let steps: LanguageModelV4StreamPart[][];
let streamOverride: ((options: LanguageModelV4CallOptions) => ReadableStream<LanguageModelV4StreamPart>) | undefined;
const usage = { inputTokens: { total: 1 }, outputTokens: { total: 1 } };
const finish = (unified: 'stop' | 'tool-calls' | 'length' | 'content-filter' | 'error' = 'stop'): LanguageModelV4StreamPart =>
    ({ type: 'finish', finishReason: { unified, raw: unified }, usage });
const text = (value: string): LanguageModelV4StreamPart[] => [
    { type: 'text-start', id: 'answer' }, { type: 'text-delta', id: 'answer', delta: value }, { type: 'text-end', id: 'answer' },
];
const call = (name: string, args: unknown, id = name): LanguageModelV4StreamPart =>
    ({ type: 'tool-call', toolCallId: id, toolName: name, input: JSON.stringify(args) });
const request = (overrides: Partial<LlmRequest> = {}): LlmRequest => {
    const restrictions = new Restrictions(cwd);
    return { kind: 'ask', prompt: 'Prompt', restrictions, showReasoning: false, tools: new ToolHost(restrictions, cwd), ...overrides };
};
const command = (overrides: Partial<LlmRequest> = {}) => backend.call(request({
    kind: 'agent', naturalLanguage: true, runtimeTools: AGENT_TOOLS, invokeAction: async () => null, ...overrides,
}));
const client = () => ({
    listTools: vi.fn(async () => ({ tools: [
        { name: 'search', description: 'Search', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
        { name: 'write', inputSchema: { type: 'object', properties: {} } },
    ] })),
    callTool: vi.fn(async () => ({ content: [{ type: 'text', text: 'Verified documentation' }] })),
    close: vi.fn(async () => {}),
});

beforeEach(() => {
    vi.clearAllMocks();
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'spl-ai-'));
    vi.stubEnv('SPL_HOME', path.join(cwd, 'home'));
    vi.stubEnv('OPENAI_API_KEY', 'test-openai-key');
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-anthropic-key');
    vi.stubEnv('GOOGLE_GENERATIVE_AI_API_KEY', 'test-google-key');
    vi.stubEnv('SPL_PROVIDER', 'openai');
    requests = [];
    steps = [[...text('Final answer'), finish()]];
    streamOverride = undefined;
    sdk.model = new MockLanguageModelV4({
        doStream: async options => {
            requests.push(options);
            return { stream: streamOverride?.(options) ?? new ReadableStream({
                start(controller) {
                    for (const part of steps.shift() ?? []) controller.enqueue(part);
                    controller.close();
                },
            }) };
        },
    });
    sdk.mcp.mockReset().mockResolvedValue(client());
    backend = new AiBackend({ cwd, timeoutMs: 2000, logger: new Logger('silent') });
});
afterEach(async () => {
    await backend.close();
    vi.unstubAllEnvs();
    fs.rmSync(cwd, { recursive: true, force: true });
});

it('retains the old backend import as an alias, not a second implementation', () => {
    expect(CopilotBackend).toBe(AiBackend);
});

it.each([
    ['openai/gpt-4.1', 'openai'], ['anthropic/claude-sonnet-4-5', 'anthropic'], ['google/gemini-2.5-flash', 'google'],
] as const)('uses the %s provider through the real AI SDK stream pipeline', async (model, provider) => {
    const result = await backend.call(request({ model }));
    expect(result).toMatchObject({ text: 'Final answer', effective: { backend: 'vercel-ai-sdk', provider } });
    expect(sdk[provider]).toHaveBeenCalledWith({ apiKey: `test-${provider}-key` });
    expect(requests[0].prompt.at(-1)).toMatchObject({ role: 'user', content: [{ type: 'text', text: 'Prompt' }] });
});

it.each(['ask', 'think', 'agent'] as const)('streams %s text and keeps calls isolated', async kind => {
    const updates: LlmStreamUpdate[] = [];
    steps.push([...text('Second answer'), finish()]);
    expect(await backend.call(request({ kind, onStream: value => updates.push(value) }))).toMatchObject({ text: 'Final answer' });
    expect(updates).toEqual([
        { channel: 'response', messageId: '0:answer', mode: 'append', text: 'Final answer' },
        { channel: 'response', messageId: '0:answer', mode: 'replace', text: 'Final answer' },
    ]);
    await backend.call(request({ prompt: 'Second prompt' }));
    expect(requests[1].prompt.filter(message => message.role !== 'system')).toHaveLength(1);
});

it.each(['ask', 'think', 'agent'] as const)('forwards %s sampling to the SDK without modifying the prompt or reasoning', async kind => {
    const result = await backend.call(request({
        kind, model: 'google/gemini-2.5-flash', reasoningEffort: 'high',
        randomness: { seed: 42, temperature: 0, top_p: 0.01 },
    }));
    expect(requests[0]).toMatchObject({
        seed: 42, temperature: 0, topP: 0.01,
        providerOptions: { google: { thinkingConfig: { thinkingBudget: 16384 } } },
    });
    expect(requests[0].prompt.at(-1)).toMatchObject({ role: 'user', content: [{ type: 'text', text: 'Prompt' }] });
    expect(result.effective).toMatchObject({ reasoningEffort: 'high', randomness: { seed: 42, temperature: 0, top_p: 0.01 } });
});

it('routes unsupported sampling warnings through the host logger and does not claim rejected controls were effective', async () => {
    steps[0].unshift({ type: 'stream-start', warnings: [
        { type: 'unsupported', feature: 'temperature', details: 'unsupported by this model' },
        { type: 'unsupported', feature: 'topP', details: 'unsupported by this model' },
    ] });
    const warn = vi.spyOn(Logger.prototype, 'warn');
    try {
        const result = await backend.call(request({ randomness: { seed: 42, temperature: 0, top_p: 0.01 } }));
        expect(result.effective.randomness).toEqual({ seed: null, temperature: null, top_p: null });
        expect(warn).toHaveBeenCalledTimes(3);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('does not support randomness.seed'));
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('"feature":"temperature"'));
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('"feature":"topP"'));
    } finally {
        warn.mockRestore();
    }
});

it('validates sampling on direct embedded backend calls before invoking any provider', async () => {
    const invalid = { temperature: Number.NaN };
    await expect(backend.call(request({ randomness: invalid }))).rejects.toMatchObject({ statusCode: 'runtime_error' });
    expect(requests).toHaveLength(0);
    expect(sdk.openai).not.toHaveBeenCalled();
    expect(sdk.anthropic).not.toHaveBeenCalled();
    expect(sdk.google).not.toHaveBeenCalled();
});

it('normalizes optional undefined sampling fields from embedded callers to provider defaults', async () => {
    const result = await backend.call(request({ randomness: { seed: undefined, temperature: undefined, top_p: undefined } }));
    expect(requests[0].seed).toBeUndefined();
    expect(requests[0].temperature).toBeUndefined();
    expect(requests[0].topP).toBeUndefined();
    expect(result.effective.randomness).toEqual({ seed: null, temperature: null, top_p: null });
});

it.each([false, true])('returns reasoning, but exposes live reasoning only when requested: %s', async showReasoning => {
    steps = [[
        { type: 'reasoning-start', id: 'reason' }, { type: 'reasoning-delta', id: 'reason', delta: 'Thinking.' },
        { type: 'reasoning-end', id: 'reason' }, ...text('42'), finish(),
    ]];
    const updates: LlmStreamUpdate[] = [];
    expect(await backend.call(request({ showReasoning, onStream: update => updates.push(update) }))).toMatchObject({ text: '42', reasoning: 'Thinking.' });
    expect(updates.filter(update => update.channel === 'reasoning')).toHaveLength(showReasoning ? 2 : 0);
});

it.each(['ask', 'think'] as const)('does not expose tools or initialize MCP during %s', async kind => {
    backend = new AiBackend({ cwd, timeoutMs: 2000, logger: new Logger('silent'), mcpServers: { docs: { command: 'never-start' } } });
    await backend.call(request({ kind }));
    expect(requests[0].tools ?? []).toHaveLength(0);
    expect(sdk.mcp).not.toHaveBeenCalled();
});

it('denies a tool attempt during generation even when the provider ignores the empty tool list', async () => {
    steps = [[call('read_file', { path: 'secret' }), ...text('Ignored denial'), finish()]];
    await expect(backend.call(request())).rejects.toMatchObject({ statusCode: 'restriction_violation' });
});

it('exposes exactly the runtime tool set for explicit agents', async () => {
    await backend.call(request({ kind: 'agent' }));
    expect(requests[0].tools?.map(tool => tool.name).sort()).toEqual(Object.keys(TOOL_SPECS).sort());
});

it('executes a factorial instruction and saves the real function result in the same conversation', async () => {
    steps = [[call('call_function', { name: 'factorial', args: [15] }), finish('tool-calls')],
        [call('save_variable', { name: 'fact15', value: 1307674368000 }), finish('tool-calls')],
        [...text(''), finish()]];
    const result = await run(parseMarkdown([
        '---', 'extension: semantic-prompt-language', 'version: 1', '---', '',
        '```spl', 'def factorial(n):', '    if n == 0:', '        return 1', '    return n * factorial(n - 1)', '```', '',
        '> Invoke @factorial with 15 as argument -> @fact15', '',
        '```spl', 'success fact15', '```',
    ].join('\n')), { cwd, backend, logger: new Logger('silent') });
    expect(result).toEqual({ status: 'success', value: 1307674368000, hasValue: true });
    expect(requests).toHaveLength(3);
    expect(JSON.stringify(requests[1].prompt)).toContain('1307674368000');
    expect(requests[0].tools?.map(tool => tool.name)).toEqual(AGENT_TOOLS.map(tool => tool.name));
});

it('serializes multiple actions requested together and supplies actual results to the next step', async () => {
    steps = [[call('save_variable', { name: 'answer', value: 42 }, 'first'),
        call('load_variable', { name: 'answer' }, 'second'), finish('tool-calls')], [...text('Done'), finish()]];
    const invoked: string[] = [];
    let running = false;
    await command({ invokeAction: async action => {
        expect(running).toBe(false);
        running = true;
        await Promise.resolve();
        invoked.push(action.name);
        running = false;
        return 42;
    } });
    expect(invoked).toEqual(['save_variable', 'load_variable']);
    expect(JSON.stringify(requests[1].prompt)).toContain('{"value":42}'.replaceAll('"', '\\"'));
});

it.each([
    new Failure('runtime_error', 'missing function'), new Failure('validation_failed', 'invalid'),
    new Failure('tool_error', 'write failed'), new Failure('restriction_violation', 'denied'),
    new Failure('explicit_failure', 'stop'), new Error('unexpected tool failure'), new SuccessSignal(42),
])('preserves the original action failure/control signal and never executes a later action: %s', async error => {
    steps = [[call('call_function', { name: 'missing', args: [] }), call('save_variable', { name: 'later', value: 1 }), finish('tool-calls')]];
    const invokeAction = vi.fn(async () => { throw error; });
    await expect(command({ invokeAction })).rejects.toBe(error);
    expect(invokeAction).toHaveBeenCalledOnce();
    expect(requests).toHaveLength(1);
    expect(requests[0].abortSignal?.aborted).toBe(true);
});

it('rejects invalid runtime arguments without calling the host', async () => {
    steps = [[call('save_variable', { name: 'answer' }), finish('tool-calls')]];
    const invokeAction = vi.fn(async () => null);
    await expect(command({ invokeAction })).rejects.toMatchObject({ statusCode: 'runtime_error' });
    expect(invokeAction).not.toHaveBeenCalled();
});

it.each(['', ' \n'])('accepts action-only completion with %j prose, but not empty generation', async prose => {
    steps = [[call('save_variable', { name: 'answer', value: 42 }), finish('tool-calls')], [...text(prose), finish()]];
    expect(await command()).toMatchObject({ text: 'Runtime actions completed.' });
    steps = [[...text(prose), finish()]];
    await expect(backend.call(request())).rejects.toThrow('empty response');
});

it('lets explicit agents recover ordinary tool errors, but not restriction violations', async () => {
    const tools = request().tools;
    const invoke = vi.spyOn(tools, 'invoke').mockRejectedValueOnce(new Failure('tool_error', 'missing file'));
    steps = [[call('read_file', { path: 'missing.txt' }), finish('tool-calls')], [...text('Not found'), finish()]];
    expect(await backend.call(request({ kind: 'agent', tools }))).toMatchObject({ text: 'Not found' });
    invoke.mockRejectedValueOnce(new Failure('restriction_violation', 'blocked'));
    steps = [[call('read_file', { path: 'secret.txt' }), finish('tool-calls')]];
    await expect(backend.call(request({ kind: 'agent', tools }))).rejects.toMatchObject({ statusCode: 'restriction_violation' });
});

it('aborts on streaming consumer failure even if the remote stream never finishes', async () => {
    const error = new Error('consumer failed');
    streamOverride = () => new ReadableStream({ start(controller) {
        controller.enqueue({ type: 'text-start', id: 'a' });
        controller.enqueue({ type: 'text-delta', id: 'a', delta: 'Preview' });
    } });
    await expect(backend.call(request({ onStream: () => { throw error; } }))).rejects.toBe(error);
    expect(requests[0].abortSignal?.aborted).toBe(true);
});

it('times out without accepting preview text, and never starts another action after a stalled action', async () => {
    backend = new AiBackend({ cwd, timeoutMs: 30, logger: new Logger('silent') });
    steps = [[...text('Preview'), call('save_variable', { name: 'x', value: 1 }), call('save_variable', { name: 'later', value: 2 }), finish()]];
    let release!: () => void;
    const invokeAction = vi.fn(() => new Promise<null>(resolve => { release = () => resolve(null); }));
    await expect(command({ invokeAction })).rejects.toThrow('timed out');
    release();
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(invokeAction).toHaveBeenCalledOnce();
});

it.each(['length', 'content-filter', 'error'] as const)('does not accept partial or abnormal completion: %s', async reason => {
    steps = [[...text('Partial'), finish(reason)]];
    await expect(backend.call(request())).rejects.toThrow('did not complete');
});

it('close cancels an active model turn and prevents future calls', async () => {
    let ready!: () => void;
    const started = new Promise<void>(resolve => { ready = resolve; });
    streamOverride = () => new ReadableStream({ start() { ready(); } });
    const result = backend.call(request());
    await started;
    await backend.close();
    await expect(result).rejects.toThrow('cancelled');
    await expect(backend.call(request())).rejects.toThrow('closed');
});

it.each(['stdio', 'http', 'sse'] as const)('connects configured %s MCP tools, filters names, traces real results and closes clients', async type => {
    const mcp = client();
    sdk.mcp.mockResolvedValue(mcp);
    const config = type === 'stdio'
        ? { command: 'node', tools: ['search'], workingDirectory: cwd, timeout: 500 }
        : { type, url: 'https://example.test/mcp', headers: { Authorization: 'test' }, tools: ['search'], timeout: 500 };
    backend = new AiBackend({ cwd, timeoutMs: 2000, logger: new Logger('silent'), mcpServers: { docs: config } });
    steps = [[call('mcp_0_0', { query: 'SPL' }), finish('tool-calls')], [...text('Found'), finish()]];
    const result = await command();
    expect(requests[0].tools?.map(tool => tool.name)).toEqual([...AGENT_TOOLS.map(tool => tool.name), 'mcp_0_0']);
    expect(mcp.callTool).toHaveBeenCalledWith(expect.objectContaining({ name: 'search', arguments: { query: 'SPL' }, options: expect.objectContaining({ timeout: 500 }) }));
    expect(JSON.parse(result.toolResults![0])).toMatchObject({ server: 'docs', tool: 'search', success: true, result: { content: [{ text: 'Verified documentation' }] } });
    expect(mcp.close).toHaveBeenCalledOnce();
    if (type !== 'stdio') expect(sdk.mcp).toHaveBeenCalledWith(expect.objectContaining({ transport: { type, url: config.url, headers: config.headers } }));
});

it('does not start excluded MCP servers and checks narrowed MCP restrictions immediately', async () => {
    let restrictions = new Restrictions(cwd).with(makeRestriction('mcp', 'docs', cwd));
    const mcp = client();
    sdk.mcp.mockResolvedValue(mcp);
    backend = new AiBackend({ cwd, timeoutMs: 2000, logger: new Logger('silent'), mcpServers: { docs: { command: 'node' }, excluded: { command: 'never-start' } } });
    steps = [[call('restrict', { kind: 'mcp', value: 'docs/write' }), call('mcp_0_0', { query: 'SPL' }), finish('tool-calls')]];
    await expect(command({
        restrictions, currentRestrictions: () => restrictions,
        invokeAction: async () => { restrictions = restrictions.with(makeRestriction('mcp', 'docs/write', cwd)); return null; },
    })).rejects.toMatchObject({ statusCode: 'restriction_violation' });
    expect(sdk.mcp).toHaveBeenCalledOnce();
    expect(mcp.callTool).not.toHaveBeenCalled();
    expect(mcp.close).toHaveBeenCalledOnce();
});

it('stops on an unsuccessful MCP result before any subsequent runtime action', async () => {
    const mcp = client();
    mcp.callTool.mockResolvedValue({ isError: true, content: [{ type: 'text', text: 'server failed' }] });
    sdk.mcp.mockResolvedValue(mcp);
    backend = new AiBackend({ cwd, timeoutMs: 2000, logger: new Logger('silent'), mcpServers: { docs: { command: 'node' } } });
    steps = [[call('mcp_0_0', { query: 'SPL' }), call('save_variable', { name: 'later', value: 42 }), finish('tool-calls')]];
    const invokeAction = vi.fn(async () => null);
    await expect(command({ invokeAction })).rejects.toMatchObject({ statusCode: 'tool_error', reason: expect.stringContaining('server failed') });
    expect(invokeAction).not.toHaveBeenCalled();
    expect(mcp.close).toHaveBeenCalledOnce();
});

it('allows explicit agents to recover a non-restriction MCP failure', async () => {
    const mcp = client();
    mcp.callTool.mockRejectedValueOnce(new Error('temporary tool failure'));
    sdk.mcp.mockResolvedValue(mcp);
    backend = new AiBackend({ cwd, timeoutMs: 2000, logger: new Logger('silent'), mcpServers: { docs: { command: 'node' } } });
    steps = [[call('mcp_0_0', { query: 'SPL' }), finish('tool-calls')], [...text('Tool unavailable'), finish()]];
    const result = await backend.call(request({ kind: 'agent' }));
    expect(result.text).toBe('Tool unavailable');
    expect(JSON.parse(result.toolResults![0])).toMatchObject({ success: false, error: expect.stringContaining('temporary tool failure') });
    expect(JSON.stringify(requests[1].prompt)).toContain('temporary tool failure');
});

it.each([
    ['openai', 'gpt-5', { openai: { reasoningEffort: 'high' } }],
    ['anthropic', 'claude-sonnet-4-5', { anthropic: { thinking: { type: 'enabled', budgetTokens: 16384 } } }],
    ['anthropic', 'claude-sonnet-4-6', { anthropic: { thinking: { type: 'adaptive' }, effort: 'high' } }],
    ['google', 'gemini-2.5-flash', { google: { thinkingConfig: { thinkingBudget: 16384, includeThoughts: true } } }],
    ['google', 'gemini-3-flash-preview', { google: { thinkingConfig: { thinkingLevel: 'high' } } }],
] as const)('maps reasoning for %s/%s', (provider, model, expected) => {
    expect(reasoningOptions(provider, model, 'high', true, new Logger('silent'))).toMatchObject({ effort: 'high', options: expected });
});

it('warns and records no effective effort for an unsupported reasoning model', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn');
    expect(await backend.call(request({ model: 'gpt-4.1', reasoningEffort: 'high' }))).toMatchObject({ effective: { reasoningEffort: null } });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('using the model default'));
    warn.mockRestore();
});

it('requests available Google reasoning even without an explicit effort, and avoids unsupported OpenAI summaries', () => {
    expect(reasoningOptions('google', 'gemini-2.5-flash', undefined, true, new Logger('silent'))).toMatchObject({
        options: { google: { thinkingConfig: { includeThoughts: true } } },
    });
    expect(reasoningOptions('openai', 'gpt-4.1', undefined, true, new Logger('silent')).options.openai).not.toHaveProperty('reasoningSummary');
});

it.each([
    ['openai', 'gpt-6-luna'],
    ['anthropic', 'claude-sonnet-4-5'],
    ['google', 'gemini-2.5-flash'],
] as const)('requests portable disabled reasoning for sampled %s calls, but preserves explicit effort', async (provider, model) => {
    steps.push([...text('Explicit answer'), finish()], [...text('Empty prefix answer'), finish()]);
    const sampled = { model: `${provider}/${model}`, randomness: { temperature: 0 } };
    expect(await backend.call(request(sampled))).toMatchObject({ effective: { reasoningEffort: 'none' } });
    expect(requests[0].reasoning).toBe('none');
    expect(await backend.call(request({ ...sampled, reasoningEffort: 'high' })))
        .toMatchObject({ effective: { reasoningEffort: 'high' } });
    expect(requests[1].reasoning).toBeUndefined();
    expect(await backend.call(request({ ...sampled, randomness: {} })))
        .toMatchObject({ effective: { reasoningEffort: 'none' } });
    expect(requests[2].reasoning).toBe('none');
});

it.each([
    ['openai', 'gpt-4.1'],
    ['anthropic', 'claude-3-5-haiku-20241022'],
    ['google', 'gemini-2.0-flash'],
] as const)('does not send thinking controls to non-reasoning %s models', (provider, model) => {
    expect(reasoningOptions(provider, model, undefined, true, new Logger('silent'), true)).not.toHaveProperty('effort');
});

it('routes provider warnings through the SPL logger instead of leaking global SDK warnings', async () => {
    steps[0].unshift({ type: 'stream-start', warnings: [{ type: 'unsupported', feature: 'test setting' }] });
    const warn = vi.spyOn(Logger.prototype, 'warn');
    const emit = vi.spyOn(process, 'emitWarning');
    try {
        await backend.call(request());
        expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('test setting'));
        expect(emit).not.toHaveBeenCalled();
    } finally {
        warn.mockRestore();
        emit.mockRestore();
    }
});
