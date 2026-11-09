import type { Value } from './values.js';

/** Optional initial bindings and snapshots for embedded callers, not CLI persistence. */
export interface VariableStore {
    load(): Record<string, Value>;
    save(vars: Record<string, Value>): void;
}

export class MemoryStore implements VariableStore {
    load(): Record<string, Value> { return {}; }
    save(): void {}
}
