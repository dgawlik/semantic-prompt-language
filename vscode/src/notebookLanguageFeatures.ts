import * as vscode from 'vscode';
import { InsertTextFormat } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { analyze, completions } from './features';
import { semanticTokenLegend, semanticTokens } from './languageFeatures';
import { DEFAULT_FRONTMATTER, encodeWorkflow, NOTEBOOK_TYPE, type WorkflowCell } from './notebookFormat';

function instructionAnalysis(document: vscode.TextDocument) {
    const notebook = vscode.workspace.notebookDocuments.find(notebook =>
        notebook.notebookType === NOTEBOOK_TYPE && notebook.getCells().some(cell =>
            cell.kind === vscode.NotebookCellKind.Code && cell.document === document && document.languageId === 'markdown'));
    if (!notebook) return undefined;
    const cells: WorkflowCell[] = [];
    for (const cell of notebook.getCells()) {
        if (cell.kind === vscode.NotebookCellKind.Code && ['spl', 'markdown'].includes(cell.document.languageId)) {
            cells.push({ kind: cell.document.languageId === 'spl' ? 'spl' : 'natural', value: cell.document.getText() });
        }
        if (cell.document === document) break;
    }
    const source = encodeWorkflow({
        frontmatter: notebook.metadata.frontmatter ?? DEFAULT_FRONTMATTER,
        cells, trailing: '\n', eol: '\n', bom: '',
    });
    const analysis = analyze(TextDocument.create(document.uri.toString(), 'markdown', document.version, source));
    const block = analysis.blocks?.at(-1);
    if (block?.kind !== 'natural') return undefined;
    return { analysis, line: block.line - 1 };
}

export function notebookSemanticTokens(document: vscode.TextDocument): vscode.SemanticTokens | undefined {
    const context = instructionAnalysis(document);
    if (!context) return undefined;
    const data = semanticTokens(context.analysis).data;
    const builder = new vscode.SemanticTokensBuilder();
    let line = 0;
    let character = 0;
    for (let i = 0; i < data.length; i += 5) {
        line += data[i];
        character = data[i] === 0 ? character + data[i + 1] : data[i + 1];
        if (line >= context.line && character >= 2) {
            builder.push(line - context.line, character - 2, data[i + 2], data[i + 3], data[i + 4]);
        }
    }
    return builder.build();
}

export function registerNotebookLanguageFeatures(context: Pick<vscode.ExtensionContext, 'subscriptions'>): void {
    const selector = { language: 'markdown', scheme: 'vscode-notebook-cell', notebookType: NOTEBOOK_TYPE };
    const changed = new vscode.EventEmitter<void>();
    context.subscriptions.push(
        changed,
        vscode.workspace.onDidChangeTextDocument(({ document }) => {
            if (document.uri.scheme === 'vscode-notebook-cell') changed.fire();
        }),
        vscode.workspace.onDidChangeNotebookDocument(({ notebook }) => {
            if (notebook.notebookType === NOTEBOOK_TYPE) changed.fire();
        }),
        vscode.languages.registerDocumentSemanticTokensProvider(selector, {
            onDidChangeSemanticTokens: changed.event,
            provideDocumentSemanticTokens: notebookSemanticTokens,
        }, new vscode.SemanticTokensLegend(semanticTokenLegend.tokenTypes, semanticTokenLegend.tokenModifiers)),
        vscode.languages.registerCompletionItemProvider(selector, {
            provideCompletionItems(document, position) {
                const context = instructionAnalysis(document);
                if (!context) return [];
                return completions(context.analysis, { line: context.line + position.line, character: position.character + 2 })
                    .map(item => {
                        const result = new vscode.CompletionItem(item.label, item.kind === undefined ? undefined : item.kind - 1);
                        result.detail = item.detail;
                        result.documentation = typeof item.documentation === 'string' ? item.documentation :
                            item.documentation?.kind === 'markdown' ? new vscode.MarkdownString(item.documentation.value) :
                                item.documentation?.value;
                        result.filterText = item.filterText;
                        result.sortText = item.sortText;
                        if (item.textEdit && 'range' in item.textEdit) {
                            const { start, end } = item.textEdit.range;
                            result.range = new vscode.Range(
                                new vscode.Position(start.line - context.line, start.character - 2),
                                new vscode.Position(end.line - context.line, end.character - 2),
                            );
                            result.insertText = item.insertTextFormat === InsertTextFormat.Snippet
                                ? new vscode.SnippetString(item.textEdit.newText) : item.textEdit.newText;
                        }
                        return result;
                    });
            },
        }, '@', '(', ',', '=', '{', '[', "'", '"'),
    );
}
