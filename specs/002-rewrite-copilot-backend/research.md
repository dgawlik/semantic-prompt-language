# Research: Rewrite Copilot Backend

**Date**: 2026-11-02  
**Baseline**: `745e516ef78031c3654b51ec674c0f00d19dc45e`  
**Scope**: [Specification](spec.md). This records design decisions, not a claim of implemented compatibility.

## Local Baseline Decisions

### R1 - Preserve the Published Boundary

**Decision**: Keep `CopilotBackend`, its constructor options, `call`, `close`, the public authentication helpers, and the existing model request/response and logger contracts. Replace their implementation rather than introducing a user-facing provider selector or requiring workflow edits.

**Rationale**: [index.ts](../../lang/src/index.ts), [llm.ts](../../lang/src/llm.ts), and [copilot.ts](../../lang/src/copilot.ts) expose a small boundary already used by the CLI and notebook worker. Formatting, schema validation, repair policy, variable state, and workflow execution already belong to the interpreter; moving them into a new SDK would change semantics.

**Alternatives considered**: A new backend class requiring consumer migration; an optional parallel backend retaining the retired SDK; moving schema validation into provider-native structured output. All conflict with the compatibility or complete-replacement requirement.

### R2 - Preserve Checkpoint Build Pinning

**Decision**: Keep exact runtime-build mismatch rejection. Do not introduce checkpoint migration, an allowlist, or a guard bypass.

**Rationale**: [cli.ts](../../lang/src/cli.ts) fingerprints the package version, Node.js version, and every emitted runtime JavaScript file. [checkpoint.ts](../../lang/src/checkpoint.ts) rejects a mismatching runtime before execution. The user explicitly selected preservation of this safety boundary during planning on 2026-11-02. User Story 6, FR-018, and SC-004 were clarified accordingly.

**Alternatives considered**: Claiming that old CLI journals automatically resume after a rewrite; weakening the runtime comparison; adding verified cross-build migration. The first is false and the latter two change the chosen contract.

**Validation consequence**: Old trace/recording/store fixtures remain cross-backend fixtures. Checkpoints require both matching-build resume coverage and a baseline-build mismatch fixture that fails before any effect occurs.

### R3 - Retain Request-Local Execution and Existing Failure Distinctions

**Decision**: Own sequencing, restrictions, failure propagation, and turn history in the replacement backend. Keep a separate turn context for every `call`, including nested calls made by an SPL function. Do not use a backend-wide execution lock.

**Rationale**: [copilot.ts](../../lang/src/copilot.ts) immediately invokes blockquote runtime actions, preserves thrown runtime control signals, stops on blockquote/MCP failures, and accepts an empty final blockquote answer only after successful runtime actions. Explicit agents instead return ordinary nonrestriction tool failures to the model; restriction violations stop them. [agent.ts](../../lang/src/agent.ts) and the interpreter already validate action arguments and enforce lexical scope.

**Alternatives considered**: Automatic parallel tool execution; a default fixed-step agent loop; converting every exception into a recoverable tool result; treating explicit agents and blockquotes identically. These can reorder state changes, truncate workflows, mask failures, or repeat effects.

**Validation consequence**: Preserve the current behavioral assertions while replacing SDK-specific mock mechanics. Test nested model calls without deadlocks, sequential same-turn actions, original-failure precedence, late-event rejection, and no retry of completed effects.

### R4 - Preserve Artifact Formats Rather Than Backend Labels

**Decision**: Keep version-1 artifact formats, request keys, response shapes, and side-effect ownership unchanged. Historical backend-identification values remain readable; new effective metadata identifies the replacement truthfully.

**Rationale**: [recording.ts](../../lang/src/recording.ts) matches request kind, prompt, model, reasoning effort, reasoning visibility, and the natural-language flag. Backend identity is not part of that key. The response's `effective` field is an open record, not a format discriminator. Existing replay already distinguishes agent-owned effects from explicit deterministic tools.

**Alternatives considered**: A new trace format, synthetic streaming timing on replay, or converting all replay into a dry run. None is needed for the backend replacement.

### R5 - Migrate All Package and Host Boundaries

**Decision**: Update the language package, VS Code package, their lockfiles, and the private root package's stale installed runtime resolution. Point the root's `spl-lang` dependency at the local language package rather than keeping the published `0.1.0` copy that transitively installs the retired SDK.

**Rationale**: [lang/package.json](../../lang/package.json) and [vscode/package.json](../../vscode/package.json) directly depend on the old SDK. [package-lock.json](../../package-lock.json) also retains it through the root's published `spl-lang` dependency. [vscode/build.mjs](../../vscode/build.mjs) currently bundles CommonJS for a Node 18 extension host while externalizing the SDK; [notebookWorker.ts](../../vscode/src/notebookWorker.ts) lazily creates the live backend in a separate Node.js worker.

**Alternatives considered**: Updating only the CLI package; bundling new ESM-only execution dependencies into extension-host CommonJS; deleting the root dependency without preserving its local-runtime purpose. These leave an old execution graph or risk loading incompatible code in the editor host.

**Validation consequence**: Keep live dependencies behind lazy dynamic imports, externalize them for the worker, package required worker dependencies, and test the packaged CLI and VS Code runtime as well as source-level tests. Deterministic execution and language features must not load or authenticate model services.

### R6 - Preserve the Actual Authentication and MCP Type Boundaries

**Decision**: Keep explicit-token precedence and the distinction between public `authStatus(token?)` and callers that explicitly supply `loadToken()`. Replace the exported SDK-owned MCP type with a structurally compatible local union.

**Rationale**: [auth.ts](../../lang/src/auth.ts) does not load SPL's saved token inside `authStatus()` itself; `login` and the backend explicitly pass it. The installed SDK documents that an explicit `gitHubToken` overrides other discovery and disables logged-in-user selection by default. Remaining discovery runs inside its native runtime, so the project source alone does not establish its complete precedence.

The existing MCP embedding type permits omitted stdio type and the `local` alias, `workingDirectory`, and transport-specific fields. The JSON configuration reader in [mcp.ts](../../lang/src/mcp.ts) intentionally accepts only `stdio`, `http`, and `sse`, translating user-facing `cwd` into `workingDirectory`. Both boundaries must remain distinct.

**Alternatives considered**: Changing `authStatus()` to silently consult SPL's saved credentials; retaining a type-only dependency on the retired SDK; narrowing embedding configuration to only the JSON parser's accepted subset. Each changes an existing boundary or prevents complete removal.

## Baseline Verification

The following focused offline baseline command was executed successfully before implementation:

```powershell
Set-Location C:\Users\gawli\Code\research\spl-lang\lang
.\node_modules\.bin\vitest.cmd run tests\copilot.test.ts tests\mcp.test.ts tests\generation.test.ts tests\tracing.test.ts tests\checkpoint.test.ts tests\permissions.test.ts
```

Result: **6 test files passed; 210 tests passed**. No live model calls or user credential-store reads were performed.

## Governance and Feature Resolution

- The [constitution](../../.specify/memory/constitution.md) is an unfilled template. No adopted concrete principles, version, or ratification can be inferred from its examples.
- Setup resolved the active feature to this directory. Its `BRANCH` JSON value was `002-rewrite-copilot-backend`, but `git branch --show-current` reported `main`; the former is a feature-resolution identifier, not evidence that a branch was created or switched.
