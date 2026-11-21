import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AiBackend } from '../src/ai.js';
import { DEFAULT_MODELS, PROVIDERS, PROVIDER_ENV, resolveProvider, type Provider } from '../src/auth.js';
import { Failure } from '../src/errors.js';
import { agent, ask, attach, configure, defineTool } from '../src/index.js';
import { LlmError, type LlmRequest } from '../src/llm.js';
import { Logger } from '../src/logger.js';
import { estimateCostUsd, inferProvider, resolveModelCapabilities } from '../src/models.js';
import { Restrictions, makeRestriction } from '../src/restrict.js';
import { Runtime, setAmbient } from '../src/runtime.js';
import { ToolHost } from '../src/tools.js';
import { Trace } from '../src/trace.js';
import { traceHtml } from '../src/trace-html.js';
import { Int, Str, Struct } from '../src/types.js';
import { run } from '../src/workflow.js';
import { agentBlock, cleanTemp, exec, scripted, silent, tempDir } from './helpers.js';

let home: string;
let backend: AiBackend | undefined;

const sse = (events: unknown[]) => new Response(events.map(event => {
    const type = typeof event === 'object' && event !== null && 'type' in event ? `event: ${event.type}\n` : '';
    return `${type}data: ${JSON.stringify(event)}\n\n`;
}).join(''), {
    headers: { 'content-type': 'text/event-stream' },
});

function providerUsageEvents(provider: Provider, text: string) {
    if (provider === 'google') return [{
        candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50, totalTokenCount: 150, cachedContentTokenCount: 20, thoughtsTokenCount: 10 },
    }];
    if (provider === 'anthropic') return [
        { type: 'message_start', message: { id: 'msg_1', model: DEFAULT_MODELS.anthropic, usage: { input_tokens: 100, cache_read_input_tokens: 20 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 50 } },
        { type: 'message_stop' },
    ];
    return [
        { type: 'response.created', response: { id: 'resp_1', created_at: 1, model: DEFAULT_MODELS.openai } },
        { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: text },
        { type: 'response.output_text.done', item_id: 'msg_1', output_index: 0, content_index: 0, text },
        {
            type: 'response.output_item.done', output_index: 0,
            item: { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] },
        },
        {
            type: 'response.completed',
            response: {
                model: DEFAULT_MODELS.openai,
                usage: {
                    input_tokens: 100,
                    output_tokens: 50,
                    total_tokens: 150,
                    input_tokens_details: { cached_tokens: 20 },
                    output_tokens_details: { reasoning_tokens: 10 },
                },
            },
        },
    ];
}

function chatUsageEvents(text: string, toolCall?: { id: string; name: string; args: string }) {
    if (toolCall) {
        return [
            {
                id: 'chat_1', object: 'chat.completion.chunk', created: 1, model: 'local-llama',
                choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: toolCall.id, type: 'function', function: { name: toolCall.name, arguments: toolCall.args } }] }, finish_reason: null }],
            },
            {
                id: 'chat_1', object: 'chat.completion.chunk', created: 1, model: 'local-llama',
                choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
                usage: { prompt_tokens: 40, completion_tokens: 10, total_tokens: 50 },
            },
        ];
    }
    return [
        {
            id: 'chat_1', object: 'chat.completion.chunk', created: 1, model: 'local-llama',
            choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
        },
        {
            id: 'chat_1', object: 'chat.completion.chunk', created: 1, model: 'local-llama',
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 60, completion_tokens: 20, total_tokens: 80 },
        },
    ];
}

beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'spl-upgrades-'));
    vi.stubEnv('SPL_HOME', home);
    for (const provider of PROVIDERS) vi.stubEnv(PROVIDER_ENV[provider][0], `test-${provider}`);
    backend = new AiBackend({ cwd: home, timeoutMs: 2000, logger: new Logger('silent') });
});

afterEach(async () => {
    await backend?.close();
    backend = undefined;
    setAmbient(undefined);
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    cleanTemp();
    fs.rmSync(home, { recursive: true, force: true });
});

describe('native structured outputs', () => {
    const Invoice = Struct('Invoice', { vendor: Str, total: Int });

    it.each(PROVIDERS)('wires responseSchema to %s native structured output parameter', async provider => {
        const bodies: Record<string, unknown>[] = [];
        vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
            bodies.push(JSON.parse(String(init.body)));
            return sse(providerUsageEvents(provider, '{"vendor":"Acme","total":42}'));
        }));
        const rt = configure({ backend, model: `${provider}/${DEFAULT_MODELS[provider]}`, logLevel: 'silent' });
        const result = await ask('Extract invoice', { schema: Invoice });
        expect(result).toEqual({ vendor: 'Acme', total: 42 });
        expect(bodies).toHaveLength(1);
        if (provider === 'openai') {
            expect(bodies[0].text).toMatchObject({
                format: { type: 'json_schema', name: 'spl_output', strict: false, schema: Invoice.schema() },
            });
        } else if (provider === 'anthropic') {
            expect(bodies[0].output_config).toMatchObject({
                format: { type: 'json_schema', schema: Invoice.schema() },
            });
        } else {
            expect(bodies[0].generationConfig).toMatchObject({
                responseMimeType: 'application/json',
                responseJsonSchema: Invoice.schema(),
            });
        }
        expect(rt.usage.totalTokens).toBe(150);
    });

    it('preserves Anthropic effort alongside output_config.format on adaptive models', async () => {
        const bodies: Record<string, unknown>[] = [];
        vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
            bodies.push(JSON.parse(String(init.body)));
            return sse(providerUsageEvents('anthropic', '{"vendor":"Acme","total":42}'));
        }));
        configure({ backend, model: 'anthropic/claude-sonnet-4-6', logLevel: 'silent' });
        await ask('Extract', { schema: Invoice, reasoning: 'high' });
        expect(bodies[0].output_config).toEqual({
            effort: 'high',
            format: { type: 'json_schema', schema: Invoice.schema() },
        });
    });

    it('uses response_format json_schema on seeded OpenAI Chat Completions', async () => {
        const bodies: Record<string, unknown>[] = [];
        vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
            bodies.push(JSON.parse(String(init.body)));
            return sse(chatUsageEvents('{"vendor":"Acme","total":42}'));
        }));
        configure({ backend, model: 'openai/gpt-4.1', logLevel: 'silent' });
        const result = await ask('Extract', { schema: Invoice, seed: 7 });
        expect(result).toEqual({ vendor: 'Acme', total: 42 });
        expect(bodies[0].response_format).toEqual({
            type: 'json_schema',
            json_schema: { name: 'spl_output', strict: false, schema: Invoice.schema() },
        });
    });

    it('skips root non-object native json_schema on OpenAI/Anthropic while sending it on Google', async () => {
        const bodies: Record<string, unknown>[] = [];
        vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
            bodies.push(JSON.parse(String(init.body)));
            return sse(providerUsageEvents(bodies.length === 1 ? 'openai' : 'google', '42'));
        }));
        configure({ backend, logLevel: 'silent' });
        expect(await ask('Pick a number', { schema: Int, model: 'openai/gpt-4.1' })).toBe(42);
        expect(await ask('Pick a number', { schema: Int, model: 'google/gemini-2.5-flash' })).toBe(42);
        expect(bodies[0]).not.toHaveProperty('text');
        expect(bodies[1].generationConfig).toMatchObject({ responseMimeType: 'application/json', responseJsonSchema: { type: 'integer' } });
    });
});

describe('token usage, cost tracking and budgets', () => {
    it.each(PROVIDERS)('captures %s token usage and estimated cost across calls', async provider => {
        vi.stubGlobal('fetch', vi.fn(async () => sse(providerUsageEvents(provider, 'hello'))));
        const rt = configure({ backend, model: `${provider}/${DEFAULT_MODELS[provider]}`, logLevel: 'silent' });
        await ask('One');
        await ask('Two');
        expect(rt.usage.inputTokens).toBe(200);
        expect(rt.usage.outputTokens).toBe(100);
        expect(rt.usage.totalTokens).toBe(300);
        expect(rt.usage.cachedTokens).toBe(40);
        if (provider !== 'anthropic') expect(rt.usage.reasoningTokens).toBe(20);
        expect(rt.estimatedCostUsd).toBeGreaterThan(0);
    });

    it('enforces maxSteps on agent() and in --- agent block headers', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => sse(chatUsageEvents('', { id: 'c1', name: 'lookup', args: '{"q":"a"}' }))));
        const customBackend = new AiBackend({
            cwd: home, timeoutMs: 2000, logger: new Logger('silent'),
            provider: 'openai-compatible', baseUrl: 'http://localhost:11434/v1',
        });
        try {
            configure({ backend: customBackend, model: 'openai-compatible/local-llama', logLevel: 'silent' });
            const lookup = defineTool({
                name: 'lookup',
                description: 'Look up',
                input: Struct('Lookup', { q: Str }),
                execute: ({ q }) => `found ${q}`,
            });
            await expect(agent('Loop forever', { tools: [lookup], builtinTools: false, maxSteps: 2 }))
                .rejects.toMatchObject({ statusCode: 'llm_error', reason: expect.stringContaining('maxSteps (2)') });
        } finally {
            await customBackend.close();
        }
    });

    it('forwards maxSteps from agent block headers and file defaults', async () => {
        const seen: (number | undefined)[] = [];
        const model = {
            async call(req: LlmRequest) {
                seen.push(req.maxSteps);
                return { text: 'Done.', effective: {} };
            },
            async close() {},
        };
        const source = [
            '---', 'maxSteps: 5', '---',
            agentBlock('First'),
            agentBlock('Second', 'maxSteps: 3'),
        ].join('\n');
        const res = await exec(source, { backend: model });
        expect(res.status).toBe('success');
        expect(seen).toEqual([5, 3]);
    });

    it('enforces runtime maxTotalTokens and maxCostUsd budgets', async () => {
        const metered = {
            async call() {
                return {
                    text: 'ok',
                    effective: { model: 'gpt-4.1' },
                    usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
                    costUsd: 0.05,
                };
            },
            async close() {},
        };
        const rtTokens = new Runtime({ backend: metered, logger: silent, maxTotalTokens: 200 });
        await rtTokens.run(async () => {
            expect(await ask('first')).toBe('ok');
            await expect(ask('second')).rejects.toMatchObject({ statusCode: 'llm_error', reason: expect.stringContaining('total token budget exceeded') });
        });
        const rtCost = new Runtime({ backend: metered, logger: silent, maxCostUsd: 0.08 });
        await rtCost.run(async () => {
            expect(await ask('first')).toBe('ok');
            await expect(ask('second')).rejects.toMatchObject({ statusCode: 'llm_error', reason: expect.stringContaining('cost budget exceeded') });
        });
    });

    it('renders usage and cost in trace HTML reports', async () => {
        const dir = tempDir('spl-trace-usage-');
        const traceFile = path.join(dir, 'run.jsonl');
        const source = "success(await ask('Hi'));";
        const metered = {
            async call() {
                return {
                    text: 'Hello',
                    effective: { provider: 'openai', model: 'gpt-4.1' },
                    usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150 },
                    costUsd: 0.0012,
                };
            },
            async close() {},
        };
        const trace = Trace.open(traceFile, { source, runtime: 'test', cwd: dir });
        try {
            const res = await run(source, { backend: metered, logger: silent, cwd: dir, trace });
            trace.finish(res);
        } finally {
            trace.close();
        }
        const html = traceHtml(fs.readFileSync(traceFile, 'utf8'), { title: 'usage.spl', source });
        expect(html).toContain('usage: 120+30=150 tok');
        expect(html).toContain('~$0.0012');
    });
});

describe('custom tools and selective built-in tools', () => {
    it('registers custom typed tools, coerces inputs, disables built-ins, and records calls', async () => {
        const bodies: Record<string, unknown>[] = [];
        vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
            bodies.push(JSON.parse(String(init.body)));
            return sse(bodies.length === 1
                ? chatUsageEvents('', { id: 'call_1', name: 'doubleNum', args: '{"n":"21"}' })
                : chatUsageEvents('The answer is 42.'));
        }));
        const customBackend = new AiBackend({
            cwd: home, timeoutMs: 2000, logger: new Logger('silent'),
            provider: 'openai-compatible', baseUrl: 'http://localhost:11434/v1',
        });
        try {
            const rt = configure({ backend: customBackend, model: 'openai-compatible/local-llama', logLevel: 'silent' });
            const received: number[] = [];
            const doubleNum = defineTool({
                name: 'doubleNum',
                description: 'Doubles an integer',
                input: Struct('DoubleInput', { n: Int }),
                execute: ({ n }) => {
                    received.push(n);
                    return { doubled: n * 2 };
                },
            });
            const reply = await agent('Double 21', { tools: [doubleNum], builtinTools: false });
            expect(reply).toBe('The answer is 42.');
            expect(received).toEqual([21]);
            expect((bodies[0].tools as { function: { name: string } }[]).map(t => t.function.name)).toEqual(['doubleNum']);
            expect(JSON.stringify(bodies[1].messages)).toContain('{\\"doubled\\":42}');
            expect(rt.toolCalls).toEqual([{ name: 'doubleNum', arguments: { n: '21' }, success: true }]);
        } finally {
            await customBackend.close();
        }
    });

    it('supports map syntax for tools and selective builtinTools list', async () => {
        const bodies: Record<string, unknown>[] = [];
        vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
            bodies.push(JSON.parse(String(init.body)));
            return sse(chatUsageEvents('Done'));
        }));
        const customBackend = new AiBackend({
            cwd: home, timeoutMs: 2000, logger: new Logger('silent'),
            provider: 'openai-compatible', baseUrl: 'http://localhost:11434/v1',
        });
        try {
            configure({ backend: customBackend, model: 'openai-compatible/local-llama', logLevel: 'silent' });
            await agent('Act', {
                builtinTools: ['readFile'],
                tools: {
                    ping: {
                        description: 'Ping',
                        input: { type: 'object', properties: {} },
                        execute: () => 'pong',
                    },
                },
            });
            const toolNames = (bodies[0].tools as { function: { name: string } }[]).map(t => t.function.name);
            expect(toolNames).toEqual(['readFile', 'ping']);
        } finally {
            await customBackend.close();
        }
    });

    it('rejects agent-only options on ask()', async () => {
        const model = scripted('nope');
        configure({ backend: model, logLevel: 'silent' });
        await expect(ask('Hi', { maxSteps: 2 } as any)).rejects.toMatchObject({ statusCode: 'runtime_error' });
        await expect(ask('Hi', { builtinTools: false } as any)).rejects.toMatchObject({ statusCode: 'runtime_error' });
        expect(model.calls).toHaveLength(0);
    });
});

describe('resilient retries and custom baseUrl / openai-compatible', () => {
    it('retries transient 429 and 503 responses with backoff when maxRetries > 0', async () => {
        let attempts = 0;
        vi.stubGlobal('fetch', vi.fn(async () => {
            attempts++;
            if (attempts === 1) {
                return new Response(JSON.stringify({ error: { message: 'Rate limited' } }), {
                    status: 429, headers: { 'content-type': 'application/json', 'retry-after': '0' },
                });
            }
            if (attempts === 2) {
                return new Response(JSON.stringify({ error: { message: 'Overloaded' } }), {
                    status: 503, headers: { 'content-type': 'application/json' },
                });
            }
            return sse(providerUsageEvents('openai', 'recovered'));
        }));
        const retrying = new AiBackend({ cwd: home, timeoutMs: 5000, logger: silent, maxRetries: 2, retryDelayMs: 5 });
        try {
            const restrictions = new Restrictions(home);
            const res = await retrying.call({
                kind: 'ask', model: 'openai/gpt-4.1', prompt: 'Hi', showReasoning: false,
                restrictions, tools: new ToolHost(restrictions, home),
            });
            expect(res.text).toBe('recovered');
            expect(attempts).toBe(3);
        } finally {
            await retrying.close();
        }
    });

    it('never retries 400 client errors even when maxRetries > 0', async () => {
        const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'Bad request' } }), {
            status: 400, headers: { 'content-type': 'application/json' },
        }));
        vi.stubGlobal('fetch', fetchMock);
        const retrying = new AiBackend({ cwd: home, timeoutMs: 5000, logger: silent, maxRetries: 3, retryDelayMs: 5 });
        try {
            const restrictions = new Restrictions(home);
            await expect(retrying.call({
                kind: 'ask', model: 'openai/gpt-4.1', prompt: 'Hi', showReasoning: false,
                restrictions, tools: new ToolHost(restrictions, home),
            })).rejects.toThrow();
            expect(fetchMock).toHaveBeenCalledOnce();
        } finally {
            await retrying.close();
        }
    });

    it('routes openai-compatible and custom baseUrl requests to the configured endpoint', async () => {
        const urls: string[] = [];
        vi.stubGlobal('fetch', vi.fn(async (url: string) => {
            urls.push(String(url));
            return sse(urls.length === 1 ? chatUsageEvents('from-ollama') : providerUsageEvents('anthropic', 'from-proxy'));
        }));
        const compat = new AiBackend({
            cwd: home, timeoutMs: 2000, logger: silent,
            baseUrls: {
                'openai-compatible': 'http://127.0.0.1:11434/v1',
                anthropic: 'https://proxy.example.test',
            },
        });
        try {
            const restrictions = new Restrictions(home);
            const r1 = await compat.call({
                kind: 'ask', model: 'openai-compatible/llama3.3', prompt: 'Hi', showReasoning: false,
                restrictions, tools: new ToolHost(restrictions, home),
            });
            expect(r1.text).toBe('from-ollama');
            expect(r1.effective.provider).toBe('openai-compatible');
            expect(urls[0]).toBe('http://127.0.0.1:11434/v1/chat/completions');

            const r2 = await compat.call({
                kind: 'ask', model: 'anthropic/claude-sonnet-4-5', prompt: 'Hi', showReasoning: false,
                restrictions, tools: new ToolHost(restrictions, home),
            });
            expect(r2.text).toBe('from-proxy');
            expect(urls[1]).toContain('https://proxy.example.test/v1/messages');
        } finally {
            await compat.close();
        }
    });

    it('resolves openai-compatible from SPL_OPENAI_COMPATIBLE_BASE_URL without requiring an API key', () => {
        vi.stubEnv('SPL_OPENAI_COMPATIBLE_BASE_URL', 'http://localhost:8000/v1');
        expect(resolveProvider('openai-compatible/qwen2.5')).toEqual({
            provider: 'openai-compatible',
            model: 'qwen2.5',
            apiKey: 'no-key',
            baseUrl: 'http://localhost:8000/v1',
        });
    });
});

describe('consolidated model capability registry', () => {
    it('infers providers, resolves capabilities, supports overrides and estimates cost', () => {
        expect(inferProvider('gpt-4.1')).toBe('openai');
        expect(inferProvider('claude-sonnet-4-6')).toBe('anthropic');
        expect(inferProvider('gemini-2.5-flash')).toBe('google');
        expect(inferProvider('llama3')).toBeUndefined();

        expect(resolveModelCapabilities('anthropic', 'claude-sonnet-4-6')).toMatchObject({
            reasoning: 'adaptive',
            defaultMaxTokens: 128000,
        });
        const custom = resolveModelCapabilities('openai-compatible', 'my-reasoner', [
            { provider: 'openai-compatible', match: /^my-reasoner$/, capabilities: { reasoning: 'effort', pricing: { input: 1, output: 2 } } },
        ]);
        expect(custom.reasoning).toBe('effort');
        expect(estimateCostUsd('openai-compatible', 'my-reasoner', { inputTokens: 1_000_000, outputTokens: 500_000, totalTokens: 1_500_000 }, [
            { provider: 'openai-compatible', match: /^my-reasoner$/, capabilities: { pricing: { input: 1, output: 2 } } },
        ])).toBeCloseTo(2.0);
    });
});

describe('multimodal attachments', () => {
    it('builds attachments from local files, URLs, data URLs and bytes while enforcing restrictions', () => {
        const dir = tempDir('spl-attach-');
        const imgPath = path.join(dir, 'chart.png');
        const pdfPath = path.join(dir, 'invoice.pdf');
        fs.writeFileSync(imgPath, Uint8Array.from([0x89, 0x50, 0x4e, 0x47]));
        fs.writeFileSync(pdfPath, '%PDF-1.4');

        const img = attach(imgPath);
        expect(img).toMatchObject({ kind: 'image', mediaType: 'image/png', name: 'chart.png' });
        expect(img.data).toBeInstanceOf(Uint8Array);

        const pdf = attach(pdfPath);
        expect(pdf).toMatchObject({ kind: 'file', mediaType: 'application/pdf', name: 'invoice.pdf' });

        const urlAtt = attach('https://example.com/photo.webp');
        expect(urlAtt).toMatchObject({ kind: 'image', mediaType: 'image/webp', data: 'https://example.com/photo.webp' });

        const dataAtt = attach('data:image/jpeg;base64,/9j/4AAQ');
        expect(dataAtt).toMatchObject({ kind: 'image', mediaType: 'image/jpeg' });

        const rawAtt = attach(Uint8Array.from([1, 2, 3]), { mediaType: 'application/pdf', name: 'raw.pdf' });
        expect(rawAtt).toMatchObject({ kind: 'file', mediaType: 'application/pdf', name: 'raw.pdf' });

        const rt = new Runtime({ backend: scripted('ok'), logger: silent, cwd: dir });
        const restricted = { ...rt.root, restrictions: new Restrictions(dir).with(makeRestriction('fs', path.join(dir, 'sub'), dir)) };
        expect(() => rt.run(() => attach(imgPath), restricted)).toThrow(Failure);
    });

    it.each(PROVIDERS)('serializes image and PDF attachments natively for %s', async provider => {
        const bodies: Record<string, unknown>[] = [];
        vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
            bodies.push(JSON.parse(String(init.body)));
            return sse(providerUsageEvents(provider, 'Analyzed'));
        }));
        configure({ backend, model: `${provider}/${DEFAULT_MODELS[provider]}`, logLevel: 'silent' });
        const img = attach(Uint8Array.from([1, 2, 3]), { mediaType: 'image/png', name: 'pic.png' });
        const pdf = attach(Uint8Array.from([4, 5, 6]), { mediaType: 'application/pdf', name: 'doc.pdf' });
        const answer = await ask('Describe both', { attachments: [img, pdf] });
        expect(answer).toBe('Analyzed');
        const payload = JSON.stringify(bodies[0]);
        if (provider === 'openai') {
            expect(payload).toContain('"type":"input_image"');
            expect(payload).toContain('"type":"input_file"');
            expect(payload).toContain('data:image/png;base64,AQID');
            expect(payload).toContain('data:application/pdf;base64,BAUG');
        } else if (provider === 'anthropic') {
            expect(payload).toContain('"type":"image"');
            expect(payload).toContain('"type":"document"');
            expect(payload).toContain('"media_type":"image/png"');
            expect(payload).toContain('"media_type":"application/pdf"');
        } else {
            expect(payload).toContain('"mimeType":"image/png"');
            expect(payload).toContain('"mimeType":"application/pdf"');
            expect(payload).toContain('"data":"AQID"');
        }
    });
});
