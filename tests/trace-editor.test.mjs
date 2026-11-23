import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  TraceDocument,
  JsonTextBuffer,
  parseTraceJsonl,
  serializeTraceJsonl,
  expandEmbeddedJson,
  formatEntryPrettyJson,
  formatEntryAsJs,
  formatEntryAsSpl,
  formatCodeSnippet,
  highlightJsonLine,
  highlightJsLine,
  highlightSplLine,
  extractEmbeddedCodeBlocks,
  renderEntryInspectorLines,
  wrapAnsiLine,
  visibleLength,
  decodeKeyInput,
  stripAnsi,
  createTemplateForKind,
  runTraceEditor,
} from "../dist/trace-editor.js";

const SAMPLE_JSONL = [
  '{"kind":"meta","version":1,"provider":"openai_responses","model":"gpt-6-luna","turns":2,"total_input_tokens":163,"total_output_tokens":32,"total_duration_ms":3871,"finish_reason":"completed","warnings":[]}',
  '{"kind":"user_prompt","content":"Use the multiply tool to compute 17 * 23."}',
  '{"kind":"tool_call","turn":1,"id":"call_1","name":"multiply","arguments":{"a":17,"b":23}}',
  '{"kind":"tool_result","turn":1,"id":"call_1","name":"multiply","output":"{\\"product\\":391}","succeeded":true}',
  '{"kind":"turn_completed","turn":1,"input_tokens":68,"output_tokens":18,"total_tokens":86,"duration_ms":1295,"finish_reason":"tool_calls"}',
  '{"kind":"assistant_text","turn":2,"text":"The product is 391."}',
  '{"kind":"turn_completed","turn":2,"input_tokens":95,"output_tokens":14,"total_tokens":109,"duration_ms":2576,"finish_reason":"completed"}',
].join("\n") + "\n";

test("TraceDocument: parse, edit, insert, delete, reorder, undo/redo, recalculate meta, and save JSONL", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "spl-trace-ed-"));
  const file = path.join(tmpDir, "traces.jsonl");
  fs.writeFileSync(file, SAMPLE_JSONL, "utf8");

  try {
    const doc = TraceDocument.loadFromFile(file);
    assert.equal(doc.entries.length, 7);
    assert.equal(doc.dirty, false);

    // Invalid JSON edit is rejected without mutating entry
    const bad = doc.updateEntryJson(1, "{ broken json");
    assert.equal(bad.ok, false);
    assert.equal(doc.dirty, false);

    // Valid JSON edit updates entry and marks dirty
    const ok = doc.updateEntryJson(1, JSON.stringify({ kind: "user_prompt", content: "Updated prompt!" }, null, 2));
    assert.equal(ok.ok, true);
    assert.equal(doc.dirty, true);
    assert.equal(doc.entries[1].data.content, "Updated prompt!");

    // Undo & redo
    const uIdx = doc.undo(1);
    assert.equal(uIdx, 1);
    assert.equal(doc.entries[1].data.content, "Use the multiply tool to compute 17 * 23.");
    const rIdx = doc.redo(1);
    assert.equal(rIdx, 1);
    assert.equal(doc.entries[1].data.content, "Updated prompt!");

    // Insert, duplicate, move, delete
    const inserted = doc.insertEntryAfter(1, createTemplateForKind("warning", 1));
    assert.equal(inserted, 2);
    assert.equal(doc.entries.length, 8);
    const moved = doc.moveEntry(2, 1);
    assert.equal(moved, 3);
    assert.equal(doc.entries[3].data.kind, "warning");
    doc.updateEntryJson(3, JSON.stringify({ kind: "warning", turn: 1, message: "check-warn" }));

    // Recalculate meta aggregates turns, tokens, duration, and warnings
    doc.recalculateMeta(0);
    assert.equal(doc.entries[0].data.turns, 2);
    assert.equal(doc.entries[0].data.total_input_tokens, 163);
    assert.equal(doc.entries[0].data.total_output_tokens, 32);
    assert.deepEqual(doc.entries[0].data.warnings, ["check-warn"]);

    // Save to disk and verify valid compact JSONL round-trip
    const outFile = path.join(tmpDir, "edited.jsonl");
    doc.save(outFile);
    assert.equal(doc.dirty, false);
    const reloaded = parseTraceJsonl(fs.readFileSync(outFile, "utf8"));
    assert.equal(reloaded.length, 8);
    assert.equal(reloaded[1].data.content, "Updated prompt!");
    assert.equal(reloaded[3].data.message, "check-warn");

    // Malformed lines are preserved with parseError so user can fix them
    const withBroken = parseTraceJsonl('{"kind":"user_prompt","content":"ok"}\n{not valid json\n');
    assert.equal(withBroken.length, 2);
    assert.ok(withBroken[1].parseError);
    assert.match(serializeTraceJsonl(withBroken), /\{not valid json/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("JsonTextBuffer: multi-line editing, auto-indent, format, validation, and ANSI key decoding", () => {
  const buf = new JsonTextBuffer('{"a": 1}');
  assert.equal(buf.validateJson().ok, true);

  // Format single-line JSON into multi-line pretty JSON
  assert.equal(buf.formatJson().ok, true);
  assert.equal(buf.getText(), '{\n  "a": 1\n}');

  // Auto-indent after `{` on Enter
  const buf2 = new JsonTextBuffer("{");
  buf2.moveEnd();
  buf2.insertNewline();
  assert.equal(buf2.row, 1);
  assert.equal(buf2.col, 2);
  buf2.insertText('"x": 42');
  buf2.insertNewline();
  buf2.backspace();
  buf2.backspace();
  buf2.insertText("}");
  assert.equal(buf2.validateJson().ok, true);
  assert.deepEqual(buf2.validateJson().value, { x: 42 });

  // Key decoder handles arrows, Ctrl+S, Ctrl+F, Shift+Up, F2, Esc
  const evs = decodeKeyInput("\x1b[A\x1b[1;2B\x13\x06\x1bOQ\x1b");
  assert.deepEqual(
    evs.map((e) => ({ name: e.name, ctrl: Boolean(e.ctrl), shift: Boolean(e.shift) })),
    [
      { name: "up", ctrl: false, shift: false },
      { name: "down", ctrl: false, shift: true },
      { name: "s", ctrl: true, shift: false },
      { name: "f", ctrl: true, shift: false },
      { name: "f2", ctrl: false, shift: false },
      { name: "escape", ctrl: false, shift: false },
    ]
  );
});

test("Trace pretty printing: JSON, JS, SPL syntax highlighting and embedded JS/SPL code detection", () => {
  const entries = parseTraceJsonl(SAMPLE_JSONL);
  const toolCall = entries[2];
  const toolResult = entries[3];

  // Embedded JSON expansion in tool_result.output
  const expanded = expandEmbeddedJson(toolResult.data);
  assert.deepEqual(expanded.output, { product: 391 });
  assert.match(formatEntryPrettyJson(toolResult, true), /"product": 391/);

  // JSON syntax highlighting preserves exact visible text
  const jsonLine = '  "name": "multiply",';
  const hlJson = highlightJsonLine(jsonLine);
  assert.equal(stripAnsi(hlJson), jsonLine);
  assert.ok(hlJson.includes("\x1b["), "Expected ANSI color codes in JSON highlighting");

  // JS pretty printing & syntax highlighting
  const jsFormatted = formatEntryAsJs(toolCall, true);
  assert.match(jsFormatted, /export const step_tool_call = \{/);
  assert.match(jsFormatted, /name: "multiply"/);
  const hlJs = highlightJsLine('export const f = (x) => { return x + 1; };');
  assert.equal(stripAnsi(hlJs), 'export const f = (x) => { return x + 1; };');
  assert.ok(hlJs.includes("\x1b["));

  // SPL pretty printing & syntax highlighting
  const splFormatted = formatEntryAsSpl(toolCall, true);
  assert.match(splFormatted, /ToolCallStep\(/);
  assert.match(splFormatted, /"multiply"/);
  assert.match(splFormatted, /a: 17/);
  const hlSpl = highlightSplLine("pub reified fn run<T>(x: Str) -> Result<T, Str> { Ok(x) } '' hint");
  assert.equal(stripAnsi(hlSpl), "pub reified fn run<T>(x: Str) -> Result<T, Str> { Ok(x) } '' hint");
  assert.ok(hlSpl.includes("\x1b["));

  // Formatting single-line JS & SPL snippets
  const prettyJsSnippet = formatCodeSnippet("const s = input.a + input.b; if (s > 0) { return s; }", "js");
  assert.ok(prettyJsSnippet.includes("\n  return s;\n"));
  const prettySplSnippet = formatCodeSnippet("pub fn run(p) { { sum: p.a + p.b } }", "spl");
  assert.ok(prettySplSnippet.includes("\n  {"));

  // Extracting embedded JS & SPL code blocks from trace records
  const codeEntry = parseTraceJsonl(
    JSON.stringify({
      kind: "assistant_text",
      turn: 1,
      text: "Here is JS and SPL:\n```js\nconst x = 1; return x + 2;\n```\n```splx\npub fn add(a: Int, b: Int) -> Int { a + b }\n```",
    })
  )[0];
  const blocks = extractEmbeddedCodeBlocks(codeEntry.data);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].lang, "js");
  assert.equal(blocks[1].lang, "spl");

  const renderedPretty = renderEntryInspectorLines(codeEntry, "pretty", true).map(stripAnsi).join("\n");
  assert.match(renderedPretty, /JS Preview/);
  assert.match(renderedPretty, /SPL Preview/);
});

test("CLI `spl trace --view` pretty-prints trace.jsonl in pretty, json, js, and spl formats", () => {
  const cli = path.resolve("dist/cli.js");
  const sampleFile = path.resolve("trace.jsonl");

  const outPretty = stripAnsi(execFileSync(process.execPath, [cli, "trace", sampleFile, "--view"], { encoding: "utf8" }));
  assert.match(outPretty, /SPL Trace/);
  assert.match(outPretty, /\[META\]/);
  assert.match(outPretty, /\[CALL\]/);
  assert.match(outPretty, /"product": 391/);

  const outJs = stripAnsi(
    execFileSync(process.execPath, [cli, "trace", sampleFile, "--view", "--format", "js"], { encoding: "utf8" })
  );
  assert.match(outJs, /export const traceMeta = \{/);
  assert.match(outJs, /export const step_tool_call = \{/);

  const outSpl = stripAnsi(
    execFileSync(process.execPath, [cli, "trace", sampleFile, "--view", "--format", "spl"], { encoding: "utf8" })
  );
  assert.match(outSpl, /ToolCallStep\(/);
  assert.match(outSpl, /TurnCompleted\(/);
});

test("Trace soft wrapping: wraps long JSON/JS/SPL lines strictly within console width and preserves ANSI colors", () => {
  const longPrompt = parseTraceJsonl(
    JSON.stringify({
      kind: "user_prompt",
      content: "This is a very long prompt line that must wrap cleanly inside narrow terminal screens without overflowing horizontally across the pane border.",
    })
  )[0];

  for (const fmt of ["pretty", "json", "js", "spl"]) {
    const wrappedLines = renderEntryInspectorLines(longPrompt, fmt, true, 40);
    assert.ok(wrappedLines.length > 4, `Expected ${fmt} view to wrap onto multiple lines at width 40`);
    for (const ln of wrappedLines) {
      assert.ok(
        visibleLength(ln) <= 40,
        `Line exceeded maxWidth 40 in ${fmt} view (${visibleLength(ln)}): ${stripAnsi(ln)}`
      );
    }
  }

  // ANSI color codes are carried across wrapped chunks
  const colored = highlightJsonLine('  "content": "abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz"');
  const chunks = wrapAnsiLine(colored, 24, false);
  assert.ok(chunks.length >= 3);
  for (const c of chunks) {
    assert.ok(visibleLength(c) <= 24);
    assert.ok(c.includes("\x1b["), "Expected active ANSI color preserved on each wrapped chunk");
  }
  assert.equal(chunks.map(stripAnsi).join(""), stripAnsi(colored));
});

test("Interactive TUI runTraceEditor: browse, switch views, edit JSON, save to disk, and exit cleanly", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "spl-trace-tui-"));
  const file = path.join(tmpDir, "traces.jsonl");
  fs.writeFileSync(file, SAMPLE_JSONL, "utf8");

  try {
    // Also verify extended key decoder sequences (Alt+Enter, F1-F4, CSI-u Ctrl+S, rxvt Home/End)
    const extKeys = decodeKeyInput("\x1b\r\x1bOP\x1bOR\x1bOS\x1b[115;5u\x1b[7~\x1b[8~");
    assert.deepEqual(
      extKeys.map((k) => ({ name: k.name, alt: Boolean(k.alt), ctrl: Boolean(k.ctrl) })),
      [
        { name: "enter", alt: true, ctrl: false },
        { name: "f1", alt: false, ctrl: false },
        { name: "f3", alt: false, ctrl: false },
        { name: "f4", alt: false, ctrl: false },
        { name: "s", alt: false, ctrl: true },
        { name: "home", alt: false, ctrl: false },
        { name: "end", alt: false, ctrl: false },
      ]
    );

    const mockIn = new EventEmitter();
    mockIn.isTTY = true;
    mockIn.isRaw = false;
    mockIn.setRawMode = (flag) => {
      mockIn.isRaw = flag;
    };
    mockIn.setEncoding = () => {};
    mockIn.resume = () => {};
    mockIn.pause = () => {};

    const writes = [];
    const mockOut = new EventEmitter();
    mockOut.isTTY = true;
    mockOut.columns = 80;
    mockOut.rows = 24;
    mockOut.write = (chunk) => {
      writes.push(String(chunk));
      return true;
    };

    const editorPromise = runTraceEditor(file, { stdin: mockIn, stdout: mockOut });

    // Initial render enters alt screen, disables wrap, draws dual panes
    assert.ok(writes.join("").includes("\x1b[?1049h"));
    assert.ok(writes.join("").includes("\x1b[?7l"));
    assert.ok(stripAnsi(writes.join("")).includes("SPL TRACE EDITOR"));

    // Navigate down to entry #1 (user_prompt), switch to JS ('3') and SPL ('4'), then back to Pretty ('1')
    mockIn.emit("data", "j");
    mockIn.emit("data", "3");
    assert.ok(stripAnsi(writes[writes.length - 1]).includes("export const step_user_prompt"));
    mockIn.emit("data", "4");
    assert.ok(stripAnsi(writes[writes.length - 1]).includes("UserPrompt("));
    mockIn.emit("data", "1");

    // Enter Edit Mode ('e'), navigate to content line, edit value, format with Ctrl+L, apply+save with Ctrl+W
    mockIn.emit("data", "e");
    assert.ok(stripAnsi(writes[writes.length - 1]).includes("EDIT #1"));

    // Move down to line 2 (`  "content": "Use the multiply tool to compute 17 * 23."`), go to End, backspace `"`, append text + `"`
    mockIn.emit("data", "\x1b[B\x1b[B\x1b[F"); // down, down, End
    mockIn.emit("data", "\x7f"); // backspace closing quote
    mockIn.emit("data", ' [edited]"');
    mockIn.emit("data", "\x0c"); // Ctrl+L format JSON
    assert.ok(stripAnsi(writes[writes.length - 1]).includes("Formatted JSON."));

    mockIn.emit("data", "\x17"); // Ctrl+W apply & save to file
    assert.ok(stripAnsi(writes[writes.length - 1]).includes("Updated record #1 and saved"));

    // Verify file on disk was updated cleanly
    const saved = parseTraceJsonl(fs.readFileSync(file, "utf8"));
    assert.equal(saved[1].data.content, "Use the multiply tool to compute 17 * 23. [edited]");

    // Quit cleanly with 'q' and verify NOTHING is written after alt-screen exit
    const beforeQuitCount = writes.length;
    mockIn.emit("data", "q");
    await editorPromise;

    assert.equal(writes.length, beforeQuitCount + 1, "Expected only the cleanup sequence after pressing q (no trailing render)");
    assert.equal(writes[writes.length - 1], "\x1b[?7h\x1b[?25h\x1b[?1049l");
    assert.equal(mockIn.isRaw, false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
