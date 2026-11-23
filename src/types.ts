import { SplError, type Span } from "./errors.js";

// ==================== Type Representation ====================

export type PrimName =
  | "Int"
  | "Float"
  | "Str"
  | "Bool"
  | "Char"
  | "Byte"
  | "Bytes"
  | "Json"
  | "Prompt"
  | "Unit";

export type Type =
  | { kind: "TPrim"; name: PrimName }
  | { kind: "TVar"; id: number; name?: string; bounds: string[]; instance?: Type }
  | { kind: "TTuple"; elements: Type[] }
  | { kind: "TArray"; element: Type }
  | { kind: "TIter"; element: Type }
  | { kind: "TDict"; key: Type; value: Type }
  | { kind: "TFn"; params: Type[]; paramNames?: (string | undefined)[]; requiredCount?: number; ret: Type; isAsync?: boolean }
  | { kind: "TRecord"; fields: Map<string, Type>; tail: RowTail; meta?: RecordMeta }
  | { kind: "TEnum"; name: string; typeArgs: Type[]; variants: Map<string, EnumVariantType>; doc?: string; llmHint?: string }
  | { kind: "TNewtype"; name: string; moduleFile?: string; typeArgs: Type[]; underlying: Type; doc?: string; llmHint?: string };

export interface RecordMeta {
  typeName?: string;
  doc?: string;
  llmHint?: string;
  fieldDocs: Map<string, string>;
  fieldHints: Map<string, string>;
}

export interface EnumVariantType {
  fields: Type[];
  doc?: string;
  llmHint?: string;
}

export type RowTail =
  | { kind: "RClosed" }
  | { kind: "RVar"; id: number; instance?: RowTail; extraFields?: Map<string, Type> }
  | { kind: "ROpenDict"; valueType: Type; extraName?: string; doc?: string; llmHint?: string };

export interface TypeScheme {
  quantifiedTypeVars: number[];
  quantifiedRowVars: number[];
  explicitTypeParams?: number[]; // declared `<A, B>` var IDs in order for explicit call typeArgs
  reifiedTypeParams?: number[];  // ordered TVar IDs passed at runtime in `__spl_reified`
  type: Type;
}

// ==================== Constructors & Fresh Vars ====================

let nextVarId = 1;

export function resetTypeVars(): void {
  nextVarId = 1;
}

export function freshTVar(bounds: string[] = [], name?: string): Type {
  return { kind: "TVar", id: nextVarId++, name, bounds };
}

export function freshRVar(): RowTail {
  return { kind: "RVar", id: nextVarId++ };
}

export const TInt: Type = { kind: "TPrim", name: "Int" };
export const TFloat: Type = { kind: "TPrim", name: "Float" };
export const TStr: Type = { kind: "TPrim", name: "Str" };
export const TBool: Type = { kind: "TPrim", name: "Bool" };
export const TChar: Type = { kind: "TPrim", name: "Char" };
export const TByte: Type = { kind: "TPrim", name: "Byte" };
export const TBytes: Type = { kind: "TPrim", name: "Bytes" };
export const TJson: Type = { kind: "TPrim", name: "Json" };
export const TPrompt: Type = { kind: "TPrim", name: "Prompt" };
export const TUnit: Type = { kind: "TPrim", name: "Unit" };

export function tArray(element: Type): Type {
  return { kind: "TArray", element };
}

export function tIter(element: Type): Type {
  return { kind: "TIter", element };
}

export function tDict(key: Type, value: Type): Type {
  return { kind: "TDict", key, value };
}

export function tTuple(elements: Type[]): Type {
  return { kind: "TTuple", elements };
}

export function tOption(inner: Type): Type {
  return {
    kind: "TEnum",
    name: "Option",
    typeArgs: [inner],
    variants: new Map([
      ["Some", { fields: [inner] }],
      ["None", { fields: [] }],
    ]),
  };
}

export function tResult(ok: Type, err: Type): Type {
  return {
    kind: "TEnum",
    name: "Result",
    typeArgs: [ok, err],
    variants: new Map([
      ["Ok", { fields: [ok] }],
      ["Err", { fields: [err] }],
    ]),
  };
}

// ==================== Prune / Flatten ====================

export function prune(t: Type): Type {
  if (t.kind === "TVar" && t.instance) {
    t.instance = prune(t.instance);
    return t.instance;
  }
  return t;
}

/** Flatten a record's row tail chain into consolidated fields + final irreducible tail */
export function flattenRecord(rec: Extract<Type, { kind: "TRecord" }>): {
  fields: Map<string, Type>;
  tail: RowTail;
  meta?: RecordMeta;
} {
  const fields = new Map<string, Type>();
  for (const [k, v] of rec.fields) {
    fields.set(k, prune(v));
  }
  let tail = rec.tail;
  while (tail.kind === "RVar" && (tail.instance || tail.extraFields)) {
    if (tail.extraFields) {
      for (const [k, v] of tail.extraFields) {
        if (!fields.has(k)) fields.set(k, prune(v));
      }
    }
    if (tail.instance) {
      tail = tail.instance;
    } else {
      break;
    }
  }
  return { fields, tail, meta: rec.meta };
}

// ==================== Unification (HM + Row Polymorphism) ====================

export function unify(a: Type, b: Type, span?: Span): void {
  const t1 = prune(a);
  const t2 = prune(b);

  if (t1 === t2) return;

  if (t1.kind === "TVar") {
    if (occursInType(t1.id, t2)) {
      throw new SplError("type", `Infinite recursive type detected: ${formatType(t1)} ~ ${formatType(t2)}`, span);
    }
    if (t2.kind === "TVar") {
      // Merge trait bounds
      const merged = Array.from(new Set([...t1.bounds, ...t2.bounds]));
      t2.bounds = merged;
    }
    t1.instance = t2;
    return;
  }

  if (t2.kind === "TVar") {
    unify(t2, t1, span);
    return;
  }

  if (t1.kind === "TPrim" && t2.kind === "TPrim") {
    if (t1.name === t2.name) return;
    throw new SplError("type", `Type mismatch: expected ${formatType(t1)}, found ${formatType(t2)}`, span);
  }

  if (t1.kind === "TArray" && t2.kind === "TArray") {
    unify(t1.element, t2.element, span);
    return;
  }

  if (t1.kind === "TIter" && t2.kind === "TIter") {
    unify(t1.element, t2.element, span);
    return;
  }

  if (t1.kind === "TDict" && t2.kind === "TDict") {
    unify(t1.key, t2.key, span);
    unify(t1.value, t2.value, span);
    return;
  }

  if (t1.kind === "TTuple" && t2.kind === "TTuple") {
    if (t1.elements.length !== t2.elements.length) {
      throw new SplError("type", `Tuple arity mismatch: expected ${t1.elements.length}, found ${t2.elements.length}`, span);
    }
    for (let i = 0; i < t1.elements.length; i++) {
      unify(t1.elements[i], t2.elements[i], span);
    }
    return;
  }

  if (t1.kind === "TFn" && t2.kind === "TFn") {
    if (t1.params.length !== t2.params.length) {
      throw new SplError("type", `Function arity mismatch: expected ${t1.params.length} args, found ${t2.params.length}`, span);
    }
    for (let i = 0; i < t1.params.length; i++) {
      unify(t1.params[i], t2.params[i], span);
    }
    unify(t1.ret, t2.ret, span);
    return;
  }

  if (t1.kind === "TEnum" && t2.kind === "TEnum") {
    if (t1.name !== t2.name || t1.typeArgs.length !== t2.typeArgs.length) {
      throw new SplError("type", `Enum type mismatch: expected ${formatType(t1)}, found ${formatType(t2)}`, span);
    }
    for (let i = 0; i < t1.typeArgs.length; i++) {
      unify(t1.typeArgs[i], t2.typeArgs[i], span);
    }
    return;
  }

  if (t1.kind === "TNewtype" && t2.kind === "TNewtype") {
    if (
      t1.name !== t2.name ||
      (t1.moduleFile && t2.moduleFile && t1.moduleFile !== t2.moduleFile) ||
      t1.typeArgs.length !== t2.typeArgs.length
    ) {
      throw new SplError("type", `Newtype mismatch: expected ${formatType(t1)}, found ${formatType(t2)}`, span);
    }
    for (let i = 0; i < t1.typeArgs.length; i++) {
      unify(t1.typeArgs[i], t2.typeArgs[i], span);
    }
    unify(t1.underlying, t2.underlying, span);
    return;
  }

  if (t1.kind === "TRecord" && t2.kind === "TRecord") {
    unifyRecords(t1, t2, span);
    return;
  }

  throw new SplError("type", `Type mismatch: cannot unify ${formatType(t1)} with ${formatType(t2)}`, span);
}

function unifyRecords(
  r1: Extract<Type, { kind: "TRecord" }>,
  r2: Extract<Type, { kind: "TRecord" }>,
  span?: Span
): void {
  const f1 = flattenRecord(r1);
  const f2 = flattenRecord(r2);

  const only1 = new Map<string, Type>();
  const only2 = new Map<string, Type>();

  for (const [k, v1] of f1.fields) {
    const v2 = f2.fields.get(k);
    if (v2 !== undefined) {
      unify(v1, v2, span);
    } else {
      only1.set(k, v1);
    }
  }
  for (const [k, v2] of f2.fields) {
    if (!f1.fields.has(k)) {
      only2.set(k, v2);
    }
  }

  const tail1 = f1.tail;
  const tail2 = f2.tail;

  // Both closed: must have exact same fields (structural equivalence!)
  if (tail1.kind === "RClosed" && tail2.kind === "RClosed") {
    if (only1.size > 0 || only2.size > 0) {
      const missing = Array.from(only1.keys()).map((k) => `missing '${k}'`);
      const extra = Array.from(only2.keys()).map((k) => `unexpected '${k}'`);
      throw new SplError(
        "type",
        `Record shape mismatch (${[...missing, ...extra].join(", ")}): ${formatType(r1)} vs ${formatType(r2)}`,
        span
      );
    }
    return;
  }

  // Case: tail1 is RVar, tail2 is RClosed
  if (tail1.kind === "RVar" && tail2.kind === "RClosed") {
    if (only1.size > 0) {
      throw new SplError(
        "type",
        `Record missing required field(s): ${Array.from(only1.keys()).join(", ")}`,
        span
      );
    }
    if (occursInRow(tail1.id, only2)) {
      throw new SplError("type", "Infinite recursive row type", span);
    }
    tail1.extraFields = only2;
    tail1.instance = { kind: "RClosed" };
    return;
  }

  // Case: tail2 is RVar, tail1 is RClosed
  if (tail2.kind === "RVar" && tail1.kind === "RClosed") {
    if (only2.size > 0) {
      throw new SplError(
        "type",
        `Record missing required field(s): ${Array.from(only2.keys()).join(", ")}`,
        span
      );
    }
    if (occursInRow(tail2.id, only1)) {
      throw new SplError("type", "Infinite recursive row type", span);
    }
    tail2.extraFields = only1;
    tail2.instance = { kind: "RClosed" };
    return;
  }

  // Case: both RVar -> share a fresh tail variable!
  if (tail1.kind === "RVar" && tail2.kind === "RVar") {
    if (tail1.id === tail2.id) {
      if (only1.size > 0 || only2.size > 0) {
        throw new SplError("type", `Incompatible fields on same row variable`, span);
      }
      return;
    }
    const shared = freshRVar();
    if (only2.size > 0) tail1.extraFields = only2;
    tail1.instance = shared;
    if (only1.size > 0) tail2.extraFields = only1;
    tail2.instance = shared;
    return;
  }

  // Case: ROpenDict vs ROpenDict
  if (tail1.kind === "ROpenDict" && tail2.kind === "ROpenDict") {
    unify(tail1.valueType, tail2.valueType, span);
    for (const v of only1.values()) {
      if (prune(tail2.valueType).kind !== "TPrim" || (prune(tail2.valueType) as { name: string }).name !== "Json") {
        unify(v, tail2.valueType, span);
      }
    }
    for (const v of only2.values()) {
      if (prune(tail1.valueType).kind !== "TPrim" || (prune(tail1.valueType) as { name: string }).name !== "Json") {
        unify(v, tail1.valueType, span);
      }
    }
    return;
  }

  // Case: RVar vs ROpenDict
  if (tail1.kind === "RVar" && tail2.kind === "ROpenDict") {
    if (only1.size > 0) {
      for (const v of only1.values()) {
        if (!(prune(tail2.valueType).kind === "TPrim" && (prune(tail2.valueType) as { name: string }).name === "Json")) {
          unify(v, tail2.valueType, span);
        }
      }
    }
    tail1.extraFields = only2;
    tail1.instance = tail2;
    return;
  }
  if (tail2.kind === "RVar" && tail1.kind === "ROpenDict") {
    unifyRecords(r2, r1, span);
    return;
  }

  // Case: ROpenDict vs RClosed (a closed record with matching required fields satisfies an open dict record if extra fields fit)
  if (tail1.kind === "ROpenDict" && tail2.kind === "RClosed") {
    if (only1.size > 0) {
      throw new SplError("type", `Record missing required field(s): ${Array.from(only1.keys()).join(", ")}`, span);
    }
    const valT = prune(tail1.valueType);
    if (!(valT.kind === "TPrim" && valT.name === "Json")) {
      for (const v of only2.values()) unify(v, valT, span);
    }
    return;
  }
  if (tail2.kind === "ROpenDict" && tail1.kind === "RClosed") {
    unifyRecords(r2, r1, span);
    return;
  }
}

function occursInType(varId: number, t: Type): boolean {
  const p = prune(t);
  switch (p.kind) {
    case "TVar":
      return p.id === varId;
    case "TPrim":
      return false;
    case "TArray":
    case "TIter":
      return occursInType(varId, p.element);
    case "TDict":
      return occursInType(varId, p.key) || occursInType(varId, p.value);
    case "TTuple":
      return p.elements.some((e) => occursInType(varId, e));
    case "TFn":
      return p.params.some((e) => occursInType(varId, e)) || occursInType(varId, p.ret);
    case "TEnum":
      return p.typeArgs.some((e) => occursInType(varId, e));
    case "TNewtype":
      return p.typeArgs.some((e) => occursInType(varId, e)) || occursInType(varId, p.underlying);
    case "TRecord": {
      const f = flattenRecord(p);
      for (const v of f.fields.values()) {
        if (occursInType(varId, v)) return true;
      }
      if (f.tail.kind === "ROpenDict") return occursInType(varId, f.tail.valueType);
      return false;
    }
  }
}

function occursInRow(rowId: number, fields: Map<string, Type>): boolean {
  for (const t of fields.values()) {
    if (occursRowInType(rowId, t)) return true;
  }
  return false;
}

function occursRowInType(rowId: number, t: Type): boolean {
  const p = prune(t);
  switch (p.kind) {
    case "TRecord": {
      const f = flattenRecord(p);
      if (f.tail.kind === "RVar" && f.tail.id === rowId) return true;
      for (const v of f.fields.values()) if (occursRowInType(rowId, v)) return true;
      return false;
    }
    case "TArray":
    case "TIter":
      return occursRowInType(rowId, p.element);
    case "TDict":
      return occursRowInType(rowId, p.key) || occursRowInType(rowId, p.value);
    case "TTuple":
      return p.elements.some((e) => occursRowInType(rowId, e));
    case "TFn":
      return p.params.some((e) => occursRowInType(rowId, e)) || occursRowInType(rowId, p.ret);
    case "TEnum":
      return p.typeArgs.some((e) => occursRowInType(rowId, e));
    case "TNewtype":
      return p.typeArgs.some((e) => occursRowInType(rowId, e)) || occursRowInType(rowId, p.underlying);
    default:
      return false;
  }
}

// ==================== Generalization & Instantiation ====================

export function collectFreeVars(
  t: Type,
  tVars = new Set<number>(),
  rVars = new Set<number>()
): { tVars: Set<number>; rVars: Set<number> } {
  const p = prune(t);
  switch (p.kind) {
    case "TVar":
      tVars.add(p.id);
      break;
    case "TPrim":
      break;
    case "TArray":
    case "TIter":
      collectFreeVars(p.element, tVars, rVars);
      break;
    case "TDict":
      collectFreeVars(p.key, tVars, rVars);
      collectFreeVars(p.value, tVars, rVars);
      break;
    case "TTuple":
      p.elements.forEach((e) => collectFreeVars(e, tVars, rVars));
      break;
    case "TFn":
      p.params.forEach((e) => collectFreeVars(e, tVars, rVars));
      collectFreeVars(p.ret, tVars, rVars);
      break;
    case "TEnum":
      p.typeArgs.forEach((e) => collectFreeVars(e, tVars, rVars));
      break;
    case "TNewtype":
      p.typeArgs.forEach((e) => collectFreeVars(e, tVars, rVars));
      collectFreeVars(p.underlying, tVars, rVars);
      break;
    case "TRecord": {
      const f = flattenRecord(p);
      for (const v of f.fields.values()) collectFreeVars(v, tVars, rVars);
      if (f.tail.kind === "RVar") rVars.add(f.tail.id);
      else if (f.tail.kind === "ROpenDict") collectFreeVars(f.tail.valueType, tVars, rVars);
      break;
    }
  }
  return { tVars, rVars };
}

export function instantiate(scheme: TypeScheme): Type {
  return instantiateWithArgs(scheme).type;
}

export function instantiateWithArgs(
  scheme: TypeScheme,
  explicitArgs?: Type[],
  span?: Span
): { type: Type; instantiatedParams: Type[]; instantiatedReifiedParams: Type[]; tMap: Map<number, Type> } {
  const tMap = new Map<number, Type>();
  const rMap = new Map<number, RowTail>();
  for (const id of scheme.quantifiedTypeVars) {
    tMap.set(id, freshTVar());
  }
  for (const id of scheme.quantifiedRowVars) {
    rMap.set(id, freshRVar());
  }
  const paramIds = scheme.explicitTypeParams ?? scheme.quantifiedTypeVars;
  const instantiatedParams = paramIds.map((id) => tMap.get(id) ?? freshTVar());
  const reifiedIds = scheme.reifiedTypeParams ?? paramIds;
  const instantiatedReifiedParams = reifiedIds.map((id) => tMap.get(id) ?? freshTVar());
  if (explicitArgs && explicitArgs.length > 0) {
    if (explicitArgs.length !== instantiatedParams.length) {
      throw new SplError(
        "type",
        `Expected ${instantiatedParams.length} type argument(s), got ${explicitArgs.length}`,
        span
      );
    }
    for (let i = 0; i < explicitArgs.length; i++) {
      unify(instantiatedParams[i], explicitArgs[i], span);
    }
  }
  return { type: cloneWithSubst(scheme.type, tMap, rMap), instantiatedParams, instantiatedReifiedParams, tMap };
}

export function cloneWithSubst(t: Type, tMap: Map<number, Type>, rMap: Map<number, RowTail>): Type {
  const p = prune(t);
  switch (p.kind) {
    case "TPrim":
      return p;
    case "TVar": {
      const mapped = tMap.get(p.id);
      if (mapped) {
        if (mapped.kind === "TVar" && p.bounds.length > 0) {
          mapped.bounds = Array.from(new Set([...mapped.bounds, ...p.bounds]));
        }
        return mapped;
      }
      return p;
    }
    case "TArray":
      return tArray(cloneWithSubst(p.element, tMap, rMap));
    case "TIter":
      return tIter(cloneWithSubst(p.element, tMap, rMap));
    case "TDict":
      return tDict(cloneWithSubst(p.key, tMap, rMap), cloneWithSubst(p.value, tMap, rMap));
    case "TTuple":
      return tTuple(p.elements.map((e) => cloneWithSubst(e, tMap, rMap)));
    case "TFn":
      return {
        kind: "TFn",
        params: p.params.map((e) => cloneWithSubst(e, tMap, rMap)),
        paramNames: p.paramNames,
        requiredCount: p.requiredCount,
        ret: cloneWithSubst(p.ret, tMap, rMap),
        isAsync: p.isAsync,
      };
    case "TEnum": {
      const newArgs = p.typeArgs.map((a) => cloneWithSubst(a, tMap, rMap));
      const newVariants = new Map<string, EnumVariantType>();
      for (const [k, v] of p.variants) {
        newVariants.set(k, {
          fields: v.fields.map((f) => cloneWithSubst(f, tMap, rMap)),
          doc: v.doc,
          llmHint: v.llmHint,
        });
      }
      return { kind: "TEnum", name: p.name, typeArgs: newArgs, variants: newVariants, doc: p.doc, llmHint: p.llmHint };
    }
    case "TNewtype":
      return {
        kind: "TNewtype",
        name: p.name,
        moduleFile: p.moduleFile,
        typeArgs: p.typeArgs.map((a) => cloneWithSubst(a, tMap, rMap)),
        underlying: cloneWithSubst(p.underlying, tMap, rMap),
        doc: p.doc,
        llmHint: p.llmHint,
      };
    case "TRecord": {
      const flat = flattenRecord(p);
      const newFields = new Map<string, Type>();
      for (const [k, v] of flat.fields) {
        newFields.set(k, cloneWithSubst(v, tMap, rMap));
      }
      let newTail: RowTail;
      if (flat.tail.kind === "RClosed") {
        newTail = { kind: "RClosed" };
      } else if (flat.tail.kind === "RVar") {
        newTail = rMap.get(flat.tail.id) ?? flat.tail;
      } else {
        newTail = {
          kind: "ROpenDict",
          valueType: cloneWithSubst(flat.tail.valueType, tMap, rMap),
          extraName: flat.tail.extraName,
          doc: flat.tail.doc,
          llmHint: flat.tail.llmHint,
        };
      }
      return { kind: "TRecord", fields: newFields, tail: newTail, meta: flat.meta };
    }
  }
}

// ==================== Canonical Shape Key (for Trait Coherence) ====================

export function canonicalShapeKey(t: Type): string {
  const p = prune(t);
  switch (p.kind) {
    case "TPrim":
      return p.name;
    case "TVar":
      return `?_`;
    case "TArray":
      return `Array<${canonicalShapeKey(p.element)}>`;
    case "TIter":
      return `Iter<${canonicalShapeKey(p.element)}>`;
    case "TDict":
      return `Dict<${canonicalShapeKey(p.key)},${canonicalShapeKey(p.value)}>`;
    case "TTuple":
      return `(${p.elements.map(canonicalShapeKey).join(",")})`;
    case "TFn":
      return `fn(${p.params.map(canonicalShapeKey).join(",")})->${canonicalShapeKey(p.ret)}`;
    case "TEnum":
      return p.typeArgs.length > 0
        ? `${p.name}<${p.typeArgs.map(canonicalShapeKey).join(",")}>`
        : p.name;
    case "TNewtype": {
      const modPrefix = p.moduleFile ? `${p.moduleFile}::` : "";
      const args = p.typeArgs.length > 0 ? `<${p.typeArgs.map(canonicalShapeKey).join(",")}>` : "";
      return `newtype:${modPrefix}${p.name}${args}`;
    }
    case "TRecord": {
      const f = flattenRecord(p);
      const keys = Array.from(f.fields.keys()).sort();
      const parts = keys.map((k) => `${k}:${canonicalShapeKey(f.fields.get(k)!)}`);
      if (f.tail.kind === "ROpenDict") {
        parts.push(`..Dict<Str,${canonicalShapeKey(f.tail.valueType)}>`);
      } else if (f.tail.kind === "RVar") {
        parts.push("..");
      }
      return `{${parts.join(",")}}`;
    }
  }
}

// ==================== Formatting ====================

export function formatType(t: Type): string {
  const p = prune(t);
  switch (p.kind) {
    case "TPrim":
      return p.name;
    case "TVar":
      return p.name ? `${p.name}` : `t${p.id}`;
    case "TArray":
      return `Array<${formatType(p.element)}>`;
    case "TIter":
      return `Iter<${formatType(p.element)}>`;
    case "TDict":
      return `Dict<${formatType(p.key)}, ${formatType(p.value)}>`;
    case "TTuple":
      return `(${p.elements.map(formatType).join(", ")})`;
    case "TFn":
      return `fn(${p.params.map(formatType).join(", ")}) -> ${formatType(p.ret)}`;
    case "TEnum":
      if (p.name === "Option" && p.typeArgs.length === 1) {
        return `${formatType(p.typeArgs[0])}?`;
      }
      return p.typeArgs.length > 0
        ? `${p.name}<${p.typeArgs.map(formatType).join(", ")}>`
        : p.name;
    case "TNewtype":
      return p.typeArgs.length > 0
        ? `${p.name}<${p.typeArgs.map(formatType).join(", ")}>`
        : p.name;
    case "TRecord": {
      const f = flattenRecord(p);
      const entries = Array.from(f.fields.entries()).map(([k, v]) => `${k}: ${formatType(v)}`);
      if (f.tail.kind === "RVar") entries.push(`..r${f.tail.id}`);
      else if (f.tail.kind === "ROpenDict") {
        entries.push(`..${f.tail.extraName ?? "extra"}: Dict<Str, ${formatType(f.tail.valueType)}>`);
      }
      return `{ ${entries.join(", ")} }`;
    }
  }
}
