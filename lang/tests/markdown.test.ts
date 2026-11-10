import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExecutionSession, run } from '../src/interpreter.js';
import type { LlmBackend, LlmRequest, LlmResponse, RuntimeAction } from '../src/llm.js';
import { Logger } from '../src/logger.js';
import { extractMarkdown, isWorkflowMarkdown, parseMarkdown } from '../src/markdown.js';
import { RUNTIME_PREAMBLE } from '../src/preamble.js';
import { NoLlm } from './helpers.js';

const header = '---\nextension: semantic-prompt-language\nversion: 1\n';
const document = (body: string, metadata = '') => `${header}${metadata}---\n\n${body}`;
const fence = (code: string) => `\`\`\`spl\n${code}\n\`\`\``;
const logger = new Logger('silent');
const temporary: string[] = [];
const directory = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spl-markdown-'));
    temporary.push(dir);
    return dir;
};
afterEach(() => {
    vi.unstubAllEnvs();
    for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
const backend = (call: (request: LlmRequest) => Promise<LlmResponse>): LlmBackend => ({ call, async close() {} });

describe('Markdown document syntax', () => {
    it('accepts the maintained is-friday example without changing version or syntax', () => {
        const source = fs.readFileSync(path.resolve(__dirname, '..', 'examples', 'is-friday.md'), 'utf8');
        expect(parseMarkdown(source).directives).toEqual({ model: 'gpt-6-luna' });
        expect(parseMarkdown(source).body).toHaveLength(2);
    });

    it.each([
        ['', /frontmatter/],
        ['---\nextension: wrong\nversion: 1\n---', /extension/],
        ['---\nextension: semantic-prompt-language\nversion: 2\n---', /version: 1/],
        ['---\nextension: semantic-prompt-language\n---', /version: 1/],
        ['---\nextension: semantic-prompt-language\nversion: 1\nversion: 1\n---', /invalid frontmatter/],
        [document('', 'model: 42\n'), /model/],
        [document('', 'preamble: []\n'), /preamble/],
        [document('', 'unknown: value\n'), /unknown frontmatter/],
        [document('```spl\nsuccess 1'), /unterminated SPL/],
        [document(fence("@(model='x')\npass")), /frontmatter/],
        [document(fence('if True:') + '\n\n' + fence('    pass')), /indented block/],
    ])('rejects invalid documents %#', (source, error) => {
        expect(() => parseMarkdown(source)).toThrow(error);
    });

    it('ignores commentary, non-SPL fences, HTML blocks and nested list examples', async () => {
        const source = document(`Fail now. @fail

\`\`\`text
> fail now
\`\`\`

<!--
> fail now
-->

- \`\`\`spl
  fail 'nested example'
  \`\`\`

${fence('let count = 1')}

## A comment

${fence('count += 2\nsuccess count')}`);
        expect(await run(parseMarkdown(source), { backend: new NoLlm(), logger }))
            .toEqual({ status: 'success', value: 3, hasValue: true });
    });

    it('handles tilde fences, CRLF, YAML multiline preambles and original line numbers', () => {
        const source = document('~~~spl\nfail \'no\'\n~~~', 'preamble: |\n  Be precise.\n  Be brief.\n').replace(/\n/g, '\r\n');
        const program = parseMarkdown(source);
        expect(program.markdown?.preamble).toBe('Be precise.\nBe brief.\n');
        expect(program.body[0].line).toBe(10);
        expect(extractMarkdown(source).code.split('\n')[9]).toBe("fail 'no'");
    });

    it('only opts in via the initial frontmatter', () => {
        expect(isWorkflowMarkdown(document('Text'))).toBe(true);
        expect(isWorkflowMarkdown(document('Text').replace('extension:', '"extension":'))).toBe(true);
        expect(isWorkflowMarkdown(document('Text').replace('\n---\n', '\n---  \n'))).toBe(true);
        expect(isWorkflowMarkdown('---\nplain scalar\n---')).toBe(false);
        expect(isWorkflowMarkdown('# Comment\n' + document('Text'))).toBe(false);
        expect(isWorkflowMarkdown('---\ntitle: ordinary\n---\nextension: semantic-prompt-language')).toBe(false);
    });

    it('parses blockquotes as whole CommonMark blocks, including lazy continuation', () => {
        const parsed = parseMarkdown(document('> First line\ncontinued\n>\n> Second paragraph\n\nComment\n\n> Next instruction'));
        expect(parsed.body).toMatchObject([
            { t: 'natural', text: 'First line\ncontinued\n\nSecond paragraph' },
            { t: 'natural', text: 'Next instruction' },
        ]);
    });

    it('parses grouped literal controls without including them in the instruction', () => {
        const parsed = parseMarkdown(document(`> @CTL(
>     restrict={fs: ['./src', './reports'], exec: 'git', net: ['api.example.com'], mcp: ['docs/search'],},
>     enforce=['Be concise', 'Use Markdown'],
>     forbid="Do not invent facts (or sources)",
>     model='other-model', reasoning='high',
> )
>
> Review @notes.`).replace(/\n/g, '\r\n'));
        expect(parsed.body).toEqual([{
            t: 'natural', text: 'Review @notes.', line: 6,
            controls: {
                restrict: { fs: ['./src', './reports'], exec: 'git', net: ['api.example.com'], mcp: ['docs/search'] },
                enforce: ['Be concise', 'Use Markdown'], forbid: 'Do not invent facts (or sources)',
                model: 'other-model', reasoning: 'high',
            },
        }]);
    });

    it('supports quoted restriction keys, escapes, raw strings and empty settings', () => {
        const parsed = parseMarkdown(document(String.raw`> @CTL(restrict={'fs': r'C:\work\'}, enforce='Say \'hello\' (briefly)') Act.

> @CTL() Continue.`));
        expect(parsed.body[0]).toMatchObject({
            text: 'Act.', controls: { restrict: { fs: 'C:\\work\\' }, enforce: "Say 'hello' (briefly)" },
        });
        expect(parsed.body[1]).toMatchObject({ text: 'Continue.', controls: {} });
    });

    it.each([
        ['@CTL(unknown="x")', /unknown setting/],
        ['@CTL(model="one", model="two")', /duplicate setting/],
        ['@CTL(model=" ")', /non-empty string/],
        ['@CTL(model=42)', /literal string/],
        ['@CTL(reasoning="extreme")', /reasoning must be/],
        ['@CTL(enforce=notes)', /literal string/],
        ['@CTL(enforce="{notes}")', /no interpolation/],
        ['@CTL(enforce=["ok", 1])', /literal string/],
        ['@CTL(restrict="src")', /expected '\{'/],
        ['@CTL(restrict={other: []})', /unknown restriction/],
        ['@CTL(restrict={fs: [], fs: []})', /duplicate restriction/],
        ['@CTL(restrict={fs: [42]})', /literal string/],
        ['@CTL(enforce="x"', /unterminated @CTL/],
        ['@CTL() @CTL() Act.', /once at the start/],
        ['Act. @CTL(model="other")', /once at the start/],
        ['@CTL', /once at the start/],
        ['@Restrict fs["src"]', /has been removed; use @CTL/],
        ['@Enforce Be concise', /has been removed; use @CTL/],
        ['@FORBID Inventions', /has been removed; use @CTL/],
        ['@Human Approve?', /removed; request human input/],
    ])('rejects invalid or removed controls: %s', (instruction, error) => {
        expect(() => parseMarkdown(document('> ' + instruction))).toThrow(error);
    });

    it('keeps multiline control diagnostics on the original document line', () => {
        try {
            parseMarkdown(document('> @CTL(\n> model="ok",\n> reasoning="invalid") Act.'));
            expect.fail('invalid reasoning must fail');
        } catch (error) {
            expect(error).toMatchObject({ line: 8 });
        }
    });

    it('parses every maintained workflow with the current marker syntax', () => {
        const examples = path.resolve(__dirname, '..', 'examples');
        for (const file of fs.readdirSync(examples).filter(file => file.endsWith('.md'))) {
            expect(() => parseMarkdown(fs.readFileSync(path.join(examples, file), 'utf8')), file).not.toThrow();
        }
    });
});

describe('shared natural-language execution', () => {
    it('loads complete descriptor schemas and saves the code-review example as hydrated classes', async () => {
        const example = fs.readFileSync(path.resolve(__dirname, '..', 'examples', 'code-review.md'), 'utf8');
        const declarations = extractMarkdown(example).blocks.filter(block => block.kind === 'spl')[0].text;
        const source = document(fence(declarations) +
            '\n\n> Convert @notes into structured findings @validate[Review] and save to @review.\n\n' +
            fence('success [isinstance(review, Review), isinstance(review.findings[0], Item), review.findings[0].severity]'));
        const result = await run(parseMarkdown(source), { logger, backend: backend(async req => {
            const severity = { type: 'string', enum: ['low', 'medium', 'high'] };
            const item = {
                type: 'object', properties: {
                    severity, title: { type: 'string' }, location: { type: 'string' }, fix: { type: 'string' },
                }, required: ['severity', 'title', 'location', 'fix'], additionalProperties: false,
            };
            expect(await req.invokeAction!(action('load_variable', { name: 'Severity' }))).toEqual(severity);
            expect(await req.invokeAction!(action('load_variable', { name: 'Item' }))).toEqual(item);
            expect(await req.invokeAction!(action('load_variable', { name: 'Review' }))).toEqual({
                type: 'object', properties: { findings: { type: 'array', items: item } },
                required: ['findings'], additionalProperties: false,
            });
            await req.invokeAction!(action('save_variable', {
                name: 'review', schema: 'Review', value: {
                    findings: [{ severity: 'high', title: 'Bug', location: 'src/main.ts:1', fix: 'Validate the input' }],
                },
            }));
            return { text: 'Done', effective: {} };
        }) });
        expect(result, result.status === 'failure' ? result.failure.reason : undefined)
            .toMatchObject({ status: 'success', value: [true, true, 'high'] });
    });

    it('decodes a named struct schema without enforcing advisory field metadata', async () => {
        const source = document(fence(`struct Data:
    title: str [min=2]
    count: int
let count: int = 0`) + '\n\n> Save @data and @count.\n\n' + fence('success [data.title, data.count, count]'));
        expect(await run(parseMarkdown(source), { logger, backend: actions(
            action('save_variable', { name: 'data', value: { title: 'x', count: 15 }, schema: 'Data' }),
            action('save_variable', { name: 'count', value: 3, schema: 'int' }),
        ) })).toMatchObject({ status: 'success', value: ['x', 15n, 3n] });
    });

    it('supports named and inline raw JSON schemas without hydrating dynamic values', async () => {
        const source = document(fence(`let Schema = object:
    'type': 'integer'`) + '\n\n> Save @number and @text.\n\n' + fence('success [number, text, type(number)]'));
        expect(await run(parseMarkdown(source), { logger, backend: actions(
            action('save_variable', { name: 'number', value: 3, schema: 'Schema' }),
            action('save_variable', { name: 'text', value: 'ok', schema: { type: 'string' } }),
        ) })).toMatchObject({ status: 'success', value: [3, 'ok', 'number'] });
    });

    it.each([
        { findings: [{ severity: 'urgent', title: 'Bug' }] },
        { findings: [{ severity: 'high' }] },
        { findings: [{ severity: 'high', title: 'Bug', extra: true }] },
    ])('rejects invalid named descriptor schema data before later effects %#', async value => {
        const cwd = directory();
        const source = document(fence(`enum Severity = 'low' | 'high'
hydratable class Item:
    severity: Severity
    title: str
hydratable class Review:
    findings: list[Item]`) + '\n\n> Save @review.\n\n' + fence("write_file('saved.txt', 'must not execute')"));
        expect(await run(parseMarkdown(source), { cwd, logger, backend: actions(
            action('save_variable', { name: 'review', value, schema: 'Review' }),
        ) })).toMatchObject({ status: 'failure', failure: { status_code: 'validation_failed', reason: expect.stringContaining('review.findings[0]') } });
        expect(fs.existsSync(path.join(cwd, 'saved.txt'))).toBe(false);
    });

    it.each([
        ["let Schema = False", 'Schema', 'validation_failed'],
        ['pass', 'Missing', 'runtime_error'],
        ['class Ordinary:\n    title: str', 'Ordinary', 'runtime_error'],
        ['let result: int = 0', 'str', 'type_error'],
    ])('rejects unusable named schemas and conflicting binding contracts %#', async (declarations, schema, statusCode) => {
        const source = document(fence(declarations) + '\n\n> Save @result.');
        expect(await run(parseMarkdown(source), { logger, backend: actions(
            action('save_variable', { name: 'result', value: 'text', schema }),
        ) })).toMatchObject({ status: 'failure', failure: { status_code: statusCode } });
    });


    it('decodes JSON arguments for recursive typed functions and exposes their signatures', async () => {
        const source = document(fence(`def factorial(n: int) -> int:
    if n == 0:
        return 1
    return n * factorial(n - 1)
def fib(n: int) -> int:
    if n < 2:
        return n
    return fib(n - 1) + fib(n - 2)`) +
            '\n\n> Invoke @factorial with int 15 as argument -> @fact15\n\n' + fence('success fact15'));
        const result = await run(parseMarkdown(source), { logger, backend: backend(async req => {
            expect(req.prompt).toContain('def factorial(n: int) -> int');
            expect(req.prompt).toContain('def fib(n: int) -> int');
            expect(await req.invokeAction!(action('call_function', { name: 'factorial', args: [15] }))).toBe('1307674368000');
            expect(await req.invokeAction!(action('call_function', { name: 'fib', args: [10] }))).toBe('55');
            await req.invokeAction!(action('save_variable', { name: 'fact15', value: 1307674368000 }));
            return { text: 'Done', effective: {} };
        }) });
        expect(result).toMatchObject({ status: 'success', value: 1307674368000 });
    });

    it('decodes nested typed arguments while leaving unannotated arguments dynamic', async () => {
        const source = document(fence(`struct Data:
    values: list[int]
    ratio: float
def inspect(data: Data, dynamic, optional: int | None) -> str:
    return json_stringify([data.values, data.ratio, type(dynamic), optional])`) +
            '\n\n> Inspect the data.');
        expect(await run(parseMarkdown(source), { logger, backend: backend(async req => {
            expect(await req.invokeAction!(action('call_function', {
                name: 'inspect', args: [{ values: [1, 2], ratio: 1 }, 3, null],
            }))).toBe('[[1,2],1.0,"number",null]');
            return { text: 'Done', effective: {} };
        }) })).toMatchObject({ status: 'success' });
    });

    it('decodes arguments for guarded callable bindings', async () => {
        const source = document(fence(`def echo(value):
    return value
let callback: fn(int) -> int = echo`) + '\n\n> Invoke @callback.');
        expect(await run(parseMarkdown(source), { logger, backend: backend(async req => {
            expect(await req.invokeAction!(action('call_function', { name: 'callback', args: [42] }))).toBe('42');
            return { text: 'Done', effective: {} };
        }) })).toMatchObject({ status: 'success' });
    });

    it('decodes saved JSON against an existing binding contract', async () => {
        const source = document(fence('let count: int = 0') + '\n\n> Set @count to 15.\n\n' + fence('success count'));
        expect(await run(parseMarkdown(source), { logger, backend: actions(
            action('save_variable', { name: 'count', value: 15 }),
        ) })).toMatchObject({ status: 'success', value: 15n });
    });

    it.each([1.5, true, '15', Number.MAX_SAFE_INTEGER + 1])('rejects invalid typed tool arguments %s before executing the function', async value => {
        const cwd = directory();
        const source = document(fence(`def write(n: int):
    write_file('called.txt', 'must not execute')`) + '\n\n> Invoke @write.');
        expect(await run(parseMarkdown(source), { cwd, logger, backend: actions(
            action('call_function', { name: 'write', args: [value] }),
        ) })).toMatchObject({ status: 'failure', failure: { status_code: 'validation_failed', reason: expect.stringContaining('argument[0]') } });
        expect(fs.existsSync(path.join(cwd, 'called.txt'))).toBe(false);
    });

    it('describes cyclic collections and nested functions without changing shared values', async () => {
        const source = document(fence("let cyclic = []\ncyclic.append(cyclic)\ndef double(x):\n    return x * 2\nlet helpers = object:\n    'double': double") +
            '\n\n> Return the doubled length of @cyclic.');
        let turn = 0;
        const result = await run(parseMarkdown(source), {
            logger, backend: backend(async req => {
                expect(req.prompt).toContain('<circular reference>');
                expect(req.prompt).toContain('"helpers":{"double":"def double(x)"}');
                return { text: 'Done', effective: {}, ...(turn++ === 0 ? { action: action('success', { value: 2 }) } : {}) };
            }),
        });
        expect(result).toMatchObject({ status: 'success', value: 2 });
    });

    it('executes mixed blocks in order, with shared functions and variables', async () => {
        const requests: LlmRequest[] = [];
        const source = document(`${fence('let count = 2\ndef double(x):\n    return x * 2')}

> Set @count to @double of its current value.

${fence('assert count == 4')}

> Return @count as the document result.

${fence("fail 'must not execute'")}`, "model: document-model\npreamble: Be concise.\n");
        const result = await run(parseMarkdown(source), {
            logger, model: 'cli-model',
            backend: backend(async (req) => {
                requests.push(req);
                const actions = [
                    action('call_function', { name: 'double', args: [2] }),
                    action('save_variable', { name: 'count', value: 4 }),
                    undefined,
                    action('load_variable', { name: 'count' }),
                    action('success', { value: 4 }),
                ];
                return { text: 'Done', effective: {}, action: actions[requests.length - 1] };
            }),
        });
        expect(result).toEqual({ status: 'success', value: 4, hasValue: true });
        expect(requests).toHaveLength(5);
        expect(requests[0].naturalLanguage).toBe(true);
        expect(requests[0].model).toBe('cli-model');
        expect(requests[0].prompt).toContain('"double":"def double(x)"');
        expect(requests[3].prompt).toContain('"count":4');
        expect(requests[1].prompt).toContain('"result":{"value":4}');
        expect(requests[0].runtimeTools?.map(tool => tool.name)).toContain('call_function');
        for (const req of requests) expect(req.prompt.startsWith(`${RUNTIME_PREAMBLE}\n\nBe concise.`)).toBe(true);
    });

    it('prepends the preamble to nested generation, including repairs, and preserves model precedence', async () => {
        const requests: LlmRequest[] = [];
        const source = document(fence("def number():\n    return ask(fmt='integer', repairs=1, model='other') 'Number?'") +
            '\n\n> Generate an integer using @number.', 'model: default-model\npreamble: Custom guidance.\n');
        let naturalTurn = 0;
        const result = await run(parseMarkdown(source), {
            logger,
            backend: backend(async (req) => {
                requests.push(req);
                if (req.naturalLanguage) return { text: 'Done', effective: {}, action: naturalTurn++ === 0
                    ? action('call_function', { name: 'number', args: [] }) : action('success', { value: 7 }) };
                return { text: requests.length === 2 ? '"bad"' : '7', effective: {} };
            }),
        });
        expect(result).toMatchObject({ status: 'success', value: 7 });
        expect(requests.map(req => req.model)).toEqual(['default-model', 'other', 'other', 'default-model']);
        for (const req of requests) expect(req.prompt.startsWith(`${RUNTIME_PREAMBLE}\n\nCustom guidance.`)).toBe(true);
        expect(requests[2].prompt).toContain('Validation failed');
    });

    it.each(['success', 'fail'])('honors whole-document termination: %s', async (name) => {
        const result = await run(parseMarkdown(document(`> End here.\n\n${fence("fail 'later'")}`)), {
            logger, backend: actions(action(name, name === 'fail' ? { reason: 'stop' } : { value: 9 })),
        });
        if (name === 'fail') expect(result).toMatchObject({ status: 'failure', failure: { reason: 'stop', line: 6 } });
        else expect(result).toMatchObject({ status: 'success', value: 9 });
    });

    it('supports scoped restrictions, caught failures, loops, schema validation and raw tools', async () => {
        const cwd = directory();
        fs.mkdirSync(path.join(cwd, 'allowed'));
        const code = `let total = 0
for n in range(4):
    total += n
let caught = False
try:
    restrict './allowed':
        write_file('outside.txt', 'blocked')
except error:
    caught = error.status_code == 'restriction_violation'
assert caught
let Schema = object:
    'type': 'integer'
let result = ask(schema=Schema) 'Return {total}'
write_file('allowed/result.txt', str(result))
return result`;
        let naturalTurn = 0;
        const result = await run(parseMarkdown(document(fence(`def calculate():
${code.split('\n').map(line => '    ' + line).join('\n')}`) +
            '\n\n> Calculate, validate and save a result using @calculate.')), {
            logger, cwd,
            backend: backend(async req => req.naturalLanguage
                ? { text: 'Done', effective: {}, action: naturalTurn++ === 0
                    ? action('call_function', { name: 'calculate', args: [] }) : action('success', { value: 6 }) }
                : { text: '6', effective: {} }),
        });
        expect(result).toMatchObject({ status: 'success', value: 6 });
        expect(fs.existsSync(path.join(cwd, 'outside.txt'))).toBe(false);
        expect(fs.readFileSync(path.join(cwd, 'allowed', 'result.txt'), 'utf8')).toBe('6');
    });

    it('fails immediately on human input without a handler', async () => {
        const cwd = directory();
        let turn = 0;
        const result = await run(parseMarkdown(document('> Ask a human.')), {
            logger, cwd, backend: backend(async () => {
                turn++;
                return { text: 'Ask', effective: {}, action: action('ask_human', { question: 'Approve?' }) };
            }),
        });
        expect(result).toMatchObject({ status: 'failure', failure: { reason: expect.stringContaining('human handler') } });
        expect(turn).toBe(1);
    });

    it('returns a direct human answer to the same agent session and shared bindings', async () => {
        const human = vi.fn(async () => '  approved\nexactly  ');
        const source = document('> Ask a human to approve this and save to @answer.\n\n' + fence('success answer'));
        let turns = 0;
        const result = await run(parseMarkdown(source), {
            logger, human, backend: backend(async req => {
                turns++;
                const answer = await req.invokeAction!(action('ask_human', { question: 'Approve?' }));
                expect(answer).toBe('  approved\nexactly  ');
                await req.invokeAction!(action('save_variable', { name: 'answer', value: answer }));
                return { text: 'Done', effective: {} };
            }),
        });
        expect(result).toMatchObject({ status: 'success', value: '  approved\nexactly  ' });
        expect(human).toHaveBeenCalledExactlyOnceWith('Approve?', 6);
        expect(turns).toBe(1);
    });







    it('loads and saves JSON variables, accesses env and args, and preserves persistence', async () => {
        const source = document('> Set @result.\n\n' + fence("success [result, $args]"));
        let turn = 0;
        const result = await run(parseMarkdown(source), {
            logger, args: ['one'],
            backend: backend(async req => {
                const next = [
                    action('get_env', { name: 'SPL_TEST_UNSET_ENVIRONMENT_VARIABLE' }),
                    action('load_variable', { name: '$args' }),
                    action('save_variable', { name: 'result', value: { setup: 'a', punchline: 'b' } }),
                    action('load_variable', { name: 'result' }),
                    undefined,
                ][turn++];
                if (turn === 2) expect(req.prompt).toContain('"result":{"value":null}');
                if (turn === 5) expect(req.prompt).toContain('"punchline":"b"');
                return { text: 'Done', effective: {}, action: next };
            }),
        });
        expect(result).toMatchObject({ status: 'success', value: [{ setup: 'a', punchline: 'b' }, ['one']] });
    });

    it('fails validation without updating shared bindings or asking the model to retry', async () => {
        const source = document(fence('let answer = 1') + '\n\n> Save a validated integer to @answer.\n\n' + fence('success answer'));
        const session = new ExecutionSession();
        const schema = { type: 'integer', minimum: 2 };
        const call = vi.fn(async (req: LlmRequest) => {
            await req.invokeAction!(action('save_variable', { name: 'answer', value: 'bad', schema }));
            throw new Error('must stop before another action');
        });
        expect(await session.run(parseMarkdown(source), { logger, backend: backend(call) }))
            .toMatchObject({ status: 'failure', failure: { status_code: 'validation_failed' } });
        expect(call).toHaveBeenCalledOnce();
        expect(await session.run(parseMarkdown(document(fence('success answer'))), { logger, backend: new NoLlm() }))
            .toMatchObject({ status: 'success', value: 1 });
    });


    it.each([
        action('submit_spl', { source: "success 1" }),
        action('save_variable', { name: '$env', value: {} }),
        action('save_variable', { name: 'human', value: 'invalid' }),
        action('save_variable', { name: 'x', value: { __fn: 'user' } }),
        action('call_function', { name: 'missing', args: [] }),
    ])('reports invalid tool calls explicitly: $name', async invalid => {
        let turn = 0;
        expect(await run(parseMarkdown(document('> Act.')), {
            logger, backend: backend(async () => {
                turn++;
                return { text: 'Act', effective: {}, action: invalid };
            }),
        })).toMatchObject({ status: 'failure', failure: { status_code: expect.stringMatching(/runtime_error|validation_failed/) } });
        expect(turn).toBe(1);
    });

    it('enforces narrowed restrictions across functions and restores them after the command', async () => {
        const cwd = directory();
        const source = document(fence("def write():\n    write_file('outside.txt', 'blocked')") +
            '\n\n> Restrict file access and invoke @write.');
        expect(await run(parseMarkdown(source), { cwd, logger, backend: actions(
            action('restrict', { kind: 'fs', value: './allowed' }),
            action('call_function', { name: 'write', args: [] }),
        ) })).toMatchObject({ status: 'failure', failure: { status_code: 'restriction_violation' } });
        expect(fs.existsSync(path.join(cwd, 'outside.txt'))).toBe(false);
    });

    it('scopes guidance and restrictions to one blockquote, including nested model calls', async () => {
        const cwd = directory();
        const source = document(fence("def generate():\n    return ask 'Generate'") +
            '\n\n> Apply guidance and restrictions, then invoke @generate.\n\n> Write a file outside the previous restriction.');
        let turn = 0;
        const result = await run(parseMarkdown(source), { cwd, logger, backend: backend(async req => {
            if (!req.naturalLanguage) {
                expect(req.prompt).toContain('Follow: Be formal');
                expect(req.restrictions.has('fs')).toBe(true);
                return { text: 'Formal answer', effective: {} };
            }
            if (turn === 4) {
                expect(req.restrictions.has('fs')).toBe(false);
                expect(req.prompt).not.toContain('Follow: Be formal');
            }
            return { text: 'Done', effective: {}, action: [
                action('set_guidance', { kind: 'enforce', text: 'Be formal' }),
                action('restrict', { kind: 'fs', value: './allowed' }),
                action('call_function', { name: 'generate', args: [] }),
                undefined,
                action('write_file', { path: 'outside.txt', content: 'allowed after command' }),
                action('success', { value: 'done' }),
            ][turn++] };
        }) });
        expect(result).toMatchObject({ status: 'success', value: 'done' });
        expect(fs.readFileSync(path.join(cwd, 'outside.txt'), 'utf8')).toBe('allowed after command');
    });

    it('applies CTL before the first action and restores defaults for following blocks', async () => {
        const cwd = directory();
        const requests: LlmRequest[] = [];
        const source = document(fence("def generate():\n    return ask(model='nested-model') 'Generate'") +
            '\n\n> @CTL(restrict={fs: ["./allowed"], exec: ["git"], net: ["api.example.com"], mcp: ["docs/search"]}, ' +
            'enforce=["Be formal", "Be brief"], forbid="Inventions", model="quote-model", reasoning="high") Invoke @generate.' +
            '\n\n> Write outside the previous restriction.\n\n' + fence("success ask 'Final'"), 'model: document-model\n');
        let turn = 0;
        const result = await run(parseMarkdown(source), { cwd, logger, backend: backend(async req => {
            requests.push(req);
            if (requests.length <= 3) {
                expect(req.prompt).toContain('Follow: Be formal');
                expect(req.prompt).toContain('Follow: Be brief');
                expect(req.prompt).toContain('Avoid: Inventions');
                expect(req.restrictions.has('fs')).toBe(true);
                expect(() => req.restrictions.checkExec('npm')).toThrow(/blocked/);
                expect(() => req.restrictions.checkHost('example.com')).toThrow(/blocked/);
                expect(req.restrictions.has('mcp')).toBe(true);
                expect(req.prompt).not.toContain('@CTL(');
            } else {
                expect(req.restrictions.active).toBe(false);
                expect(req.prompt).not.toContain('Follow: Be formal');
            }
            if (!req.naturalLanguage) return { text: 'Generated', effective: {} };
            const next = [
                action('call_function', { name: 'generate', args: [] }), undefined,
                action('write_file', { path: 'outside.txt', content: 'allowed' }), undefined,
            ][turn++];
            return { text: 'Done', effective: {}, action: next };
        }) });
        expect(result, result.status === 'failure' ? result.failure.reason : undefined)
            .toMatchObject({ status: 'success', value: 'Generated' });
        expect(requests.map(req => req.model)).toEqual([
            'quote-model', 'nested-model', 'quote-model', 'document-model', 'document-model', 'document-model',
        ]);
        expect(requests.map(req => req.reasoningEffort)).toEqual(['high', undefined, 'high', 'medium', 'medium', undefined]);
        expect(fs.readFileSync(path.join(cwd, 'outside.txt'), 'utf8')).toBe('allowed');
    });

    it('preserves CLI model precedence over blockquote controls', async () => {
        const result = await run(parseMarkdown(document('> @CTL(model="quote", reasoning="low") Act.')), {
            logger, model: 'cli', backend: backend(async req => {
                expect(req.model).toBe('cli');
                expect(req.reasoningEffort).toBe('low');
                return { text: 'Done', effective: {} };
            }),
        });
        expect(result.status).toBe('success');
    });

    it('enforces CTL restrictions on the first function call without relying on the model', async () => {
        const cwd = directory();
        const source = document(fence("def write():\n    write_file('outside.txt', 'blocked')") +
            '\n\n> @CTL(restrict={fs: ["./allowed"]}) Invoke @write.');
        expect(await run(parseMarkdown(source), { cwd, logger, backend: actions(
            action('call_function', { name: 'write', args: [] }),
        ) })).toMatchObject({ status: 'failure', failure: { status_code: 'restriction_violation' } });
        expect(fs.existsSync(path.join(cwd, 'outside.txt'))).toBe(false);
    });

    it('preserves existing restriction validation before contacting the model', async () => {
        expect(await run(parseMarkdown(document('> @CTL(restrict={net: []}) Act.')), {
            logger, backend: new NoLlm(),
        })).toMatchObject({ status: 'failure', failure: {
            status_code: 'runtime_error', reason: 'restrict net needs at least one entry',
        } });
    });
});

function action(name: string, args: Record<string, unknown>): RuntimeAction { return { name, arguments: args }; }
function actions(...steps: RuntimeAction[]): LlmBackend {
    return backend(async req => {
        for (const step of steps.splice(0)) await req.invokeAction!(step);
        return { text: 'Done', effective: {} };
    });
}
