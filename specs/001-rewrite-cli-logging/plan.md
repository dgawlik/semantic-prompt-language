# Implementation Plan: Minimal Interactive CLI Logging

**Branch**: `main` (unchanged) | **Date**: 2026-10-30 | **Spec**: [spec.md](spec.md)

**Feature identifier**: `001-rewrite-cli-logging`. Setup reports this identifier
as `BRANCH`; the actual Git branch remains `main`. No branch hook is installed.

**Input**: [Feature specification](spec.md), including state-change-only logging
and the user's planning approval for Node.js >=24.15 and renderer isolation.

**Status**: Implementation, automated regression validation, documentation and
Windows arm64 and Linux arm64 installed-package/native-terminal checks are complete.
All 53 tasks, including keyboard Ctrl+C, prior hidden-cursor/alternate-screen preservation
and Unix PTY acceptance, are complete; see the evidence in
[quickstart.md](quickstart.md#implementation-acceptance-results-2026-10-30).

## Summary

Replace automatic deterministic source tracing with committed variable-state
events in every scope. Keep model transcripts, explicit script logs, severity
filtering, stdout results, and persistent formats intact. Present CLI events
with one compact header, directional colors and type icons, and independently
foldable JSON in interactive terminals.

Use the published, MIT-licensed `@bettertui/core` 0.1.1 rather than the unpublished
React adapter. Its renderer hardcodes stdout and requires Node.js >=24.15.
The user approved that runtime increase and a dedicated renderer subprocess:
the child's fd 1 inherits the parent's fd 2, while the parent retains exclusive
ownership of workflow stdout. Non-interactive and embedded execution never
start the renderer or read terminal input.

Observe writes at their actual commit boundaries, not at statement entry/exit.
Reuse existing scope lookup, mutation dispatch, safe value descriptions, JSON
token formatting, checkpoint replay guards, and child-process lifecycle patterns.

## Technical Context

**Language/Version**: TypeScript, strict ESM/NodeNext, ES2022 output; supported
Node.js floor changes from >=20 to >=24.15.0 by explicit approval. The available
local interpreter is Node.js 24.18.0. No Python or browser runtime is involved.

**Primary Dependencies**: Add exactly `@bettertui/core` 0.1.1 to the language
package with its lockfile. Existing Copilot SDK, Ajv, Markdown, and YAML
dependencies remain. Only the renderer entry point imports BetterTUI at runtime.
Do not install an unpublished adapter or add a second UI framework.

**Storage**: In-memory event history, detached value snapshots, scope metadata,
and per-payload folding state. No new log file, database, journal field, or
persisted UI setting. Existing stores, recordings, traces, and checkpoints
retain their formats and validation.

**Testing**: Existing Vitest and TypeScript build; BetterTUI's exported test
renderer/mock keys for rendering and resize checks; child-process tests for
stream ownership and lifecycle; focused notebook regression checks because
its worker imports the interpreter and logger directly.

**Target Platform**: Supported BetterTUI native targets: Windows x64/arm64,
macOS x64/arm64, and Linux x64/arm64 with glibc or musl. Real-terminal acceptance
must include Windows Terminal/ConPTY and a Unix PTY. Unsupported native loading
reports a diagnostic and uses append-only logs, not a workflow failure.

**Project Type**: Existing language interpreter, CLI, and embeddable library;
VS Code notebook integration is a compatibility surface, not a UI redesign.

**Performance Goals**: A selected payload up to 100 KB toggles within 100 ms;
1,000 mixed events retain order, identities, contents, and fold state. Measure
against synthetic local events, excluding model/network time.

**Constraints**: UI and diagnostics only on stderr; no global stream
monkey-patching; no terminal acquisition in embedded, silent, check, auth, or
checkpoint/resume paths; no source traces at any verbosity; no observation
side effects; no dropped state transitions; restore terminal state before exit.

**Scale/Scope**: One workflow and at most one renderer process per CLI invocation.
Every user binding and supported mutation path is covered, including closures,
aliases, model-assisted saves, and persistent execution sessions. History is
retained for the invocation without a silent event cap.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

The [constitution](../../.specify/memory/constitution.md) contains only unfilled
template placeholders. There are no ratified principles to infer or enforce.
Do not treat example comments as binding governance or modify the constitution.

| Gate | Before research | After design |
|------|-----------------|--------------|
| Applicable ratified principles | None present; no conflict | Unchanged |
| Requested BetterTUI dependency | Identity/compatibility required | Resolved; exact published package selected |
| Runtime compatibility | Node 20 baseline conflicts with BetterTUI | User approved >=24.15; all runtime claims are update targets |
| Clean stdout | Direct renderer use would violate FR-012 | Child fd mapping preserves separation; integration assertions required |
| Deterministic reporting | Existing source traces conflict with refinement | Commit hooks replace them at every level |
| Scope and semantics | Existing binding/mutation semantics are authoritative | No proxies, reevaluation, or persistence changes |
| Implementation scope | Planning artifacts only | No runtime code, manifests, or lockfiles changed in this phase |

No unresolved gate or clarification remains. Platform smoke tests are
implementation acceptance checks, not claims of already verified behavior.

## Project Structure

### Documentation (this feature)

```text
specs/001-rewrite-cli-logging/
  spec.md
  plan.md
  research.md
  data-model.md
  quickstart.md
  checklists/requirements.md
  contracts/cli-logging.md
  contracts/renderer-ipc.md
```

`tasks.md` is intentionally not generated by this command.

### Source Code (repository root)

```text
lang/
  package.json, package-lock.json
  src/
    logger.ts               # filtering, public logger compatibility
    log-events.ts           # new immutable event and snapshot types
    log-format.ts           # extracted shared safe body/JSON formatting
    state-observer.ts       # new scope/binding/mutation observation
    cli-logging.ts          # new parent-side renderer supervisor/plain fallback
    cli-renderer.ts         # new child-only BetterTUI entry point
    interpreter.ts          # commit hooks, model directions, no source tracing
    builtins.ts             # shared mutating-method classification
    values.ts               # reuse/extend safe display helpers
    cli.ts                  # terminal lifecycle around existing command flow
    index.ts                # additive public event types, if exposed
  tests/
    logging.test.ts
    state-observer.test.ts  # new cross-scope and mutation tests
    cli-renderer.test.ts    # new rendering and lifecycle tests
    cli.test.ts
    checkpoint.test.ts
    session.test.ts
    tracing.test.ts
vscode/
  package.json              # supported external-node setting description
  README.md                 # external notebook runtime prerequisite
  src/notebookWorker.ts     # compatibility assertion; change only if necessary
  test/notebook.test.ts
README.md, lang/README.md
docs-template/CLI.md, docs-template/Getting-started.md
docs/                        # generated through the existing docs builder
```

**Structure Decision**: Extend the existing language package. Keep event data,
formatting, interpreter observation, process ownership, and the native renderer
separate because they have different side-effect boundaries. Do not introduce
a generic event bus, plugin system, service, custom renderer framework, or
shared worker abstraction across unrelated packages.

## Phase 0: Research Decisions

See [research.md](research.md) for evidence, alternatives, and sources.

1. Pin the actually published BetterTUI core and adopt the approved Node floor.
2. Isolate stdout-hardcoded native rendering in a child with explicit fd mapping.
3. Use typed, immutable events; retain the string-sink constructor contract.
4. Observe binding writes and synchronous mutation commits after argument/RHS
   evaluation, preserving intermediate changes and failures.
5. Discover affected aliases from live/captured user scopes, not a permanent
   strong registry of every scope ever created.
6. Preserve serialized JSON tokens and use cycle-safe runtime snapshots.
7. Respect checkpoint reconstruction at commit time, with no journal additions.
8. Use explicit presentation-error fallback and a bounded child shutdown.

## Phase 1: Design

### Event production and compatibility

`Logger` continues filtering before formatting. Add typed paths for model input,
model output/action, and state changes; actual model producers call these paths
rather than relying on regex classification of rendered strings. Keep generic
`llm()` available for embedded callers. Retain `deterministic()` as a deprecated
explicit-call compatibility helper, but remove every automatic interpreter call
to it. An explicit caller's message is not a generated execution trace.

An optional structured event sink is additive; it substitutes for formatted
string emission only when supplied. Existing string sinks default to plain,
non-interactive text. Preserve the leading `[info|error|debug] log:` convention
for explicit script logs so notebook output classification continues working.
Never import BetterTUI from `logger.ts`, `interpreter.ts`, or the library index.

Model runtime actions receive output-direction metadata and are logged once
at the action boundary, rather than twice through response and execution paths.
Do not remove the corresponding model response text or fabricate a response
after a failed call.

### State observation

Route user-binding commits through one interpreter-local helper: declaration,
ordinary/augmented assignment, function definition, function parameters, loop
unpacking, handler binding, and model-assisted `save_variable`. Store loading
and runtime input setup establish a silent baseline.

Assign scope identities with weak metadata. Maintain active execution roots
with balanced entry/exit in `finally`; traverse reachable user functions'
closures to discover retained environments. Track captured scopes without
serializing function bodies. A scope that is neither active nor reachable is
not kept alive solely for logging. Session cells use the current interpreter's
logger, not a callback retained by a previous cell.

For member/index writes, evaluate the target, index, RHS and augmented value
exactly as today, then observe only the synchronous committed write. For
collection methods, evaluate arguments first, then wrap the existing method
dispatch. Extract its existing mutating-method classification rather than
maintaining a second list.

Before a mutation, identify live bindings whose data graphs contain the target
container and capture their detached display snapshots. Compare ordered keys/
elements and scalar/reference identities immediately after the operation.
Emit one logical event with all affected bindings only if state changed.
A `finally` comparison also records a partial mutation if a method changes
state before throwing; it never swallows or replaces the original failure.
Do not treat internal sorting swaps as separate language-level operations.

No observer boundary spans an awaited RHS or argument computation: nested
changes must be emitted separately, never folded into the enclosing assignment.
Use identity-sensitive change detection, not language `equals()` or rendered
JSON equality. A different but equal-content container is still a rebind.
Cycle-safe display snapshots do not participate in equality decisions.

Check `checkpoint.replaying` at each commit, including immediately after
`human()` consumes the last historical answer. Reconstructed state is tracked
but not emitted; the newly completed answer assignment must be visible.
Ordinary trace replay is not checkpoint reconstruction and retains its normal
logging. Remove automatic `caught ...` and `restrict ...` step messages as well
as source-statement traces; actual failures and model/backend diagnostics remain.

### Shared formatting and folding

Extract and reuse the current JSON-token pretty printer and terminal-control
sanitization. Validate JSON text without reserializing it. Extend detection to
balanced standalone JSON blocks within multiline text, keeping text before and
after each block in order. Structured values and state snapshots use the same
body segment representation; primitives are not fold controls.

Allocate event and payload identities before rendering. Fold state is keyed by
payload ID, not array index or terminal row. Use a borderless event list with
one header per event and one summary per collapsed container. Use terminal-safe
type icons with labels; input and output have separate palettes. Keyboard
navigation selects payloads; Enter/Space toggles; Page Up/Down scrolls; Home/End
reach the ends. One compact hint explains controls. Incoming events and resize
never reset selection or folds. Cache formatted payloads and keep viewport work
bounded; validate the actual 100 KB/100 ms and 1,000-event thresholds.

### Process ownership and terminal lifecycle

The parent owns filtering, canonical event history, workflow/backend execution,
result printing, diagnostics, and exit status. Start the renderer only after
argument/source/config validation, only for non-silent ordinary execution with
interactive stdin and stderr and a usable terminal. Auth, help, version,
`--check`, checkpoint/resume, and custom sinks never start it.

Use Node `fork()` with `process.execPath`, cleared inherited `execArgv`, IPC,
inherited stdin, and child stdout/stderr attached to parent fd 2. Thus BetterTUI
can use its own stdout and terminal-size queries without touching the parent
stdout. Do not intercept or replace global stream methods. Only the child reads
keys; Ctrl+C requests parent cancellation rather than independently choosing
the workflow's exit status.

Use a versioned ready/event/finish protocol from
[renderer-ipc.md](contracts/renderer-ipc.md). Readiness and graceful shutdown
each have a 1,000 ms deadline. Terminate only the owned child if a deadline is
exceeded; report the cause and restore terminal state. Native import/startup
failure, invalid IPC, or premature child exit selects explicit plain fallback.

The parent captures OS input-mode ownership before forking, so a native child crash
cannot strand Unix input in raw mode. The child probes cursor visibility and primary
screen state with a 250 ms deadline; a prepared/activate handshake gives the parent
the cursor snapshot before native initialization. Unsupported queries or an already-active
alternate screen select diagnosed append-only output without clearing the caller's screen.
Pair renderer teardown with restoration on completion, failure, cancellation,
and parent IPC disconnection. Parent-side emergency restoration must work even
after a native child crash. Do not let a renderer invoke `process.exit()` on
behalf of the workflow.

Visible rows use bounded, single-line BetterTUI Text widgets. Actual terminal-frame
checks exposed missing rows with the original multiline widget despite accumulated
test-output assertions passing; the terminal harness now checks folds and hints on screen.

Normal finish stops the live view and writes one complete, expanded append-only
transcript to stderr so logs survive terminal teardown; it never waits for a
keypress. Failure fallback likewise restores the screen and replays canonical
history exactly once, then streams subsequent events plainly. The live view
is transient; the final transcript is the retained log, not a second live event.
Finish backend cleanup while logging remains available, then close the renderer
and flush the transcript before writing existing stdout results. Route the
top-level unexpected-error path through the same terminal cleanup before exit 70.

### Dependency, packaging, and runtime documentation

During implementation, change `lang/package.json` engines to `>=24.15.0`, add
the exact core dependency using npm, and update `lang/package-lock.json`.
Do not manually edit dependency trees or the unrelated root package's installed
registry copy of SPL. Verify the packed language artifact includes the compiled
child entry point and resolves the platform native package after installation.

Update Node prerequisites in both READMEs and CLI/getting-started documentation.
Update the VS Code external notebook node-path hint and prerequisite text to
match the supported SPL runtime, without raising the editor-host requirement
or pulling the native UI into the extension bundle. Preserve notebook result/
log classification and session behavior; adjust the worker only if a focused
regression demonstrates it is necessary. Regenerate site documentation through
the existing builder rather than editing generated HTML manually.

### Validation and requirement coverage

The [quickstart](quickstart.md) defines commands and observable outcomes.

| Requirements | Design surface | Validation |
|--------------|----------------|------------|
| FR-001--FR-004 | Typed events, direction metadata, shared headers | Header/category/order and failed-call tests; SC-001, SC-002 |
| FR-005--FR-009 | Safe segments, token-preserving JSON, payload identities | Mixed/malformed JSON, folding, cycles, resize; SC-002--SC-004, SC-007 |
| FR-010--FR-015 | Capability gate, supervisor, unchanged CLI result path | Non-TTY, silent, checkpoint, color, child failure and shutdown; SC-005, SC-006 |
| FR-016 | Shared terminal-control sanitization | CSI/OSC/control injection cases in headers, values and transcripts |
| FR-017 | Help, READMEs, source docs and generated docs | Help assertions, docs build/check, runtime prerequisite consistency |
| FR-018--FR-021 | Commit hooks and scope identities | No sources/no-ops, all binding origins and shadowing; SC-008--SC-010 |
| FR-022--FR-024 | Mutation boundaries, alias discovery, snapshots | Nested/cyclic aliases, partial failure, equal-content rebinds, immutable history |
| FR-025--FR-026 | Baseline setup and commit-time replay guard | Store/session baselines, answer boundary, neutrality; SC-008, SC-011 |

Run the smallest focused interpreter/logger/CLI suites first. Extend validation
to session, checkpoint, tracing, notebook, packaging, and real-terminal tests
because those are directly affected contracts. Live Copilot calls are not
required; use existing fake backends and synthetic event feeds.

## Complexity Tracking

No ratified constitution violation requires an exception. The one additional
process is necessary because the required published renderer hardcodes stdout.
A direct in-process renderer would corrupt workflow stdout; global stream
patching would be riskier and would break embedded callers. Other planned
modules isolate required side effects rather than introducing a framework.
