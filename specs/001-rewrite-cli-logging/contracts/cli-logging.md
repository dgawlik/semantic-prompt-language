# Contract: CLI Logging and Embedded Sinks

## Runtime and unchanged command interface

- Supported SPL runtime becomes Node.js >=24.15.0 by user approval.
- Existing workflow syntax, options, stdout formats, and exit codes remain.
- No new flag is required to obtain interactive logs in an eligible terminal.
- `--silent`, `--log-level`, `NO_COLOR`, `FORCE_COLOR`, and `TERM` keep their
  documented meanings, except source traces are deliberately replaced by
  variable-state changes.
- This contract changes human-readable stderr formatting, not trace/recording,
  store, checkpoint, or replay matching formats.

## Output ownership

| Surface | Required behavior |
|---------|-------------------|
| Workflow stdout | Existing success/failure result only; no UI bytes |
| Checkpoint/resume stdout | Existing JSON envelopes only |
| stderr, interactive | Live BetterTUI view, followed by retained plain transcript after teardown |
| stderr, non-interactive | Append-only complete events; JSON expanded; no cursor controls |
| Trace/store/checkpoint files | Existing formats and semantics, no presentation events |
| Custom string sink | Non-interactive complete text; no process/input acquisition |

Auth/help/version stdout behavior is unchanged; these commands do not start a
renderer. Usage/syntax diagnostics remain visible even where silent execution
would suppress workflow logs.

Normal completion never waits for a keypress. The live view is transient.
After restoring terminal state, one complete plain transcript remains on
stderr; output values retain their original stdout representation.

## Event headers and types

One event has one compact header. Continuation lines never repeat that header.
No default timestamps, decorative surrounding panels, or blank filler rows.
Type icons are terminal-safe and always accompanied by text labels.

| Event | ASCII icon | Label | Default color when enabled |
|-------|------------|-------|----------------------------|
| Model input | `->` | input plus interaction kind | Magenta |
| Model output/action | `<-` | output plus interaction kind/role | Cyan |
| Error | `x` | error | Red |
| Warning | `!` | warning | Yellow |
| Information | `i` | info | Blue |
| Debug | `.` | debug | Muted gray |
| Variable state | `~` | state plus binding/scope | Yellow |

ASCII icons are the baseline on all platforms, avoiding unreliable font
capability detection. A generic explicit embedding message has a generic
label; unknown messages are not dropped or mislabeled as errors.

Input/output direction applies to `ask`, `think`, `agent`, and blockquote
interactions. Failures do not fabricate output events. Runtime actions are
identified as model outputs and not logged twice at response/execution.

## Visibility

| Selected level | Error diagnostics | Info/warning/script info | Debug | Model transcripts/state |
|----------------|-------------------|--------------------------|-------|-------------------------|
| error | Yes | No | No | Yes |
| info | Yes | Yes | No | Yes |
| debug | Yes | Yes | Yes | Yes |
| silent | No execution logs | No | No | No |

Explicit script logs retain their requested error/info/debug filtering.
Automatic deterministic source traces, statement banners, reads, and pure
control-flow step logs appear at no level. Existing failure diagnostics may
still contain source location/context.

## Variable-state output

- Identify each affected variable and its defining scope, plus previous and
  new values. Use an explicit unbound marker for initialization.
- Distinguish shadowed names, loop iterations, and function invocations.
- Include parameters, handler/loop bindings, function declarations, closure
  updates, nested collection mutations, and model-assisted variable saves.
- Report each logical mutation once, listing all affected bindings/scopes.
- Do not emit no-op assignments/methods, initial runtime/store dumps, scope-exit
  deletions, or historical checkpoint reconstruction.
- Keep each committed intermediate change, including changes before failure.
- Preserve event-time values; later mutations cannot rewrite earlier logs.
- Callable display includes identity/name, never source/body/closure contents.

See [the data model](../data-model.md) for precise equality and snapshot rules.

## JSON and keyboard interaction

- Every JSON object/array payload starts collapsed in the live view.
- A collapsed payload has one summary line showing object/array and folded
  state. Text outside the payload stays visible and ordered.
- Expanded JSON has two-space indentation. Serialized input retains numeric
  lexemes, duplicate keys, escapes, and content.
- Up/Down selects payloads; Enter or Space toggles the selected payload.
  Page Up/Down scrolls; Home/End reaches the first/last payload.
- One compact hint advertises navigation and toggling.
- Incoming events and terminal resizing do not change another payload's fold
  state or redirect the selection to a different event.
- Primitive values, malformed JSON, ordinary prose, and non-JSON inspection
  output are readable, not misleading fold controls.
- All content is reachable; there is no hidden truncation or silent history cap.

## Capability and color rules

Interactivity requires terminal stdin and stderr, a usable non-dumb terminal,
permission to read stdin for this invocation, and restorable terminal state.
The parent never reads keys; the renderer owns input only for the live view.
The parent captures OS input-mode restoration ownership before starting the child.
The child must confirm primary-screen state and cursor visibility before native rendering;
unsupported mode queries or an existing alternate screen produce diagnosed append-only output.
Checkpoint/resume, auth, check-only, silent, help/version, and embedded sinks
never acquire terminal input.

`NO_COLOR` overrides all color choices. Otherwise `FORCE_COLOR=0` disables color
and other set values enable it. Without overrides, stderr TTY capability and
`TERM != dumb` determine color. Force-color never grants interactivity.
Color-disabled live views still have labels, ASCII icons, selection markers,
and fold indicators. Non-interactive output never contains cursor controls,
even when color is explicitly forced.

## Failure and interruption

Renderer startup/native import errors, invalid IPC, or premature exits produce
an explicit stderr diagnostic, restore terminal state, and select complete
append-only output without changing the workflow result/exit code.

The retained transcript is emitted once, not once per resend or failure callback.
Ctrl+C follows CLI cancellation semantics, restoring state before termination;
it is not interpreted as successful workflow completion.

## Embedded compatibility

Keep `new Logger(level, stringSink, options)` valid. Default custom sinks remain
plain and non-interactive, with complete content and explicit color override.
Preserve the script-log prefix `[info|error|debug] log:` used by existing notebook
classification. New structured sink/event types are additive and readonly.

An explicitly supplied structured event sink receives each accepted event once
instead of automatic string delivery. It is not implicitly a terminal UI.
Filtering happens before formatting or invoking arbitrary payload serializers.
Generic `llm()` remains usable; typed model/state methods carry new metadata.
The deprecated explicit `deterministic()` helper is never called by runtime
execution and does not restore automatic source tracing.
