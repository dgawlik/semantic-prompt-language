// SPL Standard LLM Parameter Translator & Model Capability Matrix
// Translates one provider-agnostic parameter set into native payloads for:
//   - "openai_responses"
//   - "openai_chat"
//   - "anthropic"
//   - "google"
// Any parameter dropped or adapted for a specific model is recorded in `warnings`.

function unwrapOpt(v, fallback = undefined) {
  if (v && typeof v === "object") {
    if (v.$tag === "Some") return v._0;
    if (v.$tag === "None") return fallback;
  }
  return v ?? fallback;
}

/**
 * Normalize either `thinking: Thinking?` ADT or legacy `thinking_effort: Str?`
 * into `{ mode: "off" | "low" | "medium" | "high" | "max" | "budget", budget?: number } | null`.
 */
export function normalizeThinking(req) {
  const t = unwrapOpt(req.thinking);
  if (t && typeof t === "object" && t.$tag) {
    switch (t.$tag) {
      case "ThinkOff": return { mode: "off" };
      case "ThinkLow": return { mode: "low" };
      case "ThinkMedium": return { mode: "medium" };
      case "ThinkHigh": return { mode: "high" };
      case "ThinkMax": return { mode: "max" };
      case "ThinkBudget": return { mode: "budget", budget: Math.max(0, Number(t._0) || 0) };
    }
  }
  const effort = unwrapOpt(req.thinking_effort);
  if (typeof effort === "string" && effort.length > 0) {
    const lower = effort.toLowerCase();
    if (lower === "none" || lower === "off") return { mode: "off" };
    if (lower === "low" || lower === "medium" || lower === "high" || lower === "max") {
      return { mode: lower };
    }
  }
  return null;
}

/** Normalize `tool_choice: ToolChoice?` ADT into `{ mode: "auto"|"required"|"none"|"force", name?: string } | null` */
export function normalizeToolChoice(req) {
  const tc = unwrapOpt(req.tool_choice);
  if (!tc || typeof tc !== "object" || !tc.$tag) return null;
  switch (tc.$tag) {
    case "ToolAuto": return { mode: "auto" };
    case "ToolRequired": return { mode: "required" };
    case "ToolNone": return { mode: "none" };
    case "ToolForce": return { mode: "force", name: String(tc._0) };
    default: return null;
  }
}

/** Detect model-family capabilities for graceful parameter translation */
export function detectModelCapabilities(provider, model) {
  const m = String(model || "").toLowerCase();

  if (provider === "openai_responses" || provider === "openai_chat") {
    const isReasoning =
      /^o[1-9]($|[-.])/.test(m) ||
      /^gpt-([5-9]|\d{2,})/.test(m) ||
      m.includes("codex") ||
      m.includes("deepseek-r1");
    return {
      supportsThinking: isReasoning,
      thinkingStyle: isReasoning ? "openai_effort" : "none",
      // OpenAI o1/o3/o4 reject temperature & top_p; gpt-5+ reject them when reasoning is active
      supportsSamplingWithThinking: false,
      supportsSamplingWithoutThinking: !/^o[1-9]($|[-.])/.test(m),
      maxTemperature: 2.0,
      supportsStop: provider === "openai_chat" && !/^o[1-9]($|[-.])/.test(m),
      supportsSeed: provider === "openai_chat",
      supportsPenalties: provider === "openai_chat" && !/^o[1-9]($|[-.])/.test(m),
    };
  }

  if (provider === "anthropic") {
    const supportsThinking =
      m.includes("claude-3-7") ||
      m.includes("claude-3.7") ||
      /claude-(?:(?:sonnet|opus|haiku)-)?[4-9]/.test(m);
    return {
      supportsThinking,
      thinkingStyle: supportsThinking ? "anthropic_budget" : "none",
      // Anthropic forbids temperature != 1 / top_p when extended thinking is enabled
      supportsSamplingWithThinking: false,
      supportsSamplingWithoutThinking: true,
      maxTemperature: 1.0,
      supportsStop: true,
      supportsSeed: false,
      supportsPenalties: false,
    };
  }

  if (provider === "google") {
    const isGemini3 = /gemini-([3-9]|\d{2,})/.test(m);
    const isGemini25 = /gemini-2\.5/.test(m) || m.includes("thinking");
    return {
      supportsThinking: isGemini3 || isGemini25,
      thinkingStyle: isGemini3 ? "google_level" : isGemini25 ? "google_budget" : "none",
      supportsSamplingWithThinking: true,
      supportsSamplingWithoutThinking: true,
      maxTemperature: 2.0,
      supportsStop: true,
      supportsSeed: true,
      supportsPenalties: true,
    };
  }

  return {
    supportsThinking: false,
    thinkingStyle: "none",
    supportsSamplingWithThinking: true,
    supportsSamplingWithoutThinking: true,
    maxTemperature: 2.0,
    supportsStop: false,
    supportsSeed: false,
    supportsPenalties: false,
  };
}

function thinkingToEffort(t) {
  if (t.mode === "budget") {
    if (t.budget <= 0) return "none";
    if (t.budget <= 2048) return "low";
    if (t.budget <= 8192) return "medium";
    return "high";
  }
  if (t.mode === "max") return "high";
  return t.mode;
}

function thinkingToBudget(t, defaultMax = 16384) {
  switch (t.mode) {
    case "off": return 0;
    case "low": return 1024;
    case "medium": return 4096;
    case "high": return 10240;
    case "max": return defaultMax;
    case "budget": return t.budget;
    default: return 0;
  }
}

function thinkingToGoogleLevel(t) {
  switch (t.mode) {
    case "off": return "minimal";
    case "low": return "low";
    case "medium": return "medium";
    case "high":
    case "max": return "high";
    case "budget":
      if (t.budget <= 0) return "minimal";
      if (t.budget <= 2048) return "low";
      if (t.budget <= 8192) return "medium";
      return "high";
    default: return "low";
  }
}

/**
 * Translate SPL's standard generation parameters into provider-native body fields
 * while collecting human-readable `warnings` for any adapted/unsupported options.
 */
export function translateStandardParams(provider, req) {
  const caps = detectModelCapabilities(provider, req.model);
  const warnings = [];

  const maxTokens = unwrapOpt(req.max_tokens);
  const temperature = unwrapOpt(req.temperature);
  const topP = unwrapOpt(req.top_p);
  const stop = Array.isArray(req.stop) ? req.stop : [];
  const seed = unwrapOpt(req.seed);
  const presencePenalty = unwrapOpt(req.presence_penalty);
  const frequencyPenalty = unwrapOpt(req.frequency_penalty);
  const thinking = normalizeThinking(req);
  const toolChoice = normalizeToolChoice(req);
  const hasTools = Array.isArray(req.tools) && req.tools.length > 0;

  let thinkingActive = false;
  const out = {};

  // ---- 1. Thinking / Reasoning ----
  if (thinking && thinking.mode !== "off") {
    if (!caps.supportsThinking) {
      warnings.push(
        `Dropped thinking (${thinking.mode}): model '${req.model}' on '${provider}' does not support reasoning/thinking parameters`
      );
    } else if (caps.thinkingStyle === "openai_effort") {
      const effort = thinkingToEffort(thinking);
      if (effort !== "none") {
        thinkingActive = true;
        if (provider === "openai_responses") out.reasoning = { effort, summary: "auto" };
        else out.reasoning_effort = effort;
      }
    } else if (caps.thinkingStyle === "anthropic_budget") {
      const budget = Math.max(1024, thinkingToBudget(thinking, 16384));
      thinkingActive = true;
      out.thinking = { type: "enabled", budget_tokens: budget };
    } else if (caps.thinkingStyle === "google_level") {
      thinkingActive = true;
      out.thinkingConfig = { thinkingLevel: thinkingToGoogleLevel(thinking), includeThoughts: true };
    } else if (caps.thinkingStyle === "google_budget") {
      const budget = thinkingToBudget(thinking, 24576);
      thinkingActive = budget > 0;
      out.thinkingConfig = { thinkingBudget: budget, ...(budget > 0 ? { includeThoughts: true } : {}) };
    }
  } else if (thinking && thinking.mode === "off" && caps.thinkingStyle === "google_budget") {
    out.thinkingConfig = { thinkingBudget: 0 };
  }

  // ---- 2. Max Tokens ----
  if (provider === "anthropic") {
    let effMax = maxTokens != null ? maxTokens : 4096;
    if (out.thinking && effMax <= out.thinking.budget_tokens) {
      const raised = out.thinking.budget_tokens + 1024;
      warnings.push(
        `Raised max_tokens (${effMax} -> ${raised}) to exceed Anthropic thinking.budget_tokens (${out.thinking.budget_tokens})`
      );
      effMax = raised;
    }
    out.max_tokens = effMax;
  } else if (maxTokens != null) {
    if (provider === "openai_responses") out.max_output_tokens = maxTokens;
    else if (provider === "openai_chat") out.max_completion_tokens = maxTokens;
    else if (provider === "google") out.maxOutputTokens = maxTokens;
  }

  // ---- 3. Sampling: temperature & top_p ----
  const samplingAllowed = thinkingActive
    ? caps.supportsSamplingWithThinking
    : caps.supportsSamplingWithoutThinking;

  if (temperature != null) {
    if (!samplingAllowed) {
      warnings.push(
        `Dropped temperature=${temperature}: unsupported on '${req.model}'${thinkingActive ? " while thinking/reasoning is enabled" : ""}`
      );
    } else {
      let clamped = temperature;
      if (clamped < 0) clamped = 0;
      if (clamped > caps.maxTemperature) {
        warnings.push(`Clamped temperature (${temperature} -> ${caps.maxTemperature}) for '${provider}'`);
        clamped = caps.maxTemperature;
      }
      out.temperature = clamped;
    }
  }

  if (topP != null) {
    if (!samplingAllowed) {
      warnings.push(
        `Dropped top_p=${topP}: unsupported on '${req.model}'${thinkingActive ? " while thinking/reasoning is enabled" : ""}`
      );
    } else {
      const clamped = Math.max(0, Math.min(1, topP));
      if (provider === "google") out.topP = clamped;
      else out.top_p = clamped;
    }
  }

  // ---- 4. Stop Sequences ----
  if (stop.length > 0) {
    if (!caps.supportsStop) {
      warnings.push(`Dropped stop sequences: unsupported on '${provider}' (${req.model})`);
    } else if (provider === "openai_chat") {
      out.stop = stop;
    } else if (provider === "anthropic") {
      out.stop_sequences = stop;
    } else if (provider === "google") {
      out.stopSequences = stop;
    }
  }

  // ---- 5. Seed ----
  if (seed != null) {
    if (!caps.supportsSeed) {
      warnings.push(`Dropped seed=${seed}: unsupported on '${provider}'`);
    } else {
      out.seed = seed;
    }
  }

  // ---- 6. Presence & Frequency Penalties ----
  if (presencePenalty != null) {
    if (!caps.supportsPenalties) {
      warnings.push(`Dropped presence_penalty=${presencePenalty}: unsupported on '${provider}' (${req.model})`);
    } else if (provider === "google") {
      out.presencePenalty = presencePenalty;
    } else {
      out.presence_penalty = presencePenalty;
    }
  }
  if (frequencyPenalty != null) {
    if (!caps.supportsPenalties) {
      warnings.push(`Dropped frequency_penalty=${frequencyPenalty}: unsupported on '${provider}' (${req.model})`);
    } else if (provider === "google") {
      out.frequencyPenalty = frequencyPenalty;
    } else {
      out.frequency_penalty = frequencyPenalty;
    }
  }

  // ---- 7. Tool Choice ----
  if (toolChoice && hasTools) {
    if (provider === "openai_responses") {
      if (toolChoice.mode === "force") out.tool_choice = { type: "function", name: toolChoice.name };
      else out.tool_choice = toolChoice.mode; // "auto" | "required" | "none"
    } else if (provider === "openai_chat") {
      if (toolChoice.mode === "force") {
        out.tool_choice = { type: "function", function: { name: toolChoice.name } };
      } else {
        out.tool_choice = toolChoice.mode;
      }
    } else if (provider === "anthropic") {
      if (thinkingActive && (toolChoice.mode === "required" || toolChoice.mode === "force")) {
        warnings.push(`Downgraded tool_choice '${toolChoice.mode}' -> 'auto' because Anthropic forbids forced tool_choice with thinking enabled`);
        out.tool_choice = { type: "auto" };
      } else if (toolChoice.mode === "auto") out.tool_choice = { type: "auto" };
      else if (toolChoice.mode === "required") out.tool_choice = { type: "any" };
      else if (toolChoice.mode === "none") out.tool_choice = { type: "none" };
      else if (toolChoice.mode === "force") out.tool_choice = { type: "tool", name: toolChoice.name };
    } else if (provider === "google") {
      if (toolChoice.mode === "auto") {
        out.toolConfig = { functionCallingConfig: { mode: "AUTO" } };
      } else if (toolChoice.mode === "required") {
        out.toolConfig = { functionCallingConfig: { mode: "ANY" } };
      } else if (toolChoice.mode === "none") {
        out.toolConfig = { functionCallingConfig: { mode: "NONE" } };
      } else if (toolChoice.mode === "force") {
        out.toolConfig = {
          functionCallingConfig: { mode: "ANY", allowedFunctionNames: [toolChoice.name] },
        };
      }
    }
  }

  return { params: out, warnings };
}
