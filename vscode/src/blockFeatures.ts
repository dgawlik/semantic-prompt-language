import ts from 'typescript';
import { CompletionItemKind, MarkupKind, type CompletionItem, type Hover, type Position, type Range } from 'vscode-languageserver/node';
import { HEADER_KEYS, type HeaderKey, type Region } from '../../lang/src/scanner.js';
import { library } from './catalog';
import type { WorkflowContext } from './languageFeatures';

/** A name a block can refer to. */
interface Binding {
    name: string;
    kind: 'function' | 'type' | 'variable';
    detail: string;
    /** Declared by the workflow, as opposed to the library. */
    own: boolean;
    /** Can be the target of `@=name`. */
    assignable: boolean;
    /** A constant declared at or below the block: it has no value when the block runs. */
    later: boolean;
    /** Offset of the declared name in the module, for names of the workflow. */
    offset?: number;
}

/** The names in scope at the opening fence of a block: the workflow's declarations and the library. */
function bindings({ project, file, workflow }: WorkflowContext, region: Region): Binding[] {
    const program = project.service.getProgram();
    const source = program?.getSourceFile(file);
    if (!program || !source) return [];
    const checker = program.getTypeChecker();
    const start = workflow.virtual.offsetAt({ line: region.line - 1, character: 0 });
    let node: ts.Node = source;
    for (let inner: ts.Node | undefined = node; inner; inner = node.forEachChild(child => child.getStart(source) <= start && start < child.end ? child : undefined)) node = inner;
    const isType = (type: ts.Type): boolean => type.getProperty('coerce') !== undefined && type.getProperty('schema') !== undefined;
    const found: Binding[] = [];
    for (const symbol of checker.getSymbolsInScope(node, ts.SymbolFlags.Value | ts.SymbolFlags.Alias)) {
        const name = symbol.getName();
        const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
        if (!declaration || symbol.flags & ts.SymbolFlags.Alias && !(checker.getAliasedSymbol(symbol).flags & ts.SymbolFlags.Value)) continue;
        const own = declaration.getSourceFile() === source;
        if (own ? name.startsWith('__') : !Object.hasOwn(library, name)) continue;
        const type = checker.getTypeOfSymbolAtLocation(symbol, node);
        const signatures = type.getCallSignatures();
        found.push({
            name, own,
            kind: isType(type) || signatures.some(signature => isType(signature.getReturnType())) ? 'type' : signatures.length ? 'function' : 'variable',
            detail: checker.typeToString(type).slice(0, 200),
            assignable: (ts.isVariableDeclaration(declaration) || ts.isParameter(declaration)) && !(ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const),
            // A block inside a function runs when the function is called, after the declarations around it.
            later: own && declaration.getStart(source) >= start && (symbol.flags & (ts.SymbolFlags.BlockScopedVariable | ts.SymbolFlags.Class)) !== 0
                && ts.findAncestor(declaration, ts.isFunctionLike) === ts.findAncestor(node, ts.isFunctionLike),
            ...(own ? { offset: (ts.getNameOfDeclaration(declaration) ?? declaration).getStart(source) } : {}),
        });
    }
    return found;
}

const KEYS = new Map(HEADER_KEYS.map(key => [key.name, key]));

function keyHelp(key: HeaderKey): string {
    return [
        `\`${key.name}${key.values ? `: ${key.values.join(' | ')}` : ''}\``, key.description,
        ...(key.applies === 'all' ? [] : [`Applies only to ${key.applies} blocks.`]),
    ].join('\n\n');
}

/** Completion inside a `---` block: header keys and their closed sets of values, `@name` references and output types. */
export function blockCompletions(context: WorkflowContext, region: Region, position: Position, trigger?: string): CompletionItem[] {
    const { line, character } = position;
    // The scanner counts lines from 1; a block that is still open has no closing fence.
    const row = line + 1;
    if (row <= region.line || row > region.endLine || row === region.endLine && !region.open || trigger && !'@[ '.includes(trigger)) return [];
    const text = context.workflow.scan.lines[line] ?? '';
    const before = text.slice(0, character);
    const after = text.slice(character);
    const word = /[\w$]*$/.exec(before)![0];
    const range: Range = { start: { line, character: character - word.length }, end: { line, character: character + /^[\w$]*/.exec(after)![0].length } };
    // A key is offered while its name is typed, not for the spaces that indent it.
    const naming = trigger === undefined && /^\s*[A-Za-z]*$/.test(before);

    const names = (keep: (binding: Binding) => boolean): CompletionItem[] => bindings(context, region).filter(binding => !binding.later && keep(binding)).map(binding => ({
        label: binding.name,
        kind: binding.kind === 'function' ? CompletionItemKind.Function : binding.kind === 'type' ? CompletionItemKind.Struct : CompletionItemKind.Variable,
        detail: binding.own ? binding.detail : library[binding.name].signature,
        ...(binding.own ? {} : { documentation: library[binding.name].description }),
        sortText: `${binding.own ? '0' : '1'}${binding.name}`,
        textEdit: { range, newText: binding.name },
    }));
    const types = (): CompletionItem[] => before[character - word.length - 1] === '.' ? [] : names(binding => binding.kind === 'type');
    const keys = (): CompletionItem[] => {
        const colon = /^[\w$]*\s*:/.test(after);
        return HEADER_KEYS.filter(key => (key.applies === 'all' || key.applies === region.mode)
            && !region.header.some(item => item.name === key.name && item.line !== row)).map((key, index) => ({
            label: key.name, kind: CompletionItemKind.Property, detail: 'header key',
            documentation: { kind: MarkupKind.Markdown, value: keyHelp(key) },
            sortText: String(index).padStart(2, '0'),
            textEdit: { range, newText: colon ? key.name : `${key.name}: ` },
            ...(!colon && (key.values || key.name === 'outputType') ? { command: { title: 'Suggest', command: 'editor.action.triggerSuggest' } } : {}),
        }));
    };

    const entry = region.header.find(item => item.line === row);
    const current = entry && KEYS.get(entry.name);
    if (current) {
        const value = /^\s*\w+\s*:\s*(.*)$/.exec(before);
        if (!value) return naming ? keys() : [];
        if (current.name === 'outputType') return types();
        if (!current.values || value[1] !== word) return [];
        return current.values.map((item, index) => ({ label: item, kind: CompletionItemKind.EnumMember, sortText: String(index), textEdit: { range, newText: item } }));
    }
    if (row < region.bodyLine) return [];
    // The line after the header may become its next key.
    if (row === region.bodyLine && naming && !after.trim()) return keys();
    const reference = /(?<![\w@])@(=?)[\w$]*$/.exec(before);
    if (reference) {
        // After an arrow, `@name` names a new output; `@=name` assigns a variable that exists.
        if (reference[1]) return names(binding => binding.own && binding.assignable);
        return region.mode !== 'ask' && /->[ \t]*(?:\[[^\]]*\][ \t]*)?@[\w$]*$/.test(before) ? [] : names(() => true);
    }
    return region.mode === 'agent' && /->[ \t]*\[[^\]]*$/.test(before) ? types() : [];
}

/** What a header key means, when the position is on one. */
export function headerHover({ workflow }: WorkflowContext, position: Position): Hover | null {
    const { line, character } = position;
    const entry = workflow.region(line)?.header.find(item =>
        item.line === line + 1 && character >= item.column - 1 && character <= item.column - 1 + item.name.length);
    const key = entry && KEYS.get(entry.name);
    return entry && key ? {
        contents: { kind: MarkupKind.Markdown, value: keyHelp(key) },
        range: { start: { line, character: entry.column - 1 }, end: { line, character: entry.column - 1 + entry.name.length } },
    } : null;
}

/** The output a block declares at a position, `@name` after an arrow or the value of `outputVar`, with the offset of its variable in the module. */
export function outputAt(context: WorkflowContext, position: Position): { offset: number; range: Range } | undefined {
    const region = context.workflow.region(position.line);
    const output = context.workflow.outputs(position.line).find(item =>
        item.line === position.line + 1 && position.character >= item.column - 1 && position.character <= item.column - 1 + item.name.length);
    const offset = region && output && bindings(context, region).find(binding => binding.name === output.name)?.offset;
    return offset === undefined || !output ? undefined : {
        offset,
        range: { start: { line: position.line, character: output.column - 1 }, end: { line: position.line, character: output.column - 1 + output.name.length } },
    };
}