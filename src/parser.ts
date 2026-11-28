import { INT64_MAX, INT64_MIN } from "./canonical.js";
import { KEYWORDS, Token, lex } from "./lexer.js";
import {
  BinaryOp,
  BlockStmt,
  CaseLiteral,
  Expr,
  FnDecl,
  FnParam,
  FsOp,
  InputDecl,
  LValue,
  LValueSeg,
  ProgramAst,
  Span,
  SplCompileError,
  SplDiagnostic,
  StateDecl,
  Stmt,
  SwitchCase,
  TemplatePart,
  TypeAst,
  TypeDecl,
  UnaryOp,
} from "./types.js";

const FS_OPS = new Set<FsOp>(["read", "write", "append", "exists", "list", "stat"]);
const PRIM_TYPES = new Set(["null", "bool", "int", "float", "string", "json", "void", "Error"]);
const EFFECT_ROOTS = new Set(["model", "web", "fs", "shell", "tool", "mcp"]);

export function parse(source: string): ProgramAst {
  const tokens = lex(source);
  const parser = new Parser(tokens);
  return parser.parseProgram();
}

class Parser {
  private pos = 0;
  private diagnostics: SplDiagnostic[] = [];

  constructor(private readonly tokens: Token[]) {}

  private peek(offset = 0): Token {
    return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)];
  }

  private advance(): Token {
    const t = this.peek();
    if (this.pos < this.tokens.length - 1) this.pos++;
    return t;
  }

  private isPunct(val: string, offset = 0): boolean {
    const t = this.peek(offset);
    return t.kind === "PUNCT" && t.value === val;
  }

  private isKw(val: string, offset = 0): boolean {
    const t = this.peek(offset);
    return t.kind === "IDENT" && t.value === val;
  }

  private expectPunct(val: string): Token {
    const t = this.peek();
    if (t.kind === "PUNCT" && t.value === val) {
      return this.advance();
    }
    this.fail("E_PARSE_EXPECTED", `Expected '${val}', found '${t.value || t.kind}'`, t.span, val, t.value || t.kind);
  }

  /**
   * Consume a closing '>' in generic type syntax, splitting '>>' or '>>>' tokens
   * so nested generics like `model.ask<list<int>>` and `list<list<int>>` parse cleanly.
   */
  private expectTypeCloseAngle(): Token {
    const t = this.peek();
    if (t.kind === "PUNCT" && t.value === ">") {
      return this.advance();
    }
    if (t.kind === "PUNCT" && (t.value === ">>" || t.value === ">>>")) {
      const consumedSpan: Span = {
        line: t.span.line,
        col: t.span.col,
        offset: t.span.offset,
        endOffset: t.span.offset + 1,
      };
      const remainingVal = t.value.slice(1);
      this.tokens[this.pos] = {
        kind: "PUNCT",
        value: remainingVal,
        span: {
          line: t.span.line,
          col: t.span.col + 1,
          offset: t.span.offset + 1,
          endOffset: t.span.endOffset,
        },
      };
      return { kind: "PUNCT", value: ">", span: consumedSpan };
    }
    this.fail("E_PARSE_EXPECTED", `Expected '>', found '${t.value || t.kind}'`, t.span, ">", t.value || t.kind);
  }

  private expectKw(val: string): Token {
    const t = this.peek();
    if (t.kind === "IDENT" && t.value === val) {
      return this.advance();
    }
    this.fail("E_PARSE_EXPECTED", `Expected keyword '${val}', found '${t.value || t.kind}'`, t.span, val, t.value || t.kind);
  }

  private expectIdent(allowKeywords = false): Token {
    const t = this.peek();
    if (t.kind === "IDENT" && (allowKeywords || !KEYWORDS.has(t.value))) {
      return this.advance();
    }
    this.fail("E_PARSE_EXPECTED_IDENT", `Expected identifier, found '${t.value || t.kind}'`, t.span, "IDENT", t.value || t.kind);
  }

  private fail(code: string, message: string, span: Span, expected?: string, found?: string): never {
    this.diagnostics.push({ code, message, span, expected, found });
    throw new SplCompileError(this.diagnostics);
  }

  private mergeSpan(start: Span, end: Span): Span {
    return { line: start.line, col: start.col, offset: start.offset, endOffset: end.endOffset };
  }

  parseProgram(): ProgramAst {
    const startSpan = this.peek().span;
    const types: TypeDecl[] = [];
    const inputs: InputDecl[] = [];
    const states: StateDecl[] = [];
    const functions: FnDecl[] = [];
    const topStmts: Stmt[] = [];

    while (this.peek().kind !== "EOF") {
      if (this.isKw("type")) {
        types.push(this.parseTypeDecl());
      } else if (this.isKw("input")) {
        inputs.push(this.parseInputDecl());
      } else if (this.isKw("state")) {
        states.push(this.parseStateDecl());
      } else if (this.isKw("fn")) {
        functions.push(this.parseFnDecl());
      } else {
        break;
      }
    }

    while (this.peek().kind !== "EOF") {
      if (this.isKw("type") || this.isKw("input") || this.isKw("state") || this.isKw("fn")) {
        this.fail(
          "E_PARSE_TOP_DECL_ORDER",
          "Top-level declarations (type, input, state, fn) must appear before top-level statements",
          this.peek().span
        );
      }
      topStmts.push(this.parseStmt());
    }

    return {
      types,
      inputs,
      states,
      functions,
      topStmts,
      span: this.mergeSpan(startSpan, this.peek().span),
    };
  }

  private parseTypeDecl(): TypeDecl {
    const start = this.expectKw("type").span;
    const nameTok = this.expectIdent();
    this.expectPunct("=");
    const typeAst = this.parseTypeExpr();
    const end = this.expectPunct(";").span;
    return { kind: "type_decl", name: nameTok.value, typeAst, span: this.mergeSpan(start, end) };
  }

  private parseInputDecl(): InputDecl {
    const start = this.expectKw("input").span;
    const nameTok = this.expectIdent();
    this.expectPunct(":");
    const typeAst = this.parseTypeExpr();
    let defaultExpr: Expr | undefined;
    if (this.isPunct("=")) {
      this.advance();
      defaultExpr = this.parseExpr();
    }
    const end = this.expectPunct(";").span;
    return { kind: "input_decl", name: nameTok.value, typeAst, defaultExpr, span: this.mergeSpan(start, end) };
  }

  private parseStateDecl(): StateDecl {
    const start = this.expectKw("state").span;
    const nameTok = this.expectIdent();
    this.expectPunct(":");
    const typeAst = this.parseTypeExpr();
    this.expectPunct("=");
    const initExpr = this.parseExpr();
    const end = this.expectPunct(";").span;
    return { kind: "state_decl", name: nameTok.value, typeAst, initExpr, span: this.mergeSpan(start, end) };
  }

  private parseFnDecl(): FnDecl {
    const start = this.expectKw("fn").span;
    const nameTok = this.expectIdent();
    this.expectPunct("(");
    const params: FnParam[] = [];
    if (!this.isPunct(")")) {
      while (true) {
        const pName = this.expectIdent();
        this.expectPunct(":");
        const pType = this.parseTypeExpr();
        params.push({ name: pName.value, typeAst: pType, span: this.mergeSpan(pName.span, pType.span) });
        if (this.isPunct(",")) {
          this.advance();
          continue;
        }
        break;
      }
    }
    this.expectPunct(")");
    this.expectPunct("->");
    const retTypeAst = this.parseTypeExpr();
    const body = this.parseBlock();
    return {
      kind: "fn_decl",
      name: nameTok.value,
      params,
      retTypeAst,
      body,
      span: this.mergeSpan(start, body.span),
    };
  }

  // --- Types ---

  private parseTypeExpr(): TypeAst {
    const first = this.parseNullableType();
    if (!this.isPunct("|")) return first;
    const members: TypeAst[] = [first];
    while (this.isPunct("|")) {
      this.advance();
      members.push(this.parseNullableType());
    }
    return {
      kind: "t_union",
      members,
      span: this.mergeSpan(first.span, members[members.length - 1].span),
    };
  }

  private parseNullableType(): TypeAst {
    let base = this.parseBaseType();
    if (this.isPunct("?")) {
      const q = this.advance();
      base = { kind: "t_nullable", inner: base, span: this.mergeSpan(base.span, q.span) };
    }
    return base;
  }

  private parseBaseType(): TypeAst {
    const t = this.peek();
    if (t.kind === "STRING") {
      this.advance();
      return { kind: "t_str_lit", value: t.value, span: t.span };
    }
    if (this.isPunct("{")) {
      const start = this.advance().span;
      const fields: Array<{ name: string; type: TypeAst; span: Span }> = [];
      while (!this.isPunct("}")) {
        const fName = this.expectIdent();
        this.expectPunct(":");
        const fType = this.parseTypeExpr();
        fields.push({ name: fName.value, type: fType, span: this.mergeSpan(fName.span, fType.span) });
        if (this.isPunct(",")) {
          this.advance();
          if (this.isPunct("}")) break;
        } else {
          break;
        }
      }
      const end = this.expectPunct("}").span;
      return { kind: "t_record", fields, span: this.mergeSpan(start, end) };
    }
    if (t.kind === "IDENT") {
      if (t.value === "list") {
        this.advance();
        this.expectPunct("<");
        const elem = this.parseTypeExpr();
        const end = this.expectTypeCloseAngle().span;
        return { kind: "t_list", elem, span: this.mergeSpan(t.span, end) };
      }
      if (t.value === "map") {
        this.advance();
        this.expectPunct("<");
        const keyTok = this.expectKw("string");
        void keyTok;
        this.expectPunct(",");
        const val = this.parseTypeExpr();
        const end = this.expectTypeCloseAngle().span;
        return { kind: "t_map", value: val, span: this.mergeSpan(t.span, end) };
      }
      if (PRIM_TYPES.has(t.value)) {
        this.advance();
        return {
          kind: "t_prim",
          name: t.value as "null" | "bool" | "int" | "float" | "string" | "json" | "void" | "Error",
          span: t.span,
        };
      }
      if (!KEYWORDS.has(t.value)) {
        this.advance();
        return { kind: "t_named", name: t.value, span: t.span };
      }
    }
    this.fail("E_PARSE_TYPE", `Expected type expression, found '${t.value || t.kind}'`, t.span);
  }

  // --- Statements ---

  private parseBlock(): BlockStmt {
    const start = this.expectPunct("{").span;
    const stmts: Stmt[] = [];
    while (!this.isPunct("}") && this.peek().kind !== "EOF") {
      stmts.push(this.parseStmt());
    }
    const end = this.expectPunct("}").span;
    return { kind: "block", stmts, span: this.mergeSpan(start, end) };
  }

  private parseStmt(): Stmt {
    if (this.isKw("let")) return this.parseLetStmt();
    if (this.isKw("if")) return this.parseIfStmt();
    if (this.isKw("switch")) return this.parseSwitchStmt();
    if (this.isKw("while")) return this.parseWhileStmt();
    if (this.isKw("for")) return this.parseForStmt();
    if (this.isKw("try")) return this.parseTryStmt();
    if (this.isKw("return")) return this.parseReturnStmt();
    if (this.isKw("break")) {
      const s = this.advance().span;
      const e = this.expectPunct(";").span;
      return { kind: "break", span: this.mergeSpan(s, e) };
    }
    if (this.isKw("continue")) {
      const s = this.advance().span;
      const e = this.expectPunct(";").span;
      return { kind: "continue", span: this.mergeSpan(s, e) };
    }

    // Either assign_stmt or expr_stmt
    const expr = this.parseExpr();
    if (this.isPunct("=")) {
      const lval = this.exprToLValue(expr);
      this.advance(); // '='
      const value = this.parseExpr();
      const end = this.expectPunct(";").span;
      return { kind: "assign", target: lval, value, span: this.mergeSpan(expr.span, end) };
    }
    const end = this.expectPunct(";").span;
    return { kind: "expr_stmt", expr, span: this.mergeSpan(expr.span, end) };
  }

  private exprToLValue(expr: Expr): LValue {
    const segments: LValueSeg[] = [];
    let cur: Expr = expr;
    while (true) {
      if (cur.kind === "var_ref") {
        segments.reverse();
        return { root: cur.name, segments, span: expr.span };
      }
      if (cur.kind === "prop_access" && !cur.optional) {
        segments.push({ kind: "field", name: cur.property, span: cur.span });
        cur = cur.object;
        continue;
      }
      if (cur.kind === "index_access" && !cur.optional) {
        segments.push({ kind: "index", index: cur.index, span: cur.span });
        cur = cur.object;
        continue;
      }
      this.fail("E_PARSE_INVALID_LVALUE", "Invalid assignment target", expr.span);
    }
  }

  private parseLetStmt(): Stmt {
    const start = this.expectKw("let").span;
    let mutable = false;
    if (this.isKw("mut")) {
      this.advance();
      mutable = true;
    }
    const nameTok = this.expectIdent();
    let typeAst: TypeAst | undefined;
    if (this.isPunct(":")) {
      this.advance();
      typeAst = this.parseTypeExpr();
    }
    this.expectPunct("=");
    const init = this.parseExpr();
    const end = this.expectPunct(";").span;
    return {
      kind: "let",
      mutable,
      name: nameTok.value,
      typeAst,
      init,
      span: this.mergeSpan(start, end),
    };
  }

  private parseIfStmt(): Extract<Stmt, { kind: "if" }> {
    const start = this.expectKw("if").span;
    this.expectPunct("(");
    const cond = this.parseExpr();
    this.expectPunct(")");
    const thenBlock = this.parseBlock();
    let elseBranch: BlockStmt | Extract<Stmt, { kind: "if" }> | undefined;
    let endSpan = thenBlock.span;
    if (this.isKw("else")) {
      this.advance();
      if (this.isKw("if")) {
        elseBranch = this.parseIfStmt();
        endSpan = elseBranch.span;
      } else {
        elseBranch = this.parseBlock();
        endSpan = elseBranch.span;
      }
    }
    return { kind: "if", cond, thenBlock, elseBranch, span: this.mergeSpan(start, endSpan) };
  }

  private parseSwitchStmt(): Stmt {
    const start = this.expectKw("switch").span;
    this.expectPunct("(");
    const discriminant = this.parseExpr();
    this.expectPunct(")");
    this.expectPunct("{");
    const cases: SwitchCase[] = [];
    let defaultBlock: BlockStmt | undefined;

    while (this.isKw("case")) {
      const cStart = this.advance().span;
      const literals: CaseLiteral[] = [];
      while (true) {
        literals.push(this.parseCaseLiteral());
        if (this.isPunct(",")) {
          this.advance();
          continue;
        }
        break;
      }
      this.expectPunct(":");
      const body = this.parseBlock();
      cases.push({ literals, body, span: this.mergeSpan(cStart, body.span) });
    }
    if (this.isKw("default")) {
      this.advance();
      this.expectPunct(":");
      defaultBlock = this.parseBlock();
    }
    const end = this.expectPunct("}").span;
    return { kind: "switch", discriminant, cases, defaultBlock, span: this.mergeSpan(start, end) };
  }

  private parseCaseLiteral(): CaseLiteral {
    const t = this.peek();
    if (t.kind === "STRING") {
      this.advance();
      return { kind: "string", value: t.value, span: t.span };
    }
    if (t.kind === "INT") {
      this.advance();
      const iv = t.intValue!;
      if (iv > INT64_MAX) {
        this.fail("E_INT_OVERFLOW", `Integer literal ${t.value} exceeds signed 64-bit max`, t.span);
      }
      return { kind: "int", value: iv, span: t.span };
    }
    if (this.isKw("true")) {
      this.advance();
      return { kind: "bool", value: true, span: t.span };
    }
    if (this.isKw("false")) {
      this.advance();
      return { kind: "bool", value: false, span: t.span };
    }
    this.fail("E_PARSE_CASE_LITERAL", `Expected string, int, or bool literal in case, found '${t.value || t.kind}'`, t.span);
  }

  private parseWhileStmt(): Stmt {
    const start = this.expectKw("while").span;
    this.expectPunct("(");
    const cond = this.parseExpr();
    this.expectPunct(")");
    const body = this.parseBlock();
    return { kind: "while", cond, body, span: this.mergeSpan(start, body.span) };
  }

  private parseForStmt(): Stmt {
    const start = this.expectKw("for").span;
    this.expectPunct("(");
    const itemTok = this.expectIdent();
    this.expectKw("in");
    const iterable = this.parseExpr();
    this.expectPunct(")");
    const body = this.parseBlock();
    return { kind: "for", itemName: itemTok.value, iterable, body, span: this.mergeSpan(start, body.span) };
  }

  private parseTryStmt(): Stmt {
    const start = this.expectKw("try").span;
    const tryBlock = this.parseBlock();
    this.expectKw("catch");
    this.expectPunct("(");
    const errTok = this.expectIdent();
    this.expectPunct(")");
    const catchBlock = this.parseBlock();
    return {
      kind: "try",
      tryBlock,
      errName: errTok.value,
      catchBlock,
      span: this.mergeSpan(start, catchBlock.span),
    };
  }

  private parseReturnStmt(): Stmt {
    const start = this.expectKw("return").span;
    let value: Expr | undefined;
    if (!this.isPunct(";")) {
      value = this.parseExpr();
    }
    const end = this.expectPunct(";").span;
    return { kind: "return", value, span: this.mergeSpan(start, end) };
  }

  // --- Expressions (lowest to highest precedence) ---

  private parseExpr(): Expr {
    return this.parseCoalesce();
  }

  private parseLeftBinary(next: () => Expr, ops: BinaryOp[]): Expr {
    let left = next();
    while (this.peek().kind === "PUNCT" && ops.includes(this.peek().value as BinaryOp)) {
      const op = this.advance().value as BinaryOp;
      const right = next();
      left = { kind: "binary", op, left, right, span: this.mergeSpan(left.span, right.span) };
    }
    return left;
  }

  private parseCoalesce(): Expr {
    return this.parseLeftBinary(() => this.parseOr(), ["??"]);
  }
  private parseOr(): Expr {
    return this.parseLeftBinary(() => this.parseAnd(), ["||"]);
  }
  private parseAnd(): Expr {
    return this.parseLeftBinary(() => this.parseBitOr(), ["&&"]);
  }
  private parseBitOr(): Expr {
    return this.parseLeftBinary(() => this.parseBitXor(), ["|"]);
  }
  private parseBitXor(): Expr {
    return this.parseLeftBinary(() => this.parseBitAnd(), ["^"]);
  }
  private parseBitAnd(): Expr {
    return this.parseLeftBinary(() => this.parseEq(), ["&"]);
  }
  private parseEq(): Expr {
    return this.parseLeftBinary(() => this.parseRel(), ["==", "!="]);
  }
  private parseRel(): Expr {
    return this.parseLeftBinary(() => this.parseShift(), ["<=", ">=", "<", ">"]);
  }
  private parseShift(): Expr {
    return this.parseLeftBinary(() => this.parseAdd(), [">>>", "<<", ">>"]);
  }
  private parseAdd(): Expr {
    return this.parseLeftBinary(() => this.parseMul(), ["+", "-"]);
  }
  private parseMul(): Expr {
    return this.parseLeftBinary(() => this.parseCast(), ["*", "/", "%"]);
  }

  private parseCast(): Expr {
    const expr = this.parseUnary();
    if (this.isKw("as")) {
      this.advance();
      const targetTypeAst = this.parseTypeExpr();
      return { kind: "cast", expr, targetTypeAst, span: this.mergeSpan(expr.span, targetTypeAst.span) };
    }
    return expr;
  }

  private parseUnary(): Expr {
    if (this.isPunct("!") || this.isPunct("-") || this.isPunct("~")) {
      const opTok = this.advance();
      const op = opTok.value as UnaryOp;
      // Special case §3.1: -9223372036854775808 is INT64_MIN
      if (op === "-" && this.peek().kind === "INT" && this.peek().intValue === 9223372036854775808n) {
        const intTok = this.advance();
        return { kind: "lit_int", value: INT64_MIN, span: this.mergeSpan(opTok.span, intTok.span) };
      }
      const operand = this.parseUnary();
      return { kind: "unary", op, operand, span: this.mergeSpan(opTok.span, operand.span) };
    }
    return this.parsePostfix();
  }

  private parsePostfix(): Expr {
    let expr = this.parsePrimary();
    while (true) {
      if (this.isPunct(".")) {
        this.advance();
        const prop = this.expectIdent();
        expr = {
          kind: "prop_access",
          object: expr,
          property: prop.value,
          optional: false,
          span: this.mergeSpan(expr.span, prop.span),
        };
      } else if (this.isPunct("?.")) {
        this.advance();
        const prop = this.expectIdent();
        expr = {
          kind: "prop_access",
          object: expr,
          property: prop.value,
          optional: true,
          span: this.mergeSpan(expr.span, prop.span),
        };
      } else if (this.isPunct("[")) {
        this.advance();
        const idx = this.parseExpr();
        const end = this.expectPunct("]").span;
        expr = {
          kind: "index_access",
          object: expr,
          index: idx,
          optional: false,
          span: this.mergeSpan(expr.span, end),
        };
      } else if (this.isPunct("?.[")) {
        this.advance();
        const idx = this.parseExpr();
        const end = this.expectPunct("]").span;
        expr = {
          kind: "index_access",
          object: expr,
          index: idx,
          optional: true,
          span: this.mergeSpan(expr.span, end),
        };
      } else if (this.isPunct("(")) {
        const { args, endSpan } = this.parseCallArgs();
        expr = {
          kind: "call",
          callee: expr,
          args,
          span: this.mergeSpan(expr.span, endSpan),
        };
      } else {
        break;
      }
    }
    return expr;
  }

  private parseCallArgs(): { args: Expr[]; endSpan: Span } {
    this.expectPunct("(");
    const args: Expr[] = [];
    if (!this.isPunct(")")) {
      while (true) {
        args.push(this.parseExpr());
        if (this.isPunct(",")) {
          this.advance();
          if (this.isPunct(")")) break;
        } else {
          break;
        }
      }
    }
    const endSpan = this.expectPunct(")").span;
    return { args, endSpan };
  }

  private parsePrimary(): Expr {
    const t = this.peek();

    // Explicit effect expressions
    if (t.kind === "IDENT" && EFFECT_ROOTS.has(t.value) && this.isPunct(".", 1)) {
      return this.parseEffectExpr();
    }

    if (this.isKw("null")) {
      this.advance();
      return { kind: "lit_null", span: t.span };
    }
    if (this.isKw("true")) {
      this.advance();
      return { kind: "lit_bool", value: true, span: t.span };
    }
    if (this.isKw("false")) {
      this.advance();
      return { kind: "lit_bool", value: false, span: t.span };
    }
    if (t.kind === "INT") {
      this.advance();
      const iv = t.intValue!;
      if (iv > INT64_MAX) {
        this.fail("E_INT_OVERFLOW", `Integer literal ${t.value} exceeds signed 64-bit max`, t.span);
      }
      return { kind: "lit_int", value: iv, span: t.span };
    }
    if (t.kind === "FLOAT") {
      this.advance();
      return { kind: "lit_float", value: t.floatValue!, span: t.span };
    }
    if (t.kind === "STRING") {
      this.advance();
      return { kind: "lit_string", value: t.value, span: t.span };
    }
    if (t.kind === "TEMPLATE_START") {
      return this.parseTemplateStr();
    }
    if (this.isPunct("[")) {
      return this.parseListLit();
    }
    if (this.isPunct("{")) {
      return this.parseRecordLit();
    }
    if (this.isPunct("(")) {
      this.advance();
      const inner = this.parseExpr();
      this.expectPunct(")");
      return inner;
    }
    if (t.kind === "IDENT" && !KEYWORDS.has(t.value)) {
      this.advance();
      return { kind: "var_ref", name: t.value, span: t.span };
    }

    this.fail("E_PARSE_EXPR", `Unexpected token '${t.value || t.kind}' in expression`, t.span);
  }

  private parseEffectExpr(): Expr {
    const rootTok = this.advance();
    this.expectPunct(".");
    const memberTok = this.expectIdent();

    if (rootTok.value === "model") {
      if (memberTok.value === "ask") {
        this.expectPunct("<");
        const typeAst = this.parseTypeExpr();
        this.expectTypeCloseAngle();
        const { args, endSpan } = this.parseCallArgs();
        return { kind: "eff_ask", typeAst, args, span: this.mergeSpan(rootTok.span, endSpan) };
      }
      if (memberTok.value === "decide") {
        const { args, endSpan } = this.parseCallArgs();
        return { kind: "eff_decide", args, span: this.mergeSpan(rootTok.span, endSpan) };
      }
      this.fail("E_PARSE_EFFECT", `Unknown model effect 'model.${memberTok.value}'`, memberTok.span);
    }

    if (rootTok.value === "web") {
      if (memberTok.value === "search") {
        const { args, endSpan } = this.parseCallArgs();
        return { kind: "eff_web_search", args, span: this.mergeSpan(rootTok.span, endSpan) };
      }
      if (memberTok.value === "fetch") {
        const { args, endSpan } = this.parseCallArgs();
        return { kind: "eff_web_fetch", args, span: this.mergeSpan(rootTok.span, endSpan) };
      }
      this.fail("E_PARSE_EFFECT", `Unknown web effect 'web.${memberTok.value}'`, memberTok.span);
    }

    if (rootTok.value === "fs") {
      if (!FS_OPS.has(memberTok.value as FsOp)) {
        this.fail("E_PARSE_EFFECT", `Unknown fs operation 'fs.${memberTok.value}'`, memberTok.span);
      }
      const { args, endSpan } = this.parseCallArgs();
      return { kind: "eff_fs", op: memberTok.value as FsOp, args, span: this.mergeSpan(rootTok.span, endSpan) };
    }

    if (rootTok.value === "shell") {
      if (memberTok.value !== "run") {
        this.fail("E_PARSE_EFFECT", `Unknown shell effect 'shell.${memberTok.value}'`, memberTok.span);
      }
      const { args, endSpan } = this.parseCallArgs();
      return { kind: "eff_shell", args, span: this.mergeSpan(rootTok.span, endSpan) };
    }

    if (rootTok.value === "tool") {
      this.expectPunct("(");
      const arg = this.parseExpr();
      const endSpan = this.expectPunct(")").span;
      return { kind: "eff_js_tool", name: memberTok.value, arg, span: this.mergeSpan(rootTok.span, endSpan) };
    }

    if (rootTok.value === "mcp") {
      this.expectPunct(".");
      const toolTok = this.expectIdent();
      this.expectPunct("(");
      const arg = this.parseExpr();
      const endSpan = this.expectPunct(")").span;
      return {
        kind: "eff_mcp_tool",
        server: memberTok.value,
        tool: toolTok.value,
        arg,
        span: this.mergeSpan(rootTok.span, endSpan),
      };
    }

    this.fail("E_PARSE_EFFECT", `Unknown effect namespace '${rootTok.value}'`, rootTok.span);
  }

  private parseTemplateStr(): Expr {
    const start = this.advance().span; // TEMPLATE_START
    const parts: TemplatePart[] = [];
    while (this.peek().kind !== "TEMPLATE_END" && this.peek().kind !== "EOF") {
      const t = this.peek();
      if (t.kind === "TEMPLATE_TEXT") {
        this.advance();
        parts.push({ kind: "text", value: t.value, span: t.span });
      } else if (t.kind === "TEMPLATE_EXPR_START") {
        const es = this.advance().span;
        const expr = this.parseExpr();
        const ee = this.peek();
        if (ee.kind !== "TEMPLATE_EXPR_END") {
          this.fail("E_PARSE_TEMPLATE", "Expected '}' to close template interpolation", ee.span);
        }
        this.advance();
        parts.push({ kind: "expr", expr, span: this.mergeSpan(es, ee.span) });
      } else {
        this.fail("E_PARSE_TEMPLATE", `Unexpected token in template string: '${t.value || t.kind}'`, t.span);
      }
    }
    const end = this.peek();
    if (end.kind !== "TEMPLATE_END") {
      this.fail("E_PARSE_TEMPLATE", "Unterminated template string", end.span);
    }
    this.advance();
    return { kind: "template_str", parts, span: this.mergeSpan(start, end.span) };
  }

  private parseListLit(): Expr {
    const start = this.expectPunct("[").span;
    const items: Expr[] = [];
    if (!this.isPunct("]")) {
      while (true) {
        items.push(this.parseExpr());
        if (this.isPunct(",")) {
          this.advance();
          if (this.isPunct("]")) break;
        } else {
          break;
        }
      }
    }
    const end = this.expectPunct("]").span;
    return { kind: "list_lit", items, span: this.mergeSpan(start, end) };
  }

  private parseRecordLit(): Expr {
    const start = this.expectPunct("{").span;
    const entries: Array<{ key: string; value: Expr; span: Span }> = [];
    if (!this.isPunct("}")) {
      while (true) {
        const kt = this.peek();
        let key: string;
        if (kt.kind === "STRING") {
          this.advance();
          key = kt.value;
        } else if (kt.kind === "IDENT") {
          this.advance();
          key = kt.value;
        } else {
          this.fail("E_PARSE_RECORD_KEY", `Expected identifier or string key, found '${kt.value || kt.kind}'`, kt.span);
        }
        this.expectPunct(":");
        const value = this.parseExpr();
        entries.push({ key, value, span: this.mergeSpan(kt.span, value.span) });
        if (this.isPunct(",")) {
          this.advance();
          if (this.isPunct("}")) break;
        } else {
          break;
        }
      }
    }
    const end = this.expectPunct("}").span;
    return { kind: "record_lit", entries, span: this.mergeSpan(start, end) };
  }
}
