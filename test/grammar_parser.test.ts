import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  INT64_MIN,
  SplCompileError,
  compileSource,
  createEmptyCatalog,
  lex,
  loadSplV5LarkGrammar,
  parse,
  runVm,
} from "../src/index.js";

describe("§11.5.1 Grammar, Lexer & Parser Conformance", () => {
  it("loads normative llguidance-compatible Lark CFG file", () => {
    const g = loadSplV5LarkGrammar();
    assert.ok(g.includes("start: program"));
    assert.ok(g.includes("eff_decide"));
    assert.ok(g.includes("eff_ask"));
    // Guard against llguidance-unsupported regex/Lark constructs
    assert.ok(!g.includes("(?!") && !g.includes("(?="), "Lark CFG must not contain regex lookarounds");
    assert.ok(!g.includes("*?") && !g.includes("+?"), "Lark CFG must not contain lazy regex quantifiers");
    assert.ok(!/^\?/m.test(g), "Lark CFG must not use Python-Lark '?' rule prefixes");
    assert.ok(!/\s->\s[a-z_]+$/m.test(g), "Lark CFG must not use Python-Lark '-> alias' suffixes");
    assert.ok(g.includes("%ignore /[ \\t\\r\\n]+/"));
  });

  it("rejects UTF-8 BOM and normalizes CRLF line endings", () => {
    assert.throws(() => lex("\uFEFFfn main() -> int { return 1; }"), (err: unknown) => {
      assert.ok(err instanceof SplCompileError);
      assert.equal(err.diagnostics[0].code, "E_LEX_BOM");
      return true;
    });

    const ast = parse("fn main() -> int {\r\n  // line comment\r\n  /* block\r\n  comment */\r\n  return 42;\r\n}\r\n");
    assert.equal(ast.functions.length, 1);
    assert.equal(ast.functions[0].name, "main");
  });

  it("parses INT64_MIN, hex ints, floats, and unicode escapes", async () => {
    const src = `
      fn main() -> { min_i: int, hex_i: int, f: float, s: string } {
        return {
          min_i: -9223372036854775808,
          hex_i: 0xFF_00,
          f: 1_000.5e-1,
          s: "hi \\u{1F600}\\n"
        };
      }
    `;
    const compiled = compileSource(src, createEmptyCatalog());
    const trace = await runVm({ bytecode: compiled.text });
    assert.equal(trace.result.status, "ok");
    assert.deepStrictEqual(trace.result.value, {
      f: 100.05,
      hex_i: 0xff00n,
      min_i: INT64_MIN,
      s: "hi 😀\n",
    });
  });

  it("rejects out-of-range positive int64 literal", () => {
    assert.throws(() => parse("fn main() -> int { return 9223372036854775808; }"), (err: unknown) => {
      assert.ok(err instanceof SplCompileError);
      assert.equal(err.diagnostics[0].code, "E_INT_OVERFLOW");
      return true;
    });
  });

  it("enforces exact operator precedence from §3.2", async () => {
    const src = `
      fn main() -> { a: int, b: bool, c: int, d: int } {
        let opt: int? = null;
        return {
          a: 1 + 2 * 3 - 4 / 2,
          b: true || false && false,
          c: (1 | 2 ^ 3 & 1) + (1 << 3),
          d: opt ?? 10 + 5
        };
      }
    `;
    const compiled = compileSource(src, createEmptyCatalog());
    const trace = await runVm({ bytecode: compiled.text });
    assert.equal(trace.result.status, "ok");
    assert.deepStrictEqual(trace.result.value, {
      a: 5n,
      b: true,
      c: 11n, // (1 | (2 ^ (3 & 1))) + 8 = (1 | 3) + 8 = 3 + 8 = 11
      d: 15n,
    });
  });

  it("parses template strings with expressions and nested record braces", async () => {
    const src = `
      fn main() -> string {
        let n = 7;
        let ok = true;
        let f = 2.5;
        let r = \`n=\${n}, ok=\${ok}, f=\${f}, obj=\${json.stringify({ a: 1, b: "x" })}\`;
        return r;
      }
    `;
    const compiled = compileSource(src, createEmptyCatalog());
    const trace = await runVm({ bytecode: compiled.text });
    assert.equal(trace.result.status, "ok");
    assert.equal(trace.result.value, 'n=7, ok=true, f=2.5, obj={"a":1,"b":"x"}');
  });

  it("supports script-shorthand entry lowering and rejects duplicate/missing entry", async () => {
    const scriptSrc = `
      input x: int;
      let y = x * 2;
      return y + 1;
    `;
    const compiled = compileSource(scriptSrc, createEmptyCatalog());
    const trace = await runVm({ bytecode: compiled.text, inputs: { x: 20 } });
    assert.equal(trace.result.status, "ok");
    assert.equal(trace.result.value, 41n);

    assert.throws(
      () => compileSource("fn main() -> int { return 1; } let x = 2;", createEmptyCatalog()),
      (err: unknown) => err instanceof SplCompileError && err.diagnostics.some((d) => d.code === "E_DUPLICATE_ENTRY")
    );

    assert.throws(
      () => compileSource("type A = int;", createEmptyCatalog()),
      (err: unknown) => err instanceof SplCompileError && err.diagnostics.some((d) => d.code === "E_MISSING_ENTRY")
    );
  });
});
