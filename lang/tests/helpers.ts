import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { LlmBackend, LlmRequest, LlmResponse, RuntimeAction } from '../src/llm.js';
import { Logger } from '../src/logger.js';
import type { LogEvent } from '../src/log-events.js';
import { parse, parseMarkdown } from '../src/markdown.js';
import { run, type RunOptions, type RunResult } from '../src/workflow.js';

/** Backend for tests that must not reach an LLM: any call is a test failure. */
export class NoLlm implements LlmBackend {
    async call(): Promise<LlmResponse> {
        throw new Error('unexpected LLM call');
    }
    async close(): Promise<void> {}
}

export const silent = new Logger('silent');
export const header = '---\nextension: semantic-prompt-language\nversion: 1\n';
/** A workflow document with the given body and extra frontmatter lines. */
export const document = (body: string, metadata = ''): string => `${header}${metadata}---\n\n${body}`;
export const fence = (code: string, language = 'js'): string => `\`\`\`${language}\n${code}\n\`\`\``;
export const quote = (text: string): string => text.split('\n').map(line => `> ${line}`).join('\n');

export function backend(call: (request: LlmRequest) => Promise<LlmResponse> | LlmResponse): LlmBackend {
    return { call: async request => call(request), async close() {} };
}

/** Answers model calls in order and records every request. */
export function scripted(...replies: (string | ((request: LlmRequest) => string | Promise<string>))[]): LlmBackend & { calls: LlmRequest[] } {
    const calls: LlmRequest[] = [];
    return {
        calls,
        async call(request) {
            const reply = replies[calls.length];
            calls.push(request);
            if (reply === undefined) throw new Error(`unexpected model call ${calls.length}: ${request.prompt.slice(-80)}`);
            return { text: typeof reply === 'string' ? reply : await reply(request), effective: {} };
        },
        async close() {},
    };
}

/** A blockquote agent that performs the given tool calls, then finishes. */
export function acting(...actions: (RuntimeAction | ((results: unknown[]) => RuntimeAction))[]): LlmBackend & { calls: LlmRequest[]; results: unknown[] } {
    const calls: LlmRequest[] = [];
    const results: unknown[] = [];
    return {
        calls, results,
        async call(request) {
            calls.push(request);
            if (!request.naturalLanguage) throw new Error('unexpected generation call');
            for (const action of actions) results.push(await request.invokeAction!(typeof action === 'function' ? action(results) : action));
            return { text: 'Done.', effective: {} };
        },
        async close() {},
    };
}

export const action = (name: string, args: Record<string, unknown>): RuntimeAction => ({ name, arguments: args });

const temporary: string[] = [];
export function tempDir(prefix = 'spl-test-'): string {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
    temporary.push(dir);
    return dir;
}
export function cleanTemp(): void {
    for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
}

/** Runs JavaScript as a one-fence workflow. */
export function exec(code: string, options: Partial<RunOptions> = {}): Promise<RunResult> {
    return run(parse(code), { backend: new NoLlm(), logger: silent, ...options });
}

/** Runs a Markdown workflow body (fences and blockquotes) with default frontmatter. */
export function execMarkdown(body: string, options: Partial<RunOptions> = {}, metadata = ''): Promise<RunResult> {
    return run(parseMarkdown(document(body, metadata)), { backend: new NoLlm(), logger: silent, ...options });
}

export function collecting(level: 'error' | 'info' | 'debug' = 'info'): { logger: Logger; events: LogEvent[] } {
    const events: LogEvent[] = [];
    return { events, logger: new Logger(level, undefined, { eventSink: event => events.push(event) }) };
}

export const text = (event: LogEvent): string => event.segments.map(segment =>
    segment.type === 'json' || segment.type === 'code' || segment.type === 'preface' ? segment.source : segment.text).join('');
