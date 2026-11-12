import { randomUUID } from 'node:crypto';
import { AGENT_TOOLS, actionArguments } from './agent.js';
import { codegenHeader, codegenSignature, compileCodegen, isCodegenSource, readCodegenCache, saveCodegenCache, unwrapCode, type CodegenSource } from './codegen.js';
import type { CompiledCell } from './cell.js';
import type { NaturalBlock, NaturalControls } from './controls.js';
import { Failure, SuccessSignal } from './errors.js';
import { buildPromptParts, type LlmRequest, type LlmResponse, type RuntimeAction } from './llm.js';
import type { ModelInteraction } from './log-events.js';
import { PinError } from './pin.js';
import { CODEGEN_PREAMBLE, NATURAL_PREAMBLE } from './preamble.js';
import { isResponse } from './recording.js';
import { describeValue, runInContext, type Context } from './runtime.js';
import { compileSchema } from './schema.js';
import { TOOL_SPECS, ToolHost } from './tools.js';
import { TraceError } from './trace.js';
import { isType } from './types.js';
import type { Workspace } from './workspace.js';

const runtimeError = (message: string): Failure => new Failure('runtime_error', message);
/** Library functions an agent can usefully invoke with JSON arguments. */
const CALLABLE = ['ask', 'think', 'agent', 'human', 'log', 'codegen', 'readFile', 'writeFile', 'webFetch', 'webSearch', 'shell', 'validate'];

function overview(workspace: Workspace): { bindings: Record<string, unknown>; library: string } {
    const bindings: Record<string, unknown> = Object.create(null);
    for (const [name, value] of Object.entries(workspace.scope)) {
        if (value === undefined) continue;
        const module = workspace.imports.get(name);
        // A module namespace would flood the prompt; functions and types already describe themselves briefly.
        bindings[name] = module !== undefined && typeof value === 'object' && value !== null && !isType(value)
            ? `<imported from '${module}'>` : describeValue(value);
    }
    const library = CALLABLE.filter(name => typeof workspace.globals[name] === 'function' && !(name in workspace.scope)).join(', ');
    return { bindings, library };
}

/** Applies `@CTL` restrictions and guidance to a private copy of the context. */
async function controlled(parent: Context, line: number, controls: NaturalControls | undefined): Promise<Context> {
    const local: Context = { ...parent, line };
    for (const kind of ['fs', 'exec', 'net', 'mcp'] as const) {
        const value = controls?.restrict?.[kind];
        if (value !== undefined) local.restrictions = local.restrictions.with(await parent.runtime.restriction(kind, value));
    }
    for (const kind of ['enforce', 'forbid'] as const) {
        const value = controls?.[kind];
        if (value !== undefined) local.constraints = [...local.constraints, ...[value].flat().map(text => ({ kind, text }))];
    }
    return local;
}

async function act(action: RuntimeAction, workspace: Workspace, local: Context, line: number): Promise<unknown> {
    const { runtime } = local;
    const args = actionArguments(action);
    switch (action.name) {
        case 'load_variable': {
            const name = String(args.name);
            if (name === '$args' || name === 'args' && !(name in workspace.scope)) return runtime.args;
            if (name === 'env' && !(name in workspace.scope)) throw runtimeError('read environment variables one at a time with get_env(name)');
            if (!workspace.has(name)) throw runtimeError(`name '${name}' is not defined`);
            const value = workspace.get(name);
            return isType(value) ? value.schema() : value;
        }
        case 'save_variable': {
            const name = String(args.name);
            let schema = args.schema;
            if (typeof schema === 'string') {
                if (!workspace.has(schema)) throw runtimeError(`name '${schema}' is not defined`);
                schema = workspace.get(schema);
            }
            const target = isType(schema) ? schema : undefined;
            if ('schema' in args && !target) compileSchema(schema)(args.value);
            if (typeof workspace.scope[name] === 'function') throw runtimeError(`cannot replace function '${name}' with a variable`);
            if (isType(workspace.scope[name])) throw runtimeError(`cannot replace type '${name}' with a variable`);
            if (workspace.imports.has(name)) throw runtimeError(`cannot replace import '${name}' with a variable`);
            if (!(name in workspace.scope) && name in workspace.globals) {
                throw runtimeError(`'${name}' is a library name and cannot be replaced with a variable`);
            }
            const value = target ? target.parse(args.value, name) : args.value;
            workspace.scope[name] = value;
            return value;
        }
        case 'call_function': {
            const name = String(args.name);
            if (!workspace.has(name)) throw runtimeError(`name '${name}' is not defined`);
            const fn = workspace.get(name);
            if (typeof fn !== 'function') throw runtimeError(`'${name}' is not callable`);
            if (!Array.isArray(args.args)) throw runtimeError('function arguments must be a list');
            return await (fn as (...values: unknown[]) => unknown)(...args.args);
        }
        case 'get_env': return runtime.environmentValue(String(args.name));
        case 'ask_human': return runtime.human(String(args.question), line);
        case 'success': throw new SuccessSignal(args.value);
        case 'fail': throw new Failure('explicit_failure', String(args.reason));
        case 'restrict': {
            const kind = args.kind;
            if (kind !== 'fs' && kind !== 'exec' && kind !== 'net' && kind !== 'mcp') throw runtimeError('invalid restriction kind');
            local.restrictions = local.restrictions.with(await runtime.restriction(kind, args.value));
            return null;
        }
        case 'set_guidance': {
            const kind = args.kind;
            if (kind !== 'enforce' && kind !== 'forbid') throw runtimeError('invalid guidance kind');
            local.constraints = [...local.constraints, { kind, text: String(args.text) }];
            return null;
        }
        default: {
            const tool = Object.values(TOOL_SPECS).find(spec => spec.name === action.name);
            if (!tool) throw runtimeError(`unknown blockquote tool '${action.name}'`);
            return runtime.tool(tool.name, tool.required.map(name => args[name]), local);
        }
    }
}

/** Runs a blockquote as an agent command acting on the shared scope through runtime tools. */
export async function runNatural(block: NaturalBlock, workspace: Workspace, parent: Context): Promise<void> {
    const { text, line, controls } = block;
    const { runtime } = parent;
    const { bindings, library } = overview(workspace);
    const local = await controlled(parent, line, controls);
    if (block.codegen) {
        await runInContext(local, () => generateFunctions(text, line, controls, workspace, local, bindings, library));
        return;
    }
    const history: unknown[] = [];
    let interaction: ModelInteraction = { requestId: randomUUID(), kind: 'blockquote' };
    const { trace, journal } = runtime;
    const decisionRequest = () => ({
        kind: 'natural', text, line, history: JSON.stringify(history), restrictions: local.restrictions.list,
        ...(controls ? { controls } : {}),
    });
    const decision = (perform: () => Promise<LlmResponse>): Promise<LlmResponse> => journal
        ? runtime.effect(decisionRequest(), perform, isResponse)
        : perform();
    const execute = async (action: RuntimeAction): Promise<unknown> => {
        if (!trace?.replaying) runtime.logger.modelOutput({ ...interaction, role: 'action' }, JSON.stringify(action));
        let value: unknown;
        try {
            value = describeValue(await act(action, workspace, local, line));
        } catch (error) {
            if (error instanceof SuccessSignal || error instanceof TraceError || error instanceof PinError) throw error;
            // Errors thrown by workflow functions keep their own kind instead of looking like model failures.
            throw runtime.failure(error);
        } finally {
            workspace.observe(runtime);
        }
        history.push({ action, result: { value } });
        return value;
    };
    await runInContext(local, async () => {
        for (;;) {
            interaction = { requestId: randomUUID(), kind: 'blockquote' };
            if (trace?.replaying || runtime.pin?.replaying) {
                const response = await decision(async () => { throw new TraceError('missing recorded runtime decision'); });
                if (!response.action) return;
                await execute(response.action);
                continue;
            }
            trace?.assertLive(decisionRequest());
            let actionFailed = false;
            const context = `${NATURAL_PREAMBLE}\n\nAvailable library functions: ${library}\n\nShared bindings at command start:\n${JSON.stringify(bindings)}`;
            const built = buildPromptParts({
                prompt: `${context}\n\nBlockquote:\n${text}\n\nCompleted turns and action results:\n${JSON.stringify(history)}`,
                constraints: local.constraints, restrictions: local.restrictions,
            });
            const request: LlmRequest = {
                kind: 'agent', naturalLanguage: true, runtimeTools: AGENT_TOOLS,
                prompt: built.prompt,
                model: runtime.resolveModel(controls?.model),
                reasoningEffort: controls?.reasoning ?? 'medium', showReasoning: true,
                restrictions: local.restrictions, tools: new ToolHost(local.restrictions, runtime.cwd),
                currentRestrictions: () => local.restrictions,
                invokeAction: async action => {
                    try {
                        await decision(async () => ({ text: 'Runtime action.', effective: {}, action }));
                        return await execute(action);
                    } catch (error) {
                        actionFailed = true;
                        throw error;
                    }
                },
            };
            let response: LlmResponse;
            try {
                response = await runtime.callModel(request, interaction, [built.preface, context].filter(Boolean).join('\n\n'));
            } catch (error) {
                if (journal && !actionFailed && error instanceof Failure) {
                    await decision(async () => { throw error; });
                }
                throw error;
            }
            await decision(async () => response);
            if (!response.action) return;
            await execute(response.action);
        }
    });
}

/**
 * Generates JavaScript functions from a description, validates that the response only declares
 * functions, and defines them in the shared scope. Returns the first, requested function.
 */
export async function generateFunctions(
    text: string, line: number, controls: NaturalControls | undefined, workspace: Workspace, context: Context,
    bindings = overview(workspace).bindings, library = overview(workspace).library,
): Promise<(...args: any[]) => unknown> {
    const { runtime } = context;
    if (typeof text !== 'string' || !text.trim()) throw runtimeError('codegen requires a non-empty description');
    const signature = codegenSignature(text);
    const cacheSource = runtime.trace ? runtime.source ?? runtime.trace.file : undefined;
    let compiled: CompiledCell | undefined;
    const perform = async (): Promise<CodegenSource> => {
        if (cacheSource) {
            const cached = readCodegenCache(cacheSource, signature, runtime.cwd);
            if (cached) {
                compiled = compileCodegen(cached.text);
                runtime.logger.info(`@CODEGEN reusing ${cached.file}`);
                runtime.logger.modelOutput({ requestId: randomUUID(), kind: 'codegen', role: 'response' }, cached.text);
                return cached;
            }
        }
        const guide = `${CODEGEN_PREAMBLE}\n\nAvailable library functions: ${library}\n\nShared bindings:\n${JSON.stringify(bindings)}`;
        const built = buildPromptParts({
            prompt: `${guide}\n\nFunction description:\n${text}`,
            constraints: context.constraints, restrictions: context.restrictions,
        });
        const response = await runtime.callModel({
            kind: 'ask', prompt: built.prompt,
            model: runtime.resolveModel(controls?.model),
            reasoningEffort: controls?.reasoning ?? 'medium', showReasoning: true,
            restrictions: context.restrictions, tools: new ToolHost(context.restrictions, runtime.cwd),
        }, { requestId: randomUUID(), kind: 'codegen' }, [built.preface, guide].filter(Boolean).join('\n\n'), false);
        const source: CodegenSource = { text: `${codegenHeader(signature)}\n${unwrapCode(response.text)}\n` };
        compiled = compileCodegen(source.text);
        if (cacheSource) {
            source.file = saveCodegenCache(cacheSource, signature, compiled.declarations[0].name, source.text, runtime.cwd);
            runtime.logger.info(`@CODEGEN saved ${source.file}`);
        }
        return source;
    };
    const source = await runtime.effect({ kind: 'codegen', text, line, ...(controls ? { controls } : {}) }, perform, isCodegenSource);
    const cell = compiled ?? compileCodegen(source.text);
    const file = source.file ?? `${runtime.source ?? 'workflow'}#codegen-${signature.slice(0, 12)}.js`;
    runtime.sources.set(file, { lines: source.text.replace(/\r\n/g, '\n').split('\n'), uri: source.file });
    await workspace.execute(cell, file, runtime);
    const fn = workspace.scope[cell.declarations[0].name];
    if (typeof fn !== 'function') throw runtimeError('@CODEGEN did not define a function');
    return fn as (...args: any[]) => unknown;
}
