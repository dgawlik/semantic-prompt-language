import { inspect, stripVTControlCharacters } from 'node:util';
import type { BodySegment, LogEvent, StateChange } from './log-events.js';

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

export function paint(text: string, color: number, enabled: boolean): string {
    return enabled ? `\u001b[${color}m${text}\u001b[0m` : text;
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
        : segment.text).join('');
}

export function eventHeader(event: LogEvent, color = false): string {
    if (event.origin === 'script') return paint(`[${event.kind}]`, { error: 31, warning: 33, info: 34, debug: 90 }[event.kind], color);
    switch (event.kind) {
        case 'model-input': return paint(`-> input ${sanitize(event.interaction.kind)}`, 35, color);
        case 'model-output': return paint(`<- output ${sanitize(event.interaction.kind)}${event.interaction.role === 'action' ? ' action' : ''}`, 36, color);
        case 'state': return paint('~ state', 33, color);
        case 'error': return paint('x error', 31, color);
        case 'warning': return paint('! warning', 33, color);
        case 'info': return paint('i info', 34, color);
        case 'debug': return paint('. debug', 90, color);
        case 'generic': return paint(`- ${sanitize(event.label)}`, 35, color);
    }
}

export function formatEvent(event: LogEvent, color = false): string {
    return `${eventHeader(event, color)} ${formatSegments(event.segments, color)}`;
}
