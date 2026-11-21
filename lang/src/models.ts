import type { ProviderId } from './auth.js';
import type { ReasoningLevel, TokenUsage } from './llm.js';

export type ReasoningStyle = 'none' | 'effort' | 'budget' | 'adaptive' | 'level';
export type MinReasoningMode = 'none' | 'minimal' | 'low' | 'high' | 'between_tools';

export interface ModelPricing {
    /** USD per 1M uncached input tokens. */
    readonly input: number;
    /** USD per 1M output tokens (including reasoning tokens). */
    readonly output: number;
    /** USD per 1M cached input tokens (defaults to `input` when omitted). */
    readonly cachedInput?: number;
}

export interface ModelCapabilities {
    readonly reasoning: ReasoningStyle;
    readonly supportsReasoningSummary: boolean;
    readonly maxReasoningEffort: 'high' | 'xhigh' | 'max';
    readonly minReasoningEffort: MinReasoningMode;
    /** When set, requested efforts not in this list fall back to the nearest higher supported effort. */
    readonly allowedEfforts?: readonly Exclude<ReasoningLevel, 'none'>[];
    readonly minThinkingBudget?: number;
    readonly maxThinkingBudget?: number;
    readonly supportsSampling: boolean;
    readonly supportsSamplingWithReasoning: boolean;
    readonly supportsSeed: boolean;
    readonly supportsTemperatureAndTopP: boolean;
    readonly maxTemperature?: number;
    readonly defaultMaxTokens?: number;
    readonly supportsNativeStructuredOutput: boolean;
    readonly pricing?: ModelPricing;
}

export interface ModelCapabilityRule {
    readonly provider?: ProviderId;
    readonly match: string | RegExp;
    readonly capabilities: Partial<ModelCapabilities>;
}

const DEFAULT_CAPABILITIES: ModelCapabilities = {
    reasoning: 'none',
    supportsReasoningSummary: false,
    maxReasoningEffort: 'high',
    minReasoningEffort: 'none',
    supportsSampling: true,
    supportsSamplingWithReasoning: true,
    supportsSeed: true,
    supportsTemperatureAndTopP: true,
    supportsNativeStructuredOutput: true,
};

/** Declarative capability and pricing rules evaluated in order (later matches override earlier ones). */
const BUILTIN_RULES: readonly ModelCapabilityRule[] = [
    // ---- Provider baselines ----
    {
        provider: 'openai',
        match: /.*/,
        capabilities: {
            reasoning: 'none',
            supportsReasoningSummary: false,
            supportsSampling: true,
            supportsSamplingWithReasoning: false,
            supportsSeed: true,
            supportsTemperatureAndTopP: true,
            supportsNativeStructuredOutput: true,
        },
    },
    {
        provider: 'openai-compatible',
        match: /.*/,
        capabilities: {
            reasoning: 'none',
            supportsReasoningSummary: false,
            supportsSampling: true,
            supportsSamplingWithReasoning: true,
            supportsSeed: true,
            supportsTemperatureAndTopP: true,
            supportsNativeStructuredOutput: true,
        },
    },
    {
        provider: 'anthropic',
        match: /.*/,
        capabilities: {
            reasoning: 'none',
            supportsReasoningSummary: false,
            supportsSampling: true,
            supportsSamplingWithReasoning: false,
            supportsSeed: false,
            supportsTemperatureAndTopP: false,
            maxTemperature: 1,
            defaultMaxTokens: 4096,
            supportsNativeStructuredOutput: true,
        },
    },
    {
        provider: 'google',
        match: /.*/,
        capabilities: {
            reasoning: 'none',
            supportsReasoningSummary: false,
            supportsSampling: true,
            supportsSamplingWithReasoning: true,
            supportsSeed: true,
            supportsTemperatureAndTopP: true,
            supportsNativeStructuredOutput: true,
        },
    },

    // ---- OpenAI models ----
    {
        provider: 'openai',
        match: /^gpt-4\.1(?:-|$)/,
        capabilities: { pricing: { input: 2.0, output: 8.0, cachedInput: 0.5 } },
    },
    {
        provider: 'openai',
        match: /^gpt-4\.1-mini(?:-|$)/,
        capabilities: { pricing: { input: 0.4, output: 1.6, cachedInput: 0.1 } },
    },
    {
        provider: 'openai',
        match: /^gpt-4\.1-nano(?:-|$)/,
        capabilities: { pricing: { input: 0.1, output: 0.4, cachedInput: 0.025 } },
    },
    {
        provider: 'openai',
        match: /^(?:o[134](?:-|$)|gpt-[5-9](?:[.-]|$))/,
        capabilities: {
            reasoning: 'effort',
            supportsReasoningSummary: true,
            maxReasoningEffort: 'high',
            minReasoningEffort: 'none',
            supportsSampling: true,
            supportsSamplingWithReasoning: false,
        },
    },
    {
        provider: 'openai',
        match: /^o1-(?:mini|preview)/,
        capabilities: {
            reasoning: 'none',
            supportsReasoningSummary: true,
            supportsSampling: false,
            minReasoningEffort: 'low',
        },
    },
    {
        provider: 'openai',
        match: /^o[134](?:-|$)/,
        capabilities: {
            minReasoningEffort: 'low',
            supportsSampling: false,
        },
    },
    {
        provider: 'openai',
        match: /^o3(?:-|$)/,
        capabilities: { pricing: { input: 2.0, output: 8.0, cachedInput: 0.5 } },
    },
    {
        provider: 'openai',
        match: /^o4-mini(?:-|$)/,
        capabilities: { pricing: { input: 1.1, output: 4.4, cachedInput: 0.275 } },
    },
    {
        provider: 'openai',
        match: /^gpt-5(?:-|$)/,
        capabilities: {
            minReasoningEffort: 'minimal',
            supportsSampling: false,
            pricing: { input: 1.25, output: 10.0, cachedInput: 0.125 },
        },
    },
    {
        provider: 'openai',
        match: /^gpt-5-mini(?:-|$)/,
        capabilities: { pricing: { input: 0.25, output: 2.0, cachedInput: 0.025 } },
    },
    {
        provider: 'openai',
        match: /^gpt-5-nano(?:-|$)/,
        capabilities: { pricing: { input: 0.05, output: 0.4, cachedInput: 0.005 } },
    },
    {
        provider: 'openai',
        match: /^gpt-5-pro(?:-|$)/,
        capabilities: {
            minReasoningEffort: 'high',
            maxReasoningEffort: 'high',
            allowedEfforts: ['high'],
            supportsSampling: false,
            pricing: { input: 15.0, output: 120.0 },
        },
    },
    {
        provider: 'openai',
        match: /^gpt-(?:5\.[2-9]|[6-9])/,
        capabilities: {
            maxReasoningEffort: 'xhigh',
        },
    },
    {
        provider: 'openai',
        match: /-pro(?:-|$)/,
        capabilities: {
            supportsSampling: false,
        },
    },
    {
        provider: 'openai',
        match: /^gpt-6(?:\.1)?-astra(?:-|$)/,
        capabilities: {
            minReasoningEffort: 'low',
            supportsSampling: false,
        },
    },

    // ---- Anthropic models ----
    {
        provider: 'anthropic',
        match: /^claude-3-5-haiku/,
        capabilities: { pricing: { input: 0.8, output: 4.0, cachedInput: 0.08 } },
    },
    {
        provider: 'anthropic',
        match: /^claude-3-7/,
        capabilities: {
            reasoning: 'budget',
            maxReasoningEffort: 'max',
            defaultMaxTokens: 4096,
            pricing: { input: 3.0, output: 15.0, cachedInput: 0.3 },
        },
    },
    {
        provider: 'anthropic',
        match: /^claude-opus-4/,
        capabilities: {
            reasoning: 'budget',
            maxReasoningEffort: 'max',
            defaultMaxTokens: 32000,
            pricing: { input: 15.0, output: 75.0, cachedInput: 1.5 },
        },
    },
    {
        provider: 'anthropic',
        match: /^claude-(?:(?:sonnet|haiku)-4|opus-4-5)/,
        capabilities: {
            reasoning: 'budget',
            maxReasoningEffort: 'max',
            defaultMaxTokens: 64000,
        },
    },
    {
        provider: 'anthropic',
        match: /^claude-sonnet-4/,
        capabilities: { pricing: { input: 3.0, output: 15.0, cachedInput: 0.3 } },
    },
    {
        provider: 'anthropic',
        match: /^claude-haiku-4/,
        capabilities: { pricing: { input: 1.0, output: 5.0, cachedInput: 0.1 } },
    },
    {
        provider: 'anthropic',
        match: /^claude-(?:(?:opus|sonnet)-4-[6-9]|(?:sonnet|opus|haiku|fable)-[5-9])/,
        capabilities: {
            reasoning: 'adaptive',
            maxReasoningEffort: 'max',
            defaultMaxTokens: 128000,
        },
    },
    {
        provider: 'anthropic',
        match: /^claude-(?:opus-4-[78]|(?:sonnet|opus|haiku|fable)-[5-9])/,
        capabilities: {
            supportsSampling: false,
        },
    },
    {
        provider: 'anthropic',
        match: /^claude-sonnet-5-5/,
        capabilities: {
            minReasoningEffort: 'between_tools',
        },
    },
    {
        provider: 'anthropic',
        match: /^claude-(?:opus-5-5|fable-5)/,
        capabilities: {
            minReasoningEffort: 'low',
        },
    },

    // ---- Google models ----
    {
        provider: 'google',
        match: /^gemini-2\.0-flash/,
        capabilities: { pricing: { input: 0.1, output: 0.4, cachedInput: 0.025 } },
    },
    {
        provider: 'google',
        match: /^gemini-2\.5/,
        capabilities: {
            reasoning: 'budget',
            supportsReasoningSummary: true,
            minThinkingBudget: 0,
            maxThinkingBudget: 24576,
            pricing: { input: 0.3, output: 2.5, cachedInput: 0.075 },
        },
    },
    {
        provider: 'google',
        match: /^gemini-2\.5-pro/,
        capabilities: {
            minThinkingBudget: 128,
            maxThinkingBudget: 32768,
            pricing: { input: 1.25, output: 10.0, cachedInput: 0.31 },
        },
    },
    {
        provider: 'google',
        match: /^gemini-[3-9]/,
        capabilities: {
            reasoning: 'level',
            supportsReasoningSummary: true,
            maxReasoningEffort: 'high',
            minReasoningEffort: 'minimal',
        },
    },
    {
        provider: 'google',
        match: /^gemini-[3-9].*-pro/,
        capabilities: {
            minReasoningEffort: 'low',
        },
    },
    {
        provider: 'google',
        match: /^gemini-3(?:\.0)?-pro/,
        capabilities: {
            allowedEfforts: ['low', 'high'],
        },
    },
];

const registeredRules: ModelCapabilityRule[] = [];

/** Registers a global capability/pricing override rule for models matching `pattern`. */
export function registerModelCapabilities(
    match: string | RegExp,
    capabilities: Partial<ModelCapabilities>,
    provider?: ProviderId,
): void {
    registeredRules.push({ ...(provider ? { provider } : {}), match, capabilities });
}

/** Infers the built-in provider from an unqualified model name, or `undefined` if unknown. */
export function inferProvider(model: string): 'openai' | 'anthropic' | 'google' | undefined {
    if (model.startsWith('claude-')) return 'anthropic';
    if (model.startsWith('gemini-')) return 'google';
    if (/^(?:gpt-|chatgpt-|o[134](?:-|$))/.test(model)) return 'openai';
    return undefined;
}

function matches(rule: ModelCapabilityRule, provider: ProviderId, model: string): boolean {
    if (rule.provider !== undefined && rule.provider !== provider) return false;
    return typeof rule.match === 'string' ? model === rule.match : rule.match.test(model);
}

/** Resolves effective model capabilities by applying built-in, globally registered, and per-runtime rules. */
export function resolveModelCapabilities(
    provider: ProviderId,
    model: string,
    overrides?: readonly ModelCapabilityRule[],
): ModelCapabilities {
    let caps: ModelCapabilities = { ...DEFAULT_CAPABILITIES };
    for (const rule of BUILTIN_RULES) {
        if (matches(rule, provider, model)) caps = { ...caps, ...rule.capabilities };
    }
    for (const rule of registeredRules) {
        if (matches(rule, provider, model)) caps = { ...caps, ...rule.capabilities };
    }
    if (overrides) {
        for (const rule of overrides) {
            if (matches(rule, provider, model)) caps = { ...caps, ...rule.capabilities };
        }
    }
    return caps;
}

/** Computes estimated USD cost from token usage and model pricing, or `undefined` when pricing is unknown. */
export function estimateCostUsd(
    provider: ProviderId,
    model: string,
    usage: TokenUsage,
    overrides?: readonly ModelCapabilityRule[],
): number | undefined {
    const pricing = resolveModelCapabilities(provider, model, overrides).pricing;
    if (!pricing) return undefined;
    const cached = Math.min(usage.cachedTokens ?? 0, usage.inputTokens);
    const uncached = Math.max(0, usage.inputTokens - cached);
    const cachedRate = pricing.cachedInput ?? pricing.input;
    return (uncached * pricing.input + cached * cachedRate + usage.outputTokens * pricing.output) / 1_000_000;
}
