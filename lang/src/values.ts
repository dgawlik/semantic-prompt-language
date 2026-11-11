import type { Stmt } from './ast.js';
import { Failure } from './errors.js';
import type { TypeDescriptor } from './types.js';

export interface FloatValue {
    readonly __float: number;
}

export interface InstanceValue {
    readonly __instance: true;
    readonly descriptor: TypeDescriptor;
    readonly fields: { [key: string]: Value };
    complete: boolean;
}

export type Value = null | boolean | number | bigint | string | Value[] | { [key: string]: Value } | FunctionValue | FloatValue | TypeDescriptor | InstanceValue;

export interface Env {
    vars: Map<string, Value>;
    parent?: Env;
    contracts?: Map<string, TypeDescriptor>;
    readonlyNames?: Set<string>;
    imports?: Map<string, { env: Env; name: string }>;
}

export function bindingValue(env: Env, name: string): Value | undefined {
    const imported = env.imports?.get(name);
    return imported ? bindingValue(imported.env, imported.name) : env.vars.get(name);
}

export interface UserFunction {
    __fn: 'user';
    name: string;
    params: string[];
    body: Stmt[];
    closure: Env;
    source?: { lines: string[]; uri?: string; version?: number };
    paramTypes?: (TypeDescriptor | undefined)[];
    returnType?: TypeDescriptor;
    self?: InstanceValue;
}

export interface BuiltinFunction {
    __fn: 'builtin';
    name: string;
    call: (args: Value[]) => Value | Promise<Value>;
    signature?: TypeDescriptor;
    target?: Value;
}

export type FunctionValue = UserFunction | BuiltinFunction;

const floats = new WeakSet<object>();
const descriptors = new WeakSet<object>();
const instances = new WeakSet<object>();

export function registerFloat(value: FloatValue): FloatValue {
    floats.add(value);
    return value;
}

export function registerDescriptor(value: TypeDescriptor): TypeDescriptor {
    descriptors.add(value);
    return value;
}

export function registerInstance(value: InstanceValue): InstanceValue {
    instances.add(value);
    return value;
}

export const runtimeError = (msg: string): Failure => new Failure('runtime_error', msg);

export function assertMutable(v: Value): void {
    if (typeof v === 'object' && v !== null && Object.isFrozen(v)) {
        throw runtimeError('cannot modify a read-only value');
    }
}

export function isFunction(v: unknown): v is FunctionValue {
    if (typeof v !== 'object' || v === null || !('__fn' in v) || !('name' in v) || typeof v.name !== 'string') return false;
    if (v.__fn === 'builtin') return 'call' in v && typeof v.call === 'function';
    return v.__fn === 'user' && 'params' in v && Array.isArray(v.params) && 'body' in v && Array.isArray(v.body)
        && 'closure' in v && typeof v.closure === 'object' && v.closure !== null && 'vars' in v.closure && v.closure.vars instanceof Map;
}

export function isList(v: unknown): v is Value[] {
    return Array.isArray(v);
}

export function isDict(v: unknown): v is { [key: string]: Value } {
    return typeof v === 'object' && v !== null && !Array.isArray(v) && !isFunction(v) && !isFloat(v) && !isDescriptor(v) && !isInstance(v);
}

export function isFloat(v: unknown): v is FloatValue {
    return typeof v === 'object' && v !== null && floats.has(v);
}

export function isDescriptor(v: unknown): v is TypeDescriptor {
    return typeof v === 'object' && v !== null && descriptors.has(v);
}

export function isInstance(v: unknown): v is InstanceValue {
    return typeof v === 'object' && v !== null && instances.has(v);
}

export function typeName(v: Value): string {
    if (v === null) return 'None';
    if (typeof v === 'boolean') return 'bool';
    if (typeof v === 'number') return 'number';
    if (typeof v === 'bigint') return 'int';
    if (isFloat(v)) return 'float';
    if (isDescriptor(v)) return `type ${v.name}`;
    if (isInstance(v)) return v.descriptor.name;
    if (typeof v === 'string') return 'str';
    if (Array.isArray(v)) return 'list';
    if (isFunction(v)) return 'function';
    return 'dict';
}

export function truthy(v: Value): boolean {
    if (v === null || v === false) return false;
    if (v === true) return true;
    if (typeof v === 'number') return v !== 0;
    if (typeof v === 'bigint') return v !== 0n;
    if (isFloat(v)) return v.__float !== 0;
    if (isDescriptor(v) || isInstance(v)) return true;
    if (typeof v === 'string') return v.length > 0;
    if (Array.isArray(v)) return v.length > 0;
    if (isFunction(v)) return true;
    return Object.keys(v).length > 0;
}

export function hasKey(o: { [key: string]: Value }, k: string): boolean {
    return Object.prototype.hasOwnProperty.call(o, k);
}

/** Assigns a dict key without ever touching the prototype chain. */
export function setKey(o: { [key: string]: Value }, k: string, v: Value): void {
    Object.defineProperty(o, k, { value: v, writable: true, enumerable: true, configurable: true });
}

export function newDict(entries: Iterable<[string, Value]> = []): { [key: string]: Value } {
    const d: { [key: string]: Value } = {};
    for (const [k, v] of entries) setKey(d, k, v);
    return d;
}

function formatNumber(n: number): string {
    if (Number.isNaN(n)) return 'nan';
    if (n === Infinity) return 'inf';
    if (n === -Infinity) return '-inf';
    return String(n);
}

/** Display form used for string interpolation and str(). */
export function str(v: Value): string {
    if (v === null) return 'None';
    if (v === true) return 'True';
    if (v === false) return 'False';
    if (typeof v === 'number') return formatNumber(v);
    if (typeof v === 'bigint') return String(v);
    if (isFloat(v)) return floatToken(v.__float);
    if (isDescriptor(v)) return v.name;
    if (isInstance(v)) return `<${v.descriptor.name} instance>`;
    if (typeof v === 'string') return v;
    return encodeJson(v);
}

/** Converts to a plain JSON-compatible value (functions become descriptive strings). */
export function toJson(v: Value): unknown {
    if (v === null || typeof v === 'boolean' || typeof v === 'string') return v;
    if (typeof v === 'number') return Number.isFinite(v) ? v : formatNumber(v);
    if (typeof v === 'bigint') return String(v);
    if (isFloat(v)) return v.__float;
    if (isDescriptor(v)) return `<type ${v.name}>`;
    if (isInstance(v)) throw runtimeError('class instances must be projected with object() before JSON serialization');
    if (Array.isArray(v)) return v.map(toJson);
    if (isFunction(v)) return `<function ${v.name}>`;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) Object.defineProperty(out, k, { value: toJson(x), enumerable: true, writable: true, configurable: true });
    return out;
}

/** Cycle-safe display data without exposing function closures or runtime internals. */
export function describeValue(value: Value): unknown {
    const visiting = new Set<Value>();
    const describe = (value: Value): unknown => {
        if (isInstance(value)) {
            if (visiting.has(value)) return '<circular reference>';
            visiting.add(value);
            const result = { class: value.descriptor.name, fields: describe(value.fields) };
            visiting.delete(value);
            return result;
        }
        if (isFunction(value)) {
            if (value.__fn === 'builtin') return value.name;
            const params = value.params.map((name, index) => {
                const type = value.paramTypes?.[index];
                return type ? `${name}: ${type.name}` : name;
            });
            return `def ${value.name}(${params.join(', ')})${value.returnType ? ` -> ${value.returnType.name}` : ''}`;
        }
        if (!isList(value) && !isDict(value)) return toJson(value);
        if (visiting.has(value)) return '<circular reference>';
        visiting.add(value);
        const result = isList(value) ? value.map(describe)
            : Object.fromEntries(Object.entries(value).map(([key, child]) => [key, describe(child)]));
        visiting.delete(value);
        return result;
    };
    return describe(value);
}

/** Converts parsed JSON into a Value (JSON objects are already safe dicts). */
export function fromJson(j: unknown): Value {
    if (j === null || typeof j === 'boolean' || typeof j === 'number' || typeof j === 'string') return j;
    if (Array.isArray(j)) return j.map(fromJson);
    if (typeof j === 'object') return newDict(Object.entries(j as object).map(([k, x]) => [k, fromJson(x)]));
    throw runtimeError(`cannot convert ${typeof j} to a value`);
}

export function equals(a: Value, b: Value): boolean {
    if (a === b) return true;
    if ((typeof a === 'bigint' || isFloat(a)) && (typeof b === 'bigint' || isFloat(b))) return compareValues(a, b) === 0;
    if (isFloat(a) && isFloat(b)) return a.__float === b.__float;
    if (Array.isArray(a) && Array.isArray(b)) {
        return a.length === b.length && a.every((x, i) => equals(x, b[i]));
    }
    if (isDict(a) && isDict(b)) {
        const ka = Object.keys(a);
        return ka.length === Object.keys(b).length && ka.every((k) => hasKey(b, k) && equals(a[k], b[k]));
    }
    return false;
}

/** Ordering for numbers, strings and (lexicographically) lists. */
export function compareValues(a: Value, b: Value): number {
    if (typeof a === 'bigint' || isFloat(a) || typeof b === 'bigint' || isFloat(b)) {
        const x = isFloat(a) ? a.__float : a;
        const y = isFloat(b) ? b.__float : b;
        if ((typeof x === 'bigint' || typeof x === 'number') && (typeof y === 'bigint' || typeof y === 'number')) {
            return x < y ? -1 : x > y ? 1 : 0;
        }
    }
    if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : a > b ? 1 : 0;
    if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
    if (Array.isArray(a) && Array.isArray(b)) {
        const n = Math.min(a.length, b.length);
        for (let i = 0; i < n; i++) {
            const c = compareValues(a[i], b[i]);
            if (c !== 0) return c;
        }
        return a.length - b.length;
    }
    throw runtimeError(`cannot order ${typeName(a)} and ${typeName(b)}`);
}

export function floatToken(n: number): string {
    const token = Object.is(n, -0) ? '-0' : String(n);
    return /[.eE]/.test(token) ? token : `${token}.0`;
}

/** Typed numbers must be emitted as tokens, never rounded through JSON.stringify. */
export function encodeJson(value: Value, indent?: number): string {
    const visiting = new Set<object>();
    const gap = ' '.repeat(Math.max(0, Math.min(10, indent ?? 0)));
    const encode = (value: Value, depth: number): string => {
        if (typeof value === 'bigint') return String(value);
        if (isFloat(value)) return floatToken(value.__float);
        if (isInstance(value)) throw runtimeError('class instances must be projected with object() before JSON serialization');
        if (!isList(value) && !isDict(value)) return JSON.stringify(toJson(value));
        if (visiting.has(value)) throw runtimeError('cannot serialize a cyclic data graph');
        visiting.add(value);
        const array = isList(value);
        const entries = array ? value.map(child => encode(child, depth + 1))
            : Object.entries(value).map(([key, child]) => `${JSON.stringify(key)}:${gap ? ' ' : ''}${encode(child, depth + 1)}`);
        visiting.delete(value);
        const [open, close] = array ? ['[', ']'] : ['{', '}'];
        if (!entries.length) return open + close;
        return gap ? `${open}\n${gap.repeat(depth + 1)}${entries.join(`,\n${gap.repeat(depth + 1)}`)}\n${gap.repeat(depth)}${close}`
            : open + entries.join(',') + close;
    };
    return encode(value, 0);
}
