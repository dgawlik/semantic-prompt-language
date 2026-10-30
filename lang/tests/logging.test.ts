import { stripVTControlCharacters } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { run } from '../src/interpreter.js';
import { LlmError, type LlmBackend, type LlmRequest } from '../src/llm.js';
import { Logger } from '../src/logger.js';
import { parse } from '../src/parser.js';
import { NoLlm } from './helpers.js';
import type { LogEvent } from '../src/log-events.js';

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
});

const tagged = (tag: string, text: string) =>
    `${({ error: 'x error', warn: '! warning', info: 'i info', debug: '. debug', llm: '- message', deterministic: '- message' })[tag] ?? tag} ${text}`;

describe('structured logging foundation', () => {
    it('allocates contiguous visible order after successful or reentrant serialization', () => {
        const history: LogEvent[] = [];
        const logger = new Logger('info', undefined, { eventSink: event => history.push(event) });
        expect(() => logger.info({ toJSON() { throw new Error('serialization failed'); } })).toThrow('serialization failed');
        logger.info({ toJSON() { logger.info('inner'); return { outer: true }; } });
        expect(history.map(event => event.sequence)).toEqual([1, 2]);
        expect(new Set(history.map(event => event.id)).size).toBe(2);
        expect(history[0].segments).toEqual([{ type: 'text', text: 'inner' }]);
    });

    it('filters before serializers, state factories and event allocation', () => {
        const eventSink = vi.fn();
        const serialize = vi.fn(() => 'payload');
        const snapshot = vi.fn();
        const logger = new Logger('silent', vi.fn(), { eventSink });
        logger.error({ toJSON: serialize });
        logger.state(snapshot);
        expect(serialize).not.toHaveBeenCalled();
        expect(snapshot).not.toHaveBeenCalled();
        expect(eventSink).not.toHaveBeenCalled();
    });

    describe('ordered JSON payloads', () => {
        it('retains tokens and text around multiple balanced multiline containers', () => {
            const history: LogEvent[] = [];
            const logger = new Logger('info', undefined, { eventSink: event => history.push(event) });
            logger.llm('Before\nlabel: {\n"large":9007199254740993,"key":1,"key":2,"escaped":"\\\\n"\n}\nbetween [[],{},-0,1.20e+03] after');
            const payloads = history[0].segments.filter(segment => segment.type === 'json');
            expect(payloads).toHaveLength(2);
            expect(payloads[0].source).toContain('"key":1,"key":2');
            expect(payloads[1].source).toBe('[[],{},-0,1.20e+03]');
            expect(new Set(payloads.map(payload => payload.payloadId)).size).toBe(2);
            const text = history[0].segments.filter(segment => segment.type === 'text').map(segment => segment.text).join('');
            expect(text).toContain('Before\nlabel:');
            expect(text).toContain('between');
            expect(text).toContain('after');
        });

        it.each(['{"broken":{"valid":1},}', 'not [JSON] prose', 'true', 'null', '9007199254740993', '"string"'])(
            'does not invent folds for malformed JSON/prose/primitives: %s', value => {
                const sink = vi.fn();
                new Logger('info', undefined, { eventSink: sink }).info(value);
                expect(sink.mock.calls[0][0].segments.every(segment => segment.type !== 'json')).toBe(true);
            },
        );

        it('sanitizes labels, inspected values and controls but preserves legitimate newlines', () => {
            const lines: string[] = [];
            const logger = new Logger('info', line => lines.push(line));
            logger.info('\u001b]0;hostile\u0007safe\u0000\nnext\u009b31m');
            logger.error(new Error('\u001b[31munsafe\u001b[0m\u0007'));
            expect(lines[0]).toBe('i info safe\nnext');
            expect(lines.every(line => !/[\u0000\u0007\u001b\u009b]/.test(line))).toBe(true);
        });
    });

    it('substitutes structured delivery and detaches immutable event bodies', () => {
        const eventSink = vi.fn();
        const stringSink = vi.fn();
        const logger = new Logger('info', stringSink, { eventSink });
        const payload = { count: 1 };
        logger.info(payload);
        payload.count = 2;
        logger.debug('filtered');
        logger.llm('generic');
        logger.deterministic('explicit embedding message');
        expect(stringSink).not.toHaveBeenCalled();
        const events = eventSink.mock.calls.map(([event]) => event);
        expect(events.map(event => event.sequence)).toEqual([1, 2, 3]);
        expect(new Set(events.map(event => event.id)).size).toBe(3);
        expect(events[0].segments[0]).toMatchObject({ type: 'json', source: '{"count":1}' });
        expect(Object.isFrozen(events[0])).toBe(true);
        expect(Object.isFrozen(events[0].segments)).toBe(true);
        expect(Object.isFrozen(events[0].segments[0])).toBe(true);
        expect(events.slice(1).map(event => event.kind)).toEqual(['generic', 'generic']);
    });

    it('keeps script prefixes and custom sinks plain without acquiring input', () => {
        const input = vi.spyOn(process.stdin, 'on');
        const lines: string[] = [];
        new Logger('info', line => lines.push(line)).info('log:', 'explicit');
        expect(lines).toEqual(['[info] log: explicit']);
        expect(input).not.toHaveBeenCalled();
    });
});

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
            expect(lines).toContain(`-> input ${kind} ${requests[0].prompt}`);
            expect(lines.at(-1)).toBe(`<- output ${kind} ${text}`);
            expect(lines.some((line) => line.startsWith('i info llm '))).toBe(level !== 'error');
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
            expect(lines).toContain('-> input ask Failing prompt');
            expect(lines.at(-1)).toContain('x error llm_error: backend unavailable');
            expect(lines.some((line) => line.startsWith('<- output'))).toBe(false);
        }
    });

    it('never traces executed deterministic source, including loop iterations', async () => {
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
        expect(lines.some(line => /deterministic|line \d+ \(|let n|n \+=|if False|success n/.test(line))).toBe(false);
    });
});

it('distinguishes all event directions and categories with single colored headers', () => {
    const lines: string[] = [];
    const logger = new Logger('debug', line => lines.push(line), { color: true });
    const interaction = { kind: 'ask', requestId: 'request-1' } as const;
    logger.modelInput(interaction, 'one\ntwo');
    logger.modelOutput(interaction, 'three\nfour');
    logger.error('error');
    logger.warn('warning');
    logger.info('info');
    logger.debug('debug');
    logger.state(() => ({ operation: 'initialize', bindings: [{
        binding: { bindingId: 's1:n', name: 'n', scopeId: 's1', kind: 'global', label: 'global' },
        previous: { presence: 'unbound' }, next: { presence: 'value', valueKind: 'scalar', display: '1' },
    }] }));
    logger.llm('generic');
    const headers = [['-> input ask', 35], ['<- output ask', 36], ['x error', 31], ['! warning', 33],
        ['i info', 34], ['. debug', 90], ['~ state', 33], ['- message', 35]];
    headers.forEach(([header, color], index) => {
        expect(lines[index]).toContain(`\u001b[${color}m${header}\u001b[0m`);
        expect(stripVTControlCharacters(lines[index]).split(String(header))).toHaveLength(2);
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
    expect(lines).toEqual(['x error visible error', '- message visible transcript']);
});

describe('console formatting', () => {
    it('uses one header for each multiline event across all log categories', () => {
        const lines: string[] = [];
        const logger = new Logger('debug', line => lines.push(line));
        for (const tag of ['error', 'warn', 'info', 'debug', 'llm', 'deterministic'] as const) {
            logger[tag]('First\r\nSecond\rThird');
        }
        expect(lines).toEqual(['error', 'warn', 'info', 'debug', 'llm', 'deterministic']
            .map(tag => tagged(tag, 'First\nSecond\nThird')));
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
            '- message line 1 (let): let value = [1, 2]',
        ]);
    });

    it('colors tags and individual JSON tokens without changing the plain-text output', () => {
        const plain: string[] = [];
        const colored: string[] = [];
        const value = { key: 'text', number: 42, boolean: false, nothing: null };
        new Logger('info', line => plain.push(line)).info('payload:', value);
        new Logger('info', line => colored.push(line), { color: true }).info('payload:', value);
        expect(stripVTControlCharacters(colored[0])).toBe(plain[0]);
        expect(colored[0]).toContain('\u001b[34mi info\u001b[0m');
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
        expect(lines[1]).toBe('i info 1n undefined NaN');
        expect(lines[2]).toContain('Error: visible failure');
        expect(lines[2].match(/x error/g)).toHaveLength(1);
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
        expect(lines).toEqual(['i info plain']);
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
        const expected = `[info] log: review\n${JSON.stringify({ findings: [1, true, null] }, null, 2)}`;
        expect(lines.filter(line => line.startsWith('[info]'))).toEqual([expected, expected]);
        expect(result).toMatchObject({ status: 'success', value: { findings: [1, true, null] } });
    });
});
