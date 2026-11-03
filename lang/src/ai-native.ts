import type { ResponseInputItem } from 'openai/resources/responses/responses';
import type OpenAI from 'openai';
import type { ChatCompletionMessageParam, ChatCompletionMessageFunctionToolCall } from 'openai/resources/chat/completions/completions';
import type { ContentBlockParam, MessageParam, MessageCreateParamsStreaming, RawMessageStreamEvent, ThinkingConfigParam } from '@anthropic-ai/sdk/resources/messages';
import type { Stream } from '@anthropic-ai/sdk/core/streaming';
import type { Content, Part } from '@google/genai';
import type { Provider } from './auth.js';
import { LlmError, type ReasoningLevel, type RuntimeTool } from './llm.js';
import type { Logger } from './logger.js';

export interface ProviderOptions {
    openai?: { parallelToolCalls?: boolean; store?: boolean; reasoningSummary?: 'auto' | null; reasoningEffort?: ReasoningLevel };
    anthropic?: {
        disableParallelToolUse?: boolean;
        thinking?: { type: 'adaptive' } | { type: 'enabled'; budgetTokens: number };
        effort?: ReasoningLevel;
    };
    google?: { thinkingConfig?: { includeThoughts?: boolean; thinkingBudget?: number; thinkingLevel?: ReasoningLevel } };
}

export interface ModelWarning {
    type: 'unsupported' | 'compatibility';
    feature: string;
    details?: string;
}

export type ModelStreamPart =
    | { type: 'stream-start'; warnings: ModelWarning[] }
    | { type: 'text-start' | 'reasoning-start'; id: string }
    | { type: 'text-delta' | 'reasoning-delta'; id: string; delta: string }
    | { type: 'text-end' | 'reasoning-end'; id: string; text?: string }
    | { type: 'tool-input-start'; toolName: string; providerExecuted?: boolean }
    | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown; providerExecuted?: boolean }
    | { type: 'tool-error'; toolName: string; error: unknown }
    | { type: 'finish'; reason: string; modelId?: string };

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
    seed?: number;
    tokens?: number;
    temperature?: number;
    topP?: number;
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

function settings(provider: Provider, model: string, options: ModelCallOptions) {
    const warnings: ModelWarning[] = [];
    let { temperature, topP } = options;
    let openaiEffort: 'none' | 'minimal' | ReasoningLevel | undefined = options.providerOptions.openai?.reasoningEffort;
    let thinking: ThinkingConfigParam | undefined;
    let anthropicEffort = options.providerOptions.anthropic?.effort;
    const googleThinking: { includeThoughts?: boolean; thinkingBudget?: number; thinkingLevel?: ReasoningLevel | 'minimal' } =
        { ...options.providerOptions.google?.thinkingConfig };
    const unsupported = (feature: string, details: string) => warnings.push({ type: 'unsupported', feature, details });
    const compatibility = (details: string) => warnings.push({ type: 'compatibility', feature: 'reasoning', details });
    if (provider === 'openai') {
        if (options.reasoning === 'none') {
            if (/^gpt-5(?:-|$)/.test(model)) openaiEffort = /^gpt-5-pro(?:-|$)/.test(model) ? 'high' : 'minimal';
            else if (/^(?:o[134](?:-|$)|gpt-6(?:\.1)?-astra(?:-|$))/.test(model)) openaiEffort = 'low';
            else openaiEffort = 'none';
            if (openaiEffort !== 'none') compatibility(`reasoning 'none' is not supported by ${model}; using '${openaiEffort}'`);
        }
        const reasoningModel = /^(?:o[134](?:-|$)|gpt-[5-9](?:[.-]|$))/.test(model);
        const supportsSampling = !reasoningModel || openaiEffort === 'none' && !/^(?:o[134]|gpt-5(?:-|$)|gpt-6(?:\.1)?-astra)/.test(model)
            && !/-pro(?:-|$)/.test(model);
        if (!supportsSampling) {
            if (temperature !== undefined) unsupported('temperature', 'temperature is not supported with this reasoning setting');
            if (topP !== undefined) unsupported('topP', 'topP is not supported with this reasoning setting');
            temperature = topP = undefined;
        }
    } else if (provider === 'anthropic') {
        if (options.seed !== undefined) unsupported('seed', 'Anthropic does not support randomness.seed; using the provider default');
        const configured = options.providerOptions.anthropic?.thinking;
        thinking = configured?.type === 'enabled' ? { type: 'enabled', budget_tokens: configured.budgetTokens } : configured;
        if (options.reasoning === 'none') {
            if (/^claude-sonnet-5-5/.test(model)) {
                thinking = { type: 'between_tools' };
                compatibility(`reasoning 'none' is not supported by ${model}; using 'between_tools' thinking`);
            } else if (/^claude-(?:opus-5-5|fable-5)/.test(model)) {
                thinking = undefined;
                anthropicEffort = 'low';
                compatibility(`reasoning 'none' is not supported by ${model}; using low effort`);
            } else thinking = { type: 'disabled' };
        }
        const supportsSampling = !/^claude-(?:opus-4-[78]|(?:sonnet|opus|haiku|fable)-[5-9])/.test(model)
            && (!thinking || thinking.type === 'disabled');
        if (!supportsSampling) {
            if (temperature !== undefined) unsupported('temperature', 'temperature is not supported by this model or while thinking');
            if (topP !== undefined) unsupported('topP', 'topP is not supported by this model or while thinking');
            temperature = topP = undefined;
        } else if (temperature !== undefined && topP !== undefined) {
            unsupported('topP', 'topP is ignored when temperature is set');
            topP = undefined;
        }
    } else if (options.reasoning === 'none') {
        if (/^gemini-2\.5/.test(model)) {
            googleThinking.thinkingBudget = /^gemini-2\.5-pro/.test(model) ? 128 : 0;
            if (googleThinking.thinkingBudget !== 0) compatibility(`reasoning 'none' is not supported by ${model}; using the minimum thinking budget`);
        } else {
            googleThinking.thinkingLevel = /-pro/.test(model) ? 'low' : 'minimal';
            compatibility(`reasoning 'none' is not supported by ${model}; using the minimum thinking level`);
        }
    }
    return { warnings, temperature, topP, openaiEffort, thinking, anthropicEffort, googleThinking };
}

function openaiChatModel(client: OpenAI, model: string): NativeModel {
    const history: ChatCompletionMessageParam[] = [];
    return {
        addToolResults(outputs) {
            history.push(...outputs.map(output => ({
                role: 'tool' as const, tool_call_id: output.toolCallId, content: output.value,
            })));
        },
        async *stream(options) {
            if (!history.length) history.push({ role: 'user', content: options.prompt });
            const config = settings('openai', model, options);
            if (options.providerOptions.openai?.reasoningSummary != null) config.warnings.push({
                type: 'unsupported', feature: 'reasoningSummary',
                details: 'seeded OpenAI calls use Chat Completions, which does not expose reasoning summaries',
            });
            yield { type: 'stream-start', warnings: config.warnings };
            const stream = await client.chat.completions.create({
                model, messages: [{ role: 'system', content: options.system }, ...history], stream: true,
                store: false, parallel_tool_calls: options.tools.length ? false : undefined,
                tools: options.tools.length ? options.tools.map(tool => ({
                    type: 'function', function: {
                        name: tool.name, description: tool.description, parameters: tool.parameters, strict: false,
                    },
                })) : undefined,
                reasoning_effort: config.openaiEffort,
                seed: options.seed, temperature: config.temperature, top_p: config.topP,
                max_completion_tokens: options.tokens,
            }, { signal: options.abortSignal });
            const calls = new Map<number, ChatCompletionMessageFunctionToolCall>();
            let text = '';
            let reason = 'unknown';
            let modelId = model;
            for await (const event of stream) {
                options.abortSignal.throwIfAborted();
                modelId = event.model ?? modelId;
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
            yield { type: 'finish', reason: reason === 'tool_calls' ? 'tool-calls' : reason, modelId };
        },
    };
}

async function openaiModel(apiKey: string, model: string, logger: Logger): Promise<NativeModel> {
    const { default: OpenAI } = await import('openai');
    const client = new OpenAI({
        apiKey, baseURL: 'https://api.openai.com/v1', organization: null, project: null,
        maxRetries: 0, logger, logLevel: 'warn',
    });
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
                chatModel ??= openaiChatModel(client, model);
                yield* chatModel.stream(options);
                return;
            }
            if (!history.length) history.push({ role: 'user', content: options.prompt });
            const config = settings('openai', model, options);
            yield { type: 'stream-start', warnings: config.warnings };
            const stream = await client.responses.create({
                model, input: history, instructions: options.system, stream: true,
                store: false, parallel_tool_calls: options.tools.length ? false : undefined,
                tools: options.tools.length ? options.tools.map(tool => ({
                    type: 'function', name: tool.name, description: tool.description, parameters: tool.parameters, strict: false,
                })) : undefined,
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
                    yield { type: 'finish', reason: hasCalls ? 'tool-calls' : 'stop', modelId: event.response.model ?? modelId };
                }
            }
        },
    };
}

function anthropicMaxTokens(model: string): number {
    if (/^claude-(?:(?:sonnet|opus)-4-[6-9]|(?:sonnet|opus|haiku|fable)-[5-9])/.test(model)) return 128000;
    if (/^claude-(?:(?:sonnet|haiku)-4|opus-4-5)/.test(model)) return 64000;
    if (/^claude-opus-4/.test(model)) return 32000;
    return 4096;
}

async function anthropicModel(apiKey: string, model: string, logger: Logger): Promise<NativeModel> {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey, baseURL: 'https://api.anthropic.com', maxRetries: 0, logger, logLevel: 'warn' });
    const history: MessageParam[] = [];
    return {
        addToolResults(outputs) {
            history.push({ role: 'user', content: outputs.map(output => ({
                type: 'tool_result', tool_use_id: output.toolCallId, content: output.value,
            })) });
        },
        async *stream(options) {
            if (!history.length) history.push({ role: 'user', content: options.prompt });
            const config = settings('anthropic', model, options);
            if (options.tokens !== undefined && config.thinking?.type === 'enabled'
                && options.tokens <= config.thinking.budget_tokens) {
                throw new LlmError(`tokens (${options.tokens}) must exceed the Anthropic thinking budget (${config.thinking.budget_tokens}); increase tokens or lower reasoning`);
            }
            yield { type: 'stream-start', warnings: config.warnings };
            const maxTokens = anthropicMaxTokens(model);
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
                output_config: config.anthropicEffort ? { effort: config.anthropicEffort } : undefined,
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
            for await (const event of stream) {
                options.abortSignal.throwIfAborted();
                if (event.type === 'message_start') modelId = event.message.model ?? model;
                else if (event.type === 'content_block_start') {
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
                } else if (event.type === 'message_delta') reason = event.delta.stop_reason ?? reason;
                else if (event.type === 'message_stop') {
                    history.push({ role: 'assistant', content: [...blocks.entries()].sort(([a], [b]) => a - b).map(([, block]) => block) });
                    yield { type: 'finish', reason: reason === 'tool_use' ? 'tool-calls'
                        : reason === 'end_turn' || reason === 'stop_sequence' ? 'stop' : reason, modelId };
                }
            }
        },
    };
}

async function googleModel(apiKey: string, model: string): Promise<NativeModel> {
    const { GoogleGenAI, FunctionCallingConfigMode, ThinkingLevel } = await import('@google/genai');
    const thinkingLevels = { low: ThinkingLevel.LOW, medium: ThinkingLevel.MEDIUM, high: ThinkingLevel.HIGH, minimal: ThinkingLevel.MINIMAL };
    const client = new GoogleGenAI({
        apiKey, enterprise: false, httpOptions: { baseUrl: 'https://generativelanguage.googleapis.com', retryOptions: { attempts: 1 } },
    });
    const history: Content[] = [];
    return {
        addToolResults(outputs) {
            history.push({ role: 'user', parts: outputs.map(output => ({
                functionResponse: { id: output.toolCallId, name: output.toolName, response: { output: output.value } },
            })) });
        },
        async *stream(options) {
            if (!history.length) history.push({ role: 'user', parts: [{ text: options.prompt }] });
            const config = settings('google', model, options);
            yield { type: 'stream-start', warnings: config.warnings };
            const stream = await client.models.generateContentStream({
                model, contents: history,
                config: {
                    systemInstruction: options.system, abortSignal: options.abortSignal,
                    seed: options.seed, temperature: config.temperature, topP: config.topP,
                    maxOutputTokens: options.tokens,
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
            for await (const event of stream) {
                options.abortSignal.throwIfAborted();
                modelId = event.modelVersion ?? modelId;
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
            yield { type: 'finish', reason: reason === 'STOP' ? hasCalls ? 'tool-calls' : 'stop' : reason, modelId };
        },
    };
}

export function createNativeModel(provider: Provider, apiKey: string, model: string, logger: Logger): Promise<NativeModel> {
    return provider === 'anthropic' ? anthropicModel(apiKey, model, logger)
        : provider === 'google' ? googleModel(apiKey, model) : openaiModel(apiKey, model, logger);
}
