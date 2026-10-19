import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ToolName } from './ast.js';
import { Failure } from './errors.js';
import type { Restrictions } from './restrict.js';

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
    read_file: {
        name: 'read_file',
        description: 'Read a UTF-8 text file and return its content.',
        properties: { path: { type: 'string', description: 'Path of the file to read' } },
        required: ['path'],
    },
    write_file: {
        name: 'write_file',
        description: 'Create or overwrite a UTF-8 text file (parent folders are created).',
        properties: {
            path: { type: 'string', description: 'Path of the file to write' },
            content: { type: 'string', description: 'Complete new content of the file' },
        },
        required: ['path', 'content'],
    },
    web_fetch: {
        name: 'web_fetch',
        description: 'Fetch an http(s) URL with GET and return the response body as text.',
        properties: { url: { type: 'string', description: 'URL to fetch' } },
        required: ['url'],
    },
    web_search: {
        name: 'web_search',
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

/**
 * Executes the built-in tools. Every call is checked against the active restrictions,
 * whether it comes from the script itself or from the LLM.
 */
export class ToolHost {
    constructor(
        private readonly restrictions: Restrictions,
        private readonly cwd: string,
    ) {}

    async invoke(name: ToolName, params: Record<string, unknown>): Promise<string> {
        switch (name) {
            case 'read_file': return this.readFile(needString(name, params, 'path'));
            case 'write_file': {
                const content = params.content;
                if (typeof content !== 'string') throw new Failure('tool_error', "write_file: parameter 'content' must be a string");
                return this.writeFile(needString(name, params, 'path'), content);
            }
            case 'web_fetch': return this.webFetch(needString(name, params, 'url'));
            case 'web_search': return this.webSearch(needString(name, params, 'query'));
            case 'shell': return this.shell(needString(name, params, 'command'));
        }
    }

    private async readFile(p: string): Promise<string> {
        const canonical = this.restrictions.checkPath(p, 'read');
        try {
            return truncate(await fs.readFile(canonical, 'utf8'));
        } catch (e) {
            throw new Failure('tool_error', `read_file '${p}': ${(e as Error).message}`);
        }
    }

    private async writeFile(p: string, content: string): Promise<string> {
        const canonical = this.restrictions.checkPath(p, 'write');
        try {
            await fs.mkdir(path.dirname(canonical), { recursive: true });
            await fs.writeFile(canonical, content, 'utf8');
        } catch (e) {
            throw new Failure('tool_error', `write_file '${p}': ${(e as Error).message}`);
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
                throw new Failure('tool_error', `web_fetch '${current.href}': ${(e as Error).message}`);
            }
            if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
                current = this.restrictions.checkUrl(new URL(res.headers.get('location')!, current).href);
                continue;
            }
            const body = truncate(await res.text());
            if (!res.ok) throw new Failure('tool_error', `web_fetch '${current.href}': HTTP ${res.status}\n${body}`);
            return body;
        }
        throw new Failure('tool_error', `web_fetch '${url}': too many redirects`);
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
            throw new Failure('tool_error', `web_search '${query}': ${(e as Error).message}`);
        }
        const results = parseSearchResults(html);
        if (results.length === 0) return `No results for "${query}".`;
        return results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ''}`).join('\n');
    }

    private async shell(command: string): Promise<string> {
        if (!command || command.trim() === '') throw new Failure('tool_error', 'shell: empty command');
        if (this.restrictions.active) {
            this.checkCommandRestrictions(command);
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
            const collect = (d: Buffer) => {
                if (out.length < MAX_TEXT * 2) out += d.toString('utf8');
            };
            child.stdout.on('data', collect);
            child.stderr.on('data', collect);
            const timer = setTimeout(() => child.kill(), SHELL_TIMEOUT_MS);
            child.on('error', (e) => {
                clearTimeout(timer);
                reject(new Failure('tool_error', `shell: ${e.message}`));
            });
            child.on('close', (code, signal) => {
                clearTimeout(timer);
                const text = truncate(out);
                if (code === 0) resolve(text);
                else reject(new Failure('tool_error', `shell: ${signal ? `terminated by ${signal}` : `exit code ${code}`}\n${text}`));
            });
        });
    }
}
