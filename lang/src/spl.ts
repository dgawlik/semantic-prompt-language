import { compileCell, type CellLanguage } from './cell.js';
import { checkTagInstruction, parseTagControls, scanSettings, type NaturalControls } from './controls.js';
import { SplSyntaxError } from './errors.js';
import { readFrontmatter, type CodeStep, type NaturalStep, type Workflow } from './markdown.js';
import { parsePin, validatePinSource, type PinData } from './pin.js';

/** Blocks of a `.spl` workflow. `js`, `ts`, `agent` and `codegen` run; `comment` is commentary; `lock` holds a pinned journal. */
export const SPL_TAGS = ['js', 'ts', 'agent', 'codegen', 'comment', 'lock'] as const;
export type SplTag = typeof SPL_TAGS[number];

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
}

export interface SplProblem {
    message: string;
    line: number;
    column: number;
}

export interface SplDocument {
    model?: string;
    preamble?: string;
    blocks: SplBlock[];
    lock?: PinData;
    /** Everything wrong with the structure, in document order. A workflow with problems does not run. */
    problems: SplProblem[];
}

const OPENING = /^[ \t]*\{([A-Za-z][\w-]*)(?=[\s}]|$)/;
const CLOSING = /^[ \t]*\{\/([A-Za-z][\w-]*)\}[ \t]*$/;
const LANGUAGES: Partial<Record<SplTag, CellLanguage>> = { js: 'js', ts: 'ts' };
const isTag = (name: string): name is SplTag => (SPL_TAGS as readonly string[]).includes(name);

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
    const document: SplDocument = { blocks: [], problems: [] };
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
    while (index < lines.length) {
        const line = lines[index];
        const number = index + 1;
        const opening = OPENING.exec(line);
        const tag = opening && isTag(opening[1]) ? opening[1] : undefined;
        if (!opening || !tag) {
            const column = line.length - line.trimStart().length + 1;
            const closing = CLOSING.exec(line);
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
            });
            if (!valid) headerEnd = scanSettings(header, start).end;
        } else {
            const rest = (LANGUAGES[tag] ? /^(?:[ \t]+(ignore|no-run))?[ \t]*\}/ : /^[ \t]*\}/).exec(line.slice(opening[0].length));
            if (rest) {
                headerEnd = start + rest[0].length;
                if (rest[1]) block.ignored = true;
            } else {
                valid = false;
                problem(LANGUAGES[tag] ? `expected {${tag}}, {${tag} ignore} or {${tag} no-run}` : `expected {${tag}}`, number, column);
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
    return document;
}

/** Parses a `.spl` workflow. Every code block is compiled first, so syntax errors surface before anything runs. */
export function parseSpl(source: string): Workflow {
    const document = scanSpl(source);
    const [problem] = document.problems;
    if (problem) throw new SplSyntaxError(problem.message, problem.line, problem.column);
    const steps: (CodeStep | NaturalStep)[] = [];
    for (const block of document.blocks) {
        const language = LANGUAGES[block.tag];
        if (language) {
            const line = block.headerEndLine + 1;
            if (!block.ignored) steps.push({ kind: 'code', line, cell: compileCell(block.text, { language, line }) });
        } else if (block.tag === 'agent' || block.tag === 'codegen') {
            steps.push({
                kind: 'natural', text: splInstruction(block.text), line: block.line,
                ...(block.controls ? { controls: block.controls } : {}),
                ...(block.tag === 'codegen' ? { codegen: true as const } : {}),
            });
        }
    }
    return {
        model: document.model,
        steps,
        lines: source.split(/\r?\n/),
        markdown: { preamble: document.preamble, ...(document.lock ? { lock: document.lock } : {}) },
    };
}
