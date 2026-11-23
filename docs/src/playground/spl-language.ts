import { StreamLanguage, HighlightStyle, syntaxHighlighting, type StreamParser } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import type { Extension } from "@codemirror/state";

interface SplStreamState {
  blockCommentDepth: number;
  promptBraceDepth: number;
  inPrompt: boolean;
}

const KEYWORDS = new Set([
  "let",
  "mut",
  "fn",
  "reified",
  "type",
  "newtype",
  "typeof",
  "struct",
  "enum",
  "trait",
  "impl",
  "for",
  "in",
  "match",
  "if",
  "else",
  "while",
  "return",
  "pub",
  "import",
  "from",
  "as",
  "extern",
  "and",
  "or",
  "not",
]);

const ATOMS = new Set(["true", "false", "Some", "None", "Ok", "Err"]);

const TYPES = new Set([
  "Int",
  "Float",
  "Str",
  "Bool",
  "Char",
  "Byte",
  "Bytes",
  "Json",
  "Prompt",
  "Array",
  "Iter",
  "Dict",
  "Option",
  "Result",
  "Unit",
  "Never",
  "TypeInfo",
  "TypeFieldInfo",
  "TypeVariantInfo",
  "HashMap",
  "TreeSet",
  "List",
]);

const BUILTINS = new Set([
  "print",
  "print_inline",
  "to_str",
  "panic",
  "type_schema",
  "decode",
  "json_parse",
  "json_stringify",
  "to_json",
  "async_all",
  "async_race",
  "array_fold",
  "array_from_fn",
  "dict_empty",
  "iter_from_fn",
]);

const splStreamParser: StreamParser<SplStreamState> = {
  startState: () => ({
    blockCommentDepth: 0,
    promptBraceDepth: 0,
    inPrompt: false,
  }),

  token(stream, state) {
    // Inside /* ... */ block comment
    if (state.blockCommentDepth > 0) {
      while (!stream.eol()) {
        if (stream.match("/*")) {
          state.blockCommentDepth++;
        } else if (stream.match("*/")) {
          state.blockCommentDepth--;
          if (state.blockCommentDepth === 0) break;
        } else {
          stream.next();
        }
      }
      return "blockComment";
    }

    // Inside @{ ... } first-class prompt block
    if (state.inPrompt) {
      if (stream.match("${")) {
        // Highlight interpolation delimiter
        return "punctuation";
      }
      const ch = stream.next();
      if (ch === "{") {
        state.promptBraceDepth++;
        return "string.special";
      }
      if (ch === "}") {
        state.promptBraceDepth--;
        if (state.promptBraceDepth <= 0) {
          state.inPrompt = false;
          state.promptBraceDepth = 0;
          return "punctuation";
        }
        return "string.special";
      }
      while (!stream.eol()) {
        if (stream.peek() === "{" || stream.peek() === "}" || stream.match("${", false)) {
          break;
        }
        stream.next();
      }
      return "string.special";
    }

    if (stream.eatSpace()) return null;

    // Prompt block start: @{
    if (stream.match("@{")) {
      state.inPrompt = true;
      state.promptBraceDepth = 1;
      return "punctuation";
    }

    // LLM hint comment: '' ...
    if (stream.match("''")) {
      stream.skipToEnd();
      return "docComment";
    }

    // Doc comment /// or line comment //
    if (stream.match("///")) {
      stream.skipToEnd();
      return "docComment";
    }
    if (stream.match("//")) {
      stream.skipToEnd();
      return "lineComment";
    }

    // Block comment /*
    if (stream.match("/*")) {
      state.blockCommentDepth = 1;
      return "blockComment";
    }

    // Double-quoted string
    if (stream.eat('"')) {
      let escaped = false;
      while (!stream.eol()) {
        const ch = stream.next();
        if (escaped) {
          escaped = false;
        } else if (ch === "\\") {
          escaped = true;
        } else if (ch === '"') {
          break;
        }
      }
      return "string";
    }

    // Single-quoted char literal: 'a' or '\n'
    if (stream.match(/^'(?:\\.|[^'\\])'/)) {
      return "character";
    }

    // Numbers (hex, binary, float, int with underscores)
    if (stream.match(/^0[xX][0-9a-fA-F_]+/) || stream.match(/^0[bB][01_]+/) || stream.match(/^\d[\d_]*(?:\.\d[\d_]*)?/)) {
      return "number";
    }

    // Multi-char operators
    if (stream.match(/^(?:->|=>|\?\?|\?\.|\.\.=|\.\.|\*\*|==|!=|<=|>=|<<|>>|&&|\|\|)/)) {
      return "operator";
    }

    // Identifiers, keywords, types
    if (stream.match(/^[A-Za-z_][A-Za-z0-9_]*/)) {
      const word = stream.current();
      if (KEYWORDS.has(word)) return "keyword";
      if (ATOMS.has(word)) return "atom";
      if (TYPES.has(word)) return "typeName";
      if (BUILTINS.has(word)) return "standard";
      if (/^[A-Z]/.test(word)) return "typeName";
      if (stream.peek() === "(") return "function";
      return "variableName";
    }

    // Punctuation & single-char operators
    if (stream.match(/^[{}()[\],.;:]/)) return "punctuation";
    if (stream.match(/^[+\-*/%<>=!?|&^~]/)) return "operator";

    stream.next();
    return null;
  },
};

export const splLanguage = StreamLanguage.define(splStreamParser);

const darkHighlight = HighlightStyle.define([
  { tag: tags.keyword, color: "#ef4444", fontWeight: "600" },
  { tag: tags.typeName, color: "#e5e5e5", fontWeight: "600" },
  { tag: tags.atom, color: "#f87171" },
  { tag: tags.standard(tags.variableName), color: "#ffffff", fontWeight: "600" },
  { tag: tags.function(tags.variableName), color: "#f5f5f5" },
  { tag: tags.variableName, color: "#d4d4d4" },
  { tag: tags.string, color: "#a3e635" },
  { tag: tags.special(tags.string), color: "#fbbf24" },
  { tag: tags.character, color: "#a3e635" },
  { tag: tags.number, color: "#fb923c" },
  { tag: tags.lineComment, color: "#737373", fontStyle: "italic" },
  { tag: tags.blockComment, color: "#737373", fontStyle: "italic" },
  { tag: tags.docComment, color: "#fca5a5", fontStyle: "italic" },
  { tag: tags.operator, color: "#ef4444" },
  { tag: tags.punctuation, color: "#a3a3a3" },
]);

const lightHighlight = HighlightStyle.define([
  { tag: tags.keyword, color: "#b91c1c", fontWeight: "600" },
  { tag: tags.typeName, color: "#171717", fontWeight: "600" },
  { tag: tags.atom, color: "#991b1b" },
  { tag: tags.standard(tags.variableName), color: "#0a0a0a", fontWeight: "600" },
  { tag: tags.function(tags.variableName), color: "#262626" },
  { tag: tags.variableName, color: "#262626" },
  { tag: tags.string, color: "#15803d" },
  { tag: tags.special(tags.string), color: "#92400e" },
  { tag: tags.character, color: "#15803d" },
  { tag: tags.number, color: "#c2410c" },
  { tag: tags.lineComment, color: "#737373", fontStyle: "italic" },
  { tag: tags.blockComment, color: "#737373", fontStyle: "italic" },
  { tag: tags.docComment, color: "#991b1b", fontStyle: "italic" },
  { tag: tags.operator, color: "#b91c1c" },
  { tag: tags.punctuation, color: "#525252" },
]);

export function createSplEditorTheme(isLight: boolean): Extension[] {
  const baseTheme = EditorView.theme(
    {
      "&": {
        backgroundColor: "var(--spl-code-bg)",
        color: "var(--sl-color-gray-1)",
        fontFamily: "var(--sl-font-mono)",
        fontSize: "0.875rem",
        height: "100%",
      },
      ".cm-scroller": {
        fontFamily: "var(--sl-font-mono)",
        lineHeight: "1.6",
        overflow: "auto",
      },
      ".cm-content": {
        paddingBlock: "0.85rem",
        caretColor: "var(--sl-color-accent)",
      },
      ".cm-cursor, .cm-dropCursor": {
        borderLeftColor: "var(--sl-color-accent)",
        borderLeftWidth: "2px",
      },
      "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
        backgroundColor: isLight ? "rgb(200 30 30 / 0.16)" : "rgb(220 38 38 / 0.28)",
      },
      ".cm-activeLine": {
        backgroundColor: isLight ? "rgb(0 0 0 / 0.035)" : "rgb(255 255 255 / 0.04)",
      },
      ".cm-gutters": {
        backgroundColor: "var(--spl-code-gutter-bg)",
        color: "var(--spl-code-gutter-fg)",
        borderRight: "1px solid var(--spl-code-gutter-border)",
        fontVariantNumeric: "tabular-nums",
      },
      ".cm-activeLineGutter": {
        backgroundColor: isLight ? "rgb(0 0 0 / 0.06)" : "rgb(255 255 255 / 0.06)",
        color: "var(--sl-color-white)",
      },
      ".cm-lineNumbers .cm-gutterElement": {
        paddingInline: "0.75rem 0.65rem",
        minWidth: "3.2ch",
      },
      ".cm-tooltip": {
        backgroundColor: "var(--spl-surface)",
        border: "1px solid var(--spl-border)",
        borderRadius: "0.25rem",
        color: "var(--sl-color-gray-1)",
        boxShadow: "var(--spl-editor-shadow)",
        fontFamily: "var(--sl-font-mono)",
        fontSize: "0.8rem",
      },
      ".cm-tooltip.cm-tooltip-autocomplete": {
        borderColor: "var(--spl-border-strong)",
      },
      ".cm-tooltip-autocomplete > ul": {
        fontFamily: "var(--sl-font-mono)",
        maxHeight: "16rem",
      },
      ".cm-tooltip-autocomplete > ul > li": {
        display: "flex",
        alignItems: "center",
        gap: "0.55rem",
        padding: "0.3rem 0.65rem",
        lineHeight: "1.4",
      },
      ".cm-tooltip-autocomplete > ul > li[aria-selected]": {
        backgroundColor: "var(--sl-color-accent)",
        color: "#ffffff",
      },
      ".cm-tooltip-autocomplete > ul > li[aria-selected] .spl-cm-kind": {
        backgroundColor: "rgb(0 0 0 / 0.25)",
        borderColor: "rgb(255 255 255 / 0.4)",
        color: "#ffffff",
      },
      ".cm-tooltip-autocomplete > ul > li[aria-selected] .cm-completionDetail": {
        color: "rgb(255 255 255 / 0.88)",
      },
      ".cm-completionLabel": {
        fontWeight: "600",
      },
      ".cm-completionDetail": {
        marginInlineStart: "auto",
        paddingInlineStart: "0.75rem",
        fontStyle: "normal",
        fontSize: "0.74rem",
        color: "var(--sl-color-gray-3)",
      },
      ".cm-completionInfo": {
        padding: "0.65rem 0.85rem",
        maxWidth: "24rem",
        lineHeight: "1.5",
        borderLeft: "1px solid var(--spl-border)",
        whiteSpace: "pre-wrap",
      },
      ".cm-diagnostic-error": {
        borderLeft: "3px solid var(--sl-color-accent)",
        paddingInlineStart: "0.55rem",
      },
      ".cm-lintRange-error": {
        backgroundImage: "none",
        textDecoration: "wavy underline var(--sl-color-accent)",
        textUnderlineOffset: "3px",
      },
    },
    { dark: !isLight }
  );

  return [baseTheme, syntaxHighlighting(isLight ? lightHighlight : darkHighlight)];
}
