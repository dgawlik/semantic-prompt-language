import * as vscode from 'vscode';
import { LanguageClient, TransportKind } from 'vscode-languageclient/node';
import { extendMarkdownIt } from './markdownPreview';

let client: LanguageClient | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<{ extendMarkdownIt: typeof extendMarkdownIt }> {
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
            documentSelector: [{ language: 'markdown' }],
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
    return { extendMarkdownIt };
}

export async function deactivate(): Promise<void> {
    await client?.stop();
    client = undefined;
}
