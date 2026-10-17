import { describe, expect, it } from 'vitest';
import { decidePermission } from '../src/copilot.js';
import type { Failure } from '../src/errors.js';
import { Restrictions, makeRestriction } from '../src/restrict.js';

const cwd = process.cwd();
const restricted = (...rs: ReturnType<typeof makeRestriction>[]) => rs.reduce((acc, r) => acc.with(r), new Restrictions(cwd));

function decide(request: object, restrictions: Restrictions) {
    const blocked: Failure[] = [];
    const result = decidePermission(request as never, restrictions, (f) => blocked.push(f));
    return { result, blocked };
}

describe('Copilot permission layer (hard enforcement)', () => {
    it('approves only the four runtime tools', () => {
        const none = new Restrictions(cwd);
        expect(decide({ kind: 'custom-tool', toolName: 'read_file' }, none).result.kind).toBe('approve-once');
        expect(decide({ kind: 'custom-tool', toolName: 'other' }, none).result.kind).toBe('reject');
        expect(decide({ kind: 'mcp', toolName: 'x' }, none).result.kind).toBe('reject');
    });

    it('blocks built-in file, url and shell requests that violate restrictions', () => {
        const r = restricted(makeRestriction('fs', './out', cwd), makeRestriction('net', 'a.example.com', cwd), makeRestriction('exec', 'git', cwd));
        expect(decide({ kind: 'read', path: '../secret.txt' }, r).blocked).toHaveLength(1);
        expect(decide({ kind: 'write', fileName: './elsewhere.txt' }, r).blocked).toHaveLength(1);
        expect(decide({ kind: 'url', url: 'https://b.example.com/' }, r).blocked).toHaveLength(1);
        expect(decide({ kind: 'shell', commands: [{ identifier: 'rm' }], possiblePaths: [] }, r).blocked).toHaveLength(1);
        const ok = decide({ kind: 'read', path: './out/x.txt' }, r);
        expect(ok.blocked).toHaveLength(0);
        expect(ok.result.kind).toBe('reject'); // built-ins are never exposed; only runtime tools are approved
    });
});

describe('net restrictions', () => {
    it('matches exact hosts and wildcard subdomains', () => {
        const r = restricted(makeRestriction('net', 'api.example.com, *.cdn.test, https://host.test:8443/x', cwd));
        expect(() => r.checkUrl('https://api.example.com/a')).not.toThrow();
        expect(() => r.checkUrl('https://img.cdn.test/a')).not.toThrow();
        expect(() => r.checkUrl('https://host.test/a')).not.toThrow();
        expect(() => r.checkUrl('https://example.com/a')).toThrow(/blocked/);
        expect(() => r.checkUrl('https://evil.com/api.example.com')).toThrow(/blocked/);
        expect(() => r.checkUrl('https://api.example.com.evil.com/')).toThrow(/blocked/);
    });
});
