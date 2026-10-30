# Contract: Renderer Process IPC

**Status**: Internal implementation contract, version 1. This is not a public
trace, checkpoint, notebook, network, or persisted event protocol.

## Process boundary

The CLI parent forks its compiled renderer entry point with the same supported
Node executable and no inherited inspector/test `execArgv`. Child fd 0 inherits
stdin; child fd 1 and fd 2 inherit parent fd 2; an additional IPC channel carries
messages. The parent's stdout is never inherited as the child's render target.

Only the child imports `@bettertui/core`. Library imports, string sinks,
notebook workers, and excluded CLI commands must not load it.

## Common validation

Messages are discriminated plain data, validated at runtime from `unknown`.
Each includes `version: 1`, a nonempty `sessionId`, and a known `type`.
No message contains callable values, runtime object references, terminal
control instructions from message contents, or executable source.

An unknown version/type, wrong session, or invalid field is a diagnosed
protocol failure, never a successful no-op. Use proper TypeScript unions and
guards, not unchecked broad casts.

## Parent to child

| Type | Fields | Meaning |
|------|--------|---------|
| `initialize` | Color policy, initial raw-input state, initial dimensions where known | Establish one session and probe restorable terminal modes |
| `activate` | No additional fields | Acknowledge parent ownership of the prepared cursor snapshot before native initialization |
| `event` | Immutable log event and sequence | Append the next canonical event |
| `finish` | `lastSequence`, reason: completed/failed/cancelled | Process pending events, stop input/rendering and restore terminal |

Initialize once, receive `prepared`, then activate once. Events start only after `ready`. Each event's sequence must
be the next expected sequence; every event/payload identity must remain stable.
`finish.lastSequence` describes the final event sent by the parent.

Empty histories use an explicit null final sequence. They do not invent a
message or require a user keypress.

## Child to parent

| Type | Fields | Meaning |
|------|--------|---------|
| `prepared` | `cursorVisible`: boolean; confirmed primary screen | Parent must retain this restoration snapshot before sending `activate` |
| `ready` | Confirmed terminal capability and restoration ownership | Native view may receive events |
| `accepted` | Highest contiguous accepted event sequence | Queue/accounting progress, not durable storage |
| `finished` | Final accepted sequence and restoration confirmation | Safe to retain transcript and print result |
| `cancel` | Reason: interrupt | Ask parent to cancel workflow; child does not choose result status |
| `fatal` | Error stage and sanitized diagnostic | Startup, rendering, protocol, or restoration failure |

A native crash may yield only a child `exit` event; the parent handles that as
a failure without waiting indefinitely for a `fatal` message.

The child queries DEC modes 25 and 1049 with a 250 ms deadline, restoring its probe
listeners/raw-mode flag before continuing. Unsupported mode reporting and an already-active
alternate screen are diagnosed startup failures, without native initialization or clearing
the caller's screen. The parent owns the OS input-mode snapshot before forking and restores
explicit cursor visibility/primary-screen state after reaping the child; unverified DEC
private-mode save/restore sequences are not used.

## Ordering, backpressure, and retention

1. Parent retains canonical accepted events before sending them.
2. IPC sends are ordered and their callbacks/errors are checked.
3. When IPC applies backpressure, queue without dropping events or rerunning
   workflow operations. Rendering may batch frames, but not state transitions.
4. Child acknowledges contiguous event acceptance; this is not permission for
   the parent to discard history.
5. On normal finish, child acknowledges the final sequence only after cleanup.
   The parent then writes one complete expanded transcript to stderr.
6. On failure, stop/reap the child, restore terminal state, diagnose the cause,
   replay retained events once, and send subsequent events directly to the
   append-only formatter. Do not start a restart loop.

Both native UI output and the retained transcript use parent stderr. Actual
workflow stdout is written only through the unchanged result path.

## Timeouts and cleanup

- Ready deadline: 1,000 ms after initialization.
- Graceful finish deadline: 1,000 ms after sending finish.
- If a deadline expires, terminate only the owned child, restore terminal
  state, emit a diagnostic, and use the plain path.
- Teardown is idempotent across IPC errors, process errors/exits, finish,
  cancellation, top-level exceptions, and disconnect.
- Clear only owned listeners and timers; do not remove unrelated application
  listeners or kill processes by name.
- The child stops and restores on parent disconnect. The parent has an
  independent emergency restoration path for a native child crash.
- Preserve the initial raw-mode and cursor/screen state. If restoration cannot
  safely be established, do not acquire the live view; select diagnosed plain
  output instead.

The renderer must not use a toolkit default Ctrl+C process exit to bypass
parent cleanup. Parent workflow interruption and renderer presentation failure
are separate outcomes.

## Test obligations

- Verify actual descriptor routing with terminal stderr while stdout is piped.
- Prove excluded commands spawn zero renderer processes and register zero
  input listeners.
- Cover malformed/wrong-version IPC, sequence gaps, startup failure, native
  load failure, backpressure, missing finish acknowledgment, crash, and parent
  disconnect.
- Assert no history loss or duplicate retained transcript.
- Use renderer test facilities for frames, keys, resize, and folding; real
  PTY/ConPTY acceptance is still required for descriptor and terminal behavior.
