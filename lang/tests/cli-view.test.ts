import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { CliLogging, canInteract, type MountedUi } from '../src/cli-logging.js';
import { mountTui } from '../src/cli-tui.js';
import { TerminalView, type PausedBlock } from '../src/cli-view.js';
import type { LogEvent } from '../src/log-events.js';
import { Logger } from '../src/logger.js';
import { describeMcpCall, describeToolCall } from '../src/tools.js';
import { run } from '../src/workflow.js';
import { acting, agentBlock, block, save, scripted } from './helpers.js';

function setup(debug = false) {
    const onCancel = vi.fn();
    const view = new TerminalView({ color: false, title: 'flow.spl', debug, onCancel });
    const logger = new Logger('debug', undefined, { eventSink: event => view.append(event), streamSink: event => view.stream(event) });
    const screen = (width = 80, height = 40) => {
        const frame = view.frame(width, height);
        return { ...frame, text: frame.rows.join('\n').trimEnd(), all: [frame.header, ...frame.rows, ...frame.footer, frame.hints].join('\n') };
    };
    return { view, logger, onCancel, screen };
}

const statement = (line: number, source = 'const x = 1;', variables: Record<string, unknown> = {}): PausedBlock =>
    ({ kind: 'code', line, language: 'ts', source, variables: () => variables });
const paused = (line: number, language: string, source: string, variables: Record<string, unknown> = {}): PausedBlock =>
    ({ kind: 'block', line, language, source, variables: () => variables });

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

describe('terminal view', () => {
    it('logs tool calls collapsed and expands the selected one with line numbers', () => {
        const { view, logger, screen } = setup();
        logger.tool(describeToolCall('readFile', { path: 'src/a.ts' }, { output: 'const a = 1;\nconst b = 2;\n' }));
        logger.tool(describeToolCall('writeFile', { path: 'out.md', content: '# Title\n' }, { output: 'Wrote 8 bytes' }));
        let { text } = screen();
        expect(text).toContain('\u25cf readFile src/a.ts\n  \u25b8 2 lines');
        expect(text).toContain('\u25cf writeFile out.md\n\u203a \u25b8 1 line written  space to expand');
        expect(text).not.toContain('const a = 1;');
        view.key(' ', {});
        expect(screen().text).toContain('\u25be 1 line written  space to collapse\n    1 | # Title');
        view.key('', { upArrow: true });
        view.key(' ', {});
        ({ text } = screen());
        expect(text).toContain('\u203a \u25be 2 lines  space to collapse\n    1 | const a = 1;\n    2 | const b = 2;');
        view.key('', { return: true });
        expect(screen().text).not.toContain('const a = 1;');
    });

    it('shows failed tool calls and MCP results collapsed', () => {
        const { logger, screen } = setup();
        logger.tool(describeToolCall('shell', { command: 'git status' }, { error: 'shell: exit 1\nfatal' }));
        logger.tool(describeMcpCall('docs', 'search', { q: 'x' }, { result: { content: [] }, isError: false }));
        logger.tool(describeToolCall('shell', { command: 'true' }, { output: '' }));
        const { text } = screen();
        expect(text).toContain('\u2717 shell git status\n  \u25b8 shell: exit 1');
        expect(text).not.toContain('fatal');
        expect(text).toContain('\u25cf docs/search {"q":"x"}\n\u203a');
        expect(text).toContain('\u25cf shell true\n  no output');
    });

    it('folds preambles, JSON and generated code apart from the workflow prompt', () => {
        const { view, logger, screen } = setup();
        logger.modelPrompt({ requestId: 'r', kind: 'ask' }, 'GENERATED RULES\nmore rules\n\nWrite about {"a":1}', 'GENERATED RULES\nmore rules');
        logger.modelOutput({ requestId: 'c', kind: 'codegen', role: 'response' }, 'function f() {\n    return 1;\n}');
        const { text } = screen();
        expect(text).toContain('\u276f ask prompt\n  \u25b8 preamble \u00b7 2 lines\n  \u2502 Write about\n  \u25b8 {\u2026} 1 key');
        expect(text).not.toContain('GENERATED RULES');
        expect(text).toContain('\u25cf codegen response\n\u203a \u25b8 JavaScript \u00b7 3 lines');
        expect(text).not.toContain('return 1;');
        view.key('', { home: true });
        view.key(' ', {});
        expect(screen().text).toContain('\u25be preamble \u00b7 2 lines  space to collapse\n    GENERATED RULES\n    more rules');
    });

    it('shows the transcript of an agent block: folded context, visible instruction, actions, tools and state', async () => {
        const { logger, screen } = setup();
        const source = `const draft = { title: 'T' };\n${agentBlock('Review @draft ->[Int] @score', 'enforce: Be brief')}`;
        expect(await run(source, { logger, backend: acting(save('score', 4)) })).toMatchObject({ status: 'success' });
        const { text } = screen(100, 60);
        expect(text).toContain('~ draft @ global (scope-1): <unbound> ->\n  \u25b8 {\u2026} 1 key');
        expect(text).toMatch(/\u276f agent prompt\n {2}\u25b8 preamble \u00b7 \d+ lines\n {2}\u2502 Instruction:\n {2}\u2502 Review @draft ->\[Int\] @score\n {2}\u2502 \n {2}\u2502 Completed actions and their results:\n {2}\u25b8 \[\u2026\] 0 items/);
        expect(text).toContain('\u25cf agent action\n  \u25b8 {\u2026} 2 keys');
        expect(text).toContain('\u25cf agent response\n  Done.');
        expect(text).toContain('~ score @ global (scope-1): <unbound> -> 4');
        expect(text).not.toContain('Be brief');
        expect(text).not.toContain('saveVariable');
    });

    it('streams responses until the final event replaces them', () => {
        const { view, logger, screen } = setup();
        const interaction = { requestId: 'r', kind: 'ask' } as const;
        view.stream({ type: 'update', interaction, update: { channel: 'response', messageId: 'm', mode: 'append', text: 'Hel' } });
        view.stream({ type: 'update', interaction, update: { channel: 'response', messageId: 'm', mode: 'append', text: 'lo' } });
        expect(screen().text).toContain('\u25cf ask responding\u2026\n  Hello');
        view.stream({ type: 'end', interaction, outcome: 'completed', response: 'Hello' });
        logger.modelOutput({ ...interaction, role: 'response' }, 'Hello');
        expect(screen().text).toBe('\u25cf ask response\n  Hello');
    });

    it('keeps following new output until the user scrolls away', () => {
        const { view, logger, screen } = setup();
        for (let index = 0; index < 50; index++) logger.info(`line ${index}`);
        expect(screen(80, 20).text).toContain('line 49');
        view.key('', { pageUp: true });
        logger.info('line 50');
        let frame = screen(80, 20);
        expect(frame.text).not.toContain('line 50');
        expect(frame.hints).toContain('end follow');
        view.key('', { end: true });
        frame = screen(80, 20);
        expect(frame.text).toContain('line 50');
        expect(frame.rows).toHaveLength(frame.viewport);
    });

    it('cancels on Ctrl+C while running', () => {
        const { view, onCancel, screen } = setup();
        expect(screen().hints).toContain('ctrl+c cancel');
        view.key('c', { ctrl: true });
        expect(onCancel).toHaveBeenCalledOnce();
    });

    it('steps statement by statement and block by block, prints variables and continues to the end', async () => {
        const { view, onCancel, screen } = setup(true);
        const first = view.pause(statement(5, 'const color = "blue";', { color: 'blue', list: [1] }));
        let frame = screen();
        expect(frame.header).toMatch(/^\u25cf SPL flow\.spl +debug $/);
        expect(frame.footer).toEqual(['\u2016 Paused before statement at line 5', 'const color = "blue";']);
        expect(frame.hints).toContain('n Next \u00b7 v Variables \u00b7 c Continue \u00b7 e Exit');
        expect(frame.text).toContain('\u25b6 statement \u00b7 line 5\n');
        view.key('v', {});
        expect(screen().text).toContain('\u25c6 Variables before line 5\n\u203a \u25be 2 variables  space to collapse\n    {\n      "color": "blue",');
        view.key('x', {});
        view.key('n', {});
        await expect(first).resolves.toBe('next');
        expect(screen().footer[0]).toContain('Running \u00b7 stepping');
        const second = view.pause(paused(9, 'agent', 'Summarize @color.'));
        frame = screen();
        expect(frame.text).toContain('\u25b6 agent block \u00b7 line 9');
        expect(frame.footer).toEqual(['\u2016 Paused before agent block at line 9', 'Summarize @color.']);
        view.key('c', {});
        await expect(second).resolves.toBe('continue');
        await expect(view.pause(statement(12))).resolves.toBe('continue');
        expect(screen().text).not.toContain('line 12');
        expect(onCancel).not.toHaveBeenCalled();
    });

    it.each(['ask', 'agent', 'codegen'])('labels a paused %s block by its mode and lists its instruction as Markdown', async mode => {
        const { view, screen } = setup(true);
        const pending = view.pause(paused(3, mode, '\n# Task\nDescribe @topic\n'));
        expect(screen().footer).toEqual([`\u2016 Paused before ${mode} block at line 3`, '# Task']);
        expect(screen().text).toBe(`\u25b6 ${mode} block \u00b7 line 3\n\u203a \u25b8 3 lines  space to expand`);
        view.key(' ', {});
        expect(screen().text).toContain('\u25be 3 lines  space to collapse\n    1 | \n    2 | # Task\n    3 | Describe @topic');
        view.key('N', {});
        await expect(pending).resolves.toBe('next');
    });

    it('lists the source of a paused statement with its own line numbers', () => {
        const { view, screen } = setup(true);
        void view.pause(statement(7, 'const total = items\n    .map(item => item.price)\n    .reduce((a, b) => a + b, 0);'));
        expect(screen().footer).toEqual(['\u2016 Paused before statement at line 7', 'const total = items']);
        view.key(' ', {});
        expect(screen().text).toBe([
            '\u25b6 statement \u00b7 line 7', '\u203a \u25be 3 lines  space to collapse',
            '    1 | const total = items', '    2 |     .map(item => item.price)', '    3 |     .reduce((a, b) => a + b, 0);',
        ].join('\n'));
    });

    it('shows variables that are not assigned yet, an empty scope and a snapshot that fails', () => {
        const { view, screen } = setup(true);
        void view.pause(statement(1, 'let count = 1;', { count: '<uninitialized>', twice: 'function twice(n)' }));
        view.key('v', {});
        expect(screen().text).toContain('\u25be 2 variables  space to collapse\n    {\n      "count": "<uninitialized>",\n      "twice": "function twice(n)"\n    }');
        view.key('n', {});
        void view.pause(statement(2));
        view.key('V', {});
        expect(screen().text).toContain('\u25c6 Variables before line 2\n  no top-level variables yet');
        view.key('n', {});
        void view.pause({ ...statement(3, 'count++;', { count: 1 }) });
        view.key('v', {});
        expect(screen().text).toContain('\u25c6 Variables before line 3\n\u203a \u25be 1 variable  space to collapse');
        view.key('n', {});
        void view.pause({ ...statement(4), variables: () => { throw new Error('snapshot failed'); } });
        view.key('v', {});
        expect(screen().text).toContain('\u25c6 Variables before line 4\n\u203a \u25be 1 variable  space to collapse\n    {\n      "error": "snapshot failed"\n    }');
    });

    it('exits immediately with e while paused', () => {
        const { view, onCancel } = setup(true);
        void view.pause(statement(1));
        view.key('e', {});
        expect(onCancel).toHaveBeenCalledOnce();
    });

    it('does not pause without --debug', async () => {
        const { view } = setup(false);
        await expect(view.pause(statement(1))).resolves.toBe('continue');
        await expect(view.pause(paused(2, 'ask', 'Hi'))).resolves.toBe('continue');
    });

    it('reads human answers in the status box', async () => {
        const { view, screen } = setup();
        const answer = view.ask('Favourite colour?');
        expect(screen().footer).toEqual(['? Favourite colour?', '\u203a _']);
        expect(screen().hints).toContain('enter submit');
        for (const input of ['b', 'l', 'u', 'x']) view.key(input, {});
        view.key('', { backspace: true });
        view.key('e', {});
        view.key(' ', {});
        expect(screen().footer[1]).toBe('\u203a blue _');
        view.key('', { return: true });
        await expect(answer).resolves.toBe('blue ');
        expect(screen().text).toBe('? Favourite colour?\n  \u203a blue');
        expect(view.status).toBe('running');
    });

    it('waits for e after the run ends, and not after cancellation', async () => {
        const { view, onCancel, screen } = setup();
        let finished = false;
        const done = view.finish('failed').then(() => { finished = true; });
        expect(screen().footer).toEqual(['\u2717 Failed']);
        expect(screen().hints).toMatch(/^ e Exit/);
        view.key('n', {});
        await tick();
        expect(finished).toBe(false);
        view.key('e', {});
        await done;
        expect(onCancel).not.toHaveBeenCalled();
        const completed = setup();
        const waiting = completed.view.finish('completed');
        expect(completed.screen().footer).toEqual(['\u2713 Completed']);
        completed.view.key('c', { ctrl: true });
        await waiting;
        await expect(setup().view.finish('cancelled')).resolves.toBeUndefined();
    });

    it('sanitizes terminal controls and fits every row to the width', () => {
        const { logger, screen } = setup();
        logger.info('evil \u001b[2Jtext ' + 'x'.repeat(200));
        const frame = screen(40, 20);
        expect(frame.all).not.toContain('\u001b[2J');
        for (const row of [frame.header, ...frame.rows]) expect([...row].length).toBeLessThanOrEqual(40);
    });
});

describe('presentation', () => {
    const event = (logger: Logger) => logger.info('hello');

    it('writes plain append-only logs without loading the UI', async () => {
        const lines: string[] = [];
        const mount = vi.fn();
        const logging = new CliLogging({ interactive: false, color: false, write: line => lines.push(line), mount });
        const logger = new Logger('info', undefined, { eventSink: logging.sink });
        await logging.start();
        event(logger);
        await logging.close('completed');
        expect(lines).toEqual(['i info hello']);
        expect(mount).not.toHaveBeenCalled();
        expect(logging.interactive).toBe(false);
        await expect(logging.pause(statement(1))).resolves.toBe('continue');
    });

    it('shows events in the UI, waits for e and prints nothing on exit', async () => {
        const lines: string[] = [];
        let view: TerminalView | undefined;
        const unmount = vi.fn(async () => {});
        const logging = new CliLogging({
            interactive: true, color: false, write: line => lines.push(line), title: 'flow.spl',
            mount: target => { view = target; return { unmount, exited: new Promise(() => {}) }; },
        });
        const logger = new Logger('info', undefined, { eventSink: logging.sink });
        event(logger);
        await logging.start();
        event(logger);
        expect(logging.interactive).toBe(true);
        expect(view!.frame(80, 20).rows.filter(row => row.includes('hello'))).toHaveLength(2);
        const answer = logging.ask('Name?');
        await tick();
        view!.key('A', {});
        view!.key('', { return: true });
        await expect(answer).resolves.toBe('A');
        const closing = logging.close('completed');
        await tick();
        expect(unmount).not.toHaveBeenCalled();
        view!.key('e', {});
        await closing;
        expect(unmount).toHaveBeenCalledOnce();
        expect(lines).toEqual([]);
    });

    it('falls back to plain logs when the UI fails', async () => {
        const lines: string[] = [];
        let fail!: (error: Error) => void;
        let view: TerminalView | undefined;
        const logging = new CliLogging({
            interactive: true, color: false, write: line => lines.push(line), debug: true,
            mount: target => {
                view = target;
                return { unmount: async () => {}, exited: new Promise((_, reject) => { fail = reject; }) } satisfies MountedUi;
            },
        });
        const logger = new Logger('info', undefined, { eventSink: logging.sink });
        await logging.start();
        event(logger);
        const paused = logging.pause(statement(1));
        await tick();
        expect(view!.status).toBe('paused');
        fail(new Error('boom'));
        await expect(paused).resolves.toBe('continue');
        event(logger);
        expect(lines).toEqual(['x error terminal UI: boom; using append-only logs.', 'i info hello', 'i info hello']);
        await logging.close('completed');
    });

    it('falls back to plain logs when the UI cannot start', async () => {
        const lines: string[] = [];
        const logging = new CliLogging({ interactive: true, color: false, write: line => lines.push(line), mount: () => { throw new Error('no tty'); } });
        await logging.start();
        expect(lines).toEqual(['x error terminal UI startup: no tty; using append-only logs.']);
        expect(logging.interactive).toBe(false);
    });

    it('requires terminal stdin and stderr with raw mode', () => {
        expect(canInteract({ stdinTTY: true, stderrTTY: true, rawMode: true, term: 'xterm' })).toBe(true);
        expect(canInteract({ stdinTTY: true, stderrTTY: false, rawMode: true })).toBe(false);
        expect(canInteract({ stdinTTY: false, stderrTTY: true, rawMode: true })).toBe(false);
        expect(canInteract({ stdinTTY: true, stderrTTY: true, rawMode: false })).toBe(false);
        expect(canInteract({ stdinTTY: true, stderrTTY: true, rawMode: true, term: 'dumb' })).toBe(false);
    });
});

describe('--debug stepper', () => {
    /** A logging session as `spl run --debug` builds it; keys go straight to the view instead of a terminal. */
    async function debugging(source: string, options: Partial<Parameters<typeof run>[1]> = {}) {
        let view!: TerminalView;
        const cancel = vi.fn();
        const lines: string[] = [];
        const logging = new CliLogging({
            interactive: true, color: false, debug: true, title: 'flow.spl', cancel, write: line => lines.push(line),
            mount: target => { view = target; return { unmount: async () => {}, exited: new Promise(() => {}) }; },
        });
        const logger = new Logger('info', undefined, { eventSink: logging.sink, streamSink: logging.streamSink });
        await logging.start();
        const result = run(source, { backend: scripted(), logger, ...options, beforeStep: async step => { await logging.pause(step); } });
        const screen = () => {
            const frame = view.frame(100, 80);
            return { ...frame, text: frame.rows.join('\n').trimEnd() };
        };
        /** Waits until the run stops before its next step. */
        const stop = async () => {
            while (view.status !== 'paused') await tick();
            return screen().footer;
        };
        const variables = (): unknown => {
            view.key('v', {});
            const { text } = screen();
            return JSON.parse(text.slice(text.lastIndexOf('space to collapse') + 'space to collapse'.length));
        };
        return { view, result, stop, screen, variables, cancel, logging, lines };
    }

    const source = [
        'let count = 1;',
        'function twice(n: number) {', '    return n * 2;', '}',
        agentBlock('Double @count ->[Int] @doubled'),
        'count = twice(',
        '    doubled,',
        ');',
        'success(count);',
    ].join('\n');

    it('stops before each top-level statement and each block, showing the top-level variables', async () => {
        const session = await debugging(source, { backend: acting(save('doubled', 2)) });
        expect(await session.stop()).toEqual(['\u2016 Paused before statement at line 1', 'let count = 1;']);
        expect(session.variables()).toEqual({ count: '<uninitialized>', twice: 'function twice(n)', doubled: '<uninitialized>' });
        session.view.key('n', {});
        expect(await session.stop()).toEqual(['\u2016 Paused before agent block at line 5', 'Double @count ->[Int] @doubled']);
        expect(session.variables()).toEqual({ count: 1, twice: 'function twice(n)', doubled: '<uninitialized>' });
        expect(session.screen().text).not.toContain('agent prompt');
        session.view.key('n', {});
        expect(await session.stop()).toEqual(['\u2016 Paused before statement at line 10', 'count = twice(']);
        expect(session.variables()).toEqual({ count: 1, twice: 'function twice(n)', doubled: 2 });
        expect(session.screen().text).toContain('\u25cf agent response\n  Done.');
        session.view.key('n', {});
        expect(await session.stop()).toEqual(['\u2016 Paused before statement at line 13', 'success(count);']);
        expect(session.variables()).toEqual({ count: 4, twice: 'function twice(n)', doubled: 2 });
        session.view.key('n', {});
        expect(await session.result).toEqual({ status: 'success', value: 4, hasValue: true });
        const steps = session.screen().text.split('\n').filter(row => row.startsWith('\u25b6'));
        expect(steps).toEqual(['\u25b6 statement \u00b7 line 1', '\u25b6 agent block \u00b7 line 5', '\u25b6 statement \u00b7 line 10', '\u25b6 statement \u00b7 line 13']);
        expect(session.screen().text).toContain('\u25b6 statement \u00b7 line 10\n  \u25b8 3 lines');
        const closing = session.logging.close('completed');
        await tick();
        expect(session.screen().footer).toEqual(['\u2713 Completed']);
        session.view.key('e', {});
        await closing;
        expect(session.lines).toEqual([]);
        expect(session.cancel).not.toHaveBeenCalled();
    });

    it('runs to the end with c, and cancels the run with e', async () => {
        const continued = await debugging(source, { backend: acting(save('doubled', 2)) });
        await continued.stop();
        continued.view.key('n', {});
        await continued.stop();
        continued.view.key('c', {});
        expect(await continued.result).toMatchObject({ status: 'success', value: 4 });
        expect(continued.screen().text).not.toContain('line 10');
        const exited = await debugging(source);
        await exited.stop();
        exited.view.key('e', {});
        expect(exited.cancel).toHaveBeenCalledOnce();
        expect(exited.view.status).toBe('paused');
    });

    it('stops before blocks inside functions and loops, but not before the statements around them', async () => {
        const nested = [
            'const seen: string[] = [];',
            'async function describe(item: string) {',
            '    const label = item.toUpperCase();',
            '    ---', '    outputVar: summary', '', '    Describe @label', '    ---',
            '    return summary;',
            '}',
            'for (const item of ["a", "b"]) {',
            '    seen.push(await describe(item));',
            '}',
            block('Generate -> @count(items: string[]): number', 'mode: codegen'),
            'success(count(seen));',
        ].join('\n');
        const session = await debugging(nested, { backend: scripted('A.', 'B.', 'function count(items) { return items.length; }') });
        const stops: string[] = [];
        const seen: unknown[] = [];
        for (;;) {
            const done = await Promise.race([session.stop(), session.result.then(() => undefined)]);
            if (!done) break;
            stops.push(done[0].replace('\u2016 Paused before ', ''));
            seen.push((session.variables() as { seen: unknown }).seen);
            session.view.key('n', {});
        }
        expect(stops).toEqual([
            'statement at line 1', 'statement at line 11', 'ask block at line 4', 'ask block at line 4', 'codegen block at line 14', 'statement at line 19',
        ]);
        expect(seen).toEqual(['<uninitialized>', [], [], ['A.'], ['A.', 'B.'], ['A.', 'B.']]);
        expect(await session.result).toMatchObject({ status: 'success', value: 2 });
    });

    it('stops before a failing statement and still reports the failure of the run', async () => {
        const session = await debugging("const limit = 1;\nassert(limit > 1, 'too small');");
        await session.stop();
        session.view.key('n', {});
        expect(await session.stop()).toEqual(['\u2016 Paused before statement at line 2', "assert(limit > 1, 'too small');"]);
        session.view.key('n', {});
        expect(await session.result).toMatchObject({ status: 'failure', failure: { status_code: 'assertion_failed', line: 2 } });
        expect(session.screen().text).toContain('\u2717 assertion_failed: too small (line 2)');
        const closing = session.logging.close('failed');
        await tick();
        expect(session.screen().footer).toEqual(['\u2717 Failed']);
        session.view.key('e', {});
        await closing;
    });
});

describe('ink terminal UI', () => {
    function terminal() {
        let output = '';
        const stdout = Object.assign(new Writable({ write(chunk, _encoding, callback) { output += chunk.toString(); callback(); } }),
            { isTTY: true, columns: 60, rows: 18 });
        const stdin = new PassThrough();
        Object.assign(stdin, { isTTY: true, setRawMode: () => stdin, ref: () => stdin, unref: () => stdin });
        return {
            stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream,
            get output() { return output; },
            screen: () => output.slice(output.lastIndexOf('SPL')).replace(/\u001b\[[\d;?]*[A-Za-z]/g, ''),
            type: async (text: string) => { stdin.write(text); await new Promise(resolve => setTimeout(resolve, 60)); },
        };
    }

    it('renders on the alternate screen, takes keys and restores the screen on exit', async () => {
        const term = terminal();
        const view = new TerminalView({ color: false, title: 'flow.spl', onCancel: vi.fn() });
        const logger = new Logger('info', undefined, { eventSink: (event: LogEvent) => view.append(event) });
        const ui = mountTui(view, term);
        logger.tool(describeToolCall('readFile', { path: 'a.js' }, { output: 'const a = 1;\n' }));
        const answer = view.ask('Colour?');
        await term.type('red');
        await term.type('\r');
        await expect(answer).resolves.toBe('red');
        const done = view.finish('completed');
        await term.type(' ');
        const screen = term.screen();
        expect(screen).toContain('\u25cf readFile a.js');
        expect(screen).toContain('1 | const a = 1;');
        expect(screen).toContain('? Colour?');
        expect(screen).toMatch(/\u256d\u2500+\u256e/);
        expect(screen).toContain('\u2713 Completed');
        expect(screen).toContain('e Exit');
        await term.type('e');
        await done;
        await ui.unmount();
        expect(term.output).toContain('\u001b[?1049h');
        expect(term.output.endsWith('\u001b[?1049l') || term.output.lastIndexOf('\u001b[?1049l') > term.output.lastIndexOf('Completed')).toBe(true);
    });
});
