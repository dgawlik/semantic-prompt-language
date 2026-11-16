import { fileURLToPath } from 'node:url';
import {
    createConnection, ProposedFeatures, TextDocuments, TextDocumentSyncKind,
    type CompletionItem,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import {
    completions, definition, diagnostics, documentHighlights, documentSymbols, foldingRanges, hover, prepareRename, references, rename,
    resolveCompletion, signatureHelp, workflowContext, type CompletionData, type WorkflowContext,
} from './languageFeatures';
import { defaultResources, TypeScriptProject } from './typescriptService';

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);
const contexts = new Map<string, WorkflowContext>();
let project: TypeScriptProject;

/** Runs a feature and keeps the server alive when TypeScript or the analysis throws. */
function guarded<T>(uri: string, fallback: T, feature: (context: WorkflowContext) => T): T {
    const context = contexts.get(uri);
    if (!context) return fallback;
    try {
        return feature(context);
    } catch (error) {
        connection.console.error(`Request failed for ${uri}: ${error instanceof Error ? error.stack : String(error)}`);
        return fallback;
    }
}

/** Reports every open document again: a change in one workflow shows in the files that import it. */
function publish(): void {
    for (const document of documents.all()) {
        connection.sendDiagnostics({ uri: document.uri, version: document.version, diagnostics: guarded(document.uri, [], diagnostics) });
    }
}

connection.onInitialize(params => {
    const folder = params.workspaceFolders?.find(item => item.uri.startsWith('file:'))?.uri ?? params.rootUri;
    project = new TypeScriptProject(folder?.startsWith('file:') ? fileURLToPath(folder) : process.cwd(), defaultResources(__dirname));
    return {
        capabilities: {
            textDocumentSync: TextDocumentSyncKind.Incremental,
            completionProvider: { triggerCharacters: ['.', '"', "'", '`', '/', '@', '<', '#', ' ', '['], resolveProvider: true },
            hoverProvider: true,
            definitionProvider: true,
            documentSymbolProvider: true,
            referencesProvider: true,
            documentHighlightProvider: true,
            foldingRangeProvider: true,
            renameProvider: { prepareProvider: true },
            signatureHelpProvider: { triggerCharacters: ['(', ','], retriggerCharacters: [')'] },
        },
        serverInfo: { name: 'SPL Language Server' },
    };
});

documents.onDidChangeContent(({ document }) => {
    try {
        contexts.set(document.uri, workflowContext(project, document.uri, document.getText()));
    } catch (error) {
        contexts.delete(document.uri);
        connection.console.error(`Analysis failed for ${document.uri}: ${error instanceof Error ? error.stack : String(error)}`);
    }
    publish();
});

documents.onDidClose(({ document }) => {
    project.close(document.uri);
    contexts.delete(document.uri);
    connection.sendDiagnostics({ uri: document.uri, diagnostics: [] });
    publish();
});

connection.onCompletion(({ textDocument, position, context }) =>
    guarded(textDocument.uri, [] as CompletionItem[], workflow => completions(workflow, position, context)));
connection.onCompletionResolve(item => {
    const uri = (item.data as CompletionData | undefined)?.uri;
    return uri ? guarded(uri, item, workflow => resolveCompletion(workflow, item)) : item;
});
connection.onHover(({ textDocument, position }) => guarded(textDocument.uri, null, workflow => hover(workflow, position)));
connection.onSignatureHelp(({ textDocument, position }) => guarded(textDocument.uri, null, workflow => signatureHelp(workflow, position)));
connection.onDefinition(({ textDocument, position }) => guarded(textDocument.uri, [], workflow => definition(workflow, position)));
connection.onReferences(({ textDocument, position }) => guarded(textDocument.uri, [], workflow => references(workflow, position)));
connection.onDocumentHighlight(({ textDocument, position }) => guarded(textDocument.uri, [], workflow => documentHighlights(workflow, position)));
connection.onDocumentSymbol(({ textDocument }) => guarded(textDocument.uri, [], documentSymbols));
connection.onFoldingRanges(({ textDocument }) => guarded(textDocument.uri, [], foldingRanges));
connection.onPrepareRename(({ textDocument, position }) => guarded(textDocument.uri, null, workflow => prepareRename(workflow, position)));
connection.onRenameRequest(({ textDocument, position, newName }) => guarded(textDocument.uri, null, workflow => rename(workflow, position, newName)));

documents.listen(connection);
connection.listen();
