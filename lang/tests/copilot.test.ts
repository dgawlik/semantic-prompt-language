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
            return {
                on() {},
                async sendAndWait() {
                    if (sdk.permission) await config.onPermissionRequest?.(sdk.permission, { sessionId: 'test' });
                    return { data: { content: 'MCP result' } };
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
    vi.clearAllMocks();
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
            kind: 'think', prompt: 'Only search', restrictions, showReasoning: false,
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
            kind: 'ask', prompt: 'Search docs', restrictions, showReasoning: false,
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
