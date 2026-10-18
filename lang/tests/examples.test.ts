import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { run } from '../src/interpreter.js';
import { Logger } from '../src/logger.js';
import { parse } from '../src/parser.js';
import { LIVE_TIMEOUT, RecordingCopilot, live } from './live.js';

const dir = path.resolve(__dirname, '..', 'examples');
const load = (name: string) => fs.readFileSync(path.join(dir, name), 'utf8');

describe('examples', () => {
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.spl'))) {
        it(`${file} is valid syntax`, () => {
            expect(() => parse(load(file))).not.toThrow();
        });
    }
});

describe.skipIf(!live)('examples on Copilot', () => {
    it(
        'triage-issues labels every issue and aggregates the counts',
        async () => {
            const backend = new RecordingCopilot(path.dirname(dir));
            try {
                const result = await run(parse(load('triage-issues.spl')), { backend, logger: new Logger('silent'), cwd: path.dirname(dir) });
                expect(result.status).toBe('success');
                const v = (result as { value: { counts: Record<string, number>; urgent: string[] } }).value;
                expect(Object.values(v.counts).reduce((a, b) => a + b, 0)).toBe(4);
                expect(Array.isArray(v.urgent)).toBe(true);
            } finally {
                await backend.close();
            }
        },
        LIVE_TIMEOUT * 3,
    );
});
