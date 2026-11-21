import { randomUUID } from 'node:crypto';
import { generateFunctions } from './codegen.js';
import { createRuntime, type ConfigureOptions } from './configure.js';
import { Failure, SuccessSignal } from './errors.js';
import { buildPromptParts, type LlmRequest, type LlmResponse, type ReasoningLevel, type RuntimeAction, type RuntimeTool } from './llm.js';
import { sources } from './loader.js';
import type { ModelInteraction } from './log-events.js';
import { ScopeObserver } from './observer.js';
import { AGENT_PREAMBLE } from './preamble.js';
import { isResponse } from './recording.js';
import type { RestrictKind } from './restrict.js';
import {
    activeContext, control, currentContext, describeValue, runInContext, signature,
    type Context, type Defaults, type GenerateOptions,
} from './runtime.js';
import { compileSchema } from './schema.js';
import { TOOL_SPECS, ToolHost, describeRuntimeToolCall } from './tools.js';
import { TraceError } from './trace.js';
import { Any, isType, type Type } from './types.js';

/** Options of the default export of a compiled workflow: how to build its runtime when none is active. */
export type WorkflowOptions = ConfigureOptions;
/** The default export of a `.spl` module. Resolves to the value given to `success()`; a failure rejects. */
export type Workflow = (args?: readonly string[], options?: WorkflowOptions) => Promise<unknown>;

interface BlockOptions {
    /** Line of the opening `---`. */
    line: number;
    /** The instruction, with `@@` already written as `@`. */
    text: string;
    /** The block sits inside a function or loop: no top-level variable shows its outputs. */
    local?: boolean;
    model?: string;
    reasoning?: ReasoningLevel;
    enforce?: readonly string[];
    forbid?: readonly string[];
    hide?: boolean;
    tokens?: number;
}

interface AskOptions<T> extends BlockOptions {
    output?: string;
    outputType?: Type<T>;
    repairs?: number;
    seed?: number;
    temperature?: number;
    topP?: number;
}

interface AgentOptions extends BlockOptions {
    restrict?: Partial<Record<RestrictKind, string | readonly string[]>>;
    maxSteps?: number;
}

/** An invalid save may be corrected this many times per output before the block fails. */
const CORRECTIONS = 2;
const runtimeError = (message: string): Failure => new Failure('runtime_error', message);
const name = { type: 'string', pattern: '^[A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)*$' };
const text = { type: 'string', minLength: 1 };
const tool = (name: string, description: string, properties: Record<string, unknown>): RuntimeTool => ({
    name, description, parameters: { type: 'object', properties, required: Object.keys(properties), additionalProperties: false },
});

/** What an agent block can do besides the built-in and MCP tools. */
export const AGENT_TOOLS: readonly RuntimeTool[] = [
    tool('loadVariable', 'Read an input of this block by its name. A type returns its complete JSON Schema.', { name }),
    tool('saveVariable', 'Save an output of this block as a JSON value. The value must fit the declared type of the output.', { name, value: {} }),
    tool('callFunction', 'Call an input that is a function with positional JSON arguments. Send numbers, not numeric strings.', { name, args: { type: 'array', items: {} } }),
    tool('getEnv', 'Read one environment variable. Missing variables return null.', { name: text }),
    tool('askHuman', 'Ask a human a question and return their answer.', { question: text }),
    tool('setGuidance', 'Add enforce/forbid guidance to model calls made by functions called later in this block.', {
        kind: { enum: ['enforce', 'forbid'] }, text,
    }),
    ...Object.values(TOOL_SPECS).map(spec => tool(spec.name, spec.description, spec.properties)),
];
const validators = new Map(AGENT_TOOLS.map(spec => [spec.name, compileSchema(spec.parameters)]));

function actionArguments(action: RuntimeAction): Record<string, unknown> {
    const validate = validators.get(action.name);
    if (!validate) throw runtimeError(`unknown agent tool '${action.name}'`);
    const value: Record<string, unknown> = structuredClone(action.arguments);
    validate(value);
    const check = (item: unknown): void => {
        if (typeof item === 'number' && !Number.isFinite(item)) throw runtimeError('agent tool arguments must contain finite JSON numbers');
        if (item && typeof item === 'object') for (const child of Object.values(item)) check(child);
    };
    check(value);
    return value;
}

/** A `---` block: the generated code adds its inputs and outputs, then awaits it. */
abstract class Block<R> implements PromiseLike<R> {
    protected readonly inputs = new Map<string, unknown>();

    constructor(protected readonly mode: string, protected readonly options: BlockOptions) {}

    /** `@name` in the instruction: a value the block reads. */
    in(name: string, value: unknown): this {
        this.inputs.set(name, value);
        return this;
    }

    then<A = R, B = never>(resolved?: ((value: R) => A | PromiseLike<A>) | null, rejected?: ((reason: unknown) => B | PromiseLike<B>) | null): Promise<A | B> {
        return this.start().then(resolved, rejected);
    }

    protected abstract run(context: Context): Promise<R>;

    /** Runs the block; a block that journals many effects overrides this to keep them together. */
    protected sequenced(context: Context): Promise<R> {
        return runInContext(context, () => this.run(context));
    }
    /** Values to report for a block no top-level variable shows. */
    protected abstract outputsOf(result: R): Record<string, unknown>;

    private async start(): Promise<R> {
        const parent = currentContext();
        const { runtime } = parent;
        const { line, text, enforce = [], forbid = [] } = this.options;
        const context: Context = {
            ...parent, line,
            constraints: [...parent.constraints, ...enforce.map(text => ({ kind: 'enforce' as const, text })), ...forbid.map(text => ({ kind: 'forbid' as const, text }))],
        };
        try {
            for (const [kind, value] of Object.entries((this.options as AgentOptions).restrict ?? {})) {
                context.restrictions = context.restrictions.with(await runtime.restriction(kind as RestrictKind, value));
            }
            await runtime.step(parent, { kind: 'block', line, language: this.mode, source: text });
            const result = await this.sequenced(context);
            if (this.options.local && !runtime.replaying) {
                const observer = parent.scope?.observer ?? new ScopeObserver();
                for (const [name, value] of Object.entries(this.outputsOf(result))) observer.output(runtime.logger, line, name, value);
            }
            return result;
        } catch (error) {
            if (control(error)) throw error;
            // Code the block ran reports its own line; anything else failed in the block itself.
            const failure = runtime.failure(error, { line, command: '' });
            if (failure.line === line) failure.command = text.split('\n')[0];
            throw failure;
        }
    }
}

class AskBlock<T> extends Block<T> {
    protected async run(context: Context): Promise<T> {
        const { text, outputType, model, reasoning, hide, tokens, repairs, seed, temperature, topP } = this.options as AskOptions<T>;
        const values = [...this.inputs].map(([name, value]) =>
            `@${name} = ${JSON.stringify(isType(value) ? value.schema() : describeValue(value))}`);
        const prompt = values.length ? `${text}\n\nValues referenced above, as JSON:\n${values.join('\n')}` : text;
        const options: GenerateOptions = { schema: outputType, model, reasoning, hide, tokens, repairs, seed, temperature, topP };
        return await context.runtime.generate('ask', prompt, options, context) as T;
    }

    protected outputsOf(result: T): Record<string, unknown> {
        const { output } = this.options as AskOptions<T>;
        return output ? { [output]: result } : {};
    }
}

/** How an input looks in the agent's prompt: enough to choose a tool, never the value itself. */
function summary(value: unknown): string {
    if (typeof value === 'function') return signature(value);
    if (isType(value)) return `type ${value.name}`;
    if (Array.isArray(value)) return `list of ${value.length}`;
    return value === null ? 'null' : typeof value === 'object' ? 'object' : typeof value;
}

class AgentBlock<O> extends Block<O> {
    private readonly outputs = new Map<string, Type<unknown>>();

    /** `-> @name` in the instruction: a value the agent must save. */
    out<K extends string, T = unknown>(name: K, type?: Type<T>): AgentBlock<O & Record<K, T>> {
        this.outputs.set(name, type ?? Any);
        return this as unknown as AgentBlock<O & Record<K, T>>;
    }

    protected outputsOf(result: O): Record<string, unknown> {
        return result as Record<string, unknown>;
    }

    /** With a trace, the block holds its place in the journal until it ends; what it starts is ordered inside it. */
    protected sequenced(context: Context): Promise<O> {
        const { runtime } = context;
        if (!runtime.trace) return super.sequenced(context);
        return runtime.sequence(() => {
            context.gate = { tail: Promise.resolve() };
            return super.sequenced(context);
        });
    }

    private async act(action: RuntimeAction, args: Record<string, unknown>, local: Context, saved: Map<string, unknown>, rejected: Map<string, number>): Promise<unknown> {
        const { runtime } = local;
        const { line } = this.options;
        const input = (name: string): unknown => {
            if (saved.has(name)) return saved.get(name);
            if (!this.inputs.has(name)) throw runtimeError(`@${name} is not referenced in this block; an agent reaches only the names its instruction mentions`);
            return this.inputs.get(name);
        };
        switch (action.name) {
            case 'loadVariable': {
                const value = input(String(args.name));
                return isType(value) ? value.schema() : value;
            }
            case 'saveVariable': {
                const name = String(args.name);
                const type = this.outputs.get(name);
                if (!type) {
                    const declared = [...this.outputs.keys()].map(item => `@${item}`).join(', ');
                    throw runtimeError(`agent tried to save @${name}, which is not an output of this block${declared ? ` (outputs: ${declared})` : ''}; declare it with -> @${name}`);
                }
                try {
                    const value = type.coerce(args.value, name);
                    saved.set(name, value);
                    return value;
                } catch (error) {
                    if (!(error instanceof Failure) || error.statusCode !== 'validation_failed') throw error;
                    const count = (rejected.get(name) ?? 0) + 1;
                    rejected.set(name, count);
                    if (count > CORRECTIONS) throw new Failure('validation_failed', `@${name} is still invalid after ${CORRECTIONS} corrections: ${error.reason}`);
                    return { rejected: error.reason, hint: `Correct the value and save @${name} again.` };
                }
            }
            case 'callFunction': {
                const fn = input(String(args.name));
                if (typeof fn !== 'function') throw runtimeError(`@${args.name} is not a function`);
                return await (fn as (...values: unknown[]) => unknown)(...args.args as unknown[]);
            }
            case 'getEnv': return runtime.environmentValue(String(args.name));
            case 'askHuman': return runtime.human(String(args.question), line);
            case 'setGuidance':
                local.constraints = [...local.constraints, { kind: args.kind as 'enforce' | 'forbid', text: String(args.text) }];
                return null;
            default: {
                const spec = Object.values(TOOL_SPECS).find(item => item.name === action.name)!;
                return runtime.tool(spec.name, spec.required.map(name => args[name]), local);
            }
        }
    }

    /** One agent call over the whole block: the model acts through tools until every output is saved. */
    protected async run(local: Context): Promise<O> {
        const { runtime } = local;
        const { trace } = runtime;
        const { text, line, model, reasoning, hide, tokens, maxSteps } = this.options as AgentOptions;
        const saved = new Map<string, unknown>();
        const rejected = new Map<string, number>();
        const history: unknown[] = [];
        let interaction: ModelInteraction = { requestId: randomUUID(), kind: 'agent' };
        // Every decision of the model is journaled with what led to it, so an interrupted trace resumes mid-block.
        const decisionRequest = () => ({
            kind: 'agent-block', text, line, history: JSON.stringify(history), restrictions: local.restrictions.list,
        });
        const decision = (perform: () => Promise<LlmResponse>): Promise<LlmResponse> => trace
            ? runtime.effect(decisionRequest(), perform, isResponse)
            : perform();
        const execute = async (action: RuntimeAction): Promise<unknown> => {
            if (!runtime.replaying) runtime.logger.modelOutput({ ...interaction, role: 'action' }, JSON.stringify(action));
            let value: unknown;
            let builtin = false;
            try {
                const args = actionArguments(action);
                builtin = Object.hasOwn(TOOL_SPECS, action.name);
                value = describeValue(await this.act(action, args, local, saved, rejected));
                if (!builtin) {
                    const rejectedSave = action.name === 'saveVariable'
                        && typeof value === 'object' && value !== null && Object.hasOwn(value, 'rejected');
                    runtime.toolCalls.push({ name: action.name, arguments: args, success: !rejectedSave });
                }
            } catch (error) {
                if (control(error)) throw error;
                if (!builtin) {
                    runtime.toolCalls.push({ name: action.name, arguments: action.arguments, success: false });
                }
                // Errors thrown by workflow functions keep their own kind and line.
                const failure = runtime.failure(error);
                if (!runtime.replaying && !builtin) {
                    runtime.logger.tool(describeRuntimeToolCall(action.name, action.arguments, { error: failure.reason }));
                }
                throw failure;
            }
            if (!runtime.replaying && !builtin) {
                runtime.logger.tool(describeRuntimeToolCall(action.name, action.arguments, { value }));
            }
            // A copy: the backend owns the action it sent and may change it later.
            history.push({ action: structuredClone(action), result: { value } });
            return value;
        };
        const inputs = [...this.inputs].map(([name, value]) => `- @${name}: ${summary(value)}`);
        const outputs = [...this.outputs].map(([name, type]) => `- @${name}: ${type.name}, JSON Schema ${JSON.stringify(type.kind === 'fn' ? {} : type.schema())}`);
        const guide = [
            AGENT_PREAMBLE,
            `Inputs:\n${inputs.length ? inputs.join('\n') : '(none)'}`,
            `Outputs to save:\n${outputs.length ? outputs.join('\n') : '(none)'}`,
        ].join('\n\n');
        for (;;) {
            interaction = { requestId: randomUUID(), kind: 'agent' };
            if (runtime.replaying) {
                const response = await decision(async () => { throw new TraceError('missing recorded agent decision'); });
                if (!response.action) break;
                await execute(response.action);
                continue;
            }
            trace?.assertLive(decisionRequest());
            let actionFailed = false;
            const built = buildPromptParts({
                prompt: `${guide}\n\nInstruction:\n${text}\n\nCompleted actions and their results:\n${JSON.stringify(history)}`,
                constraints: local.constraints, restrictions: local.restrictions,
            });
            const request: LlmRequest = {
                kind: 'agent', runtimeTools: AGENT_TOOLS,
                prompt: built.prompt,
                model: runtime.resolveModel(model, local),
                reasoningEffort: reasoning ?? local.defaults.reasoning,
                showReasoning: !(hide ?? local.defaults.hide ?? false),
                ...(tokens ?? local.defaults.tokens ? { tokens: tokens ?? local.defaults.tokens } : {}),
                ...(maxSteps ?? local.defaults.maxSteps ?? runtime.maxSteps ? { maxSteps: maxSteps ?? local.defaults.maxSteps ?? runtime.maxSteps } : {}),
                restrictions: local.restrictions, tools: new ToolHost(local.restrictions, runtime.cwd),
                invokeAction: async action => {
                    try {
                        await decision(async () => ({ text: 'Action.', effective: {}, action }));
                        return await execute(action);
                    } catch (error) {
                        actionFailed = true;
                        throw error;
                    }
                },
            };
            let response: LlmResponse;
            try {
                response = await runtime.callModel(request, interaction, [built.preface, guide].filter(Boolean).join('\n\n'));
            } catch (error) {
                if (trace && !actionFailed && error instanceof Failure) await decision(async () => { throw error; });
                throw error;
            }
            await decision(async () => response);
            break;
        }
        const missing = [...this.outputs.keys()].find(name => !saved.has(name));
        if (missing) throw new Failure('validation_failed', `agent did not produce @${missing}`);
        return Object.fromEntries(saved) as O;
    }
}

class CodegenBlock<O> extends Block<O> {
    private readonly names: string[] = [];

    /** `-> @name(params): Type` in the description: a function to generate. */
    fn<F extends Record<string, (...args: any[]) => unknown>>(name: keyof F & string): CodegenBlock<O & F> {
        this.names.push(name);
        return this as unknown as CodegenBlock<O & F>;
    }

    protected outputsOf(result: O): Record<string, unknown> {
        return result as Record<string, unknown>;
    }

    protected async run(context: Context): Promise<O> {
        const { text, line, model, reasoning, hide, tokens } = this.options;
        const functions = await generateFunctions({
            text, line, names: this.names, inputs: this.inputs, model, reasoning, hide, tokens,
        }, context);
        return Object.fromEntries(this.names.map(name => [name, functions[name]])) as O;
    }
}

/** An ask block: one prompt and one model call, without tools. Resolves to the answer, coerced to `outputType`. */
export function ask<T = string>(options: AskOptions<T>): AskBlock<T> {
    return new AskBlock<T>('ask', options);
}

/** An agent block: one agent call that reads its inputs and saves its outputs through tools. */
export function agent(options: AgentOptions): AgentBlock<{}> {
    return new AgentBlock<{}>('agent', options);
}

/** A codegen block: functions generated together in one model call. */
export function codegen(options: BlockOptions): CodegenBlock<{}> {
    return new CodegenBlock<{}>('codegen', options);
}

/**
 * Runs the body of a `.spl` file: the default export of every compiled workflow. Inside a running
 * workflow it shares that runtime; otherwise `options` configure one, or the ambient runtime is used.
 * Resolves to the value given to `success()`, or `undefined`; a failure rejects.
 */
export async function workflow(
    meta: { url: string; defaults?: Defaults & { enforce?: readonly string[]; forbid?: readonly string[] } },
    args: readonly string[], options: WorkflowOptions | undefined, body: () => Promise<void>,
): Promise<unknown> {
    if (!Array.isArray(args) || args.some(item => typeof item !== 'string')) throw runtimeError('workflow arguments must be a list of strings');
    const owned = options ? createRuntime({ ...options, args }) : undefined;
    const parent = owned?.root ?? activeContext() ?? currentContext();
    const { runtime } = parent;
    const { enforce = [], forbid = [], ...defaults } = meta.defaults ?? {};
    // Failures are located through stack traces; the default ten frames lose the workflow behind deep helper calls.
    if (Error.stackTraceLimit < 100) Error.stackTraceLimit = 100;
    // A compiled module that runs without the loader is located by reading its own file.
    if (!sources.has(meta.url)) sources.set(meta.url, {});
    const context: Context = {
        ...parent, args: owned ? owned.args : Object.freeze([...args]), defaults, url: meta.url, line: undefined,
        constraints: [...parent.constraints, ...enforce.map(text => ({ kind: 'enforce' as const, text })), ...forbid.map(text => ({ kind: 'forbid' as const, text }))],
        scope: { observer: new ScopeObserver() },
    };
    try {
        await runInContext(context, body);
        return undefined;
    } catch (error) {
        if (error instanceof SuccessSignal) return error.value;
        throw control(error) ? error : runtime.failure(error);
    } finally {
        runtime.observe(context);
        await owned?.backend.close();
    }
}

/** Names the top-level variables of an instrumented workflow, for state logs and the stepper. */
export function watch(variables: () => Record<string, () => unknown>): void {
    const { scope } = currentContext();
    if (scope) scope.variables = variables;
}

/** Runs before each top-level statement of an instrumented workflow. */
export function step(line: number, endLine: number): Promise<void> {
    const context = currentContext();
    return context.runtime.step(context, { kind: 'code', line, endLine, language: 'ts' });
}

/** Registers a top-level `eval '...' { ... }` block during `*.eval.spl` discovery. */
function evalCase(name: string, fn: () => Promise<void>): void {
    const context = currentContext();
    if (!context.evalCollector) return;
    const { defaults, constraints, url } = context;
    context.evalCollector.push({
        name,
        fn: () => {
            const active = currentContext();
            return runInContext({
                ...active,
                defaults: { ...defaults, ...active.defaults },
                constraints: [...constraints, ...active.constraints],
                url: url ?? active.url,
            }, fn);
        },
    });
}

/** Phase divider (`---`) inside an `eval` block: awaits pending arrange/act calls and enters assert phase. */
async function evalPhase(): Promise<void> {
    const scope = currentContext().evalScope;
    if (!scope) return;
    if (scope.pendingArrange.length) {
        await Promise.all(scope.pendingArrange.splice(0));
    }
    scope.phase = 'assert';
}

export { evalCase as eval, evalPhase as phase };
