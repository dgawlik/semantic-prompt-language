import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { compile } from '../src/compile.js';
import { SplSyntaxError } from '../src/errors.js';
import { library } from '../src/library.js';
import type { Step } from '../src/runtime.js';
import { run } from '../src/workflow.js';
import { NoLlm, agentBlock, acting, block, cleanTemp, collecting, exec, save, scripted, silent, tempDir, text, value } from './helpers.js';

afterEach(cleanTemp);

const failure = async (source: string, options = {}) => {
    const result = await exec(source, options);
    if (result.status !== 'failure') throw new Error('expected a failure');
    return result.failure;
};

describe('results', () => {
    it('returns the value given to success()', async () => {
        expect(await exec("success({ answer: 42 });\nfail('not reached');")).toEqual({ status: 'success', value: { answer: 42 }, hasValue: true });
        expect(await exec('success();')).toEqual({ status: 'success', value: null, hasValue: true });
    });

    it('has no value when the workflow just ends', async () => {
        expect(await exec('const a = 1;')).toEqual({ status: 'success', value: null, hasValue: false });
    });

    it('runs TypeScript with top-level await, the library and Node.js imports', async () => {
        expect(await value([
            "import * as path from 'node:path';",
            'interface Point { x: number; y: number }',
            'type Pair<T> = [T, T];',
            'const point: Point = { x: 1, y: 2 };',
            'const pair = [point.x, point.y] as Pair<number>;',
            'const Total = Struct("Total", { sum: Int });',
            'await new Promise<void>(resolve => setTimeout(resolve, 1));',
            'success({ total: Total.parse({ sum: pair[0] + pair[1] }), file: path.basename(import.meta.filename), args: [...args] });',
        ].join('\n'), { file: 'points.spl', args: ['a', 'b'] })).toEqual({ total: { sum: 3 }, file: 'points.spl', args: ['a', 'b'] });
    });

    it('lets workflow variables shadow library names', async () => {
        expect(await value('const log = (text: string) => text.toUpperCase();\nconst List = [1, 2];\nsuccess([log("a"), List.length]);')).toEqual(['A', 2]);
    });
});

describe('failures', () => {
    it('reports the line and source of the statement that failed', async () => {
        expect(await failure("const a = 1;\n\nfail('nope');")).toEqual({ status: 'failure', reason: 'nope', command: "fail('nope');", line: 3, status_code: 'explicit_failure' });
        expect(await failure("assert(1 + 1 === 3,\n    'math');")).toMatchObject({ status_code: 'assertion_failed', reason: 'math', line: 1 });
    });

    it('locates errors thrown inside functions, on any line including the first', async () => {
        expect(await failure("null.x;")).toMatchObject({ status_code: 'runtime_error', line: 1, command: 'null.x;' });
        expect(await failure("function boom(): never {\n    throw new TypeError('bad');\n}\nawait Promise.resolve();\nboom();"))
            .toMatchObject({ status_code: 'runtime_error', reason: 'TypeError: bad', line: 2, command: "throw new TypeError('bad');" });
    });

    it('lets workflow code catch failures and read their status', async () => {
        expect(await value("try {\n    fail('inner');\n} catch (error) {\n    success([error instanceof Failure, error.statusCode, error.line]);\n}"))
            .toEqual([true, 'explicit_failure', 2]);
    });

    it('throws syntax problems before anything runs', async () => {
        await expect(exec('let a = 1;\nlet a = 2;')).rejects.toThrow(SplSyntaxError);
        await expect(exec('const x = ;')).rejects.toMatchObject({ problems: [{ line: 1, column: 11, message: 'invalid TypeScript: Expression expected' }] });
        await expect(exec('function f() {\n    ---\n    outputVar: a\n\n    Hi\n    ---\n}')).rejects.toMatchObject({ problems: [{ line: 2 }] });
        await expect(exec('---\nmodel: x\n---\n---\nmodle: y\noutputVar: a\n\nHi\n---')).rejects.toMatchObject({ problems: [{ line: 5, column: 1, message: 'unknown header key `modle`; did you mean `model`?' }] });
    });
});

describe('modules', () => {
    it('keeps imports and exported declarations at module level, on their own lines', async () => {
        const directory = tempDir();
        fs.writeFileSync(path.join(directory, 'lib.spl'), [
            'const greeting = "hello";',
            'export function double(n: number): number {',
            "    if (n < 0) throw new RangeError('negative');",
            '    return n * 2;',
            '}',
            'export const Pair = Struct("Pair", { a: Int, b: Int });',
            'success(`${greeting} ${args.join(",")}`);',
        ].join('\n'));
        const source = [
            'const before = 1;',
            "import sub, { double, Pair } from './lib.spl';",
            'const viaWorkflow = await sub(["x", "y"]);',
            'success({ doubled: double(before + 1), pair: Pair.parse({ a: 1, b: 2 }), viaWorkflow, own: [...args] });',
        ].join('\n');
        expect(await value(source, { file: path.join(directory, 'main.spl'), cwd: directory, args: ['main'] }))
            .toEqual({ doubled: 4, pair: { a: 1, b: 2 }, viaWorkflow: 'hello x,y', own: ['main'] });
        const failed = await failure("import { double } from './lib.spl';\ndouble(-1);", { file: path.join(directory, 'other.spl'), cwd: directory });
        expect(failed).toMatchObject({ reason: 'RangeError: negative', line: 3, command: "if (n < 0) throw new RangeError('negative');", source: path.join(directory, 'lib.spl') });
    });

    it('locates failures in exported declarations of the workflow itself', async () => {
        expect(await failure("const a = 1;\nexport function check(n: number): void {\n    assert(n > 1, 'too small');\n}\ncheck(a);"))
            .toMatchObject({ status_code: 'assertion_failed', line: 3, command: "assert(n > 1, 'too small');" });
    });

    it('rejects exports that depend on the workflow run', async () => {
        await expect(exec('const limit = 3;\nexport function capped(n: number) {\n    return Math.min(n, limit);\n}')).rejects.toMatchObject({
            problems: [{ line: 3, column: 24, message: 'exported `capped` uses the workflow variable `limit`; exports live outside the workflow, so export `limit` too or pass it as a parameter' }],
        });
        await expect(exec('const limit = 3;\nexport { limit };')).rejects.toMatchObject({ problems: [{ line: 2, message: 'cannot export the workflow variable `limit`; write `export` on its declaration instead' }] });
        await expect(exec('export default 1;')).rejects.toMatchObject({ problems: [{ message: 'the default export of a .spl file is its workflow; remove `export default`' }] });
        expect(await value('export const limit = 3;\nexport function capped(n: number, limit: number) {\n    const local = limit;\n    return Math.min(n, local);\n}\nsuccess(capped(5, limit));')).toBe(3);
    });

    it('reports syntax problems of an imported workflow with its file', async () => {
        const directory = tempDir();
        fs.writeFileSync(path.join(directory, 'broken.spl'), 'enum Color { Red }');
        const error = await exec("import './broken.spl';", { file: path.join(directory, 'main.spl') }).catch(error => error);
        expect(error).toBeInstanceOf(SplSyntaxError);
        expect(error.format('main.spl')).toBe(`${path.join(directory, 'broken.spl')}:1:1: syntax error: Unsupported TypeScript syntax: \`enum\` cannot be erased; use a union of string literals instead of enum`);
    });
});

describe('compile', () => {
    const emit = (source: string): string => compile(source).emit({ library: Object.keys(library()), from: 'demo.spl' });

    it('emits a TypeScript module whose default export runs the workflow', () => {
        const output = emit([
            '---', 'model: gpt-6-luna', 'enforce: Be brief', '---',
            "import { helper } from './helper.spl';", "import * as fs from 'node:fs';",
            'export const Card = Struct("Card", { term: Str });',
            'const topic: string = helper(args[0]);',
            block('Define @topic', 'outputVar: card', 'outputType: Card'),
            'success(card);',
        ].join('\n'));
        expect(output).toBe([
            '// Generated by `spl compile` from demo.spl. Edit the .spl file, not this module.',
            "import { __spl, success, args, Str, Struct } from 'spl-lang';",
            "import { helper } from './helper.ts' ;",
            "import * as fs from 'node:fs';",
            'export const Card = Struct("Card", { term: Str });',
            '',
            'export default async function workflow(args: string[] = [], options?: __spl.WorkflowOptions): Promise<unknown> {',
            '    return __spl.workflow({ url: import.meta.url, defaults: {"model":"gpt-6-luna","enforce":["Be brief"]} }, args, options, async () => {',
            'const topic: string = helper(args[0]);',
            'const card = await __spl.ask({"line":9,"output":"card","text":"Define @topic", "outputType":',
            '',
            'Card })',
            '',
            '.in("topic", topic)',
            ';',
            'success(card);',
            '    });',
            '}',
            '',
        ].join('\n'));
    });

    it('runs as a plain module that builds its own runtime from options', async () => {
        const directory = tempDir();
        const target = path.join(directory, 'compiled.ts');
        fs.writeFileSync(target, emit(`${block('Say hi to @args', 'outputVar: greeting')}\nif (greeting === 'fail') fail('asked to');\nsuccess(greeting);`)
            .replace("'spl-lang'", JSON.stringify(pathToFileURL(path.resolve('dist/index.js')).href)));
        // Node's own import(), so the module runs exactly as it would outside the test runner.
        const load = (await import('data:text/javascript,export default specifier => import(specifier);')).default as (specifier: string) => Promise<unknown>;
        const module = await load(pathToFileURL(target).href) as { default: (args?: string[], options?: object) => Promise<unknown> };
        const backend = scripted('Hi!', 'fail');
        expect(await module.default(['Ada'], { backend, logger: silent })).toBe('Hi!');
        expect(backend.calls[0].prompt).toContain('@args = ["Ada"]');
        await expect(module.default([], { backend, logger: silent })).rejects.toMatchObject({ statusCode: 'explicit_failure', reason: 'asked to', line: 10, command: "if (greeting === 'fail') fail('asked to');" });
    });
});

describe('stepping and state', () => {
    it('stops before each block and each top-level statement, with a snapshot of the top-level variables', async () => {
        const steps: (Omit<Step, 'variables'> & { variables: Record<string, unknown> })[] = [];
        const source = [
            'let count = 1;',
            'function twice(n: number) {', '    const inner = n * 2;', '    return inner;', '}',
            agentBlock('Double @count ->[Int] @doubled'),
            'count = twice(doubled);',
        ].join('\n');
        const result = await run(source, {
            backend: acting(save('doubled', 2)), logger: silent,
            beforeStep: step => { steps.push({ ...step, variables: step.variables() }); },
        });
        expect(result).toMatchObject({ status: 'success' });
        expect(steps).toEqual([
            { kind: 'code', line: 1, language: 'ts', source: 'let count = 1;', variables: { count: '<uninitialized>', twice: 'function twice(n)', doubled: '<uninitialized>' } },
            { kind: 'block', line: 6, language: 'agent', source: 'Double @count ->[Int] @doubled', variables: { count: 1, twice: 'function twice(n)', doubled: '<uninitialized>' } },
            { kind: 'code', line: 11, language: 'ts', source: 'count = twice(doubled);', variables: { count: 1, twice: 'function twice(n)', doubled: 2 } },
        ]);
    });

    it('logs changes of top-level variables and outputs of nested blocks at debug level', async () => {
        const { logger, events } = collecting('debug');
        const source = [
            'let total = 0;',
            'const seen: string[] = [];',
            'async function describe(item: string) {',
            '    let local = item.length;',
            '    ---', '    outputVar: summary', '', '    Describe @item', '    ---',
            '    local++;',
            '    return summary;',
            '}',
            'seen.push(await describe("pear"));',
            'total = seen.length;',
        ].join('\n');
        expect(await run(source, { backend: scripted('A fruit.'), logger })).toMatchObject({ status: 'success' });
        expect(events.filter(event => event.kind === 'state').map(text)).toEqual([
            'describe @ global (scope-1): <unbound> -> "<async function describe(item) ref-1>"',
            'total @ global (scope-1): <unbound> -> 0',
            'seen @ global (scope-1): <unbound> -> []',
            'summary @ block at line 5 (block-5): <unbound> -> "A fruit."',
            'seen @ global (scope-1): [] -> ["A fruit."]',
            'total @ global (scope-1): 0 -> 1',
        ]);
    });

    it('adds nothing to a run that neither steps nor logs state', async () => {
        expect(compile('let a = 1;\na++;').module({ library: [] }).code).not.toContain('__spl.step');
        expect(await new NoLlm().close()).toBeUndefined();
    });
});
