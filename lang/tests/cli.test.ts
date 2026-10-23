import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
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
    const file = path.join(dir, 's.spl');
    fs.writeFileSync(file, script);
    return run([file, ...args]);
}

function run(args: string[]) {
    const r = spawnSync(process.execPath, [CLI, ...args], {
        encoding: 'utf8',
        cwd: dir,
        env: { ...process.env, SPL_HOME: path.join(dir, 'spl-home') },
    });
    return { code: r.status, out: r.stdout, err: r.stderr };
}

describe('cli', () => {
    it('passes repeated --arg values in order before and after the script path', () => {
        const file = path.join(dir, 'args.spl');
        fs.writeFileSync(file, `success [$args, $args[0], $args[3]]`);
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

    it('--silent suppresses logs', () => {
        const r = spl(`log('hi')\nsuccess 1`, '--silent');
        expect(r.err).toBe('');
        expect(r.out).toBe('1\n');
    });

    it('--log-level error hides info logs', () => {
        const r = spl(`log('hi')\nsuccess 1`, '--log-level', 'error');
        expect(r.err).not.toContain('[info]');
        expect(r.err).toContain('[deterministic] line 2 (success): success 1');
    });

    it('prints the failure payload to stdout and exits non-zero', () => {
        const r = spl(`let a = 1\nfail 'nope'`, '--silent');
        expect(r.code).toBe(1);
        expect(JSON.parse(r.out)).toEqual({ status: 'failure', reason: 'nope', command: "fail 'nope'", line: 2, status_code: 'explicit_failure' });
    });

    it('reports syntax errors on stderr with exit code 2', () => {
        const r = spl(`let a = ask(unknown='huge') 'x'`);
        expect(r.code).toBe(2);
        expect(r.out).toBe('');
        expect(r.err).toMatch(/s\.spl:1:\d+: syntax error: unknown modifier/);
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
                request: JSON.stringify({ kind: 'ask', prompt: 'question', model: null, reasoningEffort: null, showReasoning: false }),
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
                    kind: 'agent', prompt: 'Think carefully about the problem before giving the final answer.\n\nAct',
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
