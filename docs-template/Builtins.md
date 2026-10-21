# Built-ins

A deliberately small, Python-flavoured standard library — enough to validate, reshape and report on LLM output without leaving the language.

**Semantics in one line**

An *iterable* is a list, a string (its characters) or a dict (its keys). Calling a built-in with the wrong number or type of arguments is a catchable `runtime_error`.

## Special variables

| Variable | Description |
| --- | --- |
| `$env` | Read-only process-environment dict snapshot. `$env.NAME` or `$env['NAME']` returns a string, or `None` if absent. Empty strings remain empty. |
| `$args` | Read-only list of strings from repeated CLI `--arg` options, in order; empty by default. Out-of-range integer indexes return `None`. Negative indexes count from the end. |

Both work in any scope and interpolation. Aliases remain read-only; assignments and
mutating methods fail with `runtime_error`. Non-mutating dict/list operations work
normally, and `.copy()` creates a mutable copy. The special names cannot be rebound.
See [runtime inputs](Language.md#runtime-inputs-env-and-args) and [passing arguments](CLI.md#script-arguments-and-environment).

## Functions

### Raw tools: no model round-trip

`read_file(path)`, `write_file(path, content)`, `web_fetch(url)`, `web_search(query)`, and `shell(command)` are ordinary positional functions with required string arguments. They use active restrictions, return raw text (write returns confirmation), and never invoke a model. Shell returns combined stdout/stderr or raises `tool_error` on nonzero exit. Raw results are not truncated. See [tool contracts](LLM-commands.md#exact-raw-tools).

Use a separate generation expression to interpret output. Use explicit `agent` when the model should choose actions. Replay permits only `read_file`; all other raw tools are blocked.

### Types & conversion

| Signature | Description |
| --- | --- |
| `len(x)` | Length of a string (in characters), list or dict. |
| `str(x)` | Display form: strings as is, `True`/`False`/`None`, numbers plainly, lists and dicts as JSON. |
| `int(x)` | Truncates a number; converts `True`/`False` to 1/0; parses an integer string. |
| `float(x)` | Numbers pass through; booleans become 1/0; numeric strings are parsed. |
| `bool(x)` | Truthiness of any value. |
| `type(x)` | One of `'None'` `'bool'` `'number'` `'str'` `'list'` `'function'` `'dict'`. |
| `list(x)` | A new list from any iterable. |

### Numbers & sequences

| Signature | Description |
| --- | --- |
| `range(stop)`; `range(start, stop[, step])` | List of integers; `step` may be negative but not zero. |
| `abs(n)` | Absolute value. |
| `round(n[, digits])` | Without `digits`: rounds half to even (`round(2.5)` is `2`). With `digits`: rounds to that many decimal places. |
| `min(x)` / `max(x)`; `min(a, b, …)` | Smallest / largest of an iterable or of the arguments. Empty input is an error. |
| `sum(x)` | Sum of an iterable of numbers. |
| `sorted(x[, reverse])` | New sorted list. Pass a truthy second argument for descending order. |
| `reversed(x)` | New list in reverse order. |
| `enumerate(x)` | List of `[index, item]` pairs. |
| `zip(a, b, …)` | List of tuples-as-lists, as long as the shortest input. |
| `any(x)` / `all(x)` | True if any / every element is truthy. |

### Dicts & JSON

| Signature | Description |
| --- | --- |
| `keys(d)` `values(d)` `items(d)` | Lists of keys, values, or `[key, value]` pairs. |
| `json_parse(s)` | Parses a JSON string into a value. Invalid JSON raises `runtime_error`. |
| `json_stringify(v[, indent])` | Serializes to JSON, optionally pretty-printed with `indent` spaces. |

### Logging

| Signature | Description |
| --- | --- |
| `log(a, b, …)`; `log{level=debug}(a, b, …)` | Writes the `str()` of each argument, space-separated, to **stderr**. Plain calls default to info; the modifier selects `error`, `info` or `debug`, using a bare name, string or expression. The level is evaluated once and validated before arguments. Debug messages appear only at debug log level; silent suppresses all logs. Returns `None`. Never pollutes stdout. |

## Methods

Methods are called with dot syntax on strings, lists and dicts. Strings are immutable; list and dict methods that say “in place” mutate the value and return `None`.

### String methods

| Method | Description |
| --- | --- |
| `upper()` `lower()` | Change case. |
| `title()` `capitalize()` | Title-case every word / capitalize the first character. |
| `strip()` `lstrip()` `rstrip()` | Trim whitespace from both / left / right. |
| `split([sep])` | Without a separator: split on runs of whitespace. With one: split on exactly that text (empty separator is an error). |
| `splitlines()` | Split on `\n` or `\r\n`. An empty string gives `[]`. |
| `join(items)` | `', '.join(parts)` — every item must be a string. |
| `replace(old, new)` | Replace all occurrences. |
| `startswith(s)` `endswith(s)` | Prefix / suffix test. |
| `find(s)` | Index of the first occurrence, or `-1`. |
| `count(s)` | Number of non-overlapping occurrences. |
| `isdigit()` | True for a non-empty string of digits `0-9`. |

### List methods

| Method | Description |
| --- | --- |
| `append(x)` | Add an item at the end (in place). |
| `extend(iterable)` | Append all items of another iterable (in place). |
| `insert(i, x)` | Insert before index `i` (in place). |
| `pop([i])` | Remove and return the item at `i` (default: last). |
| `remove(x)` | Remove the first item equal to `x`; error if missing (in place). |
| `index(x)` | Index of the first equal item, or `-1`. |
| `count(x)` | Number of equal items. |
| `sort([reverse])` `reverse()` | Sort / reverse in place. |
| `copy()` `clear()` | Shallow copy / empty the list in place. |

### Dict methods

| Method | Description |
| --- | --- |
| `keys()` `values()` `items()` | Lists of keys, values, `[key, value]` pairs. |
| `get(key[, default])` | Value for `key`, or `default` (`None` if omitted). The safe alternative to `d.key`, which fails on a missing key. |
| `pop(key[, default])` | Remove and return a key; error if missing and no default. |
| `update(other)` | Merge another dict in (in place). |
| `copy()` `clear()` | Shallow copy / remove all keys. |

**Safe access to model output**

Models forget keys. Prefer `r.get('label', 'unknown')` or an explicit `assert 'label' in r` over `r.label` when you are validating parsed `fmt='object'` output.

## Putting it together

```spl
let counts = {}
for t in results {
    if t['label'] in counts { counts[t['label']] += 1 } else { counts[t['label']] = 1 }
}

let lines = []
for label in sorted(keys(counts)) {
    lines.append("- {label}: {counts[label]}")
}
log('\n'.join(lines))
```
