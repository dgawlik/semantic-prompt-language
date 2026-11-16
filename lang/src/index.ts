// The library: everything a `.spl` file can use without importing it.
export {
    ask, agent, human, enforce, forbid, restrict, success, fail, assert, log, codegen,
    readFile, writeFile, webFetch, webSearch, shell, args, env, markdown, configure, validate,
    t, Str, Int, Float, Bool, Char, Nil, Any, Dict, Fn, List, Union, Nullable, Enum, Struct, Typedef, JsonSchema,
    type AskOptions, type AgentOptions, type CodegenOptions, type ConfigureOptions,
    type GenerationResult, type RestrictSpec,
} from './library.js';
export { Type, StructType, isType, type Infer, type InferShape, type Shape, type Annotations, type TypeKind } from './types.js';
export { Failure, SuccessSignal, SplSyntaxError, type FailurePayload, type StatusCode, type SyntaxProblem } from './errors.js';

// What compiled workflows call: the `---` blocks and the workflow function itself.
export * as __spl from './blocks.js';

// Compiling and running workflows, and embedding the runtime.
export { scan, sourceColumn, CHECK_OPTIONS, DEFAULT_EXPORT, HEADER_KEYS, MODES, type Scan, type Region, type HeaderEntry, type SplBlock, type SplComment, type SplProblem, type BlockMode, type BlockInput, type BlockOutput, type HeaderKey, type Span } from './scanner.js';
export { compile, type Compiled } from './compile.js';
export { check, type CheckProblem } from './check.js';
export { documentMarkdown, documentHtml, type DocOptions } from './doc.js';
export { run, type RunOptions, type RunResult } from './workflow.js';
export { Runtime, type RuntimeOptions, type GenerateOptions, type HumanHandler, type Step } from './runtime.js';
export { Logger, type LogLevel, type LoggerOptions } from './logger.js';
export type { LogEvent, LogEventSink, BodySegment, ModelInteraction, ModelStreamEvent, ModelStreamSink, StateChange, BindingDelta, BindingReference, ScopeReference, ObservedValue, ToolUse } from './log-events.js';
export { AiBackend, type AiBackendOptions } from './ai.js';
export { Trace, TraceError, type TraceContext } from './trace.js';
export { loadMcpConfig, type McpServers } from './mcp.js';
export { login, logout, authStatus, AuthError, type Provider } from './auth.js';
export type { LlmBackend, LlmRequest, LlmResponse, LlmStreamUpdate, Randomness, ReasoningLevel, RuntimeAction, RuntimeTool } from './llm.js';
