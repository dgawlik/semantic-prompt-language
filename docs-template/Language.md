# Language

SPL is a small Python-like language with colon-and-indentation blocks. This page covers the code inside
`spl` fences: values, bindings, control flow, functions, built-ins and exact tools.

## Block syntax and migration

**Breaking change:** blocks use `:` followed by a newline and an indented, nonempty body, not
`{ ... }`. To migrate, replace each opening block brace with `:`, move any inline body onto its
own indented lines, and remove the closing brace. Align `elif`, `else` and `except` with their
opening statement. Replace empty bodies with `pass`; inline suites are not supported.

Use exactly four spaces per indentation level. Tabs in indentation are prohibited.
Unexpected indentation, a missing indented body, and a dedent that does not match a prior level
are syntax errors. Blank and comment-only lines are ignored: they neither open nor close a block
and do not count as a body. Semicolons can separate simple statements only, never block headers
or compound statements.

Dictionary literals `{...}` are removed: use `object:` with indented `key: value` entries,
and `object()` for an empty dictionary. String interpolation `{expr}` and JSON wire syntax
are unchanged. Newlines inside `()` and `[]` suspend ordinary indentation; explicit object
suites still delimit their entries. Explicit backslash continuation remains supported.
Statement blocks retain lexical child scopes, not Python assignment semantics; dictionary keys
do not form a lexical scope. See the [manual typing migration guide](Migration.md).

## Values and strings

Values include `None`, `True`/`False`, numbers, strings, lists, dictionaries with string keys,
functions, immutable type descriptors and nominal class instances.
Simple statements end at a newline or `;`. `#` starts a comment, and a trailing `\` continues a line.

```spl
let name = 'Ada'
let greeting = "Hello, {name.upper()}!"     # {expr} interpolates in every quote style
let literal = 'Use {{name}} as a placeholder' # doubled braces are literal
let raw = r'C:\temp\{not interpolated}'     # raw strings: no escapes or interpolation
let block = '''
Triple-quoted strings span lines.
'''
```

Escapes: `\n` `\t` `\r` `\0` `\\` `\'` `\"` `\{` `\}`. Python-style operators work as expected:
`+ - * / // % **`, comparisons, `in`/`not in`, `and`/`or`/`not`, `a if cond else b`, indexing,
slicing with negative indexes, and `d.key` as a shorthand for `d['key']`.

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
let score = 6
let label = if score > 7:
    'high'
elif score > 3:
    'medium'
else:
    'low'
let data = object:
    'a': 1
    'b': 2
for key, value in items(data):
    log(key, value)
if score < 0:
    pass
```

## Functions

`def` defines a function with lexical closures and recursion. Functions return `None`
unless they use an explicit `return`.

```spl
def fib(n):
    if n < 2:
        return n
    return fib(n - 1) + fib(n - 2)
```

## Gradual typing

Annotations are optional enforced contracts, not advisory lint hints. Untyped bindings remain
dynamic. Known typed violations block execution before model calls; unknown values are validated
at typed boundaries without coercion, defaults or field removal.

Built-in types and existing type declarations remain available after `if`, loops, and
`try`/`except` blocks. An untyped alias used as an annotation must still identify the same
type on every possible control-flow path.

Declare read-only, transparent aliases with optional semantic advice:

```spl
type Money = int [minimum=0, desc='Amount in cents']
let subtotal: Money = 1250
let computed: Money = 0
computed += subtotal
```

Aliases accept the same values and operations as their underlying types, without implicit
conversion. Advice is included in generated schemas' descriptions, including when an alias
is used as a field or list element; it does not enforce extra constraints. Aliasing an alias
inherits its advice, with newly supplied keys overriding inherited keys. Field advice is
appended separately. `type(value)` remains the type-name builtin.

```spl
enum Color = 'red' | 'green' | 'blue'
struct Entry:
    color: Color
    note: str | None
    callback: fn(str, int) -> str
def repeat(text: str, count: int) -> str:
    return text * count
let names: list[str] = ['Ada']
let count: int = 2
let ratio: float = 1.0
```

Struct fields are exact and required; nullable does not mean absent. Metadata such as
`str [min=2, desc='Name']` is model advice, not a validity constraint. `int` is signed 64-bit,
`float` is distinct finite binary64, and untyped numbers require explicit conversion to enter
either representation. Mutable contracts persist through untyped aliases and bulk mutators.
`validate(value, Type)` validates; `isinstance(value, Type)` tests without converting and supports
temporary branch narrowing. See [Typing migration](Migration.md) for numeric rules, callables,
classes, hydration and deep projections.

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
| `validate(x, T)` `isinstance(x, T)` | Non-converting validation and type testing |
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
| List | `append` `extend` `insert` `pop` `remove` `index` `count` `reverse` `sort` `copy` `clear` |
| Dict | `keys` `values` `items` `get` `pop` `update` `copy` `clear` |

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
