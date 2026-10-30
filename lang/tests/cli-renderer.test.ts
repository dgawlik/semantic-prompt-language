import { EventEmitter } from 'node:events';
import { fork, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '../src/logger.js';
import { parseChildMessage, parseParentMessage, RendererProtocol, type LogEvent, type ParentMessage } from '../src/log-events.js';
import { CliLogging, canInteract, type RendererChild } from '../src/cli-logging.js';
import { createEventView, probeTerminalModes } from '../src/cli-renderer.js';
import { stripVTControlCharacters } from 'node:util';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

function events(): LogEvent[] {
    const history: LogEvent[] = [];
    const logger = new Logger('info', undefined, { eventSink: event => history.push(event) });
    logger.info('first', { value: 1 });
    logger.llm('second');
    return history;
}

class FakeChild extends EventEmitter {
    connected = true;
    killed = false;
    cursorVisible = true;
    sent: unknown[] = [];
    send = vi.fn((message: ParentMessage, callback: (error: Error | null) => void) => {
        this.sent.push(message);
        queueMicrotask(() => {
            callback(null);
            if (message.type === 'initialize') this.emit('message', { version: 1, sessionId: message.sessionId, type: 'prepared', cursorVisible: this.cursorVisible });
            if (message.type === 'activate') this.emit('message', { version: 1, sessionId: message.sessionId, type: 'ready', restored: true });
            if (message.type === 'event') this.emit('message', { version: 1, sessionId: message.sessionId, type: 'accepted', sequence: message.sequence });
            if (message.type === 'finish') {
                this.emit('message', { version: 1, sessionId: message.sessionId, type: 'finished', lastSequence: message.lastSequence, restored: true });
                this.connected = false;
                this.emit('exit', 0, null);
            }
        });

        return true;
    });
    kill = vi.fn(() => { this.killed = true; this.connected = false; this.emit('exit', null, 'SIGTERM'); return true; });
    disconnect = vi.fn(() => { this.connected = false; });
}

function session(child = new FakeChild()) {
    const lines: string[] = [];
    const restore = vi.fn();
    const spawn = (): RendererChild => child;
    const logging = new CliLogging({ interactive: true, color: false, write: line => lines.push(line), spawn, restore });
    return { child, lines, logging, restore };
}

describe('renderer protocol', () => {
    it('rejects invalid payload tokens, embedded terminal controls and unexpected runtime fields', () => {
        const event = events()[0];
        const common = { version: 1, sessionId: 'invalid', type: 'event', sequence: 1 };
        expect(() => parseParentMessage({ ...common, event: { ...event, runtime: () => {} } })).toThrow(/protocol/);
        expect(() => parseParentMessage({ ...common, event: { ...event, segments: [{ type: 'text', text: '\u001b[31munsafe' }] } })).toThrow(/protocol/);
        expect(() => parseParentMessage({ ...common, event: { ...event, segments: [{
            type: 'json', payloadId: `${event.id}:bad`, source: '{"invalid":}', container: 'object', summary: 'object [folded]',
        }] } })).toThrow(/protocol/);
    });
    it('validates version, session, fields, event identity and contiguous ordering', () => {
        const protocol = new RendererProtocol();
        const initialize = { version: 1, sessionId: 'session', type: 'initialize', color: false,
            terminal: { raw: false, width: 80, height: 24 } };
        expect(protocol.accept(initialize).type).toBe('initialize');
        expect(() => protocol.accept({ version: 1, sessionId: 'session', type: 'finish', lastSequence: null, reason: 'completed' })).toThrow(/activate/i);
        expect(protocol.accept({ version: 1, sessionId: 'session', type: 'activate' }).type).toBe('activate');
        expect(() => protocol.accept({ version: 1, sessionId: 'session', type: 'activate' })).toThrow(/activate/i);
        const [first, second] = events();
        expect(protocol.accept({ version: 1, sessionId: 'session', type: 'event', sequence: 1, event: first }).type).toBe('event');
        expect(() => protocol.accept({ version: 1, sessionId: 'session', type: 'event', sequence: 3, event: { ...second, sequence: 3 } })).toThrow(/sequence/i);
        expect(() => parseParentMessage({ ...initialize, version: 2 })).toThrow(/protocol/i);
        expect(() => parseParentMessage({ ...initialize, sessionId: '' })).toThrow(/protocol/i);
        expect(() => parseParentMessage({ ...initialize, type: 'unknown' })).toThrow(/protocol/i);
        expect(() => protocol.accept({ ...initialize, sessionId: 'other' })).toThrow(/session/i);
        expect(() => parseChildMessage({ version: 1, sessionId: 'session', type: 'finished', lastSequence: 'wrong', restored: true })).toThrow(/protocol/i);
    });

    it('finishes empty history with null rather than an invented sequence', () => {
        const protocol = new RendererProtocol();
        protocol.accept({ version: 1, sessionId: 'empty', type: 'initialize', color: false, terminal: { raw: false } });
        protocol.accept({ version: 1, sessionId: 'empty', type: 'activate' });
        expect(protocol.accept({ version: 1, sessionId: 'empty', type: 'finish', lastSequence: null, reason: 'completed' }).type).toBe('finish');
    });
});

describe('terminal ownership handshake', () => {
    class ProbeInput extends EventEmitter {
        setRawMode = vi.fn();
        resume = vi.fn();
        pause = vi.fn();
    }

    it('captures a hidden cursor from fragmented mode replies before activation and restores input ownership', async () => {
        const input = new ProbeInput();
        const write = vi.fn(() => {
            queueMicrotask(() => {
                input.emit('data', Buffer.from('\u001b[?25;'));
                input.emit('data', Buffer.from('2$y\u001b[?1049;2$y'));
            });
        });
        await expect(probeTerminalModes(input, write, true, vi.fn())).resolves.toEqual({ cursorVisible: false });
        expect(write).toHaveBeenCalledWith('\u001b[?25$p\u001b[?1049$p');
        expect(input.setRawMode.mock.calls).toEqual([[true], [true]]);
        expect(input.listenerCount('data')).toBe(0);
        expect(input.pause).toHaveBeenCalledOnce();
    });

    it.each(['\u001b[?25;0$y\u001b[?1049;2$y', '\u001b[?25;1$y\u001b[?1049;1$y', '\u001b[?25;1$y\u001b[?1049;4$y'])(
        'refuses unknown or already-alternate terminal state without entering the view: %j', async reply => {
            const input = new ProbeInput();
            await expect(probeTerminalModes(input, () => {
                queueMicrotask(() => input.emit('data', Buffer.from(reply)));
            }, false, vi.fn())).rejects.toThrow(/terminal.*(mode|alternate)/i);
            expect(input.setRawMode.mock.calls).toEqual([[true], [false]]);
            expect(input.listenerCount('data')).toBe(0);
        },
    );

    it('bounds unsupported queries and routes keyboard interruption while probing', async () => {
        vi.useFakeTimers();
        const input = new ProbeInput();
        const timedOut = expect(probeTerminalModes(input, vi.fn(), false, vi.fn())).rejects.toThrow(/terminal.*timed out/i);
        await vi.advanceTimersByTimeAsync(250);
        await timedOut;
        const cancel = vi.fn();
        await expect(probeTerminalModes(input, () => {
            queueMicrotask(() => input.emit('data', Buffer.from('\u0003')));
        }, false, cancel)).rejects.toThrow(/interrupted/);
        expect(cancel).toHaveBeenCalledOnce();
        expect(input.listenerCount('data')).toBe(0);
    });

    it.each(['completed', 'crashed'])('owns the restoration snapshot before activation and restores a hidden cursor when %s', async outcome => {
        const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        const child = new FakeChild();
        child.cursorVisible = false;
        const logging = new CliLogging({ interactive: true, spawn: () => child });
        await logging.start();
        if (outcome === 'crashed') child.emit('exit', 1, null);
        await logging.close('completed');
        expect(child.sent.map(message => (message as ParentMessage).type)).toEqual(outcome === 'crashed'
            ? ['initialize', 'activate'] : ['initialize', 'activate', 'finish']);
        const output = write.mock.calls.map(([text]) => String(text)).join('');
        expect(output).toContain('\u001b[?1049l\u001b[?25l');
        expect(output).not.toContain('\u001b[?25s');
        expect(output).not.toContain('\u001b[?25r');
        expect(() => parseChildMessage({ version: 1, sessionId: 'x', type: 'prepared', cursorVisible: 'unknown' })).toThrow(/protocol/);
    });
});

it.skipIf(!process.env.SPL_PTY_HOST)('preserves real terminal state through completion, failure, keyboard Ctrl+C and native crash', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'spl-terminal-acceptance-'));
    const driver = path.join(directory, 'driver.cjs');
    const fixture = path.join(directory, 'terminal.mjs');
    const wrapper = path.join(directory, 'wrapper.ps1');
    fs.writeFileSync(wrapper, `
param([string]$NodePath,[string]$Fixture,[string]$Result)
$ErrorActionPreference='Stop'
$start=[System.Diagnostics.ProcessStartInfo]::new($NodePath)
$start.ArgumentList.Add($Fixture)
$start.UseShellExecute=$false
$start.RedirectStandardOutput=$true
$child=[System.Diagnostics.Process]::Start($start)
$output=$child.StandardOutput.ReadToEnd()
$child.WaitForExit()
[System.IO.File]::WriteAllText($Result,$output)
exit $child.ExitCode
`);
    fs.writeFileSync(driver, `
const path=require('node:path');
const fs=require('node:fs');
const {spawn}=require(path.join(process.env.SPL_PTY_MODULES,'node-pty'));
const {Terminal}=require(path.join(process.env.SPL_PTY_MODULES,'@xterm','headless'));
const [platform,node,fixture,result,wrapper,report]=process.argv.slice(2);
const terminal=new Terminal({cols:100,rows:30,allowProposedApi:true});
const quote=value=>"'"+value.replaceAll("'","'\\\\''")+"'";
const child=platform==='windows'
    ? spawn('pwsh.exe',['-NoProfile','-File',wrapper,node,fixture,result],{cols:100,rows:30,env:process.env,useConpty:true})
    : spawn('wsl.exe',['--distribution','Ubuntu','--exec','sh','-c',
        quote(node)+' '+quote(fixture)+' > '+quote(result)],{cols:100,rows:30,env:process.env,useConpty:true});
terminal.onData(data=>child.write(data));
const snapshots={};
terminal.parser.registerOscHandler(777,data=>{
    const frame=Array.from({length:terminal.rows},(_,i)=>terminal.buffer.active.getLine(i)?.translateToString(true)??'').join('\\n');
    snapshots[data]={cursor:terminal.modes.showCursor,screen:terminal.buffer.active.type,frame};
    if(data==='live'&&process.env.SPL_PTY_OUTCOME==='cancelled') child.write('\\x03');
    if(data==='live'&&process.env.SPL_PTY_OUTCOME==='completed'&&process.env.SPL_PTY_MODE!=='alternate') child.write('\\r');
    if(data==='expanded') child.write(' ');
    return true;
});
let pending=Promise.resolve();
child.onData(data=>{pending=pending.then(()=>new Promise(resolve=>terminal.write(data,resolve)));});
const timer=setTimeout(()=>{child.kill();process.exit(1);},12000);
child.onExit(async event=>{
    await pending;
    clearTimeout(timer);
    fs.writeFileSync(report,JSON.stringify({event,snapshots}));
    terminal.dispose();
    process.exit(0);
});
`);
    const platforms = ['windows'];
    if (process.env.SPL_UNIX_PTY_NODE) platforms.push('unix');
    try {
        for (const platform of platforms) {
            const unixPath = (file: string) => {
                const converted = spawnSync('wsl.exe', ['--distribution', 'Ubuntu', '--exec', 'wslpath', '-a', file], { encoding: 'utf8' });
                if (converted.status !== 0) throw new Error(converted.stderr);
                return converted.stdout.trim();
            };
            const dist = platform === 'windows' ? process.env.SPL_WINDOWS_PTY_DIST ?? new URL('../dist/', import.meta.url).href
                : `file://${process.env.SPL_UNIX_PTY_DIST}/`;
            const cases = ['visible', 'hidden'].flatMap(mode =>
                ['completed', 'failed', 'cancelled', 'crashed'].map(outcome => ({ mode, outcome })));
            cases.push({ mode: 'alternate', outcome: 'completed' }, { mode: 'raw', outcome: 'completed' });
            for (const [index, { mode, outcome }] of cases.entries()) {
                const report = path.join(directory, `${platform}-${index}.json`);
                const result = path.join(directory, `${platform}-${index}.stdout`);
                const rawReport = path.join(directory, 'input-state.json');
                fs.rmSync(rawReport, { force: true });
                const rawReportPath = platform === 'windows' ? rawReport : unixPath(rawReport);
                fs.writeFileSync(fixture, `
import {fork,execFileSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {CliLogging} from ${JSON.stringify(`${dist}cli-logging.js`)};
import {Logger} from ${JSON.stringify(`${dist}logger.js`)};
const mode=${JSON.stringify(mode)},outcome=${JSON.stringify(outcome)};
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const phase=name=>process.stderr.write('\\x1b]777;'+name+'\\x07');
const state=()=>process.platform==='win32'?process.stdin.isRaw:
    execFileSync('stty',['-g'],{encoding:'utf8',stdio:['inherit','pipe','inherit']}).trim();
if(mode==='alternate') process.stderr.write('\\x1b[?1049h');
process.stderr.write('\\x1b[?25'+(mode==='hidden'?'l':'h')+'BASELINE-MARKER\\n');
if(mode==='raw') process.stdin.setRawMode(true);
await delay(30);
const before=state();
phase('before');
let child,cancelled=false;
const retained=[];
const logging=new CliLogging({interactive:true,color:false,
    spawn:()=>child=fork(new URL(${JSON.stringify(`${dist}cli-renderer.js`)}),[],{
        execPath:process.execPath,execArgv:[],stdio:['inherit',2,2,'ipc']}),
    write:line=>{retained.push(line);process.stderr.write(line+'\\n');},
    cancel:()=>{cancelled=true;}
});
try {
    await logging.start();
    const interactive=logging.state==='interactive';
    const logger=new Logger('info',undefined,{eventSink:logging.sink});
    logger.modelInput({kind:'ask',requestId:'paced'},'request', {nested:[1,2]});
    logger.modelOutput({kind:'ask',requestId:'paced',role:'response'},'response', {answer:2});
    await delay(150);
    phase('live');
    if(interactive&&outcome==='cancelled') for(let i=0;i<100&&!cancelled;i++) await delay(10);
    else if(interactive&&outcome==='crashed') child.kill('SIGKILL');
    else if(interactive&&outcome==='completed') {
        await delay(120);
        phase('expanded');
        await delay(120);
        phase('folded');
    }
    if(outcome==='failed') logger.error('synthetic failure');
    await logging.close(outcome==='failed'?'failed':cancelled?'cancelled':'completed');
    await delay(30);
    phase('after');
    writeFileSync(${JSON.stringify(rawReportPath)},JSON.stringify({before,after:state(),interactive,cancelled,retained}));
    if(outcome==='failed') process.stdout.write('{"kind":"synthetic_failure"}\\n');
    else if(!cancelled) process.stdout.write('2\\n');
    process.exitCode=outcome==='failed'?1:cancelled?130:0;
} catch(error) {
    await logging.close('failed');
    writeFileSync(${JSON.stringify(rawReportPath)},JSON.stringify({error:error.stack}));
    process.exitCode=70;
} finally {
    process.stdin.setRawMode(false);
    process.stdin.pause();
    if(mode==='alternate') process.stderr.write('\\x1b[?1049l');
    process.stderr.write('\\x1b[?25h');
}
`);
                const run = spawnSync(process.env.SPL_PTY_HOST!, [driver, platform,
                    platform === 'windows' ? process.execPath : process.env.SPL_UNIX_PTY_NODE!,
                    platform === 'windows' ? fixture : unixPath(fixture),
                    platform === 'windows' ? result : unixPath(result), wrapper, report], {
                    encoding: 'utf8', timeout: 15_000,
                    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SPL_PTY_OUTCOME: outcome, SPL_PTY_MODE: mode },
                });
                expect(run.error, `${platform}/${mode}/${outcome}: ${run.stderr}`).toBeUndefined();
                expect(run.status, `${platform}/${mode}/${outcome}: ${run.stderr}`).toBe(0);
                const { snapshots, event } = JSON.parse(fs.readFileSync(report, 'utf8'));
                const evidence = JSON.parse(fs.readFileSync(rawReport, 'utf8'));
                expect(evidence.error).toBeUndefined();
                expect(evidence.after, `${platform}/${mode}/${outcome}: input`).toEqual(evidence.before);
                expect(snapshots.after.cursor).toBe(snapshots.before.cursor);
                expect(snapshots.after.screen).toBe(snapshots.before.screen);
                expect(snapshots.after.frame).toContain('BASELINE-MARKER');
                expect(evidence.interactive, evidence.retained.join('\n')).toBe(mode !== 'alternate');
                expect(evidence.cancelled).toBe(outcome === 'cancelled');
                expect(event.exitCode).toBe(outcome === 'failed' ? 1 : outcome === 'cancelled' ? 130 : 0);
                if (evidence.interactive) {
                    expect(snapshots.live.screen).toBe('alternate');
                    expect(snapshots.live.frame).toContain('Enter/Space');
                    expect(snapshots.live.frame).toContain('object [folded]');
                    if (outcome === 'completed') {
                        expect(snapshots.expanded.frame).toContain('"nested"');
                        expect((snapshots.expanded.frame.match(/object \[folded\]/g) ?? []).length).toBe(1);
                        expect((snapshots.folded.frame.match(/object \[folded\]/g) ?? []).length).toBe(2);
                    }
                }
                const transcript = evidence.retained.join('\n');
                expect((transcript.match(/-> input ask/g) ?? []).length).toBe(1);
                expect((transcript.match(/<- output ask/g) ?? []).length).toBe(1);
                expect(transcript).toContain('"nested": [\n    1,\n    2\n  ]');
                expect(transcript.includes('using append-only')).toBe(mode === 'alternate' || outcome === 'crashed');
                expect(fs.readFileSync(result, 'utf8')).toBe(outcome === 'failed'
                    ? '{"kind":"synthetic_failure"}\n' : outcome === 'cancelled' ? '' : '2\n');
                console.error(`PTY acceptance: ${platform}/${mode}/${outcome}, cursor/screen/input restored`);
            }
        }
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
}, 60_000);

describe('presentation ownership', () => {
    it('sends an ordered queue through successful backpressure without dropping events', async () => {
        const { logging, child, lines } = session();
        await logging.start();
        const send = child.send.getMockImplementation()!;
        child.send.mockImplementation((message, callback) => { send(message, callback); return false; });
        events().forEach(logging.sink);
        await logging.close('completed');
        expect(child.sent.slice(2).map(message => (message as ParentMessage).type)).toEqual(['event', 'event', 'finish']);
        expect(lines.filter(line => line.includes('i info first'))).toHaveLength(1);
        expect(lines.join('\n')).not.toContain('using append-only');
    });

    it('diagnoses a disconnected channel and a restoration failure explicitly', async () => {
        const child = new FakeChild();
        const lines: string[] = [];
        const logging = new CliLogging({ interactive: true, spawn: () => child,
            write: line => lines.push(line), restore: () => { throw new Error('restore failed'); } });
        await logging.start();
        events().forEach(logging.sink);
        child.emit('disconnect');
        await logging.close('failed');
        expect(lines.join('\n')).toContain('IPC disconnected');
        expect(lines.join('\n')).toContain('terminal restoration failed: restore failed');
        expect(lines.filter(line => line.includes('i info first'))).toHaveLength(1);
    });

    it.each(['ready', 'finish'] as const)('bounds a missing %s acknowledgment at 1,000 ms and retains once', async stage => {
        vi.useFakeTimers();
        const { logging, child, lines, restore } = session();
        const original = child.send.getMockImplementation()!;
        child.send.mockImplementation((message, callback) => {
            if ((stage === 'ready' && message.type === 'initialize') || (stage === 'finish' && message.type === 'finish')) {
                queueMicrotask(() => callback(null));
                return true;
            }
            return original(message, callback);
        });
        const start = logging.start();
        if (stage === 'ready') await vi.advanceTimersByTimeAsync(1_000);
        await start;
        events().forEach(logging.sink);
        const close = logging.close('completed');
        await vi.advanceTimersByTimeAsync(1_000);
        await close;
        expect(child.kill).toHaveBeenCalled();
        expect(restore).toHaveBeenCalledTimes(1);
        expect(lines.join('\n')).toContain(`${stage} timed out after 1,000 ms`);
        expect(lines.filter(line => line.includes('i info first'))).toHaveLength(1);
    });

    it.each([
        { version: 2, type: 'ready' },
        { version: 1, type: 'unknown' },
        { version: 1, type: 'accepted', sequence: 99 },
        { version: 1, type: 'accepted', sequence: 'bad' },
        { version: 1, type: 'ready', restored: true, sessionId: 'other' },
    ])('diagnoses malformed/wrong-version/wrong-session/gapped child messages: %j', async fault => {
        const { logging, child, lines, restore } = session();
        await logging.start();
        events().forEach(logging.sink);
        const initialize = child.sent[0] as ParentMessage;
        child.emit('message', { sessionId: initialize.sessionId, ...fault });
        await logging.close('failed');
        expect(lines.join('\n')).toContain('renderer protocol');
        expect(lines.filter(line => line.includes('i info first'))).toHaveLength(1);
        expect(restore).toHaveBeenCalledTimes(1);
    });

    it('queues through backpressure and checks send callback failures without losing history', async () => {
        const { logging, child, lines, restore } = session();
        await logging.start();
        child.send.mockImplementation((_message, callback) => {
            queueMicrotask(() => callback(new Error('channel failed')));
            return false;
        });
        events().forEach(logging.sink);
        child.emit('error', new Error('duplicate error'));
        await logging.close('failed');
        expect(lines.join('\n')).toContain('using append-only logs');
        expect(lines.filter(line => line.includes('i info first'))).toHaveLength(1);
        expect(lines.filter(line => line.includes('- message second'))).toHaveLength(1);
        expect(restore).toHaveBeenCalledTimes(1);
    });

    it('handles a native crash and interruption separately, including empty-history finish', async () => {
        const first = session();
        await first.logging.start();
        first.child.emit('exit', 1, null);
        await first.logging.close('failed');
        expect(first.lines.join('\n')).toContain('exited unexpectedly');
        const cancel = vi.fn();
        const child = new FakeChild();
        const logging = new CliLogging({ interactive: true, spawn: () => child, restore: vi.fn(), write: vi.fn(), cancel });
        await logging.start();
        const initialize = child.sent[0] as ParentMessage;
        child.emit('message', { version: 1, sessionId: initialize.sessionId, type: 'cancel', reason: 'interrupt' });
        expect(cancel).toHaveBeenCalledOnce();
        await logging.close('cancelled');
        expect(child.sent.at(-1)).toMatchObject({ type: 'finish', lastSequence: null, reason: 'cancelled' });
    });

    it('retains exactly one complete transcript and closes without a keypress', async () => {
        const { logging, lines, restore, child } = session();
        await logging.start();
        events().forEach(logging.sink);
        await logging.close('completed');
        await logging.close('completed');
        expect(child.sent.map(message => (message as { type: string }).type)).toEqual(['initialize', 'activate', 'event', 'event', 'finish']);
        expect(lines.filter(line => line.includes('i info first'))).toHaveLength(1);
        expect(lines.join('\n')).toContain('"value": 1');
        expect(lines.join('\n')).toContain('- message second');
        expect(restore).toHaveBeenCalledTimes(1);
        expect(logging.state).toBe('closed');
    });

    describe('native event view', () => {
        async function setup() {
            const { createTestRenderer } = await import('@bettertui/core');
            const test = await createTestRenderer({ width: 100, height: 24, autoStart: false, exitOnCtrlC: false });
            const view = await createEventView(test.renderer, false);
            test.renderer.keyInput.start();
            return { test, view, async cleanup() {
                view.destroy();
                test.renderer.destroy();
                await new Promise<void>(resolve => setImmediate(resolve));
                test.cleanup();
            } };
        }

        it('folds independently with mock keys and preserves selection/folds through arrival and resize', async () => {
            const { test, view, cleanup } = await setup();
            try {
                const history: LogEvent[] = [];
                const logger = new Logger('info', undefined, { eventSink: event => { history.push(event); view.append(event); } });
                logger.info('first:', { a: 1 });
                logger.llm('second:', [2, 3]);
                test.renderOnce();
                const initial = stripVTControlCharacters(test.captureFrame());
                expect(initial).toContain('object [folded]');
                expect(initial).toContain('array [folded]');
                expect(initial).toContain('Enter/Space');
                const first = view.selectedPayloadId;
                test.mockInput.pressEnter();
                test.renderOnce();
                expect(stripVTControlCharacters(test.captureFrame())).toContain('"a": 1');
                test.mockInput.pressArrow('down');
                test.mockInput.pressKey(' ');
                test.renderOnce();
                expect([...view.collapsedByPayload.values()]).toEqual([false, false]);
                logger.info('third:', {});
                test.resize(30, 12);
                test.renderer.emit('resize', 30, 12);
                test.renderOnce();
                expect(view.width).toBe(30);
                expect(view.height).toBe(12);
                test.resize(100, 24);
                test.renderer.emit('resize', 100, 24);
                test.renderOnce();
                expect(view.selectedPayloadId).not.toBe(first);
                expect([...view.collapsedByPayload.values()]).toEqual([false, false, true]);
                test.mockInput.pressHome();
                expect(view.selectedPayloadId).toBe(first);
                expect(view.followingTail).toBe(false);
                test.mockInput.pressEnd();
                expect(view.followingTail).toBe(true);
                test.mockInput.pressPageUp();
                expect(view.followingTail).toBe(false);
                test.mockInput.pressPageDown();
                expect(view.history.map(event => event.id)).toEqual(history.map(event => event.id));
            } finally { await cleanup(); }
        });

        it('updates a 100 KiB payload frame within 100 ms and retains 1,000 mixed events', async () => {
            const { test, view, cleanup } = await setup();
            try {
                const history: LogEvent[] = [];
                const logger = new Logger('debug', undefined, { eventSink: event => { history.push(event); view.append(event); } });
                const source = JSON.stringify({ data: Array.from({ length: 1_000 }, (_, i) => `${i}:${'x'.repeat(100)}`) });
                expect(Buffer.byteLength(source)).toBeGreaterThanOrEqual(100 * 1024);
                logger.modelOutput({ requestId: 'large', kind: 'ask', role: 'response' }, source);
                const started = performance.now();
                test.mockInput.pressEnter();
                test.renderOnce();
                expect(stripVTControlCharacters(test.captureFrame())).toContain('"data"');
                const elapsed = performance.now() - started;
                expect(elapsed).toBeLessThan(100);
                process.stderr.write(`SC-003: ${Buffer.byteLength(source)} bytes toggled to captured frame in ${elapsed.toFixed(2)} ms\n`);
                const selected = view.selectedPayloadId;
                for (let i = 1; i < 1_000; i++) {
                    if (i % 3 === 0) logger.debug(`event ${i}`);
                    else if (i % 3 === 1) logger.info({ i });
                    else logger.modelInput({ kind: 'think', requestId: String(i) }, `event ${i}`);
                }
                test.resize(36, 16);
                test.renderer.emit('resize', 36, 16);
                test.renderOnce();
                expect(view.width).toBe(36);
                test.resize(100, 24);
                test.renderer.emit('resize', 100, 24);
                expect(view.history).toEqual(history);
                expect(view.history.map(event => event.sequence)).toEqual(Array.from({ length: 1_000 }, (_, index) => index + 1));
                expect(view.selectedPayloadId).toBe(selected);
                expect(view.collapsedByPayload.get(selected!)).toBe(false);
            } finally { await cleanup(); }
        });
    });

    it('diagnoses startup failure and streams complete append-only logs', async () => {
        const lines: string[] = [];
        const logging = new CliLogging({ interactive: true, color: false, write: line => lines.push(line),
            spawn: () => { throw new Error('native startup unavailable'); }, restore: vi.fn() });
        await logging.start();
        events().forEach(logging.sink);
        await logging.close('completed');
        expect(lines.join('\n')).toContain('native startup unavailable');
        expect(lines.filter(line => line.includes('i info first'))).toHaveLength(1);
    });

    it('does not spawn or acquire input in plain mode and gates on stdin/stderr, not stdout', async () => {
        const spawn = vi.fn();
        const logging = new CliLogging({ interactive: false, spawn, write: vi.fn() });
        await logging.start();
        await logging.close('completed');
        expect(spawn).not.toHaveBeenCalled();
        expect(canInteract({ stdinTTY: true, stderrTTY: true, rawMode: true, term: 'xterm' })).toBe(true);
        expect(canInteract({ stdinTTY: false, stderrTTY: true, rawMode: true, term: 'xterm' })).toBe(false);
    });

    it('uses the real child entry point and diagnoses an unavailable terminal', async () => {
        const child = fork(fileURLToPath(new URL('../dist/cli-renderer.js', import.meta.url)), [], {
            execPath: process.execPath, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        });
        const message = new Promise<unknown>(resolve => child.once('message', resolve));
        child.send({ version: 1, sessionId: 'real', type: 'initialize', color: false, terminal: { raw: false } });
        expect(await message).toMatchObject({ type: 'fatal', stage: 'startup' });
        await new Promise(resolve => child.once('exit', resolve));
    });

        it('routes real child fd 1 and fd 2 to parent stderr without patching workflow stdout', () => {
            const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'spl-renderer-fds-'));
            const fixture = path.join(directory, 'child.cjs');
            try {
                fs.writeFileSync(fixture, `process.on('message', message => {
                    const common = {version:1,sessionId:message.sessionId};
                    if(message.type==='initialize') {
                        process.send({...common,type:'prepared',cursorVisible:true});
                    } else if(message.type==='activate') {
                        process.stdout.write('transient frame\\n');
                        process.stderr.write('native diagnostic\\n');
                        process.send({...common,type:'ready',restored:true});
                    } else if(message.type==='event') process.send({...common,type:'accepted',sequence:message.sequence});
                    else {
                        process.stdout.write('restored\\n');
                        process.send({...common,type:'finished',lastSequence:message.lastSequence,restored:true},()=>process.disconnect());
                    }
                });`);
                const script = `import {fork} from 'node:child_process';
import {CliLogging} from ${JSON.stringify(new URL('../dist/cli-logging.js', import.meta.url).href)};
import {Logger} from ${JSON.stringify(new URL('../dist/logger.js', import.meta.url).href)};
const session=new CliLogging({interactive:true,color:false,restore:()=>{},
spawn:()=>fork(${JSON.stringify(fixture)},[],{execPath:process.execPath,execArgv:[],stdio:['inherit',2,2,'ipc']})});
await session.start();
new Logger('info',undefined,{eventSink:session.sink}).info('retained',{value:1});
await session.close('completed');
process.stdout.write('workflow result\\n');`;
                const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 5_000 });
                expect(result.error).toBeUndefined();
                expect(result.status).toBe(0);
                expect(result.stdout).toBe('workflow result\n');
                expect(result.stderr).toBe('transient frame\nnative diagnostic\nrestored\ni info retained\n{\n  "value": 1\n}\n');
            } finally { fs.rmSync(directory, { recursive: true, force: true }); }
        });
});
