import assert from 'node:assert/strict';
import * as path from 'node:path';
import { afterEach, test } from 'node:test';
import { registerNotebooks } from '../src/notebook';
import { DEFAULT_FRONTMATTER } from '../src/notebookFormat';
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

test('native controller queues requests, renders results and routes function errors to their cell', async () => {
    const { notebook, controller } = setup(fence("let count = 2\ndef broken() {\n    fail 'original'\n}") +
        '\n\n' + fence('count += 1\ncount') + '\n\n' + fence('count += 1\ncount') + '\n\n' + fence('broken()'));
    const cells = notebook.getCells();
    await controller.executeHandler([cells[0]], notebook);
    await Promise.all([
        controller.executeHandler([cells[2]], notebook),
        controller.executeHandler([cells[1]], notebook),
    ]);
    assert.deepEqual(mock.executions.map(execution => execution.executionOrder), [1, 2, 3]);
    assert.equal(mock.executions[1].outputs[0].items[0].text, '3');
    assert.equal(mock.executions[2].outputs[0].items[0].text, '4');
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
    assert.match(last.outputs[0].items[0].error?.message ?? '', /declare a local/);
});

test('untrusted notebooks cannot execute cells', async () => {
    const { notebook, controller } = setup(fence("write_file('must-not-exist', 'test')"));
    mock.workspace.isTrusted = false;
    await controller.executeHandler(notebook.getCells(), notebook);
    assert.equal(mock.executions.length, 0);
    assert.match(mock.messages.at(-1) ?? '', /Trust this workspace/);
});

test('cancellation ends running and queued cells and allows a clean session restart', async () => {
    const { notebook, controller } = setup(fence('while True { pass }') + '\n\n' + fence('42'));
    const running = controller.executeHandler(notebook.getCells(), notebook);
    await new Promise(resolve => setTimeout(resolve, 200));
    mock.executions[0].cancel();
    await running;
    assert.ok(mock.executions.every(execution => execution.ended && !execution.success));
    await controller.executeHandler([notebook.getCells()[1]], notebook);
    assert.equal(mock.executions.at(-1)?.success, true);
    assert.equal(mock.executions.at(-1)?.outputs[0].items[0].text, '42');
    mock.workspace.close(notebook);
});
