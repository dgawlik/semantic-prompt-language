import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelStreamPart, ModelCallOptions, ToolOutput } from '../src/ai-native.js';
import { AiBackend, reasoningOptions } from '../src/ai.js';
import type { Provider } from '../src/auth.js';
import { AGENT_TOOLS } from '../src/blocks.js';
import { Failure, SuccessSignal } from '../src/errors.js';
import { LlmError, type LlmRequest, type LlmStreamUpdate, type ReasoningLevel } from '../src/llm.js';
import type { LogEvent, ModelStreamEvent } from '../src/log-events.js';
import { Logger } from '../src/logger.js';
import { makeRestriction, Restrictions } from '../src/restrict.js';
import { TOOL_SPECS, ToolHost } from '../src/tools.js';
import { agentBlock, block, cleanTemp, collecting, exec, silent, tempDir, text as body } from './helpers.js';

const sdk = vi.hoisted(() => ({
    model: vi.fn(),
    openai: vi.fn(),
    anthropic: vi.fn(),
    google: vi.fn(),
    mcp: vi.fn(),
}));
vi.mock('../src/ai-native.js', () => ({ createNativeModel: (provider: 'openai' | 'anthropic' | 'google', apiKey: string) => {
    sdk[provider]({ apiKey });
    return sdk.model();
} }));
vi.mock('@ai-sdk/mcp', () => ({ createMCPClient: (options: unknown) => sdk.mcp(options) }));

let cwd: string;
let backend: AiBackend;
type TestCallOptions = Omit<ModelCallOptions, 'prompt'> & { prompt: { role: string; content: unknown }[] };
let requests: TestCallOptions[];
let steps: ModelStreamPart[][];
let streamOverride: ((options: TestCallOptions) => ReadableStream<ModelStreamPart>) | undefined;
const finish = (reason: 'stop' | 'tool-calls' | 'length' | 'content-filter' | 'error' = 'stop'): ModelStreamPart =>
    ({ type: 'finish', reason });
const text = (value: string): ModelStreamPart[] => [
    { type: 'text-start', id: 'answer' }, { type: 'text-delta', id: 'answer', delta: value }, { type: 'text-end', id: 'answer' },
];
const call = (name: string, args: unknown, id = name): ModelStreamPart =>
    ({ type: 'tool-call', toolCallId: id, toolName: name, input: args });
const request = (overrides: Partial<LlmRequest> = {}): LlmRequest => {
    const restrictions = new Restrictions(cwd);
    return { kind: 'ask', prompt: 'Prompt', restrictions, showReasoning: false, tools: new ToolHost(restrictions, cwd), ...overrides };
};
const command = (overrides: Partial<LlmRequest> = {}) => backend.call(request({
    kind: 'agent', runtimeTools: AGENT_TOOLS, invokeAction: async () => null, ...overrides,
}));
const tool = (name: string) => ({ name, inputSchema: { type: 'object', properties: {} } });
const client = (tools: { name: string; description?: string; inputSchema: Record<string, unknown> }[] = [
    { name: 'search', description: 'Search', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
    tool('write'),
]) => ({
    listTools: vi.fn(async () => ({ tools })),
    callTool: vi.fn(async (): Promise<Record<string, unknown>> => ({ content: [{ type: 'text', text: 'Verified documentation' }] })),
    close: vi.fn(async () => {}),
});
const conflict = (feature: string): ModelStreamPart =>
    ({ type: 'stream-start', warnings: [{ type: 'unsupported', feature, details: `${feature} is not supported while reasoning`, conflict: 'reasoning' }] });


beforeEach(() => {
    vi.clearAllMocks();
    cwd = tempDir('spl-ai-');
    vi.stubEnv('SPL_HOME', path.join(cwd, 'home'));
    vi.stubEnv('OPENAI_API_KEY', 'test-openai-key');
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-anthropic-key');
    vi.stubEnv('GOOGLE_GENERATIVE_AI_API_KEY', 'test-google-key');
    vi.stubEnv('SPL_PROVIDER', 'openai');
    requests = [];
    steps = [[...text('Final answer'), finish()]];
    streamOverride = undefined;
    sdk.model.mockImplementation(() => {
        let prompt: TestCallOptions['prompt'] = [];
        return {
            addToolResults(outputs: ToolOutput[]) {
                prompt.push({ role: 'tool', content: outputs });
            },
            async *stream(options: ModelCallOptions) {
                if (!prompt.length) prompt = [{ role: 'user', content: [{ type: 'text', text: options.prompt }] }];
                const captured = { ...options, prompt: [...prompt] };
                requests.push(captured);
                const stream = streamOverride?.(captured) ?? new ReadableStream<ModelStreamPart>({
                    start(controller) {
                        for (const part of steps.shift() ?? []) controller.enqueue(part);
                        controller.close();
                    },
                });
                const reader = stream.getReader();
                try {
                    for (;;) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        yield value;
                    }
                } finally {
                    reader.releaseLock();
                }
            },
        };
    });
    sdk.mcp.mockReset().mockResolvedValue(client());
    backend = new AiBackend({ cwd, timeoutMs: 2000, logger: new Logger('silent') });
});
afterEach(async () => {
    await backend.close();
    vi.unstubAllEnvs();
    cleanTemp();
});

it.each([
    ['openai/gpt-4.1', 'openai'], ['anthropic/claude-sonnet-4-5', 'anthropic'], ['google/gemini-2.5-flash', 'google'],
] as const)('uses the %s provider through the native adapter', async (model, provider) => {
    const result = await backend.call(request({ model }));
    expect(result).toMatchObject({ text: 'Final answer', effective: { backend: 'native-sdk', provider } });
    expect(sdk[provider]).toHaveBeenCalledWith({ apiKey: `test-${provider}-key` });
    expect(requests[0].prompt.at(-1)).toMatchObject({ role: 'user', content: [{ type: 'text', text: 'Prompt' }] });
});

it.each(['ask', 'agent'] as const)('streams %s text and keeps calls isolated', async kind => {
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

it.each(['ask', 'agent'] as const)('forwards %s sampling to the client without modifying the prompt or reasoning', async kind => {
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
        { type: 'unsupported', feature: 'seed', details: 'does not support randomness.seed' },
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

it.each([0, -1, 1.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid embedded token budget %s before invoking a provider', async tokens => {
    await expect(backend.call(request({ tokens }))).rejects.toMatchObject({ statusCode: 'runtime_error' });
    expect(requests).toHaveLength(0);
    expect(sdk.model).not.toHaveBeenCalled();
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

it('does not expose tools or initialize MCP during ask', async () => {
    backend = new AiBackend({ cwd, timeoutMs: 2000, logger: new Logger('silent'), mcpServers: { docs: { command: 'never-start' } } });
    await backend.call(request());
    expect(requests[0].tools ?? []).toHaveLength(0);
    expect(sdk.mcp).not.toHaveBeenCalled();
});

it('denies a tool attempt during generation even when the provider ignores the empty tool list', async () => {
    steps = [[call('readFile', { path: 'secret' }), ...text('Ignored denial'), finish()]];
    await expect(backend.call(request())).rejects.toMatchObject({ statusCode: 'restriction_violation' });
});

it('exposes exactly the runtime tool set for explicit agents', async () => {
    await backend.call(request({ kind: 'agent' }));
    expect(requests[0].tools?.map(tool => tool.name).sort()).toEqual(Object.keys(TOOL_SPECS).sort());
});

it('serializes multiple actions requested together and supplies actual results to the next step', async () => {
    steps = [[call('saveVariable', { name: 'answer', value: 42 }, 'first'),
        call('loadVariable', { name: 'answer' }, 'second'), finish('tool-calls')], [...text('Done'), finish()]];
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
    expect(invoked).toEqual(['saveVariable', 'loadVariable']);
    expect(JSON.stringify(requests[1].prompt)).toContain('{"value":42}'.replaceAll('"', '\\"'));
});

it.each([
    new Failure('runtime_error', 'missing function'), new Failure('validation_failed', 'invalid'),
    new Failure('tool_error', 'write failed'), new Failure('restriction_violation', 'denied'),
    new Failure('explicit_failure', 'stop'), new Error('unexpected tool failure'), new SuccessSignal(42),
])('preserves the original action failure/control signal and never executes a later action: %s', async error => {
    steps = [[call('callFunction', { name: 'missing', args: [] }), call('saveVariable', { name: 'later', value: 1 }), finish('tool-calls')]];
    const invokeAction = vi.fn(async () => { throw error; });
    await expect(command({ invokeAction })).rejects.toBe(error);
    expect(invokeAction).toHaveBeenCalledOnce();
    expect(requests).toHaveLength(1);
    expect(requests[0].abortSignal?.aborted).toBe(true);
});

it('rejects invalid runtime arguments without calling the host', async () => {
    steps = [[call('saveVariable', { name: 'answer' }), finish('tool-calls')]];
    const invokeAction = vi.fn(async () => null);
    await expect(command({ invokeAction })).rejects.toMatchObject({ statusCode: 'runtime_error' });
    expect(invokeAction).not.toHaveBeenCalled();
});

it.each(['', ' \n'])('accepts action-only completion with %j prose, but not empty generation', async prose => {
    steps = [[call('saveVariable', { name: 'answer', value: 42 }), finish('tool-calls')], [...text(prose), finish()]];
    expect(await command()).toMatchObject({ text: 'Actions completed.' });
    steps = [[...text(prose), finish()]];
    await expect(backend.call(request())).rejects.toThrow('empty response');
});

it('lets explicit agents recover ordinary tool errors, but not restriction violations', async () => {
    const tools = request().tools;
    const invoke = vi.spyOn(tools, 'invoke').mockRejectedValueOnce(new Failure('tool_error', 'missing file'));
    steps = [[call('readFile', { path: 'missing.txt' }), finish('tool-calls')], [...text('Not found'), finish()]];
    expect(await backend.call(request({ kind: 'agent', tools }))).toMatchObject({ text: 'Not found' });
    invoke.mockRejectedValueOnce(new Failure('restriction_violation', 'blocked'));
    steps = [[call('readFile', { path: 'secret.txt' }), finish('tool-calls')]];
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
    steps = [[...text('Preview'), call('saveVariable', { name: 'x', value: 1 }), call('saveVariable', { name: 'later', value: 2 }), finish()]];
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
    steps = [[call('mcp0Search', { query: 'SPL' }), finish('tool-calls')], [...text('Found'), finish()]];
    const result = await command();
    expect(requests[0].tools?.map(tool => tool.name)).toEqual([...AGENT_TOOLS.map(tool => tool.name), 'mcp0Search']);
    expect(mcp.callTool).toHaveBeenCalledWith(expect.objectContaining({ name: 'search', arguments: { query: 'SPL' }, options: expect.objectContaining({ timeout: 500 }) }));
    expect(JSON.parse(result.toolResults![0])).toMatchObject({ server: 'docs', tool: 'search', success: true, result: { content: [{ text: 'Verified documentation' }] } });
    expect(mcp.close).toHaveBeenCalledOnce();
    if (type !== 'stdio') expect(sdk.mcp).toHaveBeenCalledWith(expect.objectContaining({ transport: { type, url: config.url, headers: config.headers } }));
});

it('names MCP tools mcp<Index><Tool>, numbering the servers that start and keeping names unique', async () => {
    const docs = client([tool('search'), tool('search_docs'), tool('search-docs'), tool('get.page.v2'), tool('listIssues')]);
    const issues = client([tool('search')]);
    sdk.mcp.mockResolvedValueOnce(docs).mockResolvedValueOnce(issues);
    const mcpServers = { docs: { command: 'node' }, issues: { command: 'node' } };
    backend = new AiBackend({ cwd, timeoutMs: 2000, logger: silent, mcpServers });
    steps = [[call('mcp0SearchDocs2', {}), call('mcp1Search', {}, 'second'), finish('tool-calls')], [...text('Found'), finish()]];
    const result = await backend.call(request({ kind: 'agent' }));
    expect(requests[0].tools.filter(tool => tool.name.startsWith('mcp')).map(tool => [tool.name, tool.description])).toEqual([
        ['mcp0Search', 'MCP docs/search: search'], ['mcp0SearchDocs', 'MCP docs/search_docs: search_docs'],
        ['mcp0SearchDocs2', 'MCP docs/search-docs: search-docs'], ['mcp0GetPageV2', 'MCP docs/get.page.v2: get.page.v2'],
        ['mcp0ListIssues', 'MCP docs/listIssues: listIssues'], ['mcp1Search', 'MCP issues/search: search'],
    ]);
    expect(docs.callTool).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ name: 'search-docs' }));
    expect(issues.callTool).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ name: 'search' }));
    expect(result.toolResults!.map(item => JSON.parse(item))).toMatchObject([{ server: 'docs', tool: 'search-docs' }, { server: 'issues', tool: 'search' }]);
    // A server the restrictions exclude takes no index.
    sdk.mcp.mockResolvedValueOnce(client([tool('search')]));
    steps = [[...text('Done'), finish()]];
    await backend.call(request({ kind: 'agent', restrictions: new Restrictions(cwd).with(makeRestriction('mcp', 'issues', cwd)) }));
    expect(requests.at(-1)!.tools.map(tool => tool.name)).toEqual([...Object.keys(TOOL_SPECS), 'mcp0Search']);
});

it('does not start excluded MCP servers and offers only the tools the restrictions allow', async () => {
    const restrictions = new Restrictions(cwd).with(makeRestriction('mcp', 'docs/write', cwd));
    const mcp = client();
    sdk.mcp.mockResolvedValue(mcp);
    backend = new AiBackend({ cwd, timeoutMs: 2000, logger: new Logger('silent'), mcpServers: { docs: { command: 'node' }, excluded: { command: 'never-start' } } });
    steps = [[call('mcp0Search', { query: 'SPL' }), finish('tool-calls')]];
    await expect(command({ restrictions })).rejects.toMatchObject({
        statusCode: 'restriction_violation', reason: "tool 'mcp0Search' is not enabled by the runtime",
    });
    expect(requests[0].tools.map(tool => tool.name)).toEqual([...AGENT_TOOLS.map(tool => tool.name), 'mcp0Write']);
    expect(sdk.mcp).toHaveBeenCalledOnce();
    expect(mcp.callTool).not.toHaveBeenCalled();
    expect(mcp.close).toHaveBeenCalledOnce();
});

it('stops on an unsuccessful MCP result before any subsequent runtime action', async () => {
    const mcp = client();
    mcp.callTool.mockResolvedValue({ isError: true, content: [{ type: 'text', text: 'server failed' }] });
    sdk.mcp.mockResolvedValue(mcp);
    backend = new AiBackend({ cwd, timeoutMs: 2000, logger: new Logger('silent'), mcpServers: { docs: { command: 'node' } } });
    steps = [[call('mcp0Search', { query: 'SPL' }), call('saveVariable', { name: 'later', value: 42 }), finish('tool-calls')]];
    const invokeAction = vi.fn(async () => null);
    await expect(command({ invokeAction })).rejects.toMatchObject({ statusCode: 'tool_error', reason: expect.stringContaining('server failed') });
    expect(invokeAction).not.toHaveBeenCalled();
    expect(mcp.close).toHaveBeenCalledOnce();
});

it('logs agent built-in and MCP tool calls once each', async () => {
    const events: LogEvent[] = [];
    const mcp = client();
    mcp.callTool.mockResolvedValueOnce({ isError: true, content: [{ type: 'text', text: 'server failed' }] });
    sdk.mcp.mockResolvedValue(mcp);
    backend = new AiBackend({ cwd, timeoutMs: 2000, logger: new Logger('info', undefined, { eventSink: event => events.push(event) }),
        mcpServers: { docs: { command: 'node' } } });
    const tools = request().tools;
    vi.spyOn(tools, 'invoke').mockResolvedValueOnce('file text').mockRejectedValueOnce(new Failure('tool_error', 'missing file'));
    steps = [
        [call('readFile', { path: 'a.md' }), finish('tool-calls')],
        [call('readFile', { path: 'b.md' }), finish('tool-calls')],
        [call('mcp0Search', { query: 'SPL' }), finish('tool-calls')],
        [...text('Done'), finish()],
    ];
    expect(await backend.call(request({ kind: 'agent', tools }))).toMatchObject({ text: 'Done' });
    expect(events.filter(event => event.kind === 'tool').map(event => event.kind === 'tool' && event.tool)).toEqual([
        { name: 'readFile', target: 'a.md', status: 'success' },
        { name: 'readFile', target: 'b.md', status: 'error' },
        { name: 'docs/search', target: '{"query":"SPL"}', status: 'error' },
    ]);
});

it('allows explicit agents to recover a non-restriction MCP failure', async () => {
    const mcp = client();
    mcp.callTool.mockRejectedValueOnce(new Error('temporary tool failure'));
    sdk.mcp.mockResolvedValue(mcp);
    backend = new AiBackend({ cwd, timeoutMs: 2000, logger: new Logger('silent'), mcpServers: { docs: { command: 'node' } } });
    steps = [[call('mcp0Search', { query: 'SPL' }), finish('tool-calls')], [...text('Tool unavailable'), finish()]];
    const result = await backend.call(request({ kind: 'agent' }));
    expect(result.text).toBe('Tool unavailable');
    expect(JSON.parse(result.toolResults![0])).toMatchObject({ success: false, error: expect.stringContaining('temporary tool failure') });
    expect(JSON.stringify(requests[1].prompt)).toContain('temporary tool failure');
});

/** Reasoning settings for a model, with the warnings that choosing them produced. */
const reasoning = (provider: Provider, model: string, level?: ReasoningLevel, sampling = false) => {
    const { logger, events } = collecting();
    return { ...reasoningOptions(provider, model, level, true, logger, sampling), warnings: events.map(body) };
};

it.each([
    ['openai', 'gpt-5', { openai: { reasoningEffort: 'high' } }],
    ['anthropic', 'claude-sonnet-4-5', { anthropic: { thinking: { type: 'enabled', budgetTokens: 16384 } } }],
    ['anthropic', 'claude-sonnet-4-6', { anthropic: { thinking: { type: 'adaptive' }, effort: 'high' } }],
    ['google', 'gemini-2.5-flash', { google: { thinkingConfig: { thinkingBudget: 16384, includeThoughts: true } } }],
    ['google', 'gemini-3-flash-preview', { google: { thinkingConfig: { thinkingLevel: 'high' } } }],
] as const)('maps reasoning for %s/%s', (provider, model, expected) => {
    expect(reasoning(provider, model, 'high')).toMatchObject({ effort: 'high', options: expected, warnings: [] });
});

it.each([
    ['openai', 'gpt-5', { openai: { reasoningEffort: 'medium' } }],
    ['anthropic', 'claude-sonnet-4-5', { anthropic: { thinking: { type: 'enabled', budgetTokens: 4096 } } }],
    ['anthropic', 'claude-sonnet-4-6', { anthropic: { thinking: { type: 'adaptive' }, effort: 'medium' } }],
    ['google', 'gemini-2.5-flash', { google: { thinkingConfig: { thinkingBudget: 4096, includeThoughts: true } } }],
    ['google', 'gemini-3-flash-preview', { google: { thinkingConfig: { thinkingLevel: 'medium' } } }],
] as const)('defaults to medium reasoning for %s/%s, or to none with sampling', (provider, model, expected) => {
    expect(reasoning(provider, model)).toMatchObject({ effort: 'medium', options: expected, warnings: [] });
    expect(reasoning(provider, model, 'medium')).toEqual(reasoning(provider, model));
    expect(reasoning(provider, model, undefined, true)).toMatchObject({ effort: 'none', warnings: [] });
    expect(reasoning(provider, model, undefined, true)).toEqual(reasoning(provider, model, 'none'));
    expect(reasoning(provider, model, 'medium', true)).toEqual(reasoning(provider, model));
});

it.each([
    ['openai', 'gpt-5'], ['openai', 'gpt-5-pro'], ['anthropic', 'claude-sonnet-4-5'], ['anthropic', 'claude-sonnet-4-6'],
    ['google', 'gemini-2.5-flash'], ['google', 'gemini-2.5-pro'], ['google', 'gemini-3-pro-preview'],
] as const)('leaves the provider minimum of reasoning none for %s/%s to the request', (provider, model) => {
    expect(reasoning(provider, model, 'none')).toEqual({
        effort: 'none', warnings: [],
        options: provider === 'openai' ? { openai: { parallelToolCalls: false, store: false, reasoningSummary: 'auto' } }
            : provider === 'anthropic' ? { anthropic: { disableParallelToolUse: true } } : { google: { thinkingConfig: { includeThoughts: true } } },
    });
});

it.each([
    ['openai', 'gpt-5', 'high', { openai: { reasoningEffort: 'high' } }],
    ['openai', 'gpt-5.1', 'high', { openai: { reasoningEffort: 'high' } }],
    ['openai', 'gpt-5.2', 'max', { openai: { reasoningEffort: 'xhigh' } }],
    ['openai', 'gpt-6-luna', 'max', { openai: { reasoningEffort: 'xhigh' } }],
    ['openai', 'gpt-5-pro', 'high', { openai: { reasoningEffort: 'high' } }],
    ['openai', 'o3', 'high', { openai: { reasoningEffort: 'high' } }],
    ['anthropic', 'claude-3-7-sonnet-20250219', 'max', { anthropic: { thinking: { type: 'enabled', budgetTokens: 32768 } } }],
    ['anthropic', 'claude-sonnet-4-5', 'max', { anthropic: { thinking: { type: 'enabled', budgetTokens: 32768 } } }],
    ['anthropic', 'claude-opus-4-8', 'max', { anthropic: { thinking: { type: 'adaptive' }, effort: 'max' } }],
    ['google', 'gemini-2.5-flash', 'max', { google: { thinkingConfig: { thinkingBudget: 24576 } } }],
    ['google', 'gemini-2.5-pro', 'max', { google: { thinkingConfig: { thinkingBudget: 32768 } } }],
    ['google', 'gemini-3-flash-preview', 'high', { google: { thinkingConfig: { thinkingLevel: 'high' } } }],
    ['google', 'gemini-3-pro-preview', 'high', { google: { thinkingConfig: { thinkingLevel: 'high' } } }],
] as const)('maps reasoning max to the strongest effort of %s/%s: %s', (provider, model, effort, expected) => {
    expect(reasoning(provider, model, 'max')).toMatchObject({ effort, options: expected });
});

it.each([
    ['openai', 'gpt-5-pro', 'low', 'high', { openai: { reasoningEffort: 'high' } }],
    ['openai', 'gpt-5-pro', 'medium', 'high', { openai: { reasoningEffort: 'high' } }],
    ['google', 'gemini-3-pro-preview', 'medium', 'high', { google: { thinkingConfig: { thinkingLevel: 'high' } } }],
    ['google', 'gemini-3.0-pro', 'medium', 'high', { google: { thinkingConfig: { thinkingLevel: 'high' } } }],
] as const)('falls back from a level %s/%s lacks (%s) to the nearest one, with a warning naming it', (provider, model, level, effort, expected) => {
    expect(reasoning(provider, model, level)).toMatchObject({
        effort, options: expected, warnings: [`model '${model}' does not support reasoning '${level}'; using '${effort}'`],
    });
    // The default level is not something the workflow asked for: the same fallback stays silent.
    if (level === 'medium') expect(reasoning(provider, model)).toMatchObject({ effort, options: expected, warnings: [] });
});

it.each([
    ['openai', 'gpt-4.1'], ['openai', 'o1-mini'], ['anthropic', 'claude-3-5-haiku-20241022'], ['google', 'gemini-2.0-flash'],
] as const)('sends no thinking controls to %s/%s, which cannot reason, and warns only about a requested level', (provider, model) => {
    for (const level of ['low', 'medium', 'high', 'max'] as const) {
        const { options, warnings, ...rest } = reasoning(provider, model, level);
        expect(rest).toEqual({});
        expect(options).toEqual(reasoning(provider, model).options);
        expect(warnings).toEqual([`model '${model}' does not support reasoning '${level}'; using the model default`]);
    }
    for (const result of [reasoning(provider, model), reasoning(provider, model, 'none'), reasoning(provider, model, undefined, true)]) {
        expect(result).not.toHaveProperty('effort');
        expect(result.warnings).toEqual([]);
        expect(JSON.stringify(result.options)).not.toMatch(/reasoningEffort|thinking|effort/);
    }
});

it('warns and records no effective effort for an unsupported reasoning model', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn');
    expect(await backend.call(request({ model: 'gpt-4.1', reasoningEffort: 'high' }))).toMatchObject({ effective: { reasoningEffort: null } });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('using the model default'));
    warn.mockRestore();
});

it('requests reasoning summaries only where they exist and are shown', () => {
    expect(reasoningOptions('google', 'gemini-2.5-flash', undefined, true, silent).options).toMatchObject({ google: { thinkingConfig: { includeThoughts: true } } });
    expect(reasoningOptions('google', 'gemini-2.5-flash', undefined, false, silent).options).toMatchObject({ google: { thinkingConfig: { includeThoughts: false } } });
    expect(reasoningOptions('openai', 'gpt-5', undefined, true, silent).options.openai).toMatchObject({ reasoningSummary: 'auto' });
    expect(reasoningOptions('openai', 'gpt-5', undefined, false, silent).options.openai).toMatchObject({ reasoningSummary: null });
    expect(reasoningOptions('openai', 'gpt-4.1', undefined, true, silent).options.openai).not.toHaveProperty('reasoningSummary');
});

it.each([
    [undefined, 'medium', 'medium'], ['none', 'none', undefined], ['low', 'low', 'low'], ['high', 'high', 'high'], ['max', 'max', 'xhigh'],
] as const)('sends reasoning %s as %s and reports it as the effective level', async (reasoningEffort, effective, sent) => {
    const warn = vi.spyOn(Logger.prototype, 'warn');
    try {
        expect(await backend.call(request({ model: 'openai/gpt-6-luna', reasoningEffort }))).toMatchObject({ effective: { reasoningEffort: effective } });
        expect(requests[0].providerOptions.openai?.reasoningEffort).toBe(sent);
        expect(requests[0].reasoning).toBe(effective === 'none' ? 'none' : undefined);
        expect(warn).not.toHaveBeenCalled();
    } finally {
        warn.mockRestore();
    }
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
    ['low', 'temperature'], ['medium', 'topP'], ['high', 'temperature'], ['max', 'topP'],
] as const)('fails when requested reasoning %s meets a %s setting the provider rejects, naming both', async (reasoningEffort, feature) => {
    steps = [[conflict(feature), call('saveVariable', { name: 'answer', value: 42 }), finish('tool-calls')]];
    const invokeAction = vi.fn(async () => null);
    const error = await command({ model: 'openai/gpt-6-luna', reasoningEffort, randomness: { temperature: 0, top_p: 0.5 }, invokeAction }).catch(error => error);
    expect(error).toBeInstanceOf(LlmError);
    expect(error.message).toBe(`reasoning '${reasoningEffort}' cannot be combined with ${feature} on openai/gpt-6-luna; drop one of the two settings`);
    expect(invokeAction).not.toHaveBeenCalled();
    expect(requests).toHaveLength(1);
    expect(requests[0].abortSignal.aborted).toBe(true);
});

it.each([undefined, 'none'] as const)('only warns about rejected sampling when reasoning is %s: nothing was insisted on', async reasoningEffort => {
    steps[0].unshift(conflict('temperature'));
    const warn = vi.spyOn(Logger.prototype, 'warn');
    try {
        const result = await backend.call(request({ model: 'openai/gpt-5', reasoningEffort, randomness: { seed: 3, temperature: 0 } }));
        expect(result).toMatchObject({ text: 'Final answer', effective: { reasoningEffort: 'none', randomness: { seed: 3, temperature: null, top_p: null } } });
        expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('"conflict":"reasoning"'));
    } finally {
        warn.mockRestore();
    }
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

describe('workflows on the provider backend', () => {
    const factorial = 'function factorial(n: number): number {\n    return n === 0 ? 1 : n * factorial(n - 1);\n}';
    /** A value as it appears in a tool result, which is JSON text inside the JSON of the conversation. */
    const escaped = (value: unknown): string => JSON.stringify(JSON.stringify(value)).slice(1, -1);

    it('executes a factorial instruction and saves the real function result in the same conversation', async () => {
        steps = [[call('callFunction', { name: 'factorial', args: [15] }), finish('tool-calls')],
            [call('saveVariable', { name: 'fact15', value: 1307674368000 }), finish('tool-calls')],
            [...text(''), finish()]];
        const instruction = 'Invoke @factorial with 15 as argument ->[Int] @fact15';
        const result = await exec(`${factorial}\n${agentBlock(instruction)}\nsuccess(fact15);`, { cwd, backend });
        expect(result).toEqual({ status: 'success', value: 1307674368000, hasValue: true });
        expect(requests).toHaveLength(3);
        expect(JSON.stringify(requests[1].prompt)).toContain('1307674368000');
        expect(requests[0].tools?.map(tool => tool.name)).toEqual(AGENT_TOOLS.map(tool => tool.name));
        expect(requests[0].prompt[0]).toMatchObject({ role: 'user', content: [{ text: expect.stringContaining(`Instruction:\n${instruction}`) }] });
    });

    it('gives an agent block types, async functions and coerced saves through runtime tools', async () => {
        steps = [[call('loadVariable', { name: 'Review' }), finish('tool-calls')],
            [call('callFunction', { name: 'grade', args: ['four'] }), finish('tool-calls')],
            [call('saveVariable', { name: 'review', value: { score: '4' } }), finish('tool-calls')],
            [...text('Saved the review.'), finish()]];
        const result = await exec(`const Review = Struct('Review', { score: Int.describe('Characters') }).methods({ stars() { return '*'.repeat(this.score); } });
async function grade(text: string): Promise<number> { await 0; return text.length; }
${agentBlock('Grade the word with @grade and save a @Review ->[Review] @review')}
success(review.stars());`, { cwd, backend });
        expect(result).toMatchObject({ status: 'success', value: '****' });
        expect(JSON.stringify(requests[1].prompt)).toContain(escaped({ description: 'Characters' }).slice(1, -1));
        expect(JSON.stringify(requests[2].prompt)).toContain(escaped({ value: 4 }));
        expect(JSON.stringify(requests[3].prompt)).toContain(escaped({ value: { score: 4 } }));
    });

    it('keeps the failure of a workflow function, aborts the model turn and never runs a later action', async () => {
        steps = [[call('callFunction', { name: 'explode', args: [] }), call('saveVariable', { name: 'later', value: 1 }), finish('tool-calls')],
            [...text('unreachable'), finish()]];
        const result = await exec(`function explode(): never {\n    throw new TypeError('boom');\n}\n${agentBlock('Call @explode -> @later')}\nsuccess(later);`, { cwd, backend });
        expect(result).toMatchObject({ status: 'failure', failure: {
            status_code: 'runtime_error', reason: 'TypeError: boom', line: 2, command: "throw new TypeError('boom');",
        } });
        expect(requests).toHaveLength(1);
        expect(requests[0].abortSignal.aborted).toBe(true);
    });

    it('returns an invalid save to the model, and fails with validation_failed after two corrections', async () => {
        const source = `${agentBlock('Rate it ->[Int] @rating')}\nsuccess(rating);`;
        const rate = (value: unknown) => [call('saveVariable', { name: 'rating', value }), finish('tool-calls')];
        steps = [rate('high'), rate(4.5), rate('4'), [...text('Saved.'), finish()]];
        expect(await exec(source, { cwd, backend })).toEqual({ status: 'success', value: 4, hasValue: true });
        expect(requests).toHaveLength(4);
        expect(JSON.stringify(requests[1].prompt)).toContain(escaped({ value: { rejected: 'rating: expected Int, got "high"', hint: 'Correct the value and save @rating again.' } }));
        expect(JSON.stringify(requests[2].prompt)).toContain(escaped({ rejected: 'rating: expected Int, got 4.5' }).slice(1, -1));
        requests = [];
        steps = [rate('high'), rate('higher'), rate('highest'), [...text('unreachable'), finish()]];
        expect(await exec(source, { cwd, backend })).toMatchObject({ status: 'failure', failure: {
            status_code: 'validation_failed', reason: '@rating is still invalid after 2 corrections: rating: expected Int, got "highest"',
            line: 1, command: 'Rate it ->[Int] @rating',
        } });
        expect(requests).toHaveLength(3);
        expect(requests[2].abortSignal.aborted).toBe(true);
    });

    it('ends the workflow as soon as a function called by the agent calls success', async () => {
        steps = [[call('callFunction', { name: 'finish', args: [] }), call('saveVariable', { name: 'later', value: 1 }), finish('tool-calls')]];
        const source = `function finish(): never {\n    success({ ok: true });\n}\n${agentBlock('Finish with @finish -> @later')}\nfail('unreachable');`;
        expect(await exec(source, { cwd, backend })).toEqual({ status: 'success', value: { ok: true }, hasValue: true });
        expect(requests).toHaveLength(1);
        expect(requests[0].abortSignal.aborted).toBe(true);
    });

    it('answers askHuman and getEnv actions from the run, and returns their results to the model', async () => {
        vi.stubEnv('SPL_AI_TEST_VALUE', 'from-env');
        steps = [[call('askHuman', { question: 'Proceed?' }), call('getEnv', { name: 'SPL_AI_TEST_VALUE' }), finish('tool-calls')],
            [...text('Asked.'), finish()]];
        const questions: string[] = [];
        expect(await exec(agentBlock('Ask whether to proceed'), { cwd, backend, human: question => { questions.push(question); return 'yes'; } }))
            .toMatchObject({ status: 'success' });
        expect(questions).toEqual(['Proceed?']);
        const results = JSON.stringify(requests[1].prompt);
        expect(results).toContain(escaped({ value: 'yes' }));
        expect(results).toContain(escaped({ value: 'from-env' }));
    });

    it('runs agent() file tools inside the working directory and stops on a restriction violation', async () => {
        fs.writeFileSync(path.join(cwd, 'secret.txt'), 'top secret');
        steps = [[call('writeFile', { path: './out/note.txt', content: 'written' }), finish('tool-calls')], [...text('Wrote it'), finish()],
            [call('readFile', { path: './out/missing.txt' }), finish('tool-calls')], [...text('Not found'), finish()],
            [call('readFile', { path: './secret.txt' }), finish('tool-calls')], [...text('unreachable'), finish()]];
        const result = await exec(`
const reports = await restrict('./out', async () => [await agent('Write the note'), await agent('Read a missing file')]);
let blocked;
try {
    await restrict('./out', () => agent('Read the secret'));
} catch (error) {
    blocked = [error.statusCode, error.reason.includes('secret.txt')];
}
success([reports, blocked, await readFile('./out/note.txt')]);`, { cwd, backend });
        expect(result).toMatchObject({ status: 'success', value: [['Wrote it', 'Not found'], ['restriction_violation', true], 'written'] });
        expect(requests).toHaveLength(5);
        expect(requests[0].tools.map(tool => tool.name)).toEqual(Object.keys(TOOL_SPECS));
        expect(requests[0].prompt[0]).toMatchObject({ content: [{ text: expect.stringContaining(`File system: you may read and write only inside: ${path.join(cwd, 'out')}.`) }] });
        expect(JSON.stringify(requests[3].prompt)).toContain('missing.txt');
        expect(steps).toHaveLength(1);
    });

    it('forwards block and per-call model, reasoning, token and sampling settings, and reports the effective ones', async () => {
        steps = ['one', 'two', 'three', 'four', 'five'].map(answer => [...text(answer), finish()]);
        const { logger: recorder, events } = collecting('info');
        const source = `${block('One', 'outputVar: one', 'model: google/gemini-2.5-flash', 'reasoning: max', 'tokens: 128', 'hide: true')}
success([
    one,
    await ask('Two', { seed: 7, temperature: 0, topP: 0.5 }),
    await ask('Three', { model: 'anthropic/claude-sonnet-4-6' }),
    await ask('Four', { model: 'gpt-6-luna', reasoning: 'none' }),
]);`;
        expect(await exec(source, { cwd, backend, logger: recorder })).toMatchObject({ status: 'success', value: ['one', 'two', 'three', 'four'] });
        expect(requests[0]).toMatchObject({ tokens: 128, providerOptions: { google: { thinkingConfig: { thinkingBudget: 24576, includeThoughts: false } } } });
        expect(requests[1]).toMatchObject({ seed: 7, temperature: 0, topP: 0.5 });
        expect(requests[1].tokens).toBeUndefined();
        expect(requests[2]).toMatchObject({ providerOptions: { anthropic: { thinking: { type: 'adaptive' }, effort: 'medium' } } });
        expect(requests[3]).toMatchObject({ reasoning: 'none' });
        expect(requests[3].providerOptions.openai).not.toHaveProperty('reasoningEffort');
        expect(sdk.google).toHaveBeenCalledWith({ apiKey: 'test-google-key' });
        expect(sdk.openai).toHaveBeenCalledWith({ apiKey: 'test-openai-key' });
        expect(sdk.anthropic).toHaveBeenCalledWith({ apiKey: 'test-anthropic-key' });
        const effective = events.filter(event => event.kind === 'info').map(event => JSON.parse(body(event).split('\n')[1].replace(/ \(\d+ ms\)$/, '')));
        expect(effective).toEqual([
            { backend: 'native-sdk', provider: 'google', model: 'gemini-2.5-flash', reasoningEffort: 'max', tokens: 128 },
            { backend: 'native-sdk', provider: 'openai', model: 'gpt-4.1', reasoningEffort: null, randomness: { seed: 7, temperature: 0, top_p: 0.5 } },
            { backend: 'native-sdk', provider: 'anthropic', model: 'claude-sonnet-4-6', reasoningEffort: 'medium' },
            { backend: 'native-sdk', provider: 'openai', model: 'gpt-6-luna', reasoningEffort: 'none' },
        ]);
        await exec("await ask('Five', { model: 'google/gemini-2.5-flash' });", { cwd, backend, model: 'anthropic/claude-sonnet-4-5' });
        expect(sdk.anthropic).toHaveBeenCalledTimes(2);
    });

    it.each(['none', 'low', 'medium', 'high', 'max'] as const)('accepts reasoning %s in block headers, ask() and agent()', async level => {
        steps = ['one', 'two', 'three', 'four'].map(answer => [...text(answer), finish()]);
        const source = `---\nmodel: gpt-6-luna\n---
${block('One', 'outputVar: one', `reasoning: ${level}`)}
${agentBlock('Two', `reasoning: ${level}`)}
success([one, await ask('Three', { reasoning: '${level}' }), await agent('Four', { reasoning: '${level}' })]);`;
        expect(await exec(source, { cwd, backend })).toMatchObject({ status: 'success', value: ['one', 'three', 'four'] });
        const sent = { none: undefined, low: 'low', medium: 'medium', high: 'high', max: 'xhigh' }[level];
        expect(requests.map(request => [request.providerOptions.openai?.reasoningEffort, request.reasoning]))
            .toEqual(new Array(4).fill([sent, level === 'none' ? 'none' : undefined]));
    });

    it('rejects an unknown reasoning level before calling a provider', async () => {
        expect(await exec("await ask('Prompt', { reasoning: 'think' });", { cwd, backend })).toMatchObject({
            status: 'failure', failure: { status_code: 'runtime_error', reason: 'reasoning must be none, low, medium, high, or max', line: 1 },
        });
        await expect(exec(block('Prompt', 'outputVar: answer', 'reasoning: think'), { cwd, backend })).rejects.toThrow('`reasoning` must be none, low, medium, high or max');
        expect(requests).toHaveLength(0);
    });

    it('streams provider previews and reasoning into the run logger', async () => {
        steps = [[
            { type: 'reasoning-start', id: 'why' }, { type: 'reasoning-delta', id: 'why', delta: 'Because.' }, { type: 'reasoning-end', id: 'why' },
            ...text('Final answer'), finish(),
        ]];
        const streams: ModelStreamEvent[] = [];
        const result = await exec("success(await ask('Prompt', { model: 'gpt-5', reasoning: 'high' }));", { cwd, backend, logger: new Logger('error', () => {}, { streamSink: event => streams.push(event) }) });
        expect(result).toMatchObject({ status: 'success', value: 'Final answer' });
        expect(requests[0].providerOptions).toMatchObject({ openai: { reasoningEffort: 'high', reasoningSummary: 'auto' } });
        expect(streams.map(event => event.type === 'update' ? [event.update.channel, event.update.messageId, event.update.mode, event.update.text] : [event.type, event.outcome])).toEqual([
            ['reasoning', '0:why', 'append', 'Because.'], ['reasoning', '0:why', 'replace', 'Because.'],
            ['response', '0:answer', 'append', 'Final answer'], ['response', '0:answer', 'replace', 'Final answer'],
            ['end', 'completed'],
        ]);
        expect(streams.at(-1)).toMatchObject({ response: 'Final answer', reasoning: 'Because.', interaction: { kind: 'ask' } });
    });

    it.each([
        ['an empty response', () => { steps = [[...text(' '), finish()]]; }, 'llm_error', 'the model returned an empty response'],
        ['a truncated turn', () => { steps = [[...text('Partial'), finish('length')]]; }, 'llm_error', 'model turn did not complete (length)'],
        ['a tool attempt during generation', () => { steps = [[call('readFile', { path: 'secret' }), finish('tool-calls')]]; },
            'restriction_violation', 'generation cannot use tools; use an explicit agent operation'],
        ['a missing API key', () => { vi.stubEnv('OPENAI_API_KEY', undefined); }, 'llm_error', 'no API key for openai; set OPENAI_API_KEY or run spl login openai'],
        ['a stalled provider', () => {
            backend = new AiBackend({ cwd, timeoutMs: 30, logger: silent });
            streamOverride = () => new ReadableStream({ start() {} });
        }, 'llm_error', 'model call timed out after 30ms'],
    ])('reports %s as a located workflow failure', async (_name, arrange, code, reason) => {
        arrange();
        expect(await exec("\nconst answer = await ask('Prompt');\nsuccess(answer);", { cwd, backend })).toEqual({
            status: 'failure', failure: { status: 'failure', status_code: code, reason, line: 2, command: "const answer = await ask('Prompt');" },
        });
    });

    it('fails an ask block that requests reasoning together with sampling the provider rejects', async () => {
        steps = [[conflict('temperature'), ...text('unreachable'), finish()], [...text('Sampled'), finish()]];
        const source = (...header: string[]) => `${block('Prompt', 'outputVar: answer', 'model: gpt-6-luna', 'temperature: 0', ...header)}\nsuccess(answer);`;
        expect(await exec(source('reasoning: high'), { cwd, backend })).toEqual({ status: 'failure', failure: {
            status: 'failure', status_code: 'llm_error', line: 1, command: 'Prompt',
            reason: "reasoning 'high' cannot be combined with temperature on openai/gpt-6-luna; drop one of the two settings",
        } });
        expect(steps).toHaveLength(1);
        // Without a requested level the sampled call runs with reasoning off.
        expect(await exec(source(), { cwd, backend })).toEqual({ status: 'success', value: 'Sampled', hasValue: true });
        expect(requests[1]).toMatchObject({ temperature: 0, reasoning: 'none' });
    });

    it('lets workflow code catch a provider failure and continue with another call', async () => {
        steps = [[...text('Partial'), finish('content-filter')], [...text('Recovered'), finish()]];
        const result = await exec(`
let first;
try { await ask('Risky'); } catch (error) { first = [error instanceof Failure, error.statusCode]; }
success([first, await ask('Safe')]);`, { cwd, backend });
        expect(result).toMatchObject({ status: 'success', value: [[true, 'llm_error'], 'Recovered'] });
    });
});
