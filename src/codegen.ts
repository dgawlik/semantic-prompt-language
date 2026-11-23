import type {
  TopItem, FnDecl, ExternFnDecl, EnumDecl, NewtypeDecl, ImplDecl, Stmt, Expr, BlockExpr, Pattern,
} from "./ast.js";
import type { CheckedProgram } from "./typechecker.js";
import { prune, flattenRecord, formatType, TStr, type Type } from "./types.js";
import { generateJsonSchema, generateDecodeCodec, generateTypeDescriptor } from "./schema.js";

export interface CodegenOptions {
  runtimeDirUrl: string; // e.g. file:///.../runtime or relative path
  resolveImportPath: (specifier: string, fromFile: string) => string;
}

export function generateJs(checked: CheckedProgram, opts: CodegenOptions): string {
  const gen = new JsCodegen(checked, opts);
  return gen.emitProgram();
}

class JsCodegen {
  private tempCounter = 0;
  private usedFfiModules = new Set<string>();
  private varScopes: Map<string, string>[] = [new Map()];
  private iifeDepth = 0;
  private currentReifiedParamMap = new Map<number, number>(); // TVar.id -> index in `__spl_reified`

  constructor(
    private readonly checked: CheckedProgram,
    private readonly opts: CodegenOptions
  ) {}

  private tmp(prefix = "_t"): string {
    return `${prefix}${++this.tempCounter}`;
  }

  private pushScope(): void {
    this.varScopes.push(new Map());
  }

  private popScope(): void {
    this.varScopes.pop();
  }

  private resolveVar(name: string): string {
    for (let i = this.varScopes.length - 1; i >= 0; i--) {
      const mapped = this.varScopes[i].get(name);
      if (mapped !== undefined) return mapped;
    }
    return name;
  }

  private isNameBound(name: string): boolean {
    for (let i = this.varScopes.length - 1; i >= 0; i--) {
      if (this.varScopes[i].has(name)) return true;
    }
    return false;
  }

  private static readonly JS_RESERVED_IDENT = new Set([
    "arguments", "eval", "class", "const", "var", "function", "new", "delete",
    "switch", "case", "default", "try", "catch", "finally", "throw", "typeof",
    "void", "with", "yield", "await", "debugger", "this", "super", "extends",
    "implements", "interface", "package", "private", "protected", "public", "static",
    "do", "finally", "instanceof", "in", "of",
  ]);

  private bindVar(name: string, preserveExact = false): string {
    const cur = this.varScopes[this.varScopes.length - 1];
    if (JsCodegen.JS_RESERVED_IDENT.has(name) || (!preserveExact && this.isNameBound(name))) {
      const renamed = `_${name}_${++this.tempCounter}`;
      cur.set(name, renamed);
      return renamed;
    }
    cur.set(name, name);
    return name;
  }

  emitProgram(): string {
    const lines: string[] = [];
    const { program } = this.checked;

    // Collect extern JS modules first
    for (const item of program.items) {
      if (item.kind === "ExternFnDecl") {
        this.usedFfiModules.add(item.jsModule);
      }
    }

    // Core runtime import
    lines.push(`import * as __spl from ${JSON.stringify(`${this.opts.runtimeDirUrl}/core.mjs`)};`);
    for (const mod of this.usedFfiModules) {
      if (mod !== "core") {
        lines.push(`import * as __ffi_${mod} from ${JSON.stringify(`${this.opts.runtimeDirUrl}/${mod}.mjs`)};`);
      }
    }

    // Collect top-level declared/imported names so prelude bindings never shadow module declarations
    const declaredTop = new Set<string>();
    for (const item of program.items) {
      if (item.kind === "FnDecl" && !item.receiverType) declaredTop.add(item.name);
      else if (item.kind === "ExternFnDecl") declaredTop.add(item.name);
      else if (item.kind === "LetStmt" && item.pattern.kind === "IdentPattern") declaredTop.add(item.pattern.name);
      else if (item.kind === "ImportDecl") {
        if (item.defaultAlias) declaredTop.add(item.defaultAlias);
        for (const s of item.specifiers) declaredTop.add(s.alias ?? s.name);
      } else if (item.kind === "EnumDecl") {
        for (const v of item.variants) declaredTop.add(v.name);
      } else if (item.kind === "NewtypeDecl") {
        declaredTop.add(item.name);
      }
    }

    // Built-in prelude bindings (skip any name explicitly declared/imported by this module)
    const preludePairs: [string, string][] = [
      ["Some", "__spl.Some"], ["None", "__spl.None"], ["Ok", "__spl.Ok"], ["Err", "__spl.Err"],
      ["panic", "__spl.panic"], ["to_str", "__spl.toStr"], ["print", "__spl.print"], ["print_inline", "__spl.printInline"],
      ["json_parse", "__spl.jsonParse"], ["json_stringify", "__spl.jsonStringify"], ["to_json", "__spl.toJson"],
      ["floor", "Math.floor"], ["ceil", "Math.ceil"], ["round", "Math.round"], ["sqrt", "Math.sqrt"],
      ["abs", "Math.abs"], ["abs_int", "Math.abs"], ["log", "Math.log"], ["exp", "Math.exp"],
      ["is_finite", "Number.isFinite"], ["int_to_float", "(x) => x"], ["float_to_int", "(x) => Math.trunc(x)"],
      ["array_fold", "__spl.arrayFold"], ["array_from_fn", "__spl.arrayFromFn"], ["dict_empty", "__spl.dictEmpty"], ["iter_from_fn", "__spl.iterFromFn"],
      ["regex_test", "__spl.regexTest"], ["regex_match", "__spl.regexMatch"], ["regex_replace", "__spl.regexReplace"],
      ["async_all", "__spl.asyncAll"], ["async_race", "__spl.asyncRace"],
      ["bytes_from_utf8", "__spl.bytesFromUtf8"], ["bytes_to_utf8", "__spl.bytesToUtf8"], ["bytes_len", "__spl.bytesLen"],
    ];
    const activePrelude = preludePairs
      .filter(([name]) => !declaredTop.has(name))
      .map(([name, val]) => `${name} = ${val}`);
    if (activePrelude.length > 0) {
      lines.push(`const ${activePrelude.join(", ")};`);
    }

    // Emit module imports
    const importedAux = new Set<string>();
    for (const item of program.items) {
      if (item.kind === "ImportDecl") {
        const target = this.opts.resolveImportPath(item.from, program.file);
        if (item.defaultAlias) {
          lines.push(`import * as ${item.defaultAlias} from ${JSON.stringify(target)};`);
        }
        const specs: string[] = [];
        for (const s of item.specifiers) {
          const local = s.alias ?? s.name;
          const binding = this.checked.importBindings.get(local);
          if (binding && binding.moduleSpec === item.from) {
            specs.push(s.alias ? `${s.name} as ${s.alias}` : s.name);
          }
        }
        // Also import extension (__ext_*) and trait impl (__impl_*) symbols from this module
        for (const [sym, info] of this.checked.importBindings) {
          if (
            info.moduleSpec === item.from &&
            (sym.startsWith("__ext_") || sym.startsWith("__impl_")) &&
            !importedAux.has(sym)
          ) {
            importedAux.add(sym);
            specs.push(sym);
          }
        }
        if (specs.length > 0) {
          lines.push(`import { ${Array.from(new Set(specs)).join(", ")} } from ${JSON.stringify(target)};`);
        }
      }
    }

    lines.push("");

    // Emit top-level items
    for (const item of program.items) {
      const code = this.emitTopItem(item);
      if (code) lines.push(code);
    }

    return lines.join("\n") + "\n";
  }

  private emitTopItem(item: TopItem): string {
    switch (item.kind) {
      case "ImportDecl":
      case "TypeDecl":
      case "TraitDecl":
        return "";

      case "EnumDecl":
        return this.emitEnumDecl(item);

      case "NewtypeDecl":
        return this.emitNewtypeDecl(item);

      case "ExternFnDecl":
        return this.emitExternFnDecl(item);

      case "FnDecl":
        return this.emitFnDecl(item, item.pub);

      case "ImplDecl":
        return this.emitImplDecl(item);

      case "LetStmt":
        return this.emitLetStmt(item, Boolean(item.pub));

      case "AssignStmt":
      case "FieldAssignStmt":
      case "IndexAssignStmt":
      case "WhileStmt":
      case "ForStmt":
        return this.emitStmt(item);

      case "ExprStmt":
        return `${this.emitExpr(item.expr)};`;
    }
  }

  private emitEnumDecl(decl: EnumDecl): string {
    const exp = decl.pub ? "export " : "";
    const out: string[] = [];
    for (const v of decl.variants) {
      if (v.fields.length === 0) {
        out.push(`${exp}const ${v.name} = Object.freeze({ $tag: ${JSON.stringify(v.name)} });`);
      } else {
        const params = v.fields.map((_, i) => `_${i}`).join(", ");
        const props = v.fields.map((_, i) => `_${i}`).join(", ");
        out.push(`${exp}function ${v.name}(${params}) { return { $tag: ${JSON.stringify(v.name)}, ${props} }; }`);
      }
    }
    return out.join("\n");
  }

  private emitNewtypeDecl(decl: NewtypeDecl): string {
    const exp = decl.pub ? "export " : "";
    return `${exp}function ${decl.name}(v) { return v; }`;
  }

  private emitExternFnDecl(decl: ExternFnDecl): string {
    const exp = decl.pub ? "export " : "";
    const src = decl.jsModule === "core" ? `__spl.${decl.jsName}` : `__ffi_${decl.jsModule}.${decl.jsName}`;
    return `${exp}const ${decl.name} = ${src};`;
  }

  private emitImplDecl(impl: ImplDecl): string {
    const out: string[] = [];
    for (const m of impl.methods) {
      const jsSym = this.checked.traitImplJsSymbols.get(m);
      if (!jsSym) continue;
      out.push(this.emitFnDeclWithName(m, jsSym, true));
    }
    return out.join("\n");
  }

  private emitFnDecl(fn: FnDecl, exported: boolean): string {
    const jsName = fn.receiverType ? this.checked.extensionJsSymbols.get(fn)! : fn.name;
    return this.emitFnDeclWithName(fn, jsName, exported);
  }

  private emitFnDeclWithName(fn: FnDecl, jsName: string, exported: boolean): string {
    const exp = exported ? "export " : "";
    const isAsync = this.checked.asyncFns.has(fn);
    const asyncKw = isAsync ? "async " : "";
    const prevReifiedMap = this.currentReifiedParamMap;
    this.currentReifiedParamMap = new Map(prevReifiedMap);
    const reifiedTvs = this.checked.fnReifiedParams.get(fn);
    const hasReified = Boolean(fn.reified || (reifiedTvs && reifiedTvs.length > 0));
    if (hasReified && reifiedTvs) {
      for (let i = 0; i < reifiedTvs.length; i++) {
        const p = prune(reifiedTvs[i]);
        if (p.kind === "TVar") {
          this.currentReifiedParamMap.set(p.id, i);
        }
      }
    }

    this.pushScope();
    const paramJsNames: string[] = [];
    const params = fn.params.map((p) => {
      const defCode = p.defaultValue ? this.emitExpr(p.defaultValue) : undefined;
      const pJs = this.bindVar(p.name, true);
      paramJsNames.push(pJs);
      return defCode !== undefined ? `${pJs} = ${defCode}` : pJs;
    });
    if (hasReified) {
      params.unshift("__spl_reified");
    }

    const hasTry = this.blockContainsTry(fn.body);
    const canTco = !fn.receiverType && !hasReified && this.hasSelfTailCall(fn.body, fn.name);

    let bodyCode: string;
    if (canTco) {
      const inner = this.emitBlockBody(fn.body, { tailReturn: true, tcoName: fn.name, tcoParams: paramJsNames });
      bodyCode = `while (true) {\n${indent(inner)}\n  return;\n}`;
    } else {
      bodyCode = this.emitBlockBody(fn.body, { tailReturn: true });
    }
    this.popScope();
    this.currentReifiedParamMap = prevReifiedMap;

    if (hasTry) {
      bodyCode = `try {\n${indent(bodyCode)}\n} catch (__spl_e) {\n  if (__spl_e instanceof __spl.EarlyReturn) return __spl_e.value;\n  throw __spl_e;\n}`;
    }

    return `${exp}${asyncKw}function ${jsName}(${params.join(", ")}) {\n${indent(bodyCode)}\n}`;
  }

  private emitLetStmt(stmt: Extract<Stmt, { kind: "LetStmt" }>, exported: boolean): string {
    const valCode = this.emitExpr(stmt.value);
    const kw = stmt.mutable ? "let" : "const";
    const exp = exported ? "export " : "";

    if (stmt.pattern.kind === "IdentPattern") {
      const jsName = this.bindVar(stmt.pattern.name, exported);
      return `${exp}${kw} ${jsName} = ${valCode};`;
    }
    if (stmt.pattern.kind === "WildcardPattern") {
      return `${valCode};`;
    }

    const tmp = this.tmp("_pat");
    const { bindings } = this.emitPatternMatch(stmt.pattern, tmp, stmt.mutable);
    return `const ${tmp} = ${valCode};\n${bindings.join("\n")}`;
  }

  private emitBlockBody(
    block: BlockExpr,
    ctx: { tailReturn: boolean; tcoName?: string; tcoParams?: string[] }
  ): string {
    this.pushScope();
    const lines: string[] = [];
    for (const stmt of block.stmts) {
      lines.push(this.emitStmt(stmt));
    }
    if (block.tailExpr) {
      lines.push(this.emitTailReturn(block.tailExpr, ctx));
    }
    this.popScope();
    return lines.join("\n");
  }

  private emitTailReturn(
    expr: Expr,
    ctx: { tailReturn: boolean; tcoName?: string; tcoParams?: string[] }
  ): string {
    if (!ctx.tailReturn) {
      return `${this.emitExpr(expr)};`;
    }

    // Self-tail-call optimization!
    if (ctx.tcoName && ctx.tcoParams) {
      if (expr.kind === "CallExpr" && expr.callee.kind === "IdentExpr" && expr.callee.name === ctx.tcoName) {
        const res = this.checked.callResolutions.get(expr);
        const argExprs =
          res?.kind === "Normal" && res.reorderedArgs
            ? res.reorderedArgs.map((a) => this.emitExpr(a!))
            : expr.args.map((a) => this.emitExpr(a.value));
        if (ctx.tcoParams.length === 0) return `continue;`;
        return `[${ctx.tcoParams.join(", ")}] = [${argExprs.join(", ")}];\ncontinue;`;
      }
      if (expr.kind === "IfExpr") {
        const cond = this.emitExpr(expr.cond);
        const thenCode = this.emitBlockBody(expr.thenBranch, ctx);
        let code = `if (${cond}) {\n${indent(thenCode)}\n}`;
        if (expr.elseBranch) {
          if (expr.elseBranch.kind === "BlockExpr") {
            code += ` else {\n${indent(this.emitBlockBody(expr.elseBranch, ctx))}\n}`;
          } else {
            code += ` else {\n${indent(this.emitTailReturn(expr.elseBranch, ctx))}\n}`;
          }
        } else {
          code += ` else {\n  return;\n}`;
        }
        return code;
      }
      if (expr.kind === "MatchExpr") {
        return this.emitMatchStmt(expr, ctx);
      }
    }

    return `return ${this.emitExpr(expr)};`;
  }

  private emitStmt(stmt: Stmt): string {
    switch (stmt.kind) {
      case "LetStmt":
        return this.emitLetStmt(stmt, false);
      case "AssignStmt":
        return `${this.resolveVar(stmt.target)} = ${this.emitExpr(stmt.value)};`;
      case "FieldAssignStmt":
        return `${this.emitExpr(stmt.object)}.${stmt.property} = ${this.emitExpr(stmt.value)};`;
      case "IndexAssignStmt":
        return `__spl.array_set(${this.emitExpr(stmt.object)}, ${this.emitExpr(stmt.index)}, ${this.emitExpr(stmt.value)});`;
      case "ReturnStmt": {
        const val = stmt.value ? this.emitExpr(stmt.value) : "undefined";
        if (this.iifeDepth > 0) {
          return `throw new __spl.EarlyReturn(${val});`;
        }
        return stmt.value ? `return ${val};` : `return;`;
      }
      case "WhileStmt": {
        const cond = this.emitExpr(stmt.cond);
        const body = this.emitBlockBody(stmt.body, { tailReturn: false });
        return `while (${cond}) {\n${indent(body)}\n}`;
      }
      case "ForStmt": {
        const res = this.checked.forResolutions.get(stmt);
        const elTmp = this.tmp("_el");
        this.pushScope();
        const { bindings } = this.emitPatternMatch(stmt.pattern, elTmp, false);
        const bodyCode = this.emitBlockBody(stmt.body, { tailReturn: false });
        this.popScope();
        const innerLines = [...bindings, bodyCode].filter((l) => l.length > 0).join("\n");

        // Zero-allocation native numeric loop fast-path for `for x in start..end[..step]`
        if (stmt.iterable.kind === "RangeExpr") {
          const r = stmt.iterable;
          const rs = this.tmp("_rs");
          const re = this.tmp("_re");
          const rst = this.tmp("_rst");
          const startCode = this.emitExpr(r.start);
          const endCode = this.emitExpr(r.end);
          const stepCode = r.step ? this.emitExpr(r.step) : "1";
          const posCmp = r.inclusive ? "<=" : "<";
          const negCmp = r.inclusive ? ">=" : ">";
          return `{\n  const ${rs} = ${startCode}, ${re} = ${endCode}, ${rst} = ${stepCode};\n  if (${rst} === 0) __spl.panic("Range step cannot be 0");\n  for (let ${elTmp} = ${rs}; ${rst} > 0 ? (${elTmp} ${posCmp} ${re}) : (${elTmp} ${negCmp} ${re}); ${elTmp} += ${rst}) {\n${indent(indent(innerLines))}\n  }\n}`;
        }

        const iterExpr = this.emitExpr(stmt.iterable);

        if (res?.kind === "Array" || res?.kind === "Str") {
          return `for (const ${elTmp} of ${iterExpr}) {\n${indent(innerLines)}\n}`;
        }
        if (res?.kind === "Dict") {
          return `for (const ${elTmp} of (${iterExpr}).entries()) {\n${indent(innerLines)}\n}`;
        }
        const itTmp = this.tmp("_it");
        const nextTmp = this.tmp("_next");
        let initIt: string;
        if (res?.kind === "ExtensionIter" || res?.kind === "TraitIter") {
          const call = `${res.jsSymbol}(${iterExpr})`;
          initIt = res.isAsync ? `(await ${call})` : call;
        } else {
          initIt = iterExpr;
        }
        return `{\n  const ${itTmp} = ${initIt};\n  while (true) {\n    const ${nextTmp} = __spl.iter_next(${itTmp});\n    if (${nextTmp}.$tag === "None") break;\n    const ${elTmp} = ${nextTmp}._0;\n${indent(indent(innerLines))}\n  }\n}`;
      }
      case "FnDecl":
        return this.emitFnDecl(stmt, false);
      case "EnumDecl":
        return this.emitEnumDecl(stmt);
      case "NewtypeDecl":
        return this.emitNewtypeDecl(stmt);
      case "TypeDecl":
        return "";
      case "ExprStmt":
        if (stmt.expr.kind === "IfExpr") {
          return this.emitIfStmt(stmt.expr);
        }
        return `${this.emitExpr(stmt.expr)};`;
    }
  }

  private emitIfStmt(expr: Extract<Expr, { kind: "IfExpr" }>): string {
    const cond = this.emitExpr(expr.cond);
    const thenCode = this.emitBlockBody(expr.thenBranch, { tailReturn: false });
    let code = `if (${cond}) {\n${indent(thenCode)}\n}`;
    if (expr.elseBranch) {
      if (expr.elseBranch.kind === "BlockExpr") {
        code += ` else {\n${indent(this.emitBlockBody(expr.elseBranch, { tailReturn: false }))}\n}`;
      } else {
        code += ` else ${this.emitIfStmt(expr.elseBranch)}`;
      }
    }
    return code;
  }

  private emitExpr(expr: Expr): string {
    switch (expr.kind) {
      case "IntLitExpr":
      case "FloatLitExpr":
        return String(expr.value);

      case "StrLitExpr":
      case "CharLitExpr":
        return JSON.stringify(expr.value);

      case "BoolLitExpr":
        return expr.value ? "true" : "false";

      case "StrInterpExpr": {
        const chunks = expr.parts.map((p) =>
          typeof p === "string" ? JSON.stringify(p) : `__spl.toStr(${this.emitExpr(p)})`
        );
        return chunks.length === 0 ? `""` : `(${chunks.join(" + ")})`;
      }

      case "PromptExpr": {
        const parts: string[] = [];
        const values: string[] = [];
        let curText = "";
        for (const p of expr.parts) {
          if (typeof p === "string") {
            curText += p;
          } else {
            parts.push(JSON.stringify(curText));
            curText = "";
            values.push(this.emitExpr(p));
          }
        }
        parts.push(JSON.stringify(curText));
        return `__spl.prompt([${parts.join(", ")}], [${values.join(", ")}])`;
      }

      case "IdentExpr": {
        const resolved = this.resolveVar(expr.name);
        const refReified = this.checked.reifiedIdentRefs.get(expr);
        if (refReified && refReified.length > 0) {
          return `((...__spl_a) => ${resolved}(${this.emitReifiedArray(refReified)}, ...__spl_a))`;
        }
        return resolved;
      }

      case "TupleExpr":
        return `[${expr.elements.map((e) => this.emitExpr(e)).join(", ")}]`;

      case "ArrayExpr":
        return `[${expr.elements.map((e) => this.emitExpr(e)).join(", ")}]`;

      case "RecordExpr": {
        const entries = expr.entries.map((e) =>
          e.kind === "Spread" ? `...${this.emitExpr(e.expr)}` : `${JSON.stringify(e.name)}: ${this.emitExpr(e.value)}`
        );
        return `({ ${entries.join(", ")} })`;
      }

      case "LambdaExpr": {
        const isAsync = this.checked.asyncFns.has(expr);
        const asyncKw = isAsync ? "async " : "";
        this.pushScope();
        const params = expr.params.map((p) => this.bindVar(p.name)).join(", ");
        const hasTry = this.blockContainsTry(expr.body);
        if (expr.body.stmts.length === 0 && expr.body.tailExpr && !hasTry) {
          const tail = this.emitExpr(expr.body.tailExpr);
          this.popScope();
          return `(${asyncKw}(${params}) => (${tail}))`;
        }
        let body = this.emitBlockBody(expr.body, { tailReturn: true });
        this.popScope();
        if (hasTry) {
          body = `try {\n${indent(body)}\n} catch (__spl_e) {\n  if (__spl_e instanceof __spl.EarlyReturn) return __spl_e.value;\n  throw __spl_e;\n}`;
        }
        return `(${asyncKw}(${params}) => {\n${indent(body)}\n})`;
      }

      case "BlockExpr": {
        const needsAsync = this.exprContainsAwait(expr);
        this.iifeDepth++;
        const body = this.emitBlockBody(expr, { tailReturn: true });
        this.iifeDepth--;
        return needsAsync ? `(await (async () => {\n${indent(body)}\n})())` : `((() => {\n${indent(body)}\n})())`;
      }

      case "UnaryExpr":
        return `(${expr.op}${this.emitExpr(expr.operand)})`;

      case "BinaryExpr": {
        const l = this.emitExpr(expr.left);
        const r = this.emitExpr(expr.right);
        if (expr.op === "==") return `__spl.eq(${l}, ${r})`;
        if (expr.op === "!=") return `!__spl.eq(${l}, ${r})`;
        if (expr.op === "/") {
          const lt = this.checked.exprTypes.get(expr.left);
          if (lt && prune(lt).kind === "TPrim" && (prune(lt) as { name: string }).name === "Int") {
            return `Math.trunc(${l} / ${r})`;
          }
        }
        return `(${l} ${expr.op} ${r})`;
      }

      case "RangeExpr": {
        const s = this.emitExpr(expr.start);
        const e = this.emitExpr(expr.end);
        const st = expr.step ? this.emitExpr(expr.step) : "1";
        return `__spl.rangeIter(${s}, ${e}, ${st}, ${expr.inclusive ? "true" : "false"})`;
      }

      case "AsExpr": {
        const inner = this.emitExpr(expr.expr);
        const kind = this.checked.castResolutions.get(expr) ?? "noop";
        switch (kind) {
          case "noop": return inner;
          case "trunc_int": return `Math.trunc(${inner})`;
          case "to_byte": return `(Math.trunc(${inner}) & 0xff)`;
          case "char_to_int": return `__spl.charToInt(${inner})`;
          case "char_to_byte": return `(__spl.charToInt(${inner}) & 0xff)`;
          case "int_to_char": return `__spl.intToChar(${inner})`;
          case "bool_to_int": return `((${inner}) ? 1 : 0)`;
          case "int_to_bool": return `((${inner}) !== 0)`;
          case "to_str": return `__spl.toStr(${inner})`;
          case "str_to_int": return `__spl.strToInt(${inner})`;
          case "str_to_float": return `__spl.strToFloat(${inner})`;
          case "str_to_bytes": return `__spl.bytesFromUtf8(${inner})`;
          case "bytes_to_str": return `__spl.bytesToUtf8(${inner})`;
          case "to_json": return `__spl.toJson(${inner})`;
          case "iter_to_array": return `__spl.iter_collect(${inner})`;
          case "array_to_iter": return `__spl.array_iter(${inner})`;
        }
      }

      case "MemberExpr":
        if (this.checked.newtypeValueAccess.has(expr)) {
          return this.emitExpr(expr.object);
        }
        return `${this.emitExpr(expr.object)}.${expr.property}`;

      case "OptionalMemberExpr":
        if (this.checked.newtypeValueAccess.has(expr)) {
          return `__spl.optMap(${this.emitExpr(expr.object)}, (__o) => __o)`;
        }
        return `__spl.optMap(${this.emitExpr(expr.object)}, (__o) => __o.${expr.property})`;

      case "NullCoalesceExpr":
        return `__spl.optCoalesce(${this.emitExpr(expr.left)}, () => (${this.emitExpr(expr.right)}))`;

      case "IndexExpr":
        return `__spl.indexGet(${this.emitExpr(expr.object)}, ${this.emitExpr(expr.index)})`;

      case "TryExpr":
        return `__spl.tryUnwrap(${this.emitExpr(expr.operand)})`;

      case "IfExpr": {
        const needsAsync = this.exprContainsAwait(expr);
        const cond = this.emitExpr(expr.cond);
        if (
          !needsAsync &&
          expr.thenBranch.stmts.length === 0 &&
          expr.thenBranch.tailExpr &&
          expr.elseBranch?.kind === "BlockExpr" &&
          expr.elseBranch.stmts.length === 0 &&
          expr.elseBranch.tailExpr
        ) {
          return `(${cond} ? ${this.emitExpr(expr.thenBranch.tailExpr)} : ${this.emitExpr(expr.elseBranch.tailExpr)})`;
        }
        this.iifeDepth++;
        const thenCode = this.emitBlockBody(expr.thenBranch, { tailReturn: true });
        let body = `if (${cond}) {\n${indent(thenCode)}\n}`;
        if (expr.elseBranch) {
          if (expr.elseBranch.kind === "BlockExpr") {
            body += ` else {\n${indent(this.emitBlockBody(expr.elseBranch, { tailReturn: true }))}\n}`;
          } else {
            body += ` else {\n  return ${this.emitExpr(expr.elseBranch)};\n}`;
          }
        }
        this.iifeDepth--;
        return needsAsync ? `(await (async () => {\n${indent(body)}\n})())` : `((() => {\n${indent(body)}\n})())`;
      }

      case "MatchExpr": {
        const needsAsync = this.exprContainsAwait(expr);
        this.iifeDepth++;
        const body = this.emitMatchStmt(expr, { tailReturn: true });
        this.iifeDepth--;
        return needsAsync ? `(await (async () => {\n${indent(body)}\n})())` : `((() => {\n${indent(body)}\n})())`;
      }

      case "ReturnExpr": {
        const val = expr.value ? this.emitExpr(expr.value) : "undefined";
        return `(() => { throw new __spl.EarlyReturn(${val}); })()`;
      }

      case "TypeSchemaExpr": {
        const resolved = this.checked.reifiedExprTypes.get(expr);
        if (resolved && this.typeContainsReifiedParam(resolved)) {
          return this.emitSchemaExpr(resolved);
        }
        const schema = this.checked.schemaLiterals.get(expr) ?? {};
        return JSON.stringify(schema);
      }

      case "DecodeExpr": {
        const resolved = this.checked.reifiedExprTypes.get(expr);
        const codecCode =
          resolved && this.typeContainsReifiedParam(resolved)
            ? this.emitCodecExpr(resolved)
            : JSON.stringify(this.checked.decodeCodecs.get(expr) ?? { k: "Json" });
        return `__spl.decode(${codecCode}, ${this.emitExpr(expr.arg)})`;
      }

      case "TypeofExpr": {
        const resolved = this.checked.reifiedExprTypes.get(expr) ?? TStr;
        return `__spl.toTypeInfo(${this.emitReifiedDescriptor(resolved)})`;
      }

      case "CallExpr":
        return this.emitCallExpr(expr);
    }
  }

  private emitCallExpr(expr: Extract<Expr, { kind: "CallExpr" }>): string {
    const res = this.checked.callResolutions.get(expr);
    const isAsync = this.checked.asyncCalls.has(expr);
    const wrap = (call: string) => (isAsync ? `(await ${call})` : call);

    if (res?.kind === "EnumCtor") {
      const args = expr.args.map((a) => this.emitExpr(a.value)).join(", ");
      return `${res.variant}(${args})`;
    }

    if (res?.kind === "NamespaceCall") {
      const argExprs = res.reorderedArgs
        ? res.reorderedArgs.map((a) => this.emitExpr(a!))
        : expr.args.map((a) => this.emitExpr(a.value));
      if (res.reifiedTypeVars) {
        argExprs.unshift(this.emitReifiedArray(res.reifiedTypeVars));
      }
      return wrap(`${res.alias}.${res.member}(${argExprs.join(", ")})`);
    }

    if (res?.kind === "ExtensionMethod") {
      const recv = this.emitExpr(res.receiver);
      const argExprs = res.reorderedArgs
        ? res.reorderedArgs.map((a) => this.emitExpr(a!))
        : expr.args.map((a) => this.emitExpr(a.value));
      const allArgs = [recv, ...argExprs];
      if (res.reifiedTypeVars) {
        allArgs.unshift(this.emitReifiedArray(res.reifiedTypeVars));
      }
      return wrap(`${res.jsSymbol}(${allArgs.join(", ")})`);
    }

    if (res?.kind === "TraitMethod") {
      const recv = this.emitExpr(res.receiver);
      const args = expr.args.map((a) => this.emitExpr(a.value));
      return wrap(`${res.jsSymbol}(${[recv, ...args].join(", ")})`);
    }

    if (res?.kind === "BuiltinMethod") {
      const recv = this.emitExpr(res.receiver);
      const args = expr.args.map((a) => this.emitExpr(a.value));
      const asyncSuffix = res.isAsync && !res.target.includes("par_map") ? "_async" : "";
      return wrap(`__spl.${res.target}${asyncSuffix}(${[recv, ...args].join(", ")})`);
    }

    // Normal call
    const callee = this.emitExpr(expr.callee);
    const argExprs =
      res?.kind === "Normal" && res.reorderedArgs
        ? res.reorderedArgs.map((a) => this.emitExpr(a!))
        : expr.args.map((a) => this.emitExpr(a.value));
    if (res?.kind === "Normal" && res.reifiedTypeVars) {
      argExprs.unshift(this.emitReifiedArray(res.reifiedTypeVars));
    }
    return wrap(`${callee}(${argExprs.join(", ")})`);
  }

  private typeContainsReifiedParam(type: Type, seen = new Set<number>()): boolean {
    if (this.currentReifiedParamMap.size === 0) return false;
    const t = prune(type);
    switch (t.kind) {
      case "TVar":
        if (seen.has(t.id)) return false;
        seen.add(t.id);
        return this.currentReifiedParamMap.has(t.id);
      case "TArray":
      case "TIter":
        return this.typeContainsReifiedParam(t.element, seen);
      case "TDict":
        return this.typeContainsReifiedParam(t.key, seen) || this.typeContainsReifiedParam(t.value, seen);
      case "TTuple":
        return t.elements.some((el) => this.typeContainsReifiedParam(el, seen));
      case "TRecord": {
        const flat = flattenRecord(t);
        for (const ft of flat.fields.values()) {
          if (this.typeContainsReifiedParam(ft, seen)) return true;
        }
        return flat.tail.kind === "ROpenDict" ? this.typeContainsReifiedParam(flat.tail.valueType, seen) : false;
      }
      case "TEnum":
        return t.typeArgs.some((ta) => this.typeContainsReifiedParam(ta, seen));
      case "TNewtype":
        return (
          t.typeArgs.some((ta) => this.typeContainsReifiedParam(ta, seen)) ||
          this.typeContainsReifiedParam(t.underlying, seen)
        );
      case "TFn":
        return (
          t.params.some((pt) => this.typeContainsReifiedParam(pt, seen)) ||
          this.typeContainsReifiedParam(t.ret, seen)
        );
      default:
        return false;
    }
  }

  private emitSchemaExpr(type: Type): string {
    if (!this.typeContainsReifiedParam(type)) {
      return JSON.stringify(generateJsonSchema(type));
    }
    const t = prune(type);
    switch (t.kind) {
      case "TVar": {
        const idx = this.currentReifiedParamMap.get(t.id);
        return idx !== undefined ? `__spl_reified[${idx}].schema` : "{}";
      }
      case "TArray":
      case "TIter":
        return `({ type: "array", items: ${this.emitSchemaExpr(t.element)} })`;
      case "TDict":
        return `({ type: "object", additionalProperties: ${this.emitSchemaExpr(t.value)} })`;
      case "TTuple": {
        const items = t.elements.map((el) => this.emitSchemaExpr(el)).join(", ");
        return `({ type: "array", prefixItems: [${items}], minItems: ${t.elements.length}, maxItems: ${t.elements.length} })`;
      }
      case "TEnum":
        if (t.name === "Option" && t.typeArgs.length === 1) {
          return `({ anyOf: [${this.emitSchemaExpr(t.typeArgs[0])}, { type: "null" }] })`;
        }
        return JSON.stringify(generateJsonSchema(t));
      case "TRecord": {
        const flat = flattenRecord(t);
        const propPairs: string[] = [];
        const required: string[] = [];
        for (const [name, fType] of flat.fields) {
          const pf = prune(fType);
          const isOpt = pf.kind === "TEnum" && pf.name === "Option" && pf.typeArgs.length === 1;
          let fieldSchemaCode = isOpt
            ? `({ anyOf: [${this.emitSchemaExpr(pf.typeArgs[0])}, { type: "null" }] })`
            : this.emitSchemaExpr(pf);
          const fieldHint = flat.meta?.fieldHints.get(name);
          if (fieldHint) {
            fieldSchemaCode = `({ ...${fieldSchemaCode}, description: ${JSON.stringify(fieldHint)} })`;
          }
          propPairs.push(`${JSON.stringify(name)}: ${fieldSchemaCode}`);
          if (!isOpt) required.push(name);
        }
        const extraProps: string[] = [
          `type: "object"`,
          `properties: { ${propPairs.join(", ")} }`,
          `required: ${JSON.stringify(required)}`,
        ];
        if (flat.meta?.typeName) extraProps.push(`title: ${JSON.stringify(flat.meta.typeName)}`);
        if (flat.meta?.llmHint) extraProps.push(`description: ${JSON.stringify(flat.meta.llmHint)}`);
        if (flat.tail.kind === "RClosed") {
          extraProps.push(`additionalProperties: false`);
        } else if (flat.tail.kind === "ROpenDict") {
          const v = prune(flat.tail.valueType);
          extraProps.push(
            `additionalProperties: ${v.kind === "TPrim" && v.name === "Json" ? "true" : this.emitSchemaExpr(v)}`
          );
        } else {
          extraProps.push(`additionalProperties: true`);
        }
        return `({ ${extraProps.join(", ")} })`;
      }
      case "TNewtype":
        return `(${this.emitReifiedDescriptor(t)}).schema`;
      default:
        return JSON.stringify(generateJsonSchema(t));
    }
  }

  private emitCodecExpr(type: Type): string {
    if (!this.typeContainsReifiedParam(type)) {
      return JSON.stringify(generateDecodeCodec(type));
    }
    const t = prune(type);
    switch (t.kind) {
      case "TVar": {
        const idx = this.currentReifiedParamMap.get(t.id);
        return idx !== undefined ? `__spl_reified[${idx}].codec` : `({ k: "Json" })`;
      }
      case "TArray":
      case "TIter":
        return `({ k: "Array", el: ${this.emitCodecExpr(t.element)} })`;
      case "TDict":
        return `({ k: "Dict", val: ${this.emitCodecExpr(t.value)} })`;
      case "TTuple":
        return `({ k: "Tuple", els: [${t.elements.map((el) => this.emitCodecExpr(el)).join(", ")}] })`;
      case "TEnum":
        if (t.name === "Option" && t.typeArgs.length === 1) {
          return `({ k: "Option", inner: ${this.emitCodecExpr(t.typeArgs[0])} })`;
        }
        return JSON.stringify(generateDecodeCodec(t));
      case "TRecord": {
        const flat = flattenRecord(t);
        const fieldPairs: string[] = [];
        for (const [name, fType] of flat.fields) {
          const pf = prune(fType);
          const isOpt = pf.kind === "TEnum" && pf.name === "Option" && pf.typeArgs.length === 1;
          const cCode = this.emitCodecExpr(isOpt ? pf.typeArgs[0] : pf);
          fieldPairs.push(`${JSON.stringify(name)}: { codec: ${cCode}, optional: ${isOpt ? "true" : "false"} }`);
        }
        if (flat.tail.kind === "ROpenDict") {
          return `({ k: "Record", fields: { ${fieldPairs.join(", ")} }, open: true, extraName: ${JSON.stringify(flat.tail.extraName ?? "extra")}, extraCodec: ${this.emitCodecExpr(flat.tail.valueType)} })`;
        }
        return `({ k: "Record", fields: { ${fieldPairs.join(", ")} }, open: ${flat.tail.kind !== "RClosed" ? "true" : "false"} })`;
      }
      case "TNewtype":
        return `(${this.emitReifiedDescriptor(t)}).codec`;
      default:
        return JSON.stringify(generateDecodeCodec(t));
    }
  }

  private emitReifiedDescriptor(type: Type): string {
    const p = prune(type);
    if (p.kind === "TVar") {
      const paramIdx = this.currentReifiedParamMap.get(p.id);
      if (paramIdx !== undefined) {
        return `__spl_reified[${paramIdx}]`;
      }
      return JSON.stringify(generateTypeDescriptor(TStr));
    }
    if (!this.typeContainsReifiedParam(p)) {
      return JSON.stringify(generateTypeDescriptor(p));
    }
    switch (p.kind) {
      case "TArray":
        return `__spl.reifyArray(${this.emitReifiedDescriptor(p.element)})`;
      case "TIter":
        return `__spl.reifyIter(${this.emitReifiedDescriptor(p.element)})`;
      case "TDict":
        return `__spl.reifyDict(${this.emitReifiedDescriptor(p.key)}, ${this.emitReifiedDescriptor(p.value)})`;
      case "TTuple":
        return `__spl.reifyTuple([${p.elements.map((el) => this.emitReifiedDescriptor(el)).join(", ")}])`;
      case "TFn":
        return `__spl.reifyFn([${p.params.map((pt) => this.emitReifiedDescriptor(pt)).join(", ")}], ${this.emitReifiedDescriptor(p.ret)})`;
      case "TNewtype": {
        const tArgs = p.typeArgs.map((ta) => this.emitReifiedDescriptor(ta)).join(", ");
        const docCode = p.doc !== undefined ? `__spl.Some(${JSON.stringify(p.doc)})` : `__spl.None`;
        const hintCode = p.llmHint !== undefined ? `__spl.Some(${JSON.stringify(p.llmHint)})` : `__spl.None`;
        return `__spl.reifyNewtype(${JSON.stringify(p.name)}, [${tArgs}], ${this.emitReifiedDescriptor(p.underlying)}, ${docCode}, ${hintCode})`;
      }
      case "TEnum": {
        if (p.name === "Option" && p.typeArgs.length === 1) {
          return `__spl.reifyOption(${this.emitReifiedDescriptor(p.typeArgs[0])})`;
        }
        const tArgs = p.typeArgs.map((ta) => this.emitReifiedDescriptor(ta)).join(", ");
        const vSpecs = Array.from(p.variants.entries()).map(([vn, vi]) => {
          const fs = vi.fields.map((f) => this.emitReifiedDescriptor(f)).join(", ");
          const vd = vi.doc !== undefined ? `__spl.Some(${JSON.stringify(vi.doc)})` : `__spl.None`;
          const vh = vi.llmHint !== undefined ? `__spl.Some(${JSON.stringify(vi.llmHint)})` : `__spl.None`;
          return `{ name: ${JSON.stringify(vn)}, fields: [${fs}], doc: ${vd}, hint: ${vh} }`;
        });
        const docCode = p.doc !== undefined ? `__spl.Some(${JSON.stringify(p.doc)})` : `__spl.None`;
        const hintCode = p.llmHint !== undefined ? `__spl.Some(${JSON.stringify(p.llmHint)})` : `__spl.None`;
        return `__spl.reifyEnum(${JSON.stringify(p.name)}, [${tArgs}], [${vSpecs.join(", ")}], ${docCode}, ${hintCode})`;
      }
      case "TRecord": {
        const flat = flattenRecord(p);
        const fSpecs: string[] = [];
        for (const [fName, fType] of flat.fields) {
          const pf = prune(fType);
          const isOpt = pf.kind === "TEnum" && pf.name === "Option" && pf.typeArgs.length === 1;
          const descCode = this.emitReifiedDescriptor(pf);
          const innerCode = isOpt ? this.emitReifiedDescriptor(pf.typeArgs[0]) : "null";
          const fd = flat.meta?.fieldDocs.get(fName);
          const fh = flat.meta?.fieldHints.get(fName);
          const fdCode = fd !== undefined ? `__spl.Some(${JSON.stringify(fd)})` : `__spl.None`;
          const fhCode = fh !== undefined ? `__spl.Some(${JSON.stringify(fh)})` : `__spl.None`;
          fSpecs.push(
            `{ name: ${JSON.stringify(fName)}, desc: ${descCode}, optional: ${isOpt ? "true" : "false"}, innerDesc: ${innerCode}, doc: ${fdCode}, hint: ${fhCode} }`
          );
        }
        const tnCode = flat.meta?.typeName ? JSON.stringify(flat.meta.typeName) : "null";
        const docCode = flat.meta?.doc !== undefined ? `__spl.Some(${JSON.stringify(flat.meta.doc)})` : `__spl.None`;
        const hintCode = flat.meta?.llmHint !== undefined ? `__spl.Some(${JSON.stringify(flat.meta.llmHint)})` : `__spl.None`;
        const tailKind =
          flat.tail.kind === "RClosed" ? '"closed"' : flat.tail.kind === "ROpenDict" ? '"openDict"' : '"open"';
        const tailVal =
          flat.tail.kind === "ROpenDict" ? this.emitReifiedDescriptor(flat.tail.valueType) : "null";
        const extraName =
          flat.tail.kind === "ROpenDict" && flat.tail.extraName ? JSON.stringify(flat.tail.extraName) : "null";
        return `__spl.reifyRecord(${tnCode}, ${docCode}, ${hintCode}, [${fSpecs.join(", ")}], ${tailKind}, ${tailVal}, ${extraName})`;
      }
      default:
        return JSON.stringify(generateTypeDescriptor(p));
    }
  }

  private emitReifiedArray(typeVars: Type[]): string {
    const items = typeVars.map((tv) => this.emitReifiedDescriptor(tv));
    return `[${items.join(", ")}]`;
  }

  private emitMatchStmt(
    expr: Extract<Expr, { kind: "MatchExpr" }>,
    ctx: { tailReturn: boolean; tcoName?: string; tcoParams?: string[] }
  ): string {
    const subj = this.tmp("_m");
    const lines: string[] = [`const ${subj} = ${this.emitExpr(expr.subject)};`];

    for (const arm of expr.arms) {
      this.pushScope();
      const { cond, bindings } = this.emitPatternMatch(arm.pattern, subj, false);
      const bodyLines = [...bindings];
      const emitArmBody = () => this.emitTailReturn(arm.body, ctx);

      if (arm.guard) {
        bodyLines.push(`if (${this.emitExpr(arm.guard)}) {\n${indent(emitArmBody())}\n}`);
      } else {
        bodyLines.push(emitArmBody());
      }
      this.popScope();

      if (cond === "true") {
        lines.push(`{\n${indent(bodyLines.join("\n"))}\n}`);
      } else {
        lines.push(`if (${cond}) {\n${indent(bodyLines.join("\n"))}\n}`);
      }
    }

    lines.push(`__spl.panic("Non-exhaustive match at runtime");`);
    return lines.join("\n");
  }

  private emitPatternMatch(
    pat: Pattern,
    target: string,
    mutable: boolean
  ): { cond: string; bindings: string[] } {
    const kw = mutable ? "let" : "const";
    switch (pat.kind) {
      case "WildcardPattern":
        return { cond: "true", bindings: [] };

      case "IdentPattern": {
        const jsName = this.bindVar(pat.name);
        return { cond: "true", bindings: [`${kw} ${jsName} = ${target};`] };
      }

      case "LiteralPattern":
        return { cond: `(${target} === ${JSON.stringify(pat.value)})`, bindings: [] };

      case "TuplePattern": {
        const conds = [`Array.isArray(${target})`, `${target}.length === ${pat.elements.length}`];
        const bindings: string[] = [];
        for (let i = 0; i < pat.elements.length; i++) {
          const sub = this.emitPatternMatch(pat.elements[i], `${target}[${i}]`, mutable);
          if (sub.cond !== "true") conds.push(sub.cond);
          bindings.push(...sub.bindings);
        }
        return { cond: conds.join(" && "), bindings };
      }

      case "ArrayPattern": {
        const lenCheck = pat.rest
          ? `${target}.length >= ${pat.elements.length}`
          : `${target}.length === ${pat.elements.length}`;
        const conds = [`Array.isArray(${target})`, lenCheck];
        const bindings: string[] = [];
        for (let i = 0; i < pat.elements.length; i++) {
          const sub = this.emitPatternMatch(pat.elements[i], `${target}[${i}]`, mutable);
          if (sub.cond !== "true") conds.push(sub.cond);
          bindings.push(...sub.bindings);
        }
        if (pat.rest && pat.rest !== "_") {
          const jsRest = this.bindVar(pat.rest);
          bindings.push(`${kw} ${jsRest} = ${target}.slice(${pat.elements.length});`);
        }
        return { cond: conds.join(" && "), bindings };
      }

      case "EnumPattern": {
        if (this.checked.newtypePatterns.has(pat)) {
          return this.emitPatternMatch(pat.fields[0], target, mutable);
        }
        const conds = [`(${target} != null && ${target}.$tag === ${JSON.stringify(pat.variant)})`];
        const bindings: string[] = [];
        for (let i = 0; i < pat.fields.length; i++) {
          const sub = this.emitPatternMatch(pat.fields[i], `${target}._${i}`, mutable);
          if (sub.cond !== "true") conds.push(sub.cond);
          bindings.push(...sub.bindings);
        }
        return { cond: conds.join(" && "), bindings };
      }

      case "RecordPattern": {
        const conds = [`(${target} != null && typeof ${target} === "object")`];
        const bindings: string[] = [];
        const keys: string[] = [];
        for (const f of pat.fields) {
          keys.push(f.name);
          conds.push(`(${JSON.stringify(f.name)} in ${target})`);
          const sub = this.emitPatternMatch(f.pattern, `${target}[${JSON.stringify(f.name)}]`, mutable);
          if (sub.cond !== "true") conds.push(sub.cond);
          bindings.push(...sub.bindings);
        }
        if (pat.restName && pat.restName !== "_") {
          const jsRest = this.bindVar(pat.restName);
          bindings.push(`${kw} ${jsRest} = __spl.omit(${target}, ${JSON.stringify(keys)});`);
        }
        return { cond: conds.join(" && "), bindings };
      }
    }
  }

  // ==================== AST Analysis Helpers ====================

  private hasSelfTailCall(block: BlockExpr, fnName: string): boolean {
    if (!block.tailExpr) return false;
    return this.exprHasSelfTailCall(block.tailExpr, fnName);
  }

  private exprHasSelfTailCall(expr: Expr, fnName: string): boolean {
    if (expr.kind === "CallExpr" && expr.callee.kind === "IdentExpr" && expr.callee.name === fnName) {
      return true;
    }
    if (expr.kind === "IfExpr") {
      const t = this.hasSelfTailCall(expr.thenBranch, fnName);
      const e = expr.elseBranch
        ? expr.elseBranch.kind === "BlockExpr"
          ? this.hasSelfTailCall(expr.elseBranch, fnName)
          : this.exprHasSelfTailCall(expr.elseBranch, fnName)
        : false;
      return t || e;
    }
    if (expr.kind === "MatchExpr") {
      return expr.arms.some((a) => this.exprHasSelfTailCall(a.body, fnName));
    }
    return false;
  }

  private blockContainsTry(block: BlockExpr): boolean {
    for (const s of block.stmts) {
      if (this.stmtContainsTry(s)) return true;
    }
    return block.tailExpr ? this.exprContainsTry(block.tailExpr) : false;
  }

  private stmtContainsTry(stmt: Stmt): boolean {
    switch (stmt.kind) {
      case "LetStmt": return this.exprContainsTry(stmt.value);
      case "AssignStmt": return this.exprContainsTry(stmt.value);
      case "FieldAssignStmt": return this.exprContainsTry(stmt.object) || this.exprContainsTry(stmt.value);
      case "IndexAssignStmt": return this.exprContainsTry(stmt.object) || this.exprContainsTry(stmt.index) || this.exprContainsTry(stmt.value);
      case "ReturnStmt": return true; // may occur inside expression-position IIFE
      case "WhileStmt": return this.exprContainsTry(stmt.cond) || this.blockContainsTry(stmt.body);
      case "ForStmt": return this.exprContainsTry(stmt.iterable) || this.blockContainsTry(stmt.body);
      case "ExprStmt": return this.exprContainsTry(stmt.expr);
      default: return false;
    }
  }

  private exprContainsTry(expr: Expr): boolean {
    if (expr.kind === "TryExpr" || expr.kind === "ReturnExpr") return true;
    if (expr.kind === "LambdaExpr") return false; // boundary of its own function
    switch (expr.kind) {
      case "UnaryExpr": return this.exprContainsTry(expr.operand);
      case "BinaryExpr": return this.exprContainsTry(expr.left) || this.exprContainsTry(expr.right);
      case "RangeExpr": return this.exprContainsTry(expr.start) || this.exprContainsTry(expr.end) || (expr.step ? this.exprContainsTry(expr.step) : false);
      case "AsExpr": return this.exprContainsTry(expr.expr);
      case "MemberExpr":
      case "OptionalMemberExpr": return this.exprContainsTry(expr.object);
      case "NullCoalesceExpr": return this.exprContainsTry(expr.left) || this.exprContainsTry(expr.right);
      case "IndexExpr": return this.exprContainsTry(expr.object) || this.exprContainsTry(expr.index);
      case "CallExpr": return this.exprContainsTry(expr.callee) || expr.args.some((a) => this.exprContainsTry(a.value));
      case "IfExpr":
        return (
          this.exprContainsTry(expr.cond) ||
          this.blockContainsTry(expr.thenBranch) ||
          (expr.elseBranch
            ? expr.elseBranch.kind === "BlockExpr"
              ? this.blockContainsTry(expr.elseBranch)
              : this.exprContainsTry(expr.elseBranch)
            : false)
        );
      case "MatchExpr":
        return (
          this.exprContainsTry(expr.subject) ||
          expr.arms.some((a) => (a.guard ? this.exprContainsTry(a.guard) : false) || this.exprContainsTry(a.body))
        );
      case "BlockExpr": return this.blockContainsTry(expr);
      case "TupleExpr":
      case "ArrayExpr": return expr.elements.some((e) => this.exprContainsTry(e));
      case "RecordExpr": return expr.entries.some((e) => this.exprContainsTry(e.kind === "Spread" ? e.expr : e.value));
      case "StrInterpExpr":
      case "PromptExpr": return expr.parts.some((p) => typeof p !== "string" && this.exprContainsTry(p));
      case "DecodeExpr": return this.exprContainsTry(expr.arg);
      default: return false;
    }
  }

  private exprContainsAwait(expr: Expr): boolean {
    if (expr.kind === "LambdaExpr") return false;
    if (expr.kind === "CallExpr" && this.checked.asyncCalls.has(expr)) return true;
    switch (expr.kind) {
      case "BlockExpr":
        return (
          expr.stmts.some((s) => this.stmtContainsAwait(s)) ||
          (expr.tailExpr ? this.exprContainsAwait(expr.tailExpr) : false)
        );
      case "IfExpr":
        return (
          this.exprContainsAwait(expr.cond) ||
          this.exprContainsAwait(expr.thenBranch) ||
          (expr.elseBranch ? this.exprContainsAwait(expr.elseBranch) : false)
        );
      case "MatchExpr":
        return (
          this.exprContainsAwait(expr.subject) ||
          expr.arms.some((a) => (a.guard ? this.exprContainsAwait(a.guard) : false) || this.exprContainsAwait(a.body))
        );
      case "CallExpr":
        return this.exprContainsAwait(expr.callee) || expr.args.some((a) => this.exprContainsAwait(a.value));
      case "UnaryExpr":
      case "TryExpr": return this.exprContainsAwait(expr.operand);
      case "BinaryExpr":
      case "NullCoalesceExpr": return this.exprContainsAwait(expr.left) || this.exprContainsAwait(expr.right);
      case "RangeExpr": return this.exprContainsAwait(expr.start) || this.exprContainsAwait(expr.end) || (expr.step ? this.exprContainsAwait(expr.step) : false);
      case "AsExpr": return this.exprContainsAwait(expr.expr);
      case "MemberExpr":
      case "OptionalMemberExpr": return this.exprContainsAwait(expr.object);
      case "IndexExpr": return this.exprContainsAwait(expr.object) || this.exprContainsAwait(expr.index);
      case "TupleExpr":
      case "ArrayExpr": return expr.elements.some((e) => this.exprContainsAwait(e));
      case "RecordExpr": return expr.entries.some((e) => this.exprContainsAwait(e.kind === "Spread" ? e.expr : e.value));
      case "StrInterpExpr":
      case "PromptExpr": return expr.parts.some((p) => typeof p !== "string" && this.exprContainsAwait(p));
      case "DecodeExpr": return this.exprContainsAwait(expr.arg);
      case "ReturnExpr": return expr.value ? this.exprContainsAwait(expr.value) : false;
      default: return false;
    }
  }

  private stmtContainsAwait(stmt: Stmt): boolean {
    switch (stmt.kind) {
      case "LetStmt": return this.exprContainsAwait(stmt.value);
      case "AssignStmt": return this.exprContainsAwait(stmt.value);
      case "FieldAssignStmt": return this.exprContainsAwait(stmt.object) || this.exprContainsAwait(stmt.value);
      case "IndexAssignStmt": return this.exprContainsAwait(stmt.object) || this.exprContainsAwait(stmt.index) || this.exprContainsAwait(stmt.value);
      case "ReturnStmt": return stmt.value ? this.exprContainsAwait(stmt.value) : false;
      case "WhileStmt": return this.exprContainsAwait(stmt.cond) || this.exprContainsAwait(stmt.body);
      case "ForStmt": {
        const r = this.checked.forResolutions.get(stmt);
        const iterAsync = (r?.kind === "ExtensionIter" || r?.kind === "TraitIter") && r.isAsync;
        return iterAsync || this.exprContainsAwait(stmt.iterable) || this.exprContainsAwait(stmt.body);
      }
      case "ExprStmt": return this.exprContainsAwait(stmt.expr);
      default: return false;
    }
  }
}

function indent(s: string): string {
  return s
    .split("\n")
    .map((l) => (l.length > 0 ? `  ${l}` : l))
    .join("\n");
}
