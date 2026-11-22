export interface Span {
  file: string;
  line: number;
  col: number;
  endLine?: number;
  endCol?: number;
}

export class SplError extends Error {
  readonly phase: "lex" | "parse" | "type" | "codegen" | "module";
  readonly span?: Span;

  constructor(
    phase: "lex" | "parse" | "type" | "codegen" | "module",
    message: string,
    span?: Span
  ) {
    const loc = span ? `${span.file}:${span.line}:${span.col}: ` : "";
    super(`${loc}[${phase}] ${message}`);
    this.name = "SplError";
    this.phase = phase;
    this.span = span;
  }
}

export function dummySpan(file = "<internal>"): Span {
  return { file, line: 1, col: 1 };
}
