# Typing migration

This is a breaking source revision, including for unannotated programs. Migrate source manually;
there is no legacy grammar mode or general-purpose automatic converter. Recreate pins and
checkpoints after editing their source. The full contract is recorded in [TYPES.md](../TYPES.md).

## Blocks and dictionaries

Old blocks such as `if True { log('ok') }` are rejected. Replace the opening brace with a colon,
put the body on new lines, and remove the closing brace. Each level adds **exactly four spaces**;
tabs, inline suites and inconsistent dedents are errors. Align `elif`, `else` and `except` with
their opening statement. Use `pass` for an otherwise empty statement body.

Old dictionaries such as `let data = {'name': 'Ada'}` are also rejected. Use an `object:` expression;
replace `{}` with `object()`. Do not change ordinary JavaScript objects, raw JSON wire payloads,
or interpolation braces inside SPL strings. Expression continuation inside `()` and `[]` suspends
ordinary indentation; explicit `object:` blocks still delimit their own entries.

```spl
let data = object:
    'name': 'Ada'
    'address': object:
        'city': 'London'
let empty = object()
if True:
    log(data.name)
```

Object keys do not introduce a lexical scope. Inline `def` properties capture ordinary lexical
variables, receive no implicit `self`, and should access fields through an explicit argument or
captured dictionary. Dictionary built-in methods win in member calls: `o.pop()` calls the built-in,
whereas `(o.pop)()` invokes a function stored at the colliding key.

## Opt into typed contracts

Untyped bindings remain dynamically assignable. Add annotations only where an enforced contract
is wanted. Known typed violations stop execution before model calls; unknown dynamic values
are checked at runtime without coercion or repair.

```spl
enum Color = 'red' | 'green' | 'blue'
struct Request:
    color: Color
    note: str | None
    callback: fn(str, int) -> str

def repeat(text: str, count: int) -> str:
    return text * count

let count: int = 2
let colors: list[Color] = ['red']
let choice: int | str = 1
```

Structs are structural, exact records: every field is required, including nullable fields.
Missing and extra fields fail. Enums accept matching strings directly. `char` requires exactly
one Unicode scalar, not one UTF-16 code unit or grapheme cluster. `fn(T1, T2) -> R` uses explicit
arity, contravariant parameters and covariant returns; annotated and guarded callable boundaries
check arguments and results. Neither `validate(value, Type)` nor `isinstance(value, Type)`
converts legacy numbers. Explicit `validate(data, Class)` can turn structural field data
into a nominal instance; `isinstance` remains a non-converting test.

Field advice such as `str [min=2, desc='Name']` is compile-time JSON-compatible metadata, not a
constraint: a one-character string still satisfies that type. Raw JSON Schema constraints remain
strict. Forward declarations, recursive data schemas and inheritance are not supported.

## Reusable type aliases

Use `type Name = T` for a read-only, transparent alias. Aliases work in annotations,
fields, unions, lists and `schema=` targets, preserving the underlying representation
and class identity:

```spl
type Money = int [minimum=0, desc='Amount in cents']
type Prices = list[Money]
type MaybeMoney = Money | None
let prices: Prices = [1250, 890]
let total: Money = 0
for price in prices:
    total += price
let discount: MaybeMoney = None
```

Advice is descriptive, not a constraint: `minimum=0` does not reject negative integers.
Assert business rules explicitly. Alias chains inherit advice; newly declared keys
override inherited keys, while field advice is appended separately.
`type(value)` still returns the runtime type name.

For blockquotes, give composite schemas a binding name, for example
`type Batch = list[Request]`, then request `@validate[Batch]`.
The agent passes `schema="Batch"` to `save_variable`; a string such as
`"list[Request]"` is not a declared binding name.

## Numeric representations and conversions

Typed `1` is a signed 64-bit `int`; typed `1.0` is a distinct finite binary64 `float`.
Untyped literals retain legacy number behavior. A legacy value needs explicit `int(value)` or
`float(value)` conversion to enter a new representation; validation never converts it.

`int(...)` is exact and range-checked: fractions, booleans, nonfinite values, out-of-range inputs,
and inexact integer strings fail. It no longer truncates fractions or treats booleans as integers.
The inclusive range is `-9223372036854775808` to `9223372036854775807`.
`float(...)` constructs the distinct representation and rejects NaN and infinities; converting
an integer to binary64 may round and lose precision. Mixed `int`/`float` arithmetic requires
explicit conversion. Integer arithmetic checks overflow; integer `/` produces a float.
`sum`, `abs` and `round` preserve typed numeric representations. Ordinary `len` and `range`
counts remain legacy numbers: use explicit `int(...)` when a typed count is required.

Descriptor-directed JSON decoding preserves integer tokens without first passing through a
JavaScript number. For `int | float`, integer tokens select `int`, decimal/exponent tokens select
`float`. SPL emits integers exactly and integral floats as `1.0` (or exponent spelling).
External JSON normalization may erase that distinction; only SPL's typed encoder/decoder
provides this round-trip guarantee.

`JsonFileStore` writes typed numeric tokens losslessly, but loading a store remains dynamic:
files do not carry type descriptors or automatically restore typed contracts. Use an explicitly
requested descriptor for typed numeric decoding; do not assume a generic JSON loader preserves
signed-64-bit values or the `int`/`float` distinction.

## Class schemas versus structural data

Classes are nominal instances with declared fields, a constructor named after the class, and
implicitly bound `self` in constructors and methods. A matching dictionary is not a class instance.
Normal construction runs the constructor and must initialize every declared field before publishing
the instance. Direct schema hydration requires `hydratable class`; explicit
`validate(data, Class)` can populate an ordinary class from validated fields without
running the constructor.

```spl
hydratable class Person:
    name: str

    def Person(name: str):
        self.name = name

    def greeting() -> str:
        return 'Hello {self.name}'

let person: Person = ask(schema=Person) 'Generate a person'
let data = ask(schema=struct(Person)) 'Generate person data'
success object(person)
```

`schema=Person` returns a hydrated instance only when the class opts in. `schema=struct(Person)`
returns validated structural field data, **not** a `Person`. Consequently the old proposed
`let result: Person = ask(schema=struct(Person)) 'Random Person'` cannot satisfy the annotation.
An annotation never secretly selects an ask schema, format or hydration target.
To convert the structural result explicitly, use `let person: Person = validate(data, Person)`.
This validates exact declared fields, recursively converts nested class data and bypasses
constructors. It does not convert legacy numbers; use typed schemas or explicit numeric
conversions before validation.

For an existing instance, `validate(object(person), struct(Person))` creates a deep field
snapshot and checks its structural contract. Dynamic `object(person)` projection drops named
function properties; validation then rejects any missing required callable field rather than
silently accepting an incomplete record.

Hydration skips the constructor: methods must not assume constructor normalization, side effects
or semantic invariants occurred. Callable/non-JSON required fields make a schema target unsupported
before any model call; they are not silently omitted. Distinct ambiguous decoding targets fail
rather than being selected by union declaration order.

Typed decoding and complete hydration validation share the ask repair pipeline: zero repairs by
default, at most five additional attempts, and existing format/repair restrictions. Ordinary
assignment, call, mutation and validation failures do not trigger model retries.

## Persistent mutation contracts and projection

Typed mutable values retain their contracts for their lifetime, including mutations through
untyped aliases, member/index writes, captured bindings and built-in mutators. Mutable contracts
are invariant: `list[Color]` is not interchangeable with `list[str]`.

Successful mutable `isinstance` tests atomically install compatible contracts, just as validation
does. Failed tests leave data and contracts unchanged. Incompatible typed aliases fail even when
an empty collection's contents happen to satisfy both types. Bulk writes validate everything
before committing; failures leave no valid prefix written or partial contracts installed.
Narrowing expires after relevant assignment or potentially mutating calls; use stable local
snapshots when appropriate.

Project class instances explicitly before JSON output. `object(value)` makes a deep dynamic
snapshot without sharing mutable children or changing its source. Named function properties,
including methods, are dropped by dynamic projection; root functions, array functions and cycles
are rejected. Class-to-struct projection likewise snapshots declared data fields without silently
discarding required non-JSON fields. Ordinary untyped function serialization is unchanged:
projection rules do not globally make the serializer ignore functions.
