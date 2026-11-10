export type StrPart = string | Expr;

export type TypeExpr =
    | { t: 'type-name'; name: string; line: number }
    | { t: 'type-list'; element: TypeExpr; line: number }
    | { t: 'type-union'; members: TypeExpr[]; line: number }
    | { t: 'type-fn'; params: TypeExpr[]; result: TypeExpr; line: number };

export interface FieldDecl {
    name: string;
    type: TypeExpr;
    advice: Record<string, unknown>;
    line: number;
}

export type DefStmt = Extract<Stmt, { t: 'def' }>;

export type Expr =
    | { t: 'num'; v: number; raw?: string }
    | { t: 'str'; parts: StrPart[] }
    | { t: 'bool'; v: boolean }
    | { t: 'none' }
    | { t: 'name'; name: string; line: number }
    | { t: 'special'; name: 'env' | 'args' }
    | { t: 'list'; items: Expr[] }
    | { t: 'dict'; entries: ([Expr, Expr] | DefStmt)[] }
    | { t: 'type'; type: TypeExpr }
    | { t: 'group'; e: Expr }
    | { t: 'unary'; op: 'not' | '-' | '+'; e: Expr }
    | { t: 'binary'; op: string; l: Expr; r: Expr }
    | { t: 'logic'; op: 'and' | 'or'; l: Expr; r: Expr }
    | { t: 'compare'; ops: string[]; operands: Expr[] }
    | { t: 'ternary'; cond: Expr; then: Expr; else: Expr }
    | { t: 'lambda'; params: string[]; body: Expr; line: number }
    | { t: 'call'; callee: Expr; args: Expr[] }
    | { t: 'member'; obj: Expr; name: string; line?: number; col?: number }
    | { t: 'index'; obj: Expr; index: Expr }
    | { t: 'slice'; obj: Expr; lo?: Expr; hi?: Expr }
    | { t: 'block'; body: Stmt[]; line: number }
    | { t: 'if'; branches: { cond: Expr; body: Stmt[] }[]; orelse?: Stmt[]; line: number }
    | { t: 'log'; level: Expr; args: Expr[] }
    | { t: 'human'; prompt: Expr; line: number }
    | { t: 'ask' | 'think' | 'agent'; mods: Record<string, Expr>; prompt: Expr };

export interface AskMods {
    len?: 'word' | 'sentence' | 'paragraph' | 'long';
    fmt?: 'integer' | 'float' | 'array' | 'object' | 'text' | 'boolean' | 'json';
}

export type ToolName = 'read_file' | 'write_file' | 'web_fetch' | 'web_search' | 'shell';
export type RestrictKind = 'fs' | 'net' | 'exec' | 'mcp';

export type AssignTarget =
    | { t: 'name'; name: string }
    | { t: 'member'; obj: Expr; name: string; line?: number; col?: number }
    | { t: 'index'; obj: Expr; index: Expr };

interface Base {
    line: number;
}

export type Stmt = Base &
    (
        | { t: 'let'; name: string; annotation?: TypeExpr; value: Expr }
        | { t: 'assign'; target: AssignTarget; op: '=' | '+=' | '-=' | '*=' | '/=' | '//=' | '%='; value: Expr }
        | { t: 'block'; body: Stmt[] }
        | { t: 'expr'; e: Expr }
        | { t: 'if'; branches: { cond: Expr; body: Stmt[] }[]; orelse?: Stmt[] }
        | { t: 'for'; vars: string[]; iter: Expr; body: Stmt[] }
        | { t: 'while'; cond: Expr; body: Stmt[] }
        | { t: 'break' }
        | { t: 'continue' }
        | { t: 'pass' }
        | { t: 'natural'; text: string }
        | { t: 'def'; name: string; params: string[]; paramTypes?: (TypeExpr | undefined)[]; returnType?: TypeExpr; body: Stmt[] }
        | { t: 'enum'; name: string; values: string[] }
        | { t: 'type-alias'; name: string; type: TypeExpr; advice: Record<string, unknown> }
        | { t: 'struct'; name: string; fields: FieldDecl[] }
        | { t: 'class'; name: string; fields: FieldDecl[]; methods: DefStmt[]; hydratable: boolean }
        | { t: 'return'; value?: Expr }
        | { t: 'try'; body: Stmt[]; errName: string; handler: Stmt[] }
        | { t: 'assert'; cond: Expr; message?: Expr }
        | { t: 'fail'; reason: Expr }
        | { t: 'success'; value?: Expr }
        | { t: 'constraint'; kind: 'enforce' | 'forbid'; text: Expr; body: Stmt[] }
        | { t: 'restrict'; clauses: { kind: RestrictKind; arg: Expr }[]; body: Stmt[] }
    );

export interface Directives {
    model?: string;
}

export interface Program {
    directives: Directives;
    body: Stmt[];
    lines: string[];
    markdown?: { preamble?: string; lock?: PinData };
}
import type { PinData } from './pin.js';
