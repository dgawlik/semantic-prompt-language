import * as fs from 'node:fs';
import { LlmError, type LlmBackend, type LlmRequest, type LlmResponse } from './llm.js';

interface Entry {
    request: string;
    response: LlmResponse;
}

function requestKey(req: LlmRequest): string {
    return JSON.stringify({
        kind: req.kind, prompt: req.prompt, model: req.model ?? null,
        reasoningEffort: req.reasoningEffort ?? null, showReasoning: req.showReasoning,
    });
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
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

export class ReplayBackend implements LlmBackend {
    readonly mode = 'replay';
    private readonly entries: Entry[];
    private position = 0;

    constructor(file: string) {
        const lines = fs.readFileSync(file, 'utf8').trimEnd().split(/\r?\n/);
        const header = parseLine(lines.shift() ?? '', 1);
        if (!isRecord(header) || header.format !== 'spl-generation' || header.version !== 1) {
            throw new LlmError('unsupported recording format/version');
        }
        this.entries = lines.map((line, i) => {
            const entry = parseLine(line, i + 2);
            if (!isRecord(entry) || typeof entry.request !== 'string' || !isRecord(entry.response)
                || typeof entry.response.text !== 'string' || !isRecord(entry.response.effective)
                || (entry.response.reasoning !== undefined && typeof entry.response.reasoning !== 'string')) {
                throw new LlmError(`invalid recording entry at line ${i + 2}`);
            }
            return {
                request: entry.request,
                response: {
                    text: entry.response.text,
                    effective: entry.response.effective,
                    reasoning: entry.response.reasoning,
                },
            };
        });
    }

    async call(req: LlmRequest): Promise<LlmResponse> {
        if (req.kind === 'agent') throw new LlmError('agent actions cannot be replayed');
        const entry = this.entries[this.position];
        if (!entry) throw new LlmError(`recording exhausted at call ${this.position + 1}`);
        if (entry.request !== requestKey(req)) throw new LlmError(`replay request mismatch at call ${this.position + 1}`);
        this.position++;
        return structuredClone(entry.response);
    }

    async close(): Promise<void> {
        if (this.position !== this.entries.length) {
            throw new LlmError(`replay ended with ${this.entries.length - this.position} unused recorded response(s)`);
        }
    }
}
