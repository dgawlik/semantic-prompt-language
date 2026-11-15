import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { CliLogging, canInteract, type MountedUi } from '../src/cli-logging.js';
import { mountTui } from '../src/cli-tui.js';
import { TerminalView, type PausedBlock } from '../src/cli-view.js';
import type { LogEvent } from '../src/log-events.js';
import { Logger } from '../src/logger.js';
import { describeMcpCall, describeToolCall } from '../src/tools.js';

function setup(debug = false) {
    const onCancel = vi.fn();
    const view = new TerminalView({ color: false, title: 'flow.md', debug, onCancel });
    const logger = new Logger('debug', undefined, { eventSink: event => view.append(event), streamSink: event => view.stream(event) });
    const screen = (width = 80, height = 40) => {
        const frame = view.frame(width, height);
        return { ...frame, text: frame.rows.join('\n').trimEnd(), all: [frame.header, ...frame.rows, ...frame.footer, frame.hints].join('\n') };
    };
    return { view, logger, onCancel, screen };
}

const block = (line: number, source = 'const x = 1;', variables: Record<string, unknown> = {}): PausedBlock =>
    ({ kind: 'code', line, language: 'js', source, variables: () => variables });

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

describe('terminal view', () => {
    it('logs tool calls collapsed and expands the selected one with line numbers', () => {
        const { view, logger, screen } = setup();
        logger.tool(describeToolCall('read_file', { path: 'src/a.ts' }, { output: 'const a = 1;\nconst b = 2;\n' }));
        logger.tool(describeToolCall('write_file', { path: 'out.md', content: '# Title\n' }, { output: 'Wrote 8 bytes' }));
        let { text } = screen();
        expect(text).toContain('\u25cf read_file src/a.ts\n  \u25b8 2 lines');
        expect(text).toContain('\u25cf write_file out.md\n\u203a \u25b8 1 line written  space to expand');
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
        logger.modelPrompt({ requestId: 'r', kind: 'ask' }, 'RUNTIME RULES\nmore rules\n\nWrite about {"a":1}', 'RUNTIME RULES\nmore rules');
        logger.modelOutput({ requestId: 'c', kind: 'codegen', role: 'response' }, 'function f() {\n    return 1;\n}');
        const { text } = screen();
        expect(text).toContain('\u276f ask prompt\n  \u25b8 preamble \u00b7 2 lines\n  \u2502 Write about\n  \u25b8 {\u2026} 1 key');
        expect(text).not.toContain('RUNTIME RULES');
        expect(text).toContain('\u25cf codegen response\n\u203a \u25b8 JavaScript \u00b7 3 lines');
        expect(text).not.toContain('return 1;');
        view.key('', { home: true });
        view.key(' ', {});
        expect(screen().text).toContain('\u25be preamble \u00b7 2 lines  space to collapse\n    RUNTIME RULES\n    more rules');
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

    it('steps block by block, prints variables and continues to the end', async () => {
        const { view, onCancel, screen } = setup(true);
        const first = view.pause(block(5, 'const color = "blue";', { color: 'blue', list: [1] }));
        let frame = screen();
        expect(frame.header).toMatch(/^\u25cf SPL flow\.md +debug $/);
        expect(frame.footer).toEqual(['\u2016 Paused before js block at line 5', 'const color = "blue";']);
        expect(frame.hints).toContain('n Next \u00b7 v Variables \u00b7 c Continue \u00b7 e Exit');
        expect(frame.text).toContain('\u25b6 js block \u00b7 line 5\n');
        view.key('v', {});
        expect(screen().text).toContain('\u25c6 Variables before line 5\n\u203a \u25be 2 bindings  space to collapse\n    {\n      "color": "blue",');
        view.key('x', {});
        view.key('n', {});
        await expect(first).resolves.toBe('next');
        expect(screen().footer[0]).toContain('Running \u00b7 stepping');
        const second = view.pause({ ...block(9), kind: 'natural', language: 'agent', source: 'Summarize @color.' });
        expect(screen().text).toContain('\u25b6 agent block \u00b7 line 9');
        view.key('c', {});
        await expect(second).resolves.toBe('continue');
        await expect(view.pause(block(12))).resolves.toBe('continue');
        expect(screen().text).not.toContain('line 12');
        expect(onCancel).not.toHaveBeenCalled();
    });

    it('exits immediately with e while paused', () => {
        const { view, onCancel } = setup(true);
        void view.pause(block(1));
        view.key('e', {});
        expect(onCancel).toHaveBeenCalledOnce();
    });

    it('does not pause without --debug', async () => {
        const { view } = setup(false);
        await expect(view.pause(block(1))).resolves.toBe('continue');
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
        await expect(logging.pause(block(1))).resolves.toBe('continue');
    });

    it('shows events in the UI, waits for e and prints nothing on exit', async () => {
        const lines: string[] = [];
        let view: TerminalView | undefined;
        const unmount = vi.fn(async () => {});
        const logging = new CliLogging({
            interactive: true, color: false, write: line => lines.push(line), title: 'flow.md',
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
        const paused = logging.pause(block(1));
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
        const view = new TerminalView({ color: false, title: 'flow.md', onCancel: vi.fn() });
        const logger = new Logger('info', undefined, { eventSink: (event: LogEvent) => view.append(event) });
        const ui = mountTui(view, term);
        logger.tool(describeToolCall('read_file', { path: 'a.js' }, { output: 'const a = 1;\n' }));
        const answer = view.ask('Colour?');
        await term.type('red');
        await term.type('\r');
        await expect(answer).resolves.toBe('red');
        const done = view.finish('completed');
        await term.type(' ');
        const screen = term.screen();
        expect(screen).toContain('\u25cf read_file a.js');
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
