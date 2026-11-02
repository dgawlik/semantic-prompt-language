import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import { reply } from './fixtures/mcp-server.mjs';
import { AiBackend } from '../src/ai.js';
import { Logger } from '../src/logger.js';
import { Restrictions } from '../src/restrict.js';
import { ToolHost } from '../src/tools.js';
import type { MCPServerConfig } from '../src/mcp.js';

const sdk = vi.hoisted(() => ({ model: undefined as unknown }));
vi.mock('@ai-sdk/openai', () => ({ createOpenAI: () => ({ responses: () => sdk.model }) }));
let directory: string;
let backend: AiBackend | undefined;
let server: Server | undefined;
beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'spl-mcp-transport-'));
    vi.stubEnv('SPL_HOME', directory);
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
});
afterEach(async () => {
    await backend?.close();
    if (server) {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
    }
    server = undefined;
    vi.unstubAllEnvs();
    fs.rmSync(directory, { recursive: true, force: true });
});

it.each(['stdio', 'http', 'sse'] as const)('executes a tool over real %s MCP transport', async type => {
    let config: MCPServerConfig;
    if (type === 'stdio') {
        config = { command: process.execPath, args: [fileURLToPath(new URL('./fixtures/mcp-server.mjs', import.meta.url)), 'stdio'] };
    } else {
        let events: ServerResponse | undefined;
        server = createServer(async (request, response) => {
            if (request.method === 'GET') {
                response.writeHead(200, { 'content-type': 'text/event-stream' });
                response.write('event: endpoint\ndata: /message\n\n');
                events = response;
                return;
            }
            let body = '';
            for await (const chunk of request) body += chunk;
            const result = reply(JSON.parse(body));
            if (type === 'sse') {
                if (result) events!.write(`event: message\ndata: ${JSON.stringify(result)}\n\n`);
                response.writeHead(202).end();
            } else if (result) {
                response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
            } else response.writeHead(202).end();
        });
        await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('test server has no TCP address');
        config = { type, url: `http://127.0.0.1:${address.port}/mcp` };
    }
    let step = 0;
    sdk.model = new MockLanguageModelV4({ doStream: async options => {
        expect(options.tools?.map(tool => tool.name)).toContain('mcp_0_0');
        const first = step++ === 0;
        return { stream: new ReadableStream({ start(controller) {
            if (first) controller.enqueue({ type: 'tool-call', toolCallId: 'echo', toolName: 'mcp_0_0', input: '{"message":"real MCP result"}' });
            else {
                expect(JSON.stringify(options.prompt)).toContain('real MCP result');
                controller.enqueue({ type: 'text-start', id: 'text' });
                controller.enqueue({ type: 'text-delta', id: 'text', delta: 'Done' });
                controller.enqueue({ type: 'text-end', id: 'text' });
            }
            controller.enqueue({
                type: 'finish', finishReason: { unified: first ? 'tool-calls' : 'stop', raw: undefined },
                usage: { inputTokens: {}, outputTokens: {} },
            });
            controller.close();
        } }) };
    } });
    const restrictions = new Restrictions(directory);
    backend = new AiBackend({ cwd: directory, timeoutMs: 3000, logger: new Logger('silent'), mcpServers: { fixture: config } });
    const result = await backend.call({
        kind: 'agent', model: 'openai/gpt-4.1', prompt: 'Echo', restrictions,
        showReasoning: false, tools: new ToolHost(restrictions, directory),
    });
    expect(result.text).toBe('Done');
    expect(JSON.parse(result.toolResults![0])).toMatchObject({ server: 'fixture', tool: 'echo', success: true, result: { content: [{ text: 'real MCP result' }] } });
}, 10_000);
