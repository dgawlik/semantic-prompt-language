import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import {
    CompletionItemKind, CompletionTriggerKind, DiagnosticSeverity, DocumentHighlightKind, InsertTextFormat, MarkupKind, SymbolKind,
    type CompletionContext, type CompletionItem, type Diagnostic, type DocumentHighlight, type DocumentSymbol, type Hover,
    type Location, type Position, type Range, type SignatureHelp, type TextEdit, type WorkspaceEdit,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { compileCell } from '../../lang/src/cell.js';
import { SplSyntaxError } from '../../lang/src/errors.js';
import { missingImport } from '../../lang/src/imports.js';
import { blockquoteText, controlCompletions, controlHelp, scanControls } from './blockquoteFeatures';
import { callable, library, markers } from './catalog';
import type { TypeScriptProject } from './typescriptService';
import { analyzeWorkflow, blockquoteAt, codeBlockAt, type Marker, type WorkflowAnalysis } from './workflow';

/** A workflow document together with its virtual TypeScript module. */
export interface WorkflowContext {
    analysis: WorkflowAnalysis;
    project: TypeScriptProject;
    /** Name of the virtual module in the project. */
    file: string;
    /** The virtual module text; fence positions equal document positions. */
    virtual: TextDocument;
}

/**
 * Analyzes a document and syncs its virtual module into the project. Returns undefined, and
 * releases the previous module, when the document is not a workflow.
 */
export function workflowContext(document: TextDocument, project: TypeScriptProject, previous?: WorkflowContext): WorkflowContext | undefined {
    const analysis = analyzeWorkflow(document);
    if (!analysis.workflow) {
        previous?.project.remove(previous.file);
        return undefined;
    }
    const extension = analysis.language === 'ts' ? 'mts' : 'mjs';
    let file = previous?.file;
    if (!file || previous!.project !== project || !file.endsWith(extension)) {
        previous?.project.remove(previous.file);
        file = project.allocate(extension);
    }
    project.update(file, analysis.virtual);
    return {
        analysis, project, file,
        virtual: TextDocument.create(`${document.uri}#code`, extension === 'mts' ? 'typescript' : 'javascript', document.version, analysis.virtual),
    };
}

interface SharedBinding {
    name: string;
    kind: 'function' | 'type' | 'variable';
    detail: string;
    /** Where the name is declared: an offset in the virtual module, or another file. */
    offset?: number;
    external?: { file: string; offset: number };
    marker?: Marker;
}

export interface CompletionData {
    uri: string;
    offset: number;
    name: string;
    source?: string;
    entry?: ts.CompletionEntryData;
}

const TS_TRIGGERS = new Set(['.', '"', "'", '`', '/', '@', '<', '#', ' ']);
const WORD = /[A-Za-z_$][\w$]*/g;

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
    [ts.ScriptElementKind.enumElement]: SymbolKind.Enum,
    [ts.ScriptElementKind.constElement]: SymbolKind.Constant,
    [ts.ScriptElementKind.memberVariableElement]: SymbolKind.Property,
    [ts.ScriptElementKind.memberGetAccessorElement]: SymbolKind.Property,
    [ts.ScriptElementKind.alias]: SymbolKind.Variable,
};

function span(document: TextDocument, start: number, length: number): Range {
    return { start: document.positionAt(start), end: document.positionAt(start + length) };
}

function documentation(parts: ts.SymbolDisplayPart[] | undefined, tags: ts.JSDocTagInfo[] | undefined): string {
    const text = ts.displayPartsToString(parts);
    const extra = (tags ?? []).map(tag => `*@${tag.name}*${tag.text?.length ? ` ${ts.displayPartsToString(tag.text)}` : ''}`);
    return [text, ...extra].filter(Boolean).join('\n\n');
}

/** The identifier around a position on its line, if any. */
function wordAt(document: TextDocument, position: Position): { text: string; start: number } | undefined {
    const line = document.getText({ start: { line: position.line, character: 0 }, end: { line: position.line + 1, character: 0 } });
    for (const match of line.matchAll(WORD)) {
        if (match.index <= position.character && position.character <= match.index + match[0].length) return { text: match[0], start: match.index };
    }
    return undefined;
}

function markerAt(analysis: WorkflowAnalysis, position: Position): Marker | undefined {
    return analysis.markers.find(marker => marker.line === position.line &&
        position.character >= marker.character - 1 && position.character <= marker.character + marker.name.length);
}

/** Top-level bindings of the workflow: fence declarations, library globals and names saved by agents. */
function sharedBindings(context: WorkflowContext, names?: ReadonlySet<string>): SharedBinding[] {
    const program = context.project.service.getProgram();
    const source = program?.getSourceFile(context.file);
    if (!program || !source) return [];
    const checker = program.getTypeChecker();
    const bindings: SharedBinding[] = [];
    for (const symbol of checker.getSymbolsInScope(source.endOfFileToken, ts.SymbolFlags.Value)) {
        const name = symbol.getName();
        if (names ? !names.has(name) : false) continue;
        const declaration = symbol.declarations?.[0];
        if (!declaration) continue;
        const file = declaration.getSourceFile();
        const own = file === source;
        if (!own && !Object.hasOwn(library, name)) continue;
        const identifier = ts.getNameOfDeclaration(declaration) ?? declaration;
        const offset = identifier.getStart(file);
        const type = checker.getTypeOfSymbolAtLocation(symbol, source.endOfFileToken);
        const detail = checker.typeToString(type).slice(0, 400);
        const schema = ['Type', 'StructType'].includes(type.getSymbol()?.getName() ?? '');
        const ambient = own && offset >= context.analysis.mirrored ? context.analysis.ambient.find(item => item.name === name) : undefined;
        bindings.push({
            name, detail,
            kind: schema ? 'type' : type.getCallSignatures().length || symbol.flags & ts.SymbolFlags.Function ? 'function' : 'variable',
            ...(own ? { offset } : { external: { file: file.fileName, offset } }),
            ...(ambient ? { marker: ambient.marker } : {}),
        });
    }
    return bindings;
}

function bindingLocation(context: WorkflowContext, binding: SharedBinding): Location | undefined {
    const uri = context.analysis.document.uri;
    if (binding.marker) return { uri, range: { start: { line: binding.marker.line, character: binding.marker.character }, end: { line: binding.marker.line, character: binding.marker.character + binding.name.length } } };
    if (binding.offset !== undefined) return { uri, range: span(context.virtual, binding.offset, binding.name.length) };
    if (!binding.external) return undefined;
    const start = context.project.position(binding.external.file, binding.external.offset);
    return start && { uri: pathToFileURL(binding.external.file).href, range: { start, end: { line: start.line, character: start.character + binding.name.length } } };
}

// ---- diagnostics ------------------------------------------------------------

export function diagnostics(context: WorkflowContext): Diagnostic[] {
    const { analysis, project, file, virtual } = context;
    const result = [...analysis.diagnostics];
    for (const block of analysis.blocks) {
        if (block.kind !== 'code' || block.language !== 'js') continue;
        try {
            for (const item of compileCell(block.text, { line: block.line }).imports) {
                const missing = missingImport(project.base, item.specifier);
                if (!missing) continue;
                result.push({
                    range: { start: { line: item.line - 1, character: item.column - 1 }, end: { line: item.line - 1, character: item.column - 1 + 'import'.length } },
                    severity: DiagnosticSeverity.Error, source: 'spl',
                    message: `cannot find module '${item.specifier}' (imports resolve against the working directory ${project.base})`,
                });
            }
        } catch (error) {
            if (!(error instanceof SplSyntaxError)) throw error;
        }
    }
    const typed = analysis.blocks.filter(block => block.kind === 'code' && block.language === 'ts');
    if (!typed.length) return result;
    const severity: Record<ts.DiagnosticCategory, DiagnosticSeverity> = {
        [ts.DiagnosticCategory.Error]: DiagnosticSeverity.Error, [ts.DiagnosticCategory.Warning]: DiagnosticSeverity.Warning,
        [ts.DiagnosticCategory.Suggestion]: DiagnosticSeverity.Hint, [ts.DiagnosticCategory.Message]: DiagnosticSeverity.Information,
    };
    for (const item of [...project.service.getSyntacticDiagnostics(file), ...project.service.getSemanticDiagnostics(file)]) {
        if (item.start === undefined || item.start >= analysis.mirrored) continue;
        const range = span(virtual, item.start, item.length ?? 1);
        if (!typed.some(block => range.start.line + 1 >= block.line && range.start.line + 1 <= block.endLine)) continue;
        result.push({
            range, severity: severity[item.category], source: 'ts', code: item.code,
            message: ts.flattenDiagnosticMessageText(item.messageText, '\n'),
        });
    }
    return result;
}

// ---- completion -------------------------------------------------------------

function blockquoteCompletions(context: WorkflowContext, position: Position): CompletionItem[] {
    const { analysis } = context;
    const block = blockquoteAt(analysis, position)!;
    const document = analysis.document;
    const quote = blockquoteText(document, block);
    const at = document.offsetAt(position) - quote.from;
    const range = (from: number, to: number): Range => ({ start: document.positionAt(quote.from + from), end: document.positionAt(quote.from + to) });
    const controls = controlCompletions(quote.text, at, range, analysis.model);
    if (controls) return controls;
    const before = quote.text.slice(0, at);
    const schema = /(?<![\w@\\])@validate[ \t]*\[[ \t]*([A-Za-z_$][\w$]*)?$/i.exec(before);
    const reference = /(?<![\w@\\])@([A-Za-z_$][\w$]*)?$/.exec(before);
    if (!schema && !reference) return [];
    const typed = schema?.[1] ?? reference?.[1] ?? '';
    const replace = range(at - typed.length, at);
    const start = document.offsetAt({ line: block.line - 1, character: 0 });
    const items: CompletionItem[] = [];
    for (const binding of sharedBindings(context)) {
        if (schema && binding.kind !== 'type') continue;
        const own = binding.offset !== undefined || binding.marker !== undefined;
        // Fences below this blockquote have not run yet; agents can only use what exists.
        if (binding.offset !== undefined && !binding.marker && binding.offset > start) continue;
        if (!own && !callable.includes(binding.name)) continue;
        items.push({
            label: binding.name,
            kind: binding.kind === 'function' ? CompletionItemKind.Function : binding.kind === 'type' ? CompletionItemKind.Struct : CompletionItemKind.Variable,
            detail: own ? binding.detail : library[binding.name].signature,
            ...(own ? {} : { documentation: library[binding.name].description }),
            sortText: `${own ? '0' : '2'}${binding.name}`,
            textEdit: { range: replace, newText: binding.name },
        });
    }
    if (!schema) {
        const opening = !before.slice(0, reference!.index).trim();
        for (const [name, help] of Object.entries(markers)) {
            if ((name === 'ctl' || name === 'codegen') && !opening && !(name === 'codegen' && scanControls(quote.text)?.closed)) continue;
            items.push({
                label: help.signature.slice(1).split(/[\s(['.]/)[0], kind: CompletionItemKind.Keyword,
                detail: help.signature, documentation: help.description, sortText: `1${name}`,
                insertTextFormat: InsertTextFormat.Snippet, textEdit: { range: replace, newText: help.insert },
            });
        }
    }
    return items;
}

export function completions(context: WorkflowContext, position: Position, trigger?: CompletionContext): CompletionItem[] {
    const { analysis, project, file, virtual } = context;
    if (blockquoteAt(analysis, position)) return blockquoteCompletions(context, position);
    if (!codeBlockAt(analysis, position)) return [];
    const character = trigger?.triggerKind === CompletionTriggerKind.TriggerCharacter ? trigger.triggerCharacter : undefined;
    if (character && !TS_TRIGGERS.has(character)) return [];
    const offset = virtual.offsetAt(position);
    const info = project.service.getCompletionsAtPosition(file, offset, {
        triggerCharacter: character as ts.CompletionsTriggerCharacter | undefined,
        includeCompletionsWithInsertText: true, includeCompletionsForModuleExports: false,
    });
    if (!info) return [];
    return info.entries.map((entry): CompletionItem => {
        const replacement = entry.replacementSpan ?? info.optionalReplacementSpan;
        const data: CompletionData = { uri: analysis.document.uri, offset, name: entry.name, source: entry.source, entry: entry.data };
        return {
            label: entry.name,
            kind: COMPLETION_KINDS[entry.kind] ?? CompletionItemKind.Text,
            sortText: entry.sortText,
            ...(entry.isRecommended ? { preselect: true } : {}),
            ...(entry.kindModifiers?.includes('deprecated') ? { tags: [1] } : {}),
            ...(replacement && replacement.start < analysis.mirrored
                ? { textEdit: { range: span(virtual, replacement.start, replacement.length), newText: entry.insertText ?? entry.name } }
                : entry.insertText ? { insertText: entry.insertText } : {}),
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
    const { analysis, project, file, virtual } = context;
    const code = (text: string, notes: string): Hover => ({
        contents: { kind: MarkupKind.Markdown, value: `\`\`\`typescript\n${text}\n\`\`\`${notes ? `\n\n${notes}` : ''}` },
    });
    if (codeBlockAt(analysis, position)) {
        const info = project.service.getQuickInfoAtPosition(file, virtual.offsetAt(position));
        if (!info) return null;
        return { ...code(ts.displayPartsToString(info.displayParts), documentation(info.documentation, info.tags)), range: span(virtual, info.textSpan.start, info.textSpan.length) };
    }
    const block = blockquoteAt(analysis, position);
    if (!block) return null;
    const marker = markerAt(analysis, position);
    if (!marker) {
        const quote = blockquoteText(analysis.document, block);
        const at = analysis.document.offsetAt(position) - quote.from;
        const token = scanControls(quote.text)?.tokens.find(token => token.kind === 'name' && token.from <= at && at <= token.to);
        const help = token && Object.hasOwn(controlHelp, token.value) ? controlHelp[token.value as keyof typeof controlHelp] : undefined;
        return help ? { contents: { kind: MarkupKind.Markdown, value: `\`${help.signature}\`\n\n${help.description}` } } : null;
    }
    const range = { start: { line: marker.line, character: marker.character - 1 }, end: { line: marker.line, character: marker.character + marker.name.length } };
    const binding = sharedBindings(context, new Set([marker.name]))[0];
    if (binding && (binding.offset !== undefined || binding.marker)) {
        if (binding.marker) return { ...code(`let ${binding.name}: ${binding.detail}`, 'Saved by a blockquote agent.'), range };
        const info = project.service.getQuickInfoAtPosition(file, binding.offset!);
        if (info) return { ...code(ts.displayPartsToString(info.displayParts), documentation(info.documentation, info.tags)), range };
    }
    const fixed = Object.hasOwn(markers, marker.name.toLowerCase()) ? markers[marker.name.toLowerCase()] : undefined;
    const help = fixed ?? (Object.hasOwn(library, marker.name) ? library[marker.name] : undefined);
    return help ? { contents: { kind: MarkupKind.Markdown, value: `\`${help.signature}\`\n\n${help.description}` }, range } : null;
}

export function signatureHelp(context: WorkflowContext, position: Position): SignatureHelp | null {
    if (!codeBlockAt(context.analysis, position)) return null;
    const help = context.project.service.getSignatureHelpItems(context.file, context.virtual.offsetAt(position), {});
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

/** Maps a span of the program to an editor location; generated declarations point at their blockquote marker. */
function location(context: WorkflowContext, file: string, start: number, length: number): Location | undefined {
    const { analysis, project, virtual } = context;
    if (project.same(file, context.file)) {
        if (start < analysis.mirrored) return { uri: analysis.document.uri, range: span(virtual, start, length) };
        const ambient = analysis.ambient.find(item => item.offset === start);
        return ambient && {
            uri: analysis.document.uri,
            range: { start: { line: ambient.marker.line, character: ambient.marker.character }, end: { line: ambient.marker.line, character: ambient.marker.character + ambient.name.length } },
        };
    }
    if (project.owns(file)) return undefined;
    const from = project.position(file, start);
    const to = project.position(file, start + length);
    return from && to ? { uri: pathToFileURL(file).href, range: { start: from, end: to } } : undefined;
}

/** The offset in the virtual module a position stands for: code as is, markers through their declaration. */
function target(context: WorkflowContext, position: Position): { offset: number; name?: string; binding?: SharedBinding } | undefined {
    if (codeBlockAt(context.analysis, position)) {
        return { offset: context.virtual.offsetAt(position), name: wordAt(context.virtual, position)?.text };
    }
    const marker = markerAt(context.analysis, position);
    if (!marker) return undefined;
    const binding = sharedBindings(context, new Set([marker.name]))[0];
    if (!binding) return undefined;
    const ambient = context.analysis.ambient.find(item => item.name === marker.name);
    const offset = ambient?.offset ?? binding.offset;
    return offset === undefined ? { offset: -1, name: marker.name, binding } : { offset, name: marker.name, binding };
}

export function definition(context: WorkflowContext, position: Position): Location[] {
    const at = target(context, position);
    if (!at) return [];
    if (at.binding) {
        const found = bindingLocation(context, at.binding);
        return found ? [found] : [];
    }
    return (context.project.service.getDefinitionAtPosition(context.file, at.offset) ?? [])
        .flatMap(item => location(context, item.fileName, item.textSpan.start, item.textSpan.length) ?? []);
}

/** Every use of the binding at a position: code references plus `@name` markers of shared bindings. */
function occurrences(context: WorkflowContext, position: Position): { range: Range; write: boolean }[] {
    const { analysis, project, file, virtual } = context;
    const at = target(context, position);
    if (!at || at.offset < 0) return [];
    const found: { range: Range; write: boolean }[] = [];
    // Only top-level bindings are visible to blockquotes; a local of the same name is not.
    const top = at.name ? sharedBindings(context, new Set([at.name]))[0] : undefined;
    let shared = at.binding !== undefined;
    for (const group of project.service.findReferences(file, at.offset) ?? []) {
        if (!project.same(group.definition.fileName, file)) continue;
        shared ||= top?.offset === group.definition.textSpan.start;
        for (const reference of group.references) {
            if (!project.same(reference.fileName, file) || reference.textSpan.start >= analysis.mirrored) continue;
            found.push({ range: span(virtual, reference.textSpan.start, reference.textSpan.length), write: reference.isWriteAccess });
        }
    }
    if (shared && at.name) {
        for (const marker of analysis.markers) {
            if (marker.name !== at.name) continue;
            found.push({
                range: { start: { line: marker.line, character: marker.character }, end: { line: marker.line, character: marker.character + marker.name.length } },
                write: marker.output,
            });
        }
    }
    return found.sort((a, b) => a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character);
}

export function references(context: WorkflowContext, position: Position): Location[] {
    return occurrences(context, position).map(item => ({ uri: context.analysis.document.uri, range: item.range }));
}

export function documentHighlights(context: WorkflowContext, position: Position): DocumentHighlight[] {
    return occurrences(context, position).map(item => ({ range: item.range, kind: item.write ? DocumentHighlightKind.Write : DocumentHighlightKind.Read }));
}

export function prepareRename(context: WorkflowContext, position: Position): { range: Range; placeholder: string } | null {
    const at = target(context, position);
    if (!at || at.offset < 0) return null;
    const info = context.project.service.getRenameInfo(context.file, at.offset, {});
    if (!info.canRename) return null;
    // Only names declared by this workflow can change: not the library, imports or other files.
    const definitions = context.project.service.getDefinitionAtPosition(context.file, at.offset) ?? [];
    if (!definitions.length || definitions.some(item => !context.project.same(item.fileName, context.file))) return null;
    const marker = markerAt(context.analysis, position);
    const range = marker
        ? { start: { line: marker.line, character: marker.character }, end: { line: marker.line, character: marker.character + marker.name.length } }
        : span(context.virtual, info.triggerSpan.start, info.triggerSpan.length);
    return { range, placeholder: info.displayName };
}

export function rename(context: WorkflowContext, position: Position, newName: string): WorkspaceEdit | null {
    if (!/^[A-Za-z_$][\w$]*$/.test(newName) || !prepareRename(context, position)) return null;
    const edits: TextEdit[] = occurrences(context, position).map(item => ({ range: item.range, newText: newName }));
    return edits.length ? { changes: { [context.analysis.document.uri]: edits } } : null;
}

export function documentSymbols(context: WorkflowContext): DocumentSymbol[] {
    const { analysis, virtual } = context;
    const convert = (item: ts.NavigationTree): DocumentSymbol | undefined => {
        const whole = item.spans[0];
        if (!whole || whole.start >= analysis.mirrored || !item.text || item.text.startsWith('<')) return undefined;
        const range = span(virtual, whole.start, whole.length);
        return {
            name: item.text, kind: SYMBOL_KINDS[item.kind] ?? SymbolKind.Variable, range,
            selectionRange: item.nameSpan ? span(virtual, item.nameSpan.start, item.nameSpan.length) : range,
            children: (item.childItems ?? []).flatMap(child => convert(child) ?? []),
        };
    };
    return (context.project.service.getNavigationTree(context.file).childItems ?? []).flatMap(item => convert(item) ?? []);
}
