import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const CLI = path.resolve(__dirname, '..', 'dist', 'cli.js');
let dir: string;

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spl-cli-'));
});
afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
});

function spl(script: string, ...args: string[]) {
    const file = path.join(dir, 's.md');
    fs.writeFileSync(file, markdown(script));
    return run([file, ...args]);
}

function markdown(script: string): string {
    return `---\nextension: semantic-prompt-language\nversion: 1\n---\n\n\`\`\`spl\n${script}\n\`\`\`\n`;
}

function run(args: string[], env: NodeJS.ProcessEnv = {}, input?: string) {
    const r = spawnSync(process.execPath, [CLI, ...args], {
        encoding: 'utf8',
        cwd: dir,
        env: { ...process.env, ...env, SPL_HOME: path.join(dir, 'spl-home') },
        input,
    });
    return { code: r.status, out: r.stdout, err: r.stderr };
}

describe('module import CLI', () => {
    it('runs and checks the bundled Markdown library outside the installation directory', () => {
        const source = "import { Document } from 'markdown'\nsuccess Document().heading('Report', 1).to_string()";
        expect(spl(source, '--silent')).toEqual({ code: 0, out: '# Report\n\n', err: '' });
        expect(spl(source, '--check')).toEqual({ code: 0, out: '', err: '' });
    });

    it('resolves modules next to the Markdown file even with a different --cwd', () => {
        const workflows = path.join(dir, 'workflows');
        fs.mkdirSync(workflows);
        fs.writeFileSync(path.join(workflows, 'helpers.spl'), 'def double(value):\n    return value * 2');
        const file = path.join(workflows, 'main.md');
        fs.writeFileSync(file, markdown("import { double } from './helpers.spl'\nsuccess double(21)"));
        expect(run([file, '--cwd', dir, '--silent'])).toEqual({ code: 0, out: '42\n', err: '' });
    });

    it('--check validates imports without executing module effects and reports missing dependencies', () => {
        fs.writeFileSync(path.join(dir, 'helpers.spl'), "fail 'not executed'\nlet value = 42");
        expect(spl("import { value } from './helpers.spl'\nsuccess value", '--check')).toEqual({ code: 0, out: '', err: '' });
        const missing = spl("import { value } from './missing.spl'", '--check');
        expect(missing).toMatchObject({ code: 2, out: '' });
        expect(missing.err).toContain('cannot import');
    });

    it('pins imported source and replays and checks a locked workflow without the library file', () => {
        const library = path.join(dir, 'helpers.spl');
        fs.writeFileSync(library, 'let value = 42');
        expect(spl("import { value } from './helpers.spl'\nsuccess value", '--pin', '--silent'))
            .toEqual({ code: 0, out: '42\n', err: '' });
        fs.unlinkSync(library);
        const locked = path.join(dir, 's.locked.md');
        expect(run([locked, '--silent'])).toEqual({ code: 0, out: '42\n', err: '' });
        expect(run([locked, '--check'])).toEqual({ code: 0, out: '', err: '' });
    });
});

describe('pinned workflow CLI', () => {
    it('saves a successful run beside its source and replays all external inputs without calls, effects or prompts', () => {
        const preload = path.join(dir, 'pin-backend.mjs');
        const backend = new URL('../dist/ai.js', import.meta.url).href;
        const tools = new URL('../dist/tools.js', import.meta.url).href;
        fs.writeFileSync(preload, `import fs from 'node:fs';
import { AiBackend } from ${JSON.stringify(backend)};
import { ToolHost } from ${JSON.stringify(tools)};
AiBackend.prototype.call = async function(request) {
    if (process.env.PIN_REPLAY) throw new Error('unexpected model call');
    fs.appendFileSync('calls.txt', request.model + '\\n');
    return { text: 'captured answer', reasoning: 'captured reasoning', effective: { model: request.model } };
};
AiBackend.prototype.close = async function() {};
const invoke = ToolHost.prototype.invoke;
ToolHost.prototype.invoke = async function(...args) {
    if (process.env.PIN_REPLAY) throw new Error('unexpected tool call');
    return invoke.apply(this, args);
};`);
        const env = {
            NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(preload).href}`,
            SPL_PIN_CLI: 'original environment',
        };
        const source = markdown(`let seed = ['initial']
let input = read_file('input.txt')
let answer = ask(model='other') 'Answer {input}'
let approval = human 'Approve?'
write_file('effect.txt', approval)
seed.append('changed')
success [answer, approval, $env.SPL_PIN_CLI, $args, seed]`);
        const file = path.join(dir, 'flow.md');
        const locked = path.join(dir, 'flow.locked.md');
        fs.writeFileSync(file, source);
        fs.writeFileSync(path.join(dir, 'input.txt'), 'original input');
        const first = run([file, '--pin', '--silent', '--human=  approved  ', '--model=pinned-model',
            '--arg=original'], env);
        expect(first.code).toBe(0);
        expect(first.err).toBe('');
        expect(JSON.parse(first.out)).toEqual([
            'captured answer', '  approved  ', 'original environment', ['original'], ['initial', 'changed'],
        ]);
        expect(fs.readFileSync(file, 'utf8')).toBe(source);
        const lockedSource = fs.readFileSync(locked, 'utf8');
        expect(lockedSource.startsWith(source)).toBe(true);
        expect(lockedSource).toContain('>> ```spl-lock');
        expect(lockedSource).toContain('captured reasoning');
        fs.unlinkSync(path.join(dir, 'effect.txt'));
        fs.unlinkSync(path.join(dir, 'input.txt'));
        const replay = run([locked, '--silent'], { ...env, PIN_REPLAY: '1', SPL_PIN_CLI: 'changed environment' });
        expect(replay).toEqual(first);
        expect(fs.readFileSync(path.join(dir, 'calls.txt'), 'utf8')).toBe('pinned-model\n');
        expect(fs.existsSync(path.join(dir, 'effect.txt'))).toBe(false);
        expect(fs.readFileSync(locked, 'utf8')).toBe(lockedSource);
    });

    it('uses a sibling .locked.md path, independently of --cwd, including uppercase Markdown extensions', () => {
        const base = path.join(dir, 'base');
        fs.mkdirSync(base);
        const file = path.join(dir, 'FLOW.MD');
        fs.writeFileSync(file, markdown('success 42'));
        expect(run([file, '--pin', '--cwd', base, '--silent'])).toEqual({ code: 0, out: '42\n', err: '' });
        expect(fs.existsSync(path.join(dir, 'FLOW.locked.md'))).toBe(true);
        expect(fs.existsSync(path.join(base, 'FLOW.locked.md'))).toBe(false);
        expect(run([path.join(dir, 'FLOW.locked.md'), '--silent'])).toEqual({ code: 0, out: '42\n', err: '' });
    });

    it('does not pin failures or syntax checks, and refuses to overwrite a lock before executing', () => {
        const locked = path.join(dir, 's.locked.md');
        expect(spl("fail 'failed'", '--pin', '--silent').code).toBe(1);
        expect(fs.existsSync(locked)).toBe(false);
        expect(spl('let =', '--pin', '--silent').code).toBe(2);
        expect(fs.existsSync(locked)).toBe(false);
        expect(spl("success ask 'Not executed'", '--pin', '--check', '--silent'))
            .toEqual({ code: 0, out: '', err: '' });
        expect(fs.existsSync(locked)).toBe(false);
        fs.writeFileSync(locked, 'existing content');
        const result = spl("write_file('should-not-exist', 'content')", '--pin', '--silent');
        expect(result.code).toBe(2);
        expect(result.err).toContain('already exists');
        expect(fs.readFileSync(locked, 'utf8')).toBe('existing content');
        expect(fs.existsSync(path.join(dir, 'should-not-exist'))).toBe(false);
    });

    it('does not publish a lock when backend cleanup fails', () => {
        const preload = path.join(dir, 'close-failure.mjs');
        fs.writeFileSync(preload, `import { AiBackend } from ${JSON.stringify(new URL('../dist/ai.js', import.meta.url).href)};
import { LlmError } from ${JSON.stringify(new URL('../dist/llm.js', import.meta.url).href)};
AiBackend.prototype.close = async function() { throw new LlmError('cleanup failed'); };`);
        const file = path.join(dir, 'flow.md');
        fs.writeFileSync(file, markdown('success 42'));
        const result = run([file, '--pin', '--silent'], {
            NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(preload).href}`,
        });
        expect(result.code).toBe(1);
        expect(JSON.parse(result.out)).toMatchObject({ status_code: 'llm_error', reason: 'cleanup failed' });
        expect(fs.existsSync(path.join(dir, 'flow.locked.md'))).toBe(false);
    });

    it.each(['--trace=trace.jsonl'])(
        'rejects --pin with %s before running', option => {
            const result = spl('success 42', '--pin', option, '--silent');
            expect(result.code).toBe(2);
            expect(result.err).toContain('--pin cannot be combined');
            expect(fs.existsSync(path.join(dir, 's.locked.md'))).toBe(false);
        },
    );

    it('rejects live overrides and missing journals without falling back to execution', () => {
        expect(spl('success $args', '--pin', '--arg=original', '--silent').code).toBe(0);
        const locked = path.join(dir, 's.locked.md');
        for (const option of ['--pin', '--mcp=missing.json', '--human=answer', '--trace=trace.jsonl']) {
            const result = run([locked, option, '--silent']);
            expect(result.code).toBe(2);
            expect(result.err).toContain('locked workflows cannot');
        }
        for (const option of ['--arg=changed', '--model=changed', `--cwd=${path.join(dir, 'other')}`]) {
            const result = run([locked, option, '--silent']);
            expect(result.code).toBe(1);
            expect(JSON.parse(result.out)).toMatchObject({ reason: expect.stringContaining('options mismatch') });
        }
        fs.writeFileSync(locked, markdown("success ask 'Must not run live'"));
        const missing = run([locked, '--silent']);
        expect(missing.code).toBe(2);
        expect(missing.err).toContain('missing its execution journal');
    });
});

describe('direct human input CLI', () => {
    function prompt(script: string, input: string, ...args: string[]) {
        const file = path.join(dir, 's.md');
        fs.writeFileSync(file, markdown(script));
        return run([file, ...args], {}, input);
    }

    it('consumes repeatable answers in question order without prompting or a checkpoint', () => {
        const result = spl(`let a = human 'Color?'\nlet b = human 'Fruit?'\nsuccess [a, b, $args]`,
            '--human', '  blue\nsky  ', '--human=--apple', '--arg=script', '--silent');
        expect(result).toEqual({ code: 0, out: '[\n  "  blue\\nsky  ",\n  "--apple",\n  [\n    "script"\n  ]\n]\n', err: '' });
        expect(fs.existsSync(path.join(dir, 'run.jsonl'))).toBe(false);
        expect(spl(`success human 'Empty?'`, '--human=', '--silent')).toEqual({ code: 0, out: '\n', err: '' });
    });

    it('prompts directly on stderr even when silent and retains buffered lines and whitespace', () => {
        const result = prompt(`let a = human 'Color?'\nlet b = human 'Fruit?'\nsuccess [a, b]`,
            '  blue  \r\n\r\n', '--silent');
        expect(result).toEqual({ code: 0, out: '[\n  "  blue  ",\n  ""\n]\n', err: 'Color?\n> Fruit?\n> ' });
    });

    it('prompts only for remaining questions and does not consume answers in skipped expressions', () => {
        const result = prompt(`let skipped = False and human 'Skipped?'\nlet a = human 'Color?'\nlet b = human 'Fruit?'\nsuccess [skipped, a, b]`,
            'apple\n', '--human=blue', '--silent');
        expect(result).toEqual({ code: 0, out: '[\n  false,\n  "blue",\n  "apple"\n]\n', err: 'Fruit?\n> ' });
    });

    it('reports EOF as a script failure instead of suspending or inventing an answer', () => {
        const result = prompt(`success human 'Color?'`, '', '--silent');
        expect(result.code).toBe(1);
        expect(JSON.parse(result.out)).toMatchObject({
            status_code: 'runtime_error', reason: expect.stringContaining('stdin ended'),
        });
        expect(result.err).toBe('Color?\n> ');
    });

    it('sanitizes terminal controls in questions without modifying answers', () => {
        const result = prompt(`success human 'Color?\u001b[31m\u0007'`, 'blue\n', '--silent');
        expect(result).toEqual({ code: 0, out: 'blue\n', err: 'Color?\n> ' });
    });

    it('handles both questions in the color-poem blockquotes in the same agent sessions', () => {
        const preload = path.join(dir, 'human-backend.mjs');
        const backend = new URL('../dist/copilot.js', import.meta.url).href;
        fs.writeFileSync(preload, `import { CopilotBackend } from ${JSON.stringify(backend)};
CopilotBackend.prototype.call = async function(request) {
    const action = (name, args) => request.invokeAction({ name, arguments: args });
    if (request.prompt.includes('What is your favorite color?')) {
        await action('save_variable', { name: 'color', value: await action('ask_human', { question: 'Color?' }) });
    } else if (request.prompt.includes('What is your favorite fruit?')) {
        await action('save_variable', { name: 'fruit', value: await action('ask_human', { question: 'Fruit?' }) });
    } else {
        const color = await action('load_variable', { name: 'color' });
        const fruit = await action('load_variable', { name: 'fruit' });
        await action('save_variable', { name: 'poem', value: color + ' ' + fruit });
    }
    return { text: 'Done', effective: {} };
};
CopilotBackend.prototype.close = async function() {};`);
        const example = path.resolve(__dirname, '..', 'examples', 'color-poem.md');
        for (const [args, input, err] of [
            [['--human=blue', '--human=apple'], '', ''],
            [[], 'blue\napple\n', 'Color?\n> Fruit?\n> '],
        ] as const) {
            const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, CLI, example, '--silent', ...args], {
                encoding: 'utf8', cwd: dir, input, timeout: 10_000,
            });
            expect({ code: result.status, out: result.stdout, err: result.stderr })
                .toEqual({ code: 0, out: '{\n  "poem": "blue apple"\n}\n', err });
        }
    });
});

it('runs the randomness example through tool-free seeded OpenAI requests', () => {
    const preload = path.join(dir, 'randomness-provider.mjs');
    const requests = path.join(dir, 'requests.jsonl');
    fs.writeFileSync(preload, `import fs from 'node:fs';
globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    fs.appendFileSync(${JSON.stringify(requests)}, JSON.stringify({url: String(url), body}) + '\\n');
    if ('parallel_tool_calls' in body && !body.tools?.length) return new Response(JSON.stringify({
        error: {message: "'parallel_tool_calls' is only allowed when 'tools' are specified."}
    }), {status: 400, headers: {'content-type': 'application/json'}});
    const chunk = (delta, finish_reason = null) => ({
        id: 'chat_1', object: 'chat.completion.chunk', created: 1, model: body.model,
        choices: [{index: 0, delta, finish_reason}]
    });
    return new Response([
        chunk({content: 'Bake apples in a pastry crust with sugar and cinnamon.'}),
        chunk({}, 'stop')
    ].map(event => 'data: ' + JSON.stringify(event) + '\\n\\n').join(''),
        {headers: {'content-type': 'text/event-stream'}});
};`);
    const result = run([path.resolve(__dirname, '..', 'examples', 'randomness.md'), '--silent'], {
        OPENAI_API_KEY: 'test-openai',
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(preload).href}`,
    });
    expect(result).toEqual({
        code: 0,
        out: JSON.stringify([
            'Bake apples in a pastry crust with sugar and cinnamon.',
            'Bake apples in a pastry crust with sugar and cinnamon.',
        ], null, 2) + '\n',
        err: '',
    });
    const calls = fs.readFileSync(requests, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(calls).toHaveLength(2);
    for (const { url, body } of calls) {
        expect(url).toContain('/chat/completions');
        expect(body).toMatchObject({ model: 'gpt-6-luna', seed: 13, temperature: 0, top_p: 0.0001, max_completion_tokens: 1024 });
        expect(body).not.toHaveProperty('tools');
        expect(body).not.toHaveProperty('parallel_tool_calls');
    }
});


describe('append-only trace CLI', () => {
    it('replays a completed flow byte-for-byte without prompts, models, MCP or explicit side effects', () => {
        const preload = path.join(dir, 'trace-backend.mjs');
        fs.writeFileSync(preload, `import fs from 'node:fs';
import { AiBackend } from ${JSON.stringify(new URL('../dist/ai.js', import.meta.url).href)};
AiBackend.prototype.call = async function(request) {
    if (process.env.TRACE_OFFLINE) throw new Error('unexpected live model call');
    fs.appendFileSync('calls.txt', request.kind + '\\n');
    return { text: 'saved answer', reasoning: 'saved reasoning', effective: { model: 'test' } };
};
AiBackend.prototype.close = async function() {};`);
        const env = {
            NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(preload).href}`,
            SPL_TRACE_INPUT: 'original',
        };
        const script = `let input = read_file('input.txt')
let answer = ask 'Answer {input}'
let approval = human 'Approve?'
write_file('output.txt', approval)
success [answer, approval, $args, $env.SPL_TRACE_INPUT]`;
        const source = path.join(dir, 'flow.md');
        const trace = path.join(dir, 'trace.jsonl');
        fs.writeFileSync(source, markdown(script));
        fs.writeFileSync(path.join(dir, 'input.txt'), 'original');
        const first = run([source, '--trace', trace, '--arg=initial', '--silent'], env, '  approved  \n');
        expect(first.code).toBe(0);
        expect(JSON.parse(first.out)).toEqual(['saved answer', '  approved  ', ['initial'], 'original']);
        const original = fs.readFileSync(trace, 'utf8');
        expect(JSON.parse(original.split('\n')[0])).toMatchObject({ format: 'spl-trace', version: 2 });
        fs.unlinkSync(path.join(dir, 'input.txt'));
        fs.unlinkSync(path.join(dir, 'output.txt'));
        const replay = run([source, '--trace', trace, '--silent'], { ...env, TRACE_OFFLINE: '1', SPL_TRACE_INPUT: 'changed' });
        expect(replay).toEqual({ code: 0, out: first.out, err: '' });
        expect(fs.readFileSync(trace, 'utf8')).toBe(original);
        expect(fs.readFileSync(path.join(dir, 'calls.txt'), 'utf8')).toBe('ask\n');
        expect(fs.existsSync(path.join(dir, 'output.txt'))).toBe(false);
        expect(fs.existsSync(`${trace}.lock`)).toBe(false);
    });

    it('resumes an interrupted question using --human only for unrecorded answers', () => {
        const preload = path.join(dir, 'interrupt-input.mjs');
        fs.writeFileSync(preload, `import { Trace } from ${JSON.stringify(new URL('../dist/trace.js', import.meta.url).href)};
const effect = Trace.prototype.effect;
Trace.prototype.effect = async function(request, perform, valid) {
    if (request.kind === 'human' && request.question === 'Second?' && !this.replaying && !process.env.CONTINUE_TRACE) {
        perform = () => { throw new Error('simulated interruption'); };
    }
    return effect.call(this, request, perform, valid);
};`);
        const env = { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(preload).href}` };
        const source = path.join(dir, 'flow.md');
        const trace = path.join(dir, 'resume.jsonl');
        fs.writeFileSync(source, markdown(`write_file('output.txt', 'original')
let first = human 'First?'
let second = human 'Second?'
success [first, second]`));
        const stopped = run([source, '--trace', trace, '--human=one', '--silent'], env);
        expect(stopped.code).toBe(70);
        const prefix = fs.readFileSync(trace, 'utf8');
        fs.writeFileSync(path.join(dir, 'output.txt'), 'edited');
        expect(run([source, '--trace', trace, '--human=two', '--silent'], { ...env, CONTINUE_TRACE: '1' }))
            .toEqual({ code: 0, out: '[\n  "one",\n  "two"\n]\n', err: '' });
        expect(fs.readFileSync(path.join(dir, 'output.txt'), 'utf8')).toBe('edited');
        expect(fs.readFileSync(trace, 'utf8').startsWith(prefix)).toBe(true);
    });

    it('creates a fresh flow only for a different trace path, preserves failures, and skips --check output', () => {
        const firstFile = path.join(dir, 'first.jsonl');
        expect(spl('success 1', '--trace', firstFile, '--check')).toEqual({ code: 0, out: '', err: '' });
        expect(fs.existsSync(firstFile)).toBe(false);
        const first = spl(`write_file('effect.txt', 'original')\nsuccess 1`, '--trace', firstFile, '--silent');
        expect(first).toEqual({ code: 0, out: '1\n', err: '' });
        fs.writeFileSync(path.join(dir, 'effect.txt'), 'changed');
        expect(spl(`write_file('effect.txt', 'original')\nsuccess 1`, '--trace', firstFile, '--silent')).toEqual(first);
        expect(fs.readFileSync(path.join(dir, 'effect.txt'), 'utf8')).toBe('changed');
        expect(spl(`write_file('effect.txt', 'original')\nsuccess 1`, '--trace', path.join(dir, 'second.jsonl'), '--silent')).toEqual(first);
        expect(fs.readFileSync(path.join(dir, 'effect.txt'), 'utf8')).toBe('original');
        const failureFile = path.join(dir, 'failure.jsonl');
        const failure = spl(`fail 'rejected'`, '--trace', failureFile, '--silent');
        expect(failure.code).toBe(1);
        const bytes = fs.readFileSync(failureFile, 'utf8');
        expect(spl(`fail 'rejected'`, '--trace', failureFile, '--silent')).toEqual(failure);
        expect(fs.readFileSync(failureFile, 'utf8')).toBe(bytes);
        expect(spl('pass', '--trace', path.join(dir, 'empty.jsonl'), '--silent')).toEqual({ code: 0, out: '', err: '' });
    });

    it('rejects mismatched scripts and arguments without changing the trace', () => {
        const trace = path.join(dir, 'guarded.jsonl');
        expect(spl('success $args', '--trace', trace, '--arg=one', '--silent').code).toBe(0);
        const original = fs.readFileSync(trace, 'utf8');
        for (const result of [
            spl('success 2', '--trace', trace, '--silent'),
            spl('success $args', '--trace', trace, '--arg=two', '--silent'),
        ]) {
            expect(result.code).toBe(2);
            expect(result.out).toBe('');
            expect(result.err).toContain('mismatch');
        }
        expect(fs.readFileSync(trace, 'utf8')).toBe(original);
    });

    it.each(['--store=file', '--store-module=file', '--record=file', '--replay=file', '--checkpoint=file',
        '--resume=file', '--answer-for=id', '--answer=value', '--answer-file=file', '--answre-file=file',
        '--trace=', '--trace'])('rejects removed or invalid option %s', option => {
        const result = spl('success 1', option, '--silent');
        expect(result).toMatchObject({ code: 2, out: '' });
        expect(result.err).toContain('spl:');
    });

    it('advertises only the consolidated trace interface', () => {
        const help = run(['--help']).out;
        expect(help).toContain('--trace <file.jsonl>');
        expect(help).toContain('Reuse the same path to resume');
        for (const option of ['--store', '--record', '--replay', '--checkpoint', '--resume', '--answer']) {
            expect(help).not.toContain(option);
        }
    });
});

describe('cli', () => {
    it('matches the five-event offline alias smoke workflow byte for byte', () => {
        const source = `let count = 1
count = count
count += 1
let items = [1]
let alias = items
alias.append(2)
success count`;
        const result = spl(source, '--log-level', 'debug');
        expect(result).toMatchObject({ code: 0, out: '2\n' });
        expect(result.err.match(/^~ state /gm)).toHaveLength(5);
        expect(result.err).toContain('count @ global (scope-1): <unbound> -> 1');
        expect(result.err).toContain('count @ global (scope-1): 1 -> 2');
        const mutation = result.err.slice(result.err.lastIndexOf('~ state'));
        expect(mutation).toContain('items @ global');
        expect(mutation).toContain('alias @ global');
        expect(mutation).toContain('[\n  1\n] -> [\n  1,\n  2\n]');
        expect(result.err).not.toMatch(/\u001b|count = count|success count|\[folded\]/);
        expect(spl(source, '--silent')).toEqual({ code: 0, out: '2\n', err: '' });
    });

    it.each([undefined, 'error', 'info'] as const)('hides state changes at %s verbosity without changing results', level => {
        const result = spl('let items = []\nitems.append(1)\nsuccess items', ...(level ? ['--log-level', level] : []));
        expect(result).toEqual({ code: 0, out: '[\n  1\n]\n', err: '' });
    });

    it.each([
        [undefined, undefined, 'xterm', false], ['1', undefined, 'xterm', true],
        ['0', undefined, 'xterm', false], ['1', '1', 'xterm', false],
        [undefined, undefined, 'dumb', false], ['1', undefined, 'dumb', true],
    ])('keeps redirected output append-only with FORCE_COLOR=%s NO_COLOR=%s TERM=%s', (force, noColor, term, color) => {
        const file = path.join(dir, 'colors.md');
        fs.writeFileSync(file, markdown("let n = 1\nlog('hi')\nsuccess n"));
        const result = run([file], { FORCE_COLOR: force, NO_COLOR: noColor, TERM: term });
        expect(result).toMatchObject({ code: 0, out: '1\n' });
        expect(result.err.includes('\u001b[')).toBe(color);
        expect(result.err.replace(/\u001b\[[\d;]*m/g, '')).not.toContain('\u001b');
        expect(result.err).not.toContain('Enter/Space');
    });

    it('never loads native UI, spawns renderers or acquires input for excluded invocations and library sinks', () => {
        const preload = path.join(dir, 'excluded.mjs');
        const marker = path.join(dir, 'acquisition.txt');
        fs.writeFileSync(preload, `import fs from 'node:fs';
import cp from 'node:child_process';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
const record = value => fs.appendFileSync(${JSON.stringify(marker)}, value + '\\n');
Object.defineProperty(process.stdin, 'isTTY', { value: true });
Object.defineProperty(process.stderr, 'isTTY', { value: true });
process.stdin.setRawMode = () => { record('raw'); return process.stdin; };
const on = process.stdin.on;
process.stdin.on = function(name, ...args) { if (name === 'data' || name === 'readable') record('input'); return on.call(this, name, ...args); };
cp.fork = () => { record('spawn'); throw new Error('test renderer forbidden'); };
syncBuiltinESMExports();
registerHooks({ resolve(specifier, context, next) { if (specifier.startsWith('@bettertui/')) { record('native'); throw new Error('test native forbidden'); } return next(specifier, context); } });`);
        const file = path.join(dir, 'excluded.md');
        fs.writeFileSync(file, markdown("success human 'question'"));
        const preloadUrl = pathToFileURL(preload).href;
        const invoke = (args: string[]) => spawnSync(process.execPath, ['--import', preloadUrl, CLI, ...args], {
            encoding: 'utf8', env: { ...process.env, TERM: 'xterm', NO_COLOR: '1', SPL_HOME: path.join(dir, 'spl-home') },
        });
        for (const [args, code] of [
            [['--help'], 0], [['--version'], 0], [['logout'], 0], [[file, '--check'], 0],
        ] as const) {
            const result = invoke([...args]);
            expect({ code: result.status, err: result.stderr }).toEqual({ code, err: '' });
        }
        fs.writeFileSync(file, markdown('let n = 1\nsuccess n'));
        const silent = invoke([file, '--silent']);
        expect({ code: silent.status, err: silent.stderr }).toEqual({ code: 0, err: '' });
        const library = spawnSync(process.execPath, ['--import', preloadUrl, '--input-type=module', '-e',
            `import { Logger } from ${JSON.stringify(new URL('../dist/index.js', import.meta.url).href)}; new Logger('info', () => {}).info('embedded');`],
            { encoding: 'utf8' });
        expect(library.status).toBe(0);
        expect(fs.existsSync(marker)).toBe(false);
    });



    it('keeps renderer IPC and cancellation timers responsive during long deterministic execution', () => {
        const script = `import {run,parse,Logger} from ${JSON.stringify(new URL('../dist/index.js', import.meta.url).href)};
let active=true;
setTimeout(()=>{active=false;},10);
const result=await run(parse('let count = 0\\nwhile active():\\n    count += 1\\nsuccess count'),{
backend:{async call(){throw new Error('unexpected model');},async close(){}},
logger:new Logger('silent'),
store:{load:()=>({active:{__fn:'builtin',name:'active',call:()=>active}}),save(){}}
});
if(result.status!=='success'||result.value<=0) throw new Error('loop did not complete');
process.stdout.write('responsive\\n');`;
        const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 2_000 });
        expect(result.error).toBeUndefined();
        expect(result.stdout).toBe('responsive\n');
        expect(result.status).toBe(0);
    });

    it('rejects raw SPL files and Markdown without the exact opt-in', () => {
        const raw = path.join(dir, 'legacy.spl');
        fs.writeFileSync(raw, 'success 42');
        const legacy = run([raw, '--check']);
        expect(legacy.code).toBe(2);
        expect(legacy.err).toContain('only .md workflows');
        const file = path.join(dir, 'ordinary.md');
        for (const source of [
            '# Notes\n\n```spl\nsuccess 42\n```',
            markdown('success 42').replace('semantic-prompt-language', 'other-extension'),
            markdown('success 42').replace('version: 1', 'version: 2'),
        ]) {
            fs.writeFileSync(file, source);
            expect(run([file, '--check']).code).toBe(2);
        }
    });

    it('checks natural-language blocks offline and runs shared SPL fences in order', () => {
        const file = path.join(dir, 'mixed.md');
        fs.writeFileSync(file, markdown('let value = 20') + '\n> Double @value.\n');
        expect(run([file, '--check'])).toEqual({ code: 0, out: '', err: '' });
        fs.writeFileSync(file, markdown('let value = 20') + '\nIgnored prose\n\n```spl\nvalue *= 2\nsuccess value + 2\n```\n');
        expect(run([file, '--silent'])).toEqual({ code: 0, out: '42\n', err: '' });
    });

    it('passes repeated --arg values in order before and after the script path', () => {
        const file = path.join(dir, 'args.md');
        fs.writeFileSync(file, markdown(`success [$args, $args[0], $args[3]]`));
        const result = run(['--arg=first', file, '--arg', 'two words', '--silent', '--arg=--model=x']);
        expect(result.code).toBe(0);
        expect(JSON.parse(result.out)).toEqual([['first', 'two words', '--model=x'], 'first', null]);
        expect(result.err).toBe('');
    });

    it('supports empty arguments and defaults to an empty argument list', () => {
        expect(JSON.parse(spl(`success [$args, $args[0]]`, '--silent').out)).toEqual([[], null]);
        expect(JSON.parse(spl(`success [$args[0], $args[1]]`, '--arg=', '--silent').out)).toEqual(['', null]);
        expect(spl(`success 1`, '--arg').code).toBe(2);
        expect(spl(`success $args[0]`, '--arg=x', '--check')).toEqual({ code: 0, out: '', err: '' });
    });

    it('exposes the child process environment', () => {
        const result = spl(`success [$env.SPL_HOME, $env['SPL_HOME']]`, '--silent');
        expect(result.code).toBe(0);
        expect(JSON.parse(result.out)).toEqual([path.join(dir, 'spl-home'), path.join(dir, 'spl-home')]);
    });

    it('prints the success value to stdout and logs to stderr', () => {
        const r = spl(`log('hi')\nsuccess 'done'`);
        expect(r.code).toBe(0);
        expect(r.out).toBe('done\n');
        expect(r.err).toContain('[info] log: hi');
    });

    it('prints the value of a top-level return', () => {
        const r = spl(`let a = 41
:
    return a + 1
fail 'unreachable'`, '--silent');
        expect(r.code).toBe(0);
        expect(r.out).toBe('42\n');
    });

    it('prints non-string results as JSON', () => {
        expect(JSON.parse(spl(`success object:
    'a': [1, None, True]`).out)).toEqual({ a: [1, null, true] });
    });

    it('pretty-prints and colors JSON logs on stderr without changing stdout', () => {
        const file = path.join(dir, 'pretty.md');
        fs.writeFileSync(file, markdown("let review = object:\n    'findings': [object:\n        'severity': 'high'\n        'line': 12\n    ]\nlog('review:', review)\nsuccess review"));
        const plain = run([file], { FORCE_COLOR: undefined, NO_COLOR: undefined });
        const colored = run([file], { FORCE_COLOR: '1', NO_COLOR: undefined });
        expect(plain.code).toBe(0);
        expect(colored.code).toBe(0);
        expect(colored.out).toBe(plain.out);
        expect(JSON.parse(colored.out)).toEqual({ findings: [{ severity: 'high', line: 12 }] });
        expect(colored.out).not.toContain('\u001b[');
        expect(plain.err).not.toContain('\u001b[');
        expect(colored.err).toContain('\u001b[36m"findings"\u001b[0m');
        expect(stripVTControlCharacters(colored.err)).toBe(plain.err);
        expect(plain.err).toContain('[info] log: review:\n{\n  "findings": [');
        expect(plain.err).not.toContain('[deterministic]');
        expect(run([file, '--silent'], { FORCE_COLOR: '1', NO_COLOR: undefined }).err).toBe('');
    });

    it('uses the same log format for CLI usage and syntax diagnostics', () => {
        const usage = run(['--unknown-option'], { NO_COLOR: '1', FORCE_COLOR: undefined });
        expect(usage.code).toBe(2);
        expect(usage.out).toBe('');
        expect(usage.err).toMatch(/^x error /);
        expect(usage.err.match(/x error/g)).toHaveLength(1);
        const syntax = spl('let value =');
        expect(syntax.code).toBe(2);
        expect(syntax.err).toContain('x error ');
    });

    it('--silent suppresses logs', () => {
        const r = spl(`log('hi')\nsuccess 1`, '--silent');
        expect(r.err).toBe('');
        expect(r.out).toBe('1\n');
    });

    it('--log-level error hides info logs', () => {
        const r = spl(`log('hi')\nsuccess 1`, '--log-level', 'error');
        expect(r.err).not.toContain('[info]');
        expect(r.err).toBe('');
    });

    it('prints the failure payload to stdout and exits non-zero', () => {
        const r = spl(`let a = 1\nfail 'nope'`, '--silent');
        expect(r.code).toBe(1);
        expect(JSON.parse(r.out)).toEqual({ status: 'failure', reason: 'nope', command: "fail 'nope'", line: 8, status_code: 'explicit_failure' });
    });

    it('reports syntax errors on stderr with exit code 2', () => {
        const r = spl(`let a = ask(unknown='huge') 'x'`);
        expect(r.code).toBe(2);
        expect(r.out).toBe('');
        expect(r.err).toMatch(/s\.md:7:\d+: syntax error: unknown modifier/);
    });

    it('--check only parses', () => {
        expect(spl(`fail 'x'`, '--check').code).toBe(0);
        expect(spl(`fail`, '--check').code).toBe(2);
    });

    it('validates expression-valued modifiers at runtime without contacting the model', () => {
        const r = spl(`success ask(len='huge') 'x'`, '--silent');
        expect(r.code).toBe(1);
        expect(JSON.parse(r.out)).toMatchObject({ status_code: 'runtime_error', reason: expect.stringContaining('len must be') });
    });







    it('rejects bad usage and the removed mock/seed options', () => {
        const r = spawnSync(process.execPath, [CLI], { encoding: 'utf8' });
        expect(r.status).toBe(2);
        expect(spl(`success 1`, '--log-level', 'loud').code).toBe(2);
        expect(spl(`success 1`, '--backend', 'mock').code).toBe(2);
        expect(spl(`success 1`, '--seed', '1').code).toBe(2);
    });

    it('logout removes saved credentials and tolerates their absence', () => {
        expect(run(['logout']).out).toBe('No saved credentials.\n');
        const home = path.join(dir, 'spl-home');
        fs.mkdirSync(home, { recursive: true });
        fs.writeFileSync(path.join(home, 'credentials.json'), JSON.stringify({ token: 'x' }));
        expect(run(['logout']).out).toBe('Saved credentials removed.\n');
        expect(fs.existsSync(path.join(home, 'credentials.json'))).toBe(false);
        expect(run(['logout', 'extra']).code).toBe(2);
    });

    it('lists login and logout in the help', () => {
        const help = run(['--help']).out;
        expect(help).toContain('spl login');
        expect(help).toContain('spl logout');
        expect(help).toContain('--provider <name>');
        expect(help).not.toContain('--backend');
        expect(help).not.toContain('--seed');
        expect(help).toContain('--mcp <file.json>');
        expect(help).toContain('--arg <value>');
        expect(help).toContain('variable-state changes');
        expect(help).toContain('defining scopes');
        expect(help).toContain('no-op assignments');
        expect(help).toContain('Enter/Space toggle');
        expect(help).toContain('Plain/final transcripts');
        expect(help).not.toContain('[deterministic]');
    });

    it('requires a valid login provider and stores keys without echoing them', () => {
        const env = {
            OPENAI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined,
            GOOGLE_GENERATIVE_AI_API_KEY: undefined, GOOGLE_API_KEY: undefined, GEMINI_API_KEY: undefined,
            SPL_PROVIDER: undefined,
        };
        expect(run(['login'], env).code).toBe(2);
        expect(run(['login', 'unknown'], env).code).toBe(2);
        expect(run(['login', 'openai', '--provider', 'google'], env).code).toBe(2);
        const result = run(['login', 'openai'], env, 'private-openai-test-key\n');
        expect(result.code).toBe(0);
        expect(result.out).toContain('Default provider: openai');
        expect(result.out + result.err).not.toContain('private-openai-test-key');
        expect(JSON.parse(fs.readFileSync(path.join(dir, 'spl-home', 'credentials.json'), 'utf8'))).toEqual({
            provider: 'openai', keys: { openai: 'private-openai-test-key' },
        });
        expect(run(['login', 'google'], env, 'private-google-test-key\n').code).toBe(0);
        expect(run(['logout', 'openai'], env).code).toBe(0);
        expect(JSON.parse(fs.readFileSync(path.join(dir, 'spl-home', 'credentials.json'), 'utf8'))).toEqual({
            provider: 'google', keys: { google: 'private-google-test-key' },
        });
    });

    it('selects environment credentials without prompting and fails login cleanly on EOF', () => {
        const env = { OPENAI_API_KEY: 'environment-test-key' };
        const result = run(['login', '--provider', 'openai'], env);
        expect(result).toEqual({ code: 0, out: 'Configured openai using OPENAI_API_KEY. Default provider: openai.\n', err: '' });
        expect(fs.readFileSync(path.join(dir, 'spl-home', 'credentials.json'), 'utf8')).not.toContain(env.OPENAI_API_KEY);
        const eof = run(['login', 'anthropic'], { ANTHROPIC_API_KEY: undefined }, '');
        expect(eof.code).toBe(1);
        expect(eof.err).toContain('stdin ended');
    });

    it('validates --mcp without starting servers, including with --check', () => {
        const file = path.join(dir, 'mcp.json');
        fs.writeFileSync(file, JSON.stringify({ servers: { docs: { type: 'stdio', command: 'nonexistent-test-server' } } }));
        const r = spl(`success 42`, '--mcp', file, '--silent');
        expect(r).toEqual({ code: 0, out: '42\n', err: '' });
        expect(spl(`success 42`, '--mcp', file, '--check').code).toBe(0);
        fs.writeFileSync(file, '{"servers":{"docs":{"type":"http","url":42}}}');
        expect(spl(`success 42`, '--mcp', file, '--check')).toMatchObject({ code: 2, out: '' });
        expect(spl(`success 42`, '--mcp', path.join(dir, 'missing.json')).err).toContain('MCP config');
    });
});
