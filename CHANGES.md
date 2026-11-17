# Add evals library

## File Scoping & Tooling

- `eval` blocks and the `judge` library are only available in `*.eval.spl` files (enforced by `scanner.ts` / `compile.ts`).
- `spl run` rejects `*.eval.spl` files and directs the user to `spl eval`.
- `spl check` and the VS Code extension (`lang/src/library.ts`, `lang/globals.d.ts`, `vscode/src/catalog.ts`) support `*.eval.spl` files and `judge.*` type checking.

## Syntax & Semantics

```spl
eval 'Description of eval' {
  let answer = ask('Color blue in hex notation')

  ---

  judge.faithful(answer, 'color is blue', 0.99)
}

eval 'Tool use' {
  let answer = agent('summarize google.com')

  ---

  judge.toolUse('webFetch', 'https://www.google.com')
  judge.faithful(answer, 'it is a search engine', 0.9)
}

eval 'Increment variable' {
  let i = 0
  agent('Increment @i save to -> @=i')

  ---

  judge.toolUse('saveVariable', 'i', 1)
}
```

- **Declarative, isolated units**: Top-level `eval <string-literal> { ... }` statements are discovered as independent eval cases (disambiguated from JS `eval(...)`). Each `eval` block runs in its own isolated runtime and trace scope.
- **Top-level code**: `import`s, helper functions, and shared constants are allowed outside `eval` blocks in `*.eval.spl` files.
- **Phase divider (`---`)**: Inside an `eval` block, `---` is exclusively the phase boundary between arrange/act (top) and assertions (bottom). Exactly one `---` is required per `eval` block (0 or >1 is a syntax error). Workflow calls above `---` use function-call syntax (`ask(...)`, `agent(...)`, `codegen(...)`).
- **Lexical scope**: Variables declared above `---` are in scope below `---`. `judge.*` calls are only valid below `---`.

## `judge` Library (v1)

- **Soft assertions**: All `judge.*` calls below `---` are executed and collected (`pass`, `score?`, `reason`). An `eval` fails if any judge fails or if an unhandled exception is thrown.
- **`judge.faithful(actual, criterion, threshold = 0.8)`**:
  - Serializes non-string `actual` values (`JSON.stringify` / `String`).
  - Uses an LLM-as-a-judge (configurable via `--judge-model`) returning `{ score, pass, reason }` (`0..1`), passing when `score >= threshold`.
- **`judge.toolUse(toolName, ...args)`**:
  - Inspects the `eval` block's captured trace and passes if at least one **succeeded** call to `toolName` matches `...args` as a positional prefix using deep equality.

## CLI (`spl eval`)

- Discovers `**/*.eval.spl` by default, or accepts explicit file/directory paths.
- Flags:
  - `--filter` / `-g <pattern>`: filter evals by description.
  - `--runs <N>`: repeat each eval `N` times (default `1`; all `N` runs must pass).
  - `--concurrency <N>`: max concurrent evals (default `1`, sequential).
  - `--judge-model <model>`: override the model used by `judge.faithful`.
  - `--json`: emit machine-readable JSON results alongside/instead of terminal summary.
  - `--trace <name>`: write execution trace artifacts (JSONL + HTML report).
