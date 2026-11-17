import type { LlmStreamUpdate } from './llm.js';

export type BodySegment =
    | { readonly type: 'text' | 'inspection'; readonly text: string }
    | { readonly type: 'code'; readonly language: 'javascript'; readonly source: string }
    | {
        /** Tool content shown as it appears in a file: folded in the terminal view unless `expanded`, with line numbers. */
        readonly type: 'listing';
        readonly payloadId: string;
        readonly language: string;
        readonly source: string;
        readonly summary: string;
        readonly expanded?: boolean;
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
    readonly kind: 'ask' | 'agent' | 'codegen';
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
