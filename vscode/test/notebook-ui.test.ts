import assert from 'node:assert/strict';
import * as path from 'node:path';
import { afterEach, test } from 'node:test';
import { library, markers } from '../src/catalog';
import { registerCopilotContext, type CopilotContextProvider } from '../src/copilotContext';
import { NotebookLogBuffer, registerNotebooks } from '../src/notebook';
import { DEFAULT_FRONTMATTER } from '../src/notebookFormat';
import { NotebookKernel } from '../src/notebookKernel';
import { registerNotebookLanguageFeatures } from '../src/notebookLanguageFeatures';
import type { CellResult, ExecuteCell } from '../src/notebookProtocol';
import { compileCell } from '../../lang/src/cell.js';
import type { ModelStreamSink } from '../../lang/src/log-events.js';
import * as mock from './vscodeMock';

const contexts: ReturnType<typeof mock.context>[] = [];
afterEach(() => {
    for (const context of contexts.splice(0)) for (const subscription of context.subscriptions) subscription.dispose();
    mock.reset();
});
const setup = (body: string, frontmatter = DEFAULT_FRONTMATTER) => {
    const context = mock.context();
    contexts.push(context);
    registerNotebooks(context);
    registerNotebookLanguageFeatures(context);
    const serializer = mock.serializers[0].value;
    const source = frontmatter + '\n\n' + body;
    const data = serializer.deserializeNotebook(Buffer.from(source));
    const notebook = new mock.NotebookDocument(new mock.Uri('file', path.join(process.cwd(), 'workflow.md')), data);
    mock.workspace.open(notebook);
    mock.window.activeNotebookEditor = { notebook };
    return { notebook, controller: mock.controllers[0], serializer, data, source };
};
const fence = (code: string, language = 'js') => '```' + language + '\n' + code + '\n```';
const position = (line: number, character: number) => new mock.Position(line, character);
const range = (line: number, from: number, to: number) => new mock.Range(position(line, from), position(line, to));
const cellSelector = (language: string) => ({ language, scheme: 'vscode-notebook-cell', notebookType: 'spl-workflow' });
type Log = (text: string, output: boolean) => void;

test('instruction cells complete shared names, markers and library functions after @', () => {
    const { notebook } = setup(fence("const notes = 'draft';\nfunction shorten(text) {\n    return text.slice(0, 80);\n}") + '\n\n' +
        fence('const limit: number = 3;', 'ts') + '\n\n> Use @no\n\n' + fence('const later = 1;'));
    const document = notebook.getCells()[2].document;
    const { provider, selector, triggers } = mock.completionProviders[0];
    assert.deepEqual(selector, cellSelector('markdown'));
    assert.deepEqual(triggers, ['@', '(', ',', '=', '{', '[', "'", '"']);
    const complete = (text: string) => {
        mock.workspace.changeText(document, text);
        return provider.provideCompletionItems(document, position(0, text.length));
    };
    const items = complete('Use @no');
    const find = (label: string, kind: number) => items.find(item => item.label === label && item.kind === kind)!;
    const notes = find('notes', mock.CompletionItemKind.Variable);
    assert.deepEqual([notes.detail, notes.insertText, notes.range], ['Shared binding', undefined, range(0, 5, 7)]);
    assert.ok(find('shorten', mock.CompletionItemKind.Variable) && find('limit', mock.CompletionItemKind.Variable));
    const validate = find('validate', mock.CompletionItemKind.Keyword);
    assert.deepEqual([validate.detail, validate.insertText, validate.range],
        ['@validate[Type]', new mock.SnippetString('validate[${1:Type}]'), range(0, 5, 7)]);
    assert.deepEqual(find('env', mock.CompletionItemKind.Keyword).insertText, new mock.SnippetString('env.${1:NAME}'));
    const ask = find('ask', mock.CompletionItemKind.Function);
    assert.deepEqual([ask.detail, ask.documentation], [library.ask.signature, library.ask.description]);
    const labels = items.map(item => item.label);
    for (const name of ['success', 'fail', 'args', 'readFile', 'codegen']) assert.ok(labels.includes(name), name);
    for (const name of ['later', 'CTL', 'CODEGEN', 'struct', 'restrict']) assert.ok(!labels.includes(name), name);
    assert.deepEqual(items.map(item => item.sortText![0]), [...items.map(item => item.sortText![0])].sort(),
        'shared names come first, then markers, then library functions');

    const opening = complete('@');
    assert.deepEqual(opening.find(item => item.label === 'CTL')?.insertText, new mock.SnippetString(markers.ctl.insert));
    assert.deepEqual(opening.find(item => item.label === 'CODEGEN')?.insertText, new mock.SnippetString(markers.codegen.insert));
    assert.ok(complete("@CTL(reasoning='high') Summarize @no").some(item => item.label === 'notes'));
    for (const text of ['Plain text', 'Mail user@no', 'Escaped \\@no', 'Doubled @@no']) assert.deepEqual(complete(text), [], text);
});

test('instruction cells complete @CTL settings, restriction kinds and literal values', () => {
    const { notebook } = setup('> @CTL()', DEFAULT_FRONTMATTER.replace('\n---', '\nmodel: test-model\n---'));
    const document = notebook.getCells()[0].document;
    const complete = (text: string, line = 0) => {
        mock.workspace.changeText(document, text);
        return mock.completionProviders[0].provider.provideCompletionItems(document, position(line, text.split('\n')[line].length));
    };
    const settings = complete('@CTL(\n    rea', 1);
    assert.deepEqual(settings.map(item => item.label), ['restrict', 'enforce', 'forbid', 'model', 'reasoning']);
    const reasoning = settings[4];
    assert.deepEqual([reasoning.kind, reasoning.insertText, reasoning.range, reasoning.detail],
        [mock.CompletionItemKind.Property, 'reasoning=', range(1, 4, 7), "reasoning='low' | 'medium' | 'high'"]);
    assert.match(String(reasoning.documentation), /Reasoning effort/);
    assert.deepEqual(complete("@CTL(reasoning='high', ").map(item => item.label), ['restrict', 'enforce', 'forbid', 'model']);

    const values = complete("@CTL(reasoning='h");
    assert.deepEqual(values.map(item => [item.label, item.kind]), ['low', 'medium', 'high'].map(value => [value, mock.CompletionItemKind.Value]));
    assert.deepEqual([values[2].insertText, values[2].range], ["high'", range(0, 16, 17)]);
    assert.deepEqual(complete('@CTL(model=').map(item => [item.label, item.insertText]), [['test-model', "'test-model'"]]);
    const kinds = complete('@CTL(restrict={');
    assert.deepEqual(kinds.map(item => [item.label, item.insertText]), [['fs', 'fs:'], ['exec', 'exec:'], ['net', 'net:'], ['mcp', 'mcp:']]);
    assert.deepEqual(complete("@CTL(restrict={fs: ['./src', "), []);

    notebook.metadata.frontmatter = '---\nextension: other\n---';
    assert.deepEqual(complete('@CTL(model='), [], 'an invalid header offers no model');
});

test('instruction cells complete names saved by earlier instruction cells', () => {
    const { notebook } = setup('> Summarize the news and save it to @summary, and a title -> @title\n\n> @count = the number of words\n\n> Use @');
    const document = notebook.getCells()[2].document;
    const labels = mock.completionProviders[0].provider.provideCompletionItems(document, position(0, 5))
        .filter(item => item.detail === 'Shared binding').map(item => item.label);
    assert.deepEqual(labels, ['summary', 'title', 'count']);
});

test('code cells complete and describe the pre-imported library, leaving members to JavaScript', () => {
    const { notebook } = setup(fence("const reply = await ask('Hi');\nreply.ask;\n\nstr") + '\n\n' + fence('const total: number = 1;\nstru', 'ts'));
    const [script, typed] = notebook.getCells().map(cell => cell.document);
    const { provider, selector, triggers } = mock.completionProviders[1];
    assert.deepEqual([selector, triggers], [[cellSelector('javascript'), cellSelector('typescript')], []]);
    const items = provider.provideCompletionItems(script, position(3, 3));
    assert.deepEqual(items.map(item => item.label), Object.keys(library));
    const ask = items.find(item => item.label === 'ask')!;
    assert.deepEqual([ask.kind, ask.detail, ask.documentation], [
        mock.CompletionItemKind.Function, 'ask(prompt, options?) (SPL library)',
        new mock.MarkdownString(`\`${library.ask.signature}\`\n\n${library.ask.description}`),
    ]);
    assert.equal(items.find(item => item.label === 'args')?.kind, mock.CompletionItemKind.Variable);
    assert.equal(provider.provideCompletionItems(script, position(2, 0)).length, items.length, 'an empty line');
    assert.equal(provider.provideCompletionItems(script, position(0, 14)).length, items.length, 'after an operator');
    assert.equal(provider.provideCompletionItems(typed, position(1, 4)).length, items.length, 'TypeScript cells');
    assert.deepEqual(provider.provideCompletionItems(script, position(1, 6)), [], 'after a dot');
    assert.deepEqual(provider.provideCompletionItems(script, position(1, 9)), [], 'inside a member name');

    const hover = mock.hoverProviders[0];
    assert.deepEqual(hover.selector, [cellSelector('javascript'), cellSelector('typescript')]);
    assert.deepEqual(hover.provider.provideHover(script, position(0, 21)),
        new mock.Hover(new mock.MarkdownString(`\`${library.ask.signature}\`\n\n${library.ask.description}`), range(0, 20, 23)));
    assert.match(hover.provider.provideHover(script, position(3, 3))?.contents.value ?? '', /^`str`\n\nString type/);
    assert.equal(hover.provider.provideHover(script, position(0, 8)), undefined, 'a workflow variable');
    assert.equal(hover.provider.provideHover(script, position(1, 7)), undefined, 'a member named like a library function');
    assert.equal(hover.provider.provideHover(script, position(2, 0)), undefined, 'an empty line');
    assert.equal(hover.provider.provideHover(typed, position(1, 2)), undefined, 'an incomplete name');
});

test('notebook language features leave prose cells and other notebook types untouched', () => {
    const { notebook } = setup(fence('const notes = 1;\nask') + '\n\nMention @no in prose.\n\n> Use @no');
    const [script, prose, instruction] = notebook.getCells().map(cell => cell.document);
    const [instructions, code] = mock.completionProviders.map(entry => entry.provider.provideCompletionItems);
    const hover = mock.hoverProviders[0].provider.provideHover;
    const marker = prose.positionAt(prose.getText().indexOf('@no') + 3);
    assert.deepEqual(instructions(prose, marker), []);
    assert.ok(instructions(instruction, position(0, 7)).some(item => item.label === 'notes'));
    assert.ok(code(script, position(1, 3)).length > 0);
    assert.ok(hover(script, position(1, 1)));
    notebook.notebookType = 'jupyter-notebook';
    assert.deepEqual(instructions(instruction, position(0, 7)), []);
    assert.deepEqual(code(script, position(1, 3)), []);
    assert.equal(hover(script, position(1, 1)), undefined);
});

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
        '-> input ask private prompt',
        '<- output ask private reply',
        '~ state private variable',
        '. debug implementation detail',
        'i info reasoning: private reasoning',
        '[llm] llm request (ask):\n[llm] private prompt',
        '[llm] llm response:\n[llm] private reply',
        '[info] reasoning: private reasoning\n[info]   continued',
        '[deterministic] line 1 (expr): secret source',
        '[debug] implementation detail',
    ];
    const visible = ['[info] model call completed', '[warn] retrying\n[warn]   temporary problem', '[error] recovered failure',
        'i info model call completed', '! warning retrying', 'x error recovered failure'];
    const explicit = '[info] log: ' + 'x'.repeat(4_500);
    const requests: ExecuteCell[] = [];
    t.mock.method(NotebookKernel.prototype, 'execute', async (request: ExecuteCell, log: Log): Promise<CellResult> => {
        requests.push(request);
        for (const text of [...hidden, ...visible]) log(text, false);
        log(explicit, true);
        log('Final instruction reply', true);
        return { id: request.id, kind: 'result', text: '42' };
    });
    const { notebook, controller } = setup(fence('42') + '\n\n' + fence('42 as number', 'ts') + '\n\n> Reply with @answer.');
    await controller.executeHandler(notebook.getCells(), notebook);
    const frontmatter = DEFAULT_FRONTMATTER;
    assert.deepEqual(requests.map(({ id, ...request }) => request), [
        { value: '42', language: 'javascript', frontmatter, source: notebook.getCells()[0].document.uri.toString(), version: 1 },
        { value: '42 as number', language: 'typescript', frontmatter, source: notebook.getCells()[1].document.uri.toString(), version: 1 },
        { value: 'Reply with @answer.', language: 'markdown', frontmatter, source: notebook.getCells()[2].document.uri.toString(), version: 1 },
    ]);
    assert.equal(new Set(requests.map(request => request.id)).size, 3);
    assert.deepEqual(mock.executions.map(execution => execution.outputs[0].items[0].text!.split('\n')[0]),
        ['[info] Running javascript cell', '[info] Running typescript cell', '[info] Running instruction cell']);
    const execution = mock.executions[0];
    assert.equal(execution.success, true);
    assert.equal(execution.outputs.length, 4);
    const brief = execution.outputs[0].items[0].text!;
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
    t.mock.method(NotebookKernel.prototype, 'execute', async (request: ExecuteCell, log: Log): Promise<CellResult> => {
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

test('model replies and reasoning update in place before completion without repeating the final result', async t => {
    t.mock.method(NotebookKernel.prototype, 'execute', async (request: ExecuteCell, _log: Log, stream: ModelStreamSink): Promise<CellResult> => {
        const interaction = { kind: 'think', requestId: String(request.id) } as const;
        const update = (messageId: string, text: string, channel: 'response' | 'reasoning' = 'response') =>
            stream({ type: 'update', interaction, update: { messageId, text, channel, mode: 'append' } });
        update('intro', 'Working...');
        await new Promise(resolve => setImmediate(resolve));
        const execution = mock.executions.at(-1)!;
        assert.equal(execution.ended, false);
        assert.equal(execution.outputs[1].items[0].text, 'Working...');
        const responseOutput = execution.outputs[1];
        update('answer', 'Hel');
        update('answer', 'lo');
        update('reason', 'Think', 'reasoning');
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(execution.outputs[1], responseOutput);
        assert.equal(responseOutput.items[0].text, 'Hello');
        assert.equal(execution.outputs[2].items[0].text, 'Reasoning:\nThink');
        stream({ type: 'update', interaction, update: { messageId: 'answer', text: 'Full message', channel: 'response', mode: 'replace' } });
        stream({ type: 'end', interaction, outcome: 'completed', response: 'Authoritative answer', reasoning: 'Complete reasoning' });
        return { id: request.id, kind: 'result', text: 'Authoritative answer' };
    });
    const { notebook, controller } = setup(fence("await think('Prompt')"));
    await controller.executeHandler(notebook.getCells(), notebook);
    const execution = mock.executions[0];
    assert.equal(execution.success, true);
    assert.equal(execution.outputs.length, 3);
    assert.equal(execution.outputs[1].items[0].text, 'Authoritative answer');
    assert.equal(execution.outputs[2].items[0].text, 'Reasoning:\nComplete reasoning');
    assert.doesNotMatch(execution.outputs[0].items[0].text!, /Working|Hello|Complete reasoning/);
});

test('streaming updates coalesce, preserve large content and reset on rerun', async t => {
    let runs = 0;
    t.mock.method(NotebookKernel.prototype, 'execute', async (request: ExecuteCell, _log: Log, stream: ModelStreamSink): Promise<CellResult> => {
        const interaction = { kind: 'ask', requestId: 'same-request' } as const;
        const content = ++runs === 1 ? 'x'.repeat(10_000) : 'New response';
        for (const text of content) stream({
            type: 'update', interaction, update: { channel: 'response', messageId: 'same-message', mode: 'append', text },
        });
        await new Promise(resolve => setImmediate(resolve));
        const execution = mock.executions.at(-1)!;
        assert.equal(execution.outputs.length, 2);
        assert.equal(execution.outputs[1].items[0].text, content);
        stream({ type: 'end', interaction, outcome: 'completed', response: content });
        return { id: request.id, kind: 'result' };
    });
    const { notebook, controller } = setup(fence("const reply = await ask('Prompt');"));
    await controller.executeHandler(notebook.getCells(), notebook);
    assert.equal(mock.executions[0].outputs[1].items[0].text!.length, 10_000);
    await controller.executeHandler(notebook.getCells(), notebook);
    assert.equal(mock.executions[1].outputs[1].items[0].text, 'New response');
});

test('reasoning previews without authoritative reasoning remain explicitly identified as previews', async t => {
    t.mock.method(NotebookKernel.prototype, 'execute', async (request: ExecuteCell, _log: Log, stream: ModelStreamSink): Promise<CellResult> => {
        const interaction = { kind: 'think', requestId: String(request.id) } as const;
        stream({ type: 'update', interaction, update: { channel: 'reasoning', messageId: 'reason', mode: 'append', text: 'Partial thought' } });
        stream({ type: 'end', interaction, outcome: 'completed', response: 'Answer' });
        return { id: request.id, kind: 'result', text: 'Answer' };
    });
    const { notebook, controller } = setup(fence("await think('Prompt')"));
    await controller.executeHandler(notebook.getCells(), notebook);
    assert.equal(mock.executions[0].success, true);
    assert.deepEqual(mock.executions[0].outputs.slice(1).map(item => item.items[0].text), [
        'Reasoning:\nPartial thought\n[Reasoning preview only]', 'Answer',
    ]);
});

test('nested model calls have separate outputs and completed replies also work without deltas', async t => {
    t.mock.method(NotebookKernel.prototype, 'execute', async (request: ExecuteCell, _log: Log, stream: ModelStreamSink): Promise<CellResult> => {
        const outer = { kind: 'blockquote', requestId: 'outer' } as const;
        const inner = { kind: 'ask', requestId: 'inner' } as const;
        stream({ type: 'update', interaction: outer, update: { channel: 'response', messageId: 'same', mode: 'append', text: 'Outer preview' } });
        stream({ type: 'end', interaction: inner, outcome: 'completed', response: 'Nested answer' });
        stream({ type: 'end', interaction: outer, outcome: 'completed', response: 'Final instruction reply' });
        return { id: request.id, kind: 'result', text: 'A different workflow result' };
    });
    const { notebook, controller } = setup('> Call a function.');
    await controller.executeHandler(notebook.getCells(), notebook);
    assert.deepEqual(mock.executions[0].outputs.slice(1).map(item => item.items[0].text), [
        'Final instruction reply', 'Nested answer', 'A different workflow result',
    ]);
});

test('failed or cancelled streams remain explicitly interrupted and are not successful results', async t => {
    t.mock.method(NotebookKernel.prototype, 'execute', async (_request: ExecuteCell, _log: Log, stream: ModelStreamSink): Promise<CellResult> => {
        const interaction = { kind: 'ask', requestId: 'failed' } as const;
        stream({ type: 'update', interaction, update: { channel: 'response', messageId: 'answer', mode: 'append', text: '{"partial":true}' } });
        await new Promise(resolve => setImmediate(resolve));
        throw new Error('Runtime cancelled before completion');
    });
    const { notebook, controller } = setup(fence("await ask('Prompt')"));
    await controller.executeHandler(notebook.getCells(), notebook);
    const execution = mock.executions[0];
    assert.equal(execution.success, false);
    assert.equal(execution.outputs[1].items[0].text, '{"partial":true}\n[Model output interrupted]');
    assert.match(execution.outputs.at(-1)!.items[0].error!.message, /Runtime cancelled/);
});

test('runtime log limits do not truncate failure output or diagnostics', async t => {
    const message = 'Failure detail '.repeat(400);
    t.mock.method(NotebookKernel.prototype, 'execute', async (request: ExecuteCell): Promise<CellResult> => ({
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
    const { data, source, serializer } = setup('# Notes\n\n' + fence('let x = 1;') + '\n\n> Use @x.\n\n' + fence('const y: number = x;', 'typescript') + '\n');
    assert.deepEqual(data.cells.map(cell => [cell.kind, cell.languageId]),
        [[1, 'markdown'], [2, 'javascript'], [2, 'markdown'], [2, 'typescript']]);
    assert.equal(data.cells[2].value, 'Use @x.');
    assert.equal(Buffer.from(serializer.serializeNotebook(data)).toString(), source);
    assert.equal(mock.serializers[0].options.transientOutputs, true);
    const windows = '\uFEFF' + source.replace(/\n/g, '\r\n');
    assert.equal(Buffer.from(serializer.serializeNotebook(serializer.deserializeNotebook(Buffer.from(windows)))).toString(), windows);

    data.cells[1].value = 'let x = 2;';
    data.cells[3].languageId = 'javascript';
    const saved = Buffer.from(serializer.serializeNotebook(data)).toString();
    assert.match(saved, /```js\nlet x = 2;\n```/);
    assert.match(saved, /```js\nconst y: number = x;\n```/);
    data.cells[3].languageId = 'python';
    assert.throws(() => serializer.serializeNotebook(data), /Unsupported notebook cell language 'python'; use JavaScript, TypeScript or Markdown/);
});

test('native serializer writes cells created in the editor as a new workflow', () => {
    const { serializer } = setup('');
    const saved = Buffer.from(serializer.serializeNotebook(new mock.NotebookData([
        new mock.NotebookCellData(mock.NotebookCellKind.Markup, '# Title', 'markdown'),
        new mock.NotebookCellData(mock.NotebookCellKind.Code, "const topic = 'tea';", 'javascript'),
        new mock.NotebookCellData(mock.NotebookCellKind.Code, 'const size: number = 2;', 'typescript'),
        new mock.NotebookCellData(mock.NotebookCellKind.Code, 'Describe @topic\nin @size words -> @summary', 'markdown'),
    ]))).toString();
    assert.equal(saved, DEFAULT_FRONTMATTER + "\n\n# Title\n\n```js\nconst topic = 'tea';\n```\n\n```ts\nconst size: number = 2;\n```\n\n" +
        '> Describe @topic\n> in @size words -> @summary\n');
    assert.deepEqual(serializer.deserializeNotebook(Buffer.from(saved)).cells.map(cell => [cell.kind, cell.languageId]),
        [[1, 'markdown'], [2, 'javascript'], [2, 'typescript'], [2, 'markdown']]);
});

test('native instruction cells edit plain text and save blockquote markers automatically', () => {
    const { data, serializer } = setup("> @CTL(enforce='Answer in Chinese')\n>\n> Tell a story -> @animal\n");
    assert.equal(data.cells[0].value, "@CTL(enforce='Answer in Chinese')\n\nTell a story -> @animal");
    data.cells[0].value = "@CTL(enforce='Answer in Chinese')\n\nTell a funny story -> @animal";
    const saved = Buffer.from(serializer.serializeNotebook(data)).toString();
    assert.match(saved, /> @CTL\(enforce='Answer in Chinese'\)\n> \n> Tell a funny story -> @animal/);
    assert.equal(serializer.deserializeNotebook(Buffer.from(saved)).cells[0].value, data.cells[0].value);
    assert.equal(mock.diagnostics.get('spl-notebook-syntax')?.size, 0);
});

test('syntax diagnostics follow code and instruction cells as they are edited and removed', () => {
    const { notebook } = setup([
        fence('const ok = 1;\nlet x ='), fence('enum Color { Red }', 'ts'),
        '> Summarize @ok.\n> @CTL(reasoning="low")', fence('const fine: number = ok;', 'ts'),
    ].join('\n\n'));
    const cells = notebook.getCells();
    const syntax = mock.diagnostics.get('spl-notebook-syntax')!;
    const problems = (index: number) => syntax.get(cells[index].document.uri.toString()) ?? [];
    assert.deepEqual(problems(0).map(item => [item.message, item.source, item.severity, item.range]),
        [['Unexpected token', 'SPL Notebook', mock.DiagnosticSeverity.Error, range(1, 7, 7)]]);
    assert.match(problems(1)[0].message, /Only erasable type syntax is supported/);
    assert.match(problems(2)[0].message, /@CTL must appear once at the start of a blockquote/);
    assert.equal(syntax.size, 3);

    mock.workspace.changeText(cells[0].document, 'const ok = 1;\nlet x = ok;');
    assert.deepEqual(problems(0), []);
    mock.workspace.changeText(cells[2].document, '@CTL(reasoning="max") Summarize @ok.');
    assert.deepEqual(problems(2).map(item => [item.message, item.range]), [['@CTL: reasoning must be low, medium, or high', range(0, 5, 36)]]);
    mock.workspace.removeCell(notebook, cells[1]);
    assert.deepEqual([...syntax.keys()], [cells[2].document.uri.toString()]);

    cells[3].document.languageId = 'python';
    mock.workspace.changeText(cells[3].document, 'print(1)');
    assert.match(problems(3)[0].message, /unsupported workflow cell language 'python'/);
    assert.ok(mock.outputLines.some(line => line.startsWith('Notebook validation failed:')));
    mock.workspace.close(notebook);
    assert.equal(syntax.size, 0);
});

test('notebook commands check their context before opening or resetting a notebook', async () => {
    const { notebook } = setup(fence('42'));
    const open = mock.registeredCommands.get('spl.openNotebook')!;
    const reset = mock.registeredCommands.get('spl.resetNotebook')!;
    await open();
    assert.match(mock.messages.at(-1) ?? '', /Open an SPL workflow Markdown file first/);
    mock.window.activeTextEditor = { document: new mock.TextDocument(new mock.Uri('file', 'notes.md'), 'markdown', '# Notes\n\n' + fence('42')) };
    await open();
    assert.match(mock.messages.at(-1) ?? '', /SPL notebooks require workflow frontmatter/);
    assert.deepEqual(mock.executedCommands, []);
    const workflow = new mock.TextDocument(new mock.Uri('file', 'workflow.md'), 'markdown', DEFAULT_FRONTMATTER + '\n\n' + fence('42'));
    mock.window.activeTextEditor = { document: workflow };
    await open();
    assert.deepEqual(mock.executedCommands, [['vscode.openWith', workflow.uri, 'spl-workflow']]);

    await reset();
    assert.match(mock.messages.at(-1) ?? '', /SPL notebook session cleared/);
    notebook.notebookType = 'jupyter-notebook';
    await reset();
    assert.match(mock.messages.at(-1) ?? '', /Open an SPL notebook before resetting its session/);
});

for (const id of ['GitHub.copilot-chat', 'GitHub.copilot']) {
    test(`SPL notebook describes the JavaScript library to ${id} inline suggestions`, async () => {
        const { notebook } = setup(fence('let count = 1;') + '\n\n> Use @count.\n\n' + fence('const total: number = count;', 'ts'));
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
        assert.equal(provider.id, 'spl-notebook-library');
        assert.deepEqual(provider.selector, ['javascript', 'typescript'].map(language => ({ language, scheme: 'vscode-notebook-cell' })));
        const registered = provider;
        const resolve = (uri: string, languageId = 'javascript', cancelled = false) => registered.resolver.resolve(
            { documentContext: { uri, languageId } }, { isCancellationRequested: cancelled },
        );
        const [script, instruction, typed] = notebook.getCells().map(cell => cell.document.uri.toString());
        const traits = await resolve(script);
        assert.deepEqual(traits.map(trait => [trait.name, trait.importance]), [['SPL workflow library', 100], ['SPL workflow example', 100]]);
        const [guide, example] = traits.map(trait => trait.value);
        for (const help of Object.values(library)) assert.ok(guide.includes(`${help.signature}: ${help.description}`), help.signature);
        assert.match(guide, /native JavaScript on Node\.js/);
        assert.match(guide, /always await ask, think, agent/);
        assert.doesNotMatch(guide, /\bdef \w+\(|spl fence|```spl/);
        const compiled = compileCell(example);
        assert.deepEqual(compiled.declarations.map(item => item.name), ['Topic', 'Triage', 'triage']);
        assert.equal(compiled.statements.at(-1), 'ExpressionStatement');
        assert.match(example, /await ask\(`Classify: \$\{issue\}`, \{ schema: Triage, repairs: 2 \}\)/);
        assert.match(example, /\nsuccess\(triage\);$/);
        assert.deepEqual(await resolve(typed, 'typescript'), traits);
        assert.deepEqual(await resolve(script, 'javascript', true), []);
        assert.deepEqual(await resolve(instruction, 'markdown'), []);
        assert.deepEqual(await resolve(instruction), []);
        assert.deepEqual(await resolve('file:///workflow.md'), []);
        notebook.notebookType = 'jupyter-notebook';
        assert.deepEqual(await resolve(script), []);
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
    assert.equal(notebook.getCells()[0].document.languageId, 'javascript');
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
    const { notebook, controller } = setup([
        fence("let count = 2;\nfunction broken() {\n    fail('original');\n}"), fence('count += 1;\ncount'), fence('count += 1;\ncount'),
        fence('broken()'), fence('const total: number = count * 2;\n({ total })', 'ts'),
    ].join('\n\n'));
    assert.deepEqual([controller.supportedLanguages, controller.supportsExecutionOrder], [['javascript', 'typescript', 'markdown'], true]);
    const cells = notebook.getCells();
    await controller.executeHandler([cells[0]], notebook);
    await Promise.all([
        controller.executeHandler([cells[2]], notebook),
        controller.executeHandler([cells[1]], notebook),
    ]);
    assert.deepEqual(mock.executions.map(execution => execution.executionOrder), [1, 2, 3]);
    assert.equal(mock.executions[0].outputs.length, 1, 'declarations have no result');
    assert.equal(mock.executions[1].outputs.at(-1)!.items[0].text, '3');
    assert.equal(mock.executions[2].outputs.at(-1)!.items[0].text, '4');
    await controller.executeHandler([cells[4]], notebook);
    assert.equal(mock.executions[3].outputs.at(-1)!.items[0].text, '{\n  "total": 8\n}');
    await controller.executeHandler([cells[3]], notebook);
    assert.equal(mock.executions[4].success, false);
    assert.equal(mock.executions[4].outputs.at(-1)!.items[0].error?.message, `explicit_failure: original\n${cells[0].document.uri}:3:1`);
    const runtime = mock.diagnostics.get('spl-notebook-runtime')!;
    assert.deepEqual(runtime.get(cells[0].document.uri.toString())?.map(item => [item.message, item.range]),
        [['explicit_failure: original', range(2, 0, 21)]]);
    mock.workspace.changeText(cells[0].document, 'let count = 99;');
    assert.equal(runtime.size, 0);
    await controller.executeHandler([cells[3]], notebook);
    assert.equal(runtime.size, 0, 'Do not highlight stale locations in edited function definitions');
    mock.workspace.changeText(cells[3].document, 'const value = ;');
    await controller.executeHandler([cells[3]], notebook);
    assert.deepEqual(runtime.get(cells[3].document.uri.toString())?.map(item => [item.message, item.range]), [['Unexpected token', range(0, 14, 15)]]);
    await mock.registeredCommands.get('spl.resetNotebook')?.();
    assert.equal(runtime.size, 0);
    await controller.executeHandler([cells[1]], notebook);
    const last = mock.executions.at(-1)!;
    assert.equal(last.executionOrder, 1);
    assert.equal(last.success, false);
    assert.match(last.outputs.at(-1)!.items[0].error?.message ?? '', /^runtime_error: ReferenceError: count is not defined\n/);
});

test('untrusted notebooks cannot execute cells', async () => {
    const { notebook, controller } = setup(fence("await writeFile('must-not-exist', 'test');"));
    mock.workspace.isTrusted = false;
    await controller.executeHandler(notebook.getCells(), notebook);
    assert.equal(mock.executions.length, 0);
    assert.match(mock.messages.at(-1) ?? '', /Trust this workspace/);
});

test('cancellation ends running and queued cells and allows a clean session restart', async () => {
    const { notebook, controller } = setup(fence('while (true) {}') + '\n\n' + fence('42'));
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
