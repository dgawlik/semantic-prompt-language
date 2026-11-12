import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SplSyntaxError } from '../src/errors.js';
import type { LlmBackend, LlmRequest, RuntimeAction } from '../src/llm.js';
import { extractMarkdown, isWorkflowMarkdown, parseInstruction, parseMarkdown } from '../src/markdown.js';
import { RUNTIME_PREAMBLE } from '../src/preamble.js';
import { ExecutionSession, run } from '../src/workflow.js';
import { NoLlm, acting, action, backend, cleanTemp, document, execMarkdown, fence, quote, scripted, silent, tempDir } from './helpers.js';

afterEach(() => {
    vi.unstubAllEnvs();
    cleanTemp();
});

/** A blockquote agent that decides one action per model turn; nested generation calls answer with `replies`. */
function turns(actions: (RuntimeAction | undefined)[], ...replies: string[]): LlmBackend & { calls: LlmRequest[] } {
    const calls: LlmRequest[] = [];
    let turn = 0;
    let reply = 0;
    return {
        calls,
        async call(request) {
            calls.push(request);
            return request.naturalLanguage
                ? { text: 'Done', effective: {}, action: actions[turn++] }
                : { text: replies[reply++] ?? 'Generated', effective: {} };
        },
        async close() {},
    };
}

function syntaxError(source: string): SplSyntaxError {
    try {
        parseMarkdown(source);
    } catch (error) {
        if (error instanceof SplSyntaxError) return error;
        throw error;
    }
    throw new Error('expected a syntax error');
}

/** The shared bindings an agent was shown when its blockquote started. */
const bindings = (request: LlmRequest): Record<string, unknown> =>
    JSON.parse(/\n\nShared bindings at command start:\n(.*)\n\nBlockquote:\n/.exec(request.prompt)![1]);

describe('Markdown document syntax', () => {
    it('reads frontmatter settings and executable blocks in document order', () => {
        const source = document(`# Title\n\n${fence('const a = 1;')}\n\n> Use @a\n> twice\n\n${fence('success(a);', 'ts')}`, "model: 'gpt-6-luna'\npreamble: Be brief.\n");
        const workflow = parseMarkdown(source);
        expect(workflow.model).toBe('gpt-6-luna');
        expect(workflow.markdown).toEqual({ preamble: 'Be brief.' });
        expect(workflow.lines).toEqual(source.split('\n'));
        expect(workflow.steps.map(step => [step.kind, step.line])).toEqual([['code', 11], ['natural', 14], ['code', 18]]);
        const extracted = extractMarkdown(source);
        expect(extracted).toMatchObject({ model: 'gpt-6-luna', preamble: 'Be brief.' });
        expect(extracted.blocks).toEqual([
            { kind: 'code', language: 'js', text: 'const a = 1;', line: 11, endLine: 11 },
            { kind: 'natural', text: 'Use @a\ntwice', line: 14, endLine: 15 },
            { kind: 'code', language: 'ts', text: 'success(a);', line: 18, endLine: 18 },
        ]);
        expect(extracted.code.split('\n').map(line => line.trim())).toEqual(source.split('\n').map((line, index) => index === 10 || index === 17 ? line : ''));
        expect(parseMarkdown(document('Only commentary.'))).toMatchObject({ model: undefined, steps: [], markdown: { preamble: undefined } });
    });

    it.each([
        ['', /require YAML frontmatter/, 1],
        ['# Title\n\n> Act.', /require YAML frontmatter/, 1],
        ['---\nextension: semantic-prompt-language\nversion: 1\n', /unterminated YAML frontmatter/, 1],
        ['---\n- extension\n---', /frontmatter must be a mapping/, 2],
        ['---\nextension: wrong\nversion: 1\n---', /frontmatter requires extension: semantic-prompt-language/, 2],
        ['---\nversion: 1\n---', /frontmatter requires extension/, 2],
        ['---\nextension: semantic-prompt-language\nversion: 2\n---', /version: 1/, 2],
        ['---\nextension: semantic-prompt-language\nversion: "1"\n---', /version: 1/, 2],
        ['---\nextension: semantic-prompt-language\n---', /version: 1/, 2],
        ['---\nextension: semantic-prompt-language\nversion: 1\nversion: 1\n---', /invalid frontmatter: Map keys must be unique/, 2],
        ['---\nextension: semantic-prompt-language\nversion: 1\nmodel: &m x\npreamble: *m\n---', /invalid frontmatter/, 2],
        ['---\nextension: [semantic-prompt-language\n---', /invalid frontmatter/, 2],
        [document('', 'model: 42\n'), /frontmatter model must be a non-empty string/, 2],
        [document('', "model: ' '\n"), /frontmatter model must be a non-empty string/, 2],
        [document('', 'preamble: []\n'), /frontmatter preamble must be a string/, 2],
        [document('', 'unknown: value\n'), /unknown frontmatter field 'unknown'/, 2],
        [document('~~~ts\nsuccess(1)'), /unterminated ts fence/, 6],
        [document('Intro.\n\n~~~SPL\nlet a = 1\n~~~'), /spl fences are no longer supported: write the step in a js fence/, 8],
        [document(`${fence('if (true) {')}\n\n${fence('}')}`), /Unexpected token/, 7],
        [document(fence("@(model='x')\nlog(1);")), /Unexpected character '@'/, 7],
    ])('rejects invalid documents %#', (source, message, line) => {
        const error = syntaxError(source);
        expect(error.message).toMatch(message);
        expect(error.line).toBe(line);
    });

    it('ignores commentary, fences in other containers and HTML blocks', async () => {
        const source = document(`Fail now. @fail

\`\`\`text
> fail now
\`\`\`

\`\`\`
fail('no language');
\`\`\`

    > An indented code block is not a blockquote.

<!--
> fail now
${fence("fail('commented out');")}
-->

<div>
> fail inside HTML
</div>

- > a blockquote nested in a list
- ${fence("fail('nested example');").replace(/\n/g, '\n  ')}
- ${fence("fail 'old syntax in a nested example'", 'spl').replace(/\n/g, '\n  ')}

\`\`\`\`markdown
${fence("fail('documented fence');")}
\`\`\`\`

${fence("fail('ignored');", 'js IGNORE')}

   ${fence('let count = 1;', 'JS {title="setup"}').replace(/\n/g, '\n   ')}

## A comment

\`\`\`\`js
/* A longer fence may contain fence markers:
\`\`\`js
fail('inner');
\`\`\`
*/
count += 2;
success(count);
\`\`\`\``);
        expect(parseMarkdown(source).steps.map(step => step.kind)).toEqual(['code', 'code']);
        expect(await run(parseMarkdown(source), { backend: new NoLlm(), logger: silent })).toEqual({ status: 'success', value: 3, hasValue: true });
    });

    it('handles tilde fences, CRLF, a byte order mark, YAML multiline preambles and original line numbers', async () => {
        const source = `\uFEFF${document("~~~js\nfail('no');\n~~~", 'preamble: |\n  Be precise.\n  Be brief.\n')}`.replace(/\n/g, '\r\n');
        const workflow = parseMarkdown(source);
        expect(workflow.markdown?.preamble).toBe('Be precise.\nBe brief.\n');
        expect(workflow.steps[0].line).toBe(10);
        expect(extractMarkdown(source).code.split('\n')[9]).toBe("fail('no');");
        expect(await run(workflow, { backend: new NoLlm(), logger: silent })).toEqual({
            status: 'failure', failure: { status: 'failure', reason: 'no', command: "fail('no');", line: 10, status_code: 'explicit_failure' },
        });
    });

    it('accepts quoted frontmatter values, YAML comments and a document-end marker', () => {
        const workflow = parseMarkdown('---\n"extension": \'semantic-prompt-language\' # required\nversion: 1\nmodel: "m"\n...   \n\n> Go');
        expect(workflow).toMatchObject({ model: 'm', steps: [{ kind: 'natural', text: 'Go', line: 7 }] });
    });

    it('only opts in via the initial frontmatter', () => {
        expect(isWorkflowMarkdown(document('Text'))).toBe(true);
        expect(isWorkflowMarkdown(document('Text').replace('extension:', '"extension":'))).toBe(true);
        expect(isWorkflowMarkdown(document('Text').replace('\n---\n', '\n---  \n'))).toBe(true);
        expect(isWorkflowMarkdown(`\uFEFF${document('Text')}`.replace(/\n/g, '\r\n'))).toBe(true);
        expect(isWorkflowMarkdown('---\nplain scalar\n---')).toBe(false);
        expect(isWorkflowMarkdown(`# Comment\n${document('Text')}`)).toBe(false);
        expect(isWorkflowMarkdown('---\ntitle: ordinary\n---\nextension: semantic-prompt-language')).toBe(false);
    });

    it('parses blockquotes as whole CommonMark blocks, including lazy continuation', () => {
        const parsed = parseMarkdown(document('> First line\ncontinued\n>\n> Second paragraph\n\nComment\n\n> Next instruction'));
        expect(parsed.steps).toEqual([
            { kind: 'natural', text: 'First line\ncontinued\n\nSecond paragraph', line: 6 },
            { kind: 'natural', text: 'Next instruction', line: 13 },
        ]);
    });
});

describe('@CTL controls', () => {
    it('parses grouped literal controls without including them in the instruction', () => {
        const parsed = parseMarkdown(document(`> @CTL(
>     restrict={fs: ['./src', './reports'], exec: 'git', net: ['api.example.com'], mcp: ['docs/search'],},
>     enforce=['Be concise', 'Use Markdown'],
>     forbid="Do not invent facts (or sources)",
>     model='other-model', reasoning='high',
> )
>
> Review @notes.
> Save to @review.`).replace(/\n/g, '\r\n'));
        expect(parsed.steps).toEqual([{
            kind: 'natural', text: 'Review @notes.\nSave to @review.', line: 6,
            controls: {
                restrict: { fs: ['./src', './reports'], exec: 'git', net: ['api.example.com'], mcp: ['docs/search'] },
                enforce: ['Be concise', 'Use Markdown'], forbid: 'Do not invent facts (or sources)',
                model: 'other-model', reasoning: 'high',
            },
        }]);
    });

    it('supports quoted restriction keys, escapes, raw strings and empty settings', () => {
        const parsed = parseMarkdown(document(String.raw`> @CTL(restrict={'fs': r'C:\work\'}, enforce='Say \'hello\' (briefly)') Act.

> @ctl() Continue.`));
        expect(parsed.steps[0]).toMatchObject({
            text: 'Act.', controls: { restrict: { fs: 'C:\\work\\' }, enforce: "Say 'hello' (briefly)" },
        });
        expect(parsed.steps[1]).toEqual({ kind: 'natural', text: 'Continue.', line: 8, controls: {} });
    });

    it('reads backtick and triple-quoted strings, keeping braces literal', () => {
        const parsed = parseMarkdown(document(`> @CTL(enforce=\`Use {braces} and "quotes"\`, forbid=['''triple 'quoted'
> text''', "tab\\there \\u{1F600} \\x41 \\u0042 \\q", R"raw\\n", '{notes}'], model="m") Go.`));
        expect(parsed.steps).toEqual([{ kind: 'natural', text: 'Go.', line: 6, controls: {
            enforce: 'Use {braces} and "quotes"',
            forbid: ["triple 'quoted'\ntext", 'tab\there \u{1F600} A B q', 'raw\\n', '{notes}'],
            model: 'm',
        } }]);
    });

    it.each([
        ['@CTL(unknown="x")', /@CTL: unknown setting 'unknown'/],
        ['@CTL(model="one", model="two")', /duplicate setting 'model'/],
        ['@CTL(model=" ")', /model must be a non-empty string/],
        ['@CTL(model=42)', /expected a literal string/],
        ['@CTL(reasoning="extreme")', /reasoning must be low, medium, or high/],
        ['@CTL(enforce=notes)', /expected a literal string/],
        ['@CTL(enforce=`${notes}`)', /expected a literal string \(no interpolation\)/],
        ['@CTL(enforce=["ok", 1])', /expected a literal string/],
        ['@CTL(enforce="never closed) Act.', /unterminated string/],
        ['@CTL(restrict="src")', /expected '\{'/],
        ['@CTL(restrict={other: []})', /unknown restriction kind 'other'/],
        ['@CTL(restrict={fs: [], fs: []})', /duplicate restriction kind 'fs'/],
        ['@CTL(restrict={fs: [42]})', /expected a literal string/],
        ['@CTL(restrict={fs: "a" exec: "b"})', /expected ','/],
        ['@CTL(enforce="x"', /unterminated @CTL block/],
        ['@CTL(="x")', /expected a setting name/],
        ['@CTL() @CTL() Act.', /@CTL must appear once at the start/],
        ['Act. @CTL(model="other")', /@CTL must appear once at the start/],
        ['@CTL', /@CTL must appear once at the start/],
        ['@Restrict fs["src"]', /@Restrict has been removed; use @CTL\(restrict=\.\.\., enforce=\.\.\., forbid=\.\.\.\)/],
        ['@Enforce Be concise', /has been removed; use @CTL/],
        ['@FORBID Inventions', /has been removed; use @CTL/],
        ['@CTL(model="m") Then @forbid jokes', /has been removed; use @CTL/],
        ['@Human Approve?', /@Human has been removed; request human input in plain language/],
    ])('rejects invalid or removed controls: %s', (instruction, message) => {
        expect(syntaxError(document(quote(instruction)))).toMatchObject({ message: expect.stringMatching(message), line: 6 });
    });

    it('keeps diagnostics on the original document line', () => {
        expect(syntaxError(document('> @CTL(\n> model="ok",\n> reasoning="invalid") Act.'))).toMatchObject({ line: 8, col: 1 });
        expect(syntaxError(document('> @CTL(model="ok",\n>   enforce=oops) Act.'))).toMatchObject({ line: 7, col: 11 });
        expect(syntaxError(document('> @CTL(model="ok")\n> Review it.\n> Then @Human approves.'))).toMatchObject({ line: 8 });
    });

    it('leaves escaped and embedded markers to the agent', () => {
        const text = 'Mail user@human.example, write \\@Restrict and @@Forbid literally, mention @CTLs and @humanity.';
        expect(parseMarkdown(document(quote(text))).steps).toEqual([{ kind: 'natural', text, line: 6 }]);
    });
});

describe('blockquote agents', () => {
    it('loads complete type schemas and saves validated data as class instances', async () => {
        const severity = { type: 'string', enum: ['low', 'medium', 'high'] };
        const item = {
            type: 'object', properties: {
                severity, title: { type: 'string' }, location: { type: 'string' }, fix: { type: 'string', description: 'Suggested change' },
            }, required: ['severity', 'title', 'location', 'fix'], additionalProperties: false,
        };
        const model = acting(
            action('load_variable', { name: 'Severity' }),
            action('load_variable', { name: 'Item' }),
            action('load_variable', { name: 'Review' }),
            action('save_variable', { name: 'review', schema: 'Review', value: {
                findings: [{ severity: 'high', title: 'Bug', location: 'src/main.ts:1', fix: 'Validate the input' }],
            } }),
        );
        const result = await execMarkdown(`${fence(`const Severity = enumOf('low', 'medium', 'high');
const Item = struct('Item', { severity: Severity, title: str, location: str, fix: str.describe('Suggested change') })
    .methods({ label() { return \`[\${this.severity}] \${this.title}\`; } });
const Review = struct('Review', { findings: list(Item) })
    .methods({ worst() { return this.findings.find(item => item.severity === 'high'); } });`)}

> Convert @notes into structured findings @validate[Review] and save to @review.

${fence('success([Review.is(review), Item.is(review.findings[0]), review.worst().label()]);')}`, { backend: model });
        expect(result).toMatchObject({ status: 'success', value: [true, true, '[high] Bug'] });
        expect(model.results.slice(0, 3)).toEqual([severity, item, {
            type: 'object', properties: { findings: { type: 'array', items: item } }, required: ['findings'], additionalProperties: false,
        }]);
        expect(bindings(model.calls[0])).toEqual({ Severity: '<type "low" | "medium" | "high">', Item: '<type Item>', Review: '<type Review>' });
    });

    it('decodes values with named struct and library types without enforcing annotations', async () => {
        const body = `${fence("const Data = struct('Data', { title: str.annotate({ minLength: 2 }), count: int });\nlet count = 0;")}

> Save @data and @count.

${fence('success([data.title, data.count, count]);')}`;
        expect(await execMarkdown(body, { backend: acting(
            action('save_variable', { name: 'data', value: { title: 'x', count: 15 }, schema: 'Data' }),
            action('save_variable', { name: 'count', value: 3, schema: 'int' }),
        ) })).toMatchObject({ status: 'success', value: ['x', 15, 3] });
        expect(await execMarkdown(body, { backend: acting(action('save_variable', { name: 'count', value: '3', schema: 'int' })) })).toMatchObject({
            status: 'failure', failure: { status_code: 'validation_failed', reason: 'count: expected int, got "3"', line: 11 },
        });
    });

    it.each([
        { findings: [{ severity: 'urgent', title: 'Bug' }] },
        { findings: [{ severity: 'high' }] },
        { findings: [{ severity: 'high', title: 'Bug', extra: true }] },
    ])('rejects invalid data for a named type before later effects %#', async value => {
        const cwd = tempDir();
        const body = `${fence(`const Severity = enumOf('low', 'high');
const Item = struct('Item', { severity: Severity, title: str }).methods({ label() { return this.title; } });
const Review = struct('Review', { findings: list(Item) });`)}

> Save @review.

${fence("await writeFile('saved.txt', 'must not execute');")}`;
        expect(await execMarkdown(body, { cwd, backend: acting(action('save_variable', { name: 'review', value, schema: 'Review' })) })).toMatchObject({
            status: 'failure', failure: { status_code: 'validation_failed', reason: expect.stringContaining('review.findings[0]'), line: 12, command: '> Save @review.' },
        });
        expect(fs.existsSync(path.join(cwd, 'saved.txt'))).toBe(false);
    });

    it.each([
        ['const Schema = false;', 'Schema', 'validation_failed', /boolean schema is false/],
        ['class Ordinary { title = ""; }', 'Ordinary', 'runtime_error', /schema must be a type, a JSON Schema object or a boolean/],
        ["const Label = 'text';", 'Label', 'runtime_error', /schema must be a type, a JSON Schema object or a boolean/],
        ["const Broken = { type: 'imaginary' };", 'Broken', 'runtime_error', /invalid schema/],
        ['log("no schema");', { type: 'imaginary' }, 'runtime_error', /invalid schema/],
    ])('rejects the unusable schema of %s', async (declarations, schema, statusCode, reason) => {
        const model = acting(action('save_variable', { name: 'result', value: 'text', schema }));
        expect(await execMarkdown(`${fence(declarations)}\n\n> Save @result.\n\n${fence('success(typeof result);')}`, { backend: model })).toMatchObject({
            status: 'failure', failure: { status_code: statusCode, reason: expect.stringMatching(reason) },
        });
    });

    it('calls functions with positional JSON arguments and shows their signatures', async () => {
        const model = acting(
            action('call_function', { name: 'factorial', args: [15] }),
            action('call_function', { name: 'fib', args: [10] }),
            action('call_function', { name: 'inspect', args: [{ values: [1, 2], ratio: 1 }, 3, null] }),
            results => action('save_variable', { name: 'fact15', value: results[0] }),
        );
        const result = await execMarkdown(`${fence(`function factorial(n) {
    return n === 0 ? 1 : n * factorial(n - 1);
}
const fib = n => n < 2 ? n : fib(n - 1) + fib(n - 2);
async function inspect(data, dynamic, optional = 'default') {
    return JSON.stringify([data.values, data.ratio, typeof dynamic, optional]);
}`)}

> Invoke @factorial with 15 as argument -> @fact15

${fence('success(fact15);')}`, { backend: model });
        expect(result).toMatchObject({ status: 'success', value: 1307674368000 });
        expect(model.results).toEqual([1307674368000, 55, '[[1,2],1,"number",null]', 1307674368000]);
        expect(bindings(model.calls[0])).toEqual({
            factorial: 'function factorial(n)', fib: 'function fib(n)', inspect: "async function inspect(data, dynamic, optional = 'default')",
        });
    });

    it('returns function results to the agent as JSON-safe data', async () => {
        const model = acting(action('call_function', { name: 'everything', args: [] }), action('call_function', { name: 'nothing', args: [] }));
        expect(await execMarkdown(`${fence(`class Point { constructor(x, y) { this.x = x; this.y = y; } }
const Card = struct('Card', { term: str });
const everything = () => ({
    missing: undefined, big: 10n, when: new Date(0), point: new Point(1, 2), map: new Map([['a', 1]]), set: new Set([1]),
    callback: everything, type: Card, ratio: NaN, error: new RangeError('too far'),
});
const nothing = () => {};`)}

> Describe @everything and @nothing.`, { backend: model })).toEqual({ status: 'success', value: null, hasValue: false });
        expect(model.results).toEqual([{
            missing: null, big: '10n', when: '1970-01-01T00:00:00.000Z', point: { class: 'Point', fields: { x: 1, y: 2 } }, map: { a: 1 }, set: [1],
            callback: 'function everything()', type: '<type Card>', ratio: 'NaN', error: '<RangeError too far>',
        }, null]);
    });

    it('summarizes shared bindings and callable library functions for the agent', async () => {
        const model = acting();
        await execMarkdown(`${fence(`import * as nodePath from 'node:path';
import os from 'node:os';
import { join } from 'node:path';
class Counter { count = 2; }
const counter = new Counter();
const cyclic = [];
cyclic.push(cyclic);
function double(x) {
    return x * 2;
}
const helpers = { double };
const shell = (command) => command;
let pending;
let empty = null;`)}

> Return the doubled length of @cyclic.`, { backend: model });
        const prompt = model.calls[0].prompt;
        expect(prompt).toContain('\n\nAvailable library functions: ask, think, agent, human, log, codegen, readFile, writeFile, webFetch, webSearch, validate\n\n');
        expect(bindings(model.calls[0])).toEqual({
            double: 'function double(x)', nodePath: "<imported from 'node:path'>", os: "<imported from 'node:os'>",
            join: expect.stringMatching(/^function join\(/), Counter: 'class Counter', counter: { class: 'Counter', fields: { count: 2 } },
            cyclic: ['<circular reference>'], helpers: { double: 'function double(x)' }, shell: 'function shell(command)', empty: null,
        });
        expect(prompt.endsWith('\n\nBlockquote:\nReturn the doubled length of @cyclic.\n\nCompleted turns and action results:\n[]')).toBe(true);
    });

    it('shows the full parameter name of an arrow function written without parentheses', async () => {
        const model = acting();
        await execMarkdown(`${fence('const shout = text => text.toUpperCase();\nconst later = async value => value;')}\n\n> Use @shout.`, { backend: model });
        expect(bindings(model.calls[0])).toEqual({ shout: 'function shout(text)', later: 'async function later(value)' });
    });

    it('executes mixed blocks in order, one decided action per turn, with shared functions and variables', async () => {
        const model = turns([
            action('call_function', { name: 'double', args: [2] }),
            action('save_variable', { name: 'count', value: 4 }),
            undefined,
            action('load_variable', { name: 'count' }),
            action('success', { value: 4 }),
        ]);
        const result = await execMarkdown(`${fence('const count = 2;\nfunction double(x) {\n    return x * 2;\n}')}

> Set @count to @double of its current value.

${fence('assert(count === 4);')}

> Return @count as the document result.

${fence("fail('must not execute');")}`, { backend: model, model: 'cli-model' }, 'model: document-model\npreamble: Be concise.\n');
        expect(result).toEqual({ status: 'success', value: 4, hasValue: true });
        expect(model.calls).toHaveLength(5);
        expect(model.calls[0]).toMatchObject({ kind: 'agent', naturalLanguage: true, model: 'cli-model' });
        expect(bindings(model.calls[0])).toEqual({ double: 'function double(x)', count: 2 });
        expect(model.calls[0].prompt).toContain('Completed turns and action results:\n[]');
        expect(model.calls[1].prompt).toContain('[{"action":{"name":"call_function","arguments":{"name":"double","args":[2]}},"result":{"value":4}}]');
        expect(model.calls[2].prompt).toContain('{"action":{"name":"save_variable","arguments":{"name":"count","value":4}},"result":{"value":4}}]');
        expect(bindings(model.calls[2]).count).toBe(2);
        expect(bindings(model.calls[3]).count).toBe(4);
        expect(model.calls[3].prompt).toContain('Blockquote:\nReturn @count as the document result.\n\nCompleted turns and action results:\n[]');
        expect(model.calls[0].runtimeTools?.map(tool => tool.name)).toEqual([
            'load_variable', 'save_variable', 'call_function', 'get_env', 'ask_human', 'success', 'fail', 'restrict', 'set_guidance',
            'read_file', 'write_file', 'web_fetch', 'web_search', 'shell',
        ]);
        for (const call of model.calls) expect(call.prompt.startsWith(`${RUNTIME_PREAMBLE}\n\nBe concise.\n\nExecute this blockquote as an agent command.`)).toBe(true);
    });

    it('prepends the preamble to nested generation, including repairs, and preserves model precedence', async () => {
        const model = turns([action('call_function', { name: 'number', args: [] }), action('success', { value: 7 })], '"bad"', '7');
        const result = await execMarkdown(`${fence("function number() {\n    return ask('Number?', { fmt: 'integer', repairs: 1, model: 'other' });\n}")}

> Generate an integer using @number.`, { backend: model }, 'model: default-model\npreamble: |\n  Custom guidance.\n  Stay calm.\n');
        expect(result).toMatchObject({ status: 'success', value: 7 });
        expect(model.calls.map(call => call.model)).toEqual(['default-model', 'other', 'other', 'default-model']);
        for (const call of model.calls) expect(call.prompt.startsWith(`${RUNTIME_PREAMBLE}\n\nCustom guidance.\nStay calm.\n\n\n`)).toBe(true);
        expect(model.calls[2].prompt).toContain('Previous response:\n"bad"\n\nValidation failed');
        expect(model.calls[3].prompt).toContain('"result":{"value":7}');
    });

    it('lets a called function scope restrictions, catch failures, validate a schema and use exact tools', async () => {
        const cwd = tempDir();
        const model = turns([action('call_function', { name: 'calculate', args: [] }), action('success', { value: 6 })], '6');
        const result = await execMarkdown(`${fence(`async function calculate() {
    let total = 0;
    for (const n of [0, 1, 2, 3]) total += n;
    let caught = false;
    try {
        await restrict('./allowed', () => writeFile('outside.txt', 'blocked'));
    } catch (error) {
        caught = error.statusCode === 'restriction_violation';
    }
    assert(caught);
    const result = await ask(\`Return \${total}\`, { schema: { type: 'integer' } });
    await writeFile('allowed/result.txt', String(result));
    return result;
}`)}

> Calculate, validate and save a result using @calculate.`, { backend: model, cwd });
        expect(result).toMatchObject({ status: 'success', value: 6 });
        expect(model.calls[1].prompt).toContain('Return 6\n\nReturn ONLY valid JSON');
        expect(fs.existsSync(path.join(cwd, 'outside.txt'))).toBe(false);
        expect(fs.readFileSync(path.join(cwd, 'allowed', 'result.txt'), 'utf8')).toBe('6');
    });

    it('calls library functions under the guidance and restrictions of the blockquote', async () => {
        const cwd = tempDir();
        fs.mkdirSync(path.join(cwd, 'docs'));
        fs.writeFileSync(path.join(cwd, 'docs', 'note.txt'), 'inside');
        fs.writeFileSync(path.join(cwd, 'secret.txt'), 'outside');
        const body = quote("@CTL(restrict={fs: './docs'}, enforce='Be formal')\nRate the note with @ask.");
        const model = acting(
            action('call_function', { name: 'readFile', args: ['./docs/note.txt'] }),
            action('call_function', { name: 'ask', args: ['Rate it', { fmt: 'integer' }] }),
        );
        const rated = backend(request => request.naturalLanguage ? model.call(request) : { text: request.prompt.includes('- Follow: Be formal') ? '7' : '0', effective: {} });
        expect(await execMarkdown(body, { backend: rated, cwd })).toMatchObject({ status: 'success' });
        expect(model.results).toEqual(['inside', 7]);
        expect(await execMarkdown(body, { backend: acting(action('call_function', { name: 'readFile', args: ['./secret.txt'] })), cwd })).toMatchObject({
            status: 'failure', failure: { status_code: 'restriction_violation', line: 6, command: "> @CTL(restrict={fs: './docs'}, enforce='Be formal')" },
        });
    });

    it('fails immediately on human input without a handler', async () => {
        const model = turns([action('ask_human', { question: 'Approve?' }), action('ask_human', { question: 'Again?' })]);
        expect(await execMarkdown('> Ask a human.', { backend: model })).toEqual({
            status: 'failure', failure: { status: 'failure', reason: 'human input requires a human handler', command: '> Ask a human.', line: 6, status_code: 'runtime_error' },
        });
        expect(model.calls).toHaveLength(1);
    });

    it('returns a direct human answer to the same agent session and shared bindings', async () => {
        const human = vi.fn(async () => '  approved\nexactly  ');
        const model = acting(
            action('ask_human', { question: 'Approve?' }),
            results => action('save_variable', { name: 'answer', value: results[0] }),
        );
        const result = await execMarkdown(`Intro.\n\n> Ask a human to approve this\n> and save to @answer.\n\n${fence('success([answer, await human("Sure?")]);')}`, { backend: model, human });
        expect(result).toMatchObject({ status: 'success', value: ['  approved\nexactly  ', '  approved\nexactly  '] });
        expect(human.mock.calls).toEqual([['Approve?', 8], ['Sure?', 12]]);
        expect(model.calls).toHaveLength(1);
    });

    it('reads environment variables one at a time and arguments as a list', async () => {
        vi.stubEnv('SPL_TEST_MARKDOWN_TOKEN', 'secret');
        const model = acting(
            action('get_env', { name: 'SPL_TEST_MARKDOWN_TOKEN' }),
            action('get_env', { name: 'SPL_TEST_UNSET_ENVIRONMENT_VARIABLE' }),
            action('load_variable', { name: '$args' }),
            action('load_variable', { name: 'args' }),
            results => action('save_variable', { name: 'result', value: { token: results[0], first: (results[2] as string[])[0] } }),
            action('load_variable', { name: 'result' }),
        );
        const result = await execMarkdown(`> Set @result from @env.SPL_TEST_MARKDOWN_TOKEN and @args.\n\n${fence('success([result, args, env.SPL_TEST_MARKDOWN_TOKEN]);')}`,
            { backend: model, args: ['one'] });
        expect(result).toMatchObject({ status: 'success', value: [{ token: 'secret', first: 'one' }, ['one'], 'secret'] });
        expect(model.results).toEqual(['secret', null, ['one'], ['one'], { token: 'secret', first: 'one' }, { token: 'secret', first: 'one' }]);
    });

    it('prefers workflow bindings named args and env over the inputs', async () => {
        const model = acting(action('load_variable', { name: 'env' }), action('load_variable', { name: 'args' }), action('load_variable', { name: '$args' }));
        await execMarkdown(`${fence("const env = { stage: 'test' };\nconst args = ['own'];")}\n\n> Inspect @env and @args.`, { backend: model, args: ['cli'] });
        expect(model.results).toEqual([{ stage: 'test' }, ['own'], ['cli']]);
    });

    it('fails validation without updating shared bindings or asking the model to retry', async () => {
        const session = new ExecutionSession();
        const call = vi.fn(async (request: LlmRequest) => {
            await request.invokeAction!(action('save_variable', { name: 'answer', value: 'bad', schema: { type: 'integer', minimum: 2 } }));
            throw new Error('must stop before another action');
        });
        expect(await session.run(parseMarkdown(document(`${fence('let answer = 1;')}\n\n> Save a validated integer to @answer.\n\n${fence('success(answer);')}`)),
            { logger: silent, backend: backend(call) })).toMatchObject({ status: 'failure', failure: { status_code: 'validation_failed', reason: '$: must be integer', line: 10 } });
        expect(call).toHaveBeenCalledOnce();
        expect(await session.run(parseMarkdown(document(fence('success(answer);'))), { logger: silent, backend: new NoLlm() }))
            .toMatchObject({ status: 'success', value: 1 });
    });

    it.each([
        ['submit_spl', { source: 'success(1)' }, 'runtime_error', /unknown blockquote tool 'submit_spl'/],
        ['save_variable', { name: '$env', value: {} }, 'validation_failed', /name: must match pattern/],
        ['save_variable', { name: 'human', value: 'invalid' }, 'runtime_error', /'human' is a library name and cannot be replaced/],
        ['save_variable', { name: 'double', value: 1 }, 'runtime_error', /cannot replace function 'double' with a variable/],
        ['save_variable', { name: 'x' }, 'validation_failed', /value: must have required property 'value'/],
        ['call_function', { name: 'missing', args: [] }, 'runtime_error', /name 'missing' is not defined/],
        ['call_function', { name: 'double', args: '2' }, 'validation_failed', /args: must be array/],
        ['call_function', { name: 'new', args: [] }, 'runtime_error', /'new' is a reserved word/],
        ['load_variable', { name: '' }, 'validation_failed', /name: must NOT have fewer than 1 characters/],
        ['load_variable', { name: 'count', extra: true }, 'validation_failed', /extra: must NOT have additional properties/],
        ['restrict', { kind: 'disk', value: './x' }, 'validation_failed', /kind: must be equal to one of the allowed values/],
        ['restrict', { kind: 'fs', value: ' , ' }, 'runtime_error', /restrict fs needs at least one entry/],
        ['restrict', { kind: 'mcp', value: 'not a selector!' }, 'runtime_error', /restrict mcp expects server names or server\/tool selectors/],
        ['set_guidance', { kind: 'prefer', text: 'x' }, 'validation_failed', /kind: must be equal to one of the allowed values/],
        ['fail', { reason: '' }, 'validation_failed', /reason: must NOT have fewer than 1 characters/],
        ['read_file', {}, 'validation_failed', /path: must have required property 'path'/],
        ['read_file', { path: 'missing.txt' }, 'tool_error', /read_file 'missing.txt'/],
    ])('stops on the invalid tool call %s(%j)', async (name, args, statusCode, reason) => {
        const model = turns([action(name, args), action('success', { value: 'retried' })]);
        expect(await execMarkdown(`${fence('let count = 1;\nfunction double(x) {\n    return x * 2;\n}')}\n\n> Act.`, { backend: model, cwd: tempDir() })).toMatchObject({
            status: 'failure', failure: { status_code: statusCode, reason: expect.stringMatching(reason), line: 13, command: '> Act.' },
        });
        expect(model.calls).toHaveLength(1);
    });
});

describe('blockquote tools and restrictions', () => {
    it('runs exact tools relative to the working directory and returns their output', async () => {
        const cwd = tempDir();
        const model = acting(
            action('write_file', { path: 'notes/a.txt', content: 'héllo' }),
            action('read_file', { path: './notes/a.txt' }),
            action('shell', { command: 'node -e "console.log(6 * 7)"' }),
        );
        expect(await execMarkdown(`> Write and read a note.\n\n${fence("success(await readFile('notes/a.txt'));")}`, { backend: model, cwd })).toMatchObject({ status: 'success', value: 'héllo' });
        expect(model.results).toEqual([`Wrote 6 bytes to ${path.join(cwd, 'notes', 'a.txt')}`, 'héllo', '42\n']);
    });

    it.each([
        ['outside the @CTL folder', 10, [action('write_file', { path: './b.txt', content: 'x' })]],
        ['outside a narrowed folder', 10, [action('restrict', { kind: 'fs', value: './a/b' }), action('write_file', { path: './a/c.txt', content: 'x' })]],
        ['inside a disjoint folder', 10, [action('restrict', { kind: 'fs', value: './other' }), action('write_file', { path: './other/x.txt', content: 'x' })]],
        ['through a function that restricts again', 7, [action('restrict', { kind: 'fs', value: './a/b' }), action('call_function', { name: 'writeBeside', args: [] })]],
        ['with an executable that is not allowed', 10, [action('shell', { command: 'git status' })]],
        ['with an executable removed by narrowing', 10, [action('restrict', { kind: 'exec', value: ['git'] }), action('shell', { command: 'node --version' })]],
        ['to a host that is not allowed', 10, [action('web_fetch', { url: 'https://example.com/page' })]],
        ['to search the web', 10, [action('web_search', { query: 'anything' })]],
    ])('intersects restrictions: blocks acting %s', async (_, line, actions) => {
        const cwd = tempDir();
        const fetch = vi.spyOn(globalThis, 'fetch');
        try {
            expect(await execMarkdown(`${fence("const writeBeside = () => restrict('./a', () => writeFile('./a/c.txt', 'x'));")}

> @CTL(restrict={fs: './a', exec: 'node', net: 'example.org'}) Act.`, { backend: acting(...actions), cwd })).toMatchObject({
                status: 'failure', failure: { status_code: 'restriction_violation', line },
            });
            expect(fetch).not.toHaveBeenCalled();
        } finally {
            fetch.mockRestore();
        }
        expect(fs.existsSync(path.join(cwd, 'b.txt')) || fs.existsSync(path.join(cwd, 'a')) || fs.existsSync(path.join(cwd, 'other'))).toBe(false);
    });

    it('permits actions inside every active restriction and restores them after the command', async () => {
        const cwd = tempDir();
        const model = acting(
            action('write_file', { path: './a/first.txt', content: '1' }),
            action('restrict', { kind: 'fs', value: ['./a/b', './a/c'] }),
            action('write_file', { path: './a/c/second.txt', content: '2' }),
            action('call_function', { name: 'writeDeep', args: [] }),
            action('shell', { command: 'node -e "console.log(1)"' }),
        );
        const seen: boolean[] = [];
        const result = await execMarkdown(`${fence("const writeDeep = () => restrict('./a', () => writeFile('./a/b/third.txt', '3'));")}

> @CTL(restrict={fs: './a', exec: 'node'}) Act.

> Write outside the previous restriction.

${fence("await writeFile('./outside.txt', 'free');\nsuccess('done');")}`, { cwd, backend: backend(async request => {
            seen.push(request.restrictions.active);
            if (seen.length === 1) return model.call(request);
            await request.invokeAction!(action('write_file', { path: './b.txt', content: 'after' }));
            return { text: 'Done', effective: {} };
        }) });
        expect(result).toMatchObject({ status: 'success', value: 'done' });
        expect(seen).toEqual([true, false]);
        expect(model.results[1]).toBeNull();
        for (const file of ['a/first.txt', 'a/c/second.txt', 'a/b/third.txt', 'b.txt', 'outside.txt']) expect(fs.existsSync(path.join(cwd, file)), file).toBe(true);
    });

    it('enforces narrowed restrictions across functions', async () => {
        const cwd = tempDir();
        const model = acting(action('restrict', { kind: 'fs', value: './allowed' }), action('call_function', { name: 'write', args: [] }));
        expect(await execMarkdown(`${fence("function write() {\n    return writeFile('outside.txt', 'blocked');\n}")}\n\n> Restrict file access and invoke @write.`, { backend: model, cwd })).toMatchObject({
            status: 'failure', failure: { status_code: 'restriction_violation', line: 8, command: "return writeFile('outside.txt', 'blocked');" },
        });
        expect(fs.existsSync(path.join(cwd, 'outside.txt'))).toBe(false);
    });

    it('scopes guidance and restrictions to one blockquote, including nested model calls', async () => {
        const cwd = tempDir();
        const model = turns([
            action('set_guidance', { kind: 'enforce', text: 'Be formal' }),
            action('restrict', { kind: 'fs', value: './allowed' }),
            action('call_function', { name: 'generate', args: [] }),
            undefined,
            action('write_file', { path: 'outside.txt', content: 'allowed after command' }),
            action('success', { value: 'done' }),
        ], 'Formal answer');
        const result = await execMarkdown(`${fence("const generate = () => ask('Generate');")}

> Apply guidance and restrictions, then invoke @generate.

> Write a file outside the previous restriction.`, { backend: model, cwd });
        expect(result).toMatchObject({ status: 'success', value: 'done' });
        expect(model.calls.map(call => call.naturalLanguage ?? false)).toEqual([true, true, true, false, true, true, true]);
        expect(model.calls.map(call => call.restrictions.has('fs'))).toEqual([false, false, true, true, true, false, false]);
        expect(model.calls.map(call => call.prompt.includes('- Follow: Be formal'))).toEqual([false, true, true, true, true, false, false]);
        expect(model.calls[3].prompt).toContain(`- File system: you may read and write only inside: ${path.join(cwd, 'allowed')}.`);
        expect(fs.readFileSync(path.join(cwd, 'outside.txt'), 'utf8')).toBe('allowed after command');
    });

    it('applies @CTL before the first action and restores defaults for following blocks', async () => {
        const cwd = tempDir();
        const model = turns([
            action('call_function', { name: 'generate', args: [] }), undefined,
            action('write_file', { path: 'outside.txt', content: 'allowed' }), undefined,
        ]);
        const result = await execMarkdown(`${fence("function generate() {\n    return ask('Generate', { model: 'nested-model' });\n}")}

> @CTL(restrict={fs: ["./allowed"], exec: ["git"], net: ["api.example.com"], mcp: ["docs/search"]}, enforce=["Be formal", "Be brief"], forbid="Inventions", model="quote-model", reasoning="high") Invoke @generate.

> Write outside the previous restriction.

${fence("success(await ask('Final'));")}`, { backend: model, cwd }, 'model: document-model\n');
        expect(result).toMatchObject({ status: 'success', value: 'Generated' });
        expect(model.calls.map(call => call.model)).toEqual(['quote-model', 'nested-model', 'quote-model', 'document-model', 'document-model', 'document-model']);
        expect(model.calls.map(call => call.reasoningEffort)).toEqual(['high', undefined, 'high', 'medium', 'medium', undefined]);
        for (const call of model.calls.slice(0, 3)) {
            expect(call.prompt).toContain('Response guidance (not runtime validation):\n- Follow: Be formal\n- Follow: Be brief\n- Avoid: Inventions\n\nActive restrictions');
            expect(call.restrictions.list.map(item => item.kind)).toEqual(['fs', 'exec', 'net', 'mcp']);
            expect(() => call.restrictions.checkExec('npm')).toThrow(/blocked/);
            expect(() => call.restrictions.checkHost('example.com')).toThrow(/blocked/);
            expect(() => call.restrictions.checkMcp('docs', 'delete')).toThrow(/blocked/);
            expect(call.prompt).not.toContain('@CTL(');
        }
        expect(model.calls[0].prompt).toContain('Blockquote:\nInvoke @generate.\n\n');
        for (const call of model.calls.slice(3)) {
            expect(call.restrictions.active).toBe(false);
            expect(call.prompt).not.toContain('Follow: Be formal');
        }
        expect(fs.readFileSync(path.join(cwd, 'outside.txt'), 'utf8')).toBe('allowed');
    });

    it('preserves the runtime model override over blockquote controls', async () => {
        const model = acting();
        expect(await execMarkdown('> @CTL(model="quote", reasoning="low") Act.', { backend: model, model: 'cli' })).toMatchObject({ status: 'success' });
        expect(model.calls[0]).toMatchObject({ model: 'cli', reasoningEffort: 'low' });
    });

    it('enforces @CTL restrictions on the first function call without relying on the model', async () => {
        const cwd = tempDir();
        const model = acting(action('call_function', { name: 'write', args: [] }));
        expect(await execMarkdown(`${fence("const write = () => writeFile('outside.txt', 'blocked');")}\n\n> @CTL(restrict={fs: ["./allowed"]}) Invoke @write.`, { backend: model, cwd }))
            .toMatchObject({ status: 'failure', failure: { status_code: 'restriction_violation' } });
        expect(fs.existsSync(path.join(cwd, 'outside.txt'))).toBe(false);
    });

    it.each([
        ['@CTL(restrict={net: []}) Act.', 'restrict net needs at least one entry'],
        ['@CTL(restrict={exec: " , "}) Act.', 'restrict exec needs at least one entry'],
        ['@CTL(restrict={mcp: "docs/search/extra"}) Act.', 'restrict mcp expects server names or server/tool selectors'],
    ])('validates the restriction of %s before contacting the model', async (instruction, reason) => {
        expect(await execMarkdown(quote(instruction))).toEqual({
            status: 'failure', failure: { status: 'failure', status_code: 'runtime_error', reason, line: 6, command: quote(instruction) },
        });
    });
});

describe('single instructions', () => {
    it('runs one blockquote text as a workflow with its own model and preamble', async () => {
        const workflow = parseInstruction('@CTL(enforce="Be brief")\nSave a greeting to @greeting, then finish with @success', { model: 'doc-model', preamble: 'Custom guidance.' });
        expect(workflow.steps).toEqual([{ kind: 'natural', text: 'Save a greeting to @greeting, then finish with @success', line: 1, controls: { enforce: 'Be brief' } }]);
        const model = acting(action('save_variable', { name: 'greeting', value: 'hello' }), results => action('success', { value: results[0] }));
        expect(await run(workflow, { backend: model, logger: silent })).toEqual({ status: 'success', value: 'hello', hasValue: true });
        expect(model.calls[0].model).toBe('doc-model');
        expect(model.calls[0].prompt.startsWith(`${RUNTIME_PREAMBLE}\n\nCustom guidance.\n\nResponse guidance (not runtime validation):\n- Follow: Be brief\n\n`)).toBe(true);
        expect(await run(parseInstruction('Stop with @fail'), { backend: acting(action('fail', { reason: 'stop' })), logger: silent })).toEqual({
            status: 'failure', failure: { status: 'failure', reason: 'stop', command: 'Stop with @fail', line: 1, status_code: 'explicit_failure' },
        });
        expect(() => parseInstruction('@Human Approve?')).toThrow(/@Human has been removed/);
    });

    it('answers nested generation from an instruction with scripted replies', async () => {
        const replies = scripted('nested answer');
        const model = acting(action('call_function', { name: 'ask', args: ['Summarize'] }));
        const result = await run(parseInstruction('Summarize with @ask'), {
            logger: silent, backend: backend(request => request.naturalLanguage ? model.call(request) : replies.call(request)),
        });
        expect(result).toEqual({ status: 'success', value: null, hasValue: false });
        expect(model.results).toEqual(['nested answer']);
        expect(replies.calls[0].prompt).toBe(`${RUNTIME_PREAMBLE}\n\nSummarize`);
    });
});
