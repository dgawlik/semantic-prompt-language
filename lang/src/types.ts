import { Failure } from './errors.js';
import { compileSchema } from './schema.js';

export type Annotations = Readonly<Record<string, unknown>>;
export type JsonSchema = boolean | { [key: string]: unknown };
export type TypeKind =
    | 'str' | 'int' | 'float' | 'bool' | 'char' | 'null' | 'any' | 'object'
    | 'list' | 'union' | 'enum' | 'struct' | 'class' | 'fn' | 'schema';

/** The JavaScript value a type parses to: `Infer<typeof Invoice>`. */
export type Infer<T> = T extends Type<infer V> ? V : never;
export type Shape = Record<string, Type<any>>;
export type InferShape<F extends Shape> = { [K in keyof F]: Infer<F[K]> };
type Simplify<T> = { [K in keyof T]: T[K] } & {};
type Hydrator = { fromJSON?: (data: Record<string, unknown>) => object; prototype: object };

interface Definition {
    readonly kind: TypeKind;
    readonly name: string;
    readonly annotations: Annotations;
    readonly element?: Type<any>;
    readonly members?: readonly Type<any>[];
    readonly values?: readonly string[];
    readonly fields?: Readonly<Record<string, Type<any>>>;
    readonly prototype?: object;
    readonly hydrate?: (data: Record<string, unknown>) => object;
    readonly json?: JsonSchema;
    readonly check?: (value: unknown) => void;
}

// Shared across duplicate copies of the package, so types from a helper module still match.
const BRAND = Symbol.for('spl-lang.type');
const invalid = (path: string, detail: string): Failure => new Failure('validation_failed', `${path}: ${detail}`);
const plain = (value: unknown): value is Record<string, unknown> => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
};
const set = (target: object, key: string, value: unknown): void => {
    Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
};
const member = (path: string, key: string): string =>
    /^[A-Za-z_$][\w$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;

function describe(value: unknown): string {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'an array';
    if (typeof value === 'object') return 'an object';
    if (typeof value === 'string') return JSON.stringify(value.length > 40 ? `${value.slice(0, 40)}...` : value);
    return typeof value === 'number' || typeof value === 'boolean' ? String(value) : typeof value;
}

/**
 * A runtime description of data: it validates values, turns JSON into JavaScript objects
 * and renders the JSON Schema a model sees. Types are immutable; every modifier returns a copy.
 */
export class Type<T = unknown> {
    /** Type-level only: the parsed value. */
    declare readonly _output: T;

    /** @internal */
    constructor(/** @internal */ readonly definition: Definition) {
        Object.defineProperty(this, BRAND, { value: true });
        Object.freeze(this);
    }

    get kind(): TypeKind { return this.definition.kind; }
    get name(): string { return this.definition.name; }
    /** Free-form metadata for the model; never used for validation. */
    get annotations(): Annotations { return this.definition.annotations; }

    protected copy(changes: Partial<Definition>): this {
        const Constructor = this.constructor as new (definition: Definition) => this;
        return new Constructor({ ...this.definition, ...changes });
    }

    /** Adds arbitrary annotations the model reads next to this type or field. */
    annotate(annotations: Record<string, unknown>): this {
        return this.copy({ annotations: Object.freeze({ ...this.definition.annotations, ...annotations }) });
    }

    /** Shorthand for `annotate({ description })`. */
    describe(description: string): this {
        return this.annotate({ description });
    }

    /** Names this type, optionally with annotations: a reusable, transparent alias. */
    as(name: string, annotations: Record<string, unknown> = {}): this {
        if (typeof name !== 'string' || !name.trim()) throw new Failure('runtime_error', 'a type name must be a non-empty string');
        return this.copy({ name, annotations: Object.freeze({ ...this.definition.annotations, ...annotations }) });
    }

    nullable(): Type<T | null> {
        return union(this, nil);
    }

    list(): Type<T[]> {
        return list(this);
    }

    or<U>(other: Type<U>): Type<T | U> {
        return union(this, other);
    }

    /** Validates a value and returns the parsed JavaScript object; never coerces or fills defaults. */
    parse(value: unknown, path = '$'): T {
        return decode(this, value, path, true) as T;
    }

    /** Parses strict JSON text, then validates it. */
    parseJson(text: string): T {
        let value: unknown;
        try {
            value = JSON.parse(text);
        } catch (error) {
            if (!(error instanceof SyntaxError)) throw error;
            throw new Failure('invalid_format', `not valid JSON: ${error.message}`);
        }
        return this.parse(value);
    }

    /** True when the value already satisfies this type; classes require an instance. */
    is(value: unknown): value is T {
        try {
            decode(this, value, '$', false);
            return true;
        } catch (error) {
            if (error instanceof Failure) return false;
            throw error;
        }
    }

    /** JSON Schema for this type, including annotations as model advice. */
    schema(): { [key: string]: unknown } {
        return schemaOf(this);
    }

    toString(): string { return this.definition.name; }
    toJSON(): string { return `<type ${this.definition.name}>`; }
}

export function isType(value: unknown): value is Type<unknown> {
    return typeof value === 'object' && value !== null && (value as Record<symbol, unknown>)[BRAND] === true;
}

/** An exact record. Add fields fluently or pass them all at once. */
export class StructType<S extends Record<string, unknown>, T = S> extends Type<T> {
    get fields(): Readonly<Record<string, Type<any>>> { return this.definition.fields!; }

    /** Adds one field; annotations are read by the model. */
    field<K extends string, V>(name: K, type: Type<V>, annotations?: Record<string, unknown>): StructType<Simplify<S & Record<K, V>>> {
        if (this.definition.kind === 'class') throw new Failure('runtime_error', `add fields to ${this.name} before attaching methods or a class`);
        requireType(type, `field '${name}' of ${this.name}`);
        if (Object.hasOwn(this.definition.fields!, name)) throw new Failure('runtime_error', `duplicate field '${name}' in ${this.name}`);
        const fields: Record<string, Type<any>> = { ...this.definition.fields };
        set(fields, name, annotations ? type.annotate(annotations) : type);
        return this.copy({ fields: Object.freeze(fields) }) as unknown as StructType<Simplify<S & Record<K, V>>>;
    }

    /** Parsed objects get these methods; `this` is the parsed data. */
    methods<M extends Record<string, any>>(methods: M & ThisType<S & M>): StructType<S, S & M> {
        for (const name of Object.keys(methods)) {
            if (Object.hasOwn(this.definition.fields!, name)) throw new Failure('runtime_error', `method '${name}' collides with a field of ${this.name}`);
        }
        const prototype = Object.create(this.definition.prototype ?? Object.prototype, Object.getOwnPropertyDescriptors(methods));
        return this.copy({ kind: 'class', prototype, hydrate: undefined }) as unknown as StructType<S, S & M>;
    }

    /** Parsed objects become instances of an existing class. A static `fromJSON(data)` is used when present. */
    class<C extends abstract new (...args: any[]) => object>(constructor: C): StructType<S, InstanceType<C>> {
        if (typeof constructor !== 'function' || typeof constructor.prototype !== 'object') {
            throw new Failure('runtime_error', `${this.name}.class() requires a class`);
        }
        const hydrator = constructor as unknown as Hydrator;
        return this.copy({
            kind: 'class', prototype: hydrator.prototype,
            hydrate: typeof hydrator.fromJSON === 'function' ? data => hydrator.fromJSON!(data) : undefined,
        }) as unknown as StructType<S, InstanceType<C>>;
    }

    /** The plain-data view of a class type: same fields, no methods or prototype. */
    get data(): StructType<S> {
        return this.copy({ kind: 'struct', prototype: undefined, hydrate: undefined }) as unknown as StructType<S>;
    }
}

function requireType(value: unknown, where: string): asserts value is Type<any> {
    if (!isType(value)) throw new Failure('runtime_error', `${where} must be a type such as str, list(int) or a struct`);
}

const primitive = <T>(kind: TypeKind, name: string = kind): Type<T> =>
    new Type<T>({ kind, name, annotations: Object.freeze({}) });

export const str = primitive<string>('str');
export const int = primitive<number>('int');
export const float = primitive<number>('float');
export const bool = primitive<boolean>('bool');
/** Exactly one Unicode character. */
export const char = primitive<string>('char');
export const nil = primitive<null>('null');
/** Any JSON value. */
export const any = primitive<unknown>('any');
/** Any JSON object, without a declared shape. */
export const object = primitive<Record<string, unknown>>('object');
/** A callable; cannot be decoded from JSON. */
export const fn = primitive<(...args: any[]) => unknown>('fn');

export function list<V>(element: Type<V>): Type<V[]> {
    requireType(element, 'list() element');
    return new Type<V[]>({ kind: 'list', name: `list(${element.name})`, annotations: Object.freeze({}), element });
}

export function union<M extends Type<any>[]>(...members: M): Type<Infer<M[number]>> {
    if (!members.length) throw new Failure('runtime_error', 'union() requires at least one type');
    const flat: Type<any>[] = [];
    for (const item of members) {
        requireType(item, 'union() member');
        if (!flat.includes(item)) flat.push(item);
    }
    if (flat.length === 1) return flat[0];
    return new Type({ kind: 'union', name: flat.map(item => item.name).join(' | '), annotations: Object.freeze({}), members: Object.freeze(flat) });
}

export function nullable<V>(type: Type<V>): Type<V | null> {
    return union(type, nil);
}

/** One of the given strings. */
export function enumOf<const V extends readonly string[]>(values: V): Type<V[number]>;
export function enumOf<const V extends readonly string[]>(...values: V): Type<V[number]>;
export function enumOf(...values: readonly unknown[]): Type<string> {
    const items: readonly unknown[] = values.length === 1 && Array.isArray(values[0]) ? values[0] : values;
    if (!items.length || items.some(item => typeof item !== 'string')) throw new Failure('runtime_error', 'enumOf() requires one or more strings');
    return new Type({
        kind: 'enum', name: items.map(item => JSON.stringify(item)).join(' | '),
        annotations: Object.freeze({}), values: Object.freeze([...new Set(items as string[])]),
    });
}

/** An exact record: every field is required and extra fields are rejected. */
export function struct<F extends Shape = {}>(name: string, fields?: F): StructType<Simplify<InferShape<F>>> {
    if (typeof name !== 'string' || !name.trim()) throw new Failure('runtime_error', 'struct() requires a name');
    const checked: Record<string, Type<any>> = {};
    for (const [key, type] of Object.entries(fields ?? {})) {
        requireType(type, `field '${key}' of ${name}`);
        set(checked, key, type);
    }
    return new StructType({ kind: 'struct', name, annotations: Object.freeze({}), fields: Object.freeze(checked) });
}

/** Names a type and attaches annotations: `typedef('Money', int, { desc: 'Amount in cents' })`. */
export function typedef<T extends Type<any>>(name: string, type: T, annotations: Record<string, unknown> = {}): T {
    requireType(type, `typedef('${name}')`);
    return type.as(name, annotations);
}

/** Wraps raw JSON Schema as a type; unlike annotations, its constraints are enforced. */
export function jsonSchema<T = unknown>(schema: JsonSchema, name = 'schema'): Type<T> {
    return new Type<T>({ kind: 'schema', name, annotations: Object.freeze({}), json: schema, check: compileSchema(schema) });
}

function decode(type: Type<any>, value: unknown, path: string, hydrate: boolean): unknown {
    const definition = type.definition;
    const fail = (detail = `expected ${definition.name}, got ${describe(value)}`): never => { throw invalid(path, detail); };
    switch (definition.kind) {
        case 'str': return typeof value === 'string' ? value : fail();
        case 'int': return typeof value === 'number' && Number.isSafeInteger(value) ? value : fail();
        case 'float': return typeof value === 'number' && Number.isFinite(value) ? value : fail();
        case 'bool': return typeof value === 'boolean' ? value : fail();
        case 'char': return typeof value === 'string' && Array.from(value).length === 1 && !/^[\uD800-\uDFFF]$/.test(value) ? value : fail();
        case 'null': return value === null ? value : fail();
        case 'fn': return typeof value === 'function' ? value : fail();
        case 'object': return plain(value) ? value : fail();
        case 'any': return value === undefined || typeof value === 'function' || typeof value === 'symbol' ? fail() : value;
        case 'enum': return typeof value === 'string' && definition.values!.includes(value) ? value : fail();
        case 'schema':
            try {
                definition.check!(value);
            } catch (error) {
                if (!(error instanceof Failure)) throw error;
                // Schema errors carry paths relative to this value; anchor them at its place in the whole.
                throw new Failure('validation_failed', error.reason.split('; ').map(item => {
                    const [, at, detail] = /^([^:]*): (.*)$/s.exec(item) ?? [];
                    return detail === undefined ? `${path}: ${item}` : `${at === '$' ? path : `${path}${at.startsWith('[') ? '' : '.'}${at}`}: ${detail}`;
                }).join('; '));
            }
            return value;
        case 'list':
            if (!Array.isArray(value)) return fail();
            return value.map((item, index) => decode(definition.element!, item, `${path}[${index}]`, hydrate));
        case 'union': {
            const matches: { type: Type<any>; value: unknown }[] = [];
            let first: Failure | undefined;
            for (const candidate of definition.members!) {
                try {
                    matches.push({ type: candidate, value: decode(candidate, value, path, hydrate) });
                } catch (error) {
                    if (!(error instanceof Failure)) throw error;
                    first ??= error;
                }
            }
            if (!matches.length) {
                // For `T | null`, the error for T says more than "expected T | null".
                const members = definition.members!.filter(item => item.kind !== 'null');
                if (first && members.length === 1 && value !== null) throw first;
                return fail();
            }
            const classes = matches.filter(match => match.type.kind === 'class');
            if (hydrate && classes.length > 1 && !classes.some(match => match.value === value)) {
                return fail(`ambiguous: matches ${classes.map(match => match.type.name).join(' and ')}`);
            }
            return (classes[0] ?? matches[0]).value;
        }
        case 'struct':
        case 'class': {
            const fields = definition.fields!;
            const instance = definition.kind === 'class' && typeof value === 'object' && value !== null
                && definition.prototype!.isPrototypeOf(value);
            if (!instance && (!plain(value) || definition.kind === 'class' && !hydrate)) return fail();
            const source = value as Record<string, unknown>;
            if (!instance) {
                for (const key of Object.keys(source)) {
                    if (!Object.hasOwn(fields, key)) fail(`unexpected field '${key}' in ${definition.name}`);
                }
            }
            const data: Record<string, unknown> = {};
            for (const [key, field] of Object.entries(fields)) {
                if (!Object.hasOwn(source, key)) fail(`missing required field '${key}' of ${definition.name}`);
                set(data, key, decode(field, source[key], member(path, key), hydrate));
            }
            if (instance) return value;
            if (definition.kind === 'struct') return data;
            if (definition.hydrate) {
                const created = definition.hydrate(data);
                if (typeof created !== 'object' || created === null || !definition.prototype!.isPrototypeOf(created)) {
                    return fail(`${definition.name}.fromJSON() must return an instance of the class`);
                }
                return created;
            }
            return Object.defineProperties(Object.create(definition.prototype!), Object.getOwnPropertyDescriptors(data));
        }
    }
}

function advise(schema: { [key: string]: unknown }, annotations: Annotations): void {
    const rest: Record<string, unknown> = { ...annotations };
    const parts: string[] = [];
    if (typeof schema.description === 'string') parts.push(schema.description);
    for (const key of ['description', 'desc']) {
        const text = rest[key];
        if (typeof text !== 'string' || !text.trim()) continue;
        parts.push(text);
        delete rest[key];
    }
    if (Object.keys(rest).length) parts.push(`Model advice (not validation constraints): ${JSON.stringify(rest)}`);
    if (parts.length) schema.description = parts.join('\n');
}

function schemaOf(type: Type<any>, seen: Type<any>[] = []): { [key: string]: unknown } {
    const definition = type.definition;
    const shape = (): { [key: string]: unknown } => {
        switch (definition.kind) {
            case 'str': return { type: 'string' };
            case 'int': return { type: 'integer' };
            case 'float': return { type: 'number' };
            case 'bool': return { type: 'boolean' };
            case 'char': return { type: 'string', minLength: 1, maxLength: 1, description: 'Exactly one Unicode character.' };
            case 'null': return { type: 'null' };
            case 'any': return {};
            case 'object': return { type: 'object' };
            case 'enum': return { type: 'string', enum: [...definition.values!] };
            case 'schema': return definition.json === true ? {} : definition.json === false ? { not: {} } : structuredClone(definition.json as { [key: string]: unknown });
            case 'list': return { type: 'array', items: schemaOf(definition.element!, seen) };
            case 'union': return { anyOf: definition.members!.map(item => schemaOf(item, seen)) };
            case 'fn': throw new Failure('runtime_error', `${definition.name} is a callable and cannot be described as JSON`);
            case 'struct':
            case 'class': {
                if (seen.includes(type)) throw new Failure('runtime_error', `recursive type ${definition.name} cannot be described as JSON Schema`);
                const properties: { [key: string]: unknown } = {};
                for (const [key, field] of Object.entries(definition.fields!)) set(properties, key, schemaOf(field, [...seen, type]));
                return { type: 'object', properties, required: Object.keys(definition.fields!), additionalProperties: false };
            }
        }
    };
    const schema = shape();
    advise(schema, definition.annotations);
    return schema;
}

/** `validate(value, Invoice)` parses with a type; raw JSON Schema only checks and returns the value. */
export function validate<T>(value: unknown, type: Type<T>): T;
export function validate(value: unknown, schema: JsonSchema): unknown;
export function validate(value: unknown, target: Type<unknown> | JsonSchema): unknown {
    if (isType(target)) return target.parse(value);
    compileSchema(target)(value);
    return value;
}

/** The builders under one name, for code that prefers `t.str` and `t.list(t.int)`. */
export const t = Object.freeze({
    str, int, float, bool, char, null: nil, nil, any, object, fn,
    list, union, nullable, enum: enumOf, enumOf, struct, typedef, schema: jsonSchema, jsonSchema, validate,
});
