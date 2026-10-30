# Data Model: Minimal Interactive CLI Logging

This is an in-memory TypeScript design, not a persistence schema. No entity is
added to traces, stores, recordings, or checkpoint journals.

## 1. Log Event

| Field | Meaning and validation |
|-------|------------------------|
| `id` | Immutable ID unique within the logging session |
| `sequence` | Strictly increasing visible-event order, allocated after filtering |
| `kind` | `error`, `warning`, `info`, `debug`, `model-input`, `model-output`, `state`, or explicit legacy/generic message |
| `origin` | Diagnostic, script log, model interaction, state observation, or explicit embedding call |
| `segments` | Ordered, detached body segments |
| `interaction` | Optional request ID, interaction kind, and response/action role |
| `change` | State-change detail, present only for a state event |

Use a discriminated union so model direction and state metadata cannot be
mistaken for arbitrary message strings. Model/state events have the existing
transcript visibility floor, not error severity. Do not label them as failures.

**Invariants**:

- Filtering precedes formatting, snapshot construction, and sink delivery.
- An event goes to either the configured structured sink or its string sink,
  never implicitly to both.
- Event bodies contain no mutable runtime values, environments, backend
  objects, functions, or terminal state.
- There is no automatic source-statement event variant.
- Event IDs remain stable across IPC, rendering, fallback, and final output.

## 2. Body Segment and JSON Payload

| Variant/field | Meaning |
|---------------|---------|
| Text segment | Sanitized literal text, preserving legitimate line breaks |
| JSON segment | Object/array payload with a stable payload ID and source tokens |
| Inspection segment | Safe readable representation of non-JSON data |
| `payloadId` | Event ID plus stable segment/change-field identity |
| `container` | Object or array |
| `source` | Complete validated JSON text; not a parsed-and-regenerated substitute |
| `summary` | One-line container/fold indicator, not discarded content |

JSON input can originate from serialized model text, structured logs, or
snapshot display values. Text before/between/after JSON stays in order.
Serialized JSON retains duplicate keys, numeric spellings, and string escapes.
Primitive JSON remains inline rather than acquiring a fold state.

Terminal escape/control sanitization applies to all visible text, including
labels and inspected values. No payload is interpreted as terminal instructions.

**Relationships**: One event owns zero or more payloads. One payload has one
fold state. Before/after values of different affected bindings may each own
payloads, while remaining part of one logical mutation event.

## 3. Scope Identity and Binding Reference

| Field | Meaning |
|-------|---------|
| `scopeId` | Weakly associated, run/session-local identity |
| `kind` | Global, block/branch, iteration, function call, handler, or retained scope |
| `parentId` | Optional defining lexical parent, not an invented caller relationship |
| `label` | Readable context without executed source or function body |
| `bindingId` | Scope identity plus variable name |
| `name` | Original variable name, including same-name shadowed bindings |

Repeated calls/iterations have distinct scope IDs. An enclosing assignment
uses the owner returned by existing scope lookup, not the current inner scope.
Retained closure environments stay discoverable through reachable functions;
inactive unreachable scopes are not retained solely by observation metadata.

**Root discovery**:

1. Begin with globals, active execution environments, and the environment of
   the operation being observed.
2. Walk lexical parents and user function closures with cycle guards.
3. Enumerate binding names in each reachable environment independently;
   shadowing does not remove outer bindings from observation.
4. Walk list/dict data graphs to find references to a mutation target. Function
   closures are scope roots, not part of a callable's rendered value.

Session cells observe surviving bindings using the current cell's sink. Scope
identity metadata may be shared across the session without retaining old sinks.

## 4. Observed Value

| Field | Meaning |
|-------|---------|
| `presence` | `unbound` or `value`; null is a value, never an absence sentinel |
| `valueKind` | Scalar, list, dictionary, callable, or inspected foreign value |
| `referenceId` | Optional stable identity for containers and callables |
| `display` | Detached safe display data/text captured at the event boundary |

Display conversion reuses safe value-description behavior. Functions are shown
as callable names/signatures, not bodies, source text, closure maps, or internal
properties. Cycles use a readable reference marker. Non-finite numbers and
other non-JSON data remain inspectable.

Snapshot copying must not call getters, `toJSON`, custom inspection functions,
or user code. Interpreter-owned ordinary data can use the existing safe
description helper; foreign/accessor data needs descriptor-safe copying or
non-invoking inspection. This observation policy is separate from the existing
public logger's explicit arbitrary-value formatting contract.

Identity and mutation comparisons use runtime values only inside the observer.
Do not compare serialized display snapshots: equal-looking objects can have
different identities, and cyclic structures cannot be compared that way.

## 5. State Change

| Field | Meaning |
|-------|---------|
| `operation` | Binding initialization, rebinding, or logical container mutation |
| `bindings` | Nonempty list of affected binding deltas |
| Binding delta | Binding reference, previous observed value, new observed value |
| `targetReferenceId` | Optional identity of the mutated container |
| `path` | Optional member/index description, never an executed statement |

One underlying container operation produces one event, with multiple binding
deltas when aliases or enclosing containers observe the change. Two variable
initializations are two binding commits, even if they receive the same object.

**State transitions**:

| Before | Operation | After | Emission |
|--------|-----------|-------|----------|
| Unbound | Successful user binding | Value | Initialization |
| Value | Same scalar/reference assignment | Same value | None |
| Value | Different scalar or reference assignment | New value | Rebinding |
| Container | Logical mutation changes ordered members/elements | Changed container | One mutation with affected aliases |
| Container | Mutation leaves state unchanged | Same container state | None |
| Any | Target write fails before commit | Target unchanged | None for target |
| Any | Separate nested changes commit before a later failure | Changed bindings | Preserve those earlier events |
| Baseline state | Store/runtime setup or reconstruction | Baseline state | Track without emission |
| Scoped binding | Scope exits | No longer active | No synthetic deletion |

Scalar comparison uses `Object.is`; container/callable rebinding uses identity.
In-place comparison checks the target's ordered keys/elements and immediate
values/references before and after the synchronous operation. A different
equal-content collection remains a rebind. Internal algorithm steps within a
method are not separate user operations.

## 6. View State

| Field | Meaning |
|-------|---------|
| `collapsedByPayload` | Payload-ID keyed expansion state; new containers start collapsed |
| `selectedPayloadId` | Optional selected payload; stable on arrival/resize |
| `scrollPosition` | Viewport location, independent of event identity |
| `followingTail` | Whether new events should keep the viewport at the end |
| `width`, `height` | Current terminal layout, not a key for folding state |

Toggle changes only one fold entry. Reflow changes presentation, not IDs,
content, or event order. Navigating away from the tail stops forced scrolling.
There is no persisted fold state or after-exit interactive viewer.

## 7. Presentation Session

| State | Entry | Exit |
|-------|-------|------|
| Plain | Non-TTY, silent/excluded command, or explicit string sink | Flush existing plain output |
| Starting | Eligible CLI launches child and sends initialization | Ready within 1,000 ms or diagnosed fallback |
| Interactive | Child ready; canonical history retained in parent | Finish, error, or cancellation |
| Falling back | Renderer fault or protocol failure | Restore terminal, report cause, replay history once, then plain |
| Finishing | Workflow/backend finished; send final sequence | Restore terminal, retain transcript, write original result |
| Closed | All owned resources cleaned | No more UI work |

Closing is idempotent. Cleanup affects only the owned child, listeners, timers,
IPC channel, and terminal modes established by this session. Workflow outcome
and persistent state do not depend on presentation success.

The [IPC contract](contracts/renderer-ipc.md) defines process messages. The
[CLI contract](contracts/cli-logging.md) defines observable output and controls.
