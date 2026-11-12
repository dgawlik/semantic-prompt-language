import * as vscode from 'vscode';
import { InsertTextFormat } from 'vscode-languageserver/node';
import type { MarkdownBlock } from '../../lang/src/markdown.js';
import { controlCompletions } from './blockquoteFeatures';
import { callable, library, markers } from './catalog';
import { DEFAULT_FRONTMATTER, fenceLanguage, NOTEBOOK_TYPE } from './notebookFormat';
import { extractMarkdown } from '../../lang/src/markdown.js';
import { declaredNames } from './workflow';

function notebookOf(document: vscode.TextDocument): vscode.NotebookDocument | undefined {
    return vscode.workspace.notebookDocuments.find(notebook =>
        notebook.notebookType === NOTEBOOK_TYPE && notebook.getCells().some(cell =>
            cell.kind === vscode.NotebookCellKind.Code && cell.document === document));
}

/** Names declared by the code cells above an instruction cell, or saved by earlier instruction cells. */
function namesBefore(notebook: vscode.NotebookDocument, document: vscode.TextDocument): string[] {
    const blocks: MarkdownBlock[] = [];
    const saved = new Set<string>();
    for (const cell of notebook.getCells()) {
        if (cell.document === document) break;
        if (cell.kind !== vscode.NotebookCellKind.Code) continue;
        const language = fenceLanguage(cell.document.languageId);
        if (language) blocks.push({ kind: 'code', language, text: cell.document.getText(), line: 1, endLine: cell.document.lineCount });
        else {
            for (const match of cell.document.getText().matchAll(/(?:\bsave\b[^.!?;@]*\b(?:to|as|in)|->|\binto)\s*@([A-Za-z_$][\w$]*)|(?<![\w@\\])@([A-Za-z_$][\w$]*)\s*=(?!=)/gi)) {
                const name = match[1] ?? match[2];
                if (!Object.hasOwn(library, name) && !Object.hasOwn(markers, name.toLowerCase())) saved.add(name);
            }
        }
    }
    return [...new Set([...declaredNames(blocks), ...saved])];
}

function help(name: string): vscode.MarkdownString {
    return new vscode.MarkdownString(`\`${library[name].signature}\`\n\n${library[name].description}`);
}

/** Completions for an instruction cell: `@CTL` settings, shared names and markers. */
export function instructionCompletions(document: vscode.TextDocument, position: vscode.Position): vscode.CompletionItem[] {
    const notebook = notebookOf(document);
    if (!notebook) return [];
    const text = document.getText();
    const at = document.offsetAt(position);
    const range = (from: number, to: number) => new vscode.Range(document.positionAt(from), document.positionAt(to));
    let model: string | undefined;
    try {
        model = extractMarkdown((notebook.metadata.frontmatter ?? DEFAULT_FRONTMATTER) + '\n').model;
    } catch {
        model = undefined;
    }
    const controls = controlCompletions(text, at, (from, to) => ({ start: document.positionAt(from), end: document.positionAt(to) }), model);
    if (controls) {
        return controls.map(item => {
            const result = new vscode.CompletionItem(item.label, item.kind === undefined ? undefined : item.kind - 1);
            result.detail = item.detail;
            result.documentation = typeof item.documentation === 'string' ? item.documentation : item.documentation?.value;
            if (item.textEdit && 'range' in item.textEdit) {
                const { start, end } = item.textEdit.range;
                result.range = new vscode.Range(new vscode.Position(start.line, start.character), new vscode.Position(end.line, end.character));
                result.insertText = item.insertTextFormat === InsertTextFormat.Snippet
                    ? new vscode.SnippetString(item.textEdit.newText) : item.textEdit.newText;
            }
            return result;
        });
    }
    const reference = /(?<![\w@\\])@([A-Za-z_$][\w$]*)?$/.exec(text.slice(0, at));
    if (!reference) return [];
    const replace = range(at - (reference[1]?.length ?? 0), at);
    const items: vscode.CompletionItem[] = [];
    for (const name of namesBefore(notebook, document)) {
        const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Variable);
        item.detail = 'Shared binding';
        item.sortText = `0${name}`;
        item.range = replace;
        items.push(item);
    }
    const opening = !text.slice(0, reference.index).trim();
    for (const [name, marker] of Object.entries(markers)) {
        if ((name === 'ctl' || name === 'codegen') && !opening) continue;
        const item = new vscode.CompletionItem(marker.signature.slice(1).split(/[\s(['.]/)[0], vscode.CompletionItemKind.Keyword);
        item.detail = marker.signature;
        item.documentation = marker.description;
        item.sortText = `1${name}`;
        item.range = replace;
        item.insertText = new vscode.SnippetString(marker.insert);
        items.push(item);
    }
    for (const name of callable) {
        const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Function);
        item.detail = library[name].signature;
        item.documentation = library[name].description;
        item.sortText = `2${name}`;
        item.range = replace;
        items.push(item);
    }
    return items;
}

/** Library names for a code cell. VS Code's JavaScript support supplies everything else. */
export function libraryCompletions(document: vscode.TextDocument, position: vscode.Position): vscode.CompletionItem[] {
    if (!notebookOf(document)) return [];
    const line = document.lineAt(position.line).text.slice(0, position.character);
    const word = /(?<![\w$.])[A-Za-z_$][\w$]*$/.exec(line);
    if (!word && /[\w$.]$/.test(line)) return [];
    return Object.entries(library).map(([name, entry]) => {
        const item = new vscode.CompletionItem(name,
            entry.signature.includes('(') ? vscode.CompletionItemKind.Function : vscode.CompletionItemKind.Variable);
        item.detail = `${entry.signature} (SPL library)`;
        item.documentation = help(name);
        return item;
    });
}

export function libraryHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
    if (!notebookOf(document)) return undefined;
    const range = document.getWordRangeAtPosition(position, /[A-Za-z_$][\w$]*/);
    if (!range) return undefined;
    const name = document.getText(range);
    const before = document.lineAt(range.start.line).text.slice(0, range.start.character);
    if (!Object.hasOwn(library, name) || /\.\s*$/.test(before)) return undefined;
    return new vscode.Hover(help(name), range);
}

export function registerNotebookLanguageFeatures(context: Pick<vscode.ExtensionContext, 'subscriptions'>): void {
    const cell = (language: string) => ({ language, scheme: 'vscode-notebook-cell', notebookType: NOTEBOOK_TYPE });
    const code = [cell('javascript'), cell('typescript')];
    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider(cell('markdown'), { provideCompletionItems: instructionCompletions },
            '@', '(', ',', '=', '{', '[', "'", '"'),
        vscode.languages.registerCompletionItemProvider(code, { provideCompletionItems: libraryCompletions }),
        vscode.languages.registerHoverProvider(code, { provideHover: libraryHover }),
    );
}
