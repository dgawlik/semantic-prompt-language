import { stripVTControlCharacters, types } from 'node:util';
import type { LlmStreamUpdate } from './llm.js';

export type BodySegment =
    | { readonly type: 'text' | 'inspection'; readonly text: string }
    | { readonly type: 'code'; readonly language: 'javascript'; readonly source: string }
    | {
        /** Tool content shown as it appears in a file: folded in the terminal view, with line numbers. */
        readonly type: 'listing';
        readonly payloadId: string;
        readonly language: string;
        readonly source: string;
        readonly summary: string;
    }
    | {
        readonly type: 'preface';
        readonly payloadId: string;
        readonly source: string;
        readonly summary: string;
    }
    | {
        readonly type: 'json';
        readonly payloadId: string;
        readonly container: 'object' | 'array';
        readonly source: string;
        readonly summary: string;
    };

export type ScopeKind = 'global' | 'block' | 'branch' | 'iteration' | 'function' | 'handler' | 'retained';

export interface ScopeReference {
    readonly scopeId: string;
    readonly kind: ScopeKind;
    readonly parentId?: string;
    readonly label: string;
}

export interface BindingReference extends ScopeReference {
    readonly bindingId: string;
    readonly name: string;
}

export type ObservedValue =
    | { readonly presence: 'unbound' }
    | {
        readonly presence: 'value';
        readonly valueKind: 'scalar' | 'list' | 'dictionary' | 'callable' | 'foreign';
        readonly referenceId?: string;
        readonly display: string;
    };

export interface BindingDelta {
    readonly binding: BindingReference;
    readonly previous: ObservedValue;
    readonly next: ObservedValue;
}

export interface StateChange {
    readonly operation: 'initialize' | 'rebind' | 'mutation';
    readonly bindings: readonly [BindingDelta, ...BindingDelta[]];
    readonly targetReferenceId?: string;
    readonly path?: string;
}

export interface ModelInteraction {
    readonly requestId: string;
    readonly kind: 'ask' | 'think' | 'agent' | 'blockquote' | 'codegen';
    readonly role?: 'response' | 'action';
}

export interface ToolUse {
    /** Built-in tool name, or `server/tool` for MCP. */
    readonly name: string;
    /** Path, URL, query or command the tool acted on. */
    readonly target: string;
    readonly status: 'success' | 'error';
}

interface EventBase {
    readonly id: string;
    readonly sequence: number;
    readonly segments: readonly BodySegment[];
}

export type LogEvent = EventBase & (
    | { readonly kind: 'error' | 'warning' | 'info' | 'debug'; readonly origin: 'diagnostic' | 'script' }
    | { readonly kind: 'generic'; readonly origin: 'embedding'; readonly label: string }
    | { readonly kind: 'model-input' | 'model-output'; readonly origin: 'model'; readonly interaction: ModelInteraction }
    | { readonly kind: 'state'; readonly origin: 'state'; readonly change: StateChange }
    | { readonly kind: 'tool'; readonly origin: 'tool'; readonly tool: ToolUse }
);

export type LogEventSink = (event: LogEvent) => void;

export type ModelStreamEvent = { readonly interaction: ModelInteraction } & (
    | { readonly type: 'update'; readonly update: Readonly<LlmStreamUpdate> }
    | { readonly type: 'end'; readonly outcome: 'completed'; readonly response: string; readonly reasoning?: string }
    | { readonly type: 'end'; readonly outcome: 'failed' }
);

export type ModelStreamSink = (event: ModelStreamEvent) => void;

export function freezeEvent(event: LogEvent): LogEvent {
    for (const segment of event.segments) Object.freeze(segment);
    Object.freeze(event.segments);
    if ('interaction' in event) Object.freeze(event.interaction);
    if (event.kind === 'tool') Object.freeze(event.tool);
    if (event.kind === 'state') {
        for (const delta of event.change.bindings) {
            Object.freeze(delta.binding);
            Object.freeze(delta.previous);
            Object.freeze(delta.next);
            Object.freeze(delta);
        }
        Object.freeze(event.change.bindings);
        Object.freeze(event.change);
    }
    return Object.freeze(event);
}

export type FinishReason = 'completed' | 'failed' | 'cancelled';

function record(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !types.isProxy(value) && !Array.isArray(value) &&
        (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) &&
        Object.values(Object.getOwnPropertyDescriptors(value)).every(descriptor => 'value' in descriptor);
}
const fields = (value: Record<string, unknown>, allowed: readonly string[]): boolean =>
    Object.keys(value).every(key => allowed.includes(key));
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const safeText = (value: unknown): value is string => typeof value === 'string' &&
    stripVTControlCharacters(value) === value && !/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(value);

/** Validates a stream event received from another process, such as the notebook worker. */
export function isModelStreamEvent(value: unknown): value is ModelStreamEvent {
    if (!record(value) || !record(value.interaction)) return false;
    const interaction = value.interaction;
    if (!fields(interaction, ['requestId', 'kind', 'role']) || !nonempty(interaction.requestId) ||
        !['ask', 'think', 'agent', 'blockquote', 'codegen'].includes(String(interaction.kind)) ||
        (interaction.role !== undefined && interaction.role !== 'response' && interaction.role !== 'action')) return false;
    if (value.type === 'update') {
        return fields(value, ['type', 'interaction', 'update']) && record(value.update) &&
            fields(value.update, ['channel', 'messageId', 'mode', 'text']) &&
            ['response', 'reasoning'].includes(String(value.update.channel)) && nonempty(value.update.messageId) &&
            ['append', 'replace'].includes(String(value.update.mode)) && safeText(value.update.text);
    }
    if (value.type !== 'end') return false;
    if (value.outcome === 'failed') return fields(value, ['type', 'interaction', 'outcome']);
    return value.outcome === 'completed' && fields(value, ['type', 'interaction', 'outcome', 'response', 'reasoning']) &&
        safeText(value.response) && (value.reasoning === undefined || safeText(value.reasoning));
}
