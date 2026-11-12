import * as vscode from 'vscode';
import { library } from './catalog';
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

const CELL_LANGUAGES = ['javascript', 'typescript'];

const guide = [
    'This cell is a JavaScript step of a Semantic Prompt Language (SPL) workflow notebook. It runs as native JavaScript on Node.js.',
    'All cells share one scope: top-level const, let, function and class declarations are visible in later cells and to natural-language instruction cells.',
    'Top-level await and static imports work. Imports resolve against the working directory; node: built-ins and local .js files are importable.',
    'The spl-lang library is already in scope. Do not import it and do not redeclare these names:',
    ...Object.values(library).map(help => `${help.signature}: ${help.description}`),
    'Model calls and tools return promises: always await ask, think, agent, human, readFile, writeFile, webFetch, webSearch, shell, restrict and codegen.',
    'Use log(value) for run logs and success(value) to end the workflow with a result. Use assert(condition, message) for checks.',
].join('\n');

const example = [
    "const Topic = enumOf('bug', 'feature', 'question');",
    "const Triage = struct('Triage', {",
    '    label: Topic,',
    "    reason: str.annotate({ desc: 'One-sentence explanation' }),",
    '});',
    'const triage = await ask(`Classify: ${issue}`, { schema: Triage, repairs: 2 });',
    "assert(triage.reason.length > 0, 'a reason is required');",
    "await restrict({ fs: './out' }, () => writeFile('./out/triage.json', JSON.stringify(triage)));",
    'success(triage);',
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
                id: 'spl-notebook-library',
                selector: CELL_LANGUAGES.map(language => ({ language, scheme: 'vscode-notebook-cell' })),
                resolver: {
                    async resolve({ documentContext }, token) {
                        if (token.isCancellationRequested || !CELL_LANGUAGES.includes(documentContext.languageId)) return [];
                        const isWorkflowCell = vscode.workspace.notebookDocuments.some(notebook =>
                            notebook.notebookType === NOTEBOOK_TYPE && notebook.getCells().some(cell =>
                                cell.kind === vscode.NotebookCellKind.Code &&
                                CELL_LANGUAGES.includes(cell.document.languageId) &&
                                cell.document.uri.toString() === documentContext.uri,
                            ),
                        );
                        if (!isWorkflowCell) return [];
                        return [
                            { name: 'SPL workflow library', value: guide, importance: 100 },
                            { name: 'SPL workflow example', value: example, importance: 100 },
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
    output.appendLine('SPL AI inline context is unavailable. Library completions remain available.');
}
