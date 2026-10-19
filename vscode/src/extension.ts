import * as vscode from 'vscode';
import { LanguageClient, TransportKind } from 'vscode-languageclient/node';

let client: LanguageClient | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const outputChannel = vscode.window.createOutputChannel('SPL Language Server');
    context.subscriptions.push(outputChannel);
    client = new LanguageClient(
        'spl',
        'SPL Language Server',
        {
            module: context.asAbsolutePath('out/server.cjs'),
            transport: TransportKind.ipc,
        },
        {
            documentSelector: [{ language: 'spl' }],
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
