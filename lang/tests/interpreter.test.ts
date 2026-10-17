import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { run, type RunResult } from '../src/interpreter.js';
import { Failure } from '../src/errors.js';
import type { LlmRequest } from '../src/llm.js';
import { Logger } from '../src/logger.js';
import { MockBackend, type MockResponder } from '../src/mock.js';
import { parse } from '../src/parser.js';
import { JsonFileStore } from '../src/store.js';
import type { ToolName } from '../src/ast.js';

let dir: string;
beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'spl-')));
});
afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
});

async function exec(src: string, responder?: MockResponder, extra: Partial<Parameters<typeof run>[1]> = {}) {
    const backend = new MockBackend(responder);
    const result = await run(parse(src), { backend, logger: new Logger('silent'), cwd: dir, ...extra });
    return { result, backend };
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
    let total = 0
    def add(x) {
        total += x
        return total
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

    it('requires let for declarations and reports undefined names', async () => {
        const a = failure((await exec(`x = 1`)).result);
        expect(a.status_code).toBe('runtime_error');
        expect(a.reason).toMatch(/undeclared/);
        expect(failure((await exec(`success y`)).result).reason).toMatch(/not defined/);
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
        const { backend } = await exec(`success 1\nlet a = ?'never'`);
        expect(backend.calls).toHaveLength(0);
        const r = await exec(`fail 'x'\nsuccess 1`);
        expect(r.result.status).toBe('failure');
    });

    it('fails inside functions with the innermost location', async () => {
        const { result } = await exec(`def f() {\n    fail 'deep'\n}\nf()`);
        expect(failure(result)).toMatchObject({ line: 2, command: "fail 'deep'" });
    });
});

describe('LLM commands', () => {
    it('prepends length and format hints and returns text', async () => {
        const { result, backend } = await exec(`success ?{len='word'} 'Name a color'`, () => ' red \n');
        expect(value(result)).toBe('red');
        expect(backend.calls[0].prompt).toBe('Answer with a single word.\n\nName a color');
        expect(backend.calls[0].sampling).toEqual({ temperature: 0, seed: 0 });
    });

    it('parses fmt=object responses', async () => {
        const { result, backend } = await exec(
            `let r = ?{fmt='object'} 'joke'\nsuccess r.setup`,
            () => '```json\n{"setup": "S", "punchline": "P"}\n```',
        );
        expect(value(result)).toBe('S');
        expect(backend.calls[0].prompt).toContain('valid JSON');
    });

    it('raises invalid_format for non-JSON responses and allows catching it', async () => {
        const { result } = await exec(`let r = ?{fmt='object'} 'joke'`, () => 'not json');
        expect(failure(result).status_code).toBe('invalid_format');
        const caught = await exec(
            `try { let response = ?{fmt='object'} 'x' } except err { let response = {'setup': 'none', 'punchline': err.reason} }\nsuccess response.setup`,
            () => '"just a string"',
        );
        expect(value(caught.result)).toBe('none');
    });

    it('maps backend errors to llm_error', async () => {
        const { result } = await exec(`let a = ?'x'`, () => {
            throw new Error('network down');
        });
        expect(failure(result)).toMatchObject({ status_code: 'llm_error', reason: 'network down' });
    });

    it('interpolates variables into prompts', async () => {
        const { backend } = await exec(`let who = 'Ada'\nlet a = ?'Tell me about {who}'`);
        expect(backend.calls[0].prompt).toBe('Tell me about Ada');
    });

    it('tracks enforce/forbid scopes on a stack', async () => {
        const { backend } = await exec(`
enforce 'be polite' {
    forbid 'jokes' {
        let a = ?'one'
    }
    let b = ?'two'
}
let c = ?'three'
`);
        expect(backend.calls[0].prompt).toContain('You MUST: be polite');
        expect(backend.calls[0].prompt).toContain('You MUST NOT: jokes');
        expect(backend.calls[1].prompt).toContain('You MUST: be polite');
        expect(backend.calls[1].prompt).not.toContain('jokes');
        expect(backend.calls[2].prompt).toBe('three');
    });

    it('pops constraints after a caught failure', async () => {
        const { backend } = await exec(`
try { enforce 'x' { fail 'f' } } except e { pass }
let a = ?'after'
`);
        expect(backend.calls[0].prompt).toBe('after');
    });

    it('maps think levels and defaults', async () => {
        const { backend } = await exec(`
think{level='low', show=True} 'q1'
think 'q2'
`);
        expect(backend.calls[0]).toMatchObject({ kind: 'think', reasoningEffort: 'low', showReasoning: true });
        expect(backend.calls[1]).toMatchObject({ reasoningEffort: 'medium', showReasoning: false });
    });

    it('applies the model directive and CLI override', async () => {
        expect((await exec(`@{model='m1'}\nlet a = ?'x'`)).backend.calls[0].model).toBe('m1');
        expect((await exec(`@{model='m1'}\nlet a = ?'x'`, undefined, { model: 'm2' })).backend.calls[0].model).toBe('m2');
    });

    it('tells the LLM about active restrictions', async () => {
        const { backend } = await exec(`restrict './out' { let a = ?'x' }`);
        expect(backend.calls[0].prompt).toContain('File system: you may read and write only inside');
    });
});

describe('restrict enforcement', () => {
    it('blocks explicit tool calls outside the folder', async () => {
        fs.mkdirSync(path.join(dir, 'out'));
        fs.writeFileSync(path.join(dir, 'secret.txt'), 'secret');
        fs.writeFileSync(path.join(dir, 'out', 'ok.txt'), 'fine');
        const ok = await exec(`restrict './out' { success read_file{path='./out/ok.txt'} 'Return the file content' }`, (r) => r.prompt);
        expect(value(ok.result)).toContain('fine');
        const bad = await exec(`restrict './out' { let a = read_file{path='./secret.txt'} 'x' }`);
        expect(failure(bad.result)).toMatchObject({ status_code: 'restriction_violation', line: 1 });
        expect(bad.backend.calls).toHaveLength(0);
    });

    it('cannot escape through .. and nested restrictions only narrow', async () => {
        fs.mkdirSync(path.join(dir, 'a', 'b'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'a', 'x.txt'), 'x');
        const dotdot = await exec(`restrict './a/b' { let v = read_file{path='./a/b/../x.txt'} 'x' }`);
        expect(failure(dotdot.result).status_code).toBe('restriction_violation');
        const widen = await exec(`restrict './a/b' { restrict './a' { let v = read_file{path='./a/x.txt'} 'x' } }`);
        expect(failure(widen.result).status_code).toBe('restriction_violation');
        const narrow = await exec(`restrict './a' { restrict './a/b' { let v = read_file{path='./a/x.txt'} 'x' } }`);
        expect(failure(narrow.result).status_code).toBe('restriction_violation');
        const fine = await exec(`restrict './a' { restrict './a/b' { restrict './a' { let v = ?'x' } } }`);
        expect(fine.result.status).toBe('success');
    });

    it('resolves symlinks/junctions before checking', async () => {
        fs.mkdirSync(path.join(dir, 'out'));
        fs.mkdirSync(path.join(dir, 'outside'));
        fs.writeFileSync(path.join(dir, 'outside', 'secret.txt'), 'secret');
        fs.symlinkSync(path.join(dir, 'outside'), path.join(dir, 'out', 'link'), 'junction');
        const r = await exec(`restrict './out' { let v = read_file{path='./out/link/secret.txt'} 'x' }`);
        expect(failure(r.result).status_code).toBe('restriction_violation');
    });

    it('blocks network and exec for explicit tools', async () => {
        const net = await exec(`restrict net 'api.example.com' { let v = web_fetch{url='https://evil.example.org/x'} 'x' }`);
        expect(failure(net.result).status_code).toBe('restriction_violation');
        const exe = await exec(`restrict exec 'npm,git' { let v = shell{command='curl http://x'} 'x' }`);
        expect(failure(exe.result).status_code).toBe('restriction_violation');
        const chain = await exec(`restrict exec 'git' { let v = shell{command='git status && curl x'} 'x' }`);
        expect(failure(chain.result).reason).toMatch(/chaining/);
    });

    it('enforces restrictions on tool calls made by the LLM', async () => {
        fs.writeFileSync(path.join(dir, 'secret.txt'), 'secret');
        const responder: MockResponder = async (req: LlmRequest) => {
            return req.tools.invoke('read_file' as ToolName, { path: './secret.txt' });
        };
        const blocked = await exec(`restrict './out' { let v = ?'read the secret' }`, responder);
        expect(failure(blocked.result)).toMatchObject({ status_code: 'restriction_violation' });
        const allowed = await exec(`let v = ?'read the secret'\nsuccess v`, responder);
        expect(value(allowed.result)).toBe('secret');
    });

    it('reports tool errors as tool_error and allows catching restriction violations', async () => {
        const missing = await exec(`let v = read_file{path='./nope.txt'} 'x'`);
        expect(failure(missing.result).status_code).toBe('tool_error');
        const caught = await exec(`restrict './out' { try { let v = read_file{path='./nope.txt'} 'x' } except e { success e.status_code } }`);
        expect(value(caught.result)).toBe('restriction_violation');
    });

    it('write_file writes content inside the folder only', async () => {
        const ok = await exec(`restrict './out' { let r = write_file{path='./out/a/b.txt', content='hello {1+1}'} 'Confirm' }`);
        expect(ok.result.status).toBe('success');
        expect(fs.readFileSync(path.join(dir, 'out', 'a', 'b.txt'), 'utf8')).toBe('hello 2');
        const bad = await exec(`restrict './out' { let r = write_file{path='./evil.txt', content='x'} 'Confirm' }`);
        expect(failure(bad.result).status_code).toBe('restriction_violation');
        expect(fs.existsSync(path.join(dir, 'evil.txt'))).toBe(false);
    });

    it('rejects malformed restrict arguments', async () => {
        expect(failure((await exec(`restrict net '' { pass }`)).result).status_code).toBe('runtime_error');
        expect(failure((await exec(`restrict exec 5 { pass }`)).result).status_code).toBe('runtime_error');
    });
});

describe('explicit tool calls', () => {
    it('feeds tool output and instructions to the LLM', async () => {
        fs.writeFileSync(path.join(dir, 'f.txt'), 'file body');
        const { result, backend } = await exec(`success read_file{path='f.txt'} 'Summarize'`, () => 'summary');
        expect(value(result)).toBe('summary');
        expect(backend.calls[0].kind).toBe('tool');
        expect(backend.calls[0].prompt).toContain('file body');
        expect(backend.calls[0].prompt).toContain('Instructions: Summarize');
    });

    it('lets the LLM supply write_file content with a pinned path', async () => {
        const { backend } = await exec(`let r = write_file{path='out.txt'} 'Write a haiku'`);
        expect(backend.calls[0].pinned).toEqual({ tool: 'write_file', params: { path: 'out.txt' } });
    });

    it('runs shell commands', async () => {
        const { result } = await exec(`success shell{command='node -e "console.log(6*7)"'} 'x'`, (r) => r.prompt);
        expect(value(result)).toContain('42');
    });
});

describe('variable store', () => {
    it('persists top-level variables to a JSON file and reloads them', async () => {
        const file = path.join(dir, 'store.json');
        await exec(`let counter = 1\nlet data = {'a': [1, 2]}\ndef f() { return 1 }`, undefined, { store: new JsonFileStore(file) });
        expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ counter: 1, data: { a: [1, 2] } });
        const second = await exec(`counter += 1\nsuccess counter`, undefined, { store: new JsonFileStore(file) });
        expect(value(second.result)).toBe(2);
        expect(JSON.parse(fs.readFileSync(file, 'utf8')).counter).toBe(2);
    });

    it('saves the store even when the script fails', async () => {
        const file = path.join(dir, 'store.json');
        await exec(`let x = 5\nfail 'no'`, undefined, { store: new JsonFileStore(file) });
        expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ x: 5 });
    });
});

it('Failure payload shape', () => {
    const f = new Failure('llm_error', 'r').locate(4, 'cmd');
    expect(f.payload()).toEqual({ status: 'failure', reason: 'r', command: 'cmd', line: 4, status_code: 'llm_error' });
});
