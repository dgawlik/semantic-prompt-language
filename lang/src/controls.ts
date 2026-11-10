import type { NaturalControls, RestrictKind, Stmt } from './ast.js';
import { SplSyntaxError } from './errors.js';
import { tokenize, type Token } from './lexer.js';

const RESTRICTION_KINDS: readonly RestrictKind[] = ['fs', 'exec', 'net', 'mcp'];

export function parseNatural(text: string, line: number): Extract<Stmt, { t: 'natural' }> {
    const header = /^\s*@CTL\s*\(/i.exec(text);
    let controls: NaturalControls | undefined;
    let bodyLine = line;
    if (header) {
        let depth = 1;
        let quote = '';
        let raw = false;
        let end = header[0].length;
        for (; end < text.length; end++) {
            if (quote) {
                if (!raw && text[end] === '\\') end++;
                else if (text.startsWith(quote, end)) {
                    end += quote.length - 1;
                    quote = '';
                }
            } else if (text[end] === "'" || text[end] === '"') {
                raw = text[end - 1] === 'r';
                quote = text.startsWith(text[end].repeat(3), end) ? text[end].repeat(3) : text[end];
                end += quote.length - 1;
            } else if (text[end] === '(') depth++;
            else if (text[end] === ')' && --depth === 0) break;
        }
        if (depth !== 0) throw new SplSyntaxError('unterminated @CTL block', line, 1);
        const start = header[0].lastIndexOf('(');
        const prefix = text.slice(0, start);
        const headerLine = line + prefix.split('\n').length - 1;
        const headerCol = prefix.length - prefix.lastIndexOf('\n');
        controls = new ControlParser(tokenize(text.slice(start, end + 1), {
            inExpr: true, line: headerLine, col: headerCol,
        })).parse();
        bodyLine += text.slice(0, end + 1).split('\n').length - 1;
        text = text.slice(end + 1);
    }
    const removed = /(?<![\w@\\])@(restrict|enforce|forbid|human)\b/i.exec(text);
    if (removed) {
        const message = removed[1].toLowerCase() === 'human'
            ? '@Human has been removed; request human input in plain language'
            : `@${removed[1]} has been removed; use @CTL(restrict=..., enforce=..., forbid=...)`;
        throw new SplSyntaxError(message, bodyLine + text.slice(0, removed.index).split('\n').length - 1, 1);
    }
    if (/(?<![\w@\\])@CTL\b/i.test(text)) {
        throw new SplSyntaxError('@CTL must appear once at the start of a blockquote', line, 1);
    }
    return { t: 'natural', text: controls ? text.trimStart() : text, line, ...(controls ? { controls } : {}) };
}

class ControlParser {
    private pos = 0;

    constructor(private readonly tokens: Token[]) {}

    private get token(): Token { return this.tokens[this.pos]; }

    private fail(message: string): never {
        throw new SplSyntaxError(`@CTL: ${message}`, this.token.line, this.token.col);
    }

    private at(value: string): boolean {
        return this.token.type === 'op' && this.token.value === value;
    }

    private expect(value: string): void {
        if (!this.at(value)) this.fail(`expected '${value}'`);
        this.pos++;
    }

    private string(): string {
        const token = this.token;
        if (token.type !== 'str' || token.parts.some(part => !('text' in part))) {
            this.fail('expected a literal string (no interpolation)');
        }
        this.pos++;
        return token.parts.map(part => {
            if (!('text' in part)) this.fail('expected a literal string (no interpolation)');
            return part.text;
        }).join('');
    }

    private strings(): string | string[] {
        if (!this.at('[')) return this.string();
        this.pos++;
        const values: string[] = [];
        while (!this.at(']')) {
            values.push(this.string());
            if (!this.at(']')) this.expect(',');
        }
        this.pos++;
        return values;
    }

    private restrictions(): NonNullable<NaturalControls['restrict']> {
        this.expect('{');
        const restrictions: NonNullable<NaturalControls['restrict']> = {};
        while (!this.at('}')) {
            const token = this.token;
            const name = token.type === 'name' ? (this.pos++, token.value) : this.string();
            const kind = RESTRICTION_KINDS.find(kind => kind === name);
            if (!kind) this.fail(`unknown restriction kind '${name}'`);
            if (Object.hasOwn(restrictions, kind)) this.fail(`duplicate restriction kind '${kind}'`);
            this.expect(':');
            restrictions[kind] = this.strings();
            if (!this.at('}')) this.expect(',');
        }
        this.pos++;
        return restrictions;
    }

    parse(): NaturalControls {
        const controls: NaturalControls = {};
        this.expect('(');
        while (!this.at(')')) {
            const token = this.token;
            if (token.type !== 'name') this.fail('expected a setting name');
            this.pos++;
            const name = token.value;
            if (Object.hasOwn(controls, name)) this.fail(`duplicate setting '${name}'`);
            this.expect('=');
            switch (name) {
                case 'restrict': controls.restrict = this.restrictions(); break;
                case 'enforce': controls.enforce = this.strings(); break;
                case 'forbid': controls.forbid = this.strings(); break;
                case 'model': {
                    const model = this.string();
                    if (!model.trim()) this.fail('model must be a non-empty string');
                    controls.model = model;
                    break;
                }
                case 'reasoning': {
                    const reasoning = this.string();
                    if (reasoning !== 'low' && reasoning !== 'medium' && reasoning !== 'high') {
                        this.fail('reasoning must be low, medium, or high');
                    }
                    controls.reasoning = reasoning;
                    break;
                }
                default: this.fail(`unknown setting '${name}'`);
            }
            if (!this.at(')')) this.expect(',');
        }
        this.pos++;
        if (this.token.type !== 'eof') this.fail('unexpected text after settings');
        return controls;
    }
}
