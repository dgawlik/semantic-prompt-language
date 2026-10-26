import { createConnection, ProposedFeatures, TextDocuments, TextDocumentSyncKind } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { analyze, completions, definition, documentSymbols, hover, type Analysis } from './features';

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);
const analyses = new Map<string, Analysis>();

connection.onInitialize(() => ({
    capabilities: {
        textDocumentSync: TextDocumentSyncKind.Incremental,
        completionProvider: { triggerCharacters: ['(', '{', ',', '$', '@'] },
        hoverProvider: true,
        definitionProvider: true,
        documentSymbolProvider: true,
    },
    serverInfo: { name: 'SPL Language Server' },
}));

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

documents.listen(connection);
connection.listen();
