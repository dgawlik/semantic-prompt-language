import { isDeepStrictEqual } from 'node:util';
import { Failure } from './errors.js';
import { currentContext, display } from './runtime.js';
import { TOOL_SPECS, type ToolName } from './tools.js';

export interface JudgeResult {
    judge: 'faithful' | 'toolUse';
    pass: boolean;
    score?: number;
    reason: string;
}

export interface EvalScope {
    phase: 'arrange' | 'assert';
    readonly pendingArrange: Promise<unknown>[];
    readonly pendingJudges: Promise<JudgeResult>[];
    readonly results: JudgeResult[];
}

export interface EvalRegistration {
    name: string;
    fn: () => Promise<void>;
}

const AGENT_TOOL_ARGS: Record<string, readonly string[]> = {
    loadVariable: ['name'],
    saveVariable: ['name', 'value'],
    callFunction: ['name', 'args'],
    getEnv: ['name'],
    askHuman: ['question'],
    setGuidance: ['kind', 'text'],
};

const JUDGE_SCHEMA = {
    type: 'object',
    properties: {
        score: { type: 'number', minimum: 0, maximum: 1 },
        reason: { type: 'string' },
    },
    required: ['score', 'reason'],
    additionalProperties: false,
} as const;

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
    (typeof value === 'object' || typeof value === 'function') && value !== null && typeof (value as PromiseLike<unknown>).then === 'function';

function serializeActual(value: unknown): string {
    if (typeof value === 'string') return value;
    try {
        const json = JSON.stringify(value, null, 2);
        return json !== undefined ? json : String(value);
    } catch {
        return String(value);
    }
}

function positionalArgs(name: string, rawArgs: Record<string, unknown> | unknown[]): unknown[] {
    if (Array.isArray(rawArgs)) return rawArgs;
    if (Object.hasOwn(TOOL_SPECS, name)) {
        return TOOL_SPECS[name as ToolName].required.map(key => rawArgs[key]);
    }
    if (Object.hasOwn(AGENT_TOOL_ARGS, name)) {
        return AGENT_TOOL_ARGS[name].map(key => rawArgs[key]);
    }
    return Object.values(rawArgs);
}

/**
 * Assertions for `*.eval.spl` files, valid only below `---` inside an `eval` block.
 * All `judge.*` calls are soft assertions: every assertion runs and is collected.
 */
export const judge = {
    /**
     * Evaluates whether `actual` satisfies `criterion` using an LLM-as-a-judge.
     * Passes when `score >= threshold` (default `0.8`).
     */
    faithful(actual: unknown, criterion: string, threshold = 0.8): Promise<JudgeResult> {
        if (typeof criterion !== 'string' || !criterion.trim()) {
            throw new Failure('runtime_error', 'judge.faithful() requires a non-empty criterion string');
        }
        if (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
            throw new Failure('runtime_error', 'judge.faithful() threshold must be a number between 0 and 1');
        }
        const context = currentContext();
        const evalScope = context.evalScope;
        if (evalScope && evalScope.phase !== 'assert') {
            throw new Failure('runtime_error', 'judge.faithful() is only valid below `---` inside an eval block');
        }

        const work = (async (): Promise<JudgeResult> => {
            const resolved = isThenable(actual) ? await actual : actual;
            const actualText = serializeActual(resolved);
            const prompt = [
                'Evaluate whether the following output satisfies the given criterion.',
                'Return a score from 0.0 (completely fails) to 1.0 (completely satisfies) and a concise reason.',
                '',
                `Criterion:\n${criterion}`,
                '',
                `Actual output:\n${actualText}`,
            ].join('\n');

            const raw = await context.runtime.generate('ask', prompt, {
                schema: JUDGE_SCHEMA,
                model: context.runtime.judgeModel,
                reasoning: 'low',
            }, context) as { score: number; reason: string };

            const score = Math.max(0, Math.min(1, Number(raw.score)));
            const reason = typeof raw.reason === 'string' && raw.reason.trim() ? raw.reason.trim() : `score ${score}`;
            const result: JudgeResult = {
                judge: 'faithful',
                pass: score >= threshold,
                score,
                reason,
            };
            evalScope?.results.push(result);
            return result;
        })();

        evalScope?.pendingJudges.push(work);
        return work;
    },

    /**
     * Inspects the eval block's captured trace and passes if at least one succeeded call
     * to `toolName` matches `...args` as a positional prefix using deep equality.
     */
    toolUse(toolName: string, ...args: unknown[]): JudgeResult {
        if (typeof toolName !== 'string' || !toolName.trim()) {
            throw new Failure('runtime_error', 'judge.toolUse() requires a non-empty toolName string');
        }
        const context = currentContext();
        const evalScope = context.evalScope;
        if (evalScope && evalScope.phase !== 'assert') {
            throw new Failure('runtime_error', 'judge.toolUse() is only valid below `---` inside an eval block');
        }

        const calls = context.runtime.toolCalls;
        const matchingName = calls.filter(call =>
            call.name === toolName || (call.server !== undefined && call.name === `${call.server}/${toolName}`) || (call.server !== undefined && call.shortName === toolName),
        );
        const succeeded = matchingName.filter(call => call.success);
        const matched = succeeded.some(call => {
            const actualArgs = positionalArgs(call.shortName ?? call.name, call.arguments);
            if (args.length > actualArgs.length) return false;
            return args.every((expected, index) => isDeepStrictEqual(actualArgs[index], expected));
        });

        let reason: string;
        if (matched) {
            reason = args.length
                ? `matched succeeded call to '${toolName}' with (${args.map(a => display(a)).join(', ')})`
                : `matched succeeded call to '${toolName}'`;
        } else if (!matchingName.length) {
            const seen = [...new Set(calls.map(c => c.name))];
            reason = `no call to '${toolName}' was recorded${seen.length ? ` (recorded: ${seen.join(', ')})` : ''}`;
        } else if (!succeeded.length) {
            reason = `all ${matchingName.length} call(s) to '${toolName}' failed`;
        } else {
            reason = `no succeeded call to '${toolName}' matched prefix (${args.map(a => display(a)).join(', ')})`;
        }

        const result: JudgeResult = {
            judge: 'toolUse',
            pass: matched,
            reason,
        };
        evalScope?.results.push(result);
        return result;
    },
};
