import {
    DocumentHighlightKind, ErrorCodes, FoldingRangeKind, MarkupKind, ResponseError,
    SemanticTokensBuilder, SymbolKind,
    type DocumentHighlight, type FoldingRange, type Location, type Position, type Range,
    type SemanticTokens, type SignatureHelp, type SymbolInformation, type WorkspaceEdit,
} from 'vscode-languageserver/node';
import { tokenize, type Token } from '../../lang/src/lexer.js';
import { SplSyntaxError } from '../../lang/src/errors.js';
import { ASK_MODIFIER_NAMES, MODIFIER_NAMES } from '../../lang/src/parser.js';
import { builtins, keywords, modifiers, specialVariables } from './catalog';
import { nameAt, resolveBinding, tokenRange, type Analysis, type Binding, type NamedToken } from './features';

export const semanticTokenLegend = {
    tokenTypes: ['variable', 'parameter', 'function', 'class', 'struct', 'enum', 'type', 'keyword', 'property'],
    tokenModifiers: ['declaration', 'readonly', 'defaultLibrary'],
};

function occurrences(analysis: Analysis, binding: Binding): NamedToken[] {
    return analysis.names.filter(token => resolveBinding(analysis, token) === binding);
}

function lexicalBinding(analysis: Analysis, position: Position): Binding | undefined {
    const token = nameAt(analysis, position);
    const binding = token && resolveBinding(analysis, token);
    return binding?.property ? undefined : binding;
}

export function references(analysis: Analysis, position: Position, includeDeclaration: boolean): Location[] {
    const binding = lexicalBinding(analysis, position);
    if (!binding) return [];
    return occurrences(analysis, binding)
        .filter(token => includeDeclaration || token !== binding.token)
        .map(token => ({ uri: analysis.document.uri, range: tokenRange(token) }));
}

export function documentHighlights(analysis: Analysis, position: Position): DocumentHighlight[] {
    const binding = lexicalBinding(analysis, position);
    if (!binding) return [];
    return occurrences(analysis, binding).map(token => {
        const index = analysis.tokens.indexOf(token);
        const next = analysis.tokens[index + 1];
        const write = token === binding.token || (index >= 0 && next?.type === 'op' &&
            ['=', '+=', '-=', '*=', '/=', '//=', '%='].includes(next.value));
        return { range: tokenRange(token), kind: write ? DocumentHighlightKind.Write : DocumentHighlightKind.Read };
    });
}

export function prepareRename(analysis: Analysis, position: Position): { range: Range; placeholder: string } | undefined {
    const token = nameAt(analysis, position);
    if (!token || !lexicalBinding(analysis, position)) return undefined;
    return { range: tokenRange(token), placeholder: token.value };
}

export function rename(analysis: Analysis, position: Position, newName: string): WorkspaceEdit {
    const binding = lexicalBinding(analysis, position);
    const invalid = (message: string): never => { throw new ResponseError(ErrorCodes.InvalidParams, message); };
    if (!binding) return invalid('Only declared lexical SPL bindings can be renamed.');
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(newName) || Object.hasOwn(keywords, newName) ||
        Object.hasOwn(builtins, newName)) {
        return invalid('Use an SPL identifier that is not a keyword or built-in.');
    }
    if (newName !== binding.name) {
        if (analysis.bindings.some(other => other !== binding && other.scope === binding.scope && other.name === newName)) {
            return invalid(`Renaming to '${newName}' would conflict with another declaration.`);
        }
        const renamed = { binding, name: newName };
        for (const token of analysis.names) {
            const before = resolveBinding(analysis, token);
            const after = resolveBinding(analysis, token, renamed, before === binding ? newName : token.value);
            if (before !== after) return invalid(`Renaming to '${newName}' would capture or shadow another reference.`);
        }
    }
    return {
        documentChanges: [{
            textDocument: { uri: analysis.document.uri, version: analysis.document.version },
            edits: occurrences(analysis, binding).map(token => ({ range: tokenRange(token), newText: newName })),
        }],
    };
}

function tokenOffset(analysis: Analysis, token: Token): number {
    return analysis.document.offsetAt({ line: token.line - 1, character: token.col - 1 });
}

// Include interpolation expressions without treating raw/escaped string text as code.
function expressionTokens(analysis: Analysis, tokens = analysis.tokens): Token[] {
    const result: Token[] = [];
    const lines = analysis.document.getText().replace(/^\uFEFF/, '').split(/\r?\n/);
    for (const token of tokens) {
        result.push(token);
        if (token.type !== 'str') continue;
        for (const part of token.parts) {
            if (!('expr' in part)) continue;
            const indent = /^[ \t]*/.exec(lines[part.line - 1] ?? '')![0].length;
            try {
                result.push(...expressionTokens(analysis, tokenize(part.expr, {
                    inExpr: true, line: part.line, col: part.col, indent, allowUnclosedBrackets: true,
                })));
            } catch (error) {
                if (!(error instanceof SplSyntaxError)) throw error;
                // Parser diagnostics already describe an incomplete interpolation.
            }
        }
    }
    return result.sort((a, b) => tokenOffset(analysis, a) - tokenOffset(analysis, b));
}

interface Call {
    name?: NamedToken;
    open: Token;
    commas: number;
    declaration: boolean;
    modifier: boolean;
    argumentName?: string;
}

function signatureParameters(signature: string): { label: [number, number] }[] {
    const start = signature.indexOf('(');
    if (start < 0) return [];
    const parameters: { label: [number, number] }[] = [];
    let depth = 0;
    let from = start + 1;
    for (let i = from; i < signature.length; i++) {
        const char = signature[i];
        if ('(['.includes(char)) depth++;
        else if (')]'.includes(char)) {
            if (depth === 0) {
                if (signature.slice(from, i).trim()) parameters.push({ label: [from, i] });
                break;
            }
            depth--;
        } else if (char === ',' && depth === 0) {
            parameters.push({ label: [from, i] });
            from = i + 1;
            while (signature[from] === ' ') from++;
        }
    }
    return parameters;
}

export function signatureHelp(analysis: Analysis, position: Position): SignatureHelp | undefined {
    if (analysis.blocks && !analysis.blocks.some(block => block.kind === 'spl' &&
        position.line >= block.line - 1 && position.line < block.endLine)) return undefined;
    const at = analysis.document.offsetAt(position);
    const tokens = expressionTokens(analysis);
    const stack: Call[] = [];
    for (let i = 0; i < tokens.length && tokenOffset(analysis, tokens[i]) < at; i++) {
        const token = tokens[i];
        if (token.type !== 'op') {
            const call = stack.at(-1);
            if (call && token.type === 'name' && call.argumentName === undefined) call.argumentName = token.value;
            continue;
        }
        if (['(', '[', '{'].includes(token.value)) {
            const previous = tokens[i - 1];
            const before = tokens[i - 2];
            const name = previous?.type === 'name' && !(before?.type === 'op' && before.value === '.') ? previous : undefined;
            stack.push({
                open: token, name, commas: 0,
                declaration: before?.type === 'name' && before.value === 'def',
                modifier: !!name && ['ask', 'think', 'agent'].includes(name.value),
            });
        } else if ([')', ']', '}'].includes(token.value)) {
            stack.pop();
        } else if (token.value === ',') {
            const call = stack.at(-1);
            if (call) { call.commas++; call.argumentName = undefined; }
        }
    }
    const call = stack.at(-1);
    if (!call?.name || call.declaration || call.open.type !== 'op' || call.open.value !== '(') return undefined;
    const token = call.name;
    const binding = resolveBinding(analysis, token);
    if (binding && binding.kind !== SymbolKind.Function) return undefined;
    const help = binding ? { signature: binding.signature, description: 'Function in the current document.' } :
        builtins[token.value] ?? (call.modifier ? { signature: `${token.value}(${(token.value === 'ask' ? ASK_MODIFIER_NAMES : MODIFIER_NAMES)
            .map(name => `${name}=...`).join(', ')}) 'prompt'`,
            description: keywords[token.value] } : undefined);
    if (!help) return undefined;
    // Built-in overloads use " / " so division in a parameter description is not split.
    const labels = help.signature.split(' / ');
    const signatures = labels.filter(label => label.includes('(')).map(label => ({
        label, parameters: signatureParameters(label),
        documentation: { kind: MarkupKind.Markdown, value: help.description },
    }));
    if (!signatures.length) return undefined;
    const activeSignature = Math.max(0, signatures.findIndex(signature => signature.parameters.length > call.commas));
    const signature = signatures[activeSignature];
    const modifierIndex = call.modifier && call.argumentName
        ? signature.parameters.findIndex(parameter => signature.label.slice(...parameter.label).startsWith(`${call.argumentName}=`))
        : -1;
    return {
        signatures, activeSignature,
        activeParameter: modifierIndex >= 0 ? modifierIndex : Math.min(call.commas, Math.max(0, signature.parameters.length - 1)),
    };
}

export function foldingRanges(analysis: Analysis): FoldingRange[] {
    const result: FoldingRange[] = [];
    const seen = new Set<string>();
    const add = (startLine: number, endLine: number, kind?: FoldingRangeKind) => {
        const key = `${startLine}:${endLine}`;
        if (endLine > startLine && !seen.has(key)) {
            result.push({ startLine, endLine, ...(kind ? { kind } : {}) });
            seen.add(key);
        }
    };
    const indents: number[] = [];
    const brackets: Token[] = [];
    for (let i = 0; i < analysis.tokens.length; i++) {
        const token = analysis.tokens[i];
        if (token.type === 'indent') {
            let header = i - 1;
            while (analysis.tokens[header]?.type === 'nl') header--;
            indents.push((analysis.tokens[header]?.line ?? token.line - 1) - 1);
        }
        else if (token.type === 'dedent') {
            const start = indents.pop();
            let next = i + 1;
            while (analysis.tokens[next]?.type === 'dedent') next++;
            const eof = analysis.tokens[next]?.type === 'eof';
            if (start !== undefined) add(start, token.line - (eof && token.col > 1 ? 1 : 2));
        } else if (token.type === 'op' && ['(', '['].includes(token.value)) brackets.push(token);
        else if (token.type === 'op' && [')', ']'].includes(token.value)) {
            const open = brackets.pop();
            if (open) add(open.line - 1, token.line - 1);
        } else if (token.type === 'str') {
            const next = analysis.tokens[i + 1];
            if (next && next.line > token.line) {
                const text = analysis.document.getText().slice(tokenOffset(analysis, token), tokenOffset(analysis, next));
                const last = text.trimEnd().split(/\r?\n/).length - 1;
                add(token.line - 1, token.line - 1 + last);
            }
        }
    }
    for (const block of analysis.blocks ?? []) {
        if (block.kind === 'spl') add(block.line - 2, block.endLine);
        else add(block.line - 1, block.endLine - 1);
    }
    return result.sort((a, b) => a.startLine - b.startLine || b.endLine - a.endLine);
}

export function semanticTokens(analysis: Analysis): SemanticTokens {
    const builder = new SemanticTokensBuilder();
    const names = [...analysis.names].sort((a, b) => a.line - b.line || a.col - b.col);
    const kind = (binding: Binding): string => binding.signature.startsWith('parameter ') ? 'parameter' :
        binding.kind === SymbolKind.Function ? 'function' : binding.kind === SymbolKind.Enum ? 'enum' :
        binding.kind === SymbolKind.Struct ? 'struct' : binding.kind === SymbolKind.Class ? 'class' :
        binding.kind === SymbolKind.TypeParameter ? 'type' : 'variable';
    const codeTokens = expressionTokens(analysis);
    const locations = new Map(codeTokens.map((token, index) => [`${token.line}:${token.col}`, index]));
    let previous = '';
    for (const token of names) {
        const location = `${token.line}:${token.col}`;
        if (location === previous) continue;
        previous = location;
        const binding = resolveBinding(analysis, token);
        let type: string | undefined;
        let flags = 0;
        if (binding) {
            type = binding.property ? 'property' : kind(binding);
            if (binding.token === token) flags |= 1;
        } else if (Object.hasOwn(specialVariables, token.value)) {
            type = 'variable'; flags = 2 | 4;
        } else {
            const index = locations.get(location);
            const next = index === undefined ? undefined : codeTokens[index + 1];
            if (next?.type === 'op' && next.value === '=' && Object.hasOwn(modifiers, token.value)) type = 'property';
            else if (['bool', 'int', 'float', 'str', 'char', 'list', 'fn', 'unknown'].includes(token.value)) {
                type = 'type'; flags = 4;
            }             else if (token.value === 'type' && next?.type === 'name') type = 'keyword';
            else if (Object.hasOwn(keywords, token.value) && token.value !== 'type') type = 'keyword';
            else if (Object.hasOwn(builtins, token.value)) { type = 'function'; flags = 4; }
        }
        if (type) {
            const range = tokenRange(token);
            builder.push(range.start.line, range.start.character, token.value.length, semanticTokenLegend.tokenTypes.indexOf(type), flags);
        }
    }
    return builder.build();
}

export function workspaceSymbols(analyses: Iterable<Analysis>, query: string): SymbolInformation[] {
    const result: SymbolInformation[] = [];
    for (const analysis of analyses) {
        for (const binding of analysis.bindings) {
            if (binding.signature.startsWith('parameter ') || !binding.name.toLowerCase().includes(query.toLowerCase())) continue;
            const parent = analysis.bindings.find(candidate => candidate.functionScope === binding.scope);
            result.push({
                name: binding.name, kind: binding.kind,
                location: { uri: analysis.document.uri, range: tokenRange(binding.token) },
                ...(parent ? { containerName: parent.name } : {}),
            });
        }
    }
    return result;
}
