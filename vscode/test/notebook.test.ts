import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';
import { CELL_LANGUAGES, decodeWorkflow, encodeWorkflow, parseWorkflowCell, DEFAULT_FRONTMATTER } from '../src/notebookFormat';
import { NotebookKernel } from '../src/notebookKernel';
import type { CellResult, ExecuteCell, WorkerReply } from '../src/notebookProtocol';
import { SplSyntaxError } from '../../lang/src/errors.js';
import { extractMarkdown, isWorkflowMarkdown, parseMarkdown } from '../../lang/src/markdown.js';
import type { ModelStreamEvent } from '../../lang/src/log-events.js';

const source = (body: string) => DEFAULT_FRONTMATTER + '\n\n' + body;
const fence = (code: string, language = 'js') => '```' + language + '\n' + code + '\n```';
const header = DEFAULT_FRONTMATTER.replace('\n---', '\nmodel: openai/gpt-4.1\npreamble: Be precise.\n---');
const workerPath = path.resolve(__dirname, '..', 'notebookWorker.cjs');
const examples = path.resolve(__dirname, '..', '..', '..', 'lang', 'examples');
const workflows = readdirSync(examples, { recursive: true, encoding: 'utf8' })
    .filter(file => file.endsWith('.md')).map(file => file.replaceAll('\\', '/')).sort()
    .map(file => ({ file, markdown: readFileSync(path.join(examples, file), 'utf8') }))
    .filter(({ markdown }) => isWorkflowMarkdown(markdown));

let requests = 0;
const cell = (value: string, options: Partial<ExecuteCell> = {}): ExecuteCell => ({
    id: ++requests, value, language: 'javascript', frontmatter: DEFAULT_FRONTMATTER, source: 'cell:current', ...options,
});
const scratch = (t: TestContext, prefix: string) => {
    const directory = mkdtempSync(path.join(os.tmpdir(), prefix));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    return directory;
};
const kernel = (t: TestContext, script = workerPath, log: (text: string) => void = () => {}) => {
    const result = new NotebookKernel(script, process.cwd(), process.execPath, log);
    t.after(() => result.dispose());
    return result;
};
/** The result of a cell with the logs and stream events sent before it. */
interface Replies {
    result: CellResult;
    replies: WorkerReply[];
}
/** Runs the packaged worker in its own folder, without provider credentials, keeping every reply of a cell. */
const worker = (t: TestContext, prefix: string) => {
    const directory = mkdtempSync(path.join(os.tmpdir(), prefix));
    const child = fork(workerPath, [], {
        cwd: directory, execArgv: [], silent: true,
        env: {
            ...process.env, SPL_HOME: directory, SPL_PROVIDER: '',
            OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '',
            GOOGLE_GENERATIVE_AI_API_KEY: '', GOOGLE_API_KEY: '', GEMINI_API_KEY: '',
        },
    });
    t.after(async () => {
        if (child.exitCode === null && child.signalCode === null) {
            const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
            child.kill();
            await exited;
        }
        rmSync(directory, { recursive: true, force: true });
    });
    const execute = (value: string, options: Partial<ExecuteCell> = {}) => new Promise<Replies>((resolve, reject) => {
        const request = cell(value, options);
        const replies: WorkerReply[] = [];
        const exit = () => reject(new Error('worker exited before replying'));
        const message = (reply: WorkerReply) => {
            if (reply.id !== request.id) return;
            if (reply.kind === 'log' || reply.kind === 'stream') {
                replies.push(reply);
                return;
            }
            child.off('message', message).off('error', reject).off('exit', exit);
            resolve({ result: reply, replies });
        };
        child.on('message', message).once('error', reject).once('exit', exit);
        child.send(request);
    });
    return { directory, execute };
};
const text = (result: CellResult) => result.kind === 'result' ? result.text : assert.fail(result.message);
const failure = (result: CellResult) => result.kind === 'error' ? result : assert.fail(`unexpected result ${result.text}`);

test('notebook codec roundtrips every shipped workflow exactly', () => {
    for (const expected of ['basics.md', 'deterministic/types.md', 'imports/run.md']) {
        assert.ok(workflows.some(({ file }) => file === expected), expected);
    }
    for (const { file, markdown } of workflows) assert.equal(encodeWorkflow(decodeWorkflow(markdown)), markdown, file);
});

test('every executable cell of the shipped workflows compiles on its own', () => {
    let executable = 0;
    for (const { file, markdown } of workflows) {
        const notebook = decodeWorkflow(markdown);
        const steps = parseMarkdown(markdown).steps;
        const cells = notebook.cells.filter(item => item.kind !== 'markdown');
        assert.deepEqual(cells.map(item => item.kind), steps.map(step => step.kind), file);
        for (const item of cells) {
            const language = item.kind === 'code' ? CELL_LANGUAGES[item.language ?? 'js'] : 'markdown';
            assert.equal(parseWorkflowCell(item.value, language, notebook.frontmatter).steps.length, 1, file);
            executable++;
        }
    }
    assert.ok(executable > workflows.length);
    const basics = decodeWorkflow(workflows.find(({ file }) => file === 'basics.md')!.markdown);
    assert.ok(basics.cells.some(item => item.kind === 'natural' &&
        /invoke @factorial with 15 as argument -> @fact15/i.test(item.value)));
    assert.ok(basics.cells.some(item => item.kind === 'code' && item.language === 'js' && /function factorial\(n\)/.test(item.value)));
});

test('notebook codec preserves prose, alternate fences, lazy quotes, CRLF and BOM', () => {
    for (const body of [
        '', '# Notes\n\nNo executable blocks.\n', fence(''), fence('let x = 1;'), fence('const x: number = 1;', 'ts'),
        '~~~javascript\nlet x = 1;\n~~~\n> Use @x\nlazy continuation\n>\n> Next paragraph.\n\n## Notes\n',
        '## Notes\n\n' + fence('let x = 1;') + '\n\n> Increment @x.\n\n' + fence('x', 'typescript') + '\n',
        '```text\n> Not executable\n```\n\n<!--\n> Not executable either\n-->\n\n' + fence('void 0;'),
        fence('never.runs();', 'js ignore') + '\n\n' + fence('print("commentary")', 'python') + '\n\n' + fence('1 + 1'),
    ]) {
        const markdown = source(body);
        assert.equal(encodeWorkflow(decodeWorkflow(markdown)), markdown);
        const windows = '\uFEFF' + markdown.replace(/\n/g, '\r\n');
        assert.equal(encodeWorkflow(decodeWorkflow(windows)), windows);
    }
});

test('code cells keep their fence language, and prose keeps fences that do not run', () => {
    const markdown = source(fence('const n = 1;', 'javascript') + '\n\n' + fence('const m: number = n;', 'mts') + '\n\n' +
        fence('skipped();', 'js no-run') + '\n\n' + fence('echo commentary', 'sh') + '\n');
    const notebook = decodeWorkflow(markdown);
    assert.deepEqual(notebook.cells.map(item => [item.kind, item.language, item.value.trim().split('\n')[0]]), [
        ['code', 'js', 'const n = 1;'], ['code', 'ts', 'const m: number = n;'], ['markdown', undefined, '```js no-run'],
    ]);
    assert.match(notebook.cells[2].value, /```sh\necho commentary\n```/);
    notebook.cells[0].language = 'ts';
    notebook.cells[1].value = 'const m: number = n + 1;';
    const encoded = encodeWorkflow(notebook);
    assert.match(encoded, /```ts\nconst n = 1;\n```\n\n```ts\nconst m: number = n \+ 1;\n```\n\n```js no-run/);
    assert.deepEqual(extractMarkdown(encoded).blocks.map(block => block.language), ['ts', 'ts']);
    assert.throws(() => decodeWorkflow(source('```spl\nlet x = 1\n```')), /spl fences are no longer supported/);
    assert.throws(() => decodeWorkflow('# Ordinary Markdown'), /frontmatter/);
});

test('edited and newly inserted cells produce executable Markdown with safe fences', () => {
    const notebook = decodeWorkflow(source(fence('let x = 1;') + '\n\n> Increment @x.'));
    notebook.cells[0].value = "let x = '```';\n";
    notebook.cells[1].value = 'Use @x.';
    notebook.cells.push({ kind: 'code', value: 'const y: number = 2;', language: 'ts' }, { kind: 'code', value: 'success(x);' });
    const encoded = encodeWorkflow(notebook);
    assert.match(encoded, /````js\nlet x = '```';\n````/);
    assert.match(encoded, /> Use @x\./);
    assert.ok(encoded.endsWith('```ts\nconst y: number = 2;\n```\n\n```js\nsuccess(x);\n```'));
    assert.deepEqual(extractMarkdown(encoded).blocks.map(block => block.language ?? block.kind), ['js', 'natural', 'ts', 'js']);
    assert.equal(parseMarkdown(encoded).steps.length, 4);
});

test('instruction cells hide outer quote markers and preserve multiline guidance when saved', () => {
    const markdown = source("> @CTL(enforce='Answer in Chinese', forbid='Mentioning the word cat')\n>\n> Paragraph about a pet animal -> @animal\n");
    const notebook = decodeWorkflow(markdown);
    const instruction = "@CTL(enforce='Answer in Chinese', forbid='Mentioning the word cat')\n\nParagraph about a pet animal -> @animal";
    assert.equal(notebook.cells[0].kind, 'natural');
    assert.equal(notebook.cells[0].value, instruction);
    assert.equal(encodeWorkflow(notebook), markdown);
    assert.deepEqual(parseWorkflowCell(instruction, 'markdown', notebook.frontmatter).steps,
        [{ kind: 'natural', text: 'Paragraph about a pet animal -> @animal', line: 1,
            controls: { enforce: 'Answer in Chinese', forbid: 'Mentioning the word cat' } }]);

    notebook.cells[0].value = instruction.replace('pet animal', 'pet dog');
    const encoded = encodeWorkflow(notebook);
    assert.equal(extractMarkdown(encoded).blocks[0].text, notebook.cells[0].value);
    assert.equal(decodeWorkflow(encoded).cells[0].value, notebook.cells[0].value);
});

test('instruction cells preserve nested quotes, lazy continuations and embedded Markdown', () => {
    for (const body of [
        '> > Nested quotation\n>\n> Follow this instruction.',
        '> Instruction\nlazy continuation\n>\n> Next paragraph.',
        '> ```js\n> const example = 1;\n> ```\n>\n> Explain this example.',
    ]) {
        const markdown = source(body);
        const notebook = decodeWorkflow(markdown);
        const instruction = extractMarkdown(markdown).blocks[0].text;
        assert.deepEqual(notebook.cells.map(item => item.kind), ['natural']);
        assert.equal(notebook.cells[0].value, instruction);
        assert.equal(encodeWorkflow(notebook), markdown);
        assert.deepEqual(parseWorkflowCell(instruction, 'markdown', notebook.frontmatter).steps,
            [{ kind: 'natural', text: instruction, line: 1 }]);
        notebook.cells[0].value += '\nMore instructions.';
        assert.equal(extractMarkdown(encodeWorkflow(notebook)).blocks[0].text, notebook.cells[0].value);
    }
});

test('moving and deleting cells does not concatenate their fences', () => {
    const notebook = decodeWorkflow(source(fence('let x = 1;') + '\n\nNotes\n\n' + fence('success(x);')));
    const code = notebook.cells.filter(item => item.kind === 'code');
    notebook.cells = [code[1], code[0]];
    assert.deepEqual(extractMarkdown(encodeWorkflow(notebook)).blocks.map(block => block.text), ['success(x);', 'let x = 1;']);
});

test('edited CRLF cell text does not duplicate carriage returns when saving', () => {
    const notebook = decodeWorkflow(source(fence('void 0;')).replace(/\n/g, '\r\n'));
    notebook.cells[0].value = 'let x = 1;\r\nx\r\n';
    const encoded = encodeWorkflow(notebook);
    assert.ok(!encoded.includes('\r\r'));
    assert.ok(encoded.endsWith('```js\r\nlet x = 1;\r\nx\r\n```'));
    const [step] = parseMarkdown(encoded).steps;
    assert.deepEqual(step.kind === 'code' && step.cell.statements, ['VariableDeclaration', 'ExpressionStatement']);
});

test('code cells compile as JavaScript or erasable TypeScript and inherit model and preamble', () => {
    const workflow = parseWorkflowCell('const sum = 1 + 1;\nsum', 'javascript', header);
    assert.equal(workflow.model, 'openai/gpt-4.1');
    assert.equal(workflow.markdown?.preamble, 'Be precise.');
    const [step] = workflow.steps;
    assert.ok(step.kind === 'code' && step.line === 1 && step.cell.language === 'js');
    assert.deepEqual(step.cell.declarations.map(item => [item.name, item.kind]), [['sum', 'const']]);

    const [typed] = parseWorkflowCell('const total: number = 2;\ninterface Row { id: number }', 'typescript', header).steps;
    assert.ok(typed.kind === 'code' && typed.cell.language === 'ts');
    assert.match(typed.cell.code, /total {9}= 2/);

    const syntax = (value: string, language: string, line: number, col: number, message: RegExp) => assert.throws(
        () => parseWorkflowCell(value, language, header),
        (error: unknown) => error instanceof SplSyntaxError && error.line === line && error.col === col && message.test(error.message),
        value,
    );
    syntax('let x =', 'javascript', 1, 8, /Unexpected token/);
    syntax('const ok = 1;\nconst total: number = 2;', 'javascript', 2, 12, /Unexpected token/);
    syntax('export const shared = 1;\nexport default shared;', 'javascript', 2, 1, /exports are not supported/);
    syntax('enum Color { Red }', 'typescript', 1, 1, /Only erasable type syntax is supported/);
    for (const language of ['spl', 'python']) {
        assert.throws(() => parseWorkflowCell('1', language, header), /unsupported workflow cell language/);
    }
    assert.throws(() => parseWorkflowCell('1', 'javascript', '---\nextension: other\nversion: 1\n---'), /frontmatter requires extension/);
});

test('instruction cells parse as one blockquote with literal controls and code generation', () => {
    const steps = (value: string) => parseWorkflowCell(value, 'markdown', header).steps;
    assert.deepEqual(steps('Use @x.\ncontinued'), [{ kind: 'natural', text: 'Use @x.\ncontinued', line: 1 }]);
    assert.deepEqual(steps('Instruction.\n\nAnother paragraph.'), [{ kind: 'natural', text: 'Instruction.\n\nAnother paragraph.', line: 1 }]);
    const controlled = parseWorkflowCell('@CTL(model="quote", reasoning="low", restrict={fs: ["./src"]}) Use @x.', 'markdown', header);
    assert.deepEqual(controlled.steps, [{
        kind: 'natural', line: 1, text: 'Use @x.',
        controls: { model: 'quote', reasoning: 'low', restrict: { fs: ['./src'] } },
    }]);
    assert.equal(controlled.model, 'openai/gpt-4.1');
    assert.equal(controlled.markdown?.preamble, 'Be precise.');
    assert.deepEqual(steps("@CTL(enforce=`Plain\ntext`)\n@CODEGEN 'Define double(value), returning value * 2'"), [{
        kind: 'natural', line: 1, text: 'Define double(value), returning value * 2', codegen: true, controls: { enforce: 'Plain\ntext' },
    }]);
    assert.throws(() => steps('@CTL(reasoning="invalid") Act.'), /reasoning must be low, medium, or high/);
    assert.throws(() => steps('Act.\n@CTL(reasoning="low")'), /@CTL must appear once at the start/);
    assert.throws(() => steps('@Human Approve?'), /removed/);
    assert.throws(() => steps("Then @CODEGEN 'Define later()'"), /@CODEGEN must appear at the start/);
});

test('kernel forwards live stream IPC updates without resolving the cell early', async t => {
    const script = path.join(scratch(t, 'spl-notebook-stream-'), 'worker.cjs');
    writeFileSync(script, `process.on('message', request => {
        const interaction = { kind: 'ask', requestId: String(request.id) };
        const event = { type: 'update', interaction, update: { channel: 'response', messageId: 'answer', mode: 'append', text: 'Partial' } };
        process.send({ id: request.id + 1, kind: 'stream', event });
        process.send({ id: request.id, kind: 'stream', event });
        process.send({ id: request.id, kind: 'log', text: '[info] log: shown', output: true });
        setTimeout(() => {
            process.send({ id: request.id, kind: 'stream', event: { type: 'end', interaction, outcome: 'completed', response: 'Complete' } });
            process.send({ id: request.id, kind: 'result', text: 'Complete' });
        }, 20);
    });`);
    const events: ModelStreamEvent[] = [];
    const logs: [string, boolean][] = [];
    let finished = false;
    const request = cell("await ask('Prompt')", { source: 'cell:stream' });
    const result = await kernel(t, script).execute(request, (line, output) => logs.push([line, output]), event => {
        assert.equal(finished, false);
        events.push(event);
    });
    finished = true;
    assert.deepEqual(events.map(event => event.type), ['update', 'end']);
    assert.deepEqual(logs, [['[info] log: shown', true]]);
    assert.deepEqual(result, { id: request.id, kind: 'result', text: 'Complete' });
});

test('kernel diagnoses invalid stream payloads rather than resolving them as cell results', async t => {
    const script = path.join(scratch(t, 'spl-notebook-stream-invalid-'), 'worker.cjs');
    writeFileSync(script, `process.on('message', request => {
        process.send({ id: request.id, kind: 'stream', event: { type: 'update' } });
    });`);
    const logs: string[] = [];
    const session = kernel(t, script, line => logs.push(line));
    await assert.rejects(session.execute(cell('void 0;'), () => {}), /invalid model stream event/);
    assert.ok(logs.some(line => line.includes('invalid model stream event')));
    assert.equal(session.isStopped, true);
});

test('kernel runs one cell at a time and reports a runtime that cannot start', async t => {
    const script = path.join(scratch(t, 'spl-notebook-busy-'), 'worker.cjs');
    writeFileSync(script, `process.on('message', request => setTimeout(() => process.send({ id: request.id, kind: 'result' }), 50));`);
    const session = kernel(t, script);
    const first = session.execute(cell('1'), () => {});
    await assert.rejects(session.execute(cell('2'), () => {}), /another notebook cell is already running/);
    assert.equal((await first).kind, 'result');

    const logs: string[] = [];
    const missing = new NotebookKernel(script, process.cwd(), path.join(path.dirname(script), 'missing-node'), line => logs.push(line));
    t.after(() => missing.dispose());
    await assert.rejects(missing.execute(cell('1'), () => {}), /Could not run the SPL notebook runtime: .* Check spl\.notebook\.nodePath\./);
    assert.equal(missing.isStopped, true);
    assert.equal(logs.length, 1);
});

test('isolated worker executes out of order, pretty prints results and survives errors', async t => {
    const session = kernel(t);
    const other = kernel(t);
    const execute = (value: string, origin = 'cell:current', instance = session) => instance.execute(cell(value, { source: origin }), () => {});
    const definitions = await execute('let count = 2;\nfunction double() {\n    return count * 2;\n}', 'cell:definitions');
    assert.deepEqual(definitions, { id: requests, kind: 'result' });
    assert.equal(text(await execute('count += 1;')), '3');
    assert.equal(text(await execute('({ count, double: double() })')), '{\n  "count": 3,\n  "double": 6\n}');
    assert.equal(text(await execute("`${count} items`")), '3 items');
    assert.match(failure(await execute('count', 'cell:other', other)).message, /^runtime_error: ReferenceError: count is not defined$/);

    const syntax = failure(await execute('let x ='));
    assert.deepEqual([syntax.message, syntax.line, syntax.column, syntax.source], ['Unexpected token', 1, 8, 'cell:current']);
    await execute("function broken() {\n    fail('broken');\n}", 'cell:broken');
    const runtime = failure(await execute('broken()'));
    assert.deepEqual([runtime.message, runtime.source, runtime.line], ['explicit_failure: broken', 'cell:broken', 2]);
    const thrown = failure(await execute("const before = 1;\nthrow new TypeError('boom');"));
    assert.deepEqual([thrown.message, thrown.source, thrown.line], ['runtime_error: TypeError: boom', 'cell:current', 2]);
    assert.match(failure(await execute("assert(count > 10, 'too small')")).message, /^assertion_failed: too small$/);

    assert.equal(text(await execute('double()')), '6');
    assert.equal(text(await execute('success({ count });\ncount = 0;')), '{\n  "count": 3\n}');
    assert.equal(text(await execute('count')), '3');
    assert.match(text(await execute('const cyclic = [];\ncyclic.push(cyclic);\ncyclic')) ?? '', /circular reference/);
    assert.equal(text(await execute('double')), '"function double()"');
});

test('packaged worker runs TypeScript cells and hydrates typed data into classes across cells', async t => {
    const session = kernel(t);
    const execute = (value: string, language = 'javascript') => session.execute(
        cell(value, { language, source: `cell:conversion-${requests}` }), () => {});
    assert.equal(text(await execute(`class Person {
    constructor() {
        fail('constructor must not run');
    }
    toString() {
        return \`\${this.name} at age \${this.age}\`;
    }
}
const PersonType = struct('Person', { name: str, age: int }).class(Person);`)), undefined);
    assert.equal(text(await execute("interface Data { name: string; age: number }\nconst data: Data = { name: 'Ada', age: 37 };", 'typescript')), undefined);
    const hydrated = text(await execute(`const person = validate(data, PersonType);
[data instanceof Person, person instanceof Person, String(person), PersonType.is(person)]`));
    assert.deepEqual(JSON.parse(hydrated ?? ''), [false, true, 'Ada at age 37', true]);
    assert.match(failure(await execute("PersonType.parse({ name: 'Ada' })")).message, /^validation_failed: /);
    assert.equal(text(await execute('const ages: number[] = [person.age];\nages.map((age: number): number => age + 1)', 'typescript')), '[\n  38\n]');
    assert.match(failure(await execute('enum Color { Red }', 'typescript')).message, /Only erasable type syntax is supported/);
});

test('cancelling a running worker stops unbounded code and rejects queued work', async t => {
    const session = kernel(t);
    const running = session.execute(cell('while (true) {}', { source: 'cell:loop' }), () => {});
    const rejection = assert.rejects(running, /cancelled/);
    await new Promise(resolve => setTimeout(resolve, 200));
    session.dispose('Execution cancelled');
    await rejection;
    assert.ok(session.isStopped);
    await assert.rejects(session.execute(cell('1', { source: 'cell:next' }), () => {}), /cancelled/);
});

test('worker hides debug state logs and uses current cells without native UI', async t => {
    assert.doesNotMatch(readFileSync(workerPath, 'utf8'), /@bettertui|cli-renderer\.js|setRawMode/);
    const session = kernel(t);
    const first: { text: string; output: boolean }[] = [];
    const second: { text: string; output: boolean }[] = [];
    await session.execute(cell('const items = [];\nfunction change(x) {\n    x.push(1);\n}', { source: 'cell:first' }),
        (line, output) => first.push({ text: line, output }));
    const request = cell("change(items);\nlog('explicit', { size: items.length });\nlog.error('careful');\nlog.debug('hidden');\nitems", { source: 'cell:second' });
    const result = await session.execute(request, (line, output) => second.push({ text: line, output }));
    assert.deepEqual(first, []);
    assert.deepEqual(result, { id: request.id, kind: 'result', text: '[\n  1\n]' });
    assert.ok(!second.some(log => log.text.startsWith('~ state')));
    assert.deepEqual(second, [
        { text: '[info] log: explicit\n{\n  "size": 1\n}', output: true },
        { text: '[error] log: careful', output: true },
    ]);
});

test('packaged worker lazily loads the native backend and reports missing provider credentials', { timeout: 10_000 }, async t => {
    const { execute } = worker(t, 'spl-notebook-provider-');
    const defined = await execute("const topic = 'recursion';", { frontmatter: header });
    assert.deepEqual(defined, { result: { id: requests, kind: 'result' }, replies: [] });
    const generation = await execute("await ask('Hi')", { frontmatter: header, source: 'cell:ask', version: 4 });
    const failed = failure(generation.result);
    assert.match(failed.message, /^llm_error: no API key for openai/);
    assert.deepEqual([failed.source, failed.version, failed.line], ['cell:ask', 4, 1]);
    assert.match(failure((await execute("await ask('Hi', { model: 'anthropic/claude-sonnet-4-5' })", { frontmatter: header })).result).message,
        /^llm_error: no API key for anthropic/);
    assert.match(failure((await execute("await ask('Hi')")).result).message, /^llm_error: no provider configured/);

    const instruction = await execute('Explain @topic.', { language: 'markdown', frontmatter: header });
    assert.match(failure(instruction.result).message, /^llm_error: no API key for openai/);
    const prompt = instruction.replies.find(reply => reply.kind === 'log' && reply.text.startsWith('-> input blockquote'));
    assert.ok(prompt?.kind === 'log' && !prompt.output);
    assert.match(prompt.text, /\n\nBe precise\.\n\n/);
    assert.match(prompt.text, /"topic":\s*"recursion"/);
    assert.match(prompt.text, /Blockquote:\nExplain @topic\./);
    assert.deepEqual(instruction.replies.flatMap(reply => reply.kind === 'stream' ? [[reply.event.type, reply.event.interaction.kind]] : []),
        [['end', 'blockquote']]);
    assert.match(failure((await execute("@CTL(model='google/gemini-2.5-flash') Explain @topic.", { language: 'markdown', frontmatter: header })).result).message,
        /^llm_error: no API key for google/);
    const invalid = failure((await execute("@CTL(reasoning='max') Explain @topic.", { language: 'markdown', frontmatter: header })).result);
    assert.deepEqual([invalid.message, invalid.line, invalid.column], ['@CTL: reasoning must be low, medium, or high', 1, 6]);
});

test('packaged notebook worker imports local modules and retains live state across cells', async t => {
    const { directory, execute } = worker(t, 'spl-notebook-imports-');
    writeFileSync(path.join(directory, 'helpers.js'), 'export let count = 0;\nexport function next() {\n    count += 1;\n    return count;\n}\n');
    writeFileSync(path.join(directory, 'labels.ts'), 'export const label = (value: number): string => `#${value}`;\n');
    writeFileSync(path.join(directory, 'settings.json'), '{ "name": "demo" }\n');
    const run = async (value: string, options: Partial<ExecuteCell> = {}) => (await execute(value, options)).result;
    assert.equal(text(await run("import { next } from './helpers.js';\nnext()")), '1');
    assert.equal(text(await run("import * as helpers from './helpers.js';\n[next(), helpers.count]")), '[\n  2,\n  2\n]');
    assert.equal(text(await run("import { label } from './labels.ts';\nimport settings from './settings.json' with { type: 'json' };\n`${settings.name} ${label(next())}`")), 'demo #3');
    assert.equal(text(await run("import * as nodePath from 'node:path';\nconst { readFile: read } = await import('node:fs/promises');\n" +
        "[import.meta.dirname === process.cwd(), nodePath.basename(import.meta.filename), (await read('settings.json', 'utf8')).trim()]", { language: 'typescript' })),
        '[\n  true,\n  "workflow.md",\n  "{ \\"name\\": \\"demo\\" }"\n]');
    const missing = failure(await run("const before = 1;\nimport { nothing } from './missing.js';", { source: 'cell:missing' }));
    assert.match(missing.message, /^runtime_error: .*Cannot find module/);
    assert.deepEqual([missing.source, missing.line], ['cell:missing', 2]);
    assert.equal(text(await run("const doc = markdown.document().heading('Report', 1);\ndoc.toString()")), '# Report\n');
    assert.equal(text(await run("doc.paragraph(markdown.bold('Ready')).toString()")), '# Report\n\n**Ready**\n');
    assert.equal(text(await run("await writeFile('./out/report.md', doc.toString());\nawait readFile('./out/report.md')")), '# Report\n\n**Ready**\n');
    assert.match(failure(await run("await restrict('./out', () => writeFile('./elsewhere.md', 'no'))")).message, /^restriction_violation: /);
});
