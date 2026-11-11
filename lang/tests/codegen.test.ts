import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExecutionSession, run, type RunOptions } from '../src/interpreter.js';
import type { LlmBackend, LlmRequest, LlmResponse } from '../src/llm.js';
import { Logger } from '../src/logger.js';
import { parseMarkdown } from '../src/markdown.js';
import { parse } from '../src/parser.js';
import { Pin } from '../src/pin.js';
import { Trace } from '../src/trace.js';
import type { LogEvent, ModelStreamEvent } from '../src/log-events.js';

const logger = new Logger('silent');
const document = (body: string) => `---\nextension: semantic-prompt-language\nversion: 1\n---\n\n${body}`;
const fence = (code: string) => `\`\`\`spl\n${code}\n\`\`\``;
const instruction = (text: string) => `> @CODEGEN '${text}'`;
const unused: LlmBackend = { async call() { throw new Error('unexpected model call'); }, async close() {} };
const signature = (input: string) => `# @CODEGEN sha256:${createHash('sha256').update(input).digest('hex')}`;
let cwd: string;
let workflow: string;

beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'spl-codegen-'));
    fs.mkdirSync(path.join(cwd, 'workflows'));
    workflow = path.join(cwd, 'workflows', 'friendly-flow.md');
});
afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(cwd, { recursive: true, force: true });
});

function scripted(...responses: string[]) {
    return {
        call: vi.fn(async (_req: LlmRequest): Promise<LlmResponse> => {
            const text = responses.shift();
            if (text === undefined) throw new Error('unexpected generation');
            return { text, effective: { model: 'test' } };
        }),
        async close() {},
    };
}
const files = () => fs.readdirSync(path.dirname(workflow)).filter(file => file.endsWith('.spl'));
async function execute(source: string, backend = unused, traceFile?: string, options: Partial<RunOptions> = {}) {
    const program = parseMarkdown(source);
    const trace = traceFile ? Trace.open(path.join(cwd, traceFile), { source, runtime: 'test', cwd }) : undefined;
    try {
        const result = await run(program, { backend, logger, cwd, source: workflow, ...options, trace });
        trace?.finish(result);
        return result;
    } finally {
        trace?.close();
    }
}

describe('@CODEGEN syntax', () => {
    it('parses case-insensitive markers, controls and multiline literal descriptions', () => {
        const program = parseMarkdown(document(`> @CTL(model='custom', reasoning='high')
>
> @codegen '''
> Define answer(value).
> Return value unchanged, including @references.
> '''`));
        expect(program.body).toEqual([{
            t: 'natural', line: 6, codegen: true,
            text: '\nDefine answer(value).\nReturn value unchanged, including @references.\n',
            controls: { model: 'custom', reasoning: 'high' },
        }]);
        expect(parseMarkdown(document(String.raw`> @CODEGEN r'Define path() returning C:\work\{literal}'`)).body[0])
            .toMatchObject({ text: String.raw`Define path() returning C:\work\{literal}`, codegen: true });
    });

    it.each([
        ['@CODEGEN', /literal string/],
        ['@CODEGEN Define a function', /literal string/],
        ["@CODEGEN ''", /non-empty string/],
        ["@CODEGEN '   '", /non-empty string/],
        ["@CODEGEN '{description}'", /no interpolation/],
        ["@CODEGEN 'Define a function' trailing", /single literal string/],
        ["@CODEGEN 'First' @CODEGEN 'Second'", /single literal string/],
        ["Act. @CODEGEN 'Define a function'", /at the start/],
        ["@CODEGEN 'Define a function' @CTL()", /single literal string/],
    ])('rejects invalid directives before execution: %s', (body, error) => {
        expect(() => parseMarkdown(document('> ' + body))).toThrow(error);
    });

    it('preserves string diagnostics on original multiline document lines', () => {
        expect(() => parseMarkdown(document("> @CTL(\n> model='custom')\n> @CODEGEN '{input}'")))
            .toThrow(expect.objectContaining({ line: 8 }));
    });

    it('checks CODEGEN syntax through the CLI without generating functions or cache files', () => {
        fs.writeFileSync(workflow, document(`${instruction('Define answer()')}\n\n${fence('success answer()')}`));
        const cli = path.resolve(__dirname, '..', 'dist', 'cli.js');
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
    it('registers multiple functions without executing them, preserving lexical scope', async () => {
        const backend = scripted(`def answer(value):
    return helper(value) + offset
def helper(value):
    return value * 2`);
        const source = document(`${fence('let offset = 1')}\n\n${instruction('Define answer(value) using helper(value) and offset')}\n\n${fence('offset = 2\nsuccess answer(3)')}`);
        expect(await execute(source, backend)).toMatchObject({ status: 'success', value: 8 });
        expect(backend.call).toHaveBeenCalledOnce();
        const req = backend.call.mock.calls[0][0];
        expect(req).toMatchObject({ kind: 'ask', reasoningEffort: 'medium' });
        expect(req.naturalLanguage).toBeUndefined();
        expect(req.runtimeTools).toBeUndefined();
        expect(req.prompt).toContain('SPL is Python-like, but is NOT Python');
        expect(req.prompt).toContain('"offset":1');
        expect(files()).toEqual([]);
    });

    it('retains generated functions across interactive session cells', async () => {
        const session = new ExecutionSession();
        expect(await session.run(parseMarkdown(document(instruction('Define answer() returning 42'))), {
            backend: scripted('def answer():\n    return 42'), logger, cwd,
        })).toMatchObject({ status: 'success' });
        expect(await session.run(parse('success answer()'), { backend: unused, logger, cwd }))
            .toMatchObject({ status: 'success', value: 42 });
    });

    it('never executes function bodies during generation', async () => {
        expect(await execute(document(instruction('Define write_later()')), scripted(`def write_later():
    write_file('must-not-exist.txt', 'not yet')
    return 42`))).toMatchObject({ status: 'success' });
        expect(fs.existsSync(path.join(cwd, 'must-not-exist.txt'))).toBe(false);
    });

    it('exposes generated functions to subsequent natural-language commands', async () => {
        let calls = 0;
        const backend: LlmBackend = {
            async call(req) {
                if (calls++ === 0) return { text: 'def answer():\n    return 42', effective: {} };
                expect(req.prompt).toContain('answer');
                const result = await req.invokeAction!({ name: 'call_function', arguments: { name: 'answer', args: [] } });
                await req.invokeAction!({ name: 'save_variable', arguments: { name: 'result', value: result } });
                return { text: 'Done', effective: {} };
            },
            async close() {},
        };
        expect(await execute(document(`${instruction('Define answer()')}\n\n> Call @answer and save to @result.\n\n${fence('success result')}`), backend))
            .toMatchObject({ status: 'success', value: 42 });
    });

    it('applies controls and model precedence without leaking guidance to later calls', async () => {
        const backend = scripted('def answer():\n    return 42', 'later');
        const source = document(`> @CTL(model='local', reasoning='high', enforce='Keep it short', restrict={fs: ['./workflows']})
> @CODEGEN 'Define answer()'

${fence("success ask 'Later'")}`);
        expect(await execute(source, backend, undefined, { model: 'override' })).toMatchObject({ status: 'success', value: 'later' });
        expect(backend.call.mock.calls[0][0]).toMatchObject({ model: 'override', reasoningEffort: 'high' });
        expect(backend.call.mock.calls[0][0].prompt).toContain('Keep it short');
        expect(backend.call.mock.calls[1][0].prompt).not.toContain('Keep it short');
        const local = scripted('def answer():\n    return 42', 'later');
        await execute(source, local);
        expect(local.call.mock.calls[0][0].model).toBe('local');
    });

    it.each([
        '',
        '```spl\ndef answer():\n    return 42\n```',
        'def answer(:',
        "write_file('should-not-exist', 'bad')",
        "import * as markdown from 'markdown'",
        "@(model='other')\ndef answer():\n    return 42",
        'let answer = 42',
    ])('rejects invalid or executable top-level output: %s', async response => {
        const backend = scripted(response);
        expect(await execute(document(instruction('Define answer()')), backend, 'invalid.jsonl'))
            .toMatchObject({ status: 'failure', failure: { status_code: 'invalid_format' } });
        expect(files()).toEqual([]);
        expect(fs.existsSync(path.join(cwd, 'should-not-exist'))).toBe(false);
    });

    it('type-checks generated function contracts before saving or registering', async () => {
        expect(await execute(document(instruction('Define answer() returning a string')), scripted("def answer() -> str:\n    return True"), 'invalid.jsonl'))
            .toMatchObject({ status: 'failure', failure: { status_code: 'type_error' } });
        expect(files()).toEqual([]);
    });

    it('pins generated functions for self-contained replay without sidecars', async () => {
        const source = document(`${instruction('Define answer()')}\n\n${fence('success answer()')}`);
        const pin = Pin.capture(source, { cwd, args: [] });
        const first = await execute(source, scripted('def answer():\n    return 42'), undefined, { pin });
        expect(await execute(pin.toMarkdown(source))).toEqual(first);
        expect(first).toMatchObject({ status: 'success', value: 42 });
        expect(files()).toEqual([]);
    });
});

describe('@CODEGEN trace caches', () => {
    it('tags generated and cached definitions for code display while suppressing trace replay logs', async () => {
        const events: LogEvent[] = [];
        const streams: ModelStreamEvent[] = [];
        const logger = new Logger('error', undefined, { eventSink: event => events.push(event), streamSink: event => streams.push(event) });
        const source = document(`${instruction('Define answer()')}\n\n${fence('success answer()')}`);
        const backend: LlmBackend = {
            async call(req) {
                req.onStream?.({ channel: 'response', messageId: 'code', mode: 'append', text: 'def answer(' });
                return { text: 'def answer():\n    return 42', effective: {} };
            },
            async close() {},
        };
        await execute(source, backend, 'first.jsonl', { logger });
        expect(streams.map(event => event.interaction.kind)).toEqual(['codegen', 'codegen']);
        const input = events.find(event => event.kind === 'model-input');
        expect(input?.segments[0]).toMatchObject({ type: 'preface', source: expect.stringContaining('Generate SPL functions') });
        expect(input?.segments.at(-1)).toMatchObject({ type: 'text', text: expect.stringContaining('Define answer()') });
        const output = events.find(event => event.kind === 'model-output');
        expect(output).toMatchObject({ interaction: { kind: 'codegen' }, segments: [{ type: 'code', language: 'spl', source: 'def answer():\n    return 42' }] });
        events.length = 0;
        streams.length = 0;
        await execute(source, unused, 'fresh.jsonl', { logger });
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ kind: 'model-output', interaction: { kind: 'codegen' }, segments: [{ type: 'code', language: 'spl' }] });
        expect(streams).toEqual([]);
        events.length = 0;
        await execute(source, unused, 'first.jsonl', { logger });
        expect(events).toEqual([]);
    });

    it('saves friendly SPL files with SHA-256 comments and reuses them with a fresh trace, without imports', async () => {
        const descriptions = ['Define double(value)', 'Define increment(value)'];
        const source = document(`${instruction(descriptions[0])}\n\nComment\n\n${instruction(descriptions[1])}\n\n${fence('success increment(double(20))')}`);
        const first = scripted('def double(value):\n    return value * 2', 'def increment(value):\n    return value + 1');
        expect(await execute(source, first, 'first.jsonl')).toMatchObject({ status: 'success', value: 41 });
        expect(files()).toEqual(['friendly-flow.double.spl', 'friendly-flow.increment.spl']);
        for (const [i, name] of ['double', 'increment'].entries()) {
            const text = fs.readFileSync(path.join(path.dirname(workflow), `friendly-flow.${name}.spl`), 'utf8');
            expect(text.split('\n')[0]).toBe(signature(descriptions[i]));
            expect(parse(text).body[0]).toMatchObject({ t: 'def', name });
        }
        expect(await execute(source, unused, 'fresh.jsonl')).toMatchObject({ status: 'success', value: 41 });
    });

    it('replays recorded definitions even after cache edits or removal, without recreating files', async () => {
        const source = document(`${instruction('Define answer()')}\n\n${fence('success answer()')}`);
        expect(await execute(source, scripted('def answer():\n    return 42'), 'first.jsonl'))
            .toMatchObject({ status: 'success', value: 42 });
        const file = path.join(path.dirname(workflow), files()[0]);
        const original = fs.readFileSync(file, 'utf8');
        fs.writeFileSync(file, original.replace('return 42', 'return 99'));
        expect(await execute(source, unused, 'first.jsonl')).toMatchObject({ status: 'success', value: 42 });
        expect(await execute(source, unused, 'fresh.jsonl')).toMatchObject({ status: 'success', value: 99 });
        fs.unlinkSync(file);
        expect(await execute(source, unused, 'first.jsonl')).toMatchObject({ status: 'success', value: 42 });
        expect(files()).toEqual([]);
    });

    it('resumes an unresolved generation intent by reusing the completed cache', async () => {
        const source = document(`${instruction('Define answer()')}\n\n${fence('success answer()')}`);
        const backend = scripted('def answer():\n    return 42');
        await execute(source, backend, 'interrupted.jsonl');
        const traceFile = path.join(cwd, 'interrupted.jsonl');
        const rows = fs.readFileSync(traceFile, 'utf8').trimEnd().split('\n');
        expect(JSON.parse(rows[1])).toMatchObject({ type: 'intent' });
        fs.writeFileSync(traceFile, rows.slice(0, 2).join('\n') + '\n');
        expect(await execute(source, unused, 'interrupted.jsonl')).toMatchObject({ status: 'success', value: 42 });
        expect(files()).toEqual(['friendly-flow.answer.spl']);
        expect(backend.call).toHaveBeenCalledOnce();
    });

    it.each(['relative', 'file URI'])('locates sibling caches for a %s embedding source', async sourceKind => {
        const source = document(`${instruction('Define answer()')}\n\n${fence('success answer()')}`);
        const options = { source: sourceKind === 'relative' ? path.relative(cwd, workflow) : pathToFileURL(workflow).href };
        expect(await execute(source, scripted('def answer():\n    return 42'), 'first.jsonl', options))
            .toMatchObject({ status: 'success', value: 42 });
        expect(files()).toEqual(['friendly-flow.answer.spl']);
        expect(await execute(source, unused, 'fresh.jsonl', options)).toMatchObject({ status: 'success', value: 42 });
    });

    it('does not read a cache when running without trace', async () => {
        const source = document(`${instruction('Define answer()')}\n\n${fence('success answer()')}`);
        await execute(source, scripted('def answer():\n    return 42'), 'first.jsonl');
        const cached = fs.readFileSync(path.join(path.dirname(workflow), files()[0]), 'utf8');
        const backend = scripted('def answer():\n    return 43');
        expect(await execute(source, backend)).toMatchObject({ status: 'success', value: 43 });
        expect(backend.call).toHaveBeenCalledOnce();
        expect(fs.readFileSync(path.join(path.dirname(workflow), files()[0]), 'utf8')).toBe(cached);
    });

    it('invalidates changed input without overwriting existing codegen files', async () => {
        const original = document(`${instruction('Define answer() returning 42')}\n\n${fence('success answer()')}`);
        const changed = original.replace('returning 42', 'returning 43');
        await execute(original, scripted('def answer():\n    return 42'), 'first.jsonl');
        const firstFile = path.join(path.dirname(workflow), files()[0]);
        const contents = fs.readFileSync(firstFile, 'utf8');
        expect(await execute(changed, scripted('def answer():\n    return 43'), 'changed.jsonl'))
            .toMatchObject({ status: 'success', value: 43 });
        expect(files()).toHaveLength(2);
        expect(fs.readFileSync(firstFile, 'utf8')).toBe(contents);
        expect(await execute(changed, unused, 'fresh.jsonl')).toMatchObject({ status: 'success', value: 43 });
    });

    it.each(['', signature('Different description') + '\n'])('does not trust a missing or mismatched signature: %s', async header => {
        const source = document(`${instruction('Define answer()')}\n\n${fence('success answer()')}`);
        fs.writeFileSync(path.join(path.dirname(workflow), 'friendly-flow.answer.spl'), header + 'def answer():\n    return 99\n');
        const backend = scripted('def answer():\n    return 42');
        expect(await execute(source, backend, 'fresh.jsonl')).toMatchObject({ status: 'success', value: 42 });
        expect(backend.call).toHaveBeenCalledOnce();
        expect(files()).toHaveLength(2);
    });

    it('fails explicitly for a matching but invalid cache instead of silently regenerating or executing it', async () => {
        fs.writeFileSync(path.join(path.dirname(workflow), 'friendly-flow.answer.spl'),
            `${signature('Define answer()')}\nwrite_file('should-not-exist', 'bad')\n`);
        const backend = scripted('def answer():\n    return 42');
        expect(await execute(document(instruction('Define answer()')), backend, 'invalid.jsonl'))
            .toMatchObject({ status: 'failure', failure: { status_code: 'invalid_format' } });
        expect(backend.call).not.toHaveBeenCalled();
        expect(fs.existsSync(path.join(cwd, 'should-not-exist'))).toBe(false);
    });

    it('records cache write failures so trace replay preserves the failure', async () => {
        const hash = createHash('sha256').update('Define answer()').digest('hex');
        fs.mkdirSync(path.join(path.dirname(workflow), 'friendly-flow.answer.spl'));
        fs.mkdirSync(path.join(path.dirname(workflow), `friendly-flow.answer.${hash}.spl`));
        const source = document(instruction('Define answer()'));
        const first = await execute(source, scripted('def answer():\n    return 42'), 'failed.jsonl');
        expect(first).toMatchObject({ status: 'failure', failure: { reason: expect.stringContaining('cannot save @CODEGEN cache') } });
        expect(await execute(source, unused, 'failed.jsonl')).toEqual(first);
    });
});
