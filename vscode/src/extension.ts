import * as vscode from 'vscode';
import { LanguageClient, TransportKind } from 'vscode-languageclient/node';
import { registerNotebooks } from './notebook';
import { registerCopilotContext } from './copilotContext';
import { registerNotebookLanguageFeatures } from './notebookLanguageFeatures';

let client: LanguageClient | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    registerNotebooks(context);
    const outputChannel = vscode.window.createOutputChannel('SPL Language Server');
    context.subscriptions.push(outputChannel);
    // Workflow Markdown and .spl files: JavaScript features inside fences and {js} blocks come from the
    // TypeScript language service running in the server; notebook cells use VS Code's own JavaScript support.
    client = new LanguageClient(
        'spl',
        'SPL Language Server',
        {
            module: context.asAbsolutePath('out/server.cjs'),
            transport: TransportKind.ipc,
        },
        {
            documentSelector: ['markdown', 'spl'].flatMap(language => [{ language, scheme: 'file' }, { language, scheme: 'untitled' }]),
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
    registerNotebookLanguageFeatures(context);
    await registerCopilotContext(context, outputChannel);
}

export async function deactivate(): Promise<void> {
    await client?.stop();
    client = undefined;
}
