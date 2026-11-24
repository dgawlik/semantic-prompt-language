---
title: CLI & LSP / VS Code
description: Command-line subcommands and IDE Language Server capabilities for SPL (.splx).
---

## CLI Reference

Run the SPL CLI via `node dist/cli.js <command>` or `npm run spl -- <command>`:

| Command | Description |
|---|---|
| `spl check <file.splx>` | Parse and type-check `<file.splx>` and all transitive imports |
| `spl build <file.splx> [-o dir]` | Compile `<file.splx>` and its imports into standalone `.mjs` ES Modules (default `./dist-spl`) |
| `spl run <file.splx>` | Compile to a temporary directory and execute immediately |
| `spl debug <file.splx>` | Step interactively through every LLM request and response with pretty-printed results (reusing `spl trace` views, live JSON edit, mock injection, and `.jsonl` export; supports `--after-only`, `--no-pause`, `--format pretty\|json\|js\|spl`, `--save <path>`) |
| `spl login [provider] [token]` | Save `openai`, `google`, and `anthropic` API tokens in `~/.spl/credentials.json` (also supports `--from-env`, `--status`, `--clear`) |
| `spl trace [file.jsonl]` | Launch the zero-dependency interactive trace viewer & JSON editor with pretty JSON / JS / SPL syntax highlighting (`--view --format pretty\|json\|js\|spl` for non-interactive output) |
| `spl schema <file.splx> <Type>` | Print the compile-time JSON Schema for exported type `<Type>` |
| `spl lsp` | Start the JSON-RPC 2.0 Language Server over stdio |

## Interactive Trace Viewer & Editor (`spl trace`)

`spl trace [file.jsonl]` opens a zero-dependency full-screen terminal UI for inspecting, pretty-printing, and editing JSONL execution traces produced by `traces.save_jsonl(...)` or `spl debug --save <file.jsonl>`. If no file is specified, it defaults to `traces.jsonl` (or `trace.jsonl`).

```bash
# Open interactive split-pane trace viewer & JSON editor
node dist/cli.js trace trace.jsonl

# Pretty-print a trace directly to stdout (non-interactive / piped)
node dist/cli.js trace trace.jsonl --view --format pretty

# Render trace records as syntax-highlighted JSON, JS, or SPL
node dist/cli.js trace trace.jsonl --view --format spl
```

### View Formats & Embedded Code Highlighting

Press `v` (or `1`–`4`) at any time to switch how the right-hand inspector renders the selected record:

- **`1: PRETTY`**: Syntax-highlighted JSON with automatic expansion of nested JSON strings (such as `tool_result.output` or structured LLM `text`) and dedicated **JS / SPL Preview** panels for embedded synthesized code blocks (e.g. `Prompt.llm_fn` output).
- **`2: JSON`**: Clean syntax-highlighted JSON (`p` toggles embedded JSON string expansion).
- **`3: JS`**: Pretty-printed JavaScript object representation with JS syntax highlighting.
- **`4: SPL`**: Pretty-printed SPL `let` binding representation with SPL syntax highlighting.

### Trace Editor Controls

| Mode | Keys | Action |
|---|---|---|
| **Browse** | `↑`/`↓`, `j`/`k`, `PgUp`/`PgDn`, `g`/`G`, `Tab` | Navigate the timeline list or scroll the inspector pane (`Tab` switches focus) |
| **Browse** | `v` / `1`–`4`, `p` | Switch inspector view (`Pretty` / `JSON` / `JS` / `SPL`), toggle embedded JSON/code expansion (`p`) |
| **Browse** | `e` / `Enter` | Open the selected record in the built-in multi-line JSON editor |
| **Browse** | `a` / `c` / `d` | Insert a new templated trace event (`a`), duplicate (`c`), or delete (`d`) the selected record |
| **Browse** | `K`/`J` (`Shift+↑`/`↓`) | Reorder records up/down in the timeline |
| **Browse** | `r` | Recalculate the `meta` header (turns, token totals, duration, warnings) from events |
| **Browse** | `/` / `Esc` | Filter timeline records by text (`Esc` clears filter) |
| **Browse** | `u` (`Ctrl+Z`) / `Ctrl+Y` | Undo / redo document edits |
| **Browse** | `s` (`Ctrl+S`) / `W` | Save JSONL file (`s`) or Save As (`W`), `?` help, `q` quit |
| **Edit JSON** | `F2` / `Ctrl+O` / `Ctrl+S` | Validate and apply edited JSON back to the trace (`Ctrl+W` applies + saves file) |
| **Edit JSON** | `Ctrl+L` / `F4`, `Ctrl+U`, `Esc` | Auto-format JSON (`Ctrl+L`), delete current line (`Ctrl+U`), or cancel (`Esc`) |

## Interactive LLM Step Debugger (`spl debug`)

`spl debug <file.splx>` compiles and runs your SPL program while intercepting every `std/llm` call (`Prompt.ask<T>`, `Prompt.agent<T>`, `Prompt.llm_fn<In, Out>`, `llm.ask_raw`, `llm.decide`) inside a split-pane terminal UI built on the `spl trace` inspector. API keys are automatically redacted (`[redacted]`) from the UI and saved traces.

```bash
# Pause before & after every LLM call
node dist/cli.js debug examples/agents/agent.splx

# Auto-send requests and only pause after each response
node dist/cli.js debug examples/agents/agent.splx --after-only

# Run non-interactively, pretty-print every call/result, and save a JSONL trace
node dist/cli.js debug examples/agents/agent.splx --no-pause --format pretty --save debug.jsonl
```

### Debugger Controls

| Keys / Input | Action |
|---|---|
| `n` / `Space` / `Enter` | Step forward (send paused request or advance after response) |
| `↑`/`↓`, `j`/`k`, `PgUp`/`PgDn`, `g`/`G` | Scroll the pretty-printed result in the Inspector (default focus), or navigate the Event List when focused |
| **Mouse Wheel** / **Click** | Scroll whichever pane the cursor is over; click to focus a pane or select a trace entry |
| `←`/`→`, `h`/`l`, `Tab` | Switch focus between Event List (`←`) and Inspector (`→`) |
| `Ctrl+D`/`Ctrl+U`, `]`/`[`, `Shift+↑`/`↓` | Always scroll the Inspector down/up regardless of which pane is focused |
| `v` / `1`–`4` | Switch inspector format: `1` **Pretty** (expanded JSON + highlighted embedded JS/SPL code), `2` **JSON**, `3` **JS**, `4` **SPL** |
| `p` | Toggle embedded JSON & code block pretty-printing |
| `e` | Edit the selected entry JSON in-place (live-modifies the active paused request or response before continuing) |
| `m` | Inject a mock LLM response when paused before a call (skips the network request) |
| `x` | Abort the currently paused LLM call with an error |
| `c` / `b` | Continue all remaining calls (`c`), or cycle breakpoints (`b`: `BEFORE+AFTER`, `AFTER-ONLY`, `BEFORE-ONLY`, `NONE`) |
| `/` / `s` / `W` | Filter trace entries (`/`), save `.jsonl` (`s` / `W`, openable in `spl trace`), `?` help, `q` quit |

When a result overflows the terminal height, the Inspector pane displays a right-edge scrollbar (`█`) and a live line-range indicator (`Ln 1-28/64`) in its header.

## Language Server (`spl lsp`) Features

The built-in zero-dependency Language Server powers VS Code (`npm run vscode:install`) with:

- **Live Diagnostics**: Real-time lex, parse, module, and Hindley-Milner type errors.
- **Error-Tolerant Member Completions**: Struct fields, row-polymorphic preserved fields, built-in methods (`Array`, `Str`, `Dict`, `Iter`, `Option`, `Result`, `Prompt`), stdlib namespaces, traits, and extension methods — even when lines below the cursor are incomplete.
- **Named-Argument Completions & Signature Help**: Typing `(` or `,` inside calls like `@{ ... }.ask<Person>(...)` or `llm.ask<Person>(...)` suggests remaining named parameters (`provider:`, `api_key:`, `model:`, `temperature:`, ...) sorted with required arguments first, and highlights the active parameter in Signature Help.
- **Rich Hover Documentation**: Type signatures and `///` / `''` docs on locals, builtins, primitive types, stdlib functions, and live JSON Schema previews when hovering over `type_schema<T>()`.
- **Go to Definition & Document Symbols**: Jump directly into local or stdlib `.splx` definitions and browse types, fields, enums, and functions in the Outline view.
