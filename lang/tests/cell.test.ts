import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { compileCell } from '../src/cell.js';
import { SplSyntaxError } from '../src/errors.js';
import { parse } from '../src/markdown.js';
import { ExecutionSession } from '../src/workflow.js';
import { NoLlm, cleanTemp, exec, silent, tempDir } from './helpers.js';

afterEach(cleanTemp);
const options = { backend: new NoLlm(), logger: silent };
const value = async (code: string, extra = {}) => {
    const result = await exec(code, extra);
    if (result.status === 'failure') throw new Error(`${result.failure.status_code}: ${result.failure.reason} (line ${result.failure.line})`);
    return result.value;
};

describe('fence compilation', () => {
    it('reports declarations with document positions', () => {
        const cell = compileCell('const a = 1, { b, c: [d] } = x;\nlet e;\nfunction f() {}\nclass G {}\nimport h, { i as j } from "./m.js";', { line: 10 });
        expect(cell.declarations.map(item => [item.name, item.kind, item.line])).toEqual([
            ['a', 'const', 10], ['b', 'const', 10], ['d', 'const', 10], ['e', 'let', 11],
            ['f', 'function', 12], ['G', 'class', 13], ['h', 'import', 14], ['j', 'import', 14],
        ]);
        expect(cell.imports).toEqual([{ specifier: './m.js', line: 14, column: 1 }]);
        expect(cell.statements).toEqual(['VariableDeclaration', 'VariableDeclaration', 'FunctionDeclaration', 'ClassDeclaration', 'ImportDeclaration']);
    });

    it('keeps every source line on its own line', () => {
        const source = 'import {\n  a,\n  b,\n} from "x";\nconst {\n  c,\n} = a;\nclass K {\n  m() {}\n}\nc';
        expect(compileCell(source).code.split('\n')).toHaveLength(source.split('\n').length);
    });

    it.each([
        ['const = 1', 1, 7, /Unexpected token/],
        ['let a = 1;\nlet a = 2;', 2, 5, /already been declared/],
        ['return 1', 1, 1, /'return' outside of function/],
        ['export default 1', 1, 1, /exports are not supported/],
        ['const a = 1;\nexport { a };', 2, 1, /exports are not supported/],
        ['with (a) {}', 1, 1, /'with' in strict mode/],
    ])('rejects %j before running', (code, line, column, message) => {
        let error: unknown;
        try { compileCell(code, { line: 1 }); } catch (caught) { error = caught; }
        expect(error).toBeInstanceOf(SplSyntaxError);
        expect(error).toMatchObject({ line, col: column });
        expect((error as Error).message).toMatch(message);
    });

    it('offsets syntax errors by the fence position', () => {
        expect(() => compileCell('ok();\n)', { line: 40 })).toThrow(expect.objectContaining({ line: 41, col: 1 }));
    });

    it('erases TypeScript types and rejects non-erasable syntax', () => {
        const cell = compileCell('const a: number = 1;\ninterface B { c: string }\nfunction f<T>(x: T): T { return x; }\nf(a) as number', { language: 'ts' });
        expect(cell.declarations.map(item => item.name)).toEqual(['a', 'f']);
        expect(cell.code).not.toMatch(/number|interface/);
        expect(() => compileCell('enum Color { Red }', { language: 'ts', line: 5 })).toThrow(/invalid TypeScript.*erasable/);
        expect(() => compileCell('const a: number = 1;')).toThrow(SplSyntaxError);
    });
});

describe('fence execution', () => {
    it('runs top-level await, destructuring, classes and hoisted functions', async () => {
        expect(await value(`
const early = triple(2);
function triple(n) { return n * 3; }
const { a, list: [first, ...rest] } = await Promise.resolve({ a: 1, list: [2, 3, 4] });
let later;
later = a + first;
class Counter { #n = 0; bump() { return ++this.#n; } static make() { return new Counter(); } }
const counter = Counter.make();
counter.bump();
var legacy = 'v'
success({ early, later, rest, count: counter.bump(), legacy })`)).toEqual({ early: 6, later: 3, rest: [3, 4], count: 2, legacy: 'v' });
    });

    it('is strict: undeclared assignments fail and this is undefined', async () => {
        const result = await exec('const ok = this === undefined;\nmissing = 1;');
        expect(result).toMatchObject({ status: 'failure', failure: {
            status_code: 'runtime_error', reason: 'ReferenceError: missing is not defined', line: 2, command: 'missing = 1;',
        } });
    });

    it('avoids automatic-semicolon traps when declarations follow unterminated lines', async () => {
        expect(await value('const a = [1, 2]\nconst [b] = a\nlet c = b\nclass D {}\nconst e = new D() instanceof D\nsuccess([b, c, e])')).toEqual([1, 1, true]);
    });

    it('locates uncaught errors and failures inside nested functions', async () => {
        expect(await exec('function inner() {\n  null.x;\n}\nconst outer = async () => { await 0; inner(); };\nawait outer();')).toMatchObject({
            status: 'failure', failure: { line: 2, command: 'null.x;', status_code: 'runtime_error', reason: expect.stringContaining('TypeError') },
        });
        expect(await exec('\n\nassert(1 === 2, "math is broken");')).toMatchObject({
            failure: { line: 3, status_code: 'assertion_failed', reason: 'math is broken', command: 'assert(1 === 2, "math is broken");' },
        });
        expect(await exec('throw "plain value";')).toMatchObject({ failure: { status_code: 'runtime_error', reason: 'uncaught value: plain value', line: 1 } });
    });

    it('lets workflow code catch failures and inspect them', async () => {
        expect(await value(`
let seen;
try { fail('nope'); } catch (error) { seen = [error instanceof Failure, error.statusCode, error.status_code, error.reason, error.payload().status, error.line]; }
try { await readFile('./definitely-missing.txt'); } catch (error) { seen.push(error.statusCode, error.line); }
success(seen)`)).toEqual([true, 'explicit_failure', 'explicit_failure', 'nope', 'failure', 3, 'tool_error', 4]);
    });

    it('returns the success value and ignores a trailing expression in one-shot runs', async () => {
        expect(await exec('1 + 1')).toEqual({ status: 'success', value: null, hasValue: false });
        expect(await exec('success()')).toEqual({ status: 'success', value: null, hasValue: true });
        expect(await exec('success("done"); fail("unreachable")')).toEqual({ status: 'success', value: 'done', hasValue: true });
    });
});

describe('imports', () => {
    it('resolves Node built-ins, relative files and packages against the working directory', async () => {
        const cwd = tempDir();
        fs.writeFileSync(path.join(cwd, 'helper.mjs'), 'export const twice = n => n * 2; export default "fallback";');
        fs.writeFileSync(path.join(cwd, 'legacy.cjs'), 'module.exports = { legacy: true };');
        fs.writeFileSync(path.join(cwd, 'data.json'), '{"answer":42}');
        fs.writeFileSync(path.join(cwd, 'typed.ts'), 'export const typed: string = "ts";');
        fs.mkdirSync(path.join(cwd, 'node_modules', 'esm-only'), { recursive: true });
        fs.writeFileSync(path.join(cwd, 'node_modules', 'esm-only', 'package.json'), '{"name":"esm-only","type":"module","exports":{"import":"./index.js"}}');
        fs.writeFileSync(path.join(cwd, 'node_modules', 'esm-only', 'index.js'), 'export const packaged = "pkg";');
        expect(await value(`
import os from 'node:os';
import * as nodePath from 'path';
import fallback, { twice as double } from './helper.mjs';
import fallbackAgain, * as helper from './helper.mjs';
import legacy from './legacy.cjs';
import data from './data.json' with { type: 'json' };
import { typed } from './typed.ts';
import { packaged } from 'esm-only';
import './helper.mjs';
const lazy = await import('./helper.mjs');
success({
    os: typeof os.cpus, sep: nodePath.sep === '/' || nodePath.sep === '\\\\', double: double(4), fallback, fallbackAgain,
    same: helper.twice === double && lazy.twice === double, legacy: legacy.legacy, answer: data.answer, typed, packaged,
    meta: import.meta.dirname,
})`, { cwd })).toEqual({
            os: 'function', sep: true, double: 8, fallback: 'fallback', fallbackAgain: 'fallback', same: true,
            legacy: true, answer: 42, typed: 'ts', packaged: 'pkg', meta: cwd,
        });
    });

    it('gives helper modules the running library, with the workflow runtime', async () => {
        const cwd = tempDir();
        fs.writeFileSync(path.join(cwd, 'lib.mjs'), `
import { ask, fail, args, str, struct } from 'spl-lang';
import { bold } from 'spl-lang/markdown';
export const Card = struct('Card', { term: str });
export const shout = async text => bold((await ask('shout ' + text)).toUpperCase());
export const firstArg = () => args[0];
export const explode = () => fail('helper failed');`);
        const calls: string[] = [];
        const backend = { async call(request: { prompt: string }) { calls.push(request.prompt); return { text: 'quiet', effective: {} }; }, async close() {} };
        expect(await value(`
import { Card, shout, firstArg, explode } from './lib.mjs';
let code;
try { explode(); } catch (error) { code = error instanceof Failure && error.statusCode; }
success({ loud: await shout('now'), arg: firstArg(), card: Card.parse({ term: 'x' }), code })`,
        { cwd, backend, args: ['first'] })).toEqual({ loud: '**QUIET**', arg: 'first', card: { term: 'x' }, code: 'explicit_failure' });
        expect(calls).toEqual(['shout now']);
    });

    it('shares the running package with helpers and keeps imports live and read-only', async () => {
        const cwd = tempDir();
        fs.writeFileSync(path.join(cwd, 'counter.mjs'), `
import { Failure, markdown } from 'spl-lang';
import { Document } from 'spl-lang/markdown';
export let count = 0;
export const next = () => ++count;
export const identity = { Failure, Document, markdown };`);
        expect(await value(`
import { count, next, identity } from './counter.mjs';
import * as counter from './counter.mjs';
next(); next();
let assigned;
try { count = 10; } catch (error) { assigned = error.name; }
success([count, counter.count, identity.Failure === Failure, identity.Document === markdown.Document, identity.markdown === markdown, assigned]);`,
        { cwd })).toEqual([2, 2, true, true, true, 'TypeError']);
        const session = new ExecutionSession();
        await session.run(parse("import { next } from './counter.mjs';"), { ...options, cwd });
        expect(await session.run(parse('const next = () => "redeclared";\nnext()'), { ...options, cwd })).toMatchObject({ value: 'redeclared' });
    });

    it('fails with the import line when a module is missing', async () => {
        expect(await exec("const a = 1;\nimport { x } from './missing.mjs';", { cwd: tempDir() })).toMatchObject({
            status: 'failure', failure: { status_code: 'runtime_error', line: 2, reason: expect.stringMatching(/Cannot find module/) },
        });
    });
});

describe('interactive sessions', () => {
    it('retains variables, mutable aliases and live closures in execution order', async () => {
        const session = new ExecutionSession();
        await session.run(parse('let count = 2;\nconst items = [];\nconst alias = items;\nfunction double() { return count * 2; }'), options);
        await session.run(parse('items.push(double());\ncount += 1;'), options);
        expect(await session.run(parse('[double(), alias]'), options)).toEqual({ status: 'success', hasValue: true, value: [6, [4]] });
        await session.run(parse('let count = 10;'), options);
        expect(await session.run(parse('double()'), options)).toMatchObject({ value: 20 });
        expect(session.bindings).toEqual(expect.arrayContaining(['count', 'items', 'alias', 'double']));
    });

    it('returns the final expression, isolates sessions and keeps one-shot behavior', async () => {
        const first = new ExecutionSession();
        await first.run(parse('const value = 42;'), options);
        expect(await new ExecutionSession().run(parse('value'), options)).toMatchObject({ status: 'failure', failure: { reason: 'ReferenceError: value is not defined' } });
        expect(await first.run(parse('null'), options)).toEqual({ status: 'success', hasValue: true, value: null });
        expect(await first.run(parse('undefined'), options)).toEqual({ status: 'success', hasValue: false, value: null });
        expect(await first.run(parse('const nothing = null;'), options)).toEqual({ status: 'success', hasValue: false, value: null });
        expect(await first.run(parse('await Promise.resolve(value + 1)'), options)).toMatchObject({ value: 43 });
        expect(await first.run(parse('({ value })'), options)).toMatchObject({ value: { value: 42 } });
    });

    it('rejects concurrent runs without corrupting the active scope', async () => {
        const session = new ExecutionSession();
        let finish: (() => void) | undefined;
        const waiting = new Promise<void>(resolve => { finish = resolve; });
        const backend = { async call() { await waiting; return { text: 'ready', effective: {} }; }, async close() {} };
        const first = session.run(parse("const value = await ask('one');"), { logger: silent, backend });
        await expect(session.run(parse('const other = 1;'), options)).rejects.toThrow(/one cell at a time/);
        finish!();
        await first;
        expect(await session.run(parse('value'), options)).toMatchObject({ value: 'ready' });
        expect(await session.run(parse('other'), options)).toMatchObject({ status: 'failure' });
    });

    it('keeps state before a failure, reports the cell source and permits recovery', async () => {
        const session = new ExecutionSession();
        expect(await session.run(parse('const kept = 1;\nfail("stop");\nconst lost = 2;'), { ...options, source: 'cell:1', sourceVersion: 7 })).toEqual({
            status: 'failure', failure: {
                status: 'failure', reason: 'stop', command: 'fail("stop");', line: 2, status_code: 'explicit_failure',
                source: 'cell:1', source_version: 7,
            },
        });
        await session.run(parse('function later() { throw new Error("from cell 2"); }'), { ...options, source: 'cell:2' });
        expect(await session.run(parse('kept;\nlater();'), { ...options, source: 'cell:3' })).toMatchObject({
            failure: { reason: 'Error: from cell 2', line: 1, source: 'cell:2', command: 'function later() { throw new Error("from cell 2"); }' },
        });
        expect(await session.run(parse('[kept, typeof lost]'), options)).toMatchObject({ value: [1, 'undefined'] });
    });

    it('redefines functions and classes across cells', async () => {
        const session = new ExecutionSession();
        await session.run(parse('function greet() { return "v1"; }\nclass Shape { area() { return 1; } }'), options);
        await session.run(parse('function greet() { return "v2"; }\nclass Shape { area() { return 2; } }'), options);
        expect(await session.run(parse('[greet(), new Shape().area()]'), options)).toMatchObject({ value: ['v2', 2] });
    });
});
