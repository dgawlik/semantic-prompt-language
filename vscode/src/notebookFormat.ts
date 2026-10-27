import { SplSyntaxError } from '../../lang/src/errors.js';
import { extractMarkdown } from '../../lang/src/markdown.js';
import { parse } from '../../lang/src/parser.js';
import type { Program } from '../../lang/src/ast.js';

export const NOTEBOOK_TYPE = 'spl-workflow';
export const DEFAULT_FRONTMATTER = '---\nextension: semantic-prompt-language\nversion: 1\n---';

export interface WorkflowCell {
    kind: 'markdown' | 'spl' | 'natural';
    value: string;
    leading?: string;
    raw?: string;
    originalValue?: string;
    originalKind?: WorkflowCell['kind'];
}

export interface WorkflowNotebook {
    frontmatter: string;
    cells: WorkflowCell[];
    trailing: string;
    eol: string;
    bom: string;
}

export function decodeWorkflow(source: string): WorkflowNotebook {
    const bom = source.startsWith('\uFEFF') ? '\uFEFF' : '';
    const eol = source.includes('\r\n') ? '\r\n' : '\n';
    const normalized = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    const document = extractMarkdown(normalized);
    const lines = normalized.split('\n');
    const headerEnd = lines.findIndex((line, index) => index > 0 && /^(---|\.\.\.)\s*$/.test(line));
    const frontmatter = lines.slice(0, headerEnd + 1).join('\n');
    const offsets: number[] = [];
    let offset = 0;
    for (const line of lines) {
        offsets.push(offset);
        offset += line.length + 1;
    }
    const cells: WorkflowCell[] = [];
    let cursor = frontmatter.length;
    for (const block of document.blocks) {
        const start = offsets[block.kind === 'spl' ? block.line - 2 : block.line - 1];
        let end = offsets[block.kind === 'spl' ? block.endLine + 1 : block.endLine] ?? normalized.length;
        if (normalized[end - 1] === '\n') end--;
        const gap = normalized.slice(cursor, start);
        if (gap.trim()) cells.push({ kind: 'markdown', value: gap });
        const raw = normalized.slice(start, end);
        const kind = block.kind;
        const value = kind === 'spl' ? block.text : raw;
        cells.push({
            kind, value, leading: gap.trim() ? '' : gap,
            raw, originalValue: value, originalKind: kind,
        });
        cursor = end;
    }
    let trailing = normalized.slice(cursor);
    if (trailing.trim()) {
        cells.push({ kind: 'markdown', value: trailing });
        trailing = '';
    }
    return { frontmatter, cells, trailing, eol, bom };
}

function quote(value: string): string {
    return /^\s*>/.test(value) ? value : value.split('\n').map(line => `> ${line}`).join('\n');
}

export function encodeWorkflow(notebook: WorkflowNotebook): string {
    extractMarkdown(notebook.frontmatter + '\n');
    let source = notebook.frontmatter;
    for (const cell of notebook.cells) {
        if (cell.kind === 'markdown') {
            source += cell.value.startsWith('\n') ? cell.value : `\n\n${cell.value}`;
            continue;
        }
        const leading = cell.leading ?? '\n\n';
        if (!source.endsWith('\n') && !leading.startsWith('\n')) source += '\n\n';
        source += leading;
        if (cell.raw !== undefined && cell.value === cell.originalValue && cell.kind === cell.originalKind) {
            source += cell.raw;
        } else if (cell.kind === 'natural') {
            source += quote(cell.value);
        } else {
            const length = Math.max(3, ...[...cell.value.matchAll(/`+/g)].map(match => match[0].length + 1));
            const fence = '`'.repeat(length);
            source += `${fence}spl\n${cell.value}${cell.value.endsWith('\n') ? '' : '\n'}${fence}`;
        }
    }
    source += notebook.trailing;
    extractMarkdown(source);
    return notebook.bom + source.replace(/\r\n?/g, '\n').replace(/\n/g, notebook.eol);
}

export function parseWorkflowCell(value: string, language: string, frontmatter: string): Program {
    const metadata = extractMarkdown(frontmatter + '\n');
    let program: Program;
    if (language === 'spl') {
        program = parse(value);
        if (program.directives.model !== undefined) {
            throw new SplSyntaxError('set the document model in frontmatter, not an SPL header', 1, 1);
        }
    } else if (language === 'markdown') {
        const quoted = quote(value);
        const source = frontmatter + '\n\n' + quoted;
        const blocks = extractMarkdown(source).blocks;
        if (blocks.length !== 1 || blocks[0].kind !== 'natural') {
            throw new SplSyntaxError('a natural-language cell must contain one blockquote', 1, 1);
        }
        const lines = source.split('\n');
        if (lines.slice(frontmatter.split('\n').length, blocks[0].line - 1).join('\n').trim() ||
            lines.slice(blocks[0].endLine).join('\n').trim()) {
            throw new SplSyntaxError('a natural-language cell cannot contain text outside its blockquote', 1, 1);
        }
        program = { body: [{ t: 'natural', text: blocks[0].text, line: 1 }], directives: {}, lines: value.split('\n') };
    } else {
        throw new Error(`unsupported workflow cell language '${language}'; use SPL or Markdown`);
    }
    program.directives = { model: metadata.model };
    program.markdown = { preamble: metadata.preamble };
    return program;
}
