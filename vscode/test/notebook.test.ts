import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { decodeWorkflow, encodeWorkflow, parseWorkflowCell, DEFAULT_FRONTMATTER } from '../src/notebookFormat';
import { NotebookKernel } from '../src/notebookKernel';
import { extractMarkdown, parseMarkdown } from '../../lang/src/markdown.js';

const source = (body: string) => DEFAULT_FRONTMATTER + '\n\n' + body;
const fence = (code: string) => '```spl\n' + code + '\n```';

test('notebook codec roundtrips every shipped workflow exactly', () => {
    const examples = path.resolve(__dirname, '..', '..', '..', 'lang', 'examples');
    for (const file of readdirSync(examples).filter(file => file.endsWith('.md'))) {
        const markdown = readFileSync(path.join(examples, file), 'utf8');
        assert.equal(encodeWorkflow(decodeWorkflow(markdown)), markdown, file);
    }
});

test('basics workflow parses every executable cell and uses an instruction cell for factorial', () => {
    const markdown = readFileSync(path.resolve(__dirname, '..', '..', '..', 'lang', 'examples', 'basics.md'), 'utf8');
    const notebook = decodeWorkflow(markdown);
    for (const cell of notebook.cells) {
        if (cell.kind === 'markdown') continue;
        parseWorkflowCell(cell.value, cell.kind === 'spl' ? 'spl' : 'markdown', notebook.frontmatter);
    }
    assert.ok(notebook.cells.some(cell => cell.kind === 'natural' &&
        /invoke @factorial with 15 as argument -> @fact15/i.test(cell.value)));
});

test('notebook codec preserves prose, alternate fences, lazy quotes, CRLF and BOM', () => {
    for (const body of [
        '', '# Notes\n\nNo executable blocks.\n', fence(''), fence('let x = 1'),
        '~~~spl\nlet x = 1\n~~~\n> Use @x\nlazy continuation\n>\n> Next paragraph.\n\n## Notes\n',
        '## Notes\n\n' + fence('let x = 1') + '\n\n> Increment @x.\n\n' + fence('x') + '\n',
        '```text\n> Not executable\n```\n\n<!--\n> Not executable either\n-->\n\n' + fence('pass'),
    ]) {
        const markdown = source(body);
        assert.equal(encodeWorkflow(decodeWorkflow(markdown)), markdown);
        const windows = '\uFEFF' + markdown.replace(/\n/g, '\r\n');
        assert.equal(encodeWorkflow(decodeWorkflow(windows)), windows);
    }
});

test('edited and newly inserted cells produce executable Markdown with safe fences', () => {
    const notebook = decodeWorkflow(source(fence('let x = 1') + '\n\n> Increment @x.'));
    notebook.cells[0].value = "let x = '```'\n";
    notebook.cells[1].value = 'Use @x.';
    notebook.cells.push({ kind: 'spl', value: 'success x' });
    const encoded = encodeWorkflow(notebook);
    assert.match(encoded, /````spl/);
    assert.match(encoded, /> Use @x\./);
    assert.deepEqual(extractMarkdown(encoded).blocks.map(block => block.kind), ['spl', 'natural', 'spl']);
    assert.equal(parseMarkdown(encoded).body.length, 3);
});

test('instruction cells hide outer quote markers and preserve multiline guidance when saved', () => {
    const markdown = source('> @ENFORCE Answer in Chinese\n>\n> @FORBID Mentioning the word cat\n>\n> Paragraph about a pet animal -> @animal\n');
    const notebook = decodeWorkflow(markdown);
    const instruction = '@ENFORCE Answer in Chinese\n\n@FORBID Mentioning the word cat\n\nParagraph about a pet animal -> @animal';
    assert.equal(notebook.cells[0].kind, 'natural');
    assert.equal(notebook.cells[0].value, instruction);
    assert.equal(encodeWorkflow(notebook), markdown);
    assert.deepEqual(parseWorkflowCell(instruction, 'markdown', notebook.frontmatter).body,
        [{ t: 'natural', text: instruction, line: 1 }]);

    notebook.cells[0].value = instruction.replace('pet animal', 'pet dog');
    const encoded = encodeWorkflow(notebook);
    assert.equal(extractMarkdown(encoded).blocks[0].text, notebook.cells[0].value);
    assert.equal(decodeWorkflow(encoded).cells[0].value, notebook.cells[0].value);
});

test('instruction cells preserve nested quotes, lazy continuations and embedded Markdown', () => {
    for (const body of [
        '> > Nested quotation\n>\n> Follow this instruction.',
        '> Instruction\nlazy continuation\n>\n> Next paragraph.',
        '> ```spl\n> pass\n> ```\n>\n> Explain this example.',
    ]) {
        const markdown = source(body);
        const notebook = decodeWorkflow(markdown);
        const instruction = extractMarkdown(markdown).blocks[0].text;
        assert.equal(notebook.cells[0].value, instruction);
        assert.equal(encodeWorkflow(notebook), markdown);
        assert.deepEqual(parseWorkflowCell(instruction, 'markdown', notebook.frontmatter).body,
            [{ t: 'natural', text: instruction, line: 1 }]);
        notebook.cells[0].value += '\nMore instructions.';
        assert.equal(extractMarkdown(encodeWorkflow(notebook)).blocks[0].text, notebook.cells[0].value);
    }
});

test('moving and deleting cells does not concatenate their fences', () => {
    const notebook = decodeWorkflow(source(fence('let x = 1') + '\n\nNotes\n\n' + fence('success x')));
    const code = notebook.cells.filter(cell => cell.kind === 'spl');
    notebook.cells = [code[1], code[0]];
    assert.equal(extractMarkdown(encodeWorkflow(notebook)).blocks.length, 2);
});

test('edited CRLF cell text does not duplicate carriage returns when saving', () => {
    const notebook = decodeWorkflow(source(fence('pass')).replace(/\n/g, '\r\n'));
    notebook.cells[0].value = 'let x = 1\r\nx\r\n';
    const encoded = encodeWorkflow(notebook);
    assert.ok(!encoded.includes('\r\r'));
    assert.equal(parseMarkdown(encoded).body.length, 2);
});

test('cell parsing inherits model/preamble and does not parse unrelated cells', () => {
    const header = DEFAULT_FRONTMATTER.replace('\n---', '\nmodel: test-model\npreamble: Be precise.\n---');
    const program = parseWorkflowCell('1 + 1', 'spl', header);
    assert.equal(program.directives.model, 'test-model');
    assert.equal(program.markdown?.preamble, 'Be precise.');
    assert.deepEqual(parseWorkflowCell('Use @x.\ncontinued', 'markdown', header).body,
        [{ t: 'natural', text: 'Use @x.\ncontinued', line: 1 }]);
    assert.throws(() => parseWorkflowCell("@(model='other')\npass", 'spl', header), /frontmatter/);
    assert.throws(() => parseWorkflowCell('pass', 'python', header), /unsupported/);
    assert.deepEqual(parseWorkflowCell('Instruction.\n\nAnother paragraph.', 'markdown', header).body,
        [{ t: 'natural', text: 'Instruction.\n\nAnother paragraph.', line: 1 }]);
    assert.throws(() => decodeWorkflow('# Ordinary Markdown'), /frontmatter/);
});

test('isolated worker executes out of order, pretty prints results and survives errors', async t => {
    const workerPath = path.resolve(__dirname, '..', 'notebookWorker.cjs');
    const kernel = new NotebookKernel(workerPath, process.cwd(), process.execPath, () => {});
    const other = new NotebookKernel(workerPath, process.cwd(), process.execPath, () => {});
    t.after(() => { kernel.dispose(); other.dispose(); });
    let id = 0;
    const execute = (value: string, origin = 'cell:current', instance = kernel) => instance.execute({
        id: ++id, value, source: origin, frontmatter: DEFAULT_FRONTMATTER, language: 'spl',
    }, () => {});
    assert.equal((await execute('let count = 2\ndef double():\n    return count * 2', 'cell:definitions')).kind, 'result');
    await execute('count += 1');
    const result = await execute("{'count': count, 'double': double()}");
    assert.equal(result.kind, 'result');
    if (result.kind === 'result') assert.equal(result.text, '{\n  "count": 3,\n  "double": 6\n}');
    assert.equal((await execute('count', 'cell:other', other)).kind, 'error');
    const failure = await execute('let x =');
    assert.equal(failure.kind, 'error');
    if (failure.kind === 'error') { assert.equal(failure.line, 1); assert.ok(failure.column > 1); }
    await execute("def broken():\n    fail 'broken'", 'cell:broken');
    const runtimeFailure = await execute('broken()');
    assert.equal(runtimeFailure.kind, 'error');
    if (runtimeFailure.kind === 'error') {
        assert.equal(runtimeFailure.source, 'cell:broken');
        assert.equal(runtimeFailure.line, 2);
    }
    const recovered = await execute('double()');
    assert.equal(recovered.kind, 'result');
    if (recovered.kind === 'result') assert.equal(recovered.text, '6');
    const cyclic = await execute('let cyclic = []\ncyclic.append(cyclic)\ncyclic');
    assert.equal(cyclic.kind, 'result');
    if (cyclic.kind === 'result') assert.match(cyclic.text ?? '', /circular reference/);
});

test('cancelling a running worker stops unbounded code and rejects queued work', async t => {
    const kernel = new NotebookKernel(path.resolve(__dirname, '..', 'notebookWorker.cjs'), process.cwd(), process.execPath, () => {});
    t.after(() => kernel.dispose());
    const running = kernel.execute({
        id: 1, value: 'while True:\n    pass', source: 'cell:loop', frontmatter: DEFAULT_FRONTMATTER, language: 'spl',
    }, () => {});
    const rejection = assert.rejects(running, /cancelled/);
    await new Promise(resolve => setTimeout(resolve, 200));
    kernel.dispose('Execution cancelled');
    await rejection;
    assert.ok(kernel.isStopped);
    await assert.rejects(kernel.execute({
        id: 2, value: '1', source: 'cell:next', frontmatter: DEFAULT_FRONTMATTER, language: 'spl',
    }, () => {}), /cancelled/);
});

test('worker keeps state/model logs separate from explicit output and uses current cells without native UI', async t => {
    const workerPath = path.resolve(__dirname, '..', 'notebookWorker.cjs');
    const bundled = readFileSync(workerPath, 'utf8');
    assert.doesNotMatch(bundled, /@bettertui|cli-renderer\.js|setRawMode/);
    const kernel = new NotebookKernel(workerPath, process.cwd(), process.execPath, () => {});
    t.after(() => kernel.dispose());
    const first: { text: string; output: boolean }[] = [];
    const second: { text: string; output: boolean }[] = [];
    await kernel.execute({ id: 1, value: 'let items = []\ndef change(x):\n    x.append(1)',
        source: 'cell:first', frontmatter: DEFAULT_FRONTMATTER, language: 'spl' },
        (text, output) => first.push({ text, output }));
    const count = first.length;
    const result = await kernel.execute({ id: 2, value: "change(items)\nlog('explicit')\nitems",
        source: 'cell:second', frontmatter: DEFAULT_FRONTMATTER, language: 'spl' },
        (text, output) => second.push({ text, output }));
    assert.equal(first.length, count);
    assert.deepEqual(result, { id: 2, kind: 'result', text: '[\n  1\n]' });
    assert.ok(second.some(log => log.text.startsWith('~ state') && !log.output));
    assert.deepEqual(second.filter(log => log.output), [{ text: '[info] log: explicit', output: true }]);
    assert.ok(!second.some(log => /deterministic|line \d+ \(/.test(log.text)));
});
