import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { LogEvent } from '../src/log-events.js';
import { formatEvent } from '../src/log-format.js';
import { Logger } from '../src/logger.js';
import { parse } from '../src/markdown.js';
import { ExecutionSession, type RunOptions } from '../src/workflow.js';
import { NoLlm, acting, action, backend, cleanTemp, collecting, exec, execMarkdown, fence, scripted, silent, tempDir } from './helpers.js';

afterEach(cleanTemp);

type StateEvent = Extract<LogEvent, { kind: 'state' }>;
const states = (events: LogEvent[]): StateEvent[] => events.filter(event => event.kind === 'state');
const shown = (value: StateEvent['change']['bindings'][0]['next']) => value.presence === 'value' ? value.display : '<unbound>';
/** `operation name: before -> after` for each single-binding state event. */
const changes = (events: LogEvent[]) => states(events).map(({ change }) =>
    `${change.operation} ${change.bindings.map(delta => `${delta.binding.name}: ${shown(delta.previous)} -> ${shown(delta.next)}`).join(', ')}`);
const names = (events: LogEvent[]) => states(events).map(event => event.change.bindings.map(delta => delta.binding.name).join(','));

async function observe(code: string, options: Partial<RunOptions> = {}) {
    const { logger, events } = collecting('debug');
    const result = await exec(code, { logger, ...options });
    return { result, events, states: states(events) };
}

describe('top-level binding observation', () => {
    it.each(['error', 'info', 'debug', 'silent'] as const)('logs binding and mutation changes only at debug, not %s', async level => {
        const events: LogEvent[] = [];
        const result = await exec(`let n = 0;
const items = [];
n += 1;
items.push(n);
success([n, items]);`, { logger: new Logger(level, undefined, { eventSink: event => events.push(event) }) });
        expect(result).toMatchObject({ status: 'success', value: [1, [1]] });
        expect(events.map(event => event.kind)).toEqual(level === 'debug' ? ['state', 'state', 'state', 'state'] : []);
        expect(changes(events)).toEqual(level === 'debug'
            ? ['initialize n: <unbound> -> 0', 'initialize items: <unbound> -> []', 'rebind n: 0 -> 1', 'mutation items: [] -> [1]'] : []);
    });

    it('reports every binding in the single global scope, one binding per event', async () => {
        const { states } = await observe('const a = 1, { b, c: [d] } = { b: 2, c: [3] };\nvar e = 4;\nclass F {}');
        expect(states.map(event => event.change.bindings)).toEqual(['a', 'b', 'd', 'e', 'F'].map(name => [expect.objectContaining({
            binding: { scopeId: 'scope-1', kind: 'global', label: 'global', bindingId: `scope-1:${name}`, name },
        })]));
        expect(states.every(event => event.origin === 'state' && Object.isFrozen(event.change) && Object.isFrozen(event.change.bindings[0].next))).toBe(true);
    });

    it('distinguishes unbound/null, Object.is scalar changes and equal-content reference replacement', async () => {
        const { result, states } = await observe(`let n = null;
n = null;
n = 0;
n = -0;
n = -0;
let values = [1];
values = values;
values = [1];
success(n);`);
        expect(result).toMatchObject({ status: 'success' });
        expect(changes(states)).toEqual([
            'initialize n: <unbound> -> null', 'rebind n: null -> 0', 'rebind n: 0 -> -0',
            'initialize values: <unbound> -> [1]', 'rebind values: [1] -> [1]',
        ]);
        expect(states[0].change.bindings[0]).toMatchObject({ previous: { presence: 'unbound' }, next: { presence: 'value', valueKind: 'scalar' } });
        const [initial, replacement] = [states[3].change.bindings[0].next, states[4].change.bindings[0].next];
        expect(initial.presence === 'value' && replacement.presence === 'value' && initial.referenceId !== replacement.referenceId).toBe(true);
        expect(states[4].change.bindings[0].previous).toEqual(initial);
        expect(states.every(event => event.change.targetReferenceId === undefined && event.change.path === undefined)).toBe(true);
    });

    it('compares bindings after each top-level statement, reporting only its net effect', async () => {
        const { result, events } = await observe(`let n = 0;
const items = [];
const step = () => ++n;
items.push(step(), step());
{ n = 100; n = 2; }
for (let i = 0; i < 3; i++) n += i;
n = 9; n = 5;
success(n);`);
        expect(result).toMatchObject({ status: 'success', value: 5 });
        expect(changes(events).filter(change => !change.includes('step'))).toEqual([
            'initialize n: <unbound> -> 0', 'initialize items: <unbound> -> []',
            'rebind n: 0 -> 2', 'mutation items: [] -> [1,2]',
            'rebind n: 2 -> 5', 'rebind n: 5 -> 9', 'rebind n: 9 -> 5',
        ]);
    });

    it('reports only shared bindings: function locals, parameters, block scopes and handlers stay invisible', async () => {
        const { result, states } = await observe(`let total = 0;
const seen = [];
function visit(x) {
    const local = x * 2;
    if (x > 0) visit(x - 1);
    seen.push(local);
}
{
    const hidden = 10;
    let shadow = hidden;
    total += shadow;
}
for (const [a, b] of [[1, 2], [3, 4]]) total += a;
visit(2);
try { fail('caught'); } catch (err) { const reason = err.reason; }
success(total);`);
        expect(result).toMatchObject({ status: 'success', value: 14 });
        expect(names(states)).toEqual(['total', 'visit', 'seen', 'total', 'total', 'seen']);
        expect(changes(states).slice(3)).toEqual(['rebind total: 0 -> 10', 'rebind total: 10 -> 14', 'mutation seen: [] -> [0,2,4]']);
        expect(new Set(states.map(event => event.change.bindings[0].binding.scopeId))).toEqual(new Set(['scope-1']));
        const callable = states[1].change.bindings[0].next;
        expect(callable).toMatchObject({ presence: 'value', valueKind: 'callable', display: expect.stringMatching(/^"<function visit\(x\) ref-\d+>"$/) });
        expect(JSON.stringify(callable)).not.toMatch(/local|visit\(x - 1\)/);
    });

    it.each([
        ['null', 'scalar', 'null'],
        ["'text'", 'scalar', '"text"'],
        ['-0', 'scalar', '-0'],
        ['[1, [-0, undefined]]', 'list', '[1,["<-0>","undefined"]]'],
        ['{ a: { b: 1 }, get late() { throw new Error("getter ran"); } }', 'dictionary', '{"a":{"b":1},"late":"<accessor>"}'],
        ['Object.create(null)', 'dictionary', '{}'],
        ['new Map([[1, 2]])', 'foreign', '{}'],
        ["new Error('boom')", 'foreign', '"<Error boom>"'],
        ["struct('Card', { term: str })", 'foreign', '"<type Card>"'],
        ['new (class Point { x = 1; #secret = 2; })()', 'foreign', '{"x":1}'],
        ['new Proxy({}, { get() { throw new Error("trap ran"); } })', 'foreign', '"<proxy>"'],
        ['async (a, b) => a + b', 'callable', /^"<async function value\(a, b\) ref-\d+>"$/],
        ['class Shape { area() { return 1; } }', 'callable', /^"<class Shape ref-\d+>"$/],
    ])('describes %s as a %s value', async (expression, valueKind, display) => {
        const { result, states } = await observe(`const value = ${expression};`);
        expect(result.status).toBe('success');
        expect(states).toHaveLength(1);
        const { next } = states[0].change.bindings[0];
        expect(next).toMatchObject({ presence: 'value', valueKind, display: typeof display === 'string' ? display : expect.stringMatching(display) });
        expect('referenceId' in next).toBe(valueKind !== 'scalar');
    });

    it('skips undefined placeholders and imported modules', async () => {
        const cwd = tempDir();
        fs.writeFileSync(path.join(cwd, 'helper.mjs'), 'export const twice = n => n * 2; export const state = { calls: 0 };');
        const { result, states } = await observe(`import os from 'node:os';
import * as helper from './helper.mjs';
import { twice, state } from './helper.mjs';
let later;
var legacy;
const doubled = twice(2);
state.calls += 1;
later = os.EOL.length > 0 && helper.state.calls;
success(typeof legacy);`, { cwd });
        expect(result).toMatchObject({ status: 'success', value: 'undefined' });
        expect(changes(states)).toEqual(['initialize doubled: <unbound> -> 4', 'initialize later: <unbound> -> 1']);
    });

    it('follows bindings across fences: later fences rebind, redeclare and mutate earlier ones', async () => {
        const { logger, events } = collecting('debug');
        const result = await execMarkdown(`${fence('let n = 1;\nconst items = [];')}

Prose is not observed.

${fence('const n: number = 2;\nitems.push(n);', 'ts')}

${fence('var n = 3;\nsuccess(items);')}`, { logger });
        expect(result).toMatchObject({ status: 'success', value: [2] });
        expect(changes(events)).toEqual([
            'initialize n: <unbound> -> 1', 'initialize items: <unbound> -> []', 'rebind n: 1 -> 2', 'mutation items: [] -> [2]', 'rebind n: 2 -> 3',
        ]);
    });

    it('reports hoisted and generated functions as callables without their bodies', async () => {
        const { logger, events } = collecting('debug');
        const result = await execMarkdown(`> @CODEGEN 'Define double(value)'\n\n${fence('const four = double(2);\nfunction later() { return four; }')}`, {
            logger, backend: scripted('function double(value) {\n    return value * 2;\n}'),
        });
        expect(result.status).toBe('success');
        expect(names(events)).toEqual(['double', 'four', 'later']);
        expect(states(events)[0].change).toMatchObject({ operation: 'initialize', bindings: [{ next: {
            valueKind: 'callable', display: expect.stringMatching(/^"<function double\(value\) ref-\d+>"$/),
        } }] });
        expect(JSON.stringify(states(events))).not.toMatch(/value \* 2|return four/);
    });

    it.each(['error', 'info', 'debug'] as const)('has no automatic read/no-op/control-flow logs at %s', async level => {
        const session = new ExecutionSession();
        await session.run(parse('let n = 1;\nconst items = [1];\nconst unchanged = () => n;'), { backend: new NoLlm(), logger: silent });
        const events: LogEvent[] = [];
        const result = await session.run(parse(`n = n;
items.reverse();
items.sort();
unchanged();
if (true) {}
for (const item of items) item;
await restrict('.', async () => {});
success(n);`), { backend: new NoLlm(), logger: new Logger(level, undefined, { eventSink: event => events.push(event) }) });
        expect(result).toMatchObject({ status: 'success', value: 1 });
        expect(events).toEqual([]);
    });

    it('does not report bindings that a variable store provided before the run started', async () => {
        const { result, events } = await observe('n = n;\nitems.reverse();\nsuccess(n);', { store: { load: () => ({ n: 1, items: [1] }), save() {} } });
        expect(result).toMatchObject({ status: 'success', value: 1 });
        expect(events).toEqual([]);
    });

    it('prints the binding, its scope and foldable before/after values', async () => {
        const { logger, events } = collecting('debug');
        await exec('let n = 0;\nn += 1;\nconst item = { a: [1] };\nitem.a = "\\u001b[31mred";', { logger });
        expect(events.map(event => formatEvent(event))).toEqual([
            '~ state n @ global (scope-1): <unbound> -> 0',
            '~ state n @ global (scope-1): 0 -> 1',
            '~ state item @ global (scope-1): <unbound> -> {\n  "a": [\n    1\n  ]\n}',
            '~ state item @ global (scope-1): {\n  "a": [\n    1\n  ]\n} -> {\n  "a": "\\u001b[31mred"\n}',
        ]);
        expect(events[3].segments).toEqual([
            { type: 'text', text: 'item @ global (scope-1): ' },
            { type: 'json', payloadId: `${events[3].id}:0:before:0`, container: 'object', source: '{"a":[1]}', summary: 'object [folded]' },
            { type: 'text', text: ' -> ' },
            { type: 'json', payloadId: `${events[3].id}:0:after:0`, container: 'object', source: '{"a":"\\u001b[31mred"}', summary: 'object [folded]' },
        ]);
    });
});

describe('container mutation observation', () => {
    it('reports every top-level binding whose display changed, including aliases and owners', async () => {
        const { result, states } = await observe(`const items = [1];
const alias = items;
const parent = { child: items };
const copy = [...items];
function change(list) { list[0] = 2; }
change(alias);
parent.child.push(3);
parent.child = [4];
success(items);`);
        expect(result).toMatchObject({ status: 'success', value: [2, 3] });
        const mutations = states.filter(event => event.change.operation === 'mutation');
        expect(changes(mutations)).toEqual([
            'mutation items: [1] -> [2]', 'mutation alias: [1] -> [2]', 'mutation parent: {"child":[1]} -> {"child":[2]}',
            'mutation items: [2] -> [2,3]', 'mutation alias: [2] -> [2,3]', 'mutation parent: {"child":[2]} -> {"child":[2,3]}',
            'mutation parent: {"child":[2,3]} -> {"child":[4]}',
        ]);
        expect(mutations.map(event => event.change.path)).toEqual(['items', 'alias', 'parent', 'items', 'alias', 'parent', 'parent']);
        const initial = states[0].change.bindings[0].next;
        expect(initial).toMatchObject({ valueKind: 'list', display: '[1]' });
        const target = initial.presence === 'value' ? initial.referenceId : undefined;
        expect(target).toMatch(/^ref-\d+$/);
        expect(mutations.map(event => event.change.targetReferenceId === target)).toEqual([true, true, false, true, true, false, false]);
        expect(mutations[0].change.bindings[0].next).toMatchObject({ referenceId: target });
        expect(Object.isFrozen(mutations[0].change.bindings[0].previous)).toBe(true);
    });

    it.each([
        ['items.push(3)', [1, 2, 3]], ['items.splice(1, 0, 9)', [1, 9, 2]], ['items.pop()', [1]], ['items.reverse()', [2, 1]],
        ['items.sort()', [1, 2]], ['items.length = 0', []], ['items[1] = 2', [1, 2]], ['items.fill(0)', [0, 0]],
    ])('observes list %s once only if it changes state', async (statement, expected) => {
        const { result, states } = await observe(`const items = [1, 2];\n${statement};\nsuccess(items);`);
        expect(result).toMatchObject({ status: 'success', value: expected });
        expect(changes(states).slice(1)).toEqual(JSON.stringify(expected) === '[1,2]' ? [] : [`mutation items: [1,2] -> ${JSON.stringify(expected)}`]);
    });

    it.each([['delete item.a', {}], ['Object.assign(item, { b: 2 })', { a: 1, b: 2 }], ['item.a += 1', { a: 2 }], ['item.a = 1', { a: 1 }]])(
        'observes object %s once only if it changes state', async (statement, expected) => {
            const { result, states } = await observe(`const item = { a: 1 };\n${statement};\nsuccess(item);`);
            expect(result).toMatchObject({ status: 'success', value: expected });
            expect(states.filter(event => event.change.operation === 'mutation')).toHaveLength(JSON.stringify(expected) === '{"a":1}' ? 0 : 1);
        },
    );

    it('sees only changes to the displayed shape: opaque collections and private state stay silent', async () => {
        const { result, states } = await observe(`const cache = new Map();
class Counter { #n = 0; label = 'c'; bump() { return ++this.#n; } }
const counter = new Counter();
cache.set('k', counter.bump());
counter.label = 'renamed';
success(cache.size);`);
        expect(result).toMatchObject({ status: 'success', value: 1 });
        expect(changes(states).filter(change => !change.includes('Counter:'))).toEqual([
            'initialize cache: <unbound> -> {}', 'initialize counter: <unbound> -> {"label":"c"}',
            'mutation counter: {"label":"c"} -> {"label":"renamed"}',
        ]);
    });

    it('handles cyclic and shared graphs without rewriting old values', async () => {
        const { result, states } = await observe(`const items = [];
items.push(items);
const root = { child: items };
items.push(1);
success(1);`);
        expect(result).toMatchObject({ status: 'success' });
        expect(names(states)).toEqual(['items', 'items', 'root', 'items', 'root']);
        const reference = states[0].change.bindings[0].next;
        if (reference.presence !== 'value') throw new Error('expected a value');
        expect(changes(states)[1]).toBe(`mutation items: [] -> ["<reference ${reference.referenceId}>"]`);
        expect(changes(states)[4]).toBe(`mutation root: {"child":["<reference ${reference.referenceId}>"]} -> {"child":["<reference ${reference.referenceId}>",1]}`);
        expect(reference).toMatchObject({ display: '[]' });
    });

    it('keeps changes made before a failure or an early success, and preserves the original outcome', async () => {
        const failed = await observe(`const items = [];
function addThenFail() {
    items.push(1);
    throw new Error('partial failure');
}
addThenFail();
items.push(2);`);
        expect(failed.result).toMatchObject({ status: 'failure', failure: { reason: 'Error: partial failure', line: 4, status_code: 'runtime_error' } });
        expect(changes(failed.states).filter(change => !change.includes('addThenFail'))).toEqual(['initialize items: <unbound> -> []', 'mutation items: [] -> [1]']);
        expect(failed.events.at(-1)).toMatchObject({ kind: 'error', origin: 'diagnostic' });
        const finished = await observe('let n = 0;\nconst finish = () => { n = 7; success(n); };\nfinish();\nn = 8;');
        expect(finished.result).toMatchObject({ status: 'success', value: 7 });
        expect(changes(finished.states).filter(change => change.includes(' n:'))).toEqual(['initialize n: <unbound> -> 0', 'rebind n: 0 -> 7']);
    });

    it('never invokes getters, toJSON, custom inspection or proxy traps during observation', async () => {
        const session = new ExecutionSession();
        const { logger, events } = collecting('debug');
        const result = await session.run(parse(`const calls = { getter: 0, json: 0, inspect: 0, trap: 0 };
const foreign = {
    value: 1,
    get secret() { calls.getter++; return 'secret'; },
    toJSON() { calls.json++; throw new Error('serializer ran'); },
    [Symbol.for('nodejs.util.inspect.custom')]() { calls.inspect++; throw new Error('inspector ran'); },
};
const trap = () => { calls.trap++; throw new Error('proxy trap ran'); };
const proxy = new Proxy({}, { ownKeys: trap, get: trap, has: trap, getPrototypeOf: trap, getOwnPropertyDescriptor: trap });
const holder = { proxy };
const alias = foreign;
foreign.value = 2;
success(calls);`), { backend: new NoLlm(), logger });
        expect(result).toMatchObject({ status: 'success', value: { getter: 0, json: 0, inspect: 0, trap: 0 } });
        expect(changes(events).filter(change => change.startsWith('mutation'))).toEqual([
            expect.stringMatching(/^mutation foreign: \{"value":1,"secret":"<accessor>","toJSON":"<function toJSON\(\) ref-\d+>"\} -> \{"value":2,/),
            expect.stringMatching(/^mutation alias: \{"value":1,/),
        ]);
        expect(changes(events)).toEqual(expect.arrayContaining(['initialize proxy: <unbound> -> "<proxy>"', 'initialize holder: <unbound> -> {"proxy":"<proxy>"}']));
        expect(JSON.stringify(events)).not.toContain('secret"');
    });
});

describe('agent actions', () => {
    it('reports blockquote saves through the same rules without duplicating actions or dropping response text', async () => {
        const { logger, events } = collecting('debug');
        let turn = 0;
        const result = await execMarkdown('> Save a number.', {
            logger, backend: backend(() => ({
                text: 'actual response', effective: {},
                ...(turn++ < 2 ? { action: action('save_variable', { name: 'answer', value: 42 }) } : {}),
            })),
        });
        expect(result.status).toBe('success');
        expect(changes(events)).toEqual(['initialize answer: <unbound> -> 42']);
        const models = events.filter(event => event.origin === 'model');
        const inputs = models.filter(event => event.kind === 'model-input');
        const outputs = models.filter(event => event.kind === 'model-output');
        expect(inputs).toHaveLength(3);
        expect(models.every(event => event.interaction.kind === 'blockquote')).toBe(true);
        expect(outputs.filter(event => event.interaction.role === 'action')).toHaveLength(2);
        expect(outputs.filter(event => event.interaction.role === 'response')).toHaveLength(3);
        const requestIds = new Set(inputs.map(event => event.interaction.requestId));
        expect(outputs.every(event => requestIds.has(event.interaction.requestId))).toBe(true);
    });

    it('compares bindings after each agent action, right after the action is logged', async () => {
        const { logger, events } = collecting('debug');
        const model = acting(
            action('save_variable', { name: 'answer', value: { score: 1 } }),
            action('load_variable', { name: 'answer' }),
            action('call_function', { name: 'remember', args: ['x'] }),
            action('save_variable', { name: 'answer', value: { score: 1 } }),
            action('save_variable', { name: 'count', value: 2 }),
        );
        const result = await execMarkdown(`${fence('const notes = [];\nlet count = 0;\nfunction remember(note) { count = notes.push(note); return count; }')}

> Remember x, then save @answer and @count

${fence('success([answer, notes, count]);')}`, { logger, backend: model });
        expect(result).toMatchObject({ status: 'success', value: [{ score: 1 }, ['x'], 2] });
        expect(events.map(event => event.kind === 'state' ? changes([event])[0] : event.origin === 'model' ? event.interaction.role ?? 'input' : event.kind)).toEqual([
            'initialize notes: <unbound> -> []', 'initialize remember: <unbound> -> "<function remember(note) ref-2>"', 'initialize count: <unbound> -> 0',
            'input',
            'action', 'initialize answer: <unbound> -> {"score":1}',
            'action',
            'action', 'mutation notes: [] -> ["x"]', 'rebind count: 0 -> 1',
            'action', 'rebind answer: {"score":1} -> {"score":1}',
            'action', 'rebind count: 1 -> 2',
            'info', 'response',
        ]);
    });

    it('reports what a failing action changed before the blockquote stops', async () => {
        const { logger, events } = collecting('debug');
        const result = await execMarkdown(`${fence('const notes = [];\nfunction explode() { notes.push("partial"); fail("stop here"); }')}\n\n> Call @explode`, {
            logger, backend: acting(action('call_function', { name: 'explode', args: [] })),
        });
        expect(result).toMatchObject({ status: 'failure', failure: { status_code: 'explicit_failure', reason: 'stop here' } });
        expect(changes(events).at(-1)).toBe('mutation notes: [] -> ["partial"]');
    });
});

describe('interactive sessions', () => {
    const options = { backend: new NoLlm() };

    it('sends each run to its own logger with stable binding and reference identities', async () => {
        const session = new ExecutionSession();
        const first = collecting('debug');
        await session.run(parse('const items = [];\nlet count = 1;\nfunction bump() { count += 1; items.push(count); }'), { ...options, logger: first.logger });
        expect(names(first.events)).toEqual(['items', 'bump', 'count']);
        const second = collecting('debug');
        await session.run(parse('bump()'), { ...options, logger: second.logger });
        expect(first.events).toHaveLength(3);
        expect(changes(second.events)).toEqual(['mutation items: [] -> [2]', 'rebind count: 1 -> 2']);
        const [original, mutation] = [states(first.events)[0].change, states(second.events)[0].change];
        expect(mutation.bindings[0].binding).toEqual(original.bindings[0].binding);
        expect(mutation.targetReferenceId).toBe(original.bindings[0].next.presence === 'value' ? original.bindings[0].next.referenceId : 'missing');
        const lines: string[] = [];
        await session.run(parse('items.push(3)'), { ...options, logger: new Logger('debug', line => lines.push(line)) });
        expect(lines).toEqual(['~ state items @ global (scope-1): [\n  2\n] -> [\n  2,\n  3\n]']);
    });

    it('reports only what the current run changes, not bindings or changes from unobserved runs', async () => {
        const session = new ExecutionSession();
        await session.run(parse('let n = 1;\nconst list = [1];\nconst untouched = { a: 1 };'), { ...options, logger: silent });
        const quiet = collecting('info');
        await session.run(parse('n = 2;\nlist.push(2);\nlet fresh = 1;'), { ...options, logger: quiet.logger });
        expect(quiet.events).toEqual([]);
        const current = collecting('debug');
        expect(await session.run(parse('n = 3;\nfresh += 1;\nconst added = list.length;\n[n, fresh, added]'), { ...options, logger: current.logger }))
            .toMatchObject({ value: [3, 2, 2] });
        expect(changes(current.events)).toEqual(['rebind n: 2 -> 3', 'rebind fresh: 1 -> 2', 'initialize added: <unbound> -> 2']);
    });

    it('keeps sessions apart: equal names in another session start unbound', async () => {
        const [one, two] = [new ExecutionSession(), new ExecutionSession()];
        const first = collecting('debug');
        const second = collecting('debug');
        await one.run(parse('let shared = 1;'), { ...options, logger: first.logger });
        await two.run(parse('let shared = 2;'), { ...options, logger: second.logger });
        await one.run(parse('shared += 10;'), { ...options, logger: first.logger });
        expect(changes(first.events)).toEqual(['initialize shared: <unbound> -> 1', 'rebind shared: 1 -> 11']);
        expect(changes(second.events)).toEqual(['initialize shared: <unbound> -> 2']);
    });
});
