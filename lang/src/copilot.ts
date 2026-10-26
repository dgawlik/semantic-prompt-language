import { CopilotClient, defineTool } from '@github/copilot-sdk';
import type { CopilotSession, ModelInfo, PermissionRequest, PermissionRequestResult, Tool } from '@github/copilot-sdk';
import { loadToken } from './auth.js';
import type { ToolName } from './ast.js';
import { Failure, SplSyntaxError } from './errors.js';
import { blockLocalDeclarations, parse } from './parser.js';
import { LlmError, type LlmBackend, type LlmRequest, type LlmResponse, type ReasoningLevel } from './llm.js';
import type { Logger } from './logger.js';
import type { Restrictions } from './restrict.js';
import { TOOL_SPECS } from './tools.js';
import { configuredMcpTool, filterMcpServers, type McpServers } from './mcp.js';

const SYSTEM_MESSAGE = [
    'You are the execution engine of an automated script. Your reply is stored in a variable and used by the program.',
    'Reply with exactly what was asked for: no preamble, no sign-off, no commentary.',
    'Use the provided runtime tools and configured MCP tools only when the task needs them.',
].join(' ');

const TOOL_NAMES = Object.keys(TOOL_SPECS) as ToolName[];

const SUBMIT_REMINDER = 'No program has been accepted yet. Do not answer in prose: translate the blockquote into SPL ' +
    'and call submit_spl now with one complete program, fixing any error reported for an earlier submission.';

export interface CopilotBackendOptions {
    logger: Logger;
    cwd: string;
    timeoutMs: number;
    mcpServers?: McpServers;
}

export class CopilotBackend implements LlmBackend {
    private client?: CopilotClient;
    private models?: Promise<ModelInfo[] | undefined>;

    constructor(private readonly opts: CopilotBackendOptions) {}

    private async getClient(): Promise<CopilotClient> {
        if (!this.client) {
            const token = loadToken();
            const client = new CopilotClient(token ? { gitHubToken: token } : {});
            try {
                await client.start();
                const status = await client.getAuthStatus();
                if (!status.isAuthenticated) {
                    throw new Error(`not authenticated with GitHub Copilot${status.statusMessage ? ` (${status.statusMessage})` : ''}; run 'spl login'`);
                }
            } catch (e) {
                await client.stop().catch(() => undefined);
                throw new LlmError(`cannot start the Copilot runtime: ${(e as Error).message}`);
            }
            this.client = client;
        }
        return this.client;
    }

    private denyGenerationPermission(block: (failure: Failure) => void): PermissionRequestResult {
        const failure = new Failure('restriction_violation', 'generation cannot use tools; use an explicit agent operation');
        block(failure);
        return { kind: 'reject', feedback: failure.reason };
    }

    private listModels(client: CopilotClient): Promise<ModelInfo[] | undefined> {
        this.models ??= client.listModels().catch((e: Error) => {
            this.opts.logger.debug(`could not list models: ${e.message}`);
            return undefined;
        });
        return this.models;
    }

    /** Maps the `think` level to the SDK reasoning effort, warning when the model cannot honor it. */
    private async resolveEffort(client: CopilotClient, req: LlmRequest): Promise<ReasoningLevel | undefined> {
        if (!req.reasoningEffort) return undefined;
        if (!req.model) return req.reasoningEffort; // default model unknown; session creation is retried without it on error
        const info = (await this.listModels(client))?.find((m) => m.id === req.model);
        const supported = (info as { supportedReasoningEfforts?: string[] } | undefined)?.supportedReasoningEfforts;
        if (info && !supported?.includes(req.reasoningEffort)) {
            this.opts.logger.warn(`model '${req.model}' does not support reasoning effort '${req.reasoningEffort}'; using the model default`);
            return undefined;
        }
        return req.reasoningEffort;
    }

    /** Fails on a model id the runtime does not offer; it would otherwise silently fall back to the default model. */
    private async checkModel(client: CopilotClient, model: string | undefined): Promise<void> {
        if (!model) return;
        const models = await this.listModels(client);
        if (models && !models.some((m) => m.id === model)) {
            throw new LlmError(`unknown model '${model}' (available: ${models.map((m) => m.id).join(', ')})`);
        }
    }

    async call(req: LlmRequest): Promise<LlmResponse> {
        const client = await this.getClient();
        await this.checkModel(client, req.model);
        let effort = await this.resolveEffort(client, req);
        let violation: Failure | undefined;
        let session: CopilotSession | undefined;

        const block = (failure: Failure) => {
            violation ??= failure;
            void session?.abort().catch(() => undefined);
        };

        const agent = req.kind === 'agent' && !req.naturalLanguage;
        let submitted: string | undefined;
        const tools: Tool[] = (agent ? TOOL_NAMES : []).map((name) => {
            const spec = TOOL_SPECS[name];
            return defineTool(name, {
                description: spec.description,
                overridesBuiltInTool: true,
                parameters: { type: 'object', properties: spec.properties, required: spec.required, additionalProperties: false },
                handler: async (args: unknown) => {
                    const params: Record<string, unknown> = { ...(args as Record<string, unknown>) };
                    try {
                        return await req.tools.invoke(name, params);
                    } catch (e) {
                        if (!(e instanceof Failure)) throw e;
                        if (e.statusCode === 'restriction_violation') {
                            block(e);
                            return { textResultForLlm: JSON.stringify(e.payload()), resultType: 'denied' as const, error: e.reason };
                        }
                        return { textResultForLlm: e.reason, resultType: 'failure' as const, error: e.reason };
                    }
                },
            });
        });
        if (req.naturalLanguage) {
            tools.push(defineTool('submit_spl', {
                description: 'Submit one complete SPL program to execute after this request, in shared document scope. No actions occur during submission.',
                parameters: {
                    type: 'object', properties: { source: { type: 'string' } },
                    required: ['source'], additionalProperties: false,
                },
                handler: async (args: unknown) => {
                    if (!args || typeof args !== 'object' || !('source' in args) ||
                        typeof args.source !== 'string' || !args.source.trim()) {
                        return { resultType: 'failure' as const, textResultForLlm: 'source must be non-empty SPL code' };
                    }
                    if (submitted !== undefined) {
                        return { resultType: 'failure' as const, textResultForLlm: 'a program has already been submitted' };
                    }
                    try {
                        const program = parse(args.source);
                        if (program.directives.model !== undefined) {
                            return { resultType: 'failure' as const, textResultForLlm: 'use model modifiers, not a model header' };
                        }
                        const local = blockLocalDeclarations(program);
                        const hidden = (req.markers ?? []).filter((name) => local.has(name));
                        if (hidden.length) {
                            const list = hidden.join(', ');
                            return {
                                resultType: 'failure' as const,
                                textResultForLlm: `${list} would be declared with let inside a block and disappear when the block ends. ` +
                                    `Declare ${list} at the top level first (for example let ${hidden[0]} = None, or reuse the existing binding) ` +
                                    `and assign it inside the block without let. Submit the corrected program.`,
                            };
                        }
                    } catch (error) {
                        if (!(error instanceof SplSyntaxError)) throw error;
                        return { resultType: 'failure' as const, textResultForLlm: error.message };
                    }
                    submitted = args.source;
                    return 'Program accepted for execution after this request. Do not submit again.';
                },
            }));
        }

        const mcpServers = agent ? filterMcpServers(this.opts.mcpServers ?? {}, req.restrictions) : {};
        const baseConfig = {
            model: req.model,
            tools,
            availableTools: [...tools.map((tool) => tool.name), ...Object.keys(mcpServers).map((name) => `mcp:${name}-*`)],
            mcpServers,
            systemMessage: { mode: 'append' as const, content: SYSTEM_MESSAGE },
            workingDirectory: this.opts.cwd,
            onPermissionRequest: (r: PermissionRequest): PermissionRequestResult => {
                if (req.naturalLanguage && r.kind === 'custom-tool' && r.toolName === 'submit_spl') return { kind: 'approve-once' };
                return agent ? decidePermission(r, req.restrictions, block, mcpServers) : this.denyGenerationPermission(block);
            },
        };

        try {
            try {
                session = await client.createSession({ ...baseConfig, reasoningEffort: effort });
            } catch (e) {
                if (!effort) throw e;
                this.opts.logger.warn(`reasoning effort '${effort}' was rejected (${(e as Error).message}); using the model default`);
                effort = undefined;
                session = await client.createSession(baseConfig);
            }

            const reasoning: string[] = [];
            session.on('assistant.reasoning', (ev) => {
                reasoning.push(ev.data.content);
                if (req.showReasoning) this.opts.logger.info(`reasoning: ${ev.data.content}`);
            });

            let answer: Awaited<ReturnType<CopilotSession['sendAndWait']>>;
            try {
                answer = await session.sendAndWait({ prompt: req.prompt }, this.opts.timeoutMs);
                // Models occasionally reply in prose or give up after a rejected submission; ask once more.
                if (req.naturalLanguage && submitted === undefined && !violation) {
                    answer = await session.sendAndWait({ prompt: SUBMIT_REMINDER }, this.opts.timeoutMs);
                }
            } catch (e) {
                if (violation) throw violation;
                throw new LlmError((e as Error).message);
            }
            if (violation) throw violation;
            if (req.naturalLanguage && submitted === undefined) throw new LlmError('natural-language request did not call submit_spl');
            // After submitting, models often end their turn with an empty or missing message.
            const content = answer?.data?.content;
            const text = submitted !== undefined && (typeof content !== 'string' || content.trim() === '')
                ? 'SPL program submitted.' : content;
            if (typeof text !== 'string' || text.trim() === '') throw new LlmError('the model returned an empty response');
            const usedModel = (answer?.data as { model?: string } | undefined)?.model;
            return {
                text,
                ...(submitted !== undefined ? { spl: submitted } : {}),
                reasoning: reasoning.length ? reasoning.join('\n') : undefined,
                effective: {
                    backend: 'copilot-sdk',
                    model: usedModel ?? req.model ?? 'default',
                    reasoningEffort: effort ?? null,
                },
            };
        } finally {
            await session?.disconnect().catch(() => undefined);
        }
    }

    async close(): Promise<void> {
        await this.client?.stop().catch(() => undefined);
        this.client = undefined;
    }
}

/**
 * Only runtime tools and explicitly configured MCP tools are approved.
 * Requests that violate a restriction are additionally reported as violations.
 */
export function decidePermission(
    r: PermissionRequest,
    restrictions: Restrictions,
    block: (f: Failure) => void,
    mcpServers: McpServers = {},
): PermissionRequestResult {
    try {
        if (r.kind === 'mcp') {
            restrictions.checkMcp(r.serverName, r.toolName);
            if (configuredMcpTool(mcpServers, r.serverName, r.toolName)) return { kind: 'approve-once' };
            return { kind: 'reject', feedback: 'MCP server/tool is not enabled by --mcp configuration.' };
        }
        if (r.kind === 'custom-tool' && TOOL_NAMES.includes((r as { toolName: ToolName }).toolName)) {
            return { kind: 'approve-once' }; // the tool itself performs the restriction checks
        }
        if (r.kind === 'read') restrictions.checkPath((r as { path: string }).path, 'read');
        else if (r.kind === 'write') restrictions.checkPath((r as { fileName: string }).fileName, 'write');
        else if (r.kind === 'url') restrictions.checkUrl((r as { url: string }).url);
        else if (r.kind === 'shell') {
            const s = r as { commands: { identifier: string }[]; possiblePaths: string[] };
            for (const c of s.commands) restrictions.checkExec(c.identifier);
            for (const p of s.possiblePaths) restrictions.checkPath(p, 'read');
        }
    } catch (e) {
        if (e instanceof Failure && e.statusCode === 'restriction_violation') {
            block(e);
            return { kind: 'reject', feedback: JSON.stringify(e.payload()) };
        }
    }
    return { kind: 'reject', feedback: 'Only runtime tools and configured MCP tools may be used.' };
}
