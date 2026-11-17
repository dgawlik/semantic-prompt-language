import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelCallOptions, ModelStreamPart, ToolOutput } from '../src/ai-native.js';
import { AiBackend } from '../src/ai.js';
import { AGENT_TOOLS } from '../src/blocks.js';
import { agent, configure, restrict } from '../src/index.js';
import type { LlmBackend } from '../src/llm.js';
import { configuredMcpTool, filterMcpServers, loadMcpConfig, type McpServers } from '../src/mcp.js';
import { makeRestriction, Restrictions } from '../src/restrict.js';
import { setAmbient } from '../src/runtime.js';
import { TOOL_SPECS } from '../src/tools.js';
import { Trace } from '../src/trace.js';
import { run } from '../src/workflow.js';
import { NoLlm, agentBlock, backend, block, cleanTemp, collecting, exec, scripted, silent, tempDir, text } from './helpers.js';

type Turn = (step: number, outputs: ToolOutput[]) => ModelStreamPart[];
const sdk = vi.hoisted(() => ({ turn: (() => []) as Turn, requests: [] as ModelCallOptions[] }));
vi.mock('../src/ai-native.js', () => ({ createNativeModel: () => {
    let outputs: ToolOutput[] = [];
    let step = 0;
    return {
        addToolResults(values: ToolOutput[]) { outputs = values; },
        async *stream(options: ModelCallOptions) {
            sdk.requests.push(options);
            yield* sdk.turn(step++, outputs);
        },
    };
} }));

let cwd: string;
let file: string;
beforeEach(() => {
    cwd = tempDir('spl-mcp-');
    file = path.join(cwd, 'mcp.json');
});
afterEach(() => {
    vi.unstubAllEnvs();
    cleanTemp();
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
            remote: { type: 'http', url: 'https://example.com/mcp', headers: { Authorization: '******' } },
            events: { type: 'sse', url: 'http://localhost:9999/sse' },
        } })).toEqual({
            local: { type: 'stdio', command: 'node', args: [`${cwd}\\server.js`], env: { TOKEN: 'test-token' }, workingDirectory: path.join(cwd, 'tools'), tools: ['search'], timeout: 1000 },
            remote: { type: 'http', url: 'https://example.com/mcp', headers: { Authorization: '******' } },
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
    ])('rejects unsupported or invalid config: %j', value => {
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

    it.each(['', 'docs/', '/search', 'docs/search/other', '*', 'docs/tool*'])('rejects malformed selector %j', value => {
        expect(() => makeRestriction('mcp', value, cwd)).toThrow();
    });
});

describe('restrict() with MCP selectors', () => {
    it('applies combined restrictions together, intersects them and restores the outer scope after a caught failure', async () => {
        const model = scripted('ok', 'ok', 'ok');
        const result = await exec(`
await restrict({ fs: '.', net: 'example.com', exec: 'git', mcp: 'docs' }, async () => {
    try {
        await restrict({ mcp: 'docs/search', exec: 'node' }, async () => {
            await ask('inner');
            fail('caught');
        });
    } catch (error) {
        await ask('restored');
    }
});
success(await ask('outside'));`, { cwd, backend: model });
        expect(result).toMatchObject({ status: 'success', value: 'ok' });
        const [inner, restored, outside] = model.calls;
        expect(inner.restrictions.list.map(item => item.kind)).toEqual(['fs', 'net', 'exec', 'mcp', 'mcp', 'exec']);
        expect(() => inner.restrictions.checkExec('node')).toThrow();
        expect(() => inner.restrictions.checkMcp('docs', 'write')).toThrow();
        expect(inner.prompt).toContain('- MCP: you may only call these servers/tools: docs. Anything else will be blocked.\n- MCP: you may only call these servers/tools: docs/search.');
        expect(() => restored.restrictions.checkMcp('docs', 'write')).not.toThrow();
        expect(restored.restrictions.list.map(item => item.kind)).toEqual(['fs', 'net', 'exec', 'mcp']);
        expect(outside.restrictions.list).toEqual([]);
    });

    it('applies nothing when a later entry of the same restrict() is invalid', async () => {
        const model = scripted('ok');
        const result = await exec(`
let reason;
try {
    await restrict({ mcp: 'docs/search', exec: 42 }, () => fail('unreachable'));
} catch (error) {
    reason = error.reason;
}
success([reason, await ask('after invalid entry')]);`, { cwd, backend: model });
        expect(result).toMatchObject({ status: 'success', value: ['restrict exec expects a string (comma-separated) or a list of strings', 'ok'] });
        expect(model.calls[0].restrictions.list).toEqual([]);
    });

    it.each(['docs/', '*', 'docs/tool*', 'docs/search/other'])('rejects the malformed selector %j before running the body', async selector => {
        expect(await exec(`await restrict({ mcp: '${selector}' }, () => ask('unreachable'));`, { cwd })).toMatchObject({
            status: 'failure', failure: { status_code: 'runtime_error', reason: 'restrict mcp expects server names or server/tool selectors', line: 1 },
        });
    });

    it('narrows MCP access for an agent block with the restrict header, within the restrictions around it', async () => {
        const seen: string[][] = [];
        const model = backend(request => {
            seen.push(request.restrictions.list.map(item => `${item.kind}:${item.values}`));
            if (!request.runtimeTools) return { text: request.prompt, effective: {} };
            expect(() => request.restrictions.checkMcp('docs', 'search')).not.toThrow();
            expect(() => request.restrictions.checkMcp('docs', 'write')).toThrow(/blocked/);
            expect(() => request.restrictions.checkMcp('issues', 'read')).toThrow(/blocked/);
            expect(request.prompt).toContain('- MCP: you may only call these servers/tools: docs, issues/read. Anything else will be blocked.\n- MCP: you may only call these servers/tools: docs/search, docs/read.');
            return { text: 'Done', effective: {} };
        });
        const result = await exec(`await restrict({ mcp: ['docs', 'issues/read'] }, async () => {
${agentBlock('Search the docs.', 'restrict: { mcp: [docs/search, docs/read] }')}
    await ask('inside');
});
success(await ask('outside'));`, { cwd, backend: model });
        expect(result).toMatchObject({ status: 'success', value: 'outside' });
        expect(seen).toEqual([['mcp:docs,issues/read', 'mcp:docs/search,docs/read'], ['mcp:docs,issues/read'], []]);
    });

    it.each(['docs/', '*', 'docs/tool*'])('fails an agent block with the malformed selector %j before calling the model', async selector => {
        expect(await exec(`const before = 1;\n${agentBlock('Search the docs.', `restrict: { mcp: '${selector}' }`)}`, { cwd })).toMatchObject({
            status: 'failure', failure: {
                status_code: 'runtime_error', reason: 'restrict mcp expects server names or server/tool selectors', line: 2, command: 'Search the docs.',
            },
        });
    });
});

describe('agents with a real MCP server', () => {
    const fixture = fileURLToPath(new URL('./fixtures/mcp-server.mjs', import.meta.url));
    const call = (toolName: string, input: unknown, toolCallId = toolName): ModelStreamPart => ({ type: 'tool-call', toolCallId, toolName, input });
    const say = (delta: string): ModelStreamPart[] => [{ type: 'text-delta', id: 'answer', delta }, { type: 'text-end', id: 'answer' }];
    const finish = (reason = 'stop'): ModelStreamPart => ({ type: 'finish', reason });
    const content = (outputs: ToolOutput[]): string => JSON.parse(outputs[0].value).content[0].text;
    const echoing: Turn = (step, outputs) => step === 0
        ? [call('mcp0Echo', { message: 'real MCP result' }), finish('tool-calls')]
        : [...say(`Echoed: ${content(outputs)}`), finish()];
    const tools = (index = 0) => sdk.requests[index].tools.map(tool => tool.name);
    const advertised = (index = 0) => sdk.requests[index].tools.filter(tool => tool.name.startsWith('mcp')).map(tool => tool.description);
    let servers: McpServers;
    let ai: AiBackend;

    beforeEach(() => {
        vi.stubEnv('SPL_HOME', path.join(cwd, 'home'));
        vi.stubEnv('OPENAI_API_KEY', 'test-openai-key');
        vi.stubEnv('SPL_PROVIDER', 'openai');
        sdk.requests.length = 0;
        sdk.turn = () => [...say('Done'), finish()];
        // The servers run outside the temporary folder, so it can be removed while they shut down.
        const server = { command: process.execPath, args: [fixture, 'stdio'], cwd: path.dirname(fixture) };
        servers = config({ servers: { docs: server, notes: { ...server, tools: ['echo', 'unlisted'] } } });
        ai = new AiBackend({ cwd, timeoutMs: 10_000, logger: silent, mcpServers: servers });
    });
    afterEach(async () => {
        await ai.close();
        setAmbient(undefined);
    });

    it('lets agent() call a configured MCP tool and continue with its real result', async () => {
        sdk.turn = echoing;
        expect(await exec("success(await agent('Echo it'));", { backend: ai, cwd })).toEqual({ status: 'success', value: 'Echoed: real MCP result', hasValue: true });
        expect(sdk.requests).toHaveLength(2);
        expect(tools()).toEqual([...Object.keys(TOOL_SPECS), 'mcp0Echo', 'mcp1Echo']);
        expect(advertised()).toEqual(['MCP docs/echo: Echo a message', 'MCP notes/echo: Echo a message']);
    }, 20_000);

    it.each([
        ["{ mcp: 'notes' }", ['MCP notes/echo: Echo a message']],
        ["{ mcp: 'docs/echo' }", ['MCP docs/echo: Echo a message']],
        ["{ mcp: ['docs/other', 'notes/*'] }", ['MCP notes/echo: Echo a message']],
        ["{ mcp: 'notes/unlisted, elsewhere' }", []],
        ["{ fs: '.', exec: 'git' }", ['MCP docs/echo: Echo a message', 'MCP notes/echo: Echo a message']],
    ])('advertises only the MCP tools allowed inside restrict(%s)', async (spec, expected) => {
        expect(await exec(`success(await restrict(${spec}, () => agent('Act')));`, { backend: ai, cwd })).toMatchObject({ status: 'success', value: 'Done' });
        expect(advertised()).toEqual(expected);
    }, 20_000);

    it('never offers MCP tools to ask() or ask blocks', async () => {
        expect(await exec(`${block('Two', 'outputVar: two')}\nsuccess([await ask('One'), two]);`, { backend: ai, cwd })).toMatchObject({ value: ['Done', 'Done'] });
        expect(sdk.requests.map(request => request.tools)).toEqual([[], []]);
    });

    it('names the tools of each server mcp<Index><Tool> for an agent block, which reaches the server it picks', async () => {
        sdk.turn = (step, outputs) => step === 0 ? [call('mcp1Echo', { message: 'from notes' }), finish('tool-calls')]
            : step === 1 ? [call('saveVariable', { name: 'reply', value: content(outputs) }), finish('tool-calls')]
            : [...say('Saved.'), finish()];
        const { logger, events } = collecting('info');
        ai = new AiBackend({ cwd, timeoutMs: 10_000, logger, mcpServers: servers });
        expect(await exec(`${agentBlock('Echo with the notes server ->[Str] @reply')}\nsuccess(reply);`, { backend: ai, cwd, logger }))
            .toEqual({ status: 'success', value: 'from notes', hasValue: true });
        expect(tools()).toEqual([...AGENT_TOOLS.map(tool => tool.name), 'mcp0Echo', 'mcp1Echo']);
        expect(advertised()).toEqual(['MCP docs/echo: Echo a message', 'MCP notes/echo: Echo a message']);
        expect(events.filter(event => event.kind === 'tool').map(event => event.kind === 'tool' && event.tool))
            .toEqual([
                { name: 'notes/echo', target: '{"message":"from notes"}', status: 'success' },
                { name: 'saveVariable', target: '@reply', status: 'success' },
            ]);
    }, 20_000);

    it('lets an agent block combine an MCP result with runtime tools, within its restrict header', async () => {
        sdk.turn = (step, outputs) => step === 0 ? [call('mcp0Echo', { message: 'hello' }), finish('tool-calls')]
            : step === 1 ? [call('saveVariable', { name: 'reply', value: content(outputs).toUpperCase() }), finish('tool-calls')]
            : [...say('Saved.'), finish()];
        const { logger, events } = collecting('info');
        const result = await exec(`${agentBlock('Echo hello with the notes server and save the reply -> @reply', 'restrict: { mcp: notes/echo }')}
success(reply);`, { backend: ai, cwd, logger });
        expect(result).toMatchObject({ status: 'success', value: 'HELLO' });
        expect(sdk.requests).toHaveLength(3);
        expect(tools()).toEqual([...AGENT_TOOLS.map(tool => tool.name), 'mcp0Echo']);
        expect(advertised()).toEqual(['MCP notes/echo: Echo a message']);
        expect(sdk.requests[0].prompt).toContain('- MCP: you may only call these servers/tools: notes/echo. Anything else will be blocked.');
        const outputs = events.filter(event => event.origin === 'model').filter(event => event.kind === 'model-output');
        expect(outputs.map(event => [event.interaction.role, text(event)])).toEqual([
            ['action', '{"name":"saveVariable","arguments":{"name":"reply","value":"HELLO"}}'], ['response', 'Saved.'],
        ]);
    }, 20_000);

    it('blocks an MCP call that the restrict header of an agent block excludes', async () => {
        sdk.turn = step => step === 0
            ? [call('mcp0Echo', { message: 'blocked?' }), finish('tool-calls')]
            : [...say('unreachable'), finish()];
        const source = `${agentBlock('Echo with the docs server.', 'restrict: { mcp: [docs/search, notes/unlisted] }')}\nsuccess('unreachable');`;
        expect(await exec(source, { backend: ai, cwd })).toMatchObject({
            status: 'failure', failure: {
                status_code: 'restriction_violation', line: 1, command: 'Echo with the docs server.',
                reason: "tool 'mcp0Echo' is not enabled by the runtime",
            },
        });
        expect(sdk.requests).toHaveLength(1);
        expect(advertised()).toEqual([]);
    }, 20_000);

    it('records MCP results of agent calls in the trace and replays them without starting servers', async () => {
        sdk.turn = echoing;
        const code = "success(await restrict({ mcp: 'docs' }, () => agent('Echo it')));";
        const journal = path.join(cwd, 'run.jsonl');
        const traced = async (model: LlmBackend) => {
            const trace = Trace.open(journal, { source: code, runtime: 'test', cwd });
            try {
                const result = await run(code, { backend: model, logger: silent, cwd, trace });
                trace.finish(result);
                return result;
            } finally {
                trace.close();
            }
        };
        const first = await traced(ai);
        expect(first).toMatchObject({ status: 'success', value: 'Echoed: real MCP result' });
        const rows = fs.readFileSync(journal, 'utf8').trimEnd().split('\n').map(line => JSON.parse(line));
        const response = rows.find(row => row.type === 'outcome' && typeof row.outcome.value?.text === 'string').outcome.value;
        expect(response.toolResults.map((item: string) => JSON.parse(item))).toEqual([expect.objectContaining({
            server: 'docs', tool: 'echo', arguments: { message: 'real MCP result' }, success: true,
            result: expect.objectContaining({ content: [{ type: 'text', text: 'real MCP result' }] }),
        })]);
        sdk.requests.length = 0;
        expect(await traced(new NoLlm())).toEqual(first);
        expect(sdk.requests).toEqual([]);
    }, 20_000);

    it('reaches MCP servers from plain Node.js code through configure({ mcpServers })', async () => {
        sdk.turn = echoing;
        const runtime = configure({ mcpServers: servers, cwd, logLevel: 'silent', timeoutMs: 10_000 });
        try {
            expect(await restrict({ mcp: 'notes' }, () => agent('Echo it'))).toBe('Echoed: real MCP result');
        } finally {
            await runtime.backend.close();
        }
        expect(advertised()).toEqual(['MCP notes/echo: Echo a message']);
    }, 20_000);
});
