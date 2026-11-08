import { describe, expect, it, vi } from 'vitest';
import { ExecutionSession, run } from '../src/interpreter.js';
import { Logger } from '../src/logger.js';
import { parse } from '../src/parser.js';
import { checkProgram } from '../src/type-check.js';
import type { Env, Value } from '../src/values.js';
import { NoLlm } from './helpers.js';

async function exec(source: string) {
    const backend = new NoLlm();
    const call = vi.spyOn(backend, 'call');
    const result = await run(parse(source), { backend, logger: new Logger('silent'), cwd: process.cwd() });
    return { result, call };
}

async function rejectsBeforeModel(source: string, reason?: string) {
    const { result, call } = await exec(`let earlier = ask 'This must never execute'\n${source}`);
    expect(call).not.toHaveBeenCalled();
    expect(result.status).toBe('failure');
    if (result.status !== 'failure') throw new Error('expected a type failure');
    expect(result.failure.status_code).toBe('type_error');
    expect(result.failure.line).toBeGreaterThan(1);
    expect(result.failure.command).not.toBe('');
    if (reason) expect(result.failure.reason).toContain(reason);
}

describe('static typed preflight', () => {
    it.each([
        'type Money = Missing',
        'type Money = Money',
        "let Money = 1\ntype Money = int",
        'type Money = int\ntype Money = float',
        'type Money = int\nMoney = float',
        'type Money = int\nlet amount: Money = 1.5',
        'type Money = int\nlet amount: Money = Money(1.5)',
        'type Money = int\nlet amount: Money = 1\nlet dynamic = 0\ndynamic += amount',
    ])('rejects alias contract violations before model calls: %s', async source => {
        await rejectsBeforeModel(source);
    });

    it('defensively rejects malformed advice on an externally supplied alias AST', () => {
        const program = parse('type Money = int');
        const declaration = program.body[0];
        if (declaration.t !== 'type-alias') throw new Error('expected alias');
        declaration.advice.desc = 1;
        expect(() => checkProgram(program)).toThrow("malformed metadata for type alias 'Money'");
    });

    it.each([
        'if True:\n    pass',
        'if False:\n    pass\nelse:\n    pass',
        'for item in []:\n    pass',
        'while False:\n    pass',
        'try:\n    pass\nexcept error:\n    pass',
    ])('retains primitive and declared types after control-flow joins: %s', async flow => {
        const source = `enum Severity = 'low' | 'high'
struct Data:
    count: int
hydratable class Item:
    count: int
let Integer = int
type Cents = int [desc='Amount in cents']
${flow}
struct Money:
    amount: int
    ratio: float
    label: str
    letter: char
    active: bool
    missing: None
    data: object
    counts: list[Integer]
    severity: Severity
    record: Data
    item: Item
def identity(value: Integer) -> Integer:
    return value
let count: Integer = 15
let cents: Cents = 42
success [count, cents]`;
        expect(() => checkProgram(parse(source))).not.toThrow();
        const { result } = await exec(source);
        expect(result).toMatchObject({ status: 'success', value: [15n, 42n] });
    });

    it('retains callable contracts after control-flow joins before any model calls', async () => {
        await rejectsBeforeModel(`def consume(value: int):
    pass
if True:
    pass
consume('wrong')`, 'argument');
    });

    it.each(["'not a type'", 'float'])('does not retain descriptor aliases changed on one control-flow path: %s', replacement => {
        expect(() => checkProgram(parse(`let Alias = int
if condition:
    Alias = ${replacement}
let value: Alias = 1`))).toThrow(/not a declared type/);
    });

    it.each([
        'let count: int = 1.0',
        'let ratio: float = 1',
        "let title: str = 2.0",
        'let truth: int = True',
        "let letter: char = 'ab'",
        "let letter: char = 'é'",
        'let count: int = 9223372036854775808',
        'let count: int = -9223372036854775809',
        'let count: int = 9223372036854775807 + 1',
        'let count: int = int(1.5)',
        'let fraction = 1 + 0.5\nlet count: int = int(fraction)',
        "let text = 'a' + 'b'\nlet letter: char = text",
        "enum Color = 'red' | 'blue'\nlet color: Color = 'green'",
    ])('rejects a known literal contract before an earlier ask: %s', async source => {
        await rejectsBeforeModel(source);
    });

    it.each([
        `def bad() -> int:
    return 'wrong'`,
        `def bad(flag: bool) -> int:
    if flag:
        return 1
    return 'wrong'`,
        `def bad() -> str:
    'not an implicit return'`,
        `if False:
    let bad: int = 'wrong'`,
        `while False:
    let bad: int = 'wrong'`,
        `def consume(value: int):
    pass
consume('wrong')`,
        `def consume(value: int):
    pass
consume(1, 2)`,
        `let value: int | str = 1
let invalid = value + 1`,
        `let integer: int = 1
let fraction: float = 1.0
let invalid = integer + fraction`,
        `let legacy = 1
let integer: int = 2
let invalid = integer + legacy`,
        `let values: list[int] = [1]
let invalid = values + ['wrong']`,
        `let integer: int = -9223372036854775808
let invalid = integer // -1`,
        `let value: float = 1.0 / 0.0`,
    ])('checks nested contracts, signatures and typed operators: %s', async source => {
        await rejectsBeforeModel(source);
    });

    it.each([
        `let items: list[int] = [1]
items[0] = 'wrong'`,
        `let items: list[int] = []
let alias = items
alias.append('wrong')`,
        `let items: list[int] = []
items.extend([1, 'wrong'])`,
        `let items: list[int] = []
items.insert(0, 'wrong')`,
        `let items: list[int] = []
let incompatible: list[str] = items`,
        `let legacy = [1]
let items: list[int] = legacy`,
        `struct Data:
    name: str
    optional: str | None
let data: Data = object:
    'name': 'Ada'`,
        `struct Data:
    name: str
let data: Data = object:
    'name': 'Ada'
    'extra': True`,
        `struct Data:
    name: str
let data: Data = object:
    'name': 'Ada'
let alias = data
alias.name = 1`,
        `struct Data:
    name: str
let data: Data = object:
    'name': 'Ada'
data.extra = 'wrong'`,
        `struct Data:
    name: str
let data: Data = object:
    'name': 'Ada'
data.clear()`,
        `struct Data:
    count: int
let data: Data = object:
    'count': 1
data.update(object:
    'count': 'wrong'
)`,
    ])('checks exact fields, aliases and mutation arguments: %s', async source => {
        await rejectsBeforeModel(source);
    });

    it.each([
        `struct Handler:
    callback: fn(str) -> str
def incompatible(value: int) -> str:
    return 'x'
let handler: Handler = object:
    'callback': incompatible`,
        `struct Handler:
    callback: fn(str) -> str
def incompatible(value: str) -> int:
    return 1
let handler: Handler = object:
    'callback': incompatible`,
        `let callback: fn(str) -> str = object()`,
        `let value: Later = 'x'
enum Later = 'x'`,
        `struct Recursive:
    child: Recursive`,
        `let duplicate = 1
enum duplicate = 'x'`,
    ])('rejects signature, declaration-order and namespace violations: %s', async source => {
        await rejectsBeforeModel(source);
    });

    it('defensively rejects duplicate fields in an externally supplied AST', () => {
        const program = parse(`struct Duplicate:
    value: str`);
        const declaration = program.body[0];
        if (declaration.t !== 'struct') throw new Error('expected struct');
        declaration.fields.push(declaration.fields[0]);
        expect(() => checkProgram(program)).toThrow("duplicate field 'value'");
    });

    it.each([
        `class Person:
    name: str
let person = ask(schema=Person) 'Generate'`,
        `struct Handler:
    callback: fn(str) -> str
let handler = ask(schema=Handler) 'Generate'`,
        `class Person:
    name: str
let person: Person = ask(schema=struct(Person)) 'Generate'`,
    ])('rejects unsupported or incompatible explicit schema targets: %s', async source => {
        await rejectsBeforeModel(source);
    });

    it('preserves dynamic reassignment and purely untyped runtime operations', async () => {
        const { result, call } = await exec(`let value = 1
value = 'different'
let values = []
values.append(True)
success [value, values]`);
        expect(call).not.toHaveBeenCalled();
        expect(result).toMatchObject({ status: 'success', value: ['different', [true]] });
        expect(() => checkProgram(parse("let invalid = 'str' + 1"))).not.toThrow();
        expect(() => checkProgram(parse("let value: int = unknownFunction()"))).not.toThrow();
    });

    it('accepts typed numeric contexts, limits, Unicode scalars and advisory metadata', async () => {
        const { result, call } = await exec(`struct Data:
    name: str [min=20, max=30, desc='Advice only']
    count: int
let low: int = -9223372036854775808
let high: int = 9223372036854775807
let letter: char = '😀'
let data: Data = object:
    'name': 'x'
    'count': 1
let values: list[int] = [1, 2]
values.append(3)
success [low, high, letter, data.count, values]`);
        expect(call).not.toHaveBeenCalled();
        expect(result).toMatchObject({ status: 'success', value: [-9223372036854775808n, 9223372036854775807n, '😀', 1n, [1n, 2n, 3n]] });
    });

    it('checks the final sign of grouped and chained numeric literals', async () => {
        const { result } = await exec(`let grouped: int = -(9223372036854775808)
let chained: int = -(-(-9223372036854775808))
success [grouped, chained]`);
        expect(result).toMatchObject({ status: 'success', value: [-9223372036854775808n, -9223372036854775808n] });
        await rejectsBeforeModel('let value: int = +(9223372036854775808)');
        await rejectsBeforeModel('let value: int = -(-9223372036854775808)');
    });

    it('accepts contravariant parameters, covariant returns and class self signatures', () => {
        expect(() => checkProgram(parse(`enum Color = 'red' | 'blue'
def broad(value: str) -> Color:
    return 'red'
let callback: fn(Color) -> str = broad
class Person:
    name: str
    def Person(name: str):
        self.name = name
    def same(other: Person) -> Person:
        return other
let person = Person('Ada')
let same: Person = person.same(person)`))).not.toThrow();
    });

    it('narrows unions across branches and keeps stable snapshots across calls', () => {
        expect(() => checkProgram(parse(`def describe(value: int | str) -> str:
    if isinstance(value, str):
        let snapshot = value
        arbitrary()
        return snapshot
    return 'integer'`))).not.toThrow();
        expect(() => checkProgram(parse(`def increment(value: int | str) -> int:
    if isinstance(value, int):
        return value + 1
    return 0`))).not.toThrow();
        expect(() => checkProgram(parse(`def increment(value: int | str) -> int:
    if isinstance(value, str):
        return 0
    return value + 1`))).not.toThrow();
    });

    it('checks typed built-in methods while keeping inferred containers dynamically mutable', async () => {
        const { result, call } = await exec(`class Person:
    name: str
    def Person(name: str):
        self.name = name.upper()
let person = Person('Ada')
let text: str = person.name.lower().replace('a', 'b')
let words = text.split()
words.append(1)
success [person.name, text, words]`);
        expect(call).not.toHaveBeenCalled();
        expect(result).toMatchObject({ status: 'success', value: ['ADA', 'bdb', ['bdb', 1]] });
        await rejectsBeforeModel(`let text: str = 'hello'
text.replace(1, 'x')`);
        await rejectsBeforeModel(`let values: list[int] = []
def change():
    values.append('wrong')`);
    });

    it('accepts nullable literal containers and covariant bulk reads', async () => {
        const { result, call } = await exec(`struct Data:
    count: int
let data: Data | None = object:
    'count': 1
let values: list[int] | None = [1, 2]
enum Color = 'red' | 'blue'
let colors: list[Color] = ['red']
let strings: list[str] = []
strings.extend(colors)
success [data, values, strings]`);
        expect(call).not.toHaveBeenCalled();
        expect(result).toMatchObject({ status: 'success', value: [{ count: 1n }, [1n, 2n], ['red']] });
    });

    it('checks inferred mutable contents without imposing an untyped contract', async () => {
        await rejectsBeforeModel(`let values = []
values.append('wrong')
let typed: list[int] = values`);
        expect(() => checkProgram(parse(`let values = dynamicList()
let typed: list[int] = values`))).not.toThrow();
        expect(() => checkProgram(parse(`let values = []
arbitrary(values)
let typed: list[int] = values`))).not.toThrow();
    });

    it('preserves prior untyped cells but rejects conflicts in the current program', async () => {
        const session = new ExecutionSession();
        const options = { backend: new NoLlm(), logger: new Logger('silent') };
        await session.run(parse(`let value = 1
def previous():
    return 'old'
let saved = previous`), options);
        expect(await session.run(parse(`let value = 'new'
def previous():
    return 'new'
success [value, saved(), previous()]`), options)).toMatchObject({ status: 'success', value: ['new', 'old', 'new'] });
        expect(await session.run(parse('let duplicate = 1\nlet duplicate = 2'), options)).toMatchObject({ status: 'failure', failure: { status_code: 'type_error' } });
        await session.run(parse('let typed: int = 1'), options);
        expect(await session.run(parse("let typed = 'wrong'"), options)).toMatchObject({ status: 'failure', failure: { status_code: 'type_error' } });
    });

    it('does not execute getters or proxy traps while inspecting supplied globals', () => {
        const getter = vi.fn(() => 'secret');
        const value: Record<string, Value> = {};
        Object.defineProperty(value, 'field', { enumerable: true, get: getter });
        const trap = vi.fn(() => { throw new Error('unexpected proxy operation'); });
        const proxy = new Proxy({}, { get: trap, ownKeys: trap, getPrototypeOf: trap });
        const globals: Env = { vars: new Map([['value', value], ['proxy', proxy]]) };
        expect(() => checkProgram(parse("let output: str = value.field"), globals)).not.toThrow();
        expect(getter).not.toHaveBeenCalled();
        expect(trap).not.toHaveBeenCalled();
    });

    it('keeps type declarations read-only while allowing untyped descriptor aliases to change', async () => {
        await rejectsBeforeModel("enum Color = 'red'\nColor = 'red'");
        const { result } = await exec('let alias = int\nalias = 1\nsuccess alias');
        expect(result).toMatchObject({ status: 'success', value: 1 });
    });

    it('infers typed numeric builtin results and independent projected contracts', async () => {
        const { result } = await exec(`let values: list[int] = [1, 2]
let total: int = sum(values)
let magnitude: int = abs(-total)
let source: list[int] = []
let record = object:
    'values': source
let projected = object(record)
let independent: list[str] = projected.values
independent.append('new')
success [total, magnitude, source, independent]`);
        expect(result).toMatchObject({ status: 'success', value: [3n, 3n, [], ['new']] });
        await rejectsBeforeModel('let value: int = abs(int(-9223372036854775808))');
    });

    it('defers unknown string membership checks and requires union member narrowing', () => {
        expect(() => checkProgram(parse(`enum Color = 'RED'
let text: str = unknown()
let color: Color = text
let letter: char = text.upper()`))).not.toThrow();
        expect(() => checkProgram(parse(`struct Data:
    name: str
let data: Data | None = object:
    'name': 'Ada'
let invalid = data.name`))).toThrow('does not have member');
    });

    it('accepts compatible class constructor callables and enforces the view signature', async () => {
        const { result } = await exec(`class Person:
    name: str
    def Person(name: str):
        self.name = name
let factory: fn(str) -> Person = Person
let person = factory('Ada')
success object(person)`);
        expect(result).toMatchObject({ status: 'success', value: { name: 'Ada' } });
        await rejectsBeforeModel(`class Person:
    name: str
    def Person(name: str):
        self.name = name
let factory: fn(str) -> Person = Person
factory(1)`);
    });

    it('infers ordered dictionary entries with last-key-wins function properties', async () => {
        const { result, call } = await exec(`let first = object:
    def x(value: int) -> str:
        return 'function'
    'x': 'last'
let last: str = first.x
let second = object:
    'x': 'first'
    def x(value: str) -> str:
        return value
let callback: fn(str) -> str = second.x
success [last, callback('last function')]`);
        expect(call).not.toHaveBeenCalled();
        expect(result).toMatchObject({ status: 'success', value: ['last', 'last function'] });
    });

    it('checks inline function signatures and captures ordinary lexical names', async () => {
        const { result, call } = await exec(`let x: str = 'lexical'
let container = object:
    'x': 'field'
    def read() -> str:
        return x
success container.read()`);
        expect(call).not.toHaveBeenCalled();
        expect(result).toMatchObject({ status: 'success', value: 'lexical' });
        await rejectsBeforeModel(`struct Handler:
    callback: fn(str) -> str
let handler: Handler = object:
    def callback(value: int) -> str:
        return 'wrong signature'`);
        await rejectsBeforeModel(`let container = object:
    def bad() -> int:
        return 'wrong return'`);
    });

    it('validates only the final property against its enclosing record contract', async () => {
        const { result } = await exec(`struct Handler:
    callback: fn(str) -> str
let handler: Handler = object:
    def callback(value: int) -> str:
        return 'overwritten'
    def callback(value: str) -> str:
        return value
success handler.callback('final')`);
        expect(result).toMatchObject({ status: 'success', value: 'final' });
    });

    it('invalidates locally captured narrowing but not uncaptured scalar snapshots', async () => {
        await rejectsBeforeModel(`def use(value: int | str) -> str:
    def change():
        value = 1
    if isinstance(value, str):
        change()
        return value`);
        await rejectsBeforeModel(`let callback: fn(str) -> str | None = None
callback('x')`);
    });

    it('invalidates captured and member-path narrowing after arbitrary calls', async () => {
        await rejectsBeforeModel(`let value: int | str = 1
def use() -> str:
    if isinstance(value, str):
        arbitrary()
        return value`);
        await rejectsBeforeModel(`struct Data:
    value: int | str
def use(data: Data) -> str:
    if isinstance(data.value, str):
        arbitrary()
        return data.value`);
    });

    it('invalidates a narrowed binding after reassignment', async () => {
        await rejectsBeforeModel(`def use(value: int | str) -> str:
    if isinstance(value, str):
        value = 1
        return value`);
    });

    it('does not consult or change a store when preflight fails', async () => {
        const store = { load: vi.fn(() => ({})), save: vi.fn() };
        const backend = new NoLlm();
        const call = vi.spyOn(backend, 'call');
        const result = await run(parse("let bad: int = 'wrong'"), { backend, store, logger: new Logger('silent'), cwd: process.cwd() });
        expect(result.status).toBe('failure');
        expect(call).not.toHaveBeenCalled();
        expect(store.load).not.toHaveBeenCalled();
        expect(store.save).not.toHaveBeenCalled();
    });
});
