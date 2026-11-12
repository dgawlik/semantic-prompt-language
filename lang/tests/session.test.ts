import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { LogEvent, ModelStreamEvent } from '../src/log-events.js';
import { Logger } from '../src/logger.js';
import { parse, parseInstruction } from '../src/markdown.js';
import { NATURAL_PREAMBLE, RUNTIME_PREAMBLE } from '../src/preamble.js';
import { ExecutionSession } from '../src/workflow.js';
import { NoLlm, acting, action, backend, cleanTemp, scripted, silent, tempDir, text } from './helpers.js';

afterEach(cleanTemp);
const options = { backend: new NoLlm(), logger: silent };

function recording(level: 'error' | 'info' | 'debug' = 'info') {
    const events: LogEvent[] = [];
    const streams: ModelStreamEvent[] = [];
    const logger = new Logger(level, undefined, { eventSink: event => events.push(event), streamSink: event => streams.push(event) });
    return { events, streams, logger };
}
const streaming = (reply: string) => backend(request => {
    request.onStream?.({ channel: 'response', messageId: 'preview', mode: 'append', text: reply.slice(0, 3) });
    return { text: reply, effective: {} };
});
const requestIds = (events: LogEvent[]) => new Set(events.filter(event => event.origin === 'model').map(event => event.interaction.requestId));

describe('per-run options of interactive sessions', () => {
    it('routes logs, model transcripts and stream previews of retained closures to the current run', async () => {
        const session = new ExecutionSession();
        const first = recording();
        await session.run(parse("const consult = async prompt => {\n    log('asking', prompt);\n    return ask(prompt);\n};"), { backend: new NoLlm(), logger: first.logger });
        const second = recording();
        expect(await session.run(parse("await consult('Why?')"), { backend: streaming('Because.'), logger: second.logger }))
            .toEqual({ status: 'success', hasValue: true, value: 'Because.' });
        expect(first.events).toEqual([]);
        expect(first.streams).toEqual([]);
        expect(second.events.map(event => [event.kind, event.origin])).toEqual([['info', 'script'], ['model-input', 'model'], ['info', 'diagnostic'], ['model-output', 'model']]);
        expect(text(second.events[0])).toBe('log: asking Why?');
        expect(text(second.events[1])).toBe('Why?');
        expect(second.events.map(event => event.sequence)).toEqual([1, 2, 3, 4]);
        expect(second.streams.map(event => event.type === 'update' ? event.update.text : event.outcome)).toEqual(['Bec', 'completed']);
        const third = recording();
        await session.run(parse("await consult('Again?')"), { backend: streaming('Still.'), logger: third.logger });
        expect(second.events).toHaveLength(4);
        expect(second.streams).toHaveLength(2);
        expect(third.events.map(event => event.sequence)).toEqual([1, 2, 3, 4]);
        expect(text(third.events[3])).toBe('Still.');
        expect(new Set([...requestIds(second.events), ...requestIds(third.events)]).size).toBe(2);
    });

    it('gives retained functions the arguments, human handler, working directory and restrictions of the current run', async () => {
        const session = new ExecutionSession();
        const [one, two] = [tempDir(), tempDir()];
        fs.writeFileSync(path.join(one, 'note.txt'), 'first');
        fs.writeFileSync(path.join(two, 'note.txt'), 'second');
        await session.run(parse("const reader = readFile;\nconst print = log;\nconst probe = async () => [args[0], await human('Who?'), await reader('./note.txt')];"), { ...options, cwd: one });
        expect(await session.run(parse('await probe()'), { ...options, cwd: one, args: ['a'], human: () => 'Ada' })).toMatchObject({ value: ['a', 'Ada', 'first'] });
        expect(await session.run(parse('await probe()'), { ...options, cwd: two, args: ['b'], human: () => 'Bob' })).toMatchObject({ value: ['b', 'Bob', 'second'] });
        expect(await session.run(parse('await probe()'), { ...options, cwd: two })).toMatchObject({ failure: { reason: 'human input requires a human handler' } });
        expect(await session.run(parse("await restrict('./out', () => reader('./note.txt'))"), { ...options, cwd: two })).toMatchObject({
            status: 'failure', failure: { status_code: 'restriction_violation', line: 1 },
        });
        expect(await session.run(parse("await reader('./note.txt')"), { ...options, cwd: two })).toMatchObject({ value: 'second' });
        const lines: string[] = [];
        await session.run(parse("print('current cell')"), { backend: new NoLlm(), logger: new Logger('info', line => lines.push(line)) });
        expect(lines).toEqual(['[info] log: current cell']);
    });

    it('uses the cell model unless the call or the run overrides it, and erases types in TypeScript cells', async () => {
        const session = new ExecutionSession();
        const model = scripted('a', 'b', 'c', 'd');
        const run = (code: string, extra = {}) => session.run(parse(code, { language: 'ts', model: 'cell-model' }), { backend: model, logger: silent, ...extra });
        await run("const first: string = await ask('One');\ninterface Unused { field: number }");
        await run("await ask('Two', { model: 'call-model' })");
        await run("await ask('Three', { model: 'call-model' })", { model: 'override' });
        await session.run(parse("await ask('Four')"), { backend: model, logger: silent });
        expect(model.calls.map(call => call.model)).toEqual(['cell-model', 'call-model', 'override', undefined]);
        expect(model.calls[0].prompt).toBe('One');
        expect(await session.run(parse('first'), options)).toMatchObject({ value: 'a' });
    });

    it('logs a failing run once to its own logger, and lets a later cell end with success()', async () => {
        const session = new ExecutionSession();
        const lines: string[] = [];
        const result = await session.run(parse("const kept = 1;\nfail('stop');"), {
            backend: new NoLlm(), logger: new Logger('error', line => lines.push(line)), source: 'cell:1', sourceVersion: 2,
        });
        expect(result).toMatchObject({ status: 'failure', failure: { reason: 'stop', source: 'cell:1', source_version: 2 } });
        expect(lines).toEqual(['x error explicit_failure: stop (line 2)']);
        expect(await session.run(parse('missing'), { ...options, source: 'cell:2' })).toMatchObject({
            failure: { reason: 'ReferenceError: missing is not defined', line: 1, command: 'missing', source: 'cell:2' },
        });
        expect(await session.run(parse("success(kept + 1);\nfail('unreachable');"), options)).toEqual({ status: 'success', value: 2, hasValue: true });
        expect(await session.run(parse('kept'), options)).toMatchObject({ status: 'success', value: 1 });
        expect(lines).toHaveLength(1);
    });

    it('keeps generated functions for later cells', async () => {
        const session = new ExecutionSession();
        const model = scripted('function double(value) {\n    return value * 2;\n}', 'function triple(value) {\n    return value * 3;\n}');
        expect(await session.run(parse("const twice = await codegen('Define double(value)');\ntwice(2)"), { backend: model, logger: silent })).toMatchObject({ value: 4 });
        expect(await session.run(parseInstruction("@CODEGEN 'Define triple(value)'"), { backend: model, logger: silent }))
            .toEqual({ status: 'success', value: null, hasValue: false });
        expect(await session.run(parse('[double(4), triple(4), twice === double]'), options)).toMatchObject({ value: [8, 12, true] });
        expect(model.calls[1].prompt).toContain('"double":"function double(value)"');
        expect(session.bindings).toEqual(expect.arrayContaining(['twice', 'double', 'triple']));
    });
});

describe('failure sources across cells', () => {
    it('retains the original source version for aliases of redefined functions', async () => {
        const session = new ExecutionSession();
        await session.run(parse("function broken() {\n    fail('old');\n}\nconst old = broken;"), { ...options, source: 'cell:definition', sourceVersion: 1 });
        await session.run(parse("\nfunction broken() {\n    fail('new');\n}"), { ...options, source: 'cell:definition', sourceVersion: 2 });
        expect(await session.run(parse('old()'), { ...options, source: 'cell:caller', sourceVersion: 3 })).toMatchObject({
            status: 'failure', failure: { reason: 'old', line: 2, command: "fail('old');", source: 'cell:definition', source_version: 1 },
        });
        expect(await session.run(parse('broken()'), { ...options, source: 'cell:caller', sourceVersion: 3 })).toMatchObject({
            status: 'failure', failure: { reason: 'new', line: 3, command: "fail('new');", source: 'cell:definition', source_version: 2 },
        });
    });

    it('tells apart cells whose names share a prefix', async () => {
        const session = new ExecutionSession();
        await session.run(parse("const one = () => fail('from cell 1');"), { ...options, source: 'cell:1' });
        await session.run(parse("\n\nconst ten = () => fail('from cell 10');"), { ...options, source: 'cell:10' });
        expect(await session.run(parse('ten()'), { ...options, source: 'cell:100' })).toMatchObject({ failure: { reason: 'from cell 10', line: 3, source: 'cell:10' } });
        expect(await session.run(parse('one()'), { ...options, source: 'cell:100' })).toMatchObject({ failure: { reason: 'from cell 1', line: 1, source: 'cell:1' } });
    });

    it('locates the failure of a function called by a later blockquote cell in the defining cell', async () => {
        const session = new ExecutionSession();
        await session.run(parse("function broken() {\n    fail('original');\n}\nconst nested = async () => broken();"), { ...options, source: 'cell:definition', sourceVersion: 4 });
        const result = await session.run(parseInstruction('Call @nested'), {
            logger: silent, backend: acting(action('call_function', { name: 'nested', args: [] })), source: 'cell:quote', sourceVersion: 1,
        });
        expect(result).toEqual({ status: 'failure', failure: {
            status: 'failure', status_code: 'explicit_failure', reason: 'original', line: 2, command: "fail('original');",
            source: 'cell:definition', source_version: 4,
        } });
    });

    it('reports the instruction cell itself when one of its agent actions fails', async () => {
        const session = new ExecutionSession();
        const result = await session.run(parseInstruction('Load @missing\nand report it'), {
            logger: silent, backend: acting(action('load_variable', { name: 'missing' })), source: 'cell:quote', sourceVersion: 3,
        });
        expect(result).toEqual({ status: 'failure', failure: {
            status: 'failure', status_code: 'runtime_error', reason: "name 'missing' is not defined", line: 1, command: 'Load @missing',
            source: 'cell:quote', source_version: 3,
        } });
        expect(await session.run(parse('1 + 1'), options)).toMatchObject({ value: 2 });
    });
});

describe('blockquote cells', () => {
    it('shares state with instruction cells through the agent runtime', async () => {
        const session = new ExecutionSession();
        await session.run(parse('let count = 2;\nfunction double(x) { return x * 2; }'), options);
        let turn = 0;
        const model = backend(request => {
            expect(request.prompt).toContain('"count":2');
            return { text: 'Done', effective: {}, ...(turn++ === 0 ? { action: action('save_variable', { name: 'count', value: 4 }) } : {}) };
        });
        expect(await session.run(parseInstruction('Double @count.'), { logger: silent, backend: model })).toEqual({ status: 'success', value: null, hasValue: false });
        expect(turn).toBe(2);
        expect(await session.run(parse('double(count)'), options)).toMatchObject({ value: 8 });
    });

    it('runs an instruction cell with its own model, preamble and @CTL settings', async () => {
        const session = new ExecutionSession();
        const model = acting(action('save_variable', { name: 'summary', value: 'short' }));
        const run = (source: string, extra = {}) => session.run(parseInstruction(source, { model: 'cell-model', preamble: 'Notebook guidance.' }), { logger: silent, backend: model, ...extra });
        expect(await run("@CTL(enforce='Be concise', reasoning='low')\nSummarize into @summary")).toMatchObject({ status: 'success', hasValue: false });
        expect(model.calls[0]).toMatchObject({ kind: 'agent', naturalLanguage: true, model: 'cell-model', reasoningEffort: 'low' });
        expect(model.calls[0].prompt.startsWith(
            `${RUNTIME_PREAMBLE}\n\nNotebook guidance.\n\nResponse guidance (not runtime validation):\n- Follow: Be concise\n\n${NATURAL_PREAMBLE}`,
        )).toBe(true);
        expect(model.calls[0].prompt).toContain('Blockquote:\nSummarize into @summary\n');
        expect(session.bindings).toEqual(['summary']);
        await run("@CTL(model='ctl-model') Again");
        await run("@CTL(model='ctl-model') Again", { model: 'override' });
        await session.run(parseInstruction('Plain'), { logger: silent, backend: model });
        expect(model.calls.slice(1).map(call => call.model)).toEqual(['ctl-model', 'override', undefined]);
        expect(model.calls[3].prompt.startsWith(`${RUNTIME_PREAMBLE}\n\n${NATURAL_PREAMBLE}`)).toBe(true);
        expect(model.calls[3].prompt).toContain('Shared bindings at command start:\n{"summary":"short"}');
        expect(await session.run(parse('summary.length'), options)).toMatchObject({ value: 5 });
    });

    it('returns agent success values and explicit failures from instruction cells, keeping the session alive', async () => {
        const session = new ExecutionSession();
        expect(await session.run(parseInstruction('Finish with @success'), { logger: silent, backend: acting(action('success', { value: [1, 2] })) }))
            .toEqual({ status: 'success', value: [1, 2], hasValue: true });
        expect(await session.run(parseInstruction('Give up with @fail'), { logger: silent, backend: acting(action('fail', { reason: 'no data' })), source: 'cell:quote' })).toMatchObject({
            status: 'failure', failure: { status_code: 'explicit_failure', reason: 'no data', line: 1, command: 'Give up with @fail', source: 'cell:quote' },
        });
        expect(await session.run(parseInstruction('Save @kept'), { logger: silent, backend: acting(action('save_variable', { name: 'kept', value: true })) })).toMatchObject({ status: 'success' });
        expect(await session.run(parse('kept'), options)).toMatchObject({ value: true });
    });

    it('streams and logs an instruction cell through the logger of its run only', async () => {
        const session = new ExecutionSession();
        const earlier = recording();
        await session.run(parse('const count = 2;'), { backend: new NoLlm(), logger: earlier.logger });
        const current = recording();
        const result = await session.run(parseInstruction('Triple @count into @tripled'), {
            logger: current.logger, backend: backend(async request => {
                request.onStream?.({ channel: 'reasoning', messageId: 'why', mode: 'append', text: 'Multiply.' });
                const count = await request.invokeAction!(action('load_variable', { name: 'count' })) as number;
                await request.invokeAction!(action('save_variable', { name: 'tripled', value: count * 3 }));
                request.onStream?.({ channel: 'response', messageId: 'answer', mode: 'append', text: 'Saved' });
                return { text: 'Saved.', reasoning: 'Multiply.', effective: {} };
            }),
        });
        expect(result).toMatchObject({ status: 'success' });
        expect(earlier.events).toEqual([]);
        expect(earlier.streams).toEqual([]);
        expect(current.events.map(event => event.origin === 'model' ? `${event.interaction.kind} ${event.interaction.role ?? 'input'}` : event.kind)).toEqual([
            'blockquote input', 'blockquote action', 'blockquote action', 'info', 'blockquote response',
        ]);
        const preface = current.events[0].segments[0];
        expect(preface).toMatchObject({ type: 'preface', source: expect.stringContaining('Shared bindings at command start:\n{"count":2}') });
        expect(text(current.events[2])).toBe('{"name":"save_variable","arguments":{"name":"tripled","value":6}}');
        expect(current.streams.map(event => event.type === 'update' ? event.update.channel : event.outcome)).toEqual(['reasoning', 'response', 'completed']);
        expect(current.streams.at(-1)).toMatchObject({ interaction: { kind: 'blockquote' }, response: 'Saved.', reasoning: 'Multiply.' });
        expect(requestIds(current.events).size).toBe(1);
        expect(await session.run(parse('tripled'), options)).toMatchObject({ value: 6 });
    });

    it('rejects an instruction cell while another cell is running', async () => {
        const session = new ExecutionSession();
        let finish: (() => void) | undefined;
        const waiting = new Promise<void>(resolve => { finish = resolve; });
        const first = session.run(parseInstruction('Wait'), { logger: silent, backend: backend(async () => { await waiting; return { text: 'Done', effective: {} }; }) });
        await expect(session.run(parseInstruction('Second'), options)).rejects.toThrow(/one cell at a time/);
        finish!();
        expect(await first).toMatchObject({ status: 'success' });
        expect(await session.run(parseInstruction('Third'), { logger: silent, backend: scripted('Done') })).toMatchObject({ status: 'success' });
    });
});
