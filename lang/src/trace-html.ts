import * as path from 'node:path';
import hljs from './highlight.js';
import { languageOf, prettyJson } from './log-format.js';
import { scan as scanSource, type SplBlock } from './scanner.js';

export interface TracePaths {
    readonly base: string;
    readonly jsonl: string;
    readonly html: string;
}

/** Resolves `--trace <name>` (or `<name>.jsonl` / `<name>.html`) to its `.jsonl` and `.html` siblings. */
export function tracePaths(target: string): TracePaths {
    const resolved = path.resolve(target);
    const stripped = resolved.replace(/\.(?:jsonl|html)$/i, '');
    const base = path.basename(stripped) ? stripped : resolved;
    return { base, jsonl: `${base}.jsonl`, html: `${base}.html` };
}

export interface TraceHtmlOptions {
    /** Display name of the workflow file (for example `examples/basics.spl`). */
    title?: string;
    /** `.spl` workflow source code, shown with syntax highlighting and line anchors. */
    source?: string;
    /** Path of the `.jsonl` trace file shown in the report metadata. */
    traceFile?: string;
}

interface RawHeader {
    format?: string;
    version?: number;
    source?: string;
    runtime?: string;
    cwd?: string;
    args?: string[];
    configuration?: string;
}

type RawOutcome =
    | { status: 'resolved'; value: unknown }
    | { status: 'error'; statusCode: string; reason: string }
    | { status: 'pending' };

interface EffectPair {
    sequence: number;
    request: Record<string, unknown>;
    rawRequest: string;
    outcome: RawOutcome;
}

interface ParsedToolCall {
    name: string;
    target: string;
    input: unknown;
    output: unknown;
    status: 'success' | 'error' | 'pending';
    expanded: boolean;
    language: string;
    summary: string;
    nested: TimelineNode[];
}

type NodeCategory = 'ask' | 'agent' | 'tool' | 'decision' | 'human' | 'env';

type TimelineNode =
    | {
        kind: 'llm';
        id: string;
        sequence: number;
        category: 'ask' | 'agent';
        hasError: boolean;
        llmKind: 'ask' | 'agent';
        model: string | null;
        reasoningEffort: string | null;
        tokens?: number;
        randomness?: Record<string, unknown>;
        restrictions: unknown[];
        preface: string;
        prompt: string;
        inputs: { name: string; value: string }[];
        schema?: string;
        tools: ParsedToolCall[];
        outcome: RawOutcome;
        responseText?: string;
        reasoning?: string;
        effective?: Record<string, unknown>;
    }
    | {
        kind: 'agent-block';
        id: string;
        sequence: number;
        category: 'agent';
        hasError: boolean;
        line: number;
        instruction: string;
        restrictions: unknown[];
        blockMeta?: SplBlock;
        loadedInputs: { name: string; value: unknown }[];
        savedOutputs: { name: string; value: unknown }[];
        steps: ParsedToolCall[];
        mcpTools: ParsedToolCall[];
        outcome: RawOutcome;
        responseText?: string;
        reasoning?: string;
        effective?: Record<string, unknown>;
    }
    | {
        kind: 'tool';
        id: string;
        sequence: number;
        category: 'tool';
        hasError: boolean;
        call: ParsedToolCall;
        restrictions: unknown[];
    }
    | {
        kind: 'decision';
        id: string;
        sequence: number;
        category: 'decision';
        hasError: boolean;
        question: string;
        evidence: string[];
        labels?: string[];
        requestedModel?: string;
        outcome: RawOutcome;
        probability?: number;
        probabilities?: Record<string, number>;
        chosenLabel?: string;
        effective?: Record<string, unknown>;
    }
    | {
        kind: 'codegen';
        id: string;
        sequence: number;
        category: 'decision';
        hasError: boolean;
        line: number;
        description: string;
        outcome: RawOutcome;
        code?: string;
        cacheFile?: string;
    }
    | {
        kind: 'human';
        id: string;
        sequence: number;
        category: 'human';
        hasError: boolean;
        question: string;
        outcome: RawOutcome;
    }
    | {
        kind: 'restriction';
        id: string;
        sequence: number;
        category: 'env';
        hasError: boolean;
        restrictionKind: string;
        requested: unknown;
        outcome: RawOutcome;
    }
    | {
        kind: 'env-value';
        id: string;
        sequence: number;
        category: 'env';
        hasError: boolean;
        name: string;
        outcome: RawOutcome;
    };

interface ParsedTrace {
    header?: RawHeader;
    nodes: TimelineNode[];
    environment?: Record<string, string>;
    terminal?: { status: 'success'; value: unknown; hasValue: boolean }
        | { status: 'failure'; failure: { status_code: string; reason: string; line?: number; command?: string; source?: string } };
    rawLineCount: number;
    effectCount: number;
}

const escapeHtml = (value: string): string =>
    value.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Trace canonical JSON quotes strings normally and writes BigInt values as `<digits>n`.
 * Rewrites bare BigInt tokens outside strings into `"<digits>n"` so JSON.parse succeeds.
 */
function parseCanonicalJson(raw: string): unknown {
    let normalized = '';
    let inString = false;
    let escaped = false;
    for (let i = 0; i < raw.length; i++) {
        const ch = raw[i];
        if (inString) {
            normalized += ch;
            if (escaped) escaped = false;
            else if (ch === '\\') escaped = true;
            else if (ch === '"') inString = false;
            continue;
        }
        if (ch === '"') {
            inString = true;
            normalized += ch;
            continue;
        }
        if ((ch === '-' || (ch >= '0' && ch <= '9')) && (i === 0 || /[\s[:,{]/.test(raw[i - 1]))) {
            const match = /^-?\d+n(?=[\s\]},]|$)/.exec(raw.slice(i));
            if (match) {
                normalized += JSON.stringify(match[0]);
                i += match[0].length - 1;
                continue;
            }
        }
        normalized += ch;
    }
    return JSON.parse(normalized);
}

function safeParseJson(raw: string): unknown {
    try {
        return parseCanonicalJson(raw);
    } catch {
        return raw;
    }
}

function lineCount(text: string): number {
    if (!text) return 0;
    return text.replace(/\r?\n$/, '').split('\n').length;
}

function plural(count: number, noun: string): string {
    return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function highlightBlock(code: string, language: string): string {
    const lang = language === 'typescript' ? 'ts' : language === 'javascript' ? 'js' : language;
    if (hljs.getLanguage(lang)) {
        try {
            return hljs.highlight(code, { language: lang }).value;
        } catch {
            // Fall through to plain escaped text.
        }
    }
    return escapeHtml(code);
}

function formatJsonOrText(value: unknown): { text: string; language: string } {
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (prettyJson(trimmed) !== undefined) {
            try {
                return { text: JSON.stringify(JSON.parse(trimmed), null, 2), language: 'json' };
            } catch {
                // Keep raw text.
            }
        }
        return { text: value, language: trimmed.startsWith('<') ? 'xml' : 'text' };
    }
    try {
        return { text: JSON.stringify(value, null, 2) ?? String(value), language: 'json' };
    } catch {
        return { text: String(value), language: 'text' };
    }
}

const GENERATED_SECTION = /^(?:Response guidance \(not runtime validation\):|Active restrictions \(enforced by the runtime\):|Answer with a single word\.|Answer in a single sentence\.|Answer in a single paragraph\.|Give a long, detailed answer\.|Respond with ONLY valid JSON\.)/;

/** Separates generated prompt guidance, referenced `@var` inputs and trailing JSON Schema from the prompt. */
function dissectPrompt(fullPrompt: string): {
    preface: string;
    prompt: string;
    inputs: { name: string; value: string }[];
    schema?: string;
} {
    const paragraphs = fullPrompt.split('\n\n');
    const prefaceParts: string[] = [];
    let index = 0;
    while (index < paragraphs.length - 1 && GENERATED_SECTION.test(paragraphs[index])) {
        prefaceParts.push(paragraphs[index++]);
    }
    let body = paragraphs.slice(index).join('\n\n');
    let schema: string | undefined;
    const schemaMarker = '\n\nThe result must satisfy this JSON Schema:\n';
    const schemaAt = body.lastIndexOf(schemaMarker);
    if (schemaAt >= 0) {
        schema = body.slice(schemaAt + schemaMarker.length).trim();
        body = body.slice(0, schemaAt);
    }
    const jsonInstruction = '\n\nReturn ONLY valid JSON, without prose or code fences.';
    if (body.endsWith(jsonInstruction)) {
        body = body.slice(0, -jsonInstruction.length);
    }
    const inputs: { name: string; value: string }[] = [];
    const valuesMarker = '\n\nValues referenced above, as JSON:\n';
    const valuesAt = body.lastIndexOf(valuesMarker);
    if (valuesAt >= 0) {
        const rawValues = body.slice(valuesAt + valuesMarker.length);
        body = body.slice(0, valuesAt);
        for (const line of rawValues.split('\n')) {
            const match = /^@([^\s=]+)\s*=\s*(.*)$/.exec(line);
            if (match) inputs.push({ name: match[1], value: match[2] });
        }
    }
    return { preface: prefaceParts.join('\n\n'), prompt: body, inputs, ...(schema ? { schema } : {}) };
}

function buildBuiltinToolCall(
    name: string,
    params: Record<string, unknown>,
    outcome: RawOutcome,
    nested: TimelineNode[] = [],
): ParsedToolCall {
    const field = (key: string): string => typeof params[key] === 'string' ? params[key] : '';
    const target = name === 'readFile' || name === 'writeFile' ? field('path')
        : name === 'webFetch' ? field('url')
        : name === 'webSearch' ? JSON.stringify(field('query'))
        : name === 'shell' ? field('command')
        : JSON.stringify(params);
    const isShell = name === 'shell';
    if (outcome.status === 'pending') {
        return { name, target, input: params, output: undefined, status: 'pending', expanded: true, language: 'text', summary: 'in progress', nested };
    }
    if (outcome.status === 'error') {
        const message = `${outcome.statusCode}: ${outcome.reason}`;
        return { name, target, input: params, output: message, status: 'error', expanded: true, language: 'text', summary: outcome.reason.split('\n')[0], nested };
    }
    const outputText = typeof outcome.value === 'string' ? outcome.value : JSON.stringify(outcome.value, null, 2) ?? '';
    if (name === 'writeFile') {
        const content = field('content');
        return {
            name, target, input: params, output: outputText, status: 'success',
            expanded: false, language: languageOf(target), summary: `${plural(lineCount(content), 'line')} written`, nested,
        };
    }
    if (name === 'webSearch') {
        const results = outputText.match(/^\d+\. /gm)?.length ?? 0;
        return { name, target, input: params, output: outputText, status: 'success', expanded: false, language: 'text', summary: plural(results, 'result'), nested };
    }
    if (name === 'webFetch') {
        const trimmed = outputText.trimStart();
        const language = prettyJson(trimmed) !== undefined ? 'json' : trimmed.startsWith('<') ? 'xml' : 'text';
        return { name, target, input: params, output: outputText, status: 'success', expanded: false, language, summary: plural(lineCount(outputText), 'line'), nested };
    }
    if (name === 'readFile') {
        return { name, target, input: params, output: outputText, status: 'success', expanded: false, language: languageOf(target), summary: plural(lineCount(outputText), 'line'), nested };
    }
    return {
        name, target, input: params, output: outputText, status: 'success',
        expanded: isShell, language: 'text', summary: outputText ? plural(lineCount(outputText), 'line') : 'no output', nested,
    };
}

function parseLoopToolEntry(raw: string): ParsedToolCall {
    const parsed = safeParseJson(raw);
    if (!isRecord(parsed)) {
        return { name: 'tool', target: '', input: undefined, output: raw, status: 'success', expanded: false, language: 'text', summary: 'result', nested: [] };
    }
    if (typeof parsed.server === 'string' && typeof parsed.tool === 'string') {
        const name = `${parsed.server}/${parsed.tool}`;
        const input = parsed.arguments ?? {};
        const target = JSON.stringify(input) ?? '';
        const ok = Boolean(parsed.success);
        const output = ok ? parsed.result : (parsed.error ?? parsed.result);
        return {
            name, target, input, output, status: ok ? 'success' : 'error',
            expanded: !ok, language: ok ? 'json' : 'text',
            summary: ok ? 'MCP result' : String(parsed.error ?? 'error result').split('\n')[0], nested: [],
        };
    }
    const name = typeof parsed.tool === 'string' ? parsed.tool : 'tool';
    const args = isRecord(parsed.arguments) ? parsed.arguments : {};
    const ok = Boolean(parsed.success);
    const outcome: RawOutcome = ok
        ? { status: 'resolved', value: parsed.output ?? parsed.result ?? '' }
        : { status: 'error', statusCode: 'tool_error', reason: String(parsed.error ?? 'tool failed') };
    return buildBuiltinToolCall(name, args, outcome);
}

function formatRuntimeActionTarget(name: string, args: Record<string, unknown>): string {
    switch (name) {
        case 'loadVariable':
        case 'saveVariable':
            return typeof args.name === 'string' ? `@${args.name}` : '';
        case 'callFunction': {
            const fn = typeof args.name === 'string' ? `@${args.name}` : '';
            const list = Array.isArray(args.args) ? args.args.map(item => JSON.stringify(item)).join(', ') : '';
            return `${fn}(${list})`;
        }
        case 'getEnv':
            return typeof args.name === 'string' ? args.name : '';
        case 'askHuman':
            return typeof args.question === 'string' ? JSON.stringify(args.question) : '';
        case 'setGuidance':
            return typeof args.kind === 'string' && typeof args.text === 'string' ? `${args.kind}: ${args.text}` : JSON.stringify(args);
        default:
            return JSON.stringify(args);
    }
}

function buildAgentRuntimeToolCall(
    name: string,
    args: Record<string, unknown>,
    hasResult: boolean,
    resultValue: unknown,
    childEffects: TimelineNode[],
): ParsedToolCall {
    const Builtins = new Set(['readFile', 'writeFile', 'webFetch', 'webSearch', 'shell']);
    if (Builtins.has(name)) {
        const matchingToolIdx = childEffects.findIndex(item => item.kind === 'tool' && item.call.name === name);
        if (matchingToolIdx >= 0) {
            const toolNode = childEffects[matchingToolIdx];
            const rest = childEffects.filter((_, i) => i !== matchingToolIdx);
            if (toolNode.kind === 'tool') return { ...toolNode.call, nested: rest };
        }
        const outcome: RawOutcome = hasResult ? { status: 'resolved', value: resultValue } : { status: 'pending' };
        return buildBuiltinToolCall(name, args, outcome, childEffects);
    }
    const restNested = childEffects.filter(item =>
        !(name === 'askHuman' && item.kind === 'human') && !(name === 'getEnv' && item.kind === 'env-value'));
    const target = formatRuntimeActionTarget(name, args);
    if (!hasResult) {
        const failedChild = childEffects.find(item => item.hasError);
        if (failedChild && failedChild.kind === 'tool') {
            return { ...failedChild.call, name, target, input: args, nested: restNested };
        }
        return {
            name, target, input: args, output: undefined, status: failedChild ? 'error' : 'pending',
            expanded: true, language: 'text', summary: failedChild ? 'failed' : 'terminated / unfinished', nested: restNested,
        };
    }
    const rejected = name === 'saveVariable' && isRecord(resultValue) && 'rejected' in resultValue && 'hint' in resultValue;
    const formatted = formatJsonOrText(resultValue);
    const lines = lineCount(formatted.text);
    const shortScalar = (typeof resultValue === 'number' || typeof resultValue === 'boolean' || resultValue === null
        || (typeof resultValue === 'string' && !resultValue.includes('\n') && resultValue.length <= 100));
    return {
        name, target, input: args, output: resultValue,
        status: rejected ? 'error' : 'success',
        expanded: Boolean(rejected || shortScalar),
        language: formatted.language,
        summary: rejected ? `rejected: ${String(resultValue.rejected)}`
            : shortScalar ? JSON.stringify(resultValue) ?? String(resultValue)
            : plural(lines, 'line'),
        nested: restNested,
    };
}

function parseTraceJournal(jsonl: string, blocksByLine: ReadonlyMap<number, SplBlock>): ParsedTrace {
    const rawLines = jsonl.split(/\r?\n/).filter(line => line.trim().length > 0);
    let header: RawHeader | undefined;
    let environment: Record<string, string> | undefined;
    let terminal: ParsedTrace['terminal'];
    const pairs: EffectPair[] = [];
    const bySeq = new Map<number, EffectPair>();

    rawLines.forEach((line, idx) => {
        const row = safeParseJson(line);
        if (!isRecord(row)) return;
        if (idx === 0 && row.format === 'spl-trace') {
            header = {
                format: String(row.format),
                version: typeof row.version === 'number' ? row.version : undefined,
                source: typeof row.source === 'string' ? row.source : undefined,
                runtime: typeof row.runtime === 'string' ? row.runtime : undefined,
                cwd: typeof row.cwd === 'string' ? row.cwd : undefined,
                args: Array.isArray(row.args) ? row.args.map(String) : [],
                configuration: typeof row.configuration === 'string' ? row.configuration : undefined,
            };
            return;
        }
        if (row.type === 'intent' && typeof row.sequence === 'number' && typeof row.request === 'string') {
            const parsedReq = safeParseJson(row.request);
            const pair: EffectPair = {
                sequence: row.sequence,
                request: isRecord(parsedReq) ? parsedReq : { kind: 'unknown', raw: row.request },
                rawRequest: row.request,
                outcome: { status: 'pending' },
            };
            pairs.push(pair);
            bySeq.set(row.sequence, pair);
        } else if (row.type === 'outcome' && typeof row.sequence === 'number' && isRecord(row.outcome)) {
            const target = bySeq.get(row.sequence);
            if (!target) return;
            if ('error' in row.outcome && isRecord(row.outcome.error)) {
                target.outcome = {
                    status: 'error',
                    statusCode: String(row.outcome.error.status_code ?? 'error'),
                    reason: String(row.outcome.error.reason ?? ''),
                };
            } else if ('value' in row.outcome) {
                target.outcome = { status: 'resolved', value: row.outcome.value };
            }
        } else if (row.type === 'environment' && isRecord(row.value)) {
            environment = Object.fromEntries(Object.entries(row.value).map(([k, v]) => [k, String(v)]));
        } else if (row.type === 'terminal' && typeof row.result === 'string') {
            const parsed = safeParseJson(row.result);
            if (isRecord(parsed) && parsed.status === 'success') {
                terminal = { status: 'success', value: parsed.value, hasValue: Boolean(parsed.hasValue) };
            } else if (isRecord(parsed) && parsed.status === 'failure' && isRecord(parsed.failure)) {
                terminal = {
                    status: 'failure',
                    failure: {
                        status_code: String(parsed.failure.status_code ?? 'runtime_error'),
                        reason: String(parsed.failure.reason ?? ''),
                        ...(typeof parsed.failure.line === 'number' ? { line: parsed.failure.line } : {}),
                        ...(typeof parsed.failure.command === 'string' ? { command: parsed.failure.command } : {}),
                        ...(typeof parsed.failure.source === 'string' ? { source: parsed.failure.source } : {}),
                    },
                };
            }
        }
    });

    let cursor = 0;
    const consumeRange = (stopAt?: { line: number; text: string; expectedHistoryLength: number }): TimelineNode[] => {
        const items: TimelineNode[] = [];
        while (cursor < pairs.length) {
            const current = pairs[cursor];
            const kind = String(current.request.kind ?? '');
            if (stopAt && kind === 'agent-block'
                && current.request.line === stopAt.line
                && current.request.text === stopAt.text) {
                const hist = safeParseJson(String(current.request.history ?? '[]'));
                if (Array.isArray(hist) && hist.length === stopAt.expectedHistoryLength) {
                    break;
                }
            }
            items.push(consumeOne());
        }
        return items;
    };

    const consumeOne = (): TimelineNode => {
        const pair = pairs[cursor++];
        const req = pair.request;
        const kind = String(req.kind ?? '');
        const id = `step-${pair.sequence}`;

        if (kind === 'agent-block') {
            const line = typeof req.line === 'number' ? req.line : 0;
            const instruction = typeof req.text === 'string' ? req.text : '';
            const restrictions = Array.isArray(req.restrictions) ? req.restrictions : [];
            const decisions: { pair: EffectPair; children: TimelineNode[] }[] = [];
            let active: EffectPair = pair;
            let stepIndex = 0;

            for (;;) {
                const out = active.outcome;
                const hasAction = out.status === 'resolved' && isRecord(out.value) && isRecord(out.value.action);
                if (!hasAction) {
                    decisions.push({ pair: active, children: [] });
                    break;
                }
                stepIndex++;
                const children = consumeRange({ line, text: instruction, expectedHistoryLength: stepIndex });
                decisions.push({ pair: active, children });
                const next = pairs[cursor];
                if (next && next.request.kind === 'agent-block' && next.request.line === line && next.request.text === instruction) {
                    const hist = safeParseJson(String(next.request.history ?? '[]'));
                    if (Array.isArray(hist) && hist.length === stepIndex) {
                        cursor++;
                        active = next;
                        continue;
                    }
                }
                break;
            }

            const lastDecision = decisions.at(-1)!.pair;
            const lastHistoryRaw = safeParseJson(String(lastDecision.request.history ?? '[]'));
            const historyEntries = Array.isArray(lastHistoryRaw) ? lastHistoryRaw : [];
            const steps: ParsedToolCall[] = [];
            const loadedInputs: { name: string; value: unknown }[] = [];
            const savedMap = new Map<string, unknown>();

            decisions.forEach((entry, idx) => {
                const out = entry.pair.outcome;
                if (out.status !== 'resolved' || !isRecord(out.value) || !isRecord(out.value.action)) return;
                const actName = String(out.value.action.name ?? '');
                const actArgs = isRecord(out.value.action.arguments) ? out.value.action.arguments : {};
                const histItem = historyEntries[idx];
                const hasResult = isRecord(histItem) && isRecord(histItem.result) && 'value' in histItem.result;
                const resultValue = hasResult ? (histItem.result as Record<string, unknown>).value : undefined;

                if (actName === 'loadVariable' && hasResult && typeof actArgs.name === 'string') {
                    loadedInputs.push({ name: actArgs.name, value: resultValue });
                }
                if (actName === 'saveVariable' && hasResult && typeof actArgs.name === 'string') {
                    const rejected = isRecord(resultValue) && 'rejected' in resultValue && 'hint' in resultValue;
                    if (!rejected) savedMap.set(actArgs.name, resultValue);
                }
                steps.push(buildAgentRuntimeToolCall(actName, actArgs, hasResult, resultValue, entry.children));
            });

            const finalOutcome = lastDecision.outcome;
            let responseText: string | undefined;
            let reasoning: string | undefined;
            let effective: Record<string, unknown> | undefined;
            const mcpTools: ParsedToolCall[] = [];
            if (finalOutcome.status === 'resolved' && isRecord(finalOutcome.value)) {
                if (!isRecord(finalOutcome.value.action) && typeof finalOutcome.value.text === 'string') {
                    responseText = finalOutcome.value.text;
                }
                if (typeof finalOutcome.value.reasoning === 'string') reasoning = finalOutcome.value.reasoning;
                if (isRecord(finalOutcome.value.effective) && Object.keys(finalOutcome.value.effective).length > 0) {
                    effective = finalOutcome.value.effective;
                }
                if (Array.isArray(finalOutcome.value.toolResults)) {
                    for (const raw of finalOutcome.value.toolResults) {
                        if (typeof raw === 'string') mcpTools.push(parseLoopToolEntry(raw));
                    }
                }
            }

            const hasError = finalOutcome.status === 'error'
                || steps.some(step => step.status === 'error')
                || mcpTools.some(tool => tool.status === 'error');

            return {
                kind: 'agent-block', id, sequence: pair.sequence, category: 'agent', hasError,
                line, instruction, restrictions,
                blockMeta: blocksByLine.get(line),
                loadedInputs,
                savedOutputs: [...savedMap.entries()].map(([name, value]) => ({ name, value })),
                steps, mcpTools,
                outcome: finalOutcome, responseText, reasoning, effective,
            };
        }

        if (kind === 'llm' && isRecord(req.request)) {
            const inner = req.request;
            const llmKind = inner.kind === 'agent' ? 'agent' : 'ask';
            const dissected = dissectPrompt(typeof inner.prompt === 'string' ? inner.prompt : '');
            const tools: ParsedToolCall[] = [];
            let responseText: string | undefined;
            let reasoning: string | undefined;
            let effective: Record<string, unknown> | undefined;
            if (pair.outcome.status === 'resolved' && isRecord(pair.outcome.value)) {
                if (typeof pair.outcome.value.text === 'string') responseText = pair.outcome.value.text;
                if (typeof pair.outcome.value.reasoning === 'string') reasoning = pair.outcome.value.reasoning;
                if (isRecord(pair.outcome.value.effective) && Object.keys(pair.outcome.value.effective).length > 0) {
                    effective = pair.outcome.value.effective;
                }
                if (Array.isArray(pair.outcome.value.toolResults)) {
                    for (const raw of pair.outcome.value.toolResults) {
                        if (typeof raw === 'string') tools.push(parseLoopToolEntry(raw));
                    }
                }
            }
            const hasError = pair.outcome.status === 'error' || tools.some(tool => tool.status === 'error');
            return {
                kind: 'llm', id, sequence: pair.sequence, category: llmKind, hasError,
                llmKind,
                model: typeof inner.model === 'string' ? inner.model : null,
                reasoningEffort: typeof inner.reasoningEffort === 'string' ? inner.reasoningEffort : null,
                ...(typeof inner.tokens === 'number' ? { tokens: inner.tokens } : {}),
                ...(isRecord(inner.randomness) ? { randomness: inner.randomness } : {}),
                restrictions: Array.isArray(req.restrictions) ? req.restrictions : [],
                ...dissected,
                tools, outcome: pair.outcome, responseText, reasoning, effective,
            };
        }

        if (kind === 'tool') {
            const toolName = typeof req.tool === 'string' ? req.tool : 'tool';
            const params = isRecord(req.params) ? req.params : {};
            const call = buildBuiltinToolCall(toolName, params, pair.outcome);
            return {
                kind: 'tool', id, sequence: pair.sequence, category: 'tool',
                hasError: call.status === 'error', call,
                restrictions: Array.isArray(req.restrictions) ? req.restrictions : [],
            };
        }

        if (kind === 'decision' && isRecord(req.request)) {
            const inner = req.request;
            let probability: number | undefined;
            let probabilities: Record<string, number> | undefined;
            let chosenLabel: string | undefined;
            let effective: Record<string, unknown> | undefined;
            if (pair.outcome.status === 'resolved' && isRecord(pair.outcome.value)) {
                if (typeof pair.outcome.value.probability === 'number') probability = pair.outcome.value.probability;
                if (typeof pair.outcome.value.label === 'string') chosenLabel = pair.outcome.value.label;
                if (isRecord(pair.outcome.value.probabilities)) {
                    probabilities = Object.fromEntries(Object.entries(pair.outcome.value.probabilities)
                        .filter(([, v]) => typeof v === 'number') as [string, number][]);
                }
                if (isRecord(pair.outcome.value.effective)) effective = pair.outcome.value.effective;
            }
            return {
                kind: 'decision', id, sequence: pair.sequence, category: 'decision',
                hasError: pair.outcome.status === 'error',
                question: typeof inner.question === 'string' ? inner.question : '',
                evidence: Array.isArray(inner.evidence) ? inner.evidence.map(String) : [],
                ...(Array.isArray(inner.labels) ? { labels: inner.labels.map(String) } : {}),
                ...(typeof inner.model === 'string' ? { requestedModel: inner.model } : {}),
                outcome: pair.outcome, probability, probabilities, chosenLabel, effective,
            };
        }

        if (kind === 'codegen') {
            let code: string | undefined;
            let cacheFile: string | undefined;
            if (pair.outcome.status === 'resolved' && isRecord(pair.outcome.value)) {
                if (typeof pair.outcome.value.text === 'string') code = pair.outcome.value.text;
                if (typeof pair.outcome.value.file === 'string') cacheFile = pair.outcome.value.file;
            }
            return {
                kind: 'codegen', id, sequence: pair.sequence, category: 'decision',
                hasError: pair.outcome.status === 'error',
                line: typeof req.line === 'number' ? req.line : 0,
                description: typeof req.text === 'string' ? req.text : '',
                outcome: pair.outcome, code, cacheFile,
            };
        }

        if (kind === 'human') {
            return {
                kind: 'human', id, sequence: pair.sequence, category: 'human',
                hasError: pair.outcome.status === 'error',
                question: typeof req.question === 'string' ? req.question : '',
                outcome: pair.outcome,
            };
        }

        if (kind === 'environment-value') {
            return {
                kind: 'env-value', id, sequence: pair.sequence, category: 'env',
                hasError: pair.outcome.status === 'error',
                name: typeof req.name === 'string' ? req.name : '',
                outcome: pair.outcome,
            };
        }

        return {
            kind: 'restriction', id, sequence: pair.sequence, category: 'env',
            hasError: pair.outcome.status === 'error',
            restrictionKind: typeof req.restriction === 'string' ? req.restriction : kind || 'effect',
            requested: req.value ?? req,
            outcome: pair.outcome,
        };
    };

    const nodes = consumeRange();
    return { header, nodes, environment, terminal, rawLineCount: rawLines.length, effectCount: pairs.length };
}

function renderCodeFigure(code: string, language: string, label?: string): string {
    const shownLabel = label ?? language;
    return `<figure class="code-surface"><figcaption><span class="code-dots" aria-hidden="true"><i></i><i></i><i></i></span><span class="code-lang">${escapeHtml(shownLabel)}</span></figcaption><pre tabindex="0"><code class="language-${escapeHtml(language)}">${highlightBlock(code, language)}</code></pre></figure>`;
}

function renderValueBox(value: unknown, label?: string): string {
    const { text, language } = formatJsonOrText(value);
    if (language === 'json' || text.includes('\n') || text.length > 120) {
        return renderCodeFigure(text, language, label ?? language);
    }
    return `<div class="value-inline"><code>${escapeHtml(text)}</code></div>`;
}

function renderStatusPill(status: 'success' | 'error' | 'pending', text?: string): string {
    const label = text ?? (status === 'success' ? 'ok' : status === 'error' ? 'error' : 'pending');
    return `<span class="status-pill status-${status}">${escapeHtml(label)}</span>`;
}

function renderEffectiveMeta(effective?: Record<string, unknown>): string {
    if (!effective) return '';
    const chips: string[] = [];
    if (typeof effective.provider === 'string' && typeof effective.model === 'string') {
        chips.push(`${effective.provider}/${effective.model}`);
    } else if (typeof effective.model === 'string') {
        chips.push(effective.model);
    }
    if (typeof effective.reasoningEffort === 'string') chips.push(`reasoning: ${effective.reasoningEffort}`);
    if (typeof effective.tokens === 'number') chips.push(`tokens: ${effective.tokens}`);
    if (effective.simulated === true) chips.push('simulated');
    return chips.map(chip => `<span class="meta-chip">${escapeHtml(chip)}</span>`).join('');
}

function renderToolCallItem(call: ParsedToolCall): string {
    const inputFormatted = formatJsonOrText(call.input);
    const hasOutput = call.output !== undefined && call.output !== '';
    const outputFormatted = hasOutput ? formatJsonOrText(call.output) : undefined;
    const writeInput = call.name === 'writeFile' && isRecord(call.input) && typeof call.input.content === 'string' ? call.input : undefined;
    const openAttr = call.expanded ? ' open' : '';

    const nestedHtml = call.nested.length
        ? `<div class="nested-effects">${call.nested.map((child, idx) => renderTimelineNode(child, idx, true)).join('')}</div>`
        : '';

    return `<div class="tool-entry tool-status-${call.status}">
  <div class="tool-head">
    <span class="tool-badge">${escapeHtml(call.name)}</span>
    <code class="tool-target">${escapeHtml(call.target)}</code>
    <span class="tool-summary">${escapeHtml(call.summary)}</span>
    ${renderStatusPill(call.status)}
  </div>
  <details class="disclosure"${openAttr}>
    <summary>Input &amp; output${outputFormatted ? ` · ${escapeHtml(call.summary)}` : ''}</summary>
    <div class="disclosure-body">
      <div class="io-grid">
        <div class="io-block">
          <div class="io-label">Tool input</div>
          ${writeInput
              ? `<div class="meta-kv"><span>path</span><code>${escapeHtml(String(writeInput.path ?? ''))}</code></div>${renderCodeFigure(String(writeInput.content), call.language, `${String(writeInput.path ?? 'content')}`)}`
              : renderCodeFigure(inputFormatted.text, inputFormatted.language, 'arguments')}
        </div>
        <div class="io-block">
          <div class="io-label">Tool output</div>
          ${outputFormatted
              ? renderCodeFigure(outputFormatted.text, call.language === 'text' ? outputFormatted.language : call.language, call.status === 'error' ? 'error' : 'output')
              : `<p class="empty-note">${call.status === 'pending' ? 'No recorded output (interrupted).' : 'Empty output.'}</p>`}
        </div>
      </div>
    </div>
  </details>
  ${nestedHtml}
</div>`;
}

function renderOutcomeError(outcome: RawOutcome): string {
    if (outcome.status === 'error') {
        return `<div class="error-callout"><strong>${escapeHtml(outcome.statusCode)}</strong><pre>${escapeHtml(outcome.reason)}</pre></div>`;
    }
    if (outcome.status === 'pending') {
        return `<div class="pending-callout">Interrupted before an outcome was recorded.</div>`;
    }
    return '';
}

function renderRestrictionsList(restrictions: unknown[]): string {
    if (!restrictions.length) return '';
    const tags = restrictions.flatMap(item => {
        if (!isRecord(item) || typeof item.kind !== 'string' || !Array.isArray(item.values)) return [];
        return [`restrict ${item.kind}: ${item.values.map(String).join(', ')}`];
    });
    if (!tags.length) return '';
    return `<div class="restriction-strip">${tags.map(tag => `<span class="guard-chip">${escapeHtml(tag)}</span>`).join('')}</div>`;
}

function renderTimelineNode(node: TimelineNode, index: number, nested = false): string {
    const deferredClass = !nested && index >= 6 ? ' deferred' : '';
    const errorAttr = node.hasError ? ' data-error="true"' : '';
    const hasTools = node.kind === 'tool'
        || (node.kind === 'llm' && node.tools.length > 0)
        || (node.kind === 'agent-block' && (node.steps.length > 0 || node.mcpTools.length > 0));
    const toolsAttr = hasTools ? ' data-has-tools="true"' : '';
    const cardOpen = `<article id="${escapeHtml(node.id)}" class="timeline-card${nested ? ' nested-card' : ''}${deferredClass}" data-category="${node.category}"${toolsAttr}${errorAttr}>`;

    switch (node.kind) {
        case 'llm': {
            const status = node.outcome.status === 'error' ? 'error' : node.outcome.status === 'pending' ? 'pending' : 'success';
            const label = node.llmKind === 'agent' ? 'Agent loop' : 'Ask';
            return `${cardOpen}
  <header class="card-header">
    <span class="step-index">#${node.sequence + 1}</span>
    <span class="kind-badge kind-${node.llmKind}">${label}</span>
    ${node.model ? `<span class="meta-chip">${escapeHtml(node.model)}</span>` : ''}
    ${node.reasoningEffort ? `<span class="meta-chip">reasoning: ${escapeHtml(node.reasoningEffort)}</span>` : ''}
    ${renderEffectiveMeta(node.effective)}
    ${node.tools.length ? `<span class="meta-chip">${plural(node.tools.length, 'tool call')}</span>` : ''}
    <span class="header-spacer"></span>
    ${renderStatusPill(status)}
  </header>
  ${renderRestrictionsList(node.restrictions)}
  <div class="card-body">
    <div class="io-section">
      <div class="io-label">Input prompt</div>
      ${node.preface ? `<details class="disclosure"><summary>Generated guidance &amp; restrictions (${plural(lineCount(node.preface), 'line')})</summary><div class="disclosure-body">${renderCodeFigure(node.preface, 'markdown', 'preamble')}</div></details>` : ''}
      <div class="prompt-box"><pre>${escapeHtml(node.prompt)}</pre></div>
      ${node.inputs.length ? `<div class="var-list"><div class="io-sublabel">Referenced inputs</div>${node.inputs.map(inp => `<div class="var-row"><code class="var-name">@${escapeHtml(inp.name)}</code>${renderValueBox(safeParseJson(inp.value), `@${inp.name}`)}</div>`).join('')}</div>` : ''}
      ${node.schema ? `<details class="disclosure"><summary>Output JSON Schema</summary><div class="disclosure-body">${renderCodeFigure(formatJsonOrText(safeParseJson(node.schema)).text, 'json', 'schema')}</div></details>` : ''}
    </div>
    ${node.tools.length ? `<div class="io-section"><div class="io-label">Tool usage (${node.tools.length})</div><div class="tool-stack">${node.tools.map(renderToolCallItem).join('')}</div></div>` : ''}
    ${node.reasoning ? `<details class="disclosure"><summary>Model reasoning (${plural(lineCount(node.reasoning), 'line')})</summary><div class="disclosure-body"><div class="reasoning-box"><pre>${escapeHtml(node.reasoning)}</pre></div></div></details>` : ''}
    <div class="io-section">
      <div class="io-label">Output</div>
      ${node.responseText !== undefined ? renderValueBox(node.responseText, `${node.llmKind} response`) : ''}
      ${renderOutcomeError(node.outcome)}
    </div>
  </div>
</article>`;
        }

        case 'agent-block': {
            const status = node.outcome.status === 'error' ? 'error' : node.outcome.status === 'pending' ? 'pending' : 'success';
            const totalTools = node.steps.length + node.mcpTools.length;
            const declaredInputs = node.blockMeta?.inputs ?? [];
            const declaredOutputs = node.blockMeta?.outputs ?? [];
            return `${cardOpen}
  <header class="card-header">
    <span class="step-index">#${node.sequence + 1}</span>
    <span class="kind-badge kind-agent">Agent block</span>
    ${node.line ? `<a class="line-link" href="#L${node.line}">line ${node.line}</a>` : ''}
    ${renderEffectiveMeta(node.effective)}
    <span class="meta-chip">${plural(totalTools, 'tool call')}</span>
    <span class="header-spacer"></span>
    ${renderStatusPill(status)}
  </header>
  ${renderRestrictionsList(node.restrictions)}
  <div class="card-body">
    <div class="io-section">
      <div class="io-label">Agent instruction &amp; inputs</div>
      <div class="prompt-box"><pre>${escapeHtml(node.instruction)}</pre></div>
      ${declaredInputs.length ? `<div class="chip-row"><span class="chip-caption">Inputs in scope:</span>${declaredInputs.map(inp => `<code class="ref-chip">@${escapeHtml(inp.name)}</code>`).join('')}</div>` : ''}
      ${declaredOutputs.length ? `<div class="chip-row"><span class="chip-caption">Declared outputs:</span>${declaredOutputs.map(out => `<code class="ref-chip">@${out.assign ? '=' : ''}${escapeHtml(out.name)}${out.type ? `: ${escapeHtml(out.type)}` : ''}</code>`).join('')}</div>` : ''}
      ${node.loadedInputs.length ? `<div class="var-list"><div class="io-sublabel">Loaded input values</div>${node.loadedInputs.map(inp => `<div class="var-row"><code class="var-name">@${escapeHtml(inp.name)}</code>${renderValueBox(inp.value, `@${inp.name}`)}</div>`).join('')}</div>` : ''}
    </div>
    ${(node.steps.length || node.mcpTools.length) ? `<div class="io-section"><div class="io-label">Agent loop tool usage (${totalTools})</div><div class="tool-stack">${node.steps.map(renderToolCallItem).join('')}${node.mcpTools.map(renderToolCallItem).join('')}</div></div>` : ''}
    ${node.reasoning ? `<details class="disclosure"><summary>Model reasoning (${plural(lineCount(node.reasoning), 'line')})</summary><div class="disclosure-body"><div class="reasoning-box"><pre>${escapeHtml(node.reasoning)}</pre></div></div></details>` : ''}
    <div class="io-section">
      <div class="io-label">Agent outputs &amp; response</div>
      ${node.savedOutputs.length ? `<div class="var-list">${node.savedOutputs.map(out => `<div class="var-row"><code class="var-name">@${escapeHtml(out.name)}</code>${renderValueBox(out.value, `@${out.name}`)}</div>`).join('')}</div>` : ''}
      ${node.responseText ? renderValueBox(node.responseText, 'agent response') : ''}
      ${renderOutcomeError(node.outcome)}
    </div>
  </div>
</article>`;
        }

        case 'tool': {
            return `${cardOpen}
  <header class="card-header">
    <span class="step-index">#${node.sequence + 1}</span>
    <span class="kind-badge kind-tool">Tool</span>
    <span class="meta-chip">${escapeHtml(node.call.name)}</span>
    <span class="header-spacer"></span>
    ${renderStatusPill(node.call.status)}
  </header>
  ${renderRestrictionsList(node.restrictions)}
  <div class="card-body">
    ${renderToolCallItem(node.call)}
  </div>
</article>`;
        }

        case 'decision': {
            const status = node.outcome.status === 'error' ? 'error' : node.outcome.status === 'pending' ? 'pending' : 'success';
            const probPct = node.probability !== undefined ? `${(node.probability * 100).toFixed(1)}%` : undefined;
            return `${cardOpen}
  <header class="card-header">
    <span class="step-index">#${node.sequence + 1}</span>
    <span class="kind-badge kind-decision">Decision</span>
    ${node.requestedModel ? `<span class="meta-chip">${escapeHtml(node.requestedModel)}</span>` : ''}
    ${renderEffectiveMeta(node.effective)}
    <span class="header-spacer"></span>
    ${renderStatusPill(status)}
  </header>
  <div class="card-body">
    <div class="io-section">
      <div class="io-label">Question</div>
      <div class="prompt-box"><pre>${escapeHtml(node.question)}</pre></div>
      ${node.evidence.length ? `<details class="disclosure"><summary>Evidence (${plural(node.evidence.length, 'item')})</summary><div class="disclosure-body"><ol class="evidence-list">${node.evidence.map(item => `<li><pre>${escapeHtml(item)}</pre></li>`).join('')}</ol></div></details>` : ''}
    </div>
    <div class="io-section">
      <div class="io-label">Decision output</div>
      ${probPct !== undefined ? `<div class="prob-meter"><div class="prob-bar"><span style="inline-size:${Math.max(0, Math.min(100, node.probability! * 100)).toFixed(1)}%"></span></div><code>P(yes) = ${escapeHtml(String(node.probability))} (${probPct})</code></div>` : ''}
      ${node.probabilities ? `<div class="prob-list">${Object.entries(node.probabilities).map(([lbl, p]) => `<div class="prob-row${node.chosenLabel === lbl ? ' chosen' : ''}"><code>${escapeHtml(lbl)}</code><div class="prob-bar"><span style="inline-size:${Math.max(0, Math.min(100, p * 100)).toFixed(1)}%"></span></div><span>${(p * 100).toFixed(1)}%</span></div>`).join('')}</div>` : ''}
      ${renderOutcomeError(node.outcome)}
    </div>
  </div>
</article>`;
        }

        case 'codegen': {
            const status = node.outcome.status === 'error' ? 'error' : node.outcome.status === 'pending' ? 'pending' : 'success';
            return `${cardOpen}
  <header class="card-header">
    <span class="step-index">#${node.sequence + 1}</span>
    <span class="kind-badge kind-decision">Codegen</span>
    ${node.line ? `<a class="line-link" href="#L${node.line}">line ${node.line}</a>` : ''}
    ${node.cacheFile ? `<span class="meta-chip">${escapeHtml(path.basename(node.cacheFile))}</span>` : ''}
    <span class="header-spacer"></span>
    ${renderStatusPill(status)}
  </header>
  <div class="card-body">
    <div class="io-section">
      <div class="io-label">Function specification</div>
      <div class="prompt-box"><pre>${escapeHtml(node.description)}</pre></div>
    </div>
    <div class="io-section">
      <div class="io-label">Generated JavaScript</div>
      ${node.code ? renderCodeFigure(node.code, 'js', node.cacheFile ? path.basename(node.cacheFile) : 'generated.js') : ''}
      ${renderOutcomeError(node.outcome)}
    </div>
  </div>
</article>`;
        }

        case 'human': {
            const status = node.outcome.status === 'error' ? 'error' : node.outcome.status === 'pending' ? 'pending' : 'success';
            return `${cardOpen}
  <header class="card-header">
    <span class="step-index">#${node.sequence + 1}</span>
    <span class="kind-badge kind-human">Human input</span>
    <span class="header-spacer"></span>
    ${renderStatusPill(status)}
  </header>
  <div class="card-body">
    <div class="io-grid">
      <div class="io-block">
        <div class="io-label">Question</div>
        <div class="prompt-box"><pre>${escapeHtml(node.question)}</pre></div>
      </div>
      <div class="io-block">
        <div class="io-label">Answer</div>
        ${node.outcome.status === 'resolved' ? renderValueBox(node.outcome.value, 'answer') : renderOutcomeError(node.outcome)}
      </div>
    </div>
  </div>
</article>`;
        }

        case 'env-value': {
            const status = node.outcome.status === 'error' ? 'error' : node.outcome.status === 'pending' ? 'pending' : 'success';
            return `${cardOpen}
  <header class="card-header">
    <span class="step-index">#${node.sequence + 1}</span>
    <span class="kind-badge kind-env">Environment read</span>
    <code>${escapeHtml(node.name)}</code>
    <span class="header-spacer"></span>
    ${renderStatusPill(status)}
  </header>
  <div class="card-body">
    ${node.outcome.status === 'resolved' ? renderValueBox(node.outcome.value, node.name) : renderOutcomeError(node.outcome)}
  </div>
</article>`;
        }

        case 'restriction': {
            const status = node.outcome.status === 'error' ? 'error' : node.outcome.status === 'pending' ? 'pending' : 'success';
            return `${cardOpen}
  <header class="card-header">
    <span class="step-index">#${node.sequence + 1}</span>
    <span class="kind-badge kind-env">Restriction</span>
    <code>${escapeHtml(node.restrictionKind)}</code>
    <span class="header-spacer"></span>
    ${renderStatusPill(status)}
  </header>
  <div class="card-body">
    <div class="io-grid">
      <div class="io-block"><div class="io-label">Requested</div>${renderValueBox(node.requested, 'spec')}</div>
      <div class="io-block"><div class="io-label">Resolved scope</div>${node.outcome.status === 'resolved' ? renderValueBox(node.outcome.value, 'resolved') : renderOutcomeError(node.outcome)}</div>
    </div>
  </div>
</article>`;
        }
    }
}

function outlineLabel(node: TimelineNode): string {
    switch (node.kind) {
        case 'llm': return `${node.llmKind} · ${node.prompt.split('\n')[0].slice(0, 38) || 'prompt'}`;
        case 'agent-block': return `agent block${node.line ? ` :${node.line}` : ''} · ${node.instruction.split('\n')[0].slice(0, 32)}`;
        case 'tool': return `${node.call.name} ${node.call.target}`.slice(0, 44);
        case 'decision': return `decision · ${node.question.split('\n')[0].slice(0, 34)}`;
        case 'codegen': return `codegen${node.line ? ` :${node.line}` : ''} · ${node.description.split('\n')[0].slice(0, 32)}`;
        case 'human': return `human · ${node.question.split('\n')[0].slice(0, 36)}`;
        case 'env-value': return `env · ${node.name}`;
        case 'restriction': return `restrict · ${node.restrictionKind}`;
    }
}

function renderSourceSection(source: string, title: string, failLine?: number): string {
    const highlightedLines = highlightBlock(source.replace(/\r\n/g, '\n'), 'spl').split('\n');
    const rows = highlightedLines.map((lineHtml, idx) => {
        const lineNo = idx + 1;
        const failed = failLine === lineNo ? ' class="source-line is-failure"' : ' class="source-line"';
        return `<div id="L${lineNo}"${failed}><a class="line-num" href="#L${lineNo}" aria-label="Line ${lineNo}">${lineNo}</a><span class="line-code">${lineHtml || ' '}</span></div>`;
    }).join('');
    return `<section id="workflow-source" class="panel source-panel deferred" aria-labelledby="source-heading">
  <div class="section-head">
    <h2 id="source-heading">Workflow source</h2>
    <span class="meta-chip">${escapeHtml(title)} · ${plural(highlightedLines.length, 'line')}</span>
  </div>
  <figure class="code-surface source-listing">
    <figcaption><span class="code-dots" aria-hidden="true"><i></i><i></i><i></i></span><span class="code-lang">${escapeHtml(title)}</span></figcaption>
    <div class="source-scroll" tabindex="0">${rows}</div>
  </figure>
</section>`;
}

/** Renders a `.jsonl` workflow trace into a self-contained, interactive HTML report. */
export function traceHtml(jsonl: string, options: TraceHtmlOptions = {}): string {
    const blocksByLine = new Map<number, SplBlock>();
    if (options.source) {
        const scanned = scanSource(options.source);
        for (const block of scanned.blocks) blocksByLine.set(block.line, block);
    }
    const trace = parseTraceJournal(jsonl, blocksByLine);
    const title = options.title ?? 'workflow.spl';

    let askCount = 0;
    let agentCount = 0;
    let toolCount = 0;
    let errorCount = 0;
    const countTools = (calls: ParsedToolCall[]): void => {
        for (const call of calls) {
            toolCount++;
            if (call.status === 'error') errorCount++;
            for (const nested of call.nested) visit(nested);
        }
    };
    const visit = (node: TimelineNode): void => {
        if (node.kind === 'llm') {
            if (node.llmKind === 'ask') askCount++;
            else agentCount++;
            if (node.outcome.status === 'error') errorCount++;
            countTools(node.tools);
        } else if (node.kind === 'agent-block') {
            agentCount++;
            if (node.outcome.status === 'error') errorCount++;
            countTools(node.steps);
            countTools(node.mcpTools);
        } else if (node.kind === 'tool') {
            toolCount++;
            if (node.call.status === 'error') errorCount++;
        } else if (node.outcome.status === 'error') {
            errorCount++;
        }
    };
    for (const node of trace.nodes) visit(node);

    const runState: 'completed' | 'failed' | 'interrupted' = !trace.terminal
        ? 'interrupted'
        : trace.terminal.status === 'success' ? 'completed' : 'failed';
    const failLine = trace.terminal?.status === 'failure' ? trace.terminal.failure.line : undefined;

    const resultHtml = !trace.terminal
        ? `<div class="pending-callout">This trace has no terminal record yet. Re-run with the same <code>--trace</code> path to resume from the last sealed effect.</div>`
        : trace.terminal.status === 'success'
            ? (trace.terminal.hasValue ? renderValueBox(trace.terminal.value, 'result') : `<p class="empty-note">Workflow completed without a return value (<code>success()</code> was not called with a value).</p>`)
            : `<div class="error-callout">
                <div class="failure-meta">
                  <strong>${escapeHtml(trace.terminal.failure.status_code)}</strong>
                  ${trace.terminal.failure.line ? `<a class="line-link" href="#L${trace.terminal.failure.line}">line ${trace.terminal.failure.line}</a>` : ''}
                  ${trace.terminal.failure.source ? `<code>${escapeHtml(trace.terminal.failure.source)}</code>` : ''}
                </div>
                <pre>${escapeHtml(trace.terminal.failure.reason)}</pre>
                ${trace.terminal.failure.command ? `<div class="failure-cmd"><span>Statement:</span><code>${escapeHtml(trace.terminal.failure.command)}</code></div>` : ''}
              </div>`;

    const envEntries = trace.environment ? Object.entries(trace.environment).sort(([a], [b]) => a.localeCompare(b)) : [];
    const envSection = envEntries.length
        ? `<section id="environment" class="panel deferred" aria-labelledby="env-heading">
            <div class="section-head">
              <h2 id="env-heading">Recorded environment</h2>
              <span class="meta-chip">${plural(envEntries.length, 'variable')}</span>
            </div>
            <details class="disclosure">
              <summary>Inspect captured environment snapshot (${plural(envEntries.length, 'entry')})</summary>
              <div class="disclosure-body">
                <div class="env-table-wrap" tabindex="0">
                  <table class="env-table">
                    <thead><tr><th>Variable</th><th>Value</th></tr></thead>
                    <tbody>${envEntries.map(([k, v]) => `<tr><td><code>${escapeHtml(k)}</code></td><td><code>${escapeHtml(v)}</code></td></tr>`).join('')}</tbody>
                  </table>
                </div>
              </div>
            </details>
          </section>`
        : '';

    const timelineHtml = trace.nodes.length
        ? trace.nodes.map((node, index) => renderTimelineNode(node, index)).join('\n')
        : `<p class="empty-note panel">No external library effects were recorded during this run.</p>`;

    const outlineItems = trace.nodes.map(node => {
        const dotClass = node.hasError ? 'dot-error' : `dot-${node.category}`;
        return `<li><a href="#${escapeHtml(node.id)}"><span class="nav-dot ${dotClass}" aria-hidden="true"></span><span class="nav-seq">#${node.sequence + 1}</span><span class="nav-text">${escapeHtml(outlineLabel(node))}</span></a></li>`;
    }).join('');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(title)} — SPL Trace</title>
<script>try{const t=localStorage.getItem('spl-theme');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch{}</script>
<style>
:root {
  --paper-light: #fcfbf8;
  --paper-dark: #171917;
  --surface-light: #fffefa;
  --surface-dark: #202320;
  --subtle-light: #f3f1ec;
  --subtle-dark: #282c28;
  --hover-light: #eae6dd;
  --hover-dark: #313631;
  --ink-light: #232522;
  --ink-dark: #efeee8;
  --muted-light: #64655e;
  --muted-dark: #b2b3a9;
  --faint-light: #78776e;
  --faint-dark: #94968b;
  --line-light: #e5e1d8;
  --line-dark: #353934;
  --accent-light: #ad432f;
  --accent-dark: #f0a38a;
  --accent-soft-light: #f6e8e1;
  --accent-soft-dark: #3a2b25;
  --green-light: #2b754e;
  --green-dark: #86cfa3;
  --green-soft-light: #e3f3ea;
  --green-soft-dark: #1f3529;
  --red-light: #b42318;
  --red-dark: #f98078;
  --red-soft-light: #fdeae8;
  --red-soft-dark: #3b201e;
  --amber-light: #946200;
  --amber-dark: #f0c36d;
  --amber-soft-light: #fdf3dc;
  --amber-soft-dark: #382e1a;
  --plum-light: #6d35b5;
  --plum-dark: #ceb4ff;
  --plum-soft-light: #f0e8fc;
  --plum-soft-dark: #2d233d;
  --teal-light: #0f6d66;
  --teal-dark: #74dfd5;
  --teal-soft-light: #e0f4f2;
  --teal-soft-dark: #1c3533;

  --paper: var(--paper-light);
  --surface: var(--surface-light);
  --subtle: var(--subtle-light);
  --hover: var(--hover-light);
  --ink: var(--ink-light);
  --muted: var(--muted-light);
  --faint: var(--faint-light);
  --line: var(--line-light);
  --accent: var(--accent-light);
  --accent-soft: var(--accent-soft-light);
  --green: var(--green-light);
  --green-soft: var(--green-soft-light);
  --red: var(--red-light);
  --red-soft: var(--red-soft-light);
  --amber: var(--amber-light);
  --amber-soft: var(--amber-soft-light);
  --plum: var(--plum-light);
  --plum-soft: var(--plum-soft-light);
  --teal: var(--teal-light);
  --teal-soft: var(--teal-soft-light);

  color-scheme: light dark;
  --font: "Segoe UI", -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif;
  --mono: "Cascadia Code", "SFMono-Regular", Consolas, "Liberation Mono", monospace;
  --serif: "Iowan Old Style", "Palatino Linotype", Georgia, serif;
  --header-h: 3.9rem;
  font-family: var(--font);
  accent-color: var(--accent);
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --paper: var(--paper-dark);
    --surface: var(--surface-dark);
    --subtle: var(--subtle-dark);
    --hover: var(--hover-dark);
    --ink: var(--ink-dark);
    --muted: var(--muted-dark);
    --faint: var(--faint-dark);
    --line: var(--line-dark);
    --accent: var(--accent-dark);
    --accent-soft: var(--accent-soft-dark);
    --green: var(--green-dark);
    --green-soft: var(--green-soft-dark);
    --red: var(--red-dark);
    --red-soft: var(--red-soft-dark);
    --amber: var(--amber-dark);
    --amber-soft: var(--amber-soft-dark);
    --plum: var(--plum-dark);
    --plum-soft: var(--plum-soft-dark);
    --teal: var(--teal-dark);
    --teal-soft: var(--teal-soft-dark);
  }
}

:root[data-theme="light"] { color-scheme: light; }
:root[data-theme="dark"] {
  color-scheme: dark;
  --paper: var(--paper-dark);
  --surface: var(--surface-dark);
  --subtle: var(--subtle-dark);
  --hover: var(--hover-dark);
  --ink: var(--ink-dark);
  --muted: var(--muted-dark);
  --faint: var(--faint-dark);
  --line: var(--line-dark);
  --accent: var(--accent-dark);
  --accent-soft: var(--accent-soft-dark);
  --green: var(--green-dark);
  --green-soft: var(--green-soft-dark);
  --red: var(--red-dark);
  --red-soft: var(--red-soft-dark);
  --amber: var(--amber-dark);
  --amber-soft: var(--amber-soft-dark);
  --plum: var(--plum-dark);
  --plum-soft: var(--plum-soft-dark);
  --teal: var(--teal-dark);
  --teal-soft: var(--teal-soft-dark);
}

@supports (color: light-dark(white, black)) {
  :root {
    --paper: light-dark(var(--paper-light), var(--paper-dark));
    --surface: light-dark(var(--surface-light), var(--surface-dark));
    --subtle: light-dark(var(--subtle-light), var(--subtle-dark));
    --hover: light-dark(var(--hover-light), var(--hover-dark));
    --ink: light-dark(var(--ink-light), var(--ink-dark));
    --muted: light-dark(var(--muted-light), var(--muted-dark));
    --faint: light-dark(var(--faint-light), var(--faint-dark));
    --line: light-dark(var(--line-light), var(--line-dark));
    --accent: light-dark(var(--accent-light), var(--accent-dark));
    --accent-soft: light-dark(var(--accent-soft-light), var(--accent-soft-dark));
    --green: light-dark(var(--green-light), var(--green-dark));
    --green-soft: light-dark(var(--green-soft-light), var(--green-soft-dark));
    --red: light-dark(var(--red-light), var(--red-dark));
    --red-soft: light-dark(var(--red-soft-light), var(--red-soft-dark));
    --amber: light-dark(var(--amber-light), var(--amber-dark));
    --amber-soft: light-dark(var(--amber-soft-light), var(--amber-soft-dark));
    --plum: light-dark(var(--plum-light), var(--plum-dark));
    --plum-soft: light-dark(var(--plum-soft-light), var(--plum-soft-dark));
    --teal: light-dark(var(--teal-light), var(--teal-dark));
    --teal-soft: light-dark(var(--teal-soft-light), var(--teal-soft-dark));
  }
}

*, *::before, *::after { box-sizing: border-box; }
body, h1, h2, h3, p, figure, pre { margin: 0; }
html { scroll-padding-block-start: calc(var(--header-h) + 1.5rem); }
body { background: var(--paper); color: var(--ink); font-size: 0.94rem; line-height: 1.6; }
code, pre { font-family: var(--mono); }
button, input { font: inherit; color: inherit; }
button { cursor: pointer; }
a { color: inherit; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; border-radius: 4px; }
[hidden] { display: none !important; }

.skip-link { position: fixed; inset-block-start: 0.5rem; inset-inline-start: 0.5rem; z-index: 100; padding: 0.55rem 0.9rem; background: var(--ink); color: var(--paper); border-radius: 0.4rem; text-decoration: none; translate: 0 -200%; }
.skip-link:focus { translate: 0 0; }

.site-header { position: sticky; inset-block-start: 0; z-index: 20; background: var(--paper); border-block-end: 1px solid var(--line); }
.header-inner { max-inline-size: 96rem; min-block-size: var(--header-h); margin-inline: auto; padding-inline: 1.5rem; display: flex; align-items: center; gap: 1rem; }
.brand { display: inline-flex; align-items: center; gap: 0.75rem; text-decoration: none; }
.brand-mark { font-size: 1.85rem; font-weight: 760; letter-spacing: -0.14em; line-height: 1; }
.brand-mark > span:first-child, .brand-dot { color: var(--accent); }
.brand-divider { inline-size: 1px; block-size: 1.25rem; background: var(--line); }
.brand-subtitle { font-size: 0.78rem; font-weight: 600; color: var(--muted); letter-spacing: 0.02em; }
.header-file { font-family: var(--mono); font-size: 0.8rem; padding: 0.22rem 0.6rem; border-radius: 0.35rem; background: var(--subtle); border: 1px solid var(--line); color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-inline-size: 28rem; }
.header-actions { margin-inline-start: auto; display: flex; align-items: center; gap: 0.55rem; }
.theme-btn { display: inline-flex; align-items: center; gap: 0.4rem; padding: 0.38rem 0.7rem; border: 1px solid var(--line); border-radius: 0.45rem; background: var(--surface); font-size: 0.76rem; color: var(--muted); }
.theme-btn:hover { background: var(--subtle); color: var(--ink); }

.workspace { max-inline-size: 96rem; margin-inline: auto; padding: 1.6rem 1.5rem 4rem; display: grid; grid-template-columns: 16.5rem minmax(0, 1fr); gap: 2rem; align-items: start; }
.rail { position: sticky; inset-block-start: calc(var(--header-h) + 1.4rem); max-block-size: calc(100dvh - var(--header-h) - 2.5rem); overflow-y: auto; overscroll-behavior: contain; padding-inline-end: 0.75rem; border-inline-end: 1px solid var(--line); }
.rail-group + .rail-group { margin-block-start: 1.25rem; }
.rail-title { font-size: 0.68rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: var(--faint); margin-block-end: 0.45rem; padding-inline: 0.45rem; }
.rail ul { list-style: none; margin: 0; padding: 0; }
.rail li + li { margin-block-start: 0.12rem; }
.rail a { display: flex; align-items: center; gap: 0.45rem; padding: 0.34rem 0.5rem; border-radius: 0.38rem; text-decoration: none; font-size: 0.76rem; color: var(--muted); line-height: 1.35; }
.rail a:hover { background: var(--subtle); color: var(--ink); }
.nav-dot { inline-size: 0.45rem; block-size: 0.45rem; border-radius: 50%; flex-shrink: 0; background: var(--faint); }
.dot-ask { background: var(--plum); }
.dot-agent { background: var(--teal); }
.dot-tool { background: var(--green); }
.dot-decision { background: var(--accent); }
.dot-human { background: var(--amber); }
.dot-error { background: var(--red); }
.nav-seq { font-family: var(--mono); font-size: 0.68rem; color: var(--faint); flex-shrink: 0; }
.nav-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

main { min-inline-size: 0; display: flex; flex-direction: column; gap: 1.5rem; }
.panel { background: var(--surface); border: 1px solid var(--line); border-radius: 0.75rem; padding: 1.35rem 1.5rem; }

.hero-top { display: flex; flex-wrap: wrap; align-items: center; gap: 0.85rem; margin-block-end: 1rem; }
.hero-top h1 { font-size: clamp(1.35rem, 1.1rem + 1vw, 1.85rem); font-weight: 650; letter-spacing: -0.03em; }
.outcome-badge { display: inline-flex; align-items: center; gap: 0.4rem; padding: 0.28rem 0.75rem; border-radius: 99rem; font-size: 0.76rem; font-weight: 650; font-family: var(--mono); }
.outcome-completed { background: var(--green-soft); color: var(--green); }
.outcome-failed { background: var(--red-soft); color: var(--red); }
.outcome-interrupted { background: var(--amber-soft); color: var(--amber); }

.stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(8.5rem, 1fr)); gap: 0.75rem; margin-block: 1rem 1.2rem; }
.stat-card { padding: 0.75rem 0.95rem; border-radius: 0.55rem; background: var(--subtle); border: 1px solid var(--line); }
.stat-value { display: block; font-size: 1.35rem; font-weight: 700; font-family: var(--mono); line-height: 1.2; }
.stat-label { font-size: 0.72rem; color: var(--muted); }

.context-meta { display: flex; flex-wrap: wrap; gap: 0.45rem 0.9rem; font-size: 0.75rem; color: var(--muted); padding-block-start: 0.85rem; border-block-start: 1px solid var(--line); margin-block-start: 1rem; }
.context-meta code { font-size: 0.74rem; background: var(--subtle); padding: 0.1rem 0.38rem; border-radius: 0.25rem; border: 1px solid var(--line); }

.section-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.75rem; margin-block-end: 1rem; }
.section-head h2 { font-size: 1.12rem; font-weight: 650; letter-spacing: -0.02em; }

.controls-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 0.55rem; padding: 0.75rem 0.95rem; background: var(--surface); border: 1px solid var(--line); border-radius: 0.65rem; }
.filter-pills { display: flex; flex-wrap: wrap; gap: 0.35rem; }
.filter-pill { position: relative; display: inline-flex; align-items: center; padding: 0.28rem 0.68rem; border-radius: 99rem; border: 1px solid var(--line); background: var(--subtle); font-size: 0.75rem; font-weight: 550; color: var(--muted); cursor: pointer; user-select: none; }
.filter-pill:hover { color: var(--ink); border-color: var(--faint); }
.filter-pill input { position: absolute; opacity: 0; pointer-events: none; }
.filter-pill:has(input:checked) { background: var(--accent-soft); color: var(--accent); border-color: var(--accent); }
.search-input { flex: 1 1 12rem; min-inline-size: 10rem; padding: 0.34rem 0.68rem; border: 1px solid var(--line); border-radius: 0.45rem; background: var(--paper); font-size: 0.8rem; }
.toggle-all-btn { padding: 0.34rem 0.72rem; border: 1px solid var(--line); border-radius: 0.45rem; background: var(--subtle); font-size: 0.75rem; font-weight: 550; color: var(--ink); }
.toggle-all-btn:hover { background: var(--hover); }
.toggle-all-btn[aria-expanded="true"] .label-expand,
.toggle-all-btn[aria-expanded="false"] .label-collapse { display: none; }

#trace-explorer:has(#filter-ask:checked) .timeline-list > .timeline-card:not([data-category="ask"]),
#trace-explorer:has(#filter-agent:checked) .timeline-list > .timeline-card:not([data-category="agent"]),
#trace-explorer:has(#filter-tool:checked) .timeline-list > .timeline-card:not([data-has-tools="true"]),
#trace-explorer:has(#filter-decision:checked) .timeline-list > .timeline-card:not([data-category="decision"]),
#trace-explorer:has(#filter-human:checked) .timeline-list > .timeline-card:not([data-category="human"]),
#trace-explorer:has(#filter-error:checked) .timeline-list > .timeline-card:not([data-error="true"]) {
  display: none;
}

@supports not selector(:has(*)) {
  .filter-pill.is-active { background: var(--accent-soft); color: var(--accent); border-color: var(--accent); }
  #trace-explorer[data-active-filter="ask"] .timeline-list > .timeline-card:not([data-category="ask"]),
  #trace-explorer[data-active-filter="agent"] .timeline-list > .timeline-card:not([data-category="agent"]),
  #trace-explorer[data-active-filter="tool"] .timeline-list > .timeline-card:not([data-has-tools="true"]),
  #trace-explorer[data-active-filter="decision"] .timeline-list > .timeline-card:not([data-category="decision"]),
  #trace-explorer[data-active-filter="human"] .timeline-list > .timeline-card:not([data-category="human"]),
  #trace-explorer[data-active-filter="error"] .timeline-list > .timeline-card:not([data-error="true"]) {
    display: none;
  }
}

.timeline-list { display: flex; flex-direction: column; gap: 1rem; margin-block-start: 1rem; }
.timeline-card { background: var(--surface); border: 1px solid var(--line); border-radius: 0.75rem; overflow: clip; }
.timeline-card:has(details[open]) { border-color: var(--faint); }
.timeline-card[data-error="true"] { border-inline-start: 3px solid var(--red); }
.nested-card { margin-block-start: 0.65rem; background: var(--paper); }

.deferred { content-visibility: auto; contain-intrinsic-size: auto none auto 220px; }

.card-header { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem; padding: 0.8rem 1.15rem; background: var(--subtle); border-block-end: 1px solid var(--line); }
.step-index { font-family: var(--mono); font-size: 0.74rem; font-weight: 700; color: var(--faint); }
.header-spacer { margin-inline-start: auto; }
.kind-badge { font-size: 0.72rem; font-weight: 700; padding: 0.16rem 0.55rem; border-radius: 0.35rem; letter-spacing: 0.02em; }
.kind-ask { background: var(--plum-soft); color: var(--plum); }
.kind-agent { background: var(--teal-soft); color: var(--teal); }
.kind-tool { background: var(--green-soft); color: var(--green); }
.kind-decision { background: var(--accent-soft); color: var(--accent); }
.kind-human { background: var(--amber-soft); color: var(--amber); }
.kind-env { background: var(--hover); color: var(--muted); }

.meta-chip, .guard-chip, .ref-chip { font-family: var(--mono); font-size: 0.71rem; padding: 0.14rem 0.48rem; border-radius: 0.3rem; background: var(--surface); border: 1px solid var(--line); color: var(--muted); }
.line-link { font-family: var(--mono); font-size: 0.72rem; padding: 0.14rem 0.48rem; border-radius: 0.3rem; background: var(--accent-soft); color: var(--accent); text-decoration: none; font-weight: 600; }
.line-link:hover { text-decoration: underline; }

.status-pill { font-family: var(--mono); font-size: 0.69rem; font-weight: 700; padding: 0.14rem 0.5rem; border-radius: 99rem; text-transform: uppercase; letter-spacing: 0.04em; }
.status-success { background: var(--green-soft); color: var(--green); }
.status-error { background: var(--red-soft); color: var(--red); }
.status-pending { background: var(--amber-soft); color: var(--amber); }

.restriction-strip { display: flex; flex-wrap: wrap; gap: 0.4rem; padding: 0.5rem 1.15rem; background: var(--paper); border-block-end: 1px solid var(--line); }
.guard-chip { color: var(--amber); background: var(--amber-soft); border-color: transparent; }

.card-body { padding: 1.05rem 1.15rem; display: flex; flex-direction: column; gap: 0.95rem; }
.io-section { display: flex; flex-direction: column; gap: 0.5rem; }
.io-label { font-size: 0.7rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.07em; color: var(--faint); }
.io-sublabel { font-size: 0.73rem; font-weight: 600; color: var(--muted); margin-block-end: 0.25rem; }
.io-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 20rem), 1fr)); gap: 0.85rem; }
.io-block { min-inline-size: 0; display: flex; flex-direction: column; gap: 0.4rem; }

.prompt-box, .reasoning-box { padding: 0.8rem 0.95rem; border-radius: 0.5rem; border: 1px solid var(--line); background: var(--paper); }
.prompt-box pre, .reasoning-box pre { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 0.83rem; line-height: 1.6; }
.reasoning-box { border-inline-start: 3px solid var(--plum); color: var(--muted); }

.chip-row { display: flex; flex-wrap: wrap; align-items: center; gap: 0.4rem; margin-block-start: 0.15rem; }
.chip-caption { font-size: 0.74rem; color: var(--muted); }
.var-list { display: flex; flex-direction: column; gap: 0.55rem; }
.var-row { display: flex; flex-direction: column; gap: 0.3rem; padding: 0.6rem 0.75rem; border-radius: 0.5rem; background: var(--subtle); border: 1px solid var(--line); }
.var-name { font-size: 0.78rem; font-weight: 700; color: var(--accent); }
.value-inline code { font-size: 0.82rem; background: var(--surface); padding: 0.2rem 0.45rem; border-radius: 0.3rem; border: 1px solid var(--line); overflow-wrap: anywhere; }

.tool-stack { display: flex; flex-direction: column; gap: 0.6rem; }
.tool-entry { border: 1px solid var(--line); border-radius: 0.55rem; background: var(--paper); padding: 0.65rem 0.85rem; }
.tool-status-error { border-inline-start: 3px solid var(--red); }
.tool-head { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem; margin-block-end: 0.35rem; }
.tool-badge { font-family: var(--mono); font-size: 0.75rem; font-weight: 700; color: var(--ink); background: var(--subtle); padding: 0.12rem 0.45rem; border-radius: 0.3rem; border: 1px solid var(--line); }
.tool-target { font-size: 0.78rem; color: var(--accent); overflow-wrap: anywhere; }
.tool-summary { font-family: var(--mono); font-size: 0.72rem; color: var(--muted); margin-inline-start: auto; }
.nested-effects { margin-block-start: 0.6rem; padding-inline-start: 0.75rem; border-inline-start: 2px solid var(--line); }

details.disclosure { border: 1px solid var(--line); border-radius: 0.48rem; background: var(--subtle); }
details.disclosure > summary { list-style: none; display: flex; align-items: center; gap: 0.5ch; padding: 0.45rem 0.7rem; font-size: 0.76rem; font-weight: 600; color: var(--muted); cursor: pointer; user-select: none; }
details.disclosure > summary::-webkit-details-marker { display: none; }
details.disclosure > summary:hover { color: var(--ink); }
details.disclosure > summary::before {
  content: "";
  inline-size: 0.85em;
  block-size: 0.85em;
  flex-shrink: 0;
  background-color: currentColor;
  mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round' d='M4 6l4 4 4-4'/%3E%3C/svg%3E") no-repeat center / contain;
  rotate: -90deg;
}
details.disclosure > summary:dir(rtl)::before { rotate: 90deg; }
details.disclosure[open] > summary::before { rotate: 0deg; }
details.disclosure::details-content { interpolate-size: allow-keywords; overflow: clip; contain: layout; }
details.disclosure:not([open])::details-content { block-size: 0; }
@media (prefers-reduced-motion: no-preference) {
  details.disclosure > summary::before { transition: rotate 0.18s ease; }
  details.disclosure::details-content { transition: block-size 0.2s ease, content-visibility 0.2s ease; transition-behavior: allow-discrete; }
}
.disclosure-body { padding: 0.7rem; border-block-start: 1px solid var(--line); background: var(--surface); border-radius: 0 0 0.45rem 0.45rem; }

.code-surface, pre { color-scheme: dark; accent-color: var(--accent); }
.code-surface { border: 1px solid #343932; border-radius: 0.55rem; background: #1e221e; color: #ecebe3; overflow: hidden; min-inline-size: 0; }
.code-surface figcaption { display: flex; align-items: center; gap: 0.55rem; padding: 0.38rem 0.75rem; background: #262b26; border-block-end: 1px solid #343932; font-family: var(--mono); font-size: 0.7rem; color: #a7aaa0; }
.code-dots { display: inline-flex; gap: 0.28rem; }
.code-dots i { inline-size: 0.46rem; block-size: 0.46rem; border-radius: 50%; background: #4b5149; display: block; }
.code-surface pre { padding: 0.75rem 0.9rem; overflow-x: auto; font-size: 0.79rem; line-height: 1.6; white-space: pre-wrap; overflow-wrap: anywhere; }

.hljs-keyword, .hljs-meta { color: #f3a58c; }
.hljs-string, .hljs-regexp { color: #b9df97; }
.hljs-number, .hljs-literal { color: #f2cc81; }
.hljs-title, .hljs-section { color: #9ad8d3; }
.hljs-attr, .hljs-property, .hljs-variable { color: #d6c4ff; }
.hljs-comment { color: #8c9288; font-style: italic; }
.hljs-built_in, .hljs-type { color: #8fd4ce; }

.source-scroll { max-block-size: 38rem; overflow: auto; padding-block: 0.5rem; font-family: var(--mono); font-size: 0.79rem; line-height: 1.65; }
.source-line { display: grid; grid-template-columns: 3.4rem minmax(0, 1fr); padding-inline: 0.5rem 0.9rem; }
.source-line:target { background: #ad432f38; }
.source-line.is-failure { background: #b4231838; }
.line-num { color: #788076; text-align: end; padding-inline-end: 0.85rem; text-decoration: none; user-select: none; }
.line-num:hover { color: #ecebe3; }
.line-code { white-space: pre-wrap; overflow-wrap: anywhere; }

.prob-meter, .prob-row { display: flex; align-items: center; gap: 0.75rem; font-size: 0.8rem; }
.prob-list { display: flex; flex-direction: column; gap: 0.4rem; }
.prob-row.chosen { font-weight: 700; color: var(--green); }
.prob-bar { flex: 1 1 8rem; max-inline-size: 16rem; block-size: 0.55rem; border-radius: 99rem; background: var(--subtle); border: 1px solid var(--line); overflow: hidden; }
.prob-bar > span { display: block; block-size: 100%; background: var(--accent); border-radius: 99rem; }
.evidence-list { margin: 0; padding-inline-start: 1.25rem; display: flex; flex-direction: column; gap: 0.35rem; }
.evidence-list pre { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 0.78rem; }

.error-callout { padding: 0.8rem 0.95rem; border-radius: 0.5rem; background: var(--red-soft); color: var(--red); border: 1px solid var(--red); display: flex; flex-direction: column; gap: 0.45rem; }
.error-callout pre { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 0.8rem; color: var(--ink); }
.failure-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem; }
.failure-cmd { display: flex; flex-wrap: wrap; gap: 0.4rem; font-size: 0.76rem; color: var(--ink); }
.pending-callout { padding: 0.75rem 0.95rem; border-radius: 0.5rem; background: var(--amber-soft); color: var(--amber); font-size: 0.82rem; }
.meta-kv { display: flex; align-items: center; gap: 0.5rem; font-size: 0.76rem; margin-block-end: 0.35rem; color: var(--muted); }
.empty-note { color: var(--muted); font-size: 0.82rem; font-style: italic; }

.env-table-wrap { max-block-size: 22rem; overflow: auto; }
.env-table { inline-size: 100%; border-collapse: collapse; font-size: 0.77rem; }
.env-table th, .env-table td { text-align: start; padding: 0.38rem 0.6rem; border-block-end: 1px solid var(--line); vertical-align: top; overflow-wrap: anywhere; }
.env-table th { color: var(--muted); font-weight: 600; background: var(--subtle); position: sticky; inset-block-start: 0; }

.page-footer { border-block-start: 1px solid var(--line); padding-block-start: 1.1rem; display: flex; flex-wrap: wrap; justify-content: space-between; gap: 0.6rem; font-size: 0.74rem; color: var(--faint); }
.page-footer em { font-family: var(--serif); }

@media (max-width: 62rem) {
  .workspace { grid-template-columns: minmax(0, 1fr); }
  .rail { position: static; max-block-size: none; border-inline-end: 0; border-block-end: 1px solid var(--line); padding-block-end: 1rem; padding-inline-end: 0; }
}
</style>
</head>
<body>
<a class="skip-link" href="#main-content">Skip to trace content</a>
<header class="site-header">
  <div class="header-inner">
    <a class="brand" href="#main-content">
      <span class="brand-mark" aria-hidden="true">s<span>p</span>l<span class="brand-dot">.</span></span>
      <span class="brand-divider" aria-hidden="true"></span>
      <span class="brand-subtitle">Workflow Trace</span>
    </a>
    <span class="header-file" title="${escapeHtml(title)}">${escapeHtml(title)}</span>
    <div class="header-actions">
      <button type="button" class="theme-btn" id="theme-toggle" aria-label="Switch color theme">Theme</button>
    </div>
  </div>
</header>

<div class="workspace">
  <aside class="rail" aria-label="Trace outline">
    <div class="rail-group">
      <div class="rail-title">Sections</div>
      <ul>
        <li><a href="#run-summary">Run summary &amp; result</a></li>
        <li><a href="#trace-explorer">Execution timeline (${trace.nodes.length})</a></li>
        ${envEntries.length ? '<li><a href="#environment">Environment</a></li>' : ''}
        ${options.source !== undefined ? '<li><a href="#workflow-source">Workflow source</a></li>' : ''}
      </ul>
    </div>
    ${outlineItems ? `<div class="rail-group"><div class="rail-title">Steps</div><ul>${outlineItems}</ul></div>` : ''}
  </aside>

  <main id="main-content" tabindex="-1">
    <section id="run-summary" class="panel" aria-labelledby="summary-heading">
      <div class="hero-top">
        <h1 id="summary-heading">${escapeHtml(title)}</h1>
        <span class="outcome-badge outcome-${runState}">${runState === 'completed' ? '✓ Completed' : runState === 'failed' ? '✗ Failed' : '● Interrupted'}</span>
      </div>
      <div class="stats-grid">
        <div class="stat-card"><span class="stat-value">${trace.effectCount}</span><span class="stat-label">Recorded effects</span></div>
        <div class="stat-card"><span class="stat-value">${askCount}</span><span class="stat-label">Ask calls</span></div>
        <div class="stat-card"><span class="stat-value">${agentCount}</span><span class="stat-label">Agent runs</span></div>
        <div class="stat-card"><span class="stat-value">${toolCount}</span><span class="stat-label">Tool executions</span></div>
        <div class="stat-card"><span class="stat-value">${errorCount}</span><span class="stat-label">Errors</span></div>
      </div>
      <div class="io-section">
        <div class="io-label">${runState === 'failed' ? 'Failure payload' : 'Workflow result'}</div>
        ${resultHtml}
      </div>
      <div class="context-meta">
        ${trace.header?.cwd ? `<span>cwd: <code>${escapeHtml(trace.header.cwd)}</code></span>` : ''}
        ${trace.header?.args?.length ? `<span>args: <code>${escapeHtml(JSON.stringify(trace.header.args))}</code></span>` : '<span>args: <code>[]</code></span>'}
        ${options.traceFile ? `<span>trace: <code>${escapeHtml(options.traceFile)}</code></span>` : ''}
        ${trace.header?.source ? `<span>source sha256: <code>${escapeHtml(trace.header.source.slice(0, 12))}…</code></span>` : ''}
      </div>
    </section>

    <section id="trace-explorer" aria-labelledby="timeline-heading">
      <div class="section-head">
        <h2 id="timeline-heading">Execution timeline</h2>
      </div>
      <div class="controls-bar">
        <div class="filter-pills" role="radiogroup" aria-label="Filter trace steps">
          <label class="filter-pill is-active"><input type="radio" name="trace-filter" id="filter-all" value="all" checked>All (${trace.nodes.length})</label>
          <label class="filter-pill"><input type="radio" name="trace-filter" id="filter-ask" value="ask">Ask (${askCount})</label>
          <label class="filter-pill"><input type="radio" name="trace-filter" id="filter-agent" value="agent">Agent (${agentCount})</label>
          <label class="filter-pill"><input type="radio" name="trace-filter" id="filter-tool" value="tool">Tools (${toolCount})</label>
          <label class="filter-pill"><input type="radio" name="trace-filter" id="filter-decision" value="decision">Decisions &amp; Codegen</label>
          <label class="filter-pill"><input type="radio" name="trace-filter" id="filter-human" value="human">Human</label>
          <label class="filter-pill"><input type="radio" name="trace-filter" id="filter-error" value="error">Errors (${errorCount})</label>
        </div>
        <input type="search" id="trace-search" class="search-input" placeholder="Filter steps by text…" aria-label="Filter steps by text" autocomplete="off" spellcheck="false">
        <button type="button" id="toggle-all-details" class="toggle-all-btn" aria-expanded="false">
          <span class="label-expand">Expand all</span>
          <span class="label-collapse">Collapse all</span>
        </button>
      </div>
      <div class="timeline-list" id="timeline-list">
        ${timelineHtml}
      </div>
    </section>

    ${envSection}
    ${options.source !== undefined ? renderSourceSection(options.source, title, failLine) : ''}

    <footer class="page-footer">
      <span>Generated by <strong>spl</strong> · ${plural(trace.rawLineCount, 'JSONL record')}</span>
      <em>Short loops. Clear boundaries.</em>
    </footer>
  </main>
</div>

<script>
(() => {
  const root = document.documentElement;
  const themeBtn = document.getElementById('theme-toggle');
  themeBtn?.addEventListener('click', () => {
    const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    const next = dark ? 'light' : 'dark';
    root.dataset.theme = next;
    try { localStorage.setItem('spl-theme', next); } catch {}
  });

  const explorer = document.getElementById('trace-explorer');
  const toggleBtn = document.getElementById('toggle-all-details');
  const getDisclosures = () => Array.from(explorer ? explorer.querySelectorAll('details.disclosure') : []);
  const syncToggleState = () => {
    if (!toggleBtn) return;
    const items = getDisclosures();
    const allOpen = items.length > 0 && items.every(d => d.open);
    toggleBtn.setAttribute('aria-expanded', String(allOpen));
  };
  toggleBtn?.addEventListener('click', () => {
    const expand = toggleBtn.getAttribute('aria-expanded') !== 'true';
    for (const details of getDisclosures()) details.open = expand;
    syncToggleState();
  });
  document.addEventListener('toggle', event => {
    if (event.target instanceof HTMLDetailsElement && explorer?.contains(event.target)) syncToggleState();
  }, { capture: true });
  syncToggleState();

  const searchInput = document.getElementById('trace-search');
  const cards = Array.from(document.querySelectorAll('#timeline-list > .timeline-card'));
  searchInput?.addEventListener('input', () => {
    const query = searchInput.value.trim().toLowerCase();
    for (const card of cards) {
      card.hidden = query !== '' && !(card.textContent || '').toLowerCase().includes(query);
    }
  });

  if (!CSS.supports('selector(:has(*))') && explorer) {
    const radios = explorer.querySelectorAll('input[name="trace-filter"]');
    radios.forEach(radio => {
      radio.addEventListener('change', () => {
        explorer.dataset.activeFilter = radio.value;
        explorer.querySelectorAll('.filter-pill').forEach(pill => {
          pill.classList.toggle('is-active', pill.contains(radio));
        });
      });
    });
  }
})();
</script>
</body>
</html>
`;
}
