import { describe, expect, it } from 'vitest';
import { SplSyntaxError } from '../src/errors.js';
import { tokenize } from '../src/lexer.js';
import { parse } from '../src/parser.js';

const bad = (source: string, message: RegExp) => {
    expect(() => parse(source)).toThrow(SplSyntaxError);
    expect(() => parse(source)).toThrow(message);
};

describe('parser: typed declarations', () => {
    it('parses transparent aliases with optional advice without reserving type()', () => {
        const program = parse(`type Money = int [minimum=0, desc='Amount in cents']
type Amounts = list[Money]
type Optional = Money | None []
type Callback = fn(Money) -> Money
type(1)
let type = fn(str) -> str`);
        expect(program.body[0]).toMatchObject({
            t: 'type-alias', name: 'Money', type: { t: 'type-name', name: 'int' },
            advice: { minimum: 0, desc: 'Amount in cents' },
        });
        expect(program.body[1]).toMatchObject({ t: 'type-alias', type: { t: 'type-list' }, advice: {} });
        expect(program.body[2]).toMatchObject({ t: 'type-alias', type: { t: 'type-union' }, advice: {} });
        expect(program.body[3]).toMatchObject({ t: 'type-alias', type: { t: 'type-fn' } });
        expect(program.body[4]).toMatchObject({ t: 'expr', e: { t: 'call', callee: { name: 'type' } } });
        expect(program.body[5]).toMatchObject({ t: 'let', name: 'type' });
    });

    it.each([
        ['type Money = int [desc=1]', /must be a string/],
        ['type Money = int [min=True]', /must be a number/],
        ['type Money = int [minimum=abs(0)]', /compile-time/],
        ['type Money = int [minimum=0, minimum=1]', /duplicate/],
        ['type Money = 1', /type name/],
        ['type Money int', /expected '='/],
    ])('rejects malformed type alias %s', (source, message) => {
        bad(source as string, message as RegExp);
    });

    it('parses primitive, named, list, union, and callable annotations', () => {
        const program = parse(`let count: int = 1
let ratio: float = 1.0
let optional: PersonData | None = None
let matrix: list[list[int | str]] = []
let callback: fn(str, int) -> str | None = f`);
        expect(program.body[0]).toMatchObject({
            annotation: { t: 'type-name', name: 'int', line: 1 },
            value: { t: 'num', raw: '1' },
        });
        expect(program.body[1]).toMatchObject({ value: { t: 'num', raw: '1.0' } });
        expect(program.body[2]).toMatchObject({ annotation: {
            t: 'type-union', members: [{ name: 'PersonData' }, { name: 'None' }],
        } });
        expect(program.body[3]).toMatchObject({ annotation: {
            t: 'type-list', element: { t: 'type-list', element: { t: 'type-union' } },
        } });
        expect(program.body[4]).toMatchObject({ annotation: {
            t: 'type-fn', params: [{ name: 'str' }, { name: 'int' }], result: { t: 'type-union' },
        } });
    });

    it('retains exact numeric spellings before JavaScript rounding', () => {
        const tokens = tokenize('9223372036854775807 1.0 1e3');
        expect(tokens.filter(token => token.type === 'num').map(token => token.raw))
            .toEqual(['9223372036854775807', '1.0', '1e3']);
        expect(parse('let limit: int = -9223372036854775808').body[0]).toMatchObject({
            value: { t: 'unary', op: '-', e: { t: 'num', raw: '9223372036854775808' } },
        });
    });

    it('retains partial parameter annotations and optional returns', () => {
        const program = parse(`def repeat(text: str, count: int) -> str:
    return text * count
def partial(a, b: int, c):
    return b
def dynamic(a):
    return a`);
        expect(program.body[0]).toMatchObject({
            params: ['text', 'count'], paramTypes: [{ name: 'str' }, { name: 'int' }],
            returnType: { name: 'str' },
        });
        expect(program.body[1]).toMatchObject({
            params: ['a', 'b', 'c'], paramTypes: [undefined, { name: 'int' }, undefined],
        });
        expect(program.body[2]).not.toHaveProperty('paramTypes');
        expect(program.body[2]).not.toHaveProperty('returnType');
    });

    it('supports multiline signatures and grouped unions', () => {
        const program = parse(`def handle(
         value: (int | str),
  callback: fn(
       str,
       list[int],
   ) -> None,
        ) -> list[str | None]:
    return []`);
        expect(program.body[0]).toMatchObject({
            paramTypes: [{ t: 'type-union' }, { t: 'type-fn' }],
            returnType: { t: 'type-list' },
        });
    });

    it('parses enums and structural field declarations with advice', () => {
        const program = parse(`enum Color = 'red' | 'green' | 'blue'
struct Address:
    line1: str
    line2: str | None
    postalCode: str
struct PersonData:
    firstName: str [min=1, max=10, desc='First Name']
    lastName: str [min=2, max=10, desc='Family Name']
    age: int
    address: Address
struct Handler:
    callback: fn(str, int) -> str`);
        expect(program.body[0]).toMatchObject({ t: 'enum', name: 'Color', values: ['red', 'green', 'blue'] });
        expect(program.body[1]).toMatchObject({
            t: 'struct', fields: [{ name: 'line1' }, { name: 'line2', type: { t: 'type-union' } }, { name: 'postalCode' }],
        });
        expect(program.body[2]).toMatchObject({
            fields: expect.arrayContaining([{ name: 'firstName', type: { t: 'type-name', name: 'str', line: 7 },
                advice: { min: 1, max: 10, desc: 'First Name' }, line: 7 }]),
        });
        expect(program.body[3]).toMatchObject({ fields: [{ type: { t: 'type-fn' } }] });
    });

    it('parses nominal and hydratable classes without adding self parameters', () => {
        const program = parse(`hydratable class Person:
    firstName: str [min=1, max=10, desc='First Name']
    lastName: str
    age: int
    address: Address

    def Person(firstName: str, lastName: str, age: int, address: Address):
        self.firstName = firstName
        self.lastName = lastName
        self.age = age
        self.address = address

    def fullName() -> str:
        return '{self.firstName} {self.lastName}'
class Box:
    value: int
    def Box(value: int):
        self.value = value
let result: Person = ask(schema=Person) 'Generate a random person'
let data = ask(schema=struct(Person)) 'Generate a random person'
success object(result)`);
        expect(program.body[0]).toMatchObject({
            t: 'class', name: 'Person', hydratable: true,
            methods: [{ name: 'Person', params: ['firstName', 'lastName', 'age', 'address'] },
                { name: 'fullName', params: [], returnType: { name: 'str' } }],
        });
        expect(program.body[1]).toMatchObject({ t: 'class', hydratable: false });
        expect(program.body[3]).toMatchObject({
            value: { mods: { schema: { t: 'call', callee: { t: 'name', name: 'struct' } } } },
        });
    });

    it('permits empty records with explicit pass and declarations nested in statement blocks', () => {
        expect(parse(`struct Empty:
    pass
if True:
    enum Choice = 'a'
    class EmptyClass:
        pass`).body).toMatchObject([
            { t: 'struct', fields: [] }, { branches: [{ body: [{ t: 'enum' }, { t: 'class' }] }] },
        ]);
    });

    it.each([
        ['let x: = 1', /expected a type name/],
        ['let x: list[] = []', /expected a type name/],
        ['let x: list[int, str] = []', /expected '\]'/],
        ['let x: fn(int) = f', /expected '->'/],
        ['let x: int | = 1', /expected a type name/],
        ['let x: $env = 1', /expected a type name/],
        ['enum Color = 1', /quoted string/],
        ["enum Color = 'red' | 'red'", /duplicate enum member/],
        ["enum Color = '{name}'", /cannot contain interpolation/],
        ['struct S:\n    x: int\n    x: str', /duplicate field/],
        ['struct S:\n    def f():\n        pass', /structs contain fields, not methods/],
        ['class C:\n    x: int\n    def x():\n        pass', /duplicate class member/],
        ['class C:\n    def C(self):\n        pass', /'self' is implicit/],
        ['hydratable struct S:\n    x: str', /expected 'class'/],
        ['class C(Base):\n    pass', /expected ':'/],
    ])('rejects malformed declaration %s', (source, message) => bad(source, message as RegExp));
});

describe('parser: compile-time field metadata', () => {
    it('accepts arbitrary advice names and nested JSON-compatible literal values', () => {
        const program = parse(`struct Data:
    value: list[str] [
          desc='Values',
        min=-2.5, max=1e3,
          choices=['a', 'b', None, True, False, [1, 2]],
        guidance=object:
            'mode': 'friendly'
            'nested': object:
                'allowed': True
        ,
        __proto__='safe',
    ]`);
        expect(program.body[0]).toMatchObject({ fields: [{ advice: {
            desc: 'Values', min: -2.5, max: 1000,
            choices: ['a', 'b', null, true, false, [1, 2]],
            guidance: { mode: 'friendly', nested: { allowed: true } },
        } }] });
        const stmt = program.body[0];
        if (stmt.t !== 'struct') throw new Error('expected struct');
        expect(Object.hasOwn(stmt.fields[0].advice, '__proto__')).toBe(true);
        expect(Object.getPrototypeOf(stmt.fields[0].advice)).toBe(Object.prototype);
    });

    it.each([
        ["desc=1", /'desc' must be a string/],
        ["min='1'", /'min' must be a number/],
        ["max=True", /'max' must be a number/],
        ["hint=lookup()", /compile-time JSON-compatible literals/],
        ["hint=value", /compile-time JSON-compatible literals/],
        ["hint=1 + 2", /compile-time JSON-compatible literals/],
        ["hint='{value}'", /compile-time JSON-compatible literals/],
        ["hint=[1, lookup()]", /compile-time JSON-compatible literals/],
        ["min=1e999", /finite JSON-compatible literals/],
        ["hint=1, hint=2", /duplicate field metadata/],
        ["desc:'hello'", /expected '='/],
    ])('rejects invalid metadata %s', (advice, message) => {
        bad(`struct Data:\n    value: str [${advice}]`, message as RegExp);
    });

    it('rejects executable functions and computed keys in literal advice objects', () => {
        bad(`struct Data:
    value: str [hint=object:
        'ok': True
        def executable():
            pass
    ]`, /compile-time JSON-compatible literals/);
        bad(`struct Data:
    value: str [hint=object:
        key: True
    ]`, /object keys must be literal strings/);
    });
});

describe('parser: object expressions and descriptors', () => {
    it('parses nested dictionaries and computed lexical entries', () => {
        const program = parse(`let person = object:
    'name': 'Ada'
    'address': object:
        'city': 'London'
        'postalCode': 'SW1A 1AA'
    prefix + name: values[index]
let empty = object()`);
        expect(program.body[0]).toMatchObject({ value: {
            t: 'dict', entries: [
                [{ t: 'str', parts: ['name'] }, { t: 'str', parts: ['Ada'] }],
                [{ t: 'str', parts: ['address'] }, { t: 'dict', entries: expect.any(Array) }],
                [{ t: 'binary' }, { t: 'index' }],
            ],
        } });
        expect(program.body[1]).toMatchObject({ value: { t: 'call', callee: { name: 'object' }, args: [] } });
    });

    it('stores inline defs as lexical properties with only explicit arguments', () => {
        const program = parse(`let greeting = object:
    'x': 'Hello'
    'print': printHello
    def printWorld() -> None:
        log('{greeting.x} World')
    def repeat(text: str) -> str:
        return text
    'last': 1
greeting.print()
greeting.printWorld()`);
        expect(program.body[0]).toMatchObject({ value: {
            t: 'dict', entries: [
                [{ t: 'str', parts: ['x'] }, { t: 'str', parts: ['Hello'] }],
                [{ t: 'str', parts: ['print'] }, { t: 'name', name: 'printHello' }],
                { t: 'def', name: 'printWorld', params: [], returnType: { name: 'None' } },
                { t: 'def', name: 'repeat', params: ['text'], paramTypes: [{ name: 'str' }] },
                [{ t: 'str', parts: ['last'] }, { t: 'num', v: 1 }],
            ],
        } });
    });

    it.each([true, false])('preserves colliding property order with inline function first=%s', (functionFirst) => {
        const functionEntry = `    def x() -> str:
        return 'function'`;
        const valueEntry = "    'x': 'last'";
        const sourceEntries = functionFirst ? [functionEntry, valueEntry] : [valueEntry, functionEntry];
        const program = parse(`let objectValue = object:
${sourceEntries.join('\n')}`);
        const statement = program.body[0];
        if (statement.t !== 'let' || statement.value.t !== 'dict') throw new Error('expected object initializer');
        const expectedFunction = { t: 'def', name: 'x', params: [], returnType: { name: 'str' } };
        const expectedValue = [{ t: 'str', parts: ['x'] }, { t: 'str', parts: ['last'] }];
        expect(statement.value.entries).toMatchObject(functionFirst
            ? [expectedFunction, expectedValue]
            : [expectedValue, expectedFunction]);
        expect(statement.value).not.toHaveProperty('functions');
    });

    it('preserves grouping to distinguish dictionary built-in dispatch from stored calls', () => {
        const program = parse('o.pop()\n(o.pop)()\nlet x = (1 + 2)\n(o.x) = 3');
        expect(program.body[0]).toMatchObject({ e: { t: 'call', callee: { t: 'member', name: 'pop' } } });
        expect(program.body[1]).toMatchObject({ e: { t: 'call', callee: { t: 'group', e: { t: 'member', name: 'pop' } } } });
        expect(program.body[2]).toMatchObject({ value: { t: 'group', e: { t: 'binary' } } });
        expect(program.body[3]).toMatchObject({ t: 'assign', target: { t: 'member', name: 'x' } });
    });

    it('allows object values in calls, lists, modifiers, and grouped larger expressions', () => {
        parse(`let result = consume(object:
    'a': 1
, object:
    'b': 2
)
let values = [object:
    'a': [1,
          2]
, 3]
let selected = (object:
    'a': 1
)['a'] + 2
let answer = ask(schema=object:
    'type': 'object'
) 'Describe'`);
    });

    it('allows continuation indentation around explicit suites, but not within their bodies', () => {
        parse(`let value = [
       object:
           'nested': object:
               'x': [
                 1,
            2,
               ]
           'next': 3
  ,
       object(),
]`);
        bad(`let values = [object:
  'x': 1
]`, /exactly four spaces/);
    });

    it('preserves interpolation including object expressions and interpolation statement suites', () => {
        parse(`let text = '''value {(object:
    'key': 1
)['key']}'''
let conditional = '''{if True:
    1
else:
    2
}'''`);
    });

    it('parses composite runtime descriptors while preserving named descriptor expressions', () => {
        const program = parse(`validate(value, list[int])
isinstance(callback, fn(str, int) -> str)
validate(value, int | str | None)
let descriptor = list[int | str] | None
let PersonSchema = struct(Person)`);
        expect(program.body[0]).toMatchObject({ e: {
            args: [{ t: 'name' }, { t: 'type', type: { t: 'type-list', element: { name: 'int' } } }],
        } });
        expect(program.body[1]).toMatchObject({ e: {
            args: [{ t: 'name' }, { t: 'type', type: { t: 'type-fn' } }],
        } });
        expect(program.body[2]).toMatchObject({ e: {
            args: [{ t: 'name' }, { t: 'type', type: { t: 'type-union', members: [{ name: 'int' }, { name: 'str' }, { name: 'None' }] } }],
        } });
        expect(program.body[3]).toMatchObject({ value: { t: 'type', type: { t: 'type-union' } } });
        expect(program.body[4]).toMatchObject({ value: { t: 'call', callee: { name: 'struct' } } });
    });

    it('interprets None as a descriptor only at explicit descriptor argument positions', () => {
        const program = parse(`let nil = None
isinstance(value, None)
validate(value, (None))
let result = ask(schema=None) 'Return null'
let dynamic = ask(schema=None if flag else str) 'Return a value'
ordinary(value, None)`);
        expect(program.body[0]).toMatchObject({ value: { t: 'none' } });
        expect(program.body[1]).toMatchObject({ e: { args: [
            { t: 'name' }, { t: 'type', type: { t: 'type-name', name: 'None', line: 2 } },
        ] } });
        expect(program.body[2]).toMatchObject({ e: { args: [
            { t: 'name' }, { t: 'group', e: { t: 'type', type: { name: 'None' } } },
        ] } });
        expect(program.body[3]).toMatchObject({ value: { mods: { schema: {
            t: 'type', type: { name: 'None' },
        } } } });
        expect(program.body[4]).toMatchObject({ value: { mods: { schema: {
            t: 'ternary', then: { t: 'type', type: { name: 'None' } }, else: { name: 'str' },
        } } } });
        expect(program.body[5]).toMatchObject({ e: { args: [{ t: 'name' }, { t: 'none' }] } });
    });

    it.each([
        ['let x = {}', /brace dictionary literals have been removed.*object\(\)/],
        ["let x = {'a': 1}", /brace dictionary literals have been removed.*object:/],
        ["log({'a': 1})", /brace dictionary literals have been removed/],
        ["let x = object: 'a': 1", /expected a newline/],
        ['let x = object:\n    pass', /unexpected keyword/],
        ["let x = object:\n    'a': 1,\n    'b': 2", /end of statement/],
        ["let x = object:\n    'a': 1\n  'b': 2", /inconsistent dedent/],
        ["let x = object:\n        'a': 1", /exactly four spaces/],
        ['let x = 1 | str', /joins type descriptors/],
    ])('rejects malformed or removed expression %s', (source, message) => bad(source, message as RegExp));

    it('ignores blank/comment-only lines and rejects indentation tabs even in continuations', () => {
        parse(`let x = object:
# comment

    'a': 1
         # arbitrary comment indentation
    'b': object:
        'c': 2`);
        bad('let x = [\n\t1\n]', /tabs are not allowed/);
    });
});
