import type { Stmt } from './ast.js';
import { Failure } from './errors.js';

export type Value = null | boolean | number | string | Value[] | { [key: string]: Value } | FunctionValue;

export interface Env {
    vars: Map<string, Value>;
    parent?: Env;
}

export interface UserFunction {
    __fn: 'user';
    name: string;
    params: string[];
    body: Stmt[];
    closure: Env;
}

export interface BuiltinFunction {
    __fn: 'builtin';
    name: string;
    call: (args: Value[]) => Value | Promise<Value>;
}

export type FunctionValue = UserFunction | BuiltinFunction;

export const runtimeError = (msg: string): Failure => new Failure('runtime_error', msg);

export function isFunction(v: unknown): v is FunctionValue {
    return typeof v === 'object' && v !== null && '__fn' in v && ((v as { __fn: unknown }).__fn === 'user' || (v as { __fn: unknown }).__fn === 'builtin');
}

export function isList(v: unknown): v is Value[] {
    return Array.isArray(v);
}

export function isDict(v: unknown): v is { [key: string]: Value } {
    return typeof v === 'object' && v !== null && !Array.isArray(v) && !isFunction(v);
}

export function typeName(v: Value): string {
    if (v === null) return 'None';
    if (typeof v === 'boolean') return 'bool';
    if (typeof v === 'number') return 'number';
    if (typeof v === 'string') return 'str';
    if (Array.isArray(v)) return 'list';
    if (isFunction(v)) return 'function';
    return 'dict';
}

export function truthy(v: Value): boolean {
    if (v === null || v === false) return false;
    if (v === true) return true;
    if (typeof v === 'number') return v !== 0;
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
    if (typeof v === 'string') return v;
    return JSON.stringify(toJson(v));
}

/** Converts to a plain JSON-compatible value (functions become descriptive strings). */
export function toJson(v: Value): unknown {
    if (v === null || typeof v === 'boolean' || typeof v === 'string') return v;
    if (typeof v === 'number') return Number.isFinite(v) ? v : formatNumber(v);
    if (Array.isArray(v)) return v.map(toJson);
    if (isFunction(v)) return `<function ${v.name}>`;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) Object.defineProperty(out, k, { value: toJson(x), enumerable: true, writable: true, configurable: true });
    return out;
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
