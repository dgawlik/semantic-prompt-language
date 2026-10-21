

## Add special variable `$env` that allows accessing process environment variables

```
let date = $env.date
```

If env variable is visible then it returns string else None is returned.

## Add special variable `$args` that allows accessing program arguments

```
spl --arg="somthing" --arg="else" example.spl
```

```
log($args[0])
log($args[1])
```

Accessing higher index than arguments specified returns None

## Implemented contract

- Both special variables are read-only per-run snapshots, available in every scope
  and string interpolation. They cannot be rebound; aliases also reject item/member
  assignments and mutating methods with a catchable `runtime_error`.
- `$env.NAME` and `$env['NAME']` return environment strings. Missing names return
  `None`; present-but-empty values remain `''`. Bracket access supports names that
  are not valid identifiers. Names use the spelling exposed by the host process.
- Repeat `--arg=value` or `--arg value` before or after the script path. Values
  retain their order, whitespace, and empty strings. Use `--arg=--option` for a
  leading dash. The script path and interpreter options are not included.
- `$args` defaults to `[]`. Out-of-range integer indexes return `None`; negative
  indexes count from the end. Invalid index types remain runtime errors.
- Ordinary dict/list missing reads still fail. Explicit `.copy()`, `list($args)`,
  and argument slices create ordinary mutable collections.
- Embedding uses `RunOptions.args?: readonly string[]`, defaulting to `[]`, never
  implicitly reading `process.argv`. Each run snapshots `process.env`.
- Runtime inputs are not automatically saved to variable stores and cannot be
  shadowed by stored bindings. Explicit top-level aliases or derived values can
  still be persisted. Replay uses the current inputs; `--check` only validates syntax.
- VS Code completion, hover, diagnostics, and highlighting support both variables,
  including interpolation. Documentation-site code highlighting supports them too.

## Documentation and regression coverage

See [runtime inputs](docs-template/Language.md#runtime-inputs-env-and-args),
[CLI arguments](docs-template/CLI.md#script-arguments-and-environment),
[built-ins](docs-template/Builtins.md#special-variables), and
[embedding](docs-template/Internals.md#embedding). The language specification and both
grammar copies include the contract.

Regression tests cover parser acceptance/rejection, environment values and absent keys,
CLI argument ordering and empty values, missing/negative/invalid indexes, ordinary
collection behavior, read-only aliases and mutators, mutable copies, store isolation,
and editor completion, hover, diagnostics, and syntax scopes.

Verification commands (from the repository root):

```powershell
npm run build
Set-Location lang
npx --no-install vitest run tests\parser.test.ts tests\interpreter.test.ts tests\cli.test.ts tests\examples.test.ts
Set-Location ..
npm --prefix .\vscode test
npm run docs:build
npm run docs:check
```

Verified: the language TypeScript build passes; the targeted runtime/parser/CLI/example
suite passes 297 tests with 1 skipped. Editor type checking, all 15 language-server tests,
104 syntax-scope assertions, and tokenization of all 16 example scripts pass.
All 12 generated documentation pages and 140 searchable sections pass `docs:check`;
`git diff --check` reports no whitespace errors.
