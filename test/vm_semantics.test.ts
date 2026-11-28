import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compileSource, createEmptyCatalog, runVm } from "../src/index.js";

async function evalSpl(src: string, inputs: Record<string, unknown> = {}, limits?: Record<string, unknown>) {
  const compiled = compileSource(src, createEmptyCatalog());
  return runVm({ bytecode: compiled.text, inputs, limits });
}

describe("§11.5.4 VM Semantics, Value Isolation, Built-ins, Traps & Limits", () => {
  it("traps on checked int64 overflow, div-by-zero, non-finite float, and shift bounds", async () => {
    const ovf = await evalSpl("fn main() -> int { return 9223372036854775807 + 1; }");
    assert.equal(ovf.result.status, "trap");
    assert.equal(ovf.result.trap_code, "NUM_OVERFLOW");

    const negMin = await evalSpl("fn main() -> int { let x = -9223372036854775808; return -x; }");
    assert.equal(negMin.result.status, "trap");
    assert.equal(negMin.result.trap_code, "NUM_OVERFLOW");

    const divZero = await evalSpl("fn main() -> int { return 10 / 0; }");
    assert.equal(divZero.result.status, "trap");
    assert.equal(divZero.result.trap_code, "DIV_BY_ZERO");

    const fInf = await evalSpl("fn main() -> float { return 1.0 / 0.0; }");
    assert.equal(fInf.result.status, "trap");
    assert.equal(fInf.result.trap_code, "FLOAT_NON_FINITE");

    const shiftBad = await evalSpl("fn main() -> int { return 1 << 64; }");
    assert.equal(shiftBad.result.status, "trap");
    assert.equal(shiftBad.result.trap_code, "SHIFT_OUT_OF_RANGE");

    const f2iOvf = await evalSpl("fn main() -> int { return 1e30 as int; }");
    assert.equal(f2iOvf.result.status, "trap");
    assert.equal(f2iOvf.result.trap_code, "NUM_OVERFLOW");
  });

  it("normalizes -0.0 to 0.0 and computes 64-bit bitwise operations", async () => {
    const res = await evalSpl(`
      fn main() -> { negz: string, sh: int, ushr: int, bnot: int } {
        let z = -0.0;
        let negOne = -1;
        return {
          negz: \`\${z}\`,
          sh: (1 << 4) | (3 ^ 1),
          ushr: negOne >>> 60,
          bnot: ~0
        };
      }
    `);
    assert.equal(res.result.status, "ok");
    assert.deepStrictEqual(res.result.value, {
      bnot: -1n,
      negz: "0",
      sh: 18n,
      ushr: 15n,
    });
  });

  it("enforces pure value semantics (no aliasing across let copies, nested lvalues, or fn calls)", async () => {
    const res = await evalSpl(`
      type Inner = { c: int };
      type Outer = { arr: list<Inner> };

      fn mutateParam(x: Outer) -> int {
        let mut local = x;
        local.arr[0].c = 999;
        return local.arr[0].c;
      }

      fn main() -> { orig: int, copy: int, fnRes: int } {
        let a: Outer = { arr: [{ c: 1 }, { c: 2 }] };
        let mut b = a;
        b.arr[0].c = 42;
        let fr = mutateParam(a);
        return { orig: a.arr[0].c, copy: b.arr[0].c, fnRes: fr };
      }
    `);
    assert.equal(res.result.status, "ok");
    assert.deepStrictEqual(res.result.value, { orig: 1n, copy: 42n, fnRes: 999n });
  });

  it("uses Unicode code-point string semantics and code-point key sorting", async () => {
    const res = await evalSpl(`
      fn main() -> { l: int, ch: string, sl: string, cpOrder: bool, keys: list<string> } {
        let s = "a\\u{1F600}b";
        let m: map<string, int> = { "\\u{10000}": 1, "\\u{E000}": 2, "b": 3, "a": 4 };
        return {
          l: len(s),
          ch: s[1],
          sl: str.slice(s, 1, 3),
          cpOrder: "\\u{E000}" < "\\u{10000}",
          keys: map.keys(m)
        };
      }
    `);
    assert.equal(res.result.status, "ok");
    assert.deepStrictEqual(res.result.value, {
      ch: "😀",
      cpOrder: true,
      keys: ["a", "b", "\uE000", "\u{10000}"],
      l: 3n,
      sl: "😀b",
    });
  });

  it("executes loops, break/continue, recursion, builtins, and CAST_JSON", async () => {
    const res = await evalSpl(`
      fn fib(n: int) -> int {
        if (n <= 1) { return n; }
        return fib(n - 1) + fib(n - 2);
      }

      fn main() -> { f7: int, sum: int, parsed: { x: int } } {
        let mut sum = 0;
        for (v in [1, 2, 3, 4, 5]) {
          if (v == 2) { continue; }
          if (v == 5) { break; }
          sum = sum + v;
        }
        let j = json.parse("{\\"x\\": 77}");
        let p = j as { x: int };
        return { f7: fib(7), sum: sum, parsed: p };
      }
    `);
    assert.equal(res.result.status, "ok");
    assert.deepStrictEqual(res.result.value, { f7: 13n, parsed: { x: 77n }, sum: 8n });
  });

  it("unwinds try/catch for recoverable errors across frames, but never catches VM traps", async () => {
    const caught = await evalSpl(`
      fn parseBad() -> json {
        return json.parse("{not valid json");
      }
      fn main() -> string {
        try {
          let x = parseBad();
          return json.stringify(x);
        } catch (err) {
          return err.code;
        }
      }
    `);
    assert.equal(caught.result.status, "ok");
    assert.equal(caught.result.value, "JSON_PARSE_ERROR");

    const uncaughtTrap = await evalSpl(`
      fn main() -> int {
        try {
          return 1 / 0;
        } catch (err) {
          return 99;
        }
      }
    `);
    assert.equal(uncaughtTrap.result.status, "trap");
    assert.equal(uncaughtTrap.result.trap_code, "DIV_BY_ZERO");
  });

  it("enforces deterministic logical limits (max_steps, max_call_depth, max_memory_bytes)", async () => {
    const stepTrap = await evalSpl(
      `fn main() -> int { let mut i = 0; while (true) { i = i + 1; } return i; }`,
      {},
      { max_steps: 200 }
    );
    assert.equal(stepTrap.result.status, "trap");
    assert.equal(stepTrap.result.trap_code, "LIMIT_EXCEEDED");

    const depthTrap = await evalSpl(
      `fn rec(n: int) -> int { return rec(n + 1); } fn main() -> int { return rec(0); }`,
      {},
      { max_call_depth: 10 }
    );
    assert.equal(depthTrap.result.status, "trap");
    assert.equal(depthTrap.result.trap_code, "LIMIT_EXCEEDED");

    const memTrap = await evalSpl(
      `fn main() -> string {
         let mut s = "abcdefghij";
         let mut i = 0;
         while (i < 12) { s = s + s; i = i + 1; }
         return s;
       }`,
      {},
      { max_memory_bytes: 2048 }
    );
    assert.equal(memTrap.result.status, "trap");
    assert.equal(memTrap.result.trap_code, "LIMIT_EXCEEDED");
  });
});
