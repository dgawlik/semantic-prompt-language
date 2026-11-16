import * as path from 'node:path';
import * as vscode from 'vscode';
import { LanguageClient, TransportKind } from 'vscode-languageclient/node';
import { commandLine } from './commandLine';

const TERMINAL = 'SPL';
let client: LanguageClient | undefined;

/** Saves a workflow and runs it with the `spl` command line in the extension's terminal. */
async function run(debug: boolean, uri?: vscode.Uri): Promise<void> {
    const document = uri ? await vscode.workspace.openTextDocument(uri) : vscode.window.activeTextEditor?.document;
    if (document?.languageId !== 'spl') {
        void vscode.window.showWarningMessage('Open a .spl file to run it.');
        return;
    }
    if (document.uri.scheme !== 'file' || document.isDirty && !await document.save()) {
        void vscode.window.showWarningMessage('Save the workflow to a file before running it.');
        return;
    }
    const file = document.uri.fsPath;
    const terminal = vscode.window.terminals.find(item => item.name === TERMINAL && !item.exitStatus)
        ?? vscode.window.createTerminal({ name: TERMINAL, cwd: vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath ?? path.dirname(file) });
    terminal.show();
    terminal.sendText(commandLine(vscode.workspace.getConfiguration('spl').get('executablePath', 'spl'), file, debug));
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const outputChannel = vscode.window.createOutputChannel('SPL Language Server');
    context.subscriptions.push(
        outputChannel,
        vscode.commands.registerCommand('spl.run', (uri?: vscode.Uri) => run(false, uri)),
        vscode.commands.registerCommand('spl.debug', (uri?: vscode.Uri) => run(true, uri)),
    );
    // The server scans `.spl` files into TypeScript and answers from the TypeScript language service.
    client = new LanguageClient(
        'spl',
        'SPL Language Server',
        {
            module: context.asAbsolutePath('out/server.cjs'),
            transport: TransportKind.ipc,
        },
        {
            documentSelector: [{ language: 'spl', scheme: 'file' }, { language: 'spl', scheme: 'untitled' }],
            outputChannel,
        },
    );
    try {
        await client.start();
    } catch (error) {
        outputChannel.appendLine(`Failed to start SPL language server: ${String(error)}`);
        void vscode.window.showErrorMessage('SPL language server failed to start. See the SPL Language Server output.');
        throw error;
    }
}

export async function deactivate(): Promise<void> {
    await client?.stop();
    client = undefined;
}
