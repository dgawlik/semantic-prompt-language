# Types in SPL

This document records the contract for SPL's breaking language
revision with opt-in gradual typing and schema-directed decoding. For a practical
introduction, see [Language](docs-template/Language.md#gradual-typing), the
[migration guide](docs-template/Migration.md), and the runnable
[typed-data example](lang/examples/typed-data.md).

## Scope and guarantees

SPL remains dynamic where no typed contract participates. Type annotations,
type descriptors, validation, and operations on typed values opt into checking.

A well-typed program guarantees statically knowable consistency in its typed
operations. At runtime, accepted typed values conform to their declared types
and retain their contracts through mutation. Neither guarantee proves that
generated content is factually correct or satisfies its intended meaning.

- Known violations of typed contracts block execution before any model calls.
- Unknown values from dynamic code may enter typed code through runtime
  validation, without numeric coercion or repair. Explicit class-target validation
  can convert structural field data into a nominal instance.
- Untyped expressions may be analyzed to inform typed checks. Untyped bindings
  remain dynamically assignable; purely untyped code does not become subject to
  blanket static type checking.
- Annotations are enforced contracts, not advisory lint warnings.
- Validation does not insert defaults, remove fields, or silently convert values.
  `validate(data, Class)` explicitly requests structural-to-class conversion.

```spl
let count: int = 1
let ratio: float = 1.0
let title: str = 'Example'
```

Both `let count: int = 1.0` and `let title: str = 2.0` are static errors.

## Breaking grammar revision

There is one indentation-only block grammar, not a legacy mode or a grammar
accepting both brace and indentation blocks.

- All statement blocks use a colon and an indented body, including functions,
  constructors, methods, control flow, structs, and classes.
- Each block level adds four spaces. Indentation tabs and inconsistent dedents
  are errors.
- Blank and comment-only lines do not change block nesting.
- Indentation is suspended for ordinary multiline expression continuations
  inside parentheses and list brackets.
- Brace-delimited blocks and SPL dictionary literals are removed.
- Lists retain bracket syntax. JSON wire syntax is unchanged.

### Dictionary expressions

`object:` introduces an indented dictionary expression. Entries use
`key: value`, with string or computed keys and ordinary lexical evaluation of
values. `object()` creates an empty dynamic dictionary.

```spl
let address = object:
    'city': 'London'
    'postalCode': 'SW1A 1AA'

let person = object:
    'name': 'Ada'
    'address': object:
        'city': 'London'
        'postalCode': 'SW1A 1AA'

let empty = object()
let names = ['Ada', 'Grace']
```

An `object:` is a block-valued expression, not an implicit statement scope made
from its keys. It supports nesting and use as a value in larger expressions.
Explicit object blocks delimit their entries; indentation used only to continue
a parenthesized or bracketed expression does not open a statement block.

## Primitive types

| Type | Contract |
| --- | --- |
| `int` | Distinct signed 64-bit integer representation. |
| `float` | Distinct finite IEEE-754 binary64 representation. |
| `str` | String. |
| `char` | String containing exactly one Unicode scalar value; a subtype of `str`. |
| `bool` | Boolean, distinct from numeric types. |
| `None` | Singleton null type; not an absent field. |

`char` does not mean one UTF-16 code unit or one grapheme cluster. No Unicode
normalization is performed. A combining sequence containing multiple scalar
values is not one `char`; an isolated surrogate is not a Unicode scalar value.

### Numeric representation and operations

`int` and `float` are disjoint runtime types. In typed literal contexts, `1`
constructs an `int`, whereas `1.0` constructs a `float`. Existing untyped
numeric behavior remains unchanged; legacy numeric values require explicit
`int(...)` or `float(...)` conversion to enter these new representations.

- The integer range is `-9223372036854775808` through `9223372036854775807`,
  inclusive.
- Integer arithmetic is checked. Overflow is an error, never wrapping or
  saturation.
- `float` rejects NaN and infinities.
- Mixed `int`/`float` arithmetic requires explicit conversion.
- Integer `/` produces a `float`. Integer-preserving division is an explicit
  operation, not implicit truncation.
- Numeric comparisons compare mathematical values without first rounding an
  integer through binary64.

Integer conversion must be exact and range-checked. Fractional, nonfinite, and
out-of-range inputs fail; integer strings must parse exactly. Explicit
integer-to-float conversion may round to binary64 and is documented as
potentially lossy.

### Enums

Enums are named unions of string literals, not nominal runtime objects.
Matching strings are accepted directly, and an enum is a subtype of `str`.

```spl
enum Color = 'red' | 'green' | 'blue'

let color: Color = 'red'
```

## Containers, structs, and unions

### Lists and dynamic objects

`list[T]` is a homogeneous iterable container whose elements satisfy `T`.
Mutable list contracts are invariant: `list[Color]` is not interchangeable
with `list[str]`, even though individual `Color` values satisfy `str`.

`object` is a dynamic string-keyed dictionary. It is neither an unchecked
`any` nor a superclass of nominal instances. Extracted field values remain
unknown until validated or narrowed into a concrete type.

### Structs

Structs are structural record types and schema descriptions, without nominal
instance identity or methods.

```spl
struct Address:
    line1: str
    line2: str | None
    postalCode: str

struct PersonData:
    firstName: str [min=1, max=10, desc='First Name']
    lastName: str [min=2, max=10, desc='Family Name']
    age: int
    address: Address
```

Separately named structs with equivalent field contracts are interchangeable.
At validation boundaries, the declared shape is exact: missing and extra fields
fail rather than being inserted or removed. Mutable field contracts still obey
the aliasing rules below.

Every declared field is required. For example, `line2: str | None` requires the
`line2` field to be present, but permits its value to be `None`.

### General unions

`|` is a general union operator, not special nullable-only syntax.

```spl
let choice: int | str = 1
let optional: PersonData | None = None
```

A value satisfies a union if it satisfies a member. Operations not valid for
every possible member require explicit narrowing.

Union membership and decoding target selection are different questions:

- Equivalent decoding interpretations are collapsed.
- Distinct, ambiguous runtime representations, hydrated classes, or mutable
  contracts are rejected rather than selected by declaration order.
- Multiple membership matches are acceptable when no distinct representation
  or contract must be selected.
- Numeric union decoding follows the JSON token rule described below.

For example, identical field shapes cannot choose between two distinct nominal
classes. An untyped empty list cannot arbitrarily acquire either a `list[int]`
or a `list[str]` contract; the caller must supply an unambiguous target.

## Field metadata is model advice

The brackets after a field type contain advisory metadata, not additional
data-validity constraints.

The same metadata is permitted on transparent, read-only type aliases:

```spl
type Money = int [minimum=0, desc='Monetary amount in cents']
let total: Money = 1250
```

Aliases preserve the underlying representation, assignability and operations, including
nominal class identity. They can be used in annotations, containers and schema targets.
Alias advice propagates into schema descriptions; it is not enforced as validation.
Aliases of aliases inherit advice, with newly declared keys overriding inherited keys.
Field-specific advice is appended separately. `type(value)` remains available.

- Metadata consists of compile-time JSON-compatible literal values, not
  executed expressions or function calls.
- Arbitrary named advice keys are allowed.
- `desc` must be a string; `min` and `max` must be numbers.
- Malformed metadata is a declaration error. Violating valid advice is not a
  data-validation error.
- Advice is supplied through descriptions or prompt guidance. It is not
  lowered into enforced keywords such as `minLength`, `maximum`, or
  `minItems`.

A one-character string can satisfy `str [min=2]`. This does not weaken
constraints inherent in a type, such as the one-scalar requirement of `char`
or the range of `int`.

Explicit constraints in a user-written JSON Schema retain their existing
strict validation behavior. Advisory type metadata does not reinterpret them.

## Runtime contracts, aliases, and narrowing

### Persistent mutable contracts

Validation at initialization alone is insufficient for mutable data.
Typed lists, records, and instances retain their contracts for their lifetime.

- Reassignment of typed bindings and every mutation route are checked.
- Checks cover member/index assignment, built-in mutators, captured bindings,
  and mutations through untyped aliases.
- An incompatible typed alias is rejected even if current contents, such as
  an empty list, happen to match both candidate element types.
- Bulk operations validate the complete operation before committing.
- Failure leaves values and installed contracts unchanged; no partial writes
  or partial contract installation are allowed.

For example, an untyped alias cannot append a string to a list protected by
`list[int]`. An `extend` operation with one invalid element cannot append its
valid prefix and then fail.

### Type tests and validation

`isinstance(value, Type)` performs a non-converting type test and supports
branch narrowing. `validate(value, Type)` checks unknown data and returns a
typed view or raises an explicit error.

```spl
def describe(value: int | str) -> str:
    if isinstance(value, str):
        return value
    return 'An integer'
```

Neither operation converts a legacy number into a new numeric representation.
`isinstance` never converts structural data into a nominal class. Explicit
`validate(data, Class)` validates all declared fields and returns a complete instance,
including for ordinary classes, without running the constructor. Missing and extra
fields fail. This applies recursively through class fields, structs, lists and unions;
distinct ambiguous conversions fail rather than selecting a class arbitrarily.
Converted field dictionaries and containers are copied; input values are not rewritten.
Unchanged mutable children retain compatible contracts. Failed validation installs no
contracts and publishes no partially converted result. Existing instances of the
requested class keep their identity; instances of other classes are not reclassified.

A successful test of a mutable shape atomically installs compatible invariant
contracts, just as validation does. This does not change the data or identity,
but does change permitted future mutations. Failed tests have no such effect;
an incompatible established container contract makes a test false.

Narrowing is not permanent:

- Assignment invalidates the affected binding's narrowing.
- Potentially mutating calls invalidate affected captured-binding and
  member-path narrowing.
- Stable local snapshots can retain their narrowing.

A previous test is not proof that a mutable union binding still contains the
same member after arbitrary code executes.

## Functions and methods

Functions remain first-class values. Parameters and returns may be annotated;
callable fields use `fn(T1, T2) -> R`.

```spl
def repeat(text: str, count: int) -> str:
    return text * count

struct Handler:
    callback: fn(str, int) -> str
```

Callable compatibility uses contravariant parameter types, covariant return
types, and explicit arity. Bound instance method signatures omit the
implicitly supplied `self`.

Known incompatible signatures are static errors. Arguments and return values
are guarded at annotated-function and typed-callable boundaries, including
when the underlying implementation is untyped.

Signature-aware `isinstance` succeeds only for a known compatible signature.
It returns false for an unannotated function, whose return behavior cannot be
proven by observation. `validate(function, CallableType)` may instead create
a guarded callable view; it does not claim to statically verify that function.

### Function-valued dictionary properties

Inline `def` entries in an `object:` are shorthand for function-valued
properties. They capture the ordinary lexical environment, not an implicit
scope of dictionary keys, and receive no implicit dictionary `self`.

```spl
def printHello() -> None:
    log('Hello World')

let greeting = object:
    'x': 'Hello'
    'print': printHello
    def printWorld() -> None:
        log('{greeting.x} World')

greeting.print()
greeting.printWorld()
```

`x` alone inside `printWorld` would be a lexical name, not an implicit field
reference. Access fields through an explicit argument or captured dictionary
variable.

Dictionary built-in methods retain precedence in member calls. A
non-built-in name falls back to invoking a callable property, with exactly
the explicit arguments. A noncallable property produces an error.

`o.pop()` calls the dictionary built-in; `(o.pop)()` invokes a stored function
at the colliding key. Ordinary member reads still return stored property
values. Nominal class methods use separate, implicitly bound instance dispatch.

## Classes and construction

Classes are nominal runtime instances with identity, declared typed fields,
instance methods, and explicit normal construction. A structurally matching
dictionary is not automatically an instance of a class.

A constructor is named after its class. `self` is implicitly bound in
constructors and instance methods.

Construction is staged. Initialized fields can be accessed internally, but
an incomplete instance cannot escape or be published as a normal instance.
Before completion, every declared field must be initialized and valid.
No inheritance is included in this revision.

### Explicit opt-in to schema hydration

`hydratable class` declares that constructor-free field hydration is allowed.
Ordinary `class` declarations require constructors for normal construction and cannot
be direct schema hydration targets. Explicit `validate(data, Class)` is a separate,
caller-requested field conversion and may populate ordinary classes without constructors.

```spl
hydratable class Person:
    firstName: str [min=1, max=10, desc='First Name']
    lastName: str [min=2, max=10, desc='Family Name']
    age: int
    address: Address

    def Person(firstName: str, lastName: str, age: int, address: Address):
        self.firstName = firstName
        self.lastName = lastName
        self.age = age
        self.address = address

    def fullName() -> str:
        return '{self.firstName} {self.lastName}'

let result: Person = ask(schema=Person) 'Generate a random person'
success object(result)
```

Normal construction invokes the constructor. Hydration validates every
declared field before publishing the instance and deliberately skips the
constructor.

Opting in does not establish constructor-specific normalization, side effects,
or semantic invariants. Methods on hydrated instances must not assume those
constructor effects occurred.

## Type descriptors and schemas

Types have immutable runtime descriptors in the existing lexical namespace.
Class descriptors are also callable constructors. Conflicting declarations
in the same scope are errors.

Types must be declared before use. The enclosing class name is available in
its method signatures, but forward declarations and recursive data schemas
are out of scope.

### Explicit `ask` output targets

An `ask` call explicitly requests its decoding target through `schema=`.
A binding annotation validates the resulting value; it does not secretly
configure the call's format, schema, or hydration.

| Request | Result |
| --- | --- |
| `schema=PersonData` | Validated structural data. |
| `schema=Person` | A hydrated instance, only if `Person` opts in. |
| `schema=struct(Person)` | Validated structural data containing the class's declared fields, not a `Person` instance. |
| A raw JSON Schema | Existing strict schema-validation behavior. |

```spl
let data = ask(schema=struct(Person)) 'Generate a random person'
let person: Person = ask(schema=Person) 'Generate a random person'
```

Consequently, the original form
`let result: Person = ask(schema=struct(Person)) 'Random Person'` is not a
hydration request and cannot satisfy the nominal class annotation.

`struct(Class)` produces a structural descriptor for the declared fields.
Methods are excluded. A schema target containing required callable fields
or other non-JSON/unsupported data structures is rejected before a model
call; those fields are not silently omitted. Such types remain usable in
ordinary SPL code.

Providing a schema retains the existing JSON format default. Explicit raw
schemas and format options retain their existing strict behavior, including
restrictions on text formatting and repair support.

### Lossless typed numeric decoding

Typed JSON decoding interprets wire tokens according to the explicitly
requested descriptor. This is parsing into a requested representation, not
coercion of an already existing SPL value.

- Signed 64-bit integers are decoded without first passing through JavaScript
  `number`.
- A concrete numeric target determines the requested representation, subject
  to its validity rules.
- For `int | float`, integer tokens select `int`; decimal or exponent tokens
  select `float`.
- Invalid ranges, nonfinite results, and ambiguous distinct union decoding
  targets fail explicitly.

JSON does not carry nominal numeric type tags. SPL does not promise that its
type distinctions survive arbitrary external JSON normalization or rewriting.

### Errors and model repairs

Parsing, schema validation, typed decoding, and complete hydration validation
belong to one `ask` validation/repair pipeline.

- Preserve zero repairs by default, the existing maximum of five additional
  attempts, and existing restrictions on repair support.
- A typed decoding failure, including integer overflow, uses the configured
  repair budget just like another output-validation failure.
- Publish no partially validated or partially hydrated result.
- Assignment, call, mutation, and ordinary validation type errors do not
  trigger model retries.
- Diagnostics identify the source location and nested value path where
  applicable.

## Data projection and serialization

Class-to-data conversion is explicit. Classes must be projected before JSON
output; serializing an instance does not implicitly run its constructor,
hydrate it, or silently choose a schema.

`object(value)` creates a deep dynamic-data snapshot. Class-to-struct data
projection likewise produces a deep field snapshot for a schema-compatible
shape; required non-JSON fields cannot be silently discarded to satisfy a
struct contract.

- Projections never mutate the source or share mutable children with it.
- Named function-valued properties, including methods, are dropped by
  dynamic object projection.
- Functions at the root or inside arrays are rejected rather than removed
  or replaced, so array indices do not change.
- Cyclic data graphs are rejected explicitly, not encoded as references.

Function-valued properties are not globally ignored by the ordinary serializer.
Existing untyped function serialization remains unchanged.

Typed numeric JSON output is lossless:

- Integers are emitted as exact decimal integer tokens.
- Floats use decimal or exponent spelling, including `1.0` for an integral
  float, preserving SPL's numeric-union token distinction.
- Legacy numeric serialization remains unchanged.

The round-trip guarantee applies to SPL's own typed encoder/decoder, not to
arbitrary external JSON transformations.

## Migration and non-goals

This revision explicitly withdraws source compatibility with brace-based
programs, including programs without annotations. It does not otherwise turn
untyped bindings into statically typed ones or replace legacy number and
function serialization behavior.

Implementation must include:

- A manual migration guide covering blocks, dictionary expressions, and the
  distinction between class schemas and struct schemas.
- Clear diagnostics for removed syntax.
- Migration of maintained examples, tests, and editor snippets.

Deferred features:

- A general-purpose automatic source converter.
- Inheritance, overloads, generics, and advanced higher-order inference.
- Forward declarations and recursive data schemas.
- Unchecked casts, implicit numeric promotion, automatic validation repair,
  and semantic-correctness guarantees.

## Acceptance criteria

The eventual implementation is complete only when tests establish these
contracts, including:

1. Known typed errors stop execution before any provider call, while untyped
   bindings remain dynamically assignable.
2. Typed `1` and `1.0` have distinct representations; incompatible numeric
   assignment and implicit mixed arithmetic fail.
3. Both signed-64-bit limits round-trip exactly through typed JSON; overflow,
   fractional integer conversion, and nonfinite floats fail.
4. Unicode-scalar `char` checks differ correctly from UTF-16 length and
   grapheme count; booleans are not integers.
5. Struct fields are exact and required, including nullable fields. Advisory
   `min`/`max` violations alone do not reject data; raw schema constraints do.
6. Every mutation path, including untyped aliases and bulk mutators, preserves
   typed contracts without partial updates.
7. Mutable type tests install contracts atomically; failed tests leave values
   unchanged; narrowing expires after relevant assignments and calls.
8. Callable compatibility, argument/result guards, and dictionary method-name
   precedence follow the specified rules.
9. Hydration skips constructors only for opted-in classes, validates all fields
   before publication, and is distinct from `schema=struct(Class)`.
10. Ambiguous distinct union decoding and unsupported schema targets fail
    explicitly; unsupported targets fail before provider calls.
11. Typed decoding failures use the existing repair budget, without extending
    model retries to ordinary type errors.
12. Projections are deep snapshots; function properties, array/root functions,
    cycles, and typed numeric output follow their distinct serialization rules.
13. Indentation and object-expression syntax work across maintained language
    surfaces; removed syntax has migration diagnostics, while preserved
    untyped runtime behavior has regression coverage.
