import assert from 'node:assert/strict';
import * as path from 'node:path';
import { afterEach, test } from 'node:test';
import { NotebookLogBuffer, registerNotebooks } from '../src/notebook';
import { DEFAULT_FRONTMATTER } from '../src/notebookFormat';
import { NotebookKernel } from '../src/notebookKernel';
import type { ExecuteCell, WorkerReply } from '../src/notebookProtocol';
import { registerCopilotContext, type CopilotContextProvider } from '../src/copilotContext';
import { parse } from '../../lang/src/parser.js';
import * as mock from './vscodeMock';

const contexts: ReturnType<typeof mock.context>[] = [];
afterEach(() => {
    for (const context of contexts.splice(0)) for (const subscription of context.subscriptions) subscription.dispose();
    mock.reset();
});
const setup = (body: string) => {
    const context = mock.context();
    contexts.push(context);
    registerNotebooks(context);
    const serializer = mock.serializers[0].value;
    const source = DEFAULT_FRONTMATTER + '\n\n' + body;
    const data = serializer.deserializeNotebook(Buffer.from(source));
    const notebook = new mock.NotebookDocument(new mock.Uri('file', path.join(process.cwd(), 'workflow.md')), data);
    mock.workspace.open(notebook);
    mock.window.activeNotebookEditor = { notebook };
    return { notebook, controller: mock.controllers[0], serializer, data, source };
};
const fence = (code: string) => '```spl\n' + code + '\n```';

test('notebook log tails include their truncation notice within the 20-line limit', () => {
    const logs = new NotebookLogBuffer();
    assert.equal(logs.text, '');
    for (let index = 0; index < 20; index++) logs.append(`[info] step ${index}`);
    assert.equal(logs.text.split('\n').length, 20);
    assert.doesNotMatch(logs.text, /Earlier logs omitted/);
    logs.append('[info] step 20');
    assert.equal(logs.text.split('\n').length, 20);
    assert.match(logs.text, /^\[Earlier logs omitted; full logs: Output > SPL Notebook\]/);
    assert.doesNotMatch(logs.text, /^\[info\] step [01]$/m);
    assert.match(logs.text, /\[info\] step 2\n/);
    assert.ok(logs.text.endsWith('[info] step 20'));
});

test('notebook log tails cap characters, normalize newlines and preserve Unicode boundaries', () => {
    const logs = new NotebookLogBuffer();
    logs.append('x'.repeat(4_000));
    assert.equal(logs.text.length, 4_000);
    assert.doesNotMatch(logs.text, /Earlier logs omitted/);
    logs.append('tail');
    assert.equal(logs.text.length, 4_000);
    assert.match(logs.text, /Earlier logs omitted/);
    assert.ok(logs.text.endsWith('\ntail'));
    logs.append('\uD83D\uDE00'.repeat(5_000) + '\r\nlatest\rdone');
    assert.ok(logs.text.length <= 4_000);
    assert.doesNotMatch(logs.text.split('\n')[1], /^[\uDC00-\uDFFF]/);
    assert.ok(logs.text.endsWith('\nlatest\ndone'));
    assert.doesNotMatch(logs.text, /\r/);
    for (let index = 0; index < 100; index++) {
        logs.append(`[info] ${index}: ${'x'.repeat(index * 10)}`);
        assert.ok(logs.text.length <= 4_000);
        assert.ok(logs.text.split('\n').length <= 20);
    }
});

test('native cells show brief runtime logs separately from explicit output and results', async t => {
    const hidden = [
        '[llm] llm request (ask):\n[llm] private prompt',
        '[llm] llm response:\n[llm] private reply',
        '[info] reasoning: private reasoning\n[info]   continued',
        '[deterministic] line 1 (expr): secret source',
        '[debug] implementation detail',
    ];
    const visible = ['[info] model call completed', '[warn] retrying\n[warn]   temporary problem', '[error] recovered failure'];
    const explicit = '[info] log: ' + 'x'.repeat(4_500);
    t.mock.method(NotebookKernel.prototype, 'execute', async (
        request: ExecuteCell, log: (text: string, output: boolean) => void,
    ): Promise<Exclude<WorkerReply, { kind: 'log' }>> => {
        for (const text of [...hidden, ...visible]) log(text, false);
        log(explicit, true);
        log('Final instruction reply', true);
        return { id: request.id, kind: 'result', text: '42' };
    });
    const { notebook, controller } = setup(fence('42'));
    await controller.executeHandler(notebook.getCells(), notebook);
    const execution = mock.executions[0];
    assert.equal(execution.success, true);
    assert.equal(execution.outputs.length, 4);
    const brief = execution.outputs[0].items[0].text!;
    assert.match(brief, /^\[info\] Running SPL cell/);
    assert.match(brief, /\[info\] Cell completed \(\d+ ms\)$/);
    for (const text of visible) assert.ok(brief.includes(text));
    for (const text of [...hidden, explicit]) {
        assert.ok(!brief.includes(text));
        assert.ok(mock.outputLines.includes(text));
    }
    assert.equal(execution.outputs[1].items[0].text, explicit + '\n');
    assert.equal(execution.outputs[2].items[0].text, 'Final instruction reply\n');
    assert.equal(execution.outputs[3].items[0].text, '42');
});

test('native runtime logs update live, stay bounded and reset for each execution', async t => {
    let runs = 0;
    t.mock.method(NotebookKernel.prototype, 'execute', async (
        request: ExecuteCell, log: (text: string, output: boolean) => void,
    ): Promise<Exclude<WorkerReply, { kind: 'log' }>> => {
        const run = ++runs;
        log(`[warn] live run ${run}`, false);
        await new Promise(resolve => setImmediate(resolve));
        const execution = mock.executions.at(-1)!;
        assert.equal(execution.ended, false);
        assert.match(execution.outputs[0].items[0].text!, new RegExp(`live run ${run}`));
        if (run === 1) {
            for (let index = 0; index < 1_000; index++) {
                log(`[info] message ${index}: ${'x'.repeat(300)}`, false);
            }
        }
        return { id: request.id, kind: 'result', text: '42' };
    });
    const { notebook, controller } = setup(fence('42'));
    await controller.executeHandler(notebook.getCells(), notebook);
    const execution = mock.executions[0];
    assert.equal(execution.outputs.length, 2, 'Update one log output instead of appending one per message');
    const brief = execution.outputs[0].items[0].text!;
    assert.ok(brief.length <= 4_000);
    assert.ok(brief.split('\n').length <= 20);
    assert.match(brief, /Earlier logs omitted/);
    assert.match(brief, /message 999:/);
    assert.doesNotMatch(brief, /message 0:/);
    assert.ok(mock.outputLines.some(text => text.startsWith('[info] message 0:')));
    await controller.executeHandler(notebook.getCells(), notebook);
    const rerun = mock.executions[1].outputs[0].items[0].text!;
    assert.match(rerun, /live run 2/);
    assert.doesNotMatch(rerun, /Earlier logs omitted|message 999:|live run 1/);
});

test('runtime log limits do not truncate failure output or diagnostics', async t => {
    const message = 'Failure detail '.repeat(400);
    t.mock.method(NotebookKernel.prototype, 'execute', async (
        request: ExecuteCell,
    ): Promise<Exclude<WorkerReply, { kind: 'log' }>> => ({
        id: request.id, kind: 'error', message, source: request.source,
        version: request.version, line: 1, column: 1,
    }));
    const { notebook, controller } = setup(fence('42'));
    await controller.executeHandler(notebook.getCells(), notebook);
    const execution = mock.executions[0];
    assert.equal(execution.success, false);
    const brief = execution.outputs[0].items[0].text!;
    assert.ok(brief.length <= 4_000);
    assert.ok(brief.split('\n').length <= 20);
    assert.match(brief, /Earlier logs omitted/);
    assert.ok(execution.outputs.at(-1)!.items[0].error!.message.startsWith(message));
    assert.equal(mock.diagnostics.get('spl-notebook-runtime')?.get(notebook.getCells()[0].document.uri.toString())?.[0].message, message);
});

test('native serializer exposes editable code/instruction cells and transient outputs', () => {
    const { data, source, serializer } = setup('# Notes\n\n' + fence('let x = 1') + '\n\n> Use @x.\n');
    assert.deepEqual(data.cells.map(cell => [cell.kind, cell.languageId]), [[1, 'markdown'], [2, 'spl'], [2, 'markdown']]);
    assert.equal(data.cells[2].value, 'Use @x.');
    assert.equal(Buffer.from(serializer.serializeNotebook(data)).toString(), source);
    assert.equal(mock.serializers[0].options.transientOutputs, true);
    data.cells[1].value = 'let x = 2';
    assert.match(Buffer.from(serializer.serializeNotebook(data)).toString(), /let x = 2/);
});

test('native instruction cells edit plain text and save blockquote markers automatically', () => {
    const { data, serializer } = setup('> @ENFORCE Answer in Chinese\n>\n> Tell a story -> @animal\n');
    assert.equal(data.cells[0].value, '@ENFORCE Answer in Chinese\n\nTell a story -> @animal');
    data.cells[0].value = '@ENFORCE Answer in Chinese\n\nTell a funny story -> @animal';
    const saved = Buffer.from(serializer.serializeNotebook(data)).toString();
    assert.match(saved, /> @ENFORCE Answer in Chinese\n> \n> Tell a funny story -> @animal/);
    assert.equal(serializer.deserializeNotebook(Buffer.from(saved)).cells[0].value, data.cells[0].value);
    assert.equal(mock.diagnostics.get('spl-notebook-syntax')?.size, 0);
});

for (const id of ['GitHub.copilot-chat', 'GitHub.copilot']) {
    test(`SPL notebook supplies native syntax to ${id} inline suggestions`, async () => {
        const { notebook } = setup(fence('let count = 1') + '\n\n> Use @count.');
        const context = contexts[0];
        let provider: CopilotContextProvider | undefined;
        let disposed = false;
        const messages: string[] = [];
        mock.installedExtensions.set(id, {
            async activate() {
                const api = {
                    getContextProviderAPI(version: string) {
                        assert.equal(version, 'v1');
                        return {
                            registerContextProvider(value: CopilotContextProvider) {
                                provider = value;
                                return new mock.Disposable(() => { disposed = true; });
                            },
                        };
                    },
                };
                return id === 'GitHub.copilot' ? api : {
                    getAPI(version: number) {
                        assert.equal(version, 1);
                        return api;
                    },
                };
            },
        });
        await registerCopilotContext(context, { appendLine: text => messages.push(text) });
        assert.ok(provider);
        assert.deepEqual(provider.selector, [{ language: 'spl', scheme: 'vscode-notebook-cell' }]);
        const registered = provider;
        const resolve = (uri: string, languageId = 'spl', cancelled = false) => registered.resolver.resolve(
            { documentContext: { uri, languageId } }, { isCancellationRequested: cancelled },
        );
        const uri = notebook.getCells()[0].document.uri.toString();
        const traits = await resolve(uri);
        assert.ok(traits.every(trait => trait.importance === 100));
        assert.match(traits.find(trait => trait.name === 'SPL syntax')?.value ?? '', /colon followed by a newline/);
        assert.match(traits.find(trait => trait.name === 'SPL syntax')?.value ?? '', /let name = expression/);
        const example = traits.find(trait => trait.name === 'SPL example')?.value;
        assert.ok(example);
        assert.doesNotThrow(() => parse(example));
        assert.match(example, /if isFriday:\n {4}success/);
        assert.match(example, /\nelse:\n {4}success/);
        assert.deepEqual(await resolve(uri, 'spl', true), []);
        assert.deepEqual(await resolve(notebook.getCells()[1].document.uri.toString(), 'markdown'), []);
        assert.deepEqual(await resolve('file:///workflow.md'), []);
        notebook.notebookType = 'jupyter-notebook';
        assert.deepEqual(await resolve(uri), []);
        assert.match(messages.at(-1) ?? '', /Registered SPL notebook inline context/);
        for (const subscription of context.subscriptions) subscription.dispose();
        assert.equal(disposed, true);
    });
}

test('optional Copilot context reports unsupported APIs and activation failures without breaking notebooks', async () => {
    const { notebook } = setup(fence('42'));
    const messages: string[] = [];
    const register = () => registerCopilotContext(contexts[0], { appendLine: text => messages.push(text) });
    await register();
    assert.match(messages.at(-1) ?? '', /inline context is unavailable/);
    mock.installedExtensions.set('GitHub.copilot-chat', { activate: async () => ({}) });
    await register();
    assert.ok(messages.some(message => message.includes('does not expose')));
    mock.installedExtensions.set('GitHub.copilot-chat', {
        activate: async () => ({ getContextProviderAPI: () => ({}) }),
    });
    await register();
    assert.ok(messages.some(message => message.includes('does not support')));
    mock.installedExtensions.set('GitHub.copilot-chat', {
        async activate() { throw new Error('activation failed'); },
    });
    await register();
    assert.ok(messages.some(message => message.includes('activation failed')));
    assert.equal(notebook.getCells()[0].document.languageId, 'spl');
});

test('legacy Copilot context is used when the chat extension has no compatible API', async () => {
    setup(fence('42'));
    let registrations = 0;
    mock.installedExtensions.set('GitHub.copilot-chat', { activate: async () => ({}) });
    mock.installedExtensions.set('GitHub.copilot', {
        activate: async () => ({
            getContextProviderAPI: () => ({
                registerContextProvider() {
                    registrations++;
                    return new mock.Disposable();
                },
            }),
        }),
    });
    await registerCopilotContext(contexts[0], { appendLine() {} });
    assert.equal(registrations, 1);
});

test('native controller queues requests, renders results and routes function errors to their cell', async () => {
    const { notebook, controller } = setup(fence("let count = 2\ndef broken():\n    fail 'original'") +
        '\n\n' + fence('count += 1\ncount') + '\n\n' + fence('count += 1\ncount') + '\n\n' + fence('broken()'));
    const cells = notebook.getCells();
    await controller.executeHandler([cells[0]], notebook);
    await Promise.all([
        controller.executeHandler([cells[2]], notebook),
        controller.executeHandler([cells[1]], notebook),
    ]);
    assert.deepEqual(mock.executions.map(execution => execution.executionOrder), [1, 2, 3]);
    assert.equal(mock.executions[1].outputs.at(-1)!.items[0].text, '3');
    assert.equal(mock.executions[2].outputs.at(-1)!.items[0].text, '4');
    await controller.executeHandler([cells[3]], notebook);
    assert.equal(mock.executions[3].success, false);
    const runtime = mock.diagnostics.get('spl-notebook-runtime')!;
    assert.equal(runtime.get(cells[0].document.uri.toString())?.[0].range.start.line, 2);
    mock.workspace.changeText(cells[0].document, 'let count = 99');
    assert.equal(runtime.size, 0);
    await controller.executeHandler([cells[3]], notebook);
    assert.equal(runtime.size, 0, 'Do not highlight stale locations in edited function definitions');
    await mock.registeredCommands.get('spl.resetNotebook')?.();
    await controller.executeHandler([cells[1]], notebook);
    const last = mock.executions.at(-1)!;
    assert.equal(last.executionOrder, 1);
    assert.equal(last.success, false);
    assert.match(last.outputs.at(-1)!.items[0].error?.message ?? '', /declare a local/);
});

test('untrusted notebooks cannot execute cells', async () => {
    const { notebook, controller } = setup(fence("write_file('must-not-exist', 'test')"));
    mock.workspace.isTrusted = false;
    await controller.executeHandler(notebook.getCells(), notebook);
    assert.equal(mock.executions.length, 0);
    assert.match(mock.messages.at(-1) ?? '', /Trust this workspace/);
});

test('cancellation ends running and queued cells and allows a clean session restart', async () => {
    const { notebook, controller } = setup(fence('while True:\n    pass') + '\n\n' + fence('42'));
    const running = controller.executeHandler(notebook.getCells(), notebook);
    await new Promise(resolve => setTimeout(resolve, 200));
    mock.executions[0].cancel();
    await running;
    assert.ok(mock.executions.every(execution => execution.ended && !execution.success));
    await controller.executeHandler([notebook.getCells()[1]], notebook);
    assert.equal(mock.executions.at(-1)?.success, true);
    assert.equal(mock.executions.at(-1)?.outputs.at(-1)?.items[0].text, '42');
    mock.workspace.close(notebook);
});
