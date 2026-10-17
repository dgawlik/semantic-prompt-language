import * as fs from 'node:fs';
import * as path from 'node:path';
import type { RestrictKind } from './ast.js';
import { Failure } from './errors.js';

export interface Restriction {
    kind: RestrictKind;
    /** fs: canonical absolute directories; net: lowercase hosts (may be `*.x`); exec: executable names. */
    values: string[];
}

const IS_WINDOWS = process.platform === 'win32';

const violation = (msg: string): Failure => new Failure('restriction_violation', msg);

/** Resolves symlinks of the nearest existing ancestor so `..` and links cannot escape a folder. */
export function canonicalPath(p: string, cwd: string): string {
    const abs = path.resolve(cwd, p);
    const rest: string[] = [];
    let cur = abs;
    for (;;) {
        try {
            const real = fs.realpathSync.native(cur);
            return path.join(real, ...rest.reverse());
        } catch (e) {
            const parent = path.dirname(cur);
            if (parent === cur) return abs;
            if ((e as NodeJS.ErrnoException).code !== 'ENOENT' && (e as NodeJS.ErrnoException).code !== 'ENOTDIR') {
                throw violation(`cannot resolve path '${p}': ${(e as Error).message}`);
            }
            rest.push(path.basename(cur));
            cur = parent;
        }
    }
}

const fold = (p: string) => (IS_WINDOWS ? p.toLowerCase() : p);

function isInside(target: string, root: string): boolean {
    const rel = path.relative(fold(root), fold(target));
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function normalizeHost(entry: string): string {
    let e = entry.trim().toLowerCase();
    if (e.includes('://')) {
        try {
            e = new URL(e).hostname;
        } catch {
            throw violation(`invalid host '${entry}' in restrict net`);
        }
    }
    return e.replace(/:\d+$/, '');
}

export function normalizeExec(name: string): string {
    let n = path.basename(name.trim().replace(/\\/g, '/'));
    if (IS_WINDOWS) n = n.toLowerCase().replace(/\.(exe|cmd|bat|com)$/, '');
    return n;
}

function hostAllowed(host: string, allowed: string[]): boolean {
    return allowed.some((a) => host === a || (a.startsWith('*.') && host.endsWith(a.slice(1))));
}

/** Immutable snapshot of the active `restrict` scopes. Every kind present narrows (intersects). */
export class Restrictions {
    constructor(
        private readonly cwd: string,
        readonly list: readonly Restriction[] = [],
    ) {}

    with(r: Restriction): Restrictions {
        return new Restrictions(this.cwd, [...this.list, r]);
    }

    get active(): boolean {
        return this.list.length > 0;
    }

    has(kind: RestrictKind): boolean {
        return this.list.some((r) => r.kind === kind);
    }

    checkPath(p: string, action: 'read' | 'write' = 'read'): string {
        const canonical = canonicalPath(p, this.cwd);
        for (const r of this.list) {
            if (r.kind === 'fs' && !r.values.some((root) => isInside(canonical, root))) {
                throw violation(`${action} of '${canonical}' blocked: outside allowed folder(s) ${r.values.join(', ')}`);
            }
        }
        return canonical;
    }

    checkUrl(url: string): URL {
        let u: URL;
        try {
            u = new URL(url);
        } catch {
            throw new Failure('tool_error', `invalid URL '${url}'`);
        }
        if (u.protocol !== 'http:' && u.protocol !== 'https:') {
            throw new Failure('tool_error', `unsupported URL scheme '${u.protocol}'`);
        }
        this.checkHost(u.hostname.toLowerCase());
        return u;
    }

    checkHost(host: string): void {
        for (const r of this.list) {
            if (r.kind === 'net' && !hostAllowed(host, r.values)) {
                throw violation(`network access to '${host}' blocked: allowed hosts are ${r.values.join(', ')}`);
            }
        }
    }

    checkExec(name: string): void {
        const n = normalizeExec(name);
        for (const r of this.list) {
            if (r.kind === 'exec' && !r.values.includes(n)) {
                throw violation(`executable '${n}' blocked: allowed executables are ${r.values.join(', ')}`);
            }
        }
    }

    /** Human-readable guidance for the LLM (the first enforcement layer). */
    guidance(): string[] {
        return this.list.map((r) => {
            if (r.kind === 'fs') return `File system: you may read and write only inside: ${r.values.join(', ')}. Any other path will be blocked.`;
            if (r.kind === 'net') return `Network: you may only access these hosts: ${r.values.join(', ')}. Any other host will be blocked.`;
            return `Shell: you may only run these executables: ${r.values.join(', ')}, one simple command at a time (no pipes, redirects or chaining). Anything else will be blocked.`;
        });
    }
}

/** Builds a normalized restriction from the script-provided string ("a,b") or list of strings. */
export function makeRestriction(kind: RestrictKind, raw: unknown, cwd: string): Restriction {
    let items: string[];
    if (typeof raw === 'string') items = raw.split(',');
    else if (Array.isArray(raw) && raw.every((x) => typeof x === 'string')) items = raw.flatMap((x: string) => x.split(','));
    else throw new Failure('runtime_error', `restrict ${kind} expects a string (comma-separated) or a list of strings`);
    items = items.map((s) => s.trim()).filter((s) => s.length > 0);
    if (items.length === 0) throw new Failure('runtime_error', `restrict ${kind} needs at least one entry`);

    if (kind === 'fs') return { kind, values: [...new Set(items.map((i) => canonicalPath(i, cwd)))] };
    if (kind === 'net') return { kind, values: [...new Set(items.map(normalizeHost))] };
    return { kind, values: [...new Set(items.map(normalizeExec))] };
}
