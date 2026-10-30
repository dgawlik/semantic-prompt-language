import { fileURLToPath } from 'node:url';
import type { CliRenderer } from '@bettertui/core';
import { RendererProtocol, type ChildMessage, type LogEvent, type ModelStreamEvent } from './log-events.js';
import { eventHeader, formatSegments, paint, prettyJson, sanitize } from './log-format.js';

interface ProbeInput {
    setRawMode(mode: boolean): void;
    resume(): void;
    pause(): void;
    on(event: 'data', listener: (chunk: Buffer) => void): unknown;
    off(event: 'data', listener: (chunk: Buffer) => void): unknown;
}

export async function probeTerminalModes(input: ProbeInput, write: (text: string) => void, raw: boolean,
    interrupt: () => void): Promise<{ cursorVisible: boolean }> {
    let onData: ((chunk: Buffer) => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        input.setRawMode(true);
        input.resume();
        return await new Promise((resolve, reject) => {
            let response = '';
            const modes = new Map<number, boolean>();
            onData = chunk => {
                response += chunk.toString('utf8');
                if (response.length > 4096) { reject(new Error('terminal mode response is too large')); return; }
                if (response.includes('\u0003')) {
                    interrupt();
                    reject(new Error('terminal probing interrupted'));
                    return;
                }
                for (const match of response.matchAll(/\u001b\[\?(25|1049);([0-4])\$y/g)) {
                    const status = Number(match[2]);
                    if (status === 0) { reject(new Error('terminal mode restoration is unsupported')); return; }
                    if (match[1] === '1049' && status === 4) { reject(new Error('terminal alternate screen is unavailable')); return; }
                    modes.set(Number(match[1]), status === 1 || status === 3);
                }
                if (modes.size !== 2) return;
                if (modes.get(1049)) { reject(new Error('terminal alternate screen is already active; cannot preserve its contents')); return; }
                resolve({ cursorVisible: modes.get(25)! });
            };
            input.on('data', onData);
            timer = setTimeout(() => reject(new Error('terminal mode query timed out; safe restoration is unavailable')), 250);
            write('\u001b[?25$p\u001b[?1049$p');
        });
    } finally {
        clearTimeout(timer);
        if (onData) input.off('data', onData);
        input.setRawMode(raw);
        input.pause();
    }
}

export async function createEventView(renderer: CliRenderer, color: boolean,
    onError: (error: unknown) => void = error => { throw error; }) {
    const { Text, measureText } = await import('@bettertui/core');
    const spinnerFrames = ['\u280b', '\u2819', '\u2839', '\u2838', '\u283c', '\u2834', '\u2826', '\u2827', '\u2807', '\u280f'];
    let spinnerFrame = 0;
    let elapsed = 0;
    const lines: InstanceType<typeof Text>[] = [];
    const history: LogEvent[] = [];
    const streams = new Map<string, { interaction: ModelStreamEvent['interaction']; channel: 'response' | 'reasoning'; messageId: string; text: string }>();
    const collapsedByPayload = new Map<string, boolean>();
    const payloadOwners = new Map<string, LogEvent>();
    const expanded = new Map<string, string>();
    const cache = new Map<LogEvent, { width: number; rows: string[]; offsets: Map<string, number> }>();
    const characterWidths = new Map<string, number>();
    const hint = 'Up/Down select | Enter/Space fold | PgUp/PgDn scroll | Home/End';
    const wrap = (source: string, width: number): string[] => {
        const rows: string[] = [];
        let row = '';
        let columns = 0;
        let style = '';
        for (const token of source.match(/\u001b\[[\d;]*m|[^\u001b]/gu) ?? []) {
            if (token.startsWith('\u001b')) {
                style = token === '\u001b[0m' ? '' : token;
                row += token;
            } else if (token === '\n') {
                rows.push(row);
                row = style;
                columns = 0;
            } else {
                let size = token.charCodeAt(0) < 128 ? 1 : characterWidths.get(token);
                if (size === undefined) { size = measureText({ text: token }).width; characterWidths.set(token, size); }
                if (columns && columns + size > width) {
                    rows.push(row + (style ? '\u001b[0m' : ''));
                    row = style;
                    columns = 0;
                }
                row += token;
                columns += size;
            }
        }
        rows.push(row);
        return rows;
    };
    const view = {
        history: history as readonly LogEvent[],
        streams,
        collapsedByPayload,
        selectedPayloadId: undefined as string | undefined,
        scrollPosition: 0,
        followingTail: true,
        width: renderer.terminalWidth,
        height: renderer.terminalHeight,
        rows: [] as string[],
        payloadRows: new Map<string, number>(),
        append(event: LogEvent): void {
            history.push(event);
            for (const part of event.segments) {
                if (part.type !== 'json' && part.type !== 'preface') continue;
                collapsedByPayload.set(part.payloadId, true);
                payloadOwners.set(part.payloadId, event);
                this.selectedPayloadId ??= part.payloadId;
            }
            this.render();
        },
        stream(event: ModelStreamEvent): void {
            if (event.type === 'end') {
                for (const [key, stream] of streams) {
                    if (stream.interaction.requestId === event.interaction.requestId) streams.delete(key);
                }
            } else {
                const { update } = event;
                const key = `${event.interaction.requestId}:${update.channel}`;
                const previous = streams.get(key);
                streams.set(key, {
                    interaction: event.interaction, channel: update.channel, messageId: update.messageId,
                    text: update.mode === 'append' && previous?.messageId === update.messageId ? previous.text + update.text : update.text,
                });
            }
            this.render();
        },
        render(revealSelection = false): void {
            this.width = Math.max(1, renderer.terminalWidth);
            this.height = Math.max(2, renderer.terminalHeight);
            this.rows = [];
            this.payloadRows.clear();
            for (const event of history) {
                let cached = cache.get(event);
                if (!cached || cached.width !== this.width) {
                    let content = `${eventHeader(event, color)} `;
                    const offsets = new Map<string, number>();
                    for (const part of event.segments) {
                        if (part.type !== 'json' && part.type !== 'preface') { content += part.text; continue; }
                        if (!content.endsWith('\n')) content += '\n';
                        offsets.set(part.payloadId, wrap(content, this.width).length - 1);
                        const selected = this.selectedPayloadId === part.payloadId ? '>' : ' ';
                        if (collapsedByPayload.get(part.payloadId)) {
                            const summary = `${selected} [+] ${part.summary}`;
                            content += summary.length <= this.width ? summary
                                : `${selected}+ ${part.type === 'preface' ? 'preface' : part.container === 'object' ? '{}' : '[]'}`.slice(0, this.width);
                        }
                        else {
                            let formatted = expanded.get(part.payloadId);
                            if (formatted === undefined) {
                                formatted = part.type === 'json' ? prettyJson(part.source, color)! : formatSegments([part], color);
                                expanded.set(part.payloadId, formatted);
                            }
                            content += `${selected} [-] ${formatted}`;
                        }
                    }
                    cached = { width: this.width, rows: wrap(content, this.width), offsets };
                    cache.set(event, cached);
                }
                for (const [id, row] of cached.offsets) this.payloadRows.set(id, this.rows.length + row);
                this.rows.push(...cached.rows);
            }
            for (const stream of streams.values()) {
                const header = stream.channel === 'response'
                    ? paint(`<- output ${stream.interaction.kind} [streaming]`, 36, color, true)
                    : paint(`i info reasoning ${stream.interaction.kind} [streaming]`, 34, color, true);
                this.rows.push(...wrap(`${header} ${stream.text}`, this.width));
            }
            this.rows.push(paint(spinnerFrames[spinnerFrame], 90, color));
            const hintRows = wrap(hint, this.width).slice(0, Math.max(1, this.height - 1));
            const page = Math.max(1, this.height - hintRows.length);
            const max = Math.max(0, this.rows.length - page);
            if (this.followingTail) this.scrollPosition = max;
            if (revealSelection && this.selectedPayloadId) {
                const row = this.payloadRows.get(this.selectedPayloadId);
                if (row !== undefined && (row < this.scrollPosition || row >= this.scrollPosition + page)) this.scrollPosition = row;
            }
            this.scrollPosition = Math.max(0, Math.min(max, this.scrollPosition));
            const visible = [...this.rows.slice(this.scrollPosition, this.scrollPosition + page), ...hintRows];
            while (lines.length > visible.length) lines.pop()!.destroy();
            for (const [row, content] of visible.entries()) {
                if (!lines[row]) {
                    lines[row] = new Text(renderer, { content: '', position: 'absolute', top: row, left: 0,
                        width: '100%', height: 1, wrapMode: 'none' });
                    renderer.root.add(lines[row]);
                }
                lines[row].content = content;
            }
            renderer.requestRender();
        },
        key(name: string): void {
            const ids = [...collapsedByPayload.keys()];
            const old = this.selectedPayloadId;
            const index = old === undefined ? 0 : ids.indexOf(old);
            let reveal = false;
            const page = Math.max(1, this.height - wrap(hint, this.width).length);
            if (name === 'up' || name === 'down') {
                this.selectedPayloadId = ids[Math.max(0, Math.min(ids.length - 1, index + (name === 'up' ? -1 : 1)))];
                this.followingTail = false;
                reveal = true;
            } else if (name === 'return' || name === 'enter' || name === 'space' || name === ' ') {
                if (old) { collapsedByPayload.set(old, !collapsedByPayload.get(old)); cache.delete(payloadOwners.get(old)!); }
                this.followingTail = false;
                reveal = true;
            } else if (name === 'pageup' || name === 'pagedown') {
                this.scrollPosition += name === 'pageup' ? -page : page;
                this.followingTail = false;
            } else if (name === 'home' || name === 'end') {
                this.selectedPayloadId = name === 'home' ? ids[0] : ids.at(-1);
                this.scrollPosition = name === 'home' ? 0 : this.rows.length;
                this.followingTail = name === 'end';
                reveal = true;
            } else return;
            if (old) cache.delete(payloadOwners.get(old)!);
            if (this.selectedPayloadId) cache.delete(payloadOwners.get(this.selectedPayloadId)!);
            this.render(reveal);
        },
        destroy(): void {
            renderer.removeFrameCallback(onFrame);
            renderer.keyHandler.off('keypress', onKey);
            renderer.off('resize', onResize);
            for (const line of lines) line.destroy();
        },
    };
    const onKey = (key: { name: string; ctrl: boolean; preventDefault(): void }): void => {
        if (!key.ctrl) view.key(key.name);
    };
    const onResize = (): void => { view.render(); };
    const onFrame = (delta: number): void => {
        elapsed += delta;
        if (elapsed < 100) return;
        spinnerFrame = (spinnerFrame + Math.floor(elapsed / 100)) % spinnerFrames.length;
        elapsed %= 100;
        try { view.render(); }
        catch (error) { onError(error); }
    };
    renderer.keyHandler.on('keypress', onKey);
    renderer.on('resize', onResize);
    view.render();
    renderer.setFrameCallback(onFrame);
    return view;
}

async function main(): Promise<void> {
    const protocol = new RendererProtocol();
    let sessionId: string | undefined;
    let renderer: CliRenderer | undefined;
    let view: Awaited<ReturnType<typeof createEventView>> | undefined;
    let raw = false;
    let cursorVisible: boolean | undefined;
    let initialize: Extract<ReturnType<RendererProtocol['accept']>, { type: 'initialize' }> | undefined;
    let closed = false;
    let pending = Promise.resolve();
    const send = (message: ChildMessage, disconnect = false): void => {
        if (!process.connected) return;
        process.send!(message, error => {
            if (error) {
                try { cleanup(); }
                finally {
                    process.stderr.write(`x error renderer IPC: ${sanitize(error.message)}\n`);
                    if (process.connected) process.disconnect?.();
                }
            } else if (disconnect && process.connected) process.disconnect?.();
        });
    };
    const cleanup = (): void => {
        if (closed) return;
        closed = true;
        try { view?.destroy(); }
        finally {
            try { renderer?.destroy(); }
            finally {
                if (process.stdin.isTTY) process.stdin.setRawMode?.(raw);
                process.stdin.pause();
                if (cursorVisible !== undefined) process.stdout.write(`\u001b[?1049l\u001b[?25${cursorVisible ? 'h' : 'l'}`);
            }
        }
    };
    const fatal = (stage: 'startup' | 'protocol' | 'rendering', error: unknown): void => {
        let diagnostic = error instanceof Error ? error.message : String(error);
        let failureStage: 'startup' | 'protocol' | 'rendering' | 'restoration' = stage;
        try { cleanup(); }
        catch (restorationError) {
            failureStage = 'restoration';
            diagnostic += `; cleanup: ${restorationError instanceof Error ? restorationError.message : String(restorationError)}`;
        }
        if (sessionId) send({ version: 1, sessionId, type: 'fatal', stage: failureStage, diagnostic: sanitize(diagnostic) }, true);
        else {
            process.stderr.write(`x error renderer ${failureStage}: ${sanitize(diagnostic)}\n`);
            if (process.connected) process.disconnect?.();
        }
    };
    const handle = async (input: unknown): Promise<void> => {
        let message;
        try { message = protocol.accept(input); }
        catch (error) { fatal('protocol', error); return; }
        sessionId = message.sessionId;
        if (message.type === 'initialize') {
            try {
                if (!process.stdin.isTTY || !process.stdout.isTTY || typeof process.stdin.setRawMode !== 'function') {
                    throw new Error('restorable terminal stdin and stderr are required');
                }
                raw = message.terminal.raw;
                const modes = await probeTerminalModes(process.stdin, text => { process.stdout.write(text); }, raw,
                    () => send({ version: 1, sessionId: message.sessionId, type: 'cancel', reason: 'interrupt' }));
                initialize = message;
                cursorVisible = modes.cursorVisible;
                send({ version: 1, sessionId, type: 'prepared', cursorVisible: modes.cursorVisible });
            } catch (error) { fatal('startup', error); }
        } else if (message.type === 'activate') {
            try {
                if (!initialize) throw new Error('terminal restoration state is unavailable');
                // The parent owns this snapshot before native code can change terminal modes.
                const initial = initialize;
                const { createCliRenderer } = await import('@bettertui/core');
                renderer = await createCliRenderer({
                    autoStart: false, exitOnCtrlC: false, useMouse: false, autoFocus: false,
                    screenMode: 'alternate-screen', externalOutputMode: 'passthrough',
                    width: initial.terminal.width, height: initial.terminal.height,
                });
                view = await createEventView(renderer, initial.color, error => fatal('rendering', error));
                renderer.keyHandler.on('keypress', key => {
                    if (key.ctrl && key.name === 'c') {
                        key.preventDefault();
                        send({ version: 1, sessionId: message.sessionId, type: 'cancel', reason: 'interrupt' });
                    }
                });
                renderer.start();
                send({ version: 1, sessionId, type: 'ready', restored: true });
            } catch (error) { fatal('startup', error); }
        } else if (message.type === 'event') {
            try {
                view!.append(message.event);
                send({ version: 1, sessionId, type: 'accepted', sequence: message.sequence });
            } catch (error) { fatal('rendering', error); }
        } else if (message.type === 'stream') {
            try { view!.stream(message.event); }
            catch (error) { fatal('rendering', error); }
        } else {
            try {
                cleanup();
                send({ version: 1, sessionId, type: 'finished', lastSequence: message.lastSequence, restored: true }, true);
            } catch (error) { fatal('rendering', error); }
        }
    };
    process.on('message', input => { pending = pending.then(() => handle(input)).catch(error => { fatal('rendering', error); }); });
    process.once('disconnect', cleanup);
    process.once('SIGTERM', () => {
        try { cleanup(); }
        finally { if (process.connected) process.disconnect?.(); }
    });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    void main();
}
