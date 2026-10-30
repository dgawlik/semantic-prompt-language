import { stripVTControlCharacters, types } from 'node:util';
import type { LlmStreamUpdate } from './llm.js';

export type BodySegment =
    | { readonly type: 'text' | 'inspection'; readonly text: string }
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
    readonly kind: 'ask' | 'think' | 'agent' | 'blockquote';
    readonly role?: 'response' | 'action';
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
export interface TerminalState {
    readonly raw: boolean;
    readonly width?: number;
    readonly height?: number;
}
interface MessageBase { readonly version: 1; readonly sessionId: string }
export type ParentMessage = MessageBase & (
    | { readonly type: 'initialize'; readonly color: boolean; readonly terminal: TerminalState }
    | { readonly type: 'activate' }
    | { readonly type: 'event'; readonly sequence: number; readonly event: LogEvent }
    | { readonly type: 'stream'; readonly event: ModelStreamEvent }
    | { readonly type: 'finish'; readonly lastSequence: number | null; readonly reason: FinishReason }
);
export type ChildMessage = MessageBase & (
    | { readonly type: 'prepared'; readonly cursorVisible: boolean }
    | { readonly type: 'ready'; readonly restored: true }
    | { readonly type: 'accepted'; readonly sequence: number }
    | { readonly type: 'finished'; readonly lastSequence: number | null; readonly restored: true }
    | { readonly type: 'cancel'; readonly reason: 'interrupt' }
    | { readonly type: 'fatal'; readonly stage: 'startup' | 'protocol' | 'rendering' | 'restoration'; readonly diagnostic: string }
);

function record(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !types.isProxy(value) && !Array.isArray(value) &&
        (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) &&
        Object.values(Object.getOwnPropertyDescriptors(value)).every(descriptor => 'value' in descriptor);
}
const fields = (value: Record<string, unknown>, allowed: readonly string[]): boolean =>
    Object.keys(value).every(key => allowed.includes(key));
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const sequence = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const finalSequence = (value: unknown): value is number | null => value === null || sequence(value);
const optionalString = (value: unknown): boolean => value === undefined || nonempty(value);
const safeText = (value: unknown): value is string => typeof value === 'string' &&
    stripVTControlCharacters(value) === value && !/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(value);
const scopeKinds: readonly unknown[] = ['global', 'block', 'branch', 'iteration', 'function', 'handler', 'retained'];

export function isModelStreamEvent(value: unknown): value is ModelStreamEvent {
    if (!record(value) || !record(value.interaction)) return false;
    const interaction = value.interaction;
    if (!fields(interaction, ['requestId', 'kind', 'role']) || !nonempty(interaction.requestId) ||
        !['ask', 'think', 'agent', 'blockquote'].includes(String(interaction.kind)) ||
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

function observed(value: unknown): boolean {
    if (!record(value)) return false;
    if (value.presence === 'unbound') return fields(value, ['presence']);
    return value.presence === 'value' && fields(value, ['presence', 'valueKind', 'referenceId', 'display']) &&
        ['scalar', 'list', 'dictionary', 'callable', 'foreign'].includes(String(value.valueKind)) &&
        optionalString(value.referenceId) && typeof value.display === 'string';
}

function stateChange(value: unknown): boolean {
    return record(value) && fields(value, ['operation', 'bindings', 'targetReferenceId', 'path']) &&
        ['initialize', 'rebind', 'mutation'].includes(String(value.operation)) &&
        optionalString(value.targetReferenceId) && optionalString(value.path) &&
        Array.isArray(value.bindings) && value.bindings.length > 0 && value.bindings.every(delta => {
            if (!record(delta) || !fields(delta, ['binding', 'previous', 'next']) || !record(delta.binding)) return false;
            const binding = delta.binding;
            return fields(binding, ['scopeId', 'kind', 'parentId', 'label', 'bindingId', 'name']) &&
                nonempty(binding.scopeId) && scopeKinds.includes(binding.kind) && optionalString(binding.parentId) &&
                nonempty(binding.label) && nonempty(binding.bindingId) && nonempty(binding.name) &&
                observed(delta.previous) && observed(delta.next);
        });
}

function segment(value: unknown, eventId: string): value is BodySegment {
    if (!record(value)) return false;
    if (value.type === 'text' || value.type === 'inspection') return fields(value, ['type', 'text']) && safeText(value.text);
    if (value.type === 'preface') return fields(value, ['type', 'payloadId', 'source', 'summary']) &&
        nonempty(value.payloadId) && value.payloadId.startsWith(`${eventId}:`) && safeText(value.source) &&
        nonempty(value.source) && safeText(value.summary) && nonempty(value.summary) && !/[\r\n]/.test(value.summary);
    if (!fields(value, ['type', 'payloadId', 'container', 'source', 'summary']) ||
        value.type !== 'json' || !nonempty(value.payloadId) || !value.payloadId.startsWith(`${eventId}:`) ||
        typeof value.source !== 'string' || !safeText(value.summary) || /[\r\n]/.test(value.summary)) return false;
    const text = value.source.trim();
    if (!(value.container === 'object' && text.startsWith('{')) && !(value.container === 'array' && text.startsWith('['))) return false;
    try { JSON.parse(text); return true; }
    catch (error) { if (!(error instanceof SyntaxError)) throw error; return false; }
}

export function isLogEvent(value: unknown): value is LogEvent {
    if (!record(value) || !nonempty(value.id) || !sequence(value.sequence) || !Array.isArray(value.segments)) return false;
    const id = value.id;
    if (!value.segments.every(part => segment(part, id))) return false;
    const payloadIds = value.segments.filter(part => part.type === 'json' || part.type === 'preface').map(part => part.payloadId);
    if (new Set(payloadIds).size !== payloadIds.length) return false;
    const base = ['id', 'sequence', 'segments', 'kind', 'origin'];
    switch (value.kind) {
        case 'error': case 'warning': case 'info': case 'debug':
            return fields(value, base) && (value.origin === 'diagnostic' || value.origin === 'script');
        case 'generic': return fields(value, [...base, 'label']) && value.origin === 'embedding' && nonempty(value.label);
        case 'model-input': case 'model-output':
            return fields(value, [...base, 'interaction']) && value.origin === 'model' && record(value.interaction) &&
                fields(value.interaction, ['requestId', 'kind', 'role']) && nonempty(value.interaction.requestId) &&
                ['ask', 'think', 'agent', 'blockquote'].includes(String(value.interaction.kind)) &&
                (value.interaction.role === undefined || value.interaction.role === 'response' || value.interaction.role === 'action');
        case 'state': return fields(value, [...base, 'change']) && value.origin === 'state' && stateChange(value.change);
        default: return false;
    }
}

function parentMessage(value: unknown): value is ParentMessage {
    if (!record(value) || value.version !== 1 || !nonempty(value.sessionId)) return false;
    const base = ['version', 'sessionId', 'type'];
    switch (value.type) {
        case 'initialize':
            return fields(value, [...base, 'color', 'terminal']) && typeof value.color === 'boolean' &&
                record(value.terminal) && fields(value.terminal, ['raw', 'width', 'height']) &&
                typeof value.terminal.raw === 'boolean' &&
                (value.terminal.width === undefined || sequence(value.terminal.width)) &&
                (value.terminal.height === undefined || sequence(value.terminal.height));
        case 'event':
            return fields(value, [...base, 'sequence', 'event']) && sequence(value.sequence) &&
                isLogEvent(value.event) && value.sequence === value.event.sequence;
        case 'stream':
            return fields(value, [...base, 'event']) && isModelStreamEvent(value.event);
        case 'activate': return fields(value, base);
        case 'finish':
            return fields(value, [...base, 'lastSequence', 'reason']) && finalSequence(value.lastSequence) &&
                ['completed', 'failed', 'cancelled'].includes(String(value.reason));
        default: return false;
    }
}

function childMessage(value: unknown): value is ChildMessage {
    if (!record(value) || value.version !== 1 || !nonempty(value.sessionId)) return false;
    const base = ['version', 'sessionId', 'type'];
    switch (value.type) {
        case 'prepared': return fields(value, [...base, 'cursorVisible']) && typeof value.cursorVisible === 'boolean';
        case 'ready': return fields(value, [...base, 'restored']) && value.restored === true;
        case 'accepted': return fields(value, [...base, 'sequence']) && sequence(value.sequence);
        case 'finished': return fields(value, [...base, 'restored', 'lastSequence']) && value.restored === true && finalSequence(value.lastSequence);
        case 'cancel': return fields(value, [...base, 'reason']) && value.reason === 'interrupt';
        case 'fatal':
            return fields(value, [...base, 'stage', 'diagnostic']) &&
                ['startup', 'protocol', 'rendering', 'restoration'].includes(String(value.stage)) && nonempty(value.diagnostic);
        default: return false;
    }
}

export function parseParentMessage(value: unknown): ParentMessage {
    if (!parentMessage(value)) throw new Error('renderer protocol: invalid parent message');
    return value;
}
export function parseChildMessage(value: unknown): ChildMessage {
    if (!childMessage(value)) throw new Error('renderer protocol: invalid child message');
    return value;
}

export class RendererProtocol {
    private sessionId?: string;
    private lastSequence: number | null = null;
    private finished = false;
    private activated = false;
    private readonly ids = new Set<string>();
    private readonly endedStreams = new Set<string>();

    accept(raw: unknown): ParentMessage {
        const message = parseParentMessage(raw);
        if (this.sessionId && message.sessionId !== this.sessionId) throw new Error('renderer protocol: wrong session');
        if (this.finished) throw new Error('renderer protocol: message after finish');
        if (message.type === 'initialize') {
            if (this.sessionId) throw new Error('renderer protocol: repeated initialize');
            this.sessionId = message.sessionId;
        } else if (message.type === 'stream') {
            const id = message.event.interaction.requestId;
            if (this.endedStreams.has(id)) throw new Error('renderer protocol: stream update after end');
            if (message.event.type === 'end') this.endedStreams.add(id);
        } else {
            if (!this.sessionId) throw new Error('renderer protocol: initialize required');
            if (message.type === 'activate') {
                if (this.activated) throw new Error('renderer protocol: repeated activate');
                this.activated = true;
            } else if (!this.activated) {
                throw new Error('renderer protocol: activate required');
            } else if (message.type === 'event') {
                if (message.sequence !== (this.lastSequence ?? 0) + 1) throw new Error('renderer protocol: sequence gap');
                if (this.ids.has(message.event.id)) throw new Error('renderer protocol: duplicate event identity');
                this.ids.add(message.event.id);
                this.lastSequence = message.sequence;
            } else {
                if (message.lastSequence !== this.lastSequence) throw new Error('renderer protocol: wrong final sequence');
                this.finished = true;
            }
        }
        return message;
    }
}
