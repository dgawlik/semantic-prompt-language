import { inspect, stripVTControlCharacters } from 'node:util';
import type { BodySegment, LogEvent, StateChange } from './log-events.js';
import { isReservedName } from './parser.js';

const JSON_TOKENS = /"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[{}[\],:]/g;

export function terminalColor(env: NodeJS.ProcessEnv = process.env, tty = Boolean(process.stderr.isTTY)): boolean {
    if (env.NO_COLOR !== undefined) return false;
    if (env.FORCE_COLOR !== undefined) return env.FORCE_COLOR !== '0';
    return tty && env.TERM !== 'dumb';
}

export function sanitize(text: string): string {
    return stripVTControlCharacters(text).replace(/\r\n?/g, '\n')
        .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
}

export function paint(text: string, color: number, enabled: boolean, bold = false): string {
    return enabled ? `\u001b[${bold ? '1;' : ''}${color}m${text}\u001b[0m` : text;
}

export function prettyJson(source: string, color = false): string | undefined {
    const text = source.trim();
    if (!/^(?:[{"[\d-]|true$|false$|null$)/.test(text)) return undefined;
    try {
        JSON.parse(text);
    } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        return undefined;
    }
    // Retain original tokens, including duplicate keys and numeric lexemes.
    const tokens = text.match(JSON_TOKENS)!;
    let depth = 0;
    let result = '';
    const newline = () => '\n' + '  '.repeat(depth);
    tokens.forEach((token, index) => {
        if (token === '{' || token === '[') {
            result += paint(token, 90, color);
            if (tokens[index + 1] !== (token === '{' ? '}' : ']')) { depth++; result += newline(); }
        } else if (token === '}' || token === ']') {
            if (tokens[index - 1] !== (token === '}' ? '{' : '[')) { depth--; result += newline(); }
            result += paint(token, 90, color);
        } else if (token === ',') {
            result += paint(token, 90, color) + newline();
        } else if (token === ':') {
            result += paint(token, 90, color) + ' ';
        } else {
            const shade = token.startsWith('"') ? (tokens[index + 1] === ':' ? 36 : 32)
                : token === 'null' ? 90 : token === 'true' || token === 'false' ? 35 : 33;
            result += paint(token, shade, color);
        }
    });
    return result;
}

export function prettySpl(source: string, color = false): string {
    const text = sanitize(source).replace(/\n$/, '');
    const tokens = /#[^\n]*|\br(?:'''|"""|'|")|'''|"""|'|"|\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b|\$?[A-Za-z_]\w*/g;
    let formatted = '';
    let consumed = 0;
    let previous = '';
    for (let match = tokens.exec(text); match; match = tokens.exec(text)) {
        let token = match[0];
        let shade: number | undefined;
        if (/^(?:r?['"])/.test(token)) {
            const raw = token.startsWith('r');
            const quote = raw ? token.slice(1) : token;
            let end = match.index + token.length;
            while (end < text.length) {
                if (text.startsWith(quote, end)) { end += quote.length; break; }
                if (quote.length === 1 && text[end] === '\n') break;
                end += !raw && text[end] === '\\' ? Math.min(2, text.length - end) : 1;
            }
            token = text.slice(match.index, end);
            tokens.lastIndex = end;
            shade = 32;
        } else if (token.startsWith('#')) shade = 90;
        else if (/^\d/.test(token)) shade = 33;
        else if (isReservedName(token) || token === 'from' || token === 'as') shade = 35;
        else if (previous === 'def' && !text.slice(consumed, match.index).trim()) shade = 36;
        formatted += text.slice(consumed, match.index) + token.split('\n').map(line =>
            shade === undefined ? line : paint(line, shade, color)).join('\n');
        consumed = match.index + token.length;
        previous = token;
    }
    formatted += text.slice(consumed);
    const lines = formatted.split('\n');
    const digits = String(lines.length).length;
    return paint('SPL', 90, color, true) + '\n' + lines.map((line, index) =>
        `${paint(String(index + 1).padStart(digits), 90, color)} ${paint('|', 90, color)} ${line}`).join('\n');
}

export function textSegments(text: string, eventId: string, identity: string): BodySegment[] {
    const plain = sanitize(text);
    const segments: BodySegment[] = [];
    let consumed = 0;
    for (let start = 0; start < plain.length; start++) {
        if (plain[start] !== '{' && plain[start] !== '[') continue;
        if (start && !/[\s:=(]/.test(plain[start - 1])) continue;
        const stack: string[] = [];
        let quoted = false;
        let escaped = false;
        let end = start;
        for (; end < plain.length; end++) {
            const char = plain[end];
            if (quoted) {
                if (escaped) escaped = false;
                else if (char === '\\') escaped = true;
                else if (char === '"') quoted = false;
            } else if (char === '"') quoted = true;
            else if (char === '{' || char === '[') stack.push(char === '{' ? '}' : ']');
            else if (char === '}' || char === ']') {
                if (stack.pop() !== char || stack.length === 0) { end++; break; }
            }
        }
        const source = plain.slice(start, end);
        const valid = prettyJson(source) !== undefined && (end === plain.length || /[\s,.;:!?)]/.test(plain[end]));
        if (valid) {
            const prefix = plain.slice(consumed, start).replace(/:[ \t]*\n?[ \t]*$/, ':\n');
            if (prefix) segments.push({ type: 'text', text: prefix });
            segments.push({
                type: 'json', payloadId: `${eventId}:${identity}:${segments.length}`, source,
                container: source[0] === '{' ? 'object' : 'array',
                summary: `${source[0] === '{' ? 'object' : 'array'} [folded]`,
            });
            consumed = end;
        }
        start = end - 1;
    }
    if (consumed < plain.length || !segments.length) segments.push({ type: 'text', text: plain.slice(consumed) });
    return segments;
}

export function valueSegments(value: unknown, eventId: string, identity: string, raw = false): BodySegment[] {
    if (raw) return [{ type: 'text', text: sanitize(String(value)) }];
    if (typeof value === 'string') return textSegments(value, eventId, identity);
    if (!(value instanceof Error) && !(typeof value === 'number' && !Number.isFinite(value))) {
        try {
            const json = JSON.stringify(value);
            if (json !== undefined) return textSegments(json, eventId, identity);
        } catch (error) {
            if (!(error instanceof TypeError)) throw error;
        }
    }
    return [{ type: 'inspection', text: sanitize(inspect(value, { colors: false, depth: null })) }];
}

export function stateSegments(change: StateChange, eventId: string): BodySegment[] {
    const segments: BodySegment[] = [];
    change.bindings.forEach((delta, index) => {
        if (index) segments.push({ type: 'text', text: '\n' });
        const label = `${delta.binding.name} @ ${delta.binding.label} (${delta.binding.scopeId})`;
        segments.push({ type: 'text', text: `${sanitize(label)}: ` });
        if (delta.previous.presence === 'unbound') segments.push({ type: 'text', text: '<unbound>' });
        else segments.push(...textSegments(delta.previous.display, eventId, `${index}:before`));
        segments.push({ type: 'text', text: ' -> ' });
        segments.push(...textSegments(delta.next.presence === 'value' ? delta.next.display : '<unbound>', eventId, `${index}:after`));
    });
    return segments;
}

export function formatSegments(segments: readonly BodySegment[], color = false): string {
    return segments.map(segment => segment.type === 'json' ? prettyJson(segment.source, color)!
        : segment.type === 'preface' ? formatSegments(textSegments(segment.source, segment.payloadId, 'expanded'), color)
        : segment.type === 'code' ? segment.source
        : segment.text).join('');
}

export function eventHeader(event: LogEvent, color = false): string {
    const marker = (text: string, shade: number) => paint(text, shade, color, true);
    if (event.origin === 'script') return marker(`[${event.kind}]`, { error: 31, warning: 33, info: 34, debug: 90 }[event.kind]);
    switch (event.kind) {
        case 'model-input': return marker(`-> input ${sanitize(event.interaction.kind)}`, 35);
        case 'model-output': return marker(`<- output ${sanitize(event.interaction.kind)}${event.interaction.role === 'action' ? ' action' : ''}`, 36);
        case 'state': return marker('~ state', 33);
        case 'error': return marker('x error', 31);
        case 'warning': return marker('! warning', 33);
        case 'info': return marker('i info', 34);
        case 'debug': return marker('. debug', 90);
        case 'generic': return marker(`- ${sanitize(event.label)}`, 35);
    }
}

export function formatEvent(event: LogEvent, color = false): string {
    return `${eventHeader(event, color)} ${formatSegments(event.segments, color)}`;
}
