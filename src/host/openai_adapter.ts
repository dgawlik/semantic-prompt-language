import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import OpenAI from "openai";
import { DecisionProfile, ModelProfile, SignatureCatalog } from "../catalog.js";
import {
  SplObject,
  SplRecoverableError,
  canonicalJsonParse,
  canonicalJsonStringify,
  normalizeFloat,
} from "../canonical.js";
import { CompileResult, compileSource } from "../compiler.js";
import { JsonSchema, SplCompileError, SplDiagnostic } from "../types.js";
import { EffectDispatchResult } from "../vm.js";

/**
 * Minimal structural interface over the official OpenAI SDK client so tests can
 * inject deterministic mocks while production uses `new OpenAI(...)`.
 */
export interface OpenAiClientLike {
  responses: {
    create(params: Record<string, unknown>, options?: Record<string, unknown>): Promise<{
      id?: string;
      output_text?: string;
      output?: Array<{
        type?: string;
        name?: string;
        input?: string;
        content?: Array<{ type?: string; text?: string }>;
      }>;
      usage?: Record<string, unknown>;
    }>;
  };
  chat: {
    completions: {
      create(params: Record<string, unknown>, options?: Record<string, unknown>): Promise<{
        id?: string;
        choices: Array<{
          message?: { content?: string | null };
          logprobs?: {
            content?: Array<{
              token: string;
              logprob: number;
              top_logprobs?: Array<{ token: string; logprob: number }>;
            }> | null;
          } | null;
        }>;
        usage?: Record<string, unknown>;
      }>;
    };
  };
}

export interface DecisionAdapter {
  decide(
    profile: DecisionProfile,
    prompt: string,
    options: string[],
    cfg: { min_confidence?: number; system?: string; context?: unknown }
  ): Promise<EffectDispatchResult>;
}

/**
 * §6.1 & §11 OpenAI Responses API adapter for `model.ask<T>`.
 */
export class OpenAiModelAskAdapter {
  constructor(private readonly client: OpenAiClientLike) {}

  async ask(
    profile: ModelProfile,
    prompt: string,
    schema: JsonSchema,
    opts: { system?: string; input?: unknown }
  ): Promise<EffectDispatchResult> {
    const startMs = Date.now();
    const isPlainText = schema.type === "string" && !Array.isArray(schema.enum);
    const needsWrapper = !isPlainText && schema.type !== "object";
    const wireSchema: JsonSchema = needsWrapper
      ? {
          additionalProperties: false,
          properties: { value: schema },
          required: ["value"],
          type: "object",
        }
      : schema;

    const userContent =
      opts.input !== undefined
        ? `${prompt}\n\nINPUT_DATA:\n${canonicalJsonStringify(opts.input)}`
        : prompt;

    const inputMessages: Array<{ role: string; content: string }> = [];
    if (opts.system) inputMessages.push({ role: "system", content: opts.system });
    inputMessages.push({ role: "user", content: userContent });

    // §11.1 Explicitly specify every semantic parameter; never rely on SDK defaults
    const reqParams: Record<string, unknown> = {
      model: profile.model,
      input: inputMessages,
      max_output_tokens: profile.max_output_tokens,
      store: profile.store ?? false,
      ...(profile.temperature !== undefined ? { temperature: profile.temperature } : {}),
      text: isPlainText
        ? { format: { type: "text" } }
        : {
            format: {
              type: "json_schema",
              name: "spl_v5_output",
              strict: profile.strict_schema,
              schema: wireSchema,
            },
          },
    };

    try {
      const resp = await this.client.responses.create(reqParams, {
        timeout: profile.timeout_ms ?? 30_000,
        maxRetries: 0,
      });

      const rawText = extractResponseText(resp);
      const meta = {
        provider_request_id: resp.id ?? null,
        latency_ms: Date.now() - startMs,
        usage: resp.usage ?? null,
      };

      if (isPlainText) {
        return { outcome: { status: "ok", value: rawText }, non_normative_meta: meta };
      }

      let parsed: unknown;
      try {
        parsed = canonicalJsonParse(rawText);
      } catch (e) {
        return {
          outcome: {
            status: "error",
            error: new SplRecoverableError(
              "MODEL_SCHEMA_ERROR",
              `Model returned invalid JSON: ${e instanceof Error ? e.message : String(e)}`,
              true
            ).errObj,
          },
          non_normative_meta: meta,
        };
      }

      const unwrapped = needsWrapper
        ? parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as SplObject).value
          : undefined
        : parsed;

      return {
        outcome: { status: "ok", value: unwrapped as SplObject },
        non_normative_meta: meta,
      };
    } catch (err) {
      return {
        outcome: {
          status: "error",
          error: new SplRecoverableError(
            "MODEL_ERROR",
            err instanceof Error ? err.message : String(err),
            true
          ).errObj,
        },
        non_normative_meta: { latency_ms: Date.now() - startMs },
      };
    }
  }
}

/**
 * §6.1 Reference `openai_logprobs` Decision API adapter.
 * Maps options to unambiguous single-token labels (A, B, ...), extracts logprobs,
 * applies numerically stable softmax over the closed option set, and enforces min_confidence.
 */
export class OpenAiLogprobsDecisionAdapter implements DecisionAdapter {
  constructor(private readonly client: OpenAiClientLike) {}

  async decide(
    profile: DecisionProfile,
    prompt: string,
    options: string[],
    cfg: { min_confidence?: number; system?: string; context?: unknown }
  ): Promise<EffectDispatchResult> {
    const startMs = Date.now();
    const labels = options.map((_, i) =>
      i < 26 ? String.fromCharCode(65 + i) : String(i)
    );

    const optionsMenu = options.map((opt, i) => `${labels[i]}: ${opt}`).join("\n");
    const sysPrompt = [
      cfg.system ?? "You are a strict classifier. Reply with ONLY the single label letter/number for the best option.",
      "Allowed labels:",
      optionsMenu,
    ].join("\n");

    const userPrompt =
      cfg.context !== undefined
        ? `${prompt}\n\nCONTEXT:\n${canonicalJsonStringify(cfg.context)}\n\nRespond with ONLY one label from [${labels.join(", ")}]:`
        : `${prompt}\n\nRespond with ONLY one label from [${labels.join(", ")}]:`;

    try {
      const resp = await this.client.chat.completions.create(
        {
          model: profile.model,
          messages: [
            { role: "system", content: sysPrompt },
            { role: "user", content: userPrompt },
          ],
          ...(profile.temperature !== undefined ? { temperature: profile.temperature } : {}),
          max_tokens: 1,
          logprobs: true,
          top_logprobs: profile.top_logprobs ?? 20,
          store: profile.store ?? false,
        },
        {
          timeout: profile.timeout_ms ?? 30_000,
          maxRetries: 0,
        }
      );

      const firstChoice = resp.choices?.[0];
      const tokenEntry = firstChoice?.logprobs?.content?.[0];
      const topLogprobs = tokenEntry?.top_logprobs ?? (tokenEntry ? [{ token: tokenEntry.token, logprob: tokenEntry.logprob }] : []);

      // Collect best logprob for each candidate option (matching label or exact option text)
      const optionLogprobs: number[] = new Array(options.length).fill(-100);
      let anyMatched = false;

      for (const lp of topLogprobs) {
        const cleaned = lp.token.trim();
        for (let i = 0; i < options.length; i++) {
          if (cleaned === labels[i] || cleaned === options[i]) {
            if (lp.logprob > optionLogprobs[i]) {
              optionLogprobs[i] = lp.logprob;
            }
            anyMatched = true;
          }
        }
      }

      // Fallback to raw emitted token text if logprobs didn't list labels
      if (!anyMatched && firstChoice?.message?.content) {
        const rawOut = firstChoice.message.content.trim();
        for (let i = 0; i < options.length; i++) {
          if (rawOut === labels[i] || rawOut === options[i]) {
            optionLogprobs[i] = 0;
            anyMatched = true;
          }
        }
      }

      if (!anyMatched) {
        return {
          outcome: {
            status: "error",
            error: new SplRecoverableError(
              "DECISION_ERROR",
              "Decision API response did not match any candidate option label",
              true
            ).errObj,
          },
          non_normative_meta: { provider_request_id: resp.id ?? null, latency_ms: Date.now() - startMs },
        };
      }

      // Numerically stable softmax across all candidate options
      const maxLp = Math.max(...optionLogprobs);
      const exps = optionLogprobs.map((lp) => Math.exp(lp - maxLp));
      const sumExp = exps.reduce((a, b) => a + b, 0);
      const probs = exps.map((e) => normalizeFloat(e / sumExp));

      const scores: Record<string, number> = {};
      let bestIdx = 0;
      for (let i = 0; i < options.length; i++) {
        scores[options[i]] = probs[i];
        // Strict `>` guarantees deterministic tie-breaking by option list index
        if (probs[i] > probs[bestIdx]) {
          bestIdx = i;
        }
      }

      const confidence = probs[bestIdx];
      const belowThreshold = cfg.min_confidence !== undefined && confidence < cfg.min_confidence;
      const chosen = belowThreshold ? null : options[bestIdx];

      return {
        outcome: {
          status: "ok",
          value: chosen,
          decision_scores: scores,
          confidence,
        },
        non_normative_meta: {
          provider_request_id: resp.id ?? null,
          latency_ms: Date.now() - startMs,
          usage: resp.usage ?? null,
        },
      };
    } catch (err) {
      return {
        outcome: {
          status: "error",
          error: new SplRecoverableError(
            "DECISION_ERROR",
            err instanceof Error ? err.message : String(err),
            true
          ).errObj,
        },
        non_normative_meta: { latency_ms: Date.now() - startMs },
      };
    }
  }
}

export function loadSplV5LarkGrammar(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "../../grammar/spl_v5.lark"),
    path.resolve(here, "../../../grammar/spl_v5.lark"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      return fs.readFileSync(p, "utf8");
    }
  }
  throw new Error("Could not locate grammar/spl_v5.lark");
}

export type TranslateProgressEvent =
  | { type: "attempt_start"; attempt: number; maxAttempts: number; model: string }
  | { type: "repair"; attempt: number; maxAttempts: number; diagnostics: SplDiagnostic[] }
  | { type: "compiled"; attempt: number; sha256: string; capabilities: string[] };

export interface TranslateOptions {
  prose: string;
  catalog: SignatureCatalog;
  client: OpenAiClientLike;
  model: string;
  maxAttempts?: number;
  temperature?: number;
  maxOutputTokens?: number;
  larkGrammar?: string;
  onProgress?: (event: TranslateProgressEvent) => void;
}

export interface TranslateResult {
  source: string;
  compiled: CompileResult;
  attempts: number;
  diagnosticsHistory: SplDiagnostic[][];
}

/**
 * §2 Prose-to-SPL translation using OpenAI Lark CFG constrained decoding
 * plus bounded compile-repair loop.
 */
export async function translateProseToSpl(opts: TranslateOptions): Promise<TranslateResult> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const grammar = opts.larkGrammar ?? loadSplV5LarkGrammar();
  const diagnosticsHistory: SplDiagnostic[][] = [];

  const catalogSummary = canonicalJsonStringify({
    models: Object.keys(opts.catalog.models),
    decisions: Object.keys(opts.catalog.decisions),
    shell_profiles: Object.fromEntries(
      Object.entries(opts.catalog.shell_profiles).map(([k, v]) => [k, v.params_schema])
    ),
    fs_roots: opts.catalog.fs_roots,
    web: opts.catalog.web,
    js_tools: opts.catalog.js_tools,
    mcp_tools: opts.catalog.mcp_tools,
  });

  const messages: Array<{ role: string; content: string }> = [
    {
      role: "system",
      content: [
        "Translate the user's natural-language specification into valid SPL v5 source code via the emit_spl tool.",
        "Push all classification/judgment to model.decide(...) and generation/extraction to model.ask<T>(...).",
        "VM owns all control flow. Every variable, input, state, and function must be statically typed.",
        `Available Signature Catalog: ${catalogSummary}`,
      ].join("\n"),
    },
    {
      role: "user",
      content: opts.prose,
    },
  ];

  let lastError: SplCompileError | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    opts.onProgress?.({ type: "attempt_start", attempt, maxAttempts, model: opts.model });
    const resp = await opts.client.responses.create(
      {
        model: opts.model,
        input: messages,
        ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
        max_output_tokens: opts.maxOutputTokens ?? 16384,
        store: false,
        tools: [
          {
            type: "custom",
            name: "emit_spl",
            description: "Emit syntactically valid SPL v5 source code conforming to the Lark CFG.",
            format: {
              type: "grammar",
              syntax: "lark",
              definition: grammar,
            },
          },
        ],
        tool_choice: { type: "custom", name: "emit_spl" },
      },
      { maxRetries: 0 }
    );

    const code = extractLarkToolCode(resp);
    try {
      const compiled = compileSource(code, opts.catalog);
      opts.onProgress?.({
        type: "compiled",
        attempt,
        sha256: compiled.sha256,
        capabilities: compiled.program.capabilities,
      });
      return { source: code, compiled, attempts: attempt, diagnosticsHistory };
    } catch (err) {
      if (err instanceof SplCompileError) {
        lastError = err;
        diagnosticsHistory.push(err.diagnostics);
        opts.onProgress?.({ type: "repair", attempt, maxAttempts, diagnostics: err.diagnostics });
        messages.push({ role: "assistant", content: code });
        messages.push({
          role: "user",
          content: `Compilation failed on attempt ${attempt} with diagnostics:\n${canonicalJsonStringify(
            err.diagnostics
          )}\nFix all errors and emit valid SPL v5 source code.`,
        });
        continue;
      }
      throw err;
    }
  }

  throw lastError ?? new Error("Translation failed after maximum attempts");
}

function extractResponseText(resp: {
  output_text?: string;
  output?: Array<{ content?: Array<{ text?: string }> }>;
}): string {
  if (typeof resp.output_text === "string") return resp.output_text;
  if (Array.isArray(resp.output)) {
    const chunks: string[] = [];
    for (const item of resp.output) {
      for (const c of item.content ?? []) {
        if (typeof c.text === "string") chunks.push(c.text);
      }
    }
    return chunks.join("");
  }
  return "";
}

function extractLarkToolCode(resp: {
  output_text?: string;
  output?: Array<{ type?: string; name?: string; input?: string; content?: Array<{ text?: string }> }>;
}): string {
  if (Array.isArray(resp.output)) {
    for (const item of resp.output) {
      if (item.type === "custom_tool_call" && item.name === "emit_spl" && typeof item.input === "string") {
        return item.input;
      }
    }
  }
  return extractResponseText(resp);
}

export function createOfficialOpenAiClient(apiKey = process.env.OPENAI_API_KEY): OpenAiClientLike {
  const client = new OpenAI({ apiKey, maxRetries: 0 });
  return client as unknown as OpenAiClientLike;
}
