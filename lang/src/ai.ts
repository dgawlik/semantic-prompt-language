import { createMCPClient, type MCPClient } from '@ai-sdk/mcp';
import { StdioMCPTransport } from '@ai-sdk/mcp/mcp-stdio';
import { Ajv } from 'ajv';
import { createNativeModel, nativeDecision, type ProviderOptions, type ToolOutput } from './ai-native.js';
import { AuthError, resolveProvider, type ProviderId } from './auth.js';
import { Failure, SuccessSignal } from './errors.js';
import {
    LlmError, addTokenUsage, validateMaxSteps, validateRandomness, validateTokens,
    type DecisionRequest, type DecisionResponse, type LlmBackend, type LlmRequest, type LlmResponse, type ReasoningLevel, type RuntimeTool, type TokenUsage,
} from './llm.js';
import type { Logger } from './logger.js';
import { configuredMcpTool, filterMcpServers, type MCPServerConfig, type McpServers } from './mcp.js';
import { estimateCostUsd, resolveModelCapabilities, type ModelCapabilityRule } from './models.js';
import { TOOL_SPECS, describeCustomToolCall, describeMcpCall, describeToolCall, type ToolName } from './tools.js';
import { isType } from './types.js';

const SYSTEM_MESSAGE = [
    'You are the execution engine of an automated script. Your reply is stored in a variable and used by the program.',
    'Reply with exactly what was asked for: no preamble, no sign-off, no commentary.',
    'Use the provided runtime tools and configured MCP tools only when the task needs them.',
].join(' ');

const ajv = new Ajv({ strict: false, allErrors: true, addUsedSchema: false });
const budgets: Record<Exclude<ReasoningLevel, 'none'>, number> = { low: 1024, medium: 4096, high: 16384, max: 32768 };
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const RETRYABLE_CODE = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT']);

export interface AiBackendOptions {
    logger: Logger;
    cwd: string;
    timeoutMs: number;
    provider?: ProviderId;
    apiKey?: string;
    baseUrl?: string;
    baseUrls?: Partial<Record<ProviderId, string>>;
    mcpServers?: McpServers;
    /** Pool MCP client connections across calls until `close()`. Default: `true`. */
    poolMcp?: boolean;
    /** Retry transient 429/5xx/network errors before any turn output or tool call. Default: `0`. */
    maxRetries?: number;
    /** Base delay in ms for exponential backoff retries. Default: `250`. */
    retryDelayMs?: number;
    /** Default maximum model turns per agent call. */
    maxSteps?: number;
    /** Additional model capability/pricing rules. */
    modelCapabilities?: readonly ModelCapabilityRule[];
}

/**
 * Provider settings for a reasoning level. Without a requested level the default is `medium`, or `none`
 * when sampling is set. A level the model lacks falls back to the nearest one it offers; only a level the
 * workflow asked for is worth a warning.
 */
export function reasoningOptions(
    provider: ProviderId, model: string, requested: ReasoningLevel | undefined, showReasoning: boolean, logger: Logger,
    sampling = false, modelCapabilities?: readonly ModelCapabilityRule[],
): { options: ProviderOptions; effort?: ReasoningLevel } {
    const level = requested ?? (sampling ? 'none' : 'medium');
    const caps = resolveModelCapabilities(provider, model, modelCapabilities);
    const options: ProviderOptions = provider === 'openai'
        ? { openai: { parallelToolCalls: false, store: false,
            ...(caps.supportsReasoningSummary ? { reasoningSummary: showReasoning ? 'auto' : null } : {}) } }
        : provider === 'anthropic' ? { anthropic: { disableParallelToolUse: true } }
        : provider === 'google' && caps.reasoning !== 'none' ? { google: { thinkingConfig: { includeThoughts: showReasoning } } } : {};
    const fallback = (used: string): void => {
        if (requested) logger.warn(`model '${model}' does not support reasoning '${level}'; using ${used}`);
    };
    if (caps.reasoning === 'none') {
        if (level !== 'none') fallback('the model default');
        return { options };
    }
    // The provider minimum is chosen per model when the request is built.
    if (level === 'none') return { options, effort: 'none' };
    if (provider === 'openai' || provider === 'openai-compatible') {
        let effort: 'low' | 'medium' | 'high' | 'xhigh';
        if (caps.allowedEfforts?.length && !caps.allowedEfforts.includes(level)) {
            effort = caps.allowedEfforts[caps.allowedEfforts.length - 1] === 'max' ? 'xhigh' : caps.allowedEfforts[caps.allowedEfforts.length - 1] as 'low' | 'medium' | 'high';
        } else if (level === 'max') {
            effort = caps.maxReasoningEffort === 'xhigh' ? 'xhigh' : 'high';
        } else {
            effort = level;
        }
        if (level !== 'max' && effort !== level) fallback(`'${effort}'`);
        (options.openai ??= {}).reasoningEffort = effort;
        return { options, effort: effort === 'xhigh' ? 'max' : effort };
    }
    if (provider === 'anthropic') {
        const adaptive = caps.reasoning === 'adaptive';
        (options.anthropic ??= {}).thinking = adaptive ? { type: 'adaptive' } : { type: 'enabled', budgetTokens: budgets[level] };
        if (adaptive) options.anthropic.effort = level;
        return { options, effort: level };
    }
    if (caps.reasoning === 'budget') {
        const cap = caps.maxThinkingBudget ?? 24576;
        const budget = Math.min(budgets[level], cap);
        options.google = { thinkingConfig: { thinkingBudget: budget, includeThoughts: showReasoning } };
        return { options, effort: level };
    }
    // Level-based Gemini models (3+): no level above high, and some models only offer low/high.
    let effort: 'low' | 'medium' | 'high' = level === 'max' ? 'high' : level;
    if (caps.allowedEfforts?.length && !caps.allowedEfforts.includes(effort)) {
        effort = caps.allowedEfforts[caps.allowedEfforts.length - 1] as 'low' | 'medium' | 'high';
    }
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
    validate?: ReturnType<Ajv['compile']>;
}

interface McpToolMeta {
    name: string;
    description?: string;
    inputSchema: Record<string, unknown>;
}

interface PooledMcp {
    client: MCPClient;
    tools: McpToolMeta[];
}

function isRetryableError(error: unknown): boolean {
    if (error instanceof Failure || error instanceof AuthError || error instanceof SuccessSignal) return false;
    if (typeof error !== 'object' || error === null) return false;
    const record = error as { status?: unknown; statusCode?: unknown; code?: unknown; message?: unknown; cause?: unknown };
    const status = typeof record.status === 'number' ? record.status : typeof record.statusCode === 'number' ? record.statusCode : undefined;
    if (status !== undefined) return RETRYABLE_STATUS.has(status);
    if (typeof record.code === 'string' && RETRYABLE_CODE.has(record.code)) return true;
    if (typeof record.message === 'string' && /\b(?:429|500|502|503|504|rate limit|overloaded|fetch failed|socket hang up|ECONNRESET|ETIMEDOUT)\b/i.test(record.message)) {
        return true;
    }
    return record.cause ? isRetryableError(record.cause) : false;
}

function retryAfterMs(error: unknown): number | undefined {
    if (typeof error !== 'object' || error === null) return undefined;
    const headers = (error as { headers?: unknown }).headers;
    let raw: string | null | undefined;
    if (headers instanceof Headers) raw = headers.get('retry-after');
    else if (typeof headers === 'object' && headers !== null) {
        for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
            if (k.toLowerCase() === 'retry-after' && typeof v === 'string') { raw = v; break; }
        }
    }
    if (!raw) return undefined;
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const date = Date.parse(raw);
    return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
        if (signal.aborted) { reject(signal.reason); return; }
        const timer = setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(timer);
            reject(signal.reason);
        };
        signal.addEventListener('abort', onAbort, { once: true });
    });
}

/** Each call owns its conversation, cancellation and timeout; MCP servers are pooled across calls by default. */
export class AiBackend implements LlmBackend {
    private readonly active = new Set<AbortController>();
    private readonly mcpPool = new Map<string, Promise<PooledMcp>>();
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

    private async connectMcp(server: string, config: MCPServerConfig, signal: AbortSignal): Promise<PooledMcp> {
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
        if (signal.aborted || this.closed) {
            await this.closeMcp(client);
            signal.throwIfAborted();
            throw new LlmError('the model backend is closed');
        }
        try {
            const tools: McpToolMeta[] = [];
            let cursor: string | undefined;
            do {
                const page = await client.listTools({
                    params: cursor ? { cursor } : undefined,
                    options: { signal, timeout: config.timeout ?? this.opts.timeoutMs },
                });
                signal.throwIfAborted();
                for (const spec of page.tools) {
                    tools.push({ name: spec.name, description: spec.description, inputSchema: spec.inputSchema });
                }
                cursor = page.nextCursor;
            } while (cursor);
            return { client, tools };
        } catch (error) {
            await this.closeMcp(client);
            throw error;
        }
    }

    private getMcp(server: string, config: MCPServerConfig, signal: AbortSignal, ephemeral: Set<MCPClient>): Promise<PooledMcp> {
        if (this.opts.poolMcp === false) {
            return this.connectMcp(server, config, signal).then(entry => {
                ephemeral.add(entry.client);
                return entry;
            });
        }
        const existing = this.mcpPool.get(server);
        if (existing) return existing;
        const created = this.connectMcp(server, config, signal).catch(error => {
            if (this.mcpPool.get(server) === created) this.mcpPool.delete(server);
            throw error;
        });
        this.mcpPool.set(server, created);
        return created;
    }

    private evictMcp(server: string): void {
        const entry = this.mcpPool.get(server);
        if (!entry) return;
        this.mcpPool.delete(server);
        void entry.then(pooled => this.closeMcp(pooled.client), () => undefined);
    }

    async call(req: LlmRequest): Promise<LlmResponse> {
        if (this.closed) throw new LlmError('the model backend is closed');
        const controller = new AbortController();
        const { signal } = controller;
        this.active.add(controller);
        const ephemeralClients = new Set<MCPClient>();
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
            const selected = resolveProvider(req.model, this.opts.provider, {
                apiKey: this.opts.apiKey,
                baseUrl: this.opts.baseUrl,
                baseUrls: this.opts.baseUrls,
            });
            const randomness = req.randomness === undefined ? undefined : validateRandomness(req.randomness);
            const tokens = req.tokens === undefined ? undefined : validateTokens(req.tokens);
            const maxSteps = (req.maxSteps ?? this.opts.maxSteps) === undefined
                ? undefined
                : validateMaxSteps(req.maxSteps ?? this.opts.maxSteps);
            const caps = resolveModelCapabilities(selected.provider, selected.model, this.opts.modelCapabilities);
            const reasoning = reasoningOptions(selected.provider, selected.model, req.reasoningEffort, req.showReasoning,
                this.opts.logger, randomness !== undefined, this.opts.modelCapabilities);
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
            if (sampling.temperature !== undefined && caps.maxTemperature !== undefined && sampling.temperature > caps.maxTemperature) {
                this.opts.logger.warn(`${selected.provider}/${selected.model} supports temperature at most ${caps.maxTemperature}; clamping randomness.temperature to ${caps.maxTemperature}`);
                sampling.temperature = caps.maxTemperature;
            }
            const effectiveSampling = { ...sampling };
            const model = await createNativeModel(selected.provider, selected.apiKey, selected.model, this.opts.logger, {
                ...(selected.baseUrl ? { baseUrl: selected.baseUrl } : {}),
                ...(this.opts.modelCapabilities ? { modelCapabilities: this.opts.modelCapabilities } : {}),
            });
            check();
            const tools: RuntimeTool[] = [];
            const registered = new Map<string, RegisteredTool>();
            const add = (
                name: string,
                description: string,
                parameters: Record<string, unknown>,
                invoke: RegisteredTool['invoke'],
                skipAjv = false,
            ) => {
                if (registered.has(name)) throw new LlmError(`duplicate tool '${name}'`);
                const validate = skipAjv ? undefined : ajv.compile(parameters);
                if (validate && '$async' in validate && validate.$async) throw new LlmError(`tool '${name}' has an unsupported asynchronous schema`);
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
                    const enabledBuiltins: readonly ToolName[] = req.builtinTools === false ? []
                        : Array.isArray(req.builtinTools) ? req.builtinTools
                        : (Object.keys(TOOL_SPECS) as ToolName[]);
                    for (const builtinName of enabledBuiltins) {
                        const spec = TOOL_SPECS[builtinName];
                        if (!spec) throw new Failure('runtime_error', `unknown built-in tool '${String(builtinName)}'`);
                        add(spec.name, spec.description, {
                            type: 'object', properties: spec.properties, required: spec.required, additionalProperties: false,
                        }, async input => {
                            try {
                                const output = await req.tools.invoke(spec.name, input);
                                this.opts.logger.tool(describeToolCall(spec.name, input, { output }));
                                toolResults.push(JSON.stringify({ tool: spec.name, arguments: input, success: true, output }));
                                return output;
                            } catch (error) {
                                if (!(error instanceof Failure)) throw error;
                                this.opts.logger.tool(describeToolCall(spec.name, input, { error: error.reason }));
                                toolResults.push(JSON.stringify({ tool: spec.name, arguments: input, success: false, error: error.reason }));
                                if (error.statusCode === 'restriction_violation') return stop(error);
                                return error.reason;
                            }
                        });
                    }
                    for (const custom of req.customTools ?? []) {
                        const rawSchema = isType(custom.input) ? custom.input.schema() : custom.input;
                        const parameters = typeof rawSchema === 'object' && rawSchema !== null
                            ? { ...rawSchema, type: (rawSchema as { type?: unknown }).type ?? 'object' }
                            : { type: 'object', properties: {} };
                        add(custom.name, custom.description, parameters, async input => {
                            try {
                                const parsed = isType(custom.input) ? custom.input.coerce(input, custom.name) : input;
                                const result = await custom.execute(parsed);
                                check();
                                const serialized = typeof result === 'string' ? result : JSON.stringify(result ?? null);
                                this.opts.logger.tool(describeCustomToolCall(custom.name, input, { output: serialized }));
                                toolResults.push(JSON.stringify({ tool: custom.name, arguments: input, success: true, output: serialized }));
                                return serialized;
                            } catch (error) {
                                check();
                                if (error instanceof SuccessSignal) return stop(error);
                                if (error instanceof Failure && error.statusCode === 'restriction_violation') return stop(error);
                                const reason = error instanceof Failure ? error.reason : error instanceof Error ? error.message : String(error);
                                this.opts.logger.tool(describeCustomToolCall(custom.name, input, { error: reason }));
                                toolResults.push(JSON.stringify({ tool: custom.name, arguments: input, success: false, error: reason }));
                                return reason;
                            }
                        }, isType(custom.input));
                    }
                }
                const servers = filterMcpServers(this.opts.mcpServers ?? {}, req.restrictions);
                let serverIndex = 0;
                for (const [server, config] of Object.entries(servers)) {
                    check();
                    const pooled = await this.getMcp(server, config, signal, ephemeralClients);
                    check();
                    for (const spec of pooled.tools) {
                        if (!configuredMcpTool(servers, server, spec.name)) continue;
                        add(mcpToolName(serverIndex, spec.name, name => registered.has(name)), `MCP ${server}/${spec.name}: ${spec.description ?? spec.name}`, spec.inputSchema, async input => {
                            check();
                            let logged = false;
                            try {
                                req.restrictions.checkMcp(server, spec.name);
                                const result = await pooled.client.callTool({
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
                                // Transport/connection failures invalidate the pooled client so later calls reconnect.
                                if (!(error instanceof Failure) && this.opts.poolMcp !== false) {
                                    this.evictMcp(server);
                                }
                                const failure = error instanceof Failure ? error
                                    : new Failure('tool_error', `MCP ${server}/${spec.name}: ${error instanceof Error ? error.message : String(error)}`);
                                if (!logged) this.opts.logger.tool(describeMcpCall(server, spec.name, input, { error: failure.reason }));
                                if (req.runtimeTools) return stop(failure);
                                toolResults.push(JSON.stringify({ server, tool: spec.name, arguments: input, success: false, error: failure.reason }));
                                return JSON.stringify({ isError: true, content: [{ type: 'text', text: failure.reason }] });
                            }
                        });
                    }
                    serverIndex++;
                }
            }
            const reasons: string[] = [];
            let totalUsage: TokenUsage | undefined;
            const maxRetries = Math.max(0, this.opts.maxRetries ?? 0);
            const baseDelayMs = Math.max(0, this.opts.retryDelayMs ?? 250);
            for (let step = 0; ; step++) {
                check();
                if (maxSteps !== undefined && step >= maxSteps) {
                    throw new LlmError(`agent exceeded maxSteps (${maxSteps})`);
                }
                const outputs: ToolOutput[] = [];
                const fragments = new Map<string, string>();
                let finish = 'unknown';
                let modelId = selected.model;
                const publish = (channel: 'response' | 'reasoning', id: string, mode: 'append' | 'replace', text: string) => {
                    if (!receiving || signal.aborted || (channel === 'reasoning' && !req.showReasoning)) return;
                    try { req.onStream?.({ channel, messageId: `${step}:${id}`, mode, text }); }
                    catch (error) { stop(error); }
                };
                for (let retry = 0; ; retry++) {
                    let sawOutputOrTool = false;
                    try {
                        const stream = model.stream({
                            system: SYSTEM_MESSAGE, prompt: req.prompt, tools,
                            providerOptions: reasoning.options, abortSignal: signal,
                            reasoning: reasoning.effort === 'none' ? 'none' : undefined,
                            ...(req.responseSchema ? { responseSchema: req.responseSchema } : {}),
                            ...(req.attachments?.length ? { attachments: req.attachments } : {}),
                            tokens,
                            ...sampling,
                        });
                        for await (const part of stream) {
                            check();
                            if (part.type === 'text-delta' || part.type === 'reasoning-delta') {
                                sawOutputOrTool = true;
                                const channel = part.type === 'text-delta' ? 'response' : 'reasoning';
                                const key = `${channel}:${part.id}`;
                                fragments.set(key, (fragments.get(key) ?? '') + part.delta);
                                publish(channel, part.id, 'append', part.delta);
                            } else if (part.type === 'text-end' || part.type === 'reasoning-end') {
                                sawOutputOrTool = true;
                                const channel = part.type === 'text-end' ? 'response' : 'reasoning';
                                const key = `${channel}:${part.id}`;
                                const text = part.text ?? fragments.get(key) ?? '';
                                fragments.set(key, text);
                                publish(channel, part.id, 'replace', text);
                            } else if (part.type === 'tool-input-start' || part.type === 'tool-call') {
                                sawOutputOrTool = true;
                                if (req.kind !== 'agent' || !registered.has(part.toolName) || part.providerExecuted) {
                                    stop(new Failure('restriction_violation', req.kind !== 'agent'
                                        ? 'generation cannot use tools; use an explicit agent operation'
                                        : `tool '${part.toolName}' is not enabled by the runtime`));
                                }
                                if (part.type !== 'tool-call') continue;
                                const handler = registered.get(part.toolName)!;
                                const input: unknown = part.input;
                                if (!input || typeof input !== 'object' || Array.isArray(input) || (handler.validate && !handler.validate(input))) {
                                    return stop(new Failure(req.runtimeTools ? 'runtime_error' : 'tool_error', `invalid arguments for tool '${part.toolName}'`));
                                }
                                const output = await handler.invoke({ ...input });
                                check();
                                outputs.push({ toolCallId: part.toolCallId, toolName: part.toolName, value: output });
                            } else if (part.type === 'tool-error') {
                                sawOutputOrTool = true;
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
                                if (part.usage) totalUsage = addTokenUsage(totalUsage, part.usage);
                            }
                        }
                        break;
                    } catch (error) {
                        if (signal.aborted || sawOutputOrTool || retry >= maxRetries || !isRetryableError(error)) throw error;
                        const hinted = retryAfterMs(error);
                        const backoff = baseDelayMs * (2 ** retry);
                        const delay = hinted !== undefined ? hinted : Math.round(backoff * (0.75 + Math.random() * 0.5));
                        this.opts.logger.warn(`retrying ${selected.provider}/${selected.model} (${retry + 1}/${maxRetries}) in ${delay}ms: ${error instanceof Error ? error.message : String(error)}`);
                        await sleep(delay, signal);
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
                const costUsd = totalUsage ? estimateCostUsd(selected.provider, modelId, totalUsage, this.opts.modelCapabilities) : undefined;
                return {
                    text, reasoning: reasons.length ? reasons.join('\n') : undefined,
                    ...(totalUsage ? { usage: totalUsage } : {}),
                    ...(costUsd !== undefined ? { costUsd } : {}),
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
            if (ephemeralClients.size) {
                await Promise.all([...ephemeralClients].map(client => this.closeMcp(client)));
            }
        }
    }

    async decide(req: DecisionRequest): Promise<DecisionResponse | null> {
        if (this.closed) throw new LlmError('the model backend is closed');
        const selected = (() => {
            try {
                return resolveProvider(req.model, this.opts.provider, {
                    apiKey: this.opts.apiKey,
                    baseUrl: this.opts.baseUrl,
                    baseUrls: this.opts.baseUrls,
                });
            } catch (error) {
                throw error instanceof AuthError ? new LlmError(error.message) : error;
            }
        })();
        if (selected.provider === 'anthropic' || selected.provider === 'openai-compatible') return null;
        const controller = new AbortController();
        this.active.add(controller);
        const timer = setTimeout(() => controller.abort(new LlmError(`decision call timed out after ${this.opts.timeoutMs}ms`)), this.opts.timeoutMs);
        try {
            return await nativeDecision(selected.provider, selected.apiKey, req, controller.signal, this.opts.logger, selected.baseUrl);
        } catch (error) {
            if (controller.signal.aborted) throw controller.signal.reason;
            if (error instanceof Failure || error instanceof LlmError) throw error;
            throw new LlmError(error instanceof Error ? error.message : String(error));
        } finally {
            clearTimeout(timer);
            this.active.delete(controller);
        }
    }

    async close(): Promise<void> {
        this.closed = true;
        for (const controller of this.active) controller.abort(new LlmError('the model call was cancelled'));
        const pooled = [...this.mcpPool.values()];
        this.mcpPool.clear();
        await Promise.all(pooled.map(entry => entry.then(item => this.closeMcp(item.client), () => undefined)));
    }
}
