import { createConnection, ProposedFeatures, TextDocuments, TextDocumentSyncKind } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { analyze, completions, definition, documentSymbols, hover, type Analysis } from './features';
import {
    documentHighlights, foldingRanges, prepareRename, references, rename,
    semanticTokenLegend, semanticTokens, signatureHelp, workspaceSymbols,
} from './languageFeatures';

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);
const analyses = new Map<string, Analysis>();
let versionedEdits = false;

connection.onInitialize((params) => {
    versionedEdits = params.capabilities.workspace?.workspaceEdit?.documentChanges === true;
    return {
    capabilities: {
        textDocumentSync: TextDocumentSyncKind.Incremental,
        completionProvider: { triggerCharacters: ['(', ',', '$', '@', '.', '=', '{', '[', "'", '"'] },
        hoverProvider: true,
        definitionProvider: true,
        documentSymbolProvider: true,
        referencesProvider: true,
        documentHighlightProvider: true,
        renameProvider: { prepareProvider: true },
        signatureHelpProvider: { triggerCharacters: ['(', ','], retriggerCharacters: [')'] },
        foldingRangeProvider: true,
        semanticTokensProvider: { legend: semanticTokenLegend, full: true },
        workspaceSymbolProvider: true,
    },
    serverInfo: { name: 'SPL Language Server' },
    };
});

documents.onDidChangeContent(({ document }) => {
    try {
        const analysis = analyze(document);
        analyses.set(document.uri, analysis);
        connection.sendDiagnostics({ uri: document.uri, version: document.version, diagnostics: analysis.diagnostics });
    } catch (error) {
        analyses.delete(document.uri);
        connection.console.error(`Analysis failed for ${document.uri}: ${error instanceof Error ? error.stack : String(error)}`);
        connection.window.showErrorMessage(`SPL analysis failed for ${document.uri}. See the SPL Language Server output.`);
        connection.sendDiagnostics({ uri: document.uri, version: document.version, diagnostics: [] });
    }
});

documents.onDidClose(({ document }) => {
    analyses.delete(document.uri);
    connection.sendDiagnostics({ uri: document.uri, diagnostics: [] });
});

connection.onCompletion(({ textDocument, position }) => {
    const analysis = analyses.get(textDocument.uri);
    return analysis ? completions(analysis, position) : [];
});
connection.onHover(({ textDocument, position }) => {
    const analysis = analyses.get(textDocument.uri);
    return analysis ? hover(analysis, position) : null;
});
connection.onDefinition(({ textDocument, position }) => {
    const analysis = analyses.get(textDocument.uri);
    return analysis ? definition(analysis, position) : null;
});
connection.onDocumentSymbol(({ textDocument }) => {
    const analysis = analyses.get(textDocument.uri);
    return analysis ? documentSymbols(analysis) : [];
});
connection.onReferences(({ textDocument, position, context }) => {
    const analysis = analyses.get(textDocument.uri);
    return analysis ? references(analysis, position, context.includeDeclaration) : [];
});
connection.onDocumentHighlight(({ textDocument, position }) => {
    const analysis = analyses.get(textDocument.uri);
    return analysis ? documentHighlights(analysis, position) : [];
});
connection.onPrepareRename(({ textDocument, position }) => {
    const analysis = analyses.get(textDocument.uri);
    return analysis ? prepareRename(analysis, position) ?? null : null;
});
connection.onRenameRequest(({ textDocument, position, newName }) => {
    const analysis = analyses.get(textDocument.uri);
    if (!analysis) return null;
    const edit = rename(analysis, position, newName);
    if (versionedEdits) return edit;
    const change = edit.documentChanges?.[0];
    return change && 'textDocument' in change ? { changes: { [textDocument.uri]: change.edits } } : null;
});
connection.onSignatureHelp(({ textDocument, position }) => {
    const analysis = analyses.get(textDocument.uri);
    return analysis ? signatureHelp(analysis, position) ?? null : null;
});
connection.onFoldingRanges(({ textDocument }) => {
    const analysis = analyses.get(textDocument.uri);
    return analysis ? foldingRanges(analysis) : [];
});
connection.languages.semanticTokens.on(({ textDocument }) => {
    const analysis = analyses.get(textDocument.uri);
    return analysis ? semanticTokens(analysis) : { data: [] };
});
connection.onWorkspaceSymbol(({ query }) => workspaceSymbols(analyses.values(), query));

documents.listen(connection);
connection.listen();
