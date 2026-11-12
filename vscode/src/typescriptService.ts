import * as fs from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';

/** Declaration files shipped with the extension. */
export interface TypeResources {
    /** Folder with TypeScript's `lib.*.d.ts` files. */
    libraries: string;
    /** Folder with the spl-lang declarations: `globals.d.ts` and `dist/*.d.ts`. */
    spl: string;
    /** Fallback type root with Node.js typings, for workspaces without `@types/node`. */
    types: string;
}

/** Resources live next to the server bundle, or one level up from a bundled test. */
export function defaultResources(directory: string): TypeResources {
    const root = fs.existsSync(path.join(directory, 'ts-lib')) ? directory : path.dirname(directory);
    return { libraries: path.join(root, 'ts-lib'), spl: path.join(root, 'spl-types'), types: path.join(root, 'types') };
}

const OWN_MODULES: Record<string, string> = {
    'spl-lang': path.join('dist', 'index.d.ts'),
    'spl-lang/markdown': path.join('dist', 'markdown-lib.d.ts'),
    'spl-lang/globals': 'globals.d.ts',
};

/**
 * One TypeScript language service per working directory. Each workflow contributes a virtual
 * module placed in that directory, so relative imports and `node_modules` resolve the way the
 * runtime resolves them, and the spl-lang globals are part of every program.
 */
export class TypeScriptProject {
    readonly service: ts.LanguageService;
    private readonly virtual = new Map<string, { name: string; text: string; version: number }>();
    private readonly disk = new Map<string, { version: string; checked: number; snapshot?: ts.IScriptSnapshot }>();
    private readonly globals: string;
    private counter = 0;

    constructor(readonly base: string, private readonly resources: TypeResources) {
        this.globals = path.join(resources.spl, 'globals.d.ts');
        const options: ts.CompilerOptions = {
            target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
            allowJs: true, checkJs: false, strict: false, noEmit: true, skipLibCheck: true, esModuleInterop: true,
            resolveJsonModule: true, allowImportingTsExtensions: true, lib: ['lib.esnext.d.ts'],
            types: ['node'], typeRoots: [path.join(base, 'node_modules', '@types'), resources.types],
        };
        const cache = ts.createModuleResolutionCache(base, name => ts.sys.useCaseSensitiveFileNames ? name : name.toLowerCase(), options);
        const host: ts.LanguageServiceHost = {
            getCompilationSettings: () => options,
            getCurrentDirectory: () => base,
            getDefaultLibFileName: () => path.join(resources.libraries, 'lib.d.ts'),
            getScriptFileNames: () => [...[...this.virtual.values()].map(file => file.name), this.globals],
            getScriptVersion: file => this.virtual.get(this.key(file))?.version.toString() ?? this.diskVersion(file),
            getScriptSnapshot: file => {
                const own = this.virtual.get(this.key(file));
                if (own) return ts.ScriptSnapshot.fromString(own.text);
                this.diskVersion(file);
                const entry = this.disk.get(file)!;
                if (!entry.snapshot) {
                    const text = ts.sys.readFile(file);
                    if (text === undefined) return undefined;
                    entry.snapshot = ts.ScriptSnapshot.fromString(text);
                }
                return entry.snapshot;
            },
            fileExists: file => this.virtual.has(this.key(file)) || ts.sys.fileExists(file),
            readFile: (file, encoding) => this.virtual.get(this.key(file))?.text ?? ts.sys.readFile(file, encoding),
            readDirectory: ts.sys.readDirectory,
            directoryExists: ts.sys.directoryExists,
            getDirectories: ts.sys.getDirectories,
            realpath: ts.sys.realpath,
            useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
            resolveModuleNameLiterals: (literals, containingFile, redirected, settings, containingSourceFile) => literals.map(literal => {
                const own = Object.hasOwn(OWN_MODULES, literal.text) ? OWN_MODULES[literal.text] : undefined;
                if (own) {
                    return { resolvedModule: {
                        resolvedFileName: path.join(resources.spl, own), extension: ts.Extension.Dts, isExternalLibraryImport: true,
                    } };
                }
                return ts.resolveModuleName(literal.text, containingFile, settings, host, cache, redirected,
                    ts.getModeForUsageLocation(containingSourceFile, literal, settings));
            }),
        };
        this.service = ts.createLanguageService(host, ts.createDocumentRegistry(ts.sys.useCaseSensitiveFileNames, base));
    }

    private key(file: string): string {
        const normalized = path.normalize(file);
        return ts.sys.useCaseSensitiveFileNames ? normalized : normalized.toLowerCase();
    }

    private diskVersion(file: string): string {
        const now = Date.now();
        let entry = this.disk.get(file);
        if (!entry || now - entry.checked > 1500) {
            const version = ts.sys.getModifiedTime?.(file)?.getTime().toString() ?? '0';
            entry = { version, checked: now, snapshot: entry?.version === version ? entry.snapshot : undefined };
            this.disk.set(file, entry);
        }
        return entry.version;
    }

    /** A new virtual module name in the working directory. */
    allocate(extension: 'mjs' | 'mts'): string {
        return path.join(this.base, `__spl-workflow-${++this.counter}__.${extension}`);
    }

    update(file: string, text: string): void {
        const key = this.key(file);
        const current = this.virtual.get(key);
        if (current?.text !== text) this.virtual.set(key, { name: file, text, version: (current?.version ?? 0) + 1 });
    }

    remove(file: string): void {
        this.virtual.delete(this.key(file));
    }

    owns(file: string): boolean {
        return this.virtual.has(this.key(file));
    }

    /** Whether two names denote the same file; TypeScript may change slashes and letter case. */
    same(a: string, b: string): boolean {
        return this.key(a) === this.key(b);
    }

    /** Line and character of an offset in any file of the program. */
    position(file: string, offset: number): { line: number; character: number } | undefined {
        const source = this.service.getProgram()?.getSourceFile(file);
        return source ? ts.getLineAndCharacterOfPosition(source, Math.min(offset, source.text.length)) : undefined;
    }
}
