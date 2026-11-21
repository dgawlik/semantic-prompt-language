import { createHash } from 'node:crypto';
import type { StatusCode } from './errors.js';
import { validateMaxSteps, validateRandomness, validateTokens, type Attachment, type LlmRequest, type LlmResponse, type RuntimeAction, type TokenUsage } from './llm.js';

function summarizeAttachment(attachment: Attachment) {
    const hash = createHash('sha256')
        .update(attachment.data instanceof Uint8Array ? attachment.data : attachment.data)
        .digest('hex');
    return {
        kind: attachment.kind,
        mediaType: attachment.mediaType,
        ...(attachment.name ? { name: attachment.name } : {}),
        sha256: hash,
    };
}

export function traceRequest(req: LlmRequest) {
    return {
        kind: req.kind, prompt: req.prompt, model: req.model ?? null,
        reasoningEffort: req.reasoningEffort ?? null, showReasoning: req.showReasoning,
        ...(req.randomness !== undefined ? { randomness: validateRandomness(req.randomness) } : {}),
        ...(req.tokens !== undefined ? { tokens: validateTokens(req.tokens) } : {}),
        ...(req.maxSteps !== undefined ? { maxSteps: validateMaxSteps(req.maxSteps) } : {}),
        ...(req.attachments?.length ? { attachments: req.attachments.map(summarizeAttachment) } : {}),
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isRuntimeAction(value: unknown): value is RuntimeAction {
    return isRecord(value) && typeof value.name === 'string' && isRecord(value.arguments);
}

const isNonNegInt = (value: unknown): value is number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

export function isTokenUsage(value: unknown): value is TokenUsage {
    return isRecord(value)
        && isNonNegInt(value.inputTokens)
        && isNonNegInt(value.outputTokens)
        && isNonNegInt(value.totalTokens)
        && (value.cachedTokens === undefined || isNonNegInt(value.cachedTokens))
        && (value.reasoningTokens === undefined || isNonNegInt(value.reasoningTokens));
}

export function isResponse(value: unknown): value is LlmResponse {
    return isRecord(value) && typeof value.text === 'string' && isRecord(value.effective)
        && (value.reasoning === undefined || typeof value.reasoning === 'string')
        && (value.usage === undefined || isTokenUsage(value.usage))
        && (value.costUsd === undefined || (typeof value.costUsd === 'number' && Number.isFinite(value.costUsd) && value.costUsd >= 0))
        && (value.action === undefined || isRuntimeAction(value.action))
        && (value.toolResults === undefined || (Array.isArray(value.toolResults) && value.toolResults.every(item => typeof item === 'string')));
}

export function isTraceError(value: unknown): value is { status_code: StatusCode; reason: string } {
    const codes: readonly StatusCode[] = [
        'assertion_failed', 'explicit_failure', 'invalid_format', 'validation_failed', 'type_error',
        'restriction_violation', 'llm_error', 'tool_error', 'runtime_error',
    ];
    return isRecord(value) && typeof value.reason === 'string'
        && codes.some(code => code === value.status_code);
}
