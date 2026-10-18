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
        expect(spl(`log('hi')\nsuccess 1`, '--log-level', 'error').err).toBe('');
    });

    it('prints the failure payload to stdout and exits non-zero', () => {
        const r = spl(`let a = 1\nfail 'nope'`, '--silent');
        expect(r.code).toBe(1);
        expect(JSON.parse(r.out)).toEqual({ status: 'failure', reason: 'nope', command: "fail 'nope'", line: 2, status_code: 'explicit_failure' });
    });

    it('reports syntax errors on stderr with exit code 2', () => {
        const r = spl(`let a = ?{len='huge'} 'x'`);
        expect(r.code).toBe(2);
        expect(r.out).toBe('');
        expect(r.err).toMatch(/s\.spl:1:\d+: syntax error: invalid value 'huge'/);
    });

    it('--check only parses', () => {
        expect(spl(`fail 'x'`, '--check').code).toBe(0);
        expect(spl(`fail`, '--check').code).toBe(2);
    });

    it('persists variables with --store', () => {
        const store = path.join(dir, 'vars.json');
        spl(`let n = 41`, '--store', store);
        expect(spl(`let n += 1\nsuccess n`, '--store', store).out).toBe('42\n');
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
    });
});
