import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fromJson, isFunction, toJson, type Value } from './values.js';

/** Pluggable persistence for top-level variables. */
export interface VariableStore {
    /** Variables persisted by a previous run; they seed the global scope. */
    load(): Record<string, Value>;
    /** Persists a snapshot of all top-level variables. */
    save(vars: Record<string, Value>): void;
}

export class MemoryStore implements VariableStore {
    load(): Record<string, Value> {
        return {};
    }
    save(): void {}
}

export class JsonFileStore implements VariableStore {
    constructor(private readonly file: string) {}

    load(): Record<string, Value> {
        if (!fs.existsSync(this.file)) return {};
        const raw = fs.readFileSync(this.file, 'utf8');
        if (raw.trim() === '') return {};
        const parsed = JSON.parse(raw) as unknown;
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            throw new Error(`variable store '${this.file}' must contain a JSON object`);
        }
        const out: Record<string, Value> = {};
        for (const [k, v] of Object.entries(parsed)) out[k] = fromJson(v);
        return out;
    }

    save(vars: Record<string, Value>): void {
        const data: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(vars)) if (!isFunction(v)) data[k] = toJson(v);
        fs.mkdirSync(path.dirname(path.resolve(this.file)), { recursive: true });
        const tmp = `${this.file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
        fs.renameSync(tmp, this.file);
    }
}

/** Loads a custom store from a module exporting `createStore(): VariableStore` (or a default export of the same shape). */
export async function loadStoreModule(spec: string): Promise<VariableStore> {
    const url = spec.startsWith('.') || path.isAbsolute(spec) ? pathToFileURL(path.resolve(spec)).href : spec;
    const mod = (await import(url)) as { createStore?: () => VariableStore | Promise<VariableStore>; default?: unknown };
    const factory = mod.createStore ?? (typeof mod.default === 'function' ? (mod.default as () => VariableStore) : undefined);
    const store = factory ? await factory() : (mod.default as VariableStore | undefined);
    if (!store || typeof store.load !== 'function' || typeof store.save !== 'function') {
        throw new Error(`store module '${spec}' must export createStore() returning { load(), save() }`);
    }
    return store;
}
