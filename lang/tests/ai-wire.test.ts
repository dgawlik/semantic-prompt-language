import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AiBackend } from '../src/ai.js';
import { DEFAULT_MODELS, PROVIDERS, PROVIDER_ENV, type Provider } from '../src/auth.js';
import { AGENT_TOOLS } from '../src/agent.js';
import { Logger } from '../src/logger.js';
import { Restrictions } from '../src/restrict.js';
import { ToolHost } from '../src/tools.js';
import type { Randomness } from '../src/llm.js';

let home: string;
let backend: AiBackend;
const sse = (events: unknown[]) => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
});

function providerEvents(provider: Provider, action: boolean): unknown[] {
    const args = { name: 'answer', value: 42 };
    if (provider === 'google') return [{
        candidates: [{ content: { role: 'model', parts: action
            ? [{ functionCall: { name: 'save_variable', args } }] : [{ text: '42' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
    }];
    if (provider === 'anthropic') return [
        { type: 'message_start', message: { id: 'msg_1', model: DEFAULT_MODELS.anthropic, usage: { input_tokens: 1 } } },
        { type: 'content_block_start', index: 0, content_block: action
            ? { type: 'tool_use', id: 'tool_1', name: 'save_variable', input: {} } : { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: action
            ? { type: 'input_json_delta', partial_json: JSON.stringify(args) } : { type: 'text_delta', text: '42' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: action ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 1 } },
        { type: 'message_stop' },
    ];
    const item = action
        ? { type: 'function_call', id: 'fc_1', call_id: 'tool_1', name: 'save_variable', arguments: JSON.stringify(args), status: 'completed' }
        : { type: 'message', id: 'msg_1' };
    return [
        { type: 'response.created', response: { id: 'resp_1', created_at: 1, model: DEFAULT_MODELS.openai } },
        { type: 'response.output_item.added', output_index: 0, item: action ? { ...item, arguments: '' } : item },
        ...(action ? [
            { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 0, delta: JSON.stringify(args) },
            { type: 'response.function_call_arguments.done', item_id: 'fc_1', output_index: 0, arguments: JSON.stringify(args) },
        ] : [{ type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, delta: '42' }]),
        { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 1 } } },
    ];
}

beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'spl-wire-'));
    vi.stubEnv('SPL_HOME', home);
    for (const provider of PROVIDERS) vi.stubEnv(PROVIDER_ENV[provider][0], `test-${provider}`);
    backend = new AiBackend({ cwd: home, timeoutMs: 2000, logger: new Logger('silent') });
});
afterEach(async () => {
    await backend.close();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    fs.rmSync(home, { recursive: true, force: true });
});

it.each(PROVIDERS)('serializes real %s API requests, credentials, streaming and tool continuation', async provider => {
    const requests: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
        requests.push({ url: String(url), headers: new Headers(init.headers), body: JSON.parse(String(init.body)) });
        return sse(providerEvents(provider, requests.length === 1));
    }));
    const restrictions = new Restrictions(home);
    const invokeAction = vi.fn(async () => 42);
    const result = await backend.call({
        kind: 'agent', naturalLanguage: true, model: `${provider}/${DEFAULT_MODELS[provider]}`,
        prompt: 'Save the answer', showReasoning: false, restrictions,
        tools: new ToolHost(restrictions, home), runtimeTools: AGENT_TOOLS, invokeAction,
    });
    expect(result).toMatchObject({ text: '42', effective: { provider, model: DEFAULT_MODELS[provider] } });
    expect(invokeAction).toHaveBeenCalledExactlyOnceWith({ name: 'save_variable', arguments: { name: 'answer', value: 42 } });
    expect(requests).toHaveLength(2);
    const header = provider === 'openai' ? 'authorization' : provider === 'anthropic' ? 'x-api-key' : 'x-goog-api-key';
    expect(requests[0].headers.get(header)).toBe(`${provider === 'openai' ? 'Bearer ' : ''}test-${provider}`);
    expect(requests[0].url).toContain(provider === 'google' ? 'generativelanguage.googleapis.com' : `api.${provider}.com`);
    const second = JSON.stringify(requests[1].body);
    expect(second).toContain('save_variable');
    expect(second).toContain('42');
    if (provider === 'openai') {
        expect(requests[0].body).toMatchObject({ store: false, parallel_tool_calls: false });
        expect(requests[0].body.tools).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'save_variable', strict: false })]));
    }
});

it.each(PROVIDERS)('surfaces %s authentication/model errors without fallback or retry', async provider => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({
        error: { message: 'Unknown model or invalid API key', type: 'invalid_request_error', code: 'model_not_found' },
    }), { status: 400, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetch);
    const restrictions = new Restrictions(home);
    await expect(backend.call({
        kind: 'ask', model: `${provider}/unavailable-model`, prompt: 'Hi', showReasoning: false,
        restrictions, tools: new ToolHost(restrictions, home),
    })).rejects.toThrow();
    expect(fetch).toHaveBeenCalledOnce();
});

it.each([
    ['openai', 'gpt-4.1'],
    ['anthropic', 'claude-3-5-haiku-20241022'],
    ['google', 'gemini-2.5-flash'],
] as const)('sends supported %s sampling controls on every agent continuation and records unsupported controls accurately', async (provider, model) => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        return sse(providerEvents(provider, bodies.length === 1));
    }));
    const warn = vi.spyOn(Logger.prototype, 'warn');
    try {
        const restrictions = new Restrictions(home);
        const result = await backend.call({
            kind: 'agent', naturalLanguage: true, model: `${provider}/${model}`,
            prompt: 'Save the answer', showReasoning: false, restrictions,
            randomness: { seed: 42, temperature: 0, top_p: 0.01 },
            tools: new ToolHost(restrictions, home), runtimeTools: AGENT_TOOLS, invokeAction: async () => 42,
        });
        expect(bodies).toHaveLength(2);
        for (const body of bodies) {
            if (provider === 'google') expect(body.generationConfig).toMatchObject({ seed: 42, temperature: 0, topP: 0.01 });
            else {
                expect(body.temperature).toBe(0);
                expect(body).not.toHaveProperty('seed');
                if (provider === 'openai') expect(body.top_p).toBe(0.01);
                else expect(body).not.toHaveProperty('top_p');
            }
        }
        expect(result.effective.randomness).toEqual({
            seed: provider === 'google' ? 42 : null,
            temperature: 0,
            top_p: provider === 'anthropic' ? null : 0.01,
        });
        if (provider !== 'google') expect(warn).toHaveBeenCalledWith(expect.stringContaining('does not support randomness.seed'));
        if (provider === 'anthropic') expect(warn).toHaveBeenCalledWith(expect.stringContaining('topP is ignored'));
    } finally {
        warn.mockRestore();
    }
});

it.each([
    ['openai', 'gpt-4.1'],
    ['anthropic', 'claude-3-5-haiku-20241022'],
    ['google', 'gemini-2.5-flash'],
] as const)('leaves %s defaults unset and supports top_p alone without manufacturing a temperature', async (provider, model) => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        return sse(providerEvents(provider, false));
    }));
    const restrictions = new Restrictions(home);
    for (const randomness of [undefined, {}, { top_p: 0 }] as (Randomness | undefined)[]) {
        const result = await backend.call({
            kind: 'ask', model: `${provider}/${model}`, prompt: 'Prompt', showReasoning: false, restrictions,
            tools: new ToolHost(restrictions, home), randomness,
        });
        if (randomness === undefined) expect(result.effective).not.toHaveProperty('randomness');
        else expect(result.effective.randomness).toEqual({ seed: null, temperature: null, top_p: randomness.top_p ?? null });
    }
    const settings = bodies.map(body => provider === 'google' ? body.generationConfig : body);
    for (const body of settings) {
        expect(body).not.toHaveProperty('temperature');
        expect(body).not.toHaveProperty('seed');
    }
    for (const body of settings.slice(0, 2)) expect(body).not.toHaveProperty(provider === 'google' ? 'topP' : 'top_p');
    expect(settings[2]).toHaveProperty(provider === 'google' ? 'topP' : 'top_p', 0);
});

it.each([
    ['openai', 'gpt-5', 'high'],
    ['openai', 'gpt-6-astra', 'high'],
    ['anthropic', 'claude-sonnet-4-5', 'high'],
    ['anthropic', 'claude-opus-4-8', undefined],
] as const)('warns and omits sampling rejected by %s/%s without disabling reasoning or changing APIs', async (provider, model, reasoningEffort) => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        return sse(providerEvents(provider, false));
    }));
    const warn = vi.spyOn(Logger.prototype, 'warn');
    try {
        const restrictions = new Restrictions(home);
        const result = await backend.call({
            kind: 'think', model: `${provider}/${model}`, reasoningEffort, prompt: 'Prompt', showReasoning: false, restrictions,
            tools: new ToolHost(restrictions, home), randomness: { seed: 42, temperature: 0, top_p: 0.01 },
        });
        expect(bodies).toHaveLength(1);
        expect(bodies[0]).not.toHaveProperty('temperature');
        expect(bodies[0]).not.toHaveProperty('top_p');
        expect(bodies[0]).not.toHaveProperty('seed');
        if (reasoningEffort !== undefined) {
            if (provider === 'openai') expect(bodies[0].reasoning).toMatchObject({ effort: reasoningEffort });
            else expect(bodies[0].thinking).toMatchObject({ type: 'enabled' });
        }
        expect(result.effective.randomness).toEqual({ seed: null, temperature: null, top_p: null });
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('"feature":"temperature"'));
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('"feature":"topP"'));
    } finally {
        warn.mockRestore();
    }
});

it('caps Anthropic temperature at its supported maximum and reports the actual sent value', async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        return sse(providerEvents('anthropic', false));
    }));
    const warn = vi.spyOn(Logger.prototype, 'warn');
    try {
        const restrictions = new Restrictions(home);
        const result = await backend.call({
            kind: 'ask', model: 'anthropic/claude-3-5-haiku-20241022', prompt: 'Prompt', showReasoning: false, restrictions,
            tools: new ToolHost(restrictions, home), randomness: { temperature: 2 },
        });
        expect(bodies[0].temperature).toBe(1);
        expect(result.effective.randomness).toEqual({ seed: null, temperature: 1, top_p: null });
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('clamping randomness.temperature to 1'));
    } finally {
        warn.mockRestore();
    }
});
