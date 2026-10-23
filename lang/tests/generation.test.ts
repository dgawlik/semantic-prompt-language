import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run } from '../src/interpreter.js';
import { LlmError, type LlmBackend, type LlmRequest } from '../src/llm.js';
import { Logger } from '../src/logger.js';
import { parse } from '../src/parser.js';
import { RecordingBackend, ReplayBackend } from '../src/recording.js';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spl-generation-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function scripted(...responses: (string | Error)[]) {
    const calls: LlmRequest[] = [];
    const backend: LlmBackend = {
        async call(req) {
            calls.push(req);
            const response = responses.shift();
            if (response instanceof Error) throw response;
            if (response === undefined) throw new Error('unexpected extra generation');
            return { text: response, effective: { model: 'test' } };
        },
        async close() {},
    };
    return { backend, calls };
}

const exec = (source: string, backend: LlmBackend) => run(parse(source), { backend, cwd: dir, logger: new Logger('silent') });
const schema = `{'type': 'object', 'properties': {'total': {'type': 'number'}}, 'required': ['total'], 'additionalProperties': False}`;

describe('generation contracts', () => {
    it('executes the requested multiline rating syntax with bounded repair', async () => {
        const { backend, calls } = scripted('not an integer', '4');
        expect(await exec(`let score = ask(
    fmt = 'integer',
    repairs = 1
) 'Rate this issue'
success score`, backend)).toMatchObject({ status: 'success', value: 4 });
        expect(calls).toHaveLength(2);
        expect(calls[1].prompt).toContain('Previous response:\nnot an integer');
    });

    it.each(['ask', 'think', 'agent'])('executes multiline %s options once and preserves call metadata', async (command) => {
        const { backend, calls } = scripted('5');
        const result = await exec(`@(
    model = 'header',
)
let count = [0]
def option(value) { count[0] += 1; return value }
let score = ${command}(
    fmt = option('integer'),
    repairs = option(0),
    reasoning = 'high',
    model = 'per-call',
    show = True,
    schema = {'type': 'integer', 'minimum': 1, 'maximum': 5},
) 'Rate this issue'
success [score, count[0]]`, backend);
        expect(result).toMatchObject({ status: 'success', value: [5, 2] });
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({ kind: command, model: 'per-call', reasoningEffort: 'high', showReasoning: true });
    });

    it.each([true, false])('evaluates only the selected generation branch for %s', async (friday) => {
        const { backend, calls } = scripted(String(friday), 'selected answer');
        const result = await exec(`
let result = if ask(fmt='boolean') 'Today is friday? True/False' {
    ask 'Haiku on variance'
} else {
    ask 'Sentence on passing time'
}
success result
`, backend);
        expect(result).toMatchObject({ status: 'success', value: 'selected answer' });
        expect(calls).toHaveLength(2);
        expect(calls[1].prompt).toBe(friday ? 'Haiku on variance' : 'Sentence on passing time');
    });

    it('composes expression-valued schema, format, reasoning, model, and show modifiers', async () => {
        const { backend, calls } = scripted('{"total": 42}');
        const result = await exec(`
let Contract = ${schema}
let effort = 'high'
success ask(schema=Contract, reasoning=effort, model='test-model', show=True) 'Extract'
`, backend);
        expect(result).toMatchObject({ status: 'success', value: { total: 42 } });
        expect(calls[0]).toMatchObject({ kind: 'ask', reasoningEffort: 'high', model: 'test-model', showReasoning: true });
        expect(calls[0].prompt).toContain('"required":["total"]');
    });

    it('makes think generation-only shorthand supporting schemas', async () => {
        const { backend, calls } = scripted('{"total": 2}');
        expect(await exec(`success think(schema=${schema}) 'Extract'`, backend)).toMatchObject({ status: 'success', value: { total: 2 } });
        expect(calls[0]).toMatchObject({ kind: 'think', reasoningEffort: 'medium' });
    });

    it('gives the CLI/embedding model override precedence over per-call and header models', async () => {
        const { backend, calls } = scripted('answer');
        await run(parse(`@(model='header')\nsuccess ask(model='per-call') 'Hi'`), {
            backend, cwd: dir, logger: new Logger('silent'), model: 'override',
        });
        expect(calls[0].model).toBe('override');
    });

    it.each(['```json\n{"total":1}\n```', 'Here: {"total":1}', '{"total":1} trailing'])('rejects non-JSON wrappers: %s', async (response) => {
        const { backend } = scripted(response);
        expect(await exec(`success ask(fmt='json') 'Extract'`, backend)).toMatchObject({ status: 'failure', failure: { status_code: 'invalid_format' } });
    });

    it.each(['42', 'null', 'true', '"hello"', '[1,2]'])('supports JSON values: %s', async (response) => {
        const { backend } = scripted(response);
        expect(await exec(`success ask(fmt='json') 'Extract'`, backend)).toMatchObject({ status: 'success', value: JSON.parse(response) });
    });

    it.each([
        ['integer', '55', 55],
        ['integer', '-10', -10],
        ['integer', '1e2', 100],
        ['integer', '42.0', 42],
        ['float', '3.14', 3.14],
        ['float', '-1.2e-3', -0.0012],
        ['float', '42', 42],
        ['array', '[1, "two", {"three": true}, null]', [1, 'two', { three: true }, null]],
        ['array', '[]', []],
        ['object', '{"items": [1, 2], "ok": false}', { items: [1, 2], ok: false }],
        ['object', '{}', {}],
        ['boolean', 'true', true],
        ['boolean', 'false', false],
        ['text', 'Hello, world!', 'Hello, world!'],
        ['text', 'true', 'true'],
        ['text', '```json\n{}\n```', '```json\n{}\n```'],
    ])('returns typed %s output from %s for all generation commands', async (fmt, response, expected) => {
        for (const command of ['ask', 'think', 'agent']) {
            const { backend, calls } = scripted(` \n${response}\n `);
            expect(await exec(`let format = '${fmt}'\nsuccess ${command}(fmt=format) 'Generate'`, backend)).toMatchObject({
                status: 'success', value: expected,
            });
            expect(calls).toHaveLength(1);
            if (fmt !== 'text') {
                expect(calls[0].prompt).toContain('ONLY valid JSON');
                expect(calls[0].prompt).toContain(fmt === 'float' ? 'finite JSON number' : `JSON ${fmt}`);
            }
        }
    });

    it.each([
        ['integer', ['3.5', '"42"', 'true', 'null', '[]', '{}', '1e400']],
        ['float', ['"3.14"', 'false', 'null', '[]', '{}', '1e400', '-1e400', 'NaN', 'Infinity']],
        ['array', ['42', '3.5', 'true', 'null', '"[]"', '{}']],
        ['object', ['42', '3.5', 'false', 'null', '"{}"', '[]']],
        ['boolean', ['0', '1', '3.5', '"true"', 'null', '[]', '{}', 'True', 'False']],
    ])('rejects incorrect %s output without coercion', async (fmt, responses) => {
        for (const response of responses) {
            const { backend } = scripted(response);
            expect(await exec(`success ask(fmt='${fmt}') 'Generate'`, backend)).toMatchObject({
                status: 'failure', failure: { status_code: 'invalid_format' },
            });
        }
    });

    it.each(['integer', 'float', 'array', 'object', 'boolean'])('requires strict JSON for %s', async (fmt) => {
        for (const response of ['```json\n42\n```', 'Here: 42', '42 trailing', '']) {
            const { backend } = scripted(response);
            expect(await exec(`success ask(fmt='${fmt}') 'Generate'`, backend)).toMatchObject({
                status: 'failure', failure: { status_code: 'invalid_format' },
            });
        }
    });

    it.each([
        ['integer', '3.5', '55'],
        ['float', '"3.14"', '3.14'],
        ['array', '{}', '[1, 2]'],
        ['object', '[]', '{"ok": true}'],
        ['boolean', '"true"', 'true'],
    ])('repairs %s type mismatches and evaluates expressions once', async (fmt, invalid, valid) => {
        const { backend, calls } = scripted(invalid, valid);
        const result = await exec(`
let count = [0]
def format() { count[0] += 1; return '${fmt}' }
def prompt() { count[0] += 1; return 'Generate' }
let result = ask(fmt=format(), repairs=1) prompt()
success [result, count[0]]
`, backend);
        expect(result).toMatchObject({ status: 'success', value: [JSON.parse(valid), 2] });
        expect(calls).toHaveLength(2);
        expect(calls[1].prompt).toContain(`fmt='${fmt}'`);
        expect(calls[1].prompt).toContain('Previous response:');
    });

    it('validates schemas after checking the explicit format', async () => {
        const { backend, calls } = scripted('"55"', '55', '89');
        expect(await exec(`success ask(fmt='integer', schema={'type':'integer', 'minimum':80}, repairs=2) 'Fibonacci'`, backend)).toMatchObject({
            status: 'success', value: 89,
        });
        expect(calls[1].prompt).toContain(`fmt='integer'`);
        expect(calls[2].prompt).toContain('must be >= 80');
    });

    it('reports nested field paths and missing required fields', async () => {
        const { backend } = scripted('{"lines":[{"quantity":"many"}]}', '{}');
        const result = await exec(`success ask(schema={'type':'object','properties':{'lines':{'type':'array','items':{'type':'object','properties':{'quantity':{'type':'number'}},'required':['quantity']}}}}) 'Extract'`, backend);
        expect(result).toMatchObject({ status: 'failure', failure: { status_code: 'validation_failed', reason: expect.stringContaining('lines[0].quantity') } });
        expect(await exec(`success ask(schema=${schema}) 'Extract'`, backend)).toMatchObject({ status: 'failure', failure: { reason: expect.stringContaining('total:') } });
    });

    it('repairs invalid format and shape, evaluating the prompt once', async () => {
        const { backend, calls } = scripted('not JSON', '{"total":"bad"}', '{"total":42}');
        const result = await exec(`
let count = [0]
def prompt() { count[0] += 1; return 'Extract' }
let result = ask(schema=${schema}, repairs=2) prompt()
success [result, count[0]]
`, backend);
        expect(result).toMatchObject({ status: 'success', value: [{ total: 42 }, 1] });
        expect(calls).toHaveLength(3);
        expect(calls[1].prompt).toContain('Validation failed:');
        expect(calls[2].prompt).toContain('total:');
    });

    it('never retries transport errors or exceeds the repair limit', async () => {
        const transport = scripted(new LlmError('unavailable'), '{"total":42}');
        expect(await exec(`success ask(schema=${schema}, repairs=2) 'Extract'`, transport.backend)).toMatchObject({ status: 'failure', failure: { status_code: 'llm_error' } });
        expect(transport.calls).toHaveLength(1);
        const invalid = scripted('{}', '{}', '{"total":42}');
        expect(await exec(`success ask(schema=${schema}, repairs=1) 'Extract'`, invalid.backend)).toMatchObject({ status: 'failure', failure: { status_code: 'validation_failed' } });
        expect(invalid.calls).toHaveLength(2);
    });

    it.each([0, 1, 2, 5])('permits exactly the configured %i additional attempts', async (repairs) => {
        const { backend, calls } = scripted(...Array.from({ length: repairs }, () => '{}'), '{"total":42}');
        expect(await exec(`success ask(schema=${schema}, repairs=${repairs}) 'Extract'`, backend)).toMatchObject({ status: 'success', value: { total: 42 } });
        expect(calls).toHaveLength(1 + repairs);
    });

    it('does not coerce or remove invalid fields', async () => {
        const { backend } = scripted('{"total":"42","extra":1}');
        expect(await exec(`success ask(schema=${schema}) 'Extract'`, backend)).toMatchObject({
            status: 'failure', failure: { status_code: 'validation_failed', reason: expect.stringMatching(/extra:.*total:/) },
        });
    });

    it('does not retry agent actions when the final output is invalid', async () => {
        let calls = 0;
        const backend: LlmBackend = {
            async call(req) {
                calls++;
                await req.tools.invoke('write_file', { path: 'agent.txt', content: 'written' });
                return { text: 'not JSON', effective: {} };
            },
            async close() {},
        };
        expect(await exec(`agent(schema=${schema}) 'Write and report'`, backend)).toMatchObject({ status: 'failure', failure: { status_code: 'invalid_format' } });
        expect(calls).toBe(1);
        expect(fs.readFileSync(path.join(dir, 'agent.txt'), 'utf8')).toBe('written');
    });

    it.each([
        `ask(schema={'type':'imaginary'}) 'x'`, `ask(schema={'typo':True}) 'x'`,
        `ask(schema={'$async':True, 'type':'number'}) 'x'`,
        `ask(repairs=6, fmt='json') 'x'`, `ask(repairs=-1, fmt='json') 'x'`,
        `ask(show='yes') 'x'`, `ask(reasoning='extreme') 'x'`,
        `ask(fmt='unsupported') 'x'`, `ask(fmt=42) 'x'`, `ask(fmt=True) 'x'`,
        `ask(fmt='text', schema=${schema}) 'x'`, `agent(repairs=1, fmt='json') 'x'`,
        `ask(fmt='text', repairs=1) 'x'`,
    ])('validates configuration before calling a model: %s', async (expression) => {
        const { backend, calls } = scripted();
        expect(await exec(`success ${expression}`, backend)).toMatchObject({ status: 'failure', failure: { status_code: 'runtime_error' } });
        expect(calls).toHaveLength(0);
    });

    it('keeps guidance separate from validation and makes agent calls explicit', async () => {
        const { backend, calls } = scripted('contrary', 'done');
        expect(await exec(`enforce 'Be polite' { forbid 'jokes' { let x = ask 'Hi' } }\nsuccess agent 'Do the task'`, backend)).toMatchObject({ status: 'success', value: 'done' });
        expect(calls[0].prompt).toContain('Follow: Be polite');
        expect(calls[0].prompt).toContain('Avoid: jokes');
        expect(calls[1]).toMatchObject({ kind: 'agent' });
        expect(calls[1].prompt).not.toContain('jokes');
    });

    it.each(['ask', 'think', 'agent'])('applies enforce/forbid to %s calls through functions and unwinds afterward', async (command) => {
        const { backend, calls } = scripted('inside', 'outside');
        const result = await exec(`
def answer() { return ${command} 'inside' }
let inside = None
enforce 'Answer in English' {
    forbid 'jokes' { inside = answer() }
}
let outside = ${command} 'outside'
success [inside, outside]
`, backend);
        expect(result).toMatchObject({ status: 'success', value: ['inside', 'outside'] });
        expect(calls).toHaveLength(2);
        expect(calls[0].prompt).toContain('Follow: Answer in English');
        expect(calls[0].prompt).toContain('Avoid: jokes');
        expect(calls[1].prompt).not.toContain('Answer in English');
        expect(calls[1].prompt).not.toContain('jokes');
    });

    it('unwinds nested enforce/forbid guidance after a caught failure', async () => {
        const { backend, calls } = scripted('inside', 'after');
        const result = await exec(`
try {
    enforce 'Be polite' {
        forbid 'profanity' {
            let answer = ask 'inside'
            fail 'expected'
        }
    }
} except err {
    success ask 'after'
}
`, backend);
        expect(result).toMatchObject({ status: 'success', value: 'after' });
        expect(calls[0].prompt).toContain('Follow: Be polite');
        expect(calls[0].prompt).toContain('Avoid: profanity');
        expect(calls[1].prompt).not.toContain('Be polite');
        expect(calls[1].prompt).not.toContain('profanity');
    });
});

describe('raw tools and bindings', () => {
    it('performs raw I/O without model calls or file-content truncation', async () => {
        const { backend, calls } = scripted();
        const text = ' x\n'.repeat(80_000);
        fs.writeFileSync(path.join(dir, 'input.txt'), text);
        expect(await exec(`let text = read_file('input.txt')\nwrite_file('output.txt', text)\nsuccess text`, backend)).toMatchObject({ status: 'success', value: text });
        expect(fs.readFileSync(path.join(dir, 'output.txt'), 'utf8')).toBe(text);
        expect(calls).toHaveLength(0);
    });

    it('writes only once when a later generation requires repair', async () => {
        const { backend, calls } = scripted('{}', '{"total":2}');
        expect(await exec(`write_file('out.txt', 'once')\nsuccess ask(schema=${schema}, repairs=1) 'Extract'`, backend)).toMatchObject({ status: 'success' });
        expect(calls).toHaveLength(2);
        expect(fs.readFileSync(path.join(dir, 'out.txt'), 'utf8')).toBe('once');
    });

    it('returns complete shell output and decodes UTF-8 split across chunks', async () => {
        const { backend, calls } = scripted();
        expect(await exec(`success shell('node -e "process.stdout.write(String.fromCharCode(120).repeat(210000))"')`, backend)).toMatchObject({ status: 'success', value: 'x'.repeat(210_000) });
        expect(await exec(`success shell('node -e "process.stdout.write(Buffer.from([240,159]));setTimeout(()=>process.stdout.write(Buffer.from([152,128])),20)"')`, backend)).toMatchObject({ status: 'success', value: '\u{1f600}' });
        expect(calls).toHaveLength(0);
    });

    it('returns raw HTTP text and reports body-stream errors as tool failures', async () => {
        const { backend, calls } = scripted();
        const text = 'body\n'.repeat(50_000);
        const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(text));
        try {
            expect(await exec(`success web_fetch('https://example.com')`, backend)).toMatchObject({ status: 'success', value: text });
            fetch.mockResolvedValueOnce(new Response(new ReadableStream({ start(controller) { controller.error(new Error('body failed')); } })));
            expect(await exec(`web_fetch('https://example.com')`, backend)).toMatchObject({ status: 'failure', failure: { status_code: 'tool_error', reason: expect.stringContaining('body failed') } });
            expect(calls).toHaveLength(0);
        } finally {
            fetch.mockRestore();
        }
    });

    it('isolates child declarations and assigns to enclosing lexical bindings', async () => {
        const { backend } = scripted();
        expect(await exec(`let x = 1\n{ let x = 2; let hidden = 3 }\nsuccess x`, backend)).toMatchObject({ status: 'success', value: 1 });
        expect(await exec(`{ let hidden = 3 }\nsuccess hidden`, backend)).toMatchObject({ status: 'failure', failure: { reason: expect.stringContaining('not defined') } });
        expect(await exec(`let x = 1\ndef f() { x = 2 }\nf()\nsuccess x`, backend)).toMatchObject({ status: 'success', value: 2 });
        expect(await exec(`x = 1`, backend)).toMatchObject({ status: 'failure', failure: { status_code: 'runtime_error' } });
    });
});

describe('offline generation record/replay', () => {
    it('matches ordered requests and replays repairs without a live backend', async () => {
        const file = path.join(dir, 'run.jsonl');
        const source = `success ask(schema=${schema}, repairs=1) 'Extract'`;
        const { backend, calls } = scripted('{}', '{"total":42}');
        const recording = new RecordingBackend(backend, file);
        const expected = await exec(source, recording);
        await recording.close();
        expect(calls).toHaveLength(2);
        const replay = new ReplayBackend(file);
        expect(await exec(source, replay)).toEqual(expected);
        await replay.close();
        expect(() => new RecordingBackend(backend, file)).toThrow();
    });

    it('rejects mismatches, exhausted recordings, and unused entries', async () => {
        const file = path.join(dir, 'run.jsonl');
        const recording = new RecordingBackend(scripted('answer').backend, file);
        await exec(`success ask 'question'`, recording);
        await recording.close();
        const mismatch = new ReplayBackend(file);
        expect(await exec(`success ask 'different'`, mismatch)).toMatchObject({ status: 'failure', failure: { reason: expect.stringContaining('mismatch') } });
        await expect(mismatch.close()).rejects.toThrow(/unused/);
        const replay = new ReplayBackend(file);
        await exec(`success ask 'question'`, replay);
        expect(await exec(`success ask 'question'`, replay)).toMatchObject({ status: 'failure', failure: { reason: expect.stringContaining('exhausted') } });
        await replay.close();
    });

    it.each([`write_file('blocked.txt', 'x')`, `shell('echo x')`, `web_fetch('https://example.com')`, `web_search('query')`, `agent 'Do work'`])('blocks replay side effects: %s', async (expression) => {
        const file = path.join(dir, 'empty.jsonl');
        fs.writeFileSync(file, '{"format":"spl-generation","version":1}\n');
        const replay = new ReplayBackend(file);
        expect(await exec(expression, replay)).toMatchObject({ status: 'failure', failure: { status_code: 'restriction_violation' } });
        expect(fs.existsSync(path.join(dir, 'blocked.txt'))).toBe(false);
        await replay.close();
    });

    it('allows local reads but refuses agents during recording', async () => {
        const file = path.join(dir, 'run.jsonl');
        const recording = new RecordingBackend(scripted().backend, file);
        expect(await exec(`agent 'Do work'`, recording)).toMatchObject({ status: 'failure', failure: { status_code: 'restriction_violation' } });
        await recording.close();
        fs.writeFileSync(path.join(dir, 'input.txt'), 'local');
        const replay = new ReplayBackend(file);
        expect(await exec(`success read_file('input.txt')`, replay)).toMatchObject({ status: 'success', value: 'local' });
        await replay.close();
    });

    it('matches model, reasoning, display options, and call kind without advancing on mismatch', async () => {
        const file = path.join(dir, 'run.jsonl');
        const { backend, calls } = scripted('answer');
        const recording = new RecordingBackend(backend, file);
        await exec(`success ask 'question'`, recording);
        await recording.close();
        const replay = new ReplayBackend(file);
        const original = calls[0];
        for (const request of [
            { ...original, model: 'other-model' },
            { ...original, reasoningEffort: 'high' as const },
            { ...original, showReasoning: true },
            { ...original, kind: 'think' as const },
        ]) {
            await expect(replay.call(request)).rejects.toThrow(/mismatch at call 1/);
        }
        expect(await replay.call(original)).toMatchObject({ text: 'answer' });
        await replay.close();
    });

    it('rejects malformed or unsupported recordings explicitly', () => {
        const file = path.join(dir, 'bad.jsonl');
        fs.writeFileSync(file, '{"format":"spl-generation","version":2}\n');
        expect(() => new ReplayBackend(file)).toThrow(/format\/version/);
        fs.writeFileSync(file, '{"format":"spl-generation","version":1}\n{broken');
        expect(() => new ReplayBackend(file)).toThrow(/JSON at line 2/);
        fs.writeFileSync(file, '{"format":"spl-generation","version":1}\n{}\n');
        expect(() => new ReplayBackend(file)).toThrow(/entry at line 2/);
    });
});
