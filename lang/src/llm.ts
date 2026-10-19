import type { AskMods } from './ast.js';
import { Failure } from './errors.js';
import type { Restrictions } from './restrict.js';
import type { ToolHost } from './tools.js';
import { fromJson, isDict, isList, type Value } from './values.js';

export type ReasoningLevel = 'low' | 'medium' | 'high';

export interface Constraint {
    kind: 'instruct' | 'avoid';
    text: string;
}

export interface LlmRequest {
    kind: 'ask' | 'think' | 'agent';
    /** The fully assembled query: constraints, restriction guidance and hints are already prepended. */
    prompt: string;
    model?: string;
    reasoningEffort?: ReasoningLevel;
    showReasoning: boolean;
    restrictions: Restrictions;
    tools: ToolHost;
}

export interface LlmResponse {
    text: string;
    reasoning?: string;
    /** Effective model and parameters, recorded in the logs. */
    effective: Record<string, unknown>;
}

export interface LlmBackend {
    readonly mode?: 'record' | 'replay';
    call(req: LlmRequest): Promise<LlmResponse>;
    close(): Promise<void>;
}

/** Raised by a backend for any non-script-level LLM problem; becomes `llm_error`. */
export class LlmError extends Error {}

const LEN_HINTS: Record<NonNullable<AskMods['len']>, string> = {
    word: 'Answer with a single word.',
    sentence: 'Answer in a single sentence.',
    paragraph: 'Answer in a single paragraph.',
    long: 'Give a long, detailed answer.',
};

const JSON_HINT = 'Respond with ONLY valid JSON. No prose, no markdown, no code fences.';

export function buildPrompt(opts: {
    prompt: string;
    mods?: AskMods;
    thinking?: boolean;
    constraints: readonly Constraint[];
    restrictions: Restrictions;
}): string {
    const sections: string[] = [];
    if (opts.constraints.length) {
        sections.push(
            'Response guidance (not runtime validation):\n' +
                opts.constraints.map((c) => `- ${c.kind === 'instruct' ? 'Follow' : 'Avoid'}: ${c.text}`).join('\n'),
        );
    }
    const guidance = opts.restrictions.guidance();
    if (guidance.length) sections.push(`Active restrictions (enforced by the runtime):\n${guidance.map((g) => `- ${g}`).join('\n')}`);
    if (opts.thinking) sections.push('Think carefully about the problem before giving the final answer.');
    if (opts.mods?.len) sections.push(LEN_HINTS[opts.mods.len]);
    if (opts.mods?.fmt === 'object') sections.push(`${JSON_HINT} Return an object or array.`);
    sections.push(opts.prompt);
    return sections.join('\n\n');
}

export function parseJsonResponse(text: string, objectOnly = false): Value {
    let value: Value;
    try {
        value = fromJson(JSON.parse(text));
    } catch (e) {
        if (!(e instanceof SyntaxError)) throw e;
        throw new Failure('invalid_format', `LLM response is not valid JSON: ${e.message}`);
    }
    if (objectOnly && !isDict(value) && !isList(value)) {
        throw new Failure('invalid_format', 'LLM response must be a JSON object or array');
    }
    return value;
}
