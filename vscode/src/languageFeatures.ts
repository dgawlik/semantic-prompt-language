import ts from 'typescript';
import {
    CompletionItemKind, CompletionTriggerKind, DiagnosticSeverity, DocumentHighlightKind, MarkupKind, SymbolKind,
    type CompletionContext, type CompletionItem, type Diagnostic, type DocumentHighlight, type DocumentSymbol, type FoldingRange,
    type Hover, type Location, type Position, type Range, type SignatureHelp, type TextEdit, type WorkspaceEdit,
} from 'vscode-languageserver/node';
import { blockCompletions, headerHover, outputAt } from './blockFeatures';
import type { TypeScriptProject } from './typescriptService';
import type { Workflow } from './workflow';

/** An open `.spl` document: its workflow and the module that stands for it in the project. */
export interface WorkflowContext {
    project: TypeScriptProject;
    file: string;
    workflow: Workflow;
}

/** Scans a document and gives its module to the project. */
export function workflowContext(project: TypeScriptProject, uri: string, text: string): WorkflowContext {
    const file = project.update(uri, text);
    return { project, file, workflow: project.workflow(file)! };
}

export interface CompletionData {
    uri: string;
    offset: number;
    name: string;
    source?: string;
    entry?: ts.CompletionEntryData;
}

const TS_TRIGGERS = new Set(['.', '"', "'", '`', '/', '@', '<', '#']);

const COMPLETION_KINDS: Partial<Record<ts.ScriptElementKind, CompletionItemKind>> = {
    [ts.ScriptElementKind.functionElement]: CompletionItemKind.Function,
    [ts.ScriptElementKind.localFunctionElement]: CompletionItemKind.Function,
    [ts.ScriptElementKind.memberFunctionElement]: CompletionItemKind.Method,
    [ts.ScriptElementKind.constructSignatureElement]: CompletionItemKind.Constructor,
    [ts.ScriptElementKind.constructorImplementationElement]: CompletionItemKind.Constructor,
    [ts.ScriptElementKind.constElement]: CompletionItemKind.Constant,
    [ts.ScriptElementKind.letElement]: CompletionItemKind.Variable,
    [ts.ScriptElementKind.variableElement]: CompletionItemKind.Variable,
    [ts.ScriptElementKind.localVariableElement]: CompletionItemKind.Variable,
    [ts.ScriptElementKind.parameterElement]: CompletionItemKind.Variable,
    [ts.ScriptElementKind.alias]: CompletionItemKind.Variable,
    [ts.ScriptElementKind.classElement]: CompletionItemKind.Class,
    [ts.ScriptElementKind.localClassElement]: CompletionItemKind.Class,
    [ts.ScriptElementKind.interfaceElement]: CompletionItemKind.Interface,
    [ts.ScriptElementKind.typeElement]: CompletionItemKind.Interface,
    [ts.ScriptElementKind.typeParameterElement]: CompletionItemKind.TypeParameter,
    [ts.ScriptElementKind.enumElement]: CompletionItemKind.Enum,
    [ts.ScriptElementKind.enumMemberElement]: CompletionItemKind.EnumMember,
    [ts.ScriptElementKind.moduleElement]: CompletionItemKind.Module,
    [ts.ScriptElementKind.externalModuleName]: CompletionItemKind.Module,
    [ts.ScriptElementKind.memberVariableElement]: CompletionItemKind.Field,
    [ts.ScriptElementKind.memberGetAccessorElement]: CompletionItemKind.Property,
    [ts.ScriptElementKind.memberSetAccessorElement]: CompletionItemKind.Property,
    [ts.ScriptElementKind.keyword]: CompletionItemKind.Keyword,
    [ts.ScriptElementKind.string]: CompletionItemKind.Value,
    [ts.ScriptElementKind.scriptElement]: CompletionItemKind.File,
    [ts.ScriptElementKind.directory]: CompletionItemKind.Folder,
};

const SYMBOL_KINDS: Partial<Record<ts.ScriptElementKind, SymbolKind>> = {
    [ts.ScriptElementKind.functionElement]: SymbolKind.Function,
    [ts.ScriptElementKind.localFunctionElement]: SymbolKind.Function,
    [ts.ScriptElementKind.memberFunctionElement]: SymbolKind.Method,
    [ts.ScriptElementKind.constructorImplementationElement]: SymbolKind.Constructor,
    [ts.ScriptElementKind.classElement]: SymbolKind.Class,
    [ts.ScriptElementKind.localClassElement]: SymbolKind.Class,
    [ts.ScriptElementKind.interfaceElement]: SymbolKind.Interface,
    [ts.ScriptElementKind.typeElement]: SymbolKind.Interface,
    [ts.ScriptElementKind.constElement]: SymbolKind.Constant,
    [ts.ScriptElementKind.memberVariableElement]: SymbolKind.Property,
    [ts.ScriptElementKind.memberGetAccessorElement]: SymbolKind.Property,
};

const SEVERITIES: Record<ts.DiagnosticCategory, DiagnosticSeverity> = {
    [ts.DiagnosticCategory.Error]: DiagnosticSeverity.Error, [ts.DiagnosticCategory.Warning]: DiagnosticSeverity.Warning,
    [ts.DiagnosticCategory.Suggestion]: DiagnosticSeverity.Hint, [ts.DiagnosticCategory.Message]: DiagnosticSeverity.Information,
};

function documentation(parts: ts.SymbolDisplayPart[] | undefined, tags: ts.JSDocTagInfo[] | undefined): string {
    const text = ts.displayPartsToString(parts);
    const extra = (tags ?? []).map(tag => `*@${tag.name}*${tag.text?.length ? ` ${ts.displayPartsToString(tag.text)}` : ''}`);
    return [text, ...extra].filter(Boolean).join('\n\n');
}

/**
 * The offset in the module a position stands for: code as is, `@name` inputs and type expressions through
 * the scanner's spans, declared outputs through their variable. `range` is set when the name is not at the offset.
 */
function target(context: WorkflowContext, position: Position): { offset: number; range?: Range } | undefined {
    const offset = context.workflow.offset(position);
    return offset === undefined ? outputAt(context, position) : { offset };
}

// ---- diagnostics ------------------------------------------------------------

/** The scanner's problems, then what TypeScript finds in the module, at source positions. */
export function diagnostics({ project, file, workflow }: WorkflowContext): Diagnostic[] {
    const result: Diagnostic[] = workflow.scan.problems.map(problem => ({
        range: { start: { line: problem.line - 1, character: problem.column - 1 }, end: { line: problem.line - 1, character: problem.endColumn - 1 } },
        severity: DiagnosticSeverity.Error, source: 'spl', message: problem.message,
    }));
    // The scanner explains its own lines better than TypeScript explains what was generated from them.
    const explained = new Set(result.map(item => item.range.start.line));
    for (const item of [...project.service.getSyntacticDiagnostics(file), ...project.service.getSemanticDiagnostics(file)]) {
        if (item.start === undefined) continue;
        const range = workflow.range(item.start, item.length ?? 1) ?? workflow.lineRange(item.start);
        if (!range || explained.has(range.start.line)) continue;
        result.push({
            range, severity: SEVERITIES[item.category], source: 'ts', code: item.code,
            message: ts.flattenDiagnosticMessageText(item.messageText, '\n'),
        });
    }
    return result;
}

// ---- completion -------------------------------------------------------------

export function completions(context: WorkflowContext, position: Position, trigger?: CompletionContext): CompletionItem[] {
    const { project, file, workflow } = context;
    const character = trigger?.triggerKind === CompletionTriggerKind.TriggerCharacter ? trigger.triggerCharacter : undefined;
    const region = workflow.region(position.line);
    if (region) return blockCompletions(context, region, position, character);
    const offset = workflow.offset(position);
    if (offset === undefined || character && !TS_TRIGGERS.has(character)) return [];
    const info = project.service.getCompletionsAtPosition(file, offset, {
        triggerCharacter: character as ts.CompletionsTriggerCharacter | undefined,
        includeCompletionsWithInsertText: true, includeCompletionsForModuleExports: false,
    });
    if (!info) return [];
    return info.entries.map((entry): CompletionItem => {
        const replacement = entry.replacementSpan ?? info.optionalReplacementSpan;
        const range = replacement && workflow.range(replacement.start, replacement.length);
        const data: CompletionData = { uri: workflow.uri, offset, name: entry.name, source: entry.source, entry: entry.data };
        return {
            label: entry.name,
            kind: COMPLETION_KINDS[entry.kind] ?? CompletionItemKind.Text,
            sortText: entry.sortText,
            ...(entry.isRecommended ? { preselect: true } : {}),
            ...(entry.kindModifiers?.includes('deprecated') ? { tags: [1] } : {}),
            ...(range ? { textEdit: { range, newText: entry.insertText ?? entry.name } } : entry.insertText ? { insertText: entry.insertText } : {}),
            data,
        };
    });
}

export function resolveCompletion(context: WorkflowContext, item: CompletionItem): CompletionItem {
    const data = item.data as CompletionData | undefined;
    if (!data) return item;
    const details = context.project.service.getCompletionEntryDetails(context.file, data.offset, data.name, {}, data.source, {}, data.entry);
    if (!details) return item;
    const text = documentation(details.documentation, details.tags);
    return {
        ...item,
        detail: ts.displayPartsToString(details.displayParts),
        ...(text ? { documentation: { kind: MarkupKind.Markdown, value: text } } : {}),
    };
}

// ---- hover and signature help -------------------------------------------------

export function hover(context: WorkflowContext, position: Position): Hover | null {
    const { project, file, workflow } = context;
    const at = target(context, position);
    const info = at && project.service.getQuickInfoAtPosition(file, at.offset);
    if (!info) return headerHover(context, position);
    const notes = documentation(info.documentation, info.tags);
    return {
        contents: { kind: MarkupKind.Markdown, value: `\`\`\`typescript\n${ts.displayPartsToString(info.displayParts)}\n\`\`\`${notes ? `\n\n${notes}` : ''}` },
        range: at.range ?? workflow.range(info.textSpan.start, info.textSpan.length),
    };
}

export function signatureHelp({ project, file, workflow }: WorkflowContext, position: Position): SignatureHelp | null {
    const offset = workflow.offset(position);
    const help = offset === undefined ? undefined : project.service.getSignatureHelpItems(file, offset, {});
    if (!help) return null;
    return {
        activeSignature: help.selectedItemIndex,
        activeParameter: help.argumentIndex,
        signatures: help.items.map(item => {
            const parameters = item.parameters.map(parameter => ts.displayPartsToString(parameter.displayParts));
            const text = documentation(item.documentation, item.tags);
            return {
                label: ts.displayPartsToString(item.prefixDisplayParts) + parameters.join(ts.displayPartsToString(item.separatorDisplayParts))
                    + ts.displayPartsToString(item.suffixDisplayParts),
                ...(text ? { documentation: { kind: MarkupKind.Markdown, value: text } } : {}),
                parameters: item.parameters.map((parameter, index) => {
                    const note = ts.displayPartsToString(parameter.documentation);
                    return { label: parameters[index], ...(note ? { documentation: note } : {}) };
                }),
            };
        }),
    };
}

// ---- navigation --------------------------------------------------------------

export function definition(context: WorkflowContext, position: Position): Location[] {
    const at = target(context, position);
    if (!at) return [];
    return (context.project.service.getDefinitionAtPosition(context.file, at.offset) ?? [])
        .flatMap(item => context.project.location(item.fileName, item.textSpan.start, item.textSpan.length) ?? []);
}

/** Every use of the name at a position that the source shows: in code, as `@name` in blocks, and in other files. */
function occurrences(context: WorkflowContext, position: Position): (Location & { write: boolean })[] {
    const { project, file } = context;
    const at = target(context, position);
    if (!at) return [];
    const found = new Map<string, Location & { write: boolean }>();
    for (const group of project.service.findReferences(file, at.offset) ?? []) {
        for (const reference of group.references) {
            const location = project.location(reference.fileName, reference.textSpan.start, reference.textSpan.length);
            if (!location) continue;
            const key = `${location.uri}:${location.range.start.line}:${location.range.start.character}`;
            found.set(key, { ...location, write: reference.isWriteAccess || found.get(key)?.write === true });
        }
    }
    return [...found.values()].sort((a, b) => a.uri.localeCompare(b.uri)
        || a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character);
}

export function references(context: WorkflowContext, position: Position): Location[] {
    return occurrences(context, position).map(({ uri, range }) => ({ uri, range }));
}

export function documentHighlights(context: WorkflowContext, position: Position): DocumentHighlight[] {
    return occurrences(context, position).filter(item => item.uri === context.workflow.uri)
        .map(item => ({ range: item.range, kind: item.write ? DocumentHighlightKind.Write : DocumentHighlightKind.Read }));
}

export function prepareRename(context: WorkflowContext, position: Position): { range: Range; placeholder: string } | null {
    const { project, file, workflow } = context;
    const at = target(context, position);
    if (!at) return null;
    const info = project.service.getRenameInfo(file, at.offset, {});
    if (!info.canRename) return null;
    // Only names declared by workflows can change: not the library or other modules.
    const definitions = project.service.getDefinitionAtPosition(file, at.offset) ?? [];
    if (!definitions.length || definitions.some(item => !project.workflow(item.fileName))) return null;
    const range = at.range ?? workflow.range(info.triggerSpan.start, info.triggerSpan.length);
    return range ? { range, placeholder: info.displayName } : null;
}

export function rename(context: WorkflowContext, position: Position, newName: string): WorkspaceEdit | null {
    if (!/^[A-Za-z_$][\w$]*$/.test(newName) || !prepareRename(context, position)) return null;
    const changes: Record<string, TextEdit[]> = {};
    for (const { uri, range } of occurrences(context, position)) (changes[uri] ??= []).push({ range, newText: newName });
    return Object.keys(changes).length ? { changes } : null;
}

// ---- structure ---------------------------------------------------------------

export function documentSymbols({ project, file, workflow }: WorkflowContext): DocumentSymbol[] {
    const convert = (item: ts.NavigationTree): DocumentSymbol | undefined => {
        const whole = item.spans[0];
        const name = item.nameSpan ?? whole;
        if (!whole || !item.text || item.kind === ts.ScriptElementKind.alias || /^(?:<|__)/.test(item.text)) return undefined;
        // An output is declared by generated code: only its name has a place in the source.
        const selectionRange = workflow.range(name.start, name.length);
        return selectionRange && {
            name: item.text, kind: SYMBOL_KINDS[item.kind] ?? SymbolKind.Variable,
            range: workflow.range(whole.start, whole.length) ?? selectionRange, selectionRange,
            children: (item.childItems ?? []).flatMap(child => convert(child) ?? []),
        };
    };
    return (project.service.getNavigationTree(file).childItems ?? []).flatMap(item => convert(item) ?? []);
}

/** Blocks and Markdown comments fold as a whole; code folds the way TypeScript outlines it. */
export function foldingRanges({ project, file, workflow }: WorkflowContext): FoldingRange[] {
    const { virtual, scan } = workflow;
    const found: FoldingRange[] = [
        ...scan.regions.map(region => ({ startLine: region.line - 1, endLine: region.endLine - 1 })),
        ...scan.comments.map(comment => ({ startLine: comment.line - 1, endLine: comment.endLine - 1, kind: 'comment' })),
    ];
    for (const span of project.service.getOutliningSpans(file)) {
        const startLine = virtual.positionAt(span.textSpan.start).line;
        const endLine = virtual.positionAt(span.textSpan.start + span.textSpan.length).line;
        if (endLine >= scan.lines.length || workflow.region(startLine)) continue;
        found.push({ startLine, endLine, ...(span.kind === 'imports' || span.kind === 'comment' ? { kind: span.kind } : {}) });
    }
    return found.filter(range => range.endLine > range.startLine);
}
