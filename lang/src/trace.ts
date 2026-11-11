import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { Failure, type StatusCode } from './errors.js';
import { isTraceError } from './recording.js';

export interface TraceContext {
    source: string;
    runtime: string;
    cwd: string;
    args?: readonly string[];
    configuration?: unknown;
}

interface Header {
    format: 'spl-trace';
    version: 2;
    source: string;
    runtime: string;
    cwd: string;
    args: string[];
    configuration: string;
}

type Outcome = { value: unknown } | { error: { status_code: StatusCode; reason: string } };
type Event =
    | { type: 'intent'; sequence: number; request: string }
    | { type: 'outcome'; sequence: number; outcome: Outcome }
    | { type: 'environment'; value: Record<string, string> }
    | { type: 'terminal'; result: string };

export class TraceError extends Error {
    constructor(message: string, readonly kind: 'usage' | 'infrastructure' = 'usage') {
        super(message);
        this.name = 'TraceError';
    }
}

const record = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
const strings = (value: unknown): value is string[] =>
    Array.isArray(value) && value.every(item => typeof item === 'string');
const integer = (value: unknown): value is number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

function canonical(value: unknown): string {
    if (typeof value === 'bigint') return `${value}n`;
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (record(value)) return `{${Object.keys(value).filter(key => value[key] !== undefined).sort()
        .map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
    const json = JSON.stringify(value);
    if (json === undefined) throw new TraceError('trace contains a non-serializable value', 'infrastructure');
    return json;
}

export function fingerprint(value: unknown): string {
    return createHash('sha256').update(canonical(value)).digest('hex');
}

function identity(context: TraceContext) {
    return {
        source: fingerprint(context.source.replace(/\r\n/g, '\n')),
        runtime: context.runtime,
        cwd: fs.realpathSync.native(path.resolve(context.cwd)),
        configuration: fingerprint(context.configuration ?? null),
    };
}

function parseHeader(value: unknown): Header {
    if (!record(value) || value.format !== 'spl-trace' || value.version !== 2
        || typeof value.source !== 'string' || typeof value.runtime !== 'string'
        || typeof value.cwd !== 'string' || !strings(value.args) || typeof value.configuration !== 'string') {
        throw new TraceError('unsupported or invalid trace header; choose a new JSONL file to restart');
    }
    return { format: value.format, version: value.version, source: value.source, runtime: value.runtime,
        cwd: value.cwd, args: value.args, configuration: value.configuration };
}

function parseEvent(value: unknown): Event {
    if (record(value)) {
        switch (value.type) {
            case 'intent':
                if (integer(value.sequence) && typeof value.request === 'string') {
                    return { type: value.type, sequence: value.sequence, request: value.request };
                }
                break;
            case 'outcome':
                if (integer(value.sequence) && record(value.outcome)) {
                    if (Object.hasOwn(value.outcome, 'value') && !Object.hasOwn(value.outcome, 'error')) {
                        return { type: value.type, sequence: value.sequence, outcome: { value: value.outcome.value } };
                    }
                    if (!Object.hasOwn(value.outcome, 'value') && isTraceError(value.outcome.error)) {
                        return { type: value.type, sequence: value.sequence, outcome: { error: value.outcome.error } };
                    }
                }
                break;
            case 'environment':
                if (record(value.value) && Object.values(value.value).every(item => typeof item === 'string')) {
                    const environment: Record<string, string> = {};
                    for (const [key, item] of Object.entries(value.value)) {
                        if (typeof item === 'string') Object.defineProperty(environment, key, { value: item, enumerable: true });
                    }
                    return { type: value.type, value: environment };
                }
                break;
            case 'terminal':
                if (typeof value.result === 'string') return { type: value.type, result: value.result };
        }
    }
    throw new TraceError('invalid trace event');
}

function validateHistory(events: Event[]): void {
    let sequence = 0;
    let pending: number | undefined;
    let terminal = false;
    let environment = false;
    for (const event of events) {
        if (terminal) throw new TraceError('events after terminal trace state');
        if (pending !== undefined && event.type !== 'outcome') throw new TraceError('unresolved trace effect before another event');
        switch (event.type) {
            case 'intent':
                if (event.sequence !== sequence++) throw new TraceError('invalid trace effect sequence');
                pending = event.sequence;
                break;
            case 'outcome':
                if (pending === undefined || pending !== event.sequence) throw new TraceError('trace outcome without matching intent');
                pending = undefined;
                break;
            case 'environment':
                if (environment) throw new TraceError('duplicate trace environment');
                environment = true;
                break;
            case 'terminal':
                terminal = true;
        }
    }
}

function retryable(request: unknown): boolean {
    if (!record(request)) return false;
    return request.kind === 'modules' || request.kind === 'human' || request.kind === 'natural' || request.kind === 'restriction' || request.kind === 'environment-value'
        || request.kind === 'llm' && record(request.request) && request.request.kind !== 'agent'
        || request.kind === 'tool' && ['read_file', 'web_fetch', 'web_search'].includes(String(request.tool));
}

/** Reconstructs local execution, replaying sealed effects before appending new work. */
export class Trace {
    private position = 0;
    private sequence: number;
    private closed = false;
    private poisoned = false;
    private finished = false;
    private observedEnvironment = false;

    private constructor(
        readonly file: string,
        private readonly fd: number,
        private readonly lock: number,
        private readonly header: Header,
        private readonly events: Event[],
    ) {
        this.sequence = events.filter(event => event.type === 'intent').length;
    }

    static open(file: string, context: TraceContext): Trace {
        const resolved = path.resolve(file);
        const lock = this.acquire(resolved);
        let fd: number | undefined;
        try {
            if (!fs.existsSync(resolved)) {
                const header: Header = { format: 'spl-trace', version: 2, ...identity(context), args: [...(context.args ?? [])] };
                fd = fs.openSync(resolved, 'ax', 0o600);
                const trace = new Trace(resolved, fd, lock, header, []);
                trace.write(header);
                return trace;
            }
            const text = fs.readFileSync(resolved, 'utf8');
            if (!text.endsWith('\n')) throw new TraceError('truncated trace; no bytes were changed; choose a new JSONL file to restart');
            const lines = text.slice(0, -1).split('\n');
            const header = parseHeader(JSON.parse(lines.shift() ?? '') as unknown);
            const expected = identity(context);
            for (const key of ['source', 'runtime', 'cwd', 'configuration'] as const) {
                if (expected[key] !== header[key]) throw new TraceError(`trace ${key} mismatch; choose a new JSONL file to restart`);
            }
            if (context.args !== undefined && canonical(context.args) !== canonical(header.args)) {
                throw new TraceError('trace script arguments mismatch; choose a new JSONL file to restart');
            }
            const events = lines.map(line => parseEvent(JSON.parse(line) as unknown));
            validateHistory(events);
            fd = fs.openSync(resolved, 'a');
            return new Trace(resolved, fd, lock, header, events);
        } catch (error) {
            if (fd !== undefined) fs.closeSync(fd);
            fs.closeSync(lock);
            fs.unlinkSync(`${resolved}.lock`);
            if (error instanceof TraceError) throw error;
            throw new TraceError(`cannot open trace: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private static acquire(file: string): number {
        const lockFile = `${file}.lock`;
        try {
            try {
                const fd = fs.openSync(lockFile, 'wx', 0o600);
                try { fs.writeFileSync(fd, String(process.pid)); }
                catch (error) { fs.closeSync(fd); fs.unlinkSync(lockFile); throw error; }
                return fd;
            } catch (error) {
                if (!record(error) || error.code !== 'EEXIST') throw error;
                const pid = Number(fs.readFileSync(lockFile, 'utf8'));
                if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('invalid writer lock; manual recovery required');
                try {
                    process.kill(pid, 0);
                } catch (probe) {
                    if (!record(probe) || probe.code !== 'ESRCH') throw probe;
                    fs.unlinkSync(lockFile);
                    return this.acquire(file);
                }
                throw new Error(`another trace writer is running (PID ${pid})`);
            }
        } catch (error) {
            throw new TraceError(`cannot lock trace: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    get args(): readonly string[] { return [...this.header.args]; }
    get replaying(): boolean {
        const event = this.events[this.position];
        return event?.type === 'environment' || event?.type === 'intent' && this.events[this.position + 1]?.type === 'outcome';
    }
    get environment(): Record<string, string> | undefined {
        const event = this.events.find(event => event.type === 'environment');
        return event?.type === 'environment' ? structuredClone(event.value) : undefined;
    }

    private write(value: Header | Event): void {
        this.assertActive();
        try {
            fs.writeFileSync(this.fd, JSON.stringify(value) + '\n');
            fs.fsyncSync(this.fd);
        } catch (error) {
            this.poisoned = true;
            throw new TraceError(`cannot durably append trace: ${error instanceof Error ? error.message : String(error)}`, 'infrastructure');
        }
    }

    private append(event: Event): void {
        this.write(event);
        this.events.push(event);
        this.position = this.events.length;
    }

    observeEnvironment(environment: Record<string, unknown>): void {
        this.assertActive();
        if (this.observedEnvironment) return;
        const next = this.events[this.position];
        if (next?.type === 'environment') this.position++;
        else {
            this.assertAtEnd();
            const value: Record<string, string> = {};
            for (const [key, item] of Object.entries(environment)) {
                if (typeof item !== 'string') throw new TraceError('invalid trace environment value', 'infrastructure');
                Object.defineProperty(value, key, { value: item, enumerable: true });
            }
            this.append({ type: 'environment', value });
        }
        this.observedEnvironment = true;
    }

    assertLive(request: unknown): void {
        this.assertActive();
        const event = this.events[this.position];
        if (!event) return;
        if (event.type === 'intent' && event.request === canonical(request)
            && this.position + 1 === this.events.length && retryable(request)) return;
        throw new TraceError('trace effect history mismatch; cannot continue with live work');
    }

    async effect<T>(request: unknown, perform: () => T | Promise<T>, valid: (value: unknown) => value is T): Promise<T> {
        this.assertActive();
        const key = canonical(request);
        const intent = this.events[this.position];
        let sequence: number;
        if (intent) {
            if (intent.type !== 'intent' || intent.request !== key) throw new TraceError('trace effect history mismatch');
            const event = this.events[this.position + 1];
            if (event) {
                if (event.type !== 'outcome' || event.sequence !== intent.sequence) throw new TraceError('trace outcome history mismatch');
                this.position += 2;
                if ('error' in event.outcome) throw new Failure(event.outcome.error.status_code, event.outcome.error.reason);
                if (!valid(event.outcome.value)) throw new TraceError('invalid recorded trace effect result');
                return structuredClone(event.outcome.value);
            }
            if (!retryable(request)) throw new TraceError('trace has an unresolved effect; its side effects may have occurred; manual recovery required');
            sequence = intent.sequence;
            this.position++;
        } else {
            sequence = this.sequence++;
            this.append({ type: 'intent', sequence, request: key });
        }
        let outcome: Outcome;
        try {
            const value = await perform();
            if (!valid(value)) throw new TraceError('invalid live trace effect result', 'infrastructure');
            outcome = { value };
        } catch (error) {
            if (!(error instanceof Failure)) {
                this.poisoned = true;
                if (error instanceof TraceError) throw error;
                throw new TraceError(`trace effect interrupted: ${error instanceof Error ? error.message : String(error)}`, 'infrastructure');
            }
            outcome = { error: { status_code: error.statusCode, reason: error.reason } };
        }
        this.append({ type: 'outcome', sequence, outcome });
        if ('error' in outcome) throw new Failure(outcome.error.status_code, outcome.error.reason);
        if (!valid(outcome.value)) throw new TraceError('invalid trace effect result', 'infrastructure');
        return outcome.value;
    }

    assertConsumed(): void {
        if (this.position < this.events.length && this.events[this.position].type !== 'terminal') {
            throw new TraceError('trace ended with unused history');
        }
    }

    finish(result: unknown): void {
        this.assertActive();
        this.assertConsumed();
        const terminal = this.events[this.position];
        const value = canonical(result);
        if (terminal) {
            if (terminal.type !== 'terminal' || terminal.result !== value) throw new TraceError('trace completion mismatch');
            this.position++;
        } else this.append({ type: 'terminal', result: value });
        this.finished = true;
    }

    validateSource(source: string, args?: readonly string[]): void {
        if (fingerprint(source.replace(/\r\n/g, '\n')) !== this.header.source) throw new TraceError('trace source mismatch');
        if (args !== undefined && canonical(args) !== canonical(this.header.args)) throw new TraceError('trace script arguments mismatch');
    }

    private assertAtEnd(): void {
        if (this.position !== this.events.length) throw new TraceError('trace effect history mismatch');
    }

    private assertActive(): void {
        if (this.closed || this.poisoned || this.finished) throw new TraceError('trace is closed or unusable', 'infrastructure');
    }

    cancel(): void {
        this.poisoned = true;
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        try { fs.closeSync(this.fd); }
        finally {
            fs.closeSync(this.lock);
            fs.unlinkSync(`${this.file}.lock`);
        }
    }
}
