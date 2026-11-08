import {
    assertMutable,
    compareValues,
    encodeJson,
    equals,
    fromJson,
    hasKey,
    isDict,
    isFloat,
    isList,
    newDict,
    runtimeError,
    setKey,
    str,
    toJson,
    truthy,
    typeName,
    type BuiltinFunction,
    type Value,
} from './values.js';
import { checkedInt, contractOf, contractRead, convertFloat, convertInt, mutateContract, typedFloat, validateValue } from './types.js';

export interface BuiltinContext {
    log: (values: Value[]) => void;
}

function arity(name: string, args: Value[], min: number, max = min): void {
    if (args.length < min || args.length > max) {
        const expected = min === max ? `${min}` : `${min}-${max}`;
        throw runtimeError(`${name}() takes ${expected} argument(s) but ${args.length} were given`);
    }
}

function needNumber(name: string, v: Value): number {
    if (typeof v === 'bigint' && v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(v);
    if (isFloat(v)) return v.__float;
    if (typeof v !== 'number') throw runtimeError(`${name}() expects a number, got ${typeName(v)}`);
    return v;
}

function needInt(name: string, v: Value): number {
    const n = needNumber(name, v);
    if (!Number.isInteger(n)) throw runtimeError(`${name}() expects an integer, got ${n}`);
    return n;
}

function needString(name: string, v: Value): string {
    if (typeof v !== 'string') throw runtimeError(`${name}() expects a string, got ${typeName(v)}`);
    return v;
}

function needList(name: string, v: Value): Value[] {
    if (!isList(v)) throw runtimeError(`${name}() expects a list, got ${typeName(v)}`);
    return v;
}

/** Values that can be iterated by `for`, `list()`, `sorted()` etc. */
export function iterate(v: Value): Value[] {
    if (isList(v)) return contractOf(v)?.element?.kind === 'fn' ? v.map((_, i) => contractRead(v, i)) : v;
    if (typeof v === 'string') return Array.from(v);
    if (isDict(v)) return Object.keys(v);
    throw runtimeError(`${typeName(v)} is not iterable`);
}

export function makeBuiltins(ctx: BuiltinContext): Map<string, BuiltinFunction> {
    const fns = new Map<string, BuiltinFunction>();
    const def = (name: string, call: (args: Value[]) => Value) => fns.set(name, { __fn: 'builtin', name, call });

    def('len', (a) => {
        arity('len', a, 1);
        const v = a[0];
        if (typeof v === 'string') return Array.from(v).length;
        if (isList(v)) return v.length;
        if (isDict(v)) return Object.keys(v).length;
        throw runtimeError(`len() does not support ${typeName(v)}`);
    });
    def('str', (a) => {
        arity('str', a, 1);
        return str(a[0]);
    });
    def('int', (a) => {
        arity('int', a, 1);
        return convertInt(a[0]);
    });
    def('float', (a) => {
        arity('float', a, 1);
        return convertFloat(a[0]);
    });
    def('bool', (a) => {
        arity('bool', a, 1);
        return truthy(a[0]);
    });
    def('type', (a) => {
        arity('type', a, 1);
        return typeName(a[0]);
    });
    def('list', (a) => {
        arity('list', a, 1);
        return [...iterate(a[0])];
    });
    def('range', (a) => {
        arity('range', a, 1, 3);
        const nums = a.map((x) => needInt('range', x));
        const [start, stop, step] = nums.length === 1 ? [0, nums[0], 1] : [nums[0], nums[1], nums[2] ?? 1];
        if (step === 0) throw runtimeError('range() step must not be zero');
        const out: Value[] = [];
        for (let i = start; step > 0 ? i < stop : i > stop; i += step) {
            out.push(i);
            if (out.length > 10_000_000) throw runtimeError('range() is too large');
        }
        return out;
    });
    def('abs', (a) => {
        arity('abs', a, 1);
        if (typeof a[0] === 'bigint') return checkedInt(a[0] < 0n ? -a[0] : a[0]);
        if (isFloat(a[0])) return typedFloat(Math.abs(a[0].__float));
        return Math.abs(needNumber('abs', a[0]));
    });
    def('round', (a) => {
        arity('round', a, 1, 2);
        if (typeof a[0] === 'bigint') {
            const digits = a.length === 1 ? 0 : needInt('round', a[1]);
            if (digits >= 0) return a[0];
            if (digits < -19) return 0n;
            const factor = 10n ** BigInt(-digits);
            const magnitude = a[0] < 0n ? -a[0] : a[0];
            let quotient = magnitude / factor;
            const remainder = magnitude % factor;
            if (remainder * 2n > factor || remainder * 2n === factor && quotient % 2n !== 0n) quotient++;
            return checkedInt((a[0] < 0n ? -quotient : quotient) * factor);
        }
        const n = needNumber('round', a[0]);
        if (a.length === 1) {
            const r = Math.round(Math.abs(n));
            const even = Math.abs(n) % 1 === 0.5 && r % 2 === 1 ? r - 1 : r;
            const result = n < 0 ? -even : even;
            return isFloat(a[0]) ? typedFloat(result) : typeof a[0] === 'bigint' ? a[0] : result;
        }
        const f = 10 ** needInt('round', a[1]);
        const result = Math.round(n * f) / f;
        return isFloat(a[0]) ? typedFloat(result) : typeof a[0] === 'bigint' ? checkedInt(BigInt(result)) : result;
    });
    const extremum = (name: string, pick: (c: number) => boolean) =>
        def(name, (a) => {
            const items = a.length === 1 ? iterate(a[0]) : a;
            if (items.length === 0) throw runtimeError(`${name}() of an empty sequence`);
            return items.reduce((best, x) => (pick(compareValues(x, best)) ? x : best));
        });
    extremum('min', (c) => c < 0);
    extremum('max', (c) => c > 0);
    def('sum', (a) => {
        arity('sum', a, 1);
        const items = iterate(a[0]);
        if (!items.length) {
            const element = contractOf(a[0])?.element;
            return element?.kind === 'int' ? 0n : element?.kind === 'float' ? typedFloat(0) : 0;
        }
        if (typeof items[0] === 'bigint') {
            return items.reduce<bigint>((sum, value) => {
                if (typeof value !== 'bigint') throw runtimeError('sum() mixed numeric types require explicit conversion');
                return checkedInt(sum + value);
            }, 0n);
        }
        if (isFloat(items[0])) {
            const total = items.reduce<number>((sum, value) => {
                if (!isFloat(value)) throw runtimeError('sum() mixed numeric types require explicit conversion');
                const next = sum + value.__float;
                if (!Number.isFinite(next)) throw runtimeError('sum() float must be finite');
                return next;
            }, 0);
            return typedFloat(total);
        }
        return items.reduce<number>((sum, value) => {
            if (typeof value !== 'number') throw runtimeError(`sum() expects legacy numbers, got ${typeName(value)}; use explicit conversion`);
            return sum + value;
        }, 0);
    });
    def('sorted', (a) => {
        arity('sorted', a, 1, 2);
        const out = [...iterate(a[0])].sort(compareValues);
        return a[1] !== undefined && truthy(a[1]) ? out.reverse() : out;
    });
    def('reversed', (a) => {
        arity('reversed', a, 1);
        return [...iterate(a[0])].reverse();
    });
    def('enumerate', (a) => {
        arity('enumerate', a, 1);
        return iterate(a[0]).map((x, i) => [i, x]);
    });
    def('zip', (a) => {
        if (a.length === 0) return [];
        const lists = a.map(iterate);
        const n = Math.min(...lists.map((l) => l.length));
        return Array.from({ length: n }, (_, i) => lists.map((l) => l[i]));
    });
    def('any', (a) => {
        arity('any', a, 1);
        return iterate(a[0]).some(truthy);
    });
    def('all', (a) => {
        arity('all', a, 1);
        return iterate(a[0]).every(truthy);
    });
    def('keys', (a) => {
        arity('keys', a, 1);
        if (!isDict(a[0])) throw runtimeError(`keys() expects a dict, got ${typeName(a[0])}`);
        return Object.keys(a[0]);
    });
    def('values', (a) => {
        arity('values', a, 1);
        if (!isDict(a[0])) throw runtimeError(`values() expects a dict, got ${typeName(a[0])}`);
        return Object.keys(a[0]).map(key => contractRead(a[0] as Record<string, Value>, key));
    });
    def('items', (a) => {
        arity('items', a, 1);
        if (!isDict(a[0])) throw runtimeError(`items() expects a dict, got ${typeName(a[0])}`);
        return Object.keys(a[0]).map(key => [key, contractRead(a[0] as Record<string, Value>, key)]);
    });
    def('json_parse', (a) => {
        arity('json_parse', a, 1);
        try {
            return fromJson(JSON.parse(needString('json_parse', a[0])));
        } catch (e) {
            if (e instanceof SyntaxError) throw runtimeError(`json_parse(): ${e.message}`);
            throw e;
        }
    });
    def('json_stringify', (a) => {
        arity('json_stringify', a, 1, 2);
        const indent = a[1] === undefined ? undefined : needInt('json_stringify', a[1]);
        return encodeJson(a[0], indent);
    });
    def('log', (a) => {
        ctx.log(a);
        return null;
    });
    return fns;
}

// ---- methods ----------------------------------------------------------

type Method = (self: any, args: Value[]) => Value;

const stringMethods: Record<string, Method> = {
    upper: (s) => s.toUpperCase(),
    lower: (s) => s.toLowerCase(),
    strip: (s) => s.trim(),
    lstrip: (s) => s.trimStart(),
    rstrip: (s) => s.trimEnd(),
    title: (s: string) => s.toLowerCase().replace(/(^|\s)\S/g, (m) => m.toUpperCase()),
    capitalize: (s: string) => (s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : s),
    isdigit: (s: string) => /^\d+$/.test(s),
    split: (s: string, a) => {
        arity('split', a, 0, 1);
        if (a.length === 0 || a[0] === null) return s.trim() === '' ? [] : s.trim().split(/\s+/);
        const sep = needString('split', a[0]);
        if (sep === '') throw runtimeError('split() separator must not be empty');
        return s.split(sep);
    },
    splitlines: (s: string) => (s === '' ? [] : s.split(/\r?\n/)),
    join: (s: string, a) => {
        arity('join', a, 1);
        return iterate(a[0]).map((x) => {
            if (typeof x !== 'string') throw runtimeError(`join() expects strings, got ${typeName(x)}`);
            return x;
        }).join(s);
    },
    replace: (s: string, a) => {
        arity('replace', a, 2);
        return s.split(needString('replace', a[0])).join(needString('replace', a[1]));
    },
    startswith: (s: string, a) => {
        arity('startswith', a, 1);
        return s.startsWith(needString('startswith', a[0]));
    },
    endswith: (s: string, a) => {
        arity('endswith', a, 1);
        return s.endsWith(needString('endswith', a[0]));
    },
    find: (s: string, a) => {
        arity('find', a, 1);
        return s.indexOf(needString('find', a[0]));
    },
    count: (s: string, a) => {
        arity('count', a, 1);
        const sub = needString('count', a[0]);
        return sub === '' ? s.length + 1 : s.split(sub).length - 1;
    },
};

const listMethods: Record<string, Method> = {
    append: (l: Value[], a) => {
        arity('append', a, 1);
        l.push(a[0]);
        return null;
    },
    extend: (l: Value[], a) => {
        arity('extend', a, 1);
        l.push(...iterate(a[0]));
        return null;
    },
    insert: (l: Value[], a) => {
        arity('insert', a, 2);
        l.splice(needInt('insert', a[0]), 0, a[1]);
        return null;
    },
    pop: (l: Value[], a) => {
        arity('pop', a, 0, 1);
        if (l.length === 0) throw runtimeError('pop() from an empty list');
        const i = a.length ? needInt('pop', a[0]) : -1;
        const idx = i < 0 ? l.length + i : i;
        if (idx < 0 || idx >= l.length) throw runtimeError('pop() index out of range');
        return l.splice(idx, 1)[0];
    },
    remove: (l: Value[], a) => {
        arity('remove', a, 1);
        const i = l.findIndex((x) => equals(x, a[0]));
        if (i < 0) throw runtimeError('remove(): value not in list');
        l.splice(i, 1);
        return null;
    },
    index: (l: Value[], a) => {
        arity('index', a, 1);
        return l.findIndex((x) => equals(x, a[0]));
    },
    count: (l: Value[], a) => {
        arity('count', a, 1);
        return l.filter((x) => equals(x, a[0])).length;
    },
    reverse: (l: Value[]) => {
        l.reverse();
        return null;
    },
    sort: (l: Value[], a) => {
        arity('sort', a, 0, 1);
        l.sort(compareValues);
        if (a.length && truthy(a[0])) l.reverse();
        return null;
    },
    copy: (l: Value[]) => [...iterate(l)],
    clear: (l: Value[]) => {
        l.length = 0;
        return null;
    },
};

const dictMethods: Record<string, Method> = {
    keys: (d) => Object.keys(d),
    values: (d: Record<string, Value>) => Object.keys(d).map(key => contractRead(d, key)),
    items: (d: Record<string, Value>) => Object.keys(d).map(key => [key, contractRead(d, key)]),
    get: (d, a) => {
        arity('get', a, 1, 2);
        const k = needString('get', a[0]);
        return hasKey(d, k) ? contractRead(d, k) : (a[1] ?? null);
    },
    pop: (d, a) => {
        arity('pop', a, 1, 2);
        const k = needString('pop', a[0]);
        if (!hasKey(d, k)) {
            if (a.length === 2) return a[1];
            throw runtimeError(`key '${k}' not found`);
        }
        const v = d[k];
        delete d[k];
        return v;
    },
    update: (d, a) => {
        arity('update', a, 1);
        if (!isDict(a[0])) throw runtimeError(`update() expects a dict, got ${typeName(a[0])}`);
        for (const [k, v] of Object.entries(a[0])) setKey(d, k, v);
        return null;
    },
    copy: (d: Record<string, Value>) => newDict(Object.keys(d).map(key => [key, contractRead(d, key)])),
    clear: (d) => {
        for (const k of Object.keys(d)) delete d[k];
        return null;
    },
};

const MUTATING_LIST_METHODS = new Set(['append', 'extend', 'insert', 'pop', 'remove', 'reverse', 'sort', 'clear']);
const MUTATING_DICT_METHODS = new Set(['pop', 'update', 'clear']);

export function isMutatingMethod(self: Value, name: string): boolean {
    return isList(self) ? MUTATING_LIST_METHODS.has(name) : isDict(self) && MUTATING_DICT_METHODS.has(name);
}

export function callMethod(self: Value, name: string, args: Value[]): Value {
    const table = typeof self === 'string' ? stringMethods : isList(self) ? listMethods : isDict(self) ? dictMethods : undefined;
    if (!table || !Object.prototype.hasOwnProperty.call(table, name)) {
        throw runtimeError(`${typeName(self)} has no method '${name}'`);
    }
    if (isMutatingMethod(self, name)) {
        assertMutable(self);
        if (isList(self) || isDict(self)) {
            const result = mutateContract(self, draft => table[name](draft, args));
            const element = contractOf(self)?.element;
            return name === 'pop' && element?.kind === 'fn' ? validateValue(result, element) : result;
        }
    }
    return table[name](self, args);
}

export function hasBuiltinMethod(self: Value, name: string): boolean {
    const table = typeof self === 'string' ? stringMethods : isList(self) ? listMethods : isDict(self) ? dictMethods : undefined;
    return table !== undefined && Object.hasOwn(table, name);
}
