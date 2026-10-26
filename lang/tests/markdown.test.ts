import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Checkpoint } from '../src/checkpoint.js';
import { run } from '../src/interpreter.js';
import type { LlmBackend, LlmRequest, LlmResponse } from '../src/llm.js';
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
        [document(fence('if True {') + '\n\n' + fence('pass\n}')), /unclosed block/],
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
        const source = document(fence("let cyclic = []\ncyclic.append(cyclic)\ndef double(x) { return x * 2 }\nlet helpers = {'double': double}") +
            '\n\n> Return the doubled length of @cyclic.');
        const result = await run(parseMarkdown(source), {
            logger, backend: backend(async req => {
                expect(req.prompt).toContain('<circular reference>');
                expect(req.prompt).toContain('"helpers":{"double":"def double(x)"}');
                return { text: 'Submitted', effective: {}, spl: "success helpers['double'](len(cyclic))" };
            }),
        });
        expect(result).toMatchObject({ status: 'success', value: 2 });
    });

    it('executes mixed blocks in order, with shared functions and variables', async () => {
        const requests: LlmRequest[] = [];
        const source = document(`${fence('let count = 2\ndef double(x) { return x * 2 }')}

> Set @count to @double of its current value.

${fence('assert count == 4')}

> Return @count as the document result.

${fence("fail 'must not execute'")}`, "model: document-model\npreamble: Be concise.\n");
        const result = await run(parseMarkdown(source), {
            logger, model: 'cli-model',
            backend: backend(async (req) => {
                requests.push(req);
                return { text: 'Submitted', effective: {}, spl: requests.length === 1 ? 'count = double(count)' : 'success count' };
            }),
        });
        expect(result).toEqual({ status: 'success', value: 4, hasValue: true });
        expect(requests).toHaveLength(2);
        expect(requests[0].naturalLanguage).toBe(true);
        expect(requests[0].model).toBe('cli-model');
        expect(requests[0].prompt).toContain('"double":"def double(x)"');
        expect(requests[1].prompt).toContain('"count":4');
        for (const req of requests) expect(req.prompt.startsWith(`${RUNTIME_PREAMBLE}\n\nBe concise.`)).toBe(true);
    });

    it('prepends the preamble to nested generation, including repairs, and preserves model precedence', async () => {
        const requests: LlmRequest[] = [];
        const source = document('> Generate an integer and return it.', 'model: default-model\npreamble: Custom guidance.\n');
        const result = await run(parseMarkdown(source), {
            logger,
            backend: backend(async (req) => {
                requests.push(req);
                if (req.naturalLanguage) return { text: 'Submitted', effective: {}, spl: "success ask(fmt='integer', repairs=1, model='other') 'Number?'" };
                return { text: requests.length === 2 ? '"bad"' : '7', effective: {} };
            }),
        });
        expect(result).toMatchObject({ status: 'success', value: 7 });
        expect(requests.map(req => req.model)).toEqual(['default-model', 'other', 'other']);
        for (const req of requests) expect(req.prompt.startsWith(`${RUNTIME_PREAMBLE}\n\nCustom guidance.`)).toBe(true);
        expect(requests[2].prompt).toContain('Validation failed');
    });

    it.each(['success 9', 'return 9', "fail 'stop'"])('honors whole-document termination: %s', async (spl) => {
        const result = await run(parseMarkdown(document(`> End here.\n\n${fence("fail 'later'")}`)), {
            logger, backend: backend(async () => ({ text: 'Submitted', effective: {}, spl })),
        });
        if (spl.startsWith('fail')) expect(result).toMatchObject({ status: 'failure', failure: { reason: 'stop', line: 6 } });
        else expect(result).toMatchObject({ status: 'success', value: 9 });
    });

    it('supports scoped restrictions, caught failures, loops, schema validation and raw tools', async () => {
        const cwd = directory();
        fs.mkdirSync(path.join(cwd, 'allowed'));
        const spl = `let total = 0
for n in range(4) { total += n }
let caught = False
try {
    restrict './allowed' { write_file('outside.txt', 'blocked') }
} except error { caught = error.status_code == 'restriction_violation' }
assert caught
let Schema = {'type': 'integer'}
let result = ask(schema=Schema) 'Return {total}'
write_file('allowed/result.txt', str(result))
success result`;
        const result = await run(parseMarkdown(document('> Calculate, validate and save a result.')), {
            logger, cwd,
            backend: backend(async req => req.naturalLanguage
                ? { text: 'Submitted', effective: {}, spl }
                : { text: '6', effective: {} }),
        });
        expect(result).toMatchObject({ status: 'success', value: 6 });
        expect(fs.existsSync(path.join(cwd, 'outside.txt'))).toBe(false);
        expect(fs.readFileSync(path.join(cwd, 'allowed', 'result.txt'), 'utf8')).toBe('6');
    });

    it.each([undefined, '', 'let x =', "@(model='x')\npass"])('surfaces missing or invalid programs rather than succeeding: %s', async spl => {
        const result = await run(parseMarkdown(document('> Do work.')), {
            logger, backend: backend(async () => ({ text: 'Done', effective: {}, spl })),
        });
        expect(result.status).toBe('failure');
    });

    it('preflights generated human input before executing generated effects', async () => {
        const cwd = directory();
        const result = await run(parseMarkdown(document('> Ask a human.')), {
            logger, cwd, backend: backend(async () => ({
                text: 'Submitted', effective: {}, spl: "write_file('never.txt', 'no')\nsuccess human 'Approve?'",
            })),
        });
        expect(result).toMatchObject({ status: 'failure', failure: { reason: expect.stringContaining('checkpoint') } });
        expect(fs.existsSync(path.join(cwd, 'never.txt'))).toBe(false);
    });

    it('resumes generated human input without regenerating code or repeating completed effects', async () => {
        const cwd = directory();
        const source = document('> Write a draft, request approval, and return it.');
        const context = { source, cwd, runtime: 'test' };
        const file = path.join(cwd, 'checkpoint.jsonl');
        let checkpoint = Checkpoint.create(file, context);
        const first = await run(parseMarkdown(source), {
            logger, cwd, checkpoint, backend: backend(async () => ({
                text: 'Submitted', effective: {},
                spl: "write_file('draft.txt', 'original')\nlet approval = human 'Approve?'\nsuccess approval",
            })),
        });
        checkpoint.close();
        expect(first.status).toBe('waiting_for_input');
        fs.writeFileSync(path.join(cwd, 'draft.txt'), 'edited');
        checkpoint = Checkpoint.resume(file, context);
        checkpoint.answer(checkpoint.request!.request_id, 'approved');
        const second = await run(parseMarkdown(source), { logger, cwd, checkpoint, backend: new NoLlm() });
        checkpoint.finish(second.status === 'success' ? 'success' : 'failure');
        checkpoint.close();
        expect(second).toMatchObject({ status: 'success', value: 'approved' });
        expect(fs.readFileSync(path.join(cwd, 'draft.txt'), 'utf8')).toBe('edited');
    });

    it.each(['trace', 'record'] as const)('replays submitted SPL and its nested generation in %s mode', async mode => {
        const cwd = directory();
        const file = path.join(cwd, 'recording.jsonl');
        const source = document('> Generate a number and return it.');
        const live = backend(async req => req.naturalLanguage
            ? { text: 'Submitted', effective: {}, spl: "success ask(fmt='integer') 'Number?'" }
            : { text: '42', effective: {} });
        const recording = mode === 'trace' ? new TraceBackend(live, file) : new RecordingBackend(live, file);
        expect(await run(parseMarkdown(source), { logger, cwd, backend: recording })).toMatchObject({ value: 42 });
        await recording.close();
        const replay = new ReplayBackend(file);
        expect(await run(parseMarkdown(source), { logger, cwd, backend: replay })).toMatchObject({ value: 42 });
        await replay.close();
    });
});
