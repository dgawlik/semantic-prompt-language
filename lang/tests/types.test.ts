import { describe, expect, it, vi } from 'vitest';
import { callMethod } from '../src/builtins.js';
import { run } from '../src/interpreter.js';
import { Logger } from '../src/logger.js';
import { parse } from '../src/parser.js';
import { aliasType, contractOf, convertFloat, convertInt, descriptor, equivalent, primitives, testValue, typedFloat, validateType, validateValue } from '../src/types.js';
import { compareValues, encodeJson, isInstance, newDict, type Value } from '../src/values.js';
import type { LlmBackend, LlmRequest } from '../src/llm.js';

const int = primitives.get('int')!;
const str = primitives.get('str')!;
const ints = descriptor('list', 'list[int]', { element: int });
const strings = descriptor('list', 'list[str]', { element: str });
const logger = () => new Logger('silent');
const execute = (source: string, answers: string[] = []) => {
    const call = vi.fn(async (_request: LlmRequest) => ({ text: answers.shift() ?? '', effective: {} }));
    const backend: LlmBackend = { call, close: async () => {} };
    return { result: run(parse(source), { backend, logger: logger() }), call };
};

describe('runtime type contracts', () => {
    const person = descriptor('class', 'Person', { fields: {
        name: { type: str, advice: {} }, age: { type: int, advice: {} },
    }, methods: {} });

    it('converts structural data only through explicit validation and copies the class fields', () => {
        const shape = descriptor('struct', 'struct(Person)', { fields: person.fields });
        const input = newDict([['name', 'Ada'], ['age', 37n]]);
        validateValue(input, shape);
        expect(testValue(input, person)).toBe(false);
        expect(() => validateValue(input, person)).toThrow(/expected Person/);
        const result = validateType(input, person);
        expect(isInstance(result)).toBe(true);
        if (!isInstance(result)) throw new Error('expected a Person instance');
        expect(result.descriptor).toBe(person);
        expect(result.fields).toEqual(input);
        expect(result.fields).not.toBe(input);
        expect(contractOf(input)).toBe(shape);
        expect(validateType(result, person)).toBe(result);
        expect(testValue(result, person)).toBe(true);
        callMethod(result.fields, 'update', [newDict([['age', 38n]])]);
        expect(input.age).toBe(37n);
        expect(() => callMethod(result.fields, 'update', [newDict([['age', 38]])])).toThrow(/expected int/);
    });

    it.each<{ input: Value; reason: RegExp }>([
        { input: newDict([['name', 'Ada']]), reason: /\$\.age: missing required field/ },
        { input: newDict([['name', 'Ada'], ['age', 37]]), reason: /\$\.age: expected int/ },
        { input: newDict([['name', 'Ada'], ['age', 37n], ['extra', true]]), reason: /\$\.extra:.*extra field/ },
        { input: 'Ada', reason: /expected Person/ },
    ])('rejects invalid class field data $input', ({ input, reason }) => {
        expect(() => validateType(input, person)).toThrow(reason);
    });

    it('converts nested records and lists while leaving their structural input intact', () => {
        const input = [newDict([['name', 'Ada'], ['age', 37n]])];
        const sourceType = descriptor('list', 'list[struct(Person)]', { element: descriptor('struct', 'struct(Person)', { fields: person.fields }) });
        validateValue(input, sourceType);
        const target = descriptor('list', 'list[Person]', { element: person });
        const output = validateType(input, target);
        expect(output).not.toBe(input);
        expect(output).toMatchObject([{ __instance: true, fields: input[0] }]);
        expect(isInstance(input[0])).toBe(false);
        expect(contractOf(input)).toBe(sourceType);
        expect(() => callMethod(output, 'append', [input[0]])).toThrow(/expected Person/);
    });

    it('leaves no contracts or changes after a failed class conversion', () => {
        const items: Value[] = [];
        const type = descriptor('class', 'Data', { fields: {
            items: { type: ints, advice: {} }, name: { type: str, advice: {} },
        } });
        const input = newDict([['items', items], ['name', 1]]);
        expect(() => validateType(input, type)).toThrow(/\$\.name: expected str/);
        expect(contractOf(items)).toBeUndefined();
        callMethod(items, 'append', ['still dynamic']);
        expect(input).toEqual({ items: ['still dynamic'], name: 1 });
    });

    it('rejects ambiguous class conversions and preserves nullable and equivalent targets', () => {
        const other = descriptor('class', 'Other', { fields: person.fields });
        const input = newDict([['name', 'Ada'], ['age', 37n]]);
        for (const members of [[person, other], [person, primitives.get('object')!]]) {
            expect(() => validateType(input, descriptor('union', 'ambiguous', { members }))).toThrow(/ambiguous/);
            expect(contractOf(input)).toBeUndefined();
        }
        const optional = descriptor('union', 'Person | None', { members: [person, primitives.get('None')!] });
        expect(validateType(null, optional)).toBeNull();
        expect(isInstance(validateType(input, optional))).toBe(true);
        const alias = aliasType(person, { desc: 'Person advice' });
        expect(isInstance(validateType(input, descriptor('union', 'Person aliases', { members: [person, alias] })))).toBe(true);
    });

    it('keeps aliased contracts equivalent while merging advice', () => {
        const money = aliasType(int, { minimum: 0, desc: 'Cents' });
        const price = aliasType(money, { desc: 'Price' });
        expect(equivalent(price, int)).toBe(true);
        expect(price.advice).toEqual({ minimum: 0, desc: 'Price' });
        expect(money.advice).toEqual({ minimum: 0, desc: 'Cents' });
        expect(int.advice).toBeUndefined();
        expect(testValue(-1n, price)).toBe(true);
        expect(testValue(1, price)).toBe(false);
    });

    it('uses exact, finite explicit conversion and mathematical numeric ordering', () => {
        expect(convertInt('9223372036854775807')).toBe(9223372036854775807n);
        expect(() => convertInt(1.1)).toThrow(/exact/);
        expect(() => convertInt(true)).toThrow();
        expect(() => convertInt('9223372036854775808')).toThrow(/overflow/);
        expect(() => convertFloat(Infinity)).toThrow(/finite/);
        expect(compareValues(9007199254740993n, typedFloat(9007199254740992))).toBe(1);
        expect(convertFloat(9007199254740993n)).toEqual(typedFloat(9007199254740992));
    });

    it('checks Unicode scalars, not UTF-16 units or graphemes', () => {
        const char = primitives.get('char')!;
        expect(testValue('😀', char)).toBe(true);
        expect(testValue('e\u0301', char)).toBe(false);
        expect(testValue('\uD800', char)).toBe(false);
        expect(testValue('', char)).toBe(false);
        expect(testValue(true, int)).toBe(false);
        expect(testValue(1, int)).toBe(false);
    });

    it('guards untyped aliases and makes bulk operations atomic', () => {
        const list: Value[] = [1n];
        expect(validateValue(list, ints)).toBe(list);
        const alias = list;
        expect(() => callMethod(alias, 'append', ['bad'])).toThrow();
        expect(() => callMethod(alias, 'extend', [[2n, 'bad']])).toThrow();
        expect(list).toEqual([1n]);
        callMethod(alias, 'extend', [[2n, 3n]]);
        expect(list).toEqual([1n, 2n, 3n]);
        expect(testValue(list, strings)).toBe(false);
    });

    it('installs successful tests atomically and failed tests leave no child contracts', () => {
        const child: Value[] = [];
        const record = newDict([['items', child], ['name', 1]]);
        const shape = descriptor('struct', 'Shape', { fields: {
            items: { type: ints, advice: {} }, name: { type: str, advice: {} },
        } });
        expect(testValue(record, shape)).toBe(false);
        callMethod(child, 'append', ['still dynamic']);
        expect(child).toEqual(['still dynamic']);
        const empty: Value[] = [];
        expect(testValue(empty, ints)).toBe(true);
        expect(testValue(empty, strings)).toBe(false);
        expect(() => callMethod(empty, 'append', ['bad'])).toThrow();
    });

    it('protects exact required record fields and atomic update/delete', () => {
        const shape = descriptor('struct', 'Shape', { fields: { name: { type: str, advice: {} } } });
        const record = newDict([['name', 'x']]);
        validateValue(record, shape);
        expect(() => callMethod(record, 'update', [newDict([['name', 'valid'], ['extra', true]])])).toThrow(/extra/);
        expect(record).toEqual({ name: 'x' });
        expect(() => callMethod(record, 'pop', ['name'])).toThrow(/required/);
        expect(() => callMethod(record, 'clear', [])).toThrow(/required/);
        expect(record).toEqual({ name: 'x' });
    });

    it('keeps runtime representation markers distinct from user dictionary data', () => {
        expect(testValue(newDict([['__float', 1]]), primitives.get('float')!)).toBe(false);
        expect(testValue(newDict([['__type', true], ['kind', 'int'], ['name', 'int']]), primitives.get('object')!)).toBe(true);
        const callable = descriptor('fn', 'fn() -> str', { params: [], result: str });
        expect(testValue(newDict([['__fn', 'builtin'], ['name', 'fake']]), callable)).toBe(false);
    });
});

describe('typed execution', () => {
    it('validates structs into ordinary classes without running constructors and binds methods', async () => {
        const { result, call } = execute(`class Person:
    name: str
    age: int
    def Person(name: str, age: int):
        fail 'constructor must not run'
    def toString() -> str:
        return '{self.name} at age {self.age}'
type Alias = Person [desc='A person']
let input = ask(schema=struct(Person)) 'Generate a person'
let person: Person = validate(input, Alias)
let validateAlias = validate
let second: Person = validateAlias(input, Person)
let label: fn() -> str = person.toString
success [isinstance(input, Person), isinstance(person, Person), isinstance(second, Person), label(), second.toString()]`,
        ['{"name":"Ada","age":37}']);
        const outcome = await result;
        expect(outcome, outcome.status === 'failure' ? outcome.failure.reason : undefined).toMatchObject({
            status: 'success', value: [false, true, true, 'Ada at age 37', 'Ada at age 37'],
        });
        expect(call).toHaveBeenCalledOnce();
    });

    it('converts nested structural class fields, lists and nullable targets', async () => {
        const { result } = execute(`class Person:
    name: str
class Team:
    leader: Person
    members: list[Person]
    note: str | None
let PersonData = struct(Person)
struct TeamData:
    leader: PersonData
    members: list[PersonData]
    note: str | None
let input = ask(schema=TeamData) 'Generate team data'
let team: Team = validate(input, Team)
let members: list[Person] = validate(input.members, list[Person])
let optional: Person | None = validate(input.leader, Person | None)
success [isinstance(team, Team), isinstance(team.leader, Person), isinstance(team.members[0], Person), isinstance(members[0], Person), isinstance(optional, Person)]`,
        ['{"leader":{"name":"Ada"},"members":[{"name":"Grace"}],"note":null}']);
        const outcome = await result;
        expect(outcome, outcome.status === 'failure' ? outcome.failure.reason : undefined).toMatchObject({
            status: 'success', value: [true, true, true, true, true],
        });
    });

    it('retains guards for callable fields on converted instances', async () => {
        const { result } = execute(`class Handler:
    callback: fn(str) -> str
def bad(value):
    return 1
let input = object:
    'callback': bad
let handler: Handler = validate(input, Handler)
success (handler.callback)('value')`);
        expect(await result).toMatchObject({
            status: 'failure', failure: { status_code: 'type_error', reason: expect.stringContaining('return: expected str') },
        });
    });

    it('does not implicitly convert untyped JSON numbers during validation', async () => {
        const { result, call } = execute(`let result = ask(fmt='object') 'Sample person JSON'
struct Person:
    firstName: str
    lastName: str
    age: int
let person: Person = validate(result, Person)
success person`, ['{"firstName":"Ada","lastName":"Lovelace","age":37}']);
        expect(await result).toMatchObject({
            status: 'failure',
            failure: { status_code: 'type_error', reason: '$.age: expected int, got number', line: 6 },
        });
        expect(call).toHaveBeenCalledOnce();
    });

    it('appends schema-generated numeric union values without narrowing first', async () => {
        const { result, call } = execute(`type FloatOrInt = float | int [description='Either float or int']
let numbers: list[FloatOrInt] = []
for i in range(4):
    let num = ask(tokens=128, schema=FloatOrInt) 'Sample number'
    numbers.append(num)
for n in numbers:
    if isinstance(n, int):
        log('Integer: {n}')
    else:
        log('Float: {n}')
success numbers`, ['1', '1.5', '2', '2.5']);
        expect(await result).toMatchObject({
            status: 'success', value: [1n, typedFloat(1.5), 2n, typedFloat(2.5)],
        });
        expect(call).toHaveBeenCalledTimes(4);
    });

    it('uses integer aliases in arithmetic, conversions, functions, lists and generated schemas', async () => {
        const { result, call } = execute(`type Money = int [minimum=0, desc='Cents']
type Prices = list[Money]
type MaybeMoney = Money | None
def twice(value: Money) -> Money:
    return value + value
let values: Prices = [1250, 890]
let computed: Money = 0
for value in values:
    computed += twice(value)
let optional: MaybeMoney = None
let generated: Money = ask(schema=Money) 'Generate cents'
let converted = Money('10')
success [computed, generated, converted, type(computed), optional]`, ['-1']);
        expect(await result).toMatchObject({ status: 'success', value: [4280n, -1n, 10n, 'int', null] });
        expect(call).toHaveBeenCalledOnce();
        expect(call.mock.calls[0][0].prompt).toContain('Cents');
    });

    it('preserves class identity and constructors through metadata-bearing aliases', async () => {
        const { result } = execute(`hydratable class Item:
    value: int
    def Item(value: int):
        self.value = value
type Alias = Item [desc='Item data']
let original: Item = Item(1)
let aliased: Alias = original
let constructed: Item = Alias(2)
let decoded: Alias = ask(schema=Alias) 'Generate an item'
success [isinstance(original, Alias), isinstance(constructed, Item), isinstance(decoded, Item), decoded.value]`,
        ['{"value":3}']);
        expect(await result).toMatchObject({ status: 'success', value: [true, true, true, 3n] });
    });

    it('constructs distinct typed literals while keeping untyped bindings dynamic', async () => {
        const { result } = execute(`let n: int = 1
let f: float = 1.0
let dynamic = 2
dynamic = 'changed'
success [type(n), type(f), dynamic, json_stringify([n, f])]`);
        expect(await result).toMatchObject({ status: 'success', value: ['int', 'float', 'changed', '[1,1.0]'] });
    });

    it('retains contracts across aliases, indexing, captured bindings and mutators', async () => {
        const { result } = execute(`let values: list[int] = [1]
let alias = values
try:
    alias.extend(json_parse('[2, "bad"]'))
except error:
    pass
alias[0] = int(3)
def mutate():
    values.append(4)
mutate()
success values`);
        const outcome = await result;
        expect(outcome, outcome.status === 'failure' ? outcome.failure.reason : undefined).toMatchObject({ status: 'success', value: [3n, 4n] });
    });

    it('uses field metadata only as generation advice', async () => {
        const { result, call } = execute(`struct Data:
    title: str [min=2, max=10, desc='Title']
let data = ask(schema=Data) 'Generate data'
success data`, ['{"title":"x"}']);
        expect(await result).toMatchObject({ status: 'success', value: { title: 'x' } });
        expect(call).toHaveBeenCalledOnce();
    });

    it('repairs typed decoding overflow using the existing budget', async () => {
        const { result, call } = execute(`let n: int = ask(schema=int, repairs=1) 'Generate an integer'
success n`, ['9223372036854775808', '9223372036854775807']);
        expect(await result).toMatchObject({ status: 'success', value: 9223372036854775807n });
        expect(call).toHaveBeenCalledTimes(2);
    });

    it('guards unknown callable arguments/results and honors dictionary built-in precedence', async () => {
        const { result } = execute(`def echo(value):
    return value
let callback: fn(str) -> str = echo
let o = object:
    'pop': callback
    'stored': callback
    'data': 'x'
let read = o.pop('data')
let called = (o.pop)('property call')
let fallback = o.stored('fallback')
success [read, called, fallback]`);
        expect(await result).toMatchObject({ status: 'success', value: ['x', 'property call', 'fallback'] });
    });

    it('hydrates constructor-free opt-in classes and binds methods, but projects class schemas structurally', async () => {
        const { result, call } = execute(`hydratable class Person:
    name: str
    def Person(name: str):
        self.name = name.upper()
    def label() -> str:
        return self.name
let constructed = Person('ada')
let hydrated: Person = ask(schema=Person) 'Generate a person'
let data = ask(schema=struct(Person)) 'Generate data'
success [constructed.label(), hydrated.label(), isinstance(data, Person), object(hydrated)]`,
        ['{"name":"grace"}', '{"name":"data"}']);
        const outcome = await result;
        expect(outcome, outcome.status === 'failure' ? outcome.failure.reason : undefined).toMatchObject({ status: 'success', value: ['ADA', 'grace', false, { name: 'grace' }] });
        expect(call).toHaveBeenCalledTimes(2);
    });

    it('checks typed overflow and exact serialization of both int limits', async () => {
        const { result } = execute(`let lower: int = -9223372036854775808
let upper: int = 9223372036854775807
success json_stringify([lower, upper])`);
        expect(await result).toMatchObject({ status: 'success', value: '[-9223372036854775808,9223372036854775807]' });
        expect(encodeJson([convertInt('-9223372036854775808'), convertInt('9223372036854775807')])).toBe('[-9223372036854775808,9223372036854775807]');
    });

    it('guards narrowed callable views of known wider implementations and extracted functions', async () => {
        const { result } = execute(`enum Color = 'red' | 'blue'
def echo(text: str) -> str:
    return text
let callback: fn(Color) -> str = echo
let callbacks: list[fn(Color) -> str] = [echo]
let unknown = json_parse('"green"')
let rejected = 0
try:
    callback(unknown)
except error:
    rejected += 1
try:
    callbacks[0](unknown)
except error:
    rejected += 1
let extracted = callbacks.pop()
try:
    extracted(unknown)
except error:
    rejected += 1
success [rejected, callback('red')]`);
        const outcome = await result;
        expect(outcome, outcome.status === 'failure' ? outcome.failure.reason : undefined).toMatchObject({ status: 'success', value: [3, 'red'] });
    });

    it('contextualizes nullable containers and grouped signed integer literals', async () => {
        const { result } = execute(`struct Count:
    value: int
let record: Count | None = object:
    'value': 1
let numbers: list[int] | None = [1, 2]
let minimum: int = -(9223372036854775808)
success json_stringify([record, numbers, minimum])`);
        const outcome = await result;
        expect(outcome, outcome.status === 'failure' ? outcome.failure.reason : undefined).toMatchObject({
            status: 'success', value: '[{"value":1},[1,2],-9223372036854775808]',
        });
    });

    it('does not invoke repairs for ordinary typed call or assignment failures', async () => {
        const { result, call } = execute(`let value: int = ask(schema=int, repairs=5) 'Generate an integer'
value = json_parse('"bad"')
success value`, ['1', '2', '3']);
        const outcome = await result;
        expect(outcome).toMatchObject({ status: 'failure', failure: { status_code: 'type_error', line: 2 } });
        expect(call).toHaveBeenCalledOnce();
    });

    it('evaluates inline dictionary functions in property entry order', async () => {
        const { result } = execute(`let o = object:
    def x() -> str:
        return 'function'
    'x': 'last entry'
let p = object:
    'x': 'first entry'
    def x() -> str:
        return 'function'
success [o.x, p.x()]`);
        const outcome = await result;
        expect(outcome, outcome.status === 'failure' ? outcome.failure.reason : undefined).toMatchObject({ status: 'success', value: ['last entry', 'function'] });
    });
});
