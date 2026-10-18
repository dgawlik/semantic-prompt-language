"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var schema_exports = {};
__export(schema_exports, {
  isResponseSchema: () => isResponseSchema,
  isZodSchema: () => isZodSchema,
  toJsonSchema: () => toJsonSchema
});
module.exports = __toCommonJS(schema_exports);
function isZodSchema(value) {
  return typeof value === "object" && value !== null && "toJSONSchema" in value && typeof value.toJSONSchema === "function";
}
function toJsonSchema(schema) {
  return isZodSchema(schema) ? schema.toJSONSchema() : schema;
}
function isResponseSchema(value) {
  return isZodSchema(value) && "parse" in value && typeof value.parse === "function";
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  isResponseSchema,
  isZodSchema,
  toJsonSchema
});
