export type LogLevel = 'error' | 'info' | 'debug';

const RANK: Record<LogLevel, number> = { error: 0, info: 1, debug: 2 };

/** Logs go to stderr so that stdout carries only the script result. */
export class Logger {
    constructor(
        private level: LogLevel | 'silent' = 'info',
        private readonly sink: (line: string) => void = (l) => process.stderr.write(l + '\n'),
    ) {}

    private emit(min: LogLevel, tag: string, msg: string): void {
        if (this.level === 'silent' || RANK[this.level] < RANK[min]) return;
        this.sink(`[${tag}] ${msg}`);
    }

    error(msg: string): void {
        this.emit('error', 'error', msg);
    }

    warn(msg: string): void {
        this.emit('info', 'warn', msg);
    }

    info(msg: string): void {
        this.emit('info', 'info', msg);
    }

    debug(msg: string): void {
        this.emit('debug', 'debug', msg);
    }
}
