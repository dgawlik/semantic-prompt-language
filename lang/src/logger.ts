import { randomUUID } from 'node:crypto';
import { freezeEvent, type BodySegment, type LogEvent, type LogEventSink, type ModelInteraction, type ModelStreamEvent, type ModelStreamSink, type StateChange } from './log-events.js';
import { formatEvent, formatSegments, sanitize, stateSegments, terminalColor, valueSegments } from './log-format.js';

export type LogLevel = 'error' | 'info' | 'debug';

export interface LoggerOptions {
    /** Override terminal/environment color detection. Custom sinks default to plain text. */
    color?: boolean;
    eventSink?: LogEventSink;
    /** Transient model previews, separate from the immutable expanded transcript. */
    streamSink?: ModelStreamSink;
}

const RANK: Record<LogLevel, number> = { error: 0, info: 1, debug: 2 };
const stderr = (line: string): void => { process.stderr.write(line + '\n'); };
type EventDetail =
    | { kind: 'error' | 'warning' | 'info' | 'debug'; origin: 'diagnostic' | 'script' }
    | { kind: 'generic'; origin: 'embedding'; label: string }
    | { kind: 'model-input' | 'model-output'; origin: 'model'; interaction: ModelInteraction };

/** Logs go to stderr so that stdout carries only the script result. */
export class Logger {
    private readonly color: boolean;
    private readonly sessionId = randomUUID();
    private sequence = 0;
    private nextId = 0;

    constructor(
        private level: LogLevel | 'silent' = 'info',
        private readonly sink: (line: string) => void = stderr,
        private readonly options: LoggerOptions = {},
    ) {
        this.color = options.color ?? (sink === stderr && terminalColor());
    }

    get observesState(): boolean { return this.level !== 'silent'; }
    get streamsModels(): boolean { return this.level !== 'silent' && this.options.streamSink !== undefined; }

    modelStream(event: ModelStreamEvent): void {
        if (!this.streamsModels) return;
        const interaction = Object.freeze({ ...event.interaction });
        const detached: ModelStreamEvent = event.type === 'update'
            ? { ...event, interaction, update: Object.freeze({ ...event.update, text: sanitize(event.update.text) }) }
            : event.outcome === 'completed'
                ? { ...event, interaction, response: sanitize(event.response),
                    ...(event.reasoning !== undefined ? { reasoning: sanitize(event.reasoning) } : {}) }
                : { ...event, interaction };
        this.options.streamSink!(Object.freeze(detached));
    }

    private emit(min: LogLevel, detail: EventDetail, msg: unknown, values: readonly unknown[] = [], raw = false, preface = ''): void {
        if (this.level === 'silent' || RANK[this.level] < RANK[min]) return;
        const id = `${this.sessionId}:${++this.nextId}`;
        const segments: BodySegment[] = [];
        if (preface) {
            segments.push({ type: 'preface', payloadId: `${id}:preface`, source: sanitize(preface), summary: 'Generated preface [folded]' });
        }
        [msg, ...values].forEach((value, index) => {
            const parts = valueSegments(value, id, String(index), raw);
            if (index) segments.push({ type: 'text', text: detail.kind === 'generic' || formatSegments(parts).includes('\n') ? '\n' : ' ' });
            segments.push(...parts);
        });
        this.deliver(freezeEvent({ id, sequence: ++this.sequence, segments, ...detail }));
    }

    private deliver(event: LogEvent): void {
        if (this.options.eventSink) this.options.eventSink(event);
        else this.sink(formatEvent(event, this.color));
    }

    error(msg: unknown, ...values: unknown[]): void {
        this.emit('error', { kind: 'error', origin: msg === 'log:' ? 'script' : 'diagnostic' }, msg, values);
    }

    warn(msg: unknown, ...values: unknown[]): void {
        this.emit('info', { kind: 'warning', origin: 'diagnostic' }, msg, values);
    }

    info(msg: unknown, ...values: unknown[]): void {
        this.emit('info', { kind: 'info', origin: msg === 'log:' ? 'script' : 'diagnostic' }, msg, values);
    }

    debug(msg: unknown, ...values: unknown[]): void {
        this.emit('debug', { kind: 'debug', origin: msg === 'log:' ? 'script' : 'diagnostic' }, msg, values);
    }

    llm(msg: unknown, ...values: unknown[]): void {
        this.emit('error', { kind: 'generic', origin: 'embedding', label: 'message' }, msg, values);
    }

    modelInput(interaction: ModelInteraction, msg: unknown, ...values: unknown[]): void {
        this.emit('error', { kind: 'model-input', origin: 'model', interaction: { ...interaction } }, msg, values);
    }

    modelPrompt(interaction: ModelInteraction, prompt: string, preface: string): void {
        if (!prompt.startsWith(preface)) throw new Error('model prompt must start with its generated preface');
        this.emit('error', { kind: 'model-input', origin: 'model', interaction: { ...interaction } },
            prompt.slice(preface.length), [], false, preface);
    }

    modelOutput(interaction: ModelInteraction, msg: unknown, ...values: unknown[]): void {
        this.emit('error', { kind: 'model-output', origin: 'model', interaction: { ...interaction } }, msg, values);
    }

    state(snapshot: () => StateChange): void {
        if (!this.observesState) return;
        const change = snapshot();
        const id = `${this.sessionId}:${++this.nextId}`;
        const segments = stateSegments(change, id);
        this.deliver(freezeEvent({ id, sequence: ++this.sequence, kind: 'state', origin: 'state', change, segments }));
    }

    /** @deprecated Explicit embedding compatibility only; execution never calls this helper. */
    deterministic(msg: string): void {
        this.emit('error', { kind: 'generic', origin: 'embedding', label: 'message' }, msg, [], true);
    }
}
