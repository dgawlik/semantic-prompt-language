import * as fs from 'node:fs';
import * as path from 'node:path';
import * as nodeModule from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

interface ResolveContext { parentURL?: string; [key: string]: unknown }
type Resolve = (specifier: string, context: ResolveContext) => { url: string; shortCircuit?: boolean };
type Load = (url: string, context: unknown) => { format: string; source?: string; shortCircuit?: boolean };
// Typed here because older Node.js typings, as used by editor hosts, do not declare it yet.
const { registerHooks } = nodeModule as unknown as {
    registerHooks(hooks: {
        resolve(specifier: string, context: ResolveContext, nextResolve: Resolve): ReturnType<Resolve>;
        load(url: string, context: unknown, nextLoad: Load): ReturnType<Load>;
    }): void;
};

const PREFIX = 'spl-workflow-import:';
const RUNNING = 'spl-lang-running:';
// The modules of the running package, shared across copies: helpers that import `spl-lang`
// must get this runtime, whether it runs from files, a bundle or a test runner.
const MODULES = Symbol.for('spl-lang.modules');
const holder = globalThis as { [MODULES]?: Record<string, Record<string, unknown>> };
let registered = false;

/** Makes the running package importable by name from workflow code and its helper modules. */
export function provideModules(modules: Record<string, Record<string, unknown>>): void {
    holder[MODULES] ??= modules;
}

function register(): void {
    if (registered) return;
    registered = true;
    registerHooks({
        resolve(specifier, context, nextResolve) {
            if (specifier.startsWith(PREFIX)) {
                const { base, target } = JSON.parse(decodeURIComponent(specifier.slice(PREFIX.length))) as { base: string; target: string };
                specifier = target;
                context = { ...context, parentURL: base };
            }
            if (holder[MODULES] && Object.hasOwn(holder[MODULES], specifier)) return { url: RUNNING + specifier, shortCircuit: true };
            return nextResolve(specifier, context);
        },
        load(url, context, nextLoad) {
            if (!url.startsWith(RUNNING)) return nextLoad(url, context);
            const name = url.slice(RUNNING.length);
            const exported = Object.keys(holder[MODULES]![name]).filter(key => key !== 'default' && /^[A-Za-z_$][\w$]*$/.test(key));
            return {
                format: 'module', shortCircuit: true,
                source: `const running = globalThis[Symbol.for('spl-lang.modules')][${JSON.stringify(name)}];\n`
                    + `export const { ${exported.join(', ')} } = running;\n`,
            };
        },
    });
}
type NativeImport = (specifier: string, options?: unknown) => Promise<Record<string, unknown>>;
let native: Promise<NativeImport> | undefined;

/** Node's own import(), taken from a real module so bundlers and test runners cannot rewrite it. */
function nativeImport(): Promise<NativeImport> {
    const source = 'data:text/javascript,export default (specifier, options) => import(specifier, options);';
    return native ??= (import(source) as Promise<{ default: NativeImport }>).then(module => module.default);
}

/**
 * Imports a module the way a file in `directory` would: relative paths, packages in its
 * `node_modules`, Node.js built-ins, `.js`/`.mjs`/`.cjs`/`.json` and erasable `.ts` files.
 */
export async function importFrom(directory: string, specifier: string, options?: unknown): Promise<Record<string, unknown>> {
    if (typeof specifier !== 'string') specifier = String(specifier);
    register();
    const base = pathToFileURL(path.join(directory, '[workflow]')).href;
    return (await nativeImport())(PREFIX + encodeURIComponent(JSON.stringify({ base, target: specifier })), options);
}

/** Checks a static import without running it; only relative and absolute file paths are verified. */
export function missingImport(directory: string, specifier: string): string | undefined {
    if (!/^\.{1,2}[\\/]/.test(specifier) && !path.isAbsolute(specifier) && !specifier.startsWith('file:')) return undefined;
    const file = specifier.startsWith('file:') ? fileURLToPath(specifier) : path.resolve(directory, specifier);
    return fs.existsSync(file) ? undefined : file;
}
