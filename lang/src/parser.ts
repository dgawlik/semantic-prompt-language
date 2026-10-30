import type {
    AssignTarget,
    Directives,
    Expr,
    Program,
    RestrictKind,
    Stmt,
    StrPart,
} from './ast.js';
import { SplSyntaxError } from './errors.js';
import { tokenize, type StringPart, type Token } from './lexer.js';

const KEYWORDS = new Set([
    'let', 'if', 'elif', 'else', 'for', 'in', 'while', 'def', 'return', 'try', 'except', 'assert', 'fail',
    'success', 'enforce', 'forbid', 'restrict', 'ask', 'think', 'agent', 'human', 'break', 'continue', 'pass', 'and', 'or', 'not',
    'True', 'False', 'None',
]);

export function isReservedName(name: string): boolean {
    return KEYWORDS.has(name);
}

export const MODIFIER_NAMES = ['len', 'fmt', 'reasoning', 'hide', 'schema', 'repairs', 'model'] as const;
export const LOG_MODIFIER_NAMES = ['level'] as const;

const DIRECTIVE_SCHEMA: Record<string, 'string'> = { model: 'string' };

const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '//=', '%=']);

export function parse(source: string): Program {
    const lines = source.split(/\r?\n/);
    const parser = new Parser(tokenize(source), lines);
    return parser.parseProgram();
}

export function usesHuman(program: Program): boolean {
    const visit = (value: unknown): boolean => {
        if (Array.isArray(value)) return value.some(visit);
        if (typeof value !== 'object' || value === null) return false;
        return ('t' in value && value.t === 'human') || Object.values(value).some(visit);
    };
    return visit(program.body);
}

/**
 * Names declared with `let` inside nested blocks (not function bodies). Such bindings vanish when
 * their block ends, so a natural-language result saved this way is lost to later document steps.
 */
export function blockLocalDeclarations(program: Program): Set<string> {
    const names = new Set<string>();
    const visit = (value: unknown): void => {
        if (Array.isArray(value)) return value.forEach(visit);
        if (typeof value !== 'object' || value === null) return;
        if ('t' in value && value.t === 'def') return;
        if ('t' in value && value.t === 'let' && 'name' in value) names.add(value.name as string);
        Object.values(value).forEach(visit);
    };
    for (const stmt of program.body) visit(stmt.t === 'let' ? stmt.value : stmt);
    return names;
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

    private isType(type: Token['type']): boolean {
        return this.tok.type === type;
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
            case 'indent': return 'indentation';
            case 'dedent': return 'dedent';
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
        if (name.startsWith('$')) this.fail(`special variable '${name}' cannot be used as ${what}`);
        if (isReservedName(name)) this.fail(`'${name}' is a reserved word and cannot be used as ${what}`);
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
        if (t.type === 'nl' || t.type === 'dedent' || t.type === 'eof' || this.isOp(';') ||
            this.atSuiteEnd()) return;
        this.fail(`unexpected ${this.describe(t)} at end of statement`);
    }

    private atStatementEnd(): boolean {
        const t = this.tok;
        return t.type === 'nl' || t.type === 'dedent' || t.type === 'eof' || this.isOp(';') || this.atSuiteEnd();
    }

    private atSuiteEnd(): boolean {
        return this.toks[this.pos - 1]?.type === 'dedent';
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
        if (this.isOp('{')) this.fail("brace directives have been removed; use @(model='...')");
        const open = this.expectOp('(');
        this.skipNl();
        const seen = new Set<string>();
        while (!this.isOp(')')) {
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
            } else if (!this.isOp(')')) {
                this.fail(`expected ',' or ')' in directive`);
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
        if (this.isOp('{')) this.fail("brace-delimited blocks have been removed; use ':' and an indented body");
        this.expectOp(':');
        if (!this.isType('nl')) this.fail("expected a newline after ':'; put the block body on indented lines");
        this.skipNl();
        if (!this.isType('indent')) this.fail('expected an indented block (use pass for an empty body)');
        this.next();
        const body: Stmt[] = [];
        this.skipSeparators();
        while (this.tok.type !== 'dedent') {
            if (this.tok.type === 'eof') this.fail('expected the end of an indented block');
            body.push(this.parseStatement());
            this.endOfStatement();
            this.skipSeparators();
        }
        if (!body.length) this.fail('expected a statement in the indented block (use pass for an empty body)');
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
                    const kind = t.value;
                    this.next();
                    const text = this.parseExpr();
                    return { t: 'constraint', line, kind, text, body: this.parseBlock() };
                }
                case 'restrict': return this.parseRestrict();
                case 'instruct':
                case 'avoid':
                    this.fail(`use '${t.value === 'instruct' ? 'enforce' : 'forbid'}' instead of '${t.value}' for scoped prompt guidance`);
                default:
                    break;
            }
        }
        return this.parseSimpleStatement();
    }

    private parseLet(): Stmt {
        const line = this.tok.line;
        this.next();
        const name = this.expectIdent('a variable name');
        this.expectOp('=');
        return { t: 'let', line, name, value: this.parseExpr() };
    }

    private parseIf(): Extract<Expr, { t: 'if' }> {
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
        const clauses: { kind: RestrictKind; arg: Expr }[] = [];
        for (;;) {
            let kind: RestrictKind = 'fs';
            const t = this.tok;
            if (t.type === 'name' && (t.value === 'fs' || t.value === 'net' || t.value === 'exec' || t.value === 'mcp')) {
                kind = t.value;
                this.next();
            }
            clauses.push({ kind, arg: this.parseExpr() });
            if (!this.isOp(',')) break;
            this.next();
            this.skipNl();
        }
        return { t: 'restrict', line, clauses, body: this.parseBlock() };
    }

    private parseSimpleStatement(): Stmt {
        const start = this.tok;
        const line = start.line;
        const e = this.parseExpr();
        const t = this.tok;
        if (t.type === 'op' && ASSIGN_OPS.has(t.value)) {
            const target = this.toTarget(e, start);
            this.next();
            return { t: 'assign', line, target, op: t.value as Extract<Stmt, { t: 'assign' }>['op'], value: this.parseExpr() };
        }
        return e.t === 'block' || e.t === 'if' ? e : { t: 'expr', line, e };
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
        if (this.atSuiteEnd()) return e;
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
        while (!this.atSuiteEnd() && this.isName('or')) {
            this.next();
            l = { t: 'logic', op: 'or', l, r: this.parseAnd() };
        }
        return l;
    }

    private parseAnd(): Expr {
        let l = this.parseNot();
        while (!this.atSuiteEnd() && this.isName('and')) {
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
            if (this.atSuiteEnd()) break;
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
        while (!this.atSuiteEnd() && (this.isOp('+') || this.isOp('-'))) {
            const op = (this.next() as { value: string }).value;
            l = { t: 'binary', op, l, r: this.parseMul() };
        }
        return l;
    }

    private parseMul(): Expr {
        let l = this.parseUnary();
        while (!this.atSuiteEnd() && (this.isOp('*') || this.isOp('/') || this.isOp('//') || this.isOp('%'))) {
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
            this.fail("'?' generation syntax has been removed; use ask(...) 'prompt' or ask 'prompt'");
        }
        if (this.isName('ask')) {
            this.next();
            this.rejectBraceMods('ask');
            const mods = this.isOp('(') ? this.parseMods('ask') : {};
            return { t: 'ask', mods, prompt: this.parsePrompt('ask') };
        }
        if (this.isName('human')) return this.parseHuman();
        return this.parsePower();
    }

    private parsePower(): Expr {
        const base = this.parsePostfix();
        if (!this.atSuiteEnd() && this.isOp('**')) {
            this.next();
            return { t: 'binary', op: '**', l: base, r: this.parseUnary() };
        }
        return base;
    }

    private parsePostfix(): Expr {
        let e = this.parsePrimary();
        for (;;) {
            if (this.atSuiteEnd()) return e;
            if (this.isOp('(')) {
                e = { t: 'call', callee: e, args: this.parseArgs() };
            } else if (this.isOp('[')) {
                this.next();
                e = this.parseSubscript(e);
            } else if (this.isOp('.')) {
                this.next();
                const t = this.tok;
                if (t.type !== 'name' || t.value.startsWith('$')) this.fail("expected a member name after '.'");
                this.next();
                e = { t: 'member', obj: e, name: (t as { value: string }).value };
            } else {
                return e;
            }
        }
    }

    private parseArgs(): Expr[] {
        this.expectOp('(');
        const args: Expr[] = [];
        while (!this.isOp(')')) {
            args.push(this.parseExpr());
            if (this.isOp(',')) this.next();
            else if (!this.isOp(')')) this.fail("expected ',' or ')' in call");
        }
        this.next();
        return args;
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
        if (t.value === ':') {
            return { t: 'block', line: t.line, body: this.parseBlock() };
        }
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
            if (this.isOp('}')) {
                this.next();
                return { t: 'dict', entries: [] };
            }
            const entries: [Expr, Expr][] = [];
            while (!this.isOp('}')) {
                const k = this.parseExpr();
                this.expectOp(':');
                entries.push([k, this.parseExpr()]);
                if (this.isOp(',')) {
                    this.next();
                } else if (!this.isOp('}')) {
                    this.fail("expected ',' or '}' in dict");
                }
            }
            this.next();
            return { t: 'dict', entries };
        }
        if (t.value === '?') {
            return this.fail("'?' generation syntax has been removed; use ask(...) 'prompt'");
        }
        return this.fail(`unexpected ${this.describe(t)}`);
    }

    private parseNamePrimary(t: Token & { type: 'name' }): Expr {
        if (t.value.startsWith('$')) {
            if (t.value !== '$env' && t.value !== '$args') this.fail(`unknown special variable '${t.value}'`);
            this.next();
            return { t: 'special', name: t.value === '$env' ? 'env' : 'args' };
        }
        switch (t.value) {
            case 'True': this.next(); return { t: 'bool', v: true };
            case 'False': this.next(); return { t: 'bool', v: false };
            case 'None': this.next(); return { t: 'none' };
            case 'human': return this.parseHuman();
            case 'if': return this.parseIf();
            case 'log':
                if (this.isOp('{', this.peekAt(1))) this.fail("brace modifiers have been removed; use log(level=debug)(value)");
                if (this.isOp('(', this.peekAt(1)) && (
                    (this.peekAt(2).type === 'name' && this.isOp('=', this.peekAt(3))) ||
                    (this.isOp(')', this.peekAt(2)) && this.isOp('(', this.peekAt(3)))
                )) {
                    this.next();
                    const mods = this.parseMods('log');
                    const level = mods.level ?? { t: 'str', parts: ['info'] };
                    return { t: 'log', level, args: this.parseArgs() };
                }
                this.next();
                return { t: 'name', name: t.value, line: t.line };
            case 'think':
            case 'agent': {
                this.next();
                this.rejectBraceMods(t.value);
                const mods = this.isOp('(') ? this.parseMods(t.value) : {};
                return { t: t.value, mods, prompt: this.parsePrompt(t.value) };
            }
            default:
                if (KEYWORDS.has(t.value)) this.fail(`unexpected keyword '${t.value}'`);
                this.next();
                return { t: 'name', name: t.value, line: t.line };
        }
    }

    private parseHuman(): Expr {
        const token = this.next();
        if (this.isOp('(') && this.peekAt(1).type === 'name' && this.isOp('=', this.peekAt(2))) {
            this.fail("human does not accept modifiers; use human 'question'");
        }
        return { t: 'human', prompt: this.parsePrompt('human'), line: token.line };
    }

    private parsePrompt(cmd: string): Expr {
        if (this.atStatementEnd()) this.fail(`'${cmd}' requires a prompt`);
        return this.parsePostfix();
    }

    private rejectBraceMods(cmd: string): void {
        if (this.isOp('{')) this.fail(`brace modifiers have been removed; use ${cmd}(...) 'prompt'`);
    }

    private parseMods(cmd: 'ask' | 'think' | 'agent' | 'log'): Record<string, Expr> {
        this.expectOp('(');
        this.skipNl();
        const out: Record<string, Expr> = {};
        const allowed: readonly string[] = cmd === 'log' ? LOG_MODIFIER_NAMES : MODIFIER_NAMES;
        while (!this.isOp(')')) {
            const nameTok = this.tok;
            if (nameTok.type !== 'name') this.fail(`expected a modifier name in '${cmd}(...)'; the prompt belongs after ')'`);
            const name = (nameTok as { value: string }).value;
            this.next();
            if (!allowed.includes(name)) {
                this.fail(`unknown modifier '${name}' for '${cmd}' (allowed: ${allowed.join(', ')})`, nameTok);
            }
            if (name in out) this.fail(`duplicate modifier '${name}'`, nameTok);
            this.expectOp('=');
            out[name] = this.parseExpr();
            const value = out[name];
            if (cmd === 'log' && value.t === 'name' && ['error', 'info', 'debug'].includes(value.name)) {
                out[name] = { t: 'str', parts: [value.name] };
            }
            this.skipNl();
            if (this.isOp(',')) {
                this.next();
                this.skipNl();
            } else if (!this.isOp(')')) {
                this.fail("expected ',' or ')' in modifiers");
            }
        }
        this.next();
        return out;
    }

    private convertParts(parts: StringPart[]): StrPart[] {
        return parts.map((p) => {
            if ('text' in p) return p.text;
            const indent = /^[ \t]*/.exec(this.lines[p.line - 1] ?? '')![0].length;
            const sub = new Parser(tokenize(p.expr, { inExpr: true, line: p.line, col: p.col, indent }), this.lines);
            const e = sub.parseExpr();
            if (sub.tok.type !== 'eof') sub.fail(`unexpected ${sub.describe(sub.tok)} in interpolation`);
            return e;
        });
    }
}
