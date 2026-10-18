# spl-lang: Semantic Prompt Language interpreter

A Python-like language where LLM calls are part of the syntax. Everything outside LLM calls is deterministic; LLM
calls go through the GitHub Copilot SDK. See [../LANG-PRD.md](../LANG-PRD.md) for the full spec,
[docs/syntax.ebnf](docs/syntax.ebnf) for the grammar and the [documentation site](../docs/index.html) (open it in a
browser, or publish `docs/` with GitHub Pages) for guides and reference.

## Run

```
npm install && npm run build
node dist/cli.js login                                   # once: authenticate with GitHub Copilot
node dist/cli.js examples/live.spl
npx file:./lang examples/live.spl                        # npx from a checkout (or `npx spl-lang` once published)
```

Requires Node 20+ and an authenticated GitHub Copilot.

```
spl <script.spl> [--log-level error|info|debug] [--silent] [--model <id>]
                 [--store <file.json> | --store-module <module>]
                 [--timeout <s>] [--cwd <dir>] [--check]
spl login          # GitHub device flow: prints a code, you confirm it in the browser
spl logout         # removes the credentials saved by `spl login`
```

* stdout: the value of `success` or a top-level `return` (strings raw, everything else as JSON) or the failure payload.
* stderr: logs, including model and reasoning effort of every LLM call.
* Exit code: `0` success, `1` uncaught failure, `2` syntax/usage error.

`spl login` does nothing if the runtime is already authenticated (an earlier login, a Copilot CLI / `gh` login or
`COPILOT_GITHUB_TOKEN`/`GH_TOKEN`/`GITHUB_TOKEN`). Otherwise it runs the device flow and saves the token to
`~/.spl/credentials.json` (override the folder with `SPL_HOME`); scripts use that token automatically. A script that
needs an LLM and finds no credentials fails with `llm_error` and tells you to run `spl login`.

## Language at a glance

```
@{model='gpt-5'}

def fib(n) {
    if n < 2 { return n }
    return fib(n - 1) + fib(n - 2)
}

let joke = ?{len='sentence', fmt='object'} 'A joke about programmers'   # JSON validated and parsed
let why  = think{level='high', show=True} 'Why is {joke.setup} funny?'

let color = None
enforce 'Answer in English' {
    forbid 'profanity' { let color = ?{len='word'} 'Your favorite color?' }   # results leave the block
}

{                                                      # a bare block is a nested scope
    let color = 'Red'                                  # shadows the outer variable
    log(color)
}

restrict './out' {                                    # also: restrict net 'host,..' / restrict exec 'git,npm'
    let f = write_file{path='./out/a.txt', content='{fib(10)}'} 'Confirm'
}

try { assert fib(5) == 4 'wrong' } except err { log(err.reason) }
success {'joke': joke, 'why': why, 'color': color}
```

Decisions worth knowing (the PRD leaves them open):

* **Blocks use braces**, statements end at a newline.
* **Every modification of a variable starts with `let`**: `let x = 1`, `let x += 1`, `let d['k'] = 2`, `let d.k = 3`.
  A bare `x = 1` is a syntax error.
* **Scoping.** `let NAME = ...` binds in the current scope. Bare `{ ... }` blocks and function bodies open a new scope,
  so `let` there shadows an outer variable and the outer one is untouched. `if`/`elif`/`else`, `for`, `while`,
  `try`/`except`, `enforce`, `forbid` and `restrict` bodies share the enclosing scope, so `let` inside them updates the
  enclosing variable: this is how the answer of an LLM call leaves an `enforce`/`forbid`/`restrict` block. A function
  cannot rebind its caller's variables (use a list or dict to share state); names are read through all enclosing scopes.
* **`return` exits immediately** from any scope: the innermost function, or the whole script when used at the top level
  (like `success`). `break`/`continue` still belong to loops.
* **`?` is a prefix operator**: `?'a' + b` is `(?'a') + b`, `-?'n'` is `-(?'n')`.
* **LLM commands have defaults and braces are optional**: `?'q'`, `think 'q'` (level `medium`), and tools without
  parameters, e.g. `read_file 'Read notes.txt and summarize it'`.
* **Every string interpolates `{expr}`**. Write `{{`/`}}` or `\{`/`\}` for literal braces, or use a raw string
  `r'{"a": 1}'`. Values are substituted as is: strings raw, `True`/`False`/`None`, lists and dicts as JSON.
* Tool calls (`read_file`, `write_file`, `web_fetch`, `web_search`, `shell`): when the script supplies every parameter
  the tool needs, the runtime runs it first (restriction-checked), and the output plus your instructions go to the LLM
  whose answer is the value. When a parameter is missing (`read_file 'summarize notes.txt'`,
  `write_file{path='a.txt'} 'write a haiku'`, `web_search 'latest Node.js LTS'`) the LLM calls the tool itself with the
  parameters you gave kept fixed. `web_search` queries DuckDuckGo and counts as network access for `restrict net`.
* Builtins: `len str int float bool type list range abs round min max sum sorted reversed enumerate zip any all keys
  values items json_parse json_stringify log`, plus Python-style string/list/dict methods. `log(...)` writes to stderr.
* Unknown modifiers/values, `break` outside loops, `try` without `except`, a modification without `let`, etc. are
  syntax errors (exit code 2).

## Restrictions

Two layers: the LLM is told about active restrictions in the prompt, and the runtime enforces them. The LLM only gets
the five runtime tools (`read_file`, `write_file`, `web_fetch`, `web_search`, `shell`); every call is checked against
the active `restrict` scopes and any other Copilot permission request is rejected. A violation raises a
`restriction_violation` failure (catchable with `try/except`).

* Paths are canonicalized (symlinks resolved, `..` removed) relative to `--cwd` before the check.
* `net` matches exact hosts (and `*.example.com` wildcards); redirects are re-checked on every hop. `web_search`
  needs `html.duckduckgo.com` to be allowed.
* `exec` matches the executable name. While any restriction is active, `shell` accepts only simple commands (no
  `&|;<>` redirects, substitution or chaining) so the check is exact; path-like and URL arguments are also checked
  against `fs`/`net`. This is best effort for programs that touch files or the network on their own.
* Nested restrictions of one kind intersect and can never widen.

## Reproducibility

Control flow, arithmetic and interpolation are deterministic. The Copilot SDK has no `temperature` or `seed` setting,
so the language has none either. `think` levels map to the SDK reasoning effort; if the selected model does not support
it a warning is logged and the model default is used. Guard against variance with `assert` and `fmt='object'`.

## Variable store

`--store vars.json` loads top-level variables from the file at start and writes them back at exit (also on failure).
`--store-module ./mystore.mjs` plugs in your own store: export `createStore()` returning `{ load(): Record, save(vars) }`.

## Examples

All in [examples/](examples); run from the project root, `--cwd <dir>` points a script at another project. The example
syntax is checked by `tests/examples.test.ts`; `triage-issues` is also run on Copilot there.

| Script | Shows |
|--------|-------|
| `commit-message.spl` | `shell` under `restrict exec 'git'`, validation helper, retry loop |
| `triage-issues.spl` | `fmt='object'` + `assert` validation with feedback retries, aggregation, summary |
| `extract-invoice.spl` | structured extraction cross-checked with arithmetic before it is accepted |
| `code-review.spl` | `think` then structure, `restrict` on read and on write, `fail` as a CI gate |
| `release-notes.spl` | nested `forbid`/`enforce`, git history to a file inside `./out` |
| `web-digest.spl` | `restrict net`, `web_fetch`, catching a blocked second host |
| `fix-failing-tests.spl` | agent loop: run `npm test`, let the LLM fix the source, repeat |
| `translate-docs.spl` | `write_file` without `content` (LLM writes, path pinned), dict iteration |
| `journal.spl` | state across runs with `--store` |
| `basics.spl`, `live.spl`, `restrict-live.spl`, `tools-live.spl` | small feature tours |

## Develop

```
npm test          # builds, then runs parser, interpreter, restriction and CLI tests, plus live tests on Copilot
```

The live tests (`tests/live.test.ts`, one example in `tests/examples.test.ts`) call the real GitHub Copilot service and
are skipped automatically when the runtime is not authenticated: run `spl login` first to include them.

The VS Code extension (syntax highlighting, snippets) lives in `../vscode`.
