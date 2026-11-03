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
import type { LlmRequest, LlmStreamUpdate, Randomness } from '../src/llm.js';

let home: string;
let backend: AiBackend;
const sse = (events: unknown[]) => new Response(events.map(event => {
    const type = typeof event === 'object' && event !== null && 'type' in event ? `event: ${event.type}\n` : '';
    return `${type}data: ${JSON.stringify(event)}\n\n`;
}).join(''), {
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
        : { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '42', annotations: [] }] };
    return [
        { type: 'response.created', response: { id: 'resp_1', created_at: 1, model: DEFAULT_MODELS.openai } },
        { type: 'response.output_item.added', output_index: 0, item: action ? { ...item, arguments: '' } : item },
        ...(action ? [
            { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 0, delta: JSON.stringify(args) },
            { type: 'response.function_call_arguments.done', item_id: 'fc_1', output_index: 0, arguments: JSON.stringify(args) },
        ] : [
            { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: '42' },
            { type: 'response.output_text.done', item_id: 'msg_1', output_index: 0, content_index: 0, text: '42' },
        ]),
        { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 1 } } },
    ];
}

function chatEvents(action: boolean): unknown[] {
    const chunk = (delta: unknown, finish_reason: string | null = null) => ({
        id: 'chat_1', object: 'chat.completion.chunk', created: 1, model: 'served-chat-model',
        choices: [{ index: 0, delta, finish_reason }],
    });
    return action ? [
        chunk({ tool_calls: [{ index: 0, id: 'tool_1', type: 'function', function: { name: 'save_', arguments: '{"name":' } }] }),
        chunk({ tool_calls: [{ index: 0, function: { name: 'variable', arguments: '"answer","value":42}' } }] }),
        chunk({}, 'tool_calls'),
    ] : [chunk({ content: '4' }), chunk({ content: '2' }), chunk({}, 'stop')];
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

function callModel(provider: Provider, overrides: Partial<LlmRequest> = {}) {
    const restrictions = new Restrictions(home);
    return backend.call({
        kind: 'ask', model: `${provider}/${DEFAULT_MODELS[provider]}`, prompt: 'Prompt', showReasoning: false,
        restrictions, tools: new ToolHost(restrictions, home), ...overrides,
    });
}

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
        tokens: 2048,
    });
    expect(result).toMatchObject({ text: '42', effective: { provider, model: DEFAULT_MODELS[provider] } });
    expect(invokeAction).toHaveBeenCalledExactlyOnceWith({ name: 'save_variable', arguments: { name: 'answer', value: 42 } });
    expect(requests).toHaveLength(2);
    expect(result.effective.tokens).toBe(2048);
    for (const { body } of requests) {
        if (provider === 'google') expect(body.generationConfig).toMatchObject({ maxOutputTokens: 2048 });
        else expect(body[provider === 'openai' ? 'max_output_tokens' : 'max_tokens']).toBe(2048);
    }
    const header = provider === 'google' ? 'x-goog-api-key' : 'authorization';
    expect(requests[0].headers.get(header)).toBe(`${provider === 'google' ? '' : 'Bearer '}test-${provider}`);
    expect(requests[0].url).toContain(provider === 'google' ? 'generativelanguage.googleapis.com' : `api.${provider}.com`);
    const second = JSON.stringify(requests[1].body);
    expect(second).toContain('save_variable');
    expect(second).toContain('42');
    if (provider === 'openai') {
        expect(requests[0].body).toMatchObject({ store: false, parallel_tool_calls: false });
        expect(requests[0].body.tools).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'save_variable', strict: false })]));
    }
    if (provider === 'anthropic') expect(requests[0].headers.get('anthropic-version')).toBe('2023-06-01');
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

it.each(['ask', 'think'] as const)('omits OpenAI tool options for %s with and without a seed', async kind => {
    const requests: { url: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
        const body: Record<string, unknown> = JSON.parse(String(init.body));
        requests.push({ url: String(url), body });
        if ('parallel_tool_calls' in body && (!Array.isArray(body.tools) || !body.tools.length)) return new Response(JSON.stringify({
            error: { message: "'parallel_tool_calls' is only allowed when 'tools' are specified." },
        }), { status: 400, headers: { 'content-type': 'application/json' } });
        return sse(String(url).includes('/chat/completions') ? chatEvents(false) : providerEvents('openai', false));
    }));
    for (const seed of [undefined, 13]) {
        const result = await callModel('openai', {
            kind, model: 'openai/gpt-6-luna', tokens: 1024,
            randomness: { ...(seed !== undefined ? { seed } : {}), temperature: 0, top_p: 1 },
        });
        expect(result.text).toBe('42');
        const { url, body } = requests.at(-1)!;
        expect(url).toContain(seed === undefined ? '/responses' : '/chat/completions');
        expect(body).not.toHaveProperty('tools');
        expect(body).not.toHaveProperty('parallel_tool_calls');
        expect(body).toMatchObject({ temperature: 0, top_p: 1 });
        if (seed !== undefined) expect(body.seed).toBe(seed);
    }
    expect(requests).toHaveLength(2);
});

it.each([
    ['openai', 'gpt-4.1'],
    ['anthropic', 'claude-3-5-haiku-20241022'],
    ['google', 'gemini-2.5-flash'],
] as const)('sends supported %s sampling controls on every agent continuation and records unsupported controls accurately', async (provider, model) => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        return sse(provider === 'openai' ? chatEvents(bodies.length === 1) : providerEvents(provider, bodies.length === 1));
    }));
    const warn = vi.spyOn(Logger.prototype, 'warn');
    try {
        const restrictions = new Restrictions(home);
        const result = await backend.call({
            kind: 'agent', naturalLanguage: true, model: `${provider}/${model}`,
            prompt: 'Save the answer', showReasoning: false, restrictions,
            randomness: { seed: 42, temperature: 0, top_p: 0.01 },
            tokens: 2048,
            tools: new ToolHost(restrictions, home), runtimeTools: AGENT_TOOLS, invokeAction: async () => 42,
        });
        expect(bodies).toHaveLength(2);
        for (const body of bodies) {
            if (provider === 'google') expect(body.generationConfig).toMatchObject({ seed: 42, temperature: 0, topP: 0.01, maxOutputTokens: 2048 });
            else {
                expect(body.temperature).toBe(0);
                if (provider === 'openai') expect(body).toMatchObject({ seed: 42, top_p: 0.01, max_completion_tokens: 2048 });
                else expect(body).not.toHaveProperty('top_p');
            }
        }
        expect(result.effective.randomness).toEqual({
            seed: provider === 'anthropic' ? null : 42,
            temperature: 0,
            top_p: provider === 'anthropic' ? null : 0.01,
        });
        if (provider === 'anthropic') {
            expect(bodies[0]).not.toHaveProperty('seed');
            expect(warn).toHaveBeenCalledWith(expect.stringContaining('does not support randomness.seed'));
        }
        if (provider === 'openai') {
            expect(bodies[1].messages).toEqual(expect.arrayContaining([
                expect.objectContaining({ role: 'assistant', tool_calls: [expect.objectContaining({ id: 'tool_1', function: {
                    name: 'save_variable', arguments: '{"name":"answer","value":42}',
                } })] }),
                expect.objectContaining({ role: 'tool', tool_call_id: 'tool_1', content: '{"value":42}' }),
            ]));
            expect(result.effective.model).toBe('served-chat-model');
        }
        if (provider === 'anthropic') expect(warn).toHaveBeenCalledWith(expect.stringContaining('topP is ignored'));
    } finally {
        warn.mockRestore();
    }
});

it.each([
    ['openai', 'gpt-5.1'],
    ['openai', 'gpt-5.2'],
    ['openai', 'gpt-6-luna'],
    ['openai', 'gpt-6.1-terra'],
    ['anthropic', 'claude-sonnet-4-5'],
    ['anthropic', 'claude-sonnet-4-6'],
    ['anthropic', 'claude-opus-4-8'],
    ['google', 'gemini-2.5-flash'],
] as const)('disables default thinking for sampled %s/%s on every continuation', async (provider, model) => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        return sse(providerEvents(provider, bodies.length === 1));
    }));
    const restrictions = new Restrictions(home);
    const result = await backend.call({
        kind: 'agent', naturalLanguage: true, model: `${provider}/${model}`,
        prompt: 'Save the answer', showReasoning: true, restrictions,
        randomness: { temperature: 0 },
        tools: new ToolHost(restrictions, home), runtimeTools: AGENT_TOOLS, invokeAction: async () => 42,
    });
    expect(bodies).toHaveLength(2);
    for (const body of bodies) {
        if (provider === 'google') {
            expect(body.generationConfig).toMatchObject({
                temperature: 0, thinkingConfig: { thinkingBudget: 0, includeThoughts: true },
            });
        } else if (provider === 'openai') {
            expect(body).toMatchObject({ temperature: 0, reasoning: { effort: 'none' } });
        } else {
            expect(body.thinking).toEqual({ type: 'disabled' });
            if (model === 'claude-opus-4-8') expect(body).not.toHaveProperty('temperature');
            else expect(body.temperature).toBe(0);
        }
    }
    expect(result.effective.reasoningEffort).toBe('none');
    expect(result.effective.randomness).toEqual({
        seed: null, top_p: null,
        temperature: model === 'claude-opus-4-8' ? null : 0,
    });
});

it.each([
    ['openai', 'gpt-6-luna'],
    ['anthropic', 'claude-sonnet-4-5'],
    ['google', 'gemini-2.5-flash'],
] as const)('preserves explicit reasoning overrides with sampling for %s/%s', async (provider, model) => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        return sse(providerEvents(provider, false));
    }));
    const restrictions = new Restrictions(home);
    for (const effort of ['low', 'medium', 'high'] as const) {
        const result = await backend.call({
            kind: 'think', model: `${provider}/${model}`, reasoningEffort: effort,
            prompt: 'Prompt', showReasoning: true, restrictions,
            tools: new ToolHost(restrictions, home), randomness: { temperature: 0 },
        });
        expect(result.effective.reasoningEffort).toBe(effort);
        const body = bodies.at(-1)!;
        if (provider === 'openai') {
            expect(body.reasoning).toMatchObject({ effort });
            expect(body).not.toHaveProperty('temperature');
        } else if (provider === 'anthropic') {
            expect(body.thinking).toMatchObject({ type: 'enabled' });
            expect(body).not.toHaveProperty('temperature');
        } else {
            expect(body.generationConfig).toMatchObject({ temperature: 0, thinkingConfig: {
                thinkingBudget: { low: 1024, medium: 4096, high: 16384 }[effort],
            } });
        }
    }
});

it.each([
    ['openai', 'gpt-5', { reasoning: { effort: 'minimal' } }],
    ['openai', 'gpt-6-astra', { reasoning: { effort: 'low' } }],
    ['google', 'gemini-2.5-pro', { generationConfig: { thinkingConfig: { thinkingBudget: 128 } } }],
    ['google', 'gemini-3-flash-preview', { generationConfig: { thinkingConfig: { thinkingLevel: 'MINIMAL' } } }],
    ['anthropic', 'claude-opus-5-5', { output_config: { effort: 'low' } }],
    ['anthropic', 'claude-sonnet-5-5', { thinking: { type: 'between_tools' } }],
] as const)('warns when %s/%s cannot disable thinking, including an empty randomness prefix', async (provider, model, expected) => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        return sse(providerEvents(provider, false));
    }));
    const warn = vi.spyOn(Logger.prototype, 'warn');
    try {
        const restrictions = new Restrictions(home);
        const result = await backend.call({
            kind: 'ask', model: `${provider}/${model}`, prompt: 'Prompt', showReasoning: true,
            restrictions, tools: new ToolHost(restrictions, home), randomness: {},
        });
        expect(bodies).toHaveLength(1);
        expect(bodies[0]).toMatchObject(expected);
        if (model === 'claude-opus-5-5') expect(bodies[0]).not.toHaveProperty('thinking');
        expect(result.effective.reasoningEffort).toBeNull();
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('"feature":"reasoning"'));
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('"type":"compatibility"'));
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
] as const)('warns and omits sampling rejected by %s/%s without disabling reasoning', async (provider, model, reasoningEffort) => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        return sse(provider === 'openai' ? chatEvents(false) : providerEvents(provider, false));
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
        if (provider === 'openai') expect(bodies[0].seed).toBe(42);
        else expect(bodies[0]).not.toHaveProperty('seed');
        if (reasoningEffort !== undefined) {
            if (provider === 'openai') expect(bodies[0].reasoning_effort).toBe(reasoningEffort);
            else expect(bodies[0].thinking).toMatchObject({ type: 'enabled' });
        }
        expect(result.effective.randomness).toEqual({ seed: provider === 'openai' ? 42 : null, temperature: null, top_p: null });
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

it.each(PROVIDERS)('streams native %s responses with an authoritative replacement and the returned model identity', async provider => {
    const updates: LlmStreamUpdate[] = [];
    let events = providerEvents(provider, false);
    if (provider === 'google') {
        events = [{ modelVersion: 'served-model', candidates: [{ content: { parts: [{ text: '42' }] }, finishReason: 'STOP' }] }];
    } else if (provider === 'anthropic') {
        events[0] = { type: 'message_start', message: { id: 'msg_1', model: 'served-model', usage: { input_tokens: 1 } } };
    } else {
        events[0] = { type: 'response.created', response: { id: 'resp_1', model: 'served-model' } };
    }
    vi.stubGlobal('fetch', vi.fn(async () => sse(events)));
    const result = await callModel(provider, { onStream: update => updates.push(update) });
    expect(result).toMatchObject({ text: '42', effective: { backend: 'native-sdk', provider, model: 'served-model' } });
    expect(updates.map(({ mode, text }) => ({ mode, text }))).toEqual([
        { mode: 'append', text: '42' }, { mode: 'replace', text: '42' },
    ]);
});

it.each(PROVIDERS)('preserves %s signed reasoning and native tool calls in continuation history', async provider => {
    const bodies: Record<string, unknown>[] = [];
    const updates: LlmStreamUpdate[] = [];
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        const events = providerEvents(provider, bodies.length === 1);
        if (bodies.length !== 1) return sse(events);
        if (provider === 'google') return sse([{
            candidates: [{
                content: {
                    role: 'model', parts: [
                        { text: 'Thinking.', thought: true },
                        { functionCall: { name: 'save_variable', args: { name: 'answer', value: 42 } }, thoughtSignature: 'google-signature' },
                    ]
                }, finishReason: 'STOP'
            }],
        }]);
        if (provider === 'anthropic') return sse([
            events[0],
            { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
            { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Thinking.' } },
            { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'anthropic-signature' } },
            { type: 'content_block_stop', index: 0 },
            ...events.slice(1).map(event => typeof event === 'object' && event !== null && 'index' in event
                && typeof event.index === 'number' ? { ...event, index: event.index + 1 } : event),
        ]);
        return sse([
            events[0],
            { type: 'response.reasoning_summary_text.delta', item_id: 'reason_1', summary_index: 0, delta: 'Thinking.' },
            { type: 'response.reasoning_summary_text.done', item_id: 'reason_1', summary_index: 0, text: 'Thinking.' },
            {
                type: 'response.output_item.done', output_index: 0, item: {
                    type: 'reasoning', id: 'reason_1', summary: [{ type: 'summary_text', text: 'Thinking.' }], encrypted_content: 'openai-signature',
                }
            },
            ...events.slice(1).map(event => typeof event === 'object' && event !== null && 'output_index' in event
                && typeof event.output_index === 'number' ? { ...event, output_index: event.output_index + 1 } : event),
        ]);
    });
    vi.stubGlobal('fetch', fetch);
    const result = await callModel(provider, {
        kind: 'agent', naturalLanguage: true, showReasoning: true,
        runtimeTools: AGENT_TOOLS, invokeAction: async () => 42, onStream: update => updates.push(update),
    });
    expect(result).toMatchObject({ text: '42', reasoning: 'Thinking.' });
    expect(updates.filter(update => update.channel === 'reasoning').map(update => update.mode)).toEqual(['append', 'replace']);
    expect(JSON.stringify(bodies[1])).toContain(`${provider}-signature`);
    expect(JSON.stringify(bodies[1])).toContain('save_variable');
    expect(JSON.stringify(bodies[1])).toContain('Prompt');
});

it.each(PROVIDERS)('rejects truncated %s streams rather than accepting preview text', async provider => {
    const events = providerEvents(provider, false);
    vi.stubGlobal('fetch', vi.fn(async () => sse(provider === 'google'
        ? [{ candidates: [{ content: { parts: [{ text: 'Partial' }] } }] }]
        : events.slice(0, 3))));
    await expect(callModel(provider)).rejects.toThrow('did not complete');
});

it.each(PROVIDERS)('rejects abnormal native %s completion', async provider => {
    const events = providerEvents(provider, false);
    if (provider === 'google') events[0] = { candidates: [{ content: { parts: [{ text: 'Partial' }] }, finishReason: 'MAX_TOKENS' }] };
    else if (provider === 'anthropic') events[events.length - 2] = {
        type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 1 },
    };
    else events[events.length - 1] = { type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } };
    vi.stubGlobal('fetch', vi.fn(async () => sse(events)));
    await expect(callModel(provider)).rejects.toThrow('did not complete');
});

it.each(PROVIDERS)('cancels a stalled native %s stream and prevents further model calls', async provider => {
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    let signal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
        signal = init.signal ?? undefined;
        started();
        return new Response(new ReadableStream({
            start(controller) {
                signal?.addEventListener('abort', () => controller.error(signal!.reason), { once: true });
            },
        }), { headers: { 'content-type': 'text/event-stream' } });
    }));
    const result = callModel(provider);
    await ready;
    await backend.close();
    await expect(result).rejects.toThrow('cancelled');
    expect(signal?.aborted).toBe(true);
    await expect(callModel(provider)).rejects.toThrow('closed');
});

it.each(PROVIDERS.flatMap(provider => [429, 503].map(status => [provider, status] as const)))('does not retry %s HTTP %s errors', async (provider, status) => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'Service unavailable' } }), {
        status, headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetch);
    await expect(callModel(provider)).rejects.toThrow();
    expect(fetch).toHaveBeenCalledOnce();
});

it.each(PROVIDERS)('rejects unenabled native %s tools before executing an action', async provider => {
    vi.stubGlobal('fetch', vi.fn(async () => sse(providerEvents(provider, true))));
    const invokeAction = vi.fn(async () => 42);
    await expect(callModel(provider, { invokeAction })).rejects.toMatchObject({ statusCode: 'restriction_violation' });
    expect(invokeAction).not.toHaveBeenCalled();
});

it('keeps native Anthropic diagnostics inside the host logger, including deprecated models', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sse(providerEvents('anthropic', false))));
    const warn = vi.spyOn(console, 'warn');
    const error = vi.spyOn(console, 'error');
    try {
        await callModel('anthropic');
        expect(warn).not.toHaveBeenCalled();
        expect(error).not.toHaveBeenCalled();
    } finally {
        warn.mockRestore();
        error.mockRestore();
    }
});

it('keeps legacy Anthropic output limits above the configured thinking budget', async () => {
    let body: Record<string, unknown> | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
        body = JSON.parse(String(init.body));
        return sse(providerEvents('anthropic', false));
    }));
    await callModel('anthropic', { model: 'anthropic/claude-3-7-sonnet-20250219', reasoningEffort: 'high' });
    expect(body).toMatchObject({ thinking: { budget_tokens: 16384 } });
    expect(body?.max_tokens).toBeGreaterThan(16384);
});

it.each(PROVIDERS.flatMap(provider => (['ask', 'think', 'agent'] as const).map(kind => ({ provider, kind }))))
('honors $kind tokens with and without seeds on $provider', async ({ provider, kind }) => {
    const requests: { url: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
        requests.push({ url: String(url), body: JSON.parse(String(init.body)) });
        return sse(String(url).includes('/chat/completions') ? chatEvents(false) : providerEvents(provider, false));
    }));
    for (const seed of [undefined, 0]) {
        const result = await callModel(provider, {
            kind, tokens: 20000, reasoningEffort: 'high',
            ...(provider === 'openai' ? { model: 'openai/gpt-6-luna' } : {}),
            ...(seed !== undefined ? { randomness: { seed } } : {}),
        });
        expect(result).toMatchObject({ text: '42', effective: { tokens: 20000, reasoningEffort: 'high' } });
        const { url, body } = requests.at(-1)!;
        if (provider === 'google') {
            expect(body.generationConfig).toMatchObject({ maxOutputTokens: 20000 });
        } else if (provider === 'anthropic') {
            expect(body.max_tokens).toBe(20000);
            expect(body).not.toHaveProperty('seed');
        } else {
            expect(url).toContain(seed === undefined ? '/responses' : '/chat/completions');
            expect(body[seed === undefined ? 'max_output_tokens' : 'max_completion_tokens']).toBe(20000);
            if (kind === 'agent') {
                expect(body.tools).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'function' })]));
                expect(body.parallel_tool_calls).toBe(false);
            }
            if (seed !== undefined) {
                expect(body.seed).toBe(0);
                expect(body.reasoning_effort).toBe('high');
                expect(body.messages).toHaveLength(2);
            }
        }
        if (seed !== undefined) expect(result.effective.randomness).toMatchObject({ seed: provider === 'anthropic' ? null : 0 });
    }
    expect(requests).toHaveLength(2);
});

it.each(PROVIDERS)('preserves %s output-budget defaults when tokens is omitted', async provider => {
    let body: Record<string, unknown> = {};
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
        body = JSON.parse(String(init.body));
        return sse(providerEvents(provider, false));
    }));
    const result = await callModel(provider);
    expect(result.effective).not.toHaveProperty('tokens');
    if (provider === 'google') expect(body.generationConfig).not.toHaveProperty('maxOutputTokens');
    else if (provider === 'openai') expect(body).not.toHaveProperty('max_output_tokens');
    else expect(body.max_tokens).toBe(64000);
});

it('never expands an explicit Anthropic generation budget to accommodate manual thinking', async () => {
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
        expect(JSON.parse(String(init.body))).toMatchObject({ max_tokens: 16385, thinking: { budget_tokens: 16384 } });
        return sse(providerEvents('anthropic', false));
    });
    vi.stubGlobal('fetch', fetch);
    const req = { model: 'anthropic/claude-3-7-sonnet-20250219', reasoningEffort: 'high' as const };
    await expect(callModel('anthropic', { ...req, tokens: 16384 })).rejects.toThrow(/must exceed the Anthropic thinking budget/);
    expect(fetch).not.toHaveBeenCalled();
    expect(await callModel('anthropic', { ...req, tokens: 16385 })).toMatchObject({ effective: { tokens: 16385 } });
    expect(fetch).toHaveBeenCalledOnce();
});

it('warns about unavailable reasoning summaries on seeded OpenAI calls without removing reasoning effort', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sse(chatEvents(false))));
    const warn = vi.spyOn(Logger.prototype, 'warn');
    try {
        const result = await callModel('openai', {
            model: 'openai/gpt-6-luna', randomness: { seed: 0 }, reasoningEffort: 'high', showReasoning: true,
        });
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('does not expose reasoning summaries'));
        expect(result.effective.reasoningEffort).toBe('high');
        expect(result.reasoning).toBeUndefined();
    } finally {
        warn.mockRestore();
    }
});

it.each(['length', 'content_filter', 'unknown'])('rejects seeded OpenAI %s finishes without executing incomplete tool calls', async finish => {
    const events = chatEvents(true);
    events[events.length - 1] = { model: 'served-chat-model', choices: [{ index: 0, delta: { content: 'Partial' }, finish_reason: finish }] };
    vi.stubGlobal('fetch', vi.fn(async () => sse(events)));
    const invokeAction = vi.fn();
    await expect(callModel('openai', {
        kind: 'agent', naturalLanguage: true, runtimeTools: AGENT_TOOLS, invokeAction,
        randomness: { seed: 42 }, tokens: 1,
    })).rejects.toThrow(`model turn did not complete (${finish})`);
    expect(invokeAction).not.toHaveBeenCalled();
});

it('surfaces seeded OpenAI API errors without falling back to Responses or retrying', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({
        error: { message: 'This model does not support Chat Completions', type: 'invalid_request_error' },
    }), { status: 400, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetch);
    await expect(callModel('openai', { randomness: { seed: 42 } })).rejects.toThrow(/does not support Chat Completions/);
    expect(fetch).toHaveBeenCalledOnce();
});

it('rejects malformed seeded OpenAI tool JSON before executing an action', async () => {
    const events = chatEvents(true);
    events[1] = { model: 'served-chat-model', choices: [{ index: 0, delta: {
        tool_calls: [{ index: 0, function: { name: 'variable', arguments: 'invalid' } }],
    }, finish_reason: null }] };
    vi.stubGlobal('fetch', vi.fn(async () => sse(events)));
    const invokeAction = vi.fn();
    await expect(callModel('openai', {
        kind: 'agent', naturalLanguage: true, runtimeTools: AGENT_TOOLS, invokeAction, randomness: { seed: 42 },
    })).rejects.toThrow(/invalid JSON/);
    expect(invokeAction).not.toHaveBeenCalled();
});

it.each([
    { refusal: 'Cannot comply' },
    { function_call: { name: 'legacy_tool', arguments: '{}' } },
])('surfaces unsupported seeded OpenAI content explicitly: %j', async delta => {
    vi.stubGlobal('fetch', vi.fn(async () => sse([
        { model: 'served-chat-model', choices: [{ index: 0, delta, finish_reason: 'stop' }] },
    ])));
    await expect(callModel('openai', { randomness: { seed: 42 } })).rejects.toThrow(/refused the request|unsupported legacy function call/);
});

it('cancels a stalled seeded OpenAI stream and marks its partial reply as incomplete', async () => {
    let signal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
        signal = init.signal ?? undefined;
        return new Response(new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chatEvents(false)[0])}\n\n`));
                signal?.addEventListener('abort', () => controller.error(signal!.reason), { once: true });
            },
        }), { headers: { 'content-type': 'text/event-stream' } });
    }));
    const updates: LlmStreamUpdate[] = [];
    const pending = callModel('openai', {
        randomness: { seed: 42 }, onStream(update) {
            updates.push(update);
            void backend.close();
        },
    });
    await expect(pending).rejects.toThrow('the model call was cancelled');
    expect(signal?.aborted).toBe(true);
    expect(updates).toEqual([{ channel: 'response', messageId: '0:answer', mode: 'append', text: '4' }]);
});

it.each(['openai', 'anthropic'] as const)('rejects malformed native %s tool JSON before executing runtime actions', async provider => {
    const events = providerEvents(provider, true);
    if (provider === 'anthropic') events[2] = {
        type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{invalid' },
    };
    else events[events.length - 2] = {
        type: 'response.output_item.done', output_index: 0,
        item: { type: 'function_call', id: 'fc_1', call_id: 'tool_1', name: 'save_variable', arguments: '{invalid' },
    };
    vi.stubGlobal('fetch', vi.fn(async () => sse(events)));
    const invokeAction = vi.fn(async () => 42);
    await expect(callModel(provider, {
        kind: 'agent', naturalLanguage: true, runtimeTools: AGENT_TOOLS, invokeAction,
    })).rejects.toMatchObject({ statusCode: 'runtime_error' });
    expect(invokeAction).not.toHaveBeenCalled();
});

it.each(PROVIDERS)('keeps %s provider selection independent of native-client environment overrides', async provider => {
    vi.stubEnv('OPENAI_BASE_URL', 'https://unexpected.example.test');
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://unexpected.example.test');
    vi.stubEnv('GOOGLE_GEMINI_BASE_URL', 'https://unexpected.example.test');
    vi.stubEnv('GOOGLE_GENAI_USE_ENTERPRISE', 'true');
    vi.stubEnv('GOOGLE_GENAI_USE_VERTEXAI', 'true');
    vi.stubEnv('OPENAI_ORG_ID', 'unexpected-org');
    vi.stubEnv('OPENAI_PROJECT_ID', 'unexpected-project');
    let url: string | undefined;
    let headers: Headers | undefined;
    vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit) => {
        url = String(input);
        headers = new Headers(init.headers);
        return sse(providerEvents(provider, false));
    }));
    expect(await callModel(provider)).toMatchObject({ text: '42', effective: { provider } });
    expect(url).toContain(provider === 'google' ? 'generativelanguage.googleapis.com' : `api.${provider}.com`);
    expect(headers?.has('openai-organization')).toBe(false);
    expect(headers?.has('openai-project')).toBe(false);
});
