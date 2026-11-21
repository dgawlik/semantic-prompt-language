
### 1. Execute the Package Split (Building on [CHANGES.md](file:///c:/Users/gawli/Code/research/spl-lang3/CHANGES.md))

Right now [lang/package.json](file:///c:/Users/gawli/Code/research/spl-lang3/lang/package.json) bundles the TypeScript harness, `.spl` compiler, eval runner, and Ink/React TUI in one flat package. Anyone importing `ask` or `agent` in a TS backend pulls in `react`, `ink`, `typescript`, `acorn`, `marked`, and `highlight.js`.

* **Split into workspace packages** (e.g., npm workspaces):
  1. **`spl-harness` (or `@spl-lang/core`)**: `ask`, `agent`, `decision`, `restrict`, `enforce`/`forbid`, `Type`/`Struct`, `Trace`, `AiBackend`, `ToolHost`, `mcp`. Minimal dependencies, no React/Ink, no `typescript` compiler.
  2. **`@spl-lang/compiler`**: `scanner`, `compile`, `check`, `doc`, `loader`, `blocks`. Both the CLI and [vscode/](file:///c:/Users/gawli/Code/research/spl-lang3/vscode/package.json) can consume this cleanly instead of importing `../lang/src/...` via relative paths.
  3. **`spl-lang` (CLI + umbrella)**: re-exports core + compiler, adds `cli.ts`, Ink TUI, `eval`, and `codegen`.
* **Untangle internal coupling during the split**:
  * [runtime.ts](file:///c:/Users/gawli/Code/research/spl-lang3/lang/src/runtime.ts) currently imports `sources` from `loader.ts` and `EvalScope` from `judge.ts` — passing source-location hooks and eval hooks via interfaces/plugins on `RuntimeOptions` will let the core harness stay completely independent of `.spl` compilation and evals.
  * [library.ts](file:///c:/Users/gawli/Code/research/spl-lang3/lang/src/library.ts) imports `codegen.ts` (which pulls in `acorn` and `compile.ts`); making `codegen` an optional/separate entrypoint keeps the harness lean.

---

### 2. High-Impact Runtime & Agent Harness Upgrades

* **Native structured outputs instead of prompt-only JSON**:
  In [runtime.ts](file:///c:/Users/gawli/Code/research/spl-lang3/lang/src/runtime.ts#L634-L636), `schema` currently appends JSON Schema text to the prompt and relies on parsing + repair loops. Wiring `schema` through [ai-native.ts](file:///c:/Users/gawli/Code/research/spl-lang3/lang/src/ai-native.ts) to each provider's native structured output parameter (`response_format`/`text.format`, `output_config.format`, `responseJsonSchema`) — while keeping `Type.coerce` + `repairs` as a fallback — will cut latency, tokens, and validation failures.
* **Token usage, cost tracking, and step budgets**:
  * [ai-native.ts](file:///c:/Users/gawli/Code/research/spl-lang3/lang/src/ai-native.ts#L31-L39) and [llm.ts](file:///c:/Users/gawli/Code/research/spl-lang3/lang/src/llm.ts#L93-L102) don't capture `usage` (`inputTokens`, `outputTokens`, `cachedTokens`, `reasoningTokens`). Capturing usage per turn enables cost summaries in the TUI, trace HTML reports, and eval outputs.
  * The agent loop in [ai.ts](file:///c:/Users/gawli/Code/research/spl-lang3/lang/src/ai.ts#L271) is `for (let step = 0; ; step++)` with only a wall-clock timeout (`timeoutMs`). Adding `maxSteps` (and optionally a total token/cost budget) prevents runaway agent loops.
* **First-class custom tools for TypeScript `agent()` calls**:
  In [ai.ts](file:///c:/Users/gawli/Code/research/spl-lang3/lang/src/ai.ts#L190-L205), `agent()` always registers all 5 built-in `TOOL_SPECS` and offers no way to pass custom TypeScript tools. Adding a `tools` option powered by SPL's own `Struct` types (plus a way to disable/select built-ins, e.g. `builtinTools: ['readFile'] | false`) will make the standalone TS harness much stronger.
* **Pool MCP connections across calls**:
  [ai.ts](file:///c:/Users/gawli/Code/research/spl-lang3/lang/src/ai.ts#L207-L269) spawns and tears down every `stdio` MCP server on every single `agent` call. Caching initialized MCP clients on `AiBackend` (and closing them in `AiBackend.close()`, while still filtering tools per-call by `req.restrictions`) will eliminate repeated cold starts in multi-block or looped workflows.
* **Resilient retries & OpenAI-compatible / custom `baseURL` endpoints**:
  * [ai-native.ts](file:///c:/Users/gawli/Code/research/spl-lang3/lang/src/ai-native.ts#L208) sets `maxRetries: 0` across all three SDKs. Adding configurable exponential backoff for transient `429`/`5xx` errors (without retrying non-idempotent tool executions) is especially important for `spl eval --concurrency N`.
  * Hardcoded `baseURL` values in [ai-native.ts](file:///c:/Users/gawli/Code/research/spl-lang3/lang/src/ai-native.ts#L207) block Ollama, vLLM, OpenRouter, LiteLLM, Azure, and corporate proxies. Supporting custom `baseURL` / an `openai-compatible` provider unlocks local and self-hosted workflows.
* **Consolidate model capability rules into one registry**:
  Model regexes are currently duplicated across [ai.ts](file:///c:/Users/gawli/Code/research/spl-lang3/lang/src/ai.ts#L42-L83), [ai-native.ts](file:///c:/Users/gawli/Code/research/spl-lang3/lang/src/ai-native.ts#L86-L132), and [auth.ts](file:///c:/Users/gawli/Code/research/spl-lang3/lang/src/auth.ts#L108-L110). A single declarative capability table (with user overrides via `configure()`) will make adding new models trivial.
* **Multimodal inputs**:
  Adding an attachment primitive (images/PDFs) to `ask()` and `agent()` would unlock document workflows like [extract-invoice.spl](file:///c:/Users/gawli/Code/research/spl-lang3/lang/examples/extract-invoice.spl) on real scanned PDFs/images rather than pre-extracted `.txt`.

---

### 3. Type System, Tools & Tracing Refinements

* **Richer types & Standard Schema interop ([types.ts](file:///c:/Users/gawli/Code/research/spl-lang3/lang/src/types.ts))**:
  * Add `Optional(T)` / `.optional()` and `.default(v)` on struct fields (today only `Nullable` exists), plus common validation refinements (`.min()`, `.max()`, `.pattern()`, `.refine()`).
  * Supporting the **Standard Schema** interface (so users can pass existing Zod/Valibot schemas to `ask({ schema })`) will lower adoption friction for the TS harness library.
* **Pluggable `webSearch` backend ([tools.ts](file:///c:/Users/gawli/Code/research/spl-lang3/lang/src/tools.ts#L308-L349))**:
  HTML scraping `html.duckduckgo.com` with regexes is fragile under rate limits/bot checks. Keeping it as a zero-config default while allowing a pluggable search provider (Brave, Tavily, Exa, or native provider search) will make web agents much more reliable.
* **Concurrent tracing ([runtime.ts](file:///c:/Users/gawli/Code/research/spl-lang3/lang/src/runtime.ts#L340-L361))**:
  When `--trace` is active, `sequence()` serializes `Promise.all(items.map(x => ask(...)))`. Recording intent order deterministically while allowing network calls to fly concurrently (e.g., keyed by call-order sequence slots) would preserve deterministic replay without losing concurrency.
* **Stronger `restrict` guarantees ([tools.ts](file:///c:/Users/gawli/Code/research/spl-lang3/lang/src/tools.ts#L468-L545))**:
  `webFetch` currently validates hostnames without blocking private/loopback IPs (SSRF via redirects or DNS), and `shell` relies on string splitting (`splitCommand` / `splitChainedCommands`). Adding an opt-in OS sandbox adapter (e.g., `bwrap`/Landlock on Linux, `sandbox-exec` on macOS, or container mode) would turn `restrict` into a true security boundary for untrusted tasks.

---

### 4. Eval Framework & VS Code DX

* **Expand `spl eval` ([eval.ts](file:///c:/Users/gawli/Code/research/spl-lang3/lang/src/eval.ts), [judge.ts](file:///c:/Users/gawli/Code/research/spl-lang3/lang/src/judge.ts))**:
  * Add more built-in judges (`judge.notToolUse`, `judge.matches`, `judge.schema`, `judge.custom`, plus latency/token/cost assertions once usage is tracked).
  * Support **probabilistic pass thresholds** (e.g. `--runs 5 --min-pass-rate 0.8`) instead of requiring 100% pass across stochastic LLM runs, plus **streaming progress** in the CLI (currently [cli.ts](file:///c:/Users/gawli/Code/research/spl-lang3/lang/src/cli.ts#L315) prints nothing until the entire suite completes).
  * Support baseline comparison (`--save` / `--compare`) to catch regressions across prompt or model changes.
  * Minor bug fix: in [eval.ts](file:///c:/Users/gawli/Code/research/spl-lang3/lang/src/eval.ts#L145), the discovery `Runtime` creates a backend via `backendFactory` that is never `.close()`d.
* **VS Code extension enhancements ([vscode/](file:///c:/Users/gawli/Code/research/spl-lang3/vscode/package.json))**:
  * Integrate `*.eval.spl` files with VS Code's native **Testing API** (`TestController`) so evals can be run/filtered per case from the gutter.
  * Add **Quick Fixes** in the LSP (e.g., apply the misspelled header key suggestion already computed by `misspelled()` in [scanner.ts](file:///c:/Users/gawli/Code/research/spl-lang3/lang/src/scanner.ts#L195-L201), or insert missing `outputVar`).
  * Add a command/webview to open `.html` / `.jsonl` trace reports directly inside VS Code.

---

### 5. Repo & Engineering Hygiene

* **Add GitHub Actions CI**: `.github/` currently has skills but no CI workflow. Adding a workflow that runs `npm test`, `npm run docs:check`, and `npm --prefix vscode test` on Linux/Windows/macOS will catch cross-platform issues early (especially `shell` and path restrictions).
* **Clean up version drift and build artifacts**:
  * Align versions across [package.json](file:///c:/Users/gawli/Code/research/spl-lang3/package.json) (`"spl-lang": "^0.1.0"`), [lang/package.json](file:///c:/Users/gawli/Code/research/spl-lang3/lang/package.json) (`3.4.0`), and [vscode/package.json](file:///c:/Users/gawli/Code/research/spl-lang3/vscode/package.json) (`3.3.0`).
  * Remove or `.gitignore` the old `.vsix` binaries sitting in `vscode/` (`3.0.0`, `3.1.0`, `3.3.0`).

---

If you'd like to dive into one of these first — for example, designing and implementing the `lang` → `harness` split from [CHANGES.md](file:///c:/Users/gawli/Code/research/spl-lang3/CHANGES.md), or adding native structured outputs + token/step budgets — let me know which direction you want to prioritize! (For a larger architectural refactor like the monorepo split, you can also use `/plan` to map out the exact module boundaries before we edit code.)