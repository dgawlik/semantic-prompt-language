---
description: "Executable tasks for Minimal Interactive CLI Logging"
---

# Tasks: Minimal Interactive CLI Logging

**Input**: [spec.md](spec.md), [plan.md](plan.md), [research.md](research.md), [data-model.md](data-model.md), [CLI contract](contracts/cli-logging.md), [IPC contract](contracts/renderer-ipc.md), and [quickstart.md](quickstart.md).

**Prerequisites**: Design decisions are resolved. Use the existing TypeScript strict ESM/NodeNext package, Vitest runner, fake backends, safe value descriptions, token-preserving JSON formatter, and notebook child-process patterns.

**Tests**: Included because the specification requires acceptance scenarios and measurable outcomes. Write the relevant assertions first and demonstrate their expected failures before implementation. No live Copilot credentials or network-backed model calls are needed.

**Organization**: Setup, shared foundation, one phase per user story in specification order (US1/US2/US3: P1; US4: P2), then cross-cutting validation and documentation.

**Governance and scope**: The constitution is an unfilled template, not ratified policy. Do not modify it, create a branch, change persistence formats, add a browser/React layer, or load BetterTUI into the interpreter or notebook host.

## Format: `[ID] [P?] [Story] Description`

- Every executable task starts with `- [ ] Tnnn`.
- `[P]` identifies work that can run alongside the explicitly listed peer tasks after their prerequisites finish; it never waives a dependency.
- `[US1]` through `[US4]` appear only on story tasks.
- Paths are repository-relative Windows paths. Commands run from the repository root in PowerShell.
- Existing files are extended rather than replaced. New production modules are limited to those in the plan: `log-events.ts`, `log-format.ts`, `state-observer.ts`, `cli-logging.ts`, and `cli-renderer.ts` under `lang\src`.

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Establish the approved runtime and installable dependency without changing unrelated packages.

- [X] T001 Set the language engine to `>=24.15.0` and add exactly `@bettertui/core` 0.1.1 using `npm --prefix .\lang install --save-exact @bettertui/core@0.1.1`, updating `lang\package.json` and `lang\package-lock.json`; verify Node meets the floor, preserve existing dependencies, and do not alter the root package's registry copy of SPL or the VS Code extension-host engine.

**Checkpoint**: The language package resolves the published core package under the approved Node runtime; no unpublished adapter or second UI framework is introduced.

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Provide side-effect-free events, shared safe formatting, and compatible logger delivery before any story.

- [X] T002 Extend `lang\tests\logging.test.ts` with foundation contracts for filtering before serializers/snapshot factories, one delivery through either a string or structured sink, detached event bodies and stable IDs, existing `new Logger(level, stringSink, options)` behavior, generic `llm()`/explicit `deterministic()` compatibility, script-log prefixes, and imports that do not load BetterTUI or acquire input.
- [X] T003 Create readonly discriminated event and body-segment types in `lang\src\log-events.ts`, preserving these data-model constraints verbatim: `id` is "Immutable ID unique within the logging session"; `sequence` is "Strictly increasing visible-event order, allocated after filtering"; `kind` is "`error`, `warning`, `info`, `debug`, `model-input`, `model-output`, `state`, or explicit legacy/generic message"; `origin` is "Diagnostic, script log, model interaction, state observation, or explicit embedding call"; `segments` are "Ordered, detached body segments"; `interaction` is "Optional request ID, interaction kind, and response/action role"; `change` is "State-change detail, present only for a state event". For segments, preserve "Sanitized literal text, preserving legitimate line breaks", "Object/array payload with a stable payload ID and source tokens", and "Safe readable representation of non-JSON data"; `payloadId` is "Event ID plus stable segment/change-field identity", `container` is "Object or array", `source` is "Complete validated JSON text; not a parsed-and-regenerated substitute", and `summary` is "One-line container/fold indicator, not discarded content". Exclude mutable runtime references and automatic source-statement variants.
- [X] T004 Extract the existing token-preserving JSON pretty printer, value/text formatting, color policy, and terminal sanitization from `lang\src\logger.ts` into `lang\src\log-format.ts`; expose shared ordered-segment and complete expanded-text formatting, retain two-space JSON indentation and explicit arbitrary-value logger compatibility, sanitize labels/inspection output as well as messages, preserve legitimate newlines, and keep native UI imports out.
- [X] T005 Refactor `lang\src\logger.ts` onto the event/formatting foundation with additive typed model-input/model-output/state methods and an optional structured sink; apply silent/severity/transcript filtering before formatting, snapshot construction, ID allocation, and delivery; send each accepted event to exactly one sink; preserve leading `[info|error|debug] log:` for explicit script logs, plain custom-sink defaults and explicit color overrides, generic `llm()`, and deprecated explicit-only `deterministic()`.
- [X] T006 Add only necessary readonly event/sink type exports to `lang\src\index.ts` and validate the T002 contracts in `lang\tests\logging.test.ts` with `npm --prefix .\lang test -- tests\logging.test.ts`; ensure library imports have no BetterTUI, process-spawn, input, or terminal-lifecycle side effects.

**Checkpoint**: Common logger contracts pass with complete append-only output. All stories may use the event foundation; no terminal is acquired by a library import or custom sink.

## Phase 3: User Story 1 - Follow execution with minimal visual noise (Priority: P1)

**Goal**: Deliver compact, direction-aware events in a safely isolated BetterTUI view, retaining complete logs and clean workflow results.

**Independent Test**: Use fake backends to emit requests/responses for `ask`, `think`, `agent`, and blockquotes, script logs, diagnostics, a synthetic state event, and a failed request. Assert exactly one header per event, all seven named categories, correct distinct icons/labels and direction colors, unchanged order/content, no fabricated response, clean stdout, and automatic teardown without a keypress.

### Tests for User Story 1

- [X] T007 [P] [US1] Add header/direction contracts to `lang\tests\logging.test.ts`: input `->`/magenta, output or action `<-`/cyan, error `x`/red, warning `!`/yellow, info `i`/blue, debug `.`/gray, state `~`/yellow, and an explicit generic category; cover multiline single headers, no panels/timestamps/filler rows, every model interaction kind, failed calls, response retention, and action logging exactly once.
- [X] T008 [P] [US1] Create `lang\tests\cli-renderer.test.ts` using BetterTUI's exported test renderer/mock keys plus a controlled child-process harness; specify version/session/sequence validation, simple event frames, real child fd routing without global stream patches, readiness/finish handshakes including empty history, one retained transcript, normal cleanup, and a startup/native-import failure selecting diagnosed plain output.
- [X] T009 [P] [US1] Extend `lang\tests\cli.test.ts` with byte-level subprocess assertions for unchanged success/failure stdout and exits, a failed model call retaining its request only, backend-close diagnostics preceding final transcript/result, zero input acquisition or renderer spawn for excluded invocations, and top-level unexpected-error cleanup before exit 70; reuse existing fake backends rather than live model calls.

### Implementation for User Story 1

- [X] T010 [US1] Define version-1 parent/child IPC unions and runtime guards in `lang\src\log-events.ts` per `specs\001-rewrite-cli-logging\contracts\renderer-ipc.md`: nonempty `sessionId`, validated message fields from `unknown`, initialize/ready/event/accepted/finish/finished/cancel/fatal messages, contiguous sequences, null final sequence for empty history, and explicit rejection of unknown types/versions, wrong sessions, invalid payloads, and sequence gaps without unchecked broad casts.
- [X] T011 [P] [US1] Replace string-classified model producers in `lang\src\interpreter.ts` with typed input/output metadata for `ask`, `think`, `agent`, and blockquotes, logging runtime actions once at their action boundary while retaining actual response text; remove automatic `deterministic()` source calls and automatic caught/restrict step messages at all levels, retaining explicit script logs, failure source context, backend diagnostics, and existing replay behavior.
- [X] T012 [P] [US1] Create the child-only entry point `lang\src\cli-renderer.ts` with the sole production runtime import of `@bettertui/core`; render borderless ordered events with shared single headers and complete bodies, validate IPC before use, establish restorable input/cursor/screen ownership before ready, acknowledge accepted sequences, handle finish/disconnect, and send interrupt cancellation to the parent instead of allowing toolkit Ctrl+C to exit the workflow.
- [X] T013 [US1] Create `lang\src\cli-logging.ts` as the parent-owned presentation session: retain canonical immutable history, use `fork()` with `process.execPath`, cleared `execArgv`, inherited stdin and child stdout/stderr mapped to parent fd 2, and never intercept global streams. Implement the data-model states Plain/Starting/Interactive/Falling back/Finishing/Closed with "Closing is idempotent.", ready "within 1,000 ms or diagnosed fallback", ordered sends, bounded finish, owned-child cleanup and emergency terminal restoration, explicit failure diagnostics, replay-once expanded fallback, and one expanded retained transcript after normal teardown without an inspection keypress.
- [X] T014 [US1] Integrate the presentation session into `lang\src\cli.ts` only after argument/source/config/store validation for ordinary non-silent execution with usable stdin/stderr TTYs and restorable state; leave help/version/auth/check/checkpoint/resume/custom sinks non-interactive, keep logging available through backend cleanup, close/flush before unchanged result printing, and route cancellation and unexpected exceptions through the same restoration path before their existing exit outcome.
- [X] T015 [US1] Run `npm --prefix .\lang test -- tests\logging.test.ts tests\cli-renderer.test.ts tests\cli.test.ts` against the US1 assertions in those files; prove SC-001 and the single-header part of SC-002 using synthetic state input, and verify stderr-only UI, no automatic source traces, no fabricated outputs, and no completion keypress.

**Checkpoint**: US1 is demonstrable independently using synthetic events. Basic safe lifecycle and exclusions are already required here, not deferred to US4. Real interpreter state production and interactive folding arrive in US3 and US2 respectively.

## Phase 4: User Story 2 - Inspect JSON only when needed (Priority: P1)

**Goal**: Make each object/array independently foldable without losing tokens, surrounding text, event identity, or accessible content.

**Independent Test**: Feed two structured payloads plus text around multiple serialized JSON blocks. Navigate with the advertised keys, toggle each payload, append events and resize, then recover exactly the original tokens/content with two-space indentation. Verify malformed JSON and primitives never acquire misleading fold controls.

### Tests for User Story 2

- [X] T016 [P] [US2] Add JSON segmentation/fidelity regressions in `lang\tests\logging.test.ts` for structured values, complete/labeled/multiline JSON blocks with ordered surrounding text, empty containers, primitive JSON, malformed input/prose, large integers, `-0`, exponent spellings, duplicate keys, escaped strings, errors/cycles/bigints/non-finite values, and CSI/OSC/control injection; assert plain/final output is complete and token-preserving rather than parsed-and-regenerated.
- [X] T017 [P] [US2] Extend `lang\tests\cli-renderer.test.ts` with test-renderer/mock-key assertions for exactly one initial summary line per container, all navigation/toggle keys and visible hint, independent folds and stable selection across arrivals/narrow-wide resize, full content reachability, and measurable SC-003/SC-004 checks: a 100 KiB payload updates its captured frame within 100 ms of one toggle, and 1,000 mixed events retain exact IDs/order/content and fold state.

### Implementation for User Story 2

- [X] T018 [US2] Extend ordered segment extraction in `lang\src\log-format.ts` to detect validated balanced standalone object/array JSON blocks within labeled and multiline messages, keeping text before/between/after blocks in order and original numeric/string tokens and duplicate keys intact; keep primitives inline, malformed/non-JSON values readable, all visible text sanitized, and before/new state values compatible with the same payload representation.
- [X] T019 [US2] Implement fold/navigation state in `lang\src\cli-renderer.ts` using these verbatim data-model constraints: `collapsedByPayload` is "Payload-ID keyed expansion state; new containers start collapsed"; `selectedPayloadId` is "Optional selected payload; stable on arrival/resize"; `scrollPosition` is "Viewport location, independent of event identity"; `followingTail` is "Whether new events should keep the viewport at the end"; and `width`, `height` are "Current terminal layout, not a key for folding state". Render one object/array folded summary, two-space expanded JSON and ordered surrounding text; support Up/Down, Enter/Space, Page Up/Down and Home/End with one compact hint, preserve other folds/selection during append/reflow, and stop forced tail-following when navigating away.
- [X] T020 [US2] Bound viewport/reflow work and cache formatted payloads in `lang\src\cli-renderer.ts` until the T017 monotonic-clock 100 KiB/100 ms assertion passes, while retaining all history/content without a silent cap or truncation; keep cached formatting independent of event identity, terminal width, and fold ownership, and verify the 1,000-event fixture has zero loss, reordering, or misassociation.
- [X] T021 [US2] Run the combined JSON/folding checks with `npm --prefix .\lang test -- tests\logging.test.ts tests\cli-renderer.test.ts` for `lang\tests\logging.test.ts` and `lang\tests\cli-renderer.test.ts`; verify SC-002 through SC-004 and exercise the displayed labels/hint as the sole guidance for the SC-007 request/response inspection flow.

**Checkpoint**: US2 works with synthetic event feeds independently of interpreter state production. Plain sinks and retained final transcripts remain fully expanded regardless of live fold state.

## Phase 5: User Story 3 - Follow variable changes in every scope (Priority: P1)

**Goal**: Observe every actual user binding/mutation commit once, with correct defining scopes and detached before/after values, without changing evaluation or replay/persistence behavior.

**Independent Test**: Execute deterministic fixtures covering initialization, same-value/no-op operations, nested/shadowed scopes, loop unpacking, parameters, handlers, recursive calls, retained closures, aliases and every existing mutating method. Compare the exact ordered expected transitions, including change-then-restore and changes before failure; prove enabled and silent execution have identical results, side-effect counts and saved data.

### Tests for User Story 3

- [X] T022 [US3] Create `lang\tests\state-observer.test.ts` with binding/scope contracts for unbound versus null initialization, rebinding, `Object.is` scalar behavior, same-reference no-ops, equal-content distinct-container rebinding, top-level/block/branch owners, shadowing, repeated iteration/function/recursive scopes, parameters/loop unpacking/handler/function bindings, model-assisted saves, readable callable identity without source/closure dumps, and no synthetic scope-exit deletions.
- [X] T023 [US3] Extend `lang\tests\state-observer.test.ts` with member/index/nested writes, every existing list/dict mutating method, no-op clear/update/sort/reverse, alias discovery across active callers and retained closures, cyclic/shared graphs, event-time snapshot immutability, RHS/argument nested commits, target failure versus prior successful changes, partial mutation before a thrown error, change-then-restore, and non-invoking observation of foreign/accessor values with getter/toJSON/custom-inspector counters.
- [X] T024 [P] [US3] Extend `lang\tests\session.test.ts` with surviving bindings/functions/closures across cells, correct current-cell string or structured sink, distinguishable new invocation scopes, no stale logger callbacks, and silent baseline tracking without an initial state dump; reuse the existing `ExecutionSession` behavior rather than creating a separate session system.
- [X] T025 [P] [US3] Extend `lang\tests\checkpoint.test.ts` with no historical state events during reconstruction, exactly one newly committed assignment when the last historical `human()` answer ends replay, preservation of earlier nested commits on later failure, and unchanged envelopes/journal fields/runtime-fingerprint rejection.
- [X] T026 [P] [US3] Extend `lang\tests\logging.test.ts` and `lang\tests\tracing.test.ts` to require zero automatic statement/source/caught/restrict step events at error/info/debug, zero events for post-baseline reads/same-value/no-op execution, preserved explicit script/model/error logs, ordinary trace replay request matching and state logging, and enabled-versus-silent equality of results, evaluation/model/tool counters, store contents, and trace/recording data.

### Implementation for User Story 3

- [X] T027 [US3] Complete state-related readonly types in `lang\src\log-events.ts` with the data-model constraints verbatim: `scopeId` is "Weakly associated, run/session-local identity"; scope `kind` is "Global, block/branch, iteration, function call, handler, or retained scope"; `parentId` is "Optional defining lexical parent, not an invented caller relationship"; `label` is "Readable context without executed source or function body"; `bindingId` is "Scope identity plus variable name"; `name` is "Original variable name, including same-name shadowed bindings". Observed `presence` is "`unbound` or `value`; null is a value, never an absence sentinel"; `valueKind` is "Scalar, list, dictionary, callable, or inspected foreign value"; `referenceId` is "Optional stable identity for containers and callables"; `display` is "Detached safe display data/text captured at the event boundary". State `operation` is "Binding initialization, rebinding, or logical container mutation"; `bindings` is "Nonempty list of affected binding deltas"; a delta is "Binding reference, previous observed value, new observed value"; `targetReferenceId` is "Optional identity of the mutated container"; `path` is "Optional member/index description, never an executed statement".
- [X] T028 [P] [US3] Create `lang\src\state-observer.ts` with weak scope/container/callable identities and scope discovery rooted in globals, active environments and the observed operation's environment; walk lexical parents and reachable user-function closures with cycle guards, enumerate each environment's bindings without shadowing away outer names, and expose balanced active-root entry/exit without strongly retaining unreachable exited scopes or prior-cell sinks.
- [X] T029 [P] [US3] Extract the existing mutating-method classification from `callMethod()` into shared dispatch metadata in `lang\src\builtins.ts`, covering list append/extend/insert/pop/remove/reverse/sort/clear and dictionary pop/update/clear; use the same metadata for existing mutability enforcement and observer callers, preserving dispatch, validation, evaluation counts and failures without a second independent method-name list.
- [X] T030 [US3] Implement detached cycle-safe observed-value snapshots and identity-sensitive comparison in `lang\src\state-observer.ts`, reusing/extending `lang\src\values.ts` safe descriptions where appropriate; compare scalar writes with `Object.is` and collection/callable rebinding by identity, not display JSON or language equality. Do not invoke getters, `toJSON`, custom inspection or user code during automatic observation; display callable identity only, use readable cycle markers, and retain inspectable non-JSON/foreign values without exposing live runtime objects.
- [X] T031 [US3] Add an interpreter-local user-binding commit helper in `lang\src\interpreter.ts` and route declarations, ordinary/augmented name assignment, function definitions/parameters, loop bindings/unpacking, handler bindings and model `save_variable` through it; reuse `bindingScope()` for ownership, preserve all validation/RHS evaluation order, register distinct lexical/invocation/iteration scopes, and balance active environment roots in `finally` so nested commits are recorded separately and no observer boundary spans awaited RHS/argument evaluation.
- [X] T032 [US3] Add synchronous logical-mutation observation to `lang\src\state-observer.ts`: discover affected bindings through nested list/dict graphs in all active/captured scopes, snapshot them before commit, compare the target's ordered keys/elements and immediate scalar/reference identities afterward, and emit one event listing all affected bindings only if state changed. Compare in `finally` to preserve partial mutation before a throw without swallowing/replacing the original error; do not emit internal algorithm swaps or an event for an unbound temporary container.
- [X] T033 [US3] Wrap actual member/index writes and shared-metadata mutating method dispatch in `lang\src\interpreter.ts` with the observer only after target/index/RHS/argument/augmented-value evaluation finishes; preserve existing validation and mutability order, emit each alias-affecting mutation once, suppress no-op writes/methods, and keep earlier nested changes visible if the final write fails.
- [X] T034 [US3] Apply baseline and replay rules at every commit in `lang\src\interpreter.ts`: store loads, builtins/runtime inputs and reconstruction establish state without emission; consult the current `checkpoint.replaying` immediately at each binding/mutation commit, including after the last historical `human()` answer; keep ordinary trace replay observable and retain existing checkpoint/store/trace/recording formats and fingerprint checks unchanged.
- [X] T035 [US3] Wire persistent observation through `SessionState.current` in `lang\src\interpreter.ts` so functions and surviving values from prior cells use the current interpreter's observer/logger, share only appropriate weak identity metadata, preserve captured-scope discovery, and never retain an obsolete cell sink or change existing session result/state semantics.
- [X] T036 [US3] Run `npm --prefix .\lang test -- tests\state-observer.test.ts tests\logging.test.ts tests\session.test.ts tests\checkpoint.test.ts tests\tracing.test.ts` for the US3 files; require exact expected transition counts/order and scope attribution, immutable snapshots, zero historical/no-op/source events, and enabled/silent equivalence to demonstrate SC-008 through SC-011.

**Checkpoint**: All required binding/mutation origins are observed without side effects. US3 is independently testable through custom sinks with no native renderer or keyboard access.

## Phase 6: User Story 4 - Keep automation and existing controls reliable (Priority: P2)

**Goal**: Complete the capability, color, failure, notebook, checkpoint and terminal-restoration matrix without changing command or saved-data contracts.

**Independent Test**: Run identical offline fixtures with interactive stderr/stdin, stdout piped, stderr redirected, piped stdin, `TERM=dumb`, every color override, silent and checkpoint/resume. Compare exact stdout/exit/saved data; inject renderer faults and interruption, checking one complete retained transcript and restored terminal state.

### Tests for User Story 4

- [X] T037 [P] [US4] Extend `lang\tests\cli.test.ts` with the full capability/color/verbosity matrix: stdout piping does not disable stderr UI, redirected stderr or non-TTY stdin never acquires input, `TERM=dumb` is plain, `NO_COLOR` wins over `FORCE_COLOR`, `FORCE_COLOR=0` disables color, forced color never enables cursor controls/interactivity, and silent/help/version/auth/check/checkpoint/resume preserve existing diagnostics/stdout/exit behavior with zero renderer spawns/input listeners.
- [X] T038 [P] [US4] Extend `lang\tests\cli-renderer.test.ts` with controlled faults for malformed/wrong-version/wrong-session IPC, sequence gaps, send callback errors/backpressure, startup/native-import failures, premature/native crash, absent ready/finish acknowledgment, duplicate close/failure callbacks, parent disconnect, interruption and top-level errors; use fake timers/children for both 1,000 ms deadlines and assert final sequence validation, owned-resource cleanup, terminal restoration and exactly one complete retained transcript without lost events.
- [X] T039 [P] [US4] Add focused compatibility assertions to `vscode\test\notebook.test.ts` and `vscode\test\notebook-ui.test.ts` for preserved explicit `[info|error|debug] log:` output classification, state/model events as logs, retained bindings across cells with current sinks, unchanged cell results, and no BetterTUI runtime import, renderer process or terminal acquisition in the notebook path.

### Implementation for User Story 4

- [X] T040 [US4] Complete the tested capability/color/diagnostic matrix across `lang\src\cli-logging.ts`, `lang\src\cli.ts`, and `lang\src\logger.ts`, reusing the shared color policy rather than duplicating it; ensure excluded invocations never initialize the renderer/read input, silent leaves existing usage/syntax/checkpoint-usage diagnostics intact, and explicit color overrides never grant interactivity.
- [X] T041 [US4] Complete ordered IPC queue/backpressure and fault handling in `lang\src\cli-logging.ts` and `lang\src\cli-renderer.ts`: retain history before send, check send callbacks, queue without dropping/rerunning workflow events, acknowledge contiguous acceptance, verify finish's final sequence including null empty history, diagnose invalid input, and fall back once without a renderer restart loop or history discard.
- [X] T042 [US4] Complete terminal/resource cleanup in `lang\src\cli-logging.ts`, `lang\src\cli-renderer.ts`, and `lang\src\cli.ts` for timeout, native crash, disconnect, Ctrl+C, workflow failure and unexpected exceptions; enforce ready and graceful-finish deadlines of 1,000 ms each, restore initial raw/cursor/screen state before result/exit, remove only owned listeners/timers, terminate only the owned child, and choose explicit plain fallback if restorable ownership cannot be established.
- [X] T043 [US4] Validate notebook compatibility against `vscode\src\notebookWorker.ts` and the T039 tests; change the worker only if a focused failing regression requires it, preserving result/log classification and session behavior without bundling native UI or increasing the extension-host runtime requirement.
- [X] T044 [US4] Run `npm --prefix .\lang test -- tests\cli.test.ts tests\cli-renderer.test.ts tests\checkpoint.test.ts`, `npm --prefix .\vscode run typecheck`, `npm --prefix .\vscode run build -- --test`, and `node --test .\vscode\out\test\notebook.test.cjs .\vscode\out\test\notebook-ui.test.cjs` against `lang\tests\cli.test.ts`, `lang\tests\cli-renderer.test.ts`, `lang\tests\checkpoint.test.ts`, and the focused notebook tests; demonstrate byte-identical result/envelope/exit and unchanged saved formats for SC-005.
- [X] T045 [US4] Execute the real-terminal matrix in `specs\001-rewrite-cli-logging\quickstart.md` on Windows Terminal/ConPTY and a Unix PTY using synthetic paced events from a test-only harness in `lang\tests\cli-renderer.test.ts`; check stdout piping and actual fd routing, normal completion/script failure/Ctrl+C/native-child crash, restored raw/cursor/screen state, one retained expanded transcript and no inspection keypress for SC-006. Record platform evidence; if a platform is unavailable, leave that acceptance check explicitly unverified rather than treating redirected tests as PTY proof.

**Checkpoint**: Automation, embedding and notebook contracts remain intact. Platform-specific acceptance is evidenced rather than inferred from screenshots or test-runner capture.

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Document the deliberate presentation/runtime changes and validate the deliverable package and full affected surface.

- [X] T046 [P] Update `README.md`, `lang\README.md`, `docs-template\CLI.md`, and `docs-template\Getting-started.md` for Node.js >=24.15.0, ASCII icons/direction colors, one-header events, variable/scope state logging instead of source traces, no-op/baseline behavior, default JSON folds and keys, expanded retained transcripts, non-interactive behavior, severity/silent and color precedence; preserve unrelated install/workflow guidance.
- [X] T047 [P] Update the external notebook runtime prerequisite in `vscode\README.md` and the `spl.notebook.nodePath` description in `vscode\package.json` to Node.js >=24.15.0; do not change VS Code engine requirements or imply that the extension host loads BetterTUI.
- [X] T048 [P] Update help text in `lang\src\cli.ts` and corresponding assertions in `lang\tests\cli.test.ts` to describe state-only automatic logs, scope/no-op semantics, icon/direction distinctions, folding/navigation, retained/plain output, and existing verbosity/color controls without adding a new required flag.
- [X] T049 Regenerate documentation via `npm run docs:build` and verify `npm run docs:check` using the existing `docs\build.mjs` pipeline after T046; review generated prerequisite/logging coverage in `docs\` without hand-editing generated HTML.
- [X] T050 Verify `lang\package.json` and `lang\package-lock.json` packaging with `npm pack .\lang --dry-run --json`, then pack/install into an explicitly named isolated temporary prefix on supported native targets; prove `lang\dist\cli-renderer.js` and declarations are included as package `dist` artifacts, the platform native dependency resolves under the approved runtime, and the child starts from the installed artifact without relying on checkout-only paths. Remove only the specific temporary package/prefix created for this check.
- [X] T051 Run the offline smoke workflow from `specs\001-rewrite-cli-logging\quickstart.md` and capture byte-level checks in `lang\tests\cli.test.ts`: result `2`, exactly five logical state events including one mutation listing both aliases, no event for `count = count` or `success count`, immutable `[1]` to `[1, 2]` history, complete expanded redirected JSON, clean stdout, and identical silent results without logs; remove the named temporary workflow/output files after validation.
- [X] T052 Run the final directly affected regression set for `lang\tests\logging.test.ts`, `lang\tests\state-observer.test.ts`, `lang\tests\cli-renderer.test.ts`, `lang\tests\cli.test.ts`, `lang\tests\session.test.ts`, `lang\tests\checkpoint.test.ts`, and `lang\tests\tracing.test.ts` with one `npm --prefix .\lang test -- tests\logging.test.ts tests\state-observer.test.ts tests\cli-renderer.test.ts tests\cli.test.ts tests\session.test.ts tests\checkpoint.test.ts tests\tracing.test.ts` invocation; retain unrelated assertions and validate the TypeScript build rather than counting obsolete source-trace expectations as feature evidence.
- [X] T053 Record implementation acceptance results in `specs\001-rewrite-cli-logging\quickstart.md`, linking measured SC-001 through SC-011 evidence, native packaging and Windows/Unix terminal results or explicit unavailable-platform gaps; confirm no new journal/store/trace fields, weakened fingerprint checks, obsolete source-log documentation, silent history caps, or task-created temporary files remain.

## Dependencies & Execution Order

### Phase and story graph

```text
Phase 1: T001
  |
Phase 2: T002 -> T003 -> T004 -> T005 -> T006
  |
  +--> US1 (T007-T015) --> US2 (T016-T021) --+
  |           |                            |
  +--> US3 (T022-T036) ---------------------+--> US4 (T037-T045)
                                                   |
                                           Polish (T046-T053)
```

- Setup and all foundational tasks block story implementation.
- **US1** depends only on the foundation; it supplies the working CLI/native-view lifecycle used by US2.
- **US2** depends on US1's renderer and presentation session, but not on US3. Synthetic events make its acceptance independent of interpreter state observation.
- **US3** depends only on the foundation for functionality and is testable with custom sinks. US1 T011 and US3 T031/T033/T034/T035 edit `lang\src\interpreter.ts`; serialize those edits even when other US1/US3 work overlaps.
- **US4** depends on US1/US2/US3 behavior for its complete cross-mode regression matrix. Foundational terminal safety/exclusions are already delivered by US1.
- Polish starts after all stories. Documentation-only drafting can overlap when its target files are not being edited elsewhere; acceptance/sign-off cannot.

### Task-level dependencies

| Tasks | Prerequisites and ordering |
|-------|----------------------------|
| T001-T006 | Execute sequentially; prove T002 failing expectations before T003-T005 implementation, then validate with T006. |
| T007, T008, T009 | Foundation complete; these test files are independent and may be authored together. Demonstrate relevant failures before implementation. |
| T010 | T007-T009 test contracts established. |
| T011, T012 | T010 complete; interpreter event producers and child-only rendering may proceed in parallel in different files. |
| T013 | T010 and T012 complete; consumes the child/IPC contract and existing shared formatting. |
| T014 | T011-T013 complete; integrates producers, supervisor and existing CLI outcome paths. |
| T015 | T007-T014 complete. |
| T016, T017 | T015 complete; independent formatter/renderer test files. |
| T018 -> T019 -> T020 -> T021 | T016/T017 established, then segment extraction, folding integration, measured optimization, and story validation. |
| T022 -> T023 | Foundation complete; sequential because both edit the new observer test file. |
| T024, T025, T026 | T023 complete; independent session, checkpoint, and logging/tracing test files. Do not overlap T026 with US1 T007 or US2 T016 edits to the logging tests. |
| T027 | T022-T026 test contracts established. |
| T028, T029 | T027 complete; observer scope discovery and builtin mutation metadata can run together. |
| T030 | T028 complete; snapshot/identity support builds on observer metadata. |
| T031 | T027-T030 complete and US1 T011 merged if that work is concurrent. |
| T032 -> T033 -> T034 -> T035 -> T036 | T031 complete; mutation observation, interpreter wrapping, baseline/replay guards, session wiring, then US3 regression validation. |
| T037, T038, T039 | T015, T021 and T036 complete; independent CLI, renderer, and notebook test files. |
| T040 -> T041 -> T042 | T037-T039 established; serialize shared supervisor/renderer/CLI edits. |
| T043 | T039 complete; run after T042 in the default sequential schedule; only change the worker if regression evidence requires it. |
| T044 -> T045 | T040-T043 complete, then automated matrix followed by real-terminal acceptance. |
| T046, T047, T048 | All stories complete; independent user docs, notebook prerequisite docs/metadata, and CLI help/test files. |
| T049 | T046 complete; generated documentation must follow its source changes. |
| T050 | T001 and all production implementation/help edits complete; packaging includes the rebuilt child entry point. |
| T051 | US1-US4 complete; add the concrete smoke assertions before final regression validation. |
| T052 | T048, T050 and T051 complete; final affected-language regression pass after the last code/test changes. |
| T053 | T044/T045 and T046-T052 complete, or documented platform blockers retained; no unsupported acceptance claims. |

### Within each story

1. Establish test expectations and confirm the intended failures.
2. Implement types/shared helpers before their consumers.
3. Implement event producers/rendering before integration.
4. Preserve evaluation, output and persistence semantics while changing presentation.
5. Run the story's focused checks before claiming its checkpoint.

### Parallel opportunities

- **US1 tests**: T007/T008/T009; **US1 implementation**: T011/T012 after T010.
- **US2 tests**: T016/T017.
- **US3 tests**: T024/T025/T026 after T023; **US3 implementation**: T028/T029 after T027.
- **US4 tests**: T037/T038/T039.
- **Polish**: T046/T047/T048; T049 documentation generation and T050 packaging may also proceed independently once their prerequisites finish.
- Do not parallelize tasks merely because their story labels differ: logger tests, interpreter commits, renderer state and CLI ownership have explicit shared-file constraints.

## Parallel Examples per User Story

### User Story 1

```text
After T006:
  T007: Header/direction tests in lang\tests\logging.test.ts
  T008: Renderer/IPC tests in lang\tests\cli-renderer.test.ts
  T009: CLI stream/lifecycle tests in lang\tests\cli.test.ts

After T010:
  T011: Typed model producers in lang\src\interpreter.ts
  T012: Child event view in lang\src\cli-renderer.ts
Join before T014 integration.
```

### User Story 2

```text
After T015:
  T016: JSON fidelity tests in lang\tests\logging.test.ts
  T017: Folding/resize/performance tests in lang\tests\cli-renderer.test.ts
Join before T018-T020 implementation.
```

### User Story 3

```text
After T023:
  T024: Current-cell sink tests in lang\tests\session.test.ts
  T025: Reconstruction tests in lang\tests\checkpoint.test.ts
  T026: Source/neutrality tests in lang\tests\logging.test.ts and lang\tests\tracing.test.ts

After T027:
  T028: Scope discovery in lang\src\state-observer.ts
  T029: Shared mutation metadata in lang\src\builtins.ts
Join before T031 interpreter integration.
```

### User Story 4

```text
After T015, T021 and T036:
  T037: Capability/color tests in lang\tests\cli.test.ts
  T038: Fault/cleanup tests in lang\tests\cli-renderer.test.ts
  T039: Notebook compatibility tests in vscode\test\notebook.test.ts and vscode\test\notebook-ui.test.ts
Join before the complete cross-mode validation in T044.
```

## Requirement and Acceptance Coverage

| Requirement group | Primary implementation tasks | Acceptance evidence |
|-------------------|------------------------------|---------------------|
| FR-001-FR-004: headers, direction, categories, complete ordered events | T003-T005, T011-T014 | T007-T009, T015; SC-001 and header portion of SC-002 |
| FR-005-FR-009: foldable JSON, fidelity, safe inspection, stable state | T004, T018-T020, T030 | T016/T017/T021; SC-002-SC-004 and SC-007 |
| FR-010-FR-015: capabilities, filtering, streams, lifecycle, embedding | T005/T006, T010-T014, T034/T035, T040-T043 | T008/T009/T025, T037-T039, T044/T045; SC-005/SC-006 |
| FR-016: terminal-control sanitization | T004/T018/T030, validated IPC in T010/T041 | T016/T038; headers, values, controls and retained transcript checks |
| FR-017: help and documentation | T046-T049 | T048/T049/T053 |
| FR-018-FR-021: no source traces, all binding scopes, identities, no-ops | T011, T027/T028/T030/T031/T035 | T022/T024/T026/T036; SC-008-SC-010 |
| FR-022-FR-024: mutation boundaries, aliases, immutable snapshots | T027-T033 | T022/T023/T036/T051; SC-008/SC-010/SC-011 |
| FR-025-FR-026: baseline, commit-time reconstruction guards, neutrality | T031/T034/T035 | T024-T026/T036/T044; SC-005/SC-008/SC-011 |
| Runtime, native packaging and isolated child delivery | T001/T012-T014/T047/T050 | T045/T050/T053 |

## Implementation Strategy

### MVP First

1. Complete T001-T006.
2. Complete US1 T007-T015 and demonstrate compact typed requests/responses, diagnostics and safe stderr-only terminal ownership.
3. This is the first demonstrable increment, **not completion of the feature**: synthetic state events do not satisfy the user's all-scope state refinement, and folding still requires US2.
4. The complete P1 scope is US1 + US2 + US3. Do not release the full feature without the US4 automation/lifecycle acceptance and final packaging/documentation checks.

### Incremental Delivery

1. Foundation: compatible plain/custom sinks and safe event data.
2. US1: readable direction-aware live/plain logs with safe lifecycle.
3. US2: independent JSON folding, accessibility through keyboard navigation, measured fidelity/performance.
4. US3: real committed variable-state changes across scopes, aliases and cells, with baseline/replay neutrality.
5. US4: complete automation, color, fault and real-terminal compatibility evidence.
6. Polish: runtime/help/source/generated docs, installed-package proof and final regression pass.

### Parallel Team Strategy

After the shared foundation, US3 observer-only work may overlap US1 renderer-only work, but serialize interpreter edits and shared logging tests using the dependency table. US2 follows US1. Use the explicit per-story test/helper parallel groups rather than multiple owners editing the same production file.

## Notes

- Total: **53 tasks**: Setup 1, Foundation 5, US1 9, US2 6, US3 15, US4 9, Polish 8.
- There are **18 `[P]` tasks** across seven explicit parallel groups; additional unmarked work can overlap only after its prerequisites and file-ownership constraints are satisfied.
- No build, test, native-platform, performance or terminal acceptance result is claimed by task generation.
- Validate the exact thresholds and output bytes; screenshots, old source-trace tests, or an import-only package check are not substitutes.
- Presentation failure must be explicit and preserve workflow outcome; do not silently drop events, catch unrelated errors, retain obsolete sinks, patch process streams, or weaken persistence validation.
