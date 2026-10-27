import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
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

function run(args: string[], env: NodeJS.ProcessEnv = {}) {
    const r = spawnSync(process.execPath, [CLI, ...args], {
        encoding: 'utf8',
        cwd: dir,
        env: { ...process.env, ...env, SPL_HOME: path.join(dir, 'spl-home') },
    });
    return { code: r.status, out: r.stdout, err: r.stderr };
}

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

    it('preflights human expressions but accepts --check without creating a checkpoint', () => {
        const state = path.join(dir, 'check.jsonl');
        const script = `write_file('bad.txt', 'x')\nif False { human 'later' }\nsuccess 1`;
        expect(spl(script, '--silent').code).toBe(2);
        expect(fs.existsSync(path.join(dir, 'bad.txt'))).toBe(false);
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
        const r = spl(`let a = 41\n{\n    return a + 1\n}\nfail 'unreachable'`, '--silent');
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
        expect(plain.err).toContain('[info] log: review:\n[info]   {\n[info]     "findings": [');
        expect(plain.err.trimEnd().split('\n').every(line => /^\[(info|deterministic)\] /.test(line))).toBe(true);
        expect(run([file, '--silent'], { FORCE_COLOR: '1', NO_COLOR: undefined }).err).toBe('');
    });

    it('uses the same log format for CLI usage and syntax diagnostics', () => {
        const usage = run(['--unknown-option'], { NO_COLOR: '1', FORCE_COLOR: undefined });
        expect(usage.code).toBe(2);
        expect(usage.out).toBe('');
        expect(usage.err.trimEnd().split('\n').every(line => line.startsWith('[error] '))).toBe(true);
        const syntax = spl('let value =');
        expect(syntax.code).toBe(2);
        expect(syntax.err).toContain('[error] ');
    });

    it('--silent suppresses logs', () => {
        const r = spl(`log('hi')\nsuccess 1`, '--silent');
        expect(r.err).toBe('');
        expect(r.out).toBe('1\n');
    });

    it('--log-level error hides info logs', () => {
        const r = spl(`log('hi')\nsuccess 1`, '--log-level', 'error');
        expect(r.err).not.toContain('[info]');
        expect(r.err).toContain('[deterministic] line 8 (success): success 1');
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

    it('replays generation offline and blocks external actions', () => {
        const file = path.join(dir, 'responses.jsonl');
        fs.writeFileSync(file, [
            JSON.stringify({ format: 'spl-generation', version: 1 }),
            JSON.stringify({
                request: JSON.stringify({ kind: 'ask', prompt: `${RUNTIME_PREAMBLE}\n\nquestion`, model: null, reasoningEffort: null, showReasoning: false }),
                response: { text: 'offline answer', effective: { model: 'test' } },
            }),
            '',
        ].join('\n'));
        expect(spl(`success ask 'question'`, '--replay', file, '--silent')).toEqual({ code: 0, out: 'offline answer\n', err: '' });
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
                    model: null, reasoningEffort: 'medium', showReasoning: false,
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
