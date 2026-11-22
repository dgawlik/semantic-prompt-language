import { flattenRecord, prune, type Type } from "./types.js";

export type JsonSchema = Record<string, unknown>;
export type DecodeCodec = Record<string, unknown>;

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
    case "TFn":
      return { k: "Json" };
  }
}
