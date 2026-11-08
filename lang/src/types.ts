import type { FieldDecl, TypeExpr } from './ast.js';
import { Failure } from './errors.js';
import { types as nodeTypes } from 'node:util';
import {
    hasKey, isDescriptor, isDict, isFloat, isFunction, isInstance, isList, newDict, registerDescriptor, registerFloat, runtimeError,
    typeName, type FloatValue, type FunctionValue, type InstanceValue, type UserFunction, type Value,
} from './values.js';

export type TypeKind = 'int' | 'float' | 'str' | 'char' | 'bool' | 'None' | 'object' | 'list' | 'union' | 'enum' | 'struct' | 'class' | 'fn';
export interface FieldContract {
    readonly type: TypeDescriptor;
    readonly advice: Readonly<Record<string, unknown>>;
}
export interface TypeDescriptor {
    readonly __type: true;
    readonly kind: TypeKind;
    readonly name: string;
    readonly aliasOf?: TypeDescriptor;
    readonly advice?: Readonly<Record<string, unknown>>;
    readonly element?: TypeDescriptor;
    readonly members?: readonly TypeDescriptor[];
    readonly values?: readonly string[];
    readonly fields?: Readonly<Record<string, FieldContract>>;
    readonly params?: readonly TypeDescriptor[];
    readonly result?: TypeDescriptor;
    readonly hydratable?: boolean;
    readonly methods?: Readonly<Record<string, UserFunction>>;
}

export const INT_MIN = -(1n << 63n);
export const INT_MAX = (1n << 63n) - 1n;
export const primitives = new Map<string, TypeDescriptor>(
    ['int', 'float', 'str', 'char', 'bool', 'None', 'object'].map(name =>
        [name, descriptor(name as TypeKind, name)]),
);

export function descriptor(kind: TypeKind, name: string, details: Omit<Partial<TypeDescriptor>, '__type' | 'kind' | 'name'> = {}): TypeDescriptor {
    return registerDescriptor(Object.freeze({ __type: true, kind, name, ...details }));
}

export function aliasType(type: TypeDescriptor, advice: Record<string, unknown>): TypeDescriptor {
    if (!Object.keys(advice).length) return type;
    const { __type, kind, name, ...details } = type;
    return descriptor(kind, name, {
        ...details, aliasOf: type.aliasOf ?? type, advice: Object.freeze({ ...type.advice, ...advice }),
    });
}

export function resolveType(expr: TypeExpr, lookup: (name: string) => Value): TypeDescriptor {
    switch (expr.t) {
        case 'type-name': {
            const value = lookup(expr.name);
            if (!isDescriptor(value)) throw runtimeError(`'${expr.name}' is not a type descriptor`);
            return value;
        }
        case 'type-list': {
            const element = resolveType(expr.element, lookup);
            return descriptor('list', `list[${element.name}]`, { element });
        }
        case 'type-union': {
            const members = expr.members.map(member => resolveType(member, lookup)).flatMap(type => type.kind === 'union' ? [...type.members!] : [type]);
            const unique = members.filter((type, i) => !members.slice(0, i).some(other => equivalent(type, other)));
            return unique.length === 1 ? unique[0] : descriptor('union', unique.map(type => type.name).join(' | '), { members: Object.freeze(unique) });
        }
        case 'type-fn': {
            const params = expr.params.map(param => resolveType(param, lookup));
            const result = resolveType(expr.result, lookup);
            return descriptor('fn', `fn(${params.map(param => param.name).join(', ')}) -> ${result.name}`, { params: Object.freeze(params), result });
        }
    }
}

export function resolveFields(fields: FieldDecl[], lookup: (name: string) => Value): Readonly<Record<string, FieldContract>> {
    return Object.freeze(Object.fromEntries(fields.map(field => [field.name, Object.freeze({
        type: resolveType(field.type, lookup), advice: Object.freeze({ ...field.advice }),
    })])));
}

export function equivalent(a: TypeDescriptor, b: TypeDescriptor): boolean {
    a = a.aliasOf ?? a;
    b = b.aliasOf ?? b;
    if (a === b) return true;
    if (a.kind !== b.kind || a.kind === 'class') return false;
    switch (a.kind) {
        case 'list': return equivalent(a.element!, b.element!);
        case 'union': return a.members!.length === b.members!.length && a.members!.every(x => b.members!.some(y => equivalent(x, y)));
        case 'enum': return a.values!.length === b.values!.length && a.values!.every(x => b.values!.includes(x));
        case 'struct': {
            const keys = Object.keys(a.fields!);
            return keys.length === Object.keys(b.fields!).length && keys.every(key => Object.hasOwn(b.fields!, key) && equivalent(a.fields![key].type, b.fields![key].type));
        }
        case 'fn': return a.params!.length === b.params!.length && a.params!.every((param, i) => equivalent(param, b.params![i])) && equivalent(a.result!, b.result!);
        default: return true;
    }
}

export function assignable(source: TypeDescriptor, target: TypeDescriptor): boolean {
    if (equivalent(source, target)) return true;
    if (source.kind === 'union') return source.members!.every(member => assignable(member, target));
    if (target.kind === 'union') return target.members!.some(member => assignable(source, member));
    if ((source.kind === 'char' || source.kind === 'enum') && target.kind === 'str') return true;
    if (source.kind === 'struct' && target.kind === 'object') return true;
    if (source.kind === 'fn' && target.kind === 'fn') {
        return source.params!.length === target.params!.length
            && target.params!.every((param, i) => assignable(param, source.params![i]))
            && assignable(source.result!, target.result!);
    }
    return false;
}

export function checkedInt(value: bigint): bigint {
    if (value < INT_MIN || value > INT_MAX) throw runtimeError('int overflow: value is outside signed 64-bit range');
    return value;
}

export function typedFloat(value: number): FloatValue {
    if (!Number.isFinite(value)) throw runtimeError('float must be finite');
    return registerFloat(Object.freeze({ __float: value }));
}

export function convertInt(value: Value): bigint {
    if (typeof value === 'bigint') return checkedInt(value);
    if (isFloat(value)) value = value.__float;
    if (typeof value === 'number') {
        if (!Number.isFinite(value) || !Number.isInteger(value)) throw runtimeError('int() requires an exact finite integer');
        return checkedInt(BigInt(value));
    }
    if (typeof value === 'string' && /^[+-]?\d+$/.test(value)) return checkedInt(BigInt(value));
    throw runtimeError(`int() cannot exactly convert ${typeName(value)}`);
}

export function convertFloat(value: Value): FloatValue {
    if (isFloat(value)) return value;
    if (typeof value === 'bigint') return typedFloat(Number(value));
    if (typeof value === 'number') return typedFloat(value);
    if (typeof value === 'string' && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) return typedFloat(Number(value));
    throw runtimeError(`float() cannot convert ${typeName(value)}`);
}

type ContractPlan = Map<object, TypeDescriptor>;
const contracts = new WeakMap<object, TypeDescriptor>();

export function contractOf(value: Value): TypeDescriptor | undefined {
    return typeof value === 'object' && value !== null ? contracts.get(value) : undefined;
}

export function signatureOf(fn: Value): TypeDescriptor | undefined {
    if (isDescriptor(fn) && fn.kind === 'class') {
        const constructor = fn.methods?.[fn.name];
        if (!constructor) return Object.keys(fn.fields!).length ? undefined : descriptor('fn', fn.name, { params: [], result: fn });
        if (!constructor.paramTypes || constructor.paramTypes.some(type => !type)) return undefined;
        return descriptor('fn', fn.name, { params: constructor.paramTypes.filter((type): type is TypeDescriptor => type !== undefined), result: fn });
    }
    if (!isFunction(fn)) return undefined;
    if (fn.__fn === 'builtin') return fn.signature;
    if (!fn.returnType || !fn.paramTypes || fn.paramTypes.some(type => !type)) return undefined;
    const params = fn.paramTypes.filter((type): type is TypeDescriptor => type !== undefined);
    return descriptor('fn', fn.name, { params, result: fn.returnType });
}

function typeFailure(path: string, type: TypeDescriptor, value: Value, detail?: string): never {
    throw new Failure('type_error', `${path}: expected ${type.name}, got ${typeName(value)}${detail ? ` (${detail})` : ''}`);
}

function addContract(value: object, type: TypeDescriptor, plan: ContractPlan, path: string): void {
    const existing = plan.get(value) ?? contracts.get(value);
    if (existing && !equivalent(existing, type)) throw new Failure('type_error', `${path}: incompatible established contract ${existing.name} and ${type.name}`);
    plan.set(value, existing ?? type);
}

function check(value: Value, type: TypeDescriptor, path: string, plan: ContractPlan, test: boolean, visiting = new Set<object>()): void {
    switch (type.kind) {
        case 'int': if (typeof value === 'bigint' && value >= INT_MIN && value <= INT_MAX) return; break;
        case 'float': if (isFloat(value) && Number.isFinite(value.__float)) return; break;
        case 'str': if (typeof value === 'string') return; break;
        case 'char': if (typeof value === 'string' && Array.from(value).length === 1 && !/[\uD800-\uDFFF]/u.test(value)) return; break;
        case 'bool': if (typeof value === 'boolean') return; break;
        case 'None': if (value === null) return; break;
        case 'enum': if (typeof value === 'string' && type.values!.includes(value)) return; break;
        case 'object': if (isDict(value)) return; break;
        case 'class':
            if (isInstance(value) && value.complete && equivalent(value.descriptor, type)) return;
            break;
        case 'fn': {
            const callableDescriptor = isDescriptor(value) && ['class', 'int', 'float', 'str', 'bool', 'char', 'object', 'struct'].includes(value.kind);
            if (!isFunction(value) && !callableDescriptor) break;
            const signature = signatureOf(value);
            if (signature && !assignable(signature, type)) break;
            if (test && !signature) break;
            const arity = isFunction(value) && value.__fn === 'user' ? value.params.length : signature?.params?.length;
            if (arity !== undefined && arity !== type.params!.length) break;
            if (!signature) addContract(value, type, plan, path);
            return;
        }
        case 'list':
        case 'struct': {
            if (type.kind === 'list' ? !isList(value) : !isDict(value)) break;
            const container = value as Value[] | Record<string, Value>;
            addContract(container, type, plan, path);
            if (visiting.has(container)) throw new Failure('type_error', `${path}: cyclic typed data is not supported`);
            visiting.add(container);
            if (type.kind === 'list') {
                (container as Value[]).forEach((child, i) => check(child, type.element!, `${path}[${i}]`, plan, test, visiting));
            } else {
                const record = container as Record<string, Value>;
                for (const key of Object.keys(record)) if (!Object.hasOwn(type.fields!, key)) typeFailure(`${path}.${key}`, type, record[key], 'extra field');
                for (const [key, field] of Object.entries(type.fields!)) {
                    if (!hasKey(record, key)) throw new Failure('type_error', `${path}.${key}: missing required field`);
                    check(record[key], field.type, `${path}.${key}`, plan, test, visiting);
                }
            }
            visiting.delete(container);
            return;
        }
        case 'union': {
            const matches: ContractPlan[] = [];
            for (const member of type.members!) {
                const candidate = new Map(plan);
                try { check(value, member, path, candidate, test, new Set(visiting)); matches.push(candidate); }
                catch (error) { if (!(error instanceof Failure) || error.statusCode !== 'type_error') throw error; }
            }
            if (!matches.length) break;
            const first = matches[0];
            if (matches.some(match => match.size !== first.size || [...first].some(([object, contract]) => !match.has(object) || !equivalent(contract, match.get(object)!)))) {
                throw new Failure('type_error', `${path}: ambiguous union contracts for ${type.name}`);
            }
            for (const [object, contract] of first) plan.set(object, contract);
            return;
        }
    }
    typeFailure(path, type, value);
}

export function validateValue(value: Value, type: TypeDescriptor, path = '$'): Value {
    const plan: ContractPlan = new Map();
    check(value, type, path, plan, false);
    for (const [object, contract] of plan) contracts.set(object, contract);
    if (type.kind === 'fn' && (isFunction(value) || isDescriptor(value))) {
        if (isFunction(value) && value.__fn === 'builtin' && value.target && value.signature && equivalent(value.signature, type)) return value;
        return { __fn: 'builtin', name: value.name, signature: type, target: value, call: () => { throw runtimeError('guarded callable requires interpreter dispatch'); } };
    }
    return value;
}

export function contractRead(container: Value[] | Record<string, Value>, key: string | number): Value {
    const contract = contracts.get(container);
    const type = contract?.kind === 'list' ? contract.element : contract?.fields?.[key]?.type;
    const value = isList(container) ? container[Number(key)] : container[String(key)];
    return type?.kind === 'fn' ? validateValue(value, type, `$[${JSON.stringify(key)}]`) : value;
}

export function testValue(value: Value, type: TypeDescriptor): boolean {
    const plan: ContractPlan = new Map();
    try { check(value, type, '$', plan, true); }
    catch (error) { if (error instanceof Failure && error.statusCode === 'type_error') return false; throw error; }
    for (const [object, contract] of plan) contracts.set(object, contract);
    return true;
}

/** Validate the final state and all child contracts before publishing any write. */
export function mutateContract(value: Value[] | Record<string, Value>, operation: (draft: Value[] | Record<string, Value>) => Value): Value {
    const type = contracts.get(value);
    if (!type) return operation(value);
    const draft = isList(value) ? [...value] : newDict(Object.entries(value));
    const result = operation(draft);
    const plan: ContractPlan = new Map();
    check(draft, type, '$', plan, false);
    plan.delete(draft);
    if (isList(value) && isList(draft)) value.splice(0, value.length, ...draft);
    else {
        const record = value as Record<string, Value>;
        for (const key of Object.keys(record)) delete record[key];
        for (const [key, child] of Object.entries(draft)) Object.defineProperty(record, key, { value: child, writable: true, enumerable: true, configurable: true });
    }
    for (const [object, contract] of plan) contracts.set(object, contract);
    return result;
}

export function assertComplete(value: Value, visiting = new Set<object>()): void {
    if (typeof value === 'object' && value !== null && nodeTypes.isProxy(value)) return;
    if (isInstance(value)) {
        if (!value.complete) throw runtimeError('an incomplete instance cannot escape its constructor');
        return;
    }
    if (!isList(value) && !isDict(value)) return;
    if (visiting.has(value)) return;
    visiting.add(value);
    for (const property of Object.values(Object.getOwnPropertyDescriptors(value))) {
        if ('value' in property) assertComplete(property.value, visiting);
    }
}

export function project(value: Value, dropFunctionProperties = true): Value {
    const visiting = new Set<object>();
    const snapshot = (value: Value, property = false): Value | undefined => {
        if (isFunction(value)) {
            if (property && dropFunctionProperties) return undefined;
            throw runtimeError('object() cannot project a function at the root or in an array');
        }
        if (isDescriptor(value)) throw runtimeError('object() cannot project a type descriptor');
        if (isInstance(value)) assertComplete(value);
        if (!isInstance(value) && !isDict(value) && !isList(value)) return value;
        if (visiting.has(value)) throw runtimeError('object() cannot project a cyclic data graph');
        visiting.add(value);
        let result: Value;
        if (isList(value)) result = value.map(child => snapshot(child)!);
        else {
            const fields = isInstance(value) ? value.fields : value;
            result = newDict();
            for (const [key, child] of Object.entries(fields)) {
                const projected = snapshot(child, true);
                if (projected !== undefined) Object.defineProperty(result, key, { value: projected, writable: true, enumerable: true, configurable: true });
            }
        }
        visiting.delete(value);
        return result;
    };
    return snapshot(value)!;
}
