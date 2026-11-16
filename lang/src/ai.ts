import { createMCPClient, type MCPClient } from '@ai-sdk/mcp';
import { StdioMCPTransport } from '@ai-sdk/mcp/mcp-stdio';
import { Ajv } from 'ajv';
import { createNativeModel, type ProviderOptions, type ToolOutput } from './ai-native.js';
import { AuthError, resolveProvider, type Provider } from './auth.js';
import { Failure } from './errors.js';
import { LlmError, validateRandomness, validateTokens, type LlmBackend, type LlmRequest, type LlmResponse, type ReasoningLevel, type RuntimeTool } from './llm.js';
import type { Logger } from './logger.js';
import { configuredMcpTool, filterMcpServers, type McpServers } from './mcp.js';
import { TOOL_SPECS, describeMcpCall, describeToolCall } from './tools.js';

const SYSTEM_MESSAGE = [
    'You are the execution engine of an automated script. Your reply is stored in a variable and used by the program.',
    'Reply with exactly what was asked for: no preamble, no sign-off, no commentary.',
    'Use the provided runtime tools and configured MCP tools only when the task needs them.',
].join(' ');

const ajv = new Ajv({ strict: false, allErrors: true, addUsedSchema: false });
const budgets: Record<Exclude<ReasoningLevel, 'none'>, number> = { low: 1024, medium: 4096, high: 16384, max: 32768 };

export interface AiBackendOptions {
    logger: Logger;
    cwd: string;
    timeoutMs: number;
    provider?: Provider;
    mcpServers?: McpServers;
}

/**
 * Provider settings for a reasoning level. Without a requested level the default is `medium`, or `none`
 * when sampling is set. A level the model lacks falls back to the nearest one it offers; only a level the
 * workflow asked for is worth a warning.
 */
export function reasoningOptions(
    provider: Provider, model: string, requested: ReasoningLevel | undefined, showReasoning: boolean, logger: Logger,
    sampling = false,
): { options: ProviderOptions; effort?: ReasoningLevel } {
    const level = requested ?? (sampling ? 'none' : 'medium');
    const openaiReasoning = /^(?:o[134](?:-|$)|gpt-[5-9](?:[.-]|$))/.test(model);
    const googleReasoning = /^gemini-(?:2\.5|[3-9])/.test(model);
    const anthropicReasoning = /^claude-(?:(?:sonnet|opus|haiku|fable)-[4-9]|3-7)/.test(model);
    const options: ProviderOptions = provider === 'openai'
        ? { openai: { parallelToolCalls: false, store: false,
            ...(openaiReasoning ? { reasoningSummary: showReasoning ? 'auto' : null } : {}) } }
        : provider === 'anthropic' ? { anthropic: { disableParallelToolUse: true } }
        : googleReasoning ? { google: { thinkingConfig: { includeThoughts: showReasoning } } } : {};
    const fallback = (used: string): void => {
        if (requested) logger.warn(`model '${model}' does not support reasoning '${level}'; using ${used}`);
    };
    const supported = provider === 'openai' ? openaiReasoning && !/^o1-(?:mini|preview)/.test(model)
        : provider === 'google' ? googleReasoning : anthropicReasoning;
    if (!supported) {
        if (level !== 'none') fallback('the model default');
        return { options };
    }
    // The provider minimum is chosen per model when the request is built.
    if (level === 'none') return { options, effort: 'none' };
    if (provider === 'openai') {
        const effort = /^gpt-5-pro(?:-|$)/.test(model) ? 'high'
            : level !== 'max' ? level : /^gpt-(?:5\.[2-9]|[6-9])/.test(model) ? 'xhigh' : 'high';
        if (level !== 'max' && effort !== level) fallback(`'${effort}'`);
        (options.openai ??= {}).reasoningEffort = effort;
        return { options, effort: effort === 'xhigh' ? 'max' : effort };
    }
    if (provider === 'anthropic') {
        const adaptive = /^claude-(?:(?:opus|sonnet)-4-[6-9]|(?:sonnet|opus|haiku|fable)-[5-9])/.test(model);
        (options.anthropic ??= {}).thinking = adaptive ? { type: 'adaptive' } : { type: 'enabled', budgetTokens: budgets[level] };
        if (adaptive) options.anthropic.effort = level;
        return { options, effort: level };
    }
    if (/^gemini-2\.5/.test(model)) {
        const budget = Math.min(budgets[level], /-pro/.test(model) ? 32768 : 24576);
        options.google = { thinkingConfig: { thinkingBudget: budget, includeThoughts: showReasoning } };
        return { options, effort: level };
    }
    // Gemini 3 Pro offers low and high only; no Gemini model has a level above high.
    const effort = level === 'max' || level === 'medium' && /^gemini-3(?:\.0)?-pro/.test(model) ? 'high' : level;
    if (level !== 'max' && effort !== level) fallback(`'${effort}'`);
    options.google = { thinkingConfig: { thinkingLevel: effort, includeThoughts: showReasoning } };
    return { options, effort };
}

/** `search_docs` on the first server becomes `mcp0SearchDocs`. */
function mcpToolName(server: number, tool: string, taken: (name: string) => boolean): string {
    const base = `mcp${server}${tool.split(/[^A-Za-z0-9]+/).filter(Boolean).map(part => part[0].toUpperCase() + part.slice(1)).join('')}`;
    let name = base;
    for (let suffix = 2; taken(name); suffix++) name = `${base}${suffix}`;
    return name;
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
            const tokens = req.tokens === undefined ? undefined : validateTokens(req.tokens);
            const reasoning = reasoningOptions(selected.provider, selected.model, req.reasoningEffort, req.showReasoning,
                this.opts.logger, randomness !== undefined);
            const insisted = req.reasoningEffort !== undefined && req.reasoningEffort !== 'none';
            // A level nobody asked for must not make a small token budget invalid: think less, or not at all.
            const thinking = reasoning.options.anthropic?.thinking;
            if (!req.reasoningEffort && tokens !== undefined && thinking?.type === 'enabled' && tokens <= thinking.budgetTokens) {
                if (tokens > budgets.low) thinking.budgetTokens = budgets.low;
                else delete reasoning.options.anthropic!.thinking;
                reasoning.effort = tokens > budgets.low ? 'low' : undefined;
            }
            let effectiveReasoningEffort = reasoning.effort;
            const sampling = {
                seed: randomness?.seed,
                temperature: randomness?.temperature,
                topP: randomness?.top_p,
            };
            if (sampling.temperature !== undefined && sampling.temperature > 1 && selected.provider === 'anthropic') {
                this.opts.logger.warn(`anthropic/${selected.model} supports temperature at most 1; clamping randomness.temperature to 1`);
                sampling.temperature = 1;
            }
            const effectiveSampling = { ...sampling };
            const model = await createNativeModel(selected.provider, selected.apiKey, selected.model, this.opts.logger);
            check();
            const tools: RuntimeTool[] = [];
            const registered = new Map<string, RegisteredTool>();
            const add = (name: string, description: string, parameters: Record<string, unknown>, invoke: RegisteredTool['invoke']) => {
                if (registered.has(name)) throw new LlmError(`duplicate tool '${name}'`);
                const validate = ajv.compile(parameters);
                if ('$async' in validate && validate.$async) throw new LlmError(`tool '${name}' has an unsupported asynchronous schema`);
                tools.push({ name, description, parameters });
                registered.set(name, { invoke, validate });
            };
            const toolResults: string[] = [];
            let actionExecuted = false;
            if (req.kind === 'agent') {
                if (req.runtimeTools) {
                    for (const spec of req.runtimeTools) add(spec.name, spec.description, spec.parameters, async input => {
                        if (!req.invokeAction) throw new LlmError('agent block action handler is not configured');
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
                            const output = await req.tools.invoke(spec.name, input);
                            this.opts.logger.tool(describeToolCall(spec.name, input, { output }));
                            return output;
                        } catch (error) {
                            if (!(error instanceof Failure)) throw error;
                            this.opts.logger.tool(describeToolCall(spec.name, input, { error: error.reason }));
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
                    do {
                        const page = await client.listTools({
                            params: cursor ? { cursor } : undefined,
                            options: { signal, timeout: config.timeout ?? this.opts.timeoutMs },
                        });
                        check();
                        for (const spec of page.tools) {
                            if (!configuredMcpTool(servers, server, spec.name)) continue;
                            add(mcpToolName(serverIndex, spec.name, name => registered.has(name)), `MCP ${server}/${spec.name}: ${spec.description ?? spec.name}`, spec.inputSchema, async input => {
                                check();
                                let logged = false;
                                try {
                                    req.restrictions.checkMcp(server, spec.name);
                                    const result = await client.callTool({
                                        name: spec.name, arguments: input,
                                        options: { signal, timeout: config.timeout ?? this.opts.timeoutMs },
                                    });
                                    check();
                                    logged = true;
                                    this.opts.logger.tool(describeMcpCall(server, spec.name, input, { result, isError: Boolean(result.isError) }));
                                    toolResults.push(JSON.stringify({ server, tool: spec.name, arguments: input, success: !result.isError, result }));
                                    if (result.isError && req.runtimeTools) {
                                        throw new Failure('tool_error', `MCP ${server}/${spec.name}: ${JSON.stringify(result.content)}`);
                                    }
                                    return JSON.stringify(result);
                                } catch (error) {
                                    check();
                                    if (error instanceof Failure && error.statusCode === 'restriction_violation') return stop(error);
                                    const failure = error instanceof Failure ? error
                                        : new Failure('tool_error', `MCP ${server}/${spec.name}: ${error instanceof Error ? error.message : String(error)}`);
                                    if (!logged) this.opts.logger.tool(describeMcpCall(server, spec.name, input, { error: failure.reason }));
                                    if (req.runtimeTools) return stop(failure);
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
            const reasons: string[] = [];
            for (let step = 0; ; step++) {
                check();
                const stream = model.stream({
                    system: SYSTEM_MESSAGE, prompt: req.prompt, tools,
                    providerOptions: reasoning.options, abortSignal: signal,
                    reasoning: reasoning.effort === 'none' ? 'none' : undefined,
                    tokens,
                    ...sampling,
                });
                const outputs: ToolOutput[] = [];
                const fragments = new Map<string, string>();
                let finish = 'unknown';
                let modelId = selected.model;
                const publish = (channel: 'response' | 'reasoning', id: string, mode: 'append' | 'replace', text: string) => {
                    if (!receiving || signal.aborted || (channel === 'reasoning' && !req.showReasoning)) return;
                    try { req.onStream?.({ channel, messageId: `${step}:${id}`, mode, text }); }
                    catch (error) { stop(error); }
                };
                for await (const part of stream) {
                    check();
                    if (part.type === 'text-delta' || part.type === 'reasoning-delta') {
                        const channel = part.type === 'text-delta' ? 'response' : 'reasoning';
                        const key = `${channel}:${part.id}`;
                        fragments.set(key, (fragments.get(key) ?? '') + part.delta);
                        publish(channel, part.id, 'append', part.delta);
                    } else if (part.type === 'text-end' || part.type === 'reasoning-end') {
                        const channel = part.type === 'text-end' ? 'response' : 'reasoning';
                        const key = `${channel}:${part.id}`;
                        const text = part.text ?? fragments.get(key) ?? '';
                        fragments.set(key, text);
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
                            return stop(new Failure(req.runtimeTools ? 'runtime_error' : 'tool_error', `invalid arguments for tool '${part.toolName}'`));
                        }
                        const output = await handler.invoke({ ...input });
                        check();
                        outputs.push({ toolCallId: part.toolCallId, toolName: part.toolName, value: output });
                    } else if (part.type === 'tool-error') {
                        stop(new Failure(req.runtimeTools ? 'runtime_error' : 'tool_error', `tool '${part.toolName}': ${String(part.error)}`));
                    } else if (part.type === 'stream-start') {
                        for (const warning of part.warnings) {
                            if (warning.conflict === 'reasoning' && insisted) {
                                stop(new LlmError(`reasoning '${req.reasoningEffort}' cannot be combined with ${warning.feature} on ${selected.provider}/${selected.model}; drop one of the two settings`));
                            }
                            if (warning.feature === 'reasoning') effectiveReasoningEffort = undefined;
                            if (warning.type === 'unsupported') {
                                if (warning.feature === 'seed') effectiveSampling.seed = undefined;
                                if (warning.feature === 'temperature') effectiveSampling.temperature = undefined;
                                if (warning.feature === 'topP') effectiveSampling.topP = undefined;
                            }
                            this.opts.logger.warn(`model '${selected.model}': ${JSON.stringify(warning)}`);
                        }
                    } else if (part.type === 'finish') {
                        finish = part.reason;
                        modelId = part.modelId ?? selected.model;
                    }
                }
                check();
                const collected = (channel: 'response' | 'reasoning') => [...fragments]
                    .filter(([key]) => key.startsWith(`${channel}:`)).map(([, text]) => text).join(channel === 'reasoning' ? '\n' : '');
                const reason = collected('reasoning');
                if (reason) {
                    reasons.push(reason);
                    if (req.showReasoning) this.opts.logger.info(`reasoning: ${reason}`);
                }
                if (finish !== 'stop' && finish !== 'tool-calls') throw new LlmError(`model turn did not complete (${finish})`);
                if (outputs.length) {
                    model.addToolResults(outputs);
                    continue;
                }
                if (finish === 'tool-calls') throw new LlmError('the model ended with no executable tool calls');
                const content = collected('response');
                const text = actionExecuted && !content.trim() ? 'Actions completed.' : content;
                if (!text.trim()) throw new LlmError('the model returned an empty response');
                return {
                    text, reasoning: reasons.length ? reasons.join('\n') : undefined,
                    ...(toolResults.length ? { toolResults } : {}),
                    effective: {
                        backend: 'native-sdk', provider: selected.provider,
                        model: modelId,
                        reasoningEffort: effectiveReasoningEffort ?? null,
                        ...(tokens !== undefined ? { tokens } : {}),
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
