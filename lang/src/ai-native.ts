import type { ResponseInputContent, ResponseInputItem } from 'openai/resources/responses/responses';
import type OpenAI from 'openai';
import type { ChatCompletionContentPart, ChatCompletionMessageParam, ChatCompletionMessageFunctionToolCall } from 'openai/resources/chat/completions/completions';
import type { ContentBlockParam, MessageParam, MessageCreateParamsStreaming, RawMessageStreamEvent, ThinkingConfigParam } from '@anthropic-ai/sdk/resources/messages';
import type { Stream } from '@anthropic-ai/sdk/core/streaming';
import type { Content, Part } from '@google/genai';
import type { Provider, ProviderId } from './auth.js';
import { DECISION_MODELS, LlmError, type Attachment, type DecisionRequest, type DecisionResponse, type RuntimeTool, type TokenUsage } from './llm.js';
import type { Logger } from './logger.js';
import { resolveModelCapabilities, type ModelCapabilityRule } from './models.js';

export interface ProviderOptions {
    openai?: { parallelToolCalls?: boolean; store?: boolean; reasoningSummary?: 'auto' | null; reasoningEffort?: Effort | 'xhigh' };
    anthropic?: {
        disableParallelToolUse?: boolean;
        thinking?: { type: 'adaptive' } | { type: 'enabled'; budgetTokens: number };
        effort?: Effort | 'max';
    };
    google?: { thinkingConfig?: { includeThoughts?: boolean; thinkingBudget?: number; thinkingLevel?: Effort } };
}

type Effort = 'low' | 'medium' | 'high';

export interface ModelWarning {
    type: 'unsupported' | 'compatibility';
    feature: string;
    details?: string;
    /** Set when a sampling setting is dropped because the model is reasoning. */
    conflict?: 'reasoning';
}

export type ModelStreamPart =
    | { type: 'stream-start'; warnings: ModelWarning[] }
    | { type: 'text-start' | 'reasoning-start'; id: string }
    | { type: 'text-delta' | 'reasoning-delta'; id: string; delta: string }
    | { type: 'text-end' | 'reasoning-end'; id: string; text?: string }
    | { type: 'tool-input-start'; toolName: string; providerExecuted?: boolean }
    | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown; providerExecuted?: boolean }
    | { type: 'tool-error'; toolName: string; error: unknown }
    | { type: 'finish'; reason: string; modelId?: string; usage?: TokenUsage };

export interface ToolOutput {
    toolCallId: string;
    toolName: string;
    value: string;
}

export interface ModelCallOptions {
    system: string;
    prompt: string;
    tools: RuntimeTool[];
    providerOptions: ProviderOptions;
    abortSignal: AbortSignal;
    reasoning?: 'none';
    responseSchema?: Record<string, unknown>;
    attachments?: readonly Attachment[];
    seed?: number;
    tokens?: number;
    temperature?: number;
    topP?: number;
}

export interface NativeModelOptions {
    baseUrl?: string;
    modelCapabilities?: readonly ModelCapabilityRule[];
}

export interface NativeModel {
    stream(options: ModelCallOptions): AsyncIterable<ModelStreamPart>;
    addToolResults(outputs: ToolOutput[]): void;
}

function toolCall(toolName: string, toolCallId: string, input: string): ModelStreamPart {
    try {
        return { type: 'tool-call', toolName, toolCallId, input: JSON.parse(input) };
    } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        return { type: 'tool-error', toolName, error: `invalid JSON arguments: ${error.message}` };
    }
}

const isObjectSchema = (schema: Record<string, unknown> | undefined): schema is Record<string, unknown> =>
    Boolean(schema && schema.type === 'object');

function makeUsage(
    inputTokens: number | undefined,
    outputTokens: number | undefined,
    totalTokens?: number,
    cachedTokens?: number,
    reasoningTokens?: number,
): TokenUsage | undefined {
    if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) return undefined;
    const input = inputTokens ?? 0;
    const output = outputTokens ?? 0;
    return {
        inputTokens: input,
        outputTokens: output,
        totalTokens: totalTokens ?? (input + output),
        ...(cachedTokens !== undefined && cachedTokens > 0 ? { cachedTokens } : {}),
        ...(reasoningTokens !== undefined && reasoningTokens > 0 ? { reasoningTokens } : {}),
    };
}

type NormalizedAttachment =
    | { source: 'url'; url: string; kind: 'image' | 'file'; mediaType: string; name?: string }
    | { source: 'base64'; base64: string; dataUrl: string; kind: 'image' | 'file'; mediaType: string; name?: string };

function normalizeAttachment(attachment: Attachment): NormalizedAttachment {
    const { kind, mediaType, data, name } = attachment;
    if (data instanceof Uint8Array) {
        const base64 = Buffer.from(data).toString('base64');
        return { source: 'base64', base64, dataUrl: `data:${mediaType};base64,${base64}`, kind, mediaType, name };
    }
    if (/^https?:\/\//i.test(data)) {
        return { source: 'url', url: data, kind, mediaType, name };
    }
    const dataUrlMatch = /^data:([^;,]+);base64,([\s\S]+)$/i.exec(data);
    if (dataUrlMatch) {
        const mime = dataUrlMatch[1] || mediaType;
        return { source: 'base64', base64: dataUrlMatch[2], dataUrl: data, kind, mediaType: mime, name };
    }
    return { source: 'base64', base64: data, dataUrl: `data:${mediaType};base64,${data}`, kind, mediaType, name };
}

function openaiResponsesUserContent(prompt: string, attachments?: readonly Attachment[]): string | ResponseInputContent[] {
    if (!attachments?.length) return prompt;
    const parts: ResponseInputContent[] = [{ type: 'input_text', text: prompt }];
    for (const raw of attachments) {
        const item = normalizeAttachment(raw);
        if (item.kind === 'image') {
            parts.push({ type: 'input_image', detail: 'auto', image_url: item.source === 'url' ? item.url : item.dataUrl });
        } else if (item.source === 'url') {
            parts.push({ type: 'input_file', file_url: item.url });
        } else {
            parts.push({ type: 'input_file', file_data: item.dataUrl, ...(item.name ? { filename: item.name } : {}) });
        }
    }
    return parts;
}

function openaiChatUserContent(prompt: string, attachments?: readonly Attachment[]): string | ChatCompletionContentPart[] {
    if (!attachments?.length) return prompt;
    const parts: ChatCompletionContentPart[] = [{ type: 'text', text: prompt }];
    for (const raw of attachments) {
        const item = normalizeAttachment(raw);
        if (item.kind === 'image') {
            parts.push({ type: 'image_url', image_url: { url: item.source === 'url' ? item.url : item.dataUrl } });
        } else {
            parts.push({
                type: 'file',
                file: {
                    file_data: item.source === 'url' ? item.url : item.dataUrl,
                    ...(item.name ? { filename: item.name } : {}),
                },
            });
        }
    }
    return parts;
}

function anthropicUserContent(prompt: string, attachments?: readonly Attachment[]): string | ContentBlockParam[] {
    if (!attachments?.length) return prompt;
    const parts: ContentBlockParam[] = [{ type: 'text', text: prompt }];
    for (const raw of attachments) {
        const item = normalizeAttachment(raw);
        if (item.kind === 'image') {
            if (item.source === 'url') {
                parts.push({ type: 'image', source: { type: 'url', url: item.url } });
            } else {
                parts.push({
                    type: 'image',
                    source: {
                        type: 'base64',
                        media_type: item.mediaType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
                        data: item.base64,
                    },
                });
            }
        } else if (item.source === 'url') {
            parts.push({ type: 'document', source: { type: 'url', url: item.url }, ...(item.name ? { title: item.name } : {}) });
        } else if (item.mediaType.startsWith('text/')) {
            parts.push({
                type: 'document',
                source: { type: 'text', media_type: 'text/plain', data: Buffer.from(item.base64, 'base64').toString('utf8') },
                ...(item.name ? { title: item.name } : {}),
            });
        } else {
            parts.push({
                type: 'document',
                source: { type: 'base64', media_type: 'application/pdf', data: item.base64 },
                ...(item.name ? { title: item.name } : {}),
            });
        }
    }
    return parts;
}

function googleUserParts(prompt: string, attachments?: readonly Attachment[]): Part[] {
    const parts: Part[] = [{ text: prompt }];
    for (const raw of attachments ?? []) {
        const item = normalizeAttachment(raw);
        if (item.source === 'url') {
            parts.push({ fileData: { mimeType: item.mediaType, fileUri: item.url } });
        } else {
            parts.push({ inlineData: { mimeType: item.mediaType, data: item.base64 } });
        }
    }
    return parts;
}

function settings(
    provider: ProviderId,
    model: string,
    options: ModelCallOptions,
    modelCapabilities?: readonly ModelCapabilityRule[],
) {
    const caps = resolveModelCapabilities(provider, model, modelCapabilities);
    const warnings: ModelWarning[] = [];
    let { temperature, topP } = options;
    let openaiEffort: 'none' | 'minimal' | Effort | 'xhigh' | undefined = options.providerOptions.openai?.reasoningEffort;
    let thinking: ThinkingConfigParam | undefined;
    let anthropicEffort = options.providerOptions.anthropic?.effort;
    const googleThinking: { includeThoughts?: boolean; thinkingBudget?: number; thinkingLevel?: Effort | 'minimal' } =
        { ...options.providerOptions.google?.thinkingConfig };
    const unsupported = (feature: string, details: string, conflict?: 'reasoning') =>
        warnings.push({ type: 'unsupported', feature, details, ...(conflict ? { conflict } : {}) });
    const compatibility = (details: string) => warnings.push({ type: 'compatibility', feature: 'reasoning', details });

    if (provider === 'openai' || provider === 'openai-compatible') {
        if (options.reasoning === 'none') {
            if (caps.minReasoningEffort === 'minimal' || caps.minReasoningEffort === 'low' || caps.minReasoningEffort === 'high') {
                openaiEffort = caps.minReasoningEffort;
                compatibility(`reasoning 'none' is not supported by ${model}; using '${openaiEffort}'`);
            } else {
                openaiEffort = 'none';
            }
        }
        const reasoningActive = caps.reasoning !== 'none' && openaiEffort !== 'none';
        const supportsSampling = caps.reasoning === 'none'
            ? caps.supportsSampling
            : caps.supportsSampling && (caps.supportsSamplingWithReasoning || !reasoningActive);
        if (!supportsSampling) {
            if (temperature !== undefined) unsupported('temperature', 'temperature is not supported with this reasoning setting', 'reasoning');
            if (topP !== undefined) unsupported('topP', 'topP is not supported with this reasoning setting', 'reasoning');
            temperature = topP = undefined;
        }
    } else if (provider === 'anthropic') {
        if (!caps.supportsSeed && options.seed !== undefined) unsupported('seed', 'Anthropic does not support randomness.seed; using the provider default');
        const configured = options.providerOptions.anthropic?.thinking;
        thinking = configured?.type === 'enabled' ? { type: 'enabled', budget_tokens: configured.budgetTokens } : configured;
        if (options.reasoning === 'none') {
            if (caps.minReasoningEffort === 'between_tools') {
                thinking = { type: 'between_tools' };
                compatibility(`reasoning 'none' is not supported by ${model}; using 'between_tools' thinking`);
            } else if (caps.minReasoningEffort === 'low') {
                thinking = undefined;
                anthropicEffort = 'low';
                compatibility(`reasoning 'none' is not supported by ${model}; using low effort`);
            } else {
                thinking = { type: 'disabled' };
            }
        }
        const supportsSampling = caps.supportsSampling && (caps.supportsSamplingWithReasoning || !thinking || thinking.type === 'disabled');
        if (!supportsSampling) {
            if (temperature !== undefined) unsupported('temperature', 'temperature is not supported by this model or while thinking', 'reasoning');
            if (topP !== undefined) unsupported('topP', 'topP is not supported by this model or while thinking', 'reasoning');
            temperature = topP = undefined;
        } else if (!caps.supportsTemperatureAndTopP && temperature !== undefined && topP !== undefined) {
            unsupported('topP', 'topP is ignored when temperature is set');
            topP = undefined;
        }
    } else if (options.reasoning === 'none') {
        if (caps.reasoning === 'budget') {
            googleThinking.thinkingBudget = caps.minThinkingBudget ?? 0;
            if (googleThinking.thinkingBudget !== 0) compatibility(`reasoning 'none' is not supported by ${model}; using the minimum thinking budget`);
        } else {
            googleThinking.thinkingLevel = caps.minReasoningEffort === 'low' ? 'low' : 'minimal';
            compatibility(`reasoning 'none' is not supported by ${model}; using the minimum thinking level`);
        }
    }
    return { caps, warnings, temperature, topP, openaiEffort, thinking, anthropicEffort, googleThinking };
}

function openaiChatModel(
    client: OpenAI,
    model: string,
    provider: 'openai' | 'openai-compatible' = 'openai',
    modelCapabilities?: readonly ModelCapabilityRule[],
): NativeModel {
    const history: ChatCompletionMessageParam[] = [];
    return {
        addToolResults(outputs) {
            history.push(...outputs.map(output => ({
                role: 'tool' as const, tool_call_id: output.toolCallId, content: output.value,
            })));
        },
        async *stream(options) {
            if (!history.length) history.push({ role: 'user', content: openaiChatUserContent(options.prompt, options.attachments) });
            const config = settings(provider, model, options, modelCapabilities);
            if (provider === 'openai' && options.providerOptions.openai?.reasoningSummary != null) config.warnings.push({
                type: 'unsupported', feature: 'reasoningSummary',
                details: 'seeded OpenAI calls use Chat Completions, which does not expose reasoning summaries',
            });
            yield { type: 'stream-start', warnings: config.warnings };
            const responseFormat = config.caps.supportsNativeStructuredOutput && isObjectSchema(options.responseSchema)
                ? { type: 'json_schema' as const, json_schema: { name: 'spl_output', strict: false, schema: options.responseSchema } }
                : undefined;
            const stream = await client.chat.completions.create({
                model, messages: [{ role: 'system', content: options.system }, ...history], stream: true,
                stream_options: { include_usage: true },
                ...(provider === 'openai' ? { store: false } : {}),
                parallel_tool_calls: options.tools.length ? false : undefined,
                tools: options.tools.length ? options.tools.map(tool => ({
                    type: 'function', function: {
                        name: tool.name, description: tool.description, parameters: tool.parameters, strict: false,
                    },
                })) : undefined,
                ...(responseFormat ? { response_format: responseFormat } : {}),
                reasoning_effort: config.openaiEffort,
                seed: options.seed, temperature: config.temperature, top_p: config.topP,
                max_completion_tokens: options.tokens,
            }, { signal: options.abortSignal });
            const calls = new Map<number, ChatCompletionMessageFunctionToolCall>();
            let text = '';
            let reason = 'unknown';
            let modelId = model;
            let usage: TokenUsage | undefined;
            for await (const event of stream) {
                options.abortSignal.throwIfAborted();
                modelId = event.model ?? modelId;
                if (event.usage) {
                    usage = makeUsage(
                        event.usage.prompt_tokens,
                        event.usage.completion_tokens,
                        event.usage.total_tokens,
                        event.usage.prompt_tokens_details?.cached_tokens,
                        event.usage.completion_tokens_details?.reasoning_tokens,
                    );
                }
                const choice = event.choices.find(choice => choice.index === 0);
                if (!choice) continue;
                if (choice.finish_reason) reason = choice.finish_reason;
                if (choice.delta.refusal) throw new LlmError(`model refused the request: ${choice.delta.refusal}`);
                if (choice.delta.function_call) throw new LlmError('the model returned an unsupported legacy function call');
                if (choice.delta.content) {
                    text += choice.delta.content;
                    yield { type: 'text-delta', id: 'answer', delta: choice.delta.content };
                }
                for (const delta of choice.delta.tool_calls ?? []) {
                    const call = calls.get(delta.index) ?? { id: '', type: 'function', function: { name: '', arguments: '' } };
                    if (delta.id) call.id += delta.id;
                    if (delta.function?.name) call.function.name += delta.function.name;
                    if (delta.function?.arguments) call.function.arguments += delta.function.arguments;
                    calls.set(delta.index, call);
                }
            }
            if (text) yield { type: 'text-end', id: 'answer', text };
            if (reason === 'stop' || reason === 'tool_calls') {
                const toolCalls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
                if (toolCalls.length && reason !== 'tool_calls') throw new LlmError('the model returned tool calls without a tool-call finish reason');
                history.push({ role: 'assistant', content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });
                for (const call of toolCalls) {
                    if (!call.id || !call.function.name) throw new LlmError('the model returned a tool call without an id or name');
                    yield { type: 'tool-input-start', toolName: call.function.name };
                    yield toolCall(call.function.name, call.id, call.function.arguments);
                }
            }
            yield { type: 'finish', reason: reason === 'tool_calls' ? 'tool-calls' : reason, modelId, ...(usage ? { usage } : {}) };
        },
    };
}

async function openaiModel(
    apiKey: string,
    model: string,
    logger: Logger,
    provider: 'openai' | 'openai-compatible' = 'openai',
    nativeOptions?: NativeModelOptions,
): Promise<NativeModel> {
    const { default: OpenAI } = await import('openai');
    const client = new OpenAI({
        apiKey,
        baseURL: nativeOptions?.baseUrl ?? 'https://api.openai.com/v1',
        organization: null,
        project: null,
        maxRetries: 0,
        logger,
        logLevel: 'warn',
    });
    if (provider === 'openai-compatible') {
        return openaiChatModel(client, model, 'openai-compatible', nativeOptions?.modelCapabilities);
    }
    const history: ResponseInputItem[] = [];
    let chatModel: NativeModel | undefined;
    return {
        addToolResults(outputs) {
            if (chatModel) {
                chatModel.addToolResults(outputs);
                return;
            }
            history.push(...outputs.map(output => ({
                type: 'function_call_output' as const, call_id: output.toolCallId, output: output.value,
            })));
        },
        async *stream(options) {
            // Responses has no seed parameter; only seeded calls use Chat Completions.
            if (options.seed !== undefined) {
                chatModel ??= openaiChatModel(client, model, 'openai', nativeOptions?.modelCapabilities);
                yield* chatModel.stream(options);
                return;
            }
            if (!history.length) history.push({ role: 'user', content: openaiResponsesUserContent(options.prompt, options.attachments) });
            const config = settings('openai', model, options, nativeOptions?.modelCapabilities);
            yield { type: 'stream-start', warnings: config.warnings };
            const textFormat = config.caps.supportsNativeStructuredOutput && isObjectSchema(options.responseSchema)
                ? { format: { type: 'json_schema' as const, name: 'spl_output', strict: false, schema: options.responseSchema } }
                : undefined;
            const stream = await client.responses.create({
                model, input: history, instructions: options.system, stream: true,
                store: false, parallel_tool_calls: options.tools.length ? false : undefined,
                tools: options.tools.length ? options.tools.map(tool => ({
                    type: 'function', name: tool.name, description: tool.description, parameters: tool.parameters, strict: false,
                })) : undefined,
                ...(textFormat ? { text: textFormat } : {}),
                include: ['reasoning.encrypted_content'],
                reasoning: config.openaiEffort !== undefined || options.providerOptions.openai?.reasoningSummary != null ? {
                    effort: config.openaiEffort, summary: options.providerOptions.openai?.reasoningSummary ?? undefined,
                } : undefined,
                temperature: config.temperature, top_p: config.topP,
                max_output_tokens: options.tokens,
            }, { signal: options.abortSignal });
            const items = new Map<number, ResponseInputItem>();
            let modelId = model;
            let hasCalls = false;
            for await (const event of stream) {
                options.abortSignal.throwIfAborted();
                if (event.type === 'response.created') modelId = event.response.model ?? model;
                else if (event.type === 'response.output_text.delta') {
                    yield { type: 'text-delta', id: `${event.item_id}:${event.content_index ?? 0}`, delta: event.delta };
                } else if (event.type === 'response.output_text.done') {
                    yield { type: 'text-end', id: `${event.item_id}:${event.content_index ?? 0}`, text: event.text };
                } else if (event.type === 'response.reasoning_summary_text.delta') {
                    yield { type: 'reasoning-delta', id: `${event.item_id}:${event.summary_index}`, delta: event.delta };
                } else if (event.type === 'response.reasoning_summary_text.done') {
                    yield { type: 'reasoning-end', id: `${event.item_id}:${event.summary_index}`, text: event.text };
                } else if (event.type === 'response.output_item.added') {
                    if (event.item.type === 'function_call') yield { type: 'tool-input-start', toolName: event.item.name };
                    else if (event.item.type !== 'message' && event.item.type !== 'reasoning') {
                        yield { type: 'tool-input-start', toolName: event.item.type, providerExecuted: true };
                    }
                } else if (event.type === 'response.output_item.done') {
                    const item = event.item;
                    if (item.type === 'message' || item.type === 'reasoning' || item.type === 'function_call') items.set(event.output_index, item);
                    if (item.type === 'function_call') {
                        hasCalls = true;
                        yield toolCall(item.name, item.call_id, item.arguments);
                    }
                } else if (event.type === 'error') throw new LlmError(event.message);
                else if (event.type === 'response.failed') throw new LlmError(event.response.error?.message ?? 'the model turn failed');
                else if (event.type === 'response.incomplete') {
                    yield { type: 'finish', reason: event.response.incomplete_details?.reason ?? 'incomplete', modelId };
                } else if (event.type === 'response.completed') {
                    history.push(...[...items.entries()].sort(([a], [b]) => a - b).map(([, item]) => item));
                    const u = event.response.usage;
                    const usage = u ? makeUsage(
                        u.input_tokens,
                        u.output_tokens,
                        u.total_tokens,
                        u.input_tokens_details?.cached_tokens,
                        u.output_tokens_details?.reasoning_tokens,
                    ) : undefined;
                    yield { type: 'finish', reason: hasCalls ? 'tool-calls' : 'stop', modelId: event.response.model ?? modelId, ...(usage ? { usage } : {}) };
                }
            }
        },
    };
}

async function anthropicModel(apiKey: string, model: string, logger: Logger, nativeOptions?: NativeModelOptions): Promise<NativeModel> {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({
        apiKey,
        baseURL: nativeOptions?.baseUrl ?? 'https://api.anthropic.com',
        maxRetries: 0,
        logger,
        logLevel: 'warn',
    });
    const history: MessageParam[] = [];
    return {
        addToolResults(outputs) {
            history.push({ role: 'user', content: outputs.map(output => ({
                type: 'tool_result', tool_use_id: output.toolCallId, content: output.value,
            })) });
        },
        async *stream(options) {
            if (!history.length) history.push({ role: 'user', content: anthropicUserContent(options.prompt, options.attachments) });
            const config = settings('anthropic', model, options, nativeOptions?.modelCapabilities);
            if (options.tokens !== undefined && config.thinking?.type === 'enabled'
                && options.tokens <= config.thinking.budget_tokens) {
                throw new LlmError(`tokens (${options.tokens}) must exceed the Anthropic thinking budget (${config.thinking.budget_tokens}); increase tokens or lower reasoning`);
            }
            yield { type: 'stream-start', warnings: config.warnings };
            const maxTokens = config.caps.defaultMaxTokens ?? 4096;
            const outputFormat = config.caps.supportsNativeStructuredOutput && isObjectSchema(options.responseSchema)
                ? { type: 'json_schema' as const, schema: options.responseSchema }
                : undefined;
            const outputConfig = config.anthropicEffort || outputFormat
                ? { ...(config.anthropicEffort ? { effort: config.anthropicEffort } : {}), ...(outputFormat ? { format: outputFormat } : {}) }
                : undefined;
            // Current client types omit sampling fields still accepted by legacy Claude models.
            const params: MessageCreateParamsStreaming & { temperature?: number; top_p?: number } = {
                model, system: options.system, messages: history, stream: true,
                max_tokens: options.tokens ?? (config.thinking?.type === 'enabled' && config.thinking.budget_tokens >= maxTokens
                    ? maxTokens + config.thinking.budget_tokens : maxTokens),
                tools: options.tools.map(tool => ({
                    name: tool.name, description: tool.description, input_schema: { ...tool.parameters, type: 'object' },
                })),
                tool_choice: options.tools.length ? { type: 'auto', disable_parallel_tool_use: true } : undefined,
                thinking: config.thinking,
                output_config: outputConfig,
                temperature: config.temperature, top_p: config.topP,
            };
            // The high-level helper unconditionally writes deprecation warnings to console, bypassing SPL's logger.
            const stream = await client.post<Stream<RawMessageStreamEvent>>('/v1/messages', {
                body: params, stream: true, signal: options.abortSignal, headers: { 'anthropic-version': '2023-06-01' },
            });
            const blocks = new Map<number, ContentBlockParam>();
            const inputs = new Map<number, string>();
            let modelId = model;
            let reason = 'unknown';
            let inputTokens: number | undefined;
            let outputTokens: number | undefined;
            let cachedTokens: number | undefined;
            for await (const event of stream) {
                options.abortSignal.throwIfAborted();
                if (event.type === 'message_start') {
                    modelId = event.message.model ?? model;
                    const u = event.message.usage as { input_tokens?: number; cache_read_input_tokens?: number } | undefined;
                    if (u?.input_tokens !== undefined) inputTokens = u.input_tokens;
                    if (u?.cache_read_input_tokens !== undefined) cachedTokens = u.cache_read_input_tokens;
                } else if (event.type === 'content_block_start') {
                    const block = event.content_block;
                    blocks.set(event.index, { ...block });
                    if (block.type === 'tool_use') {
                        yield { type: 'tool-input-start', toolName: block.name };
                    } else if (block.type === 'server_tool_use') {
                        yield { type: 'tool-input-start', toolName: block.name, providerExecuted: true };
                    } else if (block.type === 'text' && block.text) {
                        yield { type: 'text-delta', id: String(event.index), delta: block.text };
                    } else if (block.type === 'thinking' && block.thinking) {
                        yield { type: 'reasoning-delta', id: String(event.index), delta: block.thinking };
                    }
                } else if (event.type === 'content_block_delta') {
                    const block = blocks.get(event.index);
                    const delta = event.delta;
                    if (delta.type === 'text_delta' && block?.type === 'text') {
                        block.text += delta.text;
                        yield { type: 'text-delta', id: String(event.index), delta: delta.text };
                    } else if (delta.type === 'thinking_delta' && block?.type === 'thinking') {
                        block.thinking += delta.thinking;
                        yield { type: 'reasoning-delta', id: String(event.index), delta: delta.thinking };
                    } else if (delta.type === 'signature_delta' && block?.type === 'thinking') block.signature += delta.signature;
                    else if (delta.type === 'input_json_delta') inputs.set(event.index, (inputs.get(event.index) ?? '') + delta.partial_json);
                } else if (event.type === 'content_block_stop') {
                    const block = blocks.get(event.index);
                    if (block?.type === 'tool_use') {
                        const call = toolCall(block.name, block.id, inputs.get(event.index) ?? JSON.stringify(block.input));
                        if (call.type === 'tool-call') block.input = call.input;
                        yield call;
                    } else if (block?.type === 'text') yield { type: 'text-end', id: String(event.index), text: block.text };
                    else if (block?.type === 'thinking') yield { type: 'reasoning-end', id: String(event.index), text: block.thinking };
                } else if (event.type === 'message_delta') {
                    reason = event.delta.stop_reason ?? reason;
                    const u = event.usage as { output_tokens?: number; input_tokens?: number; cache_read_input_tokens?: number } | undefined;
                    if (u?.output_tokens !== undefined) outputTokens = u.output_tokens;
                    if (u?.input_tokens !== undefined) inputTokens = u.input_tokens;
                    if (u?.cache_read_input_tokens !== undefined) cachedTokens = u.cache_read_input_tokens;
                } else if (event.type === 'message_stop') {
                    history.push({ role: 'assistant', content: [...blocks.entries()].sort(([a], [b]) => a - b).map(([, block]) => block) });
                    const usage = makeUsage(inputTokens, outputTokens, undefined, cachedTokens);
                    yield {
                        type: 'finish',
                        reason: reason === 'tool_use' ? 'tool-calls'
                            : reason === 'end_turn' || reason === 'stop_sequence' ? 'stop' : reason,
                        modelId,
                        ...(usage ? { usage } : {}),
                    };
                }
            }
        },
    };
}

async function googleModel(apiKey: string, model: string, nativeOptions?: NativeModelOptions): Promise<NativeModel> {
    const { GoogleGenAI, FunctionCallingConfigMode, ThinkingLevel } = await import('@google/genai');
    const thinkingLevels = { low: ThinkingLevel.LOW, medium: ThinkingLevel.MEDIUM, high: ThinkingLevel.HIGH, minimal: ThinkingLevel.MINIMAL };
    const client = new GoogleGenAI({
        apiKey,
        enterprise: false,
        httpOptions: { baseUrl: nativeOptions?.baseUrl ?? 'https://generativelanguage.googleapis.com', retryOptions: { attempts: 1 } },
    });
    const history: Content[] = [];
    return {
        addToolResults(outputs) {
            history.push({ role: 'user', parts: outputs.map(output => ({
                functionResponse: { id: output.toolCallId, name: output.toolName, response: { output: output.value } },
            })) });
        },
        async *stream(options) {
            if (!history.length) history.push({ role: 'user', parts: googleUserParts(options.prompt, options.attachments) });
            const config = settings('google', model, options, nativeOptions?.modelCapabilities);
            yield { type: 'stream-start', warnings: config.warnings };
            const structured = config.caps.supportsNativeStructuredOutput && options.responseSchema !== undefined
                ? { responseMimeType: 'application/json', responseJsonSchema: options.responseSchema }
                : {};
            const stream = await client.models.generateContentStream({
                model, contents: history,
                config: {
                    systemInstruction: options.system, abortSignal: options.abortSignal,
                    seed: options.seed, temperature: config.temperature, topP: config.topP,
                    maxOutputTokens: options.tokens,
                    ...structured,
                    thinkingConfig: options.providerOptions.google?.thinkingConfig ? {
                        ...config.googleThinking,
                        thinkingLevel: config.googleThinking.thinkingLevel ? thinkingLevels[config.googleThinking.thinkingLevel] : undefined,
                    } : undefined,
                    tools: options.tools.length ? [{ functionDeclarations: options.tools.map(tool => ({
                        name: tool.name, description: tool.description, parametersJsonSchema: tool.parameters,
                    })) }] : undefined,
                    toolConfig: { functionCallingConfig: { mode: options.tools.length ? FunctionCallingConfigMode.AUTO : FunctionCallingConfigMode.NONE } },
                },
            });
            const parts: Part[] = [];
            const channels = new Set<'text' | 'reasoning'>();
            let reason = 'unknown';
            let modelId = model;
            let hasCalls = false;
            let usage: TokenUsage | undefined;
            for await (const event of stream) {
                options.abortSignal.throwIfAborted();
                modelId = event.modelVersion ?? modelId;
                const u = event.usageMetadata;
                if (u) {
                    usage = makeUsage(
                        u.promptTokenCount,
                        u.candidatesTokenCount,
                        u.totalTokenCount,
                        u.cachedContentTokenCount,
                        u.thoughtsTokenCount,
                    );
                }
                const candidate = event.candidates?.[0];
                if (event.promptFeedback?.blockReason) throw new LlmError(`model prompt was blocked (${event.promptFeedback.blockReason})`);
                if (candidate?.finishReason) reason = candidate.finishReason;
                for (const part of candidate?.content?.parts ?? []) {
                    parts.push(part);
                    if (part.text !== undefined) {
                        const channel = part.thought ? 'reasoning' : 'text';
                        channels.add(channel);
                        yield { type: channel === 'text' ? 'text-delta' : 'reasoning-delta', id: channel, delta: part.text };
                    }
                    if (part.functionCall) {
                        hasCalls = true;
                        const name = part.functionCall.name;
                        if (!name) throw new LlmError('the model returned a function call without a name');
                        const id = part.functionCall.id ?? `call_${parts.length - 1}`;
                        part.functionCall.id = id;
                        yield { type: 'tool-input-start', toolName: name };
                        yield { type: 'tool-call', toolName: name, toolCallId: id, input: part.functionCall.args ?? {} };
                    }
                    if (part.executableCode || part.codeExecutionResult) {
                        yield { type: 'tool-input-start', toolName: 'code_execution', providerExecuted: true };
                    }
                }
            }
            for (const channel of channels) yield { type: channel === 'text' ? 'text-end' : 'reasoning-end', id: channel };
            history.push({ role: 'model', parts });
            yield { type: 'finish', reason: reason === 'STOP' ? hasCalls ? 'tool-calls' : 'stop' : reason, modelId, ...(usage ? { usage } : {}) };
        },
    };
}

export function createNativeModel(
    provider: ProviderId,
    apiKey: string,
    model: string,
    logger: Logger,
    options?: NativeModelOptions,
): Promise<NativeModel> {
    if (provider === 'anthropic') return anthropicModel(apiKey, model, logger, options);
    if (provider === 'google') return googleModel(apiKey, model, options);
    return openaiModel(apiKey, model, logger, provider, options);
}

const NO_EVIDENCE = 'No evidence was given.';

const probability = (value: unknown): number => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
        throw new LlmError(`the decision endpoint returned an invalid probability: ${JSON.stringify(value)}`);
    }
    return value;
};

function chosen(labels: readonly string[], label: unknown, entries: Iterable<[unknown, unknown]>): Pick<DecisionResponse, 'label' | 'probabilities'> {
    if (typeof label !== 'string' || !labels.includes(label)) {
        throw new LlmError(`the decision endpoint chose an unknown label: ${JSON.stringify(label)}`);
    }
    const probabilities: Record<string, number> = Object.fromEntries(labels.map(name => [name, 0]));
    for (const [name, value] of entries) {
        if (typeof name === 'string' && labels.includes(name)) probabilities[name] = probability(value);
    }
    return { label, probabilities };
}

async function openaiDecision(apiKey: string, req: DecisionRequest, signal: AbortSignal, logger: Logger, baseUrl?: string): Promise<DecisionResponse> {
    const { default: OpenAI } = await import('openai');
    const client = new OpenAI({
        apiKey, baseURL: baseUrl ?? 'https://api.openai.com/v1', organization: null, project: null,
        maxRetries: 0, logger, logLevel: 'warn',
    });
    const result = await client.decisions.create({
        model: DECISION_MODELS.openai,
        input: req.evidence.length ? [{ role: 'user', content: req.evidence.map(text => ({ type: 'input_text', text })) }] : NO_EVIDENCE,
        questions: [req.labels
            ? { type: 'choice', name: 'decision', instructions: req.question, choices: req.labels.map(value => ({ value })) }
            : { type: 'predicate', name: 'decision', instructions: req.question }],
    }, { signal });
    const answer = result.answers[0];
    const effective = { backend: 'native-sdk', provider: 'openai', model: result.model ?? DECISION_MODELS.openai, endpoint: 'decisions' };
    if (!answer) throw new LlmError('the decision endpoint returned no answer');
    if (answer.type === 'refusal') throw new LlmError('the model refused to decide');
    if (answer.type === 'predicate' && !req.labels) return { probability: probability(answer.probability), effective };
    if (answer.type === 'choice' && req.labels) {
        return { ...chosen(req.labels, answer.choice, answer.probabilities.map(item => [item.value, item.probability])), effective };
    }
    throw new LlmError(`the decision endpoint returned an unexpected '${answer.type}' answer`);
}

async function googleDecision(apiKey: string, req: DecisionRequest, signal: AbortSignal, baseUrl?: string): Promise<DecisionResponse> {
    const { GoogleGenAI } = await import('@google/genai');
    const client = new GoogleGenAI({
        apiKey, apiVersion: 'v1beta', enterprise: false, httpOptions: { baseUrl: baseUrl ?? 'https://generativelanguage.googleapis.com' },
    });
    const result = await client.decisions.create({
        model: DECISION_MODELS.google,
        input: req.evidence.length ? req.evidence.map(text => ({ type: 'text' as const, text })) : NO_EVIDENCE,
        questions: { decision: req.labels
            ? { type: 'choice', instructions: req.question, criteria: Object.fromEntries(req.labels.map(label => [label, label])) }
            : { type: 'noul', instructions: req.question } },
    }, { signal, retries: { strategy: 'none' } });
    if (result.prompt_feedback?.block_reason) throw new LlmError(`decision input was blocked (${result.prompt_feedback.block_reason})`);
    const answer = result.answers?.decision;
    const effective = { backend: 'native-sdk', provider: 'google', model: DECISION_MODELS.google, endpoint: 'decisions' };
    if (!answer) throw new LlmError('the decision endpoint returned no answer');
    if (answer.type === 'noul' && !req.labels) return { probability: probability(answer.noul), effective };
    if (answer.type === 'choice' && req.labels) return { ...chosen(req.labels, answer.choice, Object.entries(answer.probabilities)), effective };
    throw new LlmError(`the decision endpoint returned an unexpected '${answer.type}' answer`);
}

/** Calls a provider decision endpoint with its fixed model; `null` for providers without one. */
export function nativeDecision(
    provider: Provider, apiKey: string, req: DecisionRequest, signal: AbortSignal, logger: Logger, baseUrl?: string,
): Promise<DecisionResponse | null> {
    return provider === 'openai' ? openaiDecision(apiKey, req, signal, logger, baseUrl)
        : provider === 'google' ? googleDecision(apiKey, req, signal, baseUrl) : Promise.resolve(null);
}
