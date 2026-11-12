import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseMarkdown } from '../src/markdown.js';
import { run } from '../src/workflow.js';
import { cleanTemp, exec as execute, execMarkdown, fence, silent, tempDir } from './helpers.js';
import { LIVE_TIMEOUT, RecordingCopilot, live } from './live.js';

const examples = path.resolve(__dirname, '..', 'examples');
let dir: string;
let backend: RecordingCopilot;
beforeEach(() => {
    dir = tempDir('spl-live-');
    backend = new RecordingCopilot(dir);
});
afterEach(async () => {
    await backend.close();
    cleanTemp();
});
const exec = (code: string) => execute(code, { backend, cwd: dir });

describe.skipIf(!live)('generation and explicit agents on Copilot', () => {
    it('generates text without tools', async () => {
        expect(await exec("success(await ask('Name the color of a ripe banana', { len: 'word' }));")).toMatchObject({ status: 'success', value: expect.any(String) });
        expect(backend.calls[0].kind).toBe('ask');
    }, LIVE_TIMEOUT);

    it('combines reasoning and schema-validated output', async () => {
        const result = await exec(`success(await ask('What is 6 times 7?', {
    reasoning: 'low', repairs: 1,
    schema: { type: 'object', properties: { answer: { type: 'number' } }, required: ['answer'], additionalProperties: false },
}));`);
        expect(result).toMatchObject({ status: 'success', value: { answer: 42 } });
        expect(backend.calls[0].reasoningEffort).toBe('low');
    }, LIVE_TIMEOUT * 2);

    it('parses a typed schema into an object with methods', async () => {
        const result = await exec(`const Product = struct('Product', { factors: list(int), answer: int }).methods({
    check() { return this.factors.reduce((product, factor) => product * factor, 1) === this.answer; },
});
const product = await ask('Multiply 6 by 7. Report both factors and the answer.', { schema: Product, repairs: 2 });
success([product.answer, product.check()]);`);
        expect(result).toMatchObject({ status: 'success', value: [42, true] });
    }, LIVE_TIMEOUT * 3);

    it('supports think shorthand with the same options', async () => {
        expect(await exec("success(await think('What is 2+2? Reply with a JSON number', { reasoning: 'low', fmt: 'json' }));")).toMatchObject({ status: 'success', value: 4 });
        expect(backend.calls[0].kind).toBe('think');
    }, LIVE_TIMEOUT);

    it('keeps raw file and shell operations independent of the model', async () => {
        const result = await exec(`await writeFile('file.txt', 'exact\\n');
const output = await shell('node -e "process.stdout.write(String(42))"');
success([await readFile('file.txt'), output]);`);
        expect(result).toMatchObject({ status: 'success', value: ['exact\n', '42'] });
        expect(backend.calls).toHaveLength(0);
    });

    it('lets an explicit agent read through the runtime tools', async () => {
        fs.writeFileSync(path.join(dir, 'note.txt'), 'The magic word is PINEAPPLE.');
        const result = await exec("success(await restrict('.', () => agent('Read note.txt and return the magic word only')));");
        expect(result).toMatchObject({ status: 'success', value: expect.stringContaining('PINEAPPLE') });
        expect(backend.calls[0].kind).toBe('agent');
    }, LIVE_TIMEOUT);

    it('lets a blockquote agent save a variable for later code', async () => {
        const result = await execMarkdown(`${fence("const note = 'The magic word is PINEAPPLE.';")}

> Extract the magic word from @note and save only that word to @word

${fence('success(word);')}`, { backend, cwd: dir });
        expect(result).toMatchObject({ status: 'success', value: expect.stringContaining('PINEAPPLE') });
        expect(backend.calls[0]).toMatchObject({ kind: 'agent', naturalLanguage: true });
    }, LIVE_TIMEOUT);

    it('rejects an unknown model instead of silently selecting a default', async () => {
        expect(await exec("success(await ask('Hi', { model: 'no-such-model' }));")).toMatchObject({ status: 'failure', failure: { status_code: 'llm_error' } });
    }, LIVE_TIMEOUT);
});

describe.skipIf(!live)('examples on Copilot', () => {
    it('extract-invoice extracts a balanced invoice from the sample document', async () => {
        fs.cpSync(path.join(examples, 'data'), path.join(dir, 'examples', 'data'), { recursive: true });
        const workflow = parseMarkdown(fs.readFileSync(path.join(examples, 'extract-invoice.md'), 'utf8'));
        expect(await run(workflow, { backend, logger: silent, cwd: dir })).toMatchObject({
            status: 'success', value: { number: 'INV-2026-0042', currency: 'EUR', total: 20742 },
        });
    }, LIVE_TIMEOUT * 3);
});
