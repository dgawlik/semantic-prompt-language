import { describe, expect, it, vi } from 'vitest';
import { run, type RunOptions } from '../src/interpreter.js';
import { Logger } from '../src/logger.js';
import { parse } from '../src/parser.js';
import { parseMarkdown } from '../src/markdown.js';
import type { LogEvent } from '../src/log-events.js';
import { StateObserver } from '../src/state-observer.js';
import type { Env, Value } from '../src/values.js';
import { NoLlm } from './helpers.js';

type StateEvent = Extract<LogEvent, { kind: 'state' }>;
async function observe(source: string, overrides: Partial<RunOptions> = {}) {
    const history: LogEvent[] = [];
    const logger = new Logger('debug', undefined, { eventSink: event => history.push(event) });
    const result = await run(parse(source), { backend: new NoLlm(), ...overrides, logger });
    return { result, history, states: history.filter((event): event is StateEvent => event.kind === 'state') };
}
const names = (events: StateEvent[]) => events.map(event => event.change.bindings.map(delta => delta.binding.name));

describe('binding commit observation', () => {
    it('distinguishes unbound/null, Object.is scalar changes and equal-content reference replacement', async () => {
        const { result, states } = await observe(`let n = None
n = None
n = 0
n = -0
n = -0
let values = [1]
values = values
values = [1]
success n`);
        expect(result).toMatchObject({ status: 'success' });
        expect(names(states)).toEqual([['n'], ['n'], ['n'], ['values'], ['values']]);
        expect(states[0].change.bindings[0]).toMatchObject({ previous: { presence: 'unbound' }, next: { presence: 'value', display: 'null' } });
        expect(states[2].change.bindings[0].next).toMatchObject({ display: '-0' });
        const [initial, replacement] = [states[3].change.bindings[0].next, states[4].change.bindings[0].next];
        expect(initial.presence === 'value' && replacement.presence === 'value' && initial.referenceId !== replacement.referenceId).toBe(true);
    });

    it('attributes enclosing writes and independently identifies shadowed branches, iterations, parameters and handlers', async () => {
        const { result, states } = await observe(`let n = 0
:
    let n = 10
    if True:
        n += 1
for a, b in [[1, 2], [3, 4]]:
    n += a
def recurse(x):
    if x > 0:
        recurse(x - 1)
recurse(2)
try:
    fail 'caught'
except err:
    let reason = err.reason
success n`);
        expect(result).toMatchObject({ status: 'success', value: 4 });
        const deltas = states.flatMap(event => event.change.bindings);
        const n = deltas.filter(delta => delta.binding.name === 'n');
        expect(n[0].binding.scopeId).not.toBe(n[1].binding.scopeId);
        expect(n[1].binding.scopeId).toBe(n[2].binding.scopeId);
        expect(n[3].binding.scopeId).toBe(n[0].binding.scopeId);
        expect(new Set(deltas.filter(delta => delta.binding.name === 'a').map(delta => delta.binding.scopeId)).size).toBe(2);
        expect(new Set(deltas.filter(delta => delta.binding.name === 'x').map(delta => delta.binding.scopeId)).size).toBe(3);
        expect(deltas.find(delta => delta.binding.name === 'err')?.binding.kind).toBe('handler');
        const callable = deltas.find(delta => delta.binding.name === 'recurse')?.next;
        expect(callable).toMatchObject({ presence: 'value', valueKind: 'callable' });
        expect(JSON.stringify(callable)).not.toMatch(/body|closure|recurse\(x - 1\)/);
        expect(states.every(event => event.change.operation !== 'delete')).toBe(true);
    });

    it.each(['error', 'info', 'debug'] as const)('has no automatic read/no-op/source/control-flow logs at %s', async level => {
        const events: LogEvent[] = [];
        const result = await run(parse(`n = n
items.reverse()
if True:
    pass
restrict '.':
    pass
success n`), {
            backend: new NoLlm(), logger: new Logger(level, undefined, { eventSink: event => events.push(event) }),
            store: { load: () => ({ n: 1, items: [1] }), save() {} },
        });
        expect(result).toMatchObject({ status: 'success', value: 1 });
        expect(events).toEqual([]);
    });

    it('reports blockquote saves through the same commit rules without duplicating actions or dropping response text', async () => {
        const history: LogEvent[] = [];
        let turn = 0;
        const result = await run(parseMarkdown('---\nextension: semantic-prompt-language\nversion: 1\n---\n\n> Save a number.'), {
            logger: new Logger('error', undefined, { eventSink: event => history.push(event) }),
            backend: {
                async call() {
                    return { text: 'actual response', effective: {},
                        ...(turn++ < 2 ? { action: { name: 'save_variable', arguments: { name: 'answer', value: 42 } } } : {}) };
                }, async close() {},
            },
        });
        expect(result.status).toBe('success');
        expect(history.filter(event => event.kind === 'state')).toHaveLength(1);
        expect(history.filter(event => event.kind === 'model-input').every(event => event.interaction.kind === 'blockquote')).toBe(true);
        expect(history.filter(event => event.kind === 'model-output' && event.interaction.role === 'action')).toHaveLength(2);
        expect(history.filter(event => event.kind === 'model-output' && event.interaction.role === 'response')).toHaveLength(3);
        const requestIds = new Set(history.filter(event => event.kind === 'model-input').map(event => event.interaction.requestId));
        expect(history.filter(event => event.kind === 'model-output').every(event => requestIds.has(event.interaction.requestId))).toBe(true);
    });
});

describe('logical container mutation observation', () => {
    it('reports aliases and nested owners together once with immutable historical snapshots', async () => {
        const { result, states } = await observe(`let items = [1]
let alias = items
let parent = {'child': items}
alias[0] = 2
parent.child.append(3)
parent.child = [4]
success items`);
        expect(result).toMatchObject({ status: 'success', value: [2, 3] });
        const mutations = states.filter(event => event.change.operation === 'mutation');
        expect(names(mutations)).toEqual([['items', 'alias', 'parent'], ['items', 'alias', 'parent'], ['parent']]);
        expect(mutations[0].change.bindings[0]).toMatchObject({ previous: { display: '[1]' }, next: { display: '[2]' } });
        expect(mutations[1].change.bindings[0]).toMatchObject({ previous: { display: '[2]' }, next: { display: '[2,3]' } });
        expect(states[0].change.bindings[0].next).toMatchObject({ display: '[1]' });
        expect(Object.isFrozen(mutations[0].change.bindings[0].previous)).toBe(true);
    });

    it.each([
        ['append(3)', [1, 2, 3]], ['extend([3,4])', [1, 2, 3, 4]], ['insert(1,9)', [1, 9, 2]],
        ['pop()', [1]], ['remove(1)', [2]], ['reverse()', [2, 1]], ['sort()', [1, 2]], ['clear()', []],
    ])('observes list %s once only if it changes state', async (method, expected) => {
        const { result, states } = await observe(`let items = [1, 2]\nitems.${method}\nsuccess items`);
        expect(result).toMatchObject({ status: 'success', value: expected });
        expect(states.filter(event => event.change.operation === 'mutation')).toHaveLength(method === 'sort()' ? 0 : 1);
    });

    it.each([["pop('a')", {}], ["update({'b':2})", { a: 1, b: 2 }], ['clear()', {}]])(
        'observes dictionary %s once', async (method, expected) => {
            const { result, states } = await observe(`let item = {'a':1}\nitem.${method}\nsuccess item`);
            expect(result).toMatchObject({ status: 'success', value: expected });
            expect(states.filter(event => event.change.operation === 'mutation')).toHaveLength(1);
        },
    );

    it('suppresses empty and same-state writes/methods, but keeps changes that are later restored', async () => {
        const { states } = await observe(`let items = []
items.clear()
items.extend([])
items.reverse()
items.sort()
let d = {}
d.update({})
d.clear()
let n = 0
n = 1
n = 0`);
        expect(names(states)).toEqual([['items'], ['d'], ['n'], ['n'], ['n']]);
    });

    it('discovers active caller aliases, shadowed outer bindings and retained closure scopes', async () => {
        const { result, states } = await observe(`let items = []
def change(items):
    items.append(1)
def caller():
    let caller_alias = items
    change(caller_alias)
caller()
let saved = None
:
    let captured = []
    def update():
        captured.append(2)
    saved = update
saved()
success items`);
        expect(result).toMatchObject({ status: 'success', value: [1] });
        const mutations = states.filter(event => event.change.operation === 'mutation');
        expect(names(mutations)[0]).toEqual(expect.arrayContaining(['items', 'caller_alias', 'items']));
        expect(mutations[0].change.bindings.filter(delta => delta.binding.name === 'items')).toHaveLength(2);
        expect(names(mutations)[1]).toEqual(['captured']);
    });

    it('handles cyclic/shared graphs without closure dumps or rewriting old values', async () => {
        const { result, states } = await observe(`let items = []
items.append(items)
let root = {'child': items}
items.append(1)
success 1`);
        expect(result).toMatchObject({ status: 'success' });
        expect(names(states)).toEqual([['items'], ['items'], ['root'], ['items', 'root']]);
        expect(JSON.stringify(states)).toContain('reference');
        expect(states[0].change.bindings[0].next).toMatchObject({ display: '[]' });
    });

    it('keeps nested RHS/argument commits before outer writes and preserves them on target failure', async () => {
        const { states, result } = await observe(`let n = 0
let items = []
let d = {}
def step():
    n += 1
    return n
items.append(step())
try:
    d.missing += step()
except err:
    pass
success n`);
        expect(result).toMatchObject({ status: 'success', value: 2 });
        const meaningful = states.filter(event => event.change.operation !== 'initialize');
        expect(names(meaningful)).toEqual([['n'], ['items'], ['n']]);
    });

    it('captures partial synchronous mutation before rethrowing the original error', () => {
        const history: LogEvent[] = [];
        const items: Value[] = [];
        const globals: Env = { vars: new Map([['items', items]]) };
        const observer = new StateObserver(globals, new Logger('info', undefined, { eventSink: event => history.push(event) }));
        const error = new Error('partial failure');
        expect(() => observer.mutate(items, globals, 'test', true, () => { items.push(1); throw error; })).toThrow(error);
        expect(history).toHaveLength(1);
        expect(history[0]).toMatchObject({ kind: 'state', change: { operation: 'mutation', bindings: [
            { previous: { display: '[]' }, next: { display: '[1]' } },
        ] } });
    });

    it('never invokes getters, toJSON, custom inspection or proxy traps during observation', async () => {
        const getter = vi.fn(() => 'secret');
        const toJSON = vi.fn(() => { throw new Error('serializer ran'); });
        const custom = vi.fn(() => { throw new Error('inspector ran'); });
        const foreign: { [key: string]: Value } = { value: 1 };
        Object.defineProperty(foreign, 'getter', { get: getter, enumerable: true });
        Object.defineProperty(foreign, 'toJSON', { value: toJSON, enumerable: true });
        Object.defineProperty(foreign, Symbol.for('nodejs.util.inspect.custom'), { value: custom });
        const trap = vi.fn(() => { throw new Error('proxy trap ran'); });
        const proxy = new Proxy({}, { ownKeys: trap, get: trap, getPrototypeOf: trap });
        const { states, result } = await observe('let alias = foreign\nforeign.value = 2\nsuccess 1', {
            store: { load: () => ({ foreign, proxy }), save() {} },
        });
        const globals: Env = { vars: new Map() };
        new StateObserver(globals, new Logger('info', () => {})).commit(globals, 'opaque', proxy, true);
        expect(result).toMatchObject({ status: 'success', value: 1 });
        expect(states.filter(event => event.change.operation === 'mutation')).toHaveLength(1);
        expect(getter).not.toHaveBeenCalled();
        expect(toJSON).not.toHaveBeenCalled();
        expect(custom).not.toHaveBeenCalled();
        expect(trap).not.toHaveBeenCalled();
    });
});
