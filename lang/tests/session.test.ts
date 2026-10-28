import { describe, expect, it } from 'vitest';
import { ExecutionSession, run } from '../src/interpreter.js';
import { Logger } from '../src/logger.js';
import { parse } from '../src/parser.js';
import { parseMarkdown } from '../src/markdown.js';
import type { LlmBackend } from '../src/llm.js';
import { NoLlm } from './helpers.js';

const logger = new Logger('silent');
const options = { logger, backend: new NoLlm() };

describe('interactive execution sessions', () => {
    it('retains variables, mutable aliases and closures in execution order', async () => {
        const session = new ExecutionSession();
        await session.run(parse('let count = 2\nlet items = []\nlet alias = items\ndef double():\n    return count * 2'), options);
        await session.run(parse('items.append(double())\ncount += 1'), options);
        expect(await session.run(parse('[double(), alias]'), options))
            .toEqual({ status: 'success', hasValue: true, value: [6, [4]] });
        await session.run(parse('let count = 10'), options);
        expect(await session.run(parse('double()'), options)).toMatchObject({ value: 20 });
    });

    it('isolates notebooks and preserves one-shot result behavior', async () => {
        const first = new ExecutionSession();
        await first.run(parse('let value = 42'), options);
        expect(await new ExecutionSession().run(parse('value'), options)).toMatchObject({ status: 'failure' });
        expect(await run(parse('1 + 1'), options)).toEqual({ status: 'success', hasValue: false, value: null });
        expect(await first.run(parse('None'), options)).toEqual({ status: 'success', hasValue: true, value: null });
        expect(await first.run(parse('let nothing = None'), options)).toEqual({ status: 'success', hasValue: false, value: null });
    });

    it('rejects concurrent runs without corrupting the active scope', async () => {
        const session = new ExecutionSession();
        let finish: (() => void) | undefined;
        const waiting = new Promise<void>(resolve => { finish = resolve; });
        const backend: LlmBackend = {
            async call() { await waiting; return { text: 'ready', effective: {} }; },
            async close() {},
        };
        const first = session.run(parse("let value = ask 'one'"), { logger, backend });
        await expect(session.run(parse('let other = 1'), options)).rejects.toThrow(/one cell at a time/);
        finish!();
        await first;
        expect(await session.run(parse('value'), options)).toMatchObject({ value: 'ready' });
        expect(await session.run(parse('other'), options)).toMatchObject({ status: 'failure' });
    });

    it('keeps state before a failure and permits recovery without replaying cells', async () => {
        const session = new ExecutionSession();
        expect(await session.run(parse("let count = 1\ncount += 1\nfail 'stop'"), options)).toMatchObject({ status: 'failure' });
        expect(await session.run(parse('count'), options)).toMatchObject({ status: 'success', value: 2 });
        expect(await session.run(parse('missing'), options)).toMatchObject({ status: 'failure' });
        expect(await session.run(parse('count += 1\nsuccess count'), options)).toMatchObject({ status: 'success', value: 3 });
    });

    it('uses the current cell restrictions and logger for saved builtin aliases', async () => {
        const session = new ExecutionSession();
        await session.run(parse('let reader = read_file\nlet print = log'), options);
        expect(await session.run(parse("restrict './out':\n    reader('./secret.txt')"), options)).toMatchObject({
            status: 'failure', failure: { status_code: 'restriction_violation' },
        });
        const lines: string[] = [];
        await session.run(parse("print('current cell')"), {
            backend: new NoLlm(), logger: new Logger('info', line => lines.push(line)),
        });
        expect(lines.some(line => line.includes('current cell'))).toBe(true);
    });

    it('locates nested function failures in the original cell', async () => {
        const session = new ExecutionSession();
        await session.run(parse("def broken():\n    fail 'original'\ndef nested():\n    return broken()"),
            { ...options, source: 'cell:definition' });
        expect(await session.run(parse('nested()'), { ...options, source: 'cell:caller' })).toMatchObject({
            status: 'failure', failure: { line: 2, command: "fail 'original'", source: 'cell:definition' },
        });
        expect(await session.run(parse('missing'), { ...options, source: 'cell:next' })).toMatchObject({
            status: 'failure', failure: { line: 1, source: 'cell:next' },
        });
    });

    it('retains the original source version for aliases of redefined functions', async () => {
        const session = new ExecutionSession();
        await session.run(parse("def broken():\n    fail 'old'\nlet old = broken"),
            { ...options, source: 'cell:definition', sourceVersion: 1 });
        await session.run(parse("def broken():\n    fail 'new'"),
            { ...options, source: 'cell:definition', sourceVersion: 2 });
        expect(await session.run(parse('old()'), { ...options, source: 'cell:caller', sourceVersion: 3 }))
            .toMatchObject({ status: 'failure', failure: { reason: 'old', source: 'cell:definition', source_version: 1 } });
        expect(await session.run(parse('broken()'), { ...options, source: 'cell:caller', sourceVersion: 3 }))
            .toMatchObject({ status: 'failure', failure: { reason: 'new', source: 'cell:definition', source_version: 2 } });
    });

    it('shares state with blockquotes using the existing agent runtime', async () => {
        const session = new ExecutionSession();
        await session.run(parse('let count = 2\ndef double(x):\n    return x * 2'), options);
        let turn = 0;
        const backend: LlmBackend = {
            async call(request) {
                expect(request.prompt).toContain('"count":2');
                return {
                    text: 'Done', effective: {},
                    ...(turn++ === 0 ? { action: { name: 'save_variable', arguments: { name: 'count', value: 4 } } } : {}),
                };
            },
            async close() {},
        };
        const program = parseMarkdown('---\nextension: semantic-prompt-language\nversion: 1\n---\n\n> Double @count.');
        expect(await session.run(program, { logger, backend })).toMatchObject({ status: 'success' });
        expect(await session.run(parse('double(count)'), options)).toMatchObject({ value: 8 });
    });
});
