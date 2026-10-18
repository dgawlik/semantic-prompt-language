import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { run, type RunResult } from '../src/interpreter.js';
import { Logger } from '../src/logger.js';
import { parse } from '../src/parser.js';
import { LIVE_TIMEOUT, RecordingCopilot, live } from './live.js';

// These tests talk to the real GitHub Copilot service (authenticate once with `spl login`).
// Assertions are deliberately loose: they check structure and behavior, not exact wording.

let dir: string;
let backend: RecordingCopilot;
beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'spl-live-')));
    backend = new RecordingCopilot(dir);
});
afterEach(async () => {
    await backend.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

const exec = (src: string) => run(parse(src), { backend, logger: new Logger('silent'), cwd: dir });

const value = (r: RunResult) => {
    if (r.status !== 'success') throw new Error(`expected success, got ${JSON.stringify(r.failure)}`);
    return r.value;
};
const failure = (r: RunResult) => {
    if (r.status !== 'failure') throw new Error('expected failure');
    return r.failure;
};

describe.skipIf(!live)('LLM commands on Copilot', () => {
    const t = LIVE_TIMEOUT;

    it('answers with length hints and without braces', async () => {
        const result = await exec(`let a = ?{len='word'} 'Name the color of a ripe banana'\nlet b = ?'Say hello'\nsuccess [a, b]`);
        const [a, b] = value(result) as string[];
        expect(a.trim().split(/\s+/).length).toBeLessThanOrEqual(2);
        expect(b.length).toBeGreaterThan(0);
        expect(backend.calls[0].prompt).toBe('Answer with a single word.\n\nName the color of a ripe banana');
        expect(backend.calls[1].prompt).toBe('Say hello');
    }, t);

    it('parses fmt=object responses', async () => {
        const result = await exec(`let r = ?{fmt='object'} 'Reply with a JSON object with the string fields setup and punchline'\nsuccess keys(r)`);
        expect(value(result)).toEqual(expect.arrayContaining(['setup', 'punchline']));
        expect(backend.calls[0].prompt).toContain('valid JSON');
    }, t);

    it('maps think levels and defaults', async () => {
        const result = await exec(`success [think{level='low'} 'What is 2+2? Reply with the digit only', think 'What is 3+3? Reply with the digit only']`);
        const [a, b] = value(result) as string[];
        expect(a).toContain('4');
        expect(b).toContain('6');
        expect(backend.calls[0]).toMatchObject({ kind: 'think', reasoningEffort: 'low', showReasoning: false });
        expect(backend.calls[1]).toMatchObject({ kind: 'think', reasoningEffort: 'medium' });
    }, t);

    it('tracks enforce/forbid scopes and passes results out of them', async () => {
        const result = await exec(`
let color = None
let later = None
enforce 'be polite' {
    forbid 'jokes' {
        let color = ?{len='word'} 'Name a primary color'
    }
    let later = ?{len='word'} 'Name another primary color'
}
let last = ?{len='word'} 'Name a secondary color'
success [color, later, last]
`);
        const [color, later, last] = value(result) as string[];
        expect([color, later, last].every((s) => s.length > 0)).toBe(true);
        expect(backend.calls[0].prompt).toContain('You MUST: be polite');
        expect(backend.calls[0].prompt).toContain('You MUST NOT: jokes');
        expect(backend.calls[1].prompt).toContain('You MUST: be polite');
        expect(backend.calls[1].prompt).not.toContain('jokes');
        expect(backend.calls[2].prompt).not.toContain('be polite');
    }, t * 2);

    it('tells the LLM about active restrictions', async () => {
        await exec(`restrict './out' { let a = ?{len='word'} 'Say OK' }`);
        expect(backend.calls[0].prompt).toContain('File system: you may read and write only inside');
    }, t);
});

describe.skipIf(!live)('tools on Copilot', () => {
    const t = LIVE_TIMEOUT;

    it('read_file with a path feeds the content to the instructions', async () => {
        fs.writeFileSync(path.join(dir, 'f.txt'), 'The magic word is PINEAPPLE.');
        const result = await exec(`success read_file{path='f.txt'} 'Reply with the magic word only'`);
        expect(String(value(result)).toUpperCase()).toContain('PINEAPPLE');
        expect(backend.calls[0].kind).toBe('tool');
        expect(backend.calls[0].prompt).toContain('Instructions: Reply with the magic word only');
        expect(backend.calls[0].pinned).toBeUndefined();
    }, t);

    it('read_file without parameters lets the LLM call the tool', async () => {
        fs.writeFileSync(path.join(dir, 'notes.txt'), 'The magic word is PINEAPPLE.');
        const result = await exec(`success read_file 'Read the file notes.txt and reply with the magic word only'`);
        expect(String(value(result)).toUpperCase()).toContain('PINEAPPLE');
        expect(backend.calls[0].pinned).toEqual({ tool: 'read_file', params: {} });
    }, t);

    it('write_file without content pins the path and lets the LLM write', async () => {
        await exec(`let r = write_file{path='out.txt'} 'Write the single word PINEAPPLE into the file'`);
        expect(backend.calls[0].pinned).toEqual({ tool: 'write_file', params: { path: 'out.txt' } });
        expect(fs.readFileSync(path.join(dir, 'out.txt'), 'utf8').toUpperCase()).toContain('PINEAPPLE');
    }, t);

    it('write_file with content writes it inside the folder only', async () => {
        const ok = await exec(`restrict './out' { let r = write_file{path='./out/a/b.txt', content='hello {1+1}'} 'Confirm in one word' }`);
        expect(ok.status).toBe('success');
        expect(fs.readFileSync(path.join(dir, 'out', 'a', 'b.txt'), 'utf8')).toBe('hello 2');
    }, t);

    it('runs shell commands', async () => {
        const result = await exec(`success shell{command='node -e "console.log(6*7)"'} 'Reply with the printed number only'`);
        expect(String(value(result))).toContain('42');
    }, t);

    it('searches the web', async () => {
        const result = await exec(`success web_search{query='vitest test runner'} 'Reply with one URL from the results and nothing else'`);
        expect(String(value(result))).toMatch(/https?:\/\//);
    }, t);

    it('web_search is blocked by restrict net', async () => {
        const result = await exec(`restrict net 'api.example.com' { let r = web_search{query='vitest'} 'x' }`);
        expect(failure(result).status_code).toBe('restriction_violation');
    }, t);

    it('enforces restrictions on tool calls made by the LLM', async () => {
        fs.mkdirSync(path.join(dir, 'out'));
        fs.writeFileSync(path.join(dir, 'secret.txt'), 'The secret is PINEAPPLE.');
        const prompt = `Use the read_file tool on ./secret.txt and reply with the secret word only`;
        const blocked = await exec(`restrict './out' { success ?'${prompt}' }`);
        // The prompt already tells the model about the restriction, so it may refuse; if it tries, the runtime must block it.
        if (blocked.status === 'failure') expect(blocked.failure.status_code).toBe('restriction_violation');
        else expect(String(blocked.value).toUpperCase()).not.toContain('PINEAPPLE');
        const allowed = await exec(`success ?'${prompt}'`);
        expect(String(value(allowed)).toUpperCase()).toContain('PINEAPPLE');
    }, t * 2);
});
