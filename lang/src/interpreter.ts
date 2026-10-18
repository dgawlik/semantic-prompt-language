import type { AssignTarget, Expr, Program, Stmt, StrPart, ToolName } from './ast.js';
import { callMethod, iterate, makeBuiltins } from './builtins.js';
import { Failure, SuccessSignal, type FailurePayload } from './errors.js';
import { LlmError, buildPrompt, parseObjectResponse, type Constraint, type LlmBackend, type LlmRequest } from './llm.js';
import type { Logger } from './logger.js';
import { Restrictions, makeRestriction } from './restrict.js';
import { MemoryStore, type VariableStore } from './store.js';
import { ToolHost, TOOL_SPECS } from './tools.js';
import {
    compareValues,
    equals,
    hasKey,
    isDict,
    isFunction,
    isList,
    newDict,
    runtimeError,
    setKey,
    str,
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
    /** Overrides the `@{model=...}` directive. */
    model?: string;
    maxCallDepth?: number;
}

export type RunResult =
    | { status: 'success'; value: Value; hasValue: boolean }
    | { status: 'failure'; failure: FailurePayload };

type Signal = { k: 'break' } | { k: 'continue' } | { k: 'return'; v: Value; hasValue: boolean };

export async function run(program: Program, opts: RunOptions): Promise<RunResult> {
    return new Interpreter(program, opts).run();
}

class Interpreter {
    private readonly globals: Env = { vars: new Map() };
    private readonly builtins;
    private readonly store: VariableStore;
    private readonly cwd: string;
    private readonly model?: string;
    private readonly maxDepth: number;
    private constraints: Constraint[] = [];
    private restrictions: Restrictions;
    private depth = 0;

    constructor(
        private readonly program: Program,
        private readonly opts: RunOptions,
    ) {
        this.cwd = opts.cwd ?? process.cwd();
        this.store = opts.store ?? new MemoryStore();
        this.model = opts.model ?? program.directives.model;
        this.maxDepth = opts.maxCallDepth ?? 200;
        this.restrictions = new Restrictions(this.cwd);
        this.builtins = makeBuiltins({ log: (m) => opts.logger.info(`log: ${m}`) });
    }

    async run(): Promise<RunResult> {
        const { logger } = this.opts;
        try {
            for (const [k, v] of Object.entries(this.store.load())) this.globals.vars.set(k, v);
            const signal = await this.execBlock(this.program.body, this.globals);
            if (signal?.k === 'return') return { status: 'success', value: signal.v, hasValue: signal.hasValue };
            if (signal) throw runtimeError(`'${signal.k}' outside of a loop`);
            return { status: 'success', value: null, hasValue: false };
        } catch (e) {
            if (e instanceof SuccessSignal) return { status: 'success', value: e.value as Value, hasValue: true };
            if (e instanceof Failure) {
                logger.error(`${e.statusCode}: ${e.reason} (line ${e.line})`);
                return { status: 'failure', failure: e.payload() };
            }
            throw e;
        } finally {
            try {
                const snapshot: Record<string, Value> = {};
                for (const [k, v] of this.globals.vars) if (!isFunction(v)) snapshot[k] = v;
                this.store.save(snapshot);
            } catch (e) {
                logger.error(`could not save variable store: ${(e as Error).message}`);
            }
        }
    }

    // ---- environments --------------------------------------------------

    private lookup(name: string, env: Env): Value {
        for (let e: Env | undefined = env; e; e = e.parent) {
            if (e.vars.has(name)) return e.vars.get(name)!;
        }
        const b = this.builtins.get(name);
        if (b) return b;
        throw runtimeError(`name '${name}' is not defined`);
    }

    // ---- statements ----------------------------------------------------

    private async execBlock(stmts: Stmt[], env: Env): Promise<Signal | undefined> {
        for (const s of stmts) {
            const signal = await this.execStmt(s, env);
            if (signal) return signal;
        }
        return undefined;
    }

    private async execStmt(s: Stmt, env: Env): Promise<Signal | undefined> {
        try {
            return await this.execStmtInner(s, env);
        } catch (e) {
            if (e instanceof Failure) throw e.locate(s.line, this.program.lines[s.line - 1]?.trim() ?? '');
            if (e instanceof RangeError) {
                throw new Failure('runtime_error', e.message).locate(s.line, this.program.lines[s.line - 1]?.trim() ?? '');
            }
            throw e;
        }
    }

    private async execStmtInner(s: Stmt, env: Env): Promise<Signal | undefined> {
        switch (s.t) {
            case 'let':
                await this.execLet(s.target, s.op, s.value, env);
                return;
            case 'block':
                return this.execBlock(s.body, { vars: new Map(), parent: env });
            case 'expr':
                await this.eval(s.e, env);
                return;
            case 'pass':
                return;
            case 'break':
                return { k: 'break' };
            case 'continue':
                return { k: 'continue' };
            case 'return':
                return { k: 'return', v: s.value ? await this.eval(s.value, env) : null, hasValue: s.value !== undefined };
            case 'if': {
                for (const b of s.branches) {
                    if (truthy(await this.eval(b.cond, env))) return this.execBlock(b.body, env);
                }
                return s.orelse ? this.execBlock(s.orelse, env) : undefined;
            }
            case 'while': {
                while (truthy(await this.eval(s.cond, env))) {
                    const sig = await this.execBlock(s.body, env);
                    if (sig?.k === 'break') break;
                    if (sig?.k === 'return') return sig;
                }
                return;
            }
            case 'for': {
                const items = iterate(await this.eval(s.iter, env));
                for (let i = 0; i < items.length; i++) {
                    this.bindLoopVars(s.vars, items[i], env);
                    const sig = await this.execBlock(s.body, env);
                    if (sig?.k === 'break') break;
                    if (sig?.k === 'return') return sig;
                }
                return;
            }
            case 'def': {
                const fn: UserFunction = { __fn: 'user', name: s.name, params: s.params, body: s.body, closure: env };
                env.vars.set(s.name, fn);
                return;
            }
            case 'try': {
                const savedConstraints = this.constraints;
                const savedRestrictions = this.restrictions;
                const savedDepth = this.depth;
                try {
                    return await this.execBlock(s.body, env);
                } catch (e) {
                    if (!(e instanceof Failure)) throw e;
                    this.constraints = savedConstraints;
                    this.restrictions = savedRestrictions;
                    this.depth = savedDepth;
                    this.opts.logger.debug(`caught ${e.statusCode}: ${e.reason}`);
                    env.vars.set(s.errName, newDict(Object.entries(e.payload()) as [string, Value][]));
                    return this.execBlock(s.handler, env);
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
                    return await this.execBlock(s.body, env);
                } finally {
                    this.constraints = saved;
                }
            }
            case 'restrict': {
                const restriction = makeRestriction(s.kind, await this.eval(s.arg, env), this.cwd);
                const saved = this.restrictions;
                this.restrictions = saved.with(restriction);
                this.opts.logger.debug(`restrict ${s.kind}: ${restriction.values.join(', ')}`);
                try {
                    return await this.execBlock(s.body, env);
                } finally {
                    this.restrictions = saved;
                }
            }
        }
    }

    private bindLoopVars(vars: string[], item: Value, env: Env): void {
        if (vars.length === 1) {
            env.vars.set(vars[0], item);
            return;
        }
        if (!isList(item) || item.length !== vars.length) {
            throw runtimeError(`cannot unpack ${typeName(item)} into ${vars.length} variables`);
        }
        vars.forEach((v, i) => env.vars.set(v, item[i]));
    }

    private async execLet(target: AssignTarget, op: string, valueExpr: Expr, env: Env): Promise<void> {
        const compute = async (current: () => Value): Promise<Value> => {
            const rhs = await this.eval(valueExpr, env);
            return op === '=' ? rhs : this.binary(op.slice(0, -1), current(), rhs);
        };
        if (target.t === 'name') {
            // Binds in the current scope, which is what lets a nested block shadow an outer variable.
            env.vars.set(target.name, await compute(() => this.lookup(target.name, env)));
            return;
        }
        const obj = await this.eval(target.obj, env);
        if (target.t === 'member') {
            if (!isDict(obj)) throw runtimeError(`cannot set member '${target.name}' on ${typeName(obj)}`);
            const value = await compute(() => this.getKey(obj, target.name));
            setKey(obj, target.name, value);
            return;
        }
        const index = await this.eval(target.index, env);
        if (isList(obj)) {
            const i = this.listIndex(obj, index);
            obj[i] = await compute(() => obj[i]);
        } else if (isDict(obj)) {
            if (typeof index !== 'string') throw runtimeError(`dict keys must be strings, got ${typeName(index)}`);
            setKey(obj, index, await compute(() => this.getKey(obj, index)));
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
            case 'name': return this.lookup(e.name, env);
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
            case 'ask': {
                const prompt = str(await this.eval(e.prompt, env));
                const text = await this.callLlm({ kind: 'ask', prompt, mods: e.mods });
                return e.mods.fmt === 'object' ? parseObjectResponse(text) : text;
            }
            case 'think': {
                const prompt = str(await this.eval(e.prompt, env));
                return this.callLlm({
                    kind: 'think',
                    prompt,
                    effort: e.mods.level ?? 'medium',
                    show: e.mods.show ?? false,
                });
            }
            case 'tool': return this.evalTool(e.tool, e.params, e.instructions, env);
        }
    }

    private getKey(d: { [key: string]: Value }, k: string): Value {
        if (!hasKey(d, k)) throw runtimeError(`key '${k}' not found`);
        return d[k];
    }

    private async evalCall(callee: Expr, argExprs: Expr[], env: Env): Promise<Value> {
        if (callee.t === 'member') {
            const obj = await this.eval(callee.obj, env);
            const args = await this.evalArgs(argExprs, env);
            return callMethod(obj, callee.name, args);
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
        const local: Env = { vars: new Map(fn.params.map((p, i) => [p, args[i]])), parent: fn.closure };
        this.depth++;
        try {
            const sig = await this.execBlock(fn.body, local);
            if (sig && sig.k !== 'return') throw runtimeError(`'${sig.k}' outside of a loop`);
            return sig?.k === 'return' ? sig.v : null;
        } finally {
            this.depth--;
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
        if (i < 0 || i >= list.length) throw runtimeError(`index ${index} out of range`);
        return i;
    }

    private index(obj: Value, index: Value): Value {
        if (isList(obj)) return obj[this.listIndex(obj, index)];
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

    private async callLlm(c: {
        kind: 'ask' | 'think' | 'tool';
        prompt: string;
        mods?: { len?: 'word' | 'sentence' | 'paragraph' | 'long'; fmt?: 'text' | 'object' };
        effort?: 'low' | 'medium' | 'high';
        show?: boolean;
        pinned?: LlmRequest['pinned'];
    }): Promise<string> {
        const { logger, backend } = this.opts;
        const req: LlmRequest = {
            kind: c.kind,
            prompt: buildPrompt({
                prompt: c.prompt,
                mods: c.mods,
                thinking: c.kind === 'think',
                constraints: this.constraints,
                restrictions: this.restrictions,
            }),
            model: this.model,
            reasoningEffort: c.effort ?? (c.kind === 'tool' ? 'medium' : undefined),
            showReasoning: c.show ?? false,
            restrictions: this.restrictions,
            tools: new ToolHost(this.restrictions, this.cwd),
            pinned: c.pinned,
        };
        logger.debug(`llm request (${c.kind}):\n${req.prompt}`);
        const started = Date.now();
        try {
            const res = await backend.call(req);
            logger.info(`llm ${c.kind} call: ${JSON.stringify(res.effective)} (${Date.now() - started} ms)`);
            logger.debug(`llm response:\n${res.text}`);
            return res.text.trim();
        } catch (e) {
            if (e instanceof Failure) throw e;
            if (e instanceof LlmError) throw new Failure('llm_error', e.message);
            throw new Failure('llm_error', (e as Error).message ?? String(e));
        }
    }

    private async evalTool(tool: ToolName, paramExprs: Record<string, Expr>, instrExpr: Expr, env: Env): Promise<Value> {
        const params: Record<string, string> = {};
        for (const [k, ex] of Object.entries(paramExprs)) {
            const v = await this.eval(ex, env);
            if (k !== 'content' && typeof v !== 'string') throw runtimeError(`${tool}: parameter '${k}' must be a string, got ${typeName(v)}`);
            params[k] = str(v);
        }
        const instructions = str(await this.eval(instrExpr, env));
        const host = new ToolHost(this.restrictions, this.cwd);

        // When the script leaves a required parameter out, the LLM calls the tool itself with the fixed ones pinned.
        if (TOOL_SPECS[tool].required.some((p) => !(p in params))) {
            if (tool === 'write_file' && params.path !== undefined) this.restrictions.checkPath(params.path, 'write');
            const fixed = Object.keys(params).length ? ` with these fixed parameters (set by the script): ${JSON.stringify(params)}` : '';
            return this.callLlm({
                kind: 'tool',
                prompt: `Use the ${tool} tool${fixed}. Instructions: ${instructions}`,
                pinned: { tool, params },
            });
        }

        const output = await host.invoke(tool, params);
        this.opts.logger.debug(`tool ${tool} ${JSON.stringify(params)} -> ${output.length} chars`);
        return this.callLlm({
            kind: 'tool',
            prompt: `The tool \`${tool}\` was run with parameters ${JSON.stringify(params)}. Its output is between the markers.\n<tool_output>\n${output}\n</tool_output>\n\nInstructions: ${instructions}`,
        });
    }
}
