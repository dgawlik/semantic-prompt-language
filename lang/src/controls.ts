import { SplSyntaxError } from './errors.js';
import type { RestrictKind } from './restrict.js';

export interface NaturalControls {
    restrict?: Partial<Record<RestrictKind, string | string[]>>;
    enforce?: string | string[];
    forbid?: string | string[];
    model?: string;
    reasoning?: 'low' | 'medium' | 'high';
}

export interface NaturalBlock {
    text: string;
    line: number;
    controls?: NaturalControls;
    codegen?: true;
}

const RESTRICTION_KINDS: readonly RestrictKind[] = ['fs', 'exec', 'net', 'mcp'];
const ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', 0: '\0', b: '\b', f: '\f', v: '\v' };

/** Reads the literal settings of `@CTL(...)` and the `@CODEGEN` description; values are never evaluated. */
class Scanner {
    pos = 0;

    constructor(
        private readonly text: string,
        private readonly line: number,
        private readonly marker: string,
    ) {}

    fail(message: string, at = this.pos): never {
        const before = this.text.slice(0, at);
        throw new SplSyntaxError(`${this.marker}: ${message}`, this.line + before.split('\n').length - 1, at - before.lastIndexOf('\n'));
    }

    skip(): void {
        while (this.pos < this.text.length && /\s/.test(this.text[this.pos])) this.pos++;
    }

    get done(): boolean {
        this.skip();
        return this.pos >= this.text.length;
    }

    at(value: string): boolean {
        this.skip();
        return this.text.startsWith(value, this.pos);
    }

    take(value: string): boolean {
        if (!this.at(value)) return false;
        this.pos += value.length;
        return true;
    }

    expect(value: string): void {
        if (!this.take(value)) this.fail(this.pos >= this.text.length ? `unterminated ${this.marker} block` : `expected '${value}'`);
    }

    name(): string | undefined {
        this.skip();
        const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.text.slice(this.pos));
        if (!match || /^['"`]/.test(this.text.slice(this.pos + match[0].length)) && /^r$/i.test(match[0])) return undefined;
        this.pos += match[0].length;
        return match[0];
    }

    string(): string {
        this.skip();
        const start = this.pos;
        const raw = /^r['"]/i.test(this.text.slice(this.pos));
        if (raw) this.pos++;
        const first = this.text[this.pos];
        if (first !== "'" && first !== '"' && first !== '`') this.fail('expected a literal string', start);
        const quote = first !== '`' && this.text.startsWith(first.repeat(3), this.pos) ? first.repeat(3) : first;
        this.pos += quote.length;
        let value = '';
        for (;;) {
            if (this.pos >= this.text.length) this.fail('unterminated string', start);
            if (this.text.startsWith(quote, this.pos)) break;
            const character = this.text[this.pos];
            if (character === '\n' && quote.length === 1 && quote !== '`') this.fail('unterminated string', start);
            if (quote === '`' && character === '$' && this.text[this.pos + 1] === '{') {
                this.fail('expected a literal string (no interpolation)', start);
            }
            if (character !== '\\' || raw) {
                value += character;
                this.pos++;
                continue;
            }
            const escaped = this.text[this.pos + 1];
            if (escaped === undefined) this.fail('unterminated string', start);
            const unicode = /^u\{([0-9a-fA-F]{1,6})\}|^u([0-9a-fA-F]{4})|^x([0-9a-fA-F]{2})/.exec(this.text.slice(this.pos + 1));
            if (unicode) {
                value += String.fromCodePoint(parseInt(unicode[1] ?? unicode[2] ?? unicode[3], 16));
                this.pos += 1 + unicode[0].length;
            } else {
                value += escaped === '\n' ? '' : ESCAPES[escaped] ?? escaped;
                this.pos += 2;
            }
        }
        this.pos += quote.length;
        return value;
    }

    strings(): string | string[] {
        if (!this.take('[')) return this.string();
        const values: string[] = [];
        while (!this.take(']')) {
            values.push(this.string());
            if (!this.at(']')) this.expect(',');
        }
        return values;
    }

    restrictions(): NonNullable<NaturalControls['restrict']> {
        this.expect('{');
        const restrictions: NonNullable<NaturalControls['restrict']> = {};
        while (!this.take('}')) {
            this.skip();
            const start = this.pos;
            const name = this.name() ?? this.string();
            const kind = RESTRICTION_KINDS.find(kind => kind === name);
            if (!kind) this.fail(`unknown restriction kind '${name}'`, start);
            if (Object.hasOwn(restrictions, kind)) this.fail(`duplicate restriction kind '${kind}'`, start);
            this.expect(':');
            restrictions[kind] = this.strings();
            if (!this.at('}')) this.expect(',');
        }
        return restrictions;
    }

    controls(): NaturalControls {
        const controls: NaturalControls = {};
        this.expect('(');
        while (!this.take(')')) {
            this.skip();
            const start = this.pos;
            const name = this.name();
            if (!name) this.fail(this.pos >= this.text.length ? 'unterminated @CTL block' : 'expected a setting name');
            if (Object.hasOwn(controls, name)) this.fail(`duplicate setting '${name}'`, start);
            this.expect('=');
            switch (name) {
                case 'restrict': controls.restrict = this.restrictions(); break;
                case 'enforce': controls.enforce = this.strings(); break;
                case 'forbid': controls.forbid = this.strings(); break;
                case 'model': {
                    const model = this.string();
                    if (!model.trim()) this.fail('model must be a non-empty string', start);
                    controls.model = model;
                    break;
                }
                case 'reasoning': {
                    const reasoning = this.string();
                    if (reasoning !== 'low' && reasoning !== 'medium' && reasoning !== 'high') {
                        this.fail('reasoning must be low, medium, or high', start);
                    }
                    controls.reasoning = reasoning;
                    break;
                }
                default: this.fail(`unknown setting '${name}'`, start);
            }
            if (!this.at(')')) this.expect(',');
        }
        return controls;
    }
}

export function parseNatural(text: string, line: number): NaturalBlock {
    const header = /^\s*@CTL\s*(?=\()/i.exec(text);
    let controls: NaturalControls | undefined;
    let bodyLine = line;
    if (header) {
        const scanner = new Scanner(text, line, '@CTL');
        scanner.pos = header[0].length;
        controls = scanner.controls();
        bodyLine += text.slice(0, scanner.pos).split('\n').length - 1;
        text = text.slice(scanner.pos);
    }
    const codegen = /^\s*@CODEGEN\b/i.exec(text);
    if (codegen) {
        const scanner = new Scanner(text, bodyLine, '@CODEGEN');
        scanner.pos = codegen[0].length;
        const description = scanner.string();
        if (!description.trim()) scanner.fail('description must be a non-empty string', codegen[0].length);
        if (!scanner.done) scanner.fail('expected a single literal string description');
        return { text: description, line, codegen: true, ...(controls ? { controls } : {}) };
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
    if (/(?<![\w@\\])@CODEGEN\b/i.test(text)) {
        throw new SplSyntaxError('@CODEGEN must appear at the start of a blockquote, after optional @CTL settings', line, 1);
    }
    return { text: controls ? text.trimStart() : text, line, ...(controls ? { controls } : {}) };
}
