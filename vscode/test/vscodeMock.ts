import * as path from 'node:path';

export class Disposable {
    constructor(private readonly callback: () => void = () => {}) {}
    dispose() { this.callback(); }
}
class Emitter<T> {
    private listeners = new Set<(value: T) => void>();
    event = (listener: (value: T) => void) => {
        this.listeners.add(listener);
        return new Disposable(() => this.listeners.delete(listener));
    };
    fire(value: T) { for (const listener of this.listeners) listener(value); }
    dispose() { this.listeners.clear(); }
}
export class Position {
    constructor(public line: number, public character: number) {}
}
export class Range {
    constructor(public start: Position, public end: Position) {}
}
export class SnippetString {
    constructor(public value: string) {}
}
export class MarkdownString {
    constructor(public value: string) {}
}
export const CompletionItemKind = { Function: 2, Variable: 5, Property: 9, Value: 11, Keyword: 13 };
export class CompletionItem {
    detail?: string;
    documentation?: string | MarkdownString;
    sortText?: string;
    range?: Range;
    insertText?: string | SnippetString;
    constructor(public label: string, public kind?: number) {}
}
export class Hover {
    constructor(public contents: MarkdownString, public range?: Range) {}
}
export class Diagnostic {
    source?: string;
    constructor(public range: Range, public message: string, public severity: number) {}
}
export const DiagnosticSeverity = { Error: 0 };
export const NotebookCellKind = { Markup: 1, Code: 2 };
export class NotebookCellData {
    metadata: Record<string, unknown> = {};
    constructor(public kind: number, public value: string, public languageId: string) {}
}
export class NotebookData {
    metadata: Record<string, unknown> = {};
    constructor(public cells: NotebookCellData[]) {}
}
export class NotebookCellOutput {
    constructor(public items: { text?: string; error?: Error; mime: string }[]) {}
}
export const NotebookCellOutputItem = {
    text: (text: string) => ({ text, mime: 'text/plain' }),
    stdout: (text: string) => ({ text, mime: 'application/vnd.code.notebook.stdout' }),
    error: (error: Error) => ({ error, mime: 'application/vnd.code.notebook.error' }),
};
export class Uri {
    constructor(public scheme: string, public fsPath: string) {}
    toString() { return `${this.scheme}:${this.fsPath}`; }
}
export class TextDocument {
    version = 1;
    isClosed = false;
    constructor(public uri: Uri, public languageId: string, private value: string) {}
    get lineCount() { return this.value.split('\n').length; }
    getText(range?: Range) {
        return range ? this.value.slice(this.offsetAt(range.start), this.offsetAt(range.end)) : this.value;
    }
    setText(value: string) { this.value = value; this.version++; }
    offsetAt(position: Position) {
        return this.value.split('\n').slice(0, position.line).reduce((offset, line) => offset + line.length + 1, 0) + position.character;
    }
    positionAt(offset: number) {
        const lines = this.value.slice(0, offset).split('\n');
        return new Position(lines.length - 1, lines[lines.length - 1].length);
    }
    validatePosition(position: Position) {
        const lines = this.value.split('\n');
        const line = Math.min(position.line, lines.length - 1);
        return new Position(line, Math.min(position.character, lines[line].length));
    }
    lineAt(line: number) {
        const text = this.value.split('\n')[line];
        return { text, range: new Range(new Position(line, 0), new Position(line, text.length)) };
    }
    getWordRangeAtPosition(position: Position, pattern: RegExp) {
        for (const match of this.lineAt(position.line).text.matchAll(new RegExp(pattern.source, 'g'))) {
            const end = match.index + match[0].length;
            if (match.index <= position.character && position.character <= end) {
                return new Range(new Position(position.line, match.index), new Position(position.line, end));
            }
        }
        return undefined;
    }
}
export class NotebookDocument {
    isClosed = false;
    notebookType = 'spl-workflow';
    metadata: Record<string, unknown>;
    private cells: { kind: number; document: TextDocument }[];
    constructor(public uri: Uri, data: NotebookData) {
        this.metadata = data.metadata;
        this.cells = data.cells.map((cell, index) => ({
            kind: cell.kind, document: new TextDocument(new Uri('vscode-notebook-cell', `${uri.fsPath}#${index}`), cell.languageId, cell.value),
        }));
    }
    getCells() { return this.cells; }
    removeCell(cell: Cell) { this.cells = this.cells.filter(item => item !== cell); }
}
type Cell = ReturnType<NotebookDocument['getCells']>[number];
class Execution {
    outputs: NotebookCellOutput[] = [];
    executionOrder?: number;
    started = false;
    ended = false;
    success?: boolean;
    private cancellation = new Emitter<void>();
    token = { onCancellationRequested: this.cancellation.event };
    constructor(public cell: Cell) {}
    start() { this.started = true; }
    end(success: boolean) { this.ended = true; this.success = success; }
    async clearOutput() { this.outputs = []; }
    async appendOutput(output: NotebookCellOutput) { this.outputs.push(output); }
    async replaceOutputItems(items: NotebookCellOutput['items'], output: NotebookCellOutput) {
        if (!this.outputs.includes(output)) throw new Error('Notebook output does not exist');
        output.items = items;
    }
    cancel() { this.cancellation.fire(); }
}
export const executions: Execution[] = [];
export const controllers: {
    supportedLanguages?: string[]; supportsExecutionOrder?: boolean; description?: string;
    executeHandler: (cells: Cell[], notebook: NotebookDocument) => Promise<void>;
    createNotebookCellExecution: (cell: Cell) => Execution;
    dispose: () => void;
}[] = [];
export const notebooks = {
    createNotebookController() {
        const controller = {
            executeHandler: async (_cells: Cell[], _notebook: NotebookDocument) => {},
            createNotebookCellExecution(cell: Cell) {
                const execution = new Execution(cell);
                executions.push(execution);
                return execution;
            },
            dispose() {},
        };
        controllers.push(controller);
        return controller;
    },
};
const opened = new Emitter<NotebookDocument>();
const closed = new Emitter<NotebookDocument>();
const changed = new Emitter<{ notebook: NotebookDocument; contentChanges: { removedCells: Cell[] }[] }>();
const textChanged = new Emitter<{ document: TextDocument }>();
export const serializers: { value: {
    deserializeNotebook: (content: Uint8Array) => NotebookData;
    serializeNotebook: (data: NotebookData) => Uint8Array;
}; options: { transientOutputs: boolean } }[] = [];
export const workspace = {
    notebookDocuments: [] as NotebookDocument[],
    workspaceFolders: undefined,
    isTrusted: true,
    getConfiguration: () => ({ get: () => process.execPath }),
    registerNotebookSerializer(_type: string, value: typeof serializers[number]['value'], options: typeof serializers[number]['options']) {
        serializers.push({ value, options });
        return new Disposable();
    },
    onDidOpenNotebookDocument: opened.event,
    onDidCloseNotebookDocument: closed.event,
    onDidChangeNotebookDocument: changed.event,
    onDidChangeTextDocument: textChanged.event,
    open(notebook: NotebookDocument) { this.notebookDocuments.push(notebook); opened.fire(notebook); },
    close(notebook: NotebookDocument) {
        notebook.isClosed = true;
        this.notebookDocuments = this.notebookDocuments.filter(item => item !== notebook);
        closed.fire(notebook);
    },
    changeText(document: TextDocument, value: string) { document.setText(value); textChanged.fire({ document }); },
    removeCell(notebook: NotebookDocument, cell: Cell) {
        notebook.removeCell(cell);
        changed.fire({ notebook, contentChanges: [{ removedCells: [cell] }] });
    },
    async openTextDocument(uri: Uri) {
        const document = window.activeTextEditor?.document;
        if (document?.uri !== uri) throw new Error(`Cannot open ${uri}`);
        return document;
    },
};
export const diagnostics = new Map<string, Map<string, Diagnostic[]>>();
export const completionProviders: { selector: unknown; triggers: string[]; provider: {
    provideCompletionItems(document: TextDocument, position: Position): CompletionItem[];
} }[] = [];
export const hoverProviders: { selector: unknown; provider: {
    provideHover(document: TextDocument, position: Position): Hover | undefined;
} }[] = [];
export const languages = {
    registerCompletionItemProvider(selector: unknown, provider: typeof completionProviders[number]['provider'], ...triggers: string[]) {
        const entry = { selector, provider, triggers };
        completionProviders.push(entry);
        return new Disposable(() => completionProviders.splice(completionProviders.indexOf(entry), 1));
    },
    registerHoverProvider(selector: unknown, provider: typeof hoverProviders[number]['provider']) {
        const entry = { selector, provider };
        hoverProviders.push(entry);
        return new Disposable(() => hoverProviders.splice(hoverProviders.indexOf(entry), 1));
    },
    createDiagnosticCollection(name: string) {
        const items = new Map<string, Diagnostic[]>();
        diagnostics.set(name, items);
        return {
            set: (uri: Uri, values: Diagnostic[]) => items.set(uri.toString(), values),
            delete: (uri: Uri) => items.delete(uri.toString()),
            dispose: () => items.clear(),
        };
    },
};
export const messages: string[] = [];
export const outputLines: string[] = [];
export const window: {
    activeNotebookEditor?: { notebook: NotebookDocument };
    activeTextEditor?: { document: TextDocument };
    createOutputChannel: () => { appendLine: (text: string) => void; dispose: () => void };
    showErrorMessage: (text: string) => Promise<void>;
    showInformationMessage: (text: string) => Promise<void>;
} = {
    createOutputChannel: () => ({ appendLine(text) { outputLines.push(text); }, dispose() {} }),
    showErrorMessage: async text => { messages.push(text); },
    showInformationMessage: async text => { messages.push(text); },
};
export const registeredCommands = new Map<string, () => unknown>();
export const executedCommands: unknown[][] = [];
export const commands = {
    registerCommand(name: string, handler: () => unknown) {
        registeredCommands.set(name, handler);
        return new Disposable(() => { registeredCommands.delete(name); });
    },
    async executeCommand(...command: unknown[]) { executedCommands.push(command); },
};
export const installedExtensions = new Map<string, { activate(): Promise<unknown> }>();
export const extensions = {
    getExtension: (id: string) => installedExtensions.get(id),
};
export function context() {
    return {
        subscriptions: [] as Disposable[],
        asAbsolutePath: (relative: string) => path.resolve(__dirname, '..', '..', relative),
    };
}
export function reset() {
    workspace.notebookDocuments = [];
    workspace.isTrusted = true;
    window.activeNotebookEditor = undefined;
    window.activeTextEditor = undefined;
    executions.length = 0;
    controllers.length = 0;
    serializers.length = 0;
    messages.length = 0;
    outputLines.length = 0;
    diagnostics.clear();
    installedExtensions.clear();
    completionProviders.length = 0;
    hoverProviders.length = 0;
    executedCommands.length = 0;
}
