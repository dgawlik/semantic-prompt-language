import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Failure } from '../src/errors.js';
import { LlmError, type LlmResponse } from '../src/llm.js';
import { parse } from '../src/markdown.js';
import { run } from '../src/workflow.js';
import { backend, cleanTemp, exec, scripted, silent, tempDir } from './helpers.js';

afterEach(cleanTemp);

const kinds = ['ask', 'think', 'agent'] as const;
const schema = "{ type: 'object', properties: { total: { type: 'number' } }, required: ['total'], additionalProperties: false }";
const JSON_HINT = 'Respond with ONLY valid JSON. No prose, no markdown, no code fences.';
/** Answers every call with its own prompt, so results show what each call was asked. */
const echo = () => backend(request => ({ text: request.prompt, effective: {} }));
const failing = (error: Error) => (): string => { throw error; };

describe('generation options', () => {
    it.each(kinds)('passes multiline %s options through to a single model call', async kind => {
        const model = scripted('5');
        const result = await run(parse(`
const score = await ${kind}('Rate this issue', {
    fmt: 'integer',
    repairs: 0,
    reasoning: 'high',
    model: 'per-call',
    tokens: 2048,
    hide: true,
    schema: { type: 'integer', minimum: 1, maximum: 5 },
});
success(score);`, { model: 'header' }), { backend: model, logger: silent });
        expect(result).toMatchObject({ status: 'success', value: 5 });
        expect(model.calls).toHaveLength(1);
        expect(model.calls[0]).toMatchObject({ kind, model: 'per-call', tokens: 2048, reasoningEffort: 'high', showReasoning: false });
    });

    it('ignores options that are undefined', async () => {
        const model = scripted('answer');
        expect(await exec("success(await ask('Prompt', { fmt: undefined, schema: undefined, repairs: undefined, model: undefined, tokens: undefined, seed: undefined, len: undefined }));",
            { backend: model })).toMatchObject({ status: 'success', value: 'answer' });
        expect(model.calls[0]).toMatchObject({ prompt: 'Prompt', model: undefined, showReasoning: true });
        expect(model.calls[0]).not.toHaveProperty('tokens');
        expect(model.calls[0]).not.toHaveProperty('randomness');
    });

    it('composes a schema with reasoning, model and hide options', async () => {
        const model = scripted('{"total": 42}');
        const result = await exec(`
const Contract = ${schema};
const effort = 'high';
const hidden = false;
success(await ask('Extract', { schema: Contract, reasoning: effort, model: 'test-model', hide: hidden }));`, { backend: model });
        expect(result).toMatchObject({ status: 'success', value: { total: 42 } });
        expect(model.calls[0]).toMatchObject({ kind: 'ask', reasoningEffort: 'high', model: 'test-model', showReasoning: true });
        expect(model.calls[0].prompt).toContain('"required":["total"]');
    });

    it('lets think validate schemas with its default reasoning', async () => {
        const model = scripted('{"total": 2}');
        expect(await exec(`success(await think('Extract', { schema: ${schema} }));`, { backend: model })).toMatchObject({ status: 'success', value: { total: 2 } });
        expect(model.calls[0]).toMatchObject({ kind: 'think', reasoningEffort: 'medium' });
    });

    it('prefers the runtime override, then the per-call model, then the document model', async () => {
        const model = scripted('a', 'b', 'c', 'd', 'e');
        const code = "await ask('Hi', { model: 'per-call' });\nawait think('Hi');";
        await run(parse(code, { model: 'header' }), { backend: model, logger: silent, model: 'override' });
        await run(parse(code, { model: 'header' }), { backend: model, logger: silent });
        await run(parse("await agent('Hi');"), { backend: model, logger: silent });
        expect(model.calls.map(call => call.model)).toEqual(['override', 'override', 'per-call', 'header', undefined]);
    });

    it('uses a boolean answer to select the branch that generates next', async () => {
        for (const friday of [true, false]) {
            const model = scripted(String(friday), 'selected answer');
            const result = await exec(`
const result = await ask('Today is friday? true/false', { fmt: 'boolean' })
    ? await ask('Haiku on variance')
    : await ask('Sentence on passing time');
success(result);`, { backend: model });
            expect(result).toMatchObject({ status: 'success', value: 'selected answer' });
            expect(model.calls).toHaveLength(2);
            expect(model.calls[1].prompt).toBe(friday ? 'Haiku on variance' : 'Sentence on passing time');
        }
    });

    it.each([
        "schema: { type: 'imaginary' }", 'schema: { typo: true }', "schema: { $async: true, type: 'number' }", "schema: 'Invoice'", 'schema: null',
        "repairs: -1, fmt: 'json'", "repairs: 1.5, fmt: 'json'", "repairs: '1', fmt: 'json'",
        'hide: null', 'hide: 1', 'fmt: 42', 'fmt: true', 'len: 5', 'model: 42', 'reasoning: true',
        `fmt: 'text', schema: ${schema}`, "fmt: 'text', repairs: 1",
    ])('rejects { %s } before calling a model', async options => {
        const model = scripted();
        expect(await exec(`success(await ask('x', { ${options} }));`, { backend: model })).toMatchObject({ status: 'failure', failure: { status_code: 'runtime_error', line: 1 } });
        expect(model.calls).toHaveLength(0);
    });

    it.each([
        ["ask('x', null)", /ask\(\) options must be an object/],
        ["think('x', ['json'])", /think\(\) options must be an object/],
        ["agent('x', struct('Invoice', { total: float }))", /agent\(\) options must be an object such as \{ schema: Invoice, repairs: 1 \}/],
        ["agent('x', { topP: 1 })", /exclusive to ask\(\); agent\(\) does not accept them/],
        ["think('x', { randomness: { seed: 1 } })", /unknown think\(\) option 'randomness'/],
    ])('rejects %s before calling a model', async (call, reason) => {
        const model = scripted();
        expect(await exec(`await ${call};`, { backend: model })).toMatchObject({
            status: 'failure', failure: { status_code: 'runtime_error', reason: expect.stringMatching(reason) },
        });
        expect(model.calls).toHaveLength(0);
    });
});

describe('token budgets', () => {
    it.each(kinds)('validates %s token budgets before contacting a model', async kind => {
        for (const invalid of ['0', '-1', '1.5', 'true', "'2048'", 'null', '9007199254740992', '1e400', 'NaN']) {
            const model = scripted();
            expect(await exec(`success(await ${kind}('Prompt', { tokens: ${invalid} }));`, { backend: model })).toMatchObject({
                status: 'failure', failure: { status_code: 'runtime_error', reason: 'tokens must be a positive safe integer' },
            });
            expect(model.calls).toHaveLength(0);
        }
    });

    it('reuses the token budget for every repair without changing the prompt', async () => {
        const model = scripted('not JSON', '42');
        expect(await exec("success(await ask('Prompt', { seed: 0, tokens: 2048, fmt: 'integer', repairs: 1 }));", { backend: model }))
            .toMatchObject({ status: 'success', value: 42 });
        expect(model.calls).toHaveLength(2);
        for (const call of model.calls) expect(call).toMatchObject({ tokens: 2048, randomness: { seed: 0 } });
        expect(model.calls[0].prompt).not.toContain('2048');
    });

    it.each([1, Number.MAX_SAFE_INTEGER])('accepts the token-budget boundary %s', async tokens => {
        const model = scripted('answer');
        expect(await exec(`success(await ask('Prompt', { tokens: ${tokens} }));`, { backend: model })).toMatchObject({ status: 'success', value: 'answer' });
        expect(model.calls[0].tokens).toBe(tokens);
    });
});

describe('prompts', () => {
    it('orders guidance, restrictions, hints, the prompt and the JSON contract', async () => {
        const model = scripted('true', '2.5', 'null');
        const result = await exec(`
success([
    await enforce('Be exact', () => restrict({ exec: 'git' }, () => think('Is it?', { len: 'word', fmt: 'boolean' }))),
    await ask('Extract', { schema: { type: 'number' } }),
    await ask('Any', { fmt: 'json', len: 'long' }),
]);`, { backend: model });
        expect(result).toMatchObject({ status: 'success', value: [true, 2.5, null] });
        expect(model.calls.map(call => call.prompt)).toEqual([
            'Response guidance (not runtime validation):\n- Follow: Be exact\n\n'
                + 'Active restrictions (enforced by the runtime):\n- Shell: you may only run these executables: git. Anything else will be blocked.\n\n'
                + 'Think carefully about the problem before giving the final answer.\n\nAnswer with a single word.\n\n'
                + `${JSON_HINT} Return a JSON boolean (true or false).\n\nIs it?`,
            'Extract\n\nReturn ONLY valid JSON, without prose or code fences.\n\nThe result must satisfy this JSON Schema:\n{"type":"number"}',
            'Give a long, detailed answer.\n\nAny\n\nReturn ONLY valid JSON, without prose or code fences.',
        ]);
    });

    it.each([
        ['word', 'Answer with a single word.'],
        ['sentence', 'Answer in a single sentence.'],
        ['paragraph', 'Answer in a single paragraph.'],
        ['long', 'Give a long, detailed answer.'],
    ])('adds the %s length hint', async (len, hint) => {
        expect(await exec(`success(await ask('Explain', { len: '${len}' }));`, { backend: echo() })).toMatchObject({ value: `${hint}\n\nExplain` });
    });

    it('renders interpolated and non-string prompts as text', async () => {
        const result = await exec(`
const Card = struct('Card', { term: str });
const card = { term: 'closures', tags: ['js'] };
function shout() {}
success([
    await ask\`Rate \${card} as \${Card} with \${shout}, \${null}, \${3.5} and \${[1, 'two']}\`,
    await ask(42),
    await ask(card),
    await ask\`\`,
]);`, { backend: echo() });
        expect(result).toMatchObject({ status: 'success', value: [
            'Rate {"term":"closures","tags":["js"]} as Card with [function shout], null, 3.5 and [1,"two"]', '42', '{"term":"closures","tags":["js"]}', '',
        ] });
    });
});

describe('output formats', () => {
    it.each(['```json\n{"total":1}\n```', 'Here: {"total":1}', '{"total":1} trailing'])('rejects non-JSON wrappers: %s', async response => {
        expect(await exec("success(await ask('Extract', { fmt: 'json' }));", { backend: scripted(response) }))
            .toMatchObject({ status: 'failure', failure: { status_code: 'invalid_format' } });
    });

    it.each(['42', 'null', 'true', '"hello"', '[1,2]'])('supports the JSON value %s', async response => {
        expect(await exec("success(await ask('Extract', { fmt: 'json' }));", { backend: scripted(response) }))
            .toEqual({ status: 'success', value: JSON.parse(response), hasValue: true });
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
    ])('returns typed %s output from %s for all generation calls', async (fmt, response, expected) => {
        for (const kind of kinds) {
            const model = scripted(` \n${response}\n `);
            expect(await exec(`const format = '${fmt}';\nsuccess(await ${kind}('Generate', { fmt: format }));`, { backend: model })).toMatchObject({
                status: 'success', value: expected,
            });
            expect(model.calls).toHaveLength(1);
            if (fmt === 'text') {
                expect(model.calls[0].prompt).not.toContain('JSON');
            } else {
                expect(model.calls[0].prompt).toContain('ONLY valid JSON');
                expect(model.calls[0].prompt).toContain(fmt === 'float' ? 'finite JSON number' : `JSON ${fmt}`);
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
            expect(await exec(`success(await ask('Generate', { fmt: '${fmt}' }));`, { backend: scripted(response) })).toMatchObject({
                status: 'failure', failure: { status_code: 'invalid_format' },
            });
        }
    });

    it.each(['integer', 'float', 'array', 'object', 'boolean'])('requires strict JSON for %s', async fmt => {
        for (const response of ['```json\n42\n```', 'Here: 42', '42 trailing', '']) {
            expect(await exec(`success(await ask('Generate', { fmt: '${fmt}' }));`, { backend: scripted(response) })).toMatchObject({
                status: 'failure', failure: { status_code: 'invalid_format' },
            });
        }
    });
});

describe('schemas and repairs', () => {
    it('repairs with the base prompt, the previous response and the reason', async () => {
        const model = scripted('not an integer', '4');
        expect(await exec(`
const score = await ask('Rate this issue', {
    fmt: 'integer',
    repairs: 1,
    hide: true,
});
success(score);`, { backend: model })).toMatchObject({ status: 'success', value: 4 });
        const base = `${JSON_HINT} Return a JSON integer.\n\nRate this issue`;
        expect(model.calls.map(call => call.showReasoning)).toEqual([false, false]);
        expect(model.calls[0].prompt).toBe(base);
        expect(model.calls[1].prompt).toMatch(/\n\nPrevious response:\nnot an integer\n\nValidation failed: LLM response is not valid JSON: [^\n]+\nReturn a corrected JSON value\.$/);
        expect(model.calls[1].prompt.startsWith(`${base}\n\nPrevious response:`)).toBe(true);
    });

    it.each([
        ['integer', '3.5', '55'],
        ['float', '"3.14"', '3.14'],
        ['array', '{}', '[1, 2]'],
        ['object', '[]', '{"ok": true}'],
        ['boolean', '"true"', 'true'],
    ])('repairs %s type mismatches', async (fmt, invalid, valid) => {
        const model = scripted(invalid, valid);
        expect(await exec(`success(await ask('Generate', { fmt: '${fmt}', repairs: 1 }));`, { backend: model }))
            .toMatchObject({ status: 'success', value: JSON.parse(valid) });
        expect(model.calls).toHaveLength(2);
        expect(model.calls[1].prompt).toContain(`Previous response:\n${invalid}\n\nValidation failed: LLM response must be`);
        expect(model.calls[1].prompt).toContain(`(fmt='${fmt}')\nReturn a corrected JSON value.`);
    });

    it('validates schemas after checking the explicit format', async () => {
        const model = scripted('"55"', '55', '89');
        expect(await exec("success(await ask('Fibonacci', { fmt: 'integer', schema: { type: 'integer', minimum: 80 }, repairs: 2 }));", { backend: model }))
            .toMatchObject({ status: 'success', value: 89 });
        expect(model.calls[1].prompt).toContain("fmt='integer'");
        expect(model.calls[2].prompt).toContain('Validation failed: $: must be >= 80');
        expect(model.calls[2].prompt).not.toContain('"55"');
    });

    it('reports nested field paths and missing required fields', async () => {
        const model = scripted('{"lines":[{"quantity":"many"}]}', '{}');
        expect(await exec(`success(await ask('Extract', { schema: {
    type: 'object',
    properties: { lines: { type: 'array', items: { type: 'object', properties: { quantity: { type: 'number' } }, required: ['quantity'] } } },
} }));`, { backend: model })).toMatchObject({
            status: 'failure', failure: { status_code: 'validation_failed', reason: 'lines[0].quantity: must be number' },
        });
        expect(await exec(`success(await ask('Extract', { schema: ${schema} }));`, { backend: model })).toMatchObject({
            status: 'failure', failure: { status_code: 'validation_failed', reason: "total: must have required property 'total'" },
        });
    });

    it('repairs invalid format and shape from the same base prompt', async () => {
        const model = scripted('not JSON', '{"total":"bad"}', '{"total":42}');
        expect(await exec(`success(await ask('Extract', { schema: ${schema}, repairs: 2 }));`, { backend: model }))
            .toMatchObject({ status: 'success', value: { total: 42 } });
        expect(model.calls).toHaveLength(3);
        expect(model.calls[1].prompt).toContain('Previous response:\nnot JSON\n\nValidation failed: LLM response is not valid JSON');
        expect(model.calls[2].prompt).toContain('Previous response:\n{"total":"bad"}\n\nValidation failed: total: must be number\nReturn a corrected JSON value.');
        expect(model.calls[2].prompt).not.toContain('not JSON');
        for (const call of model.calls) expect(call.prompt.startsWith(model.calls[0].prompt)).toBe(true);
    });

    it('never retries transport errors or exceeds the repair limit', async () => {
        const transport = scripted(failing(new LlmError('unavailable')), '{"total":42}');
        expect(await exec(`success(await ask('Extract', { schema: ${schema}, repairs: 2 }));`, { backend: transport })).toMatchObject({
            status: 'failure', failure: { status_code: 'llm_error', reason: 'unavailable', line: 1 },
        });
        expect(transport.calls).toHaveLength(1);
        const invalid = scripted('{}', '{}', '{"total":42}');
        expect(await exec(`success(await ask('Extract', { schema: ${schema}, repairs: 1 }));`, { backend: invalid }))
            .toMatchObject({ status: 'failure', failure: { status_code: 'validation_failed' } });
        expect(invalid.calls).toHaveLength(2);
    });

    it('reports backend problems as llm_error and keeps failures raised by a backend', async () => {
        expect(await exec("await ask('x');", { backend: scripted(failing(new TypeError('socket closed'))) }))
            .toMatchObject({ failure: { status_code: 'llm_error', reason: 'socket closed' } });
        expect(await exec("await ask('x');", { backend: scripted(failing(new Failure('restriction_violation', 'blocked by policy'))) }))
            .toMatchObject({ failure: { status_code: 'restriction_violation', reason: 'blocked by policy' } });
        expect(await exec("await ask('x');", { backend: backend(() => ({ text: 42 }) as unknown as LlmResponse) }))
            .toMatchObject({ failure: { status_code: 'llm_error', reason: expect.stringContaining('invalid response') } });
        expect(await exec(`
let caught;
try { await ask('x'); } catch (error) { caught = [error instanceof Failure, error.statusCode, error.reason]; }
success(caught);`, { backend: scripted(failing(new LlmError('rate limited'))) })).toMatchObject({ value: [true, 'llm_error', 'rate limited'] });
    });

    it.each([0, 1, 2, 5])('permits exactly the configured %i additional attempts', async repairs => {
        const model = scripted(...Array.from({ length: repairs }, () => '{}'), '{"total":42}');
        expect(await exec(`success(await ask('Extract', { schema: ${schema}, repairs: ${repairs} }));`, { backend: model }))
            .toMatchObject({ status: 'success', value: { total: 42 } });
        expect(model.calls).toHaveLength(1 + repairs);
    });

    it('does not coerce or remove invalid fields', async () => {
        expect(await exec(`success(await ask('Extract', { schema: ${schema} }));`, { backend: scripted('{"total":"42","extra":1}') })).toMatchObject({
            status: 'failure', failure: { status_code: 'validation_failed', reason: expect.stringMatching(/extra:.*total:/) },
        });
        expect(await exec("success(await ask('Extract', { schema: struct('Total', { total: float }) }));", { backend: scripted('{"total":"42"}') })).toMatchObject({
            status: 'failure', failure: { status_code: 'validation_failed', reason: '$.total: expected float, got "42"' },
        });
    });

    it('does not retry agent actions when the final output is invalid', async () => {
        const cwd = tempDir();
        let calls = 0;
        const model = backend(async request => {
            calls++;
            await request.tools.invoke('write_file', { path: 'agent.txt', content: 'written' });
            return { text: 'not JSON', effective: {} };
        });
        expect(await exec(`await agent('Write and report', { schema: ${schema} });`, { backend: model, cwd }))
            .toMatchObject({ status: 'failure', failure: { status_code: 'invalid_format' } });
        expect(calls).toBe(1);
        expect(fs.readFileSync(path.join(cwd, 'agent.txt'), 'utf8')).toBe('written');
    });
});

describe('guidance', () => {
    it('keeps guidance separate from validation and scoped to its callback', async () => {
        const model = scripted('contrary', 'done');
        expect(await exec(`
const x = await enforce('Be polite', () => forbid('jokes', () => ask('Hi')));
assert(x === 'contrary');
success(await agent('Do the task'));`, { backend: model })).toMatchObject({ status: 'success', value: 'done' });
        expect(model.calls[0].prompt).toBe('Response guidance (not runtime validation):\n- Follow: Be polite\n- Avoid: jokes\n\nHi');
        expect(model.calls[1]).toMatchObject({ kind: 'agent' });
        expect(model.calls[1].prompt).not.toContain('jokes');
    });

    it.each(kinds)('applies enforce/forbid to %s calls through functions and unwinds afterward', async kind => {
        const model = scripted('inside', 'outside');
        const result = await exec(`
function answer() {
    return ${kind}('inside');
}
let inside = null;
await enforce('Answer in English', () => forbid('jokes', async () => {
    inside = await answer();
}));
const outside = await ${kind}('outside');
success([inside, outside]);`, { backend: model });
        expect(result).toMatchObject({ status: 'success', value: ['inside', 'outside'] });
        expect(model.calls).toHaveLength(2);
        expect(model.calls[0].prompt).toContain('Follow: Answer in English');
        expect(model.calls[0].prompt).toContain('Avoid: jokes');
        expect(model.calls[1].prompt).not.toContain('Answer in English');
        expect(model.calls[1].prompt).not.toContain('jokes');
    });

    it('unwinds nested guidance after a caught failure', async () => {
        const model = scripted('inside', 'after');
        const result = await exec(`
try {
    await enforce('Be polite', () => forbid('profanity', async () => {
        const answer = await ask('inside');
        fail('expected');
    }));
} catch (error) {
    success(await ask('after'));
}`, { backend: model });
        expect(result).toMatchObject({ status: 'success', value: 'after' });
        expect(model.calls[0].prompt).toContain('Follow: Be polite');
        expect(model.calls[0].prompt).toContain('Avoid: profanity');
        expect(model.calls[1].prompt).not.toContain('Be polite');
        expect(model.calls[1].prompt).not.toContain('profanity');
    });

    it('keeps guidance apart between concurrent calls and carries it across awaits', async () => {
        const result = await exec(`
const later = async text => {
    await new Promise(resolve => setTimeout(resolve, 5));
    return ask(text);
};
success(await Promise.all([
    enforce(['Be formal', 'Be brief'], () => later('first')),
    forbid('slang', async () => { await null; return enforce('Use lists', () => later('second')); }),
    later('third'),
]));`, { backend: echo() });
        expect(result).toMatchObject({ status: 'success', value: [
            'Response guidance (not runtime validation):\n- Follow: Be formal\n- Follow: Be brief\n\nfirst',
            'Response guidance (not runtime validation):\n- Avoid: slang\n- Follow: Use lists\n\nsecond',
            'third',
        ] });
    });

    it('returns the value of the callback, synchronously when it is synchronous', async () => {
        expect(await exec("success([enforce('x', () => 1), forbid(['y'], () => enforce('z', () => 'two')), await restrict('.', () => 3)]);"))
            .toMatchObject({ status: 'success', value: [1, 'two', 3] });
    });
});

describe('exact tools', () => {
    it('performs raw file I/O without model calls or content truncation', async () => {
        const cwd = tempDir();
        const model = scripted();
        const text = ' x\n'.repeat(80_000);
        fs.writeFileSync(path.join(cwd, 'input.txt'), text);
        expect(await exec("const text = await readFile('input.txt');\nawait writeFile('nested/output.txt', text);\nsuccess(text);", { backend: model, cwd }))
            .toMatchObject({ status: 'success', value: text });
        expect(fs.readFileSync(path.join(cwd, 'nested', 'output.txt'), 'utf8')).toBe(text);
        expect(model.calls).toHaveLength(0);
    });

    it('writes only once when a later generation requires repair', async () => {
        const cwd = tempDir();
        const model = scripted('{}', '{"total":2}');
        const result = await exec(`
let writes = 0;
const report = await writeFile('out.txt', 'once' + ++writes);
success([report, await ask('Extract', { schema: ${schema}, repairs: 1 }), writes]);`, { backend: model, cwd });
        expect(result).toMatchObject({ status: 'success', value: [`Wrote 5 bytes to ${path.join(cwd, 'out.txt')}`, { total: 2 }, 1] });
        expect(model.calls).toHaveLength(2);
        expect(fs.readFileSync(path.join(cwd, 'out.txt'), 'utf8')).toBe('once1');
    });

    it('returns complete shell output and decodes UTF-8 split across chunks', async () => {
        const cwd = tempDir();
        expect(await exec(`success(await shell('node -e "process.stdout.write(String.fromCharCode(120).repeat(210000))"'));`, { cwd }))
            .toMatchObject({ status: 'success', value: 'x'.repeat(210_000) });
        expect(await exec(`success(await shell('node -e "process.stdout.write(Buffer.from([240,159]));setTimeout(()=>process.stdout.write(Buffer.from([152,128])),20)"'));`, { cwd }))
            .toMatchObject({ status: 'success', value: '\u{1f600}' });
        expect(await exec(`await shell('node -e "process.stderr.write(String.fromCharCode(98,97,100));process.exit(3)"');`, { cwd }))
            .toMatchObject({ status: 'failure', failure: { status_code: 'tool_error', reason: 'shell: exit code 3\nbad', line: 1 } });
    });

    it('returns raw HTTP text and reports body-stream errors as tool failures', async () => {
        const text = 'body\n'.repeat(50_000);
        const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(text));
        try {
            expect(await exec("success(await webFetch('https://example.com'));")).toMatchObject({ status: 'success', value: text });
            fetch.mockResolvedValueOnce(new Response(new ReadableStream({ start(controller) { controller.error(new Error('body failed')); } })));
            expect(await exec("await webFetch('https://example.com');")).toMatchObject({
                status: 'failure', failure: { status_code: 'tool_error', reason: expect.stringContaining('body failed') },
            });
            expect(await exec("await restrict({ net: 'example.org' }, () => webFetch('https://example.com'));")).toMatchObject({
                status: 'failure', failure: { status_code: 'restriction_violation', reason: expect.stringContaining("network access to 'example.com' blocked") },
            });
            expect(fetch).toHaveBeenCalledTimes(2);
        } finally {
            fetch.mockRestore();
        }
    });

    it.each([
        ["writeFile('a.txt')", /write_file\(\): content must be a string/],
        ["writeFile('a.txt', 42)", /write_file\(\): content must be a string/],
        ['shell(["node"])', /shell\(\): command must be a string/],
        ['webFetch(new URL("https://example.com"))', /web_fetch\(\): url must be a string/],
        ['webSearch(null)', /web_search\(\): query must be a string/],
    ])('rejects %s before running the tool', async (call, reason) => {
        expect(await exec(`await ${call};`, { cwd: tempDir() })).toMatchObject({
            status: 'failure', failure: { status_code: 'runtime_error', reason: expect.stringMatching(reason) },
        });
    });
});
