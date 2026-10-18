function isZodSchema(value) {
  return typeof value === "object" && value !== null && "toJSONSchema" in value && typeof value.toJSONSchema === "function";
}
function toJsonSchema(schema) {
  return isZodSchema(schema) ? schema.toJSONSchema() : schema;
}
function isResponseSchema(value) {
  return isZodSchema(value) && "parse" in value && typeof value.parse === "function";
}
export {
  isResponseSchema,
  isZodSchema,
  toJsonSchema
};
