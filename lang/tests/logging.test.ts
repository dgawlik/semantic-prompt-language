import { stripVTControlCharacters } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { run } from '../src/interpreter.js';
import { LlmError, type LlmBackend, type LlmRequest } from '../src/llm.js';
import { Logger } from '../src/logger.js';
import { parse } from '../src/parser.js';
import { NoLlm } from './helpers.js';

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
});

const tagged = (tag: string, text: string) => text.split('\n').map((line, i) => `[${tag}] ${i ? '  ' : ''}${line}`).join('\n');

describe.each(['error', 'info', 'debug', 'silent'] as const)('script log levels at %s', (level) => {
    it('filters modifier logs and keeps ordinary log at info', async () => {
        const lines: string[] = [];
        const result = await run(parse(`
let chosen = 'debug'
let n = 0
def next():
    n += 1
    return n
log('plain', next())
log(level=error)('problem', next())
log(level='info')('details', next())
let logged = log(level=chosen)('trace', next())
success [n, logged]
`), { backend: new NoLlm(), logger: new Logger(level, (line) => lines.push(line)) });
        expect(result).toMatchObject({ status: 'success', value: [4, null] });
        const messages = lines.filter((line) => /^\[(error|info|debug)\] log:/.test(line));
        expect(messages).toEqual(level === 'silent' ? [] : [
            ...(level === 'error' ? [] : ['[info] log: plain 1']),
            '[error] log: problem 2',
            ...(level === 'error' ? [] : ['[info] log: details 3']),
            ...(level === 'debug' ? ['[debug] log: trace 4'] : []),
        ]);
    });
});

it.each(["'trace'", '1', 'None', 'True'])('rejects invalid log level %s before evaluating arguments', async (level) => {
    const result = await run(parse(`log(level=${level})(missing)`), {
        backend: new NoLlm(), logger: new Logger('silent'),
    });
    expect(result).toMatchObject({
        status: 'failure', failure: { status_code: 'runtime_error', reason: "log level must be 'error', 'info' or 'debug'" },
    });
});

describe.each(['error', 'info', 'debug', 'silent'] as const)('LLM logging at %s', (level) => {
    it.each([
        ['ask', `ask 'Ask prompt'`],
        ['think', `think 'Think prompt'`],
        ['agent', `agent 'Agent prompt'`],
    ])('logs the full %s request and raw response unless silent', async (kind, expression) => {
        const lines: string[] = [];
        const requests: LlmRequest[] = [];
        const text = '  First line\nSecond line\n  ';
        const backend: LlmBackend = {
            async call(req) {
                requests.push(req);
                return { text, effective: { model: 'test-model' } };
            },
            async close() {},
        };
        const result = await run(parse(`enforce 'Be precise':
    success ${expression}`), {
            backend, logger: new Logger(level, (line) => lines.push(line)), cwd: process.cwd(),
        });

        expect(result).toMatchObject({ status: 'success', value: text.trim() });
        expect(requests).toHaveLength(1);
        expect(requests[0].prompt).toContain('Follow: Be precise');
        if (level === 'silent') {
            expect(lines).toEqual([]);
        } else {
            expect(lines).toContain(tagged('llm', `llm request (${kind}):\n${requests[0].prompt}`));
            expect(lines.at(-1)).toBe(tagged('llm', `llm response:\n${text}`));
            expect(lines.some((line) => line.startsWith('[info] llm '))).toBe(level !== 'error');
        }
    });

    it('logs failed requests and errors without inventing a response', async () => {
        const lines: string[] = [];
        const backend: LlmBackend = {
            async call() { throw new LlmError('backend unavailable'); },
            async close() {},
        };
        const result = await run(parse(`success ask 'Failing prompt'`), {
            backend, logger: new Logger(level, (line) => lines.push(line)), cwd: process.cwd(),
        });

        expect(result).toMatchObject({ status: 'failure', failure: { status_code: 'llm_error' } });
        if (level === 'silent') {
            expect(lines).toEqual([]);
        } else {
            expect(lines).toContain('[llm] llm request (ask):\n[llm]   Failing prompt');
            expect(lines.at(-1)).toContain('[error] llm_error: backend unavailable');
            expect(lines.some((line) => line.startsWith('[llm] llm response:'))).toBe(false);
        }
    });

    it('traces only executed deterministic statements, including loop iterations', async () => {
        const lines: string[] = [];
        const result = await run(parse(`let n = 0
for i in [1, 2]:
    n += i
if False:
    fail 'unreachable'
success n`), {
            backend: { async call() { throw new Error('unexpected LLM call'); }, async close() {} },
            logger: new Logger(level, (line) => lines.push(line)), cwd: process.cwd(),
        });
        expect(result).toMatchObject({ status: 'success', value: 3 });
        expect(lines).toEqual(level === 'silent' ? [] : [
            '[deterministic] line 1 (let): let n = 0',
            '[deterministic] line 2 (for): for i in [1, 2]:',
            '[deterministic] line 3 (assign): n += i',
            '[deterministic] line 3 (assign): n += i',
            '[deterministic] line 4 (if): if False:',
            '[deterministic] line 6 (success): success n',
        ]);
    });
});

it('preserves ordinary severity filtering', () => {
    const lines: string[] = [];
    const logger = new Logger('error', (line) => lines.push(line));
    logger.info('hidden info');
    logger.warn('hidden warning');
    logger.debug('hidden debug');
    logger.error('visible error');
    logger.llm('visible transcript');
    expect(lines).toEqual(['[error] visible error', '[llm] visible transcript']);
});

describe('console formatting', () => {
    it('prefixes every line consistently across all log categories', () => {
        const lines: string[] = [];
        const logger = new Logger('debug', line => lines.push(line));
        for (const tag of ['error', 'warn', 'info', 'debug', 'llm', 'deterministic'] as const) {
            logger[tag]('First\r\nSecond\rThird');
        }
        expect(lines).toEqual(['error', 'warn', 'info', 'debug', 'llm', 'deterministic']
            .map(tag => `[${tag}] First\n[${tag}]   Second\n[${tag}]   Third`));
    });

    it('pretty-prints structured JSON and serialized JSON without changing their values', () => {
        const lines: string[] = [];
        const logger = new Logger('info', line => lines.push(line));
        const value = { findings: [{ severity: 'high', title: 'Quotes " and slashes \\ and {}[]' }], count: 1, ok: true, extra: null, empty: [] };
        logger.info('review:', value);
        logger.llm('llm response:', JSON.stringify(value));
        expect(lines).toEqual([
            tagged('info', `review:\n${JSON.stringify(value, null, 2)}`),
            tagged('llm', `llm response:\n${JSON.stringify(value, null, 2)}`),
        ]);
    });

    it('preserves original JSON number lexemes and duplicate keys', () => {
        const lines: string[] = [];
        new Logger('info', line => lines.push(line)).info('{"large":9007199254740993,"negative":-0,"exponent":1.20e+03,"key":1,"key":2}');
        expect(lines[0]).toBe(tagged('info', `{
  "large": 9007199254740993,
  "negative": -0,
  "exponent": 1.20e+03,
  "key": 1,
  "key": 2
}`));
    });

    it('recognizes JSON payloads in existing labeled string messages', () => {
        const lines: string[] = [];
        const logger = new Logger('info', line => lines.push(line));
        logger.info('review: {"count":1,"findings":[]}');
        logger.info('review:\n{\n"count":1,"findings":[]\n}');
        const expected = tagged('info', 'review:\n{\n  "count": 1,\n  "findings": []\n}');
        expect(lines).toEqual([expected, expected]);
    });

    it('formats standalone JSON lines inside transcripts but leaves malformed JSON and source code alone', () => {
        const lines: string[] = [];
        const logger = new Logger('info', line => lines.push(line));
        logger.llm('Context:\n{"count":2}\n{"broken":}\nEnd.');
        logger.deterministic('line 1 (let): let value = [1, 2]');
        expect(lines).toEqual([
            tagged('llm', 'Context:\n{\n  "count": 2\n}\n{"broken":}\nEnd.'),
            '[deterministic] line 1 (let): let value = [1, 2]',
        ]);
    });

    it('colors tags and individual JSON tokens without changing the plain-text output', () => {
        const plain: string[] = [];
        const colored: string[] = [];
        const value = { key: 'text', number: 42, boolean: false, nothing: null };
        new Logger('info', line => plain.push(line)).info('payload:', value);
        new Logger('info', line => colored.push(line), { color: true }).info('payload:', value);
        expect(stripVTControlCharacters(colored[0])).toBe(plain[0]);
        expect(colored[0]).toContain('\u001b[34m[info]\u001b[0m');
        expect(colored[0]).toContain('\u001b[36m"key"\u001b[0m');
        expect(colored[0]).toContain('\u001b[32m"text"\u001b[0m');
        expect(colored[0]).toContain('\u001b[33m42\u001b[0m');
        expect(colored[0]).toContain('\u001b[35mfalse\u001b[0m');
        expect(colored[0]).toContain('\u001b[90mnull\u001b[0m');
    });

    it('handles non-JSON values explicitly instead of dropping errors or crashing on cycles', () => {
        const lines: string[] = [];
        const logger = new Logger('info', line => lines.push(line));
        const cyclic: { self?: unknown } = {};
        cyclic.self = cyclic;
        logger.info(cyclic);
        logger.info(1n, undefined, NaN);
        logger.error(new Error('visible failure'));
        expect(lines[0]).toContain('[Circular');
        expect(lines[1]).toBe('[info] 1n undefined NaN');
        expect(lines[2]).toContain('Error: visible failure');
        expect(lines[2].split('\n').every(line => line.startsWith('[error] '))).toBe(true);
    });

    it('does not serialize filtered log payloads', () => {
        const toJSON = vi.fn(() => { throw new Error('must not serialize'); });
        const sink = vi.fn();
        new Logger('error', sink).debug({ toJSON });
        new Logger('silent', sink).error({ toJSON });
        expect(toJSON).not.toHaveBeenCalled();
        expect(sink).not.toHaveBeenCalled();
    });

    it('strips supplied terminal escapes before applying its own consistent styling', () => {
        const lines: string[] = [];
        new Logger('info', line => lines.push(line)).info('\u001b[31mplain\u001b[0m');
        expect(lines).toEqual(['[info] plain']);
    });

    it.each([
        [undefined, undefined, false],
        ['1', undefined, true],
        ['0', undefined, false],
        ['1', '1', false],
    ])('honors FORCE_COLOR=%s and NO_COLOR=%s for the default stderr sink', (force, noColor, colored) => {
        vi.stubEnv('FORCE_COLOR', force);
        vi.stubEnv('NO_COLOR', noColor);
        const writes = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        const descriptor = Object.getOwnPropertyDescriptor(process.stderr, 'isTTY');
        Object.defineProperty(process.stderr, 'isTTY', { value: false, configurable: true });
        try {
            new Logger().info({ value: 1 });
        } finally {
            if (descriptor) Object.defineProperty(process.stderr, 'isTTY', descriptor);
            else Reflect.deleteProperty(process.stderr, 'isTTY');
        }
        expect(String(writes.mock.calls[0][0]).includes('\u001b[')).toBe(colored);
    });

    it('uses terminal color automatically and disables it for TERM=dumb', () => {
        vi.stubEnv('FORCE_COLOR', undefined);
        vi.stubEnv('NO_COLOR', undefined);
        vi.stubEnv('TERM', 'xterm');
        const writes = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        const descriptor = Object.getOwnPropertyDescriptor(process.stderr, 'isTTY');
        Object.defineProperty(process.stderr, 'isTTY', { value: true, configurable: true });
        try {
            new Logger().info('terminal');
            vi.stubEnv('TERM', 'dumb');
            new Logger().info('plain');
        } finally {
            if (descriptor) Object.defineProperty(process.stderr, 'isTTY', descriptor);
            else Reflect.deleteProperty(process.stderr, 'isTTY');
        }
        expect(String(writes.mock.calls[0][0])).toContain('\u001b[');
        expect(String(writes.mock.calls[1][0])).not.toContain('\u001b[');
    });

    it('keeps script objects structured for both log expressions and the log builtin', async () => {
        const lines: string[] = [];
        const result = await run(parse(`let payload = {'findings': [1, True, None]}
log('review', payload)
let write_log = log
write_log('review', payload)
success payload`), { backend: new NoLlm(), logger: new Logger('info', line => lines.push(line)) });
        const expected = tagged('info', `log: review\n${JSON.stringify({ findings: [1, true, null] }, null, 2)}`);
        expect(lines.filter(line => line.startsWith('[info]'))).toEqual([expected, expected]);
        expect(result).toMatchObject({ status: 'success', value: { findings: [1, true, null] } });
    });
});
