import { describe, expect, expectTypeOf, it } from 'vitest';
import { Failure } from '../src/errors.js';
import {
    any, bool, char, enumOf, float, fn, int, isType, jsonSchema, list, nil, nullable, object, str, struct, t, typedef, union, validate,
    type Infer,
} from '../src/types.js';

const reason = (action: () => unknown): string => {
    try {
        action();
    } catch (error) {
        if (error instanceof Failure) return `${error.statusCode}: ${error.reason}`;
        throw error;
    }
    throw new Error('expected a failure');
};

describe('primitive types', () => {
    it('validates without coercion', () => {
        expect(str.parse('a')).toBe('a');
        expect(int.parse(3)).toBe(3);
        expect(float.parse(1.5)).toBe(1.5);
        expect(float.parse(2)).toBe(2);
        expect(bool.parse(false)).toBe(false);
        expect(char.parse('é')).toBe('é');
        expect(char.parse('😀')).toBe('😀');
        expect(nil.parse(null)).toBeNull();
        expect(any.parse({ a: [1] })).toEqual({ a: [1] });
        expect(object.parse({ a: 1 })).toEqual({ a: 1 });
        expect(reason(() => int.parse('3'))).toBe('validation_failed: $: expected int, got "3"');
        expect(reason(() => int.parse(1.5))).toMatch(/expected int, got 1.5/);
        expect(reason(() => int.parse(2 ** 60))).toMatch(/expected int/);
        expect(reason(() => float.parse(Infinity))).toMatch(/expected float/);
        expect(reason(() => str.parse(1))).toMatch(/expected str, got 1/);
        expect(reason(() => bool.parse(0))).toMatch(/expected bool/);
        expect(reason(() => char.parse('ab'))).toMatch(/expected char/);
        expect(reason(() => nil.parse(undefined))).toMatch(/expected null/);
        expect(reason(() => object.parse([]))).toMatch(/expected object, got an array/);
        expect(reason(() => any.parse(undefined))).toMatch(/expected any/);
    });

    it('tests values without throwing', () => {
        expect(int.is(1)).toBe(true);
        expect(int.is('1')).toBe(false);
        expect(union(int, str).is('x')).toBe(true);
        expect(list(int).is([1, 'x'])).toBe(false);
    });
});

describe('composite types', () => {
    const Color = enumOf('red', 'green', 'blue');
    const Money = typedef('Money', int, { minimum: 0, desc: 'Amount in cents' });
    const Address = struct('Address', { city: str, postalCode: nullable(str) });
    const Order = struct('Order', {
        id: str.annotate({ pattern: '^A-\\d+$' }),
        color: Color,
        total: Money,
        address: Address,
        tags: list(str),
    });

    it('parses exact structs into plain objects with field paths in errors', () => {
        const input = { id: 'A-1', color: 'red', total: 10, address: { city: 'London', postalCode: null }, tags: ['x'] };
        const order = Order.parse(input);
        expect(order).toEqual(input);
        expect(order).not.toBe(input);
        expect(Object.getPrototypeOf(order)).toBe(Object.prototype);
        expect(reason(() => Order.parse({ ...input, extra: 1 }))).toBe("validation_failed: $: unexpected field 'extra' in Order");
        expect(reason(() => Order.parse({ ...input, tags: undefined }))).toMatch(/\$\.tags: expected list\(str\)/);
        const { tags: _tags, ...partial } = input;
        expect(reason(() => Order.parse(partial))).toBe("validation_failed: $: missing required field 'tags' of Order");
        expect(reason(() => Order.parse({ ...input, address: { city: 'X', postalCode: 5 } }))).toBe('validation_failed: $.address.postalCode: expected str, got 5');
        expect(reason(() => Order.parse({ ...input, color: 'pink' }))).toBe('validation_failed: $.color: expected "red" | "green" | "blue", got "pink"');
        expect(reason(() => Order.parse({ ...input, tags: ['a', 2] }))).toBe('validation_failed: $.tags[1]: expected str, got 2');
        expect(reason(() => Order.parse([]))).toMatch(/expected Order, got an array/);
        expect(reason(() => Order.parse(new Map()))).toMatch(/expected Order/);
    });

    it('does not enforce annotations: they are advice for the model', () => {
        expect(Money.parse(-5)).toBe(-5);
        expect(Order.fields.id.parse('not matching')).toBe('not matching');
    });

    it('renders JSON Schema with annotations as model advice', () => {
        expect(Order.schema()).toEqual({
            type: 'object',
            properties: {
                id: { type: 'string', description: 'Model advice (not validation constraints): {"pattern":"^A-\\\\d+$"}' },
                color: { type: 'string', enum: ['red', 'green', 'blue'] },
                total: { type: 'integer', description: 'Amount in cents\nModel advice (not validation constraints): {"minimum":0}' },
                address: {
                    type: 'object',
                    properties: { city: { type: 'string' }, postalCode: { anyOf: [{ type: 'string' }, { type: 'null' }] } },
                    required: ['city', 'postalCode'], additionalProperties: false,
                },
                tags: { type: 'array', items: { type: 'string' } },
            },
            required: ['id', 'color', 'total', 'address', 'tags'],
            additionalProperties: false,
        });
        expect(str.describe('A title').schema()).toEqual({ type: 'string', description: 'A title' });
        expect(char.annotate({ desc: 'Initial' }).schema().description).toBe('Exactly one Unicode character.\nInitial');
        expect(any.schema()).toEqual({});
        expect(reason(() => struct('Handler', { callback: fn }).schema())).toMatch(/runtime_error: fn is a callable/);
    });

    it('keeps types immutable: modifiers return copies', () => {
        const titled = str.describe('Title');
        expect(str.annotations).toEqual({});
        expect(titled.annotations).toEqual({ description: 'Title' });
        expect(titled.annotate({ maxLength: 10 }).annotations).toEqual({ description: 'Title', maxLength: 10 });
        expect(Object.isFrozen(titled)).toBe(true);
        expect(Money.name).toBe('Money');
        expect(int.name).toBe('int');
        expect(String(Money)).toBe('Money');
        expect(JSON.stringify({ Money })).toBe('{"Money":"<type Money>"}');
        expect(isType(Money)).toBe(true);
        expect(isType({ kind: 'int' })).toBe(false);
    });

    it('builds structs fluently, field by field', () => {
        const Point = struct('Point').field('x', float, { desc: 'Horizontal' }).field('y', float);
        expect(Point.parse({ x: 1, y: 2 })).toEqual({ x: 1, y: 2 });
        expect(Point.schema().properties).toEqual({ x: { type: 'number', description: 'Horizontal' }, y: { type: 'number' } });
        expect(reason(() => Point.field('x', int))).toMatch(/duplicate field 'x'/);
        expect(reason(() => struct('Bad', { a: 'str' as never }))).toMatch(/field 'a' of Bad must be a type/);
        expect(reason(() => struct(''))).toMatch(/requires a name/);
    });

    it('decodes unions member by member and reports nullable errors precisely', () => {
        const Id = union(int, str);
        expect(Id.parse(1)).toBe(1);
        expect(Id.parse('a')).toBe('a');
        expect(reason(() => Id.parse(true))).toBe('validation_failed: $: expected int | str, got true');
        expect(reason(() => nullable(Address).parse({ city: 1, postalCode: null }))).toBe('validation_failed: $.city: expected str, got 1');
        expect(nullable(int).parse(null)).toBeNull();
        expect(int.nullable().name).toBe('int | null');
        expect(int.or(str).list().name).toBe('list(int | str)');
        expect(union(int, int)).toBe(int);
    });

    it('accepts enum values as arguments or one array', () => {
        expect(enumOf(['a', 'b']).parse('b')).toBe('b');
        expect(reason(() => enumOf())).toMatch(/one or more strings/);
        expect(t.enum('x').is('x')).toBe(true);
    });

    it('enforces raw JSON Schema wrapped as a type', () => {
        const Rating = jsonSchema<number>({ type: 'integer', minimum: 1, maximum: 5 }, 'Rating');
        expect(Rating.parse(3)).toBe(3);
        expect(reason(() => Rating.parse(9))).toBe('validation_failed: $: must be <= 5');
        expect(Rating.schema()).toEqual({ type: 'integer', minimum: 1, maximum: 5 });
        const Review = struct('Review', { rating: Rating });
        expect(reason(() => Review.parse({ rating: 0 }))).toBe('validation_failed: $.rating: must be >= 1');
        const Range = jsonSchema({ type: 'object', properties: { low: { type: 'number' } }, required: ['low'] });
        expect(reason(() => struct('Chart', { ranges: list(Range) }).parse({ ranges: [{ low: 'x' }] }))).toBe('validation_failed: $.ranges[0].low: must be number');
        expect(reason(() => jsonSchema({ type: 'nope' }))).toMatch(/invalid schema/);
    });
});

describe('classes', () => {
    const Person = struct('Person', { firstName: str, lastName: str, age: int }).methods({
        fullName() { return `${this.firstName} ${this.lastName}`; },
        older(years: number) { return this.age + years; },
    });

    it('attaches methods to parsed objects', () => {
        const person = Person.parse({ firstName: 'Ada', lastName: 'Lovelace', age: 36 });
        expect(person.fullName()).toBe('Ada Lovelace');
        expect(person.older(4)).toBe(40);
        expect(JSON.stringify(person)).toBe('{"firstName":"Ada","lastName":"Lovelace","age":36}');
        expect(Object.keys(person)).toEqual(['firstName', 'lastName', 'age']);
        expect(Person.is(person)).toBe(true);
        expect(Person.is({ firstName: 'Ada', lastName: 'Lovelace', age: 36 })).toBe(false);
        expect(Person.parse(person)).toBe(person);
        expect(Person.kind).toBe('class');
    });

    it('offers the plain-data view of a class', () => {
        const data = Person.data.parse({ firstName: 'Ada', lastName: 'Lovelace', age: 36 });
        expect(Object.getPrototypeOf(data)).toBe(Object.prototype);
        expect(Person.data.kind).toBe('struct');
        expect(Person.schema()).toEqual(Person.data.schema());
    });

    it('hydrates existing classes, through fromJSON when present', () => {
        class Point {
            x = 0;
            y = 0;
            norm(): number { return Math.hypot(this.x, this.y); }
        }
        const PointType = struct('Point', { x: float, y: float }).class(Point);
        const point = PointType.parse({ x: 3, y: 4 });
        expect(point).toBeInstanceOf(Point);
        expect(point.norm()).toBe(5);
        expect(PointType.is(new Point())).toBe(true);

        class Celsius {
            constructor(readonly degrees: number) {
                if (degrees < -273.15) throw new Failure('assertion_failed', 'below absolute zero');
            }
            static fromJSON(data: { degrees: number }): Celsius { return new Celsius(data.degrees); }
        }
        const CelsiusType = struct('Celsius', { degrees: float }).class(Celsius);
        expect(CelsiusType.parse({ degrees: 20 })).toBeInstanceOf(Celsius);
        expect(reason(() => CelsiusType.parse({ degrees: -300 }))).toBe('assertion_failed: below absolute zero');
    });

    it('nests classes inside structs and lists, and rejects invalid shapes', () => {
        const Team = struct('Team', { members: list(Person) });
        const team = Team.parse({ members: [{ firstName: 'A', lastName: 'B', age: 1 }] });
        expect(team.members[0].fullName()).toBe('A B');
        expect(reason(() => Team.parse({ members: [{ firstName: 'A', lastName: 'B' }] })))
            .toBe("validation_failed: $.members[0]: missing required field 'age' of Person");
        expect(reason(() => Person.field('x', int))).toMatch(/before attaching methods/);
        expect(reason(() => struct('P', { name: str }).methods({ name() { return 1; } }))).toMatch(/collides with a field/);
    });

    it('rejects ambiguous class unions instead of guessing', () => {
        const A = struct('A', { v: int }).methods({ a() { return 1; } });
        const B = struct('B', { v: int }).methods({ b() { return 2; } });
        expect(reason(() => union(A, B).parse({ v: 1 }))).toMatch(/ambiguous: matches A and B/);
        const a = A.parse({ v: 1 });
        expect(union(A, B).parse(a)).toBe(a);
    });
});

describe('validate and JSON text', () => {
    it('parses with a type or checks raw JSON Schema', () => {
        const Pair = struct('Pair', { a: int });
        expect(validate({ a: 1 }, Pair)).toEqual({ a: 1 });
        expect(validate(5, { type: 'integer', minimum: 1 })).toBe(5);
        expect(reason(() => validate(0, { type: 'integer', minimum: 1 }))).toMatch(/validation_failed: \$: must be >= 1/);
        expect(reason(() => validate(1, 'int' as never))).toMatch(/schema must be a type/);
        expect(Pair.parseJson('{"a":2}')).toEqual({ a: 2 });
        expect(reason(() => Pair.parseJson('{a:2}'))).toMatch(/invalid_format: not valid JSON/);
    });
});

describe('static inference', () => {
    it('derives TypeScript types from builders', () => {
        const Line = struct('Line', { description: str, quantity: int, unit: enumOf('kg', 'pc'), note: nullable(str) });
        const Invoice = struct('Invoice', { lines: list(Line), paid: bool }).field('total', float);
        type Invoice = Infer<typeof Invoice>;
        expectTypeOf<Invoice>().toEqualTypeOf<{
            lines: { description: string; quantity: number; unit: 'kg' | 'pc'; note: string | null }[];
            paid: boolean;
            total: number;
        }>();
        expectTypeOf(union(int, str).parse(1)).toEqualTypeOf<number | string>();
        const Named = struct('Named', { name: str }).methods({ greet() { return `Hi ${this.name}`; } });
        expectTypeOf(Named.parse({ name: 'x' }).greet()).toEqualTypeOf<string>();
        expectTypeOf(typedef('Money', int).parse(1)).toEqualTypeOf<number>();
    });
});
