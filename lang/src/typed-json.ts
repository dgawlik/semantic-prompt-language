import { Failure } from './errors.js';
import { checkedInt, descriptor, equivalent, typedFloat, validateValue, type TypeDescriptor } from './types.js';
import { isDict, isInstance, isList, newDict, registerInstance, runtimeError, type Value } from './values.js';

class NumberToken {
    constructor(readonly text: string, readonly parsed = false) {}
}
type Wire = null | boolean | string | NumberToken | Wire[] | { [key: string]: Wire };

function parseWire(text: string): Wire {
    let position = 0;
    const skip = () => { while (/[ \t\r\n]/.test(text[position] ?? '') && position < text.length) position++; };
    const fail = (): never => { throw new Failure('invalid_format', `LLM response is not valid JSON at offset ${position}`); };
    const string = (): string => {
        const start = position++;
        while (position < text.length) {
            const character = text[position++];
            if (character === '\\') position++;
            else if (character === '"') {
                try { return JSON.parse(text.slice(start, position)) as string; }
                catch (error) { if (error instanceof SyntaxError) return fail(); throw error; }
            }
        }
        return fail();
    };
    const value = (): Wire => {
        skip();
        const character = text[position];
        if (character === '"') return string();
        if (character === '[') {
            position++; skip();
            const result: Wire[] = [];
            if (text[position] === ']') { position++; return result; }
            for (;;) {
                result.push(value()); skip();
                if (text[position] === ']') { position++; return result; }
                if (text[position++] !== ',') return fail();
            }
        }
        if (character === '{') {
            position++; skip();
            const result: { [key: string]: Wire } = {};
            if (text[position] === '}') { position++; return result; }
            for (;;) {
                skip();
                if (text[position] !== '"') return fail();
                const key = string(); skip();
                if (text[position++] !== ':') return fail();
                Object.defineProperty(result, key, { value: value(), enumerable: true, configurable: true, writable: true });
                skip();
                if (text[position] === '}') { position++; return result; }
                if (text[position++] !== ',') return fail();
            }
        }
        for (const [word, result] of [['true', true], ['false', false], ['null', null]] as const) {
            if (text.startsWith(word, position)) { position += word.length; return result; }
        }
        const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(position));
        if (!number) return fail();
        position += number[0].length;
        return new NumberToken(number[0]);
    };
    const result = value(); skip();
    if (position !== text.length) fail();
    return result;
}

export function schemaForType(type: TypeDescriptor): Value {
    const schema = (type: TypeDescriptor): Value => {
        const result = shape(type);
        if (!isDict(result)) throw runtimeError('invalid type schema');
        addAdvice(result, type.advice);
        return result;
    };
    const addAdvice = (schema: Record<string, Value>, advice?: Readonly<Record<string, unknown>>): void => {
        if (!advice || !Object.keys(advice).length) return;
        const text = `Model advice (not validation constraints): ${JSON.stringify(advice)}`;
        schema.description = schema.description ? `${schema.description}\n${text}` : text;
    };
    const shape = (type: TypeDescriptor): Value => {
        switch (type.kind) {
            case 'int': return newDict([['type', 'integer'], ['description', 'A signed 64-bit integer in -9223372036854775808..9223372036854775807.']]);
            case 'float': return newDict([['type', 'number'], ['description', 'A finite binary64 float; use a decimal point or exponent.']]);
            case 'str': return newDict([['type', 'string']]);
            case 'char': return newDict([['type', 'string'], ['minLength', 1], ['maxLength', 1], ['description', 'Exactly one Unicode scalar value, not a surrogate.']]);
            case 'bool': return newDict([['type', 'boolean']]);
            case 'None': return newDict([['type', 'null']]);
            case 'enum': return newDict([['type', 'string'], ['enum', [...type.values!]]]);
            case 'object': return newDict([['type', 'object']]);
            case 'list': return newDict([['type', 'array'], ['items', schema(type.element!)]]);
            case 'union': return newDict([['anyOf', type.members!.map(schema)]]);
            case 'class':
                if (!type.hydratable) throw runtimeError(`class ${type.name} is constructor-only; use schema=struct(${type.name}) or opt in with hydratable class`);
                return record(type);
            case 'struct': return record(type);
            case 'fn': throw runtimeError(`schema target ${type.name} contains a required callable and cannot be decoded from JSON`);
        }
    };
    const record = (type: TypeDescriptor): Value => {
        const properties = newDict();
        for (const [name, field] of Object.entries(type.fields!)) {
            const property = schema(field.type);
            if (!isDict(property)) throw runtimeError('invalid field schema');
            addAdvice(property, field.advice);
            Object.defineProperty(properties, name, { value: property, enumerable: true, configurable: true, writable: true });
        }
        return newDict([['type', 'object'], ['properties', properties], ['required', Object.keys(type.fields!)], ['additionalProperties', false]]);
    };
    return schema(type);
}

function wireObject(value: Wire): value is { [key: string]: Wire } {
    return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof NumberToken);
}

function dynamic(value: Wire, path: string): Value {
    if (value instanceof NumberToken) {
        const number = Number(value.text);
        if (!Number.isFinite(number)) throw new Failure('validation_failed', `${path}: nonfinite JSON number`);
        return number;
    }
    if (Array.isArray(value)) return value.map((child, index) => dynamic(child, `${path}[${index}]`));
    if (wireObject(value)) return newDict(Object.entries(value).map(([key, child]) => [key, dynamic(child, `${path}.${key}`)]));
    return value;
}

function interpretation(type: TypeDescriptor): TypeDescriptor | undefined {
    if (type.kind === 'int' || type.kind === 'float' || type.kind === 'class' || type.kind === 'struct' || type.kind === 'list') return type;
    return undefined;
}

function decode(value: Wire, type: TypeDescriptor, path: string): Value {
    const fail = (detail = `value does not satisfy ${type.name}`): never => { throw new Failure('validation_failed', `${path}: ${detail}`); };
    if (type.kind === 'union') {
        let members = [...type.members!];
        if (value instanceof NumberToken && members.some(member => member.kind === 'int') && members.some(member => member.kind === 'float')) {
            const selected = /[.eE]/.test(value.text) ? 'float' : 'int';
            members = members.filter(member => member.kind !== (selected === 'int' ? 'float' : 'int'));
        }
        const matches: { value: Value; type: TypeDescriptor }[] = [];
        for (const member of members) {
            try { matches.push({ value: decode(value, member, path), type: member }); }
            catch (error) {
                if (!(error instanceof Failure) || !['validation_failed', 'type_error', 'runtime_error'].includes(error.statusCode)) throw error;
            }
        }
        if (!matches.length) return fail();
        const first = interpretation(matches[0].type);
        if (matches.some(match => {
            const other = interpretation(match.type);
            return first ? !other || !equivalent(first, other) : other !== undefined;
        })) return fail(`ambiguous distinct decoding targets in ${type.name}`);
        return matches[0].value;
    }
    if (type.kind === 'int' || type.kind === 'float') {
        if (!(value instanceof NumberToken)) return fail();
        if (type.kind === 'int' && value.parsed && Number.isInteger(Number(value.text)) && !Number.isSafeInteger(Number(value.text))) {
            return fail('cannot decode an unsafe parsed JSON integer exactly');
        }
        try {
            if (type.kind === 'float') return typedFloat(Number(value.text));
            // Decimal/exponent wire tokens can request int only when mathematically integral.
            const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(value.text)!;
            const exponent = Number(match[4] ?? 0) - (match[3]?.length ?? 0);
            let digits = BigInt(match[2] + (match[3] ?? ''));
            if (digits !== 0n) {
                if (exponent > 19) return fail('int overflow: outside signed 64-bit range');
                if (exponent < -value.text.length) return fail('fractional int token');
                if (exponent >= 0) digits *= 10n ** BigInt(exponent);
                else {
                    const divisor = 10n ** BigInt(-exponent);
                    if (digits % divisor !== 0n) return fail('fractional int token');
                    digits /= divisor;
                }
            }
            return checkedInt(match[1] ? -digits : digits);
        } catch (error) {
            if (error instanceof Failure) return fail(error.reason);
            throw error;
        }
    }
    if (type.kind === 'list') {
        if (!Array.isArray(value)) return fail();
        return value.map((child, index) => decode(child, type.element!, `${path}[${index}]`));
    }
    if (type.kind === 'struct' || type.kind === 'class') {
        if (!wireObject(value)) return fail();
        for (const key of Object.keys(value)) if (!Object.hasOwn(type.fields!, key)) return fail(`extra field '${key}'`);
        const fields = newDict();
        for (const [key, field] of Object.entries(type.fields!)) {
            if (!Object.hasOwn(value, key)) return fail(`missing required field '${key}'`);
            Object.defineProperty(fields, key, { value: decode(value[key], field.type, `${path}.${key}`), enumerable: true, configurable: true, writable: true });
        }
        if (type.kind === 'struct') return fields;
        if (!type.hydratable) return fail(`${type.name} is not hydratable`);
        validateValue(fields, descriptor('struct', `fields(${type.name})`, { fields: type.fields }), path);
        return registerInstance({ __instance: true, descriptor: type, fields, complete: true });
    }
    const result = dynamic(value, path);
    // Only private, freshly parsed values are checked here; no result is published yet.
    try { return validateValue(result, type, path); }
    catch (error) { if (error instanceof Failure) return fail(error.reason); throw error; }
}

export function decodeTypedJson(text: string, type: TypeDescriptor, format: 'json' | 'integer' | 'float' | 'array' | 'object' | 'boolean' = 'json'): Value {
    schemaForType(type);
    const wire = parseWire(text);
    if (format !== 'json') {
        const matches = format === 'integer' ? wire instanceof NumberToken && Number.isInteger(Number(wire.text))
            : format === 'float' ? wire instanceof NumberToken
            : format === 'array' ? Array.isArray(wire)
            : format === 'object' ? wireObject(wire) : typeof wire === 'boolean';
        if (!matches) throw new Failure('invalid_format', `LLM response must satisfy fmt='${format}'`);
    }
    return finishDecode(decode(wire, type, '$'), type, '$');
}

export function decodeJsonValue(value: Value, type: TypeDescriptor, path = '$'): Value {
    schemaForType(type);
    const wire = (value: Value, path: string): Wire => {
        if (typeof value === 'number') {
            if (!Number.isFinite(value)) throw new Failure('validation_failed', `${path}: nonfinite JSON number`);
            return new NumberToken(Object.is(value, -0) ? '-0.0' : String(value), true);
        }
        if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
        if (isList(value)) return value.map((child, index) => wire(child, `${path}[${index}]`));
        if (isDict(value)) return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, wire(child, `${path}.${key}`)]));
        throw new Failure('validation_failed', `${path}: expected JSON data`);
    };
    return finishDecode(decode(wire(value, path), type, path), type, path);
}

function finishDecode(value: Value, type: TypeDescriptor, path: string): Value {
    const install = (value: Value, type: TypeDescriptor): void => {
        if (isInstance(value)) {
            validateValue(value.fields, descriptor('struct', `fields(${type.name})`, { fields: value.descriptor.fields }));
            for (const [key, field] of Object.entries(value.descriptor.fields!)) install(value.fields[key], field.type);
        } else if (isList(value) && type.kind === 'list') value.forEach(child => install(child, type.element!));
        else if (isDict(value) && type.kind === 'struct') for (const [key, field] of Object.entries(type.fields!)) install(value[key], field.type);
    };
    validateValue(value, type, path);
    install(value, type);
    return value;
}
