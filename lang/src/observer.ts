import { types } from 'node:util';
import type { BindingReference, ObservedValue } from './log-events.js';
import type { Logger } from './logger.js';
import { signature } from './runtime.js';
import { isType } from './types.js';

const GLOBAL = { scopeId: 'scope-1', kind: 'global', label: 'global' } as const;

/**
 * Reports changes to a workflow's top-level variables at debug level. JavaScript offers no hook for
 * variable writes, so their values are compared before each top-level statement and when the workflow ends.
 */
export class ScopeObserver {
    private readonly seen = new Map<string, { value: unknown; display: string }>();
    private readonly references = new WeakMap<object, string>();
    private nextReference = 0;

    /** Reports changes since the last call; `silent` only records them, as when a trace replays. */
    flush(logger: Logger, values: Readonly<Record<string, unknown>>, silent = false): void {
        if (!logger.observesState) return;
        for (const [name, value] of Object.entries(values)) {
            const known = this.seen.get(name);
            if (value === undefined && !known) continue;
            const next = this.snapshot(value);
            if (known && Object.is(known.value, value) && known.display === next.display) continue;
            const previous: ObservedValue = known ? this.snapshot(known.value, known.display) : { presence: 'unbound' };
            this.seen.set(name, { value, display: next.display });
            if (silent) continue;
            const mutation = known !== undefined && Object.is(known.value, value);
            const binding: BindingReference = { ...GLOBAL, bindingId: `${GLOBAL.scopeId}:${name}`, name };
            logger.state(() => ({
                operation: !known ? 'initialize' : mutation ? 'mutation' : 'rebind',
                bindings: [{ binding, previous, next }],
                ...(mutation && next.referenceId ? { targetReferenceId: next.referenceId, path: name } : {}),
            }));
        }
    }

    /** Reports an output of a block inside a function or loop, which no top-level variable holds. */
    output(logger: Logger, line: number, name: string, value: unknown): void {
        if (!logger.observesState) return;
        const scopeId = `block-${line}`;
        const binding: BindingReference = { scopeId, kind: 'block', label: `block at line ${line}`, bindingId: `${scopeId}:${name}`, name };
        logger.state(() => ({ operation: 'initialize', bindings: [{ binding, previous: { presence: 'unbound' }, next: this.snapshot(value) }] }));
    }

    private reference(value: object): string {
        let id = this.references.get(value);
        if (!id) {
            id = `ref-${++this.nextReference}`;
            this.references.set(value, id);
        }
        return id;
    }

    private snapshot(value: unknown, display?: string): ObservedValue & { presence: 'value' } {
        const reference = (typeof value === 'object' && value !== null) || typeof value === 'function';
        const valueKind = !reference ? 'scalar' : typeof value === 'function' ? 'callable' : types.isProxy(value) ? 'foreign'
            : Array.isArray(value) ? 'list'
            : Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null ? 'dictionary' : 'foreign';
        return {
            presence: 'value', valueKind, ...(reference ? { referenceId: this.reference(value as object) } : {}),
            display: display ?? (Object.is(value, -0) ? '-0' : value === undefined || typeof value === 'number' && !Number.isFinite(value) ? String(value) : JSON.stringify(this.describe(value, new Set()))),
        };
    }

    private describe(value: unknown, visiting: Set<object>): unknown {
        if (typeof value === 'function') return `<${signature(value)} ${this.reference(value)}>`;
        if (typeof value !== 'object' || value === null) {
            if (typeof value === 'number' && !Number.isFinite(value)) return String(value);
            if (typeof value === 'bigint') return `${value}n`;
            if (typeof value === 'symbol' || value === undefined) return String(value);
            return Object.is(value, -0) ? '<-0>' : value;
        }
        if (types.isProxy(value)) return '<proxy>';
        if (isType(value)) return `<type ${value.name}>`;
        if (visiting.has(value)) return `<reference ${this.reference(value)}>`;
        if (types.isNativeError(value)) return `<Error ${value.message}>`;
        visiting.add(value);
        try {
            if (Array.isArray(value)) return value.map(item => this.describe(item, visiting));
            return Object.fromEntries(Object.entries(Object.getOwnPropertyDescriptors(value))
                .filter(([, descriptor]) => descriptor.enumerable)
                .map(([key, descriptor]) => [key, 'value' in descriptor ? this.describe(descriptor.value, visiting) : '<accessor>']));
        } finally {
            visiting.delete(value);
        }
    }
}
