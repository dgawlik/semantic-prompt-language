import type { CopilotSession } from "./session.js";
import { type PermissionHandler, type ResumeSessionConfig } from "./types.js";
import type { WorkflowHandle } from "./workflow.js";
export { Canvas, CanvasError, createCanvas, type CanvasAction, type CanvasDeclaration, type CanvasHostContext, type CanvasJsonSchema, type CanvasOptions, } from "./canvas.js";
export type JoinSessionConfig = Omit<ResumeSessionConfig, "onPermissionRequest" | "extensionSdkPath" | "skillProvider" | "imageGeneration"> & {
    onPermissionRequest?: PermissionHandler;
    /**
     * Names of sensitive environment variables this extension needs, such as
     * `"GITHUB_TOKEN"`.
     *
     * The Copilot CLI strips sensitive variables from every extension process
     * before it starts, so an extension that needs one must ask for it by name.
     * The CLI prompts the user with the extension's name and the exact list of
     * variables requested. On approval the granted values are written into this
     * process's `process.env` before {@link joinSession} resolves, so they are
     * readable afterwards. On denial the join rejects and the extension does not
     * load, so its tools never reach the model.
     *
     * An approval is remembered against the exact set of names the user saw, so
     * asking for an additional variable later prompts again. Names that are unset
     * or that the CLI does not filter from extensions are not prompted for. An
     * empty list means the same as omitting the option: nothing is requested.
     *
     * Requires a Copilot CLI that supports extension environment access; older
     * CLIs ignore the request and grant nothing.
     *
     * @example
     * ```typescript
     * const session = await joinSession({
     *     requestedEnvironmentVariables: ["GITHUB_TOKEN"],
     * });
     * const token = process.env.GITHUB_TOKEN;
     * ```
     */
    requestedEnvironmentVariables?: string[];
    /**
     * Workflow handles to register when the extension joins the session.
     *
     * @experimental Part of the experimental Dynamic Workflows surface and may
     * change or be removed in future SDK or CLI releases.
     */
    workflows?: WorkflowHandle[];
};
export type { ExtensionInfo } from "./types.js";
export { defineWorkflow, WorkflowResumeError, isWorkflowRunTerminal, type WorkflowRunOptions, type WorkflowResumeOptions, type WorkflowLimitOverrides, type WorkflowResumeErrorCode, type SessionWorkflowApi, type WorkflowAgentOptions, type WorkflowContext, type WorkflowDefinition, type WorkflowHandle, type JsonValue, type WorkflowJsonSchema, type WorkflowLimits, type WorkflowMeta, type WorkflowPipelineStage, type WorkflowStepOptions, type WorkflowRunResult, type WorkflowRunStatus, type WorkflowRunSummary, type WorkflowListRunsOptions, type WorkflowRunsPage, type WorkflowRunDetail, type WorkflowProgressPage, type WorkflowProgressLine, type WorkflowPhaseObservation, type WorkflowPhaseStatus, type WorkflowAgentSummary, } from "./workflow.js";
/**
 * Joins the current foreground session.
 *
 * @param config - Configuration to add to the session
 * @returns A promise that resolves with the joined session
 *
 * @example
 * ```typescript
 * import { joinSession } from "@github/copilot-sdk/extension";
 *
 * const session = await joinSession({ tools: [myTool] });
 * ```
 */
export declare function joinSession(config?: JoinSessionConfig): Promise<CopilotSession>;
