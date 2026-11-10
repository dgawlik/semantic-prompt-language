import {
    CompletionItemKind, DiagnosticSeverity, MarkupKind, SymbolKind,
    type CompletionItem, type Diagnostic, type DocumentSymbol, type Hover, type Location,
    type Position, type Range,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { Failure, SplSyntaxError } from '../../lang/src/errors.js';
import { checkProgram } from '../../lang/src/type-check.js';
import { primitives, type TypeDescriptor } from '../../lang/src/types.js';
import { tokenize, type Token } from '../../lang/src/lexer.js';
import { ASK_MODIFIER_NAMES, LOG_MODIFIER_NAMES, MODIFIER_NAMES, parse } from '../../lang/src/parser.js';
import { extractMarkdown, isWorkflowMarkdown, parseMarkdown, type MarkdownBlock } from '../../lang/src/markdown.js';
import { builtins, keywords, listCallbacks, modifiers, specialVariables, type Help } from './catalog';

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
    availableFrom?: number;
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

// Include interpolation expressions without treating raw/escaped string text as code.
export function expressionTokens(analysis: Analysis, tokens = analysis.tokens): Token[] {
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
    return result.sort((a, b) => offset(analysis.document, a) - offset(analysis.document, b));
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
    const naturalOutputs: { token: NamedToken; schema?: NamedToken; availableFrom: number }[] = [];
    try {
        tokens = blocks
            ? blocks.filter(block => block.kind === 'spl').flatMap(block =>
                tokenize('\n'.repeat(block.line - 1) + block.text, { allowUnclosedBrackets: true }))
            : tokenize(source, { allowUnclosedBrackets: true });
        names = interpolationNames(tokens, source.split(/\r?\n/));
    } catch (error) {
        if (!(error instanceof SplSyntaxError)) throw error;
        // Lexically incomplete documents still get parser diagnostics and static completions.
    }
    for (const block of blocks ?? []) {
        if (block.kind !== 'natural') continue;
        const start = { line: block.line - 1, character: 0 };
        const end = { line: block.endLine, character: 0 };
        const from = document.offsetAt(start);
        const text = document.getText({ start, end })
            .replace(/^ {0,3}(?:>[ \t]?)+/gm, prefix => ' '.repeat(prefix.length));
        const name = (value: string, at: number): NamedToken => {
            const position = document.positionAt(from + at);
            return { type: 'name', value, line: position.line + 1, col: position.character + 1 };
        };
        const references = [...text.matchAll(/(?<![\w@])@([A-Za-z_]\w*)/g)]
            .map(match => ({ token: name(match[1], match.index + 1), at: match.index }));
        const schemas: { token: NamedToken; at: number }[] = [];
        for (const reference of references) {
            names.push(reference.token);
            const schema = /^@validate[ \t]*\[[ \t]*([A-Za-z_]\w*)[ \t]*\]/.exec(text.slice(reference.at));
            if (schema) {
                const token = name(schema[1], reference.at + schema[0].lastIndexOf(schema[1]));
                names.push(token);
                schemas.push({ token, at: reference.at });
            }
        }
        for (const reference of references) {
            if (!/(?:\bsave\b[^.!?;@]*\bto|->)\s*$/i.test(text.slice(0, reference.at))) continue;
            const schema = schemas.findLast(candidate => candidate.at < reference.at) ??
                (schemas.length === 1 ? schemas[0] : undefined);
            naturalOutputs.push({
                token: reference.token, schema: schema?.token, availableFrom: document.offsetAt(end),
            });
        }
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
        } else if (token.value === 'lambda') {
            const params: NamedToken[] = [];
            let j = i + 1;
            for (;;) {
                const param = tokens[j];
                if (!isName(param)) break;
                params.push(param);
                j++;
                if (!isOp(tokens[j], ',')) break;
                j++;
            }
            if (!isOp(tokens[j], ':')) continue;
            let depth = 0;
            let headers = 0;
            let end = j + 1;
            for (; end < tokens.length; end++) {
                const next = tokens[end];
                if (depth === 0 && (['nl', 'dedent', 'eof'].includes(next.type) || isOp(next, ';') ||
                    isOp(next, ',') && headers === 0 || next.type === 'op' && [')', ']', '}'].includes(next.value))) break;
                if (next.type === 'op' && ['(', '[', '{'].includes(next.value)) depth++;
                else if (next.type === 'op' && [')', ']', '}'].includes(next.value)) depth--;
                else if (depth === 0 && isName(next) && next.value === 'lambda') headers++;
                else if (depth === 0 && isOp(next, ':') && headers > 0) headers--;
            }
            const lambdaScope: Scope = {
                start: offset(document, token),
                end: tokens[end] ? offset(document, tokens[end]) : source.length,
                includesEnd: tokens[end]?.type === 'eof' || tokens[end]?.type === 'nl' && offset(document, tokens[end]) === source.length,
                parent: scope,
            };
            scopes.push(lambdaScope);
            for (const param of params) add(param, lambdaScope, `parameter ${param.value}`);
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
    const result: Analysis = { document, diagnostics, tokens, names, scopes, bindings, blocks };
    for (const output of naturalOutputs) {
        if (visibleBindings(result, output.availableFrom).some(binding => binding.name === output.token.value)) continue;
        const schema = output.schema && resolveBinding(result, output.schema);
        const type = output.schema && (schema
            ? [SymbolKind.TypeParameter, SymbolKind.Enum, SymbolKind.Struct, SymbolKind.Class].some(kind => kind === schema.kind)
            : primitives.has(output.schema.value)) ? output.schema.value : 'unknown';
        const binding = add(output.token, root, `let ${output.token.value}: ${type}`);
        binding.availableFrom = output.availableFrom;
    }
    bindings.sort((a, b) => offset(document, a.token) - offset(document, b.token));
    names.sort((a, b) => offset(document, a) - offset(document, b));
    return result;
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
            if ((binding.availableFrom ?? offset(analysis.document, binding.token)) <= at) {
                const name = binding === renamed?.binding ? renamed.name : binding.name;
                const previous = visible.get(name);
                if (!previous || offset(analysis.document, previous.token) < offset(analysis.document, binding.token)) {
                    visible.set(name, binding);
                }
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

function memberItems(type: TypeDescriptor | undefined): CompletionItem[] {
    if (type?.kind === 'union') {
        const branches = type.members!.map(memberItems);
        return (branches[0] ?? []).filter(item => branches.every(branch => branch.some(other => other.label === item.label)))
            .map(item => ({ ...item, detail: [...new Set(branches.map(branch =>
                branch.find(other => other.label === item.label)!.detail))].join(' | ') }));
    }
    if (type?.kind === 'list') return Object.entries(listCallbacks).map(([name, help]) => ({
        label: name, kind: CompletionItemKind.Method, detail: help.signature, documentation: help.description,
    }));
    if (type?.kind !== 'struct' && type?.kind !== 'class') return [];
    return [
        ...Object.entries(type.fields ?? {}).map(([name, field]) => ({
            label: name, kind: CompletionItemKind.Field, detail: `${name}: ${field.type.name}`,
        })),
        ...Object.entries(type.methods ?? {}).map(([name, method]) => ({
            label: name, kind: CompletionItemKind.Method,
            detail: `def ${name}(${method.params.map((param, i) =>
                `${param}${method.paramTypes?.[i] ? `: ${method.paramTypes[i]!.name}` : ''}`).join(', ')})` +
                (method.returnType ? ` -> ${method.returnType.name}` : ''),
        })),
    ];
}

function memberCompletions(analysis: Analysis, range: Range): CompletionItem[] | undefined {
    const start = analysis.document.offsetAt(range.start);
    const dot = expressionTokens(analysis).findLast(token => offset(analysis.document, token) < start);
    if (!isOp(dot, '.') || !dot) return undefined;
    const source = analysis.document.getText();
    if (!/^\s*$/.test(source.slice(offset(analysis.document, dot) + 1, start))) return undefined;
    const at = analysis.document.offsetAt(range.end);
    const suffix = /^[A-Za-z0-9_]*/.exec(source.slice(at))![0];
    const block = analysis.blocks?.find(candidate => candidate.kind === 'spl' &&
        dot.line >= candidate.line && dot.line <= candidate.endLine);
    const brackets: string[] = [];
    for (const token of analysis.tokens) {
        if (block && (token.line < block.line || token.line > block.endLine)) continue;
        if (token.type !== 'op') continue;
        if (['(', '[', '{'].includes(token.value)) brackets.push(token.value);
        else if ([')', ']', '}'].includes(token.value)) brackets.pop();
    }
    const closing = brackets.reverse().map(op => op === '(' ? ')' : op === '[' ? ']' : '}').join('');
    const end = block
        ? analysis.document.offsetAt({ line: block.endLine - 1, character: source.split(/\r?\n/)[block.endLine - 1].length })
        : source.length;
    // Complete just the member token and open groups; keep the surrounding control flow intact.
    const patched = source.slice(0, start) + '_' + source.slice(at + suffix.length, end) + closing + source.slice(end);
    let receiver: TypeDescriptor | undefined;
    try {
        const program = analysis.blocks ? parseMarkdown(patched) : parse(patched);
        // Natural-language outputs are editor bindings, not runtime declarations.
        program.body = program.body.flatMap(stmt => {
            if (stmt.t !== 'natural') return [stmt];
            const instruction = analysis.blocks?.find(candidate => candidate.kind === 'natural' && candidate.line === stmt.line);
            const outputs = analysis.bindings.filter(binding => binding.availableFrom !== undefined &&
                instruction && binding.token.line >= instruction.line && binding.token.line <= instruction.endLine);
            return [stmt, ...outputs.flatMap(binding =>
                parse(`${binding.signature.replace(/: unknown$/, '')} = ${binding.name}`).body)];
        });
        checkProgram(program, undefined, (expr, type) => {
            if (expr.line === dot.line && expr.col === dot.col) receiver = type;
        });
    } catch (error) {
        if (!(error instanceof SplSyntaxError) && !(error instanceof Failure)) throw error;
        // The original analysis reports diagnostics; a partial member can still have a known receiver.
    }
    const editRange = { start: range.start, end: analysis.document.positionAt(at + suffix.length) };
    return memberItems(receiver).map(item => ({ ...item, textEdit: { range: editRange, newText: item.label } }));
}

export function completions(analysis: Analysis, position: Position): CompletionItem[] {
    if (analysis.blocks && !analysis.blocks.some((block) => position.line >= block.line - 1 && position.line < block.endLine)) return [];
    const at = analysis.document.offsetAt(position);
    const prefix = /\$[A-Za-z0-9_]*$|[A-Za-z_][A-Za-z0-9_]*$/.exec(analysis.document.getText().slice(0, at))?.[0] ?? '';
    const range = { start: analysis.document.positionAt(at - prefix.length), end: position };
    const members = memberCompletions(analysis, range);
    if (members) return members;
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
