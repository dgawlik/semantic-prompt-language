# Validation Guide: Minimal Interactive CLI Logging

These are repeatable implementation acceptance steps. Recorded results and
remaining platform gaps appear at the end of this guide.

## Prerequisites

- Node.js >=24.15.0 and npm.
- A supported BetterTUI native platform from [the plan](plan.md).
- Run commands from the repository root. PowerShell examples use Windows paths.
- Use a genuine terminal for interactive acceptance. Redirected test output
  does not prove PTY/ConPTY behavior.
- No Copilot credentials or live model requests are needed: tests should use
  existing fake backends and synthetic renderer events.

```powershell
node --version
npm --version
```

The language package pins BetterTUI core 0.1.1 and declares Node.js >=24.15.0.
Restore its checked-in dependency manifest/lockfile with:

```powershell
npm --prefix .\lang ci
```

Do not install an unpublished React adapter.

## 1. Build and focused regression tests

The following command builds the language package and runs all directly affected tests.

```powershell
npm --prefix .\lang test -- tests/logging.test.ts tests/state-observer.test.ts tests/cli-renderer.test.ts tests/cli.test.ts tests/session.test.ts tests/checkpoint.test.ts tests/tracing.test.ts
```

Expected:

- Existing TypeScript build succeeds under the new minimum runtime.
- Model directions, severity filtering, silent diagnostics, and unchanged
  stdout/exit contracts pass.
- Automatic deterministic statement source is absent at error/info/debug.
- Every scope/binding/mutation case below has explicit assertions.
- Test names are selected within these files for iteration; run the combined
  set as the final directly affected regression check.

Do not count passing old source-trace expectations as evidence for this feature.
Update those intentional behavior-change assertions while retaining unrelated
existing checks.

## 2. Offline CLI state-change smoke test

Save this small workflow as a temporary `state-log-demo.md`, outside tracked
example directories unless it is intentionally promoted to a test fixture:

````markdown
---
extension: semantic-prompt-language
version: 1
---

```spl
let count = 1
count = count
count += 1
let items = [1]
let alias = items
alias.append(2)
success count
```
````

```powershell
node .\lang\dist\cli.js .\state-log-demo.md 1> .\result.txt 2> .\logs.txt
Get-Content .\result.txt
Get-Content .\logs.txt
node .\lang\dist\cli.js .\state-log-demo.md --silent
```

Expected:

- Result is `2`, exit code 0; stdout contains no header, hint, or control sequence.
- Redirected logs contain five logical state events: count initialization,
  count increment, items initialization, alias initialization, and one shared
  mutation identifying both items and alias.
- `count = count` and `success count` create no automatic state/source event.
- Initial count is unbound -> 1; increment is 1 -> 2. The list mutation is
  [1] -> [1, 2], with historical snapshots unchanged.
- JSON is expanded with two-space indentation; no cursor controls occur.
- Silent mode prints the same result and no execution logs.

Use byte-level subprocess assertions for exact stdout/control-sequence checks;
visual `Get-Content` inspection alone is insufficient.

## 3. Scope and mutation coverage

The state observer tests must exercise:

| Case | Required observation |
|------|----------------------|
| Top-level/nested block | Correct owner scope for a changed binding |
| Same-name shadowing | Independent binding identities and before/after values |
| Repeated function/recursive calls | Distinct invocation scopes |
| Parameters, loop unpacking, handler variables | Initialization in their defining scopes |
| Closure after creating scope exits | Captured variable changes remain visible |
| Active caller aliases | Mutation identifies caller and callee bindings together |
| Member/index/nested writes | Actual committed mutation, not just reassignment |
| Every existing mutating list/dict method | One event for a real logical change |
| Empty clear/update, no-op sort/reverse | No event when state is unchanged |
| Same-content replacement container | Rebinding event despite equal displayed contents |
| Cyclic/shared graphs | Safe display, no recursion crash or closure/source dump |
| RHS/argument side effects | Earlier events precede outer commit and are not coalesced |
| Failure before target write | No fictional target update; earlier changes remain |
| Method that partly mutates before failure | Actual resulting change before diagnostic |
| Change then restore | Both transitions remain in history |
| Model-assisted save | Same state rules as ordinary assignment |
| Store/runtime/session baseline | No initial dump; new changes still observed |
| Later notebook/session cell | Current sink and retained bindings, no stale logger |
| Foreign/accessor values | Observation invokes no getter, custom inspector, or serializer |

Also compare results, side-effect counters, model/tool call counts, and stored
data with logging enabled versus silent. Logging must not alter evaluation.

## 4. JSON fidelity and interactive acceptance

Use `@bettertui/core`'s published test renderer and mock keyboard facilities in
the renderer tests. Seed both model directions and all diagnostic/state types.
Include a test-only paced event producer for real-terminal interaction; do not
keep production commands alive merely for inspection.

Required checks:

1. Each event has one header, a distinct ASCII icon and label, and no panel.
2. Model input is magenta and output cyan when color is enabled.
3. Each object/array starts as exactly one summary line.
4. Up/Down selects; Enter/Space toggles; Page Up/Down scrolls; Home/End reaches
   ends; the visible hint explains those actions.
5. Toggle one payload while another stays expanded, append events, and resize
   to narrow/wide dimensions. Payload/selection identities remain unchanged.
6. Inspect text surrounding multiple JSON blocks, malformed JSON, primitives,
   empty containers, large integers, `-0`, exponent spellings, duplicate keys,
   escaped strings, and non-JSON/circular values.
7. Inject CSI/OSC/control content in messages, labels, and values; it must not
   become terminal instructions. Preserve ordinary newlines.
8. End normally without a keypress. Restore terminal state, retain one complete
   expanded transcript on stderr, then print the unchanged stdout result.

For SC-003, generate a JSON payload of 100 KiB and measure toggle request to
updated captured frame using a monotonic clock: the update must complete within
100 ms. For SC-004, feed 1,000 mixed events and assert exact IDs/order/content
and persistent fold states after additional events and resizes. A screenshot
alone does not verify either threshold.

## 5. Streams, capabilities, color, and lifecycle matrix

| Invocation/fault | Expected behavior |
|------------------|-------------------|
| stdin/stderr TTY; stdout piped | Native UI only on stderr; clean result stream |
| stdin piped or stderr redirected | No renderer/input reads; complete expanded logs |
| `TERM=dumb` | Append-only logs without automatic color |
| `NO_COLOR` with forced color also set | No color; direction/type still clear |
| `FORCE_COLOR=0` | No color |
| `FORCE_COLOR=1` with stderr redirected | Color may occur; cursor controls/interactivity may not |
| `--silent` | No renderer, history UI, execution logs, or input listeners |
| `--help`, `--version`, auth, `--check` | Existing output; no renderer |
| Native import/startup failure | Explicit cause, plain fallback, unchanged workflow outcome |
| Invalid IPC, send failure, crash, stuck finish | Owned-child cleanup, one retained transcript, no dropped events |
| Ctrl+C, parent disconnect, top-level exception | Terminal restoration, no orphan renderer |

Run real-terminal smoke checks on Windows Terminal/ConPTY and a Unix PTY,
including stdout piping. Assert raw-input and cursor/screen restoration on
normal exit, script failure, Ctrl+C, and renderer crash. If the environment
cannot establish restorable terminal state, it must explicitly choose plain
output rather than claim successful interactive coverage.

Readiness and finish acknowledgment deadlines are each 1,000 ms. Use controlled
fake-child behavior for timeout tests rather than waiting on a real hung process.

### Opt-in native terminal harness

The renderer test file includes a paced, test-only ConPTY/xterm harness. It uses
the editor's existing Electron-compatible `node-pty` and `@xterm/headless` modules;
no terminal test dependencies are added to the application. xterm answers mode
queries and provides parsed screen/cursor snapshots, rather than treating accumulated
escape-sequence output as a rendered frame.

Run on Windows with paths to your editor installation:

```powershell
$env:SPL_PTY_HOST = 'C:\path\to\Code.exe'
$env:SPL_PTY_MODULES = 'C:\path\to\resources\app\node_modules.asar'
# Optional: exercise an isolated installed Windows artifact instead of checkout dist.
$env:SPL_WINDOWS_PTY_DIST = 'file:///C:/isolated/node_modules/spl-lang/dist/'
# Optional pair: also exercise a supported Node/runtime artifact in Ubuntu WSL.
$env:SPL_UNIX_PTY_NODE = '/path/to/node-24.15-or-newer'
$env:SPL_UNIX_PTY_DIST = '/path/to/installed/node_modules/spl-lang/dist'
npm --prefix .\lang test -- tests/cli-renderer.test.ts -t 'real terminal state'
```

Without `SPL_PTY_HOST`, only this hardware-dependent test is skipped. With only
the host/modules configured, the Windows matrix runs. The optional WSL pair adds
real Unix PTYs; no tmux session, live model calls or physical keyboard automation
is used. Ctrl+C is delivered as input byte `0x03` through the terminal, not as a
mock cancellation callback or direct process signal. The harness asserts result bytes,
exit codes 0/1/130, expanded retained events, visible folds/hints, Enter/Space toggles,
prior cursor/screen contents and input-mode restoration. It removes its temporary files.

SPL itself probes terminal modes before native initialization. Unanswered or
unsupported queries, and an already-active alternate screen, select diagnosed
append-only output without clearing that screen.

## 6. Checkpoint, trace, and notebook compatibility

- A checkpoint/resume invocation never reads stdin or starts the renderer.
- Historical binding reconstruction emits no state events.
- The binding completed by the last answered `human()` is logged once after
  reconstruction; a cached statement-entry replay flag must not suppress it.
- Existing journals retain their format and validation. A pre-upgrade runtime
  fingerprint mismatch remains an error; do not bypass it for this feature.
- Trace replay preserves request matching and normal execution logging.
- Explicit notebook `log()` output remains classified as output; state events
  and transcripts remain logs. No native renderer enters the notebook bundle.

For the directly affected notebook surface:

```powershell
npm --prefix .\vscode run typecheck
npm --prefix .\vscode run build -- --test
node --test .\vscode\out\test\notebook.test.cjs .\vscode\out\test\notebook-ui.test.cjs
```

Use the existing test process mocks and compare retained-state/cell-result
behavior. Do not change extension-host runtime requirements just because the
external SPL runtime minimum changed.

## 7. Packaging and documentation

```powershell
npm pack .\lang --dry-run --json
npm run docs:build
npm run docs:check
node .\lang\dist\cli.js --help
```

Verify the package includes the compiled renderer entry point and declarations.
Separately install the produced package into an isolated temporary test prefix
on supported platforms to prove native dependency resolution; remove only that
explicit test prefix when finished.

Check the engine floor and Node prerequisite wording in the language/root
READMEs, install docs, and notebook node-path hint. Check help/doc coverage for
source-trace removal, state logging, fold controls, final transcript behavior,
silent mode, and color rules.

Use [the CLI contract](contracts/cli-logging.md) and
[the IPC contract](contracts/renderer-ipc.md) as the acceptance reference.
Remove the named temporary workflow and redirected output files after testing.

## Implementation acceptance results (2026-10-30)

**Status: 53/53 tasks complete.** T045 now passes on real Windows ConPTY and
Ubuntu WSL Unix PTYs, with xterm terminal emulation and keyboard-input bytes.
Checklists were read-only
(16/16 requirements-quality checks passed). No implementation extension hooks
were registered.

### Automated and installed-package evidence

| Criterion | Evidence |
| --- | --- |
| SC-001: compact typed headers/directions | [Logging tests](../../lang/tests/logging.test.ts): all categories, one multiline header, both direction palettes, failed requests without fabricated responses; blockquote actions/responses in [observer tests](../../lang/tests/state-observer.test.ts). |
| SC-002: JSON fidelity and folds | [Logging tests](../../lang/tests/logging.test.ts) preserve duplicate keys, numeric/string tokens and ordered surrounding text; [native renderer tests](../../lang/tests/cli-renderer.test.ts) use BetterTUI's real test renderer/mock keys for folds and resize. |
| SC-003: 100 KiB toggle under 100 ms | Final Windows arm64 native test-renderer regression: **106,900 bytes**, **12.62 ms** from Enter to captured updated frame, with bounded row widgets. The assertion requires `<100 ms`. |
| SC-004: 1,000 retained events | Installed artifact and [renderer tests](../../lang/tests/cli-renderer.test.ts): exactly 1,000 mixed events with unchanged IDs/order/content, selected payload and fold state after append/narrow-wide resize. |
| SC-005: result/automation compatibility | **227/227 tests across the seven affected language files passed**, including TypeScript build, byte-level CLI results, exclusions/input acquisition instrumentation, severity/color precedence, journal/store/trace neutrality, deadline/fault/backpressure tests and the opt-in terminal matrix. |
| SC-006: cleanup | **20/20 real-terminal cases passed** across Windows arm64 ConPTY and Linux arm64 Unix PTYs: completion, failure, keyboard Ctrl+C and native crash with initially visible/hidden cursors; existing alternate-screen fallback and initially raw input. Cursor/screen contents and input mode match their initial states. |
| SC-007: inspect request/response | [Renderer tests](../../lang/tests/cli-renderer.test.ts) cover every advertised key. Actual Windows/Unix terminal screens contain folds and the hint; Enter expands a nested field while the other payload stays folded, and Space collapses it again. This is automated keyboard evidence, not a human usability study. |
| SC-008: committed state only | [Observer tests](../../lang/tests/state-observer.test.ts), [logging tests](../../lang/tests/logging.test.ts) and [CLI smoke](../../lang/tests/cli.test.ts): no source/reads/no-op/baseline dumps; smoke returns exact `2\n` with five state events and one shared-alias mutation. |
| SC-009: scope attribution | [Observer tests](../../lang/tests/state-observer.test.ts) and [session tests](../../lang/tests/session.test.ts): shadowing, enclosing owners, iteration/recursive-call IDs, parameters, handlers, functions, captured scopes and current-cell sinks. |
| SC-010: mutation fidelity | [Observer tests](../../lang/tests/state-observer.test.ts): every shared-metadata mutator, nested/member/index writes, aliases/cycles, equal-content rebinds, detached historical values, partial failure and change-then-restore. |
| SC-011: semantic/replay neutrality | [Tracing tests](../../lang/tests/tracing.test.ts): enabled/silent results, evaluation/model/tool counts, stores and trace bytes agree. [Checkpoint tests](../../lang/tests/checkpoint.test.ts) suppress reconstruction while retaining the last answered `human()` assignment; no persisted fields/fingerprint checks changed. Getter/serializer/inspector/proxy observation counters stay zero. |

Notebook validation passed: TypeScript typecheck, test bundle build and **26/26**
focused notebook tests. The worker bundle contains no BetterTUI import, renderer
entry point or raw-input acquisition. Its classification remains compatible;
the brief-log UI filter was extended for new diagnostic headers without changing
worker result/output behavior.

Documentation generation/check passed: **8 pages and 56 searchable sections**.
The CLI help covers state/no-op semantics, icons/colors, folding/navigation,
expanded retained output and color precedence.

Packaging used `npm pack .\lang --dry-run --json`, then packed/installed the
tarball into an isolated temporary prefix. This npm version ignores `--prefix`
for `pack`, so the originally planned command attempted the unnamed root package;
the explicit folder command correctly produced **58 package files**, including
`dist/cli-renderer.js` and `dist/cli-renderer.d.ts`. The installed
`@bettertui/core-win32-arm64` 0.1.1 native module resolved, initialized and destroyed
successfully under Node.js **24.18.0**. Other native architectures were not installed
or executed here during that initial Windows-only check. Final polish additionally
installed and ran the updated artifact with `@bettertui/core-linux-arm64-gnu` 0.1.1
under Linux Node.js **24.18.0**, and reran Windows acceptance from an isolated
installed artifact.

Two tightly coupled reliability adjustments were validated:

- Allocate visible event sequences after successful formatting, including reentrant
  explicit serializers; failed formatting cannot introduce an IPC sequence gap.
- Yield to the event loop every 1,024 executed statements so long deterministic
  loops cannot starve renderer IPC/cancellation. The pre-change subprocess timed
  out; the bounded responsiveness regression now passes without changing evaluation counts.

### Real-terminal acceptance and polish fixes

A bounded, synthetic, test-only harness ran the **installed artifact** in a VS Code
integrated Windows terminal (Windows arm64, terminal stdin/stderr). It verified:

1. Normal CLI completion with stdout piped: exact result `2\n`, stderr UI only.
2. Script failure: original failure JSON/exit 1, no UI bytes in stdout, no keypress wait.
3. Real native `ready`/`finished` lifecycle, restored parent raw-mode flag and one
   complete expanded retained transcript.
4. Killing only the owned native child: explicit diagnosed fallback, restored parent
   raw-mode flag and exactly one retained transcript.

The separate real-child descriptor test also asserts exact fd 1/fd 2 routing to
stderr without patching workflow stdout.

The remaining checks were completed with the opt-in harness described above.
Ubuntu WSL became available; its earlier VM-start timeout was not counted as
Unix evidence. The final matrix used Windows arm64 ConPTY plus xterm and Linux
arm64 Ubuntu Unix PTYs transported through WSL, not redirected pipe-only tests.
There are ten cases per platform:

- Completion, synthetic script failure, keyboard Ctrl+C and owned native-child
  crash, each with an initially visible and initially hidden cursor.
- Initially active alternate screen: explicit plain fallback preserves the
  existing screen contents and mode.
- Initially raw input: normal completion restores that initial mode.

Every case retains exactly one complete expanded request/response transcript,
keeps stdout free of UI bytes and verifies the expected 0/1/130 exit code.
Actual parsed terminal screens verify initially folded containers, the keyboard
hint, independent Enter/Space folding, original cursor visibility and screen
contents. Linux input comparison uses `stty -g`, not just Node's raw-mode flag.

These stronger checks exposed and fixed three tightly coupled defects:

1. Unverified DEC private-mode save/restore did not preserve an initially hidden
   ConPTY cursor. Explicit queried cursor state now transfers to the parent
   through `prepared`/`activate` before native code can run.
2. The original multiline Text widget displayed only the first line in a live
   terminal even though accumulated-output tests contained the expected text.
   Bounded single-line widgets now show payloads and hints in real parsed frames.
3. Killing the native child could strand Unix input in raw mode because the
   parent's unchanged cached raw-mode flag was not an OS restoration snapshot.
   The parent now owns that snapshot before forking and restores it after reaping.

Final validation also passed notebook typecheck/test build and **26/26** notebook
tests, docs generation/check (**8 pages, 56 sections**), and installed native
artifacts on both tested arm64 platforms. Other architectures, macOS and a human
usability study remain untested; no broader hardware claim is made.

Temporary package/archive/prefixes, standalone probe harnesses/reports and test
workflows were removed after validation. The repeatable opt-in harness remains
in the renderer test file; all 53 task markers are checked.
