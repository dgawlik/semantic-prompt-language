import { lex, type Token, type TokenKind } from "./lexer.js";
import { SplError, type Span } from "./errors.js";
import type {
  Program, TopItem, ImportDecl, ImportSpecifier, TypeDecl, TypeParam,
  EnumDecl, EnumVariantDecl, TraitDecl, TraitMethodSig, ImplDecl,
  FnDecl, ExternFnDecl, ParamDecl, TypeExpr, StructFieldDecl, RecordRowTail,
  Stmt, LetStmt, Expr, CallArg, MatchArm, Pattern, RecordFieldPattern,
  RecordFieldInit, RecordSpreadInit, BlockExpr, LambdaExpr, PromptExpr,
} from "./ast.js";

export function parse(source: string, file = "<input>", isStdlib = false): Program {
  const tokens = lex(source, file);
  const parser = new Parser(tokens, file, isStdlib);
  return parser.parseProgram();
}

class Parser {
  private pos = 0;

  constructor(
    private readonly tokens: Token[],
    private readonly file: string,
    private readonly isStdlib: boolean
  ) {}

  // ==================== Token Navigation ====================

  private peekRaw(offset = 0): Token {
    return this.tokens[this.pos + offset] ?? this.tokens[this.tokens.length - 1];
  }

  private isCommentKind(kind: TokenKind): boolean {
    return kind === "Comment" || kind === "DocComment" || kind === "LlmHint";
  }

  /** Peek next significant token, skipping newlines and comments */
  private peek(offset = 0): Token {
    let i = this.pos;
    let seen = 0;
    while (i < this.tokens.length) {
      const t = this.tokens[i];
      if (t.kind !== "Newline" && !this.isCommentKind(t.kind)) {
        if (seen === offset) return t;
        seen++;
      }
      i++;
    }
    return this.tokens[this.tokens.length - 1];
  }

  /** Peek next token skipping only comments (keeps Newline visible for statement termination) */
  private peekSameLine(): Token {
    let i = this.pos;
    while (i < this.tokens.length && this.isCommentKind(this.tokens[i].kind)) {
      i++;
    }
    return this.tokens[i] ?? this.tokens[this.tokens.length - 1];
  }

  private skipTrivia(): void {
    while (
      this.pos < this.tokens.length &&
      (this.tokens[this.pos].kind === "Newline" || this.isCommentKind(this.tokens[this.pos].kind))
    ) {
      this.pos++;
    }
  }

  /** Collect contiguous non-trailing `///` doc-comments and `''` LLM hints right before a declaration/field */
  private collectLeadingAnnotations(): { doc?: string; llmHint?: string } {
    let docLines: string[] = [];
    let hintLines: string[] = [];
    while (this.pos < this.tokens.length) {
      const t = this.tokens[this.pos];
      if (t.kind === "DocComment" && !t.trailing) {
        docLines.push(t.value);
        this.pos++;
        if (this.tokens[this.pos]?.kind === "Newline") this.pos++;
        continue;
      }
      if (t.kind === "LlmHint" && !t.trailing) {
        hintLines.push(t.value);
        this.pos++;
        if (this.tokens[this.pos]?.kind === "Newline") this.pos++;
        continue;
      }
      if (t.kind === "Comment") {
        // Regular `//` comments are ignored and don't attach
        this.pos++;
        if (this.tokens[this.pos]?.kind === "Newline") this.pos++;
        continue;
      }
      if (t.kind === "Newline") {
        // Blank line resets annotation attachment
        docLines = [];
        hintLines = [];
        this.pos++;
        continue;
      }
      if ((t.kind === "DocComment" || t.kind === "LlmHint") && t.trailing) {
        this.pos++;
        continue;
      }
      break;
    }
    return {
      doc: docLines.length > 0 ? docLines.join("\n") : undefined,
      llmHint: hintLines.length > 0 ? hintLines.join("\n") : undefined,
    };
  }

  /** Collect inline trailing `///` doc-comment or `''` LLM hint on the same line */
  private collectTrailingAnnotations(): { doc?: string; llmHint?: string } {
    let doc: string | undefined;
    let llmHint: string | undefined;
    while (this.pos < this.tokens.length) {
      const t = this.tokens[this.pos];
      if (!t.trailing) break;
      if (t.kind === "DocComment") {
        doc = mergeDocs(doc, t.value);
        this.pos++;
      } else if (t.kind === "LlmHint") {
        llmHint = mergeDocs(llmHint, t.value);
        this.pos++;
      } else if (t.kind === "Comment") {
        this.pos++;
      } else {
        break;
      }
    }
    return { doc, llmHint };
  }

  private next(): Token {
    this.skipTrivia();
    const t = this.tokens[this.pos] ?? this.tokens[this.tokens.length - 1];
    if (this.pos < this.tokens.length - 1) this.pos++;
    return t;
  }

  private expect(kind: TokenKind, msg?: string): Token {
    const t = this.next();
    if (t.kind !== kind) {
      throw new SplError(
        "parse",
        msg ?? `Expected '${kind}', found '${t.value || t.kind}'`,
        t.span
      );
    }
    return t;
  }

  private match(kind: TokenKind): boolean {
    if (this.peek().kind === kind) {
      this.next();
      return true;
    }
    return false;
  }

  private consumeStatementSep(): void {
    while (this.pos < this.tokens.length) {
      const k = this.tokens[this.pos].kind;
      if (k === ";" || k === "Newline" || k === "Comment") {
        this.pos++;
      } else {
        break;
      }
    }
  }

  private isAtLineBreakOrEnd(): boolean {
    const k = this.peekSameLine().kind;
    return k === "Newline" || k === ";" || k === "}" || k === ")" || k === "]" || k === "," || k === "EOF";
  }

  // ==================== Program ====================

  parseProgram(): Program {
    const items: TopItem[] = [];
    while (true) {
      const ann = this.collectLeadingAnnotations();
      const t = this.peek();
      if (t.kind === "EOF") break;
      if (t.kind === ";") {
        this.next();
        continue;
      }
      items.push(this.parseTopItem(ann));
    }
    return { file: this.file, isStdlib: this.isStdlib, items };
  }

  private parseTopItem(ann: { doc?: string; llmHint?: string }): TopItem {
    const t = this.peek();
    if (t.kind === "import") return this.parseImport();

    let pub = false;
    if (t.kind === "pub") {
      this.next();
      pub = true;
    }

    const nextTok = this.peek();
    switch (nextTok.kind) {
      case "type":
        return this.parseTypeDecl(pub, ann);
      case "enum":
        return this.parseEnumDecl(pub, ann);
      case "trait":
        return this.parseTraitDecl(pub, ann);
      case "impl":
        if (pub) throw new SplError("parse", "`impl` blocks cannot be marked `pub`", nextTok.span);
        return this.parseImplDecl();
      case "extern":
        return this.parseExternFnDecl(pub, ann);
      case "fn":
        return this.parseFnDecl(pub, ann, false);
      case "Ident":
        if (nextTok.value === "reified" && this.peek(1).kind === "fn") {
          this.next();
          return this.parseFnDecl(pub, ann, true);
        }
        if (pub) {
          throw new SplError("parse", `Unexpected 'pub' before '${nextTok.value || nextTok.kind}'`, nextTok.span);
        }
        return this.parseExprOrAssignTopItem();
      case "let":
        return this.parseLetStmt(pub);
      case "while":
        if (pub) throw new SplError("parse", "`while` cannot be marked `pub`", nextTok.span);
        return this.parseWhileStmt() as TopItem;
      case "for":
        if (pub) throw new SplError("parse", "`for` cannot be marked `pub`", nextTok.span);
        return this.parseForStmt() as TopItem;
      default:
        if (pub) {
          throw new SplError("parse", `Unexpected 'pub' before '${nextTok.value || nextTok.kind}'`, nextTok.span);
        }
        return this.parseExprOrAssignTopItem();
    }
  }

  private parseExprOrAssignTopItem(): TopItem {
    const expr = this.parseExpr(true);
    const assign = this.finishAssignStmt(expr);
    if (assign) return assign;
    return { kind: "ExprStmt", expr, span: expr.span };
  }

  private finishAssignStmt(expr: Expr): (Stmt & TopItem) | null {
    if (this.peekSameLine().kind !== "=") return null;
    const eqTok = this.next();
    const value = this.parseExpr(true);
    if (expr.kind === "IdentExpr") {
      return { kind: "AssignStmt", target: expr.name, value, span: expr.span };
    }
    if (expr.kind === "MemberExpr") {
      return { kind: "FieldAssignStmt", object: expr.object, property: expr.property, value, span: expr.span };
    }
    if (expr.kind === "IndexExpr") {
      return { kind: "IndexAssignStmt", object: expr.object, index: expr.index, value, span: expr.span };
    }
    throw new SplError("parse", "Invalid assignment target (expected variable, field, or index expression)", eqTok.span);
  }

  private parseImport(): ImportDecl {
    const start = this.expect("import").span;
    const specifiers: ImportSpecifier[] = [];
    let defaultAlias: string | undefined;

    if (this.match("{")) {
      while (this.peek().kind !== "}" && this.peek().kind !== "EOF") {
        const name = this.expect("Ident", "Expected imported symbol name").value;
        let alias: string | undefined;
        if (this.match("as")) {
          alias = this.expect("Ident", "Expected alias name after 'as'").value;
        }
        specifiers.push({ name, alias });
        if (!this.match(",")) break;
      }
      this.expect("}");
    } else {
      defaultAlias = this.expect("Ident", "Expected import alias or `{ ... }`").value;
      if (this.match(",")) {
        this.expect("{");
        while (this.peek().kind !== "}" && this.peek().kind !== "EOF") {
          const name = this.expect("Ident").value;
          let alias: string | undefined;
          if (this.match("as")) alias = this.expect("Ident").value;
          specifiers.push({ name, alias });
          if (!this.match(",")) break;
        }
        this.expect("}");
      }
    }

    this.expect("from", "Expected 'from' in import declaration");
    const from = this.expect("Str", "Expected module path string after 'from'").value;
    return { kind: "ImportDecl", specifiers, defaultAlias, from, span: start };
  }

  private parseTypeParams(): TypeParam[] {
    const params: TypeParam[] = [];
    if (!this.match("<")) return params;
    while (this.peek().kind !== ">" && this.peek().kind !== "EOF") {
      const name = this.expect("Ident", "Expected type parameter name").value;
      const bounds: string[] = [];
      if (this.match(":")) {
        bounds.push(this.expect("Ident", "Expected trait bound name").value);
        while (this.match("+")) {
          bounds.push(this.expect("Ident", "Expected trait bound name after '+'").value);
        }
      }
      params.push({ name, bounds });
      if (!this.match(",")) break;
    }
    this.expect(">", "Expected '>' to close type parameters");
    return params;
  }

  private parseTypeDecl(pub: boolean, ann: { doc?: string; llmHint?: string }): TypeDecl {
    const start = this.expect("type").span;
    const name = this.expect("Ident", "Expected type name").value;
    const typeParams = this.parseTypeParams();
    this.expect("=", "Expected '=' in type declaration");
    const body = this.parseTypeExpr();
    return { kind: "TypeDecl", pub, name, typeParams, doc: ann.doc, llmHint: ann.llmHint, body, span: start };
  }

  private parseEnumDecl(pub: boolean, ann: { doc?: string; llmHint?: string }): EnumDecl {
    const start = this.expect("enum").span;
    const name = this.expect("Ident", "Expected enum name").value;
    const typeParams = this.parseTypeParams();
    this.expect("{");
    const variants: EnumVariantDecl[] = [];
    while (true) {
      const lead = this.collectLeadingAnnotations();
      if (this.peek().kind === "}" || this.peek().kind === "EOF") break;
      const vTok = this.expect("Ident", "Expected enum variant name");
      const fields: TypeExpr[] = [];
      let namedFields: StructFieldDecl[] | undefined;

      if (this.match("(")) {
        while (this.peek().kind !== ")" && this.peek().kind !== "EOF") {
          fields.push(this.parseTypeExpr());
          if (!this.match(",")) break;
        }
        this.expect(")");
      } else if (this.match("{")) {
        namedFields = this.parseStructFieldsOnly();
        this.expect("}");
      }

      const trail = this.collectTrailingAnnotations();
      variants.push({
        name: vTok.value,
        fields,
        namedFields,
        doc: mergeDocs(lead.doc, trail.doc),
        llmHint: mergeDocs(lead.llmHint, trail.llmHint),
        span: vTok.span,
      });
      this.match(",");
    }
    this.expect("}");
    return { kind: "EnumDecl", pub, name, typeParams, doc: ann.doc, llmHint: ann.llmHint, variants, span: start };
  }

  private parseTraitDecl(pub: boolean, ann: { doc?: string; llmHint?: string }): TraitDecl {
    const start = this.expect("trait").span;
    const name = this.expect("Ident", "Expected trait name").value;
    const typeParams = this.parseTypeParams();
    this.expect("{");
    const methods: TraitMethodSig[] = [];
    while (this.peek().kind !== "}" && this.peek().kind !== "EOF") {
      this.collectLeadingAnnotations();
      if (this.peek().kind === "}") break;
      const fnStart = this.expect("fn").span;
      const mName = this.expect("Ident", "Expected trait method name").value;
      const params = this.parseParamList();
      let returnType: TypeExpr | undefined;
      if (this.match("->")) returnType = this.parseTypeExpr();
      methods.push({ name: mName, params, returnType, span: fnStart });
      this.match(";");
    }
    this.expect("}");
    return { kind: "TraitDecl", pub, name, typeParams, doc: ann.doc, llmHint: ann.llmHint, methods, span: start };
  }

  private parseImplDecl(): ImplDecl {
    const start = this.expect("impl").span;
    const typeParams = this.parseTypeParams();
    const traitName = this.expect("Ident", "Expected trait name in `impl`").value;
    this.expect("for", "Expected 'for' in `impl Trait for Type`");
    const targetType = this.parseTypeExpr();
    this.expect("{");
    const methods: FnDecl[] = [];
    while (true) {
      const mAnn = this.collectLeadingAnnotations();
      if (this.peek().kind === "}" || this.peek().kind === "EOF") break;
      methods.push(this.parseFnDecl(false, mAnn));
    }
    this.expect("}");
    return { kind: "ImplDecl", traitName, typeParams, targetType, methods, span: start };
  }

  private parseExternFnDecl(pub: boolean, ann: { doc?: string; llmHint?: string }): ExternFnDecl {
    const start = this.expect("extern").span;
    let isAsync = false;
    let reified = false;
    while (this.peek().kind === "Ident" && (this.peek().value === "async" || this.peek().value === "reified")) {
      const kw = this.next().value;
      if (kw === "async") isAsync = true;
      if (kw === "reified") reified = true;
    }
    this.expect("fn", "Expected 'fn' after 'extern'");
    const name = this.expect("Ident", "Expected extern function name").value;
    const typeParams = this.parseTypeParams();
    const params = this.parseParamList();
    this.expect("->", "Expected '-> ReturnType' on extern function");
    const returnType = this.parseTypeExpr();
    this.expect("=", "Expected '= \"module:jsName\"' on extern function");
    const binding = this.expect("Str", "Expected JS binding string like \"ffi_universal:httpFetch\"").value;
    const parts = binding.split(":");
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new SplError("parse", `Invalid extern binding "${binding}"; expected "module:exportName"`, start);
    }
    return {
      kind: "ExternFnDecl",
      pub,
      name,
      typeParams,
      params,
      returnType,
      jsModule: parts[0],
      jsName: parts[1],
      isAsync,
      reified,
      doc: ann.doc,
      llmHint: ann.llmHint,
      span: start,
    };
  }

  private parseFnDecl(pub: boolean, ann: { doc?: string; llmHint?: string }, reified = false): FnDecl {
    const start = this.expect("fn").span;
    let receiverType: TypeExpr | undefined;
    let name: string;

    // Extension method check:
    // 1) `fn { firstName: Str, .. }.greet(self) -> Str`
    // 2) `fn Person.fullName(self) -> Str` or `fn Array<T>.len(self) -> Int`
    if (this.peek().kind === "{") {
      receiverType = this.parseTypeExpr();
      this.expect(".", "Expected '.' after receiver type in extension method");
      name = this.expect("Ident", "Expected method name after '.'").value;
    } else if (this.looksLikeExtensionMethod()) {
      receiverType = this.parseTypeExpr();
      this.expect(".", "Expected '.' after receiver type in extension method");
      name = this.expect("Ident", "Expected method name after '.'").value;
    } else {
      name = this.expect("Ident", "Expected function name").value;
    }

    const typeParams = this.parseTypeParams();
    const params = this.parseParamList();
    let returnType: TypeExpr | undefined;
    if (this.match("->")) {
      returnType = this.parseTypeExpr();
    }
    const body = this.parseBlockExpr();
    return {
      kind: "FnDecl",
      pub,
      reified,
      name,
      receiverType,
      typeParams,
      params,
      returnType,
      doc: ann.doc,
      llmHint: ann.llmHint,
      body,
      span: start,
    };
  }

  private looksLikeExtensionMethod(): boolean {
    const saved = this.pos;
    try {
      if (this.peek().kind !== "Ident") return false;
      this.next();
      if (this.peek().kind === "<") {
        let depth = 0;
        while (this.peek().kind !== "EOF") {
          const k = this.next().kind;
          if (k === "<") depth++;
          else if (k === ">") {
            depth--;
            if (depth === 0) break;
          }
        }
      }
      return this.peek().kind === ".";
    } finally {
      this.pos = saved;
    }
  }

  private parseParamList(): ParamDecl[] {
    this.expect("(");
    const params: ParamDecl[] = [];
    while (this.peek().kind !== ")" && this.peek().kind !== "EOF") {
      const mutable = this.match("mut");
      const pTok = this.expect("Ident", "Expected parameter name");
      let type: TypeExpr | undefined;
      if (this.match(":")) {
        type = this.parseTypeExpr();
      }
      let defaultValue: Expr | undefined;
      if (this.match("=")) {
        defaultValue = this.parseExpr(true);
      }
      params.push({ name: pTok.value, mutable: mutable || undefined, type, defaultValue, span: pTok.span });
      if (!this.match(",")) break;
    }
    this.expect(")");
    return params;
  }

  // ==================== Type Expressions ====================

  parseTypeExpr(): TypeExpr {
    let base = this.parsePrimaryType();
    // Suffix `?` -> Option<T>
    while (this.peekSameLine().kind === "?") {
      const q = this.next();
      base = { kind: "OptionTypeExpr", inner: base, span: q.span };
    }
    return base;
  }

  private parsePrimaryType(): TypeExpr {
    const t = this.peek();

    // `struct { ... }` or `{ ... }`
    if (t.kind === "struct") {
      const start = this.next().span;
      return this.parseRecordType(true, start);
    }
    if (t.kind === "{") {
      return this.parseRecordType(false, t.span);
    }

    // `fn(A, B) -> R` or `async fn(A, B) -> R`
    if (t.kind === "fn" || (t.kind === "Ident" && t.value === "async" && this.peek(1).kind === "fn")) {
      let isAsync = false;
      const start = this.next().span;
      if (t.kind === "Ident") {
        isAsync = true;
        this.expect("fn");
      }
      this.expect("(");
      const params: TypeExpr[] = [];
      while (this.peek().kind !== ")" && this.peek().kind !== "EOF") {
        params.push(this.parseTypeExpr());
        if (!this.match(",")) break;
      }
      this.expect(")");
      this.expect("->", "Expected '->' in function type");
      const returnType = this.parseTypeExpr();
      return { kind: "FnTypeExpr", params, returnType, isAsync, span: start };
    }

    // Tuple type `(A, B)` or parenthesized type `(A)`
    if (t.kind === "(") {
      const start = this.next().span;
      const elements: TypeExpr[] = [];
      if (this.peek().kind !== ")") {
        elements.push(this.parseTypeExpr());
        while (this.match(",")) {
          if (this.peek().kind === ")") break;
          elements.push(this.parseTypeExpr());
        }
      }
      this.expect(")");
      if (elements.length === 1) return elements[0];
      return { kind: "TupleTypeExpr", elements, span: start };
    }

    // Named type `Int`, `Array<T>`, `Dict<Str, Json>`, or module-qualified `llm.AgentTool`
    if (t.kind === "Ident") {
      const id = this.next();
      let name = id.value;
      if (
        this.peekSameLine().kind === "." &&
        this.peek(1).kind === "Ident" &&
        isUpperStart(this.peek(1).value)
      ) {
        this.next(); // consume '.'
        const member = this.expect("Ident", "Expected type name after '.'");
        name = `${name}.${member.value}`;
      }
      const typeArgs: TypeExpr[] = [];
      if (this.peekSameLine().kind === "<") {
        this.next();
        while (this.peek().kind !== ">" && this.peek().kind !== ">>" && this.peek().kind !== "EOF") {
          typeArgs.push(this.parseTypeExpr());
          if (!this.match(",")) break;
        }
        this.expectCloseAngle("Expected '>' to close type arguments");
      }
      return { kind: "NamedTypeExpr", name, typeArgs, span: id.span };
    }

    throw new SplError("parse", `Expected type expression, found '${t.value || t.kind}'`, t.span);
  }

  private parseRecordType(isStructKeyword: boolean, start: Span): TypeExpr {
    this.expect("{");
    const fields: StructFieldDecl[] = [];
    let tail: RecordRowTail = { kind: "Closed" };

    while (true) {
      const lead = this.collectLeadingAnnotations();
      const t = this.peek();
      if (t.kind === "}" || t.kind === "EOF") break;

      // Row tail: `..`, `..r`, or `..extra: Dict<Str, V>`
      if (t.kind === "..") {
        this.next();
        if (this.peek().kind === "Ident") {
          const restName = this.next().value;
          if (this.match(":")) {
            const dictType = this.parseTypeExpr();
            const valType = extractDictValueType(dictType, t.span);
            const trail = this.collectTrailingAnnotations();
            tail = {
              kind: "OpenDict",
              name: restName,
              valueType: valType,
              doc: mergeDocs(lead.doc, trail.doc),
              llmHint: mergeDocs(lead.llmHint, trail.llmHint),
            };
          } else {
            tail = { kind: "OpenVar", name: restName };
          }
        } else if (this.match(":")) {
          const dictType = this.parseTypeExpr();
          const valType = extractDictValueType(dictType, t.span);
          const trail = this.collectTrailingAnnotations();
          tail = {
            kind: "OpenDict",
            valueType: valType,
            doc: mergeDocs(lead.doc, trail.doc),
            llmHint: mergeDocs(lead.llmHint, trail.llmHint),
          };
        } else {
          tail = { kind: "OpenVar" };
        }
        this.match(",");
        continue;
      }

      const fTok = this.expect("Ident", "Expected field name in record/struct type");
      this.expect(":", "Expected ':' after field name");
      const fType = this.parseTypeExpr();
      const trail = this.collectTrailingAnnotations();
      fields.push({
        name: fTok.value,
        type: fType,
        doc: mergeDocs(lead.doc, trail.doc),
        llmHint: mergeDocs(lead.llmHint, trail.llmHint),
        span: fTok.span,
      });
      this.match(",");
    }

    this.expect("}");
    return { kind: "RecordTypeExpr", isStructKeyword, fields, tail, span: start };
  }

  private parseStructFieldsOnly(): StructFieldDecl[] {
    const fields: StructFieldDecl[] = [];
    while (true) {
      const lead = this.collectLeadingAnnotations();
      if (this.peek().kind === "}" || this.peek().kind === "EOF") break;
      const fTok = this.expect("Ident", "Expected field name");
      this.expect(":");
      const fType = this.parseTypeExpr();
      const trail = this.collectTrailingAnnotations();
      fields.push({
        name: fTok.value,
        type: fType,
        doc: mergeDocs(lead.doc, trail.doc),
        llmHint: mergeDocs(lead.llmHint, trail.llmHint),
        span: fTok.span,
      });
      this.match(",");
    }
    return fields;
  }

  // ==================== Statements & Blocks ====================

  parseBlockExpr(): BlockExpr {
    const start = this.expect("{").span;
    const stmts: Stmt[] = [];
    let tailExpr: Expr | undefined;

    while (true) {
      const ann = this.collectLeadingAnnotations();
      const t = this.peek();
      if (t.kind === "}" || t.kind === "EOF") break;
      if (t.kind === ";") {
        this.next();
        continue;
      }

      if (t.kind === "let") {
        stmts.push(this.parseLetStmt(false));
        this.match(";");
        continue;
      }
      if (t.kind === "return") {
        stmts.push(this.parseReturnStmt());
        this.match(";");
        continue;
      }
      if (t.kind === "while") {
        stmts.push(this.parseWhileStmt());
        continue;
      }
      if (t.kind === "for") {
        stmts.push(this.parseForStmt());
        continue;
      }
      if (t.kind === "fn") {
        stmts.push(this.parseFnDecl(false, ann));
        continue;
      }
      if (t.kind === "type") {
        stmts.push(this.parseTypeDecl(false, ann));
        continue;
      }
      if (t.kind === "enum") {
        stmts.push(this.parseEnumDecl(false, ann));
        continue;
      }

      const expr = this.parseExpr(true);
      const assign = this.finishAssignStmt(expr);
      if (assign) {
        stmts.push(assign);
        this.match(";");
        continue;
      }
      const hadSemi = this.match(";");
      // If next significant token is `}` and no trailing semicolon, this is the tail return expression
      if (!hadSemi && this.peek().kind === "}") {
        tailExpr = expr;
        break;
      } else {
        stmts.push({ kind: "ExprStmt", expr, span: expr.span });
      }
    }

    this.expect("}");
    return { kind: "BlockExpr", stmts, tailExpr, span: start };
  }

  private parseLetStmt(pub: boolean): LetStmt {
    const start = this.expect("let").span;
    const mutable = this.match("mut");
    const pattern = this.parsePattern();
    let typeAnnotation: TypeExpr | undefined;
    if (this.match(":")) {
      typeAnnotation = this.parseTypeExpr();
    }
    this.expect("=", "Expected '=' in `let` binding");
    const value = this.parseExpr(true);
    return { kind: "LetStmt", pub, mutable, pattern, typeAnnotation, value, span: start };
  }

  private parseReturnStmt(): Stmt {
    const start = this.expect("return").span;
    let value: Expr | undefined;
    if (!this.isAtLineBreakOrEnd()) {
      value = this.parseExpr(true);
    }
    return { kind: "ReturnStmt", value, span: start };
  }

  private parseWhileStmt(): Stmt {
    const start = this.expect("while").span;
    const cond = this.parseExpr(false);
    const body = this.parseBlockExpr();
    return { kind: "WhileStmt", cond, body, span: start };
  }

  private parseForStmt(): Stmt {
    const start = this.expect("for").span;
    const pattern = this.parsePattern();
    const inTok = this.peek();
    if (inTok.kind !== "Ident" || inTok.value !== "in") {
      throw new SplError("parse", `Expected 'in' after pattern in 'for' loop, found '${inTok.value || inTok.kind}'`, inTok.span);
    }
    this.next();
    const iterable = this.parseExpr(false);
    const body = this.parseBlockExpr();
    return { kind: "ForStmt", pattern, iterable, body, span: start };
  }

  // ==================== Expressions (Table-Driven Pratt Parser) ====================
  //
  // Operator precedence from lowest (-1) to highest (13):
  //   -1 : `..`, `..=` (range, optional `..step`)
  //    0 : `||`                    (left)
  //    1 : `&&`                    (left)
  //    2 : `==`, `!=`              (left)
  //    3 : `<`, `<=`, `>`, `>=`    (left)
  //    4 : `|`                     (left)
  //    5 : `^`                     (left)
  //    6 : `&`                     (left)
  //    7 : `<<`, `>>`              (left)
  //    8 : `+`, `-`                (left, same line)
  //    9 : `*`, `/`, `%`           (left, same line)
  //   10 : `??`                    (right — binds tighter than `+`, `-`, `<=`, `==`)
  //   11 : `as Type`               (left, same line — type conversions)
  //   12 : unary `-`, `!`, `~`     (prefix)
  //   13 : `**`                    (right, same line — binds tighter than prefix `-`)
  //   14 : postfix `.`, `?.`, `[]`, `()`, `@{ ... }`, `?`

  private static readonly INFIX_PREC: Partial<
    Record<TokenKind, { prec: number; rightAssoc?: boolean; sameLineOnly?: boolean }>
  > = {
    "||": { prec: 0 },
    "&&": { prec: 1 },
    "==": { prec: 2 },
    "!=": { prec: 2 },
    "<":  { prec: 3 },
    "<=": { prec: 3 },
    ">":  { prec: 3 },
    ">=": { prec: 3 },
    "|":  { prec: 4 },
    "^":  { prec: 5 },
    "&":  { prec: 6 },
    "<<": { prec: 7 },
    ">>": { prec: 7 },
    "+":  { prec: 8, sameLineOnly: true },
    "-":  { prec: 8, sameLineOnly: true },
    "*":  { prec: 9, sameLineOnly: true },
    "/":  { prec: 9, sameLineOnly: true },
    "%":  { prec: 9, sameLineOnly: true },
    "??": { prec: 10, rightAssoc: true },
  };

  parseExpr(allowTrailingBrace: boolean): Expr {
    return this.parseRange(allowTrailingBrace);
  }

  private parseRange(allowTrailingBrace: boolean): Expr {
    const start = this.parsePrecedence(0, allowTrailingBrace);
    const tok = this.peekSameLine();
    if (tok.kind === ".." || tok.kind === "..=") {
      const inclusive = tok.kind === "..=";
      this.next();
      const end = this.parsePrecedence(0, allowTrailingBrace);
      let step: Expr | undefined;
      if (this.peekSameLine().kind === "..") {
        this.next();
        step = this.parsePrecedence(0, allowTrailingBrace);
      }
      return { kind: "RangeExpr", start, end, step, inclusive, span: tok.span };
    }
    return start;
  }

  private parsePrecedence(minPrec: number, allowTrailingBrace: boolean): Expr {
    let left = this.parseCast(allowTrailingBrace);

    while (true) {
      const tokSame = this.peekSameLine();
      const tokAny = this.peek();
      const infoSame = Parser.INFIX_PREC[tokSame.kind];
      const infoAny = Parser.INFIX_PREC[tokAny.kind];

      let info: { prec: number; rightAssoc?: boolean; sameLineOnly?: boolean } | undefined;
      let opTok: Token;
      if (infoSame) {
        info = infoSame;
        opTok = tokSame;
      } else if (infoAny && !infoAny.sameLineOnly) {
        info = infoAny;
        opTok = tokAny;
      } else {
        break;
      }

      if (info.prec < minPrec) break;

      this.next(); // consume operator
      const nextMinPrec = info.rightAssoc ? info.prec : info.prec + 1;
      const right = this.parsePrecedence(nextMinPrec, allowTrailingBrace);

      if (opTok.kind === "??") {
        left = { kind: "NullCoalesceExpr", left, right, span: opTok.span };
      } else {
        left = {
          kind: "BinaryExpr",
          op: opTok.kind as Extract<Expr, { kind: "BinaryExpr" }>["op"],
          left,
          right,
          span: opTok.span,
        };
      }
    }

    return left;
  }

  private parseCast(allowTrailingBrace: boolean): Expr {
    let expr = this.parseUnary(allowTrailingBrace);
    while (this.peekSameLine().kind === "as") {
      const op = this.next();
      const targetType = this.parseTypeExpr();
      expr = { kind: "AsExpr", expr, targetType, span: op.span };
    }
    return expr;
  }

  private parseUnary(allowTrailingBrace: boolean): Expr {
    const t = this.peek();
    if (t.kind === "-" || t.kind === "!" || t.kind === "~") {
      this.next();
      const operand = this.parseUnary(allowTrailingBrace);
      return { kind: "UnaryExpr", op: t.kind, operand, span: t.span };
    }
    return this.parsePower(allowTrailingBrace);
  }

  private parsePower(allowTrailingBrace: boolean): Expr {
    const left = this.parsePostfix(allowTrailingBrace);
    if (this.peekSameLine().kind === "**") {
      const op = this.next();
      // Right-associative; RHS allows unary `-` so `2 ** -3` works while `-2 ** 2` = `-(2 ** 2)`
      const right = this.parseUnary(allowTrailingBrace);
      return { kind: "BinaryExpr", op: "**", left, right, span: op.span };
    }
    return left;
  }

  private parsePostfix(allowTrailingBrace: boolean): Expr {
    let expr = this.parsePrimary(allowTrailingBrace);

    while (true) {
      const nextSame = this.peekSameLine();

      // Member access `.prop` (also allow multiline chained `.map(...)`)
      if (this.peek().kind === "." && (nextSame.kind === "." || nextSame.kind === "Newline")) {
        // Check if next non-newline token is `.` followed by Ident
        if (nextSame.kind === "." || (nextSame.kind === "Newline" && this.peek().kind === ".")) {
          const dot = this.next();
          const prop = this.expect("Ident", "Expected property name after '.'");
          expr = { kind: "MemberExpr", object: expr, property: prop.value, span: dot.span };
          continue;
        }
      }

      // Optional chaining `?.prop`
      if (nextSame.kind === "?.") {
        const op = this.next();
        const prop = this.expect("Ident", "Expected property name after '?.'");
        expr = { kind: "OptionalMemberExpr", object: expr, property: prop.value, span: op.span };
        continue;
      }

      // Index access `expr[idx]`
      if (nextSame.kind === "[") {
        const start = this.next().span;
        const index = this.parseExpr(true);
        this.expect("]");
        expr = { kind: "IndexExpr", object: expr, index, span: start };
        continue;
      }

      // Generic call `fn<T>(...)` / `fn<T> @{ ... }` / `type_schema<T>()` / `decode<T>(x)`
      if (nextSame.kind === "<" && this.looksLikeGenericCall()) {
        const typeArgs = this.parseCallTypeArgs();
        const args: CallArg[] =
          this.peekSameLine().kind === "("
            ? this.parseCallArgs()
            : (() => {
                const prompt = this.parsePromptExpr();
                return [{ value: prompt, span: prompt.span }];
              })();
        expr = this.buildCallOrIntrinsic(expr, typeArgs, args);
        continue;
      }

      // Regular call `expr(args...)`
      if (nextSame.kind === "(") {
        const args = this.parseCallArgs();
        expr = this.buildCallOrIntrinsic(expr, [], args);
        continue;
      }

      // Trailing prompt block `expr @{ ... }`
      if (nextSame.kind === "PromptStart") {
        const prompt = this.parsePromptExpr();
        expr = appendTrailingArg(expr, prompt);
        continue;
      }

      // Trailing lambda `list.map { i -> 2 * i }` (same line, only if allowed & `{` is a lambda)
      if (allowTrailingBrace && nextSame.kind === "{") {
        const braceKind = this.classifyBrace();
        if (braceKind === "lambda") {
          const lambda = this.parseLambdaExpr();
          expr = appendTrailingArg(expr, lambda);
          continue;
        }
        // Named struct literal `Person { firstName: "Ada", ... }`
        if (
          braceKind === "record" &&
          expr.kind === "IdentExpr" &&
          isUpperStart(expr.name)
        ) {
          expr = this.parseRecordExpr(expr.name);
          continue;
        }
      }

      // Postfix `?` error propagation
      if (nextSame.kind === "?") {
        const q = this.next();
        expr = { kind: "TryExpr", operand: expr, span: q.span };
        continue;
      }

      break;
    }

    return expr;
  }

  private expectCloseAngle(msg = "Expected '>'"): void {
    const t = this.peek();
    if (t.kind === ">") {
      this.next();
      return;
    }
    if (t.kind === ">>") {
      const tok = this.next();
      // Split `>>` into two `>` tokens by inserting the remaining `>` at the current position
      this.tokens.splice(this.pos, 0, {
        kind: ">",
        value: ">",
        span: {
          ...tok.span,
          col: tok.span.col + 1,
        },
      });
      return;
    }
    throw new SplError("parse", `${msg}, found '${t.value || t.kind}'`, t.span);
  }

  private looksLikeGenericCall(): boolean {
    const saved = this.pos;
    try {
      if (this.peekSameLine().kind !== "<") return false;
      this.next();
      let depth = 1;
      while (this.pos < this.tokens.length && depth > 0) {
        const t = this.next();
        if (t.kind === "<") depth++;
        else if (t.kind === ">") depth--;
        else if (t.kind === ">>") {
          depth -= 2;
          if (depth < 0) return false;
        } else if (t.kind === ";" || t.kind === "EOF" || t.kind === "=") return false;
      }
      if (depth !== 0) return false;
      const after = this.peekSameLine().kind;
      return after === "(" || after === "PromptStart";
    } finally {
      this.pos = saved;
    }
  }

  private parseCallTypeArgs(): TypeExpr[] {
    this.expect("<");
    const args: TypeExpr[] = [];
    while (this.peek().kind !== ">" && this.peek().kind !== ">>" && this.peek().kind !== "EOF") {
      args.push(this.parseTypeExpr());
      if (!this.match(",")) break;
    }
    this.expectCloseAngle("Expected '>' to close type arguments");
    return args;
  }

  private parseCallArgs(): CallArg[] {
    this.expect("(");
    const args: CallArg[] = [];
    while (this.peek().kind !== ")" && this.peek().kind !== "EOF") {
      // Named argument `name: expr`
      if (this.peek().kind === "Ident" && this.peek(1).kind === ":") {
        const nameTok = this.next();
        this.expect(":");
        const value = this.parseExpr(true);
        args.push({ name: nameTok.value, value, span: nameTok.span });
      } else {
        const value = this.parseExpr(true);
        args.push({ value, span: value.span });
      }
      if (!this.match(",")) break;
    }
    this.expect(")");
    return args;
  }

  private buildCallOrIntrinsic(callee: Expr, typeArgs: TypeExpr[], args: CallArg[]): Expr {
    if (callee.kind === "IdentExpr" && callee.name === "type_schema" && typeArgs.length === 1) {
      if (args.length !== 0) {
        throw new SplError("parse", "`type_schema<T>()` takes no value arguments", callee.span);
      }
      return { kind: "TypeSchemaExpr", targetType: typeArgs[0], span: callee.span };
    }
    if (callee.kind === "IdentExpr" && callee.name === "decode" && typeArgs.length === 1) {
      if (args.length !== 1 || args[0].name) {
        throw new SplError("parse", "`decode<T>(json)` expects exactly 1 positional argument", callee.span);
      }
      return { kind: "DecodeExpr", targetType: typeArgs[0], arg: args[0].value, span: callee.span };
    }
    return { kind: "CallExpr", callee, typeArgs, args, span: callee.span };
  }

  private parsePrimary(allowTrailingBrace: boolean): Expr {
    const t = this.peek();

    switch (t.kind) {
      case "Int":
        this.next();
        return { kind: "IntLitExpr", value: Number.parseInt(t.value, 10), span: t.span };

      case "Float":
        this.next();
        return { kind: "FloatLitExpr", value: Number.parseFloat(t.value), span: t.span };

      case "Str":
        this.next();
        return { kind: "StrLitExpr", value: t.value, span: t.span };

      case "StrStart":
        return this.parseStrInterpExpr();

      case "Char":
        this.next();
        return { kind: "CharLitExpr", value: t.value, span: t.span };

      case "true":
        this.next();
        return { kind: "BoolLitExpr", value: true, span: t.span };

      case "false":
        this.next();
        return { kind: "BoolLitExpr", value: false, span: t.span };

      case "PromptStart":
        return this.parsePromptExpr();

      case "Ident":
        this.next();
        return { kind: "IdentExpr", name: t.value, span: t.span };

      case "if":
        return this.parseIfExpr();

      case "match":
        return this.parseMatchExpr();

      case "return": {
        const start = this.next().span;
        let value: Expr | undefined;
        if (!this.isAtLineBreakOrEnd()) {
          value = this.parseExpr(true);
        }
        return { kind: "ReturnExpr", value, span: start };
      }

      case "[":
        return this.parseArrayExpr();

      case "(":
        return this.parseParenOrTupleExpr();

      case "{": {
        const kind = this.classifyBrace();
        if (kind === "lambda") return this.parseLambdaExpr();
        if (kind === "record") return this.parseRecordExpr(undefined);
        return this.parseBlockExpr();
      }

      default:
        throw new SplError("parse", `Unexpected token '${t.value || t.kind}' in expression`, t.span);
    }
  }

  private parseStrInterpExpr(): Expr {
    const start = this.expect("StrStart").span;
    const parts: (string | Expr)[] = [];
    while (this.pos < this.tokens.length) {
      const t = this.tokens[this.pos];
      if (t.kind === "StrEnd") {
        this.pos++;
        break;
      }
      if (t.kind === "StrText") {
        parts.push(t.value);
        this.pos++;
      } else if (t.kind === "InterpStart") {
        this.pos++;
        const expr = this.parseExpr(true);
        this.expect("InterpEnd", "Expected '}' to close string interpolation");
        parts.push(expr);
      } else {
        throw new SplError("parse", `Unexpected token '${t.kind}' inside string interpolation`, t.span);
      }
    }
    return { kind: "StrInterpExpr", parts, span: start };
  }

  private parsePromptExpr(): PromptExpr {
    const start = this.expect("PromptStart").span;
    const rawParts: (string | Expr)[] = [];
    while (this.pos < this.tokens.length) {
      const t = this.tokens[this.pos];
      if (t.kind === "PromptEnd") {
        this.pos++;
        break;
      }
      if (t.kind === "PromptText") {
        rawParts.push(t.value);
        this.pos++;
      } else if (t.kind === "InterpStart") {
        this.pos++;
        const expr = this.parseExpr(true);
        this.expect("InterpEnd", "Expected '}' to close prompt interpolation");
        rawParts.push(expr);
      } else {
        throw new SplError("parse", `Unexpected token '${t.kind}' inside prompt block`, t.span);
      }
    }
    return { kind: "PromptExpr", parts: dedentPromptParts(rawParts), span: start };
  }

  private parseIfExpr(): Expr {
    const start = this.expect("if").span;
    const cond = this.parseExpr(false);
    const thenBranch = this.parseBlockExpr();
    let elseBranch: BlockExpr | Expr | undefined;
    if (this.match("else")) {
      if (this.peek().kind === "if") {
        elseBranch = this.parseIfExpr();
      } else {
        elseBranch = this.parseBlockExpr();
      }
    }
    return {
      kind: "IfExpr",
      cond,
      thenBranch,
      elseBranch: elseBranch as BlockExpr | undefined,
      span: start,
    };
  }

  private parseMatchExpr(): Expr {
    const start = this.expect("match").span;
    const subject = this.parseExpr(false);
    this.expect("{");
    const arms: MatchArm[] = [];
    while (this.peek().kind !== "}" && this.peek().kind !== "EOF") {
      const pat = this.parsePattern();
      let guard: Expr | undefined;
      if (this.match("if")) {
        guard = this.parseExpr(false);
      }
      this.expect("=>", "Expected '=>' in match arm");
      const body = this.parseExpr(true);
      arms.push({ pattern: pat, guard, body, span: pat.span });
      this.match(",");
    }
    this.expect("}");
    return { kind: "MatchExpr", subject, arms, span: start };
  }

  private parseArrayExpr(): Expr {
    const start = this.expect("[").span;
    const elements: Expr[] = [];
    while (this.peek().kind !== "]" && this.peek().kind !== "EOF") {
      elements.push(this.parseExpr(true));
      if (!this.match(",")) break;
    }
    this.expect("]");
    return { kind: "ArrayExpr", elements, span: start };
  }

  private parseParenOrTupleExpr(): Expr {
    const start = this.expect("(").span;
    if (this.match(")")) {
      return { kind: "TupleExpr", elements: [], span: start };
    }
    const first = this.parseExpr(true);
    if (this.match(",")) {
      const elements: Expr[] = [first];
      while (this.peek().kind !== ")" && this.peek().kind !== "EOF") {
        elements.push(this.parseExpr(true));
        if (!this.match(",")) break;
      }
      this.expect(")");
      return { kind: "TupleExpr", elements, span: start };
    }
    this.expect(")");
    return first;
  }

  /** Classify `{ ... }` into `lambda`, `record`, or `block` with bounded lookahead */
  private classifyBrace(): "lambda" | "record" | "block" {
    const saved = this.pos;
    try {
      if (this.peek().kind !== "{") return "block";
      this.next(); // consume `{`

      const t0 = this.peek();
      if (t0.kind === "}") return "record"; // `{}` is empty record
      if (t0.kind === "...") return "record"; // `{ ...base, ... }`
      if (t0.kind === "->") return "lambda"; // `{ -> body }`

      // Check for lambda header: `(mut)? ident (: Type)? (, (mut)? ident (: Type)?)* ->`
      if (t0.kind === "Ident" || t0.kind === "mut") {
        const afterFirst = this.peek(1);
        if (t0.kind === "Ident" && afterFirst.kind === "->") return "lambda";
        if (t0.kind === "mut" || afterFirst.kind === "," || afterFirst.kind === ":") {
          // Scan ahead to see if a `->` appears right after a valid param list
          let i = 0;
          let okLambda = true;
          while (true) {
            if (this.peek().kind === "mut") this.next();
            const p = this.peek();
            if (p.kind !== "Ident") {
              okLambda = false;
              break;
            }
            this.next();
            if (this.peek().kind === ":") {
              this.next();
              // Skip simple type expr conservatively
              let angleDepth = 0;
              let parenDepth = 0;
              let braceDepth = 0;
              while (this.peek().kind !== "EOF") {
                const cur = this.peek().kind;
                if (
                  angleDepth === 0 &&
                  parenDepth === 0 &&
                  braceDepth === 0 &&
                  (cur === "," || cur === "->" || cur === "}")
                ) {
                  break;
                }
                if (cur === "<") angleDepth++;
                else if (cur === ">") angleDepth--;
                else if (cur === "(") parenDepth++;
                else if (cur === ")") parenDepth--;
                else if (cur === "{") braceDepth++;
                else if (cur === "}") braceDepth--;
                this.next();
              }
            }
            if (this.peek().kind === "->") {
              return "lambda";
            }
            if (this.peek().kind === ",") {
              this.next();
              i++;
              continue;
            }
            okLambda = false;
            break;
          }
          // Reset and check record `{ ident: expr }` or shorthand `{ ident, ident2 }`
          this.pos = saved;
          this.next(); // `{`
          if (!okLambda && this.peek().kind === "Ident" && (this.peek(1).kind === ":" || this.peek(1).kind === ",")) {
            return "record";
          }
        }
      }

      return "block";
    } finally {
      this.pos = saved;
    }
  }

  private parseLambdaExpr(): LambdaExpr {
    const start = this.expect("{").span;
    const params: ParamDecl[] = [];
    if (this.peek().kind !== "->") {
      while (this.peek().kind !== "->" && this.peek().kind !== "EOF") {
        const mutable = this.match("mut");
        const pTok = this.expect("Ident", "Expected lambda parameter name");
        let type: TypeExpr | undefined;
        if (this.match(":")) type = this.parseTypeExpr();
        params.push({ name: pTok.value, mutable: mutable || undefined, type, span: pTok.span });
        if (!this.match(",")) break;
      }
    }
    this.expect("->", "Expected '->' after lambda parameters");

    // Parse body statements/tail expression until `}`
    const stmts: Stmt[] = [];
    let tailExpr: Expr | undefined;
    while (true) {
      const ann = this.collectLeadingAnnotations();
      const t = this.peek();
      if (t.kind === "}" || t.kind === "EOF") break;
      if (t.kind === ";") {
        this.next();
        continue;
      }
      if (t.kind === "let") {
        stmts.push(this.parseLetStmt(false));
        this.match(";");
        continue;
      }
      if (t.kind === "return") {
        stmts.push(this.parseReturnStmt());
        this.match(";");
        continue;
      }
      if (t.kind === "while") {
        stmts.push(this.parseWhileStmt());
        continue;
      }
      if (t.kind === "for") {
        stmts.push(this.parseForStmt());
        continue;
      }
      if (t.kind === "fn") {
        stmts.push(this.parseFnDecl(false, ann));
        continue;
      }
      const expr = this.parseExpr(true);
      const assign = this.finishAssignStmt(expr);
      if (assign) {
        stmts.push(assign);
        this.match(";");
        continue;
      }
      const hadSemi = this.match(";");
      if (!hadSemi && this.peek().kind === "}") {
        tailExpr = expr;
        break;
      } else {
        stmts.push({ kind: "ExprStmt", expr, span: expr.span });
      }
    }
    this.expect("}");
    return {
      kind: "LambdaExpr",
      params,
      body: { kind: "BlockExpr", stmts, tailExpr, span: start },
      span: start,
    };
  }

  private parseRecordExpr(typeName?: string): Expr {
    const start = this.expect("{").span;
    const entries: (RecordFieldInit | RecordSpreadInit)[] = [];
    while (this.peek().kind !== "}" && this.peek().kind !== "EOF") {
      if (this.peek().kind === "...") {
        const sp = this.next().span;
        const expr = this.parseExpr(true);
        entries.push({ kind: "Spread", expr, span: sp });
      } else {
        const nameTok = this.expect("Ident", "Expected record field name");
        let value: Expr;
        if (this.match(":")) {
          value = this.parseExpr(true);
        } else {
          // Field shorthand `{ firstName, age }`
          value = { kind: "IdentExpr", name: nameTok.value, span: nameTok.span };
        }
        entries.push({ kind: "Field", name: nameTok.value, value, span: nameTok.span });
      }
      if (!this.match(",")) break;
    }
    this.expect("}");
    return { kind: "RecordExpr", typeName, entries, span: start };
  }

  // ==================== Patterns ====================

  parsePattern(): Pattern {
    const t = this.peek();

    if (t.kind === "Ident" && t.value === "_") {
      this.next();
      return { kind: "WildcardPattern", span: t.span };
    }

    if (t.kind === "Int") {
      this.next();
      return { kind: "LiteralPattern", value: Number.parseInt(t.value, 10), literalType: "Int", span: t.span };
    }
    if (t.kind === "-" && this.peek(1).kind === "Int") {
      this.next();
      const n = this.next();
      return { kind: "LiteralPattern", value: -Number.parseInt(n.value, 10), literalType: "Int", span: t.span };
    }
    if (t.kind === "Float") {
      this.next();
      return { kind: "LiteralPattern", value: Number.parseFloat(t.value), literalType: "Float", span: t.span };
    }
    if (t.kind === "Str") {
      this.next();
      return { kind: "LiteralPattern", value: t.value, literalType: "Str", span: t.span };
    }
    if (t.kind === "Char") {
      this.next();
      return { kind: "LiteralPattern", value: t.value, literalType: "Char", span: t.span };
    }
    if (t.kind === "true" || t.kind === "false") {
      this.next();
      return { kind: "LiteralPattern", value: t.kind === "true", literalType: "Bool", span: t.span };
    }

    // Tuple pattern `(a, b)`
    if (t.kind === "(") {
      const start = this.next().span;
      const elements: Pattern[] = [];
      while (this.peek().kind !== ")" && this.peek().kind !== "EOF") {
        elements.push(this.parsePattern());
        if (!this.match(",")) break;
      }
      this.expect(")");
      return { kind: "TuplePattern", elements, span: start };
    }

    // Array pattern `[a, b, ..rest]`
    if (t.kind === "[") {
      const start = this.next().span;
      const elements: Pattern[] = [];
      let rest: string | undefined;
      while (this.peek().kind !== "]" && this.peek().kind !== "EOF") {
        if (this.match("..")) {
          if (this.peek().kind === "Ident") rest = this.next().value;
          else rest = "_";
          this.match(",");
          break;
        }
        elements.push(this.parsePattern());
        if (!this.match(",")) break;
      }
      this.expect("]");
      return { kind: "ArrayPattern", elements, rest, span: start };
    }

    // Record pattern `{ kind: "call", name, args, .. }`
    if (t.kind === "{") {
      const start = this.next().span;
      const fields: RecordFieldPattern[] = [];
      let hasRest = false;
      let restName: string | undefined;
      while (this.peek().kind !== "}" && this.peek().kind !== "EOF") {
        if (this.match("..")) {
          hasRest = true;
          if (this.peek().kind === "Ident") restName = this.next().value;
          this.match(",");
          break;
        }
        const fTok = this.expect("Ident", "Expected field name in record pattern");
        let pat: Pattern;
        if (this.match(":")) {
          pat = this.parsePattern();
        } else {
          pat = { kind: "IdentPattern", name: fTok.value, span: fTok.span };
        }
        fields.push({ name: fTok.value, pattern: pat, span: fTok.span });
        if (!this.match(",")) break;
      }
      this.expect("}");
      return { kind: "RecordPattern", fields, hasRest, restName, span: start };
    }

    // Enum variant pattern (`Some(x)`, `None`, `ToolResult.Ok(v)`) or Ident binding (`x`)
    if (t.kind === "Ident") {
      const id = this.next();
      // Qualified `Enum.Variant(...)`
      if (this.peekSameLine().kind === ".") {
        this.next();
        const variant = this.expect("Ident", "Expected enum variant name after '.'").value;
        const fields = this.parseVariantPatternFields();
        return { kind: "EnumPattern", enumName: id.value, variant, fields, span: id.span };
      }
      // Unqualified `Variant(...)` or uppercase unit variant `None`
      if (this.peekSameLine().kind === "(") {
        const fields = this.parseVariantPatternFields();
        return { kind: "EnumPattern", variant: id.value, fields, span: id.span };
      }
      if (isUpperStart(id.value)) {
        return { kind: "EnumPattern", variant: id.value, fields: [], span: id.span };
      }
      return { kind: "IdentPattern", name: id.value, span: id.span };
    }

    throw new SplError("parse", `Unexpected token '${t.value || t.kind}' in pattern`, t.span);
  }

  private parseVariantPatternFields(): Pattern[] {
    const fields: Pattern[] = [];
    if (!this.match("(")) return fields;
    while (this.peek().kind !== ")" && this.peek().kind !== "EOF") {
      fields.push(this.parsePattern());
      if (!this.match(",")) break;
    }
    this.expect(")");
    return fields;
  }
}

// ==================== Helpers ====================

function mergeDocs(a?: string, b?: string): string | undefined {
  if (a && b) return `${a}\n${b}`;
  return a ?? b;
}

function isUpperStart(s: string): boolean {
  return s.length > 0 && s[0] >= "A" && s[0] <= "Z";
}

function appendTrailingArg(callee: Expr, arg: Expr): Expr {
  if (callee.kind === "CallExpr") {
    return {
      ...callee,
      args: [...callee.args, { value: arg, span: arg.span }],
    };
  }
  return {
    kind: "CallExpr",
    callee,
    typeArgs: [],
    args: [{ value: arg, span: arg.span }],
    span: callee.span,
  };
}

function extractDictValueType(t: TypeExpr, span: Span): TypeExpr {
  if (t.kind === "NamedTypeExpr" && t.name === "Dict" && t.typeArgs.length === 2) {
    return t.typeArgs[1];
  }
  throw new SplError("parse", "Open record rest field must have type `Dict<Str, V>`", span);
}

/** Auto-dedent a `@{ ... }` prompt template while preserving `${expr}` boundaries */
function dedentPromptParts(parts: (string | Expr)[]): (string | Expr)[] {
  if (parts.length === 0) return [];
  const copy = [...parts];

  // Strip a single leading newline if the prompt starts right after `@{`
  if (typeof copy[0] === "string") {
    copy[0] = copy[0].replace(/^\r?\n/, "");
  }
  // Strip trailing whitespace-only line before closing `}`
  const lastIdx = copy.length - 1;
  if (typeof copy[lastIdx] === "string") {
    copy[lastIdx] = (copy[lastIdx] as string).replace(/\r?\n[ \t]*$/, "");
  }

  // Reconstruct line starts across string segments to compute minimum indent
  let minIndent = Infinity;
  let atLineStart = true;
  for (const part of copy) {
    if (typeof part !== "string") {
      atLineStart = false;
      continue;
    }
    const lines = part.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (i > 0) atLineStart = true;
      if (atLineStart && line.trim().length > 0) {
        const match = line.match(/^[ \t]*/);
        const indent = match ? match[0].length : 0;
        if (indent < minIndent) minIndent = indent;
      }
      if (line.length > 0) atLineStart = false;
    }
  }

  if (!Number.isFinite(minIndent) || minIndent === 0) return copy;

  // Strip minIndent at every line start
  const strip = (s: string) => s.slice(Math.min(minIndent, s.match(/^[ \t]*/)?.[0].length ?? 0));
  const out: (string | Expr)[] = [];
  atLineStart = true;
  for (const part of copy) {
    if (typeof part !== "string") {
      out.push(part);
      atLineStart = false;
      continue;
    }
    const lines = part.split(/\r?\n/);
    const dedented = lines.map((line, i) => {
      if (i > 0) atLineStart = true;
      const res = atLineStart ? strip(line) : line;
      if (line.length > 0) atLineStart = false;
      return res;
    });
    out.push(dedented.join("\n"));
  }
  return out;
}
