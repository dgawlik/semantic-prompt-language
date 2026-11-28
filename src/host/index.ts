import { SignatureCatalog } from "../catalog.js";
import { SplRecoverableError } from "../canonical.js";
import { EffectDispatchResult, EffectDispatcher, EffectRequest } from "../vm.js";
import { VirtualFsAdapter } from "./fs_adapter.js";
import {
  DecisionAdapter,
  OpenAiClientLike,
  OpenAiLogprobsDecisionAdapter,
  OpenAiModelAskAdapter,
} from "./openai_adapter.js";
import { ShellProfileAdapter } from "./shell_adapter.js";
import { JsToolHandler, McpToolHandler, ToolsAdapter } from "./tools_adapter.js";
import { DnsLookupFn, FetchFn, WebAdapter, WebSearchProvider } from "./web_adapter.js";

export interface HostRuntimeOptions {
  catalog: SignatureCatalog;
  openaiClient?: OpenAiClientLike;
  modelAskAdapter?: OpenAiModelAskAdapter;
  decisionAdapters?: Record<string, DecisionAdapter>;
  fsRootMounts?: Record<string, string>;
  webSearchProvider?: WebSearchProvider;
  webDnsLookup?: DnsLookupFn;
  webFetchFn?: FetchFn;
  jsTools?: Record<string, JsToolHandler>;
  mcpHandler?: McpToolHandler;
}

export class HostRuntime implements EffectDispatcher {
  private readonly fsAdapter: VirtualFsAdapter;
  private readonly shellAdapter: ShellProfileAdapter;
  private readonly webAdapter: WebAdapter;
  private readonly toolsAdapter: ToolsAdapter;
  private readonly modelAskAdapter?: OpenAiModelAskAdapter;
  private readonly decisionAdapters: Record<string, DecisionAdapter>;

  constructor(private readonly options: HostRuntimeOptions) {
    const mounts = options.fsRootMounts ?? {};
    this.fsAdapter = new VirtualFsAdapter(options.catalog, mounts);
    this.shellAdapter = new ShellProfileAdapter(options.catalog, mounts);
    this.webAdapter = new WebAdapter(options.catalog, {
      searchProvider: options.webSearchProvider,
      dnsLookup: options.webDnsLookup,
      fetchFn: options.webFetchFn,
    });
    this.toolsAdapter = new ToolsAdapter(options.catalog, options.jsTools, options.mcpHandler);
    this.modelAskAdapter =
      options.modelAskAdapter ?? (options.openaiClient ? new OpenAiModelAskAdapter(options.openaiClient) : undefined);

    this.decisionAdapters = { ...(options.decisionAdapters ?? {}) };
    if (options.openaiClient && !this.decisionAdapters.openai_logprobs) {
      this.decisionAdapters.openai_logprobs = new OpenAiLogprobsDecisionAdapter(options.openaiClient);
    }
  }

  async dispatch(req: EffectRequest): Promise<EffectDispatchResult> {
    switch (req.kind) {
      case "model.ask": {
        const profile = this.options.catalog.models[req.target];
        if (!profile || !this.modelAskAdapter) {
          return {
            outcome: {
              status: "error",
              error: new SplRecoverableError("MODEL_ERROR", `Model profile '${req.target}' not available`, false).errObj,
            },
          };
        }
        return this.modelAskAdapter.ask(profile, req.args.prompt as string, req.schema ?? { type: "string" }, {
          system: typeof req.args.system === "string" ? req.args.system : undefined,
          input: req.args.input,
        });
      }

      case "model.decide": {
        const profile = this.options.catalog.decisions[req.target];
        if (!profile) {
          return {
            outcome: {
              status: "error",
              error: new SplRecoverableError("DECISION_ERROR", `Decision profile '${req.target}' not found`, false)
                .errObj,
            },
          };
        }
        const adapter = this.decisionAdapters[profile.adapter];
        if (!adapter) {
          return {
            outcome: {
              status: "error",
              error: new SplRecoverableError(
                "DECISION_ERROR",
                `Decision adapter '${profile.adapter}' not configured`,
                false
              ).errObj,
            },
          };
        }
        return adapter.decide(profile, req.args.prompt as string, req.decideOptions ?? (req.args.options as string[]), {
          min_confidence: typeof req.args.min_confidence === "number" ? req.args.min_confidence : undefined,
          system: typeof req.args.system === "string" ? req.args.system : undefined,
          context: req.args.context,
        });
      }

      case "web.search":
        return this.webAdapter.search(req.args);

      case "web.fetch":
        return this.webAdapter.fetch(req.args);

      case "fs":
        return this.fsAdapter.execute(req.args);

      case "shell":
        return this.shellAdapter.execute(req.target, req.args);

      case "js_tool":
        return this.toolsAdapter.callJsTool(req.target, req.args);

      case "mcp_tool": {
        const dot = req.target.indexOf(".");
        const server = req.target.slice(0, dot);
        const tool = req.target.slice(dot + 1);
        return this.toolsAdapter.callMcpTool(server, tool, req.args);
      }
    }
  }
}

export * from "./fs_adapter.js";
export * from "./shell_adapter.js";
export * from "./web_adapter.js";
export * from "./tools_adapter.js";
export * from "./openai_adapter.js";
