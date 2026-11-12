import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { compileCell } from '../src/cell.js';
import { codegen, configure } from '../src/index.js';
import type { LlmBackend } from '../src/llm.js';
import { Logger } from '../src/logger.js';
import type { LogEvent, ModelStreamEvent } from '../src/log-events.js';
import { parse, parseMarkdown } from '../src/markdown.js';
import { Pin } from '../src/pin.js';
import { setAmbient } from '../src/runtime.js';
import { Trace } from '../src/trace.js';
import { ExecutionSession, run, type RunOptions, type RunResult } from '../src/workflow.js';
import { NoLlm, acting, action, backend, cleanTemp, document, fence, scripted, silent, tempDir } from './helpers.js';

const instruction = (text: string): string => `> @CODEGEN '${text}'`;
const hash = (input: string): string => createHash('sha256').update(input).digest('hex');
const signature = (input: string): string => `// @CODEGEN sha256:${hash(input)}`;
const ANSWER = 'function answer() {\n    return 42;\n}';
const answering = document(`${instruction('Define answer()')}\n\n${fence('success(answer());')}`);
let cwd: string;
let workflow: string;

beforeEach(() => {
    cwd = tempDir('spl-codegen-');
    fs.mkdirSync(path.join(cwd, 'workflows'));
    workflow = path.join(cwd, 'workflows', 'friendly-flow.md');
});
afterEach(() => {
    setAmbient(undefined);
    cleanTemp();
});

/** Generated-code cache files beside the workflow. */
const files = (): string[] => fs.readdirSync(path.dirname(workflow)).filter(file => file.endsWith('.js')).sort();
const cache = (name: string): string => path.join(path.dirname(workflow), name);
const rows = (traceFile: string): any[] => fs.readFileSync(path.join(cwd, traceFile), 'utf8').trimEnd().split('\n').map(line => JSON.parse(line));

/** Runs a Markdown workflow stored at `workflow`, optionally with a trace file in the working directory. */
async function execute(source: string, model: LlmBackend = new NoLlm(), traceFile?: string, options: Partial<RunOptions> = {}): Promise<RunResult> {
    const trace = traceFile ? Trace.open(path.join(cwd, traceFile), { source, runtime: 'test', cwd }) : undefined;
    try {
        const result = await run(parseMarkdown(source), { backend: model, logger: silent, cwd, file: workflow, ...options, trace });
        trace?.finish(result);
        return result;
    } finally {
        trace?.close();
    }
}

describe('@CODEGEN syntax', () => {
    it('parses case-insensitive markers, controls and multiline literal descriptions', () => {
        expect(parseMarkdown(document(`> @CTL(model='custom', reasoning='high')
>
> @codegen '''
> Define answer(value).
> Return value unchanged, including @references and {braces}.
> '''`)).steps).toEqual([{
            kind: 'natural', line: 6, codegen: true,
            text: '\nDefine answer(value).\nReturn value unchanged, including @references and {braces}.\n',
            controls: { model: 'custom', reasoning: 'high' },
        }]);
        expect(parseMarkdown(document(String.raw`> @CODEGEN r'Define path() returning C:\work\{literal}'`)).steps[0])
            .toEqual({ kind: 'natural', line: 6, codegen: true, text: String.raw`Define path() returning C:\work\{literal}` });
        expect(parseMarkdown(document('> @Codegen "Define tab() returning \\"\\t\\""')).steps[0]).toMatchObject({ text: 'Define tab() returning "\t"' });
        expect(parseMarkdown(document('> @CODEGEN `Define answer()`')).steps[0]).toMatchObject({ text: 'Define answer()', codegen: true });
    });

    it.each([
        ['@CODEGEN', /@CODEGEN: expected a literal string/],
        ['@CODEGEN Define a function', /expected a literal string/],
        ["@CODEGEN ''", /non-empty string/],
        ["@CODEGEN '   '", /non-empty string/],
        ['@CODEGEN `Define ${name}()`', /no interpolation/],
        ["@CODEGEN 'Define a function", /unterminated string/],
        ["@CODEGEN 'Define a function' trailing", /single literal string/],
        ["@CODEGEN 'First' @CODEGEN 'Second'", /single literal string/],
        ["Act. @CODEGEN 'Define a function'", /at the start/],
        ["@CODEGEN 'Define a function' @CTL()", /single literal string/],
        ["@CODEGEN 'Define a function' @CTL(model='late')", /single literal string/],
    ])('rejects invalid directives before execution: %s', (body, error) => {
        expect(() => parseMarkdown(document(`> ${body}`))).toThrow(error);
    });

    it('preserves string diagnostics on original multiline document lines', () => {
        expect(() => parseMarkdown(document("> @CTL(\n> model='custom')\n> @CODEGEN `${input}`")))
            .toThrow(expect.objectContaining({ name: 'SplSyntaxError', line: 8 }));
        expect(() => parseMarkdown(document("Prose.\n\n> @CODEGEN\n> 'first line\n> second line'")))
            .toThrow(expect.objectContaining({ line: 9, message: expect.stringMatching(/unterminated string/) }));
    });

    it('checks @CODEGEN syntax through the CLI without generating functions or cache files', () => {
        fs.writeFileSync(workflow, answering);
        const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
        const checked = spawnSync(process.execPath, [cli, workflow, '--check'], { cwd, encoding: 'utf8' });
        expect(checked.status, checked.stderr).toBe(0);
        expect(files()).toEqual([]);
        fs.writeFileSync(workflow, document('> @CODEGEN missing_quotes'));
        const invalid = spawnSync(process.execPath, [cli, workflow, '--check'], { cwd, encoding: 'utf8' });
        expect(invalid.status).toBe(2);
        expect(invalid.stderr).toContain('@CODEGEN');
    });
});

describe('@CODEGEN execution', () => {
    it('registers multiple functions without executing them, sharing the live document scope', async () => {
        const model = scripted('function answer(value) {\n    return helper(value) + offset;\n}\nfunction helper(value) {\n    return value * 2;\n}');
        const source = document(`${fence('let offset = 1;')}\n\n${instruction('Define answer(value) using helper(value) and offset')}\n\n${fence('offset = 2;\nsuccess(answer(3));')}`);
        expect(await execute(source, model)).toMatchObject({ status: 'success', value: 8 });
        expect(model.calls).toHaveLength(1);
        const request = model.calls[0];
        expect(request).toMatchObject({ kind: 'ask', reasoningEffort: 'medium', showReasoning: true });
        expect(request.naturalLanguage).toBeUndefined();
        expect(request.runtimeTools).toBeUndefined();
        expect(request.invokeAction).toBeUndefined();
        expect(request.prompt).toMatch(/^You are running a Semantic Prompt Language Markdown workflow\./);
        expect(request.prompt).toContain('Generate JavaScript functions implementing the literal description below.');
        expect(request.prompt).toContain('Available library functions: ask, think, agent, human, log, codegen, readFile, writeFile, webFetch, webSearch, shell, validate\n');
        expect(request.prompt).toContain('Shared bindings:\n{"offset":1}');
        expect(request.prompt.endsWith('Function description:\nDefine answer(value) using helper(value) and offset')).toBe(true);
        expect(files()).toEqual([]);
    });

    it('retains generated functions across interactive session cells', async () => {
        const session = new ExecutionSession();
        const options = { logger: silent, cwd };
        expect(await session.run(parseMarkdown(document(instruction('Define answer() returning 42'))), { ...options, backend: scripted(ANSWER) }))
            .toEqual({ status: 'success', value: null, hasValue: false });
        expect(session.bindings).toContain('answer');
        expect(await session.run(parse('answer()'), { ...options, backend: new NoLlm() })).toEqual({ status: 'success', value: 42, hasValue: true });
        const twice = scripted('function twice() {\n    return answer() * 2;\n}');
        expect(await session.run(parse("const generated = await codegen('Define twice() using answer()');"), { ...options, backend: twice }))
            .toMatchObject({ status: 'success' });
        expect(twice.calls[0].prompt).toContain('Shared bindings:\n{"answer":"function answer()"}');
        expect(await session.run(parse('[twice(), generated === twice]'), { ...options, backend: new NoLlm() })).toMatchObject({ value: [84, true] });
    });

    it('never executes function bodies during generation', async () => {
        const model = scripted("async function writeLater() {\n    await writeFile('must-not-exist.txt', 'not yet');\n    return 42;\n}");
        expect(await execute(document(instruction('Define writeLater()')), model)).toEqual({ status: 'success', value: null, hasValue: false });
        expect(fs.existsSync(path.join(cwd, 'must-not-exist.txt'))).toBe(false);
    });

    it('lets generated functions use the library, restrictions and later bindings when they are called', async () => {
        const model = scripted(
            "async function shout(topic) {\n    await writeFile('./out/topic.txt', topic);\n    return (await ask(prefix + topic)).toUpperCase();\n}",
            'quiet',
        );
        const source = document(`${instruction('Define shout(topic)')}\n\n${fence(`const prefix = 'About ';
let blocked;
try { await restrict('./elsewhere', () => shout('cats')); } catch (error) { blocked = error.statusCode; }
success([blocked, await shout('dogs'), await readFile('./out/topic.txt')]);`)}`);
        expect(await execute(source, model)).toMatchObject({ status: 'success', value: ['restriction_violation', 'QUIET', 'dogs'] });
        expect(model.calls[1].prompt).toMatch(/About dogs$/);
    });

    it('exposes generated functions to subsequent natural-language commands', async () => {
        let calls = 0;
        const model = backend(async request => {
            if (calls++ === 0) return { text: ANSWER, effective: {} };
            expect(request.naturalLanguage).toBe(true);
            expect(request.prompt).toContain('Shared bindings at command start:\n{"answer":"function answer()"}');
            const result = await request.invokeAction!(action('call_function', { name: 'answer', args: [] }));
            await request.invokeAction!(action('save_variable', { name: 'result', value: result }));
            return { text: 'Done', effective: {} };
        });
        expect(await execute(document(`${instruction('Define answer()')}\n\n> Call @answer and save to @result.\n\n${fence('success(result);')}`), model))
            .toMatchObject({ status: 'success', value: 42 });
        expect(calls).toBe(2);
    });

    it('refuses to let a blockquote replace a generated function with a variable', async () => {
        let calls = 0;
        const model = backend(async request => {
            if (calls++ === 0) return { text: ANSWER, effective: {} };
            await request.invokeAction!(action('save_variable', { name: 'answer', value: 43 }));
            return { text: 'Done', effective: {} };
        });
        expect(await execute(document(`${instruction('Define answer()')}\n\n> Save 43 to @answer.`), model)).toMatchObject({
            status: 'failure', failure: { status_code: 'runtime_error', reason: "cannot replace function 'answer' with a variable", line: 8 },
        });
    });

    it('applies controls and model precedence without leaking guidance to later calls', async () => {
        const model = scripted(ANSWER, 'later');
        const source = document(`> @CTL(model='local', reasoning='high', enforce='Keep it short', restrict={fs: ['./workflows']})
> @CODEGEN 'Define answer()'

${fence("success(await ask('Later'));")}`);
        expect(await execute(source, model, undefined, { model: 'override' })).toMatchObject({ status: 'success', value: 'later' });
        expect(model.calls[0]).toMatchObject({ model: 'override', reasoningEffort: 'high' });
        expect(model.calls[0].restrictions.list).toEqual([{ kind: 'fs', values: [path.join(cwd, 'workflows')] }]);
        expect(model.calls[0].prompt).toContain('- Follow: Keep it short');
        expect(model.calls[0].prompt).toContain(`File system: you may read and write only inside: ${path.join(cwd, 'workflows')}.`);
        expect(model.calls[1].prompt).not.toContain('Keep it short');
        expect(model.calls[1].restrictions.list).toEqual([]);
        const local = scripted(ANSWER, 'later');
        await execute(source, local);
        expect(local.calls.map(call => call.model)).toEqual(['local', undefined]);
        const documented = scripted(ANSWER);
        await execute(document(instruction('Define answer()'), 'model: doc-model\n'), documented);
        expect(documented.calls[0].model).toBe('doc-model');
    });

    it.each([
        ['', /only JavaScript function declarations/],
        [`Here is the code:\n\`\`\`js\n${ANSWER}\n\`\`\``, /invalid JavaScript/],
        [`\`\`\`js\n${ANSWER}\n\`\`\`\n\`\`\`js\nanswer();\n\`\`\``, /invalid JavaScript/],
        ['function answer(:', /invalid JavaScript: .* \(line 2\)/],
        ["writeFile('should-not-exist', 'bad');", /only JavaScript function declarations/],
        [`${ANSWER}\nawait writeFile('should-not-exist', 'bad');`, /only JavaScript function declarations/],
        [`import * as fs from 'node:fs';\n${ANSWER}`, /only JavaScript function declarations/],
        [`export ${ANSWER}`, /only JavaScript function declarations/],
        ['const answer = () => 42;', /only JavaScript function declarations/],
        ['class Answer {}', /only JavaScript function declarations/],
        ['function answer(): number {\n    return 42;\n}', /invalid JavaScript/],
    ])('rejects invalid or executable top-level output: %j', async (response, reason) => {
        const model = scripted(response);
        const first = await execute(document(instruction('Define answer()')), model, 'invalid.jsonl');
        expect(first).toMatchObject({ status: 'failure', failure: { status_code: 'invalid_format', reason: expect.stringMatching(reason), line: 6 } });
        expect(files()).toEqual([]);
        expect(fs.existsSync(path.join(cwd, 'should-not-exist'))).toBe(false);
        expect(await execute(document(instruction('Define answer()')), new NoLlm(), 'invalid.jsonl')).toEqual(first);
        expect(model.calls).toHaveLength(1);
    });

    it.each([
        ['a js fence', `\`\`\`js\n${ANSWER}\n\`\`\``],
        ['a tilde fence with surrounding blank lines', `\n~~~javascript\n${ANSWER}\n~~~\n\n`],
        ['async and generator declarations', `async function later() {\n    return answer();\n}\nfunction* each() {\n    yield 1;\n}\n${ANSWER}`],
    ])('accepts function declarations in %s', async (_, response) => {
        const source = document(`${instruction('Define answer()')}\n\n${fence('success(answer());')}`);
        expect(await execute(source, scripted(response))).toMatchObject({ status: 'success', value: 42 });
    });

    it('pins generated functions for self-contained replay without sidecars', async () => {
        const pin = Pin.capture(answering, { cwd, args: [] });
        const first = await execute(answering, scripted(ANSWER), undefined, { pin });
        expect(first).toMatchObject({ status: 'success', value: 42 });
        expect(pin.data.entries.map(entry => JSON.parse(entry.request))).toEqual([{ kind: 'store' }, { kind: 'codegen', text: 'Define answer()', line: 6 }]);
        expect(pin.data.entries[1].outcome).toEqual({ value: { text: `${signature('Define answer()')}\n${ANSWER}\n` } });
        expect(await execute(pin.toMarkdown(answering))).toEqual(first);
        expect(files()).toEqual([]);
    });
});

describe('codegen() library function', () => {
    it('returns the requested function, defines helpers in the shared scope and passes options', async () => {
        const model = scripted('function double(value) {\n    return helper(value);\n}\nfunction helper(value) {\n    return value * 2;\n}', ANSWER);
        const source = document(fence(`const twice = await codegen('Define double(value)', { model: 'code-model', reasoning: 'high' });
const answer = await codegen('Define answer()');
success([twice(4), twice === double, helper(5), answer(), twice.name]);`));
        expect(await execute(source, model)).toMatchObject({ status: 'success', value: [8, true, 10, 42, 'double'] });
        expect(model.calls[0]).toMatchObject({ kind: 'ask', model: 'code-model', reasoningEffort: 'high' });
        expect(model.calls[0].prompt.endsWith('Function description:\nDefine double(value)')).toBe(true);
        expect(model.calls[1]).toMatchObject({ kind: 'ask', model: undefined, reasoningEffort: 'medium' });
        expect(files()).toEqual([]);
    });

    it('inherits the guidance and restrictions of the calling scope', async () => {
        const model = scripted(ANSWER);
        const source = document(fence("await enforce('No recursion', () => restrict({ net: 'example.com' }, () => codegen('Define answer()')));\nsuccess(answer());"));
        expect(await execute(source, model)).toMatchObject({ status: 'success', value: 42 });
        expect(model.calls[0].prompt).toContain('- Follow: No recursion');
        expect(model.calls[0].restrictions.list).toEqual([{ kind: 'net', values: ['example.com'] }]);
    });

    it.each(["''", "'   '", '42', 'undefined'])('rejects the description %s before contacting a model', async description => {
        expect(await execute(document(fence(`await codegen(${description});`)), new NoLlm(), 'invalid.jsonl')).toMatchObject({
            status: 'failure', failure: { status_code: 'runtime_error', reason: 'codegen requires a non-empty description', line: 7 },
        });
        expect(rows('invalid.jsonl').map(row => row.type)).toEqual([undefined, 'terminal']);
    });

    it('fails with the invalid_format of the response, which the workflow can catch', async () => {
        const source = document(fence(`let code;
try { await codegen('Define answer()'); } catch (error) { code = error.statusCode; }
success([code, typeof answer]);`));
        expect(await execute(source, scripted('answer = 42;'))).toMatchObject({ status: 'success', value: ['invalid_format', 'undefined'] });
    });

    it('records one codegen effect with the call line, caches the code and replays it from the trace', async () => {
        const source = document(fence(`
const double = await codegen('Define double(value)', { reasoning: 'low' });
success(double(21));`));
        const model = scripted('function double(value) {\n    return value * 2;\n}');
        const first = await execute(source, model, 'first.jsonl');
        expect(first).toMatchObject({ status: 'success', value: 42 });
        expect(files()).toEqual(['friendly-flow.double.js']);
        const text = `${signature('Define double(value)')}\nfunction double(value) {\n    return value * 2;\n}\n`;
        expect(fs.readFileSync(cache('friendly-flow.double.js'), 'utf8')).toBe(text);
        const events = rows('first.jsonl');
        expect(events.map(row => row.type)).toEqual([undefined, 'intent', 'outcome', 'terminal']);
        expect(JSON.parse(events[1].request)).toEqual({ kind: 'codegen', text: 'Define double(value)', line: 8, controls: { reasoning: 'low' } });
        expect(events[2].outcome).toEqual({ value: { text, file: cache('friendly-flow.double.js') } });
        fs.unlinkSync(cache('friendly-flow.double.js'));
        expect(await execute(source, new NoLlm(), 'first.jsonl')).toEqual(first);
        expect(files()).toEqual([]);
        expect(model.calls).toHaveLength(1);
    });

    it('pins and reuses cached code like the blockquote form', async () => {
        const source = document(fence("success((await codegen('Define answer()'))());"));
        const pin = Pin.capture(source, { cwd, args: [] });
        const first = await execute(source, scripted(ANSWER), undefined, { pin });
        expect(await execute(pin.toMarkdown(source))).toEqual(first);
        expect(first).toMatchObject({ status: 'success', value: 42 });
        expect(await execute(answering, scripted(ANSWER), 'blockquote.jsonl')).toMatchObject({ status: 'success', value: 42 });
        expect(await execute(source, new NoLlm(), 'function.jsonl')).toEqual(first);
        expect(files()).toEqual(['friendly-flow.answer.js']);
    });

    it('generates functions for plain Node.js programs through the configured runtime', async () => {
        const model = scripted('function double(value) {\n    return value * 2;\n}');
        configure({ backend: model, logLevel: 'silent', cwd, model: 'default-model' });
        const double = await codegen<(value: number) => number>('Define double(value)');
        expect(double(21)).toBe(42);
        expect(model.calls[0]).toMatchObject({ kind: 'ask', model: 'default-model' });
        expect(model.calls[0].prompt).toMatch(/^Generate JavaScript functions/);
        await expect(codegen('')).rejects.toMatchObject({ statusCode: 'runtime_error' });
    });
});

describe('@CODEGEN trace caches', () => {
    it('tags generated and cached definitions for code display while suppressing trace replay logs', async () => {
        const events: LogEvent[] = [];
        const streams: ModelStreamEvent[] = [];
        const logger = new Logger('error', undefined, { eventSink: event => events.push(event), streamSink: event => streams.push(event) });
        const model = backend(request => {
            request.onStream?.({ channel: 'response', messageId: 'code', mode: 'append', text: 'function answer(' });
            return { text: ANSWER, effective: {} };
        });
        await execute(answering, model, 'first.jsonl', { logger });
        expect(streams.map(event => event.interaction.kind)).toEqual(['codegen', 'codegen']);
        expect(events.map(event => event.kind)).toEqual(['model-input', 'model-output']);
        expect(events[0].segments[0]).toMatchObject({ type: 'preface', source: expect.stringContaining('Generate JavaScript functions') });
        expect(events[0].segments.at(-1)).toMatchObject({ type: 'text', text: expect.stringContaining('Define answer()') });
        expect(events[1]).toMatchObject({ interaction: { kind: 'codegen', role: 'response' }, segments: [{ type: 'code', language: 'javascript', source: ANSWER }] });
        events.length = 0;
        streams.length = 0;
        await execute(answering, new NoLlm(), 'fresh.jsonl', { logger });
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
            kind: 'model-output', interaction: { kind: 'codegen' },
            segments: [{ type: 'code', language: 'javascript', source: `${signature('Define answer()')}\n${ANSWER}\n` }],
        });
        expect(streams).toEqual([]);
        events.length = 0;
        await execute(answering, new NoLlm(), 'first.jsonl', { logger });
        expect(events).toEqual([]);
        expect(streams).toEqual([]);
    });

    it('saves friendly JavaScript files with SHA-256 comments and reuses them with a fresh trace, without imports', async () => {
        const descriptions = ['Define double(value)', 'Define increment(value)'];
        const source = document(`${instruction(descriptions[0])}\n\nComment\n\n${instruction(descriptions[1])}\n\n${fence('success(increment(double(20)));')}`);
        const first = scripted('function double(value) {\n    return value * 2;\n}', '```js\nfunction increment(value) {\n    return value + 1;\n}\n```');
        expect(await execute(source, first, 'first.jsonl')).toMatchObject({ status: 'success', value: 41 });
        expect(files()).toEqual(['friendly-flow.double.js', 'friendly-flow.increment.js']);
        for (const [index, name] of ['double', 'increment'].entries()) {
            const text = fs.readFileSync(cache(`friendly-flow.${name}.js`), 'utf8');
            expect(text.split('\n')[0]).toBe(signature(descriptions[index]));
            expect(text).not.toContain('```');
            expect(text.endsWith('}\n')).toBe(true);
            const cell = compileCell(text);
            expect(cell.statements).toEqual(['FunctionDeclaration']);
            expect(cell.declarations[0]).toMatchObject({ name, kind: 'function' });
        }
        expect(rows('first.jsonl').filter(row => row.type === 'intent').map(row => JSON.parse(row.request))).toEqual([
            { kind: 'codegen', text: descriptions[0], line: 6 }, { kind: 'codegen', text: descriptions[1], line: 10 },
        ]);
        expect(await execute(source, new NoLlm(), 'fresh.jsonl')).toMatchObject({ status: 'success', value: 41 });
        expect(files()).toHaveLength(2);
    });

    it('names the cache after the first, requested function and keeps its helpers in the same file', async () => {
        const model = scripted('function answer() {\n    return helper() + 2;\n}\nfunction helper() {\n    return 40;\n}');
        expect(await execute(answering, model, 'first.jsonl')).toMatchObject({ status: 'success', value: 42 });
        expect(files()).toEqual(['friendly-flow.answer.js']);
        expect(await execute(answering.replace('success(answer())', 'success(answer() + helper())'), new NoLlm(), 'fresh.jsonl'))
            .toMatchObject({ status: 'success', value: 82 });
    });

    it('replays recorded definitions even after cache edits or removal, without recreating files', async () => {
        expect(await execute(answering, scripted(ANSWER), 'first.jsonl')).toMatchObject({ status: 'success', value: 42 });
        const file = cache(files()[0]);
        const original = fs.readFileSync(file, 'utf8');
        fs.writeFileSync(file, original.replace('return 42', 'return 99'));
        expect(await execute(answering, new NoLlm(), 'first.jsonl')).toMatchObject({ status: 'success', value: 42 });
        expect(await execute(answering, new NoLlm(), 'fresh.jsonl')).toMatchObject({ status: 'success', value: 99 });
        fs.unlinkSync(file);
        expect(await execute(answering, new NoLlm(), 'first.jsonl')).toMatchObject({ status: 'success', value: 42 });
        expect(await execute(answering, new NoLlm(), 'fresh.jsonl')).toMatchObject({ status: 'success', value: 99 });
        expect(files()).toEqual([]);
    });

    it('resumes an unresolved generation intent by reusing the completed cache', async () => {
        const model = scripted(ANSWER);
        await execute(answering, model, 'interrupted.jsonl');
        const traceFile = path.join(cwd, 'interrupted.jsonl');
        const lines = fs.readFileSync(traceFile, 'utf8').trimEnd().split('\n');
        expect(JSON.parse(lines[1])).toMatchObject({ type: 'intent' });
        fs.writeFileSync(traceFile, lines.slice(0, 2).join('\n') + '\n');
        expect(await execute(answering, new NoLlm(), 'interrupted.jsonl')).toMatchObject({ status: 'success', value: 42 });
        expect(files()).toEqual(['friendly-flow.answer.js']);
        expect(model.calls).toHaveLength(1);
        expect(rows('interrupted.jsonl').map(row => row.type)).toEqual([undefined, 'intent', 'outcome', 'terminal']);
    });

    it.each([
        ['a relative file', () => ({ file: path.relative(cwd, workflow) })],
        ['a file URI', () => ({ file: pathToFileURL(workflow).href })],
        ['a file URI source of an embedding host', () => ({ file: undefined, source: pathToFileURL(workflow).href })],
    ])('locates sibling caches for %s', async (_, location) => {
        const options = location();
        expect(await execute(answering, scripted(ANSWER), 'first.jsonl', options)).toMatchObject({ status: 'success', value: 42 });
        expect(files()).toEqual(['friendly-flow.answer.js']);
        expect(await execute(answering, new NoLlm(), 'fresh.jsonl', options)).toMatchObject({ status: 'success', value: 42 });
    });

    it('names caches after the workflow file when a reporting source is also given', async () => {
        const options = { file: workflow, source: 'cell:1' };
        expect(await execute(answering, scripted(ANSWER), 'first.jsonl', options)).toMatchObject({ status: 'success', value: 42 });
        expect(files()).toEqual(['friendly-flow.answer.js']);
        expect(fs.readdirSync(cwd).sort()).toEqual(['first.jsonl', 'workflows']);
        expect(await execute(answering, new NoLlm(), 'fresh.jsonl', options)).toMatchObject({ status: 'success', value: 42 });
    });

    it('caches beside the trace file when the workflow has no path', async () => {
        expect(await execute(answering, scripted(ANSWER), 'first.jsonl', { file: undefined })).toMatchObject({ status: 'success', value: 42 });
        expect(fs.readFileSync(path.join(cwd, 'first.answer.js'), 'utf8').split('\n')[0]).toBe(signature('Define answer()'));
        expect(files()).toEqual([]);
        fs.copyFileSync(path.join(cwd, 'first.answer.js'), path.join(cwd, 'fresh.answer.js'));
        expect(await execute(answering, new NoLlm(), 'fresh.jsonl', { file: undefined })).toMatchObject({ status: 'success', value: 42 });
    });

    it('does not read or write a cache when running without trace', async () => {
        await execute(answering, scripted(ANSWER), 'first.jsonl');
        const cached = fs.readFileSync(cache(files()[0]), 'utf8');
        const model = scripted(ANSWER.replace('42', '43'));
        expect(await execute(answering, model)).toMatchObject({ status: 'success', value: 43 });
        expect(model.calls).toHaveLength(1);
        expect(files()).toEqual(['friendly-flow.answer.js']);
        expect(fs.readFileSync(cache(files()[0]), 'utf8')).toBe(cached);
    });

    it('invalidates changed input without overwriting existing codegen files', async () => {
        const original = document(`${instruction('Define answer() returning 42')}\n\n${fence('success(answer());')}`);
        const changed = original.replace('returning 42', 'returning 43');
        await execute(original, scripted(ANSWER), 'first.jsonl');
        const contents = fs.readFileSync(cache('friendly-flow.answer.js'), 'utf8');
        expect(await execute(changed, scripted(ANSWER.replace('42', '43')), 'changed.jsonl')).toMatchObject({ status: 'success', value: 43 });
        expect(files()).toEqual(['friendly-flow.answer.js', `friendly-flow.answer.${hash('Define answer() returning 43')}.js`].sort());
        expect(fs.readFileSync(cache('friendly-flow.answer.js'), 'utf8')).toBe(contents);
        expect(await execute(changed, new NoLlm(), 'fresh.jsonl')).toMatchObject({ status: 'success', value: 43 });
        expect(await execute(original, new NoLlm(), 'original.jsonl')).toMatchObject({ status: 'success', value: 42 });
    });

    it.each(['', signature('Different description') + '\n', signature('Define answer()').replace('//', '#') + '\n'])(
        'does not trust a missing or mismatched signature: %j', async header => {
            fs.writeFileSync(cache('friendly-flow.answer.js'), `${header}function answer() {\n    return 99;\n}\n`);
            const model = scripted(ANSWER);
            expect(await execute(answering, model, 'fresh.jsonl')).toMatchObject({ status: 'success', value: 42 });
            expect(model.calls).toHaveLength(1);
            expect(files()).toHaveLength(2);
        });

    it('matches caches by signature, whatever the function or file is called, including CRLF files', async () => {
        fs.writeFileSync(cache('friendly-flow.renamed.js'), `${signature('Define answer()')}\r\nfunction answer() {\r\n    return 7;\r\n}\r\n`);
        fs.writeFileSync(cache('other-flow.answer.js'), `${signature('Define answer()')}\nfunction answer() {\n    return 8;\n}\n`);
        expect(await execute(answering, new NoLlm(), 'fresh.jsonl')).toMatchObject({ status: 'success', value: 7 });
        expect(files()).toEqual(['friendly-flow.renamed.js', 'other-flow.answer.js']);
    });

    it('fails explicitly for a matching but invalid cache instead of silently regenerating or executing it', async () => {
        fs.writeFileSync(cache('friendly-flow.answer.js'), `${signature('Define answer()')}\nawait writeFile('should-not-exist', 'bad');\n`);
        const model = scripted(ANSWER);
        const first = await execute(document(instruction('Define answer()')), model, 'invalid.jsonl');
        expect(first).toMatchObject({ status: 'failure', failure: { status_code: 'invalid_format', reason: expect.stringMatching(/only JavaScript function declarations/) } });
        expect(model.calls).toEqual([]);
        expect(fs.existsSync(path.join(cwd, 'should-not-exist'))).toBe(false);
        expect(files()).toEqual(['friendly-flow.answer.js']);
        expect(await execute(document(instruction('Define answer()')), model, 'invalid.jsonl')).toEqual(first);
    });

    it('records cache write failures so trace replay preserves the failure', async () => {
        fs.mkdirSync(cache('friendly-flow.answer.js'));
        fs.mkdirSync(cache(`friendly-flow.answer.${hash('Define answer()')}.js`));
        const source = document(instruction('Define answer()'));
        const first = await execute(source, scripted(ANSWER), 'failed.jsonl');
        expect(first).toMatchObject({ status: 'failure', failure: { status_code: 'runtime_error', reason: expect.stringContaining('cannot save @CODEGEN cache') } });
        expect(await execute(source, new NoLlm(), 'failed.jsonl')).toEqual(first);
    });

    it('reports failures inside cached functions at their line of the cache file', async () => {
        const source = document(`${instruction('Define explode()')}\n\n${fence('explode();')}`);
        const model = scripted('function explode() {\n    return null.x;\n}');
        const first = await execute(source, model, 'first.jsonl');
        expect(first).toMatchObject({ status: 'failure', failure: {
            status_code: 'runtime_error', reason: expect.stringContaining('TypeError'), line: 3, command: 'return null.x;',
            source: cache('friendly-flow.explode.js'),
        } });
        expect(await execute(source, new NoLlm(), 'first.jsonl')).toEqual(first);
    });

    it('lets a blockquote agent call codegen through the journal', async () => {
        const source = document('> Generate answer() with the codegen function and finish with its result.');
        let generations = 0;
        const model = backend(async request => {
            if (!request.naturalLanguage) { generations++; return { text: ANSWER, effective: {} }; }
            return acting(
                action('call_function', { name: 'codegen', args: ['Define answer()'] }),
                action('call_function', { name: 'answer', args: [] }),
                results => action('success', { value: results }),
            ).call(request);
        });
        const first = await execute(source, model, 'first.jsonl');
        expect(first).toMatchObject({ status: 'success', value: ['function answer()', 42] });
        expect(rows('first.jsonl').filter(row => row.type === 'intent').map(row => JSON.parse(row.request).kind)).toEqual(['natural', 'codegen', 'natural', 'natural']);
        expect(await execute(source, new NoLlm(), 'first.jsonl')).toEqual(first);
        expect(generations).toBe(1);
    });
});
