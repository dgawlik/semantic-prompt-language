import { CompletionItemKind, type CompletionItem, type Range } from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import type { NaturalControls, RestrictKind } from '../../lang/src/ast.js';
import type { MarkdownBlock } from '../../lang/src/markdown.js';
import type { Help } from './catalog';

export const controlHelp: Record<keyof NaturalControls, Help> = {
    restrict: { signature: "restrict={fs: ['./src'], exec: ['git']}", description: 'Narrow fs, exec, net or mcp permissions before the agent runs. Each restriction needs at least one entry.' },
    enforce: { signature: "enforce='Be concise'", description: 'Positive prompt guidance for this blockquote and its nested model calls; accepts a string or list of strings.' },
    forbid: { signature: "forbid='Unsupported claims'", description: 'Negative prompt guidance for this blockquote and its nested model calls; accepts a string or list of strings.' },
    model: { signature: "model='model-name'", description: 'Model for this blockquote agent. CLI --model takes precedence; nested generation keeps its own model.' },
    reasoning: { signature: "reasoning='low' | 'medium' | 'high'", description: 'Reasoning effort for this blockquote agent; defaults to medium.' },
};

const restrictionHelp: Record<RestrictKind, string> = {
    fs: 'Allowed filesystem paths, relative to the workflow working directory.',
    exec: 'Allowed executable names.',
    net: 'Allowed network hosts.',
    mcp: 'Allowed MCP server names or server/tool selectors.',
};

interface ControlTokenBase {
    value: string;
    from: number;
    to: number;
}

export type ControlToken = ControlTokenBase & (
    { kind: 'marker' | 'name' | 'punctuation' } |
    { kind: 'string'; quote: string; contentFrom: number; closed: boolean }
);

export function blockquoteText(document: TextDocument, block: MarkdownBlock): { text: string; from: number } {
    const start = { line: block.line - 1, character: 0 };
    return {
        from: document.offsetAt(start),
        text: document.getText({ start, end: { line: block.endLine, character: 0 } })
            .replace(/^ {0,3}(?:>[ \t]?)+/gm, prefix => ' '.repeat(prefix.length)),
    };
}

// Keep incomplete strings and groups usable while the user is typing.
export function scanControls(text: string): { tokens: ControlToken[]; end: number; closed: boolean } | undefined {
    const header = /^\s*(@CTL)\s*\(/i.exec(text);
    if (!header) return undefined;
    const marker = header[0].indexOf('@');
    const open = header[0].lastIndexOf('(');
    const tokens: ControlToken[] = [
        { kind: 'marker', value: text.slice(marker, marker + 4), from: marker, to: marker + 4 },
        { kind: 'punctuation', value: '(', from: open, to: open + 1 },
    ];
    let depth = 1;
    let at = open + 1;
    while (at < text.length) {
        if (/\s/.test(text[at])) { at++; continue; }
        if (text[at] === '#') {
            while (at < text.length && text[at] !== '\n') at++;
            continue;
        }
        const from = at;
        const raw = text[at] === 'r' && /['"]/.test(text[at + 1] ?? '');
        if (raw) at++;
        if (text[at] === "'" || text[at] === '"') {
            const quote = text.startsWith(text[at].repeat(3), at) ? text[at].repeat(3) : text[at];
            at += quote.length;
            const contentFrom = at;
            while (at < text.length && !text.startsWith(quote, at)) {
                at += !raw && text[at] === '\\' ? Math.min(2, text.length - at) : 1;
            }
            const closed = at < text.length;
            const value = text.slice(contentFrom, at);
            if (closed) at += quote.length;
            tokens.push({ kind: 'string', value, from, to: at, quote, contentFrom, closed });
        } else {
            const name = /^[A-Za-z_]\w*/.exec(text.slice(at));
            const value = name?.[0] ?? text[at];
            at += value.length;
            tokens.push({ kind: name ? 'name' : 'punctuation', value, from, to: at });
            if ('([{'.includes(value)) depth++;
            else if (')]}'.includes(value) && --depth === 0) return { tokens, end: at, closed: true };
        }
    }
    return { tokens, end: at, closed: false };
}

export function controlCompletions(
    text: string, at: number, range: (from: number, to: number) => Range, model?: string,
): CompletionItem[] | undefined {
    const controls = scanControls(text);
    if (!controls || at <= controls.tokens[1].from || (controls.closed && at >= controls.end)) return undefined;
    const current = controls.tokens.find(token => token.from < at && at <= token.to &&
        (token.kind === 'name' || token.kind === 'string'));
    const before = controls.tokens.filter(token => token.from < (current?.from ?? at));
    const stack: { open: string; from: number }[] = [];
    for (let i = 1; i < before.length; i++) {
        const token = before[i];
        if (token.kind !== 'punctuation') continue;
        if ('([{'.includes(token.value)) stack.push({ open: token.value, from: i });
        else if (')]}'.includes(token.value)) stack.pop();
    }
    const frame = stack.at(-1);
    if (!frame) return [];
    const segment = before.slice(Math.max(frame.from + 1, before.findLastIndex(token => token.value === ',') + 1));
    const separator = frame.open === '{' ? ':' : '=';
    const assignment = segment.findIndex(token => token.value === separator);
    const replacement = range(current?.from ?? at, current?.to ?? at);
    if (frame.open === '[') return [];
    if (assignment >= 0) {
        const setting = segment[assignment - 1]?.value;
        const values = frame.open === '(' && setting === 'reasoning' ? ['low', 'medium', 'high'] :
            frame.open === '(' && setting === 'model' && model ? [model] : [];
        return values.map(value => ({
            label: value, kind: CompletionItemKind.Value,
            textEdit: current?.kind === 'string'
                ? { range: range(current.contentFrom, current.to - (current.closed ? current.quote.length : 0)),
                    newText: value + (current.closed ? '' : current.quote) }
                : { range: replacement, newText: `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'` },
        }));
    }
    if (frame.open !== '(' && frame.open !== '{') return [];
    const catalog = frame.open === '(' ? controlHelp : restrictionHelp;
    const used = new Set(controls.tokens.filter((token, i, tokens) =>
        token !== current && tokens[i + 1]?.value === separator).map(token => token.value));
    const tail = text.slice(current?.to ?? at);
    const hasSeparator = new RegExp(`^\\s*${separator}`).test(tail);
    return Object.entries(catalog).filter(([name]) => !used.has(name)).map(([name, help]) => ({
        label: name, kind: CompletionItemKind.Property,
        detail: typeof help === 'string' ? name : help.signature,
        documentation: typeof help === 'string' ? help : help.description,
        textEdit: { range: replacement, newText: (current?.kind === 'string' ? `${current.quote}${name}${current.quote}` : name) +
            (hasSeparator ? '' : separator) },
    }));
}
