import { SplSyntaxError } from './errors.js';

export type StringPart = { text: string } | { expr: string; line: number; col: number };

export type Token =
    | { type: 'num'; value: number; line: number; col: number }
    | { type: 'str'; parts: StringPart[]; line: number; col: number }
    | { type: 'name'; value: string; line: number; col: number }
    | { type: 'op'; value: string; line: number; col: number }
    | { type: 'nl'; line: number; col: number }
    | { type: 'indent' | 'dedent'; line: number; col: number }
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
const EXPR_PREFIXES = new Set([
    'let', 'if', 'elif', 'else', 'for', 'in', 'while', 'def', 'return', 'try', 'except', 'assert', 'fail',
    'success', 'enforce', 'forbid', 'restrict', 'ask', 'think', 'agent', 'human', 'break', 'continue', 'pass',
    'and', 'or', 'not',
]);
const canEndExpression = (token: Token | undefined): boolean =>
    token?.type === 'num' || token?.type === 'str' ||
    (token?.type === 'name' && !EXPR_PREFIXES.has(token.value)) ||
    (token?.type === 'op' && [')', ']', '}'].includes(token.value));

export interface LexOptions {
    /** Interpolation newlines are insignificant except inside indentation suites. */
    inExpr?: boolean;
    line?: number;
    col?: number;
    /** Original first-line indentation when lexing an interpolation substring. */
    indent?: number;
    /** Editor analysis may tokenize a document while a group is still being typed. */
    allowUnclosedBrackets?: boolean;
}

export function tokenize(src: string, opts: LexOptions = {}): Token[] {
    const tokens: Token[] = [];
    let i = 0;
    let line = opts.line ?? 1;
    let col = opts.col ?? 1;
    const brackets: string[] = [];
    const indexes = new Set<number>();
    // Suites inside expression groups need their own indentation baseline.
    const indents = [{ width: opts.indent ?? 0, depth: 0, base: true }];
    const suiteHeaders = new Map<number, number>();
    let pendingSuite: { width: number; depth: number } | undefined;
    let lineStart = true;
    let lineIndent = 0;
    let suiteColon = false;

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
        if (lineStart) {
            const start = i;
            while (src[i] === ' ' || src[i] === '\t') advance();
            lineIndent = start === 0 && opts.inExpr ? opts.indent ?? 0 : i - start;
            lineStart = false;
            if (i === src.length) break;
            const blank = src[i] === '#' || src[i] === '\r' || src[i] === '\n';
            const active = indents.at(-1)!;
            const significant = pendingSuite || (!opts.inExpr && brackets.length === 0) ||
                (!active.base && brackets.length === active.depth);
            if (!blank && significant) {
                if (src.slice(start, i).includes('\t')) err('tabs are not allowed in indentation; use spaces', line, 1);
                if (pendingSuite) {
                    if (lineIndent <= pendingSuite.width) err('expected an indented block');
                    if (indents.at(-1)!.depth !== pendingSuite.depth) {
                        indents.push({ ...pendingSuite, base: true });
                    } else if (indents.at(-1)!.base) {
                        indents.at(-1)!.width = pendingSuite.width;
                    }
                    indents.push({ width: lineIndent, depth: pendingSuite.depth, base: false });
                    tokens.push({ type: 'indent', line, col });
                    pendingSuite = undefined;
                } else {
                    let dedented = false;
                    while (lineIndent < indents.at(-1)!.width && indents.length > 1) {
                        const indent = indents.pop()!;
                        if (!indent.base) tokens.push({ type: 'dedent', line, col });
                        dedented = true;
                    }
                    if (lineIndent !== indents.at(-1)!.width) {
                        err(dedented ? 'inconsistent dedent' : 'unexpected indentation');
                    }
                }
            }
        }
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
            const last = tokens.at(-1);
            if (last?.type === 'op' && last.value === ':' && suiteColon) {
                pendingSuite = { width: suiteHeaders.get(brackets.length) ?? lineIndent, depth: brackets.length };
            }
            if (pendingSuite || (!opts.inExpr && brackets.length === 0) ||
                (!indents.at(-1)!.base && brackets.length === indents.at(-1)!.depth)) {
                tokens.push({ type: 'nl', line, col });
                suiteHeaders.delete(brackets.length);
            }
            advance();
            lineStart = true;
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

        if (isNameStart(c) || c === '$') {
            if (c === '$' && (i + 1 >= src.length || !isNameStart(src[i + 1]))) err("unexpected character '$'");
            let j = i + (c === '$' ? 1 : 0);
            while (j < src.length && isNameChar(src[j])) j++;
            const value = src.slice(i, j);
            const previous = tokens.at(-1);
            const member = previous?.type === 'op' && previous.value === '.';
            const prefix = !canEndExpression(previous);
            if (!member && (['def', 'for', 'while', 'try', 'except', 'enforce', 'forbid', 'restrict', 'elif'].includes(value) ||
                (['if', 'else'].includes(value) && prefix))) {
                suiteHeaders.set(brackets.length, lineIndent);
            }
            advance(j - i);
            tokens.push({ type: 'name', value, line: startLine, col: startCol });
            continue;
        }

        const op = OPS.find((o) => src.startsWith(o, i));
        if (!op) err(`unexpected character '${c}'`);
        advance(op!.length);
        if (op === ':') {
            const previous = tokens.at(-1);
            suiteColon = brackets.length === 0 || brackets.at(-1) === '(' || suiteHeaders.has(brackets.length) ||
                (!indexes.has(brackets.length) && previous?.type === 'op' && ['=', '[', '{', ',', ':'].includes(previous.value));
        }
        if (op === '(' || op === '[' || op === '{') {
            const index = op === '[' && canEndExpression(tokens.at(-1));
            brackets.push(op);
            if (index) indexes.add(brackets.length);
        } else if (op === ')' || op === ']' || op === '}') {
            suiteHeaders.delete(brackets.length);
            indexes.delete(brackets.length);
            if (indents.length > 1 && indents.at(-1)!.base && indents.at(-1)!.depth === brackets.length) indents.pop();
            const open = brackets.pop();
            if (open !== { ')': '(', ']': '[', '}': '{' }[op]) {
                err(`unbalanced '${op}'`, startLine, startCol);
            }
        } else if (op === ',' || op === ';') {
            suiteHeaders.delete(brackets.length);
        }
        tokens.push({ type: 'op', value: op!, line: startLine, col: startCol });
    }

    if (brackets.length && !opts.allowUnclosedBrackets) err(`unclosed '${brackets[brackets.length - 1]}'`);
    if (!opts.inExpr || indents.length > 1) {
        if (tokens.length && tokens.at(-1)!.type !== 'nl') tokens.push({ type: 'nl', line, col });
        while (indents.length > 1) {
            if (!indents.pop()!.base) tokens.push({ type: 'dedent', line, col });
        }
    }
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
