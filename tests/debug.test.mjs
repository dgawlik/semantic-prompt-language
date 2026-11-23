import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { EventEmitter } from "node:events";

const execFileAsync = promisify(execFile);
import {
  serializeLlmRequest,
  applyEditedLlmRequest,
  serializeLlmResponse,
  applyEditedLlmResponse,
  buildMockLlmResponse,
  runLlmDebugger,
} from "../dist/llm-debugger.js";
import { TraceDocument, stripAnsi } from "../dist/trace-editor.js";

function createMockTty(cols = 120, rows = 32) {
  const input = new EventEmitter();
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = (mode) => {
    input.isRaw = Boolean(mode);
  };
  input.setEncoding = () => {};
  input.resume = () => {};
  input.pause = () => {};

  const chunks = [];
  const output = new EventEmitter();
  output.isTTY = true;
  output.columns = cols;
  output.rows = rows;
  output.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };
  output.getPlainText = () => stripAnsi(chunks.join(""));
  output.getRawText = () => chunks.join("");
  output.clear = () => {
    chunks.length = 0;
  };

  return { input, output };
}

async function waitForOutput(output, predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const plain = output.getPlainText();
    if (predicate(plain)) return plain;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`Timed out waiting for debugger TUI output. Last buffer:\n${output.getPlainText().slice(-1000)}`);
}

async function startMockOpenAiServer(handler) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const bodyText = Buffer.concat(chunks).toString("utf8");
    let body = {};
    try {
      body = JSON.parse(bodyText);
    } catch {
      body = {};
    }
    requests.push({ url: req.url, method: req.method, body });
    const reply = handler(body, requests.length);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(reply));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const baseUrl = `http://127.0.0.1:${addr.port}/v1`;
  return {
    baseUrl,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test("llm-debugger serialization redacts api_key and round-trips live request/response edits", () => {
  const origReq = {
    provider: "openai_responses",
    model: "gpt-6-luna",
    api_key: "sk-super-secret-value",
    base_url: { $tag: "Some", _0: "https://api.example.com/v1" },
    system: { $tag: "Some", _0: "Be concise." },
    messages: [{ role: "user", content: "Hello" }],
    temperature: { $tag: "Some", _0: 0.2 },
    max_tokens: { $tag: "None" },
    stream: false,
  };

  const serialized = serializeLlmRequest(origReq, 1);
  assert.equal(serialized.kind, "llm_request");
  assert.equal(serialized.call, 1);
  assert.equal(serialized.api_key, "[redacted]");
  assert.equal(serialized.system, "Be concise.");
  assert.equal(serialized.temperature, 0.2);
  assert.ok(!("max_tokens" in serialized));

  // Applying an edited request preserves secret api_key and re-wraps SPL Options
  const editedReq = applyEditedLlmRequest(origReq, {
    ...serialized,
    model: "gpt-6-edited",
    system: "New system prompt",
    max_tokens: 256,
  });
  assert.equal(editedReq.api_key, "sk-super-secret-value");
  assert.equal(editedReq.model, "gpt-6-edited");
  assert.deepEqual(editedReq.system, { $tag: "Some", _0: "New system prompt" });
  assert.deepEqual(editedReq.max_tokens, { $tag: "Some", _0: 256 });

  // Response serialization + edit round-trip
  const origResult = {
    $tag: "Ok",
    _0: buildMockLlmResponse({
      text: '{"answer": 41}',
      thinking: "thinking step",
      finish_reason: "stop",
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    }),
  };
  const serResp = serializeLlmResponse(origReq, origResult, 123, 1);
  assert.equal(serResp.kind, "llm_response");
  assert.equal(serResp.text, '{"answer": 41}');
  assert.equal(serResp.thinking, "thinking step");
  assert.equal(serResp.duration_ms, 123);

  const editedResult = applyEditedLlmResponse(origResult, {
    ...serResp,
    text: '{"answer": 42}',
  });
  assert.equal(editedResult.$tag, "Ok");
  assert.equal(editedResult._0.text, '{"answer": 42}');
  assert.deepEqual(editedResult._0.thinking, { $tag: "Some", _0: "thinking step" });

  // Editing into an error converts to Err
  const errResult = applyEditedLlmResponse(origResult, {
    kind: "llm_error",
    error: "Injected failure",
  });
  assert.deepEqual(errResult, { $tag: "Err", _0: "Injected failure" });
});

test("interactive spl debug steps through LLM calls, switches views, mocks response, and saves trace", async () => {
  const srv = await startMockOpenAiServer((_body, count) => ({
    id: `resp_${count}`,
    status: "completed",
    output: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: JSON.stringify({ greeting: "Hello from mock server", step: count }) }],
      },
    ],
    usage: { input_tokens: 21, output_tokens: 9, total_tokens: 30 },
  }));

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "spl-debug-tui-"));
  const splFile = path.join(tmpDir, "demo.splx");
  const saveFile = path.join(tmpDir, "captured.debug.jsonl");

  fs.writeFileSync(
    splFile,
    [
      'import llm from "std/llm"',
      "",
      "type Greeting = struct {",
      "    greeting: Str",
      "    step: Int",
      "}",
      "",
      `let g1 = @{ First question }.ask<Greeting>(provider: "openai_responses", api_key: "sk-test-key", base_url: Some("${srv.baseUrl}"), model: "gpt-test")?`,
      'print("STEP1=${g1.greeting}:${g1.step}")',
      `let g2 = @{ Second question }.ask<Greeting>(provider: "openai_responses", api_key: "sk-test-key", base_url: Some("${srv.baseUrl}"), model: "gpt-test")?`,
      'print("STEP2=${g2.greeting}:${g2.step}")',
    ].join("\n"),
    "utf8"
  );

  try {
    const { input, output } = createMockTty(120, 48);
    const dbgPromise = runLlmDebugger(splFile, {
      savePath: saveFile,
      stdin: input,
      stdout: output,
    });

    // 1. Paused BEFORE call #1
    const frame1 = await waitForOutput(output, (txt) => txt.includes("PAUSED BEFORE #1"));
    assert.match(frame1, /REQ/);
    assert.match(frame1, /\[redacted\]/);
    assert.doesNotMatch(frame1, /sk-test-key/);
    assert.doesNotMatch(frame1, /\[Circular\]/);

    // 2. Step ('n') to send call #1 -> pauses AFTER response #1
    output.clear();
    input.emit("data", "n");
    const frame2 = await waitForOutput(output, (txt) => txt.includes("PAUSED AFTER #1"));
    assert.match(frame2, /RESP/);
    assert.match(frame2, /Hello from mock server/);
    assert.equal(srv.requests.length, 1);

    // 3. Switch pretty views: JS ('3') and SPL ('4') and back to PRETTY ('1')
    output.clear();
    input.emit("data", "3");
    const jsFrame = await waitForOutput(output, (txt) => txt.includes("Inspector view: JS"));
    assert.match(jsFrame, /\/\/ Trace record \(llm_response\)/);
    assert.match(jsFrame, /const \w+ =/);

    output.clear();
    input.emit("data", "4");
    const splFrame = await waitForOutput(output, (txt) => txt.includes("Inspector view: SPL"));
    assert.match(splFrame, /let \w+ =/);

    output.clear();
    input.emit("data", "1");
    await waitForOutput(output, (txt) => txt.includes("Inspector view: PRETTY"));

    // 4. Step ('n') after response #1 -> program prints STEP1 and pauses BEFORE call #2
    output.clear();
    input.emit("data", "n");
    await waitForOutput(output, (txt) => txt.includes("PAUSED BEFORE #2"));

    // 5. Mock call #2 ('m') -> replace mock template with a custom Greeting JSON response!
    output.clear();
    input.emit("data", "m");
    await waitForOutput(output, (txt) => txt.includes("MOCK LLM RESPONSE"));

    // Kill all template lines with Ctrl+K and insert our custom mock JSON
    input.emit("data", "\x0b".repeat(15));
    input.emit("data", JSON.stringify({ text: JSON.stringify({ greeting: "Injected Mock", step: 99 }), finish_reason: "stop", tool_calls: [] }));
    // Apply mock with Ctrl+O
    output.clear();
    input.emit("data", "\x0f");
    const afterMockFrame = await waitForOutput(output, (txt) => txt.includes("PAUSED AFTER #2"));
    assert.match(afterMockFrame, /Injected Mock/);
    // Network server was NOT called a second time!
    assert.equal(srv.requests.length, 1);

    // 6. Step ('n') after mocked call #2 -> program completes and prints STEP2=Injected Mock:99
    output.clear();
    input.emit("data", "n");
    await waitForOutput(output, (txt) => txt.includes("Program completed"));

    // 7. Quit ('q') cleanly
    input.emit("data", "q");
    const result = await dbgPromise;
    assert.equal(result.error, undefined);
    assert.equal(result.llmCalls, 2);
    assert.equal(result.totalInputTokens, 21);
    assert.equal(result.totalOutputTokens, 9);

    // Verify stdout entries captured both STEP1 (real server) and STEP2 (debugger mock!)
    const stdoutTexts = result.doc.entries
      .filter((e) => e.data?.kind === "stdout")
      .map((e) => e.data.text);
    assert.ok(stdoutTexts.includes("STEP1=Hello from mock server:1"), `stdout was: ${JSON.stringify(stdoutTexts)}`);
    assert.ok(stdoutTexts.includes("STEP2=Injected Mock:99"), `stdout was: ${JSON.stringify(stdoutTexts)}`);

    // Verify auto-saved JSONL file reloads cleanly in TraceDocument
    assert.ok(fs.existsSync(saveFile));
    const reloaded = TraceDocument.loadFromFile(saveFile);
    assert.ok(reloaded.entries.some((e) => e.data?.kind === "llm_request"));
    assert.ok(reloaded.entries.some((e) => e.data?.kind === "llm_response" && e.data?.mocked === true));
    assert.ok(reloaded.entries.some((e) => e.data?.kind === "program_done"));
    assert.match(output.getRawText(), /\x1b\[\?1049l/);
  } finally {
    await srv.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("interactive spl debug abort ('x') injects an error into the SPL program", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "spl-debug-abort-"));
  const splFile = path.join(tmpDir, "abort.splx");

  fs.writeFileSync(
    splFile,
    [
      'import llm from "std/llm"',
      "",
      'let res = @{ Hello }.ask<Str>(provider: "openai_responses", api_key: "sk-test", model: "gpt-test")',
      "match res {",
      '    Ok(v) => print("OK:${v}")',
      '    Err(e) => print("CAUGHT:${e}")',
      "}",
    ].join("\n"),
    "utf8"
  );

  try {
    const { input, output } = createMockTty(120, 32);
    const dbgPromise = runLlmDebugger(splFile, {
      stdin: input,
      stdout: output,
    });

    await waitForOutput(output, (txt) => txt.includes("PAUSED BEFORE #1"));
    output.clear();
    input.emit("data", "x");
    const errFrame = await waitForOutput(output, (txt) => txt.includes("PAUSED AFTER #1"));
    assert.match(errFrame, /Aborted LLM call #1/);

    output.clear();
    input.emit("data", "n");
    await waitForOutput(output, (txt) => txt.includes("Program completed"));

    input.emit("data", "q");
    const res = await dbgPromise;
    assert.equal(res.error, undefined);
    const stdoutTexts = res.doc.entries
      .filter((e) => e.data?.kind === "stdout")
      .map((e) => e.data.text);
    assert.ok(stdoutTexts.some((t) => t.startsWith("CAUGHT:Aborted LLM call #1")));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("CLI `spl debug --no-pause --save` runs non-interactively with pretty-printed output", async () => {
  const srv = await startMockOpenAiServer(() => ({
    id: "resp_cli",
    status: "completed",
    output: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: JSON.stringify({ answer: 42, body: "function calc(x) { return x * 2; }" }) }],
      },
    ],
    usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20 },
  }));

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "spl-debug-cli-"));
  const splFile = path.join(tmpDir, "cli_demo.splx");
  const outJsonl = path.join(tmpDir, "out.jsonl");

  fs.writeFileSync(
    splFile,
    [
      'import llm from "std/llm"',
      "",
      "type Out = struct {",
      "    answer: Int",
      "    body: Str",
      "}",
      "",
      `let r = @{ Return 42 }.ask<Out>(provider: "openai_responses", api_key: "sk-cli-secret", base_url: Some("${srv.baseUrl}"), model: "gpt-cli")?`,
      'print("ANS=${r.answer}")',
    ].join("\n"),
    "utf8"
  );

  try {
    const { stdout: out } = await execFileAsync(
      process.execPath,
      [path.resolve("dist/cli.js"), "debug", splFile, "--no-pause", "--format", "pretty", "--save", outJsonl],
      { encoding: "utf8" }
    );
    const plain = stripAnsi(out);
    assert.match(plain, /\[REQ\]/);
    assert.match(plain, /\[RESP\]/);
    assert.match(plain, /\[STDOUT\]/);
    assert.match(plain, /ANS=42/);
    assert.match(plain, /\[DONE\]/);
    assert.doesNotMatch(plain, /\[Circular\]/);
    // Embedded JS code in `body` should be rendered by trace-editor's pretty embedded code block viewer!
    assert.match(plain, /JS Preview \(text\.body\)/);
    assert.match(plain, /return x \* 2;/);
    // Secret key must never appear in stdout or saved JSONL
    assert.doesNotMatch(plain, /sk-cli-secret/);

    assert.ok(fs.existsSync(outJsonl));
    const rawSaved = fs.readFileSync(outJsonl, "utf8");
    assert.doesNotMatch(rawSaved, /sk-cli-secret/);
    const reloaded = TraceDocument.loadFromFile(outJsonl);
    assert.ok(reloaded.entries.some((e) => e.data?.kind === "llm_response"));
    assert.ok(reloaded.entries.some((e) => e.data?.kind === "program_done"));
  } finally {
    await srv.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("interactive spl debug scrolls long results immediately with arrows, PgDn, mouse wheel, and shows scrollbar", async () => {
  const longLines = Array.from({ length: 40 }, (_, i) => `item_${i + 1}: value_${i + 1}`);
  const srv = await startMockOpenAiServer(() => ({
    id: "resp_scroll",
    status: "completed",
    output: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: JSON.stringify({ items: longLines, tail_marker: "BOTTOM_OF_RESULT_999" }) }],
      },
    ],
    usage: { input_tokens: 15, output_tokens: 45, total_tokens: 60 },
  }));

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "spl-debug-scroll-"));
  const splFile = path.join(tmpDir, "scroll_demo.splx");
  fs.writeFileSync(
    splFile,
    [
      'import llm from "std/llm"',
      `let res = @{ Return a big payload }.ask<Str>(provider: "openai_responses", api_key: "sk-scroll", base_url: Some("${srv.baseUrl}"), model: "gpt-scroll")?`,
      'print("OK")',
    ].join("\n"),
    "utf8"
  );

  try {
    // Small 20-row terminal so the 40-item response definitely overflows vertically
    const { input, output } = createMockTty(110, 20);
    const dbgPromise = runLlmDebugger(splFile, {
      pauseBefore: false,
      pauseAfter: true,
      stdin: input,
      stdout: output,
    });

    // 1. Paused AFTER response #1: shows Ln 1-.../Total scroll indicator & scrollbar, tail marker not visible yet
    const topFrame = await waitForOutput(output, (txt) => txt.includes("PAUSED AFTER #1"));
    assert.match(topFrame, /Ln 1-\d+\/\d+/);
    assert.match(topFrame, /█/);
    assert.doesNotMatch(topFrame, /BOTTOM_OF_RESULT_999/);

    // 2. Press Down arrow directly (without pressing Tab!) -> scrolls down to Ln 2-...
    output.clear();
    input.emit("data", "\x1b[B");
    const downFrame = await waitForOutput(output, (txt) => /Ln 2-\d+\/\d+/.test(txt));
    assert.match(downFrame, /Ln 2-\d+\/\d+/);

    // 3. Mouse wheel down over right inspector pane (x=80, y=10) -> scrolls down by 3 lines to Ln 5-...
    output.clear();
    input.emit("data", "\x1b[<65;80;10M");
    const wheelFrame = await waitForOutput(output, (txt) => /Ln 5-\d+\/\d+/.test(txt));
    assert.match(wheelFrame, /Ln 5-\d+\/\d+/);

    // 4. Jump to bottom with 'G' -> reveals tail_marker at the bottom of the result!
    output.clear();
    input.emit("data", "G");
    const bottomFrame = await waitForOutput(output, (txt) => txt.includes("BOTTOM_OF_RESULT_999"));
    assert.match(bottomFrame, /BOTTOM_OF_RESULT_999/);

    // 5. Switch to left Event List with Left arrow, move up to REQ, and scroll Inspector directly with Ctrl+D
    output.clear();
    input.emit("data", "\x1b[D"); // focus list
    input.emit("data", "\x1b[A"); // move to #1 REQ
    await waitForOutput(output, (txt) => txt.includes("#1 LLM_REQUEST"));

    // Quit cleanly and verify mouse tracking is disabled on exit
    input.emit("data", "q");
    await dbgPromise;
    assert.match(output.getRawText(), /\x1b\[\?1006l\x1b\[\?1000l/);
  } finally {
    await srv.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
