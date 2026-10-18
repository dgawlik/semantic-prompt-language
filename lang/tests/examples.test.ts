import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { run } from '../src/interpreter.js';
import { Logger } from '../src/logger.js';
import { MockBackend, type MockResponder } from '../src/mock.js';
import { parse } from '../src/parser.js';

const dir = path.resolve(__dirname, '..', 'examples');
const load = (name: string) => fs.readFileSync(path.join(dir, name), 'utf8');

async function exec(name: string, responder: MockResponder) {
    const backend = new MockBackend(responder);
    const result = await run(parse(load(name)), { backend, logger: new Logger('silent'), cwd: path.dirname(dir) });
    return { result, backend };
}

describe('examples', () => {
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.spl'))) {
        it(`${file} is valid syntax`, () => {
            expect(() => parse(load(file))).not.toThrow();
        });
    }

    it('triage-issues retries invalid labels and aggregates counts', async () => {
        let first = true;
        const { result, backend } = await exec('triage-issues.spl', (req) => {
            if (!req.prompt.includes('Classify this GitHub issue')) return 'Four issues triaged.';
            if (first) {
                first = false;
                return '{"label": "urgent", "priority": "high", "reason": "x"}';
            }
            const crash = req.prompt.includes('crashes');
            return JSON.stringify({ label: crash ? 'bug' : 'feature', priority: crash ? 'high' : 'low', reason: 'r' });
        });
        expect(result.status).toBe('success');
        const v = (result as { value: any }).value;
        expect(v.counts).toEqual({ bug: 1, feature: 3 });
        expect(v.urgent).toEqual(['App crashes on startup']);
        expect(backend.calls).toHaveLength(6); // 4 issues + 1 retry + summary
        expect(backend.calls[1].prompt).toContain('previous answer was rejected');
    });

    it('extract-invoice feeds validation errors back until the numbers add up', async () => {
        const good = {
            vendor: 'ACME', number: 'INV-2026-0042', date: '2026-03-14', currency: 'EUR',
            lines: [
                { description: 'bolts', quantity: 3, unit_price: 12.5 },
                { description: 'gloves', quantity: 2, unit_price: 8.9 },
                { description: 'drill', quantity: 1, unit_price: 119 },
            ],
            subtotal: 174.3, total: 207.42,
        };
        const bad = { ...good, subtotal: 150 };
        const replies = [bad, good];
        const { result, backend } = await exec('extract-invoice.spl', () => JSON.stringify(replies.shift()));
        expect(result.status).toBe('success');
        expect((result as { value: any }).value.total).toBe(207.42);
        expect(backend.calls).toHaveLength(2);
        expect(backend.calls[1].prompt).toContain('lines add up to 174.3 but subtotal is 150');
    });

    it('extract-invoice fails after three rejected attempts', async () => {
        const { result } = await exec('extract-invoice.spl', () => '{"lines": [], "subtotal": 0, "total": 0}');
        expect(result).toMatchObject({ status: 'failure', failure: { status_code: 'assertion_failed' } });
    });
});
