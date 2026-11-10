import type { AssignTarget, DefStmt, Expr, FieldDecl, Program, Stmt, TypeExpr } from './ast.js';
import { types as nodeTypes } from 'node:util';
import { Failure } from './errors.js';
import { isListCallbackMethod } from './builtins.js';
import {
    aliasType, assignable, contractOf, descriptor, equivalent, INT_MAX, INT_MIN, primitives, resolveFields, resolveType,
    type TypeDescriptor,
} from './types.js';
import { isDescriptor, isDict, isFloat, isFunction, isInstance, isList, type Env, type Value } from './values.js';

interface Callable {
    params: (TypeDescriptor | undefined)[];
    result?: TypeDescriptor;
    inferred?: Info;
}

interface Identity {
    kind: 'list' | 'object';
    contract?: TypeDescriptor;
    items?: Info[];
    fields?: Map<string, Info>;
    open?: boolean;
}

interface Info {
    type?: TypeDescriptor;
    typed?: boolean;
    legacy?: boolean;
    literal?: string | number | bigint | boolean | null;
    identity?: Identity;
    callable?: Callable;
    descriptor?: TypeDescriptor;
    builtin?: string;
}

interface Binding {
    id: number;
    value: Info;
    contract?: TypeDescriptor;
    owner: number;
    captured?: boolean;
    readonly?: boolean;
    prior?: boolean;
}

interface Scope {
    bindings: Map<string, Binding>;
    parent?: Scope;
    narrow: Map<string, Info>;
    functionId: number;
}

interface FunctionContext {
    result?: TypeDescriptor;
    returns: Info[];
}

const unknown = (): Info => ({});
const primitive = (name: string): TypeDescriptor => primitives.get(name)!;
const concrete = (type: TypeDescriptor, typed = true): Info => ({ type, typed });
const stringKey = (info: Info): string | undefined => typeof info.literal === 'string' ? info.literal : undefined;
const numeric = (type: TypeDescriptor): boolean => type.kind === 'int' || type.kind === 'float';
const mutable = (type: TypeDescriptor): boolean => ['list', 'struct', 'class'].includes(type.kind);

/** Checks only statically known contracts; dynamic values are left to runtime validation. */
export function checkProgram(program: Program, globals?: Env, onMember?: MemberObserver): void {
    new Checker(program, onMember).check(globals);
}

export type MemberObserver = (expr: Extract<Expr | AssignTarget, { t: 'member' }>, receiver: TypeDescriptor | undefined) => void;

class Checker {
    private nextId = 1;
    private line = 1;
    private function?: FunctionContext;

    constructor(private readonly program: Program, private readonly onMember?: MemberObserver) {}

    private error(reason: string, line = this.line): never {
        throw new Failure('type_error', reason).locate(line, this.program.lines[line - 1]?.trim() ?? '');
    }

    check(globals?: Env): void {
        const root: Scope = { bindings: new Map(), narrow: new Map(), functionId: 0 };
        for (const [name, type] of primitives) this.define(root, name, { descriptor: type });
        const importEnv = (env: Env): void => {
            if (env.parent) importEnv(env.parent);
            for (const [name, value] of env.vars) {
                const info = this.runtimeInfo(value, new Map());
                const existing = root.bindings.get(name);
                const contract = env.contracts?.get(name);
                const binding = existing ?? this.define(root, name, info, contract);
                if (!existing) binding.prior = true;
                binding.value = contract ? { ...info, type: contract, typed: true } : info;
                binding.contract = contract;
                binding.readonly = env.readonlyNames?.has(name);
            }
        };
        if (globals) importEnv(globals);
        this.block(this.program.body, root);
    }

    private runtimeInfo(value: Value, seen: Map<object, Info>): Info {
        if (value === null) return { type: primitive('None'), literal: null };
        if (typeof value === 'string') return { type: primitive('str'), literal: value };
        if (typeof value === 'boolean') return { type: primitive('bool'), literal: value };
        if (typeof value === 'number') return { legacy: true, literal: value };
        if (typeof value === 'bigint') return { type: primitive('int'), typed: true, literal: value };
        if (typeof value !== 'object') return unknown();
        if (nodeTypes.isProxy(value)) return unknown();
        const own = Object.getOwnPropertyDescriptors(value);
        if (['__fn', '__float', '__instance', '__type'].some(key => own[key] && !('value' in own[key]))) return unknown();
        if (isFloat(value)) return { type: primitive('float'), typed: true, literal: value.__float };
        if (isDescriptor(value)) return { descriptor: value, callable: value.kind === 'class' ? this.constructorSignature(value) : undefined };
        if (isInstance(value)) return concrete(value.descriptor);
        if (isFunction(value)) {
            if (value.__fn === 'builtin') return { ...(value.signature ? this.fromCallable(value.signature) : unknown()), builtin: value.name };
            return { callable: { params: value.paramTypes ?? value.params.map(() => undefined), result: value.returnType }, typed: !!value.returnType || !!value.paramTypes?.some(Boolean) };
        }
        if (seen.has(value)) return seen.get(value)!;
        const info: Info = { identity: { kind: isList(value) ? 'list' : 'object', contract: contractOf(value) } };
        seen.set(value, info);
        if (isList(value)) info.identity!.items = Array.from({ length: value.length }, (_, index) =>
            own[index] && 'value' in own[index] ? this.runtimeInfo(own[index].value as Value, seen) : unknown());
        else if (isDict(value)) {
            info.identity!.fields = new Map(Object.entries(own).filter(([, field]) => field.enumerable).map(([key, field]) =>
                [key, 'value' in field ? this.runtimeInfo(field.value as Value, seen) : unknown()]));
        }
        return info;
    }

    private child(parent: Scope, functionId = parent.functionId): Scope {
        return { bindings: new Map(), parent, narrow: new Map(parent.narrow), functionId };
    }

    private find(scope: Scope, name: string): Binding | undefined {
        return scope.bindings.get(name) ?? (scope.parent ? this.find(scope.parent, name) : undefined);
    }

    private define(scope: Scope, name: string, value: Info, contract?: TypeDescriptor): Binding {
        const previous = scope.bindings.get(name);
        if (previous && (!previous.prior || previous.contract || previous.readonly)) this.error(`conflicting declaration '${name}'`);
        const binding = { id: this.nextId++, value, contract, owner: scope.functionId };
        scope.bindings.set(name, binding);
        return binding;
    }

    private resolve(expr: TypeExpr, scope: Scope): TypeDescriptor {
        try {
            return resolveType(expr, name => {
                const binding = this.find(scope, name);
                if (!binding?.value.descriptor) this.error(`'${name}' is not a declared type`, expr.line);
                return binding.value.descriptor;
            });
        } catch (error) {
            if (error instanceof Failure) this.error(error.reason, expr.line);
            throw error;
        }
    }

    private advice(advice: Record<string, unknown>, label: string, line: number): void {
        const json = (value: unknown): boolean => value === null || typeof value === 'string' || typeof value === 'boolean'
            || typeof value === 'number' && Number.isFinite(value)
            || Array.isArray(value) && value.every(json)
            || typeof value === 'object' && value !== null && Object.values(value).every(json);
        if (!json(advice) || 'desc' in advice && typeof advice.desc !== 'string'
            || ['min', 'max'].some(key => key in advice && typeof advice[key] !== 'number')) {
            this.error(`malformed metadata for ${label}`, line);
        }
    }

    private fields(fields: FieldDecl[], scope: Scope): ReturnType<typeof resolveFields> {
        const names = new Set<string>();
        for (const field of fields) {
            if (names.has(field.name)) this.error(`duplicate field '${field.name}'`, field.line);
            names.add(field.name);
            this.advice(field.advice, `field '${field.name}'`, field.line);
            this.resolve(field.type, scope);
        }
        return resolveFields(fields, name => this.find(scope, name)!.value.descriptor!);
    }

    private effective(info: Info): Info {
        const contract = info.identity?.contract;
        return contract ? { ...info, type: info.type?.kind === 'union' ? info.type : contract, typed: true } : info;
    }

    private fromCallable(type: TypeDescriptor): Info {
        return { type, typed: true, callable: { params: [...type.params!], result: type.result } };
    }

    private constructorSignature(type: TypeDescriptor): Callable {
        const constructor = type.methods?.[type.name];
        return {
            params: constructor ? constructor.paramTypes ?? constructor.params.map(() => undefined) : [],
            result: type,
        };
    }

    private union(types: TypeDescriptor[]): TypeDescriptor | undefined {
        const members = types.flatMap(type => type.kind === 'union' ? [...type.members!] : [type]);
        const unique = members.filter((type, i) => !members.slice(0, i).some(other => equivalent(type, other)));
        return unique.length === 0 ? undefined : unique.length === 1 ? unique[0]
            : descriptor('union', unique.map(type => type.name).join(' | '), { members: unique });
    }

    private merge(values: Info[]): Info {
        if (!values.length) return unknown();
        if (values.every(value => value === values[0])) return values[0];
        const infos = values.map(value => this.effective(value));
        const first = infos[0];
        const shared: Info = {};
        if (first.descriptor && infos.every(value => value.descriptor === first.descriptor)) shared.descriptor = first.descriptor;
        if (first.callable && infos.every(value => value.callable === first.callable)) shared.callable = first.callable;
        if (first.builtin && infos.every(value => value.builtin === first.builtin)) shared.builtin = first.builtin;
        if (infos.every(value => value.type)) return { ...shared, type: this.union(infos.map(value => value.type!)), typed: infos.some(value => value.typed) };
        if (infos.every(value => value.legacy)) return { ...shared, legacy: true };
        return shared;
    }

    private matches(value: Info, target: TypeDescriptor): boolean | undefined {
        const info = this.effective(value);
        if (info.type?.kind === 'union') {
            const matches = info.type.members!.map(member => this.matches(concrete(member, !!info.typed), target));
            return matches.includes(false) ? false : matches.every(match => match === true) ? true : undefined;
        }
        if (target.kind === 'union') {
            const matches = target.members!.map(member => this.matches(info, member));
            return matches.includes(true) ? true : matches.every(match => match === false) ? false : undefined;
        }
        if (info.identity?.contract && mutable(target) && !equivalent(info.identity.contract, target)) return false;
        if (target.kind === 'char' && typeof info.literal === 'string') {
            return Array.from(info.literal).length === 1 && !/[\uD800-\uDFFF]/u.test(info.literal);
        }
        if (target.kind === 'enum' && typeof info.literal === 'string') return target.values!.includes(info.literal);
        if ((target.kind === 'char' || target.kind === 'enum') && info.type && this.stringType(info.type)) {
            if (info.type.kind === 'enum') {
                const matches = info.type.values!.map(value => target.kind === 'enum' ? target.values!.includes(value)
                    : Array.from(value).length === 1 && !/[\uD800-\uDFFF]/u.test(value));
                return matches.every(Boolean) ? true : matches.every(match => !match) ? false : undefined;
            }
            if (equivalent(info.type, target)) return true;
            return undefined;
        }
        if (target.kind === 'fn' && info.callable) {
            if (info.callable.params.length !== target.params!.length) return false;
            if (info.callable.params.some((param, i) => param && !assignable(target.params![i], param))
                || info.callable.result && !assignable(info.callable.result, target.result!)) return false;
            if (info.callable.params.every(Boolean) && info.callable.result) {
                const signature = descriptor('fn', 'function', { params: info.callable.params as TypeDescriptor[], result: info.callable.result });
                return assignable(signature, target);
            }
            return undefined;
        }
        if (target.kind === 'list' && info.identity?.kind === 'list') {
            if (info.type && info.type.kind !== 'list') return false;
            if (!info.identity.items) return undefined;
            const checks = info.identity.items.map(item => this.matches(item, target.element!));
            return checks.includes(false) ? false : checks.every(check => check === true) ? true : undefined;
        }
        if (target.kind === 'struct' && info.identity?.kind === 'object') {
            if (info.type?.kind === 'class') return false;
            if (!info.identity.fields) return undefined;
            if (!info.identity.open && (info.identity.fields.size !== Object.keys(target.fields!).length
                || Object.keys(target.fields!).some(key => !info.identity!.fields!.has(key)))) return false;
            const checks = [...info.identity.fields].map(([key, item]) => target.fields![key] ? this.matches(item, target.fields![key].type) : false);
            return checks.includes(false) ? false : !info.identity.open && checks.every(check => check === true) ? true : undefined;
        }
        if (target.kind === 'object' && info.identity?.kind === 'object' && info.type?.kind !== 'class') return true;
        if (info.legacy) return false;
        if (info.descriptor) return false;
        if (info.type) return assignable(info.type, target);
        if (info.identity || info.callable) return false;
        return undefined;
    }

    private require(value: Info, target: TypeDescriptor, path: string): Info {
        if (this.matches(value, target) === false) {
            const info = this.effective(value);
            if (info.identity?.contract && mutable(target) && !equivalent(info.identity.contract, target)) {
                this.error(`${path}: incompatible established contract ${info.identity.contract.name} and ${target.name}`);
            }
            if (target.kind === 'struct' && info.identity?.fields && info.type?.kind !== 'class') {
                for (const key of info.identity.fields.keys()) if (!Object.hasOwn(target.fields!, key)) this.error(`${path}.${key}: extra field`);
                if (!info.identity.open) for (const key of Object.keys(target.fields!)) {
                    if (!info.identity.fields.has(key)) this.error(`${path}.${key}: missing required field`);
                }
                for (const [key, item] of info.identity.fields) this.require(item, target.fields![key].type, `${path}.${key}`);
            }
            if (target.kind === 'list' && info.identity?.items) info.identity.items.forEach((item, index) => this.require(item, target.element!, `${path}[${index}]`));
            const actual = info.type?.name ?? (info.legacy ? 'legacy number' : info.callable ? 'function' : info.identity?.items ? 'list' : info.identity?.fields ? 'object' : 'type descriptor');
            this.error(`${path}: expected ${target.name}, got ${actual}`);
        }
        this.install(value, target);
        return { ...value, type: target, typed: true, descriptor: target.kind === 'fn' ? undefined : value.descriptor, callable: target.kind === 'fn'
            ? { params: [...target.params!], result: target.result } : value.callable };
    }

    private validationCopy(value: Info, seen = new Map<Identity, Identity>()): Info {
        if (!value.identity) return { ...value };
        let identity = seen.get(value.identity);
        if (!identity) {
            identity = { ...value.identity };
            seen.set(value.identity, identity);
            identity.items = identity.items?.map(item => this.validationCopy(item, seen));
            identity.fields = identity.fields && new Map([...identity.fields].map(([key, item]) => [key, this.validationCopy(item, seen)]));
        }
        return { ...value, identity };
    }

    private containsClass(type: TypeDescriptor): boolean {
        return type.kind === 'class' || type.kind === 'list' && this.containsClass(type.element!)
            || type.kind === 'union' && type.members!.some(member => this.containsClass(member))
            || type.kind === 'struct' && Object.values(type.fields!).some(field => this.containsClass(field.type));
    }

    private validation(value: Info, target: TypeDescriptor, path: string): Info {
        if (!this.containsClass(target)) return this.require(value, target, path);
        const info = this.effective(value);
        if (info.type?.kind === 'union') {
            for (const member of info.type.members!) this.validation(concrete(member, !!info.typed), target, path);
            return concrete(target);
        }
        if (target.kind === 'union') {
            const matches: TypeDescriptor[] = [];
            for (const member of target.members!) {
                try { this.validation(this.validationCopy(value), member, path); matches.push(member); }
                catch (error) { if (!(error instanceof Failure) || error.statusCode !== 'type_error') throw error; }
            }
            if (!matches.length) return this.require(value, target, path);
            const proven = matches.filter(member => this.matches(value, member) === true
                || member.kind === 'class' && info.type?.kind !== 'class'
                && this.matches(value, descriptor('struct', `struct(${member.name})`, { fields: member.fields })) === true);
            if (proven.length > 1 && proven.some(member => this.matches(value, member) === false)
                && proven.some(member => !equivalent(member, proven[0]))) this.error(`${path}: ambiguous union conversions for ${target.name}`);
            return concrete(target);
        }
        if (target.kind !== 'class' && this.matches(value, target) !== false) return this.require(value, target, path);
        if (target.kind === 'class' && info.type?.kind === 'class') return this.require(value, target, path);
        if (target.kind === 'list' && (info.type?.kind === 'list' || info.identity?.kind === 'list')) {
            if (info.identity?.items) {
                for (const [index, item] of info.identity.items.entries()) this.validation(item, target.element!, `${path}[${index}]`);
                if (!info.identity.items.length) return this.require(value, target, path);
            } else if (info.type?.element) this.validation(concrete(info.type.element), target.element!, `${path}[]`);
            return concrete(target);
        }
        if ((target.kind === 'class' || target.kind === 'struct') && info.type?.kind !== 'class'
            && (info.identity?.kind === 'object' || info.type?.kind === 'struct' || info.type?.kind === 'object')) {
            const fields = info.identity?.fields ?? (info.type?.fields
                && new Map(Object.entries(info.type.fields).map(([key, field]) => [key, concrete(field.type)])));
            if (fields) {
                for (const key of fields.keys()) if (!Object.hasOwn(target.fields!, key)) this.error(`${path}.${key}: extra field`);
                if (!info.identity?.open) for (const key of Object.keys(target.fields!)) {
                    if (!fields.has(key)) this.error(`${path}.${key}: missing required field`);
                }
                for (const [key, field] of fields) this.validation(field, target.fields![key].type, `${path}.${key}`);
            }
            return concrete(target);
        }
        return this.require(value, target, path);
    }

    private install(value: Info, target: TypeDescriptor): void {
        const identity = value.identity;
        if (target.kind === 'union') {
            const matches = target.members!.filter(member => this.matches(value, member) === true);
            const contracts = matches.filter(mutable);
            if (contracts.length > 1 && contracts.some(type => !equivalent(type, contracts[0]))) this.error(`ambiguous union contracts for ${target.name}`);
            if (matches.length === 1) this.install(value, matches[0]);
            return;
        }
        if (!identity || !mutable(target)) return;
        if (identity.contract && !equivalent(identity.contract, target)) this.error(`incompatible established contract ${identity.contract.name} and ${target.name}`);
        identity.contract = target;
        if (target.kind === 'list') identity.items?.forEach(item => this.install(item, target.element!));
        if (target.kind === 'struct') identity.fields?.forEach((item, key) => {
            if (target.fields![key]) this.install(item, target.fields![key].type);
        });
    }

    private path(expr: Expr, scope: Scope): string | undefined {
        if (expr.t === 'group') return this.path(expr.e, scope);
        if (expr.t === 'name') {
            const binding = this.find(scope, expr.name);
            return binding ? String(binding.id) : undefined;
        }
        if (expr.t === 'member') {
            const base = this.path(expr.obj, scope);
            return base ? `${base}.${expr.name}` : undefined;
        }
        if (expr.t === 'index' && expr.index.t === 'str' && expr.index.parts.every(part => typeof part === 'string')) {
            const base = this.path(expr.obj, scope);
            return base ? `${base}.${expr.index.parts.join('')}` : undefined;
        }
        if (expr.t === 'index' && expr.index.t === 'num') {
            const base = this.path(expr.obj, scope);
            return base ? `${base}.#[${expr.index.raw ?? expr.index.v}]` : undefined;
        }
        return undefined;
    }

    private invalidate(scope: Scope, path?: string, call = false): void {
        for (const key of scope.narrow.keys()) {
            const bindingId = Number(key.split('.')[0]);
            let binding: Binding | undefined;
            for (let current: Scope | undefined = scope; current; current = current.parent) {
                binding ??= [...current.bindings.values()].find(value => value.id === bindingId);
            }
            if (path && (key === path || key.startsWith(`${path}.`))
                || call && (key.includes('.') || binding?.owner !== scope.functionId || binding?.captured)) scope.narrow.delete(key);
        }
        if (call) {
            for (let current: Scope | undefined = scope; current; current = current.parent) {
                for (const binding of current.bindings.values()) {
                    if ((binding.owner !== scope.functionId || binding.captured) && !binding.value.descriptor && !binding.value.callable) {
                        binding.value = binding.contract ? concrete(binding.contract) : unknown();
                    }
                    if (binding.value.identity && !binding.value.identity.contract) {
                        binding.value.identity.open = true;
                        binding.value.identity.items = undefined;
                        binding.value.identity.fields?.forEach((_, key, map) => map.set(key, unknown()));
                    }
                }
            }
        }
    }

    private fork(scope: Scope): Scope {
        const identities = new Map<Identity, Identity>();
        const cloneInfo = (info: Info): Info => {
            if (!info.identity) return { ...info };
            let identity = identities.get(info.identity);
            if (!identity) {
                identity = { kind: info.identity.kind, contract: info.identity.contract, open: info.identity.open };
                identities.set(info.identity, identity);
                identity.items = info.identity.items?.map(cloneInfo);
                identity.fields = info.identity.fields && new Map([...info.identity.fields].map(([key, value]) => [key, cloneInfo(value)]));
            }
            return { ...info, identity };
        };
        const cloneScope = (source: Scope): Scope => ({
            parent: source.parent && cloneScope(source.parent),
            bindings: new Map([...source.bindings].map(([key, value]) => [key, { ...value, value: cloneInfo(value.value) }])),
            narrow: new Map([...source.narrow].map(([key, value]) => [key, cloneInfo(value)])),
            functionId: source.functionId,
        });
        return cloneScope(scope);
    }

    private join(scope: Scope, branches: Scope[]): void {
        for (let current: Scope | undefined = scope; current; current = current.parent) {
            for (const [name, binding] of current.bindings) {
                const values = branches.map(branch => {
                    for (let other: Scope | undefined = branch; other; other = other.parent) {
                        const candidate = other.bindings.get(name);
                        if (candidate?.id === binding.id) return candidate.value;
                    }
                    return binding.value;
                });
                binding.value = this.merge(values);
            }
        }
        scope.narrow.clear();
        for (const [key, info] of branches[0]?.narrow ?? []) {
            if (branches.every(branch => branch.narrow.get(key)?.type && info.type && equivalent(branch.narrow.get(key)!.type!, info.type))) scope.narrow.set(key, info);
        }
    }

    private narrow(cond: Expr, scope: Scope, truth: boolean): void {
        if (cond.t === 'group') return this.narrow(cond.e, scope, truth);
        if (cond.t === 'unary' && cond.op === 'not') return this.narrow(cond.e, scope, !truth);
        if (cond.t === 'logic' && (cond.op === 'and' && truth || cond.op === 'or' && !truth)) {
            this.narrow(cond.l, scope, truth);
            this.narrow(cond.r, scope, truth);
            return;
        }
        if (cond.t !== 'call' || cond.callee.t !== 'name' || cond.callee.name !== 'isinstance' || cond.args.length !== 2
            || this.find(scope, 'isinstance') && this.find(scope, 'isinstance')!.value.builtin !== 'isinstance') return;
        const path = this.path(cond.args[0], scope);
        const target = this.descriptorExpr(cond.args[1], scope);
        if (!path || !target) return;
        const value = this.expr(cond.args[0], scope);
        const info = this.effective(value);
        if (truth) {
            const members = info.type?.kind === 'union' ? info.type.members!.filter(member => assignable(member, target) || assignable(target, member)) : [];
            scope.narrow.set(path, { ...info, type: members.length ? this.union(members) : target, typed: true });
        } else if (info.type?.kind === 'union') {
            const members = info.type.members!.filter(member => !assignable(member, target));
            if (members.length) scope.narrow.set(path, { ...info, type: this.union(members) });
        }
    }

    private descriptorExpr(expr: Expr, scope: Scope): TypeDescriptor | undefined {
        if (expr.t === 'group') return this.descriptorExpr(expr.e, scope);
        if (expr.t === 'type') return this.resolve(expr.type, scope);
        if (expr.t === 'name') return this.find(scope, expr.name)?.value.descriptor;
        if (expr.t === 'call' && expr.callee.t === 'name' && expr.callee.name === 'struct' && expr.args.length === 1) {
            const type = this.descriptorExpr(expr.args[0], scope);
            if (type?.kind === 'class' || type?.kind === 'struct') return descriptor('struct', `struct(${type.name})`, { fields: type.fields });
        }
        return undefined;
    }

    private schema(type: TypeDescriptor): void {
        if (type.kind === 'fn') this.error(`schema target ${type.name} contains an unsupported callable field`);
        if (type.kind === 'class' && !type.hydratable) this.error(`class ${type.name} is not hydratable; use schema=struct(${type.name}) for structural data`);
        if (type.element) this.schema(type.element);
        type.members?.forEach(member => this.schema(member));
        if (type.fields) for (const [name, field] of Object.entries(type.fields)) {
            try { this.schema(field.type); }
            catch (error) {
                if (error instanceof Failure) this.error(`${type.name}.${name}: ${error.reason}`);
                throw error;
            }
        }
    }

    private hint(expr: Expr, scope: Scope): boolean {
        if (expr.t === 'group') return this.hint(expr.e, scope);
        if (expr.t === 'name') return !!this.effective(this.find(scope, expr.name)?.value ?? unknown()).typed || !!scope.narrow.get(this.path(expr, scope) ?? '')?.typed;
        if (expr.t === 'member' || expr.t === 'index' || expr.t === 'slice') return this.hint(expr.obj, scope);
        if (expr.t === 'call') {
            if (expr.callee.t === 'name' && ['int', 'float', 'char', 'validate'].includes(expr.callee.name)) return true;
            if (expr.callee.t === 'name') return !!this.find(scope, expr.callee.name)?.value.callable?.result;
        }
        if (expr.t === 'binary' || expr.t === 'logic') return this.hint(expr.l, scope) || this.hint(expr.r, scope);
        if (expr.t === 'unary') return this.hint(expr.e, scope);
        return false;
    }

    private signedLiteral(expr: Expr, sign = 1): { raw: string; value: number; sign: number } | undefined {
        if (expr.t === 'group') return this.signedLiteral(expr.e, sign);
        if (expr.t === 'unary' && expr.op !== 'not') return this.signedLiteral(expr.e, expr.op === '-' ? -sign : sign);
        if (expr.t === 'num') return { raw: expr.raw ?? String(expr.v), value: expr.v, sign };
        return undefined;
    }

    private expr(expr: Expr, scope: Scope, expected?: TypeDescriptor, typed = !!expected): Info {
        const narrowed = scope.narrow.get(this.path(expr, scope) ?? '');
        if (narrowed) return narrowed;
        switch (expr.t) {
            case 'group': return this.expr(expr.e, scope, expected, typed);
            case 'type': return { descriptor: this.resolve(expr.type, scope) };
            case 'num': {
                if (!typed) return { legacy: true, literal: expr.v };
                const raw = expr.raw ?? String(expr.v);
                if (/^\d+$/.test(raw)) {
                    const value = BigInt(raw);
                    if (value > INT_MAX) this.error('int literal is outside signed 64-bit range');
                    return { type: primitive('int'), typed: true, literal: value };
                }
                if (!Number.isFinite(expr.v)) this.error('float literal must be finite');
                return { type: primitive('float'), typed: true, literal: expr.v };
            }
            case 'str': {
                for (const part of expr.parts) if (typeof part !== 'string') this.expr(part, scope);
                return { type: primitive('str'), typed, ...(expr.parts.every(part => typeof part === 'string') ? { literal: expr.parts.join('') } : {}) };
            }
            case 'bool': return { type: primitive('bool'), typed, literal: expr.v };
            case 'none': return { type: primitive('None'), typed, literal: null };
            case 'lambda': return this.lambda(expr, scope, expected?.kind === 'fn' ? { params: [...expected.params!], result: expected.result } : undefined);
            case 'name': {
                const value = this.find(scope, expr.name)?.value ?? unknown();
                return this.effective(value);
            }
            case 'special': return expr.name === 'env' ? concrete(primitive('object'), false) : { identity: { kind: 'list' }, type: descriptor('list', 'list[str]', { element: primitive('str') }) };
            case 'list': {
                const element = expected?.kind === 'list' ? expected.element : undefined;
                return { typed, identity: { kind: 'list', items: expr.items.map(item => this.expr(item, scope, element, typed)) } };
            }
            case 'dict': {
                const fields = new Map<string, Info>();
                let open = false;
                const outerLine = this.line;
                for (const entry of expr.entries) {
                    if (!Array.isArray(entry)) {
                        fields.set(entry.name, this.def(entry, scope, false));
                        this.line = outerLine;
                        continue;
                    }
                    const [key, value] = entry;
                    const name = stringKey(this.expr(key, scope));
                    const fieldType = name && expected?.kind === 'struct' ? expected.fields![name]?.type : undefined;
                    const info = this.expr(value, scope, fieldType, typed);
                    if (name === undefined) open = true;
                    else fields.set(name, info);
                }
                return { typed, identity: { kind: 'object', fields, open } };
            }
            case 'unary': {
                if (expr.op === 'not') {
                    this.expr(expr.e, scope);
                    return concrete(primitive('bool'), false);
                }
                const contextual = typed || this.hint(expr.e, scope);
                const signed = contextual ? this.signedLiteral(expr) : undefined;
                if (signed && /^\d+$/.test(signed.raw)) {
                    const value = BigInt(signed.sign) * BigInt(signed.raw);
                    if (value < INT_MIN || value > INT_MAX) this.error('int literal is outside signed 64-bit range');
                    return { type: primitive('int'), typed: true, literal: value };
                }
                const value = this.effective(this.expr(expr.e, scope, undefined, contextual));
                if (value.typed && value.type && !this.every(value.type, numeric)) this.error(`bad typed operand for unary ${expr.op}: ${value.type.name}`);
                const literal = typeof value.literal === 'bigint' || typeof value.literal === 'number' ? expr.op === '-' ? -value.literal : value.literal : undefined;
                if (typeof literal === 'bigint' && (literal < INT_MIN || literal > INT_MAX)) this.error('int unary arithmetic overflows signed 64-bit range');
                return { ...value, literal };
            }
            case 'binary': {
                const contextual = typed || this.hint(expr.l, scope) || this.hint(expr.r, scope);
                const left = this.expr(expr.l, scope, undefined, contextual);
                const right = this.expr(expr.r, scope, undefined, contextual);
                return this.binary(expr.op, left, right, contextual);
            }
            case 'logic': {
                const left = this.expr(expr.l, scope, expected, typed);
                const branch = this.fork(scope);
                this.narrow(expr.l, branch, expr.op === 'and');
                const right = this.expr(expr.r, branch, expected, typed);
                this.join(scope, [scope, branch]);
                return this.merge([left, right]);
            }
            case 'compare': {
                const contextual = expr.operands.some(operand => this.hint(operand, scope));
                const operands = expr.operands.map(operand => this.effective(this.expr(operand, scope, undefined, contextual)));
                for (let i = 0; i < expr.ops.length; i++) {
                    if (['==', '!='].includes(expr.ops[i])) continue;
                    const left = operands[i], right = operands[i + 1];
                    if (!(left.typed || right.typed) || !left.type || !right.type) continue;
                    if (['in', 'not in'].includes(expr.ops[i])) {
                        if (!this.every(right.type, type => ['list', 'object', 'struct', 'str', 'char', 'enum'].includes(type.kind))) this.error(`typed ${right.type.name} does not support membership`);
                    } else if (!this.pairs(left.type, right.type, (a, b) => numeric(a) && numeric(b) || this.stringType(a) && this.stringType(b))) {
                        this.error(`incompatible typed comparison: ${left.type.name} and ${right.type.name}`);
                    }
                }
                return concrete(primitive('bool'), false);
            }
            case 'ternary': {
                this.expr(expr.cond, scope);
                const yes = this.fork(scope), no = this.fork(scope);
                this.narrow(expr.cond, yes, true);
                this.narrow(expr.cond, no, false);
                const values = [this.expr(expr.then, yes, expected, typed), this.expr(expr.else, no, expected, typed)];
                this.join(scope, [yes, no]);
                return this.merge(values);
            }
            case 'member': return this.member(this.memberReceiver(expr, scope), expr.name);
            case 'index': {
                const object = this.expr(expr.obj, scope);
                const index = this.expr(expr.index, scope);
                return this.index(object, index);
            }
            case 'slice': {
                const object = this.effective(this.expr(expr.obj, scope));
                if (expr.lo) this.expr(expr.lo, scope);
                if (expr.hi) this.expr(expr.hi, scope);
                return object.type?.kind === 'list' ? concrete(object.type, !!object.typed) : object.type && this.stringType(object.type) ? concrete(primitive('str'), !!object.typed) : unknown();
            }
            case 'call': return this.call(expr, scope);
            case 'block': return this.block(expr.body, this.child(scope), expected);
            case 'if': return this.branches(expr.branches, expr.orelse, scope, expected);
            case 'log':
                this.expr(expr.level, scope);
                expr.args.forEach(arg => this.expr(arg, scope));
                return concrete(primitive('None'), false);
            case 'human':
                this.expr(expr.prompt, scope);
                this.invalidate(scope, undefined, true);
                return concrete(primitive('str'), false);
            case 'ask':
            case 'think':
            case 'agent': {
                let schema: TypeDescriptor | undefined;
                for (const [key, mod] of Object.entries(expr.mods)) {
                    const value = this.expr(mod, scope);
                    if (key === 'schema' && value.descriptor) {
                        schema = value.descriptor;
                        this.schema(schema);
                    }
                }
                this.expr(expr.prompt, scope);
                this.invalidate(scope, undefined, true);
                return schema ? concrete(schema) : unknown();
            }
        }
    }

    private every(type: TypeDescriptor, predicate: (type: TypeDescriptor) => boolean): boolean {
        return type.kind === 'union' ? type.members!.every(member => this.every(member, predicate)) : predicate(type);
    }

    private pairs(a: TypeDescriptor, b: TypeDescriptor, predicate: (a: TypeDescriptor, b: TypeDescriptor) => boolean): boolean {
        return this.every(a, left => this.every(b, right => predicate(left, right)));
    }

    private stringType(type: TypeDescriptor): boolean {
        return ['str', 'char', 'enum'].includes(type.kind);
    }

    private binary(op: string, l: Info, r: Info, contextual: boolean): Info {
        let left = this.effective(l), right = this.effective(r);
        if (!contextual && !left.typed && !right.typed) {
            if (left.legacy && right.legacy) {
                if (typeof left.literal === 'number' && typeof right.literal === 'number') {
                    const a = left.literal, b = right.literal;
                    let literal: number | undefined;
                    switch (op) {
                        case '+': literal = a + b; break;
                        case '-': literal = a - b; break;
                        case '*': literal = a * b; break;
                        case '/': literal = a / b; break;
                        case '//': literal = Math.floor(a / b); break;
                        case '%': literal = ((a % b) + b) % b; break;
                        case '**': literal = a ** b; break;
                    }
                    return { legacy: true, literal };
                }
                return { legacy: true };
            }
            if (left.type && right.type && this.stringType(left.type) && this.stringType(right.type) && op === '+') {
                return { type: primitive('str'), literal: typeof left.literal === 'string' && typeof right.literal === 'string' ? left.literal + right.literal : undefined };
            }
            return unknown();
        }
        if (op === '+' && left.type?.kind === 'list' && right.identity?.kind === 'list') right = this.require(right, left.type, 'list concatenation');
        if (op === '+' && right.type?.kind === 'list' && left.identity?.kind === 'list') left = this.require(left, right.type, 'list concatenation');
        if (left.legacy || right.legacy) this.error('legacy numbers require explicit int() or float() conversion in typed arithmetic');
        if (!left.type || !right.type) return unknown();
        const result: TypeDescriptor[] = [];
        const valid = this.pairs(left.type, right.type, (a, b) => {
            if (numeric(a) && numeric(b)) {
                if (a.kind !== b.kind) return false;
                result.push(primitive(op === '/' ? 'float' : a.kind));
                return true;
            }
            if (op === '+' && this.stringType(a) && this.stringType(b)) {
                result.push(primitive('str'));
                return true;
            }
            if (op === '*' && (this.stringType(a) && b.kind === 'int' || a.kind === 'int' && this.stringType(b))) {
                result.push(primitive('str'));
                return true;
            }
            if (op === '+' && a.kind === 'list' && b.kind === 'list' && equivalent(a.element!, b.element!)) {
                result.push(a);
                return true;
            }
            if (op === '*' && (a.kind === 'list' && b.kind === 'int' || a.kind === 'int' && b.kind === 'list')) {
                result.push(a.kind === 'list' ? a : b);
                return true;
            }
            return false;
        });
        if (!valid) this.error(`incompatible typed operands for ${op}: ${left.type.name} and ${right.type.name}`);
        if (typeof left.literal === 'bigint' && typeof right.literal === 'bigint') {
            if (['/', '//', '%'].includes(op) && right.literal === 0n) this.error('typed division by zero');
            let value: bigint | undefined;
            switch (op) {
                case '+': value = left.literal + right.literal; break;
                case '-': value = left.literal - right.literal; break;
                case '*': value = left.literal * right.literal; break;
                case '//': {
                    value = left.literal / right.literal;
                    if (left.literal % right.literal !== 0n && (left.literal < 0n) !== (right.literal < 0n)) value--;
                    break;
                }
                case '%': value = ((left.literal % right.literal) + right.literal) % right.literal; break;
                case '**':
                    if (right.literal >= 0n && right.literal <= 64n) value = left.literal ** right.literal;
                    break;
            }
            if (value !== undefined) {
                if (value < INT_MIN || value > INT_MAX) this.error('int arithmetic overflows signed 64-bit range');
                return { type: this.union(result), typed: true, literal: value };
            }
        }
        if (typeof left.literal === 'number' && typeof right.literal === 'number') {
            const a = left.literal, b = right.literal;
            let value: number | undefined;
            switch (op) {
                case '+': value = a + b; break;
                case '-': value = a - b; break;
                case '*': value = a * b; break;
                case '/': value = a / b; break;
                case '//': value = Math.floor(a / b); break;
                case '%': value = ((a % b) + b) % b; break;
                case '**': value = a ** b; break;
            }
            if (value !== undefined) {
                if (!Number.isFinite(value)) this.error('typed float arithmetic must be finite');
                return { type: this.union(result), typed: true, literal: value };
            }
        }
        return { type: this.union(result), typed: true };
    }

    private memberReceiver(expr: Extract<Expr | AssignTarget, { t: 'member' }>, scope: Scope): Info {
        const value = this.expr(expr.obj, scope);
        this.onMember?.(expr, this.effective(value).type);
        return value;
    }

    private member(value: Info, name: string, writing = false): Info {
        const info = this.effective(value);
        if (info.type?.kind === 'union') {
            return this.merge(info.type.members!.map(type => this.member(concrete(type, !!info.typed), name, writing)));
        }
        if (info.type?.kind === 'struct' || info.type?.kind === 'class') {
            const field = Object.hasOwn(info.type.fields!, name) ? info.type.fields![name] : undefined;
            if (field) return { ...info.identity?.fields?.get(name), type: field.type, typed: true, ...(field.type.kind === 'fn' ? { callable: { params: [...field.type.params!], result: field.type.result } } : {}) };
            const methods = info.type.methods;
            const method = methods && Object.hasOwn(methods, name) ? methods[name] : undefined;
            if (method && !writing) return { typed: true, callable: { params: method.paramTypes ?? method.params.map(() => undefined), result: method.returnType } };
            this.error(`${info.type.name}.${name}: ${writing ? 'extra field' : 'unknown member'}`);
        }
        if (info.type?.kind === 'object') return unknown();
        if (info.identity?.fields) return info.identity.fields.get(name) ?? unknown();
        if (info.typed && info.type) this.error(`${info.type.name} does not have member '${name}'`);
        return unknown();
    }

    private index(value: Info, index: Info, writing = false): Info {
        const info = this.effective(value);
        if (info.type?.kind === 'union') return this.merge(info.type.members!.map(type => this.index(concrete(type, !!info.typed), index, writing)));
        if (info.type?.kind === 'list') {
            if (info.typed && (index.type && index.type.kind !== 'int' && !index.legacy
                || typeof index.literal === 'number' && !Number.isInteger(index.literal))) this.error(`list index must be an integer`);
            return concrete(info.type.element!, !!info.typed);
        }
        if (info.type?.kind === 'struct' || info.type?.kind === 'class') {
            const key = stringKey(index);
            if (key !== undefined) return this.member(info, key, writing);
            if (index.type && !this.stringType(index.type)) this.error(`record index must be a string, got ${index.type.name}`);
            return unknown();
        }
        if (info.type && this.stringType(info.type)) {
            if (writing && info.typed) this.error('typed strings do not support item assignment');
            return concrete(primitive('str'), !!info.typed);
        }
        if (info.type?.kind === 'object') return unknown();
        if (info.identity?.fields) {
            const key = stringKey(index);
            return key === undefined ? unknown() : info.identity.fields.get(key) ?? unknown();
        }
        if (info.identity?.items && (typeof index.literal === 'number' || typeof index.literal === 'bigint')) {
            const offset = Number(index.literal);
            return info.identity.items.at(offset) ?? unknown();
        }
        if (info.typed && info.type) this.error(`${info.type.name} does not support indexing`);
        return unknown();
    }

    private call(expr: Extract<Expr, { t: 'call' }>, scope: Scope): Info {
        const name = expr.callee.t === 'name' ? expr.callee.name : undefined;
        const binding = name ? this.find(scope, name) : undefined;
        const builtin = name && (!binding || binding.value.builtin === name || binding.value.descriptor?.kind === name);
        const validation = binding?.value.builtin ?? (builtin ? name : undefined);
        if (validation && ['isinstance', 'validate'].includes(validation)) {
            const value = expr.args[0] ? this.expr(expr.args[0], scope) : unknown();
            const target = expr.args[1] ? this.descriptorExpr(expr.args[1], scope) : undefined;
            for (const arg of expr.args.slice(1)) this.expr(arg, scope);
            if (target && validation === 'validate') return this.validation(value, target, 'validate');
            return validation === 'isinstance' ? concrete(primitive('bool'), false) : unknown();
        }
        if (builtin && name === 'struct') {
            expr.args.forEach(arg => this.expr(arg, scope));
            const type = this.descriptorExpr(expr, scope);
            if (!type && expr.args.length === 1 && this.descriptorExpr(expr.args[0], scope)) this.error('struct() requires a class or struct descriptor');
            return type ? { descriptor: type } : unknown();
        }
        if (builtin && name === 'object') {
            const value = expr.args[0] ? this.expr(expr.args[0], scope) : undefined;
            expr.args.slice(1).forEach(arg => this.expr(arg, scope));
            if (!value) return { identity: { kind: 'object', fields: new Map() } };
            return this.snapshot(value);
        }
        const conversion = binding?.value.descriptor?.kind ?? (builtin ? name : undefined);
        if (conversion && ['int', 'float', 'str', 'char', 'bool'].includes(conversion)) {
            const args = expr.args.map(arg => this.expr(arg, scope));
            const info = args[0];
            if (conversion === 'int' && info?.literal !== undefined) {
                const value = info.literal;
                if (typeof value === 'number' && (!Number.isFinite(value) || !Number.isInteger(value))
                    || typeof value === 'string' && !/^[+-]?\d+$/.test(value)
                    || typeof value === 'boolean' || value === null) this.error('int() requires an exact finite integer');
                const integer = BigInt(value as string | number | bigint);
                if (integer < INT_MIN || integer > INT_MAX) this.error('int() is outside signed 64-bit range');
                return { type: primitive('int'), typed: true, literal: integer };
            }
            if (conversion === 'float' && info?.literal !== undefined) {
                if (typeof info.literal === 'boolean' || info.literal === null
                    || typeof info.literal === 'string' && !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(info.literal)) this.error('float() requires a numeric value');
                const value = Number(info.literal);
                if (!Number.isFinite(value)) this.error('float() must be finite');
                return { type: primitive('float'), typed: true, literal: value };
            }
            if (conversion === 'char' && info) return this.require(info, primitive('char'), 'char()');
            return concrete(primitive(conversion), ['int', 'float', 'char'].includes(conversion));
        }
        if (builtin && ['abs', 'round', 'sum', 'len', 'range', 'type', 'list', 'sorted', 'reversed', 'json_stringify', 'any', 'all'].includes(name!)) {
            const args = expr.args.map(arg => this.expr(arg, scope));
            const value = args[0] && this.effective(args[0]);
            if (name === 'len') return { legacy: true };
            if (name === 'type' || name === 'json_stringify') return concrete(primitive('str'), false);
            if (name === 'any' || name === 'all') return concrete(primitive('bool'), false);
            if (name === 'range') return { identity: { kind: 'list' }, legacy: false };
            if (['list', 'sorted', 'reversed'].includes(name!) && value) {
                if (value.identity?.kind === 'list') return { identity: { kind: 'list', items: value.identity.items && [...value.identity.items] }, type: value.type };
                if (value.type?.kind === 'list') return { identity: { kind: 'list' }, type: value.type };
                if (value.type && this.stringType(value.type)) return { identity: { kind: 'list' }, type: descriptor('list', 'list[str]', { element: primitive('str') }) };
                return { identity: { kind: 'list' } };
            }
            if (name === 'sum' && value) {
                const items = value.identity?.items;
                const element = value.type?.kind === 'list' ? value.type.element : items?.length ? this.merge(items).type : undefined;
                if (element && numeric(element)) {
                    let result: Info = { type: element, typed: true, literal: element.kind === 'int' ? 0n : 0 };
                    if (items) for (const item of items) result = this.binary('+', result, item, true);
                    return result;
                }
                if (value.typed && element) this.error(`sum: ${element.name} is not a homogeneous numeric type`);
                return items?.every(item => item.legacy) ? { legacy: true } : unknown();
            }
            if (value?.type && value.typed && !this.every(value.type, numeric)) this.error(`${name}: ${value.type.name} is not numeric`);
            if (value?.type && this.every(value.type, numeric)) {
                if (name === 'abs' && typeof value.literal === 'bigint') {
                    const literal = value.literal < 0n ? -value.literal : value.literal;
                    if (literal > INT_MAX) this.error('abs: int overflow');
                    return { ...value, literal };
                }
                return { ...value, literal: undefined };
            }
            return value?.legacy ? { legacy: true } : unknown();
        }
        if (expr.callee.t === 'member') {
            const object = this.memberReceiver(expr.callee, scope);
            const method = this.builtinMethod(object, expr.callee.name, expr.args, scope);
            if (method) return method;
            return this.invoke(this.member(object, expr.callee.name), expr.args, scope, expr.callee.name);
        }
        const callee = this.expr(expr.callee, scope);
        if (callee.descriptor?.kind === 'class' && callee.type?.kind !== 'fn' && callee.type?.kind !== 'union') {
            const constructor = callee.descriptor.methods?.[callee.descriptor.name];
            const callable: Callable = constructor ? { params: constructor.paramTypes ?? constructor.params.map(() => undefined) } : { params: [] };
            this.invoke({ callable }, expr.args, scope, callee.descriptor.name);
            return concrete(callee.descriptor);
        }
        if (callee.descriptor?.kind === 'struct') {
            const args = expr.args.map(arg => this.expr(arg, scope));
            return args[0] ? this.require(args[0], callee.descriptor, callee.descriptor.name) : unknown();
        }
        return this.invoke(callee, expr.args, scope, name ?? 'call');
    }

    private invoke(value: Info, args: Expr[], scope: Scope, name: string): Info {
        return this.invokeArguments(value, args.length, (i, type) => this.expr(args[i], scope, type), scope, name);
    }

    private invokeArguments(value: Info, count: number, argument: (i: number, type?: TypeDescriptor) => Info, scope: Scope, name: string): Info {
        const info = this.effective(value);
        if (info.type?.kind === 'union' && info.typed) {
            if (!info.type.members!.every(type => type.kind === 'fn')) this.error(`${info.type.name} is not callable without narrowing`);
            const signatures = info.type.members!;
            if (signatures.some(type => type.params!.length !== count)) this.error(`${name}: incompatible callable arity`);
            for (let i = 0; i < count; i++) {
                const value = argument(i, signatures[0].params![i]);
                for (const signature of signatures) this.require(value, signature.params![i], `${name} argument ${i + 1}`);
            }
            this.invalidate(scope, undefined, true);
            return { type: this.union(signatures.map(type => type.result!)), typed: true };
        }
        const callable = info.callable ?? (info.type?.kind === 'fn' ? { params: [...info.type.params!], result: info.type.result } : undefined);
        if (callable && callable.params.length !== count) this.error(`${name}: expected ${callable.params.length} arguments, got ${count}`);
        for (let i = 0; i < count; i++) {
            const type = callable?.params[i];
            const value = argument(i, type);
            if (type) this.require(value, type, `${name} argument ${i + 1}`);
        }
        if (info.typed && info.type && !callable && info.type.kind !== 'union') this.error(`${info.type.name} is not callable`);
        this.invalidate(scope, undefined, true);
        return callable?.result ? concrete(callable.result) : callable?.inferred ?? unknown();
    }

    private lambda(expr: Extract<Expr, { t: 'lambda' }>, scope: Scope, context?: Callable): Info {
        return this.def({
            t: 'def', name: '<lambda>', params: expr.params, line: expr.line,
            body: [{ t: 'return', value: expr.body, line: expr.line }],
        }, scope, false, undefined, context);
    }

    private listCallbackMethod(info: Info, name: string, args: Expr[], scope: Scope): Info {
        if (args.length < 1 || args.length > (name === 'reduce' ? 2 : 1)) this.error(`${name}: incompatible argument count`);
        const element = info.type?.kind === 'list' ? concrete(info.type.element!, !!info.typed)
            : info.identity?.items ? this.merge(info.identity.items) : unknown();
        let expr = args[0];
        while (expr.t === 'group') expr = expr.e;
        let callback = expr.t === 'lambda' ? unknown() : this.expr(args[0], scope);
        const initialType = callback.callable?.params[0] ?? (info.typed ? element.type : undefined);
        const initial = args[1] && this.expr(args[1], scope, initialType);
        const accumulator = initial ?? element;
        if (expr.t === 'lambda') callback = this.lambda(expr, scope, {
            params: name === 'reduce' ? [accumulator.type, element.type] : [element.type],
        });
        if (callback.descriptor) {
            const kind = callback.descriptor.kind;
            if (['int', 'float', 'str', 'char', 'bool', 'object', 'struct'].includes(kind)) {
                callback = { callable: { params: [undefined], result: callback.descriptor } };
            } else if (kind !== 'class') this.error(`${name}: ${callback.descriptor.name} is not callable`);
        }
        if (!callback.callable && (callback.legacy || callback.identity || callback.type && !['fn', 'union'].includes(callback.type.kind))) {
            this.error(`${name}: ${callback.type?.name ?? 'value'} is not callable`);
        }
        const inputs = name === 'reduce' ? [accumulator, element] : [element];
        const result = this.invokeArguments(callback, inputs.length, i => inputs[i], scope, name);
        if (name === 'reduce') {
            const param = expr.t !== 'lambda' ? callback.callable?.params[0] : undefined;
            if (param) this.require(result, param, 'reduce callback return');
            return this.merge([accumulator, result]);
        }
        const output = name === 'filter' ? element : result;
        return output.type ? { type: descriptor('list', `list[${output.type.name}]`, { element: output.type }), typed: !!output.typed }
            : { identity: { kind: 'list' } };
    }

    private builtinMethod(value: Info, name: string, args: Expr[], scope: Scope): Info | undefined {
        const info = this.effective(value);
        if (info.type?.kind === 'union' && info.typed) {
            const values = info.type.members!.map(type => this.builtinMethod(concrete(type), name, args, this.fork(scope)));
            if (values.some(value => !value)) return undefined;
            this.invalidate(scope, undefined, true);
            return this.merge(values as Info[]);
        }
        const kind = info.type?.kind ?? info.identity?.kind;
        if (kind === 'list' && isListCallbackMethod(name)) return this.listCallbackMethod(info, name, args, scope);
        const stringMethods = ['upper', 'lower', 'strip', 'lstrip', 'rstrip', 'title', 'capitalize', 'isdigit', 'split', 'splitlines', 'join', 'replace', 'startswith', 'endswith', 'find', 'count'];
        if (info.type && this.stringType(info.type) && stringMethods.includes(name)) {
            const arities: Record<string, [number, number]> = {
                split: [0, 1], join: [1, 1], replace: [2, 2], startswith: [1, 1], endswith: [1, 1], find: [1, 1], count: [1, 1],
            };
            const arity = arities[name];
            if (info.typed && arity && (args.length < arity[0] || args.length > arity[1])) this.error(`${name}: incompatible argument count`);
            const values = args.map(arg => this.expr(arg, scope));
            if (info.typed) {
                if (['replace', 'startswith', 'endswith', 'find', 'count'].includes(name)) values.forEach(value => this.require(value, primitive('str'), `${name} argument`));
                if (name === 'split' && values[0]) this.require(values[0], descriptor('union', 'str | None', { members: [primitive('str'), primitive('None')] }), 'split argument');
                if (name === 'join' && values[0]) this.iterableElements(values[0], primitive('str'), 'join argument');
            }
            if (name === 'find' || name === 'count') return { legacy: true };
            if (name === 'isdigit' || name === 'startswith' || name === 'endswith') return concrete(primitive('bool'), !!info.typed);
            if (name === 'split' || name === 'splitlines') return { type: descriptor('list', 'list[str]', { element: primitive('str') }), identity: { kind: 'list' } };
            return concrete(primitive('str'), !!info.typed);
        }
        const listMethods = ['append', 'extend', 'insert', 'pop', 'remove', 'clear', 'reverse', 'sort', 'copy', 'count', 'index'];
        const objectMethods = ['pop', 'update', 'clear', 'copy', 'get', 'keys', 'values', 'items'];
        if (!(kind === 'list' && listMethods.includes(name) || ['object', 'struct'].includes(kind ?? '') && objectMethods.includes(name))) return undefined;
        const type = kind === 'list' && info.typed ? info.type?.element : undefined;
        const checks: (TypeDescriptor | undefined)[] = [];
        if (type && ['append', 'remove'].includes(name)) checks[0] = type;
        if (type && name === 'insert') checks[1] = type;
        const values = args.map((arg, i) => {
            const context = i === 0 && name === 'extend' && type ? descriptor('list', `list[${type.name}]`, { element: type })
                : i === 0 && name === 'update' && info.typed ? info.type : checks[i];
            const value = this.expr(arg, scope, context);
            if (checks[i]) this.require(value, checks[i]!, `${name} argument ${i + 1}`);
            return value;
        });
        if (type && name === 'extend' && values[0]) this.iterableElements(values[0], type, 'extend argument');
        if (type && ['insert', 'pop'].includes(name) && values[0]) {
            const index = values[0];
            if (index.type && index.type.kind !== 'int' && !index.legacy || typeof index.literal === 'number' && !Number.isInteger(index.literal)) this.error(`${name}: index must be an integer`);
        }
        if (kind === 'struct' && info.type?.fields) {
            if (name === 'clear' && Object.keys(info.type.fields).length) this.error(`${info.type.name}: clear() removes required fields`);
            if (name === 'pop') {
                const key = values[0] && stringKey(values[0]);
                if (key && info.type.fields[key]) this.error(`${info.type.name}.${key}: pop() removes a required field`);
            }
            if (name === 'update' && values[0]?.identity?.fields) {
                for (const [key, child] of values[0].identity.fields) {
                    const field = info.type.fields[key];
                    if (!field) this.error(`${info.type.name}.${key}: extra field`);
                    this.require(child, field.type, `${info.type.name}.${key}`);
                }
            }
        }
        if (name === 'copy') {
            if (kind === 'list') return { identity: { kind: 'list', items: info.identity?.items && [...info.identity.items] } };
            return { identity: { kind: 'object', fields: info.identity?.fields && new Map(info.identity.fields), open: info.identity?.open } };
        }
        if (['get', 'pop'].includes(name)) {
            const key = values[0] && stringKey(values[0]);
            const result = kind === 'list' && type ? concrete(type) : key ? this.member(info, key) : unknown();
            if (name === 'pop') this.invalidate(scope, undefined, true);
            return result;
        }
        if (['count', 'index'].includes(name)) return { legacy: true };
        if (name === 'keys') return { identity: { kind: 'list' } };
        if (name === 'values' || name === 'items') return unknown();
        if (!info.identity?.contract && info.identity?.items) {
            if (name === 'append' && values[0]) info.identity.items.push(values[0]);
            else if (name === 'extend' && values[0]?.identity?.items) info.identity.items.push(...values[0].identity.items);
            else if (name === 'clear') info.identity.items = [];
            else info.identity.items = undefined;
        }
        if (info.identity?.contract || !info.identity) this.invalidate(scope, undefined, true);
        return concrete(primitive('None'), false);
    }

    private iterableElements(value: Info, target: TypeDescriptor, path: string): void {
        const info = this.effective(value);
        if (info.identity?.items) {
            info.identity.items.forEach((item, i) => this.require(item, target, `${path}[${i}]`));
        } else if (info.type?.kind === 'list') {
            if (!assignable(info.type.element!, target)) this.error(`${path}: incompatible element type ${info.type.element!.name}, expected ${target.name}`);
        } else if (info.type && this.stringType(info.type)) {
            if (!assignable(primitive('str'), target)) this.error(`${path}: string elements do not satisfy ${target.name}`);
        } else if (info.type?.kind === 'object' || info.type?.kind === 'struct') {
            if (!assignable(primitive('str'), target)) this.error(`${path}: dictionary keys do not satisfy ${target.name}`);
        } else if (info.type && info.type.kind !== 'union' || info.legacy || info.callable || info.descriptor) {
            this.error(`${path}: value is not iterable`);
        }
    }

    private snapshot(value: Info, seen = new Map<Identity, Info>()): Info {
        const info = this.effective(value);
        if (info.identity && seen.has(info.identity)) return seen.get(info.identity)!;
        if (info.identity?.kind === 'list' || info.type?.kind === 'list') {
            const result: Info = { identity: { kind: 'list' }, type: info.type };
            if (info.identity) seen.set(info.identity, result);
            result.identity!.items = info.identity?.items?.map(item => this.snapshot(item, seen));
            return result;
        }
        if (info.identity?.kind === 'object' || info.type?.kind === 'struct' || info.type?.kind === 'class') {
            const result: Info = { identity: { kind: 'object', fields: new Map(), open: info.identity?.open } };
            if (info.identity) seen.set(info.identity, result);
            const fields = info.identity?.fields ?? (info.type?.fields && new Map(Object.entries(info.type.fields).map(([key, field]) => [key, concrete(field.type)])));
            if (!fields) result.identity!.open = true;
            else for (const [key, item] of fields) if (!item.callable && item.type?.kind !== 'fn') {
                result.identity!.fields!.set(key, this.snapshot(item, seen));
            }
            return result;
        }
        return { ...info };
    }

    private def(stmt: DefStmt, scope: Scope, declare = true, self?: TypeDescriptor, context?: Callable): Info {
        if (context && context.params.length !== stmt.params.length) this.error(`${stmt.name}: expected ${context.params.length} parameters, got ${stmt.params.length}`);
        const params = stmt.params.map((_, i) => stmt.paramTypes?.[i] ? this.resolve(stmt.paramTypes[i]!, scope) : context?.params[i]);
        const result = stmt.returnType ? this.resolve(stmt.returnType, scope) : context?.result;
        const callable: Callable = { params, result };
        const info: Info = { callable, typed: !!result || params.some(Boolean) };
        if (params.every(Boolean) && result) info.type = descriptor('fn', stmt.name, { params: params as TypeDescriptor[], result });
        if (declare) this.define(scope, stmt.name, info);
        const capture = (node: unknown): void => {
            if (!node || typeof node !== 'object') return;
            if ('t' in node && node.t === 'name' && 'name' in node && typeof node.name === 'string' && !stmt.params.includes(node.name)) {
                const binding = this.find(scope, node.name);
                if (binding) binding.captured = true;
            }
            for (const child of Object.values(node)) {
                if (Array.isArray(child)) child.forEach(capture);
                else capture(child);
            }
        };
        stmt.body.forEach(capture);
        const captured = this.fork(scope);
        const local = this.child(captured, this.nextId++);
        if (self) this.define(local, 'self', concrete(self), self);
        stmt.params.forEach((name, i) => this.define(local, name, params[i] ? concrete(params[i]!) : unknown(), params[i]));
        const saved = this.function;
        this.function = { result, returns: [] };
        this.block(stmt.body, local);
        if (!this.returns(stmt.body)) {
            this.line = stmt.line;
            const value = concrete(primitive('None'), false);
            if (result) this.require(value, result, `${stmt.name} return`);
            this.function.returns.push(value);
        }
        if (!result) callable.inferred = this.merge(this.function.returns);
        this.function = saved;
        this.line = stmt.line;
        return info;
    }

    private returns(body: Stmt[]): boolean {
        return body.some(stmt => stmt.t === 'return' || stmt.t === 'fail' || stmt.t === 'success'
            || stmt.t === 'if' && !!stmt.orelse && stmt.branches.every(branch => this.returns(branch.body)) && this.returns(stmt.orelse)
            || stmt.t === 'block' && this.returns(stmt.body));
    }

    private block(body: Stmt[], scope: Scope, expected?: TypeDescriptor): Info {
        let result: Info = concrete(primitive('None'), false);
        for (const stmt of body) {
            this.line = stmt.line;
            result = this.statement(stmt, scope, expected);
        }
        return result;
    }

    private branches(branches: { cond: Expr; body: Stmt[] }[], orelse: Stmt[] | undefined, scope: Scope, expected?: TypeDescriptor): Info {
        const paths: Scope[] = [], values: Info[] = [];
        let remaining = this.fork(scope);
        for (const branch of branches) {
            this.expr(branch.cond, remaining);
            const yes = this.fork(remaining);
            this.narrow(branch.cond, yes, true);
            const child = this.child(yes);
            values.push(this.block(branch.body, child, expected));
            if (!this.returns(branch.body)) paths.push(child);
            this.narrow(branch.cond, remaining, false);
        }
        if (orelse) {
            const child = this.child(remaining);
            values.push(this.block(orelse, child, expected));
            if (!this.returns(orelse)) paths.push(child);
        } else {
            paths.push(remaining);
            values.push(concrete(primitive('None'), false));
        }
        if (paths.length) this.join(scope, paths);
        return this.merge(values);
    }

    private assignment(target: AssignTarget, op: string, expr: Expr, scope: Scope): void {
        if (target.t === 'name') {
            const binding = this.find(scope, target.name);
            if (binding?.readonly) this.error(`cannot reassign type declaration '${target.name}'`);
            const value = this.expr(expr, scope, binding?.contract);
            const assigned = op === '=' ? value : this.binary(op.slice(0, -1), binding?.value ?? unknown(), value, !!binding?.contract);
            if (binding) {
                binding.value = binding.contract ? this.require(assigned, binding.contract, target.name) : assigned;
                this.invalidate(scope, String(binding.id));
            }
            return;
        }
        const object = target.t === 'member' ? this.memberReceiver(target, scope) : this.expr(target.obj, scope);
        const index = target.t === 'index' ? this.expr(target.index, scope) : undefined;
        const current = target.t === 'member' ? this.member(object, target.name, true) : this.index(object, index!, true);
        const contract = this.effective(object).typed ? current.type : undefined;
        const value = this.expr(expr, scope, contract);
        const assigned = op === '=' ? value : this.binary(op.slice(0, -1), current, value, !!contract);
        if (contract) this.require(assigned, contract, target.t === 'member' ? `field ${target.name}` : 'item assignment');
        const info = this.effective(object);
        const key = target.t === 'member' ? target.name : index && stringKey(index);
        if (info.identity?.fields && key !== undefined) info.identity.fields.set(key, assigned);
        if (info.identity?.items && index && (typeof index.literal === 'number' || typeof index.literal === 'bigint')) {
            const offset = Number(index.literal);
            if (offset >= 0 && offset < info.identity.items.length) info.identity.items[offset] = assigned;
        }
        const base = this.path(target.obj, scope);
        this.invalidate(scope, base ? key !== undefined ? `${base}.${key}` : base : undefined);
        for (const path of scope.narrow.keys()) if (path.includes('.')) scope.narrow.delete(path);
    }

    private statement(stmt: Stmt, scope: Scope, expected?: TypeDescriptor): Info {
        switch (stmt.t) {
            case 'let': {
                const type = stmt.annotation && this.resolve(stmt.annotation, scope);
                const value = this.expr(stmt.value, scope, type);
                this.define(scope, stmt.name, type ? this.require(value, type, stmt.name) : value, type);
                break;
            }
            case 'assign': this.assignment(stmt.target, stmt.op, stmt.value, scope); break;
            case 'expr': return this.expr(stmt.e, scope, expected);
            case 'def': this.def(stmt, scope); break;
            case 'enum':
                this.define(scope, stmt.name, { descriptor: descriptor('enum', stmt.name, { values: stmt.values }) }).readonly = true;
                break;
            case 'type-alias': {
                this.advice(stmt.advice, `type alias '${stmt.name}'`, stmt.line);
                const type = aliasType(this.resolve(stmt.type, scope), stmt.advice);
                this.define(scope, stmt.name, {
                    descriptor: type, callable: type.kind === 'class' ? this.constructorSignature(type) : undefined,
                }).readonly = true;
                break;
            }
            case 'struct':
                if (scope.bindings.has(stmt.name) && !scope.bindings.get(stmt.name)!.prior) this.error(`conflicting declaration '${stmt.name}'`);
                this.define(scope, stmt.name, { descriptor: descriptor('struct', stmt.name, { fields: this.fields(stmt.fields, scope) }) }).readonly = true;
                break;
            case 'class': {
                if (scope.bindings.has(stmt.name) && !scope.bindings.get(stmt.name)!.prior) this.error(`conflicting declaration '${stmt.name}'`);
                const fields = this.fields(stmt.fields, scope);
                const methods: Record<string, NonNullable<TypeDescriptor['methods']>[string]> = {};
                const type = descriptor('class', stmt.name, { fields, methods, hydratable: stmt.hydratable });
                this.define(scope, stmt.name, { descriptor: type }).readonly = true;
                for (const method of stmt.methods) {
                    if (Object.hasOwn(methods, method.name) || Object.hasOwn(fields, method.name)) this.error(`conflicting member '${method.name}'`, method.line);
                    const paramTypes = method.params.map((_, i) => method.paramTypes?.[i] && this.resolve(method.paramTypes[i]!, scope));
                    methods[method.name] = {
                        __fn: 'user', name: method.name, params: method.params, body: method.body, closure: { vars: new Map() },
                        paramTypes, returnType: method.returnType && this.resolve(method.returnType, scope),
                    };
                }
                this.find(scope, stmt.name)!.value.callable = this.constructorSignature(type);
                for (const method of stmt.methods) this.def(method, scope, false, type);
                break;
            }
            case 'return': {
                const value = stmt.value ? this.expr(stmt.value, scope, this.function?.result) : concrete(primitive('None'), false);
                if (this.function?.result) this.require(value, this.function.result, 'return');
                this.function?.returns.push(value);
                return value;
            }
            case 'block': return this.block(stmt.body, this.child(scope), expected);
            case 'if': return this.branches(stmt.branches, stmt.orelse, scope, expected);
            case 'for': {
                const iter = this.effective(this.expr(stmt.iter, scope));
                const fork = this.fork(scope), child = this.child(fork);
                const item = iter.type?.kind === 'list' ? concrete(iter.type.element!) : iter.identity?.items ? this.merge(iter.identity.items) : unknown();
                stmt.vars.forEach((name, i) => this.define(child, name, stmt.vars.length === 1 ? item : item.identity?.items?.[i] ?? unknown()));
                this.block(stmt.body, child);
                this.join(scope, [this.fork(scope), child]);
                break;
            }
            case 'while': {
                this.expr(stmt.cond, scope);
                const fork = this.fork(scope), child = this.child(fork);
                this.narrow(stmt.cond, child, true);
                this.block(stmt.body, child);
                this.join(scope, [this.fork(scope), child]);
                break;
            }
            case 'try': {
                const body = this.child(this.fork(scope)), handler = this.child(this.fork(scope));
                this.define(handler, stmt.errName, concrete(primitive('object'), false));
                const values = [this.block(stmt.body, body, expected), this.block(stmt.handler, handler, expected)];
                this.join(scope, [body, handler]);
                return this.merge(values);
            }
            case 'assert':
                this.expr(stmt.cond, scope);
                if (stmt.message) this.expr(stmt.message, scope);
                this.narrow(stmt.cond, scope, true);
                break;
            case 'success':
                if (stmt.value) this.expr(stmt.value, scope);
                break;
            case 'fail': this.expr(stmt.reason, scope); break;
            case 'constraint':
                this.expr(stmt.text, scope);
                this.block(stmt.body, this.child(scope));
                break;
            case 'restrict':
                stmt.clauses.forEach(clause => this.expr(clause.arg, scope));
                this.block(stmt.body, this.child(scope));
                break;
            case 'natural': this.invalidate(scope, undefined, true); break;
            case 'break':
            case 'continue':
            case 'pass': break;
        }
        return concrete(primitive('None'), false);
    }
}
