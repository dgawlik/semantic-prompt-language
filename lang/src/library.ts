import { createInterface } from 'node:readline';
import { Failure, SuccessSignal } from './errors.js';
import type { LlmBackend } from './llm.js';
import { Logger, type LogLevel } from './logger.js';
import * as markdownLibrary from './markdown-lib.js';
import { generateFunctions } from './natural.js';
import type { RestrictKind } from './restrict.js';
import {
    Runtime, ambientFactory, currentContext, display, runInContext, setAmbient,
    type Context, type GenerateOptions, type GenerationKind, type HumanHandler,
} from './runtime.js';
import type { Trace } from './trace.js';
import {
    any, bool, char, enumOf, float, fn, int, jsonSchema, list, nil, nullable, object, str, struct, t, typedef, union, validate,
    type JsonSchema, type Type,
} from './types.js';
import { Workspace } from './workspace.js';
import type { McpServers } from './mcp.js';
import type { Provider } from './auth.js';

export {
    any, bool, char, enumOf, float, fn, int, jsonSchema, list, nil, nullable, object, str, struct, t, typedef, union, validate,
};
export { Failure } from './errors.js';
export { markdownLibrary as markdown };

type Awaitable<T> = T | Promise<T>;

/** What a generation call resolves to, given its options. */
export type GenerationResult<O> =
    O extends { schema: Type<infer T> } ? T
    : O extends { schema: JsonSchema } ? unknown
    : O extends { fmt: 'integer' | 'float' } ? number
    : O extends { fmt: 'boolean' } ? boolean
    : O extends { fmt: 'array' } ? unknown[]
    : O extends { fmt: 'object' } ? Record<string, unknown>
    : O extends { fmt: 'json' } ? unknown
    : string;

export type AskOptions = GenerateOptions;
export type ThinkOptions = Omit<GenerateOptions, 'seed' | 'temperature' | 'topP'>;
export type AgentOptions = Omit<ThinkOptions, 'repairs'>;

export interface CodegenOptions {
    model?: string;
    reasoning?: 'low' | 'medium' | 'high';
}

/** `fs` when given a string or list; otherwise one entry per kind. */
export type RestrictSpec = string | readonly string[] | Partial<Record<RestrictKind, string | readonly string[]>>;

const runtimeError = (message: string): Failure => new Failure('runtime_error', message);
const template = (value: unknown): value is TemplateStringsArray =>
    Array.isArray(value) && Array.isArray((value as unknown as TemplateStringsArray).raw);

/** Gives a failure its workflow line while the call stack still shows it, so `catch` blocks can read `error.line`. */
function located<T>(context: Context, work: Promise<T>): Promise<T> {
    return work.catch(error => {
        if (error instanceof Failure) context.runtime.failure(error);
        throw error;
    });
}

function generate(kind: GenerationKind, prompt: unknown, rest: unknown[]): Promise<unknown> {
    const context = currentContext();
    if (template(prompt)) {
        const text = prompt.reduce((out, part, index) => out + part + (index < rest.length ? display(rest[index]) : ''), '');
        return located(context, context.runtime.generate(kind, text, undefined, context));
    }
    if (rest.length > 1) return Promise.reject(runtimeError(`${kind}() takes a prompt and one options object`));
    return located(context, context.runtime.generate(kind, prompt, rest[0] as GenerateOptions | undefined, context));
}

/**
 * Asks the model for a value. Without options the answer is trimmed text; `fmt` and `schema`
 * parse and check it. The model has no tools.
 *
 *     const title = await ask(`Suggest a title for: ${draft}`);
 *     const triage = await ask(`Classify: ${issue}`, { schema: Triage, repairs: 2 });
 */
export function ask(strings: TemplateStringsArray, ...values: unknown[]): Promise<string>;
export function ask(prompt: string): Promise<string>;
export function ask<const O extends AskOptions>(prompt: string, options: O): Promise<GenerationResult<O>>;
export function ask(prompt: unknown, ...rest: unknown[]): Promise<unknown> {
    return generate('ask', prompt, rest);
}

/** Like `ask`, with medium reasoning by default. */
export function think(strings: TemplateStringsArray, ...values: unknown[]): Promise<string>;
export function think(prompt: string): Promise<string>;
export function think<const O extends ThinkOptions>(prompt: string, options: O): Promise<GenerationResult<O>>;
export function think(prompt: unknown, ...rest: unknown[]): Promise<unknown> {
    return generate('think', prompt, rest);
}

/** Lets the model act with the runtime tools and configured MCP servers, within active restrictions. */
export function agent(strings: TemplateStringsArray, ...values: unknown[]): Promise<string>;
export function agent(prompt: string): Promise<string>;
export function agent<const O extends AgentOptions>(prompt: string, options: O): Promise<GenerationResult<O>>;
export function agent(prompt: unknown, ...rest: unknown[]): Promise<unknown> {
    return generate('agent', prompt, rest);
}

/** Asks a person and resolves to their answer. */
export function human(question: string): Promise<string> {
    const context = currentContext();
    return located(context, context.runtime.human(question, context.runtime.callerLine(context)));
}

function guidance<T>(kind: 'enforce' | 'forbid', text: string | readonly string[], body: () => T): T {
    const items = typeof text === 'string' ? [text] : text;
    if (!Array.isArray(items) || !items.length || items.some(item => typeof item !== 'string' || !item.trim())) {
        throw runtimeError(`${kind}() requires guidance text or a list of texts`);
    }
    if (typeof body !== 'function') throw runtimeError(`${kind}() requires a function to run with the guidance, such as () => ask(...)`);
    const context = currentContext();
    return runInContext({ ...context, constraints: [...context.constraints, ...items.map(item => ({ kind, text: item }))] }, body);
}

/** Adds an instruction to every model call made inside `body`. Guidance shapes prompts; it does not check answers. */
export function enforce<T>(text: string | readonly string[], body: () => T): T {
    return guidance('enforce', text, body);
}

/** Tells every model call inside `body` what to avoid. Guidance shapes prompts; it does not check answers. */
export function forbid<T>(text: string | readonly string[], body: () => T): T {
    return guidance('forbid', text, body);
}

/**
 * Limits what tools and agents may touch inside `body`. Nested restrictions of one kind intersect.
 *
 *     await restrict({ fs: './src', exec: ['npm', 'git'] }, () => agent('Run the tests'));
 */
export async function restrict<T>(spec: RestrictSpec, body: () => Awaitable<T>): Promise<T> {
    if (typeof body !== 'function') throw runtimeError('restrict() requires a function to run inside the restriction, such as () => agent(...)');
    const context = currentContext();
    const entries: [string, unknown][] = typeof spec === 'string' || Array.isArray(spec) ? [['fs', spec]]
        : typeof spec === 'object' && spec !== null ? Object.entries(spec) : [];
    if (!entries.length) throw runtimeError("restrict() requires a folder or an object such as { fs: './out', exec: 'git' }");
    let restrictions = context.restrictions;
    for (const [kind, value] of entries) {
        if (kind !== 'fs' && kind !== 'exec' && kind !== 'net' && kind !== 'mcp') throw runtimeError(`unknown restriction kind '${kind}'; use fs, exec, net or mcp`);
        restrictions = restrictions.with(await context.runtime.restriction(kind, value));
    }
    return runInContext({ ...context, restrictions }, body);
}

/** Ends the document with a result. */
export function success(value?: unknown): never {
    throw new SuccessSignal(value === undefined ? null : value);
}

/** Ends the document with an `explicit_failure`, unless caught. */
export function fail(reason: unknown = 'failed'): never {
    throw currentContext().runtime.failure(new Failure('explicit_failure', display(reason)));
}

/** Raises `assertion_failed` when the condition is falsy. */
export function assert(condition: unknown, message: unknown = 'assertion failed'): asserts condition {
    if (!condition) throw currentContext().runtime.failure(new Failure('assertion_failed', display(message)));
}

interface Log {
    (...values: unknown[]): void;
    info(...values: unknown[]): void;
    error(...values: unknown[]): void;
    debug(...values: unknown[]): void;
}

const logAt = (level: LogLevel) => (...values: unknown[]): void => currentContext().runtime.log(level, values);
/** Writes to the run log (stderr in the CLI) at info level; `log.error` and `log.debug` select other levels. */
export const log: Log = Object.assign(logAt('info'), { info: logAt('info'), error: logAt('error'), debug: logAt('debug') });

const tool = (name: 'read_file' | 'write_file' | 'web_fetch' | 'web_search' | 'shell', args: unknown[]): Promise<string> => {
    const context = currentContext();
    return located(context, context.runtime.tool(name, args, context));
};

/** Reads a UTF-8 text file, subject to `restrict`. */
export function readFile(path: string): Promise<string> { return tool('read_file', [path]); }
/** Creates or overwrites a UTF-8 text file (parent folders are created), subject to `restrict`. */
export function writeFile(path: string, content: string): Promise<string> { return tool('write_file', [path, content]); }
/** Fetches an http(s) URL with GET and resolves to the body text, subject to `restrict`. */
export function webFetch(url: string): Promise<string> { return tool('web_fetch', [url]); }
/** Searches the web and resolves to the top results as text, subject to `restrict`. */
export function webSearch(query: string): Promise<string> { return tool('web_search', [query]); }
/** Runs a shell command and resolves to its combined output, subject to `restrict`. */
export function shell(command: string): Promise<string> { return tool('shell', [command]); }

/**
 * Generates a JavaScript function from a description and resolves to it. In a workflow the
 * function (and any helpers) is also defined in the shared scope for later steps.
 *
 *     const sieve = await codegen('sieve(n): primes up to n, using the sieve of Eratosthenes');
 */
export function codegen<F extends (...args: any[]) => unknown = (...args: any[]) => unknown>(description: string, options: CodegenOptions = {}): Promise<F> {
    const context = currentContext();
    const controls = options.model !== undefined || options.reasoning !== undefined
        ? { ...(options.model !== undefined ? { model: options.model } : {}), ...(options.reasoning !== undefined ? { reasoning: options.reasoning } : {}) }
        : undefined;
    return generateFunctions(description, context.runtime.callerLine(context), controls, workspaceOf(context.runtime), context) as Promise<F>;
}

/** Script arguments (`--arg` in the CLI). Missing entries are `undefined`. */
export const args: readonly string[] = new Proxy([] as string[], {
    get: (_, key) => Reflect.get(currentContext().runtime.args, key),
    has: (_, key) => Reflect.has(currentContext().runtime.args, key),
    ownKeys: () => Reflect.ownKeys(currentContext().runtime.args),
    getOwnPropertyDescriptor: (_, key) => {
        // Proxy invariants: describe entries relative to the empty, writable target array.
        const descriptor = Reflect.getOwnPropertyDescriptor(currentContext().runtime.args, key);
        return descriptor && { ...descriptor, writable: true, configurable: key !== 'length' };
    },
});

/** Read-only environment variables. Missing names are `undefined`. */
export const env: Readonly<Record<string, string | undefined>> = new Proxy({} as Record<string, string>, {
    get: (_, key) => Reflect.get(currentContext().runtime.env, key),
    has: (_, key) => Reflect.has(currentContext().runtime.env, key),
    ownKeys: () => Reflect.ownKeys(currentContext().runtime.env),
    getOwnPropertyDescriptor: (_, key) => {
        const descriptor = Reflect.getOwnPropertyDescriptor(currentContext().runtime.env, key);
        return descriptor ? { ...descriptor, configurable: true } : descriptor;
    },
});

// ---- the shared scope behind each runtime ---------------------------------

const workspaces = new WeakMap<Runtime, Workspace>();

/** Everything a fence can use without importing it. */
export function library(): Record<string, unknown> {
    return {
        ask, think, agent, human, enforce, forbid, restrict, success, fail, assert, log, codegen,
        readFile, writeFile, webFetch, webSearch, shell, args, env, validate, markdown: markdownLibrary, Failure,
        t, str, int, float, bool, char, nil, any, object, fn, list, union, nullable, enumOf, struct, typedef, jsonSchema,
    };
}

export function attachWorkspace(runtime: Runtime, workspace: Workspace): void {
    workspaces.set(runtime, workspace);
}

export function workspaceOf(runtime: Runtime): Workspace {
    let workspace = workspaces.get(runtime);
    if (!workspace) {
        workspace = new Workspace(library());
        workspace.bind(runtime);
        workspaces.set(runtime, workspace);
    }
    return workspace;
}

// ---- the default runtime for plain Node.js programs -------------------------

export interface ConfigureOptions {
    /** Default model for calls that do not name one. */
    model?: string;
    provider?: Provider;
    cwd?: string;
    args?: readonly string[];
    /** `silent`, `error`, `info` (default) or `debug`. */
    logLevel?: LogLevel | 'silent';
    logger?: Logger;
    /** Replace the provider clients, for example with a test double. */
    backend?: LlmBackend;
    timeoutMs?: number;
    mcpServers?: McpServers;
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
        throw runtimeError('cannot read human input: stdin ended');
    } finally {
        input.close();
    }
}

function createRuntime(options: ConfigureOptions): Runtime {
    const level = options.logLevel ?? process.env.SPL_LOG_LEVEL ?? 'info';
    if (level !== 'silent' && level !== 'error' && level !== 'info' && level !== 'debug') throw runtimeError(`invalid log level '${level}'`);
    const logger = options.logger ?? new Logger(level);
    const cwd = options.cwd ?? process.cwd();
    let inner: LlmBackend | undefined = options.backend;
    // Provider SDKs load on the first model call, not on import.
    const backend: LlmBackend = {
        async call(request) {
            if (!inner) {
                const { AiBackend } = await import('./ai.js');
                inner = new AiBackend({
                    logger, cwd, timeoutMs: options.timeoutMs ?? 300_000,
                    provider: options.provider, mcpServers: options.mcpServers,
                });
            }
            return inner.call(request);
        },
        async close() { await inner?.close(); },
    };
    return new Runtime({
        backend, logger, cwd, defaultModel: options.model, args: options.args,
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
