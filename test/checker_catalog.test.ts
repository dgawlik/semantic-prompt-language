import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  SignatureCatalog,
  SplCompileError,
  compileSource,
  createEmptyCatalog,
  runVm,
} from "../src/index.js";

function makeCatalog(): SignatureCatalog {
  const cat = createEmptyCatalog();
  cat.models.strict_mod = {
    provider: "openai",
    model: "gpt-4.1",
    max_output_tokens: 512,
    temperature: 0,
    strict_schema: true,
  };
  cat.decisions.cls = {
    adapter: "openai_logprobs",
    model: "gpt-4.1-mini",
    top_logprobs: 20,
    temperature: 0,
  };
  cat.fs_roots.ro = {
    permissions: ["read", "list"],
    max_file_bytes: 1024,
  };
  return cat;
}

function expectCompileError(src: string, code: string, catalog = makeCatalog()): void {
  assert.throws(
    () => compileSource(src, catalog),
    (err: unknown) => {
      assert.ok(err instanceof SplCompileError, `Expected SplCompileError, got ${String(err)}`);
      assert.ok(
        err.diagnostics.some((d) => d.code === code),
        `Expected diagnostic '${code}', got: ${err.diagnostics.map((d) => `${d.code}:${d.message}`).join("; ")}`
      );
      return true;
    }
  );
}

describe("§11.5.2 Static Type Checker & Catalog Verification", () => {
  it("forbids implicit int/float coercion and allows explicit casts", async () => {
    expectCompileError("fn main() -> float { return 1 + 2.0; }", "E_TYPE_MISMATCH");
    expectCompileError("fn main() -> float { return 1.0 % 2.0; }", "E_TYPE_MISMATCH");
    expectCompileError("fn main() -> int { return 1.0 & 2.0; }", "E_TYPE_MISMATCH");

    const ok = compileSource("fn main() -> float { return (1 as float) + 2.5; }", makeCatalog());
    const trace = await runVm({ bytecode: ok.text });
    assert.equal(trace.result.status, "ok");
    assert.equal(trace.result.value, 3.5);
  });

  it("enforces nullability checks and flow-sensitive narrowing", async () => {
    expectCompileError(
      `type Box = { v: int };
       input b: Box?;
       fn main() -> int { return b.v; }`,
      "E_NULLABLE_ACCESS"
    );

    // Mutable binding must NOT narrow
    expectCompileError(
      `type Box = { v: int };
       fn main() -> int {
         let mut b: Box? = { v: 1 };
         if (b != null) { return b.v; }
         return 0;
       }`,
      "E_NULLABLE_ACCESS"
    );

    // Immutable narrowing via `if (b != null)` AND early return `if (b == null) { return ...; }`
    const src = `
      type Box = { v: int };
      input a: Box?;
      input b: Box?;
      fn main() -> int {
        let mut sum = 0;
        if (a != null) {
          sum = sum + a.v;
        }
        let viaOpt = a?.v ?? 100;
        if (b == null) {
          return sum + viaOpt;
        }
        return sum + viaOpt + b.v;
      }
    `;
    const compiled = compileSource(src, makeCatalog());
    const t1 = await runVm({ bytecode: compiled.text, inputs: { a: null, b: { v: 7 } } });
    assert.equal(t1.result.status, "ok");
    assert.equal(t1.result.value, 107n);

    const t2 = await runVm({ bytecode: compiled.text, inputs: { a: { v: 5 }, b: null } });
    assert.equal(t2.result.status, "ok");
    assert.equal(t2.result.value, 10n);
  });

  it("rejects recursive type aliases and general union types", () => {
    expectCompileError("type Node = { next: Node? }; fn main() -> int { return 0; }", "E_RECURSIVE_TYPE");
    expectCompileError("type Bad = int | string; fn main() -> int { return 0; }", "E_INVALID_UNION");
    expectCompileError('type Single = "only"; fn main() -> int { return 0; }', "E_INVALID_UNION");
  });

  it("enforces switch exhaustiveness and rejects duplicate cases", () => {
    expectCompileError(
      `type Status = "open" | "closed" | "pending";
       input s: Status;
       fn main() -> int {
         switch (s) {
           case "open": { return 1; }
           case "closed": { return 2; }
         }
       }`,
      "E_NON_EXHAUSTIVE_SWITCH"
    );

    expectCompileError(
      `input x: int;
       fn main() -> int {
         switch (x) {
           case 1: { return 1; }
           case 1: { return 2; }
           default: { return 0; }
         }
       }`,
      "E_DUPLICATE_CASE"
    );
  });

  it("enforces immutability, missing returns, jump contexts, and template types", () => {
    expectCompileError("fn main() -> int { let x = 1; x = 2; return x; }", "E_IMMUTABLE_BINDING");
    expectCompileError("input x: int; fn main() -> int { x = 2; return x; }", "E_IMMUTABLE_BINDING");
    expectCompileError("input b: bool; fn main() -> int { if (b) { return 1; } }", "E_MISSING_RETURN");
    expectCompileError("fn main() -> void { break; }", "E_INVALID_JUMP");
    expectCompileError("fn main() -> string { let x: int? = null; return `${x}`; }", "E_TEMPLATE_TYPE");
  });

  it("rejects non-strict JSON Schemas, unknown capabilities, denied fs perms, and impure state inits", () => {
    expectCompileError(
      'fn main() -> map<string, int> { return model.ask<map<string, int>>("strict_mod", "hi"); }',
      "E_SCHEMA_NOT_STRICT"
    );
    expectCompileError(
      'fn main() -> json { return model.ask<json>("strict_mod", "hi"); }',
      "E_SCHEMA_NOT_STRICT"
    );
    expectCompileError(
      'fn main() -> string { return model.ask<string>("no_such_profile", "hi"); }',
      "E_UNKNOWN_CAPABILITY"
    );
    expectCompileError(
      'fn main() -> null { return fs.write("ro", "a.txt", "hi"); }',
      "E_CAPABILITY_DENIED"
    );
    expectCompileError(
      'state bad: string = model.ask<string>("strict_mod", "hi"); fn main() -> string { return bad; }',
      "E_IMPURE_INIT"
    );
  });
});
