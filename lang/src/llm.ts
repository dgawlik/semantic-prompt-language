import type { AskMods, ToolName } from './ast.js';
import { Failure } from './errors.js';
import type { Restrictions } from './restrict.js';
import type { ToolHost } from './tools.js';
import { fromJson, isDict, isList, type Value } from './values.js';

export type ReasoningLevel = 'low' | 'medium' | 'high';

export interface Constraint {
    kind: 'enforce' | 'forbid';
    text: string;
}

export interface LlmRequest {
    kind: 'ask' | 'think' | 'tool';
    /** The fully assembled query: constraints, restriction guidance and hints are already prepended. */
    prompt: string;
    model?: string;
    reasoningEffort?: ReasoningLevel;
    showReasoning: boolean;
    restrictions: Restrictions;
    tools: ToolHost;
    /** For tools the script left parameters out of: the LLM calls the tool itself, these params are fixed by the script. */
    pinned?: { tool: ToolName; params: Record<string, string> };
}

export interface LlmResponse {
    text: string;
    reasoning?: string;
    /** Effective model and parameters, recorded in the logs. */
    effective: Record<string, unknown>;
}

export interface LlmBackend {
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

const FMT_OBJECT_HINT =
    'Respond with ONLY a valid JSON value (an object unless the task clearly asks for a list). No prose, no markdown, no code fences.';

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
            'Rules you must follow strictly:\n' +
                opts.constraints.map((c) => `- You ${c.kind === 'enforce' ? 'MUST' : 'MUST NOT'}: ${c.text}`).join('\n'),
        );
    }
    const guidance = opts.restrictions.guidance();
    if (guidance.length) sections.push(`Active restrictions (enforced by the runtime):\n${guidance.map((g) => `- ${g}`).join('\n')}`);
    if (opts.thinking) sections.push('Think carefully about the problem before giving the final answer.');
    if (opts.mods?.len) sections.push(LEN_HINTS[opts.mods.len]);
    if (opts.mods?.fmt === 'object') sections.push(FMT_OBJECT_HINT);
    sections.push(opts.prompt);
    return sections.join('\n\n');
}

/** Parses an `fmt='object'` response; anything that is not a JSON object or array is `invalid_format`. */
export function parseObjectResponse(text: string): Value {
    const candidates: string[] = [text.trim()];
    const fenced = /^```[a-zA-Z]*\s*\n([\s\S]*?)\n?```$/.exec(text.trim());
    if (fenced) candidates.push(fenced[1].trim());
    const open = text.search(/[{[]/);
    const close = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
    if (open >= 0 && close > open) candidates.push(text.slice(open, close + 1));

    let lastError = 'empty response';
    for (const c of candidates) {
        try {
            const v = fromJson(JSON.parse(c));
            if (isDict(v) || isList(v)) return v;
            lastError = 'response is JSON but not an object or array';
        } catch (e) {
            lastError = (e as Error).message;
        }
    }
    throw new Failure('invalid_format', `LLM response is not valid JSON: ${lastError}`);
}
