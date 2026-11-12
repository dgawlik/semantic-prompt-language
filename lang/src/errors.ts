export type StatusCode =
    | 'assertion_failed'
    | 'explicit_failure'
    | 'invalid_format'
    | 'validation_failed'
    | 'type_error'
    | 'restriction_violation'
    | 'llm_error'
    | 'tool_error'
    | 'runtime_error';

export interface FailurePayload {
    status: 'failure';
    reason: string;
    command: string;
    line: number;
    status_code: StatusCode;
    source?: string;
    source_version?: number;
}

// Brands keep `instanceof` working when a helper module loads a second copy of the package.
const FAILURE = Symbol.for('spl-lang.failure');
const SUCCESS = Symbol.for('spl-lang.success');
const branded = (value: unknown, brand: symbol): boolean =>
    typeof value === 'object' && value !== null && (value as Record<symbol, unknown>)[brand] === true;

/** A workflow failure. Stops the document unless caught with try/catch. */
export class Failure extends Error {
    readonly statusCode: StatusCode;
    reason: string;
    command = '';
    line = 0;
    located = false;
    source?: string;
    sourceVersion?: number;

    static [Symbol.hasInstance](value: unknown): boolean {
        return branded(value, FAILURE);
    }

    constructor(statusCode: StatusCode, reason: string) {
        super(reason);
        this.name = 'Failure';
        this.statusCode = statusCode;
        this.reason = reason;
        Object.defineProperty(this, FAILURE, { value: true });
    }

    /** Same value as `statusCode`, matching the JSON payload. */
    get status_code(): StatusCode { return this.statusCode; }

    locate(line: number, command: string, source?: string, sourceVersion?: number): this {
        if (!this.located) {
            this.line = line;
            this.command = command;
            this.located = true;
            this.source = source;
            this.sourceVersion = sourceVersion;
        }
        return this;
    }

    payload(): FailurePayload {
        return {
            status: 'failure',
            reason: this.reason,
            command: this.command,
            line: this.line,
            status_code: this.statusCode,
            ...(this.source ? { source: this.source } : {}),
            ...(this.sourceVersion !== undefined ? { source_version: this.sourceVersion } : {}),
        };
    }
}

/** Thrown by `success()`: stops the document with a result. Not an Error, so rethrow it if caught. */
export class SuccessSignal {
    static [Symbol.hasInstance](value: unknown): boolean {
        return branded(value, SUCCESS);
    }

    constructor(readonly value: unknown) {
        Object.defineProperty(this, SUCCESS, { value: true });
    }
}

/** Strict syntax error found before anything runs; never catchable by workflow code. */
export class SplSyntaxError extends Error {
    constructor(
        message: string,
        readonly line: number,
        readonly col: number,
    ) {
        super(message);
        this.name = 'SplSyntaxError';
    }

    format(file: string): string {
        return `${file}:${this.line}:${this.col}: syntax error: ${this.message}`;
    }
}
