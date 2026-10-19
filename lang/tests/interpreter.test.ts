import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { run, type RunResult } from '../src/interpreter.js';
import { Failure } from '../src/errors.js';
import { Logger } from '../src/logger.js';
import { parse } from '../src/parser.js';
import { JsonFileStore } from '../src/store.js';
import { NoLlm } from './helpers.js';

let dir: string;
beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'spl-')));
});
afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
});

/** Runs a script that must not need an LLM; tests that do are in live.test.ts. */
async function exec(src: string, extra: Partial<Parameters<typeof run>[1]> = {}) {
    const result = await run(parse(src), { backend: new NoLlm(), logger: new Logger('silent'), cwd: dir, ...extra });
    return { result };
}

const value = (r: RunResult) => {
    if (r.status !== 'success') throw new Error(`expected success, got ${JSON.stringify(r.failure)}`);
    return r.value;
};
const failure = (r: RunResult) => {
    if (r.status !== 'failure') throw new Error('expected failure');
    return r.failure;
};

describe('deterministic language', () => {
    it('evaluates arithmetic with Python semantics', async () => {
        const { result } = await exec(`success [7 / 2, 7 // 2, -7 // 2, -7 % 3, 2 ** 10, 2 ** 3 ** 2, -2 ** 2, 1 + 2 * 3, 'ab' * 2, [1] + [2]]`);
        expect(value(result)).toEqual([3.5, 3, -4, 2, 1024, 512, -4, 7, 'abab', [1, 2]]);
    });

    it('supports comparison chains, boolean operators and membership', async () => {
        const { result } = await exec(`success [1 < 2 < 3, 1 < 3 < 2, 0 or 'x', 1 and 2, not None, 'a' in 'cat', 3 not in [1,2], 'k' in {'k': 1}, [1,[2]] == [1,[2]]]`);
        expect(value(result)).toEqual([true, false, 'x', 2, true, true, true, true, true]);
    });

    it('interpolates variables as is in plain strings', async () => {
        const { result } = await exec(`
let name = 'World'
let d = {'a': [1, 2]}
success 'Hello {name}! {1 + 2} {d} {True} {None} {{braces}} \\{x\\}'
`);
        expect(value(result)).toBe('Hello World! 3 {"a":[1,2]} True None {braces} {x}');
    });

    it('runs functions, recursion, loops and closures', async () => {
        const { result } = await exec(`
def fact(n) {
    if n <= 1 { return 1 }
    return n * fact(n - 1)
}
def counter() {
    let cell = [0]
    def add(x) {
        cell[0] += x
        return cell[0]
    }
    add(1)
    return add(2)
}
let acc = []
for i in range(10) {
    if i % 2 == 0 { continue }
    if i > 7 { break }
    acc.append(i)
}
let n = 0
while n < 3 { n += 1 }
success {'fact': fact(5), 'counter': counter(), 'acc': acc, 'n': n}
`);
        expect(value(result)).toEqual({ fact: 120, counter: 3, acc: [1, 3, 5, 7], n: 3 });
    });

    it('supports indexing, slicing, member access and mutation', async () => {
        const { result } = await exec(`
let l = [10, 20, 30]
let d = {'a': {'b': 1}}
l[0] = 11
l[-1] += 1
d.a.b += 5
d['c'] = 'x'
success [l, d, l[1:], 'hello'[1:3], 'hello'[-1], d.a.b, len(d)]
`);
        expect(value(result)).toEqual([[11, 20, 31], { a: { b: 6 }, c: 'x' }, [20, 31], 'el', 'o', 6, 2]);
    });

    it('provides builtins and methods', async () => {
        const { result } = await exec(`
success [
    len('héllo'), int('42'), float('1.5'), str(3), sorted([3, 1, 2]), sum([1, 2, 3]), max(1, 5, 2), min([4, 2]),
    'a,b'.split(','), '-'.join(['x', 'y']), ' hi '.strip().upper(), 'abc'.replace('b', 'X'), keys({'k': 1}),
    {'a': 1}.get('zz', 9), json_parse(r'{"a": [1]}'), json_stringify({'a': [1]}), round(2.5), round(3.14159, 2),
    list(enumerate(['a'])), type([]), type(None),
]
`);
        expect(value(result)).toEqual([5, 42, 1.5, '3', [1, 2, 3], 6, 5, 2, ['a', 'b'], 'x-y', 'HI', 'aXc', ['k'], 9, { a: [1] }, '{"a":[1]}', 2, 3.14, [[0, 'a']], 'list', 'None']);
    });

    it('keeps __proto__ keys harmless', async () => {
        const { result } = await exec(`
let d = {}
d['__proto__'] = {'polluted': True}
let e = {}
success [e.get('polluted', 'clean'), len(d)]
`);
        expect(value(result)).toEqual(['clean', 1]);
    });

    it('reports undefined names', async () => {
        expect(failure((await exec(`success y`)).result).reason).toMatch(/not defined/);
        expect(failure((await exec(`z += 1`)).result).reason).toMatch(/declare a local/);
    });

    it('shares function-scoped bindings across nested grouping blocks', async () => {
        const { result } = await exec(`
let color = 'Blue'
let seen = []
{
    let color = 'Red'
    seen.append(color)
    {
        let color = 'Green'
        seen.append(color)
    }
    seen.append(color)
}
seen.append(color)
success seen
`);
        expect(value(result)).toEqual(['Red', 'Green', 'Green', 'Green']);
    });

    it('keeps variables declared in a grouping block visible', async () => {
        const { result } = await exec(`{ let inner = 1 }\nsuccess inner`);
        expect(value(result)).toBe(1);
    });

    it('lets function parameters and locals shadow outer variables', async () => {
        const { result } = await exec(`
let x = 'outer'
def f(x) {
    let y = x + '!'
    return y
}
success [f('inner'), x]
`);
        expect(value(result)).toEqual(['inner!', 'outer']);
    });

    it('updates the outer variable from instruct, avoid, restrict, if, loop and try bodies', async () => {
        fs.mkdirSync(path.join(dir, 'out'));
        const { result } = await exec(`
let color = None
let n = 0
instruct 'be brief' {
    avoid 'swearing' {
        restrict './out' {
            let color = 'blue'
        }
    }
}
if True { n += 1 }
for i in range(2) { n += 1 }
try { n += 10 } except e { pass }
success [color, n]
`);
        expect(value(result)).toEqual(['blue', 13]);
    });

    it('keeps variables set before a caught failure inside constraint blocks', async () => {
        const { result } = await exec(`
let r = 0
try {
    instruct 'x' {
        let r = 1
        fail 'f'
    }
} except e {
    r += 5
}
success r
`);
        expect(value(result)).toBe(6);
    });

    it('returns immediately from any scope', async () => {
        const { result } = await exec(`
def find(items) {
    for x in items {
        {
            instruct 'irrelevant' {
                try {
                    if x > 2 { return x }
                } except e { pass }
            }
        }
    }
    return -1
}
success [find([1, 2, 3, 4]), find([1])]
`);
        expect(value(result)).toEqual([3, -1]);
    });

    it('lets return end the script from the top level, nested scopes included', async () => {
        const top = await exec(`let a = 1\nreturn a + 1\nfail 'unreachable'`);
        expect(top.result).toEqual({ status: 'success', value: 2, hasValue: true });
        const nested = await exec(`for i in range(5) {\n    {\n        if i == 2 { return i }\n    }\n}\nfail 'unreachable'`);
        expect(nested.result).toEqual({ status: 'success', value: 2, hasValue: true });
        const bare = await exec(`return`);
        expect(bare.result).toEqual({ status: 'success', value: null, hasValue: false });
    });

    it('accepts assignment to declared locals and collection members', () => {
        expect(() => parse(`let x = 1\nx = 2\nx += 2`)).not.toThrow();
        expect(() => parse(`let d = {}\nd.k = 2\nd['k'] = 3`)).not.toThrow();
    });

    it('turns runtime errors into catchable failures', async () => {
        const { result } = await exec(`
let out = []
for src in ['1 / 0', 'x']  {
    pass
}
try { let a = 1 / 0 } except e { out.append(e.status_code) }
try { let a = [1][5] } except e { out.append(e.reason) }
try { let a = 'a' + 1 } except e { out.append(e.status_code) }
success out
`);
        expect(value(result)).toEqual(['runtime_error', 'index 5 out of range', 'runtime_error']);
    });

    it('limits recursion depth', async () => {
        const { result } = await exec(`def f() { return f() }\nf()`);
        expect(failure(result).reason).toMatch(/maximum call depth/);
    });
});

describe('failures', () => {
    it('produces the documented payload', async () => {
        const { result } = await exec(`let a = 1\n\n  assert 1 == 2 'Abnormal'`);
        expect(failure(result)).toEqual({
            status: 'failure',
            reason: 'Abnormal',
            command: "assert 1 == 2 'Abnormal'",
            line: 3,
            status_code: 'assertion_failed',
        });
    });

    it('supports fail, success and try/except binding', async () => {
        expect(failure((await exec(`fail 'Mysterious reason'`)).result)).toMatchObject({
            status_code: 'explicit_failure',
            reason: 'Mysterious reason',
            line: 1,
        });
        const { result } = await exec(`
try {
    fail 'boom'
} except err {
    success err
}
`);
        expect(value(result)).toMatchObject({ status: 'failure', reason: 'boom', status_code: 'explicit_failure', line: 3 });
    });

    it('stops at the first failure and success stops immediately', async () => {
        const { result } = await exec(`success 1\nlet a = ?'never'`); // NoLlm throws if the second line ever runs
        expect(value(result)).toBe(1);
        const r = await exec(`fail 'x'\nsuccess 1`);
        expect(r.result.status).toBe('failure');
    });

    it('fails inside functions with the innermost location', async () => {
        const { result } = await exec(`def f() {\n    fail 'deep'\n}\nf()`);
        expect(failure(result)).toMatchObject({ line: 2, command: "fail 'deep'" });
    });
});

describe('restrict enforcement', () => {
    it('blocks explicit tool calls outside the folder', async () => {
        fs.mkdirSync(path.join(dir, 'out'));
        fs.writeFileSync(path.join(dir, 'secret.txt'), 'secret');
        const bad = await exec(`restrict './out' { let a = read_file('./secret.txt') }`);
        expect(failure(bad.result)).toMatchObject({ status_code: 'restriction_violation', line: 1 });
    });

    it('cannot escape through .. and nested restrictions only narrow', async () => {
        fs.mkdirSync(path.join(dir, 'a', 'b'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'a', 'x.txt'), 'x');
        const dotdot = await exec(`restrict './a/b' { let v = read_file('./a/b/../x.txt') }`);
        expect(failure(dotdot.result).status_code).toBe('restriction_violation');
        const widen = await exec(`restrict './a/b' { restrict './a' { let v = read_file('./a/x.txt') } }`);
        expect(failure(widen.result).status_code).toBe('restriction_violation');
        const narrow = await exec(`restrict './a' { restrict './a/b' { let v = read_file('./a/x.txt') } }`);
        expect(failure(narrow.result).status_code).toBe('restriction_violation');
        const fine = await exec(`restrict './a' { restrict './a/b' { restrict './a' { let v = 1 } } }`);
        expect(fine.result.status).toBe('success');
    });

    it('resolves symlinks/junctions before checking', async () => {
        fs.mkdirSync(path.join(dir, 'out'));
        fs.mkdirSync(path.join(dir, 'outside'));
        fs.writeFileSync(path.join(dir, 'outside', 'secret.txt'), 'secret');
        fs.symlinkSync(path.join(dir, 'outside'), path.join(dir, 'out', 'link'), 'junction');
        const r = await exec(`restrict './out' { let v = read_file('./out/link/secret.txt') }`);
        expect(failure(r.result).status_code).toBe('restriction_violation');
    });

    it('follows dangling symlinks so writes cannot escape through them', async () => {
        fs.mkdirSync(path.join(dir, 'out'));
        fs.mkdirSync(path.join(dir, 'outside'));
        // a junction to an existing folder is followed; a file symlink needs privileges on Windows, so use a junction to a missing dir
        const missing = path.join(dir, 'outside', 'not-yet');
        fs.symlinkSync(missing, path.join(dir, 'out', 'dangling'), 'junction');
        const r = await exec(`restrict './out' { let v = write_file('./out/dangling/x.txt', 'x') }`);
        expect(failure(r.result).status_code).toBe('restriction_violation');
        expect(fs.existsSync(path.join(missing, 'x.txt'))).toBe(false);
    });

    it('blocks path-qualified executables inside restrict exec', async () => {
        const r = await exec(`restrict exec 'git' { let v = shell('./evil/git status') }`);
        expect(failure(r.result).reason).toMatch(/without a path/);
    });

    it('blocks network and exec for explicit tools', async () => {
        const net = await exec(`restrict net 'api.example.com' { let v = web_fetch('https://evil.example.org/x') }`);
        expect(failure(net.result).status_code).toBe('restriction_violation');
        const exe = await exec(`restrict exec 'npm,git' { let v = shell('curl http://x') }`);
        expect(failure(exe.result).status_code).toBe('restriction_violation');
        const chain = await exec(`restrict exec 'git' { let v = shell('git status && curl x') }`);
        expect(failure(chain.result).status_code).toBe('restriction_violation');
        expect(failure(chain.result).reason).toMatch(/executable 'curl' blocked/);
        const echoBackend = { async call(req: any) { return { text: req.prompt, effective: {} }; }, async close() {} };
        const allowedChain = await exec(`restrict exec 'node' { let v = shell('node -e "process.stdout.write(String(4))" && node -e "process.stdout.write(String(2))"')\nsuccess v }`, { backend: echoBackend as any });
        expect(value(allowedChain.result)).toContain('42');
        const pipe = await exec(`restrict '.' { let v = shell('node -e "process.stdout.write(String(7*6))"')\nsuccess v }`, { backend: echoBackend as any });
        expect(value(pipe.result)).toContain('42');
    });

    it('blocks web_search outside the allowed hosts', async () => {
        const r = await exec(`restrict net 'api.example.com' { let v = web_search('spl') }`);
        expect(failure(r.result).status_code).toBe('restriction_violation');
    });

    it('reports tool errors as tool_error and allows catching restriction violations', async () => {
        const missing = await exec(`let v = read_file('./nope.txt')`);
        expect(failure(missing.result).status_code).toBe('tool_error');
        const caught = await exec(`restrict './out' { try { let v = read_file('./nope.txt') } except e { success e.status_code } }`);
        expect(value(caught.result)).toBe('restriction_violation');
    });

    it('write_file refuses paths outside the folder', async () => {
        const bad = await exec(`restrict './out' { let r = write_file('./evil.txt', 'x') }`);
        expect(failure(bad.result).status_code).toBe('restriction_violation');
        expect(fs.existsSync(path.join(dir, 'evil.txt'))).toBe(false);
        const missingContent = await exec(`write_file('./evil.txt')`);
        expect(failure(missingContent.result).status_code).toBe('runtime_error');
    });

    it('rejects malformed restrict arguments', async () => {
        expect(failure((await exec(`restrict net '' { pass }`)).result).status_code).toBe('runtime_error');
        expect(failure((await exec(`restrict exec 5 { pass }`)).result).status_code).toBe('runtime_error');
    });
});

describe('variable store', () => {
    it('persists top-level variables to a JSON file and reloads them', async () => {
        const file = path.join(dir, 'store.json');
        await exec(`let counter = 1\nlet data = {'a': [1, 2]}\ndef f() { return 1 }`, { store: new JsonFileStore(file) });
        expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ counter: 1, data: { a: [1, 2] } });
        const second = await exec(`counter += 1\nsuccess counter`, { store: new JsonFileStore(file) });
        expect(value(second.result)).toBe(2);
        expect(JSON.parse(fs.readFileSync(file, 'utf8')).counter).toBe(2);
    });

    it('saves the store even when the script fails', async () => {
        const file = path.join(dir, 'store.json');
        await exec(`let x = 5\nfail 'no'`, { store: new JsonFileStore(file) });
        expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ x: 5 });
    });
});

it('Failure payload shape', () => {
    const f = new Failure('llm_error', 'r').locate(4, 'cmd');
    expect(f.payload()).toEqual({ status: 'failure', reason: 'r', command: 'cmd', line: 4, status_code: 'llm_error' });
});
