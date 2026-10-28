import * as path from 'node:path';
import * as vscode from 'vscode';
import { SplSyntaxError } from '../../lang/src/errors.js';
import { isWorkflowMarkdown } from '../../lang/src/markdown.js';
import {
    decodeWorkflow, encodeWorkflow, parseWorkflowCell, NOTEBOOK_TYPE, DEFAULT_FRONTMATTER,
    type WorkflowCell,
} from './notebookFormat';
import { NotebookKernel } from './notebookKernel';

class WorkflowSerializer implements vscode.NotebookSerializer {
    deserializeNotebook(content: Uint8Array): vscode.NotebookData {
        const workflow = decodeWorkflow(Buffer.from(content).toString('utf8'));
        const data = new vscode.NotebookData(workflow.cells.map(cell => {
            const result = new vscode.NotebookCellData(
                cell.kind === 'markdown' ? vscode.NotebookCellKind.Markup : vscode.NotebookCellKind.Code,
                cell.value, cell.kind === 'spl' ? 'spl' : 'markdown',
            );
            result.metadata = cell;
            return result;
        }));
        data.metadata = {
            frontmatter: workflow.frontmatter, trailing: workflow.trailing,
            eol: workflow.eol, bom: workflow.bom,
        };
        return data;
    }

    serializeNotebook(data: vscode.NotebookData): Uint8Array {
        return Buffer.from(encodeWorkflow({
            frontmatter: data.metadata?.frontmatter ?? DEFAULT_FRONTMATTER,
            trailing: data.metadata?.trailing ?? '\n',
            eol: data.metadata?.eol ?? '\n',
            bom: data.metadata?.bom ?? '',
            cells: data.cells.map(cell => {
                if (cell.kind === vscode.NotebookCellKind.Code && !['spl', 'markdown'].includes(cell.languageId)) {
                    throw new Error(`Unsupported notebook cell language '${cell.languageId}'; use SPL or Markdown.`);
                }
                return {
                    ...cell.metadata,
                    kind: cell.kind === vscode.NotebookCellKind.Markup ? 'markdown'
                        : cell.languageId === 'spl' ? 'spl' : 'natural',
                    value: cell.value,
                } satisfies WorkflowCell;
            }),
        }), 'utf8');
    }
}

const LOG_MAX_LINES = 20;
const LOG_MAX_CHARACTERS = 4_000;
const LOG_TRUNCATION = '[Earlier logs omitted; full logs: Output > SPL Notebook]\n';

export class NotebookLogBuffer {
    private tail = '';
    private truncated = false;

    append(text: string): void {
        const combined = (this.tail ? this.tail + '\n' : '') + text.replace(/\r\n?/g, '\n');
        const lines = combined.split('\n');
        this.truncated ||= lines.length > LOG_MAX_LINES || combined.length > LOG_MAX_CHARACTERS;
        const prefix = this.truncated ? LOG_TRUNCATION : '';
        this.tail = lines.slice(-(LOG_MAX_LINES - (this.truncated ? 1 : 0))).join('\n')
            .slice(-(LOG_MAX_CHARACTERS - prefix.length));
        if (/^[\uDC00-\uDFFF]/.test(this.tail)) this.tail = this.tail.slice(1);
    }

    get text(): string {
        return (this.truncated ? LOG_TRUNCATION : '') + this.tail;
    }
}

interface Session {
    kernel: NotebookKernel;
    queue: Promise<void>;
    order: number;
}

export function registerNotebooks(context: Pick<vscode.ExtensionContext, 'subscriptions' | 'asAbsolutePath'>): void {
    const output = vscode.window.createOutputChannel('SPL Notebook');
    const syntaxDiagnostics = vscode.languages.createDiagnosticCollection('spl-notebook-syntax');
    const runtimeDiagnostics = vscode.languages.createDiagnosticCollection('spl-notebook-runtime');
    const sessions = new Map<vscode.NotebookDocument, Session>();
    const controller = vscode.notebooks.createNotebookController('spl-runtime', NOTEBOOK_TYPE, 'SPL Runtime');
    controller.supportedLanguages = ['spl', 'markdown'];
    controller.supportsExecutionOrder = true;
    controller.description = 'Shared variables and functions per notebook';
    let requestId = 0;

    const frontmatter = (notebook: vscode.NotebookDocument): string => notebook.metadata.frontmatter ?? DEFAULT_FRONTMATTER;
    const notebookFor = (document: vscode.TextDocument) => vscode.workspace.notebookDocuments.find(
        notebook => notebook.notebookType === NOTEBOOK_TYPE && notebook.getCells().some(cell => cell.document === document),
    );
    const clearDiagnostics = (notebook: vscode.NotebookDocument) => {
        for (const cell of notebook.getCells()) {
            syntaxDiagnostics.delete(cell.document.uri);
            runtimeDiagnostics.delete(cell.document.uri);
        }
    };
    const diagnostic = (document: vscode.TextDocument, message: string, line: number, column: number) => {
        const start = document.validatePosition(new vscode.Position(Math.max(0, line - 1), Math.max(0, column - 1)));
        const end = document.lineAt(start.line).range.end;
        const item = new vscode.Diagnostic(new vscode.Range(start, end), message, vscode.DiagnosticSeverity.Error);
        item.source = 'SPL Notebook';
        return item;
    };
    const validate = (notebook: vscode.NotebookDocument) => {
        if (notebook.notebookType !== NOTEBOOK_TYPE) return;
        for (const cell of notebook.getCells()) {
            if (cell.kind !== vscode.NotebookCellKind.Code) continue;
            try {
                parseWorkflowCell(cell.document.getText(), cell.document.languageId, frontmatter(notebook));
                syntaxDiagnostics.delete(cell.document.uri);
            } catch (error) {
                if (error instanceof SplSyntaxError && cell.document.languageId === 'spl' &&
                    !error.message.includes('frontmatter')) {
                    // The language server owns ordinary SPL parser diagnostics.
                    syntaxDiagnostics.delete(cell.document.uri);
                    continue;
                }
                if (!(error instanceof SplSyntaxError)) {
                    output.appendLine(`Notebook validation failed: ${String(error)}`);
                }
                syntaxDiagnostics.set(cell.document.uri, [diagnostic(
                    cell.document, error instanceof Error ? error.message : String(error),
                    error instanceof SplSyntaxError ? error.line : 1,
                    error instanceof SplSyntaxError ? error.col : 1,
                )]);
            }
        }
    };
    const reset = (notebook: vscode.NotebookDocument, reason?: string) => {
        sessions.get(notebook)?.kernel.dispose(reason);
        sessions.delete(notebook);
        clearDiagnostics(notebook);
    };

    controller.executeHandler = async (cells, notebook) => {
        if (!vscode.workspace.isTrusted) {
            void vscode.window.showErrorMessage('Trust this workspace using Manage Workspace Trust before running SPL cells. Workflows can execute tools and modify files.');
            return;
        }
        let session = sessions.get(notebook);
        if (!session || session.kernel.isStopped) {
            const folder = notebook.uri.scheme === 'file' ? path.dirname(notebook.uri.fsPath)
                : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
            session = {
                kernel: new NotebookKernel(
                    context.asAbsolutePath('out/notebookWorker.cjs'), folder,
                    vscode.workspace.getConfiguration('spl', notebook.uri).get<string>('notebook.nodePath', 'node'),
                    text => output.appendLine(text),
                ),
                queue: Promise.resolve(), order: 0,
            };
            sessions.set(notebook, session);
        }
        const current = session;
        const tasks: Promise<void>[] = [];
        for (const cell of cells) {
            if (cell.kind !== vscode.NotebookCellKind.Code) continue;
            const execution = controller.createNotebookCellExecution(cell);
            const cancel = execution.token.onCancellationRequested(() => {
                const reason = 'Execution cancelled. The notebook session was cleared; rerun prerequisite cells.';
                if (sessions.get(notebook) === current) reset(notebook, reason);
                else current.kernel.dispose(reason);
            });
            const runCell = async () => {
                let success = false;
                let outputQueue = Promise.resolve();
                const logs = new NotebookLogBuffer();
                let logOutput: vscode.NotebookCellOutput | undefined;
                let logUpdatePending = false;
                const log = (text: string, display = false) => {
                    output.appendLine(text);
                    if (display) {
                        outputQueue = outputQueue.then(async () => {
                            await execution.appendOutput(new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.stdout(text + '\n')]));
                        });
                    } else if (/^\[(?:info|warn|error)\] /.test(text) && !text.startsWith('[info] reasoning:')) {
                        logs.append(text);
                        if (logUpdatePending) return;
                        logUpdatePending = true;
                        outputQueue = outputQueue.then(async () => {
                            logUpdatePending = false;
                            const items = [vscode.NotebookCellOutputItem.text(logs.text)];
                            if (logOutput) {
                                await execution.replaceOutputItems(items, logOutput);
                            } else {
                                logOutput = new vscode.NotebookCellOutput(items);
                                await execution.appendOutput(logOutput);
                            }
                        });
                    }
                };
                const started = Date.now();
                try {
                    execution.start(started);
                    execution.executionOrder = ++current.order;
                    await execution.clearOutput();
                    log(`[info] Running ${cell.document.languageId === 'spl' ? 'SPL' : 'instruction'} cell`);
                    if (cell.document.isClosed || notebook.isClosed) throw new Error('The cell or notebook was closed before execution.');
                    runtimeDiagnostics.delete(cell.document.uri);
                    const version = cell.document.version;
                    const result = await current.kernel.execute({
                        id: ++requestId, value: cell.document.getText(), language: cell.document.languageId,
                        frontmatter: frontmatter(notebook), source: cell.document.uri.toString(),
                        version,
                    }, log);
                    if (result.kind === 'error') {
                        const origin = notebook.getCells().find(item => item.document.uri.toString() === result.source)?.document;
                        if (origin && result.version === origin.version) {
                            runtimeDiagnostics.set(origin.uri, [diagnostic(origin, result.message, result.line, result.column)]);
                        }
                        throw new Error(`${result.message}\n${result.source}:${result.line}:${result.column}`);
                    }
                    log(`[info] Cell completed (${Date.now() - started} ms)`);
                    await outputQueue;
                    if (result.text !== undefined) {
                        await execution.appendOutput(new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.text(result.text)]));
                    }
                    success = true;
                } catch (error) {
                    const failure = error instanceof Error ? error : new Error(String(error));
                    log(`[error] Cell failed: ${failure.message}`);
                    await outputQueue.catch(outputError => {
                        output.appendLine(`Could not update cell output: ${String(outputError)}`);
                    });
                    await execution.appendOutput(new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.error(failure)]));
                } finally {
                    cancel.dispose();
                    execution.end(success, Date.now());
                }
            };
            current.queue = current.queue.then(runCell, runCell);
            tasks.push(current.queue);
        }
        await Promise.all(tasks);
    };

    context.subscriptions.push(
        output, syntaxDiagnostics, runtimeDiagnostics, controller,
        vscode.workspace.registerNotebookSerializer(NOTEBOOK_TYPE, new WorkflowSerializer(), { transientOutputs: true }),
        vscode.commands.registerCommand('spl.openNotebook', async () => {
            const uri = vscode.window.activeTextEditor?.document.uri;
            if (!uri) {
                void vscode.window.showErrorMessage('Open an SPL workflow Markdown file first.');
                return;
            }
            const document = await vscode.workspace.openTextDocument(uri);
            if (!isWorkflowMarkdown(document.getText())) {
                void vscode.window.showErrorMessage('SPL notebooks require workflow frontmatter: extension: semantic-prompt-language and version: 1.');
                return;
            }
            await vscode.commands.executeCommand('vscode.openWith', uri, NOTEBOOK_TYPE);
        }),
        vscode.commands.registerCommand('spl.resetNotebook', () => {
            const notebook = vscode.window.activeNotebookEditor?.notebook;
            if (notebook?.notebookType !== NOTEBOOK_TYPE) {
                void vscode.window.showErrorMessage('Open an SPL notebook before resetting its session.');
                return;
            }
            reset(notebook);
            validate(notebook);
            void vscode.window.showInformationMessage('SPL notebook session cleared. Rerun cells to rebuild state; existing outputs are from the previous session.');
        }),
        vscode.workspace.onDidOpenNotebookDocument(notebook => validate(notebook)),
        vscode.workspace.onDidCloseNotebookDocument(notebook => reset(notebook)),
        vscode.workspace.onDidChangeNotebookDocument(event => {
            for (const change of event.contentChanges) {
                for (const cell of change.removedCells) {
                    syntaxDiagnostics.delete(cell.document.uri);
                    runtimeDiagnostics.delete(cell.document.uri);
                }
            }
            validate(event.notebook);
        }),
        vscode.workspace.onDidChangeTextDocument(event => {
            const notebook = notebookFor(event.document);
            if (!notebook) return;
            runtimeDiagnostics.delete(event.document.uri);
            validate(notebook);
        }),
        new vscode.Disposable(() => {
            for (const session of sessions.values()) session.kernel.dispose('SPL extension deactivated.');
            sessions.clear();
        }),
    );
    for (const notebook of vscode.workspace.notebookDocuments) validate(notebook);
}
