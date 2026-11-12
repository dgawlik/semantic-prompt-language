import * as path from 'node:path';
import * as vm from 'node:vm';
import { pathToFileURL } from 'node:url';
import type { CompiledCell } from './cell.js';
import { importFrom } from './imports.js';
import { ScopeObserver } from './observer.js';
import type { Runtime, SourceInfo } from './runtime.js';

const HEADER = '"use strict"; return (async () => { ';

/**
 * The shared top-level scope of a document or interactive session. Fences read and write its
 * bindings as ordinary variables; blockquote agents reach the same bindings through tools.
 */
export class Workspace {
    /** Bindings declared by fences, saved by agents or generated with codegen. */
    readonly scope: Record<string, unknown> = Object.create(null);
    /** The pre-imported library; scope bindings shadow it. */
    readonly globals: Record<string, unknown> = Object.create(null);
    /** Names bound by `import`, with the module they came from. */
    readonly imports = new Map<string, string>();
    /** Every source run in this scope, by engine file name: functions outlive the cell that defined them. */
    readonly sources = new Map<string, SourceInfo>();
    private readonly observer = new ScopeObserver(this.scope, this.imports);

    constructor(library: Record<string, unknown>) {
        Object.assign(this.globals, library);
    }

    /** Points `args` and `env` at the runtime of the current run. */
    bind(runtime: Runtime): void {
        this.globals.args = runtime.args;
        this.globals.env = runtime.env;
        this.observer.baseline(runtime.logger);
    }

    has(name: string): boolean {
        return name in this.scope || name in this.globals;
    }

    get(name: string): unknown {
        return name in this.scope ? this.scope[name] : this.globals[name];
    }

    observe(runtime: Runtime): void {
        this.observer.flush(runtime.logger, runtime.replaying);
    }

    /** Runs one compiled fence; resolves to the value of its final expression. */
    async execute(cell: CompiledCell, file: string, runtime: Runtime): Promise<unknown> {
        for (const declaration of cell.declarations) {
            if (declaration.kind === 'import') {
                this.imports.set(declaration.name, declaration.from ?? '');
                continue;
            }
            this.imports.delete(declaration.name);
            // Declarations become assignments, so the name must exist and must not be a read-only import.
            const existing = Object.getOwnPropertyDescriptor(this.scope, declaration.name);
            if (!existing || existing.get) {
                Object.defineProperty(this.scope, declaration.name, { value: undefined, writable: true, enumerable: true, configurable: true });
            }
        }
        const bind = (module: Record<string, unknown>, pairs: [string, string][]): void => {
            for (const [local, imported] of pairs) {
                Object.defineProperty(this.scope, local, {
                    get: imported === '*' ? () => module : () => module[imported], enumerable: true, configurable: true,
                });
            }
        };
        const run = vm.compileFunction(`${HEADER}${cell.code}\n})()`, ['__spl'], {
            filename: file, lineOffset: cell.line - 1, columnOffset: -HEADER.length,
            contextExtensions: [this.globals, this.scope],
        }) as (internals: unknown) => Promise<unknown>;
        // Failures are located through stack traces; the default ten frames lose the fence behind deep helper calls.
        if (Error.stackTraceLimit < 100) Error.stackTraceLimit = 100;
        const location = path.isAbsolute(file) ? file : path.join(runtime.cwd, 'workflow.md');
        try {
            return await run({
                scope: this.scope, bind,
                import: async (specifier: string, options?: unknown) => {
                    // Loader errors carry no workflow frames; remember where the import was written.
                    const site = runtime.locate(new Error());
                    try {
                        return await importFrom(runtime.cwd, specifier, options);
                    } catch (error) {
                        throw runtime.failure(error, site);
                    }
                },
                tick: () => this.observer.flush(runtime.logger, runtime.replaying),
                meta: Object.freeze({ url: pathToFileURL(location).href, filename: location, dirname: path.dirname(location) }),
            });
        } finally {
            this.observer.flush(runtime.logger, runtime.replaying);
        }
    }
}
