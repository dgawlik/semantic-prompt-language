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
    /** The file the failure is in, when it is not the workflow that was run. */
    source?: string;
}

// Brands keep `instanceof` working when a helper module loads a second copy of the package.
const FAILURE = Symbol.for('spl-lang.failure');
const SUCCESS = Symbol.for('spl-lang.success');
const branded = (value: unknown, brand: symbol): boolean =>
    typeof value === 'object' && value !== null && (value as Record<symbol, unknown>)[brand] === true;

/** A workflow failure. Stops the workflow unless caught with try/catch. */
export class Failure extends Error {
    readonly statusCode: StatusCode;
    reason: string;
    command = '';
    line = 0;
    located = false;
    source?: string;

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

    locate(line: number, command: string, source?: string): this {
        if (!this.located) {
            this.line = line;
            this.command = command;
            this.located = true;
            this.source = source;
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
        };
    }
}

/** Thrown by `success()`: stops the workflow with a result. Not an Error, so rethrow it if caught. */
export class SuccessSignal {
    static [Symbol.hasInstance](value: unknown): boolean {
        return branded(value, SUCCESS);
    }

    constructor(readonly value: unknown) {
        Object.defineProperty(this, SUCCESS, { value: true });
    }
}

export interface SyntaxProblem {
    line: number;
    column: number;
    message: string;
}

/** Problems found before anything runs; never catchable by workflow code. */
export class SplSyntaxError extends Error {
    readonly problems: readonly SyntaxProblem[];
    /** The file the problems are in, when it is not the workflow that was asked for. */
    file?: string;

    constructor(problems: readonly SyntaxProblem[]);
    constructor(message: string, line: number, column: number);
    constructor(first: string | readonly SyntaxProblem[], line = 1, column = 1) {
        const problems = typeof first === 'string' ? [{ line, column, message: first }] : first;
        super(problems[0].message);
        this.name = 'SplSyntaxError';
        this.problems = problems;
    }

    get line(): number { return this.problems[0].line; }
    get col(): number { return this.problems[0].column; }

    format(file: string): string {
        return this.problems.map(problem => `${this.file ?? file}:${problem.line}:${problem.column}: syntax error: ${problem.message}`).join('\n');
    }
}
