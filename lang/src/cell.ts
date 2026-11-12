import * as acorn from 'acorn';
import * as nodeModule from 'node:module';
import { SplSyntaxError } from './errors.js';

export type CellLanguage = 'js' | 'ts';

export interface CellDeclaration {
    name: string;
    kind: 'function' | 'class' | 'const' | 'let' | 'var' | 'import';
    /** Module specifier of an imported name. */
    from?: string;
    /** 1-based document position of the declared name. */
    line: number;
    column: number;
}

export interface CellImport {
    specifier: string;
    line: number;
    column: number;
}

export interface CompiledCell {
    /** The fence as written. */
    readonly source: string;
    /** JavaScript whose top-level declarations live in the shared scope. */
    readonly code: string;
    readonly language: CellLanguage;
    /** Document line of the first source line. */
    readonly line: number;
    readonly declarations: readonly CellDeclaration[];
    readonly imports: readonly CellImport[];
    /** Node types of the top-level statements, in order. */
    readonly statements: readonly string[];
}

interface Node {
    type: string;
    start: number;
    end: number;
    loc?: { start: { line: number; column: number } };
    [key: string]: unknown;
}

const isNode = (value: unknown): value is Node =>
    typeof value === 'object' && value !== null && typeof (value as Node).type === 'string' && typeof (value as Node).start === 'number';

export const FENCE_LANGUAGES: Readonly<Record<string, CellLanguage>> = Object.freeze({
    js: 'js', javascript: 'js', mjs: 'js', ts: 'ts', typescript: 'ts', mts: 'ts',
});

/** Erases TypeScript annotations in place, so positions keep matching the document. */
function stripTypes(source: string, line: number): string {
    const strip = (nodeModule as { stripTypeScriptTypes?: (code: string, options?: { mode: 'strip' }) => string }).stripTypeScriptTypes;
    if (!strip) throw new SplSyntaxError('ts fences need a Node.js release with built-in type stripping', line, 1);
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
        throw new SplSyntaxError(`invalid TypeScript: ${error.message.split('\n')[0]}. Only erasable type syntax is supported`, line, 1);
    } finally {
        process.emitWarning = emitWarning;
    }
}

function bindingNames(pattern: Node | null, out: Node[] = []): Node[] {
    if (!pattern) return out;
    switch (pattern.type) {
        case 'Identifier': out.push(pattern); break;
        case 'ObjectPattern':
            for (const property of pattern.properties as Node[]) {
                bindingNames((property.type === 'RestElement' ? property.argument : property.value) as Node, out);
            }
            break;
        case 'ArrayPattern': for (const element of pattern.elements as (Node | null)[]) bindingNames(element, out); break;
        case 'AssignmentPattern': bindingNames(pattern.left as Node, out); break;
        case 'RestElement': bindingNames(pattern.argument as Node, out); break;
    }
    return out;
}

function walk(node: Node, visit: (node: Node) => void): void {
    visit(node);
    for (const [key, value] of Object.entries(node)) {
        if (key === 'loc' || key === 'range') continue;
        if (Array.isArray(value)) {
            for (const item of value) if (isNode(item)) walk(item, visit);
        } else if (isNode(value)) walk(value, visit);
    }
}

/**
 * Compiles one fence. Top-level `const`/`let`/`var`, classes and imports become assignments to the
 * shared scope, so later fences, closures and blockquote agents all see the same live bindings.
 * Function declarations keep hoisting and are published to the scope before the fence runs.
 */
export function compileCell(source: string, options: { language?: CellLanguage; line?: number } = {}): CompiledCell {
    const language = options.language ?? 'js';
    const line = options.line ?? 1;
    const text = language === 'ts' ? stripTypes(source, line) : source;
    let program: Node;
    try {
        program = acorn.parse(text, {
            ecmaVersion: 'latest', sourceType: 'module', locations: true, allowAwaitOutsideFunction: true,
        }) as unknown as Node;
    } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        const loc = (error as SyntaxError & { loc?: { line: number; column: number } }).loc;
        throw new SplSyntaxError(error.message.replace(/ \(\d+:\d+\)$/, ''), line + (loc?.line ?? 1) - 1, (loc?.column ?? 0) + 1);
    }
    const unsupported = (node: Node, message: string): never => {
        throw new SplSyntaxError(message, line + node.loc!.start.line - 1, node.loc!.start.column + 1);
    };
    const edits: { start: number; end: number; text: string }[] = [];
    const declarations: CellDeclaration[] = [];
    const imports: CellImport[] = [];
    const hoisted: string[] = [];
    const declare = (id: Node, kind: CellDeclaration['kind'], from?: string): void => {
        declarations.push({
            name: String(id.name), kind, line: line + id.loc!.start.line - 1, column: id.loc!.start.column + 1,
            ...(from !== undefined ? { from } : {}),
        });
    };
    const lines = (node: Node): string => '\n'.repeat(text.slice(node.start, node.end).split('\n').length - 1);

    const declaration = (node: Node): void => {
        if (node.type === 'VariableDeclaration') {
            const kind = String(node.kind);
            if (kind !== 'const' && kind !== 'let' && kind !== 'var') return;
            edits.push({ start: node.start, end: node.start + kind.length, text: ';' + ' '.repeat(kind.length - 1) });
            for (const declarator of node.declarations as Node[]) {
                for (const id of bindingNames(declarator.id as Node)) declare(id, kind);
                edits.push({ start: declarator.start, end: declarator.start, text: '(' });
                edits.push({ start: declarator.end, end: declarator.end, text: declarator.init ? ')' : ' = undefined)' });
            }
        } else if (node.type === 'FunctionDeclaration') {
            const id = node.id as Node;
            declare(id, 'function');
            hoisted.push(`__spl.scope.${id.name} = ${id.name};`);
        } else if (node.type === 'ClassDeclaration') {
            const id = node.id as Node;
            declare(id, 'class');
            edits.push({ start: node.start, end: node.start, text: `;${id.name} = ` });
            edits.push({ start: node.end, end: node.end, text: ';' });
        }
    };

    const body = program.body as Node[];
    body.forEach((node, index) => {
        switch (node.type) {
            case 'ImportDeclaration': {
                const specifier = String((node.source as Node).value);
                imports.push({ specifier, line: line + node.loc!.start.line - 1, column: node.loc!.start.column + 1 });
                const attributes = (node.attributes as Node[] | undefined) ?? [];
                const withClause = attributes.length ? `, { with: { ${attributes.map(attribute => {
                    const key = attribute.key as Node;
                    return `${JSON.stringify(key.type === 'Identifier' ? key.name : key.value)}: ${JSON.stringify((attribute.value as Node).value)}`;
                }).join(', ')} } }` : '';
                const call = `await __spl.import(${JSON.stringify(specifier)}${withClause})`;
                const named: [string, string][] = [];
                let namespace: string | undefined;
                let fallback: string | undefined;
                for (const item of node.specifiers as Node[]) {
                    const local = item.local as Node;
                    declare(local, 'import', specifier);
                    if (item.type === 'ImportNamespaceSpecifier') namespace = String(local.name);
                    else if (item.type === 'ImportDefaultSpecifier') fallback = String(local.name);
                    else {
                        const imported = item.imported as Node;
                        named.push([String(local.name), String(imported.type === 'Identifier' ? imported.name : imported.value)]);
                    }
                }
                // Named and default imports stay live bindings of the module, as in ES modules.
                const pairs = [...(namespace ? [[namespace, '*']] : []), ...(fallback ? [[fallback, 'default']] : []), ...named];
                const statement = pairs.length ? `;__spl.bind(${call}, ${JSON.stringify(pairs)});` : `;${call};`;
                edits.push({ start: node.start, end: node.end, text: statement + lines(node) });
                break;
            }
            case 'ExportNamedDeclaration':
                if (!node.declaration) unsupported(node, 'exports are not supported in workflow code; every top-level declaration is already shared');
                edits.push({ start: node.start, end: (node.declaration as Node).start, text: ' '.repeat((node.declaration as Node).start - node.start) });
                declaration(node.declaration as Node);
                break;
            case 'ExportDefaultDeclaration':
            case 'ExportAllDeclaration':
                unsupported(node, 'exports are not supported in workflow code; every top-level declaration is already shared');
                break;
            case 'ExpressionStatement':
                if (index === body.length - 1) {
                    // The value of a final expression is the result of an interactive cell.
                    edits.push({ start: node.start, end: node.start, text: ';return ' });
                    return;
                }
                break;
            default:
                declaration(node);
        }
        if (node.type !== 'FunctionDeclaration') edits.push({ start: node.end, end: node.end, text: ';__spl.tick();' });
    });

    walk(program, node => {
        if (node.type === 'ImportExpression') edits.push({ start: node.start, end: node.start + 'import'.length, text: '__spl.import' });
        else if (node.type === 'MetaProperty' && (node.meta as Node).name === 'import') {
            edits.push({ start: node.start, end: node.end, text: '__spl.meta' });
        }
    });

    // Later edits first; at one position the insertion made last must end up leftmost.
    let code = text;
    edits.map((edit, order) => ({ ...edit, order }))
        .sort((a, b) => b.start - a.start || b.end - a.end || b.order - a.order)
        .forEach(edit => { code = code.slice(0, edit.start) + edit.text + code.slice(edit.end); });
    return { source, code: hoisted.join(' ') + code, language, line, declarations, imports, statements: body.map(node => node.type) };
}
