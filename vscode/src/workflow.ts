import type { Position, Range } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { DEFAULT_EXPORT, scan, sourceColumn, type BlockOutput, type Region, type Scan, type Span } from '../../lang/src/scanner.js';

/**
 * A `.spl` document and the TypeScript module the language service sees in its place. The module keeps
 * every construct on its line: code keeps its columns too, blocks map through the scanner's spans.
 * Positions are 0-based, as editors count; the scanner's lines and columns are 1-based.
 */
export class Workflow {
    readonly scan: Scan;
    readonly virtual: TextDocument;

    constructor(readonly uri: string, source: string) {
        this.scan = scan(source);
        this.virtual = TextDocument.create(uri, 'typescript', 0, `${this.scan.code}\n${DEFAULT_EXPORT}\n`);
    }

    get text(): string {
        return this.virtual.getText();
    }

    /** The block a line belongs to, fences included. */
    region(line: number): Region | undefined {
        return this.scan.regions.find(region => line + 1 >= region.line && line + 1 <= region.endLine);
    }

    /** What the block around a line declares; nothing when the scanner rejects the block. */
    outputs(line: number): BlockOutput[] {
        return this.scan.blocks.find(block => line + 1 >= block.line && line + 1 <= block.endLine)?.outputs ?? [];
    }

    /** The span of the scanner around a column of the source or of the module. */
    private span(line: number, character: number, side: 'column' | 'generatedColumn'): Span | undefined {
        return this.scan.spans.find(item => item.line === line + 1 && character + 1 >= item[side] && character + 1 <= item[side] + item.length);
    }

    /** The offset in the module a source position stands for, if it stands for code. */
    offset(position: Position): number | undefined {
        const { line, character } = position;
        if (this.scan.comments.some(comment => line + 1 >= comment.line && line + 1 <= comment.endLine)) return undefined;
        if (!this.region(line)) return this.virtual.offsetAt(position);
        const span = this.span(line, character, 'column');
        return span && this.virtual.offsetAt({ line, character: span.generatedColumn + character - span.column });
    }

    /** The source range a span of the module was generated from, if the source has that text. */
    range(start: number, length: number): Range | undefined {
        const from = this.virtual.positionAt(start);
        const { line } = from;
        if (line >= this.scan.lines.length) return undefined;
        const region = this.region(line);
        if (!region) return { start: from, end: this.virtual.positionAt(start + length) };
        const span = this.span(line, from.character, 'generatedColumn');
        if (span) {
            const character = sourceColumn(this.scan, line + 1, from.character + 1) - 1;
            return { start: { line, character }, end: { line, character: Math.min(character + length, span.column - 1 + span.length) } };
        }
        // Outputs are declared on the fences; the source names them where the instruction or the header does.
        const name = this.text.slice(start, start + length);
        const output = (line + 1 === region.line || line + 1 === region.endLine) && this.text[start - 1] !== '.'
            ? this.outputs(line).find(item => item.name === name) : undefined;
        return output && {
            start: { line: output.line - 1, character: output.column - 1 },
            end: { line: output.line - 1, character: output.column - 1 + name.length },
        };
    }

    /** Where to report a problem in generated code that has no counterpart in the source: on its source line. */
    lineRange(start: number): Range | undefined {
        const { line, character } = this.virtual.positionAt(start);
        const text = this.scan.lines[line];
        return text === undefined ? undefined
            : { start: { line, character: sourceColumn(this.scan, line + 1, character + 1) - 1 }, end: { line, character: text.trimEnd().length } };
    }
}
