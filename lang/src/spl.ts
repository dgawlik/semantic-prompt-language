import { compileCell, type CellLanguage, type CompiledCell } from './cell.js';
import { ALIAS, ALIAS_MESSAGE, checkTagInstruction, parseTagControls, scanSettings, type NaturalControls } from './controls.js';
import { SplSyntaxError } from './errors.js';
import { readFrontmatter, type Step, type Workflow } from './markdown.js';
import { parsePin, validatePinSource, type PinData } from './pin.js';

/** Blocks of a `.spl` workflow. `js`, `ts`, `agent` and `codegen` run; `comment` is commentary; `lock` holds a pinned journal. */
export const SPL_TAGS = ['js', 'ts', 'agent', 'codegen', 'comment', 'lock'] as const;
export type SplTag = typeof SPL_TAGS[number];

/** Control-flow lines between the blocks of a `.spl` workflow. */
export const SPL_KEYWORDS = ['if', 'elif', 'else', 'while'] as const;
export type SplKeyword = typeof SPL_KEYWORDS[number];

export interface SplBlock {
    tag: SplTag;
    /** 1-based position of the opening tag. */
    line: number;
    column: number;
    /** Line on which the opening tag ends; the body starts on the next one. */
    headerEndLine: number;
    /** Line of the closing tag, or the last line of an unterminated block. */
    endLine: number;
    closed: boolean;
    /** The body as written, without the tag lines. */
    text: string;
    /** Settings of an `{agent ...}` or `{codegen ...}` tag. */
    controls?: NaturalControls;
    /** `{js ignore}` and `{js no-run}`: shown but not run. */
    ignored?: true;
    /** `alias="name"` in the tag: the name `go()` continues at. */
    alias?: string;
}

export interface SplProblem {
    message: string;
    line: number;
    column: number;
}

/** An `if`, `elif`, `else` or `while` line. */
export interface SplControl {
    keyword: SplKeyword;
    line: number;
    /** 1-based column of the keyword. */
    column: number;
    /** Width of the indentation, with tabs advancing to the next multiple of four. */
    indent: number;
    /** The JavaScript condition as written; absent for `else`. */
    condition?: string;
    /** 1-based column where the condition starts. */
    conditionColumn?: number;
}

/** Blocks and control flow nested by indentation. */
export type SplNode =
    | { kind: 'block'; block: SplBlock }
    | { kind: 'if'; branches: { control: SplControl; body: SplNode[] }[] }
    | { kind: 'while'; control: SplControl; body: SplNode[] };

export interface SplDocument {
    model?: string;
    preamble?: string;
    blocks: SplBlock[];
    /** Control-flow lines in document order. */
    controls: SplControl[];
    /** Blocks and control flow as a tree; the body of a control line is everything indented further. */
    body: SplNode[];
    lock?: PinData;
    /** Everything wrong with the structure, in document order. A workflow with problems does not run. */
    problems: SplProblem[];
}

const OPENING = /^[ \t]*\{([A-Za-z][\w-]*)(?=[\s}]|$)/;
const CLOSING = /^[ \t]*\{\/([A-Za-z][\w-]*)\}[ \t]*$/;
const CONTROL = /^([ \t]*)(if|elif|else|while)(?![\w$])(.*)$/;
const LANGUAGES: Partial<Record<SplTag, CellLanguage>> = { js: 'js', ts: 'ts' };
const isTag = (name: string): name is SplTag => (SPL_TAGS as readonly string[]).includes(name);

function indentation(line: string): number {
    let width = 0;
    for (const char of /^[ \t]*/.exec(line)![0]) width = char === '\t' ? width + 4 - width % 4 : width + 1;
    return width;
}

/** Nests blocks under the control lines above them: a body is every following item indented further. */
function structure(items: { indent: number; node: SplNode | SplControl }[], problem: (message: string, line: number, column: number) => void): SplNode[] {
    let index = 0;
    const isControl = (value: SplNode | SplControl): value is SplControl => 'keyword' in value;
    const body = (control: SplControl): SplNode[] => {
        const nodes = suite(control.indent);
        if (!nodes.length) problem(`expected an indented block after '${control.keyword}'`, control.line, control.column);
        return nodes;
    };
    const suite = (parent: number): SplNode[] => {
        const nodes: SplNode[] = [];
        while (index < items.length && items[index].indent > parent) {
            const item = items[index++].node;
            if (!isControl(item)) {
                nodes.push(item);
                continue;
            }
            if (item.keyword === 'elif' || item.keyword === 'else') {
                problem(`'${item.keyword}' without a matching 'if'`, item.line, item.column);
                body(item);
                continue;
            }
            if (item.keyword === 'while') {
                nodes.push({ kind: 'while', control: item, body: body(item) });
                continue;
            }
            const branches = [{ control: item, body: body(item) }];
            while (index < items.length && branches.at(-1)!.control.keyword !== 'else') {
                const next = items[index].node;
                if (!isControl(next) || next.indent !== item.indent || next.keyword !== 'elif' && next.keyword !== 'else') break;
                index++;
                branches.push({ control: next, body: body(next) });
            }
            nodes.push({ kind: 'if', branches });
        }
        return nodes;
    };
    return suite(-1);
}

/** The text of an instruction or description: common indentation and surrounding blank lines removed. */
export function splInstruction(text: string): string {
    const lines = text.split('\n');
    const indent = Math.min(...lines.filter(line => line.trim()).map(line => line.length - line.trimStart().length));
    return lines.map(line => line.trim() ? line.slice(indent) : '').join('\n').trim();
}

/**
 * Reads the structure of a `.spl` workflow without compiling its code. Never throws on malformed
 * documents: problems are collected, and blocks are still found while the text is being typed.
 */
export function scanSpl(source: string): SplDocument {
    const text = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    const lines = text.split('\n');
    const offsets: number[] = [];
    for (let index = 0, offset = 0; index < lines.length; offset += lines[index++].length + 1) offsets.push(offset);
    const document: SplDocument = { blocks: [], controls: [], body: [], problems: [] };
    const items: { indent: number; node: SplNode | SplControl }[] = [];
    const problem = (message: string, line: number, column = 1): void => { document.problems.push({ message, line, column }); };
    const attempt = (action: () => void): boolean => {
        try {
            action();
            return true;
        } catch (error) {
            if (!(error instanceof SplSyntaxError)) throw error;
            problem(error.message, error.line, error.col);
            return false;
        }
    };

    let index = 0;
    if (lines[0] === '---') {
        const end = lines.findIndex((line, i) => i > 0 && /^(---|\.\.\.)\s*$/.test(line));
        index = end < 0 ? lines.length : end + 1;
        attempt(() => {
            const settings = readFrontmatter(lines, false);
            document.model = settings.model;
            document.preamble = settings.preamble;
        });
    }

    let stray = false;
    let journal: SplBlock | undefined;
    const aliases = new Map<string, number>();
    while (index < lines.length) {
        const line = lines[index];
        const number = index + 1;
        const opening = OPENING.exec(line);
        const tag = opening && isTag(opening[1]) ? opening[1] : undefined;
        if (!opening || !tag) {
            const column = line.length - line.trimStart().length + 1;
            const closing = CLOSING.exec(line);
            const control = !opening && !closing ? CONTROL.exec(line) : null;
            if (control) {
                const keyword = control[2] as SplKeyword;
                const item: SplControl = { keyword, line: number, column, indent: indentation(line) };
                const rest = control[3];
                const colon = /:[ \t]*$/.exec(rest);
                const condition = (colon ? rest.slice(0, colon.index) : rest).trim();
                const conditionColumn = column + keyword.length + rest.length - rest.trimStart().length;
                if (keyword === 'else') {
                    if (condition) problem("'else' takes no condition; use 'elif'", number, conditionColumn);
                    else if (!colon) problem("expected ':' after 'else'", number, column + keyword.length);
                } else {
                    // The condition is kept while it is typed, so the editor can complete it.
                    if (rest) {
                        item.condition = condition;
                        item.conditionColumn = conditionColumn;
                    }
                    if (!condition) problem(`expected a condition after '${keyword}'`, number, column + keyword.length);
                    else if (!colon) problem(`expected ':' at the end of the '${keyword}' line`, number, column + line.trimStart().trimEnd().length);
                }
                document.controls.push(item);
                items.push({ indent: item.indent, node: item });
                stray = false;
                index++;
                continue;
            }
            if (closing) problem(`{/${closing[1]}} does not close a block`, number, column);
            else if (opening) problem(`unknown block {${opening[1]}}; expected {js}, {ts}, {agent}, {codegen} or {comment}`, number, column);
            else if (line.trim() && !stray) problem('text outside a block; wrap commentary in {comment} and {/comment}', number, column);
            stray = Boolean(line.trim()) && !closing && !opening;
            index++;
            continue;
        }
        stray = false;
        const column = opening[0].indexOf('{') + 1;
        const start = offsets[index] + opening[0].length;
        const block: SplBlock = { tag, line: number, column, headerEndLine: number, endLine: number, closed: false, text: '' };
        let headerEnd = offsets[index] + line.length;
        let valid = true;
        if (tag === 'agent' || tag === 'codegen') {
            // A tag that is still being typed ends before the next closing tag rather than swallowing the document.
            let limit = index + 1;
            while (limit < lines.length && !CLOSING.test(lines[limit])) limit++;
            const header = text.slice(0, limit < lines.length ? offsets[limit] - 1 : text.length);
            valid = attempt(() => {
                const parsed = parseTagControls(header, 1, tag, start);
                headerEnd = parsed.end;
                if (parsed.controls) block.controls = parsed.controls;
                if (parsed.alias !== undefined) block.alias = parsed.alias;
            });
            if (!valid) headerEnd = scanSettings(header, start).end;
        } else {
            const after = line.slice(opening[0].length);
            const rest = (LANGUAGES[tag]
                ? /^(?:[ \t]+(ignore|no-run)|[ \t]+alias[ \t]*=[ \t]*(?:"([^"\n]*)"|'([^'\n]*)'))?[ \t]*\}/
                : /^[ \t]*\}/).exec(after);
            if (rest) {
                headerEnd = start + rest[0].length;
                if (rest[1]) block.ignored = true;
                const alias = rest[2] ?? rest[3];
                if (alias !== undefined) {
                    if (ALIAS.test(alias)) block.alias = alias;
                    else problem(`{${tag}}: ${ALIAS_MESSAGE}`, number, opening[0].length + rest[0].search(/["']/) + 1);
                }
            } else {
                valid = false;
                if (LANGUAGES[tag] && /[ \t](?:ignore|no-run)\b/.test(after) && /[ \t]alias\b/.test(after)) {
                    problem(`{${tag}}: a block marked ignore or no-run never runs, so it cannot have an alias`, number, column);
                } else {
                    problem(LANGUAGES[tag] ? `expected {${tag}}, {${tag} alias="name"}, {${tag} ignore} or {${tag} no-run}` : `expected {${tag}}`, number, column);
                }
            }
        }
        let headerIndex = index;
        while (headerIndex + 1 < lines.length && offsets[headerIndex + 1] < headerEnd) headerIndex++;
        block.headerEndLine = headerIndex + 1;
        const trailing = text.slice(headerEnd, offsets[headerIndex] + lines[headerIndex].length);
        if (valid && trailing.trim()) {
            problem(`expected a line break after the {${tag}} tag`, headerIndex + 1, headerEnd - offsets[headerIndex] + trailing.length - trailing.trimStart().length + 1);
        }

        let close = headerIndex + 1;
        while (close < lines.length && CLOSING.exec(lines[close])?.[1] !== tag) close++;
        block.closed = close < lines.length;
        if (!block.closed) {
            problem(`unterminated {${tag}} block; close it with {/${tag}}`, number, column);
            // Later blocks stay recognizable while this one is being typed.
            close = headerIndex + 1;
            while (close < lines.length && !isTag(OPENING.exec(lines[close])?.[1] ?? '')) close++;
        }
        block.endLine = block.closed ? close + 1 : Math.max(block.headerEndLine, close);
        block.text = lines.slice(headerIndex + 1, close).join('\n');
        document.blocks.push(block);
        items.push({ indent: indentation(line), node: { kind: 'block', block } });
        if (block.alias !== undefined) {
            const first = aliases.get(block.alias);
            if (first) problem(`duplicate alias '${block.alias}'; it is already used on line ${first}`, number, column);
            else aliases.set(block.alias, number);
        }

        if (tag === 'agent') attempt(() => checkTagInstruction(block.text, headerIndex + 2));
        else if (tag === 'codegen' && block.closed && !block.text.trim()) problem('{codegen}: description must not be empty', number, column);
        else if (tag === 'lock') {
            if (journal) problem('duplicate locked workflow journal', number, column);
            else if (attempt(() => { document.lock = parsePin(block.text, number); })) journal = block;
        }
        index = block.closed ? close + 1 : close;
    }
    if (journal && document.lock) {
        const { line, endLine } = journal;
        const lock = document.lock;
        attempt(() => validatePinSource(lock, [...lines.slice(0, line - 1), ...lines.slice(endLine)].join('\n'), line));
    }
    const structural: SplProblem[] = [];
    document.body = structure(items, (message, line, column) => { structural.push({ message, line, column }); });
    for (const item of structural) {
        const at = document.problems.findIndex(other => other.line > item.line || other.line === item.line && other.column > item.column);
        document.problems.splice(at < 0 ? document.problems.length : at, 0, item);
    }
    return document;
}

/** Compiles a condition at its document position, so syntax errors point into the control line. */
export function compileCondition(control: SplControl): CompiledCell {
    const column = control.conditionColumn!;
    const cell = compileCell(`${' '.repeat(column - 2)}(${control.condition})`, { line: control.line });
    if (cell.statements.length !== 1 || cell.statements[0] !== 'ExpressionStatement') {
        throw new SplSyntaxError(`expected a JavaScript expression after '${control.keyword}'`, control.line, column);
    }
    return cell;
}

function steps(nodes: readonly SplNode[]): Step[] {
    return nodes.flatMap((node): Step[] => {
        if (node.kind === 'if') {
            return [{
                kind: 'if', line: node.branches[0].control.line,
                branches: node.branches.map(({ control, body }) => ({
                    line: control.line, steps: steps(body),
                    ...(control.keyword === 'else' ? {} : { condition: compileCondition(control) }),
                })),
            }];
        }
        if (node.kind === 'while') {
            return [{ kind: 'while', line: node.control.line, condition: compileCondition(node.control), steps: steps(node.body) }];
        }
        const { block } = node;
        const alias = block.alias !== undefined ? { alias: block.alias } : {};
        const language = LANGUAGES[block.tag];
        if (language) {
            const line = block.headerEndLine + 1;
            return block.ignored ? [] : [{ kind: 'code', line, cell: compileCell(block.text, { language, line }), ...alias }];
        }
        if (block.tag !== 'agent' && block.tag !== 'codegen') return [];
        return [{
            kind: 'natural', text: splInstruction(block.text), line: block.line,
            ...(block.controls ? { controls: block.controls } : {}),
            ...(block.tag === 'codegen' ? { codegen: true as const } : {}),
            ...alias,
        }];
    });
}

/** Parses a `.spl` workflow. Every code block and condition is compiled first, so syntax errors surface before anything runs. */
export function parseSpl(source: string): Workflow {
    const document = scanSpl(source);
    const [problem] = document.problems;
    if (problem) throw new SplSyntaxError(problem.message, problem.line, problem.column);
    return {
        model: document.model,
        steps: steps(document.body),
        lines: source.split(/\r?\n/),
        markdown: { preamble: document.preamble, ...(document.lock ? { lock: document.lock } : {}) },
    };
}
