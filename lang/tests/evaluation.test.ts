import { describe, expect, it } from 'vitest';
import { run } from '../src/interpreter.js';
import { Logger } from '../src/logger.js';
import { isReservedName, parse } from '../src/parser.js';
import { NoLlm } from './helpers.js';

describe('removed eval syntax', () => {
    it.each([
        "eval(expected='Reference', actual='Candidate', cutoff=0.9)",
        "let result = eval(expected='Reference', actual='Candidate', cutoff=0.9)",
    ])('rejects the former evaluation statement: %s', source => {
        expect(() => parse(source)).toThrow();
    });

    it('allows eval as an ordinary function name', async () => {
        expect(isReservedName('eval')).toBe(false);
        const source = `def eval(value):
    return value
success eval(42)`;
        expect(await run(parse(source), { backend: new NoLlm(), logger: new Logger('silent') }))
            .toMatchObject({ status: 'success', value: 42 });
    });

    it('retains explicit output assertions', async () => {
        const result = await run(parse("assert 'Reference' == 'Candidate' 'outputs differ'"), {
            backend: new NoLlm(), logger: new Logger('silent'),
        });
        expect(result).toMatchObject({
            status: 'failure', failure: { status_code: 'assertion_failed', reason: 'outputs differ' },
        });
    });
});
