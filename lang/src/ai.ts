import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createMCPClient, type MCPClient } from '@ai-sdk/mcp';
import { StdioMCPTransport } from '@ai-sdk/mcp/mcp-stdio';
import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { jsonSchema, streamText, wrapLanguageModel, type ModelMessage, type ToolSet, type ToolModelMessage } from 'ai';
import { Ajv } from 'ajv';
import { AuthError, resolveProvider, type Provider } from './auth.js';
import { Failure } from './errors.js';
import { LlmError, validateRandomness, type LlmBackend, type LlmRequest, type LlmResponse, type ReasoningLevel } from './llm.js';
import type { Logger } from './logger.js';
import { configuredMcpTool, filterMcpServers, type McpServers } from './mcp.js';
import { TOOL_SPECS } from './tools.js';

const SYSTEM_MESSAGE = [
    'You are the execution engine of an automated script. Your reply is stored in a variable and used by the program.',
    'Reply with exactly what was asked for: no preamble, no sign-off, no commentary.',
    'Use the provided runtime tools and configured MCP tools only when the task needs them.',
].join(' ');

const ajv = new Ajv({ strict: false, allErrors: true, addUsedSchema: false });
const budgets: Record<ReasoningLevel, number> = { low: 1024, medium: 4096, high: 16384 };
type ProviderOptions = NonNullable<Parameters<typeof streamText>[0]['providerOptions']>;

export interface AiBackendOptions {
    logger: Logger;
    cwd: string;
    timeoutMs: number;
    provider?: Provider;
    mcpServers?: McpServers;
}

function modelFor(provider: Provider, apiKey: string, model: string) {
    if (provider === 'anthropic') return createAnthropic({ apiKey })(model);
    if (provider === 'google') return createGoogleGenerativeAI({ apiKey })(model);
    return createOpenAI({ apiKey }).responses(model);
}

export function reasoningOptions(
    provider: Provider, model: string, effort: ReasoningLevel | undefined, showReasoning: boolean, logger: Logger,
    disableThinking = false,
): { options: ProviderOptions; effort?: ReasoningLevel | 'none' } {
    const openaiReasoning = /^(?:o[134](?:-|$)|gpt-[5-9](?:[.-]|$))/.test(model);
    const googleReasoning = /^gemini-(?:2\.5|[3-9])/.test(model);
    const anthropicReasoning = /^claude-(?:(?:sonnet|opus|haiku|fable)-[4-9]|3-7)/.test(model);
    const options: ProviderOptions = provider === 'openai'
        ? { openai: { parallelToolCalls: false, store: false,
            ...(openaiReasoning ? { reasoningSummary: showReasoning ? 'auto' : null } : {}) } }
        : provider === 'anthropic' ? { anthropic: { disableParallelToolUse: true } }
        : googleReasoning ? { google: { thinkingConfig: { includeThoughts: showReasoning } } } : {};
    if (!effort) {
        const supportsReasoning = provider === 'openai' ? openaiReasoning
            : provider === 'google' ? googleReasoning : anthropicReasoning;
        return { options, ...(disableThinking && supportsReasoning ? { effort: 'none' } : {}) };
    }
    if (provider === 'openai' && openaiReasoning && !/^o1-(?:mini|preview)/.test(model)
        && (!/^gpt-5-pro(?:-|$)/.test(model) || effort === 'high')) {
        options.openai.reasoningEffort = effort;
    } else if (provider === 'anthropic' && anthropicReasoning) {
        const adaptive = /^claude-(?:(?:opus|sonnet)-4-[6-9]|(?:sonnet|opus|haiku|fable)-[5-9])/.test(model);
        options.anthropic.thinking = adaptive ? { type: 'adaptive' } : { type: 'enabled', budgetTokens: budgets[effort] };
        if (adaptive) options.anthropic.effort = effort;
    } else if (provider === 'google' && googleReasoning) {
        // Gemini 3 Pro supports low/high, but not medium.
        if (/^gemini-3(?:\.0)?-pro/.test(model) && effort === 'medium') {
            logger.warn(`model '${model}' does not support reasoning effort '${effort}'; using the model default`);
            return { options };
        }
        options.google = { thinkingConfig: {
            ...(/^gemini-2\.5/.test(model) ? { thinkingBudget: budgets[effort] } : { thinkingLevel: effort }),
            includeThoughts: showReasoning,
        } };
    } else {
        logger.warn(`model '${model}' does not support reasoning effort '${effort}'; using the model default`);
        return { options };
    }
    return { options, effort };
}

interface RegisteredTool {
    invoke(input: Record<string, unknown>): Promise<string>;
    validate: ReturnType<Ajv['compile']>;
}

/** Each call owns its conversation, tool connections, cancellation and timeout. */
export class AiBackend implements LlmBackend {
    private readonly active = new Set<AbortController>();
    private closed = false;

    constructor(private readonly opts: AiBackendOptions) {}

    private async closeMcp(client: MCPClient): Promise<void> {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            await Promise.race([
                client.close(),
                new Promise<never>((_, reject) => {
                    timer = setTimeout(() => reject(new Error('cleanup timed out')), 1000);
                }),
            ]);
        } catch (error) {
            this.opts.logger.warn(`cannot close MCP client: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
            clearTimeout(timer);
        }
    }

    async call(req: LlmRequest): Promise<LlmResponse> {
        if (this.closed) throw new LlmError('the model backend is closed');
        const controller = new AbortController();
        const { signal } = controller;
        this.active.add(controller);
        const clients = new Set<MCPClient>();
        const interrupted = new Promise<never>((_, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
        const timer = setTimeout(() => controller.abort(new LlmError(`model call timed out after ${this.opts.timeoutMs}ms`)), this.opts.timeoutMs);
        const check = () => signal.throwIfAborted();
        const stop = (error: unknown): never => {
            if (!signal.aborted) controller.abort(error);
            throw signal.reason;
        };
        let receiving = true;
        const perform = async (): Promise<LlmResponse> => {
            const selected = resolveProvider(req.model, this.opts.provider);
            const randomness = req.randomness === undefined ? undefined : validateRandomness(req.randomness);
            const reasoning = reasoningOptions(selected.provider, selected.model, req.reasoningEffort, req.showReasoning,
                this.opts.logger, randomness !== undefined);
            let effectiveReasoningEffort = reasoning.effort;
            const sampling = {
                seed: randomness?.seed,
                temperature: randomness?.temperature,
                topP: randomness?.top_p,
            };
            if (sampling.seed !== undefined && selected.provider !== 'google') {
                this.opts.logger.warn(`${selected.provider}/${selected.model} does not support randomness.seed; using the provider default`);
                sampling.seed = undefined;
            }
            if (sampling.temperature !== undefined && sampling.temperature > 1 && selected.provider === 'anthropic') {
                this.opts.logger.warn(`anthropic/${selected.model} supports temperature at most 1; clamping randomness.temperature to 1`);
                sampling.temperature = 1;
            }
            const effectiveSampling = { ...sampling };
            const model = wrapLanguageModel({
                model: modelFor(selected.provider, selected.apiKey, selected.model),
                middleware: {
                    specificationVersion: 'v4',
                    wrapStream: async ({ doStream }) => {
                        const result = await doStream();
                        return { ...result, stream: result.stream.pipeThrough(new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>({
                            transform: (part, output) => {
                                if (part.type !== 'stream-start') return output.enqueue(part);
                                if (receiving && !signal.aborted) {
                                    for (const warning of part.warnings) {
                                        if ((warning.type === 'unsupported' || warning.type === 'compatibility')
                                            && warning.feature === 'reasoning') effectiveReasoningEffort = undefined;
                                        // Let the provider adapter own model-specific compatibility, including thinking.
                                        if (warning.type === 'unsupported') {
                                            if (warning.feature === 'seed') effectiveSampling.seed = undefined;
                                            if (warning.feature === 'temperature') effectiveSampling.temperature = undefined;
                                            if (warning.feature === 'topP') effectiveSampling.topP = undefined;
                                        }
                                        this.opts.logger.warn(`model '${selected.model}': ${JSON.stringify(warning)}`);
                                    }
                                }
                                // Keep SDK global warning output from bypassing the host's logger and --silent.
                                output.enqueue({ ...part, warnings: [] });
                            },
                        })) };
                    },
                },
            });
            const tools: ToolSet = {};
            const registered = new Map<string, RegisteredTool>();
            const add = (name: string, description: string, parameters: Record<string, unknown>, invoke: RegisteredTool['invoke']) => {
                if (Object.hasOwn(tools, name)) throw new LlmError(`duplicate tool '${name}'`);
                const validate = ajv.compile(parameters);
                if ('$async' in validate && validate.$async) throw new LlmError(`tool '${name}' has an unsupported asynchronous schema`);
                tools[name] = { description, inputSchema: jsonSchema(parameters), strict: false };
                registered.set(name, { invoke, validate });
            };
            const toolResults: string[] = [];
            let actionExecuted = false;
            if (req.kind === 'agent') {
                if (req.naturalLanguage) {
                    for (const spec of req.runtimeTools ?? []) add(spec.name, spec.description, spec.parameters, async input => {
                        if (!req.invokeAction) throw new LlmError('blockquote runtime action handler is not configured');
                        try {
                            const value = await req.invokeAction({ name: spec.name, arguments: input });
                            check();
                            actionExecuted = true;
                            return JSON.stringify({ value });
                        } catch (error) {
                            return stop(error);
                        }
                    });
                } else {
                    for (const spec of Object.values(TOOL_SPECS)) add(spec.name, spec.description, {
                        type: 'object', properties: spec.properties, required: spec.required, additionalProperties: false,
                    }, async input => {
                        try {
                            return await req.tools.invoke(spec.name, input);
                        } catch (error) {
                            if (!(error instanceof Failure)) throw error;
                            if (error.statusCode === 'restriction_violation') return stop(error);
                            return error.reason;
                        }
                    });
                }
                const servers = filterMcpServers(this.opts.mcpServers ?? {}, req.restrictions);
                let serverIndex = 0;
                for (const [server, config] of Object.entries(servers)) {
                    check();
                    const transport = 'command' in config
                        ? new StdioMCPTransport({
                            command: config.command, args: config.args, env: config.env,
                            cwd: config.workingDirectory ?? this.opts.cwd, stderr: 'inherit',
                        })
                        : { type: config.type, url: config.url, headers: config.headers };
                    const client = await createMCPClient({
                        transport, maxRetries: 0,
                        initializationOptions: { signal, timeout: config.timeout ?? this.opts.timeoutMs },
                        onUncaughtError: error => this.opts.logger.warn(`MCP ${server}: ${error instanceof Error ? error.message : String(error)}`),
                    });
                    if (signal.aborted) {
                        void this.closeMcp(client);
                        check();
                    }
                    clients.add(client);
                    let cursor: string | undefined;
                    let toolIndex = 0;
                    do {
                        const page = await client.listTools({
                            params: cursor ? { cursor } : undefined,
                            options: { signal, timeout: config.timeout ?? this.opts.timeoutMs },
                        });
                        check();
                        for (const spec of page.tools) {
                            if (!configuredMcpTool(servers, server, spec.name)) continue;
                            add(`mcp_${serverIndex}_${toolIndex++}`, `MCP ${server}/${spec.name}: ${spec.description ?? spec.name}`, spec.inputSchema, async input => {
                                check();
                                try {
                                    (req.currentRestrictions?.() ?? req.restrictions).checkMcp(server, spec.name);
                                    const result = await client.callTool({
                                        name: spec.name, arguments: input,
                                        options: { signal, timeout: config.timeout ?? this.opts.timeoutMs },
                                    });
                                    check();
                                    toolResults.push(JSON.stringify({ server, tool: spec.name, arguments: input, success: !result.isError, result }));
                                    if (result.isError && req.naturalLanguage) {
                                        throw new Failure('tool_error', `MCP ${server}/${spec.name}: ${JSON.stringify(result.content)}`);
                                    }
                                    return JSON.stringify(result);
                                } catch (error) {
                                    check();
                                    if (error instanceof Failure && error.statusCode === 'restriction_violation') return stop(error);
                                    const failure = error instanceof Failure ? error
                                        : new Failure('tool_error', `MCP ${server}/${spec.name}: ${error instanceof Error ? error.message : String(error)}`);
                                    if (req.naturalLanguage) return stop(failure);
                                    toolResults.push(JSON.stringify({ server, tool: spec.name, arguments: input, success: false, error: failure.reason }));
                                    return JSON.stringify({ isError: true, content: [{ type: 'text', text: failure.reason }] });
                                }
                            });
                        }
                        cursor = page.nextCursor;
                    } while (cursor);
                    serverIndex++;
                }
            }
            const messages: ModelMessage[] = [{ role: 'user', content: req.prompt }];
            const reasons: string[] = [];
            for (let step = 0; ; step++) {
                check();
                const stream = streamText({
                    model,
                    system: SYSTEM_MESSAGE, messages, tools,
                    providerOptions: reasoning.options, abortSignal: signal,
                    reasoning: reasoning.effort === 'none' ? 'none' : undefined,
                    ...sampling,
                    maxRetries: 0, streamRetries: 0,
                    onError: () => {}, // The error part below is authoritative; never write SDK diagnostics to stdout.
                });
                const outputs: ToolModelMessage['content'] = [];
                const fragments = new Map<string, string>();
                const publish = (channel: 'response' | 'reasoning', id: string, mode: 'append' | 'replace', text: string) => {
                    if (!receiving || signal.aborted || (channel === 'reasoning' && !req.showReasoning)) return;
                    try { req.onStream?.({ channel, messageId: `${step}:${id}`, mode, text }); }
                    catch (error) { stop(error); }
                };
                for await (const part of stream.fullStream) {
                    check();
                    if (part.type === 'text-delta' || part.type === 'reasoning-delta') {
                        const channel = part.type === 'text-delta' ? 'response' : 'reasoning';
                        const key = `${channel}:${part.id}`;
                        fragments.set(key, (fragments.get(key) ?? '') + part.text);
                        publish(channel, part.id, 'append', part.text);
                    } else if (part.type === 'text-end' || part.type === 'reasoning-end') {
                        const channel = part.type === 'text-end' ? 'response' : 'reasoning';
                        const text = fragments.get(`${channel}:${part.id}`) ?? '';
                        publish(channel, part.id, 'replace', text);
                    } else if (part.type === 'tool-input-start' || part.type === 'tool-call') {
                        if (req.kind !== 'agent' || !registered.has(part.toolName) || part.providerExecuted) {
                            stop(new Failure('restriction_violation', req.kind !== 'agent'
                                ? 'generation cannot use tools; use an explicit agent operation'
                                : `tool '${part.toolName}' is not enabled by the runtime`));
                        }
                        if (part.type !== 'tool-call') continue;
                        const handler = registered.get(part.toolName)!;
                        const input: unknown = part.input;
                        if (!input || typeof input !== 'object' || Array.isArray(input) || !handler.validate(input)) {
                            return stop(new Failure(req.naturalLanguage ? 'runtime_error' : 'tool_error', `invalid arguments for tool '${part.toolName}'`));
                        }
                        const output = await handler.invoke({ ...input });
                        check();
                        outputs.push({ type: 'tool-result', toolCallId: part.toolCallId, toolName: part.toolName, output: { type: 'text', value: output } });
                    } else if (part.type === 'tool-error') {
                        stop(new Failure(req.naturalLanguage ? 'runtime_error' : 'tool_error', `tool '${part.toolName}': ${String(part.error)}`));
                    } else if (part.type === 'error') {
                        throw part.error;
                    } else if (part.type === 'abort') {
                        throw new LlmError(part.reason ?? 'the model turn was aborted');
                    } else if (part.type === 'start-step') {
                        for (const warning of part.warnings) this.opts.logger.warn(`model '${selected.model}': ${JSON.stringify(warning)}`);
                    }
                }
                check();
                const reason = await stream.reasoningText;
                if (reason) {
                    reasons.push(reason);
                    if (req.showReasoning) this.opts.logger.info(`reasoning: ${reason}`);
                }
                const finish = await stream.finishReason;
                if (finish !== 'stop' && finish !== 'tool-calls') throw new LlmError(`model turn did not complete (${finish})`);
                if (outputs.length) {
                    messages.push(...(await stream.response).messages, { role: 'tool', content: outputs });
                    continue;
                }
                if (finish === 'tool-calls') throw new LlmError('the model ended with no executable tool calls');
                const content = await stream.text;
                const text = actionExecuted && !content.trim() ? 'Runtime actions completed.' : content;
                if (!text.trim()) throw new LlmError('the model returned an empty response');
                return {
                    text, reasoning: reasons.length ? reasons.join('\n') : undefined,
                    ...(toolResults.length ? { toolResults } : {}),
                    effective: {
                        backend: 'vercel-ai-sdk', provider: selected.provider,
                        model: (await stream.response).modelId ?? selected.model,
                        reasoningEffort: effectiveReasoningEffort ?? null,
                        ...(randomness !== undefined ? { randomness: {
                            seed: effectiveSampling.seed ?? null,
                            temperature: effectiveSampling.temperature ?? null,
                            top_p: effectiveSampling.topP ?? null,
                        } } : {}),
                    },
                };
            }
        };
        try {
            return await Promise.race([perform(), interrupted]);
        } catch (error) {
            if (signal.aborted) throw signal.reason;
            if (error instanceof AuthError) throw new LlmError(error.message);
            if (error instanceof Failure || error instanceof LlmError) throw error;
            throw new LlmError(error instanceof Error ? error.message : String(error));
        } finally {
            receiving = false;
            clearTimeout(timer);
            this.active.delete(controller);
            if (!signal.aborted) controller.abort(new LlmError('the model call has completed'));
            await Promise.all([...clients].map(client => this.closeMcp(client)));
        }
    }

    async close(): Promise<void> {
        this.closed = true;
        for (const controller of this.active) controller.abort(new LlmError('the model call was cancelled'));
    }
}
