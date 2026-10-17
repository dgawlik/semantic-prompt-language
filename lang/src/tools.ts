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

/** Characters that let a command chain, redirect or substitute; rejected while any restriction is active. */
const SHELL_META = /[&|;<>`$()\r\n^%!]/;

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

    private async shell(command: string): Promise<string> {
        if (!this.restrictions.active) return this.run(command, { shell: true });

        // With any restriction active only plain commands are accepted, so the checks below are exact.
        if (SHELL_META.test(command)) {
            throw new Failure('restriction_violation', 'shell command rejected: chaining, redirection and substitution are not allowed inside a restrict block');
        }
        const argv = splitCommand(command);
        if (argv.length === 0) throw new Failure('tool_error', 'shell: empty command');
        this.restrictions.checkExec(argv[0]);
        for (const arg of argv.slice(1)) {
            const value = arg.startsWith('-') && arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : arg;
            if (looksLikeUrl(value)) {
                if (this.restrictions.has('net')) this.restrictions.checkHost(new URL(value).hostname.toLowerCase());
            } else if (this.restrictions.has('fs') && value && !value.startsWith('-') && looksLikePath(value)) {
                this.restrictions.checkPath(value, 'read');
            }
        }
        if (argv.some((a) => a.includes('"'))) {
            throw new Failure('restriction_violation', 'shell command rejected: embedded double quotes are not allowed inside a restrict block');
        }
        if (process.platform === 'win32') {
            // .cmd shims (npm, ...) need a shell on Windows; metacharacters were already rejected.
            return this.run(argv.map((a) => (/\s/.test(a) || a === '' ? `"${a}"` : a)).join(' '), { shell: true });
        }
        return this.run(argv[0], { shell: false, args: argv.slice(1) });
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
