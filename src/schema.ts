import { flattenRecord, formatType, prune, type Type } from "./types.js";

export type JsonSchema = Record<string, unknown>;
export type DecodeCodec = Record<string, unknown>;

export interface ReifiedFieldMeta {
  name: string;
  type_name: string;
  optional: boolean;
  doc: { $tag: "Some"; _0: string } | { $tag: "None" };
  hint: { $tag: "Some"; _0: string } | { $tag: "None" };
}

export interface ReifiedVariantMeta {
  name: string;
  fields: string[];
  doc: { $tag: "Some"; _0: string } | { $tag: "None" };
  hint: { $tag: "Some"; _0: string } | { $tag: "None" };
}

export interface FullReifiedDescriptor {
  name: string;
  kind: string;
  splType: string;
  spl_type: string;
  schema: JsonSchema;
  codec: DecodeCodec;
  doc: { $tag: "Some"; _0: string } | { $tag: "None" };
  hint: { $tag: "Some"; _0: string } | { $tag: "None" };
  underlying: { $tag: "Some"; _0: string } | { $tag: "None" };
  type_args: string[];
  fields: ReifiedFieldMeta[];
  variants: ReifiedVariantMeta[];
  params: string[];
  return_type: { $tag: "Some"; _0: string } | { $tag: "None" };
}

const OPT_NONE: { $tag: "None" } = { $tag: "None" };
function optStr(s?: string): { $tag: "Some"; _0: string } | { $tag: "None" } {
  return s !== undefined ? { $tag: "Some", _0: s } : OPT_NONE;
}

/** Generate a JSON Schema (Draft 2020-12 compatible) from a static SPL type */
export function generateJsonSchema(type: Type): JsonSchema {
  const t = prune(type);

  switch (t.kind) {
    case "TPrim":
      switch (t.name) {
        case "Int":
          return { type: "integer" };
        case "Float":
          return { type: "number" };
        case "Str":
        case "Prompt":
          return { type: "string" };
        case "Bool":
          return { type: "boolean" };
        case "Char":
          return { type: "string", minLength: 1, maxLength: 1 };
        case "Byte":
          return { type: "integer", minimum: 0, maximum: 255 };
        case "Bytes":
          return { type: "array", items: { type: "integer", minimum: 0, maximum: 255 } };
        case "Json":
          return {};
        case "Unit":
          return { type: "null" };
      }

    case "TVar":
      return {};

    case "TArray":
    case "TIter":
      return {
        type: "array",
        items: generateJsonSchema(t.element),
      };

    case "TDict":
      return {
        type: "object",
        additionalProperties:
          prune(t.value).kind === "TPrim" && (prune(t.value) as { name: string }).name === "Json"
            ? true
            : generateJsonSchema(t.value),
      };

    case "TTuple":
      return {
        type: "array",
        prefixItems: t.elements.map(generateJsonSchema),
        minItems: t.elements.length,
        maxItems: t.elements.length,
      };

    case "TRecord": {
      const flat = flattenRecord(t);
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];

      for (const [name, fType] of flat.fields) {
        const pf = prune(fType);
        const isOpt = pf.kind === "TEnum" && pf.name === "Option" && pf.typeArgs.length === 1;
        const fieldSchema = isOpt
          ? { anyOf: [generateJsonSchema(pf.typeArgs[0]), { type: "null" }] }
          : generateJsonSchema(pf);

        const fieldHint = flat.meta?.fieldHints.get(name);
        if (fieldHint) {
          fieldSchema.description = fieldHint;
        }
        properties[name] = fieldSchema;
        if (!isOpt) required.push(name);
      }

      const schema: JsonSchema = {
        type: "object",
        properties,
        required,
      };
      if (flat.meta?.typeName) schema.title = flat.meta.typeName;
      if (flat.meta?.llmHint) schema.description = flat.meta.llmHint;

      if (flat.tail.kind === "RClosed") {
        schema.additionalProperties = false;
      } else if (flat.tail.kind === "ROpenDict") {
        const v = prune(flat.tail.valueType);
        schema.additionalProperties =
          v.kind === "TPrim" && v.name === "Json" ? true : generateJsonSchema(v);
      } else {
        schema.additionalProperties = true;
      }
      return schema;
    }

    case "TEnum": {
      if (t.name === "Option" && t.typeArgs.length === 1) {
        return { anyOf: [generateJsonSchema(t.typeArgs[0]), { type: "null" }] };
      }
      if (t.variants.size === 0) {
        return { description: `Recursive ${t.name}` };
      }

      const allUnit = Array.from(t.variants.values()).every((v) => v.fields.length === 0);
      if (allUnit) {
        const schema: JsonSchema = {
          type: "string",
          enum: Array.from(t.variants.keys()),
        };
        if (t.llmHint) schema.description = t.llmHint;
        return schema;
      }

      const oneOf: JsonSchema[] = [];
      for (const [vName, vInfo] of t.variants) {
        const props: Record<string, JsonSchema> = {
          tag: { const: vName },
        };
        const req = ["tag"];
        if (vInfo.fields.length === 1) {
          props.value = generateJsonSchema(vInfo.fields[0]);
          req.push("value");
        } else if (vInfo.fields.length > 1) {
          props.values = {
            type: "array",
            prefixItems: vInfo.fields.map(generateJsonSchema),
            minItems: vInfo.fields.length,
            maxItems: vInfo.fields.length,
          };
          req.push("values");
        }
        const variantSchema: JsonSchema = {
          type: "object",
          properties: props,
          required: req,
          additionalProperties: false,
        };
        if (vInfo.llmHint) variantSchema.description = vInfo.llmHint;
        oneOf.push(variantSchema);
      }
      const schema: JsonSchema = { title: t.name, oneOf };
      if (t.llmHint) schema.description = t.llmHint;
      return schema;
    }

    case "TNewtype": {
      const inner = { ...generateJsonSchema(t.underlying) };
      inner.title = t.name;
      if (t.llmHint) inner.description = t.llmHint;
      return inner;
    }

    case "TFn":
      return { description: "function" };
  }
}

/** Generate a compact runtime decoder descriptor for `decode<T>(json)` */
export function generateDecodeCodec(type: Type): DecodeCodec {
  const t = prune(type);

  switch (t.kind) {
    case "TPrim":
      return { k: t.name };
    case "TVar":
      return { k: "Json" };
    case "TArray":
    case "TIter":
      return { k: "Array", el: generateDecodeCodec(t.element) };
    case "TDict":
      return { k: "Dict", val: generateDecodeCodec(t.value) };
    case "TTuple":
      return { k: "Tuple", els: t.elements.map(generateDecodeCodec) };
    case "TRecord": {
      const flat = flattenRecord(t);
      const fields: Record<string, { codec: DecodeCodec; optional: boolean }> = {};
      for (const [name, fType] of flat.fields) {
        const pf = prune(fType);
        const isOpt = pf.kind === "TEnum" && pf.name === "Option" && pf.typeArgs.length === 1;
        fields[name] = {
          codec: generateDecodeCodec(isOpt ? pf.typeArgs[0] : pf),
          optional: isOpt,
        };
      }
      if (flat.tail.kind === "ROpenDict") {
        return {
          k: "Record",
          fields,
          open: true,
          extraName: flat.tail.extraName ?? "extra",
          extraCodec: generateDecodeCodec(flat.tail.valueType),
        };
      }
      return {
        k: "Record",
        fields,
        open: flat.tail.kind !== "RClosed",
      };
    }
    case "TEnum": {
      if (t.name === "Option" && t.typeArgs.length === 1) {
        return { k: "Option", inner: generateDecodeCodec(t.typeArgs[0]) };
      }
      const variants: Record<string, DecodeCodec[]> = {};
      for (const [vName, vInfo] of t.variants) {
        variants[vName] = vInfo.fields.map(generateDecodeCodec);
      }
      return { k: "Enum", name: t.name, variants };
    }
    case "TNewtype":
      return generateDecodeCodec(t.underlying);
    case "TFn":
      return { k: "Json" };
  }
}

/** Generate a full compile-time reified type descriptor (TypeInfo + schema + codec) for any SPL type */
export function generateTypeDescriptor(type: Type): FullReifiedDescriptor {
  const t = prune(type);
  const splType = formatType(t);
  const schema = generateJsonSchema(t);
  const codec = generateDecodeCodec(t);

  const base: FullReifiedDescriptor = {
    name: splType,
    kind: "primitive",
    splType,
    spl_type: splType,
    schema,
    codec,
    doc: OPT_NONE,
    hint: OPT_NONE,
    underlying: OPT_NONE,
    type_args: [],
    fields: [],
    variants: [],
    params: [],
    return_type: OPT_NONE,
  };

  switch (t.kind) {
    case "TPrim":
      base.name = t.name;
      base.kind = "primitive";
      return base;

    case "TVar":
      base.kind = "var";
      return base;

    case "TArray":
      base.kind = "array";
      base.type_args = [formatType(t.element)];
      return base;

    case "TIter":
      base.kind = "iter";
      base.type_args = [formatType(t.element)];
      return base;

    case "TDict":
      base.kind = "dict";
      base.type_args = [formatType(t.key), formatType(t.value)];
      return base;

    case "TTuple":
      base.kind = "tuple";
      base.type_args = t.elements.map(formatType);
      return base;

    case "TFn":
      base.kind = "fn";
      base.params = t.params.map(formatType);
      base.return_type = optStr(formatType(t.ret));
      return base;

    case "TRecord": {
      const flat = flattenRecord(t);
      base.kind = "record";
      base.name = flat.meta?.typeName ?? splType;
      base.doc = optStr(flat.meta?.doc);
      base.hint = optStr(flat.meta?.llmHint);
      for (const [fName, fType] of flat.fields) {
        const pf = prune(fType);
        const isOpt = pf.kind === "TEnum" && pf.name === "Option" && pf.typeArgs.length === 1;
        base.fields.push({
          name: fName,
          type_name: formatType(pf),
          optional: isOpt,
          doc: optStr(flat.meta?.fieldDocs.get(fName)),
          hint: optStr(flat.meta?.fieldHints.get(fName)),
        });
      }
      return base;
    }

    case "TEnum": {
      base.kind = t.name === "Option" ? "option" : t.name === "Result" ? "result" : "enum";
      base.name = t.typeArgs.length > 0 ? splType : t.name;
      base.doc = optStr(t.doc);
      base.hint = optStr(t.llmHint);
      base.type_args = t.typeArgs.map(formatType);
      for (const [vName, vInfo] of t.variants) {
        base.variants.push({
          name: vName,
          fields: vInfo.fields.map(formatType),
          doc: optStr(vInfo.doc),
          hint: optStr(vInfo.llmHint),
        });
      }
      return base;
    }

    case "TNewtype": {
      base.kind = "newtype";
      base.name = t.typeArgs.length > 0 ? splType : t.name;
      base.doc = optStr(t.doc);
      base.hint = optStr(t.llmHint);
      base.underlying = optStr(formatType(t.underlying));
      base.type_args = t.typeArgs.map(formatType);
      const u = prune(t.underlying);
      if (u.kind === "TRecord") {
        const flat = flattenRecord(u);
        for (const [fName, fType] of flat.fields) {
          const pf = prune(fType);
          const isOpt = pf.kind === "TEnum" && pf.name === "Option" && pf.typeArgs.length === 1;
          base.fields.push({
            name: fName,
            type_name: formatType(pf),
            optional: isOpt,
            doc: optStr(flat.meta?.fieldDocs.get(fName)),
            hint: optStr(flat.meta?.fieldHints.get(fName)),
          });
        }
      }
      return base;
    }
  }
}
