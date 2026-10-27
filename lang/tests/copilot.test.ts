import type { PermissionRequest, SessionConfig } from '@github/copilot-sdk';
import { beforeEach, expect, it, vi } from 'vitest';
import { CopilotBackend } from '../src/copilot.js';
import { Logger } from '../src/logger.js';
import { makeRestriction, Restrictions } from '../src/restrict.js';
import { TOOL_SPECS, ToolHost } from '../src/tools.js';
import { AGENT_TOOLS } from '../src/agent.js';
import type { RuntimeAction } from '../src/llm.js';

const sdk = vi.hoisted(() => ({
    configs: [] as SessionConfig[],
    disconnect: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
    permission: undefined as PermissionRequest | undefined,
    calls: [] as RuntimeAction[],
    results: [] as unknown[],
    events: [] as { type: string; data: object }[],
    prompts: [] as string[],
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
            return {
                on(type: string, handler: (event: { data: object }) => void) { listeners.set(type, handler); },
                async sendAndWait({ prompt }: { prompt: string }) {
                    sdk.prompts.push(prompt);
                    for (const event of sdk.events) listeners.get(event.type)?.(event);
                    if (sdk.permission) await config.onPermissionRequest?.(sdk.permission, { sessionId: 'test' });
                    for (const call of sdk.calls) {
                        const tool = config.tools?.find(tool => tool.name === call.name);
                        if (!tool) throw new Error(`${call.name} not registered`);
                        sdk.results.push(await tool.handler(call.arguments, {
                            sessionId: 'test', toolCallId: 'test', toolName: call.name, arguments: call.arguments,
                        }));
                    }
                    return sdk.reply;
                },
                disconnect: sdk.disconnect,
                abort: sdk.abort,
            };
        }
    },
}));

beforeEach(() => {
    sdk.configs.length = 0;
    sdk.permission = undefined;
    sdk.calls = [];
    sdk.results = [];
    sdk.events = [];
    sdk.prompts.length = 0;
    sdk.reply = { data: { content: 'MCP result' } };
    vi.clearAllMocks();
});

const command = async (prompt: string) => {
    const cwd = process.cwd();
    const restrictions = new Restrictions(cwd);
    const backend = new CopilotBackend({ cwd, timeoutMs: 1000, logger: new Logger('silent') });
    try {
        return await backend.call({
            kind: 'agent', naturalLanguage: true, prompt, runtimeTools: AGENT_TOOLS, restrictions,
            showReasoning: false, tools: new ToolHost(restrictions, cwd),
        });
    } finally {
        await backend.close();
    }
};

it('provides blockquote runtime tools instead of an SPL compiler and queues one action per turn', async () => {
    sdk.calls = [
        { name: 'save_variable', arguments: { name: 'animal', value: 'story' } },
        { name: 'success', arguments: { value: 'must not run before save' } },
    ];
    expect(await command('Story -> @animal')).toMatchObject({ action: sdk.calls[0] });
    expect(sdk.configs[0].availableTools).toEqual(AGENT_TOOLS.map(tool => tool.name));
    expect(sdk.configs[0].availableTools).not.toContain('submit_spl');
    expect(sdk.results[0]).toContain('not yet executed');
    expect(sdk.results[1]).toMatchObject({ resultType: 'failure' });
    expect(sdk.prompts).toHaveLength(1);
});

it.each([
    ['an empty', { data: { content: '' } }],
    ['a whitespace-only', { data: { content: '\n ' } }],
    ['no', undefined],
])('accepts a queued action when the model ends with %s final message', async (_, reply) => {
    const cwd = process.cwd();
    const restrictions = new Restrictions(cwd);
    sdk.calls = [{ name: 'save_variable', arguments: { name: 'modelFib10', value: 55 } }];
    sdk.reply = reply;
    const backend = new CopilotBackend({ cwd, timeoutMs: 1000, logger: new Logger('silent') });
    try {
        const response = await backend.call({
            kind: 'agent', naturalLanguage: true, runtimeTools: AGENT_TOOLS, prompt: 'Save the 10th Fibonacci number to @modelFib10', restrictions,
            showReasoning: false, tools: new ToolHost(restrictions, cwd),
        });
        expect(response).toMatchObject({ action: sdk.calls[0], text: 'Runtime action queued.' });
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
            showReasoning: false, tools: new ToolHost(restrictions, cwd),
        });
        expect(response.action).toEqual(sdk.calls[0]);
        expect(sdk.configs[0].availableTools).toContain('mcp:docs-*');
        expect(sdk.configs[0].tools).toHaveLength(AGENT_TOOLS.length);
        expect(sdk.configs[0].mcpServers).toEqual({ docs: { command: 'never-start', tools: ['*'] } });
        expect(sdk.abort).not.toHaveBeenCalled();
    } finally {
        await backend.close();
    }
});

it('accepts a final blockquote answer without requiring generated SPL', async () => {
    expect(await command('Finish')).toMatchObject({ text: 'MCP result' });
    expect(sdk.prompts).toHaveLength(1);
});

it('retains actual MCP results for later runtime-action turns', async () => {
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
