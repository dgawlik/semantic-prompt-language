import { Lexer } from 'marked';
import { isMap, parseDocument } from 'yaml';
import { FENCE_LANGUAGES, compileCell, type CellLanguage, type CompiledCell } from './cell.js';
import { parseNatural, type NaturalBlock } from './controls.js';
import { SplSyntaxError } from './errors.js';
import { parsePin, validatePinSource, type PinData } from './pin.js';

export const EXTENSION = 'semantic-prompt-language';

export interface MarkdownBlock {
    kind: 'code' | 'natural';
    /** Fence language; absent for blockquotes. */
    language?: CellLanguage;
    text: string;
    line: number;
    endLine: number;
}

export interface MarkdownDocument {
    model?: string;
    preamble?: string;
    blocks: MarkdownBlock[];
    lock?: PinData;
    /** Same positions as the document, with everything except executable code blanked. */
    code: string;
}

export interface CodeStep {
    kind: 'code';
    cell: CompiledCell;
    line: number;
}

export type NaturalStep = NaturalBlock & { kind: 'natural' };

/** A parsed, runnable document: fences and blockquotes in order. */
export interface Workflow {
    model?: string;
    steps: (CodeStep | NaturalStep)[];
    /** Source lines, for failure reports. */
    lines: string[];
    /** Present for Markdown documents; plain code has no preamble or lock. */
    markdown?: { preamble?: string; lock?: PinData };
}

export function isWorkflowMarkdown(source: string): boolean {
    const frontmatter = /^---\n([\s\S]*?)\n(?:---|\.\.\.)[ \t]*(?:\n|$)/.exec(
        source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n'),
    );
    if (!frontmatter) return false;
    const document = parseDocument(frontmatter[1]);
    return isMap(document.contents) && document.get('extension') === EXTENSION;
}

/** Splits a workflow into frontmatter settings, executable fences and blockquotes without compiling them. */
export function extractMarkdown(source: string): MarkdownDocument {
    const normalized = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    const lines = normalized.split('\n');
    if (lines[0] !== '---') throw new SplSyntaxError('Markdown workflows require YAML frontmatter', 1, 1);
    const end = lines.findIndex((line, i) => i > 0 && /^(---|\.\.\.)\s*$/.test(line));
    if (end < 0) throw new SplSyntaxError('unterminated YAML frontmatter', 1, 1);
    const yaml = parseDocument(lines.slice(1, end).join('\n'), { uniqueKeys: true });
    if (yaml.errors.length || yaml.warnings.length) {
        const error = yaml.errors[0] ?? yaml.warnings[0];
        throw new SplSyntaxError(`invalid frontmatter: ${error.message}`, 2, 1);
    }
    let metadata: unknown;
    try {
        metadata = yaml.toJS({ maxAliasCount: 0 });
    } catch (error) {
        if (!(error instanceof Error)) throw error;
        throw new SplSyntaxError(`invalid frontmatter: ${error.message}`, 2, 1);
    }
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
        throw new SplSyntaxError('frontmatter must be a mapping', 2, 1);
    }
    if (!('extension' in metadata) || metadata.extension !== EXTENSION) {
        throw new SplSyntaxError(`frontmatter requires extension: ${EXTENSION}`, 2, 1);
    }
    if (!('version' in metadata) || metadata.version !== 1) {
        throw new SplSyntaxError('frontmatter requires version: 1', 2, 1);
    }
    for (const key of Object.keys(metadata)) {
        if (!['extension', 'version', 'model', 'preamble'].includes(key)) {
            throw new SplSyntaxError(`unknown frontmatter field '${key}'`, 2, 1);
        }
    }
    const model = 'model' in metadata ? metadata.model : undefined;
    const preamble = 'preamble' in metadata ? metadata.preamble : undefined;
    if (model !== undefined && (typeof model !== 'string' || !model.trim())) {
        throw new SplSyntaxError('frontmatter model must be a non-empty string', 2, 1);
    }
    if (preamble !== undefined && typeof preamble !== 'string') {
        throw new SplSyntaxError('frontmatter preamble must be a string', 2, 1);
    }
    const masked = lines.map((line) => ' '.repeat(line.length));
    const body = lines.slice(end + 1).join('\n');
    const blocks: MarkdownBlock[] = [];
    let lock: PinData | undefined;
    let lockSource: string | undefined;
    let lockLine = 1;
    let cursor = 0;
    for (const token of Lexer.lex(body)) {
        const start = body.indexOf(token.raw, cursor);
        if (start < 0) throw new SplSyntaxError('cannot locate Markdown block', end + 2, 1);
        cursor = start + token.raw.length;
        const line = end + 2 + body.slice(0, start).split('\n').length - 1;
        if (token.type === 'code' && token.lang === 'spl-lock') {
            throw new SplSyntaxError('locked workflow journals require a double blockquote', line, 1);
        }
        if (token.type === 'code' && typeof token.lang === 'string' && token.lang) {
            const rawLines = token.raw.trimEnd().split('\n');
            const fence = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\s`]+)([^\n]*)$/.exec(rawLines[0]);
            if (!fence) continue;
            const info = fence[2].toLowerCase();
            if (/(?:^|\s)(?:ignore|no-run)(?:\s|$)/i.test(fence[3])) continue;
            if (info === 'spl') {
                throw new SplSyntaxError('spl fences are no longer supported: write the step in a js fence, where ask, agent, restrict and the rest of the library are already imported', line, 1);
            }
            const language = Object.hasOwn(FENCE_LANGUAGES, info) ? FENCE_LANGUAGES[info] : undefined;
            if (!language) continue;
            const closing = new RegExp(`^ {0,3}${fence[1][0]}{${fence[1].length},}\\s*$`);
            if (rawLines.length < 2 || !closing.test(rawLines.at(-1)!)) {
                throw new SplSyntaxError(`unterminated ${info} fence`, line, 1);
            }
            const text = rawLines.slice(1, -1).join('\n');
            rawLines.slice(1, -1).forEach((text, i) => { masked[line + i] = text; });
            blocks.push({ kind: 'code', language, text, line: line + 1, endLine: line + rawLines.length - 2 });
        } else if (token.type === 'blockquote') {
            const outer = (token.tokens ?? []).filter(item => item.type !== 'space');
            const inner = outer.length === 1 && outer[0].type === 'blockquote'
                ? (outer[0].tokens ?? []).filter(item => item.type !== 'space') : [];
            if (inner.length === 1 && inner[0].type === 'code' && inner[0].lang === 'spl-lock') {
                if (lock) throw new SplSyntaxError('duplicate locked workflow journal', line, 1);
                if (!/^```spl-lock[ \t]*\n[\s\S]*\n```[ \t]*$/.test(inner[0].raw.trimEnd())) {
                    throw new SplSyntaxError('invalid or unterminated locked workflow journal fence', line, 1);
                }
                lock = parsePin(inner[0].text, line);
                const offset = lines.slice(0, end + 1).join('\n').length + 1 + start;
                lockSource = normalized.slice(0, offset) + normalized.slice(offset + token.raw.length);
                lockLine = line;
                continue;
            }
            if (/(?:^|\n) {0,3}(?:>[ \t]*)*[`~]{3,}spl-lock\b/.test(token.raw)) {
                throw new SplSyntaxError('invalid locked workflow double blockquote', line, 1);
            }
            blocks.push({
                kind: 'natural', text: token.text,
                line, endLine: line + token.raw.trimEnd().split('\n').length - 1,
            });
        }
    }
    if (lock) validatePinSource(lock, lockSource!, lockLine);
    return { model, preamble, blocks, code: masked.join('\n'), ...(lock ? { lock } : {}) };
}

/** Parses a Markdown workflow. Every fence is compiled first, so syntax errors surface before anything runs. */
export function parseMarkdown(source: string): Workflow {
    const document = extractMarkdown(source);
    return {
        model: document.model,
        steps: document.blocks.map(block => block.kind === 'natural'
            ? { kind: 'natural', ...parseNatural(block.text, block.line) }
            : { kind: 'code', line: block.line, cell: compileCell(block.text, { language: block.language, line: block.line }) }),
        lines: source.split(/\r?\n/),
        markdown: { preamble: document.preamble, ...(document.lock ? { lock: document.lock } : {}) },
    };
}

/** Parses plain JavaScript (or erasable TypeScript) as a one-step workflow, for scripts and interactive cells. */
export function parse(source: string, options: { language?: CellLanguage; model?: string } = {}): Workflow {
    return {
        model: options.model,
        steps: [{ kind: 'code', line: 1, cell: compileCell(source, { language: options.language }) }],
        lines: source.split(/\r?\n/),
    };
}

/** Parses the text of one blockquote (without `>` markers) as a one-step workflow. */
export function parseInstruction(text: string, options: { model?: string; preamble?: string } = {}): Workflow {
    return {
        model: options.model,
        steps: [{ kind: 'natural', ...parseNatural(text, 1) }],
        lines: text.split(/\r?\n/),
        markdown: { preamble: options.preamble },
    };
}
