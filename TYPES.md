# Types in SPL

This document is the contract of the SPL type builder: what a type guarantees, what it
deliberately does not, and how types reach a model. For a practical introduction see
[Workflow code](docs-template/Language.md#types), the [API reference](docs-template/Reference.md#types)
and the runnable [typed-data example](lang/examples/typed-data.md).

Types are JavaScript values created with library functions. In a workflow fence the builders are
already in scope; elsewhere, import them from `spl-lang`.

```js
const Color = enumOf('red', 'green', 'blue');
const Money = typedef('Money', int, { minimum: 0, desc: 'Amount in cents' });
const Item = struct('Item', { name: str, color: Color, price: Money, note: nullable(str) });
```

## Scope and guarantees

A type describes data. It does three things:

1. **Validates** a value (`parse`, `is`, `validate`).
2. **Parses** JSON-shaped data into JavaScript values, including class instances.
3. **Renders JSON Schema** (`schema`) for the model, including annotations.

What a successful `parse` guarantees:

- The returned value conforms to the type at that moment: every struct field is present with a
  conforming value, no undeclared field exists, and list items and union members conform.
- Nothing was coerced, defaulted or dropped. `int.parse('1')` fails; a missing field fails.
- Structs and lists are returned as new objects and arrays; the input is not modified.

What it does not guarantee:

- **No static checking.** JavaScript variables and parameters carry no enforced types. A type
  checks data only where it is applied: `schema` on a model call, `@validate[Type]` in a
  blockquote, or an explicit `parse`, `is` or `validate`.
- **No persistent contracts.** A parsed value is an ordinary JavaScript value and can be changed
  afterwards. Parse again when it matters.
- **No semantic truth.** A value of the right shape can still be wrong. Use `assert` for
  business rules.

Failures are `Failure` exceptions with the status code `validation_failed` and a reason that
names the path: `$.items[0].price: expected Money, got "12.50"`.

## Types are immutable values

Every builder returns a frozen `Type`. Methods that modify a type (`annotate`, `describe`, `as`,
`nullable`, `list`, `or`, `field`, `methods`, `class`) return a new type and leave the original
unchanged. Types can therefore be shared between fences, modules and blockquotes freely.

A type has a `kind`, a display `name` and `annotations`. The name appears in error messages and
in the label an agent sees for a binding (`<type Money>`). `String(type)` is the name.

## Primitive types

| Builder | Accepts | Rejects |
| --- | --- | --- |
| `str` | Strings | Everything else; numbers are not converted |
| `int` | Safe integers: `Number.isSafeInteger(value)` | Fractions, numeric strings, `NaN`, values beyond 2^53 - 1 |
| `float` | Finite numbers, including integers | `NaN`, `Infinity`, numeric strings |
| `bool` | `true`, `false` | `0`, `1`, `'true'` |
| `char` | Strings of exactly one Unicode code point | Empty and longer strings, lone surrogates |
| `nil` | `null` | `undefined` |
| `any` | Any JSON value | `undefined`, functions, symbols |
| `object` | Plain objects of any shape | Arrays, `null`, class instances, `Map` |
| `fn` | Functions | Everything else; has no JSON Schema |

Numbers are JavaScript numbers. There is one numeric representation, so `int` and `float` differ
only in the values they accept: `float.parse(2)` returns `2`, and `union(float, int)` accepts
every finite number. Integers beyond the safe range cannot be represented exactly and are rejected
by `int`.

`char` counts code points, not UTF-16 units or grapheme clusters: an emoji outside the Basic
Multilingual Plane is one `char`; a letter followed by a combining accent is two.

## Enums and lists

`enumOf('a', 'b')` or `enumOf(['a', 'b'])` accepts exactly the listed strings. The values are
ordinary strings, so `Color.parse('red') === 'red'`.

`list(T)`, also written `T.list()`, accepts arrays whose every item satisfies `T`. Errors name
the index: `$[1]: expected int, got "a"`.

## Structs are exact

`struct(name, fields)` describes a record with exactly the declared fields.

```js
const Address = struct('Address', { city: str, postalCode: nullable(str) });

assert(Address.is({ city: 'London', postalCode: null }));
assert(!Address.is({ city: 'London' }), 'a nullable field must still be present');
assert(!Address.is({ city: 'London', postalCode: null, country: 'UK' }), 'extra fields are rejected');
assert(!Address.is({ city: 1, postalCode: null }), 'values are not converted');
```

- Every field is required. Nullable means the value may be `null`, not that the field may be absent.
- Fields that are not declared are rejected.
- The value must be a plain object; arrays and class instances are not structs.
- Two struct types with the same fields accept the same values. The name is a label, not an identity.
- Fields are fixed when the type is created. A type cannot refer to itself, so recursive data
  has no struct type; use `any` or `jsonSchema` for it.

`struct('Point').field('x', float, { desc: 'Horizontal' }).field('y', float)` builds the same
kind of type one field at a time. `Type.fields` exposes the field types by name.

## Unions

`union(A, B, ...)`, also `A.or(B)`, accepts a value that satisfies any member; `nullable(T)` and
`T.nullable()` are `union(T, nil)`.

- Members are tried in declaration order and the first match provides the parsed value, except
  that a matching [class type](#classes) takes precedence over a plain struct.
- Duplicate members are removed, and a union of one type is that type.
- For `T | null`, a rejected value reports the error of `T`, which says more than the union would.
- If plain data matches more than one class type, `parse` fails with
  `ambiguous: matches A and B` rather than choosing by order. An existing instance is never ambiguous.

## Annotations are advice

Annotations are arbitrary JSON-compatible metadata written for the model.

```js
const Rating = int.annotate({ minimum: 1, maximum: 5, desc: 'Stars' });
const Price = typedef('Price', Money, { currency: 'EUR' });

assert(Rating.parse(9) === 9, 'annotations never reject a value');
log(Rating.schema());
// { type: 'integer', description: 'Stars\nModel advice (not validation constraints): {"minimum":1,"maximum":5}' }
```

- `type.annotate({...})` merges annotations into a copy; later keys override earlier ones.
  `type.describe(text)` is `annotate({ description: text })`.
- `typedef(name, type, annotations)` and `type.as(name, annotations)` name a type and add
  annotations. A named alias accepts exactly the values of its underlying type, and inherits
  its annotations.
- Annotating a field means annotating the type given for that field:
  `struct('Item', { price: Money.annotate({ desc: 'Net price' }) })`. The shared `Money` is unchanged.
- In JSON Schema, `description` and `desc` become the schema's `description`. All other keys
  are appended to it as `Model advice (not validation constraints): {...}`, so a model reads
  them but a schema validator does not enforce them.
- Annotations never take part in `parse`, `is` or `validate`.

To enforce a constraint, state it in code or use raw JSON Schema:

```js
const rating = Rating.parse(4);
assert(rating >= 1 && rating <= 5, 'rating out of range');

const Strict = jsonSchema({ type: 'integer', minimum: 1, maximum: 5 }, 'StrictRating');
assert(!Strict.is(9));
```

## Classes

A struct becomes a class type when it gets behavior.

```js
const Person = struct('Person', { name: str, age: int }).methods({
    greeting() { return `Hello ${this.name}`; },
});

class Point {
    constructor(x, y) { this.x = x; this.y = y; }
    static fromJSON(data) { return new Point(data.x, data.y); }
    norm() { return Math.hypot(this.x, this.y); }
}
const PointType = struct('Point', { x: float, y: float }).class(Point);

const person = Person.parse({ name: 'Ada', age: 36 });
assert(person.greeting() === 'Hello Ada');
assert(PointType.parse({ x: 3, y: 4 }) instanceof Point);
```

- `.methods({...})` creates a prototype with the given methods; `this` is the parsed object.
  A method may not have the name of a field.
- `.class(Constructor)` uses an existing class. When the class has a static `fromJSON(data)`,
  `parse` calls it with the validated fields and requires an instance in return. Otherwise the
  instance is created with the class's prototype and the validated fields, **without running
  the constructor**.
- Fields must be declared before `.methods` or `.class`.
- `parse` accepts plain data, which it validates exactly and hydrates, or an existing instance,
  whose declared fields it validates and which it returns unchanged.
- `is` is true only for instances. Plain data that would hydrate successfully is not an instance.
- `Type.data` is the plain-struct view: same fields, no methods. `JSON.stringify(instance)`
  yields the fields, so `Person.data.parse(JSON.parse(JSON.stringify(person)))` is a plain copy.
- Class types nest: a struct field, list item or union member of a class type is hydrated too.

## Raw JSON Schema

`jsonSchema(schema, name?)` wraps a JSON Schema (draft-07, compiled strictly with Ajv) as a type.
Unlike annotations, its keywords are enforced. The value is returned as it is, without copying
or hydration. `validate(value, schema)` and the `schema` option of model calls accept a raw
schema object or boolean directly. An invalid schema is a `runtime_error`.

## JSON Schema output

`type.schema()` returns the JSON Schema sent to a model.

| Type | Schema |
| --- | --- |
| `str`, `int`, `float`, `bool`, `nil` | `{ "type": "string" }`, `"integer"`, `"number"`, `"boolean"`, `"null"` |
| `char` | `{ "type": "string", "minLength": 1, "maxLength": 1 }` with a description |
| `any`, `object` | `{}`, `{ "type": "object" }` |
| `enumOf('a', 'b')` | `{ "type": "string", "enum": ["a", "b"] }` |
| `list(T)` | `{ "type": "array", "items": T }` |
| `union(A, B)` | `{ "anyOf": [A, B] }` |
| `struct` and class types | `{ "type": "object", "properties": {...}, "required": [every field], "additionalProperties": false }` |
| `jsonSchema(schema)` | A copy of `schema` |
| `fn` | None: `schema()` raises `runtime_error` |

Named aliases are transparent in the output: their schema is the underlying schema plus their
annotations. Nested types are written inline; there are no `$ref` references.

The built-in schema is a description for the model. The runtime validates with the type itself,
which is stricter than the schema in two places: `int` requires a safe integer and `char` a
single code point.

## Types and model output

```js
const item = await ask('Describe a red pen that costs 2.50', { schema: Item, repairs: 1 });
```

- `schema: Type` implies JSON output. The prompt ends with the type's JSON Schema; the answer
  is parsed as strict JSON and then with `Type.parse`. The call resolves to the parsed value:
  plain objects for structs, instances for class types.
- `invalid_format` (not JSON) and `validation_failed` (wrong shape) can be repaired: with
  `repairs: n`, the model gets up to `n` more attempts, each with its previous answer and the error.
- A variable's declared TypeScript type never selects a schema. Only the `schema` option does.
- In a blockquote, `@validate[Item]` makes the agent save through the type: `save_variable`
  with the schema name `Item` stores `Item.parse(value)`. The name is the JavaScript binding, so
  give composite types a binding first: `const Items = list(Item);`. Loading a type binding
  returns its JSON Schema to the agent. A rejected value is reported with the variable as the
  root of the path, such as `invoice.tax: expected Money, got 3312.5`, where `Type.parse`
  itself uses `$`.

## TypeScript inference

Types carry their parsed JavaScript type. `Infer` extracts it, and model calls are typed by
their options.

```ts
import type { Infer } from 'spl-lang';

const Color = enumOf('red', 'green', 'blue');
const Item = struct('Item', { name: str, color: Color, tags: list(str), note: nullable(str) });
type Item = Infer<typeof Item>;
// { name: string; color: 'red' | 'green' | 'blue'; tags: string[]; note: string | null }

const item = await ask('Describe a pen', { schema: Item });   // Item
const count = await ask('How many?', { fmt: 'integer' });      // number
const text = await ask('Say hi');                               // string
```

| Builder | Inferred type |
| --- | --- |
| `str`, `char` | `string` |
| `int`, `float` | `number` |
| `bool`, `nil` | `boolean`, `null` |
| `any`, `object` | `unknown`, `Record<string, unknown>` |
| `enumOf('a', 'b')` | `'a' \| 'b'` |
| `list(T)`, `nullable(T)`, `union(A, B)` | `T[]`, `T \| null`, `A \| B` |
| `struct(name, fields)` | An object type with one property per field |
| `.methods(M)` | The fields and the methods |
| `.class(C)` | `InstanceType<typeof C>` |
| `jsonSchema<T>(schema)` | `T`, `unknown` by default |

Inference is compile-time help only. `ts` fences are erased before running, so the guarantees
above come from `parse`, not from annotations in the source.

## Non-goals

- Optional fields, default values and coercion.
- Recursive types, inheritance between struct types and callable signatures.
- Exact integers beyond the JavaScript safe range.
- Static checking of JavaScript code, or contracts that persist after parsing.
- Enforcing annotations.

## Acceptance

The behavior described here is covered by `lang/tests/types.test.ts` and exercised without a
model by [typed-data.md](lang/examples/typed-data.md),
[deterministic/types.md](lang/examples/deterministic/types.md) and
[deterministic/enumsStructs.md](lang/examples/deterministic/enumsStructs.md).
