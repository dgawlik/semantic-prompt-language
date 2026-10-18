# spl-lang: Semantic Prompt Language interpreter

A Python-like language where LLM calls are part of the syntax. Everything outside LLM calls is deterministic; LLM
calls go through the GitHub Copilot SDK. See [../LANG-PRD.md](../LANG-PRD.md) for the full spec and
[docs/syntax.ebnf](docs/syntax.ebnf) for the grammar.

## Run

```
npm install && npm run build
node dist/cli.js examples/basics.spl --backend mock      # offline run
node dist/cli.js examples/live.spl                       # uses your Copilot login
npx file:./lang examples/live.spl                        # npx from a checkout (or `npx spl-lang` once published)
```

Requires Node 20+ and, for the default backend, an authenticated GitHub Copilot (e.g. `gh auth login`).

```
spl <script.spl> [--log-level error|info|debug] [--silent] [--model <id>]
                 [--store <file.json> | --store-module <module>] [--backend copilot|mock]
                 [--timeout <s>] [--seed <n>] [--cwd <dir>] [--check]
```

* stdout: the value of `success` (strings raw, everything else as JSON) or the failure payload.
* stderr: logs, including model, reasoning effort, `temperature` and `seed` of every LLM call.
* Exit code: `0` success, `1` uncaught failure, `2` syntax/usage error.

## Language at a glance

```
@{model='gpt-5'}

def fib(n) {
    if n < 2 { return n }
    return fib(n - 1) + fib(n - 2)
}

let joke = ?{len='sentence', fmt='object'} 'A joke about programmers'   # JSON validated and parsed
let why  = think{level='high', show=True} 'Why is {joke.setup} funny?'

enforce 'Answer in English' {
    forbid 'profanity' { let a = ?'Say hi' }
}

restrict './out' {                                    # also: restrict net 'host,..' / restrict exec 'git,npm'
    let f = write_file{path='./out/a.txt', content='{fib(10)}'} 'Confirm'
}

try { assert fib(5) == 4 'wrong' } except err { log(err.reason) }
success {'joke': joke, 'why': why}
```

Decisions worth knowing (the PRD leaves them open):

* **Blocks use braces**, statements end at a newline. `let` binds in the enclosing function scope (not per block);
  `x = ...` reassigns an existing variable.
* **Every string interpolates `{expr}`**. Write `{{`/`}}` or `\{`/`\}` for literal braces, or use a raw string
  `r'{"a": 1}'`. Values are substituted as is: strings raw, `True`/`False`/`None`, lists and dicts as JSON.
* Tool calls (`read_file`, `write_file`, `web_fetch`, `shell`) run in the runtime first (restriction-checked); the
  output plus your instructions go to the LLM and the LLM answer is the value. `write_file` without `content` lets the
  LLM write the file (the path is fixed by the script).
* Builtins: `len str int float bool type list range abs round min max sum sorted reversed enumerate zip any all keys
  values items json_parse json_stringify log`, plus Python-style string/list/dict methods. `log(...)` writes to stderr.
* Unknown modifiers/values, `break` outside loops, `return` outside functions, `try` without `except`, etc. are syntax
  errors (exit code 2).

## Restrictions

Two layers: the LLM is told about active restrictions in the prompt, and the runtime enforces them. The LLM only gets
the four runtime tools (`read_file`, `write_file`, `web_fetch`, `shell`); every call is checked against the active
`restrict` scopes and any other Copilot permission request is rejected. A violation raises a
`restriction_violation` failure (catchable with `try/except`).

* Paths are canonicalized (symlinks resolved, `..` removed) relative to `--cwd` before the check.
* `net` matches exact hosts (and `*.example.com` wildcards); redirects are re-checked on every hop.
* `exec` matches the executable name. While any restriction is active, `shell` accepts only simple commands (no
  `&|;<>` redirects, substitution or chaining) so the check is exact; path-like and URL arguments are also checked
  against `fs`/`net`. This is best effort for programs that touch files or the network on their own.
* Nested restrictions of one kind intersect and can never widen.

## Reproducibility

Control flow, arithmetic and interpolation are deterministic. The Copilot SDK currently exposes no `temperature` or
`seed` setting, so the runtime requests `temperature=0`/`seed` (`--seed`), cannot apply them, and logs exactly that.
`think` levels map to the SDK reasoning effort; if the selected model does not support it a warning is logged and the
model default is used. Guard against variance with `assert` and `fmt='object'`.

## Variable store

`--store vars.json` loads top-level variables from the file at start and writes them back at exit (also on failure).
`--store-module ./mystore.mjs` plugs in your own store: export `createStore()` returning `{ load(): Record, save(vars) }`.

## Examples

All in [examples/](examples); run from the project root, `--cwd <dir>` points a script at another project. The retry logic
of `triage-issues` and `extract-invoice` is covered by `tests/examples.test.ts`.

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
npm test          # builds, then runs parser, interpreter, restriction and CLI tests (offline, mock backend)
```

Not included: the VS Code syntax-highlighting extension from the MVP scope.
