import * as fs from 'node:fs';
import { Failure, type StatusCode } from './errors.js';
import { LlmError, type LlmBackend, type LlmRequest, type LlmResponse } from './llm.js';

interface Entry {
    request: string;
    outcome: Outcome;
}

interface TraceRequest {
    kind: LlmRequest['kind'];
    prompt: string;
    model: string | null;
    reasoningEffort: LlmRequest['reasoningEffort'] | null;
    showReasoning: boolean;
    naturalLanguage?: boolean;
}

type Outcome =
    | { response: LlmResponse }
    | { error: { status_code: StatusCode; reason: string } };

export function traceRequest(req: LlmRequest | TraceRequest): TraceRequest {
    return {
        kind: req.kind, prompt: req.prompt, model: req.model ?? null,
        reasoningEffort: req.reasoningEffort ?? null, showReasoning: req.showReasoning,
        ...(req.naturalLanguage ? { naturalLanguage: true } : {}),
    };
}

function requestKey(req: LlmRequest): string {
    return JSON.stringify(traceRequest(req));
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isResponse(value: unknown): value is LlmResponse {
    return isRecord(value) && typeof value.text === 'string' && isRecord(value.effective)
        && (value.reasoning === undefined || typeof value.reasoning === 'string')
        && (value.spl === undefined || typeof value.spl === 'string');
}

function isTraceRequest(value: unknown): value is TraceRequest {
    return isRecord(value) && (value.kind === 'ask' || value.kind === 'think' || value.kind === 'agent')
        && typeof value.prompt === 'string' && (value.model === null || typeof value.model === 'string')
        && (value.reasoningEffort === null || value.reasoningEffort === 'low' || value.reasoningEffort === 'medium' || value.reasoningEffort === 'high')
        && typeof value.showReasoning === 'boolean'
        && (value.naturalLanguage === undefined || typeof value.naturalLanguage === 'boolean');
}

export function isTraceError(value: unknown): value is Extract<Outcome, { error: unknown }>['error'] {
    const codes: readonly StatusCode[] = [
        'assertion_failed', 'explicit_failure', 'invalid_format', 'validation_failed',
        'restriction_violation', 'llm_error', 'tool_error', 'runtime_error',
    ];
    return isRecord(value) && typeof value.reason === 'string'
        && codes.some((code) => code === value.status_code);
}

function parseLine(line: string, number: number): unknown {
    try {
        return JSON.parse(line);
    } catch (e) {
        if (!(e instanceof SyntaxError)) throw e;
        throw new LlmError(`invalid recording JSON at line ${number}: ${e.message}`);
    }
}

export class RecordingBackend implements LlmBackend {
    readonly mode = 'record';

    constructor(private readonly backend: LlmBackend, private readonly file: string) {
        fs.writeFileSync(file, JSON.stringify({ format: 'spl-generation', version: 1 }) + '\n', { flag: 'wx', mode: 0o600 });
    }

    async call(req: LlmRequest): Promise<LlmResponse> {
        if (req.kind === 'agent' && !req.naturalLanguage) throw new LlmError('agent actions cannot be recorded; record generation-only workflows');
        const request = requestKey(req);
        const response = await this.backend.call(req);
        try {
            fs.appendFileSync(this.file, JSON.stringify({ request, response }) + '\n');
        } catch (e) {
            if (!(e instanceof Error)) throw e;
            throw new LlmError(`could not save recording: ${e.message}`);
        }
        return response;
    }

    close(): Promise<void> {
        return this.backend.close();
    }
}

export class TraceBackend implements LlmBackend {
    readonly mode = 'trace';

    constructor(private readonly backend: LlmBackend, private readonly file: string) {
        fs.writeFileSync(file, JSON.stringify({ format: 'spl-trace', version: 1 }) + '\n', { flag: 'wx', mode: 0o600 });
    }

    async call(req: LlmRequest): Promise<LlmResponse> {
        const request = traceRequest(req);
        let outcome: Outcome;
        let failure: unknown;
        try {
            outcome = { response: await this.backend.call(req) };
        } catch (e) {
            failure = e instanceof Error ? e : new LlmError(String(e));
            outcome = { error: {
                status_code: e instanceof Failure ? e.statusCode : 'llm_error',
                reason: e instanceof Failure ? e.reason : e instanceof Error ? e.message : String(e),
            } };
        }
        try {
            fs.appendFileSync(this.file, JSON.stringify({ request, ...outcome }) + '\n');
        } catch (e) {
            if (!(e instanceof Error)) throw e;
            throw new LlmError(`could not save trace: ${e.message}`);
        }
        if ('error' in outcome) throw failure;
        return outcome.response;
    }

    close(): Promise<void> {
        return this.backend.close();
    }
}

export class ReplayBackend implements LlmBackend {
    readonly mode: 'replay' | 'workflow-replay';
    private readonly entries: Entry[];
    private position = 0;

    constructor(file: string) {
        const lines = fs.readFileSync(file, 'utf8').trimEnd().split(/\r?\n/);
        const header = parseLine(lines.shift() ?? '', 1);
        if (!isRecord(header) || (header.format !== 'spl-generation' && header.format !== 'spl-trace') || header.version !== 1) {
            throw new LlmError('unsupported recording format/version');
        }
        this.mode = header.format === 'spl-trace' ? 'workflow-replay' : 'replay';
        this.entries = lines.map((line, i) => {
            const entry = parseLine(line, i + 2);
            if (!isRecord(entry)) throw new LlmError(`invalid recording entry at line ${i + 2}`);
            let request: string;
            if (this.mode === 'workflow-replay' && isTraceRequest(entry.request)) {
                request = JSON.stringify(traceRequest(entry.request));
            } else if (this.mode === 'replay' && typeof entry.request === 'string') {
                request = entry.request;
            } else {
                throw new LlmError(`invalid recording entry at line ${i + 2}`);
            }
            if (isResponse(entry.response) && entry.error === undefined) {
                return { request, outcome: { response: entry.response } };
            }
            if (this.mode === 'workflow-replay' && entry.response === undefined && isTraceError(entry.error)) {
                return { request, outcome: { error: entry.error } };
            }
            throw new LlmError(`invalid recording entry at line ${i + 2}`);
        });
    }

    async call(req: LlmRequest): Promise<LlmResponse> {
        if (req.kind === 'agent' && !req.naturalLanguage && this.mode === 'replay') throw new LlmError('agent actions cannot be replayed');
        const entry = this.entries[this.position];
        if (!entry) throw new LlmError(`recording exhausted at call ${this.position + 1}`);
        if (entry.request !== requestKey(req)) throw new LlmError(`replay request mismatch at call ${this.position + 1}`);
        this.position++;
        if ('error' in entry.outcome) {
            const { status_code, reason } = entry.outcome.error;
            throw new Failure(status_code, reason);
        }
        return structuredClone(entry.outcome.response);
    }

    async close(): Promise<void> {
        if (this.position !== this.entries.length) {
            throw new LlmError(`replay ended with ${this.entries.length - this.position} unused recorded response(s)`);
        }
    }
}
