import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RUNTIME_PREAMBLE } from '../src/preamble.js';

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

describe('noninteractive checkpoint CLI', () => {
    it.each(['file', 'checkpoint'] as const)('pauses, inspects, answers and completes with --resume %s', (syntax) => {
        const state = path.join(dir, 'run.jsonl');
        const resume = syntax === 'file' ? ['--resume', state] : ['--resume', '--checkpoint', state];
        const script = `write_file('output.txt', 'original')\nlet a = human 'First question'\nlet b = human 'Second question'\nsuccess [a, b, $args]`;
        const first = spl(script, '--checkpoint', state, '--arg=initial', '--silent');
        expect(first.code).toBe(3);
        expect(first.err).toBe('');
        const pending = JSON.parse(first.out);
        expect(pending).toMatchObject({ status: 'waiting_for_input', question: 'First question', line: 8, checkpoint: state });
        const before = fs.readFileSync(state, 'utf8');
        expect(spl(script, ...resume, '--silent')).toEqual(first);
        expect(fs.readFileSync(state, 'utf8')).toBe(before);
        fs.writeFileSync(path.join(dir, 'output.txt'), 'not overwritten');
        const stale = spl(script, ...resume, '--answer-for', pending.run_id, '--answer=yes', '--silent');
        expect(stale.code).toBe(2);
        expect(stale.out).toBe('');
        expect(stale.err).toContain('use request_id from the latest waiting_for_input response, not run_id');
        expect(fs.readFileSync(state, 'utf8')).toBe(before);
        expect(spl(script, '--checkpoint', state, '--silent').code).toBe(2);
        expect(fs.readFileSync(state, 'utf8')).toBe(before);
        const second = spl(script, ...resume, '--answer-for', pending.request_id, '--answer=', '--silent');
        expect(second.code).toBe(3);
        const next = JSON.parse(second.out);
        expect(next.request_id).not.toBe(pending.request_id);
        expect(next.run_id).toBe(pending.run_id);
        expect(next.checkpoint).toBe(state);
        expect(next.question).toBe('Second question');
        const afterSecond = fs.readFileSync(state, 'utf8');
        expect(afterSecond.startsWith(before)).toBe(true);
        expect(spl(script, ...resume, '--silent')).toEqual(second);
        expect(spl(script, ...resume, '--answer-for', pending.request_id, '--answer=yes').code).toBe(2);
        expect(fs.readFileSync(state, 'utf8')).toBe(afterSecond);
        const answer = '  "quoted"\nmultiline\n';
        const answerFile = path.join(dir, 'answer.txt');
        fs.writeFileSync(answerFile, answer);
        const done = spl(script, ...resume, '--answer-for', next.request_id, '--answer-file', answerFile, '--silent');
        expect(done.code).toBe(0);
        expect(JSON.parse(done.out)).toEqual({
            status: 'success', run_id: pending.run_id, has_value: true, value: ['', answer, ['initial']],
        });
        expect(fs.readFileSync(path.join(dir, 'output.txt'), 'utf8')).toBe('not overwritten');
        expect(fs.readFileSync(state, 'utf8').startsWith(afterSecond)).toBe(true);
        expect(spl(script, ...resume, '--silent').code).toBe(2);
        expect(fs.existsSync(`${state}.lock`)).toBe(false);
    });

    it.each([
        ['--resume={state}'],
        ['--resume', '{state}'],
        ['--checkpoint={state}', '--resume'],
        ['--resume', '--checkpoint={state}'],
    ])('supports inline paths and either flag order: %j', (...options) => {
        const state = path.join(dir, 'state with spaces.jsonl');
        const script = `success human 'question'`;
        const first = spl(script, '--checkpoint', state, '--silent');
        const resume = options.map((option) => option.replace('{state}', state));
        expect(spl(script, ...resume, '--silent')).toEqual(first);
        const done = run([...resume, path.join(dir, 's.md'), '--answer-for', JSON.parse(first.out).request_id, '--answer=--resume', '--silent']);
        expect(done.code).toBe(0);
        expect(JSON.parse(done.out).value).toBe('--resume');
    });

    it('does not interpret --resume after the option terminator as an option', () => {
        fs.writeFileSync(path.join(dir, '--resume.md'), markdown('success 7'));
        expect(run(['--silent', '--', '--resume.md'])).toEqual({ code: 0, out: '7\n', err: '' });
    });

    it('allows unused human expressions and accepts --check without creating a checkpoint', () => {
        const state = path.join(dir, 'check.jsonl');
        const script = `write_file('bad.txt', 'x')
if False:
    human 'later'
success 1`;
        expect(spl(script, '--silent')).toEqual({ code: 0, out: '1\n', err: '' });
        expect(fs.readFileSync(path.join(dir, 'bad.txt'), 'utf8')).toBe('x');
        expect(spl(script, '--check', '--checkpoint', state)).toEqual({ code: 0, out: '', err: '' });
        expect(fs.existsSync(state)).toBe(false);
        expect(fs.existsSync(`${state}.lock`)).toBe(false);
    });

    it('returns terminal JSON failure/no-value envelopes and never treats waiting as failure', () => {
        const state = path.join(dir, 'failure.jsonl');
        const result = spl(`fail 'rejected'`, '--checkpoint', state, '--silent');
        expect(result.code).toBe(1);
        expect(JSON.parse(result.out)).toMatchObject({ status: 'failure', failure: { status_code: 'explicit_failure', reason: 'rejected' } });
        const empty = spl(`pass`, '--checkpoint', path.join(dir, 'empty.jsonl'), '--silent');
        expect(empty.code).toBe(0);
        expect(JSON.parse(empty.out)).toMatchObject({ status: 'success', has_value: false, value: null });
    });

    it.each([
        ['--answer=yes'],
        ['--answer-for=id'],
        ['--checkpoint=a', '--resume=b'],
        ['--resume'],
        ['--resume', '--silent'],
        ['--resume', '--checkpoint='],
        ['--resume', '--checkpoint=a', '--resume=b'],
        ['--resume', '--checkpoint=a', '--answer=yes'],
        ['--resume', '--checkpoint=a', '--answer-for=id'],
        ['--resume', '--checkpoint=a', '--trace=b'],
        ['--resume', '--checkpoint=a', '--store=b'],
        ['--resume=a', '--answer=yes'],
        ['--resume=a', '--answer-for=id'],
        ['--resume=a', '--answer-for=id', '--answer=yes', '--answer-file=answer.txt'],
        ['--checkpoint=a', '--trace=b'],
        ['--checkpoint=a', '--record=b'],
        ['--checkpoint=a', '--replay=b'],
        ['--checkpoint=a', '--store=b'],
        ['--checkpoint=a', '--store-module=b'],
        ['--checkpoint='],
        ['--human'],
        ['--checkpoint=a', '--human=yes'],
        ['--resume=a', '--human=yes'],
    ])('rejects incompatible/invalid options: %j', (...options) => {
        const result = spl(`success 1`, ...options);
        expect(result.code).toBe(2);
        expect(result.out).toBe('');
        expect(fs.existsSync(path.join(dir, 'a'))).toBe(false);
    });

    it.each(['file', 'checkpoint'] as const)('rejects changed scripts and arguments with --resume %s', (syntax) => {
        const state = path.join(dir, 'run.jsonl');
        const resume = syntax === 'file' ? ['--resume', state] : ['--resume', '--checkpoint', state];
        const first = spl(`success human 'question'`, '--checkpoint', state, '--arg=one', '--silent');
        const id = JSON.parse(first.out).request_id;
        const original = fs.readFileSync(state, 'utf8');
        expect(spl(`success human 'changed'`, ...resume, '--answer-for', id, '--answer=yes', '--silent').code).toBe(2);
        expect(spl(`success human 'question'`, ...resume, '--arg=two', '--answer-for', id, '--answer=yes', '--silent').code).toBe(2);
        expect(fs.readFileSync(state, 'utf8')).toBe(original);
    });

    it('does not create a missing journal when resuming with --checkpoint', () => {
        const state = path.join(dir, 'missing.jsonl');
        const result = spl(`success human 'question'`, '--resume', '--checkpoint', state, '--silent');
        expect(result.code).toBe(2);
        expect(result.out).toBe('');
        expect(result.err).toContain('cannot resume checkpoint');
        expect(fs.existsSync(state)).toBe(false);
        expect(fs.existsSync(`${state}.lock`)).toBe(false);
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
        const result = spl(source);
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
        const journal = path.join(dir, 'excluded.jsonl');
        const preloadUrl = pathToFileURL(preload).href;
        const invoke = (args: string[]) => spawnSync(process.execPath, ['--import', preloadUrl, CLI, ...args], {
            encoding: 'utf8', env: { ...process.env, TERM: 'xterm', NO_COLOR: '1', SPL_HOME: path.join(dir, 'spl-home') },
        });
        for (const [args, code] of [
            [['--help'], 0], [['--version'], 0], [['logout'], 0], [[file, '--check'], 0],
            [[file, '--checkpoint', journal], 3], [[file, '--resume', journal], 3],
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

    it('retains failed model requests only, and reports backend-close errors before printing failure results', () => {
        const file = path.join(dir, 'failed-trace.jsonl');
        fs.writeFileSync(file, [
            JSON.stringify({ format: 'spl-trace', version: 1 }),
            JSON.stringify({ request: {
                kind: 'agent', prompt: `${RUNTIME_PREAMBLE}\n\nThink carefully about the problem before giving the final answer.\n\nAct`,
                model: null, reasoningEffort: 'medium', showReasoning: true,
            }, error: { status_code: 'llm_error', reason: 'backend unavailable' } }), '',
        ].join('\n'));
        const failed = spl("success agent 'Act'", '--replay', file);
        expect(failed.code).toBe(1);
        expect(JSON.parse(failed.out)).toMatchObject({ status_code: 'llm_error', reason: 'backend unavailable' });
        expect(failed.err.match(/-> input agent/g)).toHaveLength(1);
        expect(failed.err).not.toContain('<- output');
        const unused = spl("log('before close')\nsuccess 'unused'", '--replay', file);
        expect(unused.code).toBe(1);
        expect(JSON.parse(unused.out).reason).toContain('unused');
        expect(unused.err.indexOf('[info] log: before close')).toBeLessThan(unused.err.indexOf('x error'));
        expect(unused.out).not.toContain('\u001b');
    });

    it('cleans up an unexpected runtime exception before returning exit 70', () => {
        const mod = path.join(dir, 'unexpected-store.mjs');
        fs.writeFileSync(mod, "export function createStore() { return { load() { throw new Error('unexpected load failure'); }, save() {} }; }");
        const result = spl('success 1', '--store-module', mod);
        expect(result).toMatchObject({ code: 70, out: '' });
        expect(result.err).toContain('x error spl: internal error: Error: unexpected load failure');
        expect(result.err).not.toContain('Enter/Space');
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
        expect(JSON.parse(spl(`success {'a': [1, None, True]}`).out)).toEqual({ a: [1, null, true] });
    });

    it('pretty-prints and colors JSON logs on stderr without changing stdout', () => {
        const file = path.join(dir, 'pretty.md');
        fs.writeFileSync(file, markdown("let review = {'findings': [{'severity': 'high', 'line': 12}]}\nlog('review:', review)\nsuccess review"));
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

    it.each([true, false])('replays generation offline and blocks external actions with showReasoning: %s', showReasoning => {
        const file = path.join(dir, 'responses.jsonl');
        fs.writeFileSync(file, [
            JSON.stringify({ format: 'spl-generation', version: 1 }),
            JSON.stringify({
                request: JSON.stringify({ kind: 'ask', prompt: `${RUNTIME_PREAMBLE}\n\nquestion`, model: null, reasoningEffort: null, showReasoning }),
                response: { text: 'offline answer', effective: { model: 'test' } },
            }),
            '',
        ].join('\n'));
        expect(spl(`success ask${showReasoning ? '' : '(hide=True)'} 'question'`, '--replay', file, '--silent')).toEqual({ code: 0, out: 'offline answer\n', err: '' });
        if (!showReasoning) {
            const mismatch = spl(`success ask 'question'`, '--replay', file, '--silent');
            expect(mismatch.code).toBe(1);
            expect(JSON.parse(mismatch.out).reason).toContain('mismatch');
        }
        expect(spl(`success ask 'changed'`, '--replay', file, '--silent').code).not.toBe(0);
        const empty = path.join(dir, 'empty.jsonl');
        fs.writeFileSync(empty, '{"format":"spl-generation","version":1}\n');
        const inputs = spl(`success [$env.SPL_HOME, $args[0], $args[1]]`, '--arg=current', '--replay', empty, '--silent');
        expect(inputs.code).toBe(0);
        expect(JSON.parse(inputs.out)).toEqual([path.join(dir, 'spl-home'), 'current', null]);
        expect(inputs.err).toBe('');
        const denied = spl(`write_file('blocked.txt', 'x')`, '--replay', empty, '--silent');
        expect(denied.code).toBe(1);
        expect(JSON.parse(denied.out).status_code).toBe('restriction_violation');
        expect(fs.existsSync(path.join(dir, 'blocked.txt'))).toBe(false);
        expect(spl(`success 1`, '--record', file, '--silent').code).toBe(2);
        expect(spl(`success 1`, '--record', file, '--replay', file).code).toBe(2);
        expect(spl(`success 1`, '--replay', file, '--store', path.join(dir, 'vars.json')).code).toBe(2);
    });

    it('persists variables with --store', () => {
        const store = path.join(dir, 'vars.json');
        spl(`let n = 41`, '--store', store);
        expect(spl(`n += 1\nsuccess n`, '--store', store).out).toBe('42\n');
    });

    it('--trace creates a new trace even with --silent, and --check does not create one', () => {
        const file = path.join(dir, 'trace.jsonl');
        expect(spl(`success 1`, '--trace', file, '--check')).toEqual({ code: 0, out: '', err: '' });
        expect(fs.existsSync(file)).toBe(false);
        expect(spl(`success 1`, '--trace', file, '--silent')).toEqual({ code: 0, out: '1\n', err: '' });
        expect(fs.readFileSync(file, 'utf8')).toBe('{"format":"spl-trace","version":1}\n');
        expect(spl(`success 1`, '--trace', file, '--silent').code).toBe(2);
        expect(fs.readFileSync(file, 'utf8')).toBe('{"format":"spl-trace","version":1}\n');
        for (const flags of [
            ['--trace', file, '--record', file],
            ['--trace', file, '--replay', file],
            ['--trace='],
            ['--trace'],
        ]) {
            expect(spl(`success 1`, ...flags).code).toBe(2);
        }
    });

    it('replays agent traces without Copilot or MCP, but runs explicit writes and JSON stores', () => {
        const file = path.join(dir, 'trace.jsonl');
        const store = path.join(dir, 'vars.json');
        const mcp = path.join(dir, 'mcp.json');
        const marker = path.join(dir, 'mcp-started.txt');
        fs.writeFileSync(mcp, JSON.stringify({ servers: {
            offline: { command: process.execPath, args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started')`] },
        } }));
        fs.writeFileSync(file, [
            JSON.stringify({ format: 'spl-trace', version: 1 }),
            JSON.stringify({
                request: {
                    kind: 'agent', prompt: `${RUNTIME_PREAMBLE}\n\nThink carefully about the problem before giving the final answer.\n\nAct`,
                    model: null, reasoningEffort: 'medium', showReasoning: true,
                },
                response: { text: 'offline agent', effective: { model: 'test' } },
            }),
            '',
        ].join('\n'));
        const result = spl(`let answer = agent 'Act'\nwrite_file('output.txt', answer)\nsuccess answer`,
            '--replay', file, '--store', store, '--mcp', mcp, '--silent');
        expect(result).toEqual({ code: 0, out: 'offline agent\n', err: '' });
        expect(fs.readFileSync(path.join(dir, 'output.txt'), 'utf8')).toBe('offline agent');
        expect(JSON.parse(fs.readFileSync(store, 'utf8'))).toEqual({ answer: 'offline agent' });
        expect(fs.existsSync(marker)).toBe(false);
        const unused = spl(`success 'not replayed'`, '--replay', file, '--silent');
        expect(unused.code).toBe(1);
        expect(JSON.parse(unused.out)).toMatchObject({ status_code: 'llm_error', reason: expect.stringContaining('unused') });
    });

    it('allows custom store modules for workflow traces but rejects them before import for legacy recordings', () => {
        const file = path.join(dir, 'trace.jsonl');
        const legacy = path.join(dir, 'legacy.jsonl');
        const mod = path.join(dir, 'store.mjs');
        const marker = path.join(dir, 'imported.txt');
        const saved = path.join(dir, 'saved.json');
        fs.writeFileSync(file, '{"format":"spl-trace","version":1}\n');
        fs.writeFileSync(legacy, '{"format":"spl-generation","version":1}\n');
        fs.writeFileSync(mod, `import fs from 'node:fs';
fs.writeFileSync(${JSON.stringify(marker)}, 'imported');
export function createStore() {
    return { load: () => ({ base: 7 }), save: (vars) => fs.writeFileSync(${JSON.stringify(saved)}, JSON.stringify(vars)) };
}`);
        expect(spl(`success 1`, '--replay', legacy, '--store-module', mod, '--silent').code).toBe(2);
        expect(fs.existsSync(marker)).toBe(false);
        expect(spl(`let answer = base * 6\nsuccess answer`, '--replay', file, '--store-module', mod, '--silent'))
            .toEqual({ code: 0, out: '42\n', err: '' });
        expect(JSON.parse(fs.readFileSync(saved, 'utf8'))).toEqual({ base: 7, answer: 42 });
    });

    it('supports a pluggable store module', () => {
        const mod = path.join(dir, 'store.mjs');
        fs.writeFileSync(
            mod,
            `import fs from 'node:fs';\nexport function createStore() { return { load: () => ({ base: 7 }), save: (v) => fs.writeFileSync(${JSON.stringify(path.join(dir, 'saved.json'))}, JSON.stringify(v)) }; }`,
        );
        expect(spl(`let r = base * 6\nsuccess r`, '--store-module', mod).out).toBe('42\n');
        expect(JSON.parse(fs.readFileSync(path.join(dir, 'saved.json'), 'utf8'))).toEqual({ base: 7, r: 42 });
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
