import * as fs from 'node:fs';
import * as nodeModule from 'node:module';
import { fileURLToPath } from 'node:url';
import { compile } from './compile.js';
import { SplSyntaxError } from './errors.js';

interface ResolveContext { parentURL?: string; [key: string]: unknown }
type Resolve = (specifier: string, context: ResolveContext) => { url: string; shortCircuit?: boolean; format?: string };
type Load = (url: string, context: unknown) => { format: string; source?: string; shortCircuit?: boolean };
// Typed here because older Node.js typings, as used by editor hosts, do not declare it yet.
const { registerHooks } = nodeModule as unknown as {
    registerHooks(hooks: {
        resolve(specifier: string, context: ResolveContext, nextResolve: Resolve): ReturnType<Resolve>;
        load(url: string, context: unknown, nextLoad: Load): ReturnType<Load>;
    }): void;
};

/** A loaded source that may appear in stack traces. */
export interface SourceInfo {
    /** Read from the file when a failure needs them. */
    lines?: readonly string[];
    /** Frames past this line are module-level code of a `.spl` file, kept this many lines below its source. */
    pageOffset?: number;
    /** Columns of generated code before the source on line 1. */
    header?: number;
}

interface LoaderState {
    /** The running package by specifier: workflows and their helper modules must share this copy. */
    modules: Record<string, Record<string, unknown>>;
    /** Workflow library names, imported into each `.spl` module that uses them. */
    library: readonly string[];
    /** Sources given as text, by URL, instead of read from disk. */
    virtual: Map<string, string>;
    sources: Map<string, SourceInfo>;
    instrument: boolean;
    registered: boolean;
}

// One state per process, even when a bundle or test runner loads a second copy of the package.
const STATE = Symbol.for('spl-lang.loader');
const holder = globalThis as { [STATE]?: LoaderState };
const state: LoaderState = holder[STATE] ??= {
    modules: {}, library: [], virtual: new Map(), sources: new Map(), instrument: false, registered: false,
};
const RUNNING = 'spl-lang-running:';

export const sources: Map<string, SourceInfo> = state.sources;

/** Makes the running package importable by name and names the library a workflow gets without importing it. */
export function provideLibrary(modules: Record<string, Record<string, unknown>>, library: readonly string[]): void {
    if (Object.keys(state.modules).length) return;
    state.modules = modules;
    state.library = library;
}

function register(): void {
    if (state.registered) return;
    state.registered = true;
    registerHooks({
        resolve(specifier, context, nextResolve) {
            if (Object.hasOwn(state.modules, specifier)) return { url: RUNNING + specifier, shortCircuit: true };
            if (state.virtual.has(specifier)) return { url: specifier, format: 'module', shortCircuit: true };
            return nextResolve(specifier, context);
        },
        load(url, context, nextLoad) {
            if (url.startsWith(RUNNING)) {
                const name = url.slice(RUNNING.length);
                const exported = Object.keys(state.modules[name]).filter(key => key !== 'default' && /^[A-Za-z_$][\w$]*$/.test(key));
                return {
                    format: 'module', shortCircuit: true,
                    source: `const running = globalThis[Symbol.for('spl-lang.loader')].modules[${JSON.stringify(name)}];\n`
                        + `export const { ${exported.join(', ')} } = running;\n`,
                };
            }
            if (!/\.spl(?:\?|$)/.test(url)) return nextLoad(url, context);
            const text = state.virtual.get(url) ?? fs.readFileSync(fileURLToPath(url), 'utf8');
            try {
                const compiled = compile(text);
                const { code, header } = compiled.module({ library: state.library, instrument: state.instrument });
                state.sources.set(url, { lines: compiled.scan.lines, pageOffset: compiled.pageOffset, header });
                return { format: 'module', shortCircuit: true, source: code };
            } catch (error) {
                if (error instanceof SplSyntaxError && !state.virtual.has(url)) error.file = fileURLToPath(url);
                throw error;
            }
        },
    });
}

type NativeImport = (specifier: string) => Promise<Record<string, unknown>>;
let native: Promise<NativeImport> | undefined;

/** Node's own import(), taken from a real module so bundlers and test runners cannot rewrite it. */
function nativeImport(): Promise<NativeImport> {
    const source = 'data:text/javascript,export default specifier => import(specifier);';
    return native ??= (import(source) as Promise<{ default: NativeImport }>).then(module => module.default);
}

/**
 * Imports a `.spl` module, compiling it and any `.spl` file it imports on the way. With `source`, the text
 * stands in for the file at `url`. `instrument` adds state reports and `--debug` stops to modules loaded now.
 */
export async function importWorkflow(url: string, options: { source?: string; instrument?: boolean } = {}): Promise<Record<string, unknown>> {
    register();
    state.instrument = Boolean(options.instrument);
    if (options.source !== undefined) state.virtual.set(url, options.source);
    try {
        return await (await nativeImport())(url);
    } finally {
        state.virtual.delete(url);
    }
}
