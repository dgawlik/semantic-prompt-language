import {
    CompletionItemKind, DiagnosticSeverity, MarkupKind, SymbolKind,
    type CompletionItem, type Diagnostic, type DocumentSymbol, type Hover, type Location,
    type Position, type Range,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { SplSyntaxError } from '../../lang/src/errors.js';
import { tokenize, type Token } from '../../lang/src/lexer.js';
import { LOG_MODIFIER_NAMES, MODIFIER_NAMES, parse } from '../../lang/src/parser.js';
import { extractMarkdown, isWorkflowMarkdown, parseMarkdown, type MarkdownBlock } from '../../lang/src/markdown.js';
import { builtins, keywords, modifiers, specialVariables, type Help } from './catalog';

type NamedToken = Extract<Token, { type: 'name' }>;

interface Scope {
    start: number;
    end: number;
    parent?: Scope;
}

interface Binding {
    name: string;
    token: NamedToken;
    scope: Scope;
    signature: string;
    kind: SymbolKind;
    end: number;
    functionScope?: Scope;
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

function tokenRange(token: NamedToken): Range {
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

function interpolationNames(tokens: Token[]): NamedToken[] {
    const names: NamedToken[] = [];
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        if (isName(token) && !isOp(tokens[i - 1], '.')) names.push(token);
        if (token.type === 'str') {
            for (const part of token.parts) {
                if ('expr' in part) {
                    names.push(...interpolationNames(tokenize(part.expr, { inExpr: true, line: part.line, col: part.col })));
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
            parseMarkdown(document.getText());
        } else {
            parse(source);
        }
    } catch (error) {
        if (!(error instanceof SplSyntaxError)) throw error;
        const start = document.positionAt(document.offsetAt({ line: error.line - 1, character: error.col - 1 }));
        const end = document.positionAt(Math.min(source.length, document.offsetAt(start) + 1));
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
        tokens = blocks?.length === 0 ? [] : tokenize(source, { allowUnclosedBrackets: true });
        names = interpolationNames(tokens);
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

    const root: Scope = { start: 0, end: source.length };
    const scopes: Scope[] = [root];
    const bindings: Binding[] = [];
    const braceEnds = new Map<number, number>();
    const opens: number[] = [];
    for (let i = 0; i < tokens.length; i++) {
        if (isOp(tokens[i], '{')) opens.push(i);
        if (isOp(tokens[i], '}')) {
            const open = opens.pop();
            if (open !== undefined) braceEnds.set(open, i);
        }
    }
    const currentScope = (at: number) => scopes.findLast((scope) => scope.start <= at && at <= scope.end) ?? root;
    const braceScopes = new Map<number, Scope>();
    const blockScope = (open: number, parent: Scope): Scope => {
        const existing = braceScopes.get(open);
        if (existing) return existing;
        const close = braceEnds.get(open);
        const scope = {
            start: offset(document, tokens[open]),
            end: close === undefined ? source.length : offset(document, tokens[close]) + 1,
            parent,
        };
        braceScopes.set(open, scope);
        scopes.push(scope);
        return scope;
    };
    const bodyOpen = (start: number): number | undefined => {
        let candidate: number | undefined;
        let depth = 0;
        for (let j = start; j < tokens.length; j++) {
            const token = tokens[j];
            if (depth === 0 && (token.type === 'nl' || token.type === 'eof' || isOp(token, ';'))) break;
            if (isOp(token, '(') || isOp(token, '[')) depth++;
            if (isOp(token, ')') || isOp(token, ']')) depth--;
            if (depth === 0 && isOp(token, '{')) {
                candidate = j;
                const close = braceEnds.get(j);
                if (close === undefined) break;
                j = close;
            }
        }
        return candidate;
    };
    const add = (token: NamedToken, scope: Scope, signature: string, kind: SymbolKind = SymbolKind.Variable): Binding => {
        const binding = { name: token.value, token, scope, signature, kind, end: offset(document, token) + token.value.length };
        bindings.push(binding);
        return binding;
    };

    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        if (isOp(token, '{')) blockScope(i, currentScope(offset(document, token)));
        if (!isName(token) || isOp(tokens[i - 1], '.')) continue;
        const scope = currentScope(offset(document, token));
        const name = tokens[i + 1];
        if ((token.value === 'let' || token.value === 'except') && isName(name)) {
            const open = token.value === 'except' && isOp(tokens[i + 2], '{') ? i + 2 : undefined;
            add(name, open === undefined ? scope : blockScope(open, scope),
                token.value === 'let' ? `let ${name.value}` : `except ${name.value}`);
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
            while (j < tokens.length && !isOp(tokens[j], ')')) {
                const param = tokens[j];
                if (isName(param)) params.push(param);
                j++;
            }
            if (!isOp(tokens[j + 1], '{')) continue;
            const open = j + 1;
            const close = braceEnds.get(open);
            const end = close === undefined ? source.length : offset(document, tokens[close]) + 1;
            const functionScope = blockScope(open, scope);
            const binding = add(name, scope, `def ${name.value}(${params.map((param) => param.value).join(', ')})`, SymbolKind.Function);
            binding.end = end;
            binding.functionScope = functionScope;
            for (const param of params) add(param, functionScope, `parameter ${param.value}`);
        }
    }
    return { document, diagnostics, tokens, names, scopes, bindings, blocks };
}

function scopeAt(analysis: Analysis, at: number): Scope {
    return analysis.scopes.findLast((scope) => scope.start <= at && at < scope.end) ?? analysis.scopes[0];
}

function visibleBindings(analysis: Analysis, at: number): Binding[] {
    const result = new Map<string, Binding>();
    for (let scope: Scope | undefined = scopeAt(analysis, at); scope; scope = scope.parent) {
        const local = analysis.bindings.filter((binding) => binding.scope === scope);
        for (const binding of local) {
            if (result.has(binding.name)) continue;
            const candidates = local.filter((candidate) => candidate.name === binding.name);
            const visible = candidates.findLast((candidate) => offset(analysis.document, candidate.token) <= at);
            if (visible) result.set(binding.name, visible);
        }
    }
    return [...result.values()];
}

function nameAt(analysis: Analysis, position: Position): NamedToken | undefined {
    return analysis.names.find((token) =>
        token.line - 1 === position.line && token.col - 1 <= position.character &&
        position.character < token.col - 1 + token.value.length);
}

function modifierContext(analysis: Analysis, at: number): 'call' | 'directive' | 'log' | undefined {
    const stack: { op: string; context?: 'call' | 'directive' | 'log' }[] = [];
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
                isName(previous) && ['ask', 'think', 'agent'].includes(previous.value) ? 'call' : undefined;
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
        ? (context === 'directive' ? ['model'] : context === 'log' ? LOG_MODIFIER_NAMES : MODIFIER_NAMES).map((name) => ({
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
    const binding = analysis.bindings.find((candidate) => candidate.token === token) ??
        visibleBindings(analysis, at).find((candidate) => candidate.name === token.value);
    if (binding) return helpHover({ signature: binding.signature, description: 'Binding in the current document.' }, range);
    if (Object.hasOwn(builtins, token.value)) return helpHover(builtins[token.value], range);
    if (Object.hasOwn(keywords, token.value)) return helpHover({ signature: token.value, description: keywords[token.value] }, range);
    return undefined;
}

export function definition(analysis: Analysis, position: Position): Location | undefined {
    const token = nameAt(analysis, position);
    if (!token) return undefined;
    const at = offset(analysis.document, token);
    const next = analysis.tokens.find((candidate) => offset(analysis.document, candidate) >= at + token.value.length);
    if (modifierContext(analysis, at) && isOp(next, '=')) return undefined;
    const binding = analysis.bindings.find((candidate) => candidate.token === token) ??
        visibleBindings(analysis, at).find((candidate) => candidate.name === token.value);
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
