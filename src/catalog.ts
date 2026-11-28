import { canonicalJsonStringify, sha256Hex, sortKeysCodePoint } from "./canonical.js";
import {
  JsonSchema,
  SplType,
  T_BOOL,
  T_FLOAT,
  T_INT,
  T_JSON,
  T_NULL,
  T_STRING,
  makeList,
  makeMap,
  makeNullable,
  makeRecord,
  makeStrUnion,
} from "./types.js";

export type FsPermission = "read" | "write" | "append" | "exists" | "list" | "stat";
export type WebMethod = "GET" | "HEAD" | "POST";

export interface ModelProfile {
  provider: string;
  model: string;
  max_output_tokens: number;
  temperature?: number;
  strict_schema: boolean;
  store?: boolean;
  timeout_ms?: number;
}

export interface DecisionProfile {
  adapter: string;
  model: string;
  top_logprobs?: number;
  temperature?: number;
  store?: boolean;
  timeout_ms?: number;
}

export interface ShellProfile {
  executable: string;
  base_argv: string[];
  cwd_root: string;
  params_schema: JsonSchema;
  argv_template: string[];
  env_allowlist: string[];
  timeout_ms: number;
  max_stdout_bytes: number;
  max_stderr_bytes: number;
}

export interface FsRootConfig {
  permissions: FsPermission[];
  max_file_bytes: number;
}

export interface WebSearchPolicy {
  enabled: boolean;
  max_results_cap: number;
}

export interface WebFetchPolicy {
  enabled: boolean;
  allowed_methods: WebMethod[];
  allowed_domains: string[];
  denied_domains: string[];
  block_private_ips: boolean;
  max_redirects: number;
  max_response_bytes: number;
}

export interface ToolSignature {
  params_schema: JsonSchema;
  result_schema: JsonSchema;
  timeout_ms: number;
  description?: string;
}

export interface SignatureCatalog {
  spec_version: "5";
  models: Record<string, ModelProfile>;
  decisions: Record<string, DecisionProfile>;
  shell_profiles: Record<string, ShellProfile>;
  fs_roots: Record<string, FsRootConfig>;
  web: {
    search: WebSearchPolicy;
    fetch: WebFetchPolicy;
  };
  js_tools: Record<string, ToolSignature>;
  mcp_tools: Record<string, Record<string, ToolSignature>>;
}

export function createEmptyCatalog(): SignatureCatalog {
  return {
    spec_version: "5",
    models: {},
    decisions: {},
    shell_profiles: {},
    fs_roots: {},
    web: {
      search: { enabled: false, max_results_cap: 0 },
      fetch: {
        enabled: false,
        allowed_methods: [],
        allowed_domains: [],
        denied_domains: [],
        block_private_ips: true,
        max_redirects: 0,
        max_response_bytes: 0,
      },
    },
    js_tools: {},
    mcp_tools: {},
  };
}

export function validateSignatureCatalog(raw: unknown): SignatureCatalog {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Signature catalog must be a JSON object");
  }
  const obj = raw as Record<string, unknown>;
  if (obj.spec_version !== "5") {
    throw new Error(`Unsupported catalog spec_version: ${String(obj.spec_version)}`);
  }
  const base = createEmptyCatalog();
  const catalog: SignatureCatalog = {
    spec_version: "5",
    models: (obj.models as Record<string, ModelProfile>) ?? base.models,
    decisions: (obj.decisions as Record<string, DecisionProfile>) ?? base.decisions,
    shell_profiles: (obj.shell_profiles as Record<string, ShellProfile>) ?? base.shell_profiles,
    fs_roots: (obj.fs_roots as Record<string, FsRootConfig>) ?? base.fs_roots,
    web: {
      search: (obj.web as { search?: WebSearchPolicy })?.search ?? base.web.search,
      fetch: (obj.web as { fetch?: WebFetchPolicy })?.fetch ?? base.web.fetch,
    },
    js_tools: (obj.js_tools as Record<string, ToolSignature>) ?? base.js_tools,
    mcp_tools: (obj.mcp_tools as Record<string, Record<string, ToolSignature>>) ?? base.mcp_tools,
  };

  for (const [name, p] of Object.entries(catalog.shell_profiles)) {
    if (!p.executable || typeof p.executable !== "string") {
      throw new Error(`shell_profiles.${name}: missing executable`);
    }
    if (!Array.isArray(p.base_argv) || !Array.isArray(p.argv_template)) {
      throw new Error(`shell_profiles.${name}: base_argv and argv_template must be arrays`);
    }
  }
  for (const [rootName, cfg] of Object.entries(catalog.fs_roots)) {
    if (!Array.isArray(cfg.permissions)) {
      throw new Error(`fs_roots.${rootName}: permissions must be an array`);
    }
  }
  return catalog;
}

export function computeCatalogSha256(catalog: SignatureCatalog): string {
  return sha256Hex(canonicalJsonStringify(catalog));
}

/**
 * Convert a JSON Schema from the Signature Catalog into an SPL static type.
 */
export function jsonSchemaToSplType(schema: JsonSchema): SplType {
  if (!schema || typeof schema !== "object" || Object.keys(schema).length === 0) {
    return T_JSON;
  }
  if (Array.isArray(schema.anyOf)) {
    const branches = schema.anyOf as JsonSchema[];
    const hasNull = branches.some((b) => b.type === "null");
    const nonNull = branches.filter((b) => b.type !== "null");
    if (hasNull && nonNull.length === 1) {
      return makeNullable(jsonSchemaToSplType(nonNull[0]));
    }
    return T_JSON;
  }
  if (Array.isArray(schema.enum)) {
    const lits = (schema.enum as unknown[]).filter((x): x is string => typeof x === "string");
    if (lits.length >= 2 && lits.length === schema.enum.length) {
      return makeStrUnion(lits);
    }
    if (lits.length === 1 && schema.enum.length === 1) {
      return T_STRING;
    }
    return T_JSON;
  }
  switch (schema.type) {
    case "null":
      return T_NULL;
    case "boolean":
      return T_BOOL;
    case "integer":
      return T_INT;
    case "number":
      return T_FLOAT;
    case "string":
      return T_STRING;
    case "array":
      return makeList(jsonSchemaToSplType((schema.items ?? {}) as JsonSchema));
    case "object": {
      const props = schema.properties as Record<string, JsonSchema> | undefined;
      if (props && typeof props === "object") {
        const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
        const fields = sortKeysCodePoint(Object.keys(props)).map((name) => {
          const ft = jsonSchemaToSplType(props[name]);
          return { name, type: required.has(name) ? ft : makeNullable(ft) };
        });
        return makeRecord(fields);
      }
      if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
        return makeMap(jsonSchemaToSplType(schema.additionalProperties as JsonSchema));
      }
      return T_JSON;
    }
    default:
      return T_JSON;
  }
}
