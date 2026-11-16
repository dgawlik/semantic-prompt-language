import * as fs from 'node:fs';
import * as path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LlmError, type LlmBackend, type LlmRequest } from '../src/llm.js';
import type { LogEvent, ModelStreamEvent } from '../src/log-events.js';
import { formatEvent, formatSegments, prettyListing } from '../src/log-format.js';
import { Logger } from '../src/logger.js';
import { AGENT_PREAMBLE, CODEGEN_PREAMBLE } from '../src/preamble.js';
import { describeToolCall } from '../src/tools.js';
import { Trace } from '../src/trace.js';
import { run } from '../src/workflow.js';
import { NoLlm, acting, action, agentBlock, backend, block, cleanTemp, collecting, exec, save, scripted, tempDir, text } from './helpers.js';

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    cleanTemp();
});

type Level = 'error' | 'info' | 'debug' | 'silent';
const tagged = (tag: string, body: string) =>
    `${({ error: 'x error', warn: '! warning', info: 'i info', debug: '. debug' })[tag] ?? tag} ${body}`;

const modelEvents = (events: LogEvent[], kind: 'model-input' | 'model-output') =>
    events.filter(event => event.origin === 'model').filter(event => event.kind === kind);
const states = (events: LogEvent[]): string[] => events.filter(event => event.kind === 'state').map(text);
/** Model events as `kind interaction role`, other events by kind: the shape of a transcript. */
const outline = (events: LogEvent[]): string[] => events.map(event => event.kind === 'model-input' || event.kind === 'model-output'
    ? `${event.kind} ${event.interaction.kind} ${event.interaction.role ?? '-'}` : event.kind);

/** Collects transcript events and transient stream previews separately. */
function recording(level: Level = 'error') {
    const events: LogEvent[] = [];
    const streams: ModelStreamEvent[] = [];
    const logger = new Logger(level, undefined, { eventSink: event => events.push(event), streamSink: event => streams.push(event) });
    return { events, streams, logger };
}

/** Collects the plain lines a custom string sink receives. */
function printing(level: Level = 'info') {
    const lines: string[] = [];
    return { lines, logger: new Logger(level, line => lines.push(line)) };
}

describe('structured logging foundation', () => {
    it('keeps codegen source in one immutable code segment instead of folding JSON-like literals', () => {
        const { logger, events } = recording();
        const source = 'function values() {\n    return [1,2,{"not":"folded"}];\n}';
        logger.modelOutput({ kind: 'codegen', requestId: 'generated' }, source);
        expect(events[0].segments).toEqual([{ type: 'code', language: 'javascript', source }]);
        expect(Object.isFrozen(events[0].segments[0])).toBe(true);
        expect(formatSegments(events[0].segments)).toBe(source);
        const colored = formatSegments(events[0].segments, true);
        expect(colored).toContain('\u001b[35mfunction\u001b[0m');
        expect(colored).toContain('\u001b[36mvalues\u001b[0m');
        expect(stripVTControlCharacters(colored)).toBe(source);
        expect(formatEvent(events[0])).toBe('<- output codegen ' + source);
        logger.modelOutput({ kind: 'ask', requestId: 'ordinary' }, '[1,2]');
        expect(events[1].segments[0].type).toBe('json');
        logger.modelOutput({ kind: 'codegen', requestId: 'generated', role: 'action' }, '[1,2]');
        expect(events[2].segments[0].type).toBe('json');
    });

    it('sanitizes codegen source before structured or plain delivery', () => {
        const { logger, events } = recording();
        logger.modelOutput({ kind: 'codegen', requestId: 'controls' }, '\u001b[31mfunction answer() {\r\n    return 42;\u0007\r\n}');
        expect(events[0].segments).toEqual([{ type: 'code', language: 'javascript', source: 'function answer() {\n    return 42;\n}' }]);
    });

    it('allocates contiguous visible order after successful or reentrant serialization', () => {
        const { logger, events } = collecting('info');
        expect(() => logger.info({ toJSON() { throw new Error('serialization failed'); } })).toThrow('serialization failed');
        logger.info({ toJSON() { logger.info('inner'); return { outer: true }; } });
        expect(events.map(event => event.sequence)).toEqual([1, 2]);
        expect(new Set(events.map(event => event.id)).size).toBe(2);
        expect(events[0].segments).toEqual([{ type: 'text', text: 'inner' }]);
    });

    describe('JavaScript code display', () => {
        it.each([false, true])('preserves transcript source whitespace without gutters with color=%s', color => {
            const source = '\n// Generated function\nfunction answer() {\n    return `return 42\nfunction string`;\n}\n\n';
            const { logger, events } = recording();
            logger.modelOutput({ kind: 'codegen', requestId: 'whitespace' }, source);
            const formatted = formatEvent(events[0], color);
            expect(stripVTControlCharacters(formatted)).toBe('<- output codegen ' + source);
            if (color) {
                expect(formatted).toContain('\u001b[90m// Generated function\u001b[0m');
                expect(formatted).toContain('\u001b[35mfunction\u001b[0m');
                expect(formatted).toContain('\u001b[32m`return 42\u001b[0m');
                expect(formatted).toContain('\u001b[32mfunction string`\u001b[0m');
            } else expect(formatted).toBe('<- output codegen ' + source);
        });

        const prettyCode = (source: string, color = false): string => prettyListing(source, 'javascript', color);

        it('adds line numbers without changing indentation, literals or numeric spelling', () => {
            const source = 'function values() {\n    return [1,2,1.20e+03];\n}\n';
            expect(prettyCode(source)).toBe('1 | function values() {\n2 |     return [1,2,1.20e+03];\n3 | }');
            expect(stripVTControlCharacters(prettyCode(source, true))).toBe(prettyCode(source));
            expect(prettyCode(source, true)).toContain('\u001b[35mfunction\u001b[0m');
            expect(prettyCode(source, true)).toContain('\u001b[36mvalues\u001b[0m');
            expect(prettyCode(source, true)).toContain('\u001b[33m1.20e+03\u001b[0m');
        });

        it('highlights comments, strings and template literals without styling their contents as code', () => {
            const source = [
                '// function comment',
                '/* block',
                '   return */',
                'async function answer() {',
                "    const folder = 'C:\\\\work\\\\';",
                '    return `return 42',
                'function string`;',
                '}',
            ].join('\n');
            const formatted = prettyCode(source, true);
            expect(formatted).toContain('\u001b[90m// function comment\u001b[0m');
            expect(formatted).toContain('\u001b[90m/* block\u001b[0m');
            expect(formatted).toContain('\u001b[90m   return */\u001b[0m');
            expect(formatted).toContain('\u001b[35masync\u001b[0m \u001b[35mfunction\u001b[0m \u001b[36manswer\u001b[0m');
            expect(formatted).toContain("\u001b[32m'C:\\\\work\\\\'\u001b[0m");
            expect(formatted).toContain('\u001b[32m`return 42\u001b[0m');
            expect(formatted).toContain('\u001b[32mfunction string`\u001b[0m');
            expect(formatted).not.toContain('\u001b[35mfunction\u001b[0m string');
            expect(formatted).not.toContain('\u001b[35mreturn\u001b[0m */');
            expect(stripVTControlCharacters(formatted)).toBe(prettyCode(source));
        });

        it.each(['function answer(value', "function answer() {\n    return 'part", 'function answer() {\n    return `part\nnext', '/* open\nfunction'])(
            'supports incomplete streaming source: %s', source => {
                const expected = source.split('\n').map((line, i) => `${i + 1} | ${line}`).join('\n');
                expect(stripVTControlCharacters(prettyCode(source, true))).toBe(expected);
            },
        );

        it('aligns double-digit line numbers and strips embedded terminal controls', () => {
            expect(prettyCode(Array.from({ length: 10 }, (_, i) => `// ${i + 1}`).join('\n')).split('\n'))
                .toEqual(Array.from({ length: 10 }, (_, i) => `${String(i + 1).padStart(2)} | // ${i + 1}`));
            expect(prettyCode('\u001b[31mfunction answer() {\u0007\n    return 42;\n}'))
                .toBe('1 | function answer() {\n2 |     return 42;\n3 | }');
        });
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

    it.each(['error', 'info', 'silent'] as const)('filters state snapshots before evaluation and allocation at %s', level => {
        const history: LogEvent[] = [];
        const sink = vi.fn();
        const snapshot = vi.fn();
        const logger = new Logger(level, sink, { eventSink: event => history.push(event) });
        expect(logger.observesState).toBe(false);
        logger.state(snapshot);
        expect(snapshot).not.toHaveBeenCalled();
        expect(history).toEqual([]);
        expect(sink).not.toHaveBeenCalled();
        logger.error('visible');
        expect(history.map(event => event.sequence)).toEqual(level === 'silent' ? [] : [1]);
    });

    describe('ordered JSON payloads', () => {
        it('retains tokens and text around multiple balanced multiline containers', () => {
            const { logger, events } = collecting('info');
            logger.info('Before\nlabel: {\n"large":9007199254740993,"key":1,"key":2,"escaped":"\\\\n"\n}\nbetween [[],{},-0,1.20e+03] after');
            const payloads = events[0].segments.filter(segment => segment.type === 'json');
            expect(payloads).toHaveLength(2);
            expect(payloads[0].source).toContain('"key":1,"key":2');
            expect(payloads[0]).toMatchObject({ container: 'object', summary: 'object [folded]' });
            expect(payloads[1]).toMatchObject({ container: 'array', summary: 'array [folded]', source: '[[],{},-0,1.20e+03]' });
            expect(new Set(payloads.map(payload => payload.payloadId)).size).toBe(2);
            expect(payloads.every(payload => payload.payloadId.startsWith(`${events[0].id}:`))).toBe(true);
            const prose = events[0].segments.flatMap(segment => segment.type === 'text' ? [segment.text] : []).join('');
            expect(prose).toContain('Before\nlabel:');
            expect(prose).toContain('between');
            expect(prose).toContain('after');
        });

        it.each(['{"broken":{"valid":1},}', 'not [JSON] prose', 'true', 'null', '9007199254740993', '"string"'])(
            'does not invent folds for malformed JSON/prose/primitives: %s', value => {
                const { logger, events } = collecting('info');
                logger.info(value);
                expect(events[0].segments.every(segment => segment.type !== 'json')).toBe(true);
            },
        );

        it('sanitizes labels, inspected values and controls but preserves legitimate newlines', () => {
            const { logger, lines } = printing();
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
        logger.warn('careful');
        logger.modelOutput({ kind: 'ask', requestId: 'request' }, 'answer');
        expect(stringSink).not.toHaveBeenCalled();
        const events = eventSink.mock.calls.map(([event]) => event);
        expect(events.map(event => event.sequence)).toEqual([1, 2, 3]);
        expect(new Set(events.map(event => event.id)).size).toBe(3);
        expect(events[0].segments[0]).toMatchObject({ type: 'json', source: '{"count":1}' });
        expect(Object.isFrozen(events[0])).toBe(true);
        expect(Object.isFrozen(events[0].segments)).toBe(true);
        expect(Object.isFrozen(events[0].segments[0])).toBe(true);
        expect(events.slice(1).map(event => [event.kind, event.origin])).toEqual([['warning', 'diagnostic'], ['model-output', 'model']]);
        expect(Object.isFrozen(events[2].interaction)).toBe(true);
    });

    it('logs tool calls under their camelCase names with the content as a listing', () => {
        const { logger, events } = collecting('info');
        logger.tool(describeToolCall('readFile', { path: 'src/a.ts' }, { output: 'const a = 1;\n' }));
        logger.tool(describeToolCall('webSearch', { query: 'spl' }, { error: 'webSearch: offline\ndetails' }));
        expect(events.map(event => event.kind === 'tool' && event.tool)).toEqual([
            { name: 'readFile', target: 'src/a.ts', status: 'success' }, { name: 'webSearch', target: '"spl"', status: 'error' },
        ]);
        expect(events[0].segments).toEqual([
            { type: 'text', text: 'src/a.ts' }, { type: 'text', text: '\n' },
            { type: 'listing', payloadId: `${events[0].id}:listing`, language: 'typescript', source: 'const a = 1;\n', summary: '1 line' },
        ]);
        expect(events.map(event => formatEvent(event))).toEqual(['* tool readFile src/a.ts\nconst a = 1;\n', '* tool webSearch failed "spl"\nwebSearch: offline\ndetails']);
        const quiet = collecting('error');
        quiet.logger.tool(describeToolCall('shell', { command: 'true' }, { output: '' }));
        expect(quiet.events).toEqual([]);
    });

    it('keeps script prefixes and custom sinks plain without acquiring input', () => {
        const input = vi.spyOn(process.stdin, 'on');
        const { logger, lines } = printing();
        logger.info('log:', 'explicit');
        expect(lines).toEqual(['[info] log: explicit']);
        expect(input).not.toHaveBeenCalled();
    });
});

describe.each(['error', 'info', 'debug', 'silent'] as const)('script log levels at %s', level => {
    it('filters leveled logs and keeps ordinary log at info', async () => {
        const { logger, lines } = printing(level);
        const result = await exec(`
let n = 0;
const next = () => ++n;
log('plain', next());
log.error('problem', next());
log.info('details', next());
const logged = log.debug('trace', next());
success([n, logged === undefined]);`, { logger });
        expect(result).toMatchObject({ status: 'success', value: [4, true] });
        const messages = lines.filter(line => /^\[(error|info|debug)\] log:/.test(line));
        expect(messages).toEqual(level === 'silent' ? [] : [
            ...(level === 'error' ? [] : ['[info] log: plain 1']),
            '[error] log: problem 2',
            ...(level === 'error' ? [] : ['[info] log: details 3']),
            ...(level === 'debug' ? ['[debug] log: trace 4'] : []),
        ]);
    });
});

describe('script logs', () => {
    it('offers exactly the info, error and debug levels', async () => {
        expect(await exec('success([typeof log, Object.keys(log)]);')).toMatchObject({ value: ['function', ['info', 'error', 'debug']] });
        expect(await exec("log.trace('too detailed');")).toMatchObject({
            status: 'failure', failure: { status_code: 'runtime_error', reason: 'TypeError: log.trace is not a function', line: 1 },
        });
    });

    it('keeps objects structured for log calls and aliases of log', async () => {
        const { logger, lines } = printing();
        const result = await exec(`
const payload = { findings: [1, true, null] };
log('review', payload);
const writeLog = log;
writeLog('review', payload);
const { error: report } = log;
report('review', payload);
success(payload);`, { logger });
        const body = `log: review\n${JSON.stringify({ findings: [1, true, null] }, null, 2)}`;
        expect(lines).toEqual([`[info] ${body}`, `[info] ${body}`, `[error] ${body}`]);
        expect(result).toMatchObject({ status: 'success', value: { findings: [1, true, null] } });
    });

    it('marks script events and folds logged containers into JSON segments', async () => {
        const { logger, events } = collecting('info');
        await exec("log('rows', [{ id: 1 }], 'label: {\"a\":1} done');\nlog();", { logger });
        expect(events.map(event => [event.kind, event.origin])).toEqual([['info', 'script'], ['info', 'script']]);
        expect(events[0].segments).toEqual([
            { type: 'text', text: 'log:' }, { type: 'text', text: ' ' }, { type: 'text', text: 'rows' }, { type: 'text', text: '\n' },
            { type: 'json', payloadId: `${events[0].id}:2:0`, container: 'array', source: '[{"id":1}]', summary: 'array [folded]' },
            { type: 'text', text: '\n' }, { type: 'text', text: 'label:\n' },
            { type: 'json', payloadId: `${events[0].id}:3:1`, container: 'object', source: '{"a":1}', summary: 'object [folded]' },
            { type: 'text', text: ' done' },
        ]);
        expect(events[1].segments).toEqual([{ type: 'text', text: 'log:' }]);
    });

    it('describes classes, types, functions, collections and cycles without invoking serializers', async () => {
        const { logger, events } = collecting('info');
        const result = await exec(`
class Point { x = 1; toJSON() { throw new Error('serializer ran'); } }
const Card = Struct('Card', { term: Str });
const loop: { name: string; self?: unknown } = { name: 'loop' };
loop.self = loop;
log(new Point(), Card, function named(a: number) {}, undefined, 10n, NaN, new Map([['k', new Set([1])]]), loop, new Error('kept'));`, { logger });
        expect(result.status).toBe('success');
        expect(text(events[0])).toBe([
            'log:', '{"class":"Point","fields":{"x":1}} Card [function named] undefined 10 NaN',
            '{"k":[1]}', '{"name":"loop","self":"<circular reference>"} <Error kept>',
        ].join('\n'));
    });

    it('sanitizes terminal controls written by scripts', async () => {
        const { logger, lines } = printing();
        await exec("log('\\u001b[31mred\\u001b[0m\\r\\nnext\\u0007', { text: 'bell\\u0007' });", { logger });
        expect(lines).toEqual(['[info] log:\nred\nnext\n{\n  "text": "bell\\u0007"\n}']);
    });
});

describe('model streaming', () => {
    it.each([
        ['ask', "ask('Prompt', { fmt: 'object' })"],
        ['ask', "ask('Prompt', { fmt: 'object', reasoning: 'high' })"],
        ['agent', "agent('Prompt', { fmt: 'object' })"],
    ] as const)('streams %s previews of %s without allocating transcript events or parsing partial JSON', async (kind, call) => {
        const { logger, events, streams } = recording();
        let late: LlmRequest['onStream'];
        const result = await exec(`success(await ${call});`, {
            logger, backend: backend(async request => {
                late = request.onStream;
                request.onStream?.({ channel: 'response', messageId: 'answer', mode: 'append', text: '{"partial":' });
                await new Promise(resolve => setImmediate(resolve));
                expect(streams).toHaveLength(1);
                expect(events.map(event => event.kind)).toEqual(['model-input']);
                return { text: '{"answer":42}', effective: {} };
            }),
        });
        expect(result).toMatchObject({ status: 'success', value: { answer: 42 } });
        expect(streams).toHaveLength(2);
        expect(streams[0]).toMatchObject({ type: 'update', interaction: { kind }, update: { channel: 'response', text: '{"partial":' } });
        expect(streams[1]).toMatchObject({ type: 'end', outcome: 'completed', response: '{"answer":42}' });
        expect(events.map(event => event.kind)).toEqual(['model-input', 'model-output']);
        expect(events.map(event => event.sequence)).toEqual([1, 2]);
        expect(events[1]).toMatchObject({ origin: 'model', interaction: { kind, role: 'response', requestId: streams[0].interaction.requestId } });
        expect(streams[0].interaction.requestId).toBe(streams[1].interaction.requestId);
        late?.({ channel: 'response', messageId: 'answer', mode: 'append', text: 'late' });
        expect(streams).toHaveLength(2);
    });

    it('does not turn a valid partial preview into success when the backend fails', async () => {
        const { logger, events, streams } = recording();
        const result = await exec("success(await ask('Prompt', { fmt: 'object' }));", {
            logger, backend: backend(request => {
                request.onStream?.({ channel: 'response', messageId: 'answer', mode: 'append', text: '{"valid":true}' });
                throw new LlmError('connection lost');
            }),
        });
        expect(result).toMatchObject({ status: 'failure', failure: { status_code: 'llm_error', reason: 'connection lost' } });
        expect(streams.at(-1)).toMatchObject({ type: 'end', outcome: 'failed' });
        expect(streams.at(-1)).not.toHaveProperty('response');
        expect(events.map(event => event.kind)).toEqual(['model-input', 'error']);
    });

    it('keeps repairs in independent stream lifecycles and validates only complete responses', async () => {
        const { logger, streams } = recording();
        let calls = 0;
        const result = await exec("success(await ask('Number?', { fmt: 'integer', repairs: 1 }));", {
            logger, backend: backend(request => {
                request.onStream?.({ channel: 'response', messageId: 'same-sdk-id', mode: 'append', text: '1' });
                return { text: ++calls === 1 ? '"invalid"' : '7', effective: {} };
            }),
        });
        expect(result).toMatchObject({ status: 'success', value: 7 });
        expect(streams.map(event => event.type)).toEqual(['update', 'end', 'update', 'end']);
        expect(streams[0].interaction.requestId).not.toBe(streams[2].interaction.requestId);
    });

    it.each([
        ...['ask', 'agent'].flatMap(kind => [
            { source: `await ${kind}('Prompt');`, show: true },
            { source: `await ${kind}('Prompt', { hide: false });`, show: true },
            { source: `await ${kind}('Prompt', { hide: true });`, show: false },
        ]),
        { source: block('Prompt', 'outputVar: answer'), show: true },
        { source: block('Prompt', 'outputVar: answer', 'hide: true'), show: false },
        { source: agentBlock('Prompt'), show: true },
        { source: agentBlock('Prompt', 'hide: true'), show: false },
        { source: `---\nhide: true\n---\n${agentBlock('Prompt')}`, show: false },
    ])('gates only reasoning previews and final reasoning: $source', async ({ source, show }) => {
        const { logger, streams } = recording();
        await run(source, {
            logger, backend: backend(request => {
                expect(request.showReasoning).toBe(show);
                request.onStream?.({ channel: 'reasoning', messageId: 'reason', mode: 'append', text: 'Thinking' });
                request.onStream?.({ channel: 'response', messageId: 'answer', mode: 'append', text: 'Done' });
                return { text: 'Done', reasoning: 'Full reasoning', effective: {} };
            }),
        });
        expect(streams.filter(event => event.type === 'update' && event.update.channel === 'reasoning')).toHaveLength(show ? 1 : 0);
        expect(streams.filter(event => event.type === 'update' && event.update.channel === 'response')).toHaveLength(1);
        expect(streams.at(-1)).toEqual(expect.objectContaining({
            type: 'end', outcome: 'completed', response: 'Done', ...(show ? { reasoning: 'Full reasoning' } : {}),
        }));
        if (!show) expect(streams.at(-1)).not.toHaveProperty('reasoning');
    });

    it('forwards previews to a caller-supplied stream even when the logger has no stream sink', async () => {
        const { logger, events } = collecting('error');
        const seen: boolean[] = [];
        await exec("await ask('Prompt');", { logger, backend: backend(request => {
            seen.push(typeof request.onStream === 'function');
            return { text: 'Done', effective: {} };
        }) });
        await exec("await ask('Prompt');", { logger: recording().logger, backend: backend(request => {
            seen.push(typeof request.onStream === 'function');
            return { text: 'Done', effective: {} };
        }) });
        expect(seen).toEqual([false, true]);
        expect(events.map(event => event.kind)).toEqual(['model-input', 'model-output']);
    });

    it('detaches and sanitizes stream updates without touching the persistent sequence', () => {
        const { logger, events, streams } = recording();
        const update = { channel: 'response', messageId: 'answer', mode: 'append', text: '\u001b[31mSafe\u001b[0m\r\nnext\u0000' } as const;
        logger.modelStream({ type: 'update', interaction: { kind: 'ask', requestId: 'request' }, update });
        expect(streams[0]).toMatchObject({ update: { text: 'Safe\nnext' } });
        expect(Object.isFrozen(streams[0])).toBe(true);
        if (streams[0].type === 'update') expect(Object.isFrozen(streams[0].update)).toBe(true);
        logger.modelStream({ type: 'end', interaction: { kind: 'ask', requestId: 'request' }, outcome: 'completed', response: 'Done\u0007', reasoning: '\u001b[1mWhy' });
        expect(streams[1]).toMatchObject({ response: 'Done', reasoning: 'Why' });
        logger.modelOutput({ kind: 'ask', requestId: 'request' }, 'Done');
        expect(events[0].sequence).toBe(1);
        const sink = vi.fn();
        const silent = new Logger('silent', sink, { streamSink: sink });
        expect(silent.streamsModels).toBe(false);
        silent.modelStream({ type: 'update', interaction: { kind: 'ask', requestId: 'request' }, update });
        expect(sink).not.toHaveBeenCalled();
    });
});

describe('generated model prefaces', () => {
    it.each([
        ['ask', "success(await enforce('Be precise', () => ask('Visible prompt', { len: 'sentence' })));"],
        ['agent', "success(await enforce('Be precise', () => agent('Visible prompt', { len: 'sentence' })));"],
        ['ask', "---\nenforce: Be precise\n---\nsuccess(await ask('Visible prompt', { len: 'sentence' }));"],
        ['ask', `${block('Visible prompt', 'outputVar: answer', 'enforce: Be precise')}\nsuccess(answer);`],
    ])('separates the generated %s preface without changing the request: %s', async (kind, source) => {
        const { logger, events } = collecting('info');
        const model = scripted('Done');
        const result = await exec(source, { logger, backend: model });
        expect(result).toMatchObject({ status: 'success', value: 'Done' });
        const input = events.find(event => event.kind === 'model-input')!;
        const preface = input.segments[0];
        expect(preface).toMatchObject({ type: 'preface', summary: 'Generated preface [folded]', payloadId: `${input.id}:preface` });
        if (preface.type !== 'preface') throw new Error('expected generated preface');
        expect(preface.source.startsWith('Response guidance (not runtime validation):\n- Follow: Be precise')).toBe(true);
        expect(preface.source.includes('Answer in a single sentence.')).toBe(source.includes('len:'));
        expect(preface.source).not.toContain('Visible prompt');
        expect(Object.isFrozen(preface)).toBe(true);
        expect(formatEvent(input)).toBe(`-> input ${kind} ${model.calls[0].prompt}`);
        expect(formatSegments(input.segments.slice(1))).toBe('\n\nVisible prompt');
    });

    it('does not fold an unprefaced prompt, even if it resembles generated guidance', async () => {
        const { logger, events } = collecting('error');
        const prompt = 'Response guidance (not runtime validation):';
        await exec(`success(await ask('${prompt}'));`, { logger, backend: scripted('Done') });
        expect(events[0].segments).toEqual([{ type: 'text', text: prompt }]);
        const quoted = collecting('error');
        await exec(block(prompt, 'outputVar: answer'), { logger: quoted.logger, backend: scripted('Done') });
        expect(quoted.events[0].segments).toEqual([{ type: 'text', text: prompt }]);
    });

    it('retains the generated preface across repairs while keeping repair feedback visible', async () => {
        const { logger, events } = collecting('info');
        const model = scripted('"bad"', '7');
        const result = await exec("---\nenforce: Be precise\n---\nsuccess(await ask('Number?', { fmt: 'integer', repairs: 1 }));", { logger, backend: model });
        expect(result).toMatchObject({ status: 'success', value: 7 });
        const inputs = modelEvents(events, 'model-input');
        expect(inputs).toHaveLength(2);
        const [first, second] = inputs.map(event => event.segments[0]);
        if (first.type !== 'preface' || second.type !== 'preface') throw new Error('expected generated prefaces');
        expect(first.source).toBe(second.source);
        expect(first.payloadId).not.toBe(second.payloadId);
        expect(formatSegments(inputs[0].segments.slice(1))).toBe('\n\nNumber?');
        expect(formatSegments(inputs[1].segments.slice(1))).toContain('Previous response:\n"bad"\n\nValidation failed:');
        inputs.forEach((event, index) => expect(formatEvent(event)).toBe(`-> input ask ${model.calls[index].prompt}`));
        const repair = events.find(event => event.kind === 'info' && text(event).startsWith('repair'))!;
        expect(repair).toMatchObject({ origin: 'diagnostic' });
        expect(text(repair)).toMatch(/^repair 1\/1: LLM response must be a JSON integer/);
    });

    it('logs the repair of an ask block whose answer does not fit outputType', async () => {
        const { logger, events } = collecting('info');
        const source = `${block('How many?', 'outputVar: count', 'outputType: Int', 'repairs: 1')}\nsuccess(count);`;
        expect(await exec(source, { logger, backend: scripted('"many"', '3') })).toMatchObject({ status: 'success', value: 3 });
        expect(outline(events)).toEqual(['model-input ask -', 'info', 'model-output ask response', 'info', 'model-input ask -', 'info', 'model-output ask response']);
        expect(text(events[3])).toBe('repair 1/1: $: expected Int, got "many"');
        expect(text(events[4])).toContain('Previous response:\n"many"\n\nValidation failed: $: expected Int, got "many"');
    });

    it('shows a requested schema after the folded preface, as a foldable payload', async () => {
        const { logger, events } = collecting('error');
        await exec("await enforce('Be precise', () => ask('Card?', { schema: Struct('Card', { term: Str }) }));", { logger, backend: scripted('{"term":"x"}') });
        const [input, output] = events;
        expect(input.segments[0]).toMatchObject({ type: 'preface', source: 'Response guidance (not runtime validation):\n- Follow: Be precise' });
        expect(input.segments.slice(1).map(segment => segment.type)).toEqual(['text', 'json']);
        expect(input.segments.at(-1)).toMatchObject({ container: 'object', source: expect.stringContaining('"required":["term"]') });
        expect(output.segments).toEqual([expect.objectContaining({ type: 'json', source: '{"term":"x"}' })]);
    });

    it('shows the values an ask block references as foldable payloads after its instruction', async () => {
        const { logger, events } = collecting('error');
        const model = scripted('Fine');
        await exec(`const invoice = { total: 12 };\nconst tags = ['a'];\n${block('Sum up @invoice with @tags', 'outputVar: summary')}`, { logger, backend: model });
        expect(events[0]).toMatchObject({ kind: 'model-input', interaction: { kind: 'ask' } });
        expect(events[0].segments).toEqual([
            { type: 'text', text: 'Sum up @invoice with @tags\n\nValues referenced above, as JSON:\n@invoice = ' },
            expect.objectContaining({ type: 'json', container: 'object', source: '{"total":12}' }),
            { type: 'text', text: '\n@tags = ' },
            expect.objectContaining({ type: 'json', container: 'array', source: '["a"]' }),
        ]);
        expect(text(events[0])).toBe(model.calls[0].prompt);
    });

    it('groups agent block instructions, inputs and outputs, leaving the instruction and completed actions visible', async () => {
        const { logger, events } = collecting('error');
        const agent = acting(save('answer', 2));
        const source = `---\nenforce: File guidance.\n---\nconst original = { value: 1 };\n${agentBlock('Double @original.value ->[Int] @answer')}\nsuccess(answer);`;
        expect(await exec(source, { logger, backend: agent })).toMatchObject({ status: 'success', value: 2 });
        const inputs = modelEvents(events, 'model-input');
        expect(inputs).toHaveLength(1);
        expect(inputs[0]).toMatchObject({ interaction: { kind: 'agent' } });
        const preface = inputs[0].segments[0];
        if (preface.type !== 'preface') throw new Error('expected generated preface');
        expect(preface.source.startsWith(`Response guidance (not runtime validation):\n- Follow: File guidance.\n\n${AGENT_PREAMBLE}`)).toBe(true);
        expect(preface.source).toContain('Inputs:\n- @original.value: number');
        expect(preface.source).toContain('Outputs to save:\n- @answer: Int, JSON Schema {"type":"integer"}');
        expect(preface.source).not.toContain('"value":1');
        expect(preface.source).not.toContain('Double @original.value');
        expect(formatSegments(inputs[0].segments.slice(1))).toBe('\n\nInstruction:\nDouble @original.value ->[Int] @answer\n\nCompleted actions and their results:\n[]');
        expect(text(inputs[0])).toBe(agent.calls[0].prompt);
    });

    it('folds header guidance and restrictions together with the agent block context', async () => {
        const { logger, events } = collecting('error');
        const cwd = tempDir();
        await exec(agentBlock('Tidy up.', 'enforce: Be concise', 'restrict: { fs: ./src }'), { logger, cwd, backend: acting() });
        const preface = events[0].segments[0];
        if (preface.type !== 'preface') throw new Error('expected generated preface');
        expect(preface.source).toContain('- Follow: Be concise');
        expect(preface.source).toContain(`File system: you may read and write only inside: ${path.join(cwd, 'src')}.`);
        expect(preface.source.indexOf('- Follow: Be concise')).toBeLessThan(preface.source.indexOf(AGENT_PREAMBLE));
        expect(preface.source.endsWith('Inputs:\n(none)\n\nOutputs to save:\n(none)')).toBe(true);
        expect(formatSegments(events[0].segments.slice(1))).toBe('\n\nInstruction:\nTidy up.\n\nCompleted actions and their results:\n[]');
    });

    it.each([
        ["const answer = await codegen('Define answer()');\nsuccess(answer());", 'Define answer()'],
        [`${block('Define -> @answer(): unknown[]', 'mode: codegen')}\nsuccess(answer());`, 'Define -> @answer(): unknown[]'],
    ])('logs codegen as its own interaction with a folded guide and a JavaScript code segment: %s', async (workflow, description) => {
        const { logger, events, streams } = recording();
        const source = 'function answer() {\n    return [1,2,{"not":"folded"}];\n}';
        const result = await exec(workflow, {
            logger, backend: backend(request => {
                request.onStream?.({ channel: 'response', messageId: 'code', mode: 'append', text: 'function answer(' });
                return { text: source, effective: {} };
            }),
        });
        expect(result).toMatchObject({ status: 'success', value: [1, 2, { not: 'folded' }] });
        expect(streams.map(event => [event.type, event.interaction.kind])).toEqual([['update', 'codegen'], ['end', 'codegen']]);
        const [input, output] = events;
        expect(input).toMatchObject({ kind: 'model-input', interaction: { kind: 'codegen', requestId: streams[0].interaction.requestId } });
        expect(input.segments[0]).toMatchObject({ type: 'preface', source: `${CODEGEN_PREAMBLE}\n\nInputs in scope:\n{}` });
        expect(input.segments.slice(1)).toEqual([{ type: 'text', text: `\n\nFunction description:\n${description}` }]);
        expect(output).toMatchObject({ kind: 'model-output', interaction: { kind: 'codegen', role: 'response' } });
        expect(output.segments).toEqual([{ type: 'code', language: 'javascript', source }]);
    });

    it('logs generated code that is reused from the cache without a model call', async () => {
        const directory = tempDir();
        const file = path.join(directory, 'flow.spl');
        const source = `${block('Twice a number -> @twice(n: number): number', 'mode: codegen')}\nsuccess(twice(21));`;
        fs.writeFileSync(file, source);
        const code = 'function twice(n) {\n    return n * 2;\n}';
        const first = collecting('info');
        expect(await exec(source, { logger: first.logger, backend: scripted(code), file, cwd: directory })).toMatchObject({ value: 42 });
        const cache = path.join(directory, 'flow.twice.js');
        expect(outline(first.events)).toEqual(['model-input codegen -', 'info', 'model-output codegen response', 'info']);
        expect(text(first.events[3])).toBe(`codegen saved ${cache}`);
        const again = collecting('info');
        expect(await exec(source, { logger: again.logger, file, cwd: directory })).toMatchObject({ value: 42 });
        expect(outline(again.events)).toEqual(['info', 'model-output codegen response']);
        expect(text(again.events[0])).toBe(`codegen reusing ${cache}`);
        expect(again.events[1].segments).toEqual([{ type: 'code', language: 'javascript', source: fs.readFileSync(cache, 'utf8') }]);
    });

    it('rejects mismatched prefaces instead of silently truncating the prompt', () => {
        expect(() => new Logger('info', vi.fn()).modelPrompt(
            { kind: 'ask', requestId: 'invalid' }, 'actual prompt', 'unrelated preface',
        )).toThrow('model prompt must start with its generated preface');
    });
});

describe('agent block transcripts', () => {
    it('logs each runtime action as an action output of the call that requested it, before the final response', async () => {
        const { logger, events } = collecting('info');
        const result = await exec(`const notes = ["a"];\n${agentBlock('Count @notes into ->[Int] @count')}\nsuccess(count);`, {
            logger, backend: backend(async request => {
                const notes = await request.invokeAction!(action('loadVariable', { name: 'notes' })) as unknown[];
                await request.invokeAction!(save('count', notes.length));
                return { text: 'Saved.', effective: { model: 'fake' } };
            }),
        });
        expect(result).toMatchObject({ status: 'success', value: 1 });
        expect(outline(events)).toEqual([
            'model-input agent -', 'model-output agent action', 'model-output agent action', 'info', 'model-output agent response',
        ]);
        const models = events.filter(event => event.origin === 'model');
        expect(new Set(models.map(event => event.interaction.requestId)).size).toBe(1);
        expect(formatEvent(events[1])).toBe('<- output agent action {\n  "name": "loadVariable",\n  "arguments": {\n    "name": "notes"\n  }\n}');
        expect(text(events[2])).toBe('{"name":"saveVariable","arguments":{"name":"count","value":1}}');
        expect(text(events[3])).toMatch(/^llm agent call:\n\{"model":"fake"\} \(\d+ ms\)$/);
        expect(formatEvent(events[4])).toBe('<- output agent Saved.');
    });

    it('logs the failing action and the located error without inventing a response', async () => {
        const { logger, lines } = printing('error');
        const result = await exec(`const secret = 1;\n\n${agentBlock('Load the secret')}`, {
            logger, backend: acting(action('loadVariable', { name: 'secret' })),
        });
        expect(result).toMatchObject({ status: 'failure', failure: { status_code: 'runtime_error', line: 3, command: 'Load the secret' } });
        expect(lines.map(line => line.split(' ').slice(0, 4).join(' '))).toEqual([
            '-> input agent You', '<- output agent action', 'x error runtime_error: @secret',
        ]);
        expect(lines.at(-1)).toBe('x error runtime_error: @secret is not referenced in this block; an agent reaches only the names its instruction mentions (line 3)');
    });

    it('logs rejected saves, their corrections and a block that ends without an output', async () => {
        const { logger, events } = collecting('error');
        const source = agentBlock('Count ->[Int] @count and name it -> @label');
        const result = await exec(source, { logger, backend: acting(save('count', 'three'), save('count', 3)) });
        expect(result).toMatchObject({ status: 'failure', failure: { status_code: 'validation_failed', reason: 'agent did not produce @label', line: 1 } });
        expect(outline(events)).toEqual(['model-input agent -', 'model-output agent action', 'model-output agent action', 'model-output agent response', 'error']);
        expect(events.slice(1, 3).map(event => JSON.parse(text(event)).arguments.value)).toEqual(['three', 3]);
        expect(text(events[4])).toBe('validation_failed: agent did not produce @label (line 1)');
    });

    it('logs the tools an agent uses and the model calls of the functions it calls, inside its transcript', async () => {
        const { logger, events } = collecting('info');
        const cwd = tempDir();
        const source = [
            'async function title(topic: string) {', "    return ask('Title for ' + topic);", '}',
            agentBlock('Write a note with a @title -> @note'),
        ].join('\n');
        const model = backend(async request => {
            if (!request.runtimeTools) return { text: 'Pears', effective: {} };
            const title = await request.invokeAction!(action('callFunction', { name: 'title', args: ['fruit'] }));
            await request.invokeAction!(action('writeFile', { path: 'note.md', content: `# ${title}\n` }));
            await request.invokeAction!(save('note', title));
            return { text: 'Written.', effective: {} };
        });
        expect(await exec(source, { logger, cwd, backend: model })).toMatchObject({ status: 'success' });
        expect(outline(events)).toEqual([
            'model-input agent -',
            'model-output agent action', 'model-input ask -', 'info', 'model-output ask response',
            'model-output agent action', 'tool',
            'model-output agent action', 'info', 'model-output agent response',
        ]);
        expect(events[6]).toMatchObject({ tool: { name: 'writeFile', target: 'note.md', status: 'success' } });
        expect(formatEvent(events[6])).toBe('* tool writeFile note.md\n# Pears\n');
        const requests = events.filter(event => event.origin === 'model').map(event => [event.interaction.kind, event.interaction.requestId]);
        expect(new Set(requests.filter(([kind]) => kind === 'agent').map(([, id]) => id)).size).toBe(1);
        expect(new Set(requests.map(([, id]) => id)).size).toBe(2);
    });
});

describe.each(['error', 'info', 'debug', 'silent'] as const)('LLM logging at %s', level => {
    it.each(['ask', 'agent'])('logs the full %s request and raw response unless silent', async kind => {
        const { logger, lines } = printing(level);
        const requests: LlmRequest[] = [];
        const reply = '  First line\nSecond line\n  ';
        const result = await exec(`success(await enforce('Be precise', () => ${kind}('${kind} prompt')));`, {
            logger, backend: backend(request => {
                requests.push(request);
                return { text: reply, effective: { model: 'test-model' } };
            }),
        });
        expect(result).toMatchObject({ status: 'success', value: reply.trim() });
        expect(requests).toHaveLength(1);
        expect(requests[0].prompt).toContain('Follow: Be precise');
        if (level === 'silent') {
            expect(lines).toEqual([]);
        } else {
            expect(lines[0]).toBe(`-> input ${kind} ${requests[0].prompt}`);
            expect(lines.at(-1)).toBe(`<- output ${kind} ${reply}`);
            expect(lines.some(line => line.startsWith(`i info llm ${kind} call:\n{\n  "model": "test-model"\n} (`))).toBe(level !== 'error');
            expect(lines).toHaveLength(level === 'error' ? 2 : 3);
        }
    });

    it('logs failed requests and errors without inventing a response', async () => {
        const { logger, lines } = printing(level);
        const failing: LlmBackend = { async call() { throw new LlmError('backend unavailable'); }, async close() {} };
        const result = await exec("\nsuccess(await ask('Failing prompt'));", { logger, backend: failing });
        expect(result).toMatchObject({ status: 'failure', failure: { status_code: 'llm_error', line: 2 } });
        expect(lines).toEqual(level === 'silent' ? [] : ['-> input ask Failing prompt', 'x error llm_error: backend unavailable (line 2)']);
    });

    it('never traces executed deterministic source, including loop iterations', async () => {
        const { logger, lines } = printing(level);
        const result = await exec(`let n = 0;
for (const i of [1, 2]) {
    n += i;
}
if (false) fail('unreachable');
success(n);`, { logger });
        expect(result).toMatchObject({ status: 'success', value: 3 });
        expect(lines.some(line => /deterministic|line \d+ \(|let n|n \+=|if \(false\)|success\(n\)/.test(line))).toBe(false);
        expect(lines.filter(line => !line.startsWith('~ state'))).toEqual([]);
    });
});

describe('trace replay', () => {
    const source = [
        "log('before');", "const n = await ask('Number?', { fmt: 'integer', repairs: 1 });", "log.error('between', n);",
        agentBlock('Save @n to ->[Int] @saved'),
        "log('after', saved);", 'success(saved);',
    ].join('\n');
    const live = (): LlmBackend => {
        const replies = ['"bad"', '7'];
        return backend(async request => {
            request.onStream?.({ channel: 'response', messageId: 'preview', mode: 'append', text: 'partial' });
            if (!request.runtimeTools) return { text: replies.shift()!, effective: {} };
            await request.invokeAction!(save('saved', 7));
            return { text: 'Saved.', effective: {} };
        });
    };
    async function traced(cwd: string, model: LlmBackend, logger: Logger) {
        const trace = Trace.open(path.join(cwd, 'run.jsonl'), { source, runtime: 'test', cwd });
        try {
            const result = await run(source, { backend: model, logger, cwd, trace });
            trace.finish(result);
            return result;
        } finally {
            trace.close();
        }
    }

    it('logs nothing for replayed effects and resumes once the recorded history is exhausted', async () => {
        const cwd = tempDir();
        const first = recording('info');
        const result = await traced(cwd, live(), first.logger);
        expect(result).toMatchObject({ status: 'success', value: 7 });
        expect(first.events.filter(event => event.origin === 'script').map(text)).toEqual(['log: before', 'log: between 7', 'log: after 7']);
        expect(modelEvents(first.events, 'model-input')).toHaveLength(3);
        expect(modelEvents(first.events, 'model-output').map(event => event.interaction.role)).toEqual(['response', 'response', 'action', 'response']);
        expect(first.events.some(event => text(event).startsWith('repair 1/1'))).toBe(true);
        expect(first.streams.map(event => event.type)).toEqual(['update', 'end', 'update', 'end', 'update', 'end']);

        const replay = recording('info');
        expect(await traced(cwd, new NoLlm(), replay.logger)).toEqual(result);
        expect(replay.events.map(event => [event.origin, text(event)])).toEqual([['script', 'log: after 7']]);
        expect(replay.streams).toEqual([]);
    });

    it('does not report state changes made while effects are still being replayed', async () => {
        const cwd = tempDir();
        await traced(cwd, live(), new Logger('silent'));
        const replay = recording('debug');
        await traced(cwd, new NoLlm(), replay.logger);
        expect(states(replay.events).filter(line => line.startsWith('n @'))).toEqual([]);
    });

    it('does not report state changes made while replaying recorded effects', async () => {
        const cwd = tempDir();
        await traced(cwd, live(), new Logger('silent'));
        const replay = recording('debug');
        await traced(cwd, new NoLlm(), replay.logger);
        expect(replay.events.filter(event => event.kind === 'state')).toEqual([]);
    });
});

describe('state logs', () => {
    const observed = async (source: string, options: Parameters<typeof exec>[1] = {}) => {
        const { logger, events } = collecting('debug');
        const result = await exec(source, { logger, ...options });
        return { result, events, states: states(events) };
    };

    it('report top-level variables when they are initialized, rebound or mutated', async () => {
        const { result, events, states } = await observed([
            'let count = 1;', 'count = count;', 'count += 1;', 'const items = [1];', 'const alias = items;', 'alias.push(2);', 'success(count);',
        ].join('\n'));
        expect(result).toMatchObject({ status: 'success', value: 2 });
        expect(states).toEqual([
            'count @ global (scope-1): <unbound> -> 1',
            'count @ global (scope-1): 1 -> 2',
            'items @ global (scope-1): <unbound> -> [1]',
            'alias @ global (scope-1): <unbound> -> [1]',
            'items @ global (scope-1): [1] -> [1,2]',
            'alias @ global (scope-1): [1] -> [1,2]',
        ]);
        const changes = events.flatMap(event => event.kind === 'state' ? [event.change] : []);
        expect(changes.map(change => change.operation)).toEqual(['initialize', 'rebind', 'initialize', 'initialize', 'mutation', 'mutation']);
        expect(changes[0].bindings[0]).toEqual({
            binding: { scopeId: 'scope-1', kind: 'global', label: 'global', bindingId: 'scope-1:count', name: 'count' },
            previous: { presence: 'unbound' }, next: { presence: 'value', valueKind: 'scalar', display: '1' },
        });
        const reference = changes[2].bindings[0].next;
        expect(reference).toMatchObject({ valueKind: 'list', referenceId: expect.stringMatching(/^ref-\d+$/) });
        expect(changes[4]).toMatchObject({ targetReferenceId: reference.presence === 'value' && reference.referenceId, path: 'items' });
        expect(changes[5]).toMatchObject({ targetReferenceId: changes[4].targetReferenceId, path: 'alias' });
        expect(events.every(event => event.kind === 'state' && event.origin === 'state' && Object.isFrozen(event.change))).toBe(true);
    });

    it('report the outputs of top-level blocks as top-level variables, including assigned ones', async () => {
        const source = [
            'let total = 1;',
            block('How many?', 'outputVar: =total', 'outputType: Int'),
            agentBlock('Name it -> @label and list ->[List(Str)] @tags'),
            block('Shout -> @shout(text: string): string', 'mode: codegen'),
            'const loud = shout(label);',
        ].join('\n');
        const model = backend(async request => {
            if (request.runtimeTools) {
                await request.invokeAction!(save('label', 'two'));
                await request.invokeAction!(save('tags', ['a']));
                return { text: 'Done', effective: {} };
            }
            return { text: request.prompt.includes('How many?') ? '2' : 'function shout(text) { return text.toUpperCase(); }', effective: {} };
        });
        const { result, states } = await observed(source, { backend: model });
        expect(result).toMatchObject({ status: 'success' });
        expect(states).toEqual([
            'total @ global (scope-1): <unbound> -> 1',
            'total @ global (scope-1): 1 -> 2',
            'label @ global (scope-1): <unbound> -> "two"',
            'tags @ global (scope-1): <unbound> -> ["a"]',
            'shout @ global (scope-1): <unbound> -> "<function shout(text) ref-2>"',
            'loud @ global (scope-1): <unbound> -> "TWO"',
        ]);
    });

    it('report the outputs of nested blocks with the line of their block, and never the locals around them', async () => {
        const source = [
            'async function describe(item: string) {',
            '    let local = item.length;',
            '    ---', '    outputVar: summary', '', '    Describe @item', '    ---',
            '    local++;',
            '    return `${summary} (${local})`;',
            '}',
            'const seen: string[] = [];',
            'for (const item of ["pear", "fig"]) {',
            '    const before = seen.length;',
            '    ---', '    mode: agent', '', '    Rate @item ->[Int] @stars and say why -> @why', '    ---',
            '    seen.push(`${await describe(item)} ${stars} ${why} ${before}`);',
            '}',
        ].join('\n');
        const model = backend(async request => {
            if (!request.runtimeTools) return { text: 'A fruit.', effective: {} };
            await request.invokeAction!(save('stars', 5));
            await request.invokeAction!(save('why', { taste: 'sweet' }));
            return { text: 'Done', effective: {} };
        });
        const { result, events, states } = await observed(source, { backend: model });
        expect(result).toMatchObject({ status: 'success' });
        const nested = [
            'stars @ block at line 14 (block-14): <unbound> -> 5',
            'why @ block at line 14 (block-14): <unbound> -> {"taste":"sweet"}',
            'summary @ block at line 3 (block-3): <unbound> -> "A fruit."',
        ];
        expect(states).toEqual([
            'describe @ global (scope-1): <unbound> -> "<async function describe(item) ref-1>"',
            'seen @ global (scope-1): <unbound> -> []',
            ...nested,
            // Top-level variables are compared before every block too, wherever it sits.
            'seen @ global (scope-1): [] -> ["A fruit. (5) 5 [object Object] 0"]',
            ...nested,
            'seen @ global (scope-1): ["A fruit. (5) 5 [object Object] 0"] -> ["A fruit. (5) 5 [object Object] 0","A fruit. (4) 5 [object Object] 1"]',
        ]);
        expect(states.join('\n')).not.toMatch(/\b(?:local|before|item) @/);
        const output = events.find(event => event.kind === 'state' && event.change.bindings[0].binding.kind === 'block')!;
        expect(output).toMatchObject({ change: { operation: 'initialize', bindings: [{
            binding: { scopeId: 'block-14', kind: 'block', label: 'block at line 14', bindingId: 'block-14:stars', name: 'stars' },
            previous: { presence: 'unbound' }, next: { presence: 'value', valueKind: 'scalar', display: '5' },
        }] } });
        // Each output is reported after its block's transcript and before the next model call.
        expect(outline(events).filter(kind => kind !== 'info').slice(2, 11)).toEqual([
            'model-input agent -', 'model-output agent action', 'model-output agent action', 'model-output agent response', 'state', 'state',
            'model-input ask -', 'model-output ask response', 'state',
        ]);
    });

    it('report only the variables the workflow declares, never those of generated code', async () => {
        const source = `let total = 0;\n${agentBlock('Count ->[Int] @=total and name it -> @label')}`;
        const { states } = await observed(source, { backend: acting(save('total', 1), save('label', 'one')) });
        expect(states).toEqual([
            'total @ global (scope-1): <unbound> -> 0',
            'total @ global (scope-1): 0 -> 1',
            'label @ global (scope-1): <unbound> -> "one"',
        ]);
    });

    it('leave out variables that are not assigned yet and changes nobody can see', async () => {
        const { states } = await observed('const first = 1;\nlet later: number | undefined;\nlet unset;\nlater = undefined;\nconst last = [first];\nlast.length = 1;');
        expect(states).toEqual(['first @ global (scope-1): <unbound> -> 1', 'last @ global (scope-1): <unbound> -> [1]']);
    });

    it.each(['error', 'info', 'silent'] as const)('are not produced at %s level, where workflows are not instrumented', async level => {
        const { logger, events } = recording(level);
        const steps: number[] = [];
        const result = await exec('let count = 1;\ncount++;\nsuccess(count);', { logger });
        expect(result).toMatchObject({ status: 'success', value: 2 });
        expect(events).toEqual([]);
        await exec('let count = 1;\ncount++;', { logger, beforeStep: step => { steps.push(step.line); } });
        expect(steps).toEqual([1, 2]);
        expect(events).toEqual([]);
    });
});

it('distinguishes all event directions and categories with single bold colored headers', () => {
    const lines: string[] = [];
    const logger = new Logger('debug', line => lines.push(line), { color: true });
    const interaction = { kind: 'ask', requestId: 'request-1' } as const;
    logger.modelPrompt(interaction, 'one\ntwo', '');
    logger.modelOutput(interaction, 'three\nfour');
    logger.error('error');
    logger.warn('warning');
    logger.info('info');
    logger.debug('debug');
    logger.state(() => ({ operation: 'initialize', bindings: [{
        binding: { bindingId: 's1:n', name: 'n', scopeId: 's1', kind: 'global', label: 'global' },
        previous: { presence: 'unbound' }, next: { presence: 'value', valueKind: 'scalar', display: '1' },
    }] }));
    logger.info('log:', 'script body');
    logger.modelOutput({ ...interaction, role: 'action' }, 'action body');
    logger.modelOutput({ kind: 'agent', requestId: 'request-2', role: 'response' }, 'reply');
    logger.modelPrompt({ kind: 'codegen', requestId: 'request-3' }, 'describe', '');
    logger.tool(describeToolCall('shell', { command: 'git status' }, { output: 'clean' }));
    logger.tool(describeToolCall('shell', { command: 'git push' }, { error: 'denied' }));
    const headers = [['-> input ask', 35], ['<- output ask', 36], ['x error', 31], ['! warning', 33],
        ['i info', 34], ['. debug', 90], ['~ state', 33], ['[info]', 34], ['<- output ask action', 36],
        ['<- output agent', 36], ['-> input codegen', 35], ['* tool shell', 32], ['* tool shell failed', 31]];
    expect(lines).toHaveLength(headers.length);
    headers.forEach(([header, color], index) => {
        expect(lines[index].startsWith(`\u001b[1;${color}m${header}\u001b[0m `)).toBe(true);
        expect(stripVTControlCharacters(lines[index]).split(String(header))).toHaveLength(2);
        expect(lines[index].match(/\u001b\[1;/g)).toHaveLength(1);
    });
});

it('preserves ordinary severity filtering', () => {
    const { logger, lines } = printing('error');
    logger.info('hidden info');
    logger.warn('hidden warning');
    logger.debug('hidden debug');
    logger.error('visible error');
    logger.modelOutput({ kind: 'ask', requestId: 'request' }, 'visible transcript');
    expect(lines).toEqual(['x error visible error', '<- output ask visible transcript']);
});

describe('console formatting', () => {
    it('uses one header for each multiline event across all log categories', () => {
        const { logger, lines } = printing('debug');
        for (const tag of ['error', 'warn', 'info', 'debug'] as const) {
            logger[tag]('First\r\nSecond\rThird');
        }
        expect(lines).toEqual(['error', 'warn', 'info', 'debug']
            .map(tag => tagged(tag, 'First\nSecond\nThird')));
    });

    it('pretty-prints structured JSON and serialized JSON without changing their values', () => {
        const { logger, lines } = printing();
        const value = { findings: [{ severity: 'high', title: 'Quotes " and slashes \\ and {}[]' }], count: 1, ok: true, extra: null, empty: [] };
        logger.info('review:', value);
        logger.error('llm response:', JSON.stringify(value));
        expect(lines).toEqual([
            tagged('info', `review:\n${JSON.stringify(value, null, 2)}`),
            tagged('error', `llm response:\n${JSON.stringify(value, null, 2)}`),
        ]);
    });

    it('preserves original JSON number lexemes and duplicate keys', () => {
        const { logger, lines } = printing();
        logger.info('{"large":9007199254740993,"negative":-0,"exponent":1.20e+03,"key":1,"key":2}');
        expect(lines[0]).toBe(tagged('info', `{
  "large": 9007199254740993,
  "negative": -0,
  "exponent": 1.20e+03,
  "key": 1,
  "key": 2
}`));
    });

    it('recognizes JSON payloads in existing labeled string messages', () => {
        const { logger, lines } = printing();
        logger.info('review: {"count":1,"findings":[]}');
        logger.info('review:\n{\n"count":1,"findings":[]\n}');
        const expected = tagged('info', 'review:\n{\n  "count": 1,\n  "findings": []\n}');
        expect(lines).toEqual([expected, expected]);
    });

    it('formats standalone JSON lines inside messages and model output but leaves malformed JSON alone', () => {
        const { logger, lines } = printing();
        logger.info('Context:\n{"count":2}\n{"broken":}\nEnd.');
        logger.modelOutput({ kind: 'ask', requestId: 'request' }, 'Context:\n{"count":2}\n{"broken":}\nEnd.');
        expect(lines).toEqual([
            tagged('info', 'Context:\n{\n  "count": 2\n}\n{"broken":}\nEnd.'),
            '<- output ask Context:\n{\n  "count": 2\n}\n{"broken":}\nEnd.',
        ]);
    });

    it('colors tags and individual JSON tokens without changing the plain-text output', () => {
        const plain: string[] = [];
        const colored: string[] = [];
        const value = { key: 'text', number: 42, boolean: false, nothing: null };
        new Logger('info', line => plain.push(line)).info('payload:', value);
        new Logger('info', line => colored.push(line), { color: true }).info('payload:', value);
        expect(stripVTControlCharacters(colored[0])).toBe(plain[0]);
        expect(colored[0]).toContain('\u001b[1;34mi info\u001b[0m');
        expect(colored[0]).toContain('\u001b[36m"key"\u001b[0m');
        expect(colored[0]).toContain('\u001b[32m"text"\u001b[0m');
        expect(colored[0]).toContain('\u001b[33m42\u001b[0m');
        expect(colored[0]).toContain('\u001b[35mfalse\u001b[0m');
        expect(colored[0]).toContain('\u001b[90mnull\u001b[0m');
    });

    it('handles non-JSON values explicitly instead of dropping errors or crashing on cycles', () => {
        const { logger, lines } = printing();
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
        const { logger, lines } = printing();
        logger.info('\u001b[31mplain\u001b[0m');
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
});
