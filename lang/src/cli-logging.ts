import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseChildMessage, type FinishReason, type LogEvent, type ModelStreamEvent, type ParentMessage, type TerminalState } from './log-events.js';
import { formatEvent, sanitize, terminalColor } from './log-format.js';

export interface TerminalCapabilities {
    stdinTTY: boolean;
    stderrTTY: boolean;
    rawMode: boolean;
    term?: string;
}

export function canInteract(capabilities: TerminalCapabilities = {
    stdinTTY: Boolean(process.stdin.isTTY), stderrTTY: Boolean(process.stderr.isTTY),
    rawMode: typeof process.stdin.setRawMode === 'function', term: process.env.TERM,
}): boolean {
    return capabilities.stdinTTY && capabilities.stderrTTY && capabilities.rawMode && capabilities.term !== 'dumb';
}

export type RendererChild = Pick<ChildProcess, 'on' | 'off' | 'once' | 'kill' | 'disconnect' | 'connected'> & {
    send(message: ParentMessage, callback: (error: Error | null) => void): boolean;
};

interface PresentationOptions {
    interactive: boolean;
    color?: boolean;
    write?: (line: string) => void;
    spawn?: () => RendererChild;
    restore?: () => void;
    cancel?: () => void;
}

const DEADLINE = 1_000;

export class CliLogging {
    state: 'plain' | 'starting' | 'interactive' | 'falling-back' | 'finishing' | 'closed' = 'plain';
    private readonly history: LogEvent[] = [];
    private readonly sessionId = randomUUID();
    private readonly color: boolean;
    private readonly write: (line: string) => void;
    private readonly terminal: TerminalState;
    private child?: RendererChild;
    private readonly queue: ParentMessage[] = [];
    private sending = false;
    private sent = 0;
    private accepted = 0;
    private timer?: ReturnType<typeof setTimeout>;
    private ready?: () => void;
    private finished?: () => void;
    private startPromise?: Promise<void>;
    private closePromise?: Promise<void>;
    private failurePromise?: Promise<void>;
    private restored = false;
    private exited = false;
    private finishAcknowledged = false;
    private cursorVisible?: boolean;

    constructor(private readonly options: PresentationOptions) {
        this.color = options.color ?? terminalColor();
        this.write = options.write ?? (line => { process.stderr.write(line + '\n'); });
        this.terminal = { raw: Boolean(process.stdin.isRaw),
            width: process.stderr.columns || undefined, height: process.stderr.rows || undefined };
    }

    readonly sink = (event: LogEvent): void => {
        if (this.state === 'closed') throw new Error('logging session is closed');
        this.history.push(event);
        if (this.state === 'plain') this.write(formatEvent(event, this.color));
        else if (this.state === 'interactive') this.enqueue({
            version: 1, sessionId: this.sessionId, type: 'event', sequence: event.sequence, event,
        });
    };

    readonly streamSink = (event: ModelStreamEvent): void => {
        if (this.state === 'closed') throw new Error('logging session is closed');
        if (this.state === 'interactive') this.enqueue({ version: 1, sessionId: this.sessionId, type: 'stream', event });
    };

    start(): Promise<void> {
        if (this.startPromise) return this.startPromise;
        if (!this.options.interactive) return this.startPromise = Promise.resolve();
        this.state = 'starting';
        this.startPromise = new Promise(resolve => { this.ready = resolve; });
        try {
            // Own the OS input-mode snapshot before a child can change it or crash.
            if (!this.options.restore) process.stdin.setRawMode?.(true);
            this.child = this.options.spawn?.() ?? fork(fileURLToPath(new URL('./cli-renderer.js', import.meta.url)), [], {
                execPath: process.execPath, execArgv: [], stdio: ['inherit', 2, 2, 'ipc'],
            });
            this.child.on('message', this.onMessage);
            this.child.on('error', this.onError);
            this.child.on('exit', this.onExit);
            this.child.on('disconnect', this.onDisconnect);
            this.timer = setTimeout(() => { void this.fail('renderer ready timed out after 1,000 ms'); }, DEADLINE);
            this.enqueue({ version: 1, sessionId: this.sessionId, type: 'initialize', color: this.color, terminal: this.terminal });
        } catch (error) {
            void this.fail(`renderer startup: ${error instanceof Error ? error.message : String(error)}`);
        }
        return this.startPromise;
    }

    close(reason: FinishReason): Promise<void> {
        return this.closePromise ??= this.finish(reason);
    }

    private async finish(reason: FinishReason): Promise<void> {
        await this.startPromise;
        if (this.failurePromise) await this.failurePromise;
        if (this.state === 'interactive') {
            this.state = 'finishing';
            await new Promise<void>(resolve => {
                this.finished = resolve;
                this.timer = setTimeout(() => { void this.fail('renderer finish timed out after 1,000 ms'); }, DEADLINE);
                this.enqueue({ version: 1, sessionId: this.sessionId, type: 'finish',
                    lastSequence: this.history.at(-1)?.sequence ?? null, reason });
            });
            if (this.failurePromise) await this.failurePromise;
            else {
                await this.reap(false);
                this.restore();
                this.transcript();
            }
        }
        this.detach();
        this.state = 'closed';
    }

    private enqueue(message: ParentMessage): void {
        this.queue.push(message);
        this.pump();
    }

    private pump(): void {
        if (this.sending || !this.queue.length || !this.child || this.state === 'falling-back' || this.state === 'plain') return;
        const message = this.queue.shift()!;
        this.sending = true;
        if (message.type === 'event') this.sent = message.sequence;
        try {
            this.child.send(message, error => {
                this.sending = false;
                if (error) void this.fail(`renderer send failed: ${error.message}`);
                else this.pump();
            });
        } catch (error) {
            this.sending = false;
            void this.fail(`renderer send failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private readonly onMessage = (raw: unknown): void => {
        if (this.state === 'falling-back' || this.state === 'closed' || this.state === 'plain') return;
        try {
            const message = parseChildMessage(raw);
            if (message.sessionId !== this.sessionId) throw new Error('renderer protocol: wrong session');
            switch (message.type) {
                case 'prepared':
                    if (this.state !== 'starting' || this.cursorVisible !== undefined) throw new Error('renderer protocol: unexpected prepared');
                    this.cursorVisible = message.cursorVisible;
                    this.enqueue({ version: 1, sessionId: this.sessionId, type: 'activate' });
                    break;
                case 'ready':
                    if (this.state !== 'starting' || this.cursorVisible === undefined) throw new Error('renderer protocol: unexpected ready');
                    clearTimeout(this.timer);
                    this.state = 'interactive';
                    for (const event of this.history) this.enqueue({ version: 1, sessionId: this.sessionId, type: 'event', sequence: event.sequence, event });
                    this.ready?.();
                    break;
                case 'accepted':
                    if (message.sequence !== this.accepted + 1 || message.sequence > this.sent) throw new Error('renderer protocol: invalid accepted sequence');
                    this.accepted = message.sequence;
                    break;
                case 'finished':
                    if (this.state !== 'finishing' || message.lastSequence !== (this.history.at(-1)?.sequence ?? null) ||
                        (message.lastSequence ?? 0) !== this.accepted) throw new Error('renderer protocol: invalid final sequence');
                    clearTimeout(this.timer);
                    this.finishAcknowledged = true;
                    this.finished?.();
                    break;
                case 'cancel': this.options.cancel?.(); break;
                case 'fatal': void this.fail(`renderer ${message.stage}: ${message.diagnostic}`); break;
            }
        } catch (error) {
            void this.fail(error instanceof Error ? error.message : String(error));
        }
    };

    private readonly onError = (error: Error): void => { void this.fail(`renderer process: ${error.message}`); };
    private readonly onDisconnect = (): void => {
        if (this.state === 'starting' || this.state === 'interactive' || (this.state === 'finishing' && !this.finishAcknowledged)) {
            void this.fail('renderer IPC disconnected before cleanup acknowledgment');
        }
    };
    private readonly onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
        this.exited = true;
        if (this.state === 'starting' || this.state === 'interactive' || (this.state === 'finishing' && !this.finishAcknowledged)) {
            void this.fail(`renderer exited unexpectedly (${signal ?? code})`);
        }
    };

    private fail(diagnostic: string): Promise<void> {
        if (this.failurePromise) return this.failurePromise;
        if (this.state === 'closed' || this.state === 'plain') return Promise.resolve();
        this.state = 'falling-back';
        clearTimeout(this.timer);
        this.queue.length = 0;
        this.failurePromise = (async () => {
            await this.reap(true);
            this.restore();
            this.write(`x error ${sanitize(diagnostic)}; using append-only logs.`);
            this.transcript();
            this.state = 'plain';
            this.detach();
            this.ready?.();
            this.finished?.();
        })();
        return this.failurePromise;
    }

    private async reap(terminate: boolean): Promise<void> {
        const child = this.child;
        if (!child || this.exited) return;
        await new Promise<void>(resolve => {
            const done = () => { clearTimeout(timer); child.off('exit', done); resolve(); };
            const timer = setTimeout(() => {
                if (!child.kill('SIGKILL')) this.write('x error renderer could not be terminated; terminal restoration is required.');
                done();
            }, DEADLINE);
            child.once('exit', done);
            if (terminate) child.kill();
        });
    }

    private restore(): void {
        if (this.restored) return;
        this.restored = true;
        try {
            if (this.options.restore) this.options.restore();
            else process.stdin.setRawMode?.(this.terminal.raw);
        } catch (error) {
            this.write(`x error terminal restoration failed: ${sanitize(error instanceof Error ? error.message : String(error))}`);
        } finally {
            if (!this.options.restore && this.cursorVisible !== undefined) {
                process.stderr.write(`\u001b[0m\u001b[?1049l\u001b[?25${this.cursorVisible ? 'h' : 'l'}`);
            }
        }
    }

    private transcript(): void { for (const event of this.history) this.write(formatEvent(event, this.color)); }
    private detach(): void {
        clearTimeout(this.timer);
        this.child?.off('message', this.onMessage);
        this.child?.off('error', this.onError);
        this.child?.off('exit', this.onExit);
        this.child?.off('disconnect', this.onDisconnect);
    }
}
