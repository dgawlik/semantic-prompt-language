# Feature Specification: Rewrite Copilot Backend

**Feature Branch**: `main` (existing branch; no branch-creation hook configured)

**Created**: 2026-11-02

**Status**: Draft

**Input**: User description: "rewrite copilot backend entirely with vercel ai sdk. make sure there is 100% compatibility with existing project features"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Run Existing Generation Workflows Unchanged (Priority: P1)

As a workflow author, I can run my existing documents without editing them and receive values that obey the same language, formatting, validation, and reasoning rules.

**Why this priority**: Existing workflows are the primary product contract; a replacement that changes their meaning is not compatible.

**Independent Test**: Run representative generation workflows with controlled responses, compare their results and failures with the baseline, and confirm the same documents also complete an authenticated live smoke test.

**Acceptance Scenarios**:

1. **Given** a document using `ask`, `think`, interpolation, document preambles, and scoped guidance, **When** it runs unchanged, **Then** each request receives the same assembled context and each completed answer is processed using the existing language rules.
2. **Given** requests for text, integer, float, boolean, array, object, or general JSON output, **When** valid and invalid answers are supplied, **Then** valid values retain their types and invalid values produce the same format or schema failure without coercion.
3. **Given** a generation request with a schema and an allowed repair count, **When** an answer fails validation, **Then** only the allowed generation repairs occur with the existing corrective context and exhausted repairs preserve the failure.
4. **Given** two separate model calls, **When** the second runs, **Then** it has no implicit conversation history from the first; only explicitly supplied context is available.

---

### User Story 2 - Complete Agent and Natural-Language Actions (Priority: P1)

As a workflow author, I can keep using explicit agents and Markdown blockquotes to perform real actions, share variables, and call existing functions.

**Why this priority**: Action execution and shared runtime state distinguish SPL from a text-generation wrapper.

**Independent Test**: Run a workflow that reads a fixture file through an explicit agent, then uses a blockquote to call a function, save its actual result, and consume that value in subsequent SPL.

**Acceptance Scenarios**:

1. **Given** an explicit agent, **When** it acts, **Then** it can use the existing file, web, search, shell, and configured MCP tools, but cannot use blockquote-only shared-scope tools.
2. **Given** a blockquote and visible variables and functions, **When** the model requests multiple runtime actions, **Then** actions execute immediately and sequentially, their real results return to the same turn, and later actions see earlier state changes.
3. **Given** a blockquote, **When** it loads or saves a variable, reads arguments or environment values, calls an existing function or builtin, narrows restrictions, or adds guidance, **Then** existing scope, value-validation, nested-call, and read-only rules remain in force.
4. **Given** a blockquote requests human input, **When** the CLI or embedding host supplies an answer, **Then** the answer returns to the ongoing command without repeating completed actions; explicit checkpoint mode retains its suspension behavior.
5. **Given** a blockquote invokes `success` or `fail`, or a runtime action fails, **When** that result occurs, **Then** execution follows the original document-ending or failure behavior and no subsequent action runs.
6. **Given** a blockquote completes runtime actions but produces no final prose, **When** the turn completes normally, **Then** completed actions remain usable; ordinary empty generation and unexpected aborted turns still fail.
7. **Given** a configured MCP server using stdio, HTTP, or SSE, **When** an agent invokes an enabled tool, **Then** its actual result is available to the turn and retained for tracing where currently supported.

---

### User Story 3 - Keep Existing Sign-In and Model Choices (Priority: P1)

As an existing user, I can upgrade without obtaining a different provider account, replacing credentials, or changing the way I choose a model.

**Why this priority**: A backend rewrite must not remove access for users who already have working GitHub Copilot credentials.

**Independent Test**: Exercise every supported credential source in an isolated test environment, then check model precedence, unavailable models, and supported and unsupported reasoning choices.

**Acceptance Scenarios**:

1. **Given** usable saved credentials, supported environment credentials, or an existing Copilot CLI or GitHub CLI login, **When** I run `spl login` or a model workflow, **Then** the existing credential-discovery behavior works without requiring a new service account or a second credential file.
2. **Given** no usable existing credentials, **When** I log in, **Then** the existing device-authorization experience, saved-credential location, `SPL_HOME` override, and logout behavior remain available.
3. **Given** a model specified in more than one place, **When** the workflow runs, **Then** the CLI override wins over the per-call choice, which wins over the document choice, which wins over the service default.
4. **Given** an available model and reasoning level, **When** they are selected, **Then** those choices are honored; an unknown model fails explicitly rather than silently selecting another.
5. **Given** a reasoning level that the selected model cannot honor, **When** the request runs, **Then** the existing warned use of the model default remains visible and the recorded effective settings reflect what actually happened.
6. **Given** a deterministic workflow, check-only operation, replay, or language-service request, **When** it runs without credentials or network access, **Then** it does not initialize model services or request authentication.

---

### User Story 4 - Preserve Restrictions and Reliable Failure Handling (Priority: P1)

As a user running workflows with external effects, I can trust the same restrictions and failure boundaries after upgrading.

**Why this priority**: Compatibility must include denied actions and interruption, not just successful answers.

**Independent Test**: Attempt prohibited file, command, network, and MCP actions, narrow restrictions during a blockquote, and inject tool failures, timeouts, and unexpected interruptions.

**Acceptance Scenarios**:

1. **Given** `ask` or `think`, **When** the model attempts any tool or external action, **Then** the action is denied and the request cannot complete successfully by ignoring that denial.
2. **Given** nested file, network, command, and MCP restrictions, **When** an agent requests an action, **Then** all active restrictions apply and neither native capabilities nor unconfigured tools bypass the runtime's allowed tool set.
3. **Given** a blockquote narrows restrictions, **When** a later runtime or MCP action is requested in the same turn or a nested function, **Then** the narrowed restrictions apply immediately.
4. **Given** a failed blockquote runtime or MCP action, **When** the model attempts to continue or retry, **Then** the original failure wins, completed external actions are not repeated, and no new action is authorized.
5. **Given** a timeout, cancelled notebook cell, or failed streaming consumer, **When** the request stops, **Then** no partial answer becomes a successful value and no later output or newly requested action is accepted.
6. **Given** an interruption whose remote acknowledgement stalls or fails, **When** the original local failure is known, **Then** it is surfaced without waiting indefinitely, and cleanup problems are diagnosed without replacing it.

---

### User Story 5 - Observe the Same Live Progress and Final Results (Priority: P2)

As a CLI, notebook, or embedding user, I can continue seeing live responses and available reasoning without duplicate results or corrupted structured output.

**Why this priority**: Live progress and stable logs are important existing integration and usability contracts.

**Independent Test**: Deliver controlled response and reasoning chunks, complete messages, multiple message identities, and interruptions through CLI and embedded/notebook consumers.

**Acceptance Scenarios**:

1. **Given** a running model request, **When** response and available reasoning updates arrive, **Then** they appear before completion, remain separated by request and channel, and support the existing append, replacement, and message-reset semantics.
2. **Given** `hide=True`, **When** the request streams, **Then** reasoning is not displayed while the response remains visible; `--silent` suppresses execution logs and previews as before.
3. **Given** a streamed JSON answer, **When** only part of it has arrived, **Then** previews do not mutate program variables or trigger parsing, schema validation, or repairs; the completed response remains authoritative.
4. **Given** completion or failure, **When** the transcript is finalized, **Then** the final response appears once, interrupted previews are explicitly marked, and stdout results, stderr logs, structured logging, and effective-setting information keep their existing contracts.

---

### User Story 6 - Reuse Traces, Recordings, Checkpoints, and Stores (Priority: P2)

As an automation user, I can reuse existing supported run artifacts and resume workflows within a matching runtime build without repeating agent-owned external effects.

**Why this priority**: Existing execution artifacts and persisted state are user data, not disposable backend internals.

**Independent Test**: Replay baseline-created traces and recordings offline, record and replay a new agent workflow, resume a matching-build checkpoint containing completed actions and a pending human question, and confirm a different-build checkpoint is rejected before execution.

**Acceptance Scenarios**:

1. **Given** supported existing trace or generation-recording files, **When** they are replayed after the upgrade, **Then** request matching, format versions, effective-setting data, and existing replay restrictions remain compatible without conversion.
2. **Given** a traced blockquote, **When** it is replayed, **Then** shared-state and function decisions are reconstructed using recorded external results without contacting models or MCP servers or repeating agent-owned effects; explicit deterministic tools retain their existing replay behavior.
3. **Given** a matching-build checkpoint awaiting a human answer, **When** the answer is supplied and the workflow resumes, **Then** completed decisions and effects are reused, execution continues from the existing journal contract, and top-level stores retain their existing load/save behavior; a checkpoint from a different runtime build is rejected before any action runs.
4. **Given** generation-only recording mode, **When** it encounters agents or blockquotes that the baseline disallows, **Then** it continues rejecting them rather than silently recording an incomplete execution.

---

### User Story 7 - Keep Embedded and Notebook Workflows Working (Priority: P2)

As an embedding developer or notebook user, I can upgrade without rewriting integrations or losing execution isolation and cancellation.

**Why this priority**: The same runtime is consumed outside the CLI, including through published library exports and notebook workers.

**Independent Test**: Run an existing embedding example unchanged and execute deterministic, generation, and blockquote notebook cells, then stop and reset the notebook.

**Acceptance Scenarios**:

1. **Given** an existing caller using the published `CopilotBackend`, backend request/response contracts, authentication helpers, logger hooks, or execution sessions, **When** the package is upgraded, **Then** its existing imports, supported options, result shapes, and cleanup calls remain usable.
2. **Given** two open notebooks, **When** cells run and retain variables or closures, **Then** each notebook remains isolated, cells use the current session state, and relative tool paths resolve beside the notebook.
3. **Given** an executing notebook cell, including an unbounded deterministic cell, **When** it is stopped or the session is reset or closed, **Then** the worker stops, old state is cleared under the existing rules, and a later run starts cleanly.
4. **Given** a notebook failure or streamed result, **When** it is displayed, **Then** source-qualified diagnostics, output/log boundaries, trust requirements, and explicit-run-only behavior are preserved.

### Edge Cases

- Missing, expired, revoked, or malformed credentials; denied, expired, or slowed device authorization; unavailable model discovery.
- A model disappears between discovery and execution, rejects a reasoning level, provides no reasoning, or returns an empty answer.
- Final messages repeat streamed text, replace earlier content, change message identity, or arrive after interruption; reasoning from a different agent must not leak into the main response.
- Multiple or overlapping tool requests, malformed arguments, unknown tools, function calls that make nested model requests, and values that fail a save-time schema check.
- Runtime and MCP tools share a local name on different servers; tool identity and server-specific allowlists must remain distinct.
- An MCP tool is denied after restrictions narrow, returns an error, disconnects, times out, or is still running when the main request fails.
- A blockquote changes shared state before failing or requesting human input; committed state follows existing non-transactional semantics.
- A stream consumer throws, cancellation acknowledgement never settles, cleanup fails, or closure is requested repeatedly.
- Replay artifacts contain historical backend-identification values or requests that do not match; existing mismatch and unused-entry diagnostics remain explicit.
- Native terminal rendering is unavailable, input/output is redirected, or a notebook has no human-input facility; existing host-specific behavior remains unchanged.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The replacement MUST preserve every supported user-visible behavior in the compatibility baseline defined under Assumptions across the CLI, library, and notebook runtime; release MUST NOT waive a capability because it is inconvenient to replace.
- **FR-002**: All existing live model execution and supporting authentication, model selection, and MCP behavior MUST work without the retired Copilot SDK or its managed runtime. A hidden fallback or a second execution path through the retired backend does not constitute a complete replacement.
- **FR-003**: Existing workflow files, language syntax, command names and options, embedding entry points, supported runtime/platform requirements, and configuration files MUST remain usable without mandatory user migration.
- **FR-004**: Generation MUST preserve prompt assembly, preambles, interpolation, guidance, fresh-call isolation, modifier defaults, strict output types, schema validation, repair limits, and existing failure classifications.
- **FR-005**: Explicit agents MUST retain their existing exact runtime/MCP tool set and action/validation behavior, with no generation-repair loop that repeats agent actions.
- **FR-006**: Blockquotes MUST retain the full shared-scope action set described in User Story 2, execute runtime actions immediately and sequentially, return real results within the ongoing turn, and never require generated SPL.
- **FR-007**: Human questions MUST retain normal CLI prompting, ordered `--human` answers, embedded answer handlers, and explicit checkpoint/resume behavior, including the existing unsupported-host errors and option-combination restrictions.
- **FR-008**: Authentication MUST retain saved-token reuse, `SPL_HOME`, supported Copilot CLI and GitHub CLI credential discovery, `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`, device authorization, authentication status, and logout semantics. Existing discovery precedence MUST be characterized and retained.
- **FR-009**: Model selection MUST retain existing precedence and accepted identifiers for models available to the same account. Invalid or unavailable selections MUST fail explicitly; reasoning capability handling MUST retain explicit warnings and accurate effective settings rather than silent substitution.
- **FR-010**: MCP support MUST retain stdio, HTTP, and SSE configuration, working directories, environment and workspace substitutions, headers, tool allowlists, configured timeouts, and current validation errors. Validation-only operations MUST NOT start servers.
- **FR-011**: Tool permissions MUST remain deny-by-default: generation has no tools, agents use only enabled runtime and configured MCP tools, and unconfigured or provider-native actions cannot bypass restrictions.
- **FR-012**: File, network, command, and MCP restrictions MUST preserve nested intersection, scope restoration, configured allowlist intersection, and immediate enforcement of restrictions narrowed during a blockquote, including nested calls.
- **FR-013**: Blockquote runtime/MCP failures and restriction violations MUST preserve the original failure, stop further action authorization, and prevent model continuation or automatic retries from repeating completed effects.
- **FR-014**: Model-service errors, empty ordinary-generation replies, timeouts, unexpected aborts, and malformed responses MUST retain existing failure categories, actionable diagnostics, source attribution, and CLI exit behavior. Partial responses MUST NOT be returned as success.
- **FR-015**: Request termination and backend closure MUST stop accepting new output/actions and release owned request resources and MCP connections/processes. Cleanup and remote-abort failures MUST be diagnosed without masking the original failure or indefinitely delaying its delivery.
- **FR-016**: Live output MUST preserve response/reasoning separation, request/message identity, append/replace updates, optional reasoning visibility, observer-error propagation, and the authority of the final response over previews.
- **FR-017**: CLI and embedding logging MUST preserve stdout/stderr separation, structured and string/event/stream sink contracts, severity filtering, silent behavior, terminal/nonterminal behavior, state logs, and nonduplicated final transcripts. Effective model and reasoning data MUST be truthful.
- **FR-018**: Supported existing traces, generation recordings, checkpoints, and stores MUST retain their formats, matching rules, failure diagnostics, side-effect rules, and privacy warnings without mandatory conversion. Traces, generation recordings, and stores remain cross-backend readable; checkpoints retain the existing exact runtime-build guard and reject cross-build resume before execution. New artifacts MUST remain consumable by existing project readers subject to those same compatibility guards.
- **FR-019**: Replay and checkpoint reconstruction MUST NOT repeat agent-owned external effects or contact live model/MCP services; explicit deterministic tools and stores MUST retain their existing behavior rather than becoming an unintended dry run.
- **FR-020**: Deterministic execution, syntax/configuration checking, supported replay, library import, and language-service features MUST remain usable without credentials, model connectivity, or eager model-runtime initialization.
- **FR-021**: Published backend and authentication exports, constructor options, request/response contracts, custom-backend support, and lifecycle ownership MUST remain source-compatible with existing consumers.
- **FR-022**: Notebook execution MUST preserve isolated stateful workers, sequential cell execution, shared variables and closures, lazy model access, streamed/final outputs, source-qualified failures, working-directory behavior, trust gating, and cancellation/reset semantics. This migration MUST NOT add unsupported notebook-only capabilities.
- **FR-023**: Release evidence MUST include a baseline-to-replacement compatibility inventory covering every row below, with executable acceptance checks for applicable success, failure, permission-denial, interruption, and offline behavior. Existing behavior checks MUST NOT be removed or weakened merely to accommodate the replacement; replacement of retired-backend-specific test mechanics MUST retain the same behavioral assertions.
- **FR-024**: User-facing documentation and examples MUST accurately describe the replacement while preserving existing usage instructions, credential/configuration expectations, and artifact compatibility guarantees.

### Compatibility Coverage

Every row is required. This is the minimum inventory, not permission to omit a supported behavior discovered during planning.

| Capability | Required coverage | Requirements | Acceptance stories |
| --- | --- | --- | --- |
| Generation and validation | All call kinds, modifiers, formats, schemas, repair boundaries, preambles, guidance, and fresh context | FR-004 | 1 |
| Explicit agents | Exact runtime tools, real effects, configured MCP, no shared-scope tools or action repairs | FR-005 | 2, 4 |
| Blockquote commands | Every shared-scope action, ordered execution, nested calls, termination, and real results | FR-006, FR-013 | 2, 4 |
| Human interaction | Prompted and supplied answers, host handlers, suspension/resume, unsupported combinations | FR-007 | 2, 6, 7 |
| Credentials and model choices | Every credential source, precedence, login/logout, model availability, reasoning fallbacks | FR-008, FR-009 | 3 |
| MCP configuration and execution | All three transports, substitutions, identities, allowlists, timeouts, results, and errors | FR-010 | 2, 4, 6 |
| Permissions and restrictions | Generation denial, native-tool denial, nested scopes, dynamic narrowing, and blocked continuation | FR-011, FR-012, FR-013 | 4 |
| Failure and lifecycle | Original failures, timeouts, interruption, empty output, cleanup, and repeated closure | FR-014, FR-015 | 2, 4, 7 |
| Streaming and observability | Responses/reasoning, identities, final authority, logging sinks, CLI rendering, and quiet modes | FR-016, FR-017 | 5, 7 |
| Existing execution artifacts | Old and new traces/recordings, matching, checkpoints, stores, and no repeated effects | FR-018, FR-019 | 6 |
| Offline and language features | Deterministic workflows, checking, replay, parsing, editor features, and lazy initialization | FR-020 | 3, 7 |
| Published embedding contract | Existing imports/options, custom backends, result/error shapes, sessions, and host cleanup | FR-021 | 7 |
| Notebook runtime | Worker/state isolation, execution ordering, paths, output, diagnostics, trust, and reset/stop | FR-022 | 5, 7 |
| Complete replacement and delivery | No retired runtime dependency, no required user migration, complete evidence, accurate documentation | FR-001, FR-002, FR-003, FR-023, FR-024 | 1-7 |

### Key Entities *(include if feature involves data)*

- **Compatibility baseline**: The pinned project's supported behaviors, public contracts, fixtures, and examples, with each capability linked to its acceptance evidence.
- **Model operation**: A generation or agent request with prompt context, model choice, reasoning preferences, active restrictions, permitted actions, and a completed response or original failure.
- **Runtime action**: An operation requested by a blockquote or agent, including its validated arguments, effective permissions, real result, and completed external effects.
- **Credential source**: An existing saved or discovered credential and its authentication status, precedence, and lifecycle; secret values are not compatibility-report data.
- **Execution artifact**: A supported trace, recording, checkpoint journal, or variable store whose format and side-effect semantics survive the replacement.
- **Live update**: A request-scoped response or reasoning preview with message identity and append/replacement meaning; it is not an authoritative program value.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of inventoried baseline capabilities have passing replacement acceptance evidence, with zero missing capabilities, migration-related waivers, or weakened behavioral assertions.
- **SC-002**: 100% of the existing offline behavioral regression checks pass after any necessary test-mechanics updates, and every applicable compatibility-coverage row has passing success and negative-path evidence.
- **SC-003**: All baseline example workflows and the published embedding example remain valid without edits required by the migration; deterministic examples complete offline, and authenticated acceptance workflows complete generation, explicit-agent, blockquote, human-answer, and configured-MCP journeys successfully.
- **SC-004**: 100% of supported baseline-created trace, generation-recording, and store fixtures replay or load without conversion; matching-build checkpoint fixtures resume, and cross-build checkpoint fixtures fail with a runtime mismatch before execution. Measured agent-owned external-effect counts during replay and checkpoint reconstruction are zero.
- **SC-005**: Every tested forbidden action is blocked before its effect occurs; every tested interrupted or failed request rejects partial-success results and executes zero newly requested actions after termination.
- **SC-006**: In controlled streaming tests for CLI, notebook, and embedded consumers, previews arrive before completion, hidden reasoning stays hidden, and each completed response appears exactly once in the final transcript.
- **SC-007**: Existing users can authenticate and select available models using every previously supported credential source and selection method without obtaining a different provider account or changing workflow configuration.
- **SC-008**: After each tested completion, failure, timeout, closure, or notebook reset, zero request-owned connections/processes remain active once cancellation/cleanup settles, no late update is accepted, and the original outcome remains visible.

## Assumptions

- **Baseline**: Compatibility is measured against commit `745e516ef78031c3654b51ec674c0f00d19dc45e`, its supported public behavior, and its offline/live behavioral checks. The baseline includes [runtime usage and embedding](../../lang/README.md), [CLI, MCP, artifacts, and authentication](../../docs-template/CLI.md), [model and blockquote behavior](../../docs-template/LLM-commands.md), [credential sources](../../docs-template/Getting-started.md), and [notebook/editor behavior](../../vscode/README.md).
- **Fixed delivery constraint**: The user explicitly requires Vercel AI SDK to replace the Copilot backend entirely. This is the requested implementation boundary, not a choice left open by this specification; provider integration, dependencies, and architecture are planning decisions.
- **Service continuity**: GitHub Copilot remains the model service and existing account access remains sufficient. Adding other model providers, a hosted proxy, mandatory paid credentials, or a new user-facing backend selector is outside scope.
- **Confirmed transport policy (2026-11-02)**: The user approved a project-owned direct adapter over undocumented GitHub Copilot HTTP interfaces because no first-party direct integration satisfies the complete-replacement constraint. This approval does not waive model-discovery, reasoning, authentication, or other compatibility checks; those remain mandatory release gates.
- **Meaning of 100%**: Compatibility means no loss of supported capabilities, configuration, integration contracts, data readability, or failure/safety semantics. It does not mean identical nondeterministic generated text, token timing, or reproduction of private implementation details.
- **Baseline conflicts**: Existing documentation or test-mechanics references to the retired runtime are not requirements to keep it. If documented supported behavior and executable behavior conflict, planning must record the discrepancy and resolve the intended contract explicitly rather than silently dropping the capability. Unrelated existing defects are not migration work.
- **Availability boundary**: External account entitlements, the service's current model catalogue, rate limits, and availability are outside project control. Compatibility checks use the same account and available capabilities, and service failures must still surface explicitly.
- **Verification dependency**: Offline controlled fixtures are required for all behavioral and negative-path checks. Authenticated checks require an authorized test account and controlled MCP fixtures; unavailable credentials or services make those checks unverified, not passing or waived.
- **Artifact identity**: Historical effective-setting and backend-identification values remain readable. New diagnostics may truthfully identify the replacement without changing artifact formats or requiring users to rewrite existing files.
- **Confirmed checkpoint boundary (2026-11-02)**: The user selected preservation of the existing runtime-build safety guard. CLI checkpoints fingerprint the package version, Node.js version, and emitted runtime files; cross-build resume, checkpoint migration, and runtime allowlists are outside this feature. A journal created before the rewrite is not resumable by the new build.
- **Safety boundary**: Existing restrictions remain runtime checks, not an operating-system sandbox. Completed external effects are not made transactional or rolled back by this migration.
- **Scope**: No language redesign, editor feature redesign, new notebook human-input/MCP configuration surface, replay-format upgrade, or unrelated logging redesign is included. User-visible behavior that already works must continue working regardless of which internal component currently provides it.
- **Governance**: The checked-in constitution contains unfilled template placeholders and establishes no additional concrete project principles for this feature.
