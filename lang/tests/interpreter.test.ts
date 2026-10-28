import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
    vi.unstubAllEnvs();
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
    it('reads environment strings and returns None for absent keys without exposing prototypes', async () => {
        vi.stubEnv('SPL_TEST_INPUT', 'a value');
        vi.stubEnv('SPL_TEST_EMPTY', '');
        for (const name of ['SPL_TEST_MISSING', 'toString', 'constructor', '__proto__']) vi.stubEnv(name, undefined);
        const { result } = await exec(`
let env = $env
def read():
    return env.SPL_TEST_INPUT
success [read(), $env['SPL_TEST_INPUT'], $env.SPL_TEST_EMPTY, env.SPL_TEST_MISSING,
    env['toString'], env.constructor, env.__proto__, type(env), '{env.SPL_TEST_INPUT}']
`);
        expect(value(result)).toEqual(['a value', 'a value', '', null, null, null, null, 'dict', 'a value']);
    });

    it('exposes only supplied script arguments with normal list operations and nullable bounds', async () => {
        const args = ['first', '', '--model=x'];
        const { result } = await exec(`
let args = $args
def read():
    return args[0]
success [read(), args[1], args[2], args[3], args[99], args[-1], args[-4],
    args[1:], len(args), type(args), list(enumerate(args)), '{$args[0]}']
`, { args });
        expect(value(result)).toEqual(['first', '', '--model=x', null, null, '--model=x', null,
            ['', '--model=x'], 3, 'list', [[0, 'first'], [1, ''], [2, '--model=x']], 'first']);
        expect(args).toEqual(['first', '', '--model=x']);
        expect(value((await exec(`success [$args, $args[0], $args[-1], len($args)]`)).result)).toEqual([[], null, null, 0]);
    });

    it.each([
        `$args['0']`, `$args[0.5]`, `$args[None]`, `$env[0]`,
        `[][0]`, `[1][1]`, `'x'[1]`, `{}.missing`, `{}['missing']`,
    ])('preserves index type validation and ordinary collection errors: %s', async (expr) => {
        expect(failure((await exec(`success ${expr}`)).result).status_code).toBe('runtime_error');
    });

    it.each([
        `$env.KEY = 'changed'`, `$env['KEY'] = 'changed'`, `$env.KEY += 'changed'`,
        `$env.pop('KEY')`, `$env.update({'KEY': 'changed'})`, `$env.clear()`,
        `$args[0] = 'changed'`, `$args[0] += 'changed'`, `$args.append('changed')`,
        `$args.extend(['changed'])`, `$args.insert(0, 'changed')`, `$args.pop()`,
        `$args.remove('first')`, `$args.reverse()`, `$args.sort()`, `$args.clear()`,
        `let alias = $env\nalias.KEY = 'changed'`, `let alias = $env\nalias.clear()`,
        `let alias = $args\nalias[0] = 'changed'`, `let alias = $args\nalias.append('changed')`,
        `def change(a):
    a.clear()
change($args)`,
        `let nested = {'env': $env}\nnested.env.update({})`,
    ])('rejects mutation of runtime inputs through all aliases: %s', async (source) => {
        const { result } = await exec(source, { args: ['first'] });
        expect(failure(result)).toMatchObject({ status_code: 'runtime_error', reason: 'cannot modify a read-only value' });
    });

    it('allows catchable read-only errors, read methods, and mutable copies', async () => {
        vi.stubEnv('SPL_TEST_INPUT', 'original');
        const { result } = await exec(`
let caught = None
try:
    $args.clear()
except err:
    caught = err.status_code
let args = $args.copy()
args.append('copy')
let env = $env.copy()
env.SPL_TEST_INPUT = 'copy'
let sliced = $args[:]
sliced[0] = 'slice'
success [caught, args, sliced, env.SPL_TEST_INPUT, $env.get('SPL_TEST_INPUT'),
    $args.count('first'), $args.index('first'), $args, $env.SPL_TEST_INPUT]
`, { args: ['first'] });
        expect(value(result)).toEqual(['runtime_error', ['first', 'copy'], ['slice'], 'copy', 'original', 1, 0, ['first'], 'original']);
        expect(process.env.SPL_TEST_INPUT).toBe('original');
    });

    it('does not automatically persist runtime inputs or let stores shadow them', async () => {
        vi.stubEnv('SPL_TEST_MISSING', undefined);
        const file = path.join(dir, 'inputs.json');
        fs.writeFileSync(file, JSON.stringify({ '$env': { fake: 'stored' }, '$args': ['stored'] }));
        const { result } = await exec(`let kept = $args[0]\nsuccess [$env.SPL_TEST_MISSING, $args]`, {
            args: ['current'], store: new JsonFileStore(file),
        });
        expect(value(result)).toEqual([null, ['current']]);
        expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ '$env': { fake: 'stored' }, '$args': ['stored'], kept: 'current' });
        const cleanFile = path.join(dir, 'clean.json');
        await exec(`assert $args[0] == None`, { store: new JsonFileStore(cleanFile) });
        expect(JSON.parse(fs.readFileSync(cleanFile, 'utf8'))).toEqual({});
    });

    it('copies host inputs once per run without freezing or changing the originals', async () => {
        vi.stubEnv('SPL_TEST_INPUT', 'initial');
        const args = ['initial'];
        const { result } = await exec(`success [$env.SPL_TEST_INPUT, $args[0]]`, {
            args,
            store: {
                load() {
                    vi.stubEnv('SPL_TEST_INPUT', 'changed');
                    args[0] = 'changed';
                    return {};
                },
                save() {},
            },
        });
        expect(value(result)).toEqual(['initial', 'initial']);
        expect(value((await exec(`success [$env.SPL_TEST_INPUT, $args[0]]`, { args })).result)).toEqual(['changed', 'changed']);
        expect(Object.isFrozen(args)).toBe(false);
    });

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

    it('preserves value-producing suites inside interpolation at any enclosing indentation', async () => {
        const { result } = await exec(`if True:
    let text = '''Answer: {if False:
        1
    else:
        let n = 2
        n + 1
    }'''
    success text`);
        expect(value(result)).toBe('Answer: 3');
        expect(value((await exec(`success '''{:
    let n = 4
    n * 2
}'''`)).result)).toBe('8');
    });

    it('runs functions, recursion, loops and closures', async () => {
        const { result } = await exec(`
def fact(n):
    if n <= 1:
        return 1
    return n * fact(n - 1)
def counter():
    let cell = [0]
    def add(x):
        cell[0] += x
        return cell[0]
    add(1)
    return add(2)
let acc = []
for i in range(10):
    if i % 2 == 0:
        continue
    if i > 7:
        break
    acc.append(i)
let n = 0
while n < 3:
    n += 1
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

    it('shadows bindings in nested blocks without changing their parents', async () => {
        const { result } = await exec(`
let color = 'Blue'
let seen = []
:
    let color = 'Red'
    seen.append(color)
    :
        let color = 'Green'
        seen.append(color)
    seen.append(color)
seen.append(color)
success seen
`);
        expect(value(result)).toEqual(['Red', 'Green', 'Red', 'Blue']);
    });

    it('rejects access to variables declared in a child scope', async () => {
        const { result } = await exec(`:
    let inner = 1
success inner`);
        expect(failure(result)).toMatchObject({ status_code: 'runtime_error', reason: "name 'inner' is not defined", line: 3 });
    });

    it('lets function parameters and locals shadow outer variables', async () => {
        const { result } = await exec(`
let x = 'outer'
def f(x):
    let y = x + '!'
    return y
success [f('inner'), x]
`);
        expect(value(result)).toEqual(['inner!', 'outer']);
    });

    it('updates enclosing declarations through multiple nested scopes', async () => {
        fs.mkdirSync(path.join(dir, 'out'));
        const { result } = await exec(`
let color = None
let n = 0
enforce 'be brief':
    forbid 'swearing':
        restrict './out':
            color = 'blue'
if True:
    n += 1
for i in range(2):
    n += 1
try:
    n += 10
except e:
    pass
success [color, n]
`);
        expect(value(result)).toEqual(['blue', 13]);
    });

    it('keeps outer assignments but discards child declarations after failure', async () => {
        const { result } = await exec(`
let r = 0
try:
    enforce 'x':
        r = 1
        let hidden = 2
        fail 'f'
except e:
    r += 5
success r
`);
        expect(value(result)).toBe(6);
    });

    it.each([
        `if True:
    let hidden = 1`,
        `for hidden in [1]:
    pass`,
        `while True:
    let hidden = 1
    break`,
        `try:
    let hidden = 1
except e:
    pass`,
        `try:
    fail 'x'
except hidden:
    pass`,
        `enforce 'x':
    let hidden = 1`,
        `forbid 'x':
    let hidden = 1`,
        `restrict '.':
    let hidden = 1`,
    ])('isolates block-local declarations: %s', async (source) => {
        expect(failure((await exec(`${source}\nsuccess hidden`)).result).reason).toBe("name 'hidden' is not defined");
    });

    it('creates fresh loop scopes and retains lexical closures', async () => {
        const { result } = await exec(`
let fns = []
let i = 'outer'
for i in [1, 2, 3]:
    def capture():
        return i
    fns.append(capture)
success [fns[0](), fns[1](), fns[2](), i]
`);
        expect(value(result)).toEqual([1, 2, 3, 'outer']);
    });

    it('searches the entire lexical chain for assignments without losing child scopes', async () => {
        const { result } = await exec(`
let x = 1
:
    let local = 3
    :
        x += 2
        assert local == 3
    assert local == 3
def update():
    x += 4
update()
success x
`);
        expect(value(result)).toBe(7);
    });

    it('returns final expressions from blocks and selected conditional branches', async () => {
        const { result } = await exec(`
let result = if False:
    fail 'unreachable'
elif True:
    let x = 3
    :
        let y = 4
        x + y
else:
    fail 'unreachable'
let other =:
    let result = 8
    if True:
        result + 1
    else:
        0
success [result, other, if False:
    0
else:
    10
]
`);
        expect(value(result)).toEqual([7, 9, 10]);
    });

    it('returns None for blocks ending in statements or unmatched conditionals', async () => {
        const { result } = await exec(`
let x =:
    1
    let y = 2
let y = if False:
    3
let z = if True:
    pass
success [x, y, z,:
    pass
,:
    5
    pass
]
`);
        expect(value(result)).toEqual([null, null, null, null, null]);
    });

    it('preserves dictionaries and supports multiline blocks within calls and lists', async () => {
        const { result } = await exec(`
success [
    len(:
        let value = [1, 2]
        value
    ),
    if True:
        let x = 2
        {'value': x}
    else:
        {}
    ,
    {},
    {'if': if False:
        1
    else:
        2
    },
]
`);
        expect(value(result)).toEqual([2, { value: 2 }, {}, { if: 2 }]);
    });

    it('propagates return, break, continue and success out of expression blocks', async () => {
        const { result } = await exec(`
def f():
    let unused =:
        if True:
            return 42
        0
    fail 'unreachable'
let out = []
for i in [1, 2, 3, 4]:
    let x = if i == 2:
        continue
    elif i == 4:
        break
    else:
        i
    out.append(x)
success [f(), out]
`);
        expect(value(result)).toEqual([42, [1, 3]]);
        expect(value((await exec(`let unused =:
    success 7
fail 'unreachable'`)).result)).toBe(7);
    });

    it('restores scopes after expression failures and persists only top-level bindings', async () => {
        const file = path.join(dir, 'store.json');
        const { result } = await exec(`
let x = 1
try:
    let bad =:
        let x = 2
        fail 'stop'
except e:
    assert x == 1
:
    let transient = 3
    x += 4
success x
`, { store: new JsonFileStore(file) });
        expect(value(result)).toBe(5);
        expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ x: 5 });
    });

    it('returns immediately from any scope', async () => {
        const { result } = await exec(`
def find(items):
    for x in items:
        :
            enforce 'irrelevant':
                try:
                    if x > 2:
                        return x
                except e:
                    pass
    return -1
success [find([1, 2, 3, 4]), find([1])]
`);
        expect(value(result)).toEqual([3, -1]);
    });

    it('lets return end the script from the top level, nested scopes included', async () => {
        const top = await exec(`let a = 1\nreturn a + 1\nfail 'unreachable'`);
        expect(top.result).toEqual({ status: 'success', value: 2, hasValue: true });
        const nested = await exec(`for i in range(5):
    :
        if i == 2:
            return i
fail 'unreachable'`);
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
for src in ['1 / 0', 'x']:
    pass
try:
    let a = 1 / 0
except e:
    out.append(e.status_code)
try:
    let a = [1][5]
except e:
    out.append(e.reason)
try:
    let a = 'a' + 1
except e:
    out.append(e.status_code)
success out
`);
        expect(value(result)).toEqual(['runtime_error', 'index 5 out of range', 'runtime_error']);
    });

    it('limits recursion depth', async () => {
        const { result } = await exec(`def f():
    return f()
f()`);
        expect(failure(result).reason).toMatch(/maximum call depth/);
    });
});

describe('failures', () => {
    it('produces the documented payload', async () => {
        const { result } = await exec(`let a = 1\n\nassert 1 == 2 'Abnormal'`);
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
try:
    fail 'boom'
except err:
    success err
`);
        expect(value(result)).toMatchObject({ status: 'failure', reason: 'boom', status_code: 'explicit_failure', line: 3 });
    });

    it('stops at the first failure and success stops immediately', async () => {
        const { result } = await exec(`success 1\nlet a = ask 'never'`); // NoLlm throws if the second line ever runs
        expect(value(result)).toBe(1);
        const r = await exec(`fail 'x'\nsuccess 1`);
        expect(r.result.status).toBe('failure');
    });

    it('fails inside functions with the innermost location', async () => {
        const { result } = await exec(`def f():
    fail 'deep'
f()`);
        expect(failure(result)).toMatchObject({ line: 2, command: "fail 'deep'" });
    });
});

describe('restrict enforcement', () => {
    it('blocks explicit tool calls outside the folder', async () => {
        fs.mkdirSync(path.join(dir, 'out'));
        fs.writeFileSync(path.join(dir, 'secret.txt'), 'secret');
        const bad = await exec(`restrict './out':
    let a = read_file('./secret.txt')`);
        expect(failure(bad.result)).toMatchObject({ status_code: 'restriction_violation', line: 2 });
    });

    it('cannot escape through .. and nested restrictions only narrow', async () => {
        fs.mkdirSync(path.join(dir, 'a', 'b'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'a', 'x.txt'), 'x');
        const dotdot = await exec(`restrict './a/b':
    let v = read_file('./a/b/../x.txt')`);
        expect(failure(dotdot.result).status_code).toBe('restriction_violation');
        const widen = await exec(`restrict './a/b':
    restrict './a':
        let v = read_file('./a/x.txt')`);
        expect(failure(widen.result).status_code).toBe('restriction_violation');
        const narrow = await exec(`restrict './a':
    restrict './a/b':
        let v = read_file('./a/x.txt')`);
        expect(failure(narrow.result).status_code).toBe('restriction_violation');
        const fine = await exec(`restrict './a':
    restrict './a/b':
        restrict './a':
            let v = 1`);
        expect(fine.result.status).toBe('success');
    });

    it('resolves symlinks/junctions before checking', async () => {
        fs.mkdirSync(path.join(dir, 'out'));
        fs.mkdirSync(path.join(dir, 'outside'));
        fs.writeFileSync(path.join(dir, 'outside', 'secret.txt'), 'secret');
        fs.symlinkSync(path.join(dir, 'outside'), path.join(dir, 'out', 'link'), 'junction');
        const r = await exec(`restrict './out':
    let v = read_file('./out/link/secret.txt')`);
        expect(failure(r.result).status_code).toBe('restriction_violation');
    });

    it('follows dangling symlinks so writes cannot escape through them', async () => {
        fs.mkdirSync(path.join(dir, 'out'));
        fs.mkdirSync(path.join(dir, 'outside'));
        // a junction to an existing folder is followed; a file symlink needs privileges on Windows, so use a junction to a missing dir
        const missing = path.join(dir, 'outside', 'not-yet');
        fs.symlinkSync(missing, path.join(dir, 'out', 'dangling'), 'junction');
        const r = await exec(`restrict './out':
    let v = write_file('./out/dangling/x.txt', 'x')`);
        expect(failure(r.result).status_code).toBe('restriction_violation');
        expect(fs.existsSync(path.join(missing, 'x.txt'))).toBe(false);
    });

    it('blocks path-qualified executables inside restrict exec', async () => {
        const r = await exec(`restrict exec 'git':
    let v = shell('./evil/git status')`);
        expect(failure(r.result).reason).toMatch(/without a path/);
    });

    it('blocks network and exec for explicit tools', async () => {
        const net = await exec(`restrict net 'api.example.com':
    let v = web_fetch('https://evil.example.org/x')`);
        expect(failure(net.result).status_code).toBe('restriction_violation');
        const exe = await exec(`restrict exec 'npm,git':
    let v = shell('curl http://x')`);
        expect(failure(exe.result).status_code).toBe('restriction_violation');
        const chain = await exec(`restrict exec 'git':
    let v = shell('git status && curl x')`);
        expect(failure(chain.result).status_code).toBe('restriction_violation');
        expect(failure(chain.result).reason).toMatch(/executable 'curl' blocked/);
        const echoBackend = { async call(req: any) { return { text: req.prompt, effective: {} }; }, async close() {} };
        const allowedChain = await exec(`restrict exec 'node':
    let v = shell('node -e "process.stdout.write(String(4))" && node -e "process.stdout.write(String(2))"')
    success v`, { backend: echoBackend as any });
        expect(value(allowedChain.result)).toContain('42');
        const pipe = await exec(`restrict '.':
    let v = shell('node -e "process.stdout.write(String(7*6))"')
    success v`, { backend: echoBackend as any });
        expect(value(pipe.result)).toContain('42');
    });

    it('blocks web_search outside the allowed hosts', async () => {
        const r = await exec(`restrict net 'api.example.com':
    let v = web_search('spl')`);
        expect(failure(r.result).status_code).toBe('restriction_violation');
    });

    it('reports tool errors as tool_error and allows catching restriction violations', async () => {
        const missing = await exec(`let v = read_file('./nope.txt')`);
        expect(failure(missing.result).status_code).toBe('tool_error');
        const caught = await exec(`restrict './out':
    try:
        let v = read_file('./nope.txt')
    except e:
        success e.status_code`);
        expect(value(caught.result)).toBe('restriction_violation');
    });

    it('write_file refuses paths outside the folder', async () => {
        const bad = await exec(`restrict './out':
    let r = write_file('./evil.txt', 'x')`);
        expect(failure(bad.result).status_code).toBe('restriction_violation');
        expect(fs.existsSync(path.join(dir, 'evil.txt'))).toBe(false);
        const missingContent = await exec(`write_file('./evil.txt')`);
        expect(failure(missingContent.result).status_code).toBe('runtime_error');
    });

    it('rejects malformed restrict arguments', async () => {
        expect(failure((await exec(`restrict net '':
    pass`)).result).status_code).toBe('runtime_error');
        expect(failure((await exec(`restrict exec 5:
    pass`)).result).status_code).toBe('runtime_error');
    });
});

describe('variable store', () => {
    it('persists top-level variables to a JSON file and reloads them', async () => {
        const file = path.join(dir, 'store.json');
        await exec(`let counter = 1
let data = {'a': [1, 2]}
def f():
    return 1`, { store: new JsonFileStore(file) });
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
