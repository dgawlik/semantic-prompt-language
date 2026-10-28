import type { PermissionRequest, SessionConfig } from '@github/copilot-sdk';
import { beforeEach, expect, it, vi } from 'vitest';
import { CopilotBackend } from '../src/copilot.js';
import { Logger } from '../src/logger.js';
import { makeRestriction, Restrictions } from '../src/restrict.js';
import { TOOL_SPECS, ToolHost } from '../src/tools.js';
import { AGENT_TOOLS } from '../src/agent.js';
import type { LlmRequest, RuntimeAction } from '../src/llm.js';
import { run } from '../src/interpreter.js';
import { parseMarkdown } from '../src/markdown.js';
import { Failure, SuccessSignal } from '../src/errors.js';

const sdk = vi.hoisted(() => ({
    configs: [] as SessionConfig[],
    disconnect: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
    continueTurn: vi.fn(async () => {}),
    permission: undefined as PermissionRequest | undefined,
    calls: [] as RuntimeAction[],
    results: [] as unknown[],
    toolErrors: [] as unknown[],
    events: [] as { type: string; data: object }[],
    eventsAfterTools: [] as { type: string; data: object }[],
    prompts: [] as string[],
    sendError: undefined as Error | undefined,
    abortRejectsWait: true,
    reply: { data: { content: 'MCP result' } } as { data?: { content?: string } } | undefined,
}));
vi.mock('../src/auth.js', () => ({ loadToken: () => undefined }));
vi.mock('@github/copilot-sdk', () => ({
    defineTool: (name: string, options: object) => ({ name, ...options }),
    CopilotClient: class {
        async start() {}
        async getAuthStatus() { return { isAuthenticated: true }; }
        async stop() { await sdk.stop(); }
        async createSession(config: SessionConfig) {
            sdk.configs.push(config);
            const listeners = new Map<string, (event: { data: object }) => void>();
            let aborted = false;
            return {
                on(type: string, handler: (event: { data: object }) => void) { listeners.set(type, handler); },
                async sendAndWait({ prompt }: { prompt: string }) {
                    sdk.prompts.push(prompt);
                    for (const event of sdk.events) listeners.get(event.type)?.(event);
                    if (sdk.permission) await config.onPermissionRequest?.(sdk.permission, { sessionId: 'test' });
                    for (const call of sdk.calls) {
                        const tool = config.tools?.find(tool => tool.name === call.name);
                        if (!tool) throw new Error(`${call.name} not registered`);
                        try {
                            sdk.results.push(await tool.handler(call.arguments, {
                                sessionId: 'test', toolCallId: 'test', toolName: call.name, arguments: call.arguments,
                            }));
                        } catch (error) {
                            sdk.toolErrors.push(error);
                        }
                    }
                    if (sdk.sendError) throw sdk.sendError;
                    if (aborted) {
                        if (sdk.abortRejectsWait) throw new Error('The requested run was aborted before completion.');
                        return undefined;
                    }
                    for (const event of sdk.eventsAfterTools) listeners.get(event.type)?.(event);
                    await sdk.continueTurn();
                    return sdk.reply;
                },
                disconnect: sdk.disconnect,
                async abort() {
                    await sdk.abort();
                    aborted = true;
                },
            };
        }
    },
}));

beforeEach(() => {
    sdk.configs.length = 0;
    sdk.permission = undefined;
    sdk.calls = [];
    sdk.results = [];
    sdk.toolErrors = [];
    sdk.events = [];
    sdk.eventsAfterTools = [];
    sdk.prompts.length = 0;
    sdk.sendError = undefined;
    sdk.abortRejectsWait = true;
    sdk.reply = { data: { content: 'MCP result' } };
    vi.clearAllMocks();
    sdk.abort.mockReset().mockResolvedValue(undefined);
    sdk.continueTurn.mockReset().mockResolvedValue(undefined);
});

const command = async (prompt: string, invokeAction: NonNullable<LlmRequest['invokeAction']> = async () => null) => {
    const cwd = process.cwd();
    const restrictions = new Restrictions(cwd);
    const backend = new CopilotBackend({ cwd, timeoutMs: 1000, logger: new Logger('silent') });
    try {
        return await backend.call({
            kind: 'agent', naturalLanguage: true, prompt, runtimeTools: AGENT_TOOLS, restrictions,
            showReasoning: false, tools: new ToolHost(restrictions, cwd), invokeAction,
        });
    } finally {
        await backend.close();
    }
};

it('executes multiple runtime actions immediately and returns their results in one session', async () => {
    sdk.calls = [
        { name: 'save_variable', arguments: { name: 'animal', value: 'story' } },
        { name: 'load_variable', arguments: { name: 'animal' } },
    ];
    let invoked = 0;
    const invoke = vi.fn(async (_action: RuntimeAction) => {
        expect(sdk.results).toHaveLength(invoked++);
        return 'story';
    });
    expect(await command('Story -> @animal', invoke)).not.toHaveProperty('action');
    expect(sdk.configs[0].availableTools).toEqual(AGENT_TOOLS.map(tool => tool.name));
    expect(sdk.configs[0].availableTools).not.toContain('submit_spl');
    expect(invoke.mock.calls).toEqual(sdk.calls.map(action => [action]));
    expect(sdk.results).toEqual(['{"value":"story"}', '{"value":"story"}']);
    expect(sdk.prompts).toHaveLength(1);
    expect(sdk.abort).not.toHaveBeenCalled();
});

it.each([
    new Failure('runtime_error', 'missing function'),
    new Failure('validation_failed', 'invalid value'),
    new Failure('tool_error', 'write failed'),
    new Failure('restriction_violation', 'denied'),
    new Failure('explicit_failure', 'stop'),
    new Error('unexpected tool failure'),
    new SuccessSignal(42),
])('stops immediately with the original tool error or control signal: %s', async error => {
    sdk.calls = [
        { name: 'call_function', arguments: { name: 'missing', args: [] } },
        { name: 'save_variable', arguments: { name: 'mustNotRun', value: true } },
    ];
    sdk.continueTurn.mockImplementation(() => new Promise(() => {}));
    const invoke = vi.fn(async () => { throw error; });
    await expect(command('Act', invoke)).rejects.toBe(error);
    expect(invoke).toHaveBeenCalledOnce();
    expect(sdk.abort).toHaveBeenCalledOnce();
    expect(sdk.continueTurn).not.toHaveBeenCalled();
    expect(sdk.disconnect).toHaveBeenCalledOnce();
});

it('preserves a tool failure when an older SDK resolves the aborted wait without a response', async () => {
    sdk.calls = [{ name: 'save_variable', arguments: { name: 'answer', value: 42 } }];
    sdk.abortRejectsWait = false;
    const error = new Failure('runtime_error', 'cannot save');
    await expect(command('Save @answer', vi.fn(async () => { throw error; }))).rejects.toBe(error);
});

it('fails without waiting for a stalled SDK abort or model continuation', async () => {
    sdk.calls = [{ name: 'call_function', arguments: { name: 'missing', args: [] } }];
    sdk.abort.mockImplementation(() => new Promise(() => {}));
    sdk.continueTurn.mockImplementation(() => new Promise(() => {}));
    const error = new Failure('runtime_error', 'missing function');
    await expect(command('Act', async () => { throw error; })).rejects.toBe(error);
    expect(sdk.disconnect).toHaveBeenCalledOnce();
});

it('does not suppress an unrelated abort', async () => {
    sdk.sendError = new Error('The requested run was aborted before completion.');
    await expect(command('Finish')).rejects.toThrow(sdk.sendError.message);
    expect(sdk.abort).not.toHaveBeenCalled();
    expect(sdk.disconnect).toHaveBeenCalledOnce();
});

it('executes a factorial instruction and saves the real function result in the same SDK session', async () => {
    const cwd = process.cwd();
    const backend = new CopilotBackend({ cwd, timeoutMs: 1000, logger: new Logger('silent') });
    sdk.calls = [
        { name: 'call_function', arguments: { name: 'factorial', args: [15] } },
        { name: 'save_variable', arguments: { name: 'fact15', value: 1307674368000 } },
    ];
    sdk.continueTurn.mockImplementation(async () => {
        expect(sdk.results).toEqual(['{"value":1307674368000}', '{"value":1307674368000}']);
    });
    try {
        const result = await run(parseMarkdown([
            '---', 'extension: semantic-prompt-language', 'version: 1', '---', '',
            '```spl', 'def factorial(n) {',
            '    if n == 0 { return 1 }',
            '    return n * factorial(n - 1)', '}', '```', '',
            '> Invoke @factorial with 15 as argument -> @fact15', '',
            '```spl', 'success fact15', '```',
        ].join('\n')), {
            cwd, logger: new Logger('silent'),
            backend,
        });
        expect(result).toEqual({ status: 'success', value: 1307674368000, hasValue: true });
        expect(sdk.prompts).toHaveLength(1);
        expect(sdk.abort).not.toHaveBeenCalled();
    } finally {
        await backend.close();
    }
});

it('fails at the blockquote on an invalid runtime call without executing subsequent actions', async () => {
    const cwd = process.cwd();
    const backend = new CopilotBackend({ cwd, timeoutMs: 1000, logger: new Logger('silent') });
    sdk.calls = [
        { name: 'call_function', arguments: { name: 'missing', args: [] } },
        { name: 'success', arguments: { value: 'must not run' } },
    ];
    try {
        expect(await run(parseMarkdown([
            '---', 'extension: semantic-prompt-language', 'version: 1', '---', '',
            '> Invoke @missing.', '', '```spl', "fail 'must not reach the next block'", '```',
        ].join('\n')), { cwd, backend, logger: new Logger('silent') })).toMatchObject({
            status: 'failure', failure: { status_code: 'runtime_error', line: 6, reason: expect.stringContaining('missing') },
        });
        expect(sdk.prompts).toHaveLength(1);
        expect(sdk.results).toEqual([]);
        expect(sdk.continueTurn).not.toHaveBeenCalled();
        expect(sdk.abort).toHaveBeenCalledOnce();
    } finally {
        await backend.close();
    }
});

it.each([
    'backend unavailable',
    'Timeout after 1000ms waiting for session.idle',
])('preserves unrelated errors after executing an action: %s', async message => {
    sdk.calls = [{ name: 'save_variable', arguments: { name: 'answer', value: 42 } }];
    sdk.sendError = new Error(message);
    await expect(command('Save @answer')).rejects.toThrow(message);
    expect(sdk.disconnect).toHaveBeenCalledOnce();
});

it('preserves the original failure and logs an unsuccessful abort', async () => {
    sdk.calls = [{ name: 'save_variable', arguments: { name: 'answer', value: 42 } }];
    sdk.abort.mockRejectedValueOnce(new Error('abort failed'));
    const warn = vi.spyOn(Logger.prototype, 'warn');
    const error = new Failure('runtime_error', 'cannot save');
    await expect(command('Save @answer', vi.fn(async () => { throw error; }))).rejects.toBe(error);
    expect(warn).toHaveBeenCalledWith('cannot abort the Copilot turn: abort failed');
    warn.mockRestore();
    expect(sdk.disconnect).toHaveBeenCalledOnce();
});

it('executes runtime actions immediately while retaining in-flight MCP results', async () => {
    const cwd = process.cwd();
    const restrictions = new Restrictions(cwd);
    sdk.events = [{
        type: 'tool.execution_start',
        data: { toolCallId: 'mcp-1', toolName: 'mcp:docs-search', mcpServerName: 'docs', mcpToolName: 'search', arguments: { query: 'SPL' } },
    }];
    sdk.eventsAfterTools = [{
        type: 'tool.execution_complete',
        data: { toolCallId: 'mcp-1', success: true, result: { content: 'Verified documentation' } },
    }];
    sdk.calls = [{ name: 'save_variable', arguments: { name: 'answer', value: 42 } }];
    const backend = new CopilotBackend({
        cwd, timeoutMs: 1000, logger: new Logger('silent'), mcpServers: { docs: { command: 'never-start' } },
    });
    try {
        const response = await backend.call({
            kind: 'agent', naturalLanguage: true, runtimeTools: AGENT_TOOLS, prompt: 'Search and save', restrictions,
            showReasoning: false, tools: new ToolHost(restrictions, cwd),
            invokeAction: async () => {
                expect(sdk.continueTurn).not.toHaveBeenCalled();
                return 42;
            },
        });
        expect(response).not.toHaveProperty('action');
        expect(sdk.results).toEqual(['{"value":42}']);
        expect(response.toolResults).toHaveLength(1);
        expect(JSON.parse(response.toolResults![0])).toMatchObject({
            server: 'docs', tool: 'search', result: { content: 'Verified documentation' },
        });
        expect(sdk.abort).not.toHaveBeenCalled();
        expect(sdk.continueTurn).toHaveBeenCalledOnce();
    } finally {
        await backend.close();
    }
});

it.each([
    ['an empty', { data: { content: '' } }],
    ['a whitespace-only', { data: { content: '\n ' } }],
    ['no', undefined],
])('accepts completed actions when the model ends with %s final message', async (_, reply) => {
    const cwd = process.cwd();
    const restrictions = new Restrictions(cwd);
    sdk.calls = [{ name: 'save_variable', arguments: { name: 'modelFib10', value: 55 } }];
    sdk.reply = reply;
    sdk.abortRejectsWait = false;
    const backend = new CopilotBackend({ cwd, timeoutMs: 1000, logger: new Logger('silent') });
    try {
        const response = await backend.call({
            kind: 'agent', naturalLanguage: true, runtimeTools: AGENT_TOOLS, prompt: 'Save the 10th Fibonacci number to @modelFib10', restrictions,
            showReasoning: false, tools: new ToolHost(restrictions, cwd), invokeAction: async () => 55,
        });
        expect(response).toMatchObject({ text: 'Runtime actions completed.' });
        expect(response).not.toHaveProperty('action');
    } finally {
        await backend.close();
    }
});

it('still rejects an empty answer to ordinary generation', async () => {
    const cwd = process.cwd();
    const restrictions = new Restrictions(cwd);
    sdk.reply = { data: { content: '' } };
    const backend = new CopilotBackend({ cwd, timeoutMs: 1000, logger: new Logger('silent') });
    try {
        await expect(backend.call({
            kind: 'ask', prompt: 'Say hi', restrictions, showReasoning: false, tools: new ToolHost(restrictions, cwd),
        })).rejects.toThrow('empty response');
    } finally {
        await backend.close();
    }
});

it('registers runtime tools and configured MCP servers together for blockquotes', async () => {
    const cwd = process.cwd();
    const restrictions = new Restrictions(cwd);
    sdk.calls = [{ name: 'call_function', arguments: { name: 'fib', args: [10] } }];
    sdk.permission = { kind: 'custom-tool', toolName: 'call_function', toolDescription: 'Invoke SPL function' };
    const backend = new CopilotBackend({
        cwd, timeoutMs: 1000, logger: new Logger('silent'), mcpServers: { docs: { command: 'never-start' } },
    });
    try {
        const response = await backend.call({
            kind: 'agent', naturalLanguage: true, runtimeTools: AGENT_TOOLS, prompt: 'Set @answer to 42', restrictions,
            showReasoning: false, tools: new ToolHost(restrictions, cwd), invokeAction: async () => 55,
        });
        expect(response).not.toHaveProperty('action');
        expect(sdk.configs[0].availableTools).toContain('mcp:docs-*');
        expect(sdk.configs[0].tools).toHaveLength(AGENT_TOOLS.length);
        expect(sdk.configs[0].mcpServers).toEqual({ docs: { command: 'never-start', tools: ['*'] } });
        expect(sdk.abort).not.toHaveBeenCalled();
    } finally {
        await backend.close();
    }
});

it('does not treat an aborted MCP turn as a successful completed action', async () => {
    const cwd = process.cwd();
    const restrictions = new Restrictions(cwd);
    sdk.calls = [{ name: 'save_variable', arguments: { name: 'answer', value: 42 } }];
    sdk.sendError = new Error('The requested run was aborted before completion.');
    const backend = new CopilotBackend({
        cwd, timeoutMs: 1000, logger: new Logger('silent'), mcpServers: { docs: { command: 'never-start' } },
    });
    try {
        await expect(backend.call({
            kind: 'agent', naturalLanguage: true, runtimeTools: AGENT_TOOLS, prompt: 'Search and save', restrictions,
            showReasoning: false, tools: new ToolHost(restrictions, cwd), invokeAction: async () => 42,
        })).rejects.toThrow(sdk.sendError.message);
        expect(sdk.abort).not.toHaveBeenCalled();
        expect(sdk.disconnect).toHaveBeenCalledOnce();
    } finally {
        await backend.close();
    }
});

it('accepts a final blockquote answer without requiring generated SPL', async () => {
    expect(await command('Finish')).toMatchObject({ text: 'MCP result' });
    expect(sdk.prompts).toHaveLength(1);
    expect(sdk.abort).not.toHaveBeenCalled();
    expect(sdk.continueTurn).toHaveBeenCalledOnce();
});

it('retains actual MCP results in the response', async () => {
    sdk.events = [
        { type: 'tool.execution_start', data: { toolCallId: 'mcp-1', toolName: 'mcp:docs-search', mcpServerName: 'docs', mcpToolName: 'search', arguments: { query: 'SPL' } } },
        { type: 'tool.execution_complete', data: { toolCallId: 'mcp-1', success: true, result: { content: 'Verified documentation' } } },
    ];
    sdk.calls = [{ name: 'save_variable', arguments: { name: 'answer', value: 'Verified documentation' } }];
    const response = await command('Search and save');
    expect(response.toolResults).toHaveLength(1);
    expect(JSON.parse(response.toolResults![0])).toMatchObject({
        server: 'docs', tool: 'search', result: { content: 'Verified documentation' },
    });
});

it('aborts immediately on a failed MCP tool instead of letting the model continue', async () => {
    sdk.events = [
        { type: 'tool.execution_start', data: { toolCallId: 'mcp-1', toolName: 'mcp:docs-search', mcpServerName: 'docs', arguments: {} } },
        { type: 'tool.execution_complete', data: { toolCallId: 'mcp-1', success: false, error: { message: 'server failed' } } },
    ];
    sdk.calls = [{ name: 'save_variable', arguments: { name: 'answer', value: 42 } }];
    const invoke = vi.fn(async () => null);
    await expect(command('Search and save', invoke)).rejects.toMatchObject({ statusCode: 'tool_error', reason: expect.stringContaining('server failed') });
    expect(invoke).not.toHaveBeenCalled();
    expect(sdk.abort).toHaveBeenCalledOnce();
});

it('checks current MCP restrictions after a runtime action narrows them', async () => {
    const cwd = process.cwd();
    let restrictions = new Restrictions(cwd);
    const backend = new CopilotBackend({
        cwd, timeoutMs: 1000, logger: new Logger('silent'), mcpServers: { docs: { command: 'never-start' } },
    });
    sdk.calls = [{ name: 'restrict', arguments: { kind: 'mcp', value: 'docs/search' } }];
    sdk.continueTurn.mockImplementation(async () => {
        expect(await sdk.configs[0].onPermissionRequest!({
            kind: 'mcp', serverName: 'docs', toolName: 'write', readOnly: false, toolTitle: 'Write',
        }, { sessionId: 'test' })).toMatchObject({ kind: 'reject' });
    });
    try {
        await expect(backend.call({
            kind: 'agent', naturalLanguage: true, runtimeTools: AGENT_TOOLS, prompt: 'Restrict MCP', restrictions,
            currentRestrictions: () => restrictions,
            invokeAction: async () => { restrictions = restrictions.with(makeRestriction('mcp', 'docs/search', cwd)); return null; },
            showReasoning: false, tools: new ToolHost(restrictions, cwd),
        })).rejects.toMatchObject({ statusCode: 'restriction_violation' });
    } finally {
        await backend.close();
    }
});

it('keeps explicit agent expressions on their existing tool set', async () => {
    const cwd = process.cwd();
    const restrictions = new Restrictions(cwd);
    const backend = new CopilotBackend({ cwd, timeoutMs: 1000, logger: new Logger('silent') });
    try {
        await backend.call({ kind: 'agent', prompt: 'Act', restrictions, showReasoning: false, tools: new ToolHost(restrictions, cwd) });
        expect(sdk.configs[0].availableTools).toEqual(Object.keys(TOOL_SPECS));
        expect(sdk.configs[0].availableTools).not.toContain('save_variable');
    } finally {
        await backend.close();
    }
});

it('denies unregistered native tools during blockquote execution', async () => {
    const cwd = process.cwd();
    const restrictions = new Restrictions(cwd);
    sdk.permission = { kind: 'custom-tool', toolName: 'submit_spl', toolDescription: 'Unregistered tool' };
    const backend = new CopilotBackend({ cwd, timeoutMs: 1000, logger: new Logger('silent') });
    try {
        await backend.call({
            kind: 'agent', naturalLanguage: true, runtimeTools: AGENT_TOOLS, prompt: 'Do work', restrictions,
            showReasoning: false, tools: new ToolHost(restrictions, cwd),
        });
        expect(sdk.abort).not.toHaveBeenCalled();
        const decide = sdk.configs[0].onPermissionRequest!;
        expect(await decide(sdk.permission!, { sessionId: 'test' })).toMatchObject({ kind: 'reject' });
    } finally {
        await backend.close();
    }
});

it('aborts and surfaces an MCP restriction violation even if the model returns a response', async () => {
    const cwd = process.cwd();
    const restrictions = new Restrictions(cwd).with(makeRestriction('mcp', 'docs/search', cwd));
    sdk.permission = { kind: 'mcp', serverName: 'docs', toolName: 'write', readOnly: false, toolTitle: 'Write' };
    const backend = new CopilotBackend({
        cwd, timeoutMs: 1000, logger: new Logger('silent'), mcpServers: { docs: { command: 'node' } },
    });
    try {
        await expect(backend.call({
            kind: 'agent', prompt: 'Only search', restrictions, showReasoning: false,
            tools: new ToolHost(restrictions, cwd),
        })).rejects.toMatchObject({ statusCode: 'restriction_violation' });
        expect(sdk.abort).toHaveBeenCalledOnce();
        expect(sdk.disconnect).toHaveBeenCalledOnce();
    } finally {
        await backend.close();
    }
});

it('wires MCP configuration and source-qualified tool filters into SDK sessions', async () => {
    const cwd = process.cwd();
    const restrictions = new Restrictions(cwd).with(makeRestriction('mcp', 'docs/search', cwd));
    const backend = new CopilotBackend({
        cwd, timeoutMs: 1000, logger: new Logger('silent'),
        mcpServers: {
            docs: { command: 'node', args: ['docs-server.js'] },
            other: { command: 'never-start-this-server' },
        },
    });
    try {
        const response = await backend.call({
            kind: 'agent', prompt: 'Search docs', restrictions, showReasoning: false,
            tools: new ToolHost(restrictions, cwd),
        });
        expect(response.text).toBe('MCP result');
        expect(sdk.configs).toHaveLength(1);
        expect(sdk.configs[0].mcpServers).toEqual({ docs: { command: 'node', args: ['docs-server.js'], tools: ['search'] } });
        expect(sdk.configs[0].availableTools).toContain('mcp:docs-*');
        expect(sdk.configs[0].availableTools).not.toContain('mcp:other-*');
        const decide = sdk.configs[0].onPermissionRequest!;
        expect(await decide({
            kind: 'mcp', serverName: 'docs', toolName: 'search', readOnly: true, toolTitle: 'Search',
        }, { sessionId: 'test' })).toEqual({ kind: 'approve-once' });
        expect(sdk.disconnect).toHaveBeenCalledOnce();
    } finally {
        await backend.close();
    }
    expect(sdk.stop).toHaveBeenCalledOnce();
});

it.each(['ask', 'think'] as const)('never exposes tools or starts MCP servers during %s', async (kind) => {
    const cwd = process.cwd();
    const restrictions = new Restrictions(cwd);
    const backend = new CopilotBackend({
        cwd, timeoutMs: 1000, logger: new Logger('silent'),
        mcpServers: { docs: { command: 'must-not-start' } },
    });
    try {
        await backend.call({ kind, prompt: 'Generate', restrictions, showReasoning: false, tools: new ToolHost(restrictions, cwd) });
        expect(sdk.configs[0]).toMatchObject({ tools: [], availableTools: [], mcpServers: {} });
    } finally {
        await backend.close();
    }
});

it('aborts an attempted tool permission request during generation', async () => {
    const cwd = process.cwd();
    const restrictions = new Restrictions(cwd);
    sdk.permission = { kind: 'mcp', serverName: 'docs', toolName: 'search', readOnly: true, toolTitle: 'Search' };
    const backend = new CopilotBackend({ cwd, timeoutMs: 1000, logger: new Logger('silent') });
    try {
        await expect(backend.call({
            kind: 'ask', prompt: 'Generate', restrictions, showReasoning: false, tools: new ToolHost(restrictions, cwd),
        })).rejects.toMatchObject({ statusCode: 'restriction_violation' });
        expect(sdk.abort).toHaveBeenCalledOnce();
    } finally {
        await backend.close();
    }
});
