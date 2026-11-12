import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    createConnection, ProposedFeatures, TextDocuments, TextDocumentSyncKind,
    type CompletionItem,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import {
    completions, definition, diagnostics, documentHighlights, documentSymbols, hover, prepareRename, references, rename,
    resolveCompletion, signatureHelp, workflowContext, type CompletionData, type WorkflowContext,
} from './languageFeatures';
import { defaultResources, TypeScriptProject } from './typescriptService';

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);
const resources = defaultResources(__dirname);
const projects = new Map<string, TypeScriptProject>();
const contexts = new Map<string, WorkflowContext>();
let folders: string[] = [];
let versionedEdits = false;

/** Imports resolve against the working directory: the workspace folder, as when running `spl` from its root. */
function baseDirectory(uri: string): string {
    if (!uri.startsWith('file:')) return folders[0] ?? process.cwd();
    const file = fileURLToPath(uri);
    const inside = folders.filter(folder => {
        const relative = path.relative(folder, file);
        return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
    }).sort((a, b) => b.length - a.length)[0];
    return inside ?? path.dirname(file);
}

function refresh(document: TextDocument): WorkflowContext | undefined {
    const base = baseDirectory(document.uri);
    let project = projects.get(base);
    if (!project) {
        project = new TypeScriptProject(base, resources);
        projects.set(base, project);
    }
    const context = workflowContext(document, project, contexts.get(document.uri));
    if (context) contexts.set(document.uri, context);
    else contexts.delete(document.uri);
    return context;
}

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

connection.onInitialize(params => {
    versionedEdits = params.capabilities.workspace?.workspaceEdit?.documentChanges === true;
    folders = (params.workspaceFolders ?? []).flatMap(folder => folder.uri.startsWith('file:') ? [fileURLToPath(folder.uri)] : []);
    if (!folders.length && params.rootUri?.startsWith('file:')) folders = [fileURLToPath(params.rootUri)];
    return {
        capabilities: {
            textDocumentSync: TextDocumentSyncKind.Incremental,
            completionProvider: { triggerCharacters: ['.', '"', "'", '`', '/', '@', '(', ',', '=', '{', '['], resolveProvider: true },
            hoverProvider: true,
            definitionProvider: true,
            documentSymbolProvider: true,
            referencesProvider: true,
            documentHighlightProvider: true,
            renameProvider: { prepareProvider: true },
            signatureHelpProvider: { triggerCharacters: ['(', ','], retriggerCharacters: [')'] },
        },
        serverInfo: { name: 'SPL Language Server' },
    };
});

documents.onDidChangeContent(({ document }) => {
    try {
        const context = refresh(document);
        connection.sendDiagnostics({ uri: document.uri, version: document.version, diagnostics: context ? diagnostics(context) : [] });
    } catch (error) {
        connection.console.error(`Analysis failed for ${document.uri}: ${error instanceof Error ? error.stack : String(error)}`);
        connection.sendDiagnostics({ uri: document.uri, version: document.version, diagnostics: [] });
    }
});

documents.onDidClose(({ document }) => {
    const context = contexts.get(document.uri);
    context?.project.remove(context.file);
    contexts.delete(document.uri);
    connection.sendDiagnostics({ uri: document.uri, diagnostics: [] });
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
connection.onDocumentSymbol(({ textDocument }) => guarded(textDocument.uri, [], workflow => documentSymbols(workflow)));
connection.onPrepareRename(({ textDocument, position }) => guarded(textDocument.uri, null, workflow => prepareRename(workflow, position)));
connection.onRenameRequest(({ textDocument, position, newName }) => guarded(textDocument.uri, null, workflow => {
    const edit = rename(workflow, position, newName);
    const edits = edit?.changes?.[textDocument.uri];
    if (!edit || !edits || !versionedEdits) return edit;
    return { documentChanges: [{ textDocument: { uri: textDocument.uri, version: workflow.analysis.document.version }, edits }] };
}));

documents.listen(connection);
connection.listen();
