import { fingerprint as traceFingerprint } from './trace.js';
import { Failure, SplSyntaxError } from './errors.js';
import { isTraceError } from './recording.js';

interface PinContext {
    cwd: string;
    args: readonly string[];
    model?: string;
}

interface PinEntry {
    request: string;
    outcome: { value: unknown } | { error: { status_code: Failure['statusCode']; reason: string } };
}

export interface PinData {
    format: 'spl-lock';
    version: 1;
    source: string;
    context: PinContext;
    environment?: Record<string, string>;
    entries: PinEntry[];
}

export class PinError extends Error {}

const record = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
const strings = (value: unknown): value is string[] =>
    Array.isArray(value) && value.every(item => typeof item === 'string');

function isEntry(value: unknown): value is PinEntry {
    if (!record(value) || typeof value.request !== 'string' || !record(value.outcome)) return false;
    return Object.hasOwn(value.outcome, 'value') && !Object.hasOwn(value.outcome, 'error')
        || !Object.hasOwn(value.outcome, 'value') && isTraceError(value.outcome.error);
}

function isPinData(value: unknown): value is PinData {
    return record(value) && value.format === 'spl-lock' && value.version === 1
        && typeof value.source === 'string' && record(value.context)
        && typeof value.context.cwd === 'string' && strings(value.context.args)
        && (value.context.model === undefined || typeof value.context.model === 'string')
        && (value.environment === undefined || record(value.environment)
            && Object.values(value.environment).every(item => typeof item === 'string'))
        && Array.isArray(value.entries) && value.entries.every(isEntry);
}

function fingerprint(source: string): string {
    return traceFingerprint(source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trimEnd());
}

export function parsePin(text: string, line: number): PinData {
    let data: unknown;
    try {
        data = JSON.parse(text);
    } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        throw new SplSyntaxError(`invalid locked workflow JSON: ${error.message}`, line, 1);
    }
    if (!isPinData(data)) throw new SplSyntaxError('invalid locked workflow format/version or journal', line, 1);
    return data;
}

export function validatePinSource(data: PinData, source: string, line: number): void {
    if (fingerprint(source) !== data.source) {
        throw new SplSyntaxError('locked workflow source mismatch; run the original workflow with --pin again', line, 1);
    }
}

/** Records execution decisions before their actions, so nested calls replay in the same order. */
export class Pin {
    private position = 0;

    private constructor(readonly data: PinData, readonly replaying: boolean) {}

    static capture(source: string, context: PinContext): Pin {
        return new Pin({
            format: 'spl-lock', version: 1, source: fingerprint(source),
            context: structuredClone(context), entries: [],
        }, false);
    }

    static replay(data: PinData): Pin {
        return new Pin(structuredClone(data), true);
    }

    validateOptions(options: { cwd?: string; args?: readonly string[]; model?: string; store?: unknown; trace?: unknown }): void {
        if (options.trace) throw new PinError('pinned workflows cannot use traces');
        if (!this.replaying) return;
        if (options.store) throw new PinError('locked workflows cannot use a variable store');
        const context = this.data.context;
        if (options.cwd !== undefined && options.cwd !== context.cwd
            || options.args !== undefined && JSON.stringify(options.args) !== JSON.stringify(context.args)
            || options.model !== undefined && options.model !== context.model) {
            throw new PinError('locked workflow execution options mismatch; cwd, arguments and model are pinned');
        }
    }

    observeEnvironment(environment: Record<string, unknown>): void {
        if (!this.replaying && this.data.environment === undefined) {
            const snapshot: Record<string, string> = {};
            for (const [name, value] of Object.entries(environment)) {
                if (typeof value !== 'string') throw new PinError('invalid environment value');
                Object.defineProperty(snapshot, name, { value, enumerable: true });
            }
            this.data.environment = snapshot;
        }
        if (this.replaying && this.data.environment === undefined) throw new PinError('locked workflow has no saved environment');
    }

    async effect<T>(request: unknown, perform: () => T | Promise<T>, valid: (value: unknown) => value is T): Promise<T> {
        const key = JSON.stringify(request);
        if (this.replaying) {
            const entry = this.data.entries[this.position];
            if (!entry) throw new PinError(`locked workflow exhausted at entry ${this.position + 1}`);
            if (entry.request !== key) throw new PinError(`locked workflow request mismatch at entry ${this.position + 1}`);
            this.position++;
            if ('error' in entry.outcome) {
                throw new Failure(entry.outcome.error.status_code, entry.outcome.error.reason);
            }
            if (!valid(entry.outcome.value)) throw new PinError(`invalid locked workflow result at entry ${this.position}`);
            return structuredClone(entry.outcome.value);
        }
        let outcome: PinEntry['outcome'];
        try {
            const value = await perform();
            if (!valid(value)) throw new PinError('invalid live result while pinning workflow');
            outcome = { value };
        } catch (error) {
            if (!(error instanceof Failure)) throw error;
            outcome = { error: { status_code: error.statusCode, reason: error.reason } };
        }
        // Snapshot immediately: later mutations must not change an earlier external result.
        try {
            this.data.entries.push({ request: key, outcome: JSON.parse(JSON.stringify(outcome)) });
        } catch (error) {
            throw new PinError(`cannot pin non-serializable result: ${error instanceof Error ? error.message : String(error)}`);
        }
        if ('error' in outcome) throw new Failure(outcome.error.status_code, outcome.error.reason);
        if (!valid(outcome.value)) throw new PinError('invalid pinned result');
        return outcome.value;
    }

    assertConsumed(): void {
        if (this.replaying && this.position !== this.data.entries.length) {
            throw new PinError(`locked workflow ended with ${this.data.entries.length - this.position} unused journal entries`);
        }
    }

    toMarkdown(source: string): string {
        validatePinSource(this.data, source, 1);
        const journal = ['```spl-lock', JSON.stringify(this.data, null, 2), '```'].join('\n')
            .split('\n').map(line => `>> ${line}`).join('\n');
        return `${source}\n\n${journal}\n`;
    }

    /** The `.spl` form of a locked workflow: the source followed by its journal in a `{lock}` block. */
    toSpl(source: string): string {
        validatePinSource(this.data, source, 1);
        return `${source}\n\n{lock}\n${JSON.stringify(this.data, null, 2)}\n{/lock}\n`;
    }
}
