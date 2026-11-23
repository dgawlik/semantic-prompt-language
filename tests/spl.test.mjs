import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

import { compileSnippet, compileFile, extractTypeSchema, SplError } from "../dist/index.js";

async function runSpl(source) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "spl-test-"));
  const srcPath = path.join(tmpDir, "main.splx");
  fs.writeFileSync(srcPath, source, "utf8");
  try {
    const outDir = path.join(tmpDir, "out");
    const res = compileFile(srcPath, outDir);
    const mod = await import(`${pathToFileURL(res.entryOutPath).href}?t=${Date.now()}_${Math.random()}`);
    return { mod, jsCode: res.modules.get(srcPath).jsCode };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

test("1. Prompt blocks @{ ... }: auto-dedent, brace-balanced JSON, and ${expr} interpolation", async () => {
  const { mod } = await runSpl(`
    fn run_agent(model: Str = "gpt-6-luna", tokens: Int = 1024, prompt: Prompt) -> Result<(Str, Int), Str> {
        Ok((prompt.render(), tokens))
    }

    pub fn test_prompt() -> Result<(Str, Int), Str> {
        let dir = "./src"
        let (text, tok) = run_agent(model: "gpt-6-luna", tokens: 2048) @{
            Analyze \`\${dir}\` for vulnerabilities.
            Format: {"issues": ["item1", "item2"]}
        }?
        Ok((text, tok))
    }
  `);

  const res = mod.test_prompt();
  assert.equal(res.$tag, "Ok");
  const [text, tok] = res._0;
  assert.equal(tok, 2048);
  assert.equal(text, 'Analyze `./src` for vulnerabilities.\nFormat: {"issues": ["item1", "item2"]}');
});

test("2. Trailing lambdas, tuples vs arrays, Int vs Float, Char vs Str, let mut", async () => {
  const { mod } = await runSpl(`
    pub fn run() -> (Array<Int>, Int, Float, Char, Int) {
        let nums = [1, 2, 3, 4]
        let doubled = nums.map { i -> 2 * i }
        let mut sum = 0
        let mut idx = 0
        while idx < doubled.len() {
            let v = doubled[idx] ?? 0
            sum = sum + v
            idx = idx + 1
        }
        let ch: Char = 'Z'
        let f: Float = 3.5 + 1.5
        (doubled, sum, f, ch, 7 / 2)
    }
  `);

  const [doubled, sum, f, ch, intDiv] = mod.run();
  assert.deepEqual(doubled, [2, 4, 6, 8]);
  assert.equal(sum, 20);
  assert.equal(f, 5);
  assert.equal(ch, "Z");
  assert.equal(intDiv, 3); // Int division truncates!
});

test("3. Immutability enforcement: reassigning `let` fails at compile time", () => {
  assert.throws(
    () =>
      compileSnippet(`
        fn bad() -> Int {
            let x = 1
            x = 2
            x
        }
      `),
    (err) => err instanceof SplError && err.phase === "type" && /immutable/i.test(err.message)
  );
});

test("4. Structural equivalence + row polymorphism preserves extra fields", async () => {
  const { mod } = await runSpl(`
    type Person = struct {
        firstName: Str
        lastName: Str
        age: Int
    }

    fn greet(p: Person) -> Str {
        "Hello " + p.firstName + " " + p.lastName
    }

    fn with_timestamp(x) {
        { ...x, ts: 999 }
    }

    pub fn run() -> (Str, Str, Int, Int) {
        let anon = { firstName: "Ada", lastName: "Lovelace", age: 36 }
        let g = greet(anon)
        let tagged = with_timestamp(anon)
        (g, tagged.firstName, tagged.age, tagged.ts)
    }
  `);

  assert.deepEqual(mod.run(), ["Hello Ada Lovelace", "Ada", 36, 999]);
});

test("5. Hybrid open records: dot access for static fields, bracket access -> Option for dynamic keys", async () => {
  const { mod } = await runSpl(`
    type ToolEvent = struct {
        id: Str   // Unique event id
        kind: Str // Event category
        ..extra: Dict<Str, Json> // Arbitrary runtime metadata
    }

    pub fn parse_event(raw: Str) -> Result<(Str, Str, Bool, Bool), Str> {
        let j = json_parse(raw)?
        let ev = match decode<ToolEvent>(j) {
            Ok(v) => v
            Err(e) => return Err(e.path + ": " + e.message)
        }
        let has_model = ev["model"].is_some()
        let has_missing = ev["nope"].is_some()
        Ok((ev.id, ev.kind, has_model, has_missing))
    }
  `);

  const res = mod.parse_event('{"id":"e1","kind":"call","model":"gpt-6-luna","temp":0.2}');
  assert.equal(res.$tag, "Ok");
  assert.deepEqual(res._0, ["e1", "call", true, false]);

  // Accessing unknown field via dot notation MUST fail at compile time
  assert.throws(
    () =>
      compileSnippet(`
        type ToolEvent = struct {
            id: Str
            ..extra: Dict<Str, Json>
        }
        fn bad(ev: ToolEvent) -> Str {
            ev.typo
        }
      `),
    (err) => err instanceof SplError && err.phase === "type" && /no property 'typo'/i.test(err.message)
  );
});

test("6. Option<T> (T?, ?., ??) and Result<T, E> with postfix ? propagation", async () => {
  const { mod } = await runSpl(`
    type Profile = struct {
        nickname: Str?
    }

    fn step1(ok: Bool) -> Result<Int, Str> {
        if ok { Ok(21) } else { Err("step1 failed") }
    }

    pub fn compute(ok: Bool) -> Result<Int, Str> {
        let v = step1(ok)?
        Ok(v * 2)
    }

    pub fn nick_or_default(p: Profile?) -> Str {
        p?.nickname ?? "anonymous"
    }
  `);

  assert.deepEqual(mod.compute(true), { $tag: "Ok", _0: 42 });
  assert.deepEqual(mod.compute(false), { $tag: "Err", _0: "step1 failed" });
  assert.equal(mod.nick_or_default({ $tag: "Some", _0: { nickname: { $tag: "Some", _0: "neo" } } }), "neo");
  assert.equal(mod.nick_or_default({ $tag: "Some", _0: { nickname: { $tag: "None" } } }), "anonymous");
  assert.equal(mod.nick_or_default({ $tag: "None" }), "anonymous");
});

test("7. Enums, Pattern Matching & Exhaustiveness Checking", async () => {
  const { mod } = await runSpl(`
    enum Action {
        Call(Str, Int)
        Done(Str)
        Idle
    }

    pub fn describe(a: Action) -> Str {
        match a {
            Call(name, n) => name + ":" + to_str(n)
            Done(msg) => "done:" + msg
            Idle => "idle"
        }
    }

    pub fn match_open_record(ev: { kind: Str, name: Str, .. }) -> Str {
        match ev {
            { kind: "call", name, .. } => "calling " + name
            { kind, .. } => "other:" + kind
        }
    }
  `);

  assert.equal(mod.describe({ $tag: "Call", _0: "search", _1: 3 }), "search:3");
  assert.equal(mod.describe({ $tag: "Done", _0: "ok" }), "done:ok");
  assert.equal(mod.describe({ $tag: "Idle" }), "idle");
  assert.equal(mod.match_open_record({ kind: "call", name: "grep", extra: 1 }), "calling grep");

  // Non-exhaustive enum match MUST fail at compile time
  assert.throws(
    () =>
      compileSnippet(`
        enum Color { Red, Green, Blue }
        fn bad(c: Color) -> Int {
            match c {
                Red => 1
                Green => 2
            }
        }
      `),
    (err) => err instanceof SplError && err.phase === "type" && /non-exhaustive/i.test(err.message)
  );
});

test("8. Traits, Extension Methods & Structural Coherence Check", async () => {
  const { mod } = await runSpl(`
    type User = struct {
        first: Str
        last: Str
    }

    fn { first: Str, last: Str, .. }.full_name(self) -> Str {
        self.first + " " + self.last
    }

    impl Show for User {
        fn show(self) -> Str {
            "User(" + self.first + ")"
        }
    }

    pub fn run() -> (Str, Str) {
        let u = { first: "Grace", last: "Hopper", rank: "Admiral" }
        let strict_u = { first: "Alan", last: "Turing" }
        (u.full_name(), strict_u.show())
    }
  `);

  assert.deepEqual(mod.run(), ["Grace Hopper", "User(Alan)"]);

  // Overlapping trait impl on structurally identical record shapes MUST fail!
  assert.throws(
    () =>
      compileSnippet(`
        type Person = struct { name: Str }
        type Guest = struct { name: Str }
        impl Show for Person {
            fn show(self) -> Str { self.name }
        }
        impl Show for Guest {
            fn show(self) -> Str { "guest:" + self.name }
        }
      `),
    (err) => err instanceof SplError && err.phase === "type" && /conflicting trait implementation/i.test(err.message)
  );
});

test("9. Compile-time type_schema<T>() & decode<T>(json) with '' LLM hints (excluding // and ///)", async () => {
  const { mod } = await runSpl(`
    // Regular comment (ignored everywhere)
    /// Developer doc-comment (for IDE only, NOT emitted to LLM schema)
    '' This is a user
    '' of a restaurant
    type Person = struct {
        /// Developer field doc (NOT in schema)
        firstName: Str '' Starting with letter A
        lastName: Str  // Regular comment (NOT in schema)
        age: Int       '' Greater than zero
        bio: Str?      '' Optional short bio
    }

    type OpenBag = struct {
        id: Str
        ..extra: Dict<Str, Int>
    }

    pub fn get_person_schema() -> Json { type_schema<Person>() }
    pub fn get_open_schema() -> Json { type_schema<OpenBag>() }
    pub fn get_char() -> Char { 'X' }
    pub fn decode_person(raw: Str) -> Result<Person, Str> {
        let j = json_parse(raw)?
        match decode<Person>(j) {
            Ok(p) => Ok(p)
            Err(e) => Err(e.path + ": " + e.message)
        }
    }
  `);

  const ps = mod.get_person_schema();
  assert.equal(ps.title, "Person");
  assert.equal(ps.description, "This is a user\nof a restaurant");
  assert.equal(ps.additionalProperties, false);
  assert.deepEqual(ps.required, ["firstName", "lastName", "age"]);
  assert.equal(ps.properties.firstName.description, "Starting with letter A");
  assert.equal(ps.properties.lastName.description, undefined); // `//` comment excluded!
  assert.equal(ps.properties.age.type, "integer");
  assert.equal(ps.properties.age.description, "Greater than zero");
  assert.equal(mod.get_char(), "X"); // `'X'` Char literal unaffected by `''` hints!

  const osSchema = mod.get_open_schema();
  assert.deepEqual(osSchema.additionalProperties, { type: "integer" });

  // Valid decode
  const ok = mod.decode_person('{"firstName":"Ada","lastName":"Lovelace","age":36}');
  assert.equal(ok.$tag, "Ok");
  assert.equal(ok._0.firstName, "Ada");
  assert.equal(ok._0.bio.$tag, "None");

  // Rejects float for Int!
  const badFloat = mod.decode_person('{"firstName":"Ada","lastName":"Lovelace","age":36.5}');
  assert.equal(badFloat.$tag, "Err");
  assert.match(badFloat._0, /Expected Int/);

  // Rejects extra property on closed struct!
  const badExtra = mod.decode_person('{"firstName":"Ada","lastName":"Lovelace","age":36,"hacker":true}');
  assert.equal(badExtra.$tag, "Err");
  assert.match(badExtra._0, /Unexpected field 'hacker'/);
});

test("10. Transparent (colorless) async: sequential map vs concurrent par_map, sync pure functions", async () => {
  const { mod, jsCode } = await runSpl(`
    import clock from "std/clock"

    pub fn pure_add(a: Int, b: Int) -> Int {
        a + b
    }

    fn delayed_double(x: Int) -> Int {
        clock.sleep(25)
        x * 2
    }

    pub fn run_sequential() -> (Array<Int>, Int) {
        let start = clock.now_ms()
        let out = [1, 2, 3].map { x -> delayed_double(x) }
        (out, clock.now_ms() - start)
    }

    pub fn run_parallel() -> (Array<Int>, Int) {
        let start = clock.now_ms()
        let out = [1, 2, 3].par_map { x -> delayed_double(x) }
        (out, clock.now_ms() - start)
    }
  `);

  // Pure function must NOT be emitted as `async`!
  assert.match(jsCode, /export function pure_add\(/);
  assert.equal(mod.pure_add(2, 3), 5);

  const [seqOut, seqMs] = await mod.run_sequential();
  assert.deepEqual(seqOut, [2, 4, 6]);
  assert.ok(seqMs >= 60, `Expected sequential map >= 60ms, got ${seqMs}ms`);

  const [parOut, parMs] = await mod.run_parallel();
  assert.deepEqual(parOut, [2, 4, 6]);
  assert.ok(parMs < seqMs, `Expected par_map (${parMs}ms) to be faster than sequential map (${seqMs}ms)`);
});

test("11. Self-tail-call optimization (TCO) compiles to while loop without stack overflow", async () => {
  const { mod, jsCode } = await runSpl(`
    pub fn sum_to(n: Int, acc: Int) -> Int {
        if n <= 0 {
            acc
        } else {
            sum_to(n - 1, acc + n)
        }
    }
  `);

  assert.match(jsCode, /while \(true\)/);
  assert.equal(mod.sum_to(100_000, 0), 5000050000);
});

test("12. Private JS FFI enforcement: `extern` is rejected in user code", () => {
  assert.throws(
    () =>
      compileSnippet(`
        extern fn sneaky() -> Int = "ffi_universal:clockNowMs"
      `),
    (err) => err instanceof SplError && err.phase === "type" && /restricted to the standard library/i.test(err.message)
  );
});

test("13. Multi-file modules + std/fs + std/proc + std/agent end-to-end with local HTTP server", async () => {
  // Start local mock LLM HTTP server
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          summary: `Reviewed: ${parsed.prompt.split("\n")[0]}`,
          severity: 2,
        })
      );
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "spl-e2e-"));

  try {
    fs.writeFileSync(
      path.join(tmpDir, "models.splx"),
      `
        // Audit report from agent
        pub type AuditReport = struct {
            summary: Str  // Short summary
            severity: Int // 1 to 5
        }
      `,
      "utf8"
    );

    const mainPath = path.join(tmpDir, "main.splx");
    const scratchFile = path.join(tmpDir, "hello.txt").replace(/\\/g, "/");
    fs.writeFileSync(
      mainPath,
      `
        import { AuditReport } from "./models"
        import fs from "std/fs"
        import proc from "std/proc"
        import agent from "std/agent"

        pub fn e2e(endpoint: Str) -> Result<(Str, Str, Int, Str), Str> {
            // Test std/fs
            fs.write("${scratchFile}", "hello spl")?
            let content = fs.read("${scratchFile}")?

            // Test std/proc pure-SPL shell wrapper
            let sh_out = proc.shell("echo spl-ok")?

            // Test std/agent with @{ ... } prompt + type_schema + decode
            let target = "./src"
            let (raw_body, trace) = agent.call_endpoint(
                endpoint: endpoint,
                model: "gpt-6-luna",
                tokens: 512,
                schema: Some(type_schema<AuditReport>())
            ) @{
                Analyze \`\${target}\` for issues.
                Return JSON matching schema.
            }?

            let parsed = json_parse(raw_body)?
            let report = match decode<AuditReport>(parsed) {
                Ok(r) => r
                Err(e) => return Err(e.path + ": " + e.message)
            }
            Ok((content, report.summary, report.severity, sh_out.stdout.trim()))
        }
      `,
      "utf8"
    );

    const outDir = path.join(tmpDir, "out");
    const compiled = compileFile(mainPath, outDir);
    const mod = await import(`${pathToFileURL(compiled.entryOutPath).href}?t=${Date.now()}`);
    const result = await mod.e2e(`http://127.0.0.1:${port}/v1/agent`);

    assert.equal(result.$tag, "Ok");
    assert.deepEqual(result._0, [
      "hello spl",
      "Reviewed: Analyze `./src` for issues.",
      2,
      "spl-ok",
    ]);
  } finally {
    server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("14. CLI smoke test: `spl check`, `spl schema`, `spl run` on examples/06_prompts_and_schemas.splx", () => {
  const cli = path.resolve("dist/cli.js");
  const sample = path.resolve("examples/06_prompts_and_schemas.splx");

  const checkOut = execFileSync(process.execPath, [cli, "check", sample], { encoding: "utf8" });
  assert.match(checkOut, /OK/);

  const schemaOut = execFileSync(process.execPath, [cli, "schema", sample, "SecurityAudit"], { encoding: "utf8" });
  const schema = JSON.parse(schemaOut);
  assert.equal(schema.title, "SecurityAudit");
  assert.equal(schema.properties.issue_count.type, "integer");
  assert.equal(schema.additionalProperties, false);

  const runOut = execFileSync(process.execPath, [cli, "run", sample], { encoding: "utf8" });
  assert.match(runOut, /=== 06_prompts_and_schemas ===/);
  assert.match(runOut, /prompt=120, completion=45/);
});

test("15. All documented examples (`examples/01..13_*.splx`) compile and execute cleanly", () => {
  const cli = path.resolve("dist/cli.js");
  const examplesDir = path.resolve("examples");
  const files = fs.readdirSync(examplesDir).filter((f) => /^\d+_.*\.splx$/.test(f)).sort();
  assert.equal(files.length, 13);

  for (const file of files) {
    if (file === "08_dynamic_codegen.splx") {
      const checkOut = execFileSync(process.execPath, [cli, "check", path.join(examplesDir, file)], {
        encoding: "utf8",
      });
      assert.match(checkOut, /^OK \(/);
      continue;
    }
    const out = execFileSync(process.execPath, [cli, "run", path.join(examplesDir, file)], {
      encoding: "utf8",
      env: { ...process.env, OPENAI_API_KEY: "" },
    });
    assert.match(out, new RegExp(`=== ${file.replace(".splx", "")} ===`));
    if (file === "06_prompts_and_schemas.splx") {
      assert.match(out, /prompt=120, completion=45/);
    }
    if (file === "09_collections.splx") {
      assert.match(out, /TreeSet sorted:\s+\[10, 20, 30, 50, 60, 70, 80\]/);
      assert.match(out, /TreeSet after remove: \[20, 30, 60, 70, 80\]/);
      assert.match(out, /List transformed: \[60, 40, 20, 0\]/);
    }
    if (file === "11_reified_types.splx") {
      assert.match(out, /parsed Task:\s+id=1, title=Ship reified types/);
      assert.match(out, /parsed batch:\s+2 tasks, second=Build/);
      assert.match(out, /parsed Envelope: ok=true, data\.id=7/);
      assert.match(out, /eval_typed Task: id=42, title=Generated/);
      assert.match(out, /invalid decode:\s+is_err=true/);
    }
    if (file === "12_files_and_shell.splx") {
      assert.match(out, /config loaded:\s+name=spl-demo, version=1\.0\.0/);
      assert.match(out, /walked files:\s+total=3, splx=1/);
      assert.match(out, /proc\.shell:\s+code=0, stdout=hello from shell/);
      assert.match(out, /proc\.exec \(cwd\): code=0, stdout=spl-demo@1\.0\.0/);
      assert.match(out, /non-zero exit:\s+code=2, stderr=simulated warning/);
      assert.match(out, /cleanup:\s+done/);
    }
    if (file === "13_typeof_and_newtype.splx") {
      assert.match(out, /newtype show:\s+User#42 vs Order#42 \(admin=true, raw=42\)/);
      assert.match(out, /struct newtype:\s+Point\(15, 20\)/);
      assert.match(out, /typeof type:\s+api\.spl\.dev:443/);
      assert.match(out, /nominal eq:\s+UserId==OrderId=false, UserId==Int=false/);
      assert.match(out, /compounds:\s+Array<UserId>, Box<UserId>, UserId\?/);
    }
  }
});

test("16. std/codegen: typed js_fn, js_async_fn, js_eval, spl_fn, sandbox timeout & type rejection", async () => {
  const { mod } = await runSpl(`
    import codegen from "std/codegen"

    type Pair = struct { a: Int, b: Int }
    type Out = struct { sum: Int, diff: Int }

    pub fn test_all() -> Result<(Int, Int, Int, Int, Bool, Bool, Bool), Str> {
        let f_js = codegen.js_fn<Pair, Out>("return { sum: input.a + input.b, diff: input.a - input.b };")?
        let r1 = f_js({ a: 10, b: 3 })?

        let f_async = codegen.js_async_fn<Int, Int>("return await Promise.resolve(input + 5);")?
        let r2 = f_async(37)?

        let r3 = codegen.js_eval<Int>("6 * 7")?

        let f_spl = codegen.spl_fn<Pair, Out>("pub fn run(p) { { sum: p.a + p.b, diff: p.a - p.b } }")?
        let r4 = f_spl({ a: 20, b: 4 })?

        // Runtime type mismatch caught by Out codec
        let bad_js = codegen.js_fn<Int, Int>("return 'oops';")?
        let bad_js_err = bad_js(1).is_err()

        // Infinite loop stopped by VM timeout
        let hang = codegen.js_fn<Int, Int>("while (true) {}", timeout_ms: 40)?
        let hang_err = hang(1).is_err()

        // Compile-time type error caught in spl_fn before execution
        let bad_spl_err = codegen.spl_fn<Pair, Out>("pub fn run(p) { { sum: \\"nope\\", diff: 0 } }").is_err()

        Ok((r1.sum, r2, r3, r4.diff, bad_js_err, hang_err, bad_spl_err))
    }
  `);

  const res = await mod.test_all();
  assert.equal(res.$tag, "Ok");
  assert.deepEqual(res._0, [13, 42, 42, 16, true, true, true]);
});

test("17. std/collections: HashMap, AVL TreeSet (balancing + removal + set ops) & List extension methods", async () => {
  const { mod } = await runSpl(`
    import col from "std/collections"

    pub fn test_hashmap() -> (Int, Int, Bool, Int, Int) {
        let m0 = col.map_new().put("a", 1).put("b", 2).put("c", 3)
        let m1 = m0.remove("b").map_values({ v -> v * 10 }).merge(col.map_from_entries([("d", 40)]))
        (m0.len(), m1.len(), m1.has("b"), m1.get_or("a", 0), m1.fold(0, { acc, _, v -> acc + v }))
    }

    pub fn test_treeset() -> (Array<Int>, Int, Int, Int, Array<Int>, Array<Int>, Bool) {
        // Ascending insertion stresses left rotations; descending stresses right rotations
        let mut s = col.set_new()
        let mut i = 1
        while i <= 15 {
            s = s.add(i)
            i = i + 1
        }
        // Duplicate insert must not grow size
        s = s.add(7).add(1)
        let after = s.remove(8).remove(1).remove(15)
        let other = col.set_from_array([2, 4, 6, 100])
        (
            after.to_array(),
            s.len(),
            after.min() ?? -1,
            after.max() ?? -1,
            after.intersection(other).to_array(),
            other.difference(after).to_array(),
            after.contains(7) && !after.contains(8)
        )
    }

    pub fn test_list() -> (Array<Int>, Int, Int, Array<(Int, Str)>, Bool, Bool) {
        let xs = col.list_from_array([10, 20, 30, 40])
        let ys = xs.prepend(5).push(50).drop(1).take(4).reverse()
        let zs = xs.take(2).zip(col.list_from_array(["x", "y", "z"]))
        (
            ys.to_array(),
            ys.first() ?? -1,
            ys.last() ?? -1,
            zs.to_array(),
            ys.contains(30),
            ys.all({ n -> n >= 10 })
        )
    }
  `);

  assert.deepEqual(mod.test_hashmap(), [3, 3, false, 10, 80]);
  assert.deepEqual(mod.test_treeset(), [
    [2, 3, 4, 5, 6, 7, 9, 10, 11, 12, 13, 14],
    15,
    2,
    14,
    [2, 4, 6],
    [100],
    true,
  ]);
  assert.deepEqual(mod.test_list(), [
    [40, 30, 20, 10],
    40,
    10,
    [[10, "x"], [20, "y"]],
    true,
    true,
  ]);
});

test("18. Iterators (`Iter<T>`) & `for ... in ...` over Array, Dict, List, TreeSet, HashMap, Str, custom `.iter()`, lazy pipelines & colorless async", async () => {
  const { mod } = await runSpl(`
    import col from "std/collections"
    import clock from "std/clock"

    type Range = struct {
        start: Int
        end: Int
    }

    fn Range.iter(self) -> Iter<Int> {
        let mut cur = self.start
        iter_from_fn({ ->
            if cur < self.end {
                let v = cur
                cur = cur + 1
                Some(v)
            } else {
                None
            }
        })
    }

    pub fn test_for_in_all() -> (Int, Int, Array<Int>, Int, Array<Str>, Int) {
        // 1. Array
        let mut arr_sum = 0
        for x in [1, 2, 3, 4] {
            arr_sum = arr_sum + x
        }

        // 2. List<T>
        let list = col.list_from_array([10, 20, 30])
        let mut list_sum = 0
        for x in list {
            list_sum = list_sum + x
        }

        // 3. TreeSet<T> (yields elements in ascending sorted order lazily)
        let set = col.set_from_array([30, 10, 50, 20, 40])
        let mut set_out: Array<Int> = []
        for x in set {
            set_out = set_out.push(x)
        }

        // 4. HashMap<K, V> with tuple pattern destructuring
        let map = col.map_from_entries([("a", 10), ("b", 20), ("c", 30)])
        let mut map_sum = 0
        for (_, v) in map {
            map_sum = map_sum + v
        }

        // 5. Dict<K, V>
        let d = dict_empty().set("x", 1).set("y", 2)
        let mut dict_keys: Array<Str> = []
        for (k, _) in d {
            dict_keys = dict_keys.push(k)
        }

        // 6. Custom user type with .iter() -> Iter<Int>
        let r: Range = { start: 1, end: 6 }
        let mut range_sum = 0
        for n in r {
            range_sum = range_sum + n
        }

        (arr_sum, list_sum, set_out, map_sum, dict_keys, range_sum)
    }

    pub fn test_lazy_iter_pipeline() -> (Array<Int>, Array<(Int, Str)>, Array<Int>, Int, Int, Bool, Bool, Int) {
        // Verify genuine laziness: counter tracks how many elements are actually pulled
        let mut pulled = 0
        let infinite = iter_from_fn({ ->
            pulled = pulled + 1
            Some(pulled)
        })
        let first3_evens = infinite
            .filter({ n -> n % 2 == 0 })
            .map({ n -> n * 10 })
            .take(3)
            .collect()

        // TreeSet lazy take + skip + zip + enumerate + chain + flat_map
        let set = col.set_from_array([5, 1, 4, 2, 3])
        let labels = ["a", "b", "c", "d"]
        let zipped = set.iter().skip(1).zip(labels.iter()).take(3).collect()

        let chained = [1, 2].iter().chain([3, 4].iter()).flat_map({ n -> [n, n * 100].iter() }).collect()
        let found = set.iter().find({ n -> n > 3 }) ?? -1
        let any_big = set.iter().any({ n -> n == 5 })
        let all_pos = set.iter().all({ n -> n > 0 })
        let cnt = col.map_from_entries([("k1", 1), ("k2", 2)]).keys_iter().count()

        (first3_evens, zipped, chained, pulled, found, any_big, all_pos, cnt)
    }

    pub fn test_from_iter_and_async() -> (Array<Int>, Int, Int) {
        let s = col.set_from_iter([4, 2, 4, 1, 3].iter())
        let m = col.map_from_iter([("a", 2), ("b", 3)].iter())
        let l = col.list_from_iter(m.values_iter().map({ v -> v * 10 }))

        // Colorless async inside for-in loop & Iter.fold
        let mut async_sum = 0
        for x in l {
            clock.sleep(1)
            async_sum = async_sum + x
        }
        let fold_sum = [1, 2, 3].iter().fold(0, { acc, n ->
            clock.sleep(1)
            acc + n
        })
        (s.to_array(), async_sum, fold_sum)
    }
  `);

  assert.deepEqual(mod.test_for_in_all(), [10, 60, [10, 20, 30, 40, 50], 60, ["x", "y"], 15]);
  assert.deepEqual(mod.test_lazy_iter_pipeline(), [
    [20, 40, 60],
    [[2, "a"], [3, "b"], [4, "c"]],
    [1, 100, 2, 200, 3, 300, 4, 400],
    6, // pulled ONLY 6 items from infinite iterator to get 3 evens!
    4,
    true,
    true,
    2,
  ]);
  assert.deepEqual(await mod.test_from_iter_and_async(), [[1, 2, 3, 4], 50, 6]);

  // Non-iterable type must fail at compile time
  assert.throws(() => compileSnippet(`for x in 42 { print(x) }`), /not iterable/i);
});

test("19. Ranges (`low..high`, `low..high..step`, inclusive `..=`, countdown & first-class `Iter<Int>`)", async () => {
  const { mod } = await runSpl(`
    pub fn test_ranges(low: Int, high: Int) -> (Array<Int>, Array<Int>, Array<Int>, Array<Int>, Array<Int>, Array<Int>, Int, Array<(Int, Int)>, Bool) {
        // 1. Half-open default step 1: low..high
        let mut r1: Array<Int> = []
        for j in low..high {
            r1 = r1.push(j)
        }

        // 2. Half-open with positive step: low..high..2
        let mut r2: Array<Int> = []
        for j in low..high..2 {
            r2 = r2.push(j)
        }

        // 3. Countdown with negative step: 10..0..-2
        let mut r3: Array<Int> = []
        for j in 10..0..-2 {
            r3 = r3.push(j)
        }

        // 4. Inclusive range with step: 0..=10..2
        let mut r4: Array<Int> = []
        for j in 0..=10..2 {
            r4 = r4.push(j)
        }

        // 5. Empty ranges (start >= end with positive step)
        let mut r5: Array<Int> = []
        for j in 5..2 {
            r5 = r5.push(j)
        }

        // 6. First-class RangeExpr as Iter<Int> (combinators + collect + fold + enumerate)
        let r6 = (low..high..2).map({ x -> x * 10 }).collect()
        let sum = (1..=5).fold(0, { a, b -> a + b })
        let enum_pairs = (10..20..3).enumerate().collect()

        // 7. ?? binds tighter than arithmetic and comparisons so arr.get(j) ?? 0 <= pivot and arr.get(0) ?? 1 + 1 work cleanly!
        let vals = [5, 2, 8]
        let cmp_ok = vals.get(1) ?? 0 <= 3 && vals.get(99) ?? 0 == 0 && vals.get(0) ?? 1 + 1 == 6

        (r1, r2, r3, r4, r5, r6, sum, enum_pairs, cmp_ok)
    }

    pub fn test_zero_step() -> Int {
        let mut n = 0
        for j in 0..5..0 {
            n = n + j
        }
        n
    }
  `);

  assert.deepEqual(mod.test_ranges(2, 9), [
    [2, 3, 4, 5, 6, 7, 8],
    [2, 4, 6, 8],
    [10, 8, 6, 4, 2],
    [0, 2, 4, 6, 8, 10],
    [],
    [20, 40, 60, 80],
    15,
    [[0, 10], [1, 13], [2, 16], [3, 19]],
    true,
  ]);
  assert.throws(() => mod.test_zero_step(), /Range step cannot be 0/);
});

test("20. Mutable Array<T> (`set`, `push`, `pop`, `swap`, `clear`) & in-place Quicksort", async () => {
  const { mod } = await runSpl(`
    fn partition(arr: Array<Int>, low: Int, high: Int) -> Int {
        let pivot = arr.get(high) ?? 0
        let mut i = low - 1
        for j in low..high {
            if arr.get(j) ?? 0 <= pivot {
                i = i + 1
                let temp = arr.get(i) ?? 0
                arr.set(i, arr.get(j) ?? 0)
                arr.set(j, temp)
            }
        }
        let temp = arr.get(i + 1) ?? 0
        arr.set(i + 1, arr.get(high) ?? 0)
        arr.set(high, temp)
        i + 1
    }

    fn qsort(arr: Array<Int>, low: Int, high: Int) -> Unit {
        if low < high {
            let p = partition(arr, low, high)
            qsort(arr, low, p - 1)
            qsort(arr, p + 1, high)
        }
    }

    pub fn test_mutable_array() -> (Array<Int>, Int?, Array<Int>, Int) {
        let nums = [9, 3, 7, 1, 8, 2, 5]
        qsort(nums, 0, nums.len() - 1)

        let buf = [10, 20]
        buf.push(30)
        buf.swap(0, 2)
        let popped = buf.pop()

        let tmp = [1, 2, 3]
        tmp.clear()
        (nums, popped, buf, tmp.len())
    }

    pub fn test_oob() -> Unit {
        let a = [1, 2]
        a.set(5, 99)
        ()
    }
  `);

  assert.deepEqual(mod.test_mutable_array(), [
    [1, 2, 3, 5, 7, 8, 9],
    { $tag: "Some", _0: 10 },
    [30, 20],
    0,
  ]);
  assert.throws(() => mod.test_oob(), /out of bounds/);
});

test("21. Operator precedence table (Pratt parser): **, unary, ??, arithmetic, shifts, bitwise, comparisons, logical & ranges", async () => {
  const { mod } = await runSpl(`
    pub fn test_precedence() -> (Int, Int, Int, Int, Bool, Bool, Bool, Int, Str, Array<Int>) {
        // Multiplicative > Additive
        let a = 1 + 2 * 3 - 4 / 2                // 1 + 6 - 2 = 5
        // Right-associative ** and unary precedence (-2 ** 2 == -4)
        let b = 2 ** 3 ** 2                      // 2 ** 9 = 512
        let c = -2 ** 2                          // -(2 ** 2) = -4
        // ?? tighter than arithmetic & comparisons, looser than unary (-1)
        let arr = [10, 20]
        let d = arr.get(1) ?? 0 - 1              // (20) - 1 = 19
        let e = arr.get(99) ?? -1 == -1          // (-1) == -1 -> true
        // Bitwise tighter than comparisons (no C/JS footgun!)
        let f = 6 & 3 == 2 && 1 | 2 == 3 && 5 ^ 3 == 6
        // Logical: && tighter than ||
        let g = true || false && false           // true || (false && false) = true
        // Shift looser than additive, tighter than bitwise AND
        let h = 1 << 2 + 1 & 15                  // (1 << 3) & 15 = 8
        // String concat with ?? (no parens needed!)
        let opt_s: Str? = None
        let s = "hi " + opt_s ?? "spl"           // "hi " + ("spl") = "hi spl"
        // Result ?? fallback (works on Result<T, E> as well as Option<T>)
        let ok_res: Result<Str, Str> = Ok("ok")
        let err_res: Result<Str, Str> = Err("boom")
        let _r_ok = ok_res ?? "fallback"
        let _r_err = err_res ?? "fallback"
        // Range looser than arithmetic and ??
        let lo: Int? = None
        let hi: Int? = Some(5)
        let r = (lo ?? 1 + 0..hi ?? 10 - 1..2).collect() // (1..4..2) -> [1, 3]
        (a, b, c, d, e, f, g, h, s, r)
    }
  `);

  assert.deepEqual(mod.test_precedence(), [
    5,
    512,
    -4,
    19,
    true,
    true,
    true,
    8,
    "hi spl",
    [1, 3],
  ]);
});

test("22. Type conversions with `as` keyword + Str.chars()/bytes() + FNV-1a hash", async () => {
  const { mod } = await runSpl(`
    pub fn fnv1a_hash(s: String) -> Int {
        let mut hash = 2166136261
        for c in s.chars() {
            hash = hash ^ c as Int
            hash = hash * 16777619
        }
        hash
    }

    pub fn test_casts() -> (Int, Float, Byte, Char, Int, Bool, Str, Int, Float, Str, Array<Int>) {
        let a = 3.9 as Int                  // 3
        let b = 42 as Float                 // 42.0
        let c = 257 as Byte                 // 1
        let d = 65 as Char                  // 'A'
        let e = true as Int + false as Int  // 1
        let f = 1 as Bool && !(0 as Bool)   // true
        let g = 123 as Str                  // "123"
        let h = "42" as Int + 8             // 50
        let i = "2.5" as Float * 2.0        // 5.0
        let j = ("hello" as Bytes) as Str   // "hello"
        let k = (0..4) as Array<Int>        // [0, 1, 2, 3]
        (a, b, c, d, e, f, g, h, i, j, k)
    }
  `);

  assert.deepEqual(mod.test_casts(), [3, 42, 1, "A", 1, true, "123", 50, 5, "hello", [0, 1, 2, 3]]);
  assert.equal(typeof mod.fnv1a_hash("hello"), "number");
  assert.notEqual(mod.fnv1a_hash("hello"), mod.fnv1a_hash("world"));

  // Invalid `as` conversion must fail at compile time
  assert.throws(() => compileSnippet(`type P = struct { x: Int }\nlet p: P = { x: 1 }\nlet n = p as Int`), /Cannot convert/i);
});

test("23. `mut self`, `mut` params, field assignment (`obj.field = v`), and index assignment (`arr[i] = v`)", async () => {
  const { mod } = await runSpl(`
    type Stack<T> = {
        elements: Array<T>
        length: Int
    }

    fn Stack<T>.push(mut self, item: T) {
        self.elements = self.elements.concat([item])
        self.length = self.length + 1
    }

    fn Stack<T>.pop(mut self) -> T? {
        if self.length == 0 {
            None
        } else {
            let popped = self.elements[self.length - 1]
            self.elements = self.elements.slice(0, self.length - 1)
            self.length = self.length - 1
            popped
        }
    }

    fn Stack<T>.peek(self) -> T? {
        if self.length == 0 { None } else { self.elements[self.length - 1] }
    }

    type Inner = { count: Int }
    type Outer = { inner: Inner }

    fn add_to(mut x: Int, y: Int) -> Int {
        x = x + y
        x
    }

    pub fn test_mut_self() -> (Int?, Int?, Int?, Int?, Int, Int, Array<Int>, Int) {
        let mut s: Stack<Int> = { elements: [], length: 0 }
        s.push(10)
        s.push(20)
        let top = s.peek()
        let p1 = s.pop()
        let p2 = s.pop()
        let p3 = s.pop()

        // Nested field assignment on let mut
        let mut o: Outer = { inner: { count: 1 } }
        o.inner.count = o.inner.count + 41

        // Array index assignment
        let nums = [1, 2, 3]
        nums[1] = 99

        // Mutable function parameter rebinding
        let sum = add_to(5, 7)

        (top, p1, p2, p3, s.length, o.inner.count, nums, sum)
    }
  `);

  assert.deepEqual(mod.test_mut_self(), [
    { $tag: "Some", _0: 20 },
    { $tag: "Some", _0: 20 },
    { $tag: "Some", _0: 10 },
    { $tag: "None" },
    0,
    42,
    [1, 99, 3],
    12,
  ]);

  // Compile-time error: mutating self.field in non-mut self method
  assert.throws(
    () =>
      compileSnippet(`
        type Counter = { n: Int }
        fn Counter.inc(self) {
            self.n = self.n + 1
        }
      `),
    /Cannot mutate field 'n' on immutable 'self'/
  );

  // Compile-time error: calling mut self method on immutable variable
  assert.throws(
    () =>
      compileSnippet(`
        type Counter = { n: Int }
        fn Counter.inc(mut self) {
            self.n = self.n + 1
        }
        let c: Counter = { n: 0 }
        c.inc()
      `),
    /Cannot call 'mut self' method 'inc' on immutable 'c'/
  );

  // Compile-time error: mutating field on immutable record binding
  assert.throws(
    () =>
      compileSnippet(`
        type Counter = { n: Int }
        let c: Counter = { n: 0 }
        c.n = 1
      `),
    /Cannot mutate field 'n' on immutable 'c'/
  );

  // Compile-time error: index assignment on immutable Dict
  assert.throws(
    () =>
      compileSnippet(`
        let d: Dict<Str, Int> = dict_empty()
        d["a"] = 1
      `),
    /Cannot mutate Dict via index assignment/
  );
});

test("24. User-defined `reified fn<T>` with `type_schema<T>()`, `decode<T>()`, compound types & erased-param check", async () => {
  const { mod } = await runSpl(`
    type Item = struct { name: Str, qty: Int }

    pub reified fn parse_as<T>(raw: Str) -> Result<T, Str> {
        let j = json_parse(raw)?
        match decode<T>(j) {
            Ok(v) => Ok(v)
            Err(e) => Err(e.path + ": " + e.message)
        }
    }

    pub reified fn schema_of<T>() -> Json {
        type_schema<T>()
    }

    pub reified fn parse_list<T>(raw: Str) -> Result<Array<T>, Str> {
        parse_as<Array<T>>(raw)
    }

    pub fn test_reified() -> (Str, Bool, Int, Str) {
        let ok_item = parse_as<Item>("{\\"name\\":\\"bolts\\",\\"qty\\":12}")
        let bad_item = parse_as<Item>("{\\"name\\":\\"bolts\\",\\"qty\\":\\"twelve\\"}")
        let items = parse_list<Item>("[{\\"name\\":\\"a\\",\\"qty\\":1},{\\"name\\":\\"b\\",\\"qty\\":2}]").unwrap_or([])
        let list_schema = json_stringify(schema_of<Array<Item>>())
        let name = match ok_item {
            Ok(it) => it.name
            Err(_) => ""
        }
        (name, bad_item.is_err(), items.len(), list_schema)
    }
  `);

  const [name, badErr, listLen, listSchema] = mod.test_reified();
  assert.equal(name, "bolts");
  assert.equal(badErr, true);
  assert.equal(listLen, 2);
  const parsedSchema = JSON.parse(listSchema);
  assert.equal(parsedSchema.type, "array");
  assert.equal(parsedSchema.items.title, "Item");
  assert.equal(parsedSchema.items.properties.qty.type, "integer");

  // Plain generic functions (WITHOUT `reified` keyword) also auto-reify `type_schema<T>()` and `decode<T>()`!
  const { mod: autoMod } = await runSpl(`
    type Item = struct { name: Str, qty: Int }

    pub fn auto_schema<T>() -> Str {
        json_stringify(type_schema<T>())
    }

    pub fn auto_decode<T>(raw: Str) -> Result<T, Str> {
        let j = json_parse(raw)?
        match decode<T>(j) {
            Ok(v) => Ok(v)
            Err(e) => Err(e.path + ": " + e.message)
        }
    }

    pub fn run_auto() -> (Str, Str) {
        let s = auto_schema<Item>()
        let res = auto_decode<Item>("{\\"name\\":\\"nuts\\",\\"qty\\":5}")
        let n = match res {
            Ok(it) => it.name
            Err(_) => ""
        }
        (s, n)
    }
  `);
  const [autoSchemaStr, autoItemName] = autoMod.run_auto();
  assert.equal(autoItemName, "nuts");
  assert.equal(JSON.parse(autoSchemaStr).title, "Item");

  // Top-level `?` failure must report a readable error message (never `[object Object]`)
  const cli = path.resolve("dist/cli.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "spl-try-"));
  try {
    const errFile = path.join(tmpDir, "top_err.splx");
    fs.writeFileSync(errFile, `let x = Err("something broke")?\nprint(x)\n`, "utf8");
    assert.throws(
      () => execFileSync(process.execPath, [cli, "run", errFile], { encoding: "utf8", stdio: "pipe" }),
      (e) => {
        const stderr = String(e.stderr ?? "");
        assert.match(stderr, /Unhandled Err from '\?': something broke/);
        assert.doesNotMatch(stderr, /\[object Object\]/);
        return true;
      }
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("25. `newtype`: nominal type safety, constructors, .value, as cast, pattern matching, struct field forwarding, traits & schemas", async () => {
  const { mod } = await runSpl(`
    pub newtype UserId = Int
    pub newtype OrderId = Int

    '' Validated customer email address
    pub newtype Email = Str

    pub newtype Point = struct {
        x: Int '' Horizontal coordinate
        y: Int '' Vertical coordinate
    }

    pub newtype Box<T> = struct {
        item: T
    }

    impl Show for UserId {
        fn show(self) -> Str { "User#" + to_str(self.value) }
    }

    impl Show for OrderId {
        fn show(self) -> Str { "Order#" + to_str(self.value) }
    }

    fn UserId.is_admin(self) -> Bool {
        self.value == 0
    }

    pub fn test_newtypes() -> (Int, Int, Bool, Str, Str, Int, Int, Str, Str, Str) {
        let uid = UserId(42)
        let admin = 0 as UserId
        let oid = OrderId(42)

        // Pattern destructuring in let & exhaustive match
        let UserId(raw_let) = uid
        let raw_match = match uid {
            UserId(n) => n + 1
        }

        // Struct newtype: both constructor and named struct literal, transparent field access & mutation
        let mut p = Point { x: 10, y: 20 }
        p.x = p.x + 5
        let p2 = Point({ x: 1, y: 2 })

        // Generic newtype
        let b = Box({ item: "hello" })

        // Schema & decode on newtype preserves title + '' LLM hint
        let email_schema = json_stringify(type_schema<Email>())
        let decoded_email = match decode<Email>(to_json("ada@spl.dev")) {
            Ok(e) => e.value
            Err(_) => ""
        }

        (
            raw_let,
            raw_match,
            admin.is_admin(),
            uid.show(),
            oid.show(),
            p.x + p2.y,
            uid as Int,
            b.item,
            email_schema,
            decoded_email
        )
    }
  `);

  const [rawLet, rawMatch, isAdmin, uShow, oShow, sumXY, asInt, boxItem, emailSchemaStr, decodedEmail] =
    mod.test_newtypes();
  assert.equal(rawLet, 42);
  assert.equal(rawMatch, 43);
  assert.equal(isAdmin, true);
  assert.equal(uShow, "User#42");
  assert.equal(oShow, "Order#42");
  assert.equal(sumXY, 17);
  assert.equal(asInt, 42);
  assert.equal(boxItem, "hello");
  assert.equal(decodedEmail, "ada@spl.dev");
  const emailSchema = JSON.parse(emailSchemaStr);
  assert.equal(emailSchema.type, "string");
  assert.equal(emailSchema.title, "Email");
  assert.equal(emailSchema.description, "Validated customer email address");

  // Nominal safety: UserId cannot unify with Int or OrderId
  assert.throws(
    () =>
      compileSnippet(`
        newtype UserId = Int
        let x: UserId = 42
      `),
    /Type mismatch/
  );
  assert.throws(
    () =>
      compileSnippet(`
        newtype UserId = Int
        newtype OrderId = Int
        let u = UserId(1)
        let o: OrderId = u
      `),
    /Newtype mismatch/
  );
  assert.throws(
    () =>
      compileSnippet(`
        newtype UserId = Int
        fn take_int(n: Int) -> Int { n }
        let _ = take_int(UserId(5))
      `),
    /Type mismatch/
  );
});

test("26. `typeof` (type-level & runtime TypeInfo) and universal auto-reification across all generic functions", async () => {
  const { mod } = await runSpl(`
    '' A domain user record
    type User = struct {
        /// Primary name
        name: Str '' Full name
        age: Int?
    }

    enum Color { Red, Green, Blue }

    newtype UserId = Int
    newtype OrderId = Int
    newtype Wrapper<T> = struct { inner: T }

    // Type-level typeof
    let default_cfg = { host: "localhost", port: 8080 }
    type Config = typeof default_cfg

    fn get_port(c: typeof default_cfg) -> Int {
        c.port
    }

    // Plain generic fn<T> (NO reified keyword!) using typeof<T>() and typeof(x)
    fn describe<T>(x: T) -> Str {
        typeof(x).name + ":" + typeof<T>().kind + "=" + to_str(x)
    }

    // Implicit HM-polymorphic fn (NO <T> and NO reified keyword!)
    fn kind_of(x) -> Str {
        typeof(x).name + "/" + typeof(x).kind
    }

    // Transitive reification forwarding across plain generic functions
    fn forward_kind(x) -> Str {
        kind_of(x)
    }

    // Compound reified types with typeof<...> inside a plain generic function
    fn compound_types<T>() -> (Str, Str, Str) {
        (typeof<Array<T>>().name, typeof<Wrapper<T>>().name, typeof<T?>().name)
    }

    pub fn test_typeof_and_reification() -> (
        Str, Str, Bool, Bool, Bool,
        Int, Str, Str, Int,
        Str, Str, Str,
        Array<Str>,
        (Str, Str, Str),
        Int
    ) {
        let t_int = typeof(42)
        let t_uid = typeof(UserId(7))
        let t_oid = typeof(OrderId(7))
        let t_user = typeof<User>()
        let t_color = typeof<Color>()

        // Type-level typeof
        let custom_cfg: Config = { host: "0.0.0.0", port: 9090 }
        let port = get_port(custom_cfg)

        // Higher-order passing of auto-reified generic function
        let mapped = [1, 2].map(describe)

        // Function type reflection
        let add = { a: Int, b: Int -> a + b }
        let t_add = typeof(add)

        (
            t_int.name,
            t_uid.underlying ?? "",
            t_int == typeof<Int>(),
            t_uid == t_oid,
            t_uid == t_int,
            t_user.fields.len(),
            t_user.fields.get(0)?.hint ?? "",
            t_color.kind,
            t_color.variants.len(),
            describe(UserId(9)),
            kind_of("hello"),
            forward_kind([1, 2]),
            mapped,
            compound_types<UserId>(),
            port + t_add.params.len()
        )
    }
  `);

  const [
    intName,
    uidUnderlying,
    intEq,
    uidEqOid,
    uidEqInt,
    userFieldCount,
    firstFieldHint,
    colorKind,
    colorVariantCount,
    descUid,
    kindStr,
    fwdArr,
    mapped,
    compounds,
    portPlusParams,
  ] = mod.test_typeof_and_reification();

  assert.equal(intName, "Int");
  assert.equal(uidUnderlying, "Int");
  assert.equal(intEq, true);
  assert.equal(uidEqOid, false);
  assert.equal(uidEqInt, false);
  assert.equal(userFieldCount, 2);
  assert.equal(firstFieldHint, "Full name");
  assert.equal(colorKind, "enum");
  assert.equal(colorVariantCount, 3);
  assert.equal(descUid, "UserId:newtype=9");
  assert.equal(kindStr, "Str/primitive");
  assert.equal(fwdArr, "Array<Int>/array");
  assert.deepEqual(mapped, ["Int:primitive=1", "Int:primitive=2"]);
  assert.deepEqual(compounds, ["Array<UserId>", "Wrapper<UserId>", "UserId?"]);
  assert.equal(portPlusParams, 9092);
});
