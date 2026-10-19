export type StatusCode =
    | 'assertion_failed'
    | 'explicit_failure'
    | 'invalid_format'
    | 'validation_failed'
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
}

/** A script-level failure. Stops the script unless caught by try/except. */
export class Failure extends Error {
    readonly statusCode: StatusCode;
    reason: string;
    command = '';
    line = 0;
    located = false;

    constructor(statusCode: StatusCode, reason: string) {
        super(reason);
        this.name = 'Failure';
        this.statusCode = statusCode;
        this.reason = reason;
    }

    locate(line: number, command: string): this {
        if (!this.located) {
            this.line = line;
            this.command = command;
            this.located = true;
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
        };
    }
}

/** Thrown by `success`: stops the script with a result. */
export class SuccessSignal {
    constructor(readonly value: unknown) {}
}

/** Strict syntax error found while parsing; never catchable by scripts. */
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
