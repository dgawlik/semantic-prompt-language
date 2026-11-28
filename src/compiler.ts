import { SignatureCatalog, computeCatalogSha256 } from "./catalog.js";
import {
  SplValue,
  canonicalJsonParse,
  canonicalJsonStringify,
  compareCodePoints,
  escapeJsonString,
  formatFloatCanonical,
  sha256Hex,
} from "./canonical.js";
import { CheckedFunction, CheckedProgram, ExprMeta, StmtMeta, checkProgram } from "./checker.js";
import { parse } from "./parser.js";
import {
  BlockStmt,
  Expr,
  JsonSchema,
  ProgramAst,
  SplType,
  Stmt,
  canonicalTypeString,
  parseCanonicalTypeString,
} from "./types.js";

export type ConstEntry =
  | { kind: "I"; value: bigint }
  | { kind: "F"; value: number }
  | { kind: "S"; value: string }
  | { kind: "J"; value: SplValue };

export interface BytecodeInputDecl {
  name: string;
  type: SplType;
  defaultRef: string; // "NONE", "c<idx>", or "fn:<name>"
}

export interface BytecodeStateDecl {
  name: string;
  type: SplType;
  initRef: string; // "c<idx>" or "fn:<name>"
}

export interface Instruction {
  op: string;
  args: string[];
}

export interface BytecodeFunction {
  name: string;
  paramTypes: SplType[];
  retType: SplType;
  locals: number;
  code: Instruction[];
}

export interface BytecodeProgram {
  specVersion: "5";
  catalogSha256: string;
  capabilities: string[];
  inputs: BytecodeInputDecl[];
  states: BytecodeStateDecl[];
  consts: ConstEntry[];
  schemas: JsonSchema[];
  functions: BytecodeFunction[];
}

export interface CompileResult {
  program: BytecodeProgram;
  text: string;
  sha256: string;
  checked: CheckedProgram;
}

export function compileSource(source: string, catalog: SignatureCatalog): CompileResult {
  const ast = parse(source);
  return compileAst(ast, catalog);
}

export function compileAst(ast: ProgramAst, catalog: SignatureCatalog): CompileResult {
  const checked = checkProgram(ast, catalog);
  const compiler = new BytecodeCompiler(checked, catalog);
  const program = compiler.compile();
  const text = serializeBytecode(program);
  const sha256 = sha256Hex(text);
  return { program, text, sha256, checked };
}

interface LoopContext {
  breakPatches: number[];
  continuePatches: number[];
  tryDepth: number;
}

class BytecodeCompiler {
  private consts: ConstEntry[] = [];
  private constIndex = new Map<string, number>();

  private schemas: JsonSchema[] = [];
  private schemaIndex = new Map<string, number>();

  private syntheticInitFns: BytecodeFunction[] = [];

  constructor(
    private readonly checked: CheckedProgram,
    private readonly catalog: SignatureCatalog
  ) {}

  private addConst(entry: ConstEntry): string {
    let key: string;
    switch (entry.kind) {
      case "I":
        key = `I:${entry.value.toString(10)}`;
        break;
      case "F":
        key = `F:${formatFloatCanonical(entry.value)}`;
        break;
      case "S":
        key = `S:${escapeJsonString(entry.value)}`;
        break;
      case "J":
        key = `J:${canonicalJsonStringify(entry.value)}`;
        break;
    }
    const existing = this.constIndex.get(key);
    if (existing !== undefined) return `c${existing}`;
    const idx = this.consts.length;
    this.consts.push(entry);
    this.constIndex.set(key, idx);
    return `c${idx}`;
  }

  private addSchema(schema: JsonSchema): string {
    const key = canonicalJsonStringify(schema);
    const existing = this.schemaIndex.get(key);
    if (existing !== undefined) return `s${existing}`;
    const idx = this.schemas.length;
    this.schemas.push(canonicalJsonParse(key) as JsonSchema);
    this.schemaIndex.set(key, idx);
    return `s${idx}`;
  }

  private tryConstExpr(expr: Expr): ConstEntry | null {
    switch (expr.kind) {
      case "lit_int":
        return { kind: "I", value: expr.value };
      case "lit_float":
        return { kind: "F", value: expr.value };
      case "lit_string":
        return { kind: "S", value: expr.value };
      case "lit_bool":
        return { kind: "J", value: expr.value };
      case "lit_null":
        return { kind: "J", value: null };
      default:
        return null;
    }
  }

  compile(): BytecodeProgram {
    const inputs: BytecodeInputDecl[] = [];
    for (const inp of this.checked.inputs) {
      let defaultRef = "NONE";
      if (inp.defaultExpr) {
        const ce = this.tryConstExpr(inp.defaultExpr);
        if (ce) {
          defaultRef = this.addConst(ce);
        } else {
          const fnName = `__init_input_${inp.name}`;
          this.syntheticInitFns.push(this.compileExprInitFn(fnName, inp.type, inp.defaultExpr));
          defaultRef = `fn:${fnName}`;
        }
      }
      inputs.push({ name: inp.name, type: inp.type, defaultRef });
    }

    const states: BytecodeStateDecl[] = [];
    for (const st of this.checked.states) {
      let initRef: string;
      const ce = this.tryConstExpr(st.initExpr);
      if (ce) {
        initRef = this.addConst(ce);
      } else {
        const fnName = `__init_state_${st.name}`;
        this.syntheticInitFns.push(this.compileExprInitFn(fnName, st.type, st.initExpr));
        initRef = `fn:${fnName}`;
      }
      states.push({ name: st.name, type: st.type, initRef });
    }

    // §8.1: Sort functions lexicographically, with `main` always emitted last
    const sortedCheckedFns = [...this.checked.functions].sort((a, b) => {
      if (a.name === "main" && b.name !== "main") return 1;
      if (b.name === "main" && a.name !== "main") return -1;
      return compareCodePoints(a.name, b.name);
    });

    const compiledFns: BytecodeFunction[] = [...this.syntheticInitFns].sort((a, b) =>
      compareCodePoints(a.name, b.name)
    );
    for (const fn of sortedCheckedFns) {
      compiledFns.push(this.compileFunction(fn));
    }

    return {
      specVersion: "5",
      catalogSha256: computeCatalogSha256(this.catalog),
      capabilities: [...this.checked.capabilities],
      inputs,
      states,
      consts: this.consts,
      schemas: this.schemas,
      functions: compiledFns,
    };
  }

  private compileExprInitFn(name: string, retType: SplType, expr: Expr): BytecodeFunction {
    const fc = new FnCompiler(
      this.checked.exprMeta,
      this.checked.stmtMeta,
      (e) => this.addConst(e),
      (s) => this.addSchema(s),
      0
    );
    fc.emitExpr(expr);
    fc.emit("RET");
    return {
      name,
      paramTypes: [],
      retType,
      locals: fc.totalLocals,
      code: fc.code,
    };
  }

  private compileFunction(fn: CheckedFunction): BytecodeFunction {
    const fc = new FnCompiler(
      this.checked.exprMeta,
      this.checked.stmtMeta,
      (e) => this.addConst(e),
      (s) => this.addSchema(s),
      fn.localsCount
    );
    fc.emitBlock(fn.body);
    // Ensure trailing return for void functions or fallthrough safety
    if (fc.code.length === 0 || fc.code[fc.code.length - 1].op !== "RET") {
      fc.emit("PUSH_NULL");
      fc.emit("RET");
    }
    return {
      name: fn.name,
      paramTypes: fn.params.map((p) => p.type),
      retType: fn.retType,
      locals: fc.totalLocals,
      code: fc.code,
    };
  }
}

class FnCompiler {
  readonly code: Instruction[] = [];
  totalLocals: number;
  private loopStack: LoopContext[] = [];
  private activeTryDepth = 0;

  constructor(
    private readonly exprMeta: Map<Expr, ExprMeta>,
    private readonly stmtMeta: Map<Stmt, StmtMeta>,
    private readonly addConst: (e: ConstEntry) => string,
    private readonly addSchema: (s: JsonSchema) => string,
    initialLocals: number
  ) {
    this.totalLocals = initialLocals;
  }

  private allocTempSlot(): number {
    return this.totalLocals++;
  }

  emit(op: string, ...args: string[]): number {
    const idx = this.code.length;
    this.code.push({ op, args });
    return idx;
  }

  private patchJump(instrIdx: number, targetPc: number): void {
    this.code[instrIdx].args[0] = formatPc(targetPc);
  }

  emitBlock(block: BlockStmt): void {
    for (const stmt of block.stmts) {
      this.emitStmt(stmt);
    }
  }

  private emitStmt(stmt: Stmt): void {
    const sm = this.stmtMeta.get(stmt);
    switch (stmt.kind) {
      case "let": {
        this.emitExpr(stmt.init);
        this.emit("STORE_LOCAL", String(sm!.localSlot!));
        return;
      }

      case "assign": {
        const root = sm!.assignRoot!;
        const segs = stmt.target.segments;
        if (segs.length === 0) {
          this.emitExpr(stmt.value);
          if (root.kind === "local") this.emit("STORE_LOCAL", String(root.slot));
          else if (root.kind === "state") this.emit("STORE_STATE", String(root.index));
          return;
        }

        // Load root container
        if (root.kind === "local") this.emit("LOAD_LOCAL", String(root.slot));
        else if (root.kind === "state") this.emit("LOAD_STATE", String(root.index));

        const indexTemps: Array<number | null> = [];
        for (let i = 0; i < segs.length - 1; i++) {
          const seg = segs[i];
          if (seg.kind === "field") {
            const keyConst = this.addConst({ kind: "S", value: seg.name });
            this.emit("DUP");
            this.emit("GET_FIELD", keyConst);
            indexTemps.push(null);
          } else {
            const tIdx = this.allocTempSlot();
            this.emitExpr(seg.index);
            this.emit("STORE_LOCAL", String(tIdx));
            this.emit("DUP");
            this.emit("LOAD_LOCAL", String(tIdx));
            this.emit("GET_INDEX");
            indexTemps.push(tIdx);
          }
        }

        const last = segs[segs.length - 1];
        if (last.kind === "field") {
          const keyConst = this.addConst({ kind: "S", value: last.name });
          this.emitExpr(stmt.value);
          this.emit("SET_FIELD", keyConst);
        } else {
          this.emitExpr(last.index);
          this.emitExpr(stmt.value);
          this.emit("SET_INDEX");
        }

        // Unwind nested value-semantic updates
        for (let i = segs.length - 2; i >= 0; i--) {
          const seg = segs[i];
          if (seg.kind === "field") {
            const keyConst = this.addConst({ kind: "S", value: seg.name });
            this.emit("SET_FIELD", keyConst);
          } else {
            const tVal = this.allocTempSlot();
            this.emit("STORE_LOCAL", String(tVal));
            this.emit("LOAD_LOCAL", String(indexTemps[i]!));
            this.emit("LOAD_LOCAL", String(tVal));
            this.emit("SET_INDEX");
          }
        }

        if (root.kind === "local") this.emit("STORE_LOCAL", String(root.slot));
        else if (root.kind === "state") this.emit("STORE_STATE", String(root.index));
        return;
      }

      case "if": {
        this.emitExpr(stmt.cond);
        const jmpFalse = this.emit("JMP_IF_FALSE", "0000");
        this.emitBlock(stmt.thenBlock);
        if (stmt.elseBranch) {
          const jmpEnd = this.emit("JMP", "0000");
          this.patchJump(jmpFalse, this.code.length);
          if (stmt.elseBranch.kind === "if") {
            this.emitStmt(stmt.elseBranch);
          } else {
            this.emitBlock(stmt.elseBranch);
          }
          this.patchJump(jmpEnd, this.code.length);
        } else {
          this.patchJump(jmpFalse, this.code.length);
        }
        return;
      }

      case "switch": {
        const discSlot = this.allocTempSlot();
        this.emitExpr(stmt.discriminant);
        this.emit("STORE_LOCAL", String(discSlot));

        const endJumps: number[] = [];
        for (const c of stmt.cases) {
          if (c.literals.length === 1) {
            this.emit("LOAD_LOCAL", String(discSlot));
            this.emitCaseLiteral(c.literals[0]);
            this.emit("EQ");
            const skipCase = this.emit("JMP_IF_FALSE", "0000");
            this.emitBlock(c.body);
            if (this.code.length === 0 || this.code[this.code.length - 1].op !== "RET") {
              endJumps.push(this.emit("JMP", "0000"));
            }
            this.patchJump(skipCase, this.code.length);
          } else {
            const matchJumps: number[] = [];
            for (const lit of c.literals) {
              this.emit("LOAD_LOCAL", String(discSlot));
              this.emitCaseLiteral(lit);
              this.emit("EQ");
              matchJumps.push(this.emit("JMP_IF_TRUE", "0000"));
            }
            const skipCase = this.emit("JMP", "0000");
            const bodyPc = this.code.length;
            for (const mj of matchJumps) this.patchJump(mj, bodyPc);
            this.emitBlock(c.body);
            if (this.code.length === 0 || this.code[this.code.length - 1].op !== "RET") {
              endJumps.push(this.emit("JMP", "0000"));
            }
            this.patchJump(skipCase, this.code.length);
          }
        }
        if (stmt.defaultBlock) {
          this.emitBlock(stmt.defaultBlock);
        }
        const endPc = this.code.length;
        for (const ej of endJumps) this.patchJump(ej, endPc);
        return;
      }

      case "while": {
        const loopStart = this.code.length;
        this.emitExpr(stmt.cond);
        const jmpEnd = this.emit("JMP_IF_FALSE", "0000");
        const ctx: LoopContext = { breakPatches: [], continuePatches: [], tryDepth: this.activeTryDepth };
        this.loopStack.push(ctx);
        this.emitBlock(stmt.body);
        this.loopStack.pop();
        for (const cp of ctx.continuePatches) this.patchJump(cp, loopStart);
        this.emit("JMP", formatPc(loopStart));
        const endPc = this.code.length;
        this.patchJump(jmpEnd, endPc);
        for (const bp of ctx.breakPatches) this.patchJump(bp, endPc);
        return;
      }

      case "for": {
        const listSlot = sm!.forListSlot!;
        const idxSlot = sm!.forIndexSlot!;
        const itemSlot = sm!.forItemSlot!;
        const cZero = this.addConst({ kind: "I", value: 0n });
        const cOne = this.addConst({ kind: "I", value: 1n });

        this.emitExpr(stmt.iterable);
        this.emit("STORE_LOCAL", String(listSlot));
        this.emit("PUSH_CONST", cZero);
        this.emit("STORE_LOCAL", String(idxSlot));

        const loopStart = this.code.length;
        this.emit("LOAD_LOCAL", String(idxSlot));
        this.emit("LOAD_LOCAL", String(listSlot));
        this.emit("LIST_LEN");
        this.emit("ILT");
        const jmpEnd = this.emit("JMP_IF_FALSE", "0000");

        this.emit("LOAD_LOCAL", String(listSlot));
        this.emit("LOAD_LOCAL", String(idxSlot));
        this.emit("GET_INDEX");
        this.emit("STORE_LOCAL", String(itemSlot));

        const ctx: LoopContext = { breakPatches: [], continuePatches: [], tryDepth: this.activeTryDepth };
        this.loopStack.push(ctx);
        this.emitBlock(stmt.body);
        this.loopStack.pop();

        const stepPc = this.code.length;
        for (const cp of ctx.continuePatches) this.patchJump(cp, stepPc);
        this.emit("LOAD_LOCAL", String(idxSlot));
        this.emit("PUSH_CONST", cOne);
        this.emit("IADD");
        this.emit("STORE_LOCAL", String(idxSlot));
        this.emit("JMP", formatPc(loopStart));

        const endPc = this.code.length;
        this.patchJump(jmpEnd, endPc);
        for (const bp of ctx.breakPatches) this.patchJump(bp, endPc);
        return;
      }

      case "try": {
        const pushIdx = this.emit("TRY_PUSH", "0000");
        this.activeTryDepth++;
        this.emitBlock(stmt.tryBlock);
        this.activeTryDepth--;
        this.emit("TRY_POP");
        const jmpAfterCatch = this.emit("JMP", "0000");

        const catchPc = this.code.length;
        this.patchJump(pushIdx, catchPc);
        this.emit("STORE_LOCAL", String(sm!.catchSlot!));
        this.emitBlock(stmt.catchBlock);

        this.patchJump(jmpAfterCatch, this.code.length);
        return;
      }

      case "return": {
        if (stmt.value) {
          this.emitExpr(stmt.value);
        } else {
          this.emit("PUSH_NULL");
        }
        this.emit("RET");
        return;
      }

      case "break": {
        const ctx = this.loopStack[this.loopStack.length - 1];
        for (let i = 0; i < this.activeTryDepth - ctx.tryDepth; i++) {
          this.emit("TRY_POP");
        }
        ctx.breakPatches.push(this.emit("JMP", "0000"));
        return;
      }

      case "continue": {
        const ctx = this.loopStack[this.loopStack.length - 1];
        for (let i = 0; i < this.activeTryDepth - ctx.tryDepth; i++) {
          this.emit("TRY_POP");
        }
        ctx.continuePatches.push(this.emit("JMP", "0000"));
        return;
      }

      case "expr_stmt": {
        this.emitExpr(stmt.expr);
        this.emit("POP");
        return;
      }
    }
  }

  private emitCaseLiteral(lit: { kind: "string"; value: string } | { kind: "int"; value: bigint } | { kind: "bool"; value: boolean }): void {
    if (lit.kind === "string") {
      this.emit("PUSH_CONST", this.addConst({ kind: "S", value: lit.value }));
    } else if (lit.kind === "int") {
      this.emit("PUSH_CONST", this.addConst({ kind: "I", value: lit.value }));
    } else {
      this.emit(lit.value ? "PUSH_TRUE" : "PUSH_FALSE");
    }
  }

  emitExpr(expr: Expr): void {
    const meta = this.exprMeta.get(expr)!;
    switch (expr.kind) {
      case "lit_null":
        this.emit("PUSH_NULL");
        return;
      case "lit_bool":
        this.emit(expr.value ? "PUSH_TRUE" : "PUSH_FALSE");
        return;
      case "lit_int":
        this.emit("PUSH_CONST", this.addConst({ kind: "I", value: expr.value }));
        return;
      case "lit_float":
        this.emit("PUSH_CONST", this.addConst({ kind: "F", value: expr.value }));
        return;
      case "lit_string":
        this.emit("PUSH_CONST", this.addConst({ kind: "S", value: expr.value }));
        return;

      case "template_str": {
        if (expr.parts.length === 0) {
          this.emit("PUSH_CONST", this.addConst({ kind: "S", value: "" }));
          return;
        }
        for (const p of expr.parts) {
          if (p.kind === "text") {
            this.emit("PUSH_CONST", this.addConst({ kind: "S", value: p.value }));
          } else {
            this.emitExpr(p.expr);
            this.emit("FMT_VAL");
          }
        }
        if (expr.parts.length > 1) {
          this.emit("STR_CONCAT", String(expr.parts.length));
        }
        return;
      }

      case "list_lit": {
        for (const item of expr.items) {
          this.emitExpr(item);
        }
        this.emit("MAKE_LIST", String(expr.items.length));
        return;
      }

      case "record_lit": {
        // §9.1: evaluate entries in source order, then assemble in canonical key order
        for (const entry of expr.entries) {
          this.emit("PUSH_CONST", this.addConst({ kind: "S", value: entry.key }));
          this.emitExpr(entry.value);
        }
        this.emit(meta.isMapLiteral ? "MAKE_MAP" : "MAKE_REC", String(expr.entries.length));
        return;
      }

      case "var_ref": {
        const b = meta.resolvedBinding!;
        if (b.kind === "local") this.emit("LOAD_LOCAL", String(b.slot));
        else if (b.kind === "input") this.emit("LOAD_INPUT", String(b.index));
        else this.emit("LOAD_STATE", String(b.index));
        return;
      }

      case "unary": {
        this.emitExpr(expr.operand);
        if (expr.op === "!") this.emit("NOT");
        else if (expr.op === "~") this.emit("BIT_NOT");
        else if (expr.op === "-") {
          this.emit(meta.type.kind === "float" ? "FNEG" : "INEG");
        }
        return;
      }

      case "binary": {
        if (expr.op === "&&") {
          this.emitExpr(expr.left);
          this.emit("DUP");
          const jmp = this.emit("JMP_IF_FALSE", "0000");
          this.emit("POP");
          this.emitExpr(expr.right);
          this.patchJump(jmp, this.code.length);
          return;
        }
        if (expr.op === "||") {
          this.emitExpr(expr.left);
          this.emit("DUP");
          const jmp = this.emit("JMP_IF_TRUE", "0000");
          this.emit("POP");
          this.emitExpr(expr.right);
          this.patchJump(jmp, this.code.length);
          return;
        }
        if (expr.op === "??") {
          this.emitExpr(expr.left);
          const jmp = this.emit("JMP_IF_NOT_NULL", "0000");
          this.emit("POP");
          this.emitExpr(expr.right);
          this.patchJump(jmp, this.code.length);
          return;
        }

        const lt = this.exprMeta.get(expr.left)!.type;
        this.emitExpr(expr.left);
        this.emitExpr(expr.right);

        switch (expr.op) {
          case "==":
            this.emit("EQ");
            return;
          case "!=":
            this.emit("NEQ");
            return;
          case "&":
            this.emit("BIT_AND");
            return;
          case "|":
            this.emit("BIT_OR");
            return;
          case "^":
            this.emit("BIT_XOR");
            return;
          case "<<":
            this.emit("SHL");
            return;
          case ">>":
            this.emit("SHR");
            return;
          case ">>>":
            this.emit("USHR");
            return;
          case "+":
            if (lt.kind === "string" || lt.kind === "str_union") this.emit("STR_CONCAT", "2");
            else if (lt.kind === "float") this.emit("FADD");
            else this.emit("IADD");
            return;
          case "-":
            this.emit(lt.kind === "float" ? "FSUB" : "ISUB");
            return;
          case "*":
            this.emit(lt.kind === "float" ? "FMUL" : "IMUL");
            return;
          case "/":
            this.emit(lt.kind === "float" ? "FDIV" : "IDIV");
            return;
          case "%":
            this.emit("IMOD");
            return;
          case "<":
            this.emit(lt.kind === "float" ? "FLT" : lt.kind === "int" ? "ILT" : "SLT");
            return;
          case "<=":
            this.emit(lt.kind === "float" ? "FLE" : lt.kind === "int" ? "ILE" : "SLE");
            return;
          case ">":
            this.emit(lt.kind === "float" ? "FGT" : lt.kind === "int" ? "IGT" : "SGT");
            return;
          case ">=":
            this.emit(lt.kind === "float" ? "FGE" : lt.kind === "int" ? "IGE" : "SGE");
            return;
        }
      }

      case "cast": {
        this.emitExpr(expr.expr);
        if (meta.castKind === "i2f") this.emit("CAST_I2F");
        else if (meta.castKind === "f2i") this.emit("CAST_F2I");
        else if (meta.castKind === "json") {
          const sRef = this.addSchema(meta.schema!);
          this.emit("CAST_JSON", sRef);
        }
        return;
      }

      case "prop_access": {
        this.emitExpr(expr.object);
        const cKey = this.addConst({ kind: "S", value: expr.property });
        this.emit(expr.optional ? "GET_FIELD_OPT" : "GET_FIELD", cKey);
        return;
      }

      case "index_access": {
        if (expr.optional) {
          this.emitExpr(expr.object);
          const jmpNull = this.emit("JMP_IF_NULL", "0000");
          this.emitExpr(expr.index);
          this.emit("GET_INDEX_OPT");
          this.patchJump(jmpNull, this.code.length);
        } else {
          this.emitExpr(expr.object);
          this.emitExpr(expr.index);
          this.emit("GET_INDEX");
        }
        return;
      }

      case "call": {
        for (const arg of expr.args) {
          this.emitExpr(arg);
        }
        if (meta.builtinId) {
          this.emit("CALL_BUILTIN", meta.builtinId, String(expr.args.length));
        } else {
          this.emit("CALL_FN", meta.fnName!, String(expr.args.length));
        }
        return;
      }

      case "eff_ask": {
        const prof = (expr.args[0] as Extract<Expr, { kind: "lit_string" }>).value;
        const cProf = this.addConst({ kind: "S", value: prof });
        const sRef = this.addSchema(meta.schema!);
        this.emitExpr(expr.args[1]);
        const hasOpts = expr.args.length === 3 ? "1" : "0";
        if (expr.args[2]) this.emitExpr(expr.args[2]);
        this.emit("EFF_ASK", cProf, sRef, hasOpts);
        return;
      }

      case "eff_decide": {
        const prof = (expr.args[0] as Extract<Expr, { kind: "lit_string" }>).value;
        const cProf = this.addConst({ kind: "S", value: prof });
        this.emitExpr(expr.args[1]);
        const cOpts = this.addConst({ kind: "J", value: meta.decideOptions! });
        const hasCfg = expr.args.length === 4 ? "1" : "0";
        if (expr.args[3]) this.emitExpr(expr.args[3]);
        this.emit("EFF_DECIDE", cProf, cOpts, hasCfg);
        return;
      }

      case "eff_web_search": {
        this.emitExpr(expr.args[0]);
        const hasOpts = expr.args.length === 2 ? "1" : "0";
        if (expr.args[1]) this.emitExpr(expr.args[1]);
        this.emit("EFF_WEB_SEARCH", hasOpts);
        return;
      }

      case "eff_web_fetch": {
        this.emitExpr(expr.args[0]);
        const hasOpts = expr.args.length === 2 ? "1" : "0";
        if (expr.args[1]) this.emitExpr(expr.args[1]);
        this.emit("EFF_WEB_FETCH", hasOpts);
        return;
      }

      case "eff_fs": {
        const root = (expr.args[0] as Extract<Expr, { kind: "lit_string" }>).value;
        const cRoot = this.addConst({ kind: "S", value: root });
        this.emitExpr(expr.args[1]);
        if (expr.args[2]) this.emitExpr(expr.args[2]);
        this.emit("EFF_FS", expr.op, cRoot);
        return;
      }

      case "eff_shell": {
        const prof = (expr.args[0] as Extract<Expr, { kind: "lit_string" }>).value;
        const cProf = this.addConst({ kind: "S", value: prof });
        const sRef = this.addSchema(meta.schema!);
        this.emitExpr(expr.args[1]);
        this.emit("EFF_SHELL", cProf, sRef);
        return;
      }

      case "eff_js_tool": {
        const cName = this.addConst({ kind: "S", value: expr.name });
        const sRef = this.addSchema(meta.schema!);
        this.emitExpr(expr.arg);
        this.emit("EFF_JS_TOOL", cName, sRef);
        return;
      }

      case "eff_mcp_tool": {
        const cSrv = this.addConst({ kind: "S", value: expr.server });
        const cTool = this.addConst({ kind: "S", value: expr.tool });
        const sRef = this.addSchema(meta.schema!);
        this.emitExpr(expr.arg);
        this.emit("EFF_MCP_TOOL", cSrv, cTool, sRef);
        return;
      }
    }
  }
}

function formatPc(pc: number): string {
  const s = String(pc);
  return s.length < 4 ? s.padStart(4, "0") : s;
}

/**
 * §8.1 Canonical UTF-8 textual bytecode serializer.
 */
export function serializeBytecode(prog: BytecodeProgram): string {
  const lines: string[] = [];
  lines.push("SPLB 5");
  lines.push(`CATALOG ${prog.catalogSha256}`);
  lines.push(`CAPS ${canonicalJsonStringify(prog.capabilities)}`);

  lines.push("INPUTS");
  for (const inp of prog.inputs) {
    lines.push(`  ${inp.name} ${canonicalTypeString(inp.type)} ${inp.defaultRef}`);
  }

  lines.push("STATE");
  for (const st of prog.states) {
    lines.push(`  ${st.name} ${canonicalTypeString(st.type)} ${st.initRef}`);
  }

  lines.push("CONSTS");
  for (let i = 0; i < prog.consts.length; i++) {
    const c = prog.consts[i];
    let lit: string;
    if (c.kind === "I") lit = c.value.toString(10);
    else if (c.kind === "F") lit = formatFloatCanonical(c.value);
    else if (c.kind === "S") lit = escapeJsonString(c.value);
    else lit = canonicalJsonStringify(c.value);
    lines.push(`  c${i} ${c.kind} ${lit}`);
  }

  lines.push("SCHEMAS");
  for (let i = 0; i < prog.schemas.length; i++) {
    lines.push(`  s${i} ${canonicalJsonStringify(prog.schemas[i])}`);
  }

  for (const fn of prog.functions) {
    const paramsStr = fn.paramTypes.map(canonicalTypeString).join(",");
    lines.push(`FN ${fn.name} (${paramsStr}) -> ${canonicalTypeString(fn.retType)} locals=${fn.locals}`);
    for (let pc = 0; pc < fn.code.length; pc++) {
      const ins = fn.code[pc];
      const argStr = ins.args.length > 0 ? " " + ins.args.join(" ") : "";
      lines.push(`  ${formatPc(pc)}: ${ins.op}${argStr}`);
    }
    lines.push("END");
  }

  return lines.join("\n") + "\n";
}

/**
 * Lossless parser for canonical `SPLB 5` textual bytecode.
 */
export function parseBytecode(text: string): BytecodeProgram {
  const normalized = text.replace(/\r\n/g, "\n");
  if (!normalized.endsWith("\n")) {
    throw new Error("SPLB 5 bytecode must end with a trailing LF newline");
  }
  const lines = normalized.slice(0, -1).split("\n");
  let i = 0;

  const expectLine = (): string => {
    if (i >= lines.length) throw new Error("Unexpected end of SPLB 5 bytecode");
    return lines[i++];
  };

  if (expectLine() !== "SPLB 5") throw new Error("Invalid SPLB header; expected 'SPLB 5'");

  const catLine = expectLine();
  if (!catLine.startsWith("CATALOG ")) throw new Error("Expected CATALOG header");
  const catalogSha256 = catLine.slice("CATALOG ".length);

  const capsLine = expectLine();
  if (!capsLine.startsWith("CAPS ")) throw new Error("Expected CAPS header");
  const capabilities = canonicalJsonParse(capsLine.slice("CAPS ".length)) as string[];

  if (expectLine() !== "INPUTS") throw new Error("Expected INPUTS section");
  const inputs: BytecodeInputDecl[] = [];
  while (i < lines.length && lines[i].startsWith("  ")) {
    const parts = lines[i++].trim().split(" ");
    if (parts.length !== 3) throw new Error(`Invalid INPUTS entry: ${lines[i - 1]}`);
    inputs.push({ name: parts[0], type: parseCanonicalTypeString(parts[1]), defaultRef: parts[2] });
  }

  if (expectLine() !== "STATE") throw new Error("Expected STATE section");
  const states: BytecodeStateDecl[] = [];
  while (i < lines.length && lines[i].startsWith("  ")) {
    const parts = lines[i++].trim().split(" ");
    if (parts.length !== 3) throw new Error(`Invalid STATE entry: ${lines[i - 1]}`);
    states.push({ name: parts[0], type: parseCanonicalTypeString(parts[1]), initRef: parts[2] });
  }

  if (expectLine() !== "CONSTS") throw new Error("Expected CONSTS section");
  const consts: ConstEntry[] = [];
  while (i < lines.length && lines[i].startsWith("  ")) {
    const trimmed = lines[i++].trim();
    const m = /^c(\d+) ([IFSJ]) (.*)$/.exec(trimmed);
    if (!m || Number(m[1]) !== consts.length) {
      throw new Error(`Invalid CONSTS entry: ${trimmed}`);
    }
    const kind = m[2];
    const payload = m[3];
    if (kind === "I") consts.push({ kind: "I", value: BigInt(payload) });
    else if (kind === "F") consts.push({ kind: "F", value: Number(payload) });
    else if (kind === "S") consts.push({ kind: "S", value: canonicalJsonParse(payload) as string });
    else consts.push({ kind: "J", value: canonicalJsonParse(payload) });
  }

  if (expectLine() !== "SCHEMAS") throw new Error("Expected SCHEMAS section");
  const schemas: JsonSchema[] = [];
  while (i < lines.length && lines[i].startsWith("  ")) {
    const trimmed = lines[i++].trim();
    const m = /^s(\d+) (.*)$/.exec(trimmed);
    if (!m || Number(m[1]) !== schemas.length) {
      throw new Error(`Invalid SCHEMAS entry: ${trimmed}`);
    }
    schemas.push(canonicalJsonParse(m[2]) as JsonSchema);
  }

  const functions: BytecodeFunction[] = [];
  while (i < lines.length) {
    const header = expectLine();
    const fm = /^FN ([A-Za-z_][A-Za-z0-9_]*) \((.*)\) -> ([^ ]+) locals=(\d+)$/.exec(header);
    if (!fm) throw new Error(`Invalid FN header: ${header}`);
    const name = fm[1];
    const paramTypes = fm[2].length === 0 ? [] : splitTopLevelComma(fm[2]).map(parseCanonicalTypeString);
    const retType = parseCanonicalTypeString(fm[3]);
    const locals = Number(fm[4]);
    const code: Instruction[] = [];
    while (i < lines.length && lines[i] !== "END") {
      const insLine = lines[i++].trim();
      const im = /^(\d+): ([A-Z0-9_]+)(?: (.*))?$/.exec(insLine);
      if (!im || Number(im[1]) !== code.length) {
        throw new Error(`Invalid instruction line: ${insLine}`);
      }
      const op = im[2];
      const args = im[3] ? im[3].split(" ") : [];
      code.push({ op, args });
    }
    if (expectLine() !== "END") throw new Error(`Expected END for FN ${name}`);
    functions.push({ name, paramTypes, retType, locals, code });
  }

  return {
    specVersion: "5",
    catalogSha256,
    capabilities,
    inputs,
    states,
    consts,
    schemas,
    functions,
  };
}

function splitTopLevelComma(s: string): string[] {
  const out: string[] = [];
  let depthAngle = 0;
  let depthBrace = 0;
  let depthParen = 0;
  let inStr = false;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (ch === "\\") {
        i++;
      } else if (ch === '"') {
        inStr = false;
      }
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "<") depthAngle++;
    else if (ch === ">") depthAngle--;
    else if (ch === "{") depthBrace++;
    else if (ch === "}") depthBrace--;
    else if (ch === "(") depthParen++;
    else if (ch === ")") depthParen--;
    else if (ch === "," && depthAngle === 0 && depthBrace === 0 && depthParen === 0) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  out.push(s.slice(start));
  return out;
}
