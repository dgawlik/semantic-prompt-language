import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import type { Location } from 'vscode-languageserver/node';
import { CHECK_OPTIONS } from '../../lang/src/scanner.js';
import { Workflow } from './workflow';

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
/** A `.spl` file is known to TypeScript as the module beside it, as in `spl check`: `flow.spl` is `flow.spl.ts`. */
const MODULE = '.spl.ts';
const splSource = (file: string): string | undefined => file.endsWith(MODULE) ? file.slice(0, -'.ts'.length) : undefined;

interface DiskFile {
    version: string;
    checked: number;
    snapshot?: ts.IScriptSnapshot;
    workflow?: Workflow;
}

/**
 * The TypeScript language service of the workspace. Every `.spl` file is a virtual module made by the
 * scanner: open documents from the editor's text, files they import from disk. The modules are checked
 * the way `spl check` checks them, with the spl-lang globals in every program.
 */
export class TypeScriptProject {
    readonly service: ts.LanguageService;
    private readonly open = new Map<string, { file: string; version: number; workflow: Workflow }>();
    private readonly disk = new Map<string, DiskFile>();
    private readonly globals: string;
    private versions = 0;

    constructor(private readonly base: string, resources: TypeResources) {
        this.globals = path.join(resources.spl, 'globals.d.ts');
        const options: ts.CompilerOptions = {
            ...ts.convertCompilerOptionsFromJson(CHECK_OPTIONS, base).options,
            typeRoots: [path.join(base, 'node_modules', '@types'), resources.types],
        };
        const host: ts.LanguageServiceHost = {
            getCompilationSettings: () => options,
            getCurrentDirectory: () => base,
            getDefaultLibFileName: () => path.join(resources.libraries, 'lib.d.ts'),
            getScriptFileNames: () => [...[...this.open.values()].map(item => item.file), this.globals],
            getScriptVersion: file => this.open.get(this.key(file))?.version.toString() ?? this.stat(file).version,
            getScriptSnapshot: file => {
                const open = this.open.get(this.key(file));
                if (open) return ts.ScriptSnapshot.fromString(open.workflow.text);
                const entry = this.stat(file);
                if (!entry.snapshot) {
                    const text = this.read(file);
                    if (text === undefined) return undefined;
                    entry.snapshot = ts.ScriptSnapshot.fromString(text);
                }
                return entry.snapshot;
            },
            fileExists: file => this.open.has(this.key(file)) || ts.sys.fileExists(splSource(file) ?? file),
            readFile: file => this.open.get(this.key(file))?.workflow.text ?? this.read(file),
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
                return ts.resolveModuleName(literal.text, containingFile, settings, host, undefined, redirected,
                    ts.getModeForUsageLocation(containingSourceFile, literal, settings));
            }),
        };
        this.service = ts.createLanguageService(host, ts.createDocumentRegistry(ts.sys.useCaseSensitiveFileNames, base));
    }

    /** TypeScript may change the slashes and the letter case of a file name. */
    private key(file: string): string {
        const normalized = path.normalize(file);
        return ts.sys.useCaseSensitiveFileNames ? normalized : normalized.toLowerCase();
    }

    /** The state of a file on disk, looked up at most every 1.5 seconds; a `.spl` module follows its source. */
    private stat(file: string): DiskFile {
        const key = this.key(file);
        const now = Date.now();
        let entry = this.disk.get(key);
        if (!entry || now - entry.checked > 1500) {
            const version = ts.sys.getModifiedTime?.(splSource(file) ?? file)?.getTime().toString() ?? '0';
            entry = { version, checked: now, ...(entry?.version === version ? { snapshot: entry.snapshot, workflow: entry.workflow } : {}) };
            this.disk.set(key, entry);
        }
        return entry;
    }

    private read(file: string): string | undefined {
        return splSource(file) ? this.workflow(file)?.text : ts.sys.readFile(file);
    }

    /** The module name of a document: beside a file, so its relative imports resolve as they do when it runs. */
    file(uri: string): string {
        return uri.startsWith('file:') ? `${fileURLToPath(uri)}.ts` : path.join(this.base, `${encodeURIComponent(uri)}${MODULE}`);
    }

    /** Takes the editor's text of a document as the content of its module, and returns the module name. */
    update(uri: string, text: string): string {
        const file = this.file(uri);
        this.open.set(this.key(file), { file, version: ++this.versions, workflow: new Workflow(uri, text) });
        return file;
    }

    /** Forgets the editor's text: the module is read from disk again, if anything still imports it. */
    close(uri: string): void {
        this.open.delete(this.key(this.file(uri)));
    }

    /** The workflow behind a module of the program, when the module stands for a `.spl` file. */
    workflow(file: string): Workflow | undefined {
        const open = this.open.get(this.key(file))?.workflow;
        const source = splSource(file);
        if (open || !source) return open;
        const entry = this.stat(file);
        if (!entry.workflow) {
            const text = ts.sys.readFile(source);
            if (text === undefined) return undefined;
            entry.workflow = new Workflow(pathToFileURL(source).href, text);
        }
        return entry.workflow;
    }

    /** Where the editor shows a span of a file of the program; nowhere for generated code. */
    location(file: string, start: number, length: number): Location | undefined {
        const workflow = this.workflow(file);
        if (workflow) {
            const range = workflow.range(start, length);
            return range && { uri: workflow.uri, range };
        }
        const source = this.service.getProgram()?.getSourceFile(file);
        if (!source) return undefined;
        const position = (offset: number) => ts.getLineAndCharacterOfPosition(source, Math.min(offset, source.text.length));
        return { uri: pathToFileURL(file).href, range: { start: position(start), end: position(start + length) } };
    }
}
