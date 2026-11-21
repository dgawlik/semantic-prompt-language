import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { Failure } from './errors.js';
import { languageOf, prettyJson } from './log-format.js';
import type { Restrictions } from './restrict.js';

export type ToolName = 'readFile' | 'writeFile' | 'webFetch' | 'webSearch' | 'shell';

const MAX_TEXT = 200_000;
const SHELL_TIMEOUT_MS = 120_000;
const FETCH_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;

export interface ToolSpec {
    name: ToolName;
    description: string;
    properties: Record<string, { type: 'string'; description: string }>;
    required: string[];
}

export const TOOL_SPECS: Record<ToolName, ToolSpec> = {
    readFile: {
        name: 'readFile',
        description: 'Read a UTF-8 text file and return its content.',
        properties: { path: { type: 'string', description: 'Path of the file to read' } },
        required: ['path'],
    },
    writeFile: {
        name: 'writeFile',
        description: 'Create or overwrite a UTF-8 text file (parent folders are created).',
        properties: {
            path: { type: 'string', description: 'Path of the file to write' },
            content: { type: 'string', description: 'Complete new content of the file' },
        },
        required: ['path', 'content'],
    },
    webFetch: {
        name: 'webFetch',
        description: 'Fetch an http(s) URL with GET and return the response body as text.',
        properties: { url: { type: 'string', description: 'URL to fetch' } },
        required: ['url'],
    },
    webSearch: {
        name: 'webSearch',
        description: 'Search the web and return the top results (title, URL and snippet).',
        properties: { query: { type: 'string', description: 'Search query' } },
        required: ['query'],
    },
    shell: {
        name: 'shell',
        description: 'Run a shell command and return its combined output.',
        properties: { command: { type: 'string', description: 'Command line to run' } },
        required: ['command'],
    },
};

export interface ToolCallLog {
    name: string;
    target: string;
    status: 'success' | 'error';
    /** Content shown in the terminal view: folded for files/web, expanded for shell. */
    source: string;
    language: string;
    summary: string;
    expanded?: boolean;
}

const count = (text: string, noun: string): string => {
    const lines = text.replace(/\r?\n$/, '').split('\n').length;
    return `${lines} ${noun}${lines === 1 ? '' : 's'}`;
};

/** What a built-in tool call did, for the log. */
export function describeToolCall(name: ToolName, params: Record<string, unknown>, outcome: { output: string } | { error: string }): ToolCallLog {
    const field = (key: string): string => typeof params[key] === 'string' ? params[key] : '';
    const target = name === 'readFile' || name === 'writeFile' ? field('path')
        : name === 'webFetch' ? field('url') : name === 'webSearch' ? JSON.stringify(field('query')) : field('command');
    const expanded = name === 'shell' ? { expanded: true } : {};
    if ('error' in outcome) {
        return { name, target, status: 'error', source: outcome.error, language: 'text', summary: outcome.error.split('\n')[0], ...expanded };
    }
    const { output } = outcome;
    switch (name) {
        case 'readFile': return { name, target, status: 'success', source: output, language: languageOf(target), summary: count(output, 'line') };
        case 'writeFile': {
            const content = field('content');
            return { name, target, status: 'success', source: content, language: languageOf(target), summary: `${count(content, 'line')} written` };
        }
        case 'webFetch': {
            const body = output.trimStart();
            const language = prettyJson(body) !== undefined ? 'json' : body.startsWith('<') ? 'html' : 'text';
            return { name, target, status: 'success', source: output, language, summary: count(output, 'line') };
        }
        case 'webSearch': {
            const results = output.match(/^\d+\. /gm)?.length ?? 0;
            return { name, target, status: 'success', source: output, language: 'text', summary: `${results} result${results === 1 ? '' : 's'}` };
        }
        case 'shell': return { name, target, status: 'success', source: output, language: 'text', summary: output ? count(output, 'line') : 'no output', expanded: true };
    }
}

/** What an MCP tool call did, for the log. */
export function describeMcpCall(server: string, tool: string, input: unknown, outcome: { result: unknown; isError: boolean } | { error: string }): ToolCallLog {
    const name = `${server}/${tool}`;
    const target = JSON.stringify(input) ?? '';
    if ('error' in outcome) return { name, target, status: 'error', source: outcome.error, language: 'text', summary: outcome.error.split('\n')[0] };
    const source = JSON.stringify(outcome.result) ?? 'null';
    return { name, target, status: outcome.isError ? 'error' : 'success', source, language: 'json', summary: outcome.isError ? 'error result' : 'result' };
}

/** What a custom TypeScript tool call did, for the log. */
export function describeCustomToolCall(name: string, input: unknown, outcome: { output: string } | { error: string }): ToolCallLog {
    const target = JSON.stringify(input) ?? '';
    if ('error' in outcome) return { name, target, status: 'error', source: outcome.error, language: 'text', summary: outcome.error.split('\n')[0] };
    const { output } = outcome;
    const isJson = prettyJson(output.trimStart()) !== undefined;
    return { name, target, status: 'success', source: output, language: isJson ? 'json' : 'text', summary: count(output, 'line') };
}

function runtimeValueDisplay(value: unknown, noun = 'line'): { source: string; language: string; summary: string } {
    if (typeof value === 'string') {
        if (value.includes('\n') || value.length > 100) {
            return { source: value, language: 'text', summary: count(value, noun) };
        }
        const quoted = JSON.stringify(value);
        return { source: quoted, language: 'json', summary: quoted };
    }
    if (value !== null && typeof value === 'object') {
        const source = JSON.stringify(value) ?? 'null';
        const summary = Array.isArray(value)
            ? `${value.length} item${value.length === 1 ? '' : 's'}`
            : `${Object.keys(value).length} key${Object.keys(value).length === 1 ? '' : 's'}`;
        return { source, language: 'json', summary };
    }
    const scalar = JSON.stringify(value ?? null) ?? String(value);
    return { source: scalar, language: 'json', summary: scalar };
}

/** Formats the target of an agent runtime tool (`@name`, `@fn(args)`, question, env var or guidance). */
export function runtimeToolTarget(name: string, args: Record<string, unknown>): string {
    switch (name) {
        case 'loadVariable':
        case 'saveVariable':
            return typeof args.name === 'string' ? `@${args.name}` : '';
        case 'callFunction': {
            const fn = typeof args.name === 'string' ? `@${args.name}` : '';
            const params = Array.isArray(args.args) ? args.args.map(item => JSON.stringify(item)).join(', ') : '';
            return `${fn}(${params})`;
        }
        case 'getEnv':
            return typeof args.name === 'string' ? args.name : '';
        case 'askHuman':
            return typeof args.question === 'string' ? JSON.stringify(args.question) : '';
        case 'setGuidance':
            return typeof args.kind === 'string' && typeof args.text === 'string' ? `${args.kind} ${JSON.stringify(args.text)}` : JSON.stringify(args);
        default:
            return JSON.stringify(args) ?? '';
    }
}

/** What an agent block runtime tool (`loadVariable`, `saveVariable`, `callFunction`, `getEnv`, `askHuman`, `setGuidance`) did, for the log. */
export function describeRuntimeToolCall(name: string, args: Record<string, unknown>, outcome: { value: unknown } | { error: string }): ToolCallLog {
    const target = runtimeToolTarget(name, args);
    if ('error' in outcome) {
        return { name, target, status: 'error', source: outcome.error, language: 'text', summary: outcome.error.split('\n')[0] };
    }
    const { value } = outcome;
    if (name === 'saveVariable' && value !== null && typeof value === 'object' && !Array.isArray(value)
        && 'rejected' in value && 'hint' in value && Object.keys(value).length === 2) {
        const rejected = String((value as { rejected: unknown }).rejected);
        return { name, target, status: 'error', source: JSON.stringify(value), language: 'json', summary: `rejected: ${rejected.split('\n')[0]}` };
    }
    if (name === 'setGuidance') {
        return { name, target, status: 'success', source: '', language: 'text', summary: 'applied' };
    }
    return { name, target, status: 'success', ...runtimeValueDisplay(value) };
}

function needString(tool: string, params: Record<string, unknown>, name: string): string {
    const v = params[name];
    if (typeof v !== 'string' || v === '') throw new Failure('tool_error', `${tool}: parameter '${name}' must be a non-empty string`);
    return v;
}

function truncate(text: string): string {
    return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n...[truncated ${text.length - MAX_TEXT} characters]` : text;
}

/** Splits a simple command line, honoring '...' and "..." quoting. No escapes, no expansion. */
export function splitCommand(command: string): string[] {
    const args: string[] = [];
    let cur = '';
    let inToken = false;
    let quote: string | undefined;
    for (const ch of command) {
        if (quote) {
            if (ch === quote) quote = undefined;
            else cur += ch;
        } else if (ch === '"' || ch === "'") {
            quote = ch;
            inToken = true;
        } else if (/\s/.test(ch)) {
            if (inToken) args.push(cur);
            cur = '';
            inToken = false;
        } else {
            cur += ch;
            inToken = true;
        }
    }
    if (quote) throw new Failure('restriction_violation', 'shell command rejected: unterminated quote');
    if (inToken) args.push(cur);
    return args;
}

function findMatchingParen(str: string, openIndex: number): number {
    let depth = 0;
    for (let i = openIndex; i < str.length; i++) {
        if (str[i] === '(') depth++;
        else if (str[i] === ')') {
            depth--;
            if (depth === 0) return i;
        }
    }
    return -1;
}

/** Splits a command string by chain/pipeline separators (&&, ||, |, ;, &, \n) outside quotes. */
export function splitChainedCommands(command: string): string[] {
    const subcmds: string[] = [];
    let cur = '';
    let quote: string | undefined;
    for (let i = 0; i < command.length; i++) {
        const ch = command[i];
        if (quote) {
            if (ch === quote) quote = undefined;
            cur += ch;
        } else if (ch === '"' || ch === "'") {
            quote = ch;
            cur += ch;
        } else if (ch === '\n' || ch === ';') {
            if (cur.trim()) subcmds.push(cur.trim());
            cur = '';
        } else if (ch === '&' && command[i + 1] === '&') {
            if (cur.trim()) subcmds.push(cur.trim());
            cur = '';
            i++;
        } else if (ch === '|' && command[i + 1] === '|') {
            if (cur.trim()) subcmds.push(cur.trim());
            cur = '';
            i++;
        } else if (ch === '|') {
            if (cur.trim()) subcmds.push(cur.trim());
            cur = '';
        } else if (ch === '&') {
            const prevNonSpace = cur.trimEnd().slice(-1);
            if (prevNonSpace === '>') {
                cur += ch;
            } else {
                if (cur.trim()) subcmds.push(cur.trim());
                cur = '';
            }
        } else {
            cur += ch;
        }
    }
    if (quote) throw new Failure('restriction_violation', 'shell command rejected: unterminated quote');
    if (cur.trim()) subcmds.push(cur.trim());
    return subcmds;
}

/** Finds nested $(...) or `...` command substitutions outside single quotes. */
export function extractSubstitutions(command: string): string[] {
    const subs: string[] = [];
    let quote: string | undefined;
    for (let i = 0; i < command.length; i++) {
        const ch = command[i];
        if (quote === "'") {
            if (ch === "'") quote = undefined;
        } else if (quote === '"') {
            if (ch === '"') {
                quote = undefined;
            } else if (ch === '`') {
                const end = command.indexOf('`', i + 1);
                if (end !== -1) {
                    subs.push(command.slice(i + 1, end));
                    i = end;
                }
            } else if (ch === '$' && command[i + 1] === '(') {
                const end = findMatchingParen(command, i + 1);
                if (end !== -1) {
                    subs.push(command.slice(i + 2, end));
                    i = end;
                }
            }
        } else if (ch === "'" || ch === '"') {
            quote = ch;
        } else if (ch === '`') {
            const end = command.indexOf('`', i + 1);
            if (end !== -1) {
                subs.push(command.slice(i + 1, end));
                i = end;
            }
        } else if (ch === '$' && command[i + 1] === '(') {
            const end = findMatchingParen(command, i + 1);
            if (end !== -1) {
                subs.push(command.slice(i + 2, end));
                i = end;
            }
        }
    }
    return subs;
}

const SEARCH_ENDPOINT = 'https://html.duckduckgo.com/html/';
const MAX_SEARCH_RESULTS = 10;

export interface SearchResult {
    title: string;
    url: string;
    snippet: string;
}

const decodeEntities = (s: string): string =>
    s
        .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
        .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
        .replace(/&quot;/g, '"')
        .replace(/&#39;|&apos;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');

const plainText = (html: string): string => decodeEntities(html.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();

/** Extracts result links from DuckDuckGo's HTML results page; result links are redirects carrying the target in `uddg`. */
export function parseSearchResults(html: string): SearchResult[] {
    const results: SearchResult[] = [];
    const link = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
    const snippets = [...html.matchAll(/<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g)];
    let m: RegExpExecArray | null;
    let i = 0;
    while ((m = link.exec(html)) && results.length < MAX_SEARCH_RESULTS) {
        const href = decodeEntities(m[1]);
        let url = href;
        try {
            const u = new URL(href, 'https://duckduckgo.com');
            url = u.searchParams.get('uddg') ?? u.href;
        } catch {
            // keep the raw href
        }
        results.push({ title: plainText(m[2]), url, snippet: snippets[i] ? plainText(snippets[i][1]) : '' });
        i++;
    }
    return results;
}

const looksLikeUrl = (s: string) => /^[a-z][a-z0-9+.-]*:\/\//i.test(s);
const looksLikePath = (s: string) => /[\\/]/.test(s) || s.startsWith('.') || s.startsWith('~') || /^[a-z]:/i.test(s);

function isDirSwitch(executable: string, arg: string): boolean {
    return process.platform === 'win32' && executable.toLowerCase() === 'dir'
        && /^\/(?:-?[bcdlnpqrswx4]|[aot](?::[a-z-]+)?)$/i.test(arg);
}

/**
 * Executes the built-in tools. Every call is checked against the active restrictions,
 * whether it comes from the script itself or from the LLM.
 */
export class ToolHost {
    /** Serialized built-in tool records captured during this host's lifetime. */
    readonly calls: string[] = [];

    constructor(
        private readonly restrictions: Restrictions,
        private readonly cwd: string,
        /** Workflow code gets files and pages whole; a model gets long ones truncated. */
        private readonly raw = false,
    ) {}

    async invoke(name: ToolName, params: Record<string, unknown>): Promise<string> {
        try {
            const output = await this.dispatch(name, params);
            this.calls.push(JSON.stringify({ tool: name, arguments: params, success: true, output }));
            return output;
        } catch (error) {
            if (error instanceof Failure) {
                this.calls.push(JSON.stringify({ tool: name, arguments: params, success: false, error: error.reason }));
            }
            throw error;
        }
    }

    private async dispatch(name: ToolName, params: Record<string, unknown>): Promise<string> {
        switch (name) {
            case 'readFile': return this.readFile(needString(name, params, 'path'));
            case 'writeFile': {
                const content = params.content;
                if (typeof content !== 'string') throw new Failure('tool_error', "writeFile: parameter 'content' must be a string");
                return this.writeFile(needString(name, params, 'path'), content);
            }
            case 'webFetch': return this.webFetch(needString(name, params, 'url'));
            case 'webSearch': return this.webSearch(needString(name, params, 'query'));
            case 'shell': return this.shell(needString(name, params, 'command'));
        }
    }

    private async readFile(p: string): Promise<string> {
        const canonical = this.restrictions.checkPath(p, 'read');
        try {
            const text = await fs.readFile(canonical, 'utf8');
            return this.raw ? text : truncate(text);
        } catch (e) {
            throw new Failure('tool_error', `readFile '${p}': ${(e as Error).message}`);
        }
    }

    private async writeFile(p: string, content: string): Promise<string> {
        const canonical = this.restrictions.checkPath(p, 'write');
        try {
            await fs.mkdir(path.dirname(canonical), { recursive: true });
            await fs.writeFile(canonical, content, 'utf8');
        } catch (e) {
            throw new Failure('tool_error', `writeFile '${p}': ${(e as Error).message}`);
        }
        return `Wrote ${Buffer.byteLength(content)} bytes to ${canonical}`;
    }

    private async webFetch(url: string): Promise<string> {
        let current = this.restrictions.checkUrl(url);
        for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
            let res: Response;
            try {
                res = await fetch(current, { redirect: 'manual', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
            } catch (e) {
                throw new Failure('tool_error', `webFetch '${current.href}': ${(e as Error).message}`);
            }
            if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
                current = this.restrictions.checkUrl(new URL(res.headers.get('location')!, current).href);
                continue;
            }
            let text: string;
            try {
                text = await res.text();
            } catch (e) {
                if (!(e instanceof Error)) throw e;
                throw new Failure('tool_error', `webFetch '${current.href}': ${e.message}`);
            }
            const body = this.raw ? text : truncate(text);
            if (!res.ok) throw new Failure('tool_error', `webFetch '${current.href}': HTTP ${res.status}\n${body}`);
            return body;
        }
        throw new Failure('tool_error', `webFetch '${url}': too many redirects`);
    }

    /** Searches DuckDuckGo's HTML endpoint (no API key); it is a network call, so `restrict net` applies to it. */
    private async webSearch(query: string): Promise<string> {
        const url = this.restrictions.checkUrl(`${SEARCH_ENDPOINT}?q=${encodeURIComponent(query)}`);
        let html: string;
        try {
            const res = await fetch(url, {
                headers: { 'user-agent': 'Mozilla/5.0 (compatible; spl-lang)' },
                signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            html = await res.text();
        } catch (e) {
            throw new Failure('tool_error', `webSearch '${query}': ${(e as Error).message}`);
        }
        const results = parseSearchResults(html);
        if (results.length === 0) return `No results for "${query}".`;
        return results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ''}`).join('\n');
    }

    private async shell(command: string): Promise<string> {
        if (!command || command.trim() === '') throw new Failure('tool_error', 'shell: empty command');
        if (this.restrictions.active) {
            try {
                this.checkCommandRestrictions(command);
            } catch (e) {
                if (e instanceof Failure && e.statusCode === 'restriction_violation') {
                    throw new Failure('restriction_violation', `${e.reason} (shell command: ${JSON.stringify(command)})`);
                }
                throw e;
            }
        }
        return this.run(command, { shell: true });
    }

    private checkCommandRestrictions(command: string): void {
        const subcmds = splitChainedCommands(command);
        if (subcmds.length === 0) throw new Failure('tool_error', 'shell: empty command');
        for (const sub of subcmds) {
            this.checkSubcommand(sub);
        }
        for (const sub of extractSubstitutions(command)) {
            this.checkCommandRestrictions(sub);
        }
    }

    private checkSubcommand(subcmd: string): void {
        const argv = splitCommand(subcmd);
        if (argv.length === 0) return;

        let execIdx = 0;
        while (execIdx < argv.length && /^[a-zA-Z_][a-zA-Z0-9_]*=/.test(argv[execIdx])) {
            execIdx++;
        }
        if (execIdx >= argv.length) return;

        const exe = argv[execIdx].replace(/^[()]+/, '').replace(/[()]+$/, '');
        if (exe) this.restrictions.checkExec(exe);

        for (let i = execIdx + 1; i < argv.length; i++) {
            const arg = argv[i];
            if (arg === '>' || arg === '>>' || arg === '1>' || arg === '2>') {
                const target = argv[++i];
                if (target && !target.startsWith('&') && this.restrictions.has('fs')) {
                    this.restrictions.checkPath(target, 'write');
                }
                continue;
            }
            if (arg === '<' || arg === '0<') {
                const target = argv[++i];
                if (target && this.restrictions.has('fs')) {
                    this.restrictions.checkPath(target, 'read');
                }
                continue;
            }
            if (/^[0-9]?>+/.test(arg)) {
                const target = arg.replace(/^[0-9]?>+/, '');
                if (target && !target.startsWith('&') && this.restrictions.has('fs')) {
                    this.restrictions.checkPath(target, 'write');
                }
                continue;
            }
            if (/^[0-9]?<+/.test(arg)) {
                const target = arg.replace(/^[0-9]?<+/, '');
                if (target && this.restrictions.has('fs')) {
                    this.restrictions.checkPath(target, 'read');
                }
                continue;
            }
            if (isDirSwitch(exe, arg)) continue;
            const value = arg.startsWith('-') && arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : arg;
            if (looksLikeUrl(value)) {
                if (this.restrictions.has('net')) this.restrictions.checkHost(new URL(value).hostname.toLowerCase());
            } else if (this.restrictions.has('fs') && value && !value.startsWith('-') && looksLikePath(value)) {
                this.restrictions.checkPath(value, 'read');
            }
        }
    }

    private run(command: string, opts: { shell: boolean; args?: string[] }): Promise<string> {
        return new Promise((resolve, reject) => {
            const child = spawn(command, opts.args ?? [], { cwd: this.cwd, shell: opts.shell, windowsHide: true });
            let out = '';
            const collect = (text: string) => {
                if (this.raw || out.length < MAX_TEXT * 2) out += text;
            };
            for (const stream of [child.stdout, child.stderr]) {
                const decoder = new StringDecoder('utf8');
                stream.on('data', (data: Buffer) => collect(decoder.write(data)));
                stream.on('end', () => collect(decoder.end()));
            }
            const timer = setTimeout(() => child.kill(), SHELL_TIMEOUT_MS);
            child.on('error', (e) => {
                clearTimeout(timer);
                reject(new Failure('tool_error', `shell: ${e.message}`));
            });
            child.on('close', (code, signal) => {
                clearTimeout(timer);
                const text = this.raw ? out : truncate(out);
                if (code === 0) resolve(text);
                else reject(new Failure('tool_error', `shell: ${signal ? `terminated by ${signal}` : `exit code ${code}`}\n${text}`));
            });
        });
    }
}
