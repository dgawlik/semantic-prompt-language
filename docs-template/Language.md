# Language

SPL is a small Python-like language with brace-delimited blocks. This page covers the code inside
`spl` fences: values, bindings, control flow, functions, built-ins and exact tools.

## Values and strings

Values are `None`, `True`/`False`, numbers, strings, lists, dicts with string keys, and functions.
Statements end at a newline or `;`. `#` starts a comment, and a trailing `\` continues a line.

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
for i in range(3) {
    count += i
}
let result = {
    let count = 10
    count + 1
}
success [count, result]  # [3, 11]
```

Declare a result before a block when the block should set it:
`let answer = None` and then `answer = ...` inside.

## Control flow and expressions

`if`/`elif`/`else`, `for`, `while`, `break`, `continue` and `pass` behave as in Python, with braces.
`for k, v in items(d)` unpacks pairs. Blocks and `if` are expressions that yield their last
expression, or `None`. `{}` is an empty dict; `{ pass }` is an empty block.

```spl
let score = 6
let label = if score > 7 { 'high' } elif score > 3 { 'medium' } else { 'low' }
for key, value in items({'a': 1, 'b': 2}) {
    log(key, value)
}
```

## Functions

`def` defines a function with lexical closures and recursion. Functions return `None`
unless they use an explicit `return`.

```spl
def fib(n) {
    if n < 2 {
        return n
    }
    return fib(n - 1) + fib(n - 2)
}
```

## Runtime inputs: $env and $args

`$env.NAME` or `$env['NAME']` reads a process environment variable as a string.
`$args[0]`, `$args[1]`, … read the CLI's repeated `--arg` values. Missing variables and
out-of-range indexes return `None`. Both are read-only snapshots and are never persisted by stores.

```spl
let target = $args[0]
if target == None {
    target = $env.USER
}
```

## Logging

`log(value, ...)` writes to stderr at info level. `log(level=debug)(value)` selects `error`, `info` or
`debug`. Debug output appears only with `--log-level debug`; `--silent` hides all logs.

## Built-in functions

| Function | Description |
| --- | --- |
| `len(x)` `type(x)` | Length; type name |
| `str(x)` `int(x)` `float(x)` `bool(x)` `list(x)` | Conversions |
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
restrict exec 'git' {
    diff = shell('git diff --cached')
}
```

`shell` runs through the platform shell (`cmd.exe` on Windows, `/bin/sh` elsewhere).
External state can still change between runs; "exact" means no model is involved.
