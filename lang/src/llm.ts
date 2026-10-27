import type { AskMods } from './ast.js';
import { Failure } from './errors.js';
import type { Restrictions } from './restrict.js';
import type { ToolHost } from './tools.js';
import { fromJson, isDict, isList, type Value } from './values.js';

export type ReasoningLevel = 'low' | 'medium' | 'high';

export interface RuntimeTool {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
}

export interface RuntimeAction {
    name: string;
    arguments: Record<string, unknown>;
}

export interface Constraint {
    kind: 'enforce' | 'forbid';
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
    /** Execute a blockquote as an agent command, yielding runtime actions between turns. */
    naturalLanguage?: boolean;
    runtimeTools?: readonly RuntimeTool[];
}

export interface LlmResponse {
    text: string;
    reasoning?: string;
    /** Effective model and parameters, recorded in the logs. */
    effective: Record<string, unknown>;
    action?: RuntimeAction;
    /** MCP results retained across the blockquote's runtime-action turns. */
    toolResults?: string[];
}

export interface LlmBackend {
    readonly mode?: 'record' | 'replay' | 'trace' | 'workflow-replay';
    call(req: LlmRequest): Promise<LlmResponse>;
    /** Record/replay external effects of blockquote actions, including those inside SPL functions. */
    invokeTool?(action: RuntimeAction, perform: () => Promise<Value>): Promise<Value>;
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

type JsonFormat = Exclude<NonNullable<AskMods['fmt']>, 'text'>;

const FORMAT_CONTRACTS: Record<Exclude<JsonFormat, 'json'>, { description: string; accepts: (value: Value) => boolean }> = {
    integer: { description: 'a JSON integer', accepts: (value) => typeof value === 'number' && Number.isInteger(value) },
    float: { description: 'a finite JSON number', accepts: (value) => typeof value === 'number' && Number.isFinite(value) },
    array: { description: 'a JSON array', accepts: isList },
    object: { description: 'a JSON object', accepts: isDict },
    boolean: { description: 'a JSON boolean (true or false)', accepts: (value) => typeof value === 'boolean' },
};

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
                opts.constraints.map((c) => `- ${c.kind === 'enforce' ? 'Follow' : 'Avoid'}: ${c.text}`).join('\n'),
        );
    }
    const guidance = opts.restrictions.guidance();
    if (guidance.length) sections.push(`Active restrictions (enforced by the runtime):\n${guidance.map((g) => `- ${g}`).join('\n')}`);
    if (opts.thinking) sections.push('Think carefully about the problem before giving the final answer.');
    if (opts.mods?.len) sections.push(LEN_HINTS[opts.mods.len]);
    if (opts.mods?.fmt && opts.mods.fmt !== 'text' && opts.mods.fmt !== 'json') {
        sections.push(`${JSON_HINT} Return ${FORMAT_CONTRACTS[opts.mods.fmt].description}.`);
    }
    sections.push(opts.prompt);
    return sections.join('\n\n');
}

export function parseJsonResponse(text: string, format: JsonFormat = 'json'): Value {
    let value: Value;
    try {
        value = fromJson(JSON.parse(text));
    } catch (e) {
        if (!(e instanceof SyntaxError)) throw e;
        throw new Failure('invalid_format', `LLM response is not valid JSON: ${e.message}`);
    }
    if (format !== 'json' && !FORMAT_CONTRACTS[format].accepts(value)) {
        throw new Failure('invalid_format', `LLM response must be ${FORMAT_CONTRACTS[format].description} (fmt='${format}')`);
    }
    return value;
}
