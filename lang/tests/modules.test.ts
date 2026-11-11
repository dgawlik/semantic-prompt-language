import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExecutionSession, run, type RunOptions } from '../src/interpreter.js';
import { Logger } from '../src/logger.js';
import { parseMarkdown } from '../src/markdown.js';
import { parse } from '../src/parser.js';
import { Pin } from '../src/pin.js';
import { Trace } from '../src/trace.js';
import { loadModules } from '../src/modules.js';
import { NoLlm } from './helpers.js';

let cwd: string;
const logger = new Logger('silent');
const markdown = (body: string) => `---\nextension: semantic-prompt-language\nversion: 1\n---\n\n\`\`\`spl\n${body}\n\`\`\`\n`;
const module = (name: string, source: string) => {
    const file = path.join(cwd, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, source);
    return file;
};
async function execute(body: string, options: Partial<RunOptions> = {}) {
    return run(parseMarkdown(markdown(body)), {
        backend: new NoLlm(), logger, cwd, source: path.join(cwd, 'workflow.md'), ...options,
    });
}
beforeEach(() => { cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'spl-modules-')); });
afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(cwd, { recursive: true, force: true });
});

describe('SPL module imports', () => {
    it('imports named aliases and namespaces from Markdown with isolated lexical scopes', async () => {
        module('helpers.spl', `let factor = 3
def multiply(value):
    return value * factor`);
        expect(await execute(`import { multiply as times } from './helpers.spl'
import * as helpers from './helpers.spl'
let factor = 99
success [times(4), helpers.multiply(5), helpers.factor, factor]`))
            .toMatchObject({ status: 'success', value: [12, 15, 3, 99] });
    });

    it('automatically exports typed functions, variables and type declarations', async () => {
        module('types.spl', `enum Color = 'red' | 'blue'
type Amount = int
struct Item:
    count: Amount
class Box:
    count: int
    def Box(count: int):
        self.count = count
let initial: Amount = 2
def add(a: Amount, b: Amount) -> Amount:
    return a + b`);
        expect(await execute(`import { Color, Amount, Item, Box, initial, add } from './types.spl'
let item: Item = object:
    'count': initial
let color: Color = 'red'
let box = Box(initial)
success [add(item.count, initial), color, box.count]`))
            .toMatchObject({ status: 'success', value: [4n, 'red', 2n] });
    });

    it('initializes nested dependencies once and resolves paths relative to each importer, not cwd', async () => {
        module('lib/counter.spl', `log('initialized')
let count = 0
def next():
    count += 1
    return count`);
        module('lib/index.spl', `import { count, next } from './counter.spl'
let label = 'barrel'`);
        const lines: string[] = [];
        expect(await execute(`import { next, count } from './lib/index.spl'
import * as counter from './lib/counter.spl'
success [next(), count, counter.next(), counter.count]`, {
            cwd: os.tmpdir(), logger: new Logger('info', line => lines.push(line)),
        })).toMatchObject({ status: 'success', value: [1, 1, 2, 2] });
        expect(lines).toEqual(['[info] log: initialized']);
    });

    it('links imports before any workflow statement even when the import appears later', async () => {
        module('values.spl', 'let answer = 42');
        expect(await execute("success answer\nimport { answer } from './values.spl'"))
            .toMatchObject({ status: 'success', value: 42 });
    });

    it('supports multiline named imports, trailing commas, file URLs and paths with spaces', async () => {
        module('some helpers.spl', 'let one = 1\nlet two = 2');
        expect(await execute(`import {
    one,
    two as other,
} from './some helpers.spl'
success one + other`, { source: pathToFileURL(path.join(cwd, 'workflow.md')).href }))
            .toMatchObject({ status: 'success', value: 3 });
    });

    it('keeps imports live and read-only while allowing mutation of exported containers', async () => {
        module('counter.spl', `let count = 0
let items = []
def advance():
    count += 1
    items.append(count)`);
        expect(await execute(`import { count, items, advance } from './counter.spl'
import * as counter from './counter.spl'
advance()
items.append(2)
success [count, counter.count, counter.items]`))
            .toMatchObject({ status: 'success', value: [1, 1, [1, 2]] });
        for (const statement of ['count = 9', 'let count = 9', 'counter = object()', 'counter.count = 9', "counter['count'] = 9"]) {
            expect(await execute(`import { count } from './counter.spl'
import * as counter from './counter.spl'
${statement}`)).toMatchObject({ status: 'failure' });
        }
    });

    it('preflights missing imports and module type errors before earlier model calls', async () => {
        module('bad.spl', "let bad: int = 'wrong'");
        module('known.spl', 'let known = 1');
        for (const statement of [
            "import { absent } from './missing.spl'",
            "import { absent } from './known.spl'",
            "import * as bad from './bad.spl'",
            "import { known } from 'known.spl'",
            "import { known } from './workflow.md'",
        ]) {
            const backend = new NoLlm();
            const call = vi.spyOn(backend, 'call');
            expect(await execute(`let earlier = ask 'must not run'\n${statement}`, { backend }))
                .toMatchObject({ status: 'failure' });
            expect(call).not.toHaveBeenCalled();
        }
    });

    it('preflights imported function signatures in named and namespace calls', async () => {
        module('typed.spl', 'def add(value: int) -> int:\n    return value + 1');
        for (const expr of ["add('wrong')", "typed.add('wrong')"]) {
            expect(await execute(`import { add } from './typed.spl'
import * as typed from './typed.spl'
success ${expr}`)).toMatchObject({ status: 'failure', failure: { status_code: 'type_error' } });
        }
    });

    it('treats namespace exports as members rather than dictionary methods', async () => {
        module('helpers.spl', `def keys(value: int) -> int:
    return value + 1
def copy(value):
    return value`);
        expect(await execute(`import * as helpers from './helpers.spl'
success [helpers.keys(2), helpers.copy('kept')]`))
            .toMatchObject({ status: 'success', value: [3n, 'kept'] });
        expect(await execute(`import * as helpers from './helpers.spl'
helpers.copy('first')
success helpers.keys('wrong')`)).toMatchObject({ status: 'failure', failure: { status_code: 'type_error' } });
    });

    it('invalidates live imported scalar literals after calls without losing their contracts', async () => {
        module('counter.spl', `let count: int = 0
def advance():
    count += 1`);
        expect(await execute(`import { count, advance } from './counter.spl'
advance()
success 4 // count`)).toMatchObject({ status: 'success', value: 4n });
    });

    it('does not export block-local declarations', async () => {
        module('scopes.spl', 'if True:\n    let hidden = 1\nlet visible = 2');
        expect(await execute("import { hidden } from './scopes.spl'"))
            .toMatchObject({ status: 'failure', failure: { reason: expect.stringContaining("no export 'hidden'") } });
    });

    it('reports cycles, syntax errors, missing exports and module source locations explicitly', async () => {
        module('a.spl', "import { b } from './b.spl'\nlet a = 1");
        module('b.spl', "import { a } from './a.spl'\nlet b = 2");
        expect(await execute("import * as a from './a.spl'"))
            .toMatchObject({ status: 'failure', failure: { reason: expect.stringContaining('circular import') } });
        const invalid = module('invalid.spl', 'let missing =');
        expect(await execute("import * as invalid from './invalid.spl'"))
            .toMatchObject({ status: 'failure', failure: { source: invalid, line: 1, reason: expect.stringContaining('syntax error') } });
        const broken = module('broken.spl', "def broken():\n    fail 'from module'");
        expect(await execute("import { broken } from './broken.spl'\nbroken()"))
            .toMatchObject({ status: 'failure', failure: { source: broken, line: 2, reason: 'from module' } });
    });

    it.each(["success 1", "return 1", "@(model='other')\nlet value = 1"])(
        'does not let module initialization terminate or reconfigure the caller: %s', async source => {
            module('bad.spl', source);
            expect(await execute("import * as bad from './bad.spl'\nsuccess 'caller'"))
                .toMatchObject({ status: 'failure', failure: { status_code: 'runtime_error' } });
        },
    );

    it('preserves caller restrictions for imported functions', async () => {
        module('reader.spl', "def read():\n    return read_file('private.txt')");
        module('private.txt', 'private');
        fs.mkdirSync(path.join(cwd, 'allowed'));
        expect(await execute(`import { read } from './reader.spl'
restrict './allowed':
    read()`)).toMatchObject({ status: 'failure', failure: { status_code: 'restriction_violation' } });
    });

    it('does not persist imported bindings or namespace objects in variable stores', async () => {
        module('values.spl', 'let values = [1]\nlet count = 2');
        const save = vi.fn();
        expect(await execute(`import { values, count } from './values.spl'
import * as all from './values.spl'
let own = count
success values`, { store: { load: () => ({}), save } })).toMatchObject({ status: 'success', value: [1] });
        expect(save).toHaveBeenCalledWith({ own: 2 });
    });

    it('retains cached module state across notebook cells and uses current-cell log sinks', async () => {
        const file = module('counter.spl', `let count = 0
def next():
    count += 1
    log(count)
    return count`);
        const session = new ExecutionSession();
        const old: string[] = [], current: string[] = [];
        const options = { backend: new NoLlm(), cwd, source: 'vscode-notebook-cell:test' };
        expect(await session.run(parse("import { next, count } from './counter.spl'\nnext()"), {
            ...options, logger: new Logger('info', line => old.push(line)),
        })).toMatchObject({ status: 'success', value: 1 });
        fs.unlinkSync(file);
        expect(await session.run(parse("import * as counter from './counter.spl'\n[next(), count, counter.count]"), {
            ...options, logger: new Logger('info', line => current.push(line)),
        })).toMatchObject({ status: 'success', value: [2, 2, 2] });
        expect(old).toEqual(['[info] log: 1']);
        expect(current).toEqual(['[info] log: 2']);
    });

    it('pins module sources and replays without their files or live model calls', async () => {
        const file = module('answer.spl', "let answer = ask 'Question?'\ndef read():\n    return answer");
        const source = markdown("import { read } from './answer.spl'\nsuccess read()");
        const pin = Pin.capture(source, { cwd, args: [] });
        const first = await run(parseMarkdown(source), {
            backend: { async call() { return { text: 'recorded answer', effective: {} }; }, async close() {} },
            logger, cwd, pin, source: path.join(cwd, 'workflow.md'),
        });
        expect(first).toMatchObject({ status: 'success', value: 'recorded answer' });
        fs.unlinkSync(file);
        expect(await run(parseMarkdown(pin.toMarkdown(source)), { backend: new NoLlm(), logger })).toEqual(first);
    });

    it('type-checks retained live bindings after a module rebinds them to None', async () => {
        module('values.spl', `let value = 1
def clear():
    value = None`);
        const session = new ExecutionSession();
        const options = { backend: new NoLlm(), logger, cwd };
        expect(await session.run(parse("import { value, clear } from './values.spl'\nclear()"), options))
            .toMatchObject({ status: 'success' });
        expect(await session.run(parse('let result: None = value\nsuccess result'), options))
            .toMatchObject({ status: 'success', value: null });
    });

    it('allows notebook cells to repeat the same imports without reinitializing modules', async () => {
        module('counter.spl', `let count = 0
def next():
    count += 1
    return count`);
        const session = new ExecutionSession();
        const source = `import { count, next } from './counter.spl'
import * as counter from './counter.spl'
next()
success [count, counter.count]`;
        for (const value of [1, 2]) {
            expect(await session.run(parse(source), { backend: new NoLlm(), logger, cwd }))
                .toMatchObject({ status: 'success', value: [value, value] });
        }
        expect(await execute("import { next } from './counter.spl'\nimport { next } from './counter.spl'"))
            .toMatchObject({ status: 'failure', failure: { status_code: 'type_error' } });
    });

    it('records module sources in traces and replays without accessing changed or missing files', async () => {
        const file = module('answer.spl', 'let answer = 42');
        const source = "import { answer } from './answer.spl'\nsuccess answer";
        const traceFile = path.join(cwd, 'run.jsonl');
        let expected;
        for (let i = 0; i < 2; i++) {
            const trace = Trace.open(traceFile, { source, runtime: 'test', cwd });
            try {
                const result = await run(parse(source), { backend: new NoLlm(), logger, cwd, trace });
                trace.finish(result);
                if (!i) {
                    expected = result;
                    expect(result).toMatchObject({ status: 'success', value: 42 });
                    fs.unlinkSync(file);
                } else expect(result).toEqual(expected);
            } finally { trace.close(); }
        }
    });

    it('loads graphs for check-only callers without executing module code', () => {
        module('check.spl', "fail 'must not execute'\nlet known = 1");
        expect(loadModules(parse("import { known } from './check.spl'"), undefined, cwd).modules.size).toBe(1);
    });
});
