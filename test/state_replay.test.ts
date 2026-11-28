import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  EffectRecord,
  SignatureCatalog,
  canonicalTraceJson,
  compileSource,
  createEmptyCatalog,
  runVm,
} from "../src/index.js";

function makeCatalog(): SignatureCatalog {
  const cat = createEmptyCatalog();
  cat.models.default = {
    provider: "openai",
    model: "gpt-4.1",
    max_output_tokens: 256,
    temperature: 0,
    strict_schema: true,
  };
  return cat;
}

describe("§11.5.5 Durable Transactional State & Deterministic Replay", () => {
  it("commits durable state atomically on clean exit and rolls back on trap", async () => {
    const src = `
      input shouldFail: bool;
      state counter: int = 10;
      fn main() -> int {
        counter = counter + 5;
        if (shouldFail) {
          let boom = 1 / 0;
          return boom;
        }
        return counter;
      }
    `;
    const compiled = compileSource(src, createEmptyCatalog());

    let persistedState: Record<string, unknown> = {};
    const okRun = await runVm({
      bytecode: compiled.text,
      inputs: { shouldFail: false },
      initialState: persistedState,
      onCommitState(finalState) {
        persistedState = finalState;
      },
    });
    assert.equal(okRun.result.status, "ok");
    assert.equal(okRun.result.value, 15n);
    assert.deepStrictEqual(persistedState, { counter: 15n });

    // Next run traps after mutating counter: state MUST roll back and onCommitState MUST NOT fire
    let commitCalled = false;
    const trapRun = await runVm({
      bytecode: compiled.text,
      inputs: { shouldFail: true },
      initialState: persistedState,
      onCommitState() {
        commitCalled = true;
      },
    });
    assert.equal(trapRun.result.status, "trap");
    assert.equal(trapRun.result.final_state, null);
    assert.equal(commitCalled, false);
    assert.deepStrictEqual(persistedState, { counter: 15n });
  });

  it("supports mid-run crash recovery and strict replay with normative trace equality", async () => {
    const catalog = makeCatalog();
    const src = `
      state runs: int = 0;
      fn main() -> string {
        let a = model.ask<string>("default", "step 1");
        let b = model.ask<string>("default", \`step 2: \${a}\`);
        runs = runs + 1;
        return a + "|" + b;
      }
    `;
    const compiled = compileSource(src, catalog);

    // Run 1: record live effects
    const wal: EffectRecord[] = [];
    let liveCalls = 0;
    const liveTrace = await runVm({
      bytecode: compiled.text,
      catalog,
      dispatcher: {
        async dispatch(req) {
          liveCalls++;
          return {
            outcome: { status: "ok", value: req.seq === 0 ? "FIRST" : "SECOND" },
            non_normative_meta: { provider_request_id: `req_live_${req.seq}`, latency_ms: 123 },
          };
        },
      },
      onEffectRecorded(rec) {
        wal.push(rec);
      },
    });
    assert.equal(liveTrace.result.status, "ok");
    assert.equal(liveTrace.result.value, "FIRST|SECOND");
    assert.equal(liveCalls, 2);

    // Simulate crash after effect 0: recover from partial WAL [wal[0]], only effect 1 executes live
    let recoveryLiveCalls = 0;
    const recoveredTrace = await runVm({
      bytecode: compiled.text,
      catalog,
      replayLog: [wal[0]],
      replayMode: "recovery",
      dispatcher: {
        async dispatch(req) {
          recoveryLiveCalls++;
          assert.equal(req.seq, 1);
          return {
            outcome: { status: "ok", value: "SECOND" },
            non_normative_meta: { provider_request_id: "req_recovered_1", latency_ms: 999 },
          };
        },
      },
    });
    assert.equal(recoveredTrace.result.status, "ok");
    assert.equal(recoveryLiveCalls, 1);
    // Normative trace equality ignores non_normative_meta!
    assert.equal(canonicalTraceJson(recoveredTrace), canonicalTraceJson(liveTrace));

    // Strict replay requires ZERO dispatcher and reproduces byte-identical normative trace
    const strictTrace = await runVm({
      bytecode: compiled.text,
      catalog,
      replayLog: wal,
      replayMode: "strict_replay",
    });
    assert.equal(strictTrace.result.status, "ok");
    assert.equal(canonicalTraceJson(strictTrace), canonicalTraceJson(liveTrace));
  });

  it("hard-traps with uncatchable REPLAY_DIVERGENCE on mutated effect args or exhausted log", async () => {
    const catalog = makeCatalog();
    const src = `
      fn main() -> string {
        try {
          return model.ask<string>("default", "hello");
        } catch (err) {
          return "caught:" + err.code;
        }
      }
    `;
    const compiled = compileSource(src, catalog);

    // Mutated args in replay log
    const badLog: EffectRecord[] = [
      {
        seq: 0,
        kind: "model.ask",
        target: "default",
        args: { prompt: "DIFFERENT_PROMPT" },
        outcome: { status: "ok", value: "hi" },
      },
    ];
    const divTrace = await runVm({
      bytecode: compiled.text,
      replayLog: badLog,
      replayMode: "strict_replay",
    });
    assert.equal(divTrace.result.status, "trap");
    assert.equal(divTrace.result.trap_code, "REPLAY_DIVERGENCE");

    // Exhausted strict replay log
    const emptyStrict = await runVm({
      bytecode: compiled.text,
      replayLog: [],
      replayMode: "strict_replay",
    });
    assert.equal(emptyStrict.result.status, "trap");
    assert.equal(emptyStrict.result.trap_code, "REPLAY_DIVERGENCE");
  });
});
