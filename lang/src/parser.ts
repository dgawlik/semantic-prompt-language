import type {
    AskMods,
    AssignTarget,
    Directives,
    Expr,
    Program,
    RestrictKind,
    Stmt,
    StrPart,
    ThinkMods,
    ToolName,
} from './ast.js';
import { SplSyntaxError } from './errors.js';
import { tokenize, type StringPart, type Token } from './lexer.js';

export const TOOL_NAMES: readonly ToolName[] = ['read_file', 'write_file', 'web_fetch', 'web_search', 'shell'];

const KEYWORDS = new Set([
    'let', 'if', 'elif', 'else', 'for', 'in', 'while', 'def', 'return', 'try', 'except', 'assert', 'fail',
    'success', 'enforce', 'forbid', 'restrict', 'think', 'break', 'continue', 'pass', 'and', 'or', 'not',
    'True', 'False', 'None', ...TOOL_NAMES,
]);

/** Fixed modifier schema per command; anything else is a syntax error. */
export const MODIFIER_SCHEMA: Record<'?' | 'think', Record<string, readonly (string | boolean)[]>> = {
    '?': {
        len: ['word', 'sentence', 'paragraph', 'long'],
        fmt: ['text', 'object'],
    },
    think: {
        level: ['low', 'medium', 'high'],
        show: [true, false],
    },
};

/**
 * Tool parameter schema: the allowed names, and the `required` ones that let the runtime run the tool itself.
 * Every parameter is optional in a script; the LLM supplies the missing required ones when it calls the tool.
 */
export const TOOL_SCHEMA: Record<ToolName, { params: string[]; required: string[] }> = {
    read_file: { params: ['path'], required: ['path'] },
    write_file: { params: ['path', 'content'], required: ['path', 'content'] },
    web_fetch: { params: ['url'], required: ['url'] },
    web_search: { params: ['query'], required: ['query'] },
    shell: { params: ['command'], required: ['command'] },
};

const DIRECTIVE_SCHEMA: Record<string, 'string'> = { model: 'string' };

const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '//=', '%=']);

export function parse(source: string): Program {
    const lines = source.split(/\r?\n/);
    const parser = new Parser(tokenize(source), lines);
    return parser.parseProgram();
}

class Parser {
    private pos = 0;
    private loopDepth = 0;

    constructor(
        private readonly toks: Token[],
        private readonly lines: string[],
    ) {}

    // ---- token helpers -------------------------------------------------

    private get tok(): Token {
        return this.toks[this.pos];
    }

    private peekAt(n: number): Token {
        return this.toks[Math.min(this.pos + n, this.toks.length - 1)];
    }

    private next(): Token {
        const t = this.toks[this.pos];
        if (t.type !== 'eof') this.pos++;
        return t;
    }

    private fail(msg: string, t: Token = this.tok): never {
        throw new SplSyntaxError(msg, t.line, t.col);
    }

    private describe(t: Token): string {
        switch (t.type) {
            case 'eof': return 'end of file';
            case 'nl': return 'end of line';
            case 'num': return `number ${t.value}`;
            case 'str': return 'string';
            default: return `'${t.value}'`;
        }
    }

    private isOp(v: string, t: Token = this.tok): boolean {
        return t.type === 'op' && t.value === v;
    }

    private isName(v: string, t: Token = this.tok): boolean {
        return t.type === 'name' && t.value === v;
    }

    private expectOp(v: string): Token {
        if (!this.isOp(v)) this.fail(`expected '${v}' but found ${this.describe(this.tok)}`);
        return this.next();
    }

    private expectKeyword(v: string): Token {
        if (!this.isName(v)) this.fail(`expected '${v}' but found ${this.describe(this.tok)}`);
        return this.next();
    }

    private expectIdent(what: string): string {
        const t = this.tok;
        if (t.type !== 'name') this.fail(`expected ${what} but found ${this.describe(t)}`);
        const name = (t as { value: string }).value;
        if (KEYWORDS.has(name)) this.fail(`'${name}' is a reserved word and cannot be used as ${what}`);
        this.next();
        return name;
    }

    private skipNl(): void {
        while (this.tok.type === 'nl') this.next();
    }

    private skipSeparators(): void {
        while (this.tok.type === 'nl' || this.isOp(';')) this.next();
    }

    /** True when the next non-newline token is the given keyword. */
    private keywordAfterNl(v: string): boolean {
        let k = 0;
        while (this.peekAt(k).type === 'nl') k++;
        return this.isName(v, this.peekAt(k));
    }

    private endOfStatement(): void {
        const t = this.tok;
        if (t.type === 'nl' || t.type === 'eof' || this.isOp(';') || this.isOp('}')) return;
        this.fail(`unexpected ${this.describe(t)} at end of statement`);
    }

    private atStatementEnd(): boolean {
        const t = this.tok;
        return t.type === 'nl' || t.type === 'eof' || this.isOp(';') || this.isOp('}');
    }

    // ---- program & statements -----------------------------------------

    parseProgram(): Program {
        const directives: Directives = {};
        this.skipSeparators();
        while (this.isOp('@')) {
            this.parseDirective(directives);
            this.endOfStatement();
            this.skipSeparators();
        }
        const body: Stmt[] = [];
        while (this.tok.type !== 'eof') {
            body.push(this.parseStatement());
            this.endOfStatement();
            this.skipSeparators();
        }
        return { directives, body, lines: this.lines };
    }

    private parseDirective(into: Directives): void {
        this.expectOp('@');
        const open = this.expectOp('{');
        this.skipNl();
        const seen = new Set<string>();
        while (!this.isOp('}')) {
            const nameTok = this.tok;
            if (nameTok.type !== 'name') this.fail('expected directive name');
            const name = (nameTok as { value: string }).value;
            this.next();
            if (!(name in DIRECTIVE_SCHEMA)) {
                this.fail(`unknown directive '${name}' (allowed: ${Object.keys(DIRECTIVE_SCHEMA).join(', ')})`, nameTok);
            }
            if (seen.has(name)) this.fail(`duplicate directive '${name}'`, nameTok);
            seen.add(name);
            this.expectOp('=');
            const value = this.parseLiteralString(`directive '${name}'`);
            (into as Record<string, string>)[name] = value;
            this.skipNl();
            if (this.isOp(',')) {
                this.next();
                this.skipNl();
            } else if (!this.isOp('}')) {
                this.fail(`expected ',' or '}' in directive`);
            }
        }
        this.next();
        if (seen.size === 0) this.fail('empty directive', open);
    }

    private parseLiteralString(what: string): string {
        const t = this.tok;
        if (t.type !== 'str') this.fail(`${what} requires a quoted string value`);
        const parts = (t as { parts: StringPart[] }).parts;
        if (parts.some((p) => 'expr' in p)) this.fail(`${what} cannot contain interpolation`);
        this.next();
        return parts.map((p) => (p as { text: string }).text).join('');
    }

    private parseBlock(): Stmt[] {
        this.expectOp('{');
        const body: Stmt[] = [];
        this.skipSeparators();
        while (!this.isOp('}')) {
            if (this.tok.type === 'eof') this.fail("unclosed block, missing '}'");
            body.push(this.parseStatement());
            this.endOfStatement();
            this.skipSeparators();
        }
        this.next();
        return body;
    }

    private parseStatement(): Stmt {
        const t = this.tok;
        const line = t.line;
        if (t.type === 'op' && t.value === '@') this.fail('directives are only allowed at the top of the script');
        if (t.type === 'name') {
            switch (t.value) {
                case 'let': return this.parseLet();
                case 'if': return this.parseIf();
                case 'for': {
                    this.next();
                    const vars = [this.expectIdent('a loop variable')];
                    while (this.isOp(',')) {
                        this.next();
                        vars.push(this.expectIdent('a loop variable'));
                    }
                    this.expectKeyword('in');
                    const iter = this.parseExpr();
                    return { t: 'for', line, vars, iter, body: this.parseLoopBody() };
                }
                case 'while': {
                    this.next();
                    const cond = this.parseExpr();
                    return { t: 'while', line, cond, body: this.parseLoopBody() };
                }
                case 'break':
                case 'continue':
                    if (this.loopDepth === 0) this.fail(`'${t.value}' outside of a loop`);
                    this.next();
                    return { t: t.value, line };
                case 'pass': this.next(); return { t: 'pass', line };
                case 'def': return this.parseDef();
                case 'return': {
                    this.next();
                    return { t: 'return', line, value: this.atStatementEnd() ? undefined : this.parseExpr() };
                }
                case 'try': {
                    this.next();
                    const body = this.parseBlock();
                    if (!this.keywordAfterNl('except')) this.fail("'try' requires an 'except <name>' block");
                    this.skipNl();
                    this.next();
                    const errName = this.expectIdent('a name for the caught failure');
                    return { t: 'try', line, body, errName, handler: this.parseBlock() };
                }
                case 'except': this.fail("'except' without matching 'try'"); break;
                case 'elif':
                case 'else': this.fail(`'${t.value}' without matching 'if'`); break;
                case 'assert': {
                    this.next();
                    const cond = this.parseExpr();
                    const message = this.atStatementEnd() ? undefined : this.parseExpr();
                    return { t: 'assert', line, cond, message };
                }
                case 'fail': {
                    this.next();
                    return { t: 'fail', line, reason: this.parseExpr() };
                }
                case 'success': {
                    this.next();
                    return { t: 'success', line, value: this.atStatementEnd() ? undefined : this.parseExpr() };
                }
                case 'enforce':
                case 'forbid': {
                    const kind = t.value as 'enforce' | 'forbid';
                    this.next();
                    const text = this.parseExpr();
                    return { t: 'constraint', line, kind, text, body: this.parseBlock() };
                }
                case 'restrict': return this.parseRestrict();
                default:
                    break;
            }
        }
        if (t.type === 'op' && t.value === '{') return { t: 'block', line, body: this.parseBlock() };
        return this.parseSimpleStatement();
    }

    private parseLet(): Stmt {
        const line = this.tok.line;
        this.next();
        const startTok = this.tok;
        if (startTok.type === 'name' && KEYWORDS.has(startTok.value)) {
            this.fail(`'${startTok.value}' is a reserved word and cannot be used as a variable name`);
        }
        if (startTok.type !== 'name') this.fail(`expected a variable name but found ${this.describe(startTok)}`);
        const target = this.toTarget(this.parsePostfix(), startTok);
        const opTok = this.tok;
        if (opTok.type !== 'op' || !ASSIGN_OPS.has(opTok.value)) this.fail(`expected '=' after the target of 'let' but found ${this.describe(opTok)}`);
        this.next();
        return { t: 'let', line, target, op: (opTok as { value: string }).value as '=', value: this.parseExpr() };
    }

    private parseIf(): Stmt {
        const line = this.tok.line;
        this.next();
        const branches: { cond: Expr; body: Stmt[] }[] = [];
        let orelse: Stmt[] | undefined;
        const cond = this.parseExpr();
        branches.push({ cond, body: this.parseBlock() });
        for (;;) {
            if (this.keywordAfterNl('elif')) {
                this.skipNl();
                this.next();
                const c = this.parseExpr();
                branches.push({ cond: c, body: this.parseBlock() });
            } else if (this.keywordAfterNl('else')) {
                this.skipNl();
                this.next();
                orelse = this.parseBlock();
                break;
            } else {
                break;
            }
        }
        return { t: 'if', line, branches, orelse };
    }

    private parseDef(): Stmt {
        const line = this.tok.line;
        this.next();
        const name = this.expectIdent('a function name');
        this.expectOp('(');
        const params: string[] = [];
        while (!this.isOp(')')) {
            const nameTok = this.tok;
            const p = this.expectIdent('a parameter name');
            if (params.includes(p)) this.fail(`duplicate parameter '${p}'`, nameTok);
            params.push(p);
            if (this.isOp(',')) this.next();
            else if (!this.isOp(')')) this.fail("expected ',' or ')' in parameter list");
        }
        this.next();
        const savedLoop = this.loopDepth;
        this.loopDepth = 0;
        const body = this.parseBlock();
        this.loopDepth = savedLoop;
        return { t: 'def', line, name, params, body };
    }

    private parseLoopBody(): Stmt[] {
        this.loopDepth++;
        const body = this.parseBlock();
        this.loopDepth--;
        return body;
    }

    private parseRestrict(): Stmt {
        const line = this.tok.line;
        this.next();
        let kind: RestrictKind = 'fs';
        const t = this.tok;
        if (t.type === 'name' && (t.value === 'fs' || t.value === 'net' || t.value === 'exec')) {
            kind = t.value;
            this.next();
        }
        const arg = this.parseExpr();
        return { t: 'restrict', line, kind, arg, body: this.parseBlock() };
    }

    private parseSimpleStatement(): Stmt {
        const line = this.tok.line;
        const e = this.parseExpr();
        const t = this.tok;
        if (t.type === 'op' && ASSIGN_OPS.has(t.value)) {
            this.fail(`variables are modified with 'let' (write 'let <target> ${t.value} ...')`, t);
        }
        return { t: 'expr', line, e };
    }

    private toTarget(e: Expr, at: Token): AssignTarget {
        if (e.t === 'name') return { t: 'name', name: e.name };
        if (e.t === 'member') return { t: 'member', obj: e.obj, name: e.name };
        if (e.t === 'index') return { t: 'index', obj: e.obj, index: e.index };
        return this.fail('invalid assignment target', at);
    }

    // ---- expressions ---------------------------------------------------

    private parseExpr(): Expr {
        const e = this.parseOr();
        if (this.isName('if')) {
            this.next();
            const cond = this.parseOr();
            this.expectKeyword('else');
            return { t: 'ternary', cond, then: e, else: this.parseExpr() };
        }
        return e;
    }

    private parseOr(): Expr {
        let l = this.parseAnd();
        while (this.isName('or')) {
            this.next();
            l = { t: 'logic', op: 'or', l, r: this.parseAnd() };
        }
        return l;
    }

    private parseAnd(): Expr {
        let l = this.parseNot();
        while (this.isName('and')) {
            this.next();
            l = { t: 'logic', op: 'and', l, r: this.parseNot() };
        }
        return l;
    }

    private parseNot(): Expr {
        if (this.isName('not')) {
            this.next();
            return { t: 'unary', op: 'not', e: this.parseNot() };
        }
        return this.parseComparison();
    }

    private parseComparison(): Expr {
        const first = this.parseAdd();
        const ops: string[] = [];
        const operands: Expr[] = [first];
        for (;;) {
            const t = this.tok;
            let op: string | undefined;
            if (t.type === 'op' && ['==', '!=', '<', '<=', '>', '>='].includes(t.value)) {
                op = t.value;
                this.next();
            } else if (this.isName('in')) {
                op = 'in';
                this.next();
            } else if (this.isName('not') && this.isName('in', this.peekAt(1))) {
                op = 'not in';
                this.next();
                this.next();
            }
            if (!op) break;
            ops.push(op);
            operands.push(this.parseAdd());
        }
        return ops.length ? { t: 'compare', ops, operands } : first;
    }

    private parseAdd(): Expr {
        let l = this.parseMul();
        while (this.isOp('+') || this.isOp('-')) {
            const op = (this.next() as { value: string }).value;
            l = { t: 'binary', op, l, r: this.parseMul() };
        }
        return l;
    }

    private parseMul(): Expr {
        let l = this.parseUnary();
        while (this.isOp('*') || this.isOp('/') || this.isOp('//') || this.isOp('%')) {
            const op = (this.next() as { value: string }).value;
            l = { t: 'binary', op, l, r: this.parseUnary() };
        }
        return l;
    }

    private parseUnary(): Expr {
        if (this.isOp('-') || this.isOp('+')) {
            const op = (this.next() as { value: string }).value as '-' | '+';
            return { t: 'unary', op, e: this.parseUnary() };
        }
        if (this.isOp('?')) {
            this.next();
            const mods = this.isOp('{') ? (this.parseMods('?') as AskMods) : {};
            return { t: 'ask', mods, prompt: this.parsePrompt('?') };
        }
        return this.parsePower();
    }

    private parsePower(): Expr {
        const base = this.parsePostfix();
        if (this.isOp('**')) {
            this.next();
            return { t: 'binary', op: '**', l: base, r: this.parseUnary() };
        }
        return base;
    }

    private parsePostfix(): Expr {
        let e = this.parsePrimary();
        for (;;) {
            if (this.isOp('(')) {
                this.next();
                const args: Expr[] = [];
                while (!this.isOp(')')) {
                    args.push(this.parseExpr());
                    if (this.isOp(',')) this.next();
                    else if (!this.isOp(')')) this.fail("expected ',' or ')' in call");
                }
                this.next();
                e = { t: 'call', callee: e, args };
            } else if (this.isOp('[')) {
                this.next();
                e = this.parseSubscript(e);
            } else if (this.isOp('.')) {
                this.next();
                const t = this.tok;
                if (t.type !== 'name') this.fail("expected a member name after '.'");
                this.next();
                e = { t: 'member', obj: e, name: (t as { value: string }).value };
            } else {
                return e;
            }
        }
    }

    private parseSubscript(obj: Expr): Expr {
        const lo = this.isOp(':') ? undefined : this.parseExpr();
        if (lo && !this.isOp(':')) {
            this.expectOp(']');
            return { t: 'index', obj, index: lo };
        }
        this.expectOp(':');
        const hi = this.isOp(']') ? undefined : this.parseExpr();
        this.expectOp(']');
        return { t: 'slice', obj, lo, hi };
    }

    private parsePrimary(): Expr {
        const t = this.tok;
        switch (t.type) {
            case 'num':
                this.next();
                return { t: 'num', v: t.value };
            case 'str':
                this.next();
                return { t: 'str', parts: this.convertParts(t.parts) };
            case 'op':
                return this.parseOpPrimary(t);
            case 'name':
                return this.parseNamePrimary(t);
            default:
                return this.fail(`unexpected ${this.describe(t)}`);
        }
    }

    private parseOpPrimary(t: Token & { type: 'op' }): Expr {
        if (t.value === '(') {
            this.next();
            const e = this.parseExpr();
            this.expectOp(')');
            return e;
        }
        if (t.value === '[') {
            this.next();
            const items: Expr[] = [];
            while (!this.isOp(']')) {
                items.push(this.parseExpr());
                if (this.isOp(',')) this.next();
                else if (!this.isOp(']')) this.fail("expected ',' or ']' in list");
            }
            this.next();
            return { t: 'list', items };
        }
        if (t.value === '{') {
            this.next();
            this.skipNl();
            const entries: [Expr, Expr][] = [];
            while (!this.isOp('}')) {
                const k = this.parseExpr();
                this.expectOp(':');
                this.skipNl();
                entries.push([k, this.parseExpr()]);
                this.skipNl();
                if (this.isOp(',')) {
                    this.next();
                    this.skipNl();
                } else if (!this.isOp('}')) {
                    this.fail("expected ',' or '}' in dict");
                }
            }
            this.next();
            return { t: 'dict', entries };
        }
        if (t.value === '?') {
            return this.fail("'?' is a prefix operator and cannot be used here");
        }
        return this.fail(`unexpected ${this.describe(t)}`);
    }

    private parseNamePrimary(t: Token & { type: 'name' }): Expr {
        switch (t.value) {
            case 'True': this.next(); return { t: 'bool', v: true };
            case 'False': this.next(); return { t: 'bool', v: false };
            case 'None': this.next(); return { t: 'none' };
            case 'think': {
                this.next();
                const mods = this.isOp('{') ? (this.parseMods('think') as ThinkMods) : {};
                return { t: 'think', mods, prompt: this.parsePrompt('think') };
            }
            case 'read_file':
            case 'write_file':
            case 'web_fetch':
            case 'web_search':
            case 'shell':
                return this.parseToolCall(t.value);
            default:
                if (KEYWORDS.has(t.value)) this.fail(`unexpected keyword '${t.value}'`);
                this.next();
                return { t: 'name', name: t.value, line: t.line };
        }
    }

    private parsePrompt(cmd: string): Expr {
        if (this.atStatementEnd()) this.fail(`'${cmd}' requires a prompt`);
        return this.parsePostfix();
    }

    private parseMods(cmd: '?' | 'think'): Record<string, string | boolean> {
        const schema = MODIFIER_SCHEMA[cmd];
        this.expectOp('{');
        this.skipNl();
        const out: Record<string, string | boolean> = {};
        while (!this.isOp('}')) {
            const nameTok = this.tok;
            if (nameTok.type !== 'name') this.fail('expected a modifier name');
            const name = (nameTok as { value: string }).value;
            this.next();
            if (!(name in schema)) {
                this.fail(`unknown modifier '${name}' for '${cmd}' (allowed: ${Object.keys(schema).join(', ')})`, nameTok);
            }
            if (name in out) this.fail(`duplicate modifier '${name}'`, nameTok);
            this.expectOp('=');
            const valTok = this.tok;
            let value: string | boolean;
            if (valTok.type === 'str') value = this.parseLiteralString(`modifier '${name}'`);
            else if (this.isName('True') || this.isName('False')) value = (this.next() as { value: string }).value === 'True';
            else return this.fail(`modifier '${name}' requires a quoted string or True/False`);
            if (!schema[name].includes(value)) {
                const allowed = schema[name].map((v) => (typeof v === 'string' ? `'${v}'` : v ? 'True' : 'False'));
                this.fail(`invalid value ${typeof value === 'string' ? `'${value}'` : value ? 'True' : 'False'} for modifier '${name}' (allowed: ${allowed.join(', ')})`, valTok);
            }
            out[name] = value;
            this.skipNl();
            if (this.isOp(',')) {
                this.next();
                this.skipNl();
            } else if (!this.isOp('}')) {
                this.fail("expected ',' or '}' in modifiers");
            }
        }
        this.next();
        return out;
    }

    private parseToolCall(tool: ToolName): Expr {
        this.next();
        const schema = TOOL_SCHEMA[tool];
        const params: Record<string, Expr> = {};
        if (this.isOp('{')) {
            this.next();
            this.skipNl();
            while (!this.isOp('}')) {
                const nameTok = this.tok;
                if (nameTok.type !== 'name') this.fail('expected a parameter name');
                const name = (nameTok as { value: string }).value;
                this.next();
                if (!schema.params.includes(name)) {
                    this.fail(`unknown parameter '${name}' for '${tool}' (allowed: ${schema.params.join(', ')})`, nameTok);
                }
                if (name in params) this.fail(`duplicate parameter '${name}'`, nameTok);
                this.expectOp('=');
                params[name] = this.parseExpr();
                this.skipNl();
                if (this.isOp(',')) {
                    this.next();
                    this.skipNl();
                } else if (!this.isOp('}')) {
                    this.fail("expected ',' or '}' in tool parameters");
                }
            }
            this.next();
        }
        return { t: 'tool', tool, params, instructions: this.parsePrompt(tool) };
    }

    private convertParts(parts: StringPart[]): StrPart[] {
        return parts.map((p) => {
            if ('text' in p) return p.text;
            const sub = new Parser(tokenize(p.expr, { inExpr: true, line: p.line, col: p.col }), this.lines);
            const e = sub.parseExpr();
            if (sub.tok.type !== 'eof') sub.fail(`unexpected ${sub.describe(sub.tok)} in interpolation`);
            return e;
        });
    }
}
