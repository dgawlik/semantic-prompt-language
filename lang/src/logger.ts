import { inspect, stripVTControlCharacters } from 'node:util';

export type LogLevel = 'error' | 'info' | 'debug';

export interface LoggerOptions {
    /** Override terminal/environment color detection. Custom sinks default to plain text. */
    color?: boolean;
}

const RANK: Record<LogLevel, number> = { error: 0, info: 1, debug: 2 };
const COLORS: Record<string, number> = { error: 31, warn: 33, info: 34, debug: 90, llm: 35, deterministic: 36 };
const stderr = (line: string): void => { process.stderr.write(line + '\n'); };
const JSON_TOKENS = /"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[{}[\],:]/g;

function terminalColor(): boolean {
    if (process.env.NO_COLOR !== undefined) return false;
    if (process.env.FORCE_COLOR !== undefined) return process.env.FORCE_COLOR !== '0';
    return Boolean(process.stderr.isTTY) && process.env.TERM !== 'dumb';
}

function paint(text: string, color: number, enabled: boolean): string {
    return enabled ? `\u001b[${color}m${text}\u001b[0m` : text;
}

function prettyJson(source: string, color: boolean): string | undefined {
    const text = source.trim();
    if (!/^(?:[{"[\d-]|true$|false$|null$)/.test(text)) return undefined;
    try {
        JSON.parse(text);
    } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        return undefined;
    }
    // Keep original JSON tokens: parsing and re-stringifying would round large integers.
    const tokens = text.match(JSON_TOKENS)!;
    let depth = 0;
    let result = '';
    const newline = () => '\n' + '  '.repeat(depth);
    tokens.forEach((token, index) => {
        if (token === '{' || token === '[') {
            result += paint(token, 90, color);
            if (tokens[index + 1] !== (token === '{' ? '}' : ']')) { depth++; result += newline(); }
        } else if (token === '}' || token === ']') {
            if (tokens[index - 1] !== (token === '}' ? '{' : '[')) { depth--; result += newline(); }
            result += paint(token, 90, color);
        } else if (token === ',') {
            result += paint(token, 90, color) + newline();
        } else if (token === ':') {
            result += paint(token, 90, color) + ' ';
        } else {
            const shade = token.startsWith('"') ? (tokens[index + 1] === ':' ? 36 : 32)
                : token === 'null' ? 90 : token === 'true' || token === 'false' ? 35 : 33;
            result += paint(token, shade, color);
        }
    });
    return result;
}

function formatText(text: string, color: boolean): string {
    const plain = stripVTControlCharacters(text).replace(/\r\n?/g, '\n');
    const json = prettyJson(plain, color);
    if (json !== undefined) return json;
    const labeled = /^([^\n]*?:)\s*([\[{][\s\S]*)$/.exec(plain);
    const payload = labeled && prettyJson(labeled[2], color);
    if (payload) return `${labeled[1]}\n${payload}`;
    return plain.split('\n').map(line => prettyJson(line, color) ?? line).join('\n');
}

function formatValue(value: unknown, color: boolean): string {
    if (typeof value === 'string') return formatText(value, color);
    if (value instanceof Error || (typeof value === 'number' && !Number.isFinite(value))) {
        return inspect(value, { colors: color, depth: null });
    }
    let json: string | undefined;
    try {
        json = JSON.stringify(value);
    } catch (error) {
        if (!(error instanceof TypeError)) throw error;
        return inspect(value, { colors: color, depth: null });
    }
    return json === undefined ? inspect(value, { colors: color, depth: null }) : prettyJson(json, color)!;
}

/** Logs go to stderr so that stdout carries only the script result. */
export class Logger {
    private readonly color: boolean;

    constructor(
        private level: LogLevel | 'silent' = 'info',
        private readonly sink: (line: string) => void = stderr,
        options: LoggerOptions = {},
    ) {
        this.color = options.color ?? (sink === stderr && terminalColor());
    }

    private emit(min: LogLevel, tag: string, msg: unknown, values: readonly unknown[] = [], raw = false): void {
        if (this.level === 'silent' || RANK[this.level] < RANK[min]) return;
        const parts = [msg, ...values].map(value => raw ? stripVTControlCharacters(String(value)) : formatValue(value, this.color));
        const message = parts.reduce((text, part) => text + (tag === 'llm' || part.includes('\n') ? '\n' : ' ') + part);
        const badge = paint(`[${tag}]`, COLORS[tag], this.color);
        this.sink(message.replace(/\r\n?/g, '\n').split('\n').map((line, index) => `${badge} ${index ? '  ' : ''}${line}`).join('\n'));
    }

    error(msg: unknown, ...values: unknown[]): void {
        this.emit('error', 'error', msg, values);
    }

    warn(msg: unknown, ...values: unknown[]): void {
        this.emit('info', 'warn', msg, values);
    }

    info(msg: unknown, ...values: unknown[]): void {
        this.emit('info', 'info', msg, values);
    }

    debug(msg: unknown, ...values: unknown[]): void {
        this.emit('debug', 'debug', msg, values);
    }

    /** LLM transcripts are visible at every non-silent level, without labeling them as errors. */
    llm(msg: unknown, ...values: unknown[]): void {
        this.emit('error', 'llm', msg, values);
    }

    deterministic(msg: string): void {
        this.emit('error', 'deterministic', msg, [], true);
    }
}
