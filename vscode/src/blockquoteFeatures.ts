import { CompletionItemKind, type CompletionItem, type Range } from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import { scanSettings, type ControlToken, type NaturalControls } from '../../lang/src/controls.js';
import type { MarkdownBlock } from '../../lang/src/markdown.js';
import type { RestrictKind } from '../../lang/src/restrict.js';
import type { SplBlock } from '../../lang/src/spl.js';
import type { Help } from './catalog';

export type { ControlToken };

/** A fence or blockquote of a Markdown workflow, or a block of a `.spl` file, which then carries its tag. */
export type WorkflowBlock = MarkdownBlock & { spl?: SplBlock };

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

/** The text of an instruction block at document positions, with the syntax around it blanked. */
export function blockquoteText(document: TextDocument, block: WorkflowBlock): { text: string; from: number } {
    const start = { line: block.line - 1, character: 0 };
    const from = document.offsetAt(start);
    const text = document.getText({ start, end: { line: block.endLine, character: 0 } });
    if (!block.spl) return { from, text: text.replace(/^ {0,3}(?:>[ \t]?)+/gm, prefix => ' '.repeat(prefix.length)) };
    if (!block.spl.closed) return { from, text };
    const closing = document.offsetAt({ line: block.endLine - 1, character: 0 }) - from;
    return { from, text: text.slice(0, closing) + text.slice(closing).replace(/[^\r\n]/g, ' ') };
}

export interface ControlScan {
    /** The marker and its opening delimiter, then every setting token. */
    tokens: ControlToken[];
    /** Offset from which settings may be written. */
    start: number;
    end: number;
    closed: boolean;
}

/**
 * Finds the settings that open an instruction: `@CTL(...)` in a blockquote, or the opening tag of
 * a `.spl` block when `tag` names it. Incomplete strings and groups stay usable while the user is typing.
 */
export function scanControls(text: string, tag?: string): ControlScan | undefined {
    if (tag) {
        const header = new RegExp(`^\\s*\\{(${tag})(?=[\\s}]|$)`).exec(text);
        if (!header) return undefined;
        const open = header[0].indexOf('{');
        const settings = scanSettings(text, header[0].length);
        return {
            ...settings, start: header[0].length + 1,
            tokens: [
                { kind: 'marker', value: tag, from: open + 1, to: header[0].length },
                { kind: 'punctuation', value: '{', from: open, to: open + 1 },
                ...settings.tokens,
            ],
        };
    }
    const header = /^\s*(@CTL)\s*\(/i.exec(text);
    if (!header) return undefined;
    const marker = header[0].indexOf('@');
    const open = header[0].lastIndexOf('(');
    const settings = scanSettings(text, open + 1);
    return {
        ...settings, start: open + 1,
        tokens: [
            { kind: 'marker', value: text.slice(marker, marker + 4), from: marker, to: marker + 4 },
            { kind: 'punctuation', value: '(', from: open, to: open + 1 },
            ...settings.tokens,
        ],
    };
}

export function scanCodegen(text: string): ControlToken[] | undefined {
    const controls = scanControls(text);
    if (controls && !controls.closed) return undefined;
    const start = controls?.end ?? 0;
    const header = /^\s*(@CODEGEN)\b/i.exec(text.slice(start));
    if (!header) return undefined;
    const from = start + header[0].indexOf('@');
    const to = from + header[1].length;
    return [
        { kind: 'marker', value: header[1], from, to },
        { kind: 'string', value: text.slice(to), from: to, to: text.length, quote: '', contentFrom: to, closed: true },
    ];
}

export function controlCompletions(
    text: string, at: number, range: (from: number, to: number) => Range, model?: string, tag?: string,
): CompletionItem[] | undefined {
    const controls = scanControls(text, tag);
    if (!controls || at < controls.start || (controls.closed && at >= controls.end)) return undefined;
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
    // The outermost group holds the settings; a brace group inside it is a restriction map.
    const settings = stack.length === 1;
    const segment = before.slice(Math.max(frame.from + 1, before.findLastIndex(token => token.value === ',') + 1));
    const separator = settings ? '=' : ':';
    const assignment = segment.findIndex(token => token.value === separator);
    const replacement = range(current?.from ?? at, current?.to ?? at);
    if (!settings && frame.open !== '{') return [];
    if (assignment >= 0) {
        const setting = segment[assignment - 1]?.value;
        const values = settings && setting === 'reasoning' ? ['low', 'medium', 'high'] :
            settings && setting === 'model' && model ? [model] : [];
        return values.map(value => ({
            label: value, kind: CompletionItemKind.Value,
            textEdit: current?.kind === 'string'
                ? { range: range(current.contentFrom, current.to - (current.closed ? current.quote.length : 0)),
                    newText: value + (current.closed ? '' : current.quote) }
                : { range: replacement, newText: `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'` },
        }));
    }
    const catalog = settings ? controlHelp : restrictionHelp;
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
