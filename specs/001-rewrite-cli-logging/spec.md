# Feature Specification: Minimal Interactive CLI Logging

**Feature Branch**: `main` (unchanged; no branch-creation hook configured)

**Created**: 2026-10-30

**Status**: Draft

**Input**: User description: "rewrite existing logging solution from spl-lang cli. it should use bettertui for node.js. the output should be minimal but different colors for agent input and output. the json content should be foldable but pretty printed. add icons next to the messages corresponding to their type."

**Refinement (2026-10-30)**: "run of deterministic code with code source is not logged, only what is logged is change of the state of variables in any scope"

**Planning approval (2026-10-30)**: The user approved raising SPL's minimum
Node.js version to 24.15 and using an isolated BetterTUI renderer subprocess
whose output goes to the CLI's stderr, preserving clean workflow stdout.
The user also chose a complete, expanded transcript retained on stderr after
the live view closes, rather than retaining only collapsed summaries.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Follow execution with minimal visual noise (Priority: P1)

As a person running an SPL workflow, I want compact messages with recognizable
types so I can follow what is sent to an agent, what comes back, and what needs
attention without scanning repetitive log decorations.

**Why this priority**: Differentiating requests, responses, and diagnostics is
the primary purpose of the logging rewrite.

**Independent Test**: Run a workflow with a model request, response, script log,
and failure. Check the message headers, direction colors, ordering, and absence
of repeated badges on continuation lines.

**Acceptance Scenarios**:

1. **Given** a color-capable interactive terminal, **When** an agent request and
   response appear, **Then** they use distinct direction colors, distinct icons,
   and explicit input/output labels.
2. **Given** messages containing multiple lines, **When** they are displayed,
   **Then** each event has one compact header with its icon and type, and
   continuation lines do not repeat that header.
3. **Given** error, warning, information, debug, and variable-state change
   events, **When** each is visible at the selected log level, **Then** each
   category has a consistent, distinct icon and text label.
4. **Given** an execution that fails after sending a request, **When** the
   failure is reported, **Then** the request remains visible, the failure is
   clearly identified, and no response is fabricated.

---

### User Story 2 - Inspect JSON only when needed (Priority: P1)

As a person reviewing structured agent messages, script logs, or variable-state
changes, I want JSON objects and arrays collapsed until I need their contents,
then expanded in a readable format without losing the surrounding conversation.

**Why this priority**: Large structured payloads are a major source of visual
noise; folding them must not sacrifice access to their actual contents.

**Independent Test**: Display two JSON payloads in an interactive run, expand
and collapse each with the keyboard, and compare the expanded content with the
original payloads.

**Acceptance Scenarios**:

1. **Given** a message containing a JSON object or array, **When** it first
   appears in an interactive run, **Then** its body is collapsed into a
   single-line summary identifying the container type and folded state.
2. **Given** a collapsed payload, **When** the user selects it and activates the
   advertised toggle action, **Then** its complete content is shown with
   two-space indentation and readable nested structure.
3. **Given** two separate payloads and one expanded payload, **When** another
   message arrives or the other payload is toggled, **Then** the first
   payload's folded state and association with its message remain unchanged.
4. **Given** an expanded payload, **When** the user toggles it again, **Then**
   it returns to its summary without changing or discarding its content.
5. **Given** a structured log value, a serialized JSON response, or a valid JSON
   block within a labeled or multiline message, **When** it is displayed,
   **Then** the object or array is foldable while surrounding text remains
   readable and in its original order.
6. **Given** malformed JSON or ordinary prose in an explicit script log,
   **When** it is displayed, **Then** it remains readable text and is not
   misleadingly presented as a foldable JSON payload.

---

### User Story 3 - Follow variable changes in every scope (Priority: P1)

As a person following a workflow, I want automatic deterministic execution logs
to show only actual variable-state changes, with their scope and previous and
new values, instead of reproducing the statements being executed.

**Why this priority**: State changes explain what execution accomplished without
the noise of source-code traces or steps that have no effect on variables.

**Independent Test**: Run a deterministic fixture with declarations, repeated
assignments, nested scopes, function calls, and collection mutations. Compare
its expected state transitions with the logs, including a same-value assignment
and a read-only expression that must produce no automatic execution event.

**Acceptance Scenarios**:

1. **Given** an absent variable, **When** it is initialized and then changed,
   **Then** initialization reports an absent previous binding and its new value,
   and the subsequent change reports the previous and new values in order.
   Neither event includes the executed statement's source.
2. **Given** an outer variable and a same-named variable in an inner block,
   **When** either changes, **Then** its defining scope is identifiable.
   Assigning to an enclosing binding identifies that binding's scope rather
   than misreporting a new local variable.
3. **Given** a function call, loop iteration, or exception handler, **When**
   parameters, loop variables, handler variables, or local variables are bound
   or changed, **Then** each committed change is reported, and separate calls
   or iterations have distinguishable scopes.
4. **Given** a list or dictionary shared through aliases across scopes,
   **When** an item, nested member, or mutating method changes its contents,
   **Then** the mutation is reported once with the affected bindings and
   scopes. Previously recorded values do not change with later mutations.
5. **Given** a variable assigned its existing value, **When** that assignment,
   a read-only expression, or control flow with no binding changes executes,
   **Then** no automatic deterministic execution event is emitted.
6. **Given** an assignment whose value calculation fails before committing,
   **When** the error is reported, **Then** no change is claimed for its target.
   Any separate state changes already committed while calculating the value
   remain reported, followed by the existing error diagnostic.
7. **Given** a closure or recursive function, **When** it changes captured
   variables or invocation-local variables, **Then** the event identifies the
   correct retained or invocation scope without merging same-named bindings.
8. **Given** a new function binding, **When** it is reported, **Then** its value
   is represented by a readable callable identity without printing its body
   or captured source code.
9. **Given** a model-assisted action that saves a variable, **When** that action
   commits a new binding or changes an existing one, **Then** it follows the
   same state-change reporting rules and model input/output remains visible.
10. **Given** a variable that changes and then returns to its earlier value,
    **When** both changes commit, **Then** both transitions remain visible
    rather than being reduced to an unchanged final snapshot.

---

### User Story 4 - Keep automation and existing controls reliable (Priority: P2)

As a person running SPL in scripts, CI, or a terminal with limited capabilities,
I want the logging refresh to preserve command results and diagnostics without
requiring keyboard interaction.

**Why this priority**: A visual improvement must not break pipelines, resumable
workflows, log filtering, or embedded callers.

**Independent Test**: Run the same fixture interactively, with stderr redirected,
with non-terminal stdin, in silent mode, and in checkpoint/resume mode. Compare
results, diagnostics, exit codes, and saved data.

**Acceptance Scenarios**:

1. **Given** redirected stderr or non-terminal stdin, **When** the workflow
   runs, **Then** logs are append-only text with complete, expanded JSON, no
   cursor-control sequences, and no keyboard reads or waits.
2. **Given** an existing log-level selection, **When** the workflow runs,
   **Then** ordinary severity filtering is unchanged, and model transcripts
   and variable-state changes remain visible at every non-silent level.
   Automatic deterministic source-code traces appear at no level.
3. **Given** `--silent`, **When** execution occurs, **Then** no execution logs,
   interaction hints, or terminal interface appear; existing usage, syntax,
   and checkpoint-usage diagnostics still appear when applicable.
4. **Given** color is disabled or icons cannot be displayed, **When** messages
   appear, **Then** direction and category remain identifiable through text
   labels and plain-text icon substitutes.
5. **Given** a checkpoint or resume invocation, **When** it runs or reports a
   pending human request, **Then** it never reads stdin and its stdout envelope
   and exit code remain unchanged.
6. **Given** an execution that completes, fails, or is interrupted, **When**
   control returns to the shell, **Then** no folding interaction delays exit
   and the terminal's input mode and cursor visibility are restored. After
   ordinary completion, one complete transcript with expanded JSON remains
   on stderr.
7. **Given** a checkpoint that resumes by reconstructing already executed
   work, **When** reconstruction and new execution occur, **Then** historical
   state changes are not logged again and newly committed changes are logged
   once, without changing checkpoint data or command results.

### Edge Cases

- Empty objects and arrays have clear summaries and can be expanded; JSON
  strings, numbers, booleans, and null remain readable inline values.
- Deeply nested or lengthy payloads remain accessible through navigation without
  silently truncating data or interleaving different messages.
- JSON supplied as text retains large integers, negative zero, exponent
  notation, duplicate keys, and string escapes when expanded.
- Errors, circular objects, big integers, and other non-JSON values remain
  inspectable and do not crash logging.
- Terminal resizing, narrow windows, and incoming messages do not associate a
  payload's folded state with a different event.
- Color-disabled terminals still support folding when interactive; terminals
  without interactive capabilities use complete append-only output.
- Embedded control characters in message contents cannot act as navigation or
  terminal commands; ordinary line breaks remain readable.
- A rendering or interaction failure produces an explicit stderr diagnostic,
  restores terminal state, and uses complete append-only logs for subsequent
  events without altering the workflow outcome.
- A new binding containing null is distinguishable from an absent binding;
  leaving a scope does not generate synthetic variable-deletion messages.
- A container mutation may affect multiple bindings, including aliases in
  enclosing or captured scopes; it must not be missed merely because no
  variable is reassigned.
- A variable changed several times during a single expression retains each
  committed transition, including changes made before a later failure.
- No-op mutations and skipped branches produce no state-change events.
  Replacing a collection with a different collection is a binding change even
  when its contents match, because its alias relationships can differ.
- Runtime inputs, built-in registration, and variables loaded before execution
  are an initial baseline, not a bulk variable-state dump.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The CLI MUST present each visible event with one compact header
  containing an icon and a textual category or direction label. It MUST NOT
  repeat headers on body continuation lines, add decorative enclosing panels,
  or add default timestamps to every event.
- **FR-002**: Model inputs and outputs MUST have different, consistently applied
  direction colors when color is enabled, plus distinct icons and explicit
  direction labels that remain meaningful without color. This applies to
  `ask`, `think`, `agent`, and blockquote model interactions.
- **FR-003**: Errors, warnings, information, debug messages, and variable-state
  changes MUST each have stable, distinct category icons and text
  labels. Unclassified messages MUST retain their content with an explicit
  generic category.
- **FR-004**: Visible events MUST preserve their emission order, message
  association, and full content; failed calls MUST NOT generate fictional
  outputs. Folding may hide content visually but MUST NOT discard it.
- **FR-005**: JSON objects and arrays in structured values, complete JSON text,
  labeled payloads, and standalone JSON blocks within multiline messages MUST
  be foldable independently in interactive output and initially collapsed.
  Surrounding text MUST retain its position relative to the payload.
- **FR-006**: Each collapsed payload MUST occupy one summary line identifying
  its object/array type and folded state. Users MUST be able to navigate to a
  payload and toggle it with the keyboard; a compact visible hint MUST explain
  the navigation and toggle actions.
- **FR-007**: Expanded JSON MUST use two-space indentation and preserve the
  supplied data, including original numeric and string tokens and duplicate
  keys in serialized JSON. Primitive JSON values need not be foldable.
- **FR-008**: Folding and selection MUST remain associated with the same event
  when other events arrive or the terminal is resized. All expanded content
  MUST remain reachable without silent truncation.
- **FR-009**: Malformed JSON and non-JSON values MUST remain readable without
  being treated as JSON containers. Unsupported
  JSON serialization MUST NOT suppress the message or crash logging.
- **FR-010**: Interactive controls MUST activate only when stdin and stderr
  support an interactive terminal and the invocation permits reading stdin.
  Non-interactive output and checkpoint/resume invocations MUST never read
  stdin or wait for log inspection and MUST show all JSON expanded in
  append-only text without cursor-control sequences.
- **FR-011**: Existing `--log-level` and `--silent` controls MUST be preserved:
  ordinary messages retain severity filtering; model transcripts and the new
  variable-state change events MUST be visible at every non-silent level.
  Automatic deterministic source-code traces MUST NOT appear at any level.
  Silent execution creates no interactive interface or state-change logs;
  existing command-usage diagnostics remain visible as before.
- **FR-012**: Logs and interface content MUST remain on stderr. Workflow stdout
  results, failure payloads, checkpoint envelopes, exit codes, trace/recording
  journals, replay matching, and stored variables MUST remain unchanged.
- **FR-013**: Existing color controls MUST be honored: `NO_COLOR` takes
  precedence; otherwise `FORCE_COLOR` enables color except when set to `0`;
  automatic color is disabled for redirected stderr or `TERM=dumb`. Forcing
  color MUST NOT enable interactivity. Text labels and plain-text icon
  substitutes MUST preserve meaning where color or icons are unavailable.
- **FR-014**: Completion, failure, interruption, or a presentation error MUST
  restore any terminal state changed by logging. Normal completion MUST NOT
  wait for a keypress. After the interactive view closes, a complete, expanded
  append-only transcript MUST remain on stderr without duplicating retained
  events. Presentation errors MUST be reported explicitly before
  switching to complete append-only logging, without changing execution results.
- **FR-015**: Embedded callers and custom log sinks MUST retain non-interactive
  operation by default, filtering and complete content access under the revised
  event policy, and explicit color control without acquiring terminal input or
  lifecycle side effects.
- **FR-016**: Message content MUST NOT be able to inject terminal controls.
  Legitimate multiline content MUST remain readable.
- **FR-017**: CLI help and logging documentation MUST describe icons,
  direction distinctions, default folding and keyboard interaction,
  non-interactive behavior, and existing verbosity and color controls. They
  MUST describe variable-state changes as the replacement for automatic
  deterministic source-code traces, including scope and no-op behavior.
- **FR-018**: Automatic deterministic execution reporting MUST consist only
  of variable-state changes. It MUST NOT emit executed statement source,
  statement-start messages, control-flow steps, reads, or pure computations.
  Explicit script logs, model transcripts, and existing error diagnostics
  MUST remain available under their respective controls.
- **FR-019**: State-change reporting MUST cover user bindings in every scope:
  top-level, nested blocks and branches, loop iterations, function calls,
  exception handlers, and retained closure scopes. It MUST include binding
  initialization, reassignment, collection mutation, and committed variable
  saves performed by model-assisted actions.
- **FR-020**: Each state-change event MUST identify the affected variable
  binding or bindings, their defining scopes, and their previous and new
  values. A scope identifier MUST distinguish shadowed names, separate
  function invocations, and separate loop iterations. An absent previous
  binding MUST be distinguishable from a previous null value.
- **FR-021**: Assignments of the existing value and operations leaving a
  binding and its value unchanged MUST NOT produce state-change events.
  Each actual committed transition MUST remain visible even if a later
  transition restores the earlier value.
- **FR-022**: Collection mutations MUST be reported for item/member writes,
  nested changes, and mutating methods, including changes reached through
  aliases. Each underlying mutation MUST be reported once, identifying the
  affected user bindings and their scopes rather than duplicating the mutation
  for each alias.
- **FR-023**: State-change events MUST describe committed changes in execution
  order, not attempted changes. A failed operation MUST NOT claim an
  uncommitted target update or erase separate changes committed before the
  failure. Recorded previous and new values MUST retain their event-time
  contents after subsequent mutations.
- **FR-024**: Structured previous/new values MUST use the same pretty-printing
  and folding rules as other JSON payloads. Function bindings MUST use readable
  callable identities without function bodies, captured source, or internal
  execution details. Non-JSON values MUST remain inspectable.
- **FR-025**: Runtime setup, preloaded variables, and read-only runtime inputs
  MUST be treated as an initial baseline rather than automatically dumped as
  state changes. Scope exit MUST NOT create synthetic deletion events.
- **FR-026**: Checkpoint reconstruction MUST NOT re-emit historical state
  changes; newly executed changes MUST be reported once. State-change
  observation MUST NOT re-evaluate expressions, invoke functions or tools,
  modify variables, or alter existing trace, store, or checkpoint formats.

### Key Entities *(include if feature involves data)*

- **Log event**: A visible execution or diagnostic message with a category,
  optional model direction and interaction kind, content, and emission order.
- **JSON payload**: An object or array associated with a log event, retaining
  its complete content and independent expanded/collapsed state.
- **Presentation context**: The terminal capabilities, color preferences,
  verbosity, and invocation constraints that determine whether output may be
  interactive.
- **Variable binding**: A user-visible name in a defining scope, distinct from
  a same-named binding in another scope; bindings may share a collection value.
- **Scope identity**: A run-local identity for a top-level, block, iteration,
  function-invocation, handler, or retained closure scope.
- **State change**: A committed creation, replacement, or mutation associated
  with affected bindings, scope identities, event-time previous/new values,
  and execution order.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In a fixture covering all seven named message types (model input,
  model output, error, warning, information, debug, and variable-state change),
  100% of visible events have the correct icon and label; input and output
  use different colors whenever color is enabled.
- **SC-002**: Every initially collapsed JSON object or array occupies exactly
  one body summary line, and every event has exactly one header, regardless
  of the number of lines in its expanded body.
- **SC-003**: Users can expand or collapse a selected payload with one toggle
  action, see the change within 100 milliseconds for payloads up to 100 KB,
  and recover 100% of its content across repeated toggles.
- **SC-004**: A 1,000-event fixture with mixed text and nested JSON has zero
  missing, reordered, or misassociated events; selected folded states remain
  attached to their payloads after incoming events and terminal resizing.
- **SC-005**: Across interactive, redirected, silent, color-disabled, and
  checkpoint/resume runs of identical fixtures, stdout output, exit codes,
  and saved trace/store contents match the existing behavior exactly.
  Non-interactive runs contain no cursor-control sequences or hidden JSON.
- **SC-006**: In success, script failure, interruption, and presentation-error
  checks, 100% of runs return terminal control without an inspection keypress
  and leave input mode and cursor visibility in their pre-run state.
- **SC-007**: Using only the displayed labels and interaction hint, a reviewer
  can identify a model request and its response, inspect a nested JSON field,
  and collapse the payload again without consulting external documentation.
- **SC-008**: A fixture covering top-level, nested-block, loop, function,
  exception-handler, and retained-closure scopes reports 100% of expected
  committed transitions exactly once, with correct scope attribution and
  event-time previous/new values. Coverage includes alias mutations,
  model-assisted saves, and changes preceding a failed operation.
- **SC-009**: Across error, information, and debug verbosity checks, automatic
  deterministic source-code traces number zero. A fixture containing only
  reads, same-value assignments, and no-op mutations after baseline setup
  produces zero state-change events.
- **SC-010**: In a same-name shadowing and recursive-call fixture, a reviewer
  can attribute every change to its defining scope using only the event's
  variable name and scope label, with zero ambiguous bindings.
- **SC-011**: Identical fixtures run with logging enabled and silent produce
  identical workflow results, side-effect counts, and saved data. Checkpoint
  reconstruction re-emits zero historical state-change events.

## Assumptions

- The user's requested "bettertui for node.js" is a delivery constraint, not
  permission to substitute a different library. Exact package identity,
  availability, and compatibility were confirmed during planning as
  `@bettertui/core` 0.1.1. The user approved Node.js >=24.15 as the new minimum;
  retaining support for older Node.js releases is outside this feature's scope.
- "Agent input and output" means prompts sent to and responses returned from
  all existing model interaction kinds, not only the `agent` keyword.
- "Minimal" means less repeated visual decoration and state-change-only
  automatic deterministic reporting. The refinement intentionally replaces
  statement/source traces at every verbosity; model transcripts and explicit
  script logs retain their existing visibility.
- The refinement amends this existing CLI logging feature rather than creating
  a separate feature. "Only" applies to automatic deterministic execution
  reporting, not to model transcripts, explicit script logs, or diagnostics.
- Variable creation includes function parameters, loop bindings, exception
  bindings, and function declarations. Same-value scalar assignment is a
  no-op; assigning the same collection without changing it is also a no-op.
  Replacing a collection with a different collection counts as a change even
  if their contents match. Callable identity, not its body, represents a
  function value.
- Initial loaded state and interpreter-managed runtime inputs are baseline
  state, not changes caused by workflow execution. Scope lifetime bookkeeping
  is not logged; mutations of values retained by closures remain in scope.
- The ban on automatic source tracing does not remove source-location or
  source-context information from existing failure diagnostics, nor prohibit
  source text explicitly included by a user in a script log or model prompt.
- Folding applies to whole JSON object/array payloads. Independently folding
  each nested property, editing payloads, searching history, saving UI state,
  and post-exit log browsing are outside this feature's scope.
- The interactive view is available during execution and does not keep a
  finished command alive solely for inspection.
- This feature changes CLI presentation and automatic deterministic event
  selection, not SPL evaluation semantics, authentication flows,
  editor-extension UI, trace formats, persistence formats, or the programmatic
  result contract.
- Existing scope, assignment, mutation, and model-action behavior are
  dependencies. Observing state must not introduce new evaluations, model
  calls, tools, or workflow effects.
- Performance checks use a local terminal and synthetic payloads so network
  latency and model response time do not affect presentation measurements.
- The available project constitution is an unfilled template and contributes
  no ratified constraints.
