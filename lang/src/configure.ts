import { createInterface } from 'node:readline';
import type { ProviderId } from './auth.js';
import { Failure } from './errors.js';
import type { LlmBackend } from './llm.js';
import { Logger, type LogLevel } from './logger.js';
import type { McpServers } from './mcp.js';
import type { ModelCapabilityRule } from './models.js';
import { Runtime, ambientFactory, setAmbient, type Context, type HumanHandler } from './runtime.js';
import type { Trace } from './trace.js';

export interface ConfigureOptions {
    /** Default model for calls that do not name one. */
    model?: string;
    provider?: ProviderId;
    /** Explicit API key override. */
    apiKey?: string;
    /** Custom base URL for the selected provider (or `openai-compatible` server). */
    baseUrl?: string;
    /** Per-provider custom base URL overrides. */
    baseUrls?: Partial<Record<ProviderId, string>>;
    cwd?: string;
    args?: readonly string[];
    /** `silent`, `error`, `info` (default) or `debug`. */
    logLevel?: LogLevel | 'silent';
    logger?: Logger;
    /** Replace the provider clients, for example with a test double. */
    backend?: LlmBackend;
    timeoutMs?: number;
    mcpServers?: McpServers;
    /** Pool MCP client connections across calls until `close()`. Default: `true`. */
    poolMcp?: boolean;
    /** Retry transient 429/5xx/network errors before turn output/tool execution. Default: `0`. */
    maxRetries?: number;
    /** Base delay in ms for exponential backoff retries. Default: `250`. */
    retryDelayMs?: number;
    /** Default maximum model turns per agent call. */
    maxSteps?: number;
    /** Maximum cumulative tokens across all model calls in this runtime. */
    maxTotalTokens?: number;
    /** Maximum cumulative estimated USD cost across all model calls in this runtime. */
    maxCostUsd?: number;
    /** Custom model capability/pricing overrides. */
    modelCapabilities?: readonly ModelCapabilityRule[];
    /** An open trace: effects are recorded and replayed. */
    trace?: Trace;
    /** Answers `human()` and agent questions. Defaults to reading a line from stdin. */
    human?: HumanHandler;
}

async function promptHuman(question: string): Promise<string> {
    const input = createInterface({ input: process.stdin, output: process.stderr, terminal: false });
    try {
        process.stderr.write(`${question}\n> `);
        for await (const line of input) return line;
        throw new Failure('runtime_error', 'cannot read human input: stdin ended');
    } finally {
        input.close();
    }
}

/** A runtime for library calls and compiled workflows that run outside the CLI. */
export function createRuntime(options: ConfigureOptions): Runtime {
    const level = options.logLevel ?? process.env.SPL_LOG_LEVEL ?? 'info';
    if (level !== 'silent' && level !== 'error' && level !== 'info' && level !== 'debug') throw new Failure('runtime_error', `invalid log level '${level}'`);
    const logger = options.logger ?? new Logger(level);
    const cwd = options.cwd ?? process.cwd();
    let inner: LlmBackend | undefined = options.backend;
    const load = async (): Promise<LlmBackend> => {
        if (!inner) {
            const { AiBackend } = await import('./ai.js');
            inner = new AiBackend({
                logger, cwd, timeoutMs: options.timeoutMs ?? 300_000,
                provider: options.provider,
                apiKey: options.apiKey,
                baseUrl: options.baseUrl,
                baseUrls: options.baseUrls,
                mcpServers: options.mcpServers,
                poolMcp: options.poolMcp,
                maxRetries: options.maxRetries,
                retryDelayMs: options.retryDelayMs,
                maxSteps: options.maxSteps,
                modelCapabilities: options.modelCapabilities,
            });
        }
        return inner;
    };
    // Provider SDKs load on the first model call, not on import.
    const backend: LlmBackend = {
        async call(request) {
            return (await load()).call(request);
        },
        async decide(request) {
            const loaded = await load();
            return loaded.decide ? loaded.decide(request) : null;
        },
        async close() { await inner?.close(); },
    };
    return new Runtime({
        backend, logger, cwd, defaultModel: options.model, args: options.args,
        maxSteps: options.maxSteps,
        maxTotalTokens: options.maxTotalTokens,
        maxCostUsd: options.maxCostUsd,
        trace: options.trace, human: options.human ?? promptHuman,
    });
}

ambientFactory((): Context => createRuntime({}).root);

/**
 * Sets up the runtime used by library calls outside a workflow: model, provider, logging,
 * working directory and more. Returns the runtime; call `close()` on its backend when done.
 */
export function configure(options: ConfigureOptions = {}): Runtime {
    const runtime = createRuntime(options);
    setAmbient(runtime.root);
    return runtime;
}
