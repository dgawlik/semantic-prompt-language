// The library: everything a workflow fence can use without importing it.
export {
    ask, think, agent, human, enforce, forbid, restrict, success, fail, assert, log, codegen,
    readFile, writeFile, webFetch, webSearch, shell, args, env, markdown, configure,
    t, str, int, float, bool, char, nil, any, object, fn, list, union, nullable, enumOf, struct, typedef, jsonSchema, validate,
    type AskOptions, type ThinkOptions, type AgentOptions, type CodegenOptions, type ConfigureOptions,
    type GenerationResult, type RestrictSpec,
} from './library.js';
export { Type, StructType, isType, type Infer, type InferShape, type Shape, type Annotations, type JsonSchema, type TypeKind } from './types.js';
export { Failure, SuccessSignal, SplSyntaxError, type FailurePayload, type StatusCode } from './errors.js';

// Running workflows and embedding the runtime.
export { parse, parseInstruction, parseMarkdown, extractMarkdown, isWorkflowMarkdown, type Workflow, type MarkdownDocument, type MarkdownBlock } from './markdown.js';
export { parseSpl, scanSpl, type SplBlock, type SplDocument, type SplProblem, type SplTag } from './spl.js';
export { run, ExecutionSession, checkWorkflow, type RunOptions, type RunResult, type WorkflowProblem } from './workflow.js';
export { Runtime, type RuntimeOptions, type GenerateOptions, type HumanHandler } from './runtime.js';
export { compileCell, type CompiledCell, type CellDeclaration, type CellLanguage } from './cell.js';
export { Logger, type LogLevel, type LoggerOptions } from './logger.js';
export type { LogEvent, LogEventSink, BodySegment, ModelInteraction, ModelStreamEvent, ModelStreamSink, StateChange, BindingDelta, BindingReference, ScopeReference, ObservedValue } from './log-events.js';
export { CopilotBackend } from './copilot.js';
export { AiBackend, type AiBackendOptions } from './ai.js';
export { Trace, TraceError, type TraceContext } from './trace.js';
export { Pin, PinError, type PinData } from './pin.js';
export { loadMcpConfig, type McpServers } from './mcp.js';
export { login, logout, authStatus, AuthError, type Provider } from './auth.js';
export { MemoryStore, type VariableStore } from './store.js';
export type { LlmBackend, LlmRequest, LlmResponse, LlmStreamUpdate, Randomness, RuntimeAction, RuntimeTool } from './llm.js';
