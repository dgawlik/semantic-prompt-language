import type { AssignTarget, DefStmt, Expr, Program, Stmt, StrPart, ToolName } from './ast.js';
import { callMethod, hasBuiltinMethod, isListCallbackMethod, isMutatingMethod, iterate, makeBuiltins } from './builtins.js';
import { Failure, SuccessSignal, type FailurePayload } from './errors.js';
import { LlmError, buildPromptParts, parseJsonResponse, validateRandomness, validateTokens, type Constraint, type LlmBackend, type LlmRequest, type LlmResponse, type RuntimeAction } from './llm.js';
import { AGENT_TOOLS, actionArguments } from './agent.js';
import { compileSchema } from './schema.js';
import { checkProgram } from './type-check.js';
import { aliasType, assertComplete, checkedInt, contractOf, contractRead, convertFloat, convertInt, descriptor, equivalent, mutateContract, primitives, project, resolveFields, resolveType, signatureOf, testValue, typedFloat, validateType, validateValue, type TypeDescriptor } from './types.js';
import { decodeJsonValue, decodeTypedJson, schemaForType } from './typed-json.js';
import type { Logger, LogLevel } from './logger.js';
import { Restrictions, makeRestriction, type Restriction } from './restrict.js';
import { MemoryStore, type VariableStore } from './store.js';
import { ToolHost, TOOL_SPECS } from './tools.js';
import { TraceError, type Trace } from './trace.js';
import { isResponse, isToolValue, traceRequest } from './recording.js';
import { Pin, PinError } from './pin.js';
import { usesHuman } from './parser.js';
import { NATURAL_PREAMBLE, RUNTIME_PREAMBLE } from './preamble.js';
import { randomUUID } from 'node:crypto';
import { setImmediate as yieldExecution } from 'node:timers/promises';
import { ObservationIdentities, StateObserver } from './state-observer.js';
import type { ModelInteraction, ScopeKind } from './log-events.js';
import {
    assertMutable,
    compareValues,
    describeValue,
    equals,
    hasKey,
    isDict,
    isFunction,
    isDescriptor,
    isFloat,
    isInstance,
    isList,
    newDict,
    registerInstance,
    runtimeError,
    setKey,
    str,
    toJson,
    truthy,
    typeName,
    type Env,
    type FunctionValue,
    type InstanceValue,
    type UserFunction,
    type Value,
} from './values.js';

export interface RunOptions {
    backend: LlmBackend;
    logger: Logger;
    store?: VariableStore;
    /** Working directory for relative paths, `restrict` folders and tools. */
    cwd?: string;
    /** Overrides the `@(model=...)` directive. */
    model?: string;
    /** Script arguments exposed as read-only `$args`; defaults to an empty list. */
    args?: readonly string[];
    maxCallDepth?: number;
    trace?: Trace;
    /** Capture a successful workflow for deterministic Markdown replay. */
    pin?: Pin;
    /** Handles human expressions and blockquote ask_human calls without suspending. */
    human?: (question: string, line: number) => string | Promise<string>;
    /** Source URI used to locate failures across interactive cells. */
    source?: string;
    sourceVersion?: number;
}

export type RunResult =
    | { status: 'success'; value: Value; hasValue: boolean }
    | { status: 'failure'; failure: FailurePayload };

type Signal = { k: 'break' } | { k: 'continue' } | { k: 'return'; v: Value; hasValue: boolean };
type Completion = Signal | { k: 'value'; v: Value } | undefined;

class ExpressionSignal {
    constructor(readonly signal: Signal) {}
}

export async function run(program: Program, opts: RunOptions): Promise<RunResult> {
    try {
        if (program.markdown?.lock && opts.pin) throw new PinError('cannot pin an already locked workflow');
        const pin = opts.pin ?? (program.markdown?.lock ? Pin.replay(program.markdown.lock) : undefined);
        pin?.validateOptions(opts);
        const result = await new Interpreter(program, { ...opts, pin }).run();
        pin?.assertConsumed();
        return result;
    } catch (error) {
        if (!(error instanceof PinError)) throw error;
        opts.logger.error(error.message);
        return { status: 'failure', failure: new Failure('runtime_error', error.message).payload() };
    }
}

interface SessionState {
    globals: Env;
    identities: ObservationIdentities;
    current?: Interpreter;
}

/** An isolated interactive scope, retaining values and function closures between runs. */
export class ExecutionSession {
    private readonly state: SessionState = { globals: { vars: new Map() }, identities: new ObservationIdentities() };
    private running = false;

    async run(program: Program, opts: Omit<RunOptions, 'store' | 'trace' | 'pin'>): Promise<RunResult> {
        if (this.running) throw new Error('an execution session can only run one cell at a time');
        if (program.markdown?.lock) throw new PinError('locked workflows must run standalone with run(), not in an execution session');
        this.running = true;
        try {
            this.state.current = new Interpreter(program, opts, this.state);
            return await this.state.current.run();
        } finally {
            this.running = false;
            this.state.current = undefined;
        }
    }
}

class Interpreter {
    private readonly globals: Env;
    private readonly observer: StateObserver;
    private readonly builtins: Map<string, Value>;
    private readonly store: VariableStore;
    private readonly cwd: string;
    private readonly model?: string;
    private readonly maxDepth: number;
    private readonly runtimeEnv = newDict();
    private readonly runtimeArgs: Value[];
    private constraints: Constraint[] = [];
    private restrictions: Restrictions;
    private depth = 0;
    private sourceLines: string[];
    private sourceUri?: string;
    private sourceVersion?: number;
    private steps = 0;
    private returnType?: TypeDescriptor;

    constructor(
        private readonly program: Program,
        private readonly opts: RunOptions,
        private readonly sessionState?: SessionState,
    ) {
        this.globals = sessionState?.globals ?? { vars: new Map() };
        this.observer = new StateObserver(this.globals, opts.logger, sessionState?.identities);
        this.sourceLines = program.lines;
        this.sourceUri = opts.source;
        this.sourceVersion = opts.sourceVersion;
        this.cwd = opts.pin?.data.context.cwd ?? opts.cwd ?? process.cwd();
        this.store = opts.store ?? new MemoryStore();
        this.model = opts.pin?.data.context.model ?? opts.model ?? program.directives.model;
        this.maxDepth = opts.maxCallDepth ?? 200;
        const environment = opts.pin?.replaying ? opts.pin.data.environment ?? {} : opts.trace?.environment ?? process.env;
        for (const [name, value] of Object.entries(environment)) {
            if (value !== undefined) setKey(this.runtimeEnv, name, value);
        }
        this.runtimeArgs = [...(opts.pin?.data.context.args ?? opts.trace?.args ?? opts.args ?? [])];
        Object.freeze(this.runtimeEnv);
        Object.freeze(this.runtimeArgs);
        this.restrictions = new Restrictions(this.cwd);
        this.builtins = makeBuiltins({ log: sessionState
            ? Interpreter.sessionLog(sessionState)
            : values => this.logValues('info', values) });
        for (const [name, type] of primitives) this.builtins.set(name, type);
        for (const name of ['validate', 'isinstance']) {
            this.builtins.set(name, { __fn: 'builtin', name, call: args => {
                if (args.length !== 2 || !isDescriptor(args[1])) throw runtimeError(`${name}() requires a value and a type descriptor`);
                return name === 'validate' ? validateType(args[0], args[1]) : testValue(args[0], args[1]);
            } });
        }
        this.builtins.set('struct', { __fn: 'builtin', name: 'struct', call: args => {
            if (args.length !== 1 || !isDescriptor(args[0]) || args[0].kind !== 'class') throw runtimeError('struct() requires a class descriptor');
            return descriptor('struct', `struct(${args[0].name})`, { fields: args[0].fields });
        } });
        for (const tool of Object.keys(TOOL_SPECS) as ToolName[]) {
            this.builtins.set(tool, {
                __fn: 'builtin', name: tool,
                call: sessionState ? Interpreter.sessionTool(sessionState, tool) : args => this.callTool(tool, args),
            });
        }
    }

    private static sessionLog(state: SessionState): (values: Value[]) => void {
        return values => {
            if (!state.current) throw runtimeError('no active execution session');
            state.current.logValues('info', values);
        };
    }

    private static sessionTool(state: SessionState, tool: ToolName): (args: Value[]) => Promise<Value> {
        return args => {
            if (!state.current) throw runtimeError('no active execution session');
            return state.current.callTool(tool, args);
        };
    }

    async run(): Promise<RunResult> {
        const { logger } = this.opts;
        let executing = false;
        try {
            checkProgram(this.program, this.globals);
            if (this.opts.trace && this.opts.store) {
                throw new TraceError('trace runs cannot use a variable store');
            }
            this.opts.trace?.validateSource(this.program.lines.join('\n'), this.opts.args);
            if (!this.opts.trace && !this.opts.pin?.replaying && !this.opts.human && usesHuman(this.program)) {
                throw runtimeError('human input requires a human handler');
            }
            const variables = this.opts.pin
                ? await this.opts.pin.effect({ kind: 'store' }, () => this.store.load(),
                    (value): value is Record<string, Value> => isDict(value) && Object.values(value).every(isToolValue))
                : this.store.load();
            for (const [k, v] of Object.entries(variables)) this.globals.vars.set(k, v);
            executing = true;
            const signal = await this.execBlock(this.program.body, this.globals);
            this.opts.trace?.assertConsumed();
            if (signal?.k === 'return') return { status: 'success', value: signal.v, hasValue: signal.hasValue };
            if (signal && signal.k !== 'value') throw runtimeError(`'${signal.k}' outside of a loop`);
            if (this.sessionState && signal?.k === 'value') return { status: 'success', value: signal.v, hasValue: true };
            return { status: 'success', value: null, hasValue: false };
        } catch (e) {
            if (e instanceof SuccessSignal) {
                this.opts.trace?.assertConsumed();
                return { status: 'success', value: e.value as Value, hasValue: true };
            }
            if (e instanceof Failure) {
                e.source ??= this.sourceUri;
                e.sourceVersion ??= this.sourceVersion;
                this.opts.trace?.assertConsumed();
                logger.error(`${e.statusCode}: ${e.reason} (line ${e.line})`);
                return { status: 'failure', failure: e.payload() };
            }
            throw e;
        } finally {
            try {
                if (executing && !this.sessionState && !this.opts.trace && !this.opts.pin?.replaying) {
                    const snapshot: Record<string, Value> = {};
                    for (const [k, v] of this.globals.vars) if (!isFunction(v) && !isDescriptor(v) && !isInstance(v)) snapshot[k] = v;
                    this.store.save(snapshot);
                }
            } catch (e) {
                logger.error(`could not save variable store: ${(e as Error).message}`);
            }
        }
    }

    // ---- environments --------------------------------------------------

    private logValues(level: LogLevel, values: Value[]): void {
        if (!this.opts.trace?.replaying) {
            this.opts.logger[level]('log:', ...values.map(value => isDict(value) || isList(value) ? toJson(value) : str(value)));
        }
    }

    private lookup(name: string, env: Env): Value {
        const scope = this.bindingScope(name, env);
        if (scope) return scope.vars.get(name)!;
        const b = this.builtins.get(name);
        if (b) return b;
        throw runtimeError(`name '${name}' is not defined`);
    }

    private bindingScope(name: string, env: Env): Env | undefined {
        for (let scope: Env | undefined = env; scope; scope = scope.parent) {
            if (scope.vars.has(name)) return scope;
        }
        return undefined;
    }

    private childScope(parent: Env, kind: ScopeKind = 'block', label: string = kind): Env {
        const scope = { vars: new Map<string, Value>(), parent };
        this.observer.scope(scope, kind, label);
        return scope;
    }

    private commit(env: Env, name: string, value: Value): void {
        assertComplete(value);
        const contract = env.contracts?.get(name);
        if (contract) value = validateValue(value, contract, name);
        if (env.readonlyNames?.has(name)) throw runtimeError(`type declaration '${name}' is immutable`);
        this.observer.commit(env, name, value, !this.opts.trace?.replaying);
    }

    private type(expr: import('./ast.js').TypeExpr, env: Env): TypeDescriptor {
        return resolveType(expr, name => this.lookup(name, env));
    }

    private makeFunction(s: DefStmt, env: Env): UserFunction {
        return {
            __fn: 'user', name: s.name, params: s.params, body: s.body, closure: env,
            paramTypes: s.paramTypes?.map(type => type ? this.type(type, env) : undefined),
            returnType: s.returnType ? this.type(s.returnType, env) : undefined,
            source: { lines: this.sourceLines, uri: this.sourceUri, version: this.sourceVersion },
        };
    }

    private makeLambda(e: Extract<Expr, { t: 'lambda' }>, env: Env, params?: readonly (TypeDescriptor | undefined)[], result?: TypeDescriptor): UserFunction {
        return {
            ...this.makeFunction({ t: 'def', name: '<lambda>', params: e.params, body: [{ t: 'return', value: e.body, line: e.line }], line: e.line }, env),
            paramTypes: params ? [...params] : undefined,
            returnType: result,
        };
    }

    // ---- statements ----------------------------------------------------

    private async execBlock(stmts: Stmt[], env: Env): Promise<Completion> {
        const leave = this.observer.enter(env);
        try {
            let completion: Completion;
            for (const s of stmts) {
                completion = await this.execStmt(s, env);
                if (completion && completion.k !== 'value') return completion;
            }
            return completion;
        } finally {
            leave();
        }
    }

    private async execStmt(s: Stmt, env: Env): Promise<Completion> {
        try {
            if (++this.steps % 1_024 === 0) await yieldExecution();
            return await this.execStmtInner(s, env);
        } catch (e) {
            if (e instanceof ExpressionSignal) return e.signal;
            if (e instanceof Failure) throw e.locate(s.line, this.sourceLines[s.line - 1]?.trim() ?? '', this.sourceUri, this.sourceVersion);
            if (e instanceof RangeError) {
                throw new Failure('runtime_error', e.message).locate(s.line, this.sourceLines[s.line - 1]?.trim() ?? '', this.sourceUri, this.sourceVersion);
            }
            throw e;
        }
    }

    private async execStmtInner(s: Stmt, env: Env): Promise<Completion> {
        switch (s.t) {
            case 'let': {
                const type = s.annotation ? this.type(s.annotation, env) : undefined;
                const existing = env.contracts?.get(s.name);
                if (existing && type && !equivalent(existing, type)) throw new Failure('type_error', `cannot replace binding contract ${existing.name} with ${type.name}`);
                let value = await this.eval(s.value, env, type);
                assertComplete(value);
                if (type) value = validateValue(value, type, s.name);
                if (type) (env.contracts ??= new Map()).set(s.name, type);
                this.commit(env, s.name, value);
                return;
            }
            case 'enum':
                this.commit(env, s.name, descriptor('enum', s.name, { values: Object.freeze([...s.values]) }));
                (env.readonlyNames ??= new Set()).add(s.name);
                return;
            case 'type-alias':
                this.commit(env, s.name, aliasType(this.type(s.type, env), s.advice));
                (env.readonlyNames ??= new Set()).add(s.name);
                return;
            case 'struct':
                this.commit(env, s.name, descriptor('struct', s.name, { fields: resolveFields(s.fields, name => this.lookup(name, env)) }));
                (env.readonlyNames ??= new Set()).add(s.name);
                return;
            case 'class': {
                const fields = resolveFields(s.fields, name => this.lookup(name, env));
                const methods: Record<string, UserFunction> = {};
                const type = descriptor('class', s.name, { fields, methods, hydratable: s.hydratable });
                this.commit(env, s.name, type);
                (env.readonlyNames ??= new Set()).add(s.name);
                for (const method of s.methods) Object.defineProperty(methods, method.name, { value: this.makeFunction(method, env), enumerable: true });
                Object.freeze(methods);
                return;
            }
            case 'assign':
                await this.execAssign(s.target, s.op, s.value, env);
                return;
            case 'block':
                return this.execBlock(s.body, this.childScope(env));
            case 'expr':
                return { k: 'value', v: await this.eval(s.e, env) };
            case 'pass':
                return;
            case 'natural':
                return this.execNatural(s.text, s.line, env);
            case 'break':
                return { k: 'break' };
            case 'continue':
                return { k: 'continue' };
            case 'return':
                return { k: 'return', v: s.value ? await this.eval(s.value, env, this.returnType) : null, hasValue: s.value !== undefined };
            case 'if': {
                for (const b of s.branches) {
                    if (truthy(await this.eval(b.cond, env))) return this.execBlock(b.body, this.childScope(env, 'branch'));
                }
                return s.orelse ? this.execBlock(s.orelse, this.childScope(env, 'branch')) : undefined;
            }
            case 'while': {
                while (truthy(await this.eval(s.cond, env))) {
                    const sig = await this.execBlock(s.body, this.childScope(env, 'iteration'));
                    if (sig?.k === 'break') break;
                    if (sig?.k === 'return') return sig;
                }
                return;
            }
            case 'for': {
                const items = iterate(await this.eval(s.iter, env));
                for (let i = 0; i < items.length; i++) {
                    const scope = this.childScope(env, 'iteration');
                    this.bindLoopVars(s.vars, items[i], scope);
                    const sig = await this.execBlock(s.body, scope);
                    if (sig?.k === 'break') break;
                    if (sig?.k === 'return') return sig;
                }
                return;
            }
            case 'def': {
                const fn = this.makeFunction(s, env);
                this.commit(env, s.name, fn);
                return;
            }
            case 'try': {
                const savedConstraints = this.constraints;
                const savedRestrictions = this.restrictions;
                const savedDepth = this.depth;
                try {
                    const completion = await this.execBlock(s.body, this.childScope(env));
                    return completion?.k === 'value' ? undefined : completion;
                } catch (e) {
                    if (!(e instanceof Failure)) throw e;
                    this.constraints = savedConstraints;
                    this.restrictions = savedRestrictions;
                    this.depth = savedDepth;
                    const scope = this.childScope(env, 'handler');
                    this.commit(scope, s.errName, newDict(Object.entries(e.payload()) as [string, Value][]));
                    const completion = await this.execBlock(s.handler, scope);
                    return completion?.k === 'value' ? undefined : completion;
                }
            }
            case 'assert': {
                if (truthy(await this.eval(s.cond, env))) return;
                const msg = s.message ? str(await this.eval(s.message, env)) : 'assertion failed';
                throw new Failure('assertion_failed', msg);
            }
            case 'fail':
                throw new Failure('explicit_failure', str(await this.eval(s.reason, env)));
            case 'success':
                const value = s.value ? await this.eval(s.value, env) : null;
                assertComplete(value);
                throw new SuccessSignal(value);
            case 'constraint': {
                const text = str(await this.eval(s.text, env));
                const saved = this.constraints;
                this.constraints = [...saved, { kind: s.kind, text }];
                try {
                    const completion = await this.execBlock(s.body, this.childScope(env));
                    return completion?.k === 'value' ? undefined : completion;
                } finally {
                    this.constraints = saved;
                }
            }
            case 'restrict': {
                const saved = this.restrictions;
                try {
                    for (const clause of s.clauses) {
                        const restriction = await this.makeRestriction(clause.kind, await this.eval(clause.arg, env));
                        this.restrictions = this.restrictions.with(restriction);
                    }
                    const completion = await this.execBlock(s.body, this.childScope(env));
                    return completion?.k === 'value' ? undefined : completion;
                } finally {
                    this.restrictions = saved;
                }
            }
        }
    }

    private bindLoopVars(vars: string[], item: Value, env: Env): void {
        if (vars.length === 1) {
            this.commit(env, vars[0], item);
            return;
        }
        if (!isList(item) || item.length !== vars.length) {
            throw runtimeError(`cannot unpack ${typeName(item)} into ${vars.length} variables`);
        }
        vars.forEach((v, i) => this.commit(env, v, item[i]));
    }

    private async execAssign(target: AssignTarget, op: string, valueExpr: Expr, env: Env): Promise<void> {
        const compute = async (current: () => Value, expected?: TypeDescriptor): Promise<Value> => {
            const rhs = await this.eval(valueExpr, env, expected);
            return op === '=' ? rhs : this.binary(op.slice(0, -1), current(), rhs);
        };
        if (target.t === 'name') {
            const scope = this.bindingScope(target.name, env);
            if (!scope) throw runtimeError(`cannot assign '${target.name}': declare a local with let first`);
            this.commit(scope, target.name, await compute(() => this.lookup(target.name, env), scope.contracts?.get(target.name)));
            return;
        }
        const obj = await this.eval(target.obj, env);
        assertMutable(obj);
        if (isInstance(obj)) {
            const key = target.t === 'member' ? target.name : await this.eval(target.index, env);
            if (typeof key !== 'string' || !Object.hasOwn(obj.descriptor.fields!, key)) throw runtimeError(`unknown declared field '${String(key)}'`);
            const field = obj.descriptor.fields![key];
            const value = await compute(() => this.getKey(obj.fields, key), field.type);
            assertComplete(value);
            const checked = validateValue(value, field.type, `${obj.descriptor.name}.${key}`);
            this.observer.mutate(obj.fields, env, key, !this.opts.trace?.replaying, () => setKey(obj.fields, key, checked));
            return;
        }
        if (target.t === 'member') {
            if (!isDict(obj)) throw runtimeError(`cannot set member '${target.name}' on ${typeName(obj)}`);
            const value = await compute(() => this.getKey(obj, target.name), contractOf(obj)?.fields?.[target.name]?.type);
            assertComplete(value);
            this.observer.mutate(obj, env, target.name, !this.opts.trace?.replaying, () => mutateContract(obj, draft => { setKey(draft as Record<string, Value>, target.name, value); return null; }));
            return;
        }
        const index = await this.eval(target.index, env);
        if (isList(obj)) {
            const i = this.listIndex(obj, index);
            const value = await compute(() => obj[i], contractOf(obj)?.element);
            assertComplete(value);
            this.observer.mutate(obj, env, String(i), !this.opts.trace?.replaying, () => mutateContract(obj, draft => { (draft as Value[])[i] = value; return null; }));
        } else if (isDict(obj)) {
            if (typeof index !== 'string') throw runtimeError(`dict keys must be strings, got ${typeName(index)}`);
            const value = await compute(() => this.getKey(obj, index), contractOf(obj)?.fields?.[index]?.type);
            assertComplete(value);
            this.observer.mutate(obj, env, index, !this.opts.trace?.replaying, () => mutateContract(obj, draft => { setKey(draft as Record<string, Value>, index, value); return null; }));
        } else {
            throw runtimeError(`${typeName(obj)} does not support item assignment`);
        }
    }

    // ---- expressions ---------------------------------------------------

    private async text(parts: StrPart[], env: Env): Promise<string> {
        let out = '';
        for (const p of parts) out += typeof p === 'string' ? p : str(await this.eval(p, env));
        return out;
    }

    private async eval(e: Expr, env: Env, expected?: TypeDescriptor): Promise<Value> {
        switch (e.t) {
            case 'num':
                if (expected?.kind === 'int' || expected?.kind === 'float' || expected?.kind === 'union' && expected.members!.some(type => type.kind === 'int' || type.kind === 'float')) {
                    const token = e.raw ?? String(e.v);
                    return /[.eE]/.test(token) ? typedFloat(Number(token)) : checkedInt(BigInt(token));
                }
                return e.v;
            case 'group': return this.eval(e.e, env, expected);
            case 'type': return this.type(e.type, env);
            case 'str': return this.text(e.parts, env);
            case 'bool': return e.v;
            case 'none': return null;
            case 'lambda': return this.makeLambda(e, env, expected?.kind === 'fn' ? expected.params : undefined, expected?.kind === 'fn' ? expected.result : undefined);
            case 'block':
            case 'if': {
                const completion = await this.execStmt(e, env);
                if (completion && completion.k !== 'value') throw new ExpressionSignal(completion);
                return completion?.v ?? null;
            }
            case 'log': {
                const level = await this.eval(e.level, env);
                if (level !== 'error' && level !== 'info' && level !== 'debug') {
                    throw runtimeError("log level must be 'error', 'info' or 'debug'");
                }
                const args = await this.evalArgs(e.args, env);
                this.logValues(level, args);
                return null;
            }
            case 'name': return this.lookup(e.name, env);
            case 'special':
                if (e.name === 'env') {
                    this.opts.trace?.observeEnvironment(this.runtimeEnv);
                    this.opts.pin?.observeEnvironment(this.runtimeEnv);
                }
                return e.name === 'env' ? this.runtimeEnv : this.runtimeArgs;
            case 'human': {
                const question = await this.eval(e.prompt, env);
                if (typeof question !== 'string') throw runtimeError('human question must be a string');
                return this.askHuman(question, e.line);
            }
            case 'list': {
                const out: Value[] = [];
                const elements = expected?.kind === 'union' ? expected.members!.filter(type => type.kind === 'list').map(type => type.element!)
                    : expected?.kind === 'list' ? [expected.element!] : [];
                const element = this.unionContext(elements);
                for (const it of e.items) out.push(await this.eval(it, env, element));
                assertComplete(out);
                return out;
            }
            case 'dict': {
                const d = newDict();
                for (const entry of e.entries) {
                    if (!Array.isArray(entry)) {
                        setKey(d, entry.name, this.makeFunction(entry, env));
                        continue;
                    }
                    const [k, v] = entry;
                    const key = await this.eval(k, env);
                    if (typeof key !== 'string') throw runtimeError(`dict keys must be strings, got ${typeName(key)}`);
                    const fields = expected?.kind === 'union' ? expected.members!.flatMap(type => type.fields?.[key] ? [type.fields[key].type] : [])
                        : expected?.fields?.[key] ? [expected.fields[key].type] : [];
                    setKey(d, key, await this.eval(v, env, this.unionContext(fields)));
                }
                assertComplete(d);
                return d;
            }
            case 'unary': {
                if (this.isNumericLiteral(e) && expected && (expected.kind === 'int' || expected.kind === 'float' || expected.kind === 'union' && expected.members!.some(type => type.kind === 'int' || type.kind === 'float'))) {
                    const literal = this.signedLiteral(e);
                    if (!/[.eE]/.test(literal.token)) return checkedInt(BigInt(literal.sign) * BigInt(literal.token));
                    return typedFloat(literal.sign * Number(literal.token));
                }
                const v = await this.eval(e.e, env);
                if (e.op === 'not') return !truthy(v);
                if (typeof v === 'bigint') return checkedInt(e.op === '-' ? -v : v);
                if (isFloat(v)) return typedFloat(e.op === '-' ? -v.__float : v.__float);
                if (typeof v !== 'number') throw runtimeError(`bad operand for unary ${e.op}: ${typeName(v)}`);
                return e.op === '-' ? -v : v;
            }
            case 'binary': {
                let left = await this.eval(e.l, env, expected);
                let right = await this.eval(e.r, env, expected ?? this.numericType(left));
                if (this.numericType(right) && this.isNumericLiteral(e.l) && !this.numericType(left)) left = await this.eval(e.l, env, this.numericType(right));
                return this.binary(e.op, left, right);
            }
            case 'logic': {
                const l = await this.eval(e.l, env);
                if (e.op === 'and') return truthy(l) ? this.eval(e.r, env) : l;
                return truthy(l) ? l : this.eval(e.r, env);
            }
            case 'compare': {
                let left = await this.eval(e.operands[0], env);
                for (let i = 0; i < e.ops.length; i++) {
                    let right = await this.eval(e.operands[i + 1], env);
                    if (this.isNumericLiteral(e.operands[i + 1]) && this.numericType(left)) right = await this.eval(e.operands[i + 1], env, this.numericType(left));
                    if (i === 0 && this.isNumericLiteral(e.operands[0]) && this.numericType(right)) left = await this.eval(e.operands[0], env, this.numericType(right));
                    if (!this.compare(e.ops[i], left, right)) return false;
                    left = right;
                }
                return true;
            }
            case 'ternary':
                return truthy(await this.eval(e.cond, env)) ? this.eval(e.then, env, expected) : this.eval(e.else, env, expected);
            case 'call': return this.evalCall(e.callee, e.args, env);
            case 'member': {
                const obj = await this.eval(e.obj, env);
                if (isInstance(obj)) {
                    if (hasKey(obj.fields, e.name)) return this.getKey(obj.fields, e.name);
                    const methods = obj.descriptor.methods;
                    const method = methods && Object.hasOwn(methods, e.name) ? methods[e.name] : undefined;
                    if (method && e.name !== obj.descriptor.name) return { ...method, self: obj };
                    throw runtimeError(`member '${e.name}' is not initialized or declared`);
                }
                if (!isDict(obj)) throw runtimeError(`${typeName(obj)} has no member '${e.name}'`);
                return this.getKey(obj, e.name);
            }
            case 'index': return this.index(await this.eval(e.obj, env), await this.eval(e.index, env));
            case 'slice': {
                const obj = await this.eval(e.obj, env);
                const lo = e.lo ? await this.eval(e.lo, env) : undefined;
                const hi = e.hi ? await this.eval(e.hi, env) : undefined;
                return this.slice(obj, lo, hi);
            }
            case 'ask':
            case 'think':
            case 'agent':
                return this.evalGeneration(e.t, e.mods, e.prompt, env);
        }
    }

    private getKey(d: { [key: string]: Value }, k: string): Value {
        if (!hasKey(d, k)) {
            if (d === this.runtimeEnv) return null;
            throw runtimeError(`key '${k}' not found`);
        }
        const type = contractOf(d)?.fields?.[k]?.type;
        return type?.kind === 'fn' ? validateValue(d[k], type, k) : d[k];
    }

    private async evalCall(callee: Expr, argExprs: Expr[], env: Env): Promise<Value> {
        if (callee.t === 'member') {
            const obj = await this.eval(callee.obj, env);
            if (isInstance(obj)) {
                const methods = obj.descriptor.methods;
                const method = methods && Object.hasOwn(methods, callee.name) ? methods[callee.name] : undefined;
                if (!method || callee.name === obj.descriptor.name) throw runtimeError(`unknown instance method '${callee.name}'`);
                return this.callValue({ ...method, self: obj }, await this.evalArgs(argExprs, env, method.paramTypes));
            }
            if (isDict(obj) && !hasBuiltinMethod(obj, callee.name)) {
                const fn = this.getKey(obj, callee.name);
                return this.callValue(fn, await this.evalArgs(argExprs, env, this.callParams(fn)));
            }
            if (isList(obj) && isListCallbackMethod(callee.name)) {
                const args: Value[] = [];
                for (const [i, arg] of argExprs.entries()) {
                    const expected = callee.name === 'reduce' && i === 1 ? this.callParams(args[0])?.[0] ?? contractOf(obj)?.element : undefined;
                    args.push(await this.eval(arg, env, expected));
                }
                args.forEach(value => assertComplete(value));
                return callMethod(obj, callee.name, args, (fn, values) => this.callValue(fn, values));
            }
            const type = contractOf(obj);
            const expected: (TypeDescriptor | undefined)[] = callee.name === 'append' ? [type?.element]
                : callee.name === 'insert' ? [undefined, type?.element]
                : callee.name === 'extend' || callee.name === 'update' ? [type] : [];
            const args = await this.evalArgs(argExprs, env, expected);
            args.forEach(value => assertComplete(value));
            return typeof obj === 'object' && obj !== null && isMutatingMethod(obj, callee.name)
                ? this.observer.mutate(obj, env, callee.name, !this.opts.trace?.replaying, () => callMethod(obj, callee.name, args))
                : callMethod(obj, callee.name, args);
        }
        if (callee.t === 'name' && (callee.name === 'validate' || callee.name === 'isinstance')) {
            if (argExprs.length !== 2) throw runtimeError(`${callee.name}() takes 2 arguments`);
            const value = await this.eval(argExprs[0], env);
            const type = await this.eval(argExprs[1], env);
            if (!isDescriptor(type)) throw runtimeError(`${callee.name}() requires a type descriptor`);
            return callee.name === 'validate' ? validateType(value, type) : testValue(value, type);
        }
        if (callee.t === 'name' && callee.name === 'struct') {
            if (argExprs.length !== 1) throw runtimeError('struct() takes one class descriptor');
            const type = await this.eval(argExprs[0], env);
            if (!isDescriptor(type) || type.kind !== 'class') throw runtimeError('struct() requires a class descriptor');
            return descriptor('struct', `struct(${type.name})`, { fields: type.fields });
        }
        const fn = await this.eval(callee, env);
        const args = await this.evalArgs(argExprs, env, this.callParams(fn));
        return this.callValue(fn, args);
    }

    private callParams(fn: Value): readonly (TypeDescriptor | undefined)[] | undefined {
        if (isDescriptor(fn) && fn.kind === 'class') return fn.methods?.[fn.name]?.paramTypes;
        if (!isFunction(fn)) return undefined;
        return signatureOf(fn)?.params ?? (fn.__fn === 'user' ? fn.paramTypes : undefined) ?? contractOf(fn)?.params;
    }

    private async callValue(fn: Value, args: Value[]): Promise<Value> {
        args.forEach(value => assertComplete(value));
        if (isDescriptor(fn)) {
            switch (fn.kind) {
                case 'int': if (args.length === 1) return convertInt(args[0]); break;
                case 'float': if (args.length === 1) return convertFloat(args[0]); break;
                case 'str': if (args.length === 1) return str(args[0]); break;
                case 'bool': if (args.length === 1) return truthy(args[0]); break;
                case 'char': if (args.length === 1) return validateValue(args[0], fn); break;
                case 'object': if (!args.length) return newDict(); if (args.length === 1) return project(args[0]); break;
                case 'class': return this.construct(fn, args);
                case 'struct':
                    if (args.length === 1) {
                        schemaForType(fn);
                        const data = project(args[0], false);
                        return validateValue(data, fn);
                    }
                    break;
            }
            throw runtimeError(`${fn.name}() received unsupported arguments`);
        }
        if (!isFunction(fn)) throw runtimeError(`${typeName(fn)} is not callable`);
        const guard = fn.__fn === 'builtin' ? fn.signature : contractOf(fn);
        if (guard) {
            if (args.length !== guard.params!.length) throw runtimeError(`${fn.name}() takes ${guard.params!.length} arguments`);
            args = args.map((value, i) => validateValue(value, guard.params![i], `argument[${i}]`));
        }
        const result = fn.__fn === 'builtin' ? fn.target ? await this.callValue(fn.target, args) : await fn.call(args) : await this.callUser(fn, args);
        assertComplete(result);
        return guard ? validateValue(result, guard.result!, 'return') : result;
    }

    private async construct(type: TypeDescriptor, args: Value[]): Promise<InstanceValue> {
        const instance = registerInstance({ __instance: true, descriptor: type, fields: newDict(), complete: false });
        const constructor = type.methods?.[type.name];
        if (constructor) await this.callUser({ ...constructor, self: instance }, args);
        else if (args.length || Object.keys(type.fields!).length) throw runtimeError(`${type.name} requires an explicit constructor initializing all fields`);
        validateValue(instance.fields, descriptor('struct', `fields(${type.name})`, { fields: type.fields }), type.name);
        instance.complete = true;
        return instance;
    }

    private async evalArgs(exprs: Expr[], env: Env, expected?: readonly (TypeDescriptor | undefined)[]): Promise<Value[]> {
        const out: Value[] = [];
        for (const [i, a] of exprs.entries()) out.push(await this.eval(a, env, expected?.[i]));
        return out;
    }

    private async callUser(fn: UserFunction, args: Value[]): Promise<Value> {
        if (args.length !== fn.params.length) {
            throw runtimeError(`${fn.name}() takes ${fn.params.length} argument(s) but ${args.length} were given`);
        }
        if (this.depth >= this.maxDepth) throw runtimeError(`maximum call depth (${this.maxDepth}) exceeded`);
        const local = this.childScope(fn.closure, 'function', `${fn.name}()`);
        fn.params.forEach((name, index) => {
            const type = fn.paramTypes?.[index];
            const value = type ? validateValue(args[index], type, `argument.${name}`) : args[index];
            if (type) (local.contracts ??= new Map()).set(name, type);
            this.commit(local, name, value);
        });
        if (fn.self) local.vars.set('self', fn.self);
        const savedLines = this.sourceLines;
        const savedUri = this.sourceUri;
        const savedVersion = this.sourceVersion;
        const savedReturn = this.returnType;
        this.returnType = fn.returnType;
        this.sourceLines = fn.source?.lines ?? savedLines;
        this.sourceUri = fn.source?.uri ?? savedUri;
        this.sourceVersion = fn.source?.version ?? savedVersion;
        this.depth++;
        try {
            const sig = await this.execBlock(fn.body, local);
            if (sig && sig.k !== 'return' && sig.k !== 'value') throw runtimeError(`'${sig.k}' outside of a loop`);
            const value = sig?.k === 'return' ? sig.v : null;
            assertComplete(value);
            return fn.returnType ? validateValue(value, fn.returnType, `${fn.name}.return`) : value;
        } finally {
            this.depth--;
            this.sourceLines = savedLines;
            this.sourceUri = savedUri;
            this.sourceVersion = savedVersion;
            this.returnType = savedReturn;
        }
    }

    // ---- operators -----------------------------------------------------

    private numericType(value: Value): TypeDescriptor | undefined {
        return typeof value === 'bigint' ? primitives.get('int') : isFloat(value) ? primitives.get('float') : undefined;
    }

    private unionContext(types: TypeDescriptor[]): TypeDescriptor | undefined {
        if (!types.length) return undefined;
        return types.length === 1 ? types[0] : descriptor('union', types.map(type => type.name).join(' | '), { members: types });
    }

    private isNumericLiteral(expr: Expr): boolean {
        return expr.t === 'num' || expr.t === 'unary' && expr.op !== 'not' && this.isNumericLiteral(expr.e)
            || expr.t === 'group' && this.isNumericLiteral(expr.e);
    }

    private signedLiteral(expr: Expr): { token: string; sign: number } {
        if (expr.t === 'num') return { token: expr.raw ?? String(expr.v), sign: 1 };
        if (expr.t === 'group') return this.signedLiteral(expr.e);
        if (expr.t === 'unary' && expr.op !== 'not') {
            const literal = this.signedLiteral(expr.e);
            return { token: literal.token, sign: expr.op === '-' ? -literal.sign : literal.sign };
        }
        throw runtimeError('expected a numeric literal');
    }
    private binary(op: string, l: Value, r: Value): Value {
        if (typeof l === 'bigint' && typeof r === 'bigint') {
            if ((op === '/' || op === '//' || op === '%') && r === 0n) throw runtimeError('division by zero');
            switch (op) {
                case '+': return checkedInt(l + r);
                case '-': return checkedInt(l - r);
                case '*': return checkedInt(l * r);
                case '/': return typedFloat(Number(l) / Number(r));
                case '//': {
                    const quotient = l / r;
                    return checkedInt(l % r !== 0n && (l < 0n) !== (r < 0n) ? quotient - 1n : quotient);
                }
                case '%': return checkedInt(((l % r) + r) % r);
                case '**':
                    if (r < 0n) throw runtimeError('integer exponent must be nonnegative; convert explicitly to float');
                    if (l === 0n) return r === 0n ? 1n : 0n;
                    if (l === 1n) return 1n;
                    if (l === -1n) return r % 2n ? -1n : 1n;
                    if (r > 63n && l !== 0n && l !== 1n && l !== -1n) throw runtimeError('int overflow');
                    return checkedInt(l ** r);
            }
        }
        if (isFloat(l) && isFloat(r)) {
            const x = l.__float, y = r.__float;
            if ((op === '/' || op === '//' || op === '%') && y === 0) throw runtimeError('division by zero');
            switch (op) {
                case '+': return typedFloat(x + y);
                case '-': return typedFloat(x - y);
                case '*': return typedFloat(x * y);
                case '/': return typedFloat(x / y);
                case '//': return typedFloat(Math.floor(x / y));
                case '%': return typedFloat(((x % y) + y) % y);
                case '**': return typedFloat(x ** y);
            }
        }
        if (op === '*' && (typeof l === 'bigint' || typeof r === 'bigint')) {
            const count = typeof l === 'bigint' ? l : r;
            const sequence = typeof l === 'bigint' ? r : l;
            if (typeof count === 'bigint' && (typeof sequence === 'string' || isList(sequence))) {
                if (count > BigInt(Number.MAX_SAFE_INTEGER)) throw runtimeError('repetition count exceeds the supported sequence size');
                const n = Number(count < 0n ? 0n : count);
                return typeof sequence === 'string' ? sequence.repeat(n) : Array.from({ length: n }, () => sequence).flat();
            }
        }
        if (this.numericType(l) || this.numericType(r)) throw new Failure('type_error', `mixed numeric arithmetic requires explicit conversion (${typeName(l)}, ${typeName(r)})`);
        if (op === '+') {
            if (typeof l === 'number' && typeof r === 'number') return l + r;
            if (typeof l === 'string' && typeof r === 'string') return l + r;
            if (isList(l) && isList(r)) return [...l, ...r];
            throw runtimeError(`unsupported operand types for +: ${typeName(l)} and ${typeName(r)} (use "{...}" interpolation or str())`);
        }
        if (op === '*') {
            if (typeof l === 'number' && typeof r === 'number') return l * r;
            const [seq, n] = typeof l === 'number' ? [r, l] : [l, r];
            if ((typeof seq === 'string' || isList(seq)) && typeof n === 'number' && Number.isInteger(n)) {
                if (typeof seq === 'string') return seq.repeat(Math.max(0, n));
                return Array.from({ length: Math.max(0, n) }, () => seq).flat();
            }
            throw runtimeError(`unsupported operand types for *: ${typeName(l)} and ${typeName(r)}`);
        }
        if (typeof l !== 'number' || typeof r !== 'number') {
            throw runtimeError(`unsupported operand types for ${op}: ${typeName(l)} and ${typeName(r)}`);
        }
        switch (op) {
            case '-': return l - r;
            case '/':
                if (r === 0) throw runtimeError('division by zero');
                return l / r;
            case '//':
                if (r === 0) throw runtimeError('division by zero');
                return Math.floor(l / r);
            case '%':
                if (r === 0) throw runtimeError('modulo by zero');
                return ((l % r) + r) % r;
            case '**': return l ** r;
        }
        throw runtimeError(`unknown operator ${op}`);
    }

    private compare(op: string, l: Value, r: Value): boolean {
        if ((op === '==' || op === '!=') && (this.numericType(l) || this.numericType(r))
            && (typeof l === 'bigint' || typeof l === 'number' || isFloat(l))
            && (typeof r === 'bigint' || typeof r === 'number' || isFloat(r))) {
            const same = compareValues(l, r) === 0;
            return op === '==' ? same : !same;
        }
        switch (op) {
            case '==': return equals(l, r);
            case '!=': return !equals(l, r);
            case '<': return compareValues(l, r) < 0;
            case '<=': return compareValues(l, r) <= 0;
            case '>': return compareValues(l, r) > 0;
            case '>=': return compareValues(l, r) >= 0;
            case 'in': return this.contains(r, l);
            case 'not in': return !this.contains(r, l);
        }
        throw runtimeError(`unknown comparison ${op}`);
    }

    private contains(container: Value, item: Value): boolean {
        if (typeof container === 'string') {
            if (typeof item !== 'string') throw runtimeError(`'in <string>' requires a string, got ${typeName(item)}`);
            return container.includes(item);
        }
        if (isList(container)) return container.some((x) => equals(x, item));
        if (isDict(container)) return typeof item === 'string' && hasKey(container, item);
        throw runtimeError(`argument of type ${typeName(container)} is not a container`);
    }

    private listIndex(list: Value[] | string, index: Value): number {
        if (typeof index === 'bigint') {
            if (index < BigInt(Number.MIN_SAFE_INTEGER) || index > BigInt(Number.MAX_SAFE_INTEGER)) throw runtimeError(`index ${index} out of range`);
            index = Number(index);
        }
        if (typeof index !== 'number' || !Number.isInteger(index)) throw runtimeError(`indices must be integers, got ${typeName(index)}`);
        const i = index < 0 ? list.length + index : index;
        if ((i < 0 || i >= list.length) && list !== this.runtimeArgs) throw runtimeError(`index ${index} out of range`);
        return i;
    }

    private index(obj: Value, index: Value): Value {
        if (isList(obj)) return contractRead(obj, this.listIndex(obj, index)) ?? null;
        if (typeof obj === 'string') {
            const chars = Array.from(obj);
            return chars[this.listIndex(chars, index)];
        }
        if (isDict(obj)) {
            if (typeof index !== 'string') throw runtimeError(`dict keys must be strings, got ${typeName(index)}`);
            return this.getKey(obj, index);
        }
        throw runtimeError(`${typeName(obj)} is not subscriptable`);
    }

    private slice(obj: Value, lo: Value | undefined, hi: Value | undefined): Value {
        if (typeof obj !== 'string' && !isList(obj)) throw runtimeError(`${typeName(obj)} cannot be sliced`);
        const items = typeof obj === 'string' ? Array.from(obj) : obj;
        const bound = (v: Value | undefined, dflt: number): number => {
            if (v === undefined) return dflt;
            if (typeof v === 'bigint') v = Number(v);
            if (typeof v !== 'number' || !Number.isInteger(v)) throw runtimeError('slice indices must be integers');
            return Math.min(Math.max(v < 0 ? items.length + v : v, 0), items.length);
        };
        const part = items.slice(bound(lo, 0), bound(hi, items.length));
        return typeof obj === 'string' ? part.join('') : part;
    }

    // ---- LLM and tools -------------------------------------------------

    private async callLlm(req: LlmRequest, preface: string): Promise<string> {
        return (await this.callLlmResponse(req, undefined, preface)).text.trim();
    }

    private async callLlmResponse(req: LlmRequest, interaction: ModelInteraction = {
        requestId: randomUUID(), kind: req.naturalLanguage ? 'blockquote' : req.kind,
    }, preface = ''): Promise<LlmResponse> {
        const { logger, backend } = this.opts;
        if (this.program.markdown) {
            preface = [RUNTIME_PREAMBLE, this.program.markdown.preamble, preface].filter(Boolean).join('\n\n');
            req = { ...req, prompt: [
                RUNTIME_PREAMBLE, this.program.markdown.preamble, req.prompt,
            ].filter(Boolean).join('\n\n') };
        }
        const replaying = this.opts.trace?.replaying;
        if (!replaying) logger.modelPrompt(interaction, req.prompt, preface);
        const originalStream = req.onStream;
        let receiving = true;
        if (!replaying && (logger.streamsModels || originalStream)) req = { ...req, onStream: update => {
            if (!receiving) return;
            originalStream?.(update);
            if (update.channel !== 'reasoning' || req.showReasoning) logger.modelStream({ type: 'update', interaction, update });
        } };
        let completed = false;
        const started = Date.now();
        try {
            const perform = async () => {
                try {
                    return await backend.call(req);
                } catch (error) {
                    if (error instanceof Failure || error instanceof TraceError || error instanceof PinError ||
                        error instanceof SuccessSignal) throw error;
                    throw new Failure('llm_error', error instanceof Error ? error.message : String(error));
                }
            };
            const journal = this.opts.trace ?? this.opts.pin;
            const res = journal && !req.naturalLanguage
                ? await journal.effect({ kind: 'llm', request: traceRequest(req), restrictions: req.restrictions.list }, perform, isResponse)
                : await perform();
            if (!isResponse(res)) throw new Failure('llm_error', 'backend returned an invalid response; blockquotes require runtime actions, not submitted SPL');
            if (!replaying) {
                receiving = false;
                logger.modelStream({ type: 'end', interaction, outcome: 'completed', response: res.text,
                    ...(req.showReasoning && res.reasoning !== undefined ? { reasoning: res.reasoning } : {}) });
                completed = true;
                logger.info(`llm ${req.kind} call: ${JSON.stringify(res.effective)} (${Date.now() - started} ms)`);
                logger.modelOutput({ ...interaction, role: 'response' }, res.text);
            }
            return res;
        } catch (e) {
            if (e instanceof TraceError || e instanceof PinError || e instanceof SuccessSignal) throw e;
            if (e instanceof Failure) throw e;
            if (e instanceof LlmError) throw new Failure('llm_error', e.message);
            throw new Failure('llm_error', (e as Error).message ?? String(e));
        } finally {
            receiving = false;
            if (!replaying && !completed) logger.modelStream({ type: 'end', interaction, outcome: 'failed' });
        }
    }

    private async execNatural(text: string, line: number, env: Env): Promise<Completion> {
        const bindings: Record<string, unknown> = Object.create(null);
        for (let scope: Env | undefined = env; scope; scope = scope.parent) {
            for (const [name, value] of scope.vars) {
                if (Object.hasOwn(bindings, name)) continue;
                bindings[name] = describeValue(value);
            }
        }
        const history: unknown[] = [];
        let interaction: ModelInteraction = { requestId: randomUUID(), kind: 'blockquote' };
        const savedRestrictions = this.restrictions;
        const savedConstraints = this.constraints;
        try {
            const trace = this.opts.trace;
            const journal = trace ?? this.opts.pin;
            const decisionRequest = () => ({
                kind: 'natural', text, line, history: JSON.stringify(history), restrictions: this.restrictions.list,
            });
            const decision = (perform: () => Promise<LlmResponse>) => journal
                ? journal.effect(decisionRequest(), perform, isResponse)
                : perform();
            const execute = async (action: RuntimeAction): Promise<unknown> => {
                if (!trace?.replaying) this.opts.logger.modelOutput({ ...interaction, role: 'action' }, JSON.stringify(action));
                const result = { value: describeValue(await this.execNaturalAction(action, line, env)) };
                history.push({ action, result });
                return result.value;
            };
            for (;;) {
                interaction = { requestId: randomUUID(), kind: 'blockquote' };
                if (trace?.replaying || this.opts.pin?.replaying) {
                    const response = await decision(async () => { throw new TraceError('missing recorded runtime decision'); });
                    if (!response.action) return;
                    await execute(response.action);
                    continue;
                }
                trace?.assertLive(decisionRequest());
                let actionFailed = false;
                const context = `${NATURAL_PREAMBLE}\n\nAvailable builtin names: ${[...this.builtins.keys()].join(', ')}\n\nShared bindings at command start:\n${JSON.stringify(bindings)}`;
                const built = buildPromptParts({
                    prompt: `${context}\n\nBlockquote:\n${text}\n\nCompleted turns and action results:\n${JSON.stringify(history)}`,
                    constraints: this.constraints, restrictions: this.restrictions,
                });
                const request: LlmRequest = {
                    kind: 'agent', naturalLanguage: true, runtimeTools: AGENT_TOOLS,
                    prompt: built.prompt,
                    model: this.model, reasoningEffort: 'medium', showReasoning: true,
                    restrictions: this.restrictions, tools: new ToolHost(this.restrictions, this.cwd),
                    currentRestrictions: () => this.restrictions,
                    invokeAction: async action => {
                        try {
                            await decision(async () => ({ text: 'Runtime action.', effective: {}, action }));
                            return await execute(action);
                        } catch (error) {
                            actionFailed = true;
                            throw error;
                        }
                    },
                };
                let response: LlmResponse;
                try {
                    response = await this.callLlmResponse(request, interaction, [built.preface, context].filter(Boolean).join('\n\n'));
                } catch (error) {
                    if (journal && !actionFailed && error instanceof Failure) {
                        await decision(async () => { throw error; });
                    }
                    throw error;
                }
                await decision(async () => response);
                if (!response.action) return;
                await execute(response.action);
            }
        } finally {
            this.restrictions = savedRestrictions;
            this.constraints = savedConstraints;
        }
    }

    private async askHuman(question: string, line: number): Promise<string> {
        const journal = this.opts.trace ?? this.opts.pin;
        if (journal) return journal.effect({ kind: 'human', question, line },
            () => this.directHuman(question, line), (value): value is string => typeof value === 'string');
        return this.directHuman(question, line);
    }

    private async directHuman(question: string, line: number): Promise<string> {
        if (!this.opts.human) throw runtimeError('human input requires a human handler');
        const answer = await this.opts.human(question, line);
        if (typeof answer !== 'string') throw runtimeError('human answer must be a string');
        return answer;
    }

    private async execNaturalAction(action: RuntimeAction, line: number, env: Env): Promise<Value> {
        const args = actionArguments(action);
        switch (action.name) {
            case 'load_variable': {
                const value = args.name === '$args' ? this.runtimeArgs : this.lookup(String(args.name), env);
                return isDescriptor(value) ? schemaForType(value) : value;
            }
            case 'save_variable': {
                const name = String(args.name);
                const schema = typeof args.schema === 'string' ? this.lookup(args.schema, env) : args.schema;
                const target = isDescriptor(schema) ? schema : undefined;
                if ('schema' in args && !target) compileSchema(schema)(args.value);
                const scope = this.bindingScope(name, env) ?? env;
                if (isFunction(scope.vars.get(name)) || this.builtins.has(name)) {
                    throw runtimeError(`cannot replace function '${name}' with a variable`);
                }
                const type = target ?? scope.contracts?.get(name);
                const value = type ? decodeJsonValue(args.value, type, name) : args.value;
                this.commit(scope, name, value);
                return value;
            }
            case 'call_function': {
                const fn = this.lookup(String(args.name), env);
                if (!isFunction(fn)) throw runtimeError(`'${args.name}' is not callable`);
                if (!isList(args.args)) throw runtimeError('function arguments must be a list');
                const params = this.callParams(fn);
                const values = args.args.map((value, index) => {
                    const type = params?.[index];
                    return type ? decodeJsonValue(value, type, `argument[${index}]`) : value;
                });
                return this.callValue(fn, values);
            }
            case 'get_env': {
                this.opts.pin?.observeEnvironment(this.runtimeEnv);
                const perform = () => this.getKey(this.runtimeEnv, String(args.name));
                return this.opts.trace
                    ? this.opts.trace.effect({ kind: 'environment-value', name: args.name }, perform, isToolValue)
                    : perform();
            }
            case 'ask_human':
                return this.askHuman(String(args.question), line);
            case 'success':
                throw new SuccessSignal(args.value);
            case 'fail':
                throw new Failure('explicit_failure', String(args.reason));
            case 'restrict': {
                const kind = args.kind;
                if (kind !== 'fs' && kind !== 'exec' && kind !== 'net' && kind !== 'mcp') throw runtimeError('invalid restriction kind');
                this.restrictions = this.restrictions.with(await this.makeRestriction(kind, args.value));
                return null;
            }
            case 'set_guidance': {
                const kind = args.kind;
                if (kind !== 'enforce' && kind !== 'forbid') throw runtimeError('invalid guidance kind');
                this.constraints = [...this.constraints, { kind, text: String(args.text) }];
                return null;
            }
            default: {
                const tool = Object.values(TOOL_SPECS).find(spec => spec.name === action.name);
                if (!tool) throw runtimeError(`unknown blockquote tool '${action.name}'`);
                return this.callTool(tool.name, tool.required.map(name => args[name]));
            }
        }
    }

    private async callTool(tool: ToolName, args: Value[]): Promise<Value> {
        const names = TOOL_SPECS[tool].required;
        if (args.length !== names.length) throw runtimeError(`${tool}() takes ${names.length} argument(s) but ${args.length} were given`);
        const params: Record<string, string> = {};
        names.forEach((name, i) => {
            if (typeof args[i] !== 'string') throw runtimeError(`${tool}(): ${name} must be a string`);
            params[name] = args[i];
        });
        const perform = async () => new ToolHost(this.restrictions, this.cwd, false, true).invoke(tool, params);
        const journal = this.opts.trace ?? this.opts.pin;
        return journal
            ? journal.effect({ kind: 'tool', tool, params, restrictions: this.restrictions.list }, perform, (value): value is string => typeof value === 'string')
            : perform();
    }

    private async makeRestriction(kind: Restriction['kind'], value: Value): Promise<Restriction> {
        const perform = () => makeRestriction(kind, value, this.cwd);
        const journal = this.opts.trace ?? this.opts.pin;
        return journal
            ? journal.effect({ kind: 'restriction', restriction: kind, value }, perform,
                (result): result is Restriction => isDict(result) && result.kind === kind
                    && Array.isArray(result.values) && result.values.every(item => typeof item === 'string'))
            : perform();
    }

    private async evalGeneration(
        kind: LlmRequest['kind'], mods: Record<string, Expr>, promptExpr: Expr, env: Env,
    ): Promise<Value> {
        const options: Record<string, Value> = {};
        for (const [name, expr] of Object.entries(mods)) setKey(options, name, await this.eval(expr, env));
        const sampling = Object.fromEntries(Object.entries(options).filter(([name]) => ['seed', 'temperature', 'top_p'].includes(name)));
        const randomness = kind === 'ask' && Object.keys(sampling).length ? validateRandomness(sampling) : undefined;
        const { len, reasoning = kind === 'ask' ? undefined : 'medium', hide = false, repairs = 0, model } = options;
        const tokens = 'tokens' in options ? validateTokens(options.tokens) : undefined;
        const fmt = options.fmt ?? ('schema' in options ? 'json' : 'text');
        if (len !== undefined && len !== 'word' && len !== 'sentence' && len !== 'paragraph' && len !== 'long') throw runtimeError('len must be word, sentence, paragraph, or long');
        if (fmt !== 'integer' && fmt !== 'float' && fmt !== 'array' && fmt !== 'object' && fmt !== 'text' && fmt !== 'boolean' && fmt !== 'json') {
            throw runtimeError('fmt must be integer, float, array, object, text, boolean, or json');
        }
        if (reasoning !== undefined && reasoning !== 'low' && reasoning !== 'medium' && reasoning !== 'high') throw runtimeError('reasoning must be low, medium, or high');
        if (typeof hide !== 'boolean') throw runtimeError('hide must be True or False');
        if (model !== undefined && (typeof model !== 'string' || !model.trim())) throw runtimeError('model must be a non-empty string');
        if (typeof repairs !== 'number' || !Number.isInteger(repairs) || repairs < 0 || repairs > 5) throw runtimeError('repairs must be an integer from 0 to 5');
        if (kind === 'agent' && repairs !== 0) throw runtimeError('agents cannot use repairs: external actions must not be retried automatically');
        if (fmt === 'text' && ('schema' in options || repairs !== 0)) throw runtimeError('schema and repairs require JSON output');
        const target = isDescriptor(options.schema) ? options.schema : undefined;
        const schema = target ? schemaForType(target) : options.schema;
        const validate = 'schema' in options && !target ? compileSchema(schema) : undefined;
        const built = buildPromptParts({
            prompt: str(await this.eval(promptExpr, env)),
            mods: { len, fmt },
            thinking: reasoning !== undefined,
            constraints: this.constraints,
            restrictions: this.restrictions,
        });
        let prompt = built.prompt;
        if (fmt === 'json') prompt += '\n\nReturn ONLY valid JSON, without prose or code fences.';
        if ('schema' in options) prompt += `\n\nThe result must satisfy this JSON Schema:\n${JSON.stringify(toJson(schema))}`;
        const basePrompt = prompt;
        for (let attempt = 0; ; attempt++) {
            const text = await this.callLlm({
                kind, prompt,
                model: this.opts.pin?.data.context.model ?? this.opts.model ?? model ?? this.model,
                reasoningEffort: reasoning,
                ...(tokens !== undefined ? { tokens } : {}),
                ...(randomness !== undefined ? { randomness: { ...randomness } } : {}),
                showReasoning: !hide,
                restrictions: this.restrictions,
                tools: new ToolHost(this.restrictions, this.cwd),
            }, built.preface);
            try {
                const value = target ? decodeTypedJson(text, target, fmt === 'text' ? undefined : fmt) : fmt === 'text' ? text : parseJsonResponse(text, fmt);
                validate?.(value);
                return value;
            } catch (e) {
                if (!(e instanceof Failure) || (e.statusCode !== 'invalid_format' && e.statusCode !== 'validation_failed' && !(target && e.statusCode === 'type_error')) || attempt >= repairs) throw e;
                if (!this.opts.trace?.replaying) this.opts.logger.info(`repair ${attempt + 1}/${repairs}: ${e.reason}`);
                prompt = `${basePrompt}\n\nPrevious response:\n${text}\n\nValidation failed: ${e.reason}\nReturn a corrected JSON value.`;
            }
        }
    }
}
