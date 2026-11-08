import { describe, expect, it } from 'vitest';
import { decodeJsonValue, decodeTypedJson, schemaForType } from '../src/typed-json.js';
import { INT_MAX, INT_MIN, aliasType, descriptor, primitives, project, typedFloat, validateValue } from '../src/types.js';
import { encodeJson, isInstance, newDict, registerInstance, type Value } from '../src/values.js';

const int = primitives.get('int')!;
const float = primitives.get('float')!;
const str = primitives.get('str')!;
const union = descriptor('union', 'int | float', { members: [int, float] });

describe('parsed tool JSON decoding', () => {
    it('decodes numbers by their target contract without changing the JSON input', () => {
        const input = [1, 2];
        expect(decodeJsonValue(input, descriptor('list', 'list[int]', { element: int }))).toEqual([1n, 2n]);
        expect(input).toEqual([1, 2]);
        expect(decodeJsonValue(Number.MAX_SAFE_INTEGER, int)).toBe(BigInt(Number.MAX_SAFE_INTEGER));
        expect(decodeJsonValue(1, float)).toEqual(typedFloat(1));
        expect(decodeJsonValue(1, union)).toBe(1n);
        expect(decodeJsonValue(1.5, union)).toEqual(typedFloat(1.5));
        expect(encodeJson(decodeJsonValue(-0, float))).toBe('-0.0');
        expect(decodeJsonValue(-0, union)).toEqual(typedFloat(-0));
    });

    it.each([true, '15', 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity])('rejects invalid parsed int %s', value => {
        expect(() => decodeJsonValue(value, int, 'argument.n')).toThrow(/argument.n/);
    });

    it('retains nested paths and rejects ambiguous mutable targets', () => {
        const ints = descriptor('list', 'list[int]', { element: int });
        expect(() => decodeJsonValue([Number.MAX_SAFE_INTEGER + 1], ints, 'argument.items')).toThrow(/argument.items\[0\].*unsafe/);
        const strings = descriptor('list', 'list[str]', { element: str });
        expect(() => decodeJsonValue([], descriptor('union', 'lists', { members: [ints, strings] }))).toThrow(/ambiguous/);
    });
});

describe('lossless descriptor JSON', () => {
    it('propagates alias advice through root, field and list schemas without enforcing it', () => {
        const money = aliasType(int, { minimum: 0, desc: 'Cents' });
        const price = aliasType(money, { desc: 'Unit price' });
        const record = descriptor('struct', 'Invoice', { fields: {
            total: { type: money, advice: { desc: 'Invoice total' } },
            prices: { type: descriptor('list', 'prices', { element: price }), advice: {} },
        } });
        expect(schemaForType(money)).toMatchObject({
            type: 'integer', description: expect.stringContaining('"desc":"Cents"'),
        });
        expect(schemaForType(record)).toMatchObject({ properties: {
            total: { type: 'integer', description: expect.stringContaining('"desc":"Invoice total"') },
            prices: { items: { type: 'integer', description: expect.stringContaining('"desc":"Unit price"') } },
        } });
        expect(encodeJson(schemaForType(record))).not.toContain('"minimum":');
        expect(schemaForType(int)).not.toHaveProperty('advice');
        expect(encodeJson(decodeTypedJson('{"total":-1,"prices":[-2]}', record))).toBe('{"total":-1,"prices":[-2]}');
    });

    it.each([INT_MIN, INT_MAX])('round trips signed int limit %s exactly', value => {
        expect(encodeJson(value)).toBe(String(value));
        expect(decodeTypedJson(encodeJson(value), int)).toBe(value);
        expect(decodeTypedJson(encodeJson(value), union)).toBe(value);
    });

    it('preserves integral float and exponent union interpretations', () => {
        expect(encodeJson(typedFloat(1))).toBe('1.0');
        expect(encodeJson(typedFloat(-0))).toBe('-0.0');
        expect(decodeTypedJson('1', union)).toBe(1n);
        expect(decodeTypedJson('1.0', union)).toEqual(typedFloat(1));
        expect(decodeTypedJson('1e0', union)).toEqual(typedFloat(1));
        expect(decodeTypedJson('1.0', int)).toBe(1n);
        expect(decodeTypedJson('1', float)).toEqual(typedFloat(1));
    });

    it.each(['9223372036854775808', '-9223372036854775809', '1.1', '1e10000'])('rejects invalid int %s', token => {
        expect(() => decodeTypedJson(token, int)).toThrow();
    });

    it.each(['NaN', 'Infinity', '1e9999', '+1', '01', '1.', '[1,]', '\u00a01'])('rejects nonfinite or malformed JSON %s', token => {
        expect(() => decodeTypedJson(token, float)).toThrow();
    });

    it('decodes nested exact records and treats metadata as advice', () => {
        const record = descriptor('struct', 'Data', { fields: {
            title: { type: str, advice: { min: 2, max: 5, desc: 'Title', arbitrary: [1, true] } },
            count: { type: int, advice: {} },
            optional: { type: descriptor('union', 'str | None', { members: [str, primitives.get('None')!] }), advice: {} },
        } });
        const decoded = decodeTypedJson('{"title":"x","count":9223372036854775807,"optional":null}', record);
        expect(encodeJson(decoded)).toBe('{"title":"x","count":9223372036854775807,"optional":null}');
        expect(() => decodeTypedJson('{"title":"x","count":1}', record)).toThrow(/required/);
        expect(() => decodeTypedJson('{"title":"x","count":1,"optional":null,"extra":0}', record)).toThrow(/extra/);
        const schema = encodeJson(schemaForType(record));
        expect(schema).toContain('Model advice');
        expect(schema).not.toContain('minLength');
        expect(schema).not.toContain('"maximum"');
    });

    it('rejects distinct mutable/nominal interpretations, collapsing equivalent structs', () => {
        const ints = descriptor('list', 'list[int]', { element: int });
        const strings = descriptor('list', 'list[str]', { element: str });
        expect(() => decodeTypedJson('[]', descriptor('union', 'lists', { members: [ints, strings] }))).toThrow(/ambiguous/);
        const fields = { x: { type: str, advice: {} } };
        const a = descriptor('class', 'A', { fields, hydratable: true, methods: {} });
        const b = descriptor('class', 'B', { fields, hydratable: true, methods: {} });
        expect(() => decodeTypedJson('{"x":"x"}', descriptor('union', 'classes', { members: [a, b] }))).toThrow(/ambiguous/);
        const sa = descriptor('struct', 'SA', { fields });
        const sb = descriptor('struct', 'SB', { fields });
        expect(decodeTypedJson('{"x":"x"}', descriptor('union', 'structs', { members: [sa, sb] }))).toEqual({ x: 'x' });
    });

    it('hydrates only opt-in classes and rejects callable schemas', () => {
        const fields = { count: { type: int, advice: {} } };
        const ordinary = descriptor('class', 'Ordinary', { fields, methods: {} });
        expect(() => schemaForType(ordinary)).toThrow(/constructor-only/);
        const hydratable = descriptor('class', 'Hydrated', { fields, methods: {}, hydratable: true });
        const value = decodeTypedJson('{"count":1}', hydratable);
        expect(isInstance(value)).toBe(true);
        expect(project(value)).toEqual({ count: 1n });
        const callable = descriptor('fn', 'fn() -> str', { params: [], result: str });
        expect(() => schemaForType(descriptor('struct', 'Handler', { fields: { callback: { type: callable, advice: {} } } }))).toThrow(/callable/);
    });

    it('preserves explicit format restrictions', () => {
        expect(() => decodeTypedJson('"text"', str, 'object')).toThrow(/fmt/);
        expect(() => decodeTypedJson('[]', descriptor('list', 'list[int]', { element: int }), 'integer')).toThrow(/fmt/);
    });
});

describe('deep projection and serialization', () => {
    const fn: Value = { __fn: 'builtin', name: 'f', call: () => null };

    it('drops function properties, copies children, but rejects root/array functions', () => {
        const child: Value[] = [1n];
        const source = newDict([['child', child], ['fn', fn]]);
        const projected = project(source);
        expect(projected).toEqual({ child: [1n] });
        expect(projected).not.toBe(source);
        expect((projected as Record<string, Value>).child).not.toBe(child);
        expect(() => project(fn)).toThrow(/function/);
        expect(() => project([fn])).toThrow(/function/);
        expect(encodeJson(source)).toContain('<function f>');
    });

    it('requires explicit instance projection and rejects cycles', () => {
        const type = descriptor('class', 'C', { fields: { x: { type: int, advice: {} } }, methods: {} });
        const instance = registerInstance({ __instance: true, descriptor: type, fields: newDict([['x', 1n]]), complete: true });
        expect(() => encodeJson(instance)).toThrow(/projected/);
        expect(encodeJson(project(instance))).toBe('{"x":1}');
        const cyclic: Value[] = [];
        cyclic.push(cyclic);
        expect(() => project(cyclic)).toThrow(/cyclic/);
        expect(() => encodeJson(cyclic)).toThrow(/cyclic/);
    });

    it('does not drop required callable fields during class-to-struct projection', () => {
        const fieldType = descriptor('fn', 'fn() -> str', { params: [], result: str });
        const shape = descriptor('struct', 'WithFn', { fields: { callback: { type: fieldType, advice: {} } } });
        expect(() => validateValue(project(newDict([['callback', fn]])), shape)).toThrow(/required/);
        expect(() => project(newDict([['callback', fn]]), false)).toThrow(/function/);
    });
});
