import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import { pathToFileURL } from "node:url";
import { compileFile } from "../dist/index.js";

async function runSpl(source) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "spl-llm-"));
  const srcPath = path.join(tmpDir, "main.splx");
  fs.writeFileSync(srcPath, source, "utf8");
  try {
    const outDir = path.join(tmpDir, "out");
    const res = compileFile(srcPath, outDir);
    return await import(`${pathToFileURL(res.entryOutPath).href}?t=${Date.now()}_${Math.random()}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function startMockLlmServer() {
  const recorded = [];
  let agentTurnCount = 0;

  const server = http.createServer((req, res) => {
    res.setHeader("connection", "close");
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      recorded.push({ url: req.url, headers: req.headers, body });

      // 1. OpenAI Responses API (/v1/responses)
      if (req.url === "/v1/responses") {
        // Non-object wrapped schema (e.g. Array<Str> -> { result: [...] })
        if (body.text?.format?.schema?.properties?.result) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              status: "completed",
              output: [
                { type: "message", content: [{ type: "output_text", text: '{"result":["alpha","beta"]}' }] },
              ],
              usage: { input_tokens: 8, output_tokens: 6, total_tokens: 14 },
            })
          );
          return;
        }
        if (body.stream) {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write(`event: response.reasoning_summary_text.delta\ndata: ${JSON.stringify({ delta: "plan..." })}\n\n`);
          res.write(`event: response.reasoning_text.delta\ndata: ${JSON.stringify({ delta: "raw-thought" })}\n\n`);
          res.write(`event: response.output_text.delta\ndata: ${JSON.stringify({ delta: '{"answer":' })}\n\n`);
          res.write(`event: response.output_text.delta\ndata: ${JSON.stringify({ delta: '42}' })}\n\n`);
          res.write(
            `event: response.completed\ndata: ${JSON.stringify({
              response: { status: "completed", usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20 } },
            })}\n\n`
          );
          res.end();
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            status: "completed",
            output: [
              { type: "reasoning", summary: [{ text: "thought" }] },
              { type: "message", content: [{ type: "output_text", text: '{"answer":42}' }] },
            ],
            usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          })
        );
        return;
      }

      // 2. OpenAI Chat Completions API (/v1/chat/completions)
      if (req.url === "/v1/chat/completions") {
        if (body.stream) {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "hmm" } }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "Hello " } }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "Chat!" }, finish_reason: "stop" }], usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 } })}\n\n`);
          res.write(`data: [DONE]\n\n`);
          res.end();
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [{ finish_reason: "stop", message: { content: "Hello Chat!", reasoning_content: "hmm" } }],
            usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 },
          })
        );
        return;
      }

      // 3. Anthropic Messages API (/v1/messages)
      if (req.url === "/v1/messages") {
        // Multi-turn agent test uses tools
        if (body.tools && body.tools.length > 0) {
          const lastUser = body.messages[body.messages.length - 1];
          const hasToolResults =
            Array.isArray(lastUser?.content) && lastUser.content.some((b) => b.type === "tool_result");
          if (!hasToolResults) {
            agentTurnCount++;
            res.writeHead(200, { "content-type": "application/json" });
            res.end(
              JSON.stringify({
                stop_reason: "tool_use",
                content: [
                  { type: "thinking", thinking: "Let me multiply and check db." },
                  { type: "text", text: "Calling tools..." },
                  { type: "tool_use", id: "tu_1", name: "multiply", input: { a: 2, b: 3 } },
                  { type: "tool_use", id: "tu_2", name: "delete_db", input: { confirm: true } },
                ],
                usage: { input_tokens: 40, output_tokens: 25 },
              })
            );
            return;
          }
          // Turn 2: inspect tool_result messages and produce final answer
          const toolResults = Array.isArray(lastUser.content) ? lastUser.content : [];
          const calcRes = JSON.parse(toolResults[0].content);
          const delRes = JSON.parse(toolResults[1].content);
          const wantsJson = body.output_config?.format?.type === "json_schema";
          const finalText = wantsJson
            ? JSON.stringify({ product: calcRes.product, blocked: delRes.error })
            : `Result=${calcRes.product}; Blocked=${delRes.error}`;
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              stop_reason: "end_turn",
              content: [
                {
                  type: "text",
                  text: finalText,
                },
              ],
              usage: { input_tokens: 60, output_tokens: 15 },
            })
          );
          return;
        }

        if (body.stream) {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write(`event: message_start\ndata: ${JSON.stringify({ message: { usage: { input_tokens: 15 } } })}\n\n`);
          res.write(`event: content_block_delta\ndata: ${JSON.stringify({ index: 0, delta: { type: "thinking_delta", thinking: "deep" } })}\n\n`);
          res.write(`event: content_block_delta\ndata: ${JSON.stringify({ index: 1, delta: { type: "text_delta", text: "Claude OK" } })}\n\n`);
          res.write(`event: message_delta\ndata: ${JSON.stringify({ delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } })}\n\n`);
          res.end();
          return;
        }

        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            stop_reason: "end_turn",
            content: [
              { type: "thinking", thinking: "deep" },
              { type: "text", text: "Claude OK" },
            ],
            usage: { input_tokens: 15, output_tokens: 7 },
          })
        );
        return;
      }

      // 4. Google Gemini API (/v1beta/models/...:generateContent or :streamGenerateContent?alt=sse)
      if (req.url && req.url.startsWith("/v1beta/models/")) {
        if (req.url.includes("streamGenerateContent")) {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write(
            `data: ${JSON.stringify({
              candidates: [{ content: { parts: [{ thought: true, text: "gem-think" }] } }],
            })}\n\n`
          );
          res.write(
            `data: ${JSON.stringify({
              candidates: [{ content: { parts: [{ text: "Gemini OK" }] }, finishReason: "STOP" }],
              usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 6, totalTokenCount: 17 },
            })}\n\n`
          );
          res.end();
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            candidates: [{ content: { parts: [{ thought: true, text: "gem-think" }, { text: "Gemini OK" }] }, finishReason: "STOP" }],
            usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 6, totalTokenCount: 17 },
          })
        );
        return;
      }

      // 5. OpenAI Decisions API (/v1/decisions)
      if (req.url === "/v1/decisions") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            model: body.model,
            answers: [
              { name: "needs_refund", type: "predicate", probability: 0.96, confidence: 0.94 },
              {
                name: "department",
                type: "choice",
                choice: "billing",
                probabilities: [
                  { value: "billing", probability: 0.91 },
                  { value: "shipping", probability: 0.05 },
                  { value: "other", probability: 0.04 },
                ],
                confidence: 0.89,
              },
              {
                name: "urgency",
                type: "score",
                score: 1.75,
                probabilities: [
                  { value: "low", probability: 0.05 },
                  { value: "medium", probability: 0.15 },
                  { value: "high", probability: 0.80 },
                ],
                confidence: 0.87,
              },
            ],
            usage: { input_tokens: 38, output_tokens: 0, total_tokens: 38 },
          })
        );
        return;
      }

      // 6. Google Gemini Decisions API (/v1beta/decisions)
      if (req.url === "/v1beta/decisions") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            answers: {
              needs_refund: { value: true, probability: 0.984, confidence: 0.991 },
              department: {
                value: "billing",
                probabilities: { billing: 0.92, shipping: 0.05, other: 0.03 },
                confidence: 0.945,
              },
              urgency: {
                value: 2,
                probabilities: { "0": 0.04, "1": 0.12, "2": 0.84 },
                confidence: 0.91,
              },
            },
            usage_metadata: { input_token_count: 42, output_token_count: 0, total_token_count: 42 },
          })
        );
        return;
      }

      res.writeHead(404);
      res.end("Not found");
    });
  });

  return {
    server,
    recorded,
    resetTurns: () => { agentTurnCount = 0; },
    listen: () =>
      new Promise((resolve) => {
        server.unref();
        server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`));
      }),
  };
}

test("std/llm: parameterized ask<T> across all 4 providers (typed struct, inferred type, Array<Str> wrapper, plain Str, and ask_raw)", async () => {
  const mock = startMockLlmServer();
  const baseUrl = await mock.listen();

  try {
    const mod = await runSpl(`
      import llm from "std/llm"

      type Answer = struct {
          answer: Int '' Final numeric answer
      }

      pub fn run_providers(base: Str) -> Result<(Int, Int, Array<Str>, Str, Str, Str, Array<Str>, Str), Str> {
          let mut streamed: Array<Str> = []
          let img: llm.Attachment = {
              kind: "image_base64",
              mime_type: "image/png",
              data: "iVBORw0KGgo=",
              name: Some("chart.png")
          }

          // 1. OpenAI Responses: explicit @{ ... }.ask<Answer> — NO manual json_schema or decode needed!
          let r1 = @{
              What is the answer?
          }.ask<Answer>(
              provider: "openai_responses",
              api_key: "sk-openai",
              base_url: Some(base + "/v1"),
              model: "o4-mini",
              system: Some("Be concise"),
              max_tokens: Some(256),
              thinking_effort: Some("high"),
              attachments: [img],
              // Passing on_delta: Some(...) automatically enables streaming even without stream: true
              on_delta: Some({ d ->
                  match d {
                      llm.SummaryDelta(s) => { streamed = streamed.push("summary:" + s) }
                      llm.ThinkingDelta(t) => { streamed = streamed.push("thinking:" + t) }
                      llm.TextDelta(t) => { streamed = streamed.push("text:" + t) }
                      llm.ToolCallDelta(_, _, _) => ()
                      llm.DoneDelta => ()
                  }
              })
          )?

          // 1b. Type inferred from let annotation (no explicit <Answer> needed!)
          let r1_inferred: Answer = @{
              Infer the return schema
          }.ask(
              provider: "openai_responses",
              api_key: "sk-openai",
              base_url: Some(base + "/v1"),
              model: "o4-mini"
          )?

          // 1c. Non-object root type Array<Str> — auto-wrapped as { result: [...] } and unwrapped!
          let r1_arr = @{
              Return two tags
          }.ask<Array<Str>>(
              provider: "openai_responses",
              api_key: "sk-openai",
              base_url: Some(base + "/v1"),
              model: "o4-mini"
          )?

          // 2. OpenAI Chat Completions: @{ ... }.ask<Str> — returns plain Str directly, no json_schema sent!
          let r2 = @{
              Say hi
          }.ask<Str>(
              provider: "openai_chat",
              api_key: "sk-chat",
              base_url: Some(base + "/v1"),
              model: "gpt-5-mini",
              max_tokens: Some(128),
              thinking_effort: Some("low"),
              attachments: [img],
              stream: true
          )?

          // 3. Anthropic Messages: @{ ... }.ask<Str> — returns plain Str directly
          let r3 = @{
              Check attachment
          }.ask<Str>(
              provider: "anthropic",
              api_key: "sk-ant",
              base_url: Some(base),
              model: "claude-sonnet-4-5",
              max_tokens: Some(512),
              thinking_effort: Some("medium"),
              attachments: [img],
              stream: true
          )?

          // 4. Google Gemini: @{ ... }.ask<Str> — returns plain Str directly (and no responseSchema)
          let r4 = @{
              Analyze image
          }.ask<Str>(
              provider: "google",
              api_key: "AIza-test",
              base_url: Some(base),
              model: "gemini-2.5-pro",
              max_tokens: Some(512),
              thinking_effort: Some("medium"),
              attachments: [img],
              stream: true
          )?

          // 5. llm.ask_raw still returns full LlmResponse with thinking/usage metadata
          let raw = llm.ask_raw(
              provider: "openai_responses",
              api_key: "sk-openai",
              base_url: Some(base + "/v1"),
              model: "o4-mini",
              stream: true
          ) @{
              Raw turn
          }?

          Ok((r1.answer, r1_inferred.answer, r1_arr, r2, r3, r4, streamed, raw.thinking ?? ""))
      }
    `);

    const res = await mod.run_providers(baseUrl);
    assert.equal(res.$tag, "Ok");
    const [answer, inferredAnswer, arrVal, chatText, antText, gemText, streamed, rawThink] = res._0;

    assert.equal(answer, 42);
    assert.equal(inferredAnswer, 42);
    assert.deepEqual(arrVal, ["alpha", "beta"]);
    assert.equal(chatText, "Hello Chat!");
    assert.equal(antText, "Claude OK");
    assert.equal(gemText, "Gemini OK");
    assert.equal(rawThink, "plan...raw-thought");
    assert.deepEqual(streamed, ["summary:plan...", "thinking:raw-thought", 'text:{"answer":', "text:42}"]);

    // Verify provider wire headers & payloads
    const [oaiResp, oaiInf, oaiArr, oaiChat, anth, goog] = mock.recorded;
    assert.equal(oaiResp.headers.authorization, "Bearer sk-openai");
    assert.equal(oaiResp.body.reasoning.effort, "high");
    assert.equal(oaiResp.body.text.format.type, "json_schema");
    assert.equal(oaiResp.body.text.format.schema.properties.answer.type, "integer");
    assert.equal(oaiResp.body.input[0].content[1].type, "input_image");

    // Inferred `let r1_inferred: Answer = llm.ask(...)` also auto-sent json_schema!
    assert.equal(oaiInf.body.text.format.type, "json_schema");
    assert.equal(oaiInf.body.text.format.schema.properties.answer.type, "integer");

    // Non-object `Array<Str>` auto-wrapped into `{ result: { type: "array", items: { type: "string" } } }`
    assert.equal(oaiArr.body.text.format.type, "json_schema");
    assert.equal(oaiArr.body.text.format.schema.type, "object");
    assert.equal(oaiArr.body.text.format.schema.properties.result.type, "array");

    // `ask<Str>` sent NO json_schema / response_format / responseSchema!
    assert.equal(oaiChat.body.reasoning_effort, "low");
    assert.equal(oaiChat.body.max_completion_tokens, 128);
    assert.equal(oaiChat.body.response_format, undefined);

    assert.equal(anth.headers["x-api-key"], "sk-ant");
    assert.equal(anth.body.thinking.budget_tokens, 4096);
    assert.equal(anth.body.messages[0].content[0].type, "image");
    assert.equal(anth.body.output_config, undefined);

    assert.equal(goog.headers["x-goog-api-key"], "AIza-test");
    assert.equal(goog.body.generationConfig.thinkingConfig.thinkingBudget, 4096);
    assert.equal(goog.body.generationConfig.responseMimeType, undefined);
    assert.equal(goog.body.generationConfig.responseSchema, undefined);
    assert.equal(goog.body.contents[0].parts[1].inlineData.mimeType, "image/png");
  } finally {
    mock.server.closeAllConnections?.();
    mock.server.close();
  }
});

test("std/llm + std/traces: ordered TraceEvent enum array, JSONL save/load, and deterministic agent_replay<T>", async () => {
  const mock = startMockLlmServer();
  const baseUrl = await mock.listen();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "spl-trace-"));
  const tracePath = path.join(tmpDir, "agent_run.jsonl");

  try {
    const mod = await runSpl(`
      import llm, { Approve, Reject, Modify } from "std/llm"
      import traces, {
          UserPrompt,
          ThinkingStep,
          AssistantText,
          ToolCallStep,
          ToolDecisionStep,
          ToolResultStep,
          TurnCompleted
      } from "std/traces"

      type MulArgs = struct {
          a: Int '' Left operand
          b: Int '' Right operand
      }

      type MulOut = struct {
          product: Int '' Product of a and b
      }

      type DelArgs = struct {
          confirm: Bool '' Confirmation flag
      }

      type DelOut = struct {
          deleted: Bool '' Whether deletion succeeded
      }

      type AgentReport = struct {
          product: Int '' Computed product
          blocked: Str '' Error message from blocked tool
      }

      // Explicit type arguments: llm.tool<MulArgs, MulOut>
      fn make_calc_tool() -> llm.AgentTool<MulArgs, MulOut> {
          llm.tool<MulArgs, MulOut>(
              name: "multiply",
              description: "Multiplies two integers"
          ) { args ->
              Ok({ product: args.a * args.b })
          }
      }

      // Inferred type arguments from return type llm.AgentTool<DelArgs, DelOut>
      fn make_danger_tool() -> llm.AgentTool<DelArgs, DelOut> {
          llm.tool(
              name: "delete_db",
              description: "Deletes database"
          ) { _ ->
              Ok({ deleted: true })
          }
      }

      // Tool with Str output: returns plain Str directly (no extra JSON quotes)
      fn make_greet_tool() -> llm.AgentTool<MulArgs, Str> {
          llm.tool<MulArgs, Str>(
              name: "format_mul",
              description: "Formats multiplication"
          ) { args ->
              Ok(to_str(args.a) + "x" + to_str(args.b))
          }
      }

      pub fn test_tool_direct() -> Result<(Int, Str, Bool, Str), Str> {
          let calc = make_calc_tool()
          let direct = calc.run({ a: 3, b: 4 })?

          let greet = make_greet_tool()
          let plain_out = greet.run_raw(to_json({ a: 5, b: 6 }))?

          // Invalid arguments should be rejected automatically by reified decode
          let bad_rejected = match calc.run_raw(to_json({ a: "oops", b: 2 })) {
              Ok(_) => false
              Err(_) => true
          }

          Ok((direct.product, plain_out, bad_rejected, json_stringify(calc.parameters)))
      }

      fn make_tools() -> Array<llm.AnyTool> {
          [make_calc_tool().any(), make_danger_tool().any()]
      }

      pub fn run_agent_and_save(
          base: Str,
          out_path: Str
      ) -> Result<(Str, Int, Int, Int, Array<Str>, Array<(Str, Str)>), Str> {
          let (final_text, trace) = @{
              Multiply numbers and check DB.
          }.agent<Str>(
              provider: "anthropic",
              api_key: "sk-ant-agent",
              base_url: Some(base),
              model: "claude-sonnet-4-5",
              thinking_effort: Some("low"),
              tools: make_tools(),
              on_decision: Some({ req ->
                  if req.tool_call.name == "delete_db" {
                      Reject("policy-blocked")
                  } else if req.tool_call.name == "multiply" {
                      Modify(to_json({ a: 6, b: 7 }))
                  } else {
                      Approve
                  }
              })
          )?

          // Save trace to JSONL file via std/traces
          traces.save_jsonl(out_path, trace)?

          let kinds = trace.events.map { ev -> ev.kind_name() }
          let mut decisions: Array<(Str, Str)> = []
          let mut i = 0
          while i < trace.events.len() {
              match trace.events.get(i) {
                  Some(ToolDecisionStep(_, _, name, dec, _)) => {
                      decisions = decisions.push((name, dec))
                  }
                  _ => ()
              }
              i = i + 1
          }
          Ok((final_text, trace.turns, trace.total_input_tokens, trace.total_output_tokens, kinds, decisions))
      }

      pub fn run_agent_typed(base: Str) -> Result<(Int, Str, Int), Str> {
          let (report, trace) = @{
              Multiply numbers and report structured output.
          }.agent<AgentReport>(
              provider: "anthropic",
              api_key: "sk-ant-agent",
              base_url: Some(base),
              model: "claude-sonnet-4-5",
              tools: make_tools(),
              on_decision: Some({ req ->
                  if req.tool_call.name == "delete_db" {
                      Reject("policy-blocked")
                  } else if req.tool_call.name == "multiply" {
                      Modify(to_json({ a: 6, b: 7 }))
                  } else {
                      Approve
                  }
              })
          )?
          Ok((report.product, report.blocked, trace.turns))
      }

      // Replay 1: Full deterministic replay from loaded JSONL (0 LLM calls, 0 tool executions)
      pub fn replay_full(base: Str, path: Str) -> Result<(Str, Int), Str> {
          let loaded = traces.load_jsonl(path)?
          let (ans, t) = llm.agent_replay<Str>(
              trace: loaded,
              up_to_step: loaded.step_count(),
              provider: "anthropic",
              api_key: "sk-ant-agent",
              base_url: Some(base),
              model: "claude-sonnet-4-5"
          )?
          Ok((ans, t.step_count()))
      }

      // Replay 2: Replay Turn 1 deterministically (up_to_step = 10, right after TurnCompleted(1)),
      // then resume live at Turn 2 with a DIFFERENT output type AgentReport!
      pub fn replay_from_turn_boundary(base: Str, path: Str) -> Result<(Int, Str, Int, Int), Str> {
          let loaded = traces.load_jsonl(path)?
          let (report, t) = llm.agent_replay<AgentReport>(
              trace: loaded,
              up_to_step: 10,
              provider: "anthropic",
              api_key: "sk-ant-agent",
              base_url: Some(base),
              model: "claude-sonnet-4-5",
              tools: make_tools()
          )?
          Ok((report.product, report.blocked, t.turns, t.step_count()))
      }

      // Replay 3: Mid-turn replay up_to_step = 5 (right after Turn 1's ToolCallSteps, BEFORE tools run),
      // then execute tools live with a DIFFERENT Modify(10, 10) decision -> product = 100!
      pub fn replay_mid_turn_fork(base: Str, path: Str) -> Result<(Int, Str, Int), Str> {
          let loaded = traces.load_jsonl(path)?
          let (report, t) = llm.agent_replay<AgentReport>(
              trace: loaded,
              up_to_step: 5,
              provider: "anthropic",
              api_key: "sk-ant-agent",
              base_url: Some(base),
              model: "claude-sonnet-4-5",
              tools: make_tools(),
              on_decision: Some({ req ->
                  if req.tool_call.name == "delete_db" {
                      Reject("fork-blocked")
                  } else if req.tool_call.name == "multiply" {
                      Modify(to_json({ a: 10, b: 10 }))
                  } else {
                      Approve
                  }
              })
          )?
          Ok((report.product, report.blocked, t.turns))
      }
    `);

    // 1. Direct typed tool execution, Str output without extra JSON quotes, auto-validation & auto-schema
    const directRes = await mod.test_tool_direct();
    assert.equal(directRes.$tag, "Ok");
    const [directProduct, plainOut, badRejected, schemaJson] = directRes._0;
    assert.equal(directProduct, 12);
    assert.equal(plainOut, "5x6");
    assert.equal(badRejected, true);
    const schema = JSON.parse(schemaJson);
    assert.equal(schema.properties.a.type, "integer");
    assert.equal(schema.properties.a.description, "Left operand");
    assert.equal(schema.properties.b.description, "Right operand");

    // 2. Heterogeneous tools via `.any()` in `llm.agent<Str>`, ordered TraceEvent enum array, and JSONL save
    const res1 = await mod.run_agent_and_save(baseUrl, tracePath);
    assert.equal(res1.$tag, "Ok");
    const [finalText, turns, totalIn, totalOut, eventKinds, decisions] = res1._0;

    assert.equal(finalText, "Result=42; Blocked=Tool call rejected: policy-blocked");
    assert.equal(turns, 2);
    assert.equal(totalIn, 100); // 40 + 60
    assert.equal(totalOut, 40); // 25 + 15
    assert.deepEqual(eventKinds, [
      "user_prompt",
      "thinking",
      "assistant_text",
      "tool_call",
      "tool_call",
      "tool_decision",
      "tool_result",
      "tool_decision",
      "tool_result",
      "turn_completed",
      "assistant_text",
      "turn_completed",
    ]);
    assert.deepEqual(decisions, [
      ["multiply", "modified"],
      ["delete_db", "rejected:policy-blocked"],
    ]);

    // Verify JSONL file format on disk (line 1 = meta, lines 2..13 = 12 ordered TraceEvent JSON objects)
    const jsonlLines = fs.readFileSync(tracePath, "utf8").trim().split("\n");
    assert.equal(jsonlLines.length, 13);
    assert.equal(JSON.parse(jsonlLines[0]).kind, "meta");
    assert.equal(JSON.parse(jsonlLines[1]).kind, "user_prompt");
    assert.equal(JSON.parse(jsonlLines[2]).kind, "thinking");
    assert.equal(JSON.parse(jsonlLines[4]).kind, "tool_call");
    assert.equal(JSON.parse(jsonlLines[4]).name, "multiply");

    // Verify `agent<Str>` sent NO output_config schema, and sent auto-generated input_schema for both tools!
    assert.equal(mock.recorded[0].body.output_config, undefined);
    assert.equal(mock.recorded[0].body.tools[0].input_schema.properties.a.type, "integer");
    assert.equal(mock.recorded[0].body.tools[1].input_schema.properties.confirm.type, "boolean");

    // 3. Typed `llm.agent<AgentReport>`
    const beforeTyped = mock.recorded.length;
    const res2 = await mod.run_agent_typed(baseUrl);
    assert.equal(res2.$tag, "Ok");
    assert.deepEqual(res2._0, [42, "Tool call rejected: policy-blocked", 2]);
    const typedReq = mock.recorded[beforeTyped];
    assert.equal(typedReq.body.output_config?.format?.type, "json_schema");
    assert.equal(typedReq.body.output_config?.format?.schema?.properties?.product?.type, "integer");
    assert.equal(typedReq.body.output_config?.format?.schema?.properties?.blocked?.type, "string");

    // 4a. Full deterministic replay from JSONL: ZERO live HTTP requests!
    const beforeFull = mock.recorded.length;
    const fullRep = await mod.replay_full(baseUrl, tracePath);
    assert.equal(fullRep.$tag, "Ok");
    assert.deepEqual(fullRep._0, ["Result=42; Blocked=Tool call rejected: policy-blocked", 12]);
    assert.equal(mock.recorded.length, beforeFull);

    // 4b. Replay up to step 10 (end of Turn 1), then continue live at Turn 2 as AgentReport: ONLY 1 live HTTP call!
    const beforeTurnBoundary = mock.recorded.length;
    const turnRep = await mod.replay_from_turn_boundary(baseUrl, tracePath);
    assert.equal(turnRep.$tag, "Ok");
    assert.deepEqual(turnRep._0, [42, "Tool call rejected: policy-blocked", 2, 12]);
    assert.equal(mock.recorded.length - beforeTurnBoundary, 1);

    // 4c. Mid-turn replay up to step 5 (after Turn 1 ToolCallSteps, BEFORE tool execution),
    //     then fork with live Modify(10, 10) + Reject("fork-blocked"): ONLY 1 live HTTP call (Turn 2)!
    const beforeMidTurn = mock.recorded.length;
    const midRep = await mod.replay_mid_turn_fork(baseUrl, tracePath);
    assert.equal(midRep.$tag, "Ok");
    assert.deepEqual(midRep._0, [100, "Tool call rejected: fork-blocked", 2]);
    assert.equal(mock.recorded.length - beforeMidTurn, 1);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    mock.server.closeAllConnections?.();
    mock.server.close();
  }
});

test("std/llm: standard parameter translator across OpenAI, Anthropic & Google model families", async () => {
  const { translateStandardParams } = await import("../runtime/llm_capabilities.mjs");
  const { Some, None } = await import("../runtime/core.mjs");
  const dummyTools = [{ name: "calc", description: "calc", parameters: {} }];

  // 1. Non-reasoning OpenAI model (gpt-4.1-mini): drops thinking with warning, preserves temperature
  const t1 = translateStandardParams("openai_responses", {
    model: "gpt-4.1-mini",
    max_tokens: Some(256),
    thinking: Some({ $tag: "ThinkLow" }),
    temperature: Some(0.4),
    top_p: Some(0.9),
    stop: ["END"],
    tool_choice: Some({ $tag: "ToolForce", _0: "calc" }),
    tools: dummyTools,
  });
  assert.equal(t1.params.reasoning, undefined);
  assert.equal(t1.params.temperature, 0.4);
  assert.equal(t1.params.max_output_tokens, 256);
  assert.deepEqual(t1.params.tool_choice, { type: "function", name: "calc" });
  assert.ok(t1.warnings.some((w) => /Dropped thinking/.test(w)));
  assert.ok(t1.warnings.some((w) => /Dropped stop/.test(w)));

  // 2. Reasoning OpenAI models (o4-mini & gpt-6-luna): sends reasoning.effort + summary:"auto", drops temperature/top_p
  const t2 = translateStandardParams("openai_responses", {
    model: "o4-mini",
    thinking: Some({ $tag: "ThinkBudget", _0: 6000 }),
    temperature: Some(0.5),
    top_p: Some(0.8),
  });
  assert.deepEqual(t2.params.reasoning, { effort: "medium", summary: "auto" });
  assert.equal(t2.params.temperature, undefined);
  assert.equal(t2.params.top_p, undefined);
  assert.ok(t2.warnings.some((w) => /Dropped temperature/.test(w)));

  const t2b = translateStandardParams("openai_responses", {
    model: "gpt-6-luna",
    thinking: Some({ $tag: "ThinkLow" }),
  });
  assert.deepEqual(t2b.params.reasoning, { effort: "low", summary: "auto" });
  assert.deepEqual(t2b.warnings, []);

  // 3. Anthropic Claude 4.5 with thinking + low max_tokens + forced tool_choice
  const t3 = translateStandardParams("anthropic", {
    model: "claude-sonnet-4-5",
    max_tokens: Some(1024),
    thinking: Some({ $tag: "ThinkMedium" }),
    temperature: Some(1.4),
    stop: ["STOP"],
    tool_choice: Some({ $tag: "ToolForce", _0: "calc" }),
    tools: dummyTools,
  });
  assert.deepEqual(t3.params.thinking, { type: "enabled", budget_tokens: 4096 });
  assert.equal(t3.params.max_tokens, 5120); // auto-raised above 4096!
  assert.equal(t3.params.temperature, undefined); // forbidden with thinking
  assert.deepEqual(t3.params.stop_sequences, ["STOP"]);
  assert.deepEqual(t3.params.tool_choice, { type: "auto" }); // downgraded with warning
  assert.ok(t3.warnings.some((w) => /Raised max_tokens/.test(w)));
  assert.ok(t3.warnings.some((w) => /Downgraded tool_choice/.test(w)));

  // 4. Anthropic without thinking clamps temperature > 1.0 -> 1.0
  const t4 = translateStandardParams("anthropic", {
    model: "claude-sonnet-4-5",
    temperature: Some(1.6),
    tool_choice: Some({ $tag: "ToolRequired" }),
    tools: dummyTools,
  });
  assert.equal(t4.params.temperature, 1.0);
  assert.deepEqual(t4.params.tool_choice, { type: "any" });
  assert.ok(t4.warnings.some((w) => /Clamped temperature/.test(w)));

  // 5. Google Gemini 3 (thinkingLevel) vs Gemini 2.5 (thinkingBudget) vs Gemini 2.0 (unsupported)
  const g3 = translateStandardParams("google", {
    model: "gemini-3-flash",
    max_tokens: Some(512),
    thinking: Some({ $tag: "ThinkHigh" }),
    temperature: Some(0.7),
    stop: ["###"],
    seed: Some(42),
    presence_penalty: Some(0.2),
    frequency_penalty: Some(0.1),
    tool_choice: Some({ $tag: "ToolForce", _0: "calc" }),
    tools: dummyTools,
  });
  assert.deepEqual(g3.params.thinkingConfig, { thinkingLevel: "high", includeThoughts: true });
  assert.equal(g3.params.maxOutputTokens, 512);
  assert.equal(g3.params.temperature, 0.7);
  assert.deepEqual(g3.params.stopSequences, ["###"]);
  assert.equal(g3.params.seed, 42);
  assert.equal(g3.params.presencePenalty, 0.2);
  assert.equal(g3.params.frequencyPenalty, 0.1);
  assert.deepEqual(g3.params.toolConfig, {
    functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["calc"] },
  });
  assert.deepEqual(g3.warnings, []);

  const g25 = translateStandardParams("google", {
    model: "gemini-2.5-pro",
    thinking: Some({ $tag: "ThinkBudget", _0: 3000 }),
  });
  assert.deepEqual(g25.params.thinkingConfig, { thinkingBudget: 3000, includeThoughts: true });

  const g20 = translateStandardParams("google", {
    model: "gemini-2.0-flash",
    thinking: Some({ $tag: "ThinkMedium" }),
  });
  assert.equal(g20.params.thinkingConfig, undefined);
  assert.ok(g20.warnings.some((w) => /Dropped thinking/.test(w)));
});

test("std/llm: OpenAI (/v1/decisions) and Google (/v1beta/decisions) Decisions APIs + print_inline without newline", async () => {
  const mock = startMockLlmServer();
  const baseUrl = await mock.listen();

  try {
    const mod = await runSpl(`
      import llm, { BoolAnswer, ChoiceAnswer, ScoreAnswer } from "std/llm"

      pub fn run_decisions(base: Str) -> Result<(Bool, Str, Float, Bool, Str, Float, Int, Int), Str> {
          let img: llm.Attachment = {
              kind: "image_url",
              mime_type: "image/jpeg",
              data: "https://example.com/receipt.jpg",
              name: Some("receipt.jpg")
          }
          let qs = [
              llm.predicate(
                  "needs_refund",
                  "Is the customer asking for a refund?",
                  true_description: Some("Explicit refund or chargeback request"),
                  false_description: Some("General question")
              ),
              llm.choice("department", "Which team?", [
                  ("billing", Some("Invoices and payments")),
                  ("shipping", Some("Delivery issues")),
                  ("other", None)
              ]),
              llm.score("urgency", "Rate urgency", ["low", "medium", "high"])
          ]

          // OpenAI Decisions API (/v1/decisions)
          let oai = llm.decide(
              provider: "openai",
              api_key: "sk-oai-dec",
              base_url: Some(base + "/v1"),
              model: "gpt-6-luna",
              questions: qs,
              attachments: [img],
              prompt_cache_key: Some("support-triage-v1")
          ) @{
              I was charged twice today, please refund me!
          }?

          // Google Gemini Decisions API (/v1beta/decisions)
          let goog = llm.decide(
              provider: "google",
              api_key: "AIza-dec",
              base_url: Some(base),
              model: "gemini-decision-1",
              questions: qs,
              attachments: [img]
          ) @{
              I was charged twice today, please refund me!
          }?

          let oai_refund = match oai.answers.get("needs_refund") {
              Some(a) => match a.value {
                  BoolAnswer(b) => b
                  _ => false
              }
              None => false
          }
          let oai_dept = match oai.answers.get("department") {
              Some(a) => match a.value {
                  ChoiceAnswer(c) => c
                  _ => ""
              }
              None => ""
          }
          let oai_urg = match oai.answers.get("urgency") {
              Some(a) => match a.value {
                  ScoreAnswer(s) => s
                  _ => 0.0
              }
              None => 0.0
          }

          let goog_refund = match goog.answers.get("needs_refund") {
              Some(a) => match a.value {
                  BoolAnswer(b) => b
                  _ => false
              }
              None => false
          }
          let goog_dept = match goog.answers.get("department") {
              Some(a) => match a.value {
                  ChoiceAnswer(c) => c
                  _ => ""
              }
              None => ""
          }
          let goog_urg = match goog.answers.get("urgency") {
              Some(a) => match a.value {
                  ScoreAnswer(s) => s
                  _ => 0.0
              }
              None => 0.0
          }

          Ok((oai_refund, oai_dept, oai_urg, goog_refund, goog_dept, goog_urg, oai.usage.output_tokens, goog.usage.output_tokens))
      }
    `);

    const res = await mod.run_decisions(baseUrl);
    assert.equal(res.$tag, "Ok");
    assert.deepEqual(res._0, [true, "billing", 1.75, true, "billing", 2, 0, 0]);

    // Verify exact wire formats sent to both endpoints
    const [oaiReq, googReq] = mock.recorded;
    assert.equal(oaiReq.url, "/v1/decisions");
    assert.equal(oaiReq.headers.authorization, "Bearer sk-oai-dec");
    assert.equal(oaiReq.body.model, "gpt-6-luna");
    assert.equal(oaiReq.body.prompt_cache_key, "support-triage-v1");
    assert.equal(oaiReq.body.questions[0].type, "predicate");
    assert.deepEqual(oaiReq.body.questions[1].choices, ["billing", "shipping", "other"]);
    assert.deepEqual(oaiReq.body.questions[2].levels, ["low", "medium", "high"]);

    assert.equal(googReq.url, "/v1beta/decisions");
    assert.equal(googReq.headers["x-goog-api-key"], "AIza-dec");
    assert.equal(googReq.body.model, "gemini-decision-1");
    assert.equal(googReq.body.questions.needs_refund.type, "noul");
    assert.equal(googReq.body.questions.needs_refund.criteria.true_description, "Explicit refund or chargeback request");
    assert.equal(googReq.body.questions.department.type, "choice");
    assert.equal(googReq.body.questions.department.criteria.billing, "Invoices and payments");
    assert.equal(googReq.body.questions.urgency.type, "score");
    assert.equal(googReq.body.questions.urgency.criteria["2"], "high");

    // Verify `print_inline` writes without trailing newline
    const { execFileSync } = await import("node:child_process");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "spl-inline-"));
    const p = path.join(tmpDir, "inline.splx");
    fs.writeFileSync(p, `print_inline("A")\nprint_inline("B")\nprint_inline("C")\n`, "utf8");
    try {
      const out = execFileSync(process.execPath, [path.resolve("dist/cli.js"), "run", p], { encoding: "utf8" });
      assert.equal(out, "ABC");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  } finally {
    mock.server.closeAllConnections?.();
    mock.server.close();
  }
});

test("std/llm & std/codegen: Prompt.llm_fn<In, Out> synthesizes sandboxed JS from prompt + schemas with auto syntax retry", async () => {
  const recorded = [];
  let retryCalls = 0;

  const server = http.createServer((req, res) => {
    res.setHeader("connection", "close");
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      recorded.push({ url: req.url, body });

      const userText = String(body.input?.[0]?.content ?? "");
      let jsBody;
      if (userText.includes("RETRY_ME")) {
        retryCalls++;
        // First attempt intentionally returns invalid JS syntax; second attempt fixes it!
        jsBody =
          retryCalls === 1
            ? "return { sum: input.a +, product: 0 };"
            : "return { sum: input.a + input.b, product: input.a * input.b };";
      } else if (userText.includes("reverse and uppercase")) {
        jsBody = "```js\nreturn input.split('').reverse().join('').toUpperCase();\n```";
      } else {
        jsBody = "return { sum: input.a + input.b, product: input.a * input.b };";
      }

      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          status: "completed",
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: JSON.stringify({ body: jsBody }) }],
            },
          ],
          usage: { input_tokens: 20, output_tokens: 15, total_tokens: 35 },
        })
      );
    });
  });

  const baseUrl = await new Promise((resolve) => {
    server.unref();
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`));
  });

  try {
    const mod = await runSpl(`
      import llm from "std/llm"
      import codegen from "std/codegen"

      type CalcIn = struct {
          a: Int '' First operand
          b: Int '' Second operand
      }

      type CalcOut = struct {
          sum: Int     '' Sum of a and b
          product: Int '' Product of a and b
      }

      pub fn run_llm_fn(base: Str) -> Result<(Int, Int, Str, Int, Int, Int), Str> {
          // 1. Prompt.llm_fn<CalcIn, CalcOut> exposed directly from std/llm
          let f1 = @{
              Compute sum and product of two integers
          }.llm_fn<CalcIn, CalcOut>(
              provider: "openai_responses",
              api_key: "sk-test",
              base_url: Some(base + "/v1"),
              model: "gpt-4.1-mini"
          )?
          let r1 = f1({ a: 6, b: 7 })?

          // 2. Prompt.llm_fn<Str, Str> (also tests markdown fence stripping!)
          let f2 = @{
              Return a function to reverse and uppercase the input string.
          }.llm_fn<Str, Str>(
              provider: "openai_responses",
              api_key: "sk-test",
              base_url: Some(base + "/v1"),
              model: "gpt-4.1-mini"
          )?
          let r2 = f2("hello")?

          // 3. Automatic retry when LLM first emits invalid JS syntax
          let f3 = @{
              RETRY_ME compute sum and product
          }.llm_fn<CalcIn, CalcOut>(
              provider: "openai_responses",
              api_key: "sk-test",
              base_url: Some(base + "/v1"),
              model: "gpt-4.1-mini",
              max_retries: 2
          )?
          let r3 = f3({ a: 10, b: 5 })?

          // 4. Backwards compatibility: codegen.llm_fn still works
          let f4 = codegen.llm_fn<CalcIn, CalcOut>(
              provider: "openai_responses",
              api_key: "sk-test",
              base_url: Some(base + "/v1"),
              model: "gpt-4.1-mini",
              description: "Compute sum and product"
          )?
          let r4 = f4({ a: 3, b: 4 })?

          Ok((r1.sum, r1.product, r2, r3.sum, r3.product, r4.sum))
      }
    `);

    const res = await mod.run_llm_fn(baseUrl);
    assert.equal(res.$tag, "Ok");
    assert.deepEqual(res._0, [13, 42, "OLLEH", 15, 50, 7]);

    // Verify first prompt included BOTH In and Out JSON Schemas + '' LLM hints!
    const prompt1 = recorded[0].body.input[0].content;
    assert.match(prompt1, /First operand/);
    assert.match(prompt1, /Second operand/);
    assert.match(prompt1, /Sum of a and b/);
    assert.match(prompt1, /Product of a and b/);

    // Verify retry happened (2 attempts for RETRY_ME, with the syntax error fed back on attempt 2!)
    assert.equal(retryCalls, 2);
    const retryPrompt = recorded[3].body.input[0].content;
    assert.match(retryPrompt, /Previous attempt failed JS compilation/);
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});

test("CLI `spl login` & optional api_key: saves/loads ~/.spl/credentials.json for openai, google, and anthropic", async () => {
  const { execFileSync } = await import("node:child_process");
  const mock = startMockLlmServer();
  const baseUrl = await mock.listen();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "spl-login-"));
  const credsFile = path.join(tmpDir, "credentials.json");
  const cli = path.resolve("dist/cli.js");

  const prevCredsEnv = process.env.SPL_CREDENTIALS_FILE;
  const prevOpenAi = process.env.OPENAI_API_KEY;
  const prevAnth = process.env.ANTHROPIC_API_KEY;
  const prevGem = process.env.GEMINI_API_KEY;
  const prevGoog = process.env.GOOGLE_API_KEY;

  try {
    // 1. Save tokens via `spl login` (both flags and positional syntax)
    const loginOut = execFileSync(
      process.execPath,
      [cli, "login", "--openai", "sk-saved-openai-1234", "--anthropic", "sk-saved-ant-5678"],
      { encoding: "utf8", env: { ...process.env, SPL_CREDENTIALS_FILE: credsFile } }
    );
    assert.match(loginOut, /Saved credentials/);
    assert.match(loginOut, /openai \(sk-s\.\.\.1234\)/);
    assert.match(loginOut, /anthropic \(sk-s\.\.\.5678\)/);

    execFileSync(
      process.execPath,
      [cli, "login", "google", "AIza-saved-google-9012"],
      { encoding: "utf8", env: { ...process.env, SPL_CREDENTIALS_FILE: credsFile } }
    );

    const statusOut = execFileSync(process.execPath, [cli, "login", "--status"], {
      encoding: "utf8",
      env: { ...process.env, SPL_CREDENTIALS_FILE: credsFile },
    });
    assert.match(statusOut, /openai\s+sk-s\.\.\.1234/);
    assert.match(statusOut, /google\s+AIza\.\.\.9012/);
    assert.match(statusOut, /anthropic\s+sk-s\.\.\.5678/);

    const savedJson = JSON.parse(fs.readFileSync(credsFile, "utf8"));
    assert.deepEqual(savedJson, {
      openai: "sk-saved-openai-1234",
      google: "AIza-saved-google-9012",
      anthropic: "sk-saved-ant-5678",
    });

    // 2. Call Prompt.ask without api_key across OpenAI, Anthropic, and Google — reads credentials file!
    process.env.SPL_CREDENTIALS_FILE = credsFile;
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;

    const mod = await runSpl(`
      import llm from "std/llm"

      type Answer = struct {
          answer: Int '' Numeric answer
      }

      pub fn run_without_keys(base: Str) -> Result<(Int, Str, Str), Str> {
          // Omit provider, model, and api_key -> defaults to "openai_responses", "gpt-6-luna", and saved credentials!
          let r1 = @{ What is 6*7? }.ask<Answer>(
              base_url: Some(base + "/v1")
          )?
          let r2 = @{ Say hi }.ask<Str>(
              provider: "anthropic",
              model: "claude-sonnet-4-5",
              base_url: Some(base)
          )?
          let r3 = @{ Say hi }.ask<Str>(
              provider: "google",
              model: "gemini-2.5-pro",
              base_url: Some(base)
          )?
          Ok((r1.answer, r2, r3))
      }
    `);

    const res = await mod.run_without_keys(baseUrl);
    assert.equal(res.$tag, "Ok");
    assert.deepEqual(res._0, [42, "Claude OK", "Gemini OK"]);

    const [oaiReq, antReq, googReq] = mock.recorded;
    assert.equal(oaiReq.url, "/v1/responses");
    assert.equal(oaiReq.body.model, "gpt-6-luna");
    assert.equal(oaiReq.headers.authorization, "Bearer sk-saved-openai-1234");
    assert.equal(antReq.headers["x-api-key"], "sk-saved-ant-5678");
    assert.equal(googReq.headers["x-goog-api-key"], "AIza-saved-google-9012");

    // 2b. Environment variables take priority over ~/.spl/credentials.json when api_key is omitted
    const beforeEnvCount = mock.recorded.length;
    process.env.OPENAI_API_KEY = "sk-env-openai-9999";
    process.env.ANTHROPIC_API_KEY = "sk-env-ant-8888";
    process.env.GEMINI_API_KEY = "AIza-env-gem-7777";
    const envRes = await mod.run_without_keys(baseUrl);
    assert.equal(envRes.$tag, "Ok");
    assert.deepEqual(envRes._0, [42, "Claude OK", "Gemini OK"]);
    const [oaiEnvReq, antEnvReq, googEnvReq] = mock.recorded.slice(beforeEnvCount);
    assert.equal(oaiEnvReq.headers.authorization, "Bearer sk-env-openai-9999");
    assert.equal(antEnvReq.headers["x-api-key"], "sk-env-ant-8888");
    assert.equal(googEnvReq.headers["x-goog-api-key"], "AIza-env-gem-7777");
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.GEMINI_API_KEY;

    // 3. Clearing credentials makes calls without api_key return a helpful `spl login` error
    execFileSync(process.execPath, [cli, "login", "--clear"], {
      encoding: "utf8",
      env: { ...process.env, SPL_CREDENTIALS_FILE: credsFile },
    });
    const missingRes = await mod.run_without_keys(baseUrl);
    assert.equal(missingRes.$tag, "Err");
    assert.match(missingRes._0, /spl login/);
  } finally {
    if (prevCredsEnv === undefined) delete process.env.SPL_CREDENTIALS_FILE;
    else process.env.SPL_CREDENTIALS_FILE = prevCredsEnv;
    if (prevOpenAi === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prevOpenAi;
    if (prevAnth === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevAnth;
    if (prevGem === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = prevGem;
    if (prevGoog === undefined) delete process.env.GOOGLE_API_KEY;
    else process.env.GOOGLE_API_KEY = prevGoog;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    mock.server.closeAllConnections?.();
    mock.server.close();
  }
});
