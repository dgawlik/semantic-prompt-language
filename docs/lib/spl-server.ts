import {
  EffectDispatchResult,
  EffectDispatcher,
  OpenAiClientLike,
  SignatureCatalog,
  SplCompileError,
  SplValue,
  canonicalJsonStringify,
  canonicalTraceJson,
  canonicalTypeString,
  compileSource,
  createOfficialOpenAiClient,
  runVm,
  sha256Hex,
  translateProseToSpl,
  validateSignatureCatalog,
} from "../../dist/src/index.js";
import { DEFAULT_CATALOG, WORKFLOW_PRESETS } from "./presets";

/**
 * Bundled normative llguidance-compatible Lark CFG so Vercel serverless
 * functions never depend on relative filesystem lookups.
 */
export const SPL_V5_LARK_GRAMMAR = `start: program

program: top_decl+ stmt* | stmt+

top_decl: type_decl
        | input_decl
        | state_decl
        | fn_decl

type_decl: "type" IDENT "=" type_expr ";"
input_decl: "input" IDENT ":" type_expr ("=" expr)? ";"
state_decl: "state" IDENT ":" type_expr "=" expr ";"
fn_decl: "fn" IDENT "(" param_list? ")" "->" type_expr block

param_list: param ("," param)*
param: IDENT ":" type_expr

type_expr: union_type
union_type: nullable_type ("|" nullable_type)*
nullable_type: base_type "?"?

base_type: "null"
         | "bool"
         | "int"
         | "float"
         | "string"
         | "json"
         | "void"
         | "Error"
         | "list" "<" type_expr ">"
         | "map" "<" "string" "," type_expr ">"
         | "{" field_type_list? "}"
         | STRING
         | IDENT

field_type_list: field_type ("," field_type)* ","?
field_type: IDENT ":" type_expr

block: "{" stmt* "}"

stmt: let_stmt
    | assign_stmt
    | if_stmt
    | switch_stmt
    | while_stmt
    | for_stmt
    | try_stmt
    | return_stmt
    | break_stmt
    | continue_stmt
    | expr_stmt

let_stmt: "let" "mut"? IDENT (":" type_expr)? "=" expr ";"

assign_stmt: lvalue "=" expr ";"
lvalue: IDENT lvalue_seg*
lvalue_seg: "." IDENT
          | "[" expr "]"

if_stmt: "if" "(" expr ")" block ("else" (if_stmt | block))?

switch_stmt: "switch" "(" expr ")" "{" switch_case* switch_default? "}"
switch_case: "case" case_lit ("," case_lit)* ":" block
switch_default: "default" ":" block
case_lit: STRING | INT | "true" | "false"

while_stmt: "while" "(" expr ")" block
for_stmt: "for" "(" IDENT "in" expr ")" block
try_stmt: "try" block "catch" "(" IDENT ")" block

return_stmt: "return" expr? ";"
break_stmt: "break" ";"
continue_stmt: "continue" ";"
expr_stmt: expr ";"

expr: coalesce_expr

coalesce_expr: or_expr ("??" or_expr)*
or_expr: and_expr ("||" and_expr)*
and_expr: bitor_expr ("&&" bitor_expr)*
bitor_expr: bitxor_expr ("|" bitxor_expr)*
bitxor_expr: bitand_expr ("^" bitand_expr)*
bitand_expr: eq_expr ("&" eq_expr)*
eq_expr: rel_expr (EQ_OP rel_expr)*
rel_expr: shift_expr (REL_OP shift_expr)*
shift_expr: add_expr (SHIFT_OP add_expr)*
add_expr: mul_expr (ADD_OP mul_expr)*
mul_expr: cast_expr (MUL_OP cast_expr)*
cast_expr: unary_expr ("as" type_expr)?

unary_expr: UNARY_OP unary_expr
          | postfix_expr

postfix_expr: primary postfix_op*
postfix_op: "." IDENT
          | "?." IDENT
          | "[" expr "]"
          | "?.[" expr "]"
          | "(" arg_list? ")"

arg_list: expr ("," expr)* ","?

primary: effect_expr
       | literal
       | template_str
       | list_lit
       | record_lit
       | IDENT
       | "(" expr ")"

effect_expr: eff_ask
           | eff_decide
           | eff_web_search
           | eff_web_fetch
           | eff_fs
           | eff_shell
           | eff_js_tool
           | eff_mcp_tool

eff_ask: "model" "." "ask" "<" type_expr ">" "(" arg_list ")"
eff_decide: "model" "." "decide" "(" arg_list ")"
eff_web_search: "web" "." "search" "(" arg_list ")"
eff_web_fetch: "web" "." "fetch" "(" arg_list ")"
eff_fs: "fs" "." FS_OP "(" arg_list ")"
eff_shell: "shell" "." "run" "(" arg_list ")"
eff_js_tool: "tool" "." IDENT "(" expr ")"
eff_mcp_tool: "mcp" "." IDENT "." IDENT "(" expr ")"

FS_OP: "read" | "write" | "append" | "exists" | "list" | "stat"

literal: "null"
       | "true"
       | "false"
       | FLOAT
       | INT
       | STRING

list_lit: "[" arg_list? "]"
record_lit: "{" record_entry_list? "}"
record_entry_list: record_entry ("," record_entry)* ","?
record_entry: (IDENT | STRING) ":" expr

template_str: "\`" template_part* "\`"
template_part: TEMPLATE_TEXT
             | "\${" expr "}"

EQ_OP: "==" | "!="
REL_OP: "<=" | ">=" | "<" | ">"
SHIFT_OP: ">>>" | "<<" | ">>"
ADD_OP: "+" | "-"
MUL_OP: "*" | "/" | "%"
UNARY_OP: "!" | "-" | "~"

IDENT: /[A-Za-z_][A-Za-z0-9_]*/
FLOAT: /[0-9][0-9_]*\\.[0-9][0-9_]*([eE][+-]?[0-9]+)?|[0-9][0-9_]*[eE][+-]?[0-9]+/
INT: /0[xX][0-9a-fA-F][0-9a-fA-F_]*|[0-9][0-9_]*/
STRING: /"([^"\\\\\\r\\n]|\\\\["\\\\nrt]|\\\\u\\{[0-9a-fA-F]{1,6}\\})*"/
TEMPLATE_TEXT: /([^\\\`\\\\$]|\\\\[\\\`\\\\$nrt]|\\\\u\\{[0-9a-fA-F]{1,6}\\})+/

%ignore /[ \\t\\r\\n]+/
`;

export function toJsonSafe<T>(val: T): unknown {
  return JSON.parse(canonicalJsonStringify(val));
}

export function resolveCatalog(raw?: unknown): SignatureCatalog {
  return validateSignatureCatalog(raw ?? DEFAULT_CATALOG);
}

export function serializeCompileMeta(compiled: ReturnType<typeof compileSource>) {
  return {
    bytecode: compiled.text,
    sha256: compiled.sha256,
    catalog_sha256: compiled.program.catalogSha256,
    capabilities: compiled.program.capabilities,
    inputs: compiled.program.inputs.map((i) => ({
      name: i.name,
      type: canonicalTypeString(i.type),
      required: i.defaultRef === "NONE",
    })),
    states: compiled.program.states.map((s) => ({
      name: s.name,
      type: canonicalTypeString(s.type),
      init: s.initRef,
    })),
    functions: compiled.program.functions.map((f) => ({
      name: f.name,
      params: f.paramTypes.map(canonicalTypeString),
      return_type: canonicalTypeString(f.retType),
      locals: f.locals,
      instructions: f.code.length,
    })),
    consts_count: compiled.program.consts.length,
    schemas_count: compiled.program.schemas.length,
  };
}

function synthesizeCustomDemoSpl(prose: string): string {
  const lower = prose.toLowerCase();
  // Match known presets closely first
  for (const preset of WORKFLOW_PRESETS) {
    if (prose.trim() === preset.prose.trim()) {
      return preset.demoSpl;
    }
  }
  if (lower.includes("invoice") && (lower.includes("extract") || lower.includes("vendor"))) {
    return WORKFLOW_PRESETS[1].demoSpl;
  }
  if (lower.includes("web") && lower.includes("search")) {
    return WORKFLOW_PRESETS[2].demoSpl;
  }
  if (lower.includes("mcp") || lower.includes("risk") || lower.includes("git_status")) {
    return WORKFLOW_PRESETS[3].demoSpl;
  }
  if (lower.includes("ticket") && lower.includes("refund")) {
    return WORKFLOW_PRESETS[0].demoSpl;
  }

  // Generic natural-language workflow synthesis (compiles through real SPL v5 compiler)
  const escaped = prose.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, " ").slice(0, 180);
  return `input text: string = "Sample user request";
state runs: int = 0;

fn main() -> { verdict: string, confidence_ok: bool, response: string, runs: int } {
  let decision = model.decide(
    "classifier_default",
    \`Evaluate input for workflow ("${escaped}"): \${text}\`,
    ["proceed", "escalate", "reject"],
    { min_confidence: 0.75 }
  );

  runs = runs + 1;

  if (decision == null) {
    return {
      verdict: "escalate",
      confidence_ok: false,
      response: "Confidence below 0.75; routed to human review.",
      runs: runs
    };
  }

  switch (decision) {
    case "proceed": {
      let reply = model.ask<string>(
        "default",
        \`Execute instruction ("${escaped}") for input: \${text}\`
      );
      return { verdict: "proceed", confidence_ok: true, response: reply, runs: runs };
    }
    case "escalate": {
      return { verdict: "escalate", confidence_ok: true, response: "Escalated by classifier.", runs: runs };
    }
    case "reject": {
      return { verdict: "reject", confidence_ok: true, response: "Rejected by classifier.", runs: runs };
    }
  }
}`;
}

function createDemoLarkClient(prose: string): OpenAiClientLike {
  const matchedPreset = WORKFLOW_PRESETS.find((p) => p.prose.trim() === prose.trim());
  const finalSpl = synthesizeCustomDemoSpl(prose);
  let attempt = 0;

  return {
    responses: {
      async create() {
        attempt++;
        if (attempt === 1 && matchedPreset?.demoFirstAttemptBuggySpl) {
          return {
            output: [{ type: "custom_tool_call", name: "emit_spl", input: matchedPreset.demoFirstAttemptBuggySpl }],
          };
        }
        return {
          output: [{ type: "custom_tool_call", name: "emit_spl", input: finalSpl }],
        };
      },
    },
    chat: {
      completions: {
        async create() {
          throw new Error("Unused in translation demo");
        },
      },
    },
  };
}

export async function serverTranslateProse(params: {
  prose: string;
  catalog?: unknown;
  model?: string;
  apiKey?: string;
  mode?: "live" | "demo";
  maxAttempts?: number;
}) {
  const catalog = resolveCatalog(params.catalog);
  const effectiveKey = params.apiKey?.trim() || process.env.OPENAI_API_KEY?.trim();
  const useLive = params.mode === "live" || (params.mode !== "demo" && Boolean(effectiveKey));

  if (useLive && !effectiveKey) {
    throw new Error("Live mode requires an OpenAI API key (provide one in the API Key drawer or switch to Instant Demo).");
  }

  const client = useLive ? createOfficialOpenAiClient(effectiveKey) : createDemoLarkClient(params.prose);
  const res = await translateProseToSpl({
    prose: params.prose,
    catalog,
    client,
    model: params.model || "gpt-4.1",
    maxAttempts: Math.min(5, Math.max(1, params.maxAttempts ?? 3)),
    larkGrammar: SPL_V5_LARK_GRAMMAR,
  });

  return {
    mode: useLive ? "live" : "demo",
    source: res.source,
    attempts: res.attempts,
    diagnosticsHistory: res.diagnosticsHistory,
    ...serializeCompileMeta(res.compiled),
  };
}

export function serverCompileSpl(source: string, rawCatalog?: unknown) {
  const catalog = resolveCatalog(rawCatalog);
  try {
    const compiled = compileSource(source, catalog);
    return {
      ok: true as const,
      ...serializeCompileMeta(compiled),
    };
  } catch (err) {
    if (err instanceof SplCompileError) {
      return {
        ok: false as const,
        diagnostics: err.diagnostics,
      };
    }
    throw err;
  }
}

function generateMockForSchema(schema: Record<string, unknown> | undefined, prompt: string): SplValue {
  if (!schema || (schema.type === "string" && !Array.isArray(schema.enum))) {
    if (prompt.toLowerCase().includes("approval")) {
      return "Your refund request has been approved and will post within 3–5 business days.";
    }
    return `Completed generated response for: ${prompt.slice(0, 72)}`;
  }
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return String(schema.enum[0]);
  }
  if (Array.isArray(schema.anyOf)) {
    const nonNull = (schema.anyOf as Record<string, unknown>[]).find((b) => b.type !== "null");
    return nonNull ? generateMockForSchema(nonNull, prompt) : null;
  }
  switch (schema.type) {
    case "boolean":
      return true;
    case "integer":
      return 12000n;
    case "number":
      return 0.42;
    case "array": {
      const itemSchema = (schema.items ?? {}) as Record<string, unknown>;
      if (itemSchema.type === "string") {
        return [
          "VM owns all branching, loops, and state transitions",
          "Model calls are strictly validated leaf data effects",
          "Strict offline replay traps on any effect divergence",
        ];
      }
      if (itemSchema.type === "object" && (itemSchema.properties as Record<string, unknown>)?.amount_cents) {
        return [
          { description: "Compute cluster", amount_cents: 12000n },
          { description: "Object storage", amount_cents: 3500n },
        ];
      }
      return [generateMockForSchema(itemSchema, prompt)];
    }
    case "object": {
      const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
      const out: Record<string, SplValue> = {};
      for (const [k, ps] of Object.entries(props)) {
        if (k === "vendor") out[k] = "Acme Cloud Corp";
        else if (k === "po_number") out[k] = "PO-8812";
        else if (k === "headline") out[k] = "SPL v5 Deterministic Agent Workflows";
        else out[k] = generateMockForSchema(ps, prompt);
      }
      return out;
    }
    default:
      return "ok";
  }
}

/**
 * Sandboxed in-memory dispatcher for safe browser playground execution on Vercel.
 */
function createPlaygroundDispatcher(): EffectDispatcher {
  const virtualFs = new Map<string, string>();

  return {
    async dispatch(req): Promise<EffectDispatchResult> {
      switch (req.kind) {
        case "model.decide": {
          const opts = req.decideOptions ?? (req.args.options as string[]) ?? ["yes", "no"];
          const scores: Record<string, number> = {};
          const topProb = 0.92;
          const restProb = opts.length > 1 ? Number(((1 - topProb) / (opts.length - 1)).toFixed(4)) : 0;
          opts.forEach((opt, i) => {
            scores[opt] = i === 0 ? topProb : restProb;
          });
          const minConf = typeof req.args.min_confidence === "number" ? req.args.min_confidence : undefined;
          const chosen = minConf !== undefined && topProb < minConf ? null : opts[0];
          return {
            outcome: {
              status: "ok",
              value: chosen,
              decision_scores: scores,
              confidence: topProb,
            },
            non_normative_meta: { sandbox: "playground_logprobs_sim" },
          };
        }
        case "model.ask": {
          const prompt = String(req.args.prompt ?? "");
          return {
            outcome: {
              status: "ok",
              value: generateMockForSchema(req.schema, prompt),
            },
            non_normative_meta: { sandbox: "playground_responses_sim" },
          };
        }
        case "web.search": {
          return {
            outcome: {
              status: "ok",
              value: [
                {
                  title: "SPL v5 Specification",
                  url: "https://spec.docs.org/spl-v5",
                  snippet: "Deterministic stack VM with Lark CFG constrained compilation.",
                },
                {
                  title: "External Unlisted Blog",
                  url: "https://blocked.example.net/post",
                  snippet: "Demonstrates policy-denied domain fallback to snippet.",
                },
              ],
            },
          };
        }
        case "web.fetch": {
          const url = String(req.args.url ?? "");
          if (url.includes("blocked.example.net")) {
            return {
              outcome: {
                status: "error",
                error: {
                  code: "POLICY_DENIED",
                  message: "Domain 'blocked.example.net' is not in allowed_domains",
                  retryable: false,
                  details: null,
                },
              },
            };
          }
          return {
            outcome: {
              status: "ok",
              value: {
                status: 200n,
                url,
                content_type: "text/plain",
                headers: { "content-type": "text/plain" },
                body: `Fetched canonical documentation page from ${url}.`,
                truncated: false,
              },
            },
          };
        }
        case "fs": {
          const key = `${String(req.args.root)}:${String(req.args.path)}`;
          const op = String(req.args.op);
          if (op === "write") {
            virtualFs.set(key, String(req.args.content ?? ""));
            return { outcome: { status: "ok", value: null } };
          }
          if (op === "append") {
            virtualFs.set(key, (virtualFs.get(key) ?? "") + String(req.args.content ?? ""));
            return { outcome: { status: "ok", value: null } };
          }
          if (op === "read") {
            return { outcome: { status: "ok", value: virtualFs.get(key) ?? "" } };
          }
          if (op === "exists") {
            return { outcome: { status: "ok", value: virtualFs.has(key) } };
          }
          if (op === "list") {
            return { outcome: { status: "ok", value: Array.from(virtualFs.keys()) } };
          }
          return {
            outcome: {
              status: "ok",
              value: { exists: virtualFs.has(key), is_file: true, is_dir: false, size_bytes: 128n },
            },
          };
        }
        case "shell": {
          return {
            outcome: {
              status: "ok",
              value: { exit_code: 0n, stdout: "", stderr: "", truncated: false },
            },
          };
        }
        case "js_tool": {
          const amt = Number(req.args.amount_cents ?? 0);
          const age = Math.max(1, Number(req.args.account_age_days ?? 30));
          const score = Math.min(1, Number((amt / (age * 100)).toFixed(4)));
          return {
            outcome: { status: "ok", value: { score, flagged: score > 0.7 } },
          };
        }
        case "mcp_tool": {
          const id = String(req.args.customer_id ?? "");
          return {
            outcome: {
              status: "ok",
              value: {
                tier: id.includes("ent") ? "enterprise" : "pro",
                account_age_days: 180n,
              },
            },
          };
        }
      }
    },
  };
}

export async function serverRunBytecode(params: {
  bytecode: string;
  inputs?: Record<string, unknown>;
  initialState?: Record<string, unknown>;
  catalog?: unknown;
}) {
  const catalog = resolveCatalog(params.catalog);
  const dispatcher = createPlaygroundDispatcher();
  const trace = await runVm({
    bytecode: params.bytecode,
    catalog,
    inputs: params.inputs ?? {},
    initialState: params.initialState ?? {},
    dispatcher,
  });

  // Immediately verify strict offline replay
  const replayed = await runVm({
    bytecode: params.bytecode,
    inputs: trace.inputs,
    initialState: trace.initial_state,
    limits: trace.limits,
    replayLog: trace.effects,
    replayMode: "strict_replay",
  });

  const canonA = canonicalTraceJson(trace);
  const canonB = canonicalTraceJson(replayed);
  const replayVerified = canonA === canonB;

  return {
    trace: toJsonSafe(trace),
    replayVerified,
    normativeTraceSha256: sha256Hex(canonA),
  };
}
