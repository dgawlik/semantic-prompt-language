import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  HostRuntime,
  OpenAiClientLike,
  SignatureCatalog,
  compileSource,
  createEmptyCatalog,
  runVm,
  translateProseToSpl,
} from "../src/index.js";

function makeFullCatalog(): SignatureCatalog {
  const cat = createEmptyCatalog();
  cat.models.default = {
    provider: "openai",
    model: "gpt-4.1",
    max_output_tokens: 512,
    temperature: 0,
    strict_schema: true,
  };
  cat.decisions.cls = {
    adapter: "openai_logprobs",
    model: "gpt-4.1-mini",
    top_logprobs: 10,
    temperature: 0,
  };
  cat.fs_roots.ws = {
    permissions: ["read", "write", "append", "exists", "list", "stat"],
    max_file_bytes: 64,
  };
  cat.web.search = { enabled: true, max_results_cap: 2 };
  cat.web.fetch = {
    enabled: true,
    allowed_methods: ["GET", "HEAD"],
    allowed_domains: ["example.com", "*.docs.org"],
    denied_domains: ["secret.docs.org"],
    block_private_ips: true,
    max_redirects: 2,
    max_response_bytes: 16,
  };
  cat.shell_profiles.node_echo = {
    executable: process.execPath,
    base_argv: ["-e", "process.stdout.write(JSON.stringify(process.argv.slice(1))); process.exit(Number(process.argv[2] || 0));"],
    cwd_root: "ws",
    params_schema: {
      type: "object",
      properties: {
        msg: { type: "string" },
        code: { type: "integer" },
      },
      required: ["msg", "code"],
      additionalProperties: false,
    },
    argv_template: ["${msg}", "${code}"],
    env_allowlist: [],
    timeout_ms: 5000,
    max_stdout_bytes: 28,
    max_stderr_bytes: 28,
  };
  cat.js_tools.double_it = {
    params_schema: {
      type: "object",
      properties: { n: { type: "integer" } },
      required: ["n"],
      additionalProperties: false,
    },
    result_schema: {
      type: "object",
      properties: { out: { type: "integer" } },
      required: ["out"],
      additionalProperties: false,
    },
    timeout_ms: 1000,
  };
  cat.mcp_tools.crm = {
    get_tier: {
      params_schema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      },
      result_schema: {
        type: "object",
        properties: { tier: { type: "string", enum: ["free", "pro"] } },
        required: ["tier"],
        additionalProperties: false,
      },
      timeout_ms: 1000,
    },
  };
  return cat;
}

describe("§11.5.6 Effect Boundary Security, OpenAI SDK & Translator Tests", () => {
  it("enforces Virtual FS operations, size limits, path traversal, and symlink escape rejection", async () => {
    const tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), "spl-fs-test-"));
    const wsDir = path.join(tmpBase, "ws");
    const outsideFile = path.join(tmpBase, "secret.txt");
    await fs.mkdir(wsDir, { recursive: true });
    await fs.writeFile(outsideFile, "TOP_SECRET", "utf8");

    // Attempt creating a symlink inside ws pointing outside (skip symlink check if OS denies symlink creation)
    let symlinkCreated = false;
    try {
      await fs.symlink(outsideFile, path.join(wsDir, "escape.txt"));
      symlinkCreated = true;
    } catch {
      symlinkCreated = false;
    }

    try {
      const catalog = makeFullCatalog();
      const src = `
        fn tryRead(p: string) -> string {
          try {
            return fs.read("ws", p);
          } catch (err) {
            return "ERR:" + err.code;
          }
        }

        fn main() -> {
          ok: string,
          ex: bool,
          listed: list<string>,
          sz: int,
          trav: string,
          abs: string,
          tooBig: string,
          sym: string
        } {
          fs.write("ws", "b.txt", "hello");
          fs.append("ws", "b.txt", " world");
          fs.write("ws", "a.txt", "first");
          let st = fs.stat("ws", "b.txt");
          let mut tooBig = "ok";
          try {
            fs.write("ws", "big.txt", "0123456789012345678901234567890123456789012345678901234567890123456789");
          } catch (err) {
            tooBig = err.code;
          }
          return {
            ok: fs.read("ws", "b.txt"),
            ex: fs.exists("ws", "a.txt"),
            listed: fs.list("ws", "."),
            sz: st.size_bytes,
            trav: tryRead("../secret.txt"),
            abs: tryRead("/etc/passwd"),
            tooBig: tooBig,
            sym: tryRead("escape.txt")
          };
        }
      `;
      const compiled = compileSource(src, catalog);
      const host = new HostRuntime({ catalog, fsRootMounts: { ws: wsDir } });
      const trace = await runVm({ bytecode: compiled.text, catalog, dispatcher: host });

      assert.equal(trace.result.status, "ok");
      const val = trace.result.value as Record<string, unknown>;
      assert.equal(val.ok, "hello world");
      assert.equal(val.ex, true);
      assert.equal(val.sz, 11n);
      assert.equal(val.trav, "ERR:POLICY_DENIED");
      assert.equal(val.abs, "ERR:POLICY_DENIED");
      assert.equal(val.tooBig, "FS_LIMIT_EXCEEDED");
      assert.ok((val.listed as string[]).includes("a.txt"));
      assert.ok((val.listed as string[]).includes("b.txt"));
      if (symlinkCreated) {
        assert.equal(val.sym, "ERR:POLICY_DENIED");
      }
    } finally {
      await fs.rm(tmpBase, { recursive: true, force: true });
    }
  });

  it("enforces web.fetch domain policies, SSRF private-IP & redirect checks, truncation, and web.search caps", async () => {
    const catalog = makeFullCatalog();
    const src = `
      fn tryFetch(u: string) -> string {
        try {
          let r = web.fetch(u);
          return r.body + "|" + (r.truncated ? "T" : "F");
        } catch (err) {
          return "ERR:" + err.code;
        }
      }
      fn main() -> {
        okBody: string,
        okTrunc: bool,
        deniedDom: string,
        disallowedDom: string,
        ssrfLoopback: string,
        ssrfDns: string,
        ssrfRedir: string,
        searchLen: int
      } {
        let r = web.fetch("https://api.docs.org/page");
        let mut deniedDom = "";
        try { web.fetch("https://secret.docs.org/x"); } catch (e) { deniedDom = e.code; }
        let mut disallowedDom = "";
        try { web.fetch("https://evil.com/x"); } catch (e) { disallowedDom = e.code; }
        let mut ssrfLoopback = "";
        try { web.fetch("http://127.0.0.1/admin"); } catch (e) { ssrfLoopback = e.code; }
        let mut ssrfDns = "";
        try { web.fetch("https://example.com/private-dns"); } catch (e) { ssrfDns = e.code; }
        let mut ssrfRedir = "";
        try { web.fetch("https://redir.docs.org/go"); } catch (e) { ssrfRedir = e.code; }
        let sr = web.search("spl", { max_results: 10 });
        return {
          okBody: r.body,
          okTrunc: r.truncated,
          deniedDom: deniedDom,
          disallowedDom: disallowedDom,
          ssrfLoopback: ssrfLoopback,
          ssrfDns: ssrfDns,
          ssrfRedir: ssrfRedir,
          searchLen: len(sr)
        };
      }
    `;
    // Note: SPL v5 does not have ternary operator `?:`, remove unused tryFetch helper cleanly
    const cleanSrc = src.replace(/fn tryFetch[\s\S]*?fn main/, "fn main");
    const compiled = compileSource(cleanSrc, catalog);

    const host = new HostRuntime({
      catalog,
      webDnsLookup: async (hostname) => {
        if (hostname === "example.com") return [{ address: "10.0.0.5", family: 4 }];
        return [{ address: "93.184.216.34", family: 4 }];
      },
      webFetchFn: async (input) => {
        const u = String(input);
        if (u.includes("redir.docs.org")) {
          return new Response(null, { status: 302, headers: { Location: "http://169.254.169.254/latest/meta-data" } });
        }
        return new Response("0123456789ABCDEF_EXTRA_BYTES", {
          status: 200,
          headers: { "Content-Type": "text/plain", "X-Custom": "1" },
        });
      },
      webSearchProvider: async () => [
        { title: "A", url: "https://example.com/1", snippet: "s1" },
        { title: "B", url: "https://example.com/2", snippet: "s2" },
        { title: "C", url: "https://example.com/3", snippet: "s3" },
      ],
    });

    const trace = await runVm({ bytecode: compiled.text, catalog, dispatcher: host });
    assert.equal(trace.result.status, "ok");
    assert.deepStrictEqual(trace.result.value, {
      deniedDom: "POLICY_DENIED",
      disallowedDom: "POLICY_DENIED",
      okBody: "0123456789ABCDEF",
      okTrunc: true,
      searchLen: 2n,
      ssrfDns: "POLICY_DENIED",
      ssrfLoopback: "POLICY_DENIED",
      ssrfRedir: "POLICY_DENIED",
    });
  });

  it("runs shell.run via argv-only execFile without shell interpolation, returning non-zero exit code & truncation", async () => {
    const tmpWs = await fs.mkdtemp(path.join(os.tmpdir(), "spl-shell-test-"));
    try {
      const catalog = makeFullCatalog();
      const src = `
        fn main() -> { code: int, out: string, trunc: bool } {
          let r = shell.run("node_echo", { msg: "safe; echo INJECTED && rm -rf /", code: 3 });
          return { code: r.exit_code, out: r.stdout, trunc: r.truncated };
        }
      `;
      const compiled = compileSource(src, catalog);
      const host = new HostRuntime({ catalog, fsRootMounts: { ws: tmpWs } });
      const trace = await runVm({ bytecode: compiled.text, catalog, dispatcher: host });

      assert.equal(trace.result.status, "ok");
      const v = trace.result.value as { code: bigint; out: string; trunc: boolean };
      assert.equal(v.code, 3n);
      assert.equal(v.trunc, true);
      assert.ok(v.out.includes('["safe; echo INJECTED'));
    } finally {
      await fs.rm(tmpWs, { recursive: true, force: true });
    }
  });

  it("runs OpenAI model.decide (logprobs + min_confidence + scores), model.ask<T> (wrap/unwrap + schema rejection), JS & MCP tools", async () => {
    const catalog = makeFullCatalog();
    const seenParams: Record<string, unknown>[] = [];

    const mockClient: OpenAiClientLike = {
      responses: {
        async create(params) {
          seenParams.push(params);
          const inputArr = params.input as Array<{ content: string }>;
          const prompt = inputArr[inputArr.length - 1].content;
          if (prompt.includes("BAD_JSON")) {
            return { id: "resp_bad", output_text: '{"wrong_key": 123}' };
          }
          if (prompt.includes("NUMBERS")) {
            // Non-object schema list<int> is wrapped in { value: [...] }
            return { id: "resp_list", output_text: '{"value":[10,20,30]}' };
          }
          return { id: "resp_ok", output_text: "hello from responses" };
        },
      },
      chat: {
        completions: {
          async create(params) {
            seenParams.push(params);
            const msgs = params.messages as Array<{ content: string }>;
            const userMsg = msgs[msgs.length - 1].content;
            if (userMsg.includes("UNCERTAIN")) {
              return {
                id: "chat_unc",
                choices: [
                  {
                    message: { content: "A" },
                    logprobs: {
                      content: [
                        {
                          token: "A",
                          logprob: Math.log(0.55),
                          top_logprobs: [
                            { token: "A", logprob: Math.log(0.55) },
                            { token: "B", logprob: Math.log(0.45) },
                          ],
                        },
                      ],
                    },
                  },
                ],
              };
            }
            return {
              id: "chat_hi",
              choices: [
                {
                  message: { content: "B" },
                  logprobs: {
                    content: [
                      {
                        token: "B",
                        logprob: Math.log(0.9),
                        top_logprobs: [
                          { token: "B", logprob: Math.log(0.9) },
                          { token: "A", logprob: Math.log(0.1) },
                        ],
                      },
                    ],
                  },
                },
              ],
            };
          },
        },
      },
    };

    const src = `
      fn main() -> {
        d1: string,
        d2: string,
        nums: list<int>,
        badErr: string,
        jsOut: int,
        mcpTier: string
      } {
        let d1 = model.decide("cls", "CERTAIN", ["yes", "no"]);
        let d2 = model.decide("cls", "UNCERTAIN", ["yes", "no"], { min_confidence: 0.8 }) ?? "abstain";
        let nums = model.ask<list<int>>("default", "NUMBERS");
        let mut badErr = "none";
        try {
          let x = model.ask<{ ok: int }>("default", "BAD_JSON");
          badErr = \`\${x.ok}\`;
        } catch (err) {
          badErr = err.code;
        }
        let j = tool.double_it({ n: 21 });
        let m = mcp.crm.get_tier({ id: "u1" });
        return {
          d1: d1,
          d2: d2,
          nums: nums,
          badErr: badErr,
          jsOut: j.out,
          mcpTier: m.tier
        };
      }
    `;

    const compiled = compileSource(src, catalog);
    const host = new HostRuntime({
      catalog,
      openaiClient: mockClient,
      jsTools: {
        double_it: (args) => ({ out: (args.n as bigint) * 2n }),
      },
      mcpHandler: async (server, tool, args) => {
        assert.equal(server, "crm");
        assert.equal(tool, "get_tier");
        assert.equal(args.id, "u1");
        return { tier: "pro" };
      },
    });

    const trace = await runVm({ bytecode: compiled.text, catalog, dispatcher: host });
    assert.equal(trace.result.status, "ok");
    assert.deepStrictEqual(trace.result.value, {
      badErr: "MODEL_SCHEMA_ERROR",
      d1: "no",
      d2: "abstain",
      jsOut: 42n,
      mcpTier: "pro",
      nums: [10n, 20n, 30n],
    });

    // Verify Decision API scores recorded in trace & sum to 1.0
    const decideRec = trace.effects[0];
    assert.equal(decideRec.kind, "model.decide");
    assert.equal(decideRec.outcome.status, "ok");
    const scores = decideRec.outcome.decision_scores!;
    assert.ok(Math.abs(scores.yes + scores.no - 1.0) < 1e-9);
    assert.ok(scores.no > 0.89);

    // Verify §11.1 explicit SDK parameters passed (never relying on defaults)
    assert.ok(seenParams.every((p) => p.store === false && p.temperature === 0));
  });

  it("executes §2 Lark CFG translator bounded compile-repair loop", async () => {
    const catalog = makeFullCatalog();
    let callNum = 0;

    const mockClient: OpenAiClientLike = {
      responses: {
        async create(params) {
          callNum++;
          // Verify Lark CFG custom tool is explicitly passed
          const tools = params.tools as Array<{ type: string; format: { syntax: string } }>;
          assert.equal(tools[0].type, "custom");
          assert.equal(tools[0].format.syntax, "lark");

          if (callNum === 1) {
            // Syntactically valid SPL, but type error (int + float)
            return {
              output: [{ type: "custom_tool_call", name: "emit_spl", input: "fn main() -> float { return 1 + 2.5; }" }],
            };
          }
          // Attempt 2: repaired after receiving structured diagnostic
          const msgs = params.input as Array<{ content: string }>;
          assert.ok(msgs.some((m) => m.content.includes("E_TYPE_MISMATCH")));
          return {
            output: [
              { type: "custom_tool_call", name: "emit_spl", input: "fn main() -> float { return (1 as float) + 2.5; }" },
            ],
          };
        },
      },
      chat: { completions: { async create() { throw new Error("unused"); } } },
    };

    const res = await translateProseToSpl({
      prose: "Add 1 and 2.5 and return a float",
      catalog,
      client: mockClient,
      model: "gpt-4.1",
      maxAttempts: 3,
    });

    assert.equal(res.attempts, 2);
    assert.equal(res.diagnosticsHistory.length, 1);
    assert.equal(res.diagnosticsHistory[0][0].code, "E_TYPE_MISMATCH");

    const trace = await runVm({ bytecode: res.compiled.text, catalog });
    assert.equal(trace.result.status, "ok");
    assert.equal(trace.result.value, 3.5);
  });
});
