import {
    CompletionItemKind, DiagnosticSeverity, MarkupKind, SymbolKind,
    type CompletionItem, type Diagnostic, type DocumentSymbol, type Hover, type Location,
    type Position, type Range,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { Failure, SplSyntaxError } from '../../lang/src/errors.js';
import { checkProgram } from '../../lang/src/type-check.js';
import { tokenize, type Token } from '../../lang/src/lexer.js';
import { ASK_MODIFIER_NAMES, LOG_MODIFIER_NAMES, MODIFIER_NAMES, parse } from '../../lang/src/parser.js';
import { extractMarkdown, isWorkflowMarkdown, parseMarkdown, type MarkdownBlock } from '../../lang/src/markdown.js';
import { builtins, keywords, modifiers, specialVariables, type Help } from './catalog';

export type NamedToken = Extract<Token, { type: 'name' }>;

interface Scope {
    start: number;
    end: number;
    includesEnd?: boolean;
    parent?: Scope;
}

function contains(scope: Scope, at: number): boolean {
    return scope.start <= at && (at < scope.end || (scope.includesEnd === true && at === scope.end));
}

export interface Binding {
    name: string;
    token: NamedToken;
    scope: Scope;
    signature: string;
    kind: SymbolKind;
    end: number;
    functionScope?: Scope;
    property?: boolean;
    parameters?: NamedToken[];
}

export interface Analysis {
    document: TextDocument;
    diagnostics: Diagnostic[];
    tokens: Token[];
    names: NamedToken[];
    scopes: Scope[];
    bindings: Binding[];
    blocks?: MarkdownBlock[];
}

export function tokenRange(token: NamedToken): Range {
    return {
        start: { line: token.line - 1, character: token.col - 1 },
        end: { line: token.line - 1, character: token.col - 1 + token.value.length },
    };
}

function offset(document: TextDocument, token: Token): number {
    return document.offsetAt({ line: token.line - 1, character: token.col - 1 });
}

function isName(token: Token | undefined): token is NamedToken {
    return token?.type === 'name';
}

function isOp(token: Token | undefined, value: string): boolean {
    return token?.type === 'op' && token.value === value;
}

function interpolationNames(tokens: Token[], lines: string[]): NamedToken[] {
    const names: NamedToken[] = [];
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        if (isName(token) && !isOp(tokens[i - 1], '.')) names.push(token);
        if (token.type === 'str') {
            for (const part of token.parts) {
                if ('expr' in part) {
                    const indent = /^[ \t]*/.exec(lines[part.line - 1] ?? '')![0].length;
                    names.push(...interpolationNames(tokenize(part.expr, { inExpr: true, line: part.line, col: part.col, indent }), lines));
                }
            }
        }
    }
    return names;
}

export function analyze(document: TextDocument): Analysis {
    let source = document.getText();
    let blocks: MarkdownBlock[] | undefined;
    if (document.languageId === 'markdown') {
        if (!isWorkflowMarkdown(source)) {
            return { document, diagnostics: [], tokens: [], names: [], scopes: [], bindings: [], blocks: [] };
        }
        blocks = [];
    }
    const diagnostics: Diagnostic[] = [];
    try {
        if (blocks) {
            const extracted = extractMarkdown(source);
            blocks = extracted.blocks;
            source = extracted.code;
            checkProgram(parseMarkdown(document.getText()));
        } else {
            checkProgram(parse(source));
        }
    } catch (error) {
        if (!(error instanceof SplSyntaxError) && !(error instanceof Failure)) throw error;
        const start = document.positionAt(document.offsetAt({
            line: Math.max(0, error.line - 1),
            character: error instanceof SplSyntaxError ? error.col - 1 : 0,
        }));
        const end = document.positionAt(Math.min(document.getText().length, document.offsetAt(start) + 1));
        diagnostics.push({
            range: { start, end },
            severity: DiagnosticSeverity.Error,
            source: 'spl',
            message: error.message,
        });
    }

    let tokens: Token[] = [];
    let names: NamedToken[] = [];
    try {
        tokens = blocks
            ? blocks.filter(block => block.kind === 'spl').flatMap(block =>
                tokenize('\n'.repeat(block.line - 1) + block.text, { allowUnclosedBrackets: true }))
            : tokenize(source, { allowUnclosedBrackets: true });
        names = interpolationNames(tokens, source.split(/\r?\n/));
        for (const block of blocks ?? []) {
            if (block.kind !== 'natural') continue;
            const lines = document.getText().split(/\r?\n/);
            for (let line = block.line; line <= block.endLine; line++) {
                for (const match of lines[line - 1].matchAll(/(?<![\w@])@([A-Za-z_]\w*)/g)) {
                    names.push({ type: 'name', value: match[1], line, col: match.index + 2 });
                }
            }
        }
    } catch (error) {
        if (!(error instanceof SplSyntaxError)) throw error;
        // Lexically incomplete documents still get parser diagnostics and static completions.
    }

    const root: Scope = { start: 0, end: document.getText().length, includesEnd: true };
    const scopes: Scope[] = [root];
    const bindings: Binding[] = [];
    const suiteEnds = new Map<number, number>();
    const objectSuites = new Set<number>();
    const classSuites = new Set<number>();
    const opens: number[] = [];
    for (let i = 0; i < tokens.length; i++) {
        if (tokens[i].type === 'indent') {
            opens.push(i);
            let header = i - 1;
            while (tokens[header]?.type === 'nl') header--;
            const introducer = tokens[header - 1];
            if (isOp(tokens[header], ':') && isName(introducer) && introducer.value === 'object') {
                objectSuites.add(i);
            }
        }
        if (tokens[i].type === 'dedent') {
            const open = opens.pop();
            if (open !== undefined) suiteEnds.set(open, i);
        }
    }
    const currentScope = (at: number) => scopes.findLast((scope) => contains(scope, at)) ?? root;
    const suiteScopes = new Map<number, Scope>();
    const blockScope = (open: number, parent: Scope): Scope => {
        const existing = suiteScopes.get(open);
        if (existing) return existing;
        const close = suiteEnds.get(open);
        let next = close === undefined ? tokens.length : close + 1;
        while (tokens[next]?.type === 'dedent') next++;
        const scope = {
            start: offset(document, tokens[open]),
            end: close === undefined ? source.length : offset(document, tokens[close]),
            includesEnd: tokens[next]?.type === 'eof' && tokens[next].col > 1,
            parent,
        };
        suiteScopes.set(open, scope);
        scopes.push(scope);
        return scope;
    };
    const bodyOpen = (start: number): number | undefined => {
        for (let j = start; j < tokens.length; j++) {
            const token = tokens[j];
            if (token.type === 'eof' || isOp(token, ';')) return undefined;
            if (token.type === 'nl') {
                while (tokens[j]?.type === 'nl') j++;
                return tokens[j]?.type === 'indent' ? j : undefined;
            }
        }
        return undefined;
    };
    const add = (token: NamedToken, scope: Scope, signature: string, kind: SymbolKind = SymbolKind.Variable): Binding => {
        const binding = { name: token.value, token, scope, signature, kind, end: offset(document, token) + token.value.length };
        bindings.push(binding);
        return binding;
    };

    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        if (token.type === 'indent' && !objectSuites.has(i)) blockScope(i, currentScope(offset(document, token)));
        if (!isName(token) || isOp(tokens[i - 1], '.')) continue;
        const scope = currentScope(offset(document, token));
        const name = tokens[i + 1];
        let enclosingSuite: number | undefined;
        for (const [start, finish] of suiteEnds) {
            if (start < i && i < finish && (enclosingSuite === undefined || start > enclosingSuite)) enclosingSuite = start;
        }
        if (enclosingSuite !== undefined && classSuites.has(enclosingSuite) && isOp(name, ':') &&
            ['nl', 'indent', 'dedent'].includes(tokens[i - 1]?.type)) {
            let end = i + 2;
            while (end < tokens.length && tokens[end].type !== 'nl' && tokens[end].type !== 'eof' && !isOp(tokens[end], '=')) end++;
            const binding = add(token, scope, document.getText().slice(offset(document, token),
                offset(document, tokens[end])).trim(), SymbolKind.Field);
            binding.property = true;
        } else if ((token.value === 'let' || token.value === 'except') && isName(name)) {
            const open = token.value === 'except' ? bodyOpen(i + 2) : undefined;
            let end = i + 2;
            while (end < tokens.length && tokens[end].type !== 'nl' && tokens[end].type !== 'eof' && !isOp(tokens[end], '=')) end++;
            add(name, open === undefined ? scope : blockScope(open, scope),
                token.value === 'let'
                    ? document.getText().slice(offset(document, token), offset(document, tokens[end])).trim()
                    : `except ${name.value}`);
        } else if (['type', 'enum', 'struct', 'class'].includes(token.value) && isName(name)) {
            const open = ['type', 'enum'].includes(token.value) ? undefined : bodyOpen(i + 2);
            const binding = add(name, scope, `${token.value} ${name.value}`,
                token.value === 'type' ? SymbolKind.TypeParameter :
                token.value === 'enum' ? SymbolKind.Enum : token.value === 'struct' ? SymbolKind.Struct : SymbolKind.Class);
            if (token.value === 'type') {
                let end = i + 2;
                while (end < tokens.length && tokens[end].type !== 'nl' && tokens[end].type !== 'eof' && !isOp(tokens[end], ';')) end++;
                binding.signature = document.getText().slice(offset(document, token), offset(document, tokens[end])).trim();
            }
            if (open !== undefined) {
                const close = suiteEnds.get(open);
                binding.end = close === undefined ? source.length : offset(document, tokens[close]);
                binding.functionScope = blockScope(open, scope);
                classSuites.add(open);
            }
        } else if (token.value === 'for') {
            const open = bodyOpen(i + 1);
            const loopScope = open === undefined ? scope : blockScope(open, scope);
            for (let j = i + 1; j < tokens.length; j++) {
                const variable = tokens[j];
                if (isName(variable) && variable.value === 'in') break;
                if (isName(variable)) add(variable, loopScope, `for ${variable.value}`);
                else if (!isOp(variable, ',')) break;
            }
        } else if (token.value === 'def' && isName(name) && isOp(tokens[i + 2], '(')) {
            const params: NamedToken[] = [];
            let j = i + 3;
            let depth = 0;
            let parameterStart = true;
            while (j < tokens.length) {
                const param = tokens[j];
                if (depth === 0 && isOp(param, ')')) break;
                if (depth === 0 && parameterStart && isName(param)) {
                    params.push(param);
                    parameterStart = false;
                }
                if (isOp(param, '(') || isOp(param, '[')) depth++;
                else if (isOp(param, ')') || isOp(param, ']')) depth--;
                else if (depth === 0 && isOp(param, ',')) parameterStart = true;
                j++;
            }
            const open = bodyOpen(j + 1);
            if (open === undefined) continue;
            const close = suiteEnds.get(open);
            const end = close === undefined ? source.length : offset(document, tokens[close]);
            const functionScope = blockScope(open, scope);
            let signatureEnd = j + 1;
            while (signatureEnd < tokens.length && !isOp(tokens[signatureEnd], ':') && tokens[signatureEnd].type !== 'nl') signatureEnd++;
            const binding = add(name, scope,
                document.getText().slice(offset(document, token), offset(document, tokens[signatureEnd])).trim(), SymbolKind.Function);
            binding.property = enclosingSuite !== undefined && (objectSuites.has(enclosingSuite) || classSuites.has(enclosingSuite));
            binding.end = end;
            binding.functionScope = functionScope;
            binding.parameters = params;
            for (const param of params) add(param, functionScope, `parameter ${param.value}`);
        }
    }
    return { document, diagnostics, tokens, names, scopes, bindings, blocks };
}

function scopeAt(analysis: Analysis, at: number): Scope {
    return analysis.scopes.findLast((scope) => contains(scope, at)) ?? analysis.scopes[0];
}

function visibleBindings(analysis: Analysis, at: number, renamed?: { binding: Binding; name: string }): Binding[] {
    const result = new Map<string, Binding>();
    for (let scope: Scope | undefined = scopeAt(analysis, at); scope; scope = scope.parent) {
        const local = analysis.bindings.filter((binding) => binding.scope === scope && !binding.property);
        const visible = new Map<string, Binding>();
        for (const binding of local) {
            if (offset(analysis.document, binding.token) <= at) {
                visible.set(binding === renamed?.binding ? renamed.name : binding.name, binding);
            }
        }
        for (const [name, binding] of visible) if (!result.has(name)) result.set(name, binding);
    }
    return [...result.values()];
}

export function nameAt(analysis: Analysis, position: Position): NamedToken | undefined {
    return analysis.names.find((token) =>
        token.line - 1 === position.line && token.col - 1 <= position.character &&
        position.character < token.col - 1 + token.value.length);
}

export function resolveBinding(
    analysis: Analysis, token: NamedToken, renamed?: { binding: Binding; name: string }, name = token.value,
): Binding | undefined {
    const at = offset(analysis.document, token);
    const next = analysis.tokens.find((candidate) => offset(analysis.document, candidate) >= at + token.value.length);
    if (modifierContext(analysis, at) && isOp(next, '=')) return undefined;
    return analysis.bindings.find((candidate) => candidate.token === token) ??
        visibleBindings(analysis, at, renamed).find((candidate) =>
            (candidate === renamed?.binding ? renamed.name : candidate.name) === name);
}

function modifierContext(analysis: Analysis, at: number): 'ask' | 'call' | 'directive' | 'log' | undefined {
    const stack: { op: string; context?: 'ask' | 'call' | 'directive' | 'log' }[] = [];
    const tokens = analysis.tokens;
    for (let i = 0; i < tokens.length && offset(analysis.document, tokens[i]) < at; i++) {
        const token = tokens[i];
        if (token.type !== 'op') continue;
        if (['{', '(', '['].includes(token.value)) {
            const previous = tokens[i - 1];
            const beforePrevious = tokens[i - 2];
            const first = tokens[i + 1];
            const logOptions = isName(first)
                ? isOp(tokens[i + 2], '=') || 'level'.startsWith(first.value)
                : first?.type === 'eof' || isOp(first, ')');
            const context = token.value !== '(' ? undefined : isOp(previous, '@') ? 'directive' :
                isOp(beforePrevious, '.') ? undefined :
                isName(previous) && previous.value === 'log' && logOptions ? 'log' :
                isName(previous) && previous.value === 'ask' ? 'ask' :
                isName(previous) && ['think', 'agent'].includes(previous.value) ? 'call' : undefined;
            stack.push({ op: token.value, context });
        } else if (['}', ')', ']'].includes(token.value)) {
            stack.pop();
        }
    }
    return stack.at(-1)?.context;
}

export function completions(analysis: Analysis, position: Position): CompletionItem[] {
    if (analysis.blocks && !analysis.blocks.some((block) => position.line >= block.line - 1 && position.line < block.endLine)) return [];
    const at = analysis.document.offsetAt(position);
    const prefix = /\$[A-Za-z0-9_]*$|[A-Za-z_][A-Za-z0-9_]*$/.exec(analysis.document.getText().slice(0, at))?.[0] ?? '';
    const range = { start: analysis.document.positionAt(at - prefix.length), end: position };
    const context = modifierContext(analysis, at - prefix.length);
    const modifierItems: CompletionItem[] = context
        ? (context === 'directive' ? ['model'] : context === 'log' ? LOG_MODIFIER_NAMES
            : context === 'ask' ? ASK_MODIFIER_NAMES : MODIFIER_NAMES).map((name) => ({
            label: name,
            kind: CompletionItemKind.Property,
            detail: modifiers[name].signature,
            documentation: modifiers[name].description,
            textEdit: { range, newText: `${name}=` },
        }))
        : [];
    if (context && (context !== 'log' || (prefix !== '' && 'level'.startsWith(prefix)))) {
        return modifierItems;
    }
    const items = new Map<string, CompletionItem>();
    for (const [name, description] of Object.entries(keywords)) {
        items.set(name, { label: name, kind: CompletionItemKind.Keyword, documentation: description });
    }
    for (const [name, help] of Object.entries(builtins)) {
        items.set(name, { label: name, kind: CompletionItemKind.Function, detail: help.signature, documentation: help.description });
    }
    for (const [name, help] of Object.entries(specialVariables)) {
        items.set(name, { label: name, kind: CompletionItemKind.Variable, detail: help.signature, documentation: help.description });
    }
    for (const binding of visibleBindings(analysis, at)) {
        items.set(binding.name, {
            label: binding.name,
            kind: binding.kind === SymbolKind.Function ? CompletionItemKind.Function : CompletionItemKind.Variable,
            detail: binding.signature,
        });
    }
    return [...modifierItems, ...[...items.values()].map((item) => ({ ...item, textEdit: { range, newText: item.label } }))];
}

function helpHover(help: Help, range: Range): Hover {
    return { range, contents: { kind: MarkupKind.Markdown, value: `\`\`\`spl\n${help.signature}\n\`\`\`\n\n${help.description}` } };
}

export function hover(analysis: Analysis, position: Position): Hover | undefined {
    const token = nameAt(analysis, position);
    if (!token) return undefined;
    const at = offset(analysis.document, token);
    const range = tokenRange(token);
    if (Object.hasOwn(specialVariables, token.value)) return helpHover(specialVariables[token.value], range);
    const context = modifierContext(analysis, at);
    const next = analysis.tokens.find((candidate) => offset(analysis.document, candidate) >= at + token.value.length);
    if (context && isOp(next, '=') && Object.hasOwn(modifiers, token.value)) return helpHover(modifiers[token.value], range);
    const binding = resolveBinding(analysis, token);
    if (binding) return helpHover({ signature: binding.signature, description: 'Binding in the current document.' }, range);
    if (token.value === 'type' && isName(next)) return helpHover({ signature: 'type', description: keywords.type }, range);
    if (Object.hasOwn(builtins, token.value)) return helpHover(builtins[token.value], range);
    if (Object.hasOwn(keywords, token.value)) return helpHover({ signature: token.value, description: keywords[token.value] }, range);
    return undefined;
}

export function definition(analysis: Analysis, position: Position): Location | undefined {
    const token = nameAt(analysis, position);
    if (!token) return undefined;
    const binding = resolveBinding(analysis, token);
    return binding ? { uri: analysis.document.uri, range: tokenRange(binding.token) } : undefined;
}

export function documentSymbols(analysis: Analysis): DocumentSymbol[] {
    if (!analysis.scopes.length) return [];
    const symbolScope = (scope: Scope): Scope => {
        while (scope.parent && !analysis.bindings.some((binding) => binding.functionScope === scope)) scope = scope.parent;
        return scope;
    };
    const inScope = (scope: Scope): DocumentSymbol[] => analysis.bindings
        .filter((binding) => symbolScope(binding.scope) === scope && !binding.signature.startsWith('parameter '))
        .map((binding) => ({
            name: binding.name,
            detail: binding.signature,
            kind: binding.kind,
            range: { start: tokenRange(binding.token).start, end: analysis.document.positionAt(binding.end) },
            selectionRange: tokenRange(binding.token),
            ...(binding.functionScope ? { children: inScope(binding.functionScope) } : {}),
        }));
    return inScope(analysis.scopes[0]);
}
