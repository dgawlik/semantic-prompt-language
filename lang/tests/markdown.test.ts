import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Checkpoint } from '../src/checkpoint.js';
import { ExecutionSession, run } from '../src/interpreter.js';
import type { LlmBackend, LlmRequest, LlmResponse, RuntimeAction } from '../src/llm.js';
import { Logger } from '../src/logger.js';
import { extractMarkdown, isWorkflowMarkdown, parseMarkdown } from '../src/markdown.js';
import { RUNTIME_PREAMBLE } from '../src/preamble.js';
import { RecordingBackend, ReplayBackend, TraceBackend } from '../src/recording.js';
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
    it('accepts the supplied example without changing version or syntax', () => {
        const source = fs.readFileSync(path.resolve(__dirname, '..', '..', 'spl2-examples'), 'utf8');
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
});

describe('shared natural-language execution', () => {
    it('describes cyclic collections and nested functions without changing shared values', async () => {
        const source = document(fence("let cyclic = []\ncyclic.append(cyclic)\ndef double(x):\n    return x * 2\nlet helpers = {'double': double}") +
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
let Schema = {'type': 'integer'}
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

    it('fails immediately on human input without a checkpoint', async () => {
        const cwd = directory();
        let turn = 0;
        const result = await run(parseMarkdown(document('> Ask a human.')), {
            logger, cwd, backend: backend(async () => {
                turn++;
                return { text: 'Ask', effective: {}, action: action('ask_human', { question: 'Approve?' }) };
            }),
        });
        expect(result).toMatchObject({ status: 'failure', failure: { reason: expect.stringContaining('checkpoint') } });
        expect(turn).toBe(1);
    });

    it('resumes agent human input without repeating completed model turns or effects', async () => {
        const cwd = directory();
        const source = document('> Write a draft, request approval, and return it.');
        const context = { source, cwd, runtime: 'test' };
        const file = path.join(cwd, 'checkpoint.jsonl');
        let checkpoint = Checkpoint.create(file, context);
        const first = await run(parseMarkdown(source), {
            logger, cwd, checkpoint, backend: actions(
                action('write_file', { path: 'draft.txt', content: 'original' }),
                action('ask_human', { question: 'Approve?' }),
            ),
        });
        checkpoint.close();
        expect(first.status).toBe('waiting_for_input');
        fs.writeFileSync(path.join(cwd, 'draft.txt'), 'edited');
        checkpoint = Checkpoint.resume(file, context);
        checkpoint.answer(checkpoint.request!.request_id, 'approved');
        const second = await run(parseMarkdown(source), { logger, cwd, checkpoint, backend: backend(async req => {
            expect(req.prompt).toContain('"value":"approved"');
            return { text: 'Done', effective: {}, action: action('success', { value: 'approved' }) };
        }) });
        checkpoint.finish(second.status === 'success' ? 'success' : 'failure');
        checkpoint.close();
        expect(second).toMatchObject({ status: 'success', value: 'approved' });
        expect(fs.readFileSync(path.join(cwd, 'draft.txt'), 'utf8')).toBe('edited');
    });

    it('resumes inside invoked SPL functions without repeating effects or duplicating mutations', async () => {
        const cwd = directory();
        const source = document(fence(`let count = 0
def approve():
    count += 1
    write_file('function.txt', 'original')
    return human 'Function approval?'`) + '\n\n> Invoke @approve and save its answer to @answer.\n\n' + fence('success [count, answer]'));
        const context = { source, cwd, runtime: 'test' };
        const file = path.join(cwd, 'checkpoint.jsonl');
        let checkpoint = Checkpoint.create(file, context);
        const first = await run(parseMarkdown(source), {
            cwd, checkpoint, logger, backend: actions(action('call_function', { name: 'approve', args: [] })),
        });
        checkpoint.close();
        expect(first).toMatchObject({ status: 'waiting_for_input', request: { question: 'Function approval?' } });
        fs.writeFileSync(path.join(cwd, 'function.txt'), 'edited');
        checkpoint = Checkpoint.resume(file, context);
        checkpoint.answer(checkpoint.request!.request_id, 'yes');
        let turn = 0;
        const result = await run(parseMarkdown(source), { cwd, checkpoint, logger, backend: backend(async req => {
            expect(req.prompt).toContain('"result":{"value":"yes"}');
            return { text: 'Done', effective: {}, action: turn++ === 0 ? action('save_variable', { name: 'answer', value: 'yes' }) : undefined };
        }) });
        checkpoint.finish('success');
        checkpoint.close();
        expect(result).toMatchObject({ status: 'success', value: [1, 'yes'] });
        expect(fs.readFileSync(path.join(cwd, 'function.txt'), 'utf8')).toBe('edited');
    });

    it('replays function calls, shared mutations and nested generation without repeating agent effects', async () => {
        const cwd = directory();
        const file = path.join(cwd, 'recording.jsonl');
        const source = document(fence("let count = 0\ndef number():\n    count += 1\n    write_file('number.txt', 'original')\n    return ask(fmt='integer') 'Number?'") +
            '\n\n> Use @number and save the result to @numberResult.\n\n' + fence('assert count == 1\nsuccess numberResult'));
        const live = backend(async req => {
            if (!req.naturalLanguage) return { text: '42', effective: {} };
            const value = await req.invokeAction!(action('call_function', { name: 'number', args: [] }));
            expect(value).toBe(42);
            await req.invokeAction!(action('save_variable', { name: 'numberResult', value }));
            return { text: 'Done', effective: {} };
        });
        const recording = new TraceBackend(live, file);
        expect(await run(parseMarkdown(source), { logger, cwd, backend: recording })).toMatchObject({ value: 42 });
        await recording.close();
        fs.writeFileSync(path.join(cwd, 'number.txt'), 'edited');
        const replay = new ReplayBackend(file);
        expect(await run(parseMarkdown(source), { logger, cwd, backend: replay })).toMatchObject({ value: 42 });
        await replay.close();
        expect(fs.readFileSync(path.join(cwd, 'number.txt'), 'utf8')).toBe('edited');
    });

    it.each([
        action('success', { value: 9 }),
        action('fail', { reason: 'stop now' }),
        action('call_function', { name: 'missing', args: [] }),
        action('save_variable', { name: 'value', value: 'bad', schema: { type: 'integer' } }),
        action('read_file', { path: 'missing.txt' }),
    ])('replays an immediately terminating $name call without an extra model response', async step => {
        const cwd = directory();
        const file = path.join(cwd, 'trace.jsonl');
        const source = document('> Execute the requested action.');
        const trace = new TraceBackend(actions(step), file);
        const expected = await run(parseMarkdown(source), { logger, cwd, backend: trace });
        await trace.close();
        expect(expected).toMatchObject({ status: step.name === 'success' ? 'success' : 'failure' });
        const replay = new ReplayBackend(file);
        expect(await run(parseMarkdown(source), { logger, cwd, backend: replay })).toEqual(expected);
        await replay.close();
    });

    it('rejects generation-only recordings before blockquote actions', async () => {
        const cwd = directory();
        const recording = new RecordingBackend(new NoLlm(), path.join(cwd, 'record.jsonl'));
        expect(await run(parseMarkdown(document('> Act.')), { logger, cwd, backend: recording }))
            .toMatchObject({ status: 'failure', failure: { status_code: 'restriction_violation' } });
        await recording.close();
    });

    it('fails explicitly on a mismatched runtime-tool trace without executing the tool', async () => {
        const cwd = directory();
        const file = path.join(cwd, 'trace.jsonl');
        const source = document('> Write a file.');
        let turn = 0;
        const trace = new TraceBackend(backend(async () => ({
            text: 'Done', effective: {}, action: turn++ === 0 ? action('write_file', { path: 'file.txt', content: 'original' }) : undefined,
        })), file);
        const first = await run(parseMarkdown(source), { cwd, logger, backend: trace });
        expect(first.status).toBe('success');
        await trace.close();
        const entries = fs.readFileSync(file, 'utf8').trimEnd().split('\n').map(line => JSON.parse(line));
        entries[2].tool.arguments.path = 'different.txt';
        fs.writeFileSync(file, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
        fs.writeFileSync(path.join(cwd, 'file.txt'), 'edited');
        const result = await run(parseMarkdown(source), { cwd, logger, backend: new ReplayBackend(file) });
        expect(result).toMatchObject({ status: 'failure', failure: { status_code: 'llm_error', reason: expect.stringContaining('replay tool mismatch') } });
        expect(fs.readFileSync(path.join(cwd, 'file.txt'), 'utf8')).toBe('edited');
        expect(fs.existsSync(path.join(cwd, 'different.txt'))).toBe(false);
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

    it('records requested environment values without exposing the full environment or reading it again on replay', async () => {
        const cwd = directory();
        const file = path.join(cwd, 'trace.jsonl');
        const source = document('> Read the configured environment value.\n\n' + fence('success value'));
        vi.stubEnv('SPL_AGENT_TEST_VALUE', 'original');
        vi.stubEnv('SPL_AGENT_TEST_PRIVATE', 'do-not-include');
        let turn = 0;
        const trace = new TraceBackend(backend(async req => {
            expect(req.prompt).not.toContain('do-not-include');
            if (turn === 1) expect(req.prompt).toContain('"value":"original"');
            return { text: 'Done', effective: {}, action: [
                action('get_env', { name: 'SPL_AGENT_TEST_VALUE' }),
                action('save_variable', { name: 'value', value: 'original' }),
                undefined,
            ][turn++] };
        }), file);
        const expected = await run(parseMarkdown(source), { cwd, logger, backend: trace });
        await trace.close();
        vi.stubEnv('SPL_AGENT_TEST_VALUE', 'changed');
        const replay = new ReplayBackend(file);
        expect(await run(parseMarkdown(source), { cwd, logger, backend: replay })).toEqual(expected);
        await replay.close();
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
});

function action(name: string, args: Record<string, unknown>): RuntimeAction { return { name, arguments: args }; }
function actions(...steps: RuntimeAction[]): LlmBackend {
    return backend(async req => {
        for (const step of steps.splice(0)) await req.invokeAction!(step);
        return { text: 'Done', effective: {} };
    });
}
