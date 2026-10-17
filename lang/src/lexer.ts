import { SplSyntaxError } from './errors.js';

export type StringPart = { text: string } | { expr: string; line: number; col: number };

export type Token =
    | { type: 'num'; value: number; line: number; col: number }
    | { type: 'str'; parts: StringPart[]; line: number; col: number }
    | { type: 'name'; value: string; line: number; col: number }
    | { type: 'op'; value: string; line: number; col: number }
    | { type: 'nl'; line: number; col: number }
    | { type: 'eof'; line: number; col: number };

const OPS = [
    '//=', '**', '//', '==', '!=', '<=', '>=', '+=', '-=', '*=', '/=', '%=',
    '+', '-', '*', '/', '%', '<', '>', '=', '(', ')', '[', ']', '{', '}', ',', ':', '.', '?', '@', ';',
];

const ESCAPES: Record<string, string> = {
    n: '\n', t: '\t', r: '\r', '0': '\0', '\\': '\\', "'": "'", '"': '"', '{': '{', '}': '}',
};

const isDigit = (c: string) => c >= '0' && c <= '9';
const isNameStart = (c: string) => /[A-Za-z_]/.test(c);
const isNameChar = (c: string) => /[A-Za-z0-9_]/.test(c);

export interface LexOptions {
    /** Lexing the body of a `{...}` interpolation: newlines are insignificant. */
    inExpr?: boolean;
    line?: number;
    col?: number;
}

export function tokenize(src: string, opts: LexOptions = {}): Token[] {
    const tokens: Token[] = [];
    let i = 0;
    let line = opts.line ?? 1;
    let col = opts.col ?? 1;
    let depth = opts.inExpr ? 1 : 0;
    const brackets: string[] = [];

    const err = (msg: string, l = line, c = col): never => {
        throw new SplSyntaxError(msg, l, c);
    };
    const advance = (n = 1) => {
        for (let k = 0; k < n; k++) {
            if (src[i] === '\n') {
                line++;
                col = 1;
            } else {
                col++;
            }
            i++;
        }
    };

    while (i < src.length) {
        const c = src[i];

        if (c === ' ' || c === '\t' || c === '\r') {
            advance();
            continue;
        }
        if (c === '#') {
            while (i < src.length && src[i] !== '\n') advance();
            continue;
        }
        if (c === '\\' && (src[i + 1] === '\n' || (src[i + 1] === '\r' && src[i + 2] === '\n'))) {
            advance(src[i + 1] === '\r' ? 3 : 2);
            continue;
        }
        if (c === '\n') {
            if (depth === 0) tokens.push({ type: 'nl', line, col });
            advance();
            continue;
        }

        const startLine = line;
        const startCol = col;

        if (isDigit(c)) {
            const m = /^\d+(\.\d+)?([eE][+-]?\d+)?/.exec(src.slice(i))!;
            advance(m[0].length);
            if (i < src.length && isNameChar(src[i])) err('invalid number literal', startLine, startCol);
            tokens.push({ type: 'num', value: Number(m[0]), line: startLine, col: startCol });
            continue;
        }

        const quoteAt = (k: number) => src[k] === "'" || src[k] === '"';
        if (quoteAt(i) || (c === 'r' && quoteAt(i + 1))) {
            const raw = c === 'r';
            if (raw) advance();
            tokens.push(readString(raw));
            continue;
        }

        if (isNameStart(c)) {
            let j = i;
            while (j < src.length && isNameChar(src[j])) j++;
            const value = src.slice(i, j);
            advance(j - i);
            tokens.push({ type: 'name', value, line: startLine, col: startCol });
            continue;
        }

        const op = OPS.find((o) => src.startsWith(o, i));
        if (!op) err(`unexpected character '${c}'`);
        advance(op!.length);
        if (op === '(' || op === '[') {
            brackets.push(op);
            depth++;
        } else if (op === ')' || op === ']') {
            const open = brackets.pop();
            if ((op === ')' && open !== '(') || (op === ']' && open !== '[')) {
                err(`unbalanced '${op}'`, startLine, startCol);
            }
            depth--;
        }
        tokens.push({ type: 'op', value: op!, line: startLine, col: startCol });
    }

    if (brackets.length) err(`unclosed '${brackets[brackets.length - 1]}'`);
    tokens.push({ type: 'eof', line, col });
    return tokens;

    function readString(raw: boolean): Token {
        const startLine = line;
        const startCol = col;
        const quote = src[i];
        const triple = src.startsWith(quote.repeat(3), i);
        advance(triple ? 3 : 1);
        const parts: StringPart[] = [];
        let text = '';
        const flush = () => {
            if (text) parts.push({ text });
            text = '';
        };

        for (;;) {
            if (i >= src.length) err('unterminated string', startLine, startCol);
            const ch = src[i];
            if (triple ? src.startsWith(quote.repeat(3), i) : ch === quote) {
                advance(triple ? 3 : 1);
                break;
            }
            if (ch === '\n' && !triple) err('unterminated string', startLine, startCol);
            if (raw) {
                text += ch;
                advance();
                continue;
            }
            if (ch === '\\') {
                const esc = src[i + 1];
                if (esc === '\n') {
                    advance(2);
                    continue;
                }
                if (esc === undefined || !(esc in ESCAPES)) err(`invalid escape sequence '\\${esc ?? ''}'`);
                text += ESCAPES[esc];
                advance(2);
                continue;
            }
            if (ch === '{') {
                if (src[i + 1] === '{') {
                    text += '{';
                    advance(2);
                    continue;
                }
                flush();
                advance();
                const exprLine = line;
                const exprCol = col;
                const exprSrc = readInterpolation();
                if (!exprSrc.trim()) err('empty interpolation', exprLine, exprCol);
                parts.push({ expr: exprSrc, line: exprLine, col: exprCol });
                continue;
            }
            if (ch === '}') {
                if (src[i + 1] === '}') {
                    text += '}';
                    advance(2);
                    continue;
                }
                err("single '}' in string; write '}}' or '\\}' for a literal brace");
            }
            text += ch;
            advance();
        }
        flush();
        return { type: 'str', parts, line: startLine, col: startCol };
    }

    /** Reads up to the matching '}' of an interpolation, returning the expression source. */
    function readInterpolation(): string {
        const start = i;
        const startLine = line;
        const startCol = col;
        let nest = 0;
        for (;;) {
            if (i >= src.length) err("unterminated interpolation, missing '}'", startLine, startCol);
            const ch = src[i];
            if (ch === '"' || ch === "'") {
                advance();
                while (i < src.length && src[i] !== ch && src[i] !== '\n') {
                    advance(src[i] === '\\' ? 2 : 1);
                }
                if (src[i] !== ch) err('unterminated string in interpolation', startLine, startCol);
                advance();
                continue;
            }
            if (ch === '{' || ch === '[' || ch === '(') nest++;
            if (ch === '}' || ch === ']' || ch === ')') {
                if (nest === 0) {
                    if (ch !== '}') err(`unbalanced '${ch}' in interpolation`);
                    const body = src.slice(start, i);
                    advance();
                    return body;
                }
                nest--;
            }
            advance();
        }
    }
}
