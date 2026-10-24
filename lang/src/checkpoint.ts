import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Failure, type StatusCode } from './errors.js';
import { isTraceError } from './recording.js';

export interface CheckpointContext {
    source: string;
    runtime: string;
    cwd: string;
    args?: readonly string[];
    configuration?: unknown;
}

export interface HumanRequest {
    run_id: string;
    request_id: string;
    question: string;
    checkpoint: string;
    line: number;
}

interface Header {
    format: 'spl-checkpoint';
    version: 1;
    run_id: string;
    source: string;
    runtime: string;
    cwd: string;
    args: string[];
    configuration: string;
}

type Outcome = { value: unknown } | { error: { status_code: StatusCode; reason: string } };
type Question = { type: 'question'; request_id: string; question: string; line: number };
type Event =
    | { type: 'intent'; sequence: number; request: string }
    | { type: 'outcome'; sequence: number; outcome: Outcome }
    | { type: 'environment'; fingerprint: string }
    | Question
    | { type: 'answer'; request_id: string; value: string }
    | { type: 'terminal'; status: 'success' | 'failure' };

export class CheckpointError extends Error {
    constructor(message: string, readonly kind: 'usage' | 'infrastructure' = 'usage') {
        super(message);
        this.name = 'CheckpointError';
    }
}

export class SuspensionSignal {
    constructor(readonly request: HumanRequest) {}
}

const record = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
const strings = (value: unknown): value is string[] =>
    Array.isArray(value) && value.every((item) => typeof item === 'string');
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

function canonical(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (record(value)) return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
    const json = JSON.stringify(value);
    if (json === undefined) throw new CheckpointError('checkpoint identity contains an unsupported value', 'infrastructure');
    return json;
}

export function checkpointFingerprint(value: unknown): string {
    return createHash('sha256').update(canonical(value)).digest('hex');
}

function environmentFingerprint(): string {
    return checkpointFingerprint(Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)));
}

function identity(context: CheckpointContext) {
    return {
        source: checkpointFingerprint(context.source.replace(/\r\n/g, '\n')),
        runtime: context.runtime,
        cwd: fs.realpathSync.native(path.resolve(context.cwd)),
        configuration: checkpointFingerprint(context.configuration ?? null),
    };
}

function parseHeader(value: unknown): Header {
    if (!record(value) || value.format !== 'spl-checkpoint' || value.version !== 1
        || typeof value.run_id !== 'string' || !value.run_id
        || typeof value.source !== 'string' || typeof value.runtime !== 'string'
        || typeof value.cwd !== 'string' || !strings(value.args) || typeof value.configuration !== 'string') {
        throw new CheckpointError('unsupported or invalid checkpoint header');
    }
    return {
        format: value.format, version: value.version, run_id: value.run_id, source: value.source,
        runtime: value.runtime, cwd: value.cwd, args: value.args, configuration: value.configuration,
    };
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
                if (typeof value.fingerprint === 'string') return { type: value.type, fingerprint: value.fingerprint };
                break;
            case 'question':
                if (typeof value.request_id === 'string' && value.request_id && typeof value.question === 'string' && integer(value.line)) {
                    return { type: value.type, request_id: value.request_id, question: value.question, line: value.line };
                }
                break;
            case 'answer':
                if (typeof value.request_id === 'string' && typeof value.value === 'string') {
                    return { type: value.type, request_id: value.request_id, value: value.value };
                }
                break;
            case 'terminal':
                if (value.status === 'success' || value.status === 'failure') return { type: value.type, status: value.status };
        }
    }
    throw new CheckpointError('invalid checkpoint event');
}

function validateHistory(events: Event[]): Question {
    let sequence = 0;
    let intent: number | undefined;
    let pending: Question | undefined;
    let terminal = false;
    let environment = false;
    const requests = new Set<string>();
    for (const event of events) {
        if (terminal) throw new CheckpointError('events after terminal checkpoint state');
        if (intent !== undefined && event.type !== 'outcome') throw new CheckpointError('checkpoint has an unresolved effect');
        if (pending && event.type !== 'answer') throw new CheckpointError('checkpoint has an unanswered question');
        switch (event.type) {
            case 'intent':
                if (event.sequence !== sequence++) throw new CheckpointError('invalid checkpoint effect sequence');
                intent = event.sequence;
                break;
            case 'outcome':
                if (intent === undefined || intent !== event.sequence) throw new CheckpointError('outcome without matching checkpoint intent');
                intent = undefined;
                break;
            case 'question':
                if (requests.has(event.request_id)) throw new CheckpointError('duplicate checkpoint request ID');
                requests.add(event.request_id);
                pending = event;
                break;
            case 'answer':
                if (!pending || pending.request_id !== event.request_id) throw new CheckpointError('answer without matching checkpoint question');
                pending = undefined;
                break;
            case 'environment':
                if (environment) throw new CheckpointError('duplicate checkpoint environment');
                environment = true;
                if (event.fingerprint !== environmentFingerprint()) throw new CheckpointError('checkpoint environment mismatch');
                break;
            case 'terminal':
                terminal = true;
        }
    }
    if (terminal) throw new CheckpointError('checkpoint run is already terminal');
    if (intent !== undefined) throw new CheckpointError('checkpoint has an unresolved effect; manual recovery required');
    if (!pending) throw new CheckpointError('checkpoint run was interrupted; manual recovery required');
    return pending;
}

function ioMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** A single-writer effect history. Only sealed human-input boundaries can resume. */
export class Checkpoint {
    private position = 0;
    private readonly replayLength: number;
    private sequence: number;
    private observedEnvironment = false;
    private pending?: Question;
    private closed = false;
    private poisoned = false;
    private terminal = false;

    private constructor(
        readonly file: string,
        private readonly fd: number,
        private readonly lock: number,
        private readonly header: Header,
        private readonly events: Event[],
        pending?: Question,
    ) {
        this.pending = pending;
        this.replayLength = events.length;
        this.sequence = events.filter((event) => event.type === 'intent').length;
    }

    static create(file: string, context: CheckpointContext): Checkpoint {
        const resolved = path.resolve(file);
        const lock = this.acquire(resolved);
        let fd: number | undefined;
        try {
            const header: Header = {
                format: 'spl-checkpoint', version: 1, run_id: randomUUID(),
                ...identity(context), args: [...(context.args ?? [])],
            };
            fd = fs.openSync(resolved, 'wx', 0o600);
            const checkpoint = new Checkpoint(resolved, fd, lock, header, []);
            checkpoint.write(header);
            return checkpoint;
        } catch (error) {
            if (fd !== undefined) fs.closeSync(fd);
            fs.closeSync(lock);
            fs.unlinkSync(`${resolved}.lock`);
            if (error instanceof CheckpointError) throw error;
            throw new CheckpointError(`cannot create checkpoint: ${ioMessage(error)}`);
        }
    }

    static resume(file: string, context: CheckpointContext): Checkpoint {
        const resolved = path.resolve(file);
        const lock = this.acquire(resolved);
        let fd: number | undefined;
        try {
            const text = fs.readFileSync(resolved, 'utf8');
            if (!text.endsWith('\n')) throw new CheckpointError('truncated checkpoint; manual recovery required');
            const lines = text.slice(0, -1).split('\n');
            const header = parseHeader(JSON.parse(lines.shift() ?? '') as unknown);
            const expected = identity(context);
            for (const key of ['source', 'runtime', 'cwd', 'configuration'] as const) {
                if (expected[key] !== header[key]) throw new CheckpointError(`checkpoint ${key} mismatch`);
            }
            if (context.args !== undefined && canonical(context.args) !== canonical(header.args)) {
                throw new CheckpointError('checkpoint script arguments mismatch');
            }
            const events = lines.map((line) => parseEvent(JSON.parse(line) as unknown));
            const pending = validateHistory(events);
            fd = fs.openSync(resolved, 'a');
            return new Checkpoint(resolved, fd, lock, header, events, pending);
        } catch (error) {
            if (fd !== undefined) fs.closeSync(fd);
            fs.closeSync(lock);
            fs.unlinkSync(`${resolved}.lock`);
            if (error instanceof CheckpointError) throw error;
            throw new CheckpointError(`cannot resume checkpoint: ${ioMessage(error)}`);
        }
    }

    private static acquire(file: string): number {
        try {
            return fs.openSync(`${file}.lock`, 'wx', 0o600);
        } catch (error) {
            throw new CheckpointError(`cannot lock checkpoint (another writer or stale lock may exist): ${ioMessage(error)}`);
        }
    }

    get runId(): string { return this.header.run_id; }
    get args(): readonly string[] { return [...this.header.args]; }
    get replaying(): boolean { return this.position < this.replayLength; }
    get request(): HumanRequest | undefined {
        return this.pending ? { run_id: this.runId, checkpoint: this.file, ...this.pendingRequest(this.pending) } : undefined;
    }

    private pendingRequest(question: Question) {
        return { request_id: question.request_id, question: question.question, line: question.line };
    }

    answer(requestId: string, value: string): void {
        this.assertActive();
        if (!this.pending || this.pending.request_id !== requestId) {
            throw new CheckpointError('answer does not match the pending request ID; use request_id from the latest waiting_for_input response, not run_id');
        }
        this.append({ type: 'answer', request_id: requestId, value });
        this.pending = undefined;
    }

    private write(value: Header | Event): void {
        this.assertActive();
        try {
            fs.writeFileSync(this.fd, JSON.stringify(value) + '\n');
            fs.fsyncSync(this.fd);
        } catch (error) {
            this.poisoned = true;
            throw new CheckpointError(`cannot durably save checkpoint: ${ioMessage(error)}`, 'infrastructure');
        }
    }

    private append(event: Event): void {
        this.write(event);
        this.events.push(event);
    }

    observeEnvironment(snapshot: unknown): void {
        this.assertActive();
        if (this.observedEnvironment) return;
        const event: Event = { type: 'environment', fingerprint: checkpointFingerprint(snapshot) };
        if (this.replaying) {
            if (canonical(this.events[this.position++]) !== canonical(event)) throw new CheckpointError('checkpoint environment history mismatch');
        } else {
            this.append(event);
        }
        this.observedEnvironment = true;
    }

    async effect<T>(request: unknown, perform: () => Promise<T>, valid: (value: unknown) => value is T): Promise<T> {
        this.assertActive();
        const key = canonical(request);
        if (this.replaying) {
            const intent = this.events[this.position++];
            const outcome = this.events[this.position++];
            if (intent?.type !== 'intent' || intent.request !== key || outcome?.type !== 'outcome' || outcome.sequence !== intent.sequence) {
                throw new CheckpointError('checkpoint effect history mismatch');
            }
            if ('error' in outcome.outcome) {
                const error = outcome.outcome.error;
                throw new Failure(error.status_code, error.reason);
            }
            if (!valid(outcome.outcome.value)) throw new CheckpointError('invalid recorded checkpoint effect result');
            return structuredClone(outcome.outcome.value);
        }
        if (this.pending) throw new CheckpointError('cannot execute before answering the pending question');
        const sequence = this.sequence++;
        this.append({ type: 'intent', sequence, request: key });
        let outcome: Outcome;
        try {
            const value = await perform();
            if (!valid(value)) throw new CheckpointError('invalid live checkpoint effect result', 'infrastructure');
            outcome = { value };
        } catch (error) {
            if (!(error instanceof Failure)) throw error;
            outcome = { error: { status_code: error.statusCode, reason: error.reason } };
        }
        this.append({ type: 'outcome', sequence, outcome });
        if ('error' in outcome) throw new Failure(outcome.error.status_code, outcome.error.reason);
        if (!valid(outcome.value)) throw new CheckpointError('invalid checkpoint effect result', 'infrastructure');
        return outcome.value;
    }

    human(question: string, line: number): string {
        this.assertActive();
        if (this.replaying) {
            const event = this.events[this.position++];
            const answer = this.events[this.position++];
            if (event?.type !== 'question' || event.question !== question || event.line !== line
                || answer?.type !== 'answer' || answer.request_id !== event.request_id) {
                throw new CheckpointError('checkpoint human-input history mismatch');
            }
            return answer.value;
        }
        if (this.pending) throw new CheckpointError('cannot execute before answering the pending question');
        const event: Question = { type: 'question', request_id: randomUUID(), question, line };
        this.append(event);
        this.pending = event;
        throw new SuspensionSignal({ run_id: this.runId, checkpoint: this.file, ...this.pendingRequest(event) });
    }

    finish(status: 'success' | 'failure'): void {
        this.assertConsumed();
        this.append({ type: 'terminal', status });
        this.terminal = true;
    }

    assertConsumed(): void {
        if (this.replaying || this.pending) throw new CheckpointError('checkpoint ended with unused history or pending input');
    }

    validateSource(source: string, args?: readonly string[]): void {
        this.assertActive();
        if (checkpointFingerprint(source.replace(/\r\n/g, '\n')) !== this.header.source) throw new CheckpointError('checkpoint source mismatch');
        if (args !== undefined && canonical(args) !== canonical(this.header.args)) throw new CheckpointError('checkpoint script arguments mismatch');
    }

    private assertActive(): void {
        if (this.closed || this.poisoned || this.terminal) throw new CheckpointError('checkpoint is closed, terminal, or unusable', 'infrastructure');
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        try {
            fs.closeSync(this.fd);
        } finally {
            fs.closeSync(this.lock);
            fs.unlinkSync(`${this.file}.lock`);
        }
    }
}
