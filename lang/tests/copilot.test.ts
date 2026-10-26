import type { PermissionRequest, SessionConfig } from '@github/copilot-sdk';
import { beforeEach, expect, it, vi } from 'vitest';
import { CopilotBackend } from '../src/copilot.js';
import { Logger } from '../src/logger.js';
import { makeRestriction, Restrictions } from '../src/restrict.js';
import { ToolHost } from '../src/tools.js';

const sdk = vi.hoisted(() => ({
    configs: [] as SessionConfig[],
    disconnect: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
    permission: undefined as PermissionRequest | undefined,
    submissions: undefined as string[] | undefined,
    retrySubmissions: undefined as string[] | undefined,
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
            let turn = 0;
            return {
                on() {},
                async sendAndWait({ prompt }: { prompt: string }) {
                    sdk.prompts.push(prompt);
                    if (sdk.permission) await config.onPermissionRequest?.(sdk.permission, { sessionId: 'test' });
                    for (const source of (turn++ === 0 ? sdk.submissions : sdk.retrySubmissions) ?? []) {
                        const tool = config.tools?.find(tool => tool.name === 'submit_spl');
                        if (!tool) throw new Error('submit_spl not registered');
                        await tool.handler({ source }, {
                            sessionId: 'test', toolCallId: 'test', toolName: 'submit_spl', arguments: { source },
                        });
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
    sdk.submissions = undefined;
    sdk.retrySubmissions = undefined;
    sdk.prompts.length = 0;
    sdk.reply = { data: { content: 'MCP result' } };
    vi.clearAllMocks();
});

const translate = async (prompt: string, markers: string[] = []) => {
    const cwd = process.cwd();
    const restrictions = new Restrictions(cwd);
    const backend = new CopilotBackend({ cwd, timeoutMs: 1000, logger: new Logger('silent') });
    try {
        return await backend.call({
            kind: 'agent', naturalLanguage: true, prompt, markers, restrictions,
            showReasoning: false, tools: new ToolHost(restrictions, cwd),
        });
    } finally {
        await backend.close();
    }
};

it('rejects saving a marked result with a block-local let, then accepts the corrected program', async () => {
    const corrected = `let animal = None\nenforce 'Answer in Chinese' { animal = ask 'A pet story' }`;
    sdk.submissions = [`enforce 'Answer in Chinese' { let animal = ask 'A pet story' }`, corrected];
    expect(await translate('Story -> @animal', ['ENFORCE', 'animal'])).toMatchObject({ spl: corrected });
});

it('allows block-local temporaries and function locals that are not marked results', async () => {
    const source = `let total = 0\nfor i in range(3) { let step = i * 2; total += step }\ndef f(x) { let animal = x; return animal }`;
    sdk.submissions = [source];
    expect(await translate('Sum into @total', ['total', 'animal'])).toMatchObject({ spl: source });
});

it('reminds the model once when it replies without submitting a program', async () => {
    sdk.retrySubmissions = ['let joke = 1'];
    expect(await translate('@joke = a joke', ['joke'])).toMatchObject({ spl: 'let joke = 1' });
    expect(sdk.prompts).toHaveLength(2);
    expect(sdk.prompts[1]).toContain('call submit_spl now');
});

it.each([
    ['an empty', { data: { content: '' } }],
    ['a whitespace-only', { data: { content: '\n ' } }],
    ['no', undefined],
])('accepts a submitted program when the model ends with %s final message', async (_, reply) => {
    const cwd = process.cwd();
    const restrictions = new Restrictions(cwd);
    sdk.submissions = ['let modelFib10 = 55'];
    sdk.reply = reply;
    const backend = new CopilotBackend({ cwd, timeoutMs: 1000, logger: new Logger('silent') });
    try {
        const response = await backend.call({
            kind: 'agent', naturalLanguage: true, prompt: 'Save the 10th Fibonacci number to @modelFib10', restrictions,
            showReasoning: false, tools: new ToolHost(restrictions, cwd),
        });
        expect(response).toMatchObject({ spl: 'let modelFib10 = 55', text: 'SPL program submitted.' });
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

it('self-registers the submission hook without action tools, and accepts the first valid program', async () => {
    const cwd = process.cwd();
    const restrictions = new Restrictions(cwd);
    sdk.submissions = ['let invalid =', 'let answer = 42', "fail 'second submission'"];
    sdk.permission = { kind: 'custom-tool', toolName: 'submit_spl', toolDescription: 'Submit SPL' };
    const backend = new CopilotBackend({
        cwd, timeoutMs: 1000, logger: new Logger('silent'), mcpServers: { docs: { command: 'never-start' } },
    });
    try {
        const response = await backend.call({
            kind: 'agent', naturalLanguage: true, prompt: 'Set @answer to 42', restrictions,
            showReasoning: false, tools: new ToolHost(restrictions, cwd),
        });
        expect(response.spl).toBe('let answer = 42');
        expect(sdk.configs[0].availableTools).toEqual(['submit_spl']);
        expect(sdk.configs[0].tools).toHaveLength(1);
        expect(sdk.configs[0].mcpServers).toEqual({});
        expect(sdk.abort).not.toHaveBeenCalled();
    } finally {
        await backend.close();
    }
});

it('fails when a natural-language model merely replies without submitting code', async () => {
    const cwd = process.cwd();
    const restrictions = new Restrictions(cwd);
    const backend = new CopilotBackend({ cwd, timeoutMs: 1000, logger: new Logger('silent') });
    try {
        await expect(backend.call({
            kind: 'agent', naturalLanguage: true, prompt: 'Do work', restrictions,
            showReasoning: false, tools: new ToolHost(restrictions, cwd),
        })).rejects.toThrow('did not call submit_spl');
    } finally {
        await backend.close();
    }
});

it('denies all action permissions while translating natural language', async () => {
    const cwd = process.cwd();
    const restrictions = new Restrictions(cwd);
    sdk.permission = { kind: 'custom-tool', toolName: 'shell', toolDescription: 'Run shell' };
    const backend = new CopilotBackend({ cwd, timeoutMs: 1000, logger: new Logger('silent') });
    try {
        await expect(backend.call({
            kind: 'agent', naturalLanguage: true, prompt: 'Do work', restrictions,
            showReasoning: false, tools: new ToolHost(restrictions, cwd),
        })).rejects.toMatchObject({ statusCode: 'restriction_violation' });
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
