/** Optional initial bindings and snapshots for embedded callers, not CLI persistence. */
export interface VariableStore {
    load(): Record<string, unknown>;
    save(vars: Record<string, unknown>): void;
}

export class MemoryStore implements VariableStore {
    load(): Record<string, unknown> { return {}; }
    save(): void {}
}
