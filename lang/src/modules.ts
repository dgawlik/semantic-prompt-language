import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ImportStmt, Program } from './ast.js';
import { Failure, SplSyntaxError } from './errors.js';
import { parse } from './parser.js';
import { Restrictions } from './restrict.js';
import { bindingValue, newDict, type Env, type Value } from './values.js';

export interface ModuleFile {
    path: string;
    id: string;
    source: string;
    standard?: string;
}

export interface ModuleSources {
    directory: string;
    files: ModuleFile[];
}

export interface LoadedModule {
    id: string;
    program: Program;
    exports: string[];
    globals?: Env;
}

export interface ModuleGraph {
    imports: Map<ImportStmt, LoadedModule>;
    modules: Map<string, LoadedModule>;
}

export interface RuntimeModule {
    env: Env;
    namespace: Record<string, Value>;
    initialized: boolean;
}

const key = (file: string): string => process.platform === 'win32' ? file.toLowerCase() : file;
const standardModules = new Map([
    ['markdown', path.join(import.meta.dirname, 'stdlib', 'markdown.spl')],
]);
const namespaces = new WeakMap<object, { env: Env; names: string[] }>();

export function namespaceBindings(value: object): { env: Env; names: string[] } | undefined {
    return namespaces.get(value);
}

export function createNamespace(env: Env, names: string[]): Record<string, Value> {
    const namespace = newDict();
    for (const name of names) Object.defineProperty(namespace, name, {
        enumerable: true, get: () => bindingValue(env, name),
    });
    namespaces.set(namespace, { env, names });
    return Object.freeze(namespace);
}

export function moduleDirectory(source: string | undefined, cwd: string): string {
    if (!source) return cwd;
    if (source.startsWith('file:') || source.startsWith('vscode-notebook-cell:')) {
        try {
            const uri = new URL(source);
            if (uri.protocol === 'file:') return path.dirname(fileURLToPath(uri));
            if (uri.pathname.startsWith('/')) return path.dirname(fileURLToPath(`file://${uri.host}${uri.pathname}`));
        } catch (error) {
            if (!(error instanceof Error)) throw error;
            throw new Failure('runtime_error', `cannot resolve module source '${source}': ${error.message}`);
        }
    }
    if (path.isAbsolute(source)) return path.dirname(source);
    if (/^[A-Za-z][A-Za-z\d+.-]*:/.test(source)) return cwd;
    return path.dirname(path.resolve(cwd, source));
}

export function importBindings(stmt: ImportStmt): string[] {
    return stmt.namespace ? [stmt.namespace] : stmt.bindings.map(binding => binding.local);
}

function exportedNames(program: Program): string[] {
    return program.body.flatMap(stmt => {
        if (stmt.t === 'import') return importBindings(stmt);
        return ['let', 'def', 'enum', 'type-alias', 'struct', 'class'].includes(stmt.t) && 'name' in stmt ? [stmt.name] : [];
    });
}

function importPath(stmt: ImportStmt, directory: string, known: readonly ModuleFile[]): string {
    const standard = standardModules.get(stmt.specifier);
    if (standard) return known.find(file => file.standard === stmt.specifier)?.path ?? standard;
    if (!/^\.\.?[\\/]/.test(stmt.specifier) || !/\.spl$/i.test(stmt.specifier) || stmt.specifier.includes('\0')) {
        throw new Failure('runtime_error', `import path '${stmt.specifier}' must name a standard library module or be a relative .spl file path`);
    }
    return path.resolve(directory, stmt.specifier);
}

function moduleProgram(file: ModuleFile): Program {
    try {
        const program = parse(file.source.replace(/^\uFEFF/, ''));
        if (program.directives.model !== undefined) {
            throw new Failure('runtime_error', 'SPL modules use the importing workflow model; module directives are not supported');
        }
        return program;
    } catch (error) {
        if (error instanceof SplSyntaxError) {
            throw new Failure('runtime_error', error.format(file.id))
                .locate(error.line, file.source.split(/\r?\n/)[error.line - 1]?.trim() ?? '', file.id);
        }
        if (error instanceof Failure) error.source ??= file.id;
        throw error;
    }
}

function locateImport(error: unknown, stmt: ImportStmt, program: Program, source?: string): never {
    if (error instanceof Failure) throw error.locate(stmt.line, program.lines[stmt.line - 1]?.trim() ?? '', source);
    throw error;
}

/** Reads the complete dependency graph without executing any SPL or calling a model. */
export function readModuleSources(
    program: Program, directory: string, known: readonly ModuleFile[] = [], source?: string,
): ModuleSources {
    const files = new Map<string, ModuleFile>();
    const cached = new Map(known.map(file => [key(file.path), file]));
    const identities = new Map(known.map(file => [key(file.id), file.source]));
    const visited = new Set<string>();
    const restrictions = new Restrictions(directory);
    const visit = (program: Program, directory: string, source?: string): void => {
        for (const stmt of program.body) {
            if (stmt.t !== 'import') continue;
            try {
                const requested = importPath(stmt, directory, known);
                let file = cached.get(key(requested));
                if (!file) {
                    const standard = standardModules.has(stmt.specifier) ? stmt.specifier : undefined;
                    const id = standard ? requested : restrictions.checkPath(requested);
                    let text = identities.get(key(id));
                    if (text === undefined) {
                        try { text = fs.readFileSync(id, 'utf8'); }
                        catch (error) {
                            if (!(error instanceof Error)) throw error;
                            throw new Failure('runtime_error', `cannot import '${stmt.specifier}': ${error.message}`);
                        }
                        identities.set(key(id), text);
                    }
                    file = { path: requested, id, source: text, ...(standard ? { standard } : {}) };
                }
                files.set(key(requested), file);
                if (visited.has(key(file.id))) continue;
                visited.add(key(file.id));
                visit(moduleProgram(file), path.dirname(file.id), file.id);
            } catch (error) { locateImport(error, stmt, program, source); }
        }
    };
    visit(program, directory, source);
    return { directory, files: [...files.values()] };
}

export function isModuleSources(value: unknown): value is ModuleSources {
    if (typeof value !== 'object' || value === null || !('directory' in value) || typeof value.directory !== 'string'
        || !('files' in value) || !Array.isArray(value.files)) return false;
    return path.isAbsolute(value.directory) && value.files.every(file =>
        typeof file === 'object' && file !== null
        && typeof file.path === 'string' && path.isAbsolute(file.path)
        && typeof file.id === 'string' && path.isAbsolute(file.id)
        && typeof file.source === 'string'
        && (file.standard === undefined || typeof file.standard === 'string' && standardModules.has(file.standard)));
}

/** Links only recorded sources when replaying; no filesystem access is needed. */
export function linkModules(program: Program, sources: ModuleSources, source?: string): ModuleGraph {
    const files = new Map(sources.files.map(file => [key(file.path), file]));
    const graph: ModuleGraph = { imports: new Map(), modules: new Map() };
    const active: string[] = [];
    const visit = (program: Program, directory: string, source?: string): void => {
        for (const stmt of program.body) {
            if (stmt.t !== 'import') continue;
            try {
                const requested = importPath(stmt, directory, sources.files);
                const file = files.get(key(requested));
                if (!file) throw new Failure('runtime_error', `missing module source for '${stmt.specifier}'`);
                const id = key(file.id);
                if (active.includes(id)) throw new Failure('runtime_error', `circular import: ${[...active, id].join(' -> ')}`);
                let module = graph.modules.get(id);
                if (!module) {
                    module = { id: file.id, program: moduleProgram(file), exports: [] };
                    module.exports = exportedNames(module.program);
                    graph.modules.set(id, module);
                    active.push(id);
                    visit(module.program, path.dirname(file.id), file.id);
                    active.pop();
                }
                for (const binding of stmt.bindings) if (!module.exports.includes(binding.imported)) {
                    throw new Failure('runtime_error', `module '${stmt.specifier}' has no export '${binding.imported}'`);
                }
                graph.imports.set(stmt, module);
            } catch (error) { locateImport(error, stmt, program, source); }
        }
    };
    visit(program, sources.directory, source);
    return graph;
}

export function loadModules(program: Program, source?: string, cwd = process.cwd()): ModuleGraph {
    if (!program.body.some(stmt => stmt.t === 'import')) return { imports: new Map(), modules: new Map() };
    return linkModules(program, readModuleSources(program, moduleDirectory(source, cwd), [], source), source);
}
