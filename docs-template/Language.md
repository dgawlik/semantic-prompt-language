# Language basics

The deterministic core of SPL: Python-flavoured expressions, braces, lexical block scopes, and explicit assignment. Model calls are distinct expressions, not implicit behavior of ordinary functions.

Read a script by its boundaries: `let` names values, `ask` and `think` mark model
judgment, `agent` opts into model-selected actions, and `assert` exposes acceptance
rules. Keep routine computation in ordinary code so the variable parts and their
guards remain easy to spot.

**Design decisions at a glance**

* **Blocks use braces**; the opening `{` must be on the same line as its keyword. Statements end at a newline (or `;`).

* **`let` declares/redeclares a local**; `x = …` and `x += …` update an existing local. Collection assignment uses `d['k'] = 2`, without `let`.

* **Block scoping:** each block has a child scope. Reads and assignments search outward; `let` shadows enclosing names. See [Scope](#scope).

* **`return` exits immediately** from any scope — the function, or the whole script at the top level.

* **Every string interpolates** `{expr}`.

* Unknown/duplicate modifier names, `break` outside loops, and `try` without `except` are syntax errors. Modifier values are expressions validated at runtime.

* Model commands use `ask(options) 'prompt'`, `think(options) 'prompt'`, and
  `agent(options) 'prompt'`. Named options support multiple lines and trailing commas.
  With no options, omit the group or use `()`. Prompts remain outside the parentheses.

## Program structure

A script is an optional `@(…)` directive header followed by statements. `#` starts a comment that runs to the end of the line.

```spl
@(model='gpt-5.5')        # header: only allowed before the first statement

let greeting = 'hello'  # a statement
log(greeting)           # an expression statement
```

### Directives

The header directive is `@(model='...')`, whose value must be a plain string without
interpolation. Parentheses may span lines and have a trailing comma.
Precedence is CLI `--model`, per-call `model`, header, then SDK default.

## Variables

`let name = expression` declares or redeclares a local. Assignment and compound operators (`+= -= *= /= //= %=`) update existing locals; they do not use `let`. Member/item targets also omit `let`. Unknown reads and assignment to an undeclared local are catchable runtime errors.

```spl
let count = 0
count += 1                # same as: count = count + 1
count = 5                 # assignment to an existing local

let user = {'name': 'Ada'}
user.name = 'Grace'    # member assignment
user['age'] = 36       # item assignment
```

### Runtime inputs: `$env` and `$args`

These special variables are available in every scope, including functions and string
interpolation. They are snapshots taken at the start of each run, not ordinary bindings.

* `$env` is a read-only dict of process environment variables. `$env.NAME` and
  `$env['NAME']` return a string, including `''` for a set-but-empty variable.
  An absent name returns `None`. Bracket access also supports names containing punctuation.
  Environment names use the spelling exposed by the host process.
* `$args` is a read-only list of strings supplied with repeated CLI `--arg` options,
  in command-line order. The script path and interpreter options are not included.
  Without `--arg`, it is empty. Out-of-range integer indexes return `None`;
  negative indexes count from the end, as with ordinary lists. Non-integer indexes fail.

```bash
spl --arg=first --arg="two words" example.spl
```

```spl
let date = $env.date
log($args[0])             # first
log($args[1])             # two words
log($args[2])             # None
log("date={date}, first={$args[0]}")
```

The special names cannot be declared, rebound, or used as parameters or loop variables.
Assignments to their members/items and mutating methods raise catchable `runtime_error`,
even through aliases such as `let args = $args`. Use `$args.copy()`, `list($args)`,
`$args[:]`, or `$env.copy()` to create a normal mutable copy. Copies have ordinary
missing-index/key errors; this does not change ordinary dict/list behavior.

The runtime does not automatically add either value to a variable store. Explicitly
assigning a value or alias to a top-level variable can persist it, so do not persist,
log, or interpolate sensitive environment values into prompts unintentionally.
Replay uses the current run's inputs, not recorded environment variables or arguments.
Other `$`-prefixed variable names are syntax errors.

### Scope

`let name = …` binds in the current scope. Every block creates a lexical child scope. Inner declarations shadow enclosing names and cannot be accessed from a parent scope. Reads and assignments search outward through the full lexical chain for the first declaration. There is no hoisting: a local appears when execution binds it.

```spl
let color = 'Blue'
{
    let color = 'Red'
    log(color)             # Red
}
log(color)                 # Blue: the child declaration did not change it
```

Conditionals, loops, exception handlers, and guidance/restriction blocks follow the same rule. Each loop iteration has fresh locals, including its loop variables. Caught failure names belong to their handler. To keep a result, declare it outside and assign inside:

```spl
let color = None
enforce 'Your favorite color is blue' {
    color = ask(len='word') 'What is your favorite color?'
}
log(color)                 # the answer

let response = None
try {
    response = ask(fmt='object') 'A joke about programmers'
} except err {
    response = {'setup': 'none', 'punchline': err.reason}
}
log(response)              # visible here, whichever branch ran
```

`enforce` provides positive scoped prompt guidance and `forbid` provides negative guidance. Both create child variable scopes, but neither verifies model compliance.

Functions close over their lexical defining scope. They can read or assign enclosing declarations; `let` instead declares locally and shadows an enclosing name. Lists and dicts remain mutable across scopes.

### Block and conditional expressions

A block or selected `if`/`elif`/`else` branch yields its final expression. An empty branch, a block ending in a statement, or an unmatched conditional returns `None`. Only the selected branch runs. `{}` remains an empty dictionary; use `{ pass }` for a block yielding `None`. Functions still require explicit `return`.

```spl
let result = if ask(fmt='boolean') 'Today is Friday?' {
    ask 'Haiku on variance'
} else {
    ask 'Sentence on passing time'
}
let length = {
    let text = result
    len(text)
}
log(level=debug)(length)
success result
```

### Persistence

Top-level variables can be saved between runs with opt-in `--store`, even after a script failure. Persistence is not a transaction or an action log. It is allowed during workflow trace replay, but forbidden during legacy generation replay. See [CLI & runtime](CLI.md#variable-store).

## Types & values

| `type()` | Literals | Notes |
| --- | --- | --- |
| `'None'` | `None` | Falsy. |
| `'bool'` | `True` `False` | Python spelling. |
| `'number'` | `42` `3.14` `1e-3` | One numeric type. `int()` truncates, `float()` parses. |
| `'str'` | `'a'` `"a"` `'''a'''` `r'a'` | Indexed by Unicode character. |
| `'list'` | `[1, 2, 3]` | Mutable, trailing comma allowed. |
| `'dict'` | `{'a': 1}` | Keys must be strings. Insertion ordered. Also readable as `d.a`. |
| `'function'` | `def f(x) { … }` | First-class values. |

Model calls can request typed output with `fmt='integer'`, `'float'`, `'array'`, `'object'`, `'text'`, or `'boolean'`. Non-text formats validate strict JSON and return ordinary SPL values; `fmt='json'` accepts any JSON value. See [output formats and examples](LLM-commands.md#output-formats).

**`type()` returns a string**

Compare it with a quoted name: `type(x) == 'list'`. There is no separate `int`/`float` distinction — both report `'number'`.

### Truthiness

`None`, `False`, `0`, empty strings, empty lists and empty dicts are falsy. Everything else (including functions) is truthy.

## Strings & interpolation

All four quote styles interpolate `{expression}`. Any expression is allowed, including calls and indexing. Substitution is *as is*: strings raw, `True`/`False`/`None` in Python spelling, lists and dicts as JSON.

```spl
let items = ['a', 'b']
let n = 2
log("found {n} items: {items}")          # found 2 items: ["a","b"]
log("first is {items[0].upper()}")       # first is A
log("{{literal}} and \{also literal\}")  # {literal} and {also literal}
log(r'{"raw": "no {interpolation} here"}')
```

### Quote styles & escapes

| Form | Behaviour |
| --- | --- |
| `'…'` `"…"` | Single line; escapes and interpolation. |
| `'''…'''` `"""…"""` | May span lines; escapes and interpolation. Ideal for prompts. |
| `r'…'` | Raw: no escapes, no interpolation. |

Valid escapes: `\n \t \r \0 \\ \' \" \{ \}`. Anything else is a syntax error, and so is a stray single `}` in a string — write `}}` or `\}`.

## Operators

Lowest to highest precedence:

| Operators | Description |
| --- | --- |
| `x if cond else y` | Conditional expression. |
| `or` | Logical or (short-circuit). |
| `and` | Logical and (short-circuit). |
| `not` | Logical negation. |
| `== != < <= > >= in` `not in` | Comparison and membership. `==` is deep for lists and dicts. Ordering works on numbers, strings and lists. |
| `+ -` | Add / subtract. `+` also joins two strings or two lists — mixing types is an error (use interpolation or `str()`). |
| `* / // %` | Multiply, divide, floor-divide, modulo. `*` repeats strings and lists. Division by zero is a failure. |
| `-x +x` | Unary sign. |
| `**` | Power. |
| `f(x)` `a[i]` `a[i:j]` `a.b` | Call, index, slice, member. Negative indexes count from the end. |

```spl
let xs = [10, 20, 30, 40]
log(xs[-1])                  # 40
log(xs[1:3])                 # [20,30]
log('ab' * 3)                # ababab
log('x' in 'text')           # True
log('role' in {'role': 1})   # True  (dicts test keys)
log(7 // 2, 7 % 3, 2 ** 10)  # 3 1 1024
let label = 'many' if len(xs) > 3 else 'few'
```

## Control flow

### if / elif / else

```spl
if score >= 90 {
    let grade = 'A'
} elif score >= 80 {
    let grade = 'B'
} else {
    let grade = 'C'
}
```

### for & while

`for` iterates lists, strings (characters) and dicts (keys). Several names unpack list items, which pairs well with `items()` and `enumerate()`. `break`, `continue` and `pass` work as in Python.

```spl
for i in range(3) { log(i) }

for code, language in items({'de': 'German', 'pl': 'Polish'}) {
    log("{code} = {language}")
}

let tries = 0
while tries < 3 {
    tries += 1
    if tries == 2 { continue }
}
```

## Functions

Define with `def`. Functions take positional arguments only (the count is checked), return `None` unless `return` is used, can recurse (up to a maximum call depth of 200) and close over their defining scope. `return` leaves the innermost function immediately, from inside any nested block, loop, `try` or constraint block; at the top level of a script it ends the script like `success`, optionally with a value.

```spl
def fib(n) {
    if n < 2 { return n }
    return fib(n - 1) + fib(n - 2)
}

def is_valid(msg) {
    let first = msg.splitlines()[0]
    return len(first) <= 72 and ': ' in first
}
```

Functions are the right place for validators — the deterministic code that decides whether to trust an LLM answer. See [commit-message](Examples.md#commit-message).

## Built-ins

A compact standard library is available without imports: `len`, `range`, `sorted`, `json_parse`, `log`, and Python-style methods on strings, lists and dicts. The full list is on the [Built-ins](Builtins.md) page.
