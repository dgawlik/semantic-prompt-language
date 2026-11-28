import { SignatureCatalog, jsonSchemaToSplType } from "./catalog.js";
import { sortKeysCodePoint } from "./canonical.js";
import {
  BlockStmt,
  Expr,
  FnDecl,
  JsonSchema,
  ProgramAst,
  Span,
  SplCompileError,
  SplDiagnostic,
  SplType,
  Stmt,
  T_BOOL,
  T_ERROR,
  T_ERROR_RECORD,
  T_FLOAT,
  T_FS_STAT,
  T_INT,
  T_JSON,
  T_NULL,
  T_SHELL_RESULT,
  T_STRING,
  T_VOID,
  T_WEB_FETCH_RESPONSE,
  T_WEB_SEARCH_RESULT,
  TypeAst,
  canonicalTypeString,
  isAssignable,
  makeList,
  makeMap,
  makeNullable,
  makeRecord,
  makeStrUnion,
  splTypeToJsonSchema,
  typesEqual,
} from "./types.js";

export type BindingKind =
  | { kind: "local"; slot: number; mutable: boolean; type: SplType }
  | { kind: "input"; index: number; type: SplType }
  | { kind: "state"; index: number; type: SplType };

export interface ExprMeta {
  type: SplType;
  resolvedBinding?: BindingKind;
  builtinId?: string;
  fnName?: string;
  schema?: JsonSchema;
  decideOptions?: string[];
  decideHasOpts?: boolean;
  isMapLiteral?: boolean;
  castKind?: "i2f" | "f2i" | "json" | "noop";
}

export interface StmtMeta {
  localSlot?: number;
  forIndexSlot?: number;
  forListSlot?: number;
  forItemSlot?: number;
  catchSlot?: number;
  assignRoot?: BindingKind;
  assignStepKinds?: Array<"field" | "list_index" | "map_index">;
}

export interface CheckedInput {
  index: number;
  name: string;
  type: SplType;
  defaultExpr?: Expr;
}

export interface CheckedState {
  index: number;
  name: string;
  type: SplType;
  initExpr: Expr;
}

export interface CheckedFunction {
  name: string;
  params: Array<{ name: string; type: SplType; slot: number }>;
  retType: SplType;
  body: BlockStmt;
  localsCount: number;
}

export interface CheckedProgram {
  inputs: CheckedInput[];
  states: CheckedState[];
  functions: CheckedFunction[];
  capabilities: string[];
  exprMeta: Map<Expr, ExprMeta>;
  stmtMeta: Map<Stmt, StmtMeta>;
}

const RESERVED_BUILTIN_NS = new Set(["str", "list", "map", "math", "json"]);
const EFFECT_NS = new Set(["model", "web", "fs", "shell", "tool", "mcp"]);

export function checkProgram(ast: ProgramAst, catalog: SignatureCatalog): CheckedProgram {
  const checker = new Checker(ast, catalog);
  return checker.run();
}

class Scope {
  readonly vars = new Map<string, BindingKind>();
  readonly narrowed = new Map<string, SplType>();

  constructor(public readonly parent?: Scope) {}

  lookup(name: string): BindingKind | undefined {
    const v = this.vars.get(name);
    if (v) return v;
    return this.parent?.lookup(name);
  }

  lookupNarrowed(name: string): SplType | undefined {
    const n = this.narrowed.get(name);
    if (n) return n;
    return this.parent?.lookupNarrowed(name);
  }
}

class Checker {
  private diagnostics: SplDiagnostic[] = [];
  private typeAliases = new Map<string, TypeAst>();
  private resolvedAliases = new Map<string, SplType>();
  private resolvingAliases = new Set<string>();

  private inputs = new Map<string, CheckedInput>();
  private states = new Map<string, CheckedState>();
  private fnSigs = new Map<string, { params: SplType[]; retType: SplType; decl: FnDecl }>();
  private capabilities = new Set<string>();

  private exprMeta = new Map<Expr, ExprMeta>();
  private stmtMeta = new Map<Stmt, StmtMeta>();

  private currentFnRetType: SplType = T_VOID;
  private currentNextSlot = 0;
  private loopDepth = 0;
  private pureMode = false;

  constructor(
    private readonly ast: ProgramAst,
    private readonly catalog: SignatureCatalog
  ) {}

  private err(code: string, message: string, span?: Span, expected?: string, found?: string): void {
    this.diagnostics.push({ code, message, span, expected, found });
  }

  run(): CheckedProgram {
    // 1. Register type aliases
    for (const td of this.ast.types) {
      if (this.typeAliases.has(td.name)) {
        this.err("E_DUPLICATE_TYPE", `Duplicate type alias '${td.name}'`, td.span);
      } else {
        this.typeAliases.set(td.name, td.typeAst);
      }
    }
    for (const td of this.ast.types) {
      this.resolveNamedType(td.name, td.span);
    }

    // 2. Register inputs
    const checkedInputs: CheckedInput[] = [];
    for (const inp of this.ast.inputs) {
      if (this.inputs.has(inp.name)) {
        this.err("E_DUPLICATE_INPUT", `Duplicate input '${inp.name}'`, inp.span);
        continue;
      }
      const type = this.resolveTypeAst(inp.typeAst);
      if (type.kind === "void") {
        this.err("E_INVALID_TYPE", "Input cannot have type void", inp.span);
      }
      const ci: CheckedInput = { index: checkedInputs.length, name: inp.name, type, defaultExpr: inp.defaultExpr };
      this.inputs.set(inp.name, ci);
      checkedInputs.push(ci);
    }

    // 3. Register states
    const checkedStates: CheckedState[] = [];
    for (const st of this.ast.states) {
      if (this.states.has(st.name) || this.inputs.has(st.name)) {
        this.err("E_DUPLICATE_STATE", `Duplicate top-level binding '${st.name}'`, st.span);
        continue;
      }
      const type = this.resolveTypeAst(st.typeAst);
      if (type.kind === "void") {
        this.err("E_INVALID_TYPE", "State cannot have type void", st.span);
      }
      const cs: CheckedState = { index: checkedStates.length, name: st.name, type, initExpr: st.initExpr };
      this.states.set(st.name, cs);
      checkedStates.push(cs);
    }

    // 4. Normalize entry point (§3.3)
    const allFns: FnDecl[] = [...this.ast.functions];
    const hasMain = allFns.some((f) => f.name === "main");
    const hasTopStmts = this.ast.topStmts.length > 0;
    if (hasMain && hasTopStmts) {
      this.err(
        "E_DUPLICATE_ENTRY",
        "Program cannot declare both fn main and top-level executable statements",
        this.ast.topStmts[0].span
      );
    } else if (!hasMain && !hasTopStmts) {
      this.err("E_MISSING_ENTRY", "Program must define fn main or top-level statements", this.ast.span);
    }

    let syntheticMainBody: BlockStmt | null = null;
    if (!hasMain && hasTopStmts) {
      syntheticMainBody = {
        kind: "block",
        stmts: this.ast.topStmts,
        span: this.ast.span,
      };
    }

    // 5. Register function signatures
    for (const fn of allFns) {
      if (this.fnSigs.has(fn.name)) {
        this.err("E_DUPLICATE_FN", `Duplicate function '${fn.name}'`, fn.span);
        continue;
      }
      const params = fn.params.map((p) => {
        const pt = this.resolveTypeAst(p.typeAst);
        if (pt.kind === "void") this.err("E_INVALID_TYPE", `Parameter '${p.name}' cannot be void`, p.span);
        return pt;
      });
      const retType = this.resolveTypeAst(fn.retTypeAst);
      if (fn.name === "main" && params.length > 0) {
        this.err("E_MAIN_SIGNATURE", "fn main must take 0 parameters (use `input` declarations)", fn.span);
      }
      this.fnSigs.set(fn.name, { params, retType, decl: fn });
    }

    // 6. Check pure input defaults & state initializers
    const emptyScope = new Scope();
    for (const ci of checkedInputs) {
      if (ci.defaultExpr) {
        this.pureMode = true;
        const dt = this.checkExpr(ci.defaultExpr, emptyScope, ci.type);
        this.pureMode = false;
        if (!isAssignable(dt, ci.type)) {
          this.err(
            "E_TYPE_MISMATCH",
            `Default value for input '${ci.name}' has incompatible type`,
            ci.defaultExpr.span,
            canonicalTypeString(ci.type),
            canonicalTypeString(dt)
          );
        }
      }
    }
    for (const cs of checkedStates) {
      this.pureMode = true;
      const it = this.checkExpr(cs.initExpr, emptyScope, cs.type);
      this.pureMode = false;
      if (!isAssignable(it, cs.type)) {
        this.err(
          "E_TYPE_MISMATCH",
          `Initial value for state '${cs.name}' has incompatible type`,
          cs.initExpr.span,
          canonicalTypeString(cs.type),
          canonicalTypeString(it)
        );
      }
    }

    // 7. Check all declared functions
    const checkedFunctions: CheckedFunction[] = [];
    for (const fn of allFns) {
      const sig = this.fnSigs.get(fn.name);
      if (!sig) continue;
      checkedFunctions.push(this.checkFunction(fn, sig.params, sig.retType));
    }

    // 8. Check synthetic main if script-shorthand
    if (syntheticMainBody) {
      checkedFunctions.push(this.checkSyntheticMain(syntheticMainBody));
    }

    if (this.diagnostics.length > 0) {
      throw new SplCompileError(this.diagnostics);
    }

    return {
      inputs: checkedInputs,
      states: checkedStates,
      functions: checkedFunctions,
      capabilities: sortKeysCodePoint(this.capabilities),
      exprMeta: this.exprMeta,
      stmtMeta: this.stmtMeta,
    };
  }

  private resolveNamedType(name: string, span: Span): SplType {
    const cached = this.resolvedAliases.get(name);
    if (cached) return cached;
    if (this.resolvingAliases.has(name)) {
      this.err("E_RECURSIVE_TYPE", `Recursive type alias '${name}' is forbidden in SPL v5`, span);
      return T_JSON;
    }
    const ast = this.typeAliases.get(name);
    if (!ast) {
      this.err("E_UNKNOWN_TYPE", `Unknown type '${name}'`, span);
      return T_JSON;
    }
    this.resolvingAliases.add(name);
    const resolved = this.resolveTypeAst(ast);
    this.resolvingAliases.delete(name);
    this.resolvedAliases.set(name, resolved);
    return resolved;
  }

  private resolveTypeAst(ast: TypeAst): SplType {
    switch (ast.kind) {
      case "t_prim":
        switch (ast.name) {
          case "null":
            return T_NULL;
          case "bool":
            return T_BOOL;
          case "int":
            return T_INT;
          case "float":
            return T_FLOAT;
          case "string":
            return T_STRING;
          case "json":
            return T_JSON;
          case "void":
            return T_VOID;
          case "Error":
            return T_ERROR;
        }
      case "t_named":
        return this.resolveNamedType(ast.name, ast.span);
      case "t_str_lit":
        this.err(
          "E_INVALID_UNION",
          "Standalone string literal type requires a closed union of at least 2 distinct string literals",
          ast.span
        );
        return T_STRING;
      case "t_list": {
        const elem = this.resolveTypeAst(ast.elem);
        if (elem.kind === "void") this.err("E_INVALID_TYPE", "list<void> is not valid", ast.span);
        return makeList(elem);
      }
      case "t_map": {
        const val = this.resolveTypeAst(ast.value);
        if (val.kind === "void") this.err("E_INVALID_TYPE", "map<string, void> is not valid", ast.span);
        return makeMap(val);
      }
      case "t_record": {
        const seen = new Set<string>();
        const fields: Array<{ name: string; type: SplType }> = [];
        for (const f of ast.fields) {
          if (seen.has(f.name)) {
            this.err("E_DUPLICATE_FIELD", `Duplicate record field '${f.name}'`, f.span);
            continue;
          }
          seen.add(f.name);
          const ft = this.resolveTypeAst(f.type);
          if (ft.kind === "void") this.err("E_INVALID_TYPE", `Record field '${f.name}' cannot be void`, f.span);
          fields.push({ name: f.name, type: ft });
        }
        return makeRecord(fields);
      }
      case "t_nullable": {
        const inner = this.resolveTypeAst(ast.inner);
        if (inner.kind === "void") {
          this.err("E_INVALID_TYPE", "void? is not valid", ast.span);
          return T_VOID;
        }
        return makeNullable(inner);
      }
      case "t_union": {
        // §4.1: Only valid for closed string literal unions (>=2 distinct literals, optionally nullable)
        // OR T | null (nullable sugar)
        let hasNull = false;
        const strLits: string[] = [];
        const otherTypes: TypeAst[] = [];

        for (const m of ast.members) {
          if (m.kind === "t_prim" && m.name === "null") {
            hasNull = true;
          } else if (m.kind === "t_str_lit") {
            strLits.push(m.value);
          } else if (m.kind === "t_nullable" && m.inner.kind === "t_str_lit") {
            hasNull = true;
            strLits.push(m.inner.value);
          } else {
            otherTypes.push(m);
          }
        }

        if (otherTypes.length === 0 && strLits.length > 0) {
          const uniq = Array.from(new Set(strLits));
          if (uniq.length < 2) {
            this.err("E_INVALID_UNION", "String literal union must have at least 2 distinct literals", ast.span);
            return hasNull ? makeNullable(T_STRING) : T_STRING;
          }
          const u = makeStrUnion(uniq);
          return hasNull ? makeNullable(u) : u;
        }
        if (strLits.length === 0 && hasNull && otherTypes.length === 1) {
          const inner = this.resolveTypeAst(otherTypes[0]);
          return makeNullable(inner);
        }
        this.err(
          "E_INVALID_UNION",
          "General union types are not supported in SPL v5; only closed string literal unions or T | null are allowed",
          ast.span
        );
        return T_JSON;
      }
    }
  }

  private createModuleScope(): Scope {
    const scope = new Scope();
    for (const [name, inp] of this.inputs) {
      scope.vars.set(name, { kind: "input", index: inp.index, type: inp.type });
    }
    for (const [name, st] of this.states) {
      scope.vars.set(name, { kind: "state", index: st.index, type: st.type });
    }
    return scope;
  }

  private checkFunction(fn: FnDecl, paramTypes: SplType[], retType: SplType): CheckedFunction {
    const modScope = this.createModuleScope();
    const fnScope = new Scope(modScope);
    this.currentNextSlot = 0;
    this.currentFnRetType = retType;
    this.loopDepth = 0;

    const checkedParams: Array<{ name: string; type: SplType; slot: number }> = [];
    for (let i = 0; i < fn.params.length; i++) {
      const p = fn.params[i];
      if (fnScope.vars.has(p.name)) {
        this.err("E_DUPLICATE_BINDING", `Duplicate parameter '${p.name}'`, p.span);
        continue;
      }
      const slot = this.currentNextSlot++;
      fnScope.vars.set(p.name, { kind: "local", slot, mutable: false, type: paramTypes[i] });
      checkedParams.push({ name: p.name, type: paramTypes[i], slot });
    }

    const alwaysReturns = this.checkBlock(fn.body, fnScope, false);
    if (retType.kind !== "void" && !alwaysReturns) {
      this.err(
        "E_MISSING_RETURN",
        `Function '${fn.name}' must return a value of type '${canonicalTypeString(retType)}' on all paths`,
        fn.span
      );
    }

    return {
      name: fn.name,
      params: checkedParams,
      retType,
      body: fn.body,
      localsCount: this.currentNextSlot,
    };
  }

  private checkSyntheticMain(body: BlockStmt): CheckedFunction {
    const modScope = this.createModuleScope();
    const fnScope = new Scope(modScope);
    this.currentNextSlot = 0;
    this.loopDepth = 0;

    // Infer unified return type from top-level return statements
    const inferredReturns: SplType[] = [];
    this.currentFnRetType = T_JSON; // sentinel while collecting returns? Better: two-pass or infer directly!
    // Collect return types cleanly by tracking a collector array:
    this.syntheticReturnCollector = inferredReturns;
    this.checkBlock(body, fnScope, false);
    this.syntheticReturnCollector = null;

    let retType: SplType = T_VOID;
    if (inferredReturns.length > 0) {
      retType = inferredReturns[0];
      for (let i = 1; i < inferredReturns.length; i++) {
        const next = inferredReturns[i];
        if (typesEqual(retType, next)) continue;
        if (retType.kind === "null" && next.kind !== "void") {
          retType = makeNullable(next);
        } else if (next.kind === "null" && retType.kind !== "void") {
          retType = makeNullable(retType);
        } else if (isAssignable(next, retType)) {
          continue;
        } else if (isAssignable(retType, next)) {
          retType = next;
        } else {
          this.err(
            "E_TYPE_MISMATCH",
            "Incompatible return types in top-level statements",
            body.span,
            canonicalTypeString(retType),
            canonicalTypeString(next)
          );
        }
      }
    }

    return {
      name: "main",
      params: [],
      retType,
      body,
      localsCount: this.currentNextSlot,
    };
  }

  private syntheticReturnCollector: SplType[] | null = null;

  private checkBlock(block: BlockStmt, parentScope: Scope, createChild = true): boolean {
    const scope = createChild ? new Scope(parentScope) : parentScope;
    let terminated = false;
    for (const stmt of block.stmts) {
      const stmtTerminates = this.checkStmt(stmt, scope);
      if (stmtTerminates) terminated = true;
    }
    return terminated;
  }

  private checkStmt(stmt: Stmt, scope: Scope): boolean {
    switch (stmt.kind) {
      case "let": {
        if (scope.vars.has(stmt.name)) {
          this.err("E_DUPLICATE_BINDING", `Variable '${stmt.name}' is already declared in this scope`, stmt.span);
        }
        const declaredType = stmt.typeAst ? this.resolveTypeAst(stmt.typeAst) : undefined;
        if (declaredType?.kind === "void") {
          this.err("E_INVALID_TYPE", "Cannot declare variable of type void", stmt.span);
        }
        const initType = this.checkExpr(stmt.init, scope, declaredType);
        if (initType.kind === "void") {
          this.err("E_INVALID_TYPE", "Cannot assign void expression to variable", stmt.init.span);
        }
        const finalType = declaredType ?? initType;
        if (declaredType && !this.isExprAssignable(stmt.init, initType, declaredType)) {
          this.err(
            "E_TYPE_MISMATCH",
            `Cannot initialize '${stmt.name}' of type '${canonicalTypeString(declaredType)}' with '${canonicalTypeString(initType)}'`,
            stmt.init.span,
            canonicalTypeString(declaredType),
            canonicalTypeString(initType)
          );
        }
        const slot = this.currentNextSlot++;
        scope.vars.set(stmt.name, { kind: "local", slot, mutable: stmt.mutable, type: finalType });
        this.stmtMeta.set(stmt, { localSlot: slot });
        return false;
      }

      case "assign": {
        const binding = scope.lookup(stmt.target.root);
        if (!binding) {
          this.err("E_UNDEFINED_VAR", `Undefined variable '${stmt.target.root}'`, stmt.target.span);
          this.checkExpr(stmt.value, scope);
          return false;
        }
        if (binding.kind === "input") {
          this.err("E_IMMUTABLE_BINDING", `Cannot assign to immutable input '${stmt.target.root}'`, stmt.target.span);
        } else if (binding.kind === "local" && !binding.mutable) {
          this.err("E_IMMUTABLE_BINDING", `Cannot assign to immutable binding '${stmt.target.root}' (declare with 'let mut')`, stmt.target.span);
        }

        let curType = binding.type;
        const stepKinds: Array<"field" | "list_index" | "map_index"> = [];
        for (const seg of stmt.target.segments) {
          if (seg.kind === "field") {
            stepKinds.push("field");
            if (curType.kind === "nullable") {
              this.err("E_NULLABLE_ACCESS", "Cannot mutate field on nullable value", seg.span);
              break;
            }
            if (curType.kind !== "record") {
              this.err("E_TYPE_MISMATCH", `Cannot access field '.${seg.name}' on type '${canonicalTypeString(curType)}'`, seg.span);
              break;
            }
            const field = curType.fields.find((f) => f.name === seg.name);
            if (!field) {
              this.err("E_UNKNOWN_FIELD", `Record has no field '${seg.name}'`, seg.span);
              break;
            }
            curType = field.type;
          } else {
            const idxType = this.checkExpr(seg.index, scope);
            if (curType.kind === "nullable") {
              this.err("E_NULLABLE_ACCESS", "Cannot index nullable value", seg.span);
              stepKinds.push("list_index");
              break;
            }
            if (curType.kind === "list") {
              stepKinds.push("list_index");
              if (idxType.kind !== "int") {
                this.err("E_TYPE_MISMATCH", "List index must be int", seg.index.span, "int", canonicalTypeString(idxType));
              }
              curType = curType.elem;
            } else if (curType.kind === "map") {
              stepKinds.push("map_index");
              if (idxType.kind !== "string" && idxType.kind !== "str_union") {
                this.err("E_TYPE_MISMATCH", "Map index must be string", seg.index.span, "string", canonicalTypeString(idxType));
              }
              curType = curType.value;
            } else {
              stepKinds.push("list_index");
              this.err("E_TYPE_MISMATCH", `Type '${canonicalTypeString(curType)}' is not index-assignable`, seg.span);
              break;
            }
          }
        }

        const valType = this.checkExpr(stmt.value, scope, curType);
        if (!this.isExprAssignable(stmt.value, valType, curType)) {
          this.err(
            "E_TYPE_MISMATCH",
            `Cannot assign '${canonicalTypeString(valType)}' to '${canonicalTypeString(curType)}'`,
            stmt.value.span,
            canonicalTypeString(curType),
            canonicalTypeString(valType)
          );
        }
        this.stmtMeta.set(stmt, { assignRoot: binding, assignStepKinds: stepKinds });
        return false;
      }

      case "if": {
        const condType = this.checkExpr(stmt.cond, scope, T_BOOL);
        if (condType.kind !== "bool") {
          this.err("E_TYPE_MISMATCH", "if condition must be bool", stmt.cond.span, "bool", canonicalTypeString(condType));
        }

        // §4.4 Flow-sensitive nullability narrowing
        const narrow = this.extractNullCheck(stmt.cond, scope);
        const thenScope = new Scope(scope);
        const elseScope = new Scope(scope);
        if (narrow) {
          if (narrow.isNotNull) {
            thenScope.narrowed.set(narrow.name, narrow.nonNullType);
          } else {
            elseScope.narrowed.set(narrow.name, narrow.nonNullType);
          }
        }

        const thenTerm = this.checkBlock(stmt.thenBlock, thenScope, false);
        let elseTerm = false;
        if (stmt.elseBranch) {
          if (stmt.elseBranch.kind === "if") {
            elseTerm = this.checkStmt(stmt.elseBranch, elseScope);
          } else {
            elseTerm = this.checkBlock(stmt.elseBranch, elseScope, false);
          }
        } else if (narrow && !narrow.isNotNull && thenTerm) {
          // Early exit narrowing: `if (x == null) { return ...; }` narrows x in remaining block!
          scope.narrowed.set(narrow.name, narrow.nonNullType);
        }

        return thenTerm && elseTerm;
      }

      case "switch": {
        const discType = this.checkExpr(stmt.discriminant, scope);
        if (
          discType.kind !== "bool" &&
          discType.kind !== "int" &&
          discType.kind !== "string" &&
          discType.kind !== "str_union"
        ) {
          this.err(
            "E_TYPE_MISMATCH",
            `switch discriminant must be bool, int, string, or string literal union; got '${canonicalTypeString(discType)}'`,
            stmt.discriminant.span
          );
        }

        const seen = new Set<string>();
        let allCasesTerminate = stmt.cases.length > 0;
        for (const c of stmt.cases) {
          for (const lit of c.literals) {
            const key = `${lit.kind}:${String(lit.value)}`;
            if (seen.has(key)) {
              this.err("E_DUPLICATE_CASE", `Duplicate switch case literal '${String(lit.value)}'`, lit.span);
            }
            seen.add(key);

            if (discType.kind === "bool" && lit.kind !== "bool") {
              this.err("E_TYPE_MISMATCH", "Expected bool case literal", lit.span, "bool", lit.kind);
            } else if (discType.kind === "int" && lit.kind !== "int") {
              this.err("E_TYPE_MISMATCH", "Expected int case literal", lit.span, "int", lit.kind);
            } else if (discType.kind === "string" && lit.kind !== "string") {
              this.err("E_TYPE_MISMATCH", "Expected string case literal", lit.span, "string", lit.kind);
            } else if (discType.kind === "str_union") {
              if (lit.kind !== "string" || !discType.literals.includes(lit.value)) {
                this.err(
                  "E_TYPE_MISMATCH",
                  `Case literal '${String(lit.value)}' is not a member of ${canonicalTypeString(discType)}`,
                  lit.span
                );
              }
            }
          }
          const bodyTerm = this.checkBlock(c.body, scope, true);
          if (!bodyTerm) allCasesTerminate = false;
        }

        let defaultTerm = false;
        if (stmt.defaultBlock) {
          defaultTerm = this.checkBlock(stmt.defaultBlock, scope, true);
        }

        // §4.5 Exhaustiveness for bool and str_union
        let exhaustive = Boolean(stmt.defaultBlock);
        if (!exhaustive && discType.kind === "bool") {
          exhaustive = seen.has("bool:true") && seen.has("bool:false");
          if (!exhaustive) {
            this.err("E_NON_EXHAUSTIVE_SWITCH", "switch over bool must cover true and false or include default", stmt.span);
          }
        } else if (!exhaustive && discType.kind === "str_union") {
          const missing = discType.literals.filter((l) => !seen.has(`string:${l}`));
          exhaustive = missing.length === 0;
          if (!exhaustive) {
            this.err(
              "E_NON_EXHAUSTIVE_SWITCH",
              `Non-exhaustive switch over ${canonicalTypeString(discType)}; missing: ${missing.join(", ")}`,
              stmt.span
            );
          }
        }

        return exhaustive && allCasesTerminate && (stmt.defaultBlock ? defaultTerm : true);
      }

      case "while": {
        const condType = this.checkExpr(stmt.cond, scope, T_BOOL);
        if (condType.kind !== "bool") {
          this.err("E_TYPE_MISMATCH", "while condition must be bool", stmt.cond.span, "bool", canonicalTypeString(condType));
        }
        this.loopDepth++;
        this.checkBlock(stmt.body, scope, true);
        this.loopDepth--;
        return false;
      }

      case "for": {
        const iterType = this.checkExpr(stmt.iterable, scope);
        let elemType: SplType = T_JSON;
        if (iterType.kind !== "list") {
          this.err("E_TYPE_MISMATCH", "for-in iterable must be list<T>", stmt.iterable.span, "list<T>", canonicalTypeString(iterType));
        } else {
          elemType = iterType.elem;
        }
        const forListSlot = this.currentNextSlot++;
        const forIndexSlot = this.currentNextSlot++;
        const forItemSlot = this.currentNextSlot++;
        this.stmtMeta.set(stmt, { forListSlot, forIndexSlot, forItemSlot });

        const bodyScope = new Scope(scope);
        bodyScope.vars.set(stmt.itemName, { kind: "local", slot: forItemSlot, mutable: false, type: elemType });
        this.loopDepth++;
        this.checkBlock(stmt.body, bodyScope, false);
        this.loopDepth--;
        return false;
      }

      case "try": {
        const tryTerm = this.checkBlock(stmt.tryBlock, scope, true);
        const catchSlot = this.currentNextSlot++;
        this.stmtMeta.set(stmt, { catchSlot });
        const catchScope = new Scope(scope);
        catchScope.vars.set(stmt.errName, { kind: "local", slot: catchSlot, mutable: false, type: T_ERROR });
        const catchTerm = this.checkBlock(stmt.catchBlock, catchScope, false);
        return tryTerm && catchTerm;
      }

      case "return": {
        if (this.syntheticReturnCollector) {
          if (!stmt.value) {
            this.syntheticReturnCollector.push(T_VOID);
          } else {
            const vt = this.checkExpr(stmt.value, scope);
            this.syntheticReturnCollector.push(vt);
          }
          return true;
        }
        if (this.currentFnRetType.kind === "void") {
          if (stmt.value) {
            this.err("E_TYPE_MISMATCH", "Void function cannot return a value", stmt.value.span);
          }
        } else {
          if (!stmt.value) {
            this.err(
              "E_TYPE_MISMATCH",
              `Expected return value of type '${canonicalTypeString(this.currentFnRetType)}'`,
              stmt.span
            );
          } else {
            const vt = this.checkExpr(stmt.value, scope, this.currentFnRetType);
            if (!this.isExprAssignable(stmt.value, vt, this.currentFnRetType)) {
              this.err(
                "E_TYPE_MISMATCH",
                `Return value of type '${canonicalTypeString(vt)}' is not assignable to '${canonicalTypeString(this.currentFnRetType)}'`,
                stmt.value.span,
                canonicalTypeString(this.currentFnRetType),
                canonicalTypeString(vt)
              );
            }
          }
        }
        return true;
      }

      case "break":
      case "continue": {
        if (this.loopDepth === 0) {
          this.err("E_INVALID_JUMP", `'${stmt.kind}' is only valid inside a while or for loop`, stmt.span);
        }
        return true;
      }

      case "expr_stmt": {
        this.checkExpr(stmt.expr, scope);
        return false;
      }
    }
  }

  private extractNullCheck(
    cond: Expr,
    scope: Scope
  ): { name: string; nonNullType: SplType; isNotNull: boolean } | null {
    if (cond.kind !== "binary" || (cond.op !== "!=" && cond.op !== "==")) return null;
    let varExpr: Extract<Expr, { kind: "var_ref" }> | null = null;
    if (cond.left.kind === "var_ref" && cond.right.kind === "lit_null") varExpr = cond.left;
    else if (cond.right.kind === "var_ref" && cond.left.kind === "lit_null") varExpr = cond.right;
    if (!varExpr) return null;

    const binding = scope.lookup(varExpr.name);
    if (!binding) return null;
    // Narrowing only applies to immutable locals/params/inputs (§4.4)
    if (binding.kind === "state") return null;
    if (binding.kind === "local" && binding.mutable) return null;

    const curType = scope.lookupNarrowed(varExpr.name) ?? binding.type;
    if (curType.kind !== "nullable") return null;
    return {
      name: varExpr.name,
      nonNullType: curType.inner,
      isNotNull: cond.op === "!=",
    };
  }

  private isExprAssignable(expr: Expr, from: SplType, to: SplType): boolean {
    if (isAssignable(from, to)) return true;
    // Contextual string literal -> str_union or str_union?
    if (expr.kind === "lit_string") {
      if (to.kind === "str_union" && to.literals.includes(expr.value)) return true;
      if (to.kind === "nullable" && to.inner.kind === "str_union" && to.inner.literals.includes(expr.value)) {
        return true;
      }
    }
    return false;
  }

  private checkExpr(expr: Expr, scope: Scope, expected?: SplType): SplType {
    const unwrapExp = expected?.kind === "nullable" ? expected.inner : expected;

    const finish = (type: SplType, extra: Partial<ExprMeta> = {}): SplType => {
      this.exprMeta.set(expr, { type, ...extra });
      return type;
    };

    switch (expr.kind) {
      case "lit_null":
        return finish(T_NULL);
      case "lit_bool":
        return finish(T_BOOL);
      case "lit_int":
        return finish(T_INT);
      case "lit_float":
        return finish(T_FLOAT);
      case "lit_string":
        if (unwrapExp?.kind === "str_union" && unwrapExp.literals.includes(expr.value)) {
          return finish(unwrapExp);
        }
        return finish(T_STRING);

      case "template_str": {
        for (const p of expr.parts) {
          if (p.kind === "expr") {
            const pt = this.checkExpr(p.expr, scope);
            if (
              pt.kind !== "string" &&
              pt.kind !== "str_union" &&
              pt.kind !== "int" &&
              pt.kind !== "float" &&
              pt.kind !== "bool"
            ) {
              this.err(
                "E_TEMPLATE_TYPE",
                `Template interpolation requires string, int, float, or bool; got '${canonicalTypeString(pt)}'`,
                p.span
              );
            }
          }
        }
        return finish(T_STRING);
      }

      case "list_lit": {
        if (expr.items.length === 0) {
          if (unwrapExp?.kind === "list") {
            return finish(unwrapExp);
          }
          if (unwrapExp?.kind === "json") {
            return finish(makeList(T_JSON));
          }
          this.err(
            "E_AMBIGUOUS_EMPTY_LIST",
            "Empty list literal requires an explicit type annotation or contextual type",
            expr.span
          );
          return finish(makeList(T_JSON));
        }
        const elemExpected = unwrapExp?.kind === "list" ? unwrapExp.elem : undefined;
        let elemType = this.checkExpr(expr.items[0], scope, elemExpected);
        if (elemExpected && this.isExprAssignable(expr.items[0], elemType, elemExpected)) {
          elemType = elemExpected;
        }
        for (let i = 1; i < expr.items.length; i++) {
          const it = this.checkExpr(expr.items[i], scope, elemType);
          if (!this.isExprAssignable(expr.items[i], it, elemType)) {
            if (elemType.kind === "null" && it.kind !== "void") {
              elemType = makeNullable(it);
            } else if (it.kind === "null") {
              elemType = makeNullable(elemType);
            } else if (isAssignable(elemType, it)) {
              elemType = it;
            } else {
              this.err(
                "E_TYPE_MISMATCH",
                `List element ${i} has type '${canonicalTypeString(it)}', expected '${canonicalTypeString(elemType)}'`,
                expr.items[i].span
              );
            }
          }
        }
        return finish(makeList(elemType));
      }

      case "record_lit": {
        const seen = new Set<string>();
        for (const e of expr.entries) {
          if (seen.has(e.key)) {
            this.err("E_DUPLICATE_FIELD", `Duplicate field '${e.key}' in object literal`, e.span);
          }
          seen.add(e.key);
        }

        if (unwrapExp?.kind === "map") {
          for (const e of expr.entries) {
            const vt = this.checkExpr(e.value, scope, unwrapExp.value);
            if (!this.isExprAssignable(e.value, vt, unwrapExp.value)) {
              this.err(
                "E_TYPE_MISMATCH",
                `Map value for '${e.key}' has type '${canonicalTypeString(vt)}', expected '${canonicalTypeString(unwrapExp.value)}'`,
                e.value.span
              );
            }
          }
          return finish(unwrapExp, { isMapLiteral: true });
        }

        if (expr.entries.length === 0) {
          if (unwrapExp?.kind === "record" && unwrapExp.fields.length === 0) {
            return finish(unwrapExp);
          }
          if (unwrapExp?.kind === "record") {
            // Check if all fields are nullable -> fill implicitly in record check? No, require explicit or match empty record
            const allNullable = unwrapExp.fields.every((f) => f.type.kind === "nullable");
            if (allNullable) {
              return finish(makeRecord([]));
            }
          }
          if (unwrapExp?.kind === "json") {
            return finish(makeRecord([]));
          }
          return finish(makeRecord([]));
        }

        const expectedFieldMap = new Map<string, SplType>();
        if (unwrapExp?.kind === "record") {
          for (const f of unwrapExp.fields) expectedFieldMap.set(f.name, f.type);
        }

        const fields: Array<{ name: string; type: SplType }> = [];
        for (const e of expr.entries) {
          const ef = expectedFieldMap.get(e.key);
          const vt = this.checkExpr(e.value, scope, ef);
          if (vt.kind === "void") {
            this.err("E_INVALID_TYPE", `Record field '${e.key}' cannot have void value`, e.value.span);
          }
          fields.push({ name: e.key, type: ef && this.isExprAssignable(e.value, vt, ef) ? ef : vt });
        }
        return finish(makeRecord(fields));
      }

      case "var_ref": {
        const binding = scope.lookup(expr.name);
        if (!binding) {
          if (this.pureMode && (this.inputs.has(expr.name) || this.states.has(expr.name))) {
            this.err("E_IMPURE_INIT", `Initializer cannot reference input/state '${expr.name}'`, expr.span);
          } else {
            this.err("E_UNDEFINED_VAR", `Undefined identifier '${expr.name}'`, expr.span);
          }
          return finish(T_JSON);
        }
        const effType = scope.lookupNarrowed(expr.name) ?? binding.type;
        return finish(effType, { resolvedBinding: binding });
      }

      case "unary": {
        const ot = this.checkExpr(expr.operand, scope);
        if (expr.op === "!") {
          if (ot.kind !== "bool") {
            this.err("E_TYPE_MISMATCH", "Unary '!' requires bool", expr.span, "bool", canonicalTypeString(ot));
          }
          return finish(T_BOOL);
        }
        if (expr.op === "~") {
          if (ot.kind !== "int") {
            this.err("E_TYPE_MISMATCH", "Bitwise '~' requires int", expr.span, "int", canonicalTypeString(ot));
          }
          return finish(T_INT);
        }
        // Unary '-'
        if (ot.kind === "int") return finish(T_INT);
        if (ot.kind === "float") return finish(T_FLOAT);
        this.err("E_TYPE_MISMATCH", "Unary '-' requires int or float", expr.span, "int | float", canonicalTypeString(ot));
        return finish(T_INT);
      }

      case "binary": {
        if (expr.op === "??") {
          const lt = this.checkExpr(expr.left, scope);
          if (lt.kind === "null") {
            const rt = this.checkExpr(expr.right, scope, expected);
            return finish(rt);
          }
          if (lt.kind !== "nullable") {
            this.err("E_TYPE_MISMATCH", "Left operand of '??' must be nullable (T?)", expr.left.span, "T?", canonicalTypeString(lt));
            const rt = this.checkExpr(expr.right, scope, expected);
            return finish(rt);
          }
          const rt = this.checkExpr(expr.right, scope, lt.inner);
          if (this.isExprAssignable(expr.right, rt, lt.inner)) {
            return finish(lt.inner);
          }
          if (isAssignable(lt.inner, rt)) {
            return finish(rt);
          }
          if (rt.kind === "nullable" && isAssignable(rt.inner, lt.inner)) {
            return finish(lt);
          }
          if (rt.kind === "nullable" && isAssignable(lt.inner, rt.inner)) {
            return finish(rt);
          }
          if (rt.kind === "null") {
            return finish(lt);
          }
          this.err(
            "E_TYPE_MISMATCH",
            `Right operand of '??' has type '${canonicalTypeString(rt)}', incompatible with '${canonicalTypeString(lt.inner)}'`,
            expr.right.span
          );
          return finish(lt.inner);
        }

        if (expr.op === "&&" || expr.op === "||") {
          const lt = this.checkExpr(expr.left, scope, T_BOOL);
          const rt = this.checkExpr(expr.right, scope, T_BOOL);
          if (lt.kind !== "bool" || rt.kind !== "bool") {
            this.err("E_TYPE_MISMATCH", `Operator '${expr.op}' requires bool operands`, expr.span);
          }
          return finish(T_BOOL);
        }

        if (expr.op === "&" || expr.op === "|" || expr.op === "^" || expr.op === "<<" || expr.op === ">>" || expr.op === ">>>") {
          const lt = this.checkExpr(expr.left, scope, T_INT);
          const rt = this.checkExpr(expr.right, scope, T_INT);
          if (lt.kind !== "int" || rt.kind !== "int") {
            this.err("E_TYPE_MISMATCH", `Bitwise operator '${expr.op}' requires int operands`, expr.span);
          }
          return finish(T_INT);
        }

        if (expr.op === "==" || expr.op === "!=") {
          const lt = this.checkExpr(expr.left, scope);
          const rt = this.checkExpr(expr.right, scope, lt.kind === "str_union" ? lt : undefined);
          const ok =
            typesEqual(lt, rt) ||
            (lt.kind === "nullable" && (rt.kind === "null" || isAssignable(rt, lt.inner))) ||
            (rt.kind === "nullable" && (lt.kind === "null" || isAssignable(lt, rt.inner))) ||
            (lt.kind === "str_union" && rt.kind === "string") ||
            (rt.kind === "str_union" && lt.kind === "string");
          if (!ok) {
            this.err(
              "E_TYPE_MISMATCH",
              `Cannot compare '${canonicalTypeString(lt)}' and '${canonicalTypeString(rt)}' with '${expr.op}'`,
              expr.span
            );
          }
          return finish(T_BOOL);
        }

        if (expr.op === "<" || expr.op === "<=" || expr.op === ">" || expr.op === ">=") {
          const lt = this.checkExpr(expr.left, scope);
          const rt = this.checkExpr(expr.right, scope);
          if (lt.kind === "int" && rt.kind === "int") return finish(T_BOOL);
          if (lt.kind === "float" && rt.kind === "float") return finish(T_BOOL);
          if ((lt.kind === "string" || lt.kind === "str_union") && (rt.kind === "string" || rt.kind === "str_union")) {
            return finish(T_BOOL);
          }
          this.err(
            "E_TYPE_MISMATCH",
            `Relational operator '${expr.op}' requires matching int, float, or string operands; got '${canonicalTypeString(lt)}' and '${canonicalTypeString(rt)}'`,
            expr.span
          );
          return finish(T_BOOL);
        }

        // Arithmetic & string '+'
        const lt = this.checkExpr(expr.left, scope);
        const rt = this.checkExpr(expr.right, scope);
        if (expr.op === "+" && (lt.kind === "string" || lt.kind === "str_union") && (rt.kind === "string" || rt.kind === "str_union")) {
          return finish(T_STRING);
        }
        if (expr.op === "%") {
          if (lt.kind !== "int" || rt.kind !== "int") {
            this.err("E_TYPE_MISMATCH", "Operator '%' is only defined for int operands", expr.span);
          }
          return finish(T_INT);
        }
        if (lt.kind === "int" && rt.kind === "int") return finish(T_INT);
        if (lt.kind === "float" && rt.kind === "float") return finish(T_FLOAT);
        this.err(
          "E_TYPE_MISMATCH",
          `Operator '${expr.op}' cannot be applied to '${canonicalTypeString(lt)}' and '${canonicalTypeString(rt)}' (explicit cast required for int/float)`,
          expr.span
        );
        return finish(lt.kind === "float" ? T_FLOAT : T_INT);
      }

      case "cast": {
        const target = this.resolveTypeAst(expr.targetTypeAst);
        const src = this.checkExpr(expr.expr, scope, target);
        if (typesEqual(src, target) || this.isExprAssignable(expr.expr, src, target)) {
          return finish(target, { castKind: "noop" });
        }
        if (src.kind === "int" && target.kind === "float") {
          return finish(T_FLOAT, { castKind: "i2f" });
        }
        if (src.kind === "float" && target.kind === "int") {
          return finish(T_INT, { castKind: "f2i" });
        }
        if (src.kind === "json") {
          const schemaRes = splTypeToJsonSchema(target, { strict: false });
          if (!schemaRes.ok) {
            this.err("E_INVALID_CAST", schemaRes.reason, expr.span);
            return finish(target, { castKind: "noop" });
          }
          return finish(target, { castKind: "json", schema: schemaRes.schema });
        }
        this.err(
          "E_INVALID_CAST",
          `Cannot cast '${canonicalTypeString(src)}' to '${canonicalTypeString(target)}'`,
          expr.span
        );
        return finish(target, { castKind: "noop" });
      }

      case "prop_access": {
        const objType = this.checkExpr(expr.object, scope);
        if (expr.optional) {
          if (objType.kind === "null") return finish(T_NULL);
          const inner = objType.kind === "nullable" ? objType.inner : objType;
          const fieldType = this.lookupFieldType(inner, expr.property, expr.span);
          return finish(makeNullable(fieldType));
        }
        if (objType.kind === "nullable" || objType.kind === "null") {
          this.err("E_NULLABLE_ACCESS", `Cannot access '.${expr.property}' on nullable type '${canonicalTypeString(objType)}'; use '?.' or narrow with != null`, expr.span);
          return finish(T_JSON);
        }
        return finish(this.lookupFieldType(objType, expr.property, expr.span));
      }

      case "index_access": {
        const objType = this.checkExpr(expr.object, scope);
        const idxType = this.checkExpr(expr.index, scope);
        if (expr.optional) {
          if (objType.kind === "null") return finish(T_NULL);
          const inner = objType.kind === "nullable" ? objType.inner : objType;
          const elem = this.checkIndexTarget(inner, idxType, expr.span);
          return finish(makeNullable(elem));
        }
        if (objType.kind === "nullable" || objType.kind === "null") {
          this.err("E_NULLABLE_ACCESS", `Cannot index nullable type '${canonicalTypeString(objType)}'; use '?.[' or narrow`, expr.span);
          return finish(T_JSON);
        }
        return finish(this.checkIndexTarget(objType, idxType, expr.span));
      }

      case "call": {
        return this.checkCallExpr(expr, scope, finish);
      }

      case "eff_ask": {
        if (this.pureMode) this.err("E_IMPURE_INIT", "Effects are forbidden in state/input initializers", expr.span);
        const targetType = this.resolveTypeAst(expr.typeAst);
        if (expr.args.length < 2 || expr.args.length > 3) {
          this.err("E_ARITY", "model.ask expects 2 or 3 arguments (profile, prompt, opts?)", expr.span);
          return finish(targetType);
        }
        const profName = this.requireStringLiteral(expr.args[0], "model.ask profile");
        const promptType = this.checkExpr(expr.args[1], scope, T_STRING);
        if (promptType.kind !== "string" && promptType.kind !== "str_union") {
          this.err("E_TYPE_MISMATCH", "model.ask prompt must be string", expr.args[1].span);
        }
        if (expr.args[2]) {
          this.checkOptsRecord(
            expr.args[2],
            scope,
            { system: T_STRING, input: T_JSON },
            "model.ask opts"
          );
        }
        let strict = true;
        if (profName !== null) {
          const prof = this.catalog.models[profName];
          if (!prof) {
            this.err("E_UNKNOWN_CAPABILITY", `Unknown model profile '${profName}' in Signature Catalog`, expr.args[0].span);
          } else {
            strict = prof.strict_schema;
            this.capabilities.add(`model:${profName}`);
          }
        }
        const schemaRes = splTypeToJsonSchema(targetType, { strict });
        if (!schemaRes.ok) {
          this.err("E_SCHEMA_NOT_STRICT", schemaRes.reason, expr.typeAst.span);
          return finish(targetType, { schema: { type: "string" } });
        }
        return finish(targetType, { schema: schemaRes.schema });
      }

      case "eff_decide": {
        if (this.pureMode) this.err("E_IMPURE_INIT", "Effects are forbidden in state/input initializers", expr.span);
        if (expr.args.length < 3 || expr.args.length > 4) {
          this.err("E_ARITY", "model.decide expects 3 or 4 arguments (profile, prompt, options, opts?)", expr.span);
          return finish(T_STRING);
        }
        const profName = this.requireStringLiteral(expr.args[0], "model.decide profile");
        if (profName !== null) {
          if (!this.catalog.decisions[profName]) {
            this.err("E_UNKNOWN_CAPABILITY", `Unknown decision profile '${profName}' in Signature Catalog`, expr.args[0].span);
          } else {
            this.capabilities.add(`decision:${profName}`);
          }
        }
        const promptType = this.checkExpr(expr.args[1], scope, T_STRING);
        if (promptType.kind !== "string" && promptType.kind !== "str_union") {
          this.err("E_TYPE_MISMATCH", "model.decide prompt must be string", expr.args[1].span);
        }
        const optArg = expr.args[2];
        const options: string[] = [];
        if (optArg.kind !== "list_lit") {
          this.err("E_INVALID_DECIDE_OPTIONS", "model.decide options must be a list literal of >= 2 distinct string literals", optArg.span);
        } else {
          const seen = new Set<string>();
          for (const item of optArg.items) {
            if (item.kind !== "lit_string") {
              this.err("E_INVALID_DECIDE_OPTIONS", "Each option in model.decide must be a string literal", item.span);
            } else if (seen.has(item.value)) {
              this.err("E_INVALID_DECIDE_OPTIONS", `Duplicate option '${item.value}' in model.decide`, item.span);
            } else {
              seen.add(item.value);
              options.push(item.value);
            }
          }
          if (options.length < 2) {
            this.err("E_INVALID_DECIDE_OPTIONS", "model.decide requires at least 2 distinct options", optArg.span);
          }
        }
        let hasMinConf = false;
        if (expr.args[3]) {
          const present = this.checkOptsRecord(
            expr.args[3],
            scope,
            { min_confidence: T_FLOAT, system: T_STRING, context: T_JSON },
            "model.decide opts"
          );
          hasMinConf = present.has("min_confidence");
        }
        const unionType = options.length >= 2 ? makeStrUnion(options) : T_STRING;
        const retType = hasMinConf ? makeNullable(unionType) : unionType;
        return finish(retType, { decideOptions: options, decideHasOpts: Boolean(expr.args[3]) });
      }

      case "eff_web_search": {
        if (this.pureMode) this.err("E_IMPURE_INIT", "Effects are forbidden in state/input initializers", expr.span);
        if (!this.catalog.web.search.enabled) {
          this.err("E_UNKNOWN_CAPABILITY", "web.search is not enabled in Signature Catalog", expr.span);
        } else {
          this.capabilities.add("web:search");
        }
        if (expr.args.length < 1 || expr.args.length > 2) {
          this.err("E_ARITY", "web.search expects 1 or 2 arguments (query, opts?)", expr.span);
        } else {
          const qt = this.checkExpr(expr.args[0], scope, T_STRING);
          if (qt.kind !== "string" && qt.kind !== "str_union") {
            this.err("E_TYPE_MISMATCH", "web.search query must be string", expr.args[0].span);
          }
          if (expr.args[1]) {
            this.checkOptsRecord(expr.args[1], scope, { max_results: T_INT, domain: T_STRING }, "web.search opts");
          }
        }
        return finish(makeList(T_WEB_SEARCH_RESULT));
      }

      case "eff_web_fetch": {
        if (this.pureMode) this.err("E_IMPURE_INIT", "Effects are forbidden in state/input initializers", expr.span);
        if (!this.catalog.web.fetch.enabled) {
          this.err("E_UNKNOWN_CAPABILITY", "web.fetch is not enabled in Signature Catalog", expr.span);
        } else {
          this.capabilities.add("web:fetch");
        }
        if (expr.args.length < 1 || expr.args.length > 2) {
          this.err("E_ARITY", "web.fetch expects 1 or 2 arguments (url, opts?)", expr.span);
        } else {
          const ut = this.checkExpr(expr.args[0], scope, T_STRING);
          if (ut.kind !== "string" && ut.kind !== "str_union") {
            this.err("E_TYPE_MISMATCH", "web.fetch url must be string", expr.args[0].span);
          }
          if (expr.args[1]) {
            this.checkOptsRecord(
              expr.args[1],
              scope,
              {
                method: makeStrUnion(["GET", "HEAD", "POST"]),
                headers: makeMap(T_STRING),
                body: T_STRING,
              },
              "web.fetch opts"
            );
          }
        }
        return finish(T_WEB_FETCH_RESPONSE);
      }

      case "eff_fs": {
        if (this.pureMode) this.err("E_IMPURE_INIT", "Effects are forbidden in state/input initializers", expr.span);
        const needsContent = expr.op === "write" || expr.op === "append";
        const expectedArity = needsContent ? 3 : 2;
        if (expr.args.length !== expectedArity) {
          this.err("E_ARITY", `fs.${expr.op} expects ${expectedArity} arguments`, expr.span);
          return finish(T_NULL);
        }
        const rootName = this.requireStringLiteral(expr.args[0], `fs.${expr.op} root`);
        if (rootName !== null) {
          const rootCfg = this.catalog.fs_roots[rootName];
          if (!rootCfg) {
            this.err("E_UNKNOWN_CAPABILITY", `Unknown fs root '${rootName}' in Signature Catalog`, expr.args[0].span);
          } else if (!rootCfg.permissions.includes(expr.op)) {
            this.err(
              "E_CAPABILITY_DENIED",
              `fs root '${rootName}' does not grant '${expr.op}' permission`,
              expr.span
            );
          } else {
            this.capabilities.add(`fs:${rootName}:${expr.op}`);
          }
        }
        const pathT = this.checkExpr(expr.args[1], scope, T_STRING);
        if (pathT.kind !== "string" && pathT.kind !== "str_union") {
          this.err("E_TYPE_MISMATCH", `fs.${expr.op} path must be string`, expr.args[1].span);
        }
        if (needsContent) {
          const cT = this.checkExpr(expr.args[2], scope, T_STRING);
          if (cT.kind !== "string" && cT.kind !== "str_union") {
            this.err("E_TYPE_MISMATCH", `fs.${expr.op} content must be string`, expr.args[2].span);
          }
        }
        switch (expr.op) {
          case "read":
            return finish(T_STRING);
          case "write":
          case "append":
            return finish(T_NULL);
          case "exists":
            return finish(T_BOOL);
          case "list":
            return finish(makeList(T_STRING));
          case "stat":
            return finish(T_FS_STAT);
        }
      }

      case "eff_shell": {
        if (this.pureMode) this.err("E_IMPURE_INIT", "Effects are forbidden in state/input initializers", expr.span);
        if (expr.args.length !== 2) {
          this.err("E_ARITY", "shell.run expects 2 arguments (profile, args)", expr.span);
          return finish(T_SHELL_RESULT);
        }
        const profName = this.requireStringLiteral(expr.args[0], "shell.run profile");
        if (profName !== null) {
          const prof = this.catalog.shell_profiles[profName];
          if (!prof) {
            this.err("E_UNKNOWN_CAPABILITY", `Unknown shell profile '${profName}' in Signature Catalog`, expr.args[0].span);
            this.checkExpr(expr.args[1], scope);
          } else {
            this.capabilities.add(`shell:${profName}`);
            const paramsType = jsonSchemaToSplType(prof.params_schema);
            const argT = this.checkExpr(expr.args[1], scope, paramsType);
            this.checkRecordMatchesSchemaType(expr.args[1], argT, paramsType, `shell.run("${profName}") args`);
          }
        } else {
          this.checkExpr(expr.args[1], scope);
        }
        const resSchema = splTypeToJsonSchema(T_SHELL_RESULT, { strict: true });
        return finish(T_SHELL_RESULT, { schema: resSchema.ok ? resSchema.schema : {} });
      }

      case "eff_js_tool": {
        if (this.pureMode) this.err("E_IMPURE_INIT", "Effects are forbidden in state/input initializers", expr.span);
        const sig = this.catalog.js_tools[expr.name];
        if (!sig) {
          this.err("E_UNKNOWN_CAPABILITY", `Unknown JS tool 'tool.${expr.name}' in Signature Catalog`, expr.span);
          this.checkExpr(expr.arg, scope);
          return finish(T_JSON);
        }
        this.capabilities.add(`tool:${expr.name}`);
        const paramsType = jsonSchemaToSplType(sig.params_schema);
        const resultType = jsonSchemaToSplType(sig.result_schema);
        const argT = this.checkExpr(expr.arg, scope, paramsType);
        this.checkRecordMatchesSchemaType(expr.arg, argT, paramsType, `tool.${expr.name} args`);
        return finish(resultType, { schema: sig.result_schema });
      }

      case "eff_mcp_tool": {
        if (this.pureMode) this.err("E_IMPURE_INIT", "Effects are forbidden in state/input initializers", expr.span);
        const srv = this.catalog.mcp_tools[expr.server];
        const sig = srv?.[expr.tool];
        if (!sig) {
          this.err("E_UNKNOWN_CAPABILITY", `Unknown MCP tool 'mcp.${expr.server}.${expr.tool}' in Signature Catalog`, expr.span);
          this.checkExpr(expr.arg, scope);
          return finish(T_JSON);
        }
        this.capabilities.add(`mcp:${expr.server}.${expr.tool}`);
        const paramsType = jsonSchemaToSplType(sig.params_schema);
        const resultType = jsonSchemaToSplType(sig.result_schema);
        const argT = this.checkExpr(expr.arg, scope, paramsType);
        this.checkRecordMatchesSchemaType(expr.arg, argT, paramsType, `mcp.${expr.server}.${expr.tool} args`);
        return finish(resultType, { schema: sig.result_schema });
      }
    }
  }

  private checkRecordMatchesSchemaType(argExpr: Expr, actual: SplType, expected: SplType, label: string): void {
    if (this.isExprAssignable(argExpr, actual, expected)) return;
    // Allow omitting nullable fields in record literals for catalog tool/shell params
    if (argExpr.kind === "record_lit" && actual.kind === "record" && expected.kind === "record") {
      const actualMap = new Map(actual.fields.map((f) => [f.name, f.type]));
      const expectedMap = new Map(expected.fields.map((f) => [f.name, f.type]));
      let ok = true;
      for (const [k] of actualMap) {
        if (!expectedMap.has(k)) {
          this.err("E_UNKNOWN_FIELD", `${label}: unexpected field '${k}'`, argExpr.span);
          ok = false;
        }
      }
      for (const [k, et] of expectedMap) {
        const at = actualMap.get(k);
        if (!at) {
          if (et.kind !== "nullable") {
            this.err("E_MISSING_FIELD", `${label}: missing required field '${k}'`, argExpr.span);
            ok = false;
          }
        } else if (!isAssignable(at, et)) {
          this.err(
            "E_TYPE_MISMATCH",
            `${label}: field '${k}' has type '${canonicalTypeString(at)}', expected '${canonicalTypeString(et)}'`,
            argExpr.span
          );
          ok = false;
        }
      }
      if (ok) return;
    }
    this.err(
      "E_TYPE_MISMATCH",
      `${label}: expected '${canonicalTypeString(expected)}', got '${canonicalTypeString(actual)}'`,
      argExpr.span,
      canonicalTypeString(expected),
      canonicalTypeString(actual)
    );
  }

  private checkOptsRecord(
    expr: Expr,
    scope: Scope,
    allowed: Record<string, SplType>,
    label: string
  ): Set<string> {
    const present = new Set<string>();
    if (expr.kind !== "record_lit") {
      this.err("E_TYPE_MISMATCH", `${label} must be a record literal`, expr.span);
      this.checkExpr(expr, scope);
      return present;
    }
    const fields: Array<{ name: string; type: SplType }> = [];
    for (const entry of expr.entries) {
      if (present.has(entry.key)) {
        this.err("E_DUPLICATE_FIELD", `Duplicate option '${entry.key}' in ${label}`, entry.span);
      }
      present.add(entry.key);
      const expected = allowed[entry.key];
      if (!expected) {
        this.err("E_UNKNOWN_FIELD", `Unknown option '${entry.key}' in ${label}`, entry.span);
        this.checkExpr(entry.value, scope);
        continue;
      }
      const vt = this.checkExpr(entry.value, scope, expected);
      if (!this.isExprAssignable(entry.value, vt, expected)) {
        this.err(
          "E_TYPE_MISMATCH",
          `${label}.${entry.key} expected '${canonicalTypeString(expected)}', got '${canonicalTypeString(vt)}'`,
          entry.value.span
        );
      }
      fields.push({ name: entry.key, type: expected });
    }
    this.exprMeta.set(expr, { type: makeRecord(fields) });
    return present;
  }

  private requireStringLiteral(expr: Expr, label: string): string | null {
    if (expr.kind !== "lit_string") {
      this.err("E_LITERAL_REQUIRED", `${label} must be a compile-time string literal`, expr.span);
      return null;
    }
    this.exprMeta.set(expr, { type: T_STRING });
    return expr.value;
  }

  private lookupFieldType(objType: SplType, prop: string, span: Span): SplType {
    if (objType.kind === "error") {
      return this.lookupFieldType(T_ERROR_RECORD, prop, span);
    }
    if (objType.kind !== "record") {
      this.err("E_TYPE_MISMATCH", `Cannot access property '.${prop}' on type '${canonicalTypeString(objType)}'`, span);
      return T_JSON;
    }
    const f = objType.fields.find((x) => x.name === prop);
    if (!f) {
      this.err("E_UNKNOWN_FIELD", `Record type '${canonicalTypeString(objType)}' has no field '${prop}'`, span);
      return T_JSON;
    }
    return f.type;
  }

  private checkIndexTarget(objType: SplType, idxType: SplType, span: Span): SplType {
    if (objType.kind === "list") {
      if (idxType.kind !== "int") {
        this.err("E_TYPE_MISMATCH", "List index must be int", span, "int", canonicalTypeString(idxType));
      }
      return objType.elem;
    }
    if (objType.kind === "string" || objType.kind === "str_union") {
      if (idxType.kind !== "int") {
        this.err("E_TYPE_MISMATCH", "String index must be int", span, "int", canonicalTypeString(idxType));
      }
      return T_STRING;
    }
    if (objType.kind === "map") {
      if (idxType.kind !== "string" && idxType.kind !== "str_union") {
        this.err("E_TYPE_MISMATCH", "Map index must be string", span, "string", canonicalTypeString(idxType));
      }
      return objType.value;
    }
    this.err("E_TYPE_MISMATCH", `Type '${canonicalTypeString(objType)}' is not indexable`, span);
    return T_JSON;
  }

  private checkCallExpr(
    expr: Extract<Expr, { kind: "call" }>,
    scope: Scope,
    finish: (type: SplType, extra?: Partial<ExprMeta>) => SplType
  ): SplType {
    // 1. Namespaced pure built-in: str.*, list.*, map.*, math.*, json.*
    if (
      expr.callee.kind === "prop_access" &&
      !expr.callee.optional &&
      expr.callee.object.kind === "var_ref" &&
      RESERVED_BUILTIN_NS.has(expr.callee.object.name) &&
      !scope.lookup(expr.callee.object.name)
    ) {
      const id = `${expr.callee.object.name}.${expr.callee.property}`;
      return this.checkBuiltinCall(id, expr.args, expr.span, scope, finish);
    }

    // 2. Top-level built-in `len(...)` or top-level SPL function
    if (expr.callee.kind === "var_ref") {
      const name = expr.callee.name;
      if (name === "len" && !scope.lookup("len") && !this.fnSigs.has("len")) {
        return this.checkBuiltinCall("len", expr.args, expr.span, scope, finish);
      }
      if (EFFECT_NS.has(name)) {
        this.err("E_PARSE_EFFECT", `'${name}' is a reserved effect namespace`, expr.callee.span);
        return finish(T_JSON);
      }
      const sig = this.fnSigs.get(name);
      if (!sig) {
        this.err("E_UNKNOWN_FN", `Unknown function '${name}'`, expr.callee.span);
        for (const a of expr.args) this.checkExpr(a, scope);
        return finish(T_JSON);
      }
      if (this.pureMode) {
        this.err("E_IMPURE_INIT", `Cannot call user function '${name}' in state/input initializer`, expr.span);
      }
      if (expr.args.length !== sig.params.length) {
        this.err(
          "E_ARITY",
          `Function '${name}' expects ${sig.params.length} argument(s), got ${expr.args.length}`,
          expr.span
        );
      }
      for (let i = 0; i < expr.args.length; i++) {
        const expT = sig.params[i];
        const argT = this.checkExpr(expr.args[i], scope, expT);
        if (expT && !this.isExprAssignable(expr.args[i], argT, expT)) {
          this.err(
            "E_TYPE_MISMATCH",
            `Argument ${i} to '${name}' expected '${canonicalTypeString(expT)}', got '${canonicalTypeString(argT)}'`,
            expr.args[i].span
          );
        }
      }
      return finish(sig.retType, { fnName: name });
    }

    this.err("E_NOT_CALLABLE", "Only top-level named functions and built-ins are callable in SPL v5", expr.callee.span);
    for (const a of expr.args) this.checkExpr(a, scope);
    return finish(T_JSON);
  }

  private checkBuiltinCall(
    id: string,
    args: Expr[],
    span: Span,
    scope: Scope,
    finish: (type: SplType, extra?: Partial<ExprMeta>) => SplType
  ): SplType {
    const checkArgs = (expectedTypes: SplType[]): SplType[] => {
      if (args.length !== expectedTypes.length) {
        this.err("E_ARITY", `Built-in '${id}' expects ${expectedTypes.length} argument(s), got ${args.length}`, span);
      }
      const actual: SplType[] = [];
      for (let i = 0; i < args.length; i++) {
        const exp = expectedTypes[i];
        const t = this.checkExpr(args[i], scope, exp);
        actual.push(t);
        if (exp && !this.isExprAssignable(args[i], t, exp)) {
          this.err(
            "E_TYPE_MISMATCH",
            `Argument ${i} to '${id}' expected '${canonicalTypeString(exp)}', got '${canonicalTypeString(t)}'`,
            args[i].span
          );
        }
      }
      return actual;
    };

    switch (id) {
      case "len": {
        if (args.length !== 1) {
          this.err("E_ARITY", "len() expects 1 argument", span);
          return finish(T_INT, { builtinId: id });
        }
        const t = this.checkExpr(args[0], scope);
        if (t.kind !== "string" && t.kind !== "str_union" && t.kind !== "list" && t.kind !== "map") {
          this.err("E_TYPE_MISMATCH", `len() requires string, list, or map; got '${canonicalTypeString(t)}'`, args[0].span);
        }
        return finish(T_INT, { builtinId: id });
      }
      case "str.slice":
        checkArgs([T_STRING, T_INT, T_INT]);
        return finish(T_STRING, { builtinId: id });
      case "str.split":
        checkArgs([T_STRING, T_STRING]);
        return finish(makeList(T_STRING), { builtinId: id });
      case "str.join":
        checkArgs([makeList(T_STRING), T_STRING]);
        return finish(T_STRING, { builtinId: id });
      case "str.trim":
      case "str.lower":
      case "str.upper":
        checkArgs([T_STRING]);
        return finish(T_STRING, { builtinId: id });
      case "str.contains":
      case "str.starts_with":
      case "str.ends_with":
        checkArgs([T_STRING, T_STRING]);
        return finish(T_BOOL, { builtinId: id });
      case "str.replace":
        checkArgs([T_STRING, T_STRING, T_STRING]);
        return finish(T_STRING, { builtinId: id });

      case "list.push": {
        if (args.length !== 2) {
          this.err("E_ARITY", "list.push expects 2 arguments", span);
          return finish(makeList(T_JSON), { builtinId: id });
        }
        const lt = this.checkExpr(args[0], scope);
        if (lt.kind !== "list") {
          this.err("E_TYPE_MISMATCH", "list.push first argument must be list<T>", args[0].span);
          this.checkExpr(args[1], scope);
          return finish(makeList(T_JSON), { builtinId: id });
        }
        const vt = this.checkExpr(args[1], scope, lt.elem);
        if (!this.isExprAssignable(args[1], vt, lt.elem)) {
          this.err("E_TYPE_MISMATCH", `list.push element expected '${canonicalTypeString(lt.elem)}', got '${canonicalTypeString(vt)}'`, args[1].span);
        }
        return finish(lt, { builtinId: id });
      }
      case "list.slice": {
        if (args.length !== 3) {
          this.err("E_ARITY", "list.slice expects 3 arguments", span);
          return finish(makeList(T_JSON), { builtinId: id });
        }
        const lt = this.checkExpr(args[0], scope);
        const s = this.checkExpr(args[1], scope, T_INT);
        const e = this.checkExpr(args[2], scope, T_INT);
        if (lt.kind !== "list") this.err("E_TYPE_MISMATCH", "list.slice first argument must be list<T>", args[0].span);
        if (s.kind !== "int" || e.kind !== "int") this.err("E_TYPE_MISMATCH", "list.slice bounds must be int", span);
        return finish(lt.kind === "list" ? lt : makeList(T_JSON), { builtinId: id });
      }
      case "list.concat": {
        if (args.length !== 2) {
          this.err("E_ARITY", "list.concat expects 2 arguments", span);
          return finish(makeList(T_JSON), { builtinId: id });
        }
        const a = this.checkExpr(args[0], scope);
        const b = this.checkExpr(args[1], scope, a.kind === "list" ? a : undefined);
        if (a.kind !== "list" || b.kind !== "list" || !typesEqual(a.elem, b.elem)) {
          this.err("E_TYPE_MISMATCH", "list.concat requires two list<T> of the same element type", span);
        }
        return finish(a.kind === "list" ? a : makeList(T_JSON), { builtinId: id });
      }
      case "list.contains": {
        if (args.length !== 2) {
          this.err("E_ARITY", "list.contains expects 2 arguments", span);
          return finish(T_BOOL, { builtinId: id });
        }
        const lt = this.checkExpr(args[0], scope);
        if (lt.kind !== "list") {
          this.err("E_TYPE_MISMATCH", "list.contains first argument must be list<T>", args[0].span);
          this.checkExpr(args[1], scope);
          return finish(T_BOOL, { builtinId: id });
        }
        const vt = this.checkExpr(args[1], scope, lt.elem);
        if (!this.isExprAssignable(args[1], vt, lt.elem)) {
          this.err("E_TYPE_MISMATCH", `list.contains value expected '${canonicalTypeString(lt.elem)}', got '${canonicalTypeString(vt)}'`, args[1].span);
        }
        return finish(T_BOOL, { builtinId: id });
      }

      case "map.has": {
        if (args.length !== 2) {
          this.err("E_ARITY", "map.has expects 2 arguments", span);
          return finish(T_BOOL, { builtinId: id });
        }
        const mt = this.checkExpr(args[0], scope);
        const kt = this.checkExpr(args[1], scope, T_STRING);
        if (mt.kind !== "map") this.err("E_TYPE_MISMATCH", "map.has first argument must be map<string, T>", args[0].span);
        if (kt.kind !== "string" && kt.kind !== "str_union") this.err("E_TYPE_MISMATCH", "map.has key must be string", args[1].span);
        return finish(T_BOOL, { builtinId: id });
      }
      case "map.get": {
        if (args.length !== 2) {
          this.err("E_ARITY", "map.get expects 2 arguments", span);
          return finish(makeNullable(T_JSON), { builtinId: id });
        }
        const mt = this.checkExpr(args[0], scope);
        const kt = this.checkExpr(args[1], scope, T_STRING);
        if (mt.kind !== "map") {
          this.err("E_TYPE_MISMATCH", "map.get first argument must be map<string, T>", args[0].span);
          return finish(makeNullable(T_JSON), { builtinId: id });
        }
        if (kt.kind !== "string" && kt.kind !== "str_union") this.err("E_TYPE_MISMATCH", "map.get key must be string", args[1].span);
        return finish(makeNullable(mt.value), { builtinId: id });
      }
      case "map.set": {
        if (args.length !== 3) {
          this.err("E_ARITY", "map.set expects 3 arguments", span);
          return finish(makeMap(T_JSON), { builtinId: id });
        }
        const mt = this.checkExpr(args[0], scope);
        const kt = this.checkExpr(args[1], scope, T_STRING);
        if (mt.kind !== "map") {
          this.err("E_TYPE_MISMATCH", "map.set first argument must be map<string, T>", args[0].span);
          this.checkExpr(args[2], scope);
          return finish(makeMap(T_JSON), { builtinId: id });
        }
        if (kt.kind !== "string" && kt.kind !== "str_union") this.err("E_TYPE_MISMATCH", "map.set key must be string", args[1].span);
        const vt = this.checkExpr(args[2], scope, mt.value);
        if (!this.isExprAssignable(args[2], vt, mt.value)) {
          this.err("E_TYPE_MISMATCH", `map.set value expected '${canonicalTypeString(mt.value)}', got '${canonicalTypeString(vt)}'`, args[2].span);
        }
        return finish(mt, { builtinId: id });
      }
      case "map.delete": {
        if (args.length !== 2) {
          this.err("E_ARITY", "map.delete expects 2 arguments", span);
          return finish(makeMap(T_JSON), { builtinId: id });
        }
        const mt = this.checkExpr(args[0], scope);
        const kt = this.checkExpr(args[1], scope, T_STRING);
        if (mt.kind !== "map") this.err("E_TYPE_MISMATCH", "map.delete first argument must be map<string, T>", args[0].span);
        if (kt.kind !== "string" && kt.kind !== "str_union") this.err("E_TYPE_MISMATCH", "map.delete key must be string", args[1].span);
        return finish(mt.kind === "map" ? mt : makeMap(T_JSON), { builtinId: id });
      }
      case "map.keys": {
        if (args.length !== 1) {
          this.err("E_ARITY", "map.keys expects 1 argument", span);
          return finish(makeList(T_STRING), { builtinId: id });
        }
        const mt = this.checkExpr(args[0], scope);
        if (mt.kind !== "map") this.err("E_TYPE_MISMATCH", "map.keys argument must be map<string, T>", args[0].span);
        return finish(makeList(T_STRING), { builtinId: id });
      }
      case "map.values": {
        if (args.length !== 1) {
          this.err("E_ARITY", "map.values expects 1 argument", span);
          return finish(makeList(T_JSON), { builtinId: id });
        }
        const mt = this.checkExpr(args[0], scope);
        if (mt.kind !== "map") {
          this.err("E_TYPE_MISMATCH", "map.values argument must be map<string, T>", args[0].span);
          return finish(makeList(T_JSON), { builtinId: id });
        }
        return finish(makeList(mt.value), { builtinId: id });
      }

      case "math.abs_i":
        checkArgs([T_INT]);
        return finish(T_INT, { builtinId: id });
      case "math.abs_f":
      case "math.floor":
      case "math.ceil":
      case "math.round":
        checkArgs([T_FLOAT]);
        return finish(T_FLOAT, { builtinId: id });
      case "math.min_i":
      case "math.max_i":
        checkArgs([T_INT, T_INT]);
        return finish(T_INT, { builtinId: id });
      case "math.min_f":
      case "math.max_f":
        checkArgs([T_FLOAT, T_FLOAT]);
        return finish(T_FLOAT, { builtinId: id });

      case "json.stringify": {
        if (args.length !== 1) {
          this.err("E_ARITY", "json.stringify expects 1 argument", span);
          return finish(T_STRING, { builtinId: id });
        }
        const vt = this.checkExpr(args[0], scope);
        if (vt.kind === "void") this.err("E_TYPE_MISMATCH", "Cannot json.stringify a void value", args[0].span);
        return finish(T_STRING, { builtinId: id });
      }
      case "json.parse":
        checkArgs([T_STRING]);
        return finish(T_JSON, { builtinId: id });

      default:
        this.err("E_UNKNOWN_BUILTIN", `Unknown built-in function '${id}'`, span);
        for (const a of args) this.checkExpr(a, scope);
        return finish(T_JSON);
    }
  }
}
