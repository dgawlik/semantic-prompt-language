import { DiagnosticSeverity, type Diagnostic, type Position, type Range } from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import { compileCell, FENCE_LANGUAGES, type CellLanguage } from '../../lang/src/cell.js';
import { parseNatural } from '../../lang/src/controls.js';
import { SplSyntaxError } from '../../lang/src/errors.js';
import { extractMarkdown, isWorkflowMarkdown, type MarkdownBlock } from '../../lang/src/markdown.js';
import { blockquoteText, scanCodegen, scanControls } from './blockquoteFeatures';
import { library, markers } from './catalog';

/** A `@name` in a blockquote. */
export interface Marker {
    name: string;
    /** Position of the name, after the `@`. */
    line: number;
    character: number;
    /** The blockquote it belongs to. */
    block: MarkdownBlock;
    /** `@validate[Schema]` naming the type of the value saved to this marker. */
    schema?: string;
    /** The instruction saves a value to this name. */
    output: boolean;
}

/** A name an agent may define, declared for the type checker after the document text. */
export interface AmbientName {
    name: string;
    schema?: string;
    marker: Marker;
    /** Offset of the name inside the virtual text. */
    offset: number;
}

export interface WorkflowAnalysis {
    document: TextDocument;
    /** The document opted in with SPL frontmatter. */
    workflow: boolean;
    model?: string;
    blocks: MarkdownBlock[];
    markers: Marker[];
    /** Names agents may save that no fence declares. */
    ambient: AmbientName[];
    /** Workflow, control and JavaScript syntax problems. TypeScript adds its own for `ts` fences. */
    diagnostics: Diagnostic[];
    /** `ts` when any fence is TypeScript: the whole document is then checked as one TypeScript module. */
    language: CellLanguage;
    /** The document with everything except fence code blanked, followed by generated declarations. */
    virtual: string;
    /** Length of the part of `virtual` that mirrors the document. */
    mirrored: number;
}

const MARKER = /(?<![\w@\\])@([A-Za-z_]\w*)/g;

function range(line: number, character: number, length = 1): Range {
    return { start: { line, character }, end: { line, character: character + length } };
}

function problem(error: SplSyntaxError, document: TextDocument): Diagnostic {
    const line = Math.min(Math.max(0, error.line - 1), document.lineCount - 1);
    const text = document.getText({ start: { line, character: 0 }, end: { line: line + 1, character: 0 } }).replace(/\r?\n$/, '');
    const character = Math.min(Math.max(0, error.col - 1), text.length);
    const word = /^[\w$@]+/.exec(text.slice(character))?.[0].length ?? 1;
    return { range: range(line, character, Math.max(1, word)), severity: DiagnosticSeverity.Error, source: 'spl', message: error.message };
}

/**
 * Finds fences and blockquotes while the document is being typed and does not parse as a
 * whole: an unterminated fence runs to the end, and frontmatter problems do not hide the body.
 */
function scanBlocks(lines: string[]): MarkdownBlock[] {
    const blocks: MarkdownBlock[] = [];
    let start = 0;
    if (lines[0] === '---') {
        const end = lines.findIndex((line, index) => index > 0 && /^(---|\.\.\.)\s*$/.test(line));
        start = end < 0 ? lines.length : end + 1;
    }
    for (let index = start; index < lines.length; index++) {
        const fence = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\s`]*)([^\n]*)$/.exec(lines[index]);
        if (fence) {
            const closing = new RegExp(`^ {0,3}${fence[1][0]}{${fence[1].length},}\\s*$`);
            let end = index + 1;
            while (end < lines.length && !closing.test(lines[end])) end++;
            const info = fence[2].toLowerCase();
            const language = Object.hasOwn(FENCE_LANGUAGES, info) ? FENCE_LANGUAGES[info] : undefined;
            if (language && !/(?:^|\s)(?:ignore|no-run)(?:\s|$)/i.test(fence[3])) {
                blocks.push({ kind: 'code', language, text: lines.slice(index + 1, end).join('\n'), line: index + 2, endLine: end });
            }
            index = end;
        } else if (/^ {0,3}>/.test(lines[index])) {
            let end = index;
            while (end + 1 < lines.length && /^ {0,3}>/.test(lines[end + 1])) end++;
            blocks.push({
                kind: 'natural', line: index + 1, endLine: end + 1,
                text: lines.slice(index, end + 1).map(line => line.replace(/^ {0,3}>[ \t]?/, '')).join('\n'),
            });
            index = end;
        }
    }
    return blocks;
}

export function codeBlockAt(analysis: WorkflowAnalysis, position: Position): MarkdownBlock | undefined {
    return analysis.blocks.find(block => block.kind === 'code' && position.line + 1 >= block.line && position.line + 1 <= block.endLine);
}

export function blockquoteAt(analysis: WorkflowAnalysis, position: Position): MarkdownBlock | undefined {
    return analysis.blocks.find(block => block.kind === 'natural' && position.line + 1 >= block.line && position.line + 1 <= block.endLine);
}

/** Top-level names declared by fences, as far as they can be read from possibly incomplete code. */
export function declaredNames(blocks: readonly MarkdownBlock[]): Set<string> {
    const names = new Set<string>();
    for (const block of blocks) {
        if (block.kind !== 'code') continue;
        try {
            if (block.language === 'js') {
                for (const declaration of compileCell(block.text).declarations) names.add(declaration.name);
                continue;
            }
        } catch (error) {
            if (!(error instanceof SplSyntaxError)) throw error;
        }
        for (const match of block.text.matchAll(/^(?:export\s+)?(?:async\s+)?(?:const|let|var|function\*?|class)\s+([A-Za-z_$][\w$]*)/gm)) names.add(match[1]);
        for (const match of block.text.matchAll(/^import\s+(?:([A-Za-z_$][\w$]*)\s*,?\s*)?(?:\*\s+as\s+([A-Za-z_$][\w$]*)|\{([^}]*)\})?\s*from\b/gm)) {
            for (const name of [match[1], match[2], ...(match[3] ?? '').split(',').map(item => item.trim().split(/\s+as\s+/).at(-1))]) {
                if (name) names.add(name);
            }
        }
    }
    return names;
}

export function analyzeWorkflow(document: TextDocument): WorkflowAnalysis {
    const source = document.getText();
    const lines = source.replace(/^\uFEFF/, '').split(/\r?\n/);
    const empty: WorkflowAnalysis = {
        document, workflow: false, blocks: [], markers: [], ambient: [], diagnostics: [], language: 'js', virtual: '', mirrored: 0,
    };
    if (!isWorkflowMarkdown(source)) return empty;
    const diagnostics: Diagnostic[] = [];
    let blocks: MarkdownBlock[];
    let model: string | undefined;
    try {
        const extracted = extractMarkdown(source);
        blocks = extracted.blocks;
        model = extracted.model;
    } catch (error) {
        if (!(error instanceof SplSyntaxError)) throw error;
        diagnostics.push(problem(error, document));
        blocks = scanBlocks(lines);
    }
    const language: CellLanguage = blocks.some(block => block.language === 'ts') ? 'ts' : 'js';
    const masked = lines.map(line => ' '.repeat(line.length));
    for (const block of blocks) {
        if (block.kind !== 'code') continue;
        for (let line = block.line; line <= block.endLine; line++) masked[line - 1] = lines[line - 1];
        // TypeScript reports its own syntax errors; JavaScript is checked exactly as the runtime compiles it.
        if (block.language !== 'js') continue;
        try {
            compileCell(block.text, { line: block.line });
        } catch (error) {
            if (!(error instanceof SplSyntaxError)) throw error;
            diagnostics.push(problem(error, document));
        }
    }

    const markerList: Marker[] = [];
    for (const block of blocks) {
        if (block.kind !== 'natural') continue;
        try {
            parseNatural(block.text, block.line);
        } catch (error) {
            if (!(error instanceof SplSyntaxError)) throw error;
            diagnostics.push(problem(error, document));
        }
        const quote = blockquoteText(document, block);
        if (scanCodegen(quote.text)) continue;
        const controls = scanControls(quote.text);
        const text = controls ? quote.text.slice(0, controls.end).replace(/[^\r\n]/g, ' ') + quote.text.slice(controls.end) : quote.text;
        const found: (Marker & { at: number })[] = [];
        const schemas: { name: string; at: number }[] = [];
        for (const match of text.matchAll(MARKER)) {
            const position = document.positionAt(quote.from + match.index + 1);
            found.push({ name: match[1], line: position.line, character: position.character, block, output: false, at: match.index });
            const schema = /^@validate[ \t]*\[[ \t]*([A-Za-z_$][\w$]*)[ \t]*\]/i.exec(text.slice(match.index));
            if (schema) schemas.push({ name: schema[1], at: match.index });
        }
        for (const marker of found) {
            const before = text.slice(0, marker.at);
            const after = text.slice(marker.at + marker.name.length + 1);
            marker.output = /(?:\bsave\b[^.!?;@]*\b(?:to|as|in)|->|\binto)\s*$/i.test(before) || /^\s*=(?!=)/.test(after);
        }
        // `@validate[Type]` describes the value saved next, or the one saved just before it.
        const outputs = found.filter(marker => marker.output);
        for (const schema of schemas) {
            const target = outputs.find(marker => marker.at > schema.at) ?? outputs.findLast(marker => marker.at < schema.at);
            if (target) target.schema ??= schema.name;
        }
        for (const { at: _at, ...marker } of found) markerList.push(marker);
    }

    // Agents can save any variable; declaring the referenced ones lets later fences use them with types.
    const declared = declaredNames(blocks);
    const ambient: AmbientName[] = [];
    let virtual = masked.join('\n');
    const mirrored = virtual.length;
    virtual += '\nexport {};\n';
    for (const marker of markerList) {
        const lower = marker.name.toLowerCase();
        if (declared.has(marker.name) || Object.hasOwn(library, marker.name) || Object.hasOwn(markers, lower)) continue;
        const known = ambient.find(item => item.name === marker.name);
        if (known) {
            if (marker.output && !known.marker.output) known.marker = marker;
            if (!known.schema && marker.schema) known.schema = marker.schema;
            continue;
        }
        ambient.push({ name: marker.name, schema: marker.schema, marker, offset: 0 });
    }
    for (const item of ambient) {
        const type = item.schema && declared.has(item.schema) ? `import('spl-lang').Infer<typeof ${item.schema}>` : 'any';
        virtual += 'declare let ';
        item.offset = virtual.length;
        virtual += `${item.name}: ${type};\n`;
    }
    return { document, workflow: true, model, blocks, markers: markerList, ambient, diagnostics, language, virtual, mirrored };
}
