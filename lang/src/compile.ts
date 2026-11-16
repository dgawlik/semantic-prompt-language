import * as acorn from 'acorn';
import * as nodeModule from 'node:module';
import { SplSyntaxError } from './errors.js';
import { scan, type Scan } from './scanner.js';

interface Node {
    type: string;
    start: number;
    end: number;
    loc: { start: { line: number; column: number }; end: { line: number; column: number } };
    [key: string]: unknown;
}

/** A module the file imports, statically or with `import()` of a literal. */
export interface ModuleImport {
    specifier: string;
    line: number;
    column: number;
}

export interface ModuleOptions {
    /** Names the workflow library exports; those the file uses are imported for it. */
    library: readonly string[];
    /** Report top-level state and stop for the `--debug` stepper before each top-level statement. */
    instrument?: boolean;
}

export interface Compiled {
    scan: Scan;
    imports: ModuleImport[];
    /**
     * JavaScript for the loader. The workflow body keeps its lines inside the default export; imports and
     * exported declarations follow at their own lines plus `pageOffset`, since they must stay at module level.
     * `header` is the length of the generated code that precedes the source on line 1.
     */
    module(options: ModuleOptions): { code: string; header: number };
    /** An importable TypeScript module with the same shape, laid out to be read. */
    emit(options: ModuleOptions & { from: string }): string;
    pageOffset: number;
}

const isNode = (value: unknown): value is Node =>
    typeof value === 'object' && value !== null && typeof (value as Node).type === 'string' && typeof (value as Node).start === 'number';

function walk(node: Node, visit: (node: Node, parent: Node | undefined, key: string) => void, parent?: Node, key = ''): void {
    visit(node, parent, key);
    for (const [name, value] of Object.entries(node)) {
        if (name === 'loc') continue;
        if (Array.isArray(value)) {
            for (const item of value) if (isNode(item)) walk(item, visit, node, name);
        } else if (isNode(value)) walk(value, visit, node, name);
    }
}

function patternNames(pattern: Node | null, out: string[] = []): string[] {
    if (!pattern) return out;
    switch (pattern.type) {
        case 'Identifier': out.push(String(pattern.name)); break;
        case 'ObjectPattern':
            for (const property of pattern.properties as Node[]) {
                patternNames((property.type === 'RestElement' ? property.argument : property.value) as Node, out);
            }
            break;
        case 'ArrayPattern': for (const element of pattern.elements as (Node | null)[]) patternNames(element, out); break;
        case 'AssignmentPattern': patternNames(pattern.left as Node, out); break;
        case 'RestElement': patternNames(pattern.argument as Node, out); break;
    }
    return out;
}

/** Names a top-level statement declares. */
function declaredNames(node: Node): string[] {
    if (node.type === 'VariableDeclaration') return (node.declarations as Node[]).flatMap(item => patternNames(item.id as Node));
    if (node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') return [String((node.id as Node).name)];
    return [];
}

/** True for an identifier that reads a variable, as opposed to naming a property, label or module export. */
function isReference(parent: Node | undefined, key: string): boolean {
    if (!parent) return true;
    switch (parent.type) {
        case 'MemberExpression': return key !== 'property' || Boolean(parent.computed);
        case 'Property':
        case 'MethodDefinition':
        case 'PropertyDefinition': return key !== 'key' || Boolean(parent.computed);
        case 'LabeledStatement':
        case 'BreakStatement':
        case 'ContinueStatement':
        case 'MetaProperty':
        case 'ImportSpecifier':
        case 'ExportSpecifier': return false;
        default: return true;
    }
}

/** Erases TypeScript annotations in place, so positions keep matching the source. */
export function stripTypes(source: string): string {
    const strip = (nodeModule as { stripTypeScriptTypes?: (code: string, options?: { mode: 'strip' }) => string }).stripTypeScriptTypes;
    if (!strip) throw new SplSyntaxError('SPL needs a Node.js release with built-in type stripping (24.15 or later)', 1, 1);
    // Node reports this stable-in-practice API as experimental on every first use.
    const emitWarning = process.emitWarning;
    process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
        const type = typeof rest[0] === 'string' ? rest[0] : (rest[0] as { type?: string } | undefined)?.type;
        if (type === 'ExperimentalWarning' && String(warning).includes('stripTypeScriptTypes')) return;
        (emitWarning as (...args: unknown[]) => void).call(process, warning, ...rest);
    }) as typeof process.emitWarning;
    try {
        return strip(source, { mode: 'strip' });
    } catch (error) {
        if (!(error instanceof Error)) throw error;
        // The parser reports its position only as a source excerpt at the top of the stack.
        const line = Number(/^[^\n]*:(\d+)\n/.exec(error.stack ?? '')?.[1] ?? 1);
        const column = (/^( *)\^/m.exec(error.stack ?? '')?.[1].length ?? 0) + 1;
        const unsupported = (error as { code?: string }).code === 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX';
        throw new SplSyntaxError(unsupported
            ? `Unsupported TypeScript syntax: ${error.message}; only type syntax that can be erased is allowed`
            : `invalid TypeScript: ${error.message}`, line, column);
    } finally {
        process.emitWarning = emitWarning;
    }
}

const blank = (text: string): string => text.replace(/[^\n]/g, ' ');

/** Scans, erases types and analyses a `.spl` file. Throws `SplSyntaxError` with every problem found. */
export function compile(source: string): Compiled {
    const scanned = scan(source);
    if (scanned.problems.length) throw new SplSyntaxError(scanned.problems);
    const javascript = stripTypes(scanned.code);
    let program: Node;
    try {
        program = acorn.parse(javascript, {
            ecmaVersion: 'latest', sourceType: 'module', locations: true, allowAwaitOutsideFunction: true,
        }) as unknown as Node;
    } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        const loc = (error as SyntaxError & { loc?: { line: number; column: number } }).loc;
        throw new SplSyntaxError(error.message.replace(/ \(\d+:\d+\)$/, ''), loc?.line ?? 1, (loc?.column ?? 0) + 1);
    }
    const fail = (node: Node, message: string): never => {
        throw new SplSyntaxError(message, node.loc.start.line, node.loc.start.column + 1);
    };

    // Imports and exported declarations stay at module level; everything else is the workflow body.
    const body = program.body as Node[];
    const outer = body.filter(node => node.type === 'ImportDeclaration' || node.type.startsWith('Export'));
    const inner = body.filter(node => !outer.includes(node));
    const workflowNames = new Set(inner.flatMap(declaredNames));
    const moduleNames = new Set<string>();
    const specifiers: Node[] = [];
    for (const node of outer) {
        const from = node.source as Node | null | undefined;
        if (from) specifiers.push(from);
        if (node.type === 'ImportDeclaration') {
            for (const item of node.specifiers as Node[]) moduleNames.add(String((item.local as Node).name));
        } else if (node.type === 'ExportDefaultDeclaration') {
            fail(node, 'the default export of a .spl file is its workflow; remove `export default`');
        } else if (node.type === 'ExportNamedDeclaration' && node.declaration) {
            const declaration = node.declaration as Node;
            for (const name of declaredNames(declaration)) moduleNames.add(name);
            const local = new Set<string>();
            walk(declaration, item => {
                if (item.type === 'VariableDeclarator') patternNames(item.id as Node).forEach(name => local.add(name));
                else if (item.type === 'CatchClause') patternNames(item.param as Node | null).forEach(name => local.add(name));
                else if (/^(?:Function|Class|ArrowFunction)/.test(item.type)) {
                    if (item.id) local.add(String((item.id as Node).name));
                    for (const param of (item.params as Node[] | undefined) ?? []) patternNames(param).forEach(name => local.add(name));
                }
            });
            walk(declaration, (item, parent, key) => {
                const name = String(item.name);
                if (item.type === 'Identifier' && isReference(parent, key) && workflowNames.has(name) && !local.has(name)) {
                    fail(item, `exported \`${declaredNames(declaration)[0]}\` uses the workflow variable \`${name}\`; exports live outside the workflow, so export \`${name}\` too or pass it as a parameter`);
                }
            });
        } else if (node.type === 'ExportNamedDeclaration' && !from) {
            for (const item of node.specifiers as Node[]) {
                const name = String((item.local as Node).name);
                if (workflowNames.has(name)) fail(item, `cannot export the workflow variable \`${name}\`; write \`export\` on its declaration instead`);
            }
        }
    }
    walk(program, node => {
        if (node.type === 'ImportExpression' && (node.source as Node).type === 'Literal') specifiers.push(node.source as Node);
    });
    const imports = specifiers.map(literal => ({ specifier: String(literal.value), line: literal.loc.start.line, column: literal.loc.start.column + 1 }));
    const used = new Set<string>();
    walk(program, (node, parent, key) => { if (node.type === 'Identifier' && isReference(parent, key)) used.add(String(node.name)); });

    const lineCount = scanned.lines.length;
    const settings = scanned.defaults?.settings ?? {};
    const meta = `{ url: import.meta.url${Object.keys(settings).length ? `, defaults: ${JSON.stringify(settings)}` : ''} }`;
    const libraryImport = (library: readonly string[]): string =>
        `import { ${['__spl', ...library.filter(name => used.has(name) && !moduleNames.has(name))].join(', ')} } from 'spl-lang';`;
    /** One of the two layers of the file: the workflow body, or what stays at module level. */
    const layer = (text: string, kind: 'workflow' | 'module'): string => {
        let result = '';
        let position = 0;
        for (const node of outer) {
            const [between, own] = [text.slice(position, node.start), text.slice(node.start, node.end)];
            result += kind === 'workflow' ? between + blank(own) : blank(between) + own;
            position = node.end;
        }
        return result + (kind === 'workflow' ? text.slice(position) : blank(text.slice(position)));
    };
    const blockLines = scanned.blocks.map(block => [block.line, block.endLine] as const);

    return {
        scan: scanned, imports, pageOffset: lineCount + 1,
        module({ library, instrument }) {
            let workflow = layer(javascript, 'workflow');
            let prelude = '';
            if (instrument) {
                // Later insertions first, so earlier offsets stay valid.
                for (const node of [...inner].reverse()) {
                    const line = node.loc.start.line;
                    if (node.type === 'FunctionDeclaration' || node.type === 'EmptyStatement') continue;
                    if (blockLines.some(([start, end]) => line >= start && line <= end)) continue;
                    workflow = `${workflow.slice(0, node.start)}await __spl.step(${line}, ${node.loc.end.line}); ${workflow.slice(node.start)}`;
                }
                // Variables of generated code are not the workflow's.
                const watched = [...workflowNames].filter(name => !name.startsWith('__spl'));
                prelude = ` __spl.watch(() => ({ ${watched.map(name => `${name}: () => ${name}`).join(', ')} }));`;
            }
            const header = `${libraryImport(library)} export default async function workflow(args = [], options) { return __spl.workflow(${meta}, args, options, async () => {${prelude} `;
            return { header: header.length, code: `${header}${workflow}\n}); }\n${layer(javascript, 'module')}\n` };
        },
        emit({ library, from }) {
            // Imports of other workflows point at their compiled modules; padding keeps every offset in place.
            let text = scanned.code;
            for (const literal of specifiers) {
                const raw = text.slice(literal.start, literal.end);
                if (String(literal.value).endsWith('.spl')) text = `${text.slice(0, literal.start)}${raw.slice(0, -5)}.ts${raw.at(-1)} ${text.slice(literal.end)}`;
            }
            const tidy = (part: string): string => part.split('\n').map(line => line.trimEnd()).join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+|\s+$/g, '');
            const moduleLevel = tidy(layer(text, 'module'));
            const workflow = tidy(layer(text, 'workflow'));
            return [
                `// Generated by \`spl compile\` from ${from}. Edit the .spl file, not this module.`,
                libraryImport(library),
                ...(moduleLevel ? [moduleLevel] : []),
                '',
                'export default async function workflow(args: string[] = [], options?: __spl.WorkflowOptions): Promise<unknown> {',
                `    return __spl.workflow(${meta}, args, options, async () => {`,
                workflow,
                '    });',
                '}',
                '',
            ].join('\n');
        },
    };
}
