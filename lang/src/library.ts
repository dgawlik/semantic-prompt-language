import * as fs from 'node:fs';
import * as path from 'node:path';
import { generateFunctions } from './codegen.js';
import { Failure, SuccessSignal } from './errors.js';
import { judge, type JudgeResult } from './judge.js';
import type { Attachment, CustomTool } from './llm.js';
import type { LogLevel } from './logger.js';
import * as markdownLibrary from './markdown-lib.js';
import type { RestrictKind } from './restrict.js';
import { activeContext, currentContext, display, runInContext, type Context, type CustomToolsMap, type DecisionOptions, type GenerateOptions, type GenerationKind } from './runtime.js';
import type { ToolName } from './tools.js';
import {
    Any, Bool, Char, Dict, Enum, Float, Fn, Int, JsonSchema, List, Nil, Nullable, Str, Struct, Typedef, Union, isType, t, validate,
    type Type,
} from './types.js';

export { Any, Bool, Char, Dict, Enum, Float, Fn, Int, JsonSchema, List, Nil, Nullable, Str, Struct, Typedef, Union, t, validate };
export { Failure } from './errors.js';
export { configure, type ConfigureOptions } from './configure.js';
export { judge, type JudgeResult };
export { markdownLibrary as markdown };
export type { Attachment, CustomTool, CustomToolsMap };

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

export type AskOptions = Omit<GenerateOptions, 'maxSteps' | 'tools' | 'builtinTools'>;
export type AgentOptions = Omit<GenerateOptions, 'seed' | 'temperature' | 'topP' | 'repairs'>;
export type CodegenOptions = Pick<GenerateOptions, 'model' | 'reasoning' | 'hide' | 'tokens'>;

export interface AttachOptions {
    mediaType?: string;
    kind?: 'image' | 'file';
    name?: string;
}

const MIME_BY_EXT: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.pdf': 'application/pdf',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.csv': 'text/csv',
    '.json': 'application/json',
    '.html': 'text/html',
    '.xml': 'application/xml',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
};

function inferMediaType(target: string): string | undefined {
    const clean = target.split(/[?#]/, 1)[0];
    return MIME_BY_EXT[path.extname(clean).toLowerCase()];
}

/**
 * Defines a typed custom tool for `agent(..., { tools: [...] })`.
 *
 *     const lookup = defineTool({
 *         name: 'lookupOrder',
 *         description: 'Look up an order by id',
 *         input: Struct('LookupInput', { id: Str }),
 *         execute: ({ id }) => orders[id] ?? null,
 *     });
 */
export function defineTool<I, O = unknown>(spec: CustomTool<I, O>): CustomTool<I, O> {
    if (!spec || typeof spec !== 'object') throw runtimeError('defineTool() requires a tool specification object');
    if (typeof spec.name !== 'string' || !/^[A-Za-z_][\w.-]*$/.test(spec.name)) {
        throw runtimeError(`defineTool(): invalid tool name '${String(spec.name)}'`);
    }
    if (typeof spec.description !== 'string' || !spec.description.trim()) {
        throw runtimeError(`defineTool('${spec.name}'): description must be a non-empty string`);
    }
    if (!isType(spec.input) && (typeof spec.input !== 'object' || spec.input === null || Array.isArray(spec.input))) {
        throw runtimeError(`defineTool('${spec.name}'): input must be a Type or JSON Schema object`);
    }
    if (typeof spec.execute !== 'function') {
        throw runtimeError(`defineTool('${spec.name}'): execute must be a function`);
    }
    return spec;
}

/**
 * Creates a multimodal `Attachment` from a local file path, `http(s):` URL, `data:` URL or raw bytes.
 * Local paths and URLs honor active `restrict` rules when called inside a workflow.
 */
export function attach(source: string | Uint8Array, options: AttachOptions = {}): Attachment {
    if (source instanceof Uint8Array) {
        const mediaType = options.mediaType?.trim();
        if (!mediaType) throw runtimeError('attach(bytes, { mediaType }) requires mediaType');
        const kind = options.kind ?? (mediaType.startsWith('image/') ? 'image' : 'file');
        return { kind, mediaType, data: source, ...(options.name ? { name: options.name } : {}) };
    }
    if (typeof source !== 'string' || !source.trim()) {
        throw runtimeError('attach() requires a file path, URL, data URL, or Uint8Array');
    }
    const context = activeContext();
    if (/^https?:\/\//i.test(source)) {
        context?.restrictions.checkUrl(source);
        const mediaType = options.mediaType?.trim() || inferMediaType(source) || (options.kind === 'image' ? 'image/png' : 'application/octet-stream');
        const kind = options.kind ?? (mediaType.startsWith('image/') ? 'image' : 'file');
        return { kind, mediaType, data: source, ...(options.name ? { name: options.name } : {}) };
    }
    const dataUrl = /^data:([^;,]+);base64,/i.exec(source);
    if (dataUrl) {
        const mediaType = options.mediaType?.trim() || dataUrl[1];
        const kind = options.kind ?? (mediaType.startsWith('image/') ? 'image' : 'file');
        return { kind, mediaType, data: source, ...(options.name ? { name: options.name } : {}) };
    }
    const resolved = context
        ? context.restrictions.checkPath(source, 'read')
        : path.resolve(process.cwd(), source);
    let data: Buffer;
    try {
        data = fs.readFileSync(resolved);
    } catch (error) {
        throw new Failure('tool_error', `attach '${source}': ${(error as Error).message}`);
    }
    const mediaType = options.mediaType?.trim() || inferMediaType(resolved) || 'application/octet-stream';
    const kind = options.kind ?? (mediaType.startsWith('image/') ? 'image' : 'file');
    return { kind, mediaType, data, name: options.name ?? path.basename(resolved) };
}

/** `fs` when given a string or list; otherwise one entry per kind. */
export type RestrictSpec = string | readonly string[] | Partial<Record<RestrictKind, string | readonly string[]>>;

const runtimeError = (message: string): Failure => new Failure('runtime_error', message);
const template = (value: unknown): value is TemplateStringsArray =>
    Array.isArray(value) && Array.isArray((value as unknown as TemplateStringsArray).raw);

/**
 * Gives a failure its workflow line, so `catch` blocks can read `error.line`. A failure raised later, in a
 * callback, has no workflow frame on its stack: the call site is remembered now.
 */
function located<T>(context: Context, work: Promise<T>): Promise<T> {
    const site = new Error();
    return work.catch(error => {
        if (error instanceof Failure) context.runtime.failure(error, context.runtime.locate(site));
        throw error;
    });
}

function trackArrange<T>(context: Context, work: Promise<T>): Promise<T> {
    if (context.evalScope?.phase === 'arrange') context.evalScope.pendingArrange.push(work);
    return work;
}

function generate(kind: GenerationKind, prompt: unknown, rest: unknown[]): Promise<unknown> {
    const context = currentContext();
    if (template(prompt)) {
        const text = prompt.reduce((out, part, index) => out + part + (index < rest.length ? display(rest[index]) : ''), '');
        return trackArrange(context, located(context, context.runtime.generate(kind, text, undefined, context)));
    }
    if (rest.length > 1) return Promise.reject(runtimeError(`${kind}() takes a prompt and one options object`));
    return trackArrange(context, located(context, context.runtime.generate(kind, prompt, rest[0] as GenerateOptions | undefined, context)));
}

/**
 * Asks the model for a value. Without options the answer is trimmed text; `fmt` and `schema`
 * parse and check it. The model has no tools. Reasoning is `medium` unless `reasoning` says otherwise.
 *
 *     const title = await ask(`Suggest a title for: ${draft}`);
 *     const triage = await ask(`Classify: ${issue}`, { schema: Triage, repairs: 2, reasoning: 'high' });
 */
export function ask(strings: TemplateStringsArray, ...values: unknown[]): Promise<string>;
export function ask(prompt: string): Promise<string>;
export function ask<const O extends AskOptions>(prompt: string, options: O): Promise<GenerationResult<O>>;
export function ask(prompt: unknown, ...rest: unknown[]): Promise<unknown> {
    return generate('ask', prompt, rest);
}

/** Lets the model act with the built-in tools and configured MCP servers, within active restrictions. */
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

export type { DecisionOptions };
type DecisionQuestion = Pick<DecisionOptions, 'question' | 'evidence' | 'model'>;

/**
 * Answers a question about the evidence with a boolean. OpenAI and Google use their decision endpoints
 * (`gpt-6-luna`, `gemini-decision-1`); Anthropic models simulate one.
 *
 *     if (await decision({ evidence: ['The color red is #ff0000'], question: `Is ${color} a shade of red?`, cutoff: 0.85 })) ...
 *     const urgent = await decision({ evidence: [ticket], question: 'How urgent is it?', labels: { now: true, today: true, later: false } });
 */
export function decision(options: DecisionQuestion & { cutoff?: number }): Promise<boolean>;
export function decision(options: DecisionQuestion & { labels: Readonly<Record<string, boolean>> }): Promise<boolean>;
export function decision(options: DecisionOptions): Promise<boolean> {
    const context = currentContext();
    return located(context, context.runtime.decision(options, context));
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

/** Ends the workflow with a result. */
export function success(value?: unknown): never {
    throw new SuccessSignal(value === undefined ? null : value);
}

/** Ends the workflow with an `explicit_failure`, unless caught. */
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

const tool = (name: ToolName, args: unknown[]): Promise<string> => {
    const context = currentContext();
    return located(context, context.runtime.tool(name, args, context));
};

/** Reads a UTF-8 text file, subject to `restrict`. */
export function readFile(path: string): Promise<string> { return tool('readFile', [path]); }
/** Creates or overwrites a UTF-8 text file (parent folders are created), subject to `restrict`. */
export function writeFile(path: string, content: string): Promise<string> { return tool('writeFile', [path, content]); }
/** Fetches an http(s) URL with GET and resolves to the body text, subject to `restrict`. */
export function webFetch(url: string): Promise<string> { return tool('webFetch', [url]); }
/** Searches the web and resolves to the top results as text, subject to `restrict`. */
export function webSearch(query: string): Promise<string> { return tool('webSearch', [query]); }
/** Runs a shell command and resolves to its combined output, subject to `restrict`. */
export function shell(command: string): Promise<string> { return tool('shell', [command]); }

/**
 * Generates a JavaScript function from a description and resolves to it. Inside a workflow the code
 * is cached beside the workflow file and reused on later runs.
 *
 *     const sieve = await codegen('sieve(n): primes up to n, using the sieve of Eratosthenes');
 */
export function codegen<F extends (...args: any[]) => unknown = (...args: any[]) => unknown>(description: string, options: CodegenOptions = {}): Promise<F> {
    const context = currentContext();
    const work = located(context, generateFunctions({
        text: description, line: context.runtime.callerLine(context), names: [], inputs: new Map(), ...options,
    }, context)).then(functions => Object.values(functions)[0] as F);
    return trackArrange(context, work);
}

/** Script arguments (`--arg` in the CLI). Missing entries are `undefined`. */
export const args: readonly string[] = new Proxy([] as string[], {
    get: (_, key) => Reflect.get(currentContext().args, key),
    has: (_, key) => Reflect.has(currentContext().args, key),
    ownKeys: () => Reflect.ownKeys(currentContext().args),
    getOwnPropertyDescriptor: (_, key) => {
        // Proxy invariants: describe entries relative to the empty, writable target array.
        const descriptor = Reflect.getOwnPropertyDescriptor(currentContext().args, key);
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

/** Everything a `.spl` file can use without importing it. */
export function library(): Record<string, unknown> {
    return {
        ask, agent, human, decision, enforce, forbid, restrict, success, fail, assert, log, codegen,
        defineTool, attach,
        readFile, writeFile, webFetch, webSearch, shell, args, env, validate, markdown: markdownLibrary, judge, Failure,
        t, Str, Int, Float, Bool, Char, Nil, Any, Dict, Fn, List, Union, Nullable, Enum, Struct, Typedef, JsonSchema,
    };
}
