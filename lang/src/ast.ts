export type StrPart = string | Expr;

export type Expr =
    | { t: 'num'; v: number }
    | { t: 'str'; parts: StrPart[] }
    | { t: 'bool'; v: boolean }
    | { t: 'none' }
    | { t: 'name'; name: string; line: number }
    | { t: 'list'; items: Expr[] }
    | { t: 'dict'; entries: [Expr, Expr][] }
    | { t: 'unary'; op: 'not' | '-' | '+'; e: Expr }
    | { t: 'binary'; op: string; l: Expr; r: Expr }
    | { t: 'logic'; op: 'and' | 'or'; l: Expr; r: Expr }
    | { t: 'compare'; ops: string[]; operands: Expr[] }
    | { t: 'ternary'; cond: Expr; then: Expr; else: Expr }
    | { t: 'call'; callee: Expr; args: Expr[] }
    | { t: 'member'; obj: Expr; name: string }
    | { t: 'index'; obj: Expr; index: Expr }
    | { t: 'slice'; obj: Expr; lo?: Expr; hi?: Expr }
    | { t: 'ask'; mods: AskMods; prompt: Expr }
    | { t: 'think'; mods: ThinkMods; prompt: Expr }
    | { t: 'tool'; tool: ToolName; params: Record<string, Expr>; instructions: Expr };

export interface AskMods {
    len?: 'word' | 'sentence' | 'paragraph' | 'long';
    fmt?: 'text' | 'object';
}

export interface ThinkMods {
    level?: 'low' | 'medium' | 'high';
    show?: boolean;
}

export type ToolName = 'read_file' | 'write_file' | 'web_fetch' | 'shell';
export type RestrictKind = 'fs' | 'net' | 'exec';

export type AssignTarget =
    | { t: 'name'; name: string }
    | { t: 'member'; obj: Expr; name: string }
    | { t: 'index'; obj: Expr; index: Expr };

interface Base {
    line: number;
}

export type Stmt = Base &
    (
        | { t: 'let'; name: string; value: Expr }
        | { t: 'assign'; target: AssignTarget; op: '=' | '+=' | '-=' | '*=' | '/=' | '//=' | '%='; value: Expr }
        | { t: 'expr'; e: Expr }
        | { t: 'if'; branches: { cond: Expr; body: Stmt[] }[]; orelse?: Stmt[] }
        | { t: 'for'; vars: string[]; iter: Expr; body: Stmt[] }
        | { t: 'while'; cond: Expr; body: Stmt[] }
        | { t: 'break' }
        | { t: 'continue' }
        | { t: 'pass' }
        | { t: 'def'; name: string; params: string[]; body: Stmt[] }
        | { t: 'return'; value?: Expr }
        | { t: 'try'; body: Stmt[]; errName: string; handler: Stmt[] }
        | { t: 'assert'; cond: Expr; message?: Expr }
        | { t: 'fail'; reason: Expr }
        | { t: 'success'; value?: Expr }
        | { t: 'constraint'; kind: 'enforce' | 'forbid'; text: Expr; body: Stmt[] }
        | { t: 'restrict'; kind: RestrictKind; arg: Expr; body: Stmt[] }
    );

export interface Directives {
    model?: string;
}

export interface Program {
    directives: Directives;
    body: Stmt[];
    lines: string[];
}
