import { SplError, type Span } from "./errors.js";

export type TokenKind =
  | "Int"
  | "Float"
  | "Str"
  | "StrStart"
  | "StrText"
  | "StrEnd"
  | "Char"
  | "PromptStart"
  | "PromptText"
  | "PromptEnd"
  | "InterpStart"
  | "InterpEnd"
  | "Ident"
  | "Comment"
  | "DocComment"
  | "LlmHint"
  // Keywords
  | "let" | "mut" | "fn" | "type" | "newtype" | "typeof" | "struct" | "enum"
  | "trait" | "impl" | "for" | "match" | "if" | "else"
  | "while" | "return" | "pub" | "import" | "from" | "as"
  | "extern" | "true" | "false"
  // Punctuation / Operators
  | "(" | ")" | "[" | "]" | "{" | "}"
  | "," | ":" | ";" | "." | ".." | "..=" | "..."
  | "->" | "=>" | "?." | "??" | "?"
  | "+" | "-" | "*" | "/" | "%" | "**"
  | "==" | "!=" | "<" | "<=" | ">" | ">="
  | "&&" | "||" | "!" | "&" | "|" | "^" | "<<" | ">>" | "~"
  | "="
  | "Newline"
  | "EOF";

export interface Token {
  kind: TokenKind;
  value: string;
  span: Span;
  trailing?: boolean; // for comments: true if preceded by non-whitespace on same line
}

const KEYWORDS = new Set<TokenKind>([
  "let", "mut", "fn", "type", "newtype", "typeof", "struct", "enum",
  "trait", "impl", "for", "match", "if", "else",
  "while", "return", "pub", "import", "from", "as",
  "extern", "true", "false",
]);

type LexMode =
  | { kind: "code"; braceDepth: number; returnTo?: "prompt" | "str" }
  | { kind: "prompt"; braceDepth: number }
  | { kind: "str" };

export function lex(source: string, file = "<input>"): Token[] {
  const tokens: Token[] = [];
  let pos = 0;
  let line = 1;
  let col = 1;
  let lineHasCode = false;
  const modes: LexMode[] = [{ kind: "code", braceDepth: 0 }];

  const peek = (offset = 0): string => source[pos + offset] ?? "";
  const advance = (): string => {
    const ch = source[pos++] ?? "";
    if (ch === "\n") {
      line++;
      col = 1;
      lineHasCode = false;
    } else {
      col++;
    }
    return ch;
  };
  const makeSpan = (startLine: number, startCol: number): Span => ({
    file,
    line: startLine,
    col: startCol,
    endLine: line,
    endCol: col,
  });

  while (pos < source.length) {
    const mode = modes[modes.length - 1];

    // -------------------- PROMPT MODE (@{ ... }) --------------------
    if (mode.kind === "prompt") {
      const startLine = line;
      const startCol = col;
      let buf = "";

      const flushBuf = () => {
        if (buf.length > 0) {
          tokens.push({
            kind: "PromptText",
            value: buf,
            span: makeSpan(startLine, startCol),
          });
          buf = "";
        }
      };

      while (pos < source.length) {
        const ch = peek();
        if (ch === "\\" && (peek(1) === "$" || peek(1) === "{" || peek(1) === "}" || peek(1) === "\\")) {
          advance();
          buf += advance();
          continue;
        }
        if (ch === "$" && peek(1) === "{") {
          flushBuf();
          const sL = line;
          const sC = col;
          advance();
          advance();
          tokens.push({ kind: "InterpStart", value: "${", span: makeSpan(sL, sC) });
          modes.push({ kind: "code", braceDepth: 0, returnTo: "prompt" });
          break;
        }
        if (ch === "{") {
          mode.braceDepth++;
          buf += advance();
          continue;
        }
        if (ch === "}") {
          if (mode.braceDepth === 0) {
            flushBuf();
            const sL = line;
            const sC = col;
            advance();
            tokens.push({ kind: "PromptEnd", value: "}", span: makeSpan(sL, sC) });
            modes.pop();
            lineHasCode = true;
            break;
          } else {
            mode.braceDepth--;
            buf += advance();
            continue;
          }
        }
        buf += advance();
      }
      if (pos >= source.length && modes[modes.length - 1] === mode) {
        throw new SplError("lex", "Unterminated prompt block `@{ ... }`", makeSpan(startLine, startCol));
      }
      continue;
    }

    // -------------------- INTERPOLATED STRING MODE --------------------
    if (mode.kind === "str") {
      const startLine = line;
      const startCol = col;
      let buf = "";

      const flushBuf = () => {
        if (buf.length > 0) {
          tokens.push({ kind: "StrText", value: buf, span: makeSpan(startLine, startCol) });
          buf = "";
        }
      };

      while (pos < source.length) {
        const ch = peek();
        if (ch === "\"") {
          flushBuf();
          const sL = line;
          const sC = col;
          advance();
          tokens.push({ kind: "StrEnd", value: "\"", span: makeSpan(sL, sC) });
          modes.pop();
          lineHasCode = true;
          break;
        }
        if (ch === "\\" ) {
          buf += readEscape(advance, peek, file, line, col);
          continue;
        }
        if (ch === "$" && peek(1) === "{") {
          flushBuf();
          const sL = line;
          const sC = col;
          advance();
          advance();
          tokens.push({ kind: "InterpStart", value: "${", span: makeSpan(sL, sC) });
          modes.push({ kind: "code", braceDepth: 0, returnTo: "str" });
          break;
        }
        buf += advance();
      }
      if (pos >= source.length && modes[modes.length - 1] === mode) {
        throw new SplError("lex", "Unterminated string literal", makeSpan(startLine, startCol));
      }
      continue;
    }

    // -------------------- CODE MODE --------------------
    const ch = peek();

    // Whitespace
    if (ch === " " || ch === "\t" || ch === "\r") {
      advance();
      continue;
    }

    if (ch === "\n") {
      const sL = line;
      const sC = col;
      advance();
      tokens.push({ kind: "Newline", value: "\n", span: makeSpan(sL, sC) });
      continue;
    }

    // Comments: `///` doc-comment or `//` regular comment
    if (ch === "/" && peek(1) === "/") {
      const sL = line;
      const sC = col;
      const trailing = lineHasCode;
      advance();
      advance();
      const isDoc = peek() === "/";
      if (isDoc) advance();
      let text = "";
      while (pos < source.length && peek() !== "\n") {
        text += advance();
      }
      if (text.startsWith(" ")) text = text.slice(1);
      tokens.push({
        kind: isDoc ? "DocComment" : "Comment",
        value: text.trimEnd(),
        span: makeSpan(sL, sC),
        trailing,
      });
      continue;
    }

    // LLM hint comment `'' ...` (must be checked before single-quoted `Char` literal `'a'`)
    if (ch === "'" && peek(1) === "'") {
      const sL = line;
      const sC = col;
      const trailing = lineHasCode;
      advance();
      advance();
      let text = "";
      while (pos < source.length && peek() !== "\n") {
        text += advance();
      }
      if (text.startsWith(" ")) text = text.slice(1);
      tokens.push({
        kind: "LlmHint",
        value: text.trimEnd(),
        span: makeSpan(sL, sC),
        trailing,
      });
      continue;
    }

    // Prompt block start `@{`
    if (ch === "@" && peek(1) === "{") {
      const sL = line;
      const sC = col;
      advance();
      advance();
      lineHasCode = true;
      tokens.push({ kind: "PromptStart", value: "@{", span: makeSpan(sL, sC) });
      modes.push({ kind: "prompt", braceDepth: 0 });
      continue;
    }

    // String literal `"..."` (plain or interpolated)
    if (ch === "\"") {
      const sL = line;
      const sC = col;
      // Look ahead to see if this string has unescaped `${`
      if (hasInterpolationAhead(source, pos + 1)) {
        advance();
        lineHasCode = true;
        tokens.push({ kind: "StrStart", value: "\"", span: makeSpan(sL, sC) });
        modes.push({ kind: "str" });
      } else {
        advance();
        let val = "";
        while (pos < source.length && peek() !== "\"") {
          if (peek() === "\\") {
            val += readEscape(advance, peek, file, line, col);
          } else {
            val += advance();
          }
        }
        if (peek() !== "\"") {
          throw new SplError("lex", "Unterminated string literal", makeSpan(sL, sC));
        }
        advance();
        lineHasCode = true;
        tokens.push({ kind: "Str", value: val, span: makeSpan(sL, sC) });
      }
      continue;
    }

    // Char literal `'a'`
    if (ch === "'") {
      const sL = line;
      const sC = col;
      advance();
      let val = "";
      if (peek() === "\\") {
        val = readEscape(advance, peek, file, line, col);
      } else if (pos < source.length && peek() !== "'") {
        val = advance();
      } else {
        throw new SplError("lex", "Empty character literal", makeSpan(sL, sC));
      }
      if (peek() !== "'") {
        throw new SplError("lex", "Unterminated or multi-character `Char` literal (use `\"...\"` for `Str`)", makeSpan(sL, sC));
      }
      advance();
      lineHasCode = true;
      tokens.push({ kind: "Char", value: val, span: makeSpan(sL, sC) });
      continue;
    }

    // Numbers (Int or Float)
    if (isDigit(ch)) {
      const sL = line;
      const sC = col;
      let raw = "";
      let isFloat = false;
      while (isDigit(peek()) || peek() === "_") {
        const c = advance();
        if (c !== "_") raw += c;
      }
      if (peek() === "." && isDigit(peek(1))) {
        isFloat = true;
        raw += advance();
        while (isDigit(peek()) || peek() === "_") {
          const c = advance();
          if (c !== "_") raw += c;
        }
      }
      if (peek() === "e" || peek() === "E") {
        isFloat = true;
        raw += advance();
        if (peek() === "+" || peek() === "-") raw += advance();
        while (isDigit(peek())) raw += advance();
      }
      lineHasCode = true;
      tokens.push({
        kind: isFloat ? "Float" : "Int",
        value: raw,
        span: makeSpan(sL, sC),
      });
      continue;
    }

    // Identifiers and keywords
    if (isIdentStart(ch)) {
      const sL = line;
      const sC = col;
      let ident = "";
      while (isIdentPart(peek())) {
        ident += advance();
      }
      lineHasCode = true;
      const kind: TokenKind = KEYWORDS.has(ident as TokenKind) ? (ident as TokenKind) : "Ident";
      tokens.push({ kind, value: ident, span: makeSpan(sL, sC) });
      continue;
    }

    // Braces in code mode (track interpolation return!)
    if (ch === "{") {
      const sL = line;
      const sC = col;
      advance();
      mode.braceDepth++;
      lineHasCode = true;
      tokens.push({ kind: "{", value: "{", span: makeSpan(sL, sC) });
      continue;
    }
    if (ch === "}") {
      const sL = line;
      const sC = col;
      advance();
      if (mode.returnTo && mode.braceDepth === 0) {
        tokens.push({ kind: "InterpEnd", value: "}", span: makeSpan(sL, sC) });
        modes.pop();
      } else {
        if (mode.braceDepth > 0) mode.braceDepth--;
        lineHasCode = true;
        tokens.push({ kind: "}", value: "}", span: makeSpan(sL, sC) });
      }
      continue;
    }

    // Multi-char operators
    const sL = line;
    const sC = col;
    const three = source.slice(pos, pos + 3);
    if (three === "..." || three === "..=") {
      advance(); advance(); advance();
      lineHasCode = true;
      tokens.push({ kind: three as TokenKind, value: three, span: makeSpan(sL, sC) });
      continue;
    }

    const two = source.slice(pos, pos + 2);
    const twoOps: TokenKind[] = [
      "->", "=>", "..", "?.", "??", "**", "==", "!=", "<=", ">=", "&&", "||", "<<", ">>",
    ];
    if (twoOps.includes(two as TokenKind)) {
      advance(); advance();
      lineHasCode = true;
      tokens.push({ kind: two as TokenKind, value: two, span: makeSpan(sL, sC) });
      continue;
    }

    const oneOps: TokenKind[] = [
      "(", ")", "[", "]", ",", ":", ";", ".", "?",
      "+", "-", "*", "/", "%", "<", ">", "!", "&", "|", "^", "~", "=",
    ];
    if (oneOps.includes(ch as TokenKind)) {
      advance();
      lineHasCode = true;
      tokens.push({ kind: ch as TokenKind, value: ch, span: makeSpan(sL, sC) });
      continue;
    }

    throw new SplError("lex", `Unexpected character '${ch}'`, makeSpan(sL, sC));
  }

  tokens.push({ kind: "EOF", value: "", span: { file, line, col } });
  return tokens;
}

function hasInterpolationAhead(source: string, start: number): boolean {
  let i = start;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "\"") return false;
    if (ch === "$" && source[i + 1] === "{") return true;
    i++;
  }
  return false;
}

function readEscape(
  advance: () => string,
  peek: (offset?: number) => string,
  file: string,
  line: number,
  col: number
): string {
  advance(); // consume '\'
  const esc = advance();
  switch (esc) {
    case "n": return "\n";
    case "r": return "\r";
    case "t": return "\t";
    case "\\": return "\\";
    case "\"": return "\"";
    case "'": return "'";
    case "$": return "$";
    case "0": return "\0";
    default:
      throw new SplError("lex", `Unknown escape sequence '\\${esc}'`, { file, line, col });
  }
}

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

function isIdentStart(ch: string): boolean {
  return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_";
}

function isIdentPart(ch: string): boolean {
  return isIdentStart(ch) || isDigit(ch);
}
