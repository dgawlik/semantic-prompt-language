import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decidePermission } from '../src/copilot.js';
import { Failure } from '../src/errors.js';
import { run } from '../src/interpreter.js';
import type { LlmRequest } from '../src/llm.js';
import { Logger } from '../src/logger.js';
import { configuredMcpTool, filterMcpServers, loadMcpConfig, type McpServers } from '../src/mcp.js';
import { parse } from '../src/parser.js';
import { makeRestriction, Restrictions } from '../src/restrict.js';

let cwd: string;
let file: string;
beforeEach(() => {
    cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'spl-mcp-')));
    file = path.join(cwd, 'mcp.json');
});
afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(cwd, { recursive: true, force: true });
});
const config = (value: unknown) => {
    fs.writeFileSync(file, JSON.stringify(value));
    return loadMcpConfig(file, cwd);
};

describe('MCP configuration', () => {
    it('maps VS Code stdio, HTTP and SSE servers to SDK configuration', () => {
        vi.stubEnv('SPL_TEST_MCP_TOKEN', 'test-token');
        expect(config({ servers: {
            local: { command: 'node', args: ['${workspaceFolder}\\server.js'], env: { TOKEN: '${env:SPL_TEST_MCP_TOKEN}' }, cwd: './tools', tools: ['search'], timeout: 1000 },
            remote: { type: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer ${env:SPL_TEST_MCP_TOKEN}' } },
            events: { type: 'sse', url: 'http://localhost:9999/sse' },
        } })).toEqual({
            local: { type: 'stdio', command: 'node', args: [`${cwd}\\server.js`], env: { TOKEN: 'test-token' }, workingDirectory: path.join(cwd, 'tools'), tools: ['search'], timeout: 1000 },
            remote: { type: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer test-token' } },
            events: { type: 'sse', url: 'http://localhost:9999/sse' },
        });
    });

    it.each([
        null, [], {}, { servers: [] },
        { servers: { docs: { command: '' } } },
        { servers: { docs: { type: 'ftp', url: 'ftp://example.com' } } },
        { servers: { docs: { type: 'http', url: 'file:///secret' } } },
        { servers: { docs: { command: 'node', args: [42] } } },
        { servers: { docs: { command: 'node', env: { KEY: false } } } },
        { servers: { docs: { command: 'node', tools: 'search' } } },
        { servers: { docs: { command: 'node', timeout: -1 } } },
        { servers: { docs: { command: 'node', envFile: '.env' } } },
        { servers: { 'bad/name': { command: 'node' } } },
        { servers: { docs: { command: '${input:command}' } } },
        { servers: {}, inputs: [{ id: 'command' }] },
    ])('rejects unsupported or invalid config: %j', (value) => {
        expect(() => config(value)).toThrow(/MCP config/);
    });

    it('reports missing files, invalid JSON and missing environment variables explicitly', () => {
        expect(() => loadMcpConfig(file, cwd)).toThrow(/cannot read JSON/);
        fs.writeFileSync(file, '{');
        expect(() => loadMcpConfig(file, cwd)).toThrow(/cannot read JSON/);
        vi.stubEnv('SPL_TEST_MCP_MISSING', undefined);
        expect(() => config({ servers: { docs: { command: '${env:SPL_TEST_MCP_MISSING}' } } })).toThrow(/is not set/);
    });
});

describe('MCP restriction enforcement', () => {
    const servers: McpServers = {
        docs: { command: 'node', tools: ['*'] },
        issues: { type: 'http', url: 'https://example.com/mcp', tools: ['read', 'write'] },
    };
    const restricted = (value: string, parent = new Restrictions(cwd)) => parent.with(makeRestriction('mcp', value, cwd));

    it('allows whole servers, exact tools, wildcard servers and intersects nested scopes', () => {
        const outer = restricted('docs,issues/read');
        expect(() => outer.checkMcp('docs', 'search')).not.toThrow();
        expect(() => outer.checkMcp('issues', 'write')).toThrow(/blocked/);
        const inner = restricted('docs/search,issues', outer);
        expect(() => inner.checkMcp('docs', 'search')).not.toThrow();
        expect(() => inner.checkMcp('docs', 'write')).toThrow(/blocked/);
        expect(filterMcpServers(servers, inner)).toMatchObject({
            docs: { tools: ['search'] }, issues: { tools: ['read'] },
        });
        expect(filterMcpServers(servers, restricted('docs/*'))).toEqual({ docs: servers.docs });
        expect(filterMcpServers(servers, restricted('missing'))).toEqual({});
        expect(filterMcpServers({ docs: { command: 'node', tools: [] } }, new Restrictions(cwd))).toEqual({});
    });

    it('does not widen configured tool allowlists', () => {
        const filtered = filterMcpServers(servers, restricted('issues/delete'));
        expect(filtered).toEqual({});
        expect(configuredMcpTool(servers, 'issues', 'delete')).toBe(false);
        expect(configuredMcpTool(servers, 'toString', 'read')).toBe(false);
    });

    it('approves configured MCP permissions and blocks restriction violations', () => {
        const blocked: Failure[] = [];
        const decide = (serverName: string, toolName: string, restrictions = new Restrictions(cwd)) =>
            decidePermission({ kind: 'mcp', serverName, toolName, readOnly: true, toolTitle: toolName },
                restrictions, (failure) => blocked.push(failure), servers);
        expect(decide('docs', 'search').kind).toBe('approve-once');
        expect(decide('unconfigured', 'search').kind).toBe('reject');
        expect(decide('issues', 'delete').kind).toBe('reject');
        expect(decide('docs', 'write', restricted('docs/search')).kind).toBe('reject');
        expect(blocked).toHaveLength(1);
        expect(blocked[0].statusCode).toBe('restriction_violation');
    });

    it.each(['', 'docs/', '/search', 'docs/search/other', '*', 'docs/tool*'])('rejects malformed selector %j', (value) => {
        expect(() => makeRestriction('mcp', value, cwd)).toThrow();
    });
});

it('combined restrictions apply together, intersect, and restore after a caught failure', async () => {
    const calls: LlmRequest[] = [];
    const result = await run(parse(`
restrict '.', net 'example.com', exec 'git', mcp 'docs' {
    try {
        restrict mcp 'docs/search', exec 'node' {
            let x = ?'inner'
            fail 'caught'
        }
    } except err {
        let x = ?'restored'
    }
}
let x = ?'outside'
success x`), {
        cwd, logger: new Logger('silent'),
        backend: {
            async call(req) { calls.push(req); return { text: 'ok', effective: {} }; },
            async close() {},
        },
    });
    expect(result).toMatchObject({ status: 'success', value: 'ok' });
    expect(calls).toHaveLength(3);
    expect(calls[0].restrictions.list.map((r) => r.kind)).toEqual(['fs', 'net', 'exec', 'mcp', 'mcp', 'exec']);
    expect(() => calls[0].restrictions.checkExec('node')).toThrow();
    expect(() => calls[0].restrictions.checkMcp('docs', 'write')).toThrow();
    expect(() => calls[1].restrictions.checkMcp('docs', 'write')).not.toThrow();
    expect(calls[1].restrictions.list.map((r) => r.kind)).toEqual(['fs', 'net', 'exec', 'mcp']);
    expect(calls[2].restrictions.list).toEqual([]);
});

it('restores scopes when a later clause fails to evaluate', async () => {
    const calls: LlmRequest[] = [];
    const result = await run(parse(`
try {
    restrict mcp 'docs/search', exec 42 { fail 'unreachable' }
} except err {
    success ?'after invalid clause'
}`), {
        cwd, logger: new Logger('silent'),
        backend: {
            async call(req) { calls.push(req); return { text: 'ok', effective: {} }; },
            async close() {},
        },
    });
    expect(result).toMatchObject({ status: 'success', value: 'ok' });
    expect(calls[0].restrictions.list).toEqual([]);
});
