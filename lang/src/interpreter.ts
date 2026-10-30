import type { AssignTarget, Expr, Program, Stmt, StrPart, ToolName } from './ast.js';
import { callMethod, isMutatingMethod, iterate, makeBuiltins } from './builtins.js';
import { Failure, SuccessSignal, type FailurePayload } from './errors.js';
import { LlmError, buildPrompt, parseJsonResponse, type Constraint, type LlmBackend, type LlmRequest, type LlmResponse, type RuntimeAction } from './llm.js';
import { AGENT_TOOLS, actionArguments } from './agent.js';
import { compileSchema } from './schema.js';
import type { Logger, LogLevel } from './logger.js';
import { Restrictions, makeRestriction } from './restrict.js';
import { MemoryStore, type VariableStore } from './store.js';
import { ToolHost, TOOL_SPECS } from './tools.js';
import { CheckpointError, SuspensionSignal, type Checkpoint, type HumanRequest } from './checkpoint.js';
import { isResponse, traceRequest } from './recording.js';
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
    isList,
    newDict,
    runtimeError,
    setKey,
    str,
    toJson,
    truthy,
    typeName,
    type Env,
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
    checkpoint?: Checkpoint;
    /** Source URI used to locate failures across interactive cells. */
    source?: string;
    sourceVersion?: number;
}

export type RunResult =
    | { status: 'success'; value: Value; hasValue: boolean }
    | { status: 'failure'; failure: FailurePayload }
    | { status: 'waiting_for_input'; request: HumanRequest };

type Signal = { k: 'break' } | { k: 'continue' } | { k: 'return'; v: Value; hasValue: boolean };
type Completion = Signal | { k: 'value'; v: Value } | undefined;

class ExpressionSignal {
    constructor(readonly signal: Signal) {}
}

export async function run(program: Program, opts: RunOptions): Promise<RunResult> {
    return new Interpreter(program, opts).run();
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

    async run(program: Program, opts: Omit<RunOptions, 'store' | 'checkpoint'>): Promise<RunResult> {
        if (this.running) throw new Error('an execution session can only run one cell at a time');
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
    private readonly builtins;
    private readonly store: VariableStore;
    private readonly cwd: string;
    private readonly model?: string;
    private readonly maxDepth: number;
    private readonly runtimeEnv = newDict();
    private readonly runtimeArgs: Value[];
    private constraints: Constraint[] = [];
    private restrictions: Restrictions;
    private depth = 0;
    private naturalDepth = 0;
    private sourceLines: string[];
    private sourceUri?: string;
    private sourceVersion?: number;
    private steps = 0;

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
        this.cwd = opts.cwd ?? process.cwd();
        this.store = opts.store ?? new MemoryStore();
        this.model = opts.model ?? program.directives.model;
        this.maxDepth = opts.maxCallDepth ?? 200;
        for (const [name, value] of Object.entries(process.env)) {
            if (value !== undefined) setKey(this.runtimeEnv, name, value);
        }
        this.runtimeArgs = [...(opts.checkpoint?.args ?? opts.args ?? [])];
        Object.freeze(this.runtimeEnv);
        Object.freeze(this.runtimeArgs);
        this.restrictions = new Restrictions(this.cwd);
        this.builtins = makeBuiltins({ log: sessionState
            ? Interpreter.sessionLog(sessionState)
            : values => this.logValues('info', values) });
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
        try {
            if (this.opts.checkpoint && (this.opts.store || this.opts.backend.mode)) {
                throw new CheckpointError('checkpoint runs cannot use stores or recording/replay backends');
            }
            this.opts.checkpoint?.validateSource(this.program.lines.join('\n'), this.opts.args);
            if (!this.opts.checkpoint && usesHuman(this.program)) {
                throw runtimeError('human input requires a checkpoint; use --checkpoint or --resume');
            }
            if (this.opts.backend.mode === 'replay' && this.opts.store) {
                throw new Failure('restriction_violation', 'replay does not allow a persistent variable store');
            }
            for (const [k, v] of Object.entries(this.store.load())) this.globals.vars.set(k, v);
            const signal = await this.execBlock(this.program.body, this.globals);
            this.opts.checkpoint?.assertConsumed();
            if (signal?.k === 'return') return { status: 'success', value: signal.v, hasValue: signal.hasValue };
            if (signal && signal.k !== 'value') throw runtimeError(`'${signal.k}' outside of a loop`);
            if (this.sessionState && signal?.k === 'value') return { status: 'success', value: signal.v, hasValue: true };
            return { status: 'success', value: null, hasValue: false };
        } catch (e) {
            if (e instanceof SuspensionSignal) return { status: 'waiting_for_input', request: e.request };
            if (e instanceof SuccessSignal) {
                this.opts.checkpoint?.assertConsumed();
                return { status: 'success', value: e.value as Value, hasValue: true };
            }
            if (e instanceof Failure) {
                this.opts.checkpoint?.assertConsumed();
                logger.error(`${e.statusCode}: ${e.reason} (line ${e.line})`);
                return { status: 'failure', failure: e.payload() };
            }
            throw e;
        } finally {
            try {
                if (!this.sessionState && !this.opts.checkpoint && this.opts.backend.mode !== 'replay') {
                    const snapshot: Record<string, Value> = {};
                    for (const [k, v] of this.globals.vars) if (!isFunction(v)) snapshot[k] = v;
                    this.store.save(snapshot);
                }
            } catch (e) {
                logger.error(`could not save variable store: ${(e as Error).message}`);
            }
        }
    }

    // ---- environments --------------------------------------------------

    private logValues(level: LogLevel, values: Value[]): void {
        if (!this.opts.checkpoint?.replaying) {
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
        this.observer.commit(env, name, value, !this.opts.checkpoint?.replaying);
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
            case 'let':
                this.commit(env, s.name, await this.eval(s.value, env));
                return;
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
                return { k: 'return', v: s.value ? await this.eval(s.value, env) : null, hasValue: s.value !== undefined };
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
                const fn: UserFunction = {
                    __fn: 'user', name: s.name, params: s.params, body: s.body, closure: env,
                    source: { lines: this.sourceLines, uri: this.sourceUri, version: this.sourceVersion },
                };
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
                throw new SuccessSignal(s.value ? await this.eval(s.value, env) : null);
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
                        const restriction = makeRestriction(clause.kind, await this.eval(clause.arg, env), this.cwd);
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
        const compute = async (current: () => Value): Promise<Value> => {
            const rhs = await this.eval(valueExpr, env);
            return op === '=' ? rhs : this.binary(op.slice(0, -1), current(), rhs);
        };
        if (target.t === 'name') {
            const scope = this.bindingScope(target.name, env);
            if (!scope) throw runtimeError(`cannot assign '${target.name}': declare a local with let first`);
            this.commit(scope, target.name, await compute(() => this.lookup(target.name, env)));
            return;
        }
        const obj = await this.eval(target.obj, env);
        assertMutable(obj);
        if (target.t === 'member') {
            if (!isDict(obj)) throw runtimeError(`cannot set member '${target.name}' on ${typeName(obj)}`);
            const value = await compute(() => this.getKey(obj, target.name));
            this.observer.mutate(obj, env, target.name, !this.opts.checkpoint?.replaying, () => setKey(obj, target.name, value));
            return;
        }
        const index = await this.eval(target.index, env);
        if (isList(obj)) {
            const i = this.listIndex(obj, index);
            const value = await compute(() => obj[i]);
            this.observer.mutate(obj, env, String(i), !this.opts.checkpoint?.replaying, () => { obj[i] = value; });
        } else if (isDict(obj)) {
            if (typeof index !== 'string') throw runtimeError(`dict keys must be strings, got ${typeName(index)}`);
            const value = await compute(() => this.getKey(obj, index));
            this.observer.mutate(obj, env, index, !this.opts.checkpoint?.replaying, () => setKey(obj, index, value));
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

    private async eval(e: Expr, env: Env): Promise<Value> {
        switch (e.t) {
            case 'num': return e.v;
            case 'str': return this.text(e.parts, env);
            case 'bool': return e.v;
            case 'none': return null;
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
                if (e.name === 'env') this.opts.checkpoint?.observeEnvironment(this.runtimeEnv);
                return e.name === 'env' ? this.runtimeEnv : this.runtimeArgs;
            case 'human': {
                const question = await this.eval(e.prompt, env);
                if (typeof question !== 'string') throw runtimeError('human question must be a string');
                if (!this.opts.checkpoint) throw runtimeError('human input requires a checkpoint');
                return this.opts.checkpoint.human(question, e.line);
            }
            case 'list': {
                const out: Value[] = [];
                for (const it of e.items) out.push(await this.eval(it, env));
                return out;
            }
            case 'dict': {
                const d = newDict();
                for (const [k, v] of e.entries) {
                    const key = await this.eval(k, env);
                    if (typeof key !== 'string') throw runtimeError(`dict keys must be strings, got ${typeName(key)}`);
                    setKey(d, key, await this.eval(v, env));
                }
                return d;
            }
            case 'unary': {
                const v = await this.eval(e.e, env);
                if (e.op === 'not') return !truthy(v);
                if (typeof v !== 'number') throw runtimeError(`bad operand for unary ${e.op}: ${typeName(v)}`);
                return e.op === '-' ? -v : v;
            }
            case 'binary':
                return this.binary(e.op, await this.eval(e.l, env), await this.eval(e.r, env));
            case 'logic': {
                const l = await this.eval(e.l, env);
                if (e.op === 'and') return truthy(l) ? this.eval(e.r, env) : l;
                return truthy(l) ? l : this.eval(e.r, env);
            }
            case 'compare': {
                let left = await this.eval(e.operands[0], env);
                for (let i = 0; i < e.ops.length; i++) {
                    const right = await this.eval(e.operands[i + 1], env);
                    if (!this.compare(e.ops[i], left, right)) return false;
                    left = right;
                }
                return true;
            }
            case 'ternary':
                return truthy(await this.eval(e.cond, env)) ? this.eval(e.then, env) : this.eval(e.else, env);
            case 'call': return this.evalCall(e.callee, e.args, env);
            case 'member': {
                const obj = await this.eval(e.obj, env);
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
        return d[k];
    }

    private async evalCall(callee: Expr, argExprs: Expr[], env: Env): Promise<Value> {
        if (callee.t === 'member') {
            const obj = await this.eval(callee.obj, env);
            const args = await this.evalArgs(argExprs, env);
            return typeof obj === 'object' && obj !== null && isMutatingMethod(obj, callee.name)
                ? this.observer.mutate(obj, env, callee.name, !this.opts.checkpoint?.replaying, () => callMethod(obj, callee.name, args))
                : callMethod(obj, callee.name, args);
        }
        const fn = await this.eval(callee, env);
        const args = await this.evalArgs(argExprs, env);
        if (!isFunction(fn)) throw runtimeError(`${typeName(fn)} is not callable`);
        if (fn.__fn === 'builtin') return fn.call(args);
        return this.callUser(fn, args);
    }

    private async evalArgs(exprs: Expr[], env: Env): Promise<Value[]> {
        const out: Value[] = [];
        for (const a of exprs) out.push(await this.eval(a, env));
        return out;
    }

    private async callUser(fn: UserFunction, args: Value[]): Promise<Value> {
        if (args.length !== fn.params.length) {
            throw runtimeError(`${fn.name}() takes ${fn.params.length} argument(s) but ${args.length} were given`);
        }
        if (this.depth >= this.maxDepth) throw runtimeError(`maximum call depth (${this.maxDepth}) exceeded`);
        const local = this.childScope(fn.closure, 'function', `${fn.name}()`);
        fn.params.forEach((name, index) => this.commit(local, name, args[index]));
        const savedLines = this.sourceLines;
        const savedUri = this.sourceUri;
        const savedVersion = this.sourceVersion;
        this.sourceLines = fn.source?.lines ?? savedLines;
        this.sourceUri = fn.source?.uri ?? savedUri;
        this.sourceVersion = fn.source?.version ?? savedVersion;
        this.depth++;
        try {
            const sig = await this.execBlock(fn.body, local);
            if (sig && sig.k !== 'return' && sig.k !== 'value') throw runtimeError(`'${sig.k}' outside of a loop`);
            return sig?.k === 'return' ? sig.v : null;
        } finally {
            this.depth--;
            this.sourceLines = savedLines;
            this.sourceUri = savedUri;
            this.sourceVersion = savedVersion;
        }
    }

    // ---- operators -----------------------------------------------------

    private binary(op: string, l: Value, r: Value): Value {
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
        if (typeof index !== 'number' || !Number.isInteger(index)) throw runtimeError(`indices must be integers, got ${typeName(index)}`);
        const i = index < 0 ? list.length + index : index;
        if ((i < 0 || i >= list.length) && list !== this.runtimeArgs) throw runtimeError(`index ${index} out of range`);
        return i;
    }

    private index(obj: Value, index: Value): Value {
        if (isList(obj)) return obj[this.listIndex(obj, index)] ?? null;
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
            if (typeof v !== 'number' || !Number.isInteger(v)) throw runtimeError('slice indices must be integers');
            return Math.min(Math.max(v < 0 ? items.length + v : v, 0), items.length);
        };
        const part = items.slice(bound(lo, 0), bound(hi, items.length));
        return typeof obj === 'string' ? part.join('') : part;
    }

    // ---- LLM and tools -------------------------------------------------

    private async callLlm(req: LlmRequest): Promise<string> {
        return (await this.callLlmResponse(req)).text.trim();
    }

    private async callLlmResponse(req: LlmRequest, interaction: ModelInteraction = {
        requestId: randomUUID(), kind: req.naturalLanguage ? 'blockquote' : req.kind,
    }): Promise<LlmResponse> {
        const { logger, backend } = this.opts;
        if (this.program.markdown) {
            req = { ...req, prompt: [
                RUNTIME_PREAMBLE, this.program.markdown.preamble, req.prompt,
            ].filter(Boolean).join('\n\n') };
        }
        const replaying = this.opts.checkpoint?.replaying;
        if (!replaying) logger.modelInput(interaction, req.prompt);
        const started = Date.now();
        try {
            const perform = async () => {
                try {
                    return await backend.call(req);
                } catch (error) {
                    if (error instanceof Failure || error instanceof CheckpointError ||
                        error instanceof SuccessSignal || error instanceof SuspensionSignal) throw error;
                    throw new Failure('llm_error', error instanceof Error ? error.message : String(error));
                }
            };
            const res = this.opts.checkpoint && !req.naturalLanguage
                ? await this.opts.checkpoint.effect({ kind: 'llm', request: traceRequest(req), restrictions: req.restrictions.list }, perform, isResponse)
                : await perform();
            if (!isResponse(res)) throw new Failure('llm_error', 'backend returned an invalid response; blockquotes require runtime actions, not submitted SPL');
            if (!replaying) {
                logger.info(`llm ${req.kind} call: ${JSON.stringify(res.effective)} (${Date.now() - started} ms)`);
                logger.modelOutput({ ...interaction, role: 'response' }, res.text);
            }
            return res;
        } catch (e) {
            if (e instanceof CheckpointError || e instanceof SuspensionSignal || e instanceof SuccessSignal) throw e;
            if (e instanceof Failure) throw e;
            if (e instanceof LlmError) throw new Failure('llm_error', e.message);
            throw new Failure('llm_error', (e as Error).message ?? String(e));
        }
    }

    private async execNatural(text: string, line: number, env: Env): Promise<Completion> {
        if (this.opts.backend.mode === 'record' || this.opts.backend.mode === 'replay') {
            throw new Failure('restriction_violation', 'blockquotes are agents and cannot run in generation-only record/replay mode; use --trace');
        }
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
        this.naturalDepth++;
        try {
            const checkpoint = this.opts.checkpoint;
            const decision = (perform: () => Promise<LlmResponse>) => checkpoint
                ? checkpoint.effect({
                    kind: 'natural', text, line, history: JSON.stringify(history), restrictions: this.restrictions.list,
                }, perform, isResponse)
                : perform();
            const execute = async (action: RuntimeAction): Promise<unknown> => {
                if (!checkpoint?.replaying) this.opts.logger.modelOutput({ ...interaction, role: 'action' }, JSON.stringify(action));
                const result = { value: describeValue(await this.execNaturalAction(action, line, env)) };
                history.push({ action, result });
                return result.value;
            };
            for (;;) {
                interaction = { requestId: randomUUID(), kind: 'blockquote' };
                if (checkpoint?.replaying) {
                    const response = await decision(async () => { throw new CheckpointError('missing recorded runtime decision'); });
                    if (!response.action) return;
                    await execute(response.action);
                    continue;
                }
                let actionFailed = false;
                const request: LlmRequest = {
                    kind: 'agent', naturalLanguage: true, runtimeTools: AGENT_TOOLS,
                    prompt: buildPrompt({
                        prompt: `${NATURAL_PREAMBLE}\n\nAvailable builtin names: ${[...this.builtins.keys()].join(', ')}\n\nShared bindings at command start:\n${JSON.stringify(bindings)}\n\nBlockquote:\n${text}\n\nCompleted turns and action results:\n${JSON.stringify(history)}`,
                        constraints: this.constraints, restrictions: this.restrictions,
                    }),
                    model: this.model, reasoningEffort: 'medium', showReasoning: false,
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
                    response = await this.callLlmResponse(request, interaction);
                } catch (error) {
                    if (checkpoint && !actionFailed && error instanceof Failure) {
                        await decision(async () => { throw error; });
                    }
                    throw error;
                }
                await decision(async () => response);
                if (!response.action) return;
                await execute(response.action);
            }
        } finally {
            this.naturalDepth--;
            this.restrictions = savedRestrictions;
            this.constraints = savedConstraints;
        }
    }

    private async execNaturalAction(action: RuntimeAction, line: number, env: Env): Promise<Value> {
        const args = actionArguments(action);
        switch (action.name) {
            case 'load_variable':
                return args.name === '$args' ? this.runtimeArgs : this.lookup(String(args.name), env);
            case 'save_variable': {
                const name = String(args.name);
                if ('schema' in args) compileSchema(args.schema)(args.value);
                if (isFunction(this.bindingScope(name, env)?.vars.get(name)) || this.builtins.has(name)) {
                    throw runtimeError(`cannot replace function '${name}' with a variable`);
                }
                this.commit(this.bindingScope(name, env) ?? env, name, args.value);
                return args.value;
            }
            case 'call_function': {
                const fn = this.lookup(String(args.name), env);
                if (!isFunction(fn)) throw runtimeError(`'${args.name}' is not callable`);
                if (!isList(args.args)) throw runtimeError('function arguments must be a list');
                return fn.__fn === 'user' ? this.callUser(fn, args.args) : fn.call(args.args);
            }
            case 'get_env':
                this.opts.checkpoint?.observeEnvironment(this.runtimeEnv);
                return this.externalAction(action, async () => this.getKey(this.runtimeEnv, String(args.name)));
            case 'ask_human':
                if (!this.opts.checkpoint) throw runtimeError('human input requires a checkpoint; use --checkpoint or --resume');
                return this.opts.checkpoint.human(String(args.question), line);
            case 'success':
                throw new SuccessSignal(args.value);
            case 'fail':
                throw new Failure('explicit_failure', String(args.reason));
            case 'restrict': {
                const kind = args.kind;
                if (kind !== 'fs' && kind !== 'exec' && kind !== 'net' && kind !== 'mcp') throw runtimeError('invalid restriction kind');
                this.restrictions = this.restrictions.with(makeRestriction(kind, args.value, this.cwd));
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

    private async externalAction(action: RuntimeAction, perform: () => Promise<Value>): Promise<Value> {
        try {
            return await (this.opts.backend.invokeTool ? this.opts.backend.invokeTool(action, perform) : perform());
        } catch (error) {
            if (error instanceof LlmError) throw new Failure('llm_error', error.message);
            throw error;
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
        const invoke = async () => new ToolHost(this.restrictions, this.cwd, this.opts.backend.mode === 'replay', true).invoke(tool, params);
        const perform = () => this.naturalDepth
            ? this.externalAction({ name: tool, arguments: { ...params, restrictions: this.restrictions.list } }, invoke)
            : invoke();
        return this.opts.checkpoint
            ? this.opts.checkpoint.effect({ kind: 'tool', tool, params, restrictions: this.restrictions.list }, perform, (value): value is string => typeof value === 'string')
            : perform();
    }

    private async evalGeneration(kind: LlmRequest['kind'], mods: Record<string, Expr>, promptExpr: Expr, env: Env): Promise<Value> {
        if (kind === 'agent' && (this.opts.backend.mode === 'record' || this.opts.backend.mode === 'replay')) {
            throw new Failure('restriction_violation', 'agents cannot run in record/replay mode; record generation-only workflows');
        }
        const options: Record<string, Value> = {};
        for (const [name, expr] of Object.entries(mods)) setKey(options, name, await this.eval(expr, env));
        const { len, reasoning = kind === 'ask' ? undefined : 'medium', show = false, repairs = 0, model } = options;
        const fmt = options.fmt ?? ('schema' in options ? 'json' : 'text');
        if (len !== undefined && len !== 'word' && len !== 'sentence' && len !== 'paragraph' && len !== 'long') throw runtimeError('len must be word, sentence, paragraph, or long');
        if (fmt !== 'integer' && fmt !== 'float' && fmt !== 'array' && fmt !== 'object' && fmt !== 'text' && fmt !== 'boolean' && fmt !== 'json') {
            throw runtimeError('fmt must be integer, float, array, object, text, boolean, or json');
        }
        if (reasoning !== undefined && reasoning !== 'low' && reasoning !== 'medium' && reasoning !== 'high') throw runtimeError('reasoning must be low, medium, or high');
        if (typeof show !== 'boolean') throw runtimeError('show must be True or False');
        if (model !== undefined && (typeof model !== 'string' || !model.trim())) throw runtimeError('model must be a non-empty string');
        if (typeof repairs !== 'number' || !Number.isInteger(repairs) || repairs < 0 || repairs > 5) throw runtimeError('repairs must be an integer from 0 to 5');
        if (kind === 'agent' && repairs !== 0) throw runtimeError('agents cannot use repairs: external actions must not be retried automatically');
        if (fmt === 'text' && ('schema' in options || repairs !== 0)) throw runtimeError('schema and repairs require JSON output');
        const validate = 'schema' in options ? compileSchema(options.schema) : undefined;
        let prompt = buildPrompt({
            prompt: str(await this.eval(promptExpr, env)),
            mods: { len, fmt },
            thinking: reasoning !== undefined,
            constraints: this.constraints,
            restrictions: this.restrictions,
        });
        if (fmt === 'json') prompt += '\n\nReturn ONLY valid JSON, without prose or code fences.';
        if (validate) prompt += `\n\nThe result must satisfy this JSON Schema:\n${JSON.stringify(toJson(options.schema))}`;
        const basePrompt = prompt;
        for (let attempt = 0; ; attempt++) {
            const text = await this.callLlm({
                kind, prompt,
                model: this.opts.model ?? model ?? this.model,
                reasoningEffort: reasoning,
                showReasoning: show,
                restrictions: this.restrictions,
                tools: new ToolHost(this.restrictions, this.cwd, this.opts.backend.mode === 'replay'),
            });
            try {
                const value = fmt === 'text' ? text : parseJsonResponse(text, fmt);
                validate?.(value);
                return value;
            } catch (e) {
                if (!(e instanceof Failure) || (e.statusCode !== 'invalid_format' && e.statusCode !== 'validation_failed') || attempt >= repairs) throw e;
                if (!this.opts.checkpoint?.replaying) this.opts.logger.info(`repair ${attempt + 1}/${repairs}: ${e.reason}`);
                prompt = `${basePrompt}\n\nPrevious response:\n${text}\n\nValidation failed: ${e.reason}\nReturn a corrected JSON value.`;
            }
        }
    }
}
