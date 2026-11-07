import * as vscode from 'vscode';
import { keywords } from './catalog';
import { NOTEBOOK_TYPE } from './notebookFormat';

interface Trait {
    name: string;
    value: string;
    importance: number;
}

export interface CopilotContextProvider {
    id: string;
    selector: vscode.DocumentSelector;
    resolver: {
        resolve(
            request: { documentContext: { uri: string; languageId: string } },
            token: Pick<vscode.CancellationToken, 'isCancellationRequested'>,
        ): Promise<Trait[]>;
    };
}

interface CopilotApi {
    getContextProviderAPI?(version: 'v1'): {
        registerContextProvider(provider: CopilotContextProvider): vscode.Disposable;
    };
}

interface CopilotExports extends CopilotApi {
    getAPI?(version: 1): CopilotApi;
}

const syntax = [
    'This is Semantic Prompt Language (language id: spl), not Python or Splunk SPL.',
    'Complete native SPL code only. Blocks use a colon followed by a newline and a space-indented body, like Python. Never use brace-delimited blocks.',
    'Declare variables with let name = expression. Reassign existing variables with name = expression.',
    'Functions use def name(args):. Branches use if condition:, elif condition:, and else: with indented bodies.',
    'Loops use for item in items: or while condition:. Catch failures with try: and except err:. Use pass for empty bodies.',
    'Use four spaces per indentation level, not tabs. Braces are only for dictionaries and string interpolation. Anonymous blocks use a bare colon and an indented body.',
    'Use True, False, None, and/or/not, # comments, and {name} interpolation inside strings.',
    'Use log(value), not print(value). Use success value to end the workflow successfully.',
    'Do not generate Python imports, f-strings, or @name references in SPL code cells.',
    ...['ask', 'think', 'agent', 'human'].map(name => `${name}: ${keywords[name]}`),
].join('\n');

const example = [
    "let isFriday = ask(fmt='boolean') 'Is today Friday?'",
    'if isFriday:',
    "    success 'Today is Friday!'",
    'else:',
    "    success ask 'Complain in an original way'",
    '',
    'def double(value):',
    '    return value * 2',
    'for item in range(3):',
    '    log(double(item))',
].join('\n');

export async function registerCopilotContext(
    context: Pick<vscode.ExtensionContext, 'subscriptions'>,
    output: Pick<vscode.OutputChannel, 'appendLine'>,
): Promise<void> {
    // Copilot moved inline completions into the chat extension; support both exports.
    for (const id of ['GitHub.copilot-chat', 'GitHub.copilot']) {
        const extension = vscode.extensions.getExtension<CopilotExports>(id);
        if (!extension) continue;
        try {
            const exports = await extension.activate();
            const copilotApi = typeof exports?.getContextProviderAPI === 'function'
                ? exports : exports?.getAPI?.(1);
            if (typeof copilotApi?.getContextProviderAPI !== 'function') {
                output.appendLine(`${id} does not expose the Copilot inline context API.`);
                continue;
            }
            const api = copilotApi.getContextProviderAPI('v1');
            if (typeof api?.registerContextProvider !== 'function') {
                output.appendLine(`${id} does not support Copilot inline context API v1.`);
                continue;
            }
            context.subscriptions.push(api.registerContextProvider({
                id: 'spl-notebook-syntax',
                selector: [{ language: 'spl', scheme: 'vscode-notebook-cell' }],
                resolver: {
                    async resolve({ documentContext }, token) {
                        if (token.isCancellationRequested || documentContext.languageId !== 'spl') return [];
                        const isSplCell = vscode.workspace.notebookDocuments.some(notebook =>
                            notebook.notebookType === NOTEBOOK_TYPE && notebook.getCells().some(cell =>
                                cell.kind === vscode.NotebookCellKind.Code &&
                                cell.document.languageId === 'spl' &&
                                cell.document.uri.toString() === documentContext.uri,
                            ),
                        );
                        if (!isSplCell) return [];
                        return [
                            { name: 'SPL syntax', value: syntax, importance: 100 },
                            { name: 'SPL example', value: example, importance: 100 },
                        ];
                    },
                },
            }));
            output.appendLine(`Registered SPL notebook inline context with ${id}.`);
            return;
        } catch (error) {
            output.appendLine(`Failed to register SPL inline context with ${id}: ${String(error)}`);
        }
    }
    output.appendLine('SPL AI inline context is unavailable. Native SPL language-server completions remain available.');
}
