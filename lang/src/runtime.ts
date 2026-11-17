import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';
import { Failure, SplSyntaxError, SuccessSignal } from './errors.js';
import {
    LlmError, REASONING_LEVELS, buildPromptParts, parseJsonResponse, validateRandomness, validateTokens,
    type AskMods, type Constraint, type DecisionRequest, type DecisionResponse, type LlmBackend, type LlmRequest, type LlmResponse,
    type ReasoningLevel,
} from './llm.js';
import { sources } from './loader.js';
import type { ModelInteraction } from './log-events.js';
import type { Logger, LogLevel } from './logger.js';
import { ScopeObserver } from './observer.js';
import { isResponse, traceRequest } from './recording.js';
import { Restrictions, makeRestriction, type Restriction, type RestrictKind } from './restrict.js';
import { compileSchema } from './schema.js';
import { TOOL_SPECS, ToolHost, describeToolCall, type ToolName } from './tools.js';
import { TraceError, type Trace } from './trace.js';
import { isType, type JsonSchema, type Type } from './types.js';

export type HumanHandler = (question: string, line: number) => string | Promise<string>;
export type GenerationKind = 'ask' | 'agent';

export interface GenerateOptions {
    /** Length hint for the model; guidance only. */
    len?: AskMods['len'];
    /** Parse and check the answer. */
    fmt?: AskMods['fmt'];
    /** A type from the builder, which the answer is coerced to, or raw JSON Schema. Implies JSON output. */
    schema?: Type<unknown> | JsonSchema;
    /** Extra attempts after a format or schema error: 0 to 5. */
    repairs?: number;
    /** `medium` by default; `none` when `seed`, `temperature` or `topP` is set. */
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

/** `decision()`: a yes/no question judged by a probability cutoff, or a choice of labels that stand for true or false. */
export interface DecisionOptions {
    /** The question to judge. */
    question: string;
    /** What the question is judged against: a text or a list of items; non-strings are shown as JSON. */
    evidence?: string | readonly unknown[];
    /** Yes/no questions: true when the probability of yes exceeds this, 0.5 by default. */
    cutoff?: number;
    /** Choice questions: each label and the boolean it stands for. */
    labels?: Readonly<Record<string, boolean>>;
    /** Selects the provider; OpenAI and Google decide with their fixed decision models. */
    model?: string;
}

const DECISION_OPTIONS = ['question', 'evidence', 'cutoff', 'labels', 'model'];

const isDecisionResponse = (value: unknown): value is DecisionResponse | null => {
    if (value === null) return true;
    if (typeof value !== 'object' || Array.isArray(value)) return false;
    const { probability, probabilities, label, effective } = value as Record<string, unknown>;
    const unit = (item: unknown): boolean => typeof item === 'number' && item >= 0 && item <= 1;
    return typeof effective === 'object' && effective !== null && !Array.isArray(effective)
        && (probability === undefined || unit(probability))
        && (label === undefined || typeof label === 'string')
        && (probabilities === undefined || typeof probabilities === 'object' && probabilities !== null && !Array.isArray(probabilities)
            && Object.values(probabilities).every(unit));
};

/** A place the `--debug` stepper can stop: a `---` block or a top-level statement. */
export interface Step {
    kind: 'code' | 'block';
    line: number;
    /** `ts` for code; `ask`, `agent` or `codegen` for a block. */
    language: string;
    /** The step as written. */
    source: string;
    /** JSON-shaped snapshot of the workflow's top-level variables; unassigned ones show `<uninitialized>`. */
    variables(): Record<string, unknown>;
}

export interface RuntimeOptions {
    backend: LlmBackend;
    logger: Logger;
    /** Working directory for relative paths, restrictions and tools. */
    cwd?: string;
    /** Overrides every other model choice, like the CLI `--model`. */
    model?: string;
    /** Used when neither the call nor the file names a model. */
    defaultModel?: string;
    /** Script arguments exposed as the read-only `args`. */
    args?: readonly string[];
    trace?: Trace;
    human?: HumanHandler;
    /** Awaited before each block and top-level statement of an instrumented workflow. */
    beforeStep?: (step: Step) => void | Promise<void>;
}

/** Defaults a `.spl` file sets for every model call in its workflow. */
export interface Defaults {
    model?: string;
    reasoning?: ReasoningLevel;
    hide?: boolean;
    tokens?: number;
}

/** The dynamic scope of a call: which runtime, which restrictions and which guidance apply. */
export interface Context {
    runtime: Runtime;
    restrictions: Restrictions;
    constraints: readonly Constraint[];
    /** Arguments of the running workflow. */
    args: readonly string[];
    defaults: Defaults;
    /** Module URL of the running workflow: names generated-code caches. */
    url?: string;
    /** Line of the running block, used when a failure has no code location. */
    line?: number;
    /** Top-level variables of an instrumented workflow, for state logs and the stepper. */
    scope?: { variables?: () => Record<string, () => unknown>; readonly observer: ScopeObserver };
    /** Orders the journaled work started inside an agent block; outside one, the runtime's own gate does. */
    gate?: Gate;
}

/** A queue of journaled work: each piece starts when the one before it has finished. */
export interface Gate {
    tail: Promise<void>;
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

/** The context of the running workflow, if any. */
export function activeContext(): Context | undefined {
    return shared.storage.getStore();
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

const GENERATION_OPTIONS = ['len', 'fmt', 'schema', 'repairs', 'reasoning', 'hide', 'model', 'tokens', 'seed', 'temperature', 'topP'];
const runtimeError = (message: string): Failure => new Failure('runtime_error', message);
/** Signals that end a run on purpose; they pass through every failure handler untouched. */
export const control = (error: unknown): boolean =>
    error instanceof TraceError || error instanceof SuccessSignal || error instanceof SplSyntaxError;

/** Models often wrap an answer in a fence despite instructions; one enclosing fence is unwrapped. */
export function unwrapFence(text: string): string {
    const fenced = /^\s*(`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n\1\s*$/.exec(text);
    return (fenced ? fenced[2] : text).trim();
}

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
    // Erased type annotations leave blanks behind.
    const tidy = params.replace(/\s+/g, ' ').replace(/ (?=[,)])|(?<=\() /g, '');
    return `${asynchronous ? 'async ' : ''}function ${fn.name || 'anonymous'}${tidy}`;
}

export class Runtime {
    readonly cwd: string;
    readonly args: readonly string[];
    readonly logger: Logger;
    readonly backend: LlmBackend;
    readonly trace?: Trace;
    /** Read-only environment; the first access is recorded for deterministic replay. */
    readonly env: Readonly<Record<string, string>>;
    readonly root: Context;
    private readonly environment: Readonly<Record<string, string>>;
    private readonly model?: string;
    private readonly defaultModel?: string;
    private readonly humanHandler?: HumanHandler;
    private readonly beforeStep?: (step: Step) => void | Promise<void>;
    private readonly gate: Gate = { tail: Promise.resolve() };
    /** An effect was replayed since state was last compared: what it changed is history, not news. */
    private replayed = false;

    constructor(options: RuntimeOptions) {
        this.logger = options.logger;
        this.backend = options.backend;
        this.trace = options.trace;
        this.cwd = options.cwd ?? process.cwd();
        this.model = options.model;
        this.defaultModel = options.defaultModel;
        this.humanHandler = options.human;
        this.beforeStep = options.beforeStep;
        const environment: Record<string, string> = {};
        for (const [name, value] of Object.entries(options.trace?.environment ?? process.env)) {
            if (value !== undefined) Object.defineProperty(environment, name, { value, enumerable: true });
        }
        this.environment = Object.freeze(environment);
        const observe = (): void => this.trace?.observeEnvironment(this.environment);
        this.env = new Proxy(this.environment, {
            get: (target, key, receiver) => { observe(); return Reflect.get(target, key, receiver); },
            has: (target, key) => { observe(); return Reflect.has(target, key); },
            ownKeys: target => { observe(); return Reflect.ownKeys(target); },
            getOwnPropertyDescriptor: (target, key) => { observe(); return Reflect.getOwnPropertyDescriptor(target, key); },
        });
        this.args = Object.freeze([...(options.trace?.args ?? options.args ?? [])]);
        this.root = { runtime: this, restrictions: new Restrictions(this.cwd), constraints: [], args: this.args, defaults: {} };
    }

    get replaying(): boolean { return Boolean(this.trace?.replaying); }
    /** Workflows report state and stop for the stepper only when something listens. */
    get instrumented(): boolean { return this.logger.observesState || this.beforeStep !== undefined; }

    /** Runs a body with this runtime as the current one. */
    run<T>(body: () => T, context: Context = this.root): T {
        return runInContext(context, body);
    }

    /**
     * Runs journaled work when everything queued before it has finished. A trace replays only if its
     * effects come in the same order again, so the order must follow from the code, not from timing:
     * concurrent calls such as `Promise.all(items.map(item => ask(...)))` are journaled in call order,
     * and an agent block, whose actions arrive whenever the model sends them, holds its place until it ends.
     */
    async sequence<T>(work: () => T | Promise<T>): Promise<T> {
        const gate = activeContext()?.gate ?? this.gate;
        const previous = gate.tail;
        let release!: () => void;
        gate.tail = new Promise<void>(resolve => { release = resolve; });
        await previous;
        try {
            return await work();
        } finally {
            release();
        }
    }

    /** Records an external effect in the trace, or just performs it. */
    effect<T>(request: unknown, perform: () => T | Promise<T>, valid: (value: unknown) => value is T): Promise<T> {
        const { trace } = this;
        if (!trace) return Promise.resolve().then(perform);
        return this.sequence(() => {
            this.replayed ||= trace.replaying;
            return trace.effect(request, perform, valid);
        });
    }

    // ---- source locations ------------------------------------------------

    /** Finds the innermost workflow frame of an error, so failures name the line that caused them. */
    locate(error: unknown): { line: number; command: string; source: string } | undefined {
        const stack = error instanceof Error ? error.stack : undefined;
        if (!stack || !sources.size) return undefined;
        for (const frame of stack.split('\n')) {
            for (const [file, info] of sources) {
                const at = frame.indexOf(file);
                if (at < 0) continue;
                const position = /^:(\d+):(\d+)\)?\s*$/.exec(frame.slice(at + file.length));
                if (!position) continue;
                let line = Number(position[1]);
                // Line 1 starts with the generated wrapper; a frame there is not workflow code.
                if (line === 1 && Number(position[2]) <= (info.header ?? 0)) continue;
                if (info.pageOffset !== undefined && line > info.pageOffset) line -= info.pageOffset;
                if (!info.lines && file.startsWith('file:')) {
                    try { info.lines = fs.readFileSync(fileURLToPath(file), 'utf8').split(/\r?\n/); }
                    catch { info.lines = []; }
                }
                return { line, command: (info.lines?.[line - 1] ?? '').trim(), source: file };
            }
        }
        return undefined;
    }

    /** Line of the workflow code that called into the library, or the running block. */
    callerLine(context: Context): number {
        return this.locate(new Error())?.line ?? context.line ?? 0;
    }

    /** Turns anything thrown by workflow code into a located failure. */
    failure(error: unknown, fallback?: { line: number; command: string; source?: string }): Failure {
        const failure = error instanceof Failure ? error
            : new Failure('runtime_error', error instanceof Error ? `${error.name}: ${error.message}` : `uncaught value: ${display(error)}`);
        if (!failure.located) {
            const location = this.locate(error) ?? this.locate(failure) ?? fallback;
            if (location) failure.locate(location.line, location.command, location.source);
        }
        return failure;
    }

    // ---- state and stepping ------------------------------------------------

    /** Top-level variables of the workflow running in `context`; ones not yet assigned are left out or marked. */
    private variables(context: Context, uninitialized?: unknown): Record<string, unknown> {
        const values: Record<string, unknown> = {};
        for (const [name, read] of Object.entries(context.scope?.variables?.() ?? {})) {
            try {
                values[name] = read();
            } catch (error) {
                if (!(error instanceof ReferenceError)) throw error;
                if (uninitialized !== undefined) values[name] = uninitialized;
            }
        }
        return values;
    }

    /** Reports changes to top-level variables since the last call. */
    observe(context: Context): void {
        if (this.logger.observesState && context.scope?.variables) {
            context.scope.observer.flush(this.logger, this.variables(context), this.replayed || this.replaying);
            this.replayed = false;
        }
    }

    /** Called before each block and each top-level statement of an instrumented workflow. */
    async step(context: Context, step: Omit<Step, 'variables' | 'source'> & { source?: string; endLine?: number }): Promise<void> {
        this.observe(context);
        if (!this.beforeStep) return;
        const lines = context.url ? sources.get(context.url)?.lines : undefined;
        await this.beforeStep({
            kind: step.kind, line: step.line, language: step.language,
            source: step.source ?? lines?.slice(step.line - 1, step.endLine ?? step.line).join('\n') ?? '',
            variables: () => Object.fromEntries(Object.entries(this.variables(context, UNINITIALIZED))
                .map(([name, value]) => [name, value === UNINITIALIZED ? '<uninitialized>' : describeValue(value)])),
        });
    }

    // ---- logging ---------------------------------------------------------

    log(level: LogLevel, values: readonly unknown[]): void {
        if (this.replaying) return;
        this.logger[level]('log:', ...values.map(value =>
            typeof value === 'object' && value !== null && !isType(value) ? describeValue(value) : display(value)));
    }

    // ---- environment -----------------------------------------------------

    async environmentValue(name: string): Promise<string | null> {
        const perform = (): string | null => Object.hasOwn(this.environment, name) ? this.environment[name] : null;
        return this.trace
            ? this.effect({ kind: 'environment-value', name }, perform, (value): value is string | null => value === null || typeof value === 'string')
            : perform();
    }

    // ---- human input -----------------------------------------------------

    async human(question: unknown, line: number): Promise<string> {
        if (typeof question !== 'string') throw runtimeError('human question must be a string');
        // Without a handler nothing can answer: fail before the trace records an unanswerable question.
        if (!this.humanHandler && !this.replaying) throw runtimeError('human input requires a human handler');
        const direct = async (): Promise<string> => {
            if (!this.humanHandler) throw runtimeError('human input requires a human handler');
            const answer = await this.humanHandler(question, line);
            if (typeof answer !== 'string') throw runtimeError('human answer must be a string');
            return answer;
        };
        return this.trace
            ? this.effect({ kind: 'human', question }, direct, (value): value is string => typeof value === 'string')
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
        const perform = (): Promise<string> => new ToolHost(context.restrictions, this.cwd, true).invoke(tool, params);
        try {
            const output = await (this.trace
                ? this.effect({ kind: 'tool', tool, params, restrictions: context.restrictions.list }, perform, (value): value is string => typeof value === 'string')
                : perform());
            if (!this.replaying) this.logger.tool(describeToolCall(tool, params, { output }));
            return output;
        } catch (error) {
            if (!this.replaying && error instanceof Failure) this.logger.tool(describeToolCall(tool, params, { error: error.reason }));
            throw error;
        }
    }

    async restriction(kind: RestrictKind, value: unknown): Promise<Restriction> {
        const perform = (): Restriction => makeRestriction(kind, value, this.cwd);
        return this.trace
            ? this.effect({ kind: 'restriction', restriction: kind, value }, perform,
                (result): result is Restriction => typeof result === 'object' && result !== null && !Array.isArray(result)
                    && (result as Restriction).kind === kind && Array.isArray((result as Restriction).values)
                    && (result as Restriction).values.every(item => typeof item === 'string'))
            : perform();
    }

    // ---- models ----------------------------------------------------------

    /** CLI `--model`, then the per-call model, then the file default, then the configured default, then the provider's. */
    resolveModel(model: string | undefined, context: Context): string | undefined {
        return this.model ?? model ?? context.defaults.model ?? this.defaultModel;
    }

    /** One model call. Calls that act through `runtimeTools` are journaled action by action by their caller. */
    async callModel(
        req: LlmRequest,
        interaction: ModelInteraction = { requestId: randomUUID(), kind: req.kind },
        preface = '', record = !req.runtimeTools,
    ): Promise<LlmResponse> {
        const { logger, backend } = this;
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
                    const reply = await backend.call(req);
                    return req.kind === 'agent' && !req.runtimeTools && reply.toolResults === undefined && req.tools.calls.length
                        ? { ...reply, toolResults: [...req.tools.calls] }
                        : reply;
                } catch (error) {
                    if (error instanceof Failure || control(error)) throw error;
                    throw new Failure('llm_error', error instanceof Error ? error.message : String(error));
                }
            };
            const res = this.trace && record
                ? await this.effect({ kind: 'llm', request: traceRequest(req), restrictions: req.restrictions.list }, perform, isResponse)
                : await perform();
            if (!isResponse(res)) throw new Failure('llm_error', 'backend returned an invalid response');
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

    /** `ask` and `agent`: one fresh conversation, optional format/schema checks and repairs. */
    async generate(kind: GenerationKind, prompt: unknown, options: GenerateOptions | undefined, context: Context): Promise<unknown> {
        if (options !== undefined && (typeof options !== 'object' || options === null || Array.isArray(options) || isType(options))) {
            throw runtimeError(`${kind}() options must be an object such as { schema: Invoice, repairs: 1 }`);
        }
        const given: Record<string, unknown> = { ...options };
        for (const name of Object.keys(given)) {
            if (!GENERATION_OPTIONS.includes(name)) throw runtimeError(`unknown ${kind}() option '${name}'`);
            if (given[name] === undefined) delete given[name];
        }
        const sampling = {
            ...('seed' in given ? { seed: given.seed } : {}),
            ...('temperature' in given ? { temperature: given.temperature } : {}),
            ...('topP' in given ? { top_p: given.topP } : {}),
        };
        if (kind !== 'ask' && Object.keys(sampling).length) throw runtimeError(`seed, temperature and topP are exclusive to ask(); ${kind}() does not accept them`);
        const randomness = Object.keys(sampling).length ? validateRandomness(sampling) : undefined;
        const { len, repairs = 0, model } = given;
        const reasoning = 'reasoning' in given ? given.reasoning : context.defaults.reasoning;
        const hide = 'hide' in given ? given.hide : context.defaults.hide ?? false;
        const tokens = 'tokens' in given ? validateTokens(given.tokens) : context.defaults.tokens;
        // A Str answer is the reply itself; every other type is read from JSON.
        const target = isType(given.schema) && given.schema.kind !== 'str' ? given.schema : undefined;
        const structured = 'schema' in given && (target !== undefined || !isType(given.schema));
        const fmt = 'fmt' in given ? given.fmt : structured ? 'json' : 'text';
        if (len !== undefined && len !== 'word' && len !== 'sentence' && len !== 'paragraph' && len !== 'long') throw runtimeError('len must be word, sentence, paragraph, or long');
        if (fmt !== 'integer' && fmt !== 'float' && fmt !== 'array' && fmt !== 'object' && fmt !== 'text' && fmt !== 'boolean' && fmt !== 'json') {
            throw runtimeError('fmt must be integer, float, array, object, text, boolean, or json');
        }
        if (reasoning !== undefined && !REASONING_LEVELS.includes(reasoning as ReasoningLevel)) throw runtimeError('reasoning must be none, low, medium, high, or max');
        if (typeof hide !== 'boolean') throw runtimeError('hide must be true or false');
        if (model !== undefined && (typeof model !== 'string' || !model.trim())) throw runtimeError('model must be a non-empty string');
        if (typeof repairs !== 'number' || !Number.isInteger(repairs) || repairs < 0 || repairs > 5) throw runtimeError('repairs must be an integer from 0 to 5');
        if (kind === 'agent' && repairs !== 0) throw runtimeError('agents cannot use repairs: external actions must not be retried automatically');
        if (fmt === 'text' && (structured || repairs !== 0)) throw runtimeError('schema and repairs require JSON output: use a type other than Str');
        const schema = target ? target.schema() : given.schema;
        const validate = structured && !target ? compileSchema(schema) : undefined;
        const built = buildPromptParts({
            prompt: display(prompt),
            mods: { len, fmt },
            constraints: context.constraints,
            restrictions: context.restrictions,
        });
        let text = built.prompt;
        if (fmt === 'json') text += '\n\nReturn ONLY valid JSON, without prose or code fences.';
        if (structured) text += `\n\nThe result must satisfy this JSON Schema:\n${JSON.stringify(schema)}`;
        const base = text;
        for (let attempt = 0; ; attempt++) {
            const response = (await this.callModel({
                kind, prompt: text,
                model: this.resolveModel(model, context),
                reasoningEffort: reasoning as ReasoningLevel | undefined,
                ...(tokens !== undefined ? { tokens } : {}),
                ...(randomness !== undefined ? { randomness: { ...randomness } } : {}),
                showReasoning: !hide,
                restrictions: context.restrictions,
                tools: new ToolHost(context.restrictions, this.cwd),
            }, undefined, built.preface)).text.trim();
            try {
                if (fmt === 'text') return response;
                const value = parseJsonResponse(unwrapFence(response), fmt);
                if (target) return target.coerce(value);
                validate?.(value);
                return value;
            } catch (error) {
                if (!(error instanceof Failure) || (error.statusCode !== 'invalid_format' && error.statusCode !== 'validation_failed') || attempt >= repairs) throw error;
                if (!this.replaying) this.logger.info(`repair ${attempt + 1}/${repairs}: ${error.reason}`);
                text = `${base}\n\nPrevious response:\n${response}\n\nValidation failed: ${error.reason}\nReturn a corrected JSON value.`;
            }
        }
    }

    /**
     * `decision`: a provider decision endpoint with its fixed model, or, for providers without one, a simulated
     * decision made with `ask` and a JSON Schema. Yes/no questions are true above the cutoff; choice questions
     * are the boolean of the chosen label.
     */
    async decision(options: unknown, context: Context): Promise<boolean> {
        if (typeof options !== 'object' || options === null || Array.isArray(options) || isType(options)) {
            throw runtimeError("decision() requires an object such as { question: 'Is it red?', evidence: [...], cutoff: 0.8 }");
        }
        const given: Record<string, unknown> = { ...options };
        for (const name of Object.keys(given)) {
            if (!DECISION_OPTIONS.includes(name)) throw runtimeError(`unknown decision() option '${name}'`);
            if (given[name] === undefined) delete given[name];
        }
        const { question, evidence = [], model, labels } = given;
        if (typeof question !== 'string' || !question.trim()) throw runtimeError('decision() requires a question: a non-empty string');
        if (typeof evidence !== 'string' && !Array.isArray(evidence)) throw runtimeError('decision() evidence must be a string or a list');
        const items = (typeof evidence === 'string' ? [evidence] : evidence).map(display);
        if (model !== undefined && (typeof model !== 'string' || !model.trim())) throw runtimeError('model must be a non-empty string');
        if ('cutoff' in given && labels !== undefined) throw runtimeError('decision() takes either cutoff or labels, not both');
        const cutoff = given.cutoff ?? 0.5;
        if (typeof cutoff !== 'number' || !(cutoff >= 0 && cutoff <= 1)) throw runtimeError('decision() cutoff must be a number from 0 to 1');
        let meanings: Record<string, boolean> | undefined;
        if (labels !== undefined) {
            if (typeof labels !== 'object' || labels === null || Array.isArray(labels) || isType(labels)) {
                throw runtimeError("decision() labels must be an object such as { red: true, orange: false }");
            }
            meanings = { ...labels as Record<string, unknown> } as Record<string, boolean>;
            const names = Object.keys(meanings);
            if (names.length < 2 || names.length > 255) throw runtimeError('decision() labels must name between 2 and 255 labels');
            for (const name of names) {
                if (!name.trim() || name !== name.trim() || /[\u0000-\u001f\u007f]/.test(name)) {
                    throw runtimeError(`decision() label '${name}' must be non-empty, without surrounding spaces or control characters`);
                }
                if (typeof meanings[name] !== 'boolean') throw runtimeError(`decision() label '${name}' must map to true or false`);
            }
            if (!Object.values(meanings).includes(true) || !Object.values(meanings).includes(false)) {
                throw runtimeError('decision() labels need at least one label for true and one for false');
            }
        }
        const names = meanings ? Object.keys(meanings) : undefined;
        const guidance = context.constraints.map(c => `- ${c.kind === 'enforce' ? 'Follow' : 'Avoid'}: ${c.text}`).join('\n');
        const resolved = this.resolveModel(model as string | undefined, context);
        const request: DecisionRequest = {
            evidence: items,
            question: guidance ? `${question}\n\nGuidance:\n${guidance}` : question,
            ...(names ? { labels: names } : {}),
            ...(resolved !== undefined ? { model: resolved } : {}),
        };
        let response: DecisionResponse | null = null;
        if (this.backend.decide) {
            const decide = this.backend.decide.bind(this.backend);
            const started = Date.now();
            const perform = async (): Promise<DecisionResponse | null> => {
                try {
                    return await decide(request);
                } catch (error) {
                    if (error instanceof Failure || control(error)) throw error;
                    throw new Failure('llm_error', error instanceof Error ? error.message : String(error));
                }
            };
            response = this.trace
                ? await this.effect({ kind: 'decision', request }, perform, isDecisionResponse)
                : await perform();
            if (!isDecisionResponse(response)) throw new Failure('llm_error', 'backend returned an invalid decision');
            if (response && !this.replaying) this.logger.info(`llm decision call: ${JSON.stringify(response.effective)} (${Date.now() - started} ms)`);
        }
        response ??= await this.simulateDecision(question, items, names, model as string | undefined, context);
        let result: boolean;
        if (meanings) {
            const label = response.label;
            if (label === undefined || !Object.hasOwn(meanings, label)) throw new Failure('llm_error', `decision chose an unknown label: ${JSON.stringify(label)}`);
            result = meanings[label];
            if (!this.replaying) this.logger.info(`decision: '${label}' -> ${result}`);
        } else {
            if (response.probability === undefined) throw new Failure('llm_error', 'decision returned no probability');
            result = response.probability > cutoff;
            if (!this.replaying) this.logger.info(`decision: P(yes)=${response.probability} ${result ? '>' : '<='} cutoff ${cutoff} -> ${result}`);
        }
        return result;
    }

    /** A decision for providers without a decision endpoint: `ask` for probabilities that satisfy a JSON Schema. */
    private async simulateDecision(
        question: string, evidence: readonly string[], labels: readonly string[] | undefined, model: string | undefined, context: Context,
    ): Promise<DecisionResponse> {
        const shown = evidence.length ? evidence.map((item, index) => `${index + 1}. ${item}`).join('\n') : 'No evidence was given.';
        const unit = { type: 'number', minimum: 0, maximum: 1 };
        const prompt = labels
            ? `Judge the question by the evidence alone. Give each label the probability that it is the right answer; the probabilities add up to 1.\n\nQuestion: ${question}\n\nLabels: ${labels.map(label => JSON.stringify(label)).join(', ')}\n\nEvidence:\n${shown}`
            : `Judge the question by the evidence alone. Give the probability, from 0 to 1, that the answer is yes.\n\nQuestion: ${question}\n\nEvidence:\n${shown}`;
        const schema = labels
            ? { type: 'object', properties: { probabilities: { type: 'object', properties: Object.fromEntries(labels.map(label => [label, unit])), required: [...labels], additionalProperties: false } }, required: ['probabilities'], additionalProperties: false }
            : { type: 'object', properties: { probability: unit }, required: ['probability'], additionalProperties: false };
        const answer = await this.generate('ask', prompt, { schema, repairs: 1, ...(model !== undefined ? { model } : {}) }, context) as
            { probability?: number; probabilities?: Record<string, number> };
        const effective = { simulated: true };
        if (!labels) return { probability: answer.probability!, effective };
        const raw = answer.probabilities!;
        const total = labels.reduce((sum, label) => sum + raw[label], 0);
        if (!(total > 0)) throw new Failure('invalid_format', 'decision label probabilities must not all be 0');
        const probabilities = Object.fromEntries(labels.map(label => [label, raw[label] / total]));
        // The first label wins a tie, as listed.
        const label = labels.reduce((best, item) => probabilities[item] > probabilities[best] ? item : best);
        return { label, probabilities, effective };
    }
}

const UNINITIALIZED = Symbol('uninitialized');
