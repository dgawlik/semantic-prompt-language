"use client";

import React, { useState } from "react";
import { Check, Copy } from "lucide-react";

type Language = "spl" | "splb" | "bash" | "json" | "text";

interface Token {
  text: string;
  className?: string;
}

const SPL_KEYWORDS = new Set([
  "type",
  "input",
  "state",
  "fn",
  "let",
  "mut",
  "if",
  "else",
  "switch",
  "case",
  "default",
  "while",
  "for",
  "in",
  "break",
  "continue",
  "return",
  "try",
  "catch",
  "as",
]);

const SPL_TYPES = new Set(["bool", "int", "float", "string", "json", "void", "Error", "list", "map"]);
const SPL_CONSTANTS = new Set(["true", "false", "null"]);
const SPL_EFFECT_NS = new Set(["model", "web", "fs", "shell", "tool", "mcp"]);
const SPL_BUILTINS = new Set(["str", "list", "map", "math", "json", "len"]);

function tokenizeSplLine(line: string): Token[] {
  const tokens: Token[] = [];
  const regex =
    /(\/\/.*$|`(?:\\.|[^`])*`|"(?:\\.|[^"\\])*"|\b(?:model|web|fs|shell|tool|mcp)\.[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?|\b(?:str|list|map|math|json)\.[A-Za-z_][A-Za-z0-9_]*|\b0[xX][0-9a-fA-F_]+\b|\b\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?\b|\b[A-Za-z_][A-Za-z0-9_]*\b|\?\?|\?\.\[|\?\.|->|>>>|<<|>>|==|!=|<=|>=|&&|\|\|)/g;

  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(line)) !== null) {
    if (m.index > last) {
      tokens.push({ text: line.slice(last, m.index), className: "text-zinc-300" });
    }
    const word = m[0];
    if (word.startsWith("//")) {
      tokens.push({ text: word, className: "text-zinc-500 italic" });
    } else if (word.startsWith('"') || word.startsWith("`")) {
      tokens.push({ text: word, className: "text-emerald-300" });
    } else if (word.includes(".") && SPL_EFFECT_NS.has(word.split(".")[0])) {
      tokens.push({ text: word, className: "text-cyan-300 font-medium" });
    } else if (word.includes(".") && SPL_BUILTINS.has(word.split(".")[0])) {
      tokens.push({ text: word, className: "text-sky-300" });
    } else if (SPL_KEYWORDS.has(word)) {
      tokens.push({ text: word, className: "text-violet-400 font-medium" });
    } else if (SPL_TYPES.has(word)) {
      tokens.push({ text: word, className: "text-amber-300" });
    } else if (SPL_CONSTANTS.has(word)) {
      tokens.push({ text: word, className: "text-orange-300" });
    } else if (/^[0-9]/.test(word)) {
      tokens.push({ text: word, className: "text-amber-200" });
    } else if (/^[A-Z][A-Za-z0-9_]*$/.test(word)) {
      tokens.push({ text: word, className: "text-amber-200" });
    } else if (word === "??" || word === "?." || word === "?.[" || word === "->") {
      tokens.push({ text: word, className: "text-fuchsia-300" });
    } else {
      tokens.push({ text: word, className: "text-zinc-100" });
    }
    last = regex.lastIndex;
  }
  if (last < line.length) {
    tokens.push({ text: line.slice(last), className: "text-zinc-300" });
  }
  return tokens;
}

function tokenizeSplbLine(line: string): Token[] {
  const tokens: Token[] = [];
  const dirMatch = /^(SPLB|CATALOG|CAPS|INPUTS|STATE|CONSTS|SCHEMAS|FN|END)(\b.*)$/.exec(line);
  if (dirMatch) {
    tokens.push({ text: dirMatch[1], className: "text-violet-400 font-semibold" });
    if (dirMatch[2]) tokens.push({ text: dirMatch[2], className: "text-zinc-300" });
    return tokens;
  }

  const insMatch = /^(\s*)(\d{4,}:)(\s+)([A-Z0-9_]+)(.*)$/.exec(line);
  if (insMatch) {
    tokens.push({ text: insMatch[1] });
    tokens.push({ text: insMatch[2], className: "text-zinc-500" });
    tokens.push({ text: insMatch[3] });
    const op = insMatch[4];
    const opClass = op.startsWith("EFF_")
      ? "text-cyan-300 font-semibold"
      : op.startsWith("JMP") || op.startsWith("CALL") || op === "RET" || op.startsWith("TRY_")
        ? "text-violet-300 font-medium"
        : "text-sky-200";
    tokens.push({ text: op, className: opClass });
    if (insMatch[5]) {
      tokens.push({ text: insMatch[5], className: "text-amber-200" });
    }
    return tokens;
  }

  const poolMatch = /^(\s*)(c\d+|s\d+)(\s+)([IFSJ]\s+)?(.*)$/.exec(line);
  if (poolMatch) {
    tokens.push({ text: poolMatch[1] });
    tokens.push({
      text: poolMatch[2],
      className: poolMatch[2].startsWith("c") ? "text-amber-300 font-medium" : "text-fuchsia-300 font-medium",
    });
    tokens.push({ text: poolMatch[3] });
    if (poolMatch[4]) tokens.push({ text: poolMatch[4], className: "text-violet-300 font-semibold" });
    tokens.push({ text: poolMatch[5], className: "text-emerald-300" });
    return tokens;
  }

  return [{ text: line, className: "text-zinc-200" }];
}

function tokenizeLine(line: string, lang: Language): Token[] {
  if (lang === "spl") return tokenizeSplLine(line);
  if (lang === "splb") return tokenizeSplbLine(line);
  if (lang === "bash") {
    if (line.trimStart().startsWith("#")) return [{ text: line, className: "text-zinc-500 italic" }];
    return [{ text: line, className: "text-cyan-100" }];
  }
  if (lang === "json") {
    const out: Token[] = [];
    const rx = /("(?:\\.|[^"\\])*"(?=\s*:)|"(?:\\.|[^"\\])*"|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = rx.exec(line)) !== null) {
      if (m.index > last) out.push({ text: line.slice(last, m.index), className: "text-zinc-400" });
      const w = m[0];
      const nextChar = line[rx.lastIndex];
      if (w.startsWith('"') && nextChar === ":") out.push({ text: w, className: "text-sky-300" });
      else if (w.startsWith('"')) out.push({ text: w, className: "text-emerald-300" });
      else if (/^[tfn]/.test(w)) out.push({ text: w, className: "text-violet-400" });
      else out.push({ text: w, className: "text-amber-200" });
      last = rx.lastIndex;
    }
    if (last < line.length) out.push({ text: line.slice(last), className: "text-zinc-400" });
    return out;
  }
  return [{ text: line, className: "text-zinc-200" }];
}

export function CodeBlock({
  code,
  language = "spl",
  title,
  maxHeight,
  showLineNumbers = false,
}: {
  code: string;
  language?: Language;
  title?: string;
  maxHeight?: string;
  showLineNumbers?: boolean;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // ignore clipboard denial
    }
  };

  const lines = code.replace(/\r\n/g, "\n").split("\n");

  return (
    <div className="group relative overflow-hidden rounded-xl border border-white/10 bg-zinc-950/95 shadow-xl shadow-black/40">
      {title && (
        <div className="flex items-center justify-between border-b border-white/[0.07] bg-white/[0.02] px-4 py-2">
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-cyan-400/70" />
            <span className="font-mono text-xs text-zinc-400">{title}</span>
          </div>
          <button
            type="button"
            onClick={handleCopy}
            className="inline-flex items-center gap-1 rounded-md border border-white/10 bg-white/[0.03] px-2 py-1 font-mono text-[11px] text-zinc-400 transition hover:border-white/20 hover:text-white"
          >
            {copied ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      )}
      {!title && (
        <button
          type="button"
          onClick={handleCopy}
          aria-label="Copy code"
          className="absolute right-3 top-3 z-10 inline-flex items-center gap-1 rounded-md border border-white/10 bg-zinc-900/90 px-2 py-1 font-mono text-[11px] text-zinc-400 opacity-0 transition hover:border-white/20 hover:text-white group-hover:opacity-100"
        >
          {copied ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
          {copied ? "Copied" : "Copy"}
        </button>
      )}
      <pre
        className="overflow-auto p-4 font-mono text-[12.5px] leading-6"
        style={maxHeight ? { maxHeight } : undefined}
      >
        <code>
          {lines.map((line, i) => (
            <div key={i} className="table-row">
              {showLineNumbers && (
                <span className="table-cell select-none pr-4 text-right text-zinc-600">{i + 1}</span>
              )}
              <span className="table-cell whitespace-pre">
                {tokenizeLine(line, language).map((tok, j) => (
                  <span key={j} className={tok.className}>
                    {tok.text}
                  </span>
                ))}
                {line === "" ? "\n" : null}
              </span>
            </div>
          ))}
        </code>
      </pre>
    </div>
  );
}
