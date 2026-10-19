import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { run } from '../src/interpreter.js';
import { Logger } from '../src/logger.js';
import { parse } from '../src/parser.js';
import { LIVE_TIMEOUT, RecordingCopilot, live } from './live.js';

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
const exec = (source: string) => run(parse(source), { backend, logger: new Logger('silent'), cwd: dir });

describe.skipIf(!live)('generation and explicit agents on Copilot', () => {
    it('generates text without tools', async () => {
        expect(await exec(`success ?{len='word'} 'Name the color of a ripe banana'`)).toMatchObject({ status: 'success', value: expect.any(String) });
        expect(backend.calls[0].kind).toBe('ask');
    }, LIVE_TIMEOUT);

    it('combines reasoning and schema-validated output', async () => {
        const result = await exec(`success ?{reasoning='low', schema={'type':'object','properties':{'answer':{'type':'number'}},'required':['answer'],'additionalProperties':False}, repairs=1} 'What is 6 times 7?'`);
        expect(result).toMatchObject({ status: 'success', value: { answer: 42 } });
        expect(backend.calls[0].reasoningEffort).toBe('low');
    }, LIVE_TIMEOUT * 2);

    it('supports think shorthand with the same modifiers', async () => {
        expect(await exec(`success think{reasoning='low', fmt='json'} 'What is 2+2? Reply with a JSON number'`)).toMatchObject({ status: 'success', value: 4 });
    }, LIVE_TIMEOUT);

    it('keeps raw file and shell operations independent of the model', async () => {
        const result = await exec(`write_file('file.txt', 'exact\\n')\nlet output = shell('node -e "process.stdout.write(String(42))"')\nsuccess [read_file('file.txt'), output]`);
        expect(result).toMatchObject({ status: 'success', value: ['exact\n', '42'] });
        expect(backend.calls).toHaveLength(0);
    });

    it('lets an explicit agent read through the runtime tools', async () => {
        fs.writeFileSync(path.join(dir, 'note.txt'), 'The magic word is PINEAPPLE.');
        const result = await exec(`restrict '.' { success agent 'Read note.txt and return the magic word only' }`);
        expect(result).toMatchObject({ status: 'success', value: expect.stringContaining('PINEAPPLE') });
        expect(backend.calls[0].kind).toBe('agent');
    }, LIVE_TIMEOUT);

    it('rejects an unknown model instead of silently selecting a default', async () => {
        expect(await exec(`success ?{model='no-such-model'} 'Hi'`)).toMatchObject({ status: 'failure', failure: { status_code: 'llm_error' } });
    }, LIVE_TIMEOUT);
});
