import { Span, SplCompileError, SplDiagnostic } from "./types.js";

export type TokenKind =
  | "IDENT"
  | "INT"
  | "FLOAT"
  | "STRING"
  | "TEMPLATE_START"
  | "TEMPLATE_TEXT"
  | "TEMPLATE_EXPR_START"
  | "TEMPLATE_EXPR_END"
  | "TEMPLATE_END"
  | "PUNCT"
  | "EOF";

export interface Token {
  kind: TokenKind;
  value: string;
  intValue?: bigint;
  floatValue?: number;
  span: Span;
}

export const KEYWORDS = new Set([
  "as",
  "break",
  "case",
  "catch",
  "continue",
  "default",
  "else",
  "false",
  "fn",
  "for",
  "if",
  "in",
  "input",
  "let",
  "mut",
  "null",
  "return",
  "state",
  "switch",
  "true",
  "try",
  "type",
  "while",
]);

const MULTI_CHAR_PUNCTS = [
  ">>>",
  "?.[",
  "?.",
  "??",
  "||",
  "&&",
  "==",
  "!=",
  "<=",
  ">=",
  "<<",
  ">>",
  "->",
];

const SINGLE_CHAR_PUNCTS = new Set([
  "(",
  ")",
  "{",
  "}",
  "[",
  "]",
  "<",
  ">",
  ",",
  ":",
  ";",
  ".",
  "?",
  "=",
  "+",
  "-",
  "*",
  "/",
  "%",
  "!",
  "~",
  "&",
  "|",
  "^",
]);

interface TemplateState {
  braceDepth: number;
}

export function lex(rawSource: string): Token[] {
  const diagnostics: SplDiagnostic[] = [];
  if (rawSource.charCodeAt(0) === 0xfeff) {
    diagnostics.push({
      code: "E_LEX_BOM",
      message: "SPL source must be UTF-8 without BOM",
      span: { line: 1, col: 1, offset: 0, endOffset: 1 },
    });
    throw new SplCompileError(diagnostics);
  }

  // §3.1 Normalize CRLF and CR to LF
  const src = rawSource.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const len = src.length;
  let pos = 0;
  let line = 1;
  let col = 1;

  const tokens: Token[] = [];
  const templateStack: TemplateState[] = [];

  function advance(count = 1): void {
    for (let i = 0; i < count; i++) {
      if (src[pos] === "\n") {
        line++;
        col = 1;
      } else {
        col++;
      }
      pos++;
    }
  }

  function makeSpan(startLine: number, startCol: number, startOff: number): Span {
    return { line: startLine, col: startCol, offset: startOff, endOffset: pos };
  }

  function parseEscape(isTemplate: boolean, startLine: number, startCol: number, startOff: number): string {
    advance(); // skip '\'
    if (pos >= len) {
      diagnostics.push({
        code: "E_LEX_UNTERMINATED_STRING",
        message: "Unterminated escape sequence",
        span: makeSpan(startLine, startCol, startOff),
      });
      return "";
    }
    const ch = src[pos];
    advance();
    if (ch === "\\") return "\\";
    if (ch === "n") return "\n";
    if (ch === "r") return "\r";
    if (ch === "t") return "\t";
    if (!isTemplate && ch === '"') return '"';
    if (isTemplate && (ch === "`" || ch === "$")) return ch;
    if (ch === "u") {
      if (src[pos] !== "{") {
        diagnostics.push({
          code: "E_LEX_INVALID_ESCAPE",
          message: "Unicode escape must use \\u{HEX} syntax",
          span: makeSpan(startLine, startCol, startOff),
        });
        return "";
      }
      advance(); // '{'
      const hexStart = pos;
      while (pos < len && /[0-9a-fA-F]/.test(src[pos])) advance();
      const hex = src.slice(hexStart, pos);
      if (src[pos] !== "}" || hex.length < 1 || hex.length > 6) {
        diagnostics.push({
          code: "E_LEX_INVALID_ESCAPE",
          message: `Invalid unicode escape \\u{${hex}}`,
          span: makeSpan(startLine, startCol, startOff),
        });
        if (src[pos] === "}") advance();
        return "";
      }
      advance(); // '}'
      const cp = parseInt(hex, 16);
      if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
        diagnostics.push({
          code: "E_LEX_INVALID_UNICODE",
          message: `Invalid Unicode scalar value U+${hex.toUpperCase()}`,
          span: makeSpan(startLine, startCol, startOff),
        });
        return "";
      }
      return String.fromCodePoint(cp);
    }
    diagnostics.push({
      code: "E_LEX_INVALID_ESCAPE",
      message: `Invalid escape sequence \\${ch}`,
      span: makeSpan(startLine, startCol, startOff),
    });
    return ch;
  }

  function lexTemplateBody(): void {
    while (pos < len) {
      const startLine = line;
      const startCol = col;
      const startOff = pos;

      if (src[pos] === "`") {
        advance();
        tokens.push({
          kind: "TEMPLATE_END",
          value: "`",
          span: makeSpan(startLine, startCol, startOff),
        });
        return;
      }
      if (src[pos] === "$" && src[pos + 1] === "{") {
        advance(2);
        tokens.push({
          kind: "TEMPLATE_EXPR_START",
          value: "${",
          span: makeSpan(startLine, startCol, startOff),
        });
        templateStack.push({ braceDepth: 0 });
        return;
      }

      // Accumulate TEMPLATE_TEXT chunk
      let text = "";
      while (pos < len) {
        if (src[pos] === "`") break;
        if (src[pos] === "$" && src[pos + 1] === "{") break;
        if (src[pos] === "\\") {
          text += parseEscape(true, startLine, startCol, startOff);
        } else {
          text += src[pos];
          advance();
        }
      }
      tokens.push({
        kind: "TEMPLATE_TEXT",
        value: text,
        span: makeSpan(startLine, startCol, startOff),
      });
    }

    diagnostics.push({
      code: "E_LEX_UNTERMINATED_TEMPLATE",
      message: "Unterminated template string",
      span: { line, col, offset: pos, endOffset: pos },
    });
  }

  while (pos < len) {
    // Skip whitespace
    const ch = src[pos];
    if (ch === " " || ch === "\t" || ch === "\n") {
      advance();
      continue;
    }

    // Comments
    if (ch === "/" && src[pos + 1] === "/") {
      while (pos < len && src[pos] !== "\n") advance();
      continue;
    }
    if (ch === "/" && src[pos + 1] === "*") {
      const sLine = line;
      const sCol = col;
      const sOff = pos;
      advance(2);
      let closed = false;
      while (pos < len) {
        if (src[pos] === "*" && src[pos + 1] === "/") {
          advance(2);
          closed = true;
          break;
        }
        advance();
      }
      if (!closed) {
        diagnostics.push({
          code: "E_LEX_UNTERMINATED_COMMENT",
          message: "Unterminated block comment",
          span: makeSpan(sLine, sCol, sOff),
        });
      }
      continue;
    }

    const startLine = line;
    const startCol = col;
    const startOff = pos;

    // Template start
    if (ch === "`") {
      advance();
      tokens.push({
        kind: "TEMPLATE_START",
        value: "`",
        span: makeSpan(startLine, startCol, startOff),
      });
      lexTemplateBody();
      continue;
    }

    // Check closing brace of template interpolation
    if (ch === "}" && templateStack.length > 0) {
      const top = templateStack[templateStack.length - 1];
      if (top.braceDepth === 0) {
        advance();
        templateStack.pop();
        tokens.push({
          kind: "TEMPLATE_EXPR_END",
          value: "}",
          span: makeSpan(startLine, startCol, startOff),
        });
        lexTemplateBody();
        continue;
      } else {
        top.braceDepth--;
        advance();
        tokens.push({
          kind: "PUNCT",
          value: "}",
          span: makeSpan(startLine, startCol, startOff),
        });
        continue;
      }
    }

    if (ch === "{" && templateStack.length > 0) {
      templateStack[templateStack.length - 1].braceDepth++;
      advance();
      tokens.push({
        kind: "PUNCT",
        value: "{",
        span: makeSpan(startLine, startCol, startOff),
      });
      continue;
    }

    // String literal
    if (ch === '"') {
      advance();
      let val = "";
      let closed = false;
      while (pos < len) {
        if (src[pos] === '"') {
          advance();
          closed = true;
          break;
        }
        if (src[pos] === "\n") {
          diagnostics.push({
            code: "E_LEX_UNTERMINATED_STRING",
            message: "Unescaped newline inside string literal",
            span: makeSpan(startLine, startCol, startOff),
          });
          break;
        }
        if (src[pos] === "\\") {
          val += parseEscape(false, startLine, startCol, startOff);
        } else {
          val += src[pos];
          advance();
        }
      }
      if (!closed) {
        diagnostics.push({
          code: "E_LEX_UNTERMINATED_STRING",
          message: "Unterminated string literal",
          span: makeSpan(startLine, startCol, startOff),
        });
      }
      tokens.push({
        kind: "STRING",
        value: val,
        span: makeSpan(startLine, startCol, startOff),
      });
      continue;
    }

    // Number literal (INT or FLOAT)
    if (ch >= "0" && ch <= "9") {
      // Hex int
      if (ch === "0" && (src[pos + 1] === "x" || src[pos + 1] === "X")) {
        advance(2);
        const hexStart = pos;
        while (pos < len && /[0-9a-fA-F_]/.test(src[pos])) advance();
        const raw = src.slice(hexStart, pos).replace(/_/g, "");
        if (raw.length === 0) {
          diagnostics.push({
            code: "E_LEX_INVALID_NUMBER",
            message: "Invalid hex integer literal",
            span: makeSpan(startLine, startCol, startOff),
          });
        } else {
          tokens.push({
            kind: "INT",
            value: src.slice(startOff, pos),
            intValue: BigInt("0x" + raw),
            span: makeSpan(startLine, startCol, startOff),
          });
        }
        continue;
      }

      while (pos < len && /[0-9_]/.test(src[pos])) advance();
      let isFloat = false;
      if (src[pos] === "." && src[pos + 1] >= "0" && src[pos + 1] <= "9") {
        isFloat = true;
        advance(); // '.'
        while (pos < len && /[0-9_]/.test(src[pos])) advance();
      }
      if (src[pos] === "e" || src[pos] === "E") {
        isFloat = true;
        advance();
        if (src[pos] === "+" || src[pos] === "-") advance();
        const expStart = pos;
        while (pos < len && /[0-9]/.test(src[pos])) advance();
        if (pos === expStart) {
          diagnostics.push({
            code: "E_LEX_INVALID_NUMBER",
            message: "Invalid float exponent",
            span: makeSpan(startLine, startCol, startOff),
          });
        }
      }

      const rawText = src.slice(startOff, pos);
      const clean = rawText.replace(/_/g, "");
      if (isFloat) {
        const fv = Number(clean);
        if (!Number.isFinite(fv)) {
          diagnostics.push({
            code: "E_FLOAT_NON_FINITE",
            message: `Float literal '${rawText}' is not finite`,
            span: makeSpan(startLine, startCol, startOff),
          });
        }
        tokens.push({
          kind: "FLOAT",
          value: rawText,
          floatValue: Object.is(fv, -0) ? 0 : fv,
          span: makeSpan(startLine, startCol, startOff),
        });
      } else {
        tokens.push({
          kind: "INT",
          value: rawText,
          intValue: BigInt(clean),
          span: makeSpan(startLine, startCol, startOff),
        });
      }
      continue;
    }

    // Identifier / Keyword
    if ((ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_") {
      while (pos < len && /[A-Za-z0-9_]/.test(src[pos])) advance();
      const ident = src.slice(startOff, pos);
      tokens.push({
        kind: "IDENT",
        value: ident,
        span: makeSpan(startLine, startCol, startOff),
      });
      continue;
    }

    // Multi-char punctuators
    let matchedPunct: string | null = null;
    for (const p of MULTI_CHAR_PUNCTS) {
      if (src.startsWith(p, pos)) {
        matchedPunct = p;
        break;
      }
    }
    if (matchedPunct) {
      advance(matchedPunct.length);
      tokens.push({
        kind: "PUNCT",
        value: matchedPunct,
        span: makeSpan(startLine, startCol, startOff),
      });
      continue;
    }

    if (SINGLE_CHAR_PUNCTS.has(ch)) {
      advance();
      tokens.push({
        kind: "PUNCT",
        value: ch,
        span: makeSpan(startLine, startCol, startOff),
      });
      continue;
    }

    diagnostics.push({
      code: "E_LEX_INVALID_CHAR",
      message: `Unexpected character '${ch}'`,
      span: makeSpan(startLine, startCol, startOff),
    });
    advance();
  }

  tokens.push({
    kind: "EOF",
    value: "",
    span: { line, col, offset: pos, endOffset: pos },
  });

  if (diagnostics.length > 0) {
    throw new SplCompileError(diagnostics);
  }
  return tokens;
}
