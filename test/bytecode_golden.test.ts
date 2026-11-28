import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  SignatureCatalog,
  compileSource,
  createEmptyCatalog,
  parseBytecode,
  runVm,
  serializeBytecode,
} from "../src/index.js";

function makeTicketCatalog(reversedKeys = false): SignatureCatalog {
  const cat = createEmptyCatalog();
  if (!reversedKeys) {
    cat.models.default = {
      provider: "openai",
      model: "gpt-4.1",
      max_output_tokens: 2048,
      temperature: 0.0,
      strict_schema: true,
    };
    cat.decisions.classifier_default = {
      adapter: "openai_logprobs",
      model: "gpt-4.1-mini",
      top_logprobs: 20,
      temperature: 0.0,
    };
  } else {
    cat.decisions.classifier_default = {
      temperature: 0.0,
      top_logprobs: 20,
      model: "gpt-4.1-mini",
      adapter: "openai_logprobs",
    };
    cat.models.default = {
      strict_schema: true,
      temperature: 0.0,
      max_output_tokens: 2048,
      model: "gpt-4.1",
      provider: "openai",
    };
  }
  return cat;
}

const SPEC_SECTION_10_SOURCE = `
type Ticket = { id: int, text: string };
input ticket: Ticket;
state approved_count: int = 0;

fn main() -> string {
  let verdict = model.decide(
    "classifier_default",
    \`Classify refund ticket #\${ticket.id}: \${ticket.text}\`,
    ["approve", "reject"],
    { min_confidence: 0.8 }
  );

  if (verdict == null) {
    return "manual_review";
  }

  switch (verdict) {
    case "approve": {
      approved_count = approved_count + 1;
      return model.ask<string>("default", \`Write brief approval reply for #\${ticket.id}\`);
    }
    case "reject": {
      return "rejected";
    }
  }
}
`;

describe("§11.5.3 Canonical Bytecode Golden & Round-Trip Tests", () => {
  it("produces byte-identical SPLB 5 across repeated compilations and catalog key permutations", () => {
    const c1 = compileSource(SPEC_SECTION_10_SOURCE, makeTicketCatalog(false));
    const c2 = compileSource(SPEC_SECTION_10_SOURCE, makeTicketCatalog(false));
    const c3 = compileSource(SPEC_SECTION_10_SOURCE, makeTicketCatalog(true));

    assert.equal(c1.text, c2.text);
    assert.equal(c1.sha256, c2.sha256);
    assert.equal(c1.text, c3.text);
    assert.equal(c1.sha256, c3.sha256);
    assert.ok(c1.text.startsWith("SPLB 5\n"));
    assert.ok(!c1.text.includes("\r"));
    assert.ok(c1.text.endsWith("\n"));
    assert.ok(c1.text.includes('CAPS ["decision:classifier_default","model:default"]\n'));
  });

  it("round-trips SPLB 5 text losslessly through parseBytecode and serializeBytecode", () => {
    const compiled = compileSource(SPEC_SECTION_10_SOURCE, makeTicketCatalog(false));
    const reparsed = parseBytecode(compiled.text);
    const reserialized = serializeBytecode(reparsed);
    assert.equal(reserialized, compiled.text);
  });

  it("preserves AST operand order without algebraic rewriting (x + 1 !== 1 + x)", () => {
    const a = compileSource("input x: int; fn main() -> int { return x + 1; }", createEmptyCatalog());
    const b = compileSource("input x: int; fn main() -> int { return 1 + x; }", createEmptyCatalog());
    assert.notEqual(a.text, b.text);
    assert.ok(a.text.includes("0000: LOAD_INPUT 0\n  0001: PUSH_CONST c0\n  0002: IADD"));
    assert.ok(b.text.includes("0000: PUSH_CONST c0\n  0001: LOAD_INPUT 0\n  0002: IADD"));
  });

  it("executes the §10 worked ticket classification example end-to-end", async () => {
    const catalog = makeTicketCatalog();
    const compiled = compileSource(SPEC_SECTION_10_SOURCE, catalog);

    const trace = await runVm({
      bytecode: compiled.text,
      catalog,
      inputs: { ticket: { id: 42, text: "Charged twice" } },
      initialState: { approved_count: 3 },
      dispatcher: {
        async dispatch(req) {
          if (req.kind === "model.decide") {
            return {
              outcome: {
                status: "ok",
                value: "approve",
                decision_scores: { approve: 0.95, reject: 0.05 },
                confidence: 0.95,
              },
            };
          }
          if (req.kind === "model.ask") {
            return {
              outcome: { status: "ok", value: "Refund #42 approved." },
            };
          }
          throw new Error(`Unexpected effect ${req.kind}`);
        },
      },
    });

    assert.equal(trace.result.status, "ok");
    assert.equal(trace.result.value, "Refund #42 approved.");
    assert.deepStrictEqual(trace.result.final_state, { approved_count: 4n });
    assert.equal(trace.effects.length, 2);
    assert.deepStrictEqual(trace.effects[0].outcome, {
      status: "ok",
      value: "approve",
      decision_scores: { approve: 0.95, reject: 0.05 },
      confidence: 0.95,
    });
  });
});
