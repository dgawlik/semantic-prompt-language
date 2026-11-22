import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

class LspTestClient {
  constructor(proc) {
    this.proc = proc;
    this.nextId = 1;
    this.buffer = Buffer.alloc(0);
    this.pending = new Map();
    this.notifications = [];
    this.notifWaiters = [];

    proc.stdout.on("data", (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.drain();
    });
  }

  drain() {
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) break;
      const header = this.buffer.toString("ascii", 0, headerEnd);
      const m = header.match(/Content-Length:\s*(\d+)/i);
      if (!m) break;
      const len = Number.parseInt(m[1], 10);
      const start = headerEnd + 4;
      if (this.buffer.length < start + len) break;
      const body = this.buffer.toString("utf8", start, start + len);
      this.buffer = this.buffer.subarray(start + len);
      const msg = JSON.parse(body);

      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      } else if (msg.method) {
        let consumed = false;
        for (let i = this.notifWaiters.length - 1; i >= 0; i--) {
          const w = this.notifWaiters[i];
          if (w.pred(msg)) {
            this.notifWaiters.splice(i, 1);
            w.resolve(msg);
            consumed = true;
            break;
          }
        }
        if (!consumed) this.notifications.push(msg);
      }
    }
  }

  sendRaw(obj) {
    const json = JSON.stringify(obj);
    const bytes = Buffer.byteLength(json, "utf8");
    this.proc.stdin.write(`Content-Length: ${bytes}\r\n\r\n${json}`);
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.sendRaw({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method, params) {
    this.sendRaw({ jsonrpc: "2.0", method, params });
  }

  waitForNotification(pred, timeoutMs = 4000) {
    const idx = this.notifications.findIndex(pred);
    if (idx !== -1) {
      const [found] = this.notifications.splice(idx, 1);
      return Promise.resolve(found);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out waiting for LSP notification")), timeoutMs);
      this.notifWaiters.push({
        pred,
        resolve: (msg) => {
          clearTimeout(timer);
          resolve(msg);
        },
      });
    });
  }

  async close() {
    await this.request("shutdown", null);
    this.notify("exit", null);
    this.proc.kill();
  }
}

function startLsp() {
  const lspPath = path.resolve("dist/lsp.js");
  const proc = spawn(process.execPath, [lspPath], { stdio: ["pipe", "pipe", "pipe"] });
  return new LspTestClient(proc);
}

test("LSP: initialize, diagnostics, row-polymorphic property completion, hover JSON Schema, go-to-definition, document symbols", async () => {
  const client = startLsp();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "splx-lsp-"));
  const docPath = path.join(tmpDir, "app.splx");
  const uri = pathToFileURL(docPath).href;

  try {
    // 1. Initialize handshake
    const init = await client.request("initialize", {
      processId: process.pid,
      rootUri: pathToFileURL(tmpDir).href,
      capabilities: {},
    });
    assert.equal(init.serverInfo.name, "splx-language-server");
    assert.equal(init.capabilities.hoverProvider, true);
    assert.equal(init.capabilities.definitionProvider, true);
    assert.equal(init.capabilities.documentSymbolProvider, true);
    client.notify("initialized", {});

    // 2. Open valid .splx file -> 0 diagnostics
    const validSrc = [
      `import fs from "std/fs"`,
      ``,
      `/// Developer doc for Person`,
      `'' A restaurant user`,
      `pub type Person = struct {`,
      `    firstName: Str '' Starting with A`,
      `    age: Int       '' Greater than 0`,
      `}`,
      ``,
      `type ToolEvent = struct {`,
      `    /// Unique identifier for tracing`,
      `    id: Str '' Event ID`,
      `    ..extra: Dict<Str, Json> '' Extra metadata`,
      `}`,
      ``,
      `fn with_ts(x) {`,
      `    { ...x, ts: 123 }`,
      `}`,
      ``,
      `fn { firstName: Str, .. }.greet(self) -> Str {`,
      `    "Hi " + self.firstName`,
      `}`,
      ``,
      `fn demo(ev: ToolEvent, opt: Person?) -> Json {`,
      `    let user = { firstName: "Ada", age: 36 }`,
      `    let tagged = with_ts(user)`,
      `    let _ = tagged.firstName`,
      `    let _ = fs.read("x.txt")`,
      `    type_schema<Person>()`,
      `}`,
    ].join("\n");

    const diagP1 = client.waitForNotification((m) => m.method === "textDocument/publishDiagnostics");
    client.notify("textDocument/didOpen", {
      textDocument: { uri, languageId: "splx", version: 1, text: validSrc },
    });
    const diag1 = await diagP1;
    assert.deepEqual(diag1.params.diagnostics, []);

    // 3. Document symbols (Outline)
    const symbols = await client.request("textDocument/documentSymbol", { textDocument: { uri } });
    const symNames = symbols.map((s) => s.name);
    assert.ok(symNames.includes("Person"));
    assert.ok(symNames.includes("ToolEvent"));
    assert.ok(symNames.includes("with_ts"));
    assert.ok(symNames.includes("demo"));
    const personSym = symbols.find((s) => s.name === "Person");
    assert.deepEqual(personSym.children.map((c) => c.name), ["firstName", "age"]);

    // 4. Hover on `tagged` (line 26, col 14) shows row-polymorphic inferred fields including `ts: Int`!
    const hoverTagged = await client.request("textDocument/hover", {
      textDocument: { uri },
      position: { line: 26, character: 14 },
    });
    assert.ok(hoverTagged, "Expected hover for `tagged`");
    assert.match(hoverTagged.contents.value, /firstName: Str/);
    assert.match(hoverTagged.contents.value, /age: Int/);
    assert.match(hoverTagged.contents.value, /ts: Int/);

    // 5. Hover on `type_schema<Person>()` (line 28) shows live generated JSON Schema with `''` hints (and NOT `///` docs)!
    const hoverSchema = await client.request("textDocument/hover", {
      textDocument: { uri },
      position: { line: 28, character: 8 },
    });
    assert.ok(hoverSchema, "Expected hover for `type_schema<Person>()`");
    assert.match(hoverSchema.contents.value, /"additionalProperties": false/);
    assert.match(hoverSchema.contents.value, /Starting with A/);
    assert.doesNotMatch(hoverSchema.contents.value, /Developer doc for Person/);

    // 6. Go to Definition: `fs.read` -> jumps into `stdlib/fs.splx`!
    const defFs = await client.request("textDocument/definition", {
      textDocument: { uri },
      position: { line: 27, character: 16 },
    });
    assert.ok(defFs, "Expected definition for `fs.read`");
    assert.match(defFs.uri, /stdlib\/fs\.splx$/);

    // 7. Property completion on row-polymorphic `tagged.` (including extension method `greet`!)
    const withDot = validSrc.replace("let _ = tagged.firstName", "let _ = tagged.");
    const diagP2 = client.waitForNotification((m) => m.method === "textDocument/publishDiagnostics");
    client.notify("textDocument/didChange", {
      textDocument: { uri, version: 2 },
      contentChanges: [{ text: withDot }],
    });
    await diagP2;

    const compTagged = await client.request("textDocument/completion", {
      textDocument: { uri },
      position: { line: 26, character: 19 },
    });
    const taggedLabels = compTagged.items.map((i) => i.label);
    assert.ok(taggedLabels.includes("firstName"), `Missing firstName in ${taggedLabels}`);
    assert.ok(taggedLabels.includes("age"), `Missing age in ${taggedLabels}`);
    assert.ok(taggedLabels.includes("ts"), `Missing row-polymorphic ts in ${taggedLabels}`);
    assert.ok(taggedLabels.includes("greet"), `Missing extension method greet in ${taggedLabels}`);

    // 8. Property completion on hybrid open record `ev.` (shows `///` doc + `''` LLM hint + `extra: Dict<Str, Json>`)
    const withEvDot = validSrc.replace("let _ = tagged.firstName", "let _ = ev.");
    const diagP3 = client.waitForNotification((m) => m.method === "textDocument/publishDiagnostics");
    client.notify("textDocument/didChange", {
      textDocument: { uri, version: 3 },
      contentChanges: [{ text: withEvDot }],
    });
    await diagP3;

    const compEv = await client.request("textDocument/completion", {
      textDocument: { uri },
      position: { line: 26, character: 15 },
    });
    const idItem = compEv.items.find((i) => i.label === "id");
    const extraItem = compEv.items.find((i) => i.label === "extra");
    assert.ok(idItem && idItem.detail === "Str");
    assert.match(idItem.documentation.value, /Unique identifier for tracing/);
    assert.match(idItem.documentation.value, /LLM hint:\*\* Event ID/);
    assert.ok(extraItem && extraItem.detail === "Dict<Str, Json>");

    // 9. Optional chaining completion `opt?.` unwraps `Person?` -> completes `firstName`, `age`
    const withOptDot = validSrc.replace("let _ = tagged.firstName", "let _ = opt?.");
    const diagP4 = client.waitForNotification((m) => m.method === "textDocument/publishDiagnostics");
    client.notify("textDocument/didChange", {
      textDocument: { uri, version: 4 },
      contentChanges: [{ text: withOptDot }],
    });
    await diagP4;

    const compOpt = await client.request("textDocument/completion", {
      textDocument: { uri },
      position: { line: 26, character: 17 },
    });
    const optLabels = compOpt.items.map((i) => i.label);
    assert.ok(optLabels.includes("firstName"));
    assert.ok(optLabels.includes("age"));

    // 10. Namespace completion `fs.` and import path completion `from "std/`
    const withFsDot = validSrc.replace(`let _ = fs.read("x.txt")`, "let _ = fs.");
    const diagP5 = client.waitForNotification((m) => m.method === "textDocument/publishDiagnostics");
    client.notify("textDocument/didChange", {
      textDocument: { uri, version: 5 },
      contentChanges: [{ text: withFsDot }],
    });
    await diagP5;

    const compFs = await client.request("textDocument/completion", {
      textDocument: { uri },
      position: { line: 27, character: 15 },
    });
    const fsLabels = compFs.items.map((i) => i.label);
    assert.ok(fsLabels.includes("read"));
    assert.ok(fsLabels.includes("write"));
    assert.ok(fsLabels.includes("join_path"));

    const compImport = await client.request("textDocument/completion", {
      textDocument: { uri },
      position: { line: 0, character: 20 }, // inside `import fs from "std/`
    });
    const impLabels = compImport.items.map((i) => i.label);
    assert.ok(impLabels.includes("std/fs"));
    assert.ok(impLabels.includes("std/agent"));

    // 11. Type error produces accurate live diagnostic
    const brokenSrc = `fn bad(x: Int) -> Str { x + 1 }`;
    const diagP6 = client.waitForNotification((m) => m.method === "textDocument/publishDiagnostics");
    client.notify("textDocument/didChange", {
      textDocument: { uri, version: 6 },
      contentChanges: [{ text: brokenSrc }],
    });
    const diag6 = await diagP6;
    assert.equal(diag6.params.diagnostics.length, 1);
    assert.equal(diag6.params.diagnostics[0].source, "splx (type)");
    assert.match(diag6.params.diagnostics[0].message, /Type mismatch/);

    // 12. Opening stdlib/http.splx with lowercase Windows drive URI allows `extern` with 0 diagnostics
    const stdHttpPath = path.resolve("stdlib/http.splx");
    const stdHttpUri = pathToFileURL(stdHttpPath).href.replace(/^file:\/\/\/([A-Z]):/, (_, d) => `file:///${d.toLowerCase()}%3A`);
    const stdHttpText = fs.readFileSync(stdHttpPath, "utf8");
    const diagP7 = client.waitForNotification((m) => m.method === "textDocument/publishDiagnostics");
    client.notify("textDocument/didOpen", {
      textDocument: { uri: stdHttpUri, languageId: "splx", version: 1, text: stdHttpText },
    });
    const diag7 = await diagP7;
    assert.deepEqual(diag7.params.diagnostics, []);

    // 13. Property completion on return value of `codegen.js_fn<CalcIn, CalcOut>`!
    const cgUri = pathToFileURL(path.join(tmpDir, "cg.splx")).href;
    const cgSrc = [
      `import codegen from "std/codegen"`,
      `type CalcIn = struct { a: Int, b: Int }`,
      `type CalcOut = struct {`,
      `    sum: Int '' Sum of inputs`,
      `    product: Int`,
      `}`,
      `fn run() -> Result<Int, Str> {`,
      `    let f = codegen.js_fn<CalcIn, CalcOut>("return { sum: 1, product: 2 };")?`,
      `    let res = f({ a: 2, b: 3 })?`,
      `    let _ = res.`,
      `    Ok(0)`,
      `}`,
    ].join("\n");
    const diagP8 = client.waitForNotification((m) => m.method === "textDocument/publishDiagnostics");
    client.notify("textDocument/didOpen", {
      textDocument: { uri: cgUri, languageId: "splx", version: 1, text: cgSrc },
    });
    await diagP8;
    const compCg = await client.request("textDocument/completion", {
      textDocument: { uri: cgUri },
      position: { line: 9, character: 16 },
    });
    const cgLabels = compCg.items.map((i) => i.label);
    assert.ok(cgLabels.includes("sum"), `Expected 'sum' completion on dynamic js_fn output, got ${cgLabels}`);
    assert.ok(cgLabels.includes("product"), `Expected 'product' completion on dynamic js_fn output, got ${cgLabels}`);

    // 14. Extension method completion on std/collections (HashMap, TreeSet, List)
    const colUri = pathToFileURL(path.join(tmpDir, "col.splx")).href;
    const makeColSrc = (line5) => [
      `import col from "std/collections"`,
      `fn run() {`,
      `    let m = col.map_new().put("a", 1)`,
      `    let s = col.set_from_array([3, 1, 2])`,
      `    let xs = col.list_from_array([1, 2, 3])`,
      `    ${line5}`,
      `}`,
    ].join("\n");

    const diagP9 = client.waitForNotification((m) => m.method === "textDocument/publishDiagnostics");
    client.notify("textDocument/didOpen", {
      textDocument: { uri: colUri, languageId: "splx", version: 1, text: makeColSrc("let _ = m.") },
    });
    await diagP9;

    const compMap = await client.request("textDocument/completion", {
      textDocument: { uri: colUri },
      position: { line: 5, character: 14 },
    });
    const mapLabels = compMap.items.map((i) => i.label);
    assert.ok(mapLabels.includes("put") && mapLabels.includes("map_values") && mapLabels.includes("merge"), `Got: ${mapLabels}`);

    const diagP10 = client.waitForNotification((m) => m.method === "textDocument/publishDiagnostics");
    client.notify("textDocument/didChange", {
      textDocument: { uri: colUri, version: 2 },
      contentChanges: [{ text: makeColSrc("let _ = s.") }],
    });
    await diagP10;
    const compSet = await client.request("textDocument/completion", {
      textDocument: { uri: colUri },
      position: { line: 5, character: 14 },
    });
    const setLabels = compSet.items.map((i) => i.label);
    assert.ok(setLabels.includes("add") && setLabels.includes("union") && setLabels.includes("min"), `Got: ${setLabels}`);

    const diagP11 = client.waitForNotification((m) => m.method === "textDocument/publishDiagnostics");
    client.notify("textDocument/didChange", {
      textDocument: { uri: colUri, version: 3 },
      contentChanges: [{ text: makeColSrc("let _ = xs.") }],
    });
    await diagP11;
    const compList = await client.request("textDocument/completion", {
      textDocument: { uri: colUri },
      position: { line: 5, character: 15 },
    });
    const listLabels = compList.items.map((i) => i.label);
    assert.ok(listLabels.includes("push") && listLabels.includes("reverse") && listLabels.includes("zip"), `Got: ${listLabels}`);

    // 15. Chained method completion: single-line, multi-line, after trailing lambda, and mid-chain!
    const chainUri = pathToFileURL(path.join(tmpDir, "chain.splx")).href;

    // 15a. Single-line chain: `nums.take(3).`
    const chain1 = [
      `import col from "std/collections"`,
      `let nums = col.list_from_array([1, 2, 3, 4])`,
      `let x = nums.take(3).`,
    ].join("\n");
    const d12 = client.waitForNotification((m) => m.method === "textDocument/publishDiagnostics");
    client.notify("textDocument/didOpen", {
      textDocument: { uri: chainUri, languageId: "splx", version: 1, text: chain1 },
    });
    await d12;
    const c1 = await client.request("textDocument/completion", {
      textDocument: { uri: chainUri },
      position: { line: 2, character: 21 },
    });
    const c1Labels = c1.items.map((i) => i.label);
    assert.ok(c1Labels.includes("zip") && c1Labels.includes("reverse"), `Single-line chain failed: ${c1Labels}`);

    // 15b. Multi-line chain after trailing lambda:
    const chain2 = [
      `import col from "std/collections"`,
      `let nums = col.list_from_array([1, 2, 3, 4])`,
      `let transformed = nums`,
      `    .prepend(0)`,
      `    .filter { n -> n % 2 == 0 }`,
      `    .`,
    ].join("\n");
    const d13 = client.waitForNotification((m) => m.method === "textDocument/publishDiagnostics");
    client.notify("textDocument/didChange", {
      textDocument: { uri: chainUri, version: 2 },
      contentChanges: [{ text: chain2 }],
    });
    await d13;
    const c2 = await client.request("textDocument/completion", {
      textDocument: { uri: chainUri },
      position: { line: 5, character: 5 },
    });
    const c2Labels = c2.items.map((i) => i.label);
    assert.ok(c2Labels.includes("map") && c2Labels.includes("reverse") && c2Labels.includes("push"), `Multi-line lambda chain failed: ${c2Labels}`);

    // 15c. Mid-chain completion (more chained calls below the cursor!):
    const chain3 = [
      `import col from "std/collections"`,
      `let nums = col.list_from_array([1, 2, 3, 4])`,
      `let transformed = nums`,
      `    .prepend(0)`,
      `    .`,
      `    .push(6)`,
      `    .reverse()`,
    ].join("\n");
    const d14 = client.waitForNotification((m) => m.method === "textDocument/publishDiagnostics");
    client.notify("textDocument/didChange", {
      textDocument: { uri: chainUri, version: 3 },
      contentChanges: [{ text: chain3 }],
    });
    await d14;
    const c3 = await client.request("textDocument/completion", {
      textDocument: { uri: chainUri },
      position: { line: 4, character: 5 },
    });
    const c3Labels = c3.items.map((i) => i.label);
    assert.ok(c3Labels.includes("push") && c3Labels.includes("filter") && c3Labels.includes("take"), `Mid-chain completion failed: ${c3Labels}`);

    // 16. Hover documentation for stdlib functions, built-in prelude functions, built-in methods,
    //     stdlib extension methods, AND hover inside a file that currently has a type error!
    const hoverPath = path.join(tmpDir, "hover_docs.splx");
    const hoverUri = pathToFileURL(hoverPath).href;
    const hoverSrc = [
      `import fs from "std/fs"`,
      `import col from "std/collections"`,
      ``,
      `fn demo_hover(arr: Array<Int>) -> Unit {`,
      `    let _ = fs.read("a.txt")`,
      `    let _ = arr.get(0)`,
      `    let m = col.map_new().put("k", 1)`,
      `    print_inline("hi")`,
      `}`,
    ].join("\n");
    const d15 = client.waitForNotification((m) => m.method === "textDocument/publishDiagnostics");
    client.notify("textDocument/didOpen", {
      textDocument: { uri: hoverUri, languageId: "splx", version: 1, text: hoverSrc },
    });
    await d15;

    // 16a. Hover stdlib `fs.read` (on `read`)
    const hFsRead = await client.request("textDocument/hover", {
      textDocument: { uri: hoverUri },
      position: { line: 4, character: 16 },
    });
    assert.ok(hFsRead, "Expected hover popup on fs.read");
    assert.match(hFsRead.contents.value, /UTF-8 contents/i);

    // 16b. Hover built-in method `arr.get` (on `get`)
    const hArrGet = await client.request("textDocument/hover", {
      textDocument: { uri: hoverUri },
      position: { line: 5, character: 17 },
    });
    assert.ok(hArrGet, "Expected hover popup on arr.get");
    assert.match(hArrGet.contents.value, /Bounds-checked element lookup/i);

    // 16c. Hover stdlib extension method `.put` on HashMap
    const hMapPut = await client.request("textDocument/hover", {
      textDocument: { uri: hoverUri },
      position: { line: 6, character: 27 },
    });
    assert.ok(hMapPut, "Expected hover popup on HashMap.put");
    assert.match(hMapPut.contents.value, /Inserts or updates/i);

    // 16d. Hover built-in prelude function `print_inline`
    const hPrintInline = await client.request("textDocument/hover", {
      textDocument: { uri: hoverUri },
      position: { line: 7, character: 8 },
    });
    assert.ok(hPrintInline, "Expected hover popup on print_inline");
    assert.match(hPrintInline.contents.value, /without.*trailing newline/i);

    // 16e. Hover STILL works on builtins & stdlib inside a broken file with a type error!
    const brokenHoverPath = path.join(tmpDir, "broken_hover.splx");
    const brokenHoverUri = pathToFileURL(brokenHoverPath).href;
    const brokenHoverSrc = [
      `import llm from "std/llm"`,
      `fn f(arr: Array<Int>) -> Unit {`,
      `    let x = arr.get(0)`,
      `    arr.nonexistent(0)`,
      `    let _ = llm.ask`,
      `    print("ok")`,
      `}`,
    ].join("\n");
    const d16 = client.waitForNotification((m) => m.method === "textDocument/publishDiagnostics");
    client.notify("textDocument/didOpen", {
      textDocument: { uri: brokenHoverUri, languageId: "splx", version: 1, text: brokenHoverSrc },
    });
    await d16;

    const hBrokenGet = await client.request("textDocument/hover", {
      textDocument: { uri: brokenHoverUri },
      position: { line: 2, character: 17 },
    });
    assert.ok(hBrokenGet && /Bounds-checked/i.test(hBrokenGet.contents.value), "Expected arr.get hover even in broken file");

    const hBrokenAsk = await client.request("textDocument/hover", {
      textDocument: { uri: brokenHoverUri },
      position: { line: 4, character: 17 },
    });
    assert.ok(hBrokenAsk && /single-turn/i.test(hBrokenAsk.contents.value), "Expected llm.ask hover even in broken file");

    const hBrokenPrint = await client.request("textDocument/hover", {
      textDocument: { uri: brokenHoverUri },
      position: { line: 5, character: 6 },
    });
    assert.ok(hBrokenPrint && /stdout/i.test(hBrokenPrint.contents.value), "Expected print hover even in broken file");

    // 17. Completion on `arr.` inside a function that has unrelated errors BELOW the cursor (like quicksort.splx!)
    const qsPath = path.join(tmpDir, "qs_complete.splx");
    const qsUri = pathToFileURL(qsPath).href;
    const qsSrc = [
      `fn partition(arr: Array<Int>, low: Int, high: Int) -> Int {`,
      `    let pivot = arr.get(high) ?? 0`,
      `    let mut i = low - 1`,
      `    for j in low..high {`,
      `        if arr.get(j) ?? 0 <= pivot {`,
      `            i = i + 1`,
      `            let temp = arr.`,
      `        }`,
      `    }`,
      `    arr.nonexistent(i + 1, 0)`,
      `    i + 1`,
      `}`,
    ].join("\n");
    const d17 = client.waitForNotification((m) => m.method === "textDocument/publishDiagnostics");
    client.notify("textDocument/didOpen", {
      textDocument: { uri: qsUri, languageId: "splx", version: 1, text: qsSrc },
    });
    await d17;

    const cArr = await client.request("textDocument/completion", {
      textDocument: { uri: qsUri },
      position: { line: 6, character: 27 },
    });
    const cArrLabels = cArr.items.map((i) => i.label);
    assert.ok(
      cArrLabels.includes("get") && cArrLabels.includes("push") && cArrLabels.includes("iter") && cArrLabels.includes("len"),
      `Expected Array<Int> completions on arr. despite errors below cursor, got: ${cArrLabels}`
    );

    // 18. Stdlib function named-argument completions & signatureHelp (e.g. `llm.ask<Person>(|)`)
    assert.ok(init.capabilities.signatureHelpProvider, "Expected signatureHelpProvider capability");
    const askPath = path.join(tmpDir, "ask_args.splx");
    const askUri = pathToFileURL(askPath).href;
    const askSrc = [
      `import llm from "std/llm"`,
      `import { read } from "std/fs"`,
      ``,
      `type Person = {`,
      `    firstName: String '' Ada`,
      `    age: Int '' 36`,
      `}`,
      ``,
      `let ada = llm.ask<Person>()`,
      `let ada2 = llm.ask<Person>(provider: "openai_responses", )`,
      `let ada3 = llm.ask<Person>(provider: "openai_responses", mod)`,
      `let ada4 = llm.ask<Person>(provider: "openai_responses", temperature: )`,
      `let f = read()`,
    ].join("\n");
    const d18 = client.waitForNotification((m) => m.method === "textDocument/publishDiagnostics");
    client.notify("textDocument/didOpen", {
      textDocument: { uri: askUri, languageId: "splx", version: 1, text: askSrc },
    });
    await d18;

    // 18a. Empty `llm.ask<Person>(|)` -> completes required & optional named args
    const cAskEmpty = await client.request("textDocument/completion", {
      textDocument: { uri: askUri },
      position: { line: 8, character: 26 },
    });
    const askLabels = cAskEmpty.items.map((i) => i.label);
    assert.ok(
      askLabels.includes("provider:") &&
        askLabels.includes("api_key:") &&
        askLabels.includes("model:") &&
        askLabels.includes("prompt:") &&
        askLabels.includes("temperature:"),
      `Expected llm.ask named arg completions inside (), got: ${askLabels.slice(0, 20)}`
    );
    const providerItem = cAskEmpty.items.find((i) => i.label === "provider:");
    const tempItem = cAskEmpty.items.find((i) => i.label === "temperature:");
    assert.equal(providerItem.insertText, "provider: ");
    assert.match(providerItem.detail, /required/);
    assert.match(tempItem.detail, /optional/);
    assert.ok(providerItem.sortText < tempItem.sortText, "Required params should sort before optional params");

    // 18b. After `provider: "openai_responses", ` -> omits already-used `provider:`
    const cAskSecond = await client.request("textDocument/completion", {
      textDocument: { uri: askUri },
      position: { line: 9, character: 57 },
    });
    const secondLabels = cAskSecond.items.map((i) => i.label);
    assert.ok(!secondLabels.includes("provider:"), "Already-used named arg `provider:` should be excluded");
    assert.ok(secondLabels.includes("api_key:") && secondLabels.includes("model:"));

    // 18c. Prefix filtering: `mod` -> `model:`
    const cAskPrefix = await client.request("textDocument/completion", {
      textDocument: { uri: askUri },
      position: { line: 10, character: 60 },
    });
    assert.ok(cAskPrefix.items.some((i) => i.label === "model:"), "Expected `model:` for prefix `mod`");

    // 18d. Value slot after `temperature: ` -> does NOT suggest named arg labels, DOES return signatureHelp highlighting `temperature`
    const cAskVal = await client.request("textDocument/completion", {
      textDocument: { uri: askUri },
      position: { line: 11, character: 70 },
    });
    assert.ok(!cAskVal.items.some((i) => i.label === "api_key:"), "Should not suggest named arg labels inside argument value slot");

    const sigHelp = await client.request("textDocument/signatureHelp", {
      textDocument: { uri: askUri },
      position: { line: 11, character: 70 },
    });
    assert.ok(sigHelp && sigHelp.signatures.length === 1, "Expected signatureHelp for llm.ask");
    assert.match(sigHelp.signatures[0].label, /reified async fn llm\.ask\(/);
    assert.match(sigHelp.signatures[0].parameters[sigHelp.activeParameter].label, /^temperature:/);

    // 18e. Direct named stdlib import `read(|)` -> completes `path:`
    const cRead = await client.request("textDocument/completion", {
      textDocument: { uri: askUri },
      position: { line: 12, character: 13 },
    });
    assert.ok(cRead.items.some((i) => i.label === "path:"), "Expected `path:` arg completion for imported `read()`");
  } finally {
    await client.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
