import { Lexer } from 'marked';
import { isMap, parseDocument } from 'yaml';
import type { Program } from './ast.js';
import { SplSyntaxError } from './errors.js';
import { parse } from './parser.js';

export const EXTENSION = 'semantic-prompt-language';

export interface MarkdownBlock {
    kind: 'spl' | 'natural';
    text: string;
    line: number;
    endLine: number;
}

export interface MarkdownDocument {
    model?: string;
    preamble?: string;
    blocks: MarkdownBlock[];
    /** Same positions as the document, with everything except SPL code blanked. */
    code: string;
}

export function isWorkflowMarkdown(source: string): boolean {
    const frontmatter = /^---\n([\s\S]*?)\n(?:---|\.\.\.)[ \t]*(?:\n|$)/.exec(
        source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n'),
    );
    if (!frontmatter) return false;
    const document = parseDocument(frontmatter[1]);
    return isMap(document.contents) && document.get('extension') === EXTENSION;
}

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
    let cursor = 0;
    for (const token of Lexer.lex(body)) {
        const start = body.indexOf(token.raw, cursor);
        if (start < 0) throw new SplSyntaxError('cannot locate Markdown block', end + 2, 1);
        cursor = start + token.raw.length;
        const line = end + 2 + body.slice(0, start).split('\n').length - 1;
        if (token.type === 'code' && token.lang === 'spl') {
            const rawLines = token.raw.trimEnd().split('\n');
            const fence = /^ {0,3}(`{3,}|~{3,})spl\s*$/.exec(rawLines[0]);
            if (!fence) continue;
            const closing = new RegExp(`^ {0,3}${fence[1][0]}{${fence[1].length},}\\s*$`);
            if (rawLines.length < 2 || !closing.test(rawLines.at(-1)!)) {
                throw new SplSyntaxError('unterminated SPL fence', line, 1);
            }
            const text = rawLines.slice(1, -1).join('\n');
            rawLines.slice(1, -1).forEach((text, i) => { masked[line + i] = text; });
            blocks.push({ kind: 'spl', text, line: line + 1, endLine: line + rawLines.length - 2 });
        } else if (token.type === 'blockquote') {
            blocks.push({
                kind: 'natural', text: token.text,
                line, endLine: line + token.raw.trimEnd().split('\n').length - 1,
            });
        }
    }
    return { model, preamble, blocks, code: masked.join('\n') };
}

export function parseMarkdown(source: string): Program {
    const document = extractMarkdown(source);
    const program: Program = {
        directives: { model: document.model },
        body: [], lines: source.split(/\r?\n/),
        markdown: { preamble: document.preamble },
    };
    for (const block of document.blocks) {
        if (block.kind === 'natural') {
            program.body.push({ t: 'natural', text: block.text, line: block.line });
        } else {
            const parsed = parse('\n'.repeat(block.line - 1) + block.text);
            if (parsed.directives.model !== undefined) {
                throw new SplSyntaxError('set the document model in frontmatter, not an SPL header', block.line, 1);
            }
            program.body.push(...parsed.body);
        }
    }
    return program;
}
