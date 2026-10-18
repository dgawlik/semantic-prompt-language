import type { ResponseSchema, ZodSchema } from "./types.js";
export declare function isZodSchema(value: unknown): value is ZodSchema;
export declare function toJsonSchema(schema: ZodSchema | Record<string, unknown> | undefined): Record<string, unknown> | undefined;
export declare function isResponseSchema(value: unknown): value is ResponseSchema;
