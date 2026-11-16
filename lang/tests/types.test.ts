import { describe, expect, expectTypeOf, it } from 'vitest';
import { Failure } from '../src/errors.js';
import { library } from '../src/library.js';
import {
    Any, Bool, Char, Dict, Enum, Float, Fn, Int, JsonSchema, List, Nil, Nullable, Str, Struct, Typedef, Union, isType, t, validate,
    type Infer,
} from '../src/types.js';
import { exec, scripted, value } from './helpers.js';

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
        expect(Str.parse('a')).toBe('a');
        expect(Int.parse(3)).toBe(3);
        expect(Float.parse(1.5)).toBe(1.5);
        expect(Float.parse(2)).toBe(2);
        expect(Bool.parse(false)).toBe(false);
        expect(Char.parse('é')).toBe('é');
        expect(Char.parse('😀')).toBe('😀');
        expect(Nil.parse(null)).toBeNull();
        expect(Any.parse({ a: [1] })).toEqual({ a: [1] });
        expect(Dict.parse({ a: 1 })).toEqual({ a: 1 });
        expect(reason(() => Int.parse('3'))).toBe('validation_failed: $: expected Int, got "3"');
        expect(reason(() => Int.parse(1.5))).toMatch(/expected Int, got 1.5/);
        expect(reason(() => Int.parse(2 ** 60))).toMatch(/expected Int/);
        expect(reason(() => Float.parse(Infinity))).toMatch(/expected Float/);
        expect(reason(() => Str.parse(1))).toMatch(/expected Str, got 1/);
        expect(reason(() => Bool.parse(0))).toMatch(/expected Bool/);
        expect(reason(() => Char.parse('ab'))).toMatch(/expected Char/);
        expect(reason(() => Nil.parse(undefined))).toMatch(/expected Nil/);
        expect(reason(() => Dict.parse([]))).toMatch(/expected Dict, got an array/);
        expect(reason(() => Any.parse(undefined))).toMatch(/expected Any/);
    });

    it('tests values without throwing', () => {
        expect(Int.is(1)).toBe(true);
        expect(Int.is('1')).toBe(false);
        expect(Union(Int, Str).is('x')).toBe(true);
        expect(List(Int).is([1, 'x'])).toBe(false);
    });

    it('have uppercase names only: in the library, the t namespace and workflows', async () => {
        const names = ['Str', 'Int', 'Float', 'Bool', 'Char', 'Nil', 'Any', 'Dict', 'Fn', 'List', 'Union', 'Nullable', 'Enum', 'Struct', 'Typedef', 'JsonSchema'];
        expect(Object.keys(t)).toEqual([...names, 'validate']);
        expect(Object.keys(library()).filter(name => /^[A-Z]/.test(name) && name !== 'Failure')).toEqual(names);
        expect([Str, Int, Float, Bool, Char, Nil, Any, Dict, Fn].map(String)).toEqual(names.slice(0, 9));
        const removed = ['str', 'int', 'float', 'bool', 'char', 'nil', 'any', 'object', 'fn', 'list', 'union', 'nullable', 'enumOf', 'struct', 'typedef', 'jsonSchema'];
        expect(removed.filter(name => name in library() || name in t)).toEqual([]);
        expect(await value(`success([${removed.map(name => `typeof ${name}`).join(', ')}]);`)).toEqual(removed.map(() => 'undefined'));
        expect(await value([
            'const Tags = t.List(t.Union(t.Str, t.Int));',
            'const Card = Struct("Card", { term: Str, tags: Tags, level: Nullable(Enum("easy", "hard")) });',
            'type Card = { term: string; tags: (string | number)[]; level: "easy" | "hard" | null };',
            'const card: Card = Card.parse({ term: "closure", tags: ["js", 1], level: null });',
            'success([card, Card.name, Tags.name, Card.fields.level.name, Dict.is({}), t.Int === Int]);',
        ].join('\n'))).toEqual([{ term: 'closure', tags: ['js', 1], level: null }, 'Card', 'List(Str | Int)', '"easy" | "hard" | Nil', true, true]);
    });
});

describe('composite types', () => {
    const Color = Enum('red', 'green', 'blue');
    const Money = Typedef('Money', Int, { minimum: 0, desc: 'Amount in cents' });
    const Address = Struct('Address', { city: Str, postalCode: Nullable(Str) });
    const Order = Struct('Order', {
        id: Str.annotate({ pattern: '^A-\\d+$' }),
        color: Color,
        total: Money,
        address: Address,
        tags: List(Str),
    });

    it('parses exact structs into plain objects with field paths in errors', () => {
        const input = { id: 'A-1', color: 'red', total: 10, address: { city: 'London', postalCode: null }, tags: ['x'] };
        const order = Order.parse(input);
        expect(order).toEqual(input);
        expect(order).not.toBe(input);
        expect(Object.getPrototypeOf(order)).toBe(Object.prototype);
        expect(reason(() => Order.parse({ ...input, extra: 1 }))).toBe("validation_failed: $: unexpected field 'extra' in Order");
        expect(reason(() => Order.parse({ ...input, tags: undefined }))).toMatch(/\$\.tags: expected List\(Str\)/);
        const { tags: _tags, ...partial } = input;
        expect(reason(() => Order.parse(partial))).toBe("validation_failed: $: missing required field 'tags' of Order");
        expect(reason(() => Order.parse({ ...input, address: { city: 'X', postalCode: 5 } }))).toBe('validation_failed: $.address.postalCode: expected Str, got 5');
        expect(reason(() => Order.parse({ ...input, color: 'pink' }))).toBe('validation_failed: $.color: expected "red" | "green" | "blue", got "pink"');
        expect(reason(() => Order.parse({ ...input, tags: ['a', 2] }))).toBe('validation_failed: $.tags[1]: expected Str, got 2');
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
        expect(Str.describe('A title').schema()).toEqual({ type: 'string', description: 'A title' });
        expect(Char.annotate({ desc: 'Initial' }).schema().description).toBe('Exactly one Unicode character.\nInitial');
        expect(Any.schema()).toEqual({});
        expect(Dict.schema()).toEqual({ type: 'object' });
        expect(reason(() => Struct('Handler', { callback: Fn }).schema())).toMatch(/runtime_error: Fn is a callable/);
    });

    it('keeps types immutable: modifiers return copies', () => {
        const titled = Str.describe('Title');
        expect(Str.annotations).toEqual({});
        expect(titled.annotations).toEqual({ description: 'Title' });
        expect(titled.annotate({ maxLength: 10 }).annotations).toEqual({ description: 'Title', maxLength: 10 });
        expect(Object.isFrozen(titled)).toBe(true);
        expect(Money.name).toBe('Money');
        expect(Int.name).toBe('Int');
        expect(String(Money)).toBe('Money');
        expect(JSON.stringify({ Money })).toBe('{"Money":"<type Money>"}');
        expect(isType(Money)).toBe(true);
        expect(isType({ kind: 'int' })).toBe(false);
    });

    it('builds structs fluently, field by field', () => {
        const Point = Struct('Point').field('x', Float, { desc: 'Horizontal' }).field('y', Float);
        expect(Point.parse({ x: 1, y: 2 })).toEqual({ x: 1, y: 2 });
        expect(Point.schema().properties).toEqual({ x: { type: 'number', description: 'Horizontal' }, y: { type: 'number' } });
        expect(reason(() => Point.field('x', Int))).toMatch(/duplicate field 'x'/);
        expect(reason(() => Struct('Bad', { a: 'Str' as never }))).toMatch(/field 'a' of Bad must be a type such as Str, List\(Int\) or a Struct/);
        expect(reason(() => Struct(''))).toMatch(/requires a name/);
    });

    it('decodes unions member by member and reports nullable errors precisely', () => {
        const Id = Union(Int, Str);
        expect(Id.parse(1)).toBe(1);
        expect(Id.parse('a')).toBe('a');
        expect(reason(() => Id.parse(true))).toBe('validation_failed: $: expected Int | Str, got true');
        expect(reason(() => Nullable(Address).parse({ city: 1, postalCode: null }))).toBe('validation_failed: $.city: expected Str, got 1');
        expect(Nullable(Int).parse(null)).toBeNull();
        expect(Int.nullable().name).toBe('Int | Nil');
        expect(Int.or(Str).list().name).toBe('List(Int | Str)');
        expect(Union(Int, Int)).toBe(Int);
    });

    it('accepts enum values as arguments or one array', () => {
        expect(Enum(['a', 'b']).parse('b')).toBe('b');
        expect(reason(() => Enum())).toMatch(/Enum\(\) requires one or more strings/);
        expect(t.Enum('x').is('x')).toBe(true);
    });

    it('enforces raw JSON Schema wrapped as a type', () => {
        const Rating = JsonSchema<number>({ type: 'integer', minimum: 1, maximum: 5 }, 'Rating');
        expect(Rating.parse(3)).toBe(3);
        expect(reason(() => Rating.parse(9))).toBe('validation_failed: $: must be <= 5');
        expect(Rating.schema()).toEqual({ type: 'integer', minimum: 1, maximum: 5 });
        const Review = Struct('Review', { rating: Rating });
        expect(reason(() => Review.parse({ rating: 0 }))).toBe('validation_failed: $.rating: must be >= 1');
        const Range = JsonSchema({ type: 'object', properties: { low: { type: 'number' } }, required: ['low'] });
        expect(reason(() => Struct('Chart', { ranges: List(Range) }).parse({ ranges: [{ low: 'x' }] }))).toBe('validation_failed: $.ranges[0].low: must be number');
        expect(reason(() => JsonSchema({ type: 'nope' }))).toMatch(/invalid schema/);
    });
});

describe('classes', () => {
    const Person = Struct('Person', { firstName: Str, lastName: Str, age: Int }).methods({
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
        const PointType = Struct('Point', { x: Float, y: Float }).class(Point);
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
        const CelsiusType = Struct('Celsius', { degrees: Float }).class(Celsius);
        expect(CelsiusType.parse({ degrees: 20 })).toBeInstanceOf(Celsius);
        expect(reason(() => CelsiusType.parse({ degrees: -300 }))).toBe('assertion_failed: below absolute zero');
    });

    it('nests classes inside structs and lists, and rejects invalid shapes', () => {
        const Team = Struct('Team', { members: List(Person) });
        const team = Team.parse({ members: [{ firstName: 'A', lastName: 'B', age: 1 }] });
        expect(team.members[0].fullName()).toBe('A B');
        expect(reason(() => Team.parse({ members: [{ firstName: 'A', lastName: 'B' }] })))
            .toBe("validation_failed: $.members[0]: missing required field 'age' of Person");
        expect(reason(() => Person.field('x', Int))).toMatch(/before attaching methods/);
        expect(reason(() => Struct('P', { name: Str }).methods({ name() { return 1; } }))).toMatch(/collides with a field/);
    });

    it('rejects ambiguous class unions instead of guessing', () => {
        const A = Struct('A', { v: Int }).methods({ a() { return 1; } });
        const B = Struct('B', { v: Int }).methods({ b() { return 2; } });
        expect(reason(() => Union(A, B).parse({ v: 1 }))).toMatch(/ambiguous: matches A and B/);
        const a = A.parse({ v: 1 });
        expect(Union(A, B).parse(a)).toBe(a);
    });
});

describe('validate and JSON text', () => {
    it('parses with a type or checks raw JSON Schema', () => {
        const Pair = Struct('Pair', { a: Int });
        expect(validate({ a: 1 }, Pair)).toEqual({ a: 1 });
        expect(validate(5, { type: 'integer', minimum: 1 })).toBe(5);
        expect(reason(() => validate(0, { type: 'integer', minimum: 1 }))).toMatch(/validation_failed: \$: must be >= 1/);
        expect(reason(() => validate(1, 'Int' as never))).toMatch(/schema must be a type/);
        expect(Pair.parseJson('{"a":2}')).toEqual({ a: 2 });
        expect(reason(() => Pair.parseJson('{a:2}'))).toMatch(/invalid_format: not valid JSON/);
    });

    it('stays strict where coerce converts', () => {
        const Pair = Struct('Pair', { a: Int });
        expect(reason(() => validate({ a: '1' }, Pair))).toBe('validation_failed: $.a: expected Int, got "1"');
        expect(reason(() => Pair.parseJson('{"a":"2"}'))).toBe('validation_failed: $.a: expected Int, got "2"');
        expect(reason(() => Pair.parse('{"a":2}'))).toBe('validation_failed: $: expected Pair, got "{\\"a\\":2}"');
        expect(Pair.is({ a: '1' })).toBe(false);
        expect(Pair.coerce({ a: '1' })).toEqual({ a: 1 });
    });
});

describe('coerce', () => {
    const Point = Struct('Point', { x: Float, y: Float });
    const Line = Struct('Line', { description: Str, quantity: Int, price: Float, taxed: Bool });
    const Invoice = Struct('Invoice', { id: Str, lines: List(Line), paid: Bool, note: Nullable(Str) });
    const raw = {
        id: 17, paid: 'true', note: null,
        lines: [{ description: 'Pen', quantity: '2', price: '1.50', taxed: 1 }, '{"description":"Ink","quantity":3.0,"price":4,"taxed":"false"}'],
    };
    const invoice = {
        id: '17', paid: true, note: null,
        lines: [{ description: 'Pen', quantity: 2, price: 1.5, taxed: true }, { description: 'Ink', quantity: 3, price: 4, taxed: false }],
    };

    it('parses strings that hold JSON first', () => {
        expect(List(Int).coerce('[1, 2]')).toEqual([1, 2]);
        expect(Point.coerce(' {"x": 1, "y": 2}\n')).toEqual({ x: 1, y: 2 });
        expect(Dict.coerce('{"a":{"b":[1]}}')).toEqual({ a: { b: [1] } });
        expect(Any.coerce('{"a":[1,"2"]}')).toEqual({ a: [1, '2'] });
        expect(Float.coerce('1.5e1')).toBe(15);
        expect(Bool.coerce('false')).toBe(false);
        expect(Nil.coerce('null')).toBeNull();
        // The same holds at any depth: a field or an item may hold JSON text.
        expect(Struct('Shape', { name: Str, points: List(Point) }).coerce({ name: 'line', points: '[{"x":0,"y":0},"{\\"x\\":1,\\"y\\":1}"]' }))
            .toEqual({ name: 'line', points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] });
        expect(reason(() => List(Int).coerce('1, 2'))).toBe('validation_failed: $: expected List(Int), got "1, 2"');
        expect(reason(() => Point.coerce('x=1'))).toBe('validation_failed: $: expected Point, got "x=1"');
        expect(reason(() => List(Int).coerce('{"0":1}'))).toBe('validation_failed: $: expected List(Int), got an object');
    });

    it('turns numeric strings into numbers', () => {
        expect(Int.coerce('42')).toBe(42);
        expect(Int.coerce(' -7\n')).toBe(-7);
        expect(Int.coerce('1e2')).toBe(100);
        expect(Int.coerce(42)).toBe(42);
        expect(Float.coerce('3.14')).toBe(3.14);
        expect(Float.coerce('-1.2e-3')).toBe(-0.0012);
        expect(Float.coerce('.5')).toBe(0.5);
        expect(Float.coerce('7')).toBe(7);
        expect(Float.coerce(2.5)).toBe(2.5);
        for (const text of ['', '  ', 'abc', '12abc', '1,000', 'NaN', 'Infinity', '1e400']) {
            expect(reason(() => Int.coerce(text))).toBe(`validation_failed: $: expected Int, got ${JSON.stringify(text)}`);
            expect(reason(() => Float.coerce(text))).toBe(`validation_failed: $: expected Float, got ${JSON.stringify(text)}`);
        }
        for (const other of [true, null, [3], { value: 3 }, NaN, Infinity]) {
            expect(reason(() => Int.coerce(other))).toMatch(/^validation_failed: \$: expected Int, got /);
            expect(reason(() => Float.coerce(other))).toMatch(/^validation_failed: \$: expected Float, got /);
        }
    });

    it('requires an exact integer for Int: 3.0 gives 3, but 3.7 fails', () => {
        expect(Int.coerce(3.0)).toBe(3);
        expect(Int.coerce('3.0')).toBe(3);
        expect(Int.coerce('3.000')).toBe(3);
        expect(Int.coerce('30e-1')).toBe(3);
        expect(reason(() => Int.coerce(3.7))).toBe('validation_failed: $: expected Int, got 3.7');
        expect(reason(() => Int.coerce('3.7'))).toBe('validation_failed: $: expected Int, got 3.7');
        expect(reason(() => Int.coerce('0.1e-1'))).toBe('validation_failed: $: expected Int, got 0.01');
        // An integer that a number cannot hold exactly is not rounded either.
        expect(reason(() => Int.coerce('9007199254740993'))).toMatch(/expected Int, got 9007199254740992/);
        expect(Int.coerce(String(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
        expect(Float.coerce('3.7')).toBe(3.7);
        expect(reason(() => List(Int).coerce(['3.0', '3.7']))).toBe('validation_failed: $[1]: expected Int, got 3.7');
    });

    it('accepts true, false, 1, 0 and their strings for Bool', () => {
        for (const yes of [true, 1, 'true', '1', ' true ']) expect(Bool.coerce(yes)).toBe(true);
        for (const no of [false, 0, 'false', '0', '0\n']) expect(Bool.coerce(no)).toBe(false);
        for (const other of [2, -1, 'yes', 'no', 'TRUE', 'False', '1.0', '', null, [], {}]) {
            expect(reason(() => Bool.coerce(other))).toMatch(/^validation_failed: \$: expected Bool, got /);
        }
        expect(reason(() => Bool.coerce('yes'))).toBe('validation_failed: $: expected Bool, got "yes"');
        expect(reason(() => Bool.coerce(2))).toBe('validation_failed: $: expected Bool, got 2');
    });

    it('turns non-strings into JSON text for Str, and keeps strings as they are', () => {
        expect(Str.coerce(3)).toBe('3');
        expect(Str.coerce(-1.5)).toBe('-1.5');
        expect(Str.coerce(true)).toBe('true');
        expect(Str.coerce(null)).toBe('null');
        expect(Str.coerce([1, 'two', null])).toBe('[1,"two",null]');
        expect(Str.coerce({ a: { b: [1] } })).toBe('{"a":{"b":[1]}}');
        expect(Str.coerce(new Date(0))).toBe('"1970-01-01T00:00:00.000Z"');
        for (const text of ['', 'plain', '  padded  ', '3', 'true', '{ "a": 1 }', '"quoted"']) expect(Str.coerce(text)).toBe(text);
        expect(reason(() => Str.coerce(undefined))).toBe('validation_failed: $: expected Str, got undefined');
        expect(reason(() => Str.coerce(() => 1))).toBe('validation_failed: $: expected Str, got function');
        expect(reason(() => Str.coerce(Symbol('s')))).toBe('validation_failed: $: expected Str, got symbol');
    });

    it('fails with validation_failed for values that have no JSON text', () => {
        const cyclic: Record<string, unknown> = {};
        cyclic.self = cyclic;
        expect(reason(() => Str.coerce(10n))).toMatch(/^validation_failed: \$: expected Str/);
        expect(reason(() => Str.coerce(cyclic))).toMatch(/^validation_failed: \$: expected Str/);
    });

    it('coerces struct fields and list items recursively, keeping structs exact', () => {
        expect(Invoice.coerce(raw)).toEqual(invoice);
        expect(Invoice.coerce(JSON.stringify(raw))).toEqual(invoice);
        expect(List(List(Bool)).coerce('[["1", 0], "[true]", []]')).toEqual([[true, false], [true], []]);
        expect(List(Int).coerce(['1', 2, '3.0', ' 4 '])).toEqual([1, 2, 3, 4]);
        expect(List(Str).coerce(['a', 1, null, { b: 2 }])).toEqual(['a', '1', 'null', '{"b":2}']);
        const coerced = Invoice.coerce(raw);
        expect(Object.getPrototypeOf(coerced)).toBe(Object.prototype);
        expect(Invoice.is(coerced)).toBe(true);
        expect(Invoice.is(raw)).toBe(false);
        // Coercion converts values; it does not invent or drop fields, or wrap single values into lists.
        expect(reason(() => Point.coerce({ x: '1', y: '2', z: '3' }))).toBe("validation_failed: $: unexpected field 'z' in Point");
        expect(reason(() => Point.coerce({ x: '1' }))).toBe("validation_failed: $: missing required field 'y' of Point");
        expect(reason(() => List(Int).coerce('5'))).toBe('validation_failed: $: expected List(Int), got 5');
        expect(reason(() => Point.coerce([1, 2]))).toBe('validation_failed: $: expected Point, got an array');
    });

    it('fails with validation_failed and the path of the bad field', () => {
        const failure = (input: unknown): string => reason(() => Invoice.coerce(input));
        expect(failure({ ...raw, paid: 'maybe' })).toBe('validation_failed: $.paid: expected Bool, got "maybe"');
        expect(failure({ ...raw, lines: [raw.lines[0], { ...invoice.lines[1], quantity: '3.7' }] })).toBe('validation_failed: $.lines[1].quantity: expected Int, got 3.7');
        expect(failure({ ...raw, lines: [raw.lines[0], '{"description":"Ink","quantity":3,"price":"free","taxed":0}'] })).toBe('validation_failed: $.lines[1].price: expected Float, got "free"');
        expect(failure({ ...raw, lines: [{ description: 'Pen', quantity: 2, taxed: true }] })).toBe("validation_failed: $.lines[0]: missing required field 'price' of Line");
        expect(failure({ ...raw, lines: 'none' })).toBe('validation_failed: $.lines: expected List(Line), got "none"');
        expect(failure('[]')).toBe('validation_failed: $: expected Invoice, got an array');
        expect(reason(() => Struct('Odd', { 'unit price': Float, 'a.b': List(Int) }).coerce({ 'unit price': '1', 'a.b': [1, 'x'] })))
            .toBe('validation_failed: $["a.b"][1]: expected Int, got "x"');
        // The root of the path can be named, as agent blocks do for their outputs.
        expect(reason(() => Int.coerce('three', 'count'))).toBe('validation_failed: count: expected Int, got "three"');
        expect(reason(() => Point.coerce({ x: 1, y: 'north' }, 'origin'))).toBe('validation_failed: origin.y: expected Float, got "north"');
        let thrown: unknown;
        try {
            Invoice.coerce({ ...raw, id: undefined });
        } catch (error) {
            thrown = error;
        }
        expect(thrown).toBeInstanceOf(Failure);
        expect(thrown).toMatchObject({ statusCode: 'validation_failed', status_code: 'validation_failed', reason: '$.id: expected Str, got undefined' });
    });

    it('is deterministic, leaves its input alone and never calls a model', async () => {
        const input = structuredClone(raw);
        const first = Invoice.coerce(input);
        for (let round = 0; round < 3; round++) expect(Invoice.coerce(input)).toEqual(first);
        expect(input).toEqual(raw);
        expect(first).not.toBe(input);
        expect(first.lines[0]).not.toBe(input.lines[0]);
        // Coercing a coerced value changes nothing.
        expect(Invoice.coerce(first)).toEqual(first);
        expect(Invoice.parse(first)).toEqual(first);
        // The result is a plain value, at once: nothing is awaited.
        expect(Int.coerce('3')).toBe(3);
        const model = scripted();
        expect(await value([
            'const Joke = Struct("Joke", { setup: Str, stars: Int, tags: List(Str) });',
            'const joke: { setup: string; stars: number; tags: string[] } = Joke.coerce(\'{"setup":"Knock","stars":"4","tags":[1]}\');',
            'const total: number = Int.coerce("3.0") + Float.coerce("0.5");',
            'success({ joke, total, flag: Bool.coerce(0) });',
        ].join('\n'), { backend: model })).toEqual({ joke: { setup: 'Knock', stars: 4, tags: ['1'] }, total: 3.5, flag: false });
        expect(model.calls).toHaveLength(0);
    });

    it('fails a workflow with validation_failed on the line of the call, unless caught', async () => {
        expect(await exec('const Point = Struct("Point", { x: Float, y: Float });\n\nconst point = Point.coerce({ x: "1", y: "north" });')).toEqual({
            status: 'failure',
            failure: { status: 'failure', status_code: 'validation_failed', reason: '$.y: expected Float, got "north"', line: 3, command: 'const point = Point.coerce({ x: "1", y: "north" });' },
        });
        expect(await value('try {\n    Int.coerce("3.7");\n} catch (error) {\n    success([error instanceof Failure, error.statusCode, error.reason]);\n}'))
            .toEqual([true, 'validation_failed', '$: expected Int, got 3.7']);
    });

    it('keeps a value that fits a union member, and otherwise converts to the first member that takes it', () => {
        const Id = Union(Int, Str);
        expect(Id.coerce(7)).toBe(7);
        expect(Id.coerce('7')).toBe('7');
        expect(Id.coerce(true)).toBe('true');
        expect(Union(Int, Bool).coerce('true')).toBe(true);
        expect(Union(Int, Bool).coerce('1')).toBe(1);
        expect(Union(Bool, Int).coerce('1')).toBe(true);
        expect(Union(Bool, Int).coerce('2')).toBe(2);
        expect(Union(Int, List(Int)).coerce('["1", 2]')).toEqual([1, 2]);
        expect(Union(Point, List(Point)).coerce('[{"x":"1","y":2}]')).toEqual([{ x: 1, y: 2 }]);
        expect(Union(Point, Line).coerce({ description: 'Pen', quantity: '2', price: 1, taxed: 'false' })).toEqual({ description: 'Pen', quantity: 2, price: 1, taxed: false });
        expect(List(Union(Str, Int)).coerce('["a", 1, "2", true]')).toEqual(['a', 1, '2', 'true']);
        expect(reason(() => Union(Int, Bool).coerce('x'))).toBe('validation_failed: $: expected Int | Bool, got "x"');
        expect(reason(() => Struct('Row', { id: Union(Int, Bool) }).coerce({ id: [] }))).toBe('validation_failed: $.id: expected Int | Bool, got an array');
        expect(reason(() => List(Union(Int, Point)).coerce([1, { x: 1 }]))).toBe('validation_failed: $[1]: expected Int | Point, got an object');
    });

    it('accepts null and "null" for nullable types, and reports the error of the type otherwise', () => {
        expect(Nullable(Int).coerce(null)).toBeNull();
        expect(Nullable(Int).coerce('null')).toBeNull();
        expect(Int.nullable().coerce(' null ')).toBeNull();
        expect(Nullable(Int).coerce('5')).toBe(5);
        expect(Nullable(Bool).coerce(0)).toBe(false);
        expect(Nullable(Point).coerce('{"x":"1","y":2}')).toEqual({ x: 1, y: 2 });
        expect(Nullable(List(Int)).coerce('null')).toBeNull();
        expect(Nullable(Dict).coerce('null')).toBeNull();
        expect(Nullable(Str).coerce(null)).toBeNull();
        expect(Nullable(Str).coerce(5)).toBe('5');
        expect(reason(() => Nullable(Int).coerce('x'))).toBe('validation_failed: $: expected Int, got "x"');
        expect(reason(() => Nullable(Int).coerce(''))).toBe('validation_failed: $: expected Int, got ""');
        expect(reason(() => Nullable(Int).coerce(undefined))).toBe('validation_failed: $: expected Int, got undefined');
        const Address = Struct('Address', { city: Str, zip: Nullable(Int) });
        expect(Address.coerce('{"city":"Oslo","zip":"0150"}')).toEqual({ city: 'Oslo', zip: 150 });
        expect(Address.coerce({ city: 'Oslo', zip: null })).toEqual({ city: 'Oslo', zip: null });
        expect(reason(() => Address.coerce({ city: 'Oslo', zip: 'x' }))).toBe('validation_failed: $.zip: expected Int, got "x"');
        expect(reason(() => Address.coerce({ city: 'Oslo' }))).toBe("validation_failed: $: missing required field 'zip' of Address");
        expect(reason(() => Nullable(Address).coerce({ city: 'Oslo', zip: 'x' }))).toBe('validation_failed: $.zip: expected Int, got "x"');
    });

    it('reports the field that cannot be converted in a nullable struct', () => {
        const Address = Struct('Address', { city: Str, zip: Int });
        expect(reason(() => Nullable(Address).coerce({ city: 5, zip: 'x' }))).toBe('validation_failed: $.zip: expected Int, got "x"');
    });

    it('checks enum values exactly, wherever they are', () => {
        const Color = Enum('red', 'green');
        expect(Color.coerce('red')).toBe('red');
        expect(List(Color).coerce('["red","green"]')).toEqual(['red', 'green']);
        expect(Nullable(Color).coerce('null')).toBeNull();
        expect(Enum('1', '2').coerce('1')).toBe('1');
        expect(Enum('true', 'null').coerce('null')).toBe('null');
        expect(reason(() => Color.coerce('Red'))).toBe('validation_failed: $: expected "red" | "green", got "Red"');
        expect(reason(() => Color.coerce(' red '))).toBe('validation_failed: $: expected "red" | "green", got " red "');
        expect(reason(() => Color.coerce(0))).toBe('validation_failed: $: expected "red" | "green", got 0');
        expect(reason(() => Struct('Paint', { colors: List(Color) }).coerce('{"colors":["green","blue"]}')))
            .toBe('validation_failed: $.colors[1]: expected "red" | "green", got "blue"');
    });

    it('reads a Dict from an object or its JSON text, without touching what is inside', () => {
        expect(Dict.coerce({ a: 1 })).toEqual({ a: 1 });
        expect(Dict.coerce('{}')).toEqual({});
        expect(Dict.coerce('{"a":"1","b":"[true]","c":{"d":"2"}}')).toEqual({ a: '1', b: '[true]', c: { d: '2' } });
        expect(Struct('Config', { options: Dict, flags: List(Dict) }).coerce({ options: '{"depth":"2"}', flags: '[{"on":"1"}]' }))
            .toEqual({ options: { depth: '2' }, flags: [{ on: '1' }] });
        expect(reason(() => Dict.coerce('[1]'))).toBe('validation_failed: $: expected Dict, got an array');
        expect(reason(() => Dict.coerce('nope'))).toBe('validation_failed: $: expected Dict, got "nope"');
        expect(reason(() => Dict.coerce('7'))).toBe('validation_failed: $: expected Dict, got 7');
        expect(reason(() => Dict.coerce(null))).toBe('validation_failed: $: expected Dict, got null');
        expect(reason(() => Dict.coerce(new Map()))).toBe('validation_failed: $: expected Dict, got an object');
    });

    it('reads Any from JSON text when a string holds it, and keeps every other JSON value', () => {
        expect(Any.coerce('{"a":[1,"2"]}')).toEqual({ a: [1, '2'] });
        expect(Any.coerce(' [1, "2"] ')).toEqual([1, '2']);
        expect(Any.coerce('12')).toBe(12);
        expect(Any.coerce('true')).toBe(true);
        expect(Any.coerce('"quoted"')).toBe('quoted');
        expect(Any.coerce('plain text')).toBe('plain text');
        expect(Any.coerce('')).toBe('');
        expect(Any.coerce({ a: '1', b: '[2]' })).toEqual({ a: '1', b: '[2]' });
        expect(Any.coerce(null)).toBeNull();
        expect(Any.coerce(0)).toBe(0);
        expect(Struct('Note', { meta: Any }).coerce('{"meta":"{\\"k\\":[1]}"}')).toEqual({ meta: { k: [1] } });
        expect(reason(() => Any.coerce(undefined))).toBe('validation_failed: $: expected Any, got undefined');
        expect(reason(() => Any.coerce(() => 1))).toBe('validation_failed: $: expected Any, got function');
        expect(reason(() => Struct('Note', { meta: Any }).coerce({ meta: undefined }))).toBe('validation_failed: $.meta: expected Any, got undefined');
    });

    it('reads the JSON text null as null for Any', () => {
        expect(Any.coerce('null')).toBeNull();
        expect(Struct('Note', { meta: Any }).coerce({ meta: 'null' })).toEqual({ meta: null });
    });

    it('converts nothing for Char, Nil and Fn beyond JSON null, and never builds code from text', () => {
        expect(Char.coerce('é')).toBe('é');
        expect(Nil.coerce(null)).toBeNull();
        const callback = (): number => 1;
        expect(Fn.coerce(callback)).toBe(callback);
        expect(reason(() => Char.coerce(1))).toBe('validation_failed: $: expected Char, got 1');
        expect(reason(() => Char.coerce('ab'))).toBe('validation_failed: $: expected Char, got "ab"');
        expect(reason(() => Nil.coerce(''))).toBe('validation_failed: $: expected Nil, got ""');
        expect(reason(() => Nil.coerce(0))).toBe('validation_failed: $: expected Nil, got 0');
        expect(reason(() => Nil.coerce(undefined))).toBe('validation_failed: $: expected Nil, got undefined');
        expect(reason(() => Fn.coerce('x => x'))).toBe('validation_failed: $: expected Fn, got "x => x"');
    });

    it('builds class instances with their methods from coerced data', () => {
        const Person = Struct('Person', { name: Str, age: Int }).methods({
            greet() { return `Hi ${this.name}`; },
            older(years: number) { return this.age + years; },
        });
        const person = Person.coerce('{"name":"Ada","age":"36"}');
        expect([person.greet(), person.older(4), person.age]).toEqual(['Hi Ada', 40, 36]);
        expect(Person.is(person)).toBe(true);
        expect(JSON.stringify(person)).toBe('{"name":"Ada","age":36}');
        // An instance is already of the type; plain data gets a new instance each time.
        expect(Person.coerce(person)).toBe(person);
        expect(Person.coerce({ name: 'Ada', age: 36 })).not.toBe(Person.coerce({ name: 'Ada', age: 36 }));
        const data = Person.data.coerce({ name: 'Ada', age: '36' });
        expect(data).toEqual({ name: 'Ada', age: 36 });
        expect(Object.getPrototypeOf(data)).toBe(Object.prototype);

        const Team = Struct('Team', { lead: Nullable(Person), members: List(Person) });
        const team = Team.coerce({ lead: 'null', members: '[{"name":"A","age":"1"},{"name":"B","age":2.0}]' });
        expect(team.lead).toBeNull();
        expect(team.members.map(member => member.greet())).toEqual(['Hi A', 'Hi B']);
        expect(reason(() => Team.coerce({ lead: null, members: [{ name: 'A', age: 'old' }] }))).toBe('validation_failed: $.members[0].age: expected Int, got "old"');
        expect(reason(() => Team.coerce({ lead: null, members: [{ name: 'A' }] }))).toBe("validation_failed: $.members[0]: missing required field 'age' of Person");
        expect(reason(() => Person.coerce({ name: 'A', age: 1, greet: 'hi' }))).toBe("validation_failed: $: unexpected field 'greet' in Person");

        // In a union, a class is preferred over the plain struct with the same fields.
        const Plain = Struct('Plain', { name: Str, age: Int });
        expect(Person.is(Union(Plain, Person).coerce({ name: 'Ada', age: '36' }))).toBe(true);
    });

    it('hydrates existing classes from coerced data, through fromJSON when present', () => {
        class Vector {
            x = 0;
            y = 0;
            norm(): number { return Math.hypot(this.x, this.y); }
        }
        const VectorType = Struct('Vector', { x: Float, y: Float }).class(Vector);
        const vector = VectorType.coerce('{"x":"3","y":4}');
        expect(vector).toBeInstanceOf(Vector);
        expect(vector.norm()).toBe(5);

        class Celsius {
            constructor(readonly degrees: number) {
                if (typeof degrees !== 'number' || degrees < -273.15) throw new Failure('assertion_failed', 'below absolute zero');
            }
            static fromJSON(data: { degrees: number }): Celsius { return new Celsius(data.degrees); }
        }
        const CelsiusType = Struct('Celsius', { degrees: Float }).class(Celsius);
        // fromJSON receives the data after conversion.
        expect(CelsiusType.coerce({ degrees: '20.5' })).toEqual(new Celsius(20.5));
        expect(CelsiusType.coerce({ degrees: '20.5' })).toBeInstanceOf(Celsius);
        expect(reason(() => CelsiusType.coerce({ degrees: '-300' }))).toBe('assertion_failed: below absolute zero');
        expect(reason(() => CelsiusType.coerce({ degrees: 'cold' }))).toBe('validation_failed: $.degrees: expected Float, got "cold"');
    });

    it('enforces JSON Schema types on the value as written, then on the JSON it holds', () => {
        const Rating = JsonSchema<number>({ type: 'integer', minimum: 1, maximum: 5 }, 'Rating');
        expect(Rating.coerce(3)).toBe(3);
        expect(Rating.coerce('3')).toBe(3);
        expect(reason(() => Rating.coerce('9'))).toBe('validation_failed: $: must be <= 5');
        expect(reason(() => Rating.coerce(0))).toBe('validation_failed: $: must be >= 1');
        expect(reason(() => Rating.coerce('high'))).toBe('validation_failed: $: must be integer');
        // A schema may describe a string: text that fits is not parsed.
        expect(JsonSchema({ type: 'string' }).coerce('3')).toBe('3');
        expect(JsonSchema({ type: ['string', 'null'] }).coerce('null')).toBe('null');
        expect(JsonSchema({ type: 'null' }).coerce('null')).toBeNull();
        expect(reason(() => JsonSchema({ type: 'string' }).coerce(3))).toBe('validation_failed: $: must be string');
        // What is inside is up to the schema: nothing is converted there.
        const Range = JsonSchema({ type: 'object', properties: { low: { type: 'number' } }, required: ['low'] }, 'Range');
        expect(Range.coerce('{"low":1}')).toEqual({ low: 1 });
        expect(reason(() => Range.coerce({ low: '1' }))).toBe('validation_failed: $.low: must be number');
        expect(reason(() => Range.coerce('{"low":"x"}'))).toBe('validation_failed: $.low: must be number');
        expect(reason(() => Range.coerce('{}'))).toBe("validation_failed: $.low: must have required property 'low'");
        expect(reason(() => Range.coerce('nope'))).toBe('validation_failed: $: must be object');
        const Chart = Struct('Chart', { title: Str, rating: Rating, ranges: List(Range) });
        expect(Chart.coerce('{"title":7,"rating":"4","ranges":[{"low":1},"{\\"low\\":2}"]}')).toEqual({ title: '7', rating: 4, ranges: [{ low: 1 }, { low: 2 }] });
        expect(reason(() => Chart.coerce({ title: 'T', rating: '0', ranges: [] }))).toBe('validation_failed: $.rating: must be >= 1');
        expect(reason(() => Chart.coerce({ title: 'T', rating: 4, ranges: [{ low: 1 }, { low: 'x' }] }))).toBe('validation_failed: $.ranges[1].low: must be number');
        expect(reason(() => Chart.coerce({ title: 'T', rating: 4, ranges: [[]] }))).toBe('validation_failed: $.ranges[0]: must be object');
    });

    it('treats annotations and type names as it does when parsing', () => {
        const Money = Typedef('Money', Int, { minimum: 0, desc: 'Amount in cents' });
        expect(Money.coerce('-5')).toBe(-5);
        expect(reason(() => Money.coerce('x'))).toBe('validation_failed: $: expected Money, got "x"');
        expect(Str.describe('Title').annotate({ maxLength: 1 }).coerce(55)).toBe('55');
        expect(Struct('Price', { amount: Money }).coerce({ amount: '12.0' })).toEqual({ amount: 12 });
        expect(reason(() => Struct('Price', { amount: Money }).coerce({ amount: '12.5' }))).toBe('validation_failed: $.amount: expected Money, got 12.5');
        expect(t.List(t.Int).coerce('["1"]')).toEqual([1]);
    });
});

describe('static inference', () => {
    it('derives TypeScript types from builders', () => {
        const Line = Struct('Line', { description: Str, quantity: Int, unit: Enum('kg', 'pc'), note: Nullable(Str) });
        const Invoice = Struct('Invoice', { lines: List(Line), paid: Bool }).field('total', Float);
        type Invoice = Infer<typeof Invoice>;
        expectTypeOf<Invoice>().toEqualTypeOf<{
            lines: { description: string; quantity: number; unit: 'kg' | 'pc'; note: string | null }[];
            paid: boolean;
            total: number;
        }>();
        expectTypeOf(Union(Int, Str).parse(1)).toEqualTypeOf<number | string>();
        const Named = Struct('Named', { name: Str }).methods({ greet() { return `Hi ${this.name}`; } });
        expectTypeOf(Named.parse({ name: 'x' }).greet()).toEqualTypeOf<string>();
        expectTypeOf(Typedef('Money', Int).parse(1)).toEqualTypeOf<number>();
        expectTypeOf<Infer<typeof Dict>>().toEqualTypeOf<Record<string, unknown>>();
        expectTypeOf<Infer<typeof Nil>>().toEqualTypeOf<null>();
    });

    it('gives coerce the same result type as parse', () => {
        const Line = Struct('Line', { description: Str, quantity: Int, unit: Enum('kg', 'pc'), note: Nullable(Str) });
        expectTypeOf(Line.coerce).returns.toEqualTypeOf<{ description: string; quantity: number; unit: 'kg' | 'pc'; note: string | null }>();
        expectTypeOf(Line.coerce).returns.toEqualTypeOf<ReturnType<typeof Line.parse>>();
        expectTypeOf(Int.coerce('3')).toEqualTypeOf<number>();
        expectTypeOf(Bool.coerce('1')).toEqualTypeOf<boolean>();
        expectTypeOf(Str.coerce(1)).toEqualTypeOf<string>();
        expectTypeOf(List(Union(Str, Int)).coerce('[]')).toEqualTypeOf<(string | number)[]>();
        expectTypeOf(Nullable(Float).coerce('null')).toEqualTypeOf<number | null>();
        expectTypeOf(Any.coerce('1')).toEqualTypeOf<unknown>();
        const Named = Struct('Named', { name: Str }).methods({ greet() { return `Hi ${this.name}`; } });
        expectTypeOf(Named.coerce({ name: 'x' }).greet()).toEqualTypeOf<string>();
        expectTypeOf(JsonSchema<number>({ type: 'integer' }).coerce('1')).toEqualTypeOf<number>();
    });
});
