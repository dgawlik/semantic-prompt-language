import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentBlock, block, cleanTemp, exec as execute, tempDir } from './helpers.js';
import { LIVE_TIMEOUT, RecordingBackend, live } from './live.js';

const examples = path.resolve(__dirname, '..', 'examples');
let dir: string;
let backend: RecordingBackend;
beforeEach(() => {
    dir = tempDir('spl-live-');
    backend = new RecordingBackend(dir);
});
afterEach(async () => {
    await backend.close();
    cleanTemp();
});
const exec = (source: string) => execute(source, { backend, cwd: dir });

describe.skipIf(!live)('generation and agents on a live provider', () => {
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

    it('coerces a typed answer into an object with methods', async () => {
        const result = await exec(`const Product = Struct('Product', { factors: List(Int), answer: Int }).methods({
    check() { return this.factors.reduce((product, factor) => product * factor, 1) === this.answer; },
});
const product = await ask('Multiply 6 by 7. Report both factors and the answer.', { schema: Product, repairs: 2 });
success([product.answer, product.check()]);`);
        expect(result).toMatchObject({ status: 'success', value: [42, true] });
    }, LIVE_TIMEOUT * 3);

    it.each(['none', 'high', 'max'] as const)('answers with reasoning %s and the same options', async reasoning => {
        expect(await exec(`success(await ask('What is 2+2? Reply with a JSON number', { reasoning: '${reasoning}', fmt: 'json' }));`)).toMatchObject({ status: 'success', value: 4 });
        expect(backend.calls[0]).toMatchObject({ kind: 'ask', reasoningEffort: reasoning });
    }, LIVE_TIMEOUT);

    it('samples without reasoning unless a level is requested', async () => {
        expect(await exec("success(await ask('What is 2+2? Reply with a JSON number', { seed: 7, fmt: 'json' }));")).toMatchObject({ status: 'success', value: 4 });
        expect(backend.calls[0]).toMatchObject({ kind: 'ask', randomness: { seed: 7 } });
        expect(backend.calls[0].reasoningEffort).toBeUndefined();
    }, LIVE_TIMEOUT);

    it('answers an ask block from the values it references', async () => {
        const result = await exec(`const note = 'The magic word is PINEAPPLE.';
const Word = Struct('Word', { word: Str, letters: Int });
${block('Find the magic word in @note and count its letters.', 'outputVar: found', 'outputType: Word', 'repairs: 2')}
success(found);`);
        expect(result).toMatchObject({ status: 'success', value: { word: expect.stringMatching(/^pineapple$/i), letters: 9 } });
        expect(backend.calls[0].kind).toBe('ask');
        expect(backend.calls[0].runtimeTools).toBeUndefined();
    }, LIVE_TIMEOUT * 3);

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

    it('lets an agent block call a function and save typed outputs for later code', async () => {
        const result = await exec(`const note = 'The magic word is PINEAPPLE.';
function shout(text: string): string {
    return text.toUpperCase() + '!';
}
${agentBlock('Extract the magic word from @note and save only that word ->[Str] @word\nCall @shout with the word and save the result ->[Str] @loud\nSave the number of letters in the word ->[Int] @letters')}
success({ word, loud, letters });`);
        expect(result).toMatchObject({ status: 'success', value: { word: expect.stringContaining('PINEAPPLE'), loud: 'PINEAPPLE!', letters: 9 } });
        expect(backend.calls[0]).toMatchObject({ kind: 'agent', runtimeTools: expect.arrayContaining([expect.objectContaining({ name: 'saveVariable' })]) });
    }, LIVE_TIMEOUT);

    it('rejects an unknown model instead of silently selecting a default', async () => {
        expect(await exec("success(await ask('Hi', { model: 'no-such-model' }));")).toMatchObject({ status: 'failure', failure: { status_code: 'llm_error' } });
    }, LIVE_TIMEOUT);
});

describe.skipIf(!live)('examples on a live provider', () => {
    it('extract-invoice extracts a balanced invoice from the sample document', async () => {
        fs.cpSync(path.join(examples, 'data'), path.join(dir, 'examples', 'data'), { recursive: true });
        expect(await exec(fs.readFileSync(path.join(examples, 'extract-invoice.spl'), 'utf8'))).toMatchObject({
            status: 'success', value: { number: 'INV-2026-0042', currency: 'EUR', total: 20742 },
        });
    }, LIVE_TIMEOUT * 3);
});
