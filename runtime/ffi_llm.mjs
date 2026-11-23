// SPL Universal LLM Provider Facade (Browser + Node 22+ / Bun / Deno)
// Supports: "openai_responses", "openai_chat", "anthropic", "google"
// Features: api_key, base_url, model, max_tokens, thinking_effort, json_schema,
//           tools, attachments, and SSE streaming with real-time on_delta callbacks.
import { Ok, Err, Some, None, decode, jsonStringify } from "./core.mjs";
import { translateStandardParams } from "./llm_capabilities.mjs";

// Lazily load Node built-ins only when running on Node/Bun/Deno so this file stays browser-safe
let nodeFs = null;
let nodeOs = null;
let nodePath = null;
if (typeof process !== "undefined" && process.versions && process.versions.node) {
  try {
    const fsSpec = "node:fs";
    const osSpec = "node:os";
    const pathSpec = "node:path";
    nodeFs = await import(/* @vite-ignore */ fsSpec);
    nodeOs = await import(/* @vite-ignore */ osSpec);
    nodePath = await import(/* @vite-ignore */ pathSpec);
  } catch {
    // Non-Node runtime
  }
}

const PROVIDER_ENV_VARS = {
  openai: ["OPENAI_API_KEY"],
  google: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY"],
};

function providerFamily(provider) {
  const p = typeof provider === "string" ? provider.trim().toLowerCase().replace(/-/g, "_") : "";
  if (p === "openai" || p === "openai_responses" || p === "openai_chat" || p === "openai_decisions") return "openai";
  if (p === "google" || p === "gemini" || p === "google_decisions") return "google";
  if (p === "anthropic" || p === "claude") return "anthropic";
  return null;
}

function getCredentialsFilePath() {
  if (!nodeOs || !nodePath) return null;
  if (typeof process !== "undefined" && process.env?.SPL_CREDENTIALS_FILE?.trim()) {
    return process.env.SPL_CREDENTIALS_FILE.trim();
  }
  return nodePath.join(nodeOs.homedir(), ".spl", "credentials.json");
}

function readSavedApiKey(family) {
  if (!family || !nodeFs) return "";
  const filePath = getCredentialsFilePath();
  if (!filePath) return "";
  try {
    if (!nodeFs.existsSync(filePath)) return "";
    const raw = nodeFs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && typeof parsed[family] === "string") {
      return parsed[family].trim();
    }
  } catch {
    // Ignore malformed credentials file
  }
  return "";
}

function readEnvApiKey(family) {
  if (!family || typeof process === "undefined" || !process.env) return "";
  for (const envName of PROVIDER_ENV_VARS[family] ?? []) {
    const val = process.env[envName];
    if (typeof val === "string" && val.trim() !== "") return val.trim();
  }
  return "";
}

function resolveAuthAndBaseUrl(provider, req) {
  const family = providerFamily(provider);
  const explicitKey = typeof req.api_key === "string" ? req.api_key.trim() : "";
  const explicitBase = unwrapOpt(req.base_url, undefined);

  if (explicitKey) {
    return { ok: true, apiKey: explicitKey, baseUrl: req.base_url };
  }

  // 1. Environment variables (OPENAI_API_KEY / GEMINI_API_KEY / GOOGLE_API_KEY / ANTHROPIC_API_KEY)
  const envKey = readEnvApiKey(family);
  if (envKey) {
    return { ok: true, apiKey: envKey, baseUrl: req.base_url };
  }

  // 2. Saved credentials in ~/.spl/credentials.json (created by `spl login`)
  const savedKey = readSavedApiKey(family);
  if (savedKey) {
    return { ok: true, apiKey: savedKey, baseUrl: req.base_url };
  }

  // 3. Browser playground server-side proxy hook (keeps API keys strictly on the server)
  const proxyBase =
    !explicitBase &&
    typeof globalThis !== "undefined" &&
    globalThis.__splLlmProxy &&
    family &&
    typeof globalThis.__splLlmProxy[family] === "string"
      ? globalThis.__splLlmProxy[family]
      : null;
  if (proxyBase) {
    return { ok: true, apiKey: "", baseUrl: Some(proxyBase) };
  }

  const envHint = (PROVIDER_ENV_VARS[family] ?? []).join(" / ");
  return {
    ok: false,
    error: `Missing API key for '${family ?? provider}'. Run 'spl login ${family ?? ""}' to save your token in ~/.spl/credentials.json${envHint ? `, set ${envHint}` : ""}, or pass api_key: "..."`,
  };
}

function unwrapOpt(v, fallback = undefined) {
  if (v && typeof v === "object") {
    if (v.$tag === "Some") return v._0;
    if (v.$tag === "None") return fallback;
  }
  return v ?? fallback;
}

function safeJsonParse(str, fallback = {}) {
  if (str && typeof str === "object") return str;
  if (typeof str !== "string" || str.trim() === "") return fallback;
  try {
    return JSON.parse(str);
  } catch {
    return { raw: str };
  }
}

async function emitDelta(onDelta, kind, text, toolName = null, toolCallId = null) {
  if (typeof onDelta !== "function") return;
  let ev;
  switch (kind) {
    case "text":
      ev = { $tag: "TextDelta", _0: text ?? "" };
      break;
    case "thinking":
      ev = { $tag: "ThinkingDelta", _0: text ?? "" };
      break;
    case "summary":
      ev = { $tag: "SummaryDelta", _0: text ?? "" };
      break;
    case "tool_call":
      ev = { $tag: "ToolCallDelta", _0: toolName ?? "", _1: toolCallId ?? "", _2: text ?? "" };
      break;
    default:
      ev = { $tag: "DoneDelta" };
      break;
  }
  await onDelta(ev);
}

function appendTextBlock(blocks, kind, chunk) {
  if (!chunk) return;
  const last = blocks[blocks.length - 1];
  if (last && last.kind === kind) {
    last.text += chunk;
  } else {
    blocks.push({ kind, text: chunk, tool_call: None });
  }
}

function appendToolBlock(blocks, tc) {
  blocks.push({ kind: "tool_call", text: "", tool_call: Some(tc) });
}

// ==================== SSE Stream Reader ====================

async function* readSseEvents(response) {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let eventName = null;
  let dataLines = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    let nlIdx;
    while ((nlIdx = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nlIdx).replace(/\r$/, "");
      buf = buf.slice(nlIdx + 1);

      if (line === "") {
        if (dataLines.length > 0) {
          yield { event: eventName, data: dataLines.join("\n") };
          eventName = null;
          dataLines = [];
        }
        continue;
      }
      if (line.startsWith(":")) continue;
      if (line.startsWith("event:")) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
  }
  if (dataLines.length > 0) {
    yield { event: eventName, data: dataLines.join("\n") };
  }
}

// ==================== Provider 1: OpenAI Responses API ====================

function toOpenAiResponsesInput(messages) {
  const input = [];
  for (const msg of messages) {
    if (msg.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: unwrapOpt(msg.tool_call_id, ""),
        output: msg.content,
      });
      continue;
    }

    if (msg.role === "assistant" && msg.tool_calls && msg.tool_calls.length > 0) {
      if (msg.content) {
        input.push({ role: "assistant", content: msg.content });
      }
      for (const tc of msg.tool_calls) {
        input.push({
          type: "function_call",
          call_id: tc.id,
          name: tc.name,
          arguments: typeof tc.arguments === "string" ? tc.arguments : JSON.stringify(tc.arguments),
        });
      }
      continue;
    }

    const attachments = msg.attachments ?? [];
    if (attachments.length === 0) {
      input.push({ role: msg.role, content: msg.content });
    } else {
      const content = [];
      if (msg.content) content.push({ type: "input_text", text: msg.content });
      for (const att of attachments) {
        if (att.kind === "image_url") {
          content.push({ type: "input_image", image_url: att.data });
        } else if (att.kind === "image_base64") {
          content.push({ type: "input_image", image_url: `data:${att.mime_type};base64,${att.data}` });
        } else if (att.kind === "file_base64") {
          content.push({
            type: "input_file",
            filename: unwrapOpt(att.name, "attachment"),
            file_data: `data:${att.mime_type};base64,${att.data}`,
          });
        } else {
          content.push({ type: "input_text", text: att.data });
        }
      }
      input.push({ role: msg.role, content });
    }
  }
  return input;
}

async function callOpenAiResponses(req, onDelta) {
  const baseUrl = (unwrapOpt(req.base_url, "https://api.openai.com/v1")).replace(/\/+$/, "");
  const url = `${baseUrl}/responses`;
  const schema = unwrapOpt(req.json_schema);
  const system = unwrapOpt(req.system);
  const tools = req.tools ?? [];
  const { params, warnings } = translateStandardParams("openai_responses", req);

  const body = {
    model: req.model,
    input: toOpenAiResponsesInput(req.messages),
    stream: Boolean(req.stream),
    ...params,
  };
  if (system) body.instructions = system;
  if (schema != null) {
    body.text = {
      format: {
        type: "json_schema",
        name: schema.title || "spl_output",
        schema,
        strict: true,
      },
    };
  }
  if (tools.length > 0) {
    body.tools = tools.map((t) => ({
      type: "function",
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
  }

  const headers = { "content-type": "application/json" };
  if (req.api_key) headers.authorization = `Bearer ${req.api_key}`;
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    return Err(`openai_responses HTTP ${res.status}: ${await res.text()}`);
  }

  if (req.stream) {
    let text = "";
    let thinking = "";
    const callMap = new Map(); // item_id/call_id -> { id, name, argsStr, blockRef }
    const blocks = [];
    let usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
    let finishReason = "stop";
    let finalRaw = {};

    for await (const ev of readSseEvents(res)) {
      if (ev.data === "[DONE]") break;
      const chunk = safeJsonParse(ev.data, null);
      if (!chunk) continue;
      const type = ev.event || chunk.type;

      if (type === "response.output_text.delta" && typeof chunk.delta === "string") {
        text += chunk.delta;
        appendTextBlock(blocks, "text", chunk.delta);
        await emitDelta(onDelta, "text", chunk.delta);
      } else if (
        (type === "response.reasoning_summary_text.delta" || type === "response.reasoning_summary.delta") &&
        typeof chunk.delta === "string"
      ) {
        thinking += chunk.delta;
        appendTextBlock(blocks, "thinking", chunk.delta);
        await emitDelta(onDelta, "summary", chunk.delta);
      } else if (type === "response.reasoning_text.delta" && typeof chunk.delta === "string") {
        thinking += chunk.delta;
        appendTextBlock(blocks, "thinking", chunk.delta);
        await emitDelta(onDelta, "thinking", chunk.delta);
      } else if (type === "response.output_item.added" && chunk.item?.type === "function_call") {
        const key = chunk.item.id || chunk.item.call_id;
        const placeholder = { kind: "tool_call", text: "", tool_call: None };
        blocks.push(placeholder);
        callMap.set(key, {
          id: chunk.item.call_id || chunk.item.id,
          name: chunk.item.name || "",
          argsStr: chunk.item.arguments || "",
          blockRef: placeholder,
        });
      } else if (type === "response.function_call_arguments.delta") {
        const key = chunk.item_id || chunk.call_id;
        let entry = callMap.get(key);
        if (!entry) {
          const placeholder = { kind: "tool_call", text: "", tool_call: None };
          blocks.push(placeholder);
          entry = { id: key, name: chunk.name || "", argsStr: "", blockRef: placeholder };
        }
        entry.argsStr += chunk.delta || "";
        callMap.set(key, entry);
        await emitDelta(onDelta, "tool_call", chunk.delta || "", entry.name, entry.id);
      } else if (type === "response.output_item.done" && chunk.item?.type === "function_call") {
        const key = chunk.item.id || chunk.item.call_id;
        const existing = callMap.get(key);
        const blockRef = existing?.blockRef ?? (() => {
          const placeholder = { kind: "tool_call", text: "", tool_call: None };
          blocks.push(placeholder);
          return placeholder;
        })();
        callMap.set(key, {
          id: chunk.item.call_id || chunk.item.id,
          name: chunk.item.name,
          argsStr: chunk.item.arguments || "{}",
          blockRef,
        });
      } else if (type === "response.completed" && chunk.response) {
        finalRaw = chunk.response;
        const u = chunk.response.usage;
        if (u) {
          usage = {
            input_tokens: u.input_tokens ?? 0,
            output_tokens: u.output_tokens ?? 0,
            total_tokens: u.total_tokens ?? (u.input_tokens ?? 0) + (u.output_tokens ?? 0),
          };
        }
        finishReason = chunk.response.status || "completed";
      }
    }

    const toolCalls = Array.from(callMap.values()).map((c) => {
      const tc = {
        id: c.id,
        name: c.name,
        arguments: safeJsonParse(c.argsStr, {}),
      };
      if (c.blockRef) c.blockRef.tool_call = Some(tc);
      return tc;
    });
    if (toolCalls.length > 0) finishReason = "tool_calls";
    await emitDelta(onDelta, "done", "");

    return Ok({
      text,
      thinking: thinking ? Some(thinking) : None,
      tool_calls: toolCalls,
      blocks,
      finish_reason: finishReason,
      usage,
      warnings,
      raw: finalRaw,
    });
  }

  const data = await res.json();
  let text = "";
  let thinking = "";
  const toolCalls = [];
  const blocks = [];

  for (const item of data.output ?? []) {
    if (item.type === "message") {
      for (const part of item.content ?? []) {
        if ((part.type === "output_text" || part.type === "text") && part.text) {
          text += part.text;
          appendTextBlock(blocks, "text", part.text);
        }
      }
    } else if (item.type === "reasoning") {
      for (const s of item.summary ?? []) {
        if (s.text) {
          thinking += (thinking ? "\n" : "") + s.text;
          appendTextBlock(blocks, "thinking", s.text);
        }
      }
    } else if (item.type === "function_call") {
      const tc = {
        id: item.call_id || item.id || `call_${toolCalls.length}`,
        name: item.name,
        arguments: safeJsonParse(item.arguments, {}),
      };
      toolCalls.push(tc);
      appendToolBlock(blocks, tc);
    }
  }
  if (!text && typeof data.output_text === "string" && data.output_text) {
    text = data.output_text;
    appendTextBlock(blocks, "text", text);
  }

  const u = data.usage ?? {};
  return Ok({
    text,
    thinking: thinking ? Some(thinking) : None,
    tool_calls: toolCalls,
    blocks,
    finish_reason: toolCalls.length > 0 ? "tool_calls" : (data.status || "stop"),
    usage: {
      input_tokens: u.input_tokens ?? 0,
      output_tokens: u.output_tokens ?? 0,
      total_tokens: u.total_tokens ?? (u.input_tokens ?? 0) + (u.output_tokens ?? 0),
    },
    warnings,
    raw: data,
  });
}

// ==================== Provider 2: OpenAI Chat Completions API ====================

function toOpenAiChatMessages(system, messages) {
  const out = [];
  if (system) out.push({ role: "system", content: system });

  for (const msg of messages) {
    if (msg.role === "tool") {
      out.push({
        role: "tool",
        tool_call_id: unwrapOpt(msg.tool_call_id, ""),
        content: msg.content,
      });
      continue;
    }

    if (msg.role === "assistant" && msg.tool_calls && msg.tool_calls.length > 0) {
      out.push({
        role: "assistant",
        content: msg.content || null,
        tool_calls: msg.tool_calls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: {
            name: tc.name,
            arguments: typeof tc.arguments === "string" ? tc.arguments : JSON.stringify(tc.arguments),
          },
        })),
      });
      continue;
    }

    const attachments = msg.attachments ?? [];
    if (attachments.length === 0) {
      out.push({ role: msg.role, content: msg.content });
    } else {
      const parts = [];
      if (msg.content) parts.push({ type: "text", text: msg.content });
      for (const att of attachments) {
        if (att.kind === "image_url") {
          parts.push({ type: "image_url", image_url: { url: att.data } });
        } else if (att.kind === "image_base64") {
          parts.push({ type: "image_url", image_url: { url: `data:${att.mime_type};base64,${att.data}` } });
        } else if (att.kind === "file_base64") {
          parts.push({
            type: "file",
            file: {
              filename: unwrapOpt(att.name, "attachment"),
              file_data: `data:${att.mime_type};base64,${att.data}`,
            },
          });
        } else {
          parts.push({ type: "text", text: att.data });
        }
      }
      out.push({ role: msg.role, content: parts });
    }
  }
  return out;
}

async function callOpenAiChat(req, onDelta) {
  const baseUrl = (unwrapOpt(req.base_url, "https://api.openai.com/v1")).replace(/\/+$/, "");
  const url = `${baseUrl}/chat/completions`;
  const schema = unwrapOpt(req.json_schema);
  const system = unwrapOpt(req.system);
  const tools = req.tools ?? [];
  const { params, warnings } = translateStandardParams("openai_chat", req);

  const body = {
    model: req.model,
    messages: toOpenAiChatMessages(system, req.messages),
    stream: Boolean(req.stream),
    ...params,
  };
  if (req.stream) body.stream_options = { include_usage: true };
  if (schema != null) {
    body.response_format = {
      type: "json_schema",
      json_schema: {
        name: schema.title || "spl_output",
        schema,
        strict: true,
      },
    };
  }
  if (tools.length > 0) {
    body.tools = tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
  }

  const headers = { "content-type": "application/json" };
  if (req.api_key) headers.authorization = `Bearer ${req.api_key}`;
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    return Err(`openai_chat HTTP ${res.status}: ${await res.text()}`);
  }

  if (req.stream) {
    let text = "";
    let thinking = "";
    const callByIdx = new Map();
    const blocks = [];
    let finishReason = "stop";
    let usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
    let lastChunk = {};

    for await (const ev of readSseEvents(res)) {
      if (ev.data === "[DONE]") break;
      const chunk = safeJsonParse(ev.data, null);
      if (!chunk) continue;
      lastChunk = chunk;

      if (chunk.usage) {
        usage = {
          input_tokens: chunk.usage.prompt_tokens ?? 0,
          output_tokens: chunk.usage.completion_tokens ?? 0,
          total_tokens: chunk.usage.total_tokens ?? 0,
        };
      }
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const delta = choice.delta ?? {};

      const rDelta = delta.reasoning_content ?? delta.reasoning;
      if (typeof rDelta === "string" && rDelta.length > 0) {
        thinking += rDelta;
        appendTextBlock(blocks, "thinking", rDelta);
        await emitDelta(onDelta, "thinking", rDelta);
      }
      if (typeof delta.content === "string" && delta.content.length > 0) {
        text += delta.content;
        appendTextBlock(blocks, "text", delta.content);
        await emitDelta(onDelta, "text", delta.content);
      }
      for (const tc of delta.tool_calls ?? []) {
        const idx = tc.index ?? 0;
        let entry = callByIdx.get(idx);
        if (!entry) {
          const placeholder = { kind: "tool_call", text: "", tool_call: None };
          blocks.push(placeholder);
          entry = { id: tc.id || `call_${idx}`, name: "", argsStr: "", blockRef: placeholder };
        }
        if (tc.id) entry.id = tc.id;
        if (tc.function?.name) entry.name += tc.function.name;
        if (tc.function?.arguments) entry.argsStr += tc.function.arguments;
        callByIdx.set(idx, entry);
        await emitDelta(onDelta, "tool_call", tc.function?.arguments || "", entry.name, entry.id);
      }
    }

    const toolCalls = Array.from(callByIdx.values()).map((c) => {
      const tc = {
        id: c.id,
        name: c.name,
        arguments: safeJsonParse(c.argsStr, {}),
      };
      if (c.blockRef) c.blockRef.tool_call = Some(tc);
      return tc;
    });
    await emitDelta(onDelta, "done", "");

    return Ok({
      text,
      thinking: thinking ? Some(thinking) : None,
      tool_calls: toolCalls,
      blocks,
      finish_reason: toolCalls.length > 0 ? "tool_calls" : finishReason,
      usage,
      warnings,
      raw: lastChunk,
    });
  }

  const data = await res.json();
  const choice = data.choices?.[0] ?? {};
  const msg = choice.message ?? {};
  const blocks = [];
  const thinking = msg.reasoning_content ?? msg.reasoning ?? "";
  if (thinking) appendTextBlock(blocks, "thinking", thinking);
  if (msg.content) appendTextBlock(blocks, "text", msg.content);
  const toolCalls = (msg.tool_calls ?? []).map((tc, i) => {
    const parsed = {
      id: tc.id || `call_${i}`,
      name: tc.function?.name || tc.name,
      arguments: safeJsonParse(tc.function?.arguments, {}),
    };
    appendToolBlock(blocks, parsed);
    return parsed;
  });
  const u = data.usage ?? {};

  return Ok({
    text: msg.content ?? "",
    thinking: thinking ? Some(thinking) : None,
    tool_calls: toolCalls,
    blocks,
    finish_reason: choice.finish_reason || (toolCalls.length > 0 ? "tool_calls" : "stop"),
    usage: {
      input_tokens: u.prompt_tokens ?? 0,
      output_tokens: u.completion_tokens ?? 0,
      total_tokens: u.total_tokens ?? (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0),
    },
    warnings,
    raw: data,
  });
}

// ==================== Provider 3: Anthropic Messages API ====================

function toAnthropicMessages(messages) {
  const out = [];
  for (const msg of messages) {
    if (msg.role === "tool") {
      const block = {
        type: "tool_result",
        tool_use_id: unwrapOpt(msg.tool_call_id, ""),
        content: msg.content,
      };
      // Group consecutive tool_result blocks into a single user message (Anthropic spec)
      const prev = out[out.length - 1];
      if (prev && prev.role === "user" && Array.isArray(prev.content) && prev.content[0]?.type === "tool_result") {
        prev.content.push(block);
      } else {
        out.push({ role: "user", content: [block] });
      }
      continue;
    }

    if (msg.role === "assistant" && msg.tool_calls && msg.tool_calls.length > 0) {
      const content = [];
      if (msg.content) content.push({ type: "text", text: msg.content });
      for (const tc of msg.tool_calls) {
        content.push({
          type: "tool_use",
          id: tc.id,
          name: tc.name,
          input: safeJsonParse(tc.arguments, {}),
        });
      }
      out.push({ role: "assistant", content });
      continue;
    }

    const attachments = msg.attachments ?? [];
    if (attachments.length === 0) {
      out.push({ role: msg.role, content: msg.content });
    } else {
      const blocks = [];
      for (const att of attachments) {
        if (att.kind === "image_base64") {
          blocks.push({
            type: "image",
            source: { type: "base64", media_type: att.mime_type, data: att.data },
          });
        } else if (att.kind === "image_url") {
          blocks.push({
            type: "image",
            source: { type: "url", url: att.data },
          });
        } else if (att.kind === "file_base64") {
          blocks.push({
            type: "document",
            source: { type: "base64", media_type: att.mime_type, data: att.data },
          });
        } else {
          blocks.push({ type: "text", text: att.data });
        }
      }
      if (msg.content) blocks.push({ type: "text", text: msg.content });
      out.push({ role: msg.role, content: blocks });
    }
  }
  return out;
}

async function callAnthropic(req, onDelta) {
  const baseUrl = (unwrapOpt(req.base_url, "https://api.anthropic.com")).replace(/\/+$/, "");
  const url = `${baseUrl}/v1/messages`;
  const schema = unwrapOpt(req.json_schema);
  const system = unwrapOpt(req.system);
  const tools = req.tools ?? [];
  const { params, warnings } = translateStandardParams("anthropic", req);

  const body = {
    model: req.model,
    messages: toAnthropicMessages(req.messages),
    stream: Boolean(req.stream),
    ...params,
  };
  if (system) body.system = system;
  if (schema != null) {
    body.output_config = {
      format: { type: "json_schema", schema },
    };
  }
  if (tools.length > 0) {
    body.tools = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }));
  }

  const headers = {
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
  };
  if (req.api_key) headers["x-api-key"] = req.api_key;
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    return Err(`anthropic HTTP ${res.status}: ${await res.text()}`);
  }

  if (req.stream) {
    let text = "";
    let thinking = "";
    const blocks = new Map(); // index -> { type, id, name, text, argsStr }
    let finishReason = "end_turn";
    const usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
    let lastEvent = {};

    for await (const ev of readSseEvents(res)) {
      const chunk = safeJsonParse(ev.data, null);
      if (!chunk) continue;
      lastEvent = chunk;
      const type = ev.event || chunk.type;

      if (type === "message_start" && chunk.message?.usage) {
        usage.input_tokens = chunk.message.usage.input_tokens ?? 0;
      } else if (type === "content_block_start" && chunk.content_block) {
        const b = chunk.content_block;
        blocks.set(chunk.index, {
          type: b.type,
          id: b.id || "",
          name: b.name || "",
          text: "",
          argsStr: "",
        });
      } else if (type === "content_block_delta" && chunk.delta) {
        const d = chunk.delta;
        const idx = chunk.index ?? 0;
        if (d.type === "text_delta" && typeof d.text === "string") {
          text += d.text;
          const b = blocks.get(idx) ?? { type: "text", id: "", name: "", text: "", argsStr: "" };
          b.text += d.text;
          blocks.set(idx, b);
          await emitDelta(onDelta, "text", d.text);
        } else if (d.type === "thinking_delta" && typeof d.thinking === "string") {
          thinking += d.thinking;
          const b = blocks.get(idx) ?? { type: "thinking", id: "", name: "", text: "", argsStr: "" };
          b.text += d.thinking;
          blocks.set(idx, b);
          await emitDelta(onDelta, "thinking", d.thinking);
        } else if (d.type === "input_json_delta" && typeof d.partial_json === "string") {
          const b = blocks.get(idx);
          if (b) {
            b.argsStr += d.partial_json;
            await emitDelta(onDelta, "tool_call", d.partial_json, b.name, b.id);
          }
        }
      } else if (type === "message_delta") {
        if (chunk.delta?.stop_reason) finishReason = chunk.delta.stop_reason;
        if (chunk.usage?.output_tokens != null) usage.output_tokens = chunk.usage.output_tokens;
      }
    }

    usage.total_tokens = usage.input_tokens + usage.output_tokens;
    const orderedBlocks = [];
    const toolCalls = [];
    for (const [, b] of Array.from(blocks.entries()).sort((a, b) => a[0] - b[0])) {
      if (b.type === "thinking" && b.text) {
        orderedBlocks.push({ kind: "thinking", text: b.text, tool_call: None });
      } else if (b.type === "text" && b.text) {
        orderedBlocks.push({ kind: "text", text: b.text, tool_call: None });
      } else if (b.type === "tool_use") {
        const tc = { id: b.id, name: b.name, arguments: safeJsonParse(b.argsStr, {}) };
        toolCalls.push(tc);
        appendToolBlock(orderedBlocks, tc);
      }
    }
    await emitDelta(onDelta, "done", "");

    return Ok({
      text,
      thinking: thinking ? Some(thinking) : None,
      tool_calls: toolCalls,
      blocks: orderedBlocks,
      finish_reason: toolCalls.length > 0 ? "tool_calls" : finishReason,
      usage,
      warnings,
      raw: lastEvent,
    });
  }

  const data = await res.json();
  let text = "";
  let thinking = "";
  const toolCalls = [];
  const orderedBlocks = [];

  for (const block of data.content ?? []) {
    if (block.type === "text") {
      const txt = block.text ?? "";
      text += txt;
      appendTextBlock(orderedBlocks, "text", txt);
    } else if (block.type === "thinking") {
      const th = block.thinking ?? "";
      thinking += (thinking ? "\n" : "") + th;
      appendTextBlock(orderedBlocks, "thinking", th);
    } else if (block.type === "tool_use") {
      const tc = {
        id: block.id,
        name: block.name,
        arguments: block.input ?? {},
      };
      toolCalls.push(tc);
      appendToolBlock(orderedBlocks, tc);
    }
  }

  const u = data.usage ?? {};
  const inp = u.input_tokens ?? 0;
  const out = u.output_tokens ?? 0;
  return Ok({
    text,
    thinking: thinking ? Some(thinking) : None,
    tool_calls: toolCalls,
    blocks: orderedBlocks,
    finish_reason: toolCalls.length > 0 ? "tool_calls" : (data.stop_reason || "end_turn"),
    usage: { input_tokens: inp, output_tokens: out, total_tokens: inp + out },
    warnings,
    raw: data,
  });
}

// ==================== Provider 4: Google Gemini API ====================

function toGoogleContents(messages) {
  const contents = [];
  for (const msg of messages) {
    if (msg.role === "tool") {
      contents.push({
        role: "user",
        parts: [
          {
            functionResponse: {
              name: unwrapOpt(msg.tool_name, "tool"),
              response: safeJsonParse(msg.content, { result: msg.content }),
            },
          },
        ],
      });
      continue;
    }

    const role = msg.role === "assistant" ? "model" : "user";
    const parts = [];
    if (msg.content) parts.push({ text: msg.content });

    for (const att of msg.attachments ?? []) {
      if (att.kind === "image_base64" || att.kind === "file_base64") {
        parts.push({ inlineData: { mimeType: att.mime_type, data: att.data } });
      } else if (att.kind === "image_url") {
        parts.push({ fileData: { mimeType: att.mime_type, fileUri: att.data } });
      } else {
        parts.push({ text: att.data });
      }
    }

    for (const tc of msg.tool_calls ?? []) {
      parts.push({
        functionCall: {
          name: tc.name,
          args: safeJsonParse(tc.arguments, {}),
        },
      });
    }

    contents.push({ role, parts });
  }
  return contents;
}

async function callGoogle(req, onDelta) {
  const baseUrl = (unwrapOpt(req.base_url, "https://generativelanguage.googleapis.com")).replace(/\/+$/, "");
  const method = req.stream ? "streamGenerateContent?alt=sse" : "generateContent";
  const url = `${baseUrl}/v1beta/models/${encodeURIComponent(req.model)}:${method}`;
  const schema = unwrapOpt(req.json_schema);
  const system = unwrapOpt(req.system);
  const tools = req.tools ?? [];
  const { params, warnings } = translateStandardParams("google", req);

  const { toolConfig, ...genFields } = params;
  const generationConfig = { ...genFields };
  if (schema != null) {
    generationConfig.responseMimeType = "application/json";
    generationConfig.responseSchema = schema;
  }

  const body = {
    contents: toGoogleContents(req.messages),
  };
  if (Object.keys(generationConfig).length > 0) body.generationConfig = generationConfig;
  if (toolConfig) body.toolConfig = toolConfig;
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  if (tools.length > 0) {
    body.tools = [
      {
        functionDeclarations: tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })),
      },
    ];
  }

  const headers = { "content-type": "application/json" };
  if (req.api_key) headers["x-goog-api-key"] = req.api_key;
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    return Err(`google HTTP ${res.status}: ${await res.text()}`);
  }

  if (req.stream) {
    let text = "";
    let thinking = "";
    const toolCalls = [];
    const blocks = [];
    let finishReason = "STOP";
    const usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
    let lastChunk = {};

    for await (const ev of readSseEvents(res)) {
      const chunk = safeJsonParse(ev.data, null);
      if (!chunk) continue;
      lastChunk = chunk;

      if (chunk.usageMetadata) {
        usage.input_tokens = chunk.usageMetadata.promptTokenCount ?? usage.input_tokens;
        usage.output_tokens = chunk.usageMetadata.candidatesTokenCount ?? usage.output_tokens;
        usage.total_tokens = chunk.usageMetadata.totalTokenCount ?? (usage.input_tokens + usage.output_tokens);
      }
      const cand = chunk.candidates?.[0];
      if (!cand) continue;
      if (cand.finishReason) finishReason = cand.finishReason;

      for (const part of cand.content?.parts ?? []) {
        if (part.thought && typeof part.text === "string") {
          thinking += part.text;
          appendTextBlock(blocks, "thinking", part.text);
          await emitDelta(onDelta, "thinking", part.text);
        } else if (typeof part.text === "string") {
          text += part.text;
          appendTextBlock(blocks, "text", part.text);
          await emitDelta(onDelta, "text", part.text);
        } else if (part.functionCall) {
          const callId = `google_call_${toolCalls.length}`;
          const tc = {
            id: callId,
            name: part.functionCall.name,
            arguments: part.functionCall.args ?? {},
          };
          toolCalls.push(tc);
          appendToolBlock(blocks, tc);
          await emitDelta(
            onDelta,
            "tool_call",
            JSON.stringify(part.functionCall.args ?? {}),
            part.functionCall.name,
            callId
          );
        }
      }
    }

    await emitDelta(onDelta, "done", "");
    return Ok({
      text,
      thinking: thinking ? Some(thinking) : None,
      tool_calls: toolCalls,
      blocks,
      finish_reason: toolCalls.length > 0 ? "tool_calls" : finishReason,
      usage,
      warnings,
      raw: lastChunk,
    });
  }

  const data = await res.json();
  const cand = data.candidates?.[0] ?? {};
  let text = "";
  let thinking = "";
  const toolCalls = [];
  const blocks = [];

  for (const part of cand.content?.parts ?? []) {
    if (part.thought && typeof part.text === "string") {
      thinking += (thinking ? "\n" : "") + part.text;
      appendTextBlock(blocks, "thinking", part.text);
    } else if (typeof part.text === "string") {
      text += part.text;
      appendTextBlock(blocks, "text", part.text);
    } else if (part.functionCall) {
      const tc = {
        id: `google_call_${toolCalls.length}`,
        name: part.functionCall.name,
        arguments: part.functionCall.args ?? {},
      };
      toolCalls.push(tc);
      appendToolBlock(blocks, tc);
    }
  }

  const u = data.usageMetadata ?? {};
  const inp = u.promptTokenCount ?? 0;
  const out = u.candidatesTokenCount ?? 0;
  return Ok({
    text,
    thinking: thinking ? Some(thinking) : None,
    tool_calls: toolCalls,
    blocks,
    finish_reason: toolCalls.length > 0 ? "tool_calls" : (cand.finishReason || "STOP"),
    usage: {
      input_tokens: inp,
      output_tokens: out,
      total_tokens: u.totalTokenCount ?? (inp + out),
    },
    warnings,
    raw: data,
  });
}

// ==================== Decisions API (OpenAI /v1/decisions & Google /v1beta/decisions) ====================

function buildOpenAiDecisionInput(text, attachments) {
  if (!attachments || attachments.length === 0) return text;
  const content = [];
  if (text) content.push({ type: "input_text", text });
  for (const att of attachments) {
    if (att.kind === "image_url") {
      content.push({ type: "input_image", image_url: att.data });
    } else if (att.kind === "image_base64") {
      content.push({ type: "input_image", image_url: `data:${att.mime_type};base64,${att.data}` });
    } else if (att.kind === "file_base64") {
      content.push({
        type: "input_file",
        filename: unwrapOpt(att.name, "attachment"),
        file_data: `data:${att.mime_type};base64,${att.data}`,
      });
    } else {
      content.push({ type: "input_text", text: att.data });
    }
  }
  return [{ role: "user", content }];
}

function buildGoogleDecisionInput(text, attachments) {
  if (!attachments || attachments.length === 0) return text;
  const blocks = [];
  if (text) blocks.push({ type: "text", text });
  for (const att of attachments) {
    if (att.kind === "image_url") {
      blocks.push({ type: "image", uri: att.data, mime_type: att.mime_type });
    } else if (att.kind === "image_base64") {
      blocks.push({ type: "image", data: att.data, mime_type: att.mime_type });
    } else if (att.kind === "file_base64") {
      blocks.push({ type: "document", data: att.data, mime_type: att.mime_type });
    } else {
      blocks.push({ type: "text", text: att.data });
    }
  }
  return blocks;
}

async function callOpenAiDecisions(req) {
  const baseUrl = (unwrapOpt(req.base_url, "https://api.openai.com/v1")).replace(/\/+$/, "");
  const url = `${baseUrl}/decisions`;
  const cacheKey = unwrapOpt(req.prompt_cache_key);

  const questions = (req.questions ?? []).map((q) => {
    const k = q.kind;
    if (k.$tag === "Predicate") {
      return { name: q.name, type: "predicate", instructions: q.instructions };
    }
    if (k.$tag === "Choice") {
      const choices = (k._0 ?? []).map((pair) => pair[0]);
      return { name: q.name, type: "choice", instructions: q.instructions, choices };
    }
    if (k.$tag === "Score") {
      return { name: q.name, type: "score", instructions: q.instructions, levels: k._0 ?? [] };
    }
    return { name: q.name, type: "predicate", instructions: q.instructions };
  });

  const body = {
    model: req.model,
    input: buildOpenAiDecisionInput(req.input, req.attachments),
    questions,
  };
  if (cacheKey) body.prompt_cache_key = cacheKey;

  const headers = { "content-type": "application/json" };
  if (req.api_key) headers.authorization = `Bearer ${req.api_key}`;
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    return Err(`openai_decisions HTTP ${res.status}: ${await res.text()}`);
  }

  const data = await res.json();
  const answersMap = new Map();
  const answerList = [];

  for (const a of data.answers ?? []) {
    const probs = new Map();
    let value;
    let topProb = 0;

    if (a.type === "predicate") {
      const p = Number(a.probability ?? 0);
      topProb = p;
      probs.set("true", p);
      probs.set("false", Math.max(0, 1 - p));
      value = { $tag: "BoolAnswer", _0: p >= 0.5 };
    } else if (a.type === "choice") {
      for (const entry of a.probabilities ?? []) {
        probs.set(String(entry.value), Number(entry.probability ?? 0));
      }
      const chosen = String(a.choice ?? "");
      topProb = probs.get(chosen) ?? Number(a.probability ?? 0);
      value = { $tag: "ChoiceAnswer", _0: chosen };
    } else {
      for (const entry of a.probabilities ?? []) {
        probs.set(String(entry.value ?? entry.level ?? ""), Number(entry.probability ?? 0));
      }
      const sc = Number(a.score ?? 0);
      topProb = Number(a.probability ?? Math.max(0, ...probs.values()));
      value = { $tag: "ScoreAnswer", _0: sc };
    }

    const normalized = {
      name: a.name,
      kind: a.type,
      value,
      probability: topProb,
      probabilities: probs,
      confidence: Number(a.confidence ?? 0),
      refusal: a.refusal ? Some(String(a.refusal)) : None,
    };
    answersMap.set(a.name, normalized);
    answerList.push(normalized);
  }

  const u = data.usage ?? {};
  return Ok({
    provider: "openai",
    model: data.model || req.model,
    answers: answersMap,
    answer_list: answerList,
    usage: {
      input_tokens: u.input_tokens ?? 0,
      output_tokens: u.output_tokens ?? 0,
      total_tokens: u.total_tokens ?? (u.input_tokens ?? 0) + (u.output_tokens ?? 0),
    },
    raw: data,
  });
}

async function callGoogleDecisions(req) {
  const baseUrl = (unwrapOpt(req.base_url, "https://generativelanguage.googleapis.com")).replace(/\/+$/, "");
  const url = `${baseUrl}/v1beta/decisions`;

  const questions = {};
  const questionKinds = new Map();
  for (const q of req.questions ?? []) {
    const k = q.kind;
    if (k.$tag === "Predicate") {
      questionKinds.set(q.name, "predicate");
      const criteria = {};
      const tDesc = unwrapOpt(k._0);
      const fDesc = unwrapOpt(k._1);
      if (tDesc) criteria.true_description = tDesc;
      if (fDesc) criteria.false_description = fDesc;
      const entry = { type: "noul", instructions: q.instructions };
      if (Object.keys(criteria).length > 0) entry.criteria = criteria;
      questions[q.name] = entry;
    } else if (k.$tag === "Choice") {
      questionKinds.set(q.name, "choice");
      const criteria = {};
      for (const pair of k._0 ?? []) {
        const label = pair[0];
        const desc = unwrapOpt(pair[1], null);
        criteria[label] = desc;
      }
      questions[q.name] = { type: "choice", instructions: q.instructions, criteria };
    } else if (k.$tag === "Score") {
      questionKinds.set(q.name, "score");
      const criteria = {};
      const levels = k._0 ?? [];
      for (let idx = 0; idx < levels.length; idx++) {
        criteria[String(idx)] = levels[idx];
      }
      questions[q.name] = { type: "score", instructions: q.instructions, criteria };
    }
  }

  const body = {
    model: req.model,
    input: buildGoogleDecisionInput(req.input, req.attachments),
    questions,
  };

  const headers = { "content-type": "application/json" };
  if (req.api_key) headers["x-goog-api-key"] = req.api_key;
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    return Err(`google_decisions HTTP ${res.status}: ${await res.text()}`);
  }

  const data = await res.json();
  const answersMap = new Map();
  const answerList = [];

  for (const [name, ans] of Object.entries(data.answers ?? {})) {
    const kind = questionKinds.get(name) || (typeof ans.value === "boolean" ? "predicate" : typeof ans.value === "number" ? "score" : "choice");
    const probs = new Map();
    if (ans.probabilities && typeof ans.probabilities === "object") {
      for (const [k, v] of Object.entries(ans.probabilities)) {
        probs.set(String(k), Number(v ?? 0));
      }
    }

    let value;
    let topProb = Number(ans.probability ?? 0);
    if (kind === "predicate") {
      const boolVal = Boolean(ans.value);
      if (probs.size === 0) {
        probs.set("true", topProb);
        probs.set("false", Math.max(0, 1 - topProb));
      }
      value = { $tag: "BoolAnswer", _0: boolVal };
    } else if (kind === "choice") {
      const strVal = String(ans.value ?? "");
      if (!topProb && probs.has(strVal)) topProb = probs.get(strVal);
      value = { $tag: "ChoiceAnswer", _0: strVal };
    } else {
      const numVal = Number(ans.value ?? 0);
      if (!topProb && probs.size > 0) topProb = Math.max(...probs.values());
      value = { $tag: "ScoreAnswer", _0: numVal };
    }

    const normalized = {
      name,
      kind,
      value,
      probability: topProb,
      probabilities: probs,
      confidence: Number(ans.confidence ?? 0),
      refusal: ans.refusal ? Some(String(ans.refusal)) : None,
    };
    answersMap.set(name, normalized);
    answerList.push(normalized);
  }

  const u = data.usage_metadata ?? {};
  const inp = u.input_token_count ?? 0;
  const out = u.output_token_count ?? 0;
  return Ok({
    provider: "google",
    model: req.model,
    answers: answersMap,
    answer_list: answerList,
    usage: {
      input_tokens: inp,
      output_tokens: out,
      total_tokens: u.total_token_count ?? (inp + out),
    },
    raw: data,
  });
}

export async function llmDecide(req) {
  const debugHook = typeof globalThis !== "undefined" ? globalThis.__splLlmDebugHook : null;
  try {
    let curReq = req;
    let callId = 0;
    if (debugHook && typeof debugHook.beforeDecide === "function") {
      const dec = await debugHook.beforeDecide(curReq);
      if (dec) {
        if (typeof dec.callId === "number") callId = dec.callId;
        if (dec.req) curReq = dec.req;
        if (dec.action === "abort") {
          const aborted = Err(dec.error ?? "Aborted by SPL debugger");
          return typeof debugHook.afterDecide === "function"
            ? await debugHook.afterDecide(curReq, aborted, 0, callId)
            : aborted;
        }
        if (dec.action === "mock") {
          const mocked = Ok(dec.response);
          return typeof debugHook.afterDecide === "function"
            ? await debugHook.afterDecide(curReq, mocked, 0, callId)
            : mocked;
        }
      }
    }

    const t0 = Date.now();
    const provider =
      typeof curReq.provider === "string"
        ? curReq.provider.trim().toLowerCase().replace(/-/g, "_")
        : curReq.provider;
    const auth = resolveAuthAndBaseUrl(provider, curReq);
    let result;
    if (!auth.ok) {
      result = Err(auth.error);
    } else {
      const effectiveReq = { ...curReq, api_key: auth.apiKey, base_url: auth.baseUrl };
      switch (provider) {
        case "openai":
        case "openai_responses":
        case "openai_decisions":
          result = await callOpenAiDecisions(effectiveReq);
          break;
        case "google":
        case "google_decisions":
          result = await callGoogleDecisions(effectiveReq);
          break;
        default:
          result = Err(
            `Unknown Decisions API provider '${curReq.provider}'. Expected 'openai' or 'google'`
          );
          break;
      }
    }
    const elapsedMs = Date.now() - t0;
    if (debugHook && typeof debugHook.afterDecide === "function") {
      return await debugHook.afterDecide(curReq, result, elapsedMs, callId);
    }
    return result;
  } catch (e) {
    return Err(e instanceof Error ? e.message : String(e));
  }
}

// ==================== Reified Typed Output Helpers ====================

/**
 * Generates an optional JSON Schema from the reified target type `T`:
 * - Returns `None` for `Str` / `Unit` (plain text output, no schema constraint).
 * - Returns `Some(schema)` directly for object/struct schemas.
 * - Wraps non-object schemas (arrays, primitives, tuples, enums) in an object
 *   `{ result: <schema> }` so strict providers (e.g. OpenAI Responses) accept them.
 */
export function reifiedOutputSchema(typeInfos) {
  const tInfo = Array.isArray(typeInfos) ? typeInfos[0] : null;
  if (!tInfo || tInfo.splType === "Str" || tInfo.splType === "Unit") {
    return None;
  }
  const schema = tInfo.schema;
  if (schema && typeof schema === "object" && schema.type === "object") {
    return Some(schema);
  }
  return Some({
    type: "object",
    title: "SplResult",
    properties: {
      result: schema ?? {},
    },
    required: ["result"],
    additionalProperties: false,
  });
}

function parseJsonWithFenceFallback(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    const trimmed = typeof text === "string" ? text.trim() : "";
    const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    if (fence) {
      try {
        return { ok: true, value: JSON.parse(fence[1]) };
      } catch {
        // fall through to original error
      }
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Decodes raw LLM output text into the reified target type `T`:
 * - Returns `Ok(text)` directly when `T` is `Str`.
 * - Parses JSON, unwraps `{ result }` if `T` used a non-object wrapper schema,
 *   and validates with `decode(tInfo.codec, value)`.
 */
export function reifiedDecodeOutput(typeInfos, text) {
  const tInfo = Array.isArray(typeInfos) ? typeInfos[0] : null;
  if (!tInfo || tInfo.splType === "Str") {
    return Ok(typeof text === "string" ? text : String(text ?? ""));
  }
  if (tInfo.splType === "Unit") {
    return Ok(undefined);
  }
  const parsed = parseJsonWithFenceFallback(text);
  if (!parsed.ok) {
    return Err(`Failed to parse LLM output as JSON for ${tInfo.name}: ${parsed.error}`);
  }
  let val = parsed.value;
  const isObjectSchema = tInfo.schema && typeof tInfo.schema === "object" && tInfo.schema.type === "object";
  if (
    !isObjectSchema &&
    val &&
    typeof val === "object" &&
    !Array.isArray(val) &&
    Object.prototype.hasOwnProperty.call(val, "result")
  ) {
    val = val.result;
  }
  const decoded = decode(tInfo.codec, val);
  if (decoded.$tag === "Ok") return decoded;
  return Err(
    `Failed to decode LLM output as ${tInfo.name} at ${decoded._0.path}: ${decoded._0.message}`
  );
}

/**
 * Generates a JSON Schema object for a parameterized `AgentTool<Args, Out>`'s input `Args`.
 */
export function reifiedSchema(typeInfos) {
  const tInfo = Array.isArray(typeInfos) ? typeInfos[0] : null;
  if (!tInfo || tInfo.splType === "Unit") {
    return { type: "object", properties: {}, required: [], additionalProperties: false };
  }
  const schema = tInfo.schema;
  if (schema && typeof schema === "object" && schema.type === "object") {
    return schema;
  }
  return {
    type: "object",
    title: tInfo.name || "Args",
    properties: { value: schema ?? {} },
    required: ["value"],
    additionalProperties: false,
  };
}

/**
 * Validates and decodes a raw JSON value into the reified tool input type `Args`.
 */
export function reifiedDecodeJson(typeInfos, raw) {
  const tInfo = Array.isArray(typeInfos) ? typeInfos[0] : null;
  if (!tInfo || tInfo.splType === "Json") {
    return Ok(raw);
  }
  if (tInfo.splType === "Unit") {
    return Ok(undefined);
  }
  let val = raw;
  if (typeof val === "string" && tInfo.splType !== "Str") {
    const parsed = parseJsonWithFenceFallback(val);
    if (!parsed.ok) {
      return Err(`Invalid JSON arguments for ${tInfo.name}: ${parsed.error}`);
    }
    val = parsed.value;
  }
  const isObjectSchema = tInfo.schema && typeof tInfo.schema === "object" && tInfo.schema.type === "object";
  if (
    !isObjectSchema &&
    val &&
    typeof val === "object" &&
    !Array.isArray(val) &&
    Object.prototype.hasOwnProperty.call(val, "value")
  ) {
    val = val.value;
  }
  const decoded = decode(tInfo.codec, val);
  if (decoded.$tag === "Ok") return decoded;
  return Err(
    `Invalid tool arguments for ${tInfo.name} at ${decoded._0.path}: ${decoded._0.message}`
  );
}

/**
 * Encodes a parameterized tool's output `Out` for returning to the LLM:
 * - Returns `Str` directly when `Out = Str` (no extra JSON quotes).
 * - Serializes any other SPL type to JSON via `jsonStringify`.
 */
export function reifiedEncodeToolOutput(typeInfos, value) {
  const tInfo = Array.isArray(typeInfos) ? typeInfos[0] : null;
  if (!tInfo || tInfo.splType === "Str") {
    return typeof value === "string" ? value : String(value ?? "");
  }
  return jsonStringify(value);
}

// ==================== Unified Entry Point ====================

export async function llmTurn(req) {
  const debugHook = typeof globalThis !== "undefined" ? globalThis.__splLlmDebugHook : null;
  try {
    let curReq = req;
    let callId = 0;
    if (debugHook && typeof debugHook.beforeTurn === "function") {
      const dec = await debugHook.beforeTurn(curReq);
      if (dec) {
        if (typeof dec.callId === "number") callId = dec.callId;
        if (dec.req) curReq = dec.req;
        if (dec.action === "abort") {
          const aborted = Err(dec.error ?? "Aborted by SPL debugger");
          return typeof debugHook.afterTurn === "function"
            ? await debugHook.afterTurn(curReq, aborted, 0, callId)
            : aborted;
        }
        if (dec.action === "mock") {
          const mocked = Ok(dec.response);
          return typeof debugHook.afterTurn === "function"
            ? await debugHook.afterTurn(curReq, mocked, 0, callId)
            : mocked;
        }
      }
    }

    const userOnDelta = unwrapOpt(curReq.on_delta, null);
    const onDelta =
      debugHook && typeof debugHook.onDelta === "function"
        ? async (delta) => {
            try {
              debugHook.onDelta(callId, delta);
            } catch {
              // ignore debug observer errors
            }
            if (typeof userOnDelta === "function") {
              return await userOnDelta(delta);
            }
          }
        : userOnDelta;

    const t0 = Date.now();
    const provider =
      typeof curReq.provider === "string"
        ? curReq.provider.trim().toLowerCase().replace(/-/g, "_")
        : curReq.provider;
    const auth = resolveAuthAndBaseUrl(provider, curReq);
    let result;
    if (!auth.ok) {
      result = Err(auth.error);
    } else {
      const baseReq = { ...curReq, api_key: auth.apiKey, base_url: auth.baseUrl };
      const effectiveReq =
        typeof userOnDelta === "function" && !baseReq.stream ? { ...baseReq, stream: true } : baseReq;
      switch (provider) {
        case "openai_responses":
          result = await callOpenAiResponses(effectiveReq, onDelta);
          break;
        case "openai_chat":
          result = await callOpenAiChat(effectiveReq, onDelta);
          break;
        case "anthropic":
          result = await callAnthropic(effectiveReq, onDelta);
          break;
        case "google":
          result = await callGoogle(effectiveReq, onDelta);
          break;
        default:
          result = Err(
            `Unknown LLM provider '${effectiveReq.provider}'. Expected one of: openai_responses, openai_chat, anthropic, google`
          );
          break;
      }
    }
    const elapsedMs = Date.now() - t0;
    if (debugHook && typeof debugHook.afterTurn === "function") {
      return await debugHook.afterTurn(curReq, result, elapsedMs, callId);
    }
    return result;
  } catch (e) {
    return Err(e instanceof Error ? e.message : String(e));
  }
}
