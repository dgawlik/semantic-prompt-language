import {
  INT64_MAX,
  INT64_MIN,
  SplObject,
  SplValue,
  compareCodePoints,
  escapeJsonString,
  makeSplObject,
  normalizeFloat,
  sortKeysCodePoint,
} from "./canonical.js";

export interface Span {
  line: number;
  col: number;
  offset: number;
  endOffset: number;
}

export interface SplDiagnostic {
  code: string;
  message: string;
  span?: Span;
  expected?: string;
  found?: string;
}

export class SplCompileError extends Error {
  constructor(public readonly diagnostics: SplDiagnostic[]) {
    super(diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    this.name = "SplCompileError";
  }
}

// --- Static Type Representation ---

export type SplType =
  | { kind: "null" }
  | { kind: "bool" }
  | { kind: "int" }
  | { kind: "float" }
  | { kind: "string" }
  | { kind: "json" }
  | { kind: "void" }
  | { kind: "error" }
  | { kind: "list"; elem: SplType }
  | { kind: "map"; value: SplType }
  | { kind: "record"; fields: Array<{ name: string; type: SplType }> }
  | { kind: "str_union"; literals: string[] }
  | { kind: "nullable"; inner: SplType };

export const T_NULL: SplType = { kind: "null" };
export const T_BOOL: SplType = { kind: "bool" };
export const T_INT: SplType = { kind: "int" };
export const T_FLOAT: SplType = { kind: "float" };
export const T_STRING: SplType = { kind: "string" };
export const T_JSON: SplType = { kind: "json" };
export const T_VOID: SplType = { kind: "void" };
export const T_ERROR: SplType = { kind: "error" };

export function makeList(elem: SplType): SplType {
  return { kind: "list", elem };
}

export function makeMap(value: SplType): SplType {
  return { kind: "map", value };
}

export function makeRecord(fields: Array<{ name: string; type: SplType }>): SplType {
  const sorted = [...fields].sort((a, b) => compareCodePoints(a.name, b.name));
  return { kind: "record", fields: sorted };
}

export function makeStrUnion(literals: string[]): SplType {
  const uniq = Array.from(new Set(literals)).sort(compareCodePoints);
  return { kind: "str_union", literals: uniq };
}

export function makeNullable(inner: SplType): SplType {
  if (inner.kind === "null" || inner.kind === "nullable") return inner;
  return { kind: "nullable", inner };
}

export const T_WEB_SEARCH_RESULT: SplType = makeRecord([
  { name: "snippet", type: T_STRING },
  { name: "title", type: T_STRING },
  { name: "url", type: T_STRING },
]);

export const T_WEB_FETCH_RESPONSE: SplType = makeRecord([
  { name: "body", type: T_STRING },
  { name: "content_type", type: T_STRING },
  { name: "headers", type: makeMap(T_STRING) },
  { name: "status", type: T_INT },
  { name: "truncated", type: T_BOOL },
  { name: "url", type: T_STRING },
]);

export const T_FS_STAT: SplType = makeRecord([
  { name: "exists", type: T_BOOL },
  { name: "is_dir", type: T_BOOL },
  { name: "is_file", type: T_BOOL },
  { name: "size_bytes", type: T_INT },
]);

export const T_SHELL_RESULT: SplType = makeRecord([
  { name: "exit_code", type: T_INT },
  { name: "stderr", type: T_STRING },
  { name: "stdout", type: T_STRING },
  { name: "truncated", type: T_BOOL },
]);

export const T_ERROR_RECORD: SplType = makeRecord([
  { name: "code", type: T_STRING },
  { name: "details", type: makeNullable(T_JSON) },
  { name: "message", type: T_STRING },
  { name: "retryable", type: T_BOOL },
]);

/**
 * §8.1 Canonical type string with zero extra spaces.
 */
export function canonicalTypeString(t: SplType): string {
  switch (t.kind) {
    case "null":
      return "null";
    case "bool":
      return "bool";
    case "int":
      return "int";
    case "float":
      return "float";
    case "string":
      return "string";
    case "json":
      return "json";
    case "void":
      return "void";
    case "error":
      return "Error";
    case "list":
      return `list<${canonicalTypeString(t.elem)}>`;
    case "map":
      return `map<string,${canonicalTypeString(t.value)}>`;
    case "record":
      return `{${t.fields.map((f) => `${f.name}:${canonicalTypeString(f.type)}`).join(",")}}`;
    case "str_union":
      return `(${t.literals.map((l) => escapeJsonString(l)).join("|")})`;
    case "nullable":
      return `${canonicalTypeString(t.inner)}?`;
  }
}

export function typesEqual(a: SplType, b: SplType): boolean {
  return canonicalTypeString(a) === canonicalTypeString(b);
}

/**
 * Parse a canonical type string back to SplType (used by bytecode parser).
 */
export function parseCanonicalTypeString(input: string): SplType {
  let pos = 0;
  function parseType(): SplType {
    let base = parseBase();
    if (pos < input.length && input[pos] === "?") {
      pos++;
      base = makeNullable(base);
    }
    return base;
  }

  function parseBase(): SplType {
    if (input.startsWith("list<", pos)) {
      pos += 5;
      const elem = parseType();
      expect(">");
      return makeList(elem);
    }
    if (input.startsWith("map<string,", pos)) {
      pos += 11;
      const val = parseType();
      expect(">");
      return makeMap(val);
    }
    if (input[pos] === "{") {
      pos++;
      const fields: Array<{ name: string; type: SplType }> = [];
      if (input[pos] !== "}") {
        while (true) {
          const name = parseIdent();
          expect(":");
          const ft = parseType();
          fields.push({ name, type: ft });
          if (input[pos] === ",") {
            pos++;
            continue;
          }
          break;
        }
      }
      expect("}");
      return makeRecord(fields);
    }
    if (input[pos] === "(") {
      pos++;
      const lits: string[] = [];
      while (true) {
        lits.push(parseQuotedString());
        if (input[pos] === "|") {
          pos++;
          continue;
        }
        break;
      }
      expect(")");
      return makeStrUnion(lits);
    }
    const id = parseIdent();
    switch (id) {
      case "null":
        return T_NULL;
      case "bool":
        return T_BOOL;
      case "int":
        return T_INT;
      case "float":
        return T_FLOAT;
      case "string":
        return T_STRING;
      case "json":
        return T_JSON;
      case "void":
        return T_VOID;
      case "Error":
        return T_ERROR;
      default:
        throw new Error(`Unknown canonical type token '${id}' in '${input}'`);
    }
  }

  function parseIdent(): string {
    const start = pos;
    while (pos < input.length && /[A-Za-z0-9_]/.test(input[pos])) pos++;
    if (pos === start) throw new Error(`Expected identifier at ${pos} in '${input}'`);
    return input.slice(start, pos);
  }

  function parseQuotedString(): string {
    expect('"');
    let out = "";
    while (pos < input.length) {
      const ch = input[pos++];
      if (ch === '"') return out;
      if (ch === "\\") {
        const esc = input[pos++];
        if (esc === '"') out += '"';
        else if (esc === "\\") out += "\\";
        else if (esc === "n") out += "\n";
        else if (esc === "r") out += "\r";
        else if (esc === "t") out += "\t";
        else if (esc === "b") out += "\b";
        else if (esc === "f") out += "\f";
        else if (esc === "u") {
          const hex = input.slice(pos, pos + 4);
          pos += 4;
          out += String.fromCharCode(parseInt(hex, 16));
        } else {
          throw new Error(`Invalid escape \\${esc}`);
        }
      } else {
        out += ch;
      }
    }
    throw new Error("Unterminated string literal in canonical type");
  }

  function expect(ch: string): void {
    if (input[pos] !== ch) {
      throw new Error(`Expected '${ch}' at ${pos} in canonical type '${input}'`);
    }
    pos++;
  }

  const res = parseType();
  if (pos !== input.length) {
    throw new Error(`Trailing characters '${input.slice(pos)}' in canonical type '${input}'`);
  }
  return res;
}

export function isAssignable(from: SplType, to: SplType): boolean {
  if (typesEqual(from, to)) return true;
  if (to.kind === "json") {
    return from.kind !== "void";
  }
  if (to.kind === "nullable") {
    if (from.kind === "null") return true;
    if (from.kind === "nullable") return isAssignable(from.inner, to.inner);
    return isAssignable(from, to.inner);
  }
  if (to.kind === "string" && from.kind === "str_union") {
    return true;
  }
  if (to.kind === "str_union" && from.kind === "str_union") {
    return from.literals.every((l) => to.literals.includes(l));
  }
  if (to.kind === "list" && from.kind === "list") {
    return isAssignable(from.elem, to.elem);
  }
  if (to.kind === "map" && from.kind === "map") {
    return isAssignable(from.value, to.value);
  }
  if (to.kind === "record" && from.kind === "record") {
    if (to.fields.length !== from.fields.length) return false;
    for (let i = 0; i < to.fields.length; i++) {
      if (to.fields[i].name !== from.fields[i].name) return false;
      if (!isAssignable(from.fields[i].type, to.fields[i].type)) return false;
    }
    return true;
  }
  if (to.kind === "record" && from.kind === "error") {
    return isAssignable(T_ERROR_RECORD, to);
  }
  return false;
}

// --- JSON Schema Mapping (§4.8) ---

export type JsonSchema = Record<string, unknown>;

export function splTypeToJsonSchema(
  t: SplType,
  opts: { strict?: boolean } = {}
): { ok: true; schema: JsonSchema } | { ok: false; reason: string } {
  const strict = opts.strict ?? true;
  switch (t.kind) {
    case "null":
      return { ok: true, schema: { type: "null" } };
    case "bool":
      return { ok: true, schema: { type: "boolean" } };
    case "int":
      return { ok: true, schema: { type: "integer" } };
    case "float":
      return { ok: true, schema: { type: "number" } };
    case "string":
      return { ok: true, schema: { type: "string" } };
    case "void":
      return { ok: false, reason: "void cannot be converted to a JSON Schema" };
    case "json":
      if (strict) {
        return { ok: false, reason: "json type is not allowed in OpenAI strict JSON Schema mode" };
      }
      return { ok: true, schema: {} };
    case "error":
      return splTypeToJsonSchema(T_ERROR_RECORD, opts);
    case "str_union":
      return { ok: true, schema: { enum: [...t.literals], type: "string" } };
    case "nullable": {
      const inner = splTypeToJsonSchema(t.inner, opts);
      if (!inner.ok) return inner;
      return { ok: true, schema: { anyOf: [inner.schema, { type: "null" }] } };
    }
    case "list": {
      const elem = splTypeToJsonSchema(t.elem, opts);
      if (!elem.ok) return elem;
      return { ok: true, schema: { items: elem.schema, type: "array" } };
    }
    case "map": {
      if (strict) {
        return { ok: false, reason: "map<string, T> is not allowed in OpenAI strict JSON Schema mode" };
      }
      const val = splTypeToJsonSchema(t.value, opts);
      if (!val.ok) return val;
      return { ok: true, schema: { additionalProperties: val.schema, type: "object" } };
    }
    case "record": {
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      for (const f of t.fields) {
        const fs = splTypeToJsonSchema(f.type, opts);
        if (!fs.ok) return fs;
        properties[f.name] = fs.schema;
        required.push(f.name);
      }
      return {
        ok: true,
        schema: {
          additionalProperties: false,
          properties,
          required,
          type: "object",
        },
      };
    }
  }
}

/**
 * Runtime boundary validator: validates arbitrary JSON/host data against an SPL Type
 * and returns a canonical SplValue (bigint for int, normalized finite number for float,
 * code-point sorted objects/maps).
 */
export function validateRuntimeValue(
  val: unknown,
  t: SplType,
  path = "$"
): { ok: true; value: SplValue } | { ok: false; message: string } {
  switch (t.kind) {
    case "null":
    case "void":
      return val === null
        ? { ok: true, value: null }
        : { ok: false, message: `${path}: expected null` };

    case "bool":
      return typeof val === "boolean"
        ? { ok: true, value: val }
        : { ok: false, message: `${path}: expected bool` };

    case "int": {
      if (typeof val === "bigint") {
        if (val < INT64_MIN || val > INT64_MAX) {
          return { ok: false, message: `${path}: int64 out of range` };
        }
        return { ok: true, value: val };
      }
      if (typeof val === "number") {
        if (!Number.isFinite(val) || !Number.isInteger(val)) {
          return { ok: false, message: `${path}: expected integer` };
        }
        if (!Number.isSafeInteger(val)) {
          return { ok: false, message: `${path}: unsafe integer number; provide exact int64` };
        }
        return { ok: true, value: BigInt(val) };
      }
      return { ok: false, message: `${path}: expected int` };
    }

    case "float": {
      if (typeof val === "number") {
        if (!Number.isFinite(val)) {
          return { ok: false, message: `${path}: float must be finite` };
        }
        return { ok: true, value: normalizeFloat(val) };
      }
      if (typeof val === "bigint") {
        const num = Number(val);
        if (!Number.isFinite(num)) {
          return { ok: false, message: `${path}: float must be finite` };
        }
        return { ok: true, value: normalizeFloat(num) };
      }
      return { ok: false, message: `${path}: expected float` };
    }

    case "string":
      return typeof val === "string"
        ? { ok: true, value: val }
        : { ok: false, message: `${path}: expected string` };

    case "str_union":
      if (typeof val !== "string" || !t.literals.includes(val)) {
        return {
          ok: false,
          message: `${path}: expected one of ${t.literals.map(escapeJsonString).join(" | ")}`,
        };
      }
      return { ok: true, value: val };

    case "nullable":
      if (val === null) return { ok: true, value: null };
      return validateRuntimeValue(val, t.inner, path);

    case "list": {
      if (!Array.isArray(val)) return { ok: false, message: `${path}: expected list` };
      const out: SplValue[] = [];
      for (let i = 0; i < val.length; i++) {
        const res = validateRuntimeValue(val[i], t.elem, `${path}[${i}]`);
        if (!res.ok) return res;
        out.push(res.value);
      }
      return { ok: true, value: out };
    }

    case "map": {
      if (val === null || typeof val !== "object" || Array.isArray(val)) {
        return { ok: false, message: `${path}: expected map object` };
      }
      const obj = val as Record<string, unknown>;
      const entries: Array<[string, SplValue]> = [];
      for (const k of sortKeysCodePoint(Object.keys(obj))) {
        const res = validateRuntimeValue(obj[k], t.value, `${path}.${k}`);
        if (!res.ok) return res;
        entries.push([k, res.value]);
      }
      return { ok: true, value: makeSplObject(entries) };
    }

    case "error":
      return validateRuntimeValue(val, T_ERROR_RECORD, path);

    case "record": {
      if (val === null || typeof val !== "object" || Array.isArray(val)) {
        return { ok: false, message: `${path}: expected record object` };
      }
      const obj = val as Record<string, unknown>;
      const allowed = new Set(t.fields.map((f) => f.name));
      for (const k of Object.keys(obj)) {
        if (!allowed.has(k)) {
          return { ok: false, message: `${path}: unexpected extra field '${k}'` };
        }
      }
      const entries: Array<[string, SplValue]> = [];
      for (const f of t.fields) {
        if (!Object.prototype.hasOwnProperty.call(obj, f.name)) {
          if (f.type.kind === "nullable") {
            entries.push([f.name, null]);
            continue;
          }
          return { ok: false, message: `${path}: missing required field '${f.name}'` };
        }
        const res = validateRuntimeValue(obj[f.name], f.type, `${path}.${f.name}`);
        if (!res.ok) return res;
        entries.push([f.name, res.value]);
      }
      return { ok: true, value: makeSplObject(entries) };
    }

    case "json":
      return validateJsonValue(val, path);
  }
}

function validateJsonValue(
  val: unknown,
  path: string
): { ok: true; value: SplValue } | { ok: false; message: string } {
  if (val === null || typeof val === "boolean" || typeof val === "string") {
    return { ok: true, value: val };
  }
  if (typeof val === "bigint") {
    if (val < INT64_MIN || val > INT64_MAX) {
      return { ok: false, message: `${path}: int64 out of range` };
    }
    return { ok: true, value: val };
  }
  if (typeof val === "number") {
    if (!Number.isFinite(val)) {
      return { ok: false, message: `${path}: JSON number must be finite` };
    }
    return { ok: true, value: normalizeFloat(val) };
  }
  if (Array.isArray(val)) {
    const out: SplValue[] = [];
    for (let i = 0; i < val.length; i++) {
      const r = validateJsonValue(val[i], `${path}[${i}]`);
      if (!r.ok) return r;
      out.push(r.value);
    }
    return { ok: true, value: out };
  }
  if (typeof val === "object") {
    const obj = val as Record<string, unknown>;
    const entries: Array<[string, SplValue]> = [];
    for (const k of sortKeysCodePoint(Object.keys(obj))) {
      const r = validateJsonValue(obj[k], `${path}.${k}`);
      if (!r.ok) return r;
      entries.push([k, r.value]);
    }
    return { ok: true, value: makeSplObject(entries) };
  }
  return { ok: false, message: `${path}: unsupported JSON value type ${typeof val}` };
}

/**
 * Runtime validator against a JSON Schema (used for CAST_JSON and schema pool entries).
 */
export function validateValueAgainstJsonSchema(
  val: SplValue,
  schema: JsonSchema,
  path = "$"
): { ok: true; value: SplValue } | { ok: false; message: string } {
  if (Object.keys(schema).length === 0) {
    return validateJsonValue(val, path);
  }
  if (Array.isArray(schema.anyOf)) {
    for (const branch of schema.anyOf as JsonSchema[]) {
      const r = validateValueAgainstJsonSchema(val, branch, path);
      if (r.ok) return r;
    }
    return { ok: false, message: `${path}: value did not match anyOf schema` };
  }
  if (Array.isArray(schema.enum)) {
    if (typeof val !== "string" || !(schema.enum as unknown[]).includes(val)) {
      return { ok: false, message: `${path}: value not in enum` };
    }
    return { ok: true, value: val };
  }
  switch (schema.type) {
    case "null":
      return validateRuntimeValue(val, T_NULL, path);
    case "boolean":
      return validateRuntimeValue(val, T_BOOL, path);
    case "integer":
      return validateRuntimeValue(val, T_INT, path);
    case "number":
      return validateRuntimeValue(val, T_FLOAT, path);
    case "string":
      return validateRuntimeValue(val, T_STRING, path);
    case "array": {
      if (!Array.isArray(val)) return { ok: false, message: `${path}: expected array` };
      const itemSchema = (schema.items ?? {}) as JsonSchema;
      const out: SplValue[] = [];
      for (let i = 0; i < val.length; i++) {
        const r = validateValueAgainstJsonSchema(val[i], itemSchema, `${path}[${i}]`);
        if (!r.ok) return r;
        out.push(r.value);
      }
      return { ok: true, value: out };
    }
    case "object": {
      if (val === null || typeof val !== "object" || Array.isArray(val)) {
        return { ok: false, message: `${path}: expected object` };
      }
      const obj = val as SplObject;
      const props = (schema.properties ?? {}) as Record<string, JsonSchema>;
      const req = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
      const addProps = schema.additionalProperties;

      const entries: Array<[string, SplValue]> = [];
      for (const reqKey of req) {
        if (!Object.prototype.hasOwnProperty.call(obj, reqKey)) {
          return { ok: false, message: `${path}: missing required property '${reqKey}'` };
        }
      }
      for (const k of sortKeysCodePoint(Object.keys(obj))) {
        if (Object.prototype.hasOwnProperty.call(props, k)) {
          const r = validateValueAgainstJsonSchema(obj[k], props[k], `${path}.${k}`);
          if (!r.ok) return r;
          entries.push([k, r.value]);
        } else if (addProps === false) {
          return { ok: false, message: `${path}: additional property '${k}' not allowed` };
        } else if (addProps && typeof addProps === "object") {
          const r = validateValueAgainstJsonSchema(obj[k], addProps as JsonSchema, `${path}.${k}`);
          if (!r.ok) return r;
          entries.push([k, r.value]);
        } else {
          const r = validateJsonValue(obj[k], `${path}.${k}`);
          if (!r.ok) return r;
          entries.push([k, r.value]);
        }
      }
      return { ok: true, value: makeSplObject(entries) };
    }
    default:
      return validateJsonValue(val, path);
  }
}

// --- AST Definitions ---

export type TypeAst =
  | { kind: "t_prim"; name: "null" | "bool" | "int" | "float" | "string" | "json" | "void" | "Error"; span: Span }
  | { kind: "t_named"; name: string; span: Span }
  | { kind: "t_str_lit"; value: string; span: Span }
  | { kind: "t_list"; elem: TypeAst; span: Span }
  | { kind: "t_map"; value: TypeAst; span: Span }
  | { kind: "t_record"; fields: Array<{ name: string; type: TypeAst; span: Span }>; span: Span }
  | { kind: "t_nullable"; inner: TypeAst; span: Span }
  | { kind: "t_union"; members: TypeAst[]; span: Span };

export interface TypeDecl {
  kind: "type_decl";
  name: string;
  typeAst: TypeAst;
  span: Span;
}

export interface InputDecl {
  kind: "input_decl";
  name: string;
  typeAst: TypeAst;
  defaultExpr?: Expr;
  span: Span;
}

export interface StateDecl {
  kind: "state_decl";
  name: string;
  typeAst: TypeAst;
  initExpr: Expr;
  span: Span;
}

export interface FnParam {
  name: string;
  typeAst: TypeAst;
  span: Span;
}

export interface FnDecl {
  kind: "fn_decl";
  name: string;
  params: FnParam[];
  retTypeAst: TypeAst;
  body: BlockStmt;
  span: Span;
}

export interface ProgramAst {
  types: TypeDecl[];
  inputs: InputDecl[];
  states: StateDecl[];
  functions: FnDecl[];
  topStmts: Stmt[];
  span: Span;
}

export interface BlockStmt {
  kind: "block";
  stmts: Stmt[];
  span: Span;
}

export type LValueSeg =
  | { kind: "field"; name: string; span: Span }
  | { kind: "index"; index: Expr; span: Span };

export interface LValue {
  root: string;
  segments: LValueSeg[];
  span: Span;
}

export type CaseLiteral =
  | { kind: "string"; value: string; span: Span }
  | { kind: "int"; value: bigint; span: Span }
  | { kind: "bool"; value: boolean; span: Span };

export interface SwitchCase {
  literals: CaseLiteral[];
  body: BlockStmt;
  span: Span;
}

export type Stmt =
  | { kind: "let"; mutable: boolean; name: string; typeAst?: TypeAst; init: Expr; span: Span }
  | { kind: "assign"; target: LValue; value: Expr; span: Span }
  | { kind: "if"; cond: Expr; thenBlock: BlockStmt; elseBranch?: BlockStmt | Extract<Stmt, { kind: "if" }>; span: Span }
  | { kind: "switch"; discriminant: Expr; cases: SwitchCase[]; defaultBlock?: BlockStmt; span: Span }
  | { kind: "while"; cond: Expr; body: BlockStmt; span: Span }
  | { kind: "for"; itemName: string; iterable: Expr; body: BlockStmt; span: Span }
  | { kind: "try"; tryBlock: BlockStmt; errName: string; catchBlock: BlockStmt; span: Span }
  | { kind: "return"; value?: Expr; span: Span }
  | { kind: "break"; span: Span }
  | { kind: "continue"; span: Span }
  | { kind: "expr_stmt"; expr: Expr; span: Span };

export type BinaryOp =
  | "??"
  | "||"
  | "&&"
  | "|"
  | "^"
  | "&"
  | "=="
  | "!="
  | "<"
  | "<="
  | ">"
  | ">="
  | "<<"
  | ">>"
  | ">>>"
  | "+"
  | "-"
  | "*"
  | "/"
  | "%";

export type UnaryOp = "!" | "-" | "~";

export type FsOp = "read" | "write" | "append" | "exists" | "list" | "stat";

export type TemplatePart =
  | { kind: "text"; value: string; span: Span }
  | { kind: "expr"; expr: Expr; span: Span };

export type Expr =
  | { kind: "lit_null"; span: Span }
  | { kind: "lit_bool"; value: boolean; span: Span }
  | { kind: "lit_int"; value: bigint; span: Span }
  | { kind: "lit_float"; value: number; span: Span }
  | { kind: "lit_string"; value: string; span: Span }
  | { kind: "template_str"; parts: TemplatePart[]; span: Span }
  | { kind: "list_lit"; items: Expr[]; span: Span }
  | { kind: "record_lit"; entries: Array<{ key: string; value: Expr; span: Span }>; span: Span }
  | { kind: "var_ref"; name: string; span: Span }
  | { kind: "unary"; op: UnaryOp; operand: Expr; span: Span }
  | { kind: "binary"; op: BinaryOp; left: Expr; right: Expr; span: Span }
  | { kind: "cast"; expr: Expr; targetTypeAst: TypeAst; span: Span }
  | { kind: "prop_access"; object: Expr; property: string; optional: boolean; span: Span }
  | { kind: "index_access"; object: Expr; index: Expr; optional: boolean; span: Span }
  | { kind: "call"; callee: Expr; args: Expr[]; span: Span }
  | { kind: "eff_ask"; typeAst: TypeAst; args: Expr[]; span: Span }
  | { kind: "eff_decide"; args: Expr[]; span: Span }
  | { kind: "eff_web_search"; args: Expr[]; span: Span }
  | { kind: "eff_web_fetch"; args: Expr[]; span: Span }
  | { kind: "eff_fs"; op: FsOp; args: Expr[]; span: Span }
  | { kind: "eff_shell"; args: Expr[]; span: Span }
  | { kind: "eff_js_tool"; name: string; arg: Expr; span: Span }
  | { kind: "eff_mcp_tool"; server: string; tool: string; arg: Expr; span: Span };
