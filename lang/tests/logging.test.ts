import { describe, expect, it } from 'vitest';
import { run } from '../src/interpreter.js';
import { LlmError, type LlmBackend, type LlmRequest } from '../src/llm.js';
import { Logger } from '../src/logger.js';
import { parse } from '../src/parser.js';
import { NoLlm } from './helpers.js';

describe.each(['error', 'info', 'debug', 'silent'] as const)('script log levels at %s', (level) => {
    it('filters modifier logs and keeps ordinary log at info', async () => {
        const lines: string[] = [];
        const result = await run(parse(`
let chosen = 'debug'
let n = 0
def next() { n += 1; return n }
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
        const result = await run(parse(`enforce 'Be precise' { success ${expression} }`), {
            backend, logger: new Logger(level, (line) => lines.push(line)), cwd: process.cwd(),
        });

        expect(result).toMatchObject({ status: 'success', value: text.trim() });
        expect(requests).toHaveLength(1);
        expect(requests[0].prompt).toContain('Follow: Be precise');
        if (level === 'silent') {
            expect(lines).toEqual([]);
        } else {
            expect(lines).toContain(`[llm] llm request (${kind}):\n${requests[0].prompt}`);
            expect(lines.at(-1)).toBe(`[llm] llm response:\n${text}`);
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
            expect(lines).toContain('[llm] llm request (ask):\nFailing prompt');
            expect(lines.at(-1)).toContain('[error] llm_error: backend unavailable');
            expect(lines.some((line) => line.startsWith('[llm] llm response:'))).toBe(false);
        }
    });

    it('traces only executed deterministic statements, including loop iterations', async () => {
        const lines: string[] = [];
        const result = await run(parse(`let n = 0
for i in [1, 2] {
    n += i
}
if False {
    fail 'unreachable'
}
success n`), {
            backend: { async call() { throw new Error('unexpected LLM call'); }, async close() {} },
            logger: new Logger(level, (line) => lines.push(line)), cwd: process.cwd(),
        });
        expect(result).toMatchObject({ status: 'success', value: 3 });
        expect(lines).toEqual(level === 'silent' ? [] : [
            '[deterministic] line 1 (let): let n = 0',
            '[deterministic] line 2 (for): for i in [1, 2] {',
            '[deterministic] line 3 (assign): n += i',
            '[deterministic] line 3 (assign): n += i',
            '[deterministic] line 5 (if): if False {',
            '[deterministic] line 8 (success): success n',
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
