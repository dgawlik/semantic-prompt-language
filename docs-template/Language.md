# Language

SPL is a small Python-like language with colon-and-indentation blocks. This page covers the code inside
`spl` fences: values, bindings, control flow, functions, built-ins and exact tools.
Markdown blockquotes use a single optional `@CTL(restrict=..., enforce=..., forbid=..., model=..., reasoning=...)`
header for [agent controls](LLM-commands.md#blockquotes). These controls are separate from SPL syntax;
human input in blockquotes is requested in plain language, without a special marker.

## Values and strings

Values include `None`, `True`/`False`, numbers, strings, lists, dictionaries with string keys,
functions, immutable type descriptors and nominal class instances.
Simple statements end at a newline or `;`. `#` starts a comment, and a trailing `\` continues a line.

```spl 
assert int(1.0) == 1
assert str(float(1)) == '1.0'
assert bool(1) == True 
assert bool(0.0) == False

assert any([0, 0.0, '', [], object()]) == False
assert all([1, 1.0, 'hello', [1], object:
    'x': 1
]) == True

let lst = []
for i in range(0, 10, 2):
    lst.append(i)
assert lst == [0, 2, 4, 6, 8]

let name = 'Ada'
let greeting = "Hello, {name.upper()}!"     # {expr} interpolates in every quote style
let literal = 'Use {{name}} as a placeholder' # doubled braces are literal
let raw = r'C:\temp\{not interpolated}'     # raw strings: no escapes or interpolation
let block = '''
Triple-quoted strings span lines.
'''

let split1 = 'hello world'
assert split1.split() == ['hello', 'world']
assert split1.split('e') == ['h', 'llo world']

let fruits = ['apple', 'orange', 'grape']
assert ','.join(fruits) == 'apple,orange,grape'

let speech = '''Hello!

Today is a new day. 

My recent work shows... 

What I would like to propose'''

assert speech.splitlines() == ["Hello!","","Today is a new day. ","",
  "My recent work shows... ","", "What I would like to propose"]

let hello = "Hello world"
assert hello.replace('world', "WORLD!!!") == 'Hello WORLD!!!'
assert hello.find('world') == 6
assert len(hello) == 11

let word = 'Word'
assert word.lower() == 'word'
assert word.upper() == 'WORD'

let totrim = '  word '
assert totrim.strip() == 'word'
```

Escapes: `\n` `\t` `\r` `\0` `\\` `\'` `\"` `\{` `\}`. Python-style operators work as expected:
`+ - * / // % **`, comparisons, `in`/`not in`, `and`/`or`/`not`, `a if cond else b`, indexing,
slicing with negative indexes, and `d.key` as a shorthand for `d['key']`.


## Lists 

```spl
let lst = [1,2,3,4];

# Indexing and searching for index
let secondElement = lst[1];
let thirdIndex = lst.index(3);
log('Second element: {secondElement}');
log('Threes index: {thirdIndex}')

# List concatenation
let l2 = [5,6];
let combined = lst + l2
log('Extend list {combined}')

# Clone list and pop second element
let removedSecond = combined.copy()
removedSecond.pop(1)
log('Removed second: {removedSecond}')

# Remove elements from the end
let removedLast = combined.copy()
removedLast.pop(-1)
log('Removed last: {removedLast}')

# Remove by value
let remove3 = combined.copy()
remove3.remove(3)
log('Removed 3: {remove3}')

# Remove by nonexisting throws exception
try:
    let remove7 = combined.copy()
    remove7.remove(7)
except e:
    log(e.reason)

# Insert value at index
let ins = [1,10]
ins.insert(1, 100)
log('Inserted: {ins}')

# Clear list
ins.clear()
log('Cleared: {ins}')

let numbers = [1,2,3,4,5]

let f = numbers.filter(lambda i: i % 2 ==0)
assert f == [2, 4]

let m = f.map(lambda i: i*2)
assert m == [4, 8]

let r = m.reduce(lambda acc, i: acc + i)
assert r == 12
```

## Objects 

```spl 
# Create object
let test = object:
    'a': 1
    'b': 2
log('Test object {test}')

# Assign values to keys
test['c'] = 3
test.d = 4
log('Addition: {test}')


# Remove by key
test.pop('c')
test.pop('d')
log('Removal: {test}')

# Iterate by values
for v in test.values():
    log("Test value: {v}")

# Iterate by keys
for k in test.keys():
    log('Test key: {k}')

# Iterate by key, value pairs
for k, v in test.items():
    log('Test -> k = {k}, v = {v}')


# Copy and clear
let cpy = test.copy()
cpy.clear()
log('Cleared: {cpy}')
```


## Bindings and scopes

`let` declares a name in the current block; plain assignment updates the nearest existing declaration.
Every block is a child scope, so inner `let` shadows outer names and does not leak out.
Each loop iteration gets fresh variables.

```spl
let count = 0
for i in range(3):
    count += i
let result = :
    let count = 10
    count + 1
success [count, result]  # [3, 11]
```

Declare a result before a block when the block should set it:
`let answer = None` and then `answer = ...` inside.

## Control flow and expressions

`if`/`elif`/`else`, `for`, `while`, `break`, `continue` and `pass` use Python-like layout,
but keep SPL's lexical scopes.
`for k, v in items(d)` unpacks pairs. Blocks and `if` are expressions that yield their last
expression, or `None`. Anonymous value-producing blocks begin with a bare `:`, as in `result`
above. `object()` is an empty dictionary; a block containing only `pass` yields `None`.

```spl 
let i = 0
while True:
    let msg = if not i % 2:
        '{i} is Even'
    elif i == 5:
        i += 1
        continue
    elif i == 11:
        break
    else:
        '{i} is Odd'
    log(level='debug')(msg)
    i += 1

let numbers = list(range(0,10,2))
for i, n in enumerate(numbers):
    log('{i} = {n}')
```

## Functions

`def` defines a function with lexical closures and recursion. Functions return `None`
unless they use an explicit `return`. Functions are first class citizens and can be passed around. `lambda` defines lambda function defined inline.

```spl 
def fib(n):
    return if n < 2:
        1
    else:
        fib(n-1) + fib(n-2)

log(fib(10))

def iterate(from, to, f):
    for n in range(from, to):
        log(f(n))

iterate(9,10,fib)

iterate(1, 10, lambda x: x*2 + 3)
```

## Gradual typing

Annotations are optional enforced contracts, not advisory lint hints. Untyped bindings remain
dynamic. Known typed violations block execution before model calls; unknown values are validated
at typed boundaries without coercion, defaults or field removal.

Built-in types and existing type declarations remain available after `if`, loops, and
`try`/`except` blocks. An untyped alias used as an annotation must still identify the same
type on every possible control-flow path.

### Types at a glance

| Type | Accepted values |
| --- | --- |
| `int` | Signed 64-bit integers; checked arithmetic, no overflow wrapping |
| `float` | Finite binary64 numbers, distinct from `int` |
| `str` | Strings |
| `char` | Strings containing exactly one Unicode scalar value |
| `bool` | `True` or `False`, not integers |
| `None` | The null value, not an absent field |
| `object` | Dynamic string-keyed dictionaries, not nominal class instances |
| `list[T]` | Lists whose elements satisfy `T` |
| `A \| B` | Values satisfying either member; narrow before member-specific operations |
| `fn(T1, T2) -> R` | Callables with the declared parameter and return contracts |

Typed literals select the representation: `let count: int = 2`, but
`let ratio: float = 2.0`. Neither `let count: int = 2.0` nor
`let ratio: float = 2` is valid. Untyped numbers keep their existing representation;
use `int(value)` or `float(value)` explicitly to enter typed numeric code.
`int(...)` rejects fractions, booleans and out-of-range values; conversion to `float`
can lose integer precision. Mixed `int`/`float` arithmetic requires explicit conversion.
Integer `/` produces a float. Counts from `len` and `range` remain untyped numbers.

### Transparent type aliases

Declare read-only, transparent aliases with optional semantic advice:

```spl 
let a = 10
let b: int = int(a)
let c: float = float(b)


type Money = int [minimum=0, desc='Amount in cents']
type Prices = list[Money]
type MaybeMoney = Money | None
let subtotal: Money = 1250
let computed: Money = 0
computed += subtotal
let prices: Prices = [subtotal, computed]
let discount: MaybeMoney = None

def computeDiscount(total: Money, 
                    discount: MaybeMoney) -> Money:
    let discountWithDefault = if isinstance(discount, None):
        int(10)
    else:
        validate(discount, Money)
    return int(total * (100-discountWithDefault)/100)


log(computeDiscount(1000, None))

```

Aliases accept the same values and operations as their underlying types, without implicit
conversion. Advice is included in generated schemas' descriptions, including when an alias
is used as a field or list element; it does not enforce extra constraints. Aliasing an alias
inherits its advice, with newly supplied keys overriding inherited keys. Field advice is
appended separately. `type(value)` remains the type-name builtin.

### Enums, structs and functions

```spl 
enum Greeting = 'hello' | 'world'

# let g: Greeting = 'hi' // error
let g: Greeting = 'hello'
log(g)

struct Test:
    num: int 
    desc: str 

let t: Test = object:
    'num': 1
    'desc': 'hi'

log(t)

let o1 = object:
    'a': 1
    'b': [2,3]
let o2 = object:
    'a': 1
    'b': [2,3]

assert o1 == o2
   
```

Enums accept matching strings directly and are subtypes of `str`. Structs are structural:
equivalent field contracts are interchangeable. Fields are exact and required; nullable does
not mean absent, so `note` above must be present even when it is `None`.
Metadata such as `str [min=2, desc='Name']` is model advice, not a validity constraint.
Use `assert` for business rules, or explicit JSON Schema for strict data constraints.
Function parameters, results and callable fields are checked at their typed boundaries.
A union value can be assigned or passed to another union, including a list element contract,
when every source alternative is accepted by the destination. Member order does not matter;
an alternative missing from the destination must be narrowed first.

### Validation, narrowing and mutation

`validate(value, Type)` checks values and returns a typed view, or fails. For a class
target it explicitly converts structural field data into a nominal instance.
`isinstance(value, Type)` tests without converting and narrows within a branch:

```spl
def describe(value: int | str) -> str:
    if isinstance(value, str):
        return value.upper()
    return 'Integer: {value}'

let data = json_parse(r'{"color":"blue","note":null}')
struct Selection:
    color: Color
    note: str | None
let selection = validate(data, Selection)
```

Neither operation converts untyped numbers. `isinstance` never converts structural data
into a class. `validate(data, Class)` checks all declared fields and creates a complete
instance without running the constructor, including for ordinary classes. Missing or extra
fields fail; no defaults or numeric conversions are inserted. Class conversion also applies
to nested fields, lists and union members; distinct ambiguous conversions fail.
Converted field dictionaries and containers are copied rather than rewriting the source.

Successful tests and validation install persistent contracts on mutable values.
These survive untyped aliases, index/member writes and bulk mutators. For example, an
untyped alias cannot append an integer to a `list[str]`. Mutable contracts are invariant:
`list[Color]` cannot be used as `list[str]`. Failed bulk mutations leave the whole value
unchanged. Narrowing expires after relevant assignment or potentially mutating calls.

### Classes and structural projections

Classes have nominal identity, declared fields, and implicitly bound `self` in methods.
Normal construction calls the constructor named after the class and must initialize every field.
Use `hydratable class` only when constructor-free JSON hydration is safe:

```spl
hydratable class Person:
    name: str

    def Person(name: str):
        self.name = name

    def greeting() -> str:
        return 'Hello {self.name}'

let person: Person = Person('Ada')
let fields = validate(object(person), struct(Person))
let snapshot = object(person)
success snapshot
```

`struct(Person)` describes structural field data, not a `Person` instance.
To explicitly turn that data into an instance, use `validate(data, Person)`:

```spl
class GeneratedPerson:
    name: str
    age: int
    def label() -> str:
        return '{self.name} at age {self.age}'
let data = ask(schema=struct(GeneratedPerson)) 'Generate person data'
let person: GeneratedPerson = validate(data, GeneratedPerson)
log(person.label())
```

This conversion bypasses constructor normalization and side effects. Direct
`schema=GeneratedPerson` still requires a `hydratable class` declaration.

`object(person)` makes a deep snapshot and drops named function properties.
Validate that snapshot against `struct(Person)` when a checked field view is needed;
validation rejects missing required fields, including callable fields dropped by projection.
Use explicit projection before serializing class instances.
See [Schemas and repairs](LLM-commands.md#schemas-and-repairs) for typed model output,
[typed-data.md](../lang/examples/typed-data.md) for an offline workflow, and
[Typing migration](Migration.md) for the full migration rules.

## Runtime inputs: $env and $args

`$env.NAME` or `$env['NAME']` reads a process environment variable as a string.
`$args[0]`, `$args[1]`, … read the CLI's repeated `--arg` values. Missing variables and
out-of-range indexes return `None`. Both are read-only snapshots and are never persisted by stores.

```spl
let target = $args[0]
if target == None:
    target = $env.USER
```

## Logging

`log(value, ...)` writes to stderr at info level. `log(level=debug)(value)` selects `error`, `info` or
`debug`. Debug output appears only with `--log-level debug`; `--silent` hides all logs.
Objects and lists are logged as indented JSON, including when mixed with text arguments.
Every continuation line carries the same log tag. Terminal output colors JSON tokens;
redirected logs are plain text by default. See [console formatting](CLI.md#output-and-exit-codes).

## Built-in functions

| Function | Description |
| --- | --- |
| `len(x)` `type(x)` | Length; type name |
| `str(x)` `int(x)` `float(x)` `bool(x)` `list(x)` | Conversions |
| `object()` `object(x)` | Empty dictionary; deep dynamic-data snapshot |
| `validate(x, T)` `isinstance(x, T)` | Validation with explicit struct-to-class conversion; non-converting type testing |
| `struct(Class)` | Structural descriptor for declared class fields, not nominal hydration |
| `range(stop)` `range(start, stop[, step])` | List of integers |
| `abs(x)` `round(x[, digits])` `min(...)` `max(...)` `sum(list)` | Numbers |
| `sorted(list[, reverse])` `reversed(list)` `enumerate(list)` `zip(a, b, ...)` | Sequences |
| `any(list)` `all(list)` | Truthiness checks |
| `keys(d)` `values(d)` `items(d)` | Dict views as lists |
| `json_parse(text)` `json_stringify(value[, indent])` | Strict JSON |
| `log(...)` | Logging, see above |

Methods:

| Type | Methods |
| --- | --- |
| String | `upper` `lower` `strip` `lstrip` `rstrip` `title` `capitalize` `isdigit` `split` `splitlines` `join` `replace` `startswith` `endswith` `find` `count` |
| List | `append` `extend` `insert` `pop` `remove` `index` `count` `reverse` `sort` `copy` `clear` `map` `filter` `reduce` |
| Dict | `keys` `values` `items` `get` `pop` `update` `copy` `clear` |

### List callbacks and lambdas

`lambda x: expression` creates an anonymous function that implicitly returns its
expression. Use `lambda: expression` for no parameters, or comma-separated names
for multiple parameters. Lambdas capture lexical bindings like `def`, can be stored
or returned, and accept a checked `fn(...) -> ...` contract. Parameter annotations
and default arguments are not supported in lambda syntax. Parenthesize a lambda
to call it immediately: `(lambda x: x + 1)(2)`.

These methods are available **only on lists**, not strings or dictionaries:

| Method | Behavior |
| --- | --- |
| `xs.map(callback)` | Return a new list containing `callback(item)` for each item |
| `xs.filter(callback)` | Return a new list of original items whose callback result is truthy |
| `xs.reduce(callback[, initial])` | Fold left with `callback(accumulator, item)` and return the final accumulator |

Callbacks can be lambdas, named functions, or built-ins. Map and filter pass only
the item, not an index. Reduce uses the initial value when supplied; otherwise it
starts with the first item. An empty list reduces to its initial value, including
`None`; without one it raises a runtime error. A singleton without an initial value
returns its item without calling the callback.

Callbacks run sequentially, including asynchronous operations, and failures propagate
normally. Each operation takes a shallow snapshot of the list before invoking callbacks;
it does not mutate the source itself. Changes a callback makes to the source do not
add or remove work from that snapshot. Filter preserves the original item references.

```spl
let xs = [1, 2, 3, 4]
let doubled = xs.map(lambda x: x * 2)
let evens = xs.filter(lambda x: x % 2 == 0)
let total = xs.reduce(lambda acc, x: acc + x, 0)
success [doubled, evens, total]  # [[2, 4, 6, 8], [2, 4], 10]
```

## Exact tools

Tools are ordinary functions that never call a model. Paths are relative to `--cwd`, and every
call is checked against active [restrictions](Safety.md#restrictions).

| Function | Result |
| --- | --- |
| `read_file(path)` | File contents as UTF-8 text |
| `write_file(path, content)` | Writes the file and returns a confirmation |
| `web_fetch(url)` | Response body as text (30 s timeout, up to 5 redirects) |
| `web_search(query)` | Search results as text |
| `shell(command)` | Combined stdout/stderr; a nonzero exit raises `tool_error` (120 s timeout) |

```spl
let diff = ''
restrict exec 'git':
    diff = shell('git diff --cached')
```

`shell` runs through the platform shell (`cmd.exe` on Windows, `/bin/sh` elsewhere).
External state can still change between runs; "exact" means no model is involved.
