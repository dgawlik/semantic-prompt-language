# Research: Minimal Interactive CLI Logging

**Date**: 2026-10-30
**Scope**: Resolve dependency, runtime, observation, formatting, and lifecycle
decisions before implementation. This records findings, not completed code.

## 1. The requested BetterTUI package

**Decision**: Use exactly `@bettertui/core` 0.1.1, the published core package of
Localfirstai's BetterTUI. Do not use the unscoped `bettertui` name or the React
adapter advertised on the website.

**Rationale**:

- The unscoped npm name is absent. Published core metadata resolves the
  requested product to the `localfirstai/bettertui` repository.
- Core 0.1.1 is MIT licensed, ESM-only, exports `index.mjs` and `index.d.mts`,
  and declares Node.js >=24.15.0.
- Its renderer is a Rust/N-API addon, with native optional packages for Windows,
  macOS, and Linux (glibc/musl), on x64/arm64. Supported prebuilt platforms do not
  require a Rust toolchain.
- `@bettertui/react` is documented but unpublished/private; choosing it would
  produce an un-installable plan. Framework-independent core is sufficient.
- The project labels itself an early preview. Published package declarations
  and implementation are the authority where website API examples disagree.
  Pinning the package avoids an unreviewed pre-1.0 API change.

**Alternatives considered**: Unpublished React/Solid adapters; a different
terminal library; keeping the bespoke logger only. They either cannot be
installed or fail the explicit BetterTUI requirement.

**Sources**:

- [Published 0.1.1 metadata](https://registry.npmjs.org/@bettertui%2fcore/0.1.1)
- [npm package](https://www.npmjs.com/package/@bettertui/core)
- [Source repository and license](https://github.com/localfirstai/bettertui)
- [Official project site](https://bettertui.dev/)
- [Official documentation](https://bettertui.dev/docs)

The dependency research inspected the published declarations and JavaScript,
not only marketing examples. No application source was submitted to external
research services. No dependency has been installed during planning.

## 2. Runtime minimum

**Decision**: Raise the language package's supported Node.js minimum from 20
to 24.15.0 during implementation.

**Rationale**: The selected dependency's declared minimum is a hard mismatch
with [the current package](../../lang/package.json). The user explicitly chose
`raise-node-floor` rather than older-runtime plain output or a different UI
library. Local Node.js 24.18.0 meets the new requirement.

Update package engines, lockfile root metadata, README/install instructions,
and the VS Code external notebook runtime hint. This does not require changing
VS Code's extension-host engine or loading BetterTUI in that host.

**Alternatives considered**: Preserve Node 20 with degraded interaction;
substitute a different framework; assume lower-runtime compatibility despite
the package engine declaration. The first two were offered and not chosen;
the last is unsupported.

## 3. Renderer stream isolation

**Decision**: Run BetterTUI in a CLI-owned child process with child stdout and
stderr mapped to the parent's stderr descriptor; use IPC for immutable events.

**Rationale**: Published `CliRendererOptions` has no output-stream override.
The implementation uses `process.stdout` for frames, terminal-size discovery,
resize handling, cursor/screen controls, and other terminal writes.
`externalOutputMode` manages output emitted inside the renderer process; it
does not redirect the renderer to stderr.

Node child-process stdio descriptor mapping is the appropriate process boundary:
the renderer's fd 1 is the parent's fd 2, and the parent's fd 1 is untouched.
This also isolates native failures and raw input from embedded callers.
The user explicitly approved this subprocess design.

The existing [notebook kernel](../../vscode/src/notebookKernel.ts) provides
repository precedent for `fork`, an explicit executable, cleared `execArgv`,
typed IPC, disconnect handling, and owned-child cleanup. Reuse those patterns,
not its notebook-specific controller.

**Alternatives considered**: Global `process.stdout.write` interception, patching
vendor code, allowing UI escape sequences in workflow stdout, or changing the
stdout result contract. All violate reliability or the specification.

**Sources**:

- Published core `CliRendererOptions` and implementation in the 0.1.1 package.
- [Node child-process stdio documentation](https://nodejs.org/api/child_process.html#optionsstdio).
- [Node fork documentation](https://nodejs.org/api/child_process.html#child_processforkmodulepath-args-options).

## 4. Native UI capabilities and constraints

**Decision**: Use core's renderer and borderless widget primitives, including a
scrollable list and text nodes; maintain selection/folds in application state.
Keep readiness, terminal restoration, fallback, and process ownership explicit.

**Rationale**: Published core supplies `CliRenderer`, `ScrollBox`, `Select`,
and `ScrollBar` primitives, keyboard handling, and renderer `stop`, `suspend`,
and `destroy` operations. Its testing exports include `createTestRenderer`,
mock keys/input, captured frames, resize, and cleanup.

The renderer binds real process stdin for raw-mode input. Therefore non-TTY,
silent, embedded, and checkpoint/resume paths must bypass native initialization
entirely, not start the renderer and hope its guards avoid reading.

A single native process is sufficient; no browser, React, Bun, Rust build
pipeline, or second UI framework is needed. Bun compatibility is not a target.
Native platform import and PTY behavior remain explicit implementation tests.

**Alternatives considered**: Reimplement keyboard/scroll rendering from scratch;
use web UI components; enable controls merely because `FORCE_COLOR` is set.
These introduce unnecessary scope or violate terminal capability rules.

## 5. Observe commits, not statements

**Decision**: Introduce an interpreter-local observer around actual user-binding
commits and synchronous collection mutations.

**Rationale**: [The interpreter](../../lang/src/interpreter.ts) currently logs
source before each statement, but changes also occur in parameter creation,
loop unpacking, handler bindings, function definitions, collection methods,
and model-assisted variable saves. Statement-end snapshots miss intermediate
changes, incorrectly coalesce nested effects, and cannot reliably report partial
success before failure.

The existing `bindingScope` logic remains authoritative. Factor the existing
`callMethod` mutating-method knowledge in [builtins](../../lang/src/builtins.ts)
into shared dispatch metadata. Perform argument/RHS evaluation outside mutation
observation; only the final write or method call is the logical boundary.

**Alternatives considered**: Snapshot all state before/after each statement;
intercept only assignments; wrap every runtime value in proxies; instrument
generic dictionary construction. They lose transitions, miss paths, change
language identities, or report internal temporary objects.

## 6. Scope and alias discovery

**Decision**: Use weak scope metadata plus active execution and reachable
closure roots. Enumerate affected user bindings for a target container and
emit one mutation event containing all affected bindings/scopes.

**Rationale**: An alias can live outside the current lexical chain, including
an active caller or a closure retained after its creating block exits.
Traverse data containers to locate aliases, and traverse function closures
only to discover environments; never serialize a closure as a function value.
Cycle guards are required in both traversals.

Do not retain all exited scopes in a permanent strong registry. Conversely,
do not discard an environment still reachable from a user function. Existing
`ExecutionSession` state persists across cells, so current-cell observation
must work on old values and functions without keeping an obsolete logger.

**Alternatives considered**: Only inspect the current environment; only inspect
globals; permanently track every scope; report each alias as an independent
mutation. These miss state, leak memory, or duplicate logical operations.

## 7. Snapshot and equality policy

**Decision**: Store detached, cycle-safe display snapshots; compare actual
scalar/reference state separately from its rendered form.

**Rationale**: Existing [describeValue](../../lang/src/values.ts) already avoids
function source/closure leakage and handles cycles. Reuse this behavior for
display, adding identity metadata where needed to distinguish equal-content
container replacements. Do not use `toJson` on a cyclic graph or expose live
runtime objects through log events.

For binding writes, use scalar `Object.is` and collection/callable identity.
For an in-place mutation, compare ordered keys/elements and their immediate
values/references around that logical operation. This recognizes no-op methods
without losing alias changes. Display strings and language `equals()` are not
appropriate change detectors.

**Alternatives considered**: `JSON.stringify` equality, deep language equality,
or storing live object references. These conflate identities, fail on cycles,
or let later changes rewrite history.

## 8. JSON formatting and event compatibility

**Decision**: Extract the existing token-preserving pretty printer into shared
formatting and represent bodies as ordered text/JSON/inspection segments.

**Rationale**: [The existing logger](../../lang/src/logger.ts) preserves numeric
lexemes and duplicate JSON keys by formatting tokens rather than regenerating
JSON from parsed data. Retain that invariant for folding. Extend block detection
without parsing ordinary prose or deterministic source as executable content.

Keep the public string-sink constructor, level filtering before serialization,
and script-log prefixes used by [the notebook worker](../../vscode/src/notebookWorker.ts).
New typed model/state methods supply semantics to renderers without inspecting
human-readable strings.

**Alternatives considered**: Parsing and reserializing every payload; changing
all sinks to a mandatory event API; inferring direction from terminal colors.
These lose data or break existing embedding contracts.

## 9. Replay, lifecycle, and retained output

**Decision**: Suppress reconstructed checkpoint state events at commit time;
close the live view and emit one retained plain transcript before result output.
Presentation failures explicitly select the same append-only path.

**User confirmation**: When offered compact summaries versus a complete
expanded retained transcript, the user chose `complete`. This deliberately
keeps full data after exit without keeping the live viewer open.

**Rationale**: [Checkpoint.replaying](../../lang/src/checkpoint.ts) changes as
history is consumed. In particular, `human()` can end reconstruction before
its surrounding binding commits. A statement-entry replay flag would suppress
the first newly completed answer assignment incorrectly. No new checkpoint
record or format is needed.

Native alternate-screen teardown can remove the visible view. The parent
therefore retains canonical events and writes one complete transcript after
restoration. This avoids holding a finished command open for inspection.
Initialization/finalization have finite deadlines, and only the owned renderer
may be terminated. An error diagnostic precedes fallback; user workflow results
do not become a renderer failure.

Existing checkpoints fingerprint runtime files and Node version. A runtime
upgrade can invalidate older journals under the existing safety check; preserving
the format does not promise cross-runtime resumption or justify weakening that
check.

**Alternatives considered**: Add variable events to the checkpoint journal;
cache replay state for an entire statement; wait for a final keypress; silently
drop history after a child crash; bypass runtime fingerprinting. All conflict
with explicit requirements or existing safety behavior.

## Resolution Summary

All design decisions needed for Phase 1 are resolved. Runtime minimum and
renderer isolation were confirmed with the user. Future tests must prove the
planned behavior, native package installation, and real-terminal lifecycle;
no build, performance, or platform result is claimed by this research.
