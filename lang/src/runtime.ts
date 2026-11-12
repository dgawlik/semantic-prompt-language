import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { inspect } from 'node:util';
import { Failure, SuccessSignal } from './errors.js';
import {
    LlmError, buildPromptParts, parseJsonResponse, validateRandomness, validateTokens,
    type AskMods, type Constraint, type LlmBackend, type LlmRequest, type LlmResponse, type ReasoningLevel,
} from './llm.js';
import type { ModelInteraction } from './log-events.js';
import type { Logger, LogLevel } from './logger.js';
import { Pin, PinError } from './pin.js';
import { RUNTIME_PREAMBLE } from './preamble.js';
import { isResponse, isToolValue, traceRequest } from './recording.js';
import { Restrictions, makeRestriction, type Restriction, type RestrictKind } from './restrict.js';
import { compileSchema } from './schema.js';
import { TOOL_SPECS, ToolHost, type ToolName } from './tools.js';
import { TraceError, type Trace } from './trace.js';
import { isType, type JsonSchema, type Type } from './types.js';

export type HumanHandler = (question: string, line: number) => string | Promise<string>;
export type GenerationKind = 'ask' | 'think' | 'agent';

export interface GenerateOptions {
    /** Length hint for the model; guidance only. */
    len?: AskMods['len'];
    /** Parse and check the answer. */
    fmt?: AskMods['fmt'];
    /** A type from the builder, or raw JSON Schema. Implies JSON output. */
    schema?: Type<unknown> | JsonSchema;
    /** Extra attempts after a format or schema error: 0 to 5. */
    repairs?: number;
    reasoning?: ReasoningLevel;
    /** Hide reasoning in logs; responses stay visible. */
    hide?: boolean;
    model?: string;
    /** Maximum generated tokens per model turn, including reasoning. */
    tokens?: number;
    /** `ask` only. */
    seed?: number;
    /** `ask` only. */
    temperature?: number;
    /** `ask` only. */
    topP?: number;
}

export interface RuntimeOptions {
    backend: LlmBackend;
    logger: Logger;
    /** Working directory for imports, relative paths, restrictions and tools. */
    cwd?: string;
    /** Overrides every other model choice, like the CLI `--model`. */
    model?: string;
    /** The document model from frontmatter; per-call models take precedence. */
    defaultModel?: string;
    /** Script arguments exposed as the read-only `args`. */
    args?: readonly string[];
    trace?: Trace;
    pin?: Pin;
    human?: HumanHandler;
    /** Markdown workflows prefix every prompt with the runtime preamble and this text. */
    markdown?: { preamble?: string };
    /** Workflow file or URI: names generated-code caches and locates failures. */
    source?: string;
    /** Sources already known to an interactive session, so old closures still locate their failures. */
    sources?: Map<string, SourceInfo>;
}

export interface SourceInfo {
    lines: readonly string[];
    uri?: string;
    version?: number;
}

/** The dynamic scope of a call: which runtime, which restrictions and which guidance apply. */
export interface Context {
    runtime: Runtime;
    restrictions: Restrictions;
    constraints: readonly Constraint[];
    /** Document line of the running blockquote, used when a failure has no code location. */
    line?: number;
}

interface Shared {
    storage: AsyncLocalStorage<Context>;
    ambient?: Context;
    factory?: () => Context;
}

// One store per process, even if a helper module loads a second copy of the package.
const SHARED = Symbol.for('spl-lang.runtime');
const holder = globalThis as { [SHARED]?: Shared };
const shared: Shared = holder[SHARED] ??= { storage: new AsyncLocalStorage<Context>() };

/** Registers how to build the default runtime used outside workflows. */
export function ambientFactory(factory: () => Context): void {
    shared.factory ??= factory;
}

export function setAmbient(context: Context | undefined): void {
    shared.ambient = context;
}

export function currentContext(): Context {
    const active = shared.storage.getStore();
    if (active) return active;
    if (!shared.ambient) {
        if (!shared.factory) throw new Failure('runtime_error', 'no SPL runtime is active');
        shared.ambient = shared.factory();
    }
    return shared.ambient;
}

export function runInContext<T>(context: Context, body: () => T): T {
    return shared.storage.run(context, body);
}

const GENERATION_OPTIONS = ['len', 'fmt', 'schema', 'repairs', 'reasoning', 'hide', 'model', 'tokens', 'seed', 'temperature', 'topP', 'top_p'];
const runtimeError = (message: string): Failure => new Failure('runtime_error', message);
const control = (error: unknown): boolean =>
    error instanceof TraceError || error instanceof PinError || error instanceof SuccessSignal;

/** Text form used when a value is interpolated into a prompt. */
export function display(value: unknown): string {
    if (typeof value === 'string') return value;
    if (value === null || value === undefined || typeof value !== 'object' && typeof value !== 'function') return String(value);
    if (isType(value)) return value.name;
    if (typeof value === 'function') return `[function ${value.name || 'anonymous'}]`;
    try {
        const json = JSON.stringify(value);
        if (json !== undefined) return json;
    } catch (error) {
        if (!(error instanceof TypeError)) throw error;
    }
    return inspect(value, { depth: 4, breakLength: Infinity });
}

/** JSON-shaped copy for logs and model context: never throws, never exposes function bodies. */
export function describeValue(value: unknown): unknown {
    const visiting = new Set<object>();
    const describe = (value: unknown): unknown => {
        if (value === undefined) return null;
        if (typeof value === 'bigint') return `${value}n`;
        if (typeof value === 'symbol') return String(value);
        if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
        if (typeof value === 'function') return signature(value);
        if (typeof value !== 'object' || value === null) return value;
        if (isType(value)) return `<type ${value.name}>`;
        if (value instanceof Date) return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString();
        if (value instanceof Error) return `<${value.name} ${value.message}>`;
        if (visiting.has(value)) return '<circular reference>';
        visiting.add(value);
        try {
            if (Array.isArray(value)) return value.map(describe);
            if (value instanceof Map) return Object.fromEntries([...value].map(([key, item]) => [String(key), describe(item)]));
            if (value instanceof Set) return [...value].map(describe);
            const fields = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, describe(item)]));
            const prototype = Object.getPrototypeOf(value);
            if (prototype === Object.prototype || prototype === null) return fields;
            const name = prototype.constructor?.name;
            return name && name !== 'Object' ? { class: name, fields } : fields;
        } finally {
            visiting.delete(value);
        }
    };
    return describe(value);
}

/** `function name(a, b)` without the body; classes show as `class Name`. */
export function signature(fn: Function): string {
    const source = Function.prototype.toString.call(fn);
    if (/^class\b/.test(source)) return `class ${fn.name || 'anonymous'}`;
    const asynchronous = /^async\b/.test(source);
    const rest = source.replace(/^async\s*/, '');
    let params: string | undefined;
    const bare = /^([A-Za-z_$][\w$]*)\s*=>/.exec(rest);
    if (bare) params = `(${bare[1]})`;
    else {
        // Balanced scan: default values may contain parentheses of their own.
        const open = rest.indexOf('(');
        if (open >= 0 && /^(?:function\b\s*\*?\s*)?[\w$]*\s*$/.test(rest.slice(0, open))) {
            let depth = 0;
            for (let index = open; index < rest.length; index++) {
                if (rest[index] === '(') depth++;
                else if (rest[index] === ')' && --depth === 0) {
                    params = rest.slice(open, index + 1);
                    break;
                }
            }
        }
    }
    params ??= `(${Array.from({ length: fn.length }, (_, index) => `arg${index + 1}`).join(', ')})`;
    return `${asynchronous ? 'async ' : ''}function ${fn.name || 'anonymous'}${params.replace(/\s+/g, ' ')}`;
}

export class Runtime {
    readonly cwd: string;
    readonly args: readonly string[];
    readonly logger: Logger;
    readonly backend: LlmBackend;
    readonly trace?: Trace;
    readonly pin?: Pin;
    /** Read-only environment; the first access is recorded for deterministic replay. */
    readonly env: Readonly<Record<string, string>>;
    /** Sources that may appear in stack traces, by the file name given to the engine. */
    readonly sources: Map<string, SourceInfo>;
    readonly root: Context;
    readonly source?: string;
    private readonly environment: Readonly<Record<string, string>>;
    private readonly model?: string;
    private readonly defaultModel?: string;
    private readonly markdown?: { preamble?: string };
    private readonly humanHandler?: HumanHandler;
    private pending: Promise<void> = Promise.resolve();

    constructor(options: RuntimeOptions) {
        this.logger = options.logger;
        this.backend = options.backend;
        this.trace = options.trace;
        this.pin = options.pin;
        this.cwd = options.pin?.data.context.cwd ?? options.cwd ?? process.cwd();
        this.model = options.pin?.data.context.model ?? options.model;
        this.defaultModel = options.defaultModel;
        this.markdown = options.markdown;
        this.humanHandler = options.human;
        this.source = options.source;
        this.sources = options.sources ?? new Map();
        const source = options.pin?.replaying ? options.pin.data.environment ?? {} : options.trace?.environment ?? process.env;
        const environment: Record<string, string> = {};
        for (const [name, value] of Object.entries(source)) {
            if (value !== undefined) Object.defineProperty(environment, name, { value, enumerable: true });
        }
        this.environment = Object.freeze(environment);
        const observe = (): void => {
            this.trace?.observeEnvironment(this.environment);
            this.pin?.observeEnvironment(this.environment);
        };
        this.env = new Proxy(this.environment, {
            get: (target, key, receiver) => { observe(); return Reflect.get(target, key, receiver); },
            has: (target, key) => { observe(); return Reflect.has(target, key); },
            ownKeys: target => { observe(); return Reflect.ownKeys(target); },
            getOwnPropertyDescriptor: (target, key) => { observe(); return Reflect.getOwnPropertyDescriptor(target, key); },
        });
        this.args = Object.freeze([...(options.pin?.data.context.args ?? options.trace?.args ?? options.args ?? [])]);
        this.root = { runtime: this, restrictions: new Restrictions(this.cwd), constraints: [] };
    }

    get journal(): Trace | Pin | undefined { return this.trace ?? this.pin; }
    get replaying(): boolean { return Boolean(this.trace?.replaying); }

    /** Runs a body with this runtime as the current one. */
    run<T>(body: () => T, context: Context = this.root): T {
        return runInContext(context, body);
    }

    /**
     * Records an external effect in the trace or pin, or just performs it. Journaled effects run one
     * at a time in call order, so concurrent calls such as `Promise.all(items.map(item => ask(...)))`
     * still produce a journal that replays deterministically.
     */
    effect<T>(request: unknown, perform: () => T | Promise<T>, valid: (value: unknown) => value is T): Promise<T> {
        const journal = this.journal;
        if (!journal) return Promise.resolve().then(perform);
        const result = this.pending.then(() => journal.effect(request, perform, valid));
        this.pending = result.then(() => undefined, () => undefined);
        return result;
    }

    // ---- source locations ------------------------------------------------

    /** Finds the innermost workflow frame of an error, so failures name the line that caused them. */
    locate(error: unknown): { line: number; command: string; uri?: string; version?: number } | undefined {
        const stack = error instanceof Error ? error.stack : undefined;
        if (!stack || !this.sources.size) return undefined;
        for (const frame of stack.split('\n')) {
            for (const [file, info] of this.sources) {
                const at = frame.indexOf(file);
                if (at < 0) continue;
                const position = /^:(\d+):\d+\)?\s*$/.exec(frame.slice(at + file.length));
                if (!position) continue;
                const line = Number(position[1]);
                return { line, command: (info.lines[line - 1] ?? '').trim(), uri: info.uri, version: info.version };
            }
        }
        return undefined;
    }

    /** Line of the workflow code that called into the library, or the running blockquote. */
    callerLine(context: Context): number {
        return this.locate(new Error())?.line ?? context.line ?? 0;
    }

    /** Turns anything thrown by workflow code into a located failure. */
    failure(error: unknown, fallback?: { line: number; command: string; uri?: string; version?: number }): Failure {
        const failure = error instanceof Failure ? error
            : new Failure('runtime_error', error instanceof Error ? `${error.name}: ${error.message}` : `uncaught value: ${display(error)}`);
        if (!failure.located) {
            const location = this.locate(error) ?? this.locate(failure) ?? fallback;
            if (location) failure.locate(location.line, location.command, location.uri, location.version);
        }
        return failure;
    }

    // ---- logging ---------------------------------------------------------

    log(level: LogLevel, values: readonly unknown[]): void {
        if (this.replaying) return;
        this.logger[level]('log:', ...values.map(value =>
            typeof value === 'object' && value !== null && !isType(value) ? describeValue(value) : display(value)));
    }

    // ---- environment -----------------------------------------------------

    async environmentValue(name: string): Promise<string | null> {
        this.pin?.observeEnvironment(this.environment);
        const perform = (): string | null => Object.hasOwn(this.environment, name) ? this.environment[name] : null;
        return this.trace
            ? this.effect({ kind: 'environment-value', name }, perform, (value): value is string | null => value === null || typeof value === 'string')
            : perform();
    }

    // ---- human input -----------------------------------------------------

    async human(question: unknown, line: number): Promise<string> {
        if (typeof question !== 'string') throw runtimeError('human question must be a string');
        // Without a handler nothing can answer: fail before the journal records an unanswerable question.
        if (!this.humanHandler && !this.trace?.replaying && !this.pin?.replaying) throw runtimeError('human input requires a human handler');
        const direct = async (): Promise<string> => {
            if (!this.humanHandler) throw runtimeError('human input requires a human handler');
            const answer = await this.humanHandler(question, line);
            if (typeof answer !== 'string') throw runtimeError('human answer must be a string');
            return answer;
        };
        return this.journal
            ? this.effect({ kind: 'human', question, line }, direct, (value): value is string => typeof value === 'string')
            : direct();
    }

    // ---- tools and restrictions -------------------------------------------

    async tool(tool: ToolName, args: readonly unknown[], context: Context): Promise<string> {
        const names = TOOL_SPECS[tool].required;
        if (args.length !== names.length) throw runtimeError(`${tool}() takes ${names.length} argument(s) but ${args.length} were given`);
        const params: Record<string, string> = {};
        names.forEach((name, index) => {
            const value = args[index];
            if (typeof value !== 'string') throw runtimeError(`${tool}(): ${name} must be a string`);
            params[name] = value;
        });
        const perform = (): Promise<string> => new ToolHost(context.restrictions, this.cwd, false, true).invoke(tool, params);
        return this.journal
            ? this.effect({ kind: 'tool', tool, params, restrictions: context.restrictions.list }, perform, (value): value is string => typeof value === 'string')
            : perform();
    }

    async restriction(kind: RestrictKind, value: unknown): Promise<Restriction> {
        const perform = (): Restriction => makeRestriction(kind, value, this.cwd);
        return this.journal
            ? this.effect({ kind: 'restriction', restriction: kind, value }, perform,
                (result): result is Restriction => typeof result === 'object' && result !== null && !Array.isArray(result)
                    && (result as Restriction).kind === kind && Array.isArray((result as Restriction).values)
                    && (result as Restriction).values.every(item => typeof item === 'string'))
            : perform();
    }

    // ---- models ----------------------------------------------------------

    /** CLI `--model`, then the per-call model, then the document model, then the provider default. */
    resolveModel(model?: string): string | undefined {
        return this.model ?? model ?? this.defaultModel;
    }

    async callModel(
        req: LlmRequest,
        interaction: ModelInteraction = { requestId: randomUUID(), kind: req.naturalLanguage ? 'blockquote' : req.kind },
        preface = '', record = true,
    ): Promise<LlmResponse> {
        const { logger, backend } = this;
        if (this.markdown) {
            preface = [RUNTIME_PREAMBLE, this.markdown.preamble, preface].filter(Boolean).join('\n\n');
            req = { ...req, prompt: [RUNTIME_PREAMBLE, this.markdown.preamble, req.prompt].filter(Boolean).join('\n\n') };
        }
        const replaying = this.replaying;
        if (!replaying) logger.modelPrompt(interaction, req.prompt, preface);
        const originalStream = req.onStream;
        let receiving = true;
        if (!replaying && (logger.streamsModels || originalStream)) {
            const showReasoning = req.showReasoning;
            req = { ...req, onStream: update => {
                if (!receiving) return;
                originalStream?.(update);
                if (update.channel !== 'reasoning' || showReasoning) logger.modelStream({ type: 'update', interaction, update });
            } };
        }
        let completed = false;
        const started = Date.now();
        try {
            const perform = async (): Promise<LlmResponse> => {
                try {
                    return await backend.call(req);
                } catch (error) {
                    if (error instanceof Failure || control(error)) throw error;
                    throw new Failure('llm_error', error instanceof Error ? error.message : String(error));
                }
            };
            const res = this.journal && !req.naturalLanguage && record
                ? await this.effect({ kind: 'llm', request: traceRequest(req), restrictions: req.restrictions.list }, perform, isResponse)
                : await perform();
            if (!isResponse(res)) throw new Failure('llm_error', 'backend returned an invalid response; blockquotes require runtime actions, not submitted code');
            if (!replaying) {
                receiving = false;
                logger.modelStream({ type: 'end', interaction, outcome: 'completed', response: res.text,
                    ...(req.showReasoning && res.reasoning !== undefined ? { reasoning: res.reasoning } : {}) });
                completed = true;
                logger.info(`llm ${req.kind} call: ${JSON.stringify(res.effective)} (${Date.now() - started} ms)`);
                logger.modelOutput({ ...interaction, role: 'response' }, res.text);
            }
            return res;
        } catch (error) {
            if (control(error) || error instanceof Failure) throw error;
            if (error instanceof LlmError) throw new Failure('llm_error', error.message);
            throw new Failure('llm_error', error instanceof Error ? error.message : String(error));
        } finally {
            receiving = false;
            if (!replaying && !completed) logger.modelStream({ type: 'end', interaction, outcome: 'failed' });
        }
    }

    /** `ask`, `think` and `agent`: one fresh conversation, optional format/schema checks and repairs. */
    async generate(kind: GenerationKind, prompt: unknown, options: GenerateOptions | undefined, context: Context): Promise<unknown> {
        if (options !== undefined && (typeof options !== 'object' || options === null || Array.isArray(options) || isType(options))) {
            throw runtimeError(`${kind}() options must be an object such as { schema: Invoice, repairs: 1 }`);
        }
        const given: Record<string, unknown> = { ...options };
        for (const name of Object.keys(given)) {
            if (!GENERATION_OPTIONS.includes(name)) throw runtimeError(`unknown ${kind}() option '${name}'`);
            if (given[name] === undefined) delete given[name];
        }
        if ('top_p' in given) {
            if ('topP' in given) throw runtimeError('use either topP or top_p, not both');
            given.topP = given.top_p;
            delete given.top_p;
        }
        const sampling = {
            ...('seed' in given ? { seed: given.seed } : {}),
            ...('temperature' in given ? { temperature: given.temperature } : {}),
            ...('topP' in given ? { top_p: given.topP } : {}),
        };
        if (kind !== 'ask' && Object.keys(sampling).length) throw runtimeError(`seed, temperature and topP are exclusive to ask(); ${kind}() does not accept them`);
        const randomness = Object.keys(sampling).length ? validateRandomness(sampling) : undefined;
        const { len, hide = false, repairs = 0, model } = given;
        const reasoning = given.reasoning ?? (kind === 'ask' ? undefined : 'medium');
        const tokens = 'tokens' in given ? validateTokens(given.tokens) : undefined;
        const fmt = given.fmt ?? ('schema' in given ? 'json' : 'text');
        if (len !== undefined && len !== 'word' && len !== 'sentence' && len !== 'paragraph' && len !== 'long') throw runtimeError('len must be word, sentence, paragraph, or long');
        if (fmt !== 'integer' && fmt !== 'float' && fmt !== 'array' && fmt !== 'object' && fmt !== 'text' && fmt !== 'boolean' && fmt !== 'json') {
            throw runtimeError('fmt must be integer, float, array, object, text, boolean, or json');
        }
        if (reasoning !== undefined && reasoning !== 'low' && reasoning !== 'medium' && reasoning !== 'high') throw runtimeError('reasoning must be low, medium, or high');
        if (typeof hide !== 'boolean') throw runtimeError('hide must be true or false');
        if (model !== undefined && (typeof model !== 'string' || !model.trim())) throw runtimeError('model must be a non-empty string');
        if (typeof repairs !== 'number' || !Number.isInteger(repairs) || repairs < 0 || repairs > 5) throw runtimeError('repairs must be an integer from 0 to 5');
        if (kind === 'agent' && repairs !== 0) throw runtimeError('agents cannot use repairs: external actions must not be retried automatically');
        if (fmt === 'text' && ('schema' in given || repairs !== 0)) throw runtimeError('schema and repairs require JSON output');
        const target = isType(given.schema) ? given.schema : undefined;
        const schema = target ? target.schema() : given.schema;
        const validate = 'schema' in given && !target ? compileSchema(schema) : undefined;
        const built = buildPromptParts({
            prompt: display(prompt),
            mods: { len, fmt },
            thinking: reasoning !== undefined,
            constraints: context.constraints,
            restrictions: context.restrictions,
        });
        let text = built.prompt;
        if (fmt === 'json') text += '\n\nReturn ONLY valid JSON, without prose or code fences.';
        if ('schema' in given) text += `\n\nThe result must satisfy this JSON Schema:\n${JSON.stringify(schema)}`;
        const base = text;
        for (let attempt = 0; ; attempt++) {
            const response = (await this.callModel({
                kind, prompt: text,
                model: this.resolveModel(model),
                reasoningEffort: reasoning,
                ...(tokens !== undefined ? { tokens } : {}),
                ...(randomness !== undefined ? { randomness: { ...randomness } } : {}),
                showReasoning: !hide,
                restrictions: context.restrictions,
                tools: new ToolHost(context.restrictions, this.cwd),
            }, undefined, built.preface)).text.trim();
            try {
                if (fmt === 'text') return response;
                const value = parseJsonResponse(response, fmt);
                if (target) return target.parse(value);
                validate?.(value);
                return value;
            } catch (error) {
                if (!(error instanceof Failure) || (error.statusCode !== 'invalid_format' && error.statusCode !== 'validation_failed') || attempt >= repairs) throw error;
                if (!this.replaying) this.logger.info(`repair ${attempt + 1}/${repairs}: ${error.reason}`);
                text = `${base}\n\nPrevious response:\n${response}\n\nValidation failed: ${error.reason}\nReturn a corrected JSON value.`;
            }
        }
    }
}

export { isToolValue };
