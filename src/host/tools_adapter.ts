import { SignatureCatalog } from "../catalog.js";
import { SplObject, SplRecoverableError, SplValue, deepCloneSpl } from "../canonical.js";
import { EffectDispatchResult } from "../vm.js";

export type JsToolHandler = (args: SplObject) => Promise<unknown> | unknown;
export type McpToolHandler = (server: string, tool: string, args: SplObject) => Promise<unknown>;

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  if (!timeoutMs || timeoutMs <= 0) return promise;
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new SplRecoverableError("TOOL_ERROR", `${label} timed out after ${timeoutMs}ms`, true));
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class ToolsAdapter {
  constructor(
    private readonly catalog: SignatureCatalog,
    private readonly jsHandlers: Record<string, JsToolHandler> = {},
    private readonly mcpHandler?: McpToolHandler
  ) {}

  async callJsTool(name: string, args: SplObject): Promise<EffectDispatchResult> {
    const sig = this.catalog.js_tools[name];
    const handler = this.jsHandlers[name];
    if (!sig || !handler) {
      return {
        outcome: {
          status: "error",
          error: new SplRecoverableError("TOOL_ERROR", `JS tool '${name}' is not registered`, false).errObj,
        },
      };
    }
    const startMs = Date.now();
    try {
      const result = await withTimeout(
        Promise.resolve(handler(deepCloneSpl(args) as SplObject)),
        sig.timeout_ms,
        `tool.${name}`
      );
      return {
        outcome: { status: "ok", value: result as SplValue },
        non_normative_meta: { latency_ms: Date.now() - startMs },
      };
    } catch (err) {
      if (err instanceof SplRecoverableError) {
        return { outcome: { status: "error", error: err.errObj }, non_normative_meta: { latency_ms: Date.now() - startMs } };
      }
      return {
        outcome: {
          status: "error",
          error: new SplRecoverableError("TOOL_ERROR", err instanceof Error ? err.message : String(err), false).errObj,
        },
        non_normative_meta: { latency_ms: Date.now() - startMs },
      };
    }
  }

  async callMcpTool(server: string, tool: string, args: SplObject): Promise<EffectDispatchResult> {
    const sig = this.catalog.mcp_tools[server]?.[tool];
    if (!sig || !this.mcpHandler) {
      return {
        outcome: {
          status: "error",
          error: new SplRecoverableError("TOOL_ERROR", `MCP tool '${server}.${tool}' is not connected`, false).errObj,
        },
      };
    }
    const startMs = Date.now();
    try {
      const result = await withTimeout(
        this.mcpHandler(server, tool, deepCloneSpl(args) as SplObject),
        sig.timeout_ms,
        `mcp.${server}.${tool}`
      );
      return {
        outcome: { status: "ok", value: result as SplValue },
        non_normative_meta: { latency_ms: Date.now() - startMs },
      };
    } catch (err) {
      if (err instanceof SplRecoverableError) {
        return { outcome: { status: "error", error: err.errObj }, non_normative_meta: { latency_ms: Date.now() - startMs } };
      }
      return {
        outcome: {
          status: "error",
          error: new SplRecoverableError("TOOL_ERROR", err instanceof Error ? err.message : String(err), true).errObj,
        },
        non_normative_meta: { latency_ms: Date.now() - startMs },
      };
    }
  }
}
