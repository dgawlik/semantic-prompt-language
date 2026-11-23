import { SplError, type Span } from "./errors.js";
import type {
  Program, TopItem, TypeDecl, NewtypeDecl, EnumDecl, TraitDecl, ImplDecl,
  FnDecl, ExternFnDecl, TypeExpr, Stmt, ForStmt, Expr, AsExpr, Pattern, BlockExpr, CallArg,
} from "./ast.js";
import {
  type Type, type TypeScheme, type RowTail, type EnumVariantType,
  TInt, TFloat, TStr, TBool, TChar, TByte, TBytes, TJson, TPrompt, TUnit,
  tArray, tIter, tDict, tTuple, tOption, tResult,
  freshTVar, freshRVar, prune, flattenRecord, unify,
  collectFreeVars, instantiate, instantiateWithArgs, cloneWithSubst, canonicalShapeKey, formatType,
} from "./types.js";
import { generateJsonSchema, generateDecodeCodec, type JsonSchema, type DecodeCodec } from "./schema.js";

// ==================== Public Types ====================

export interface ExtensionMethodInfo {
  name: string;
  receiverType: Type;
  fnType: Type;
  scheme?: TypeScheme;
  defaults?: (Expr | undefined)[];
  isReified?: boolean;
  jsSymbol: string;
  moduleFile: string;
  isAsync: boolean;
  mutSelf?: boolean;
  doc?: string;
  span?: Span;
}

export interface TraitImplInfo {
  traitName: string;
  shapeKey: string;
  targetType: Type;
  methods: Map<string, { fnType: Type; jsSymbol: string; isAsync: boolean; mutSelf?: boolean }>;
}

export interface SymbolInfo {
  name: string;
  kind: "fn" | "extern" | "type" | "newtype" | "enum" | "variant" | "trait" | "var" | "param" | "extension";
  type?: Type;
  doc?: string;
  llmHint?: string;
  span: Span;
  scopeSpan?: Span; // undefined for module-level symbols
}

export interface ReifiedTypeInfo {
  name: string;
  splType: string;
  schema: JsonSchema;
  codec: DecodeCodec;
}

export interface ModuleExports {
  file: string;
  values: Map<string, TypeScheme>;
  valueSpans: Map<string, Span>;
  valueDocs: Map<string, string>;
  valueDefaults: Map<string, (Expr | undefined)[]>;
  asyncValues: Set<string>;
  reifiedValues: Set<string>;
  types: Map<string, TypeDef>;
  newtypes: Map<string, NewtypeDef>;
  enums: Map<string, EnumDef>;
  traits: Map<string, TraitDef>;
  extensions: ExtensionMethodInfo[];
  traitImpls: TraitImplInfo[];
}

export interface TypeDef {
  name: string;
  typeParams: string[];
  body: TypeExpr;
  doc?: string;
  llmHint?: string;
  span?: Span;
}

export interface NewtypeDef {
  name: string;
  moduleFile: string;
  typeParams: string[];
  body: TypeExpr;
  doc?: string;
  llmHint?: string;
  span?: Span;
}

export interface EnumDef {
  name: string;
  typeParams: string[];
  variants: Map<string, { fields: TypeExpr[]; doc?: string; llmHint?: string }>;
  doc?: string;
  llmHint?: string;
  span?: Span;
}

export interface TraitDef {
  name: string;
  methods: Map<string, { paramCount: number }>;
  doc?: string;
  span?: Span;
}

export type ResolvedCallKind =
  | { kind: "Normal"; reorderedArgs?: (Expr | undefined)[]; reifiedTypeVars?: Type[] }
  | { kind: "BuiltinMethod"; target: string; receiver: Expr; isAsync?: boolean }
  | {
      kind: "ExtensionMethod";
      jsSymbol: string;
      receiver: Expr;
      isAsync?: boolean;
      reorderedArgs?: (Expr | undefined)[];
      reifiedTypeVars?: Type[];
    }
  | { kind: "TraitMethod"; jsSymbol: string; receiver: Expr; isAsync?: boolean }
  | { kind: "EnumCtor"; variant: string }
  | { kind: "NamespaceCall"; alias: string; member: string; reorderedArgs?: (Expr | undefined)[]; reifiedTypeVars?: Type[] };

export type ForResolution =
  | { kind: "Array" }
  | { kind: "Dict" }
  | { kind: "Str" }
  | { kind: "Iter" }
  | { kind: "ExtensionIter"; jsSymbol: string; isAsync: boolean }
  | { kind: "TraitIter"; jsSymbol: string; isAsync: boolean };

export type CastKind =
  | "noop"
  | "trunc_int"
  | "to_byte"
  | "char_to_int"
  | "char_to_byte"
  | "int_to_char"
  | "bool_to_int"
  | "int_to_bool"
  | "to_str"
  | "str_to_int"
  | "str_to_float"
  | "str_to_bytes"
  | "bytes_to_str"
  | "to_json"
  | "iter_to_array"
  | "array_to_iter";

export interface CheckedProgram {
  program: Program;
  exports: ModuleExports;
  exprTypes: Map<Expr, Type>;
  callResolutions: Map<Expr, ResolvedCallKind>;
  forResolutions: Map<ForStmt, ForResolution>;
  castResolutions: Map<AsExpr, CastKind>;
  schemaLiterals: Map<Expr, JsonSchema>;
  decodeCodecs: Map<Expr, DecodeCodec>;
  reifiedExprTypes: Map<Expr, Type>;
  newtypePatterns: Set<Pattern>;
  newtypeValueAccess: Set<Expr>;
  reifiedIdentRefs: Map<Expr, Type[]>;
  asyncFns: Set<FnDecl | Expr>;
  asyncCalls: Set<Expr>;
  extensionJsSymbols: Map<FnDecl, string>;
  traitImplJsSymbols: Map<FnDecl, string>;
  fnReifiedParams: Map<FnDecl, Type[]>;
  namedParamDefaults: Map<string, (Expr | undefined)[]>;
  importBindings: Map<string, { moduleSpec: string; exportedName: string }>;
  namespaceImports: Map<string, string>;
  // LSP metadata
  symbols: SymbolInfo[];
  identDefs: Map<Expr, { span: Span; doc?: string; kind: string }>;
  namespaces: Map<string, ModuleExports>;
  extensions: ExtensionMethodInfo[];
  traitImpls: TraitImplInfo[];
}

export type ModuleResolver = (specifier: string, fromFile: string) => ModuleExports;

// ==================== Built-in Reified TypeInfo Types ====================

const TTypeFieldInfo: Type = {
  kind: "TRecord",
  fields: new Map<string, Type>([
    ["name", TStr],
    ["type_name", TStr],
    ["optional", TBool],
    ["doc", tOption(TStr)],
    ["hint", tOption(TStr)],
  ]),
  tail: { kind: "RClosed" },
  meta: {
    typeName: "TypeFieldInfo",
    doc: "Metadata for a single record/struct field returned inside `TypeInfo.fields`.",
    fieldDocs: new Map([
      ["name", "Field name."],
      ["type_name", "Formatted SPL type of the field."],
      ["optional", "Whether the field type is optional (`T?`)."],
      ["doc", "Developer doc-comment (`///`) attached to the field, if any."],
      ["hint", "LLM schema hint (`''`) attached to the field, if any."],
    ]),
    fieldHints: new Map(),
  },
};

const TTypeVariantInfo: Type = {
  kind: "TRecord",
  fields: new Map<string, Type>([
    ["name", TStr],
    ["fields", tArray(TStr)],
    ["doc", tOption(TStr)],
    ["hint", tOption(TStr)],
  ]),
  tail: { kind: "RClosed" },
  meta: {
    typeName: "TypeVariantInfo",
    doc: "Metadata for a single enum variant returned inside `TypeInfo.variants`.",
    fieldDocs: new Map([
      ["name", "Variant name."],
      ["fields", "Formatted SPL types of the variant's payload fields."],
      ["doc", "Developer doc-comment (`///`) attached to the variant, if any."],
      ["hint", "LLM schema hint (`''`) attached to the variant, if any."],
    ]),
    fieldHints: new Map(),
  },
};

const TTypeInfo: Type = {
  kind: "TRecord",
  fields: new Map<string, Type>([
    ["name", TStr],
    ["kind", TStr],
    ["spl_type", TStr],
    ["schema", TJson],
    ["doc", tOption(TStr)],
    ["hint", tOption(TStr)],
    ["underlying", tOption(TStr)],
    ["type_args", tArray(TStr)],
    ["fields", tArray(TTypeFieldInfo)],
    ["variants", tArray(TTypeVariantInfo)],
    ["params", tArray(TStr)],
    ["return_type", tOption(TStr)],
  ]),
  tail: { kind: "RClosed" },
  meta: {
    typeName: "TypeInfo",
    doc: "First-class reified runtime type descriptor returned by `typeof(expr)` and `typeof<T>()`.",
    fieldDocs: new Map([
      ["name", "Type display name (e.g. `Int`, `UserId`, `Person`, `Array<Int>`)."],
      ["kind", "Type category: `primitive`, `record`, `enum`, `newtype`, `array`, `iter`, `dict`, `tuple`, `fn`, `option`, `result`, or `var`."],
      ["spl_type", "Full formatted SPL type signature."],
      ["schema", "Compile-time / reified JSON Schema (`Json`) for this type."],
      ["doc", "Developer doc-comment (`///`) on the type declaration, if any."],
      ["hint", "LLM schema hint (`''`) on the type declaration, if any."],
      ["underlying", "For `newtype`, the underlying SPL type string (`Some(...)`); otherwise `None`."],
      ["type_args", "Formatted type argument names for generic/container types."],
      ["fields", "Field descriptors for records/structs (and struct-backed newtypes)."],
      ["variants", "Variant descriptors for enums."],
      ["params", "Formatted parameter type names for function types."],
      ["return_type", "Formatted return type for function types (`Some(...)`); otherwise `None`."],
    ]),
    fieldHints: new Map(),
  },
};

// ==================== Checker Implementation ====================

interface VarBinding {
  scheme: TypeScheme;
  mutable: boolean;
  isAsyncFn?: boolean;
  isReified?: boolean;
  fnDecl?: FnDecl;
  paramNames?: string[];
  defaults?: (Expr | undefined)[];
  defSpan?: Span;
  doc?: string;
  symKind?: string;
}

interface Scope {
  vars: Map<string, VarBinding>;
  parent?: Scope;
}

export function checkProgram(program: Program, resolveModule?: ModuleResolver): CheckedProgram {
  const checker = new TypeChecker(program, resolveModule);
  return checker.check();
}

class TypeChecker {
  private rootScope: Scope = { vars: new Map() };
  private currentScope: Scope = this.rootScope;
  private types = new Map<string, TypeDef>();
  private newtypes = new Map<string, NewtypeDef>();
  private enums = new Map<string, EnumDef>();
  private traits = new Map<string, TraitDef>();
  private variantToEnum = new Map<string, string>();
  private extensions: ExtensionMethodInfo[] = [];
  private traitImpls: TraitImplInfo[] = [];
  private traitImplKeys = new Set<string>(); // `${traitName}::${shapeKey}` for coherence

  private namespaces = new Map<string, ModuleExports>();
  private namespaceImports = new Map<string, string>();
  private importBindings = new Map<string, { moduleSpec: string; exportedName: string }>();

  private exprTypes = new Map<Expr, Type>();
  private callResolutions = new Map<Expr, ResolvedCallKind>();
  private forResolutions = new Map<ForStmt, ForResolution>();
  private castResolutions = new Map<AsExpr, CastKind>();
  private schemaLiterals = new Map<Expr, JsonSchema>();
  private decodeCodecs = new Map<Expr, DecodeCodec>();
  private reifiedExprTypes = new Map<Expr, Type>();
  private newtypePatterns = new Set<Pattern>();
  private newtypeValueAccess = new Set<Expr>();
  private reifiedIdentRefs = new Map<Expr, Type[]>();
  private asyncFns = new Set<FnDecl | Expr>();
  private asyncCalls = new Set<Expr>();
  private extensionJsSymbols = new Map<FnDecl, string>();
  private traitImplJsSymbols = new Map<FnDecl, string>();
  private fnReifiedParams = new Map<FnDecl, Type[]>();
  private fnExplicitTypeParams = new Map<FnDecl, Type[]>();
  private fnTypeParamMaps = new Map<FnDecl, Map<string, Type>>();
  private fnBindings = new Map<FnDecl, VarBinding>();
  private extFnDecls = new Map<string, FnDecl>();
  private fnDirectReifiedTypes = new Map<FnDecl, Type[]>();
  private reifiedCallSites: Array<{
    callerFn?: FnDecl;
    expr: Expr;
    kind: "Direct" | "Namespace" | "Extension" | "IdentRef";
    targetFn?: FnDecl;
    targetExt?: ExtensionMethodInfo;
    fixedReifiedTypes?: Type[];
    instantiationMap?: Map<number, Type>;
  }> = [];
  private topLevelLets = new Map<string, Extract<TopItem, { kind: "LetStmt" }>>();
  private checkedTopLets = new Set<TopItem>();
  private activeTypeParams = new Map<string, Type>();
  private activeReifiedParams: Type[] = [];
  private namedParamDefaults = new Map<string, (Expr | undefined)[]>();
  private symbols: SymbolInfo[] = [];
  private identDefs = new Map<Expr, { span: Span; doc?: string; kind: string }>();

  private currentFnRetType?: Type;
  private currentFnNode?: FnDecl | Expr;
  private currentEnclosingFnDecl?: FnDecl;
  private currentFnBecameAsync = false;

  // Call graph edges for fixed-point colorless async inference
  private fnDeclsByName = new Map<string, FnDecl>();
  private asyncFnNames = new Set<string>();
  private callEdges = new Map<FnDecl | Expr, Set<string>>();
  private callSites = new Map<Expr, { caller?: FnDecl | Expr; calleeName?: string; calleeExpr?: Expr; hofArgExprs: Expr[] }>();
  private implDeclToInfo = new Map<ImplDecl, TraitImplInfo>();
  private extCounter = 0;
  private moduleTag: string;

  constructor(
    private readonly program: Program,
    private readonly resolveModule?: ModuleResolver
  ) {
    // Stable sanitized module tag so __ext_ and __impl_ symbols never collide across files
    const base = program.file.replace(/\\/g, "/").split("/").pop() ?? "mod";
    let hash = 0;
    for (let i = 0; i < program.file.length; i++) {
      hash = ((hash << 5) - hash + program.file.charCodeAt(i)) | 0;
    }
    this.moduleTag = `${base.replace(/[^A-Za-z0-9]/g, "_")}_${(hash >>> 0).toString(36)}`;
    this.installBuiltins();
  }

  private installBuiltins(): void {
    // Built-in enums: Option<T>, Result<T, E>
    this.enums.set("Option", {
      name: "Option",
      typeParams: ["T"],
      variants: new Map([
        ["Some", { fields: [{ kind: "NamedTypeExpr", name: "T", typeArgs: [], span: { file: "<builtin>", line: 1, col: 1 } }] }],
        ["None", { fields: [] }],
      ]),
    });
    this.variantToEnum.set("Some", "Option");
    this.variantToEnum.set("None", "Option");

    this.enums.set("Result", {
      name: "Result",
      typeParams: ["T", "E"],
      variants: new Map([
        ["Ok", { fields: [{ kind: "NamedTypeExpr", name: "T", typeArgs: [], span: { file: "<builtin>", line: 1, col: 1 } }] }],
        ["Err", { fields: [{ kind: "NamedTypeExpr", name: "E", typeArgs: [], span: { file: "<builtin>", line: 1, col: 1 } }] }],
      ]),
    });
    this.variantToEnum.set("Ok", "Result");
    this.variantToEnum.set("Err", "Result");

    // Built-in traits
    for (const [name, methodName, paramCount] of [
      ["Show", "show", 1],
      ["Eq", "eq", 2],
      ["Ord", "cmp", 2],
      ["Add", "add", 2],
    ] as const) {
      this.traits.set(name, { name, methods: new Map([[methodName, { paramCount }]]) });
    }

    // Built-in constructors: Some, None, Ok, Err
    const tv1 = freshTVar();
    this.defineBuiltin("Some", this.generalize({ kind: "TFn", params: [tv1], ret: tOption(tv1) }, this.rootScope));
    const tv2 = freshTVar();
    this.defineBuiltin("None", this.generalize(tOption(tv2), this.rootScope));

    const okT = freshTVar();
    const okE = freshTVar();
    this.defineBuiltin("Ok", this.generalize({ kind: "TFn", params: [okT], ret: tResult(okT, okE) }, this.rootScope));
    const errT = freshTVar();
    const errE = freshTVar();
    this.defineBuiltin("Err", this.generalize({ kind: "TFn", params: [errE], ret: tResult(errT, errE) }, this.rootScope));

    // Core compiler builtins
    const anyT = freshTVar();
    this.defineBuiltin("panic", this.generalize({ kind: "TFn", params: [TStr], ret: anyT }, this.rootScope));
    const showT = freshTVar();
    this.defineBuiltin("to_str", this.generalize({ kind: "TFn", params: [showT], ret: TStr }, this.rootScope));
    this.defineBuiltin("print", this.generalize({ kind: "TFn", params: [freshTVar()], ret: TUnit }, this.rootScope));
    this.defineBuiltin("print_inline", this.generalize({ kind: "TFn", params: [freshTVar()], ret: TUnit }, this.rootScope));

    // JSON builtins
    this.defineBuiltin("json_parse", this.generalize({ kind: "TFn", params: [TStr], ret: tResult(TJson, TStr) }, this.rootScope));
    const jsT = freshTVar();
    this.defineBuiltin("json_stringify", this.generalize({ kind: "TFn", params: [jsT], ret: TStr }, this.rootScope));
    const toJsonT = freshTVar();
    this.defineBuiltin("to_json", this.generalize({ kind: "TFn", params: [toJsonT], ret: TJson }, this.rootScope));

    // Math builtins
    this.defineBuiltin("floor", this.generalize({ kind: "TFn", params: [TFloat], ret: TInt }, this.rootScope));
    this.defineBuiltin("ceil", this.generalize({ kind: "TFn", params: [TFloat], ret: TInt }, this.rootScope));
    this.defineBuiltin("round", this.generalize({ kind: "TFn", params: [TFloat], ret: TInt }, this.rootScope));
    this.defineBuiltin("sqrt", this.generalize({ kind: "TFn", params: [TFloat], ret: TFloat }, this.rootScope));
    this.defineBuiltin("abs", this.generalize({ kind: "TFn", params: [TFloat], ret: TFloat }, this.rootScope));
    this.defineBuiltin("abs_int", this.generalize({ kind: "TFn", params: [TInt], ret: TInt }, this.rootScope));
    this.defineBuiltin("log", this.generalize({ kind: "TFn", params: [TFloat], ret: TFloat }, this.rootScope));
    this.defineBuiltin("exp", this.generalize({ kind: "TFn", params: [TFloat], ret: TFloat }, this.rootScope));
    this.defineBuiltin("is_finite", this.generalize({ kind: "TFn", params: [TFloat], ret: TBool }, this.rootScope));
    this.defineBuiltin("int_to_float", this.generalize({ kind: "TFn", params: [TInt], ret: TFloat }, this.rootScope));
    this.defineBuiltin("float_to_int", this.generalize({ kind: "TFn", params: [TFloat], ret: TInt }, this.rootScope));

    // Array & Dict primitives
    const fA = freshTVar();
    const fB = freshTVar();
    this.defineBuiltin(
      "array_fold",
      this.generalize(
        { kind: "TFn", params: [tArray(fA), fB, { kind: "TFn", params: [fB, fA], ret: fB }], ret: fB },
        this.rootScope
      )
    );
    const fnEl = freshTVar();
    this.defineBuiltin(
      "array_from_fn",
      this.generalize(
        { kind: "TFn", params: [TInt, { kind: "TFn", params: [TInt], ret: fnEl }], ret: tArray(fnEl) },
        this.rootScope
      )
    );
    const dk = freshTVar();
    const dv = freshTVar();
    this.defineBuiltin("dict_empty", this.generalize({ kind: "TFn", params: [], ret: tDict(dk, dv) }, this.rootScope));

    const iterEl = freshTVar();
    this.defineBuiltin(
      "iter_from_fn",
      this.generalize({ kind: "TFn", params: [{ kind: "TFn", params: [], ret: tOption(iterEl) }], ret: tIter(iterEl) }, this.rootScope)
    );

    // Regex builtins
    this.defineBuiltin("regex_test", this.generalize({ kind: "TFn", params: [TStr, TStr], ret: TBool }, this.rootScope));
    this.defineBuiltin("regex_match", this.generalize({ kind: "TFn", params: [TStr, TStr], ret: tOption(tArray(TStr)) }, this.rootScope));
    this.defineBuiltin("regex_replace", this.generalize({ kind: "TFn", params: [TStr, TStr, TStr], ret: TStr }, this.rootScope));

    // Async combinators
    const allT = freshTVar();
    this.defineBuiltin(
      "async_all",
      this.generalize({ kind: "TFn", params: [tArray({ kind: "TFn", params: [], ret: allT })], ret: tArray(allT), isAsync: true }, this.rootScope),
      true
    );
    const raceT = freshTVar();
    this.defineBuiltin(
      "async_race",
      this.generalize({ kind: "TFn", params: [tArray({ kind: "TFn", params: [], ret: raceT })], ret: raceT, isAsync: true }, this.rootScope),
      true
    );

    // Bytes primitives
    this.defineBuiltin("bytes_from_utf8", this.generalize({ kind: "TFn", params: [TStr], ret: TBytes }, this.rootScope));
    this.defineBuiltin("bytes_to_utf8", this.generalize({ kind: "TFn", params: [TBytes], ret: TStr }, this.rootScope));
    this.defineBuiltin("bytes_len", this.generalize({ kind: "TFn", params: [TBytes], ret: TInt }, this.rootScope));
  }

  private defineBuiltin(name: string, scheme: TypeScheme, isAsyncFn = false): void {
    this.rootScope.vars.set(name, { scheme, mutable: false, isAsyncFn });
    if (isAsyncFn) this.asyncFnNames.add(name);
  }

  // ==================== Top-Level Checking ====================

  check(): CheckedProgram {
    // Pass 1: Process imports, types, newtypes, enums, traits
    for (const item of this.program.items) {
      if (item.kind === "ImportDecl") {
        this.processImport(item);
      } else if (item.kind === "TypeDecl") {
        this.types.set(item.name, {
          name: item.name,
          typeParams: item.typeParams.map((p) => p.name),
          body: item.body,
          doc: item.doc,
          llmHint: item.llmHint,
          span: item.span,
        });
        this.symbols.push({ name: item.name, kind: "type", doc: item.doc, llmHint: item.llmHint, span: item.span });
      } else if (item.kind === "NewtypeDecl") {
        this.newtypes.set(item.name, {
          name: item.name,
          moduleFile: this.program.file,
          typeParams: item.typeParams.map((p) => p.name),
          body: item.body,
          doc: item.doc,
          llmHint: item.llmHint,
          span: item.span,
        });
        this.symbols.push({ name: item.name, kind: "newtype", doc: item.doc, llmHint: item.llmHint, span: item.span });
      } else if (item.kind === "EnumDecl") {
        const variants = new Map<string, { fields: TypeExpr[]; doc?: string; llmHint?: string }>();
        for (const v of item.variants) {
          variants.set(v.name, { fields: v.fields, doc: v.doc, llmHint: v.llmHint });
          this.variantToEnum.set(v.name, item.name);
        }
        this.enums.set(item.name, {
          name: item.name,
          typeParams: item.typeParams.map((p) => p.name),
          variants,
          doc: item.doc,
          llmHint: item.llmHint,
          span: item.span,
        });
        this.symbols.push({ name: item.name, kind: "enum", doc: item.doc, llmHint: item.llmHint, span: item.span });
      } else if (item.kind === "TraitDecl") {
        const methods = new Map<string, { paramCount: number }>();
        for (const m of item.methods) methods.set(m.name, { paramCount: m.params.length });
        this.traits.set(item.name, { name: item.name, methods, doc: item.doc, span: item.span });
        this.symbols.push({ name: item.name, kind: "trait", doc: item.doc, span: item.span });
      } else if (item.kind === "LetStmt" && item.pattern.kind === "IdentPattern") {
        this.topLevelLets.set(item.pattern.name, item);
      }
    }

    // Register enum & newtype constructors in root scope
    for (const item of this.program.items) {
      if (item.kind === "EnumDecl") {
        this.registerEnumConstructors(item);
      } else if (item.kind === "NewtypeDecl") {
        this.registerNewtypeConstructor(item, this.rootScope);
      }
    }

    // Pass 2: Pre-declare externs, functions, extension methods, and impls (for mutual recursion)
    for (const item of this.program.items) {
      if (item.kind === "ExternFnDecl") {
        if (!this.program.isStdlib) {
          throw new SplError(
            "type",
            "`extern` JS FFI declarations are restricted to the standard library",
            item.span
          );
        }
        const tpMap = new Map<string, Type>();
        const explicitIds: number[] = [];
        for (const tp of item.typeParams) {
          const tv = freshTVar(tp.bounds, tp.name);
          tpMap.set(tp.name, tv);
          if (tv.kind === "TVar") explicitIds.push(tv.id);
        }
        const params = item.params.map((p) => (p.type ? this.resolveTypeExpr(p.type, tpMap) : freshTVar()));
        const ret = this.resolveTypeExpr(item.returnType, tpMap);
        const fnType: Type = {
          kind: "TFn",
          params,
          paramNames: item.params.map((p) => p.name),
          requiredCount: item.params.filter((p) => !p.defaultValue).length,
          ret,
          isAsync: item.isAsync,
        };
        const scheme = this.generalize(fnType, this.rootScope);
        if (explicitIds.length > 0) {
          scheme.explicitTypeParams = explicitIds;
          for (const id of explicitIds) {
            if (!scheme.quantifiedTypeVars.includes(id)) {
              scheme.quantifiedTypeVars.push(id);
            }
          }
        }
        this.rootScope.vars.set(item.name, {
          scheme,
          mutable: false,
          isAsyncFn: item.isAsync,
          isReified: Boolean(item.reified),
          paramNames: item.params.map((p) => p.name),
          defaults: item.params.map((p) => p.defaultValue),
          defSpan: item.span,
          doc: item.doc,
          symKind: "extern",
        });
        this.symbols.push({ name: item.name, kind: "extern", type: fnType, doc: item.doc, span: item.span });
        if (item.isAsync) this.asyncFnNames.add(item.name);
        this.namedParamDefaults.set(item.name, item.params.map((p) => p.defaultValue));
      } else if (item.kind === "FnDecl") {
        this.predeclareFn(item, this.rootScope);
      } else if (item.kind === "ImplDecl") {
        this.predeclareImpl(item);
      }
    }

    // Pass 3: Type-check bodies and top-level statements
    for (const item of this.program.items) {
      if (item.kind === "FnDecl") {
        this.checkFnDecl(item, this.rootScope);
      } else if (item.kind === "ImplDecl") {
        this.checkImplDecl(item);
      } else if (item.kind === "LetStmt") {
        if (!this.checkedTopLets.has(item)) {
          this.checkedTopLets.add(item);
          this.checkLetStmt(item, this.rootScope);
        }
      } else if (
        item.kind === "WhileStmt" ||
        item.kind === "ForStmt" ||
        item.kind === "AssignStmt" ||
        item.kind === "FieldAssignStmt" ||
        item.kind === "IndexAssignStmt"
      ) {
        this.checkStmt(item, this.rootScope);
      } else if (item.kind === "ExprStmt") {
        this.checkExpr(item.expr, this.rootScope);
      }
    }

    // Pass 4: Fixed-point colorless async propagation across call graph & higher-order calls
    this.propagateAsync();

    // Pass 4b: Fixed-point universal reification propagation across all generic functions
    this.propagateReification();

    // Collect exports
    const exports: ModuleExports = {
      file: this.program.file,
      values: new Map(),
      valueSpans: new Map(),
      valueDocs: new Map(),
      valueDefaults: new Map(),
      asyncValues: new Set(),
      reifiedValues: new Set(),
      types: new Map(),
      newtypes: new Map(),
      enums: new Map(),
      traits: new Map(),
      extensions: [],
      traitImpls: [],
    };

    for (const item of this.program.items) {
      if (item.kind === "FnDecl" && item.pub) {
        if (item.receiverType) {
          const ext = this.extensions.find((e) => e.jsSymbol === this.extensionJsSymbols.get(item));
          if (ext) {
            ext.isAsync = this.asyncFns.has(item);
            exports.extensions.push(ext);
          }
        } else {
          const b = this.rootScope.vars.get(item.name);
          if (b) {
            exports.values.set(item.name, b.scheme);
            exports.valueSpans.set(item.name, item.span);
            if (b.defaults) exports.valueDefaults.set(item.name, b.defaults);
            if (item.doc) exports.valueDocs.set(item.name, item.doc);
            if (this.asyncFns.has(item)) exports.asyncValues.add(item.name);
            if (item.reified || b.isReified || this.fnReifiedParams.has(item)) exports.reifiedValues.add(item.name);
          }
        }
      } else if (item.kind === "ExternFnDecl" && item.pub) {
        const b = this.rootScope.vars.get(item.name);
        if (b) {
          exports.values.set(item.name, b.scheme);
          exports.valueSpans.set(item.name, item.span);
          if (b.defaults) exports.valueDefaults.set(item.name, b.defaults);
          if (item.doc) exports.valueDocs.set(item.name, item.doc);
          if (item.isAsync) exports.asyncValues.add(item.name);
          if (item.reified) exports.reifiedValues.add(item.name);
        }
      } else if (item.kind === "LetStmt" && item.pub && item.pattern.kind === "IdentPattern") {
        const b = this.rootScope.vars.get(item.pattern.name);
        if (b) {
          exports.values.set(item.pattern.name, b.scheme);
          exports.valueSpans.set(item.pattern.name, item.span);
        }
      } else if (item.kind === "TypeDecl" && item.pub) {
        exports.types.set(item.name, this.types.get(item.name)!);
      } else if (item.kind === "NewtypeDecl" && item.pub) {
        exports.newtypes.set(item.name, this.newtypes.get(item.name)!);
        const b = this.rootScope.vars.get(item.name);
        if (b) {
          exports.values.set(item.name, b.scheme);
          exports.valueSpans.set(item.name, item.span);
          if (item.doc) exports.valueDocs.set(item.name, item.doc);
        }
      } else if (item.kind === "EnumDecl" && item.pub) {
        exports.enums.set(item.name, this.enums.get(item.name)!);
        for (const v of item.variants) {
          const b = this.rootScope.vars.get(v.name);
          if (b) {
            exports.values.set(v.name, b.scheme);
            exports.valueSpans.set(v.name, v.span);
          }
        }
      } else if (item.kind === "TraitDecl" && item.pub) {
        exports.traits.set(item.name, this.traits.get(item.name)!);
      } else if (item.kind === "ImplDecl") {
        const implInfo = this.implDeclToInfo.get(item);
        if (implInfo) exports.traitImpls.push(implInfo);
      }
    }

    // Update top-level symbol types after inference
    for (const sym of this.symbols) {
      if ((sym.kind === "fn" || sym.kind === "var") && !sym.scopeSpan) {
        const b = this.rootScope.vars.get(sym.name);
        if (b) sym.type = b.scheme.type;
      } else if (sym.kind === "type") {
        const td = this.types.get(sym.name);
        if (td && td.typeParams.length === 0) {
          try { sym.type = this.resolveTypeExpr({ kind: "NamedTypeExpr", name: td.name, typeArgs: [], span: sym.span }, new Map()); } catch {}
        }
      } else if (sym.kind === "newtype") {
        const nt = this.newtypes.get(sym.name);
        if (nt && nt.typeParams.length === 0) {
          try { sym.type = this.resolveTypeExpr({ kind: "NamedTypeExpr", name: nt.name, typeArgs: [], span: sym.span }, new Map()); } catch {}
        }
      }
    }

    return {
      program: this.program,
      exports,
      exprTypes: this.exprTypes,
      callResolutions: this.callResolutions,
      forResolutions: this.forResolutions,
      castResolutions: this.castResolutions,
      schemaLiterals: this.schemaLiterals,
      decodeCodecs: this.decodeCodecs,
      reifiedExprTypes: this.reifiedExprTypes,
      newtypePatterns: this.newtypePatterns,
      newtypeValueAccess: this.newtypeValueAccess,
      reifiedIdentRefs: this.reifiedIdentRefs,
      asyncFns: this.asyncFns,
      asyncCalls: this.asyncCalls,
      extensionJsSymbols: this.extensionJsSymbols,
      traitImplJsSymbols: this.traitImplJsSymbols,
      fnReifiedParams: this.fnReifiedParams,
      namedParamDefaults: this.namedParamDefaults,
      importBindings: this.importBindings,
      namespaceImports: this.namespaceImports,
      symbols: this.symbols,
      identDefs: this.identDefs,
      namespaces: this.namespaces,
      extensions: this.extensions,
      traitImpls: this.traitImpls,
    };
  }

  private processImport(imp: Extract<TopItem, { kind: "ImportDecl" }>): void {
    if (!this.resolveModule) {
      throw new SplError("module", `Cannot resolve import "${imp.from}" without a module loader`, imp.span);
    }
    const mod = this.resolveModule(imp.from, this.program.file);

    if (imp.defaultAlias) {
      this.namespaces.set(imp.defaultAlias, mod);
      this.namespaceImports.set(imp.defaultAlias, imp.from);
      // Also import extensions & trait impls from namespace-imported module
      for (const ext of mod.extensions) {
        if (!this.extensions.some((e) => e.jsSymbol === ext.jsSymbol)) {
          this.extensions.push(ext);
        }
        this.importBindings.set(ext.jsSymbol, { moduleSpec: imp.from, exportedName: ext.jsSymbol });
      }
      for (const impl of mod.traitImpls) {
        this.registerImportedTraitImpl(impl, imp.span);
        for (const m of impl.methods.values()) {
          this.importBindings.set(m.jsSymbol, { moduleSpec: imp.from, exportedName: m.jsSymbol });
        }
      }
    }

    for (const spec of imp.specifiers) {
      const localName = spec.alias ?? spec.name;
      let found = false;

      const val = mod.values.get(spec.name);
      if (val) {
        const isAsync = mod.asyncValues.has(spec.name);
        const isReified = mod.reifiedValues.has(spec.name);
        const defaults = mod.valueDefaults.get(spec.name);
        this.rootScope.vars.set(localName, {
          scheme: val,
          mutable: false,
          isAsyncFn: isAsync,
          isReified,
          defaults,
          defSpan: mod.valueSpans.get(spec.name),
          doc: mod.valueDocs.get(spec.name),
          symKind: "fn",
        });
        if (defaults) this.namedParamDefaults.set(localName, defaults);
        if (isAsync) this.asyncFnNames.add(localName);
        this.importBindings.set(localName, { moduleSpec: imp.from, exportedName: spec.name });
        // If this imported value is an enum variant, register its parent enum for pattern matching
        for (const [eName, eDef] of mod.enums) {
          if (eDef.variants.has(spec.name)) {
            if (!this.enums.has(eName)) this.enums.set(eName, eDef);
            this.variantToEnum.set(localName, eName);
          }
        }
        found = true;
      }

      const tDef = mod.types.get(spec.name);
      if (tDef) {
        this.types.set(localName, tDef);
        found = true;
      }

      const ntDef = mod.newtypes?.get(spec.name);
      if (ntDef) {
        this.newtypes.set(localName, ntDef);
        found = true;
      }

      const eDef = mod.enums.get(spec.name);
      if (eDef) {
        this.enums.set(localName, eDef);
        for (const vName of eDef.variants.keys()) {
          this.variantToEnum.set(vName, localName);
          const vScheme = mod.values.get(vName);
          if (vScheme) {
            this.rootScope.vars.set(vName, { scheme: vScheme, mutable: false });
            this.importBindings.set(vName, { moduleSpec: imp.from, exportedName: vName });
          }
        }
        found = true;
      }

      const trDef = mod.traits.get(spec.name);
      if (trDef) {
        this.traits.set(localName, trDef);
        found = true;
      }

      // Check extension method export by name
      const matchingExts = mod.extensions.filter((e) => e.name === spec.name);
      if (matchingExts.length > 0) {
        for (const ext of matchingExts) {
          this.extensions.push({ ...ext, name: localName });
          this.importBindings.set(ext.jsSymbol, { moduleSpec: imp.from, exportedName: ext.jsSymbol });
        }
        found = true;
      }

      if (!found) {
        throw new SplError("module", `Module "${imp.from}" does not export '${spec.name}'`, imp.span);
      }
    }

    // Bring in trait impls and exported extensions from imported module
    for (const impl of mod.traitImpls) {
      this.registerImportedTraitImpl(impl, imp.span);
      for (const m of impl.methods.values()) {
        this.importBindings.set(m.jsSymbol, { moduleSpec: imp.from, exportedName: m.jsSymbol });
      }
    }
    for (const ext of mod.extensions) {
      if (!this.extensions.some((e) => e.jsSymbol === ext.jsSymbol)) {
        this.extensions.push(ext);
      }
      this.importBindings.set(ext.jsSymbol, { moduleSpec: imp.from, exportedName: ext.jsSymbol });
    }
  }

  private registerImportedTraitImpl(impl: TraitImplInfo, span: Span): void {
    const key = `${impl.traitName}::${impl.shapeKey}`;
    if (this.traitImplKeys.has(key)) return;
    this.traitImplKeys.add(key);
    this.traitImpls.push(impl);
  }

  private registerEnumConstructors(decl: EnumDecl): void {
    const tpMap = new Map<string, Type>();
    for (const tp of decl.typeParams) tpMap.set(tp.name, freshTVar(tp.bounds, tp.name));
    const resolving = new Set<string>([decl.name]);
    const variants = new Map<string, EnumVariantType>();
    for (const v of decl.variants) {
      variants.set(v.name, {
        fields: v.fields.map((f) => this.resolveTypeExpr(f, tpMap, resolving)),
        doc: v.doc,
        llmHint: v.llmHint,
      });
    }
    const enumType: Type = {
      kind: "TEnum",
      name: decl.name,
      typeArgs: decl.typeParams.map((tp) => tpMap.get(tp.name)!),
      variants,
      doc: decl.doc,
      llmHint: decl.llmHint,
    };

    for (const v of decl.variants) {
      const fTypes = variants.get(v.name)!.fields;
      const ctorType: Type =
        fTypes.length === 0 ? enumType : { kind: "TFn", params: fTypes, ret: enumType };
      const scheme = this.generalize(ctorType, this.rootScope);
      this.rootScope.vars.set(v.name, { scheme, mutable: false });
    }
  }

  private registerNewtypeConstructor(decl: NewtypeDecl, scope: Scope): void {
    const tpMap = new Map<string, Type>();
    const explicitIds: number[] = [];
    for (const tp of decl.typeParams) {
      const tv = freshTVar(tp.bounds, tp.name);
      tpMap.set(tp.name, tv);
      if (tv.kind === "TVar") explicitIds.push(tv.id);
    }
    const underlying = this.resolveTypeExpr(decl.body, tpMap);
    const ntType: Type = {
      kind: "TNewtype",
      name: decl.name,
      moduleFile: this.program.file,
      typeArgs: decl.typeParams.map((tp) => tpMap.get(tp.name)!),
      underlying,
      doc: decl.doc,
      llmHint: decl.llmHint,
    };
    const ctorType: Type = {
      kind: "TFn",
      params: [underlying],
      paramNames: ["value"],
      requiredCount: 1,
      ret: ntType,
    };
    const scheme = this.generalize(ctorType, scope);
    if (explicitIds.length > 0) {
      scheme.explicitTypeParams = explicitIds;
      for (const id of explicitIds) {
        if (!scheme.quantifiedTypeVars.includes(id)) scheme.quantifiedTypeVars.push(id);
      }
    }
    scope.vars.set(decl.name, {
      scheme,
      mutable: false,
      defSpan: decl.span,
      doc: decl.doc,
      symKind: "newtype",
    });
  }

  private collectReceiverTypeParams(te: TypeExpr, out: Set<string>): void {
    switch (te.kind) {
      case "NamedTypeExpr": {
        const isBuiltIn = [
          "Int", "Float", "Str", "String", "Bool", "Boolean", "Char", "Byte", "Bytes",
          "Json", "Prompt", "Unit", "Void", "Array", "Iter", "Dict", "Option", "Result",
          "TypeInfo", "TypeFieldInfo", "TypeVariantInfo",
        ].includes(te.name);
        if (
          te.typeArgs.length === 0 &&
          !isBuiltIn &&
          !this.types.has(te.name) &&
          !this.newtypes.has(te.name) &&
          !this.enums.has(te.name) &&
          !te.name.includes(".")
        ) {
          out.add(te.name);
        }
        for (const a of te.typeArgs) this.collectReceiverTypeParams(a, out);
        return;
      }
      case "OptionTypeExpr":
        this.collectReceiverTypeParams(te.inner, out);
        return;
      case "TupleTypeExpr":
        for (const e of te.elements) this.collectReceiverTypeParams(e, out);
        return;
      case "FnTypeExpr":
        for (const p of te.params) this.collectReceiverTypeParams(p, out);
        this.collectReceiverTypeParams(te.returnType, out);
        return;
      case "RecordTypeExpr":
        for (const f of te.fields) this.collectReceiverTypeParams(f.type, out);
        if (te.tail.kind === "OpenDict") this.collectReceiverTypeParams(te.tail.valueType, out);
        return;
      case "TypeofTypeExpr":
        return;
    }
  }

  private predeclareFn(fn: FnDecl, scope: Scope): void {
    const tpMap = new Map<string, Type>();
    if (fn.receiverType) {
      const recvParams = new Set<string>();
      this.collectReceiverTypeParams(fn.receiverType, recvParams);
      for (const name of recvParams) {
        tpMap.set(name, freshTVar([], name));
      }
    }
    const explicitTvs: Type[] = [];
    const explicitIds: number[] = [];
    for (const tp of fn.typeParams) {
      if (!tpMap.has(tp.name)) {
        const tv = freshTVar(tp.bounds, tp.name);
        tpMap.set(tp.name, tv);
        explicitTvs.push(tv);
        if (tv.kind === "TVar") explicitIds.push(tv.id);
      } else {
        const existing = tpMap.get(tp.name)!;
        explicitTvs.push(existing);
        if (existing.kind === "TVar") explicitIds.push(existing.id);
      }
    }
    if (explicitTvs.length > 0) {
      this.fnExplicitTypeParams.set(fn, explicitTvs);
    }
    if (fn.reified && explicitTvs.length > 0) {
      this.fnReifiedParams.set(fn, explicitTvs);
    }
    if (tpMap.size > 0) {
      this.fnTypeParamMaps.set(fn, tpMap);
    }

    const paramTypes: Type[] = [];
    for (let i = 0; i < fn.params.length; i++) {
      const p = fn.params[i];
      if (i === 0 && p.name === "self" && fn.receiverType && !p.type) {
        paramTypes.push(this.resolveTypeExpr(fn.receiverType, tpMap));
      } else {
        paramTypes.push(p.type ? this.resolveTypeExpr(p.type, tpMap) : freshTVar());
      }
    }
    const retType = fn.returnType ? this.resolveTypeExpr(fn.returnType, tpMap) : freshTVar();
    const fnType: Type = {
      kind: "TFn",
      params: paramTypes,
      paramNames: fn.params.map((p) => p.name),
      requiredCount: fn.params.filter((p) => !p.defaultValue).length,
      ret: retType,
    };

    if (fn.receiverType) {
      const recvType = this.resolveTypeExpr(fn.receiverType, tpMap);
      const jsSymbol = `__ext_${this.moduleTag}_${fn.name}_${++this.extCounter}`;
      this.extensionJsSymbols.set(fn, jsSymbol);
      const initScheme = this.generalize(fnType, this.rootScope);
      if (explicitIds.length > 0) {
        initScheme.explicitTypeParams = explicitIds;
        for (const id of explicitIds) {
          if (!initScheme.quantifiedTypeVars.includes(id)) {
            initScheme.quantifiedTypeVars.push(id);
          }
        }
      }
      this.extensions.push({
        name: fn.name,
        receiverType: recvType,
        fnType,
        scheme: initScheme,
        defaults: fn.params.map((p) => p.defaultValue),
        isReified: Boolean(fn.reified),
        jsSymbol,
        moduleFile: this.program.file,
        isAsync: false,
        mutSelf: Boolean(fn.params[0]?.mutable),
        doc: fn.doc,
        span: fn.span,
      });
      this.extFnDecls.set(jsSymbol, fn);
      this.fnDeclsByName.set(jsSymbol, fn);
    } else {
      const binding: VarBinding = {
        scheme: {
          quantifiedTypeVars: explicitIds.length > 0 ? [...explicitIds] : [],
          quantifiedRowVars: [],
          explicitTypeParams: explicitIds.length > 0 ? explicitIds : undefined,
          type: fnType,
        },
        mutable: false,
        isReified: Boolean(fn.reified),
        fnDecl: fn,
        paramNames: fn.params.map((p) => p.name),
        defaults: fn.params.map((p) => p.defaultValue),
        defSpan: fn.span,
        doc: fn.doc,
        symKind: "fn",
      };
      scope.vars.set(fn.name, binding);
      this.fnBindings.set(fn, binding);
      if (scope === this.rootScope) {
        this.symbols.push({ name: fn.name, kind: "fn", type: fnType, doc: fn.doc, span: fn.span });
      }
      this.fnDeclsByName.set(fn.name, fn);
      this.namedParamDefaults.set(fn.name, fn.params.map((p) => p.defaultValue));
    }
  }

  private predeclareImpl(impl: ImplDecl): void {
    if (!this.traits.has(impl.traitName)) {
      throw new SplError("type", `Unknown trait '${impl.traitName}'`, impl.span);
    }
    const tpMap = new Map<string, Type>();
    for (const tp of impl.typeParams) tpMap.set(tp.name, freshTVar(tp.bounds, tp.name));
    const targetType = this.resolveTypeExpr(impl.targetType, tpMap);
    const shapeKey = canonicalShapeKey(targetType);
    const coherenceKey = `${impl.traitName}::${shapeKey}`;

    // Structural coherence check!
    if (this.traitImplKeys.has(coherenceKey)) {
      throw new SplError(
        "type",
        `Conflicting trait implementation: '${impl.traitName}' is already implemented for structurally identical shape ${shapeKey}`,
        impl.span
      );
    }
    this.traitImplKeys.add(coherenceKey);

    const methods = new Map<string, { fnType: Type; jsSymbol: string; isAsync: boolean; mutSelf?: boolean }>();
    for (const m of impl.methods) {
      const paramTypes = m.params.map((p, i) => {
        if (i === 0 && p.name === "self" && !p.type) return targetType;
        return p.type ? this.resolveTypeExpr(p.type, tpMap) : freshTVar();
      });
      const retType = m.returnType ? this.resolveTypeExpr(m.returnType, tpMap) : freshTVar();
      const fnType: Type = { kind: "TFn", params: paramTypes, ret: retType };
      const jsSymbol = `__impl_${this.moduleTag}_${impl.traitName}_${m.name}_${++this.extCounter}`;
      this.traitImplJsSymbols.set(m, jsSymbol);
      methods.set(m.name, { fnType, jsSymbol, isAsync: false, mutSelf: Boolean(m.params[0]?.mutable) });
      this.fnDeclsByName.set(jsSymbol, m);
    }

    const implInfo: TraitImplInfo = {
      traitName: impl.traitName,
      shapeKey,
      targetType,
      methods,
    };
    this.implDeclToInfo.set(impl, implInfo);
    this.traitImpls.push(implInfo);
  }

  private checkFnDecl(fn: FnDecl, parentScope: Scope): void {
    let fnType: Type;
    let symName: string;

    if (fn.receiverType) {
      symName = this.extensionJsSymbols.get(fn)!;
      const ext = this.extensions.find((e) => e.jsSymbol === symName)!;
      fnType = ext.fnType;
    } else {
      symName = fn.name;
      fnType = parentScope.vars.get(fn.name)!.scheme.type;
    }

    if (fnType.kind !== "TFn") return;

    const fnScope: Scope = { vars: new Map(), parent: parentScope };
    for (let i = 0; i < fn.params.length; i++) {
      const p = fn.params[i];
      const pt = fnType.params[i];
      if (p.defaultValue) {
        const dt = this.checkExpr(p.defaultValue, parentScope);
        unify(pt, dt, p.defaultValue.span);
      }
      fnScope.vars.set(p.name, {
        scheme: { quantifiedTypeVars: [], quantifiedRowVars: [], type: pt },
        mutable: Boolean(p.mutable),
        defSpan: p.span,
        symKind: "param",
      });
      this.symbols.push({ name: p.name, kind: "param", type: pt, span: p.span, scopeSpan: fn.body.span });
    }

    const prevRet = this.currentFnRetType;
    const prevNode = this.currentFnNode;
    const prevEnclosingFn = this.currentEnclosingFnDecl;
    const prevScope = this.currentScope;
    const prevAsync = this.currentFnBecameAsync;
    const prevTypeParams = this.activeTypeParams;
    const prevReifiedParams = this.activeReifiedParams;
    this.currentFnRetType = fnType.ret;
    this.currentFnNode = fn;
    this.currentEnclosingFnDecl = fn;
    this.currentScope = fnScope;
    this.currentFnBecameAsync = false;
    const fnTpMap = this.fnTypeParamMaps.get(fn);
    if (fnTpMap && fnTpMap.size > 0) {
      this.activeTypeParams = new Map([...prevTypeParams, ...fnTpMap]);
      this.activeReifiedParams = [...prevReifiedParams, ...fnTpMap.values()];
    }

    const bodyType = this.checkBlock(fn.body, fnScope);
    unify(fnType.ret, bodyType, fn.body.span);

    if (this.currentFnBecameAsync) {
      this.asyncFns.add(fn);
      this.asyncFnNames.add(symName);
    }

    this.currentFnRetType = prevRet;
    this.currentFnNode = prevNode;
    this.currentEnclosingFnDecl = prevEnclosingFn;
    this.currentScope = prevScope;
    this.currentFnBecameAsync = prevAsync;
    this.activeTypeParams = prevTypeParams;
    this.activeReifiedParams = prevReifiedParams;

    // Generalize function scheme after checking body (enables row-polymorphic inference!)
    if (!fn.receiverType) {
      const b = parentScope.vars.get(fn.name)!;
      b.scheme = this.generalize(fnType, parentScope);
      const explicitTvs = this.fnExplicitTypeParams.get(fn);
      if (explicitTvs && explicitTvs.length > 0) {
        const prunedIds: number[] = [];
        for (const tv of explicitTvs) {
          const p = prune(tv);
          if (p.kind === "TVar") {
            prunedIds.push(p.id);
            if (!b.scheme.quantifiedTypeVars.includes(p.id)) {
              b.scheme.quantifiedTypeVars.push(p.id);
            }
          }
        }
        if (prunedIds.length > 0) {
          b.scheme.explicitTypeParams = prunedIds;
        }
      }
      if (this.asyncFns.has(fn)) b.isAsyncFn = true;
    } else {
      const ext = this.extensions.find((e) => e.jsSymbol === symName)!;
      ext.scheme = this.generalize(fnType, parentScope);
      const explicitTvs = this.fnExplicitTypeParams.get(fn);
      if (explicitTvs && explicitTvs.length > 0) {
        const prunedIds: number[] = [];
        for (const tv of explicitTvs) {
          const p = prune(tv);
          if (p.kind === "TVar") {
            prunedIds.push(p.id);
            if (!ext.scheme.quantifiedTypeVars.includes(p.id)) {
              ext.scheme.quantifiedTypeVars.push(p.id);
            }
          }
        }
        if (prunedIds.length > 0) {
          ext.scheme.explicitTypeParams = prunedIds;
        }
      }
      if (this.asyncFns.has(fn)) ext.isAsync = true;
    }
  }

  private checkImplDecl(impl: ImplDecl): void {
    const info = this.implDeclToInfo.get(impl);
    if (!info) return;

    for (const m of impl.methods) {
      const entry = info.methods.get(m.name)!;
      if (entry.fnType.kind !== "TFn") continue;
      const fnScope: Scope = { vars: new Map(), parent: this.rootScope };
      for (let i = 0; i < m.params.length; i++) {
        fnScope.vars.set(m.params[i].name, {
          scheme: { quantifiedTypeVars: [], quantifiedRowVars: [], type: entry.fnType.params[i] },
          mutable: Boolean(m.params[i].mutable),
        });
      }
      const prevRet = this.currentFnRetType;
      const prevNode = this.currentFnNode;
      const prevAsync = this.currentFnBecameAsync;
      this.currentFnRetType = entry.fnType.ret;
      this.currentFnNode = m;
      this.currentFnBecameAsync = false;

      const bodyType = this.checkBlock(m.body, fnScope);
      unify(entry.fnType.ret, bodyType, m.body.span);

      if (this.currentFnBecameAsync) {
        this.asyncFns.add(m);
        this.asyncFnNames.add(entry.jsSymbol);
        entry.isAsync = true;
      }

      this.currentFnRetType = prevRet;
      this.currentFnNode = prevNode;
      this.currentFnBecameAsync = prevAsync;
    }
  }

  // ==================== Statements ====================

  private checkBlock(block: BlockExpr, scope: Scope): Type {
    const inner: Scope = { vars: new Map(), parent: scope };
    const prevScope = this.currentScope;
    this.currentScope = inner;
    try {
      for (const stmt of block.stmts) {
        this.checkStmt(stmt, inner);
      }
      if (block.tailExpr) {
        const t = this.checkExpr(block.tailExpr, inner);
        this.exprTypes.set(block, t);
        return t;
      }
      this.exprTypes.set(block, TUnit);
      return TUnit;
    } finally {
      this.currentScope = prevScope;
    }
  }

  private checkStmt(stmt: Stmt, scope: Scope): void {
    switch (stmt.kind) {
      case "LetStmt":
        this.checkLetStmt(stmt, scope);
        return;
      case "AssignStmt": {
        const b = this.lookupVar(stmt.target, scope);
        if (!b) {
          throw new SplError("type", `Undefined variable '${stmt.target}'`, stmt.span);
        }
        if (!b.mutable) {
          throw new SplError(
            "type",
            `Cannot reassign immutable variable '${stmt.target}' (declare with 'let mut' to allow rebinding)`,
            stmt.span
          );
        }
        const valT = this.checkExpr(stmt.value, scope);
        unify(b.scheme.type, valT, stmt.span);
        return;
      }
      case "FieldAssignStmt": {
        if (
          stmt.object.kind === "IdentExpr" &&
          (this.namespaces.has(stmt.object.name) || this.enums.has(stmt.object.name))
        ) {
          throw new SplError("type", `Cannot assign to property '${stmt.property}' on '${stmt.object.name}'`, stmt.span);
        }
        const root = this.getRootIdent(stmt.object);
        if (root) {
          const b = this.lookupVar(root.name, scope);
          if (!b) {
            throw new SplError("type", `Undefined variable '${root.name}'`, root.span);
          }
          if (!b.mutable) {
            const hint =
              root.name === "self"
                ? "use 'mut self' in the method signature"
                : `declare with 'let mut ${root.name}' or 'mut ${root.name}'`;
            throw new SplError(
              "type",
              `Cannot mutate field '${stmt.property}' on immutable '${root.name}' (${hint})`,
              stmt.span
            );
          }
        }
        const objT = prune(this.checkExpr(stmt.object, scope));
        if (objT.kind === "TPrim" && objT.name === "Prompt") {
          throw new SplError("type", `Cannot mutate read-only property '${stmt.property}' on Prompt`, stmt.span);
        }
        if (objT.kind === "TNewtype" && stmt.property === "value") {
          const u = prune(objT.underlying);
          const hasRealValueField = u.kind === "TRecord" && flattenRecord(u).fields.has("value");
          if (!hasRealValueField) {
            throw new SplError(
              "type",
              `Cannot mutate '.value' directly on newtype '${objT.name}' (rebind with '${objT.name}(new_val)')`,
              stmt.span
            );
          }
        }
        const fieldT = this.accessProperty(objT, stmt.property, stmt.span);
        const valT = this.checkExpr(stmt.value, scope);
        unify(fieldT, valT, stmt.span);
        return;
      }
      case "IndexAssignStmt": {
        const objT = prune(this.checkExpr(stmt.object, scope));
        const idxT = this.checkExpr(stmt.index, scope);
        const valT = this.checkExpr(stmt.value, scope);
        if (objT.kind === "TArray") {
          unify(idxT, TInt, stmt.index.span);
          unify(objT.element, valT, stmt.value.span);
          return;
        }
        if (objT.kind === "TDict") {
          throw new SplError(
            "type",
            `Cannot mutate Dict via index assignment (Dict is immutable; use 'd = d.set(k, v)')`,
            stmt.span
          );
        }
        if (objT.kind === "TVar") {
          const elT = freshTVar();
          unify(objT, tArray(elT), stmt.object.span);
          unify(idxT, TInt, stmt.index.span);
          unify(elT, valT, stmt.value.span);
          return;
        }
        throw new SplError("type", `Type ${formatType(objT)} does not support index assignment`, stmt.span);
      }
      case "ReturnStmt": {
        const retT = stmt.value ? this.checkExpr(stmt.value, scope) : TUnit;
        if (this.currentFnRetType) {
          unify(this.currentFnRetType, retT, stmt.span);
        }
        return;
      }
      case "WhileStmt": {
        const condT = this.checkExpr(stmt.cond, scope);
        unify(condT, TBool, stmt.cond.span);
        this.checkBlock(stmt.body, scope);
        return;
      }
      case "ForStmt": {
        const iterT = prune(this.checkExpr(stmt.iterable, scope));
        let elemT: Type;

        if (iterT.kind === "TArray") {
          elemT = iterT.element;
          this.forResolutions.set(stmt, { kind: "Array" });
        } else if (iterT.kind === "TIter") {
          elemT = iterT.element;
          this.forResolutions.set(stmt, { kind: "Iter" });
        } else if (iterT.kind === "TDict") {
          elemT = tTuple([iterT.key, iterT.value]);
          this.forResolutions.set(stmt, { kind: "Dict" });
        } else if (iterT.kind === "TPrim" && iterT.name === "Str") {
          elemT = TChar;
          this.forResolutions.set(stmt, { kind: "Str" });
        } else {
          // Check for `.iter()` extension method or trait method returning `Iter<T>`
          const extMatch = this.findExtensionMethod(iterT, "iter");
          if (extMatch) {
            const instFn = instantiate(this.generalize(extMatch.fnType, this.rootScope));
            if (instFn.kind === "TFn" && instFn.params.length === 1) {
              unify(instFn.params[0], iterT, stmt.iterable.span);
              const elVar = freshTVar();
              unify(instFn.ret, tIter(elVar), stmt.iterable.span);
              elemT = prune(elVar);
              const isAsync = extMatch.isAsync || this.asyncFnNames.has(extMatch.jsSymbol);
              this.forResolutions.set(stmt, { kind: "ExtensionIter", jsSymbol: extMatch.jsSymbol, isAsync });
              if (isAsync) this.currentFnBecameAsync = true;
            } else {
              throw new SplError("type", `'.iter()' on ${formatType(iterT)} must take no extra arguments`, stmt.iterable.span);
            }
          } else {
            const traitMatch = this.findTraitMethodForType(iterT, "iter");
            if (traitMatch && traitMatch.fnType.kind === "TFn" && traitMatch.fnType.params.length === 1) {
              const elVar = freshTVar();
              unify(traitMatch.fnType.ret, tIter(elVar), stmt.iterable.span);
              elemT = prune(elVar);
              const isAsync = traitMatch.isAsync || this.asyncFnNames.has(traitMatch.jsSymbol);
              this.forResolutions.set(stmt, { kind: "TraitIter", jsSymbol: traitMatch.jsSymbol, isAsync });
              if (isAsync) this.currentFnBecameAsync = true;
            } else {
              throw new SplError(
                "type",
                `Type ${formatType(iterT)} is not iterable (expected Array<T>, Dict<K, V>, Iter<T>, Str, or a type with '.iter() -> Iter<T>')`,
                stmt.iterable.span
              );
            }
          }
        }

        const loopScope: Scope = { vars: new Map(), parent: scope };
        this.bindPattern(stmt.pattern, elemT, false, loopScope, false);
        this.checkBlock(stmt.body, loopScope);
        return;
      }
      case "FnDecl":
        this.predeclareFn(stmt, scope);
        this.checkFnDecl(stmt, scope);
        return;
      case "TypeDecl":
        this.types.set(stmt.name, {
          name: stmt.name,
          typeParams: stmt.typeParams.map((p) => p.name),
          body: stmt.body,
          doc: stmt.doc,
          llmHint: stmt.llmHint,
        });
        return;
      case "NewtypeDecl":
        this.newtypes.set(stmt.name, {
          name: stmt.name,
          moduleFile: this.program.file,
          typeParams: stmt.typeParams.map((p) => p.name),
          body: stmt.body,
          doc: stmt.doc,
          llmHint: stmt.llmHint,
          span: stmt.span,
        });
        this.registerNewtypeConstructor(stmt, scope);
        return;
      case "EnumDecl": {
        const variants = new Map<string, { fields: TypeExpr[]; doc?: string; llmHint?: string }>();
        for (const v of stmt.variants) {
          variants.set(v.name, { fields: v.fields, doc: v.doc, llmHint: v.llmHint });
          this.variantToEnum.set(v.name, stmt.name);
        }
        this.enums.set(stmt.name, {
          name: stmt.name,
          typeParams: stmt.typeParams.map((p) => p.name),
          variants,
          doc: stmt.doc,
          llmHint: stmt.llmHint,
        });
        this.registerEnumConstructors(stmt);
        return;
      }
      case "ExprStmt":
        this.checkExpr(stmt.expr, scope);
        return;
    }
  }

  private checkLetStmt(stmt: Extract<Stmt, { kind: "LetStmt" }>, scope: Scope): void {
    const valT = this.checkExpr(stmt.value, scope);
    if (stmt.typeAnnotation) {
      const annT = this.resolveTypeExpr(stmt.typeAnnotation, new Map());
      unify(annT, valT, stmt.span);
      this.bindPattern(stmt.pattern, annT, stmt.mutable, scope, true);
    } else {
      this.bindPattern(stmt.pattern, valT, stmt.mutable, scope, true);
    }
  }

  // ==================== Expressions ====================

  private checkExpr(expr: Expr, scope: Scope, expectedType?: Type): Type {
    const t =
      expr.kind === "LambdaExpr" && expectedType
        ? this.checkLambdaExpr(expr, scope, expectedType)
        : this.inferExpr(expr, scope);
    this.exprTypes.set(expr, t);
    return t;
  }

  private inferExpr(expr: Expr, scope: Scope): Type {
    switch (expr.kind) {
      case "IntLitExpr":
        return TInt;
      case "FloatLitExpr":
        return TFloat;
      case "StrLitExpr":
        return TStr;
      case "StrInterpExpr":
        for (const p of expr.parts) {
          if (typeof p !== "string") this.checkExpr(p, scope);
        }
        return TStr;
      case "CharLitExpr":
        return TChar;
      case "BoolLitExpr":
        return TBool;
      case "PromptExpr":
        for (const p of expr.parts) {
          if (typeof p !== "string") this.checkExpr(p, scope);
        }
        return TPrompt;

      case "IdentExpr": {
        const b = this.lookupVar(expr.name, scope);
        if (!b) {
          if (this.namespaces.has(expr.name)) {
            return { kind: "TRecord", fields: new Map(), tail: { kind: "RClosed" } };
          }
          throw new SplError("type", `Undefined identifier '${expr.name}'`, expr.span);
        }
        if (b.defSpan) {
          this.identDefs.set(expr, { span: b.defSpan, doc: b.doc, kind: b.symKind ?? "var" });
        }
        const inst = instantiateWithArgs(b.scheme, undefined, expr.span);
        if (b.isReified) {
          this.reifiedIdentRefs.set(expr, inst.instantiatedReifiedParams);
          this.reifiedCallSites.push({
            callerFn: this.currentEnclosingFnDecl,
            expr,
            kind: "IdentRef",
            targetFn: b.fnDecl,
            fixedReifiedTypes: inst.instantiatedReifiedParams,
            instantiationMap: inst.tMap,
          });
        } else if (b.fnDecl) {
          this.reifiedCallSites.push({
            callerFn: this.currentEnclosingFnDecl,
            expr,
            kind: "IdentRef",
            targetFn: b.fnDecl,
            instantiationMap: inst.tMap,
          });
        }
        return inst.type;
      }

      case "TupleExpr":
        if (expr.elements.length === 0) return TUnit;
        return tTuple(expr.elements.map((e) => this.checkExpr(e, scope)));

      case "ArrayExpr": {
        const elT = freshTVar();
        for (const el of expr.elements) {
          unify(elT, this.checkExpr(el, scope), el.span);
        }
        return tArray(elT);
      }

      case "RecordExpr":
        return this.checkRecordExpr(expr, scope);

      case "LambdaExpr":
        return this.checkLambdaExpr(expr, scope);

      case "BlockExpr":
        return this.checkBlock(expr, scope);

      case "UnaryExpr": {
        const opT = this.checkExpr(expr.operand, scope);
        if (expr.op === "!") {
          unify(opT, TBool, expr.span);
          return TBool;
        }
        if (expr.op === "~") {
          unify(opT, TInt, expr.span);
          return TInt;
        }
        // Unary `-`
        const p = prune(opT);
        if (p.kind === "TPrim" && (p.name === "Int" || p.name === "Float")) return p;
        unify(opT, TInt, expr.span);
        return TInt;
      }

      case "BinaryExpr":
        return this.checkBinaryExpr(expr, scope);

      case "RangeExpr": {
        unify(this.checkExpr(expr.start, scope), TInt, expr.start.span);
        unify(this.checkExpr(expr.end, scope), TInt, expr.end.span);
        if (expr.step) {
          unify(this.checkExpr(expr.step, scope), TInt, expr.step.span);
        }
        return tIter(TInt);
      }

      case "AsExpr": {
        const fromT = prune(this.checkExpr(expr.expr, scope));
        const toT = prune(this.resolveTypeExpr(expr.targetType, new Map()));
        const castKind = this.resolveCastKind(fromT, toT, expr.span);
        this.castResolutions.set(expr, castKind);
        return toT;
      }

      case "MemberExpr":
        return this.checkMemberExpr(expr, scope);

      case "OptionalMemberExpr": {
        const objT = this.checkExpr(expr.object, scope);
        const inner = freshTVar();
        unify(objT, tOption(inner), expr.object.span);
        const propT = prune(this.accessProperty(inner, expr.property, expr.span, expr));
        // Flat-map Option so `p?.optField` yields `T?` rather than `T??`
        if (propT.kind === "TEnum" && propT.name === "Option") {
          return propT;
        }
        return tOption(propT);
      }

      case "NullCoalesceExpr": {
        const leftT = prune(this.checkExpr(expr.left, scope));
        const rightT = this.checkExpr(expr.right, scope);
        if (leftT.kind === "TEnum" && leftT.name === "Result" && leftT.typeArgs.length === 2) {
          unify(leftT.typeArgs[0], rightT, expr.span);
          return leftT.typeArgs[0];
        }
        if (
          leftT.kind !== "TVar" &&
          !(leftT.kind === "TEnum" && leftT.name === "Option" && leftT.typeArgs.length === 1)
        ) {
          throw new SplError(
            "type",
            `Operator '??' expects Option<T> or Result<T, E>, found ${formatType(leftT)}`,
            expr.span
          );
        }
        unify(leftT, tOption(rightT), expr.span);
        return rightT;
      }

      case "IndexExpr": {
        const objT = prune(this.checkExpr(expr.object, scope));
        const idxT = this.checkExpr(expr.index, scope);

        if (objT.kind === "TArray") {
          unify(idxT, TInt, expr.index.span);
          return tOption(objT.element);
        }
        if (objT.kind === "TDict") {
          unify(idxT, objT.key, expr.index.span);
          return tOption(objT.value);
        }
        if (objT.kind === "TRecord") {
          unify(idxT, TStr, expr.index.span);
          const flat = flattenRecord(objT);
          if (flat.tail.kind === "ROpenDict") {
            return tOption(flat.tail.valueType);
          }
          if (flat.tail.kind === "RVar") {
            const vT = freshTVar();
            flat.tail.instance = { kind: "ROpenDict", valueType: vT };
            return tOption(vT);
          }
          throw new SplError(
            "type",
            `Cannot index closed record ${formatType(objT)} with dynamic key (declare \`..extra: Dict<Str, V>\` for dynamic keys)`,
            expr.span
          );
        }
        if (objT.kind === "TPrim" && objT.name === "Json") {
          return tOption(TJson);
        }
        if (objT.kind === "TVar") {
          const elT = freshTVar();
          unify(objT, tArray(elT), expr.object.span);
          unify(idxT, TInt, expr.index.span);
          return tOption(elT);
        }
        throw new SplError("type", `Cannot index type ${formatType(objT)}`, expr.span);
      }

      case "TryExpr": {
        const opT = prune(this.checkExpr(expr.operand, scope));
        const okT = freshTVar();
        const errT = freshTVar();
        if (opT.kind === "TEnum" && opT.name === "Option") {
          unify(opT, tOption(okT), expr.span);
          if (this.currentFnRetType) {
            unify(this.currentFnRetType, tOption(freshTVar()), expr.span);
          }
          return okT;
        }
        unify(opT, tResult(okT, errT), expr.span);
        if (this.currentFnRetType) {
          unify(this.currentFnRetType, tResult(freshTVar(), errT), expr.span);
        }
        return okT;
      }

      case "CallExpr":
        return this.checkCallExpr(expr, scope);

      case "IfExpr": {
        const condT = this.checkExpr(expr.cond, scope);
        unify(condT, TBool, expr.cond.span);
        const thenT = this.checkBlock(expr.thenBranch, scope);
        if (expr.elseBranch) {
          const elseT =
            expr.elseBranch.kind === "BlockExpr"
              ? this.checkBlock(expr.elseBranch, scope)
              : this.checkExpr(expr.elseBranch, scope);
          unify(thenT, elseT, expr.span);
          return thenT;
        }
        return TUnit;
      }

      case "MatchExpr":
        return this.checkMatchExpr(expr, scope);

      case "ReturnExpr": {
        const retT = expr.value ? this.checkExpr(expr.value, scope) : TUnit;
        if (this.currentFnRetType) {
          unify(this.currentFnRetType, retT, expr.span);
        }
        return freshTVar();
      }

      case "TypeSchemaExpr": {
        const resolved = this.resolveTypeExpr(expr.targetType, new Map(), new Set(), undefined, scope);
        const schema = generateJsonSchema(resolved);
        this.schemaLiterals.set(expr, schema);
        this.reifiedExprTypes.set(expr, resolved);
        this.recordFnReifiedTypeUse(this.currentEnclosingFnDecl, resolved);
        return TJson;
      }

      case "DecodeExpr": {
        const resolved = this.resolveTypeExpr(expr.targetType, new Map(), new Set(), undefined, scope);
        const argT = this.checkExpr(expr.arg, scope);
        unify(argT, TJson, expr.arg.span);
        const codec = generateDecodeCodec(resolved);
        this.decodeCodecs.set(expr, codec);
        this.reifiedExprTypes.set(expr, resolved);
        this.recordFnReifiedTypeUse(this.currentEnclosingFnDecl, resolved);
        const decodeErrType: Type = {
          kind: "TRecord",
          fields: new Map([
            ["path", TStr],
            ["message", TStr],
          ]),
          tail: { kind: "RClosed" },
        };
        return tResult(resolved, decodeErrType);
      }

      case "TypeofExpr": {
        let resolved: Type;
        if (expr.targetType) {
          resolved = this.resolveTypeExpr(expr.targetType, new Map(), new Set(), undefined, scope);
        } else {
          const prevAsync = this.currentFnBecameAsync;
          resolved = prune(this.checkExpr(expr.arg!, scope));
          this.currentFnBecameAsync = prevAsync;
        }
        this.reifiedExprTypes.set(expr, resolved);
        this.recordFnReifiedTypeUse(this.currentEnclosingFnDecl, resolved);
        return TTypeInfo;
      }
    }
  }

  private checkRecordExpr(expr: Extract<Expr, { kind: "RecordExpr" }>, scope: Scope): Type {
    const fields = new Map<string, Type>();
    let tail: RowTail = { kind: "RClosed" };

    for (const entry of expr.entries) {
      if (entry.kind === "Spread") {
        const spT = prune(this.checkExpr(entry.expr, scope));
        if (spT.kind === "TRecord") {
          const flat = flattenRecord(spT);
          for (const [k, v] of flat.fields) {
            fields.set(k, v);
          }
          tail = flat.tail;
        } else if (spT.kind === "TVar") {
          // Row-polymorphic spread! `{ ...x, ts: 123 }` infers `x: { ..r }` -> `{ ts: Int, ..r }`
          const rv = freshRVar();
          unify(spT, { kind: "TRecord", fields: new Map(), tail: rv }, entry.span);
          tail = rv;
        } else {
          throw new SplError("type", `Cannot spread non-record type ${formatType(spT)}`, entry.span);
        }
      } else {
        const vT = this.checkExpr(entry.value, scope);
        fields.set(entry.name, vT);
      }
    }

    const recType: Type = { kind: "TRecord", fields, tail };

    if (expr.typeName) {
      const named = this.resolveTypeExpr(
        { kind: "NamedTypeExpr", name: expr.typeName, typeArgs: [], span: expr.span },
        new Map()
      );
      if (named.kind === "TNewtype") {
        unify(named.underlying, recType, expr.span);
        return named;
      }
      unify(named, recType, expr.span);
      return named;
    }
    return recType;
  }

  private checkLambdaExpr(expr: Extract<Expr, { kind: "LambdaExpr" }>, scope: Scope, expectedType?: Type): Type {
    const expFn = expectedType ? prune(expectedType) : undefined;
    const lambdaScope: Scope = { vars: new Map(), parent: scope };
    const paramTypes: Type[] = [];
    for (let i = 0; i < expr.params.length; i++) {
      const p = expr.params[i];
      const pt = p.type
        ? this.resolveTypeExpr(p.type, new Map())
        : expFn?.kind === "TFn" && i < expFn.params.length
          ? expFn.params[i]
          : freshTVar();
      paramTypes.push(pt);
      lambdaScope.vars.set(p.name, {
        scheme: { quantifiedTypeVars: [], quantifiedRowVars: [], type: pt },
        mutable: Boolean(p.mutable),
        defSpan: p.span,
        symKind: "param",
      });
    }

    const retVar = expr.returnType
      ? this.resolveTypeExpr(expr.returnType, new Map())
      : expFn?.kind === "TFn"
        ? expFn.ret
        : freshTVar();
    const prevRet = this.currentFnRetType;
    const prevNode = this.currentFnNode;
    const prevAsync = this.currentFnBecameAsync;
    this.currentFnRetType = retVar;
    this.currentFnNode = expr;
    this.currentFnBecameAsync = false;

    const bodyT = this.checkBlock(expr.body, lambdaScope);
    unify(retVar, bodyT, expr.body.span);

    if (this.currentFnBecameAsync) {
      this.asyncFns.add(expr);
    }

    this.currentFnRetType = prevRet;
    this.currentFnNode = prevNode;
    this.currentFnBecameAsync = prevAsync;

    return { kind: "TFn", params: paramTypes, ret: retVar, isAsync: this.asyncFns.has(expr) };
  }

  private resolveCastKind(fromT: Type, toT: Type, span: Span): CastKind {
    const f = prune(fromT);
    const t = prune(toT);

    // Same primitive / structurally identical type -> no-op
    if (f.kind === "TPrim" && t.kind === "TPrim" && f.name === t.name) return "noop";

    // Any -> Str / Json
    if (t.kind === "TPrim" && t.name === "Str") {
      if (f.kind === "TPrim" && f.name === "Bytes") return "bytes_to_str";
      if (f.kind === "TPrim" && f.name === "Char") return "noop";
      return "to_str";
    }
    if (t.kind === "TPrim" && t.name === "Json") return "to_json";

    // Unconstrained type variable on LHS: unify with target
    if (f.kind === "TVar") {
      unify(f, t, span);
      return "noop";
    }

    // Numeric, Char, Bool, Str, Bytes conversions
    if (f.kind === "TPrim" && t.kind === "TPrim") {
      const fn = f.name;
      const tn = t.name;
      if ((fn === "Int" || fn === "Byte") && tn === "Float") return "noop";
      if (fn === "Byte" && tn === "Int") return "noop";
      if (fn === "Float" && tn === "Int") return "trunc_int";
      if ((fn === "Int" || fn === "Float") && tn === "Byte") return "to_byte";
      if (fn === "Char" && tn === "Int") return "char_to_int";
      if (fn === "Char" && tn === "Byte") return "char_to_byte";
      if ((fn === "Int" || fn === "Byte") && tn === "Char") return "int_to_char";
      if (fn === "Bool" && tn === "Int") return "bool_to_int";
      if ((fn === "Int" || fn === "Byte") && tn === "Bool") return "int_to_bool";
      if (fn === "Str" && tn === "Int") return "str_to_int";
      if (fn === "Str" && tn === "Float") return "str_to_float";
      if (fn === "Str" && tn === "Bytes") return "str_to_bytes";
    }

    // Iter<T> <-> Array<T>
    if (f.kind === "TIter" && t.kind === "TArray") {
      unify(f.element, t.element, span);
      return "iter_to_array";
    }
    if (f.kind === "TArray" && t.kind === "TIter") {
      unify(f.element, t.element, span);
      return "array_to_iter";
    }

    // Newtype <-> underlying type explicit cast (zero-overhead)
    if (f.kind === "TNewtype") {
      try {
        unify(cloneWithSubst(f.underlying, new Map(), new Map()), cloneWithSubst(t, new Map(), new Map()));
        unify(f.underlying, t, span);
        return "noop";
      } catch {
        // fall through to other casts (e.g. `as Str` or `as Json`)
      }
    }
    if (t.kind === "TNewtype") {
      try {
        unify(cloneWithSubst(f, new Map(), new Map()), cloneWithSubst(t.underlying, new Map(), new Map()));
        unify(f, t.underlying, span);
        return "noop";
      } catch {
        // fall through
      }
    }

    // Identical compound types (e.g. structural record upcast / alias cast)
    if (canonicalShapeKey(f) === canonicalShapeKey(t)) {
      return "noop";
    }

    throw new SplError("type", `Cannot convert ${formatType(f)} to ${formatType(t)} using 'as'`, span);
  }

  private checkBinaryExpr(expr: Extract<Expr, { kind: "BinaryExpr" }>, scope: Scope): Type {
    const lT = prune(this.checkExpr(expr.left, scope));
    const rT = prune(this.checkExpr(expr.right, scope));

    if (expr.op === "&&" || expr.op === "||") {
      unify(lT, TBool, expr.left.span);
      unify(rT, TBool, expr.right.span);
      return TBool;
    }

    if (expr.op === "==" || expr.op === "!=") {
      unify(lT, rT, expr.span);
      return TBool;
    }

    if (expr.op === "<" || expr.op === "<=" || expr.op === ">" || expr.op === ">=") {
      unify(lT, rT, expr.span);
      const p = prune(lT);
      if (p.kind === "TPrim" && (p.name === "Int" || p.name === "Float" || p.name === "Str" || p.name === "Char")) {
        return TBool;
      }
      if (p.kind === "TVar" || this.findTraitImpl("Ord", p)) {
        return TBool;
      }
      throw new SplError("type", `Type ${formatType(p)} does not implement 'Ord' for '${expr.op}'`, expr.span);
    }

    if (expr.op === "&" || expr.op === "|" || expr.op === "^" || expr.op === "<<" || expr.op === ">>") {
      unify(lT, TInt, expr.left.span);
      unify(rT, TInt, expr.right.span);
      return TInt;
    }

    if (expr.op === "+") {
      unify(lT, rT, expr.span);
      const p = prune(lT);
      if (p.kind === "TPrim" && (p.name === "Int" || p.name === "Float" || p.name === "Str")) {
        return p;
      }
      if (p.kind === "TVar") return p;
      const addImpl = this.findTraitImpl("Add", p);
      if (addImpl) return p;
      throw new SplError("type", `Operator '+' is not defined for type ${formatType(p)}`, expr.span);
    }

    // Arithmetic `- * / % **`
    unify(lT, rT, expr.span);
    const p = prune(lT);
    if (p.kind === "TPrim" && (p.name === "Int" || p.name === "Float")) {
      return p;
    }
    if (p.kind === "TVar") {
      unify(p, TInt, expr.span);
      return TInt;
    }
    throw new SplError("type", `Arithmetic operator '${expr.op}' expects Int or Float, found ${formatType(p)}`, expr.span);
  }

  private checkMemberExpr(expr: Extract<Expr, { kind: "MemberExpr" }>, scope: Scope): Type {
    // Namespace access `fs.read`
    if (expr.object.kind === "IdentExpr" && this.namespaces.has(expr.object.name)) {
      const mod = this.namespaces.get(expr.object.name)!;
      const val = mod.values.get(expr.property);
      if (!val) {
        throw new SplError("type", `Module '${expr.object.name}' has no export '${expr.property}'`, expr.span);
      }
      return instantiate(val);
    }

    // Qualified enum constructor `ToolResult.Ok`
    if (expr.object.kind === "IdentExpr" && this.enums.has(expr.object.name)) {
      const vScheme = this.lookupVar(expr.property, scope);
      if (vScheme) return instantiate(vScheme.scheme);
    }

    const objT = this.checkExpr(expr.object, scope);
    return this.accessProperty(objT, expr.property, expr.span, expr);
  }

  private accessProperty(objType: Type, prop: string, span: Span, memberExpr?: Expr): Type {
    const p = prune(objType);

    if (p.kind === "TNewtype") {
      const u = prune(p.underlying);
      // 1. Transparent field forwarding for struct/record-backed newtypes
      if (u.kind === "TRecord") {
        const flat = flattenRecord(u);
        const fieldT = flat.fields.get(prop);
        if (fieldT) return fieldT;
        if (flat.tail.kind === "ROpenDict" && (flat.tail.extraName ?? "extra") === prop) {
          return tDict(TStr, flat.tail.valueType);
        }
      }
      // 2. `.value` unwraps the newtype to its underlying type (zero runtime overhead)
      if (prop === "value") {
        if (memberExpr) this.newtypeValueAccess.add(memberExpr);
        return p.underlying;
      }
      if (u.kind === "TRecord" && flattenRecord(u).tail.kind === "RVar") {
        return this.accessProperty(u, prop, span, memberExpr);
      }
      throw new SplError(
        "type",
        `Newtype '${p.name}' has no property '${prop}' (use '.value' to unwrap underlying ${formatType(p.underlying)})`,
        span
      );
    }

    if (p.kind === "TRecord") {
      const flat = flattenRecord(p);
      const fieldT = flat.fields.get(prop);
      if (fieldT) return fieldT;

      // Accessing `ev.extra` on hybrid open record `..extra: Dict<Str, V>`
      if (flat.tail.kind === "ROpenDict" && (flat.tail.extraName ?? "extra") === prop) {
        return tDict(TStr, flat.tail.valueType);
      }

      // Open row variable: infer required field `prop`!
      if (flat.tail.kind === "RVar") {
        const fVar = freshTVar();
        const nextTail = freshRVar();
        flat.tail.extraFields = new Map([[prop, fVar]]);
        flat.tail.instance = nextTail;
        return fVar;
      }

      throw new SplError(
        "type",
        `Record ${formatType(p)} has no property '${prop}'` +
          (flat.tail.kind === "ROpenDict" ? ` (use bracket access \`["${prop}"]\` for dynamic keys)` : ""),
        span
      );
    }

    if (p.kind === "TVar") {
      // Infer open row-polymorphic record `{ prop: a, ..r }`!
      const fVar = freshTVar();
      unify(p, { kind: "TRecord", fields: new Map([[prop, fVar]]), tail: freshRVar() }, span);
      return fVar;
    }

    // Built-in property shortcuts (e.g. `prompt.text`)
    if (p.kind === "TPrim" && p.name === "Prompt") {
      if (prop === "text") return TStr;
      if (prop === "parts") return tArray(TStr);
    }

    throw new SplError("type", `Type ${formatType(p)} has no property '${prop}'`, span);
  }

  private checkCallExpr(expr: Extract<Expr, { kind: "CallExpr" }>, scope: Scope): Type {
    // Case 1: Method call `receiver.method(args...)` (not a module namespace or enum qualifier)
    if (expr.callee.kind === "MemberExpr") {
      const obj = expr.callee.object;
      const method = expr.callee.property;

      // Namespace call `fs.read(path)` or `codegen.js_fn<In, Out>(body)`
      if (obj.kind === "IdentExpr" && this.namespaces.has(obj.name)) {
        const mod = this.namespaces.get(obj.name)!;
        const val = mod.values.get(method);
        if (!val) {
          throw new SplError("type", `Module '${obj.name}' has no export '${method}'`, expr.span);
        }
        const explicitArgs =
          expr.typeArgs.length > 0
            ? expr.typeArgs.map((ta) => this.resolveTypeExpr(ta, new Map()))
            : undefined;
        const { type: fnT, instantiatedReifiedParams } = instantiateWithArgs(val, explicitArgs, expr.span);
        const modDefaults = mod.valueDefaults.get(method);
        const { ret, reordered } = this.applyCallArgs(fnT, expr.args, modDefaults, scope, expr.span);
        const reifiedTypeVars = mod.reifiedValues.has(method) ? instantiatedReifiedParams : undefined;
        if (reifiedTypeVars) {
          this.reifiedCallSites.push({
            callerFn: this.currentEnclosingFnDecl,
            expr,
            kind: "Namespace",
            fixedReifiedTypes: reifiedTypeVars,
          });
        }
        this.callResolutions.set(expr, {
          kind: "NamespaceCall",
          alias: obj.name,
          member: method,
          reorderedArgs: reordered,
          reifiedTypeVars,
        });
        if (mod.asyncValues.has(method)) {
          this.markCallAsync(expr);
        }
        this.recordCallSite(expr, `${obj.name}.${method}`, undefined, expr.args);
        return ret;
      }

      // Enum constructor `ToolResult.Ok(v)`
      if (obj.kind === "IdentExpr" && this.enums.has(obj.name)) {
        const ctor = this.lookupVar(method, scope);
        if (!ctor) {
          throw new SplError("type", `Enum '${obj.name}' has no variant '${method}'`, expr.span);
        }
        const fnT = instantiate(ctor.scheme);
        const { ret } = this.applyCallArgs(fnT, expr.args, undefined, scope, expr.span);
        this.callResolutions.set(expr, { kind: "EnumCtor", variant: method });
        return ret;
      }

      // Check if receiver has a function-typed field (record method field) vs extension/trait/builtin method
      const recvT = prune(this.checkExpr(obj, scope));

      // 1a. Record field holding a function
      if (recvT.kind === "TRecord") {
        const flat = flattenRecord(recvT);
        const fieldT = flat.fields.get(method);
        if (fieldT) {
          const { ret, reordered } = this.applyCallArgs(fieldT, expr.args, undefined, scope, expr.span);
          this.callResolutions.set(expr, { kind: "Normal", reorderedArgs: reordered });
          const pf = prune(fieldT);
          if (pf.kind === "TFn" && pf.isAsync) {
            this.markCallAsync(expr);
          }
          this.recordCallSite(expr, undefined, expr.callee, expr.args);
          return ret;
        }
      }

      // 1b. Extension method matching receiver structurally
      const extMatch = this.findExtensionMethod(recvT, method);
      if (extMatch) {
        if (extMatch.mutSelf) {
          this.assertMutableReceiver(obj, method, scope, expr.span);
        }
        const scheme = extMatch.scheme ?? this.generalize(extMatch.fnType, this.rootScope);
        const explicitArgs =
          expr.typeArgs.length > 0
            ? expr.typeArgs.map((ta) => this.resolveTypeExpr(ta, new Map()))
            : undefined;
        const { type: instFn, instantiatedReifiedParams, tMap } = instantiateWithArgs(scheme, explicitArgs, expr.span);
        if (instFn.kind === "TFn") {
          unify(instFn.params[0], recvT, obj.span);
          const restFn: Type = {
            kind: "TFn",
            params: instFn.params.slice(1),
            paramNames: instFn.paramNames?.slice(1),
            requiredCount:
              instFn.requiredCount !== undefined ? Math.max(0, instFn.requiredCount - 1) : undefined,
            ret: instFn.ret,
          };
          const restDefaults = extMatch.defaults?.slice(1);
          const { ret, reordered } = this.applyCallArgs(restFn, expr.args, restDefaults, scope, expr.span);
          const reifiedTypeVars = extMatch.isReified ? instantiatedReifiedParams : undefined;
          const targetExtFn = this.extFnDecls.get(extMatch.jsSymbol);
          if (reifiedTypeVars || targetExtFn) {
            this.reifiedCallSites.push({
              callerFn: this.currentEnclosingFnDecl,
              expr,
              kind: "Extension",
              targetFn: targetExtFn,
              targetExt: extMatch,
              fixedReifiedTypes: reifiedTypeVars,
              instantiationMap: tMap,
            });
          }
          this.callResolutions.set(expr, {
            kind: "ExtensionMethod",
            jsSymbol: extMatch.jsSymbol,
            receiver: obj,
            isAsync: extMatch.isAsync,
            reorderedArgs: reordered,
            reifiedTypeVars,
          });
          if (extMatch.isAsync || this.asyncFnNames.has(extMatch.jsSymbol)) {
            this.markCallAsync(expr);
          }
          this.recordCallSite(expr, extMatch.jsSymbol, undefined, expr.args);
          return ret;
        }
      }

      // 1c. Trait method implementation for receiver
      const traitMatch = this.findTraitMethodForType(recvT, method);
      if (traitMatch) {
        if (traitMatch.mutSelf) {
          this.assertMutableReceiver(obj, method, scope, expr.span);
        }
        const instFn = traitMatch.fnType;
        if (instFn.kind === "TFn") {
          const restFn: Type = { kind: "TFn", params: instFn.params.slice(1), ret: instFn.ret };
          const { ret } = this.applyCallArgs(restFn, expr.args, undefined, scope, expr.span);
          this.callResolutions.set(expr, {
            kind: "TraitMethod",
            jsSymbol: traitMatch.jsSymbol,
            receiver: obj,
            isAsync: traitMatch.isAsync,
          });
          if (traitMatch.isAsync || this.asyncFnNames.has(traitMatch.jsSymbol)) {
            this.markCallAsync(expr);
          }
          this.recordCallSite(expr, traitMatch.jsSymbol, undefined, expr.args);
          return ret;
        }
      }

      // 1d. Built-in type methods (`Array.map`, `Str.split`, `Dict.get`, `Option.unwrap_or`, etc.)
      const builtinRes = this.checkBuiltinMethod(recvT, obj, method, expr.args, expr, scope);
      if (builtinRes) return builtinRes;

      throw new SplError("type", `No method '${method}' found on type ${formatType(recvT)}`, expr.span);
    }

    // Case 2: Direct call `callee(args...)` or `callee<T...>(args...)`
    let calleeName: string | undefined;
    let defaults: (Expr | undefined)[] | undefined;
    let isKnownAsync = false;
    let isReified = false;
    let targetFnDecl: FnDecl | undefined;
    let callTMap: Map<number, Type> | undefined;
    let fnT: Type;
    let instantiatedParams: Type[] = [];

    if (expr.callee.kind === "IdentExpr") {
      calleeName = expr.callee.name;
      const b = this.lookupVar(calleeName, scope);
      if (b) {
        defaults = b.defaults ?? this.namedParamDefaults.get(calleeName);
        isKnownAsync = Boolean(b.isAsyncFn || this.asyncFnNames.has(calleeName));
        isReified = Boolean(b.isReified);
        targetFnDecl = b.fnDecl;
      }
      // Enum constructor?
      if (this.variantToEnum.has(calleeName)) {
        const ctorT = this.checkExpr(expr.callee, scope);
        const { ret } = this.applyCallArgs(ctorT, expr.args, undefined, scope, expr.span);
        this.callResolutions.set(expr, { kind: "EnumCtor", variant: calleeName });
        return ret;
      }
      if (b && (expr.typeArgs.length > 0 || isReified || targetFnDecl)) {
        const explicitArgs =
          expr.typeArgs.length > 0
            ? expr.typeArgs.map((ta) => this.resolveTypeExpr(ta, new Map()))
            : undefined;
        const inst = instantiateWithArgs(b.scheme, explicitArgs, expr.span);
        fnT = inst.type;
        instantiatedParams = inst.instantiatedReifiedParams;
        callTMap = inst.tMap;
        this.exprTypes.set(expr.callee, fnT);
        if (b.defSpan) {
          this.identDefs.set(expr.callee, { span: b.defSpan, doc: b.doc, kind: b.symKind ?? "fn" });
        }
      } else {
        fnT = this.checkExpr(expr.callee, scope);
      }
    } else {
      fnT = this.checkExpr(expr.callee, scope);
    }

    const { ret, reordered } = this.applyCallArgs(fnT, expr.args, defaults, scope, expr.span);
    const reifiedTypeVars = isReified ? instantiatedParams : undefined;
    if (reifiedTypeVars || targetFnDecl) {
      this.reifiedCallSites.push({
        callerFn: this.currentEnclosingFnDecl,
        expr,
        kind: "Direct",
        targetFn: targetFnDecl,
        fixedReifiedTypes: reifiedTypeVars,
        instantiationMap: callTMap,
      });
    }
    this.callResolutions.set(expr, { kind: "Normal", reorderedArgs: reordered, reifiedTypeVars });

    if (isKnownAsync || (prune(fnT).kind === "TFn" && (prune(fnT) as Extract<Type, { kind: "TFn" }>).isAsync)) {
      this.markCallAsync(expr);
    }
    this.recordCallSite(expr, calleeName, expr.callee, expr.args);
    return ret;
  }

  private applyCallArgs(
    calleeType: Type,
    args: CallArg[],
    defaults: (Expr | undefined)[] | undefined,
    scope: Scope,
    span: Span
  ): { ret: Type; reordered?: (Expr | undefined)[] } {
    const fn = prune(calleeType);
    const hasNamed = args.some((a) => a.name !== undefined);

    if (fn.kind === "TFn") {
      const paramNames = fn.paramNames;
      let orderedExprs: (Expr | undefined)[];

      if (hasNamed && paramNames) {
        orderedExprs = new Array(fn.params.length).fill(undefined);
        let posIdx = 0;
        let seenNamed = false;
        for (const arg of args) {
          if (arg.name) {
            seenNamed = true;
            const idx = paramNames.indexOf(arg.name);
            if (idx === -1) {
              throw new SplError("type", `Unknown named parameter '${arg.name}'`, arg.span);
            }
            if (orderedExprs[idx] !== undefined) {
              throw new SplError("type", `Duplicate argument for parameter '${arg.name}'`, arg.span);
            }
            orderedExprs[idx] = arg.value;
          } else {
            if (seenNamed) {
              // Trailing lambda or prompt block goes into the last remaining slot!
              const lastEmpty = orderedExprs.lastIndexOf(undefined);
              if (lastEmpty === -1) {
                throw new SplError("type", `Too many arguments: expected ${fn.params.length}`, arg.span);
              }
              orderedExprs[lastEmpty] = arg.value;
            } else {
              if (posIdx >= fn.params.length) {
                throw new SplError("type", `Too many arguments: expected ${fn.params.length}`, arg.span);
              }
              orderedExprs[posIdx++] = arg.value;
            }
          }
        }
        // Fill defaults for omitted optional params
        for (let i = 0; i < fn.params.length; i++) {
          if (orderedExprs[i] === undefined) {
            const def = defaults?.[i];
            if (def !== undefined) {
              orderedExprs[i] = def;
            } else {
              throw new SplError(
                "type",
                `Missing required argument '${paramNames[i] ?? i}'`,
                span
              );
            }
          }
        }
      } else {
        const lastArg = args.length > 0 ? args[args.length - 1] : undefined;
        const lastParamType = fn.params.length > 0 ? prune(fn.params[fn.params.length - 1]) : undefined;
        const routeTrailingPrompt =
          lastArg !== undefined &&
          lastArg.value.kind === "PromptExpr" &&
          args.length < fn.params.length &&
          lastParamType?.kind === "TPrim" &&
          lastParamType.name === "Prompt";

        if (routeTrailingPrompt && defaults) {
          orderedExprs = new Array(fn.params.length).fill(undefined);
          for (let i = 0; i < args.length - 1; i++) {
            orderedExprs[i] = args[i].value;
          }
          orderedExprs[fn.params.length - 1] = lastArg.value;
          for (let i = 0; i < fn.params.length; i++) {
            if (orderedExprs[i] === undefined) {
              if (defaults[i] !== undefined) {
                orderedExprs[i] = defaults[i];
              } else {
                throw new SplError("type", `Missing required argument '${paramNames?.[i] ?? i}'`, span);
              }
            }
          }
        } else {
          orderedExprs = args.map((a) => a.value);
          if (orderedExprs.length < fn.params.length && defaults) {
            for (let i = orderedExprs.length; i < fn.params.length; i++) {
              if (defaults[i] !== undefined) orderedExprs.push(defaults[i]);
            }
          }
          if (orderedExprs.length !== fn.params.length) {
            throw new SplError(
              "type",
              `Expected ${fn.params.length} argument(s), got ${orderedExprs.length}`,
              span
            );
          }
        }
      }

      for (let i = 0; i < fn.params.length; i++) {
        const argExpr = orderedExprs[i]!;
        const argT = this.checkExpr(argExpr, scope, fn.params[i]);
        unify(fn.params[i], argT, argExpr.span);
        this.checkTraitBounds(fn.params[i], argT, argExpr.span);
      }

      return { ret: fn.ret, reordered: hasNamed || (defaults?.some(Boolean) ?? false) ? orderedExprs : undefined };
    }

    // Unknown function variable
    const argTypes = args.map((a) => this.checkExpr(a.value, scope));
    const ret = freshTVar();
    unify(calleeType, { kind: "TFn", params: argTypes, ret }, span);
    return { ret };
  }

  private checkBuiltinMethod(
    recvT: Type,
    recvExpr: Expr,
    method: string,
    args: CallArg[],
    callExpr: Extract<Expr, { kind: "CallExpr" }>,
    scope: Scope
  ): Type | undefined {
    const checkArg = (i: number, expected?: Type) => this.checkExpr(args[i].value, scope, expected);

    // Array<T> methods
    if (recvT.kind === "TArray") {
      const el = recvT.element;
      switch (method) {
        case "len":
          if (args.length !== 0) throw new SplError("type", "Array.len() takes 0 args", callExpr.span);
          this.callResolutions.set(callExpr, { kind: "BuiltinMethod", target: "array_len", receiver: recvExpr });
          return TInt;

        case "get": {
          if (args.length !== 1) throw new SplError("type", "Array.get(index) takes 1 arg", callExpr.span);
          unify(checkArg(0), TInt, args[0].span);
          this.callResolutions.set(callExpr, { kind: "BuiltinMethod", target: "array_get", receiver: recvExpr });
          return tOption(el);
        }

        case "set": {
          if (args.length !== 2) throw new SplError("type", "Array.set(index, value) takes 2 args", callExpr.span);
          unify(checkArg(0), TInt, args[0].span);
          unify(checkArg(1), el, args[1].span);
          this.callResolutions.set(callExpr, { kind: "BuiltinMethod", target: "array_set", receiver: recvExpr });
          return tArray(el);
        }

        case "slice": {
          if (args.length !== 2) throw new SplError("type", "Array.slice(start, end) takes 2 args", callExpr.span);
          unify(checkArg(0), TInt, args[0].span);
          unify(checkArg(1), TInt, args[1].span);
          this.callResolutions.set(callExpr, { kind: "BuiltinMethod", target: "array_slice", receiver: recvExpr });
          return tArray(el);
        }

        case "concat": {
          if (args.length !== 1) throw new SplError("type", "Array.concat(other) takes 1 arg", callExpr.span);
          unify(checkArg(0), tArray(el), args[0].span);
          this.callResolutions.set(callExpr, { kind: "BuiltinMethod", target: "array_concat", receiver: recvExpr });
          return tArray(el);
        }

        case "push": {
          if (args.length !== 1) throw new SplError("type", "Array.push(item) takes 1 arg", callExpr.span);
          unify(checkArg(0), el, args[0].span);
          this.callResolutions.set(callExpr, { kind: "BuiltinMethod", target: "array_push", receiver: recvExpr });
          return tArray(el);
        }

        case "pop": {
          if (args.length !== 0) throw new SplError("type", "Array.pop() takes 0 args", callExpr.span);
          this.callResolutions.set(callExpr, { kind: "BuiltinMethod", target: "array_pop", receiver: recvExpr });
          return tOption(el);
        }

        case "swap": {
          if (args.length !== 2) throw new SplError("type", "Array.swap(i, j) takes 2 args", callExpr.span);
          unify(checkArg(0), TInt, args[0].span);
          unify(checkArg(1), TInt, args[1].span);
          this.callResolutions.set(callExpr, { kind: "BuiltinMethod", target: "array_swap", receiver: recvExpr });
          return tArray(el);
        }

        case "clear": {
          if (args.length !== 0) throw new SplError("type", "Array.clear() takes 0 args", callExpr.span);
          this.callResolutions.set(callExpr, { kind: "BuiltinMethod", target: "array_clear", receiver: recvExpr });
          return tArray(el);
        }

        case "map":
        case "par_map": {
          if (args.length !== 1) throw new SplError("type", `Array.${method}(f) takes 1 arg`, callExpr.span);
          const outEl = freshTVar();
          const fnT = checkArg(0, { kind: "TFn", params: [el], ret: outEl });
          unify(fnT, { kind: "TFn", params: [el], ret: outEl }, args[0].span);
          const isPar = method === "par_map";
          const cbAsync = this.isExprAsync(args[0].value);
          this.callResolutions.set(callExpr, {
            kind: "BuiltinMethod",
            target: isPar ? "array_par_map" : "array_map",
            receiver: recvExpr,
            isAsync: isPar || cbAsync,
          });
          if (isPar || cbAsync) this.markCallAsync(callExpr);
          this.recordCallSite(callExpr, undefined, undefined, args);
          return tArray(outEl);
        }

        case "filter": {
          if (args.length !== 1) throw new SplError("type", "Array.filter(f) takes 1 arg", callExpr.span);
          const fnT = checkArg(0, { kind: "TFn", params: [el], ret: TBool });
          unify(fnT, { kind: "TFn", params: [el], ret: TBool }, args[0].span);
          const cbAsync = this.isExprAsync(args[0].value);
          this.callResolutions.set(callExpr, {
            kind: "BuiltinMethod",
            target: "array_filter",
            receiver: recvExpr,
            isAsync: cbAsync,
          });
          if (cbAsync) this.markCallAsync(callExpr);
          this.recordCallSite(callExpr, undefined, undefined, args);
          return tArray(el);
        }

        case "fold": {
          if (args.length !== 2) throw new SplError("type", "Array.fold(init, f) takes 2 args", callExpr.span);
          const accT = checkArg(0);
          const fnT = checkArg(1, { kind: "TFn", params: [accT, el], ret: accT });
          unify(fnT, { kind: "TFn", params: [accT, el], ret: accT }, args[1].span);
          const cbAsync = this.isExprAsync(args[1].value);
          this.callResolutions.set(callExpr, {
            kind: "BuiltinMethod",
            target: "array_fold",
            receiver: recvExpr,
            isAsync: cbAsync,
          });
          if (cbAsync) this.markCallAsync(callExpr);
          this.recordCallSite(callExpr, undefined, undefined, args);
          return accT;
        }

        case "flat_map": {
          if (args.length !== 1) throw new SplError("type", "Array.flat_map(f) takes 1 arg", callExpr.span);
          const outEl = freshTVar();
          const fnT = checkArg(0, { kind: "TFn", params: [el], ret: tArray(outEl) });
          unify(fnT, { kind: "TFn", params: [el], ret: tArray(outEl) }, args[0].span);
          const cbAsync = this.isExprAsync(args[0].value);
          this.callResolutions.set(callExpr, {
            kind: "BuiltinMethod",
            target: "array_flat_map",
            receiver: recvExpr,
            isAsync: cbAsync,
          });
          if (cbAsync) this.markCallAsync(callExpr);
          this.recordCallSite(callExpr, undefined, undefined, args);
          return tArray(outEl);
        }

        case "find": {
          if (args.length !== 1) throw new SplError("type", "Array.find(f) takes 1 arg", callExpr.span);
          const fnT = checkArg(0, { kind: "TFn", params: [el], ret: TBool });
          unify(fnT, { kind: "TFn", params: [el], ret: TBool }, args[0].span);
          this.callResolutions.set(callExpr, { kind: "BuiltinMethod", target: "array_find", receiver: recvExpr });
          return tOption(el);
        }

        case "join": {
          if (args.length !== 1) throw new SplError("type", "Array.join(sep) takes 1 arg", callExpr.span);
          unify(el, TStr, callExpr.span);
          unify(checkArg(0), TStr, args[0].span);
          this.callResolutions.set(callExpr, { kind: "BuiltinMethod", target: "array_join", receiver: recvExpr });
          return TStr;
        }

        case "iter": {
          if (args.length !== 0) throw new SplError("type", "Array.iter() takes 0 args", callExpr.span);
          this.callResolutions.set(callExpr, { kind: "BuiltinMethod", target: "array_iter", receiver: recvExpr });
          return tIter(el);
        }
      }
    }

    // Iter<T> methods (lazy pull iterator)
    if (recvT.kind === "TIter") {
      const el = recvT.element;
      switch (method) {
        case "next":
          if (args.length !== 0) throw new SplError("type", "Iter.next() takes 0 args", callExpr.span);
          this.callResolutions.set(callExpr, { kind: "BuiltinMethod", target: "iter_next", receiver: recvExpr });
          return tOption(el);

        case "map": {
          if (args.length !== 1) throw new SplError("type", "Iter.map(f) takes 1 arg", callExpr.span);
          const outEl = freshTVar();
          const fnT = checkArg(0, { kind: "TFn", params: [el], ret: outEl });
          unify(fnT, { kind: "TFn", params: [el], ret: outEl }, args[0].span);
          this.callResolutions.set(callExpr, { kind: "BuiltinMethod", target: "iter_map", receiver: recvExpr });
          return tIter(outEl);
        }

        case "filter": {
          if (args.length !== 1) throw new SplError("type", "Iter.filter(pred) takes 1 arg", callExpr.span);
          const fnT = checkArg(0, { kind: "TFn", params: [el], ret: TBool });
          unify(fnT, { kind: "TFn", params: [el], ret: TBool }, args[0].span);
          this.callResolutions.set(callExpr, { kind: "BuiltinMethod", target: "iter_filter", receiver: recvExpr });
          return tIter(el);
        }

        case "flat_map": {
          if (args.length !== 1) throw new SplError("type", "Iter.flat_map(f) takes 1 arg", callExpr.span);
          const outEl = freshTVar();
          const fnT = checkArg(0, { kind: "TFn", params: [el], ret: tIter(outEl) });
          unify(fnT, { kind: "TFn", params: [el], ret: tIter(outEl) }, args[0].span);
          this.callResolutions.set(callExpr, { kind: "BuiltinMethod", target: "iter_flat_map", receiver: recvExpr });
          return tIter(outEl);
        }

        case "take":
          if (args.length !== 1) throw new SplError("type", "Iter.take(n) takes 1 arg", callExpr.span);
          unify(checkArg(0), TInt, args[0].span);
          this.callResolutions.set(callExpr, { kind: "BuiltinMethod", target: "iter_take", receiver: recvExpr });
          return tIter(el);

        case "skip":
          if (args.length !== 1) throw new SplError("type", "Iter.skip(n) takes 1 arg", callExpr.span);
          unify(checkArg(0), TInt, args[0].span);
          this.callResolutions.set(callExpr, { kind: "BuiltinMethod", target: "iter_skip", receiver: recvExpr });
          return tIter(el);

        case "enumerate":
          if (args.length !== 0) throw new SplError("type", "Iter.enumerate() takes 0 args", callExpr.span);
          this.callResolutions.set(callExpr, { kind: "BuiltinMethod", target: "iter_enumerate", receiver: recvExpr });
          return tIter(tTuple([TInt, el]));

        case "zip": {
          if (args.length !== 1) throw new SplError("type", "Iter.zip(other) takes 1 arg", callExpr.span);
          const otherEl = freshTVar();
          unify(checkArg(0), tIter(otherEl), args[0].span);
          this.callResolutions.set(callExpr, { kind: "BuiltinMethod", target: "iter_zip", receiver: recvExpr });
          return tIter(tTuple([el, otherEl]));
        }

        case "chain":
          if (args.length !== 1) throw new SplError("type", "Iter.chain(other) takes 1 arg", callExpr.span);
          unify(checkArg(0), tIter(el), args[0].span);
          this.callResolutions.set(callExpr, { kind: "BuiltinMethod", target: "iter_chain", receiver: recvExpr });
          return tIter(el);

        case "collect":
        case "to_array":
          if (args.length !== 0) throw new SplError("type", `Iter.${method}() takes 0 args`, callExpr.span);
          this.callResolutions.set(callExpr, { kind: "BuiltinMethod", target: "iter_collect", receiver: recvExpr });
          return tArray(el);

        case "fold": {
          if (args.length !== 2) throw new SplError("type", "Iter.fold(init, f) takes 2 args", callExpr.span);
          const accT = checkArg(0);
          const fnT = checkArg(1, { kind: "TFn", params: [accT, el], ret: accT });
          unify(fnT, { kind: "TFn", params: [accT, el], ret: accT }, args[1].span);
          const cbAsync = this.isExprAsync(args[1].value);
          this.callResolutions.set(callExpr, {
            kind: "BuiltinMethod",
            target: "iter_fold",
            receiver: recvExpr,
            isAsync: cbAsync,
          });
          if (cbAsync) this.markCallAsync(callExpr);
          this.recordCallSite(callExpr, undefined, undefined, args);
          return accT;
        }

        case "for_each": {
          if (args.length !== 1) throw new SplError("type", "Iter.for_each(f) takes 1 arg", callExpr.span);
          const outT = freshTVar();
          const fnT = checkArg(0, { kind: "TFn", params: [el], ret: outT });
          unify(fnT, { kind: "TFn", params: [el], ret: outT }, args[0].span);
          const cbAsync = this.isExprAsync(args[0].value);
          this.callResolutions.set(callExpr, {
            kind: "BuiltinMethod",
            target: "iter_for_each",
            receiver: recvExpr,
            isAsync: cbAsync,
          });
          if (cbAsync) this.markCallAsync(callExpr);
          this.recordCallSite(callExpr, undefined, undefined, args);
          return TUnit;
        }

        case "find": {
          if (args.length !== 1) throw new SplError("type", "Iter.find(pred) takes 1 arg", callExpr.span);
          const fnT = checkArg(0, { kind: "TFn", params: [el], ret: TBool });
          unify(fnT, { kind: "TFn", params: [el], ret: TBool }, args[0].span);
          this.callResolutions.set(callExpr, { kind: "BuiltinMethod", target: "iter_find", receiver: recvExpr });
          return tOption(el);
        }

        case "any":
        case "all": {
          if (args.length !== 1) throw new SplError("type", `Iter.${method}(pred) takes 1 arg`, callExpr.span);
          const fnT = checkArg(0, { kind: "TFn", params: [el], ret: TBool });
          unify(fnT, { kind: "TFn", params: [el], ret: TBool }, args[0].span);
          this.callResolutions.set(callExpr, { kind: "BuiltinMethod", target: `iter_${method}`, receiver: recvExpr });
          return TBool;
        }

        case "count":
          if (args.length !== 0) throw new SplError("type", "Iter.count() takes 0 args", callExpr.span);
          this.callResolutions.set(callExpr, { kind: "BuiltinMethod", target: "iter_count", receiver: recvExpr });
          return TInt;
      }
    }

    // Str methods
    if (recvT.kind === "TPrim" && recvT.name === "Str") {
      switch (method) {
        case "len":
          this.callResolutions.set(callExpr, { kind: "BuiltinMethod", target: "str_len", receiver: recvExpr });
          return TInt;
        case "trim":
        case "to_upper":
        case "to_lower":
          this.callResolutions.set(callExpr, { kind: "BuiltinMethod", target: `str_${method}`, receiver: recvExpr });
          return TStr;
        case "slice":
          unify(checkArg(0), TInt, args[0].span);
          unify(checkArg(1), TInt, args[1].span);
          this.callResolutions.set(callExpr, { kind: "BuiltinMethod", target: "str_slice", receiver: recvExpr });
          return TStr;
        case "split":
          unify(checkArg(0), TStr, args[0].span);
          this.callResolutions.set(callExpr, { kind: "BuiltinMethod", target: "str_split", receiver: recvExpr });
          return tArray(TStr);
        case "starts_with":
        case "ends_with":
        case "contains":
          unify(checkArg(0), TStr, args[0].span);
          this.callResolutions.set(callExpr, { kind: "BuiltinMethod", target: `str_${method}`, receiver: recvExpr });
          return TBool;
        case "index_of":
          unify(checkArg(0), TStr, args[0].span);
          this.callResolutions.set(callExpr, { kind: "BuiltinMethod", target: "str_index_of", receiver: recvExpr });
          return tOption(TInt);
        case "replace":
          unify(checkArg(0), TStr, args[0].span);
          unify(checkArg(1), TStr, args[1].span);
          this.callResolutions.set(callExpr, { kind: "BuiltinMethod", target: "str_replace", receiver: recvExpr });
          return TStr;
        case "chars":
          if (args.length !== 0) throw new SplError("type", "Str.chars() takes 0 args", callExpr.span);
          this.callResolutions.set(callExpr, { kind: "BuiltinMethod", target: "str_chars", receiver: recvExpr });
          return tIter(TChar);
        case "bytes":
          if (args.length !== 0) throw new SplError("type", "Str.bytes() takes 0 args", callExpr.span);
          this.callResolutions.set(callExpr, { kind: "BuiltinMethod", target: "str_bytes", receiver: recvExpr });
          return tIter(TByte);
      }
    }

    // Dict<K, V> methods
    if (recvT.kind === "TDict") {
      switch (method) {
        case "len":
          this.callResolutions.set(callExpr, { kind: "BuiltinMethod", target: "dict_len", receiver: recvExpr });
          return TInt;
        case "get":
          unify(checkArg(0), recvT.key, args[0].span);
          this.callResolutions.set(callExpr, { kind: "BuiltinMethod", target: "dict_get", receiver: recvExpr });
          return tOption(recvT.value);
        case "set":
          unify(checkArg(0), recvT.key, args[0].span);
          unify(checkArg(1), recvT.value, args[1].span);
          this.callResolutions.set(callExpr, { kind: "BuiltinMethod", target: "dict_set", receiver: recvExpr });
          return recvT;
        case "delete":
          unify(checkArg(0), recvT.key, args[0].span);
          this.callResolutions.set(callExpr, { kind: "BuiltinMethod", target: "dict_delete", receiver: recvExpr });
          return recvT;
        case "entries":
          this.callResolutions.set(callExpr, { kind: "BuiltinMethod", target: "dict_entries", receiver: recvExpr });
          return tArray(tTuple([recvT.key, recvT.value]));
        case "iter":
          if (args.length !== 0) throw new SplError("type", "Dict.iter() takes 0 args", callExpr.span);
          this.callResolutions.set(callExpr, { kind: "BuiltinMethod", target: "dict_iter", receiver: recvExpr });
          return tIter(tTuple([recvT.key, recvT.value]));
        case "keys_iter":
          if (args.length !== 0) throw new SplError("type", "Dict.keys_iter() takes 0 args", callExpr.span);
          this.callResolutions.set(callExpr, { kind: "BuiltinMethod", target: "dict_keys_iter", receiver: recvExpr });
          return tIter(recvT.key);
        case "values_iter":
          if (args.length !== 0) throw new SplError("type", "Dict.values_iter() takes 0 args", callExpr.span);
          this.callResolutions.set(callExpr, { kind: "BuiltinMethod", target: "dict_values_iter", receiver: recvExpr });
          return tIter(recvT.value);
      }
    }

    // Option<T> methods
    if (recvT.kind === "TEnum" && recvT.name === "Option") {
      const inner = recvT.typeArgs[0];
      switch (method) {
        case "unwrap_or":
          unify(checkArg(0), inner, args[0].span);
          this.callResolutions.set(callExpr, { kind: "BuiltinMethod", target: "option_unwrap_or", receiver: recvExpr });
          return inner;
        case "map": {
          const outT = freshTVar();
          unify(checkArg(0), { kind: "TFn", params: [inner], ret: outT }, args[0].span);
          this.callResolutions.set(callExpr, { kind: "BuiltinMethod", target: "option_map", receiver: recvExpr });
          return tOption(outT);
        }
        case "is_some":
        case "is_none":
          this.callResolutions.set(callExpr, { kind: "BuiltinMethod", target: `option_${method}`, receiver: recvExpr });
          return TBool;
      }
    }

    // Result<T, E> methods
    if (recvT.kind === "TEnum" && recvT.name === "Result") {
      const [okT, errT] = recvT.typeArgs;
      switch (method) {
        case "unwrap_or":
          unify(checkArg(0), okT, args[0].span);
          this.callResolutions.set(callExpr, { kind: "BuiltinMethod", target: "result_unwrap_or", receiver: recvExpr });
          return okT;
        case "is_ok":
        case "is_err":
          this.callResolutions.set(callExpr, { kind: "BuiltinMethod", target: `result_${method}`, receiver: recvExpr });
          return TBool;
        case "map": {
          const outT = freshTVar();
          unify(checkArg(0), { kind: "TFn", params: [okT], ret: outT }, args[0].span);
          this.callResolutions.set(callExpr, { kind: "BuiltinMethod", target: "result_map", receiver: recvExpr });
          return tResult(outT, errT);
        }
      }
    }

    // Prompt methods
    if (recvT.kind === "TPrim" && recvT.name === "Prompt") {
      if (method === "render") {
        this.callResolutions.set(callExpr, { kind: "BuiltinMethod", target: "prompt_render", receiver: recvExpr });
        return TStr;
      }
    }

    // Built-in `show()` fallback for primitives implementing Show
    if (method === "show" && args.length === 0) {
      if (recvT.kind === "TPrim") {
        this.callResolutions.set(callExpr, { kind: "BuiltinMethod", target: "prim_show", receiver: recvExpr });
        return TStr;
      }
    }

    return undefined;
  }

  // ==================== Match & Patterns ====================

  private checkMatchExpr(expr: Extract<Expr, { kind: "MatchExpr" }>, scope: Scope): Type {
    const subjT = this.checkExpr(expr.subject, scope);
    const resultT = freshTVar();

    for (const arm of expr.arms) {
      const armScope: Scope = { vars: new Map(), parent: scope };
      this.bindPattern(arm.pattern, subjT, false, armScope, false);
      if (arm.guard) {
        const gT = this.checkExpr(arm.guard, armScope);
        unify(gT, TBool, arm.guard.span);
      }
      const bodyT = this.checkExpr(arm.body, armScope);
      unify(resultT, bodyT, arm.body.span);
    }

    // Exhaustiveness check
    this.checkExhaustiveness(prune(subjT), expr);

    return resultT;
  }

  private checkExhaustiveness(subjT: Type, expr: Extract<Expr, { kind: "MatchExpr" }>): void {
    const hasUnguardedCatchAll = expr.arms.some(
      (a) =>
        !a.guard &&
        (a.pattern.kind === "WildcardPattern" || a.pattern.kind === "IdentPattern")
    );
    if (hasUnguardedCatchAll) return;

    if (subjT.kind === "TEnum") {
      const covered = new Set<string>();
      for (const arm of expr.arms) {
        if (!arm.guard && arm.pattern.kind === "EnumPattern") {
          covered.add(arm.pattern.variant);
        }
      }
      const missing = Array.from(subjT.variants.keys()).filter((v) => !covered.has(v));
      if (missing.length > 0) {
        throw new SplError(
          "type",
          `Non-exhaustive match on enum '${subjT.name}': missing variant(s) ${missing.join(", ")}`,
          expr.span
        );
      }
      return;
    }

    if (subjT.kind === "TPrim" && subjT.name === "Bool") {
      let hasTrue = false;
      let hasFalse = false;
      for (const arm of expr.arms) {
        if (!arm.guard && arm.pattern.kind === "LiteralPattern" && arm.pattern.literalType === "Bool") {
          if (arm.pattern.value === true) hasTrue = true;
          if (arm.pattern.value === false) hasFalse = true;
        }
      }
      if (!hasTrue || !hasFalse) {
        throw new SplError("type", "Non-exhaustive match on Bool: must cover both `true` and `false`", expr.span);
      }
      return;
    }

    if (subjT.kind === "TArray") {
      const exactLengths = new Set<number>();
      let minRestLen = Infinity;
      for (const arm of expr.arms) {
        if (arm.guard || arm.pattern.kind !== "ArrayPattern") continue;
        if (!arm.pattern.elements.every((e) => this.isIrrefutablePattern(e))) continue;
        if (arm.pattern.rest) {
          minRestLen = Math.min(minRestLen, arm.pattern.elements.length);
        } else {
          exactLengths.add(arm.pattern.elements.length);
        }
      }
      if (Number.isFinite(minRestLen)) {
        let allCovered = true;
        for (let k = 0; k < minRestLen; k++) {
          if (!exactLengths.has(k)) {
            allCovered = false;
            break;
          }
        }
        if (allCovered) return;
      }
    }

    if (subjT.kind === "TNewtype") {
      const hasIrrefutableNewtype = expr.arms.some(
        (a) =>
          !a.guard &&
          a.pattern.kind === "EnumPattern" &&
          a.pattern.variant === subjT.name &&
          a.pattern.fields.length === 1 &&
          this.isIrrefutablePattern(a.pattern.fields[0])
      );
      if (hasIrrefutableNewtype) return;
    }

    if (subjT.kind === "TRecord" || subjT.kind === "TTuple") {
      // A single irrefutable record/tuple destructuring covers it if all nested patterns are irrefutable
      const hasIrrefutable = expr.arms.some((a) => !a.guard && this.isIrrefutablePattern(a.pattern));
      if (hasIrrefutable) return;
    }

    throw new SplError(
      "type",
      `Non-exhaustive match on ${formatType(subjT)}: add a wildcard \`_\` arm`,
      expr.span
    );
  }

  private isIrrefutablePattern(p: Pattern): boolean {
    switch (p.kind) {
      case "WildcardPattern":
      case "IdentPattern":
        return true;
      case "TuplePattern":
        return p.elements.every((e) => this.isIrrefutablePattern(e));
      case "RecordPattern":
        return p.fields.every((f) => this.isIrrefutablePattern(f.pattern));
      default:
        return false;
    }
  }

  private bindPattern(
    pat: Pattern,
    expectedType: Type,
    mutable: boolean,
    scope: Scope,
    generalizeBindings: boolean
  ): void {
    const t = prune(expectedType);

    switch (pat.kind) {
      case "WildcardPattern":
        return;

      case "IdentPattern": {
        const scheme =
          generalizeBindings && !mutable
            ? this.generalize(expectedType, scope)
            : { quantifiedTypeVars: [], quantifiedRowVars: [], type: expectedType };
        scope.vars.set(pat.name, { scheme, mutable, defSpan: pat.span, symKind: "var" });
        this.symbols.push({
          name: pat.name,
          kind: "var",
          type: expectedType,
          span: pat.span,
          scopeSpan: scope === this.rootScope ? undefined : this.currentFnNode && "body" in this.currentFnNode ? this.currentFnNode.body.span : undefined,
        });
        return;
      }

      case "LiteralPattern": {
        const litT =
          pat.literalType === "Int" ? TInt
          : pat.literalType === "Float" ? TFloat
          : pat.literalType === "Str" ? TStr
          : pat.literalType === "Char" ? TChar
          : TBool;
        unify(expectedType, litT, pat.span);
        return;
      }

      case "TuplePattern": {
        const elVars = pat.elements.map(() => freshTVar());
        unify(expectedType, tTuple(elVars), pat.span);
        for (let i = 0; i < pat.elements.length; i++) {
          this.bindPattern(pat.elements[i], elVars[i], mutable, scope, generalizeBindings);
        }
        return;
      }

      case "ArrayPattern": {
        const elT = freshTVar();
        unify(expectedType, tArray(elT), pat.span);
        for (const el of pat.elements) {
          this.bindPattern(el, elT, mutable, scope, generalizeBindings);
        }
        if (pat.rest && pat.rest !== "_") {
          scope.vars.set(pat.rest, {
            scheme: { quantifiedTypeVars: [], quantifiedRowVars: [], type: tArray(elT) },
            mutable,
          });
        }
        return;
      }

      case "RecordPattern": {
        const pFields = new Map<string, Type>();
        for (const f of pat.fields) {
          pFields.set(f.name, freshTVar());
        }
        const tail: RowTail = pat.hasRest ? freshRVar() : { kind: "RClosed" };
        unify(expectedType, { kind: "TRecord", fields: pFields, tail }, pat.span);
        for (const f of pat.fields) {
          this.bindPattern(f.pattern, pFields.get(f.name)!, mutable, scope, generalizeBindings);
        }
        if (pat.restName && pat.restName !== "_") {
          scope.vars.set(pat.restName, {
            scheme: {
              quantifiedTypeVars: [],
              quantifiedRowVars: [],
              type: { kind: "TRecord", fields: new Map(), tail },
            },
            mutable,
          });
        }
        return;
      }

      case "EnumPattern": {
        // 0. Check if this pattern destructures a `newtype`: `UserId(raw)` or `mod.UserId(raw)`
        let ntDef: NewtypeDef | undefined;
        let ntCtxMod: ModuleExports | undefined;
        if (pat.enumName && this.namespaces.has(pat.enumName)) {
          const mod = this.namespaces.get(pat.enumName)!;
          ntDef = mod.newtypes?.get(pat.variant);
          ntCtxMod = mod;
        } else if (!pat.enumName) {
          ntDef = this.newtypes.get(pat.variant);
        }
        if (ntDef) {
          if (pat.fields.length !== 1) {
            throw new SplError(
              "type",
              `Newtype pattern '${pat.variant}' expects 1 inner pattern, found ${pat.fields.length}`,
              pat.span
            );
          }
          const tpMap = new Map<string, Type>();
          const typeArgs: Type[] = [];
          for (const tp of ntDef.typeParams) {
            const tv = freshTVar();
            tpMap.set(tp, tv);
            typeArgs.push(tv);
          }
          const underlying = this.resolveTypeExpr(ntDef.body, tpMap, new Set(), ntCtxMod);
          const instNt: Type = {
            kind: "TNewtype",
            name: ntDef.name,
            moduleFile: ntDef.moduleFile,
            typeArgs,
            underlying,
            doc: ntDef.doc,
            llmHint: ntDef.llmHint,
          };
          unify(expectedType, instNt, pat.span);
          this.newtypePatterns.add(pat);
          this.bindPattern(pat.fields[0], underlying, mutable, scope, generalizeBindings);
          return;
        }

        let enumName: string | undefined;
        let enumDef: EnumDef | undefined;

        // 1. Namespace-qualified enum variant pattern: `llm.ThinkingDelta(t)`
        if (pat.enumName && this.namespaces.has(pat.enumName)) {
          const mod = this.namespaces.get(pat.enumName)!;
          for (const [eName, eDef] of mod.enums) {
            if (eDef.variants.has(pat.variant)) {
              enumName = eName;
              enumDef = eDef;
              break;
            }
          }
          if (!enumDef) {
            throw new SplError("type", `Module '${pat.enumName}' has no enum variant '${pat.variant}'`, pat.span);
          }
        } else {
          enumName = pat.enumName ?? this.variantToEnum.get(pat.variant);
          enumDef = enumName ? this.enums.get(enumName) : undefined;
        }

        // 2. If expectedType is already a matching TEnum (covers both contextual unqualified variants
        //    like `SummaryDelta(s)` and namespace-qualified variants whose field types come from another module)
        const exp = prune(expectedType);
        if (exp.kind === "TEnum" && (!enumName || exp.name === enumName) && exp.variants.has(pat.variant)) {
          const vInfo = exp.variants.get(pat.variant)!;
          if (vInfo.fields.length !== pat.fields.length) {
            throw new SplError(
              "type",
              `Variant '${pat.variant}' expects ${vInfo.fields.length} field(s), pattern has ${pat.fields.length}`,
              pat.span
            );
          }
          for (let i = 0; i < pat.fields.length; i++) {
            this.bindPattern(pat.fields[i], vInfo.fields[i], mutable, scope, generalizeBindings);
          }
          return;
        }

        if (!enumName) {
          throw new SplError("type", `Unknown enum variant '${pat.variant}'`, pat.span);
        }
        if (!enumDef) {
          throw new SplError("type", `Unknown enum '${enumName}'`, pat.span);
        }
        const vDef = enumDef.variants.get(pat.variant);
        if (!vDef) {
          throw new SplError("type", `Enum '${enumName}' has no variant '${pat.variant}'`, pat.span);
        }
        if (vDef.fields.length !== pat.fields.length) {
          throw new SplError(
            "type",
            `Variant '${pat.variant}' expects ${vDef.fields.length} field(s), pattern has ${pat.fields.length}`,
            pat.span
          );
        }

        const tpMap = new Map<string, Type>();
        for (const tp of enumDef.typeParams) tpMap.set(tp, freshTVar());
        const resolving = new Set<string>([enumName]);
        const variants = new Map<string, EnumVariantType>();
        for (const [vn, vd] of enumDef.variants) {
          variants.set(vn, {
            fields: vd.fields.map((f) => this.resolveTypeExpr(f, tpMap, resolving)),
            doc: vd.doc,
            llmHint: vd.llmHint,
          });
        }
        const instEnum: Type = {
          kind: "TEnum",
          name: enumName,
          typeArgs: enumDef.typeParams.map((tp) => tpMap.get(tp)!),
          variants,
          doc: enumDef.doc,
        };
        unify(expectedType, instEnum, pat.span);

        const fieldTypes = variants.get(pat.variant)!.fields;
        for (let i = 0; i < pat.fields.length; i++) {
          this.bindPattern(pat.fields[i], fieldTypes[i], mutable, scope, generalizeBindings);
        }
        return;
      }
    }
  }

  private assertNoErasedTypeParams(t: Type, exprName: string, span: Span, seen = new Set<number>()): void {
    const p = prune(t);
    if (p.kind === "TVar") {
      if (seen.has(p.id)) return;
      seen.add(p.id);
      const isReified = this.activeReifiedParams.some((rt) => {
        const pr = prune(rt);
        return pr.kind === "TVar" && pr.id === p.id;
      });
      if (!isReified) {
        for (const [tpName, tpType] of this.activeTypeParams) {
          const pp = prune(tpType);
          if (pp.kind === "TVar" && pp.id === p.id) {
            throw new SplError(
              "type",
              `Type parameter '${tpName}' is erased at runtime; mark the enclosing function 'reified fn' to use ${exprName}`,
              span
            );
          }
        }
      }
      return;
    }
    if (p.kind === "TArray" || p.kind === "TIter") {
      this.assertNoErasedTypeParams(p.element, exprName, span, seen);
    } else if (p.kind === "TDict") {
      this.assertNoErasedTypeParams(p.key, exprName, span, seen);
      this.assertNoErasedTypeParams(p.value, exprName, span, seen);
    } else if (p.kind === "TTuple") {
      for (const el of p.elements) this.assertNoErasedTypeParams(el, exprName, span, seen);
    } else if (p.kind === "TRecord") {
      const flat = flattenRecord(p);
      for (const ft of flat.fields.values()) this.assertNoErasedTypeParams(ft, exprName, span, seen);
      if (flat.tail.kind === "ROpenDict") {
        this.assertNoErasedTypeParams(flat.tail.valueType, exprName, span, seen);
      }
    } else if (p.kind === "TEnum") {
      for (const ta of p.typeArgs) this.assertNoErasedTypeParams(ta, exprName, span, seen);
    }
  }

  private getRootIdent(expr: Expr): Extract<Expr, { kind: "IdentExpr" }> | undefined {
    let cur: Expr = expr;
    while (cur.kind === "MemberExpr") {
      cur = cur.object;
    }
    return cur.kind === "IdentExpr" ? cur : undefined;
  }

  private assertMutableReceiver(receiver: Expr, method: string, scope: Scope, span: Span): void {
    const root = this.getRootIdent(receiver);
    if (!root) return;
    const b = this.lookupVar(root.name, scope);
    if (b && !b.mutable) {
      const hint =
        root.name === "self"
          ? "use 'mut self' in the method signature"
          : `declare with 'let mut ${root.name}' or 'mut ${root.name}'`;
      throw new SplError("type", `Cannot call 'mut self' method '${method}' on immutable '${root.name}' (${hint})`, span);
    }
  }

  // ==================== Trait & Extension Lookup ====================

  private findExtensionMethod(recvT: Type, method: string): ExtensionMethodInfo | undefined {
    for (const ext of this.extensions) {
      if (ext.name !== method) continue;
      if (this.matchesReceiverShape(ext.receiverType, recvT)) {
        return ext;
      }
    }
    return undefined;
  }

  private findTraitMethodForType(
    recvT: Type,
    method: string
  ): { fnType: Type; jsSymbol: string; isAsync: boolean; mutSelf?: boolean } | undefined {
    const key = canonicalShapeKey(recvT);
    for (const impl of this.traitImpls) {
      if (impl.shapeKey === key && impl.methods.has(method)) {
        return impl.methods.get(method);
      }
    }
    return undefined;
  }

  private findTraitImpl(traitName: string, t: Type): TraitImplInfo | undefined {
    const key = canonicalShapeKey(t);
    return this.traitImpls.find((i) => i.traitName === traitName && i.shapeKey === key);
  }

  private checkTraitBounds(paramT: Type, argT: Type, span: Span): void {
    const p = prune(paramT);
    const a = prune(argT);
    if (p.kind !== "TVar" || p.bounds.length === 0 || a.kind === "TVar") return;

    for (const bound of p.bounds) {
      if (bound === "Show" || bound === "Eq" || bound === "Ord" || bound === "Add") {
        if (a.kind === "TPrim" && (a.name === "Int" || a.name === "Float" || a.name === "Str" || a.name === "Bool" || a.name === "Char")) {
          continue;
        }
      }
      if (!this.findTraitImpl(bound, a)) {
        throw new SplError("type", `Type ${formatType(a)} does not implement trait '${bound}'`, span);
      }
    }
  }

  private matchesReceiverShape(patternType: Type, actualType: Type): boolean {
    if (prune(actualType).kind === "TVar") return false;
    // Try unifying a fresh clone of patternType with a fresh clone of actualType
    const cloneP = instantiate(this.generalize(patternType, this.rootScope));
    const cloneA = cloneWithSubst(actualType, new Map(), new Map());
    try {
      unify(cloneP, cloneA);
      return true;
    } catch {
      return false;
    }
  }

  // ==================== Type Resolution ====================

  private resolveTypeExpr(
    te: TypeExpr,
    tpMap: Map<string, Type>,
    resolvingEnums = new Set<string>(),
    contextMod?: ModuleExports,
    scope: Scope = this.currentScope
  ): Type {
    switch (te.kind) {
      case "TypeofTypeExpr": {
        const root = this.getRootIdent(te.expr);
        if (root && !this.lookupVar(root.name, scope)) {
          const topLet = this.topLevelLets.get(root.name);
          if (topLet && !this.checkedTopLets.has(topLet)) {
            this.checkedTopLets.add(topLet);
            this.checkLetStmt(topLet, this.rootScope);
          }
        }
        const prevAsync = this.currentFnBecameAsync;
        const t = prune(this.checkExpr(te.expr, scope));
        this.currentFnBecameAsync = prevAsync;
        return t;
      }

      case "OptionTypeExpr":
        return tOption(this.resolveTypeExpr(te.inner, tpMap, resolvingEnums, contextMod, scope));

      case "TupleTypeExpr":
        if (te.elements.length === 0) return TUnit;
        return tTuple(te.elements.map((e) => this.resolveTypeExpr(e, tpMap, resolvingEnums, contextMod, scope)));

      case "FnTypeExpr":
        return {
          kind: "TFn",
          params: te.params.map((p) => this.resolveTypeExpr(p, tpMap, resolvingEnums, contextMod, scope)),
          ret: this.resolveTypeExpr(te.returnType, tpMap, resolvingEnums, contextMod, scope),
          isAsync: te.isAsync,
        };

      case "RecordTypeExpr": {
        const fields = new Map<string, Type>();
        const fieldDocs = new Map<string, string>();
        const fieldHints = new Map<string, string>();
        for (const f of te.fields) {
          fields.set(f.name, this.resolveTypeExpr(f.type, tpMap, resolvingEnums, contextMod, scope));
          if (f.doc) fieldDocs.set(f.name, f.doc);
          if (f.llmHint) fieldHints.set(f.name, f.llmHint);
        }
        let tail: RowTail;
        if (te.tail.kind === "Closed") {
          tail = { kind: "RClosed" };
        } else if (te.tail.kind === "OpenVar") {
          tail = freshRVar();
        } else {
          tail = {
            kind: "ROpenDict",
            valueType: this.resolveTypeExpr(te.tail.valueType, tpMap, resolvingEnums, contextMod, scope),
            extraName: te.tail.name,
            doc: te.tail.doc,
            llmHint: te.tail.llmHint,
          };
        }
        return { kind: "TRecord", fields, tail, meta: { fieldDocs, fieldHints } };
      }

      case "NamedTypeExpr": {
        if (tpMap.has(te.name)) return tpMap.get(te.name)!;
        if (this.activeTypeParams.has(te.name)) return this.activeTypeParams.get(te.name)!;

        // Module-qualified type name e.g. `llm.AgentTool` or `col.HashMap<Str, Int>`
        if (te.name.includes(".")) {
          const [nsAlias, memberName] = te.name.split(".");
          const nsMod = this.namespaces.get(nsAlias);
          if (!nsMod) {
            throw new SplError("type", `Unknown module namespace '${nsAlias}' in type '${te.name}'`, te.span);
          }
          const td = nsMod.types.get(memberName);
          if (td) {
            if (td.typeParams.length !== te.typeArgs.length) {
              throw new SplError("type", `Type '${te.name}' expects ${td.typeParams.length} type arg(s)`, te.span);
            }
            const sub = new Map<string, Type>();
            for (let i = 0; i < td.typeParams.length; i++) {
              sub.set(td.typeParams[i], this.resolveTypeExpr(te.typeArgs[i], tpMap, resolvingEnums, contextMod));
            }
            const resolved = this.resolveTypeExpr(td.body, sub, resolvingEnums, nsMod);
            if (resolved.kind === "TRecord") {
              resolved.meta = {
                typeName: td.name,
                doc: td.doc,
                llmHint: td.llmHint,
                fieldDocs: resolved.meta?.fieldDocs ?? new Map(),
                fieldHints: resolved.meta?.fieldHints ?? new Map(),
              };
            }
            return resolved;
          }
          const nt = nsMod.newtypes?.get(memberName);
          if (nt) {
            if (nt.typeParams.length !== te.typeArgs.length) {
              throw new SplError("type", `Newtype '${te.name}' expects ${nt.typeParams.length} type arg(s)`, te.span);
            }
            const sub = new Map<string, Type>();
            const resolvedArgs: Type[] = [];
            for (let i = 0; i < nt.typeParams.length; i++) {
              const argT = this.resolveTypeExpr(te.typeArgs[i], tpMap, resolvingEnums, contextMod, scope);
              sub.set(nt.typeParams[i], argT);
              resolvedArgs.push(argT);
            }
            const underlying = this.resolveTypeExpr(nt.body, sub, resolvingEnums, nsMod, scope);
            return {
              kind: "TNewtype",
              name: nt.name,
              moduleFile: nt.moduleFile,
              typeArgs: resolvedArgs,
              underlying,
              doc: nt.doc,
              llmHint: nt.llmHint,
            };
          }
          const ed = nsMod.enums.get(memberName);
          if (ed) {
            if (ed.typeParams.length !== te.typeArgs.length) {
              throw new SplError("type", `Enum '${te.name}' expects ${ed.typeParams.length} type arg(s)`, te.span);
            }
            const sub = new Map<string, Type>();
            const resolvedArgs: Type[] = [];
            for (let i = 0; i < ed.typeParams.length; i++) {
              const argT = this.resolveTypeExpr(te.typeArgs[i], tpMap, resolvingEnums, contextMod);
              sub.set(ed.typeParams[i], argT);
              resolvedArgs.push(argT);
            }
            if (resolvingEnums.has(ed.name)) {
              return { kind: "TEnum", name: ed.name, typeArgs: resolvedArgs, variants: new Map(), doc: ed.doc, llmHint: ed.llmHint };
            }
            const nextResolving = new Set(resolvingEnums);
            nextResolving.add(ed.name);
            const variants = new Map<string, EnumVariantType>();
            for (const [vn, vd] of ed.variants) {
              variants.set(vn, {
                fields: vd.fields.map((f) => this.resolveTypeExpr(f, sub, nextResolving, nsMod)),
                doc: vd.doc,
                llmHint: vd.llmHint,
              });
            }
            return { kind: "TEnum", name: ed.name, typeArgs: resolvedArgs, variants, doc: ed.doc, llmHint: ed.llmHint };
          }
          throw new SplError("type", `Module '${nsAlias}' exports no type '${memberName}'`, te.span);
        }

        switch (te.name) {
          case "Int": return TInt;
          case "Float": return TFloat;
          case "Str":
          case "String": return TStr;
          case "Bool":
          case "Boolean": return TBool;
          case "Char": return TChar;
          case "Byte": return TByte;
          case "Bytes": return TBytes;
          case "Json": return TJson;
          case "Prompt": return TPrompt;
          case "Unit":
          case "Void": return TUnit;
          case "TypeInfo": return TTypeInfo;
          case "TypeFieldInfo": return TTypeFieldInfo;
          case "TypeVariantInfo": return TTypeVariantInfo;
          case "Array":
            if (te.typeArgs.length !== 1) throw new SplError("type", "Array<T> requires 1 type argument", te.span);
            return tArray(this.resolveTypeExpr(te.typeArgs[0], tpMap, resolvingEnums, contextMod));
          case "Iter":
            if (te.typeArgs.length !== 1) throw new SplError("type", "Iter<T> requires 1 type argument", te.span);
            return tIter(this.resolveTypeExpr(te.typeArgs[0], tpMap, resolvingEnums, contextMod));
          case "Dict":
            if (te.typeArgs.length !== 2) throw new SplError("type", "Dict<K, V> requires 2 type arguments", te.span);
            return tDict(
              this.resolveTypeExpr(te.typeArgs[0], tpMap, resolvingEnums, contextMod),
              this.resolveTypeExpr(te.typeArgs[1], tpMap, resolvingEnums, contextMod)
            );
          case "Option":
            if (te.typeArgs.length !== 1) throw new SplError("type", "Option<T> requires 1 type argument", te.span);
            return tOption(this.resolveTypeExpr(te.typeArgs[0], tpMap, resolvingEnums, contextMod));
          case "Result":
            if (te.typeArgs.length !== 2) throw new SplError("type", "Result<T, E> requires 2 type arguments", te.span);
            return tResult(
              this.resolveTypeExpr(te.typeArgs[0], tpMap, resolvingEnums, contextMod),
              this.resolveTypeExpr(te.typeArgs[1], tpMap, resolvingEnums, contextMod)
            );
        }

        // User-defined `type` alias / struct (check current module or imported context module)
        const td = this.types.get(te.name) ?? contextMod?.types.get(te.name);
        if (td) {
          if (td.typeParams.length !== te.typeArgs.length) {
            throw new SplError("type", `Type '${te.name}' expects ${td.typeParams.length} type arg(s)`, te.span);
          }
          const sub = new Map<string, Type>();
          for (let i = 0; i < td.typeParams.length; i++) {
            sub.set(td.typeParams[i], this.resolveTypeExpr(te.typeArgs[i], tpMap, resolvingEnums, contextMod));
          }
          const resolved = this.resolveTypeExpr(td.body, sub, resolvingEnums, contextMod);
          if (resolved.kind === "TRecord") {
            resolved.meta = {
              typeName: td.name,
              doc: td.doc,
              llmHint: td.llmHint,
              fieldDocs: resolved.meta?.fieldDocs ?? new Map(),
              fieldHints: resolved.meta?.fieldHints ?? new Map(),
            };
          }
          return resolved;
        }

        // User-defined nominal `newtype`
        const nt = this.newtypes.get(te.name) ?? contextMod?.newtypes?.get(te.name);
        if (nt) {
          if (nt.typeParams.length !== te.typeArgs.length) {
            throw new SplError("type", `Newtype '${te.name}' expects ${nt.typeParams.length} type arg(s)`, te.span);
          }
          const sub = new Map<string, Type>();
          const resolvedArgs: Type[] = [];
          for (let i = 0; i < nt.typeParams.length; i++) {
            const argT = this.resolveTypeExpr(te.typeArgs[i], tpMap, resolvingEnums, contextMod, scope);
            sub.set(nt.typeParams[i], argT);
            resolvedArgs.push(argT);
          }
          const underlying = this.resolveTypeExpr(nt.body, sub, resolvingEnums, contextMod, scope);
          return {
            kind: "TNewtype",
            name: nt.name,
            moduleFile: nt.moduleFile,
            typeArgs: resolvedArgs,
            underlying,
            doc: nt.doc,
            llmHint: nt.llmHint,
          };
        }

        // User-defined `enum` (supports recursive generic ADTs like `TreeNode<T>`)
        const ed = this.enums.get(te.name) ?? contextMod?.enums.get(te.name);
        if (ed) {
          if (ed.typeParams.length !== te.typeArgs.length) {
            throw new SplError("type", `Enum '${te.name}' expects ${ed.typeParams.length} type arg(s)`, te.span);
          }
          const sub = new Map<string, Type>();
          const resolvedArgs: Type[] = [];
          for (let i = 0; i < ed.typeParams.length; i++) {
            const argT = this.resolveTypeExpr(te.typeArgs[i], tpMap, resolvingEnums, contextMod);
            sub.set(ed.typeParams[i], argT);
            resolvedArgs.push(argT);
          }
          if (resolvingEnums.has(ed.name)) {
            return {
              kind: "TEnum",
              name: ed.name,
              typeArgs: resolvedArgs,
              variants: new Map(),
              doc: ed.doc,
              llmHint: ed.llmHint,
            };
          }
          const nextResolving = new Set(resolvingEnums);
          nextResolving.add(ed.name);
          const variants = new Map<string, EnumVariantType>();
          for (const [vn, vd] of ed.variants) {
            variants.set(vn, {
              fields: vd.fields.map((f) => this.resolveTypeExpr(f, sub, nextResolving, contextMod)),
              doc: vd.doc,
              llmHint: vd.llmHint,
            });
          }
          return {
            kind: "TEnum",
            name: ed.name,
            typeArgs: resolvedArgs,
            variants,
            doc: ed.doc,
            llmHint: ed.llmHint,
          };
        }

        throw new SplError("type", `Unknown type '${te.name}'`, te.span);
      }
    }
  }

  // ==================== Scope & Generalization ====================

  private lookupVar(name: string, scope: Scope): VarBinding | undefined {
    let cur: Scope | undefined = scope;
    while (cur) {
      const found = cur.vars.get(name);
      if (found) return found;
      cur = cur.parent;
    }
    return undefined;
  }

  private generalize(t: Type, scope: Scope): TypeScheme {
    const envT = new Set<number>();
    const envR = new Set<number>();
    let cur: Scope | undefined = scope;
    while (cur && cur !== this.rootScope) {
      for (const b of cur.vars.values()) {
        const fv = collectFreeVars(b.scheme.type);
        for (const id of fv.tVars) if (!b.scheme.quantifiedTypeVars.includes(id)) envT.add(id);
        for (const id of fv.rVars) if (!b.scheme.quantifiedRowVars.includes(id)) envR.add(id);
      }
      cur = cur.parent;
    }
    const { tVars, rVars } = collectFreeVars(t);
    const quantifiedTypeVars = Array.from(tVars).filter((id) => !envT.has(id));
    const quantifiedRowVars = Array.from(rVars).filter((id) => !envR.has(id));
    return { quantifiedTypeVars, quantifiedRowVars, type: t };
  }

  // ==================== Transparent (Colorless) Async Inference ====================

  private markCallAsync(callExpr: Expr): void {
    this.asyncCalls.add(callExpr);
    if (this.currentFnNode) {
      this.currentFnBecameAsync = true;
      this.asyncFns.add(this.currentFnNode);
    }
  }

  private recordCallSite(callExpr: Expr, calleeName: string | undefined, calleeExpr: Expr | undefined, args: CallArg[]): void {
    const hofArgExprs = args.map((a) => a.value);
    this.callSites.set(callExpr, { caller: this.currentFnNode, calleeName, calleeExpr, hofArgExprs });
    if (this.currentFnNode && calleeName) {
      let set = this.callEdges.get(this.currentFnNode);
      if (!set) {
        set = new Set();
        this.callEdges.set(this.currentFnNode, set);
      }
      set.add(calleeName);
    }
  }

  private isExprAsync(expr: Expr): boolean {
    if (expr.kind === "LambdaExpr") return this.asyncFns.has(expr);
    if (expr.kind === "IdentExpr") return this.asyncFnNames.has(expr.name);
    return false;
  }

  private propagateAsync(): void {
    let changed = true;
    while (changed) {
      changed = false;
      for (const [callExpr, site] of this.callSites) {
        let shouldBeAsync = this.asyncCalls.has(callExpr);

        if (!shouldBeAsync && site.calleeName && this.asyncFnNames.has(site.calleeName)) {
          shouldBeAsync = true;
        }
        if (!shouldBeAsync) {
          for (const arg of site.hofArgExprs) {
            if (this.isExprAsync(arg)) {
              const res = this.callResolutions.get(callExpr);
              if (res && res.kind === "BuiltinMethod") {
                res.isAsync = true;
                shouldBeAsync = true;
              }
            }
          }
        }

        if (shouldBeAsync && !this.asyncCalls.has(callExpr)) {
          this.asyncCalls.add(callExpr);
          changed = true;
        }

        if (shouldBeAsync && site.caller && !this.asyncFns.has(site.caller)) {
          this.asyncFns.add(site.caller);
          // Also mark its name if it's a named FnDecl
          for (const [name, decl] of this.fnDeclsByName) {
            if (decl === site.caller && !this.asyncFnNames.has(name)) {
              this.asyncFnNames.add(name);
            }
          }
          changed = true;
        }
      }
    }
  }

  // ==================== Universal Automatic Reification Propagation ====================

  private recordFnReifiedTypeUse(fn: FnDecl | undefined, type: Type): void {
    if (!fn) return;
    let list = this.fnDirectReifiedTypes.get(fn);
    if (!list) {
      list = [];
      this.fnDirectReifiedTypes.set(fn, list);
    }
    list.push(type);
  }

  private getFnScheme(fn: FnDecl): TypeScheme | undefined {
    if (fn.receiverType) {
      const sym = this.extensionJsSymbols.get(fn);
      const ext = sym ? this.extensions.find((e) => e.jsSymbol === sym) : undefined;
      return ext?.scheme;
    }
    return this.fnBindings.get(fn)?.scheme;
  }

  private propagateReification(): void {
    // Build map of all local FnDecls -> their available quantified TVar IDs
    const allFns = new Set<FnDecl>();
    for (const fn of this.fnBindings.keys()) allFns.add(fn);
    for (const fn of this.extFnDecls.values()) allFns.add(fn);

    const fnQuantIds = new Map<FnDecl, Set<number>>();
    const fnNeededIds = new Map<FnDecl, Set<number>>();

    for (const fn of allFns) {
      const scheme = this.getFnScheme(fn);
      const qSet = new Set<number>(scheme?.quantifiedTypeVars ?? []);
      const explicitTvs = this.fnExplicitTypeParams.get(fn) ?? [];
      for (const tv of explicitTvs) {
        const p = prune(tv);
        if (p.kind === "TVar") qSet.add(p.id);
      }
      fnQuantIds.set(fn, qSet);

      const needed = new Set<number>();
      if (fn.reified) {
        for (const tv of explicitTvs) {
          const p = prune(tv);
          if (p.kind === "TVar") needed.add(p.id);
        }
      }
      const directTypes = this.fnDirectReifiedTypes.get(fn) ?? [];
      for (const dt of directTypes) {
        const fv = collectFreeVars(dt);
        for (const id of fv.tVars) {
          if (qSet.has(id)) needed.add(id);
        }
      }
      fnNeededIds.set(fn, needed);
    }

    // Fixed-point propagation across call sites and first-class function refs
    let changed = true;
    while (changed) {
      changed = false;
      for (const site of this.reifiedCallSites) {
        if (!site.callerFn) continue;
        const callerQ = fnQuantIds.get(site.callerFn);
        const callerNeeded = fnNeededIds.get(site.callerFn);
        if (!callerQ || !callerNeeded) continue;

        const passedTypes: Type[] = [];
        if (site.fixedReifiedTypes) {
          passedTypes.push(...site.fixedReifiedTypes);
        }
        if (site.targetFn) {
          const targetNeeded = fnNeededIds.get(site.targetFn);
          if (targetNeeded && targetNeeded.size > 0) {
            for (const tid of targetNeeded) {
              const mapped = site.instantiationMap?.get(tid);
              if (mapped) passedTypes.push(mapped);
              else passedTypes.push({ kind: "TVar", id: tid, bounds: [] });
            }
          }
        }

        for (const pt of passedTypes) {
          const fv = collectFreeVars(pt);
          for (const id of fv.tVars) {
            if (callerQ.has(id) && !callerNeeded.has(id)) {
              callerNeeded.add(id);
              changed = true;
            }
          }
        }
      }
    }

    // Finalize ordered reified param lists for every FnDecl that needs runtime type descriptors
    const fnOrderedReifiedIds = new Map<FnDecl, number[]>();
    for (const fn of allFns) {
      const needed = fnNeededIds.get(fn);
      if (!needed || needed.size === 0) continue;

      const explicitTvs = this.fnExplicitTypeParams.get(fn) ?? [];
      const ordered: number[] = [];
      const added = new Set<number>();
      for (const tv of explicitTvs) {
        const p = prune(tv);
        if (p.kind === "TVar" && needed.has(p.id) && !added.has(p.id)) {
          ordered.push(p.id);
          added.add(p.id);
        }
      }
      const remaining = Array.from(needed).filter((id) => !added.has(id)).sort((a, b) => a - b);
      ordered.push(...remaining);

      fnOrderedReifiedIds.set(fn, ordered);
      this.fnReifiedParams.set(
        fn,
        ordered.map((id) => ({ kind: "TVar" as const, id, bounds: [] }))
      );

      if (fn.receiverType) {
        const sym = this.extensionJsSymbols.get(fn);
        const ext = sym ? this.extensions.find((e) => e.jsSymbol === sym) : undefined;
        if (ext) {
          ext.isReified = true;
          if (ext.scheme) ext.scheme.reifiedTypeParams = ordered;
        }
      } else {
        const binding = this.fnBindings.get(fn);
        if (binding) {
          binding.isReified = true;
          binding.scheme.reifiedTypeParams = ordered;
        }
      }
    }

    // Patch all call sites and first-class IdentExpr references targeting newly auto-reified functions
    for (const site of this.reifiedCallSites) {
      if (!site.targetFn) continue;
      const ordered = fnOrderedReifiedIds.get(site.targetFn);
      if (!ordered || ordered.length === 0) continue;

      const argTypes = ordered.map(
        (tid) => site.instantiationMap?.get(tid) ?? ({ kind: "TVar", id: tid, bounds: [] } as Type)
      );

      if (site.kind === "IdentRef") {
        this.reifiedIdentRefs.set(site.expr, argTypes);
      } else {
        const res = this.callResolutions.get(site.expr);
        if (res && (res.kind === "Normal" || res.kind === "ExtensionMethod" || res.kind === "NamespaceCall")) {
          res.reifiedTypeVars = argTypes;
        }
      }
    }
  }
}
