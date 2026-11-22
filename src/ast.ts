import type { Span } from "./errors.js";

// ==================== Program / Module ====================

export interface Program {
  file: string;
  isStdlib: boolean;
  items: TopItem[];
}

export type TopItem =
  | ImportDecl
  | TypeDecl
  | EnumDecl
  | TraitDecl
  | ImplDecl
  | FnDecl
  | ExternFnDecl
  | LetStmt
  | AssignStmt
  | FieldAssignStmt
  | IndexAssignStmt
  | WhileStmt
  | ForStmt
  | ExprStmt;

export interface ImportDecl {
  kind: "ImportDecl";
  specifiers: ImportSpecifier[]; // empty if namespace import `import fs from "std/fs"`
  defaultAlias?: string;
  from: string;
  span: Span;
}

export interface ImportSpecifier {
  name: string;
  alias?: string;
}

export interface TypeDecl {
  kind: "TypeDecl";
  pub: boolean;
  name: string;
  typeParams: TypeParam[];
  doc?: string;
  llmHint?: string;
  body: TypeExpr;
  span: Span;
}

export interface TypeParam {
  name: string;
  bounds: string[]; // trait names e.g. T: Ord
}

export interface EnumDecl {
  kind: "EnumDecl";
  pub: boolean;
  name: string;
  typeParams: TypeParam[];
  doc?: string;
  llmHint?: string;
  variants: EnumVariantDecl[];
  span: Span;
}

export interface EnumVariantDecl {
  name: string;
  fields: TypeExpr[]; // empty for unit variant, e.g. None; 1+ for tuple variant e.g. Ok(T)
  namedFields?: StructFieldDecl[]; // optional record variant e.g. Move { x: Int, y: Int }
  doc?: string;
  llmHint?: string;
  span: Span;
}

export interface TraitDecl {
  kind: "TraitDecl";
  pub: boolean;
  name: string;
  typeParams: TypeParam[];
  doc?: string;
  llmHint?: string;
  methods: TraitMethodSig[];
  span: Span;
}

export interface TraitMethodSig {
  name: string;
  params: ParamDecl[];
  returnType?: TypeExpr;
  span: Span;
}

export interface ImplDecl {
  kind: "ImplDecl";
  traitName: string;
  typeParams: TypeParam[];
  targetType: TypeExpr;
  methods: FnDecl[];
  span: Span;
}

export interface ParamDecl {
  name: string;
  mutable?: boolean;
  type?: TypeExpr;
  defaultValue?: Expr;
  span: Span;
}

export interface FnDecl {
  kind: "FnDecl";
  pub: boolean;
  reified?: boolean;
  name: string;
  receiverType?: TypeExpr; // For extension methods: `fn Person.fullName(self) -> Str`
  typeParams: TypeParam[];
  params: ParamDecl[];
  returnType?: TypeExpr;
  doc?: string;
  llmHint?: string;
  body: BlockExpr;
  span: Span;
}

export interface ExternFnDecl {
  kind: "ExternFnDecl";
  pub: boolean;
  name: string;
  typeParams: TypeParam[];
  params: ParamDecl[];
  returnType: TypeExpr;
  jsModule: string; // e.g. "core" | "ffi_universal" | "ffi_server" | "ffi_codegen"
  jsName: string;   // exported JS function name
  isAsync: boolean;
  reified?: boolean; // compiler injects compile-time type descriptors for explicit `<T...>` type args
  doc?: string;
  llmHint?: string;
  span: Span;
}

// ==================== Type Expressions ====================

export type TypeExpr =
  | NamedTypeExpr
  | OptionTypeExpr
  | TupleTypeExpr
  | FnTypeExpr
  | RecordTypeExpr;

export interface NamedTypeExpr {
  kind: "NamedTypeExpr";
  name: string;
  typeArgs: TypeExpr[];
  span: Span;
}

export interface OptionTypeExpr {
  kind: "OptionTypeExpr";
  inner: TypeExpr;
  span: Span;
}

export interface TupleTypeExpr {
  kind: "TupleTypeExpr";
  elements: TypeExpr[];
  span: Span;
}

export interface FnTypeExpr {
  kind: "FnTypeExpr";
  params: TypeExpr[];
  returnType: TypeExpr;
  isAsync?: boolean;
  span: Span;
}

export interface StructFieldDecl {
  name: string;
  type: TypeExpr;
  doc?: string;
  llmHint?: string;
  span: Span;
}

export type RecordRowTail =
  | { kind: "Closed" }
  | { kind: "OpenVar"; name?: string } // `..` or `..r`
  | { kind: "OpenDict"; name?: string; valueType: TypeExpr; doc?: string; llmHint?: string }; // `..extra: Dict<Str, V>`

export interface RecordTypeExpr {
  kind: "RecordTypeExpr";
  isStructKeyword: boolean;
  fields: StructFieldDecl[];
  tail: RecordRowTail;
  span: Span;
}

// ==================== Statements ====================

export type Stmt =
  | LetStmt
  | AssignStmt
  | FieldAssignStmt
  | IndexAssignStmt
  | ReturnStmt
  | WhileStmt
  | ForStmt
  | FnDecl
  | TypeDecl
  | EnumDecl
  | ExprStmt;

export interface LetStmt {
  kind: "LetStmt";
  pub?: boolean;
  mutable: boolean;
  pattern: Pattern;
  typeAnnotation?: TypeExpr;
  value: Expr;
  span: Span;
}

export interface AssignStmt {
  kind: "AssignStmt";
  target: string;
  value: Expr;
  span: Span;
}

export interface FieldAssignStmt {
  kind: "FieldAssignStmt";
  object: Expr;
  property: string;
  value: Expr;
  span: Span;
}

export interface IndexAssignStmt {
  kind: "IndexAssignStmt";
  object: Expr;
  index: Expr;
  value: Expr;
  span: Span;
}

export interface ReturnStmt {
  kind: "ReturnStmt";
  value?: Expr;
  span: Span;
}

export interface WhileStmt {
  kind: "WhileStmt";
  cond: Expr;
  body: BlockExpr;
  span: Span;
}

export interface ForStmt {
  kind: "ForStmt";
  pattern: Pattern;
  iterable: Expr;
  body: BlockExpr;
  span: Span;
}

export interface ExprStmt {
  kind: "ExprStmt";
  expr: Expr;
  span: Span;
}

// ==================== Expressions ====================

export type Expr =
  | IntLitExpr
  | FloatLitExpr
  | StrLitExpr
  | StrInterpExpr
  | CharLitExpr
  | BoolLitExpr
  | PromptExpr
  | IdentExpr
  | TupleExpr
  | ArrayExpr
  | RecordExpr
  | LambdaExpr
  | BlockExpr
  | UnaryExpr
  | BinaryExpr
  | AsExpr
  | RangeExpr
  | CallExpr
  | MemberExpr
  | OptionalMemberExpr
  | NullCoalesceExpr
  | IndexExpr
  | TryExpr
  | IfExpr
  | MatchExpr
  | ReturnExpr
  | TypeSchemaExpr
  | DecodeExpr;

export interface ReturnExpr {
  kind: "ReturnExpr";
  value?: Expr;
  span: Span;
}

export interface IntLitExpr {
  kind: "IntLitExpr";
  value: number;
  span: Span;
}

export interface FloatLitExpr {
  kind: "FloatLitExpr";
  value: number;
  span: Span;
}

export interface StrLitExpr {
  kind: "StrLitExpr";
  value: string;
  span: Span;
}

export interface StrInterpExpr {
  kind: "StrInterpExpr";
  parts: (string | Expr)[];
  span: Span;
}

export interface CharLitExpr {
  kind: "CharLitExpr";
  value: string;
  span: Span;
}

export interface BoolLitExpr {
  kind: "BoolLitExpr";
  value: boolean;
  span: Span;
}

export interface PromptExpr {
  kind: "PromptExpr";
  parts: (string | Expr)[]; // dedented text segments and interpolated expressions
  span: Span;
}

export interface IdentExpr {
  kind: "IdentExpr";
  name: string;
  span: Span;
}

export interface TupleExpr {
  kind: "TupleExpr";
  elements: Expr[];
  span: Span;
}

export interface ArrayExpr {
  kind: "ArrayExpr";
  elements: Expr[];
  span: Span;
}

export interface RecordFieldInit {
  kind: "Field";
  name: string;
  value: Expr;
  span: Span;
}

export interface RecordSpreadInit {
  kind: "Spread";
  expr: Expr;
  span: Span;
}

export interface RecordExpr {
  kind: "RecordExpr";
  typeName?: string; // optional e.g. `Person { ... }`
  entries: (RecordFieldInit | RecordSpreadInit)[];
  span: Span;
}

export interface LambdaExpr {
  kind: "LambdaExpr";
  params: ParamDecl[];
  returnType?: TypeExpr;
  body: BlockExpr;
  span: Span;
}

export interface BlockExpr {
  kind: "BlockExpr";
  stmts: Stmt[];
  tailExpr?: Expr;
  span: Span;
}

export interface UnaryExpr {
  kind: "UnaryExpr";
  op: "-" | "!" | "~";
  operand: Expr;
  span: Span;
}

export interface RangeExpr {
  kind: "RangeExpr";
  start: Expr;
  end: Expr;
  step?: Expr;
  inclusive: boolean;
  span: Span;
}

export interface AsExpr {
  kind: "AsExpr";
  expr: Expr;
  targetType: TypeExpr;
  span: Span;
}

export interface BinaryExpr {
  kind: "BinaryExpr";
  op:
    | "+" | "-" | "*" | "/" | "%" | "**"
    | "==" | "!=" | "<" | "<=" | ">" | ">="
    | "&&" | "||"
    | "&" | "|" | "^" | "<<" | ">>";
  left: Expr;
  right: Expr;
  span: Span;
}

export interface CallArg {
  name?: string; // for named arguments `model: "gpt-6"`
  value: Expr;
  span: Span;
}

export interface CallExpr {
  kind: "CallExpr";
  callee: Expr;
  typeArgs: TypeExpr[];
  args: CallArg[];
  span: Span;
}

export interface MemberExpr {
  kind: "MemberExpr";
  object: Expr;
  property: string;
  span: Span;
}

export interface OptionalMemberExpr {
  kind: "OptionalMemberExpr";
  object: Expr;
  property: string;
  span: Span;
}

export interface NullCoalesceExpr {
  kind: "NullCoalesceExpr";
  left: Expr;
  right: Expr;
  span: Span;
}

export interface IndexExpr {
  kind: "IndexExpr";
  object: Expr;
  index: Expr;
  span: Span;
}

export interface TryExpr {
  kind: "TryExpr";
  operand: Expr;
  span: Span;
}

export interface IfExpr {
  kind: "IfExpr";
  cond: Expr;
  thenBranch: BlockExpr;
  elseBranch?: BlockExpr | IfExpr;
  span: Span;
}

export interface MatchArm {
  pattern: Pattern;
  guard?: Expr;
  body: Expr;
  span: Span;
}

export interface MatchExpr {
  kind: "MatchExpr";
  subject: Expr;
  arms: MatchArm[];
  span: Span;
}

export interface TypeSchemaExpr {
  kind: "TypeSchemaExpr";
  targetType: TypeExpr;
  span: Span;
}

export interface DecodeExpr {
  kind: "DecodeExpr";
  targetType: TypeExpr;
  arg: Expr;
  span: Span;
}

// ==================== Patterns ====================

export type Pattern =
  | WildcardPattern
  | IdentPattern
  | LiteralPattern
  | TuplePattern
  | ArrayPattern
  | EnumPattern
  | RecordPattern;

export interface WildcardPattern {
  kind: "WildcardPattern";
  span: Span;
}

export interface IdentPattern {
  kind: "IdentPattern";
  name: string;
  span: Span;
}

export interface LiteralPattern {
  kind: "LiteralPattern";
  value: number | string | boolean;
  literalType: "Int" | "Float" | "Str" | "Char" | "Bool";
  span: Span;
}

export interface TuplePattern {
  kind: "TuplePattern";
  elements: Pattern[];
  span: Span;
}

export interface ArrayPattern {
  kind: "ArrayPattern";
  elements: Pattern[];
  rest?: string; // optional `..rest`
  span: Span;
}

export interface EnumPattern {
  kind: "EnumPattern";
  enumName?: string; // optional qualifier e.g. ToolResult.Ok
  variant: string;
  fields: Pattern[];
  span: Span;
}

export interface RecordFieldPattern {
  name: string;
  pattern: Pattern;
  span: Span;
}

export interface RecordPattern {
  kind: "RecordPattern";
  fields: RecordFieldPattern[];
  hasRest: boolean; // `..`
  restName?: string; // optional `..rest`
  span: Span;
}
