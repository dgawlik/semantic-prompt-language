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
}
export class Position {
    constructor(public line: number, public character: number) {}
}
export class Range {
    constructor(public start: Position, public end: Position) {}
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
    getText() { return this.value; }
    setText(value: string) { this.value = value; this.version++; }
    validatePosition(position: Position) {
        const lines = this.value.split('\n');
        const line = Math.min(position.line, lines.length - 1);
        return new Position(line, Math.min(position.character, lines[line].length));
    }
    lineAt(line: number) { return { range: new Range(new Position(line, 0), new Position(line, this.value.split('\n')[line].length)) }; }
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
};
export const diagnostics = new Map<string, Map<string, Diagnostic[]>>();
export const languages = {
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
export const window: {
    activeNotebookEditor?: { notebook: NotebookDocument };
    activeTextEditor?: { document: TextDocument };
    createOutputChannel: () => { appendLine: (text: string) => void; dispose: () => void };
    showErrorMessage: (text: string) => Promise<void>;
    showInformationMessage: (text: string) => Promise<void>;
} = {
    createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
    showErrorMessage: async text => { messages.push(text); },
    showInformationMessage: async text => { messages.push(text); },
};
export const registeredCommands = new Map<string, () => unknown>();
export const commands = {
    registerCommand(name: string, handler: () => unknown) {
        registeredCommands.set(name, handler);
        return new Disposable(() => { registeredCommands.delete(name); });
    },
    async executeCommand() {},
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
    diagnostics.clear();
    installedExtensions.clear();
}
