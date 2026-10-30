import { types } from 'node:util';
import type { Logger } from './logger.js';
import type { BindingDelta, BindingReference, ObservedValue, ScopeKind, ScopeReference } from './log-events.js';
import type { Env, Value } from './values.js';

function data(object: object, key: string): unknown {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

function entries(object: object): [string, unknown][] {
    if (types.isProxy(object)) return [];
    return Object.entries(Object.getOwnPropertyDescriptors(object))
        .filter(([, descriptor]) => descriptor.enumerable)
        .map(([key, descriptor]) => [key, 'value' in descriptor ? descriptor.value : '<accessor>']);
}

function environment(value: unknown): value is Env {
    return typeof value === 'object' && value !== null && !types.isProxy(value) && data(value, 'vars') instanceof Map;
}

function callable(value: object): { name: string; params: string[]; closure?: Env } | undefined {
    if (types.isProxy(value)) return undefined;
    const kind = data(value, '__fn');
    if (kind !== 'user' && kind !== 'builtin' && typeof value !== 'function') return undefined;
    const name = data(value, 'name');
    const params = data(value, 'params');
    const closure = data(value, 'closure');
    return {
        name: typeof name === 'string' ? name : 'anonymous',
        params: Array.isArray(params) ? entries(params).flatMap(([, item]) => typeof item === 'string' ? [item] : []) : [],
        closure: kind === 'user' && environment(closure) ? closure : undefined,
    };
}

/** Weak identities may survive notebook cells; observers and sinks do not. */
export class ObservationIdentities {
    readonly scopes = new WeakMap<Env, ScopeReference>();
    readonly references = new WeakMap<object, string>();
    nextScope = 0;
    nextReference = 0;
}

export class StateObserver {
    private readonly active = new Map<Env, number>();

    constructor(
        private readonly globals: Env,
        private readonly logger: Logger,
        private readonly identities = new ObservationIdentities(),
    ) {
        this.scope(globals, 'global', 'global');
    }

    scope(env: Env, kind: ScopeKind = 'retained', label: string = kind): ScopeReference {
        let scope = this.identities.scopes.get(env);
        if (!scope) {
            const parent = data(env, 'parent');
            scope = {
                scopeId: `scope-${++this.identities.nextScope}`, kind, label,
                ...(environment(parent) ? { parentId: this.scope(parent).scopeId } : {}),
            };
            this.identities.scopes.set(env, scope);
        }
        return scope;
    }

    enter(env: Env): () => void {
        this.active.set(env, (this.active.get(env) ?? 0) + 1);
        return () => {
            const count = this.active.get(env)! - 1;
            if (count) this.active.set(env, count);
            else this.active.delete(env);
        };
    }

    commit(env: Env, name: string, value: Value, emit: boolean): void {
        const present = env.vars.has(name);
        const old = env.vars.get(name);
        if (!emit || !this.logger.observesState || (present && Object.is(old, value))) {
            env.vars.set(name, value);
            return;
        }
        const previous: ObservedValue = present ? this.snapshot(old) : { presence: 'unbound' };
        env.vars.set(name, value);
        this.logger.state(() => ({
            operation: present ? 'rebind' : 'initialize',
            bindings: [{ binding: this.binding(env, name), previous, next: this.snapshot(value) }],
        }));
    }

    mutate<T>(target: object, env: Env, path: string, emit: boolean, perform: () => T): T {
        if (!emit || !this.logger.observesState || types.isProxy(target)) return perform();
        const bindings: { env: Env; name: string; value: Value; previous: ObservedValue }[] = [];
        for (const scope of this.discover(env)) {
            for (const [name, value] of scope.vars) {
                if (this.contains(value, target)) bindings.push({ env: scope, name, value, previous: this.snapshot(value) });
            }
        }
        if (!bindings.length) return perform();
        const members = (): [string, unknown][] => {
            const values = entries(target);
            if (Array.isArray(target)) values.push(['length', target.length]);
            return values;
        };
        const before = members();
        try {
            return perform();
        } finally {
            const after = members();
            if (before.length !== after.length || before.some(([key, value], index) =>
                key !== after[index][0] || !Object.is(value, after[index][1]))) {
                const deltas = bindings.map(({ env, name, value, previous }): BindingDelta =>
                    ({ binding: this.binding(env, name), previous, next: this.snapshot(value) }));
                const [first, ...rest] = deltas;
                this.logger.state(() => ({
                    operation: 'mutation', bindings: [first, ...rest], targetReferenceId: this.reference(target), path,
                }));
            }
        }
    }

    private binding(env: Env, name: string): BindingReference {
        const scope = this.scope(env);
        return { ...scope, bindingId: `${scope.scopeId}:${name}`, name };
    }

    private reference(value: object): string {
        let id = this.identities.references.get(value);
        if (!id) { id = `ref-${++this.identities.nextReference}`; this.identities.references.set(value, id); }
        return id;
    }

    private snapshot(value: unknown): ObservedValue {
        const reference = (typeof value === 'object' && value !== null) || typeof value === 'function';
        const fn = reference && callable(value);
        const valueKind = !reference ? 'scalar' : fn ? 'callable' : types.isProxy(value) ? 'foreign'
            : Array.isArray(value) ? 'list' : Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null ? 'dictionary' : 'foreign';
        return {
            presence: 'value', valueKind, ...(reference ? { referenceId: this.reference(value) } : {}),
            display: Object.is(value, -0) ? '-0' : JSON.stringify(this.describe(value, new Set())),
        };
    }

    private describe(value: unknown, visiting: Set<object>): unknown {
        if ((typeof value !== 'object' || value === null) && typeof value !== 'function') {
            if (typeof value === 'number' && !Number.isFinite(value)) return String(value);
            if (typeof value === 'bigint') return `${value}n`;
            if (typeof value === 'symbol' || value === undefined) return String(value);
            return Object.is(value, -0) ? '<-0>' : value;
        }
        if (types.isProxy(value)) return '<proxy>';
        const fn = callable(value);
        if (fn) return `<function ${fn.name}(${fn.params.join(', ')}) ${this.reference(value)}>`;
        if (visiting.has(value)) return `<reference ${this.reference(value)}>`;
        if (types.isNativeError(value)) return `<Error ${String(data(value, 'message') ?? '')}>`;
        visiting.add(value);
        const result = Array.isArray(value)
            ? Array.from({ length: value.length }, (_, index) => {
                const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
                return descriptor && 'value' in descriptor ? this.describe(descriptor.value, visiting) : '<accessor or empty>';
            })
            : Object.fromEntries(entries(value).map(([key, child]) => [key, this.describe(child, visiting)]));
        visiting.delete(value);
        return result;
    }

    private discover(operation: Env): Env[] {
        const scopes: Env[] = [];
        const seenScopes = new Set<Env>();
        const seenValues = new Set<object>();
        const walkValue = (value: unknown): void => {
            if ((typeof value !== 'object' || value === null) && typeof value !== 'function') return;
            if (seenValues.has(value) || types.isProxy(value)) return;
            seenValues.add(value);
            const fn = callable(value);
            if (fn) { if (fn.closure) walkScope(fn.closure); return; }
            for (const [, child] of entries(value)) walkValue(child);
        };
        const walkScope = (env: Env): void => {
            if (seenScopes.has(env)) return;
            seenScopes.add(env);
            scopes.push(env);
            const parent = data(env, 'parent');
            if (environment(parent)) walkScope(parent);
            for (const value of env.vars.values()) walkValue(value);
        };
        walkScope(this.globals);
        for (const env of this.active.keys()) walkScope(env);
        walkScope(operation);
        return scopes;
    }

    private contains(value: unknown, target: object, seen = new Set<object>()): boolean {
        if (value === target) return true;
        if ((typeof value !== 'object' || value === null) && typeof value !== 'function') return false;
        if (seen.has(value) || types.isProxy(value) || callable(value)) return false;
        seen.add(value);
        return entries(value).some(([, child]) => this.contains(child, target, seen));
    }
}
