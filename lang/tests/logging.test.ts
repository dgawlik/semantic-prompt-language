import { describe, expect, it } from 'vitest';
import { run } from '../src/interpreter.js';
import { LlmError, type LlmBackend, type LlmRequest } from '../src/llm.js';
import { Logger } from '../src/logger.js';
import { parse } from '../src/parser.js';

describe.each(['error', 'info', 'debug', 'silent'] as const)('LLM logging at %s', (level) => {
    it.each([
        ['ask', `?'Ask prompt'`],
        ['think', `think 'Think prompt'`],
        ['tool', `read_file 'Tool prompt'`],
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
        expect(requests[0].prompt).toContain('You MUST: Be precise');
        if (level === 'silent') {
            expect(lines).toEqual([]);
        } else {
            expect(lines[0]).toBe(`[llm] llm request (${kind}):\n${requests[0].prompt}`);
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
        const result = await run(parse(`success ?'Failing prompt'`), {
            backend, logger: new Logger(level, (line) => lines.push(line)), cwd: process.cwd(),
        });

        expect(result).toMatchObject({ status: 'failure', failure: { status_code: 'llm_error' } });
        if (level === 'silent') {
            expect(lines).toEqual([]);
        } else {
            expect(lines[0]).toBe('[llm] llm request (ask):\nFailing prompt');
            expect(lines[1]).toContain('[error] llm_error: backend unavailable');
            expect(lines).toHaveLength(2);
        }
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
