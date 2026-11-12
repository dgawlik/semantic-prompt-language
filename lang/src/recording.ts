import type { StatusCode } from './errors.js';
import { validateRandomness, validateTokens, type LlmRequest, type LlmResponse } from './llm.js';
import { isRuntimeAction } from './agent.js';

export function traceRequest(req: LlmRequest) {
    return {
        kind: req.kind, prompt: req.prompt, model: req.model ?? null,
        reasoningEffort: req.reasoningEffort ?? null, showReasoning: req.showReasoning,
        ...(req.naturalLanguage ? { naturalLanguage: true } : {}),
        ...(req.randomness !== undefined ? { randomness: validateRandomness(req.randomness) } : {}),
        ...(req.tokens !== undefined ? { tokens: validateTokens(req.tokens) } : {}),
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isResponse(value: unknown): value is LlmResponse {
    return isRecord(value) && typeof value.text === 'string' && isRecord(value.effective)
        && (value.reasoning === undefined || typeof value.reasoning === 'string')
        && (value.action === undefined || isRuntimeAction(value.action))
        && (value.toolResults === undefined || (Array.isArray(value.toolResults) && value.toolResults.every(item => typeof item === 'string')))
        && !('spl' in value);
}

export function isToolValue(value: unknown): boolean {
    return value === null || typeof value === 'string' || typeof value === 'boolean'
        || (typeof value === 'number' && Number.isFinite(value))
        || (Array.isArray(value) && value.every(isToolValue))
        || (isRecord(value) && !('__fn' in value) && Object.values(value).every(isToolValue));
}

export function isTraceError(value: unknown): value is { status_code: StatusCode; reason: string } {
    const codes: readonly StatusCode[] = [
        'assertion_failed', 'explicit_failure', 'invalid_format', 'validation_failed', 'type_error',
        'restriction_violation', 'llm_error', 'tool_error', 'runtime_error',
    ];
    return isRecord(value) && typeof value.reason === 'string'
        && codes.some(code => code === value.status_code);
}
