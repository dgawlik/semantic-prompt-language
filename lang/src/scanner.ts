import { parse as parseYaml } from 'yaml';
import { REASONING_LEVELS } from './llm.js';

export const MODES = ['ask', 'agent', 'codegen'] as const;
export type BlockMode = typeof MODES[number];

export interface ScanOptions {
    /** Allow `eval '...' { ... --- ... }` blocks (only for `*.eval.spl` files). */
    eval?: boolean;
}

export interface EvalCase {
    name: string;
    line: number;
    endLine: number;
    dividerLine: number;
}

type Applies = 'all' | 'agent' | 'ask';

export interface HeaderKey {
    name: string;
    applies: Applies;
    description: string;
    /** The closed set of values, when there is one. */
    values?: readonly string[];
    /** Allowed in the block that sets defaults for the whole file. */
    fileDefault?: boolean;
}

/** Every header key a `---` block accepts; editors complete and document from the same table. */
export const HEADER_KEYS: readonly HeaderKey[] = [
    { name: 'mode', applies: 'all', values: MODES, description: '`ask` (default) for one model call, `agent` for a model that acts with tools, `codegen` to generate functions.' },
    { name: 'model', applies: 'all', fileDefault: true, description: 'Model id; `provider/model` selects a provider.' },
    { name: 'reasoning', applies: 'all', fileDefault: true, values: REASONING_LEVELS, description: 'Reasoning level: `none`, `low`, `medium` (default), `high` or `max`.' },
    { name: 'enforce', applies: 'all', fileDefault: true, description: 'Guidance the model must follow: a string or a list of strings.' },
    { name: 'forbid', applies: 'all', fileDefault: true, description: 'Guidance on what the model must avoid: a string or a list of strings.' },
    { name: 'hide', applies: 'all', fileDefault: true, values: ['true', 'false'], description: 'Hide reasoning in logs.' },
    { name: 'tokens', applies: 'all', fileDefault: true, description: 'Maximum generated tokens per model turn.' },
    { name: 'restrict', applies: 'agent', description: 'Limits for this block: `{ fs, exec, net, mcp }`.' },
    { name: 'outputVar', applies: 'ask', description: 'Name of the output variable; `=name` assigns an existing `let`.' },
    { name: 'outputType', applies: 'ask', description: 'Type expression the answer is coerced to; `Str` by default.' },
    { name: 'repairs', applies: 'ask', description: 'Retries (0 to 5) when the answer cannot be coerced to `outputType`.' },
    { name: 'seed', applies: 'ask', description: 'Sampling seed.' },
    { name: 'temperature', applies: 'ask', description: 'Sampling temperature, 0 to 2.' },
    { name: 'topP', applies: 'ask', description: 'Nucleus sampling, 0 to 1.' },
];

const KEYS = new Map(HEADER_KEYS.map(key => [key.name, key]));
const LEGACY_KEYS = new Set(['extension', 'version', 'preamble']);
const LEGACY = 'SPL 2.x syntax; see the migration guide';
const IDENTIFIER = /[A-Za-z_$][\w$]*/y;
const REFERENCE = /@(@|[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)/g;
// After these, `/` starts a regular expression and a `---` block would be an operand.
const REGEX_KEYWORDS = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);
const OPERAND_EXPECTED = new Set(['=', '+', '-', '*', '/', '%', ',', '?', '&', '|', '^', '!', '~', '<', '=>', '.', '(', '[']);

/**
 * The default export of every `.spl` module, declared for type checkers: the scanner's TypeScript has the
 * workflow body at the top level, so a file that imports the module still sees its workflow function.
 */
export const DEFAULT_EXPORT = "declare const __workflow: import('spl-lang').__spl.Workflow; export default __workflow;";

/**
 * How the scanner's TypeScript is type-checked, by `spl check` and by editors: strict about values that may
 * be missing, relaxed about annotations a short script leaves out, and limited to type syntax Node can erase.
 */
export const CHECK_OPTIONS = {
    target: 'esnext', module: 'esnext', moduleResolution: 'bundler', moduleDetection: 'force', lib: ['esnext'],
    strict: true, noImplicitAny: false, useUnknownInCatchVariables: false,
    erasableSyntaxOnly: true, allowImportingTsExtensions: true, resolveJsonModule: true, allowJs: true,
    noEmit: true, skipLibCheck: true, types: ['node'],
} as const;

/** A position in the source, 1-based, as editors and compilers report it. */
export interface SplProblem {
    line: number;
    column: number;
    endColumn: number;
    message: string;
}

/** `@name` in a block: a value the block reads. */
export interface BlockInput {
    /** As written after `@`, such as `invoice.total`. */
    name: string;
    line: number;
    column: number;
}

export interface BlockOutput {
    name: string;
    line: number;
    column: number;
    /** Type expression of an agent or ask output, or the signature of a generated function. */
    type?: string;
    /** `@=name`: assigns an existing variable instead of declaring a constant. */
    assign: boolean;
}

export interface SplBlock {
    mode: BlockMode;
    /** Lines of the opening and closing `---`. */
    line: number;
    endLine: number;
    /** Open brackets around the block; 0 at the top level. */
    depth: number;
    /** Header values other than `mode`, `outputVar` and `outputType`. */
    settings: Record<string, unknown>;
    /** The instruction as written, without the header. */
    text: string;
    inputs: BlockInput[];
    outputs: BlockOutput[];
}

/** A known header key where it is written. */
export interface HeaderEntry {
    name: string;
    line: number;
    column: number;
}

/**
 * The lines from one `---` to the next, whatever they hold: a block, file defaults, or text the scanner
 * rejects. Editors complete and explain headers from this while a block is still being typed.
 */
export interface Region {
    line: number;
    /** The closing `---`, or the last line of the file while the block is still open. */
    endLine: number;
    open: boolean;
    mode: BlockMode;
    header: HeaderEntry[];
    /** The first line after the header. */
    bodyLine: number;
}

export interface SplComment {
    line: number;
    endLine: number;
    /** The Markdown between the comment markers. */
    text: string;
}

export interface FileDefaults {
    line: number;
    endLine: number;
    settings: Record<string, unknown>;
}

/** Where generated code stands for source text on the same line; code outside blocks keeps its columns. */
export interface Span {
    line: number;
    column: number;
    generatedColumn: number;
    length: number;
}

export interface Scan {
    /** TypeScript with every construct on its source line. */
    code: string;
    blocks: SplBlock[];
    regions: Region[];
    comments: SplComment[];
    defaults?: FileDefaults;
    evals: EvalCase[];
    spans: Span[];
    problems: SplProblem[];
    lines: readonly string[];
}

/** Where a position in the scanner's TypeScript sits in the source: the line is the same, the column may not be. */
export function sourceColumn(scan: Scan, line: number, column: number): number {
    const span = scan.spans.find(item => item.line === line && column >= item.generatedColumn && column <= item.generatedColumn + item.length);
    if (span) return span.column + column - span.generatedColumn;
    // Generated code of a block has no counterpart in the source: point at the start of the line.
    const text = scan.lines[line - 1] ?? '';
    return scan.regions.some(region => line >= region.line && line <= region.endLine) ? text.length - text.trimStart().length + 1 : column;
}

/** Optimal string alignment distance: one transposition, insertion, deletion or substitution each cost 1. */
function distance(a: string, b: string): number {
    const rows = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array<number>(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) rows[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
            rows[i][j] = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
            if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) rows[i][j] = Math.min(rows[i][j], rows[i - 2][j - 2] + 1);
        }
    }
    return rows[a.length][b.length];
}

/** The header key a near miss was meant to be. Capitalized words are prose unless they only differ in case or underscores. */
function misspelled(key: string): string | undefined {
    const lower = key.toLowerCase();
    const plain = lower.replace(/_/g, '');
    return HEADER_KEYS.map(({ name }) => ({ name, far: name.toLowerCase() === plain ? 0 : distance(key, name) }))
        .filter(({ name, far }) => far === 0 || key[0] === lower[0] && far <= (name.length > 5 ? 2 : 1))
        .sort((a, b) => a.far - b.far || Math.abs(a.name.length - key.length) - Math.abs(b.name.length - key.length))[0]?.name;
}

const strings = (value: unknown): value is string | string[] =>
    typeof value === 'string' && value.trim() !== ''
    || Array.isArray(value) && value.length > 0 && value.every(item => typeof item === 'string' && item.trim() !== '');
const within = (value: unknown, low: number, high: number): boolean => typeof value === 'number' && value >= low && value <= high;

/** Checks one header value; returns what is wrong with it, if anything. */
function invalid(key: string, value: unknown): string | undefined {
    switch (key) {
        case 'mode': return MODES.includes(value as BlockMode) ? undefined : 'must be ask, agent or codegen';
        case 'model': return typeof value === 'string' && value.trim() ? undefined : 'must be a model id';
        case 'reasoning': return REASONING_LEVELS.includes(value as typeof REASONING_LEVELS[number]) ? undefined : 'must be none, low, medium, high or max';
        case 'enforce':
        case 'forbid': return strings(value) ? undefined : 'must be a string or a list of strings';
        case 'hide': return typeof value === 'boolean' ? undefined : 'must be true or false';
        case 'tokens': return Number.isSafeInteger(value) && (value as number) > 0 ? undefined : 'must be a positive integer';
        case 'restrict': {
            if (strings(value)) return undefined;
            const entries = typeof value === 'object' && value !== null && !Array.isArray(value) ? Object.entries(value) : [];
            return entries.length && entries.every(([kind, item]) => ['fs', 'exec', 'net', 'mcp'].includes(kind) && strings(item))
                ? undefined : 'must be a folder or { fs, exec, net, mcp } with strings or lists of strings';
        }
        case 'outputVar': return typeof value === 'string' && /^=?[A-Za-z_$][\w$]*$/.test(value) ? undefined : 'must be a variable name, or =name to assign an existing variable';
        case 'repairs': return Number.isInteger(value) && within(value, 0, 5) ? undefined : 'must be an integer from 0 to 5';
        case 'seed': return Number.isInteger(value) && within(value, 0, 2147483647) ? undefined : 'must be an integer from 0 to 2147483647';
        case 'temperature': return within(value, 0, 2) ? undefined : 'must be a number from 0 to 2';
        case 'topP': return within(value, 0, 1) ? undefined : 'must be a number from 0 to 1';
        default: return undefined;
    }
}

/** End of the bracket opened at `start`, skipping quoted text; -1 when it never closes on this line. */
function closing(text: string, start: number): number {
    const pairs: Record<string, string> = { '[': ']', '(': ')', '{': '}', '<': '>' };
    const expected: string[] = [];
    for (let index = start; index < text.length; index++) {
        const char = text[index];
        if (char === '"' || char === "'" || char === '`') {
            const end = text.indexOf(char, index + 1);
            if (end < 0) return -1;
            index = end;
        } else if (char === '=' && text[index + 1] === '>') index++;
        else if (pairs[char]) expected.push(pairs[char]);
        else if (char === expected.at(-1)) {
            expected.pop();
            if (!expected.length) return index;
        }
    }
    return -1;
}

interface Arrow {
    /** Columns (0-based) of `->` and of the end of the declaration. */
    start: number;
    end: number;
    name: string;
    nameStart: number;
    assign: boolean;
    type?: string;
    typeStart?: number;
}

/** Output declarations on one line: `->[Type] @name` in agent blocks, `-> @name(params): Type` in codegen blocks. */
function arrows(text: string, mode: BlockMode): Arrow[] {
    const found: Arrow[] = [];
    for (let start = text.indexOf('->'); start >= 0; start = text.indexOf('->', start + 2)) {
        let index = start + 2;
        const spaces = (): void => { while (text[index] === ' ' || text[index] === '\t') index++; };
        spaces();
        let type: string | undefined;
        let typeStart: number | undefined;
        if (mode !== 'codegen' && text[index] === '[') {
            const end = closing(text, index);
            if (end < 0) continue;
            const inner = text.slice(index + 1, end);
            type = inner.trim();
            typeStart = index + 1 + inner.length - inner.trimStart().length;
            index = end + 1;
            spaces();
        }
        if (text[index] !== '@') continue;
        const assign = text[index + 1] === '=';
        IDENTIFIER.lastIndex = index + (assign ? 2 : 1);
        const name = IDENTIFIER.exec(text)?.[0];
        if (!name) continue;
        const nameStart = IDENTIFIER.lastIndex - name.length;
        index = IDENTIFIER.lastIndex;
        if (mode === 'codegen' && text[index] === '(') {
            const end = closing(text, index);
            if (end < 0) continue;
            typeStart = index;
            const result = /^\s*:\s*(\S.*?)\s*$/.exec(text.slice(end + 1));
            type = `${text.slice(index, end + 1)}: ${result ? result[1] : 'any'}`;
            index = result ? text.length : end + 1;
        }
        found.push({ start, end: index, name, nameStart, assign, ...(type !== undefined ? { type, typeStart } : {}) });
        start = index - 2;
    }
    return found;
}

function unescapeString(raw: string): string {
    return raw.replace(/\\(.)/g, (_, ch: string) => {
        switch (ch) {
            case 'n': return '\n';
            case 'r': return '\r';
            case 't': return '\t';
            case '\\': return '\\';
            case "'": return "'";
            case '"': return '"';
            default: return ch;
        }
    });
}

class Scanner {
    readonly problems: SplProblem[] = [];
    readonly blocks: SplBlock[] = [];
    readonly regions: Region[] = [];
    readonly comments: SplComment[] = [];
    readonly evals: EvalCase[] = [];
    readonly spans: Span[] = [];
    readonly out: string[] = [];
    defaults?: FileDefaults;
    /** Open `{`, `(`, `[`, template literals (`` ` ``) and their `${` expressions. */
    private readonly stack: string[] = [];
    private blockComment = false;
    private quote = '';
    private previous = '';
    private previousWord = false;
    /** Something other than a comment has been seen: file defaults are no longer allowed. */
    private started = false;
    /** Depth of the parameter list of a constructor, where `private x` would declare a field. */
    private constructorDepth = -1;
    private currentEval?: {
        name: string;
        line: number;
        depth: number;
        dividerCount: number;
        dividerLine: number;
        openLine: number;
    };

    constructor(private readonly lines: readonly string[], private readonly isEval = false) {}

    problem(line: number, column: number, length: number, message: string): void {
        this.problems.push({ line: line + 1, column: column + 1, endColumn: column + 1 + Math.max(1, length), message });
    }

    private wholeLine(line: number, message: string): void {
        const text = this.lines[line];
        const start = text.length - text.trimStart().length;
        this.problem(line, start, text.trim().length, message);
    }

    /** True between statements and expressions of code: not inside a string, template or comment. */
    private get inCode(): boolean {
        return !this.blockComment && !this.quote && this.stack.at(-1) !== '`';
    }

    run(): void {
        const { lines } = this;
        for (let index = 0; index < lines.length; index++) {
            const text = lines[index];
            const trimmed = text.trim();
            if (this.inCode) {
                if (this.currentEval && trimmed === '---') {
                    if (this.stack.length !== this.currentEval.depth) {
                        this.wholeLine(index, '`---` phase divider must be at the top level of the `eval` block');
                    } else if (this.currentEval.dividerCount > 0) {
                        this.wholeLine(index, 'eval block can only have one `---` phase divider');
                    } else {
                        this.currentEval.dividerLine = index + 1;
                    }
                    this.currentEval.dividerCount++;
                    this.out.push('await __spl.phase();');
                    continue;
                }
                if (!this.currentEval && trimmed === '---') {
                    index = this.block(index);
                    continue;
                }
                if (trimmed === '//*' || /^\/\/\*\s/.test(trimmed)) {
                    index = this.comment(index);
                    continue;
                }
                if (/^\{\/?(?:js|ts|agent|codegen|comment|lock)(?:[\s}]|$)/.test(trimmed) || /^(?:```|~~~)/.test(trimmed)) {
                    this.wholeLine(index, LEGACY);
                    this.out.push('');
                    continue;
                }
                const evalMatch = /^(\s*)eval\s+(['"])((?:\\.|(?!\2)[^\\])*)\2\s*\{(.*)$/.exec(text);
                if (evalMatch) {
                    const [, indent, , rawName, rest] = evalMatch;
                    const name = unescapeString(rawName);
                    if (!this.isEval) {
                        this.wholeLine(index, 'eval blocks are only allowed in *.eval.spl files');
                        this.out.push(text);
                        continue;
                    }
                    if (this.stack.length > 0 || this.currentEval) {
                        this.wholeLine(index, 'eval blocks are only allowed at the top level');
                        this.code(index);
                        this.out.push(text);
                        continue;
                    }
                    this.started = true;
                    this.previous = '{';
                    this.previousWord = false;
                    this.stack.push('{');
                    this.currentEval = {
                        name, line: index + 1, depth: this.stack.length,
                        dividerCount: 0, dividerLine: 0, openLine: index,
                    };
                    const restStart = text.length - rest.length;
                    const closeAt = this.code(index, restStart);
                    const prefix = `${indent}__spl.eval(${JSON.stringify(name)}, async () => {`;
                    if (closeAt !== undefined) {
                        const rel = closeAt - restStart;
                        this.out.push(`${prefix}${rest.slice(0, rel)}});${rest.slice(rel + 1)}`);
                    } else {
                        this.out.push(`${prefix}${rest}`);
                    }
                    continue;
                }
                if (this.currentEval && this.currentEval.dividerCount === 0) {
                    const lowered = this.lowerEvalAgentCall(index, text);
                    if (lowered !== undefined) {
                        this.started = true;
                        this.previous = ';';
                        this.previousWord = false;
                        this.out.push(lowered);
                        continue;
                    }
                }
            }
            const closeAt = this.code(index);
            if (closeAt !== undefined) {
                this.out.push(`${text.slice(0, closeAt)}});${text.slice(closeAt + 1)}`);
            } else {
                this.out.push(text);
            }
        }
        if (this.currentEval) {
            this.wholeLine(this.currentEval.openLine, `Unclosed eval block '${this.currentEval.name}'`);
        }
    }

    /** Lowers `agent('... @x ... -> @=x ...')` inside an eval block into an `AgentBlock` call when `@` or `-> @` is used. */
    private lowerEvalAgentCall(line: number, text: string): string | undefined {
        const match = /^(\s*)(?:await\s+)?agent\(\s*(['"])((?:\\.|(?!\2)[^\\])*)\2\s*\)\s*;?\s*$/.exec(text);
        if (!match) return undefined;
        const [, indent, , rawPrompt] = match;
        const promptText = unescapeString(rawPrompt);
        const foundArrows = arrows(promptText, 'agent');
        const outputs: { name: string; assign: boolean; type?: string }[] = [];
        for (const arrow of foundArrows) {
            outputs.push({ name: arrow.name, assign: arrow.assign, ...(arrow.type !== undefined ? { type: arrow.type } : {}) });
        }
        const produced = new Set(outputs.filter(o => !o.assign).map(o => o.name));
        const inputs: string[] = [];
        REFERENCE.lastIndex = 0;
        for (let m = REFERENCE.exec(promptText); m; m = REFERENCE.exec(promptText)) {
            const at = m.index;
            const name = m[1];
            if (name === '@' || /[\w@]/.test(promptText[at - 1] ?? '') || foundArrows.some(a => at >= a.start && at < a.end)) continue;
            if (produced.has(name.split('.')[0])) continue;
            inputs.push(name);
        }
        if (!inputs.length && !outputs.length) return undefined;
        const options = JSON.stringify({ line: line + 1, local: true, text: promptText.replace(/@@/g, '@') });
        let chain = `await __spl.agent(${options})`;
        for (const name of inputs) chain += `.in(${JSON.stringify(name)}, ${name})`;
        for (const out of outputs) chain += out.type ? `.out(${JSON.stringify(out.name)}, ${out.type})` : `.out(${JSON.stringify(out.name)})`;
        const declare = outputs.filter(o => !o.assign).map(o => o.name);
        const assign = outputs.filter(o => o.assign).map(o => o.name);
        if (!assign.length) {
            return `${indent}${declare.length ? `const { ${declare.join(', ')} } = ` : ''}${chain};`;
        }
        const result = `__spl${line + 1}`;
        return `${indent}const ${result} = ${chain};${declare.length ? ` const { ${declare.join(', ')} } = ${result};` : ''}${assign.map(name => ` ${name} = ${result}.${name};`).join('')}`;
    }

    private comment(start: number): number {
        const { lines } = this;
        let close = start + 1;
        while (close < lines.length && !lines[close].trim().startsWith('*//')) close++;
        if (this.stack.length) this.wholeLine(start, 'Markdown comments (`//*`) are only allowed at the top level');
        if (close >= lines.length) this.wholeLine(start, 'Unclosed Markdown comment: `//*` needs a closing `*//` at the start of a line');
        else if (lines[close].trim() !== '*//') this.wholeLine(close, '`*//` must be alone on its line');
        const end = Math.min(close, lines.length - 1);
        const body = [lines[start].trim().slice(3), ...lines.slice(start + 1, close)];
        const indent = Math.min(...body.slice(1).filter(line => line.trim()).map(line => line.length - line.trimStart().length));
        this.comments.push({
            line: start + 1, endLine: end + 1,
            text: body.map((line, index) => (index ? line.slice(Number.isFinite(indent) ? indent : 0) : line.trimStart()).trimEnd()).join('\n').replace(/^\n+|\n+$/g, ''),
        });
        for (let line = start; line <= end; line++) this.out.push('');
        return end;
    }

    /** Tracks strings, templates, regular expressions, comments and brackets across one line of code. */
    private code(line: number, startCol = 0): number | undefined {
        const text = this.lines[line];
        let index = startCol;
        let evalCloseAt: number | undefined;
        const significant = (token: string, word = false): void => {
            this.previous = token;
            this.previousWord = word;
            this.started = true;
        };
        while (index < text.length) {
            const char = text[index];
            if (this.blockComment) {
                const end = text.indexOf('*/', index);
                if (end < 0) return evalCloseAt;
                this.blockComment = false;
                index = end + 2;
            } else if (this.quote) {
                // A string continues on the next line only after a trailing backslash.
                for (; index < text.length; index++) {
                    if (text[index] === '\\') index++;
                    else if (text[index] === this.quote) break;
                }
                if (index >= text.length && text.endsWith('\\')) return evalCloseAt;
                this.quote = '';
                index++;
                significant('string');
            } else if (this.stack.at(-1) === '`') {
                if (char === '\\') index += 2;
                else if (char === '`') {
                    this.stack.pop();
                    index++;
                    significant('string');
                } else if (char === '$' && text[index + 1] === '{') {
                    this.stack.push('${');
                    index += 2;
                    significant('(');
                } else index++;
            } else if (char === ' ' || char === '\t') index++;
            else if (char === '/' && text[index + 1] === '/') return evalCloseAt;
            else if (char === '/' && text[index + 1] === '*') {
                this.blockComment = true;
                index += 2;
            } else if (char === '"' || char === "'") {
                this.quote = char;
                index++;
            } else if (char === '`') {
                this.stack.push('`');
                index++;
            } else if (char === '/' && (!this.previous || (this.previousWord ? REGEX_KEYWORDS.has(this.previous) : !/^(?:\)|\]|\}|string|number|\+\+|--)$/.test(this.previous)))) {
                let inClass = false;
                for (index++; index < text.length; index++) {
                    if (text[index] === '\\') index++;
                    else if (text[index] === '[') inClass = true;
                    else if (text[index] === ']') inClass = false;
                    else if (text[index] === '/' && !inClass) break;
                }
                index++;
                while (/[A-Za-z]/.test(text[index] ?? '')) index++;
                significant('string');
            } else if (/[A-Za-z_$]/.test(char)) {
                IDENTIFIER.lastIndex = index;
                const word = IDENTIFIER.exec(text)![0];
                this.unsupported(line, index, word, text.slice(index + word.length));
                index += word.length;
                significant(word, true);
            } else if (/[0-9]/.test(char)) {
                index += /^[0-9][\w.]*/.exec(text.slice(index))![0].length;
                significant('number');
            } else {
                if (char === '{' || char === '(' || char === '[') this.stack.push(char);
                else if (char === '}' || char === ')' || char === ']') {
                    this.stack.pop();
                    if (this.stack.length < this.constructorDepth) this.constructorDepth = -1;
                    if (char === '}' && this.currentEval && this.stack.length === this.currentEval.depth - 1) {
                        if (this.currentEval.dividerCount === 0) {
                            this.wholeLine(this.currentEval.openLine, `eval block '${this.currentEval.name}' must contain a '---' phase divider`);
                        }
                        this.evals.push({
                            name: this.currentEval.name,
                            line: this.currentEval.line,
                            endLine: line + 1,
                            dividerLine: this.currentEval.dividerLine,
                        });
                        this.currentEval = undefined;
                        evalCloseAt = index;
                    }
                } else if (char === '@') {
                    this.problem(line, index, 1, 'Unsupported TypeScript syntax: decorators cannot be erased; call the decorator as a function instead');
                }
                const pair = text.slice(index - 1, index + 1);
                significant(pair === '=>' || pair === '++' || pair === '--' ? pair : char);
                index++;
            }
        }
        return evalCloseAt;
    }

    /** TypeScript that produces code cannot be erased, so Node cannot run it. */
    private unsupported(line: number, column: number, word: string, rest: string): void {
        if (this.previous === '.') return;
        const report = (what: string, hint: string): void =>
            this.problem(line, column, word.length, `Unsupported TypeScript syntax: ${what} cannot be erased; ${hint}`);
        if (word === 'enum' && /^\s+[A-Za-z_$]/.test(rest) && this.previous !== 'declare') {
            report('`enum`', 'use a union of string literals instead of enum');
        } else if ((word === 'namespace' || word === 'module') && /^\s+[A-Za-z_$][\w$.]*\s*\{/.test(rest) && this.previous !== 'declare') {
            report(`\`${word}\``, 'use an ES module or a plain object instead of namespace');
        } else if (word === 'constructor' && /^\s*\(/.test(rest)) {
            this.constructorDepth = this.stack.length + 1;
        } else if (this.stack.length === this.constructorDepth && this.stack.at(-1) === '(' && (this.previous === '(' || this.previous === ',')
            && /^(?:public|private|protected|readonly)$/.test(word) && /^\s+[A-Za-z_$]/.test(rest)) {
            report('parameter properties', 'declare the field and assign it in the constructor');
        }
    }

    private block(start: number): number {
        const { lines } = this;
        let end = start + 1;
        while (end < lines.length && lines[end].trim() !== '---') end++;
        const open = end >= lines.length;
        const first = !this.started;
        const depth = this.stack.length;
        if (this.stack.at(-1) === '(' || this.stack.at(-1) === '[' || !this.previousWord && OPERAND_EXPECTED.has(this.previous)) {
            this.wholeLine(start, 'Blocks are statements: a `---` block cannot be used as an expression');
        }
        this.started = true;
        this.previous = ';';
        this.previousWord = false;

        // The header: leading `key: value` lines with known keys, plus their indented YAML continuation lines.
        const settings: Record<string, unknown> = {};
        const header: HeaderEntry[] = [];
        const where = new Map<string, number>();
        let outputType: { text: string; line: number; column: number } | undefined;
        let cursor = start + 1;
        while (cursor < end) {
            const match = /^(\s*)([A-Za-z_][\w]*)\s*:(?=\s|$)(.*)$/.exec(lines[cursor]);
            if (!match) break;
            const [, indent, key, rest] = match;
            const line = cursor;
            const report = (message: string): void => this.problem(line, indent.length, key.length, message);
            const known = KEYS.has(key);
            if (!known) {
                if (LEGACY_KEYS.has(key)) this.wholeLine(cursor, LEGACY);
                else {
                    const suggestion = misspelled(key);
                    if (!suggestion) break;
                    report(`unknown header key \`${key}\`; did you mean \`${suggestion}\`?`);
                }
            }
            cursor++;
            let chunk = `${key}:${rest}`;
            if (key !== 'outputType') {
                while (cursor < end && lines[cursor].trim() && lines[cursor].length - lines[cursor].trimStart().length > indent.length) {
                    chunk += `\n${lines[cursor++].slice(indent.length)}`;
                }
            }
            if (!known) continue;
            header.push({ name: key, line: line + 1, column: indent.length + 1 });
            if (where.has(key)) {
                report(`header key \`${key}\` is set twice`);
                continue;
            }
            where.set(key, line);
            if (key === 'outputType') {
                const text = rest.trim();
                if (!text) report('`outputType` needs a type expression such as Int or List(Str)');
                else outputType = { text, line, column: lines[line].length - rest.trimStart().length };
                continue;
            }
            let value: unknown;
            try {
                value = (parseYaml(chunk) as Record<string, unknown>)[key];
            } catch (error) {
                report(`\`${key}\` is not valid YAML: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
                continue;
            }
            const wrong = invalid(key, value);
            if (wrong) report(`\`${key}\` ${wrong}`);
            else settings[key] = key === 'enforce' || key === 'forbid' ? [value].flat()
                : key === 'restrict' && (typeof value === 'string' || Array.isArray(value)) ? { fs: value } : value;
        }
        this.regions.push({
            line: start + 1, endLine: Math.min(end, lines.length - 1) + 1, open, header, bodyLine: cursor + 1,
            mode: MODES.includes(settings.mode as BlockMode) ? settings.mode as BlockMode : 'ask',
        });
        if (open) {
            this.wholeLine(start, `Unmatched block opened at line ${start + 1}: every \`---\` needs a closing \`---\``);
            for (let line = start; line < lines.length; line++) this.out.push('');
            return lines.length;
        }
        while (cursor < end && !lines[cursor].trim()) cursor++;
        let last = end - 1;
        while (last >= cursor && !lines[last].trim()) last--;

        const generated = new Array<string>(end - start + 1).fill('');
        if (last < cursor) {
            this.fileDefaults(start, end, first, settings, where, outputType !== undefined);
            this.out.push(...generated);
            return end;
        }

        const mode = (settings.mode as BlockMode | undefined) ?? 'ask';
        delete settings.mode;
        for (const [key, line] of where) {
            const applies = KEYS.get(key)!.applies;
            if (applies === 'all' || applies === mode) continue;
            const text = lines[line];
            this.problem(line, text.length - text.trimStart().length, key.length, `\`${key}\` applies only to ${applies} blocks`);
            delete settings[key];
        }
        const outputVar = mode === 'ask' ? settings.outputVar as string | undefined : undefined;
        delete settings.outputVar;

        const body = lines.slice(cursor, last + 1);
        const indent = Math.min(...body.filter(line => line.trim()).map(line => line.length - line.trimStart().length));
        const text = body.map(line => line.slice(indent).trimEnd()).join('\n');
        const inputs: BlockInput[] = [];
        const outputs: BlockOutput[] = [];
        if (outputVar) {
            const line = where.get('outputVar')!;
            const assign = outputVar.startsWith('=');
            outputs.push({
                name: outputVar.replace(/^=/, ''), line: line + 1, column: lines[line].indexOf(outputVar, lines[line].indexOf(':')) + (assign ? 2 : 1), assign,
                ...(outputType ? { type: outputType.text } : {}),
            });
        } else if (mode === 'ask' && !where.has('outputVar')) {
            this.wholeLine(start, 'ask block needs outputVar: name the variable that receives the answer, such as `outputVar: summary`');
        }
        if (outputType && mode === 'ask') {
            generated[outputType.line - start] = `${outputType.text} })`;
            this.spans.push({ line: outputType.line + 1, column: outputType.column + 1, generatedColumn: 1, length: outputType.text.length });
        }

        // Outputs first: `@name` of a constant this block declares refers to that output, not to an input.
        const declared = body.map((line, offset) => {
            const found = arrows(line, mode);
            for (const arrow of found) {
                if (mode === 'ask') {
                    this.problem(cursor + offset, arrow.start, arrow.end - arrow.start, 'ask block needs outputVar: `->` declares outputs only in agent and codegen blocks');
                } else if (outputs.some(output => output.name === arrow.name)) {
                    this.problem(cursor + offset, arrow.nameStart, arrow.name.length, `output @${arrow.name} is declared twice in this block`);
                } else if (mode === 'codegen' && arrow.assign) {
                    this.problem(cursor + offset, arrow.nameStart, arrow.name.length, 'generated functions are always new constants; write `@name`, not `@=name`');
                } else {
                    outputs.push({
                        name: arrow.name, line: cursor + offset + 1, column: arrow.nameStart + 1, assign: arrow.assign,
                        ...(arrow.type !== undefined ? { type: arrow.type } : {}),
                    });
                }
            }
            return found;
        });
        if (mode === 'codegen' && !outputs.length) {
            this.wholeLine(start, 'codegen block needs a function to generate, such as `-> @slugify(text: string): string`');
        }
        // An output that assigns an existing variable can still be read: it has a value before the block runs.
        const produced = new Set(outputs.filter(output => !output.assign).map(output => output.name));
        body.forEach((line, offset) => {
            const row = cursor + offset;
            let code = '';
            const emit = (prefix: string, expression: string, suffix: string, column: number): void => {
                this.spans.push({ line: row + 1, column: column + 1, generatedColumn: code.length + prefix.length + 1, length: expression.length });
                code += prefix + expression + suffix;
            };
            if (line.trim().startsWith('//*')) this.wholeLine(row, 'Markdown comments (`//*`) are only allowed at the top level');
            const found = mode === 'ask' ? [] : declared[offset].filter(arrow => outputs.some(output => output.name === arrow.name && output.line === row + 1));
            REFERENCE.lastIndex = 0;
            const items: { at: number; write: () => void }[] = [];
            for (let match = REFERENCE.exec(line); match; match = REFERENCE.exec(line)) {
                const at = match.index;
                const name = match[1];
                if (name === '@' || /[\w@]/.test(line[at - 1] ?? '') || declared[offset].some(arrow => at >= arrow.start && at < arrow.end)) continue;
                if (produced.has(name.split('.')[0])) continue;
                inputs.push({ name, line: row + 1, column: at + 2 });
                items.push({ at, write: () => emit(`.in(${JSON.stringify(name)}, `, name, ')', at + 1) });
            }
            for (const arrow of found) {
                items.push({ at: arrow.start, write: () => {
                    if (mode === 'codegen' && arrow.type) emit(`.fn<{ ${arrow.name}`, arrow.type, ` }>(${JSON.stringify(arrow.name)})`, arrow.typeStart!);
                    else if (mode === 'codegen') code += `.fn<{ ${arrow.name}(...args: any[]): any }>(${JSON.stringify(arrow.name)})`;
                    else if (arrow.type) emit(`.out(${JSON.stringify(arrow.name)}, `, arrow.type, ')', arrow.typeStart!);
                    else code += `.out(${JSON.stringify(arrow.name)})`;
                } });
            }
            for (const item of items.sort((a, b) => a.at - b.at)) item.write();
            generated[row - start] += code;
        });

        const options = JSON.stringify({
            line: start + 1, ...settings, ...(depth ? { local: true } : {}),
            ...(outputVar ? { output: outputVar.replace(/^=/, '') } : {}),
            text: text.replace(/@@/g, '@'),
        });
        const call = `await __spl.${mode}(${mode === 'ask' && outputType ? `${options.slice(0, -1)}, "outputType":` : `${options})`}`;
        const declare = outputs.filter(output => !output.assign).map(output => output.name);
        const assign = outputs.filter(output => output.assign).map(output => output.name);
        const result = `__spl${start + 1}`;
        if (mode === 'ask') {
            generated[0] = `${outputVar ? `${assign.length ? assign[0] : `const ${declare[0]}`} = ` : ''}${call}`;
            generated[end - start] = ';';
        } else if (!assign.length) {
            generated[0] = `${declare.length ? `const { ${declare.join(', ')} } = ` : ''}${call}`;
            generated[end - start] = ';';
        } else {
            generated[0] = `const ${result} = ${call}`;
            generated[end - start] = `;${declare.length ? ` const { ${declare.join(', ')} } = ${result};` : ''}${assign.map(name => ` ${name} = ${result}.${name};`).join('')}`;
        }
        this.blocks.push({ mode, line: start + 1, endLine: end + 1, depth, settings, text, inputs, outputs });
        this.out.push(...generated);
        return end;
    }

    private fileDefaults(start: number, end: number, first: boolean, settings: Record<string, unknown>, where: Map<string, number>, typed: boolean): void {
        if (!where.size && !typed) {
            this.wholeLine(start, 'empty block: write an instruction between the `---` lines');
            return;
        }
        if (!first || this.defaults) {
            this.wholeLine(start, 'File defaults must come first: a block without an instruction sets defaults for the whole file');
            return;
        }
        for (const [key, line] of where) {
            if (KEYS.get(key)!.fileDefault) continue;
            const text = this.lines[line];
            this.problem(line, text.length - text.trimStart().length, key.length, `\`${key}\` cannot be a file default; it belongs to a block with an instruction`);
            delete settings[key];
        }
        this.defaults = { line: start + 1, endLine: end + 1, settings };
    }
}

/**
 * The front scanner: turns a `.spl` file into TypeScript. Code is copied as written, Markdown comments
 * become blank lines and each `---` block becomes a call on the lines it occupied, so positions in the
 * result are positions in the source.
 */
export function scan(source: string, options: ScanOptions = {}): Scan {
    const lines = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
    const scanner = new Scanner(lines, Boolean(options.eval));
    scanner.run();
    return {
        code: scanner.out.join('\n'), blocks: scanner.blocks, regions: scanner.regions, comments: scanner.comments, defaults: scanner.defaults,
        evals: scanner.evals, spans: scanner.spans, problems: scanner.problems.sort((a, b) => a.line - b.line || a.column - b.column), lines,
    };
}
