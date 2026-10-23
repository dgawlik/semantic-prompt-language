# Architecture

A small tree-walking interpreter with explicit boundaries between raw I/O, generation, and agent actions.

## Execution pipeline

The lexer produces positioned tokens and string interpolation parts. The recursive-descent parser produces a typed AST and rejects invalid structure and unknown/duplicate modifier names. The interpreter evaluates modifier expressions, validates configuration, and runs the selected operation.

* Raw function call: evaluate arguments, check restrictions, run ToolHost, return exact output.

* Generation: evaluate prompt/options once, assemble guidance and schema, call a tool-free backend session, parse/validate output, optionally repair.

* Agent: create a session exposing runtime/configured MCP tools under the current restrictions; validate the final answer if requested, but never automatically retry actions.

## Modules

| Source | Responsibility |
| --- | --- |
| `lexer.ts / parser.ts / ast.ts` | Tokenization, syntax validation, typed statements and expressions. |
| `interpreter.ts` | Lexical block scopes, expression-valued blocks/conditionals, leveled logging, control flow, raw built-ins, generation options, repair, scoped guidance/restrictions, source locations. |
| `values.ts / builtins.ts` | Value model, conversions, ordinary functions and collection methods. |
| `llm.ts` | Backend contract, prompt construction, strict JSON parsing. |
| `schema.ts` | Strict synchronous draft-07 schema compilation and field-path validation errors. |
| `copilot.ts` | Fresh SDK sessions, model/effort checks, agent-only tool exposure, permission enforcement. |
| `recording.ts` | Versioned workflow traces, legacy generation recordings, and exact sequential replay. |
| `tools.ts / restrict.ts` | File, network, search, shell, path canonicalization, allowlists, and intersecting restrictions. |
| `mcp.ts / auth.ts` | MCP configuration/filtering and Copilot device authentication. |
| `cli.ts / store.ts / logger.ts / errors.ts` | CLI lifecycle, opt-in variable persistence, logs, failures and termination. |

## Execution model

Each block creates a child environment; function calls link to their lexical closure rather than the caller. Reads and assignments search outward for the first declaration, while `let` declares/redeclares locally and shadows enclosing names. Each loop iteration and exception handler has its own bindings. Child declarations do not leak into parents or persistent globals. Block/conditional expressions yield the last expression or `None`; explicit control-flow signals still propagate normally. There is no declaration hoisting.

Guidance and restrictions are execution context, not captured capabilities: a function called inside a policy block uses the caller's currently active policies. Policies unwind on return, success, or failure. Functions have a default recursion cap of 200.

Failures receive the innermost statement location once. Return/break/continue propagate as control signals; success ends the entire script. Opt-in stores save globals even after script failure, including during workflow trace replay. Only legacy generation replay forbids stores and skips saving.

## Generation and repair lifecycle

1. Evaluate modifiers once and reject invalid values/combinations.

2. Compile the schema before invoking the backend.

3. Evaluate the prompt once; assemble guidance, restriction context, hints, and schema.

4. Call a fresh generation session with no available tools or MCP servers.

5. Parse strict JSON and validate the schema. Only format/schema failures may use the bounded repair budget.

Agents use the same final-output validation but reject repairs. Custom backends must honor `req.kind`: only `agent` may invoke `req.tools` or other configured tools. The bundled Copilot backend enforces this through both tool exposure and permission callbacks.

## Embedding

`embed.mjs`

```js
import { parse, run, Logger, CopilotBackend } from 'spl-lang';

const logger = new Logger('silent');
const backend = new CopilotBackend({
  logger, cwd: process.cwd(), timeoutMs: 300_000,
});
try {
  const result = await run(parse("success ask 'Hello'"), {
    backend, logger, cwd: process.cwd(),
  });
  if (result.status === 'success') console.log(result.value);
  else console.error(result.failure);
} finally {
  await backend.close();
}
```

`run` returns success with `value` and `hasValue`, or failure with its payload. Options include backend, logger, cwd, optional store, model override, `args?: readonly string[]`, and maximum call depth. For example, `run(parse('success $args[0]'), { backend, logger, args: ['first'] })` returns `'first'`. Omitted `args` defaults to an empty list, not `process.argv`.

Each run copies arguments and the current `process.env` into read-only `$args` and `$env` snapshots. Special-variable expressions bypass lexical bindings and stores. Missing environment keys and out-of-range argument indexes return `None`; ordinary collections keep their existing errors. Assignment and mutating-method checks preserve read-only behavior through aliases. The snapshots are not automatically persisted, but a script can explicitly bind their values or aliases to saved top-level variables.

Other exports include authentication helpers, variable stores, MCP configuration helpers, and related TypeScript types.

## Recording and replay

Wrap a live backend with `new TraceBackend(backend, file)`, or use `new ReplayBackend(file)` without constructing a live backend. Close either backend after use; replay checks for unused entries on close. Do not publish a successful result until that check completes.

Traces contain structured requests and raw backend responses (including reasoning and effective parameters), or failures with their status code and reason. Every `ask`, `think`, and `agent` backend call is instrumented, including repairs and transport errors. Replay re-exercises parsing, schema checks, repairs, and deterministic code. Matching includes ordered assembled prompts, call kind, requested model, reasoning effort, and show-reasoning. See the [JSONL format](CLI.md#trace-format).

The backend's `mode` identifies execution capabilities: `trace` records all LLM operations; `workflow-replay` returns their recorded results/failures while leaving explicit script tools and stores enabled. Agent-owned actions are not repeated or restored. No Copilot client or MCP server is started by replay.

`new RecordingBackend(backend, file)` retains the legacy generation-only `record` mode. `ReplayBackend` selects `replay` for `spl-generation` files and `workflow-replay` for `spl-trace` files. Legacy `replay` rejects agents, stores, and all raw tools except local reads, preserving existing behavior.

## Extension points

### Custom backend

Implement `LlmBackend.call(req)` returning text, optional reasoning, and effective-parameter metadata, plus `close()`. The request carries the operation kind, assembled prompt, requested model/effort, reasoning display flag, restriction snapshot, and ToolHost. Backend exceptions become script-level `llm_error`; runtime Failure values retain their category.

### Custom store

Implement synchronous `load()` and `save(vars)`, exported through a module factory. Stores are independent of model traces and are forbidden only in legacy generation replay mode.

### Validation

The default suite is offline, using scripted backends and temporary files. Set `SPL_LIVE_TESTS=1` explicitly to enable authenticated Copilot checks. Editor scope tests and documentation snippet tests cover the public language surfaces.
