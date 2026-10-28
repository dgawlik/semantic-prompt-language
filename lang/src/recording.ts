import * as fs from 'node:fs';
import { Failure, type StatusCode } from './errors.js';
import { LlmError, type LlmBackend, type LlmRequest, type LlmResponse, type RuntimeAction } from './llm.js';
import { isRuntimeAction } from './agent.js';
import type { Value } from './values.js';

type Entry =
    | { request: string; outcome: Outcome }
    | { request: string; runtime: RuntimeAction }
    | { tool: string; outcome: ToolOutcome };

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

type ToolOutcome = { value: Value } | Extract<Outcome, { error: unknown }>;

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
        && (value.action === undefined || isRuntimeAction(value.action))
        && (value.toolResults === undefined || (Array.isArray(value.toolResults) && value.toolResults.every(item => typeof item === 'string')))
        && !('spl' in value);
}

function isToolValue(value: unknown): value is Value {
    return value === null || typeof value === 'string' || typeof value === 'boolean'
        || (typeof value === 'number' && Number.isFinite(value))
        || (Array.isArray(value) && value.every(isToolValue))
        || (isRecord(value) && !('__fn' in value) && Object.values(value).every(isToolValue));
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
        if (req.kind === 'agent') throw new LlmError('agent actions cannot be recorded; record generation-only workflows');
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
        const append = (entry: unknown) => {
            try {
                fs.appendFileSync(this.file, JSON.stringify(entry) + '\n');
            } catch (e) {
                throw new LlmError(`could not save trace: ${e instanceof Error ? e.message : String(e)}`);
            }
        };
        let actionFailed = false;
        const invokeAction = req.invokeAction;
        if (req.naturalLanguage && invokeAction) req = {
            ...req,
            invokeAction: async action => {
                try {
                    append({ request, runtime: action });
                    return await invokeAction(action);
                } catch (error) {
                    actionFailed = true;
                    throw error;
                }
            },
        };
        let outcome: Outcome;
        let failure: unknown;
        try {
            outcome = { response: await this.backend.call(req) };
        } catch (e) {
            if (actionFailed) throw e;
            failure = e instanceof Error ? e : new LlmError(String(e));
            outcome = { error: {
                status_code: e instanceof Failure ? e.statusCode : 'llm_error',
                reason: e instanceof Failure ? e.reason : e instanceof Error ? e.message : String(e),
            } };
        }
        append({ request, ...outcome });
        if ('error' in outcome) throw failure;
        return outcome.response;
    }

    async invokeTool(action: RuntimeAction, perform: () => Promise<Value>): Promise<Value> {
        let outcome: ToolOutcome;
        try {
            outcome = { value: await perform() };
        } catch (error) {
            if (!(error instanceof Failure)) throw error;
            outcome = { error: { status_code: error.statusCode, reason: error.reason } };
        }
        try {
            fs.appendFileSync(this.file, JSON.stringify({ tool: action, ...outcome }) + '\n');
        } catch (error) {
            throw new LlmError(`could not save tool trace: ${error instanceof Error ? error.message : String(error)}`);
        }
        if ('error' in outcome) throw new Failure(outcome.error.status_code, outcome.error.reason);
        return outcome.value;
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
            if (this.mode === 'workflow-replay' && isRuntimeAction(entry.runtime) && isTraceRequest(entry.request)) {
                return { request: JSON.stringify(traceRequest(entry.request)), runtime: entry.runtime };
            }
            if (this.mode === 'workflow-replay' && isRuntimeAction(entry.tool)) {
                if (isToolValue(entry.value) && entry.error === undefined) {
                    return { tool: JSON.stringify(entry.tool), outcome: { value: entry.value } };
                }
                if (entry.value === undefined && isTraceError(entry.error)) {
                    return { tool: JSON.stringify(entry.tool), outcome: { error: entry.error } };
                }
                throw new LlmError(`invalid tool trace at line ${i + 2}`);
            }
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
        if (req.kind === 'agent' && this.mode === 'replay') throw new LlmError('agent actions cannot be replayed');
        for (;;) {
            const entry = this.entries[this.position];
            if (!entry) throw new LlmError(`recording exhausted at call ${this.position + 1}`);
            if (!('request' in entry) || entry.request !== requestKey(req)) throw new LlmError(`replay request mismatch at call ${this.position + 1}`);
            this.position++;
            if ('runtime' in entry) {
                if (!req.naturalLanguage || !req.invokeAction) throw new LlmError('runtime trace requires a blockquote action handler');
                await req.invokeAction(structuredClone(entry.runtime));
                continue;
            }
            if ('error' in entry.outcome) {
                const { status_code, reason } = entry.outcome.error;
                throw new Failure(status_code, reason);
            }
            return structuredClone(entry.outcome.response);
        }
    }

    async invokeTool(action: RuntimeAction, _perform: () => Promise<Value>): Promise<Value> {
        const entry = this.entries[this.position];
        if (this.mode !== 'workflow-replay' || !entry || !('tool' in entry) || entry.tool !== JSON.stringify(action)) {
            throw new LlmError(`replay tool mismatch at entry ${this.position + 1}`);
        }
        this.position++;
        if ('error' in entry.outcome) throw new Failure(entry.outcome.error.status_code, entry.outcome.error.reason);
        return structuredClone(entry.outcome.value);
    }

    async close(): Promise<void> {
        if (this.position !== this.entries.length) {
            throw new LlmError(`replay ended with ${this.entries.length - this.position} unused recorded response(s)`);
        }
    }
}
